'use strict';
// muser link, PC side (remote/DESIGN.md): keys in the secure-store, the paired-device
// store, the serve proxy, and the Noise channel end to end with a Node "phone".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

// loadOrCreateLinkKeys() below persists the PC's link keys into the
// secure-store (link.enc under %LOCALAPPDATA%\muser) on the DEFAULT store.
// Point every folder at a throwaway one BEFORE loading any src module,
// mirroring tests/accounts.test.js: `npm test` already isolates via
// tests/setup.mjs, but a bare `node --test tests/link.test.js` skips that
// file — and a crash mid-run could leave phantom keys/accounts behind in
// the user's real store.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-test-home-'));

const {loadOrCreateLinkKeys, signRelay, verifyRelay, pcIdFor} = require('../src/link/keys');
const secureStore = require('../src/secure-store');
const {createRemoteStore, idFor} = require('../src/link/remote-store');
const {createProxy} = require('../src/link/proxy');
const {handleChannelSocket, messageQueue} = require('../src/link/channel-server');
const {Link, LAN_MAX_PAYLOAD} = require('../src/link/link');
const dgram = require('node:dgram');
const {EventEmitter} = require('node:events');

// noise.js is a shipped production module (deep audit H17): require it
// unconditionally. The old skip fallback let a missing/renamed noise module
// turn ~28 channel/link tests into skips while the suite stayed green.
const noise = require('../src/link/noise');

// --- keys -------------------------------------------------------------------

test('link keys persist through the secure-store and pcId derives from the relay key', () => {
  const a = loadOrCreateLinkKeys();
  assert.equal(a.keys.noise.publicKey.length, 32);
  assert.equal(a.keys.noise.privateKey.length, 32);
  assert.equal(a.keys.relay.publicKey.length, 32);
  assert.equal(a.keys.relay.privateKey.length, 32);
  const expectId = crypto.createHash('sha256').update(a.keys.relay.publicKey).digest().toString('base64url').slice(0, 22);
  assert.equal(a.pcId, expectId);
  assert.equal(pcIdFor(a.keys.relay.publicKey), a.pcId);
  // The persisted entry is one JSON value with base64 fields.
  const saved = secureStore.load('link.enc');
  assert.equal(Buffer.from(saved.noise.publicKey, 'base64').length, 32);
  assert.equal(Buffer.from(saved.relay.privateKey, 'base64').length, 32);
  // A second load returns the same keys (no regeneration).
  const b = loadOrCreateLinkKeys();
  assert.deepEqual(b.keys.noise, a.keys.noise);
  assert.deepEqual(b.keys.relay, a.keys.relay);
  assert.equal(b.pcId, a.pcId);
  // The relay signing helper round-trips, and rejects a tampered message.
  const sig = signRelay(a.keys.relay, Buffer.from('challenge-bytes'));
  assert.equal(sig.length, 64);
  assert.equal(verifyRelay(a.keys.relay, Buffer.from('challenge-bytes'), sig), true);
  assert.equal(verifyRelay(a.keys.relay, Buffer.from('other-bytes'), sig), false);
});

// --- remote-store -------------------------------------------------------------

test('remote-store add / find / touch / remove, with ids from the static key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-remote-'));
  const store = createRemoteStore(path.join(dir, 'remote.json'));
  assert.deepEqual(store.list(), []);
  const pub = crypto.randomBytes(32);
  const device = store.add({name: 'Galaxy S26', staticPub: pub});
  assert.equal(device.id, idFor(pub));
  assert.equal(device.id, crypto.createHash('sha256').update(pub).digest().toString('base64url').slice(0, 22));
  assert.equal(device.staticPub, pub.toString('base64url'));
  assert.equal(device.name, 'Galaxy S26');
  assert.ok(device.createdAt && device.lastSeen);
  // Findable by raw Buffer and by the stored base64url text alike.
  assert.equal(store.findByStatic(pub)?.id, device.id);
  assert.equal(store.findByStatic(pub.toString('base64url'))?.id, device.id);
  assert.equal(store.findByStatic(crypto.randomBytes(32)), null);
  // Re-adding the same key refreshes in place instead of duplicating.
  const again = store.add({name: 'Galaxy S26 Ultra', staticPub: pub});
  assert.equal(again.id, device.id);
  assert.equal(again.createdAt, device.createdAt);
  assert.equal(store.list().length, 1);
  // The file on disk has the documented shape, and touch only moves lastSeen.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'remote.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['devices']);
  assert.deepEqual(Object.keys(onDisk.devices[0]).sort(), ['createdAt', 'id', 'lastSeen', 'name', 'staticPub']);
  assert.equal(store.touch(device.id)?.id, device.id);
  assert.equal(store.touch('nope'), null);
  // Removal works by id and by name; a missing device removes nothing.
  const other = store.add({name: 'Pixel', staticPub: crypto.randomBytes(32)});
  assert.equal(store.remove(other.id)?.name, 'Pixel');
  assert.equal(store.remove('Galaxy S26 Ultra')?.id, device.id);
  assert.equal(store.remove('Galaxy S26 Ultra'), null);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.add({name: 'x', staticPub: Buffer.alloc(3)}), /32-byte/);
});

// --- proxy ---------------------------------------------------------------------

