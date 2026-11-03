'use strict';
// muser link, PC side (remote/DESIGN.md): while serve runs, the PC holds
//   (a) a relay control socket — outbound only, so no port is opened for the WAN;
//       the relay asks over it when a paired phone wants a channel, and each such
//       channel gets its own outbound data socket;
//   (b) a LAN WebSocket listener for the same channel, direct at home;
//   (c) at most one live pairing (QR one-time code, or Wi-Fi code-as-PSK), for five
//       minutes or until one phone pairs.
// Every channel socket, whichever carrier brought it, is handed to channel-server.
const os = require('node:os');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const WebSocket = require('ws');
const {loadOrCreateLinkKeys, signRelay, pcIdFor} = require('./keys');
const remoteStore = require('./remote-store');
const {createProxy} = require('./proxy');
const {handleChannelSocket, pairingActive} = require('./channel-server');

const DEFAULT_LAN_PORT = 8734;
const DISCOVERY_PORT = 8735; // Wi-Fi pairing discovery (the app broadcasts 'muser-link?')
const PAIRING_TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: a code is read aloud and typed
const BACKOFF_MIN_MS = 1000, BACKOFF_MAX_MS = 30000;
// A Noise transport message is at most 65535 bytes on the wire; the LAN
// listener has no reason to buffer anything bigger (audit #90 — the ws
// default is 100 MiB, offered to unauthenticated LAN hosts).
const LAN_MAX_PAYLOAD = 64 * 1024 + 1024;
const MAX_CHANNELS = 32; // concurrent channel sockets, LAN + relay data together
// Relay control heartbeat (audit #93): ping every 30 s and treat the socket
// as dead after 90 s without a pong/message — a silently dropped NAT mapping
// otherwise leaves relayConnected stuck at true and no reconnect is tried.
const CONTROL_HEARTBEAT_MS = 30000, CONTROL_TIMEOUT_MS = 90000;
// A control connection earns a backoff reset only by surviving this long
// (audit #100): resetting on 'open', before authentication has had a chance
// to fail, made a flapping relay reconnect about once a second forever.
const CONTROL_STABLE_MS = 10000;
// Domain separation for the relay Ed25519 key (audit #103): the relay
// verifies two different signatures with the same key — control-socket
// auth over a random 32-byte challenge, and data-socket auth over a cid
// (also 32 hex chars, 32 bytes as signed). Without a context prefix the
// two payloads are interchangeable and a signature for one purpose could
// be replayed for the other. These exact byte strings are prefixed on
// the relay side too (remote/relay/index.js) — the two must change
// together or relay authentication breaks.
const RELAY_CONTROL_AUTH_CONTEXT = Buffer.from('muser-relay:v1:control-auth:', 'utf8');
const RELAY_DATA_CID_CONTEXT = Buffer.from('muser-relay:v1:data-cid:', 'utf8');

function makeCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
function relayJoin(relayUrl, suffix) { return String(relayUrl).replace(/\/+$/, '') + suffix; }
// The keys may arrive as loadOrCreateLinkKeys()'s result ({keys, pcId}), as that
// result before its pcId was attached, or as a bare {noise, relay} pair set.
function normalizeKeys(keys) {
  if (keys.keys) return keys.pcId ? keys : {keys: keys.keys, pcId: pcIdFor(keys.keys.relay.publicKey)};
  return {keys, pcId: pcIdFor(keys.relay.publicKey)};
}
// The relay's {challenge} is an encoded byte string in JSON; the signature is over
// the RAW bytes, so decode base64/base64url when the value has that shape, and only
// fall back to the text bytes for a plainly textual challenge.
function challengeBytes(challenge) {
  if (Buffer.isBuffer(challenge)) return challenge;
  if (challenge instanceof Uint8Array) return Buffer.from(challenge);
  const s = String(challenge ?? '');
  if (/^[A-Za-z0-9_-]+$/.test(s) && s.length % 4 !== 1) { try { return Buffer.from(s, 'base64url'); } catch {} }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) { try { return Buffer.from(s, 'base64'); } catch {} }
  return Buffer.from(s, 'utf8');
}

class Link {
  constructor({serve, relayUrl = null, lanPort = DEFAULT_LAN_PORT, keys = null, store = null, proxy = null, discoveryPort = DISCOVERY_PORT, maxChannels = MAX_CHANNELS, backoffMinMs = BACKOFF_MIN_MS, backoffMaxMs = BACKOFF_MAX_MS, controlHeartbeatMs = CONTROL_HEARTBEAT_MS, controlTimeoutMs = CONTROL_TIMEOUT_MS} = {}) {
    if (!serve || !serve.port || !serve.token) throw new Error('link: {serve: {port, token}} is required');
    this.serve = serve;
    this.relayUrl = relayUrl;
    this.lanPort = lanPort;
    this.discoveryPort = discoveryPort;
    this.maxChannels = maxChannels;
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.controlHeartbeatMs = controlHeartbeatMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.discovery = null;
    this.keysResult = keys ? normalizeKeys(keys) : null;
    this.remoteStore = store || remoteStore;
    this.proxy = proxy || createProxy({port: serve.port, token: serve.token});
    this.pairing = null;
    this.lanServer = null;
    this.control = null; // relay control WebSocket
    this.controlOpen = false;
    this.dataSockets = new Set();
    this.channels = new Set(); // live carrier sockets (LAN + relay data)
    this.backoffMs = backoffMinMs;
    this.reconnectTimer = null;
    this.controlHeartbeat = null;
    this.stopped = true;
  }

