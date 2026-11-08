'use strict';
// The watchdog's worker half (see src/ui/watchdog.js): watches the main
// thread's heartbeat in shared memory, and when the screen has not
// answered for thresholdMs, asks the main thread's inspector where it is
// stopped (Debugger.pause), takes the call frames, resumes it, and
// writes ONE hang record per freeze into the crash folder — the same
// folder, the same shaped stack (src/stack-format.js) as a crash record,
// marked kind:'hang'. A freeze that continues does not write again: the
// record is re-armed only after the heartbeat moves again. Everything is
// best-effort; a watchdog that breaks must never take the window with it.
const {workerData} = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inspector = require('node:inspector');
const {frameOf} = require('../stack-format');

const view = new BigInt64Array(workerData.sab);
const THRESHOLD = workerData.thresholdMs || 5000;
const MAX_RECORDS = 5;
let recordedFor = 0; // the heartbeat value a record was already written for
let records = 0;
let capturing = false;

function captureStack() {
  return new Promise(resolve => {
    let done = false;
    const session = new inspector.Session();
    const scripts = new Map();
    const fin = v => { if (!done) { done = true; try { session.disconnect(); } catch {} resolve(v); } };
    try { session.connectToMainThread(); } catch { fin([]); return; }
    session.on('Debugger.scriptParsed', ev => { try { scripts.set(ev.params.scriptId, ev.params.url || ''); } catch {} });
    session.on('Debugger.paused', ev => {
      let frames = [];
      try {
        frames = (ev.params.callFrames || []).slice(0, 50).map(f => frameOf(f.functionName, scripts.get(f.location.scriptId) || f.url || '', (f.location.lineNumber ?? -1) + 1, (f.location.columnNumber ?? -1) + 1, {username: workerData.username || ''}));
      } catch {}
      try { session.post('Debugger.resume', () => fin(frames)); } catch { fin(frames); }
    });
    try {
      session.post('Debugger.enable', err => { if (err) { fin([]); return; } session.post('Debugger.pause', () => {}); });
    } catch { fin([]); return; }
    setTimeout(() => fin([]), 2500);
  });
}

function writeHang(stack, stalledMs) {
  try {
    const dir = workerData.crashDir;
    fs.mkdirSync(dir, {recursive: true});
    const now = new Date();
    const file = path.join(dir, now.toISOString().replace(/[:.]/g, '-') + '-' + workerData.pid + '-hang-' + Math.random().toString(16).slice(2, 6) + '.json');
    const record = {muser: workerData.version || '', node: process.version, windows: os.release(), kind: 'hang', at: now.toISOString(), pid: workerData.pid, sessionId: workerData.sessionId || null, thresholdMs: THRESHOLD, stalledMs, stack};
    fs.writeFileSync(file, JSON.stringify(record, null, 1));
    return file;
  } catch { return null; }
}

setInterval(async () => {
  if (capturing) return;
  let last = 0;
  try { last = Number(Atomics.load(view, 0)); } catch { return; }
  const now = Date.now();
  if (now - last <= THRESHOLD) { recordedFor = 0; return; }
  if (recordedFor === last || records >= MAX_RECORDS) return;
  recordedFor = last;
  capturing = true;
  try {
    const stack = await captureStack();
    records++;
    writeHang(stack, now - last);
  } catch {} finally { capturing = false; }
}, 500);
