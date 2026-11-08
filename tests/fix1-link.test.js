'use strict';
// Fix phase 1 regression tests (agent D): link channel revocation (#5),
// channel allowlist (#6), pairing replacement race (#7), relay default
// account (deep H8), proxy AbortSignal (deep H9), remote relay attempt
// accounting (third H1), remote relay per-IP spliced cap (third H2), and
// pairing-code expiry (deep H18). H17 lives in tests/link.test.js itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const WebSocket = require('ws');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-home-'));

const noise = require('../src/link/noise');
const {pcIdFor} = require('../src/link/keys');
const {createRemoteStore} = require('../src/link/remote-store');
const {createProxy} = require('../src/link/proxy');
const {handleChannelSocket, pairingActive, isAllowedChannelRequest, isAllowedChannelSubscription} = require('../src/link/channel-server');
const {Link} = require('../src/link/link');
const {Relay} = require('../src/relay');
const {createRelay} = require('../remote/relay/index.js');

const waitMs = ms => new Promise(r => setTimeout(r, ms));

// --- channel harness (same shape as tests/link.test.js) ----------------------
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
    this.closed = new Promise(r => { this.markClosed = r; });
  }
  async start() {
    this.conn = new noise.NoiseConnection({pattern: this.pattern, initiator: true, staticKeyPair: this.keyPair, psk: this.psk});
    this.ws = new WebSocket(this.url);
    this.ws.on('message', d => this.rawQ.push(Buffer.from(d)));
    this.ws.on('close', () => { this.rawQ.push(null); this.appQ.push(null); this.markClosed(); });
    this.ws.on('error', () => {});
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.send(this.conn.writeMessage(Buffer.alloc(0)));
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
        try { const whole = this.decoder.push(this.conn.readTransport(m)); if (whole) this.appQ.push(JSON.parse(whole.toString('utf8'))); } catch { return; }
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
function tmpStore() { return createRemoteStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-store-')), 'remote.json')); }
async function pairedSetup(t, proxy) {
  const store = tmpStore();
  const keys = pcKeys();
  const keyPair = noise.generateStaticKeyPair();
  const device = store.add({name: 'Fix Phone', staticPub: keyPair.publicKey});
  const h = await channelServer(t, {keys, remoteStore: store, proxy, pairing: null});
  return {...h, store, keyPair, device};
}

// --- #5: revoke closes live channels ------------------------------------------
test('fix1 #5: revoking a device closes its live channel on the next message', {timeout: 30000}, async t => {
  const {url, store, keyPair, device, results} = await pairedSetup(t, stubProxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'GET', path: '/api/state'});
  assert.equal((await phone.recv()).status, 200);
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'});
  // Revoke while the channel is live and healthy.
  assert.equal(store.remove(device.id)?.id, device.id);
  assert.equal(store.findByStatic(keyPair.publicKey), null);
  // The very next message — even a ping that used to just get a pong — ends it.
  // app-debug #1: the phone is TOLD ({t:'revoked'}) before the close, because a
  // bare 4403 does not survive the relay (it becomes 1000) and the app cannot
  // otherwise tell revocation from a dropped connection.
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'revoked'});
  await phone.closed;
  const outcome = await results[0];
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'revoked');
});

test('app-debug #1: an unpaired phone is told {t:revoked} before the 4403 close', {timeout: 30000}, async t => {
  const store = tmpStore();
  const keys = pcKeys();
  const {results, url} = await channelServer(t, {keys, remoteStore: store, proxy: stubProxy, pairing: null});
  const phone = await new Phone(url, {}).start(); // unknown static key, never paired
  assert.deepEqual(await phone.recv(), {t: 'revoked'});
  await phone.closed;
  const outcome = await results[0];
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'unpaired');
});

