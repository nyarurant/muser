'use strict';
// Audit-cli wave 10: regression tests for the wave-10 fixes (commits
// fe03ec7 / 4162bae and the race/skills/controller parts of the wave) —
//  (1) proof badge: test counts are read per clause, so in
//      『テスト128件通過し、失敗は0件』 the fail side no longer borrows
//      the pass side's 128; thousands separators (10,000) and fullwidth
//      digits read as numbers; a pass 0 / fail 0 run backs NOTHING (a
//      『全件通過』 claim against it is '?', never '✓'), while a
//      『0件通過』 claim against a run that DID fail is a contradiction
//      ('✗'); negated sentences (『作成していません』) are judged as
//      negations — a record of the denied change contradicts ('✗'),
//      no record backs ('✓').
//  (2) race: re-running under an already-used race ID is refused before
//      anything is created or deleted (an id-derived state dir counts by
//      existence, an explicit stateDir once it holds a result.json), and
//      a racer that failed can never be applied — only 'done' may.
//  (3) skills: a repeated frontmatter name/description key surfaces in
//      diagnostics() as 'duplicate-key' (the later value still wins),
//      and a skill with no description surfaces as 'missing-description'
//      — both are warnings about skills that DID load, not skips.
//  (4) controller: an edit made to a recalled history entry survives
//      moving away with ↑ and back with ↓ (the shell's per-entry draft);
//      the stored history itself is never rewritten by browsing.
// Isolation follows tests/audit-cli-w9.test.js: pin temp data/home
// folders before any src module loads. No commit, per the task.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');

process.env.MUSER_LANG = 'ja';
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w10-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w10-home-'));
test.after(() => { for (const d of [process.env.LOCALAPPDATA, process.env.USERPROFILE]) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });

function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}
const NL = String.fromCharCode(10);

// ---------- (1) proof badge ----------
const badge = require('../src/proof/badge');
const testRun = output => ({type: 'tool', command: 'system.run', summary: 'npm test', output});
// Judge a whole reply the way /proof does, against hand-made turn records
// (the direct-judge shape of tests/audit-cli-w8.test.js).
const proofOf = (reply, events, edits = []) =>
  badge.proofTurn({turn: 1, reply, events, edits, tools: events.filter(e => e.type === 'tool')});

test('w10 badge (1): 『テスト128件通過し、失敗は0件』 parses as {pass: 128, fail: 0} — no borrowing across the clause', () => {
  assert.deepEqual(badge.parseTestCounts('テスト128件通過し、失敗は0件'), {pass: 128, fail: 0},
    'the fail number comes from its own clause (『失敗は0件』), not from the 128 on the pass side');
  assert.deepEqual(badge.parseTestCounts('テスト 128 件通過し、失敗は 0 件'), {pass: 128, fail: 0}, 'the spaced spelling reads the same');
  assert.deepEqual(badge.parseTestCounts('テスト3件失敗し、128件通過しました'), {pass: 128, fail: 3}, 'the mirror order reads straight too');
  // End to end: the same sentence in a reply is backed by a matching run.
  // (The sentence also carries a no-error claim — 『失敗は0件』 — so judge
  // the test-kind row, not the row count.)
  const r = proofOf('テスト128件通過し、失敗は0件でした。', [testRun('pass 128' + NL + 'fail 0')]);
  const testRow = r.rows.find(row => row.kind === 'test');
  assert.ok(testRow, 'the sentence yields a test claim');
  assert.equal(testRow.mark, '✓', 'a run with exactly those counts backs the claim');
  const off = proofOf('テスト128件通過し、失敗は0件でした。', [testRun('pass 125' + NL + 'fail 3')]);
  assert.equal(off.rows.find(row => row.kind === 'test').mark, '✗', 'different counts contradict it (control)');
});