  get keys() { return this.keysResult?.keys || null; }
  get pcId() { return this.keysResult?.pcId || null; }

  lanAddresses() {
    const port = this.lanServer?.address?.()?.port ?? this.lanPort;
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address + ':' + port);
    }
    return out;
  }

  channelCtx() {
    return {
      keys: this.keysResult,
      remoteStore: this.remoteStore,
      proxy: this.proxy,
      pairing: pairingActive(this.pairing) ? this.pairing : null,
      relayUrl: this.relayUrl,
      lanAddresses: this.lanAddresses(),
      onPairSuccess: () => { if (this.pairing) this.pairing = null; },
    };
  }
  serveChannel(ws) {
    // Connection cap (audit #90): the LAN listener is unauthenticated until
    // a Noise handshake completes, so live channels must be bounded.
    if (this.channels.size >= this.maxChannels) { try { ws.close(4429); } catch {} return false; }
    this.channels.add(ws);
    ws.on('close', () => this.channels.delete(ws));
    handleChannelSocket(ws, this.channelCtx()).catch(() => { try { ws.close(); } catch {} });
    return true;
  }

  // --- pairing -------------------------------------------------------------
  startPairing({mode = 'qr'} = {}) {
    if (mode !== 'qr' && mode !== 'wifi') throw new Error('link: pairing mode must be qr or wifi');
    const code = makeCode();
    this.pairing = {mode, code, expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0, burned: false, consumed: false};
    return {code, expiresAt: this.pairing.expiresAt};
  }
  stopPairing() { this.pairing = null; }
  activePairing() { return pairingActive(this.pairing) ? this.pairing : null; }

  // --- relay ---------------------------------------------------------------
  connectControl() {
    if (this.stopped || !this.relayUrl) return;
    // Never stack a second control socket over a live/connecting one
    // (audit #100): a late reconnect would replace the healthy socket.
    if (this.control && (this.control.readyState === WebSocket.OPEN || this.control.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try { ws = new WebSocket(relayJoin(this.relayUrl, '/pc')); } catch { this.scheduleReconnect(); return; }
    this.control = ws;
    let openedAt = 0, lastSeenAt = 0, retried = false;
    const stopHeartbeat = () => { if (this.controlHeartbeat) { clearInterval(this.controlHeartbeat); this.controlHeartbeat = null; } };
    ws.on('open', () => {
      if (this.control !== ws) return;
      this.controlOpen = true;
      openedAt = lastSeenAt = Date.now();
      // Heartbeat (audit #93): a control socket whose peer silently vanished
      // (NAT drop) never emits 'close'; ping it and declare it dead when
      // nothing — pong or message — has come back for controlTimeoutMs.
      // Terminating it runs the normal close -> reconnect path.
      stopHeartbeat();
      if (this.controlHeartbeatMs > 0) {
        this.controlHeartbeat = setInterval(() => {
          if (this.control !== ws) { stopHeartbeat(); return; }
          if (Date.now() - lastSeenAt > this.controlTimeoutMs) { try { ws.terminate(); } catch {} return; }
          try { ws.ping(); } catch {}
        }, this.controlHeartbeatMs);
        this.controlHeartbeat.unref?.();
      }
    });
    ws.on('pong', () => { lastSeenAt = Date.now(); });
    ws.on('message', data => {
      lastSeenAt = Date.now();
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.challenge !== undefined) {
        const sig = signRelay(this.keys.relay, Buffer.concat([RELAY_CONTROL_AUTH_CONTEXT, challengeBytes(msg.challenge)]));
        try { ws.send(JSON.stringify({pcId: this.pcId, pub: this.keys.relay.publicKey.toString('base64url'), sig: sig.toString('base64url')})); } catch {}
        return;
      }
      if (typeof msg.open === 'string' && msg.open) this.openDataSocket(msg.open);
    });
    const retry = () => {
      if (retried) return;
      retried = true;
      // A stale socket's late close must not tear down or replace the
      // healthy control socket that superseded it (audit #100).
      if (this.control !== ws) return;
      stopHeartbeat();
      this.control = null;
      this.controlOpen = false;
      // Backoff resets only for a connection that actually lived (audit
      // #100); one that flapped during authentication keeps backing off.
      if (openedAt && Date.now() - openedAt >= CONTROL_STABLE_MS) this.backoffMs = this.backoffMinMs;
      this.scheduleReconnect();
    };
    ws.on('close', retry);
    ws.on('error', () => {}); // 'close' follows and drives the reconnect
  }
  scheduleReconnect() {
    if (this.stopped || !this.relayUrl || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectControl(); }, delay);
    this.reconnectTimer.unref?.();
  }
  openDataSocket(cid) {
    const url = relayJoin(this.relayUrl, '/a?pc=' + encodeURIComponent(this.pcId) + '&cid=' + encodeURIComponent(cid));
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this.dataSockets.add(ws);
    this.serveChannel(ws); // attach before 'open' so no early Noise frame is missed; the channel sends nothing first
    ws.on('open', () => {
      // First frame: prove this socket is the PC the relay just asked for, by
      // signing the cid (with the data-cid context prefix, audit #103),
      // before any Noise bytes cross it.
      const sig = signRelay(this.keys.relay, Buffer.concat([RELAY_DATA_CID_CONTEXT, Buffer.from(cid, 'utf8')]));
      try { ws.send(JSON.stringify({sig: sig.toString('base64url')})); } catch {}
    });
    ws.on('close', () => this.dataSockets.delete(ws));
    ws.on('error', () => {});
  }

  // --- lifecycle -------------------------------------------------------------
  async start() {
    if (!this.keysResult) this.keysResult = loadOrCreateLinkKeys();
    this.stopped = false;
    if (this.lanPort !== null && this.lanPort !== undefined) { // 0 = an ephemeral port; null = no LAN listener
      await new Promise((resolve, reject) => {
        const server = new WebSocket.WebSocketServer({host: '0.0.0.0', port: this.lanPort, maxPayload: LAN_MAX_PAYLOAD});
        server.once('error', reject);
        server.on('listening', () => { server.removeListener('error', reject); this.lanServer = server; resolve(); });
        server.on('connection', ws => this.serveChannel(ws));
      });
    }
    if (this.lanPort !== null && this.lanPort !== undefined && this.discoveryPort) {
      // Wi-Fi pairing discovery: the app broadcasts 'muser-link?' (UDP 8735);
      // answer with this PC's first LAN channel address and pcId so it can
      // open the XXpsk3 channel. The code itself never crosses UDP.
      try {
        const sock = dgram.createSocket('udp4');
        sock.on('error', () => {});
        sock.on('message', (msg, rinfo) => {
          if (msg.toString('utf8').trim() !== 'muser-link?') return;
          // Answer only while a Wi-Fi pairing is actually open (audit #99):
          // answering always would hand every LAN host this PC's pcId (the
          // target id for relay abuse) and its internal addresses, forever.
          // QR pairing does not need discovery — the QR carries the address.
          const pairing = this.activePairing();
          if (!pairing || pairing.mode !== 'wifi') return;
          const lan = this.lanAddresses()[0];
          if (!lan) return;
          try { sock.send(Buffer.from('muser-link! ' + lan + ' ' + this.pcId, 'utf8'), rinfo.port, rinfo.address); } catch {}
        });
        sock.bind(this.discoveryPort, '0.0.0.0');
        this.discovery = sock;
      } catch {}
    }
    this.connectControl();
    return this.state();
  }
  async stop() {
    this.stopped = true;
    if (this.controlHeartbeat) { clearInterval(this.controlHeartbeat); this.controlHeartbeat = null; }
    if (this.discovery) { try { this.discovery.close(); } catch {} this.discovery = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const ws of [...this.dataSockets]) { try { ws.close(); } catch {} }
    this.dataSockets.clear();
    for (const ws of [...this.channels]) { try { ws.close(); } catch {} }
    if (this.control) { try { this.control.close(); } catch {} this.control = null; this.controlOpen = false; }
    if (this.lanServer) { const s = this.lanServer; this.lanServer = null; await new Promise(r => { try { s.close(() => r()); } catch { r(); } }); }
  }

  state() {
    const p = this.activePairing();
    return {
      pcId: this.pcId,
      relayUrl: this.relayUrl,
      relayConnected: this.controlOpen,
      lanPort: this.lanServer?.address?.()?.port ?? this.lanPort ?? null,
      lan: this.lanAddresses(),
      channels: this.channels.size,
      pairing: p ? {mode: p.mode, code: p.code, expiresAt: p.expiresAt, attempts: p.attempts || 0} : null,
      pairingBurned: !!this.pairing?.burned,
      devices: this.remoteStore.list(),
    };
  }
}

// The QR payload (remote/DESIGN.md): everything the phone needs to find this
// PC and prove the pairing — relay, pcId, the PC's Noise static public key,
// the one-time code, the PC's name, and the first LAN address when listening.
function buildPairPayload({pcId, staticPub, relay, code, name, lan}) {
  const q = new URLSearchParams();
  q.set('v', '2');
  if (relay) q.set('r', relay);
  q.set('pc', pcId);
  q.set('k', Buffer.from(staticPub).toString('base64url'));
  q.set('c', code);
  if (name) q.set('n', name);
  if (lan && lan.length) q.set('l', lan[0]);
  return 'muser://pair?' + q.toString();
}

module.exports = {Link, DEFAULT_LAN_PORT, DISCOVERY_PORT, makeCode, challengeBytes, relayJoin, buildPairPayload, LAN_MAX_PAYLOAD, MAX_CHANNELS};
