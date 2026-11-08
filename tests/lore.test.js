'use strict';
// Code memory (src/lore.js): records, anchors, the work-log read side, the
// CLI. The work log itself is written by src/worklog.js; the fixture below
// is a sample in its shape (docs/design/new-features.md §1): one JSONL
// file per conversation, turn / tool / edit / expect / reply / focus
// events, before-images in worklog/blobs/<hash>.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const lore = require('../src/lore.js');

// Each test gets its own data root and repo folder: lore reads LOCALAPPDATA
// at call time, so pointing it at a fresh temp dir isolates the test.
function setup() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-lore-data-'));
  process.env.LOCALAPPDATA = data;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-lore-repo-'));
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  fs.mkdirSync(path.join(repo, 'tests'), {recursive: true});
  return {data, repo};
}
function write(repo, rel, text) { fs.writeFileSync(path.join(repo, rel), text); }
function rec(kind, fields) { return {v: 1, kind, id: 'test-' + Math.random().toString(36).slice(2), at: '2026-11-07T00:00:00.000Z', ...fields}; }

test('place: default is this PC under %LOCALAPPDATA%\\muser\\lore\\<repo id>', () => {
  const {data, repo} = setup();
  const ctx = lore.repoContext(repo);
  assert.equal(ctx.shared, false);
  assert.equal(ctx.file, ctx.localFile);
  assert.ok(ctx.localFile.startsWith(path.join(data, 'muser', 'lore')), ctx.localFile);
  assert.ok(ctx.id.startsWith('p'), 'no git -> path-hash id, got ' + ctx.id);
  assert.equal(lore.repoContext(repo).id, ctx.id, 'id is stable');
});

test('anchor + locate: exact, moved by hash, context fallback, lost', () => {
  const {repo} = setup();
  const lines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'];
  const a = lore.anchor(lines, 3, 4);
  assert.equal(a.hash, lore.hashText('l3\nl4'));
  assert.deepEqual(a.before, ['l1', 'l2']);
  assert.deepEqual(a.after, ['l5', 'l6', 'l7']);
  const r = {...a, path: 'src/a.js'};
  assert.deepEqual(lore.locate(r, lines), {status: 'exact', start: 3, end: 4});
  const moved = ['new1', 'new2', ...lines];
  assert.deepEqual(lore.locate(r, moved), {status: 'moved', start: 5, end: 6});
  const edited = ['l1', 'l2', 'CHANGED', 'ALSO', 'l5', 'l6', 'l7', 'l8'];
  assert.deepEqual(lore.locate(r, edited), {status: 'context', start: 3, end: 4, changed: true}, 'found by context, but the content changed');
  assert.equal(lore.locate(r, ['x', 'y', 'z']).status, 'lost');
  assert.equal(lore.locate(r, null).status, 'lost');
  write(repo, 'src/a.js', lines.join('\n'));
});

test('records: hunch roundtrip, sensitive path refused, secrets redacted', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'one\ntwo\nthree\n');
  const h = lore.addHunch(repo, {path: 'src/a.js', line: 2, text: 'token = abc123 なので速いはず'});
  assert.ok(h);
  assert.equal(h.state, 'open');
  assert.ok(!JSON.stringify(h).includes('abc123'), 'secret value must not be stored');
  assert.ok(h.text.includes('[redacted]'));
  const all = lore.readRecords(repo);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'hunch');
  assert.equal(lore.addHunch(repo, {path: '.env', line: 1, text: '前提'}), null, 'a sensitive path gets no record');
  assert.equal(lore.addHunch(repo, {path: 'src/key.pem', line: 1, text: '前提'}), null);
  assert.equal(lore.readRecords(repo).length, 1);
  assert.equal(lore.setHunchState(repo, h.id.slice(0, 8), 'confirmed'), true);
  assert.equal(lore.readRecords(repo)[0].state, 'confirmed');
});

test('whyFor: newest first, at most 3, only the lines the range covers', () => {
  const {repo} = setup();
  const lines = ['a', 'b', 'c', 'd', 'e'];
  write(repo, 'src/a.js', lines.join('\n'));
  const mk = (at, s, e, reason) => lore.appendRecord(repo, rec('why', {path: 'src/a.js', ...lore.anchor(lines, s, e), at, reason, agent: 'main'}));
  mk('2026-11-01T00:00:00.000Z', 2, 3, '古い理由');
  mk('2026-11-03T00:00:00.000Z', 2, 3, '新しい理由');
  mk('2026-11-02T00:00:00.000Z', 5, 5, '別の場所');
  const hits = lore.whyFor(repo, 'src/a.js', 3);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].rec.reason, '新しい理由');
  assert.equal(lore.whyFor(repo, 'src/a.js', 5).length, 1);
  assert.equal(lore.whyFor(repo, 'src/a.js', 1).length, 0);
});

