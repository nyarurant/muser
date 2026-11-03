'use strict';
// Regression tests for audit-2026-11-03 items #108-#137 (sections H proxy and
// I core client): src/link/proxy.js, src/core/muse-client.js,
// src/core/native-device.js, src/core/noise.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {EventEmitter} = require('node:events');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, what, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + what);
    await wait(20);
  }
}
function serve(t, handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    resolve(server.address().port);
  }));
}

// --- proxy (#110, #111, #112, #114, #115, #116, #117) --------------------------
const {createProxy} = require('../src/link/proxy');

test('#117 proxy: SSE frames split on mixed CRLF/LF endings stay byte-exact', async t => {
  const port = await serve(t, (req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: one\r\n\n');
    res.write('data: two\n\r\n');
    res.write('data: three\n\n');
  });
  const proxy = createProxy({port, token: 't'});
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('events missing: ' + JSON.stringify(events))), 4000);
    const close = proxy.openSubscription('/api/events', (event, data) => {
      events.push(data);
      if (events.length === 3) { clearTimeout(timer); close(); resolve(); }
    }, reject);
  });
  assert.deepEqual(events, ['one', 'two', 'three']);
});

test('#110 proxy: the request timeout is a deadline, not socket inactivity', async t => {
  let drip;
  const port = await serve(t, (req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    drip = setInterval(() => res.write(' '), 50); // a chunk every 50 ms, never an end
    res.on('close', () => clearInterval(drip));
  });
  const proxy = createProxy({port, token: 't', requestTimeoutMs: 300});
  const t0 = Date.now();
  await assert.rejects(proxy.request({path: '/x'}), /did not answer in time/);
  assert.ok(Date.now() - t0 < 3000, 'died at the deadline despite the drip: ' + (Date.now() - t0) + ' ms');
});

test('#111 proxy: responses are size-capped and the content type is preserved', async t => {
  const port = await serve(t, (req, res) => {
    if (req.url === '/big') { res.writeHead(200, {'content-type': 'text/plain'}); return res.end('x'.repeat(4096)); }
    res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({ok: 1}));
  });
  const proxy = createProxy({port, token: 't', maxResponseBytes: 1024});
  await assert.rejects(proxy.request({path: '/big'}), /too large/);
  const out = await proxy.request({path: '/json'});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, {ok: 1});
  assert.match(out.contentType, /application\/json/);
});

test('#112 proxy: a subscription that goes silent is failed by the idle watchdog', async t => {
  const port = await serve(t, (req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: {"kind":"state"}\n\n'); // one frame, then silence (no heartbeats)
  });
  const proxy = createProxy({port, token: 't', subIdleMs: 200});
  const err = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 4000);
    proxy.openSubscription('/api/events', () => {}, e => { clearTimeout(timer); resolve(e); });
  });
  assert.ok(err, 'onError fired');
  assert.match(err.message, /went silent/);
});

test('#114/#115 proxy: subscription errors fire onError exactly once and never after close()', async t => {
  const port = await serve(t, (req, res) => {
    if (req.url === '/drop') {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: x\n\n');
      setTimeout(() => res.socket.destroy(), 30); // error AND end on the client side
      return;
    }
    setTimeout(() => { res.writeHead(500); res.end('no'); }, 100); // slow failure
  });
  const proxy = createProxy({port, token: 't'});
  let errors = 0;
  proxy.openSubscription('/drop', () => {}, () => { errors++; });
  await wait(400);
  assert.equal(errors, 1, 'one onError despite error+end both firing');
  let late = 0;
  const close = proxy.openSubscription('/slow', () => {}, () => { late++; });
  close();
  await wait(300);
  assert.equal(late, 0, 'no onError after close()');
});

test('#116 proxy: an SSE stream that never delimits a frame is capped', async t => {
  const port = await serve(t, (req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: ' + 'x'.repeat(5000)); // no blank line, ever
  });
  const proxy = createProxy({port, token: 't', maxSseBufferBytes: 1024});
  const err = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 4000);
    proxy.openSubscription('/api/events', () => {}, e => { clearTimeout(timer); resolve(e); });
  });
  assert.ok(err, 'onError fired');
  assert.match(err.message, /frame too large/);
});

// --- muse-client (#120-#126) --------------------------------------------------
const {MuseClient} = require('../src/core/muse-client');

