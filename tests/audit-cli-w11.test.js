'use strict';
// audit-cli wave 11 — regression tests for the wave-11 fixes in hunt,
// parity, overnight and worklog (the lore half lives in
// tests/audit-cli-w11-lore.test.js):
//  (1) hunt: the status breakdown includes None, so the parts add up to
//      the total; and the unified findings view (state.json +
//      findings.jsonl merged, exact duplicates dropped) never counts
//      the same finding line twice.
//  (2) parity: a snapshot whose locks repeat a file is refused (names
//      compare case-insensitively), a numeric tool version is refused,
//      and a DIRECTORY named like a project marker (Cargo.toml,
//      yarn.lock, ...) adds no tools and no locks — only regular
//      files are markers.
//  (3) overnight: queueing the same prompt for the same folder twice
//      is refused while the first copy waits (queued / deferred), a
//      non-git folder cannot be queued at all, and the run's task cap
//      counts ATTEMPTED tasks — one that fails before its runner
//      starts still spends the cap.
//  (4) worklog: Worklog.readFile counts scalar / array JSON lines as
//      badLines (never as events), and lines naming another
//      conversation count as foreign and stay out of the events.
// Isolation follows tests/audit-cli-w10.test.js: tests/setup.mjs has
// already pinned temp data/home folders before any src module loads,
// and every fixture below lives in its own temp dir. No commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const NL = String.fromCharCode(10);
function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}
function gitAvailable(t) {
  try { execFileSync('git', ['--version'], {stdio: 'ignore'}); return true; } catch { t.skip('no git'); return false; }
}

// ---------- (1) hunt ----------
const hunt = require('../src/hunt');
const finding = (severity, summary, extra = {}) => ({severity, file: 'src/a.js', line: 1, summary, repro: '再現する', agent: 'h1', ...extra});
// The status counts line: 所見 T 件（Critical c · High h · Medium m · None n）
function statusCounts(state) {
  const line = hunt.formatStatusLines(state).find(l => l.startsWith('所見'));
  assert.ok(line, 'a status counts line is shown');
  const m = /所見 (\d+) 件（Critical (\d+) · High (\d+) · Medium (\d+) · None (\d+)）/.exec(line);
  assert.ok(m, 'the breakdown names every severity, None included: ' + line);
  const [, total, c, h, md, n] = m.map(Number);
  return {total, parts: c + h + md + n, bySeverity: {Critical: c, High: h, Medium: md, None: n}};
}

test('w11 hunt (1): the status breakdown includes None and the parts add up to the total', () => {
  const findings = [finding('Critical', '重大'), finding('High', '高い'), finding('Medium', '中くらい'), finding('None', '問題なし 1'), finding('None', '問題なし 2')];
  assert.deepEqual(hunt.countBySeverity(findings), {Critical: 1, High: 1, Medium: 1, None: 2, total: 5}, 'countBySeverity counts the None rows too');
  const got = statusCounts({phase: 'audit-done', groups: [{status: 'done'}], findings});
  assert.equal(got.total, 5);
  assert.deepEqual(got.bySeverity, {Critical: 1, High: 1, Medium: 1, None: 2});
  assert.equal(got.parts, got.total, 'Critical + High + Medium + None equals the headline total');
  // A hunt whose agents mostly reported "no problem" is the case that
  // used to under-add: the headline said 2, the parts summed to 0.
  const quiet = statusCounts({phase: 'audit-done', groups: [], findings: [finding('None', '問題なし A'), finding('None', '問題なし B')]});
  assert.equal(quiet.total, 2);
  assert.equal(quiet.bySeverity.None, 2);
  assert.equal(quiet.parts, quiet.total, 'an all-None hunt still adds up');
});

