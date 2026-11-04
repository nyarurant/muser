'use strict';
// Shell processes: one-shot runs for system.run, and background ones (dev servers, watchers,
// long builds) that keep running across turns. Muse reads their output with shell.output and
// stops them with shell.kill; muser stops all of them when it exits.
const {spawn, spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {frames} = require('./tui/term');

const MAX_BUFFER = 1024 * 1024, MAX_SHELLS = 8, KEEP_FINISHED = 8;

// Windows PowerShell 5.1 reads and writes files in the ANSI code page by default (Shift-JIS on a
// Japanese Windows): Get-Content of a UTF-8 file, written back, double-encodes it ("—" became
// two kanji in a README). File cmdlets default to UTF-8 here (writes get a BOM, as 5.1's utf8 does).
const PS_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;' +
  ['Get-Content', 'Select-String', 'Set-Content', 'Add-Content', 'Out-File', 'Import-Csv', 'Export-Csv'].map(c => '$PSDefaultParameterValues["' + c + ':Encoding"]="UTF8";').join('');

function launch(command, {shell, cwd}) {
  return shell === 'cmd'
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul & ' + command], {cwd, windowsHide: true, windowsVerbatimArguments: true})
    // -ExecutionPolicy Bypass for this process only, so npm.ps1 and friends run.
    : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8 + command], {cwd, windowsHide: true});
}
// True only when taskkill itself reports success: a pid that is already gone (or was never
// ours) answers non-zero, and callers must not report that as a kill.
function killTree(pid) { if (!pid) return false; try { const r = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {windowsHide: true}); return !r.error && r.status === 0; } catch { return false; } }
// The same kill without blocking the event loop on spawnSync: taskkill takes
// tens to hundreds of ms, and the synchronous version froze the TUI (input,
// rendering, every other shell's output) for its whole run — killAll paid it
// once per shell, in series. Callers that must report the verdict in their
// return value (Shells.kill, behind the shell.kill tool) keep the sync path;
// fire-and-forget killers (killAll, runOnce's timeout/abort path) use this.
function killTreeAsync(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve(false);
    let child;
    try { child = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {windowsHide: true}); } catch { return resolve(false); }
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}
// A 'change'/'finished' listener is UI code called from data handlers and
// timers; its exception used to propagate straight through them and take
// the host process down. Listener failures are contained at the emit site —
// the shell machinery itself keeps working.
function safeEmit(emitter, event, arg) { try { emitter.emit(event, arg); } catch {} }

// Where the buffer front may be cut without splitting a character or an escape sequence:
// cutting at an arbitrary code unit left a lone surrogate (rendered as U+FFFD) or the tail of
// an ANSI sequence (a stray "31m]") at the head of what remained. `dropped` counts code units,
// the same unit every offset in this module uses, so offsets stay consistent.
function safeCut(s, cut) {
  if (cut <= 0 || cut >= s.length) return cut;
  const c = s.charCodeAt(cut);
  if (c >= 0xdc00 && c <= 0xdfff) cut++; // low surrogate: drop the pair whole
  const esc = s.lastIndexOf('\x1b', cut - 1);
  if (esc >= Math.max(0, cut - 32) && s[esc + 1] === '[') {
    let i = esc + 2;
    while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
    if (i >= cut && i < s.length) cut = i + 1; // the CSI sequence ends past the cut: drop it whole
  }
  return Math.min(cut, s.length);
}
function trimFront(s) {
  if (s.out.length <= MAX_BUFFER) return;
  const cut = safeCut(s.out, s.out.length - MAX_BUFFER);
  s.out = s.out.slice(cut); s.dropped += cut;
}