// --- #6: channel allowlist ------------------------------------------------------
test('fix1 #6: unit allowlist — /api/server/* always denied, ordinary serve API allowed', () => {
  for (const [m, p] of [['POST', '/api/server/link/pair'], ['POST', '/api/server/stop'], ['POST', '/api/server/link/revoke'], ['POST', '/api/server'], ['GET', '/api/server/events'], ['GET', '/api/server/link'], ['POST', '/api/server/link/pair?x=1']]) {
    assert.equal(isAllowedChannelRequest(m, p), false, m + ' ' + p);
  }
  // android-ui: GET /api/server (the exact path only) is the read-only
  // standing view the GUI uses for accounts/version; setup stays denied —
  // its answers carry credentials (gui-server says so itself).
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/entries'], ['GET', '/api/outputs'], ['GET', '/api/complete'], ['GET', '/api/changes'], ['POST', '/api/send'], ['POST', '/api/approval'], ['POST', '/api/menu'], ['POST', '/api/limit'], ['POST', '/api/mode'], ['POST', '/api/interrupt'], ['POST', '/api/shell-kill'], ['GET', '/api/s/abc/state'], ['POST', '/api/s/abc/send'], ['POST', '/api/s/abc/menu'], ['GET', '/api/sessions'], ['POST', '/api/sessions'], ['POST', '/api/sessions/xyz/open'], ['POST', '/api/sessions/xyz/close'], ['GET', '/api/state?full=1'], ['GET', '/api/server'], ['GET', '/api/server?x=1'], ['GET', '/api/image?path=shot.png'], ['GET', '/api/s/abc/image?path=shot.png'], ['GET', '/api/accounts'], ['POST', '/api/accounts/default'], ['POST', '/api/accounts/auto'], ['POST', '/api/accounts/rename'], ['POST', '/api/accounts/remove'], ['POST', '/api/account'], ['POST', '/api/s/abc/account'], ['POST', '/api/prompt'], ['POST', '/api/s/abc/prompt'], ['GET', '/api/settings'], ['POST', '/api/s/abc/settings']]) {
    assert.equal(isAllowedChannelRequest(m, p), true, m + ' ' + p);
  }
  for (const [m, p] of [['DELETE', '/api/state'], ['GET', '/api/send'], ['POST', '/api/state'], ['GET', '/api/unknown'], ['GET', '/api/%2e%2e/server/stop'], ['GET', '//api/state'], ['GET', 'http://127.0.0.1/api/state'], ['POST', '/api/sessions/xyz/delete'], ['GET', '/api/setup'], ['POST', '/api/setup/answer'], ['POST', '/api/setup/start'], ['POST', '/api/setup/cancel'], ['DELETE', '/api/server'], ['PUT', '/api/server'], ['POST', '/api/accounts'], ['GET', '/api/accounts/remove'], ['POST', '/api/accounts/delete'], ['GET', '/api/account']]) {
    assert.equal(isAllowedChannelRequest(m, p), false, m + ' ' + p);
  }
  assert.equal(isAllowedChannelSubscription('/api/events'), true);
  assert.equal(isAllowedChannelSubscription('/api/s/abc/events'), true);
  assert.equal(isAllowedChannelSubscription('/api/server/events'), false);
  assert.equal(isAllowedChannelSubscription('/api/state'), false);
});

test('fix1 #6: a paired phone cannot tunnel server-admin paths, ordinary API still works', {timeout: 30000}, async t => {
  const calls = [], subCalls = [];
  const proxy = {
    request: async ({method, path: p, body}) => { calls.push(method + ' ' + p); return {status: 200, body: {method, path: p, body: body ?? null}}; },
    openSubscription: (p, onEvent) => { subCalls.push(p); onEvent('state', '{"kind":"state"}'); return () => {}; },
  };
  const {url, keyPair} = await pairedSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  let id = 0;
  const req = async (method, p, body) => { phone.send({t: 'req', id: ++id, method, path: p, body}); return phone.recv(); };
  for (const [m, p] of [['POST', '/api/server/link/pair'], ['POST', '/api/server/stop'], ['POST', '/api/server/link/revoke'], ['POST', '/api/server'], ['GET', '/api/server/events']]) {
    const res = await req(m, p, {mode: 'qr'});
    assert.equal(res.status, 403, m + ' ' + p);
    assert.equal(res.body.code, 'channel-forbidden');
  }
  assert.deepEqual(calls, [], 'no admin request ever reached the proxy');
  phone.send({t: 'sub', id: 90, path: '/api/server/events'});
  const subFail = await phone.recv();
  assert.equal(subFail.t, 'sub-failed');
  assert.equal(subFail.code, 'channel-forbidden');
  assert.deepEqual(subCalls, []);
  // Ordinary phone API still flows, bare and per-session.
  assert.equal((await req('POST', '/api/send', {text: 'hi'})).status, 200);
  assert.equal((await req('GET', '/api/s/abc123/state')).status, 200);
  assert.equal((await req('GET', '/api/sessions')).status, 200);
  // android-ui: the read-only standing view (accounts/version) flows too.
  assert.equal((await req('GET', '/api/server')).status, 200);
  phone.send({t: 'sub', id: 91, path: '/api/events'});
  assert.equal((await phone.recv()).t, 'ev');
  assert.deepEqual(calls, ['POST /api/send', 'GET /api/s/abc123/state', 'GET /api/sessions', 'GET /api/server']);
  assert.deepEqual(subCalls, ['/api/events']);
  phone.close();
  await phone.closed;
});

