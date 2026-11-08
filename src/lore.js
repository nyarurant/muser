'use strict';
// Code memory (muser lore, /lore, /why) — design: docs/design/new-features.md §5.
//
// Records of why code is the way it is, kept per repository:
//   why    — which turn / agent / request changed a range, and for what reason
//   scar   — a fixed bug's place and the regression test that guards it
//   grave  — code that was deleted (10+ lines or a whole block) and why
//   hunch  — an assumption placed without checking, and where it lives
// story is not stored: it is the four kinds above for one file, in append order.
//
// Place: by default this PC only, %LOCALAPPDATA%\muser\lore\<repo id>\lore.jsonl
// (repo id = a hash of the first commit's id combined with the git common
// dir's absolute path, or a hash of the folder's real path when there is no
// git). Only when the user chooses sharing (muser lore share on)
// do new records go to the repository's .muser/lore.jsonl, which can be
// committed. Reads always merge both files, so flipping the switch never
// hides what was recorded on the other side.
//
// Secrets never land here (the design's common rule): text is redacted the
// same way focus-log redacts (secret-shaped keys/values, Authorization), a
// record about a sensitive path (tools.js isSensitivePath — .env, *.enc,
// credentials, keys) is refused outright, and nothing is ever sent anywhere.
//
// Line numbers drift, so a record anchors its range with the range's content
// hash plus the 3 lines before and after. locate() finds the range again:
// same place by hash, then a whole-file hash scan, then the context lines
// (whose gap may have grown or shrunk). A range found by context whose
// content no longer matches the record comes back with a `changed` mark.
// A record anchored on the whole file anchors to the file itself and is
// found as long as the file is there. (The design's third step — following
// the range through git diffs — is not implemented; a range found by none
// of the steps is "lost", kept, and shown in story. See the DevNote's
// known limits.)
//
// why / scar / grave are derived from the work log (§1 of the design),
// which src/worklog.js writes; this file only READS it. The shape is the
// writer's: %LOCALAPPDATA%\muser\worklog\<conversation id>.jsonl, one event
// per line ({v, at, session, event, ...}) — turn {agent, parentAgent?,
// parentSession?, text}, tool {...}, edit {path, op, beforeHash, afterHash,
// added, removed, ranges: [{start, end}], diff} (or {withheld} for a
// sensitive path), expect {...}, reply {agent, text}, focus {focus: {...}};
// an edit's before-image lives in worklog\blobs\<beforeHash> and is read
// through the writer's own readBlob. syncFromWorklog() turns edits into
// records and is idempotent (each derived record carries a dedupe key).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {t} = require('./i18n.js');
const {Worklog, sanitizeText, decodeId} = require('./worklog.js');
const {withLock: configWithLock, renameRetry} = require('./config.js');

const KINDS = ['why', 'scar', 'grave', 'hunch'];
const HUNCH_STATES = ['open', 'confirmed', 'wrong'];
const GRAVE_MIN_LINES = 10; // design: aまとまった削除 is 10+ lines or a block
const ATTACH_MAX = 3; // design: at most 3 notes attached to one tool result
const LIST_CAP = 100; // the CLI's text listings print at most this many records (the rest is noted, --json is not capped)
const LINE_LIMIT = 1e7; // a file:line spec's numbers must stay below this

