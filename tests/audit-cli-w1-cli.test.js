'use strict';
// audit-cli wave 1 — regression tests for the CLI flag-surface / race /
// policy fixes e585ce0, 548c58d and 0aa6411. Black-box like
// tests/fix2-cli.test.js: the real bin runs as a subprocess in per-run
// scratch homes (LOCALAPPDATA / USERPROFILE / HOME isolated), so the
// error line / output / exit code is the observable behaviour. The race
// and policy cases call src/race.js / src/policy.js directly, the
// policy ones against throwaway git repos (tests/policy.test.js style).
// No run here sends anything anywhere: export runs dry-run / no-session
// paths only, and the resident Server / the real home are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync, execFileSync} = require('node:child_process');
const BIN = path.join(__dirname, '..', 'bin', 'muser.js');

function scratch() {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-aw1-home-')),
    data: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-aw1-data-')),
    work: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-aw1-work-')),
  };
}
function runBin(args, {env = {}, input, timeout = 30000, dirs, cwd} = {}) {
  const d = dirs || scratch();
  const e = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', USERPROFILE: d.home, HOME: d.home, LOCALAPPDATA: d.data, ...env};
  const r = spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', timeout, env: e, input, cwd: cwd || d.work});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', dirs: d};
}
const both = r => r.stdout + r.stderr;

// --- (1) e585ce0: `lore forget --all` died as an unknown option in parse()
test('audit-cli-w1 (1): lore forget --all is accepted, not an unknown option', () => {
  const r = runBin(['lore', 'forget', '--all']);
  assert.equal(r.status, 0, both(r));
  assert.match(r.stdout, /件消しました/, 'forget --all ran and reported the count');
  assert.doesNotMatch(both(r), /知らないオプションです/, '--all is a known flag now');
  assert.doesNotMatch(both(r), /はこの使い方では使えません/, '--all is in scope for lore');
});

// --- (2) e585ce0: `export --help` — export-cli knows no help flag, bin answers
test('audit-cli-w1 (2): export --help exits 0 and prints usage', () => {
  for (const flag of ['--help', '-h']) {
    const r = runBin(['export', flag]);
    assert.equal(r.status, 0, flag + ': ' + both(r));
    assert.match(r.stdout, /使い方: muser export/, flag + ' prints the usage line');
    assert.match(r.stdout, /--dry-run/, flag + ' lists the real export flags');
    assert.doesNotMatch(both(r), /知らないオプションです/, flag + ' is not an unknown option');
  }
});

// --- (3) e585ce0: a valued flag before `export` must not hide the command
// (--agents was missing from the pre-scan VALUED list, so `2` became the
// "first word" and export never ran; the run must NOT fail with the
// scoped-flag error either, because bin hands export to its child first).
test('audit-cli-w1 (3): --agents 2 export --dry-run reaches export (no scoped error)', () => {
  const r = runBin(['--agents', '2', 'export', '--dry-run']);
  assert.doesNotMatch(both(r), /--agents はこの使い方では使えません/, 'not the scoped-flag error');
  assert.doesNotMatch(both(r), /知らないオプションです: --agents/, 'not an unknown option');
  // In a scratch home export itself then answers honestly: there is no
  // conversation to send yet. That answer proves the export path ran.
  assert.equal(r.status, 1, both(r));
  assert.match(both(r), /送る会話がありません/, 'export ran and found no conversation in scratch');
});

// --- (4) e585ce0: `--fix=High` — the = form was an unknown option for hunt
test('audit-cli-w1 (4): hunt --fix=High is accepted, not an unknown option', () => {
  const r = runBin(['hunt', '--fix=High']);
  assert.doesNotMatch(both(r), /知らないオプションです/, '--fix=High parses as --fix High');
  // The scratch work folder has no hunt results, so the fix flow stops
  // there — that message (exit 1) proves --fix reached huntCommand.
  assert.equal(r.status, 1, both(r));
  assert.match(r.stderr, /バグ狩りの結果がありません/, 'prepareFix ran in the empty scratch folder');
});

// --- (5) e585ce0: `log --clear --json` printed plain text, not JSON
test('audit-cli-w1 (5): log --clear --json prints JSON', () => {
  const r = runBin(['log', '--clear', '--json']);
  assert.equal(r.status, 0, both(r));
  const v = JSON.parse(r.stdout); // throws (failing the test) on the old plain text
  assert.equal(typeof v.files, 'number');
  assert.equal(typeof v.blobs, 'number');
  assert.equal(typeof v.bytes, 'number');
  const plain = runBin(['log', '--clear']);
  assert.equal(plain.status, 0, both(plain));
  assert.match(plain.stdout, /作業ログを消しました/, 'the non-JSON form keeps its wording');
});

