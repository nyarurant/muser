'use strict';
// The standing goal (/goal, src/agent.js afterGoal): a task stopped at its round
// limit — or finished while the goal stands — starts the next leg by itself; stops
// that wait for the user do not; the leg count is capped; completing a task whose
// goal IS the standing goal achieves and clears it. The harness is tests/focus.test.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Same isolation as tests/accounts.test.js: never the real data folder.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-goal-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-goal-home-'));

const {Agent, GOAL_MAX_LEGS} = require('../src/agent');
const sessions = require('../src/sessions');

const plan = [{text: 'Source satisfies the requested behavior', kind: 'inspection'}];
const check = (status, evidence = [], reason = status) => [{id: 'c1', status, evidence, reason}];

async function harness(t, work) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-goal-test-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true})); fs.writeFileSync(path.join(cwd, 'probe.txt'), 'probe');
  const client = new EventEmitter(), events = [], sends = [], errors = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() { this.cancelled = true; }, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)}); agent.subscribed = true;
  t.after(() => agent.close());
  let inFlight = false;
  agent.device = {connected: true, disconnect() {}, async send(body, sessionId) {
    const round = sends.length + 1, id = 'user-' + round; sends.push({body, sessionId}); client.taskStatus = 'running';
    events.push({role: 'user', message_id: id, content: body, seq: round * 2});
    if (inFlight) return {message_id: id};
    inFlight = true;
    setImmediate(async () => {
      try {
        await work(agent, round);
        if (agent.main.turn?.controller.signal.aborted) return;
        const done = {event: 'delta.message_done', seq: round * 2 + 1, payload: {session_id: sessionId, message_id: 'reply-' + round, role: 'assistant', text: 'reply ' + round, status: 'completed'}};
        events.push(done); client.taskStatus = 'completed'; inFlight = false; client.emit('event', done);
      } catch (e) { errors.push(e); client.taskStatus = 'failed'; inFlight = false; client.emit('event', {event: 'task.status', session_id: sessionId, payload: {status: 'failed'}}); }
    });
    return {message_id: id};
  }};
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  agent.approver = async () => ({allow: true}); // the scripts write files: approve, like tests/agent.test.js does
  // t2 #9: an assertion failing inside work() used to surface only as a
  // generic 'failed' turn event (or a hang) — the diff was lost. Rethrow the
  // first one after the test so it fails with its own message. (The other
  // half of that finding — device.send absorbing a concurrent send as a
  // postSteer post — is the behaviour under test in the clarification test
  // below, and the sends log there is asserted, so it stays.)
  t.after(() => { if (errors.length) throw errors[0]; });
  return {agent, ctrl, sends, client, errors};
}
// One round of visible progress (an edit, so the stall detector stays quiet) that
// still leaves the criterion unmet.
async function unmetRound(a, round) {
  await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
  await a.execute('code.write', {agent: 'main', path: 'work.txt', content: 'step ' + round}, 1000, 'write-' + round);
  await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
}
async function metRound(a, round) {
  await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
  const read = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-' + round);
  await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [read.payload.muser_evidence_id]))});
}

test('goal: a task stopped at its round limit continues by itself and clears the goal when it completes', async t => {
  const goals = [];
  const fixture = await harness(t, async (a, round) => { if (round <= 3) await unmetRound(a, round); else await metRound(a, round); });
  fixture.agent.on('goal', e => goals.push(e));
  fixture.agent.setGoal('Long task');
  assert.equal(sessions.find(fixture.agent.session.id)?.goal?.text, 'Long task', 'the goal is persisted on the session record');
  const answer = await fixture.agent.send('Long task');
  assert.equal(answer.focus.status, 'complete');
  assert.equal(fixture.sends.length, 4, 'three limited rounds, then one automatic leg round');
  assert.ok(fixture.sends[3].body.includes('automatic continuation'), 'the leg explains itself to Muse (a default Focus leg now: afterFocus starts it before /goal needs to)');
  assert.equal(fixture.agent.standingGoal(), null, 'completing the goal task achieves the goal');
  assert.equal(sessions.find(fixture.agent.session.id)?.goal ?? null, null, 'the clear is persisted too');
  assert.ok(goals.some(e => e.achieved === 'Long task'));
  clearTimeout(fixture.ctrl.flashTimer);
});