// --- places -----------------------------------------------------------------
function dataRoot() { return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser'); }
function loreBase() { return path.join(dataRoot(), 'lore'); }
function worklogDir() { return path.join(dataRoot(), 'worklog'); }

function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}); }
  catch { return null; }
}
function repoRoot(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top && top.trim()) return path.resolve(top.trim());
  return path.resolve(cwd || '.');
}
// The pre-git id scheme: a hash of the folder's real path. A store created
// before the first commit lives under this id, so repoContext still needs
// it to find (and inherit) that store once the repo gets a commit.
function legacyPathId(root) {
  let real = root;
  // .native, as in tell.js / permissions.js: the non-native realpath keeps
  // an 8.3 short spelling (LONGFO~1), so one folder reached under its short
  // name hashed to a different id and its store split off from the same
  // folder's long-name store (and the migration below missed it).
  try { real = fs.realpathSync.native(root); } catch {}
  return 'p' + hashText(real.toLowerCase()).slice(0, 24);
}
function gitCommonDir(root) {
  const out = git(root, ['rev-parse', '--git-common-dir']);
  if (!out || !out.trim()) return null;
  let abs = path.resolve(root, out.trim());
  try { abs = fs.realpathSync.native(abs); } catch {} // .native: see legacyPathId — a short-spelled root must hash as its long form
  return abs;
}
function repoId(root) {
  const first = git(root, ['rev-list', '--max-parents=0', 'HEAD']);
  const id = first && first.trim().split(/\s+/).filter(Boolean).pop();
  if (id && /^[0-9a-f]{7,64}$/i.test(id)) {
    // The first commit alone does not name a repository: every copy of a
    // template repository shares it, so their lore stores collided into
    // one. Combine it with this clone's own git common dir (absolute), so
    // two clones of the same history keep separate stores, while this
    // clone's worktrees (same common dir) still share one.
    const common = gitCommonDir(root);
    return hashText(id.toLowerCase() + '|' + (common || root).toLowerCase()).slice(0, 40);
  }
  return legacyPathId(root);
}
// A store created before the first commit sits under the path-hash id;
// once the repo has a commit its id changes, so inherit the old directory
// (records + state) instead of starting over empty and orphaning it.
// Files the new directory already has are never clobbered.
function migrateLegacyDir(root, id) {
  if (!id || id.startsWith('p')) return; // a path-hash id IS the legacy scheme
  const legacy = legacyPathId(root);
  if (legacy === id) return;
  const oldDir = path.join(loreBase(), legacy), newDir = path.join(loreBase(), id);
  try {
    if (!fs.existsSync(oldDir)) return;
    if (!fs.existsSync(newDir)) { fs.mkdirSync(loreBase(), {recursive: true}); fs.renameSync(oldDir, newDir); return; }
    for (const name of fs.readdirSync(oldDir)) {
      const to = path.join(newDir, name);
      if (!fs.existsSync(to)) { try { fs.renameSync(path.join(oldDir, name), to); } catch {} }
    }
    try { fs.rmdirSync(oldDir); } catch {}
  } catch {}
}
// Everything one call needs to know about where this repo's lore lives.
// Memoized briefly: resolving a context spawns git three times (rev-parse
// toplevel + common dir, rev-list), and a work-log sync appends N records — without this, every
// appended record paid two git launches. The TTL is short so a flipped
// share switch or a fresh first commit is picked up almost at once, and
// setShared invalidates its repo's entries itself.
const ctxCache = new Map();
const CTX_TTL_MS = 1000;
function repoContext(cwd) {
  const cacheKey = path.resolve(cwd || '.');
  const hit = ctxCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.ctx;
  const root = repoRoot(cwd);
  const id = repoId(root);
  migrateLegacyDir(root, id);
  const dir = path.join(loreBase(), id);
  const localFile = path.join(dir, 'lore.jsonl');
  const sharedFile = path.join(root, '.muser', 'lore.jsonl');
  const shared = loadStateFile(path.join(dir, 'state.json')).shared === true;
  const ctx = {root, id, dir, localFile, sharedFile, shared, file: shared ? sharedFile : localFile};
  ctxCache.set(cacheKey, {at: Date.now(), ctx});
  return ctx;
}
function invalidateCtx(root) {
  for (const [k, v] of ctxCache) if (v.ctx.root === root) ctxCache.delete(k);
}
function stateFile(ctx) { return path.join(ctx.dir, 'state.json'); }
// A corrupt state.json must never be silently wiped (sessions.js's
// backupCorrupt is the model): the forgotten keys and the share switch live
// here, so reading a truncated file as {} would resurrect forgotten records
// and flip sharing off, and the next write would destroy the only bytes left
// to recover from. Move the bad file aside first; only then start empty.
function backupCorruptState(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = file + '.corrupt-' + stamp;
  try {
    if (fs.existsSync(dest)) dest += '-' + crypto.randomBytes(3).toString('hex');
    fs.renameSync(file, dest);
    return dest;
  } catch { return null; }
}
// Best-effort recovery from a corrupt state.json's bytes: the forgotten
// keys and the share switch are plain data, so pull them out of the raw
// text before starting over — otherwise the first sync after corruption
// would resurrect every forgotten record even though the backup kept them.
function salvageState(raw) {
  const out = {};
  const m = raw.match(/"forgotten"\s*:\s*\[([\s\S]*?)\]/);
  if (m) {
    const keys = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => { try { return JSON.parse('"' + x[1] + '"'); } catch { return x[1]; } });
    if (keys.length) out.forgotten = keys;
  }
  if (/"shared"\s*:\s*true/.test(raw)) out.shared = true;
  return out;
}
function loadStateFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; } // missing = no state yet
  try { const s = JSON.parse(raw); if (s && typeof s === 'object' && !Array.isArray(s)) return s; } catch {}
  backupCorruptState(file);
  return salvageState(raw);
}
function readState(ctx) { return loadStateFile(stateFile(ctx)); }
// Atomic save (sessions.js's write is the model): a uniquely named temp file,
// then rename over the target, so a crash mid-write can never leave a
// truncated state.json behind.
function writeState(ctx, state) {
  fs.mkdirSync(ctx.dir, {recursive: true});
  const file = stateFile(ctx);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
    renameRetry(tmp, file); // same retry as the records rewrite below: a plain rename throws EPERM on Windows while another window has state.json open
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
function setShared(cwd, on) {
  const ctx = repoContext(cwd);
  const state = readState(ctx);
  state.shared = !!on;
  writeState(ctx, state);
  invalidateCtx(ctx.root);
  return repoContext(cwd);
}
// Tombstones of records the user deleted: each removed record's dedupe
// key (derived records) and an 'id:<id>' entry (every record). The keys
// stop syncFromWorklog re-deriving a forgotten record from the work log
// on the very next call, which made `lore forget` a no-op (finding:
// forgotten lore came back); readRecords applies the whole set on every
// read, so restored or incoming record bytes stay forgotten too.
function loadForgotten(ctx) {
  const f = readState(ctx).forgotten;
  return Array.isArray(f) ? f.filter(k => typeof k === 'string') : [];
}
function saveForgotten(ctx, keys) {
  const state = readState(ctx);
  state.forgotten = [...keys];
  writeState(ctx, state);
}
function relOf(root, p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  // Only a real parent step is outside the repo (tell.js): a file NAMED
  // '..notes.txt' at the repo top has rel '..notes.txt' and is inside like
  // any other — a bare startsWith('..') made it an absolute path instead.
  return (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) ? rel.split(path.sep).join('/') : abs.split(path.sep).join('/');
}
// A relative path this repository can own: not absolute (POSIX or Windows
// drive), not escaping upwards. The work log mixes every conversation on
// the PC, so an edit whose path cannot be placed inside this repo belongs
// to another repo and must not be folded into this repo's lore.
function isLocalRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !/^[A-Za-z]:\//.test(rel) && rel !== '..' && !rel.startsWith('../');
}

