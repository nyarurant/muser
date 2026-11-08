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
// How long a finished request outcome is replayed to a reconnecting phone
// that resends the same request, instead of executing it a second time
// (audit #108; wave18: delivery is never confirmed — the protocol has no
// acknowledgement — so a reply merely handed to a socket still counts as
// undelivered once its channel dies). Matches the proxy/phone request timeout.
const REQ_REPLAY_WINDOW_MS = 30000;
const MAX_LEDGER_ENTRIES = 256;
// An in-flight ledger entry whose proxy request ignores the abort signal
// and never settles must not lock its fingerprint forever (deep audit c23
// #3): past this age a resend stops joining it and executes fresh. The real
// proxy answers or times out within 30 s (proxy.js REQUEST_TIMEOUT_MS), so
// three windows of grace still leave genuinely stuck entries to expire.
const REQ_IN_FLIGHT_TIMEOUT_MS = 90000;

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

// Channel allowlist (first audit #6): a paired phone is a remote control for
// ONE conversation, not a second local operator. The tunnel may only reach
// the ordinary serve API the phone actually uses — per-conversation routes
// (bare or under /api/s/:id/) and the session list/open/close routes. Server
// administration is NEVER reachable through a channel: everything under
// /api/server/ (events, stop, link pair/revoke) is denied, as is any other
// path or method, so a stolen phone cannot mint a new pairing, stop the
// server, or revoke other devices through the tunnel.
// The one server-level exception is GET /api/server itself (android-ui):
// a read-only standing view the GUI also uses — version, the open
// conversations and the accounts — whose link section is already sanitised
// by gui-server (no pairing code, no device static keys). Only the exact
// GET passes; every sub-path and every other method stays denied.
function channelPathname(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) return null;
  // Dot segments in ANY encoding are refused outright: URL parsing silently
  // normalises %2e%2e away, which must never smuggle a path past the rules.
  for (const seg of rawPath.split(/[?#]/)[0].split('/')) {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { return null; }
    if (decoded === '.' || decoded === '..') return null;
  }
  let p;
  try { p = new URL(rawPath, 'http://channel.invalid').pathname; } catch { return null; }
  try { p = decodeURIComponent(p); } catch { return null; }
  if (p.includes('\\') || p.split('/').includes('..')) return null;
  return p;
}
const CHANNEL_REQ_RULES = [
  ['GET', /^\/api\/(?:s\/[^/]+\/)?(?:state|events|complete|changes|muse-avatar|outputs|entries|image)$/],
  ['POST', /^\/api\/(?:s\/[^/]+\/)?(?:send|approval|mode|menu|limit|interrupt|shell-kill|account|prompt)$/],
  // app-ui: account management from the phone (the GUI runs the CLI for these).
  ['GET', /^\/api\/accounts$/],
  ['POST', /^\/api\/accounts\/(?:default|auto|rename|remove)$/],
  ['GET', /^\/api\/sessions$/],
  ['POST', /^\/api\/sessions$/],
  ['GET', /^\/api\/server$/],
  ['GET', /^\/api\/ui-config$/], // app-ux: the GUI theme, read-only like /api/server
  ['POST', /^\/api\/sessions\/[^/]+\/(?:open|close)$/],
];
function isAllowedChannelRequest(method, rawPath) {
  const p = channelPathname(rawPath);
  if (!p) return false;
  // Everything UNDER /api/server/ is administration and always denied;
  // the exact path falls through to the rules (GET only, see above).
  if (p.startsWith('/api/server/')) return false;
  // The allowlist governs the serve API namespace: gui-server routes ONLY
  // /api/* (anything else falls through to its 404), so a path outside /api/
  // names no serve capability at all and the proxy's 404 is the whole story.
  // Inside /api/, only the rules above may pass.
  if (!p.startsWith('/api/')) return true;
  const m = String(method || '').toUpperCase();
  return CHANNEL_REQ_RULES.some(([mm, re]) => mm === m && re.test(p));
}
function isAllowedChannelSubscription(rawPath) {
  const p = channelPathname(rawPath);
  if (!p) return false;
  if (!p.startsWith('/api/')) return true; // as above: no serve route exists there
  // Only the per-conversation SSE stream; /api/server/events never matches.
  return /^\/api\/(?:s\/[^/]+\/)?events$/.test(p);
}

// In-flight / undelivered request outcomes, shared by every channel that
// uses the same proxy (i.e. every channel of one Link), keyed by device +
// a fingerprint of the request itself (audit #108). A phone whose channel
// dies mid-request reconnects with a fresh id counter, so the id alone
// cannot identify a resend — method+path+body can. An identical request
// joins the original while it runs, and replays its outcome if the original
// finished but its reply never reached a live channel. A reply handed to a
// socket is NOT known to have been delivered — the protocol carries no
// acknowledgement — so the entry survives its send for the replay window
// (wave18): if every channel it was sent on dies, the delivery is treated
// as unknown (deliveryUnknown, like the outcome:'unknown' classification
// below) and a resend replays the stored outcome instead of executing a
// second time. Only a repeat on the very channel that received the reply,
// while that channel lives, counts as a new, intentional request.
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
// Ledger eviction (deep audit c23 #2): only an entry whose loss cannot
// cause a second execution may be evicted — an aborted leftover, or a
// settled entry whose replay window has already closed. A merely SENT
// entry is not evictable either (wave18): with no acknowledgement its
// delivery is unconfirmed, so inside its window it is exactly like an
// undelivered entry — dropping it reopens the double execution if the
// channel died before the flush. An in-flight
// entry, and a settled-but-undelivered entry still inside its replay
// window, are never dropped to make room: a resend that found them gone
// would execute the same non-idempotent request a second time, which is
// exactly what the ledger exists to prevent. When nothing is evictable the
// ledger stays over the cap until entries settle or expire — the memory
// bound yields to correctness.
function evictLedgerEntries(ledger, replayWindowMs) {
  while (ledger.size > MAX_LEDGER_ENTRIES) {
    let victim = null;
    for (const [k, e] of ledger) {
      if (e.aborted || (e.settled && Date.now() - e.settledAt > replayWindowMs)) { victim = k; break; }
    }
    if (victim === null) break;
    ledger.delete(victim);
  }
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
function notePairSuccess(ctx, claimedPairing) {
  const p = claimedPairing || ctx.pairing;
  if (p) p.consumed = true;
  // The claimed pairing object travels with the callback (first audit #7):
  // link.js clears its current pairing only when it IS this object, so a
  // stale channel can never wipe a newer pairing it never belonged to.
  try { ctx.onPairSuccess?.(p); } catch {}
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
  // Delivery bookkeeping for the request ledger (wave18): sendApp success
  // only proves a reply was handed to this socket — the tunnel protocol
  // has no receipt acknowledgement, so a reply sent on a channel that then
  // dies is UNCONFIRMED, however clean the send looked. channelRef lets a
  // ledger entry ask later whether a channel it was sent on is still
  // alive; deliveredEntries lets this handler flip its own entries to
  // deliveryUnknown the moment the socket goes away.
  const channelRef = {isClosed: () => channelClosed};
  const deliveredEntries = new Set();
  const markDeliveriesUnknown = () => {
    for (const e of deliveredEntries) {
      if ([...e.deliveredTo].every(ref => ref.isClosed())) e.deliveryUnknown = true;
    }
  };
  ws.on('close', () => {
    channelClosed = true;
    markDeliveriesUnknown();
    closeSubs();
    for (const a of aborters) { try { a.abort(); } catch {} }
    aborters.clear();
  });
  const close = (code = 1008) => { channelClosed = true; markDeliveriesUnknown(); closeSubs(); try { ws.close(code); } catch {} };

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
    // The check must cover THIS message too (deep audit c23 #4, the rest of
    // audit #118): checking only what is already buffered lets one oversized
    // reply queue its every frame past the limit. Refuse the message whole
    // when it would push the socket over the limit — never send half a
    // message, which would corrupt the framing of everything behind it.
    if (buffered + payload.length > sendBufferLimit) {
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
    // One deadline for the whole wait (deep audit c23 #1): frames that are
    // skipped below — retransmitted handshake copies, incomplete frame
    // fragments — are not application activity and must not rewind the
    // clock, or a trickle of meaningless frames keeps a dead channel (and
    // the pairing wait, which shares this helper) alive forever. Only a
    // completed application message ends the wait, so only it counts as
    // activity for the caller's idle accounting.
    const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
    for (;;) {
      let remainingMs = timeoutMs;
      if (deadline) {
        remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return APP_TIMEOUT;
      }
      const item = await queue.next(remainingMs);
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
    if (pairing.consumed || pairing.burned || (pairing.expiresAt && pairing.expiresAt <= Date.now())) {
      try { sendApp({t: 'pair-failed', error: 'pairing already used'}); } catch {}
      close();
      return {ok: false, reason: 'pairing-consumed'};
    }
    // The pairing must still be the link's CURRENT pairing (first audit #7):
    // a channel that grabbed pairing A before the user replaced it with B
    // must not register on the stale object. link.js supplies getPairing();
    // contexts without it keep the consumed/expired/burned checks above.
    if (typeof ctx.getPairing === 'function') {
      let current = null;
      try { current = ctx.getPairing(); } catch { current = null; }
      if (current !== pairing) {
        try { sendApp({t: 'pair-failed', error: 'pairing superseded'}); } catch {}
        close();
        return {ok: false, reason: 'pairing-superseded'};
      }
    }
    try { device = ctx.remoteStore.add({name: first.name || 'phone', staticPub: remoteStatic}); }
    catch (e) { close(); return {ok: false, reason: 'store-failed', error: e}; }
    notePairSuccess(ctx, pairing);
    sendApp({t: 'paired', device: {id: device.id, name: device.name}, pc: {name: os.hostname(), pcId: pcIdOf(ctx), relay: ctx.relayUrl || null, lan: ctx.lanAddresses || []}});
  } else {
    device = ctx.remoteStore.findByStatic(remoteStatic);
    if (!device) { try { sendApp({t: 'revoked'}); } catch {} close(4403); return {ok: false, reason: 'unpaired'}; }
  }
  try { ctx.remoteStore.touch(device.id); } catch {} // lastSeen, on connect

  // Revocation must reach LIVE channels (first audit #5): the store was only
  // consulted at connect time, so a phone revoked mid-session kept working
  // forever as long as it pinged. Re-validate the device against the store
  // on every application message (ping included); a store read failure is
  // not a revocation and never kills the channel by itself.
  const deviceRevoked = () => {
    if (!device || !remoteStatic) return false;
    try { return !ctx.remoteStore.findByStatic(remoteStatic); } catch { return false; }
  };

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
    if (deviceRevoked()) { try { sendApp({t: 'revoked'}); } catch {} close(4403); return {ok: false, reason: 'revoked', device}; }
    if (msg.t === 'ping') { sendApp({t: 'pong'}); continue; }
    if (msg.t === 'req') {
      // An id that cannot correlate a reply, or one this channel is already
      // answering, is not acted on (audit #109): executing an uncorrelatable
      // or duplicate non-idempotent request is the worst outcome.
      if (!validTunnelId(msg.id)) continue;
      if (reqIdsInFlight.has(msg.id)) continue;
      reqIdsInFlight.add(msg.id);
      const run = (async () => {
        // Allowlist first (first audit #6): a forbidden path/method is
        // answered 403 here and never reaches the proxy or the dedupe
        // ledger, so it cannot execute on serve or pollute replays.
        if (!isAllowedChannelRequest(msg.method, msg.path)) {
          sendApp({t: 'res', id: msg.id, status: 403, body: {error: 'path not allowed over the channel', code: 'channel-forbidden'}});
          return;
        }
        // Dedupe across channels (audit #108): an identical request from the
        // same device joins the outcome already in flight in the shared
        // ledger, and replays it when the original finished but its reply
        // never reached a live channel — it is never executed twice. A
        // reply merely handed to a socket does not retire the entry either
        // (wave18, below): only a repeat on that same live channel does.
        const ledger = ledgerFor(ctx.proxy);
        const key = (device?.id || '') + '|' + requestFingerprint(msg.method, msg.path, msg.body);
        const replayWindowMs = ctx.reqReplayWindowMs ?? REQ_REPLAY_WINDOW_MS;
        const inFlightTimeoutMs = ctx.reqInFlightTimeoutMs ?? REQ_IN_FLIGHT_TIMEOUT_MS;
        let entry = ledger.get(key);
        if (entry && entry.settled && entry.deliveredTo.has(channelRef)) {
          // The reply was handed to THIS channel and the phone repeats the
          // request on that same live channel: the delivery stands (audit
          // #108) and the repeat is a new, intentional request. Any other
          // resend — above all one arriving after the channel a reply was
          // sent on has died — finds the entry below and replays it,
          // because that delivery was never confirmed (wave18).
          ledger.delete(key);
          entry = null;
        }
        if (entry && (entry.aborted || (entry.settled && Date.now() - entry.settledAt > replayWindowMs) || (!entry.settled && Date.now() - entry.createdAt > inFlightTimeoutMs))) {
          // A stuck in-flight entry expires like a settled one (deep audit
          // c23 #3): abort it so a proxy that honours the signal frees the
          // request, and let this resend execute fresh instead of joining
          // a promise that will never settle.
          if (!entry.settled) { try { entry.controller?.abort(); } catch {} }
          ledger.delete(key);
          entry = null;
        }
        if (!entry) {
          entry = {settled: false, delivered: false, aborted: false, settledAt: 0, createdAt: Date.now(), result: null, listeners: new Set(), controller: null, promise: null, deliveredTo: new Set(), deliveryUnknown: false};
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          entry.controller = controller;
          entry.promise = (async () => {
            try {
              const out = await ctx.proxy.request({method: msg.method, path: msg.path, body: msg.body, ...(controller ? {signal: controller.signal} : {})});
              const result = {status: typeof out?.status === 'number' ? out.status : 502, body: out?.body ?? null};
              // Binary replies keep their encoding metadata (wave18): the
              // proxy returns base64 bodies with bodyEncoding/contentType,
              // and rounding them away here left the phone unable to tell
              // a base64 media body from plain text.
              if (out?.bodyEncoding) result.bodyEncoding = out.bodyEncoding;
              if (out?.contentType) result.contentType = out.contentType;
              return result;
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
          evictLedgerEntries(ledger, replayWindowMs);
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
        const resMsg = {t: 'res', id: msg.id, status: out.status, body: out.body ?? null};
        if (out.bodyEncoding) resMsg.bodyEncoding = out.bodyEncoding;
        if (out.contentType) resMsg.contentType = out.contentType;
        const delivered = sendApp(resMsg);
        if (delivered) {
          entry.delivered = true;
          entry.deliveredTo.add(channelRef);
          deliveredEntries.add(entry);
          // The entry is NOT deleted (wave18): sendApp returning true only
          // means the reply entered this socket's buffer — the protocol has
          // no acknowledgement, so a disconnect before the flush loses the
          // reply invisibly, and deleting the entry here let a reconnecting
          // phone's resend execute the same non-idempotent request a
          // second time. The entry stays for the replay window: when every
          // channel it was sent on has died, its delivery is marked
          // unknown (deliveryUnknown) and a resend replays this outcome
          // instead of executing again; a repeat on a channel that already
          // received it is still a new request (see the lookup above).
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
      // Subscriptions obey the same allowlist (first audit #6): only the
      // per-conversation event stream may be opened through a channel.
      if (!isAllowedChannelSubscription(msg.path)) {
        sendApp({t: 'sub-failed', id: msg.id, error: 'subscription not allowed over the channel', code: 'channel-forbidden'});
        continue;
      }
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

module.exports = {handleChannelSocket, pairingActive, messageQueue, isAllowedChannelRequest, isAllowedChannelSubscription, HANDSHAKE_TIMEOUT_MS, CHANNEL_IDLE_TIMEOUT_MS, MAX_QUEUED_ITEMS, MAX_QUEUED_BYTES};
