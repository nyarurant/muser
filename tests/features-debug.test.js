'use strict';
// Regression tests for the features-debug pass over the 10 features of
// features-1107 (DevNote/2026-11/features-debug-findings.md). Each test
// names the finding it pins. Real-path shapes only: absolute edit paths,
// real worklog lines, real git where the finding needed it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-home-'));

const {Worklog, sanitizeText, sha256, fileFor, encodeId, decodeId} = require('../src/worklog');
const lore = require('../src/lore');
const expectKit = require('../src/expect');
const counter = require('../src/proof/counter');
const proofWl = require('../src/proof/worklog');
const hunt = require('../src/hunt');
const overnightW = require('../src/overnight/worktree');
const overnightQ = require('../src/overnight/queue');
const overnightR = require('../src/overnight/run');
const {overnightCli} = require('../src/overnight/cli');
const worktreePool = require('../src/worktree-pool');
const badge = require('../src/proof/badge');
const race = require('../src/race');
const overnightWL = require('../src/overnight/worklog-read');
const crashInv = require('../src/crash-investigate');
const {execFileSync} = require('node:child_process');
const gitIn = (cwd, args) => execFileSync('git', args, {cwd, encoding: 'utf8', windowsHide: true});
function makeGitRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-git-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  gitIn(repo, ['init', '-q']);
  gitIn(repo, ['config', 'user.email', 't@example.com']);
  gitIn(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'init']);
  return repo;
}

function counterFixture(t, {absolute = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-cp-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const base = path.join(dir, 'base'), cwd = path.join(dir, 'proj');
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.mkdirSync(path.join(cwd, 'tests'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'fixed');
  fs.writeFileSync(path.join(cwd, 'tests', 'x.test.js'), 'new test');
  const blobs = proofWl.blobsDir(base); fs.mkdirSync(blobs, {recursive: true});
  fs.writeFileSync(path.join(blobs, 'beforeblob'), 'buggy');
  const fixPath = absolute ? path.join(cwd, 'src', 'a.js') : 'src/a.js';
  const turn = {turn: 1, edits: [
    {event: 'edit', path: fixPath, beforeHash: 'beforeblob', afterHash: 'after'},
    {event: 'edit', path: 'tests/x.test.js', beforeHash: 't0', afterHash: 't1'}],
    tools: [{event: 'tool', command: 'system.run', summary: 'npm test', ok: true}]};
  return {dir, base, cwd, turn};
}

const CANARIES = [
  'ghp_' + 'A'.repeat(36),
  'sk-' + 'a1'.repeat(12),
  'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(10) + '.' + 'c'.repeat(10),
  'jsonsecretvalue123',
  'tok_value_123456',
  'hunter2secret',
];
const CANARY_TEXT = [
  'token is ' + CANARIES[0],
  'key ' + CANARIES[1] + ' here',
  'jwt ' + CANARIES[2],
  '{"token": "' + CANARIES[3] + '"}',
  'token ' + CANARIES[4] + ' was used',
  'MY_SECRET_VALUE=' + CANARIES[5],
].join('\n');

test('finding 1: sanitizeText redacts secret shapes, not only labelled values', () => {
  const out = sanitizeText(CANARY_TEXT);
  for (const c of CANARIES) assert.ok(!out.includes(c), 'leaked: ' + c);
  assert.equal(sanitizeText('token counts are fine'), 'token counts are fine', 'prose is left alone');
  assert.equal(sanitizeText('Authorization: Bearer q'), 'Authorization: [redacted]');
});

test('finding 1: nothing secret-shaped reaches a worklog line or a blob', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const log = new Worklog({sessionId: 'dbg1', dir});
  log.turn({text: CANARY_TEXT, agent: 'main'});
  log.edit({file: 'a.js', before: 'const x = 1; // ' + CANARIES[0] + '\n', after: 'const x = 2;\n'});
  log.flush();
  const raw = fs.readFileSync(fileFor('dbg1', dir), 'utf8');
  for (const c of CANARIES) assert.ok(!raw.includes(c), 'log leaked: ' + c);
  const blob = Worklog.readBlob(sha256('const x = 1; // ' + CANARIES[0] + '\n'), dir);
  assert.ok(blob !== null && !blob.includes(CANARIES[0]), 'blob leaked the canary');
});

test('finding 7: a blob keeps CRLF line endings (it is a before-image)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const log = new Worklog({sessionId: 'dbg2', dir});
  const before = 'line1\r\nline2\r\n';
  log.edit({file: 'a.js', before, after: 'line1\n'});
  log.flush();
  assert.equal(Worklog.readBlob(sha256(before), dir), before);
});

