'use strict';
// /proof (evidence badges + counter-proof) against hand-made worklog
// samples in the shape src/worklog.js writes (%LOCALAPPDATA%\muser\
// worklog\<id>.jsonl, one event per line: {v, at, session, event, ...},
// before-images in worklog\blobs\<hash>).
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wl = require('../src/proof/worklog');
const badge = require('../src/proof/badge');
const counter = require('../src/proof/counter');
const proof = require('../src/proof/index');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-proof-test-'));
// Fixtures are written in the writer's real shape: the discriminator is
// `event`, a turn's request is `text`, and there is no recorded turn
// number (turns are counted by appearance, as splitTurns does). Callers
// below still spell {prompt} / {turn} for brevity; both are translated
// here (turn is dropped, prompt becomes text).
const ev = (type, rest = {}) => { const {turn, prompt, ...r} = rest; return {v: 1, event: type, at: '2026-11-07T00:00:00.000Z', session: 'c1', ...(prompt !== undefined ? {text: prompt} : {}), ...r}; };
function sampleLog(dir, id, events) {
  const file = wl.worklogFile(id, dir);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
function turnOf(events) { return wl.splitTurns(wl.parseWorklog(events.map(e => JSON.stringify(e)).join('\n')))[0]; }

test('worklog: parse drops broken lines and sensitive-path events', () => {
  const text = [JSON.stringify(ev('turn', {turn: 1, prompt: '直して'})), '{broken',
    JSON.stringify(ev('edit', {turn: 1, path: '.env', beforeHash: 'aa', afterHash: 'bb'})),
    JSON.stringify(ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'aa', afterHash: 'bb'})),
    JSON.stringify(ev('reply', {turn: 1, text: '直しました。'}))].join('\n');
  const events = wl.parseWorklog(text);
  assert.equal(events.length, 3);
  assert.equal(events[1].path, 'src/a.js');
  const turns = wl.splitTurns(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].reply, '直しました。');
  assert.equal(turns[0].edits.length, 1);
});

