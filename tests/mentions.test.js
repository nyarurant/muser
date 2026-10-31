'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../src/mentions');

test('@ mentions: files and folders go along, emails do not, missing are reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\n');
  assert.deepEqual(m.mentions('mail x@y.com and @src/a.js, @"b c.txt"'), ['src/a.js', 'b c.txt']);
  const read = new Set(), ex = m.expand('@src/a.js @src @gone.txt', dir, read);
  assert.deepEqual(ex.missing, ['gone.txt']);
  assert.match(ex.block, /File src\/a\.js \(3 lines\):\n    1\tone\n    2\ttwo/);
  assert.match(ex.block, /Folder src \(1 files\):\na\.js/);
  assert.ok(read.has(path.join(dir, 'src', 'a.js')));
  assert.deepEqual(m.complete('a.j', dir), ['src/a.js']);
  assert.deepEqual(m.fragmentAt('see @sr', 7), {start: 5, fragment: 'sr'});
  assert.equal(m.fragmentAt('mail x@y', 8), null);
  assert.deepEqual(m.mentions('使わずに、@src/a.js の中身、x@y.com'), ['src/a.js']);
});

test('@ mentions: files over 1 MB are referenced by name only, glob refs skip stat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-big-'));
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1024 * 1024 + 1, 65));
  const ex = m.expand('@big.bin @*.txt', dir, new Set());
  assert.equal(ex.files[0].kind, 'large');
  assert.match(ex.block, /too large to include/);
  assert.ok(!ex.block.includes('AAAA'));
  assert.deepEqual(ex.missing, ['*.txt']);
  // complete() is memoised: repeated calls return the identical array.
  assert.equal(m.complete('big', dir), m.complete('big', dir));
});
