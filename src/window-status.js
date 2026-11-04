'use strict';
// The live state of an interactive muser window, for `muser status` and for another agent (Claude
// Code, Codex) that wants to know what muser is doing right now. Only finished turns reached disk
// before (transcripts/*.jsonl): a turn that ran for half an hour, its tools, todos, Focus and
// parallel agents were visible on that window's screen and nowhere else.
//
// One file per window: %LOCALAPPDATA%\muser\windows\<pid>.json, replaced whole (temp file +
// rename), written when the window's state changes (at most once a second) and every 10 s as a
// heartbeat, removed when the window closes. A window that died leaves its file with a pid that
// is gone or a heartbeat that stopped; readers skip it and the next window to start removes it.
//
//   {"version":1,"kind":"window","pid":…,"startedAt":…,"updatedAt":…,"cwd":…,"mode":…,
//    "account":{"id":…,"label":…},"session":{"id":…,"title":…,"turns":…},"connected":true,
//    "activity":"working","turnStartedAt":…,"running":{"agent":"main","command":…,"summary":…,"since":…},
//    "approval":null,"queue":0,"todos":[{content,status}],"focus":{status,round,maxRounds,met,total,open,reason},
//    "goal":…,"agents":[{tag,type,title,state,lastTool,startedAt,endedAt}],"shells":[{id,running}],
//    "toolLog":[{agent,command,summary,ok,error,at}],"progress":[{agent,message,at}],"lastTurn":{…}}
//
// What the user is typing, the reply text and file contents are never written: this is a
// record of what the window is doing, not of the conversation.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./secure-store');
const {renameRetry} = require('./config');
const {HEARTBEAT_MS, STALE_MS} = require('./exec-status');

const THROTTLE_MS = 1000;
const CAPS = {toolLog: 30, progress: 10};
const iso = ms => (ms ? new Date(ms).toISOString() : null);
const cut = (s, n) => String(s ?? '').slice(0, n);

