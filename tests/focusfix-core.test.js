'use strict';
// Regression tests for the 2026-11-04 Focus audit fixes that live in src/focus.js
// (manual-confirmation expiry and gating, failed re-runs, executor refusals, path
// and cwd normalisation, background completion, round/endRound state edges).
const test = require('node:test');
const assert = require('node:assert/strict');
const {Focus} = require('../src/focus');

const insp = [{text: 'Source satisfies the requested behavior', kind: 'inspection'}];
const read = p => ({command: 'code.read', kind: 'read', params: {path: p}, summary: p});
const edit = p => ({command: 'code.edit', kind: 'edit', params: {path: p}, summary: p});
const run = (cmd, extra = {}) => ({command: 'system.run', kind: 'exec', params: {command: cmd, ...extra}, summary: cmd});
const exit = code => ({ok: true, payload: {exit_code: code}});
const met = (id, evidence = []) => ({id, status: 'met', evidence, reason: 'observed'});
const bgOut = (id, code) => ({command: 'shell.output', kind: 'read', params: {shell_id: id}, summary: id});
const bgResult = (id, code) => ({ok: true, payload: {id, running: false, exit_code: code, backgroundResult: {id, running: false, exit_code: code}}});

test('fix 2: a manual criterion needs a prior unknown/blocked stop, even in a user-started leg', () => {
  const fresh = new Focus('New task'); fresh.beginRound();
  fresh.plan([{text: 'Looks right on the device', kind: 'manual'}]);
  fresh.resumeLeg('confirmed!'); fresh.beginRound(); // user-started leg, but the task never stopped to ask
  assert.throws(() => fresh.checkpoint([met('c1')]), /user confirmation/);
  const f = new Focus('Check the headset'); f.beginRound();
  f.plan([{text: 'Visible in the headset', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unknown', reason: 'please check'}]);
  assert.equal(f.criteria[0].awaitingConfirm, true, 'the unknown report arms the confirmation');
  assert.equal(f.endRound().status, 'needs_input');
  f.resumeLeg('見えたよ'); f.beginRound();
  f.checkpoint([met('c1')]);
  assert.equal(f.criteria[0].status, 'met');
  assert.equal(f.criteria[0].awaitingConfirm, false, 'the confirmation is consumed');
  assert.equal(f.endRound().status, 'complete');
});

test('fix 1: a confirmed manual met expires on the next change after confirmation', () => {
  const f = new Focus('Check the headset'); f.beginRound();
  f.plan([{text: 'Visible in the headset', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unknown', reason: 'please check'}]); f.endRound();
  f.resumeLeg('見えたよ'); f.beginRound();
  f.checkpoint([met('c1')]);
  assert.equal(f.criteria[0].status, 'met');
  f.observe(edit('a.js'), {ok: true}); // the work changed after the user confirmed
  assert.equal(f.criteria[0].status, 'pending', 'manual met carries no evidence, so expiry is by confirmed revision');
  assert.match(f.criteria[0].reason, /確認のあとで変更がありました/);
});

test('fix 3: a failed re-run invalidates the earlier pass of a pending command criterion, targeted at that command', () => {
  // A read-only declared command ('git status'), so the generic change machinery
  // stays out of the way and only the failed-command change can expire the pass.
  const f = new Focus('Tests'); f.beginRound();
  f.plan([{text: 'Tree is clean', kind: 'command', command: 'git status'}, {text: 'Source ok', kind: 'inspection'}]);
  const pass = f.observe(run('git status'), exit(0));
  const proof = f.observe(read('probe.txt'), {ok: true});
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'not yet'}, {id: 'c2', status: 'unmet', reason: 'not yet'}]);
  f.observe(run('git status'), exit(1)); // the re-run failed: the old pass must stop being citable
  assert.equal(f.evidenceCurrent(f.evidence.find(e => e.id === pass)), false);
  assert.equal(f.evidenceCurrent(f.evidence.find(e => e.id === proof)), true, 'other evidence is untouched by the targeted change');
  assert.throws(() => f.checkpoint([met('c1', [pass]), {id: 'c2', status: 'unmet', reason: 'x'}]), /out of date/);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'still failing'}, met('c2', [proof])]);
});

test('fix 4: a declined re-run does not reset a met command criterion', () => {
  const f = new Focus('Tests'); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}]);
  const pass = f.observe(run('npm test'), exit(0));
  f.checkpoint([met('c1', [pass])]);
  f.observe({...run('npm test'), declined: true}, {ok: false}); // nothing ran
  assert.equal(f.criteria[0].status, 'met');
});

