'use strict';
// audit-cli wave 11 — src/lore.js: id matching, tombstones, repo id,
// locate semantics, per-call file caching, and the CLI listing cap.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const lore = require('../src/lore.js');

function setup() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w11-data-'));
  process.env.LOCALAPPDATA = data;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w11-repo-'));
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  return {data, repo};
}
function write(repo, rel, text) { fs.writeFileSync(path.join(repo, rel), text); }
function rec(kind, fields) { return {v: 1, kind, id: 'w11-' + Math.random().toString(36).slice(2), at: '2026-11-08T00:00:00.000Z', ...fields}; }
function gitAvailable(t) {
  try { execFileSync('git', ['--version'], {stdio: 'ignore'}); return true; } catch { t.skip('no git'); return false; }
}
function git(repo, args, env) {
  return execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, ...(env || {})}});
}

// ---------- (1) id matching: unique prefix only, kind filter, per-record count ----------

test('w11-1: forget with an ambiguous id prefix says so, with the count, and deletes nothing', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\ny\n');
  lore.appendRecord(repo, rec('hunch', {id: 'w11-aaa1', path: 'src/a.js', start: 1, end: 1, text: '前提1', state: 'open'}));
  lore.appendRecord(repo, rec('hunch', {id: 'w11-aaa2', path: 'src/a.js', start: 1, end: 1, text: '前提2', state: 'open'}));
  assert.throws(() => lore.forget(repo, {id: 'w11-aaa'}), /id が曖昧です（2 件に一致します）/);
  assert.equal(lore.readRecords(repo).length, 2, 'nothing was deleted');
  assert.equal(lore.forget(repo, {id: 'w11-aaa1'}), 1, 'a unique prefix still names one record');
  assert.equal(lore.readRecords(repo).length, 1);
});

test('w11-1: setHunchState with an ambiguous id prefix says so and changes nothing', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\ny\n');
  lore.appendRecord(repo, rec('hunch', {id: 'w11-hhh1', path: 'src/a.js', start: 1, end: 1, text: '前提1', state: 'open'}));
  lore.appendRecord(repo, rec('hunch', {id: 'w11-hhh2', path: 'src/a.js', start: 1, end: 1, text: '前提2', state: 'open'}));
  assert.throws(() => lore.setHunchState(repo, 'w11-hhh', 'confirmed'), /id が曖昧です（2 件に一致します）/);
  assert.ok(lore.readRecords(repo).every(r => r.state === 'open'), 'no state changed');
  assert.equal(lore.setHunchState(repo, 'w11-hhh1', 'confirmed'), true);
  assert.equal(lore.readRecords(repo).find(r => r.id === 'w11-hhh1').state, 'confirmed');
  assert.equal(lore.readRecords(repo).find(r => r.id === 'w11-hhh2').state, 'open');
});

test('w11-1: the kind filter stays in force when an id is given', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\ny\n');
  lore.appendRecord(repo, rec('scar', {id: 'w11-bbb1', path: 'src/a.js', start: 1, end: 1, bug: 'バグ'}));
  lore.appendRecord(repo, rec('hunch', {id: 'w11-bbb2', path: 'src/a.js', start: 1, end: 1, text: '前提', state: 'open'}));
  assert.equal(lore.forget(repo, {id: 'w11-bbb1', kind: 'hunch'}), 0, 'the id matches a scar, the kind filter excludes it');
  assert.equal(lore.readRecords(repo).length, 2);
  assert.equal(lore.forget(repo, {id: 'w11-bbb', kind: 'hunch'}), 1, 'after the kind filter the prefix is unambiguous');
  assert.deepEqual(lore.readRecords(repo).map(r => r.kind), ['scar']);
});