test('proxy forwards requests with the serve token and parses SSE subscriptions', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({url: req.url, auth: req.headers.authorization});
    if (req.url === '/api/events') {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: {"kind":"state"}\n\n');
      res.write(': ping\n\n');
      res.write('event: tick\ndata: hello\n\n');
      return; // stays open until the client closes
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { res.writeHead(201, {'content-type': 'application/json'}); res.end(JSON.stringify({echo: JSON.parse(body || '{}')})); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const proxy = createProxy({port: server.address().port, token: 'sekrit'});
    const out = await proxy.request({method: 'POST', path: '/api/send', body: {text: 'hi'}});
    assert.equal(out.status, 201);
    assert.deepEqual(out.body, {echo: {text: 'hi'}});
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE events did not arrive')), 5000);
      const close = proxy.openSubscription('/api/events', (event, data) => {
        events.push([event, data]);
        if (events.length === 2) { clearTimeout(timer); close(); resolve(); }
      }, reject);
    });
    assert.deepEqual(events, [['message', '{"kind":"state"}'], ['tick', 'hello']]);
    assert.ok(seen.every(s => s.auth === 'Bearer sekrit'));
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

// --- channel end to end ---------------------------------------------------------

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

// A fake phone: Noise initiator + the same framing the PC uses.
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
    // Close only ends rawQ: the drain loop below pushes appQ's null AFTER the
    // frames already queued, so a rejection sent just before the close is
    // still delivered to recv() (t1 #3: pushing null here raced the decrypt).
    this.ws.on('close', () => { this.rawQ.push(null); this.markClosed(); });
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
      try {
        for (;;) {
          const m = await this.rawQ.next().catch(() => null);
          if (!m) break;
          try { const whole = this.decoder.push(this.conn.readTransport(m)); if (whole) this.appQ.push(JSON.parse(whole.toString('utf8'))); }
          catch { break; }
        }
      } finally { this.appQ.push(null); } // after every queued frame, never before them
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
function tmpStore() { return createRemoteStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-e2e-')), 'remote.json')); }

test('channel: QR pairing, then the tunnel protocol on the paired key', {timeout: 30000}, async t => {
  const store = tmpStore();
  const pairing = {mode: 'qr', code: 'K7Q2AB12', expiresAt: Date.now() + 60000, attempts: 0};
  const ctx = () => ({keys: pcKeys(), remoteStore: store, proxy: stubProxy, pairing, relayUrl: 'wss://relay.test/', lanAddresses: ['192.168.1.6:8734']});
  // pcKeys() per connection would change the PC static; keep one set for the server.
  const keys = pcKeys();
  const {url, results} = await channelServer(t, () => ({...ctx(), keys}));

  // Wrong code: rejected, nothing paired.
  const bad = await new Phone(url, {}).start();
  bad.send({t: 'pair', code: 'WRONG123', name: 'Bad Phone'});
  const rejection = await bad.recv(); // unconditional (t1 #3): the Phone close race that used to eat this frame is fixed above, so a missing rejection now fails here
  assert.equal(rejection.t, 'pair-failed');
  await bad.closed;
  assert.deepEqual(store.list(), []);

  // Right code: paired reply carries the device and the PC's addresses.
  const phone = await new Phone(url, {}).start();
  phone.send({t: 'pair', code: 'K7Q2AB12', name: 'Galaxy S26'});
  const paired = await phone.recv();
  assert.equal(paired.t, 'paired');
  assert.equal(paired.device.name, 'Galaxy S26');
  assert.equal(paired.device.id, idFor(phone.keyPair.publicKey));
  assert.equal(paired.pc.pcId, 'pc-test-id');
  assert.equal(paired.pc.name, os.hostname());
  assert.equal(paired.pc.relay, 'wss://relay.test/');
  assert.deepEqual(paired.pc.lan, ['192.168.1.6:8734']);
  assert.equal(store.list().length, 1);
  assert.equal(pairing.consumed, true);

  // Tunnel: req/res through the stub proxy, ping/pong, sub/unsub event forwarding.
  phone.send({t: 'req', id: 7, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  const res = await phone.recv();
  assert.deepEqual(res, {t: 'res', id: 7, status: 200, body: {method: 'POST', path: '/api/send', body: {text: 'hi'}}});
  phone.send({t: 'sub', id: 8, path: '/api/events'});
  const ev = await phone.recv();
  assert.deepEqual(ev, {t: 'ev', id: 8, event: 'state', data: {kind: 'state', path: '/api/events'}});
  phone.send({t: 'unsub', id: 8});
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'});
  phone.close();
  await phone.closed;

  // The pairing is spent, but the paired key reconnects straight into the tunnel.
  const again = await new Phone(url, {keyPair: phone.keyPair}).start();
  again.send({t: 'req', id: 1, method: 'GET', path: '/api/state'});
  const res2 = await again.recv();
  assert.equal(res2.t, 'res');
  assert.equal(res2.status, 200);
  again.close();
  await Promise.allSettled(results);
});

test('channel: an unpaired static key is closed at once when not pairing', {timeout: 30000}, async t => {
  const store = tmpStore();
  const {url} = await channelServer(t, {keys: pcKeys(), remoteStore: store, proxy: stubProxy, pairing: null});
  const stranger = await new Phone(url, {}).start(); // the XX handshake itself completes…
  await stranger.closed; // …and the PC closes the channel: the key is not paired
  assert.deepEqual(store.list(), []);
});

test('channel: Wi-Fi pairing rides the PSK handshake; a wrong code burns an attempt', {timeout: 30000}, async t => {
  const store = tmpStore();
  const keys = pcKeys();
  const pairing = {mode: 'wifi', code: 'W1F1CODE', expiresAt: Date.now() + 60000, attempts: 0};
  const {url} = await channelServer(t, () => ({keys, remoteStore: store, proxy: stubProxy, pairing}));

  const phone = await new Phone(url, {pattern: 'XXpsk3', psk: noise.pskFromCode('W1F1CODE')}).start();
  phone.send({t: 'pair', name: 'Wifi Phone'}); // no code field: the PSK already proved it
  const paired = await phone.recv();
  assert.equal(paired.t, 'paired');
  assert.equal(paired.device.name, 'Wifi Phone');
  assert.equal(store.list().length, 1);
  phone.close();

  // A fresh Wi-Fi pairing, guessed wrong: the handshake cannot finish, the attempt counts.
  const pairing2 = {mode: 'wifi', code: 'W1F1CODE', expiresAt: Date.now() + 60000, attempts: 0};
  const second = await channelServer(t, () => ({keys, remoteStore: store, proxy: stubProxy, pairing: pairing2}));
  const guesser = await new Phone(second.url, {pattern: 'XXpsk3', psk: noise.pskFromCode('GUESS123')}).start();
  await guesser.closed;
  assert.equal(pairing2.attempts, 1);
  assert.equal(store.list().length, 1); // the guesser did not get in
});

test('channel: one QR code pairs exactly one phone, even concurrently (audit #87)', {timeout: 30000}, async t => {
  const store = tmpStore();
  const keys = pcKeys();
  const pairing = {mode: 'qr', code: 'K7Q2AB12', expiresAt: Date.now() + 60000, attempts: 0};
  const {url} = await channelServer(t, () => ({keys, remoteStore: store, proxy: stubProxy, pairing}));
  // Both handshakes finish while the pairing is live; only the first claim may land.
  const a = await new Phone(url, {}).start();
  const b = await new Phone(url, {}).start();
  a.send({t: 'pair', code: 'K7Q2AB12', name: 'Phone A'});
  b.send({t: 'pair', code: 'K7Q2AB12', name: 'Phone B'});
  const replies = await Promise.all([a, b].map(p => p.recv().catch(() => null)));
  assert.equal(replies.filter(r => r && r.t === 'paired').length, 1, 'exactly one phone is paired');
  assert.equal(store.list().length, 1);
  a.close(); b.close();
});

test('channel: Wi-Fi guesses in parallel share one attempt budget (audit #88)', {timeout: 30000}, async t => {
  const store = tmpStore();
  const keys = pcKeys();
  const pairing = {mode: 'wifi', code: 'W1F1CODE', expiresAt: Date.now() + 60000, attempts: 0};
  const {url} = await channelServer(t, () => ({keys, remoteStore: store, proxy: stubProxy, pairing}));
  const guessers = await Promise.all([...Array(5)].map(() => new Phone(url, {pattern: 'XXpsk3', psk: noise.pskFromCode('GUESS123')}).start().catch(() => null)));
  await Promise.all(guessers.filter(Boolean).map(g => g.closed));
  assert.equal(pairing.attempts, 5, 'every parallel connection spent from the same budget');
  assert.equal(pairing.burned, true);
  assert.equal(store.list().length, 0);
  // The code is dead now: even the right code cannot pair on a fresh connection.
  const legit = await new Phone(url, {pattern: 'XXpsk3', psk: noise.pskFromCode('W1F1CODE')}).start().catch(() => null);
  if (legit) { legit.send({t: 'pair', name: 'Too Late'}); await legit.closed; }
  assert.equal(store.list().length, 0);
});

// --- Link pairing control ---------------------------------------------------------

test('link: pairing codes are 8 unambiguous chars, live 5 minutes, and stop on demand', {timeout: 30000}, async () => {
  const keys = {keys: {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}};
  keys.pcId = pcIdFor(keys.keys.relay.publicKey);
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: 0, keys, store: tmpStore(), proxy: stubProxy});
  const before = Date.now();
  const {code, expiresAt} = link.startPairing({mode: 'qr'});
  assert.equal(code.length, 8);
  assert.ok(!/[01IOL]/.test(code), code);
  assert.ok(expiresAt >= before + 5 * 60 * 1000 - 1000 && expiresAt <= Date.now() + 5 * 60 * 1000 + 1000);
  assert.equal(link.state().pairing.code, code);
  link.stopPairing();
  assert.equal(link.state().pairing, null);
  // The LAN listener starts and stops, and state reports the real port.
  await link.start();
  try {
    assert.ok(link.state().lanPort > 0);
    assert.equal(link.state().pcId, keys.pcId);
  } finally { await link.stop(); }
});

// --- audit 2026-11-03, section G regressions ---------------------------------

test('noise framing: reassembly is capped, not unbounded (audit #89)', () => {
  const dec = new noise.FrameDecoder();
  const frame = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(1024 * 1024, 1)]); // 1 MiB, non-final
  for (let i = 0; i < 32; i++) assert.equal(dec.push(frame), null);
  assert.throws(() => dec.push(frame), /exceeds/);
  assert.deepEqual(dec.parts, []); // the buffered parts are dropped, not kept
  // Phase 2 (deep c30 #2): once the cap trips the decoder stays failed — the tail
  // of an oversized payload must never be delivered as a complete message, so
  // the decoder is NOT reusable afterwards.
  assert.throws(() => dec.push(Buffer.from([0x01, 65])), /already failed/);
  const re = new noise.ChunkReassembler();
  const piece = Buffer.alloc(1024 * 1024, 2);
  for (let i = 0; i < 32; i++) assert.equal(re.push(piece, false), null);
  assert.throws(() => re.push(piece, false), /exceeds/);
  assert.throws(() => re.push(Buffer.from('x'), true), /already failed/);
});

