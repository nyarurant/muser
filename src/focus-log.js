'use strict';
// Focus weakness 9 (2026-11-06): a per-conversation decision log, so that
// "why did it stop / why is this met / why did that evidence expire" can be
// traced from a record instead of guessed afterwards. One JSON line per event
// in %LOCALAPPDATA%\muser\logs\<session>.jsonl, with the common fields at,
// session, focus, leg, round, event, decision, why, detail and ref.
//
// The log is local only: nothing here sends anything anywhere (no telemetry).
// Secrets are never recorded — Cookie / token / password / *.enc contents /
// Authorization headers are redacted, and long values keep only their head
// (500 chars) plus their length. Verbosity is off / normal (default) /
// verbose, via /settings; normal keeps decisions and reasons only, verbose
// also keeps tool params and the head of results. Logging never breaks the
// task: every write is best-effort and failures are swallowed.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./secure-store');

const FOCUS_LOG_LEVELS = ['off', 'normal', 'verbose'];
const FOCUS_LOG_MAX_LINES = 2000; // per conversation: older lines are dropped first
const FOCUS_LOG_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // whole logs dir: oldest files go first
const FOCUS_LOG_REVALIDATE_APPENDS = 100; // appends between full trim sweeps (see maybeTrim)
const FOCUS_LOG_HEAD_CHARS = 500; // head kept of a long value, with its length
const FOCUS_LOG_INTENT_CHARS = 200; // head kept of Muse's intent text

const LOGS_DIR = path.join(store.DIR, 'logs');
function logFile(sessionId, dir = LOGS_DIR) {
  return path.join(dir, String(sessionId).replace(/[^A-Za-z0-9-]/g, '') + '.jsonl');
}

