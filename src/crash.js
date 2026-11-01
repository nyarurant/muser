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

// The controller state, reduced to what does not carry content.
function shape(s = {}) {
  return {
    busy: !!s.busy, entries: (s.entries || []).length, textLength: String(s.text || '').length,
    stream: s.stream ? {partialLength: String(s.stream.partial || '').length} : null,
    running: s.running ? {command: s.running.call?.command, tailLines: (s.running.tail || []).length} : null,
    approval: s.approval ? {kind: s.approval.call?.kind, options: (s.approval.options || []).length} : null,
    menu: !!s.menu, todos: (s.todos || []).length, attachments: (s.attachments || []).length,
    agents: (s.agents || []).map(a => a.state), shells: (s.shells || []).filter(x => x.running).length,
    mode: s.mode, flash: !!s.flash, deviceOk: !!s.deviceOk,
  };
}

function write({version, error, state, trail}) {
  const d = dir();
  fs.mkdirSync(d, {recursive: true});
  const file = path.join(d, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  const report = {
    muser: version, node: process.version, windows: os.release(),
    terminal: {columns: process.stdout.columns, rows: process.stdout.rows, TERM: process.env.TERM || '', TERM_PROGRAM: process.env.TERM_PROGRAM || '', windowsTerminal: !!process.env.WT_SESSION, vscode: process.env.TERM_PROGRAM === 'vscode', conEmu: !!process.env.ConEmuPID},
    error: String(error?.stack || error),
    state: shape(state),
    trail: (trail || []).map(([at, keys]) => [at, keys]),
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  return file;
}

module.exports = {write, shape, dir};