class Shells extends EventEmitter {
  constructor() { super(); this.list = new Map(); this.next = 1; }
  // Finished shells (and their up-to-1 MB output buffers) accumulated for the life of the
  // process. Keep the newest KEEP_FINISHED of them for shell.output / shell.list; evict the
  // oldest beyond that and drop their buffers with the entry.
  evictFinished() {
    const finished = [...this.list.values()].filter(s => !s.running).sort((a, b) => (a.ended || a.started || 0) - (b.ended || b.started || 0));
    while (finished.length > KEEP_FINISHED) { const s = finished.shift(); s.out = ''; s.reads?.clear?.(); this.list.delete(s.id); }
  }
  start(command, {shell, cwd, title}) {
    const running = [...this.list.values()].filter(s => s.running).length;
    if (running >= MAX_SHELLS) throw new Error('Too many background shells (' + MAX_SHELLS + '); stop one with shell.kill first');
    const child = launch(command, {shell, cwd});
    // No tool types into a background shell either: a command that asks for input (set /p, a
    // prompt) waited for it forever, "running" with nothing more to show.
    try { child.stdin.end(); } catch {}
    const s = this.track(child, {command, cwd, title, shell});
    this.evictFinished();
    return s;
  }
  // A foreground run that hit its timeout, adopted instead of killed — Claude Code moves it to
  // the background the same way. The child keeps running; its output so far seeds the buffer.
  adopt(command, {cwd, shell} = {}, child, initialOut = '') {
    const running = [...this.list.values()].filter(s => s.running).length;
    if (running >= MAX_SHELLS) return null;
    const s = this.track(child, {command, cwd, shell, out: initialOut});
    // The seed was already handed to the caller (system.run returns it as stdout/stderr), so
    // the shared 'main' cursor starts past it instead of re-delivering it on the first
    // shell.output. Other callers keep their own cursor and still see the whole buffer.
    const seedEnd = s.dropped + s.out.length;
    s.read = seedEnd; s.reads.set('main', seedEnd);
    this.evictFinished();
    return s;
  }
  track(child, {command, cwd, title, shell, out = ''}) {
    const id = 'bg' + this.next++;
    // `dropped` counts bytes trimmed from the front, so read offsets stay absolute.
    // `read` is the legacy shared ('main') cursor; `reads` holds one cursor per caller id.
    // The shell is part of the record (audit #221): a run adopted into the background
    // used to lose it, so the record — and everything reading it — treated a cmd run
    // as the default PowerShell. Normalised the way launch() decides.
    const s = {id, command, cwd, title: title || command, shell: shell === 'cmd' ? 'cmd' : 'powershell', pid: child.pid, started: Date.now(), ended: 0, running: true, exit: null, out, dropped: 0, read: 0, reads: new Map([['main', 0]]), child};
    trimFront(s); // a seed handed to adopt() may already be over the cap
    // 'change' is coalesced to at most one snapshot per 100 ms: rebuilding the whole snapshot
    // for every chunk made a command printing many small chunks churn the UI without bound.
    // The trailing emit keeps the last state visible; done() always emits immediately.
    let lastChange = 0, changeTimer = null;
    const emitChange = () => { lastChange = Date.now(); if (changeTimer) { clearTimeout(changeTimer); changeTimer = null; } safeEmit(this, 'change', this.snapshot(s)); };
    const queueChange = () => { const wait = 100 - (Date.now() - lastChange); if (wait <= 0) emitChange(); else if (!changeTimer) { changeTimer = setTimeout(() => { changeTimer = null; emitChange(); }, wait); changeTimer.unref?.(); } };
    const add = d => {
      s.out += String(d).replace(/\r\n/g, '\n');
      trimFront(s);
      queueChange();
    };
    // Decoded as a stream: a character split between two chunks came out as U+FFFD twice.
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', add); child.stderr.on('data', add);
    // The finished event carries a Claude-Code-style status: a shell stopped on purpose reports
    // 'stopped' (it still reports — stopping is news too), exit 0 is 'completed', else 'failed'.
    // done() is idempotent: a spawn failure emits both 'error' and 'close', and the completion
    // notification / auto-resume must fire once, with the first verdict kept.
    let finished = false;
    const done = code => { if (finished) return; finished = true; Object.assign(s, {running: false, exit: code, ended: Date.now()}); emitChange(); safeEmit(this, 'finished', {...this.snapshot(s), status: s.stopped ? 'stopped' : code === 0 ? 'completed' : 'failed'}); this.evictFinished(); };
    child.on('close', done);
    child.on('error', e => { add('[error] ' + e.message + '\n'); done(-1); });
    this.list.set(id, s);
    lastChange = Date.now();
    safeEmit(this, 'change', this.snapshot(s));
    return s;
  }
  get(id) { const s = this.list.get(String(id || '').trim()); if (!s) throw new Error('No background shell ' + id + ' (see shell.list)'); return s; }
  // Output after `since` (absolute offset; default: what THIS caller has not read yet).
  // Cursors are per caller: `caller` (or `agent`) selects one, defaulting to the shared
  // 'main' cursor so existing callers keep the old single-cursor behaviour.
  async output(id, {since, waitS = 0, maxChars = 30000, caller, agent} = {}) {
    const s = this.get(id), until = Date.now() + Math.min(30, Math.max(0, waitS)) * 1000;
    const callerId = String(caller || agent || 'main');
    if (!(s.reads instanceof Map)) s.reads = new Map([['main', s.read || 0]]);
    const cursor = () => s.reads.has(callerId) ? s.reads.get(callerId) : (callerId === 'main' ? (s.read || 0) : 0);
    // The offset the caller actually asked from (their cursor, or an explicit `since`),
    // clamped into the buffer's real range: an out-of-range `since` (past the end, or
    // negative) used to move the caller's cursor backwards in silence, re-delivering output
    // that was already read. Output the buffer already dropped before that offset is
    // truncated output, and the flag must be computed against the requested offset —
    // comparing against `start` itself (the clamped offset) could never be true, so dropped
    // output was reported as complete.
    const requestedRaw = since ?? cursor();
    const from = () => { const end = s.dropped + s.out.length; return Math.max(s.dropped, Math.min(requestedRaw, end)); };
    while (Date.now() < until && s.running && s.dropped + s.out.length <= from()) await new Promise(r => setTimeout(r, 250));
    const end = s.dropped + s.out.length;
    const requested = Math.min(Math.max(requestedRaw, 0), end);
    const start = Math.max(s.dropped, requested), text = s.out.slice(start - s.dropped);
    // An over-long read returns its FIRST maxChars and advances the cursor only past what was
    // actually shown: returning the tail while jumping the cursor to the end threw the
    // skipped head away for good.
    const shown = text.length > maxChars ? text.slice(0, maxChars) : text;
    const shownEnd = start + shown.length;
    s.reads.set(callerId, shownEnd);
    if (callerId === 'main') s.read = shownEnd;
    return {id: s.id, running: s.running, exit_code: s.exit, output: shown, ...(text.length > maxChars || start > requested ? {truncated: true} : {}), next_offset: shownEnd};
  }
  // `stopped` is set only when the kill actually landed: marking it before taskkill ran made
  // a shell whose pid was already gone report 'stopped', and killAll never marked it at all,
  // so shells stopped that way reported 'failed' instead.
  kill(id) { const s = this.get(id); const killed = s.running ? killTree(s.pid) : false; if (killed) s.stopped = true; return {id: s.id, killed}; }
  killAll() { for (const s of this.list.values()) if (s.running) void killTreeAsync(s.pid).then(killed => { if (killed) s.stopped = true; }); }
  snapshot(s) { return {id: s.id, title: s.title, command: s.command, shell: s.shell, running: s.running, exit: s.exit, started: s.started, ended: s.ended, tail: frames(s.out.slice(-8000)).trimEnd().split('\n').slice(-3)}; }
  all() { return [...this.list.values()].map(s => this.snapshot(s)); }
}