test('worklog: readWorklog reports missing, pickTurn takes the newest reply', () => {
  const dir = tmp();
  try {
    assert.equal(wl.readWorklog('nope', {base: dir}).missing, true);
    sampleLog(dir, 'c1', [ev('turn', {turn: 1, prompt: 'a'}), ev('reply', {turn: 1, text: '一回目。'}),
      ev('turn', {turn: 2, prompt: 'b'}), ev('reply', {turn: 2, text: '二回目。'})]);
    const {events} = wl.readWorklog('c1', {base: dir});
    const turns = wl.splitTurns(events);
    assert.equal(wl.pickTurn(turns).reply, '二回目。');
    assert.equal(wl.pickTurn(turns, 1).reply, '一回目。');
    assert.equal(wl.pickTurn(turns, '2').turn, 2);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('worklog: retention defaults are the design proposal (30 days / 500 MB), enforced by the writer, not by proof', () => {
  assert.equal(wl.RETENTION_DAYS, 30);
  assert.equal(wl.RETENTION_MAX_BYTES, 500 * 1024 * 1024);
  assert.equal(wl.pruneWorklog, undefined); // the second sweep is retired; src/worklog.js prunes on write
  const {Worklog} = require('../src/worklog');
  const dir = tmp();
  try {
    const old = sampleLog(dir, 'old', [ev('turn', {text: 'x'})]);
    const liveHash = 'a'.repeat(64);
    const keep = sampleLog(dir, 'keep', [ev('edit', {path: 'src/a.js', beforeHash: liveHash, afterHash: 'z'})]);
    const blobs = wl.blobsDir(dir); fs.mkdirSync(blobs, {recursive: true});
    fs.writeFileSync(path.join(blobs, liveHash), 'before');
    fs.writeFileSync(path.join(blobs, 'orphan'), 'before');
    const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    // Retention ages a log by its newest content 'at', not mtime alone
    // (wave 17), so the fixture ages the old log's lines' 'at' too.
    const oldLines = fs.readFileSync(old, 'utf8').trim().split('\n').map(line => { const e = JSON.parse(line); e.at = longAgo.toISOString(); return JSON.stringify(e); });
    fs.writeFileSync(old, oldLines.join('\n') + '\n');
    fs.utimesSync(old, longAgo, longAgo);
    // The writer's own prune runs on its first drain in this folder.
    const writer = new Worklog({sessionId: 'keep', dir: wl.worklogDir(dir)});
    writer.turn({text: 'x', agent: 'main'});
    writer.flush();
    assert.ok(!fs.existsSync(old), 'the 40-day-old log is pruned by the writer');
    assert.ok(fs.existsSync(keep));
    assert.ok(fs.existsSync(path.join(blobs, liveHash)));
    assert.ok(!fs.existsSync(path.join(blobs, 'orphan')));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('worklog: blob reads refuse path-like names', () => {
  assert.equal(wl.readBlob('../secret'), null);
  assert.equal(wl.readBlob('a/b'), null);
});

const fixedTurn = reply => turnOf([
  ev('turn', {turn: 1, prompt: 'バグを直して'}),
  ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'b1', afterHash: 'b2'}),
  ev('tool', {turn: 1, command: 'system.run', summary: 'npm test', ok: true, exitCode: 0, outHead: 'ℹ pass 128', outTail: 'ℹ fail 0'}),
  ev('reply', {turn: 1, text: reply}),
]);

test('badge: a backed test claim and file claim get ✓', () => {
  const r = badge.proofTurn(fixedTurn('テスト 128 件すべて通過しました。src/a.js を直しました。'));
  assert.deepEqual(r.rows.map(x => x.mark), ['✓', '✓']);
  assert.equal(r.counts.ok, 2);
});

test('badge: "all passed" against a failing run gets ✗', () => {
  const turn = turnOf([
    ev('turn', {turn: 1, prompt: 'x'}),
    ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'b1', afterHash: 'b2'}),
    ev('tool', {turn: 1, command: 'system.run', summary: 'npm test', ok: false, exitCode: 1, outHead: 'ℹ pass 127 ℹ fail 1'}),
    ev('reply', {turn: 1, text: 'テストは全部通った。'}),
  ]);
  const r = badge.proofTurn(turn);
  assert.equal(r.rows[0].mark, '✗');
});

test('badge: no test run after the last edit gets ?, and a run before it is stale', () => {
  const noRun = badge.proofTurn(turnOf([
    ev('turn', {turn: 1, prompt: 'x'}),
    ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'b1', afterHash: 'b2'}),
    ev('reply', {turn: 1, text: 'テスト 3 件通過しました。'}),
  ]));
  assert.equal(noRun.rows[0].mark, '?');
  const stale = badge.proofTurn(turnOf([
    ev('turn', {turn: 1, prompt: 'x'}),
    ev('tool', {turn: 1, command: 'system.run', summary: 'npm test', ok: true, exitCode: 0, outHead: 'ℹ pass 3 ℹ fail 0'}),
    ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'b1', afterHash: 'b2'}),
    ev('reply', {turn: 1, text: 'テスト 3 件通過しました。'}),
  ]));
  assert.equal(stale.rows[0].mark, '?');
  assert.match(stale.rows[0].reason, /古い証拠/);
});

test('badge: a sentence with no fixed-shape claim gets no mark', () => {
  const r = badge.proofTurn(fixedTurn('こんにちは。様子を見ていました。'));
  assert.equal(r.rows.length, 0);
  assert.equal(r.counts.none, 2);
  assert.match(badge.formatProof(r).join('\n'), /印なし 2 文/);
});

test('badge: file claim for a file the turn never edited gets ✗ when other edits exist', () => {
  const r = badge.proofTurn(fixedTurn('src/b.js を直しました。'));
  assert.equal(r.rows[0].mark, '✗');
});

test('badge: command claim and no-error claim check the record', () => {
  const ok = badge.proofTurn(fixedTurn('`npm test` を実行しました。エラーはありません。'));
  assert.deepEqual(ok.rows.map(x => x.mark), ['✓', '✓']);
  const bad = badge.proofTurn(turnOf([
    ev('turn', {turn: 1, prompt: 'x'}),
    ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'b1', afterHash: 'b2'}),
    ev('tool', {turn: 1, command: 'system.run', summary: 'npm run build', ok: false, exitCode: 1, outHead: 'Error: boom'}),
    ev('reply', {turn: 1, text: 'エラーはありません。'}),
  ]));
  assert.equal(bad.rows[0].mark, '✗');
});

test('badge: test counts parse in the main runners\' shapes', () => {
  assert.deepEqual(badge.parseTestCounts('ℹ pass 128\nℹ fail 0'), {pass: 128, fail: 0});
  assert.deepEqual(badge.parseTestCounts('Tests: 1 failed, 3 passed, 4 total'), {pass: 3, fail: 1});
  assert.deepEqual(badge.parseTestCounts('128 passing, 2 failing'), {pass: 128, fail: 2});
});

