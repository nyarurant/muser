'use strict';
// Crash investigation (docs/design/new-features.md section 9): read-only.
// When an app dies, several independent records remain on this PC — the
// Windows event log, Windows Error Reporting, Node diagnostic reports and
// muser's own crash records (src/crash.js). None of them says what changed
// just before the fall; the work log (section 1) does. This module reads all
// of them, lines the falls up with the edits that came before each one, and
// formats the result for the screen (muser crash / /crash). It writes
// nothing, sends nothing anywhere, and never reads a dump file (large, and
// it can hold secrets): a dump is named by location only.
//
// Tolerance is the point: every record is read by picking the fields this
// module knows and ignoring the rest, so a record whose shape grows new
// fields (the crash writer is being extended on another branch) still
// reads. A source that cannot be read is reported as unread, never fatal.
//
// Secrets: the only free text carried into a report is scrubbed the same
// way src/crash.js scrubs its own records (first line only, quoted spans
// and key=value values removed). Work-log diffs and blob contents are never
// read — an edit contributes its path, its agent and its time, nothing
// else — and an edit to a sensitive path (tools.js isSensitivePath) is
// shown as a placeholder, never by name.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {t} = require('./i18n');
const crashStore = require('./crash');

const DEFAULT_HOURS = 1;      // the event window (design section 9)
const DEFAULT_BEFORE_MIN = 30; // how far before a fall edits are lined up
const MAX_CRASHES = 20;
const MAX_EVENTS = 50;
const MERGE_MS = 10000; // an Application Error 1000 and its WER 1001 are one fall

const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
// The work log's folder (design section 1). The writer lives on another
// branch; this reader assumes exactly the designed shape and can be pointed
// elsewhere by the same kind of override src/crash.js accepts.
const worklogDir = () => process.env.MUSER_WORKLOG_DIR || path.join(localAppData(), 'muser', 'worklog');
const werDirs = () => ['ReportArchive', 'ReportQueue'].map(d => path.join(localAppData(), 'Microsoft', 'Windows', 'WER', d));

