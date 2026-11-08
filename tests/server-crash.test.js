'use strict';
// Muser Server crash isolation (FOCUS-WEAKNESSES.md #11): one conversation's
// uncaught error must not take the whole server down, and a fatal error
// restarts the server at most 5 times in 10 minutes. The child-process
// tests below use real unhandled rejections; the live test runs a real
// GuiServer + SessionsHost and checks the other conversation still answers.
// Nothing here touches the resident server or ~/.muser: crash reports go to
// temp dirs (MUSER_CRASH_DIR) and restart state to temp files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const serverCrash = require('../src/server/server-crash');

function tmpDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-server-crash-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function crashFiles(dir) { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }

test('sessionIdOf finds the conversation on the error, its cause, or session.id', () => {
  assert.equal(serverCrash.sessionIdOf(Object.assign(new Error('x'), {sessionId: 's1'})), 's1');
  assert.equal(serverCrash.sessionIdOf(Object.assign(new Error('x'), {conversationId: 's2'})), 's2');
  assert.equal(serverCrash.sessionIdOf(new Error('x', {cause: Object.assign(new Error('y'), {sessionId: 's3'})})), 's3');
  assert.equal(serverCrash.sessionIdOf(Object.assign(new Error('x'), {session: {id: 's4'}})), 's4');
  assert.equal(serverCrash.sessionIdOf(new Error('x')), null);
  assert.equal(serverCrash.sessionIdOf(Object.assign(new Error('x'), {sessionId: 42})), null);
});

test('restart budget: 5 restarts in 10 minutes are allowed, the 6th is not; old ones do not count', t => {
  const file = path.join(tmpDir(t), 'restarts.json');
  const now = Date.now();
  assert.equal(serverCrash.restartAllowed(file, now), true);
  for (let i = 0; i < 5; i++) serverCrash.recordRestart(file, now + i * 1000);
  assert.equal(serverCrash.restartAllowed(file, now + 6000), false);
  assert.equal(serverCrash.restartAllowed(file, now + 11 * 60 * 1000), true);
});

test('tryRestart spawns a fresh server while budget remains, and stops when it is spent', t => {
  const file = path.join(tmpDir(t), 'restarts.json');
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { spawned.push({cmd, args, opts}); return {unref() {}}; };
  const now = Date.now();
  for (let i = 0; i < 5; i++) assert.equal(serverCrash.tryRestart({spawnFn, stateFile: file, argv: ['serve', '--port', '0'], now: now + i}), true);
  assert.equal(spawned.length, 5);
  assert.equal(spawned[0].cmd, process.execPath);
  assert.deepEqual(spawned[0].args, ['serve', '--port', '0']);
  assert.equal(serverCrash.tryRestart({spawnFn, stateFile: file, now: now + 6}), false);
  assert.equal(spawned.length, 5);
});

test('handler: an error naming an open conversation closes only it and records the crash', async t => {
  const dir = tmpDir(t);
  const written = [];
  const closed = [];
  const host = {get: id => (id === 'bad' || id === 'good') ? {id} : null, closeSync: id => closed.push(id)};
  const exits = [];
  const handle = serverCrash.createServerCrashHandler({version: '9.9.9', host,
    crashWrite: input => { written.push(input); return path.join(dir, 'r.json'); },
    exit: code => exits.push(code)});
  const r = await handle('unhandledRejection', Object.assign(new Error('boom in background work'), {sessionId: 'bad'}));
  assert.equal(r.handled, 'session');
  assert.deepEqual(closed, ['bad']);
  assert.equal(written.length, 1);
  assert.equal(written[0].sessionId, 'bad');
  assert.equal(written[0].scope, 'session');
  assert.deepEqual(exits, []);
});

test('handler: an error naming no conversation is fatal — onFatal runs, no exit from the handler itself', async () => {
  const fatals = [];
  const exits = [];
  const handle = serverCrash.createServerCrashHandler({version: '9.9.9', host: {get: () => null},
    crashWrite: input => { assert.equal(input.scope, 'fatal'); return '/tmp/r.json'; },
    exit: code => exits.push(code),
    onFatal: async (error, info) => { fatals.push({message: error.message, file: info.file}); }});
  const r = await handle('uncaughtException', new Error('fatal boom'));
  assert.equal(r.handled, 'fatal');
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].message, 'fatal boom');
  assert.deepEqual(exits, []);
});

