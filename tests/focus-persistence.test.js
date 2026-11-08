'use strict';
// Focus weakness 3 (2026-11-06): the Focus state survives the window.
// The full state (goal, criteria, evidence, revisions) is saved per session
// and restored when a new Agent opens that session; finished/stopped tasks
// leave no file behind, and a turn that died before reaching Muse is
// recorded as blocked in the transcript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-persist-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-persist-home-'));

const {Agent} = require('../src/agent');
const {Focus} = require('../src/focus');
const sessions = require('../src/sessions');

function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-persist-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, id = 's1') {
  const cwd = tmpdir(t);
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id, cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}
// A task with one manual criterion, reported unknown so it stops for the user.
function planAndAskUnknown(focus) {
  focus.plan([{text: 'Do the thing', kind: 'manual'}]);
  focus.checkpoint([{id: 'c1', status: 'unknown', reason: 'need the user to confirm'}]);
  return focus.endRound();
}

test('weakness 3: serialize/restore round-trips the full state, and garbage is refused', () => {
  const f = new Focus('Do the thing', {maxRounds: 5, sessionCwd: 'C:\\work'});
  f.beginRound();
  f.plan([{text: 'First', kind: 'inspection'}, {text: 'Second', kind: 'manual'}]);
  const eid = f.observe({command: 'code.read', params: {path: 'probe.txt'}, summary: 'read probe'}, {ok: true, payload: {}});
  f.checkpoint([{id: 'c1', status: 'met', reason: 'saw it', evidence: [eid]}, {id: 'c2', status: 'unknown', reason: 'need the user'}]);
  f.observe({command: 'code.edit', params: {path: 'other.txt'}, summary: 'edit other'}, {ok: true, payload: {}});
  const saved = f.serialize();
  const g = Focus.restore(saved, {sessionCwd: 'C:\\work'});
  assert.equal(g.id, f.id);
  assert.equal(g.goal, f.goal);
  assert.equal(g.maxRounds, 5);
  assert.equal(g.round, 1);
  assert.deepEqual(g.criteria.map(c => [c.id, c.status]), [['c1', 'met'], ['c2', 'unknown']]);
  assert.equal(g.evidence.length, 2);
  assert.equal(g.evidence[0].id, eid);
  assert.equal(g.evidence[0].usable, true);
  assert.equal(g.revision, f.revision);
  assert.equal(g.changes.length, f.changes.length);
  assert.equal(g.nextEvidence, f.nextEvidence);
  assert.equal(g.operations, f.operations);
  // Mutating the saved form must not corrupt the live task.
  saved.criteria[0].status = 'unmet';
  assert.equal(f.criteria[0].status, 'met');
  // The restored task can keep working: its evidence is still current.
  assert.equal(g.evidenceCurrent(g.evidence[0]), true);
  assert.equal(g.evidenceProblem(eid), '');
  for (const bad of [null, undefined, {}, {v: 1, goal: 'x', criteria: 'no'}, {v: 1, goal: 5, criteria: [], evidence: [], changes: []}, {v: 1, criteria: [], evidence: [], changes: []}])
    assert.throws(() => Focus.restore(bad), /Invalid Focus state/);
  // Wave 18 contract: a later version, and a state whose lists are absent
  // entirely, restore instead of throwing — only a list that is present in
  // the wrong shape (above) still refuses.
  const fromV2 = Focus.restore({v: 2, goal: 'x'});
  assert.equal(fromV2.goal, 'x');
  assert.deepEqual(fromV2.criteria, []);
  assert.deepEqual(fromV2.evidence, []);
  assert.deepEqual(fromV2.changes, []);
  assert.throws(() => Focus.restore({v: 1, goal: 'x', criteria: [], evidence: [], changes: [], maxRounds: 99}), /Invalid Focus round limit/);
});

test('weakness 3: sessions saveFocus/loadFocus/clearFocus round-trip, and a corrupt file reads as null', () => {
  assert.equal(sessions.loadFocus('no-such-session'), null);
  const data = {v: 1, id: 'f1', goal: 'g', criteria: [], evidence: [], changes: []};
  sessions.saveFocus('s-focus', data);
  assert.deepEqual(sessions.loadFocus('s-focus'), data);
  sessions.clearFocus('s-focus');
  assert.equal(sessions.loadFocus('s-focus'), null);
  sessions.clearFocus('s-focus'); // clearing twice is fine
  fs.writeFileSync(sessions.focusFile('s-corrupt'), '{not json');
  assert.equal(sessions.loadFocus('s-corrupt'), null);
});

