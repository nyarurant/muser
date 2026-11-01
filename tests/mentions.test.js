'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../src/mentions');

test('@ mentions: files and folders go along, emails do not, missing are reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\n');
  await m.ready(dir);
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

test('walkFiles fallback: skips hidden files and node_modules, sorted / paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-walk-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'node_modules', 'x'), {recursive: true}); fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), ''); fs.writeFileSync(path.join(dir, 'a.txt'), '');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'c.js'), ''); fs.writeFileSync(path.join(dir, '.hidden'), ''); fs.writeFileSync(path.join(dir, '.git', 'config'), '');
  assert.deepEqual(m.walkFiles(dir), ['a.txt', 'src/b.js']);
  // After a completion the listing diagnostic always says which source produced it.
  await m.ready(dir); m.complete('a', dir);
  assert.ok(['rg', 'walk'].includes(m.listDiag().source));
  assert.equal(typeof m.listDiag().error, 'string');
});

test('@ mentions: files over 1 MB are referenced by name only, glob refs skip stat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-big-'));
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1024 * 1024 + 1, 65));
  await m.ready(dir);
  const ex = m.expand('@big.bin @*.txt', dir, new Set());
  assert.equal(ex.files[0].kind, 'large');
  assert.match(ex.block, /too large to include/);
  assert.ok(!ex.block.includes('AAAA'));
  assert.deepEqual(ex.missing, ['*.txt']);
  // complete() is memoised: repeated calls return the identical array.
  assert.equal(m.complete('big', dir), m.complete('big', dir));
});

// 2026-11-01: the list came from a synchronous rg inside the render, so "@" in a big folder froze
// the screen. Now the first call returns at once and the list arrives in the background.
test('@ completion never waits for the file list: empty while loading, then filled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-bg-'));
  fs.writeFileSync(path.join(dir, 'later.txt'), '');
  let readyCalls = 0;
  const first = m.complete('lat', dir, 6, () => { readyCalls++; }); // empty + loading = it did not run rg first
  assert.deepEqual(first, []);
  assert.equal(m.loading(dir), true);
  await m.ready(dir);
  assert.equal(m.loading(dir), false);
  assert.equal(readyCalls, 1, 'the caller is told to re-render once');
  assert.deepEqual(m.complete('lat', dir), ['later.txt']);
});

test('switching folders while a list is being built keeps the new folder\'s list', async () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-b-'));
  fs.writeFileSync(path.join(a, 'only-a.txt'), ''); fs.writeFileSync(path.join(b, 'only-b.txt'), '');
  const pa = m.ready(a);
  m.complete('only', b); // the user resumed a chat in another folder before a's list came back
  assert.equal(m.loading(b), true);
  await pa;
  // Whichever finished first: b is either still loading or already has its own list, never a's.
  assert.ok(m.loading(b) || m.complete('only', b).length === 1, "a's listing finishing must not clear or replace b's");
  await m.ready(b);
  assert.deepEqual(m.complete('only', b), ['only-b.txt']);
});
