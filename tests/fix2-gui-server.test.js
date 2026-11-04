'use strict';
// Fix phase 2, agent A8: Medium findings in src/gui-server.js — work2/c4.md
// #2-#10 (deep #29-#37), the server side of third M30-M34/M37, and the
// missing-coverage half of deep #287. Fakes mirror tests/gui-server.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {execFile, execFileSync} = require('node:child_process');
const {GuiServer} = require('../src/gui-server');

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.cwd = 'C:\\work'; this.mode = 'default'; this.session = {id: 'sess-1', turns: 2};
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 2};
    this.interrupts = 0; this.killed = [];
    this.shells = {kill: id => { if (id !== 'bg1') throw new Error('No background shell ' + id); this.killed.push(id); return {id, killed: true}; }};
  }
  async interrupt() { this.interrupts++; }
}
FakeAgent.DEVICE = 'fake-device';

class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.listeners = new Set(); this.submitted = [];
    this.s = {
      entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null,
      mode: 'default', shells: [], focus: null, todos: [], agents: [], plan: null, attachments: [],
      menu: null, limitInput: null, question: null, bangRunning: null,
    };
    this.nextId = 2;
    this.outputs = [];
    this.pending = [];
    this.limitAnswers = [];
    this.menuCancels = 0;
    this.bangStop = {aborted: false, abort() { this.aborted = true; }};
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  push(entry) { this.set({entries: [...this.s.entries, {id: this.nextId++, ...entry}]}); }
  async submit(text) { this.submitted.push(text); this.submittedAttachments = [...(this.s.attachments || [])]; this.push({type: 'user', text}); }
  answerLimit(value) {
    const edit = this.s.limitInput;
    if (!edit) return false;
    this.limitAnswers.push(value);
    if (value === null) { this.set({limitInput: null}); if (edit.back) edit.back(); return; }
    if (!Number.isSafeInteger(value) || (edit.min !== undefined && (value < edit.min || value > edit.max))) return false;
    this.set({limitInput: null});
    if (edit.done) edit.done(value);
  }
  cancelMenu() { const m = this.s.menu; if (!m) return; this.menuCancels++; this.set({menu: null}); m.cancel?.(); }
  nextApproval() { this.promoted = (this.promoted || 0) + 1; }
  submitReason(text) { (this.reasons ||= []).push(text); this.set({reasonFor: null}); }
  setMode(m) { this.agent.mode = m; this.set({mode: m}); }
  slashList() { return []; }
}

