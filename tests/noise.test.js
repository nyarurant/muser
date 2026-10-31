'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {Transport, Cipher, cat, uint, bytes} = require('../src/core/noise');

// A Cipher with no key is a passthrough, so chunk frames can be built by hand:
// a wire chunk is fields {1: stream/chunk id, 2: index, 3: count, 4: payload}.
function chunk(id, index, count, payload) {
  return cat(uint(1, id), uint(2, index), uint(3, count), bytes(4, payload));
}
function transport() { return new Transport(new Cipher(), new Cipher()); }

test('a complete single-chunk frame still decodes', () => {
  const t = transport();
  const frame = cat(uint(1, 9n), bytes(4, cat(bytes(1, Buffer.from('hi')), uint(2, 1))));
  const out = t.decode(chunk(42n, 0, 1, bytes(1, frame)));
  assert.equal(out.type, 'body');
  assert.equal(out.id, 9n);
  assert.equal(out.body.toString(), 'hi');
  assert.equal(out.end, true);
  assert.equal(t.chunks.size, 0);
  t.destroy();
});

test('a partial entry swept after 30s frees its slot', () => {
  const t = transport();
  assert.equal(t.decode(chunk(7n, 0, 2, Buffer.from('a'))), null);
  assert.equal(t.chunks.size, 1);
  const created = t.chunks.get('7').created;
  t.sweepChunks(created + 30001);
  assert.equal(t.chunks.size, 0);
  t.destroy();
});

test('a partial entry expires via its timer even if decode() never runs again', (t) => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  try {
    const tr = transport();
    assert.equal(tr.decode(chunk(8n, 0, 2, Buffer.from('a'))), null);
    assert.equal(tr.chunks.size, 1);
    t.mock.timers.tick(30002);
    assert.equal(tr.chunks.size, 0);
    tr.destroy();
  } finally {
    t.mock.timers.reset();
  }
});

test('the 16-entry cap still applies, and a decode-time sweep frees stale slots', () => {
  const t = transport();
  for (let i = 1; i <= 16; i++) t.decode(chunk(BigInt(i), 0, 2, Buffer.from('a')));
  assert.equal(t.chunks.size, 16);
  assert.throws(() => t.decode(chunk(99n, 0, 2, Buffer.from('a'))), /Too many Muse frames/);
  // A later decode sweeps entries older than 30s before the cap is checked,
  // by ageing the stored timestamps the way the wall clock would.
  const old = Date.now() - 31000;
  for (const v of t.chunks.values()) v.created = old;
  assert.equal(t.decode(chunk(100n, 0, 2, Buffer.from('a'))), null);
  assert.equal(t.chunks.size, 1);
  t.destroy();
});