test('remote-store: a corrupt file is refused, never silently emptied (audit #106)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-link-corrupt-'));
  const f = path.join(dir, 'remote.json');
  const truncated = '{"devices":[{"id":"x"';
  fs.writeFileSync(f, truncated);
  const store = createRemoteStore(f);
  assert.throws(() => store.list(), /corrupt/);
  assert.throws(() => store.add({name: 'p', staticPub: crypto.randomBytes(32)}), /corrupt/);
  assert.equal(fs.readFileSync(f, 'utf8'), truncated); // left exactly as found
  fs.writeFileSync(f, '{"nope":true}');
  assert.throws(() => store.list(), /corrupt/);
  // A missing file is still just an empty list.
  assert.deepEqual(createRemoteStore(path.join(dir, 'absent.json')).list(), []);
});

test('remote-store: remove by name refuses ambiguity (audit #107)', () => {
  const store = tmpStore();
  const a = store.add({name: 'phone', staticPub: crypto.randomBytes(32)});
  const b = store.add({name: 'phone', staticPub: crypto.randomBytes(32)});
  assert.equal(store.remove('phone'), null); // two devices share the default name: remove neither
  assert.equal(store.list().length, 2);
  assert.equal(store.remove(a.id)?.id, a.id); // ids stay exact
  assert.equal(store.remove('phone')?.id, b.id); // now the name is unambiguous again
  assert.deepEqual(store.list(), []);
});

