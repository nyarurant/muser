'use strict';
// Bug hunt (design §6) with a fake Muse: no real model is ever called.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hunt = require('../src/hunt');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-hunt-test-'));
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, text, 'utf8'); return f; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------- worklog ----
test('worklog: premise shape — dir, blobs, retention constants', () => {
  assert.equal(hunt.WORKLOG_RETENTION_DAYS, 30);
  assert.equal(hunt.WORKLOG_MAX_BYTES, 500 * 1024 * 1024);
  const base = tmp();
  assert.equal(hunt.worklogDir(base), path.join(base, 'muser', 'worklog'));
  assert.equal(hunt.blobFile(base, 'abc123'), path.join(base, 'muser', 'worklog', 'blobs', 'abc123'));
});

test('worklog: parses a sample file, skips broken lines, newest first', () => {
  const base = tmp(), dir = hunt.worklogDir(base);
  fs.mkdirSync(dir, {recursive: true});
  write(dir, 'conv-a.jsonl', [
    JSON.stringify({v: 1, event: 'turn', at: '2026-11-07T10:00:00', session: 'conv-a', text: '直して', agent: 'main'}),
    JSON.stringify({v: 1, event: 'edit', at: '2026-11-07T10:01:00', session: 'conv-a', path: 'src/a.js', beforeHash: 'h1', afterHash: 'h2'}),
    'this is not json',
    JSON.stringify({type: 'edit', at: '2026-11-07T10:02:00', file: 'src\\a.js', agent: 'a1'}), // a legacy spelling still reads
    JSON.stringify({v: 1, event: 'edit', at: '2026-11-07T10:03:00', session: 'conv-a', path: 'src/b.js'}),
    JSON.stringify({v: 1, event: 'reply', at: '2026-11-07T10:04:00', session: 'conv-a', text: 'done', agent: 'main'}),
  ].join('\n') + '\n');
  const got = hunt.readWorklog(dir);
  assert.equal(got.id, 'conv-a');
  assert.equal(got.events.length, 5);
  const edited = hunt.editedFiles(got.events);
  assert.equal(edited.get('src/a.js').count, 2, 'the real event/path spelling and the legacy type/file spelling both read');
  assert.deepEqual([...edited.get('src/a.js').agents].sort(), ['a1']); // only the legacy line names an agent; real edit events carry none
  assert.equal(edited.get('src/b.js').count, 1);
  assert.equal(hunt.readWorklog(path.join(base, 'nope')), null);
});

test('worklog: sensitive paths never surface as edited files', () => {
  const events = [{event: 'edit', path: '.env', at: '2026-11-07T10:00:00'}, {event: 'edit', path: 'src/ok.js', at: '2026-11-07T10:00:00'}];
  const edited = hunt.editedFiles(events);
  assert.equal(edited.has('.env'), false);
  assert.equal(edited.has('src/ok.js'), true);
});

// --------------------------------------------------------------- scope ----
function fixture() {
  const root = tmp();
  write(root, 'src/a.js', 'module.exports = 1;\n');
  write(root, 'src/b.js', 'module.exports = 2;\n');
  write(root, 'src/sub/c.js', 'module.exports = 3;\n');
  write(root, 'lib/d.py', 'x = 1\n');
  write(root, 'README.txt', 'not code\n');
  write(root, 'node_modules/pkg/e.js', 'module.exports = 5;\n');
  return root;
}
test('scope: collectFiles takes code only, skips node_modules and .muser', () => {
  const root = fixture();
  write(root, '.muser/hunt/x/f.js', 'x\n');
  assert.deepEqual(hunt.collectFiles(root), ['lib/d.py', 'src/a.js', 'src/b.js', 'src/sub/c.js']);
  assert.deepEqual(hunt.collectFiles(root, 'src'), ['src/a.js', 'src/b.js', 'src/sub/c.js']);
  assert.deepEqual(hunt.collectFiles(root, ['src/a.js', 'lib']), ['lib/d.py', 'src/a.js']);
});
test('scope: groups are disjoint, bounded, and machine-checked', () => {
  const files = hunt.collectFiles(fixture());
  const groups = hunt.makeGroups(files, 2);
  assert.ok(groups.length <= 2);
  assert.deepEqual(groups.flat().sort(), files);
  hunt.checkDisjoint(groups);
  assert.throws(() => hunt.checkDisjoint([['a.js'], ['a.js']]), /重なっています/);
  assert.equal(hunt.isTestFile('tests/x.test.js'), true);
  assert.equal(hunt.isTestFile('src/test/util.js'), true);
  assert.equal(hunt.isTestFile('src/a.js'), false);
});

