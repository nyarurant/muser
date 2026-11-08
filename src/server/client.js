'use strict';
// Client side of the resident Muser Server (remote/DESIGN.md step 4): the plain
// requests go through discovery.request (Bearer token, {status, json}), and the
// two SSE streams (one conversation's /events, the server-wide /api/server/events)
// are read with global fetch so they can stay open past discovery.request's short
// timeout. A dropped stream reconnects on its own with backoff until the caller
// closes it; every parsed `data:` frame (the initial {kind: 'state' / 'server'}
// snapshot frame included) is handed to onEvent as-is.
const discovery = require('./discovery');

const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 5000;
// A snapshot frame alone does not prove a stream healthy for backoff purposes (deep audit
// c25 #7): every connection starts with one, so it resets the backoff only once the
// connection has also survived this long. Real (non-snapshot) events reset it at once.
const SNAPSHOT_RESET_MS = 10000;
// An unterminated frame may not grow the buffer without bound (deep audit c25 #9): past
// this, the connection is dropped and reconnected instead of eating the resident client's
// memory forever on a server that never sends the blank-line terminator.
const MAX_BUFFER_CHARS = 32 * 1024 * 1024;
// audit-cli wave18: the read loop below used to wait on reader.read() with no
// deadline, so a frozen or half-open Server that stopped sending without
// closing the socket left the stream hanging silently forever (observed past
// 96 s: no onClose, no reconnect). The Server pings every 25 s (gui-server's
// eventsHeartbeatMs), so — like the link proxy's 90 s watchdog
// (src/link/proxy.js, audit #112) — three missed beats mean the stream is
// dead: the connection is aborted and the normal reconnect path runs. The
// handlers bag's idleMs shrinks the limit for tests (the proxy/relay
// timeouts allow the same); production callers never pass it.
const STREAM_IDLE_MS = 90000;
// audit-cli wave18: a 401/403/404 used to stop the stream for good (#66)
// with the discovery file never read again, so when the resident Server
// was restarted and its port/token changed, the stream could never
// recover (observed: the new server saw zero hits). A permanent stop now
// re-reads discovery on this cadence and reconnects only when the file
// points at a different port/token — while it names the same target the
// stream stays stopped exactly as #66 required (the target is not hit
// again; only the file is re-read).
const DISCOVERY_RECHECK_MS = 5000;

