'use strict';
// Fix phase 2 regression tests for src/mentions.js and src/account-add.js:
//  - c13 #2 / deep #101: a URL's @path is not a mention
//  - c13 #3 / deep #102: a failed read after a successful stat must not throw
//  - c13 #4 / deep #103: MAX_TOTAL counts line-number prefixes too
//  - c13 #5 / deep #104: the same file under another spelling expands once
//  - c13 #6 / deep #105: truncation never splits a surrogate pair
//  - c13 #7 / deep #106: capped rg output drops its partial last line + says so
//  - first #18: @folder listings withhold sensitive file names
//  - third M15: stripCode is not quadratic on unclosed backticks
//  - third M16: ~~~ fences hide mentions like ``` fences
//  - fourth M12: the @ completion list is not capped at 20,000
//  - c13 #15 / deep #111: a non-Error throw survives account-add's rollback notes
//  - first #33 (account-add part): a kept half-registered account is named on the error
//  - phase-1 H6 guard: Japanese particles after @file still resolve
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// Same isolation as tests/account-add.test.js: never the real data folder.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-home-'));

const m = require('../src/mentions');
const accounts = require('../src/accounts');
const store = require('../src/secure-store');
const {addAccount} = require('../src/account-add');

const createdDirs = [];
function tmpdir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); createdDirs.push(dir); return dir; }
after(() => { for (const dir of createdDirs) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} } });
const rgAvailable = (() => { try { const r = spawnSync('rg', ['--version'], {encoding: 'utf8', timeout: 10000}); return !r.error && r.status === 0; } catch { return false; } })();
const hasLoneSurrogate = s => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0xD800 && c <= 0xDBFF && !(s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF)) return true; if (c >= 0xDC00 && c <= 0xDFFF && !(s.charCodeAt(i - 1) >= 0xD800 && s.charCodeAt(i - 1) <= 0xDBFF)) return true; } return false; };

test('H6 guard: Japanese particles/punctuation after @file still resolve (phase 1)', () => {
  const dir = tmpdir('muser-fix2-h6-');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme-body');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a-body');
  const ex = m.expand('@README.md\u3092\u898b\u3066 @a.txt\uFF01', dir, new Set());
  assert.deepEqual(ex.missing, []);
  assert.ok(ex.block.includes('readme-body') && ex.block.includes('a-body'));
});

test('c13 #2: a URL @path is not a mention and never inlines a local namesake', () => {
  assert.deepEqual(m.mentions('see https://example.com/@user/profile and mail a@b.co'), []);
  assert.deepEqual(m.mentions('see https://example.com/@user/profile and @real.txt'), ['real.txt']);
  const dir = tmpdir('muser-fix2-url-');
  fs.mkdirSync(path.join(dir, 'user'));
  fs.writeFileSync(path.join(dir, 'user', 'profile'), 'LOCAL-PROFILE-CONTENT');
  const ex = m.expand('look at https://example.com/@user/profile please', dir, new Set());
  assert.ok(!ex.block.includes('LOCAL-PROFILE-CONTENT'), 'the local file behind the URL is not sent');
  assert.deepEqual(ex.files, []);
  assert.deepEqual(ex.missing, [], 'no bogus missing entry for the URL segment');
});

test('c13 #3: a read that fails after stat reports the ref missing and keeps the rest', () => {
  const dir = tmpdir('muser-fix2-read-');
  const target = path.join(dir, 'locked.txt');
  fs.writeFileSync(target, 'locked-body');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok-body');
  const origRead = fs.readFileSync, origOpen = fs.openSync;
  const denied = p => { if (String(p) === target) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } };
  fs.readFileSync = (p, ...a) => { denied(p); return origRead(p, ...a); };
  fs.openSync = (p, ...a) => { denied(p); return origOpen(p, ...a); };
  try {
    const ex = m.expand('@locked.txt @ok.txt', dir, new Set());
    assert.deepEqual(ex.missing, ['locked.txt']);
    assert.ok(ex.block.includes('ok-body'), 'the other mention still expands');
    assert.ok(!ex.block.includes('locked-body'));
  } finally { fs.readFileSync = origRead; fs.openSync = origOpen; }
});

