'use strict';
// Focus weakness 2 (2026-11-06): waiting on task agents must not spin rounds.
// The wait happens inside the round that ended with workers pending, until a
// worker finishes, the continuously-pending time limit runs out, or Esc aborts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-wait-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-wait-home-'));

const {Agent} = require('../src/agent');
const {Focus} = require('../src/focus');

function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-wait-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
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
// A worker that finishes after ms; while it runs it looks pending to Focus.
function pendingWorker(a, focus, ms) {
  const wk = {tag: 'a1', main: false, focusTask: focus, turn: {}, starting: false};
  a.workers.set('a1', wk);
  if (ms != null) setTimeout(() => { wk.turn = null; }, ms);
  return wk;
}

test('weakness 2: a 12-second worker costs no waiting round', async (t) => {
  const a = makeAgent(t);
  const order = []; let round = 0; const started = Date.now();
  a.runTurn = async (w, input, opts) => {
    round++; order.push('round' + round);
    if (round === 1) {
      pendingWorker(a, opts.focus, 12000);
      return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true, workersPending: true}};
    }
    // The worker is done by now: the collection round, not a waiting round.
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}};
  };
  await a.sendFocused('task', {turnEnd: false});
  assert.deepEqual(order, ['round1', 'round2'], 'one working round, one collection round — no spinning round in between');
  assert.ok(Date.now() - started >= 11000, 'the wait really lasted until the worker finished');
  assert.equal(a.focusRun, null);
});

test('weakness 2: a worker that never finishes still hits the time limit in one round', async (t) => {
  const a = makeAgent(t);
  let round = 0; const started = Date.now();
  a.runTurn = async (w, input, opts) => {
    round++;
    pendingWorker(a, opts.focus, null); // never finishes
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true, workersPending: true}};
  };
  const reply = await a.sendFocused('task', {maxRounds: 10, timeoutMs: 3000, turnEnd: false});
  const elapsed = Date.now() - started;
  assert.equal(round, 1, 'no new round starts while the worker is pending');
  assert.equal(reply.focus?.status, 'limit', 'the continuously-pending bound still bites');
  assert.ok(elapsed >= 2500 && elapsed < 10000, 'the limit fires at about the timeout, not after spinning rounds: ' + elapsed + 'ms');
});

test('weakness 2: a worker pending at the round limit does not stall the leg', async (t) => {
  // The round limit does not advance while workers run (endRound's
  // workersPending exemption), so with rounds exhausted the leg must not
  // sit in the wait until the time limit: it proceeds, and the
  // continuously-pending bound ends it. The stubbed runTurn returns
  // instantly, so a short timeout keeps this test fast; in production a
  // round takes seconds (a gateway call), so the same bound ends the leg
  // after one full limit span, as before.
  const a = makeAgent(t);
  const started = Date.now();
  a.runTurn = async (w, input, opts) => {
    pendingWorker(a, opts.focus, null); // never finishes
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true, workersPending: true}};
  };
  const reply = await a.sendFocused('task', {maxRounds: 1, timeoutMs: 300, turnEnd: false});
  const elapsed = Date.now() - started;
  assert.equal(reply.focus?.status, 'limit', 'the continuously-pending bound stops the leg');
  assert.ok(elapsed < 5000, 'it does not wait out a 15-minute time limit first: ' + elapsed + 'ms');
  assert.ok(a.workers.get('a1'), 'the worker stays registered for a later leg');
});

test('weakness 2: Esc during the worker wait stops at once', async (t) => {
  const a = makeAgent(t);
  let round = 0; const started = Date.now();
  a.runTurn = async (w, input, opts) => {
    round++;
    pendingWorker(a, opts.focus, null); // never finishes
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true, workersPending: true}};
  };
  setTimeout(() => { a.focusRun?.controller.abort(); }, 600);
  await assert.rejects(a.sendFocused('task', {turnEnd: false}), e => e.name === 'AbortError');
  const elapsed = Date.now() - started;
  assert.equal(round, 1, 'no new round starts while the worker is pending');
  assert.ok(elapsed < 5000, 'Esc stops the wait at once: ' + elapsed + 'ms');
  assert.equal(a.lastFocus?.status, 'stopped');
});
