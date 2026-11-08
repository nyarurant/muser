'use strict';
// The state of one `muser exec` run in a JSON file, for the agent that launched it (Codex, Claude
// Code, a script) to read while it runs and after: running → done (exit 0 / 2 / 1) or interrupted
// (130). Readers poll the file; it is replaced whole (temp file + rename, retried while a reader
// has it open), so a read never sees half a file. A run that dies without finishing leaves
// "running" with a pid that is no longer alive and an updatedAt that stopped moving (heartbeat).
//
//   {"version":1,"state":"running","pid":…,"cwd":…,"mode":…,"prompt":…,"session":…,"account":…,
//    "startedAt":…,"updatedAt":…,"tools":3,"last":"code.read src/agent.js","focus":{…},
//    "todos":[{content,status}],"progress":[{agent,message,at}],"steps":[{title,detail,at}],
//    "toolLog":[{agent,command,summary,ok,error,at}],"log":["· Muse に接続しています…", …]}
//   {"version":1,"state":"done","exit":2,"ok":true,"completed":false,"focus":{…},"reply":…,…}
// What the terminal shows is kept as it is shown (log: the stderr lines, also in --json runs where
// nothing is printed) next to the same things as data (todos, progress, steps, toolLog), each
// capped to its newest entries.
//
// Default place: %LOCALAPPDATA%\muser\exec\<started>-<pid>.json (the newest 50 kept);
// `muser exec --status-file <path>` puts it where the caller wants it.
//
// The file is a shared surface — whatever launched the run (and anything else that can
// read %LOCALAPPDATA%) can poll it — so free text never lands in it raw: write() passes
// the data through the work log's sanitiser (src/worklog.js), the same redaction the
// worklog applies to a turn, a tool summary and a reply before it keeps them. Only
// secret-shaped values are dropped; what the run did (commands, paths, the wording
// around a redaction) stays, so a poller still sees the shape of the work.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./secure-store');
const {renameRetry} = require('./config');
const {sanitizeText, sanitizeDeep} = require('./worklog');

const KEEP = 50;
const HEARTBEAT_MS = 10000;
// A running file whose heartbeat is older than this is dead, however its pid looks: the pid
// may have been reused by an unrelated process after the run died.
const STALE_MS = HEARTBEAT_MS * 3;
const CAPS = {log: 300, toolLog: 100, steps: 50, progress: 30};
const push = (list, item, cap) => { list.push(item); if (list.length > cap) list.splice(0, list.length - cap); };

// The copy of a run's data that may reach the file (see the header): every free-text
// field — the prompt, the last-tool line, the error, the reply, and each entry of the
// log / progress / steps / toolLog / todos lists — goes through sanitizeText, and the
// two structured payloads (focus, proof — its rows quote the reply sentence by
// sentence) through sanitizeDeep, exactly as the worklog keeps them. Sanitising here,
// at the single write, covers every way text gets in (constructor, tool(), log(),
// progress(), step(), todos(), update(), finish()) instead of relying on each caller.
// Identifiers a reader matches on are NOT free text and pass through untouched:
// sanitizeDeep redacts a key named "session" outright, which would break sessionIds()
// and the session line of summary(); state / mode / account are the same kind of
// value. Numbers, flags and the usage counters are not text either and stay as they are.
const ID_KEYS = new Set(['session', 'account', 'mode', 'state', 'owner']);
function sanitizedData(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) out[k] = typeof v === 'string' && !ID_KEYS.has(k) ? sanitizeText(v) : v;
  if (Array.isArray(out.log)) out.log = out.log.map(l => sanitizeText(l));
  if (Array.isArray(out.progress)) out.progress = out.progress.map(p => p && typeof p === 'object' ? {...p, message: sanitizeText(p.message ?? '')} : p);
  if (Array.isArray(out.steps)) out.steps = out.steps.map(s => s && typeof s === 'object'
    ? {...s, ...(typeof s.title === 'string' ? {title: sanitizeText(s.title)} : {}), ...(typeof s.detail === 'string' ? {detail: sanitizeText(s.detail)} : {})} : s);
  if (Array.isArray(out.toolLog)) out.toolLog = out.toolLog.map(t => t && typeof t === 'object'
    ? {...t, ...(typeof t.command === 'string' ? {command: sanitizeText(t.command)} : {}), ...(typeof t.summary === 'string' ? {summary: sanitizeText(t.summary)} : {}), ...(typeof t.error === 'string' ? {error: sanitizeText(t.error)} : {})} : t);
  if (Array.isArray(out.todos)) out.todos = out.todos.map(t => t && typeof t === 'object' ? {...t, ...(typeof t.content === 'string' ? {content: sanitizeText(t.content)} : {})} : t);
  if (out.focus) out.focus = sanitizeDeep(out.focus);
  if (out.proof) out.proof = sanitizeDeep(out.proof);
  if (Array.isArray(out.sources)) out.sources = out.sources.map(s => s && typeof s === 'object'
    ? {...s, ...(typeof s.label === 'string' ? {label: sanitizeText(s.label)} : {}), ...(typeof s.uri === 'string' ? {uri: sanitizeText(s.uri)} : {})} : s);
  return out;
}

