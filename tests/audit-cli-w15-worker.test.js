'use strict';
// Audit-cli wave 15 regression tests for W13-15 (src/agent.js, uncommitted fixes):
//  (FIX A) runTurn resets a spawned worker's collection state at the start of
//          every run (resultOffset:0, collected:false, result:'', text:'',
//          ended:0, lastTool:''). Without it, a direct runWorker rerun of a
//          finished worker kept the old offset/collected, so agent.wait
//          delivered the new result sliced from the old offset (its head
//          never arrived) or treated it as already collected and pruned it.
//  (FIX B) Worker.snapshot(): a done worker's text is only the LAST LINE of
//          its reply (result keeps the full text); while working, text
//          passes through whole. Without it, every done snapshot carried
//          the full reply twice (text and result).
// Harness modelled on tests/worker-retry.test.js: a fake Muse client drives
// a real Agent and the real agent.wait tool path (executeAgentTool).
//
// Isolation / head guard: every home-like folder is redirected under this
// process's %TEMP% root BEFORE any src module is loaded, and the file
// aborts unless that redirection held — the resident Server and the real
// HOME are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

const tmpRoot = fs.realpathSync(os.tmpdir());
const isolated = name => fs.mkdtempSync(path.join(tmpRoot, name));
process.env.LOCALAPPDATA = isolated('muser-w15-worker-data-');
process.env.USERPROFILE = process.env.HOME = isolated('muser-w15-worker-home-');
for (const [k, v] of [['LOCALAPPDATA', process.env.LOCALAPPDATA], ['USERPROFILE', process.env.USERPROFILE], ['HOME', process.env.HOME]]) {
  if (!v || !fs.realpathSync(v).startsWith(tmpRoot)) throw new Error('head guard: ' + k + ' is not under the %TEMP% root: ' + v);
}

const {Agent} = require('../src/agent');

