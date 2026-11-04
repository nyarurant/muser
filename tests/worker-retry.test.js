'use strict';
// A parallel agent whose chat Muse ends with an error before it ran any tool starts again once,
// in a fresh chat, and main never hears of the first failure (2026-11-04: ten of 36 agents got
// Muse's "Sorry, I ran into a problem" within 45 seconds; main started its own retries while
// muser's were running, and two agents edited the same files).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Agent} = require('../src/agent');

// A Muse whose chats answer by script: status(sessionId, n) says what /api/session/list/:id
// returns on the n-th poll of that chat, reply(sessionId) the assistant text once it is done.
function fakeMuse(t, {statusOf, replyOf}) {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  const polls = new Map(), sent = [];
  c.history = async id => {
    // The reply exists only once the task was sent there (before that, the turn reads the
    // history as its baseline of old messages).
    const r = sent.includes(id) ? replyOf(id) : null;
    return {chat_events: r ? [{seq: 2, message_id: 'reply-' + id, role: 'assistant', display_text: r, reply_to_message_id: 'msg-' + id}] : [], has_more: false};
  };
  c.request = async (verb, p) => { const id = decodeURIComponent(p.split('/').pop()); const n = (polls.get(id) || 0) + 1; polls.set(id, n); return {session: {status: statusOf(id, n)}}; };
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async () => {};
  c.disconnect = () => {};
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-retry-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const a = new Agent({client: c, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd, session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  a.ensureConnected = async () => {};
  a.device = {connected: true, send: async (body, sessionId) => { sent.push(sessionId); return {message_id: 'msg-' + sessionId}; }};
  t.after(() => { try { a.close(); } catch {} });
  return {a, sent};
}
function done(a, tag, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent-done never came for ' + tag)), ms);
    const events = [];
    a.on('agent-done', s => { if (s.tag !== tag) return; events.push(s); clearTimeout(timer); setTimeout(() => resolve(events), 300); });
  });
}

test('an agent whose first chat Muse ends with an error goes again in a new chat, and main sees only the result', {timeout: 30000}, async t => {
  let first = null;
  const {a, sent} = fakeMuse(t, {
    statusOf: id => { first ??= id; return id === first ? 'errored' : 'completed'; },
    replyOf: (id) => id !== first && first ? '終わりました' : null,
  });
  const w = a.spawn('調べて', {by: 'muse'});
  const events = await done(a, w.tag);
  assert.equal(events.length, 1, 'one agent-done, not a failure followed by a success');
  assert.equal(events[0].state, 'done');
  assert.equal(events[0].result, '終わりました');
  assert.equal(new Set(sent).size, 2, 'the task went to two different chats');
  assert.equal(w.retried, 1);
});

test('no retry once the agent has run a tool: its work may already be half done', {timeout: 30000}, async t => {
  const {a, sent} = fakeMuse(t, {statusOf: () => 'errored', replyOf: () => null});
  const w = a.spawn('直して', {by: 'muse'});
  const orig = a.device.send;
  a.device.send = async (...args) => { const r = await orig(...args); w.turn.toolCalls = 1; return r; }; // as if a tool ran
  const events = await done(a, w.tag);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'failed');
  assert.equal(sent.length, 1, 'sent once, no second chat');
});

test('a retry that fails too is reported as a failure, no third chat', {timeout: 30000}, async t => {
  const {a, sent} = fakeMuse(t, {statusOf: () => 'errored', replyOf: () => null});
  const w = a.spawn('調べて', {by: 'muse'});
  const events = await done(a, w.tag);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'failed');
  assert.match(events[0].error, /errored/);
  assert.equal(sent.length, 2, 'the first chat and one retry');
});
