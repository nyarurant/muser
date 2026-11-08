'use strict';
// Muse can finish a turn without answering it. Seen 2026-11-05 in a GUI session: the automatic
// bg-completion note (seq 995) got one memory search from Muse, the chat went 'completed' and
// no assistant message ever followed — muser waited on its 3 h timeout, busy, refusing sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {waitForReply} = require('../src/core/agent-reply');

const user = (id, seq) => ({seq, message_id: id, role: 'user', display_text: 'task'});
const reply = (id, text, seq) => ({seq, message_id: id, role: 'assistant', display_text: text});
function client({status = 'completed', events}) {
  const c = new EventEmitter();
  c.status = status;
  c.history = async () => ({chat_events: events});
  c.request = async () => ({session: {status: c.status}});
  return c;
}
const opts = {sessionId: 's1', pollMs: 10, settleMs: 0, timeoutMs: 1500, silentMs: 100};

test('finished chat, our message last, no reply: the wait ends empty instead of hanging', async () => {
  const events = [user('old-u', 1), reply('old-r', 'earlier answer', 2), user('u1', 3)];
  const w = waitForReply({client: client({events}), ...opts, baseline: new Set(['old-u', 'old-r'])});
  w.accept('u1');
  const r = await w.promise;
  assert.equal(r.text, '');
  assert.equal(r.silent, true);
});

test('a chat still working with no reply yet is not a silent finish', async () => {
  const w = waitForReply({client: client({status: 'running', events: [user('u1', 1)]}), ...opts});
  w.accept('u1');
  await assert.rejects(w.promise, /タイムアウト/);
});

test('our message not in history yet: no silent finish', async () => {
  const w = waitForReply({client: client({events: [user('old-u', 1)]}), ...opts, baseline: new Set(['old-u'])});
  w.accept('u1');
  await assert.rejects(w.promise, /タイムアウト/);
});

test('a tool of this turn still running locally holds the silent verdict', async () => {
  const w = waitForReply({client: client({events: [user('u1', 1)]}), ...opts, localBusy: () => true});
  w.accept('u1');
  await assert.rejects(w.promise, /タイムアウト/);
});

test('the grace restarts when Muse goes busy again, and a real reply still wins', async () => {
  const events = [user('u1', 1)];
  const c = client({events});
  const w = waitForReply({client: c, ...opts, silentMs: 200, timeoutMs: 3000});
  w.accept('u1');
  // completed for a moment (the state from before the send), then running, then the answer
  setTimeout(() => { c.status = 'running'; }, 50);
  setTimeout(() => { events.push(reply('r1', 'done', 2)); c.status = 'completed'; }, 400);
  assert.equal((await w.promise).text, 'done');
});
