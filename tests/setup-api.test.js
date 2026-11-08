'use strict';
// GuiServer setup mode (/api/setup): the first-run preparation questions are
// answered over HTTP before any conversation exists, driven here by a fake
// SetupFlow in the contracted shape (src/server/setup.js, built by another
// change): an EventEmitter with state()/start()/answer()/cancel() and
// 'change'/'done' events. The FakeAgent/FakeController/makeServer/fetch/
// eventStream helpers mirror tests/gui-server.test.js.
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
      mode: 'default', shells: [{id: 'bg1', command: 'npm run dev', running: true, started: 1}], focus: null,
      todos: [{content: 'ship the GUI', status: 'in_progress'}],
      agents: [{tag: 'a1', state: 'running', title: 'slice 2'}],
      plan: {percentUsed: 42},
    };
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  async submit(text) { this.submitted.push(text); }
}

// A SetupFlow fake in the contracted state shape. start() never settles
// (a real flow ends only when the user finishes), answer() binds to the one
// waiting prompt id 'p1', and both refuse with a status-409 error exactly
// like the real flow does for a stale answer / a second start.
function plainSetupState(patch = {}) {
  return {
    phase: 'idle',
    steps: {login: 'now', device: 'later'},
    prompt: null, busy: null, lines: [], message: null, error: null, checkpointUrl: null,
    ...patch,
  };
}
class FakeSetup extends EventEmitter {
  constructor() {
    super();
    this._state = plainSetupState();
    this.calls = [];
    this.running = false;
  }
  state() { return JSON.parse(JSON.stringify(this._state)); }
  setPhase(phase, patch = {}) { this._state = {...this._state, ...patch, phase}; this.emit('change'); }
  start() {
    this.calls.push(['start']);
    if (this.running) { const e = new Error('setup is already running'); e.status = 409; throw e; }
    this.running = true;
    this.setPhase('login');
    return new Promise(() => {});
  }
  answer(arg) {
    this.calls.push(['answer', arg]);
    if (!this.running || arg.promptId !== 'p1') { const e = new Error('no such prompt'); e.status = 409; throw e; }
    this.answers = [...(this.answers || []), arg];
  }
  cancel() {
    this.calls.push(['cancel']);
    this.running = false;
    this.setPhase('cancelled');
  }
}

function makeSetupServer(t, setup = new FakeSetup()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-setup-'));
  const discoveryFile = path.join(dir, 'gui.json');
  const server = new GuiServer({setup, token: 'test-token', port: 0, discoveryFile});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {setup, server, discoveryFile, dir};
}
function makePlainServer(t) {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-setup-'));
  const discoveryFile = path.join(dir, 'gui.json');
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server, discoveryFile};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p, {headers = {}, body} = {}) {
  return fetch('http://127.0.0.1:' + server.port + p, {
    method, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
// Collects SSE events from a fetch response as they arrive (gui-server.test.js).
function eventStream(res) {
  const events = [], waiters = [];
  let buf = '';
  const reader = res.body.getReader(), decoder = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += decoder.decode(value, {stream: true});
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (line) { events.push(JSON.parse(line.slice(6))); for (const w of waiters.splice(0)) w(); }
        }
      }
    } catch {}
  })();
  return {
    events,
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > ms) throw new Error('timed out waiting for an SSE event; got ' + JSON.stringify(events));
        await new Promise(r => { waiters.push(r); setTimeout(r, 25); });
      }
    },
  };
}

test('setup mode: start writes gui.json and GET /api/setup returns the state, no-store', async t => {
  const {setup, server, discoveryFile} = makeSetupServer(t);
  await server.start();
  const found = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
  assert.equal(found.port, server.port);
  assert.equal(found.token, 'test-token');
  assert.equal(found.sessionId, null, 'no conversation yet, so no sessionId');
  const res = await call(server, 'GET', '/api/setup', {headers: AUTH});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), setup.state());
});

test('no setup flow: GET /api/setup reports done', async t => {
  const {server} = makePlainServer(t);
  await server.start();
  const res = await call(server, 'GET', '/api/setup', {headers: AUTH});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {phase: 'done'});
});

