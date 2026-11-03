'use strict';
// One Noise channel, PC side (remote/DESIGN.md): the responder handshake, the
// pairing gate, then the tunnel protocol that proxies the phone's requests into the
// local serve. Carrier-agnostic — handleChannelSocket takes any WebSocket (a relay
// data socket or a LAN listener socket; both carry exactly one Noise transport
// message per binary frame).
//
// ctx = {keys, remoteStore, proxy, pairing, relayUrl, lanAddresses, onPairSuccess,
// onPairFailure}. `pairing` is link.js's live pairing object ({mode, code, expiresAt,
// attempts, burned, consumed}) or null; `keys` is loadOrCreateLinkKeys()'s result.
const os = require('node:os');
const crypto = require('node:crypto');

const HANDSHAKE_TIMEOUT_MS = 30000;
// One deadline for the WHOLE handshake (audit #94): retransmitted duplicates
// must not rewind the clock message by message, and duplicates are capped.
const MAX_HANDSHAKE_DUPLICATES = 32;
// An established channel that hears nothing for this long is dead, however
// politely its socket is still open (audit #98). Mirrors the relay's splice
// idle drop (ping every 30 s, drop at 90 s of silence).
const CHANNEL_IDLE_TIMEOUT_MS = 90000;
// Bounds for frames buffered while the consumer is busy (audit #91): a slow
// proxy request must not let an unauthenticated-or-paired peer queue frames
// without limit behind it.
const MAX_QUEUED_ITEMS = 256;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
// sendApp backpressure (audit #118): when the socket already holds more than
// this for a slow phone, stop queueing — events are dropped (a later snapshot
// supersedes them) and a reply that cannot be queued ends the channel so the
// phone reconnects and resyncs, instead of replies/events piling up in PC
// memory without limit.
const MAX_SEND_BUFFER_BYTES = 8 * 1024 * 1024;
// How long a finished-but-never-delivered request outcome is replayed to a
// reconnecting phone that resends the same request, instead of executing it
// a second time (audit #108). Matches the proxy/phone request timeout.
const REQ_REPLAY_WINDOW_MS = 30000;
const MAX_LEDGER_ENTRIES = 256;

// Tunnel ids correlate requests/subscriptions with their replies on the
// phone, which allocates them from one counter (audit #109): an id must be
// present and usable for correlation, or the message is not acted on at all —
// executing an uncorrelatable non-idempotent request is the worst outcome.
function validTunnelId(id) {
  return (Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && id.length > 0 && id.length <= 128);
}

// Proxy failures are classified for the phone, never relayed raw (audit
// #119): serve's internal error strings (addresses, socket codes) leak PC
// internals and give the phone no way to tell a retryable failure (serve
// never reached: nothing executed) from one where the request may already
// have executed (a timeout after the request was sent).
function classifyProxyError(err, method) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '');
  const idempotent = /^(GET|HEAD)$/i.test(String(method || 'GET'));
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ECONNREFUSED/.test(msg)) {
    return {status: 503, body: {error: 'serve unavailable', code: 'serve-unavailable', retryable: true, outcome: 'not-executed'}};
  }
  if (code === 'ETIMEDOUT' || /did not answer in time|timed? ?out/i.test(msg)) {
    return {status: 504, body: {error: 'serve timed out', code: 'serve-timeout', retryable: idempotent, outcome: 'unknown'}};
  }
  if (/response too large/i.test(msg)) {
    return {status: 502, body: {error: 'serve response too large', code: 'response-too-large', retryable: false, outcome: 'executed'}};
  }
  return {status: 502, body: {error: 'proxy request failed', code: 'proxy-failed', retryable: false, outcome: 'unknown'}};
}