function fakeClient() {
  const c = new MuseClient({credentials: {appId: 'a', vmId: 'vm1'}, fetchJson: null});
  c.status = 'connected';
  let nextId = 0n;
  const sent = {frames: [], resets: []};
  c.ws = {readyState: 1, send: f => sent.frames.push(f), on() {}, once() {}, close() {}};
  c.transport = {
    request: () => ({id: ++nextId, frames: ['f']}),
    reset: id => { sent.resets.push(id); return ['r']; },
    destroy() {},
  };
  return {c, sent};
}

test('#124 muse-client: request() rejects instead of throwing synchronously', async () => {
  const {c} = fakeClient();
  c.transport.request = () => { throw new Error('Muse request too large'); };
  const p = c.request('POST', '/x', {a: 1});
  assert.ok(p instanceof Promise, 'a promise came back, not a throw');
  await assert.rejects(p, /too large/);
  const {c: c2} = fakeClient();
  const circ = {}; circ.self = circ;
  await assert.rejects(c2.request('POST', '/x', circ), 'unserializable params reject too');
});

test('#123 muse-client: cancelRequest never throws, so the timeout path still rejects', async () => {
  const {c} = fakeClient();
  const p = c.request('GET', '/api/session/list', {});
  p.catch(() => {});
  c.transport.reset = () => { throw new Error('dead cipher'); };
  assert.doesNotThrow(() => c.cancelRequest(1n));
  assert.equal(c.pending.size, 0);
  const {c: c2} = fakeClient();
  c2.transport.reset = () => { throw new Error('dead cipher'); };
  await assert.rejects(c2.request('POST', '/x', {}, {timeout: 30}), /タイムアウト/, 'the caller still settles the promise');
});

test('#122 muse-client: subscribe(session B) does not cancel session A\'s subscription', async () => {
  const {c} = fakeClient();
  const pA = c.subscribe('sessA'); pA.catch(() => {});
  const pB = c.subscribe('sessB'); pB.catch(() => {});
  assert.equal(c.pending.size, 2, 'both subscriptions live');
  assert.deepEqual([...c.pending.values()].map(p => p.sessionId).sort(), ['sessA', 'sessB']);
  const pA2 = c.subscribe('sessA'); pA2.catch(() => {});
  assert.deepEqual(await pA, {subscribed: false, cancelled: true}, 'the same-session one was replaced');
  assert.equal(c.pending.size, 2, 'B survived, new A registered');
  c.disconnect(false);
});

test('#121 muse-client: a stream failing before its first record still emits stream-error', async () => {
  const {c} = fakeClient();
  const errors = [];
  c.on('stream-error', e => errors.push(e));
  const p = c.subscribe('s1');
  const id = [...c.pending.keys()][0];
  c.onFrame({id: BigInt(id), type: 'reset'});
  await assert.rejects(p, /終了しました/);
  assert.equal(errors.length, 1, 'stream-error fired for the unsettled stream');
  assert.equal(errors[0].path, '/chat/subscribe');
});

test('#120 muse-client: a stream that stalls after its first record is idled out', async () => {
  const {c, sent} = fakeClient();
  const errors = [];
  c.on('stream-error', e => errors.push(e));
  const p = c.request('POST', '/chat/stream', {message: 'hi'}, {stream: true, timeout: 60000, streamIdleMs: 120});
  const id = [...c.pending.keys()][0];
  c.onFrame({id: BigInt(id), type: 'response', status: 200, headers: [['content-type', 'application/x-ndjson']], body: Buffer.from(JSON.stringify({type: 'event', event: 'x', payload: {}}) + '\n'), end: false});
  assert.deepEqual(await p, {}, 'first record settled the promise');
  assert.equal(c.pending.size, 1, 'the stream stays pending');
  await waitFor(() => errors.length === 1, 'the idle stream-error');
  assert.equal(c.pending.size, 0, 'the stalled stream pending was released');
  assert.deepEqual(sent.resets, [BigInt(id)], 'and the gateway was told to reset it');
});

test('#125 muse-client: a frame error resets the stream on the gateway', async () => {
  const {c, sent} = fakeClient();
  const p = c.request('POST', '/x', {});
  const id = [...c.pending.keys()][0];
  c.onFrame({id: BigInt(id), type: 'response', status: 500, headers: [], body: Buffer.from('{}'), end: true});
  await assert.rejects(p, /HTTP 500/);
  assert.deepEqual(sent.resets, [BigInt(id)]);
});

