'use strict';
// Fix phase 2, agent A6: src/focus.js Medium findings (work2/c9.md = deep #61-#68).
const test = require('node:test');
const assert = require('node:assert/strict');
const {Focus} = require('../src/focus');

const read = path => ({command: 'code.read', kind: 'read', params: {path}, summary: path});
const edit = path => ({command: 'code.edit', kind: 'edit', params: {path}, summary: path});
const run = (command, extra = {}) => ({command: 'system.run', kind: 'exec', params: {command, ...extra}, summary: command});
const ok0 = {ok: true, payload: {exit_code: 0}};
const insp = text => ({text, kind: 'inspection'});
const met = (id, evidence, reason = 'ok') => ({id, status: 'met', evidence, reason});

// ---------- deep #61: resumeLeg must drop a question endRound never consumed ----------

test('fix2 #61: a question left by a stopped (not endRound) leg does not revive on resume', () => {
  const f = new Focus('Task'); f.beginRound();
  f.plan([insp('Do it')]);
  f.askUser('Old question?');
  f.stop('blocked', 'gateway down'); // the agent catch path: endRound never ran
  f.resumeLeg('the user moved on'); f.beginRound();
  f.checkpoint([{id: 'c1', status: 'unmet', evidence: [], reason: 'not yet'}]);
  const d = f.endRound();
  assert.equal(d.continue, true, 'the resumed leg continues the work instead of parking on the stale question');
  assert.ok(!String(d.reason).includes('Old question?'));
  // The resumed leg can ask a fresh question of its own.
  const snap = f.askUser('New question?');
  assert.equal(snap.ask, null);
  assert.equal(f.endRound().status, 'needs_input');
});

// ---------- deep #62: overlaps() must normalise path spellings ----------

test('fix2 #62: same-file edits in ./, //, .. and trailing-dot spellings expire read evidence', () => {
  for (const spelling of ['src/./foo.js', 'src//foo.js', 'src/sub/../foo.js', 'src/foo.js.', 'SRC\\FOO.JS', './src/foo.js']) {
    const f = new Focus('Task'); f.beginRound(); f.plan([insp('Check foo')]);
    const proof = f.observe(read('src/foo.js'), {ok: true});
    f.checkpoint([met('c1', [proof])]);
    assert.equal(f.criteria[0].status, 'met');
    f.observe(edit(spelling), {ok: true});
    assert.equal(f.criteria[0].status, 'pending', spelling + ' is the same file: the verified criterion resets');
    assert.throws(() => f.checkpoint([met('c1', [proof])]), /out of date/, spelling);
  }
  // Control: an edit to a genuinely different file still leaves the evidence current.
  const f = new Focus('Task'); f.beginRound(); f.plan([insp('Check foo')]);
  const proof = f.observe(read('src/foo.js'), {ok: true});
  f.observe(edit('src/sub/../bar.js'), {ok: true});
  f.checkpoint([met('c1', [proof])]);
  assert.equal(f.criteria[0].status, 'met', 'src/bar.js is not src/foo.js');
});

// ---------- deep #63: the verification exemption must not cover plain shell evidence ----------

test('fix2 #63: a shell listing taken before a verification run is stale after it', () => {
  const f = new Focus('Publish'); f.beginRound();
  f.plan([{text: 'Publishes', kind: 'command', command: 'dotnet publish'}, insp('One file in publish/')]);
  const listing = f.observe(run('Get-ChildItem publish'), ok0); // file state seen BEFORE the publish
  const pub = f.observe(run('dotnet publish'), ok0);
  assert.throws(() => f.checkpoint([met('c1', [pub]), met('c2', [listing])]), /out of date/,
    'the pre-publish listing must not prove the post-publish state');
  // Re-observed after the publish with a read tool (a fresh shell listing would itself be
  // a state-changing run and would date the publish evidence in turn — the standing
  // strictness for shell evidence, unchanged here).
  const after = f.observe({command: 'code.glob', kind: 'search', params: {path: 'publish'}, summary: 'publish'}, {ok: true});
  f.checkpoint([met('c1', [pub]), met('c2', [after])]);
  assert.equal(f.endRound().status, 'complete');
});

