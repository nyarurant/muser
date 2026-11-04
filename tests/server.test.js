'use strict';
// Muser Server (remote/SERVER.md step 1, protocol v5): SessionsHost + GuiServer in
// host mode + the discovery client, against fake Agent/Controller pairs in the
// gui-server.test.js shape. No gateway, no device, no real sessions on disk:
// the host's factory and the stored-session lookup are injected.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');
const {SessionsHost, HostError} = require('../src/server/sessions-host');
const discovery = require('../src/server/discovery');
const autostart = require('../src/server/autostart');

let seq = 0;
class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    seq++;
    this.cwd = cwd || 'C:\\work'; this.mode = 'default';
    this.session = {id: 'sess-' + seq, turns: 0};
    this.accountId = 'default'; this.accountLabel = null; this.busy = false; this.closed = false;
    this.interrupts = 0; this.killed = [];
    this.shells = {kill: id => { this.killed.push(id); return {id, killed: true}; }};
  }
  async interrupt() { this.interrupts++; }
  close() { this.closed = true; }
}
class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.museName = 'kaguya';
    this.listeners = new Set(); this.submitted = []; this.outputs = [];
    this.s = {entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null, mode: 'default', shells: [], focus: null, todos: [], agents: [], plan: null, account: null, menu: null, spinnerWord: null};
    this.nextId = 2;
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  push(entry) { this.set({entries: [...this.s.entries, {id: this.nextId++, ...entry}]}); }
  async submit(text) { this.submitted.push(text); this.push({type: 'user', text}); }
  nextApproval() { this.promoted = (this.promoted || 0) + 1; }
  setMode(m) { this.agent.mode = m; this.set({mode: m}); }
  slashList(text) { return ['/help'].filter(n => n.startsWith(text)); }
  askPending() {
    let settled = null;
    const req = {call: {command: 'system.run', agent: 'main', summary: 'x'}, preview: null, index: 0, outside: false, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], resolve: v => { settled = v; }};
    this.set({approval: req});
    return {settled: () => settled};
  }
}
function makePair(cwd) { const agent = new FakeAgent(cwd); return {agent, controller: new FakeController(agent), museName: 'kaguya'}; }

// A host whose factory mints a fresh fake pair per conversation, remembering them.
function makeHost(t, hostOpts = {}) {
  const made = [];
  const stored = new Map();
  const host = new SessionsHost({
    create: async ({cwd, session}) => { const pair = makePair(cwd); if (session && typeof session === 'object') pair.agent.session = {...session}; made.push(pair); return pair; },
    findSession: ref => stored.get(ref) || null,
    idleMs: 0, // no sweep in tests unless a test sets it
    ...hostOpts,
  });
  t.after(async () => { await host.closeAll(); });
  return {host, made, stored};
}
function makeServer(t, host, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-server-'));
  const server = new GuiServer({host, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json'), serverDiscoveryFile: path.join(dir, 'server.json'), accountsProvider: () => [{id: 'default', label: 'default', active: true}], recentProvider: () => [], ...extra});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {server, dir};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p, {headers = {}, body} = {}) {
  return fetch('http://127.0.0.1:' + server.port + p, {method, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})}, body: body !== undefined ? JSON.stringify(body) : undefined});
}
function tmpDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-cwd-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }

// ---- SessionsHost ---------------------------------------------------------------

test('host: cap closes the least recently used idle conversation; the default is exempt', async t => {
  const {host, made} = makeHost(t, {maxOpen: 3});
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  const e2 = await host.openNew({cwd: dir});
  assert.equal(host.size, 3);
  host.touch(e2.id); // e1 is now the LRU non-default
  const e3 = await host.openNew({cwd: dir});
  assert.equal(host.size, 3, 'still at the cap');
  assert.equal(host.get(e1.id), null, 'the LRU idle conversation was closed');
  assert.equal(made[0].agent.closed, true, 'its agent was closed (node slot handed back)');
  assert.ok(host.get(def.id) && host.get(e2.id) && host.get(e3.id));
});

test('host: cap with every non-default conversation busy is a 409, and closing a busy one is a 409', async t => {
  const {host} = makeHost(t, {maxOpen: 2});
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  e1.controller.set({busy: true});
  await assert.rejects(() => host.openNew({cwd: dir}), err => err instanceof HostError && err.status === 409);
  assert.throws(() => host.close(e1.id), err => err.status === 409);
  host.close(e1.id, {force: true});
  assert.equal(host.get(e1.id), null);
});

