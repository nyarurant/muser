'use strict';
// Overnight work (design new-features.md §8): the queue, the account pick,
// the worklog reader (on a sample log written in the designed shape — the
// writer itself is another branch's), and a full night run driven by a FAKE
// runner: no real Muse is ever called here.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const Q = require('../src/overnight/queue');
const WL = require('../src/overnight/worklog-read');
const R = require('../src/overnight/run');
const {overnightCli, parseAt} = require('../src/overnight/cli');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-overnight-test-'));
const settingsStub = {numberValue: () => 0, overnightApproval: () => 'edit-auto', setOvernightApproval: () => {}};
const git = (cwd, args) => { const r = spawnSync('git', args, {cwd, encoding: 'utf8'}); assert.equal(r.status, 0, args.join(' ') + ': ' + r.stderr); return r.stdout; };
function makeRepo() {
  const dir = tmp();
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}
function writeWorklog(dir, id, events) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, id + '.jsonl'), events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n');
}

// --- queue + cli ------------------------------------------------------------
// Spec update (wave 11): addItem now checks that the folder is a git
// repository WHEN THE ITEM IS QUEUED, not first during the night run —
// a made-up cwd like 'C:\\repo' is refused at add time (see the non-git
// test below). This test is about queue persistence, so it queues
// against a real temp git repo, which queues exactly as before.
test('queue: add/list/remove through the shared cli, persisted as queue.json', async () => {
  const baseDir = tmp();
  const repo = makeRepo();
  const a = await overnightCli(['add', 'テストを直す'], {baseDir, cwd: repo, settings: settingsStub});
  assert.match(a.lines[0], /積みました/);
  const id = Q.loadQueue({baseDir}).items[0].id;
  assert.ok(fs.existsSync(path.join(baseDir, 'queue.json')));
  await overnightCli(['add', '資料をまとめる'], {baseDir, cwd: repo, settings: settingsStub});
  const list = await overnightCli(['list'], {baseDir, settings: settingsStub});
  assert.equal(list.lines.length, 2);
  const rm = await overnightCli(['remove', id.slice(0, 8)], {baseDir, settings: settingsStub});
  assert.match(rm.lines[0], /外しました/);
  assert.equal(Q.loadQueue({baseDir}).items.length, 1);
  await assert.rejects(() => overnightCli(['remove', 'zzzz'], {baseDir, settings: settingsStub}), /ありません/);
  await assert.rejects(() => overnightCli(['bogus'], {baseDir, settings: settingsStub}), /使い方/);
});

test('parseAt: HH:MM rolls to tomorrow once past, ISO parses, junk throws', () => {
  const now = new Date('2026-11-07T23:00:00').getTime();
  const at = parseAt('01:30', now);
  assert.equal(new Date(at).getDate(), 8);
  assert.equal(parseAt('2026-11-09T02:00:00', now), Date.parse('2026-11-09T02:00:00'));
  assert.throws(() => parseAt('soon', now), /at=/);
  assert.equal(parseAt('', now), null);
});

test('estimate: counts queued and deferred, one agent per task', async () => {
  const baseDir = tmp();
  // Same wave-11 spec update as the queue test above: the fake cwd
  // 'C:\\r' is refused at add time now, so queue against a real repo.
  const repo = makeRepo();
  await overnightCli(['add', 'one'], {baseDir, cwd: repo, settings: settingsStub});
  await overnightCli(['add', 'two'], {baseDir, cwd: repo, settings: settingsStub});
  const q = Q.loadQueue({baseDir});
  q.items[1].status = 'done'; Q.saveQueue(q, {baseDir});
  const est = Q.estimate(Q.loadQueue({baseDir}), {statuses: [{id: 'a', label: 'main', available: true}]});
  assert.deepEqual({tasks: est.tasks, agents: est.agents, accounts: est.accounts}, {tasks: 1, agents: 1, accounts: ['main']});
});

