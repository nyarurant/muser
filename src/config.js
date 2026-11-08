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
// whole and then moved aside as corrupt on the next /lang. One leading BOM is stripped, but a
// file a pipeline touched twice can carry two, a BOM can sit after leading whitespace, and
// PowerShell 5.1's Out-File writes UTF-16 with a BOM instead of UTF-8 at all (deep audit c24
// #9): every BOM before the first real character is stripped here, and decodeText below reads
// the bytes in the encoding their BOM announces.
function parseJson(raw) {
  let s = String(raw);
  for (;;) { const t = s.replace(/^\uFEFF/, '').replace(/^(\s+)\uFEFF/, '$1'); if (t === s) return JSON.parse(s); s = t; }
}
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2), swapped = Buffer.alloc(body.length - (body.length % 2));
    for (let i = 0; i < swapped.length; i += 2) { swapped[i] = body[i + 1]; swapped[i + 1] = body[i]; }
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}
// Some tools can only write strings, so a switch saved as "false" / "0" used to be read as
// "not a boolean", fall back to the default (usually on) and run the opposite of what the
// file said (fourth audit M16). Wave 14 widened the rescue, key by key: a known switch
// (BOOL_KEYS) reads every common spelling — on/off, yes/no, true/false, 0/1 as a string,
// and the numbers 0/1 — as the value it names, so "off" can no longer come back on; a
// known number (NUMERIC_KEYS) reads a string number ("100") as that number. The rescue
// is keyed because string settings CAN legitimately hold some of these words
// (focusLogLevel / expectMode can be "off"), so unknown keys keep only the older
// true/false/0/1 string rescue, and nested values are left untouched. A value no
// spelling covers is left as-is; the reader for that key falls back to its default.
const BOOL_KEYS = new Set(['focus', 'worklog', 'bangAutoSend', 'bgAutoResume', 'bell', 'updateCheck', 'motion', 'codeWrap', 'footerDevice', 'footerSlot', 'footerName', 'footerUsage', 'footerCwd', 'footerSession', 'footerVersion', 'footerClock', 'color', 'kitty', 'fullscreen', 'lore', 'accountAuto']);
const NUMERIC_KEYS = new Set(['maxToolCallsPerTurn', 'dailyTurnLimit', 'focusRounds', 'worklogDays', 'focusMinutes', 'maxNodeSlots', 'overnightTokenCap', 'overnightMaxTasks', 'maxAgents', 'maxAgentsTotal', 'accountThreshold']);
const BOOL_WORDS = {true: true, 1: true, yes: true, on: true, false: false, 0: false, no: false, off: false};
// The environment's boolean spellings, one set for every settings surface (wave 14):
// 1/true/yes/on turn an override on, 0/false/no/off turn it off; anything else is "not a
// boolean" (null), so each caller can fall back to the saved value instead of guessing.
function envBool(v) {
  if (v === undefined || v === null) return null;
  const low = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(low)) return true;
  if (['0', 'false', 'no', 'off'].includes(low)) return false;
  return null;
}
function normalizeConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  for (const k of Object.keys(v)) {
    if (NUMERIC_KEYS.has(k)) {
      if (typeof v[k] === 'string' && v[k].trim() !== '' && Number.isFinite(Number(v[k]))) v[k] = Number(v[k]);
      continue;
    }
    if (BOOL_KEYS.has(k)) {
      if (typeof v[k] === 'string' && Object.prototype.hasOwnProperty.call(BOOL_WORDS, v[k].trim().toLowerCase())) v[k] = BOOL_WORDS[v[k].trim().toLowerCase()];
      else if (v[k] === 0) v[k] = false;
      else if (v[k] === 1) v[k] = true;
      continue;
    }
    if (typeof v[k] !== 'string') continue;
    const low = v[k].trim().toLowerCase();
    if (low === 'false' || low === '0') v[k] = false;
    else if (low === 'true' || low === '1') v[k] = true;
  }
  return v;
}
function readJson(f) { return normalizeConfig(parseJson(decodeText(fs.readFileSync(f)))); }

// Wave 14 (D12): a config.json that cannot be read as settings used to surface
// nowhere — reads quietly returned the defaults and the first save quietly moved the
// broken file aside. The fact is remembered here (once per distinct broken content;
// a move-aside is its own fact) and /settings takes it with takeCorruptNotice() to
// show it once when the settings are opened.
let corruptNotice = null, corruptNoticeTakenFor = null;
function flagCorrupt(sig, dest) {
  if (!dest && sig === corruptNoticeTakenFor) return;
  corruptNotice = {file: file(), dest: dest || null, sig};
}
function takeCorruptNotice() { const n = corruptNotice; corruptNotice = null; if (n) corruptNoticeTakenFor = n.sig; return n; }