// One line of outside text, made safe to show: control characters out,
// whitespace folded, and (through crash.js) quoted spans and key=value
// values removed, first line only.
function scrub(v, max = 200) {
  // crash.js first: it keeps the first line only, and the line break has to
  // still be there for it to cut on. Control characters are stripped after.
  if (!String(v ?? '').trim()) return '';
  return crashStore.safeErrorText({message: String(v)})
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function plain(v, max = 200) {
  return String(v ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

let _isSensitive = null;
function isSensitive(p) {
  if (!p) return false;
  try {
    _isSensitive ??= require('./tools').isSensitivePath;
    return !!_isSensitive(p);
  } catch {
    const s = String(p);
    return /[\\/](\.ssh|\.aws|\.gnupg)[\\/]/i.test(s) || /(^|[\\/])(\.env[^\\/]*|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*(credential|secret)[^\\/]*|[^\\/]*\.(pem|key|enc|p12|pfx))$/i.test(s);
  }
}

// 'c0000005', '0xC0000005' and '-1073741819' all name the same code.
function normalizeCode(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return '0x' + s.slice(2).toLowerCase();
  if (/^[0-9a-f]{4,8}$/i.test(s) && /[a-f]/i.test(s)) return '0x' + s.toLowerCase();
  if (/^-?\d+$/.test(s)) return '0x' + (Number(s) >>> 0).toString(16).padStart(8, '0');
  if (/^[0-9a-f]{8}$/i.test(s)) return '0x' + s.toLowerCase();
  return null;
}

// ---- Windows event log -----------------------------------------------------
// Get-WinEvent over the Application log for the three ids that mean an
// application died: 1000 (Application Error), 1001 (Windows Error
// Reporting), 1026 (.NET Runtime). The window travels by environment
// variable, so nothing the caller typed is ever part of the script text.
const EVENT_SCRIPT = [
  // PowerShell 5.1 writes redirected output in the OEM code page (932 here);
  // its trail bytes can be a backslash, which corrupts the JSON on the way
  // to Node's UTF-8 read. UTF-8 out, always (verified on this PC).
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$start = [datetime]::Parse($env:MUSER_CRASH_SINCE)',
  '$end = [datetime]::Parse($env:MUSER_CRASH_UNTIL)',
  "$evs = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001,1026; StartTime=$start; EndTime=$end} -MaxEvents " + MAX_EVENTS,
  // Get-WinEvent records an error even for 'no matching events', and a
  // suppressed error still leaves powershell's exit code at 1 when nothing
  // after it succeeds (verified on this PC) — so 'no match' is answered
  // here, and anything else is a real failure with its message on stderr.
  "if (-not $evs) { $e = $Error[0]; if ($e -and $e.FullyQualifiedErrorId -notlike '*NoMatchingEventsFound*') { [Console]::Error.WriteLine([string]$e.Exception.Message); exit 1 } }",
  'if ($evs) { @($evs | ForEach-Object { [PSCustomObject]@{ time = $_.TimeCreated.ToUniversalTime().ToString(\'o\'); id = $_.Id; provider = $_.ProviderName; props = @($_.Properties | ForEach-Object { [string]$_.Value }); message = [string]$_.Message } }) | ConvertTo-Json -Compress -Depth 4 }',
].join('\n');

function runEvents({since, until}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', EVENT_SCRIPT], {
      env: {...process.env, MUSER_CRASH_SINCE: new Date(since).toISOString(), MUSER_CRASH_UNTIL: new Date(until).toISOString()},
      timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      // The script puts its own one-line reason on stderr; execFile's error
      // message would carry the whole command line instead.
      if (err && !stdout) reject(new Error(plain(stderr, 300) || 'Get-WinEvent failed'));
      else resolve(stdout || '');
    });
  });
}

function msgMatch(message, patterns) {
  for (const re of patterns) { const m = re.exec(message); if (m) return m[1].trim(); }
  return null;
}
// Message fields are separated by '、' as often as by spaces, so a value
// runs to the first separator, never through it.
const MSG_APP = [/障害のあるアプリケーション名[:：]\s*([^、,，\s]+)/, /Faulting application name:\s*([^、,，\s]+)/, /アプリケーション[:：]\s*([^、,，\s]+)/, /^Application:\s*([^、,，\s]+)/m];
const MSG_MODULE = [/障害のあるモジュール名[:：]\s*([^、,，\s]+)/, /Faulting module name:\s*([^、,，\s]+)/, /障害モジュール名[:：]\s*([^、,，\s]+)/];
const MSG_CODE = [/例外コード[:：]\s*(0x[0-9a-fA-F]+)/, /Exception code:\s*(0x[0-9a-fA-F]+)/];

