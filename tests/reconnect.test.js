'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');
const {waitForReply} = require('../src/core/agent-reply');
const {NativeDevice} = require('../src/core/native-device');

const wait = ms => new Promise(r => setTimeout(r, ms));

// A gateway that has the reply ready but is offline until `online` is set.
function fakeClient() {
  const c = new EventEmitter();
  c.online = true;
  const reply = {seq: 2, timestamp: Date.now(), event: 'delta.message_done', session_id: 's1',
    payload: {session_id: 's1', message_id: 'm1', role: 'assistant', text: 'done', status: 'completed'}};
  c.history = async () => { if (!c.online) throw new Error('offline'); return {chat_events: [reply]}; };
  c.request = async () => { if (!c.online) throw new Error('offline'); return {session: {status: 'completed'}}; };
  return c;
}

test('a gateway drop during a turn does not end it; the reply is picked up after the reconnect', async () => {
  const client = fakeClient();
  const w = waitForReply({client, sessionId: 's1', pollMs: 50, settleMs: 0, reconnectGraceMs: 5000});
  client.online = false; client.emit('status', {status: 'disconnected'});
  w.accept('');
  await wait(200);
  client.online = true; client.emit('status', {status: 'connected'});
  const r = await w.promise;
  assert.equal(r.text, 'done');
});

test('a gateway that stays down past the grace period ends the turn', async () => {
  const client = fakeClient();
  const w = waitForReply({client, sessionId: 's1', pollMs: 50, reconnectGraceMs: 100});
  client.online = false; client.emit('status', {status: 'disconnected'}); w.accept('');
  await assert.rejects(w.promise, /接続が戻らない/);
});

test('an invoke re-sent on the reconnected device is answered from the record, not run again', async () => {
  const invokes = {inflight: new Map(), completed: new Map()};
  let runs = 0;
  const execute = async () => { runs++; await wait(100); return {ok: true, payload: {n: runs}}; };
  const before = new NativeDevice({execute, invokes}), after = new NativeDevice({execute, invokes});
  before._dispatchInvoke({id: 'inv1', command: 'code.edit', params: {}}); // socket drops mid-run
  after._dispatchInvoke({id: 'inv1', command: 'code.edit', params: {}});  // Muse re-sends it
  await wait(200);
  after._dispatchInvoke({id: 'inv1', command: 'code.edit', params: {}});  // and again after it finished
  await wait(50);
  assert.equal(runs, 1);
  assert.deepEqual(invokes.completed.get('inv1'), {ok: true, payload: {n: 1}});
});

function agentWithClient(client) {
  const {Agent} = require('../src/agent');
  const a = new Agent({client, auth: {saved: {}, vm: async () => ({})}, cwd: process.cwd(), session: {id: 's', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 0}});
  a.deviceConnects = 0;
  a.connectDevice = async () => { if (a.closed) throw new Error('closed'); a.deviceConnects++; a.device = {connected: true, disconnect() {}}; };
  return a;
}
function gateway() {
  const c = new EventEmitter();
  c.status = 'disconnected'; c.ws = {readyState: 1}; c.subscribes = 0; c.failSubscribe = 0;
  c.connect = async () => { await c.gate; c.status = 'connected'; };
  c.subscribe = async () => { c.subscribes++; if (c.failSubscribe-- > 0) throw new Error('subscribe failed'); };
  c.subscribeAgent = async () => {}; c.disconnect = () => { c.status = 'disconnected'; };
  return c;
}

// 2026-11-01 audit: a subscribe that failed after a good connect left the gateway "connected" but
// deaf, and the next attempt skipped subscribing, so replies never streamed again.
test('a failed subscribe is retried even though the gateway says connected', async () => {
  const c = gateway(); c.failSubscribe = 1;
  const a = agentWithClient(c);
  await assert.rejects(a.ensureConnected(), /subscribe failed/);
  assert.equal(c.status, 'connected');
  await a.ensureConnected();
  assert.equal(c.subscribes, 2, 'subscribed again');
  await a.ensureConnected();
  assert.equal(c.subscribes, 2, 'and not again once it worked');
  c.emit('status', {status: 'disconnected'}); c.status = 'disconnected'; clearTimeout(a.retryTimer); a.retryTimer = null;
  await a.ensureConnected();
  assert.equal(c.subscribes, 3, 'a dropped socket needs a new subscription');
  a.close();
});

test('a window closed during a reconnect does not connect the device again', async () => {
  const c = gateway(); let open; c.gate = new Promise(r => { open = r; });
  const a = agentWithClient(c);
  const p = a.ensureConnected();
  a.close(); open();
  await assert.rejects(p, /closed/);
  assert.equal(a.deviceConnects, 0);
});

test('a /chat/subscribe stream the gateway ends is opened again; other streams ending are ignored', async () => {
  const c = gateway();
  const a = agentWithClient(c);
  await a.ensureConnected();
  assert.equal(c.subscribes, 1);
  c.emit('stream-end', {path: '/chat/stream'}); // a send finishing: nothing to do
  c.emit('stream-end', {path: '/chat/subscribe'});
  assert.equal(a.subscribed, false);
  await wait(2300); // ended soon after it opened: the first retry waits 2 s
  assert.equal(c.subscribes, 2, 'subscribed again');
  assert.equal(a.subscribed, true);
  const reopened = [];
  c.subscribeAgent = async (sid, scope) => { reopened.push(scope); };
  a.main.turn = {owner: 'muser-x', waiting: {refresh() {}}};
  c.emit('stream-error', {path: '/chat/subscribe', scope: 'muser-x', message: 'reset'});
  assert.deepEqual(reopened, ['muser-x'], "a running turn's own subscription is reopened");
  a.main.turn = null; a.close();
});

test("a call refused as 'busy' runs when it is sent again after a slot frees up", async () => {
  const invokes = {inflight: new Map(), completed: new Map()};
  let release; const gate = new Promise(r => { release = r; });
  let runs = 0;
  const execute = async (command) => { runs++; if (command === 'slow') await gate; return {ok: true, payload: {command}}; };
  const d = new NativeDevice({execute, invokes});
  const sent = [];
  d._sendResult = async (id, r) => { sent.push([id, r.ok ? 'ok' : r.error]); };
  for (let i = 0; i < 6; i++) d._dispatchInvoke({id: 'slow' + i, command: 'slow', params: {}});
  d._dispatchInvoke({id: 'x', command: 'fast', params: {}});
  await wait(20);
  assert.deepEqual(sent.find(([id]) => id === 'x'), ['x', 'busy']);
  release(); await wait(50);
  d._dispatchInvoke({id: 'x', command: 'fast', params: {}});
  await wait(50);
  assert.deepEqual(sent.filter(([id]) => id === 'x').pop(), ['x', 'ok'], 'ran this time');
  assert.equal(runs, 7);
});

// A passing muse.ai error (5xx, 429) said "log in again" and stopped reconnecting.
test('a server error while checking the login is not taken for a lapsed login', async () => {
  const {MuseClient} = require('../src/core/muse-client');
  const stage = async status => new MuseClient({credentials: null, fetchJson: async () => { throw Object.assign(new Error('x'), {status}); }}).probeLogin();
  assert.equal(await stage(503), 'error');
  assert.equal(await stage(500), 'error');
  assert.equal(await stage(429), 'error');
  assert.equal(await stage(401), 'waiting');
  assert.equal(await stage(403), 'waiting');
});