// --- secrets / cleaning -------------------------------------------------------
const SECRET_VALUE = /(authorization\s*:|api[-_]?key|token|password|passwd|secret|cookie)(\s*[:=]\s*)([^\s,;}"]+)/gi;
const AUTH_VALUE = /authorization(\s*:\s*)(?:bearer\s+|basic\s+)?([^\s,;}"]+)/gi;
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
function clean(s, max = 500) {
  // The work log's sanitiser is the one place secret shapes are defined
  // (labelled values, token prefixes, JWTs, JSON values); lore's records
  // can be shared into the repository, so they go through the same wash.
  let v = sanitizeText(String(s ?? '')).replace(CTRL, ' ');
  v = v.replace(/\s+/g, ' ').trim();
  return v.length <= max ? v : v.slice(0, max) + '…';
}
function cleanLines(lines, maxLines = 60, maxChars = 8000) {
  const out = [];
  let n = 0;
  for (const l of (lines || []).slice(0, maxLines)) {
    const v = sanitizeText(String(l ?? '')).replace(CTRL, ' ');
    n += v.length + 1;
    if (n > maxChars) break;
    out.push(v);
  }
  return out;
}
let sensitiveFn = null;
function isSensitive(p) {
  try {
    if (!sensitiveFn) sensitiveFn = require('./tools.js').isSensitivePath;
    return !!(sensitiveFn(p) || sensitiveFn(path.resolve(p)));
  } catch { return false; }
}

// --- anchors ------------------------------------------------------------------
// The text is normalised to NFC and every line break is folded to \n
// before hashing: the same visible line saved in NFD (café written with a
// combining accent) or with a lone \r used to hash differently, so an
// unmoved, unchanged line failed its hash check and locate() reported the
// record 'changed' (or lost) for a difference no reader can see.
function hashText(s) { return crypto.createHash('sha256').update(String(s).normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8').digest('hex'); }
function readLines(abs) {
  try { return fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch { return null; }
}
// lines are 0-based file lines; start/end are 1-based and inclusive.
function anchor(lines, start, end) {
  const s = Math.max(1, start | 0), e = Math.max(s, end | 0);
  const slice = lines ? lines.slice(s - 1, e) : [];
  return {
    start: s, end: e,
    hash: slice.length ? hashText(slice.join('\n')) : null,
    text: cleanLines(slice, 200),
    before: lines ? cleanLines(lines.slice(Math.max(0, s - 4), s - 1)) : [],
    after: lines ? cleanLines(lines.slice(e, e + 3)) : [],
  };
}
// Anchor for a work-log edit, against the file as it stands now. The current
// lines may only be adopted when the window whose hash is the edit's
// afterHash is actually found in them. Adopting the recorded range anyway
// (the old behaviour) made whatever unrelated content sits there now the
// record's text and hash, so locate() later reported it 'exact' even though
// it was never the edit's result. When the window is gone, keep the recorded
// range and the afterHash but no text or context, so locate() honestly
// reports the record 'lost'. An edit with no afterHash cannot be checked
// this way, so its recorded range is anchored as before.
function editAnchor(lines, range, afterHash) {
  const fallback = {start: range ? range.start : 0, end: range ? range.end : 0, hash: afterHash || null, text: [], before: [], after: []};
  if (!lines || !range) return fallback;
  if (!afterHash) return anchor(lines, range.start, range.end);
  const len = range.end - range.start + 1;
  if (len < 1) return fallback;
  for (let s = 1; s + len - 1 <= lines.length; s++) {
    if (hashText(lines.slice(s - 1, s + len - 1).join('\n')) === afterHash) return anchor(lines, s, s + len - 1);
  }
  return fallback;
}
function sameLines(lines, at, want) { // at is 0-based index of the block's first line
  if (!want.length) return false;
  return want.every((w, i) => String(lines[at + i] ?? '') === w);
}
// Does the block now at s..e still hold the record's own content? Compared
// against the kept text when there is any, else against the range hash.
function sliceChanged(rec, lines, s, e) {
  const slice = lines.slice(s - 1, e);
  const text = rec.text || [];
  // The kept text is capped (anchor keeps at most 200 lines), so a range
  // longer than its text can only be judged by its hash.
  if (text.length && text.length >= rec.end - rec.start + 1) return !(slice.length === text.length && sameLines(slice, 0, text));
  if (rec.hash) return hashText(slice.join('\n')) !== rec.hash;
  if (text.length) return !(slice.length === text.length && sameLines(slice, 0, text));
  return false;
}
// Find a record's range in the file's current lines. -> {status, start, end}
// status: 'exact' (same place), 'moved' (hash scan), 'context' (the 3+3 clue
// lines bracketing the range), 'lost'. A 'context' hit whose content no
// longer matches the record also carries `changed: true`. When the same
// block or bracket occurs more than once, the match nearest the recorded
// place wins — the first occurrence used to win even when an identical
// copy sat far away and the real one had only drifted a line or two.
function locate(rec, lines) {
  const lost = {status: 'lost', start: rec.start, end: rec.end};
  if (!lines || !rec.start || rec.end < rec.start) return lost;
  const len = rec.end - rec.start + 1;
  if (rec.hash) {
    if (rec.end <= lines.length && hashText(lines.slice(rec.start - 1, rec.end).join('\n')) === rec.hash) return {status: 'exact', start: rec.start, end: rec.end};
    // A work-log edit's afterHash is the hash of the WHOLE file after the
    // edit, not of the range (src/worklog.js makeEdit), so a record kept
    // through editAnchor's fallback carries a whole-file hash and no text
    // or context. While the file is still exactly that edit's result, the
    // recorded range is where the edit left it — found, at its place.
    // Once the file moves on, no step finds it and it is honestly lost.
    if (lines.length && hashText(lines.join('\n')) === rec.hash) return {status: 'exact', start: rec.start, end: rec.end};
    let best = null;
    for (let s = 1; s + len - 1 <= lines.length; s++) {
      if (hashText(lines.slice(s - 1, s + len - 1).join('\n')) === rec.hash && (best === null || Math.abs(s - rec.start) < Math.abs(best - rec.start))) best = s;
    }
    if (best !== null) return {status: 'moved', start: best, end: best + len - 1};
  }
  const before = rec.before || [], after = rec.after || [];
  if (before.length || after.length) {
    // The clue lines bracket the range, but the gap between them is not
    // fixed at the recorded length: lines inserted (or removed) INSIDE the
    // range move the far bracket, and the range is still the range. Every
    // bracketed (start, end) is a candidate; the nearest one wins. With
    // clues on only one side, the other end keeps the recorded length —
    // nothing brackets it. (No before-clues means the range began at the
    // file's first line, so its start is still 1.)
    const starts = [];
    if (!before.length) starts.push(1);
    else for (let s = 1 + before.length; s <= lines.length + 1; s++) if (sameLines(lines, s - 1 - before.length, before)) starts.push(s);
    const ends = []; // an after-clue block starting at 0-based a means the range ends at line a
    if (after.length) for (let a = 0; a + after.length <= lines.length; a++) if (sameLines(lines, a, after)) ends.push(a);
    const cands = [];
    for (const s of starts) {
      if (!after.length) { const e = s + len - 1; if (e <= lines.length) cands.push({start: s, end: e}); }
      else for (const e of ends) if (e >= s) cands.push({start: s, end: e});
    }
    if (cands.length) {
      cands.sort((x, y) => (Math.abs(x.start - rec.start) - Math.abs(y.start - rec.start)) || (Math.abs(x.end - rec.end) - Math.abs(y.end - rec.end)));
      const c = cands[0];
      const out = {status: 'context', start: c.start, end: c.end};
      if (sliceChanged(rec, lines, c.start, c.end)) out.changed = true;
      return out;
    }
  }
  // A record anchored on the WHOLE file (a scar recorded against every
  // line: starts at 1, no clue lines on either side, the text kept) is an
  // anchor on the file itself, not on its bytes: while the file is there
  // the record is found, and changed content is reported as changed —
  // never as lost just because the hash no longer matches.
  if (rec.start === 1 && !before.length && !after.length && (rec.text || []).length && lines.length >= 1) {
    const out = {status: 'context', start: 1, end: lines.length};
    if (sliceChanged(rec, lines, 1, lines.length)) out.changed = true;
    return out;
  }
  return lost;
}

// --- records ------------------------------------------------------------------
function newRecord(kind, fields) {
  return {v: 1, kind, id: crypto.randomUUID(), at: new Date().toISOString(), ...fields};
}
// One lock per record file, and every record-file read-modify-write and
// append goes through it. The lock is config.withLock — the file lock the
// config / mcp / permissions stores already share (<file>.lock carrying a
// token + the holder's pid; a live holder is never stolen from, and a lock
// that cannot be taken within the budget throws instead of running
// unlocked). A full rewrite (forget / setHunchState) reads the file,
// filters it in memory and renames a temp file over it, while appendRecord
// appends a line: an append that landed between the rewrite's read and its
// rename used to be rewound away by the rename (lost update — wave-3
// measured 130 of 678 concurrent appends missing from the final file).
// Locking only the write half would not fix that, so a rewrite re-reads
// the file INSIDE the lock (see forget / setHunchState) and the append
// takes the same lock: the two can no longer interleave at all.
function withRecordLock(file, fn) { return configWithLock(file, fn); }
function appendRecordUnlocked(file, rec) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}
function appendRecord(cwd, rec) {
  if (!rec || !KINDS.includes(rec.kind)) return null;
  if (rec.path && isSensitive(rec.path)) return null; // a sensitive file's lore is not kept at all
  const ctx = repoContext(cwd);
  try {
    withRecordLock(ctx.file, () => appendRecordUnlocked(ctx.file, rec));
  } catch { return null; }
  return rec;
}
function readFileRecords(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && KINDS.includes(r.kind) && r.id) out.push(r); } catch {}
  }
  return out;
}
// Both places are read (local + shared), merged by id, in append (file)
// order: each file's own order is kept and the local file comes first.
// The records are NOT re-sorted by their `at` stamps: the clock can step
// backwards, and a record appended later must never be moved before one
// appended earlier just because its stamp is smaller — append order is
// the authoritative history, `at` is only a display date.
// Every record is stamped here with where it was actually read from
// (origin: 'local' | 'shared', plus shared:true for the shared file):
// the stored bytes carry no trustworthy provenance — a record in the
// shared file could claim any origin — so the stamp is derived from
// the file itself and overwrites whatever the record said. The stamp
// lives only on the in-memory copies readRecords returns; the writers
// (forget / setHunchState) go through readFileRecords, so it is never
// persisted back to disk.
function readRecords(cwd) {
  const ctx = repoContext(cwd);
  // The forgotten tombstones (state.forgotten) apply HERE, on every read,
  // to every kind of record — not only when syncFromWorklog re-derives.
  // A record the user forgot must stay gone even if its bytes come back:
  // a restored lore.jsonl, or the shared file arriving from another
  // machine, must not resurrect it. forget() tombstones every record it
  // removes, by dedupe key (derived records) and by id (all records).
  const forgotten = new Set(loadForgotten(ctx));
  const seen = new Set(), out = [];
  for (const [f, origin] of [[ctx.localFile, 'local'], [ctx.sharedFile, 'shared']]) {
    for (const r of readFileRecords(f)) {
      if (forgotten.size && ((r.key && forgotten.has(r.key)) || forgotten.has('id:' + r.id))) continue;
      if (!seen.has(r.id)) { seen.add(r.id); r.origin = origin; r.shared = origin === 'shared'; out.push(r); }
    }
  }
  return out;
}
// Raw full rewrite (temp file, then rename over the target). The caller
// must already hold withRecordLock for this file and must pass records it
// re-read inside that lock — this function takes no lock itself, so a
// caller that read outside the lock would still rewind concurrent appends.
function writeFileRecords(file, records) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    renameRetry(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
// An id (or id prefix) that matches several records names none of them:
// the callers surface this error's message, so it says what happened and
// how many records matched, and the operation changes nothing.
function ambiguousIdError(n) {
  const e = new Error(t('id が曖昧です（{n} 件に一致します）', {n}));
  e.code = 'ambiguous';
  e.count = n;
  return e;
}
// Resolve an id prefix to the ONE record it may mean, among the records
// the kind / path filters leave (the filters stay in force even when an
// id is given — an id used to override them and delete a record of a kind
// the caller had excluded). Several matches: throw ambiguousIdError.
// No match: null.
function resolveIdPrefix(cwd, {kind, path: p, id, kinds} = {}) {
  const hits = readRecords(cwd).filter(r =>
    String(r.id).startsWith(String(id)) &&
    (!kinds || kinds.includes(r.kind)) &&
    (!kind || r.kind === kind) &&
    (!p || r.path === p));
  if (hits.length > 1) throw ambiguousIdError(hits.length);
  return hits.length ? hits[0].id : null;
}
// The user's delete (design common rule: records besides secrets are erasable).
function forget(cwd, {kind, path: p, id, all} = {}) {
  const ctx = repoContext(cwd);
  // An id names one record, by prefix only when the prefix is unambiguous
  // (see resolveIdPrefix). Resolve it to the full id BEFORE touching any
  // file: an ambiguous id deletes nothing at all, and the per-file rewrite
  // below then removes exactly that one record.
  let targetId = null;
  if (id) {
    targetId = resolveIdPrefix(cwd, {kind, path: p, id});
    if (targetId === null) return 0;
  }
  const removedIds = new Set();
  const tombstones = [];
  let failure = null;
  for (const f of [ctx.localFile, ctx.sharedFile]) {
    if (!fs.existsSync(f)) continue; // nothing to rewrite — and taking the lock would create the shared file's .muser folder in a repo that has none
    // The whole read-filter-write runs under the record file's lock, and
    // the read happens inside it: records appended by another window after
    // this read are part of `before`, so the rename cannot rewind them
    // (and appends arriving during the rewrite wait for the lock instead).
    let outcome = null;
    try {
      outcome = withRecordLock(f, () => {
        const before = readFileRecords(f);
        if (!before.length) return null;
        // A selector (--kind / --path / --id) narrows --all instead of
        // being overridden by it: with both, only the records the selector
        // matches are deleted; --all on its own still deletes everything,
        // and a selector on its own deletes exactly what it matches.
        const kept = before.filter(r => {
          if (id) return r.id !== targetId;
          if (kind || p) {
            if (kind && r.kind !== kind) return true;
            if (p && r.path !== p) return true;
            return false;
          }
          return !all;
        });
        if (kept.length === before.length) return null;
        writeFileRecords(f, kept);
        const gone = before.filter(r => !kept.includes(r));
        return {ids: gone.map(r => r.id), tombs: gone.flatMap(r => [...(r.key ? [r.key] : []), 'id:' + r.id])};
      });
    } catch (e) { failure = failure || e; continue; }
    // Count only what the write actually removed: a failed write used to
    // be swallowed after counting, so forget reported deletions that never
    // happened and the records were still on disk. And count RECORDS, not
    // file copies: the same record living in both the local and the
    // shared file is one record, however many files it was removed from.
    if (outcome) { for (const x of outcome.ids) removedIds.add(x); tombstones.push(...outcome.tombs); }
  }
  if (tombstones.length) { const forg = new Set(loadForgotten(ctx)); for (const k of tombstones) forg.add(k); try { saveForgotten(ctx, forg); } catch (e) { failure = failure || e; } }
  if (failure) throw failure;
  return removedIds.size;
}
function addHunch(cwd, {path: p, line, text, state = 'open'} = {}) {
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(p || ''));
  if (!rel || !String(text || '').trim()) return null;
  if (!HUNCH_STATES.includes(state)) state = 'open';
  const lines = readLines(path.join(ctx.root, rel));
  const a = anchor(lines, line || 1, line || 1);
  return appendRecord(cwd, newRecord('hunch', {path: rel, ...a, text: clean(text, 300), state}));
}
// A scar offered from outside the work-log sync — the bug hunt's proven
// fixes (src/hunt.js offerScarsToLore). Same record shape the sync derives
// from a turn's edits, anchored on the file as it stands now; the offering
// is deduped by key, so offering the same fix twice records it once.
function recordScar({cwd, file, summary, tests} = {}) {
  if (!cwd || !file || !String(summary || '').trim()) return null;
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(file));
  if (!rel) return null;
  const key = 'scar|offered|' + rel + '|' + hashText(String(summary));
  if (loadForgotten(ctx).includes(key)) return null; // offered again, but the user already forgot this scar
  if (readRecords(cwd).some(r => r.key === key)) return null;
  const lines = readLines(path.join(ctx.root, rel));
  const a = lines && lines.length ? anchor(lines, 1, lines.length) : {start: 0, end: 0, hash: null, text: [], before: [], after: []};
  const testFile = Array.isArray(tests) && tests.length ? relOf(ctx.root, String(tests[0])) : '';
  return appendRecord(cwd, newRecord('scar', {path: rel, ...a, bug: clean(summary, 300), testFile, testName: '', verified: false, key}));
}
function setHunchState(cwd, id, state) {
  if (!HUNCH_STATES.includes(state)) return false;
  const ctx = repoContext(cwd);
  // The same id rule as forget(): a prefix names a hunch only when it is
  // the ONLY hunch it matches. Several matches are ambiguous — the error
  // says so, with the count, and nothing changes; the first match used to
  // be silently taken and the rest left in their old state.
  const targetId = resolveIdPrefix(cwd, {id, kinds: ['hunch']});
  if (targetId === null) return false;
  let done = false;
  for (const f of [ctx.localFile, ctx.sharedFile]) {
    if (!fs.existsSync(f)) continue; // no records there (and no .muser folder created for the shared side)
    // Same lock + re-read-inside shape as forget(): the state change is a
    // full rewrite, so it must not rewind appends that land while it runs.
    // Every copy of the record (local and shared) gets the new state, so
    // the merged read cannot resurrect the old one from the other file.
    let found = false;
    try {
      found = withRecordLock(f, () => {
        const records = readFileRecords(f);
        const hit = records.find(r => r.kind === 'hunch' && r.id === targetId);
        if (!hit) return false;
        hit.state = state;
        writeFileRecords(f, records);
        return true;
      });
    } catch { return false; }
    if (found) done = true;
  }
  return done;
}

