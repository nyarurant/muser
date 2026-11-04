'use strict';
// fix2 regression tests for src/link/channel-server.js — deep audit work2/c23
// Medium #1 (idle deadline rewound by skipped frames), #2 (ledger eviction
// drops in-flight entries), #3 (in-flight ledger entries never expire),
// #4 (sendApp checks backpressure once, then queues one oversized message
// whole). Harness mirrors tests/link.test.js: a real ws server plus a Node
// "phone" speaking Noise XX with the same framing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

// Same isolation as tests/link.test.js: never touch the real ~/.muser store
// on a bare `node --test` run (tests/setup.mjs covers the full suite).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-channel-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-channel-home-'));

const {createRemoteStore} = require('../src/link/remote-store');
const {handleChannelSocket} = require('../src/link/channel-server');
const noise = require('../src/link/noise');

class Queue {
  constructor() { this.items = []; this.waiters = []; }
  push(v) { const w = this.waiters.shift(); if (w) w(v); else this.items.push(v); }
  next(ms = 8000) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve, reject) => {
      const w = v => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('phone: timed out waiting')); }, ms);
      this.waiters.push(w);
    });
  }
}

class Phone {
  constructor(url, {keyPair, pattern = 'XX', psk} = {}) {
    this.url = url;
    this.keyPair = keyPair || noise.generateStaticKeyPair();
    this.pattern = pattern;
    this.psk = psk;
    this.rawQ = new Queue();
    this.appQ = new Queue();
    this.decoder = new noise.FrameDecoder();
    this.closeCode = null;
    this.closed = new Promise(r => { this.markClosed = r; });
  }
  async start() {
    this.conn = new noise.NoiseConnection({pattern: this.pattern, initiator: true, staticKeyPair: this.keyPair, psk: this.psk});
    this.ws = new WebSocket(this.url);
    this.ws.on('message', d => this.rawQ.push(Buffer.from(d)));
    this.ws.on('close', code => { this.closeCode = code; this.rawQ.push(null); this.appQ.push(null); this.markClosed(); });
    this.ws.on('error', () => {});
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    const msg1 = this.conn.writeMessage(Buffer.alloc(0));
    this.msg1 = msg1; // kept so tests can replay the duplicate-handshake trickle
    this.ws.send(msg1);
    while (!this.conn.handshakeFinished) {
      const m = await this.rawQ.next();
      if (!m) throw new Error('phone: channel closed during the handshake');
      this.conn.readMessage(m);
      if (!this.conn.handshakeFinished) this.ws.send(this.conn.writeMessage(Buffer.alloc(0)));
    }
    (async () => {
      for (;;) {
        const m = await this.rawQ.next().catch(() => null);
        if (!m) return;
        try { const whole = this.decoder.push(this.conn.readTransport(m)); if (whole) this.appQ.push(JSON.parse(whole.toString('utf8'))); }
        catch { return; }
      }
    })();
    return this;
  }
  send(obj) { for (const frame of noise.encodeFrames(Buffer.from(JSON.stringify(obj), 'utf8'))) this.ws.send(this.conn.writeTransport(frame)); }
  async recv() { const v = await this.appQ.next(); if (v === null) throw new Error('phone: channel closed'); return v; }
  close() { try { this.ws.close(); } catch {} }
}

function channelServer(t, ctx) {
  const wss = new WebSocket.WebSocketServer({host: '127.0.0.1', port: 0});
  const results = [];
  wss.on('connection', ws => results.push(handleChannelSocket(ws, typeof ctx === 'function' ? ctx() : ctx)));
  return new Promise(resolve => wss.on('listening', () => {
    t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
    resolve({wss, results, url: 'ws://127.0.0.1:' + wss.address().port});
  }));
}

const stubProxy = {
  request: async ({method, path: p, body}) => ({status: 200, body: {method, path: p, body: body ?? null}}),
  openSubscription: (p, onEvent) => { onEvent('state', '{"kind":"state","path":"' + p + '"}'); return () => {}; },
};
function pcKeys() { return {keys: {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}, pcId: 'pc-test-id'}; }
function tmpStore() { return createRemoteStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-channel-')), 'remote.json')); }
const waitMs = ms => new Promise(r => setTimeout(r, ms));
async function waitForCalls(cond, what) { for (let i = 0; i < 150 && !cond(); i++) await waitMs(20); assert.ok(cond(), what); }
async function pairedPhoneSetup(t, proxy, extraCtx = {}) {
  const store = tmpStore();
  const keys = pcKeys();
  const keyPair = noise.generateStaticKeyPair();
  store.add({name: 'Fix2 Phone', staticPub: keyPair.publicKey});
  const h = await channelServer(t, {keys, remoteStore: store, proxy, pairing: null, ...extraCtx});
  return {...h, keyPair};
}

test('fix2 channel #1: duplicate handshake frames do not rewind the idle deadline (c23 #1)', {timeout: 30000}, async t => {
  const {url, results, keyPair} = await pairedPhoneSetup(t, stubProxy, {channelIdleTimeoutMs: 300});
  const phone = await new Phone(url, {keyPair}).start();
  let closed = false;
  phone.closed.then(() => { closed = true; });
  // A trickle of retransmitted handshake message-1 copies: nextApp skips
  // every one as a non-application frame, so no application message ever
  // completes — the channel must still die at the 300 ms idle deadline
  // instead of being kept alive indefinitely.
  const trickle = setInterval(() => { try { phone.ws.send(phone.msg1); } catch {} }, 50);
  await Promise.race([phone.closed, waitMs(2500)]);
  clearInterval(trickle);
  assert.equal(closed, true, 'the channel was dropped despite the duplicate-frame trickle');
  const res = await results[0];
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'idle-timeout');
  phone.close();
});