test('finding 1: lore records and expect records are washed the same way', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-repo-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
  const rec = lore.addHunch(repo, {path: 'a.js', line: 1, text: '前提 ' + CANARY_TEXT});
  assert.ok(rec);
  for (const c of CANARIES) assert.ok(!rec.text.includes(c), 'lore leaked: ' + c);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  assert.equal(expectKit.appendWorklogEvent('dbg-conv', {event: 'expect', expected: CANARY_TEXT, actual: 'ok'}, {dir}), true);
  const raw = fs.readFileSync(path.join(dir, 'dbg-conv.jsonl'), 'utf8');
  for (const c of CANARIES) assert.ok(!raw.includes(c), 'expect record leaked: ' + c);
});

test('finding 8: counter-proof works with the real (absolute) edit paths and leaves no copy behind', async (t) => {
  const {base, cwd, turn} = counterFixture(t, {absolute: true});
  let seen = null;
  const r = await counter.runCounterProof({turn, cwd, base, confirmed: true, run: async (cmd, o) => {
    seen = {fix: fs.readFileSync(path.join(o.cwd, 'src', 'a.js'), 'utf8'), tmp: o.cwd};
    return {exit: 1};
  }});
  assert.equal(r.mark, '✓');
  assert.equal(seen.fix, 'buggy', 'the fix file is reverted inside the copy');
  assert.equal(fs.existsSync(seen.tmp), false, 'temp copy removed afterwards');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'fixed', 'working tree untouched');
});

test('finding 8: a fix outside the working folder is a ? and the copy is cleaned up', async (t) => {
  const {dir, base, cwd, turn} = counterFixture(t);
  turn.edits[0] = {event: 'edit', path: path.join(dir, 'elsewhere.js'), beforeHash: 'beforeblob', afterHash: 'x'};
  const tmpRoot = path.join(dir, 'tmp');
  const r = await counter.runCounterProof({turn, cwd, base, confirmed: true, tmpRoot, run: async () => ({exit: 1})});
  assert.equal(r.mark, '?');
  assert.equal(fs.existsSync(tmpRoot), false, 'no tree copy left in the temp folder');
});

test('finding 9: a command that never ran is ?, not a false ✓', async (t) => {
  const {base, cwd, turn} = counterFixture(t);
  const notFound = await counter.runCounterProof({turn, cwd, base, confirmed: true, command: 'definitely-not-a-real-command-xyz', run: async () => ({exit: 1, output: "'definitely-not-a-real-command-xyz' is not recognized as an internal or external command"})});
  assert.equal(notFound.mark, '?');
  const spawnFail = await counter.runCounterProof({turn, cwd, base, confirmed: true, run: async () => ({exit: 1, failed: true, output: ''})});
  assert.equal(spawnFail.mark, '?');
  const realFall = await counter.runCounterProof({turn, cwd, base, confirmed: true, run: async () => ({exit: 1, output: 'fail 1'})});
  assert.equal(realFall.mark, '✓', 'a genuine test failure still counts');
});

test('finding 11: a fix that created a file is counter-proved by removing it in the copy', async (t) => {
  const {base, cwd, turn} = counterFixture(t);
  fs.writeFileSync(path.join(cwd, 'src', 'new.js'), 'brand new');
  turn.edits[0] = {event: 'edit', path: 'src/new.js', beforeHash: sha256(''), afterHash: 'new'};
  let existed = null;
  const r = await counter.runCounterProof({turn, cwd, base, confirmed: true, run: async (cmd, o) => { existed = fs.existsSync(path.join(o.cwd, 'src', 'new.js')); return {exit: 1}; }});
  assert.equal(r.mark, '✓');
  assert.equal(existed, false, 'the created file is absent in the reverted copy');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'new.js'), 'utf8'), 'brand new', 'working tree untouched');
});

