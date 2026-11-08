'use strict';
// The startup guard (EXPORT.md stage 2): installed by bin/muser.js at the
// very top — after the V8 and threadpool setup, before every other module
// loads — because src/crash.js was only ever installed once a screen had
// opened (src/ui/boot.mjs), so a muser that died DURING startup (a failed
// require, a syntax error, a missing dependency) left nothing behind.
// The guard catches uncaughtException / unhandledRejection, writes the
// usual crash record (src/crash.js, whose only dependencies are the
// standard library and src/stack-format.js), and — while no screen owns
// the process yet — prints the short way out and exits:
//
//   起動できませんでした（<エラーの名前>）。muser export で開発者に送れます。記録: <パス>
//
// Once the TUI (boot.mjs) or the resident Server (server-crash.js) has
// installed its own crash handling it sets globalThis.__muserCrashHandledByApp
// and this guard steps aside: those handlers restore the screen and record
// with the window's state, and a second record of the same crash would
// only push an older one out of the kept twenty. `muser export` itself is
// dispatched before this matters (bin's first-word branch), and the export
// entry points never install the guard.
const crash = require('./crash');

let installed = false;
let version = '';

function errorName(e) {
  try { return (e && typeof e === 'object' && e.name) ? String(e.name) : 'Error'; } catch { return 'Error'; }
}

// The record + the short line. Returns the record's path (or null).
// Exported for tests; the handlers below are what bin installs.
function recordStartupCrash(e, v) {
  let file = null;
  try { file = crash.write({version: v || version, error: e, scope: 'startup'}); } catch {}
  try {
    process.stderr.write('起動できませんでした（' + errorName(e) + '）。muser export で開発者に送れます。' + (file ? '記録: ' + file : '') + '\n');
  } catch {}
  return file;
}

function onFatal(e) {
  if (globalThis.__muserCrashHandledByApp) return; // the screen / server handler owns it
  recordStartupCrash(e);
  process.exit(1);
}

function installStartupGuard({v = ''} = {}) {
  if (installed) return;
  installed = true;
  version = v;
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
}

module.exports = {installStartupGuard, recordStartupCrash, errorName};
