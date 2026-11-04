'use strict';
// Fix phase 2, agent A5: src/agent.js Medium findings (deep c2, first
// #10-#13, third M26-M29 agent side, fifth f3-1). Repros:
// audit2/fix2/repro-A5.cjs and repro-A5b.cjs (all reproduced pre-fix,
// except deep c2 #1 — see the MUSE.md/CLAUDE.md test at the bottom).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-agent-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-agent-home-'));

const {Agent, projectInstructions} = require('../src/agent');
const {Focus} = require('../src/focus');

const NOTE = '（プロジェクト指示が長いため一部省略しました）';
function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-agent-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, sessionOver = {}) {
  const cwd = tmpdir(t);
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id: 's1', cwd, title: '', created: 0, updated: 0, turns: 0, ...sessionOver}});
  a.subscribed = true;
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}
function startTurn(a, over = {}) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, usage: null, ...over};
  return a.main.turn;
}

// ---------- deep c2 #2: instruction files are not read whole ----------

test('fix2 c2-2: a huge instruction file is read bounded, still capped with the note', (t) => {
  const dir = tmpdir(t);
  const big = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(big, 'x'.repeat(300000));
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { if (String(p) === big) throw new Error('readFileSync must not be used for the huge file'); return orig(p, ...rest); };
  try {
    const mine = projectInstructions(dir).filter(e => e.file === big);
    assert.equal(mine.length, 1, 'the huge file still contributes its (capped) head');
    assert.ok(mine[0].text.length <= 12000);
    assert.ok(mine[0].text.startsWith('x'.repeat(100)));
    assert.ok(mine[0].text.includes(NOTE), 'truncation is marked, not silent');
  } finally { fs.readFileSync = orig; }
});

// ---------- deep c2 #3: account switch vs a turn starting mid-switch ----------

test('fix2 c2-3: send, sendFocused and spawn are refused while a switch is in progress', async (t) => {
  const a = makeAgent(t);
  a._switching = true;
  await assert.rejects(a.send('hi'), /作業中/);
  await assert.rejects(a.sendFocused('hi'), /作業中/);
  assert.throws(() => a.spawn('job', {by: 'user'}), /作業中/);
});

test('fix2 c2-3: a turn that starts during switch preparation refuses the switch, nothing is torn down', async (t) => {
  const a = makeAgent(t);
  const oldClient = a.client, oldSession = a.session;
  let deviceDown = 0;
  a.device = {connected: true, disconnect: () => { deviceDown++; }};
  let releaseVm; const gate = new Promise(r => { releaseVm = r; });
  const nextClient = stubClient();
  const next = {account: {id: 'acc2', label: 'Two'}, files: null, web: {}, auth: {vm: async () => { await gate; return {}; }}, client: nextClient};
  const p = a.switchAccount(next);
  await new Promise(r => setTimeout(r, 20));
  startTurn(a); // a turn got in while the target was still being prepared
  releaseVm();
  await assert.rejects(p, /作業中はアカウントを切り替えられません/);
  assert.equal(a.client, oldClient, 'still on the old client');
  assert.equal(a.session, oldSession, 'session untouched');
  assert.equal(a.accountId, null, 'account unchanged');
  assert.equal(deviceDown, 0, 'device link was never torn down');
  a.main.turn = null;
});

// ---------- deep c2 #4: agent.wait duplicate tags ----------

test('fix2 c2-4: agent.wait with a duplicated tag delivers each slice exactly once', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const w = {tag: 'a1', title: 'a1', by: 'muse', typeName: 'general', type: undefined, state: 'done', lastTool: '', text: '', result: 'a'.repeat(8000) + 'b'.repeat(8000) + 'c'.repeat(4000), error: '', started: 0, ended: 0, collected: false, turn: null, starting: false, main: false, session: {id: 'sess-a1'}, ctx: null};
  a.workers.set('a1', w);
  const r1 = await a.executeAgentTool(a.main, 'agent.wait', {tags: 'a1,a1,a1', timeout_s: 1});
  assert.equal(w.resultOffset, 8000, 'offset advances by one slice, not one per duplicate');
  assert.ok(r1.payload.agents[0].result.startsWith('a'));
  const r2 = await a.executeAgentTool(a.main, 'agent.wait', {tags: 'a1', timeout_s: 1});
  assert.ok(r2.payload.agents[0].result.startsWith('b'), 'the middle slice is delivered, not skipped');
  assert.equal(w.resultOffset, 16000);
});

// ---------- deep c2 #5: baseline must be complete or the turn aborts ----------

