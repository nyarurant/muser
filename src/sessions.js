'use strict';
// Local index of muser sessions (each one is a Muse side chat), for resume / --continue.
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./secure-store');
const {t} = require('./i18n');

const FILE = store.file('sessions.json');

// A corrupt index must never be silently wiped: move the bad file aside with a
// timestamp and only then start empty, so the original bytes survive for recovery.
// Returns the backup path (or null when the move failed), so a caller whose
// rewrite then fails can put the original back instead of losing the index.
function backupCorruptFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = file + '.corrupt-' + stamp;
  try { fs.renameSync(file, dest); return dest; } catch { return null; }
}
function backupCorrupt() { return backupCorruptFile(FILE); }
// turns on disk is user-restored / hand-edited data too (fourth M19): a garbage
// string used to survive as NaN -> null on the next touch and reset to 1 on the
// one after, and a negative count stayed negative. Every read and merge heals
// it to a non-negative integer ("10" -> 10, "abc" -> 0, -4 -> 0).
function normTurns(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }
// origin marks HOW a conversation was created ('exec' for `muser exec`); no
// origin = an interactive conversation (TUI / serve / GUI). Like turns, a
// hand-edited garbage value is healed on read — a non-string or empty origin
// is dropped — while a real string mark is carried through untouched, so the
// mark survives every read/write of the index and old files without one
// keep loading exactly as before.
function healEntry(s) {
  let out = s;
  if ('turns' in out) out = {...out, turns: normTurns(out.turns)};
  if ('origin' in out && (typeof out.origin !== 'string' || !out.origin)) { out = {...out}; delete out.origin; }
  return out;
}
function validEntries(list) {
  return list.filter(s => s && typeof s === 'object' && typeof s.id === 'string')
    .map(healEntry);
}
// Salvage pass for a corrupt index (#55): a truncated write leaves most entries
// intact as complete {...} objects. Recover every object that still parses and
// carries a string id, so one bad tail cannot make every session vanish from
// /resume (previously all() returned [] and the next touch overwrote the index
// with that single session).
//
// fix2 (fourth M18): only an object sitting directly inside an array counts.
// The old depth counter also accepted the top-level object itself, so a file
// shaped {"id":"wrapper","sessions":[{...the real session...}]} surfaced the
// wrapper as a ghost session and hid the real one inside it.
function salvage(raw) {
  const out = [];
  const stack = []; // '{' entries carry their start offset; '[' are markers
  let inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') stack.push({ch, start: i});
    else if (ch === '[') stack.push({ch});
    else if (ch === '}') {
      let idx = -1;
      for (let j = stack.length - 1; j >= 0; j--) if (stack[j].ch === '{') { idx = j; break; }
      if (idx < 0) continue;
      const start = stack[idx].start, parent = stack[idx - 1];
      stack.length = idx;
      if (parent?.ch !== '[') continue; // a bare top-level / nested object is not a session entry
      try { const o = JSON.parse(raw.slice(start, i + 1)); if (o && typeof o === 'object' && typeof o.id === 'string') out.push(healEntry(o)); } catch {}
    }
    else if (ch === ']') {
      for (let j = stack.length - 1; j >= 0; j--) if (stack[j].ch === '[') { stack.length = j; break; }
    }
  }
  return out;
}
// Wave 18 (2): a wrapper-form index ({sessions: [...], version: ..., ...})
// carries top-level fields besides the sessions array — a format version,
// fields a newer muser added. The salvage writeback used to persist the
// recovered entries as a bare array, so those fields silently vanished
// from the LIVE file (they survived only in the .corrupt-* backup). They
// are now carried in indexWrapper and every write() re-emits them around
// the sessions array. The one exception is a top-level `id`: that is the
// fourth-M18 ghost field (a wrapper that looks like a session itself), not
// wrapper metadata, and it is not carried over. A wrapper whose bytes are
// already exactly what write() would emit (extras first, then sessions,
// in write()'s format, entries healed) is a writeback THIS code already
// performed: it reads as clean, so repeated reads do not back the file
// aside and rewrite it over and over.
let indexWrapper = null; // unknown top-level fields of the wrapper-form index currently on disk, or null
// Wave 18 (4): parse reuse for the index. Every touch/save/recent used to
// re-read and re-parse the whole sessions.json (5000 entries: ~7.7 ms of
// parse + stringify per turn, growing linearly with the number of
// sessions). readIndex now memoises its result keyed on the file's EXACT
// bytes: a read whose raw text is unchanged returns clones of the memoised
// parse instead of parsing again. The key is the content itself, never a
// size/mtime pair, so a rewritten file can never be served stale; the
// memoised list is never handed out directly (callers mutate the entries
// they receive), only clones of it. write() seeds the memo lazily with the
// bytes it just wrote, so the first read after a write fills the memo by
// parsing those known-good bytes and later reads reuse them.
let indexMemo = null; // {raw, list|null, salvaged, wrapper} — list null means "parse raw on first hit"
// Entries are flat scalar records in practice; clone the top level key by
// key and deep-clone only the rare object/array VALUES (a /goal rides one
// on some entries), which keeps a 5000-entry clone far cheaper than a
// structuredClone of every entry while still never sharing a mutable
// object with the memo.
function cloneEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) { try { return structuredClone(e); } catch { return e; } }
  const out = {};
  for (const k of Object.keys(e)) { const v = e[k]; out[k] = (v && typeof v === 'object') ? cloneEntryValue(v) : v; }
  return out;
}
function cloneEntryValue(v) { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); } }
function wrapperExtras(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (k !== 'sessions' && k !== 'id') out[k] = obj[k];
  return Object.keys(out).length ? out : null;
}
// Read + parse the index with NO side effects. `salvaged` is true when the file
// was not a clean session array (unparseable, truncated, or a wrapper object
// carrying a sessions array) and the entries had to be recovered.
function readIndex() {
  let raw;
  // Only a missing index means "no sessions yet": any other read error (a lock, a permission
  // problem, the path being a folder) is real and must surface, not be read as an empty index
  // that the next write would then replace, wiping the real one.
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') { indexWrapper = null; indexMemo = null; return {list: [], salvaged: false}; } throw e; }
  // Wave 18 (4): exact-bytes memo hit — no re-parse, no salvage scan.
  if (indexMemo && indexMemo.raw === raw) {
    indexWrapper = indexMemo.wrapper ? {...indexMemo.wrapper} : null;
    if (!indexMemo.list) { // lazy seed left by write(): parse its known-good bytes once
      try { const p = JSON.parse(raw); indexMemo.list = validEntries(Array.isArray(p) ? p : p.sessions).map(cloneEntry); } catch { indexMemo = null; }
    }
    if (indexMemo) return {list: indexMemo.list.map(cloneEntry), salvaged: indexMemo.salvaged};
  }
  // Entries that are not sessions (a hand edit left a null) are skipped: one made recent() throw,
  // and with it muser -c, /resume and `muser resume`.
  let res = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) { indexWrapper = null; res = {list: validEntries(parsed), salvaged: false}; }
    else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.sessions)) {
      const list = validEntries(parsed.sessions);
      const extras = wrapperExtras(parsed);
      indexWrapper = extras;
      if (!extras) res = {list, salvaged: true};
      else res = {list, salvaged: raw !== JSON.stringify({...extras, sessions: list}, null, 1)};
    }
  } catch {}
  if (!res) { indexWrapper = null; res = {list: salvage(raw), salvaged: true}; }
  indexMemo = {raw, list: res.list.map(cloneEntry), salvaged: res.salvaged, wrapper: indexWrapper ? {...indexWrapper} : null};
  return res;
}
// Persist recovered entries as the new index. The corrupt original is moved
// aside FIRST (its bytes are the only recovery source), so when the rewrite
// itself fails the original is put back and the next read retries the salvage
// — c15 #1(b): backup-then-failed-write used to leave NO index at all, and the
// in-memory salvaged list was silently lost with it.
function persistSalvaged(kept) {
  const bak = backupCorrupt(); // always: even a zero-salvage file's bytes are the only recovery source
  if (!kept.length) return;
  try { write(kept); }
  catch { if (bak) { try { fs.renameSync(bak, FILE); } catch {} } }
}
let lastGood = null; // last successfully read index, for read-only degradation (c15 #5)
function all() {
  const r = readIndex();
  if (r.salvaged) {
    // c15 #1(a): this read used to back up + rewrite OUTSIDE the lock, racing a
    // window inside locked() whose all() read the momentarily missing file as
    // empty and overwrote the salvaged index with its single session. Persist
    // under the same lock as every other index write (or directly, when the
    // caller already holds it).
    if (lockDepth > 0) persistSalvaged(r.list);
    else {
      try { locked(() => { const again = readIndex(); if (again.salvaged) { persistSalvaged(again.list); r.list = again.list; } else r.list = again.list; }); }
      catch { /* another window holds the lock: it will salvage on its own read; serve the in-memory list */ }
    }
  }
  lastGood = r.list;
  return r.list;
}
// Read-only callers (recent/find/findAll — /resume, `muser -c`) degrade to the
// last good index on a transient read error (an AV / sync-tool sharing
// violation) instead of failing the user's resume outright (c15 #5). Writing
// callers keep using all(), which still throws: they must never act on a
// guessed-empty index.
function allSafe() {
  try { return all(); } catch { return lastGood ? lastGood.slice() : []; }
}
// Atomic save: write a uniquely named temp file, then rename over the target, so a
// crash mid-write can never leave a truncated sessions.json behind.
// Every session is kept, and no transcript or Focus file is deleted (the user's choice,
// 2026-11-07). The index used to keep only the newest 200 user sessions and 50 agent sessions
// and delete the rest's transcripts: a day of `muser exec` runs (each a user-level session)
// pushed the user's own chats out of /resume and deleted their local transcripts, including the
// chat of a window that was still open. An entry is a few hundred bytes and each transcript is
// capped on its own (MAX_TRANSCRIPT_BYTES), so keeping everything stays small.
function write(list) {
  fs.mkdirSync(store.DIR, {recursive: true});
  const temp = FILE + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    // Wave 18 (2): a wrapper-form index keeps its unknown top-level fields
    // (see readIndex) — the payload is the extras around the sessions array,
    // in the same key order readIndex's canonical check expects.
    const payload = indexWrapper ? {...indexWrapper, sessions: list} : list;
    const serialized = JSON.stringify(payload, null, 1);
    fs.writeFileSync(temp, serialized);
    store.renameRetry(temp, FILE); // fourth M7: a reader holding the file open made the raw rename throw EPERM on Windows and the turn's index update was lost
    indexMemo = {raw: serialized, list: null, salvaged: false, wrapper: indexWrapper ? {...indexWrapper} : null}; // Wave 18 (4): seed the read memo with the bytes just written
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
// sessions.json is read, changed and written by every muser window; two windows doing it at the
// same moment dropped one's update. A lock file serializes the change (a lock older than 5 s is
// taken to be left by a crashed window).
//
// Audit #50/#51/#52: the old lock ran fn() UNLOCKED on any non-EEXIST error and after a 2 s
// wait, busy-spun for those 2 s (freezing a resident server's event loop), stole a lock after
// 5 s with no sign of life from its holder, and released with a check-then-unlink that could
// delete a successor's lock. Now: the lock file carries its holder's pid, and a lock whose
// holder is still alive is NEVER stolen (a dead holder's lock, or a legacy lock with no pid
// that is over 5 s old, is claimed by atomically renaming it away — only one stealer wins
// the rename); contention sleeps properly (Atomics.wait); failure to acquire throws instead
// of running unlocked; and release renames the lock aside before checking the token,
// restoring it if it turned out to be a successor's.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
let lockDepth = 0; // >0 while THIS process holds the lock (all() / writeTranscript consult it)
// A pid lock whose holder is alive is trusted — but not forever (c15 #2): if the
// holder crashed and its pid was recycled by an unrelated long-lived process,
// an age-unbounded trust would block every window until the user deleted the
// lock file by hand. A lock older than this is stale even with a live pid;
// honest holders finish their read-modify-write in milliseconds.
const LOCK_PID_MAX_AGE_MS = 15 * 60 * 1000;
// The contention error names the way out, in words: close the other window
// or wait for it — and a lock past the age above is treated as stale, so
// waiting is bounded, not a dead end.
function lockError() {
  return new Error(t('会話の一覧が別の muser の窓で使用中です。その窓を閉じるか、終わるまで待ってからもう一度試してください。15分以上たったロックは古いものとして扱われます。'));
}
function locked(fn) {
  const lock = FILE + '.lock', until = Date.now() + 7000;
  // Ownership token: the lock file holds a random token of the window that took it, and only
  // that window unlinks it. Without it, a window whose lock was taken over as stale (its work
  // outlived 5 s) deleted the *next* window's lock on the way out, letting a third window in.
  const token = crypto.randomBytes(16).toString('hex');
  const content = token + ':' + process.pid; // the pid is the heartbeat substitute: see above
  fs.mkdirSync(store.DIR, {recursive: true});
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (e.code !== 'EEXIST') {
        if (Date.now() > until) throw e; // never run unlocked: surface the failure instead
        sleepSync(25); continue;
      }
      let stale = false;
      try {
        const held = fs.readFileSync(lock, 'utf8');
        const ownerPid = Number((held.split(':')[1] || '').trim());
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        stale = ownerPid > 0 ? (!pidAlive(ownerPid) || age > LOCK_PID_MAX_AGE_MS) : age > 5000;
      } catch {
        // c15 #3: a lock that exists but cannot be read (AV scan / sharing
        // violation) used to retry in a bare `continue` — no sleep, no deadline
        // check — busy-spinning a resident server's event loop forever.
        if (Date.now() > until) throw lockError();
        sleepSync(15); continue;
      }
      if (stale) {
        const grave = lock + '.stale-' + token;
        try { fs.renameSync(lock, grave); } catch { continue; } // another window claimed it first
        try { fs.unlinkSync(grave); } catch {}
        continue;
      }
      if (Date.now() > until) throw lockError();
      sleepSync(15);
    }
  }
  lockDepth++;
  try { return fn(); } finally {
    lockDepth--;
    const rel = lock + '.rel-' + token;
    try { fs.renameSync(lock, rel); } catch { /* already gone (stolen as stale): nothing to release */ }
    try {
      if (fs.readFileSync(rel, 'utf8') === content) { try { fs.unlinkSync(rel); } catch {} }
      // A successor's lock: put it back WITHOUT overwriting a third window's
      // brand-new lock created in the rename-aside gap (c15 #4: renameSync on
      // Windows replaces the destination, so B and C both believed they held
      // the lock). linkSync is atomic and fails with EEXIST instead; then the
      // new lock stays and the successor's moved-aside copy is dropped.
      else { try { fs.linkSync(rel, lock); try { fs.unlinkSync(rel); } catch {} } catch { try { fs.unlinkSync(rel); } catch {} } }
    } catch {}
  }
}

