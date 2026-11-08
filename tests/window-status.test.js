'use strict';
// A plain muser window's live state (src/window-status.js) and `muser status` listing it with the
// server's conversations and running exec runs (src/server/status.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const ws = require('../src/window-status');
const status = require('../src/server/status');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-windows-'));
async function window(t, folder) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {mode: 'default', cwd: 'C:\\work\\proj', session: {id: 'abcdef12-3456', turns: 4, title: 'fix the parser'}, ctx: {readFiles: new Set(), todos: []},
    client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}, accountId: 'default', accountLabel: 'メイン', nodeSlot: {slot: 2}});
  agent.constructor.DEVICE = 'test';
  const ctrl = new Controller({agent, museName: 'Muse', version: 't', onExit() {}});
  const file = path.join(folder, process.pid + '.json');
  const w = new ws.WindowStatus({ctrl, agent, file}).start();
  t.after(() => w.stop());
  return {agent, ctrl, w, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8'))};
}

test('the window writes what it is doing: activity, the running tool, todos, Focus, agents — not what is typed', async t => {
  const folder = tmp(), {ctrl, w, read} = await window(t, folder);
  let v = read();
  assert.equal(v.kind, 'window'); assert.equal(v.pid, process.pid); assert.equal(v.activity, 'idle');
  assert.deepEqual(v.account, {id: 'default', label: 'メイン'}); assert.equal(v.session.id, 'abcdef12-3456'); assert.equal(v.slot, 2);
  ctrl.set({text: 'secret draft the user is typing', busy: true, turnStart: Date.now() - 5000,
    running: {call: {id: 'c1', agent: 'main', command: 'system.run', summary: 'npm test'}, tail: []},
    todos: [{content: 'read', status: 'completed'}, {content: 'fix', status: 'in_progress'}],
    focus: {status: 'running', round: 2, maxRounds: 10, reason: 'Some criteria remain unmet.', criteria: [{id: 'c1', status: 'met'}, {id: 'c2', status: 'unmet'}]},
    agents: [{tag: 'a1', type: 'explore', title: 'look into auth', state: 'working', lastTool: 'Read', started: Date.now() - 3000, ended: 0}], queue: ['next']});
  w.write(); v = read();
  assert.equal(v.activity, 'working');
  assert.deepEqual(v.running && {command: v.running.command, summary: v.running.summary}, {command: 'system.run', summary: 'npm test'});
  assert.ok(v.running.since, 'when the running tool started');
  assert.equal(v.todos.length, 2);
  assert.deepEqual({s: v.focus.status, r: v.focus.round, met: v.focus.met, total: v.focus.total, open: v.focus.open}, {s: 'running', r: 2, met: 1, total: 2, open: ['c2']});
  assert.equal(v.agents[0].state, 'working'); assert.equal(v.queue, 1);
  assert.ok(!JSON.stringify(v).includes('secret draft'), 'the input box is never written');
  ctrl.set({approval: {call: {agent: 'main', command: 'code.edit', summary: 'src/a.js'}, options: [], index: 0}});
  w.write(); assert.equal(read().activity, 'approval'); assert.equal(read().approval.command, 'code.edit');
  assert.ok(read().approval.since, 'when the approval was asked, so the list says how long it has waited');
  const {formatWindow} = require('../src/server/status');
  assert.match(formatWindow(read(), Date.parse(read().approval.since) + 90000)[0], /承認待ち 1 分/, 'the wait is counted from the ask, not the turn start');
});

