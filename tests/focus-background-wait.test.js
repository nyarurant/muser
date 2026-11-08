'use strict';
// Focus weakness 4 (2026-11-06): waiting on a background run this task
// started must not go stalled or spin rounds — it is the same wait as for
// task agents (weakness 2), with the same time-limit bound and Esc stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-bgwait-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-bgwait-home-'));

const {Agent} = require('../src/agent');
const {Focus} = require('../src/focus');

function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-bgwait-')); if (t) t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
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
// A background shell of this task that finishes after ms; while it runs it
// looks pending to Focus. (The real flow registers it in observe() when a
// system.run goes to the background; here the registration is direct.)
function pendingShell(a, focus, ms) {
  const sh = {id: 'bg1', running: true};
  a.shells.list.set('bg1', sh);
  focus.background.set('bg1', {command: 'npm test', revision: 0});
  if (ms != null) setTimeout(() => { sh.running = false; }, ms);
  return sh;
}
// Build the round decision the way runTurn does: endRound with the pending
// flags the Agent computed, carrying them on the decision.
function decide(a, focus) {
  const backgroundPending = a.focusBackgroundPending(focus);
  const d = focus.endRound({backgroundPending});
  return (d && backgroundPending) ? {...d, backgroundPending: true} : d;
}

test('weakness 4: endRound treats a pending background run like a pending worker', () => {
  const f = new Focus('Run the tests', {maxRounds: 1});
  f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'inspection'}]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'still running'}]);
  // The round limit does not advance while the run is pending.
  assert.equal(f.endRound({backgroundPending: true}).continue, true);
  assert.equal(f.status, 'running');
  f.beginRound();
  // And stalled does not advance either: two pending rounds in a row.
  assert.equal(f.endRound({backgroundPending: true}).continue, true);
  assert.equal(f.stalled, 0);
  // Once the run is done, the same round ends at the limit.
  assert.equal(f.endRound({backgroundPending: false}).status, 'limit');
});

test('weakness 4: focusBackgroundPending only counts shells still running', () => {
  const a = makeAgent(null);
  const f = new Focus('Run the tests', {sessionCwd: a.cwd, sharedBackground: a.focusBackground});
  assert.equal(a.focusBackgroundPending(f), false, 'no runs at all');
  assert.equal(a.focusBackgroundPending(null), false);
  const sh = pendingShell(a, f, null);
  assert.equal(a.focusBackgroundPending(f), true);
  sh.running = false;
  assert.equal(a.focusBackgroundPending(f), false, 'a finished run does not hold the leg open');
  f.background.set('bg-gone', {command: 'npm test', revision: 0});
  assert.equal(a.focusBackgroundPending(f), false, 'a run with no shell record does not hold the leg open');
  try { a.close(); } catch {}
});

test('weakness 4: a 12-second background test costs no waiting round and never goes stalled', async (t) => {
  const a = makeAgent(t);
  const order = []; let round = 0; const started = Date.now(); let eid; let focus;
  a.runTurn = async (w, input, opts) => {
    round++; order.push('round' + round); focus = opts.focus;
    if (round === 1) {
      opts.focus.plan([{text: 'Tests pass', kind: 'inspection'}]);
      eid = opts.focus.observe({command: 'code.read', params: {path: 'probe.txt'}, summary: 'read probe'}, {ok: true, payload: {}});
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'test still running'}]);
      pendingShell(a, opts.focus, 12000);
      return {text: 'ok', sources: [], usage: null, focusDecision: decide(a, opts.focus)};
    }
    // The test is done by now: the collection round, not a shell.output-only round.
    opts.focus.checkpoint([{id: 'c1', status: 'met', reason: 'test passed', evidence: [eid]}]);
    return {text: 'ok', sources: [], usage: null, focusDecision: decide(a, opts.focus)};
  };
  const reply = await a.sendFocused('task', {turnEnd: false});
  assert.deepEqual(order, ['round1', 'round2'], 'one working round, one collection round — no shell.output-only round in between');
  assert.ok(Date.now() - started >= 11000, 'the wait really lasted until the test finished');
  assert.equal(reply.focus?.status, 'complete');
  assert.equal(focus.stalled, 0, 'waiting on the test never counted as stalled');
  assert.equal(a.focusRun, null);
});

test('weakness 4: a background run that never finishes still hits the time limit in one round', async (t) => {
  const a = makeAgent(t);
  let round = 0; const started = Date.now();
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      opts.focus.plan([{text: 'Tests pass', kind: 'inspection'}]);
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'test still running'}]);
      pendingShell(a, opts.focus, null); // never finishes
    }
    return {text: 'ok', sources: [], usage: null, focusDecision: decide(a, opts.focus)};
  };
  const reply = await a.sendFocused('task', {maxRounds: 10, timeoutMs: 3000, turnEnd: false});
  const elapsed = Date.now() - started;
  assert.equal(round, 1, 'no new round starts while the run is pending');
  assert.equal(reply.focus?.status, 'limit', 'the continuously-pending bound still bites');
  assert.ok(elapsed >= 2500 && elapsed < 10000, 'the limit fires at about the timeout, not after spinning rounds: ' + elapsed + 'ms');
});

test('weakness 4: Esc during the background wait stops at once', async (t) => {
  const a = makeAgent(t);
  let round = 0; const started = Date.now();
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      opts.focus.plan([{text: 'Tests pass', kind: 'inspection'}]);
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'test still running'}]);
      pendingShell(a, opts.focus, null); // never finishes
    }
    return {text: 'ok', sources: [], usage: null, focusDecision: decide(a, opts.focus)};
  };
  setTimeout(() => { a.focusRun?.controller.abort(); }, 600);
  await assert.rejects(a.sendFocused('task', {turnEnd: false}), e => e.name === 'AbortError');
  const elapsed = Date.now() - started;
  assert.equal(round, 1, 'no new round starts while the run is pending');
  assert.ok(elapsed < 5000, 'Esc stops the wait at once: ' + elapsed + 'ms');
  assert.equal(a.lastFocus?.status, 'stopped');
});

test('weakness 4: a finished background run does not exempt a round from stalled', async (t) => {
  const a = makeAgent(t);
  let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      opts.focus.plan([{text: 'Tests pass', kind: 'inspection'}]);
      opts.focus.checkpoint([{id: 'c1', status: 'unmet', reason: 'test still running'}]);
      const sh = pendingShell(a, opts.focus, null);
      sh.running = false; // the run already finished; nothing is pending
    }
    return {text: 'ok', sources: [], usage: null, focusDecision: decide(a, opts.focus)};
  };
  const reply = await a.sendFocused('task', {turnEnd: false});
  assert.equal(round, 2, 'two identical rounds run, as before');
  assert.equal(reply.focus?.status, 'stalled', 'with nothing pending, the unchanged rounds still go stalled');
});
