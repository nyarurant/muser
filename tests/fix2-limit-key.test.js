'use strict';
// First audit #22 (fix2 follow-up F3): POST /api/limit must REQUIRE the key
// of the open limitInput. Phase 1 / A8 only refused a MISMATCHED key when one
// was sent, so a keyless answer from a stale dialog landed on whatever newer
// limit input had opened since. A8 deferred the server half (the in-repo
// remote client sent no key and existing tests pinned keyless 200) and A12
// deferred the client half; this file pins the coordinated contract:
//   server: open input with a key + missing/mismatched request key -> 409,
//           no side effect, input stays open; matching key -> answers.
//   remote: limitKey posts the snapshot's key with both value and cancel.
// Design note (rows-F3.md): an open input WITHOUT a key has nothing to bind
// to, so keyless answers stay accepted for it — no in-tree producer creates
// one (controller.mjs always sets a key), and this keeps the fallback
// least-breaking. The out-of-tree C# GUI must likewise send the snapshot key
// (Android LinkClient.limitAnswer already does); its keyless answers to a
// keyed input are now refused with 409 instead of silently landing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.cwd = 'C:\\work'; this.mode = 'default'; this.session = {id: 'sess-1', turns: 2};
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 2};
  }
  async interrupt() {}
}
FakeAgent.DEVICE = 'fake-device';

class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.listeners = new Set(); this.limitAnswers = [];
    this.s = {entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null, mode: 'default', shells: [], focus: null, todos: [], agents: [], plan: null, menu: null, limitInput: null};
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  answerLimit(value) {
    const edit = this.s.limitInput;
    if (!edit) return false;
    this.limitAnswers.push(value);
    if (value === null) { this.set({limitInput: null}); if (edit.back) edit.back(); return; }
    if (!Number.isSafeInteger(value) || (edit.min !== undefined && (value < edit.min || value > edit.max))) return false;
    this.set({limitInput: null});
    if (edit.done) edit.done(value);
  }
}
function makeServer(t) {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-limitkey-'));
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {server, controller};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, body) {
  return fetch('http://127.0.0.1:' + server.port + '/api/limit', {method: 'POST', headers: {...AUTH, 'content-type': 'application/json'}, body: JSON.stringify(body)});
}
const openInput = (controller, key) => {
  const rec = {done: [], backed: 0};
  controller.set({limitInput: {key, label: 'x', text: '1', min: 1, max: 1000, done: v => rec.done.push(v), back: () => { rec.backed++; }}});
  return rec;
};

test('fix2 #22: a stale dialog answer with an omitted key is rejected and lands nowhere', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  // The user saw dialog A (key oldKey); a NEW input (key newKey) opened since.
  const rec = openInput(controller, 'newKey');
  const res = await call(server, {value: 5});
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /limit input has changed/);
  assert.deepEqual(rec.done, [], 'the newer input was not answered by the stale dialog');
  assert.deepEqual(controller.limitAnswers, [], 'answerLimit was never called');
  assert.ok(controller.s.limitInput, 'the current input stays open');
  // A keyless cancel is refused the same way (it must not close the new input).
  assert.equal((await call(server, {cancel: true})).status, 409);
  assert.equal(rec.backed, 0, 'back() did not run');
  assert.ok(controller.s.limitInput, 'still open after the keyless cancel');
});

test('fix2 #22: a stale key is rejected, the current key succeeds (value and cancel)', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const rec = openInput(controller, 'newKey');
  assert.equal((await call(server, {value: 5, key: 'oldKey'})).status, 409, 'stale key');
  assert.equal((await call(server, {cancel: true, key: 'oldKey'})).status, 409, 'stale cancel');
  assert.deepEqual(controller.limitAnswers, []);
  assert.equal((await call(server, {value: 42, key: 'newKey'})).status, 200, 'current key answers');
  assert.deepEqual(rec.done, [42]);
  assert.equal(controller.s.limitInput, null);
  const rec2 = openInput(controller, 'otherKey');
  assert.equal((await call(server, {cancel: true, key: 'otherKey'})).status, 200, 'current-key cancel answers');
  assert.equal(rec2.backed, 1);
  assert.equal(controller.s.limitInput, null);
});

test('fix2 #22: no input open stays 409, and a keyless open input keeps the legacy fallback', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.equal((await call(server, {value: 1, key: 'anything'})).status, 409, 'nothing pending');
  assert.equal((await call(server, {value: 1})).status, 409, 'nothing pending, keyless');
  // An open input without a key has nothing to bind to: keyless still answers.
  const rec = {done: []};
  controller.set({limitInput: {label: 'x', text: '1', min: 1, max: 1000, done: v => rec.done.push(v), back() {}}});
  assert.equal((await call(server, {value: 7})).status, 200);
  assert.deepEqual(rec.done, [7]);
});

// --- remote-controller half -------------------------------------------------
function snapshot(patch = {}) {
  return {
    version: '9.9.9', cwd: 'C:\\work', mode: 'default', busy: false, queue: [],
    approval: null, approvalQueue: [], reasonFor: false, limitInput: null, menu: null,
    todos: [], agents: [], shells: [], focus: null, plan: null,
    account: {id: 'default', label: 'Main'}, muse: {name: 'kaguya'}, spinnerWord: null,
    session: {id: 'sess-1', turns: 3, title: 'Chat'}, clientStatus: 'connected',
    device: {name: 'mizuki CLI (muser)', slot: 2, connected: true}, update: null,
    live: {stream: null, running: null, bangRunning: null, status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 0, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}],
    ...patch,
  };
}
function stubClient(snap = snapshot()) {
  return {
    info: {port: 1, token: 't'}, requests: [], handlers: null,
    request(method, p, body) {
      this.requests.push({method, path: p, body});
      if (method === 'GET' && p.endsWith('/state')) return Promise.resolve({status: 200, json: snap});
      if (method === 'GET' && p.includes('/complete')) return Promise.resolve({status: 200, json: {items: []}});
      return Promise.resolve({status: 202, json: {ok: true}});
    },
    events(id, handlers) { this.handlers = handlers; return () => {}; },
    emit(ev) { this.handlers.onEvent(ev); },
    posts(p) { return this.requests.filter(r => r.method === 'POST' && (!p || r.path === p)); },
  };
}
test('fix2 #22: remote limitKey posts the current limitInput key with value and cancel', async () => {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const client = stubClient();
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit() {}, onReload() {}});
  await ctrl.start();
  const state = patch => client.emit({kind: 'state', state: snapshot({...patch, entries: undefined})});
  state({limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '25', min: 1, max: 10000, hint: '1〜10000'}});
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts('/api/s/sess-1/limit').at(-1).body, {value: 25, key: 'maxToolCallsPerTurn'}, 'enter names the input it answers');
  state({limitInput: {key: 'dailyTurnLimit', label: '上限', text: '3', min: 0, max: 100, hint: '0〜100'}});
  ctrl.key('', {escape: true});
  assert.deepEqual(client.posts('/api/s/sess-1/limit').at(-1).body, {cancel: true, key: 'dailyTurnLimit'}, 'esc names the (different) input it cancels');
  ctrl.stop();
});