test('goal: a finished side task starts a goal leg; the leg completing clears the goal', async t => {
  const fixture = await harness(t, async (a, round) => { await metRound(a, round); });
  fixture.agent.setGoal('Big goal');
  const answer = await fixture.agent.send('Side task');
  assert.equal(answer.focus.goal, 'Big goal', 'the returned reply is the goal leg\'s');
  assert.equal(answer.focus.status, 'complete');
  assert.equal(fixture.sends.length, 2, 'the side task, then one goal leg');
  assert.ok(fixture.sends[1].body.includes('Standing goal: Big goal'));
  assert.equal(fixture.agent.standingGoal(), null);
  clearTimeout(fixture.ctrl.flashTimer);
});

test('a clarification sent mid-work and delivered to Muse does not end the task; the work goes on', async t => {
  // 2026-11-03: "ないならないでいいよ", posted into the running chat and answered by Muse,
  // ended the turn as "a new user message is queued". Delivered, it is part of the work.
  const fixture = await harness(t, async (a, round) => {
    if (round === 1) { await unmetRound(a, round); await fixture.ctrl.submit('New clarification'); return; }
    if (round === 2) return; // the posted clarification's own send (it rides the running turn)
    await metRound(a, round);
  });
  fixture.ctrl.set({busy: true});
  const answer = await fixture.agent.send('Original request');
  assert.equal(answer.focus.status, 'complete');
  assert.equal(fixture.sends.length, 3, 'the send, the posted clarification, then the continuation round');
  assert.match(fixture.sends[2].body, /message the user sent while you worked/, 'the continuation tells Muse the clarification wins');
  clearTimeout(fixture.ctrl.flashTimer);
});

test('goal: a stop that waits for the user (focus.ask_user) does not chain', async t => {
  const fixture = await harness(t, async a => {
    if (a.focusRun.focus.goal !== 'Original request') return;
    await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
    await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
    await a.execute('focus.ask_user', {agent: 'main', question: 'Blue or green?'});
  });
  fixture.agent.setGoal('Standing goal');
  const answer = await fixture.agent.send('Original request');
  assert.equal(answer.focus.status, 'needs_input');
  assert.equal(fixture.sends.length, 1, 'no automatic leg past the question');
  assert.equal(fixture.agent.standingGoal()?.text, 'Standing goal', 'the goal survives the wait');
});

test('goal: automatic legs are capped, then the run parks with the goal still set', async t => {
  const goals = [];
  const fixture = await harness(t, async (a, round) => { await unmetRound(a, round); });
  fixture.agent.on('goal', e => goals.push(e));
  fixture.agent.setGoal('Endless');
  const answer = await fixture.agent.send('Endless');
  assert.equal(answer.focus.status, 'limit');
  assert.equal(fixture.agent.standingGoal()?.legs, GOAL_MAX_LEGS);
  assert.ok(goals.some(e => e.capped), 'the cap is reported');
  // Each sendFocused run is focusRounds (3) rounds. A user send first chains its own
  // FOCUS_MAX_LEGS automatic legs (afterFocus — the default for any task now), then
  // the standing goal chains its GOAL_MAX_LEGS legs before the run parks, still limited.
  const {FOCUS_MAX_LEGS} = require('../src/agent');
  assert.equal(fixture.sends.length, 3 * (1 + FOCUS_MAX_LEGS + GOAL_MAX_LEGS), 'default legs, then goal legs, then the caps park it');
  clearTimeout(fixture.ctrl.flashTimer);
});

test('/goal shows, sets (busy: without sending) and clears the standing goal', async t => {
  const fixture = await harness(t, async () => {});
  const {ctrl, agent} = fixture;
  const notes = () => ctrl.get().entries.filter(e => e.type === 'note').map(e => e.lines.join('\n'));
  ctrl.slash('/goal');
  assert.ok(notes().some(x => x.includes('ゴールは設定されていません')));
  ctrl.set({busy: true});
  ctrl.slash('/goal Ship it');
  assert.equal(agent.standingGoal()?.text, 'Ship it');
  assert.equal(ctrl.get().goal?.text, 'Ship it', 'the window state follows');
  assert.equal(fixture.sends.length, 0, 'busy: nothing is sent');
  ctrl.slash('/goal');
  assert.ok(notes().some(x => x.includes('現在のゴール: Ship it')));
  ctrl.slash('/goal clear');
  assert.equal(agent.standingGoal(), null);
  assert.equal(ctrl.get().goal, null);
  clearTimeout(ctrl.flashTimer);
});