test('fix2 #63: verification evidence itself still survives another verification run', () => {
  const f = new Focus('Build and publish'); f.beginRound();
  f.plan([{text: 'Builds', kind: 'command', command: 'dotnet build'}, {text: 'Publishes', kind: 'command', command: 'dotnet publish'}]);
  const build = f.observe(run('dotnet build'), ok0);
  const pub = f.observe(run('dotnet publish'), ok0);
  f.checkpoint([met('c1', [build]), met('c2', [pub])]);
  assert.equal(f.endRound().status, 'complete', 'declared checks keep each other current, as before');
});

// ---------- deep #64: a verification command is identified by command + cwd + shell ----------

test('fix2 #64: the same command in another directory does not verify the criterion', () => {
  const f = new Focus('Tests'); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}]);
  const elsewhere = f.observe(run('npm test', {cwd: 'packages/other'}), ok0);
  assert.throws(() => f.checkpoint([met('c1', [elsewhere])]), /exact verification command: npm test/);
  const here = f.observe(run('npm test'), ok0);
  f.checkpoint([met('c1', [here])]);
  assert.equal(f.endRound().status, 'complete');
});

test('fix2 #64: a criterion may name its directory; spelling variants of it still count', () => {
  const f = new Focus('Tests'); f.beginRound();
  f.plan([{text: 'Package tests pass', kind: 'command', command: 'npm test', cwd: 'packages/app'}]);
  const root = f.observe(run('npm test'), ok0);
  assert.throws(() => f.checkpoint([met('c1', [root])]), /exact verification command/,
    'a root run does not verify a package criterion');
  const pkg = f.observe(run('npm test', {cwd: 'packages\\app\\'}), ok0); // same dir, other spelling
  f.checkpoint([met('c1', [pkg])]);
  assert.equal(f.endRound().status, 'complete');
  // The directory is part of the fixed criterion: re-planning it elsewhere is a change.
  assert.throws(() => f.plan([{text: 'Package tests pass', kind: 'command', command: 'npm test', cwd: 'packages/other'}]), /fixed/);
});

test('fix2 #64: the shell is part of the identity; powershell is the default shell', () => {
  const f = new Focus('Tests'); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}]);
  const cmdRun = f.observe(run('npm test', {shell: 'cmd'}), ok0);
  assert.throws(() => f.checkpoint([met('c1', [cmdRun])]), /exact verification command/);
  const psRun = f.observe(run('npm test', {shell: 'powershell'}), ok0);
  f.checkpoint([met('c1', [psRun])]);
  assert.equal(f.endRound().status, 'complete', 'an explicit powershell names the default shell');
  const g = new Focus('Tests'); g.beginRound();
  g.plan([{text: 'Tests pass', kind: 'command', command: 'npm test', shell: 'cmd'}]);
  const inCmd = g.observe(run('npm test', {shell: 'cmd'}), ok0);
  g.checkpoint([met('c1', [inCmd])]);
  assert.equal(g.endRound().status, 'complete', 'a cmd criterion is verified by a cmd run');
});

// ---------- deep #65: duplicate labels / headers after normalisation are refused ----------

test('fix2 #65: options that normalise to the same label are refused', () => {
  const f = new Focus('Pick'); f.beginRound();
  assert.throws(() => f.askUser('Which?', {options: [{label: 'Same'}, {label: 'Same '}, {label: 'Other'}]}), /distinct/);
  assert.throws(() => f.askUser('Which?', {options: [{label: 'Same'}, {label: 'Same\u0001'}, {label: 'Other'}]}), /distinct/);
  const long = 'x'.repeat(120);
  assert.throws(() => f.askUser('Which?', {options: [{label: long + 'A'}, {label: long + 'B'}]}), /distinct/,
    'labels that differ only past the 120-char cut are one label');
  const snap = f.askUser('Which?', {options: [{label: 'A'}, {label: 'B'}]});
  assert.equal(snap.ask.questions[0].options.length, 2, 'distinct labels still pass');
});