test('host: openNew validates the folder; openExisting re-opens a stored session once', async t => {
  const {host, stored, made} = makeHost(t);
  await assert.rejects(() => host.openNew({cwd: path.join(os.tmpdir(), 'muser-no-such-folder-zzz')}), err => err.status === 400);
  stored.set('past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'});
  const e = await host.openExisting('past-1');
  assert.equal(e.id, 'past-1');
  assert.equal(e.agent.cwd, 'C:\\old');
  const again = await host.openExisting('past-1');
  assert.equal(again, e, 'already open: the same entry, no second factory call');
  assert.equal(made.length, 1);
  await assert.rejects(() => host.openExisting('nope'), err => err.status === 404);
});

test('host: idle sweep closes stale non-default conversations only', async t => {
  const {host} = makeHost(t, {idleMs: 1000});
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  const e2 = await host.openNew({cwd: dir});
  e1.lastUsedAt = Date.now() - 5000; def.lastUsedAt = Date.now() - 5000;
  const closed = host.closeIdle();
  assert.deepEqual(closed, [e1.id]);
  assert.ok(host.get(def.id), 'the default survives the sweep');
  assert.ok(host.get(e2.id), 'a fresh conversation survives');
});

test('host: busy and approval transitions are emitted as server events', async t => {
  const {host} = makeHost(t);
  const events = [];
  host.on('event', e => events.push(e));
  const pair = makePair('C:\\a');
  host.addPrepared({...pair, isDefault: true});
  pair.controller.set({busy: true});
  pair.controller.set({busy: false});
  pair.controller.askPending();
  assert.deepEqual(events.map(e => e.type), ['session-opened', 'session-busy', 'session-idle', 'approval-pending']);
  assert.ok(events.every(e => e.sessionId === pair.agent.session.id));
});

test('host #57: concurrent opens cannot pass the cap together, and the same session opens only once', async t => {
  const dir = tmpDir(t);
  let release; const gate = new Promise(r => { release = r; });
  const madeSlow = [];
  const slow = new SessionsHost({
    create: async ({cwd, session}) => { await gate; const pair = makePair(cwd); if (session && typeof session === 'object') pair.agent.session = {...session}; madeSlow.push(pair); return pair; },
    findSession: ref => (ref === 'past-1' ? {id: 'past-1', cwd: dir, turns: 1} : null),
    idleMs: 0, maxOpen: 2,
  });
  t.after(async () => { await slow.closeAll(); });
  slow.addPrepared({...makePair('C:\\a'), isDefault: true});
  const p1 = slow.openExisting('past-1');
  const p2 = slow.openExisting('past-1');
  await assert.rejects(() => slow.openNew({cwd: dir}), err => err.status === 409, 'a second concurrent creation sees the in-flight one counting toward the cap');
  release();
  const [e1, e2] = await Promise.all([p1, p2]);
  assert.equal(e1, e2, 'both callers got the same entry');
  assert.equal(madeSlow.length, 1, 'the factory ran once, not once per caller');
});

test('host #58/#59: re-registering an id closes the superseded agent; a closed default is not silently replaced', async t => {
  const {host} = makeHost(t);
  const first = makePair('C:\\a');
  host.addPrepared({...first, isDefault: true});
  const second = makePair('C:\\a');
  second.agent.session = {...first.agent.session};
  host.addPrepared({...second});
  assert.equal(first.agent.closed, true, 'the superseded agent was closed (no leaked slot/subscription)');
  assert.equal(host.size, 1);
  assert.equal(host.get(first.agent.session.id).agent, second.agent);
  host.close(second.agent.session.id, {force: true});
  assert.equal(host.defaultId, null, 'the default is gone when it is closed');
  const dir = tmpDir(t);
  const other = await host.openNew({cwd: dir});
  assert.equal(other.isDefault, false);
  assert.equal(host.defaultId, null, 'the next unrelated conversation is NOT promoted to default');
  assert.equal(host.defaultEntry(), null);
});

test('host #60: approval-waiting and shell-running conversations are not evicted, swept or closed as idle', async t => {
  const {host} = makeHost(t, {idleMs: 1000});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  e1.lastUsedAt = Date.now() - 5000;
  e1.controller.askPending();
  assert.deepEqual(host.closeIdle(), [], 'an approval is pending: the sweep leaves it alone');
  assert.throws(() => host.close(e1.id), err => err.status === 409, 'and an explicit close refuses too');
  e1.controller.set({approval: null, shells: [{id: 'bg1', running: true}]});
  assert.deepEqual(host.closeIdle(), [], 'a running background shell also protects it');
  e1.controller.set({shells: [{id: 'bg1', running: false}]});
  assert.deepEqual(host.closeIdle(), [e1.id], 'once truly idle it is swept');
});