// --- account pick (§8.3) ------------------------------------------------------
test('pickAccount: least weekly use wins, unknown ranks below known, unavailable skipped', () => {
  const pick = Q.pickAccount([{id: 'a', available: true, percentUsed: 80}, {id: 'b', available: true, percentUsed: 20}, {id: 'c', available: false, percentUsed: 1}, {id: 'd', available: true, percentUsed: null}]);
  assert.equal(pick.account.id, 'b');
  const unk = Q.pickAccount([{id: 'd', available: true, percentUsed: null}, {id: 'e', available: true, percentUsed: 99}]);
  assert.equal(unk.account.id, 'e');
});
test('pickAccount: all exhausted -> earliest reset, no account', () => {
  const pick = Q.pickAccount([{id: 'a', available: true, percentUsed: 100, plan: {resetsAt: 5000}}, {id: 'b', available: true, quotaStatus: 'EXHAUSTED', percentUsed: 90, plan: {resetsAt: 3000}}]);
  assert.equal(pick.account, null);
  assert.equal(pick.waitUntil, 3000);
  assert.deepEqual(Q.pickAccount([]), {account: null, waitUntil: null});
});
test('parseSleepSeconds: AC index is the first hex value', () => {
  assert.equal(Q.parseSleepSeconds('  現在の AC 電源設定インデックス: 0x00000708\n  現在の DC 電源設定インデックス: 0x00000000'), 1800);
  assert.equal(Q.parseSleepSeconds('nothing'), null);
});

// --- worklog reader (sample log in the shape src/worklog.js writes) ----------
test('worklog: sample log summarises to badge ok; sensitive edit paths are dropped', () => {
  const dir = tmp();
  writeWorklog(dir, 'conv1', [
    {v: 1, at: '2026-11-07T00:00:00.000Z', session: 'conv1', event: 'turn', text: '直して', agent: 'main'},
    {v: 1, event: 'edit', path: 'src/a.js', op: 'edit', beforeHash: 'h1', afterHash: 'h2', added: 1, removed: 1, ranges: [{start: 1, end: 2}], diff: '-x\n+y'},
    {v: 1, event: 'edit', path: '.env', withheld: 'sensitive path'},
    {v: 1, event: 'tool', command: 'system.run', summary: 'npm test', ok: true, exitCode: 0, ms: 10, outChars: 6, outHead: 'pass 3', outHash: 'hh'},
    {v: 1, event: 'reply', text: '直しました', agent: 'main'},
    {v: 1, event: 'focus', focus: {status: 'complete'}},
    'this is not json',
  ]);
  const s = WL.summarizeWorklog('conv1', {baseDir: dir});
  assert.equal(s.found, true);
  assert.equal(s.badge, 'ok');
  assert.equal(s.turns, 1); assert.equal(s.edits, 2); assert.equal(s.tools, 1); assert.equal(s.badLines, 1);
  assert.deepEqual(s.files, ['src/a.js']);
});
test('worklog: badge stale when edits follow the last pass, fail when the last test failed, no-log when missing', () => {
  const dir = tmp();
  writeWorklog(dir, 'stale', [{event: 'tool', command: 'system.run', summary: 'npm test', ok: true}, {event: 'edit', path: 'src/b.js'}]);
  assert.equal(WL.summarizeWorklog('stale', {baseDir: dir}).badge, 'stale');
  writeWorklog(dir, 'fail', [{event: 'edit', path: 'src/b.js'}, {event: 'tool', command: 'system.run', summary: 'npm test', ok: false}]);
  assert.equal(WL.summarizeWorklog('fail', {baseDir: dir}).badge, 'fail');
  const none = WL.summarizeWorklog('missing', {baseDir: dir});
  assert.equal(none.found, false); assert.equal(none.badge, 'no-log');
});