test('link keys: loadLinkKeys reads without creating (a status view must not mint a pcId)', () => {
  const {loadLinkKeys} = require('../src/link/keys');
  const empty = {saved: false, load: () => null, save: () => { empty.saved = true; }};
  assert.equal(loadLinkKeys({store: empty}), null);
  assert.equal(empty.saved, false, 'nothing was persisted');
  const good = loadOrCreateLinkKeys();
  const enc = p => ({publicKey: p.publicKey.toString('base64'), privateKey: p.privateKey.toString('base64')});
  const intact = JSON.parse(JSON.stringify({noise: enc(good.keys.noise), relay: enc(good.keys.relay)}));
  const loaded = loadLinkKeys({store: {load: () => intact, save: () => { throw new Error('must not save'); }}});
  assert.equal(loaded.pcId, good.pcId);
});

test('link keys: partial corruption or a mismatched pair is a hard error, never a silent regeneration (audit #105)', () => {
  const good = loadOrCreateLinkKeys();
  const enc = p => ({publicKey: p.publicKey.toString('base64'), privateKey: p.privateKey.toString('base64')});
  const intact = JSON.parse(JSON.stringify({noise: enc(good.keys.noise), relay: enc(good.keys.relay)}));
  const fakeStore = value => { const s = {saved: false, load: () => value, save: () => { s.saved = true; }}; return s; };
  const loaded = loadOrCreateLinkKeys({store: fakeStore(JSON.parse(JSON.stringify(intact)))});
  assert.deepEqual(loaded.keys.noise, good.keys.noise);
  assert.equal(loaded.pcId, good.pcId);
  const partial = fakeStore({noise: intact.noise}); // relay half lost
  assert.throws(() => loadOrCreateLinkKeys({store: partial}), /incomplete or corrupt/);
  assert.equal(partial.saved, false);
  const swapped = JSON.parse(JSON.stringify(intact));
  swapped.relay.publicKey = enc(good.keys.noise).publicKey; // public half belongs to another key
  const bad = fakeStore(swapped);
  assert.throws(() => loadOrCreateLinkKeys({store: bad}), /does not match/);
  assert.equal(bad.saved, false);
});

test('channel: the message queue is bounded while the consumer is busy (audit #91)', () => {
  const fake = new EventEmitter();
  let terminated = false;
  fake.terminate = () => { terminated = true; };
  fake.close = () => {};
  const q = messageQueue(fake);
  for (let i = 0; i < 300; i++) fake.emit('message', Buffer.alloc(1024, 1));
  assert.equal(terminated, true);
  assert.equal(q.overflowed, true);
});

test('channel: the message queue byte cap terminates below the count cap (t1 #4)', () => {
  // MAX_QUEUED_BYTES (16 MiB) had no test: 17 × 1 MiB stays under the
  // 256-message count cap, so only the byte accounting can terminate this.
  const fake = new EventEmitter();
  let terminated = false;
  fake.terminate = () => { terminated = true; };
  fake.close = () => {};
  const q = messageQueue(fake);
  for (let i = 0; i < 17; i++) fake.emit('message', Buffer.alloc(1024 * 1024, 1));
  assert.equal(terminated, true);
  assert.equal(q.overflowed, true);
});

// A phone that stalls mid-handshake: sends message 1, reads message 2, then
// only ever retransmits message 1.
async function handshakeStaller(url) {
  const conn = new noise.NoiseConnection({pattern: 'XX', initiator: true, staticKeyPair: noise.generateStaticKeyPair()});
  const ws = new WebSocket(url);
  const rawQ = new Queue();
  const closed = new Promise(r => ws.on('close', r));
  ws.on('message', d => rawQ.push(Buffer.from(d)));
  ws.on('error', () => {});
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const msg1 = conn.writeMessage(Buffer.alloc(0));
  ws.send(msg1);
  assert.ok(await rawQ.next()); // message 2 arrived
  return {ws, msg1, closed};
}

test('channel: the handshake deadline is overall — duplicates cannot rewind it (audit #94)', {timeout: 30000}, async t => {
  const keys = pcKeys();
  const {url, results} = await channelServer(t, () => ({keys, remoteStore: tmpStore(), proxy: stubProxy, pairing: null, handshakeTimeoutMs: 250}));
  const staller = await handshakeStaller(url);
  const spam = setInterval(() => { try { staller.ws.send(staller.msg1); } catch {} }, 40);
  await staller.closed;
  clearInterval(spam);
  const res = await results[0];
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'handshake-timeout');
});

test('channel: handshake duplicate retransmits are capped (audit #94)', {timeout: 30000}, async t => {
  const keys = pcKeys();
  const {url, results} = await channelServer(t, () => ({keys, remoteStore: tmpStore(), proxy: stubProxy, pairing: null, handshakeTimeoutMs: 10000}));
  const staller = await handshakeStaller(url);
  for (let i = 0; i < 40; i++) { try { staller.ws.send(staller.msg1); } catch {} }
  await staller.closed;
  const res = await results[0];
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'handshake-duplicates');
});

