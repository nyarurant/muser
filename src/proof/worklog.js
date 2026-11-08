'use strict';
// Worklog READER for /proof (design: docs/design/new-features.md §1–§3).
//
// The writer is src/worklog.js (driven from agent.js); this module only
// reads, through that module's own file naming and line parsing, and
// normalises each event into the shape the badge/counter code judges.
// On-disk shape (design §1, as written):
//   %LOCALAPPDATA%\muser\worklog\<conversation id>.jsonl — one event per line:
//     turn   {event:'turn',  v, at, session, agent, parentAgent?, text}  (request head)
//     tool   {event:'tool',  at, command, summary, paths?, ok, exitCode?, ms?,
//             outChars, outHash, outHead?, outTail?}
//     edit   {event:'edit',  at, path, op, beforeHash, afterHash, added,
//             removed, ranges, diff}   (or {withheld} for a sensitive path)
//     expect {event:'expect', …}   (unexpected-stop feature; read, not judged here)
//     reply  {event:'reply', at, agent, text}
//     focus  {event:'focus', at, focus:{…}}  (Focus criteria/evidence as recorded)
//     gap    {event:'gap',   at, dropped, error}
//   Before-images of edits live whole in worklog\blobs\<beforeHash>.
// The discriminator is `event`; the reader still accepts the older
// spellings (type, prompt|request for a turn's text, path|file,
// beforeHash|before|prevHash, outHead|head|outputHead, outTail|tail|
// outputTail, at|ts|time) so a log written by an older build still reads.
// Retention is the writer's job: src/worklog.js prunes the folder itself
// (30 days / 500 MB, on every write of a session), so this module no
// longer carries a second sweep.
//
// Secrets never pass through here: an event whose path is a sensitive path
// (tools.js isSensitivePath) is dropped whole, and blob reads refuse
// sensitive-looking names — a proof line must never quote a secret file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {t} = require('../i18n.js');
const {isSensitivePath} = require('../tools.js');
const {Worklog, fileFor, readFileFor, RETENTION_DAYS, MAX_TOTAL_BYTES: RETENTION_MAX_BYTES} = require('../worklog.js');

function worklogDir(base) {
  const root = base || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(root, 'muser', 'worklog');
}
function blobsDir(base) { return path.join(worklogDir(base), 'blobs'); }
// A conversation id becomes a file name through the writer's own naming
// (src/worklog.js fileFor), so a crafted id can never walk out of the
// worklog folder and reader and writer always name the same file.
function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9-]/g, ''); }
function worklogFile(id, base) { return fileFor(id, worklogDir(base)); }

function atOf(e) {
  const v = e.at ?? e.ts ?? e.time;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : 0;
}
function outText(e) {
  const head = String(e.outHead ?? e.head ?? e.outputHead ?? '');
  const tail = String(e.outTail ?? e.tail ?? e.outputTail ?? '');
  return head + (head && tail ? '\n' : '') + tail;
}
function pathOf(e) { return String(e.path ?? e.file ?? ''); }
function pathsOf(e) {
  const list = [];
  if (pathOf(e)) list.push(pathOf(e));
  for (const p of Array.isArray(e.paths) ? e.paths : []) if (p && !list.includes(String(p))) list.push(String(p));
  return list;
}

// One raw line → one normalised event, or null (blank / broken / a secret
// path's event, which is dropped rather than quoted).
function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeof raw.event === 'string' ? raw.event : typeof raw.type === 'string' ? raw.type : null;
  if (!type) return null;
  const e = {...raw, type, atMs: atOf(raw)};
  if (e.type === 'tool') { e.output = outText(raw); e.paths = pathsOf(raw); e.path = e.paths[0] || ''; }
  if (e.type === 'edit') {
    e.path = pathOf(raw);
    e.beforeHash = String(raw.beforeHash ?? raw.before ?? raw.prevHash ?? '');
    e.afterHash = String(raw.afterHash ?? raw.after ?? '');
    if (!e.path) return null;
  }
  if (e.type === 'reply') e.text = String(raw.text ?? raw.reply ?? '');
  if (e.type === 'turn') e.prompt = String(raw.text ?? raw.prompt ?? raw.request ?? '');
  const touched = e.type === 'edit' ? [e.path] : e.type === 'tool' ? e.paths : [];
  if (touched.some(p => { try { return isSensitivePath(p); } catch { return false; } })) return null;
  return e;
}