function dir() { return path.join(store.DIR, 'windows'); }
function fileFor(pid = process.pid) { return path.join(dir(), pid + '.json'); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// What the window is doing, most urgent first: an approval outranks everything, then any other
// question on screen (a menu, a reason or number prompt, an account-add question, the
// selectable-question picker), then work. The picker matters here in particular: it opens
// after the turn ended on needs_input, so busy is already false and without `question` the
// window read as plain idle in `muser status` while it waited for an answer (fifth c1-1).
// Only the classification reads `question` — the picker's contents (checked options, typed
// custom answers and notes) are what the user is composing, so they are never written to disk,
// like the composer text above.
function activityOf(s) {
  if (s.approval) return 'approval';
  if (s.menu || s.promptFor || s.reasonFor || s.limitInput || s.question) return 'input';
  if (s.busy) return 'working';
  return 'idle';
}
function focusOf(f) {
  if (!f || typeof f.status !== 'string') return null;
  const cs = Array.isArray(f.criteria) ? f.criteria : [];
  return {status: f.status, round: f.round ?? null, maxRounds: f.maxRounds ?? null, met: cs.filter(c => c.status === 'met').length, total: cs.length,
    open: cs.filter(c => c.status !== 'met').map(c => c.id).slice(0, 30), reason: cut(f.reason, 300)};
}
const callOf = call => (call ? {agent: call.agent || 'main', command: call.command, summary: cut(call.summary, 200)} : null);

// The file's content from the window's screen state (the Controller's store) and its agent.
// Pure apart from what it is handed, so tests drive it without a window.
function snapshot({s, agent, startedAt, runningSince = null, approvalSince = null, toolLog = [], progress = [], lastTurn = null, now = Date.now()}) {
  const session = agent.session || {};
  return {
    version: 1, kind: 'window', pid: process.pid, startedAt: iso(startedAt), updatedAt: iso(now),
    cwd: agent.cwd || null, mode: s.mode || agent.mode || null,
    account: agent.accountId ? {id: agent.accountId, label: agent.accountLabel || s.account?.label || null} : null,
    session: session.id ? {id: session.id, title: cut(session.title, 120) || null, turns: session.turns || 0} : null,
    slot: agent.nodeSlot?.slot ?? null, connected: !!s.deviceOk,
    activity: activityOf(s), turnStartedAt: s.busy ? iso(s.turnStart) : null,
    running: s.running?.call ? {...callOf(s.running.call), since: iso(runningSince)} : null,
    approval: s.approval?.call ? {...callOf(s.approval.call), since: iso(approvalSince)} : null,
    queue: Array.isArray(s.queue) ? s.queue.length : 0,
    todos: (Array.isArray(s.todos) ? s.todos : []).slice(0, 50).map(t => ({content: cut(t?.content ?? t?.text, 200), status: String(t?.status || 'pending')})),
    focus: focusOf(s.focus), goal: s.goal?.text ? cut(s.goal.text, 300) : null,
    agents: (Array.isArray(s.agents) ? s.agents : []).slice(0, 50).map(x => ({tag: x.tag, type: x.type || null, title: cut(x.title, 120), state: x.state,
      lastTool: x.lastTool ? cut(x.lastTool, 120) : null, startedAt: iso(x.started), endedAt: iso(x.ended)})),
    shells: (Array.isArray(s.shells) ? s.shells : []).slice(0, 20).map(x => ({id: x.id, running: !!x.running})),
    toolLog: toolLog.slice(-CAPS.toolLog), progress: progress.slice(-CAPS.progress), lastTurn,
  };
}

class WindowStatus {
  constructor({ctrl, agent, file = fileFor()}) {
    this.ctrl = ctrl; this.agent = agent; this.file = file;
    this.startedAt = Date.now(); this.toolLog = []; this.progress = []; this.lastTurn = null;
    this.runningKey = null; this.runningSince = null; this.approvalKey = null; this.approvalSince = null; this.timer = null; this.heartbeat = null; this.stopped = false; this.lastWrite = 0;
  }
  write() {
    if (this.stopped) return false;
    this.lastWrite = Date.now();
    // The whole body is inside the guard, not just the file write: ctrl.get() or snapshot()
    // throwing (a state getter, a non-finite startedAt reaching toISOString) used to escape
    // through the schedule()/heartbeat timers and kill the window this file exists to watch.
    let temp = null;
    try {
      const s = this.ctrl.get();
      const key = s.running?.call ? s.running.call.id || s.running.call.command + s.running.call.summary : null;
      if (key !== this.runningKey) { this.runningKey = key; this.runningSince = key ? Date.now() : null; }
      const asking = s.approval?.call || null;
      if (asking !== this.approvalKey) { this.approvalKey = asking; this.approvalSince = asking ? Date.now() : null; }
      const data = snapshot({s, agent: this.agent, startedAt: this.startedAt, runningSince: this.runningSince, approvalSince: this.approvalSince, toolLog: this.toolLog, progress: this.progress, lastTurn: this.lastTurn});
      temp = this.file + '.tmp-' + process.pid + '-' + Date.now();
      fs.mkdirSync(path.dirname(this.file), {recursive: true});
      fs.writeFileSync(temp, JSON.stringify(data));
      renameRetry(temp, this.file);
      return true;
    } catch { if (temp) { try { fs.unlinkSync(temp); } catch {} } return false; } // never breaks the window
  }
  // A change on screen: written now if the last write is a second old, else once that second is up.
  schedule() {
    if (this.stopped || this.timer) return;
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - this.lastWrite));
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, wait);
    this.timer.unref?.();
  }
  start() {
    prune();
    const a = this.agent;
    this.onTool = call => {
      this.toolLog.push({agent: call.agent || 'main', command: call.command, summary: cut(call.summary, 200), ok: !!call.ok, ...(call.ok ? {} : {error: cut(call.error, 300)}), at: new Date().toISOString()});
      if (this.toolLog.length > CAPS.toolLog) this.toolLog.splice(0, this.toolLog.length - CAPS.toolLog);
      this.schedule();
    };
    this.onProgress = r => { this.progress.push({agent: r?.agent || 'main', message: cut(r?.message, 300), at: new Date().toISOString()}); if (this.progress.length > CAPS.progress) this.progress.shift(); this.schedule(); };
    this.onTurnEnd = e => { this.lastTurn = {endedAt: new Date().toISOString(), ok: !!e?.ok, ...(e?.aborted ? {aborted: true} : {}), ...(e?.error ? {error: cut(e.error, 300)} : {}), ms: e?.ms ?? null, ...(e?.usage ? {usage: {inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, ...(e.usage.source ? {source: e.usage.source} : {}), ...(e.usage.formatted ? {formatted: e.usage.formatted} : {}), ...(e.usage.rounds ? {rounds: e.usage.rounds} : {})}} : {})}; this.schedule(); };
    a.on?.('tool-end', this.onTool); a.on?.('progress', this.onProgress); a.on?.('turn-end', this.onTurnEnd);
    this.unsubscribe = this.ctrl.subscribe(() => this.schedule());
    this.write();
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS); this.heartbeat.unref?.();
    this.onExit = () => this.stop();
    process.on('exit', this.onExit);
    return this;
  }
  // The window closed: its file goes with it.
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.heartbeat);
    try { this.unsubscribe?.(); } catch {}
    const a = this.agent;
    a.off?.('tool-end', this.onTool); a.off?.('progress', this.onProgress); a.off?.('turn-end', this.onTurnEnd);
    process.removeListener('exit', this.onExit);
    try { if (JSON.parse(fs.readFileSync(this.file, 'utf8')).pid === process.pid) fs.unlinkSync(this.file); } catch {}
  }
}