// The JSON runEvents prints (also what the tests feed in): an array — or a
// single object, which is what ConvertTo-Json makes of one event.
function parseEventLogJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  let raw = JSON.parse(s);
  if (!Array.isArray(raw)) raw = [raw];
  const out = [];
  for (const rec of raw) {
    if (!rec || typeof rec !== 'object') continue;
    const time = Date.parse(rec.time);
    if (!Number.isFinite(time)) continue;
    const props = (Array.isArray(rec.props) ? rec.props : []).map(v => plain(v, 300));
    const message = String(rec.message ?? '');
    let app = null, module = null, code = null, pid = null;
    if (rec.id === 1000) {
      app = props[0] || null;
      module = props[3] || null;
      code = normalizeCode(props[6]);
      const p = Number(props[8]);
      if (Number.isFinite(p) && p > 0) pid = p;
    }
    if (rec.id === 1001) {
      // A WER report names the application in its problem signature (P1),
      // not in the faulting-application phrasing of a 1000. Non-application
      // reports (LiveKernelEvent and friends) have no application at all:
      // the event name is the honest label, and a kernel report's first
      // property carries the faulting driver's image name.
      const p1 = msgMatch(message, [/\bP1[:：]\s*([^、,，\s]+)/]);
      if (p1 && /\.(exe|dll)$/i.test(p1)) app = app || p1; // a kernel report's P1 is a code, not a file
      const eventName = msgMatch(message, [/イベント名[:：]\s*([^、,，\s]+)/, /Event Name:\s*([^、,，\s]+)/]);
      if (eventName === 'LiveKernelEvent') {
        const im = /IMAGE_([\w.-]+\.(?:sys|dll|exe))/i.exec(props[0] || '');
        if (im) module = module || im[1];
      }
      if (!app && eventName) app = eventName;
      // The signature's P4 / P7 are the module and the exception code, the
      // same slots Report.wer calls Sig[3] / Sig[6].
      const p4 = msgMatch(message, [/\bP4[:：]\s*([^、,，\s]+)/]);
      if (p4 && /\.(exe|dll|sys)$/i.test(p4)) module = module || p4;
      code = code || normalizeCode(msgMatch(message, [/\bP7[:：]\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]{8})/]));
    }
    app = app || msgMatch(message, MSG_APP);
    module = module || msgMatch(message, MSG_MODULE);
    code = code || normalizeCode(msgMatch(message, MSG_CODE));
    const detail = {id: rec.id, pid};
    if (rec.id === 1026) {
      const ex = /([A-Za-z][\w.]*Exception)/.exec(message);
      if (ex) detail.exceptionType = ex[1];
    }
    out.push({kind: 'event', time, app: app || '(不明)', code, module, detail});
  }
  return out;
}

// ---- Windows Error Reporting ----------------------------------------------
// A Report.wer is a key=value text (UTF-16 on disk). The Sig[n] values are
// read by index — 0 the application, 3 the module that faulted, 6 the
// exception code — because their names are localised. Anything else in the
// file (loaded modules, paths, friendly names) is not carried out.
function parseWerReport(text) {
  const kv = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const sig = n => kv.get('Sig[' + n + '].Value') || null;
  let time = null;
  const ft = Number(kv.get('EventTime'));
  if (Number.isFinite(ft) && ft > 0) time = Math.round((ft - 116444736000000000) / 10000);
  return {
    app: plain(sig(0) || kv.get('AppName') || '', 120) || null,
    module: plain(sig(3) || '', 120) || null,
    code: normalizeCode(sig(6)),
    time,
    eventType: plain(kv.get('EventType') || '', 60) || null,
  };
}

function readWerReports({dirs, since, until}) {
  const out = [];
  for (const dir of dirs) {
    let subs = [];
    try { subs = fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)); } catch { continue; }
    for (const sub of subs) {
      let names = [];
      try { names = fs.readdirSync(sub); } catch { continue; }
      const werName = names.find(n => /^Report\.wer$/i.test(n));
      if (!werName) continue;
      const file = path.join(sub, werName);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtime < since - 7 * 86400000 || mtime > until + 7 * 86400000) continue; // the time inside rules; this only skips the far-off
      let parsed = null;
      try {
        const buf = fs.readFileSync(file);
        parsed = parseWerReport(buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8'));
      } catch { continue; }
      const time = parsed.time ?? mtime;
      if (time < since || time > until) continue;
      const dumps = names.filter(n => /\.(dmp|mdmp|hdmp)$/i.test(n)).map(n => path.join(sub, n));
      out.push({kind: 'wer', time, app: parsed.app || '(不明)', code: parsed.code, module: parsed.module, detail: {dir: sub, dumps}});
    }
  }
  return out;
}

