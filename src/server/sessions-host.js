'use strict';
// SessionsHost (remote/SERVER.md step 1): the resident Muser Server's conversation
// table. It owns Map<sessionId, {agent, controller}> — one Agent + Controller per open
// conversation, each with its own folder, account, mode and node slot — and knows
// nothing about HTTP: GuiServer (src/gui-server.js) routes to it, and bin/muser.js
// supplies the factory that builds a conversation (onboard + prepare + Controller).
//
// Limits follow the node slots (src/node-slots.js): at most 6 conversations open at
// once. Opening past the cap closes the least recently used conversation that is not
// busy; the default conversation (the one serve started with, which the unprefixed
// GUI API points at) is never auto-closed — it is the anchor the existing GUI holds.
// A non-default conversation left idle (not busy, not used) is closed by the sweep,
// which hands its node slot back; the session itself stays in sessions.json and can
// be re-opened at any time.
const fs = require('node:fs');
const {EventEmitter} = require('node:events');

const MAX_OPEN = 6;
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// An error with an HTTP status, so the API layer can answer with it as-is.
class HostError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function busyOf(entry) {
  const s = entry.controller?.s ?? entry.controller?.get?.();
  return !!(s?.busy ?? entry.agent?.busy);
}
function approvalOf(entry) {
  const s = entry.controller?.s ?? entry.controller?.get?.();
  return !!(s?.approval);
}
// #60: busy alone is not "safe to close". A conversation waiting on an approval
// or a menu, composing a reason/limit answer, or running a background shell
// loses all of that when closed (close() kills its shells), so eviction and
// idle sweep must treat every one of those as active.
function activeOf(entry) {
  const s = entry.controller?.s ?? entry.controller?.get?.();
  if (!s) return busyOf(entry);
  return !!(busyOf(entry) || s.approval || s.menu || s.reasonFor || s.promptFor || s.limitInput || s.addFlow
    || s.running || s.bangRunning || (Array.isArray(s.queue) && s.queue.length)
    || (Array.isArray(s.shells) && s.shells.some(sh => sh?.running))
    || (Array.isArray(s.agents) && s.agents.some(a => a?.running || a?.status === 'running')));
}

