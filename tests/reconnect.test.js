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
