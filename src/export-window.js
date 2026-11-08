'use strict';
// Collecting one running window's live state for `muser export --window`
// (EXPORT.md stage 2). A plain TUI window has no HTTP endpoint; the one
// channel it already maintains is its window-status file
// (src/window-status.js), so the request rides the same folder: the
// collector writes windows/request-<pid>-<id>.json, the window's
// WindowStatus answers within its 1-second watch with
// windows/response-<pid>-<id>.json (its current snapshot plus its events
// ring), and the collector reads and removes its own pair. The id is
// unique per collection, so collectors running at the same time against
// the same window each get their own answer instead of overwriting one
// shared request file (wave 18: the loser used to time out answered:false
// and its cleanup could delete the winner's request). The request is
// written atomically (temp file + rename), so the window never reads a
// half-written one. A window that does not answer in time — frozen, which
// is exactly the case worth reporting — falls back to what is already on
// disk: its last window-status file and the watchdog's newest hang
// record for its pid (src/ui/watchdog-worker.js).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {renameRetry} = require('./config');

function windowsDir() { return require('./window-status').dir(); }
function listWindows() { try { return require('./window-status').readAll(); } catch { return []; } }

// The newest hang record the watchdog wrote for this pid, or null.
function latestHang(pid, dir) {
  try {
    const d = dir || require('./crash').dir();
    const files = fs.readdirSync(d).filter(f => f.endsWith('.json'))
      .map(f => { let m = 0; try { m = fs.statSync(path.join(d, f)).mtimeMs; } catch {} return {f, m}; })
      .sort((a, b) => b.m - a.m);
    for (const {f, m} of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        if (r && r.kind === 'hang' && r.pid === pid) return {file: f, at: new Date(m).toISOString(), thresholdMs: r.thresholdMs ?? null, stack: Array.isArray(r.stack) ? r.stack : []};
      } catch {}
    }
  } catch {}
  return null;
}

// Ask the window and wait. Resolves {answered:true, state, events} or
// {answered:false} after timeoutMs — never rejects: a wedged window is a
// result, not an error.
async function collectWindow(pid, {timeoutMs = 3000, pollMs = 100, dir = windowsDir()} = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const reqFile = path.join(dir, 'request-' + pid + '-' + id + '.json');
  const resFile = path.join(dir, 'response-' + pid + '-' + id + '.json');
  let temp = null;
  try {
    fs.mkdirSync(dir, {recursive: true});
    // Atomic: the request appears whole (temp file + rename), never as a
    // half-written file the window could read and drop.
    temp = reqFile + '.tmp-' + process.pid + '-' + id;
    fs.writeFileSync(temp, JSON.stringify({id, pid, at: new Date().toISOString()}));
    renameRetry(temp, reqFile);
    temp = null;
  } catch { if (temp) { try { fs.unlinkSync(temp); } catch {} } return {answered: false}; }
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() <= deadline) {
      try {
        const raw = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        if (raw && raw.id === id) {
          try { fs.unlinkSync(resFile); } catch {}
          return {answered: true, state: raw.state || null, events: Array.isArray(raw.events) ? raw.events : []};
        }
      } catch {}
      await new Promise(r => setTimeout(r, pollMs));
    }
  } finally {
    // Only this collection's own files: a concurrent collector's request
    // or response for the same window is never ours to remove. (The
    // response unlink also keeps a just-missed answer from being left
    // behind as an orphan no one will ever read.)
    try { fs.unlinkSync(reqFile); } catch {}
    try { fs.unlinkSync(resFile); } catch {}
  }
  return {answered: false};
}

module.exports = {listWindows, collectWindow, latestHang, windowsDir};