// --- #7: pairing replacement race ------------------------------------------------
test('fix1 #7: a superseded pairing cannot claim, and its success cannot clear the current pairing', {timeout: 30000}, async t => {
  const store = tmpStore();
  const keysRaw = {keys: {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}};
  keysRaw.pcId = pcIdFor(keysRaw.keys.relay.publicKey);
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: null, keys: keysRaw, store, proxy: stubProxy});
  const a = link.startPairing({mode: 'qr'});
  const pairingA = link.pairing;
  const ctxA = link.channelCtx(); // a channel starting now captures pairing A
  assert.equal(ctxA.pairing, pairingA);
  const {url} = await channelServer(t, () => ctxA);
  const attacker = await new Phone(url, {}).start(); // handshake done under A
  // The user replaces the pairing before the captured channel claims.
  const b = link.startPairing({mode: 'qr'});
  const pairingB = link.pairing;
  assert.equal(pairingA.burned, true, 'startPairing invalidates the superseded object');
  attacker.send({t: 'pair', code: a.code, name: 'Stale Phone'});
  const failed = await attacker.recv();
  assert.equal(failed.t, 'pair-failed');
  await attacker.closed;
  assert.deepEqual(store.list(), [], 'the stale pairing registered nothing');
  assert.equal(link.pairing, pairingB, 'the current pairing survived the stale claim');
  // onPairSuccess identity, directly: a stale ctx cannot clear B either.
  ctxA.onPairSuccess(pairingA);
  assert.equal(link.pairing, pairingB);
  // The current pairing still pairs normally and is cleared by ITS success.
  const live = await channelServer(t, () => link.channelCtx());
  const phone = await new Phone(live.url, {}).start();
  phone.send({t: 'pair', code: b.code, name: 'Real Phone'});
  assert.equal((await phone.recv()).t, 'paired');
  assert.equal(store.list().length, 1);
  assert.equal(link.pairing, null);
  phone.close();
  // stopPairing burns the object it drops, too.
  link.startPairing({mode: 'qr'});
  const pairingC = link.pairing;
  link.stopPairing();
  assert.equal(pairingC.burned, true);
  assert.equal(link.pairing, null);
});

// --- H18: pairing expiry ----------------------------------------------------------
test('fix1 H18: an expired pairing is inactive and cannot be claimed or registered', {timeout: 30000}, async t => {
  assert.equal(pairingActive({mode: 'qr', code: 'X', expiresAt: Date.now() - 1}), false);
  assert.equal(pairingActive({mode: 'qr', code: 'X', expiresAt: Date.now() + 60000}), true);
  assert.equal(pairingActive({mode: 'qr', code: 'X', expiresAt: Date.now() + 60000, consumed: true}), false);
  assert.equal(pairingActive({mode: 'qr', code: 'X', expiresAt: Date.now() + 60000, burned: true}), false);
  assert.equal(pairingActive(null), false);
  // Already expired when the channel starts: treated as no pairing at all.
  const store = tmpStore();
  const keys = pcKeys();
  const expired = {mode: 'qr', code: 'OLDCODE1', expiresAt: Date.now() - 1000, attempts: 0};
  const h1 = await channelServer(t, {keys, remoteStore: store, proxy: stubProxy, pairing: expired});
  const stranger = await new Phone(h1.url, {}).start();
  await stranger.closed;
  assert.deepEqual(store.list(), []);
  assert.equal((await h1.results[0]).reason, 'unpaired');
  // Expires between handshake and claim: the claim-time recheck refuses it.
  const dying = {mode: 'qr', code: 'DYING123', expiresAt: Date.now() + 400, attempts: 0};
  const h2 = await channelServer(t, {keys, remoteStore: store, proxy: stubProxy, pairing: dying});
  const phone = await new Phone(h2.url, {}).start();
  await waitMs(600);
  phone.send({t: 'pair', code: 'DYING123', name: 'Too Late'});
  const failed = await phone.recv();
  assert.equal(failed.t, 'pair-failed');
  await phone.closed;
  assert.deepEqual(store.list(), []);
  // Link level: activePairing()/state() hide an expired pairing.
  const keysRaw = {keys: {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}};
  keysRaw.pcId = pcIdFor(keysRaw.keys.relay.publicKey);
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: null, keys: keysRaw, store, proxy: stubProxy});
  link.startPairing({mode: 'qr'});
  link.pairing.expiresAt = Date.now() - 1;
  assert.equal(link.activePairing(), null);
  assert.equal(link.state().pairing, null);
});

