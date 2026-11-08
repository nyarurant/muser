'use strict';
// Server-first startup (server-first decision, 2026-11-07): the interactive
// CLI wants the resident Muser Server. ensureServer() classifies what is
// there — ready, still in first-run setup, too old to talk to (protocol),
// or absent — and when absent it tries ONCE to start one in the background
// (detached, no TTY: a serve spawned without a terminal opens in HTTP
// setup mode, and one spawned this way outlives the CLI window, like the
// logon autostart it complements) and waits a short while for it to answer.
// It NEVER stops or restarts a server: an old or busy resident is the
// user's to manage (`muser server stop`). Callers fall back to a direct
// (standalone) session on any non-ready verdict and say so in one line.
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 6;
const DEFAULT_TIMEOUT_MS = 20000; // the GUI's serve wait, rounded (setup extends separately)
const DEFAULT_POLL_MS = 250;

function verdict(info, live) {
  // serverfirst-debug B14: normalise before judging. The wire answer is
  // JSON another build wrote: a protocol arriving as the string "6" IS
  // protocol 6 (the old strict !== sent a healthy current server down
  // the "too old to talk to" path), and the setup phase is matched
  // case-insensitively, the same slack discovery's own checks allow.
  const protocol = Number(live.protocol ?? 5);
  if (protocol !== PROTOCOL) return {status: 'protocol', info, live, protocol};
  const rawPhase = live.setup?.phase;
  const phase = typeof rawPhase === 'string' ? rawPhase.toLowerCase() : rawPhase;
  if (phase && phase !== 'done') return {status: 'setup', info, live, phase};
  return {status: 'ready', info, live};
}

function defaultSpawnServer(binFile) {
  const {spawn} = require('node:child_process');
  const child = spawn(process.execPath, [binFile, 'serve'], {detached: true, stdio: 'ignore', windowsHide: true});
  child.unref();
  return child;
}