test('w11 hunt (1): the same finding line in state and findings.jsonl is counted once, never twice', t => {
  const root = tmpdir(t, 'muser-w11-hunt-');
  const dir = path.join(root, '.muser', 'hunt', '20261108-120000');
  fs.mkdirSync(dir, {recursive: true});
  const A = finding('Critical', '重大な問題');
  const B = finding('High', '高い問題');
  const C = finding('None', '問題なし');
  // The writer updates state.json and findings.jsonl in sequence, so
  // the same row normally lives in both — and a kill in between can
  // leave the jsonl holding a row the state never got (here: C, plus
  // a second copy of A inside the jsonl itself).
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({version: 1, cwd: root, phase: 'audit-done', groups: [], findings: [A, B]}) + NL);
  fs.writeFileSync(path.join(dir, 'findings.jsonl'), [A, A, B, C].map(f => JSON.stringify(f)).join(NL) + NL);
  const status = hunt.readStatus(root);
  assert.ok(status, 'the hunt reads back');
  assert.equal(status.findings.length, 3, 'state rows + jsonl-only rows, duplicates dropped: ' + JSON.stringify(status.findings.map(f => f.summary)));
  assert.deepEqual(status.findings.map(f => f.summary).sort(), ['問題なし', '重大な問題', '高い問題'].sort());
  const got = statusCounts(status);
  assert.equal(got.total, 3, 'status counts the unified view, not state + jsonl added together');
  assert.equal(got.parts, got.total);
  assert.equal(got.bySeverity.None, 1);
  // The primitives agree, and a NEAR duplicate is a different finding:
  // only a completely identical row (severity, file, line, summary,
  // repro, agent) merges.
  assert.equal(hunt.dedupeFindings([A, A, B]).length, 2);
  assert.equal(hunt.mergeFindings([A], dir).length, 3, 'merging [A] with the jsonl adds B and C only');
  assert.equal(hunt.dedupeFindings([A, {...A, line: 2}]).length, 2, 'the same summary at another line counts separately');
});

// ---------- (2) parity ----------
const parity = require('../src/parity');
function validSnap(overrides = {}) {
  return {
    kind: 'muser-parity', version: 1, createdAt: '2026-11-08T00:00:00.000Z', project: 'w11-probe',
    os: {platform: 'win32', version: 'Windows 11', release: '10.0.1', build: '1', arch: 'x64'},
    locale: {language: 'ja-JP', codePage: 932}, settings: {executionPolicy: 'RemoteSigned', longPaths: true},
    tools: {node: '22.1.0', npm: null}, path: ['C:\\Tools'], env: {names: ['NODE_ENV', 'PATH'], values: {NODE_ENV: 'test'}},
    locks: [{file: 'package-lock.json', sha256: 'a'.repeat(64), bytes: 42}],
    ...overrides,
  };
}
function writeSnap(t, snap) {
  const file = path.join(tmpdir(t, 'muser-w11-parity-'), 'snap.json');
  fs.writeFileSync(file, JSON.stringify(snap));
  return file;
}
function assertRefusedInWords(file) {
  let err = null;
  try { parity.readSnapshotFile(file); } catch (e) { err = e; }
  assert.ok(err, 'readSnapshotFile refuses the snapshot');
  assert.ok(!(err instanceof TypeError), 'the refusal is in words, not a TypeError: ' + err.message);
  assert.match(err.message, /スナップショットではありません/);
}

test('w11 parity (2): a snapshot whose locks repeat a file is refused', t => {
  const lock = {file: 'package-lock.json', sha256: 'a'.repeat(64), bytes: 42};
  assert.equal(parity.isSnapshot(validSnap()), true, 'control: the untouched shape is a snapshot');
  assert.equal(parity.isSnapshot(validSnap({locks: [lock, {file: 'yarn.lock', sha256: 'b'.repeat(64), bytes: 7}]})), true, 'control: two DIFFERENT lock files are fine');
  // The diff reads locks through a first-match lookup, so a doubled
  // entry would be invisible there: two different fingerprints could
  // diff as "no differences". Duplicates refuse, they do not merge.
  assert.equal(parity.isSnapshot(validSnap({locks: [lock, {...lock}]})), false, 'the same lock file twice is not a snapshot');
  assert.equal(parity.isSnapshot(validSnap({locks: [lock, {file: 'Package-Lock.json', sha256: 'b'.repeat(64), bytes: 7}]})), false, 'names compare case-insensitively, as the Windows file system does');
  assertRefusedInWords(writeSnap(t, validSnap({locks: [lock, {...lock}]})));
});