// --- queries --------------------------------------------------------------------
function isTestPath(rel) { return /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel); }
function located(records, cwd) {
  const ctx = repoContext(cwd);
  // One read per file per call: a file's current lines are read once and
  // shared by every record anchored in it (notesFor / storyFor locate a
  // whole file's records at once), keyed by the resolved absolute path so
  // different spellings of the same path share the one read.
  const cache = new Map();
  return records.map(rec => {
    const key = path.resolve(ctx.root, rec.path || '');
    if (!cache.has(key)) cache.set(key, readLines(key));
    return {rec, loc: locate(rec, cache.get(key))};
  });
}
function whyFor(cwd, file, line, {limit = 3} = {}) {
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(file || ''));
  // A lost record takes no part in the range match: its recorded range
  // names lines whose content is no longer there, so answering "why" for
  // whatever sits there now would pin the reason on unrelated code.
  const hits = located(readRecords(cwd).filter(r => r.kind === 'why' && r.path === rel), cwd)
    .filter(({loc}) => loc.status !== 'lost' && line >= loc.start && line <= loc.end);
  // Newest first means LAST-appended first: the hits arrive in append
  // order, and sorting by the `at` string instead would, after a backward
  // clock step, present an earlier edit's reason as the newest one.
  return hits.reverse().slice(0, limit);
}
function listKind(cwd, kind) {
  // Last-appended first, like whyFor — not an `at` sort (see readRecords).
  return located(readRecords(cwd).filter(r => r.kind === kind), cwd).reverse();
}
function storyFor(cwd, file) {
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(file || ''));
  // Append order (readRecords already returns it) — never re-sorted by
  // the `at` stamps, which a backward clock step would scramble.
  return located(readRecords(cwd).filter(r => r.path === rel), cwd);
}
// What Muse is told when it reads or edits a range (design: 守らせる).
// Scars, graves and still-open hunches on the path, overlapping the range
// when one is given, at most ATTACH_MAX, shortest first.
function noteEntries(cwd, file, range) {
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(file || ''));
  const pool = readRecords(cwd).filter(r => r.path === rel && (r.kind === 'scar' || r.kind === 'grave' || (r.kind === 'hunch' && (r.state || 'open') === 'open')));
  const hits = located(pool, cwd).filter(({rec, loc}) => {
    if (!range) return true;
    const s = loc.status !== 'lost' ? loc.start : rec.start, e = loc.status !== 'lost' ? loc.end : rec.end;
    return s <= range.end && range.start <= e;
  });
  return hits.slice(0, ATTACH_MAX).map(({rec, loc}) => ({rec, loc, text: formatNote(rec, loc)}));
}
function notesFor(cwd, file, range) {
  return noteEntries(cwd, file, range).map(({text}) => text);
}
function attachText(cwd, file, range) {
  const entries = noteEntries(cwd, file, range);
  if (!entries.length) return '';
  const local = entries.filter(({rec}) => rec.origin !== 'shared');
  const shared = entries.filter(({rec}) => rec.origin === 'shared');
  const sections = [];
  if (local.length) sections.push('[muser: ' + t('言い伝え') + ']\n' + local.map(({text}) => text).join('\n'));
  // Shared records (.muser/lore.jsonl) arrive from the repository, not
  // from this PC's own work: whoever cloned the repo could have written
  // them, and the share switch only chooses where NEW records go — it
  // says nothing about records already in the file. They must never
  // ride in under the plain local heading as if they were this PC's
  // own verified lore, so they get their own downgraded heading and a
  // per-note mark: unverified claims to weigh, not instructions from
  // this PC's history. (Hunches were already worded as unconfirmed;
  // scar/grave notes are not, which is what made this matter.)
  if (shared.length) sections.push('[muser: ' + t('リポジトリに共有された言い伝え（未検証）') + ']\n' + shared.map(({text}) => t('（共有・未検証）') + text).join('\n'));
  return sections.join('\n');
}
// Writing back code that was deleted on purpose: an exact hash hit on a
// window of the new text, or a line-set resemblance of 0.7 or more against
// the grave's kept lines.
function graveResemblance(cwd, file, newText) {
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(file || ''));
  // The whole new text is scanned, not just its head: a block written back
  // deep in a file is still a write-back. (The input is sanity-capped so a
  // pathological paste cannot make this scan unbounded.)
  const newLines = cleanLines(String(newText || '').slice(0, 2000000).split(/\r?\n/), 20000, 1e9);
  const newSet = new Set(newLines.map(l => l.trim()).filter(Boolean));
  for (const g of readRecords(cwd).filter(r => r.kind === 'grave' && r.path === rel)) {
    if (g.deletedHash && g.deletedLines > 0) {
      for (let s = 0; s + g.deletedLines <= newLines.length; s++) {
        if (hashText(newLines.slice(s, s + g.deletedLines).join('\n')) === g.deletedHash) return {grave: g, how: 'hash', score: 1};
      }
    }
    const oldSet = new Set((g.linesText || []).map(l => l.trim()).filter(Boolean));
    if (oldSet.size >= 3 && newSet.size) {
      let inter = 0;
      for (const l of oldSet) if (newSet.has(l)) inter++;
      const score = inter / Math.max(oldSet.size, 1);
      if (score >= 0.7) return {grave: g, how: 'similar', score};
    }
  }
  return null;
}
// The lines a code.apply_patch call would add, grouped by the file each
// patch section targets — the grave check's new text for a patch, which
// has neither a path nor a content field of its own.
function patchAdditions(patchText) {
  const byFile = new Map();
  let cur = '';
  for (const l of String(patchText || '').split(/\r?\n/)) {
    const m = /^\*\*\* (?:Update|Add) File: (.+)$/.exec(l) || /^\*\*\* Move to: (.+)$/.exec(l);
    if (m) { cur = m[1].trim(); if (!byFile.has(cur)) byFile.set(cur, []); continue; }
    if (l.startsWith('*** ')) { cur = ''; continue; }
    if (cur && l.startsWith('+') && !l.startsWith('+++')) byFile.get(cur).push(l.slice(1));
  }
  return [...byFile.entries()].map(([file, lines]) => ({file, text: lines.join('\n')}));
}
function blame(cwd, file, line) {
  const ctx = repoContext(cwd);
  const rel = relOf(ctx.root, String(file || ''));
  const out = git(ctx.root, ['blame', '--porcelain', '-L', line + ',' + line, '--', rel]);
  if (!out) return null;
  const get = k => { const m = new RegExp('^' + k + ' (.+)$', 'm').exec(out); return m ? m[1].trim() : ''; };
  const time = Number(get('author-time'));
  const date = Number.isFinite(time) && time > 0 ? new Date(time * 1000).toISOString().slice(0, 10) : '';
  return {hash: out.split(' ')[0], author: get('author'), date, summary: get('summary')};
}

