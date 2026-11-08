'use strict';
// The standalone /export fallback (EXPORT.md stage 2): when the muser
// body itself will not load — a broken require, a missing dependency —
// the rich export (src/export-cli.js) cannot run either, because it is
// part of the body. This entry is what remains: Node built-ins ONLY
// (node:fs / os / path / zlib / crypto / http / https / readline — no muser module,
// not even src/export.js), reading the on-disk stores directly and
// building the smallest report that still answers "what happened": the
// versions, the crash records (the usual reason for being here), the
// conversation's shape (never its words — a fallback has no business
// making the opt-in body promise), the Focus log's decisions, and the
// windows' shapes. Redaction is a small local copy of the same rules:
// emails, token shapes, and the Windows user name (Wave 16: at parity
// with src/export.js's redactString, URL userinfo included).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DEFAULT_REPORT_URL = 'https://api.necco.xyz/muser/report';
const MAX_GZIP_BYTES = 8 * 1024 * 1024;
const SEND_TIMEOUT_MS = 30000; // a receiver that never answers must not hang the send forever
// Wave 16: the fallback report had no size bound of its own — one crash
// record carrying a 10 MB string field built a >10 MB report that
// sendReport then refused (413), so the fallback was unsendable exactly
// when the machine was broken. Two bounds now apply, both local to this
// file: per-field caps as values enter (boundValue below), and a final
// guard in buildStandaloneReport (trimToFit below) that keeps the JSON
// under MAX_GZIP_BYTES — the same 8 MB line sendReport enforces on the
// gzip — so a built report is always sendable.
const MAX_FIELD_CHARS = 4096; // one string field's cap; the cut is marked in place
const MAX_ARRAY_ITEMS = 100; // one array field's cap (first items kept)
const MAX_OBJECT_KEYS = 100; // one object field's cap (first keys kept)
const TRIM_MARK = '…[trimmed]'; // the marker src/export.js's trimToFit leaves

