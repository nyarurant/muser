'use strict';
// Fix phase 1, agent E slice — regression tests for:
//  first #5  (gui-server: link revoke must terminate the device's live channels)
//  deep H1   (gui-server: approval/menu POSTs are bound to the displayed object's id)
//  deep H12  (sessions-host: busyOf / activeOf see workers and selectable questions)
//  deep H13  (sessions-host: closing the default promotes another conversation)
//  third H3  (sessions-host + bin/muser.js: explicit 'new' sentinel, no startup-resume leak)
// (Third H4 is Android/Kotlin-only and has no JS test; first #6's fix is the
// channel-side allowlist in src/link/channel-server.js, owned by another agent.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');
const {SessionsHost, NEW_SESSION, busyOf, activeOf} = require('../src/server/sessions-host');

let seq = 0;
class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super(); seq++;
    this.cwd = cwd || 'C:\\work'; this.mode = 'default';
    this.session = {id: 'sess-' + seq, turns: 0};
    this.accountId = 'default'; this.accountLabel = null; this.busy = false; this.closed = false;
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 1};
    this.shells = {kill: id => ({id, killed: true})};
  }
  async interrupt() {}
  close() { this.closed = true; }
}
FakeAgent.DEVICE = 'fake-device';
class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.museName = 'kaguya';
    this.listeners = new Set(); this.submitted = []; this.outputs = []; this.pending = [];
    this.s = {entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null, mode: 'default', shells: [], focus: null, todos: [], agents: [], plan: null, account: null, menu: null, spinnerWord: null};
    this.menuCancels = 0;
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  async submit(text) { this.submitted.push(text); }
  nextApproval() { this.promoted = (this.promoted || 0) + 1; }
  setMode(m) { this.agent.mode = m; this.set({mode: m}); }
  cancelMenu() { const m = this.s.menu; if (!m) return; this.menuCancels++; this.set({menu: null}); m.cancel?.(); }
  askPending() {
    let settled = null;
    const req = {call: {command: 'system.run', agent: 'main', summary: 'x'}, preview: null, index: 0, outside: false, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], resolve: v => { settled = v; }};
    this.set({approval: req});
    return {req, settled: () => settled};
  }
}
function makePair(cwd) { const agent = new FakeAgent(cwd); return {agent, controller: new FakeController(agent), museName: 'kaguya'}; }
function makeSingle(t) {
  const {agent, controller} = makePair('C:\\a');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-'));
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server};
}
function makeHost(t, hostOpts = {}) {
  const made = [], calls = [], stored = new Map();
  const host = new SessionsHost({
    create: async ({cwd, account, mode, session}) => { calls.push({cwd, account, mode, session}); const pair = makePair(cwd); if (session && typeof session === 'object') pair.agent.session = {...session}; made.push(pair); return pair; },
    findSession: ref => stored.get(ref) || null,
    idleMs: 0,
    ...hostOpts,
  });
  t.after(async () => { await host.closeAll(); });
  return {host, made, calls, stored};
}
function makeHostServer(t, host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1srv-'));
  const server = new GuiServer({host, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json'), serverDiscoveryFile: path.join(dir, 'server.json'), accountsProvider: () => [], recentProvider: () => []});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return server;
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p, {headers = {}, body} = {}) {
  return fetch('http://127.0.0.1:' + server.port + p, {method, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})}, body: body !== undefined ? JSON.stringify(body) : undefined});
}
function tmpDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1cwd-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
async function stateOf(server, p = '/api/state') { return (await call(server, 'GET', p, {headers: AUTH})).json(); }

// ---- deep H1: approval identity -------------------------------------------------