test('w11-1: forget counts records, not file copies (local + shared is one record)', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\ny\n');
  const h = lore.addHunch(repo, {path: 'src/a.js', line: 1, text: '前提'});
  const ctx = lore.repoContext(repo);
  fs.mkdirSync(path.dirname(ctx.sharedFile), {recursive: true});
  fs.copyFileSync(ctx.localFile, ctx.sharedFile); // the same record now lives in both files
  assert.equal(lore.readRecords(repo).length, 1, 'merged read still sees one record');
  assert.equal(lore.forget(repo, {id: h.id}), 1, 'counted once, not once per file');
  assert.equal(lore.readRecords(repo).length, 0);
});

// ---------- (2) tombstones apply on every read, to every record ----------

test('w11-2: a forgotten record stays gone when its bytes come back (restore / shared copy)', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\ny\n');
  const derived = rec('why', {path: 'src/a.js', start: 1, end: 1, reason: '理由', key: 'why|src/a.js|deadbeef|t|0'});
  lore.appendRecord(repo, derived);
  const h = lore.addHunch(repo, {path: 'src/a.js', line: 1, text: '前提'}); // a manual record: no dedupe key
  const ctx = lore.repoContext(repo);
  const rawLines = fs.readFileSync(ctx.localFile, 'utf8');
  assert.equal(lore.forget(repo, {all: true}), 2);
  assert.equal(lore.readRecords(repo).length, 0);
  fs.writeFileSync(ctx.localFile, rawLines); // the file is restored from a backup
  assert.equal(lore.readRecords(repo).length, 0, 'neither the derived record nor the keyless hunch revives');
  assert.ok(h);
});

// ---------- (3) repo id: first commit + git common dir; pre-commit store migrates ----------

test('w11-3: two template copies with the SAME first commit get different repo ids', (t) => {
  if (!gitAvailable(t)) return;
  const {data} = setup();
  void data;
  const env = {GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'};
  const ids = [], firsts = [];
  for (const name of ['copyA', 'copyB']) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w11-' + name + '-'));
    fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
    write(repo, 'src/a.js', 'one\ntwo\n');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'lore@test']);
    git(repo, ['config', 'user.name', 'Lore Test']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'first'], env);
    firsts.push(git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim());
    ids.push(lore.repoId(repo));
  }
  assert.equal(firsts[0], firsts[1], 'sanity: the template copies really share their first commit');
  assert.match(ids[0], /^[0-9a-f]{40}$/);
  assert.notEqual(ids[0], ids[1], 'the common dir keeps their lore stores apart');
});

test('w11-3: a store made before the first commit is inherited under the new id', (t) => {
  if (!gitAvailable(t)) return;
  const {repo} = setup();
  write(repo, 'src/a.js', 'one\ntwo\n');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'lore@test']);
  git(repo, ['config', 'user.name', 'Lore Test']);
  const before = lore.repoContext(repo);
  assert.ok(before.id.startsWith('p'), 'no commit yet -> path-hash id, got ' + before.id);
  lore.addHunch(repo, {path: 'src/a.js', line: 1, text: 'コミット前の前提'});
  assert.equal(lore.readRecords(repo).length, 1);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'first']);
  // repoContext is memoized for ~1s per cwd; a subdirectory of the same
  // repo resolves the same root under a fresh cache key.
  const sub = path.join(repo, 'src');
  const after = lore.repoContext(sub);
  assert.match(after.id, /^[0-9a-f]{40}$/, 'after the first commit the id is the git-based one');
  assert.notEqual(after.id, before.id);
  assert.ok(fs.existsSync(after.localFile), 'the old store directory was inherited, not orphaned');
  assert.equal(lore.readRecords(sub).length, 1, 'the pre-commit record is still there');
  assert.equal(lore.readRecords(sub)[0].text, 'コミット前の前提');
});

// ---------- (4) locate ----------