test('w11 parity (2): a numeric tool version is refused — a version is a string or null', t => {
  assert.equal(parity.isSnapshot(validSnap({tools: {node: '22.1.0', npm: null}})), true, 'control: string and null versions are the shape');
  for (const tools of [{node: 22}, {node: '22.1.0', npm: 9}, {python: 3.12}, {git: 0}]) {
    assert.equal(parity.isSnapshot(validSnap({tools})), false, 'tools ' + JSON.stringify(tools) + ' is not a snapshot');
    assertRefusedInWords(writeSnap(t, validSnap({tools})));
  }
});

test('w11 parity (2): a directory named like a marker adds no tools and no locks', t => {
  const dir = tmpdir(t, 'muser-w11-parity-dirs-');
  for (const name of ['Cargo.toml', 'yarn.lock', 'go.mod', 'package-lock.json']) fs.mkdirSync(path.join(dir, name));
  const run = () => '1.2.3' + NL;
  const snap = parity.collectSnapshot({cwd: dir, env: {}, home: dir, run, now: new Date('2026-11-08T00:00:00.000Z')});
  assert.deepEqual(Object.keys(snap.tools).sort(), ['git', 'node', 'npm', 'python'], 'only the always-probed tools: a folder named Cargo.toml / yarn.lock / go.mod is not a project file');
  assert.deepEqual(snap.locks, [], 'a folder named package-lock.json contributes no lock either');
  assert.equal(parity.isSnapshot(snap), true, 'the collected snapshot is itself well-formed');
  // Control: the same names as regular FILES do add their tools.
  const real = tmpdir(t, 'muser-w11-parity-files-');
  fs.writeFileSync(path.join(real, 'Cargo.toml'), '[package]' + NL);
  fs.writeFileSync(path.join(real, 'yarn.lock'), '# yarn lockfile v1' + NL);
  const snap2 = parity.collectSnapshot({cwd: real, env: {}, home: real, run, now: new Date('2026-11-08T00:00:00.000Z')});
  for (const key of ['rustc', 'cargo', 'yarn']) assert.ok(key in snap2.tools, 'a real marker file adds ' + key);
  assert.deepEqual(snap2.locks.map(l => l.file), ['yarn.lock'], 'a real lock file is hashed in');
});

// ---------- (3) overnight ----------
const Q = require('../src/overnight/queue');
const R = require('../src/overnight/run');
const okGit = () => ({ok: true, stdout: 'true' + NL, stderr: ''});
const noGit = () => ({ok: false, stdout: '', stderr: 'not a git repository'});
const noPower = () => ({sleepSeconds: 0, note: 'AC sleep is off'});
const noStatuses = async () => [];

test('w11 overnight (3): the same prompt for the same folder cannot be queued twice while it waits', () => {
  const q = {version: 1, items: []};
  Q.addItem(q, {prompt: '同じ頼み', cwd: 'C:\\repo-w11', runGit: okGit});
  assert.equal(q.items.length, 1);
  assert.throws(() => Q.addItem(q, {prompt: '同じ頼み', cwd: 'C:\\repo-w11', runGit: okGit}), /二重登録はできません/, 'an exact re-queue is refused');
  assert.throws(() => Q.addItem(q, {prompt: '  同じ頼み  ', cwd: 'C:\\repo-w11', runGit: okGit}), /二重登録はできません/, 'padding does not disguise the same prompt (it is stored trimmed)');
  assert.equal(q.items.length, 1, 'the refusals added nothing');
  // Controls: a different folder, or a different prompt, is a
  // different task and still queues.
  Q.addItem(q, {prompt: '同じ頼み', cwd: 'C:\\other-w11', runGit: okGit});
  Q.addItem(q, {prompt: '別の頼み', cwd: 'C:\\repo-w11', runGit: okGit});
  assert.equal(q.items.length, 3);
  // A deferred copy still waits for the morning, so it blocks too;
  // a finished copy is history and does not block a deliberate re-queue.
  q.items[0].status = 'deferred';
  assert.throws(() => Q.addItem(q, {prompt: '同じ頼み', cwd: 'C:\\repo-w11', runGit: okGit}), /二重登録はできません/, 'a deferred copy still blocks');
  q.items[0].status = 'done';
  Q.addItem(q, {prompt: '同じ頼み', cwd: 'C:\\repo-w11', runGit: okGit});
  assert.equal(q.items.length, 4, 'once the first copy is done, asking again is a new task');
});

