'use strict';
// /export (EXPORT.md, 2026-11-07): a bug report the USER chooses to send.
// Nothing here runs on its own and nothing is collected in the background:
// a report exists only because the user typed /export or `muser export`,
// saw what it holds, and picked "send". The receiver is
// POST https://api.necco.xyz/muser/report (tools/report-receiver/), the body
// is gzipped JSON, and MUSER_REPORT_URL points it elsewhere (tests use a
// local server; the real receiver is never a test target).
//
// Shape (schema 1): versions / OS / terminal, the settings values (a fixed
// whitelist, so a future config key cannot ride along by accident), the
// account COUNT and which account this conversation is on by ordinal only
// ("1 番目" — never a label that could be an address, never an email), the
// conversation's tool records (command / summary / ok / error — never a
// tool argument's body), its Focus state and decision log, the newest crash
// record, and the window / server / terminal-slot state with every token
// left out. The conversation's own words (user / reply) are the one opt-in
// section, off by default, chosen at the confirmation screen every time.
//
// Everything passes through redact() last: *.enc contents, tokens, cookies,
// Authorization, keys, password-shaped values, the contents of files
// isSensitivePath() names, email addresses, and the Windows user name in
// paths (C:\Users\<name> -> C:\Users\<user>). When in doubt, leave it out.
//
// A second pass runs BEFORE that when the conversation body is not
// included (the fix after report 20261107-6add4cf739 was read back): prose
// also hides OUTSIDE the body — a Focus log line's detail.goal is the
// user's own request and its intent is Muse's progress sentence, a
// progress note is a sentence about the user's task, a tool summary is
// copied from the tool's arguments (a progress.report call's summary IS
// its message), a todo is the task in someone's words, and OTHER windows'
// state is other conversations entirely. Redaction cannot fix a plain
// sentence (there is nothing in it to redact), so without the body those
// fields keep only their shape — lengths, counts, the decision tokens,
// the command name, path-shaped values — via shapeValue() below, and
// other windows keep only their shape ALWAYS (see windowShape()).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const SCHEMA = 1;
const DEFAULT_REPORT_URL = 'https://api.necco.xyz/muser/report';
const MAX_GZIP_BYTES = 8 * 1024 * 1024; // the receiver's 413 line
const MAX_JSON_BYTES = 6 * 1024 * 1024; // trim long before gzip can reach it
const SEND_TIMEOUT_MS = 30000; // a receiver that never answers must not hang the send forever

function reportUrl(env = process.env) { return String(env.MUSER_REPORT_URL || '').trim() || DEFAULT_REPORT_URL; }
function version() { try { return require('../package.json').version; } catch { return 'unknown'; } }