function runTurnAgent(t, history) {
  const a = makeAgent(t, {turns: 3});
  a.client.history = history;
  let sends = 0;
  a.device = {connected: true, send: async () => { sends++; throw new Error('sentinel-send'); }};
  return {a, sends: () => sends};
}

test('fix2 c2-5: history with more pages than the fetch cap aborts a non-first turn before sending', async (t) => {
  const {a, sends} = runTurnAgent(t, async (id, before) => ({chat_events: [{seq: (before || 10000) - 10}], has_more: true}));
  await assert.rejects(a.runTurn(a.main, 'hi'), /履歴の取得に失敗したためターンを開始できませんでした/);
  assert.equal(sends(), 0, 'nothing was sent on a partial baseline');
});

test('fix2 c2-5: has_more with no usable seq aborts a non-first turn before sending', async (t) => {
  const {a, sends} = runTurnAgent(t, async () => ({chat_events: [{foo: 1}], has_more: true}));
  await assert.rejects(a.runTurn(a.main, 'hi'), /履歴の取得に失敗したためターンを開始できませんでした/);
  assert.equal(sends(), 0);
});

test('fix2 c2-5: a complete history still lets the turn proceed to sending', async (t) => {
  const {a, sends} = runTurnAgent(t, async () => ({chat_events: [{seq: 5}], has_more: false}));
  await assert.rejects(a.runTurn(a.main, 'hi'), /sentinel-send/);
  assert.equal(sends(), 1);
});

// ---------- deep c2 #6: close() stops scoped resubscribe timers ----------

test('fix2 c2-6: close() clears scope resubscribe timers; nothing resubscribes after close', async (t) => {
  const a = makeAgent(t);
  let subs = 0; a.client.subscribeAgent = async () => { subs++; };
  a.onStreamClosed({path: '/chat/subscribe', scope: 'sc1'});
  assert.equal(a.scopeResubs.size, 1);
  a.close();
  assert.equal(a.scopeResubs.size, 0, 'timers are cleared with the agent');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(subs, 0, 'the closed agent never resubscribes');
});

// ---------- first #10: interrupt() scope ----------

test('fix2 first-10: interrupt stops only the current turn’s workers, not survivors of earlier turns', async (t) => {
  const a = makeAgent(t);
  const stopped = []; a.stopAgent = async tag => { stopped.push(tag); };
  const oldTurn = {controller: new AbortController()}, curTurn = startTurn(a);
  a.workers.set('a1', {tag: 'a1', main: false, turn: {controller: new AbortController()}, starting: false, spawnedIn: oldTurn, focusTask: null});
  a.workers.set('a2', {tag: 'a2', main: false, turn: {controller: new AbortController()}, starting: false, spawnedIn: curTurn, focusTask: null});
  await a.interrupt();
  assert.deepEqual(stopped, ['a2']);
});

test('fix2 first-10: interrupt between Focus rounds still stops the current Focus run’s workers', async (t) => {
  const a = makeAgent(t);
  const stopped = []; a.stopAgent = async tag => { stopped.push(tag); };
  const focus = new Focus('TASK');
  a.focusRun = {focus, controller: new AbortController()};
  a.workers.set('a1', {tag: 'a1', main: false, turn: {controller: new AbortController()}, starting: false, spawnedIn: null, focusTask: focus});
  a.workers.set('a2', {tag: 'a2', main: false, turn: {controller: new AbortController()}, starting: false, spawnedIn: null, focusTask: new Focus('OTHER')});
  await a.interrupt();
  assert.deepEqual(stopped, ['a1']);
  a.focusRun = null;
});

// ---------- first #11 (agent side): resumeLeg carries the user's words ----------

test('fix2 first-11: a resumed leg hands Focus the user’s actual message, not only a boolean', async (t) => {
  const a = makeAgent(t);
  const f = new Focus('TASK'); let seen = null;
  const orig = f.resumeLeg.bind(f); f.resumeLeg = (g, o) => { seen = o; return orig(g, o); };
  a.resumeFocus = {focus: f, sessionId: 's1'};
  a.runTurn = async () => ({text: 'ok', sources: [], usage: null, focusDecision: {continue: false}});
  await a.sendFocused('実機で確認しました、その通りです', {turnEnd: false});
  assert.equal(seen.fromUser, true);
  assert.equal(seen.userText, '実機で確認しました、その通りです');
});