test('w11 overnight (3): a non-git folder cannot be queued', t => {
  const plain = tmpdir(t, 'muser-w11-plain-');
  const q = {version: 1, items: []};
  assert.throws(() => Q.addItem(q, {prompt: '積めない頼み', cwd: plain, runGit: noGit}), /git リポジトリではない/, 'the folder is checked when the item is QUEUED, not first at 3am');
  assert.throws(() => Q.addItem({version: 1, items: []}, {prompt: '積めない頼み', cwd: plain}), /git リポジトリではない/, 'the real git probe agrees on a plain temp folder');
  assert.throws(() => Q.addItem({version: 1, items: []}, {prompt: '積めない頼み', cwd: '', runGit: okGit}), /git リポジトリではない/, 'no folder at all cannot queue either');
  assert.equal(q.items.length, 0, 'nothing was queued');
  Q.addItem(q, {prompt: '積める頼み', cwd: plain, runGit: okGit});
  assert.equal(q.items.length, 1, 'control: the same folder queues once git says it is a repository');
});

function makeRepo(t) {
  const dir = tmpdir(t, 'muser-w11-repo-');
  const git = (args) => { const r = spawnSync('git', args, {cwd: dir, encoding: 'utf8'}); assert.equal(r.status, 0, args.join(' ') + ': ' + r.stderr); return r.stdout; };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'w11@example.invalid']);
  git(['config', 'user.name', 'w11 test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello' + NL);
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  return dir;
}
function seedMixedQueue(baseDir, plain, repo) {
  // Seeded directly, bypassing addItem: the bad item models a queue
  // entry whose folder is not a git repository, so it fails BEFORE
  // its runner can start; the good item is fully runnable.
  const q = {version: 1, items: [
    {id: 'onw11bad0', prompt: 'bad folder task', cwd: plain, account: null, status: 'queued', createdAt: Date.now(), questions: []},
    {id: 'onw11good', prompt: 'good repo task', cwd: repo, account: null, status: 'queued', createdAt: Date.now(), questions: []},
  ]};
  Q.saveQueue(q, {baseDir});
}

test('w11 overnight (3): the task cap counts attempted tasks, including one that fails before its runner', async t => {
  if (!gitAvailable(t)) return;
  const repo = makeRepo(t);
  const plain = tmpdir(t, 'muser-w11-cap-plain-');
  // Capped run: maxTasks 1 is spent by the bad folder's attempt, so
  // the good task must NOT silently take its place under the cap.
  const baseDir = tmpdir(t, 'muser-w11-cap-');
  seedMixedQueue(baseDir, plain, repo);
  let calls = 0;
  const runner = async () => { calls++; return {ok: true, tokens: 1, questions: []}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower, maxTasks: 1});
  assert.equal(calls, 0, 'the runner never started for either task');
  assert.equal(report.items.length, 1, 'only the attempted task was processed');
  assert.equal(report.items[0].status, 'failed');
  assert.match(report.items[0].error, /git リポジトリではない/, 'it failed before the runner: not a git repository');
  assert.equal(report.stoppedReason, 'task-cap', 'the cap — spent by that attempt — stopped the night');
  assert.deepEqual(report.unrun.map(u => u.id), ['onw11good'], 'the unrun task is named in the report');
  const after = Q.loadQueue({baseDir});
  assert.equal(after.items.find(i => i.id === 'onw11bad0').status, 'failed');
  assert.equal(after.items.find(i => i.id === 'onw11good').status, 'queued', 'the good task is still queued for the next night');
  // Control: the same queue with no cap runs the good task, proving
  // it was the spent cap — not the task — that held it back.
  const baseDir2 = tmpdir(t, 'muser-w11-cap-control-');
  seedMixedQueue(baseDir2, plain, repo);
  const report2 = await R.runOvernight({baseDir: baseDir2, runner, statusesFn: noStatuses, checkPower: noPower});
  assert.equal(calls, 1, 'without the cap the good task reaches its runner');
  assert.deepEqual(report2.items.map(i => i.status), ['failed', 'done']);
});