// origin (optional): the mark of a non-interactive creator ('exec'). Callers
// that create an interactive conversation pass nothing and the entry carries
// no origin key at all — absence IS the interactive mark, so old readers and
// old files are unaffected.
function create(cwd, origin) { return {id: crypto.randomUUID(), cwd, title: '', created: Date.now(), updated: Date.now(), turns: 0, ...(typeof origin === 'string' && origin ? {origin} : {})}; }
// Merge a session object with the entry another window may have written for the
// same id (#53): stored-only metadata (a /goal set in the other window) survives,
// keys this object explicitly carries win, and turns never moves backwards.
function mergeStored(stored, session) {
  if (!stored || stored === session) return session;
  const merged = {...stored, ...session};
  for (const k of Object.keys(session)) if (session[k] === undefined && k in stored) merged[k] = stored[k];
  merged.turns = Math.max(normTurns(stored.turns), normTurns(session.turns)); // fourth M19: Math.max on garbage gave NaN -> null
  if (!merged.title) merged.title = stored.title || '';
  Object.assign(session, merged);
  return session;
}
// Which stored entry IS this session object? Normally the only one with its
// id. A restored/merged index can carry two different conversations under
// one id (fourth M17): then the entry whose cwd matches is the same
// conversation, and only that one may be merged with / replaced.
function matchIndex(list, session) {
  const idxs = [];
  list.forEach((s, i) => { if (s.id === session.id) idxs.push(i); });
  if (idxs.length <= 1) return idxs.length ? idxs[0] : -1;
  const byCwd = idxs.filter(i => String(list[i].cwd || '') === String(session.cwd || ''));
  return byCwd.length === 1 ? byCwd[0] : idxs[0];
}
// A session title is the user's first message, shown verbatim in session
// lists (/resume, GUI, phone): characters that are invisible or that
// reorder how neighbouring text LOOKS must not survive into it, or a
// crafted first message can make a listed title read as different text
// than it is (Trojan-Source style). Stripped at title-creation time:
// C0/C1 controls other than the whitespace ones (tab / LF / VT / FF / CR
// survive this pass and are collapsed to a single space by the \s+ pass
// below, exactly as before), bidi controls (U+061C, U+200E/200F,
// U+202A-U+202E incl. RLO, U+2066-U+2069 — the set src/ui/sanitize.mjs
// strips for the screen) and zero-width characters (U+200B-U+200D,
// U+2060, U+FEFF — sanitize keeps U+200D for emoji in body text, but a
// title gains nothing from invisible joiners).
const TITLE_STRIP = /[\x00-\x08\x0e-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
// Cut by code points, not UTF-16 units (the same cut as src/tell.js): a
// unit cut at 60 can split a surrogate pair and store a broken character.
const cutTitle = s => [...s.replace(TITLE_STRIP, '').replace(/\s+/g, ' ')].slice(0, 60).join('');
function touch(session, text) {
  // #54: the counter only stays advanced if the write lands; a failed write used
  // to leave memory ahead of disk and a retry counted the turn twice.
  session.turns = normTurns(session.turns); // fourth M19: heal a garbage count before ++ (was NaN)
  const prev = {turns: session.turns, updated: session.updated, title: session.title};
  session.turns++; session.updated = Date.now();
  if (!session.title) session.title = cutTitle(String(text));
  try {
    locked(() => {
      const list = all();
      const idx = matchIndex(list, session);
      const stored = idx >= 0 ? list[idx] : undefined;
      // Another window advanced this same session further: count this turn on
      // top of theirs instead of overwriting their count with our stale one.
      if (stored && stored !== session && (stored.turns || 0) >= session.turns) session.turns = (stored.turns || 0) + 1;
      mergeStored(stored, session);
      // fourth M17: drop only the ONE entry being replaced — filter(id) also
      // deleted a second, different conversation that shared the id (restored
      // / merged indexes), silently and with no backup.
      const rest = list.filter((s, i) => i !== idx); rest.push(session); write(rest);
    });
  } catch (e) { session.turns = prev.turns; session.updated = prev.updated; session.title = prev.title; throw e; }
}
function recent(cwd) { return allSafe().filter(s => !s.parent && (!cwd || String(s.cwd || '').toLowerCase() === cwd.toLowerCase())).sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
// Deep equality over JSON-shaped data, ignoring keys whose value is
// undefined (JSON.stringify drops those on write, so they are not a
// difference the file could ever show).
function entriesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => entriesEqual(v, b[i]));
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  return ka.length === kb.length && ka.every(k => k in b && entriesEqual(a[k], b[k]));
}
// Upsert without counting a turn: metadata that rides the session object (its /goal,
// say) has to reach the index when it changes, not at the next turn's touch.
function save(session) {
  if (!session?.id) return;
  locked(() => {
    const list = all(); const idx = matchIndex(list, session); const stored = idx >= 0 ? list[idx] : undefined;
    mergeStored(stored, session);
    // Wave 18 (4): when the merged entry is identical to the stored one AND
    // already sits where the write would put it (last), the write would
    // reproduce the same index — skip the full re-stringify + rename.
    // Semantics are unchanged: the file already holds exactly this data.
    if (stored && idx === list.length - 1 && entriesEqual(stored, session)) return;
    const rest = list.filter((s, i) => i !== idx); rest.push(session); write(rest);
  }); // fourth M17: as in touch, other entries sharing the id survive
}
// Every session whose id is `ref` (exact) or starts with `ref` (prefix).
function findAll(ref) {
  if (!ref) return [];
  const list = allSafe();
  const exact = list.filter(s => s && s.id === ref);
  if (exact.length) return exact;
  return list.filter(s => s && typeof s.id === 'string' && s.id.startsWith(ref));
}
// Unique match or falsy, as callers expect. A prefix matching several sessions is
// ambiguous: return null and set find.ambiguous (use findAll to list candidates)
// instead of silently resuming an arbitrary one. An exact full-id match always wins.
function find(ref) {
  find.ambiguous = false;
  if (!ref) return undefined;
  const matches = findAll(ref);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) { find.ambiguous = true; return null; }
  return undefined;
}
find.ambiguous = false;