// In-flight / undelivered request outcomes, shared by every channel that
// uses the same proxy (i.e. every channel of one Link), keyed by device +
// a fingerprint of the request itself (audit #108). A phone whose channel
// dies mid-request reconnects with a fresh id counter, so the id alone
// cannot identify a resend — method+path+body can. An identical request
// joins the original while it runs, and replays its outcome if the original
// finished but its reply never reached a live channel; once a reply HAS
// been delivered, the entry goes away and an identical later request is a
// new, intentional one.
const reqLedgers = new WeakMap();
function ledgerFor(proxy) {
  if (!proxy || (typeof proxy !== 'object' && typeof proxy !== 'function')) return new Map();
  let ledger = reqLedgers.get(proxy);
  if (!ledger) { ledger = new Map(); reqLedgers.set(proxy, ledger); }
  return ledger;
}
function requestFingerprint(method, path, body) {
  let bodyText;
  try { bodyText = JSON.stringify(body ?? null); } catch { bodyText = String(body); }
  return crypto.createHash('sha256').update(String(method || 'GET') + ' ' + String(path || '') + '\n' + bodyText).digest('hex');
}

// Accept the keys in loadOrCreateLinkKeys()'s shape, or a bare Noise pair.
function noiseKeyPair(keys) {
  const pair = keys?.keys?.noise || keys?.noise || keys;
  if (!pair || !Buffer.isBuffer(pair.publicKey) || !Buffer.isBuffer(pair.privateKey)) throw new Error('channel: ctx.keys has no Noise key pair');
  return pair;
}
function pcIdOf(ctx) { return ctx.keys?.pcId || ctx.pcId || null; }

function pairingActive(pairing) {
  return !!pairing && !pairing.burned && !pairing.consumed && (!pairing.expiresAt || pairing.expiresAt > Date.now());
}
// Wi-Fi pairing is guessable online, so attempts against it are counted on the
// pairing itself; at 5 the code is burned (link.js then requires a fresh
// startPairing). The attempt is debited when a connection STARTS, not when it
// fails: parallel sockets share the one budget, so a batch of simultaneous
// guesses cannot each spend from a fresh allowance (audit #88). QR codes are
// one-time secrets, not counted.
function notePairAttempt(pairing) {
  if (pairing && pairing.mode === 'wifi') {
    pairing.attempts = (pairing.attempts || 0) + 1;
    if (pairing.attempts >= 5) pairing.burned = true;
  }
}
function notePairFailure(ctx) {
  try { ctx.onPairFailure?.(); } catch {}
}
function notePairSuccess(ctx) {
  const p = ctx.pairing;
  if (p) p.consumed = true;
  try { ctx.onPairSuccess?.(); } catch {}
}
function codeMatches(given, expected) {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// Awaitable queue over the socket's message events; one consumer, in order, because
// Noise transport messages are strictly sequential.
function messageQueue(ws) {
  const items = [], waiters = [];
  let closed = false, queuedBytes = 0;
  const queue = {
    timedOut: false, // set when the last next() gave up waiting (vs a close)
    overflowed: false,
    next(timeoutMs) {
      queue.timedOut = false;
      if (items.length) { const item = items.shift(); if (item) queuedBytes -= item.data.length; return Promise.resolve(item); }
      if (closed) return Promise.resolve(null);
      return new Promise(resolve => {
        const w = item => { clearTimeout(timer); resolve(item); };
        const timer = timeoutMs ? setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); queue.timedOut = true; resolve(null); }, timeoutMs) : null;
        timer?.unref?.();
        waiters.push(w);
      });
    },
  };
  const deliver = item => { const w = waiters.shift(); if (w) w(item); else items.push(item); };
  const overflow = () => {
    // Drop everything buffered, settle any waiter as closed, and kill the
    // socket: the peer is flooding faster than this channel can consume.
    queue.overflowed = true;
    closed = true;
    items.length = 0;
    queuedBytes = 0;
    while (waiters.length) waiters.shift()(null);
    try { if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(1009); } catch {}
  };
  ws.on('message', data => {
    if (closed) return;
    const item = {data: Buffer.isBuffer(data) ? data : Buffer.from(data)};
    if (waiters.length) { deliver(item); return; }
    if (items.length >= MAX_QUEUED_ITEMS || queuedBytes + item.data.length > MAX_QUEUED_BYTES) { overflow(); return; }
    queuedBytes += item.data.length;
    items.push(item);
  });
  ws.on('close', () => { closed = true; deliver(null); });
  ws.on('error', () => {}); // 'close' follows and settles the queue
  return queue;
}

