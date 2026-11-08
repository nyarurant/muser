'use strict';
// muser race （競争）: the whole flow with a fake Muse (opts.runner), a real
// git repository in a temp folder, and sample worklog files written by the
// test itself (the worklog writer lives on the feat-worklog branch; race
// only reads the documented shape). No real Muse is ever called, and the
// fixture's own working tree must come out untouched.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const race = require('../src/race');

function git(cwd, args) { return execFileSync('git', args, {cwd, encoding: 'utf8'}); }
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.email', 'race@example.invalid']);
  git(dir, ['config', 'user.name', 'race test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, 'verify.js'), "if (require('fs').existsSync('bad.txt')) process.exit(1);\n");
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'fixture', scripts: {test: 'node verify.js', check: 'node -e "process.exit(0)"'}}, null, 2) + '\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}
// A fake Muse: edits its worktree according to which worktree it is in,
// and leaves a sample worklog for its session (edit, then a test run whose
// outcome varies), so the proof badge has something real to read.
function fakeRunner(worklogDir, calls) {
  return async ({cwd, prompt, account}) => {
    calls.push({cwd, prompt, account});
    const idx = Number(/wt-(\d+)$/.exec(cwd)[1]);
    if (idx === 1) fs.appendFileSync(path.join(cwd, 'a.txt'), 'minimal\n');
    if (idx === 2) { fs.writeFileSync(path.join(cwd, 'bad.txt'), 'x\n'); fs.appendFileSync(path.join(cwd, 'a.txt'), 'readable\n'); }
    if (idx === 3) fs.writeFileSync(path.join(cwd, 'new-test.txt'), 't\n');
    const session = 'fake-' + idx;
    const events = [{v: 1, event: 'turn', agent: 'main', text: 'task'}, {v: 1, event: 'edit', path: 'a.txt'}];
    if (idx === 1) events.push({v: 1, event: 'tool', command: 'system.run', summary: 'npm test', ok: true});
    if (idx === 3) events.push({v: 1, event: 'tool', command: 'system.run', summary: 'npm test', ok: false});
    fs.mkdirSync(worklogDir, {recursive: true});
    fs.writeFileSync(path.join(worklogDir, session + '.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    return {ok: true, reply: 'done ' + idx, session, usage: {inputTokens: 10 * idx, outputTokens: 5}};
  };
}
const CHECKS = ['node verify.js', 'node -e "process.exit(0)"'];

test('race: three strategies run in worktrees, checks and badges compare, the user tree is untouched', async () => {
  const repo = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-state-'));
  const calls = [];
  const result = await race.runRace({cwd: repo, task: 'a.txt を伸ばす', n: 3, accounts: ['a1', 'a2'], stateDir: path.join(tmp, 'r1'),
    runner: fakeRunner(path.join(tmp, 'worklog'), calls), worklogDir: path.join(tmp, 'worklog'), checkCommands: CHECKS});
  assert.equal(result.racers.length, 3);
  assert.deepEqual(result.racers.map(r => r.account), ['a1', 'a2', 'a1'], 'accounts go round-robin');
  assert.equal(new Set(result.racers.map(r => r.strategy.id)).size, 3, 'each racer gets a different strategy');
  assert.ok(calls.every(c => c.prompt.includes('a.txt を伸ばす')), 'every racer got the task');
  assert.equal(new Set(calls.map(c => c.prompt)).size, 3, 'the strategy note makes each prompt differ');
  // checks: racer 2 made bad.txt, so its verify fails; everyone passes check 2.
  assert.deepEqual(result.racers.map(r => r.checks.map(x => x.code)), [[0, 0], [1, 0], [0, 0]]);
  // badges from the sample worklogs: pass after edit / no test after edit / failed test.
  assert.deepEqual(result.racers.map(r => r.badge.mark), ['✓', '?', '✗']);
  assert.ok(result.racers.every(r => r.diff.files >= 1), 'each racer produced a diff');
  assert.equal(result.totalTokens, (10 + 5) + (20 + 5) + (30 + 5));
  // The user's tree never moved.
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'base\n');
  // Applying the winner changes the tree by exactly that diff; cleanup removes everything.
  const applied = await race.applyWinner(result, 1);
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'base\nminimal\n');
  await race.cleanupRace(result);
  assert.equal(fs.existsSync(result.dir), false);
  assert.equal(git(repo, ['worktree', 'list']).trim().split('\n').length, 1);
});