// ------------------------------------------------------------ findings ----
test('findings: parses fenced and bare JSON lines, ignores prose', () => {
  const text = ['監査しました。', '```json',
    '{"severity":"high","file":"src/a.js","line":3,"summary":"null チェック漏れ","repro":"x を渡す"}',
    '{"severity":"None","file":"","summary":"問題なし"}', '```',
    '{"severity":"Critical","file":"src/b.js","summary":"注入"}',
    '{"severity":"Bogus","summary":"拾わない"}', 'ただの文 {"severity":"High"}'].join('\n');
  const got = hunt.parseFindings(text, 'h1');
  assert.equal(got.length, 3);
  assert.equal(got[0].severity, 'High');
  assert.equal(got[0].agent, 'h1');
  assert.deepEqual(hunt.countBySeverity(got), {Critical: 1, High: 1, Medium: 0, None: 1, total: 3});
  assert.equal(hunt.atLeast(got[0], 'High'), true);
  assert.equal(hunt.atLeast(got[0], 'Critical'), false);
  assert.equal(hunt.normSeverity('medium'), 'Medium');
  assert.equal(hunt.normSeverity('x'), null);
});

// --------------------------------------------------------------- audit ----
test('audit: fake agents, concurrency cap, results saved per agent', async () => {
  const root = fixture();
  const prepared = hunt.prepareAudit({cwd: root, agents: 3});
  assert.equal(prepared.estimate.agents, 3);
  assert.equal(prepared.estimate.files, 4);
  let active = 0, maxActive = 0, calls = 0;
  const runAgent = async ({files}) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await sleep(25);
    active--;
    const f = files[0];
    return '所見です。\n```json\n' + JSON.stringify({severity: 'High', file: f, line: 1, summary: f + ' の問題', repro: '再現する'}) + '\n```';
  };
  const state = await hunt.runAudit(prepared, {runAgent, maxConcurrent: 2, now: new Date(2026, 10, 7, 12, 0, 0)});
  assert.equal(calls, 3);
  assert.ok(maxActive <= 2, 'concurrency cap holds: ' + maxActive);
  assert.equal(state.phase, 'audit-done');
  assert.equal(state.findings.length, 3);
  const dir = state.dir;
  assert.match(dir.replace(/\\/g, '/'), /\.muser\/hunt\/20261107-120000$/);
  const saved = fs.readFileSync(path.join(dir, 'findings.jsonl'), 'utf8').trim().split('\n');
  assert.equal(saved.length, 3);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /バグ狩り 報告/);
  assert.match(fs.readFileSync(path.join(dir, 'agent-h1.md'), 'utf8'), /担当 h1/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).phase, 'audit-done');
  const status = hunt.readStatus(root);
  assert.equal(status.findings.length, 3);
  assert.match(hunt.formatStatusLines(status).join('\n'), /所見 3 件/);
  assert.match(hunt.formatEstimateLines(prepared.estimate)[0], /エージェント 3 体/);
});

test('audit: quota exhaustion stops new launches, the rest is skipped', async () => {
  const root = fixture();
  const prepared = hunt.prepareAudit({cwd: root, agents: 3});
  let calls = 0;
  const state = await hunt.runAudit(prepared, {
    runAgent: async () => { calls++; return '{"severity":"None","summary":"なし"}'; },
    quota: async () => ({exhausted: true, percentUsed: 100}),
    maxConcurrent: 1, now: new Date(2026, 10, 7, 13, 0, 0),
  });
  assert.equal(calls, 0);
  assert.equal(state.phase, 'quota-stopped');
  assert.ok(state.groups.every(g => g.status === 'skipped'));
});

test('audit: worklog-hot files are dealt first', () => {
  const root = fixture();
  const base = tmp(), dir = hunt.worklogDir(base);
  fs.mkdirSync(dir, {recursive: true});
  write(dir, 'conv-z.jsonl', JSON.stringify({v: 1, event: 'edit', at: '2026-11-07T09:00:00', session: 'conv-z', path: 'src/b.js'}) + '\n');
  const prepared = hunt.prepareAudit({cwd: root, agents: 2, worklogBase: base});
  assert.deepEqual(prepared.hotFiles, ['src/b.js']);
  assert.equal(prepared.files[0], 'src/b.js');
});

test('audit: a failing agent is recorded, the hunt still completes', async () => {
  const root = fixture();
  const prepared = hunt.prepareAudit({cwd: root, agents: 2});
  const state = await hunt.runAudit(prepared, {
    runAgent: async ({tag}) => { if (tag === 'h1') throw new Error('boom'); return '{"severity":"Medium","file":"src/a.js","summary":"軽微"}'; },
    now: new Date(2026, 10, 7, 14, 0, 0),
  });
  assert.equal(state.phase, 'audit-done');
  assert.equal(state.groups.find(g => g.tag === 'h1').status, 'failed');
  assert.equal(state.findings.length, 1);
});