test('fix2 first-11: an automatic continuation leg is not a user leg', async (t) => {
  const a = makeAgent(t);
  const f = new Focus('TASK'); let seen = null;
  const orig = f.resumeLeg.bind(f); f.resumeLeg = (g, o) => { seen = o; return orig(g, o); };
  a.resumeFocus = {focus: f, sessionId: 's1'};
  a.runTurn = async () => ({text: 'ok', sources: [], usage: null, focusDecision: {continue: false}});
  await a.sendFocused('[muser: automatic continuation]', {turnEnd: false, continuation: true, automatic: true});
  assert.equal(seen.fromUser, false);
});

// ---------- first #12: baseline events contribute no usage ----------

test('fix2 first-12: a replayed baseline event cannot overwrite the turn’s usage', (t) => {
  const a = makeAgent(t);
  const turn = startTurn(a, {baseline: new Set(['old1'])});
  a.onChatEvent({event: 'delta.message_done', payload: {session_id: 's1', message_id: 'old1', transcript: {messages: [{role: 'assistant', content: 'old reply\n[usage] context_tokens=111 response_tokens=22 source=provider'}]}}});
  assert.equal(turn.usage, null);
  a.onChatEvent({event: 'delta.message_done', payload: {session_id: 's1', message_id: 'new1', transcript: {messages: [{role: 'assistant', content: 'new reply\n[usage] context_tokens=10 response_tokens=3 source=provider'}]}}});
  assert.equal(turn.usage.inputTokens, 10, 'a current-turn event still lands');
});

// ---------- first #13: quoted [usage] lines survive streaming ----------

test('fix2 first-13: a quoted [usage] line mid-reply is not eaten by chunk boundaries', (t) => {
  const a = makeAgent(t);
  startTurn(a);
  let last = '';
  a.on('text', e => { last = e.text; });
  a.onChatEvent({event: 'delta.text_append', payload: {session_id: 's1', message_id: 'm1', seq: 1, text: 'example line:\n[usage] context_tokens=5 response_tokens=6 source=x\n'}});
  a.onChatEvent({event: 'delta.text_append', payload: {session_id: 's1', message_id: 'm1', seq: 2, text: 'more text after'}});
  a.onChatEvent({event: 'delta.message_done', payload: {session_id: 's1', message_id: 'm1', seq: 3, transcript: {messages: []}}});
  assert.ok(last.includes('[usage] context_tokens=5'), 'the quoted line survives to the final text: ' + JSON.stringify(last));
});

test('fix2 first-13: a real trailing [usage] line is still stripped at message_done', (t) => {
  const a = makeAgent(t);
  startTurn(a);
  let last = '';
  a.on('text', e => { last = e.text; });
  a.onChatEvent({event: 'delta.text_append', payload: {session_id: 's1', message_id: 'm1', seq: 1, text: 'answer body\n[usage] context_tokens=9 response_tokens=9 source=x'}});
  a.onChatEvent({event: 'delta.message_done', payload: {session_id: 's1', message_id: 'm1', seq: 2, transcript: {messages: []}}});
  assert.equal(last, 'answer body');
});

// ---------- third M26 / M27 / M28 / M29 + fifth f3-1 ----------

test('fix2 M26: a /goal leg plans the goal instead of resuming a parked unrelated task', async (t) => {
  const a = makeAgent(t);
  a.session.goal = {text: 'GOAL TEXT', legs: 0, setAt: Date.now()};
  const old = new Focus('OLD TASK');
  a.resumeFocus = {focus: old, sessionId: 's1'};
  let legGoal = null;
  a.runTurn = async (w, input, opts) => { legGoal = opts.focus?.goal; return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}}; };
  await a.afterGoal({focus: {status: 'complete', goal: 'OLD TASK'}, text: 'done', usage: null});
  assert.equal(legGoal, 'GOAL TEXT');
  assert.ok(a.resumeFocus, 'the parked task stays parked for the next user message');
});

test('fix2 M26: sendFocused with resume:false leaves the stash untouched', async (t) => {
  const a = makeAgent(t);
  const old = new Focus('OLD TASK');
  a.resumeFocus = {focus: old, sessionId: 's1'};
  let legGoal = null;
  a.runTurn = async (w, input, opts) => { legGoal = opts.focus?.goal; return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}}; };
  await a.sendFocused('goal leg', {display: 'GOAL TEXT', turnEnd: false, continuation: true, resume: false});
  assert.equal(legGoal, 'GOAL TEXT');
  assert.equal(a.resumeFocus?.focus, old);
});

