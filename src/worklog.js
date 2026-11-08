'use strict';
// Work log (design: docs/design/new-features.md §1, 2026-11-04): the
// foundation record most later features read. One JSON Lines file per
// conversation in %LOCALAPPDATA%\muser\worklog\<session id>.jsonl, one line
// per event: turn / tool / edit / expect / reply / focus / gap. The expect
// events (§4 of the design) are recorded through this same writer —
// src/agent.js hands its session Worklog to src/expect.js — so one queue,
// one sanitiser and one retention sweep cover every line of the file.
//
// The log is local only: nothing here sends anything anywhere. Secrets are
// never recorded — the contents of sensitive files (tools.js
// isSensitivePath), tokens and credentials are redacted before anything is
// kept, and tool output passes the same sanitising the screen uses
// (ui/sanitize.mjs: control sequences stripped — mirrored here because this
// module is CommonJS, the same reason src/server/status.js mirrors it) and
// keeps only its head and tail. Recording never breaks a turn: writes are
// batched off the tool path, failures are counted and surface as a `gap`
// event in the log itself once writing works again (and in `muser log`).
// Retention (design §12, the proposed defaults, confirmed 2026-11-07):
// 30 days or 500 MB total, oldest first; a blob (an edit's before-text) is
// deleted once no remaining record references it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./secure-store');
const {t} = require('./i18n');

const WORKLOG_DIR = path.join(store.DIR, 'worklog');
const BLOBS_DIR = path.join(WORKLOG_DIR, 'blobs');
const RETENTION_DAYS = 30;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const REQUEST_CHARS = 2000; // a turn event keeps the head of the request
const OUTPUT_EDGE_CHARS = 2000; // a tool event keeps the head AND tail of its output, each at most this long
const DIFF_MAX_CHARS = 20 * 1024; // an edit event's diff text cap
const REPLY_MAX_CHARS = 20 * 1024; // a reply event keeps the head of the reply (wave 15: replies were the one uncapped text left)
const BLOB_MAX_CHARS = 1024 * 1024; // a blob keeps the head of an edit's before-text (wave 15: before-images were uncapped too)
const FLUSH_DELAY_MS = 200; // appends are batched off the tool path
const PRUNE_INTERVAL_MS = 60 * 1000; // drain-triggered retention sweeps are thinned to at most this cadence per instance (wave 18, see pruneIfDue)
const PRUNE_GROWTH_BYTES = 1024 * 1024; // ... plus an early sweep once an instance has itself drained this much new output since the last one

// A session id becomes a file name. The encoding is reversible: safe
// chars ([A-Za-z0-9-], which covers every real session id, so existing
// logs keep their names) pass through, '_' doubles, and any other char
// becomes _xHHHH (its UTF-16 code unit in hex). The old strip-everything
// naming made 'a.b', 'a_b' and 'ab' the same file, mixing two
// conversations into one log (features-debug #3). The encoded form never
// contains a path separator or a dot, so an id cannot walk out of the
// worklog folder either.
function encodeId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9-]/g, c => c === '_' ? '__' : '_x' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function decodeId(name) {
  return String(name).replace(/_x([0-9a-fA-F]{4})|__/g, (m, hex) => hex ? String.fromCharCode(parseInt(hex, 16)) : '_');
}
function fileFor(sessionId, dir = WORKLOG_DIR) {
  return path.join(dir, encodeId(sessionId) + '.jsonl');
}
// The pre-encoding naming (the strip-everything scheme encodeId replaced):
// 'a.b' and 'ab' shared 'ab.jsonl'. Reads fall back to it — the same rule
// src/sessions.js transcriptReadFile uses for transcripts — so a log an
// older build wrote under the stripped name stays readable for its own
// conversation: the encoded file wins whenever it exists, the legacy file
// is read only while no encoded file does, and writes never use it again
// (once an encoded file exists, the legacy name, which a colliding id may
// also claim, is never read for this id again).
function legacyName(sessionId) { return String(sessionId).replace(/[^A-Za-z0-9-]/g, ''); }
function legacyFileFor(sessionId, dir = WORKLOG_DIR) {
  return path.join(dir, legacyName(sessionId) + '.jsonl');
}
function readFileFor(sessionId, dir = WORKLOG_DIR) {
  const file = fileFor(sessionId, dir), legacy = legacyFileFor(sessionId, dir);
  if (legacy === file) return file;
  try { if (fs.existsSync(file)) return file; } catch {}
  try { if (fs.existsSync(legacy)) return legacy; } catch {}
  return file;
}
// The counts a read had to skip ride the returned array as non-enumerable
// properties (badLines / foreignLines, with `foreign` as an alias for the
// latter): enumerable extras would change what deepEqual / JSON.stringify
// make of the entries list every existing reader compares and prints.
function attachReadCounts(events, badLines, foreignLines) {
  try {
    Object.defineProperties(events, {
      badLines: {value: badLines, writable: true},
      foreignLines: {value: foreignLines, writable: true},
      foreign: {value: foreignLines, writable: true},
    });
  } catch { /* the entries themselves still read fine */ }
  return events;
}
function blobFile(hash, dir = WORKLOG_DIR) { return path.join(dir, 'blobs', String(hash)); }
function sha256(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }
// A blob lands whole or not at all: write to a unique temp next to the
// target and rename it over, the way the other stores write (secure-store's
// renameRetry rides out a momentary Windows lock). A direct writeFileSync
// to the blob's own name could be torn by a crash mid-write, leaving
// truncated text under a good hash with no way to tell it from a blob
// that was sanitised or capped on purpose.
function writeBlobAtomic(file, text) {
  const temp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  try { fs.writeFileSync(temp, text); store.renameRetry(temp, file); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
// A log's retention age is the `at` of its newest content — its last
// non-empty line (wave 17) — not its mtime: a copy or restore can give
// 60-day-old content a fresh mtime (so it lived forever), and a backup
// tool resetting mtimes got fresh content deleted. When the last line
// cannot be read or parsed, or carries no usable `at`, the mtime is the
// fallback, exactly as before.
function contentAgeMs(file, fallbackMs) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return fallbackMs; /* unreadable: fall back */ }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return fallbackMs;
    // Only the tail is read (wave 18): the newest content is the LAST
    // non-empty line, so reading the whole file just to find it made the
    // retention sweep cost grow with every log it kept. The window grows
    // until it provably holds that line complete (or the whole file), so
    // the result — including every fallback below — is the one the full
    // read gave.
    let window = 8192;
    for (;;) {
      const len = Math.min(window, size);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) { const n = fs.readSync(fd, buf, off, len - off, size - len + off); if (!n) break; off += n; }
      const lines = buf.subarray(0, off).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        if (i === 0 && len < size) break; // the last line starts before the window: grow it and read again
        try {
          const at = Date.parse(JSON.parse(lines[i])?.at);
          return Number.isFinite(at) ? at : fallbackMs;
        } catch { return fallbackMs; }
      }
      if (len >= size) return fallbackMs;
      window *= 4;
    }
  } catch { return fallbackMs; } finally { try { fs.closeSync(fd); } catch {} }
}

