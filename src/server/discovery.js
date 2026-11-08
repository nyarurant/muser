'use strict';
// Client side of the Muser Server discovery file (~/.muser/server.json, written by
// GuiServer next to gui.json): how a second `muser serve` finds the resident server
// and attaches to it instead of starting a rival, and how `muser server status/stop`
// talk to it. Everything here is plain HTTP with the file's Bearer token.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function serverFile() { return process.env.MUSER_SERVER_FILE || path.join(os.homedir(), '.muser', 'server.json'); }

// The older discovery file (~/.muser/gui.json), written by every GuiServer —
// by the resident server too, but also by a standalone single-conversation
// serve that never wrote server.json. Same shape ({pid, port, token, ...}),
// so the same validation reads it; `muser status` probes both files.
function guiFile() { return process.env.MUSER_GUI_FILE || path.join(os.homedir(), '.muser', 'gui.json'); }

function readGui(file = guiFile()) { return readServer(file); }

function readServer(file = serverFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.port === 'number' && typeof data.token === 'string') return data;
  } catch {}
  return null;
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// #62: the default timeout used to be the probe's 2 s for EVERY request, so a
// slow POST or a multi-MB /send was aborted client-side at 2 s while the server
// kept processing it — inviting a duplicate send. Plain requests get a
// generous default (longer when a body is uploaded); only the probe below
// passes a short timeout explicitly.
// c21 #10: response bodies are capped. The old `await res.text()` buffered the whole
// body with only the timeout as a limit, so a wrong/abnormal responder on loopback
// (fast enough to push hundreds of MB inside it) could inflate the client until it
// died — and for the probe, the pid check only happens after that full read. The
// probe's cap is small (it only needs the server-info JSON); plain requests get a
// generous one (a /api/state snapshot is legitimately large, but not unbounded).
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const PROBE_MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBodyCapped(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} const e = new Error('response too large (over ' + maxBytes + ' bytes)'); e.code = 'RESPONSE_TOO_LARGE'; throw e; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  const text = await res.text();
  if (text.length > maxBytes) { const e = new Error('response too large (over ' + maxBytes + ' bytes)'); e.code = 'RESPONSE_TOO_LARGE'; throw e; }
  return text;
}

// wave18 (a): a /send used to carry no idempotency key at all, so when the
// client-side abort below fired (120 s default for a body) a send the server
// had ALREADY accepted looked exactly like one that never left — and the
// user's re-send ran the turn twice (measured: exec=1 at the abort, exec=2
// after the re-send). Every /send now carries a fresh client-generated
// request id, in the body (`requestId`, the questionId/approvalId naming
// style) and in the `x-muser-request-id` header, so a future server-side
// dedupe has a stable key to refuse the duplicate with. Dedupe itself is
// the server side's half of this finding (audit-server): until the server
// honours the id, the client can only label the send, not make it safe.
// A caller-supplied requestId is respected (and mirrored to the header),
// so a deliberate retry of the SAME send can reuse its id.
function isSendPath(p) { return typeof p === 'string' && p.split('?')[0].endsWith('/send'); }
function newRequestId() { try { return crypto.randomUUID(); } catch { return crypto.randomBytes(16).toString('hex'); } }

async function request(info, method, p, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES) {
  if (timeoutMs === undefined) timeoutMs = body !== undefined ? 120000 : 30000;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    let wireBody = body, requestId = null;
    if (body !== undefined && String(method).toUpperCase() === 'POST' && isSendPath(p) && body && typeof body === 'object' && !Array.isArray(body)) {
      requestId = typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : newRequestId();
      wireBody = {...body, requestId};
    }
    const res = await fetch('http://127.0.0.1:' + info.port + p, {
      method,
      headers: {authorization: 'Bearer ' + info.token, ...(body !== undefined ? {'content-type': 'application/json'} : {}), ...(requestId ? {'x-muser-request-id': requestId} : {})},
      body: wireBody !== undefined ? JSON.stringify(wireBody) : undefined,
      signal: ctrl.signal,
    });
    const text = await readBodyCapped(res, maxBytes);
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return {status: res.status, json};
  } catch (e) {
    // wave18 (b): OUR timeout aborting a body-carrying POST does not mean
    // "not sent" — the request may have reached the server and been accepted
    // (that is exactly what the measured duplication showed). Mark it
    // unconfirmed (the src/export.js `err.unconfirmed` precedent, with
    // outcome 'unknown' as in src/link/channel-server.js) so callers can
    // leave the re-send decision to the user instead of treating it as a
    // plain disconnect. Bodyless / idempotent requests keep the plain
    // abort error: retrying those is safe, and probeServer relies on it.
    if (timedOut && body !== undefined && String(method).toUpperCase() === 'POST' && e?.code !== 'RESPONSE_TOO_LARGE') {
      const err = new Error('request timed out — the server may already have accepted it, so delivery is unconfirmed');
      err.code = 'UNCONFIRMED'; err.unconfirmed = true; err.outcome = 'unknown'; err.cause = e;
      throw err;
    }
    throw e;
  } finally { clearTimeout(timer); }
}