// ---------- (4) worklog ----------
const {Worklog, fileFor} = require('../src/worklog');
const ev = (session, event, extra = {}) => JSON.stringify({v: 1, at: '2026-11-08T00:00:00.000Z', session, event, ...extra});
function writeLog(t, name, lines) {
  const dir = tmpdir(t, 'muser-w11-worklog-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join(NL) + NL);
  return {dir, file};
}

test('w11 worklog (4): scalar and array lines count as badLines and never enter the events', t => {
  const {file} = writeLog(t, 'w11conv.jsonl', [
    ev('w11conv', 'turn', {text: '直して'}),
    '12345',
    '"just a string"',
    'null',
    'true',
    '[1, 2]',
    '{broken json',
    ev('w11conv', 'reply', {text: '直しました'}),
  ]);
  const events = Worklog.readFile(file, 'w11conv');
  assert.equal(events.length, 2, 'only the two object lines are events');
  assert.deepEqual(events.map(e => e.event), ['turn', 'reply']);
  assert.equal(events.badLines, 6, 'the four scalars, the array and the torn line are all bad lines');
  assert.equal(events.foreignLines, 0);
  assert.ok(events.every(e => e && typeof e === 'object' && !Array.isArray(e)), 'no scalar or array slipped into the events');
});

test('w11 worklog (4): lines naming another conversation count as foreign and stay out of the events', t => {
  const {dir, file} = writeLog(t, 'mine.jsonl', [
    ev('mine', 'turn', {text: '自分の頼み'}),
    ev('other', 'turn', {text: '他会話の頼み'}),
    ev('mine', 'reply', {text: '自分の返事'}),
    ev('other2', 'tool', {command: 'system.run'}),
    JSON.stringify({v: 1, event: 'tool', command: 'code.read'}), // no session: cannot be judged foreign, kept
  ]);
  const events = Worklog.readFile(file, 'mine');
  assert.equal(events.length, 3, 'this conversation\'s two lines plus the session-less line');
  assert.equal(events.foreignLines, 2, 'both other-conversation lines are counted');
  assert.equal(events.foreign, 2, 'the foreign alias carries the same count');
  assert.equal(events.badLines, 0, 'foreign lines are not bad lines');
  assert.ok(events.every(e => e.session == null || e.session === 'mine'), 'no foreign event is mixed in');
  // The same counts come back through Worklog.read on the encoded
  // file name, the path real readers use.
  fs.copyFileSync(file, fileFor('mine', dir));
  const viaRead = Worklog.read('mine', dir);
  assert.equal(viaRead.length, 3);
  assert.equal(viaRead.foreignLines, 2);
  // Control: a file whose lines ALL name one other session is that
  // session's log under a renamed / legacy-shared name, not a mix —
  // with no line of the reader's own conversation there is nothing
  // to mix into, so nothing is foreign.
  const only = writeLog(t, 'renamed.jsonl', [ev('other', 'turn', {text: 'x'}), ev('other', 'reply', {text: 'y'})]);
  const renamed = Worklog.readFile(only.file, 'mine');
  assert.equal(renamed.length, 2);
  assert.equal(renamed.foreignLines, 0);
});