// --- exec runner parsing (fake child, no real Muse) ------------------------
test('exec runner: parses the result line, tokens and declined tools', async () => {
  const runner = R.makeExecRunner({spawnFn: () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({type: 'tool', command: 'system.run', summary: 'npm test', ok: false, declined: true}) + '\n');
      child.stdout.emit('data', JSON.stringify({type: 'result', ok: true, session: 's1', reply: 'done', turnUsage: {inputTokens: 30, outputTokens: 12}}) + '\n');
      child.emit('close', 0);
    });
    return child;
  }});
  const r = await runner({item: {prompt: 'x'}, cwd: process.cwd(), account: null, mode: 'auto-edit'});
  assert.equal(r.ok, true); assert.equal(r.session, 's1'); assert.equal(r.tokens, 42);
  assert.equal(r.needsConfirmation, true); assert.match(r.declinedCommands[0], /npm test/);
});

// --- a full night, fake runner, real temp git repo ---------------------------
function seedQueue(baseDir, repo, prompts) {
  const q = {version: 1, items: []};
  for (const p of prompts) Q.addItem(q, {prompt: p, cwd: repo});
  Q.saveQueue(q, {baseDir});
  return q.items.map(i => i.id);
}
const noPower = () => ({sleepSeconds: 0, note: 'AC sleep is off'});
const noStatuses = async () => [];

test('run: done task lands on its own branch, user tree untouched, report saved', async () => {
  const repo = makeRepo(); const baseDir = tmp(); const wlDir = tmp();
  writeWorklog(wlDir, 'conv-done', [{event: 'edit', path: 'made.txt'}, {event: 'tool', command: 'system.run', summary: 'npm test', ok: true}]);
  const [id] = seedQueue(baseDir, repo, ['make a file']);
  const runner = async ({cwd}) => { fs.writeFileSync(path.join(cwd, 'made.txt'), 'overnight\n'); return {ok: true, reply: 'made it', session: 'conv-done', tokens: 100, questions: [{text: '色は青でよいですか', chosen: '青'}]}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower, worklogDir: wlDir});
  assert.equal(report.items.length, 1);
  const rec = report.items[0];
  assert.equal(rec.status, 'done'); assert.equal(rec.badge, 'ok'); assert.match(rec.branch, /^overnight\//);
  assert.equal(rec.questions.length, 1);
  // The branch holds the work; the user's tree is exactly as before.
  assert.equal(git(repo, ['show', rec.branch + ':made.txt']), 'overnight\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'hello\n');
  assert.equal(fs.existsSync(path.join(repo, 'made.txt')), false);
  // Queue + report on disk, under the overnight folder only.
  const q = Q.loadQueue({baseDir});
  assert.equal(q.items[0].status, 'done'); assert.equal(q.items[0].id, id);
  const saved = R.loadLatestReport({baseDir});
  assert.equal(saved.items[0].status, 'done');
  const lines = R.formatReport(report);
  assert.match(lines.join('\n'), /終わった/);
  assert.match(lines.join('\n'), /判断待ち: 色は青でよいですか（青）/);
});

test('run: a command needing confirmation defers the task to the morning', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['needs a command']);
  const runner = async () => ({ok: true, tokens: 5, needsConfirmation: true, declinedCommands: ['system.run npm test'], questions: []});
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower});
  assert.equal(report.items[0].status, 'deferred');
  const q = Q.loadQueue({baseDir});
  assert.equal(q.items[0].status, 'deferred');
  assert.match(q.items[0].questions.at(-1).text, /承認しますか/);
  assert.match(R.formatReport(report).join('\n'), /判断待ち/);
});

test('run: incomplete focus is blocked; a failed run is failed; order is the queue order', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['first', 'second']);
  const seen = [];
  const runner = async ({item}) => { seen.push(item.prompt); return item.prompt === 'first' ? {ok: true, tokens: 1, focusStatus: 'stalled', questions: []} : {ok: false, tokens: 2, error: 'boom', questions: []}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower});
  assert.deepEqual(seen, ['first', 'second']);
  assert.deepEqual(report.items.map(i => i.status), ['blocked', 'failed']);
  assert.equal(report.totalTokens, 3);
});

test('run: token cap stops between tasks and leaves the rest queued', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['a', 'b', 'c']);
  const runner = async () => ({ok: true, tokens: 100, questions: []});
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower, maxTokens: 150});
  assert.equal(report.items.length, 2);
  assert.equal(report.stoppedReason, 'token-cap');
  assert.equal(Q.loadQueue({baseDir}).items[2].status, 'queued');
});