test('w11-4: a whole-file scar anchors to the file itself — changed, never lost', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'one\ntwo\nthree\n');
  const scar = lore.recordScar({cwd: repo, file: 'src/a.js', summary: '境界バグ', tests: ['tests/a.test.js']});
  assert.ok(scar);
  write(repo, 'src/a.js', 'completely\ndifferent\n');
  const hits = lore.listKind(repo, 'scar');
  assert.equal(hits.length, 1);
  assert.notEqual(hits[0].loc.status, 'lost', 'the file is still there, so the scar is found');
  assert.equal(hits[0].loc.changed, true);
  assert.ok(lore.formatRecord(hits[0].rec, hits[0].loc).includes('内容が変わっています'));
  assert.ok(lore.notesFor(repo, 'src/a.js')[0].includes('内容が変わっています'), 'the note form shows it too');
});

test('w11-4: lines inserted inside the range — the context bracket gap may grow', () => {
  const lines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'];
  const r = {...lore.anchor(lines, 3, 4), path: 'src/a.js'};
  const inserted = ['l1', 'l2', 'l3', 'NEW', 'l4', 'l5', 'l6', 'l7', 'l8'];
  assert.deepEqual(lore.locate(r, inserted), {status: 'context', start: 3, end: 5, changed: true});
});

test('w11-4: the same block in several places — the nearest match wins', () => {
  const lines0 = ['x', 'A', 'B', 'y', 'A', 'B', 'z'];
  const r = {...lore.anchor(lines0, 5, 6), path: 'src/a.js'};
  const shifted = ['p', ...lines0]; // the block now sits at 3 and at 6; the record was at 5
  assert.deepEqual(lore.locate(r, shifted), {status: 'moved', start: 6, end: 7});
});

test('w11-4: whyFor does not use a lost record’s recorded range', () => {
  const {repo} = setup();
  const lines = ['a', 'b', 'c', 'd', 'e'];
  write(repo, 'src/a.js', lines.join('\n'));
  lore.appendRecord(repo, rec('why', {path: 'src/a.js', start: 2, end: 3, hash: lore.hashText('X\nY'), text: ['X', 'Y'], before: ['q'], after: ['z'], reason: '消えた理由'}));
  lore.appendRecord(repo, rec('why', {path: 'src/a.js', ...lore.anchor(lines, 2, 3), reason: '残る理由'}));
  const hits = lore.whyFor(repo, 'src/a.js', 2);
  assert.equal(hits.length, 1, 'only the located record answers');
  assert.equal(hits[0].rec.reason, '残る理由');
});

// ---------- (5) one read per path per call ----------

test('w11-5: storyFor reads a file’s content once, however many records anchor in it', () => {
  const {repo} = setup();
  const lines = ['a', 'b', 'c'];
  write(repo, 'src/a.js', lines.join('\n'));
  for (let i = 0; i < 3; i++) lore.appendRecord(repo, rec('why', {path: 'src/a.js', ...lore.anchor(lines, 1, 1), reason: '理由' + i}));
  const target = path.join(repo, 'src', 'a.js');
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) { if (String(p) === target) reads++; return orig.call(this, p, ...rest); };
  try { assert.equal(lore.storyFor(repo, 'src/a.js').length, 3); }
  finally { fs.readFileSync = orig; }
  assert.equal(reads, 1);
});

// ---------- (6) the CLI text listing is capped at 100 ----------

test('w11-6: runLoreCli scars text caps at 100 lines and notes the rest; --json does not cap', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\n');
  for (let i = 0; i < 105; i++) lore.appendRecord(repo, rec('scar', {path: 'src/a.js', start: 1, end: 1, bug: 'バグ' + i, key: 'scar|w11|' + i}));
  const lines = [];
  const code = lore.runLoreCli(['scars'], {cwd: repo, out: l => lines.push(l), sync: false});
  assert.equal(code, 0);
  assert.equal(lines.length, 101, '100 records + the remainder note');
  assert.ok(lines[100].includes('ほか 5 件'), lines[100]);
  const jsonLines = [];
  lore.runLoreCli(['scars', '--json'], {cwd: repo, out: l => jsonLines.push(l), sync: false});
  assert.equal(JSON.parse(jsonLines[0]).length, 105, 'the machine form is not capped');
});
