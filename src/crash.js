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

// The error and the trail get the same treatment as the state: shapes, never content
// (audit #33). An exception's message can carry what the user typed, a command string
// or a file fragment (parse errors, tool errors), and its stack repeats that message
// plus local paths — so the stack is dropped whole and only the first line of the
// message is kept, with quoted spans and key=value parameters stripped out of it.
// What remains (the error name and the message's own first-line wording, e.g.
// "Maximum update depth exceeded") is what identifies the crash.
function safeErrorText(error) {
  let name = '', message = '';
  try {
    if (error && typeof error === 'object') { name = String(error.name || ''); message = String(error.message ?? error); }
    else if (error !== undefined && error !== null) message = String(error);
  } catch { return 'unknown error'; }
  if (!message) return 'unknown error';
  let first = message.split(/\r?\n/)[0]
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '<quoted>')
    .replace(/([\w.-]+)=[^\s,;]+/g, '$1=<redacted>')
    .slice(0, 300);
  if (name && name !== 'Error' && !first.startsWith(name)) first = name + ': ' + first;
  return first || 'unknown error';
}

// A trail entry's second element is, by construction (Controller.set / trace), the
// comma-joined NAMES of the state keys that changed — identifiers and commas only.
// Anything else in that slot is content that rode in by mistake: keep its slot and
// timestamp, drop the text.
function safeTrailWhat(v) {
  const s = String(v ?? '');
  return /^[\w,.-]*$/.test(s) && s.length <= 200 ? s : '<redacted>';
}

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
    // The timestamp alone (millisecond precision) collided when several windows
    // crashed in the same millisecond — exactly the shared-cause crash this
    // reporter exists for — and the later write replaced the earlier report
    // (c11 #11). Pid plus a random suffix keep every report.
    const file = path.join(d, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + require('node:crypto').randomBytes(4).toString('hex') + '.json');
    let safeState; try { safeState = shape(state); } catch { safeState = shape({}); }
    let safeTrail = [];
    try { safeTrail = list(trail).map(e => (Array.isArray(e) ? [e[0], safeTrailWhat(e[1])] : [null, safeTrailWhat(e)])); } catch { safeTrail = []; }
    let errorText; try { errorText = safeErrorText(error); } catch { errorText = 'unknown error'; }
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

module.exports = {write, shape, dir, safeErrorText, safeTrailWhat};