function dir() { return path.join(store.DIR, 'exec'); }
function defaultFile(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  // UTC, not local time (c21 #3 / fifth f3-9): a local stamp repeats an hour at the autumn
  // DST fall-back, so two different runs share a stamp and nameSort falls back to pid
  // order, which can pick the older run as latest(). UTC has no repeated hour.
  const stamp = now.getUTCFullYear() + p(now.getUTCMonth() + 1) + p(now.getUTCDate()) + '-' + p(now.getUTCHours()) + p(now.getUTCMinutes()) + p(now.getUTCSeconds());
  return path.join(dir(), stamp + '-' + process.pid + '.json');
}
// Names sort by stamp, then NUMERICALLY by pid: a plain string sort ranks
// "…-9999" above "…-10000", so runs started in the same second could be ordered
// (and pruned, and picked as latest) wrong — latest() had this fixed; prune() had not.
function nameSort(a, b) { const pa = a.split('-'), pb = b.split('-'); const sa = pa[0] + pa[1], sb = pb[0] + pb[1]; if (sa !== sb) return sa < sb ? -1 : 1; return (parseInt(pa[2], 10) || 0) - (parseInt(pb[2], 10) || 0); }
const STATUS_NAME = /^\d{8}-\d{6}-\d+\.json$/;
const STATUS_TMP_NAME = /^\d{8}-\d{6}-\d+\.json\.tmp-.+$/;
// The UTC stamp embedded in a default status file's name, as ms (null when the
// name carries none). defaultFile() stamps UTC, so parse it as UTC.
function nameStampMs(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : null;
}
// When a run started, for ordering (latest / prune): the file's own startedAt
// first — a name is only a label, and a clock set forward then back leaves a
// future-named file whose run is actually old (wave-9: prune deleted the truly
// newest run and kept the future-named old one). The name's stamp is the
// fallback for files whose content cannot be read or has no usable startedAt,
// then the file's mtime.
function startedMs(name, file, v, now = Date.now()) {
  // A stamp in the future is not trusted (wave 15): a clock set forward when a
  // run started and corrected afterwards left that run's startedAt ahead of
  // every real run, so latest() crowned the old run and prune() ordered by a
  // start that has not happened yet. Fall through to the next stamp instead —
  // the name, then the mtime (clamped to now) — exactly as for an unusable one.
  if (v && typeof v === 'object') { const t = Date.parse(v.startedAt); if (Number.isFinite(t) && t <= now) return t; }
  const ns = nameStampMs(name);
  if (ns !== null && ns <= now) return ns;
  try { const m = fs.statSync(file).mtimeMs; if (Number.isFinite(m)) return Math.min(m, now); } catch {}
  return ns !== null ? ns : 0;
}
// One retry: a reader or AV holding the file for a moment (fifth f1-5) must not
// demote a live run's file to "unreadable" — the retry reads it fine. A file that
// still cannot be parsed after the retry is unreadable for this sweep.
function readStatus(file) { for (let i = 0; i < 2; i++) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} } return null; }
// Only files of the default folder are pruned, never a --status-file of the caller's.
function prune(now = Date.now()) {
  const d = dir();
  let names = [];
  try { names = fs.readdirSync(d); } catch { return; }
  const items = [];
  for (const n of names) {
    const isTmp = STATUS_TMP_NAME.test(n);
    if (!isTmp && !STATUS_NAME.test(n)) continue; // not a default run's file (e.g. a caller's own file): left alone
    const file = path.join(d, n);
    let st = null;
    try { st = fs.statSync(file); } catch {}
    if (st && !st.isFile()) continue; // a folder wearing a status name is not a run's file
    // A .tmp-* file younger than the stale window may be a live write in another
    // process (write() renames it within moments); only settled leftovers — a
    // write whose process died mid-way — join the sweep.
    if (isTmp && st && now - st.mtimeMs < STALE_MS) continue;
    // Wave-9: an unreadable or unparseable file is a prune candidate too. The
    // old rule (fifth f1-5) skipped anything it could not parse, so a corrupt
    // file was exempt forever and the folder grew past KEEP without bound; it
    // is ordered by its name's stamp (mtime when the name has none) and only
    // ever goes with the oldest excess, so a transiently locked live file —
    // recent by name — is not the one taken.
    const v = isTmp ? null : readStatus(file);
    items.push({name: n, file, v, ms: isTmp ? (nameStampMs(n) ?? (st ? st.mtimeMs : 0)) : startedMs(n, file, v, now)});
  }
  items.sort((a, b) => a.ms - b.ms || nameSort(a.name, b.name));
  let excess = items.length - KEEP;
  for (const it of items) {
    if (excess <= 0) break;
    // A still-running run's file is the only handle its poller has: deleting it (a long run is
    // old, so it prunes first) makes a live run look "gone" (exit 5) until it finishes.
    // No-longer-running files prune as before.
    if (it.v && it.v.state === 'running' && verdict(it.v, {now}) === 'running') continue;
    try { fs.unlinkSync(it.file); excess--; } catch {}
  }
}

