'use strict';
// Focus audit fix round (agent.js side): worker gap edits reaching a stashed
// Focus, Esc-stopped tasks resurrecting from the catch-path stash, /goal
// legs ending 'stalled', resumed Focus maxRounds, and the hardcoded English
// Focus time-limit reason. Harness mirrors tests/fix2-agent.test.js: a real
// Agent with runTurn stubbed, so sendFocused/afterGoal/toolEnd run for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focusfix-agent-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focusfix-agent-home-'));

const {Agent, GOAL_MAX_LEGS} = require('../src/agent');
const {Focus} = require('../src/focus');
const {t: tr} = require('../src/i18n'); // aliased: node:test callbacks name their context t

const plan = [{text: 'Source satisfies the requested behavior', kind: 'inspection'}];
const readCall = {command: 'code.read', kind: 'read', params: {path: 'probe.txt'}, summary: 'probe.txt'};
const okReply = {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}};

function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focusfix-agent-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t) {
  const cwd = tmpdir(t);
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id: 's1', cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}
function fakeWorker(a, focusTask) {
  const w = {tag: 'a9', title: 'a9', by: 'muse', typeName: 'general', type: undefined, state: 'working', lastTool: '', text: '', result: '', error: '', started: 0, ended: 0, collected: false, turn: {calls: []}, starting: false, main: false, focusTask, session: {id: 'sess-a9'}, ctx: null};
  a.workers.set('a9', w);
  return w;
}

// ---------- fix 1: gap worker edits reach the stashed (resumeFocus) Focus ----------

test('focusfix-1: a worker edit between legs expires evidence on the stashed Focus', (t) => {
  const a = makeAgent(t);
  const f = new Focus('TASK'); f.beginRound(); f.plan(plan);
  const proof = f.observe(readCall, {ok: true}); // evidence covering probe.txt, gathered in leg 1
  a.resumeFocus = {focus: f, sessionId: 's1'}; // the leg ended; the task is parked in the stash
  assert.equal(a.focusRun, null, 'no leg is running while the worker edits in the gap');
  const w = fakeWorker(a, f); // the leg's worker, still running by design
  a.toolEnd(w, {id: 'gap-edit', command: 'code.edit', kind: 'edit', params: {path: 'probe.txt'}, summary: 'probe.txt'}, {ok: true, payload: {}});
  assert.throws(() => f.checkpoint([{id: 'c1', status: 'met', evidence: [proof], reason: 'ok'}]), /evidence/, 'the gap edit must expire the pre-gap evidence (before the fix it was never observed and the stale proof passed)');
});

test('focusfix-1: toolEnd does not observe into a Focus that is neither running nor stashed', (t) => {
  const a = makeAgent(t);
  const parked = new Focus('PARKED');
  const other = new Focus('OTHER');
  let parkedSeen = 0, otherSeen = 0;
  const pObs = parked.observe.bind(parked); parked.observe = (...args) => { parkedSeen++; return pObs(...args); };
  const oObs = other.observe.bind(other); other.observe = (...args) => { otherSeen++; return oObs(...args); };
  a.resumeFocus = {focus: parked, sessionId: 's1'};
  const w = fakeWorker(a, other); // stamped with a different Focus than the stash
  a.toolEnd(w, {id: 'x1', command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true, payload: {}});
  assert.equal(otherSeen, 0, 'a Focus that is not the run/stash focus absorbs nothing');
  assert.equal(parkedSeen, 0, 'the stashed Focus only tracks its own workers');
  // And once the stash is gone (task completed / taken up), its worker is untracked too.
  a.resumeFocus = null;
  w.focusTask = parked;
  a.toolEnd(w, {id: 'x2', command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true, payload: {}});
  assert.equal(parkedSeen, 0, 'with no stash and no run, nothing is observed');
});

// ---------- fix 2: the catch-path stash must not resurrect stopped/complete tasks ----------