// ---- GuiServer in host mode (protocol v5) ---------------------------------------

test('v5: GET /api/server describes the server and its open conversations', async t => {
  const {host} = makeHost(t);
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server} = makeServer(t, host);
  await server.start();
  assert.equal((await call(server, 'GET', '/api/server')).status, 401);
  const info = await (await call(server, 'GET', '/api/server', {headers: AUTH})).json();
  assert.equal(info.protocol, 6);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.pid, process.pid);
  assert.equal(typeof info.startedAt, 'number');
  assert.deepEqual(info.muse, {name: 'kaguya'});
  assert.deepEqual(info.accounts, [{id: 'default', label: 'default', active: true}]);
  assert.equal(info.sessions.length, 1);
  assert.equal(info.sessions[0].id, def.id);
  assert.equal(info.sessions[0].isDefault, true);
});

test('v5: two conversations stay apart — sends, state and approvals never cross', async t => {
  const {host, made} = makeHost(t);
  const defPair = makePair('C:\\a');
  const def = host.addPrepared({...defPair, isDefault: true});
  const {server} = makeServer(t, host);
  await server.start();
  const dir = tmpDir(t);
  const created = await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd: dir}});
  assert.equal(created.status, 201);
  const {id: id2} = await created.json();
  const pair2 = made[0];
  assert.equal(id2, pair2.agent.session.id);
  // Sends route to their own conversation only.
  assert.equal((await call(server, 'POST', '/api/s/' + id2 + '/send', {headers: AUTH, body: {text: 'for two'}})).status, 202);
  assert.deepEqual(pair2.controller.submitted, ['for two']);
  assert.deepEqual(defPair.controller.submitted, []);
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'for default'}})).status, 202);
  assert.deepEqual(defPair.controller.submitted, ['for default'], 'the unprefixed route is the default conversation');
  // State is per conversation.
  const s2 = await (await call(server, 'GET', '/api/s/' + id2 + '/state', {headers: AUTH})).json();
  assert.equal(s2.session.id, id2);
  assert.equal(s2.cwd, dir);
  const s1 = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(s1.session.id, def.id);
  // An approval pending on conversation 2 is invisible — and unanswerable — on 1.
  const pending = pair2.controller.askPending();
  assert.equal((await (await call(server, 'GET', '/api/state', {headers: AUTH})).json()).approval, null);
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}}})).status, 409);
  const ok = await call(server, 'POST', '/api/s/' + id2 + '/approval', {headers: AUTH, body: {decision: {allow: true}}});
  assert.equal(ok.status, 200);
  assert.deepEqual(pending.settled(), {allow: true, always: null});
  // Unknown conversation ids are 404 everywhere.
  assert.equal((await call(server, 'GET', '/api/s/nope/state', {headers: AUTH})).status, 404);
  // A bad folder is a 400, not a new conversation.
  assert.equal((await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd: path.join(dir, 'missing')}})).status, 400);
});

test('v5: the menu rides the snapshot and POST .../menu picks with the TUI semantics', async t => {
  const {host} = makeHost(t);
  const pair = makePair('C:\\a');
  host.addPrepared({...pair, isDefault: true});
  const {server} = makeServer(t, host);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {value: 'x'}})).status, 409, 'no menu open');
  let picked = null;
  pair.controller.set({menu: {title: '選んで', index: 0, options: [{value: {toggle: 'a', on: true}, label: 'A'}, {value: 'b', label: 'B'}], pick: v => { picked = v; }}});
  const state = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(state.menu.title, '選んで');
  assert.deepEqual(state.menu.options[0].value, {toggle: 'a', on: true}, 'object values cross as plain JSON');
  const res = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {value: {toggle: 'a', on: true}}});
  assert.equal(res.status, 200);
  assert.deepEqual(picked, {toggle: 'a', on: true});
  assert.equal(pair.controller.s.menu, null, 'the menu closed before the pick ran');
  pair.controller.set({menu: {title: 'x', index: 0, options: [{value: 'b', label: 'B'}], pick: v => { picked = v; }}});
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 0}})).status, 200);
  assert.equal(picked, 'b');
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {value: 'zzz'}})).status, 409, 'menu already closed');
});

