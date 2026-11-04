'use strict';
// Fix phase 2 regressions for src/tools.js (agent A9): deep audit c6 Medium items,
// fourth audit M4 / M11 / M13 (tools.js side), fourth M1 (tools.js side).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TOOLS, isSensitivePath, applyHunks, dropSensitiveLines} = require('../src/tools');

const {after} = require('node:test');
const madeDirs = [];
after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
function ctx() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-')); madeDirs.push(cwd); return {cwd, readFiles: new Set()}; }

test('fix2 c6#3: .git/config is sensitive (remote URLs embed tokens); other config files are not', async () => {
  assert.equal(isSensitivePath('C:/proj/.git/config'), true);
  assert.equal(isSensitivePath(path.join('proj', '.git', 'config')), true);
  assert.equal(isSensitivePath('C:/proj/config'), false);
  assert.equal(isSensitivePath('C:/proj/nginx/config'), false);
  const c = ctx();
  fs.mkdirSync(path.join(c.cwd, '.git'), {recursive: true});
  fs.writeFileSync(path.join(c.cwd, '.git', 'config'), '[remote "origin"]\n\turl = https://x-access-token:FAKE-PAT@github.com/x/y.git\n');
  assert.throws(() => TOOLS['code.read'].run({path: '.git/config'}, c), /機密ファイル/);
  fs.writeFileSync(path.join(c.cwd, 'ok.txt'), 'FAKE-PAT marker\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE-PAT'}, c)).payload.output;
  assert.match(out, /ok\.txt/);
  assert.ok(!out.includes('x-access-token'), out);
});

test('fix2 c6#4: renamed copies of secrets are sensitive (.bak2, extra extension, stacked suffixes); look-alikes stay readable', () => {
  for (const f of ['C:/x/id_rsa.bak2', 'C:/x/credentials.json.txt', 'C:/x/id_rsa.bak.bak.bak.bak.bak',
    'C:/x/cert.pem.txt', 'C:/x/.env.txt', 'C:/x/credentials.bak', 'C:/x/id_rsa.old2', 'C:/x/id_rsa.txt'])
    assert.equal(isSensitivePath(f), true, f);
  for (const f of ['C:/x/credentials.md', 'C:/x/notes.txt.bak', 'C:/x/.env.example.bak', 'C:/x/.env.sample.old',
    'C:/x/id_rsa.pub', 'lib/credentials_manager.js', 'docs/secrets-handling.md', 'C:/x/notes.enc.md', 'C:/x/archive.bak',
    'src/logins.json.bak.md', 'src/id_util.js'])
    assert.equal(isSensitivePath(f), false, f);
});

test('fix2 fourth M4: muser control files in state folders are sensitive; project files are not', async () => {
  const home = os.homedir();
  for (const f of ['permissions.json', 'config.json', 'mcp.json', 'gui.json', 'server.json']) {
    assert.equal(isSensitivePath(path.join(home, '.muser', f)), true, '.muser/' + f);
    assert.equal(isSensitivePath(path.join(home, 'AppData', 'Local', 'muser', f)), true, 'Local/muser/' + f);
  }
  // The repo folder itself is ~/muser: a plain 'muser' segment is not a state folder.
  assert.equal(isSensitivePath(path.join(home, 'muser', 'config.json')), false);
  assert.equal(isSensitivePath('C:/proj/config.json'), false);
  assert.equal(isSensitivePath(path.join(home, '.muser', 'notes.txt')), false, 'only the named control files');
  const c = ctx();
  fs.mkdirSync(path.join(c.cwd, '.muser'), {recursive: true});
  fs.writeFileSync(path.join(c.cwd, '.muser', 'gui.json'), '{"token":"FAKE-BEARER","port":1234}\n');
  assert.throws(() => TOOLS['code.read'].run({path: '.muser/gui.json'}, c), /機密ファイル/);
  fs.writeFileSync(path.join(c.cwd, 'ok.txt'), 'FAKE-BEARER marker\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE-BEARER'}, c)).payload.output;
  assert.match(out, /ok\.txt/);
  assert.ok(!out.includes('gui.json'), out);
  const globbed = (await TOOLS['code.glob'].run({pattern: '**/*.json'}, c)).payload.files;
  assert.deepEqual(globbed, [], 'glob must not list the control file: ' + globbed);
});

test('fix2 fourth M1 (tools side): the relocated permissions store is sensitive under UNC admin-share spellings', () => {
  const prev = process.env.MUSER_PERMISSIONS_FILE;
  process.env.MUSER_PERMISSIONS_FILE = 'C:\\Users\\x\\AppData\\Local\\muser\\permissions.json';
  try {
    assert.equal(isSensitivePath('\\\\localhost\\C$\\Users\\x\\AppData\\Local\\muser\\permissions.json'), true);
    assert.equal(isSensitivePath('\\\\127.0.0.1\\C$\\Users\\x\\AppData\\Local\\muser\\permissions.json'), true);
    assert.equal(isSensitivePath('\\\\?\\UNC\\localhost\\C$\\Users\\x\\AppData\\Local\\muser\\permissions.json'), true);
    assert.equal(isSensitivePath('C:\\Users\\x\\AppData\\Local\\muser\\permissions.json'), true);
    assert.equal(isSensitivePath('\\\\localhost\\C$\\Users\\x\\AppData\\Local\\muser\\other.json'), false);
  } finally { if (prev === undefined) delete process.env.MUSER_PERMISSIONS_FILE; else process.env.MUSER_PERMISSIONS_FILE = prev; }
});