test('fix 5: executor-level failures (no payload) do not expire evidence; apply_patch is the exception', () => {
  const f = new Focus('Verify'); f.beginRound(); f.plan(insp);
  const proof = f.observe(read('probe.txt'), {ok: true});
  f.checkpoint([met('c1', [proof])]);
  const rev = f.revision;
  f.observe(edit('probe.txt'), {ok: false, payload: null}); // refused before executing: old_string not found etc.
  assert.equal(f.revision, rev, 'no revision bump for a call that never ran');
  assert.equal(f.criteria[0].status, 'met');
  f.observe({command: 'code.apply_patch', kind: 'edit', params: {}, summary: 'patch'}, {ok: false, payload: null});
  assert.equal(f.criteria[0].status, 'pending', 'a patch can partially apply before throwing, so its failure still expires');
});

test('fix 6: evidence scoped to "." expires on any change; a glob pattern\'s static root scopes its evidence', () => {
  const f = new Focus('Verify'); f.beginRound(); f.plan(insp);
  const root = f.observe(read('.'), {ok: true});
  f.observe(edit('src/foo.js'), {ok: true});
  assert.equal(f.evidenceCurrent(f.evidence.find(e => e.id === root)), false, '"." names the session root and overlaps everything');
  const g = new Focus('Verify'); g.beginRound(); g.plan(insp);
  const listing = g.observe({command: 'code.glob', kind: 'search', params: {pattern: 'tests/**'}, summary: 'tests/**'}, {ok: true});
  const ev = g.evidence.find(e => e.id === listing);
  assert.ok(ev.paths.includes('tests'), 'the pattern static root is part of the observed paths');
  g.observe(edit('src/foo.js'), {ok: true});
  assert.equal(g.evidenceCurrent(ev), true, 'an unrelated edit leaves the listing current');
  g.observe(edit('tests/a.test.js'), {ok: true});
  assert.equal(g.evidenceCurrent(ev), false, 'an edit inside the glob root expires it');
});

test('fix 7+8: background completion records one change, dates its evidence there, and the map is shared and capped', () => {
  const shared = new Map();
  const f = new Focus('Publish', {sharedBackground: shared}); f.beginRound();
  f.plan([{text: 'Publishes', kind: 'command', command: 'dotnet publish'}]);
  const before = f.observe(run('git status'), exit(0)); // pathless evidence from before the completion
  f.observe(run('dotnet publish'), {ok: true, payload: {shell_id: 'bg1'}});
  const done = f.observe(bgOut('bg1'), bgResult('bg1', 0));
  assert.equal(f.evidenceCurrent(f.evidence.find(e => e.id === before)), false, 'pre-completion evidence expires on the completion');
  assert.equal(f.evidenceCurrent(f.evidence.find(e => e.id === done)), true, 'the completion evidence is at the new revision');
  const rev = f.revision;
  f.observe(bgOut('bg1'), bgResult('bg1', 0));
  assert.equal(f.revision, rev, 'the completion change is recorded only once per background run');
  f.checkpoint([met('c1', [done])]);
  assert.equal(f.endRound().status, 'complete');
  // Shared across Focus instances: started under f, collected under another Focus.
  const other = new Focus('Other', {sharedBackground: shared});
  assert.equal(other.background, f.background);
  f.observe(run('dotnet publish'), {ok: true, payload: {shell_id: 'bgX'}});
  const collected = other.observe(bgOut('bgX'), bgResult('bgX', 0));
  assert.equal(other.evidence.find(e => e.id === collected).verificationCommand, 'dotnet publish');
  for (let i = 0; i < 60; i++) f.observe(run('cmd' + i), {ok: true, payload: {shell_id: 'cap' + i}});
  // audit-cli wave2 D4: entries whose completion has not been collected yet
  // are never evicted (evicting one made its command evidence unusable
  // forever); only collected entries leave first, so the map may exceed 50
  // while runs are outstanding.
  assert.ok(f.background.has('cap0'), 'an uncollected running entry is kept past the cap');
  assert.ok(f.background.size > 50, 'uncollected entries are held even beyond the old cap');
});

test('fix 3 (bg): a background run finishing with failure invalidates its earlier pass', () => {
  const f = new Focus('Tests'); f.beginRound();
  f.plan([{text: 'Tree is clean', kind: 'command', command: 'git status'}]);
  const pass = f.observe(run('git status'), exit(0));
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'not yet'}]);
  f.observe(run('git status'), {ok: true, payload: {shell_id: 'bg2'}});
  f.observe(bgOut('bg2'), bgResult('bg2', 1));
  assert.equal(f.evidenceCurrent(f.evidence.find(e => e.id === pass)), false);
});

