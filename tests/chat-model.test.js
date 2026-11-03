'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {messageFromEvent, splitAttachments} = require('../src/core/chat-model');

test('messageFromEvent: visibility gates the message', () => {
  const base = {message_id: 'm1', role: 'assistant', display_text: 'hi'};
  assert.equal(messageFromEvent({...base, visibility: 'private'}), null);
  assert.equal(messageFromEvent({payload: {...base, visibility: 'hidden'}}), null);
  assert.equal(messageFromEvent({...base, visibility: 'public'}).content, 'hi');
  assert.equal(messageFromEvent(base).content, 'hi', 'no visibility field is public by default');
});

test('messageFromEvent: role from event_name / event, explicit role wins', () => {
  assert.equal(messageFromEvent({event_name: 'message.user', message_id: 'a', display_text: 'x'}).role, 'user');
  assert.equal(messageFromEvent({event_name: 'message.assistant', message_id: 'a', display_text: 'x'}).role, 'assistant');
  assert.equal(messageFromEvent({event: 'message.assistant', message_id: 'a', display_text: 'x'}).role, 'assistant');
  assert.equal(messageFromEvent({payload: {event_name: 'message.user', message_id: 'a', role: 'assistant', display_text: 'x'}}).role, 'assistant', 'payload role is used when no event_name role applies');
  assert.equal(messageFromEvent({event_name: 'message.system', message_id: 'a', display_text: 'x'}), null);
  assert.equal(messageFromEvent({message_id: 'a', display_text: 'x'}), null, 'no role anywhere');
});

test('messageFromEvent: non-string content is rejected', () => {
  for (const content of [42, null, undefined, {text: 'x'}, ['x'], true])
    assert.equal(messageFromEvent({message_id: 'a', role: 'user', display_text: content}), null, String(content));
  assert.equal(messageFromEvent({message_id: 'a', role: 'user'}), null, 'missing content');
  assert.equal(messageFromEvent({message_id: 'a', role: 'user', display_text: ''}).content, '', 'empty string is still a string');
});

test('messageFromEvent: a string id is required, with payload fallbacks', () => {
  assert.equal(messageFromEvent({role: 'user', display_text: 'x'}), null, 'missing id');
  assert.equal(messageFromEvent({message_id: 42, role: 'user', display_text: 'x'}), null, 'numeric id');
  assert.equal(messageFromEvent({message_id: '', role: 'user', display_text: 'x'}), null, 'empty id');
  assert.equal(messageFromEvent({payload: {message_id: 'p1', role: 'user', display_text: 'x'}}).id, 'p1');
  assert.equal(messageFromEvent({payload: {id: 'p2', role: 'user', display_text: 'x'}}).id, 'p2');
  assert.equal(messageFromEvent({message_id: 'top', payload: {message_id: 'p3', role: 'user', display_text: 'x'}}).id, 'top', 'top-level id wins');
});

test('messageFromEvent: payload fallbacks for content, seq, time and session', () => {
  const m = messageFromEvent({payload: {id: 'a', role: 'assistant', content: 'from content', chat_event_seq: 7, created_at_ms: 99, session_id: 's9'}});
  assert.deepEqual([m.content, m.seq, m.time, m.sessionId], ['from content', 7, 99, 's9']);
  assert.equal(messageFromEvent({payload: {id: 'a', role: 'assistant', text: 'from text'}}).content, 'from text');
  assert.equal(messageFromEvent({message_id: 'a', role: 'assistant', display_text: 'top', payload: {display_text: 'payload'}}).content, 'top', 'top-level display_text wins');
  assert.equal(messageFromEvent({payload: {id: 'a', role: 'assistant', display_text: 'pd', content: 'pc'}}).content, 'pd', 'display_text before content');
  const d = messageFromEvent({message_id: 'a', role: 'assistant', display_text: 'x'});
  assert.deepEqual([d.seq, d.time, d.sessionId, d.reaction, d.replyTo], [0, 0, '', null, null], 'defaults');
  const r = messageFromEvent({message_id: 'a', role: 'assistant', display_text: 'x', reaction_emoji: '👍', reply_to_message_id: 'prev', reply_to_extra: 1});
  assert.deepEqual([r.reaction, r.replyTo], ['👍', 'prev']);
  assert.equal(messageFromEvent({message_id: 'a', role: 'assistant', display_text: 'x', reaction_emoji: 5}).reaction, null, 'non-string reaction dropped');
});

test('messageFromEvent: attachment markers split only for user messages', () => {
  const m = messageFromEvent({message_id: 'a', role: 'user', display_text: '見て\n[image:image/png workspace/pic.png]\n[file:application/pdf docs/a.pdf ]'});
  assert.equal(m.content, '見て');
  assert.deepEqual(m.attachments, [
    {kind: 'image', mime: 'image/png', path: 'workspace/pic.png'},
    {kind: 'file', mime: 'application/pdf', path: 'docs/a.pdf'},
  ]);
  const a = messageFromEvent({message_id: 'b', role: 'assistant', display_text: 'ok\n[image:image/png workspace/pic.png]'});
  assert.match(a.content, /\[image:/, 'assistant text is left alone');
  assert.deepEqual(a.attachments, []);
  assert.deepEqual(splitAttachments('plain'), {text: 'plain', files: []});
});