test('run: task cap and non-git folder (blocked, never run in place)', async () => {
  const repo = makeRepo(); const baseDir = tmp(); const plain = tmp();
  // Spec update (wave 11): addItem validates the folder WHEN QUEUING —
  // a non-git folder is refused at add time with the git-repository
  // wording, instead of being queued and only failing during the night.
  // Reason: the night should not discover at 3am that a task can never
  // start. So the plain folder is refused here, up front:
  assert.throws(() => Q.addItem({version: 1, items: []}, {prompt: 'in plain folder', cwd: plain}), /git リポジトリではない/);
  const q = {version: 1, items: []};
  // A real git repository still queues through addItem exactly as before.
  Q.addItem(q, {prompt: 'in repo', cwd: repo});
  // The run-time guard still matters for an item that is already in the
  // queue file (queued before this spec change, or written by hand):
  // seed one directly, bypassing addItem, and it must still fail at run
  // time and never run in place.
  q.items.unshift({id: 'onlegacy0', prompt: 'in plain folder', cwd: plain, account: null, status: 'queued', createdAt: Date.now(), questions: []});
  Q.saveQueue(q, {baseDir});
  let calls = 0;
  const runner = async () => { calls++; return {ok: true, tokens: 1, questions: []}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower});
  assert.equal(calls, 1);
  assert.equal(report.items[0].status, 'failed');
  assert.match(report.items[0].error, /git リポジトリではない/);
});

test('run: all accounts exhausted stops the night; with wait= it sleeps to the reset and goes on', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['task']);
  const exhausted = async () => [{id: 'a', label: 'main', available: true, percentUsed: 100, plan: {resetsAt: Date.now() + 60000}}];
  let calls = 0;
  const runner = async () => { calls++; return {ok: true, tokens: 1, questions: []}; };
  const stopped = await R.runOvernight({baseDir, runner, statusesFn: exhausted, checkPower: noPower});
  assert.equal(stopped.stoppedReason, 'accounts-exhausted');
  assert.equal(calls, 0);
  // Now wait: first read exhausted, second read has room; sleep is fake.
  let reads = 0; const slept = [];
  const flaky = async () => (++reads === 1 ? [{id: 'a', available: true, percentUsed: 100, plan: {resetsAt: Date.now() + 5000}}] : [{id: 'a', available: true, percentUsed: 10, plan: {resetsAt: Date.now() + 5000}}]);
  const went = await R.runOvernight({baseDir, runner, statusesFn: flaky, checkPower: noPower, waitForReset: true, sleep: async ms => { slept.push(ms); }});
  assert.equal(calls, 1);
  assert.equal(went.items[0].status, 'done');
  assert.ok(slept.length >= 1 && slept[0] > 0 && slept[0] <= 5000);
  const q = Q.loadQueue({baseDir});
  assert.equal(q.items[0].account, 'a');
});

// Spec update (wave 15): results that did not land on the branch — here
// the secret-shaped file, which is deliberately never committed — are no
// longer reported 'done'. The task is 'uncommitted', the worktree is kept
// and its path is in the report; the committable file still lands.
test('run: secret-shaped files are not committed; the worktree is kept and named', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['make a secret and a file']);
  const runner = async ({cwd}) => { fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=x\n'); fs.writeFileSync(path.join(cwd, 'ok.txt'), 'ok\n'); return {ok: true, tokens: 1, questions: []}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower});
  const rec = report.items[0];
  assert.equal(rec.status, 'uncommitted');
  assert.match(rec.note, /秘密らしいファイル/);
  assert.ok(rec.worktree && fs.existsSync(rec.worktree), 'the kept worktree path is on the record');
  assert.match(R.formatReport(report).join('\n'), /未コミット/);
  assert.match(R.formatReport(report).join('\n'), /作業フォルダー:/);
  const names = git(repo, ['ls-tree', '-r', '--name-only', rec.branch]);
  assert.match(names, /ok\.txt/);
  assert.doesNotMatch(names, /\.env/);
  const q = Q.loadQueue({baseDir});
  assert.equal(q.items[0].status, 'uncommitted');
  assert.ok(q.items[0].worktree && fs.existsSync(path.join(q.items[0].worktree, '.env')));
  git(repo, ['worktree', 'remove', '--force', q.items[0].worktree]);
});

