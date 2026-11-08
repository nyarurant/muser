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
// The pre-fix key: a purely lexical, lower-cased path. Kept so load/update can
// still find (and migrate) entries remembered before the key became canonical.
function legacyKey(cwd) { return path.resolve(cwd || '.').replace(/[\\/]+$/, '').toLowerCase(); }
// A folder's key must be its real identity, not one spelling of it (c29 #10):
// path.resolve alone splits one folder into several keys when it is reached
// through a junction / symlink / 8.3 short name / UNC spelling, so the mode
// remembered there silently stopped applying; and unconditional lower-casing
// merged two genuinely different folders on case-sensitive NTFS directories
// into one entry, leaking a mode (bypass included) to a folder never chosen.
// realpath resolves the spelling AND returns the on-disk casing, which unifies
// case variants of the same folder on ordinary Windows volumes while keeping
// case-distinct folders apart. A path that does not exist (yet) cannot be
// resolved, so it keeps the old lexical lower-cased key.
function key(cwd) {
  const resolved = path.resolve(cwd || '.').replace(/[\\/]+$/, '');
  try { return fs.realpathSync.native(resolved).replace(/[\\/]+$/, '') || resolved.toLowerCase(); }
  catch { return resolved.toLowerCase(); }
}

// {bad: true} when the file is there but is not a permissions file (a hand edit with a stray comma):
// the next change wrote back only its own folder and erased every other folder's mode and keys.
// Only a missing file is "nothing remembered yet": any other read error left an empty set that the
// next change wrote back, erasing every other folder. It now reads as {unreadable}, never written.
function readAll() {
  let raw;
  try { raw = fs.readFileSync(file(), 'utf8'); }
  catch (e) { return {version: 1, folders: {}, ...(e?.code === 'ENOENT' ? {} : {unreadable: true})}; }
  try {
    const j = require('./config').parseJson(raw);
    if (j && j.folders && typeof j.folders === 'object' && !Array.isArray(j.folders)) {
      // Nested entries are validated too (audit #219): one folder's entry written as a
      // string, a number, or {allow: "edit"} by a hand edit used to survive parsing, and
      // update() then threw setting properties on it — a throw its catch-all swallowed,
      // so saveMode/addAllow reported success and nothing was ever persisted. A malformed
      // entry is replaced by an empty one; a malformed allow list keeps only its strings.
      const folders = {};
      for (const [k, v] of Object.entries(j.folders)) {
        folders[k] = v && typeof v === 'object' && !Array.isArray(v)
          ? {...v, mode: typeof v.mode === 'string' ? v.mode : null, allow: Array.isArray(v.allow) ? v.allow.filter(x => typeof x === 'string') : []}
          : {mode: null, allow: []};
      }
      return {...j, folders};
    }
  } catch {}
  return {version: 1, folders: {}, bad: !!raw.trim()};
}
function writeAll(data) {
  const f = file(), temp = f + '.tmp-' + crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.dirname(f), {recursive: true});
  // Retried: a rename over a file another window is reading fails with EPERM on Windows, and
  // update() keeps quiet about failures, so /mode said "remembered" and nothing was saved.
  try { fs.writeFileSync(temp, JSON.stringify(data, null, 1)); require('./config').renameRetry(temp, f); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
// permissions.json is read, changed and written by every muser window; two
// windows doing it at the same moment dropped one's update (one folder's mode
// and "don't ask again" keys erased the other's). A lock file serializes the
// change — config.withLock's: an ownership token (this lock removed whatever lock
// file was there at the end, another window's too after a timed-out wait), and
// EPERM on a lock being deleted counts as taken, not as "no locking here".
function locked(fn) { return require('./config').withLock(file(), fn); }
// Returns whether the change was actually written. The catch-all stays (remembering is
// a convenience and must never break a session), but it no longer reports success for a
// save that never landed (audit #219): callers can see false for an unreadable file, a
// failed write, or an entry fn() rejected.
// Wave 14: the false contract covers the THROWING failures too. The inner catch only
// guards fn()'s read-modify-write; config.withLock throws before fn() ever runs — a
// live window's lock held past the budget, or its mkdir failing with EEXIST when the
// permissions folder's parent is a plain file — and those throws escaped saveMode /
// addAllow / clearAllow raw, past every caller that checks for false (the controller
// rolled nothing back; only the screen's generic catch showed the raw lock text).
// A save that throws is a save that did not land: false, like the rest.
function update(cwd, fn) {
  try {
    return locked(() => {
      try {
        const data = readAll(), k = key(cwd), lk = legacyKey(cwd);
        if (data.unreadable) return false; // never write over a file that could not be read
        if (data.bad) { try { fs.renameSync(file(), file() + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {} delete data.bad; }
        // An entry remembered under the pre-fix lexical key is carried over to
        // the canonical key on the folder's next change, not silently orphaned.
        const entry = data.folders[k] || data.folders[lk] || {mode: null, allow: []};
        fn(entry); entry.updatedAt = new Date().toISOString();
        data.folders[k] = entry; if (lk !== k) delete data.folders[lk]; writeAll(data);
        return true;
      } catch { return false; } // remembering is a convenience; it never breaks a session
    });
  } catch { return false; }
}

// A change marker for the shared file: the byte size plus a SHA-256 hash
// of its exact contents (a content hash), or null when there is no
// readable file. A running window checks this on every approval judgment
// (src/agent.js refreshPermissions): when another window saved, revoked
// or re-moded anything, the stamp moves and the window re-reads the file
// instead of judging from its startup snapshot forever. The token is
// content-based, not timestamp-based, because on Windows mtime/ctime
// share a ~0.5-1ms quantum: a same-size rewrite landing in the same tick
// produced an identical timestamp stamp and the change was silently
// missed. Identical bytes rewritten still yield the same token, which
// is fine — nothing changed.
function stamp() {
  try { const raw = fs.readFileSync(file()); return raw.length + ':' + crypto.createHash('sha256').update(raw).digest('hex'); }
  catch { return null; }
}

// The file's health, for a running window deciding how much to trust a
// changed file (src/agent.js refreshPermissions): 'missing' when there is
// no file, 'corrupt' when the file is there but its JSON cannot be parsed
// into the store shape readAll() expects, 'ok' otherwise. The tolerance is
// readAll()'s own, not a stricter one: a valid store whose entries are
// malformed is 'ok' (readAll normalises those entries), and an empty or
// whitespace-only file is 'ok' too (readAll reads it as nothing remembered,
// its `bad` flag stays off). Any other read failure (the path is a folder,
// a permission error) leaves no JSON to parse, so it counts as 'corrupt'.
function fileState() {
  let raw;
  try { raw = fs.readFileSync(file(), 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' ? 'missing' : 'corrupt'; }
  try {
    const j = require('./config').parseJson(raw);
    if (j && j.folders && typeof j.folders === 'object' && !Array.isArray(j.folders)) return 'ok';
  } catch {}
  return raw.trim() ? 'corrupt' : 'ok';
}

function load(cwd) {
  const folders = readAll().folders;
  const raw = folders[key(cwd)] ?? folders[legacyKey(cwd)];
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {mode: typeof e.mode === 'string' && MODES.includes(e.mode) ? e.mode : null, allow: Array.isArray(e.allow) ? e.allow.filter(x => typeof x === 'string') : []};
}
function saveMode(cwd, mode) { return MODES.includes(mode) ? update(cwd, e => { e.mode = mode; }) : false; }
function addAllow(cwd, k) { return k ? update(cwd, e => { if (!e.allow.includes(k)) e.allow.push(k); }) : false; }
function clearAllow(cwd) { return update(cwd, e => { e.allow = []; }); }

module.exports = {load, saveMode, addAllow, clearAllow, file, key, stamp, fileState};
