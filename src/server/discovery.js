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
async function request(info, method, p, body, timeoutMs) {
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
    const text = await res.text();
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
    try { r = await request(info, 'GET', '/api/server', undefined, timeoutMs); }
    catch { continue; } // a timeout or a refused moment: retry before calling it dead
    if (r.status !== 200) return null; // it answered and refused us: not our server
    if (r.json && typeof r.json.pid === 'number' && r.json.pid !== info.pid) return null;
    return r.json;
  }
  return null;
}

// Open a conversation on the running server: an existing session by id when one is
// named, otherwise a new conversation in the given folder.
async function attachSession(info, {cwd, account, mode, sessionId} = {}) {
  if (sessionId) {
    const r = await request(info, 'POST', '/api/sessions/' + encodeURIComponent(sessionId) + '/open', {});
    if (r.status !== 200) throw new Error(r.json?.error || ('server answered ' + r.status));
    return r.json;
  }
  const r = await request(info, 'POST', '/api/sessions', {cwd, account, mode});
  if (r.status !== 201) throw new Error(r.json?.error || ('server answered ' + r.status));
  return r.json;
}

module.exports = {serverFile, readServer, guiFile, readGui, pidAlive, probeServer, attachSession, request};