class ExecStatus {
  constructor({file, prompt, cwd, mode}) {
    this.file = path.resolve(file || defaultFile());
    // The owner token (wave 15): two runs can be pointed at one --status-file,
    // and without a mark of whose file it is, the older run's heartbeat and
    // finish overwrote the newer run's state — its result simply disappeared
    // for the poller. The token is this run's from birth and rides every write.
    this.owner = crypto.randomBytes(16).toString('hex');
    this.claimed = false; // true once this run's own write has landed on the file
    this.data = {version: 1, state: 'running', pid: process.pid, owner: this.owner, cwd, mode: mode || null, prompt: String(prompt || '').slice(0, 500),
      session: null, account: null, startedAt: new Date().toISOString(), updatedAt: null, tools: 0, last: null, focus: null,
      todos: [], progress: [], steps: [], toolLog: [], log: []};
    this.finished = false; this.timer = null; this.writeError = null; this.reportedWriteError = null; this.onSigint = null; this.onSigterm = null; this.onSigbreak = null;
    this.finishTimer = null; this.finalWritePending = false; this.finishTries = 0;
  }
  // A status file never breaks the run, but a failed write is not silent either: it is kept on
  // writeError (and returned) so a caller can tell "the run is gone" from "the file could not
  // be written" instead of polling a missing file forever.
  write() {
    this.data.updatedAt = new Date().toISOString();
    // Ownership (wave 15): once this run has claimed the file, a file that now
    // carries another run's owner token — or no token at all — was written by
    // someone else (a second run started on the same --status-file and claimed
    // it, or a hand edit). Writing over it would erase that writer's result,
    // so this run stops writing and says why on writeError instead. A file
    // that cannot be read or parsed proves nothing either way (a reader or AV
    // holding it for a moment) and is written as before. A run that has not
    // claimed the file yet may still claim it: that first write is how a new
    // run takes over a path its caller reused.
    if (this.claimed) {
      const existing = readStatus(this.file);
      if (existing && typeof existing === 'object' && existing.owner !== this.owner) {
        this.writeError = '状態ファイルはほかの実行のものになっているため、書き込みを止めました';
        return false;
      }
    }
    const temp = this.file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), {recursive: true});
      fs.writeFileSync(temp, JSON.stringify(sanitizedData(this.data), null, 1));
      renameRetry(temp, this.file);
      this.claimed = true;
      this.writeError = null; this.reportedWriteError = null; // a failure after a recovery is a new incident, worth one new warning
      // A later write (a finish retry, a log line after finish) that finally lands clears
      // the pending final write: stop retrying it and drop the exit/signal listeners.
      if (this.finalWritePending) { this.finalWritePending = false; this._clearFinishRetry(); this._removeListeners(); }
      return true;
    } catch (e) { this.writeError = e && e.message ? e.message : String(e); try { fs.unlinkSync(temp); } catch {} return false; }
  }
  // The current write failure, handed out ONCE per distinct failure (wave-9): the caller
  // warns when the status is created and again when the run finishes, and while the same
  // failure lasts both checks saw the same writeError, so the user was told twice that the
  // file could not be written. Taking the error here marks it reported; a later take gets
  // null until the failure changes or a write succeeds and a new failure follows.
  // writeError itself stays readable for callers that only need the state.
  takeWriteError() {
    if (!this.writeError || this.writeError === this.reportedWriteError) return null;
    this.reportedWriteError = this.writeError;
    return this.writeError;
  }
  _clearFinishRetry() { if (this.finishTimer) { clearInterval(this.finishTimer); this.finishTimer = null; } }
  _removeListeners() {
    if (this.onExit) process.removeListener('exit', this.onExit);
    if (this.onSigint) process.removeListener('SIGINT', this.onSigint);
    if (this.onSigterm) process.removeListener('SIGTERM', this.onSigterm);
    if (this.onSigbreak) process.removeListener('SIGBREAK', this.onSigbreak);
  }
  start() {
    this.write();
    if (this.file.startsWith(dir() + path.sep)) prune();
    // The heartbeat: a reader tells a live run that is thinking from a dead one by updatedAt.
    this.timer = setInterval(() => { if (!this.finished) this.write(); }, HEARTBEAT_MS);
    this.timer.unref?.();
    // A run that ends any other way (an uncaught error, process.exit) still says it ended.
    // c21 #1: if the run DID finish but its final write is still pending, the exit is the
    // last chance to land that write synchronously before the process is gone.
    this.onExit = () => { if (!this.finished) this.finish({state: 'failed', exit: process.exitCode || 1, ok: false, error: this.data.error || 'muser exec ended before its result'}); else if (this.finalWritePending) this.write(); };
    process.on('exit', this.onExit);
    // The caller installs its own interrupt handler only later (bin's SIGINT handler comes
    // after connect succeeds): an interrupt before that left a "running" file behind. Record
    // the interruption from the start; when another listener for the same signal exists it
    // owns cleanup and exiting (finish() is idempotent, so this changes nothing then), and
    // when none does, exit with the conventional code ourselves.
    const onSignal = (sig, exit) => () => { const others = process.listenerCount(sig) - 1; this.finish({state: 'interrupted', exit, ok: false, error: 'interrupted'}); if (others <= 0) process.exit(exit); };
    this.onSigint = onSignal('SIGINT', 130);
    this.onSigterm = onSignal('SIGTERM', 143);
    process.on('SIGINT', this.onSigint);
    process.on('SIGTERM', this.onSigterm);
    // SIGBREAK is Ctrl+Break on Windows: Node delivers it there only, and with
    // no listener the console kills the process outright (0xC000013A), so the
    // file was left "running" exactly as an unhandled Ctrl+C once left it.
    // Give it SIGINT's cleanup (interrupted, 130). Registered only on Windows:
    // the signal does not exist on other platforms, where asking for it would
    // be an unknown-signal error instead of a harmless no-op.
    if (process.platform === 'win32') {
      this.onSigbreak = onSignal('SIGBREAK', 130);
      process.on('SIGBREAK', this.onSigbreak);
    }
    return this;
  }
  update(patch) { if (this.finished) return; Object.assign(this.data, patch); this.write(); }
  tool(call) {
    if (this.finished) return;
    push(this.data.toolLog, {agent: call.agent || 'main', command: call.command, summary: String(call.summary || '').slice(0, 300), ok: !!call.ok,
      ...(call.ok ? {} : {error: String(call.error || '').slice(0, 500)}), at: new Date().toISOString()}, CAPS.toolLog);
    this.update({tools: this.data.tools + 1, last: (call.command + ' ' + String(call.summary || '')).trim().slice(0, 200)});
  }
  // One line exactly as the terminal shows it — the lines printed after the result too ("Focus
  // judgement", "to continue: …"): the state stays done, the log gets them.
  log(line) { push(this.data.log, String(line), CAPS.log); this.write(); }
  progress(report) { if (this.finished) return; push(this.data.progress, {agent: report?.agent || 'main', message: String(report?.message || ''), at: new Date().toISOString()}, CAPS.progress); this.write(); }
  step(s) { if (this.finished) return; for (const x of s?.items || [s]) push(this.data.steps, {title: x?.title || '', ...(x?.detail ? {detail: x.detail} : {}), ...(x?.failed ? {failed: true} : {}), at: new Date().toISOString()}, CAPS.steps); this.write(); }
  todos(list) { this.update({todos: Array.isArray(list) ? list.map(t => ({content: String(t?.content ?? t?.text ?? ''), status: String(t?.status || 'pending')})) : []}); }
  finish(result) {
    if (this.finished) return !this.finalWritePending;
    this.finished = true;
    clearInterval(this.timer);
    // c21 #3: a backward clock step between start and finish must not produce a negative
    // duration (the wall clock is not monotonic; clamp at 0).
    Object.assign(this.data, {state: 'done', ...result, finishedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(this.data.startedAt) || 0)});
    // c21 #1: the final write carries the whole result (reply, exit, Focus verdict). If it
    // fails (a poller/AV holding the file past renameRetry's retries), do not tear down
    // and forget it: keep the listeners, retry on a short timer while this process lives,
    // and let the 'exit' listener above make one last synchronous attempt. Returns
    // whether the result is on disk.
    if (this.write()) { this._removeListeners(); return true; }
    this.finalWritePending = true;
    this.finishTries = 0;
    this.finishTimer = setInterval(() => {
      this.finishTries++;
      if (this.write()) return; // write() clears the pending flag, timer and listeners
      if (this.finishTries >= 120) { this.finalWritePending = false; this._clearFinishRetry(); this._removeListeners(); }
    }, 500);
    this.finishTimer.unref?.();
    return false;
  }
}

