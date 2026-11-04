'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const m = require('../src/mentions');

// B8: every test in this file mkdtemps its own fixture dir and none of them
// were cleaned. Track them all (every call site goes through this fs object)
// and remove them when the file finishes.
const createdDirs = [];
const origMkdtempSync = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdDirs.push(dir); return dir; };
after(() => { for (const dir of createdDirs) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} } });

// B7: the timeout test below pins rg-specific behaviour (source stays 'rg'
// after a 1 ms timeout). Without an rg binary on PATH, listFilesAsync falls
// back to the walk and that test can only fail — skip it in that case instead.
const rgAvailable = (() => { try { const r = spawnSync('rg', ['--version'], {encoding: 'utf8', timeout: 10000}); return !r.error && r.status === 0; } catch { return false; } })();

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

// Audit #239: '[', ']', '{' and '}' are legal in Windows file names; refs using them
// used to be declared missing without a stat.
test('@ mentions: file names with [ ] { } are real files, not obviously missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-brackets-'));
  fs.writeFileSync(path.join(dir, 'notes [draft].md'), 'bracketed');
  fs.writeFileSync(path.join(dir, 'data{1}.txt'), 'braced');
  const ex = m.expand('@"notes [draft].md" @data{1}.txt', dir, new Set());
  assert.deepEqual(ex.missing, []);
  assert.match(ex.block, /bracketed/);
  assert.match(ex.block, /braced/);
});

// Audit #240: a stray backtick must not swallow a mention. An unclosed fence ate the
// rest of the message; a lone backtick paired with a later real span's opener.
test('@ mentions: stray backticks stay literal; real code spans still hide mentions', () => {
  const B = String.fromCharCode(96);
  assert.deepEqual(m.mentions('x ' + B + B + B + '\ncode @b.txt'), ['b.txt'], 'unclosed fence does not eat the mention');
  assert.deepEqual(m.mentions('a ' + B + ' stray @c.txt and ' + B + 'code' + B + ' end'), ['c.txt'], 'a stray backtick does not pair with the next span');
  assert.deepEqual(m.mentions('run ' + B + '@babel/core' + B + ' first'), [], 'a real span still hides its mention');
  assert.deepEqual(m.mentions(B + B + B + '\n@in-fence.txt\n' + B + B + B + '\n@after.txt'), ['after.txt'], 'a closed fence still hides its contents');
});

// Audit #238: MAX_TOTAL budgets the whole block — folder listings and notices count
// toward it, not just plain file bodies.
test('@ expand: folder listings count toward MAX_TOTAL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-total-'));
  const many = path.join(dir, 'many'); fs.mkdirSync(many);
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(many, 'f' + i + '-' + 'x'.repeat(70) + '.txt'), '');
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(dir, n + '.txt'), 'y'.repeat(39900));
  const ex = m.expand('@many @a.txt @b.txt @c.txt @d.txt', dir, new Set());
  assert.deepEqual(ex.files.map(f => f.kind), ['dir', 'file', 'file', 'file', 'file']);
  // Tightened from 155000 (t1 #13): measured 150041 with the current build —
  // the 150,000 content budget plus 41 chars of framing. The old bound hid
  // ~5k of slack, so a counting regression could pass unnoticed.
  assert.ok(ex.block.length <= 150250, 'the whole block stays within the 150k budget (was ~178k when listings were free): ' + ex.block.length);
});

// Audit #241: after an rg timeout resolves with the partial list, the killed child's
// close handler must not run the full fallback walk (discarded anyway) or overwrite
// the diagnostic.
test('listFilesAsync: a timeout keeps its partial result and its diagnostic', {skip: !rgAvailable && 'no rg binary on PATH: the timeout path is rg-specific (without rg the listing falls back to the walk)'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-timeout-'));
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), '');
  const files = await m.listFilesAsync(dir, 1);
  assert.ok(Array.isArray(files));
  assert.equal(m.listDiag().source, 'rg');
  assert.match(m.listDiag().error, /stopped after/);
  // The old code slept one fixed 600 ms ("the killed rg closes in the
  // meantime") and checked once at the end. The child handle lives inside
  // src/mentions, so its close cannot be awaited directly from here; what CAN
  // be done is poll the diagnostic continuously across a wider window
  // (1500 ms, checked every 25 ms): a late close handler that overwrote the
  // diagnostic at ANY point in that window is now caught, not just one that
  // happened to land before a single end-of-sleep check. (PARTIAL: the window
  // is still time-based because no close signal is exported.)
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    assert.equal(m.listDiag().source, 'rg', 'the close handler did not run the fallback walk over the result');
    assert.match(m.listDiag().error, /stopped after/);
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(m.listDiag().source, 'rg', 'the close handler did not run the fallback walk over the result');
  assert.match(m.listDiag().error, /stopped after/);
});

// Audit #237: an @mention must never inline a secret, however it was named —
// the read tools refuse these paths, and the mention path used to bypass them.
test('@ mentions: secrets are withheld by name, never inlined (audit #237)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-at-secret-'));
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'PRIVATE KEY BODY');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abc');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.mkdirSync(path.join(dir, '.ssh'));
  fs.writeFileSync(path.join(dir, '.ssh', 'id_ed25519'), 'ANOTHER KEY');
  const ex = m.expand('@id_rsa @.env @notes.txt @.ssh @../' + path.basename(dir) + '/id_rsa', dir, new Set());
  assert.ok(!ex.block.includes('PRIVATE KEY BODY'), 'the key body never reaches the message');
  assert.ok(!ex.block.includes('TOKEN=abc'), 'the env body never reaches the message');
  assert.ok(!ex.block.includes('ANOTHER KEY'));
  assert.ok(!/id_ed25519/.test(ex.block), 'a sensitive folder is not even listed');
  assert.match(ex.block, /File notes\.txt/);
  assert.deepEqual(ex.files.filter(f => f.kind === 'sensitive').map(f => f.ref), ['id_rsa', '.env', '.ssh', '../' + path.basename(dir) + '/id_rsa']);
  assert.deepEqual(ex.missing, []);
});
