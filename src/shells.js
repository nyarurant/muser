'use strict';
// Shell processes: one-shot runs for system.run, and background ones (dev servers, watchers,
// long builds) that keep running across turns. Muse reads their output with shell.output and
// stops them with shell.kill; muser stops all of them when it exits.
const {spawn, spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');

const MAX_BUFFER = 1024 * 1024, MAX_SHELLS = 8;

function launch(command, {shell, cwd}) {
  return shell === 'cmd'
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul & ' + command], {cwd, windowsHide: true, windowsVerbatimArguments: true})
    // -ExecutionPolicy Bypass for this process only, so npm.ps1 and friends run.
    : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;' + command], {cwd, windowsHide: true});
}
function killTree(pid) { try { spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {windowsHide: true}); } catch {} }

class Shells extends EventEmitter {
  constructor() { super(); this.list = new Map(); this.next = 1; }
  start(command, {shell, cwd, title}) {
    const running = [...this.list.values()].filter(s => s.running).length;
    if (running >= MAX_SHELLS) throw new Error('Too many background shells (' + MAX_SHELLS + '); stop one with shell.kill first');
    const id = 'bg' + this.next++, child = launch(command, {shell, cwd});
    // `dropped` counts bytes trimmed from the front, so read offsets stay absolute.
    // `read` is the legacy shared ('main') cursor; `reads` holds one cursor per caller id.
    const s = {id, command, cwd, title: title || command, pid: child.pid, started: Date.now(), ended: 0, running: true, exit: null, out: '', dropped: 0, read: 0, reads: new Map([['main', 0]]), child};
    const add = d => {
      s.out += String(d).replace(/\r\n/g, '\n');
      if (s.out.length > MAX_BUFFER) { const cut = s.out.length - MAX_BUFFER; s.out = s.out.slice(cut); s.dropped += cut; }
      this.emit('change', this.snapshot(s));
    };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('close', code => { Object.assign(s, {running: false, exit: code, ended: Date.now()}); this.emit('change', this.snapshot(s)); });
    child.on('error', e => { add('[error] ' + e.message + '\n'); Object.assign(s, {running: false, exit: -1, ended: Date.now()}); this.emit('change', this.snapshot(s)); });
    this.list.set(id, s);
    this.emit('change', this.snapshot(s));
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
    const from = () => Math.max(s.dropped, since ?? cursor());
    while (Date.now() < until && s.running && s.dropped + s.out.length <= from()) await new Promise(r => setTimeout(r, 250));
    const start = from(), text = s.out.slice(start - s.dropped), end = s.dropped + s.out.length;
    const shown = text.length > maxChars ? text.slice(-maxChars) : text;
    s.reads.set(callerId, end);
    if (callerId === 'main') s.read = end;
    return {id: s.id, running: s.running, exit_code: s.exit, output: shown, ...(text.length > maxChars || start > (since ?? start) ? {truncated: true} : {}), next_offset: end};
  }
  kill(id) { const s = this.get(id); if (s.running) killTree(s.pid); return {id: s.id, killed: s.running}; }
  killAll() { for (const s of this.list.values()) if (s.running) killTree(s.pid); }
  snapshot(s) { return {id: s.id, title: s.title, command: s.command, running: s.running, exit: s.exit, started: s.started, ended: s.ended, tail: s.out.trimEnd().split('\n').slice(-3)}; }
  all() { return [...this.list.values()].map(s => this.snapshot(s)); }
}

// One-shot run: resolves when the command exits (or is killed on timeout / abort).
// If a killed process does not close within ~2s, resolve with the timeout/abort
// result instead of hanging forever on a pipe a grandchild is holding open.
function runOnce(command, {shell, cwd, timeout, signal, onOutput, maxOut, clip}) {
  const child = launch(command, {shell, cwd});
  return new Promise(resolve => {
    let stdout = '', stderr = '', killed = '', done = false, timer = null, forceTimer = null;
    const onAbort = () => kill('cancelled');
    const finish = result => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      try { signal?.removeEventListener('abort', onAbort); } catch {}
      resolve(result);
    };
    const kill = why => {
      if (done) return;
      if (!killed) killed = why;
      try { killTree(child.pid); } catch {}
      if (!forceTimer) forceTimer = setTimeout(() => finish({code: typeof child.exitCode === 'number' ? child.exitCode : -1, stdout, stderr, killed}), 2000);
    };
    timer = setTimeout(() => kill('timeout'), timeout);
    if (signal) {
      if (signal.aborted) kill('cancelled');
      else signal.addEventListener('abort', onAbort, {once: true});
    }
    child.stdout.on('data', d => { stdout += d; onOutput?.(String(d)); if (stdout.length > 4 * maxOut) stdout = clip(stdout, 2 * maxOut); });
    child.stderr.on('data', d => { stderr += d; onOutput?.(String(d)); if (stderr.length > 4 * maxOut) stderr = clip(stderr, 2 * maxOut); });
    child.on('close', code => finish({code, stdout, stderr, killed}));
    child.on('error', e => finish({code: -1, stdout, stderr: stderr || e.message, killed}));
  });
}

module.exports = {Shells, runOnce, killTree};
