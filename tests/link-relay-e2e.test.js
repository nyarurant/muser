// Full-stack muser link test: a Node "phone" pairs with the PC's Link through
// the REAL relay (remote/relay) and then speaks the tunneled serve API —
// pairing, request/response, SSE subscription — plus the rejection paths.
// The serve behind the Link is a stub; the relay, Noise channel, channel
// server and proxy are the production code.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const {createRelay} = require('../remote/relay/index.js');
const {NoiseConnection, generateStaticKeyPair, encodeFrames, FrameDecoder} = require('../src/link/noise');
const {loadOrCreateLinkKeys, signRelay, pcIdFor} = require('../src/link/keys');
const {createRemoteStore} = require('../src/link/remote-store');
const {Link} = require('../src/link/link');

const TOKEN = 'e2e-token';
let relay, relayPort, stub, stubPort, link, pcId;
const stubSends = [];
const sseClients = new Set();

function sseSend(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

before(async () => {
  stub = http.createServer((req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      sseClients.add(res);
      sseSend(res, 'state', {version: 'stub'});
      req.on('close', () => sseClients.delete(res));
      return;
    }
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (req.url === '/api/send' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        stubSends.push(body);
        res.writeHead(202, {'content-type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
        for (const c of sseClients) sseSend(c, 'entry', {kind: 'entry', text: 'echo: ' + (body.text || '')});
        return;
      }
      if (req.url === '/api/state') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({version: 'stub', busy: false}));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;

  relay = createRelay({unclaimedTimeoutMs: 8000});
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  relayPort = relay.address().port;

  const keysResult = loadOrCreateLinkKeys();
  pcId = keysResult.pcId;
  const storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-e2e-')), 'remote.json');
  link = new Link({
    serve: {port: stubPort, token: TOKEN},
    relayUrl: 'ws://127.0.0.1:' + relayPort,
    lanPort: null,
    keys: keysResult,
    store: createRemoteStore(storeFile),
  });
  await link.start();
  // The control socket needs a moment to register with the relay.
  await new Promise(r => setTimeout(r, 300));
});

after(async () => {
  await link?.stop().catch(() => {});
  await new Promise(r => relay.close(() => r()));
  stub.close();
});

// A minimal phone: Noise initiator over a WebSocket carrier, with a queue of
// decoded application messages.
class Phone {
  constructor(url, keyPair) {
    this.url = url;
    this.noise = new NoiseConnection({pattern: 'XX', initiator: true, staticKeyPair: keyPair});
    this.decoder = new FrameDecoder();
    this.messages = [];
    this.waiters = [];
    this.closed = false;
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.inbox = [];
    this.inWaiters = [];
    this.ws.on('message', d => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (!this.noise.handshakeFinished) {
        const w = this.inWaiters.shift();
        if (w) w(buf); else this.inbox.push(buf);
      } else {
        // A retransmitted handshake frame (a resent message 2) is not a
        // transport message; dropping what does not decrypt is the guard.
        let payload = null;
        try { payload = this.decoder.push(this.noise.readTransport(buf)); } catch { return; }
        if (payload) this.deliver(JSON.parse(payload.toString('utf8')));
      }
    });
    this.ws.on('close', () => { this.closed = true; this.deliver(null); });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
  }
  nextHandshakeMessage() {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise(r => this.inWaiters.push(r));
  }
  async handshake(spam = 1) {
    // The relay needs a moment to splice the data socket after {open}; in the
    // real app the phone resends message 1 until message 2 arrives. Locally a
    // short settle is enough. spam > 1 retransmits message 1 in a burst, like
    // a phone whose resends were queued by the carrier: the responder must
    // answer with message 2 again, not feed the duplicate to the Noise state
    // as message 3 (that bug killed every real relay handshake).
    await new Promise(r => setTimeout(r, 400));
    const msg1 = this.noise.writeMessage(Buffer.alloc(0));
    for (let i = 0; i < spam; i++) this.ws.send(msg1);
    const msg2 = await this.nextHandshakeMessage();
    this.noise.readMessage(msg2);
    this.ws.send(this.noise.writeMessage(Buffer.alloc(0)));
    assert.equal(this.noise.handshakeFinished, true);
  }
  deliver(msg) {
    const w = this.waiters.shift();
    if (w) w(msg); else this.messages.push(msg);
  }
  async next(timeoutMs = 8000) {
    if (this.messages.length) return this.messages.shift();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('phone: timed out waiting for a message')), timeoutMs);
      this.waiters.push(m => { clearTimeout(t); res(m); });
    });
  }
  send(obj) {
    for (const frame of encodeFrames(Buffer.from(JSON.stringify(obj), 'utf8'))) {
      this.ws.send(this.noise.writeTransport(frame));
    }
  }
  close() { try { this.ws.close(); } catch {} }
}