test('fix1 H1: snapshot gives each approval a stable unique id; a mismatched approvalId is 409 and does not resolve the current approval', async t => {
  const {server, controller} = makeSingle(t);
  await server.start();
  const a = controller.askPending();
  const snapA = await stateOf(server);
  assert.equal(typeof snapA.approval.id, 'string', 'the snapshot approval carries an id');
  assert.ok(snapA.approval.id.length > 0);
  const snapA2 = await stateOf(server);
  assert.equal(snapA2.approval.id, snapA.approval.id, 'the same approval keeps its id across snapshots');
  // Approval A is replaced by B (timeout / TUI answer / queue promotion).
  const b = controller.askPending();
  const snapB = await stateOf(server);
  assert.notEqual(snapB.approval.id, snapA.approval.id, 'a different approval gets a different id');
  // The delayed / duplicate answer meant for A arrives now.
  const stale = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}, approvalId: snapA.approval.id}});
  assert.equal(stale.status, 409, 'a stale approvalId is rejected');
  assert.equal(b.settled(), null, 'the current approval B was NOT resolved by A\'s answer');
  assert.equal(controller.s.approval, b.req, 'approval B is still the one on display');
  // The same binding via decision.approvalId.
  const stale2 = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true, approvalId: snapA.approval.id}}});
  assert.equal(stale2.status, 409);
  assert.equal(b.settled(), null);
  // The answer that names B works.
  const ok = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}, approvalId: snapB.approval.id}});
  assert.equal(ok.status, 200);
  assert.deepEqual(b.settled(), {allow: true, always: null});
  assert.equal(a.settled(), null, 'approval A was never resolved by any of this');
});

test('fix1 H1: an approval POST with no id still works (legacy clients)', async t => {
  const {server, controller} = makeSingle(t);
  await server.start();
  const one = controller.askPending();
  const res = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: false, reason: 'no'}}});
  assert.equal(res.status, 200);
  assert.deepEqual(one.settled(), {allow: false, reason: 'no'});
});

test('fix1 H1: snapshot gives each menu a stable unique id; mismatched menuId is 409 for pick and cancel, matching id works', async t => {
  const {server, controller} = makeSingle(t);
  await server.start();
  let picked = null, cancelled = 0;
  const menuA = {title: 'A', index: 0, options: [{value: 'a', label: 'A'}], pick: v => { picked = v; }, cancel: () => { cancelled++; }};
  controller.set({menu: menuA});
  const snapA = await stateOf(server);
  assert.equal(typeof snapA.menu.id, 'string', 'the snapshot menu carries an id');
  assert.equal((await stateOf(server)).menu.id, snapA.menu.id, 'the same menu keeps its id');
  const menuB = {title: 'B', index: 0, options: [{value: 'b', label: 'B'}], pick: v => { picked = v; }, cancel: () => { cancelled++; }};
  controller.set({menu: menuB});
  const snapB = await stateOf(server);
  assert.notEqual(snapB.menu.id, snapA.menu.id, 'a different menu gets a different id');
  const stale = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 0, menuId: snapA.menu.id}});
  assert.equal(stale.status, 409, 'a pick naming the previous menu is rejected');
  assert.equal(picked, null, 'the current menu was NOT picked by the stale POST');
  assert.equal(controller.s.menu, menuB, 'menu B is still open');
  const staleCancel = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {cancel: true, menuId: snapA.menu.id}});
  assert.equal(staleCancel.status, 409, 'a cancel naming the previous menu is rejected too');
  assert.equal(controller.s.menu, menuB);
  assert.equal(cancelled, 0);
  const ok = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 0, menuId: snapB.menu.id}});
  assert.equal(ok.status, 200);
  assert.equal(picked, 'b');
  assert.equal(controller.s.menu, null);
  // A legacy no-id pick still works.
  controller.set({menu: {title: 'C', index: 0, options: [{value: 'c', label: 'C'}], pick: v => { picked = v; }}});
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 0}})).status, 200);
  assert.equal(picked, 'c');
});

// ---- first #5: revoke terminates live channels -----------------------------------