test('cli start: estimate lines come first, then the report (fake runner injected)', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  await overnightCli(['add', 'do it'], {baseDir, cwd: repo, settings: settingsStub});
  const out = await overnightCli(['start'], {baseDir, settings: settingsStub, statusesFn: noStatuses, run: {runner: async () => ({ok: true, tokens: 7, questions: []}), checkPower: noPower}});
  assert.match(out.lines[0], /見込み/);
  assert.match(out.lines.join('\n'), /夜間作業の報告/);
  assert.equal(out.report.items[0].status, 'done');
});

// Found on a real run (features-debug, Claude Code): the pool's least-used account
// answered HTTP 502, the night's only task failed, and the report said just "run failed".
test('run: an account that cannot connect is swapped once for another; the real error is kept', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['task one']);
  const statuses = async () => [{id: 'a', percentUsed: 10, available: true}, {id: 'b', percentUsed: 50, available: true}];
  const used = [];
  const runner = async ({account}) => { used.push(account); return account === 'a' ? {ok: false, error: 'Muse に接続できませんでした (HTTP 502)。', tokens: 0} : {ok: true, reply: 'done', tokens: 10}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: statuses, checkPower: noPower});
  assert.deepEqual(used, ['a', 'b']);
  assert.equal(report.items[0].status, 'done');
  assert.match(report.items[0].note || '', /a.*b/);
});

test('run: a named account is not swapped, and the failure says why', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['task one']);
  const statuses = async () => [{id: 'a', percentUsed: 10, available: true}, {id: 'b', percentUsed: 50, available: true}];
  const used = [];
  const runner = async ({account}) => { used.push(account); return {ok: false, error: 'Muse に接続できませんでした (HTTP 502)。', tokens: 0}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: statuses, checkPower: noPower, account: 'a'});
  assert.deepEqual(used, ['a']);
  assert.equal(report.items[0].status, 'failed');
  assert.match(report.items[0].error, /HTTP 502/);
});

test('exec runner: a result with ok:false carries its error into the run result', async () => {
  const {EventEmitter} = require('node:events');
  const spawnFn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit('data', JSON.stringify({type: 'result', ok: false, error: 'Muse に接続できませんでした (HTTP 502)。'}) + '\n'); c.emit('close', 1); }); return c; };
  const r = await R.makeExecRunner({spawnFn})({item: {prompt: 'x'}, cwd: '.', mode: 'auto-edit'});
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 502/);
});

// Found on a real run: worktrees under %LOCALAPPDATA%\muser made every edit ask
// (muser's own settings folder), so in edit-auto no task could change a file.
test('the default worktree folder is not inside muser\'s protected settings folder', () => {
  const {muserSettingsPath} = require('../src/policy.js');
  const Q = require('../src/overnight/queue.js');
  const dir = Q.worktreesDir();
  assert.equal(muserSettingsPath(path.join(dir, 'run-x', 'task', 'calc.js')), false, dir);
});

test('a test run that was declined (never ran) does not make the badge fail', () => {
  const WL = require('../src/overnight/worklog-read.js');
  const dir = tmp();
  writeWorklog(dir, 'conv-declined', [{event: 'edit', path: 'calc.js'}, {event: 'tool', command: 'system.run', summary: 'npm test', ok: false, error: 'The user declined this: headless run; the user can allow this with --mode auto-edit or bypass'}]);
  assert.equal(WL.summarizeWorklog('conv-declined', {baseDir: dir}).badge, 'none');
});