// Live: the pid exists and the heartbeat is fresh (a pid alone can be reused after a crash).
function live(v, {isAlive = alive, now = Date.now(), staleMs = STALE_MS} = {}) {
  if (!v || typeof v !== 'object' || v.kind !== 'window' || !Number.isInteger(v.pid)) return false;
  const updated = Date.parse(v.updatedAt);
  return isAlive(v.pid) && Number.isFinite(updated) && now - updated <= staleMs;
}
// Every open window's state, oldest window first. Files of windows that are gone are skipped.
function readAll({folder = dir(), ...opts} = {}) {
  let names = [];
  try { names = fs.readdirSync(folder).filter(n => /^\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) { try { const v = JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8')); if (live(v, opts)) out.push(v); } catch {} }
  return out.sort((x, y) => String(x.startedAt).localeCompare(String(y.startedAt)));
}
// Files left by windows that died (crash, killed terminal). Readers already skip them.
// Pruning is only cleanup, so it is more conservative than live(): a file that cannot be
// READ (a scanner or another window holding it for a moment) is not proof its window died,
// and a live pid's file is removed only after a long heartbeat silence — a clock step or a
// suspended laptop makes a live window look stale for a while, and deleting its file hid a
// window that was still open. Before unlinking, the file is re-read: if its content changed
// since the judgement (the owner heartbeated in between), it is left for the next prune.
const PRUNE_LIVE_GRACE = 10; // × the reader staleness window
function prune({folder = dir(), readFile, ...opts} = {}) {
  const read = readFile || (f => fs.readFileSync(f, 'utf8'));
  let names = [];
  try { names = fs.readdirSync(folder).filter(n => /^\d+\.json$/.test(n)); } catch { return; }
  const isAlive = opts.isAlive || alive, staleMs = opts.staleMs ?? STALE_MS, now = opts.now ?? Date.now();
  for (const n of names) {
    const file = path.join(folder, n);
    let raw; try { raw = read(file); } catch { continue; } // unreadable is not dead: leave it
    let v = null; try { v = JSON.parse(raw); } catch {}
    if (v && v.pid === process.pid) continue;
    if (live(v, opts)) continue;
    if (v && Number.isInteger(v.pid) && isAlive(v.pid)) {
      const updated = Date.parse(v.updatedAt);
      if (!Number.isFinite(updated) || now - updated < staleMs * PRUNE_LIVE_GRACE) continue;
    }
    let raw2; try { raw2 = read(file); } catch { continue; }
    if (raw2 !== raw) continue; // rewritten since the judgement: a live window, leave it
    try { fs.unlinkSync(file); } catch {}
  }
}

module.exports = {WindowStatus, snapshot, activityOf, focusOf, readAll, prune, live, dir, fileFor, CAPS, THROTTLE_MS};
