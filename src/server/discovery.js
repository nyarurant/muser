'use strict';
// Client side of the Muser Server discovery file (~/.muser/server.json, written by
// GuiServer next to gui.json): how a second `muser serve` finds the resident server
// and attaches to it instead of starting a rival, and how `muser server status/stop`
// talk to it. Everything here is plain HTTP with the file's Bearer token.
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

async function request(info, method, p, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES) {
  if (timeoutMs === undefined) timeoutMs = body !== undefined ? 120000 : 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:' + info.port + p, {
      method,
      headers: {authorization: 'Bearer ' + info.token, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await readBodyCapped(res, maxBytes);
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return {status: res.status, json};
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
  if (sessionId) {
    const r = await request(info, 'POST', '/api/sessions/' + encodeURIComponent(sessionId) + '/open', extra);
    if (r.status !== 200) throw new Error(r.json?.error || ('server answered ' + r.status));
    return r.json;
  }
  const r = await request(info, 'POST', '/api/sessions', {cwd, account, mode, ...extra});
  if (r.status !== 201) throw new Error(r.json?.error || ('server answered ' + r.status));
  return r.json;
}

module.exports = {serverFile, readServer, guiFile, readGui, pidAlive, probeServer, attachSession, request, MAX_RESPONSE_BYTES, PROBE_MAX_RESPONSE_BYTES};