// --- formatting (the lines both screens and the CLI print) ----------------------
// Records can arrive through a shared .muser/lore.jsonl written elsewhere,
// so their fields are untrusted at display time even though this PC's own
// writers clean() them: every interpolated field goes through clean() here
// (sanitizeText strips escape sequences and control characters, and the
// whitespace collapse keeps a stored newline from forging a heading line).
// Only the printed string is washed — the stored record is never rewritten.
function disp(s, max = 500) { return clean(s ?? '', max); }
function dispNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtDate(iso) { const s = String(iso || ''); return s.length >= 10 ? disp(s.slice(5, 7) + '/' + s.slice(8, 10), 20) : ''; }
function rangeText(rec, loc) {
  const s = loc && loc.status !== 'lost' ? loc.start : rec.start, e = loc && loc.status !== 'lost' ? loc.end : rec.end;
  if (!s) return '';
  return disp(':' + (e && e !== s ? s + '-' + e : String(s)), 60);
}
function lostSuffix(loc) { return loc && loc.status === 'lost' ? t('（場所を見失った）') : ''; }
function changedSuffix(loc) { return loc && loc.changed ? t('（内容が変わっています）') : ''; }
function formatNote(rec, loc) {
  const d = fmtDate(rec.at);
  if (rec.kind === 'scar') return t('この場所は {date} に直したバグ（{bug}）の場所。回帰テスト {test}', {date: d, bug: disp(rec.bug || ''), test: disp((rec.testFile || '') + (rec.testName ? ' ' + rec.testName : ''))}) + (rec.verified ? t('（反証テストで確かめ済み）') : '') + lostSuffix(loc) + changedSuffix(loc);
  if (rec.kind === 'grave') return t('{date} にここから {n} 行を消しました（{reason}）', {date: d, n: dispNum(rec.deletedLines), reason: disp(rec.reason || '')}) + lostSuffix(loc) + changedSuffix(loc);
  if (rec.kind === 'hunch') return t('未確認の前提: {text}', {text: disp(rec.text || '')}) + lostSuffix(loc) + changedSuffix(loc);
  return '';
}
function formatRecord(rec, loc) {
  const d = fmtDate(rec.at), at = disp(rec.path || '', 1000) + rangeText(rec, loc);
  if (rec.kind === 'why') return t('{date} why {at} {agent} {reason}', {date: d, at, agent: rec.agent ? '[' + disp(rec.agent, 100) + ']' : '', reason: disp(rec.reason || rec.request || '')}).trim() + lostSuffix(loc) + changedSuffix(loc);
  if (rec.kind === 'scar') return t('{date} 傷跡 {at} {bug}（回帰テスト {test}）', {date: d, at, bug: disp(rec.bug || ''), test: disp((rec.testFile || '') + (rec.testName ? ' ' + rec.testName : ''))}).trim() + (rec.verified ? t('（反証テストで確かめ済み）') : '') + lostSuffix(loc) + changedSuffix(loc);
  if (rec.kind === 'grave') { const head = rec.head ? disp(String(rec.head).split('\n')[0]) : ''; return t('{date} 墓標 {at} {n} 行を削除: {reason}', {date: d, at: disp(rec.path || '', 1000), n: dispNum(rec.deletedLines), reason: disp(rec.reason || '')}).trim() + (head ? ' — ' + head : '') + lostSuffix(loc) + changedSuffix(loc); }
  if (rec.kind === 'hunch') return t('{date} 仮説付箋 {at} [{state}] {text}', {date: d, at, state: t(({open: '未確認', confirmed: '確認済み', wrong: '外れ'})[rec.state || 'open'] || '未確認'), text: disp(rec.text || '')}).trim() + lostSuffix(loc) + changedSuffix(loc);
  return '';
}