test('w10 badge (1): thousands separators and fullwidth digits read as one number', () => {
  assert.deepEqual(badge.parseTestCounts('テスト 10,000 件通過し、失敗は 0 件'), {pass: 10000, fail: 0},
    '"10,000" is one count, not 10 followed by a clause comma');
  assert.deepEqual(badge.parseTestCounts('pass 10,000 / fail 0'), {pass: 10000, fail: 0});
  assert.deepEqual(badge.parseTestCounts('テスト１２８件通過し、失敗は０件'), {pass: 128, fail: 0}, 'fullwidth digits read as halfwidth');
  assert.deepEqual(badge.parseTestCounts('テスト１０，０００件通過し、失敗は０件'), {pass: 10000, fail: 0},
    'fullwidth digits with a fullwidth thousands comma read as 10000');
  const r = proofOf('テスト１２８件通過し、失敗は０件でした。', [testRun('pass 128' + NL + 'fail 0')]);
  assert.equal(r.rows[0].mark, '✓', 'a fullwidth claim is backed by the halfwidth run it names');
});

test('w10 badge (1): pass 0 / fail 0 backs no 『全件通過』 — the claim is unjudged (?), never ✓', () => {
  const r = proofOf('テストは全件通過しました。', [testRun('pass 0' + NL + 'fail 0')]);
  assert.equal(r.rows.length, 1);
  assert.notEqual(r.rows[0].mark, '✓', 'no test ran at all, so "all passed" has nothing behind it');
  assert.equal(r.rows[0].mark, '?', 'a vacuous run leaves the claim unjudged, not contradicted');
  assert.match(r.rows[0].reason, /1件も実行されていません/);
  const real = proofOf('テストは全件通過しました。', [testRun('pass 5' + NL + 'fail 0')]);
  assert.equal(real.rows[0].mark, '✓', 'control: the same words against a run that did pass are backed');
});

test('w10 badge (1): a 『0件通過』 claim against a run with failures is a contradiction (✗)', () => {
  const r = proofOf('テスト 0件通過しました。', [testRun('pass 0' + NL + 'fail 3')]);
  assert.equal(r.rows[0].mark, '✗', 'the pass count matches (0) but the run failed 3: claiming a pass outcome contradicts it');
  const vacuous = proofOf('テスト 0件通過しました。', [testRun('pass 0' + NL + 'fail 0')]);
  assert.equal(vacuous.rows[0].mark, '?', 'control: against a run where nothing ran at all it is unjudged, not ✗');
});

test('w10 badge (1): 『作成していません』 is judged as a negation — record ✗, no record ✓', () => {
  const claims = badge.extractClaims('src/a.js は作成していません。');
  const file = claims.find(c => c.kind === 'file');
  assert.ok(file && file.negated === true, 'the 〜していません form extracts as a negated file claim: ' + JSON.stringify(claims));
  const denied = proofOf('src/a.js は作成していません。', [], [{path: 'src/a.js', op: 'create'}]);
  assert.equal(denied.rows[0].mark, '✗', 'a creation record for the very file contradicts the denial');
  assert.match(denied.rows[0].reason, /変更の記録があります/);
  const honest = proofOf('src/a.js は作成していません。', [], []);
  assert.equal(honest.rows[0].mark, '✓', 'with no record at all the denial is backed');
  assert.match(honest.rows[0].reason, /変更記録がありません/);
  const positive = proofOf('src/a.js を作成しました。', [], [{path: 'src/a.js', op: 'create'}]);
  assert.equal(positive.rows[0].mark, '✓', 'control: the positive claim is still backed by the same record');
});

test('w10 badge (1): a deletion denial is backed by a mere edit, contradicted only by a deletion record', () => {
  const mereEdit = proofOf('src/a.js は削除していません。', [], [{path: 'src/a.js', op: 'edit'}]);
  assert.equal(mereEdit.rows[0].mark, '✓', 'an edit is not a deletion: the denial stands');
  assert.match(mereEdit.rows[0].reason, /削除記録がありません/);
  const deleted = proofOf('src/a.js は削除していません。', [], [{path: 'src/a.js', op: 'delete'}]);
  assert.equal(deleted.rows[0].mark, '✗', 'a deletion record contradicts it');
});