// deps are injectable for tests: {readServer, probeServer, spawnServer,
// sleep, now, timeoutMs, pollMs, binFile}.
async function ensureServer(deps = {}) {
  const discovery = require('./discovery');
  const readServer = deps.readServer || (() => discovery.readServer());
  const probeServer = deps.probeServer || (info => discovery.probeServer(info));
  const binFile = deps.binFile || path.join(__dirname, '..', '..', 'bin', 'muser.js');
  const spawnServer = deps.spawnServer || (() => defaultSpawnServer(binFile));
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const pidAlive = deps.pidAlive || (pid => discovery.pidAlive(pid));
  // serverfirst-debug B2: the spawn lock is opt-in (bin passes a path
  // next to the discovery file). Without one, behaviour is unchanged.
  const lockFile = deps.lockFile || null;

  let sawFile = false;
  let filePidAlive = false;
  const probeOnce = async () => {
    const info = readServer();
    if (!info) return null;
    sawFile = true;
    // serverfirst-debug B1: remember whether the file's owner is a LIVE
    // process — a live-but-slow server (still booting, or wedged) must
    // be waited for, never raced with a rival spawn whose late
    // discovery write could steal the file from the healthy resident.
    try { if (info.pid && pidAlive(info.pid)) filePidAlive = true; } catch {}
    const live = await probeServer(info).catch(() => null);
    return live ? {info, live} : null;
  };

  let lockFd = null;
  const tryLock = () => {
    if (!lockFile) return true;
    try {
      lockFd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(lockFd, JSON.stringify({pid: process.pid, at: now()}));
      return true;
    } catch {
      // Held: stale only when the holder is gone or the lock outlived a
      // whole ensure budget. Otherwise another starter is on it.
      try {
        const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        const stale = !pidAlive(held.pid) || (now() - (held.at || 0)) > timeoutMs + 5000;
        if (stale) { fs.unlinkSync(lockFile); return tryLock(); }
      } catch {}
      return false;
    }
  };
  const releaseLock = () => {
    if (lockFd != null) { try { fs.closeSync(lockFd); } catch {} lockFd = null; }
    if (lockFile) { try { fs.unlinkSync(lockFile); } catch {} }
  };

  // serverfirst-debug B6: the deadline covers the WHOLE ensure, first
  // probe included — it used to be set only after that probe, so slow
  // probes (a loaded machine, a half-dead server) stretched a 20s budget
  // by however long they took (measured: 2000ms budget, 3295ms elapsed).
  const deadline = now() + timeoutMs;

  const first = await probeOnce();
  if (first) return verdict(first.info, first.live);

  // Absent (no file, dead pid, or not answering): one background start try.
  // serverfirst-debug B5: the spawned child used to be fire-and-forget —
  // a serve that died at once (a bad install, a port clash) looked the
  // same as a slow one and the CLI just waited out the full timeout.
  // Watch it: if it exits/errors and no discovery file ever appeared,
  // the start failed and we can say so immediately.
  let child = null;
  let childGone = null;
  let locked = false;
  // B1: a live owner is waited for, never raced. B2: when the lock is
  // held, another starter is already spawning — poll for theirs instead
  // of adding a rival (the loser of the old race ran undiscoverable and
  // could steal the discovery file from the healthy winner).
  if (!filePidAlive && tryLock()) {
    locked = !!lockFile;
    try { child = spawnServer(); } catch (e) { releaseLock(); return {status: 'failed', reason: 'start-failed', detail: String(e?.message || e)}; }
    if (child && typeof child.once === 'function') {
      child.once('error', e => { childGone = {error: String(e?.message || e)}; });
      child.once('exit', code => { childGone = {code}; });
    }
  }
  try {
    for (;;) {
      const hit = await probeOnce();
      if (hit) return verdict(hit.info, hit.live);
      if (childGone && !sawFile) return {status: 'failed', reason: 'start-failed', detail: childGone.error || ('the started Server exited with code ' + childGone.code)};
      if (now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  } finally {
    if (locked) releaseLock();
  }
  return {status: 'failed', reason: sawFile ? 'unreachable' : 'not-found'};
}

// True when a running server is an OLDER build than this CLI. The protocol
// can stay the same across releases, so an updated muser attaches to the
// resident server that logon autostart started from the previous install,
// and every conversation keeps running the old code until that server
// restarts. Unknown or malformed versions are not "older".
function olderServer(serverVersion, ownVersion) {
  const parse = v => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? m.slice(1).map(Number) : null; };
  const a = parse(serverVersion), b = parse(ownVersion);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}

// After an update the resident server (started at logon, or by the GUI) still runs
// the previous build, and every conversation runs its code. When it is older than
// this CLI and idle — no conversation working or waiting for an approval — stop it
// so the caller can start the current build (ensureServer). A busy server is left
// alone: stopping it would cut a running turn. Returns {restarted: true} once the
// old server is gone, or {restarted: false, reason}.
async function stopOlderServer({info, live, ownVersion, request, probe, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 10000, pollMs = 250} = {}) {
  if (!info || !live || !olderServer(live.version, ownVersion)) return {restarted: false, reason: 'not-older'};
  const sessions = Array.isArray(live.sessions) ? live.sessions : [];
  if (sessions.some(s => s && (s.busy || s.approval))) return {restarted: false, reason: 'busy'};
  let res = null;
  try { res = await request(info, 'POST', '/api/server/stop', {}); } catch { res = null; }
  if (!res || res.status >= 400) return {restarted: false, reason: 'stop-failed'};
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    let alive = null;
    try { alive = await probe(info); } catch { alive = null; }
    if (!alive) return {restarted: true};
    await sleep(pollMs);
  }
  return {restarted: false, reason: 'still-running'};
}

module.exports = {ensureServer, verdict, olderServer, stopOlderServer, PROTOCOL, DEFAULT_TIMEOUT_MS};