test('fix2 M27: a new leg adopts still-running workers of a previous Focus instance', async (t) => {
  const a = makeAgent(t);
  const oldFocus = new Focus('OLD');
  const wk = {tag: 'a1', main: false, focusTask: oldFocus, turn: {}, starting: false};
  a.workers.set('a1', wk);
  let pending = null, legFocus = null;
  a.runTurn = async (w, input, opts) => { legFocus = opts.focus; pending = [...a.workers.values()].some(x => !x.main && x.focusTask === opts.focus && (x.turn || x.starting)); return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}}; };
  await a.sendFocused('new task', {turnEnd: false});
  assert.equal(pending, true, 'the leg sees the surviving worker as its own pending work');
  assert.equal(wk.focusTask, legFocus);
});

test('fix2 M28: a worker the user spawns during a Focus run belongs to the task', async (t) => {
  const a = makeAgent(t);
  const f = new Focus('TASK');
  a.focusRun = {focus: f, controller: new AbortController()};
  a.runTurn = async () => ({});
  const w = a.spawn('side job', {by: 'user'});
  assert.equal(w.focusTask, f);
  a.focusRun = null;
  const w2 = a.spawn('independent job', {by: 'user'});
  assert.equal(w2.focusTask, null, 'outside a Focus run a user worker stays untracked, as before');
});

test('fix2 M29: a workers-pending round waits for the workers before the next round', async (t) => {
  const a = makeAgent(t);
  const order = []; let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++; order.push('round' + round);
    if (round === 1) {
      const wk = {tag: 'a1', main: false, focusTask: opts.focus, turn: {}, starting: false};
      a.workers.set('a1', wk);
      setTimeout(() => { wk.turn = null; order.push('worker-done'); }, 250);
      return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true, workersPending: true}};
    }
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}};
  };
  await a.sendFocused('task', {turnEnd: false});
  assert.deepEqual(order, ['round1', 'worker-done', 'round2']);
});

test('fix2 f3-1: a worker alive at every round end can no longer postpone the Focus time limit forever', async (t) => {
  const realNow = Date.now;
  // The audit's E2 shape (rounds of 50 fake minutes, a 60-minute limit,
  // worker alive at the first two round ends): the old whole-round credit
  // stopped at round 4 (200 minutes). Rounds ending with workers pending
  // still do not consume the limit (tests/focus.test.js pins that), but
  // the pending state is bounded by the limit itself, and once the worker
  // is gone the fully counted elapsed time bites: round 3, not round 4.
  let fakeNow = 1000000000, rounds = 0;
  Date.now = () => fakeNow;
  try {
    const a = makeAgent(t);
    a.runTurn = async (w, input, opts) => {
      fakeNow += 50 * 60000; rounds++;
      if (rounds <= 2) a.workers.set('a1', {tag: 'a1', main: false, focusTask: opts.focus, turn: {}, starting: false});
      else a.workers.delete('a1');
      return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true}};
    };
    const reply = await a.sendFocused('task', {maxRounds: 10, timeoutMs: 60 * 60000, turnEnd: false});
    assert.equal(rounds, 3);
    assert.equal(reply.focus?.status, 'limit');
  } finally { Date.now = realNow; }
  // A worker that NEVER finishes: the old code never fired the limit at
  // all. Now the continuously-pending bound fires it (round 3 here).
  fakeNow = 1000000000; rounds = 0;
  Date.now = () => fakeNow;
  try {
    const a = makeAgent(t);
    a.runTurn = async (w, input, opts) => {
      fakeNow += 50 * 60000; rounds++;
      a.workers.set('a1', {tag: 'a1', main: false, focusTask: opts.focus, turn: {}, starting: false});
      return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true}};
    };
    const reply = await a.sendFocused('task', {maxRounds: 10, timeoutMs: 60 * 60000, turnEnd: false});
    assert.equal(rounds, 3, 'the limit fires even though the worker is still running');
    assert.equal(reply.focus?.status, 'limit');
  } finally { Date.now = realNow; }
});

// ---------- deep c2 #1: NOT REPRODUCED — MUSE.md is not CLAUDE.md ----------

test('fix2 c2-1 (not reproduced): CLAUDE.md and MUSE.md are two different instruction files', (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'from claude');
  fs.writeFileSync(path.join(dir, 'MUSE.md'), 'from muse');
  const mine = projectInstructions(dir).filter(e => e.file.startsWith(dir));
  assert.equal(mine.length, 2, 'both files are read, once each — they are not the same file on Windows');
  assert.deepEqual(mine.map(e => e.text).sort(), ['from claude', 'from muse']);
});