test('c13 #4: MAX_TOTAL budgets the rendered block, line-number prefixes included', () => {
  const dir = tmpdir('muser-fix2-total-');
  fs.writeFileSync(path.join(dir, 'blank.txt'), '\n'.repeat(39999)); // ~40 KB of empty lines
  const ex = m.expand('@blank.txt', dir, new Set());
  assert.equal(ex.files[0].kind, 'file');
  assert.match(ex.block, /truncated/);
  assert.ok(ex.block.length <= 150100, 'block stays within the 150k budget + header (was 280062): ' + ex.block.length);
});

test('c13 #5: the same file under another spelling is expanded only once', () => {
  const dir = tmpdir('muser-fix2-dup-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello-dup');
  const ex = m.expand('@a.txt @./a.txt @A.TXT', dir, new Set());
  assert.equal(ex.block.split('hello-dup').length - 1, 1, 'the content appears once');
  assert.equal(ex.files.length, 1);
  assert.deepEqual(ex.missing, []);
});

test('c13 #6: truncation never leaves a lone surrogate; intact emoji survive uncut', () => {
  const dir = tmpdir('muser-fix2-sur-');
  fs.writeFileSync(path.join(dir, 'emo.txt'), 'a'.repeat(39999) + '\uD83D\uDE00' + 'tail');
  const ex = m.expand('@emo.txt', dir, new Set());
  assert.match(ex.block, /truncated/);
  assert.equal(hasLoneSurrogate(ex.block), false);
  fs.writeFileSync(path.join(dir, 'small.txt'), 'hi \uD83D\uDE00 there');
  const ex2 = m.expand('@small.txt', dir, new Set());
  assert.ok(ex2.block.includes('\uD83D\uDE00'), 'an uncut emoji is preserved as a pair');
});

test('first #18: a @folder listing withholds sensitive file names', () => {
  const dir = tmpdir('muser-fix2-f18-');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}');
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'k');
  fs.writeFileSync(path.join(dir, 'key.pem'), 'k');
  fs.writeFileSync(path.join(dir, 'normal.txt'), 'n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'secret.json'), '{}');
  fs.writeFileSync(path.join(dir, 'sub', 'ok.txt'), 'o');
  const ex = m.expand('@.', dir, new Set());
  assert.equal(ex.files[0].kind, 'dir');
  for (const name of ['credentials.json', 'id_rsa', 'key.pem', 'secret.json']) assert.ok(!ex.block.includes(name), name + ' is not named to the model');
  assert.ok(ex.block.includes('normal.txt') && ex.block.includes('sub/ok.txt'), 'ordinary names are still listed');
  assert.match(ex.block, /sensitive names? withheld/);
  assert.equal(ex.files[0].count, 2, 'the count covers visible names only');
});

test('third M15: stripCode stays fast on a line of unclosed backticks', () => {
  const s = '`x '.repeat(25000); // 100k chars, no newline, no valid closing run
  const t0 = Date.now();
  const refs = m.mentions(s);
  const ms = Date.now() - t0;
  assert.deepEqual(refs, []);
  assert.ok(ms < 3000, 'not quadratic (was ~8 s at 100k before): ' + ms + ' ms');
  const many = ('`a` '.repeat(1000)) + '@real.txt';
  assert.deepEqual(m.mentions(many), ['real.txt'], 'valid spans on the same line still hide, a later mention still shows');
});

test('third M16: tilde fences hide mentions; an unclosed tilde fence stays literal', () => {
  assert.deepEqual(m.mentions('~~~\n@decorator\n~~~\n@real.txt'), ['real.txt']);
  assert.deepEqual(m.mentions('~~~js\n@in-fence.txt\n~~~\n@after.txt'), ['after.txt']);
  assert.deepEqual(m.mentions('~~~\n@x.txt'), ['x.txt'], 'unclosed fence does not eat the mention');
  assert.deepEqual(m.mentions('~~ @hidden.txt ~~'), ['hidden.txt'], 'double tilde is prose, not a span: the mention inside still shows');
});