function read() {
  const f = file();
  let buf;
  try { buf = fs.readFileSync(f); } catch { return {}; }
  const text = decodeText(buf);
  if (!text.trim()) return {};
  let v = null;
  try { v = normalizeConfig(parseJson(text)); } catch {}
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  flagCorrupt(crypto.createHash('sha256').update(buf).digest('hex'), null);
  return {};
}

// Small lock around a read-modify-write (same shape as sessions.locked): config.json is
// shared by every muser window, and two windows updating at once used to drop one change.
// The lock file carries an ownership token and only its owner unlinks it; a lock older than
// 5 s is taken to be left by a crashed window. First audit #19: a lock that could not be
// taken within the budget used to be ignored — the update ran WITHOUT the lock and the
// later writer silently wiped the other window's change — and the wait was a 15 ms
// busy-spin. Now the wait sleeps (Atomics.wait, as renameRetry does), the budget (6 s)
// lasts past the stale age so a crashed window's lock really is taken over, and on timeout
// the lock THROWS instead of running unlocked, exactly as sessions.locked and
// usage.withLock do; callers already surface a failed update as "could not change the
// setting". Deep audit c24 #10: every retry path — including a stale lock whose stat or
// unlink keeps throwing (the lock path turned into a directory, say) — passes through the
// deadline check and the sleep, so a broken lock state fails in budget instead of looping
// forever with the event loop frozen.
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { try { Atomics.wait(LOCK_WAIT, 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} } }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
function withLock(f, fn, {budgetMs = 6000, staleMs = 5000} = {}) {
  const lock = f + '.lock', token = crypto.randomBytes(16).toString('hex'), until = Date.now() + budgetMs;
  // As in sessions.locked, the lock carries its holder's pid next to the token: a lock
  // whose holder is still alive is never taken over, however old it gets — the 6 s budget
  // outlasts the 5 s stale age, and a slow-but-live window's lock must not be stolen from
  // under it. Only a dead holder's lock, or a legacy token-only lock older than staleMs,
  // is claimed.
  const content = token + ':' + process.pid;
  fs.mkdirSync(path.dirname(f), {recursive: true});
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      // Windows answers EPERM / EBUSY / EACCES for a lock file still being deleted by its last
      // holder: that is "taken", not "locks do not work here".
      let took = false;
      try {
        const ownerPid = Number((fs.readFileSync(lock, 'utf8').split(':')[1] || '').trim());
        const stale = ownerPid > 0 ? !pidAlive(ownerPid) : Date.now() - fs.statSync(lock).mtimeMs > staleMs;
        if (stale) { fs.unlinkSync(lock); took = true; }
      } catch {}
      if (took) continue;
      if (Date.now() > until) {
        if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        throw new Error(path.basename(f) + ' is locked by another muser window');
      }
      sleepSync(15);
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === content) fs.unlinkSync(lock); } catch {} }
}

// Change it: fn gets the current settings and edits them in place.
function update(fn) { return withLock(file(), () => updateUnlocked(fn)); }
function updateUnlocked(fn) {
  const f = file();
  let cfg = {}, raw = null;
  // Fifth audit f1-1: a READ failure (a momentary EACCES while another process holds the
  // file) is not "no settings": starting from {} rewrote the file with just the one changed
  // key and wiped every other setting, with no corrupt backup because nothing had failed
  // to parse. Only ENOENT means "no file yet"; anything else aborts the update and leaves
  // the file exactly as it was.
  try { raw = decodeText(fs.readFileSync(f)); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (raw !== null && raw.trim()) {
    let v = null, isObject = false;
    try { v = parseJson(raw); isObject = !!(v && typeof v === 'object' && !Array.isArray(v)); } catch {}
    if (isObject) cfg = normalizeConfig(v);
    // Fourth audit M15 (deep c24 #11): the move-aside guarantee covered only a parse
    // FAILURE. Valid JSON that is not an object ([...], "ja", 42, null) parsed fine, read
    // as {} and was overwritten with no backup anywhere. Both shapes are moved aside.
    else { const dest = f + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-'); try { fs.renameSync(f, dest); flagCorrupt(dest, dest); } catch {} }
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

module.exports = {file, read, update, parseJson, readJson, withLock, renameRetry, envBool, takeCorruptNotice};