function makeServer(t, extra = {}) {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-gui-'));
  const discoveryFile = path.join(dir, 'gui.json');
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile, ...extra});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server, discoveryFile, dir};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p, {headers = {}, body} = {}) {
  return fetch('http://127.0.0.1:' + server.port + p, {
    method, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function rawCall(server, method, p, raw) {
  return fetch('http://127.0.0.1:' + server.port + p, {method, headers: {...AUTH, 'content-type': 'application/json'}, body: raw});
}
async function until(pred, ms = 3000) {
  const t0 = Date.now();
  for (;;) { if (pred()) return; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 15)); }
}
const PNG_ATT = () => ({name: 'a.png', type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')});

// --- c4#2 (deep #29): a refused body must not run the side effect -----------

test('fix2 c4#2: POST /api/server/stop with an invalid body answers 400 and never stops', async t => {
  let stops = 0;
  const {server} = makeServer(t, {onStop: () => { stops++; }});
  await server.start();
  const bad = await rawCall(server, 'POST', '/api/server/stop', '{not json');
  assert.equal(bad.status, 400);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(stops, 0, 'onStop was not scheduled for a refused body');
  const ok = await call(server, 'POST', '/api/server/stop', {headers: AUTH, body: {}});
  assert.equal(ok.status, 200);
  await until(() => stops === 1);
});

test('fix2 c4#2: session open/close with an invalid body answer 400 and never touch the host', async t => {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-host-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const entry = {id: 'e1', agent, controller};
  const calls = [];
  const host = new EventEmitter();
  host.defaultEntry = () => entry;
  host.get = id => id === 'e1' ? entry : null;
  host.entries = new Map([['e1', entry]]);
  host.list = () => [];
  host.touch = () => {};
  host.openExisting = async id => { calls.push(['open', id]); return entry; };
  host.close = id => { calls.push(['close', id]); };
  const server = new GuiServer({host, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); });
  await server.start();
  assert.equal((await rawCall(server, 'POST', '/api/sessions/xyz/open', '{bad')).status, 400);
  assert.equal((await rawCall(server, 'POST', '/api/sessions/xyz/close', '{bad')).status, 400);
  assert.deepEqual(calls, [], 'neither open nor close ran for a refused body');
  assert.equal((await call(server, 'POST', '/api/sessions/xyz/open', {headers: AUTH, body: {}})).status, 200);
  assert.equal((await call(server, 'POST', '/api/sessions/xyz/close', {headers: AUTH, body: {}})).status, 200);
  assert.deepEqual(calls, [['open', 'xyz'], ['close', 'xyz']], 'valid bodies still work');
});

// --- c4#3 (deep #30) + third M33 server half --------------------------------

test('fix2 c4#3: attachments during a reason wait are refused, not parked for the next send', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  controller.set({reasonFor: {resolve() {}}});
  const res = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '却下の理由', attachments: [PNG_ATT()]}});
  assert.equal(res.status, 400, 'attachments cannot ride a reason answer');
  assert.deepEqual(controller.s.attachments, [], 'nothing was parked in the shared state');
  assert.deepEqual(controller.submitted, [], 'submit was not called with attachments');
  // A text-only send during the same wait keeps working (it IS the reason).
  const ok = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '理由だけ'}});
  assert.equal(ok.status, 202);
  assert.deepEqual(controller.submitted, ['理由だけ']);
});

// --- c4#4 (deep #31): a late submit rejection is surfaced -------------------

test('fix2 c4#4: a submit rejection after the 202 is surfaced as an error entry', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  controller.submit = async () => { await new Promise(r => setTimeout(r, 30)); throw new Error('late boom'); };
  const res = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'hi'}});
  assert.equal(res.status, 202, 'the answer is still the immediate 202');
  await until(() => controller.s.entries.some(e => e.type === 'end' && e.ok === false && e.error === 'late boom'));
});

// --- c4#5 (deep #32): an async menu pick rejection restores + surfaces ------

test('fix2 c4#5: an async menu pick rejection restores the menu and surfaces an error entry', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const menu = {title: 't', index: 0, options: [{value: 'x', label: 'x'}], pick: async () => { await new Promise(r => setTimeout(r, 20)); throw new Error('pick boom'); }};
  controller.set({menu});
  const res = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 0}});
  assert.equal(res.status, 200);
  await until(() => controller.s.menu === menu && controller.s.entries.some(e => e.type === 'end' && e.ok === false && e.error === 'pick boom'));
});

// --- c4#6 (deep #33): dead SSE subscribers are dropped; caps ----------------

function mockReqRes({failPing = false} = {}) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false; res.destroyed = false; res.chunks = [];
  res.writeHead = status => { res.status = status; };
  res.write = str => { if (failPing && String(str).startsWith(':')) throw new Error('gone'); res.chunks.push(String(str)); return true; };
  res.end = body => { if (body !== undefined) res.chunks.push(String(body)); res.writableEnded = true; };
  return {req, res};
}

test('fix2 c4#6: a conversation SSE client whose heartbeat write fails is dropped', async t => {
  const {server} = makeServer(t);
  server.eventsHeartbeatMs = 10;
  const entry = server.defaultEntry();
  const {req, res} = mockReqRes({failPing: true});
  server.events(entry, req, res);
  const att = server.attached.get(entry);
  assert.equal(att.clients.size, 1);
  await until(() => att.clients.size === 0);
});