test('fix1 #5: POST /api/server/link/revoke terminates the device channels through the link API and reports the count', async t => {
  const {server} = makeSingle(t);
  await server.start();
  const calls = [];
  server.link = {
    remoteStore: {remove: target => target === 'dev1' ? {id: 'dev1', name: 'phone'} : null},
    closeChannelsForDevice: (id, device) => { calls.push([id, device?.name]); return 2; },
    state: () => ({devices: []}),
  };
  const res = await call(server, 'POST', '/api/server/link/revoke', {headers: AUTH, body: {id: 'dev1'}});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {ok: true, terminated: 2});
  assert.deepEqual(calls, [['dev1', 'phone']], 'the per-device channel close was called for the revoked device');
  const missing = await call(server, 'POST', '/api/server/link/revoke', {headers: AUTH, body: {id: 'nope'}});
  assert.equal(missing.status, 404);
  assert.equal(calls.length, 1, 'no channel close is attempted for a device that was not removed');
});

test('fix1 #5: revoke fallback closes only channel entries labelled with the revoked device id', async t => {
  const {server} = makeSingle(t);
  await server.start();
  const mk = deviceId => ({deviceId, closed: 0, close() { this.closed++; }});
  const mine = mk('dev1'), other = mk('dev2'), unlabelled = mk(undefined); delete unlabelled.deviceId;
  server.link = {
    remoteStore: {remove: () => ({id: 'dev1', name: 'phone'})},
    channels: new Set([mine, other, unlabelled]),
    state: () => ({devices: []}),
  };
  const res = await call(server, 'POST', '/api/server/link/revoke', {headers: AUTH, body: {name: 'phone'}});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).terminated, 1);
  assert.equal(mine.closed, 1, 'the revoked device channel was closed');
  assert.equal(other.closed, 0, 'another device channel was left alone');
  assert.equal(unlabelled.closed, 0, 'an unlabelled channel is not closed on guesswork');
});

// ---- deep H12: busyOf / activeOf ---------------------------------------------------

test('fix1 H12: busyOf is the snapshot busy OR the agent busy (a false snapshot no longer hides the agent)', () => {
  const entry = (s, agent) => ({id: 'x', controller: {s}, agent});
  assert.equal(busyOf(entry({busy: false, agents: []}, {busy: true})), true, 'agent busy wins over a false snapshot');
  assert.equal(busyOf(entry({busy: true, agents: []}, {busy: false})), true, 'snapshot busy still counts');
  assert.equal(busyOf(entry({busy: false, agents: [{tag: 'a1', state: 'working'}]}, {busy: false})), true, 'a working worker in the snapshot counts');
  assert.equal(busyOf(entry({busy: false, agents: [{tag: 'a1', state: 'done'}]}, {busy: false, agents: () => [{tag: 'a2', state: 'working'}]})), true, 'a working worker from agent.agents() counts');
  assert.equal(busyOf(entry({busy: false, agents: []}, {busy: false})), false, 'genuinely idle is idle');
});

test('fix1 H12: activeOf sees workers by state === working and an open selectable question, so the host protects both', async t => {
  const entry = s => ({id: 'x', controller: {s}, agent: {busy: false}});
  const base = {busy: false, approval: null, menu: null, shells: [], queue: [], agents: []};
  assert.equal(activeOf(entry({...base, agents: [{tag: 'a1', state: 'working'}]})), true, 'state working is active (the old a.running/a.status fields do not exist)');
  assert.equal(activeOf(entry({...base, agents: [{tag: 'a1', state: 'done'}]})), false);
  assert.equal(activeOf(entry({...base, question: {questions: [{question: 'q'}]}})), true, 'an open selectable question is active');
  assert.equal(activeOf(entry({...base})), false);
  // Host level: a question-open conversation is not swept and refuses a plain close.
  const {host} = makeHost(t, {idleMs: 1000});
  host.addPrepared({...makePair('C:\\def'), isDefault: true}); // the sweep never closes the default; e1 must be a non-default
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  e1.lastUsedAt = Date.now() - 5000;
  e1.controller.set({question: {questions: [{question: 'which?'}], tab: 0, checked: {}, answers: {}}});
  assert.deepEqual(host.closeIdle(), [], 'the idle sweep leaves a question-open conversation alone');
  assert.throws(() => host.close(e1.id), err => err.status === 409, 'and a plain close refuses');
  e1.controller.set({question: null, agents: [{tag: 'a1', state: 'working'}]});
  assert.deepEqual(host.closeIdle(), [], 'the sweep also leaves a worker-working conversation alone');
  assert.equal(host.infoOf(e1).busy, true, 'the session list reports it busy, so the user sees it too');
  e1.controller.set({agents: []});
  assert.deepEqual(host.closeIdle(), [e1.id], 'once truly idle it is swept');
});