// --- H9: proxy AbortSignal -----------------------------------------------------------
test('fix1 H9: proxy request() honours the AbortSignal and cancels the serve request', {timeout: 30000}, async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; const timer = setTimeout(() => { try { res.end('{"late":true}'); } catch {} }, 10000); timer.unref?.(); req.on('close', () => clearTimeout(timer)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const proxy = createProxy({port: server.address().port, token: 'sekrit', requestTimeoutMs: 8000});
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(proxy.request({method: 'GET', path: '/api/state', signal: pre.signal}), e => e.name === 'AbortError');
    assert.equal(hits, 0, 'a pre-aborted request never reaches serve');
    const ctl = new AbortController();
    const started = Date.now();
    const pending = proxy.request({method: 'POST', path: '/api/send', body: {text: 'hi'}, signal: ctl.signal});
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(pending, e => e.name === 'AbortError' || e.code === 'ABORT_ERR');
    assert.ok(Date.now() - started < 3000, 'abort settled promptly, not at the 8s deadline');
    assert.equal(hits, 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

// --- H8: relay default account ----------------------------------------------------------
function rawRelayRequest(pipe, msg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('raw relay timeout')); }, 5000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(timer); sock.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
    sock.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
test('fix1 H8: the default account is filtered as \'default\', legacy no-account messages still pass', {timeout: 30000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-relay-'));
  const mk = (account, by) => new Relay({takes: () => true, run: async () => ({ok: true, by}), account, dir}).start();
  const defA = mk(() => null, 'A');
  const accB = mk(() => 'acc2', 'B');
  const defC = mk(() => null, 'C');
  try {
    // acc2 window forwarding: both default windows must refuse (their
    // effective account is 'default', not null = unfiltered).
    assert.deepEqual(await accB.forward('cmd', {}, 1000, 'x1'), {takers: 0});
    // Default window forwarding: acc2 refuses, the other default accepts.
    const fwd = await defA.forward('cmd', {}, 1000, 'x2');
    assert.deepEqual(fwd, {result: {ok: true, by: 'C'}});
    // Wire level on the default window's pipe.
    assert.deepEqual(await rawRelayRequest(defA.pipe, {type: 'takes', params: {}}), {takes: true}, 'no account field at all = legacy, unfiltered');
    assert.deepEqual(await rawRelayRequest(defA.pipe, {type: 'takes', params: {}, account: 'default'}), {takes: true});
    assert.deepEqual(await rawRelayRequest(defA.pipe, {type: 'takes', params: {}, account: 'acc2'}), {takes: false});
    const blocked = await rawRelayRequest(defA.pipe, {type: 'invoke', command: 'c', params: {}, timeoutMs: 1000, id: 'i', account: 'acc2'});
    assert.equal(blocked.result.ok, false);
  } finally {
    defA.stop(); accB.stop(); defC.stop();
  }
});

// --- remote relay helpers ------------------------------------------------------------------
function relayIdentity() {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({format: 'jwk'}).x, 'base64url');
  const pcId = crypto.createHash('sha256').update(pub).digest('base64url').slice(0, 22);
  return {privateKey, pub, pcId};
}
const CTL_CTX = Buffer.from('muser-relay:v1:control-auth:', 'utf8');
const DATA_CTX = Buffer.from('muser-relay:v1:data-cid:', 'utf8');
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._queue = []; ws._waiters = [];
    ws.on('message', d => { const w = ws._waiters.shift(); if (w) w(d); else ws._queue.push(d); });
    ws.take = () => ws._queue.length ? Promise.resolve(ws._queue.shift()) : new Promise(r => ws._waiters.push(r));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function waitClose(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(ws.closeCode);
  return new Promise(r => ws.once('close', code => r(code)));
}
async function relayPc(base, identity) {
  const ws = await wsConnect(base + '/pc');
  const {challenge} = JSON.parse((await ws.take()).toString('utf8'));
  const sig = crypto.sign(null, Buffer.concat([CTL_CTX, Buffer.from(challenge, 'base64url')]), identity.privateKey).toString('base64url');
  ws.send(JSON.stringify({pcId: identity.pcId, pub: identity.pub.toString('base64url'), sig}));
  await waitMs(60);
  return ws;
}
async function splicePhone(base, identity, control) {
  const phone = await wsConnect(base + '/c?pc=' + identity.pcId);
  const {open: cid} = JSON.parse((await control.take()).toString('utf8'));
  const data = await wsConnect(base + '/a?pc=' + identity.pcId + '&cid=' + cid);
  const sig = crypto.sign(null, Buffer.concat([DATA_CTX, Buffer.from(cid, 'utf8')]), identity.privateKey).toString('base64url');
  data.send(JSON.stringify({sig}));
  await waitMs(80);
  return {phone, data};
}
function upgradeAttempt(host, port, p) {
  return new Promise(resolve => {
    const sock = net.connect(port, host);
    let buf = '';
    const done = () => { try { sock.destroy(); } catch {} resolve(buf.split('\r\n')[0] || ''); };
    sock.on('connect', () => sock.write('GET ' + p + ' HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) done(); });
    sock.on('close', done);
    sock.on('error', done);
    setTimeout(done, 3000).unref?.();
  });
}

// --- third H1: rejected attempts do not consume the global budget ---------------------------
test('fix1 third H1: per-IP rejections do not consume the global attempt budget', {timeout: 30000}, async t => {
  // Two distinct source IPs: 127.0.0.1 and ::1 (on Windows every 127/8
  // destination still sources from 127.0.0.1, so a second loopback alias
  // would not be a second source; the relay listens dual-stack instead).
  const relay = createRelay({maxAttemptsPerIpPerMinute: 2, maxAttemptsGlobalPerMinute: 3, maxSocketsPerIp: 500, maxSocketsTotal: 5000});
  await new Promise((res, rej) => { relay.once('error', rej); relay.listen(0, res); });
  t.after(() => new Promise(r => relay.close(() => r())));
  const port = relay.address().port;
  const attempt = host => upgradeAttempt(host, port, '/c?pc=offline-pc');
  // Source 1: two admitted, then per-IP rejections.
  assert.match(await attempt('127.0.0.1'), /101/);
  assert.match(await attempt('127.0.0.1'), /101/);
  assert.match(await attempt('127.0.0.1'), /429/);
  assert.match(await attempt('127.0.0.1'), /429/);
  // Source 2's first attempt must still be admitted: the per-IP rejections
  // above burned nothing globally (global used is 2 of 3, not 4). Its second
  // attempt then hits the GLOBAL cap itself (per-IP would still allow it).
  assert.match(await attempt('::1'), /101/);
  assert.match(await attempt('::1'), /429/);
});

// --- third H2: per-IP cap covers spliced phones ------------------------------------------------
test('fix1 third H2: spliced phones count against the per-IP phone cap', {timeout: 30000}, async t => {
  const relay = createRelay({maxPendingPhonesPerIp: 2, maxPhonesPerPc: 8});
  await new Promise((res, rej) => { relay.once('error', rej); relay.listen(0, '127.0.0.1', res); });
  t.after(() => new Promise(r => relay.close(() => r())));
  const base = 'ws://127.0.0.1:' + relay.address().port;
  const identity = relayIdentity();
  const control = await relayPc(base, identity);
  t.after(() => { try { control.close(); } catch {} });
  const s1 = await splicePhone(base, identity, control);
  const s2 = await splicePhone(base, identity, control);
  t.after(() => { for (const s of [s1, s2]) { try { s.phone.close(); } catch {} try { s.data.close(); } catch {} } });
  assert.equal(relay.stats().activeSplices, 2);
  // Both slots from this source are SPLICED (none pending): a third phone
  // from the same source is still refused, not admitted past the cap.
  const third = await wsConnect(base + '/c?pc=' + identity.pcId);
  t.after(() => { try { third.close(); } catch {} });
  assert.equal(await waitClose(third), 4429);
  assert.equal(relay.stats().activeSplices, 2);
});