// --- (6) e585ce0: `account use` with no name resolved "" instead of usage
test('audit-cli-w1 (6): account use with no name is a usage error', () => {
  const r = runBin(['account', 'use']);
  assert.equal(r.status, 1, both(r));
  assert.match(r.stderr, /使い方: muser account use <名前>/);
  assert.doesNotMatch(both(r), /アカウントが見つかりません/, 'a missing name is not a lookup failure');
  const rm = runBin(['account', 'remove']);
  assert.equal(rm.status, 1, both(rm));
  assert.match(rm.stderr, /使い方: muser account remove <名前>/, 'remove got the same guard in e585ce0');
});

// --- (7) 548c58d: race applyWinner — a skipped racer has no patch at all;
// the empty-patch success is only for a done racer that changed nothing.
test('audit-cli-w1 (7): race applyWinner throws for skipped, {ok,empty} for done-empty', async () => {
  const {applyWinner} = require('../src/race');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-aw1-race-'));
  const result = {dir, cwd: dir, racers: [
    {index: 1, status: 'skipped'},
    {index: 2, status: 'done'},
  ]};
  await assert.rejects(applyWinner(result, 1), /見送られたため、差分がありません/, 'a skipped racer must not apply as an empty success');
  assert.deepEqual(await applyWinner(result, 2), {ok: true, empty: true}, 'a done racer with no patch is the genuine empty case');
});

// --- (8) 0aa6411: policy decide — the git log -p name scan must vet the
// same commit set the user's command would print.
const {decide, readOnlyCommand} = require('../src/policy');
function initRepo(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', '-b', 'main', dir], {timeout: 30000, windowsHide: true});
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  git('config', 'user.email', 'audit@example.invalid');
  git('config', 'user.name', 'audit');
  git('config', 'commit.gpgsign', 'false');
  const commit = (name, content, msg) => { fs.writeFileSync(path.join(dir, name), content); git('add', name); git('commit', '-q', '-m', msg); };
  return {dir, git, commit};
}
const decideIn = (dir, command) => decide({mode: 'default', kind: 'exec', params: {command}, cwd: dir, gitConfig: () => ''});

test('audit-cli-w1 (8a): policy — git log -p --all asks when a secret lives only on a side branch', t => {
  const {dir, git, commit} = initRepo(t, 'muser-aw1-pol-all-');
  commit('ordinary.txt', 'hello\n', 'ordinary on main');
  git('checkout', '-q', '-b', 'side');
  commit('.env', 'SECRET=1\n', 'secret only on side');
  git('checkout', '-q', 'main');
  assert.equal(fs.existsSync(path.join(dir, '.env')), false, 'the secret is not in the working tree');
  assert.equal(readOnlyCommand('git log -p --all'), true, 'the command itself is a read-only form');
  assert.equal(decideIn(dir, 'git log -p'), 'allow', 'HEAD (main) touches only ordinary files');
  assert.equal(decideIn(dir, 'git log -p --all'), 'ask', '--all widens the scan to the side branch and its secret');
});

test('audit-cli-w1 (8b): policy — git log -pn1 is detected as a patch log', t => {
  const {dir, git, commit} = initRepo(t, 'muser-aw1-pol-pn1-');
  commit('ordinary.txt', 'hello\n', 'ordinary');
  commit('.env', 'SECRET=1\n', 'add secret');
  git('rm', '-q', '.env');
  git('commit', '-q', '-m', 'remove secret');
  assert.equal(fs.existsSync(path.join(dir, '.env')), false, 'the secret is not in the working tree');
  assert.equal(readOnlyCommand('git log -pn1'), true, '-pn1 is a read-only form (p + n<value> cluster)');
  assert.equal(decideIn(dir, 'git log --oneline'), 'allow', 'a non-patch log prints no file contents');
  assert.equal(decideIn(dir, 'git log -pn1'), 'ask', '-pn1 is a patch log: its diff names the secret file');
});

test('audit-cli-w1 (9): overnight parseAt rejects out-of-range HH:MM instead of rolling over', () => {
  const {parseAt} = require('../src/overnight/cli.js');
  assert.throws(() => parseAt('25:99', Date.UTC(2026, 10, 7, 3, 0)), /at= の時刻が読めません/);
  assert.throws(() => parseAt('12:60', Date.UTC(2026, 10, 7, 3, 0)), /at= の時刻が読めません/);
  assert.equal(typeof parseAt('22:30', Date.UTC(2026, 10, 7, 3, 0)), 'number');
});

test('audit-cli-w1 (10): parity with an unknown word explains the carry-the-file flow', () => {
  const r = runBin(['parity', 'otherpc']);
  assert.equal(r.status, 1, both(r));
  assert.match(both(r), /という parity の操作はありません/);
  assert.match(both(r), /相手の PC で muser parity snapshot --out を作り/);
});