test('handler: without onFatal, a fatal error exits 0 after respawning, or 1 when the budget is spent', async t => {
  const dir = tmpDir(t);
  const stateFile = path.join(dir, 'restarts.json');
  const spawned = [];
  const spawnFn = () => { spawned.push(1); return {unref() {}}; };
  const exits = [];
  const handle = serverCrash.createServerCrashHandler({version: '9.9.9', host: {get: () => null},
    crashWrite: () => path.join(dir, 'r.json'), exit: code => exits.push(code), spawnFn, stateFile});
  const r = await handle('uncaughtException', new Error('fatal boom'));
  assert.equal(r.handled, 'fatal');
  assert.equal(r.restarted, true);
  assert.deepEqual(exits, [0]);
  assert.equal(spawned.length, 1);
  // Spend the budget, then the same fatal error exits 1 with no respawn.
  const now = Date.now();
  for (let i = 0; i < 5; i++) serverCrash.recordRestart(stateFile, now + i);
  exits.length = 0;
  const r2 = await handle('uncaughtException', new Error('fatal boom again'));
  assert.equal(r2.restarted, false);
  assert.deepEqual(exits, [1]);
  assert.equal(spawned.length, 1);
});

test('install/uninstall adds and removes the process handlers', () => {
  const before = process.listenerCount('unhandledRejection');
  const uninstall = serverCrash.installServerCrashHandlers({version: '9.9.9', host: {get: () => null}, onFatal: async () => {}});
  assert.equal(process.listenerCount('unhandledRejection'), before + 1);
  uninstall();
  assert.equal(process.listenerCount('unhandledRejection'), before);
});

// ---- real unhandled rejections in a child process -------------------------
function runChild(t, script) {
  const dir = tmpDir(t);
  const file = path.join(dir, 'child.js');
  fs.writeFileSync(file, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child did not exit in time; stdout=' + out + ' stderr=' + err)); }, 15000);
    child.on('close', code => { clearTimeout(timer); resolve({code, out, err, dir}); });
  });
}

test('child: a real unhandled rejection from one conversation does not kill the process', async t => {
  const dir = tmpDir(t);
  const crashDir = path.join(dir, 'crash');
  fs.mkdirSync(crashDir);
  const closedFile = path.join(dir, 'closed.txt');
  const resultFile = path.join(dir, 'result.json');
  const script = `'use strict';
const fs = require('node:fs');
const serverCrash = require(${JSON.stringify(require.resolve('../src/server/server-crash'))});
process.env.MUSER_CRASH_DIR = ${JSON.stringify(crashDir)};
const host = {get: id => (id === 'bad-sess' || id === 'good-sess') ? {id} : null, closeSync: id => { fs.appendFileSync(${JSON.stringify(closedFile)}, id + String.fromCharCode(10)); }};
serverCrash.installServerCrashHandlers({version: '9.9.9', host, onFatal: () => { process.exit(99); }});
setTimeout(() => { Promise.reject(Object.assign(new Error('boom in background work'), {sessionId: 'bad-sess'})); }, 50);
setTimeout(() => { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({alive: true})); process.exit(0); }, 700);
`;
  const {code, out, err} = await runChild(t, script);
  assert.equal(code, 0, 'the process stayed alive after the rejection; stdout=' + out + ' stderr=' + err);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), {alive: true});
  assert.equal(fs.readFileSync(closedFile, 'utf8'), 'bad-sess\n');
  const reports = crashFiles(crashDir);
  assert.equal(reports.length, 1);
  assert.match(reports[0].error, /boom in background work/);
  assert.equal(reports[0].sessionId, 'bad-sess');
  assert.equal(reports[0].scope, 'session');
});

test('child: a real fatal rejection with no respawn budget exits 1 and records the crash', async t => {
  const dir = tmpDir(t);
  const crashDir = path.join(dir, 'crash');
  fs.mkdirSync(crashDir);
  const stateFile = path.join(dir, 'restarts.json');
  const now = Date.now();
  for (let i = 0; i < 5; i++) serverCrash.recordRestart(stateFile, now + i);
  const spawnedFile = path.join(dir, 'spawned.txt');
  const script = `'use strict';
const fs = require('node:fs');
const serverCrash = require(${JSON.stringify(require.resolve('../src/server/server-crash'))});
process.env.MUSER_CRASH_DIR = ${JSON.stringify(crashDir)};
serverCrash.installServerCrashHandlers({version: '9.9.9', host: {get: () => null},
  spawnFn: () => { fs.writeFileSync(${JSON.stringify(spawnedFile)}, 'spawned'); return {unref() {}}; },
  stateFile: ${JSON.stringify(stateFile)}});
setTimeout(() => { Promise.reject(new Error('fatal boom')); }, 50);
`;
  const {code} = await runChild(t, script);
  assert.equal(code, 1, 'the fatal error ends the process once the restart budget is spent');
  assert.equal(fs.existsSync(spawnedFile), false);
  const reports = crashFiles(crashDir);
  assert.equal(reports.length, 1);
  assert.match(reports[0].error, /fatal boom/);
  assert.equal(reports[0].scope, 'fatal');
});