test('fix2 #65: duplicate question headers are refused, explicit or by fallback', () => {
  const f = new Focus('Pick'); f.beginRound();
  assert.throws(() => f.askUser('q', {questions: [
    {header: 'Same', question: 'One?', options: [{label: 'A'}, {label: 'B'}]},
    {header: 'Same', question: 'Two?', options: [{label: 'A'}, {label: 'B'}]},
  ]}), /distinct/);
  const prefix = 'あ'.repeat(20); // fallback header = first 16 chars: identical for both
  assert.throws(() => f.askUser('q', {questions: [
    {question: prefix + 'Aですか？', options: [{label: 'A'}, {label: 'B'}]},
    {question: prefix + 'Bですか？', options: [{label: 'A'}, {label: 'B'}]},
  ]}), /distinct/);
  const snap = f.askUser('q', {questions: [
    {header: '色', question: '色は？', options: [{label: '青'}, {label: '緑'}]},
    {header: '形', question: '形は？', options: [{label: '丸'}, {label: '角'}]},
  ]});
  assert.equal(snap.ask.questions.length, 2, 'distinct headers still pass');
});

// ---------- deep #66 (+ #267): a second askUser must not overwrite or damage the first ----------

test('fix2 #66: a second askUser in the same round is refused and the first question stands', () => {
  const f = new Focus('Ask'); f.beginRound();
  f.askUser('First question A?');
  assert.throws(() => f.askUser('Second question B?', {options: [{label: 'x'}, {label: 'y'}]}), /already waiting/);
  const d = f.endRound();
  assert.equal(d.status, 'needs_input');
  assert.ok(d.reason.includes('First question A?'), 'the user is still asked the first question');
  // After that question is consumed, asking again is fine.
  f.resumeLeg('answer'); f.beginRound();
  assert.equal(f.askUser('Follow-up?').ask, null);
});

test('fix2 #267: a failed askUser call leaves the standing question untouched', () => {
  const f = new Focus('Ask'); f.beginRound();
  const before = f.askUser('Keep me?', {options: [{label: 'Yes'}, {label: 'No'}]});
  assert.throws(() => f.askUser('x', {options: [{label: 'only one'}]}), /2 to 6 options/);
  assert.throws(() => f.askUser('Replacement?', {options: [{label: 'a'}, {label: 'b'}]}), /already waiting/);
  assert.deepEqual(f.snapshot().ask, before.ask, 'the picker data is exactly the first question');
  assert.ok(f.endRound().reason.includes('Keep me?'));
});

// ---------- deep #67: verificationCommand is capped; identity survives by hash ----------

test('fix2 #67: a long verification command is stored capped, with a hash that still proves it', () => {
  const longCommand = 'node -e ' + 'x'.repeat(2000);
  const f = new Focus('Long'); f.beginRound();
  f.plan([{text: 'Long check passes', kind: 'command', command: longCommand}]);
  const id = f.observe(run(longCommand), ok0);
  const e = f.evidence.find(x => x.id === id);
  assert.ok(e.verificationCommand.length <= 250, 'stored head is capped at 250 chars');
  assert.match(e.commandHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(f.modelState().evidence).includes('x'.repeat(300)),
    'no evidence entry carries the full script (the criterion itself keeps its declared command, once)');
  f.checkpoint([met('c1', [id])]);
  assert.equal(f.endRound().status, 'complete', 'the long command still verifies its criterion, by hash');
});

// ---------- deep #68: stop reasons go through i18n (tests run with MUSER_LANG=ja) ----------

test('fix2 #68: user-facing stop reasons are localised, not fixed English', () => {
  const capped = new Focus('Task', {maxRounds: 1, automatic: false}); capped.beginRound();
  assert.equal(capped.endRound().reason, '自動続行のラウンド上限に達しました。');
  const asking = new Focus('Task'); asking.beginRound(); asking.askUser('Which file?');
  assert.equal(asking.endRound().reason, 'ユーザーの回答を待っています: Which file?');
  const declined = new Focus('Task'); declined.beginRound();
  declined.observe({command: 'code.write', kind: 'edit', params: {path: 'x'}, summary: 'x', declined: true}, {ok: false});
  assert.equal(declined.endRound().reason, 'コマンドが却下されました。ユーザーの入力が必要です。');
  const idle = new Focus('Task'); idle.beginRound();
  assert.equal(idle.endRound().reason, '複数ステップの作業ではないため、完了追跡は行いません。');
});
