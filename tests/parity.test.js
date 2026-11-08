'use strict';
// Environment comparison, stage 1 (docs/design/new-features.md §10): the
// snapshot's collection flow is pinned with a fake probe runner and a fake
// environment (design §13 — a fake instead of the real PC), the diff's
// ordering is pinned, and the secret rules (§0) are checked against the
// snapshot as data: a token-shaped value, the user's name and a lock file's
// contents must appear nowhere in it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const parity = require('../src/parity');

const HOME = 'C:\\Users\\testuser';
function fakeRun(overrides = {}) {
  const table = {
    'chcp.com': 'Active code page: 932',
    'powershell.exe': 'RemoteSigned\n',
    'reg.exe': 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\n    LongPathsEnabled    REG_DWORD    0x1\n',
    'npm.cmd': '10.2.3\n',
    'git': 'git version 2.47.1.windows.1',
    'python': 'Python 3.12.7',
    'pip': 'pip 24.0 from C:\\x (python 3.12)',
    'rustc': 'rustc 1.82.0 (f6e511eec 2024-10-15)',
    'cargo': 'cargo 1.82.0 (2dbb1af80 2024-10-20)',
    'pnpm.cmd': '9.1.0\n',
    'yarn.cmd': '1.22.22\n',
  };
  return (file, args) => {
    const key = args && args.includes('pip') ? 'pip' : file;
    if (key in overrides) return overrides[key];
    return key in table ? table[key] : null;
  };
}
function fakeEnv(overrides = {}) {
  return {
    PATH: 'C:\\Users\\testuser\\bin;C:\\Tools;C:\\Users\\testuser\\.cargo\\bin',
    NODE_ENV: 'development',
    MY_SECRET_TOKEN: 'tok-must-not-appear',
    OTHER: 'x',
    ...overrides,
  };
}
function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-parity-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const snap = (t, files, opts = {}) => parity.collectSnapshot({cwd: project(t, files), env: fakeEnv(), home: HOME, run: fakeRun(), now: new Date('2026-11-07T00:00:00Z'), ...opts});

test('snapshot collects the stage-1 fingerprint (OS, locale, settings, tools, locks)', t => {
  const lock = '{"lockfileVersion":3}';
  const s = snap(t, {'package.json': '{"name":"x"}', 'package-lock.json': lock, 'Cargo.toml': '[package]'});
  assert.equal(s.kind, 'muser-parity');
  assert.equal(s.version, 1);
  assert.equal(s.os.platform, process.platform);
  assert.ok(s.os.version, 'OS version present');
  assert.equal(s.locale.codePage, 932);
  assert.ok(s.locale.language, 'language present');
  assert.equal(s.settings.executionPolicy, 'RemoteSigned');
  assert.equal(s.settings.longPaths, true);
  assert.equal(s.tools.node, parity.parseVersion(process.version));
  assert.equal(s.tools.npm, '10.2.3');
  assert.equal(s.tools.git, '2.47.1.windows.1');
  assert.equal(s.tools.python, '3.12.7');
  // Cargo.toml in the project adds the Rust tools (inferred, §10).
  assert.equal(s.tools.rustc, '1.82.0');
  assert.equal(s.tools.cargo, '1.82.0');
  // The lock file is a hash and a size, never its contents.
  assert.deepEqual(s.locks, [{file: 'package-lock.json', sha256: crypto.createHash('sha256').update(lock).digest('hex'), bytes: Buffer.byteLength(lock)}]);
});

test('snapshot keeps secrets out: env values, the user name, lock contents', t => {
  const s = snap(t, {'package.json': '{}', 'package-lock.json': 'lock-contents-must-not-appear'});
  const all = JSON.stringify(s);
  assert.ok(!all.includes('tok-must-not-appear'), 'a token-shaped env value is not recorded');
  assert.ok(!all.includes('lock-contents-must-not-appear'), 'lock contents are not recorded');
  assert.ok(!all.includes('testuser'), 'the user name is not recorded');
  assert.deepEqual(s.env.values, {NODE_ENV: 'development'}, 'only the allowlist carries values');
  assert.ok(s.env.names.includes('MY_SECRET_TOKEN'), 'other variables are names only');
  assert.deepEqual(s.path, ['%USERPROFILE%\\bin', 'C:\\Tools', '%USERPROFILE%\\.cargo\\bin'], 'PATH entries hide the profile folder');
});