test('findings 24+25: hunt --fix counter-proof never reverts the real tree, and sees non-code changes and deletions', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-hunt-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  fs.mkdirSync(path.join(repo, 'tests'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'buggy');
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  fs.writeFileSync(path.join(repo, 'gone.js'), 'x');
  const finding = {severity: 'High', file: 'src/a.js', summary: 'a is broken'};
  const stateDir = path.join(repo, 'hunt-state'); fs.mkdirSync(stateDir, {recursive: true});
  const prepared = {cwd: repo, dir: stateDir, level: 'High', findings: [finding], targets: [finding], byFile: new Map([['src/a.js', [finding]]]), deferred: 0, estimate: {agents: 1, account: 'default', files: 1}};
  const seen = [];
  const runTests = async (files, runCwd) => {
    const content = fs.readFileSync(path.join(runCwd, 'src', 'a.js'), 'utf8');
    seen.push({runCwd, content});
    return {ok: content === 'fixed', output: ''};
  };
  const runAgent = async () => {
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'fixed');
    fs.writeFileSync(path.join(repo, 'tests', 'a.test.js'), '// regression');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}');
    fs.rmSync(path.join(repo, 'gone.js'));
    return JSON.stringify({summary: 'a is broken', reproduced: true, fixed: true, testFile: 'tests/a.test.js', note: ''});
  };
  const r = await hunt.runFix(prepared, {runAgent, runTests});
  assert.equal(r.outcomes[0].status, 'fixed');
  assert.ok(seen.some(s => s.content === 'buggy'), 'the counter-proof ran against the reverted text somewhere');
  assert.ok(seen.filter(s => s.content === 'buggy').every(s => s.runCwd !== repo), 'the reverted text was never in the user\'s tree');
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), 'fixed');
  assert.ok(r.changedFiles.includes('package.json'), 'a non-code change is reported');
  assert.ok(r.changedFiles.includes('gone.js'), 'a deletion is reported');
});

test('finding 32: overnight never commits a secret file hiding inside an untracked folder', (t) => {
  const repo = makeGitRepo(t);
  const base = path.join(repo, '..', 'wt-' + path.basename(repo));
  const wt = overnightW.createWorktree({repoDir: repo, baseDir: base, taskId: 'task1'});
  t.after(() => { try { overnightW.removeWorktree({repoDir: repo, dir: wt.dir}); } catch {} fs.rmSync(base, {recursive: true, force: true}); });
  fs.mkdirSync(path.join(wt.dir, 'newdir'), {recursive: true});
  fs.writeFileSync(path.join(wt.dir, 'newdir', '.env'), 'TOKEN=x\n');
  fs.writeFileSync(path.join(wt.dir, 'ok.js'), 'ok\n');
  const c = overnightW.commitWorktree({dir: wt.dir, message: 'night work'});
  assert.equal(c.sensitive, 1, 'the .env inside the folder is seen');
  assert.equal(c.committed, true);
  assert.equal(c.files, 1);
  const names = gitIn(repo, ['show', '--name-only', '--format=', wt.branch]);
  assert.ok(names.includes('ok.js'));
  assert.ok(!names.includes('.env'), 'the secret file is not on the branch');
});

test('finding 27: the node_modules junction stays out of the worktree diff', (t) => {
  const repo = makeGitRepo(t);
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'dep\n');
  const wtDir = path.join(repo, '..', 'wt-nm-' + path.basename(repo));
  t.after(() => { try { worktreePool.removeWorktree({repoDir: repo, dir: wtDir}); } catch {} });
  worktreePool.createWorktree({repoDir: repo, dir: wtDir});
  assert.equal(worktreePool.linkNodeModules({repoDir: repo, dir: wtDir}), true);
  assert.equal(gitIn(wtDir, ['status', '--porcelain']), '', 'junction is invisible to git status');
  gitIn(wtDir, ['add', '-A']);
  assert.ok(!gitIn(wtDir, ['diff', '--cached', '--name-only']).includes('node_modules'), 'nothing of node_modules is staged');
});

