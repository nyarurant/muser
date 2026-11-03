'use strict';
// Local index of muser sessions (each one is a Muse side chat), for resume / --continue.
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./secure-store');

const FILE = store.file('sessions.json');

// A corrupt index must never be silently wiped: move the bad file aside with a
// timestamp and only then start empty, so the original bytes survive for recovery.
function backupCorrupt() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(FILE, FILE + '.corrupt-' + stamp); } catch {}
}
// Salvage pass for a corrupt index (#55): a truncated write leaves most entries
// intact as complete {...} objects. Recover every object that still parses and
// carries a string id, so one bad tail cannot make every session vanish from
// /resume (previously all() returned [] and the next touch overwrote the index
// with that single session).
function salvage(raw) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { const o = JSON.parse(raw.slice(start, i + 1)); if (o && typeof o === 'object' && typeof o.id === 'string') out.push(o); } catch {}
        start = -1;
      }
    }
  }
  return out;
}
function all() {
  let raw;
  // Only a missing index means "no sessions yet": any other read error (a lock, a permission
  // problem, the path being a folder) is real and must surface, not be read as an empty index
  // that the next write would then replace, wiping the real one.
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  // Entries that are not sessions (a hand edit left a null) are skipped: one made recent() throw,
  // and with it muser -c, /resume and `muser resume`.
  try { const list = JSON.parse(raw); if (Array.isArray(list)) return list.filter(s => s && typeof s === 'object' && typeof s.id === 'string'); } catch {}
  const kept = salvage(raw);
  backupCorrupt();
  // Persist the salvaged entries as the new index right away: otherwise this
  // read moved the only copy aside and the next write would still start from
  // an empty (now missing) file.
  if (kept.length) { try { write(kept); } catch {} }
  return kept;
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
    fs.renameSync(temp, FILE);
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
        stale = ownerPid > 0 ? !pidAlive(ownerPid) : Date.now() - fs.statSync(lock).mtimeMs > 5000;
      } catch { continue; }
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
  try { return fn(); } finally {
    const rel = lock + '.rel-' + token;
    try { fs.renameSync(lock, rel); } catch { /* already gone (stolen as stale): nothing to release */ }
    try {
      if (fs.readFileSync(rel, 'utf8') === content) { try { fs.unlinkSync(rel); } catch {} }
      else { try { fs.renameSync(rel, lock); } catch { try { fs.unlinkSync(rel); } catch {} } } // a successor's lock: put it back
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
  merged.turns = Math.max(stored.turns || 0, session.turns || 0);
  if (!merged.title) merged.title = stored.title || '';
  Object.assign(session, merged);
  return session;
}
function touch(session, text) {
  // #54: the counter only stays advanced if the write lands; a failed write used
  // to leave memory ahead of disk and a retry counted the turn twice.
  const prev = {turns: session.turns, updated: session.updated, title: session.title};
  session.turns++; session.updated = Date.now();
  if (!session.title) session.title = String(text).replace(/\s+/g, ' ').slice(0, 60);
  try {
    locked(() => {
      const list = all();
      const stored = list.find(s => s.id === session.id);
      // Another window advanced this same session further: count this turn on
      // top of theirs instead of overwriting their count with our stale one.
      if (stored && stored !== session && (stored.turns || 0) >= session.turns) session.turns = (stored.turns || 0) + 1;
      mergeStored(stored, session);
      const rest = list.filter(s => s.id !== session.id); rest.push(session); write(rest);
    });
  } catch (e) { session.turns = prev.turns; session.updated = prev.updated; session.title = prev.title; throw e; }
}
function recent(cwd) { return all().filter(s => !s.parent && (!cwd || String(s.cwd || '').toLowerCase() === cwd.toLowerCase())).sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
// Upsert without counting a turn: metadata that rides the session object (its /goal,
// say) has to reach the index when it changes, not at the next turn's touch.
function save(session) {
  if (!session?.id) return;
  locked(() => { const list = all(); mergeStored(list.find(s => s.id === session.id), session); const rest = list.filter(s => s.id !== session.id); rest.push(session); write(rest); });
}
// Every session whose id is `ref` (exact) or starts with `ref` (prefix).
function findAll(ref) {
  if (!ref) return [];
  const list = all();
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
      const kept = transcript(id).slice(-MAX_TRANSCRIPT_TURNS);
      const sizes = kept.map(t => Buffer.byteLength(JSON.stringify(t), 'utf8') + 1);
      let total = sizes.reduce((a, b) => a + b, 0), drop = 0;
      while (kept.length - drop > 1 && total > MAX_TRANSCRIPT_BYTES) total -= sizes[drop++];
      writeTranscript(id, kept.slice(drop));
    }
  } catch {}
}
function transcript(id) {
  let raw;
  try { raw = fs.readFileSync(transcriptFile(id), 'utf8'); } catch { return []; }
  return raw.split('\n').map(line => { try { return line.trim() ? JSON.parse(line) : null; } catch { return null; } }).filter(t => t && typeof t === 'object');
}
function writeTranscript(id, turns) {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  const file = transcriptFile(id), temp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(temp, turns.map(t => JSON.stringify(t)).join('\n') + (turns.length ? '\n' : '')); fs.renameSync(temp, file); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

module.exports = {create, touch, save, recent, find, findAll, FILE, appendTurn, transcript, writeTranscript, transcriptFile, TRANSCRIPTS, locked, MAX_TRANSCRIPT_TURNS, MAX_TRANSCRIPT_BYTES};
