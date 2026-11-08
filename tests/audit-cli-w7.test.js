'use strict';
// audit-cli wave 7 regression tests for the wave-7 fixes:
//  (1) policy: the safety screens recognise a program by its bare name, so
//      `git.exe` (and `.\git.exe`) is `git` to the secret screen; a wrapper
//      like `sudo` gets no alwaysKey at all (alwaysKey null); a quoted
//      `--ext-diff` is still seen by the exec/write-flag screen, so a
//      remembered `git log` key does not cover it; `git log -c` / `--cc`
//      counts as patch output, so an evil merge's combined diff is scanned.
//  (2) hunt: a corrupt state.json is moved aside as state.json.corrupt-*
//      (bytes preserved) instead of silently vanishing, and two hunts
//      started in the same second get different folders (-2).
//  (3) overnight: a broken latest.json falls back to the newest per-run
//      report file instead of reporting "no report".
//  (4) sessions: a corrupt Focus state file is moved aside as .corrupt-*
//      before loadFocus reads null, so the next save does not overwrite
//      the only copy.
//  (5) update: latest() returns null when the registry's latest is a
//      pre-release ("no stable version to offer", not a failed check),
//      and a v-prefixed version ('v0.4.0') parses as 0.4.0.
//  (6) turn-usage: formatUsage words the counts in the UI language —
//      入 / 出 in Japanese, not the fixed English 'in / out'.
// Isolation follows tests/setup.mjs; like tests/audit-cli-w5.test.js this
// file also pins its own temp HOME / LOCALAPPDATA before requiring any
// src module, because src/sessions.js (via secure-store) resolves its
// files at require time. All canaries are fake W7* values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const NL = String.fromCharCode(10);
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w7-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w7-test-home-'));

const policy = require('../src/policy');
const hunt = require('../src/hunt');
const overnight = require('../src/overnight/run');
const sessions = require('../src/sessions');
const update = require('../src/update');
const turnUsage = require('../src/turn-usage');

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'muser-w7-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
// policy.decide with an injectable (clean) repo config, as in the w5 tests:
// the screens under test are the command screens, not the config reader.
const decideIn = (cwd, command, always = new Set()) =>
  policy.decide({mode: 'default', kind: 'exec', params: {command}, always, cwd, root: cwd, gitConfig: () => ''});

// ---------- (1) policy ----------

test('w7 policy (1): the secret screen sees git under its git.exe spelling', (t) => {
  const cwd = tmpdir(t, 'muser-w7-policy-');
  const key = policy.alwaysKey('exec', {command: 'git.exe diff'});
  assert.equal(key, 'exec:git.exe diff', 'the alwaysKey identity keeps the spelling as written');
  const always = new Set([key]);
  assert.equal(decideIn(cwd, 'git.exe diff', always), 'allow', 'control: the remembered benign form passes');
  assert.equal(decideIn(cwd, 'git.exe diff --no-index a b', always), 'ask',
    '--no-index reads arbitrary files: the secret screen must catch it under the git.exe spelling too');
  const pathKey = policy.alwaysKey('exec', {command: '.\\git.exe diff'});
  assert.equal(decideIn(cwd, '.\\git.exe diff --no-index a b', new Set([pathKey])), 'ask',
    'the .\\git.exe path spelling is git to the screen as well');
  assert.equal(decideIn(cwd, 'git diff --no-index a b', new Set(['exec:git diff'])), 'ask',
    'control: the plain git spelling was already screened');
});

test('w7 policy (1): sudo gets no alwaysKey — the word after it is not its subcommand', () => {
  assert.equal(policy.alwaysKey('exec', {command: 'sudo git status'}), null,
    'a two-word key for `sudo git` would have covered `sudo git push` and `sudo npm install` alike');
  assert.equal(policy.alwaysKey('exec', {command: 'sudo npm install'}), null);
  assert.equal(policy.alwaysKey('exec', {command: 'sudo ls'}), null);
  assert.equal(policy.alwaysKey('exec', {command: 'git status'}), 'exec:git status', 'control: a plain command is still remembered');
});

test('w7 policy (1): a quoted --ext-diff is not covered by the remembered git log key', (t) => {
  const cwd = tmpdir(t, 'muser-w7-policy-');
  assert.equal(policy.alwaysKey('exec', {command: 'git log "--ext-diff"'}), null,
    'the quoted flagged form itself is never remembered: screening falls back to lenient tokens when strict parsing fails on the quote');
  const always = new Set(['exec:git log']);
  assert.equal(decideIn(cwd, 'git log', always), 'allow', 'control: the remembered plain form still passes');
  assert.equal(decideIn(cwd, 'git log "--ext-diff"', always), 'ask', 'the quote must not switch the flag screen off');
  assert.equal(decideIn(cwd, 'git log --ext-diff #x', always), 'ask', 'a trailing # comment marker must not switch it off either');
});

