'use strict';
// The freeze watchdog (EXPORT.md stage 2): one worker thread per window
// (installed in src/ui/boot.mjs, so fullscreen, classic and client
// windows all get it) watching a heartbeat the main thread updates four
// times a second through shared memory. When the screen's own processing
// stalls — a busy loop, a wedged render — the heartbeat stops with it,
// and after `thresholdMs` (default 5 s) the worker takes the stopped
// stack through inspector.Session.connectToMainThread() and writes a
// hang record next to the crash records (src/ui/watchdog-worker.js).
// The heartbeat is one BigInt64 in a SharedArrayBuffer and the worker
// idles on a 500 ms timer: the standing cost is a few hundred KB of
// worker heap and no measurable CPU (measured figures are in the
// DevNote). The worker is unref'd and the timer unref'd: the watchdog
// never keeps a window alive, and stop() ends both.
const path = require('node:path');
const os = require('node:os');
const {Worker} = require('node:worker_threads');

const DEFAULT_THRESHOLD_MS = 5000;
const HEARTBEAT_MS = 250;

function startWatchdog({thresholdMs = DEFAULT_THRESHOLD_MS, crashDir = null, version = '', sessionId = null} = {}) {
  let dir = crashDir;
  if (!dir) { try { dir = require('../crash').dir(); } catch { return {stop() {}, worker: null}; } }
  const sab = new SharedArrayBuffer(8);
  const view = new BigInt64Array(sab);
  Atomics.store(view, 0, BigInt(Date.now()));
  let username = '';
  try { username = os.userInfo().username || ''; } catch {}
  let worker = null;
  try {
    worker = new Worker(path.join(__dirname, 'watchdog-worker.js'), {workerData: {sab, thresholdMs, crashDir: dir, version, sessionId, pid: process.pid, username}});
    worker.unref?.();
  } catch { worker = null; }
  const timer = setInterval(() => { try { Atomics.store(view, 0, BigInt(Date.now())); } catch {} }, HEARTBEAT_MS);
  timer.unref?.();
  let stopped = false;
  return {
    worker,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try { worker?.terminate(); } catch {}
    },
  };
}

module.exports = {startWatchdog, DEFAULT_THRESHOLD_MS};