// --- wave 15: queue locking, three-way merge, run lock, uncommitted ---------
test('wave15 updateQueue: a throwing mutator saves nothing; the return value passes through', () => {
  const baseDir = tmp(); const repo = makeRepo();
  seedQueue(baseDir, repo, ['keep me']);
  assert.throws(() => Q.updateQueue(() => { throw new Error('nope'); }, {baseDir}), /nope/);
  assert.equal(Q.loadQueue({baseDir}).items.length, 1);
  const n = Q.updateQueue(q => q.items.length, {baseDir});
  assert.equal(n, 1);
});

test('wave15 queue lock: two processes adding at once lose nothing', async () => {
  const baseDir = tmp(); const repo = makeRepo();
  const {spawn} = require('node:child_process');
  const child = tag => new Promise((resolve, reject) => {
    const script = 'const Q=require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'overnight', 'queue.js')) + ');' +
      'for(let i=0;i<20;i++) Q.updateQueue(q=>Q.addItem(q,{prompt:' + JSON.stringify(tag) + '+"-"+i,cwd:' + JSON.stringify(repo) + '}),{baseDir:' + JSON.stringify(baseDir) + '});';
    const c = spawn(process.execPath, ['-e', script], {windowsHide: true});
    let err = ''; c.stderr.on('data', d => { err += d; });
    c.on('error', reject); c.on('close', code => code === 0 ? resolve() : reject(new Error('child ' + tag + ' exited ' + code + ': ' + err)));
  });
  await Promise.all([child('alpha'), child('beta')]);
  const items = Q.loadQueue({baseDir}).items;
  assert.equal(items.length, 40, 'every add from both processes survived');
  assert.equal(new Set(items.map(i => i.prompt)).size, 40);
});

test('wave15 mergeQueueForRun: disk deletions drop, disk additions survive, untouched takes disk, touched takes memory', () => {
  const a = {id: 'a', prompt: 'a', status: 'queued'};
  const b = {id: 'b', prompt: 'b', status: 'queued'};
  const c = {id: 'c', prompt: 'c', status: 'queued'};
  const memory = {version: 1, items: [a, b, c]};
  const baseline = Q.snapshotQueue(memory);
  b.status = 'done'; // the run changed b
  const diskB = {id: 'b', prompt: 'b', status: 'queued'}; // disk still has the baseline b
  const diskC = {id: 'c', prompt: 'c edited elsewhere', status: 'deferred'}; // c changed on disk only
  const diskD = {id: 'd', prompt: 'd', status: 'queued'}; // added on disk during the run
  const merged = Q.mergeQueueForRun(memory, baseline, {version: 1, items: [diskB, diskC, diskD]}); // a removed on disk
  assert.deepEqual(merged.map(i => i.id), ['b', 'c', 'd'], 'a dropped, d kept after the run items');
  assert.equal(merged[0].status, 'done', 'the run version wins for an item the run touched');
  assert.equal(merged[1].prompt, 'c edited elsewhere', 'the disk version wins for an untouched item');
  assert.equal(merged[1], c, 'surviving memory objects keep their identity');
});

test('wave15 run: an item removed mid-run is not run; an item added mid-run survives in the queue', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  const [, secondId] = seedQueue(baseDir, repo, ['first task', 'second task']);
  const seen = [];
  const runner = async ({item, cwd}) => {
    seen.push(item.prompt);
    fs.writeFileSync(path.join(cwd, 'made.txt'), 'x\n');
    // Another window acts while the first task runs (through updateQueue,
    // exactly what the CLI does now): remove the second task, add a third.
    Q.updateQueue(q => { Q.removeItem(q, secondId); }, {baseDir});
    Q.updateQueue(q => { Q.addItem(q, {prompt: 'third task', cwd: repo}); }, {baseDir});
    return {ok: true, tokens: 1, questions: []};
  };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower});
  assert.deepEqual(seen, ['first task'], 'the removed task never ran');
  assert.deepEqual(report.items.map(i => i.status), ['done', 'skipped']);
  assert.match(report.items[1].note, /外されていたため実行しませんでした/);
  const q = Q.loadQueue({baseDir});
  assert.deepEqual(q.items.map(i => i.prompt), ['first task', 'third task']);
  assert.equal(q.items[0].status, 'done');
  assert.equal(q.items[1].status, 'queued');
});