test('w7 policy (1): git log -c is patch output — an evil merge\'s secret file is scanned', (t) => {
  try { execFileSync('git', ['--version'], {stdio: 'ignore', timeout: 30000, windowsHide: true}); }
  catch { t.skip('no git'); return; }
  const repo = tmpdir(t, 'muser-w7-repo-');
  const git = (args, ok = true) => {
    const r = spawnSync('git', args, {cwd: repo, encoding: 'utf8', timeout: 30000, windowsHide: true});
    if (ok && r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
    return r;
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'w7@test.invalid']);
  git(['config', 'user.name', 'w7']);
  git(['config', 'commit.gpgsign', 'false']);
  const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);
  write('a.txt', 'base' + NL); git(['add', '.']); git(['commit', '-qm', 'base']);
  git(['checkout', '-qb', 'side']);
  write('b.txt', 'side' + NL); git(['add', '.']); git(['commit', '-qm', 'side']);
  git(['checkout', '-q', 'main']);
  write('a.txt', 'main' + NL); git(['add', '.']); git(['commit', '-qm', 'main']);
  // Evil merge: the merge result introduces credentials.json, a file NEITHER
  // parent has — no ordinary commit in the walk ever touches it, so only a
  // combined diff (-c) ever names it.
  git(['merge', '--no-commit', 'side']);
  write('credentials.json', 'merged-secret' + NL);
  git(['add', 'credentials.json']); git(['commit', '-qm', 'merge side']);
  const names = (extra) => execFileSync('git', ['log', ...extra, '--name-only', '--pretty=format:commit-%H'], {cwd: repo, encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.ok(names(['-c']).includes('credentials.json'), 'fixture: the combined-diff listing names the merged-in secret file');
  assert.ok(!names([]).includes('credentials.json'), 'fixture: the plain listing never names it');
  const d = command => decideIn(repo, command);
  assert.equal(d('git log'), 'allow', 'control: a plain log prints no patch');
  assert.equal(d('git log -p'), 'allow', 'control: -p scans the same plain listing, which names only ordinary files');
  assert.equal(d('git log -c'), 'ask', '-c prints a combined diff: the scan must ask git for combined names and find the secret');
  assert.equal(d('git log --cc'), 'ask', '--cc is the same combined diff in long form');
});

// ---------- (2) hunt ----------

test('w7 hunt (2): a corrupt state.json is moved aside as .corrupt-*, bytes preserved', (t) => {
  const dir = tmpdir(t, 'muser-w7-hunt-');
  const broken = '{ this is not json — the only record of the interrupted hunt W7';
  fs.writeFileSync(path.join(dir, 'state.json'), broken, 'utf8');
  assert.equal(hunt.loadState(dir), null, 'a corrupt state still reads as no state');
  const names = fs.readdirSync(dir);
  assert.ok(!names.includes('state.json'), 'the broken file was moved aside, so the next save starts fresh');
  const backup = names.find(n => n.startsWith('state.json.corrupt-'));
  assert.ok(backup, 'a state.json.corrupt-* backup was created: ' + names.join(', '));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), broken, 'the backup holds the broken bytes, not a rewrite');
  const empty = tmpdir(t, 'muser-w7-hunt-');
  assert.equal(hunt.loadState(empty), null, 'control: a missing state.json reads as null');
  assert.deepEqual(fs.readdirSync(empty), [], 'control: a missing file leaves no backup behind');
  const good = tmpdir(t, 'muser-w7-hunt-');
  fs.writeFileSync(path.join(good, 'state.json'), JSON.stringify({phase: 'audit-done'}) + NL, 'utf8');
  assert.equal(hunt.loadState(good).phase, 'audit-done', 'control: a valid state still loads');
  assert.deepEqual(fs.readdirSync(good), ['state.json'], 'control: a valid state is left in place');
});

test('w7 hunt (2): two hunts started in the same second get different folders', async (t) => {
  const root = tmpdir(t, 'muser-w7-hunt-');
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;' + NL);
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 2;' + NL);
  const prepared = hunt.prepareAudit({cwd: root, agents: 2});
  const now = new Date(2026, 10, 8, 12, 0, 0); // the SAME second for both runs
  const runAgent = async () => '{"severity":"None","summary":"なし"}';
  const first = await hunt.runAudit(prepared, {runAgent, now, maxConcurrent: 1});
  const second = await hunt.runAudit(prepared, {runAgent, now, maxConcurrent: 1});
  assert.notEqual(second.dir, first.dir, 'the second hunt must not land in (and overwrite) the first hunt\'s folder');
  assert.ok(first.dir.endsWith('20261108-120000'), 'the first hunt takes the plain stamp folder: ' + first.dir);
  assert.ok(second.dir.endsWith('20261108-120000-2'), 'the second hunt takes the -2 folder: ' + second.dir);
  assert.equal(hunt.loadState(first.dir).phase, 'audit-done', 'the first hunt\'s state survived the second run');
  assert.equal(hunt.loadState(second.dir).phase, 'audit-done');
  assert.equal(hunt.loadState(second.dir).dir, second.dir, 'each state names its own folder');
});