test('fix2 c6#5: a patch cannot write the same file twice under different Windows spellings', () => {
  const c = ctx();
  const two = '*** Begin Patch\n*** Add File: NewFile.txt\n+first\n*** Add File: newfile.txt\n+second\n*** End Patch';
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: two}, c), /written twice/);
  assert.ok(!fs.existsSync(path.join(c.cwd, 'NewFile.txt')) && !fs.existsSync(path.join(c.cwd, 'newfile.txt')), 'nothing was written');
  const dots = '*** Begin Patch\n*** Add File: a.txt\n+first\n*** Add File: a.txt.\n+second\n*** End Patch';
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: dots}, c), /written twice/);
  assert.ok(!fs.existsSync(path.join(c.cwd, 'a.txt')), 'nothing was written');
  // A case-only move is an in-place update, not "destination already exists".
  fs.writeFileSync(path.join(c.cwd, 'm.txt'), 'hello\n');
  TOOLS['code.read'].run({path: 'm.txt'}, c);
  const r = TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: m.txt\n*** Move to: M.TXT\n-hello\n+hi\n*** End Patch'}, c);
  assert.equal(r.payload.files.length, 1);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'm.txt'), 'utf8'), 'hi\n');
});

test('fix2 c6#6: a pure-addition hunk inserts after its @@ anchor, not at the end of the file', () => {
  const src = 'function a() {\n}\nfunction b() {\n}\n';
  assert.equal(applyHunks(src, [{anchor: 'function a() {', lines: ['+inserted();']}], 'a.js'),
    'function a() {\ninserted();\n}\nfunction b() {\n}\n');
  // No anchor: still appends at the end, as before.
  assert.equal(applyHunks(src, [{anchor: '', lines: ['+inserted();']}], 'a.js'),
    'function a() {\n}\nfunction b() {\n}\ninserted();\n');
});

test('fix2 c6#7: grep and glob see hidden files and folders, but never .git internals or sensitive dotfiles', async () => {
  const c = ctx();
  fs.mkdirSync(path.join(c.cwd, '.github', 'workflows'), {recursive: true});
  fs.mkdirSync(path.join(c.cwd, '.git'), {recursive: true});
  fs.writeFileSync(path.join(c.cwd, 'normal.txt'), 'needle\n');
  fs.writeFileSync(path.join(c.cwd, '.dotfile.txt'), 'needle\n');
  fs.writeFileSync(path.join(c.cwd, '.github', 'workflows', 'ci.txt'), 'needle\n');
  fs.writeFileSync(path.join(c.cwd, '.git', 'description'), 'needle\n');
  fs.writeFileSync(path.join(c.cwd, '.env'), 'needle=FAKE-SECRET\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'needle'}, c)).payload.output;
  assert.match(out, /normal\.txt/);
  assert.match(out, /\.dotfile\.txt/);
  assert.match(out, /ci\.txt/);
  assert.ok(!out.includes('.git\\') && !out.includes('description'), out);
  assert.ok(!out.includes('FAKE-SECRET'), out);
  const files = (await TOOLS['code.glob'].run({pattern: '**/*.txt'}, c)).payload.files;
  assert.ok(files.includes(path.join('.github', 'workflows', 'ci.txt')), files.join(','));
  assert.ok(files.includes('.dotfile.txt'), files.join(','));
  assert.ok(!files.some(f => f.split(path.sep).includes('.git')), files.join(','));
});

test('fix2 c6#8 / fourth M11: dropSensitiveLines gives the same verdicts without re-statting per hit line', () => {
  const c = ctx();
  fs.writeFileSync(path.join(c.cwd, 'ok.txt'), 'x\n');
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push('ok.txt:1:hit ' + i);
  lines.push('.env:1:FAKE-SECRET');
  lines.push('sub/.ssh/id_rsa:1:FAKE-KEY');
  const t0 = Date.now();
  const kept = dropSensitiveLines(lines, c, false);
  const ms = Date.now() - t0;
  assert.equal(kept.length, 20000, 'all ordinary hits are kept');
  assert.ok(!kept.some(l => l.includes('FAKE')), 'sensitive lines are still dropped');
  assert.ok(ms < 1500, 'filtering 20k lines of 1 file took ' + ms + 'ms (was ~2500-3100ms before the per-path cache)');
});

test('fix2 fourth M13: code.glob count is the true total and files are the newest 500 of all matches', async () => {
  const c = ctx();
  const total = 2050;
  for (let i = 0; i < total; i++) fs.writeFileSync(path.join(c.cwd, 'f' + String(i).padStart(4, '0') + '.txt'), 'x');
  const newest = path.join(c.cwd, 'zz-newest.txt');
  fs.writeFileSync(newest, 'x');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(newest, future, future);
  const r = (await TOOLS['code.glob'].run({pattern: '**/*.txt'}, c)).payload;
  assert.equal(r.count, total + 1, 'count is not cut at the old 2000 cap');
  assert.equal(r.files.length, 500);
  assert.equal(r.files[0], 'zz-newest.txt', 'the newest file overall comes first, not the newest of an arbitrary subset');
  assert.equal(r.truncated, true);
});