test('#126 muse-client: a credential refresh for a different VM is deferred until disconnect', async () => {
  const fetchJson = async path => path.startsWith('/api/session')
    ? {endpoint_url: 'https://vm2.metaaivm.com', vm_id: 'vm2', vm_name: 'VM2'}
    : {token: 'tok2', notary_token: 'nt2'};
  const c = new MuseClient({credentials: {gateway: 'https://hatch.metaaivm.com', vmId: 'vm1', appId: 'a', token: 'tok1', source: 'login'}, fetchJson});
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  ws.terminate = () => { ws.readyState = 3; };
  c.ws = ws; c.status = 'connected'; c.socketVmId = 'vm1';
  const emitted = [];
  c.on('credentials', x => emitted.push(x));
  assert.equal(await c.probeLogin(), 'ready');
  assert.equal(c.credentials.vmId, 'vm1', 'live socket VM and stored credentials stay in step');
  assert.equal(emitted.length, 0, 'nothing persisted yet');
  c.disconnect(false);
  assert.equal(c.credentials.vmId, 'vm2', 'the deferred credentials applied at disconnect');
  assert.equal(emitted.length, 1);
  // Same-VM refresh (a token rotation) still applies immediately.
  const fetchJson2 = async path => path.startsWith('/api/session')
    ? {endpoint_url: 'https://vm1.metaaivm.com', vm_id: 'vm1', vm_name: 'VM1'}
    : {token: 'tok9', notary_token: 'nt9'};
  const c2 = new MuseClient({credentials: {gateway: 'https://hatch.metaaivm.com', vmId: 'vm1', appId: 'a', token: 'tok1', source: 'login'}, fetchJson: fetchJson2});
  assert.equal(await c2.probeLogin(), 'ready');
  assert.equal(c2.credentials.token, 'tok9');
});

// --- native-device (#127-#135) ------------------------------------------------
const {NativeDevice, ControlMessageDecoder, encodeControlMessage, MAX_INBOUND_MESSAGE} = require('../src/core/native-device');

function fakeSocket(readyState = 1) {
  const ws = new EventEmitter();
  ws.readyState = readyState;
  ws.send = () => {};
  ws.ping = () => {};
  ws.close = () => { ws.readyState = 2; };
  ws.terminate = () => { ws.readyState = 3; };
  return ws;
}
const device = execute => new NativeDevice({execute: execute || (async () => ({ok: true, payload: {}}))});

test('#127 native-device: connect() with new credentials for the same nodeId reconnects', async () => {
  const d = device();
  let made = 0;
  d._socketFactory = () => { made++; return fakeSocket(0); };
  const p1 = d.connect({vm: {vm_id: 'vm1', vm_auth_token: 'tok1'}, nodeId: 'n1'});
  p1.catch(() => {});
  d._connectWait.resolve();
  await p1;
  // Simulate the established connection connect() would normally reach.
  d._ws = fakeSocket(1); d._transport = {destroy() {}}; d._connected = true;
  d._nodeId = 'n1'; d._vmId = 'vm1'; d._vmToken = 'tok1';
  await d.connect({vm: {vm_id: 'vm1', vm_auth_token: 'tok1'}, nodeId: 'n1'});
  assert.equal(made, 1, 'identical credentials: no reconnect');
  const p2 = d.connect({vm: {vm_id: 'vm1', vm_auth_token: 'tok2'}, nodeId: 'n1'});
  p2.catch(() => {});
  assert.equal(made, 2, 'a rotated token reconnects');
  assert.equal(d._vmToken, 'tok2');
  d.disconnect();
  await assert.rejects(p2, /connection_closed/);
});

test('#128 native-device: cleanup terminates a socket whose close handshake stalls', async () => {
  const d = device();
  const ws = fakeSocket(1);
  let terminated = false;
  ws.close = () => {}; // never answers
  ws.terminate = () => { terminated = true; ws.readyState = 3; };
  d._ws = ws; d._phase = 'connected';
  d.disconnect();
  assert.equal(terminated, false, 'close is tried first');
  await wait(2300);
  assert.equal(terminated, true, 'terminated after the grace period');
});