// ---- Node diagnostic reports ------------------------------------------------
// Written by --report-on-fatalerror as report.<date>.<time>.<pid>.0.<n>.json
// next to the process (its cwd) — only the header and the JavaScript error's
// first line are read; the stacks stay in the file.
const NODE_REPORT_NAME = /^report\.\d{8}\.\d{6}\.\d+\.0\.\d+\.json$/i;
function readNodeReports({dirs, since, until}) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!NODE_REPORT_NAME.test(name)) continue;
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since || st.mtimeMs > until || st.size > 4 * 1024 * 1024) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const header = (j && typeof j === 'object' && j.header) || {};
      let time = Date.parse(header.dumpEventTime || '');
      if (!Number.isFinite(time)) time = st.mtimeMs;
      if (time < since || time > until) continue;
      const js = (j && j.javascriptStack) || {};
      out.push({
        kind: 'node', time, app: 'node.exe', code: null, module: null,
        detail: {file, trigger: plain(header.trigger || '', 80) || null, error: js.message ? scrub(js.message) : null, pid: header.processId || null},
      });
    }
  }
  return out;
}

// ---- muser's own crash records ----------------------------------------------
// src/crash.js writes one JSON per fall; the fall's time is the file name
// (an ISO stamp with ':' and '.' flattened to '-'), the file's mtime is the
// fallback. Known fields are picked; anything new a future writer adds is
// ignored here.
function crashFileTime(name, mtime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (m) { const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '.' + m[7] + 'Z'); if (Number.isFinite(t)) return t; }
  return mtime;
}
function readMuserCrashes({dir, since, until}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const time = crashFileTime(name, st.mtimeMs);
    if (time < since || time > until) continue;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    out.push({
      kind: 'muser', time, app: 'muser', code: null, module: null,
      detail: {file, error: j.error ? scrub(j.error) : null, version: plain(j.muser || '', 40) || null, scope: plain(j.scope || '', 40) || null, recordKind: plain(j.kind || '', 40) || null, sessionId: typeof j.sessionId === 'string' ? j.sessionId : null},
    });
  }
  return out;
}

// ---- the work log (reading side only) ---------------------------------------
// The shape src/worklog.js writes (design section 1): one JSONL file per
// conversation at worklog/<conversation id>.jsonl, one event per line
// ({v, at, session, event, ...}); an edit carries its path, the before/after
// hashes, the changed line ranges ([{start, end}]) and a diff capped at
// 20 KB, with the full before-text in worklog/blobs/<hash>. The discrimi-
// nator is `event` (`type` / `kind` are still accepted, for older logs).
// This reader is deliberately small and separate: it keeps only edit
// events, and of those only the time, the conversation, the path and a
// function name when one can be read off the diff (its hunk header, or —
// for the writer's own line diffs — the nearest definition line above
// the first change). A real edit event carries no agent, so that field
// stays null on real logs.
// The diff itself and the blobs are never read into a report (they can
// hold anything).
function eventTime(ev) {
  const v = ev.time ?? ev.at ?? ev.ts ?? ev.timestamp;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  return null;
}
function funcFromDiff(diff) {
  if (typeof diff !== 'string') return null;
  const m = /@@[^@\n]*@@[ \t]*([^\n]*)/.exec(diff); // the context sits on the hunk's own line only
  if (m) {
    const s = m[1].trim().replace(/[{;]\s*$/, '').trim();
    if (s) return plain(s, 80);
  }
  // The work log's own diffs are line diffs (' '/'-'/'+' prefixes) with no
  // @@ header at all, so the hunk-header read above never fires on real
  // logs (features-debug #38). Fall back to walking back from the first
  // changed line to the nearest definition-looking line.
  const lines = diff.split('\n');
  let firstChange = lines.findIndex(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
  if (firstChange < 0) firstChange = lines.length - 1;
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with']);
  for (let i = firstChange; i >= 0; i--) {
    const s = lines[i].slice(1).trim();
    let mm = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(s);
    if (mm) return plain(mm[1] + '()', 80);
    mm = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(s);
    if (mm) return plain(mm[1] + '()', 80);
    mm = /^class\s+([A-Za-z_$][\w$]*)/.exec(s);
    if (mm) return plain(mm[1], 80);
    mm = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(s);
    if (mm && !KEYWORDS.has(mm[1])) return plain(mm[1] + '()', 80);
  }
  return null;
}
function readWorklogFile(file, conversation) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object' || (ev.event ?? ev.type ?? ev.kind) !== 'edit') continue;
    const time = eventTime(ev);
    if (time === null) continue;
    const rawPath = typeof ev.path === 'string' ? ev.path : typeof ev.file === 'string' ? ev.file : null;
    const sensitive = isSensitive(rawPath);
    out.push({
      time, conversation,
      agent: plain(ev.agent || ev.tag || '', 40) || null,
      path: sensitive ? null : rawPath ? plain(rawPath, 300) : null,
      sensitive,
      func: plain(ev.func || ev.symbol || '', 80) || funcFromDiff(ev.diff),
      ranges: Array.isArray(ev.ranges) ? ev.ranges.slice(0, 4) : null,
    });
  }
  return out;
}
function readWorklogEdits({dir, since, until}) {
  const edits = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return {edits, ok: true}; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    for (const e of readWorklogFile(path.join(dir, name), name.replace(/\.jsonl$/, '')))
      if (e.time >= since && e.time <= until) edits.push(e);
  }
  edits.sort((a, b) => b.time - a.time);
  return {edits, ok: true};
}