// The counts a read had to skip (src/worklog.js readFile reports the same
// names): broken lines — unparseable, or valid JSON that is not an object
// (a scalar / an array is not an event) — as `badLines`, and lines whose
// `session` names another conversation as `foreignLines` (alias
// `foreign`). They ride the events array as non-enumerable properties so
// the array itself still compares and prints exactly as before, and
// splitTurns / formatBadLineNote below can pick them up.
function attachCounts(events, badLines, foreignLines) {
  try {
    Object.defineProperties(events, {
      badLines: {value: badLines, writable: true},
      foreignLines: {value: foreignLines, writable: true},
      foreign: {value: foreignLines, writable: true},
    });
  } catch { /* the events themselves still read fine */ }
  return events;
}

function parseWorklog(text, opts = {}) {
  const events = [];
  let badLines = 0, foreignLines = 0;
  const wanted = opts ? (opts.sessionId ?? opts.session) : null;
  const expectId = wanted != null && wanted !== '' ? String(wanted) : null;
  const raws = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw; try { raw = JSON.parse(line); } catch { badLines++; continue; } // a torn last line is a gap, not a crash
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { badLines++; continue; }
    raws.push(raw);
  }
  // Same foreign rule as src/worklog.js readFile: other sessions' lines
  // are foreign only when the conversation's own lines are present too
  // (a file uniformly naming one other session is that session's log
  // under a renamed / legacy-shared name, not a mix).
  const hasOwn = expectId != null && raws.some(r => r.session != null && String(r.session) === expectId);
  for (const raw of raws) {
    if (hasOwn && raw.session != null && String(raw.session) !== expectId) { foreignLines++; continue; }
    const e = normalise(raw);
    if (e) events.push(e);
  }
  return attachCounts(events, badLines, foreignLines);
}
// {events, badLines, foreignLines} or {missing:true} — a conversation with
// no worklog yet (the writer branch not merged, or recording off) is a
// normal answer, not an error. The file actually read may be the legacy
// stripped-name file (src/worklog.js readFileFor, the transcript side's
// rule): the encoded name wins when it exists, the legacy name is read
// only while it does not, and the returned `file` names the file read.
function readWorklog(id, {base} = {}) {
  const dir = worklogDir(base);
  const file = readFileFor(id, dir);
  if (!fs.existsSync(file)) return {missing: true, file: worklogFile(id, base), events: [], badLines: 0, foreignLines: 0, foreign: 0};
  const rawEntries = Worklog.readFile(file, {sessionId: String(id ?? '')});
  const events = [];
  for (const raw of rawEntries) { const e = normalise(raw); if (e) events.push(e); }
  const badLines = rawEntries.badLines || 0, foreignLines = rawEntries.foreignLines || 0;
  attachCounts(events, badLines, foreignLines);
  return {missing: false, file, events, badLines, foreignLines, foreign: foreignLines};
}

// A reply is the turn's own claim only when it is the main agent's: the
// writer defaults a reply's agent to 'main' (src/worklog.js makeReply),
// and a subagent's reply — recorded with the sub's own tag while it helped
// inside the turn — must never stand in for what main told the user, in
// either order. A reply with no agent at all predates the field (or a
// hand-made fixture) and reads as main's, as the writer would have written
// it. Sub replies stay in the turn's `events`; they are just not `reply`.
const isMainReply = e => e.agent === undefined || e.agent === null || e.agent === '' || e.agent === 'main';

// Group a flat event list into turns. A `turn` event opens a turn; events
// carrying an explicit turn number join that turn even without one. Events
// before the first `turn` form an implicit turn 0. A turn's `reply` is its
// LAST main reply (see isMainReply); its `gaps` are the turn's gap events
// (record lines that could not be written), for formatGapNote below.
function splitTurns(events) {
  // The read's skipped-line counts (see attachCounts) belong to the whole
  // conversation, not to one turn, but every turn carries them: whichever
  // turn /proof picks, formatBadLineNote can warn that a skipped TURN line
  // may have shifted the numbering of every later turn.
  const badLines = (events && events.badLines) || 0, foreignLines = (events && events.foreignLines) || 0;
  const turns = [];
  attachCounts(turns, badLines, foreignLines);
  let cur = null;
  const open = n => { cur = {turn: n, prompt: '', agent: '', events: [], tools: [], edits: [], reply: '', focus: null, gaps: [], badLines, foreignLines}; turns.push(cur); return cur; };
  for (const e of events || []) {
    if (e.type === 'turn') { open(e.turn ?? turns.length + 1); cur.prompt = e.prompt || ''; cur.agent = e.agent || ''; cur.events.push(e); continue; }
    if (!cur) open(e.turn ?? 0);
    else if (typeof e.turn === 'number' && turns.length && e.turn !== cur.turn && !turns.some(x => x.turn === e.turn)) open(e.turn);
    else if (typeof e.turn === 'number' && e.turn !== cur.turn) { const found = turns.find(x => x.turn === e.turn); if (found) cur = found; }
    cur.events.push(e);
    if (e.type === 'tool') cur.tools.push(e);
    else if (e.type === 'edit') cur.edits.push(e);
    else if (e.type === 'reply') { if (isMainReply(e) && e.text) cur.reply = e.text; }
    else if (e.type === 'focus') cur.focus = e;
    else if (e.type === 'gap') cur.gaps.push(e);
  }
  return turns;
}

