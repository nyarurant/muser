'use strict';
// Bugs found in the 2026-11-01 sweep, one test each.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

test('a read-only rg / git grep that reaches secrets asks instead of running unasked', () => {
  const {decide} = require('../src/policy');
  const d = c => decide({mode: 'default', kind: 'exec', params: {command: c}, cwd: process.cwd(), gitConfig: () => ''});
  for (const c of ['rg -e TODO src', 'rg -n foo', 'git grep -n TODO']) assert.equal(d(c), 'allow', c);
  for (const c of ['rg --hidden -e .', 'rg -uu -e key', 'rg --no-ignore -e x', 'rg -L -e x', 'rg -e . ' + path.join(os.homedir(), '.ssh'), 'rg -e x ~/.aws', 'rg -e x .env', 'git grep --no-index -e x'])
    assert.equal(d(c), 'ask', c);
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: 'rg --hidden -e .'}, cwd: process.cwd(), gitConfig: () => ''}), 'deny');
});

test('todo.write takes the list as an array as well as JSON text, and skips junk entries', () => {
  const {TOOLS} = require('../src/tools');
  const ctx = {todos: []};
  TOOLS['todo.write'].run({todos: [{content: 'a', status: 'in_progress'}, null, 'x', {content: 'b'}]}, ctx);
  assert.deepEqual(ctx.todos, [{content: 'a', status: 'in_progress'}, {content: 'b', status: 'pending'}]);
  TOOLS['todo.write'].run({todos: JSON.stringify([{content: 'c', status: 'completed'}])}, ctx);
  assert.deepEqual(ctx.todos, [{content: 'c', status: 'completed'}]);
});

test("a stale device token is replaced by the one another window saved, without a refresh", async () => {
  const {PcAuth} = require('../src/core/pc-auth');
  let disk = {nodeId: 'n', sdkToken: 's', device: {access_token: 'old', refresh_token: 'r:1'}};
  const calls = [];
  const a = new PcAuth({load: () => disk, save: v => { disk = v; }, expectedVm: async () => 'vm1',
    request: async (scope, route, body, bearer) => {
      calls.push(route + ' ' + bearer);
      if (route === '/fetch_vms') { if (bearer === 'new') return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'x'}]}; throw Object.assign(new Error('401'), {status: 401}); }
      throw new Error('no refresh expected');
    }});
  disk = {...disk, device: {access_token: 'new', refresh_token: 'r:2'}}; // another window refreshed
  const vm = await a.lookupVm();
  assert.equal(vm.vm_id, 'vm1');
  assert.deepEqual(calls, ['/fetch_vms old', '/fetch_vms new']);
});

function agent(cwd = process.cwd()) {
  const {Agent} = require('../src/agent');
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1}; client.cancel = async () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm'); }}, cwd, session: {id: 'm', cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  return a;
}

test('agent.wait with a tag that names no agent says so instead of "all done"', async () => {
  const a = agent();
  a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  const r = await a.execute('agent.wait', {tags: 'a9', timeout_s: 1}, 5000, 'w1');
  assert.equal(r.ok, false);
  assert.match(r.error, /No parallel agent with tag a9/);
});

test('esc stops the agents Muse started for the task, not the ones the user started', async () => {
  const a = agent();
  const main = a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  a.runTurn = async w => { w.turn = {controller: new AbortController()}; };
  const bySelf = a.spawn('muse task', {by: 'muse'}), byUser = a.spawn('user task', {by: 'user'});
  await a.interrupt();
  assert.equal(main.controller.signal.aborted, true);
  assert.equal(bySelf.turn.controller.signal.aborted, true, "Muse's agent stops with the task");
  assert.equal(byUser.turn.controller.signal.aborted, false, "the user's /agent keeps going");
});

test('a one-shot command that reads stdin gets EOF instead of waiting out the timeout', async () => {
  const {runOnce} = require('../src/shells');
  const t0 = Date.now();
  const r = await runOnce('git shortlog -sn', {cwd: process.cwd(), timeout: 20000, maxOut: 1e6, clip: s => s});
  assert.equal(r.killed, '');
  assert.ok(Date.now() - t0 < 10000);
  // t4 #10: EOF alone used to pass even if the command had failed — assert
  // the run's result too. shortlog with no revision reads its log from
  // stdin: the EOF is exactly why the output is empty (defaulting to HEAD
  // would list this repo's authors instead).
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'stdin was at EOF, so shortlog had nothing to summarise');
});

test("/new and /resume start the next chat with an empty todo list (not the old chat's)", async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const a = new EventEmitter();
  Object.assign(a, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: [{content: 'old', status: 'pending'}]}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  a.constructor.DEVICE = 'test';
  const ctrl = new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
  ctrl.slash('/new');
  assert.deepEqual(a.ctx.todos, []);
});

test("Muse's own web searches about devices are shown; its records of calls to this PC are not", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'muse-steps.js'), 'utf8');
  const DEVICE = new RegExp(/const DEVICE = \/(.*)\/i;/.exec(src)[1], 'i');
  for (const s of ['Listed paired devices', 'Device command failed: code.read on package.json', 'Ran code.read on MIZUKI CLI (muser)']) assert.ok(DEVICE.test(s), s);
  for (const s of ['Found 16 web results for best Android devices', 'Searched memory for devices I own']) assert.ok(!DEVICE.test(s), s);
});

test('system.run with a cwd that does not exist says so (not "spawn powershell.exe ENOENT")', async () => {
  const {TOOLS} = require('../src/tools');
  await assert.rejects(TOOLS['system.run'].run({command: 'echo hi', cwd: 'no-such-folder'}, {cwd: process.cwd(), readFiles: new Set(), todos: []}), /cwd is not an existing folder/);
});

test('the approval box warns about a write on another drive', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const a = new EventEmitter();
  Object.assign(a, {mode: 'default', cwd: 'C:/work/proj', session: {id: 'x', turns: 0}, ctx: {cwd: 'C:/work/proj', readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
  ctrl.ask({command: 'code.write', kind: 'edit', params: {path: 'D:/data/x.txt', content: 'x'}, summary: 'x', demoPreview: {diff: []}});
  assert.equal(ctrl.get().approval.outside, true);
  ctrl.ask({command: 'code.write', kind: 'edit', params: {path: 'C:/work/proj/a.txt', content: 'x'}, summary: 'x', demoPreview: {diff: []}});
});

test('ctrl+d exits only when pressed twice, like ctrl+c', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const a = new EventEmitter();
  Object.assign(a, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  let exits = 0;
  const ctrl = new Controller({agent: a, museName: 'm', version: 't', onExit() { exits++; }});
  ctrl.key('d', {ctrl: true});
  assert.equal(exits, 0);
  ctrl.key('d', {ctrl: true});
  assert.equal(exits, 1);
});