// ---- lining the records up ---------------------------------------------------
// The same fall is usually recorded twice (an Application Error event and
// its WER report seconds later). Falls within MERGE_MS of each other for
// the same application, with no conflicting exception code, are one fall:
// the richer record leads, the other is named in `kinds`.
//
// A fall's fingerprint: how it fell and what it said — the fields that make
// two records the SAME fall rather than two falls that merely happened
// close together. muser's own records all share app 'muser' and carry no
// exception code, so time + app alone used to squash every fall inside the
// window into the first one, whatever its scope (startup / turn / session /
// fatal), its record kind (a hang is not a crash) or its error (audit wave
// 12). A pair involving a muser record merges only on an exact fingerprint
// match; records from the Windows sources keep the looser twin rule (an
// event and its WER report carry complementary fields), except that a
// field BOTH sides carry — the error text, a .NET exception type — still
// blocks the merge when it conflicts.
function fallFingerprint(c) {
  const d = c.detail || {};
  return [d.scope || '', d.recordKind || '', d.error || '', d.sessionId || ''].join('\n');
}
function fingerprintConflict(a, b) {
  const da = a.detail || {}, db = b.detail || {};
  if (da.error && db.error && da.error !== db.error) return true;
  if (da.exceptionType && db.exceptionType && da.exceptionType !== db.exceptionType) return true;
  return false;
}
function sameFall(prev, c) {
  if (c.kind === 'muser' || prev.kind === 'muser') return fallFingerprint(prev) === fallFingerprint(c);
  return !fingerprintConflict(prev, c);
}
function mergeCrashes(list) {
  const sorted = [...list].sort((a, b) => a.time - b.time);
  const out = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.time - prev.time <= MERGE_MS && String(c.app).toLowerCase() === String(prev.app).toLowerCase() && (!c.code || !prev.code || c.code === prev.code) && sameFall(prev, c)) {
      if (!prev.code && c.code) prev.code = c.code;
      if (!prev.module && c.module) prev.module = c.module;
      // A WER twin still contributes its report folder and dump locations.
      if (c.kind === 'wer') {
        prev.detail = {...prev.detail, werDir: c.detail.dir, dumps: [...(prev.detail.dumps || []), ...(c.detail.dumps || [])]};
      }
      if (!prev.kinds.includes(c.kind)) prev.kinds.push(c.kind);
      continue;
    }
    out.push({...c, kinds: [c.kind]});
  }
  return out.sort((a, b) => b.time - a.time).slice(0, MAX_CRASHES);
}