async function handleChannelSocket(ws, ctx) {
  const noise = require('./noise'); // lazy: the module lands with the channel work
  const queue = messageQueue(ws);
  const subs = new Map(); // tunnel id -> close function
  const closeSubs = () => { for (const close of subs.values()) { try { close(); } catch {} } subs.clear(); };
  // Channel liveness for senders and in-flight work (audit #108): once the
  // socket is gone, replies must not be attempted on it (an outcome that
  // could not be delivered stays replayable for a resend). Each in-flight
  // request registers an orphan check here: when the LAST channel waiting
  // on a shared-ledger entry goes away, the entry's AbortController fires —
  // a proxy that honours the signal cancels the serve request outright; one
  // that ignores it is still covered by the ledger, which joins a resend to
  // the running original instead of executing it a second time.
  let channelClosed = false;
  const aborters = new Set();
  ws.on('close', () => {
    channelClosed = true;
    closeSubs();
    for (const a of aborters) { try { a.abort(); } catch {} }
    aborters.clear();
  });
  const close = (code = 1008) => { channelClosed = true; closeSubs(); try { ws.close(code); } catch {} };

  const pairing = pairingActive(ctx.pairing) ? ctx.pairing : null;
  if (pairing) notePairAttempt(pairing); // a Wi-Fi attempt is spent by arriving, not by failing
  let conn, hsMsg1 = null, hsMsg2 = null, hsMsg3 = null;
  try {
    const options = {pattern: pairing?.mode === 'wifi' ? 'XXpsk3' : 'XX', initiator: false, staticKeyPair: noiseKeyPair(ctx.keys)};
    if (options.pattern === 'XXpsk3') options.psk = noise.pskFromCode(pairing.code);
    conn = new noise.NoiseConnection(options);
    // The timeout is a single overall deadline, not a per-message allowance
    // that every retransmit rewinds (audit #94); duplicates are tolerated
    // (carriers burst them) but capped.
    const handshakeTimeoutMs = ctx.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;
    const handshakeStartedAt = Date.now();
    let duplicates = 0;
    while (!conn.handshakeFinished) {
      const remaining = handshakeTimeoutMs - (Date.now() - handshakeStartedAt);
      if (remaining <= 0) { close(); return {ok: false, reason: 'handshake-timeout'}; }
      const item = await queue.next(remaining);
      if (!item) { close(); return {ok: false, reason: queue.timedOut ? 'handshake-timeout' : 'closed-during-handshake'}; }
      // Retransmit tolerance: over the relay, the phone resends message 1 until
      // it sees message 2 (the splice is asynchronous), and carriers may deliver
      // the queued copies in a burst. A duplicate message 1 must not be fed to
      // the Noise state as if it were message 3 — answer it with the cached
      // message 2 again and keep waiting.
      if (hsMsg1 && item.data.equals(hsMsg1)) {
        duplicates += 1;
        if (duplicates > MAX_HANDSHAKE_DUPLICATES) { close(); return {ok: false, reason: 'handshake-duplicates'}; }
        if (hsMsg2) ws.send(hsMsg2);
        continue;
      }
      if (!hsMsg1) hsMsg1 = item.data; else hsMsg3 = item.data;
      conn.readMessage(item.data);
      if (!conn.handshakeFinished) { hsMsg2 = conn.writeMessage(Buffer.alloc(0)); ws.send(hsMsg2); }
    }
  } catch (e) {
    if (pairing) notePairFailure(ctx);
    close();
    return {ok: false, reason: 'handshake-failed', error: e};
  }

  const remoteStatic = conn.remoteStatic ? Buffer.from(conn.remoteStatic) : null;
  if (!remoteStatic) { close(); return {ok: false, reason: 'no-remote-static'}; }

  // Application framing: each application message is JSON, split by encodeFrames;
  // every frame travels as exactly one Noise transport message.
  const decoder = new noise.FrameDecoder();
  const sendBufferLimit = ctx.sendBufferLimitBytes ?? MAX_SEND_BUFFER_BYTES;
  // Returns true only when the message was handed to the socket. Backpressure
  // (audit #118): a socket already holding more than the limit for a slow
  // phone gets no more queued behind it — 'ev' snapshots are dropped (the
  // next one supersedes them, and the phone resyncs on reconnect), anything
  // else ends the channel with 1009 so the phone reconnects instead of this
  // PC buffering replies without limit.
  const sendApp = obj => {
    if (channelClosed) return false;
    let payload;
    try { payload = Buffer.from(JSON.stringify(obj), 'utf8'); } catch { return false; }
    const buffered = typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
    if (buffered > sendBufferLimit) {
      if (obj && obj.t === 'ev') return false;
      close(1009);
      return false;
    }
    try {
      const frames = noise.encodeFrames(payload);
      for (const frame of frames) ws.send(conn.writeTransport(frame));
      return true;
    } catch { return false; }
  };
  // Transport-level failures are tracked separately from a clean close
  // (audit #102): an AEAD failure or a malformed/oversized frame must end
  // the channel as {ok:false}, not be reported as a normal {ok:true} end,
  // and a decoder throw must not escape past the pairing failure accounting.
  let transportFailure = null;
  const APP_TIMEOUT = Symbol('app-timeout');
  const nextApp = async timeoutMs => {
    for (;;) {
      const item = await queue.next(timeoutMs);
      if (!item) return queue.timedOut ? APP_TIMEOUT : null;
      // Retransmitted handshake messages are not transport (audit #95):
      // message 3 was already exempted; a late duplicate message 1 (the
      // phone resends it until message 2 lands, and the copies can arrive
      // after the handshake finished) must be skipped too — feeding it to
      // readTransport fails AEAD and kills a just-established channel.
      if (hsMsg1 && item.data.equals(hsMsg1)) continue;
      if (hsMsg3 && item.data.equals(hsMsg3)) continue;
      let plain;
      try { plain = conn.readTransport(item.data); } catch { transportFailure = 'aead-failed'; return null; }
      let whole;
      try { whole = decoder.push(plain); } catch (e) { transportFailure = /exceeds/.test(String(e?.message || e)) ? 'frame-too-large' : 'bad-frame'; return null; }
      if (whole === null || whole === undefined) continue;
      try { return JSON.parse(whole.toString('utf8')); } catch { return {t: '__bad__'}; }
    }
  };

  let device = null;
  if (pairing) {
    const first = await nextApp(ctx.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS);
    if (first === APP_TIMEOUT) { notePairFailure(ctx); close(); return {ok: false, reason: 'pair-timeout'}; }
    if (!first || first.t !== 'pair') { notePairFailure(ctx); close(); return {ok: false, reason: transportFailure || 'expected-pair'}; }
    if (pairing.mode === 'qr' && !codeMatches(first.code, pairing.code)) {
      try { sendApp({t: 'pair-failed', error: 'bad code'}); } catch {}
      notePairFailure(ctx);
      close();
      return {ok: false, reason: 'bad-code'};
    }
    // Wi-Fi mode needs no code check: finishing an XXpsk3 handshake already proved
    // the phone knows the code (the PSK is derived from it).
    // The pairing was captured when this socket connected; a concurrent connection
    // may have claimed it since, and one code pairs exactly one phone. Re-check
    // before the device is stored (audit #87) — no await between this check and
    // notePairSuccess, so the claim cannot interleave with another connection's.
    if (pairing.consumed || (pairing.expiresAt && pairing.expiresAt <= Date.now())) {
      try { sendApp({t: 'pair-failed', error: 'pairing already used'}); } catch {}
      close();
      return {ok: false, reason: 'pairing-consumed'};
    }
    try { device = ctx.remoteStore.add({name: first.name || 'phone', staticPub: remoteStatic}); }
    catch (e) { close(); return {ok: false, reason: 'store-failed', error: e}; }
    notePairSuccess(ctx);
    sendApp({t: 'paired', device: {id: device.id, name: device.name}, pc: {name: os.hostname(), pcId: pcIdOf(ctx), relay: ctx.relayUrl || null, lan: ctx.lanAddresses || []}});
  } else {
    device = ctx.remoteStore.findByStatic(remoteStatic);
    if (!device) { close(4403); return {ok: false, reason: 'unpaired'}; }
  }
  try { ctx.remoteStore.touch(device.id); } catch {} // lastSeen, on connect

  // Requests are dispatched, not awaited in the loop (audit #104): one slow
  // serve request (up to the proxy's 30 s) must not park ping/pong and every
  // other message behind it. Responses are correlated by id, so answering
  // out of order is safe; sendApp itself is synchronous per message, so
  // transport nonces cannot interleave.
  const pendingReqs = new Set();
  const reqIdsInFlight = new Set(); // tunnel ids with a request running on THIS channel (audit #109)
  const idleTimeoutMs = ctx.channelIdleTimeoutMs ?? CHANNEL_IDLE_TIMEOUT_MS;
  for (;;) {
    const msg = await nextApp(idleTimeoutMs || undefined);
    if (msg === APP_TIMEOUT) { close(); return {ok: false, reason: 'idle-timeout', device}; }
    if (!msg) break;
    if (msg.t === 'ping') { sendApp({t: 'pong'}); continue; }
    if (msg.t === 'req') {
      // An id that cannot correlate a reply, or one this channel is already
      // answering, is not acted on (audit #109): executing an uncorrelatable
      // or duplicate non-idempotent request is the worst outcome.
      if (!validTunnelId(msg.id)) continue;
      if (reqIdsInFlight.has(msg.id)) continue;
      reqIdsInFlight.add(msg.id);
      const run = (async () => {
        // Dedupe across channels (audit #108): an identical request from the
        // same device joins the outcome already in flight in the shared
        // ledger, and replays it when the original finished but its reply
        // never reached a live channel — it is never executed twice. Once a
        // reply HAS been delivered the entry is gone, so a later identical
        // request is a new, intentional one.
        const ledger = ledgerFor(ctx.proxy);
        const key = (device?.id || '') + '|' + requestFingerprint(msg.method, msg.path, msg.body);
        const replayWindowMs = ctx.reqReplayWindowMs ?? REQ_REPLAY_WINDOW_MS;
        let entry = ledger.get(key);
        if (entry && (entry.aborted || entry.delivered || (entry.settled && Date.now() - entry.settledAt > replayWindowMs))) {
          ledger.delete(key);
          entry = null;
        }
        if (!entry) {
          entry = {settled: false, delivered: false, aborted: false, settledAt: 0, result: null, listeners: new Set(), controller: null, promise: null};
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          entry.controller = controller;
          entry.promise = (async () => {
            try {
              const out = await ctx.proxy.request({method: msg.method, path: msg.path, body: msg.body, ...(controller ? {signal: controller.signal} : {})});
              return {status: typeof out?.status === 'number' ? out.status : 502, body: out?.body ?? null};
            } catch (e) {
              // A request cancelled because its last interested channel went
              // away (below) has no outcome worth replaying: a resend must
              // execute it fresh, not inherit a phantom failure.
              if (controller?.signal?.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
                entry.aborted = true;
                return null;
              }
              // Failures are classified for the phone, never relayed raw
              // (audit #119).
              return classifyProxyError(e, msg.method);
            }
          })();
          entry.promise.then(result => {
            entry.settled = true;
            entry.result = result;
            entry.settledAt = Date.now();
            if (entry.aborted && ledger.get(key) === entry) ledger.delete(key);
          });
          ledger.set(key, entry);
          while (ledger.size > MAX_LEDGER_ENTRIES) {
            const oldest = ledger.keys().next().value;
            if (oldest === key) break;
            ledger.delete(oldest);
          }
        }
        // This channel's interest in the entry: the proxy request is aborted
        // only when EVERY channel waiting on it has gone away, so a resend
        // that joined from a fresh channel keeps the original running.
        const listener = {};
        entry.listeners.add(listener);
        const orphanCheck = {abort() {
          entry.listeners.delete(listener);
          if (!entry.settled && entry.listeners.size === 0) { try { entry.controller?.abort(); } catch {} }
        }};
        aborters.add(orphanCheck);
        let out;
        try { out = await entry.promise; } finally { aborters.delete(orphanCheck); }
        if (entry.aborted || out === null) return; // cancelled: no reply, no replay
        const delivered = sendApp({t: 'res', id: msg.id, status: out.status, body: out.body ?? null});
        if (delivered) {
          entry.delivered = true;
          if (ledger.get(key) === entry) ledger.delete(key);
        }
      })();
      pendingReqs.add(run);
      run.finally(() => { pendingReqs.delete(run); reqIdsInFlight.delete(msg.id); });
      continue;
    }
    if (msg.t === 'sub') {
      if (!validTunnelId(msg.id)) continue;
      // A duplicate id keeps the original subscription (audit #109): the new
      // one is not opened, and the original is not silently replaced.
      if (subs.has(msg.id)) continue;
      let closeSub = null;
      let failedBeforeOpen = false;
      const onSubError = () => {
        // Subscription failures reach the phone (audit #113): it must learn
        // the stream is gone so it can resubscribe / resync, instead of
        // believing it is still subscribed while serve has moved on. Only a
        // generic reason is sent — proxy error strings carry PC internals.
        // A stale error must not remove or report over a replacement: the
        // proxy never calls this after close(), and the identity check
        // covers errors raised before the close function was stored.
        if (closeSub !== null && subs.get(msg.id) !== closeSub) return;
        if (closeSub === null) failedBeforeOpen = true;
        subs.delete(msg.id);
        sendApp({t: 'sub-failed', id: msg.id, error: 'subscription ended', code: 'subscription-ended'});
      };
      try {
        closeSub = ctx.proxy.openSubscription(msg.path, (event, dataString) => {
          let data = dataString;
          try { data = JSON.parse(dataString); } catch {}
          sendApp({t: 'ev', id: msg.id, event, data});
        }, onSubError);
      } catch { onSubError(); }
      if (failedBeforeOpen) { try { closeSub?.(); } catch {} }
      else if (typeof closeSub === 'function') subs.set(msg.id, closeSub);
      continue;
    }
    if (msg.t === 'unsub') {
      if (!validTunnelId(msg.id)) continue;
      const closeSub = subs.get(msg.id);
      if (closeSub) { try { closeSub(); } catch {} subs.delete(msg.id); }
      continue;
    }
    // Unknown tunnel messages are ignored, not fatal: a newer app must not kill the
    // channel by asking for something this PC does not know yet.
  }
  close(); // the handler is done with this socket in every exit path
  if (transportFailure) return {ok: false, reason: transportFailure, device};
  if (queue.overflowed) return {ok: false, reason: 'queue-overflow', device};
  return {ok: true, device};
}

module.exports = {handleChannelSocket, pairingActive, messageQueue, HANDSHAKE_TIMEOUT_MS, CHANNEL_IDLE_TIMEOUT_MS, MAX_QUEUED_ITEMS, MAX_QUEUED_BYTES};