test('fix 9: cwd spellings of the same folder match; a mismatch is named in the checkpoint error', () => {
  const home = 'C:\\Users\\nyaru';
  const f = new Focus('Tests', {sessionCwd: home}); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test', cwd: 'muser'}]);
  const pass = f.observe(run('npm test', {cwd: 'C:\\Users\\nyaru\\muser'}), exit(0));
  f.checkpoint([met('c1', [pass])]); // relative criterion cwd == absolute run cwd under sessionCwd
  const repo = new Focus('Tests', {sessionCwd: 'C:\\Users\\nyaru\\muser'}); repo.beginRound();
  repo.plan([{text: 'Tests pass', kind: 'command', command: 'npm test', cwd: 'C:\\Users\\nyaru\\muser'}]);
  const pass2 = repo.observe(run('npm test'), exit(0)); // absolute criterion cwd == omitted run cwd == sessionCwd
  repo.checkpoint([met('c1', [pass2])]);
  const wrong = new Focus('Tests', {sessionCwd: home}); wrong.beginRound();
  wrong.plan([{text: 'Tests pass', kind: 'command', command: 'npm test', cwd: 'muser'}]);
  const elsewhere = wrong.observe(run('npm test', {cwd: 'other'}), exit(0));
  assert.throws(() => wrong.checkpoint([met('c1', [elsewhere])]), /cwd\/shell do not match/);
});

test('fix 10: shell.kill (real kind kill) records a change, is not progress, and is no task by itself', () => {
  const q = new Focus('Stop the dev server'); q.beginRound();
  q.observe({command: 'shell.kill', kind: 'kill', params: {shell_id: 'bg1'}, summary: 'bg1'}, {ok: true, payload: {}});
  assert.equal(q.endRound().status, 'inactive');
  const f = new Focus('Task'); f.beginRound(); f.plan(insp);
  const r = f.observe(read('a.js'), {ok: true}), c = f.observe(run('git status'), exit(0));
  const progress = f.progressRevision, rev = f.revision;
  f.observe({command: 'shell.kill', kind: 'kill', params: {shell_id: 'bg1'}, summary: 'bg1'}, {ok: true, payload: {}});
  assert.ok(f.revision > rev, 'a kill is a recorded change now');
  assert.equal(f.progressRevision, progress, 'stopping a shell is not progress');
  assert.equal(f.evidenceCurrent(f.evidence.find(x => x.id === r)), true, 'no file changed');
  assert.equal(f.evidenceCurrent(f.evidence.find(x => x.id === c)), false, 'what a running process answered may have changed');
});

test('stopping a background run this task started is cleanup: the probe it passed stays current and the task completes', () => {
  const f = new Focus('Server answers'); f.beginRound();
  f.plan([{text: 'GET /health returns ok', kind: 'command', command: 'curl.exe -sf http://localhost:3000/health'}]);
  f.observe({command: 'system.run', kind: 'exec', params: {command: 'node server.js', background: true}, summary: 'node server.js'}, {ok: true, payload: {shell_id: 'bg7'}});
  const probe = f.observe(run('curl.exe -sf http://localhost:3000/health'), exit(0));
  f.checkpoint([met('c1', [probe])]);
  const rev = f.revision;
  f.observe({command: 'shell.kill', kind: 'kill', params: {shell_id: 'bg7'}, summary: 'bg7'}, {ok: true, payload: {}});
  assert.equal(f.revision, rev, 'stopping its own background run records no change');
  assert.equal(f.criteria[0].status, 'met');
  assert.equal(f.endRound().status, 'complete');
  // A shell the task did not start (bg1 above) still counts as a change.
  f.observe({command: 'shell.kill', kind: 'kill', params: {shell_id: 'bg1'}, summary: 'bg1'}, {ok: true, payload: {}});
  assert.ok(f.revision > rev);
  assert.equal(f.criteria[0].status, 'pending');
});

test('fix 11: checkpoint all-met, workers pending, then a fresh round still completes', () => {
  const f = new Focus('Task'); f.beginRound(); f.plan(insp);
  const proof = f.observe(read('probe.txt'), {ok: true});
  f.checkpoint([met('c1', [proof])]);
  assert.equal(f.endRound({workersPending: true}).continue, true);
  f.beginRound();
  assert.equal(f.endRound({}).status, 'complete', 'beginRound must not un-review an all-met task into stalled');
});