// ----------------------------------------------------------------- fix ----
function fixFixture() {
  const root = tmp();
  write(root, 'src/calc.js', 'function add(a, b) { return a - b; }\nmodule.exports = {add};\n');
  const dir = path.join(root, '.muser', 'hunt', '20261107-120000');
  fs.mkdirSync(dir, {recursive: true});
  const finding = {severity: 'High', file: 'src/calc.js', line: 1, summary: 'add が引き算になっている', repro: 'add(1,2) が -1', agent: 'h1'};
  fs.writeFileSync(path.join(dir, 'findings.jsonl'), JSON.stringify(finding) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({version: 1, cwd: root, phase: 'audit-done', groups: [], findings: [finding]}), 'utf8');
  return {root, dir, finding};
}
const TEST_BODY = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst {add} = require('../src/calc.js');\ntest('add', () => { assert.equal(add(1, 2), 3); });\n";

test('fix: a fix counts only when the counter-proof passes', async () => {
  const {root, dir} = fixFixture();
  const prepared = hunt.prepareFix({cwd: root, level: 'High', dir});
  assert.equal(prepared.targets.length, 1);
  const runAgent = async () => {
    write(root, 'src/calc.js', 'function add(a, b) { return a + b; }\nmodule.exports = {add};\n');
    write(root, 'tests/calc.test.js', TEST_BODY);
    return '```json\n' + JSON.stringify({summary: 'add が引き算になっている', reproduced: true, fixed: true, testFile: 'tests/calc.test.js'}) + '\n```';
  };
  const r = await hunt.runFix(prepared, {runAgent});
  assert.equal(r.summary.fixed, 1);
  assert.equal(r.outcomes[0].status, 'fixed');
  assert.match(fs.readFileSync(path.join(root, 'src/calc.js'), 'utf8'), /a \+ b/, 'the fix itself is restored after the counter-proof');
  assert.match(fs.readFileSync(path.join(dir, 'fix-report.md'), 'utf8'), /直した（1）/);
  assert.deepEqual(r.changedFiles.sort(), ['src/calc.js', 'tests/calc.test.js']);
});

test('fix: a test that passes without the fix does not count', async () => {
  const {root, dir} = fixFixture();
  const prepared = hunt.prepareFix({cwd: root, level: 'High', dir});
  const runAgent = async () => {
    write(root, 'src/calc.js', 'function add(a, b) { return a + b; }\nmodule.exports = {add};\n');
    write(root, 'tests/calc.test.js', "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\ntest('unrelated', () => { assert.equal(1, 1); });\n");
    return '```json\n' + JSON.stringify({summary: 'add が引き算になっている', reproduced: true, fixed: true, testFile: 'tests/calc.test.js'}) + '\n```';
  };
  const r = await hunt.runFix(prepared, {runAgent});
  assert.equal(r.summary.fixed, 0);
  assert.equal(r.outcomes[0].status, 'unproven');
  assert.equal(r.summary.unverified, 1);
  assert.match(fs.readFileSync(path.join(root, 'src/calc.js'), 'utf8'), /a \+ b/, 'even an unproven fix is left in place, just not counted');
});

test('fix: not-reproduced and below-level findings are reported apart', async () => {
  const {root, dir, finding} = fixFixture();
  fs.appendFileSync(path.join(dir, 'findings.jsonl'), JSON.stringify({severity: 'Medium', file: 'src/calc.js', summary: '中程度の所見', repro: '', agent: 'h1'}) + '\n', 'utf8');
  const prepared = hunt.prepareFix({cwd: root, level: 'High', dir});
  assert.equal(prepared.deferred, 1, 'the Medium finding is deferred at level High');
  const r = await hunt.runFix(prepared, {runAgent: async () => '```json\n' + JSON.stringify({summary: finding.summary, reproduced: false, fixed: false}) + '\n```'});
  assert.equal(r.outcomes[0].status, 'not-reproduced');
  assert.equal(r.summary.notReproduced, 1);
  const lines = hunt.formatFixSummaryLines(r.summary);
  assert.match(lines[0], /再現しなかった 1 件/);
  assert.match(lines[0], /後回し 1 件/);
});

test('fix: prepareFix without a hunt result says so', () => {
  assert.throws(() => hunt.prepareFix({cwd: tmp(), level: 'High'}), /結果がありません/);
});

test('adapters: exec runner and quota guard are functions (never invoked here)', () => {
  assert.equal(typeof hunt.execRunAgent({cwd: tmp()}), 'function');
  assert.equal(typeof hunt.makeDefaultQuota(), 'function');
});

test('collectFiles includes Kotlin and XAML (an Android or WPF project is not empty to the hunt)', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-exts-'));
  try {
    for (const f of ['Main.kt', 'build.gradle.kts', 'View.xaml', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x');
    const H = require('../src/hunt.js');
    const files = H.collectFiles(dir, '.').map(f => path.basename(f)).sort();
    assert.deepEqual(files, ['Main.kt', 'View.xaml', 'build.gradle.kts']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