// ---------------------------------------------------------------- redaction
// Key names whose VALUE is a secret wherever they appear. Plural counts
// (inputTokens, outputTokens) are numbers about usage, not credentials, so
// the token rule matches a trailing singular "token" or a token segment,
// never "...Tokens".
const SECRET_KEY = /(^|[-_.])(token|password|passwd|secret|cookie|authorization|credential|credentials|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key)([-_.]|$)/i;
const TOKEN_KEY = /^(access|refresh|auth|session|bearer|csrf|xsrf|id)[-_]?token$/i;
const CONTENT_KEY = /^(content|text|data|body|output|result|params)$/i;
const PATH_KEY = /^(path|file|filename|filepath|dir|cwd|directory)$/i;
function isSecretKey(key) {
  const k = String(key || '');
  if (/tokens$/i.test(k)) return false; // usage counts, not credentials
  return SECRET_KEY.test(k) || TOKEN_KEY.test(k) || /^(token|password|passwd|secret|cookie|authorization|apikey|privatekey)$/i.test(k.replace(/[-_]/g, ''));
}
let sensitivePathFn = null;
function isSensitivePath(p) {
  try { sensitivePathFn ??= require('./tools').isSensitivePath; return !!sensitivePathFn(p); } catch { return /\.enc$/i.test(String(p || '')); }
}
function userNameOf(opts = {}) {
  if (opts.username !== undefined) return String(opts.username || '');
  try { const u = os.userInfo().username; if (u) return String(u); } catch {}
  return String(process.env.USERNAME || process.env.USER || '');
}
function homeDirOf(opts = {}) { return String(opts.homeDir || os.homedir() || ''); }
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One string through every rule. Order matters: structured secrets first
// (an Authorization value, a key=value pair), then token shapes, emails,
// then the user name — as a path segment, as the home folder, and as a
// standalone word.
function redactString(input, opts = {}) {
  let s = String(input ?? '');
  const username = userNameOf(opts), home = homeDirOf(opts);
  if (home && home.length > 3) {
    for (const form of [home, home.replace(/\\/g, '/')]) {
      if (form.length > 3) s = s.split(form).join('~');
    }
  }
  s = s.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/:*?"<>|\s]+/gi, '$1<user>');
  s = s.replace(/(\/home\/)[^/\s]+/gi, '$1<user>');
  s = s.replace(/(authorization\s*:\s*)(?:bearer\s+|basic\s+)?[^\s,;}"']+/gi, '$1<redacted>');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  // A secret under a QUOTED key, inside a string (a JSON fragment carried
  // as text, or a single-quoted object literal): {"password": "…"} /
  // {'password': '…'}. The quote between the key and its colon kept the
  // key=value rule below from ever reaching the value (wave-5 finding;
  // src/worklog.js's SECRET_JSON covers the double-quoted form for the
  // local log — this is the same level, plus single quotes). The key's
  // [^"'] segments are capped at 64 (wave 13): unbounded, a long quoted
  // string full of keyword-shaped fragments partitioned between them
  // quadratically, the same failure worklog's SECRET_JSON had.
  s = s.replace(/((["'])(?:[^"']{0,64}?(?:api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|token|credential|authorization)[^"']{0,64}?)\2\s*:\s*)(["'])[^"']*?\3/gi, '$1$3<redacted>$3');
  s = s.replace(/((["'])(?:[^"']{0,64}?(?:api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|token|credential|authorization)[^"']{0,64}?)\2\s*:\s*)[^\s,;}\]"']+/gi, '$1<redacted>');
  s = s.replace(/((?:api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi, '$1<redacted>');
  // A bare label followed by its value (`password CANARY…`): the
  // SECRET_BARE equivalent src/worklog.js has and this pass never did.
  // worklog's bareValue keeps a value unless it is long (>=12) or
  // longish with a digit (>=8) — right for a local log that should not
  // mangle prose, but a report LEAVES the machine, so the digit branch
  // is wider here (>=4: `secret ZXQ-7` is a secret, not a sentence).
  // A value with neither length nor a digit (`token counts`) is prose
  // and stays, exactly as in worklog.
  s = s.replace(/\b(access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?key|private[-_]?key|access[-_]?key|api[-_]?key|password|passwd|secret|cookie|credential|token|bearer)\s+([^\s,;}"']+)/gi, (m, k, v) => (v.length >= 12 || (v.length >= 4 && /\d/.test(v))) ? k + ' <redacted>' : m);
  s = s.replace(/([?&](?:token|key|secret|password|auth|session|api[-_]?key)[^=&\s]*=)[^&\s]+/gi, '$1<redacted>');
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted>'); // JWT
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<redacted>');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted>');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted>');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '<redacted>'); // Google API key shape (worklog's SECRET_SHAPE set)
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted>');
  // A URL's user:password@ userinfo (wave 16): the same rule
  // src/crash.js's scrubSecretTextLine already has, which this pass
  // never did. [^/\s]+ is greedy to the LAST '@' before the path, so
  // an address used as the user name cannot leave its password
  // behind. It runs before the email rule below because that rule
  // cannot save an IP or localhost host (its domain needs a letter
  // TLD): 'http://bob:secret@192.168.1.10:8080/doc' survived
  // verbatim. A URL with no '@' before its first '/' is untouched,
  // and a plain email address has no scheme:// for it to start on.
  s = s.replace(/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]+@/g, '$1<redacted>@');
  // Bounded on purpose (wave 12): the unbounded form backtracked over
  // every starting position of a long separator-free string (50K chars of
  // plain letters took ~1.5 s — quadratic), and this pass runs over whole
  // reports. The bounds are the RFC sizes (local part <= 64, domain
  // <= 253, one label's TLD <= 63), so a real address still matches whole;
  // each starting position now costs at most a few hundred steps.
  s = s.replace(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g, '<email>');
  if (username && username.length >= 3) {
    s = s.replace(new RegExp('(^|[^A-Za-z0-9_.-])' + escRe(username) + '([^A-Za-z0-9_.-]|$)', 'gi'), '$1<user>$2');
  }
  return s;
}
// Deep copy with the rules applied. An object that NAMES a sensitive file
// (a path/file field isSensitivePath() catches, or any *.enc path) loses
// its content-shaped fields whole: the file's contents never travel, even
// clipped. A value under a secret-shaped key is replaced whatever it was.
function redactValue(value, opts = {}, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value, opts);
  if (depth > 12) return '<redacted>';
  if (Array.isArray(value)) return value.map(v => redactValue(v, opts, depth + 1));
  if (typeof value === 'object') {
    const paths = Object.entries(value).filter(([k, v]) => PATH_KEY.test(k) && typeof v === 'string').map(([, v]) => v);
    const sensitiveFile = paths.some(p => /\.enc($|[?#])/i.test(p.trim()) || isSensitivePath(p));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) { out[k] = '<redacted>'; continue; }
      if (sensitiveFile && CONTENT_KEY.test(k)) { out[k] = '<redacted>'; continue; }
      out[k] = redactValue(v, opts, depth + 1);
    }
    return out;
  }
  return undefined; // functions / symbols never travel
}
const redact = (value, opts) => redactValue(value, opts || {});

// ------------------------------------------------------- shape-only text
// Keys whose string values are codes, not prose: decisions, statuses, ids,
// command names, timestamps. Everything else that is a string becomes a
// length (<key>Chars) unless it is path-shaped (paths are a shape; the
// redact pass still rewrites the user name inside them). Inside arrays,
// short identifier-shaped strings (evidence ids, criterion ids) also ride
// as-is; any other string element becomes {chars}.
// 'why' is in this set on purpose (the 2026-11-07 shape-only fix, A):
// in the Focus decision log `why` is a fixed decision vocabulary, not
// prose — src/focus.js builds it only from fixed names (_observeWhy:
// 'classified_change:…', 'read_only:…', 'verification_run', …;
// focusToolRejectionWhy and endRound likewise) and src/agent.js passes
// literals or focus.status. Keeping the code is what makes a sent log
// readable as a decision record. The hole (wave 5): FocusLog.append
// stores `why` with String() only — no sanitising at the source — so a
// why that carries free text can carry a secret shape with it, and the
// shape pass let it through untouched. Judgment: the shape-only policy
// stands (why stays TEXT, it does not become whyChars), but a kept why
// now goes through redactString like every other string that leaves
// the machine — the code survives, any secret shape inside it does
// not. The final redact() in buildReport remains as the second pass.
const SHAPE_KEEP_KEYS = new Set(['id', 'kind', 'status', 'command', 'event', 'decision', 'why', 'code', 'type', 'state', 'mode', 'source', 'agent', 'level', 'scope', 'session', 'focus', 'ref', 'tag', 'at', 'startedAt', 'updatedAt', 'endedAt', 'createdAt', 'turnStartedAt', 'since']);
const SHAPE_TEXT = Symbol('shape-text');
const ID_LIKE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
// A path rides only under a key that names a path (cwd, path, file, observedPaths...).
// Judging the string alone let prose through: a request such as "/export を作って。仕様は
// C:\...\spec.md" holds slashes too (seen in a real report, 2026-11-07).
const SHAPE_PATH_KEY = /(^|[a-z])(path|paths|cwd|file|files|dir|folder)$/i;
function isPathLike(s, key) { return !!key && SHAPE_PATH_KEY.test(key) && !/[\r\n]/.test(s) && (/[\\/]/.test(s) || /^[A-Za-z]:/.test(s)); }
function shapeValue(value, key, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (key && SHAPE_KEEP_KEYS.has(key)) return key === 'why' ? redactString(value) : value;
    if (isPathLike(value, key)) return value;
    return SHAPE_TEXT;
  }
  if (Array.isArray(value)) {
    return value.map(v => {
      const s = shapeValue(v, key, depth + 1);
      if (s !== SHAPE_TEXT) return s;
      return typeof v === 'string' && ID_LIKE.test(v) ? v : {chars: typeof v === 'string' ? v.length : 0};
    });
  }
  if (typeof value === 'object') {
    if (depth > 8) return {keys: Object.keys(value).length};
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) { out[k] = v; continue; } // redact() replaces it wholesale below
      const s = shapeValue(v, k, depth + 1);
      if (s === SHAPE_TEXT) { out[k + 'Chars'] = typeof v === 'string' ? v.length : 0; continue; }
      out[k] = s;
    }
    return out;
  }
  return undefined;
}
// An error's text can quote the user's words or a file fragment; without
// the body only its kind (when it names one) and its length ride along.
function errorShape(error) {
  const s = String(error ?? '');
  const m = /^([A-Za-z_$][\w$]*)/.exec(s.trim());
  return m && /Error$/.test(m[1]) ? {name: m[1], chars: s.length} : {chars: s.length};
}
// Path-shaped tokens out of a tool summary: the paths a command touched
// are a shape (redacted later); the sentence around them is not.
function extractPaths(text) {
  const out = [];
  const seen = new Set();
  for (const tok of String(text || '').split(/[\s'"`<>|;]+/)) {
    const t = tok.replace(/^[([\[{]+|[)\]},:]+$/g, '');
    if (!t || t.length > 240 || seen.has(t)) continue;
    if (/^[A-Za-z]:[\\/]/.test(t) || /[\\/]/.test(t) || /^[\w.-]+\.[A-Za-z0-9]{1,10}$/.test(t)) { seen.add(t); out.push(t); if (out.length >= 5) break; }
  }
  return out;
}
function countBy(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

// ------------------------------------------------------------------ pieces
// The terminal this process runs in, in the shape src/crash.js already
// records, plus a kind name "as far as can be told".
function terminalInfo(env = process.env) {
  // TERM / TERM_PROGRAM VALUES never travel (wave 5): they are the
  // user's own environment strings — a custom TERM_PROGRAM can name a
  // private build or a path — and `kind` used to echo TERM_PROGRAM (or
  // TERM) verbatim. Only presence and the recognised kinds remain:
  // an unrecognised TERM_PROGRAM is 'other', a lone TERM is 'term'.
  const kind = env.WT_SESSION ? 'windows-terminal'
    : env.TERM_PROGRAM === 'vscode' ? 'vscode'
    : env.ConEmuPID ? 'conemu'
    : env.TERM_PROGRAM ? 'other'
    : env.TERM ? 'term' : 'unknown';
  return {
    kind,
    columns: process.stdout.columns || null, rows: process.stdout.rows || null,
    TERM: !!env.TERM, TERM_PROGRAM: !!env.TERM_PROGRAM,
    windowsTerminal: !!env.WT_SESSION, vscode: env.TERM_PROGRAM === 'vscode', conEmu: !!env.ConEmuPID,
  };
}
// Settings: a whitelist built from settings.js itself, so config.json keys
// nobody vetted (a hand-edited file can hold anything) stay home. Effective
// values, env overrides included — that is what the running muser obeys.
function settingsSnapshot() {
  const out = {};
  try {
    const settings = require('./settings');
    for (const k of Object.keys(settings.SWITCHES)) { try { out[k] = settings.switchValue(k); } catch {} }
    for (const k of Object.keys(settings.NUMBERS)) { try { out[k] = settings.numberValue(k); } catch {} }
    try { out.defaultMode = settings.defaultMode(); } catch {}
    try { out.quotaFallback = settings.quotaFallback(); } catch {}
    try { out.focusLogLevel = settings.focusLogLevel(); } catch {}
  } catch {}
  try {
    const cfg = require('./config').read();
    if (Number.isSafeInteger(cfg.maxAgents)) out.maxAgents = cfg.maxAgents;
    if (Number.isSafeInteger(cfg.maxAgentsTotal)) out.maxAgentsTotal = cfg.maxAgentsTotal;
    if (typeof cfg.accountAuto === 'boolean') out.accountAuto = cfg.accountAuto;
    if (typeof cfg.accountThreshold === 'number' && Number.isFinite(cfg.accountThreshold)) out.accountThreshold = cfg.accountThreshold;
  } catch {}
  return out;
}
// A read-only look at a store file (wave 15): true when the file is there
// but is not usable JSON of the expected shape. It never writes, renames or
// deletes — reporting a broken store must not heal it, move it or hide it.
// A missing file is a fresh install, not breakage.
function storeFileBroken(file, shapeOk) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
  try { return !shapeOk(JSON.parse(raw)); } catch { return true; }
}
function accountsFileBroken() {
  try { return storeFileBroken(require('./secure-store').file('accounts.json'), v => !!v && typeof v === 'object' && Array.isArray(v.accounts)); } catch { return false; }
}
function sessionsFileBroken() {
  try { return storeFileBroken(require('./sessions').FILE, v => Array.isArray(v) || (!!v && typeof v === 'object' && Array.isArray(v.sessions))); } catch { return false; }
}
// Accounts by count and ordinal only. list() synthesises the default first,
// so the ordinal is the position a user would count to in /account.
function accountsSnapshot(sessionAccountId) {
  let list = null;
  try { list = require('./accounts').list(); } catch {}
  // A broken accounts.json is reported as broken (wave 15): list() throwing
  // used to be read as "no accounts", so the report claimed a count of 0
  // over a registry that is really there but unreadable. The count is null
  // (unknown), never 0, and the breakage rides along as corrupt.
  if (!list || accountsFileBroken()) return {count: null, currentIndex: null, current: null, corrupt: true};
  let currentId = sessionAccountId || null;
  if (!currentId) { try { currentId = require('./accounts').activeId(); } catch {} }
  const idx = currentId ? list.findIndex(a => a.id === currentId) : -1;
  return {count: list.length, currentIndex: idx >= 0 ? idx + 1 : null, current: idx >= 0 ? (idx + 1) + ' 番目' : null};
}
// One transcript turn, reduced to the record of what was DONE. With the
// conversation body the tools keep their summaries and the progress notes
// their sentences (redacted like everything). Without it, prose fields
// keep only their shape: a summary becomes its length plus the paths in
// it (the summary is copied from the arguments — a progress.report call's
// summary is the message itself, so clipping + redaction would still let
// plain sentences through), a progress note and a step title become a
// length, an error becomes its kind and length, the todos become a count
// by status, and the Focus state goes through shapeValue(). Tool
// arguments and step details stay out either way — a written file's whole
// text is an argument, not a record.
function turnSnapshot(turn, includeConversation) {
  if (!turn || typeof turn !== 'object') return null;
  const out = {at: turn.at ?? null};
  if (turn.usage && typeof turn.usage === 'object') {
    const u = {};
    for (const k of ['inputTokens', 'outputTokens', 'source']) if (turn.usage[k] !== undefined) u[k] = turn.usage[k];
    out.usage = u;
  }
  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  const progress = Array.isArray(turn.progress) ? turn.progress : [];
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  const todos = Array.isArray(turn.todos) ? turn.todos : [];
  // The turn's sources (the citations behind the reply, recorded as
  // {label, uri} — src/agent.js) ride in BOTH modes (wave 12: they used
  // to be dropped entirely): a label and a URI are a citation, not the
  // conversation's prose, and the final redact() in buildReport rewrites
  // any email / key shape / user name inside them like everywhere else.
  const sourceList = [];
  for (const src of Array.isArray(turn.sources) ? turn.sources : []) {
    if (typeof src === 'string') { if (src) sourceList.push({label: '', uri: src}); continue; }
    if (!src || typeof src !== 'object') continue;
    const label = String(src.label ?? ''), uri = String(src.uri ?? '');
    if (label || uri) sourceList.push({label, uri});
  }
  if (sourceList.length) out.sources = sourceList;
  if (includeConversation) {
    if (turn.error) out.error = String(turn.error);
    out.tools = tools.map(tool => {
      const o = {command: String(tool?.command ?? ''), summary: String(tool?.summary ?? ''), ok: !!tool?.ok};
      if (tool?.error) o.error = String(tool.error);
      return o;
    });
    out.progress = progress.map(p => ({agent: String(p?.agent ?? 'main'), message: String(p?.message ?? ''), at: p?.at ?? null}));
    out.steps = steps.map(s => ({title: String(s?.title ?? ''), ...(s?.failed ? {failed: true} : {})}));
    out.todos = todos.map(td => ({content: String(td?.content ?? td?.text ?? ''), status: String(td?.status ?? 'pending')}));
    if (turn.focus !== undefined) out.focus = turn.focus;
    out.user = String(turn.user ?? ''); out.reply = String(turn.reply ?? '');
    return out;
  }
  if (turn.error) out.error = errorShape(turn.error);
  out.tools = tools.map(tool => {
    const o = {command: String(tool?.command ?? ''), ok: !!tool?.ok};
    const summary = String(tool?.summary ?? '');
    if (summary) { o.summaryChars = summary.length; const p = extractPaths(summary); if (p.length) o.paths = p; }
    if (tool?.error) o.error = errorShape(tool.error);
    return o;
  });
  out.progress = progress.map(p => ({agent: String(p?.agent ?? 'main'), at: p?.at ?? null, chars: String(p?.message ?? '').length}));
  out.steps = steps.map(s => ({titleChars: String(s?.title ?? '').length, ...(s?.failed ? {failed: true} : {})}));
  out.todos = {count: todos.length, byStatus: countBy(todos.map(td => String(td?.status ?? 'pending')))};
  if (turn.focus !== undefined) out.focus = shapeValue(turn.focus, 'focus');
  return out;
}
// The Focus decision log for this conversation, minus the verbose-only
// params / result fields: those are tool arguments and result heads, which
// the report never carries. Without the conversation body each line also
// goes through shapeValue(): the decisions (event / decision / why —
// why stays as text but is redactString'd first, see SHAPE_KEEP_KEYS),
// the counts, the times, the command names and the path shapes stay, while
// detail.goal (the user's request, verbatim) and intent (Muse's progress
// sentence, verbatim) become lengths.
function focusLogSnapshot(sessionId, includeConversation) {
  try {
    const {FocusLog, logFile} = require('./focus-log');
    return FocusLog.readFile(logFile(sessionId)).map(e => {
      const o = {...e}; delete o.params; delete o.result; return o;
    }).map(e => (includeConversation ? e : shapeValue(e, null)));
  } catch { return []; }
}
// The saved Focus state holds the goal and the criterion texts — the
// user's request in their own words — so without the body it keeps only
// its shape too (statuses, ids, kinds, counts, lengths).
function focusStateSnapshot(sessionId, includeConversation) {
  let raw = null;
  try { raw = require('./sessions').loadFocus(sessionId); } catch { return null; }
  if (!raw || includeConversation) return raw;
  return shapeValue(raw, null);
}
// A crash record's file name embeds the time it was written (src/crash.js
// write(): the ISO stamp with ':' and '.' folded to '-'). That embedded
// time is the record's real age — the same rule crash.js's prune and
// crash-investigate's reader already use (audit waves 9 and 12): a copy or
// restore can move mtime anywhere, so ordering by mtime alone picked a
// name-oldest record as 'newest' while investigate listed another first.
// Names that carry no readable embedded time fall back to mtime.
function crashNameTimeMs(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})[-:](\d{2})[-:](\d{2})(?:[-.](\d{1,3}))?Z?)?/.exec(f);
  if (!m) return null;
  const [, y, mo, da, h = '0', mi = '0', s = '0', ms = '0'] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0')));
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(y) || d.getUTCMonth() !== Number(mo) - 1 || d.getUTCDate() !== Number(da) || d.getUTCHours() !== Number(h) || d.getUTCMinutes() !== Number(mi) || d.getUTCSeconds() !== Number(s)) return null;
  return t;
}
// Does a parsed file look like a crash record at all? src/crash.js's
// write() always sets an 'error' string (safeErrorText falls back to
// 'unknown error', never to a missing field) alongside the shaped
// 'state' object and the 'trail' array, and the watchdog's hang
// records in the same folder carry kind:'hang' instead of an error.
// A file with none of that is foreign to the folder, however it is
// dated (wave 16).
function isCrashReport(report) {
  if (typeof report.error === 'string') return true;
  if (report.kind === 'hang') return true;
  return !!report.state && typeof report.state === 'object' && !Array.isArray(report.state) && Array.isArray(report.trail);
}
// Only the newest crash record: older ones describe older builds. A record
// that cannot be read — a write cut off mid-crash is exactly when that
// happens — is skipped for the next valid one instead of voiding the
// whole section (audit wave 12), and a record whose contents are not an
// object (a bare string, a number) is not a crash record at all. Neither
// is an object that does not look like one (wave 16): a future-dated
// foreign file holding {} used to win on its embedded name time alone
// and shadow the real record under it, so the scan keeps going past
// non-records and finds nothing only when no file qualifies.
function latestCrash() {
  try {
    const crash = require('./crash');
    const d = crash.dir();
    const files = fs.readdirSync(d).filter(f => f.endsWith('.json'))
      .map(f => { let m = 0; try { m = fs.statSync(path.join(d, f)).mtimeMs; } catch {} return {f, m: crashNameTimeMs(f) ?? m}; })
      .sort((a, b) => b.m - a.m || (a.f < b.f ? 1 : -1));
    for (const {f, m} of files) {
      let report = null;
      try { report = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
      if (!report || typeof report !== 'object' || Array.isArray(report)) continue;
      if (!isCrashReport(report)) continue;
      return {file: f, at: new Date(m).toISOString(), report};
    }
    return null;
  } catch { return null; }
}
// One window, as the report may carry it. window-status itself is a
// shape-only record about ITS window, but it still holds that window's
// todo texts, its goal, its agent titles, its tool summaries and progress
// sentences — another conversation's words. So OTHER windows keep only
// their shape ALWAYS (kind / activity / connected / slot / counts /
// times — no session id, no cwd, no account, no texts), whatever the
// body choice says. This report's OWN window is the user's own current
// screen: it adds the account ordinal and the turn count, and only with
// the conversation body does it add its texts (todos, tool log,
// progress, goal); without the body its todos are a count by status and
// its goal a length, like everywhere else.
function windowShape(w, own, includeConversation, ordinalOf) {
  const todos = Array.isArray(w.todos) ? w.todos : [];
  const agents = Array.isArray(w.agents) ? w.agents : [];
  const shells = Array.isArray(w.shells) ? w.shells : [];
  const out = {
    kind: w.kind || 'window', pid: w.pid ?? null, version: w.version ?? null, mode: w.mode ?? null,
    activity: w.activity ?? null, connected: !!w.connected, slot: w.slot ?? null,
    startedAt: w.startedAt ?? null, updatedAt: w.updatedAt ?? null, turnStartedAt: w.turnStartedAt ?? null,
    queue: typeof w.queue === 'number' ? w.queue : 0,
    todos: {count: todos.length, byStatus: countBy(todos.map(td => String(td?.status ?? 'pending')))},
    agents: {count: agents.length}, shells: {count: shells.length, running: shells.filter(x => x?.running).length},
    toolLogCount: Array.isArray(w.toolLog) ? w.toolLog.length : 0,
    progressCount: Array.isArray(w.progress) ? w.progress.length : 0,
    eventsCount: Array.isArray(w.events) ? w.events.length : 0,
  };
  if (w.focus && typeof w.focus === 'object') out.focus = {status: w.focus.status ?? null, round: w.focus.round ?? null, maxRounds: w.focus.maxRounds ?? null, met: w.focus.met ?? null, total: w.focus.total ?? null, openCount: Array.isArray(w.focus.open) ? w.focus.open.length : null};
  if (!own) return out;
  out.account = w.account ? {index: ordinalOf(w.account.id)} : null;
  out.session = w.session ? {turns: w.session.turns ?? null} : null;
  if (w.goal) out.goalChars = String(w.goal).length;
  if (includeConversation) {
    if (w.goal) out.goal = String(w.goal);
    out.todos.items = todos.map(td => ({content: String(td?.content ?? td?.text ?? ''), status: String(td?.status ?? 'pending')}));
    out.toolLog = (Array.isArray(w.toolLog) ? w.toolLog : []).map(x => ({agent: String(x?.agent ?? 'main'), command: String(x?.command ?? ''), summary: String(x?.summary ?? ''), ok: !!x?.ok, ...(x?.error ? {error: String(x.error)} : {}), at: x?.at ?? null}));
    out.progress = (Array.isArray(w.progress) ? w.progress : []).map(p => ({agent: String(p?.agent ?? 'main'), message: String(p?.message ?? ''), at: p?.at ?? null}));
    if (w.running) out.running = {command: w.running.command ?? null, summary: w.running.summary ?? null, since: w.running.since ?? null};
    if (w.approval) out.approval = {command: w.approval.command ?? null, summary: w.approval.summary ?? null, since: w.approval.since ?? null};
  }
  return out;
}
// Window / server / terminal-slot state. Server discovery files carry a
// Bearer token: only the fields that are not the token are picked, one by
// one, and the server's session id (another conversation's identifier)
// stays home too. Instance lock files are counted by slot number; their
// names (a saved node id) stay home. The exec record's session id stays
// home for the same reason.
function stateSnapshot(accountList, ownSessionId, includeConversation) {
  const state = {windows: [], servers: [], instances: {count: 0, slots: []}, exec: null, usage: null};
  const ordinalOf = id => { const i = (accountList || []).findIndex(a => a.id === id); return i >= 0 ? i + 1 : null; };
  try {
    state.windows = require('./window-status').readAll().map(w => windowShape(w, !!(ownSessionId && w.session && w.session.id === ownSessionId), includeConversation, ordinalOf));
  } catch {}
  try {
    const discovery = require('./server/discovery');
    for (const [kind, file] of [['server', discovery.serverFile()], ['gui', discovery.guiFile()]]) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object') state.servers.push({kind, pid: raw.pid ?? null, port: raw.port ?? null, version: raw.version ?? null, startedAt: raw.startedAt ?? null});
      } catch {}
    }
  } catch {}
  try {
    const dir = path.join(require('./secure-store').DIR, 'instances');
    const slots = [];
    for (const name of fs.readdirSync(dir)) { const m = /^node-.+\.(\d+)\.lock$/.exec(name); if (m) slots.push(Number(m[1])); }
    state.instances = {count: slots.length, slots: slots.sort((a, b) => a - b)};
  } catch {}
  try {
    const execStatus = require('./exec-status');
    const file = execStatus.latest();
    if (file) {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.exec = {state: e.state ?? null, pid: e.pid ?? null, cwd: e.cwd ?? null, mode: e.mode ?? null,
        accountIndex: e.account ? ordinalOf(e.account) : null, startedAt: e.startedAt ?? null, updatedAt: e.updatedAt ?? null,
        tools: typeof e.tools === 'number' ? e.tools : null, exit: e.exit ?? null, durationMs: e.durationMs ?? null};
    }
  } catch {}
  // The usage store is read with peekSummary(), never summary() (wave 15):
  // summary() goes through load(), which MOVES a broken usage.json aside as
  // a side effect — building a report renamed the user's file and then
  // showed a clean "0 turns" over the wreckage. peek() never writes, and
  // its corrupt flag rides along so a broken store is reported as broken
  // (the same read `muser doctor` makes). A healthy store keeps exactly the
  // summary() shape.
  try {
    const u = require('./usage');
    const s = typeof u.peekSummary === 'function' ? u.peekSummary() : u.summary();
    if (s && typeof s === 'object' && !s.corrupt) { const {corrupt, exists, ...rest} = s; state.usage = rest; }
    else state.usage = s;
  } catch {}
  return state;
}

// The session counter (session.turns, counted as turns finish) and the
// number of turn records a report actually carries can honestly differ:
// a turn can be counted before its record lands, and the transcript
// itself retains only the newest 500 turns / 2 MB (src/sessions.js), so
// in a long conversation the oldest records are gone before export ever
// reads them. Wave 12: that difference used to be silent — the report
// showed the counter and a shorter turns[] with nothing saying the two
// disagree. turnsRecorded always states the carried count, and when it
// differs from the counter a turnsNote says so (with turnsMissing when
// records are short). buildReport re-syncs this after trimToFit, whose
// own drops can widen the gap.
function syncTurnsCount(report) {
  const s = report && typeof report === 'object' ? report.session : null;
  if (!s || typeof s !== 'object' || !Array.isArray(report.turns)) return report;
  const recorded = report.turns.length;
  const counter = typeof s.turns === 'number' ? s.turns : recorded;
  s.turnsRecorded = recorded;
  if (counter === recorded) { delete s.turnsNote; delete s.turnsMissing; return report; }
  s.turnsNote = 'turns count differs: session.turns is ' + counter + ' but this report carries ' + recorded + ' turn record(s)'
    + (counter > recorded
      ? '; ' + (counter - recorded) + ' counted turn(s) are not in this report (dropped by the transcript retention limit or the report size trim, or never recorded)'
      : '; the transcript carries ' + (recorded - counter) + ' more turn record(s) than the counter says');
  if (counter > recorded) s.turnsMissing = counter - recorded; else delete s.turnsMissing;
  return report;
}

// ------------------------------------------------------------------- build
// buildReport({session, includeConversation, uiMode, accountId, env,
// username, homeDir}) — session is a sessions.js entry ({id, cwd, created,
// updated, turns, account?}); everything else is read from the local stores.
// The result is already redacted: callers send or save it as-is.
function buildReport(opts = {}) {
  const session = opts.session;
  if (!session || !session.id) throw new Error('export: a session is required');
  const includeConversation = !!opts.includeConversation;
  const env = opts.env || process.env;
  const rOpts = {username: opts.username, homeDir: opts.homeDir};
  let accountList = [];
  try { accountList = require('./accounts').list(); } catch {}
  const turnsRaw = (() => { try { return require('./sessions').transcript(session.id); } catch { return []; } })();
  const turns = turnsRaw.map(turn => turnSnapshot(turn, includeConversation)).filter(Boolean);
  let uiMode = opts.uiMode || null;
  if (!uiMode) { try { uiMode = require('./settings').switchValue('fullscreen') ? 'fullscreen' : 'classic'; } catch { uiMode = 'unknown'; } }
  let language = null, locale = null;
  try { language = require('./i18n').lang(); } catch {}
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale || null; } catch {}
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    includesConversation: includeConversation,
    app: {
      name: 'muser', version: version(), node: process.version,
      platform: process.platform, osRelease: os.release(), osVersion: os.version(), arch: os.arch(),
      language, locale, uiMode, terminal: terminalInfo(env),
    },
    settings: settingsSnapshot(),
    accounts: accountsSnapshot(opts.accountId || session.account || null),
    session: {
      id: String(session.id), cwd: session.cwd || null,
      createdAt: session.created ? new Date(session.created).toISOString() : null,
      updatedAt: session.updated ? new Date(session.updated).toISOString() : null,
      turns: typeof session.turns === 'number' ? session.turns : turns.length,
      turnsRecorded: turns.length,
      // A broken sessions.json is said out loud (wave 15): the index being
      // unreadable must not read as "there are no conversations" — the flag
      // rides here, next to the one conversation this report does carry.
      ...(sessionsFileBroken() ? {corrupt: true} : {}),
    },
    turns,
    focusLog: focusLogSnapshot(session.id, includeConversation),
    focusState: focusStateSnapshot(session.id, includeConversation),
    crash: latestCrash(),
    state: stateSnapshot(accountList, session.id, includeConversation),
  };
  // The window's recent-events ring (stage 2): shape-only by construction
  // (key kinds, render times and sizes, changed state key names, error
  // names — never a typed character or a sentence), so it rides the same
  // with or without the conversation body. Only a live window has one;
  // the CLI passes another window's ring via opts.window instead.
  if (Array.isArray(opts.events)) report.events = opts.events;
  // One window's section, collected by `muser export --window`
  // (src/export-window.js): its shape, its events ring when it answered,
  // and its newest hang record when it did not.
  if (opts.window && typeof opts.window === 'object') report.window = opts.window;
  const clean = redact(report, rOpts);
  trimToFit(clean);
  // After trimming: turnsRecorded / turnsNote must describe the turns the
  // report NOW carries, not the ones it started with (see syncTurnsCount).
  syncTurnsCount(clean);
  // The note itself adds a few bytes; if it pushed a just-fitting report
  // back over the cap, trim once more and re-sync (the second sync only
  // changes the counts, not the note's size class).
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_JSON_BYTES) { trimToFit(clean); syncTurnsCount(clean); }
  return clean;
}
// A report must fit the receiver with room to spare. When the JSON is too
// big, the oldest turns and log lines go first (the newest are where the
// bug just happened) and the trim is said out loud in the report itself.
// Dropping whole entries cannot always do it: a single huge turn, or a
// section those loops never touch (events, crash, window), can hold the
// whole overflow by itself. So what is still too big afterwards has its
// largest strings cut (tail off, a marker left where the cut happened),
// then its largest arrays thinned from the oldest end, and only as a last
// resort a whole oversized section replaced by a note — until the JSON
// fits MAX_JSON_BYTES. Every cut is named in report.trimmed.
const TRIM_MARK = '…[trimmed]';
// The longest prefix of s that fits maxBytes as UTF-8, plus TRIM_MARK;
// '' when even the marker would not fit.
function truncateStringToBytes(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const markBytes = Buffer.byteLength(TRIM_MARK, 'utf8');
  if (maxBytes < markBytes + 1) return '';
  const budget = maxBytes - markBytes;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= budget) lo = mid; else hi = mid - 1;
  }
  // Never split a surrogate pair: a lone half would be escaped again by
  // JSON.stringify and change the size this just measured.
  if (lo > 0 && lo < s.length) { const c = s.charCodeAt(lo - 1); if (c >= 0xd800 && c <= 0xdbff) lo--; }
  return s.slice(0, lo) + TRIM_MARK;
}
// The largest string (wantString) or array anywhere in the report, as a
// slot that can be replaced in place, with the top-level section it lives
// in. The `trimmed` note itself is never a candidate: it is the record of
// the cutting, not cargo.
function largestSlot(report, wantString) {
  let best = null;
  const seen = new Set();
  const walk = (value, parent, key, top, depth) => {
    if (depth > 50 || value == null || top === 'trimmed') return;
    if (typeof value === 'string') {
      if (wantString && parent) {
        const bytes = Buffer.byteLength(value, 'utf8');
        if (!best || bytes > best.bytes) best = {parent, key, value, bytes, top};
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (!wantString && parent) {
        const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (!best || bytes > best.bytes) best = {parent, key, value, bytes, top};
      }
      value.forEach((v, i) => walk(v, value, i, top, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value)) walk(v, value, k, parent === null ? k : top, depth + 1);
  };
  walk(report, null, null, null, 0);
  return best;
}
function trimToFit(report) {
  const size = () => Buffer.byteLength(JSON.stringify(report), 'utf8');
  if (size() <= MAX_JSON_BYTES) return report;
  const trimmed = new Set(Array.isArray(report.trimmed) ? report.trimmed : []);
  const note = () => { if (trimmed.size) report.trimmed = [...trimmed]; };
  while (size() > MAX_JSON_BYTES && Array.isArray(report.focusLog) && report.focusLog.length > 10) { report.focusLog.splice(0, Math.ceil(report.focusLog.length / 4)); trimmed.add('focusLog'); note(); }
  while (size() > MAX_JSON_BYTES && Array.isArray(report.turns) && report.turns.length > 1) { report.turns.splice(0, Math.ceil(report.turns.length / 4)); trimmed.add('turns'); note(); }
  // One oversized string at a time, cut by the whole overflow (plus slack
  // for the marker and the note), so this normally converges in one pass.
  for (let guard = 0; size() > MAX_JSON_BYTES && guard < 100; guard++) {
    const slot = largestSlot(report, true);
    if (!slot || slot.bytes < 64) break;
    const target = Math.max(0, slot.bytes - (size() - MAX_JSON_BYTES) - 256);
    const cut = truncateStringToBytes(slot.value, target);
    if (cut === slot.value) break;
    slot.parent[slot.key] = cut;
    trimmed.add(slot.top || 'report');
    note();
  }
  // The bulk is many small items, not one big string: thin the largest
  // array from the oldest end, like the entry drops above.
  for (let guard = 0; size() > MAX_JSON_BYTES && guard < 200; guard++) {
    const slot = largestSlot(report, false);
    if (!slot || !slot.value.length) break;
    slot.value.splice(0, Math.max(1, Math.ceil(slot.value.length / 4)));
    trimmed.add(slot.top || 'report');
    note();
  }
  // Last resort: replace the largest remaining section with a plain note.
  // The bookkeeping keys are tiny and always stay.
  for (let guard = 0; size() > MAX_JSON_BYTES && guard < 50; guard++) {
    let key = null, bytes = 0;
    for (const [k, v] of Object.entries(report)) {
      if (k === 'trimmed' || k === 'schema' || k === 'generatedAt' || k === 'includesConversation') continue;
      const b = Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8');
      if (b > bytes) { bytes = b; key = k; }
    }
    if (!key) break;
    report[key] = '[trimmed: section too large to send]';
    trimmed.add(key);
    note();
  }
  note();
  return report;
}
// Per-section sizes for the confirmation screen: what will be sent, section
// by section, and the total. Bytes of the JSON as it will be gzipped.
function sectionSizes(report) {
  const sections = [];
  let total = 0;
  for (const [key, value] of Object.entries(report)) {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
    sections.push({key, bytes}); total += bytes;
  }
  return {sections, total: Buffer.byteLength(JSON.stringify(report), 'utf8')};
}
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  // Promote on the ROUNDED value, not the raw one: 1048575 is below 1 MB raw,
  // but (n / 1024).toFixed(1) is '1024.0', so it must read '1.00 MB'; likewise
  // 1 GB must read '1.00 GB', not '1024.00 MB'. GB is the largest unit shown.
  const units = ['KB', 'MB', 'GB'], digits = [1, 2, 2];
  let i = 0, text = (n / 1024).toFixed(digits[0]);
  while (i < units.length - 1 && Number(text) >= 1024) { i++; text = (n / 1024 ** (i + 1)).toFixed(digits[i]); }
  return text + ' ' + units[i];
}
const SECTION_LABELS = {
  schema: '形式の版', generatedAt: '作られた時刻', includesConversation: '会話の本文を含むか',
  app: '版・OS・端末', settings: '設定', accounts: 'アカウント', session: '会話の情報',
  turns: 'ターンの記録（道具・進み具合・使用量・Focus）', focusLog: 'Focus の判定ログ', focusState: 'Focus の状態',
  crash: '落ちたときの記録', state: '窓・Server・端末の枠の状態', trimmed: '切り捨ての注記', conversation: '会話の本文',
  events: '窓の直近の出来事（キー・描画・状態の切り替え）', window: '対象の窓の状態と出来事',
};
function sizeLines(report, extra) {
  const {t} = require('./i18n');
  const {sections, total} = sectionSizes(report);
  const lines = sections.map(s => '  ' + t(SECTION_LABELS[s.key] || s.key) + ': ' + formatBytes(s.bytes));
  if (extra && extra.conversationBytes) lines.push('  ' + t('会話の本文（含める場合）: {size}', {size: formatBytes(extra.conversationBytes)}));
  lines.push('  ' + t('合計: {total}', {total: formatBytes(total)}) + (extra && extra.conversationBytes ? t('（本文を含むと {total}）', {total: formatBytes(total + extra.conversationBytes)}) : ''));
  return lines;
}

// -------------------------------------------------------------------- send
class ExportSendError extends Error {
  constructor(status, serverError, {unconfirmed = false} = {}) {
    super(serverError || ('HTTP ' + status));
    this.name = 'ExportSendError'; this.status = status; this.serverError = serverError || null;
    // unconfirmed: the receiver answered 2xx but its reply could not be
    // read (cut off, broken, or no id in it), so the report may already
    // have arrived — failureMessage() must not call that a plain failure.
    this.unconfirmed = unconfirmed;
  }
}
// gzip the JSON and POST it. fetchImpl is injectable so tests never leave
// the machine: they pass a local server's URL via MUSER_REPORT_URL and the
// real fetch. The fetch carries a timeout (opts.timeoutMs, default
// SEND_TIMEOUT_MS, the AbortSignal.timeout idiom of src/update.js): a
// receiver that accepts the connection and then never answers used to
// hang the send forever. opts.signal wins when the caller has its own.
async function sendReport(report, opts = {}) {
  const url = opts.url || reportUrl(opts.env || process.env);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(report), 'utf8'));
  if (gz.length > MAX_GZIP_BYTES) throw new ExportSendError(413, 'report too large');
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : SEND_TIMEOUT_MS;
  const signal = opts.signal || AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {method: 'POST', headers: {'content-type': 'application/gzip', 'x-muser-version': version()}, body: gz, signal});
  } catch (e) { const err = new ExportSendError(0, sendErrorDetail(e)); err.cause = e; throw err; }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new ExportSendError(res.status, body?.error || null);
  if (!body || typeof body.id !== 'string' || !body.id) throw new ExportSendError(res.status, null, {unconfirmed: true});
  return {id: body.id, bytes: gz.length};
}
// The send failure's detail, with its cause chain folded in (wave 15):
// fetch's own message is only "fetch failed" — the reason a user can act on
// (ECONNREFUSED, ENOTFOUND, a certificate error, the timeout's abort) sits
// on e.cause, sometimes nested one more level. Walk the chain and name each
// code / message once, so the failure line says WHY the send failed.
function sendErrorDetail(e) {
  let detail = (e && e.message) || String(e);
  const seen = new Set();
  let c = e && e.cause;
  while (c && typeof c === 'object' && !seen.has(c)) {
    seen.add(c);
    const part = [c.code, c.message && c.message !== c.code ? c.message : null].filter(Boolean).join(' ');
    if (part && !detail.includes(part)) detail += ': ' + part;
    c = c.cause;
  }
  return detail;
}
// The failure as the user should hear it: the reason, and what to do next.
function failureMessage(err) {
  const {t} = require('./i18n');
  if (err instanceof ExportSendError) {
    if (err.unconfirmed) return t('応答が読めなかったため、届いたか確認できませんでした。再送すると重複することがあります。');
    if (err.status === 413) return t('レポートが大きすぎて送れませんでした（8MB を超えています）。');
    if (err.status === 429) return t('短い時間に送りすぎです。時間をおいてから、もう一度送ってください。');
    if (err.status === 507) return t('開発者側の保存場所がいっぱいです。時間をおいてから、もう一度送ってください。');
    if (err.status === 415) return t('送る形式が受け付けられませんでした（muser 側の不具合の可能性があります）。');
    if (err.status === 400) return t('レポートの形式が正しくないと返されました（muser 側の不具合の可能性があります）。');
    if (err.status === 500) return t('開発者側で保存に失敗しました。時間をおいてから、もう一度送ってください。');
    if (err.status === 0) {
      // Name the cause (wave 15): an error built elsewhere may carry the
      // socket reason only on its cause chain, not in serverError — dig it
      // out so the line names ECONNREFUSED and friends, in Japanese.
      let error = err.serverError || '';
      const seen = new Set();
      let c = err.cause;
      while (c && typeof c === 'object' && !seen.has(c)) {
        seen.add(c);
        if (c.code && !error.includes(c.code)) error = error ? error + '（' + c.code + '）' : String(c.code);
        c = c.cause;
      }
      return t('送り先に接続できませんでした: {error}', {error});
    }
    return t('送れませんでした（{status}）: {error}', {status: err.status, error: err.serverError || ''});
  }
  return t('送れませんでした: {error}', {error: err?.message || String(err)});
}
function sentMessage(id) {
  const {t} = require('./i18n');
  return t('送りました。ID: {id} — この ID を Discord などで開発者に伝えてください', {id});
}
// Save instead of sending: the JSON the user can open and read first.
function saveReport(report, opts = {}) {
  const dir = opts.dir || process.env.MUSER_EXPORT_DIR || path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(dir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const short = String(report.session?.id || 'session').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
  // The stamp is only second-precise and the short id is shared by every
  // save of one session, so two saves in the same second used to land on
  // the same name and the second silently overwrote the first. A random
  // suffix keeps each save its own file.
  const suffix = crypto.randomBytes(4).toString('hex');
  const file = path.join(dir, 'muser-report-' + stamp + '-' + short + '-' + suffix + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 1) + '\n');
  return file;
}

module.exports = {SCHEMA, DEFAULT_REPORT_URL, MAX_GZIP_BYTES, MAX_JSON_BYTES, SEND_TIMEOUT_MS, reportUrl, buildReport, redact, redactString, isSecretKey, terminalInfo, settingsSnapshot, accountsSnapshot, turnSnapshot, sectionSizes, formatBytes, sizeLines, SECTION_LABELS, sendReport, saveReport, failureMessage, sendErrorDetail, sentMessage, ExportSendError, trimToFit, syncTurnsCount, shapeValue, errorShape, extractPaths, windowShape};