test('phone pairs by QR code through the relay, then chats over the tunnel', {timeout: 30000}, async () => {
  const {code} = link.startPairing({mode: 'qr'});
  const phoneKeys = generateStaticKeyPair();
  const phone = new Phone('ws://127.0.0.1:' + relayPort + '/c?pc=' + pcId, phoneKeys);
  await phone.connect();
  await phone.handshake();
  // The PC's static key the phone ends up with is the link's Noise key.
  assert.deepEqual(phone.noise.remoteStatic, loadOrCreateLinkKeys().keys.noise.publicKey);

  phone.send({t: 'pair', code: 'WRONGCODE', name: 'Galaxy S26'});
  // A wrong code in QR mode: no 'paired' — the next thing is the close.
  const wrong = await Promise.race([phone.next(2500), new Promise(r => setTimeout(() => r('timeout'), 2600))]);
  assert.ok(wrong === null || wrong === 'timeout' || wrong.t !== 'paired', 'wrong code must not pair');
  phone.close();

  const phone2 = new Phone('ws://127.0.0.1:' + relayPort + '/c?pc=' + pcId, phoneKeys);
  await phone2.connect();
  await phone2.handshake();
  phone2.send({t: 'pair', code, name: 'Galaxy S26'});
  const paired = await phone2.next();
  assert.equal(paired.t, 'paired');
  assert.equal(paired.device.name, 'Galaxy S26');
  assert.equal(paired.pc.pcId, pcId);

  phone2.send({t: 'sub', id: 9, path: '/api/events'});
  const ev0 = await phone2.next();
  assert.equal(ev0.t, 'ev'); assert.equal(ev0.id, 9); assert.equal(ev0.event, 'state');

  phone2.send({t: 'req', id: 10, method: 'POST', path: '/api/send', body: {text: 'hello from phone'}});
  const seen = [];
  while (!seen.find(m => m.t === 'res' && m.id === 10)) { const m = await phone2.next(); if (m) seen.push(m); }
  const res = seen.find(m => m.t === 'res' && m.id === 10);
  assert.equal(res.status, 202);
  assert.deepEqual(stubSends.at(-1), {text: 'hello from phone'});
  const ev = seen.find(m => m.t === 'ev' && m.id === 9 && m.event === 'entry') || await phone2.next();
  assert.equal(ev.event, 'entry');
  assert.equal(ev.data.text, 'echo: hello from phone');
  phone2.close();

  // Reconnect without pairing: the stored static key is the credential.
  const phone3 = new Phone('ws://127.0.0.1:' + relayPort + '/c?pc=' + pcId, phoneKeys);
  await phone3.connect();
  await phone3.handshake(3);
  phone3.send({t: 'req', id: 1, method: 'GET', path: '/api/state'});
  const st = await phone3.next();
  assert.equal(st.t, 'res'); assert.equal(st.status, 200); assert.equal(st.body.version, 'stub');
  phone3.close();

  // A stranger's key is refused once the handshake completes.
  const stranger = new Phone('ws://127.0.0.1:' + relayPort + '/c?pc=' + pcId, generateStaticKeyPair());
  await stranger.connect();
  await stranger.handshake().catch(() => {});
  stranger.send({t: 'req', id: 1, method: 'GET', path: '/api/state'});
  const got = await Promise.race([stranger.next(3000), new Promise(r => setTimeout(() => r('timeout'), 3200))]);
  assert.ok(got === null || got === 'timeout' || stranger.closed, 'unpaired static key must not be served');
  stranger.close();
});

// --- audit 2026-11-03 relay regressions (#92, #96, #97, #101, #103) ---------
// These drive remote/relay/index.js directly with hand-rolled PC/phone
// sockets (no Link), so each limit can be set tiny and observed exactly.

const CTL_CTX = 'muser-relay:v1:control-auth:';
const DATA_CTX = 'muser-relay:v1:data-cid:';