function correlate(crashes, edits, beforeMs) {
  for (const c of crashes)
    c.edits = edits.filter(e => e.time <= c.time && e.time >= c.time - beforeMs).slice(0, 20);
  return crashes;
}

function matchProcess(c, filter) {
  if (!filter) return true;
  const f = String(filter).toLowerCase();
  return String(c.app || '').toLowerCase().includes(f);
}

// Read everything and line it up. Never throws for a broken source: the
// source is marked in report.sources and the rest still answers.
async function investigate(options = {}) {
  const now = options.now ?? Date.now();
  const hours = Number.isFinite(options.hours) && options.hours > 0 ? options.hours : DEFAULT_HOURS;
  const beforeMin = Number.isFinite(options.beforeMin) && options.beforeMin >= 0 ? options.beforeMin : DEFAULT_BEFORE_MIN;
  const since = now - hours * 3600000, until = now + 60000;
  const sources = {};
  let crashes = [];
  try {
    const text = options.eventsText !== undefined ? options.eventsText : await (options.runEvents || runEvents)({since, until});
    // Get-WinEvent is already asked for this window; the filter is repeated
    // here so an injected or replayed log is held to the same window.
    const events = parseEventLogJson(text).filter(e => e.time >= since && e.time <= until);
    crashes.push(...events);
    sources.events = {ok: true, count: events.length};
  } catch (e) { sources.events = {ok: false, error: scrub(e && e.message || e)}; }
  const collect = (key, fn) => {
    try { const items = fn(); crashes.push(...items); sources[key] = {ok: true, count: items.length}; }
    catch (e) { sources[key] = {ok: false, error: scrub(e && e.message || e)}; }
  };
  collect('wer', () => readWerReports({dirs: options.werDirs || werDirs(), since, until}));
  collect('node', () => readNodeReports({dirs: options.nodeReportDirs || [options.cwd || process.cwd(), path.join(localAppData(), 'muser')], since, until}));
  collect('muser', () => readMuserCrashes({dir: options.crashDir || crashStore.dir(), since, until}));
  crashes = mergeCrashes(crashes.filter(c => matchProcess(c, options.process)));
  let edits = [];
  try {
    const w = readWorklogEdits({dir: options.worklogDir || worklogDir(), since: since - beforeMin * 60000, until});
    edits = w.edits;
    sources.worklog = {ok: true, count: edits.length};
  } catch (e) { sources.worklog = {ok: false, error: scrub(e && e.message || e)}; }
  correlate(crashes, edits, beforeMin * 60000);
  return {generatedAt: now, now, windowHours: hours, beforeMin, process: options.process || null, crashes, sources};
}