test('finding 33: an item left running by a dead run is queued again and reported', async (t) => {
  const repo = makeGitRepo(t);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-on-'));
  t.after(() => fs.rmSync(baseDir, {recursive: true, force: true}));
  const queue = {version: 1, items: []};
  const item = overnightQ.addItem(queue, {prompt: 'stuck task', cwd: repo});
  item.status = 'running'; item.startedAt = Date.now() - 3600000;
  overnightQ.saveQueue(queue, {baseDir});
  let ran = 0;
  const report = await overnightR.runOvernight({baseDir, runner: async () => { ran++; return {ok: true, tokens: 1, questions: []}; }, statusesFn: async () => [], checkPower: () => null});
  assert.equal(ran, 1, 'the stuck item runs');
  assert.equal(report.recovered, 1);
  assert.equal(report.items[0].status, 'done');
  assert.ok(overnightR.formatReport(report).some(l => l.includes('待ちに戻しました')), 'the recovery is in the morning report');
});

test('finding 34: account allowance is re-read before each task, not once a night', async (t) => {
  const repo = makeGitRepo(t);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-on-'));
  t.after(() => fs.rmSync(baseDir, {recursive: true, force: true}));
  const queue = {version: 1, items: []};
  overnightQ.addItem(queue, {prompt: 'one', cwd: repo});
  overnightQ.addItem(queue, {prompt: 'two', cwd: repo});
  overnightQ.saveQueue(queue, {baseDir});
  let reads = 0;
  // Read 1 is the start-of-run reading (task one picks from it); the
  // re-read after task one reports accA nearly drained, so task two must
  // land on accB.
  const statusesFn = async () => { reads++; return reads <= 1
    ? [{id: 'accA', available: true, percentUsed: 10}, {id: 'accB', available: true, percentUsed: 20}]
    : [{id: 'accA', available: true, percentUsed: 90}, {id: 'accB', available: true, percentUsed: 20}]; };
  const used = [];
  await overnightR.runOvernight({baseDir, runner: async ({account}) => { used.push(account); return {ok: true, tokens: 1, questions: []}; }, statusesFn, checkPower: () => null});
  assert.deepEqual(used, ['accA', 'accB'], 'the second task follows the fresh reading');
});

test('finding 36: overnight branch names differ within the same minute', () => {
  const a = overnightW.branchNameFor('onabc123', new Date(2026, 10, 8, 23, 5, 10));
  const b = overnightW.branchNameFor('onabc123', new Date(2026, 10, 8, 23, 5, 55));
  assert.notEqual(a, b);
});

test('finding 26: a hung muser exec child times out in hunt and overnight runners', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-hang-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const hang = path.join(dir, 'hang.js');
  fs.writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
  const huntRun = hunt.execRunAgent({binFile: hang, cwd: dir, timeoutMs: 300});
  await assert.rejects(huntRun({prompt: 'x', kind: 'audit'}), /muser exec failed/);
  const nightRun = overnightR.makeExecRunner({binFile: hang, timeoutMs: 300});
  const r = await nightRun({item: {prompt: 'x'}, cwd: dir, account: null, mode: 'auto-edit'});
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('finding 37: the overnight estimate names the accounts even without an injected reader', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-on-'));
  t.after(() => fs.rmSync(baseDir, {recursive: true, force: true}));
  const queue = {version: 1, items: []};
  // Spec update (wave 11): addItem validates the folder WHEN QUEUING and
  // refuses anything that is not a git repository — baseDir here is a
  // plain temp folder, so it is refused at add time now. Reason: the
  // night should not discover at run time that a task can never start.
  // This finding is about the estimate, so queue against a real git
  // repo instead, which queues exactly as before.
  const repo = makeGitRepo(t);
  overnightQ.addItem(queue, {prompt: 'task', cwd: repo});
  overnightQ.saveQueue(queue, {baseDir});
  const orig = overnightR.defaultStatuses;
  overnightR.defaultStatuses = async () => [{id: 'accA', available: true, percentUsed: 10}];
  t.after(() => { overnightR.defaultStatuses = orig; });
  const settings = {numberValue: () => 0, overnightApproval: () => 'edit-auto', setOvernightApproval: () => {}};
  const {lines} = await overnightCli(['estimate'], {baseDir, settings});
  assert.ok(lines.some(l => l.includes('accA')), 'accounts appear in the estimate: ' + lines.join(' / '));
});