// A raw phone that keeps its handshake messages, for retransmit / transport
// corruption tests the JSON-only Phone helper cannot express.
async function rawPhone(url, keyPair) {
  const conn = new noise.NoiseConnection({pattern: 'XX', initiator: true, staticKeyPair: keyPair});
  const ws = new WebSocket(url);
  const rawQ = new Queue(), appQ = new Queue();
  const decoder = new noise.FrameDecoder();
  let markClosed;
  const closed = new Promise(r => { markClosed = r; });
  ws.on('message', d => rawQ.push(Buffer.from(d)));
  ws.on('close', () => { rawQ.push(null); appQ.push(null); markClosed(); });
  ws.on('error', () => {});
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const msg1 = conn.writeMessage(Buffer.alloc(0));
  ws.send(msg1);
  conn.readMessage(await rawQ.next());
  const msg3 = conn.writeMessage(Buffer.alloc(0));
  ws.send(msg3);
  (async () => {
    for (;;) {
      const m = await rawQ.next().catch(() => null);
      if (!m) return;
      try { const whole = decoder.push(conn.readTransport(m)); if (whole) appQ.push(JSON.parse(whole.toString('utf8'))); } catch { return; }
    }
  })();
  return {
    conn, ws, msg1, msg3, closed,
    send(obj) { for (const f of noise.encodeFrames(Buffer.from(JSON.stringify(obj), 'utf8'))) ws.send(conn.writeTransport(f)); },
    async recv() { const v = await appQ.next(); if (v === null) throw new Error('raw phone: channel closed'); return v; },
    close() { try { ws.close(); } catch {} },
  };
}
function pairedRawSetup(t, extraCtx = {}) {
  const store = tmpStore();
  const keys = pcKeys();
  const keyPair = noise.generateStaticKeyPair();
  store.add({name: 'Raw Phone', staticPub: keyPair.publicKey});
  return channelServer(t, {keys, remoteStore: store, proxy: stubProxy, pairing: null, ...extraCtx}).then(h => ({...h, keyPair}));
}

test('channel: a late duplicate handshake message does not kill the channel (audit #95)', {timeout: 30000}, async t => {
  const {url, keyPair} = await pairedRawSetup(t);
  const phone = await rawPhone(url, keyPair);
  phone.ws.send(phone.msg1); // in-flight duplicates arriving after the handshake finished
  phone.ws.send(phone.msg3);
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'});
  phone.close();
  await phone.closed;
});

test('channel: transport corruption ends the channel as a failure, not a clean end (audit #102)', {timeout: 30000}, async t => {
  const {url, results, keyPair} = await pairedRawSetup(t);
  const phone = await rawPhone(url, keyPair);
  phone.ws.send(Buffer.alloc(48, 9)); // not a Noise transport message at all
  await phone.closed;
  const res = await results[0];
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'aead-failed');
});

test('channel: a malformed frame ends the channel as a failure (audit #102)', {timeout: 30000}, async t => {
  const {url, results, keyPair} = await pairedRawSetup(t);
  const phone = await rawPhone(url, keyPair);
  phone.ws.send(phone.conn.writeTransport(Buffer.from([0x7f, 1, 2]))); // valid AEAD, unknown frame flags
  await phone.closed;
  const res = await results[0];
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-frame');
});

test('channel: a silent established channel is dropped, activity keeps it alive (audit #98)', {timeout: 30000}, async t => {
  const store = tmpStore();
  const keys = pcKeys();
  const keyPair = noise.generateStaticKeyPair();
  store.add({name: 'Idle Phone', staticPub: keyPair.publicKey});
  const {url, results} = await channelServer(t, {keys, remoteStore: store, proxy: stubProxy, pairing: null, channelIdleTimeoutMs: 1000});
  const phone = await new Phone(url, {keyPair}).start();
  // Pinging every 100 ms keeps the channel alive past the 1 s idle deadline
  // (t1 #5: the old 200 ms deadline / 60 ms ping raced scheduler jitter).
  for (let i = 0; i < 12; i++) {
    phone.send({t: 'ping'});
    assert.deepEqual(await phone.recv(), {t: 'pong'});
    await new Promise(r => setTimeout(r, 100));
  }
  await phone.closed; // then silence gets it dropped
  const res = await results[0];
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'idle-timeout');
});

test('channel: one slow request does not park ping/pong behind it (audit #104)', {timeout: 30000}, async t => {
  const slowProxy = {
    request: async ({path: p}) => { if (p === '/slow') await new Promise(r => setTimeout(r, 400)); return {status: 200, body: {path: p}}; },
    openSubscription: stubProxy.openSubscription,
  };
  const store = tmpStore();
  const keys = pcKeys();
  const keyPair = noise.generateStaticKeyPair();
  store.add({name: 'Busy Phone', staticPub: keyPair.publicKey});
  const {url} = await channelServer(t, {keys, remoteStore: store, proxy: slowProxy, pairing: null});
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'GET', path: '/slow'});
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'}); // the pong overtakes the slow response
  const res = await phone.recv();
  assert.equal(res.t, 'res');
  assert.equal(res.id, 1);
  phone.close();
  await phone.closed;
});

// --- audit 2026-11-03, channel tunnel fixes (#108, #109, #113, #118, #119) ----

const waitMs = ms => new Promise(r => setTimeout(r, ms));
async function waitForCalls(cond, what) { for (let i = 0; i < 100 && !cond(); i++) await waitMs(20); assert.ok(cond(), what); }
async function pairedPhoneSetup(t, proxy, extraCtx = {}) {
  const store = tmpStore();
  const keys = pcKeys();
  const keyPair = noise.generateStaticKeyPair();
  store.add({name: 'Fix Phone', staticPub: keyPair.publicKey});
  const h = await channelServer(t, {keys, remoteStore: store, proxy, pairing: null, ...extraCtx});
  return {...h, keyPair};
}

