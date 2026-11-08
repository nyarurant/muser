'use strict';
// Focus weakness 1 (2026-11-06): a shell read must not count as a change.
// The approval judgement in src/policy.js stays fail-closed and is asserted
// unchanged below; the Focus-only judgement lives in src/focus.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {Focus, focusReadOnlyCommand, focusReadPaths, focusTreeNeutralCommand, focusTreeNeutralSubcommands} = require('../src/focus');
const {readOnlyCommand} = require('../src/policy');

const read = p => ({command: 'code.read', kind: 'read', params: {path: p}, summary: p});
const edit = p => ({command: 'code.edit', kind: 'edit', params: {path: p}, summary: p});
const run = (cmd, extra = {}) => ({command: 'system.run', kind: 'exec', params: {command: cmd, ...extra}, summary: cmd});
const ok0 = {ok: true, payload: {exit_code: 0}};
const insp = text => ({text, kind: 'inspection'});
const met = (id, evidence, reason = 'ok') => ({id, status: 'met', evidence, reason});
const bgOut = id => ({command: 'shell.output', kind: 'read', params: {shell_id: id}, summary: id});
const bgResult = (id, code) => ({ok: true, payload: {id, running: false, exit_code: code, backgroundResult: {id, running: false, exit_code: code}}});

test('weakness 1: common read-only shell commands are Focus-read-only', () => {
  for (const cmd of [
    'Get-Content a.js',
    'Get-Content -Raw a.js',
    "Select-String -Path x.js -Pattern foo",
    'Select-String -Path x.js -Pattern foo | Select-Object -First 5',
    'Get-Content a.js | Select-Object -First 5',
    'Get-ChildItem publish',
    'ls src',
    'Get-Process',
    'git log --oneline -5',
    'git status',
    'git show HEAD',
    'git diff --stat',
    'curl.exe -sf http://localhost:3000/health',
    'Test-Path a.js',
    "Get-Content 'a b.js'",
  ]) assert.equal(focusReadOnlyCommand(cmd), true, cmd);
});

test('weakness 1: mutating or ambiguous shell commands are still changes', () => {
  for (const cmd of [
    'Set-Content a.js -Value x',
    'Remove-Item a.js',
    'npm install',
    'npm test',
    'dotnet build',
    'Get-Content a.js > out.txt',
    'Get-Content a.js | Out-File out.txt',
    'Get-Content a.js; Remove-Item a.js',
    'git status && Remove-Item x',
    'Get-Content $(Get-Item a.js)',
    '[IO.File]::WriteAllText("a.js", "x")',
    'Get-Content a.js | Set-Content b.js',
    'Start-Process notepad',
    'powershell -Command Get-Content a.js',
    '',
  ]) assert.equal(focusReadOnlyCommand(cmd), false, cmd);
});

test('weakness 1: the approval judgement is not loosened', () => {
  assert.equal(readOnlyCommand('Get-Content a.js'), false);
  assert.equal(readOnlyCommand('ls'), false);
  assert.equal(readOnlyCommand('Select-String -Path x.js -Pattern foo'), false);
  assert.equal(readOnlyCommand('git status'), true, 'control: a real approval read still passes');
});

test('weakness 1: read paths are tied to the files a shell read covered', () => {
  assert.deepEqual(focusReadPaths('Get-Content a.js'), ['a.js']);
  assert.deepEqual(focusReadPaths('Select-String -Path x.js -Pattern foo'), ['x.js']);
  assert.deepEqual(focusReadPaths('Get-Content a.js, b.js'), ['a.js', 'b.js']);
  assert.deepEqual(focusReadPaths('Get-ChildItem publish'), ['publish']);
  assert.equal(focusReadPaths('git log --oneline'), null);
  assert.equal(focusReadPaths('Set-Content a.js -Value x'), null);
});

