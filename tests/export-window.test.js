'use strict';
// Stage 2 (B2): `muser export --window`. The window answers a request
// file with its current snapshot + events ring (WindowStatus), the
// collector reads it back; a window that never answers contributes its
// newest hang record instead. The end-to-end case uses a plain sleeper
// process as the window: it cannot answer, so its report section says
// answered:false and carries the shape from its status file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');

const sessions = require('../src/sessions');
const store = require('../src/secure-store');
const {WindowStatus} = require('../src/window-status');
const winMod = require('../src/export-window');

const BIN = path.join(__dirname, '..', 'bin', 'muser.js');

test('WindowStatus answers an export request with state and events', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-winreq-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, process.pid + '.json');
  const ctrl = {get: () => ({mode: 'default', entries: [], todos: [], agents: [], shells: [], queue: []}), subscribe: () => () => {}};
  const agent = {session: {id: 'sess-window-1', turns: 2, title: 'x'}, cwd: 'C:\\work', client: {status: 'ok'}};
  const ws = new WindowStatus({ctrl, agent, file});
  ws.eventSource = {list: () => [{type: 'key', kind: 'char', at: 1}]};
  const timer = setInterval(() => ws.answerRequests(), 25);
  t.after(() => clearInterval(timer));
  const got = await winMod.collectWindow(process.pid, {dir, timeoutMs: 3000, pollMs: 25});
  assert.equal(got.answered, true);
  assert.equal(got.state.session.id, 'sess-window-1');
  assert.deepEqual(got.events, [{type: 'key', kind: 'char', at: 1}]);
});

test('latestHang picks the newest hang record for the pid only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-hang-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({kind: 'hang', pid: 4242, thresholdMs: 5000, stack: [{fn: 'f', file: 'a.js', line: 1, column: 2}]}));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({kind: 'hang', pid: 9999, stack: []}));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({error: 'plain crash', pid: 4242}));
  const hang = winMod.latestHang(4242, dir);
  assert.ok(hang && hang.stack.length === 1 && hang.stack[0].fn === 'f');
  assert.equal(winMod.latestHang(31337, dir), null);
});

test('export --window --dry-run: an unanswering window reports answered:false with its shape', async t => {
  const s = sessions.create('C:\\work');
  s.turns = 1;
  sessions.save(s);
  sessions.appendTurn(s.id, {v: 1, at: 1762470000000, user: 'x', reply: 'y', tools: [], progress: [], steps: [], todos: []});
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
  t.after(() => { try { child.kill(); } catch {} });
  await new Promise(r => child.on('spawn', r));
  const winDir = path.join(store.DIR, 'windows');
  fs.mkdirSync(winDir, {recursive: true});
  const winFile = path.join(winDir, child.pid + '.json');
  const nowIso = new Date().toISOString();
  fs.writeFileSync(winFile, JSON.stringify({version: 1, kind: 'window', pid: child.pid, startedAt: nowIso, updatedAt: nowIso, cwd: 'C:\\work', mode: 'default', account: null, session: {id: s.id, title: 'x', turns: 1}, connected: true, activity: 'idle', todos: [{content: 'todo text stays home', status: 'pending'}], agents: [], shells: [], toolLog: [], progress: []}));
  t.after(() => { try { fs.unlinkSync(winFile); } catch {} });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-window-out-'));
  t.after(() => fs.rmSync(outDir, {recursive: true, force: true}));
  const r = spawnSync(process.execPath, [BIN, 'export', '--window', String(child.pid), '--dry-run'], {encoding: 'utf8', timeout: 30000, env: {...process.env, MUSER_EXPORT_DIR: outDir}});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const file = fs.readdirSync(outDir).find(f => f.endsWith('.json'));
  assert.ok(file, 'a report file was written: ' + r.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
  assert.equal(report.window.pid, child.pid);
  assert.equal(report.window.answered, false);
  assert.equal(report.window.hang, null);
  assert.deepEqual(report.window.todos, {count: 1, byStatus: {pending: 1}});
  assert.ok(!JSON.stringify(report).includes('todo text stays home'));
  assert.equal(report.session.id, s.id);
});