test('fix2 channel #2: ledger eviction never drops an in-flight entry, so a resend cannot execute twice (c23 #2)', {timeout: 30000}, async t => {
  const counts = new Map();
  const releases = new Map();
  let total = 0;
  const proxy = {
    request: ({body}) => {
      const n = body.n;
      total++;
      counts.set(n, (counts.get(n) || 0) + 1);
      return new Promise(res => releases.set(n, () => res({status: 200, body: {n}})));
    },
    openSubscription: stubProxy.openSubscription,
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  // Fill the ledger past its 256-entry cap with distinct in-flight
  // requests, paced so the channel's own 256-frame receive queue (audit
  // #91) never overflows while the server dispatches them.
  for (let base = 1; base <= 257; base += 16) {
    const upto = Math.min(base + 15, 257);
    for (let n = base; n <= upto; n++) phone.send({t: 'req', id: n, method: 'POST', path: '/api/send', body: {n}});
    await waitForCalls(() => total >= upto, 'requests up to ' + upto + ' reached the proxy');
  }
  // A resend of the OLDEST request joins its in-flight entry; if eviction
  // dropped that entry to make room, this would execute a second time.
  const again = await new Phone(url, {keyPair}).start();
  again.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {n: 1}});
  await waitMs(300);
  assert.equal(counts.get(1), 1, 'the oldest in-flight request was not evicted and re-executed');
  for (const release of releases.values()) release();
  assert.deepEqual(await again.recv(), {t: 'res', id: 1, status: 200, body: {n: 1}});
  again.close();
  phone.close();
  await phone.closed;
});

test('fix2 channel #3: a stuck in-flight ledger entry expires and a resend executes fresh (c23 #3)', {timeout: 30000}, async t => {
  let calls = 0;
  const signals = [];
  const proxy = {
    request: ({signal}) => {
      calls++;
      signals.push(signal);
      if (calls === 1) return new Promise(() => {}); // ignores the abort signal and never settles
      return Promise.resolve({status: 200, body: {calls}});
    },
    openSubscription: stubProxy.openSubscription,
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy, {reqInFlightTimeoutMs: 300});
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'stuck'}});
  await waitForCalls(() => calls === 1, 'the stuck request reached the proxy');
  await waitMs(500); // past the in-flight TTL: the entry is a corpse, not a lock
  const again = await new Phone(url, {keyPair}).start();
  again.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'stuck'}});
  assert.deepEqual(await again.recv(), {t: 'res', id: 1, status: 200, body: {calls: 2}});
  assert.equal(calls, 2, 'the resend executed fresh instead of joining the stuck entry forever');
  assert.equal(signals[0]?.aborted, true, 'the stuck entry was aborted when it expired');
  again.close();
  phone.close();
  await phone.closed;
});

test('fix2 channel #4: one oversized message is refused whole by sendApp, not queued past the limit (c23 #4)', {timeout: 30000}, async t => {
  const proxy = {
    request: async () => ({status: 200, body: {blob: 'x'.repeat(400)}}),
    openSubscription: (p, onEvent) => { onEvent('state', JSON.stringify({blob: 'y'.repeat(400)})); return () => {}; },
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy, {sendBufferLimitBytes: 64});
  const phone = await new Phone(url, {keyPair}).start();
  // The subscription event alone (~430 bytes of JSON) exceeds the 64-byte
  // send limit: it must be dropped whole and the channel must stay alive.
  phone.send({t: 'sub', id: 8, path: '/api/events'});
  await waitMs(250);
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'}, 'the oversized event was dropped, not delivered');
  // An oversized reply is likewise never queued: the channel ends with 1009
  // so the phone reconnects and resyncs, instead of the whole reply piling
  // into the socket buffer past the limit.
  phone.send({t: 'req', id: 1, method: 'GET', path: '/api/state'});
  await phone.closed;
  assert.equal(phone.closeCode, 1009);
  assert.deepEqual(phone.appQ.items.filter(v => v !== null), [], 'the oversized reply was not queued either');
});