test('changes reach the file within a second; finished tools and turns are logged; closing removes it', async t => {
  const folder = tmp(), {agent, ctrl, w, file, read} = await window(t, folder);
  ctrl.set({busy: true, turnStart: Date.now()});
  // Poll for the throttled write to land instead of sleeping THROTTLE_MS + a
  // fixed margin: the flush happens within one throttle interval, whenever
  // the timer fires, so wait for the state itself (5 s cap).
  const until = Date.now() + 5000;
  while (read().activity !== 'working' && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  assert.equal(read().activity, 'working');
  agent.emit('tool-end', {agent: 'main', command: 'code.read', summary: 'src/a.js', ok: true});
  agent.emit('tool-end', {agent: 'a1', command: 'code.edit', summary: 'src/b.js', ok: false, error: 'old_string not found'});
  agent.emit('turn-end', {ok: true, ms: 1200});
  w.write();
  const v = read();
  assert.deepEqual(v.toolLog.map(x => [x.agent, x.command, x.ok]), [['main', 'code.read', true], ['a1', 'code.edit', false]]);
  assert.equal(v.toolLog[1].error, 'old_string not found');
  assert.equal(v.lastTurn.ok, true);
  w.stop();
  assert.ok(!fs.existsSync(file), 'the file goes with the window');
});

test('readAll lists live windows only: a gone pid or a stopped heartbeat is skipped, and prune removes them', () => {
  const folder = tmp(), now = Date.now();
  const put = (pid, updatedAt) => fs.writeFileSync(path.join(folder, pid + '.json'), JSON.stringify({version: 1, kind: 'window', pid, startedAt: new Date(now - 60000).toISOString(), updatedAt: new Date(updatedAt).toISOString()}));
  put(101, now - 1000); put(102, now - 1000); put(103, now - 5 * 60000);
  fs.writeFileSync(path.join(folder, '104.json'), '{broken');
  const isAlive = pid => pid !== 102;
  assert.deepEqual(ws.readAll({folder, isAlive, now}).map(v => v.pid), [101]);
  ws.prune({folder, isAlive, now});
  assert.deepEqual(fs.readdirSync(folder).sort(), ['101.json']);
});

test('muser status lists windows, server conversations and running exec runs; an id shows one in detail', () => {
  const now = Date.now(), at = ms => new Date(now - ms).toISOString();
  const win = {kind: 'window', pid: 4242, activity: 'working', turnStartedAt: at(12 * 60000), connected: true, cwd: 'C:\\work\\proj', account: {id: 'default', label: 'メイン'},
    session: {id: 'abcdef12-3456', title: 'fix the parser'}, focus: {status: 'running', round: 3, maxRounds: 10, met: 2, total: 5, open: ['c3', 'c4', 'c5'], reason: 'Some criteria remain unmet.'},
    agents: [{tag: 'a1', state: 'working', title: 'tests', startedAt: at(60000)}, {tag: 'a2', state: 'done', title: 'docs', startedAt: at(90000), endedAt: at(10000)}],
    running: {agent: 'main', command: 'system.run', summary: 'npm test', since: at(20000)}, queue: 0,
    todos: [{content: 'read', status: 'completed'}, {content: 'fix', status: 'in_progress'}],
    toolLog: [{agent: 'main', command: 'code.read', summary: 'src/a.js', ok: true, at: at(30000)}], progress: [{agent: 'main', message: 'テストを実行しています', at: at(25000)}]};
  const exec = {version: 1, state: 'running', pid: 777, cwd: 'C:\\other', prompt: 'review the diff\nmore', startedAt: at(3 * 60000), updatedAt: at(1000), tools: 9, last: 'code.grep TODO', session: 'feedbeef'};
  const servers = [{kind: 'server', pid: 1, port: 2, version: 'v', startedAt: now, sessions: [{id: '72c7410c-x', cwd: 'C:\\srv', busy: false}], accounts: [], states: {}}];
  const all = {windows: [win], servers, execs: [exec]};
  const text = status.formatAll(all, now).join('\n');
  assert.match(text, /muser の窓\n  pid 4242  作業中 12 分  アカウント: メイン  C:\\work\\proj/);
  assert.match(text, /会話 abcdef12 「fix the parser」 · Focus: running 3\/10 ✓2\/5 · エージェント 1 体が作業中/);
  assert.match(text, /実行中: system\.run\(npm test\) \(20 秒\)/);
  assert.match(text, /Todo: fix（1\/2 完了）/);
  assert.match(text, /Muser Server: pid 1/);
  assert.match(text, /muser exec（実行中）\n  pid 777  作業中 3 分/);
  assert.match(text, /「review the diff」 · ツール 9 回/);
  assert.equal(status.find(all, '4242').kind, 'window');
  assert.equal(status.find(all, 'abcdef').kind, 'window');
  assert.equal(status.find(all, '777').kind, 'exec');
  assert.equal(status.find(all, '72c7').kind, 'server');
  assert.equal(status.find(all, 'zzz'), null);
  const detail = status.formatDetail(status.find(all, '4242'), now).join('\n');
  assert.match(detail, /未完: c3, c4, c5 — Some criteria remain unmet\./);
  assert.match(detail, /エージェント\n  a1  working  tests/);
  assert.match(detail, /最近のツール\n  ✓ code\.read\(src\/a\.js\)/);
  assert.match(detail, /経過報告\n  テストを実行しています/);
  assert.deepEqual(status.formatAll({}, now), ['開いている窓はありません。']);
});

test('muser status reads the real folders: a window file and a running exec file show up; --json is the same as data', async () => {
  const execStatus = require('../src/exec-status');
  fs.mkdirSync(ws.dir(), {recursive: true}); fs.mkdirSync(execStatus.dir(), {recursive: true});
  const now = new Date().toISOString();
  const wf = ws.fileFor(process.pid), ef = path.join(execStatus.dir(), '20261104-000000-' + process.pid + '.json');
  fs.writeFileSync(wf, JSON.stringify({version: 1, kind: 'window', pid: process.pid, startedAt: now, updatedAt: now, activity: 'idle', cwd: 'C:\\w', connected: true}));
  fs.writeFileSync(ef, JSON.stringify({version: 1, state: 'running', pid: process.pid, startedAt: now, updatedAt: now, cwd: 'C:\\e', tools: 1}));
  try {
    const all = await status.gatherAll({readServer: () => null, readGui: () => null});
    // t6 #11 (deep audit): exact-equality here assumed this process is the
    // ONLY live window/exec in the real folders — false when the suite runs
    // inside a muser window (system.run), whose own fresh status files then
    // join the list and fail a correct implementation. The test's claim is
    // that OUR files show up; assert exactly that.
    assert.ok(all.windows.some(w => w.pid === process.pid), 'the window file written into the real folder is listed');
    assert.ok(all.execs.some(v => v.pid === process.pid), 'the running exec file written into the real folder is listed');
    assert.deepEqual(all.servers, []);
  } finally { fs.rmSync(wf, {force: true}); fs.rmSync(ef, {force: true}); }
});

test('turn-end usage lands in lastTurn and in the muser status detail line; nothing extra without it', async t => {
  const folder = tmp(), {agent, w, read} = await window(t, folder);
  agent.emit('turn-end', {ok: true, ms: 12000, usage: {inputTokens: 130841, outputTokens: 395, source: 'provider', formatted: '130.8k in / 395 out'}});
  w.write();
  const v = read();
  assert.equal(v.lastTurn.usage.formatted, '130.8k in / 395 out', 'the window file keeps the event\'s formatted text verbatim — only the detail line below re-formats it');
  assert.equal(v.lastTurn.usage.source, 'provider');
  const now = Date.parse(v.lastTurn.endedAt) + 60000;
  const detail = status.formatDetail({kind: 'window', item: v}, now).join('\n');
  // Wave 7 spec update: the detail line re-formats from the numbers via
  // usageText/formatUsage, so its in/out words are the UI language's
  // （入 / 出） now, not the stored English text asserted above.
  assert.match(detail, /前のターン: 完了.*130\.8k 入 \/ 395 出/);
  agent.emit('turn-end', {ok: true, ms: 1000});
  w.write();
  assert.equal(read().lastTurn.usage, undefined, 'no usage on the next turn, no stale numbers');
});