// --- the work log (read side only; the writer is another branch) ----------------
function readWorklogEvents(dir = worklogDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const events = [];
  for (const name of names) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    raw.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { const e = JSON.parse(line); const kind = e && (typeof e.event === 'string' ? e.event : typeof e.type === 'string' ? e.type : null); if (kind) events.push({...e, type: kind, _conv: decodeId(name.replace(/\.jsonl$/, '')), _idx: i}); } catch {}
    });
  }
  return events;
}
function blobText(dir, hash) {
  if (!hash || !/^[0-9a-f]+$/i.test(String(hash))) return null;
  return Worklog.readBlob(String(hash), dir);
}
// The reason is a plain sentence from the reply, not its Markdown: headings
// ("**バグと修正（`calc.js`）**", "## 変更") name the file but say nothing, so
// they are skipped, and emphasis / code marks / list bullets are removed.
// Preference: a sentence naming the file AND describing a change, then any
// change sentence, then a sentence naming the file.
const CHANGE_WORDS = /(変更|修正|追加|削除|直し|直す|直した|変え|足し|消し|changed|fixed|added|removed|replaced)/i;
function pickReason(reply, base) {
  const sentences = [];
  for (const raw of String(reply || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line) || /^(```|\|)/.test(line)) continue; // heading, bold-only line, fence, table row
    const plain = line.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '').trim();
    for (const s of plain.split(/(?:。|！|？)+/)) { const t = s.trim(); if (t.length >= 4) sentences.push(t); }
  }
  const pick = s => clean(s, 200);
  if (base) { const hit = sentences.find(s => s.includes(base) && CHANGE_WORDS.test(s)); if (hit) return pick(hit); }
  const change = sentences.find(s => CHANGE_WORDS.test(s));
  if (change) return pick(change);
  if (base) { const hit = sentences.find(s => s.includes(base)); if (hit) return pick(hit); }
  return '';
}
function editRange(e) {
  // The writer's shape: `ranges`, a list of {start, end} runs — the edit's
  // span is from the first run's start to the last run's end.
  if (Array.isArray(e.ranges) && e.ranges.length) {
    const starts = e.ranges.map(r => Number(r && r.start)).filter(Number.isFinite);
    const ends = e.ranges.map(r => Number(r && (r.end ?? r.start))).filter(Number.isFinite);
    if (starts.length && ends.length) return {start: Math.min(...starts), end: Math.max(...ends)};
  }
  if (e.range && Number(e.range.start)) return {start: Number(e.range.start), end: Number(e.range.end || e.range.start)};
  if (Number(e.start)) return {start: Number(e.start), end: Number(e.end || e.start)};
  if (e.lines && Number(e.lines.start)) return {start: Number(e.lines.start), end: Number(e.lines.end || e.lines.start)};
  return null;
}
function diffRemovedLines(diff) {
  return String(diff || '').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1));
}
function diffTestName(diff) {
  for (const l of String(diff || '').split('\n')) {
    if (!l.startsWith('+')) continue;
    const m = /(?:test|it)\(\s*['"`]([^'"`]+)['"`]/.exec(l);
    if (m) return m[1];
  }
  return '';
}
// Turn the work log's edits into why / scar / grave records. Idempotent:
// a derived record's key names its source edit, and known keys are skipped.
function syncFromWorklog(cwd, {dir = worklogDir()} = {}) {
  const ctx = repoContext(cwd);
  const known = new Set([...readRecords(cwd).map(r => r.key).filter(Boolean), ...loadForgotten(ctx)]);
  const events = readWorklogEvents(dir);
  const byConv = new Map();
  for (const e of events) { if (!byConv.has(e._conv)) byConv.set(e._conv, []); byConv.get(e._conv).push(e); }
  const added = [];
  const push = rec => { if (rec && !known.has(rec.key)) { const saved = appendRecord(cwd, rec); if (saved) { known.add(rec.key); added.push(saved); } } };
  for (const [conv, list] of byConv) {
    // First pass: number the turns and keep each turn's request and reply, so
    // an edit can be tied to its turn even though the reply lands after it.
    let turnNo = 0;
    const turns = new Map();
    for (const e of list) {
      if (e.type === 'turn') { turnNo++; e._turn = turnNo; turns.set(turnNo, {agent: clean(e.agent || '', 40), request: clean(e.request || e.text || '', 200), reply: ''}); }
      else e._turn = turnNo;
      if (e.type === 'reply') { const tn = turns.get(e._turn); if (tn) tn.reply = String(e.text || e.reply || ''); }
    }
    const edits = list.filter(e => e.type === 'edit' && e.path);
    const prepared = edits.map(e => {
      const rel = relOf(ctx.root, String(e.path));
      const tn = turns.get(e._turn) || {agent: '', request: '', reply: ''};
      return {e, rel, tn, range: editRange(e), at: typeof e.at === 'string' ? e.at : undefined, base: path.posix.basename(rel)};
    }).filter(x => isLocalRel(x.rel) && !isSensitive(x.rel));
    for (const x of prepared) {
      const reason = pickReason(x.tn.reply, x.base) || x.tn.request;
      // why ranges are anchored against the file as it stands now, but only
      // a window whose hash is the edit's afterHash may be adopted as the
      // anchor (see editAnchor); when it is no longer there the record is
      // kept with no adopted content, so it locates as 'lost', not 'exact'.
      const lines = readLines(path.join(ctx.root, x.rel));
      const a = editAnchor(lines, x.range, x.e.afterHash);
      push(newRecord('why', {path: x.rel, ...a, at: x.at || new Date().toISOString(), turn: x.e._turn || undefined, session: conv, agent: clean(x.e.agent || x.tn.agent, 40), request: x.tn.request, reason, key: 'why|' + x.rel + '|' + (x.e.afterHash || '') + '|' + (x.at || '') + '|' + x.e._idx}));
      // grave: 10+ removed lines, or the edit says a whole block went away.
      const removed = diffRemovedLines(x.e.diff);
      const removedCount = Number.isSafeInteger(x.e.removed) ? x.e.removed : Number.isSafeInteger(x.e.removedLines) ? x.e.removedLines : removed.length;
      if (removedCount >= GRAVE_MIN_LINES || x.e.block === true) {
        let deleted = cleanLines(removed, 200);
        if (!deleted.length) { const blob = blobText(dir, x.e.beforeHash); if (blob != null && !x.e.afterHash) deleted = cleanLines(blob.split(/\r?\n/), 200); }
        if (deleted.length) push(newRecord('grave', {path: x.rel, ...a, at: x.at || new Date().toISOString(), deletedHash: hashText(deleted.join('\n')), deletedLines: deleted.length, head: deleted.slice(0, 3).join('\n'), linesText: deleted.slice(0, 50), reason, session: conv, key: 'grave|' + x.rel + '|' + hashText(deleted.join('\n')) + '|' + (x.at || '') + '|' + x.e._idx}));
      }
    }
    // scar: a turn that touched both a test file and a non-test file fixed
    // something; the non-test edits are the scar, the test file guards them.
    const byTurn = new Map();
    for (const x of prepared) { if (!byTurn.has(x.e._turn)) byTurn.set(x.e._turn, []); byTurn.get(x.e._turn).push(x); }
    for (const group of byTurn.values()) {
      const tests = group.filter(x => isTestPath(x.rel)), fixes = group.filter(x => !isTestPath(x.rel));
      if (!tests.length || !fixes.length) continue;
      // A scar means "a bug was fixed and a test now guards it" (design §5).
      // Merely touching a test file in the same turn — a feature add that
      // adjusts an existing test — proves neither, so a guard counts only
      // when a test edit ADDS a named test or CREATES the test file.
      const guard = tests.map(x => ({x, name: diffTestName(x.e.diff), created: x.e.beforeHash === hashText('')})).find(g => g.name || g.created);
      if (!guard) continue;
      for (const x of fixes) {
        const reason = pickReason(x.tn.reply, x.base) || x.tn.request;
        const lines = readLines(path.join(ctx.root, x.rel));
        const a = editAnchor(lines, x.range, x.e.afterHash);
        push(newRecord('scar', {path: x.rel, ...a, at: x.at || new Date().toISOString(), testFile: guard.x.rel, testName: guard.name, bug: reason, verified: false, session: conv, key: 'scar|' + x.rel + '|' + (x.e.afterHash || '') + '|' + (x.at || '') + '|' + x.e._idx}));
      }
    }
  }
  return {added, events: events.length};
}

// --- CLI (muser lore …) -----------------------------------------------------------
function parseFileLine(spec) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(String(spec || '').trim());
  if (!m) return null;
  const start = Number(m[2]), end = Number(m[3] || m[2]);
  // \d+ has no length limit: 4294967297 wraps to line 1 through anchor()'s
  // |0 coercion, and a 20-digit number becomes a garbage 1e20 start. A line
  // number counts only as a safe integer in a realistic range (1 up to but
  // not including LINE_LIMIT); anything else is a usage error, i.e. null.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start >= LINE_LIMIT || end < start || end >= LINE_LIMIT) return null;
  return {file: m[1], start, end};
}
// The text form of a record listing (what `muser lore scars` / `story`
// print, through bin/muser.js): capped at LIST_CAP lines, with the number
// of records left over noted — a store with thousands of records used to
// dump every one of them into the terminal.
function listLines(hits) {
  const lines = hits.slice(0, LIST_CAP).map(h => formatRecord(h.rec, h.loc));
  if (hits.length > LIST_CAP) lines.push(t('  … ほか {n} 件', {n: hits.length - LIST_CAP}));
  return lines;
}
function runLoreCli(argv, {cwd = process.cwd(), out = s => console.log(s), sync = true} = {}) {
  const args = [...(argv || [])];
  const json = args.includes('--json');
  const words = args.filter(a => a !== '--json');
  const sub = words[0] || 'list';
  const print = lines => { for (const l of lines) out(l); };
  try {
    if (sync && sub !== 'share' && sub !== 'sync') syncFromWorklog(cwd); // 'sync' runs its own pass below, so its count is real
    if (sub === 'why') {
      const target = parseFileLine(words[1]);
      if (!target) { out(t('使い方: muser lore why <ファイル>:<行>')); return 1; }
      const hits = whyFor(cwd, target.file, target.start);
      const b = blame(cwd, target.file, target.start);
      if (json) { out(JSON.stringify({why: hits.map(h => h.rec), blame: b})); return 0; }
      const lines = [];
      if (b) lines.push(t('git blame: {author} {date} {summary}', {author: disp(b.author, 100), date: disp(b.date, 20), summary: disp(b.summary)}));
      if (!hits.length) lines.push(t('その行の言い伝えはまだありません。'));
      for (const h of hits) lines.push(formatRecord(h.rec, h.loc));
      print(lines); return 0;
    }
    if (sub === 'scars' || sub === 'graves' || sub === 'hunches') {
      const kind = {scars: 'scar', graves: 'grave', hunches: 'hunch'}[sub];
      const hits = listKind(cwd, kind);
      if (json) { out(JSON.stringify(hits.map(h => h.rec))); return 0; }
      if (!hits.length) { out(t('まだありません。')); return 0; }
      print(listLines(hits)); return 0;
    }
    if (sub === 'story') {
      if (!words[1]) { out(t('使い方: muser lore story <ファイル>')); return 1; }
      const hits = storyFor(cwd, words[1]);
      if (json) { out(JSON.stringify(hits.map(h => h.rec))); return 0; }
      if (!hits.length) { out(t('そのファイルの言い伝えはまだありません。')); return 0; }
      print(listLines(hits)); return 0;
    }
    if (sub === 'hunch') {
      const target = parseFileLine(words[1]);
      const text = words.slice(2).join(' ');
      if (!target || !text) { out(t('使い方: muser lore hunch <ファイル>:<行> <前提>')); return 1; }
      const rec = addHunch(cwd, {path: target.file, line: target.start, text});
      if (!rec) { out(t('仮説付箋を書けませんでした（機密ファイルには書きません）。')); return 1; }
      out(t('仮説付箋を書きました: {id}', {id: rec.id})); return 0;
    }
    if (sub === 'hunch-state') {
      if (!words[1] || !HUNCH_STATES.includes(words[2])) { out(t('使い方: muser lore hunch-state <id> open|confirmed|wrong')); return 1; }
      if (!setHunchState(cwd, words[1], words[2])) { out(t('その仮説付箋が見つかりません。')); return 1; }
      out(t('仮説付箋の状態を変えました: {state}', {state: words[2]})); return 0;
    }
    if (sub === 'share') {
      if (words[1] === 'on' || words[1] === 'off') {
        const ctx = setShared(cwd, words[1] === 'on');
        out(ctx.shared ? t('これからの言い伝えはリポジトリの .muser/lore.jsonl に書きます（秘密は書く前に無害化します）。') : t('これからの言い伝えはこの PC の中にだけ書きます。'));
        return 0;
      }
      const ctx = repoContext(cwd);
      out(ctx.shared ? t('共有: オン（リポジトリの .muser/lore.jsonl）') : t('共有: オフ（この PC の中だけ）'));
      return 0;
    }
    if (sub === 'sync') {
      const r = syncFromWorklog(cwd);
      out(t('作業ログから {n} 件の言い伝えを作りました（出来事 {events} 件）。', {n: r.added.length, events: r.events}));
      return 0;
    }
    if (sub === 'forget') {
      // A word swallowed as another flag's value is not itself a flag:
      // in `forget --path --all` the `--all` is the path's value, so it
      // must not set off a delete-everything. Scan in order and let the
      // value-taking flags consume the word after them.
      const opts = {all: false};
      for (let i = 1; i < words.length; i++) {
        if (words[i] === '--all') opts.all = true;
        else if (words[i] === '--kind') opts.kind = words[++i];
        else if (words[i] === '--path') opts.path = words[++i];
        else if (words[i] === '--id') opts.id = words[++i];
      }
      if (!opts.all && !opts.kind && !opts.path && !opts.id) { out(t('使い方: muser lore forget --all | --kind <種類> | --path <ファイル> | --id <id>')); return 1; }
      const ctx = repoContext(cwd);
      if (opts.path) opts.path = relOf(ctx.root, opts.path);
      out(t('{n} 件消しました。', {n: forget(cwd, opts)}));
      return 0;
    }
    if (sub === 'list') {
      const records = readRecords(cwd);
      const ctx = repoContext(cwd);
      if (json) { out(JSON.stringify(records)); return 0; }
      const count = k => records.filter(r => r.kind === k).length;
      print([
        t('言い伝え: why {why} / 傷跡 {scar} / 墓標 {grave} / 仮説付箋 {hunch}', {why: count('why'), scar: count('scar'), grave: count('grave'), hunch: count('hunch')}),
        t('置き場所: {place}', {place: ctx.shared ? t('リポジトリの .muser/lore.jsonl（共有）') : disp(ctx.localFile, 1000)}),
      ]);
      return 0;
    }
    out(t('使い方: muser lore [why <ファイル>:<行> | scars | graves | hunches | story <ファイル> | hunch <ファイル>:<行> <前提> | share [on|off] | sync | forget …]'));
    return 1;
  } catch (e) {
    out(t('言い伝えを扱えませんでした: {error}', {error: disp(e.message, 300)}));
    return 1;
  }
}

module.exports = {KINDS, HUNCH_STATES, GRAVE_MIN_LINES, ATTACH_MAX, LIST_CAP, dataRoot, loreBase, worklogDir, repoRoot, repoId, repoContext, setShared, relOf, hashText, clean, anchor, locate, readLines, appendRecord, readRecords, forget, addHunch, recordScar, setHunchState, isTestPath, whyFor, listKind, storyFor, notesFor, attachText, graveResemblance, patchAdditions, blame, fmtDate, formatRecord, formatNote, readWorklogEvents, syncFromWorklog, pickReason, parseFileLine, runLoreCli};