// ---------- (2) race ----------
const race = require('../src/race');
function makeRepo(t) {
  const dir = tmpdir(t, 'muser-w10-race-repo-');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'w10@example.invalid');
  git('config', 'user.name', 'w10 test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base' + NL);
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}
const okRunner = async ({cwd}) => { fs.appendFileSync(path.join(cwd, 'a.txt'), 'racer' + NL); return {ok: true, reply: 'ok'}; };

test('w10 race (2): re-running under an already-used ID is refused and the first race is left intact', async t => {
  const repo = makeRepo(t);
  const first = await race.runRace({cwd: repo, task: 'x', n: 1, id: 'w10-fixed-id', checkCommands: [], runner: okRunner});
  t.after(() => race.cleanupRace(first).catch(() => {}));
  const dir = race.stateDirFor('w10-fixed-id');
  assert.equal(first.dir, dir);
  assert.ok(fs.existsSync(path.join(dir, 'result.json')), 'the first race recorded its state');
  await assert.rejects(
    race.runRace({cwd: repo, task: 'x', n: 1, id: 'w10-fixed-id', checkCommands: [], runner: okRunner}),
    /その競争の ID はすでに使われています/, 'the same ID may not start a second race');
  assert.ok(fs.existsSync(path.join(dir, 'result.json')), 'the refusal deleted nothing: the first race state survives');
  const loaded = race.loadRace('w10-fixed-id');
  assert.ok(loaded && loaded.status === 'finished' && loaded.racers.length === 1, 'the first race is still loadable as itself');
});

test('w10 race (2): an explicit stateDir holding a result.json is taken; a bare prepared folder is not', async t => {
  const repo = makeRepo(t);
  const taken = tmpdir(t, 'muser-w10-race-taken-');
  const record = JSON.stringify({id: 'someone-else', racers: []}) + NL;
  fs.writeFileSync(path.join(taken, 'result.json'), record);
  await assert.rejects(
    race.runRace({cwd: repo, task: 'x', n: 1, id: 'w10-explicit', stateDir: taken, checkCommands: [], runner: okRunner}),
    /すでに使われています/, 'a stateDir that already holds a race record refuses the run');
  assert.equal(fs.readFileSync(path.join(taken, 'result.json'), 'utf8'), record, 'the existing record is untouched');
  // Control: a bare folder the caller prepared as scratch is still usable.
  const bare = tmpdir(t, 'muser-w10-race-bare-');
  const result = await race.runRace({cwd: repo, task: 'x', n: 1, stateDir: bare, checkCommands: [], runner: okRunner});
  t.after(() => race.cleanupRace(result).catch(() => {}));
  assert.equal(result.status, 'finished', 'the bare prepared stateDir ran fine');
});

test('w10 race (2): a failed racer cannot be applied, even with a patch on disk', async t => {
  const dir = tmpdir(t, 'muser-w10-race-apply-');
  fs.writeFileSync(path.join(dir, 'racer-1.patch'), 'diff --git a/a.txt b/a.txt' + NL + '--- a/a.txt' + NL + '+++ b/a.txt' + NL + '@@ -1 +1 @@' + NL + '-base' + NL + '+half-done' + NL);
  const result = {dir, cwd: dir, racers: [{index: 1, status: 'failed', patchFile: 'racer-1.patch'}, {index: 2, status: 'done'}]};
  await assert.rejects(race.applyWinner(result, 1), /失敗したため、差分を当てられません/,
    'a failed racer\'s half-done patch is refused, not applied');
  assert.deepEqual(await race.applyWinner(result, 2), {ok: true, empty: true},
    'control: a done racer that changed nothing is still the genuine empty apply');
});

test('w10 race (2): a racer whose runner failed ends as failed and its work never reaches the user tree', async t => {
  const repo = makeRepo(t);
  const stateDir = path.join(tmpdir(t, 'muser-w10-race-fail-'), 'r1');
  const result = await race.runRace({cwd: repo, task: 'x', n: 1, stateDir, checkCommands: [],
    runner: async ({cwd}) => { fs.appendFileSync(path.join(cwd, 'a.txt'), 'half-done' + NL); return {ok: false, error: 'boom w10'}; }});
  t.after(() => race.cleanupRace(result).catch(() => {}));
  assert.equal(result.racers[0].status, 'failed');
  assert.ok(result.racers[0].patchFile, 'the failed racer did leave a patch behind — the guard is what stops it');
  await assert.rejects(race.applyWinner(result, 1), /失敗したため/);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'base' + NL, 'the user tree was not touched');
});