test('answer reaches the setup flow by value and by index; a stale promptId stays 409', async t => {
  const {setup, server} = makeSetupServer(t);
  await server.start();
  // Not running yet: the flow's 409 passes through as 409.
  const early = await call(server, 'POST', '/api/setup/answer', {headers: AUTH, body: {promptId: 'p1', value: 'x'}});
  assert.equal(early.status, 409);
  await call(server, 'POST', '/api/setup/start', {headers: AUTH, body: {}});
  const stale = await call(server, 'POST', '/api/setup/answer', {headers: AUTH, body: {promptId: 'other', value: 'x'}});
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  const byValue = await call(server, 'POST', '/api/setup/answer', {headers: AUTH, body: {promptId: 'p1', value: 'me@example.com'}});
  assert.equal(byValue.status, 200);
  const byIndex = await call(server, 'POST', '/api/setup/answer', {headers: AUTH, body: {promptId: 'p1', index: 2}});
  assert.equal(byIndex.status, 200);
  assert.deepEqual(setup.answers, [{promptId: 'p1', value: 'me@example.com'}, {promptId: 'p1', index: 2}]);
});

test('start answers at once (the flow keeps running), a second start is 409, cancel reaches the flow', async t => {
  const {setup, server} = makeSetupServer(t);
  await server.start();
  const first = await call(server, 'POST', '/api/setup/start', {headers: AUTH, body: {}});
  assert.equal(first.status, 200, 'start returns without waiting for the flow to finish');
  assert.equal(setup.running, true);
  const second = await call(server, 'POST', '/api/setup/start', {headers: AUTH, body: {}});
  assert.equal(second.status, 409);
  const cancelled = await call(server, 'POST', '/api/setup/cancel', {headers: AUTH, body: {}});
  assert.equal(cancelled.status, 200);
  assert.deepEqual(setup.calls.map(c => c[0]), ['start', 'start', 'cancel']);
  assert.equal(setup.state().phase, 'cancelled');
});

test('setup routes without the token are 401', async t => {
  const {server} = makeSetupServer(t);
  await server.start();
  assert.equal((await call(server, 'GET', '/api/setup')).status, 401);
  assert.equal((await call(server, 'POST', '/api/setup/answer', {body: {promptId: 'p1', value: 'x'}})).status, 401);
  assert.equal((await call(server, 'POST', '/api/setup/start', {body: {}})).status, 401);
  assert.equal((await call(server, 'POST', '/api/setup/cancel', {body: {}})).status, 401);
  assert.equal((await call(server, 'GET', '/api/setup', {headers: {authorization: 'Bearer nope'}})).status, 401);
});

test('SSE /api/server/events carries setup changes; /api/server carries setup.phase', async t => {
  const {setup, server} = makeSetupServer(t);
  await server.start();
  const info = await (await call(server, 'GET', '/api/server', {headers: AUTH})).json();
  assert.equal(info.setup.phase, 'idle');
  const res = await call(server, 'GET', '/api/server/events', {headers: AUTH});
  assert.equal(res.status, 200);
  const stream = eventStream(res);
  setup.setPhase('contact');
  const hit = await stream.waitFor(e => e.kind === 'setup');
  assert.equal(hit.setup.phase, 'contact');
  const info2 = await (await call(server, 'GET', '/api/server', {headers: AUTH})).json();
  assert.equal(info2.setup.phase, 'contact');
});

test('while setup runs with no host, /api/state is the empty snapshot plus setup, other conversation routes 404', async t => {
  const {setup, server} = makeSetupServer(t);
  await server.start();
  setup.setPhase('contact');
  const res = await call(server, 'GET', '/api/state', {headers: AUTH});
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.session, {id: null, turns: 0});
  assert.deepEqual(state.setup, {phase: 'contact'});
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'hi'}})).status, 404);
  assert.equal((await call(server, 'GET', '/api/s/sess-1/state', {headers: AUTH})).status, 404);
});

test('setHost hands over: /api/state and the session routes work and gui.json names the session', async t => {
  const {server, discoveryFile} = makeSetupServer(t);
  await server.start();
  assert.equal(JSON.parse(fs.readFileSync(discoveryFile, 'utf8')).sessionId, null);
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const host = new SessionsHost({create: async () => { throw new Error('not used in this test'); }});
  t.after(async () => { await host.closeAll(); });
  host.addPrepared({agent, controller, museName: null, isDefault: true});
  server.setHost(host);
  const state = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(state.session.id, 'sess-1');
  assert.deepEqual(state.entries, [{id: 1, type: 'banner'}]);
  const prefixed = await call(server, 'GET', '/api/s/sess-1/state', {headers: AUTH});
  assert.equal(prefixed.status, 200);
  assert.equal((await prefixed.json()).session.id, 'sess-1');
  assert.equal(JSON.parse(fs.readFileSync(discoveryFile, 'utf8')).sessionId, 'sess-1', 'discovery rewritten by setHost');
});
