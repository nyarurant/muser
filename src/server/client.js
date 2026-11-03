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

// One SSE connection, reconnecting while not closed. onClose fires exactly once
// per connection that ends (a drop that will be retried, and the final close),
// so a caller can tell "the link went down" apart from "events are flowing":
// any onEvent after an onClose means the link recovered.
function sseStream(info, path, {onEvent, onClose} = {}) {
  let closed = false;
  let attempt = 0;
  let controller = null;
  let wake = null; // resolves the backoff sleep early when close() lands in it

  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    timer.unref?.();
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

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
      let permanent = false; // #66: a 401/403/404 will never heal by retrying
      const reportClose = () => { if (!reported) { reported = true; try { onClose?.(); } catch {} } };
      try {
        controller = new AbortController();
        const res = await fetch('http://127.0.0.1:' + info.port + path, {
          headers: {authorization: 'Bearer ' + info.token, accept: 'text/event-stream'},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          if (res && (res.status === 401 || res.status === 403 || res.status === 404)) permanent = true;
          throw new Error('events answered ' + res.status);
        }
        // #66: the backoff used to reset here, on accept, so a server that
        // accepted and instantly dropped the stream was retried every ~250 ms
        // forever. It resets only once a real event has come through (below).
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream: true});
          buffer = drain(buffer.replace(/\r\n/g, '\n'), text => {
            let event; try { event = JSON.parse(text); } catch { return; }
            attempt = 0; // a stream that actually delivered restarts the backoff
            try { onEvent?.(event); } catch {}
          });
        }
      } catch { /* a drop, a refused connection, or close()'s abort: all reconnect-or-stop below */ }
      reportClose();
      if (closed || permanent) break;
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