test('channel: proxy failures are classified for the phone, never relayed raw (audit #119)', {timeout: 30000}, async t => {
  const proxy = {
    request: async ({path: p}) => {
      if (p === '/refused') { const e = new Error('connect ECONNREFUSED 127.0.0.1:9999'); e.code = 'ECONNREFUSED'; throw e; }
      if (p === '/timeout') throw new Error('link proxy: serve did not answer in time');
      if (p === '/toobig') throw new Error('link proxy: serve response too large');
      throw new Error('kaboom at 10.1.2.3 with secret internals');
    },
    openSubscription: stubProxy.openSubscription,
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'GET', path: '/refused'});
  assert.deepEqual(await phone.recv(), {t: 'res', id: 1, status: 503, body: {error: 'serve unavailable', code: 'serve-unavailable', retryable: true, outcome: 'not-executed'}});
  phone.send({t: 'req', id: 2, method: 'GET', path: '/timeout'});
  assert.deepEqual(await phone.recv(), {t: 'res', id: 2, status: 504, body: {error: 'serve timed out', code: 'serve-timeout', retryable: true, outcome: 'unknown'}});
  phone.send({t: 'req', id: 3, method: 'POST', path: '/timeout', body: {text: 'x'}});
  assert.deepEqual(await phone.recv(), {t: 'res', id: 3, status: 504, body: {error: 'serve timed out', code: 'serve-timeout', retryable: false, outcome: 'unknown'}});
  phone.send({t: 'req', id: 4, method: 'POST', path: '/toobig', body: {text: 'x'}});
  assert.deepEqual(await phone.recv(), {t: 'res', id: 4, status: 502, body: {error: 'serve response too large', code: 'response-too-large', retryable: false, outcome: 'executed'}});
  phone.send({t: 'req', id: 5, method: 'POST', path: '/boom', body: {text: 'x'}});
  const res5 = await phone.recv();
  assert.deepEqual(res5, {t: 'res', id: 5, status: 502, body: {error: 'proxy request failed', code: 'proxy-failed', retryable: false, outcome: 'unknown'}});
  assert.ok(!JSON.stringify(res5).includes('secret'), 'no internal error text leaks');
  phone.close();
  await phone.closed;
});

test('channel: a request whose channel dies mid-flight is replayed to the resend, never executed twice (audit #108)', {timeout: 30000}, async t => {
  let calls = 0, release = null, seenSignal = null;
  const proxy = {
    request: ({signal}) => { calls++; seenSignal = signal; if (calls === 1) return new Promise(res => { release = res; }); return Promise.resolve({status: 200, body: {calls}}); },
    openSubscription: stubProxy.openSubscription,
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  await waitForCalls(() => calls === 1, 'the first request reached the proxy');
  phone.close();
  await phone.closed;
  await waitMs(100);
  assert.equal(seenSignal?.aborted, true, 'the orphaned request was signalled cancelled');
  release({status: 200, body: {ok: 1}}); // the proxy ignored the signal and finished anyway
  await waitMs(150); // the outcome settles with no live channel to deliver it to
  const again = await new Phone(url, {keyPair}).start();
  again.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}}); // fresh channel, fresh id counter, same request
  assert.deepEqual(await again.recv(), {t: 'res', id: 1, status: 200, body: {ok: 1}});
  assert.equal(calls, 1, 'the resend replayed the original outcome instead of executing again');
  again.close();
  await again.closed;
});