// --- the work-log fixture ------------------------------------------------------
function worklogFixture({data, repo}) {
  const parseLines = ['export function parse(s) {', '  return s.trim();', '}'];
  write(repo, 'src/parse.js', parseLines.join('\n') + '\n');
  write(repo, 'src/old.js', 'keep();\n');
  write(repo, 'tests/parse.test.js', '// tests\n');
  const wl = path.join(data, 'muser', 'worklog');
  fs.mkdirSync(path.join(wl, 'blobs'), {recursive: true});
  const deleted = Array.from({length: 12}, (_, i) => 'oldLine' + (i + 1) + '();');
  // The shape src/worklog.js writes: `event` discriminator, a turn's
  // request in `text`, an edit's span in `ranges` and its deletion count
  // in `removed`.
  const events = [
    {v: 1, event: 'turn', at: '2026-11-07T01:00:00.000Z', session: 'conv1', agent: 'main', text: 'parse.js の境界バグを直して'},
    {v: 1, event: 'tool', at: '2026-11-07T01:00:30.000Z', session: 'conv1', command: 'code.read', summary: 'read parse.js', ok: true},
    {v: 1, event: 'edit', at: '2026-11-07T01:01:00.000Z', session: 'conv1', path: path.join(repo, 'src', 'parse.js'), op: 'edit', ranges: [{start: 2, end: 2}], added: 1, removed: 1, beforeHash: 'b1', afterHash: lore.hashText('  return s.trim();'), diff: '@@\n-  return s;\n+  return s.trim();'},
    {v: 1, event: 'edit', at: '2026-11-07T01:02:00.000Z', session: 'conv1', path: path.join(repo, 'tests', 'parse.test.js'), op: 'edit', ranges: [{start: 1, end: 1}], added: 1, removed: 0, beforeHash: 'b2', afterHash: 'a2', diff: "@@\n+test('境界で落ちない', () => {});"},
    {v: 1, event: 'expect', at: '2026-11-07T01:02:30.000Z', session: 'conv1', agent: 'main', command: 'system.run', expect: {exit: 0}, matched: true, expected: 'exit 0', actual: 'exit 0', mode: 'record'},
    {v: 1, event: 'reply', at: '2026-11-07T01:03:00.000Z', session: 'conv1', agent: 'main', text: 'parse.js の境界バグを修正しました。回帰テストも足しました。'},
    {v: 1, event: 'focus', at: '2026-11-07T01:03:30.000Z', session: 'conv1', focus: {status: 'complete'}},
    {v: 1, event: 'turn', at: '2026-11-07T02:00:00.000Z', session: 'conv1', agent: 'a1', text: 'old.js の古い処理を消して'},
    {v: 1, event: 'edit', at: '2026-11-07T02:01:00.000Z', session: 'conv1', path: path.join(repo, 'src', 'old.js'), op: 'edit', ranges: [{start: 1, end: 1}], added: 0, removed: 12, beforeHash: 'b3', afterHash: 'a3', diff: '@@\n' + deleted.map(l => '-' + l).join('\n') + '\n keep();'},
    {v: 1, event: 'reply', at: '2026-11-07T02:02:00.000Z', session: 'conv1', agent: 'a1', text: 'old.js の古い処理を削除しました。'},
  ];
  fs.writeFileSync(path.join(wl, 'conv1.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\nnot json\n');
  fs.writeFileSync(path.join(wl, 'blobs', 'b3'), deleted.join('\n') + '\nkeep();\n');
  return {deleted};
}

test('syncFromWorklog: why + scar + grave derived, and a second sync adds nothing', () => {
  const s = setup();
  worklogFixture(s);
  const r1 = lore.syncFromWorklog(s.repo);
  assert.ok(r1.events >= 10);
  const records = lore.readRecords(s.repo);
  const why = records.find(x => x.kind === 'why' && x.path === 'src/parse.js');
  assert.ok(why, 'why for parse.js');
  assert.equal(why.agent, 'main');
  assert.ok(why.reason.includes('修正しました'), 'reason picked from the reply: ' + why.reason);
  assert.ok(why.request.includes('境界バグ'));
  assert.equal(why.start, 2);
  const scar = records.find(x => x.kind === 'scar');
  assert.ok(scar, 'scar derived from the turn that fixed + tested');
  assert.equal(scar.path, 'src/parse.js');
  assert.equal(scar.testFile, 'tests/parse.test.js');
  assert.equal(scar.testName, '境界で落ちない');
  const grave = records.find(x => x.kind === 'grave');
  assert.ok(grave, 'grave derived from the 12-line deletion');
  assert.equal(grave.path, 'src/old.js');
  assert.equal(grave.deletedLines, 12);
  assert.ok(grave.head.startsWith('oldLine1();'));
  const r2 = lore.syncFromWorklog(s.repo);
  assert.equal(r2.added.length, 0, 'idempotent');
  assert.equal(lore.readRecords(s.repo).length, records.length);
});

test('recordScar: a scar offered from outside (the bug hunt seam) is recorded once', () => {
  const s = setup();
  write(s.repo, 'src/a.js', 'fixed();\n');
  const rec1 = lore.recordScar({cwd: s.repo, file: 'src/a.js', summary: '境界で落ちるバグ', tests: ['tests/a.test.js']});
  assert.ok(rec1, 'the offered scar is recorded');
  assert.equal(rec1.kind, 'scar');
  assert.equal(rec1.path, 'src/a.js');
  assert.equal(rec1.bug, '境界で落ちるバグ');
  assert.equal(rec1.testFile, 'tests/a.test.js');
  assert.equal(rec1.verified, false);
  const again = lore.recordScar({cwd: s.repo, file: 'src/a.js', summary: '境界で落ちるバグ', tests: ['tests/a.test.js']});
  assert.equal(again, null, 'the same offer is deduped');
  assert.equal(lore.readRecords(s.repo).filter(r => r.kind === 'scar').length, 1);
  assert.equal(lore.recordScar({cwd: s.repo, file: 'src/a.js', summary: '  '}), null, 'an empty summary is refused');
});

test('notesFor + graveResemblance: the read side that warns Muse', () => {
  const s = setup();
  const {deleted} = worklogFixture(s);
  lore.syncFromWorklog(s.repo);
  const notes = lore.notesFor(s.repo, 'src/parse.js');
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes('回帰テスト'));
  const attach = lore.attachText(s.repo, 'src/parse.js', {start: 2, end: 2});
  assert.ok(attach.startsWith('[muser: 言い伝え]'));
  assert.equal(lore.attachText(s.repo, 'src/parse.js', {start: 90, end: 99}), '', 'no overlap, no note');
  const back = lore.graveResemblance(s.repo, 'src/old.js', deleted.join('\n'));
  assert.ok(back && back.how === 'hash', 'writing the deleted block back is caught by hash');
  const similar = lore.graveResemblance(s.repo, 'src/old.js', deleted.slice(0, 10).concat(['other1();', 'other2();']).join('\n'));
  assert.ok(similar && similar.how === 'similar', 'a near-copy is caught by resemblance');
  assert.equal(lore.graveResemblance(s.repo, 'src/old.js', 'totallyDifferent();\nanother();\nthird();'), null);
});