// ---- live server: the other conversation keeps answering ------------------
// Runs in a child process: node:test fails a test on any unhandled
// rejection in its own process, even one a handler caught, so the genuine
// rejection has to happen outside the runner.

test('live server: a rejection in one conversation closes it, the other still answers', async t => {
  const dir = tmpDir(t);
  const crashDir = path.join(dir, 'crash');
  fs.mkdirSync(crashDir);
  const resultFile = path.join(dir, 'result.json');
  const guiFile = path.join(dir, 'gui.json');
  const serverFile = path.join(dir, 'server.json');
  const script = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const serverCrash = require(${JSON.stringify(require.resolve('../src/server/server-crash'))});
const {SessionsHost} = require(${JSON.stringify(require.resolve('../src/server/sessions-host'))});
const {GuiServer} = require(${JSON.stringify(require.resolve('../src/gui-server'))});
process.env.MUSER_CRASH_DIR = ${JSON.stringify(crashDir)};
let seq = 0;
class FakeAgent { constructor(cwd) { seq++; this.cwd = cwd; this.mode = 'default'; this.session = {id: 'sess-' + seq, turns: 0}; this.accountId = 'default'; this.busy = false; this.closed = false; } close() { this.closed = true; } }
class FakeController { constructor(agent) { this.agent = agent; this.museName = 'kaguya'; this.s = {entries: [], busy: false, queue: [], approval: null, mode: 'default', shells: [], agents: []}; } subscribe = () => () => {}; get = () => this.s; }
(async () => {
  const fail = msg => { try { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ok: false, error: msg})); } catch {} process.exit(1); };
  try {
    const host = new SessionsHost({create: async () => { throw new Error('no factory in this test'); }, findSession: () => null, idleMs: 0, sweepMs: 0});
    const bad = {agent: new FakeAgent('C:/work-a'), controller: null, museName: 'kaguya'};
    bad.controller = new FakeController(bad.agent);
    const good = {agent: new FakeAgent('C:/work-b'), controller: null, museName: 'kaguya'};
    good.controller = new FakeController(good.agent);
    host.addPrepared({...bad, isDefault: true});
    host.addPrepared({...good});
    const badId = bad.agent.session.id, goodId = good.agent.session.id;
    const server = new GuiServer({host, token: 'test-token', port: 0, discoveryFile: ${JSON.stringify(guiFile)}, serverDiscoveryFile: ${JSON.stringify(serverFile)}, accountsProvider: () => [{id: 'default', label: 'default', active: true}], recentProvider: () => []});
    await server.start();
    const fatals = [];
    const closed = [];
    serverCrash.installServerCrashHandlers({version: '9.9.9', host: {get: id => host.get(id), closeSync: (id, reason) => { closed.push(id); host.closeSync(id, reason); }}, onFatal: async e => { fatals.push(String((e && e.message) || e)); }});
    setTimeout(() => { Promise.reject(Object.assign(new Error('boom in background work'), {sessionId: badId})); }, 50);
    await new Promise(r => setTimeout(r, 600));
    const checks = [];
    if (fatals.length) checks.push('fatal path ran: ' + fatals.join(', '));
    if (host.get(badId)) checks.push('bad conversation still open');
    if (!host.get(goodId)) checks.push('good conversation is gone');
    if (!bad.agent.closed) checks.push('bad agent not closed');
    if (good.agent.closed) checks.push('good agent closed');
    const res = await fetch('http://127.0.0.1:' + server.port + '/api/server', {headers: {authorization: 'Bearer test-token'}});
    if (res.status !== 200) checks.push('/api/server status ' + res.status);
    const info = await res.json();
    const ids = (info.sessions || []).map(s => s.id);
    if (ids.length !== 1 || ids[0] !== goodId) checks.push('/api/server sessions ' + JSON.stringify(ids));
    const reports = fs.readdirSync(${JSON.stringify(crashDir)}).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(${JSON.stringify(crashDir)}, f), 'utf8')));
    if (reports.length !== 1) checks.push('crash reports ' + reports.length);
    else { if (reports[0].sessionId !== badId) checks.push('report sessionId ' + reports[0].sessionId); if (reports[0].scope !== 'session') checks.push('report scope ' + reports[0].scope); }
    await server.close();
    await host.closeAll();
    if (checks.length) fail(checks.join('; '));
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ok: true, closed}));
    process.exit(0);
  } catch (e) { fail(String((e && e.stack) || e)); }
})();
`;
  const {code, out, err} = await runChild(t, script);
  assert.equal(code, 0, 'live server check failed; stdout=' + out + ' stderr=' + err);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.closed.length, 1);
});