test('channel: a request a signal-honouring proxy cancelled is executed fresh on resend (audit #108)', {timeout: 30000}, async t => {
  let calls = 0;
  const proxy = {
    request: ({signal}) => {
      calls++;
      if (calls === 1) return new Promise((_, rej) => signal?.addEventListener?.('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; rej(e); }));
      return Promise.resolve({status: 200, body: {calls}});
    },
    openSubscription: stubProxy.openSubscription,
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  await waitForCalls(() => calls === 1, 'the first request reached the proxy');
  phone.close();
  await phone.closed;
  await waitMs(200); // abort settles and the ledger entry is dropped
  const again = await new Phone(url, {keyPair}).start();
  again.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  assert.deepEqual(await again.recv(), {t: 'res', id: 1, status: 200, body: {calls: 2}});
  assert.equal(calls, 2, 'a cancelled request has no outcome to replay: the resend executed it');
  again.close();
  await again.closed;
});

test('channel: an identical request sent again after delivery is a new execution (audit #108)', {timeout: 30000}, async t => {
  let calls = 0;
  const proxy = {request: async () => ({status: 200, body: {calls: ++calls}}), openSubscription: stubProxy.openSubscription};
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  assert.deepEqual((await phone.recv()).body, {calls: 1});
  phone.send({t: 'req', id: 2, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  assert.deepEqual((await phone.recv()).body, {calls: 2});
  assert.equal(calls, 2, 'delivery cleared the ledger entry, so the repeat executed');
  phone.close();
  await phone.closed;
});

test('channel: tunnel ids are validated and deduplicated (audit #109)', {timeout: 30000}, async t => {
  const reqPaths = [], subPaths = [];
  let releaseSlow = null;
  const proxy = {
    request: ({path: p}) => { reqPaths.push(p); if (p === '/slow') return new Promise(res => { releaseSlow = () => res({status: 200, body: {path: p}}); }); return Promise.resolve({status: 200, body: {path: p}}); },
    openSubscription: (p, onEvent) => { subPaths.push(p); onEvent('state', '{"kind":"state","path":"' + p + '"}'); return () => {}; },
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  // A request with no id can never be correlated: it is not executed at all.
  phone.send({t: 'req', method: 'POST', path: '/api/send', body: {text: 'hi'}});
  await waitMs(150);
  assert.deepEqual(reqPaths, []);
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'}); // the channel itself is unharmed
  // A second request reusing an in-flight id is dropped, not executed.
  phone.send({t: 'req', id: 5, method: 'GET', path: '/slow'});
  await waitForCalls(() => reqPaths.length === 1, 'the slow request reached the proxy');
  phone.send({t: 'req', id: 5, method: 'GET', path: '/other'});
  await waitMs(150);
  assert.deepEqual(reqPaths, ['/slow']);
  releaseSlow();
  assert.deepEqual(await phone.recv(), {t: 'res', id: 5, status: 200, body: {path: '/slow'}});
  // A duplicate subscription id keeps the original; the new path is not opened.
  phone.send({t: 'sub', id: 8, path: '/a'});
  assert.deepEqual(await phone.recv(), {t: 'ev', id: 8, event: 'state', data: {kind: 'state', path: '/a'}});
  phone.send({t: 'sub', id: 8, path: '/b'});
  phone.send({t: 'sub', path: '/c'}); // no id: not opened either
  await waitMs(150);
  assert.deepEqual(subPaths, ['/a']);
  phone.send({t: 'ping'});
  assert.deepEqual(await phone.recv(), {t: 'pong'});
  phone.close();
  await phone.closed;
});

test('channel: a failed subscription is reported to the phone, which can resubscribe the id (audit #113)', {timeout: 30000}, async t => {
  let opens = 0, subError = null;
  const proxy = {
    request: stubProxy.request,
    openSubscription: (p, onEvent, onError) => { opens++; if (opens === 1) { subError = onError; return () => {}; } onEvent('state', '{"kind":"state","path":"' + p + '"}'); return () => {}; },
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'sub', id: 3, path: '/api/events'});
  await waitForCalls(() => subError !== null, 'the subscription opened');
  subError(new Error('link proxy: subscription ended; serve socket at 10.0.0.9 died'));
  assert.deepEqual(await phone.recv(), {t: 'sub-failed', id: 3, error: 'subscription ended', code: 'subscription-ended'});
  // The dead entry is gone: the same id subscribes afresh instead of being
  // treated as a duplicate of a corpse.
  phone.send({t: 'sub', id: 3, path: '/api/events'});
  assert.deepEqual(await phone.recv(), {t: 'ev', id: 3, event: 'state', data: {kind: 'state', path: '/api/events'}});
  assert.equal(opens, 2);
  phone.close();
  await phone.closed;
});

test('channel: a resend that joined in flight keeps the original alive when the first channel dies (audit #108)', {timeout: 30000}, async t => {
  let calls = 0, release = null, seenSignal = null;
  const proxy = {
    request: ({signal}) => { calls++; seenSignal = signal; return new Promise(res => { release = res; }); },
    openSubscription: stubProxy.openSubscription,
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const first = await new Phone(url, {keyPair}).start();
  first.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  await waitForCalls(() => calls === 1, 'the first request reached the proxy');
  const second = await new Phone(url, {keyPair}).start();
  second.send({t: 'req', id: 1, method: 'POST', path: '/api/send', body: {text: 'hi'}});
  await waitMs(250); // the resend joins the in-flight entry instead of executing
  assert.equal(calls, 1, 'the identical resend did not execute a second time');
  first.close();
  await first.closed;
  await waitMs(150);
  assert.equal(seenSignal?.aborted, false, 'a still-waiting channel keeps the shared request un-aborted');
  release({status: 200, body: {ok: 1}});
  assert.deepEqual(await second.recv(), {t: 'res', id: 1, status: 200, body: {ok: 1}});
  assert.equal(calls, 1);
  second.close();
  await second.closed;
});

test('channel: a subscription that fails synchronously during open is reported and torn down (audit #113)', {timeout: 30000}, async t => {
  let opens = 0, closes = 0;
  const proxy = {
    request: stubProxy.request,
    openSubscription: (p, onEvent, onError) => { opens++; if (opens === 1) { onError(new Error('link proxy: subscription answered 500 at 127.0.0.1')); return () => { closes++; }; } onEvent('state', '{"kind":"state","path":"' + p + '"}'); return () => {}; },
  };
  const {url, keyPair} = await pairedPhoneSetup(t, proxy);
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'sub', id: 4, path: '/api/events'});
  assert.deepEqual(await phone.recv(), {t: 'sub-failed', id: 4, error: 'subscription ended', code: 'subscription-ended'});
  assert.equal(closes, 1, 'the synchronously failed subscription was torn down, not stored');
  phone.send({t: 'sub', id: 4, path: '/api/events'});
  assert.deepEqual(await phone.recv(), {t: 'ev', id: 4, event: 'state', data: {kind: 'state', path: '/api/events'}});
  assert.equal(opens, 2);
  phone.close();
  await phone.closed;
});

test('channel: sendApp backpressure drops events and ends the channel on an undeliverable reply (audit #118)', {timeout: 30000}, async t => {
  // A negative limit makes every bufferedAmount (even 0) exceed it, which
  // exercises the backpressure branch deterministically.
  const {url, keyPair} = await pairedPhoneSetup(t, stubProxy, {sendBufferLimitBytes: -1});
  const phone = await new Phone(url, {keyPair}).start();
  phone.send({t: 'sub', id: 8, path: '/api/events'}); // the stub emits an event at once
  await waitMs(250);
  assert.equal(phone.appQ.items.length, 0, 'the event was dropped, not queued behind a full socket');
  assert.equal(phone.ws.readyState, 1, 'a dropped event does not end the channel');
  phone.send({t: 'req', id: 1, method: 'GET', path: '/api/state'});
  await phone.closed; // a reply that cannot be queued ends the channel so the phone resyncs
  // appQ holds only the close sentinel (null) the Phone pushes on 'close' —
  // no actual reply message was queued behind the full socket.
  assert.deepEqual(phone.appQ.items.filter(v => v !== null), [], 'the reply was not queued either');
});

test('link: the LAN listener caps frame size and live channels (audit #90)', {timeout: 30000}, async () => {
  const keys = {keys: {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}};
  keys.pcId = pcIdFor(keys.keys.relay.publicKey);
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: 0, keys, store: tmpStore(), proxy: stubProxy, discoveryPort: 0});
  await link.start();
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + link.state().lanPort);
    const closedWith = new Promise(r => ws.on('close', code => r(code)));
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(Buffer.alloc(LAN_MAX_PAYLOAD + 1024, 1)); // one frame past the cap
    assert.equal(await closedWith, 1009);
  } finally { await link.stop(); }
  // The live-channel cap refuses extra sockets outright.
  const capped = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: null, keys, store: tmpStore(), proxy: stubProxy, maxChannels: 1});
  const fakeWs = () => { const e = new EventEmitter(); e.send = () => {}; e.close = code => { e.closedWith = code; }; return e; };
  assert.equal(capped.serveChannel(fakeWs()), true);
  const second = fakeWs();
  assert.equal(capped.serveChannel(second), false);
  assert.equal(second.closedWith, 4429);
});