test('v6: the new routes answer under /api/s/:id/ for that conversation only', async t => {
  const {host, made} = makeHost(t);
  const defPair = makePair('C:\\a');
  host.addPrepared({...defPair, isDefault: true});
  const {server} = makeServer(t, host);
  await server.start();
  const dir = tmpDir(t);
  const {id: id2} = await (await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd: dir}})).json();
  const pair2 = made[0];
  // /entries pages conversation 2's own list, not the default's.
  pair2.controller.push({type: 'note', lines: ['two']});
  pair2.controller.push({type: 'note', lines: ['three']});
  const page = await (await call(server, 'GET', '/api/s/' + id2 + '/entries?limit=2', {headers: AUTH})).json();
  assert.deepEqual(page.entries.map(e => e.id), [2, 3]);
  assert.equal(page.hasMore, true);
  const defPage = await (await call(server, 'GET', '/api/entries?limit=2', {headers: AUTH})).json();
  assert.deepEqual(defPage.entries.map(e => e.id), [1]);
  // /interrupt target bang aborts only conversation 2's !command.
  const bang2 = {aborted: false, abort() { this.aborted = true; }};
  pair2.controller.bangStop = bang2;
  assert.equal((await call(server, 'POST', '/api/s/' + id2 + '/interrupt', {headers: AUTH, body: {target: 'bang'}})).status, 200);
  assert.equal(bang2.aborted, true);
  assert.equal(pair2.agent.interrupts, 0);
  assert.equal(defPair.agent.interrupts, 0);
  // /limit and menu cancel reach conversation 2's controller surface.
  const answers = [];
  pair2.controller.answerLimit = v => { answers.push(v); pair2.controller.set({limitInput: null}); };
  pair2.controller.set({limitInput: {key: 'concurrent', text: '4'}});
  assert.equal((await call(server, 'POST', '/api/s/' + id2 + '/limit', {headers: AUTH, body: {value: 6, key: 'concurrent'}})).status, 200);
  assert.deepEqual(answers, [6]);
  let cancelled = 0;
  pair2.controller.cancelMenu = () => { cancelled++; pair2.controller.set({menu: null}); };
  pair2.controller.set({menu: {title: 't', index: 0, options: [{value: 'a', label: 'a'}], pick() {}}});
  assert.equal((await call(server, 'POST', '/api/s/' + id2 + '/menu', {headers: AUTH, body: {cancel: true}})).status, 200);
  assert.equal(cancelled, 1);
  assert.equal(pair2.controller.s.menu, null);
  // And a send with an attachment lands on conversation 2 only.
  const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]).toString('base64');
  assert.equal((await call(server, 'POST', '/api/s/' + id2 + '/send', {headers: AUTH, body: {text: 'pic', attachments: [{name: 'p.png', type: 'image/png', data}]}})).status, 202);
  assert.deepEqual(pair2.controller.submitted, ['pic']);
  assert.deepEqual(defPair.controller.submitted, []);
});

test('v5: /api/sessions lists stored conversations with open/busy; open and close round-trip', async t => {
  const storedList = [{id: 'past-1', cwd: 'C:\\old', title: 'old chat', turns: 3, created: 1, updated: 2, account: 'default'}];
  const {host, stored} = makeHost(t);
  stored.set('past-1', storedList[0]);
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server} = makeServer(t, host, {recentProvider: () => storedList});
  await server.start();
  let list = await (await call(server, 'GET', '/api/sessions', {headers: AUTH})).json();
  assert.deepEqual(list.sessions, [{id: 'past-1', cwd: 'C:\\old', title: 'old chat', turns: 3, created: 1, updated: 2, account: 'default', open: false, busy: false}]);
  const opened = await call(server, 'POST', '/api/sessions/past-1/open', {headers: AUTH, body: {}});
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), {id: 'past-1'});
  list = await (await call(server, 'GET', '/api/sessions', {headers: AUTH})).json();
  assert.equal(list.sessions[0].open, true);
  assert.equal((await call(server, 'POST', '/api/sessions/past-1/close', {headers: AUTH, body: {}})).status, 200);
  assert.equal(host.get('past-1'), null);
  assert.equal((await call(server, 'POST', '/api/sessions/past-1/close', {headers: AUTH, body: {}})).status, 404);
  assert.equal((await call(server, 'POST', '/api/sessions/ghost/open', {headers: AUTH, body: {}})).status, 404);
});