// The gap events of a turn however the turn was built: splitTurns collects
// them in `gaps`, a hand-built turn may only carry them in `events`.
function gapEventsOf(turn) {
  if (!turn) return [];
  if (Array.isArray(turn.gaps)) return turn.gaps;
  return (turn.events || []).filter(e => e && e.type === 'gap');
}
// The /proof note for a turn whose record has holes, as display lines
// (empty when the record is whole). `dropped` on a gap event counts the
// record lines that were lost, so the note counts those; a gap that names
// no count still counts itself. The wording is the same one `muser log`
// lists gaps with. Callers spread this into the /proof lines (badge.js's
// formatProof / proof/index.js) — a gapped turn judged without this note
// would present an incomplete record as if it were the whole story.
// The /proof note for a conversation whose log had lines the reader had
// to skip (empty when nothing was skipped): broken lines, and lines from
// another conversation kept out of this one. One line, always: a skipped
// `turn` line renumbers every later turn, so a /proof that silently
// judged under shifted numbering would present the wrong turn's reply as
// the asked-for one — the user must be able to see that the turn
// correspondence may be off. Callers spread formatGapNote, which appends
// this note, into the /proof lines (badge.js's formatProof /
// proof/index.js).
function formatBadLineNote(turn) {
  const bad = Math.max(0, (turn && turn.badLines) | 0), foreign = Math.max(0, (turn && turn.foreignLines) | 0);
  const n = bad + foreign;
  if (!n) return [];
  return [t('読み飛ばした行 {n} 件があります（壊れた行 {bad} 件・他の会話の行 {foreign} 件。ターンの対応がずれている可能性があります）', {n, bad, foreign})];
}
function formatGapNote(turn) {
  const gaps = gapEventsOf(turn);
  const lines = [];
  if (gaps.length) {
    const dropped = gaps.reduce((n, g) => { const d = Number(g && g.dropped); return n + (Number.isFinite(d) && d > 0 ? Math.floor(d) : 0); }, 0);
    lines.push(t('記録の欠け {n} 件', {n: dropped > 0 ? dropped : gaps.length}));
  }
  return [...lines, ...formatBadLineNote(turn)];
}

// The turn a /proof asks about: an explicit number (1-based as the user
// counts, or the recorded turn value), else the newest turn with a reply.
// An explicit number that names no turn (0, 99, a non-number) is NOT the
// same as an empty log, so it no longer comes back as the plain null the
// caller reported as 『ログは空』: it returns a marker object instead —
//   {outOfRange: true, want, count, available, turn: null}
// where `want` is the requested number (the raw value when it is not a
// number), `count` is how many turns there are and `available` lists
// their turn values. null now means only that there are no turns at all.
// The marker is not a turn: it has no reply / events / tools / edits, and
// callers must check `outOfRange` before treating the result as one.
function pickTurn(turns, want) {
  if (!turns || !turns.length) return null;
  if (want !== undefined && want !== null && want !== '') {
    const n = Number(want);
    const hit = Number.isFinite(n) ? (turns.find(x => x.turn === n) || turns[n - 1]) : undefined;
    if (hit) return hit;
    return {outOfRange: true, want: Number.isFinite(n) ? n : want, count: turns.length, available: turns.map(x => x.turn), turn: null, badLines: turns.badLines || 0, foreignLines: turns.foreignLines || 0};
  }
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].reply) return turns[i];
  return turns[turns.length - 1];
}

// A blob name is a content hash, nothing else: refuse anything path-like or
// sensitive-looking before it ever reaches the filesystem.
function blobFile(hash, base) {
  const name = String(hash || '');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return null;
  try { if (isSensitivePath(name)) return null; } catch {}
  return path.join(blobsDir(base), name);
}
function readBlob(hash, {base} = {}) {
  if (!blobFile(hash, base)) return null; // the name guard above still decides
  return Worklog.readBlob(String(hash), worklogDir(base));
}

// No retention sweep lives here any more: the writer (src/worklog.js)
// prunes the folder itself on every write of a session, with the same
// values (RETENTION_DAYS / RETENTION_MAX_BYTES above are its constants,
// re-exported for the tests that pin them).

module.exports = {RETENTION_DAYS, RETENTION_MAX_BYTES, worklogDir, blobsDir, worklogFile, safeId, parseWorklog, readWorklog, splitTurns, pickTurn, formatGapNote, formatBadLineNote, blobFile, readBlob, outText};
