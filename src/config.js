'use strict';
// ~/.muser/config.json, shared by the language choice, skills and the user's own settings
// (maxAgents, updateCheck, bell …). A file that does not parse (a hand edit with a stray comma)
// used to be read as {} and written back as just the one changed key, wiping every other
// setting. It is now moved aside as config.json.corrupt-<time> first, and writes go through a
// temp file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function file() { return path.join(os.homedir(), '.muser', 'config.json'); }

// JSON a person saved: Windows PowerShell's Set-Content -Encoding utf8 (and Notepad's "UTF-8 with
// BOM") puts a BOM first, and JSON.parse refuses it, so a hand-edited config.json was ignored
// whole and then moved aside as corrupt on the next /lang.
function parseJson(raw) { const s = String(raw); return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s); }
function readJson(f) { return parseJson(fs.readFileSync(f, 'utf8')); }

function read() {
  try { const v = readJson(file()); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

// Small lock around a read-modify-write (same shape as sessions.locked): config.json is
// shared by every muser window, and two windows updating at once used to drop one change.
// The lock file carries an ownership token and only its owner unlinks it; a lock older than
// 5 s is taken to be left by a crashed window, and a lock that cannot be taken within 2 s is
// not waited on forever — the update proceeds without it and leaves that lock file alone.
function withLock(f, fn) {
  const lock = f + '.lock', token = crypto.randomBytes(16).toString('hex'), until = Date.now() + 2000;
  fs.mkdirSync(path.dirname(f), {recursive: true});
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      // Windows answers EPERM / EBUSY / EACCES for a lock file still being deleted by its last
      // holder: that is "taken", not "locks do not work here" (it went ahead unlocked).
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return fn();
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) return fn();
      const end = Date.now() + 15; while (Date.now() < end) {}
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {} }
}

// Change it: fn gets the current settings and edits them in place.
function update(fn) { return withLock(file(), () => updateUnlocked(fn)); }
function updateUnlocked(fn) {
  const f = file();
  let cfg = {}, raw = null;
  try { raw = fs.readFileSync(f, 'utf8'); } catch {}
  if (raw !== null && raw.trim()) {
    try { const v = parseJson(raw); cfg = v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch { try { fs.renameSync(f, f + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {} }
  }
  fn(cfg);
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const temp = f + '.tmp-' + process.pid + '-' + Date.now();
  try { fs.writeFileSync(temp, JSON.stringify(cfg, null, 2)); renameRetry(temp, f); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  return cfg;
}
// Windows refuses to replace a file another process has open for reading (EPERM): with other
// muser windows reading config.json, 145-150 of 150 saves failed outright in a stress run
// ("could not change the setting"). The read is over in a moment, so wait briefly and retry.
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * (i + 1), 50));
    }
  }
}

module.exports = {file, read, update, parseJson, readJson, withLock, renameRetry};