class SessionsHost extends EventEmitter {
  // {create}: async ({cwd, account, mode, session}) => {agent, controller, museName}
  // — session is a stored session object when re-opening one, undefined for a new one.
  // {findSession}: (ref) => stored session | null | undefined (default src/sessions.find).
  constructor({create, findSession, maxOpen = MAX_OPEN, idleMs = IDLE_MS, sweepMs = SWEEP_MS} = {}) {
    super();
    this.create = create || null;
    this.findSession = findSession || (ref => require('../sessions').find(ref));
    this.maxOpen = maxOpen;
    this.idleMs = idleMs;
    this.entries = new Map();
    this.defaultId = null;
    this.sweepTimer = null;
    this._opening = new Map(); // #57: session id (or ref) -> in-flight open promise
    this._pendingOpens = 0; // creations past enforceCap's check but not yet registered
    if (idleMs > 0 && sweepMs > 0) {
      this.sweepTimer = setInterval(() => { try { this.closeIdle(); } catch {} }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  get size() { return this.entries.size; }
  get(id) { return this.entries.get(id) || null; }
  defaultEntry() { return (this.defaultId && this.entries.get(this.defaultId)) || null; }
  touch(id) { const e = this.entries.get(id); if (e) e.lastUsedAt = Date.now(); }

  emitEvent(event) { this.emit('event', event); }

  // Register an already-built conversation (the startup/default one, or a test fake).
  addPrepared({agent, controller, museName, isDefault = false}) {
    const id = agent?.session?.id;
    if (!id) throw new Error('a hosted conversation needs an agent with a session id');
    // #58: a second registration for the same id used to overwrite the entry
    // silently — the old agent was never closed and its subscription and node
    // slot leaked. Close the superseded entry properly first.
    const wasDefault = this.defaultId === id;
    if (this.entries.has(id)) this.closeSync(id, 'replaced');
    const entry = {id, agent, controller, museName: museName ?? controller?.museName ?? null, createdAt: Date.now(), lastUsedAt: Date.now(), isDefault: !!(isDefault || wasDefault), _unsubscribe: null, _prevBusy: false, _prevApproval: false};
    this.entries.set(id, entry);
    // #59: only an explicit default (or the replacement of the same default)
    // becomes the default. The old "or no default yet" clause silently promoted
    // the next unrelated conversation opened after the default was closed,
    // rerouting every unprefixed GUI call to it.
    if (isDefault || wasDefault) this.defaultId = id;
    entry._prevBusy = busyOf(entry); entry._prevApproval = approvalOf(entry);
    if (typeof controller?.subscribe === 'function') {
      entry._unsubscribe = controller.subscribe(() => this.onEntryChange(entry));
    }
    this.emitEvent({type: 'session-opened', sessionId: id, at: Date.now()});
    return entry;
  }

  onEntryChange(entry) {
    if (!this.entries.has(entry.id)) return;
    const busy = busyOf(entry), approval = approvalOf(entry);
    if (busy !== entry._prevBusy) {
      entry._prevBusy = busy;
      this.emitEvent({type: busy ? 'session-busy' : 'session-idle', sessionId: entry.id, at: Date.now()});
    }
    if (approval !== entry._prevApproval) {
      entry._prevApproval = approval;
      this.emitEvent({type: approval ? 'approval-pending' : 'approval-cleared', sessionId: entry.id, at: Date.now()});
    }
  }

  infoOf(entry) {
    const a = entry.agent;
    return {
      id: entry.id,
      cwd: a?.cwd ?? null,
      turns: a?.session?.turns ?? 0,
      mode: entry.controller?.s?.mode ?? a?.mode ?? null,
      busy: busyOf(entry),
      approval: approvalOf(entry),
      account: a?.accountId ?? null,
      accountLabel: a?.accountLabel ?? null,
      museName: entry.controller?.museName ?? entry.museName ?? null,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      isDefault: entry.id === this.defaultId,
    };
  }
  list() { return [...this.entries.values()].map(e => this.infoOf(e)); }

  // Make room for one more conversation: close least-recently-used idle ones.
  // The default conversation is exempt (see the header). Throws 409 when every
  // closable conversation is busy. In-flight creations count toward the cap
  // (#57): two concurrent opens used to both pass this check before either
  // registered, ending up over the cap.
  enforceCap() {
    while (this.entries.size + this._pendingOpens >= this.maxOpen) {
      const candidates = [...this.entries.values()]
        .filter(e => e.id !== this.defaultId && !activeOf(e))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      if (!candidates.length) throw new HostError(409, 'too many conversations open and all are busy');
      this.closeSync(candidates[0].id, 'cap');
    }
  }

  async openNew({cwd, account, mode} = {}) {
    if (typeof cwd !== 'string' || !cwd) throw new HostError(400, 'cwd is required');
    let dir = false; try { dir = fs.statSync(cwd).isDirectory(); } catch {}
    if (!dir) throw new HostError(400, 'cwd is not an existing folder: ' + cwd);
    if (!this.create) throw new HostError(501, 'session hosting is not enabled');
    this.enforceCap();
    this._pendingOpens++;
    try {
      const built = await this.create({cwd, account, mode, session: undefined});
      return this.addPrepared(built);
    } finally { this._pendingOpens--; }
  }

  async openExisting(ref) {
    if (!ref || typeof ref !== 'string') throw new HostError(400, 'session id is required');
    const existing = this.entries.get(ref);
    if (existing) { this.touch(ref); return existing; }
    if (this._opening.has(ref)) return this._opening.get(ref);
    let session;
    try { session = this.findSession(ref); } catch (e) { throw new HostError(400, e.message); }
    if (!session) throw new HostError(404, 'session not found: ' + ref);
    const already = this.entries.get(session.id);
    if (already) { this.touch(session.id); return already; }
    if (this._opening.has(session.id)) return this._opening.get(session.id);
    if (!this.create) throw new HostError(501, 'session hosting is not enabled');
    this.enforceCap();
    this._pendingOpens++;
    const opening = (async () => {
      try {
        const built = await this.create({cwd: session.cwd, account: session.account, mode: undefined, session});
        return this.addPrepared(built);
      } finally { this._pendingOpens--; this._opening.delete(ref); this._opening.delete(session.id); }
    })();
    this._opening.set(ref, opening);
    this._opening.set(session.id, opening);
    return opening;
  }

  // Close one conversation: refuses (409) while it is active (working, waiting
  // on a modal, or running a background shell), unless forced.
  // The Agent's close() releases its node slot and device link.
  close(id, {force = false, reason = 'closed'} = {}) {
    const entry = this.entries.get(id);
    if (!entry) throw new HostError(404, 'session not open: ' + id);
    if (!force && activeOf(entry)) throw new HostError(409, 'session is busy');
    this.closeSync(id, reason);
    return entry;
  }
  closeSync(id, reason = 'closed') {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (this.defaultId === id) this.defaultId = null;
    if (entry._unsubscribe) { try { entry._unsubscribe(); } catch {} entry._unsubscribe = null; }
    try { entry.agent?.close?.(); } catch {}
    this.emitEvent({type: 'session-closed', sessionId: id, reason, at: Date.now()});
  }

  // Idle sweep: non-default, inactive conversations unused for idleMs are closed.
  closeIdle(now = Date.now()) {
    if (!(this.idleMs > 0)) return [];
    const closed = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.id === this.defaultId || activeOf(entry)) continue;
      if (now - entry.lastUsedAt >= this.idleMs) { this.closeSync(entry.id, 'idle'); closed.push(entry.id); }
    }
    return closed;
  }

  async closeAll() {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const id of [...this.entries.keys()]) {
      const entry = this.entries.get(id);
      try { if (entry?.agent?.busy && entry.agent.cancelAll) await entry.agent.cancelAll().catch(() => {}); } catch {}
      this.closeSync(id, 'shutdown');
    }
  }
}

module.exports = {SessionsHost, HostError, MAX_OPEN, IDLE_MS, busyOf, approvalOf, activeOf};
