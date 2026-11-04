'use strict';
// A finished chat whose only new user message is this turn's: its reply is adopted whatever
// replyTo says. Seen on 2026-11-04 in Muse's own history of a 36-agent run: two finished agents
// whose reply pointed at an unknown id were never adopted (muser waited until it was stopped),
// and 45 of 51 replies had no replyTo, adopted only when the done event reached the wait.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {waitForReply} = require('../src/core/agent-reply');

const user = (id, seq) => ({seq, message_id: id, role: 'user', display_text: 'task'});
const reply = (id, text, seq, extra = {}) => ({seq, message_id: id, role: 'assistant', display_text: text, ...extra});
function client({status = 'completed', events}) {
  const c = new EventEmitter();
  c.history = async () => ({chat_events: events});
  c.request = async () => ({session: {status}});
  return c;
}
const opts = {sessionId: 's1', pollMs: 20, settleMs: 0, timeoutMs: 1500};

test('a finished chat with only our message: a reply pointing at an unknown id is adopted', async () => {
  const w = waitForReply({client: client({events: [user('u1', 1), reply('r1', '完了しました', 2, {reply_to_message_id: 'not-the-ack'})]}), ...opts});
  w.accept('ack-id');
  assert.equal((await w.promise).text, '完了しました');
});

test('a finished chat with only our message: a replyTo-less reply is adopted by polling, no done event needed', async () => {
  const w = waitForReply({client: client({events: [user('u1', 1), reply('r1', '完了', 2)]}), ...opts});
  w.accept('ack-id');
  assert.equal((await w.promise).text, '完了');
});

test('two new user messages (another turn in the same chat): the strict replyTo rule still holds', async () => {
  const w = waitForReply({client: client({events: [user('u1', 1), user('u2', 2), reply('r2', 'answer to the other turn', 3)]}), ...opts});
  w.accept('ack-id');
  await assert.rejects(w.promise, /タイムアウト/, 'an unrelated reply is not taken as ours');
});

test('a chat still working is not read as finished', async () => {
  const w = waitForReply({client: client({status: 'running', events: [user('u1', 1), reply('r1', 'partial', 2, {reply_to_message_id: 'x'})]}), ...opts});
  w.accept('ack-id');
  await assert.rejects(w.promise, /タイムアウト/);
});

test('messages already in the baseline do not count as new', async () => {
  const events = [user('old-u', 1), reply('old-r', 'old answer', 2), user('u1', 3), reply('r1', 'new answer', 4, {reply_to_message_id: 'zzz'})];
  const w = waitForReply({client: client({events}), ...opts, baseline: new Set(['old-u', 'old-r'])});
  w.accept('ack-id');
  assert.equal((await w.promise).text, 'new answer');
});