// The server info when a live server answers for this discovery file, else null
// (no file, dead pid, or nothing answering — a stale file never blocks a start).
// #65: a single 2 s probe declared a merely SLOW server dead, and the caller
// then started a rival that overwrote the discovery file and orphaned the real
// server. A live pid earns retries with growing timeouts, and an answering
// server whose pid is not the file's pid is not this file's server.
async function probeServer(info) {
  if (!info || !pidAlive(info.pid)) return null;
  for (const timeoutMs of [2000, 3000, 5000]) {
    let r;
    try { r = await request(info, 'GET', '/api/server', undefined, timeoutMs, PROBE_MAX_RESPONSE_BYTES); }
    catch { continue; } // a timeout or a refused moment: retry before calling it dead
    if (r.status !== 200) return null; // it answered and refused us: not our server
    // c21 #9: the pid check used to fire only when the answer carried a NUMERIC pid,
    // so a different process answering 200 with no pid / a string pid was accepted as
    // this server — and attachSession then presented the Bearer token (and cwd) to it.
    // The real GuiServer's /api/server always carries its numeric pid (serverInfo()),
    // so identity is now required, not optional: a numeric mismatch is final, and a
    // 200 without a usable pid (empty / non-JSON body included) is retried like a
    // slow answer and then reported as no server, never accepted on faith.
    if (r.json && typeof r.json.pid === 'number') return r.json.pid === info.pid ? r.json : null;
    continue;
  }
  return null;
}

// Open a conversation on the running server: an existing session by id when one is
// named, otherwise a new conversation in the given folder.
async function attachSession(info, {cwd, account, mode, sessionId, maxAgents, maxAgentsTotal, focusEnabled, noFocus, agentLimits} = {}) {
  // First audit #32 (discovery part): the attach used to carry only cwd/account/mode,
  // so a client's agent limits (--max-agents / --max-agents-total) and Focus on/off
  // (--no-focus) silently did nothing for a conversation created on the resident
  // server. They are forwarded now, when the caller supplies them (undefined fields
  // are omitted, so older callers see the exact old body). Whether the server
  // honours them is the gui-server / sessions-host side of the same finding.
  const extra = {};
  const effMax = maxAgents ?? agentLimits?.maxAgents;
  const effTotal = maxAgentsTotal ?? agentLimits?.maxAgentsTotal;
  if (effMax !== undefined) extra.maxAgents = effMax;
  if (effTotal !== undefined) extra.maxAgentsTotal = effTotal;
  if (focusEnabled !== undefined) extra.focusEnabled = focusEnabled;
  // bin/muser.js passes the flag in its own shape ({noFocus: o.noFocus}): forward it
  // as given AND as focusEnabled, so the server side can take either spelling.
  if (noFocus !== undefined) { extra.noFocus = noFocus; if (extra.focusEnabled === undefined) extra.focusEnabled = !noFocus; }
  // serverfirst-debug B4: the thrown error carries .status, so callers
  // can tell a 501 (host not built yet — worth retrying briefly) from
  // any other refusal without pattern-matching the message text.
  const fail = r => { const e = new Error(r.json?.error || ('server answered ' + r.status)); e.status = r.status; throw e; };
  if (sessionId) {
    const r = await request(info, 'POST', '/api/sessions/' + encodeURIComponent(sessionId) + '/open', extra);
    if (r.status !== 200) fail(r);
    return r.json;
  }
  const r = await request(info, 'POST', '/api/sessions', {cwd, account, mode, ...extra});
  if (r.status !== 201) fail(r);
  return r.json;
}

module.exports = {serverFile, readServer, guiFile, readGui, pidAlive, probeServer, attachSession, request, newRequestId, MAX_RESPONSE_BYTES, PROBE_MAX_RESPONSE_BYTES};