// ---- Reading a run back: `muser exec --status [file]` ----
// The whole file can run to hundreds of lines (log, toolLog): an agent polling it paid for all of
// them on every look. summary() is the few lines that answer "is it done, what is it doing".

// The file to read: the one named, else the newest run of the default folder. The pid in the
// name is compared numerically: a plain string sort ranks "…-9999" above "…-10000", so two
// runs started in the same second could resolve to the older one.
function latest() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter(n => STATUS_NAME.test(n)); } catch {}
  if (!names.length) return null;
  // Ordered like prune(): the content's startedAt decides, the name is only the
  // fallback (and the tie-break, pid compared numerically by nameSort) — a
  // future-named file whose run is actually old must not win as "latest".
  // An unreadable candidate (wave 12) — a corrupt file, a directory wearing a
  // status name, a file gone since the listing — is skipped, not crowned: it
  // ordered by its name's stamp, so a future-named corrupt file used to win
  // and the poller got "gone" although an older, readable run was right there.
  // The next readable run is the latest one there is to read.
  let best = null;
  for (const n of names) {
    const file = path.join(dir(), n);
    let st = null;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st || !st.isFile()) continue;
    const v = readStatus(file);
    if (!v || typeof v !== 'object') continue;
    if (v.version !== undefined && v.version !== 1) continue; // a format this build does not know is not accepted as a run (wave 15)
    const ms = startedMs(n, file, v);
    if (!best || ms > best.ms || (ms === best.ms && nameSort(n, best.name) > 0)) best = {name: n, ms};
  }
  return best ? path.join(dir(), best.name) : null;
}
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Exit code of `--status`: the run's own (0 / 2 / 1 / 130) once it ended; 4 while it runs; 5 when
// it is gone without a result (dead process) or there is no such file.
const RUNNING = 4, GONE = 5;
function verdict(v, {isAlive = alive, now = Date.now(), staleMs = STALE_MS} = {}) {
  // A file that parses but is not a status object (null, a string, fields of the wrong type)
  // is a gone run, not an exception for the poller: --status documents exit 5 for it.
  if (!v || typeof v !== 'object' || typeof v.state !== 'string') return 'dead';
  // A version this build does not know is not accepted (wave 15): a newer
  // format's "running" / "done" need not mean what they mean in version 1, so
  // the file reads as gone rather than as a verdict in a language the poller
  // cannot trust. A file with no version at all is a legacy file and is read
  // as before.
  if (v.version !== undefined && v.version !== 1) return 'dead';
  if (v.state === 'running') {
    // Only a real pid can be a live process (wave 15): 0 passes kill(pid, 0)
    // by naming the caller's own process group, and a string / fraction /
    // negative pid is not a process at all — none of them is "running".
    if (!Number.isInteger(v.pid) || v.pid <= 0) return 'dead';
    if (!isAlive(v.pid)) return 'dead';
    // The heartbeat is the liveness proof the format promises (see the header): a pid that is
    // alive proves nothing once it can be reused, so a heartbeat stopped for staleMs is dead
    // even when something with that pid exists.
    // c21 #2 / fifth f3-2: that check used to apply only when updatedAt parsed, so a file
    // with a missing/invalid updatedAt — or one far in the future after the clock was set
    // back — was "running" forever on a live (possibly reused) pid. No heartbeat is no
    // proof: fall back to startedAt (a just-started run still counts), and a stamp further
    // in the future than the stale window cannot be trusted either.
    let stamp = Date.parse(v.updatedAt);
    if (!Number.isFinite(stamp)) stamp = Date.parse(v.startedAt);
    if (!Number.isFinite(stamp)) return 'dead';
    if (stamp - now > staleMs) return 'dead';
    if (now - stamp > staleMs) return 'dead';
    return 'running';
  }
  // Only the states a run can actually end in pass through (recovery scan): a
  // hand-written or corrupt file claiming {state: 'bogus', exit: 0} used to make
  // --status print the bogus state and exit 0 (success) instead of gone/5.
  return ['done', 'interrupted', 'failed'].includes(v.state) ? v.state : 'dead';
}
function code(v, opts) {
  const s = verdict(v, opts);
  return s === 'running' ? RUNNING : s === 'dead' ? GONE : (Number.isInteger(v.exit) ? v.exit : 1);
}
function ago(iso, now) { const ms = now - Date.parse(iso); if (!Number.isFinite(ms)) return '?'; const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's'; }
const MARK = {completed: '✓', in_progress: '▶', pending: '☐'};
// Lines, plain text, in English: they are read by agents (the reply itself is as Muse wrote it).
function summary(v, {now = Date.now(), isAlive = alive, logLines = 3} = {}) {
  if (!v || typeof v !== 'object' || typeof v.state !== 'string') return 'gone · unreadable status file';
  const s = verdict(v, {isAlive, now});
  const head = [s, s === 'running' || s === 'dead' ? 'for ' + ago(v.startedAt, now) : 'took ' + Math.round((v.durationMs || 0) / 1000) + 's'];
  // The exit line (wave 12): only a run that actually ended has one, and only
  // when the file's exit is a finite integer — a dead run (a "running" file
  // whose process is gone) or a hand-written file carrying exit: "0" / 1.5 /
  // null used to print that raw value next to a state it did not belong to.
  if (['done', 'interrupted', 'failed'].includes(s) && Number.isInteger(v.exit)) head.push('exit ' + v.exit + (v.exit === 2 ? ' (Focus criteria not met)' : ''));
  if (v.account) head.push('account ' + v.account);
  if (v.session) head.push('session ' + v.session);
  head.push('tools ' + (v.tools || 0));
  const out = [head.join(' · ')];
  if (v.usage) out.push('tokens: ' + require('./turn-usage').usageText(v.usage));
  if (s === 'dead') out.push('the process (pid ' + v.pid + ') is gone without a result; last update ' + ago(v.updatedAt, now) + ' ago');
  if (s === 'running' && v.last) out.push('last: ' + v.last);
  const todos = Array.isArray(v.todos) ? v.todos : [];
  if (todos.length) out.push('todos: ' + todos.map(t => (MARK[t?.status] || '☐') + ' ' + (t?.content ?? '')).join(' | '));
  if (v.focus?.status) out.push('focus: ' + v.focus.status + (v.focus.reason ? ' — ' + v.focus.reason : ''));
  if (s === 'running' || s === 'dead') {
    const p = Array.isArray(v.progress) ? v.progress.at(-1) : undefined;
    if (p) out.push('progress: ' + (p.agent && p.agent !== 'main' ? '[' + p.agent + '] ' : '') + p.message);
    const tail = (Array.isArray(v.log) ? v.log : []).slice(-logLines);
    if (tail.length) out.push('log:', ...tail.map(l => '  ' + l));
  }
  if (v.error) out.push('error: ' + v.error);
  if (v.reply !== undefined && s !== 'running') {
    // A reply can be a whole turn's answer (wave 12): the summary is the few
    // lines that answer "is it done", so it is capped at about 500
    // characters with the cut said out loud, like the other caps here.
    // Counted in code points so a surrogate pair is never split in half.
    const reply = typeof v.reply === 'string' ? v.reply : String(v.reply);
    const chars = [...reply];
    out.push('reply:', chars.length > 500 ? chars.slice(0, 500).join('') + '\n… (truncated)' : reply);
  }
  return out.join('\n');
}

// The conversations the exec runs on record (the default status files, newest KEEP) belong to.
// Exec conversations made before sessions carried origin: 'exec' have no other trace of being
// exec work, and conversation lists (GUI, phone) leave exec work out. Read at most every few
// seconds: a list request may come often and the folder holds up to KEEP small files.
let idsCache = null;
function sessionIds({now = Date.now(), ttlMs = 5000} = {}) {
  const d = dir();
  if (idsCache && idsCache.dir === d && now - idsCache.at < ttlMs) return idsCache.ids;
  const ids = new Set();
  let names = [];
  try { names = fs.readdirSync(d).filter(n => n.endsWith('.json')); } catch {}
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8'));
      if (j.version !== undefined && j.version !== 1) continue; // unknown format: not accepted (wave 15, as in verdict/latest)
      const id = typeof j.session === 'string' ? j.session : (j.session && typeof j.session.id === 'string' ? j.session.id : null);
      if (id) ids.add(id);
    } catch {}
  }
  idsCache = {dir: d, at: now, ids};
  return ids;
}

module.exports = {sessionIds, ExecStatus, defaultFile, dir, prune, KEEP, HEARTBEAT_MS, STALE_MS, CAPS, latest, read, summary, code, verdict, RUNNING, GONE};