// ---- Search (title / body) for resume: W13-14 remainder ----
// A truncation-marker line in a transcript is not a turn, and its text must
// never produce a body hit.
// Wave 16 (4): ONE marker recognizer for every reader — search,
// readTranscriptRaw and capTurns all call this. It judges the PARSED
// top-level shape only: the writer's marker carries truncated:true (see
// truncationMarker below), and restored / imported files may instead carry
// type/kind 'truncated'/'truncation' at the top level. The old search-side
// raw-line regex disagreed with the read side (which also required a
// dropped field) and hid REAL turns whose nested fields — a tool result,
// quoted prose — contain "truncated": true; a nested flag is not a marker.
function isTruncationMarker(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (t.truncated === true || t.truncation === true || t.marker === true) return true;
  return t.type === 'truncated' || t.type === 'truncation' || t.type === 'truncation-marker' || t.kind === 'truncated' || t.kind === 'truncation' || t.kind === 'truncation-marker';
}
// Wave 17: ONE case fold for the query and every searched field. Plain
// toLowerCase() left 'strasse' unable to match 'straße' (ß never expands)
// and 'İ' unable to match 'Istanbul' (İ lowercases to i + U+0307, a
// two-code-unit sequence no plain 'i' contains). NFC first, then
// lowercase, then ß -> ss, then the i + U+0307 sequence back to plain 'i'.
function fold(s) {
  return String(s).normalize('NFC').toLowerCase().replace(/ß/g, 'ss').replace(/i\u0307/g, 'i');
}
// The fold of `s` built code point by code point, together with a map from
// each folded code-unit index to the ORIGINAL code-point index it came
// from (plus a sentinel entry for the end). Folding changes lengths — ß
// becomes two code units, İ shrinks from two to one — so an index found
// in folded space is only meaningful in the original string via this map.
function foldWithMap(s) {
  const cps = [...s];
  const map = [];
  let folded = '';
  for (let i = 0; i < cps.length; i++) {
    const piece = fold(cps[i]);
    for (let j = 0; j < piece.length; j++) map.push(i);
    folded += piece;
  }
  map.push(cps.length);
  return {folded, map};
}
// Snippet for a body hit: the matched field, whitespace-collapsed with the
// title strip applied (no control / bidi / zero-width characters survive),
// cut by code points to about 60 around the match (cutTitle-style slicing,
// so a surrogate pair is never split).
function searchSnippet(text, q) {
  const collapsed = String(text || '').replace(TITLE_STRIP, '').replace(/\s+/g, ' ').trim();
  const cps = [...collapsed];
  if (cps.length <= 60) return collapsed;
  const qCollapsed = q.replace(/\s+/g, ' ');
  const fq = fold(qCollapsed);
  const {folded, map} = foldWithMap(collapsed);
  const idx = fq ? folded.indexOf(fq) : -1;
  const matchCp = idx < 0 ? 0 : map[idx];
  const matchLen = idx < 0 ? [...qCollapsed].length : map[idx + fq.length] - matchCp;
  let start = Math.max(0, matchCp - Math.max(0, Math.floor((60 - matchLen) / 2)));
  if (start + 60 > cps.length) start = cps.length - 60;
  return cps.slice(start, start + 60).join('');
}
// Title hits first, then body hits, each newest-first, as session OBJECTS
// (duplicate ids share one transcript file and are separate hits — callers
// must never re-resolve a hit by id). Only sessions a resume could open are
// candidates: recent() (!parent, optionally one folder) with turns > 0, for
// title and body alike. Body scanning reads the transcript file itself: the
// writer (appendTurn) stores JSON.stringify output with Japanese as literal
// UTF-8, NOT \uXXXX escapes (verified in a fixture), so a raw line whose
// fold lacks q cannot hold the query in its user/reply fields and is
// skipped without JSON.parse; only pre-filtered lines are parsed, and a hit
// counts only when the parsed user (preferred) or reply field itself
// contains q. Wave 16 (5): that fast path is only sound for backslash-free
// lines — JSON escapes a backslash, a quote and control characters, so a
// query containing one of those (a Windows path, a quoted phrase) never
// appears literally in the raw line even when the parsed field matches.
// A line containing a backslash is therefore always parsed, never skipped
// by the prefilter.
function search(query, opts = {}) {
  const q = fold(String(query || '').trim());
  if (!q) return [];
  const limit = opts.limit ?? 20;
  if (!(limit > 0)) return [];
  const candidates = recent(opts.cwd).filter(s => s && s.turns > 0);
  const hits = [];
  const titleHitSessions = new Set();
  for (const s of candidates) {
    if (hits.length >= limit) return hits;
    if (typeof s.title === 'string' && fold(s.title).includes(q)) { hits.push({session: s, matchedIn: 'title', snippet: ''}); titleHitSessions.add(s); }
  }
  for (const s of candidates) {
    if (hits.length >= limit) break;
    if (titleHitSessions.has(s)) continue;
    let raw;
    try { raw = fs.readFileSync(transcriptReadFile(s.id), 'utf8'); } catch { continue; }
    // Wave 16 (2): the same BOM / CR normalisation as readTranscriptRaw.
    for (const line of splitTranscriptLines(raw)) {
      if (!line.trim()) continue;
      if (!line.includes('\\') && !fold(line).includes(q)) continue; // Wave 16 (5): a backslash line is always parsed
      let turn;
      try { turn = JSON.parse(line); } catch { continue; }
      if (!turn || typeof turn !== 'object' || isTruncationMarker(turn)) continue; // Wave 16 (4): marker-ness from the parsed turn, never a raw-line regex
      turn = normalizeTurn(turn); // Wave 18 (1): a legacy-shaped line matches on its normalised user/reply, like every other reader
      const user = String(turn.user || ''), reply = String(turn.reply || '');
      const field = fold(user).includes(q) ? user : fold(reply).includes(q) ? reply : null;
      if (field === null) continue;
      hits.push({session: s, matchedIn: 'body', snippet: searchSnippet(field, q)});
      break;
    }
  }
  return hits;
}

