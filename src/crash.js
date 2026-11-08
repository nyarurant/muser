'use strict';
// When the TUI dies (an exception nothing caught), keep enough to find out why: versions, the
// terminal, the error, and the last state changes the screen went through. On 2026-11-01 a user's
// muser died with React's "Maximum update depth exceeded" and nothing was left to tell what had
// been happening. Only shapes are written (which state keys changed, counts, sizes), never what
// the user typed or what Muse said. Since stage 2 of /export the record also carries the
// stack's SHAPE (function / file / line / column via src/stack-format.js) — where it stopped,
// never the message the raw stack repeats or the values it walked past.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {stackOf} = require('./stack-format');

const dir = () => process.env.MUSER_CRASH_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser', 'crash');
const KEEP = 20;

const list = v => (Array.isArray(v) ? v : []);

// The error and the trail get the same treatment as the state: shapes, never content
// (audit #33). An exception's message can carry what the user typed, a command string
// or a file fragment (parse errors, tool errors), and its stack repeats that message
// plus local paths — so the stack is dropped whole and only the first line of the
// message is kept, with quoted spans and secret-shaped values stripped out of it.
// The secret shapes are the set src/export.js (redactString) and src/worklog.js
// (sanitizeText) strip on their paths (audit wave 5): a labelled secret loses its
// value in `key=value`, `key: value` and bare `key value` shapes alike, and a value
// in a known token shape (an Authorization / Bearer header, a JWT, sk-, ghp_…) is a
// secret with no label at all. Quoted spans and key=value alone used to be the whole
// treatment, so every other shape rode into the record — and from there into the
// crash section of an /export report.
// The same pass also hides what needs no label at all (audit wave 12): the
// user name inside an UNQUOTED Windows path (C:\Users\<name>\… — a quoted
// path already went with its quotes), an email address, and the
// user:password@ userinfo of a URL. src/export.js's redactString hides all
// three on the report path; the record file itself, the terminal print in
// boot.mjs and the /crash lines (which scrub through this module) did not.
// What remains (the error name and the message's own first-line wording, e.g.
// "Maximum update depth exceeded") is what identifies the crash.
const SECRET_LABEL = 'api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|cookie|credentials?|token';
const SECRET_SHAPE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
// A bare label followed by a value (`password hunter2…`): the value goes only when
// it looks like a secret (long, or longish with a digit), so prose like "token
// counts" survives — worklog's SECRET_BARE heuristic, unchanged.
const SECRET_BARE = /\b(token|password|passwd|secret|api[-_]?key|cookie|authorization|credential|bearer)\s+([^\s,;}"']+)/gi;
const bareValue = (m, k, v) => (v.length >= 12 || (v.length >= 8 && /\d/.test(v))) ? k + ' <redacted>' : m;
// One line of arbitrary text with secret-shaped values removed (the same
// replacements safeErrorText applies). Exported for surfaces that print more
// than the record does — e.g. the crash stack on the terminal (boot.mjs) —
// so they scrub values without dropping the diagnostic wording.
function scrubSecretTextLine(s) {
  return String(s ?? '')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '<quoted>')
    // Unquoted paths and addresses (wave 12): the user-name segment of a
    // Windows Users path (either slash), a /home/<name> segment, a URL's
    // userinfo (greedy to the LAST '@' before the path, so an address used
    // as the user name cannot leave its password behind), and an email
    // address. The email rule carries its preceding character so the
    // '<redacted>@host' a URL pass just produced is not re-read as an
    // address ('<' / ':' / '/' before the local part blocks the match).
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/:*?"<>|\s,;]+/gi, '$1<user>')
    .replace(/(\/home\/)[^/\s,;]+/gi, '$1<user>')
    .replace(/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]+@/g, '$1<redacted>@')
    .replace(/(^|[^\w.<>:\/-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1<email>')
    .replace(/(authorization\s*:\s*)(?:bearer\s+|basic\s+)?[^\s,;}"']+/gi, '$1<redacted>')
    .replace(new RegExp('((?:' + SECRET_LABEL + ')\\s*[:=]\\s*)[^\\s,;}"\']+', 'gi'), '$1<redacted>')
    .replace(/(<quoted>\s*[:=]\s*)[^\s,;}"']+/g, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(SECRET_SHAPE, '<redacted>')
    .replace(SECRET_BARE, bareValue)
    // Run-anchored (wave 13): the key always extends to the start of its
    // [\w.-] run in the output either way, and anchoring keeps a long
    // separator-free line at one scan instead of one scan per position
    // (the unbounded form took ~2 s on 50K plain letters).
    .replace(/(^|[^\w.-])([\w.-]+)=[^\s,;]+/g, '$1$2=<redacted>');
}
function safeErrorText(error) {
  let name = '', message = '';
  try {
    if (error && typeof error === 'object') { name = String(error.name || ''); message = String(error.message ?? error); }
    else if (error !== undefined && error !== null) message = String(error);
  } catch { return 'unknown error'; }
  if (!message) return 'unknown error';
  let first = scrubSecretTextLine(message.split(/\r?\n/)[0]).slice(0, 300);
  // Wave 16: the name used to be prepended AFTER that scrubbing, uncapped and
  // unscrubbed — an error name is as untrusted as the message (a library or a
  // wrapped error can put anything in it), so a name carrying a newline, a
  // user path or a secret shape landed verbatim in the record. It now goes
  // through the same scrubbing as the message, has newlines / control
  // characters stripped, and is capped at 80 chars (the message cap is 300).
  const safeName = scrubSecretTextLine(name.split(/\r?\n/)[0]).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80);
  if (safeName && safeName !== 'Error' && !first.startsWith(safeName)) first = safeName + ': ' + first;
  return first || 'unknown error';
}

// The terminal fields follow the same rule: presence and kind, never the raw
// value (audit wave 5). TERM and TERM_PROGRAM are operator-controlled text — a
// launching shell can put any string in them — so the record keeps only which
// known family each belongs to: '' when unset, the family name when recognised,
// 'other' when set to something unrecognised. Which terminal it was stays
// visible (that is the field's diagnostic point); what the variable literally
// said does not.
function termKind(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return '';
  for (const k of ['xterm', 'screen', 'tmux', 'rxvt', 'alacritty', 'wezterm', 'kitty', 'foot', 'linux', 'cygwin', 'ansi', 'vt100', 'dumb']) if (s.startsWith(k)) return k;
  return 'other';
}
function termProgramKind(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return '';
  if (s === 'vscode') return 'vscode';
  if (s.startsWith('iterm')) return 'iterm';
  if (s === 'apple_terminal') return 'apple-terminal';
  if (s.startsWith('wezterm')) return 'wezterm';
  if (s.startsWith('alacritty')) return 'alacritty';
  if (s.startsWith('windows terminal')) return 'windows-terminal';
  if (s.startsWith('tmux')) return 'tmux';
  if (s.startsWith('hyper')) return 'hyper';
  if (s.startsWith('tabby') || s.startsWith('terminus')) return 'tabby';
  return 'other';
}

// A trail entry's second element is, by construction (Controller.set / trace), the
// comma-joined NAMES of the state keys that changed — identifiers and commas only.
// Anything else in that slot is content that rode in by mistake: keep its slot and
// timestamp, drop the text.
function safeTrailWhat(v) {
  const s = String(v ?? '');
  return /^[\w,.-]*$/.test(s) && s.length <= 200 ? s : '<redacted>';
}

// One of shape()'s few string fields, reduced to a bounded string (Wave 16):
// a scalar rides as its string form capped at 120 chars, a non-scalar (an
// object, an array, a function) drops to its type label — its contents never
// ride. null / undefined ride as they were, so an absent field stays absent
// in the record exactly as before.
function boundedLabel(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.slice(0, 120);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v).slice(0, 120);
  return typeof v;
}

// The controller state, reduced to what does not carry content. Tolerant of odd shapes:
// the reporter runs while the app is already broken, so its inputs cannot be trusted.
// Wave 16: running.command, approval.kind, mode and agents[].state used to be
// copied verbatim — any type, any length — despite that premise, so a long or
// object-shaped value in one of those slots rode into the record whole. Each
// now goes through boundedLabel above; the field names and the record's
// overall shape stay as they were for existing readers.
function shape(s = {}) {
  if (!s || typeof s !== 'object') s = {};
  return {
    busy: !!s.busy, entries: list(s.entries).length, textLength: String(s.text || '').length,
    stream: s.stream ? {partialLength: String(s.stream.partial || '').length} : null,
    running: s.running ? {command: boundedLabel(s.running.call?.command), tailLines: list(s.running.tail).length} : null,
    approval: s.approval ? {kind: boundedLabel(s.approval.call?.kind), options: list(s.approval.options).length} : null,
    menu: !!s.menu, todos: list(s.todos).length, attachments: list(s.attachments).length,
    agents: list(s.agents).map(a => boundedLabel(a?.state)), shells: list(s.shells).filter(x => x?.running).length,
    mode: boundedLabel(s.mode), flash: !!s.flash, deviceOk: !!s.deviceOk,
  };
}

// A report's file name embeds the time it was written (write() below:
// the ISO timestamp with ':' and '.' folded to '-'). That embedded time
// is the report's real age: a copy or restore can move mtime anywhere,
// and ordering by mtime alone deleted the NEWEST report first whenever
// its mtime had been reset into the past (audit wave 9). Names that do
// not carry a readable embedded time fall back to mtime.
function embeddedTimeMs(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})[-:](\d{2})[-:](\d{2})(?:[-.](\d{1,3}))?Z?)?/.exec(f);
  if (!m) return null;
  const [, y, mo, da, h = '0', mi = '0', s = '0', ms = '0'] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0')));
  const d = new Date(t);
  // Date.UTC rolls overflows over (month 13 becomes next January): a name
  // whose fields do not round-trip is not an embedded time at all.
  if (d.getUTCFullYear() !== Number(y) || d.getUTCMonth() !== Number(mo) - 1 || d.getUTCDate() !== Number(da) || d.getUTCHours() !== Number(h) || d.getUTCMinutes() !== Number(mi) || d.getUTCSeconds() !== Number(s)) return null;
  return t;
}