test('#129 native-device: any inbound frame feeds the ping watchdog', () => {
  const d = device();
  const ws = fakeSocket(1);
  d._ws = ws; d._phase = 'control'; d._transport = {decode: () => null};
  const before = d._lastInboundAt;
  d._onMessage(ws, Buffer.from('frame'));
  assert.ok(d._lastInboundAt > before && Date.now() - d._lastInboundAt < 1000, 'inbound activity recorded');
});

test('#130 native-device: a duplicate invoke while running gets exactly one result send', async () => {
  const d = device(async () => { await wait(60); return {ok: true, payload: {n: 1}}; });
  let sends = 0;
  d._sendResult = async () => { sends++; return true; };
  d._dispatchInvoke({id: 'dup', command: 'code.read', params: {}});
  d._dispatchInvoke({id: 'dup', command: 'code.read', params: {}});
  await waitFor(() => d._completedInvokes.has('dup'), 'completion');
  await wait(50);
  assert.equal(sends, 1, 'original + duplicate waiter sent once between them');
});

test('#131 native-device: an evicted completed invoke is tombstoned, not re-executed', async () => {
  let runs = 0;
  const d = device(async () => { runs++; return {ok: true, payload: {runs}}; });
  const sent = [];
  d._sendResult = async (id, r) => { sent.push([id, r]); return true; };
  // Dispatch in waves: at most MAX_CONCURRENT_INVOKES (6) run at once, the
  // rest would be answered 'busy' (and busy is deliberately not remembered).
  for (let i = 1; i <= 130; i++) {
    d._dispatchInvoke({id: 'inv' + i, command: 'code.read', params: {}});
    if (i % 6 === 0) await waitFor(() => d._inflightInvokes.size === 0, 'wave drain at ' + i);
  }
  await waitFor(() => runs === 130 && d._completedInvokes.size === 128, 'all 130 run, cache capped at 128');
  assert.equal(d._completedInvokes.has('inv1'), false, 'inv1 payload was evicted');
  d._dispatchInvoke({id: 'inv1', command: 'code.read', params: {}});
  await wait(60);
  assert.equal(runs, 130, 'the evicted invoke did not run again');
  assert.deepEqual(sent.filter(([id]) => id === 'inv1').pop()[1], {ok: false, error: 'already_completed'});
});

test('#132 native-device: a watchdog-answered invoke keeps its concurrency slot until it settles', async () => {
  const d = device(async () => { await wait(300); return {ok: true, payload: {late: 1}}; });
  d._watchdogGraceMs = 20;
  d._sendResult = async () => true;
  d._dispatchInvoke({id: 'zombie', command: 'code.read', params: {}, timeout_ms: 10});
  await wait(90); // watchdog (10 + 20 ms) has answered
  assert.deepEqual(d._completedInvokes.get('zombie'), {ok: false, error: 'invoke_timeout'});
  assert.equal(d._inflightInvokes.has('zombie'), true, 'the still-running command still counts against the cap');
  await waitFor(() => !d._inflightInvokes.has('zombie'), 'slot release at real settlement');
  assert.deepEqual(d._completedInvokes.get('zombie'), {ok: true, payload: {late: 1}}, 'the late real result still replaces the cached timeout');
});

test('#133/#134 native-device: timeout parsing, and timed-out requests are reset server-side', async () => {
  const d = device();
  const resets = [];
  d._transport = {request: () => ({id: 99n, frames: []}), reset: id => { resets.push(id); return []; }};
  d._ws = fakeSocket(1);
  d._sendFrames = async () => {};
  const pNull = d._request(Buffer.from('{}'), null); pNull.catch(() => {});
  await wait(60);
  assert.equal(d._pending.has('99'), true, 'null timeout did not become a 1 ms timeout');
  assert.equal(d._pending.get('99').timer._idleTimeout, 60000, 'null means the 60 s default');
  d._settlePending('99', new Error('done'));
  const pBig = d._request(Buffer.from('{}'), 999999999); pBig.catch(() => {});
  assert.equal(d._pending.get('99').timer._idleTimeout, 600000, 'a long request is capped at 10 min, not rounded to 60 s');
  d._settlePending('99', new Error('done'));
  const pTimeout = d._request(Buffer.from('{}'), 30);
  await assert.rejects(pTimeout, e => e.code === 'request_timeout');
  assert.deepEqual(resets, [99n], 'the timed-out stream was reset on the gateway');
  const pLarge = d._request(Buffer.from('{}'), 60000); pLarge.catch(() => {});
  d._handleFrame({id: 99n, type: 'response', status: 200, headers: [], body: Buffer.alloc(MAX_INBOUND_MESSAGE + 1)});
  await assert.rejects(pLarge, e => e.code === 'response_too_large');
  assert.equal(resets.length, 2, 'the oversized stream was reset too');
});