test('weakness 3: a task that stops for the user resumes in a new Agent on the same session, and completing it clears the file', async (t) => {
  const a = makeAgent(t, 's-resume');
  let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++;
    const d = planAndAskUnknown(opts.focus);
    return {text: 'ok', sources: [], usage: null, focusDecision: d};
  };
  const first = await a.sendFocused('Do the thing', {turnEnd: false});
  assert.equal(round, 1);
  assert.equal(first.focus.status, 'needs_input');
  const saved = sessions.loadFocus('s-resume');
  assert.ok(saved, 'the unfinished task is saved');
  assert.equal(saved.id, first.focus.id);
  assert.equal(saved.criteria[0].status, 'unknown');
  // A new Agent on the same session — as if the window had been reopened.
  const b = makeAgent(t, 's-resume');
  assert.ok(b.resumeFocus, 'the saved task is restored');
  assert.equal(b.resumeFocus.focus.id, first.focus.id);
  assert.equal(b.resumeFocus.focus.criteria[0].status, 'unknown');
  // The user's next message resumes it, and confirming completes it.
  let roundB = 0;
  b.runTurn = async (w, input, opts) => {
    roundB++;
    opts.focus.checkpoint([{id: 'c1', status: 'met', reason: 'the user confirmed it'}]);
    const d = opts.focus.endRound();
    return {text: 'ok', sources: [], usage: null, focusDecision: d};
  };
  const second = await b.sendFocused('Yes, it is done', {turnEnd: false});
  assert.equal(roundB, 1);
  assert.equal(second.focus.status, 'complete');
  assert.equal(sessions.loadFocus('s-resume'), null, 'a completed task leaves no file behind');
  // And a third Agent starts fresh.
  const c = makeAgent(t, 's-resume');
  assert.equal(c.resumeFocus, null, 'a completed task never comes back');
});

test('weakness 3: a stopped task leaves no file behind', async (t) => {
  const a = makeAgent(t, 's-stopped');
  const f = new Focus('Do the thing', {sessionCwd: a.cwd, sharedBackground: a.focusBackground});
  f.plan([{text: 'First', kind: 'inspection'}]);
  a.persistFocus(f);
  assert.ok(sessions.loadFocus('s-stopped'), 'the running task is saved');
  f.stop('stopped', 'the user stopped it');
  a.persistFocus(f);
  assert.equal(sessions.loadFocus('s-stopped'), null, 'a stopped task is cleared');
  const b = makeAgent(t, 's-stopped');
  assert.equal(b.resumeFocus, null);
});

test('weakness 3: a turn that dies before reaching Muse is recorded as blocked in the transcript', async (t) => {
  const a = makeAgent(t, 's-blocked');
  a.focusRetryDelaysMs = []; // the turnRetryable error throws at once, no retries
  let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      opts.focus.plan([{text: 'First', kind: 'inspection'}]);
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'not done yet'}]);
      const d = opts.focus.endRound();
      return {text: 'ok', sources: [], usage: null, focusDecision: d};
    }
    throw Object.assign(new Error('history fetch failed'), {turnRetryable: true});
  };
  await assert.rejects(a.sendFocused('Do the thing', {turnEnd: false}), /history fetch failed/);
  assert.equal(round, 2);
  const turns = sessions.transcript('s-blocked');
  const last = turns[turns.length - 1];
  assert.ok(last, 'a transcript line was recorded for the failed turn');
  assert.equal(last.focus.status, 'blocked');
  assert.match(last.error, /history fetch failed/);
  const saved = sessions.loadFocus('s-blocked');
  assert.ok(saved, 'the blocked task is saved for resumption');
  assert.equal(saved.criteria[0].status, 'unmet');
  const b = makeAgent(t, 's-blocked');
  assert.ok(b.resumeFocus, 'the blocked task resumes in a new window');
  assert.equal(b.resumeFocus.focus.status, 'blocked');
});