test('fix2 c4#6: a server-events client whose heartbeat write fails is dropped', async t => {
  const {server} = makeServer(t);
  server.eventsHeartbeatMs = 10;
  const {req, res} = mockReqRes({failPing: true});
  server.serverEvents(req, res);
  assert.equal(server.serverClients.size, 1);
  await until(() => server.serverClients.size === 0);
});

test('fix2 c4#6: SSE subscriber caps answer 503 instead of growing without bound', async t => {
  const {server} = makeServer(t);
  const entry = server.defaultEntry();
  server.attachEntry(entry);
  const att = server.attached.get(entry);
  for (let i = 0; i < 64; i++) att.clients.add({});
  const one = mockReqRes();
  server.events(entry, one.req, one.res);
  assert.equal(one.res.status, 503, 'conversation stream cap');
  for (let i = 0; i < 64; i++) server.serverClients.add({res: {end() {}}});
  const two = mockReqRes();
  server.serverEvents(two.req, two.res);
  assert.equal(two.res.status, 503, 'server stream cap');
});

// --- c4#7 (deep #34) + c4#8 (deep #35): /api/changes ------------------------

const emptyHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-nohooks-'));
process.on('exit', () => { try { fs.rmSync(emptyHooksDir, {recursive: true, force: true}); } catch {} });
const GIT_SAFE = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + emptyHooksDir.replace(/\\/g, '/')];
function gitIn(cwd, args) { return execFileSync('git', [...GIT_SAFE, ...args], {cwd, encoding: 'utf8', timeout: 60000}); }
function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-repo-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  gitIn(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  gitIn(dir, ['add', 'a.txt']);
  execFileSync('git', [...GIT_SAFE, '-c', 'user.name=Gui Test', '-c', 'user.email=gui@test.invalid', 'commit', '-qm', 'base'], {cwd: dir, encoding: 'utf8', timeout: 60000});
  fs.appendFileSync(path.join(dir, 'a.txt'), 'two\n');
  return dir;
}

test('fix2 c4#7: /api/changes coalesces concurrent calls and briefly caches per cwd', async t => {
  const {server, agent} = makeServer(t);
  agent.cwd = makeRepo(t);
  await server.start();
  const p1 = server.changedFiles(agent.cwd);
  const p2 = server.changedFiles(agent.cwd);
  assert.equal(p1, p2, 'concurrent calls share one in-flight git run');
  const info = await p1;
  assert.deepEqual(info.files.map(f => f.path), ['a.txt']);
  fs.writeFileSync(path.join(agent.cwd, 'b.txt'), 'new\n');
  const cached = await server.changedFiles(agent.cwd);
  assert.deepEqual(cached.files.map(f => f.path), ['a.txt'], 'within the TTL the cached run is reused');
  server.changesCacheMs = 0;
  const fresh = await server.changedFiles(agent.cwd);
  assert.deepEqual(fresh.files.map(f => f.path).sort(), ['a.txt', 'b.txt'], 'after the TTL git runs again');
});

test('fix2 c4#8: /api/changes tells a real git failure apart from not-a-repo', async t => {
  const {server, agent} = makeServer(t);
  await server.start();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-norepo-'));
  t.after(() => fs.rmSync(plain, {recursive: true, force: true}));
  agent.cwd = plain;
  const notRepo = await call(server, 'GET', '/api/changes', {headers: AUTH});
  assert.equal(notRepo.status, 200);
  assert.deepEqual(await notRepo.json(), {repo: false}, 'a plain folder is still not-a-repo');
  agent.cwd = path.join(plain, 'no-such-dir');
  const gone = await call(server, 'GET', '/api/changes', {headers: AUTH});
  assert.equal(gone.status, 502, 'a vanished cwd is a failure, not not-a-repo');
  assert.match((await gone.json()).error, /could not read repository status/);
  const goneFile = await call(server, 'GET', '/api/changes?file=a.txt', {headers: AUTH});
  assert.equal(goneFile.status, 502, 'the diff form reports the failure too');
});