// One SSE connection, reconnecting while not closed. onClose fires exactly once
// per connection that ends (a drop that will be retried, and the final close),
// so a caller can tell "the link went down" apart from "events are flowing":
// any onEvent after an onClose means the link recovered.
function sseStream(info, path, {onEvent, onClose, idleMs} = {}) {
  const idleLimit = typeof idleMs === 'number' && idleMs > 0 ? idleMs : STREAM_IDLE_MS;
  let closed = false;
  let attempt = 0;
  let controller = null;
  let wake = null; // resolves the backoff sleep early when close() lands in it

  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    timer.unref?.();
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  // The connection target this stream is currently aimed at (wave18): it
  // starts as the caller's info and moves only when the discovery file
  // comes to name a different port/token (a restarted Server). Re-reading
  // is a plain file read — cheap, and it never touches the old target.
  let current = info;
  let firstAttempt = true;
  const refreshInfo = () => {
    let fresh = null;
    try { fresh = discovery.readServer(); } catch {}
    if (fresh && (fresh.port !== current.port || fresh.token !== current.token)) { current = fresh; return true; }
    return false;
  };

  // Frames are separated by a blank line; inside a frame, `data:` lines join
  // with '\n' (a JSON payload may be split across them), ':' lines are the
  // server's keep-alive pings, and anything else is ignored. A frame may also
  // be split across network chunks anywhere, so only complete frames (those
  // terminated by the blank line) are taken out of the buffer.
  function drain(buffer, emit) {
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = [];
      for (const line of frame.split('\n')) {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (clean.startsWith('data:')) data.push(clean.slice(5).replace(/^ /, ''));
      }
      if (data.length) emit(data.join('\n'));
    }
    return buffer;
  }

  async function run() {
    while (!closed) {
      let reported = false;
      let permanent = false; // #66: a 401/403/404 will never heal by retrying the same target
      const reportClose = () => { if (!reported) { reported = true; try { onClose?.(); } catch {} } };
      // A retry re-reads discovery first (wave18): the Server may have
      // been restarted under a new port/token during the backoff.
      if (firstAttempt) firstAttempt = false; else refreshInfo();
      let idleTimer = null;
      try {
        controller = new AbortController();
        const ctrl = controller;
        let reader = null;
        // The idle deadline (wave18, see STREAM_IDLE_MS): armed at connect
        // and re-armed by every chunk that arrives — a ping frame counts,
        // it is the Server's sign of life. When it fires, aborting makes
        // the pending fetch/read reject, which the catch below turns into
        // the usual reportClose + reconnect instead of a silent hang.
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { try { ctrl.abort(); } catch {} try { reader?.cancel()?.catch(() => {}); } catch {} }, idleLimit);
          idleTimer.unref?.();
        };
        armIdle();
        const res = await fetch('http://127.0.0.1:' + current.port + path, {
          headers: {authorization: 'Bearer ' + current.token, accept: 'text/event-stream'},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          if (res && (res.status === 401 || res.status === 403 || res.status === 404)) permanent = true;
          throw new Error('events answered ' + res.status);
        }
        // #66: the backoff used to reset here, on accept, so a server that
        // accepted and instantly dropped the stream was retried every ~250 ms
        // forever. It resets only once a real event has come through (below).
        reader = res.body.getReader();
        armIdle();
        const decoder = new TextDecoder();
        const connectedAt = Date.now();
        let buffer = '';
        for (;;) {
          if (closed) break; // close() lands between reads too (deep audit c25 #8)
          const {done, value} = await reader.read();
          if (done || closed) break;
          armIdle(); // a chunk arrived (an event or a ping): the stream is alive
          buffer += decoder.decode(value, {stream: true});
          buffer = drain(buffer.replace(/\r\n/g, '\n'), text => {
            // close() from inside onEvent (the usual reaction to a terminal event) stops
            // delivery at once: the rest of this chunk's frames are not handed out after
            // the caller has closed the stream (deep audit c25 #8).
            if (closed) return;
            let event; try { event = JSON.parse(text); } catch { return; }
            // #66, completed by c25 #7: the initial snapshot frame is not by itself proof
            // of a healthy stream — a server that accepts, snapshots and instantly drops
            // was retried every ~250 ms forever because the snapshot reset the backoff.
            // A snapshot resets it only for a connection that has survived a while; any
            // other event still resets it at once, as does a long-lived stream's drop.
            const snapshot = event && (event.kind === 'state' || event.kind === 'server');
            if (!snapshot || Date.now() - connectedAt >= SNAPSHOT_RESET_MS) attempt = 0;
            try { onEvent?.(event); } catch {}
          });
          // What is left in the buffer is one unterminated frame: bound it (c25 #9).
          if (buffer.length > MAX_BUFFER_CHARS) throw new Error('events frame exceeds the size limit');
        }
      } catch { /* a drop, a refused connection, the idle abort, or close()'s abort: all reconnect-or-stop below */ } finally {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      }
      reportClose();
      if (closed) break;
      if (permanent) {
        // #66's stop stands for the target that refused us, but wave18:
        // the discovery file may already name a restarted Server, or may
        // come to while we wait. Poll it (file reads only — the refused
        // target is never hit again) until it points elsewhere, then
        // fall through to the backoff and reconnect to the new target.
        let moved = refreshInfo();
        while (!closed && !moved) {
          await sleep(DISCOVERY_RECHECK_MS);
          if (!closed) moved = refreshInfo();
        }
        if (closed) break;
      }
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** attempt);
      attempt++;
      await sleep(delay);
    }
  }
  run().catch(() => {});

  return function close() {
    if (closed) return;
    closed = true;
    if (wake) wake();
    try { controller?.abort(); } catch {}
  };
}

function createClient(info) {
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') {
    throw new Error('createClient needs the server info from discovery ({port, token, ...})');
  }
  return {
    info,
    request(method, path, body) { return discovery.request(info, method, path, body); },
    events(sessionId, handlers) {
      const path = sessionId ? '/api/s/' + encodeURIComponent(sessionId) + '/events' : '/api/events';
      return sseStream(info, path, handlers);
    },
    serverEvents(handlers) { return sseStream(info, '/api/server/events', handlers); },
  };
}

module.exports = {createClient};
