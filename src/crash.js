'use strict';
// When the TUI dies (an exception nothing caught), keep enough to find out why: versions, the
// terminal, the error, and the last state changes the screen went through. On 2026-11-01 a user's
// muser died with React's "Maximum update depth exceeded" and nothing was left to tell what had
// been happening. Only shapes are written (which state keys changed, counts, sizes), never what
// the user typed or what Muse said.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = () => process.env.MUSER_CRASH_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser', 'crash');
const KEEP = 20;

const list = v => (Array.isArray(v) ? v : []);

// The controller state, reduced to what does not carry content. Tolerant of odd shapes:
// the reporter runs while the app is already broken, so its inputs cannot be trusted.
function shape(s = {}) {
  if (!s || typeof s !== 'object') s = {};
  return {
    busy: !!s.busy, entries: list(s.entries).length, textLength: String(s.text || '').length,
    stream: s.stream ? {partialLength: String(s.stream.partial || '').length} : null,
    running: s.running ? {command: s.running.call?.command, tailLines: list(s.running.tail).length} : null,
    approval: s.approval ? {kind: s.approval.call?.kind, options: list(s.approval.options).length} : null,
    menu: !!s.menu, todos: list(s.todos).length, attachments: list(s.attachments).length,
    agents: list(s.agents).map(a => a?.state), shells: list(s.shells).filter(x => x?.running).length,
    mode: s.mode, flash: !!s.flash, deviceOk: !!s.deviceOk,
  };
}

// Prune old reports, keeping the newest KEEP. Best-effort: a pruning failure must not
// turn a written report into a failure.
function prune(d) {
  try {
    const files = fs.readdirSync(d).filter(f => f.endsWith('.json'))
      .map(f => { let m = 0; try { m = fs.statSync(path.join(d, f)).mtimeMs; } catch {} return {f, m}; })
      .sort((a, b) => a.m - b.m || (a.f < b.f ? -1 : 1));
    while (files.length > KEEP) { const {f} = files.shift(); try { fs.unlinkSync(path.join(d, f)); } catch {} }
  } catch {}
}

// Fully best-effort: the crash reporter must never throw. It is called from uncaughtException /
// unhandledRejection handlers, where a second throw would lose the original crash entirely.
// Returns the report path, or null when no report could be written.
function write(input) {
  try {
    const {version, error, state, trail} = input || {};
    const d = dir();
    fs.mkdirSync(d, {recursive: true});
    const file = path.join(d, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    let safeState; try { safeState = shape(state); } catch { safeState = shape({}); }
    let safeTrail = [];
    try { safeTrail = list(trail).map(e => (Array.isArray(e) ? [e[0], e[1]] : [null, String(e ?? '')])); } catch { safeTrail = []; }
    let errorText; try { errorText = String(error?.stack || error); } catch { errorText = 'unknown error'; }
    const report = {
      muser: version, node: process.version, windows: os.release(),
      terminal: {columns: process.stdout.columns, rows: process.stdout.rows, TERM: process.env.TERM || '', TERM_PROGRAM: process.env.TERM_PROGRAM || '', windowsTerminal: !!process.env.WT_SESSION, vscode: process.env.TERM_PROGRAM === 'vscode', conEmu: !!process.env.ConEmuPID},
      error: errorText,
      state: safeState,
      trail: safeTrail,
    };
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    prune(d);
    return file;
  } catch { return null; }
}

module.exports = {write, shape, dir};