test('c13 #7: capped rg output drops the partial last name and notes it in listDiag', {skip: !rgAvailable && 'no rg binary on PATH: the capped path is rg-specific'}, async () => {
  const dir = tmpdir('muser-fix2-cap-');
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(2, '0') + '-' + 'x'.repeat(60) + '.txt'), '');
  const files = await m.listFilesAsync(dir, 10000, 512);
  assert.ok(files.length >= 1 && files.length < 40, 'the list was actually capped: ' + files.length);
  for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), 'every returned name is a real file, not a fragment: ' + f);
  assert.match(m.listDiag().error, /capped/);
});

test('fourth M12: files past 20,000 still reach @ completion and walkFiles', {timeout: 240000}, async () => {
  const dir = tmpdir('muser-fix2-cap20k-');
  for (let i = 0; i < 20001; i++) fs.writeFileSync(path.join(dir, 'a' + String(i).padStart(5, '0') + '.txt'), '');
  fs.writeFileSync(path.join(dir, 'zzzz-tail.txt'), '');
  const walked = m.walkFiles(dir);
  assert.equal(walked.length, 20002);
  assert.ok(walked.includes('zzzz-tail.txt'));
  await m.ready(dir);
  assert.deepEqual(m.complete('zzzz-tail', dir), ['zzzz-tail.txt']);
});

// --- src/account-add.js ---
const ui = {busy: async (label, fn) => fn(), info() {}, note() {}, ask: async () => '', confirm: async () => true, pick: async () => 0, close() {}};

test('c13 #15: a login throwing a non-Error survives the rollback notes verbatim', async () => {
  let removed = false;
  const fakeAccounts = {
    add: () => ({id: 'fake-1', label: 'Fake'}),
    filesFor: () => ({web: 'fake/web.enc', device: 'fake/device.enc', session: 'fake/session.enc', browser: 'fake/browser'}),
    remove: () => { removed = true; return {leftover: 'C:\\ leftover'}; },
  };
  const err = await addAccount('Fake', {ui, deps: {
    accounts: fakeAccounts, store: {preload() {}}, web: {createWeb: () => ({}), loadJar: () => ({})},
    login: async () => { throw 'plain string failure'; }, pcLogin: async () => {}, sameMuse: async () => null,
  }}).then(() => null, e => e);
  assert.equal(err, 'plain string failure', 'the original thrown value, not a TypeError about attaching to it');
  assert.equal(removed, true, 'the rollback still ran');
});

test('c13 #15: a frozen Error keeps its identity through the rollback notes', async () => {
  const frozen = Object.freeze(new Error('frozen failure'));
  const fakeAccounts = {
    add: () => ({id: 'fake-2', label: 'Frozen'}),
    filesFor: () => ({web: 'fake/web.enc', device: 'fake/device.enc', session: 'fake/session.enc', browser: 'fake/browser'}),
    remove: () => ({leftover: 'C:\\ leftover'}),
  };
  const err = await addAccount('Frozen', {ui, deps: {
    accounts: fakeAccounts, store: {preload() {}}, web: {createWeb: () => ({}), loadJar: () => ({})},
    login: async () => { throw frozen; }, pcLogin: async () => {}, sameMuse: async () => null,
  }}).then(() => null, e => e);
  assert.equal(err, frozen, 'the very same error object is rethrown');
});

test('first #33: a registration failure after a landed login names the kept account on the error', async () => {
  const deps = {accounts, store: {preload() {}}, web: {createWeb: () => ({}), loadJar: () => ({})}, sameMuse: async () => null,
    login: async () => { const f = accounts.filesFor(accounts.resolve('Fix2 Kept').id); fs.mkdirSync(path.dirname(store.file(f.web)), {recursive: true}); fs.writeFileSync(store.file(f.web), 'x'); },
    pcLogin: async () => { throw new Error('code never arrived'); }};
  const err = await addAccount('Fix2 Kept', {ui, deps}).then(() => null, e => e);
  const keptId = accounts.resolve('Fix2 Kept')?.id;
  try {
    assert.match(err.message, /code never arrived/);
    assert.deepEqual(err.accountKept, {id: keptId, label: 'Fix2 Kept'}, 'the caller can name the half-finished account and how to finish it');
    assert.ok(accounts.get(keptId), 'the account itself is kept, as before (its login landed)');
  } finally { if (keptId) accounts.remove(keptId); }
});