test('native-device send: a command carries message_kind chat_command, a normal message does not', async () => {
  const d = device();
  const bodies = [];
  d._connected = true;
  d._transport = {request: (verb, p, body) => { bodies.push(JSON.parse(body.toString('utf8'))); return {id: 42n, frames: []}; }, reset: () => []};
  d._ws = fakeSocket(1);
  d._sendFrames = async () => {};
  const cmd = d.send('/usage on', 'sess-1', {command: true}); cmd.catch(() => {});
  assert.equal(bodies[0].message, '/usage on');
  assert.equal(bodies[0].message_kind, 'chat_command');
  assert.equal(bodies[0].session_id, 'sess-1');
  d._settlePending('42', new Error('done'));
  await assert.rejects(cmd);
  const plain = d.send('hello', 'sess-1'); plain.catch(() => {});
  assert.equal(bodies[1].message, 'hello');
  assert.equal('message_kind' in bodies[1], false);
  d._settlePending('42', new Error('done'));
  await assert.rejects(plain);
});

test('#135 native-device: a corrupt control message is a protocol error, not a silent skip', () => {
  const dec = new ControlMessageDecoder();
  const framed = encodeControlMessage({type: 'res', id: 'r1', ok: true});
  assert.deepEqual(dec.feed(framed.subarray(0, 3)), [], 'a split frame waits');
  assert.deepEqual(dec.feed(framed.subarray(3)), [{type: 'res', id: 'r1', ok: true}]);
  const bad = Buffer.alloc(4);
  const payload = Buffer.from('{not json');
  bad.writeUInt32LE(payload.length, 0);
  assert.throws(() => new ControlMessageDecoder().feed(Buffer.concat([bad, payload])), /protocol_error/);
});

// --- core noise transport (#136, #137) ----------------------------------------
const {Transport, Cipher, cat, uint, bytes} = require('../src/core/noise');
const chunk = (id, index, count, payload) => cat(uint(1, id), uint(2, index), uint(3, count), bytes(4, payload));
const transport = () => new Transport(new Cipher(), new Cipher());
function envelope() {
  const frame = cat(uint(1, 9n), bytes(4, cat(bytes(1, Buffer.from('hi')), uint(2, 1))));
  return bytes(1, frame);
}

test('#137 noise: a duplicate chunk is ignored, a conflicting one drops only its own frame', () => {
  const env = envelope();
  const half = Math.floor(env.length / 2);
  const t = transport();
  assert.equal(t.decode(chunk(5n, 0, 2, env.subarray(0, half))), null);
  assert.equal(t.decode(chunk(5n, 0, 2, env.subarray(0, half))), null, 'gateway retransmit: no throw');
  assert.equal(t.chunks.size, 1, 'the reassembly survived the duplicate');
  const out = t.decode(chunk(5n, 1, 2, env.subarray(half)));
  assert.equal(out.type, 'body');
  assert.equal(out.body.toString(), 'hi');
  t.destroy();
  const t2 = transport();
  assert.equal(t2.decode(chunk(6n, 0, 2, env.subarray(0, half))), null);
  assert.equal(t2.decode(chunk(6n, 0, 2, Buffer.from('zz'))), null, 'conflicting duplicate: no throw');
  assert.equal(t2.chunks.size, 0, 'only that reassembly was dropped');
  const whole = t2.decode(chunk(7n, 0, 1, env));
  assert.equal(whole.body.toString(), 'hi', 'the connection still decodes afterwards');
  t2.destroy();
});

test('#136 noise: 17+ concurrent multi-chunk responses do not kill the transport', () => {
  const t = transport();
  for (let i = 1; i <= 65; i++) assert.equal(t.decode(chunk(BigInt(i), 0, 2, Buffer.from('a'))), null);
  assert.equal(t.chunks.size, 64, 'capped by evicting the oldest, not by throwing');
  assert.equal(t.chunks.has('1'), false);
  const env = envelope();
  const out = t.decode(chunk(100n, 0, 1, env));
  assert.equal(out.body.toString(), 'hi', 'frames still decode after the overflow');
  t.destroy();
});