// ---------- (3) skills ----------
const skills = require('../src/skills');
// The skills.test.js sandbox: a scratch home + project per test (saved
// env here is this file's pinned temp home, restored afterwards).
function skillSandbox(t) {
  const root = tmpdir(t, 'muser-w10-skills-');
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const saved = {USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME};
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { process.env.USERPROFILE = saved.USERPROFILE; process.env.HOME = saved.HOME; });
  const put = (name, md) => {
    const d = path.join(proj, '.muser', 'skills', name);
    fs.mkdirSync(d, {recursive: true});
    fs.writeFileSync(path.join(d, 'SKILL.md'), md);
  };
  return {home, proj, put};
}

test('w10 skills (3): frontmatter() reports repeated name/description keys; the later value wins', () => {
  const fm = skills.frontmatter('---' + NL + 'name: first' + NL + 'name: second' + NL + 'description: one' + NL + 'description: two' + NL + '---' + NL + 'body' + NL);
  assert.deepEqual([...fm.duplicates].sort(), ['description', 'name'], 'both repeated keys are reported');
  assert.equal(fm.meta.name, 'second', 'the later name wins, as before');
  assert.equal(fm.meta.description, 'two', 'the later description wins, as before');
  assert.deepEqual(skills.frontmatter('---' + NL + 'name: a' + NL + 'description: d' + NL + '---' + NL + 'body').duplicates, [],
    'control: no repetition, no report');
  assert.deepEqual(skills.frontmatter('---' + NL + 'name: a' + NL + 'description: d' + NL + 'other: 1' + NL + 'other: 2' + NL + '---' + NL + 'body').duplicates, [],
    'only name/description repetitions are tracked (another tool may read those two differently)');
});

test('w10 skills (3): load() surfaces a duplicate key in diagnostics() and the skill still loads', t => {
  const {proj, put} = skillSandbox(t);
  put('dupdesc', '---' + NL + 'name: dupdesc' + NL + 'description: first desc' + NL + 'description: second desc' + NL + '---' + NL + 'body' + NL);
  put('dupname', '---' + NL + 'name: dupname' + NL + 'name: dupname' + NL + 'description: has desc' + NL + '---' + NL + 'body' + NL);
  const all = skills.load(proj);
  const dup = all.find(s => s.name === 'dupdesc');
  assert.ok(dup, 'a skill with a repeated key still loads — the diagnostic is a warning, not a skip');
  assert.equal(dup.description, 'second desc', 'the later description is the one in effect');
  const diag = skills.diagnostics();
  const dd = diag.find(d => d.reason === 'duplicate-key' && d.name === 'dupdesc');
  assert.ok(dd && dd.key === 'description', 'the repeated description key is diagnosed: ' + JSON.stringify(diag));
  const dn = diag.find(d => d.reason === 'duplicate-key' && d.name === 'dupname');
  assert.ok(dn && dn.key === 'name', 'the repeated name key is diagnosed too');
  assert.ok(!skills.preambleLines(proj).join(NL).includes('(skipped) dupdesc'),
    'a warned-about skill is not listed as skipped in the preamble');
});

