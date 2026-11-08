'use strict';
// A stack, reduced to its shape (EXPORT.md stage 2): the sequence of
// function name / file / line / column, nothing else. A raw stack repeats
// the error message (which can quote the user's words) and carries local
// paths, so crash records never kept one at all (audit #33) — this is the
// middle ground: enough to find WHERE it stopped, without WHAT was in
// the variables. File paths inside the muser install keep their relative
// shape with the user name rewritten to <user>; a path outside the
// install (the user's own code, a dependency's home) keeps only its file
// name. Node built-ins keep their node: name. Standard library only, so
// the startup guard and the watchdog worker can both use it.
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function shapePath(p, {root = ROOT, username = ''} = {}) {
  let s = String(p || '');
  if (!s) return '';
  s = s.replace(/^file:\/\//, '').replace(/^file:/, '');
  try { s = decodeURIComponent(s); } catch {}
  if (s.startsWith('node:')) return s;
  const norm = s.replace(/\//g, '\\');
  const rootNorm = String(root || '').replace(/\//g, '\\');
  let out;
  if (rootNorm && norm.toLowerCase().startsWith(rootNorm.toLowerCase())) out = norm.slice(rootNorm.length).replace(/^\\+/, '');
  else out = path.basename(norm);
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/:*?"<>|\s]+/gi, '$1<user>');
  if (username && username.length >= 3) out = out.split(username).join('<user>');
  return out;
}

// One CDP call frame (the watchdog's Debugger.paused) or one V8 stack
// line, as {fn, file, line, column}. Lines/columns are 1-based.
function frameOf(fn, file, line, column, opts) {
  return {fn: String(fn || '') || '(anonymous)', file: shapePath(file, opts), line: Number.isFinite(line) ? line : null, column: Number.isFinite(column) ? column : null};
}

// Parse an Error's .stack text. The first line (the message) is skipped:
// safeErrorText() in src/crash.js owns the message, under its own rules.
function parseStack(stack, opts = {}) {
  const frames = [];
  for (const line of String(stack || '').split(/\r?\n/)) {
    const m = /^\s*at\s+(?:async\s+)?(.*?)?\s*\((.+):(\d+):(\d+)\)\s*$/.exec(line)
      || /^\s*at\s+(?:async\s+)?(.+):(\d+):(\d+)\s*$/.exec(line);
    if (!m) continue;
    if (m.length === 5) frames.push(frameOf(m[1], m[2], Number(m[3]), Number(m[4]), opts));
    else frames.push(frameOf('', m[1], Number(m[2]), Number(m[3]), opts));
    if (frames.length >= 50) break;
  }
  return frames;
}
function stackOf(error, opts = {}) {
  try { return parseStack(error && error.stack ? error.stack : '', opts); } catch { return []; }
}

module.exports = {parseStack, stackOf, shapePath, frameOf};