// --- sanitising: what may never reach the log ---
// Secret-shaped values in text (mirrors src/focus-log.js, which guards the
// Focus decision log the same way).
// Bounded and run-anchored on purpose (wave 13): the unbounded form was
// quadratic on a long separator-free string — the [A-Za-z0-9_-]* on both
// sides of the keyword backtracks over every split of the key run at
// every starting position (50K plain letters took ~5 s in sanitizeText;
// a 1 MB single token froze the event loop for minutes, Esc included).
// A key now matches only at the START of a key-character run (the
// boundary character is captured and re-emitted) and each side of the
// keyword is capped at 64 chars — far longer than a real key name — so
// a run of any length costs bounded work. A "key" whose keyword sits
// deeper than that inside a longer identifier is no longer recognised;
// that is the same trade src/export.js's bounded email rule (wave 12)
// already makes.
const SECRET_VALUE = /(^|[^A-Za-z0-9_-])(authorization\s*:|[A-Za-z0-9_-]{0,64}(?:api[-_]?key|token|password|passwd|secret|cookie|credential)[A-Za-z0-9_-]{0,64})(\s*[:=]\s*)([^\s,;}"]+)/gi;
const AUTH_VALUE = /(authorization\s*:\s*)(?:bearer\s+|basic\s+)?([^\s,;}"]+)/gi;
// Secret SHAPES, wherever they appear (the same set src/export.js redacts
// for the report path): a known token prefix or a JWT needs no label, and
// a quoted JSON value under a secret-shaped key is a secret even though
// the key=value patterns above cannot see past the quotes.
const SECRET_SHAPE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// The quoted key's two [^"]* around the keyword are capped at 64 for the
// same reason (wave 13): a long quoted string full of keyword-shaped
// fragments partitioned between them quadratically. A real JSON key is
// far shorter than the cap.
const SECRET_JSON = /("(?:[^"]{0,64}(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|session|cookie|authorization|credential)[^"]{0,64})"\s*:\s*")[^"]*(")/gi;
// A bare label followed by a value (`token abc…`): the value is redacted
// only when it looks like a secret (long, or longish with a digit), so
// prose like "token counts" is left alone.
const SECRET_BARE = /\b(token|password|passwd|secret|api[-_]?key|bearer)\s+([^\s,;}"']+)/gi;
const bareValue = (m, k, v) => (v.length >= 12 || (v.length >= 8 && /\d/.test(v))) ? k + ' [redacted]' : m;
const SECRET_KEY = /(token|password|passwd|secret|cookie|authorization|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|bearer)/i;
// Terminal escapes and stray controls (mirrors src/ui/sanitize.mjs): a raw
// ESC in recorded output would be executed by the terminal when the log is
// printed back, so the log goes through the screen's own sanitising first.
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-Z\\-_])/g;
const CTRL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// A blob is a file's before-image, restored byte-for-byte by the counter-
// proof and compared by lore's grave check: its line endings are content,
// so the blob variant of the control strip keeps \r (\x0d).
const CTRL_CHARS_BLOB = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function sanitizeWith(text, ctrl) {
  return String(text ?? '').replace(ESC_SEQ, '').replace(ctrl, '').replace(AUTH_VALUE, '$1[redacted]').replace(SECRET_VALUE, '$1$2$3[redacted]').replace(SECRET_JSON, '$1[redacted]$2').replace(SECRET_SHAPE, '[redacted]').replace(SECRET_BARE, bareValue);
}
function sanitizeText(text) { return sanitizeWith(text, CTRL_CHARS); }
function sanitizeBlobText(text) { return sanitizeWith(text, CTRL_CHARS_BLOB); }
// A structured value (a Focus state): secret-shaped keys and values are
// redacted at any depth; strings keep up to 20,000 chars so the copy stays
// faithful (the design asks for the Focus evidence as it stands) without
// letting one field swallow the file.
function sanitizeDeep(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') { const s = sanitizeText(value); return s.length <= 20000 ? s : s.slice(0, 20000) + '… (' + s.length + ' chars)'; }
  if (Array.isArray(value)) return depth > 6 ? '[...]' : value.map(v => sanitizeDeep(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 6) return '{...}';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeDeep(v, depth + 1);
    return out;
  }
  return value;
}
function isSensitive(p) {
  try { return require('./tools').isSensitivePath(p); } catch { return false; }
}

// Cut edges must not split a surrogate pair (wave 17, the rule
// src/handoff.js's safeCut applies, implemented locally): a head cut
// backs off a trailing high surrogate, a tail cut skips a leading low
// surrogate, so a kept head/tail never starts or ends with a lone
// surrogate.
function cutHead(s, n) {
  if (s.length <= n) return s;
  if (n <= 0) return '';
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}
function cutTail(s, n) {
  if (s.length <= n) return s;
  let start = s.length - n;
  const c = s.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start++;
  return s.slice(start);
}

// Output as it may be kept: sanitised, head and tail only, with the whole
// output's length and hash so a later feature can still verify it.
function headTail(text, edge = OUTPUT_EDGE_CHARS) {
  const s = sanitizeText(text);
  const out = {chars: s.length, hash: sha256(s)};
  if (s.length <= edge * 2) out.head = s;
  else { out.head = cutHead(s, edge); out.tail = cutTail(s, edge); }
  return out;
}

// Changed line ranges from a tools.js lineDiff: contiguous runs of + / -
// lines, numbered as the diff numbers them (after-file for +, before-file
// for -; a run of both keeps the span it spans).
function diffRanges(diff) {
  const ranges = [];
  let run = null;
  for (const d of diff || []) {
    if (d.t !== '+' && d.t !== '-') { run = null; continue; }
    if (!Number.isFinite(d.n)) { run = null; continue; }
    if (run && d.n <= run.end + 1) run.end = Math.max(run.end, d.n);
    else { run = {start: d.n, end: d.n}; ranges.push(run); }
  }
  return ranges;
}
function diffTextOf(diff) {
  const s = sanitizeText((diff || []).map(d => d.t === '…' ? '…' : d.t + (d.l ?? '')).join('\n'));
  return s.length <= DIFF_MAX_CHARS ? s : s.slice(0, DIFF_MAX_CHARS) + '\n… (diff cut at ' + DIFF_MAX_CHARS + ' chars)';
}

// A capped text (wave 15): over the cap, the head is kept and the cut is
// visible in the text itself — a trailing '…', the same mark the expect
// side's clipping uses — so a reader can tell a cut record from a whole
// one instead of mistaking the head for the full text.
function cutText(text, cap) {
  const s = String(text ?? '');
  return s.length <= cap ? s : cutHead(s, cap) + '…';
}

// --- event builders (pure; the class below adds at/session) ---
function makeTurn({text, agent, parentAgent, parentSession} = {}) {
  return {event: 'turn', agent: String(agent || 'main'), ...(parentAgent ? {parentAgent: String(parentAgent)} : {}), ...(parentSession ? {parentSession: String(parentSession)} : {}), text: sanitizeText(text).slice(0, REQUEST_CHARS)};
}
function makeTool({command, summary, paths, ok, error, exitCode, ms, output, sensitive} = {}) {
  const e = {event: 'tool', command: String(command || ''), summary: sanitizeText(summary).slice(0, 200), ok: !!ok};
  const list = (paths || []).filter(p => typeof p === 'string' && p);
  if (list.length) e.paths = list.slice(0, 20).map(p => sanitizeText(p));
  if (!ok && error) e.error = sanitizeText(error).slice(0, 300);
  if (Number.isFinite(exitCode)) e.exitCode = exitCode;
  if (Number.isFinite(ms)) e.ms = Math.max(0, Math.round(ms));
  // The output of a call that touched a sensitive path is never kept — not
  // even its head; the length and hash still say it happened and how big it was.
  const ht = headTail(output ?? '');
  e.outChars = ht.chars; e.outHash = ht.hash;
  if (!sensitive) { if (ht.head !== undefined) e.outHead = ht.head; if (ht.tail !== undefined) e.outTail = ht.tail; }
  else e.outWithheld = 'sensitive path';
  return e;
}
// One file's edit. before/after are the full texts the write tool already
// held; the before-text itself goes to blobs (by hash), never into the line.
function makeEdit({file, op, before, after, diff} = {}) {
  const e = {event: 'edit', path: String(file || ''), op: String(op || 'edit')};
  if (isSensitive(e.path)) { e.withheld = 'sensitive path'; return e; }
  const b = String(before ?? ''), a = String(after ?? '');
  e.beforeHash = sha256(b); e.afterHash = sha256(a);
  // The write tools' edit records carry only the before/after texts, no
  // diff: derive it here, with the same lineDiff the approval preview
  // uses, or the event would land with empty ranges and zero counts and
  // every reader downstream (lore's anchors, crash's function names,
  // proof's badges) would see an edit that changed nothing.
  let d = diff;
  if (!d) { try { d = require('./tools').lineDiff(b, a); } catch { d = null; } }
  e.added = (d || []).filter(x => x.t === '+').length;
  e.removed = (d || []).filter(x => x.t === '-').length;
  e.ranges = diffRanges(d);
  e.diff = diffTextOf(d);
  return e;
}
function makeReply({text, agent, error} = {}) {
  // The reply text is capped like every other kept text (wave 15): a
  // turn's request keeps 2,000 chars and a diff 20,000, but a reply —
  // the longest text a turn produces — kept everything, so one huge
  // reply could outweigh the rest of the log. The cut shows as '…'.
  return {event: 'reply', agent: String(agent || 'main'), text: cutText(sanitizeText(text), REPLY_MAX_CHARS), ...(error ? {error: sanitizeText(error).slice(0, 300)} : {})};
}
function makeFocus({focus} = {}) { return {event: 'focus', focus: sanitizeDeep(focus)}; }
function makeGap({dropped, error} = {}) { return {event: 'gap', dropped: dropped | 0, error: sanitizeText(error).slice(0, 300)}; }

// Every live instance, so a shutdown path can write out ALL queued lines
// at once (flushAllWorklogs below): an Agent holds one Worklog per
// conversation, and a queue is otherwise lost when the process ends
// inside the batch window (FLUSH_DELAY_MS).
const live = new Set();

class Worklog {
  constructor({sessionId, dir = WORKLOG_DIR, enabled = true, enabledFn = null, retentionDays = RETENTION_DAYS, maxTotalBytes = MAX_TOTAL_BYTES} = {}) {
    this.sessionId = String(sessionId || '');
    this.dir = dir;
    this.enabled = enabled;
    this.enabledFn = enabledFn; // read live when set: a /settings change applies at once
    this.retentionDays = retentionDays;
    this.maxTotalBytes = maxTotalBytes;
    this.queue = []; // JSON lines waiting for the batched write
    this.blobs = new Map(); // hash -> before-text waiting to be stored
    this.timer = null;
    this.failures = 0; // lines that could not be written
    this.lastError = '';
    this.pruned = false;
    this.lastPruneAt = 0; // when this instance last ran the retention sweep (wave 18 thinning, see pruneIfDue)
    this.drainedBytes = 0; // bytes this instance has drained since that sweep
    live.add(this);
  }
  enabledNow() {
    try { return this.enabledFn ? !!this.enabledFn() : !!this.enabled; } catch { return true; }
  }
  file() { return fileFor(this.sessionId, this.dir); }
  append(fields) {
    if (!this.sessionId || !fields || !this.enabledNow()) return null;
    const entry = {v: 1, at: new Date().toISOString(), session: this.sessionId, ...fields};
    let line;
    try { line = JSON.stringify(entry); } catch { return null; }
    this.queue.push(line);
    this.schedule();
    return entry;
  }
  turn(f) { return this.append(makeTurn(f)); }
  tool(f) { return this.append(makeTool(f)); }
  reply(f) { return this.append(makeReply(f)); }
  focus(f) { return this.append(makeFocus(f)); }
  // An edit also stores its before-text as a blob (once per content hash).
  edit(f) {
    const e = makeEdit(f);
    // The blob is sanitised like everything else: a token written in an
    // ordinary-named file must not reach a record either (common rule §0).
    // Where that changed the text, the blob differs from the original — the
    // hash above still names the original content.
    // The stored text is also capped (wave 15): a before-image of a huge
    // file no longer lands whole just because one edit touched it. The
    // cut is visible in the blob itself (a trailing '…', see cutText),
    // and the blob then no longer hashes to the beforeHash that names
    // it — a reader comparing the two can tell it was cut, and the
    // counter-proof restores only the kept head of such a file.
    if (!e.withheld && f && typeof f.before === 'string' && f.before) this.blobs.set(e.beforeHash, cutText(sanitizeBlobText(f.before), BLOB_MAX_CHARS));
    return this.append(e);
  }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.drain(); }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }
  // The batched write itself. Synchronous inside the timer so the batch is
  // one append; the tool path only ever queued a string. Returns the number
  // of lines written.
  drain() {
    if (!this.queue.length && !this.blobs.size) return 0;
    const lines = this.queue.splice(0), blobs = [...this.blobs.entries()];
    this.blobs.clear();
    let drainedBytes = 0; // this batch's written bytes, for the sweep gate below
    try {
      fs.mkdirSync(path.join(this.dir, 'blobs'), {recursive: true});
      for (const [hash, text] of blobs) {
        const f = blobFile(hash, this.dir);
        // An existing blob is compared with the text this drain is about
        // to store, never hash-verified: the stored text is the sanitised
        // (and capped) form, kept under the ORIGINAL text's hash, so it
        // legitimately does not hash to its name. When the stored content
        // already equals what would be written — the normal case, and
        // always the case for a sanitised blob recorded again — it is
        // left untouched. When it differs, the atomic rewrite heals a
        // legacy torn blob at the next record of the same edit.
        let stored;
        try { stored = fs.readFileSync(f, 'utf8'); } catch { /* missing or unreadable: write it below */ }
        if (stored !== text) { writeBlobAtomic(f, text); drainedBytes += Buffer.byteLength(text); }
        // An already-stored blob this drain is about to reference again gets
        // its mtime refreshed (wave 18): prune's pending-writer guard keys
        // on a blob being newer than every log, and a re-reference must look
        // as pending as a first write — otherwise another window's sweep
        // could collect the old blob in the gap before this drain's line
        // lands. Best-effort: a failed touch only loses that protection.
        else { try { const tn = new Date(); fs.utimesSync(f, tn, tn); } catch {} }
      }
      const gap = this.failures ? JSON.stringify({v: 1, at: new Date().toISOString(), session: this.sessionId, ...makeGap({dropped: this.failures, error: this.lastError})}) : null;
      const payload = (gap ? [gap, ...lines] : lines).join('\n') + '\n';
      fs.appendFileSync(this.file(), payload);
      drainedBytes += Buffer.byteLength(payload);
      const written = lines.length;
      this.failures = 0; this.lastError = '';
      // Retention is drain-triggered (wave 15): the first-write-only sweep
      // let a long-lived session outlive the age limit entirely — its
      // folder's old logs were collected only when some NEW session
      // happened to start, so on a one-conversation machine the 30-day rule
      // in practice never fired after day one. Since wave 18 the sweep is
      // THINNED, not dropped (see pruneIfDue): a full sweep re-reads every
      // log and blob, which cost ~135 ms on every single drain at 24 MB —
      // seconds at the 500 MB cap — even for a one-line batch.
      this.drainedBytes += drainedBytes;
      this.pruneIfDue();
      return written;
    } catch (e) {
      this.failures += lines.length;
      this.lastError = String(e?.message || e);
      // Blobs whose lines were lost are dropped too: an unreferenced blob is
      // garbage the next prune would collect anyway.
      return 0;
    }
  }
  flush() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } return this.drain(); }
  // Retention: files older than retentionDays go first, then (while the
  // whole folder is over maxTotalBytes) the oldest files. A file's age
  // is its newest content's `at`, not its mtime (wave 17, contentAgeMs).
  // The age pass
  // never deletes this session's own file — a live conversation must not
  // lose the log it is still writing — but the size pass treats it like
  // any other (wave 15): the old blanket exemption meant a folder whose
  // bulk was the current session's own log could never get back under
  // the cap at all. Blobs no remaining record references are deleted last.
  // The drain-time gate for the retention sweep (wave 18). prune() reads
  // every surviving log end to end (content ages + blob references) and
  // stats every blob, so running it on EVERY drain made each batched write
  // pay a full-folder scan: ~135 ms per drain at 24 MB, seconds at the
  // 500 MB cap, for a one-line drain as much as for a thousand-line one.
  // The sweep's rules are unchanged — only its cadence from the write path
  // is thinned. An instance's FIRST drain still sweeps in full (a new
  // session collects what its predecessors left, the wave-15 point), and
  // a direct prune() call always sweeps in full; later drains sweep at
  // most once per PRUNE_INTERVAL_MS, plus early once this instance itself
  // has drained PRUNE_GROWTH_BYTES of new lines and blobs since the last
  // sweep, so a fast-growing folder cannot outrun the size cap for long
  // and the age rule fires within a minute of its deadline at the latest.
  pruneIfDue(now = Date.now()) {
    if (!this.pruned) { this.prune(now); return; }
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) { this.prune(now); return; }
    if (this.drainedBytes >= PRUNE_GROWTH_BYTES) { this.prune(now); return; }
  }
  prune(now = Date.now()) {
    this.pruned = true;
    this.lastPruneAt = now;
    this.drainedBytes = 0;
    try {
      // Per file (wave-9): one entry whose stat fails (a broken symlink) or that
      // is not a file must not abort the whole sweep — the old map threw, the
      // outer catch swallowed it, and retention silently never ran again.
      const files = [];
      let unreadableLog = false; // a *.jsonl entry that cannot be read as a file (broken link, a folder wearing the name): its blob references are unknowable, which the GC below must not read as "references nothing"
      // A snapshot of the folder as this sweep first saw it (wave 18): the
      // blob GC at the end compares the folder against it, because another
      // window's drain writes a blob FIRST and appends the referencing line
      // only afterwards — a sweep that reads the references while that
      // append is still pending sees a live blob as unreferenced and used
      // to delete it (and in-flight `.tmp-` writes with it, failing the
      // other window's rename). Any change since the snapshot — a log
      // appended to, created or removed by someone else, a blob landed or
      // renamed — means the reference set may already be stale, so the GC
      // stands down this round exactly as it does on an incomplete read.
      const logSnap = new Map(); // name -> "size|mtimeMs", or a marker when the entry could not be stat'ed as a file
      const deletedLogs = new Set(); // names THIS sweep deletes: their disappearance is not an outside change
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(this.dir, f);
        try { const s = fs.statSync(p); if (s.isFile()) { files.push({p, size: s.size, mtimeMs: s.mtimeMs, ageMs: contentAgeMs(p, s.mtimeMs)}); logSnap.set(f, s.size + '|' + s.mtimeMs); } else { unreadableLog = true; logSnap.set(f, 'NONFILE'); } } catch { unreadableLog = true; logSnap.set(f, 'ERR'); /* skip this entry only */ }
      }
      // The newest log mtime at snapshot time, for the GC's pending-writer
      // guard below: a blob NEWER than every log in the folder may belong
      // to a drain whose referencing append has not landed yet (the writer
      // may even be paused mid-drain, with the folder perfectly stable), so
      // it is never collected this round. A blob older than the newest log
      // has outlived at least one completed append since it landed — the
      // normal orphan case — and collects as before.
      let newestLogMtimeMs = -Infinity;
      for (const x of files) if (x.mtimeMs > newestLogMtimeMs) newestLogMtimeMs = x.mtimeMs;
      // Oldest first by content age (wave 17, see contentAgeMs): this
      // order drives both the age pass below and the size pass's victim
      // choice, so both judge a log by what it holds, not its mtime.
      files.sort((a, b) => a.ageMs - b.ageMs);
      const cutoff = now - Math.max(1, this.retentionDays) * 24 * 3600 * 1000;
      const kept = [];
      for (const x of files) {
        if (x.p !== this.file() && x.ageMs < cutoff) { try { fs.unlinkSync(x.p); deletedLogs.add(path.basename(x.p)); } catch {} continue; }
        kept.push(x);
      }
      const blobDir = path.join(this.dir, 'blobs');
      let blobNames = [];
      const blobSizes = new Map();
      const blobSnap = new Map(); // name -> "size|mtimeMs", or 'ERR' (see logSnap above)
      const blobMtimes = new Map(); // name -> mtimeMs, for the pending-writer guard
      try { blobNames = fs.readdirSync(blobDir); for (const n of blobNames) { try { const bs = fs.statSync(path.join(blobDir, n)); blobSizes.set(n, bs.size); blobSnap.set(n, bs.size + '|' + bs.mtimeMs); blobMtimes.set(n, bs.mtimeMs); } catch { blobSnap.set(n, 'ERR'); /* one bad blob must not empty the size map */ } } } catch {}
      // References are computed ONCE, here (wave 17) — after the age
      // pass, before any size deletion — as a per-file set plus a count
      // of how many surviving logs reference each hash, and that one
      // computation is reused by both the size total and the blob GC
      // below. The old size loop re-ran a full referenced-set scan over
      // every surviving log for each file it deleted, which made the
      // pass quadratic in the number of logs; here a deletion only
      // decrements the victim's own counts.
      // `complete` is false when any source log could not be read (wave-9): an
      // unreadable log is NOT a log that references nothing — treating its read
      // failure as "no references" deleted blobs a surviving log still pointed
      // at. Callers that delete based on the set must check completeness.
      const refsOf = new Map(); // kept entry -> the blob hashes its lines name
      let complete = true;
      for (const x of kept) {
        const ref = new Set();
        let text = '';
        try { text = fs.readFileSync(x.p, 'utf8'); } catch { complete = false; refsOf.set(x, ref); continue; }
        for (const m of text.matchAll(/"beforeHash":"([0-9a-f]{64})"/g)) ref.add(m[1]);
        refsOf.set(x, ref);
      }
      const refCount = new Map(); // hash -> how many surviving logs reference it
      for (const x of kept) for (const n of refsOf.get(x)) refCount.set(n, (refCount.get(n) || 0) + 1);
      const referenced = new Set(refCount.keys());
      // The size pass counts only the blobs the SURVIVING files still
      // reference: deleting a conversation frees its blobs too. The old
      // count charged every blob forever, so with a large blob store the
      // loop deleted conversation after conversation without the total
      // ever dropping (features-debug #4).
      for (;;) {
        const alive = kept.filter(x => !x.gone);
        let total = alive.reduce((n, x) => n + x.size, 0);
        for (const n of referenced) total += blobSizes.get(n) || 0;
        if (total <= this.maxTotalBytes) break;
        // Oldest first, this session's own file included (wave 15, see
        // the note above): it is simply the last to go when it is the
        // newest, and no longer exempt when it is the oldest.
        const victim = alive[0];
        if (!victim) break;
        try { fs.unlinkSync(victim.p); deletedLogs.add(path.basename(victim.p)); } catch {}
        victim.gone = true;
        // The victim's blobs are freed exactly when their last surviving
        // referrer goes (the semantics the per-deletion rescan had).
        for (const n of refsOf.get(victim) || []) {
          const c = (refCount.get(n) || 0) - 1;
          if (c <= 0) { refCount.delete(n); referenced.delete(n); } else refCount.set(n, c);
        }
      }
      // The GC itself runs only on a complete read (see the note above): if any
      // surviving log could not be read this time, no blob is deleted at all —
      // the next prune, with the log readable again, collects what is truly
      // unreferenced then.
      // It also runs only on a STABLE folder (wave 18, see the snapshot note
      // at the top): if any log or blob changed while this sweep was reading
      // — another window mid-drain — the reference set is already stale, so
      // no blob is deleted at all this round; the next prune, on a settled
      // folder, collects what is truly unreferenced then. And even on a
      // stable folder, a blob newer than every log (or one whose mtime
      // could not be read) is left alone: its referencing line may be a
      // pending append from a writer paused mid-drain (the pending-writer
      // guard at the top). An in-flight `.tmp-` write is covered by both
      // rules — it appears/disappears between the snapshots, and while it
      // sits there it is newer than every log — so a sweep can no longer
      // delete the temp from under another window's rename.
      if (complete && !unreadableLog) {
        let stable = true;
        try {
          const nowLogs = new Map();
          for (const f of fs.readdirSync(this.dir)) {
            if (!f.endsWith('.jsonl')) continue;
            try { const s = fs.statSync(path.join(this.dir, f)); nowLogs.set(f, s.isFile() ? s.size + '|' + s.mtimeMs : 'NONFILE'); } catch { nowLogs.set(f, 'ERR'); }
          }
          // The expected end state is the snapshot minus this sweep's own
          // deletions; anything else — an append, a new log, a deleted log
          // recreated by its writer — means the ground moved under the sweep.
          const expectedLogs = new Map(logSnap);
          for (const name of deletedLogs) expectedLogs.delete(name);
          if (nowLogs.size !== expectedLogs.size) stable = false;
          else for (const [name, sig] of expectedLogs) if (nowLogs.get(name) !== sig) { stable = false; break; }
          if (stable) {
            const nowBlobs = new Map();
            for (const n of fs.readdirSync(blobDir)) { try { const bs = fs.statSync(path.join(blobDir, n)); nowBlobs.set(n, bs.size + '|' + bs.mtimeMs); } catch { nowBlobs.set(n, 'ERR'); } }
            if (nowBlobs.size !== blobSnap.size) stable = false;
            else for (const [name, sig] of blobSnap) if (nowBlobs.get(name) !== sig) { stable = false; break; }
          }
        } catch { stable = false; /* a folder that cannot be re-read is not proven stable */ }
        if (stable) for (const n of blobNames) {
          if (referenced.has(n)) continue;
          const mt = blobMtimes.get(n);
          if (mt === undefined || mt > newestLogMtimeMs) continue; // pending-writer guard (see above)
          try { fs.unlinkSync(path.join(blobDir, n)); } catch {}
        }
      }
    } catch { /* retention never breaks the task */ }
  }
  // One file's entries. A line counts as an entry only when it parses as a
  // JSON object: a torn / unparseable line AND a line that is valid JSON
  // but a scalar or an array (12345, "just a string", [..]) are both
  // broken lines — skipped, and counted on the result as `badLines` (the
  // old reader kept scalars as entries, inflating every count built on
  // the list, and dropped broken lines without a trace). A parsed object
  // whose `session` names a DIFFERENT conversation than the one being
  // read is foreign matter in this file (a legacy shared file, a hand
  // copy, a writer bug): it is never mixed into this conversation's
  // entries — it is skipped and counted as `foreignLines` (alias
  // `foreign`). The conversation being read is, in order: the explicit
  // `expected` (a session id string, or {sessionId}), else the id the
  // file's own name decodes to. Two tolerances keep that rule from eating
  // whole logs: a line with no `session` at all (older spellings, hand
  // fixtures) cannot be judged foreign and is kept, and a file whose
  // lines ALL name one other session is that session's log under a
  // renamed / legacy-shared name (the transcript side reads its legacy
  // file the same way), not a mix — the foreign rule bites only when the
  // file also contains the conversation's own lines to mix into.
  // When the encoded file does not exist, the legacy stripped-name file
  // is read instead (see readFileFor); its lines are still judged against
  // the requested / named conversation, not against the legacy file name.
  static readFile(file, expected) {
    const events = [];
    let badLines = 0, foreignLines = 0;
    const wanted = expected != null && typeof expected === 'object' ? expected.sessionId ?? expected.session ?? expected.id : expected;
    let expectId = wanted != null && wanted !== '' ? String(wanted) : null;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    if (text === null) {
      // Legacy fallback for a caller that named the encoded file directly
      // (fileFor): decode the name back to its conversation and try the
      // stripped-name sibling before giving up as missing.
      try {
        const stem = path.basename(String(file)).replace(/\.jsonl$/, '');
        const decoded = decodeId(stem), legacyStem = legacyName(decoded);
        if (legacyStem && legacyStem !== stem) {
          text = fs.readFileSync(path.join(path.dirname(String(file)), legacyStem + '.jsonl'), 'utf8');
          if (expectId === null) expectId = decoded;
        }
      } catch { text = null; }
    }
    if (text === null) return attachReadCounts(events, 0, 0);
    if (expectId === null) {
      try { expectId = decodeId(path.basename(String(file)).replace(/\.jsonl$/, '')); } catch { expectId = null; }
    }
    const parsedLines = [];
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { badLines++; continue; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { badLines++; continue; }
      parsedLines.push(parsed);
    }
    // Foreign filtering (see the note above): only when this conversation
    // has lines of its own in the file are other sessions' lines foreign.
    const hasOwn = expectId != null && parsedLines.some(p => p.session != null && String(p.session) === expectId);
    for (const parsed of parsedLines) {
      if (hasOwn && parsed.session != null && String(parsed.session) !== expectId) { foreignLines++; continue; }
      events.push(parsed);
    }
    return attachReadCounts(events, badLines, foreignLines);
  }
  static read(sessionId, dir = WORKLOG_DIR) { return Worklog.readFile(readFileFor(sessionId, dir), String(sessionId)); }
  static readBlob(hash, dir = WORKLOG_DIR) {
    // The stored text is returned as it stands. A blob's content is NOT
    // expected to hash to its name: blobs keep the SANITISED (and capped)
    // before-text under the hash of the ORIGINAL text (see edit()), so a
    // hash check here would report every redacted or cut blob as missing
    // and counter-proof could never restore it.
    try { return fs.readFileSync(blobFile(hash, dir), 'utf8'); } catch { return null; }
  }
  // One row per conversation that has a work log, newest first.
  static list(dir = WORKLOG_DIR) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    const rows = [];
    for (const name of names) {
      const p = path.join(dir, name);
      let s;
      try { s = fs.statSync(p); } catch { continue; }
      const entries = Worklog.readFile(p);
      const firstTurn = entries.find(e => e.event === 'turn');
      rows.push({
        id: decodeId(name.replace(/\.jsonl$/, '')), file: p, size: s.size, updated: s.mtimeMs,
        events: entries.length,
        badLines: entries.badLines || 0,
        foreignLines: entries.foreignLines || 0,
        foreign: entries.foreignLines || 0,
        turns: entries.filter(e => e.event === 'turn').length,
        tools: entries.filter(e => e.event === 'tool').length,
        edits: entries.filter(e => e.event === 'edit').length,
        gaps: entries.filter(e => e.event === 'gap').reduce((n, e) => n + (e.dropped | 0), 0),
        firstAt: entries[0]?.at || null, lastAt: entries[entries.length - 1]?.at || null,
        title: firstTurn ? String(firstTurn.text || '').split('\n')[0].slice(0, 80) : '',
      });
    }
    return rows.sort((a, b) => b.updated - a.updated);
  }
  static clear(dir = WORKLOG_DIR) {
    let files = 0, blobs = 0, bytes = 0;
    try {
      for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
        const p = path.join(dir, name);
        try { bytes += fs.statSync(p).size; fs.unlinkSync(p); files++; } catch {}
      }
    } catch {}
    try {
      const blobDir = path.join(dir, 'blobs');
      for (const name of fs.readdirSync(blobDir)) {
        const p = path.join(blobDir, name);
        try { bytes += fs.statSync(p).size; fs.unlinkSync(p); blobs++; } catch {}
      }
    } catch {}
    return {files, blobs, bytes};
  }
  // One readable line per entry: time, kind, then the detail that identifies it.
  static format(entries) {
    const head = (s, n = 120) => String(s ?? '').split('\n')[0].slice(0, n);
    return entries.map(e => {
      const at = e.at || '';
      if (e.event === 'turn') return [at, 'turn', e.agent || 'main', head(e.text)].filter(Boolean).join('  ');
      if (e.event === 'tool') return [at, 'tool', e.command || '', e.ok ? 'ok' : 'FAILED', head(e.summary, 80), Number.isFinite(e.ms) ? e.ms + 'ms' : '', Number.isFinite(e.exitCode) ? 'exit ' + e.exitCode : ''].filter(Boolean).join('  ');
      if (e.event === 'edit') return [at, 'edit', e.path || '', e.withheld ? '(' + e.withheld + ')' : '+' + (e.added | 0) + ' -' + (e.removed | 0)].filter(Boolean).join('  ');
      if (e.event === 'reply') return [at, 'reply', e.agent || 'main', head(e.text)].filter(Boolean).join('  ');
      if (e.event === 'expect') return [at, 'expect', e.agent || 'main', e.matched === true ? t('一致') : e.matched === false ? t('想定外') : t('未判定'), head((e.expected || '') + ' → ' + (e.actual || ''), 80)].filter(Boolean).join('  ');
      if (e.event === 'expect-block') return [at, 'expect-block', e.agent || 'main', head((e.expected || '') + ' → ' + (e.actual || ''), 80)].filter(Boolean).join('  ');
      if (e.event === 'expect-reconcile') return [at, 'expect-reconcile', e.agent || 'main', head(e.reason)].filter(Boolean).join('  ');
      if (e.event === 'focus') return [at, 'focus', e.focus?.status || '', head(e.focus?.goal, 80)].filter(Boolean).join('  ');
      if (e.event === 'gap') return [at, 'gap', 'dropped ' + (e.dropped | 0), e.error || ''].filter(Boolean).join('  ');
      return [at, e.event || ''].filter(Boolean).join('  ');
    });
  }
  static formatList(rows) {
    return rows.map(r => [r.id.slice(0, 8), r.lastAt || '', 'turns ' + r.turns, 'events ' + r.events, r.gaps ? 'gaps ' + r.gaps : '', r.title].filter(Boolean).join('  '));
  }
}

// Write out every live instance's queued lines now and return how many
// lines were written. A close path (Agent.close) calls this: appends are
// batched on an unref'd 200 ms timer, so exiting inside that window used
// to drop the tail of every conversation's log. Best-effort per instance:
// recording never breaks shutdown.
function flushAllWorklogs() {
  let written = 0;
  for (const wl of [...live]) { try { written += wl.flush() || 0; } catch { /* one bad log must not stop the rest */ } }
  return written;
}

module.exports = {Worklog, flushAllWorklogs, WORKLOG_DIR, BLOBS_DIR, RETENTION_DAYS, MAX_TOTAL_BYTES, PRUNE_INTERVAL_MS, PRUNE_GROWTH_BYTES, REQUEST_CHARS, OUTPUT_EDGE_CHARS, DIFF_MAX_CHARS, REPLY_MAX_CHARS, BLOB_MAX_CHARS, cutText, fileFor, legacyFileFor, readFileFor, legacyName, encodeId, decodeId, blobFile, sha256, sanitizeText, sanitizeBlobText, sanitizeDeep, headTail, diffRanges, diffTextOf, makeTurn, makeTool, makeEdit, makeReply, makeFocus, makeGap};