test('tools are inferred from project files, and a pinned package manager counts', t => {
  const base = snap(t, {'package.json': '{}'});
  assert.deepEqual(Object.keys(base.tools).sort(), ['git', 'node', 'npm', 'python']);
  const withYarn = snap(t, {'package.json': '{}', 'yarn.lock': ''});
  assert.equal(withYarn.tools.yarn, '1.22.22');
  const withPnpm = snap(t, {'package.json': '{"packageManager":"pnpm@9.1.0"}'});
  assert.equal(withPnpm.tools.pnpm, '9.1.0', 'packageManager in package.json adds the tool');
  const withPip = snap(t, {'requirements.txt': 'x==1'});
  assert.equal(withPip.tools.pip, '24.0', 'a Python project adds pip');
  const missing = snap(t, {'package.json': '{}'}, {run: fakeRun({'git': null})});
  assert.equal(missing.tools.git, null, 'a tool that cannot run is null, not a guess');
});

test('parseVersion and sanitizePathEntry edge cases', () => {
  assert.equal(parity.parseVersion(''), null);
  assert.equal(parity.parseVersion('no numbers here'), null);
  assert.equal(parity.parseVersion('v22.1.0\n'), '22.1.0');
  assert.equal(parity.sanitizePathEntry('C:\\Users\\testuser\\bin', 'D:\\home\\testuser'), '%USERPROFILE%\\bin', 'a C:\\Users\\<name> prefix is replaced even when the profile is on another drive');
  assert.equal(parity.sanitizePathEntry('C:\\Tools', HOME), 'C:\\Tools');
  assert.equal(parity.sanitizePathEntry('  ', HOME), '');
});

test('diff lists differences in the design order: tools, locks, PATH, env, OS', t => {
  const files = {'package.json': '{}', 'package-lock.json': 'aaa'};
  const a = snap(t, files);
  const b = snap(t, {'package.json': '{}', 'package-lock.json': 'bbb'}, {
    run: fakeRun({'npm.cmd': '11.0.0\n', 'chcp.com': 'Active code page: 65001'}),
    env: fakeEnv({PATH: 'C:\\Tools;C:\\Users\\testuser\\bin;C:\\Extra', NODE_ENV: 'production'}),
  });
  const items = parity.diffSnapshots(a, b);
  const order = ['tools', 'locks', 'path', 'env', 'os'];
  const cats = items.map(i => i.category);
  assert.deepEqual(cats, [...cats].sort((x, y) => order.indexOf(x) - order.indexOf(y)), 'categories never go backwards: ' + cats.join(','));
  const byLabel = Object.fromEntries(items.map(i => [i.category + ':' + i.label, i]));
  assert.equal(byLabel['tools:npm'].a, '10.2.3');
  assert.equal(byLabel['tools:npm'].b, '11.0.0');
  assert.ok(byLabel['locks:package-lock.json'], 'a changed lock hash is a difference');
  assert.ok(items.some(i => i.category === 'path' && i.label === 'C:\\Extra'), 'a PATH entry only on B is listed');
  assert.ok(items.some(i => i.category === 'path' && i.label === 'C:\\Tools' && i.a !== i.b), 'a PATH entry that moved is listed with both positions');
  assert.equal(byLabel['env:NODE_ENV'].b, 'production');
  assert.ok(items.some(i => i.category === 'os' && /コードページ/.test(i.label)), 'the code page difference is in the OS group');
  assert.deepEqual(parity.diffSnapshots(a, a), [], 'a snapshot has no differences with itself');
});