// --- sanitising: what may never reach the log ---
// The same set src/worklog.js sanitizeText applies (the two modules mirror
// each other): escapes and stray controls go too, because a recorded line is
// printed back to a terminal. Every free-text field passes sanitizeText —
// detail / params / result strings, and decision / why / intent as well:
// those three used to be stored verbatim (String() / clipping only), so a
// secret that reached a reason or an intent sentence was recorded as-is.
const SECRET_KEY = /(token|password|passwd|secret|cookie|authorization|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|bearer|credential)/i;
// Bounded and run-anchored like src/worklog.js's SECRET_VALUE (wave 13):
// the unbounded stars on both sides of the keyword backtracked
// quadratically over a long separator-free string.
const SECRET_VALUE = /(^|[^A-Za-z0-9_-])(authorization\s*:|[A-Za-z0-9_-]{0,64}(?:api[-_]?key|token|password|passwd|secret|cookie|credential)[A-Za-z0-9_-]{0,64})(\s*[:=]\s*)(["']?)[^\s,;}"']+/gi;
// An Authorization header's value follows the scheme word, so the generic
// pattern above never reaches it: `Authorization: Bearer xyz` kept `xyz`.
// Strip the value after the header name, with or without a scheme.
const AUTH_VALUE = /(authorization\s*:\s*)(?:bearer\s+|basic\s+)?(["']?)[^\s,;}"']+/gi;
// Secret SHAPES, wherever they appear: a known token prefix or a JWT needs
// no label at all.
const SECRET_SHAPE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// A quoted JSON value under a secret-shaped key is a secret even though the
// key=value patterns cannot see past the quotes.
// The quoted key's stars are capped at 64 like src/worklog.js (wave 13).
const SECRET_JSON = /("(?:[^"]{0,64}(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|session|cookie|authorization|credential)[^"]{0,64})"\s*:\s*")[^"]*(")/gi;
// A bare label followed by a value (`token abc…`, `Bearer xyz`): the value
// is redacted only when it looks like a secret (long, or longish with a
// digit), so prose like "token counts" — and the log's own reason names —
// stay readable.
const SECRET_BARE = /\b(token|password|passwd|secret|api[-_]?key|bearer|credential)\s+([^\s,;}"']+)/gi;
const bareValue = (m, k, v) => (v.length >= 12 || (v.length >= 8 && /\d/.test(v))) ? k + ' [redacted]' : m;
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-Z\\-_])/g;
const CTRL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function sanitizeText(text) {
  return String(text ?? '').replace(ESC_SEQ, '').replace(CTRL_CHARS, '').replace(AUTH_VALUE, '$1$2[redacted]').replace(SECRET_VALUE, '$1$2$3$4[redacted]').replace(SECRET_JSON, '$1[redacted]$2').replace(SECRET_SHAPE, '[redacted]').replace(SECRET_BARE, bareValue);
}
function clipText(s) {
  const t = String(s);
  return t.length <= FOCUS_LOG_HEAD_CHARS ? t : t.slice(0, FOCUS_LOG_HEAD_CHARS) + '… (' + t.length + ' chars)';
}
function clipIntent(s) {
  const t = String(s);
  return t.length <= FOCUS_LOG_INTENT_CHARS ? t : t.slice(0, FOCUS_LOG_INTENT_CHARS) + '…';
}
// A value as it may be logged: secret-shaped keys and values are redacted,
// the contents of a *.enc file are never kept (even clipped), everything else
// is clipped to its head plus its length.
function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return clipText(sanitizeText(value));
  if (Array.isArray(value)) return depth > 4 ? '[...]' : value.map(v => sanitizeValue(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 4) return '{...}';
    const paths = Object.entries(value)
      .filter(([k, v]) => /^(path|file|filename)$/i.test(k) && typeof v === 'string')
      .map(([, v]) => v);
    const enc = paths.some(p => /\.enc$/i.test(p.trim()));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue; }
      if (enc && /^(content|text|data|body|output|result)$/i.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

class FocusLog {
  constructor({sessionId, level = 'normal', levelFn = null, dir = LOGS_DIR, maxLines = FOCUS_LOG_MAX_LINES, maxTotalBytes = FOCUS_LOG_MAX_TOTAL_BYTES} = {}) {
    this.sessionId = String(sessionId || '');
    this.level = level;
    this.levelFn = levelFn; // read live when set: a /settings change applies at once
    this.dir = dir;
    this.maxLines = maxLines;
    this.maxTotalBytes = maxTotalBytes;
    // Wave 18: trim() estimates, maintained by maybeTrim()/trim() so the
    // full sweep (read this file, readdir + stat the whole logs dir) runs
    // only when a cap may actually be crossed. null = not measured yet.
    this._ownLines = null;
    this._ownBytes = null;
    this._dirBytes = null;
    this._sinceSweep = 0;
  }
  levelNow() {
    try { const v = this.levelFn ? this.levelFn() : this.level; return FOCUS_LOG_LEVELS.includes(v) ? v : 'normal'; }
    catch { return 'normal'; }
  }
  file() { return logFile(this.sessionId, this.dir); }
  append(event, fields = {}) {
    if (!this.sessionId || this.levelNow() === 'off') return null;
    const entry = {at: new Date().toISOString(), session: this.sessionId};
    if (fields.focus) entry.focus = String(fields.focus);
    if (fields.leg != null) entry.leg = fields.leg;
    if (fields.round != null) entry.round = fields.round;
    entry.event = String(event);
    if (fields.decision) entry.decision = sanitizeText(String(fields.decision));
    if (fields.why) entry.why = sanitizeText(String(fields.why));
    if (fields.detail !== undefined) entry.detail = sanitizeValue(fields.detail);
    if (fields.ref) entry.ref = fields.ref;
    if (fields.intent) entry.intent = clipIntent(sanitizeText(fields.intent));
    // Verbose only: tool params and the head of results. Normal never carries them.
    if (this.levelNow() === 'verbose') {
      if (fields.params !== undefined) entry.params = sanitizeValue(fields.params);
      if (fields.result !== undefined) entry.result = sanitizeValue(fields.result);
    }
    try {
      fs.mkdirSync(this.dir, {recursive: true});
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.file(), line);
      this.maybeTrim(Buffer.byteLength(line));
    } catch { /* logging never breaks the task */ }
    return entry;
  }
  // Wave 18: append() used to run trim()'s full sweep on EVERY event —
  // reading this whole file back and readdir + stat-ing every file in
  // the logs dir — so each event cost O(file lines + dir files) and a
  // long session degraded quadratically (measured: own file pinned at
  // 1900 lines, 200 files in the dir, ~6.5 ms of sweep per append).
  // The caps' meaning is unchanged; the sweep now runs only when the
  // tracked estimates say a cap may be crossed: the line count and the
  // dir total are exact for this instance's own writes, one stat of
  // this file per append catches another writer touching it (a size
  // that is not estimate + the line just written invalidates the
  // estimates), and a full sweep still runs at least every
  // FOCUS_LOG_REVALIDATE_APPENDS appends to bound drift from other
  // sessions writing their own files into the same dir.
  maybeTrim(lineBytes) {
    let known = true;
    if (this._ownLines == null || this._ownBytes == null || this._dirBytes == null) known = false;
    else {
      try {
        const size = fs.statSync(this.file()).size;
        if (size === this._ownBytes + lineBytes) { this._ownBytes = size; this._ownLines += 1; this._dirBytes += lineBytes; }
        else known = false;
      } catch { known = false; }
    }
    if (!known) { this.trim(); return; }
    const ownOver = this._ownLines > this.maxLines;
    const dirOver = this._dirBytes > this.maxTotalBytes;
    if (dirOver || ++this._sinceSweep >= FOCUS_LOG_REVALIDATE_APPENDS) { this.trim(); return; }
    // At the line cap every append must drop the oldest line, which
    // needs this file's contents — but not a scan of the whole dir:
    // that is the part whose cost grew with the number of log files.
    if (ownOver) this._sweep(false);
  }
  // Caps: a conversation keeps its newest maxLines lines; the whole dir keeps
  // maxTotalBytes, dropping the oldest files first (never this session's own).
  trim() { this._sweep(true); }
  // One sweep of the caps. dirScan=false enforces only this file's line
  // cap and skips the readdir + stat of every other log file (wave 18).
  _sweep(dirScan) {
    try {
      const raw = fs.readFileSync(this.file(), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let ownLines = lines.length;
      let ownBytes = Buffer.byteLength(raw);
      if (lines.length > this.maxLines) { const kept = lines.slice(-this.maxLines); const out = kept.join('\n') + '\n'; fs.writeFileSync(this.file(), out); ownLines = kept.length; ownBytes = Buffer.byteLength(out); }
      if (!dirScan) {
        // Keep the dir estimate in step by this file's size change only.
        if (this._dirBytes != null && this._ownBytes != null) this._dirBytes += ownBytes - this._ownBytes;
        this._ownLines = ownLines; this._ownBytes = ownBytes;
        return;
      }
      // Per file (wave-9): one entry whose stat or unlink fails (a broken link)
      // must not abort the whole sweep, and a folder named *.jsonl is not a log
      // file — it is left out of the total and never unlinked. The old map threw
      // on the first bad entry and the outer catch skipped every later file.
      const files = [];
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(this.dir, f);
        try { const s = fs.statSync(p); if (s.isFile()) files.push({p, size: s.size, mtimeMs: s.mtimeMs}); } catch { /* skip this entry only */ }
      }
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = files.reduce((n, x) => n + x.size, 0);
      for (const x of files) {
        if (total <= this.maxTotalBytes) break;
        if (x.p === this.file()) continue;
        try { fs.unlinkSync(x.p); total -= x.size; } catch { /* one bad file must not stop the sweep */ }
      }
      // Wave 18: refresh maybeTrim()'s estimates from this sweep. The
      // scan above ran after any rewrite of this file, so its size here
      // is the post-trim size; total is what remains after deletions.
      // If this file is somehow absent from the scan, the estimates go
      // back to unmeasured and the next append sweeps again.
      const own = files.find(x => x.p === this.file());
      if (own) { this._ownLines = ownLines; this._ownBytes = own.size; this._dirBytes = total; }
      else { this._ownLines = null; this._ownBytes = null; this._dirBytes = null; }
      this._sinceSweep = 0;
    } catch { /* logging never breaks the task */ }
  }
  static readFile(file, {focus, why, event, limit} = {}) {
    let entries = [];
    try {
      entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        // Only log entries count: a line that is valid JSON but not an object
        // (42, "text", true, [...]) used to pass the truthiness filter, be
        // counted, and render as a garbage (empty) line in format().
        .filter(e => !!e && typeof e === 'object' && !Array.isArray(e));
    } catch { return []; }
    if (focus) entries = entries.filter(e => typeof e.focus === 'string' && e.focus.startsWith(focus));
    if (why) entries = entries.filter(e => e.why === why);
    if (event) entries = entries.filter(e => e.event === event);
    if (Number.isSafeInteger(limit) && limit >= 0) entries = entries.slice(-limit);
    return entries;
  }
  static read(dir, sessionId, filters = {}) { return FocusLog.readFile(logFile(sessionId, dir), filters); }
  static latestFile(dir = LOGS_DIR) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
        .map(f => { const p = path.join(dir, f); return {p, mtimeMs: fs.statSync(p).mtimeMs}; })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return files.length ? files[0].p : null;
    } catch { return null; }
  }
  // One readable line per entry: time, event, decision, why, then the detail.
  static format(entries) {
    return entries.map(e => {
      const parts = [e.at || '', e.event || '', e.decision || '', e.why || ''].filter(Boolean);
      if (e.focus) parts.push('focus ' + String(e.focus).slice(0, 8));
      if (e.round != null) parts.push('round ' + e.round);
      if (e.detail !== undefined) parts.push(typeof e.detail === 'string' ? e.detail.slice(0, 200) : JSON.stringify(e.detail).slice(0, 300));
      if (e.ref) parts.push('ref ' + (Array.isArray(e.ref) ? e.ref.join(',') : String(e.ref)).slice(0, 100));
      if (e.intent) parts.push('intent: ' + String(e.intent).slice(0, 120));
      return parts.join('  ');
    });
  }
}

module.exports = {FocusLog, FOCUS_LOG_LEVELS, FOCUS_LOG_MAX_LINES, FOCUS_LOG_MAX_TOTAL_BYTES, FOCUS_LOG_HEAD_CHARS, LOGS_DIR, logFile, sanitizeValue, sanitizeText, clipText, clipIntent};
