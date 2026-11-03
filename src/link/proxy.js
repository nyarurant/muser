'use strict';
// The channel's view of the local serve (src/gui-server.js): plain HTTP to
// 127.0.0.1 with serve's per-process Bearer token, so serve needs no remote-specific
// code paths (remote/DESIGN.md, "Inside the channel"). One-shot requests for
// {t:'req'} and long-lived SSE subscriptions for {t:'sub'}.
const http = require('node:http');

const REQUEST_TIMEOUT_MS = 30000;
// Serve can hand back media up to ~32 MB; anything past the cap is a runaway
// response, not a bigger buffer (audit #111: responses were buffered whole).
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// serve heartbeats every 25 s (': ping'); three missed beats mean the stream
// is dead even though the socket has not noticed yet (audit #112).
const SUB_IDLE_MS = 90000;
const SUB_CHECK_MS = 15000;
// One SSE frame is a state snapshot, never megabytes; a peer that never sends
// the blank-line delimiter must not grow this buffer forever (audit #116).
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

function createProxy({port, token, host = '127.0.0.1', requestTimeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES, subIdleMs = SUB_IDLE_MS, maxSseBufferBytes = MAX_SSE_BUFFER_BYTES} = {}) {
  if (!port) throw new Error('link proxy: serve port is required');
  const headers = extra => ({authorization: 'Bearer ' + token, ...extra});

  // {method, path, body} -> {status, body, contentType}. A JSON response body comes
  // back parsed; anything else (or an empty body) is text / null.
  function request({method = 'GET', path: p, body} = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined || body === null ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      const req = http.request({host, port, path: p, method, headers: headers(data ? {'content-type': 'application/json'} : {})}, res => {
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > maxResponseBytes) {
            clearTimeout(deadline);
            // Destroy without an error argument: passing one re-emits it as a
            // stray 'error' on the response stream; the reject below is the
            // single, clean failure for this request.
            req.destroy();
            reject(new Error('link proxy: serve response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
          resolve({status: res.statusCode, body: parsed, contentType: res.headers['content-type'] || null});
        });
        res.on('error', err => { clearTimeout(deadline); reject(err); });
      });
      // A deadline, not socket inactivity: a response that keeps dripping a
      // chunk every few seconds must still die at the limit (audit #110).
      // req.setTimeout alone only measures the gap between chunks.
      const deadline = setTimeout(() => req.destroy(new Error('link proxy: serve did not answer in time')), requestTimeoutMs);
      deadline.unref?.();
      req.setTimeout(requestTimeoutMs, () => req.destroy(new Error('link proxy: serve did not answer in time')));
      req.on('error', err => { clearTimeout(deadline); reject(err); });
      if (data) req.write(data);
      req.end();
    });
  }

  // Subscribe to an SSE path (/api/events, /api/server/events): each SSE frame is
  // delivered as onEvent(eventName, dataString) — 'message' when the frame carries no
  // event: line, as serve's streams send bare data: frames. Comments (': ping'
  // heartbeats) are not events. Returns a close function; a dead stream simply ends
  // the subscription (the phone re-subscribes on its next channel).
  function openSubscription(p, onEvent, onError) {
    let closed = false, failed = false, buffer = '';
    let lastActivity = Date.now();
    // onError fires at most once, never after close(), and always tears the
    // serve request down with it: a late error from a replaced subscription
    // must not be able to delete its replacement (audit #114), and an errored
    // subscription must not leave its HTTP request/socket behind (audit #115).
    const fail = err => {
      if (closed || failed) return;
      failed = true;
      clearInterval(watchdog);
      try { req.destroy(); } catch {}
      onError?.(err);
    };
    const req = http.get({host, port, path: p, headers: headers({accept: 'text/event-stream'})}, res => {
      if (res.statusCode !== 200) { res.resume(); fail(new Error('link proxy: subscription answered ' + res.statusCode)); return; }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        lastActivity = Date.now();
        buffer += chunk;
        if (buffer.length > maxSseBufferBytes) { fail(new Error('link proxy: subscription frame too large')); return; }
        let m;
        // The delimiter is 2-4 bytes (\n\n, \r\n\n, \n\r\n, \r\n\r\n): slice by the
        // matched length, not by the first byte, or mixed endings shift the
        // next frame by a byte (audit #117).
        while ((m = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const frame = buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);
          let event = 'message'; const data = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (data.length) { try { onEvent(event, data.join('\n')); } catch {} }
        }
      });
      res.on('end', () => fail(new Error('link proxy: subscription ended')));
      res.on('error', fail);
    });
    req.on('error', fail);
    // Liveness: serve heartbeats every 25 s, so a stream with no bytes at all
    // for subIdleMs is dead even if the socket still looks open (audit #112).
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > subIdleMs) fail(new Error('link proxy: subscription went silent'));
    }, Math.min(SUB_CHECK_MS, Math.max(10, subIdleMs)));
    watchdog.unref?.();
    return () => { closed = true; clearInterval(watchdog); try { req.destroy(); } catch {} };
  }

  return {request, forward: request, openSubscription, port, host};
}

module.exports = {createProxy};
