'use strict';
// No-progress watchdog for waitForReply: the silent-finish check covers a chat that ENDS
// without a reply, but a chat stuck at busy, a history read that keeps failing, or a final
// message that never becomes ready had no exit short of the overall timeout (3 h in
// agent.js) — the window stayed busy and refused every send, like the 2026-11-05 hang.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {waitForReply} = require('../src/core/agent-reply');

const user = (id, seq) => ({seq, message_id: id, role: 'user', display_text: 'task'});
const reply = (id, text, seq) => ({seq, message_id: id, role: 'assistant', display_text: text});
function client({status = 'completed', events, historyFails = false}) {
  const c = new EventEmitter();
  c.status = status;
  c.history = async () => { if (historyFails) throw new Error('history down'); return {chat_events: events}; };
  c.request = async () => ({session: {status: c.status}});
  return c;
}
const opts = {sessionId: 's1', pollMs: 10, settleMs: 0, timeoutMs: 5000, silentMs: 60000, stallMs: 200};

test('a chat stuck at busy with no events ends on the watchdog, not the 3 h timeout', async () => {
  const started = Date.now();
  const w = waitForReply({client: client({status: 'running', events: [user('u1', 1)]}), ...opts});
  w.accept('u1');
  await assert.rejects(w.promise, err => err.stalled === true && /タイムアウト/.test(err.message));
  assert.ok(Date.now() - started < 2000, 'the watchdog fired long before the overall timeout');
});

test('a history read that keeps failing also ends on the watchdog', async () => {
  const w = waitForReply({client: client({status: 'running', events: [], historyFails: true}), ...opts});
  w.accept('u1');
  await assert.rejects(w.promise, err => err.stalled === true);
});

test('session events are signs of life: the wait survives past stallMs and takes the reply', async () => {
  const events = [user('u1', 1)];
  const c = client({status: 'running', events});
  const w = waitForReply({client: c, ...opts});
  w.accept('u1');
  const drip = setInterval(() => c.emit('event', {event: 'delta.message', payload: {session_id: 's1'}}), 50);
  await new Promise(r => setTimeout(r, 450)); // > 2 x stallMs of pure event flow
  clearInterval(drip);
  events.push(reply('r1', 'done', 2));
  c.status = 'completed';
  assert.equal((await w.promise).text, 'done');
});

test('history growth counts as progress even with no events', async () => {
  const events = [user('u1', 1)];
  const c = client({status: 'running', events});
  const w = waitForReply({client: c, ...opts});
  w.accept('u1');
  let seq = 1;
  // Growth that is neither a user nor an assistant message: the raw history tail
  // moves (progress) without changing who may answer the turn (a second user
  // message would rightly switch the wait to the strict replyTo rule).
  const grow = setInterval(() => { events.push({seq: ++seq, message_id: 'tick' + seq, role: 'system', display_text: 'tick'}); }, 50);
  await new Promise(r => setTimeout(r, 450));
  clearInterval(grow);
  events.push(reply('r1', 'done', ++seq));
  c.status = 'completed';
  assert.equal((await w.promise).text, 'done');
});

test('a local tool still running holds the watchdog; the plain timeout still applies', async () => {
  const w = waitForReply({client: client({status: 'running', events: [user('u1', 1)]}), ...opts, timeoutMs: 500, localBusy: () => true});
  w.accept('u1');
  await assert.rejects(w.promise, err => err.stalled !== true && /タイムアウト/.test(err.message));
});
