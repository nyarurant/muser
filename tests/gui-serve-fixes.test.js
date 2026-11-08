'use strict';
// gui-serve fixes: (1) the standing goal in the state snapshot, (2) titles in
// the open-conversation list plus a server event when a title changes, and
// (3) a stale weekly plan re-read in the background when the GUI reads state.
// Fakes follow tests/gui-server.test.js / tests/server.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');
const {SessionsHost} = require('../src/server/sessions-host');

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.cwd = 'C:\\work'; this.mode = 'default';
    this.session = {id: 'sess-1', turns: 2, title: '', goal: null};
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 2};
    this.accountId = 'default'; this.accountLabel = null; this.busy = false;
  }
  standingGoal() { const g = this.session?.goal; return g && typeof g.text === 'string' && g.text ? g : null; }
  async interrupt() {}
  close() { this.closed = true; }
}
FakeAgent.DEVICE = 'fake-device';

class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.museName = null; this.listeners = new Set();
    this.s = {
      entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null,
      mode: 'default', shells: [], focus: null, todos: [], agents: [], plan: null, account: null,
      goal: null, menu: null, question: null, spinnerWord: null,
    };
    this.pending = [];
    this.refreshPlanCalls = 0;
    this.refreshPlanImpl = null; // a test may replace the refresh behaviour
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  refreshPlan() {
    this.refreshPlanCalls++;
    if (this.refreshPlanImpl) return this.refreshPlanImpl();
    const p = {percentUsed: 40 + this.refreshPlanCalls};
    return Promise.resolve().then(() => { this.set({plan: p}); return p; });
  }
}

function makeServer(t) {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-guiserve-'));
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p) {
  return fetch('http://127.0.0.1:' + server.port + p, {method, headers: AUTH});
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- 1. goal in the snapshot ---------------------------------------------------

test('snapshot: goal carries the standing goal from the Controller state, and null when none stands', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  let state = await (await call(server, 'GET', '/api/state')).json();
  assert.equal(state.goal, null);
  controller.set({goal: {text: 'テストを全部通す', legs: 2, setAt: 1730000000000}});
  state = await (await call(server, 'GET', '/api/state')).json();
  assert.deepEqual(state.goal, {text: 'テストを全部通す', legs: 2, setAt: 1730000000000});
});

test('snapshot: goal falls back to agent.standingGoal() and invents no fields', async t => {
  const {server, agent} = makeServer(t);
  await server.start();
  agent.session.goal = {text: 'agent 側のゴール'};
  const state = await (await call(server, 'GET', '/api/state')).json();
  assert.deepEqual(state.goal, {text: 'agent 側のゴール'}, 'only the fields the goal actually has cross the wire');
  agent.session.goal = null;
  const state2 = await (await call(server, 'GET', '/api/state')).json();
  assert.equal(state2.goal, null);
});

// ---- 2. title in the session list + a server event on change -------------------

function makePair(title) {
  const agent = new FakeAgent();
  agent.session = {id: 'sess-' + Math.random().toString(36).slice(2, 8), turns: 0, title};
  return {agent, controller: new FakeController(agent), museName: null};
}

test('host: infoOf/list carry the session title', async t => {
  const host = new SessionsHost({idleMs: 0});
  t.after(async () => { await host.closeAll(); });
  const pair = makePair('最初の題名');
  const entry = host.addPrepared({...pair, isDefault: true});
  assert.equal(host.infoOf(entry).title, '最初の題名');
  assert.equal(host.list()[0].title, '最初の題名');
  pair.agent.session.title = '';
  assert.equal(host.infoOf(entry).title, '', 'an untitled session keeps its empty title (snapshot session.title shape)');
});

test('host: a title change is announced as a session-title server event, once per change', async t => {
  const host = new SessionsHost({idleMs: 0});
  t.after(async () => { await host.closeAll(); });
  const events = [];
  host.on('event', e => events.push(e));
  const pair = makePair('');
  host.addPrepared({...pair, isDefault: true});
  // The title is set on the session by sessions.touch at a turn's start; the
  // turn's Controller changes are what reaches onEntryChange.
  pair.agent.session.title = '直した題名';
  pair.controller.set({busy: true});
  const titleEvents = events.filter(e => e.type === 'session-title');
  assert.equal(titleEvents.length, 1);
  assert.equal(titleEvents[0].sessionId, pair.agent.session.id);
  assert.equal(titleEvents[0].title, '直した題名');
  pair.controller.set({busy: false});
  assert.equal(events.filter(e => e.type === 'session-title').length, 1, 'no repeat event while the title is unchanged');
});

test('serverInfo: the single-conversation session item carries the title too', async t => {
  const {server, agent} = makeServer(t);
  await server.start();
  agent.session.title = '単独モードの題名';
  const info = await (await call(server, 'GET', '/api/server')).json();
  assert.equal(info.sessions[0].title, '単独モードの題名');
});

// ---- 3. stale plan re-read in the background -----------------------------------

test('plan: GET /api/state triggers a background refresh when no plan was ever read, at most once per window', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const state = await (await call(server, 'GET', '/api/state')).json();
  assert.equal(controller.refreshPlanCalls, 1, 'the read kicked off a refresh');
  assert.equal(state.plan, null, 'the answer itself is not waited on: it still shows the old (empty) plan');
  await tick(10); // the refresh lands through Controller.set
  const state2 = await (await call(server, 'GET', '/api/state')).json();
  assert.deepEqual(state2.plan, {percentUsed: 41}, 'the fresh plan is in the next snapshot');
  assert.equal(controller.refreshPlanCalls, 1, 'a fresh plan is not re-read');
});

test('plan: an existing plan is fresh on first sight, goes stale after the window, and failures respect the rate cap', async t => {
  const {server, controller} = makeServer(t);
  server.planRefreshMs = 50;
  controller.refreshPlanImpl = () => Promise.resolve(null); // a failing read keeps the old plan
  controller.set({plan: {percentUsed: 66}});
  await server.start();
  await call(server, 'GET', '/api/state');
  assert.equal(controller.refreshPlanCalls, 0, 'a plan first seen is treated as fresh');
  await tick(70);
  await call(server, 'GET', '/api/state');
  assert.equal(controller.refreshPlanCalls, 1, 'the same plan past the window is stale and re-read');
  await call(server, 'GET', '/api/state');
  assert.equal(controller.refreshPlanCalls, 1, 'still stale, but the attempt cap (one per window) holds');
  await tick(70);
  await call(server, 'GET', '/api/state');
  assert.equal(controller.refreshPlanCalls, 2, 'after the window a retry is allowed');
});

test('plan: subscribing to the state SSE also triggers the background refresh', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const ac = new AbortController();
  const res = await fetch('http://127.0.0.1:' + server.port + '/api/events', {headers: AUTH, signal: ac.signal});
  assert.equal(res.status, 200);
  await tick(10);
  assert.equal(controller.refreshPlanCalls, 1);
  ac.abort();
});

test('plan: the demo never refreshes', async t => {
  const {server, controller, agent} = makeServer(t);
  agent.client = {status: 'demo'};
  await server.start();
  await call(server, 'GET', '/api/state');
  assert.equal(controller.refreshPlanCalls, 0);
});