test('v5: /api/server/events streams session and approval events', {timeout: 30000}, async t => {
  const {host} = makeHost(t);
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server} = makeServer(t, host);
  await server.start();
  const ac = new AbortController(); t.after(() => ac.abort());
  const res = await fetch('http://127.0.0.1:' + server.port + '/api/server/events', {headers: AUTH, signal: ac.signal});
  assert.equal(res.status, 200);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buf = '';
  const nextEvent = async () => {
    // t6 #2 (deep audit): a bare reader.read() loop waits forever when the
    // server stops sending the event — the suite hung with no failing assert
    // to point at. Bound each read and name what was being awaited.
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const line = block.split('\n').find(l => l.startsWith('data: ')); if (line) return JSON.parse(line.slice(6)); continue; }
      const {done, value} = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for the next SSE event')), 10000))]);
      if (done) throw new Error('stream ended');
      buf += decoder.decode(value, {stream: true});
    }
  };
  const first = await nextEvent();
  assert.equal(first.kind, 'server');
  const dir = tmpDir(t);
  await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd: dir}});
  const ev = await nextEvent();
  assert.equal(ev.kind, 'event');
  assert.equal(ev.event.type, 'session-opened');
  ac.abort();
});

test('v5: server.json is written next to gui.json and removed on close', async t => {
  const {host} = makeHost(t);
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server, dir} = makeServer(t, host);
  await server.start();
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
  assert.deepEqual(Object.keys(s).sort(), ['pid', 'port', 'startedAt', 'token', 'version']);
  assert.equal(s.pid, process.pid);
  assert.equal(s.port, server.port);
  assert.equal(s.token, 'test-token');
  const g = JSON.parse(fs.readFileSync(path.join(dir, 'gui.json'), 'utf8'));
  assert.equal(g.sessionId, host.defaultEntry().id, 'gui.json keeps its v1 shape for the C# GUI');
  await server.close();
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'gui.json')), false);
});

// ---- discovery (the second-serve attach) ----------------------------------------

test('discovery: probe + attach open a conversation on the running server instead of a new one', async t => {
  const {host, made} = makeHost(t);
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server, dir} = makeServer(t, host);
  await server.start();
  const info = discovery.readServer(path.join(dir, 'server.json'));
  assert.ok(info, 'the discovery file was read');
  const live = await discovery.probeServer(info);
  assert.ok(live && live.pid === process.pid, 'the running server answers');
  const cwd = tmpDir(t);
  const opened = await discovery.attachSession(info, {cwd});
  assert.equal(opened.id, made[0].agent.session.id);
  assert.equal(host.size, 2, 'the conversation opened on THIS server — no second server exists');
  // A stale file (dead pid) and a wrong token both probe as "no server".
  assert.equal(await discovery.probeServer({pid: 99999999, port: server.port, token: 'test-token'}), null);
  assert.equal(await discovery.probeServer({pid: process.pid, port: server.port, token: 'wrong'}), null);
  assert.equal(discovery.readServer(path.join(dir, 'missing.json')), null);
});

test('discovery #62/#65: a slow server is neither declared dead by the probe nor cut off mid-request', {timeout: 30000}, async t => {
  const http = require('node:http');
  const slow = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({pid: process.pid, protocol: 6})); }, 2600);
  });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(done => { slow.closeAllConnections?.(); slow.close(done); }));
  const info = {pid: process.pid, port: slow.address().port, token: 'test-token'};
  const live = await discovery.probeServer(info);
  assert.ok(live && live.pid === process.pid, 'the probe retried past the first 2 s timeout instead of declaring a slow-but-live server dead');
  const r = await discovery.request(info, 'POST', '/api/sessions', {cwd: 'C:\\x'});
  assert.equal(r.status, 200, 'a plain request no longer inherits the 2 s probe timeout');
  assert.equal(await discovery.probeServer({pid: 99999999, port: info.port, token: 'test-token'}), null, 'a dead pid still probes as no server');
  const other = http.createServer((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({pid: 424242, protocol: 6})); });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(done => { other.closeAllConnections?.(); other.close(done); }));
  assert.equal(await discovery.probeServer({pid: process.pid, port: other.address().port, token: 'test-token'}), null, 'a different server answering on the port is not this discovery file’s server');
});

