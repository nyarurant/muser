'use strict';
// The Server's default conversation must never run in a Windows system
// folder (FOCUS-WEAKNESSES.md #12): the logon launcher used to start
// `muser serve` with no working folder, so the process — and the default
// conversation it opened — ran in C:\WINDOWS\system32, the logon working
// folder. A system folder is never a workspace anyone chose: the default
// cwd is the user's home folder instead. An explicit --cd still wins;
// this only replaces a folder nobody asked for.
const os = require('node:os');
const path = require('node:path');

function normalize(p) {
  let s = String(p || '').replace(/\//g, '\\').toLowerCase();
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

function systemRoots(systemRoot) {
  const root = normalize(systemRoot || process.env.SystemRoot || 'C:\\Windows');
  return [root, root + '\\system32', root + '\\syswow64'];
}

function isWindowsSystemFolder(cwd, {systemRoot, platform = process.platform} = {}) {
  if (platform !== 'win32') return false;
  if (typeof cwd !== 'string' || !cwd) return false;
  const c = normalize(path.resolve(cwd));
  return systemRoots(systemRoot).some(r => c === r || c.startsWith(r + '\\'));
}

function resolveDefaultCwd(cwd, home = os.homedir(), opts = {}) {
  if (typeof cwd !== 'string' || !cwd) return cwd;
  return isWindowsSystemFolder(cwd, opts) ? home : cwd;
}

module.exports = {isWindowsSystemFolder, resolveDefaultCwd};