function dataDir() { return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'muser') : path.join(os.homedir(), 'AppData', 'Local', 'muser'); }
function version() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || 'unknown'; } catch { return 'unknown'; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ------------------------------------------------------------- redaction
function username() { try { return os.userInfo().username || ''; } catch { return ''; } }
function redactString(input) {
  let s = String(input ?? '');
  const home = os.homedir() || '';
  if (home && home.length > 3) s = s.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
  s = s.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/:*?"<>|\s]+/gi, '$1<user>');
  s = s.replace(/(\/home\/)[^/\s]+/gi, '$1<user>');
  // URL userinfo (scheme://user:pass@host -> scheme://<redacted>@host),
  // greedy to the last '@' before the path so an address used as the user
  // name cannot leave its password behind (Wave 16, as src/crash.js has).
  s = s.replace(/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]+@/g, '$1<redacted>@');
  s = s.replace(/(authorization\s*:\s*)(?:bearer\s+|basic\s+)?[^\s,;}"']+/gi, '$1<redacted>');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  // Quoted-key JSON inside a string — the [:] rule below cannot see past
  // the quotes (audit-cli W5; Wave 16 brings the pair of rules to
  // src/export.js's exact coverage, incl. credential/authorization keys
  // and its 64-char caps, quoted value first, then the unquoted form).
  s = s.replace(/((["'])(?:[^"']{0,64}?(?:api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|token|credential|authorization)[^"']{0,64}?)\2\s*:\s*)(["'])[^"']*?\3/gi, '$1$3<redacted>$3');
  s = s.replace(/((["'])(?:[^"']{0,64}?(?:api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|token|credential|authorization)[^"']{0,64}?)\2\s*:\s*)[^\s,;}\]"']+/gi, '$1<redacted>');
  s = s.replace(/((?:api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi, '$1<redacted>');
  // Space-separated bare form (password CANARY-…): only values that look like secrets (>=12 chars, or >=4 chars containing a digit), so prose like "token counts" survives (mirrors src/export.js).
  s = s.replace(/\b(access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?key|private[-_]?key|access[-_]?key|api[-_]?key|password|passwd|secret|cookie|credential|token|bearer)\s+([^\s,;}"']+)/gi, (m, k, v) => (v.length >= 12 || (v.length >= 4 && /\d/.test(v)) ? k + ' <redacted>' : m));
  // Query-string secrets (?key= / ?auth= / ?session= …), the same names src/export.js covers (Wave 16).
  s = s.replace(/([?&](?:token|key|secret|password|auth|session|api[-_]?key)[^=&\s]*=)[^&\s]+/gi, '$1<redacted>');
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted>');
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<redacted>');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted>');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted>');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '<redacted>'); // Google API key shape (Wave 16)
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted>'); // Slack token shape (Wave 16)
  // Bounded like src/export.js's email rule (wave 12 there, wave 13 here):
  // the unbounded form backtracked quadratically over a long
  // separator-free string. The bounds are the RFC sizes.
  // The '<redacted>@host' a URL-userinfo pass just produced is not an
  // address (the host is no secret) — do not re-read it as one (Wave 16).
  s = s.replace(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g, (m, off, whole) => (whole[off - 1] === '<' && m.startsWith('redacted@') ? m : '<email>'));
  const un = username();
  if (un && un.length >= 3) s = s.split(un).join('<user>');
  return s;
}
const SECRET_KEY = /(token|password|passwd|secret|cookie|authorization|credential|api[-_]?key|private[-_]?key)/i;
function redactValue(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return redactString(v);
  if (depth > 10) return '<redacted>';
  if (Array.isArray(v)) return v.map(x => redactValue(x, depth + 1));
  if (typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && !/tokens$/i.test(k) ? '<redacted>' : redactValue(x, depth + 1); return out; }
  return undefined;
}

// ------------------------------------------------------------ size bounds
// Wave 16: cap what a single field can contribute, at the same points
// where redactValue already walks a value into the report. A string over
// the cap keeps its head and gains TRIM_MARK where the rest was cut; an
// array or object keeps its first items / keys. The caps bound breadth as
// well as length, but they are not the guarantee — trimToFit below is.
function capString(s) { return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) + TRIM_MARK : s; }
function boundValue(v, depth = 0) {
  if (typeof v === 'string') return capString(v);
  if (v == null || typeof v !== 'object' || depth > 12) return v;
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY_ITEMS).map(x => boundValue(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, MAX_OBJECT_KEYS)) out[k.length > MAX_FIELD_CHARS ? k.slice(0, MAX_FIELD_CHARS) : k] = boundValue(x, depth + 1);
  return out;
}

// ---------------------------------------------------------------- stores
function sessionsIndex() {
  const raw = readJson(path.join(dataDir(), 'sessions.json'));
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.sessions) ? raw.sessions : []);
  return list.filter(s => s && typeof s.id === 'string');
}
function pickSession(ref) {
  const list = sessionsIndex();
  if (ref) return list.find(s => s.id === ref) || list.find(s => s.id.startsWith(ref)) || null;
  const sorted = list.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return sorted.find(s => s.turns) || sorted[0] || null;
}
function transcriptShape(id) {
  const file = path.join(dataDir(), 'transcripts', String(id).replace(/[^A-Za-z0-9-]/g, '') + '.jsonl');
  let turns = 0, tools = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); turns++; tools += Array.isArray(t.tools) ? t.tools.length : 0; } catch {}
    }
  } catch {}
  return {turns, tools};
}
function focusLogShape(id) {
  const file = path.join(dataDir(), 'logs', String(id).replace(/[^A-Za-z0-9-]/g, '') + '.jsonl');
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      // Wave 16: event/decision/why ride verbatim no longer — each entry
      // passes through redactValue, so a secret shape stored in the log
      // (FocusLog.append sanitises nothing at the source) is scrubbed
      // before it can enter the report. Keys stay exactly these six.
      try { const e = JSON.parse(line); out.push(boundValue(redactValue({at: e.at ?? null, event: e.event ?? null, decision: e.decision ?? null, why: e.why ?? null, leg: e.leg ?? null, round: e.round ?? null}))); } catch {}
    }
  } catch {}
  return out.slice(-200);
}
function focusStateShape(id) {
  const raw = readJson(path.join(dataDir(), 'focus', String(id).replace(/[^A-Za-z0-9-]/g, '') + '.json'));
  if (!raw || typeof raw !== 'object') return null;
  const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
  const byStatus = {};
  // Wave 16: a byStatus key is a state string turned into an object key,
  // which redactValue cannot reach — redact it as the key is derived.
  for (const c of criteria) { const k = capString(redactString(String(c?.status ?? 'pending'))); byStatus[k] = (byStatus[k] || 0) + 1; }
  return boundValue(redactValue({status: raw.status ?? null, round: raw.round ?? null, maxRounds: raw.maxRounds ?? null, criteria: {total: criteria.length, byStatus}}));
}
// A crash record's file name embeds the time it was written (the ISO stamp
// with ':' and '.' folded to '-'); that embedded time orders the records,
// with mtime as the fallback for names that carry none — the same rule
// src/export.js and src/crash-investigate.js use (audit wave 12).
function crashNameTimeMs(f, mtime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(f);
  if (m) { const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '.' + m[7] + 'Z'); if (Number.isFinite(t)) return t; }
  return mtime;
}
function crashes(limit = 3) {
  const dir = path.join(dataDir(), 'crash');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => { let m = 0; try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch {} return {f, m: crashNameTimeMs(f, m)}; })
      .sort((a, b) => b.m - a.m || (a.f < b.f ? 1 : -1));
  } catch {}
  // A record that cannot be read, or whose contents are not an object, is
  // skipped WITHOUT eating one of the `limit` slots (audit wave 12): a
  // write cut off mid-crash used to leave a report:null entry in the
  // newest slot and push a valid record out of the report.
  const out = [];
  for (const {f, m} of files) {
    if (out.length >= limit) break;
    const raw = readJson(path.join(dir, f));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    out.push({file: f, at: new Date(m).toISOString(), report: boundValue(redactValue(raw))});
  }
  return out;
}
function windowShapeLite(w) {
  const todos = Array.isArray(w.todos) ? w.todos : [];
  const byStatus = {};
  // Wave 16: same byStatus-key rule as focusStateShape, and the whole
  // shape passes through redactValue so kind/activity/mode strings are
  // scrubbed before they enter the report.
  for (const td of todos) { const k = capString(redactString(String(td?.status ?? 'pending'))); byStatus[k] = (byStatus[k] || 0) + 1; }
  return boundValue(redactValue({kind: w.kind || 'window', pid: w.pid ?? null, activity: w.activity ?? null, connected: !!w.connected, slot: w.slot ?? null, mode: w.mode ?? null, startedAt: w.startedAt ?? null, updatedAt: w.updatedAt ?? null, todos: {count: todos.length, byStatus}, sessionTurns: w.session?.turns ?? null}));
}
function windows() {
  const dir = path.join(dataDir(), 'windows');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)); } catch {}
  for (const n of names) { const w = readJson(path.join(dir, n)); if (w && typeof w === 'object') out.push(w); }
  return out;
}
// Ask a window through its status folder, like src/export-window.js but
// with the standard library only. Resolves null on timeout. The file
// scheme matches src/export-window.js exactly (wave 18): one
// request-<pid>-<id>.json / response-<pid>-<id>.json pair per collection,
// the id unique to it, so simultaneous collectors no longer overwrite
// each other's single shared request file; the request is written
// atomically (temp file + rename) and cleanup removes only this
// collection's own pair.
async function collectWindow(pid, timeoutMs = 3000) {
  const dir = path.join(dataDir(), 'windows');
  const id = crypto.randomBytes(8).toString('hex');
  const reqFile = path.join(dir, 'request-' + pid + '-' + id + '.json');
  const resFile = path.join(dir, 'response-' + pid + '-' + id + '.json');
  let temp = null;
  try {
    fs.mkdirSync(dir, {recursive: true});
    temp = reqFile + '.tmp-' + process.pid + '-' + id;
    fs.writeFileSync(temp, JSON.stringify({id, pid, at: new Date().toISOString()}));
    fs.renameSync(temp, reqFile);
    temp = null;
  } catch { if (temp) { try { fs.unlinkSync(temp); } catch {} } return null; }
  const deadline = Date.now() + timeoutMs;
  let answered = null;
  try {
    while (Date.now() <= deadline) {
      const raw = readJson(resFile);
      if (raw && raw.id === id) { answered = raw; break; }
      await new Promise(r => setTimeout(r, 100));
    }
  } finally {
    try { fs.unlinkSync(reqFile); } catch {}
    try { fs.unlinkSync(resFile); } catch {}
  }
  return answered;
}
function hangFor(pid) {
  for (const c of crashes(20)) if (c.report && c.report.kind === 'hang' && c.report.pid === pid) return {file: c.file, at: c.at, stack: Array.isArray(c.report.stack) ? c.report.stack : []};
  return null;
}
function settingsLite() {
  const cfg = readJson(path.join(os.homedir(), '.muser', 'config.json'));
  const out = {};
  if (cfg && typeof cfg === 'object') for (const [k, v] of Object.entries(cfg)) if ((typeof v === 'boolean' || typeof v === 'number') && !SECRET_KEY.test(k)) out[k] = v;
  return out;
}