test('weakness 1 (repro A): a read-only shell run leaves read evidence met', () => {
  const f = new Focus('t', {maxRounds: 10}); f.beginRound();
  f.plan([insp('a.js has X'), insp('b.js has Y')]);
  const e1 = f.observe(read('a.js'), {ok: true}), e2 = f.observe(read('b.js'), {ok: true});
  f.checkpoint([met('c1', [e1]), met('c2', [e2])]);
  f.observe(run('Get-Content a.js'), ok0);
  assert.deepEqual(f.criteria.map(c => c.status), ['met', 'met']);
});

test('weakness 1 (repro B): two shell reads can prove two criteria together', () => {
  const f = new Focus('t', {maxRounds: 10}); f.beginRound();
  f.plan([insp('a has X'), insp('b has Y')]);
  const g1 = f.observe(run('Get-Content a.js'), ok0), g2 = f.observe(run('Get-Content b.js'), ok0);
  f.checkpoint([met('c1', [g1]), met('c2', [g2])]);
  assert.equal(f.endRound().status, 'complete');
});

test('weakness 1 (repro C): read-only shell rounds stall like true reads', () => {
  const f = new Focus('t', {maxRounds: 10});
  f.beginRound(); f.plan([insp('find bug')]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]); f.endRound();
  f.beginRound(); f.observe(run('Select-String -Path x.js -Pattern foo'), ok0);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]);
  assert.equal(f.endRound().status, 'stalled');
});

test('weakness 1: a mutating shell run still expires read evidence', () => {
  for (const cmd of ['Set-Content a.js -Value x', 'Remove-Item a.js', 'npm install', 'Get-Content a.js > out.txt']) {
    const f = new Focus('t'); f.beginRound(); f.plan([insp('a.js has X')]);
    const proof = f.observe(read('a.js'), {ok: true});
    f.checkpoint([met('c1', [proof])]);
    f.observe(run(cmd), ok0);
    assert.equal(f.criteria[0].status, 'pending', cmd + ' must expire the read evidence');
    assert.throws(() => f.checkpoint([met('c1', [proof])]), /out of date/, cmd);
  }
});

test('weakness 1: shell-read evidence expires only on an edit to the file it read', () => {
  const f = new Focus('t'); f.beginRound(); f.plan([insp('a has X'), insp('b has Y')]);
  const g1 = f.observe(run('Get-Content a.js'), ok0), g2 = f.observe(run('Select-String -Path b.js -Pattern foo'), ok0);
  f.checkpoint([met('c1', [g1]), met('c2', [g2])]);
  f.observe(edit('a.js'), {ok: true});
  assert.equal(f.criteria[0].status, 'pending', 'a.js was edited');
  assert.equal(f.criteria[1].status, 'met', 'b.js was not touched');
  assert.throws(() => f.checkpoint([met('c1', [g1]), met('c2', [g2])]), /out of date/);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'recheck a.js'}, met('c2', [g2])]);
});

test('weakness 1: a declared verification run does not expire read-tool evidence', () => {
  const f = new Focus('Build'); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}, insp('a.js has X')]);
  const proof = f.observe(read('a.js'), {ok: true});
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'not yet'}, met('c2', [proof])]);
  const passed = f.observe(run('npm test'), ok0);
  assert.equal(f.criteria[1].status, 'met', 'the verification run leaves the read evidence alone');
  f.checkpoint([met('c1', [passed]), met('c2', [proof])]);
  assert.equal(f.endRound().status, 'complete');
});

test('weakness 1: a listing still dates on a verification run, unlike a file read', () => {
  const f = new Focus('Publish'); f.beginRound();
  f.plan([{text: 'Publishes', kind: 'command', command: 'dotnet publish'}, insp('One file in publish/')]);
  const listing = f.observe({command: 'code.glob', kind: 'read', params: {path: 'publish'}, summary: 'publish'}, {ok: true});
  const pub = f.observe(run('dotnet publish'), ok0);
  assert.throws(() => f.checkpoint([met('c1', [pub]), met('c2', [listing])]), /out of date/,
    'the pre-publish listing must not prove the post-publish state');
});