// ---- showing it ---------------------------------------------------------------
function formatTime(ms, now) {
  const d = new Date(ms), n = new Date(now);
  const pad = v => String(v).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
function sourceLabels() {
  return {events: t('イベントログ'), wer: t('Windows Error Reporting'), node: t('Node 診断レポート'), muser: t('muser のクラッシュ記録'), worklog: t('作業ログ')};
}

function formatLines(report) {
  const labels = sourceLabels();
  const lines = [];
  const crashes = report.crashes || [];
  if (!crashes.length) lines.push(t('直近 {hours} 時間に、アプリの異常終了は見つかりませんでした。', {hours: report.windowHours}));
  else {
    lines.push(t('直近 {hours} 時間の落下: {n} 件', {hours: report.windowHours, n: crashes.length}));
    for (const c of crashes.slice(0, 10)) {
      const time = formatTime(c.time, report.now);
      if (c.code && c.module) lines.push(t('{time}、{app} が {code} で落ちました（モジュール {module}）', {time, app: c.app, code: c.code, module: c.module}));
      else if (c.code) lines.push(t('{time}、{app} が {code} で落ちました', {time, app: c.app, code: c.code}));
      else if (c.module) lines.push(t('{time}、{app} が落ちました（モジュール {module}）', {time, app: c.app, module: c.module}));
      else lines.push(t('{time}、{app} が落ちました', {time, app: c.app}));
      const d = c.detail || {};
      if (c.kind === 'event') lines.push(d.pid ? t('  イベントログ（ID {id}）、プロセス ID {pid}', {id: d.id, pid: d.pid}) : t('  イベントログ（ID {id}）', {id: d.id}));
      if (c.kind === 'wer') lines.push(t('  Windows Error Reporting の報告: {dir}', {dir: d.dir}));
      else if (d.werDir) lines.push(t('  Windows Error Reporting の報告: {dir}', {dir: d.werDir}));
      for (const dump of d.dumps || []) lines.push(t('  ダンプ（読みません）: {file}', {file: dump}));
      if (c.kind === 'node') {
        lines.push(t('  Node 診断レポート: {file}', {file: d.file}));
        if (d.trigger) lines.push(t('  きっかけ: {trigger}', {trigger: d.trigger}));
      }
      if (c.kind === 'muser') lines.push(t('  muser の記録: {file}', {file: d.file}));
      if (d.error) lines.push(t('  エラー: {error}', {error: d.error}));
      // How the fall happened and which conversation it took (audit wave 12):
      // the reader has carried scope / sessionId in detail all along, but the
      // guidance never showed them, so a startup fall, a turn fall and a
      // server session fall read exactly alike.
      if (d.scope) lines.push(t('  落ち方: {scope}', {scope: d.scope}));
      if (d.sessionId) lines.push(t('  セッション: {session}', {session: d.sessionId}));
      if (d.exceptionType) lines.push(t('  エラー: {error}', {error: d.exceptionType}));
      if ((c.kinds || []).length > 1) lines.push(t('  同じ落下が {list} にもあります', {list: c.kinds.map(k => labels[k] || k).join('・')}));
      const edits = c.edits || [];
      for (const e of edits.slice(0, 5)) {
        const diffMin = Math.round((c.time - e.time) / 60000);
        const when = diffMin <= 0 ? t('直前') : t('{min} 分前', {min: diffMin});
        const target = e.sensitive ? t('（機密ファイル）') : (e.path || '') + (e.func ? ' (' + e.func + ')' : '');
        lines.push(e.agent ? t('  その{when}、{agent} が {target} を変更', {when, agent: e.agent, target}) : t('  その{when}、{target} を変更', {when, target}));
      }
      if (edits.length > 5) lines.push(t('  … ほか {n} 件の変更', {n: edits.length - 5}));
    }
    if (crashes.length > 10) lines.push(t('  … ほか {n} 件の落下', {n: crashes.length - 10}));
  }
  for (const [key, s] of Object.entries(report.sources || {}))
    if (s && s.ok === false) lines.push(t('  ※ {source} は読めませんでした', {source: labels[key] || key}));
  if (report.process) lines.push(t('  プロセス名 {name} で絞り込みました', {name: report.process}));
  return lines;
}

const formatText = report => formatLines(report).join('\n');

// What /crash hands to Muse: the same lines, with the ask from the design —
// check whether the change before the fall is the cause, and if not, work
// from the module, the code and the reports' locations. Dumps are locations
// only, here as everywhere.
function formatPrompt(report) {
  return t('アプリのクラッシュを調べました。次の記録と、落ちる直前の変更を突き合わせて、この変更が原因か確かめてください。原因でなければ、落ちたモジュールや例外コード、報告の場所を手がかりに調べてください。ダンプファイルは読まないでください（場所だけ示しています）。') + '\n\n' + formatLines(report).join('\n');
}

module.exports = {
  investigate, parseEventLogJson, parseWerReport, readWerReports, readNodeReports, readMuserCrashes,
  readWorklogFile, readWorklogEdits, mergeCrashes, correlate, matchProcess, normalizeCode,
  formatLines, formatText, formatPrompt, formatTime, worklogDir, werDirs,
  DEFAULTS: {hours: DEFAULT_HOURS, beforeMin: DEFAULT_BEFORE_MIN},
};