'use strict';
// Stage 2 (B2): the recent-events ring holds shapes only — a typed
// character is recorded as the KIND 'char', never the character.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventRing, keyKind, CAP} = require('../src/ui/event-ring');

test('keyKind: named keys keep names, characters become the kind', () => {
  assert.equal(keyKind('a', {}), 'char');
  assert.equal(keyKind('', {return: true}), 'return');
  assert.equal(keyKind('', {escape: true}), 'escape');
  assert.equal(keyKind('', {upArrow: true}), 'upArrow');
  assert.equal(keyKind('x', {ctrl: true}), 'ctrl');
  assert.equal(keyKind('pasted words here', {}), 'sequence');
});

test('the ring never stores a typed character or a sentence', () => {
  const ring = new EventRing();
  ring.recordKey('秘', {});
  ring.recordKey('q', {});
  ring.recordState(['entries', 'busy']);
  ring.recordError('TypeError');
  const json = JSON.stringify(ring.list());
  assert.ok(!json.includes('秘') && !json.includes('"q"'));
  assert.deepEqual(ring.list().map(e => e.type), ['key', 'key', 'state', 'error']);
  assert.equal(ring.list()[0].kind, 'char');
  assert.deepEqual(ring.list()[2].keys, ['entries', 'busy']);
});

test('renders coalesce and the ring caps at CAP', () => {
  const ring = new EventRing();
  ring.recordRender({ms: 3, columns: 80, rows: 24, entries: 5});
  ring.recordRender({ms: 9, columns: 80, rows: 24, entries: 6});
  assert.equal(ring.list().length, 1);
  assert.equal(ring.list()[0].count, 2);
  assert.equal(ring.list()[0].ms, 9);
  for (let i = 0; i < CAP + 50; i++) ring.recordKey('', {return: i % 2 === 0, escape: i % 2 === 1});
  assert.equal(ring.list().length, CAP);
});