test('fix 12: unknown/blocked does not outrank workersPending', () => {
  const f = new Focus('Task'); f.beginRound();
  f.plan([{text: 'Looks right', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unknown', reason: 'user'}]);
  assert.equal(f.endRound({workersPending: true}).continue, true);
  assert.equal(f.endRound({}).status, 'needs_input');
});

test('fix 13: a plan append in a resumed leg does not block new_task replacement; a checkpoint does', () => {
  const f = new Focus('Old task'); f.beginRound();
  f.plan([{text: 'Device ok', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unknown', reason: 'u'}]); f.endRound();
  f.resumeLeg('A different task'); f.beginRound();
  f.plan([{text: 'Device ok', kind: 'manual'}, {text: 'Extra detail', kind: 'inspection'}]); // append only
  f.plan([{text: 'Different work', kind: 'inspection'}], {newTask: true});
  assert.equal(f.goal, 'A different task');
  assert.deepEqual(f.criteria.map(c => c.text), ['Different work']);
  const g = new Focus('Old task'); g.beginRound();
  g.plan([{text: 'Device ok', kind: 'manual'}]);
  g.checkpoint([{id: 'c1', status: 'unknown', reason: 'u'}]); g.endRound();
  g.resumeLeg('A different task'); g.beginRound();
  g.checkpoint([{id: 'c1', status: 'unknown', reason: 'still waiting'}]); // a checkpoint this leg locks the task
  assert.throws(() => g.plan([{text: 'Different work', kind: 'inspection'}], {newTask: true}), /fixed/);
});

test('fix 14+15: a zero-criteria task replaces its goal on a resumed leg, with a fresh round budget', () => {
  const f = new Focus('Old task', {maxRounds: 3}); f.beginRound();
  f.askUser('Which one?'); // tracked, but no criteria were ever planned
  assert.equal(f.endRound().status, 'needs_input');
  f.resumeLeg('A different task');
  f.beginRound(); f.beginRound(); f.beginRound();
  assert.equal(f.round, 3);
  f.plan([{text: 'Different work', kind: 'inspection'}], {newTask: true});
  assert.equal(f.goal, 'A different task');
  assert.equal(f.criteria.length, 1);
  assert.equal(f.round, 1, 'the replacement restarts the round budget');
});

test('fix 16+19: resumeLeg clears a decline halt, and every needs_input stop sets awaitingInput', () => {
  const f = new Focus('Task'); f.beginRound(); f.plan(insp);
  f.observe({...edit('a.js'), declined: true}, {ok: false});
  assert.equal(f.halted, true);
  const stop = f.endRound();
  assert.equal(stop.status, 'needs_input');
  assert.equal(f.awaitingInput, true, 'the halt stop is a user wait like every needs_input stop');
  f.resumeLeg('go on'); f.beginRound();
  assert.equal(f.halted, false, 'the resumed leg is not permanently halted by the old decline');
  const proof = f.observe(read('probe.txt'), {ok: true});
  f.checkpoint([met('c1', [proof])]);
  assert.equal(f.endRound().status, 'complete');
});

test('fix 17: ask_user with only structured questions is accepted; a plain ask still needs its text', () => {
  const f = new Focus('Pick'); f.beginRound();
  const snap = f.askUser('', {questions: JSON.stringify([{header: '色', question: '色は？', options: [{label: '青'}, {label: '緑'}]}])});
  assert.equal(snap.ask.questions[0].question, '色は？');
  assert.equal(f.question, '色は？', 'the first structured question becomes the stored question');
  assert.equal(f.endRound().status, 'needs_input');
  const plain = new Focus('Plain'); plain.beginRound();
  assert.throws(() => plain.askUser(''), /Give the question/);
  assert.throws(() => plain.askUser('', {options: [{label: 'only'}]}), /Give the question/);
});

test('fix 18: an unprovable shell spelling is refused at plan time', () => {
  const f = new Focus('Tests'); f.beginRound();
  assert.throws(() => f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test', shell: 'zsh'}]), /powershell or cmd/);
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test', shell: 'cmd'}]);
  assert.equal(f.criteria[0].shell, 'cmd');
});

test('fix 20: modelState keeps the older still-current evidence IDs citable', () => {
  const f = new Focus('Big task'); f.beginRound(); f.plan(insp);
  const ids = [];
  for (let i = 0; i < 45; i++) ids.push(f.observe(read('f' + i + '.txt'), {ok: true}));
  const state = f.modelState();
  assert.equal(state.evidence.length, 40);
  assert.deepEqual(state.olderCurrentEvidenceIds, ids.slice(0, 5));
});