function relayKeyPair() {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({format: 'jwk'}), priv = privateKey.export({format: 'jwk'});
  return {publicKey: Buffer.from(pub.x, 'base64url'), privateKey: Buffer.from(priv.d, 'base64url')};
}
async function startRelay(t, opts) {
  const r = createRelay(opts);
  await new Promise(res => r.listen(0, '127.0.0.1', res));
  t.after(() => new Promise(res => r.close(() => res())));
  return {relay: r, port: r.address().port};
}
function textQueue(ws) {
  const q = [], waiters = [];
  ws.on('message', d => { const s = d.toString('utf8'); const w = waiters.shift(); if (w) w(s); else q.push(s); });
  return {next() { if (q.length) return Promise.resolve(q.shift()); return new Promise(r => waiters.push(r)); }};
}
// A socket with its close promise captured at construction. Attaching a
// 'message' / 'close' listener only after 'open' resolves loses frames the
// relay sends during the upgrade (the /pc challenge, an immediate 4429):
// the ws client emits them in the same turn as 'open', before the awaiting
// continuation runs, so every listener below is attached synchronously.
function wsSocket(url) {
  const ws = new WebSocket(url);
  ws._closePromise = new Promise(r => ws.once('close', code => r(code)));
  return ws;
}
function wsOpen(url) {
  const ws = wsSocket(url);
  return new Promise((res, rej) => {
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
}
function wsCloseCode(ws) { return ws._closePromise || new Promise(r => ws.once('close', code => r(code))); }
async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out'); await new Promise(r => setTimeout(r, 10)); }
}
// Connect a control socket and answer its challenge with signPayload(challengeBytes).
async function controlAuth(port, pair, signPayload) {
  const ws = wsSocket('ws://127.0.0.1:' + port + '/pc');
  const q = textQueue(ws); // attached before 'open': the challenge must not be missed
  const closed = wsCloseCode(ws);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const challenge = Buffer.from(JSON.parse(await q.next()).challenge, 'base64url');
  const sig = signRelay(pair, signPayload(challenge));
  ws.send(JSON.stringify({pcId: pcIdFor(pair.publicKey), pub: pair.publicKey.toString('base64url'), sig: sig.toString('base64url')}));
  return {ws, q, closed};
}
const goodControlAuth = (port, pair) => controlAuth(port, pair, ch => Buffer.concat([Buffer.from(CTL_CTX, 'utf8'), ch]));
// With a registered PC (control socket + queue), open a phone and claim it
// with a data socket signed via signPayload(cid); returns all three sockets.
async function spliceViaRelay(port, pair, pcId, controlQ, signPayload) {
  const phone = await wsOpen('ws://127.0.0.1:' + port + '/c?pc=' + pcId);
  const cid = JSON.parse(await controlQ.next()).open;
  assert.equal(typeof cid, 'string');
  const data = await wsOpen('ws://127.0.0.1:' + port + '/a?pc=' + pcId + '&cid=' + cid);
  const sig = signRelay(pair, signPayload(cid));
  data.send(JSON.stringify({sig: sig.toString('base64url')}));
  return {phone, data, cid};
}
const goodDataAuth = cid => Buffer.concat([Buffer.from(DATA_CTX, 'utf8'), Buffer.from(cid, 'utf8')]);

test('relay: signatures are domain-separated — one purpose cannot be replayed for the other (audit #103)', {timeout: 30000}, async t => {
  const {relay: r, port} = await startRelay(t, {});
  const pair = relayKeyPair();
  const pcId = pcIdFor(pair.publicKey);
  // Control auth: the bare challenge (the pre-fix payload) is rejected.
  { const c = await controlAuth(port, pair, ch => ch); assert.equal(await c.closed, 4403); }
  // Control auth: a signature scoped to the data-cid purpose is rejected.
  { const c = await controlAuth(port, pair, ch => Buffer.concat([Buffer.from(DATA_CTX, 'utf8'), ch])); assert.equal(await c.closed, 4403); }
  assert.equal(r.relayState.pcs.size, 0);
  // Control auth: the control-scoped signature is accepted.
  const ctl = await goodControlAuth(port, pair);
  await waitFor(() => r.relayState.pcs.size === 1);
  // Data auth: a signature scoped to the control purpose (over the cid) is rejected.
  { const s = await spliceViaRelay(port, pair, pcId, ctl.q, cid => Buffer.concat([Buffer.from(CTL_CTX, 'utf8'), Buffer.from(cid, 'utf8')]));
    assert.equal(await wsCloseCode(s.data), 4403); s.phone.close(); }
  // Data auth: the bare cid (the pre-fix payload) is rejected.
  { const s = await spliceViaRelay(port, pair, pcId, ctl.q, cid => Buffer.from(cid, 'utf8'));
    assert.equal(await wsCloseCode(s.data), 4403); s.phone.close(); }
  assert.equal(r.relayState.splices.size, 0);
  // Data auth: the data-scoped signature splices.
  { const s = await spliceViaRelay(port, pair, pcId, ctl.q, goodDataAuth);
    await waitFor(() => r.relayState.splices.size === 1);
    s.phone.close(); s.data.close(); }
  ctl.ws.close();
});

test('relay: connection attempts and failed auths are rate-limited per IP (audit #92)', {timeout: 30000}, async t => {
  const {relay: r, port} = await startRelay(t, {maxAttemptsPerIpPerMinute: 3});
  for (let i = 0; i < 3; i++) {
    const ws = await wsOpen('ws://127.0.0.1:' + port + '/c?pc=unknown-pc');
    assert.equal(await wsCloseCode(ws), 4404); // PC offline, but the attempt counted
  }
  // The 4th attempt inside the window never upgrades: HTTP 429.
  await assert.rejects(wsOpen('ws://127.0.0.1:' + port + '/c?pc=unknown-pc'), /429/);
  assert.ok(r.stats().rateLimitedTotal >= 1);
});

test('relay: one source cannot pin every phone slot with unclaimed sockets, and repeat bad auths are banned (audit #92)', {timeout: 30000}, async t => {
  const {relay: r, port} = await startRelay(t, {maxPendingPhonesPerIp: 1, maxAuthFailuresPerIpPerMinute: 2, unclaimedTimeoutMs: 5000});
  const pair = relayKeyPair();
  const pcId = pcIdFor(pair.publicKey);
  const ctl = await goodControlAuth(port, pair);
  await waitFor(() => r.relayState.pcs.size === 1);
  const phone1 = await wsOpen('ws://127.0.0.1:' + port + '/c?pc=' + pcId);
  JSON.parse(await ctl.q.next()); // {open} for phone1: it holds the one unclaimed slot
  const phone2 = await wsOpen('ws://127.0.0.1:' + port + '/c?pc=' + pcId);
  assert.equal(await wsCloseCode(phone2), 4429); // same source, second unclaimed phone refused
  phone1.close();
  await waitFor(() => r.relayState.pending.size === 0);
  const phone3 = await wsOpen('ws://127.0.0.1:' + port + '/c?pc=' + pcId);
  JSON.parse(await ctl.q.next()); // accepted again once the slot frees
  phone3.close();
  ctl.ws.close();
  // Two failed control auths from this source ban the third attempt outright.
  for (let i = 0; i < 2; i++) {
    const bad = await controlAuth(port, pair, ch => ch); // bare challenge: invalid now
    assert.equal(await bad.closed, 4403);
  }
  await assert.rejects(goodControlAuth(port, pair), /429/);
});

test('relay: phone frames sent before the splice are buffered, bounded, and flushed in order (audit #96)', {timeout: 30000}, async t => {
  // Positive path through the real Link: a phone that sends Noise message 1
  // the instant its socket opens (no settle, no retransmit) still pairs.
  const {port} = await startRelay(t, {unclaimedTimeoutMs: 8000});
  const storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-96-')), 'remote.json');
  const link2 = new Link({serve: {port: stubPort, token: TOKEN}, relayUrl: 'ws://127.0.0.1:' + port, lanPort: null, keys: loadOrCreateLinkKeys(), store: createRemoteStore(storeFile)});
  await link2.start();
  t.after(() => link2.stop().catch(() => {}));
  await new Promise(r => setTimeout(r, 300));
  const {code} = link2.startPairing({mode: 'qr'});
  const conn = new NoiseConnection({pattern: 'XX', initiator: true, staticKeyPair: generateStaticKeyPair()});
  const decoder = new FrameDecoder();
  const ws = await wsOpen('ws://127.0.0.1:' + port + '/c?pc=' + pcId);
  const inbox = [];
  ws.on('message', d => inbox.push(Buffer.from(d)));
  const nextRaw = async () => { while (!inbox.length) await new Promise(r => setTimeout(r, 5)); return inbox.shift(); };
  ws.send(conn.writeMessage(Buffer.alloc(0))); // message 1, sent before any splice can exist
  conn.readMessage(await nextRaw()); // message 2 only arrives if message 1 was flushed, not dropped
  ws.send(conn.writeMessage(Buffer.alloc(0)));
  assert.equal(conn.handshakeFinished, true);
  const appMsgs = [];
  ws.on('message', d => { try { const whole = decoder.push(conn.readTransport(Buffer.from(d))); if (whole) appMsgs.push(JSON.parse(whole.toString('utf8'))); } catch {} });
  for (const frame of encodeFrames(Buffer.from(JSON.stringify({t: 'pair', code, name: 'Early Bird'}), 'utf8'))) ws.send(conn.writeTransport(frame));
  await waitFor(() => appMsgs.some(m => m.t === 'paired'), 5000);
  ws.close();
  // Bound: a phone that floods before being claimed is dropped, not buffered forever.
  const over = await startRelay(t, {maxPreSpliceFrames: 4, unclaimedTimeoutMs: 5000});
  const pair = relayKeyPair();
  const ctl = await goodControlAuth(over.port, pair);
  await waitFor(() => over.relay.relayState.pcs.size === 1);
  const flood = await wsOpen('ws://127.0.0.1:' + over.port + '/c?pc=' + pcIdFor(pair.publicKey));
  const floodClosed = wsCloseCode(flood);
  for (let i = 0; i < 8; i++) flood.send(Buffer.alloc(16, i));
  assert.equal(await floodClosed, 4408);
  ctl.ws.close();
});

test('relay: a splice with no forwarded data dies on idle even while pongs and text frames flow (audit #101)', {timeout: 30000}, async t => {
  const {relay: r, port} = await startRelay(t, {pingIntervalMs: 50, idleTimeoutMs: 300, unclaimedTimeoutMs: 5000});
  const pair = relayKeyPair();
  const pcId = pcIdFor(pair.publicKey);
  const ctl = await goodControlAuth(port, pair);
  await waitFor(() => r.relayState.pcs.size === 1);
  const s = await spliceViaRelay(port, pair, pcId, ctl.q, goodDataAuth);
  await waitFor(() => r.relayState.splices.size === 1);
  const phoneClosed = wsCloseCode(s.phone);
  // Dropped text frames every 80 ms, plus the ws stack's automatic pongs:
  // neither may count as activity, so the splice must still be reaped.
  const spam = setInterval(() => { try { s.phone.send('still here'); } catch {} }, 80);
  assert.equal(await phoneClosed, 4408);
  clearInterval(spam);
  ctl.ws.close();
});

test('relay: a peer that stops receiving ends the splice; undelivered bytes are not charged (audit #97)', {timeout: 60000}, async t => {
  const {relay: r, port} = await startRelay(t, {maxBufferedBytes: 256 * 1024, pingIntervalMs: 0, unclaimedTimeoutMs: 5000});
  const pair = relayKeyPair();
  const pcId = pcIdFor(pair.publicKey);
  const ctl = await goodControlAuth(port, pair);
  await waitFor(() => r.relayState.pcs.size === 1);
  const s = await spliceViaRelay(port, pair, pcId, ctl.q, goodDataAuth);
  await waitFor(() => r.relayState.splices.size === 1);
  s.phone.pause(); // the phone stops reading entirely
  const frame = Buffer.alloc(60 * 1024, 7);
  let sent = 0;
  const dataClosed = wsCloseCode(s.data);
  for (let i = 0; i < 300 && s.data.readyState === WebSocket.OPEN; i++) {
    try { s.data.send(frame, {binary: true}); sent += frame.length; } catch { break; }
    if (i % 20 === 19) await new Promise(r2 => setTimeout(r2, 1));
  }
  assert.equal(await dataClosed, 4429); // 'peer too slow', not a silent mid-stream drop
  assert.ok(r.stats().forwardedBytesTotal < sent / 2, `charged ${r.stats().forwardedBytesTotal} of ${sent} sent bytes`);
  ctl.ws.close();
});
