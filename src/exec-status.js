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
const fs = require('node:fs');
const path = require('node:path');
const store = require('./secure-store');
const {renameRetry} = require('./config');

const KEEP = 50;
const HEARTBEAT_MS = 10000;
// A running file whose heartbeat is older than this is dead, however its pid looks: the pid
// may have been reused by an unrelated process after the run died.
const STALE_MS = HEARTBEAT_MS * 3;
const CAPS = {log: 300, toolLog: 100, steps: 50, progress: 30};
const push = (list, item, cap) => { list.push(item); if (list.length > cap) list.splice(0, list.length - cap); };

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
// Only files of the default folder are pruned, never a --status-file of the caller's.
function prune() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter(n => /^\d{8}-\d{6}-\d+\.json$/.test(n)).sort(nameSort); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP))) {
    const file = path.join(dir(), n);
    // A still-running run's file is the only handle its poller has: deleting it (a long run is
    // old by name, so it pruned first) makes a live run look "gone" (exit 5) until it finishes.
    // No-longer-running files prune as before.
    // Fifth f1-5: a file that cannot be read or parsed right now is NOT pruned. The read
    // can fail transiently (a reader/AV holding the file on Windows) while its run is
    // alive; treating "unreadable" as "dead" deleted a live run's file and its poller
    // then saw gone/5 and could re-submit a non-idempotent prompt. An unreadable file
    // stays until a later prune can actually read it.
    let v;
    try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (v && v.state === 'running' && verdict(v) === 'running') continue;
    try { fs.unlinkSync(file); } catch {}
  }
}

class ExecStatus {
  constructor({file, prompt, cwd, mode}) {
    this.file = path.resolve(file || defaultFile());
    this.data = {version: 1, state: 'running', pid: process.pid, cwd, mode: mode || null, prompt: String(prompt || '').slice(0, 500),
      session: null, account: null, startedAt: new Date().toISOString(), updatedAt: null, tools: 0, last: null, focus: null,
      todos: [], progress: [], steps: [], toolLog: [], log: []};
    this.finished = false; this.timer = null; this.writeError = null; this.onSigint = null; this.onSigterm = null;
    this.finishTimer = null; this.finalWritePending = false; this.finishTries = 0;
  }
  // A status file never breaks the run, but a failed write is not silent either: it is kept on
  // writeError (and returned) so a caller can tell "the run is gone" from "the file could not
  // be written" instead of polling a missing file forever.
  write() {
    this.data.updatedAt = new Date().toISOString();
    const temp = this.file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), {recursive: true});
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 1));
      renameRetry(temp, this.file);
      this.writeError = null;
      // A later write (a finish retry, a log line after finish) that finally lands clears
      // the pending final write: stop retrying it and drop the exit/signal listeners.
      if (this.finalWritePending) { this.finalWritePending = false; this._clearFinishRetry(); this._removeListeners(); }
      return true;
    } catch (e) { this.writeError = e && e.message ? e.message : String(e); try { fs.unlinkSync(temp); } catch {} return false; }
  }
  _clearFinishRetry() { if (this.finishTimer) { clearInterval(this.finishTimer); this.finishTimer = null; } }
  _removeListeners() {
    if (this.onExit) process.removeListener('exit', this.onExit);
    if (this.onSigint) process.removeListener('SIGINT', this.onSigint);
    if (this.onSigterm) process.removeListener('SIGTERM', this.onSigterm);
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
  try { names = fs.readdirSync(dir()).filter(n => /^\d{8}-\d{6}-\d+\.json$/.test(n)); } catch {}
  names.sort(nameSort);
  return names.length ? path.join(dir(), names[names.length - 1]) : null;
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
  if (v.state === 'running') {
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
  if (v.exit !== undefined && s !== 'running') head.push('exit ' + v.exit + (v.exit === 2 ? ' (Focus criteria not met)' : ''));
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
  if (v.reply !== undefined && s !== 'running') out.push('reply:', v.reply);
  return out.join('\n');
}

module.exports = {ExecStatus, defaultFile, dir, prune, KEEP, HEARTBEAT_MS, STALE_MS, CAPS, latest, read, summary, code, verdict, RUNNING, GONE};