// ---- deep H13: default promotion -----------------------------------------------------

test('fix1 H13: closing the default promotes the most recently used remaining conversation; unprefixed routes follow it', async t => {
  const {host} = makeHost(t);
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  const e2 = await host.openNew({cwd: dir});
  host.touch(e1.id); // e1 is now the most recently used survivor
  const server = makeHostServer(t, host);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/sessions/' + def.id + '/close', {headers: AUTH, body: {}})).status, 200);
  assert.equal(host.defaultId, e1.id, 'the most recently used survivor was promoted to default');
  assert.equal(host.defaultEntry().id, e1.id);
  assert.equal(host.list().find(s => s.id === e1.id).isDefault, true);
  assert.equal(host.list().find(s => s.id === e2.id).isDefault, false);
  const state = await stateOf(server);
  assert.equal(state.session.id, e1.id, 'the unprefixed /api/state now serves the promoted conversation instead of 404ing forever');
});

test('fix1 H13/#59: opens do NOT become the default when there is none (promotion happens only at close, among survivors)', async t => {
  const {host, stored} = makeHost(t);
  const def = host.addPrepared({...makePair('C:\\a'), isDefault: true});
  host.close(def.id, {force: true});
  assert.equal(host.defaultId, null, 'no survivors: the default is empty');
  assert.equal(host.size, 0);
  const dir = tmpDir(t);
  const fresh = await host.openNew({cwd: dir});
  assert.equal(host.defaultId, null, '#59: a later unrelated open is not silently made the unprefixed target');
  host.close(fresh.id, {force: true});
  stored.set('past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'});
  await host.openExisting('past-1');
  assert.equal(host.defaultId, null, 'openExisting keeps the same #59 behaviour');
});

// ---- third H3: explicit new sentinel ---------------------------------------------------

test('fix1 H3: openNew passes the NEW_SESSION sentinel to the factory; openExisting passes the stored session object', async t => {
  const {host, calls, stored} = makeHost(t);
  const dir = tmpDir(t);
  await host.openNew({cwd: dir});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, NEW_SESSION, 'openNew sends the explicit sentinel, not undefined');
  assert.equal(NEW_SESSION, 'new');
  stored.set('past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'});
  await host.openExisting('past-1');
  assert.equal(calls[1].session.id, 'past-1', 'openExisting still passes the stored session itself');
  assert.equal(calls[1].session.turns, 3);
});

test('fix1 H3: bin/muser.js prepare() distinguishes the explicit-new sentinel from not-specified', () => {
  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'muser.js'), 'utf8');
  assert.match(bin, /overrides\.session === 'new' \? null/, 'prepare() maps the sentinel to a fresh (null) session instead of the startup flags');
  assert.match(bin, /overrides\.session !== undefined \? overrides\.session : sessionFromFlags\(o\)/, 'an unspecified session still falls back to the startup flags (CLI resume unchanged)');
  assert.match(bin, /session !== 'new'/, 'the serve factory does not treat the sentinel as a stored session');
});
