'use strict';
// Approval state that outlives a run, per working folder: the approval mode last chosen there
// and the "don't ask again" keys (policy.alwaysKey: 'edit', 'exec:git status', 'mcp:…').
// Stored in ~/.muser/permissions.json, never inside the project. Every mode is kept, bypass too
// (the user's choice); the footer always shows the mode a run starts in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {MODES} = require('./policy');

function file() { return process.env.MUSER_PERMISSIONS_FILE || path.join(os.homedir(), '.muser', 'permissions.json'); }
function key(cwd) { return path.resolve(cwd || '.').replace(/[\\/]+$/, '').toLowerCase(); }

// {bad: true} when the file is there but is not a permissions file (a hand edit with a stray comma):
// the next change wrote back only its own folder and erased every other folder's mode and keys.
function readAll() {
  let raw; try { raw = fs.readFileSync(file(), 'utf8'); } catch { return {version: 1, folders: {}}; }
  try { const j = require('./config').parseJson(raw); if (j && j.folders && typeof j.folders === 'object' && !Array.isArray(j.folders)) return j; } catch {}
  return {version: 1, folders: {}, bad: !!raw.trim()};
}
function writeAll(data) {
  const f = file(), temp = f + '.tmp-' + crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.dirname(f), {recursive: true});
  try { fs.writeFileSync(temp, JSON.stringify(data, null, 1)); fs.renameSync(temp, f); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
function update(cwd, fn) {
  try {
    const data = readAll(), k = key(cwd);
    if (data.bad) { try { fs.renameSync(file(), file() + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {} delete data.bad; }
    const entry = data.folders[k] || {mode: null, allow: []};
    fn(entry); entry.updatedAt = new Date().toISOString();
    data.folders[k] = entry; writeAll(data);
  } catch {} // remembering is a convenience; it never breaks a session
}

function load(cwd) {
  const e = readAll().folders[key(cwd)] || {};
  return {mode: typeof e.mode === 'string' && MODES.includes(e.mode) ? e.mode : null, allow: Array.isArray(e.allow) ? e.allow.filter(x => typeof x === 'string') : []};
}
function saveMode(cwd, mode) { if (MODES.includes(mode)) update(cwd, e => { e.mode = mode; }); }
function addAllow(cwd, k) { if (k) update(cwd, e => { if (!e.allow.includes(k)) e.allow.push(k); }); }
function clearAllow(cwd) { update(cwd, e => { e.allow = []; }); }

module.exports = {load, saveMode, addAllow, clearAllow, file, key};