test('finding 18: lore sync keeps edits from other repositories out of this repo', (t) => {
  const repoA = makeGitRepo(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const events = [
    {v: 1, event: 'turn', at: '2026-11-08T01:00:00.000Z', session: 'c1', agent: 'main', text: 'a.txt を直して'},
    {v: 1, event: 'edit', at: '2026-11-08T01:01:00.000Z', session: 'c1', path: path.join(repoA, 'a.txt'), ranges: [{start: 1, end: 1}], added: 1, removed: 0, beforeHash: 'b1', afterHash: 'a1'},
    {v: 1, event: 'edit', at: '2026-11-08T01:02:00.000Z', session: 'c1', path: path.join(dir, 'repoB', 'b.js'), ranges: [{start: 1, end: 1}], added: 1, removed: 0, beforeHash: 'b2', afterHash: 'a2'},
    {v: 1, event: 'reply', at: '2026-11-08T01:03:00.000Z', session: 'c1', agent: 'main', text: 'a.txt を修正しました。'},
  ];
  fs.writeFileSync(path.join(dir, 'c1.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  lore.syncFromWorklog(repoA, {dir});
  const records = lore.readRecords(repoA);
  assert.ok(records.some(r => r.path === 'a.txt'), 'the local edit is recorded');
  assert.ok(records.every(r => !String(r.path).includes('repoB') && !path.isAbsolute(r.path)), 'no foreign or absolute path lands in the lore: ' + records.map(r => r.path).join(','));
});

test('finding 23: a scar needs an added named test or a created test file, not just a touched one', (t) => {
  const run = (testDiff) => {
    const repo = makeGitRepo(t);
    fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
    fs.mkdirSync(path.join(repo, 'tests'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\n');
    fs.writeFileSync(path.join(repo, 'tests', 'a.test.js'), '// t\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const events = [
      {v: 1, event: 'turn', at: '2026-11-08T02:00:00.000Z', session: 'c1', agent: 'main', text: 'a.js に機能を足して'},
      {v: 1, event: 'edit', at: '2026-11-08T02:01:00.000Z', session: 'c1', path: path.join(repo, 'src', 'a.js'), ranges: [{start: 1, end: 1}], added: 1, removed: 0, beforeHash: 'b1', afterHash: 'a1'},
      {v: 1, event: 'edit', at: '2026-11-08T02:02:00.000Z', session: 'c1', path: path.join(repo, 'tests', 'a.test.js'), ranges: [{start: 1, end: 1}], added: 1, removed: 0, beforeHash: 'b2', afterHash: 'a2', diff: testDiff},
      {v: 1, event: 'reply', at: '2026-11-08T02:03:00.000Z', session: 'c1', agent: 'main', text: 'a.js に機能を追加しました。'},
    ];
    fs.writeFileSync(path.join(dir, 'c1.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    lore.syncFromWorklog(repo, {dir});
    return lore.readRecords(repo).filter(r => r.kind === 'scar');
  };
  assert.equal(run('@@\n-  assert.equal(x, 1);\n+  assert.equal(x, 2);').length, 0, 'a feature turn that only adjusts an existing test leaves no scar');
  const scars = run("@@\n+test('境界で落ちない', () => {});");
  assert.equal(scars.length, 1, 'an added named regression test does leave a scar');
  assert.equal(scars[0].testName, '境界で落ちない');
});

test('finding 19: grave write-back detection scans past the first 60 lines', (t) => {
  const repo = makeGitRepo(t);
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\n');
  const block = Array.from({length: 12}, (_, i) => 'deletedLine' + (i + 1) + '();');
  lore.appendRecord(repo, {v: 1, kind: 'grave', id: 'grave-fdbg-19', at: '2026-11-08T03:00:00.000Z', path: 'src/a.js', start: 1, end: 12, deletedHash: null, deletedLines: 12, linesText: block, reason: '古い処理'});
  const padding = Array.from({length: 70}, (_, i) => 'filler' + i + '();');
  const hit = lore.graveResemblance(repo, 'src/a.js', [...padding, ...block].join('\n'));
  assert.ok(hit && hit.how === 'similar' && hit.score >= 0.7, 'a block written back at line 71+ is detected');
});

test('finding 17: forgotten lore stays forgotten across later syncs', (t) => {
  const repo = makeGitRepo(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const events = [
    {v: 1, event: 'turn', at: '2026-11-08T04:00:00.000Z', session: 'c1', agent: 'main', text: 'a.txt を直して'},
    {v: 1, event: 'edit', at: '2026-11-08T04:01:00.000Z', session: 'c1', path: path.join(repo, 'a.txt'), ranges: [{start: 1, end: 1}], added: 1, removed: 0, beforeHash: 'b1', afterHash: 'a1'},
    {v: 1, event: 'reply', at: '2026-11-08T04:02:00.000Z', session: 'c1', agent: 'main', text: 'a.txt を修正しました。'},
  ];
  fs.writeFileSync(path.join(dir, 'c1.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  lore.syncFromWorklog(repo, {dir});
  const before = lore.readRecords(repo).length;
  assert.ok(before >= 1, 'a record was derived');
  assert.equal(lore.forget(repo, {all: true}), before);
  assert.equal(lore.readRecords(repo).length, 0);
  const r = lore.syncFromWorklog(repo, {dir});
  assert.equal(r.added.length, 0, 'the sync does not resurrect what was forgotten');
  assert.equal(lore.readRecords(repo).length, 0);
});

test('finding 22: repoContext is memoized briefly, and share flips still apply at once', (t) => {
  const repo = makeGitRepo(t);
  const a = lore.repoContext(repo);
  assert.equal(lore.repoContext(repo), a, 'a repeat lookup reuses the context instead of spawning git again');
  assert.equal(lore.setShared(repo, true).shared, true);
  assert.equal(lore.repoContext(repo).shared, true, 'the flip is visible immediately, not only after the memo fades');
  assert.equal(lore.setShared(repo, false).shared, false);
});

test('finding 20: a patch\'s added lines feed the grave check for its own file', (t) => {
  const repo = makeGitRepo(t);
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\n');
  const block = Array.from({length: 12}, (_, i) => 'deletedLine' + (i + 1) + '();');
  lore.appendRecord(repo, {v: 1, kind: 'grave', id: 'grave-fdbg-20', at: '2026-11-08T05:00:00.000Z', path: 'src/a.js', start: 1, end: 12, deletedHash: lore.hashText(block.join('\n')), deletedLines: 12, linesText: block, reason: '古い処理'});
  const patch = ['*** Begin Patch', '*** Update File: src/a.js', '@@', ' keep();', ...block.map(l => '+' + l), '*** End Patch'].join('\n');
  const parts = lore.patchAdditions(patch);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].file, 'src/a.js');
  assert.ok(!parts[0].text.includes('keep();'), 'context lines are not new text');
  const hit = lore.graveResemblance(repo, parts[0].file, parts[0].text);
  assert.ok(hit && hit.how === 'hash', 'writing the deleted block back through a patch is caught');
});

test('finding 12: proof and expect read the same test counts from the same output', () => {
  const out = 'early summary pass 3 / fail 1\n...lots of output...\nfinal summary pass 128 / fail 0';
  assert.deepEqual(badge.parseTestCounts(out), {pass: 128, fail: 0}, 'the last summary wins, not the first');
  assert.deepEqual(badge.parseTestCounts(out), expectKit.testCounts(out), 'both judges agree');
});

test('finding 13: a file claim is backed by the same path, not a same-named file elsewhere', () => {
  const turn = {events: [], edits: [{path: 'lib/a.js'}], tools: []};
  assert.equal(badge.judge({kind: 'file', files: ['src/a.js']}, turn).mark, '✗', 'an edit to lib/a.js does not back a claim about src/a.js');
  const abs = {events: [], edits: [{path: 'C:\\repo\\src\\a.js'}], tools: []};
  assert.equal(badge.judge({kind: 'file', files: ['src/a.js']}, abs).mark, '✓', 'an absolute recorded path backs the relative claim');
  assert.equal(badge.judge({kind: 'file', files: ['a.js']}, turn).mark, '✓', 'a bare file name still matches wherever it lives');
});

test('finding 14: reading the latest version is not a test run (race + overnight badges)', (t) => {
  const readOnly = [
    {event: 'edit', path: 'src/a.js', _i: 0},
    {event: 'tool', command: 'code.read', summary: 'read the latest version of src/a.js', ok: true, _i: 1},
  ];
  assert.equal(race.proofBadge(readOnly).mark, '?', 'race: edits with no real test run stay unverified');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const write = (id, evts) => fs.writeFileSync(path.join(dir, id + '.jsonl'), evts.map(e => JSON.stringify(e)).join('\n') + '\n');
  write('n1', readOnly.map(({_i, ...e}) => e));
  assert.equal(overnightWL.summarizeWorklog('n1', {baseDir: dir}).badge, 'none', 'overnight: a read is not a passing test');
  write('n2', [{event: 'edit', path: 'src/a.js'}, {event: 'tool', command: 'system.run', summary: 'npm test', ok: true}]);
  assert.equal(overnightWL.summarizeWorklog('n2', {baseDir: dir}).badge, 'ok', 'overnight: a real npm test still counts');
});

test('finding 28: two races started in the same second get different ids', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0);
  const a = race.newRaceId(now), b = race.newRaceId(now);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('20261108-120000-'), 'the timestamp part stays readable: ' + a);
});

test('finding 29: a race that fails partway leaves no worktrees or state dir behind', async (t) => {
  const repo = makeGitRepo(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-race-'));
  t.after(() => fs.rmSync(stateDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(stateDir, 'wt-2'), 'occupied'); // the second worktree cannot be created here
  await assert.rejects(race.runRace({cwd: repo, task: 'x', n: 2, stateDir, checkCommands: [], runner: async () => ({ok: true, reply: 'ok'})}));
  assert.equal(fs.existsSync(stateDir), false, 'the state dir is cleaned up');
  assert.equal(gitIn(repo, ['worktree', 'list']).trim().split('\n').length, 1, 'no worktree registration is left behind');
});

test('finding 38: a function name is read from the real line-diff shape (no @@ header)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-crash-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'c1.jsonl');
  const ev = {v: 1, event: 'edit', at: '2026-11-08T06:00:00.000Z', session: 'c1', path: 'src/parse.js', ranges: [{start: 2, end: 2}], diff: ' function parse(s) {\n-  return s;\n+  return s.trim();\n }'};
  fs.writeFileSync(file, JSON.stringify(ev) + '\n');
  const edits = crashInv.readWorklogFile(file, 'c1');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].func, 'parse()');
});

test('finding 39: edits after the fall are not lined up as if they came before it', () => {
  const t0 = Date.parse('2026-11-08T06:00:00.000Z');
  const crashes = [{time: t0, app: 'x', kind: 'event'}];
  const edits = [{time: t0 - 1000, path: 'a.js'}, {time: t0 + 1000, path: 'b.js'}, {time: t0, path: 'c.js'}];
  crashInv.correlate(crashes, edits, 60000);
  assert.deepEqual(crashes[0].edits.map(e => e.path), ['a.js', 'c.js'], 'the edit 1s after the fall is excluded; at-and-before stays');
});

test('finding 40: parity hides any user name in a PATH entry, not only the current home\'s', () => {
  const parity = require('../src/parity');
  assert.equal(parity.sanitizePathEntry('C:\\Users\\someoneelse\\bin', 'D:\\home\\testuser'), '%USERPROFILE%\\bin');
  assert.equal(parity.sanitizePathEntry('C:\\Users\\testuser\\bin', 'D:\\home\\testuser'), '%USERPROFILE%\\bin', 'the other-drive case still holds');
  assert.equal(parity.sanitizePathEntry('C:\\Tools', 'D:\\home\\testuser'), 'C:\\Tools', 'non-profile entries are untouched');
});

test('finding 3: conversation ids map to distinct files and the mapping round-trips', (t) => {
  assert.notEqual(fileFor('a.b', 'D'), fileFor('ab', 'D'));
  assert.notEqual(fileFor('a_b', 'D'), fileFor('ab', 'D'));
  assert.notEqual(fileFor('a.b', 'D'), fileFor('a_b', 'D'));
  assert.ok(fileFor('sess-integ-1', 'D').endsWith('sess-integ-1.jsonl'), 'real session ids keep their historical file names');
  for (const id of ['a.b', 'a_b', 'ab', 'x/y', '..\\\\evil', '日本語']) assert.equal(decodeId(encodeId(id)), id, 'round-trip: ' + id);
  assert.ok(!/[\\/.]/.test(encodeId('../evil')), 'the encoded name cannot traverse: ' + encodeId('../evil'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const l1 = new Worklog({sessionId: 'a.b', dir}); l1.turn({text: 'one'}); l1.flush();
  const l2 = new Worklog({sessionId: 'ab', dir}); l2.turn({text: 'two'}); l2.flush();
  assert.equal(Worklog.read('a.b', dir).length, 1);
  assert.equal(Worklog.read('ab', dir).length, 1);
  assert.deepEqual(Worklog.list(dir).map(r => r.id).sort(), ['a.b', 'ab'], 'the list shows the real ids again');
  assert.equal(expectKit.appendWorklogEvent('a.b', {event: 'expect', matched: true}, {dir}), true);
  assert.equal(expectKit.readWorklogEvents('a.b', {dir}).length, 2, 'expect reads and writes the same file for an exotic id');
});

test('finding 4: prune counts only the blobs the surviving conversations still reference', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-wl-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const old = new Worklog({sessionId: 'old', dir});
  old.edit({file: 'a.js', before: 'x'.repeat(4000), after: 'y'});
  old.flush();
  const mid = new Worklog({sessionId: 'mid', dir});
  mid.turn({text: 'hello'}); mid.flush();
  const t0 = Date.now() - 10000;
  fs.utimesSync(fileFor('old', dir), new Date(t0), new Date(t0));
  fs.utimesSync(fileFor('mid', dir), new Date(t0 + 1000), new Date(t0 + 1000));
  // The tight-capped instance's first flush runs the prune under test.
  const own = new Worklog({sessionId: 'own', dir, maxTotalBytes: 1500});
  own.turn({text: 'mine'}); own.flush();
  assert.equal(fs.existsSync(fileFor('old', dir)), false, 'the oldest conversation goes first');
  assert.equal(fs.existsSync(fileFor('mid', dir)), true, 'once the freed blob stops counting, the next conversation survives');
  assert.equal(fs.existsSync(fileFor('own', dir)), true, 'the pruning session keeps its own file');
  assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 0, 'the freed blob is collected');
});

test('finding 2: a run that reads a sensitive file keeps none of its output in the work log', async (t) => {
  const {Agent} = require('../src/agent');
  const {EventEmitter} = require('node:events');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fdbg-agent-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  fs.writeFileSync(path.join(cwd, '.env'), 'PLAINWORDS=swordfish-plain-value\n');
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'ordinary-content-123\n');
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {}; c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  const sessionId = 'sess-fdbg-2';
  const a = new Agent({client: c, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd, session: {id: sessionId, cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'bypass'});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, log: {tools: [], steps: [], progress: []}};
  const r1 = await a.execute('system.run', {command: 'Get-Content .env'}, 60000, 'inv-fdbg-2a');
  assert.equal(r1.ok, true, 'the run itself works: ' + (r1.error || ''));
  const r2 = await a.execute('system.run', {command: 'Get-Content note.txt'}, 60000, 'inv-fdbg-2b');
  assert.equal(r2.ok, true, 'the control run works: ' + (r2.error || ''));
  a.worklogFor(a.main).flush();
  const events = Worklog.read(sessionId, path.join(process.env.LOCALAPPDATA, 'muser', 'worklog'));
  const tools = events.filter(e => e.event === 'tool' && e.command === 'system.run');
  assert.equal(tools.length, 2, 'both runs were recorded');
  assert.equal(tools[0].outWithheld, 'sensitive path', 'the .env run keeps no output');
  assert.ok(!JSON.stringify(events).includes('swordfish-plain-value'), 'the file content is nowhere in the log');
  assert.ok(String(tools[1].outHead || '').includes('ordinary-content-123'), 'an ordinary run still keeps its output');
});

test('finding 10: a 200-char (possibly truncated) summary is not used as the test command', () => {
  const long = 'npm test ' + 'x'.repeat(191); // exactly 200 chars, as the work log caps it
  assert.equal(long.length, 200);
  assert.equal(counter.testCommandFor({tools: [{command: 'system.run', summary: long}]}), null);
  assert.equal(counter.testCommandFor({tools: [{command: 'system.run', summary: 'npm test'}]}), 'npm test');
});