test('link: UDP discovery answers only while a Wi-Fi pairing is open (audit #99)', {timeout: 30000}, async () => {
  const keys = {keys: {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}};
  keys.pcId = pcIdFor(keys.keys.relay.publicKey);
  // A free port, not 18735 + pid % 500 (t1 #6): parallel test files derive
  // the same port from nearby pids and collide.
  const discoveryPort = await new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    probe.once('error', reject);
    probe.bind(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: 0, discoveryPort, keys, store: tmpStore(), proxy: stubProxy});
  await link.start();
  // Poll until the UDP socket is actually bound instead of sleeping 100 ms.
  for (let i = 0; i < 100; i++) { try { link.discovery.address(); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
  const ask = () => new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, 400);
    sock.on('message', msg => { clearTimeout(timer); try { sock.close(); } catch {} resolve(msg.toString('utf8')); });
    sock.on('error', () => {});
    sock.send(Buffer.from('muser-link?'), discoveryPort, '127.0.0.1');
  });
  try {
    assert.equal(await ask(), null); // not pairing: silence, no pcId/address leak
    link.startPairing({mode: 'qr'});
    assert.equal(await ask(), null); // QR pairing carries its address in the QR itself
    link.startPairing({mode: 'wifi'});
    const reply = await ask();
    assert.ok(reply && reply.startsWith('muser-link! '), String(reply));
    assert.ok(reply.endsWith(' ' + keys.pcId), String(reply));
    link.stopPairing();
    assert.equal(await ask(), null);
  } finally { await link.stop(); }
});

function relayServer(t, onConn) {
  const wss = new WebSocket.WebSocketServer({host: '127.0.0.1', port: 0});
  wss.on('connection', onConn);
  return new Promise(resolve => wss.on('listening', () => {
    t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
    resolve({wss, url: 'ws://127.0.0.1:' + wss.address().port});
  }));
}
function controlLink(url, extra = {}) {
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: url, lanPort: null, keys: pcKeys(), store: tmpStore(), proxy: stubProxy, ...extra});
  link.stopped = false; // drive the control socket directly; start() would add LAN/discovery too
  return link;
}

test('link: a flapping relay backs off instead of reconnecting at the minimum forever (audit #100)', {timeout: 30000}, async t => {
  let attempts = 0;
  const {url} = await relayServer(t, ws => { attempts++; ws.close(); });
  const link = controlLink(url, {backoffMinMs: 50, backoffMaxMs: 400, controlHeartbeatMs: 0});
  link.connectControl();
  // Poll for the attempts instead of one fixed 900 ms window (t1 #5): on a
  // loaded machine the same backoff sequence simply takes longer.
  const deadline = Date.now() + 10000;
  while (attempts < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  await link.stop();
  assert.ok(attempts >= 3, `expected several attempts, got ${attempts}`);
  assert.ok(attempts <= 8, `backoff should stretch (50,100,200,400…), got ${attempts} attempts`);
});

test('link: a stale control socket closing does not replace the healthy one (audit #100)', {timeout: 30000}, async t => {
  const {url} = await relayServer(t, () => {});
  const link = controlLink(url, {controlHeartbeatMs: 0});
  link.connectControl();
  for (let i = 0; i < 100 && !link.controlOpen; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(link.controlOpen, true);
  const stale = link.control;
  const healthy = new WebSocket(url);
  await new Promise((res, rej) => { healthy.once('open', res); healthy.once('error', rej); });
  link.control = healthy;
  link.controlOpen = true;
  stale.close(); // the superseded socket's late close arrives now
  await new Promise(r => setTimeout(r, 150));
  assert.equal(link.control, healthy);
  assert.equal(link.controlOpen, true);
  assert.equal(link.reconnectTimer, null);
  healthy.close();
  await link.stop();
});

test('link: a silently dead relay control socket is detected and reconnected (audit #93)', {timeout: 30000}, async t => {
  let conns = 0;
  // Pausing the server socket simulates a NAT drop: the TCP connection looks
  // open on both ends, but no pong ever comes back.
  const {url} = await relayServer(t, ws => { conns++; ws._socket.pause(); });
  const link = controlLink(url, {controlHeartbeatMs: 25, controlTimeoutMs: 75, backoffMinMs: 20});
  link.connectControl();
  // Poll for the reconnect instead of a fixed 1200 ms sleep (t1 #5).
  const deadline = Date.now() + 10000;
  while (conns < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  await link.stop();
  assert.ok(conns >= 2, `the dead control socket should be terminated and reconnected, saw ${conns} connection(s)`);
});