// ----------------------------------------------------------------- build
// Wave 16: a stored session date can be garbage (a hand-edited or
// half-written sessions.json); new Date(garbage).toISOString() throws a
// RangeError, which killed the whole fallback report — the one report
// that must survive a broken machine. An invalid date becomes null.
function isoOrNull(v) { if (!v) return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
// Wave 16: the final size guard. A report is over when its JSON passes
// MAX_GZIP_BYTES or the gzip sendReport would build from it does, and
// the trimming runs in that order: the OLDEST crash records first
// (report.crashes is newest-first, so the oldest leave from the tail —
// the newest crash, the usual reason for the report, always stays),
// then the optional sections are thinned and, if that is not enough,
// replaced by the same note src/export.js leaves. What still does not
// fit is cut inside the newest crash record itself — its largest arrays
// halved, its largest entries dropped, its largest strings cut — and as
// a last resort that record is reduced to its scalar fields, so its
// identity (error / kind / scope) survives even then. Every cut is named
// in report.trimmed, as in src/export.js.
function largestSlot(root, want) {
  let best = null;
  const seen = new Set();
  const walk = (value, parent, key, depth) => {
    if (depth > 50 || value == null) return;
    if (typeof value === 'string') {
      if (want === 'string' && parent) { const bytes = Buffer.byteLength(value, 'utf8'); if (!best || bytes > best.bytes) best = {parent, key, value, bytes}; }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (want === 'array') { const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); if (!best || bytes > best.bytes) best = {arr: value, bytes}; }
      value.forEach((v, i) => walk(v, value, i, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (want === 'entry' && (v != null && typeof v === 'object')) { const bytes = Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8'); if (!best || bytes > best.bytes) best = {parent: value, key: k, bytes}; }
      walk(v, value, k, depth + 1);
    }
  };
  walk(root, null, null, 0);
  return best;
}
function trimToFit(report) {
  const over = () => {
    const json = JSON.stringify(report);
    if (Buffer.byteLength(json, 'utf8') > MAX_GZIP_BYTES) return true;
    return zlib.gzipSync(Buffer.from(json, 'utf8')).length > MAX_GZIP_BYTES;
  };
  if (!over()) return report;
  const trimmed = new Set(Array.isArray(report.trimmed) ? report.trimmed : []);
  const note = () => { if (trimmed.size) report.trimmed = [...trimmed]; };
  // Oldest crash records first; the newest one never leaves this loop.
  while (over() && Array.isArray(report.crashes) && report.crashes.length > 1) { report.crashes.pop(); trimmed.add('crashes'); note(); }
  // Optional sections, thinned from their oldest end.
  while (over() && Array.isArray(report.focusLog) && report.focusLog.length) { report.focusLog.splice(0, Math.ceil(report.focusLog.length / 2)); trimmed.add('focusLog'); note(); }
  const events = report.window && Array.isArray(report.window.events) ? report.window.events : null;
  while (over() && events && events.length) { events.splice(0, Math.ceil(events.length / 2)); trimmed.add('window'); note(); }
  while (over() && report.state && Array.isArray(report.state.windows) && report.state.windows.length) { report.state.windows.splice(Math.ceil(report.state.windows.length / 2)); trimmed.add('state'); note(); }
  for (const key of ['focusLog', 'focusState', 'window', 'state', 'settings']) {
    if (!over()) break;
    // Only a section bigger than the note itself is worth replacing.
    if (key in report && report[key] !== '[trimmed: section too large to send]' && Buffer.byteLength(JSON.stringify(report[key]) ?? 'null', 'utf8') > 40) { report[key] = '[trimmed: section too large to send]'; trimmed.add(key); note(); }
  }
  // Inside the newest crash record: largest arrays halved, then largest
  // object entries dropped, then largest strings cut by the overflow.
  const crashReport = () => (Array.isArray(report.crashes) && report.crashes[0] && report.crashes[0].report && typeof report.crashes[0].report === 'object' ? report.crashes[0].report : null);
  for (let guard = 0; over() && guard < 100; guard++) { const root = crashReport(); if (!root) break; const slot = largestSlot(root, 'array'); if (!slot || slot.arr.length < 2) break; slot.arr.splice(Math.ceil(slot.arr.length / 2)); trimmed.add('crashes'); note(); }
  for (let guard = 0; over() && guard < 200; guard++) { const root = crashReport(); if (!root) break; const slot = largestSlot(root, 'entry'); if (!slot) break; delete slot.parent[slot.key]; trimmed.add('crashes'); note(); }
  for (let guard = 0; over() && guard < 100; guard++) { const root = crashReport(); if (!root) break; const slot = largestSlot(root, 'string'); if (!slot || slot.bytes < 64) break; let target = Math.max(TRIM_MARK.length, slot.value.length - (Buffer.byteLength(JSON.stringify(report), 'utf8') - MAX_GZIP_BYTES) - 256); if (target >= slot.value.length) target = Math.floor(slot.value.length / 2); slot.parent[slot.key] = slot.value.slice(0, target) + TRIM_MARK; trimmed.add('crashes'); note(); }
  // Last resort: the newest crash record keeps only its scalar fields
  // (strings cut to 300, as loadError already is), so it always fits and
  // still says what crashed.
  if (over() && crashReport()) {
    const stub = {};
    for (const [k, v] of Object.entries(crashReport())) { if (v == null || typeof v === 'number' || typeof v === 'boolean') stub[k] = v; else if (typeof v === 'string') stub[k] = v.slice(0, 300); }
    report.crashes[0].report = stub;
    trimmed.add('crashes');
    note();
  }
  note();
  return report;
}
function buildStandaloneReport({sessionRef = null, windowPid = null, windowSection = null, loadError = null} = {}) {
  const session = windowPid != null ? null : pickSession(sessionRef);
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    includesConversation: false,
    standalone: true,
    note: '本体モジュールが読み込めなかったため、標準機能だけの最小レポートです。会話の本文は含みません。',
    app: {name: 'muser', version: version(), node: process.version, platform: process.platform, osRelease: os.release(), osVersion: os.version(), arch: os.arch(), uiMode: 'cli'},
    settings: settingsLite(),
    crashes: crashes(3),
    state: {windows: windows().map(windowShapeLite)},
  };
  if (loadError) report.loadError = {name: String(loadError.name || 'Error'), message: redactString(String(loadError.message || '').split(/\r?\n/)[0]).slice(0, 300)};
  // Wave 16: a caller-built window section (incl. its events) gets the
  // same redaction pass here, since nothing downstream scrubs it.
  if (windowSection) report.window = boundValue(redactValue(windowSection));
  if (session) {
    const shape = transcriptShape(session.id);
    report.session = {id: session.id, cwd: session.cwd ? capString(redactString(session.cwd)) : null, createdAt: isoOrNull(session.created), updatedAt: isoOrNull(session.updated), turns: typeof session.turns === 'number' ? session.turns : shape.turns, tools: shape.tools};
    report.focusLog = focusLogShape(session.id);
    report.focusState = focusStateShape(session.id);
  }
  // Wave 16: no built report may outgrow the send limit (trimToFit above).
  trimToFit(report);
  return report;
}

// ------------------------------------------------------------------ send
// The request carries a socket timeout (opts.timeoutMs — a number or
// {timeoutMs} — default SEND_TIMEOUT_MS, mirroring src/export.js): a
// receiver that accepts the connection and then never answers used to
// hang the send forever. A timeout destroys the request with a status-0
// error, which failureMessage() already reads as "could not connect".
function sendReport(report, url, opts = {}) {
  const timeoutMs = typeof opts === 'number' && Number.isFinite(opts) && opts > 0 ? opts
    : (opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : SEND_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(report), 'utf8'));
    if (gz.length > MAX_GZIP_BYTES) { const e = new Error('report too large'); e.status = 413; reject(e); return; }
    const u = new URL(url || String(process.env.MUSER_REPORT_URL || '').trim() || DEFAULT_REPORT_URL);
    const lib = u.protocol === 'http:' ? require('node:http') : require('node:https');
    const req = lib.request({method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, timeout: timeoutMs, headers: {'content-type': 'application/gzip', 'x-muser-version': version(), 'content-length': gz.length}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      // A receiver that cuts the socket in the middle of the reply body
      // never fires 'end', so without these handlers the promise never
      // settles and the send hangs forever. An incomplete reply is a
      // status-0 failure, which failureMessage() already phrases as a
      // connection problem. ('close' also follows a normal 'end', but
      // then res.complete is true and this stays quiet; a reject after
      // the promise resolved is a no-op anyway.)
      const incomplete = cause => { const e = new Error(cause && cause.message ? 'response cut off: ' + cause.message : 'response cut off before it completed'); e.status = 0; reject(e); };
      res.on('aborted', () => incomplete());
      res.on('error', incomplete);
      res.on('close', () => { if (!res.complete) incomplete(); });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && body && typeof body.id === 'string' && body.id) resolve({id: body.id});
        else { const e = new Error((body && body.error) || ('HTTP ' + res.statusCode)); e.status = res.statusCode; if (res.statusCode >= 200 && res.statusCode < 300) e.unconfirmed = true; reject(e); }
      });
    });
    req.on('timeout', () => { const e = new Error('request timed out after ' + timeoutMs + ' ms'); e.status = 0; req.destroy(e); });
    req.on('error', e => { if (typeof e.status !== 'number') e.status = 0; reject(e); });
    req.write(gz);
    req.end();
  });
}
function failureMessage(err) {
  // A 2xx reply whose body could not be read (or held no id): the report
  // may well have arrived, so do not phrase it as a plain failure.
  if (err && err.unconfirmed) return '応答が読めなかったため、届いたか確認できませんでした。再送すると重複することがあります。';
  const status = err && typeof err.status === 'number' ? err.status : -1;
  if (status === 413) return 'レポートが大きすぎて送れませんでした（8MB を超えています）。';
  if (status === 429) return '短い時間に送りすぎです。時間をおいてから、もう一度送ってください。';
  if (status === 507) return '開発者側の保存場所がいっぱいです。時間をおいてから、もう一度送ってください。';
  if (status === 415) return '送る形式が受け付けられませんでした（muser 側の不具合の可能性があります）。';
  if (status === 400) return 'レポートの形式が正しくないと返されました（muser 側の不具合の可能性があります）。';
  if (status === 500) return '開発者側で保存に失敗しました。時間をおいてから、もう一度送ってください。';
  if (status === 0) return '送り先に接続できませんでした: ' + (err.message || '');
  return '送れませんでした: ' + ((err && err.message) || String(err));
}
function saveReport(report) {
  const dir = process.env.MUSER_EXPORT_DIR || path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(dir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const short = String(report.session?.id || report.window?.pid || 'session').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
  // The stamp is only second-precise and the short id is shared by every
  // save of one session, so two saves in the same second used to land on
  // the same name and the second silently overwrote the first. A random
  // suffix keeps each save its own file.
  const suffix = crypto.randomBytes(4).toString('hex');
  const file = path.join(dir, 'muser-report-' + stamp + '-' + short + '-' + suffix + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 1) + '\n');
  return file;
}
function parseArgs(argv) {
  const o = {_: []};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let eqValue;
    const eq = /^--(session|window)=(.*)$/.exec(a);
    if (eq) { a = '--' + eq[1]; eqValue = eq[2]; }
    if (a === '--with-conversation') o.withConversation = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--session') { const v = eqValue !== undefined ? eqValue : argv[++i]; if (v === undefined || v === '') throw new Error('--session には値が必要です。使い方: muser --help'); o.session = v; }
    else if (a === '--window') {
      if (eqValue !== undefined) o.window = eqValue || true;
      else { const v = argv[i + 1]; if (v !== undefined && !v.startsWith('-')) { o.window = v; i++; } else o.window = true; }
    } else if (a.startsWith('--')) throw new Error('知らないオプションです: ' + a);
    else o._.push(a);
  }
  return o;
}
async function askYesNo(question) {
  const {createInterface} = require('node:readline');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const answer = await new Promise(r => { let done = false; const fin = v => { if (!done) { done = true; r(v); } }; rl.question(question, fin); rl.on('close', () => fin('')); });
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

async function run(argv, {loadError = null} = {}) {
  const o = parseArgs(argv);
  if (o._.length) throw new Error('余分な引数です: ' + o._.join(' ') + '。使い方: muser --help');
  if (o.dryRun && o.yes) throw new Error('--dry-run と --yes は一緒に使えません。');
  if (o.withConversation) console.log('本体が読み込めないため、会話の本文は含められません。本文なしで続けます。');
  let report;
  if (o.window !== undefined) {
    const all = windows();
    if (!all.length) throw new Error('動いている窓がありません。');
    let target = null;
    if (o.window === true) {
      for (const [i, w] of all.entries()) console.log('  ' + (i + 1) + '. pid ' + w.pid + '  ' + (w.activity || '') + '  ' + (w.updatedAt || ''));
      throw new Error('窓を選べません。--window <pid> で窓を指定してください。');
    }
    target = all.find(w => String(w.pid) === String(o.window)) || all.find(w => w.session && String(w.session.id).startsWith(String(o.window))) || null;
    if (!target) throw new Error('その窓が見つかりません: ' + o.window);
    const answered = await collectWindow(target.pid);
    const section = windowShapeLite(answered && answered.state ? answered.state : target);
    section.pid = target.pid;
    section.answered = !!answered;
    if (answered) section.events = Array.isArray(answered.events) ? answered.events : [];
    else section.hang = hangFor(target.pid);
    report = buildStandaloneReport({windowPid: target.pid, windowSection: section, loadError});
    if (target.session && target.session.id) {
      const s = pickSession(target.session.id);
      if (s) { const shape = transcriptShape(s.id); report.session = {id: s.id, cwd: s.cwd ? redactString(s.cwd) : null, turns: typeof s.turns === 'number' ? s.turns : shape.turns, tools: shape.tools}; report.focusLog = focusLogShape(s.id); report.focusState = focusStateShape(s.id); }
    }
  } else {
    report = buildStandaloneReport({sessionRef: o.session || null, loadError});
    if (!report.session) throw new Error('送る会話がありません。まず muser で会話をしてから実行してください。');
  }
  if (o.dryRun) {
    const file = saveReport(report);
    console.log('送らずにファイルに書きました: ' + file);
    console.log('  合計: ' + Buffer.byteLength(JSON.stringify(report), 'utf8') + ' B');
    return;
  }
  if (!o.yes) {
    if (!process.stdin.isTTY) throw new Error('確認できないため送りません。送るなら --yes、ファイルに書くなら --dry-run を付けてください。');
    console.log('送るレポートの中身（最小レポート）: 合計 ' + Buffer.byteLength(JSON.stringify(report), 'utf8') + ' B');
    if (!await askYesNo('このレポートを開発者に送りますか？ [y/N] ')) return console.log('送りませんでした。');
  }
  try {
    const {id} = await sendReport(report);
    console.log('送りました。ID: ' + id + ' — この ID を Discord などで開発者に伝えてください');
  } catch (e) {
    process.exitCode = 1;
    console.log(failureMessage(e));
  }
}

module.exports = {run, buildStandaloneReport, redactString, sendReport, failureMessage, saveReport, parseArgs, SEND_TIMEOUT_MS};