// ---------- (3) overnight ----------

test('w7 overnight (3): a broken latest.json falls back to the newest run report', (t) => {
  const baseDir = tmpdir(t, 'muser-w7-on-');
  const report = (runId, n) => ({runId, startedAt: n, endedAt: n + 1, totalTokens: 0, items: []});
  overnight.saveReport(report('run-w7-aaa', 1), {baseDir});
  overnight.saveReport(report('run-w7-bbb', 3), {baseDir});
  assert.equal(overnight.loadLatestReport({baseDir}).runId, 'run-w7-bbb', 'control: an intact latest.json is the newest report');
  const dir = path.join(baseDir, 'reports');
  fs.writeFileSync(path.join(dir, 'latest.json'), '{ broken latest W7', 'utf8');
  assert.equal(overnight.loadLatestReport({baseDir}).runId, 'run-w7-bbb',
    'latest.json is only a shortcut: the newest <runId>.json still answers');
  fs.writeFileSync(path.join(dir, 'run-w7-bbb.json'), '{ broken too W7', 'utf8');
  assert.equal(overnight.loadLatestReport({baseDir}).runId, 'run-w7-aaa',
    'a run file that does not parse is skipped for the next newest one');
});

// ---------- (4) sessions: corrupt Focus state ----------

test('w7 sessions (4): a corrupt Focus state is moved aside before loadFocus reads null', (t) => {
  const id = 'w7-focus-corrupt';
  const file = sessions.focusFile(id);
  const dir = path.dirname(file), base = path.basename(file);
  fs.mkdirSync(dir, {recursive: true});
  t.after(() => {
    sessions.clearFocus(id);
    for (const n of fs.readdirSync(dir)) if (n.startsWith(base + '.corrupt-')) fs.rmSync(path.join(dir, n), {force: true});
  });
  const broken = '{ broken focus state W7 — the only copy of the interrupted task';
  fs.writeFileSync(file, broken, 'utf8');
  assert.equal(sessions.loadFocus(id), null, 'a corrupt Focus state still reads as no saved task');
  assert.ok(!fs.existsSync(file), 'the broken file was moved aside, so the next save cannot overwrite the only copy');
  const backup = fs.readdirSync(dir).find(n => n.startsWith(base + '.corrupt-'));
  assert.ok(backup, 'a .corrupt-* backup was created next to the Focus file');
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), broken, 'the backup holds the broken bytes');
  sessions.saveFocus(id, {goal: 'w7 fresh task'});
  assert.deepEqual(sessions.loadFocus(id), {goal: 'w7 fresh task'}, 'after the backup, a fresh state saves and loads normally');
  assert.equal(sessions.loadFocus('w7-focus-absent'), null, 'control: a missing Focus file reads as null');
  assert.ok(!fs.readdirSync(dir).some(n => n.includes('w7-focus-absent') && n.includes('corrupt')), 'control: a missing file leaves no backup');
});

// ---------- (5) update ----------

test('w7 update (5): latest() is null for a pre-release registry answer, and a v-prefix parses', async (t) => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  const serve = body => { global.fetch = async () => ({ok: true, json: async () => body}); };
  serve({version: '0.4.0-beta.1'});
  assert.equal(await update.latest(), null, 'a pre-release as the registry latest is "no stable version to offer", not a failed check and not a version');
  serve({version: 'v0.4.0'});
  assert.equal(await update.latest(), '0.4.0', 'a leading v is packaging, not part of the version');
  serve({version: '0.4.0'});
  assert.equal(await update.latest(), '0.4.0', 'control: a plain stable version reads as itself');
});

// ---------- (6) turn-usage ----------

test('w7 turn-usage (6): formatUsage words the counts in Japanese — 入 / 出', () => {
  assert.equal(turnUsage.formatUsage({inputTokens: 130841, outputTokens: 395}), '130.8k 入 / 395 出');
  assert.equal(turnUsage.formatUsage({inputTokens: 0, outputTokens: 0}), '0 入 / 0 出');
  const parsed = turnUsage.parse('done\n\n[usage] context_tokens=130841 response_tokens=395 source=provider');
  assert.equal(parsed.usage.formatted, '130.8k 入 / 395 出', 'a parsed [usage] line formats the same way');
  assert.ok(!parsed.usage.formatted.includes(' in / '), 'the fixed English in/out wording is gone in the Japanese UI');
});