// --- c4#9 (deep #36): discovery ownership is verified, not pid-only --------

test('fix2 c4#9: a discovery file whose pid was reused does not block the real server', async t => {
  const {server, discoveryFile} = makeServer(t);
  const child = execFile(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
  t.after(() => { try { child.kill(); } catch {} });
  await until(() => child.pid !== undefined, 1000);
  // A crashed server's leftover file: its pid now belongs to an unrelated
  // live process, and the advertised port answers nothing.
  fs.writeFileSync(discoveryFile, JSON.stringify({pid: child.pid, port: 1, token: 'stale-token', startedAt: 1}));
  await server.start();
  const written = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
  assert.equal(written.token, 'test-token', 'the real server overwrote the stale file');
  assert.equal(written.port, server.port);
  assert.equal(written.pid, process.pid);
});

test('fix2 c4#9/#65: a REAL live server (answering its own probe) keeps its discovery file', async t => {
  const {server, discoveryFile} = makeServer(t);
  // A foreign muser server in another process: it answers /api/server with
  // its own pid under its own token — the real shape probeDiscoveryServer
  // verifies. (The phase-1 #65 fixture used a bare live pid with nothing
  // listening, which is indistinguishable from a reused pid; see rows-A8.)
  const childScript = `const http = require('node:http'); const srv = http.createServer((req, res) => { if (req.headers.authorization !== 'Bearer other-token') { res.writeHead(401); return res.end('{}'); } res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({pid: process.pid})); }); srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port))); setTimeout(() => {}, 15000);`;
  const child = execFile(process.execPath, ['-e', childScript]);
  t.after(() => { try { child.kill(); } catch {} });
  const port = await new Promise((resolve, reject) => { child.stdout.once('data', d => resolve(Number(d))); child.once('error', reject); });
  assert.ok(port > 0);
  const foreign = JSON.stringify({pid: child.pid, port, token: 'other-token', startedAt: Date.now()});
  fs.writeFileSync(discoveryFile, foreign);
  await server.start();
  assert.equal(fs.readFileSync(discoveryFile, 'utf8'), foreign, 'a verified live server is never overwritten (audit #65 intent)');
});

test('fix2 c4#9: probeDiscoveryServer only trusts a server that answers as itself', async t => {
  const {server} = makeServer(t);
  await server.start();
  assert.equal(await server.probeDiscoveryServer({pid: process.pid, port: server.port, token: 'test-token'}), true, 'the live server verifies');
  assert.equal(await server.probeDiscoveryServer({pid: 999999, port: server.port, token: 'test-token'}), false, 'a pid mismatch is not ownership');
  assert.equal(await server.probeDiscoveryServer({pid: process.pid, port: server.port, token: 'wrong'}), false, 'a token mismatch is not ownership');
  assert.equal(await server.probeDiscoveryServer({pid: process.pid, port: 1, token: 'test-token'}), false, 'a dead port is not ownership');
});

// --- c4#10 (deep #37): avatar cache follows the account/client --------------

function avatarClient(label, calls) {
  return {async request(m, p) {
    calls.push(label + ' ' + p);
    if (p === '/identity') return {avatar: {image_exists: true, image_path: 'a/' + label + '.png'}};
    return {contentType: 'image/png', data: Buffer.from('IMG-' + label)};
  }};
}

test('fix2 c4#10: the avatar cache follows a client/account swap and expires', async t => {
  const {server, agent} = makeServer(t);
  const calls = [];
  agent.client = avatarClient('old', calls);
  await server.start();
  const body = async () => Buffer.from(await (await call(server, 'GET', '/api/muse-avatar', {headers: AUTH})).arrayBuffer()).toString();
  assert.equal(await body(), 'IMG-old');
  assert.equal(await body(), 'IMG-old');
  assert.deepEqual(calls.filter(c => c.endsWith('/identity')).length, 1, 'same client: fetched once');
  // Account switch on the same entry: agent.client is swapped.
  agent.client = avatarClient('new', calls);
  agent.accountId = 'acct-2';
  assert.equal(await body(), 'IMG-new', 'the new account\'s avatar is served, not the cached old one');
  // Expiry: even with the same client, a changed avatar is re-read.
  agent.client = avatarClient('newer', calls);
  agent.accountId = 'acct-2';
  server.avatarCacheMs = 0;
  assert.equal(await body(), 'IMG-newer', 'after the TTL the identity is re-read');
});

// --- third M30-M34/M37: the server side already carries these ---------------

test('fix2 third M30-M34/M37: snapshot carries menu/limitInput/question/reasonFor/bangRunning and /entries pages beyond 200', async t => {
  const {server, controller, agent} = makeServer(t);
  await server.start();
  let picked = null;
  controller.set({
    menu: {title: '選んで', index: 0, options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}], pick: v => { picked = v; }},
    limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '250', min: 1, max: 1000, hint: 'h'},
    question: {mode: 'list', questions: [{header: 'q', options: [{label: 'x'}]}]},
    reasonFor: {resolve() {}},
    bangRunning: {call: {id: 'b1', command: 'system.run'}, tail: []},
    entries: Array.from({length: 250}, (_, i) => ({id: i + 1, type: 'note'})),
  });
  const state = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(state.menu.title, '選んで');
  assert.ok(state.menu.id, 'M30: the menu rides the snapshot with its identity id');
  assert.deepEqual(state.menu.options.map(o => o.value), ['a', 'b']);
  assert.equal(state.limitInput.key, 'maxToolCallsPerTurn', 'M31: limitInput rides the snapshot');
  assert.equal(state.question.mode, 'list', 'M32: the selectable question rides the snapshot');
  assert.equal(state.reasonFor, true, 'M33: the reason wait is visible in the snapshot');
  assert.deepEqual(state.live.bangRunning, {call: {id: 'b1', command: 'system.run'}, tail: []}, 'M34: bangRunning rides live');
  assert.equal(state.entries.length, 200, 'the snapshot window is the newest 200');
  // M37: GET /api/entries is the server route for everything older.
  const older = await (await call(server, 'GET', '/api/entries?before=51&limit=10', {headers: AUTH})).json();
  assert.deepEqual(older.entries.map(e => e.id), [41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
  assert.equal(older.hasMore, true);
  // M30: the menu can be answered over the API, bound by its id.
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 1, menuId: 'menu-999'}})).status, 409, 'a stale menuId is refused');
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 1, menuId: state.menu.id}})).status, 200);
  assert.equal(picked, 'b');
  // M34: bang can be interrupted on its own target.
  const bang = await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {target: 'bang'}});
  assert.equal(bang.status, 200);
  assert.equal(controller.bangStop.aborted, true);
  assert.equal(agent.interrupts, 0, 'a bang interrupt does not stop the turn');
});

// --- deep #287 (test-coverage half): invalid JSON + the 1 MB default cap ----

test('fix2 deep #287: a non-/send route refuses invalid JSON and an over-cap body', async t => {
  const {server, agent} = makeServer(t);
  await server.start();
  const bad = await rawCall(server, 'POST', '/api/mode', '{not json');
  assert.equal(bad.status, 400, 'invalid JSON is a 400');
  assert.equal(agent.mode, 'default', 'setMode never ran');
  const big = await rawCall(server, 'POST', '/api/mode', JSON.stringify({mode: 'default', pad: 'x'.repeat(1024 * 1024)}));
  assert.equal(big.status, 413, 'the default 1 MB body cap applies outside /send');
  assert.equal(agent.mode, 'default');
});