test('story: every kind for one file, oldest first', () => {
  const {repo} = setup();
  const lines = ['a', 'b', 'c'];
  write(repo, 'src/a.js', lines.join('\n'));
  lore.appendRecord(repo, rec('why', {path: 'src/a.js', ...lore.anchor(lines, 1, 1), at: '2026-11-03T00:00:00.000Z', reason: '理由'}));
  lore.addHunch(repo, {path: 'src/a.js', line: 2, text: '前提'});
  const story = lore.storyFor(repo, 'src/a.js');
  assert.equal(story.length, 2);
  assert.equal(story[0].rec.kind, 'why');
  assert.equal(story[1].rec.kind, 'hunch');
  const lines2 = lore.formatRecord(story[0].rec, story[0].loc);
  assert.ok(lines2.includes('why'));
});

test('share: writes move to .muser/lore.jsonl, reads still merge both places', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\n');
  lore.addHunch(repo, {path: 'src/a.js', line: 1, text: 'PC 側の前提'});
  const ctx = lore.setShared(repo, true);
  assert.equal(ctx.file, path.join(repo, '.muser', 'lore.jsonl'));
  lore.addHunch(repo, {path: 'src/a.js', line: 1, text: '共有側の前提'});
  assert.ok(fs.existsSync(path.join(repo, '.muser', 'lore.jsonl')));
  assert.equal(lore.readRecords(repo).length, 2, 'both places are read');
  lore.setShared(repo, false);
  assert.equal(lore.repoContext(repo).shared, false);
});