// ---- Transcripts: one JSONL file per session, one line per finished turn of the main chat
// ({at, user, reply, error?, tools, steps, sources, todos}). Appending a line is all a turn
// costs, and a crash can only cut the last line, which reading skips. /resume shows these
// instead of fetching the chat from Muse; Muse is asked only when the file has fewer turns.
const TRANSCRIPTS = require('node:path').join(store.DIR, 'transcripts');
// A transcript grows one line per turn, forever: cap what is retained. Once the file passes
// MAX_TRANSCRIPT_BYTES it is rewritten atomically (writeTranscript) keeping the newest
// MAX_TRANSCRIPT_TURNS turns that fit in the byte budget — the newest turn is always kept:
// a newest turn that alone is oversized has its body cut (with a note left in the cut text)
// to fit the budget alongside the turns before it, instead of staying oversized and then
// being dropped whole by the NEXT turn's compaction (wave 15: the pre-huge history and the
// huge turn itself were lost in two steps). Turns the cap does drop are not silent either:
// the rewritten file starts with one truncation-marker line carrying the cumulative drop
// count (transcript() filters it out, so callers see real turns only), and the sessions
// index entry's turns count is rewritten to the number of turns actually left in the file,
// so the count a resume header shows cannot drift away from what is really there.
const MAX_TRANSCRIPT_TURNS = 500, MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
// Wave 18 (3): the APPEND path compacts to this lower target, not to the
// cap itself. A compaction that lands just under MAX_TRANSCRIPT_BYTES
// leaves the file one ordinary turn away from the cap, so every following
// append paid a full read-modify-write compaction again (measured: a
// steady append went from ~2 ms to ~17 ms once a transcript reached
// 2 MB). Dropping to 80% of the cap gives the file ~400 KB of headroom —
// dozens of ordinary turns — before the next compaction is due. A whole-
// transcript rewrite (writeTranscript) still caps at the full budget: it
// replaces the file outright, so there is no steady-append cost to damp.
const COMPACT_TARGET_BYTES = Math.floor(MAX_TRANSCRIPT_BYTES * 0.8);
// A session id becomes a file name. The encoding is reversible and
// collision-free (the same scheme as worklog.js encodeId): safe chars
// ([A-Za-z0-9-], which covers every real session id, so existing files
// keep their names) pass through, '_' doubles, and any other char becomes
// _xHHHH (its UTF-16 code unit in hex). The old naming stripped every
// unsafe char, so 'a.b' and 'ab' shared one file and two conversations'
// transcripts / Focus states mixed into each other (audit wave 2, E8).
// The encoded form never contains a path separator or a dot, so an id
// cannot walk out of the folder either.
function encodeId(id) {
  return String(id).replace(/[^A-Za-z0-9-]/g, c => c === '_' ? '__' : '_x' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function legacyName(id) { return String(id).replace(/[^A-Za-z0-9-]/g, ''); }
function transcriptFile(id) { return require('node:path').join(TRANSCRIPTS, encodeId(id) + '.jsonl'); }
function legacyTranscriptFile(id) { return require('node:path').join(TRANSCRIPTS, legacyName(id) + '.jsonl'); }
// The file a READ of this id comes from: the encoded file wins whenever it
// exists; the legacy stripped-name file is read only when no encoded file
// exists yet, so histories written before the encoding change stay
// readable. Every write uses transcriptFile() (the encoded name) — a
// legacy file is never written to again, and once an encoded file exists
// the legacy name (which a colliding id may also claim) is never read for
// this id again.
function transcriptReadFile(id) {
  const file = transcriptFile(id), legacy = legacyTranscriptFile(id);
  if (legacy === file) return file;
  try { if (fs.existsSync(file)) return file; } catch {}
  try { if (fs.existsSync(legacy)) return legacy; } catch {}
  return file;
}
// Wave 13: the read rule above kept a legacy-only history readable, but the
// FIRST write under the encoded name split it in two: appendTurn created a
// fresh encoded file holding only the new turn, the encoded file then won
// every read, and the legacy turns vanished from the display and from
// /export (which reads through transcript()). So when an encoded file is
// about to be CREATED and a legacy file exists, its contents are imported
// first and the write lands after them. The legacy file itself is left in
// place: for a colliding id (legacyName('a.b') === 'ab') that same path is
// the other conversation's own encoded file, which must keep its turns.
// A legacy file whose last line has no trailing newline gains one, so the
// imported last turn and the next written line cannot fuse into one
// unparseable line. Caller holds the index lock (appendTurnLocked).
function seedTranscriptFromLegacy(id, file) {
  const legacy = legacyTranscriptFile(id);
  if (legacy === file) return;
  try { if (fs.existsSync(file)) return; } catch { return; }
  let raw;
  try { raw = fs.readFileSync(legacy, 'utf8'); } catch { return; }
  if (!raw) return;
  try { fs.writeFileSync(file, raw.endsWith('\n') ? raw : raw + '\n'); } catch {}
}
function appendTurn(id, turn) {
  if (!id) return;
  try {
    fs.mkdirSync(TRANSCRIPTS, {recursive: true});
    const line = JSON.stringify(turn) + '\n';
    // The append itself runs INSIDE the index lock (audit wave 2, B7): it
    // used to sit outside, so a turn appended by another window between a
    // compaction's re-read and its rename landed in the file the rename
    // then replaced, and the turn silently vanished. Holding the same
    // lock for the append and for the compaction makes the two mutually
    // exclusive. When the caller already holds the lock (lockDepth > 0)
    // the work runs directly — locked() is not re-entrant.
    if (lockDepth > 0) { appendTurnLocked(id, line); return; }
    locked(() => appendTurnLocked(id, line));
  } catch {}
}
// ---- Transcript cap: marker line, gradual shrink, index sync (wave 15) ----
// The marker is one JSONL line at the head of the file. It is a line IN the
// file, not a turn: transcript() filters it out everywhere, so turn counts,
// /resume and /export all keep seeing real turns only, while the raw file
// itself says plainly that older turns were cut and how many.
function truncationMarker(dropped) {
  return {v: 1, truncated: true, dropped, at: 0, user: '（古いターンは上限を超えたため切り捨てられました）', reply: '', tools: [], steps: [], sources: [], todos: []};
}
// (The marker recognizer itself — isTruncationMarker — is the shared one
// defined with the search section above; Wave 16 (4).)
function lineBytes(t) { return Buffer.byteLength(JSON.stringify(t), 'utf8') + 1; }
// Wave 16 (1): a line that parses is not automatically a turn. Real turns
// are plain objects carrying the fields the writers produce — user/reply
// strings (agent.record, the history import in transcript.js, and the
// minimal {user, reply} shape older files and tests use), or a text string
// (the role/text shape). Anything else that parses — {"type":"ping"}, [1,2], a stray number
// — used to surface as a ghost turn: it inflated transcript().length (so
// the forResume gate skipped the Muse backfill), occupied the resume
// window and was preserved forever by capTurns/writeTranscript. Such lines
// are now skipped like corrupt lines, and counted the same way (see (3)).
function isTurnShape(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  return typeof t.user === 'string' || typeof t.reply === 'string' || typeof t.text === 'string' || (typeof t.role === 'string' && typeof t.content === 'string');
}
// Wave 18 (1): isTurnShape ACCEPTS the legacy shapes above — {role, content}
// and {role, text} / {text} — but every reader downstream works in the
// modern {user, reply} shape (agent.record's shape). An un-normalised legacy
// line therefore surfaced as a BLANK turn (user and reply both undefined)
// that still counted in transcript().length, so the forResume gate saw a
// full local transcript and never asked Muse to backfill the real text.
// Normalise on read: the body (content, else text) lands in user for role
// 'user' and in reply for role 'assistant' — the only role names the chat
// model produces (src/core/chat-model.js); a role-less body is a user
// utterance, as a turn starts with the user. The field the body does not
// fill defaults to '' and the other modern field, when already present,
// wins over the legacy body. The consumed role/content/text keys are
// dropped; every other field (at, v, tools, ...) rides through untouched.
// A turn already carrying both user and reply is returned as-is.
function normalizeTurn(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return t;
  if (typeof t.user === 'string' && typeof t.reply === 'string') return t;
  const body = typeof t.content === 'string' ? t.content : typeof t.text === 'string' ? t.text : null;
  if (body === null) return t;
  const toReply = t.role === 'assistant';
  if (toReply && typeof t.reply === 'string') return t;
  if (!toReply && typeof t.user === 'string') return t;
  const out = {...t};
  delete out.role; delete out.content; delete out.text;
  if (toReply) { out.reply = body; if (typeof out.user !== 'string') out.user = ''; }
  else { out.user = body; if (typeof out.reply !== 'string') out.reply = ''; }
  return out;
}
// Wave 16 (2): transcript text normalisation, shared by readTranscriptRaw
// and search. A leading U+FEFF (a Windows editor / PowerShell re-save of a
// restored file) used to make the first line unparseable — losing the
// first turn, or the marker's dropped count when line 1 was the marker —
// and a CR-only file collapsed into one unparseable mega-line that read
// as zero turns. Strip the BOM and split on every line ending.
function splitTranscriptLines(raw) {
  const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return s.split(/\r\n|\r|\n/);
}
// Wave 16 (3): a transcript read that meets an unparseable or non-turn line
// preserves the file's ORIGINAL bytes before any later rewrite
// (writeTranscript, the append compaction) can destroy them — the same
// salvage instinct as backupCorruptFile for the index, except the live
// file stays in place, so the bytes are COPIED to a sibling
// <file>.corrupt-<stamp>. Keyed on size+mtime, so an unchanged file is
// backed up once per file state, not on every read. Wave 17: that key is
// per-process memory, so a changed file (or a new process) used to copy
// the whole transcript again and nothing ever deleted the copies —
// unbounded growth next to an active transcript. A copy is now skipped
// when an existing sibling already has the same byte size, and the
// siblings are pruned to the newest 3 per transcript (by mtime).
const corruptTranscriptBackups = new Map(); // file -> 'size:mtimeMs' already preserved
function preserveCorruptTranscript(file) {
  try {
    const st = fs.statSync(file);
    const key = st.size + ':' + st.mtimeMs;
    if (corruptTranscriptBackups.get(file) === key) return;
    corruptTranscriptBackups.set(file, key);
    const path = require('node:path');
    const dir = path.dirname(file), prefix = path.basename(file) + '.corrupt-';
    const siblings = () => {
      let names;
      try { names = fs.readdirSync(dir); } catch { return []; }
      const out = [];
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const p = path.join(dir, name);
        try { const s = fs.statSync(p); out.push({path: p, name, size: s.size, mtimeMs: s.mtimeMs}); } catch {}
      }
      return out;
    };
    const prune = list => {
      list.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      for (const old of list.slice(3)) { try { fs.unlinkSync(old.path); } catch {} }
    };
    const existing = siblings();
    if (existing.some(s => s.size === st.size)) { prune(existing); return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(file, file + '.corrupt-' + stamp); } catch {}
    prune(siblings());
  } catch {}
}
// Parse a transcript file into its real turns plus the cumulative number of
// turns earlier compactions dropped (summed over any marker lines present).
// `corrupt` counts the lines that were skipped as unparseable or not
// turn-shaped (Wave 16 (1)/(3)); their bytes are preserved as above.
function readTranscriptRaw(id) {
  const file = transcriptReadFile(id);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {turns: [], dropped: 0, corrupt: 0}; }
  const turns = [];
  let dropped = 0, corrupt = 0;
  for (const line of splitTranscriptLines(raw)) {
    if (!line.trim()) continue;
    let t;
    try { t = JSON.parse(line); } catch { corrupt++; continue; }
    if (isTruncationMarker(t)) { const n = Math.floor(Number(t.dropped)); if (Number.isFinite(n) && n > 0) dropped += n; continue; }
    if (!isTurnShape(t)) { corrupt++; continue; }
    turns.push(normalizeTurn(t)); // Wave 18 (1): legacy shapes read back in {user, reply} form
  }
  if (corrupt > 0) preserveCorruptTranscript(file);
  return {turns, dropped, corrupt};
}
const CUT_NOTE = '（長いため切り捨てられました）';
// Cut a string to a byte budget (never splitting a surrogate pair), leaving
// the cut note at the end so a shortened body never reads as complete.
function cutStringToBytes(s, budget) {
  if (Buffer.byteLength(s, 'utf8') <= budget) return s;
  const room = Math.max(0, budget - Buffer.byteLength(CUT_NOTE, 'utf8'));
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= room) lo = mid; else hi = mid - 1; }
  let cut = lo;
  if (cut > 0 && cut < s.length) { const c = s.charCodeAt(cut - 1); if (c >= 0xd800 && c <= 0xdbff) cut--; }
  return s.slice(0, cut) + CUT_NOTE;
}
// Return a copy of `turn` shrunk toward `target` bytes: the reply first, then
// the user's words, then the error; bulky structured detail goes only when
// the words alone still do not fit. The original object is never mutated.
function shrinkTurn(turn, target) {
  let out = {...turn};
  const size = () => lineBytes(out);
  const cutFields = () => {
    for (const field of ['reply', 'user', 'error']) {
      if (size() <= target) return;
      const val = out[field];
      if (typeof val !== 'string' || !val) continue;
      out = {...out, [field]: cutStringToBytes(val, Math.max(0, Buffer.byteLength(val, 'utf8') - (size() - target)))};
    }
  };
  cutFields();
  if (size() > target) {
    for (const field of ['steps', 'progress', 'tools', 'sources', 'todos']) if (Array.isArray(out[field]) && out[field].length) out = {...out, [field]: []};
    if (out.focus) { const o = {...out}; delete o.focus; out = o; }
    cutFields();
  }
  return out;
}
// Fit a turn list into the retention caps. `prevDropped` is the drop count
// earlier compactions already recorded (marker lines in the input list count
// too); the result carries the cumulative count. Order: the turn-count cap
// drops the oldest excess; a newest turn that ALONE exceeds the byte budget
// is shrunk to fit alongside the turns before it (keeping those turns);
// otherwise the oldest turns drop until the rest fit; a lone remaining turn
// is shrunk to the budget rather than left oversized. `targetBytes` is the
// byte budget for THIS call: the full cap by default, the lower
// COMPACT_TARGET_BYTES on the append path (Wave 18 (3) hysteresis).
function capTurns(input, prevDropped, targetBytes = MAX_TRANSCRIPT_BYTES) {
  let dropped = Math.max(0, Math.floor(Number(prevDropped) || 0));
  const turns = [];
  for (const t of input || []) {
    if (isTruncationMarker(t)) { const n = Math.floor(Number(t.dropped)); if (Number.isFinite(n) && n > 0) dropped += n; continue; }
    if (t && typeof t === 'object') turns.push(normalizeTurn(t)); // Wave 18 (1): a rewrite persists the normalised form, not the legacy shape
  }
  if (turns.length > MAX_TRANSCRIPT_TURNS) { const excess = turns.length - MAX_TRANSCRIPT_TURNS; turns.splice(0, excess); dropped += excess; }
  // Wave 18 (3): the byte total is maintained INCREMENTALLY. The old
  // totalOf() re-stringified every remaining turn after every single
  // shift, so dropping N turns cost O(N) full serialisations — quadratic
  // in the size of the drop (measured: dropping 225 turns took
  // 144-163 ms). Each turn's line size is now computed once, up front;
  // a shift subtracts the size it removes, and the only per-shift
  // recompute is the tiny marker line (its byte count changes when the
  // dropped count crosses a digit boundary).
  const markerBytes = () => (dropped > 0 ? lineBytes(truncationMarker(dropped)) : 0);
  const sizes = turns.map(t => lineBytes(t));
  let total = sizes.reduce((a, n) => a + n, 0) + markerBytes();
  if (total > targetBytes && turns.length) {
    const last = turns.length - 1, lastSize = sizes[last];
    const others = total - lastSize; // the other turns plus the marker line, if any
    if (lastSize + markerBytes() > targetBytes && others < targetBytes) {
      turns[last] = shrinkTurn(turns[last], targetBytes - others);
      sizes[last] = lineBytes(turns[last]);
      total = others + sizes[last];
    }
  }
  while (total > targetBytes && turns.length > 1) { const mb = markerBytes(); total -= sizes.shift(); turns.shift(); dropped++; total += markerBytes() - mb; }
  if (total > targetBytes && turns.length === 1) {
    turns[0] = shrinkTurn(turns[0], Math.max(256, targetBytes - markerBytes()));
  }
  return {turns, dropped};
}
function withMarker(capped) { return capped.dropped > 0 ? [truncationMarker(capped.dropped), ...capped.turns] : capped.turns; }
// After a compaction dropped turns, the index entry for this session must not
// keep counting turns the file no longer holds: rewrite its turns to the
// number of real turns now in the file. Caller holds the index lock (every
// caller of this helper runs inside locked()); a session with no index entry
// (transcripts are also written for ids the index never counted) is a no-op,
// and a failure here never loses the transcript write that already landed.
function syncIndexTurns(id, count) {
  try {
    const list = all();
    let changed = false;
    for (const s of list) if (s && s.id === id && normTurns(s.turns) !== count) { s.turns = count; changed = true; }
    if (changed) write(list);
  } catch {}
}
// Caller holds the index lock (or is appendTurn's locked callback).
function appendTurnLocked(id, line) {
  const file = transcriptFile(id);
  seedTranscriptFromLegacy(id, file); // wave 13: a first append must not orphan the legacy file's turns
  fs.appendFileSync(file, line);
  if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) {
    // The compaction is a read-modify-write of the whole file, done here
    // under the same lock hold as the append (third M24, sessions side):
    // re-read INSIDE the lock, so a turn the other window appended after
    // our first read is not cut by the rewrite — and no other window can
    // append between this re-read and the rename at all.
    const raw = readTranscriptRaw(id);
    const capped = capTurns(raw.turns, raw.dropped, COMPACT_TARGET_BYTES); // Wave 18 (3): compact with headroom, not to the cap itself
    writeTranscriptFile(id, withMarker(capped));
    if (capped.dropped > raw.dropped) syncIndexTurns(id, capped.turns.length);
  }
}
function transcript(id) { return readTranscriptRaw(id).turns; }
function writeTranscriptFile(id, turns) {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  const file = transcriptFile(id), temp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(temp, turns.map(t => JSON.stringify(t)).join('\n') + (turns.length ? '\n' : '')); store.renameRetry(temp, file); } // fourth M7: same EPERM-on-rename as the index
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
// A whole-transcript rewrite (the /resume merge in transcript.js) replaces the
// file outright, so it takes the same lock as every other sessions write
// (third M24, sessions side): unlocked, one window's merge-back could erase a
// turn the other window had just appended. The transcript.js side of M24
// (merging against a stale snapshot) belongs to that file's owner.
// Wave 13: a rewrite that CREATES the encoded file imports the legacy
// file's turns first, exactly as appendTurnLocked's seeding does — a
// caller whose turns were not read through transcript() must not orphan
// them either. Legacy turns the caller already carries (the normal case:
// its list came from transcript(), which reads the legacy file while no
// encoded file exists) are recognised by the same at/user/reply key
// transcript.js merges on and are not duplicated. The compaction inside
// appendTurnLocked calls writeTranscriptFile directly on a list already
// read in full, so its deliberate trims are not undone here.
function writeTranscript(id, turns) {
  const write = () => {
    let out = turns;
    let seedDropped = 0; // drops an earlier compaction recorded in the legacy file being imported
    const file = transcriptFile(id), legacy = legacyTranscriptFile(id);
    if (legacy !== file) {
      let exists = false;
      try { exists = fs.existsSync(file); } catch {}
      if (!exists) {
        seedDropped = readTranscriptRaw(id).dropped; // no encoded file yet: this reads the legacy file
        const old = transcript(id); // no encoded file yet: this reads the legacy file
        if (old.length) {
          const keyOf = t => JSON.stringify([t.at || 0, String(t.user || ''), String(t.reply || '')]);
          const have = new Map();
          for (const t of out) have.set(keyOf(t), (have.get(keyOf(t)) || 0) + 1);
          const pre = [];
          for (const t of old) { const k = keyOf(t); if (have.get(k)) have.set(k, have.get(k) - 1); else pre.push(t); }
          if (pre.length) out = [...pre, ...out];
        }
      }
    }
    // Wave 15: the same retention cap as the append path applies here too —
    // a whole-transcript rewrite used to bypass it entirely, so an oversized
    // file (700 turns / several MB) survived until the next append cut it
    // down in one go. capTurns drops/shrinks with the marker + index sync.
    const capped = capTurns(out, seedDropped);
    writeTranscriptFile(id, withMarker(capped));
    if (capped.dropped > 0) syncIndexTurns(id, capped.turns.length);
  };
  if (lockDepth > 0) { write(); return; }
  locked(write);
}