// One-shot run: resolves when the command exits (or is killed on timeout / abort).
// If a killed process does not close within ~2s, resolve with the timeout/abort
// result instead of hanging forever on a pipe a grandchild is holding open.
// Defaults for runOnce's options: a missing timeout used to mean "kill at once"
// (setTimeout(undefined) is 0), a missing maxOut disabled the cap, and a missing clip threw
// inside the data handler once the cap was reached. Callers (tools.js) pass their own.
const DEFAULT_TIMEOUT = 120000, DEFAULT_MAX_OUT = 60000;
const defaultClip = (s, n) => (s.length > n ? s.slice(0, n) : s);
function runOnce(command, {shell, cwd, timeout = DEFAULT_TIMEOUT, signal, onOutput, maxOut = DEFAULT_MAX_OUT, clip = defaultClip, adopt} = {}) {
  if (!(timeout > 0)) timeout = DEFAULT_TIMEOUT;
  if (!(maxOut > 0)) maxOut = DEFAULT_MAX_OUT;
  if (typeof clip !== 'function') clip = defaultClip;
  const child = launch(command, {shell, cwd});
  // Nobody types into a one-shot command: its stdin is closed at once, so a command that reads
  // input (git shortlog without a revision, python's input(), a prompt) gets EOF instead of
  // waiting out the whole timeout with no output (2026-11-01: 120 s of nothing).
  try { child.stdin.end(); } catch {}
  return new Promise(resolve => {
    let stdout = '', stderr = '', combined = '', killed = '', done = false, timer = null, forceTimer = null;
    const onAbort = () => kill('cancelled');
    // `combined` keeps stdout and stderr interleaved in arrival order: an adopted shell seeded
    // with stdout + stderr concatenated lost the chronology of the two streams.
    // onOutput is the caller's display callback, invoked from a stream 'data'
    // handler: an exception in it used to escape as an uncaught exception and
    // take muser itself down mid-command. A broken display callback loses
    // its notifications, not the run.
    const notify = t => { try { onOutput?.(t); } catch {} };
    const onStdout = d => { const t = String(d); stdout += t; combined += t; notify(t); if (stdout.length > 4 * maxOut) stdout = clip(stdout, 2 * maxOut); if (combined.length > 4 * maxOut) combined = combined.slice(-2 * maxOut); };
    const onStderr = d => { const t = String(d); stderr += t; combined += t; notify(t); if (stderr.length > 4 * maxOut) stderr = clip(stderr, 2 * maxOut); if (combined.length > 4 * maxOut) combined = combined.slice(-2 * maxOut); };
    const finish = result => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      try { signal?.removeEventListener('abort', onAbort); } catch {}
      // Detach our readers: a run resolved by the force timer may still be alive (a grandchild
      // holding the pipe open), and its late output must not keep streaming into a result the
      // caller already has. (The adopt path removed them before handing the child over.)
      try { child.stdout.removeListener('data', onStdout); child.stderr.removeListener('data', onStderr); } catch {}
      resolve(result);
    };
    const kill = why => {
      if (done) return;
      // A timeout hands the run to the background instead of killing it, when the caller gave an
      // adopt() for it (system.run does, except for sleep-led commands): detach our readers, let
      // the shells tracker take the child over, and resolve as backgrounded.
      if (why === 'timeout' && adopt) {
        const s = adopt(child, combined);
        if (s) { child.stdout.removeListener('data', onStdout); child.stderr.removeListener('data', onStderr); return finish({code: null, stdout, stderr, backgrounded: s.id}); }
      }
      if (!killed) killed = why;
      void killTreeAsync(child.pid).catch(() => {});
      // The force resolve retries the kill first: the first taskkill may have raced a process
      // that was still starting its tree. If the tree is STILL alive at the force resolve, the
      // result says so and names the pid: the run used to resolve with nothing that could find
      // or stop the survivor — no pid, no shell id, nothing in shell.list — an untracked orphan.
      if (!forceTimer) forceTimer = setTimeout(() => { void killTreeAsync(child.pid).catch(() => {}); const alive = typeof child.exitCode !== 'number'; finish({code: alive ? -1 : child.exitCode, stdout, stderr, killed, pid: child.pid, ...(alive ? {orphaned: true} : {})}); }, 2000);
    };
    timer = setTimeout(() => kill('timeout'), timeout);
    if (signal) {
      if (signal.aborted) kill('cancelled');
      else signal.addEventListener('abort', onAbort, {once: true});
    }
    // Decoded as a stream: Japanese split between chunks came out as U+FFFD (10 in 160,000 characters).
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('close', code => finish({code, stdout, stderr, killed}));
    child.on('error', e => finish({code: -1, stdout, stderr: stderr || e.message, killed}));
  });
}

module.exports = {Shells, runOnce, killTree, killTreeAsync};