test('forget: by kind, by path, and all', () => {
  const {repo} = setup();
  write(repo, 'src/a.js', 'x\ny\n');
  lore.addHunch(repo, {path: 'src/a.js', line: 1, text: '前提1'});
  lore.appendRecord(repo, rec('why', {path: 'src/a.js', ...lore.anchor(['x', 'y'], 1, 1), reason: 'r'}));
  assert.equal(lore.forget(repo, {kind: 'hunch'}), 1);
  assert.equal(lore.readRecords(repo).length, 1);
  assert.equal(lore.forget(repo, {path: 'src/a.js'}), 1);
  assert.equal(lore.forget(repo, {all: true}), 0);
});

test('CLI: list, hunch, why after sync, share, forget, bad usage', () => {
  const s = setup();
  worklogFixture(s);
  const run = argv => { const lines = []; const code = lore.runLoreCli(argv, {cwd: s.repo, out: l => lines.push(l)}); return {code, lines}; };
  let r = run(['list']);
  assert.equal(r.code, 0);
  assert.ok(r.lines[0].includes('why 3'), r.lines[0]); // one why per edit (3 edits in the fixture)
  r = run(['hunch', 'src/parse.js:2', '入力は', '空でない前提']);
  assert.equal(r.code, 0);
  r = run(['why', 'src/parse.js:2']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.some(l => l.includes('why')), r.lines.join(' / '));
  r = run(['scars']);
  assert.ok(r.lines.some(l => l.includes('傷跡')));
  r = run(['graves']);
  assert.ok(r.lines.some(l => l.includes('墓標')));
  r = run(['story', 'src/parse.js']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.length >= 2);
  r = run(['share', 'on']);
  assert.equal(r.code, 0);
  assert.equal(lore.repoContext(s.repo).shared, true);
  run(['share', 'off']);
  r = run(['forget', '--kind', 'hunch']);
  assert.equal(r.code, 0);
  assert.ok(r.lines[0].includes('1'));
  r = run(['why']);
  assert.equal(r.code, 1);
  r = run(['nope']);
  assert.equal(r.code, 1);
});

test('git repo: id is the first commit, blame names author and date', (t) => {
  const {repo} = setup();
  try { execFileSync('git', ['--version'], {stdio: 'ignore'}); } catch { t.skip('no git'); return; }
  const git = args => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  git(['init', '-q']);
  git(['config', 'user.email', 'lore@test']);
  git(['config', 'user.name', 'Lore Test']);
  write(repo, 'src/a.js', 'one\ntwo\n');
  git(['add', '.']);
  git(['commit', '-qm', 'first']);
  const ctx = lore.repoContext(repo);
  assert.match(ctx.id, /^[0-9a-f]{40}$/);
  const b = lore.blame(repo, 'src/a.js', 2);
  assert.ok(b);
  assert.equal(b.author, 'Lore Test');
  assert.match(b.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(b.summary, 'first');
});

test('controller: /lore and /why push a lore entry', async () => {
  const s = setup();
  worklogFixture(s);
  const {EventEmitter} = require('node:events');
  class FakeAgent extends EventEmitter {
    constructor(cwd) { super(); this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()}; this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true}; }
  }
  FakeAgent.DEVICE = 'test';
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(s.repo), museName: 'm', version: 't', onExit() {}});
  const last = () => { const es = ctrl.get().entries; return es[es.length - 1]; };
  ctrl.slash('/lore');
  assert.equal(last().type, 'lore');
  assert.equal(last().title, '言い伝え');
  assert.ok(last().lines[0].includes('why 3'), last().lines[0]);
  ctrl.slash('/why src/parse.js:2');
  assert.equal(last().type, 'lore');
  assert.ok(last().lines.some(l => l.includes('why')));
  ctrl.slash('/lore scars');
  assert.ok(last().lines.some(l => l.includes('傷跡')));
  ctrl.slash('/lore hunch src/parse.js:2 空でない前提');
  ctrl.slash('/lore hunches');
  assert.ok(last().lines.some(l => l.includes('仮説付箋')));
  ctrl.slash('/why');
  assert.equal(last().type, 'note', 'a missing argument is a usage note');
});