// ---- Focus state: one JSON file per session, next to the transcripts ----
// (weakness 3, 2026-11-06) The in-memory resume stash died with the window, so
// reopening it lost the unfinished task. The full Focus state (goal, criteria,
// evidence, revisions — see Focus.serialize) is saved here, per session, and
// read back when a new window opens that session. A missing or corrupt file
// reads as null: the session simply starts fresh, never fails to open.
const FOCUS_DIR = require('node:path').join(store.DIR, 'focus');
function focusFile(id) { return require('node:path').join(FOCUS_DIR, encodeId(id) + '.json'); }
function legacyFocusFile(id) { return require('node:path').join(FOCUS_DIR, legacyName(id) + '.json'); }
// Same read rule as transcripts (E8): the encoded file wins, the legacy
// stripped-name file is read only while no encoded file exists, and every
// write (saveFocus) uses the encoded name.
function focusReadFile(id) {
  const file = focusFile(id), legacy = legacyFocusFile(id);
  if (legacy === file) return file;
  try { if (fs.existsSync(file)) return file; } catch {}
  try { if (fs.existsSync(legacy)) return legacy; } catch {}
  return file;
}
// The write itself, with no locking: saveFocus wraps it in locked() (and
// loadFocus's corrupt backup shares backupCorruptFile above).
function writeFocusFile(id, data) {
  fs.mkdirSync(FOCUS_DIR, {recursive: true});
  const file = focusFile(id), temp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(temp, JSON.stringify(data)); store.renameRetry(temp, file); } // fourth M7: same EPERM-on-rename as the index
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
function focusRevOf(data) { return data && Number.isFinite(data.rev) ? data.rev : 0; }
function hasFocus(id) {
  if (!id) return false;
  try { return fs.existsSync(focusReadFile(id)); } catch { return false; }
}
// Wave 9 (2): does the on-disk Focus state still match what a caller last
// synced with? expected is {exists, rev} — the state that caller's last
// load / save / clear observed. A corrupt file matches nothing (its bytes
// are not a version anyone synced with), and a file that appeared or
// vanished since does not match either.
function focusMatches(id, expected) {
  if (!expected) return true;
  const file = focusReadFile(id);
  let exists = false;
  try { exists = fs.existsSync(file); } catch {}
  if (!!expected.exists !== exists) return false;
  if (!exists) return true;
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  return focusRevOf(cur) === (Number.isFinite(expected.rev) ? expected.rev : 0);
}
function saveFocus(id, data, expected) {
  if (!id) return false;
  // Two-window race (wave 7): a Focus file is shared by every window on the
  // session, and temp+rename alone only makes each single write atomic — two
  // windows saving at the same moment still interleaved, the later rename
  // silently replacing the earlier window's state. Serialize the write
  // through the same locked() as the index, exactly as writeTranscript does
  // (locked() is not re-entrant, so a caller already holding the lock writes
  // directly). A save that cannot take the lock in budget is dropped rather
  // than run unlocked — locked() throws and the best-effort catch below
  // swallows it, as write failures were already swallowed here.
  // Wave 9 (2): with `expected` given, the match check runs INSIDE the same
  // lock as the write, so the rev a caller checked cannot move between its
  // check and this write; a mismatch saves nothing and returns false.
  try {
    const write = () => { if (!focusMatches(id, expected)) return false; writeFocusFile(id, data); return true; };
    if (lockDepth > 0) return write();
    let out = false;
    locked(() => { out = write(); });
    return out;
  } catch { return false; }
}
function loadFocus(id) {
  if (!id) return null;
  const file = focusReadFile(id);
  let raw;
  // Only a missing Focus file means "no saved task": it reads as null with no
  // backup, exactly as before. Any other read failure also reads as null
  // (the session starts fresh, never fails to open) but leaves the file alone.
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch {
    // Corrupt Focus bytes (wave 7): the old catch-all returned null with the
    // bad file still in place, so the next saveFocus overwrote the ONLY copy
    // of the interrupted task's state. Move it aside first, in the same
    // .corrupt-* style as the index's backupCorrupt, and only then read as
    // null — the original bytes survive for recovery and the next save
    // starts from a clean path.
    backupCorruptFile(file);
    return null;
  }
}
function clearFocus(id, expected) {
  if (!id) return false;
  // Wave 9 (2): with `expected` given (see focusMatches), a state another
  // window has since advanced is NOT cleared — finishing a stale copy of
  // a task must not delete the other window's newer saved progress.
  if (expected && !focusMatches(id, expected)) return false;
  // Both names: a legacy file left behind would be read back by loadFocus's
  // fallback and resurrect the Focus state this clear just removed.
  try { fs.unlinkSync(focusFile(id)); } catch {}
  const legacy = legacyFocusFile(id);
  if (legacy !== focusFile(id)) { try { fs.unlinkSync(legacy); } catch {} }
  return true;
}

module.exports = {create, touch, save, recent, find, findAll, search, FILE, appendTurn, transcript, writeTranscript, transcriptFile, TRANSCRIPTS, locked, MAX_TRANSCRIPT_TURNS, MAX_TRANSCRIPT_BYTES, focusFile, saveFocus, loadFocus, clearFocus, hasFocus, focusMatches, FOCUS_DIR};