test('w10 skills (3): a skill with no description surfaces as missing-description and still loads', t => {
  const {proj, put} = skillSandbox(t);
  put('nodesc', '---' + NL + 'name: nodesc' + NL + '---' + NL + 'body' + NL);
  put('emptydesc', '---' + NL + 'name: emptydesc' + NL + 'description:' + NL + '---' + NL + 'body' + NL);
  put('hasdesc', '---' + NL + 'name: hasdesc' + NL + 'description: explained' + NL + '---' + NL + 'body' + NL);
  const all = skills.load(proj);
  const nd = all.find(s => s.name === 'nodesc');
  assert.ok(nd && nd.description === '', 'the undescribed skill still loads, with an empty description');
  const diag = skills.diagnostics();
  assert.ok(diag.some(d => d.reason === 'missing-description' && d.name === 'nodesc'), 'the missing description is diagnosed: ' + JSON.stringify(diag));
  assert.ok(diag.some(d => d.reason === 'missing-description' && d.name === 'emptydesc'), 'an empty description counts as missing too');
  assert.ok(!diag.some(d => d.reason === 'missing-description' && d.name === 'hasdesc'), 'control: a described skill gets no such warning');
});

// ---------- (4) controller: history edits survive ↑/↓ browsing ----------
class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';
async function makeCtrl(t) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(tmpdir(t, 'muser-w10-ctrl-')), museName: 'm', version: 't', onExit() {}});
  ctrl.history = []; ctrl.hIndex = -1; ctrl.draft = ''; ctrl.histEdits = {};
  t.after(() => { try { clearTimeout(ctrl.flashTimer); clearTimeout(ctrl.promptFlashTimer); } catch {} });
  return ctrl;
}
const up = ctrl => ctrl.key('', {upArrow: true});
const down = ctrl => ctrl.key('', {downArrow: true});

test('w10 controller (4): an edit to a recalled entry survives ↑ away and ↓ back; stored history is untouched', async t => {
  const ctrl = await makeCtrl(t);
  ctrl.history = ['alpha one', 'beta two'];
  up(ctrl);
  assert.equal(ctrl.get().text, 'beta two', '↑ recalls the newest entry');
  assert.equal(ctrl.hIndex, 1);
  ctrl.insert(' edited');
  assert.equal(ctrl.get().text, 'beta two edited');
  up(ctrl);
  assert.equal(ctrl.get().text, 'alpha one', '↑ moves to the older entry');
  ctrl.insert(' plus');
  down(ctrl);
  assert.equal(ctrl.get().text, 'beta two edited', '↓ back: the newer entry kept its edit');
  up(ctrl);
  assert.equal(ctrl.get().text, 'alpha one plus', '↑ again: the older entry kept its edit too');
  down(ctrl); down(ctrl);
  assert.equal(ctrl.hIndex, -1, '↓ past the newest returns to the draft');
  assert.equal(ctrl.get().text, '', 'the (empty) draft is restored');
  up(ctrl);
  assert.equal(ctrl.get().text, 'beta two edited', 'the edit survives even a round trip through the draft');
  assert.deepEqual(ctrl.history, ['alpha one', 'beta two'], 'browsing never rewrites the stored history');
});

test('w10 controller (4): the in-progress draft is kept while a recalled entry is edited', async t => {
  const ctrl = await makeCtrl(t);
  ctrl.history = ['only entry'];
  ctrl.setText('my draft');
  up(ctrl);
  assert.equal(ctrl.get().text, 'only entry', '↑ recalls over the draft');
  ctrl.insert(' v2');
  down(ctrl);
  assert.equal(ctrl.get().text, 'my draft', '↓ past the newest gives the draft back verbatim');
  up(ctrl);
  assert.equal(ctrl.get().text, 'only entry v2', 'and the edit is still there on the way back up');
});

test('w10 controller (4): an edit to a recalled multi-line entry survives leaving it from its first line', async t => {
  const ctrl = await makeCtrl(t);
  ctrl.history = ['older one', 'first line' + NL + 'second line'];
  up(ctrl);
  assert.equal(ctrl.get().text, 'first line' + NL + 'second line');
  ctrl.setText('first line' + NL + 'second line EDITED', 0); // caret on the first line
  up(ctrl);
  assert.equal(ctrl.get().text, 'older one', '↑ on the first line keeps browsing history (wave-8 rule)');
  down(ctrl);
  assert.equal(ctrl.get().text, 'first line' + NL + 'second line EDITED', 'the multi-line edit was kept');
  assert.deepEqual(ctrl.history, ['older one', 'first line' + NL + 'second line'], 'stored history untouched');
});