// Prune old reports, keeping the newest KEEP. Best-effort: a pruning failure must not
// turn a written report into a failure. Only real files count towards KEEP:
// a DIRECTORY named *.json is not a report — counting it ate a KEEP slot
// on every prune while the unlink against it silently failed, so real
// reports were cut below KEEP forever (audit wave 9).
// Eviction order (audit wave 17, corrected): a report named with a
// future time (a clock set forward, a crafted name) sorted after every
// real report forever, so such files were immortal and a real report
// was pruned in their place. Clamping future times to now was not
// enough: a clamped future merely ties with the present, so it still
// sorted after — and survived ahead of — every real report stamped
// earlier in the day. Future-named files are therefore evicted BEFORE
// every non-future file, largest embedded time first among themselves;
// non-future files keep the usual order among themselves (oldest
// first, so the newest are kept). The report write() just wrote (keep)
// is never pruned by the prune its own write triggers.
function prune(d, keep) {
  try {
    const now = Date.now();
    const files = [];
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      let st = null; try { st = fs.statSync(path.join(d, f)); } catch { continue; }
      if (!st.isFile()) continue;
      const emb = embeddedTimeMs(f);
      const m = emb ?? st.mtimeMs;
      files.push({f, m, e: Math.min(m, now), future: emb !== null && emb > now});
    }
    // The array is in eviction order: futures first (largest embedded
    // time first), then non-futures by effective time, oldest first.
    files.sort((a, b) => {
      if (a.future !== b.future) return a.future ? -1 : 1;
      if (a.future) return b.m - a.m || (a.f < b.f ? -1 : 1);
      return a.e - b.e || a.m - b.m || (a.f < b.f ? -1 : 1);
    });
    let excess = files.length - KEEP;
    for (const {f} of files) {
      if (excess <= 0) break;
      if (f === keep) continue;
      try { fs.unlinkSync(path.join(d, f)); } catch {}
      excess--;
    }
  } catch {}
}