test('weakness 1: a background read-only run finishing expires nothing', () => {
  const f = new Focus('t'); f.beginRound(); f.plan([insp('a.js has X')]);
  const proof = f.observe(read('a.js'), {ok: true});
  f.checkpoint([met('c1', [proof])]);
  const rev = f.revision;
  f.observe(run('Get-Content a.js'), {ok: true, payload: {shell_id: 'bg1'}});
  f.observe(bgOut('bg1'), bgResult('bg1', 0));
  assert.equal(f.revision, rev);
  assert.equal(f.criteria[0].status, 'met');
});

test('weakness 10: git add / commit / tag are tree-neutral, checkout / reset / push are not', () => {
  for (const cmd of [
    'git add -A',
    'git add .',
    'git commit -m x',
    "git commit -m 'fix it'",
    'git tag v1.0',
    'git tag -a v1.0 -m msg',
    'git add -A; git commit -m x',
    'git add -A && git commit -m x',
    'git -C sub commit -m x',
    'git -c user.name=x commit -m x',
  ]) assert.equal(focusTreeNeutralCommand(cmd), true, cmd);
  for (const cmd of [
    'git checkout -- a.js',
    'git checkout main',
    'git reset --hard',
    'git push',
    'git pull',
    'git status',
    'git log --oneline',
    'git stash',
    'git commit; Remove-Item a.js',
    'git commit > out.txt',
    'git commit $(Get-Item a.js)',
    'git add -A | Out-File x',
    'git commit || git status',
    '',
  ]) assert.equal(focusTreeNeutralCommand(cmd), false, cmd);
  assert.deepEqual(focusTreeNeutralSubcommands('git add -A; git commit -m x'), ['add', 'commit']);
  assert.deepEqual(focusTreeNeutralSubcommands('git tag v1.0'), ['tag']);
  assert.equal(focusTreeNeutralSubcommands('git status'), null);
});

test('weakness 10 (acceptance): a commit after passing tests leaves the test evidence met', () => {
  const f = new Focus('Build'); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}, insp('a.js has X')]);
  const proof = f.observe(read('a.js'), {ok: true});
  const passed = f.observe(run('npm test'), ok0);
  f.checkpoint([met('c1', [passed]), met('c2', [proof])]);
  const rev = f.revision;
  f.observe(run('git add -A'), ok0);
  f.observe(run('git commit -m x'), ok0);
  f.observe(run('git tag v1.0'), ok0);
  assert.equal(f.revision, rev + 3, 'each tree-neutral run is recorded in the revision');
  assert.deepEqual(f.criteria.map(c => c.status), ['met', 'met']);
  f.checkpoint([met('c1', [passed]), met('c2', [proof])]);
  assert.equal(f.endRound().status, 'complete');
});

test('weakness 10: checkout and reset still expire evidence', () => {
  for (const cmd of ['git checkout -- a.js', 'git reset --hard']) {
    const f = new Focus('Build'); f.beginRound();
    f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}, insp('a.js has X')]);
    const proof = f.observe(read('a.js'), {ok: true});
    const passed = f.observe(run('npm test'), ok0);
    f.checkpoint([met('c1', [passed]), met('c2', [proof])]);
    f.observe(run(cmd), ok0);
    assert.deepEqual(f.criteria.map(c => c.status), ['pending', 'pending'], cmd + ' must expire the evidence');
    assert.throws(() => f.checkpoint([met('c1', [passed]), met('c2', [proof])]), /out of date/, cmd);
  }
});

test('weakness 10: a background commit finishing expires nothing', () => {
  const f = new Focus('Build'); f.beginRound();
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}, insp('a.js has X')]);
  const proof = f.observe(read('a.js'), {ok: true});
  const passed = f.observe(run('npm test'), ok0);
  f.checkpoint([met('c1', [passed]), met('c2', [proof])]);
  const rev = f.revision;
  f.observe(run('git commit -m x'), {ok: true, payload: {shell_id: 'bg1'}});
  assert.equal(f.revision, rev, 'the commit has not happened at its start');
  f.observe(bgOut('bg1'), bgResult('bg1', 0));
  assert.equal(f.revision, rev + 1, 'the finished commit is recorded once');
  assert.deepEqual(f.criteria.map(c => c.status), ['met', 'met']);
});
