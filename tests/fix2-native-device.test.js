'use strict';
// Regression tests for fix phase 2, agent A11: work2/c7.md Medium #1-#5 and
// first audit #15, all in src/core/native-device.js.
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');
const {NativeDevice, ControlMessageDecoder, encodeControlMessage} = require('../src/core/native-device');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, what, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + what);
    await wait(10);
  }
}
function fakeSocket(readyState = 0) {
  const ws = new EventEmitter();
  ws.readyState = readyState;
  ws.send = () => {};
  ws.ping = () => {};
  ws.close = () => { ws.readyState = 2; };
  ws.terminate = () => { ws.readyState = 3; };
  return ws;
}
const device = execute => new NativeDevice({execute: execute || (async () => ({ok: true, payload: {}}))});

// --- c7 #1: a never-settling execute() must not leak its slot forever -------

test('fix2 c7#1 native-device: never-settling invokes free their slots after the zombie bound', async () => {
  let runs = 0;
  const d = device(() => { runs++; return new Promise(() => {}); });
  d._watchdogGraceMs = 20;
  d._zombieTimeoutMs = 50;
  const sent = [];
  d._sendResult = async (id, r) => { sent.push([id, r]); return true; };
  for (let i = 0; i < 6; i++) d._dispatchInvoke({id: 'hang' + i, command: 'x', params: {}, timeout_ms: 10});
  await waitFor(() => sent.filter(([, r]) => r.error === 'invoke_timeout').length === 6, 'watchdog answers all six');
  await waitFor(() => d._inflightInvokes.size === 0, 'all six slots freed despite execute never settling');
  d._dispatchInvoke({id: 'seventh', command: 'x', params: {}, timeout_ms: 10});
  await waitFor(() => sent.some(([id]) => id === 'seventh'), 'the seventh invoke is answered');
  assert.equal(runs, 7, 'the seventh invoke actually ran instead of being turned away');
  assert.deepEqual(sent.find(([id]) => id === 'seventh')[1], {ok: false, error: 'invoke_timeout'}, 'the seventh is answered by its own watchdog, not with busy');
});

test('fix2 c7#1 native-device: a watchdog-answered invoke keeps its slot until the zombie bound, then frees it', async () => {
  const d = device(() => new Promise(() => {}));
  d._watchdogGraceMs = 10;
  d._zombieTimeoutMs = 400;
  d._sendResult = async () => true;
  d._dispatchInvoke({id: 'zombie', command: 'x', params: {}, timeout_ms: 10});
  await waitFor(() => d._completedInvokes.has('zombie'), 'watchdog answered');
  await wait(100);
  assert.equal(d._inflightInvokes.has('zombie'), true, 'slot still held inside the zombie bound (#132 behaviour kept)');
  await waitFor(() => !d._inflightInvokes.has('zombie'), 'slot freed once the zombie bound passes');
});

// --- c7 #2: connect() during an in-flight attempt must not ignore new args --

test('fix2 c7#2 native-device: connect() with new credentials during an in-flight attempt supersedes it', async () => {
  const d = device();
  let made = 0;
  d._socketFactory = () => { made++; return fakeSocket(0); };
  const pA = d.connect({vm: {vm_id: 'vmA', vm_auth_token: 'tokA'}, nodeId: 'nA'});
  pA.catch(() => {});
  const pSame = d.connect({vm: {vm_id: 'vmA', vm_auth_token: 'tokA'}, nodeId: 'nA'});
  pSame.catch(() => {});
  assert.equal(made, 1, 'identical in-flight target: no new socket');
  const pB = d.connect({vm: {vm_id: 'vmB', vm_auth_token: 'tokB'}, nodeId: 'nB'});
  pB.catch(() => {});
  assert.equal(made, 2, 'new credentials during the attempt open a new socket');
  assert.equal(d._nodeId, 'nB');
  assert.equal(d._vmId, 'vmB');
  assert.equal(d._vmToken, 'tokB');
  await assert.rejects(pA, /connection_closed/, 'the superseded attempt is rejected, not silently kept');
  d._connectWait.resolve();
  await pB;
  d.disconnect();
});

// --- c7 #3: same-tick connect() after disconnect() must open a new socket ---