test('race: a dirty tree is refused unless the caller says to include it, and then the racers start from it', async () => {
  const repo = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-state-'));
  fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty-marker\n');
  await assert.rejects(race.runRace({cwd: repo, task: 'x', n: 1, stateDir: path.join(tmp, 'r0'), runner: async () => ({ok: true}), checkCommands: []}),
    e => e.code === 'dirty');
  let seenInWorktree = '';
  const result = await race.runRace({cwd: repo, task: 'x', n: 1, includeDirty: true, stateDir: path.join(tmp, 'r1'), checkCommands: [],
    runner: async ({cwd}) => { seenInWorktree = fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'); return {ok: true, reply: 'ok'}; }});
  assert.ok(seenInWorktree.includes('dirty-marker'), 'the racer started from the dirty state');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'base\ndirty-marker\n', 'the user tree itself was not written');
  await race.cleanupRace(result);
});

test('race: a token cap stops later racers from starting', async () => {
  const repo = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-state-'));
  let calls = 0;
  const result = await race.runRace({cwd: repo, task: 'x', n: 3, maxTokens: 100, stateDir: path.join(tmp, 'r1'), checkCommands: [],
    runner: async () => { calls++; return {ok: true, reply: 'ok', usage: {inputTokens: 90, outputTokens: 60}}; }});
  assert.equal(calls, 1, 'only the first racer ran');
  assert.deepEqual(result.racers.map(r => r.status), ['done', 'skipped', 'skipped']);
  await race.cleanupRace(result);
});

test('race: not a git repository, and no task, are clear errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-plain-'));
  await assert.rejects(race.runRace({cwd: dir, task: 'x'}), /git/);
  const repo = makeRepo();
  await assert.rejects(race.runRace({cwd: repo, task: '  '}), /頼み/);
  await assert.rejects(race.runRace({cwd: repo, task: 'x', n: 9}), /参加者/);
});

test('race: estimate shows the count, the accounts and the cap', () => {
  const est = race.estimate({n: 3, accounts: ['a', 'b'], maxTokens: 5000});
  assert.deepEqual(est.accounts, ['a', 'b', 'a']);
  assert.match(est.lines[0], /3/);
  assert.match(est.lines[0], /a, b, a/);
  assert.match(est.lines[2], /5000/);
  assert.deepEqual(race.assignAccounts(2, null).length, 2);
});

test('race: parseRaceArgs takes the flags before or after the task', () => {
  assert.deepEqual(race.parseRaceArgs('--n 2 --yes do it'), {task: 'do it', yes: true, n: 2});
  const after = race.parseRaceArgs('do it --n 2 --accounts a,b --max-tokens 100');
  assert.equal(after.task, 'do it'); assert.equal(after.n, 2);
  assert.deepEqual(after.accounts, ['a', 'b']); assert.equal(after.maxTokens, 100);
  assert.equal(race.parseRaceArgs('').task, '');
});

test('race: detectCommands reads the project scripts', () => {
  const repo = makeRepo();
  assert.deepEqual(race.detectCommands(repo), ['npm test', 'npm run check']);
  assert.deepEqual(race.detectCommands(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-none-'))), []);
});

test('worklog reader: parses the shape src/worklog.js writes, skips bad lines, missing file is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-wl-'));
  fs.writeFileSync(path.join(dir, 'conv-1.jsonl'), [
    JSON.stringify({v: 1, at: '2026-11-07T00:00:00.000Z', session: 'conv-1', event: 'turn', agent: 'main', text: 'hi'}),
    'not json',
    JSON.stringify({v: 1, event: 'edit', path: 'x.js', beforeHash: 'abc'}),
    JSON.stringify({v: 1, event: 'tool', command: 'system.run', summary: 'npm test', ok: true}),
    '',
  ].join('\n'));
  const events = race.readWorklog('conv-1', {dir});
  assert.equal(events.length, 3);
  assert.equal(race.proofBadge(events).mark, '✓');
  assert.deepEqual(race.readWorklog('missing', {dir}), []);
  assert.equal(race.proofBadge([]).mark, '—');
  assert.equal(race.proofBadge([{event: 'edit', path: 'x', _i: 0}]).mark, '?');
  assert.equal(race.proofBadge([{event: 'edit', path: 'x', _i: 0}, {event: 'tool', command: 'system.run', summary: 'npm test', ok: false, _i: 1}]).mark, '✗');
  // A test run from BEFORE the last edit does not count.
  assert.equal(race.proofBadge([{event: 'tool', command: 'system.run', summary: 'npm test', ok: true, _i: 0}, {event: 'edit', path: 'x', _i: 1}]).mark, '?');
});

test('race: formatRaceResult renders the comparison as plain lines', async () => {
  const repo = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-race-state-'));
  const result = await race.runRace({cwd: repo, task: 'task', n: 1, stateDir: path.join(tmp, 'r1'), checkCommands: CHECKS,
    runner: fakeRunner(path.join(tmp, 'worklog'), []), worklogDir: path.join(tmp, 'worklog')});
  const lines = race.formatRaceResult(result);
  assert.match(lines[0], /競争の結果/);
  assert.match(lines[1], /最小の変更/);
  assert.match(lines[2], /検査 2\/2 通過/);
  assert.match(lines[2], /裏取り ✓/);
  const loaded = race.loadRace(result.dir);
  assert.equal(loaded.id, result.id);
  assert.ok(race.diffText(loaded, 1).includes('minimal'));
  await race.cleanupRace(result);
});
