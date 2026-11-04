'use strict';
// Local index of muser sessions (each one is a Muse side chat), for resume / --continue.
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./secure-store');

const FILE = store.file('sessions.json');

// A corrupt index must never be silently wiped: move the bad file aside with a
// timestamp and only then start empty, so the original bytes survive for recovery.
// Returns the backup path (or null when the move failed), so a caller whose
// rewrite then fails can put the original back instead of losing the index.
function backupCorrupt() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = FILE + '.corrupt-' + stamp;
  try { fs.renameSync(FILE, dest); return dest; } catch { return null; }
}
// turns on disk is user-restored / hand-edited data too (fourth M19): a garbage
// string used to survive as NaN -> null on the next touch and reset to 1 on the
// one after, and a negative count stayed negative. Every read and merge heals
// it to a non-negative integer ("10" -> 10, "abc" -> 0, -4 -> 0).
function normTurns(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }
function validEntries(list) {
  return list.filter(s => s && typeof s === 'object' && typeof s.id === 'string')
    .map(s => ('turns' in s ? {...s, turns: normTurns(s.turns)} : s));
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
      try { const o = JSON.parse(raw.slice(start, i + 1)); if (o && typeof o === 'object' && typeof o.id === 'string') out.push('turns' in o ? {...o, turns: normTurns(o.turns)} : o); } catch {}
    }
    else if (ch === ']') {
      for (let j = stack.length - 1; j >= 0; j--) if (stack[j].ch === '[') { stack.length = j; break; }
    }
  }
  return out;
}
// Read + parse the index with NO side effects. `salvaged` is true when the file
// was not a clean session array (unparseable, truncated, or a wrapper object
// carrying a sessions array) and the entries had to be recovered.
function readIndex() {
  let raw;
  // Only a missing index means "no sessions yet": any other read error (a lock, a permission
  // problem, the path being a folder) is real and must surface, not be read as an empty index
  // that the next write would then replace, wiping the real one.
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return {list: [], salvaged: false}; throw e; }
  // Entries that are not sessions (a hand edit left a null) are skipped: one made recent() throw,
  // and with it muser -c, /resume and `muser resume`.
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return {list: validEntries(list), salvaged: false};
    if (list && typeof list === 'object' && Array.isArray(list.sessions)) return {list: validEntries(list.sessions), salvaged: true};
  } catch {}
  return {list: salvage(raw), salvaged: true};
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
// The index keeps the newest 200 of the user's sessions and, apart, the newest 50 parallel-agent
// sessions (parent set): in one shared 200, a few agent-heavy tasks pushed the user's own chats
// out of /resume, and their transcripts were deleted with them.
const KEEP_USER = 200, KEEP_AGENT = 50;
function write(list) {
  fs.mkdirSync(store.DIR, {recursive: true});
  const users = list.filter(s => !s.parent), agents = list.filter(s => s.parent);
  const kept = new Set([...users.slice(-KEEP_USER), ...agents.slice(-KEEP_AGENT)]);
  const temp = FILE + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(list.filter(s => kept.has(s)), null, 1));
    store.renameRetry(temp, FILE); // fourth M7: a reader holding the file open made the raw rename throw EPERM on Windows and the turn's index update was lost
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  // Transcripts of the sessions dropped went nowhere and grew forever.
  for (const s of list) if (!kept.has(s) && s?.id) { try { fs.unlinkSync(transcriptFile(s.id)); } catch {} }
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
        if (Date.now() > until) throw new Error('sessions index is locked by another muser window');
        sleepSync(15); continue;
      }
      if (stale) {
        const grave = lock + '.stale-' + token;
        try { fs.renameSync(lock, grave); } catch { continue; } // another window claimed it first
        try { fs.unlinkSync(grave); } catch {}
        continue;
      }
      if (Date.now() > until) throw new Error('sessions index is locked by another muser window');
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

function create(cwd) { return {id: crypto.randomUUID(), cwd, title: '', created: Date.now(), updated: Date.now(), turns: 0}; }
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
function touch(session, text) {
  // #54: the counter only stays advanced if the write lands; a failed write used
  // to leave memory ahead of disk and a retry counted the turn twice.
  session.turns = normTurns(session.turns); // fourth M19: heal a garbage count before ++ (was NaN)
  const prev = {turns: session.turns, updated: session.updated, title: session.title};
  session.turns++; session.updated = Date.now();
  if (!session.title) session.title = String(text).replace(/\s+/g, ' ').slice(0, 60);
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
// Upsert without counting a turn: metadata that rides the session object (its /goal,
// say) has to reach the index when it changes, not at the next turn's touch.
function save(session) {
  if (!session?.id) return;
  locked(() => { const list = all(); const idx = matchIndex(list, session); mergeStored(idx >= 0 ? list[idx] : undefined, session); const rest = list.filter((s, i) => i !== idx); rest.push(session); write(rest); }); // fourth M17: as in touch, other entries sharing the id survive
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

// ---- Transcripts: one JSONL file per session, one line per finished turn of the main chat
// ({at, user, reply, error?, tools, steps, sources, todos}). Appending a line is all a turn
// costs, and a crash can only cut the last line, which reading skips. /resume shows these
// instead of fetching the chat from Muse; Muse is asked only when the file has fewer turns.
const TRANSCRIPTS = require('node:path').join(store.DIR, 'transcripts');
// A transcript grows one line per turn, forever: cap what is retained. Once the file passes
// MAX_TRANSCRIPT_BYTES it is rewritten atomically (writeTranscript) keeping the newest
// MAX_TRANSCRIPT_TURNS turns that fit in the byte budget — the newest turn is always kept,
// even if it alone is oversized, so the turn just finished is never the one dropped.
const MAX_TRANSCRIPT_TURNS = 500, MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
function transcriptFile(id) { return require('node:path').join(TRANSCRIPTS, String(id).replace(/[^A-Za-z0-9-]/g, '') + '.jsonl'); }
function appendTurn(id, turn) {
  if (!id) return;
  try {
    fs.mkdirSync(TRANSCRIPTS, {recursive: true});
    const file = transcriptFile(id);
    fs.appendFileSync(file, JSON.stringify(turn) + '\n');
    if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) {
      // The compaction is a read-modify-write of the whole file: serialize it
      // (third M24, sessions side) and re-read INSIDE the lock, so a turn the
      // other window appended after our first read is not cut by the rewrite.
      locked(() => {
        const kept = transcript(id).slice(-MAX_TRANSCRIPT_TURNS);
        const sizes = kept.map(t => Buffer.byteLength(JSON.stringify(t), 'utf8') + 1);
        let total = sizes.reduce((a, b) => a + b, 0), drop = 0;
        while (kept.length - drop > 1 && total > MAX_TRANSCRIPT_BYTES) total -= sizes[drop++];
        writeTranscriptFile(id, kept.slice(drop));
      });
    }
  } catch {}
}
function transcript(id) {
  let raw;
  try { raw = fs.readFileSync(transcriptFile(id), 'utf8'); } catch { return []; }
  return raw.split('\n').map(line => { try { return line.trim() ? JSON.parse(line) : null; } catch { return null; } }).filter(t => t && typeof t === 'object');
}
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
function writeTranscript(id, turns) {
  if (lockDepth > 0) { writeTranscriptFile(id, turns); return; }
  locked(() => writeTranscriptFile(id, turns));
}

module.exports = {create, touch, save, recent, find, findAll, FILE, appendTurn, transcript, writeTranscript, transcriptFile, TRANSCRIPTS, locked, MAX_TRANSCRIPT_TURNS, MAX_TRANSCRIPT_BYTES};