test('gui #59 (route side): closing the default leaves unprefixed routes 404, and a later open is not rerouted to', async t => {
  const {host, made} = makeHost(t);
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server} = makeServer(t, host);
  await server.start();
  assert.equal((await call(server, 'GET', '/api/state', {headers: AUTH})).status, 200);
  assert.equal((await call(server, 'POST', '/api/sessions/' + def.id + '/close', {headers: AUTH, body: {}})).status, 200);
  assert.equal((await call(server, 'GET', '/api/state', {headers: AUTH})).status, 404, 'no default: unprefixed routes answer 404');
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'anyone?'}})).status, 404);
  const dir = tmpDir(t);
  const created = await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd: dir}});
  assert.equal(created.status, 201);
  const {id: id2} = await created.json();
  assert.equal((await call(server, 'GET', '/api/state', {headers: AUTH})).status, 404, 'the new conversation is NOT silently made the unprefixed target');
  assert.equal((await call(server, 'GET', '/api/s/' + id2 + '/state', {headers: AUTH})).status, 200, 'it is reachable by its own prefixed route');
  assert.deepEqual(made[0].controller.submitted, [], 'nothing was rerouted into it');
});

test('gui #61: GET polls do not count as use; POST actions and an open SSE stream do', async t => {
  const {host} = makeHost(t);
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const {server} = makeServer(t, host);
  server.eventsHeartbeatMs = 25;
  await server.start();
  const stale = Date.now() - 100000;
  def.lastUsedAt = stale;
  assert.equal((await call(server, 'GET', '/api/s/' + def.id + '/state', {headers: AUTH})).status, 200);
  assert.equal(def.lastUsedAt, stale, 'a GET poll is observation, not use — a forgotten poller cannot keep a conversation alive');
  assert.equal((await call(server, 'POST', '/api/s/' + def.id + '/send', {headers: AUTH, body: {text: 'hi'}})).status, 202);
  assert.ok(def.lastUsedAt > stale, 'a send is use');
  def.lastUsedAt = stale;
  const ac = new AbortController(); t.after(() => ac.abort());
  const res = await fetch('http://127.0.0.1:' + server.port + '/api/s/' + def.id + '/events', {headers: AUTH, signal: ac.signal});
  assert.equal(res.status, 200);
  assert.ok(def.lastUsedAt > stale, 'opening the event stream counts as use');
  def.lastUsedAt = stale;
  // t6 #1 (deep audit): a fixed 140 ms sleep against a 25 ms heartbeat timer
  // flakes under load (timers can all slip past the window on a busy Windows
  // box). Poll for the touch with a deadline instead — the claim is that the
  // heartbeat touches, not that it does so within 140 ms.
  const hbDeadline = Date.now() + 5000;
  while (!(def.lastUsedAt > stale) && Date.now() < hbDeadline) await new Promise(r => setTimeout(r, 15));
  assert.ok(def.lastUsedAt > stale, 'the open stream keeps touching on its heartbeat');
  ac.abort();
});

// ---- autostart -------------------------------------------------------------------

test('autostart: the VBS launcher runs node serve hidden; schtasks gets the logon task', async t => {
  const vbs = autostart.vbsContent('C:\\node\\node.exe', 'C:\\muser\\bin\\muser.js');
  assert.match(vbs, /WScript\.Shell/);
  assert.match(vbs, /serve/);
  assert.match(vbs, /, 0, False/, 'window style 0 = hidden');
  const calls = [];
  const home = tmpDir(t);
  const run = async (file, args) => { calls.push([file, ...args]); };
  const on = await autostart.setAutostart(true, {binFile: 'C:\\muser\\bin\\muser.js', home, platform: 'win32', run});
  assert.equal(on.task, 'muser-server');
  assert.deepEqual(calls[0].slice(0, 4), ['schtasks', '/Create', '/TN', 'muser-server']);
  // Phase-2 coordination (autostart fix): turning ON now also deletes the
  // other (Run-key) registration, so both do not fire at logon — that call
  // sits between the create and any later delete.
  assert.deepEqual(calls[1].slice(0, 4), ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v'], 'on removes the Run-key registration too');
  assert.ok(fs.existsSync(path.join(home, '.muser', 'autostart.vbs')));
  const off = await autostart.setAutostart(false, {binFile: 'x', home, platform: 'win32', run});
  assert.equal(off.on, false);
  assert.deepEqual(calls[2].slice(0, 4), ['schtasks', '/Delete', '/TN', 'muser-server']);
  assert.deepEqual(calls[3].slice(0, 4), ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v'], 'off removes the Run-key registration too');
  assert.equal(fs.existsSync(path.join(home, '.muser', 'autostart.vbs')), false);
  await assert.rejects(() => autostart.setAutostart(true, {binFile: 'x', platform: 'linux', run}), /Windows-only/);
});