// Fully best-effort: the crash reporter must never throw. It is called from uncaughtException /
// unhandledRejection handlers, where a second throw would lose the original crash entirely.
// Returns the report path, or null when no report could be written.
function write(input) {
  try {
    const {version, error, state, trail, sessionId, scope} = input || {};
    const d = dir();
    fs.mkdirSync(d, {recursive: true});
    // The timestamp alone (millisecond precision) collided when several windows
    // crashed in the same millisecond — exactly the shared-cause crash this
    // reporter exists for — and the later write replaced the earlier report
    // (c11 #11). Pid plus a random suffix keep every report.
    const file = path.join(d, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + require('node:crypto').randomBytes(4).toString('hex') + '.json');
    let safeState; try { safeState = shape(state); } catch { safeState = shape({}); }
    let safeTrail = [];
    try { safeTrail = list(trail).map(e => (Array.isArray(e) ? [e[0], safeTrailWhat(e[1])] : [null, safeTrailWhat(e)])); } catch { safeTrail = []; }
    let errorText; try { errorText = safeErrorText(error); } catch { errorText = 'unknown error'; }
    let stack = [];
    try { let un = ''; try { un = os.userInfo().username || ''; } catch {} stack = stackOf(error, {username: un}); } catch { stack = []; }
    const report = {
      muser: version, node: process.version, windows: os.release(),
      terminal: {columns: process.stdout.columns, rows: process.stdout.rows, TERM: termKind(process.env.TERM), TERM_PROGRAM: termProgramKind(process.env.TERM_PROGRAM), windowsTerminal: !!process.env.WT_SESSION, vscode: process.env.TERM_PROGRAM === 'vscode', conEmu: !!process.env.ConEmuPID},
      error: errorText,
      ...(stack.length ? {stack} : {}),
      state: safeState,
      trail: safeTrail,
    };
    // The server's crash handler (src/server/server-crash.js) records which
    // conversation the error belonged to, if any, and whether it took only
    // that conversation down ('session') or the whole process ('fatal').
    if (typeof sessionId === 'string' && sessionId) report.sessionId = sessionId;
    if (typeof scope === 'string' && scope) report.scope = scope;
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    prune(d, path.basename(file));
    return file;
  } catch { return null; }
}

module.exports = {write, shape, dir, safeErrorText, safeTrailWhat, scrubSecretTextLine};