// A Muse whose chats answer by script, per SEND (not per chat): the n-th
// message sent to a chat gets replyOf(sessionId, n) as its reply, under its
// own message id, answering that send's message id. Keying by send is what
// lets one chat serve two sequential runs: runTurn's baseline fetch for the
// second run sees only the first reply, and the wait then adopts the second.
function fakeMuse(t, {replyOf}) {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  const sends = new Map(); // sessionId -> number of sends so far
  c.history = async id => {
    const n = sends.get(id) || 0;
    const events = [];
    for (let i = 1; i <= n; i++) {
      const r = replyOf(id, i);
      if (r != null) events.push({seq: i * 2, message_id: 'reply-' + id + '-' + i, role: 'assistant', display_text: r, reply_to_message_id: 'msg-' + id + '-' + i});
    }
    return {chat_events: events, has_more: false};
  };
  c.request = async () => ({session: {status: 'completed'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async () => {};
  c.disconnect = () => {};
  const cwd = isolated('muser-w15-worker-cwd-');
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const a = new Agent({client: c, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd, session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  a.ensureConnected = async () => {};
  a.device = {connected: true, send: async (body, sessionId) => { const n = (sends.get(sessionId) || 0) + 1; sends.set(sessionId, n); return {message_id: 'msg-' + sessionId + '-' + n}; }};
  t.after(() => { try { a.close(); } catch {} });
  return {a, sends};
}
function done(a, tag, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent-done never came for ' + tag)), ms);
    const events = [];
    a.on('agent-done', s => { if (s.tag !== tag) return; events.push(s); clearTimeout(timer); setTimeout(() => resolve(events), 300); });
  });
}
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, usage: null, log: {tools: [], steps: []}};
  return a.main.turn;
}
async function waitFor(a, tag) {
  const r = await a.executeAgentTool(a.main, 'agent.wait', {tags: tag, timeout_s: 1});
  assert.equal(r.ok, true, 'agent.wait itself succeeds');
  const entry = r.payload.agents.find(x => x.tag === tag);
  assert.ok(entry, 'agent.wait reports the worker');
  return entry;
}

test('w15 rerun delivery: a direct runWorker rerun is delivered by agent.wait from its head, not the old offset', {timeout: 30000}, async t => {
  const first = 'HEAD1-FIRST-RUN\n' + 'a'.repeat(20000 - 'HEAD1-FIRST-RUN\n'.length);
  const second = 'HEAD2-SECOND-RUN\n' + 'b'.repeat(20000 - 'HEAD2-SECOND-RUN\n'.length);
  assert.equal(first.length, 20000); assert.equal(second.length, 20000);
  const {a} = fakeMuse(t, {replyOf: (id, n) => n === 1 ? first : second});
  const w = a.spawn('first job', {by: 'muse'});
  const events = await done(a, w.tag);
  assert.equal(events[0].state, 'done');
  assert.equal(w.state, 'done');
  assert.equal(w.result, first);

  // Collect the first result in slices: two waits advance resultOffset by
  // two 8000-char slices, and the worker is not yet fully collected.
  startTurn(a);
  const slice1 = await waitFor(a, w.tag);
  assert.ok(slice1.result.startsWith('HEAD1-FIRST-RUN'), 'first wait delivers the first result from its head');
  const slice2 = await waitFor(a, w.tag);
  assert.ok(slice2.result.startsWith('a'), 'second wait delivers the next slice');
  assert.ok(w.resultOffset > 0, 'resultOffset advanced after two waits, got ' + w.resultOffset);
  assert.equal(w.resultOffset, 16000);
  assert.equal(w.collected, false, 'tail not yet delivered, so not collected');

  // The rerun itself: runWorker called directly on the SAME finished worker.
  const reply = await a.runWorker(w, 'second job');
  assert.equal(reply.text, second, 'the rerun returns the new reply');
  assert.equal(w.state, 'done');
  assert.equal(w.result, second, 'the worker holds the new result');
  // FIX A pins: the new run started from a clean collection state.
  assert.equal(w.resultOffset, 0, 'rerun reset resultOffset to 0');
  assert.equal(w.collected, false, 'rerun reset collected to false');
  const pending = a.uncollectedAgentSummaries();
  assert.ok(pending.some(x => x.tag === w.tag && x.result === second), 'the rerun result counts as pending/uncollected, not already delivered');

  // And agent.wait must hand the NEW result out from its head: with the old
  // offset kept, this slice would start 16000 chars in and HEAD2 would
  // never be delivered; with collected kept, the worker could be pruned.
  const delivered = await waitFor(a, w.tag);
  assert.equal(delivered.state, 'done');
  assert.ok(delivered.result.includes('HEAD2-SECOND-RUN'), 'agent.wait delivers the new result from its head (HEAD2 marker present)');
  assert.ok(delivered.result.startsWith('HEAD2-SECOND-RUN'), 'the delivered slice starts at the head of the new result');
});

test('w15 snapshot: a done worker snapshot text is only the last line, result keeps the full reply', {timeout: 30000}, async t => {
  const reply = 'line1\nline2\nLASTLINE';
  const {a} = fakeMuse(t, {replyOf: () => reply});
  const w = a.spawn('multi-line job', {by: 'muse'});
  await done(a, w.tag);
  assert.equal(w.state, 'done');
  assert.equal(w.result, reply);
  const snap = w.snapshot();
  assert.equal(snap.result, reply, 'snapshot result is the full reply');
  assert.equal(snap.text, 'LASTLINE', 'snapshot text is only the last line once done (FIX B)');
});

// FIX B, working state — unit-level: a mid-run snapshot cannot be observed
// reliably through the fake-Muse harness (the reply lands and the state
// flips to done within the same poll cycle), so this drives a real Worker
// instance's fields directly and calls its snapshot(), as the task allows.
test('w15 snapshot: a working worker snapshot carries the streamed text whole (unit-level)', async t => {
  const {a} = fakeMuse(t, {replyOf: () => null});
  const w = a.main; // a real Worker instance; only its snapshot() is exercised here
  const streamed = 'stream line1\nstream line2\nstream tail';
  w.state = 'working'; w.text = streamed; w.result = '';
  const working = w.snapshot();
  assert.equal(working.text, streamed, 'while working, snapshot text passes through whole');
  assert.equal(working.result, '');
  w.state = 'done'; w.text = 'line1\nline2\nLASTLINE'; w.result = 'line1\nline2\nLASTLINE';
  const doneSnap = w.snapshot();
  assert.equal(doneSnap.text, 'LASTLINE', 'the same worker, once done, snapshots only the last line');
  assert.equal(doneSnap.result, 'line1\nline2\nLASTLINE');
});