test('fix2 c7#3 native-device: connect() in the same tick as disconnect() starts a fresh attempt', async () => {
  const d = device();
  let made = 0;
  d._socketFactory = () => { made++; return fakeSocket(0); };
  const p1 = d.connect({vm: {vm_id: 'vmA', vm_auth_token: 't'}, nodeId: 'n1'});
  p1.catch(() => {});
  d.disconnect();
  const p2 = d.connect({vm: {vm_id: 'vmA', vm_auth_token: 't'}, nodeId: 'n1'});
  p2.catch(() => {});
  assert.equal(made, 2, 'a new socket is created synchronously, not the stale rejected promise');
  let rejected = null;
  p2.catch(e => { rejected = e; });
  await wait(30);
  assert.equal(rejected, null, 'the fresh attempt is still pending, not already rejected');
  d._connectWait.resolve();
  await p2;
  d.disconnect();
});

// --- c7 #4 + first #15: result-send coordination ----------------------------

test('fix2 c7#4 native-device: a duplicate arriving while the completion send is in flight does not double-send', async () => {
  const d = device(async () => ({ok: true, payload: {n: 1}}));
  let sends = 0;
  d._sendResult = async () => { sends++; await wait(60); return true; };
  d._dispatchInvoke({id: 'dup', command: 'x', params: {}});
  await waitFor(() => d._completedInvokes.has('dup'), 'completion cached (send now in flight)');
  d._dispatchInvoke({id: 'dup', command: 'x', params: {}});
  await wait(160);
  assert.equal(sends, 1, 'the in-flight send satisfied the duplicate');
  d._dispatchInvoke({id: 'dup', command: 'x', params: {}});
  await waitFor(() => sends === 2, 'a re-ask after delivery re-sends the cached result on its own connection');
});

test('fix2 first#15 native-device: a waiter during a failing send retries and delivers the result itself', async () => {
  const d = device();
  let calls = 0;
  d._sendResult = async () => { calls++; await wait(30); return calls > 1; };
  const result = {ok: true, payload: {n: 1}};
  const p1 = d._sendResultOnce('x', result);
  const p2 = d._sendResultOnce('x', result);
  assert.deepEqual(await Promise.all([p1, p2]), [false, true], 'the original send failed, and the waiter delivered the result itself instead of dropping it');
  assert.equal(calls, 2, 'the waiter claimed the send after the original attempt failed');
  assert.equal(d._sentInvokeResults.has('x'), true, 'the successful delivery is remembered');
});

test('fix2 first#15 native-device: a waiter during a successful send does not send again', async () => {
  const d = device();
  let calls = 0;
  d._sendResult = async () => { calls++; await wait(30); return true; };
  const result = {ok: true, payload: {n: 1}};
  await Promise.all([d._sendResultOnce('y', result), d._sendResultOnce('y', result)]);
  assert.equal(calls, 1, 'exactly one send between the original and the waiter');
});

// --- c7 #5: decoder must handle fragmented frames in linear work -----------

test('fix2 c7#5 native-device: the decoder reassembles byte-by-byte and interleaved fragments exactly', () => {
  const m1 = {type: 'res', id: 'r1', ok: true};
  const m2 = {type: 'res', id: 'r2', payload: 'hello'};
  const framed = Buffer.concat([encodeControlMessage(m1), encodeControlMessage(m2)]);
  const dec = new ControlMessageDecoder();
  const out = [];
  for (let i = 0; i < framed.length; i++) out.push(...dec.feed(framed.subarray(i, i + 1)));
  assert.deepEqual(out, [m1, m2], 'both messages survive 1-byte fragmentation, in order');
  const big = {type: 'res', id: 'big', data: 'x'.repeat(64 * 1024)};
  const bigFramed = encodeControlMessage(big);
  const dec2 = new ControlMessageDecoder();
  const out2 = [];
  for (let i = 0; i < bigFramed.length; i += 7) out2.push(...dec2.feed(bigFramed.subarray(i, i + 7)));
  assert.deepEqual(out2, [big], 'a 64 KB message in 7-byte fragments parses exactly');
});

test('fix2 c7#5 native-device: fragmented oversize headers and corrupt payloads still fail as before', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(5 * 1024 * 1024, 0);
  const dec = new ControlMessageDecoder();
  assert.deepEqual(dec.feed(header.subarray(0, 2)), [], 'a split header waits');
  assert.throws(() => dec.feed(header.subarray(2)), /inbound_too_large/, 'an oversize declared length is refused once the header completes');
  const bad = Buffer.alloc(4);
  const payload = Buffer.from('{not json');
  bad.writeUInt32LE(payload.length, 0);
  const dec2 = new ControlMessageDecoder();
  const framed = Buffer.concat([bad, payload]);
  assert.throws(() => { for (let i = 0; i < framed.length; i += 3) dec2.feed(framed.subarray(i, i + 3)); }, /protocol_error/, 'a corrupt payload fed in fragments is still a protocol error (#135)');
});