test('wave15 run lock: a live holder refuses a second run; a dead pid lock is reclaimed', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['task']);
  const release = Q.acquireRunLock({baseDir});
  await assert.rejects(() => R.runOvernight({baseDir, runner: async () => ({ok: true, tokens: 0, questions: []}), statusesFn: noStatuses, checkPower: noPower}), /すでに実行中です/);
  release();
  assert.equal(fs.existsSync(Q.runLockFile({baseDir})), false, 'the lock is released after the refusal');
  // A lock left by a process that no longer exists is reclaimed.
  const dead = spawnSync(process.execPath, ['-e', ''], {windowsHide: true});
  fs.writeFileSync(Q.runLockFile({baseDir}), 'deadbeef:' + dead.pid, 'utf8');
  const release2 = Q.acquireRunLock({baseDir});
  release2();
  // And a normal run works afterwards (the lock does not wedge the queue).
  const report = await R.runOvernight({baseDir, runner: async () => ({ok: true, tokens: 0, questions: []}), statusesFn: noStatuses, checkPower: noPower});
  assert.equal(report.items[0].status, 'done');
});

test('wave15 run: a failed commit is uncommitted (not done), the worktree is kept and its path reported', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['make a file but commit fails']);
  const {defaultRunGit} = require('../src/overnight/worktree');
  const runGit = (args, cwd) => args.includes('commit') ? {ok: false, stdout: '', stderr: 'commit boom'} : defaultRunGit(args, cwd);
  const runner = async ({cwd}) => { fs.writeFileSync(path.join(cwd, 'made.txt'), 'x\n'); return {ok: true, tokens: 1, questions: []}; };
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower, runGit});
  const rec = report.items[0];
  assert.equal(rec.status, 'uncommitted');
  assert.match(rec.note, /コミットできませんでした/);
  assert.ok(rec.worktree && fs.existsSync(path.join(rec.worktree, 'made.txt')), 'the results are still in the kept worktree');
  const lines = R.formatReport(report).join('\n');
  assert.match(lines, /未コミット/);
  assert.ok(lines.includes(rec.worktree), 'the report names the kept worktree path');
  const q = Q.loadQueue({baseDir});
  assert.equal(q.items[0].status, 'uncommitted');
  assert.equal(q.items[0].worktree, rec.worktree);
  git(repo, ['worktree', 'remove', '--force', rec.worktree]);
});

test('wave15 run: a task that changes nothing is done and the report says 変更なし', async () => {
  const repo = makeRepo(); const baseDir = tmp();
  seedQueue(baseDir, repo, ['look only']);
  const runner = async () => ({ok: true, tokens: 1, questions: []});
  const report = await R.runOvernight({baseDir, runner, statusesFn: noStatuses, checkPower: noPower});
  const rec = report.items[0];
  assert.equal(rec.status, 'done');
  assert.equal(rec.note, '変更なし');
  assert.equal(rec.worktree, null);
});

test('wave15 sleepUntil: clock setbacks extend the budget while a remainder is left; a frozen clock still stops', async () => {
  let clock = 0; let setbacks = 150; let sleeps = 0;
  const now = () => clock;
  const sleep = async ms => { sleeps++; clock += ms; if (setbacks > 0 && clock > 1000) { clock -= 2500; setbacks--; } };
  await R.sleepUntil(3000, now, sleep);
  assert.ok(clock >= 3000, 'it waited until the (repeatedly set-back) target, clock=' + clock);
  assert.ok(sleeps > 130, 'more chunks than the original 3000ms budget of 123, sleeps=' + sleeps);
  let frozenSleeps = 0;
  await R.sleepUntil(1000, () => 0, async () => { frozenSleeps++; });
  assert.ok(frozenSleeps > 0 && frozenSleeps <= 130, 'a clock that never moves exhausts the budget instead of spinning, sleeps=' + frozenSleeps);
});
