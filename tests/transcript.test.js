'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sessions = require('../src/sessions');
const {forResume, turnsFromHistory, userText} = require('../src/transcript');

function sessionId(t) {
  const id = 'test-' + crypto.randomUUID();
  t.after(() => { try { fs.unlinkSync(sessions.transcriptFile(id)); } catch {} });
  return id;
}
const ev = (seq, role, id, text) => ({event_name: role === 'user' ? 'message.user' : 'message.assistant', role, message_id: id, seq, display_text: text, visibility: 'public', payload: {}});

test('the CLI preamble is cut from the first user message', () => {
  assert.equal(userText('[muser: a terminal coding session …]\nWork on …\n\nUser:\nうおおおおおお'), 'うおおおおおお');
  assert.equal(userText('[muser: …]\nYou are parallel agent "a1" …\n\nTask:\nread LICENSE'), 'read LICENSE');
  assert.equal(userText('plain follow-up'), 'plain follow-up');
});

test('history events become turns: each user message with the last reply after it', () => {
  const turns = turnsFromHistory([
    ev(1, 'user', 'u1', '[muser: x]\n\nUser:\nhello'), ev(2, 'assistant', 'a1', 'draft'), ev(3, 'assistant', 'a2', 'hi!'),
    ev(4, 'user', 'u2', 'next'), ev(5, 'assistant', 'a3', 'done'),
  ]);
  assert.deepEqual(turns.map(t => [t.user, t.reply]), [['hello', 'hi!'], ['next', 'done']]);
});

test('JSONL transcript: append per turn; a cut last line is skipped', t => {
  const id = sessionId(t);
  sessions.appendTurn(id, {user: 'a', reply: 'A'});
  sessions.appendTurn(id, {user: 'b', reply: 'B'});
  fs.appendFileSync(sessions.transcriptFile(id), '{"user":"c","rep');
  assert.deepEqual(sessions.transcript(id).map(x => x.user), ['a', 'b']);
});

test('resume reads the local transcript; Muse only when it has fewer turns, then it is cached', async t => {
  const id = sessionId(t);
  let calls = 0;
  const client = {history: async () => { calls++; return {chat_events: [ev(1, 'user', 'u1', '[muser: x]\n\nUser:\nfirst'), ev(2, 'assistant', 'a1', 'one'), ev(3, 'user', 'u2', 'second'), ev(4, 'assistant', 'a2', 'two')]}; }};
  sessions.appendTurn(id, {v: 1, user: 'second', reply: 'two', tools: [{command: 'code.read', summary: 'x', ok: true}], steps: [], todos: []});
  const r1 = await forResume({id, turns: 2}, client);
  assert.equal(calls, 1); assert.equal(r1.from, 'muse');
  assert.deepEqual(r1.turns.map(x => x.user), ['first', 'second']);
  assert.equal(r1.turns[1].tools.length, 1, 'the richer local record is kept for a turn that is in both');
  const r2 = await forResume({id, turns: 2}, client);
  assert.equal(calls, 1, 'second resume needs no request'); assert.equal(r2.from, 'local');
  assert.deepEqual(r2.turns.map(x => x.user), ['first', 'second']);
});
