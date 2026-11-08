'use strict';
// Muser Server crash isolation (FOCUS-WEAKNESSES.md #11): the resident
// server hosts up to 6 conversations plus the phone link in one process,
// and Node ends the process on an uncaught exception or an unhandled
// rejection — so one conversation's unexpected error used to stop them
// all, with no crash record at all (src/crash.js was only wired into the
// TUI). These handlers are the server's equivalent:
//  - an error that names a conversation (error.sessionId, or the same
//    field on error.cause / error.session.id) closes only that
//    conversation — the rest keep answering — and the crash is recorded;
//  - an error that names no conversation is fatal: it is recorded, the
//    server stops, and a fresh server is started, at most 5 times in
//    10 minutes (a crash loop must not respawn forever).
// Background work that knows its conversation should tag the error with
// sessionId; untagged errors cannot be attributed and take the fatal path.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {renameRetry} = require('../config');

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

function sessionIdOf(error) {
  let cur = error, depth = 0;
  while (cur && typeof cur === 'object' && depth < 5) {
    if (typeof cur.sessionId === 'string' && cur.sessionId) return cur.sessionId;
    if (typeof cur.conversationId === 'string' && cur.conversationId) return cur.conversationId;
    if (typeof cur.session === 'string' && cur.session) return cur.session;
    if (cur.session && typeof cur.session === 'object' && typeof cur.session.id === 'string' && cur.session.id) return cur.session.id;
    cur = cur.cause; depth++;
  }
  return null;
}

function restartStateFile(home = os.homedir()) { return path.join(home, '.muser', 'server-restarts.json'); }

function readRestarts(file, now = Date.now()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  let list;
  try { list = JSON.parse(raw); }
  catch {
    // A torn write (cut short by the very crash it was recording) used to
    // fail here silently and answer []: the whole 5-in-10-min budget came
    // back at once and a crash loop could restart forever. Move the bad
    // bytes aside first so the reset is visible and auditable, then empty.
    try { fs.renameSync(file, file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {}
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter(t => typeof t === 'number' && now - t < RESTART_WINDOW_MS);
}

function restartAllowed(file, now = Date.now()) { return readRestarts(file, now).length < MAX_RESTARTS; }

function recordRestart(file, now = Date.now()) {
  // Atomic write (unique temp + renameRetry, as every other store): a
  // direct writeFileSync cut short by a crash left a torn file behind, and
  // readRestarts then read the budget as empty (see above).
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(temp, JSON.stringify([...readRestarts(file, now), now]));
    renameRetry(temp, file);
  } catch { try { fs.unlinkSync(temp); } catch {} }
}

// Start a fresh server process with this process's arguments. Returns
// false when the restart budget is spent (or the spawn itself failed);
// the caller then exits instead of restarting.
function tryRestart({spawnFn = spawn, stateFile = restartStateFile(), argv = process.argv.slice(1), now = Date.now()} = {}) {
  if (!restartAllowed(stateFile, now)) return false;
  recordRestart(stateFile, now);
  try {
    const child = spawnFn(process.execPath, argv, {detached: true, stdio: 'ignore'});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch { return false; }
}

function createServerCrashHandler({version, host, crashWrite, exit, onFatal, spawnFn, stateFile} = {}) {
  const write = crashWrite || require('../crash').write;
  const doExit = exit || (code => process.exit(code));
  return async (kind, error) => {
    try {
      const sessionId = sessionIdOf(error);
      const open = sessionId && host && typeof host.get === 'function' ? host.get(sessionId) : null;
      let file = null;
      try { file = write({version, error, sessionId: sessionId || undefined, scope: open ? 'session' : 'fatal'}); } catch {}
      if (open) {
        try {
          if (typeof host.closeSync === 'function') host.closeSync(sessionId, 'crashed');
          else if (typeof host.close === 'function') host.close(sessionId, {force: true, reason: 'crashed'});
        } catch {}
        try { process.stderr.write('muser server: conversation ' + sessionId.slice(0, 8) + ' closed after an uncaught ' + kind + (file ? ' (crash report: ' + file + ')' : '') + '\n'); } catch {}
        return {handled: 'session', sessionId, file};
      }
      try { process.stderr.write('muser server: fatal uncaught ' + kind + (file ? ' (crash report: ' + file + ')' : '') + '\n'); } catch {}
      if (typeof onFatal === 'function') { try { await onFatal(error, {file}); } catch {} return {handled: 'fatal', file}; }
      const restarted = tryRestart({spawnFn, stateFile});
      try { doExit(restarted ? 0 : 1); } catch {}
      return {handled: 'fatal', file, restarted};
    } catch { return {handled: 'unknown'}; }
  };
}

let installed = null;
function installServerCrashHandlers(opts = {}) {
  if (installed) return installed.uninstall;
  const handle = createServerCrashHandler(opts);
  const onUncaught = error => { handle('uncaughtException', error).catch(() => {}); };
  const onUnhandled = reason => { handle('unhandledRejection', reason).catch(() => {}); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  globalThis.__muserCrashHandledByApp = true; // the startup guard (src/startup-guard.js) steps aside
  const uninstall = () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    if (installed && installed.uninstall === uninstall) installed = null;
  };
  installed = {uninstall, handle};
  return uninstall;
}

module.exports = {MAX_RESTARTS, RESTART_WINDOW_MS, sessionIdOf, restartStateFile, readRestarts, restartAllowed, recordRestart, tryRestart, createServerCrashHandler, installServerCrashHandlers};