test('focusfix-2: an Esc-aborted run (AbortError) is NOT stashed for resurrection', async (t) => {
  const a = makeAgent(t);
  a.runTurn = async (w, input, opts) => { opts.focus.plan(plan); const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(a.sendFocused('task', {turnEnd: false}), e => e.name === 'AbortError');
  assert.equal(a.lastFocus.status, 'stopped');
  assert.equal(a.resumeFocus, null, 'a task the user stopped stays stopped');
});

test('focusfix-2: a mid-task error still stashes the task as blocked (#17 design)', async (t) => {
  const a = makeAgent(t);
  let seen = null;
  a.runTurn = async (w, input, opts) => { seen = opts.focus; opts.focus.plan(plan); throw new Error('gateway died'); };
  await assert.rejects(a.sendFocused('task', {turnEnd: false}), /gateway died/);
  assert.equal(a.resumeFocus?.focus, seen, 'the errored task is parked for the next message');
  assert.equal(a.lastFocus.status, 'blocked');
});

test('focusfix-2: an error after the task completed does NOT stash it', async (t) => {
  const a = makeAgent(t);
  a.runTurn = async (w, input, opts) => { opts.focus.plan(plan); opts.focus.stop('complete', 'done'); throw new Error('late failure'); };
  await assert.rejects(a.sendFocused('task', {turnEnd: false}), /late failure/);
  assert.equal(a.resumeFocus, null, 'a completed task is not resurrected by a later error');
});

// ---------- fix 3: afterGoal continues stalled legs, under the same cap ----------

test('focusfix-3: a stalled /goal leg spawns the next goal leg', async (t) => {
  const a = makeAgent(t);
  a.session.goal = {text: 'GOAL TEXT', legs: 0, setAt: Date.now()};
  let legGoal = null;
  a.runTurn = async (w, input, opts) => { legGoal = opts.focus?.goal; return okReply; };
  await a.afterGoal({focus: {status: 'stalled', goal: 'GOAL TEXT'}, text: 'x', usage: null});
  assert.equal(legGoal, 'GOAL TEXT', 'the stalled leg was continued with a goal leg');
  assert.equal(a.session.goal.legs, 1, 'the leg counter advanced');
});

test('focusfix-3: a stalled /goal leg at the leg cap does not continue', async (t) => {
  const a = makeAgent(t);
  a.session.goal = {text: 'GOAL TEXT', legs: GOAL_MAX_LEGS, setAt: Date.now()};
  let legs = 0;
  a.runTurn = async () => { legs++; return okReply; };
  const reply = {focus: {status: 'stalled', goal: 'GOAL TEXT'}, text: 'x', usage: null};
  const out = await a.afterGoal(reply);
  assert.equal(legs, 0, 'no leg past GOAL_MAX_LEGS');
  assert.equal(out, reply);
});

// ---------- fix 4: a resumed Focus adopts the current maxRounds ----------

test('focusfix-4: resuming a Focus updates its maxRounds from the current settings value', async (t) => {
  const a = makeAgent(t);
  assert.ok(a.focusBackground instanceof Map, 'the Agent constructor creates the shared Focus background map');
  const f = new Focus('TASK', {maxRounds: 3}); // built when the setting was 3
  a.resumeFocus = {focus: f, sessionId: 's1'};
  let seenRounds = null;
  a.runTurn = async (w, input, opts) => { seenRounds = opts.focus.maxRounds; return okReply; };
  await a.sendFocused('next message', {turnEnd: false, maxRounds: 7}); // the setting is 7 now
  assert.equal(seenRounds, 7, 'the resumed leg runs with the current round limit');
  assert.equal(f.maxRounds, 7);
});

// ---------- fix 5: the Focus time-limit reason goes through i18n ----------

test('focusfix-5: the time-limit stop reason is the i18n string, not hardcoded English', async (t) => {
  const a = makeAgent(t);
  a.runTurn = async () => { await new Promise(r => setTimeout(r, 25)); return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true}}; };
  const reply = await a.sendFocused('task', {maxRounds: 5, timeoutMs: 5, turnEnd: false});
  assert.equal(reply.focus?.status, 'limit');
  assert.equal(reply.focus?.reason, tr('Focus の時間上限に達しました。'));
  assert.notEqual(reply.focus?.reason, 'The Focus time limit was reached.');
});

test('focusfix-5: the workers-pending time-limit branch uses the same i18n reason', async (t) => {
  const realNow = Date.now;
  let fakeNow = 1000000000, rounds = 0;
  Date.now = () => fakeNow;
  try {
    const a = makeAgent(t);
    a.runTurn = async (w, input, opts) => {
      fakeNow += 50 * 60000; rounds++;
      a.workers.set('a1', {tag: 'a1', main: false, focusTask: opts.focus, turn: {}, starting: false});
      return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true}};
    };
    const reply = await a.sendFocused('task', {maxRounds: 10, timeoutMs: 60 * 60000, turnEnd: false});
    assert.equal(rounds, 3, 'the continuously-pending bound fires the limit');
    assert.equal(reply.focus?.status, 'limit');
    assert.equal(reply.focus?.reason, tr('Focus の時間上限に達しました。'));
  } finally { Date.now = realNow; }
});