test('readSnapshotFile refuses files that are not snapshots, in words', t => {
  const dir = project(t, {'good.json': JSON.stringify(snap(t, {'package.json': '{}'})), 'bad.json': 'not json', 'other.json': '{"kind":"x"}'});
  assert.equal(parity.readSnapshotFile(path.join(dir, 'good.json')).kind, 'muser-parity');
  assert.throws(() => parity.readSnapshotFile(path.join(dir, 'missing.json')), /ファイルが読めません/);
  assert.throws(() => parity.readSnapshotFile(path.join(dir, 'bad.json')), /スナップショットではありません/);
  assert.throws(() => parity.readSnapshotFile(path.join(dir, 'other.json')), /スナップショットではありません/);
});

test('saved snapshots live in one folder and are pruned at 30 days / 500 MB', t => {
  const dir = project(t, {});
  const s = snap(t, {'package.json': '{}'});
  const file = parity.saveSnapshot(s, {baseDir: dir, now: Date.now()});
  assert.equal(path.dirname(file), dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tools, s.tools);
  // An old snapshot goes in the age prune; the fresh one stays.
  const old = path.join(dir, 'snapshot-2000-01-01.json');
  fs.writeFileSync(old, '{}');
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  assert.equal(parity.pruneSnapshots(dir, {keep: file}), 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(file));
  // Over the size cap the oldest goes first, and never the kept file.
  const big1 = path.join(dir, 'snapshot-a.json'); fs.writeFileSync(big1, 'x'.repeat(300));
  const big2 = path.join(dir, 'snapshot-b.json'); fs.writeFileSync(big2, 'x'.repeat(300));
  fs.utimesSync(big1, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
  fs.utimesSync(big2, new Date(Date.now() - 1000), new Date(Date.now() - 1000));
  parity.pruneSnapshots(dir, {keep: file, maxTotalBytes: 400});
  assert.ok(!fs.existsSync(big1), 'the oldest is pruned first');
  assert.ok(fs.existsSync(file), 'the kept file survives its own prune');
  assert.equal(parity.RETENTION_DAYS, 30);
  assert.equal(parity.RETENTION_MAX_BYTES, 500 * 1024 * 1024);
});

// --- the CLI (bin/muser.js), black-box like tests/fix2-cli.test.js ----------
const {spawnSync} = require('node:child_process');
const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
function runBin(args, {env = {}} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-parity-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-parity-data-'));
  const e = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', USERPROFILE: home, HOME: home, LOCALAPPDATA: data, ...env};
  const r = spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', timeout: 60000, env: e, cwd: path.join(__dirname, '..')});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

test('CLI: parity snapshot --out writes a snapshot; diff reports the change (exit 1), --json parses, no change is exit 0 (wave 15)', t => {
  const dir = project(t, {});
  const aFile = path.join(dir, 'a.json'), bFile = path.join(dir, 'b.json');
  const w = runBin(['parity', 'snapshot', '--out', aFile]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /スナップショットを保存しました/);
  const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
  assert.equal(a.kind, 'muser-parity');
  assert.ok(a.tools.node, 'the real probe found node');
  const b = {...a, tools: {...a.tools, npm: '0.0.1'}};
  fs.writeFileSync(bFile, JSON.stringify(b));
  const d = runBin(['parity', 'diff', aFile, bFile]);
  assert.equal(d.status, 1, d.stderr);
  assert.match(d.stdout, /違い 1 件/);
  assert.match(d.stdout, /道具の版/);
  assert.match(d.stdout, new RegExp('npm: ' + String(a.tools.npm).replace(/\./g, '\\.') + ' → 0.0.1'));
  const dj = runBin(['parity', 'diff', '--json', aFile, bFile]);
  assert.equal(dj.status, 1, dj.stderr);
  assert.deepEqual(JSON.parse(dj.stdout), [{category: 'tools', label: 'npm', a: String(a.tools.npm), b: '0.0.1'}]);
  const same = runBin(['parity', 'diff', aFile, aFile]);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /違いはありません/);
});

test('CLI: parity refuses bad usage and non-snapshots; --out belongs to parity alone', () => {
  for (const [args, want] of [
    [['parity'], /使い方: muser parity snapshot/],
    [['parity', 'bogus'], /という parity の操作はありません/],
    [['parity', 'diff', 'only-one.json'], /使い方: muser parity diff/],
    [['parity', 'snapshot', 'extra'], /余分な引数です: extra/],
    [['status', '--out', 'x.json'], /--out はこの使い方では使えません/],
  ]) {
    const r = runBin(args);
    assert.equal(r.status, 1, args.join(' ') + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, want, args.join(' '));
  }
  const notSnap = runBin(['parity', 'diff', path.join(__dirname, '..', 'package.json'), path.join(__dirname, '..', 'package.json')]);
  assert.equal(notSnap.status, 1);
  assert.match(notSnap.stderr, /スナップショットではありません/);
});

// --- /parity in the TUI (src/ui/controller.mjs) ------------------------------
const {EventEmitter} = require('node:events');
class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

test('/parity shows this PC fingerprint and saves it locally; /parity diff and the stage-2 refusal', async t => {
  const {Controller, COMMANDS} = await import('../src/ui/controller.mjs');
  assert.ok(COMMANDS.some(([n]) => n === '/parity'), '/parity is listed in /help and completion');
  const cwd = project(t, {'package.json': '{}'});
  const ctrl = new Controller({agent: new FakeAgent(cwd), museName: 'm', version: 't', onExit() {}});
  ctrl.slash('/parity');
  const entry = ctrl.get().entries.at(-1);
  assert.equal(entry.type, 'parity');
  assert.match(entry.title, /環境比較（この PC）/);
  const rows = entry.sections.flatMap(s => s.rows);
  assert.ok(rows.some(([k]) => k === 'node'), 'the fingerprint rows are in the entry');
  const savedRow = rows.find(([k]) => k === '保存先');
  assert.ok(savedRow, 'the entry says where the snapshot was saved');
  const savedFile = savedRow[1];
  assert.ok(savedFile.startsWith(path.join(process.env.LOCALAPPDATA, 'muser', 'parity')), 'the snapshot is saved only under %LOCALAPPDATA%\\muser\\parity');
  assert.equal(parity.readSnapshotFile(savedFile).kind, 'muser-parity');
  // diff against a doctored copy of the very file /parity just saved.
  const other = path.join(cwd, 'other.json');
  const s = parity.readSnapshotFile(savedFile);
  fs.writeFileSync(other, JSON.stringify({...s, tools: {...s.tools, node: '0.0.1'}}));
  ctrl.slash('/parity diff ' + savedFile + ' ' + other);
  const dEntry = ctrl.get().entries.at(-1);
  assert.equal(dEntry.type, 'parity');
  assert.match(dEntry.title, /違い 1 件/);
  assert.equal(dEntry.sections[0].heading, '道具の版');
  ctrl.slash('/parity diff ' + savedFile + ' ' + savedFile);
  assert.match(ctrl.get().entries.at(-1).lines.join(''), /違いはありません/);
  ctrl.slash('/parity diff only-one.json');
  assert.match(ctrl.get().entries.at(-1).lines.join(''), /使い方: \/parity diff/);
  // Stage 2 is not built: naming the other PC explains, and fetches nothing.
  ctrl.slash('/parity mizuki-2');
  const note = ctrl.get().entries.at(-1);
  assert.equal(note.type, 'note');
  assert.match(note.lines.join('\n'), /段階 2 で、まだ作っていません/);
});

test('snapshot and diff sections carry the rows both screens draw', t => {
  const a = snap(t, {'package.json': '{}', 'package-lock.json': 'aaa'});
  const sections = parity.snapshotSections(a, 'C:\\saved.json');
  const rows = sections.flatMap(s => s.rows);
  assert.ok(rows.some(([k]) => k === 'OS'));
  assert.ok(rows.some(([k]) => k === 'node'));
  assert.ok(rows.some(([k, v]) => k === '保存先' && v === 'C:\\saved.json'));
  const d = parity.diffSections(parity.diffSnapshots(a, {...a, tools: {...a.tools, npm: '0.0.1'}}));
  assert.equal(d[0].heading, '道具の版');
  assert.deepEqual(d[0].rows, [['npm', '10.2.3 → 0.0.1']]);
});