test('counter: test files split from fixes by path', () => {
  assert.equal(counter.isTestFile('tests/proof.test.js'), true);
  assert.equal(counter.isTestFile('src/__tests__/a.js'), true);
  assert.equal(counter.isTestFile('src/foo.spec.ts'), true);
  assert.equal(counter.isTestFile('src/a.js'), false);
  const {tests, fixes} = counter.splitChanges({edits: [{path: 'tests/x.test.js'}, {path: 'src/a.js'}]});
  assert.deepEqual([tests.length, fixes.length], [1, 1]);
});

function counterFixture() {
  const dir = tmp(), base = tmp(), cwd = path.join(dir, 'proj');
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.mkdirSync(path.join(cwd, 'tests'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'fixed');
  fs.writeFileSync(path.join(cwd, 'tests', 'x.test.js'), 'new test');
  const blobs = wl.blobsDir(base); fs.mkdirSync(blobs, {recursive: true});
  fs.writeFileSync(path.join(blobs, 'beforeblob'), 'buggy');
  const turn = {turn: 1, edits: [
    {event: 'edit', path: 'src/a.js', beforeHash: 'beforeblob', afterHash: 'after'},
    {event: 'edit', path: 'tests/x.test.js', beforeHash: 't0', afterHash: 't1'}],
    tools: [{event: 'tool', command: 'system.run', summary: 'npm test', ok: true}]};
  return {dir, base, cwd, turn};
}

test('counter: without confirmation nothing runs, only the plan comes back', async () => {
  const {dir, base, cwd, turn} = counterFixture();
  try {
    let ran = false;
    const r = await counter.runCounterProof({turn, cwd, base, run: async () => { ran = true; return {exit: 1}; }});
    assert.equal(r.status, 'needs-confirm');
    assert.equal(r.command, 'npm test');
    assert.equal(ran, false);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(base, {recursive: true, force: true}); }
});

test('counter: tests falling with the fix reverted get ✓, the temp copy reverts only the fix and is removed', async () => {
  const {dir, base, cwd, turn} = counterFixture();
  const tmpRoot = path.join(dir, 'tmp');
  try {
    let seen = null;
    const r = await counter.runCounterProof({turn, cwd, base, confirmed: true, tmpRoot, run: async (cmd, o) => {
      seen = {cmd, fix: fs.readFileSync(path.join(o.cwd, 'src', 'a.js'), 'utf8'), test: fs.readFileSync(path.join(o.cwd, 'tests', 'x.test.js'), 'utf8')};
      return {exit: 1};
    }});
    assert.equal(r.mark, '✓');
    assert.deepEqual(seen, {cmd: 'npm test', fix: 'buggy', test: 'new test'});
    assert.equal(fs.existsSync(tmpRoot), false, 'temp copy removed');
    assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'fixed', 'working tree untouched');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(base, {recursive: true, force: true}); }
});

test('counter: tests passing with the fix reverted get ✗; no test edit gets ?', async () => {
  const {dir, base, cwd, turn} = counterFixture();
  try {
    const r = await counter.runCounterProof({turn, cwd, base, confirmed: true, run: async () => ({exit: 0})});
    assert.equal(r.mark, '✗');
    const noTest = await counter.runCounterProof({turn: {...turn, edits: turn.edits.filter(e => e.path.startsWith('src'))}, cwd, base, confirmed: true, run: async () => ({exit: 1})});
    assert.equal(noTest.mark, '?');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(base, {recursive: true, force: true}); }
});

test('proof: conversation flow over a sample worklog; missing log is a plain answer', () => {
  const dir = tmp();
  try {
    assert.equal(proof.proofConversation('none', {base: dir}).missing, true);
    sampleLog(dir, 'c9', [
      ev('turn', {turn: 1, prompt: '直して'}),
      ev('edit', {turn: 1, path: 'src/a.js', beforeHash: 'b1', afterHash: 'b2'}),
      ev('tool', {turn: 1, command: 'system.run', summary: 'npm test', ok: true, exitCode: 0, outHead: 'ℹ pass 2 ℹ fail 0'}),
      ev('reply', {turn: 1, text: 'テスト 2 件通過しました。src/a.js を直しました。'}),
    ]);
    const r = proof.proofConversation('c9', {base: dir});
    assert.equal(r.result.counts.ok, 2);
    assert.match(r.lines.join('\n'), /裏取り（ターン 1）/);
    assert.deepEqual(proof.parseProofArg('2 --yes'), {turn: 2, yes: true});
    assert.deepEqual(proof.parseProofArg(''), {turn: undefined, yes: false});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
