'use strict';
// SessionsHost (remote/SERVER.md step 1): the resident Muser Server's conversation
// table. It owns Map<sessionId, {agent, controller}> — one Agent + Controller per open
// conversation, each with its own folder, account, mode and node slot — and knows
// nothing about HTTP: GuiServer (src/gui-server.js) routes to it, and bin/muser.js
// supplies the factory that builds a conversation (onboard + prepare + Controller).
//
// Limits follow the node slots (src/node-slots.js): at most MAX_OPEN conversations open at
// once — the same cap as the node slots (/settings 'maxNodeSlots', default 16), so every open
// conversation has a node slot of its own to register. Opening past the cap closes the least
// recently used conversation that is not busy; the default conversation (the one serve started
// with, which the unprefixed GUI API points at) is never auto-closed — it is the anchor the
// existing GUI holds. A non-default conversation left idle (not busy, not used) is closed by
// the sweep, which hands its node slot back; the session itself stays in sessions.json and can
// be re-opened at any time.
const fs = require('node:fs');
const {EventEmitter} = require('node:events');

const MAX_OPEN = 16;
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// An error with an HTTP status, so the API layer can answer with it as-is.
class HostError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Third H3: the explicit "new conversation" sentinel openNew passes to the
// factory, in place of the `session: undefined` it used to send. undefined
// means "not specified" to bin/muser.js prepare() (which then falls back to
// the startup --session/-c flags); 'new' means "explicitly new, do NOT
// resume anything". A stored session object means re-open that session.
const NEW_SESSION = 'new';

// serverfirst (out-CL §1): the attach values a client may ask for when it
// opens a conversation (src/server/discovery.js attachSession forwards
// --max-agents / --max-agents-total / --no-focus this way). They are
// validated here, next to openNew's mode check (c27 #3's rule: an unchecked
// value must not reach the factory verbatim), and passed to the factory as
// {maxAgents, maxAgentsTotal, focusEnabled, noFocus} — only the keys the
// caller actually supplied, so factories that predate them see the exact
// old argument shape. focusEnabled is the derived form (an explicit
// focusEnabled wins; otherwise it is !noFocus when noFocus was given);
// noFocus itself also rides along, in the spelling bin/muser.js uses.
function attachOptsOf({maxAgents, maxAgentsTotal, focusEnabled, noFocus} = {}) {
  const out = {};
  for (const [name, value] of [['maxAgents', maxAgents], ['maxAgentsTotal', maxAgentsTotal]]) {
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new HostError(400, name + ' must be a non-negative integer');
    out[name] = value;
  }
  for (const [name, value] of [['focusEnabled', focusEnabled], ['noFocus', noFocus]]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'boolean') throw new HostError(400, name + ' must be a boolean');
    out[name] = value;
  }
  if (out.focusEnabled === undefined && out.noFocus !== undefined) out.focusEnabled = !out.noFocus;
  // serverfirst-debug G8: a contradictory pair (an explicit focusEnabled
  // AND a noFocus that disagrees with it) used to ride along verbatim and
  // resolve only by accident of the factory's apply order. The explicit
  // focusEnabled wins — the rule this function's header already states —
  // and noFocus is rewritten to agree, so every consumer sees one story.
  if (out.focusEnabled !== undefined && out.noFocus !== undefined && out.noFocus === out.focusEnabled) out.noFocus = !out.focusEnabled;
  return out;
}

// serverfirst-debug G9: did this open ask for attach values the entry was
// NOT built with? (entry.attachOpts is what the factory actually got.)
// The values can only shape a conversation the factory builds, so for an
// already-open one they are dropped — the caller is told (the route
// answers attachApplied: false) instead of the old silent no-op behind a
// success response.
function attachDropped(attach, entry) {
  if (!attach || !Object.keys(attach).length) return false;
  const built = entry?.attachOpts || {};
  return Object.keys(attach).some(k => attach[k] !== built[k]);
}

function busyOf(entry) {
  const s = entry.controller?.s ?? entry.controller?.get?.();
  // Deep H12: `s?.busy ?? agent.busy` never reached the agent when the
  // snapshot said false (false is not nullish) — yet agent.busy is the
  // authoritative check (it sees every worker's turn/starting, src/agent.js).
  // Busy is the OR of all three views: the snapshot, the agent (whose getter
  // already covers its workers), and the snapshot's own worker list.
  let workersBusy = false;
  try {
    const list = typeof entry.agent?.agents === 'function' ? entry.agent.agents() : null;
    if (Array.isArray(list)) workersBusy = list.some(a => a?.state === 'working' || a?.state === 'starting');
  } catch {}
  const snapshotWorkersBusy = Array.isArray(s?.agents) && s.agents.some(a => a?.state === 'working' || a?.state === 'starting');
  return !!(s?.busy || entry.agent?.busy || workersBusy || snapshotWorkersBusy);
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
  // Deep H12: the agents check used to read a.running / a.status, fields the
  // worker snapshot (src/agent.js snapshot()) does not have — the live field
  // is `state`, 'working' while a worker runs ('starting' before its turn).
  // And s.question (the selectable-question picker, whose checks/drafts live
  // only in the controller state) was missing from this list entirely,
  // although the #60 rule above says anything lost on close counts as active.
  return !!(busyOf(entry) || s.approval || s.menu || s.reasonFor || s.promptFor || s.limitInput || s.addFlow || s.question
    || s.running || s.bangRunning || (Array.isArray(s.queue) && s.queue.length)
    || (Array.isArray(s.shells) && s.shells.some(sh => sh?.running))
    || (Array.isArray(s.agents) && s.agents.some(a => a?.state === 'working' || a?.state === 'starting')));
}

class SessionsHost extends EventEmitter {
  // {create}: async ({cwd, account, mode, session, ...attachOpts}) => {agent, controller, museName}
  // — attachOpts carries only the attach values the opener supplied
  // (maxAgents / maxAgentsTotal / focusEnabled / noFocus, see attachOptsOf).
  // — session is a stored session object when re-opening one, NEW_SESSION
  // ('new') for a brand-new one (Third H3: never undefined — undefined means
  // "not specified" to the factory and used to inherit startup resume flags).
  // {findSession}: (ref) => stored session | null | undefined (default src/sessions.find).
  constructor({create, findSession, maxOpen = MAX_OPEN, idleMs = IDLE_MS, sweepMs = SWEEP_MS, holders = null} = {}) {
    super();
    this.create = create || null;
    // Who else on this PC holds a stored conversation on its own (a standalone window, a
    // muser exec): src/session-holders.js localHolders. Null = not checked (tests, old callers).
    this.holders = typeof holders === 'function' ? holders : null;
    this.findSession = findSession || (ref => require('../sessions').find(ref));
    this.maxOpen = maxOpen;
    this.idleMs = idleMs;
    this.entries = new Map();
    this.defaultId = null;
    this.sweepTimer = null;
    this._opening = new Map(); // #57: session id (or ref) -> in-flight open promise
    this._pendingOpens = 0; // creations past enforceCap's check but not yet registered
    this._inflight = new Set(); // c27 #5: every in-flight creation (openNew too), so closeAll can wait for / cancel them
    this._cancelledOpens = new Set(); // c27 #5: opening keys a close() arrived for while the creation was in flight
    this._shuttingDown = false; // c27 #5: set by closeAll(); a creation completing afterwards is closed, never registered
    if (idleMs > 0 && sweepMs > 0) {
      this.sweepTimer = setInterval(() => { try { this.closeIdle(); } catch {} }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  get size() { return this.entries.size; }
  get(id) { return this.entries.get(id) || null; }
  defaultEntry() { return (this.defaultId && this.entries.get(this.defaultId)) || null; }
  // Deep H13: when the default conversation is closed while others remain,
  // the most recently used remaining conversation becomes the default —
  // otherwise defaultId stayed null forever and every unprefixed GUI route
  // (the routes the existing GUI actually uses) answered 404 until a server
  // restart. This deliberately supersedes the #59 "never promote" rule for
  // the close path: #59's silent-rerouting concern is outweighed by the
  // unprefixed API being permanently dead; promotion is visible in
  // list()/serverInfo (isDefault) and announced by the close itself.
  promoteDefault() {
    if (!this.entries.size) { this.defaultId = null; return null; }
    const chosen = [...this.entries.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    this.defaultId = chosen.id;
    for (const e of this.entries.values()) e.isDefault = e.id === chosen.id;
    return chosen;
  }
  // NOTE (merge, fix1): an earlier H13 draft also made openNew/openExisting
  // adopt the opened conversation as default when none existed. That broke
  // the #59 rule the audit did not ask to change (a later unrelated open must
  // NOT silently become the unprefixed target — tests/server.test.js gui #59)
  // and the cap/sweep exemptions. H13's actual scenario — the default is
  // closed while OTHER conversations remain — is fully covered by
  // promoteDefault() at close time, so opens keep the #59 behaviour.
  touch(id) { const e = this.entries.get(id); if (e) { e.lastUsedAt = Date.now(); e._usedWall = e.lastUsedAt; e._usedMono = performance.now(); } }

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
    // f3-4: the idle age is measured on the monotonic clock (see closeIdle);
    // _usedWall records which wall time _usedMono belongs to, so a lastUsedAt
    // set from outside (tests, a caller's own bookkeeping) falls back to the
    // wall-clock age instead of being paired with a stale monotonic stamp.
    entry._usedWall = entry.lastUsedAt; entry._usedMono = performance.now();
    this.entries.set(id, entry);
    // #59: only an explicit default (or the replacement of the same default)
    // becomes the default HERE. The old "or no default yet" clause silently promoted
    // the next unrelated conversation opened after the default was closed,
    // rerouting every unprefixed GUI call to it. Deep H13 supersedes that
    // outcome only at the close level (promoteDefault on closing the default
    // while others remain), because leaving defaultId null forever killed
    // every unprefixed route; opens and bare registrations keep #59.
    if (isDefault || wasDefault) this.defaultId = id;
    entry._prevBusy = busyOf(entry); entry._prevApproval = approvalOf(entry);
    entry._prevTitle = entry.agent?.session?.title ?? null;
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
    // gui-serve: the title lives on the agent's session, not in the Controller
    // state, so busy/approval changes never announced it — a GUI holding the
    // /api/server list kept a stale (or empty) title for a conversation it did
    // not open itself. The title is set by sessions.touch at a turn's start,
    // and the turn's own Controller changes reach this hook right after, so a
    // change seen here is announced through the same server-event channel;
    // the new title rides along so a listener need not re-read the list.
    const title = entry.agent?.session?.title ?? null;
    if (title !== entry._prevTitle) {
      entry._prevTitle = title;
      this.emitEvent({type: 'session-title', sessionId: entry.id, title, at: Date.now()});
    }
  }

  infoOf(entry) {
    const a = entry.agent;
    return {
      id: entry.id,
      cwd: a?.cwd ?? null,
      title: a?.session?.title ?? null,
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
  // c27 #4: enforceCap used to run BEFORE the factory, so a creation that
  // then failed (unknown account, not logged in, onboarding aborted) had
  // already destroyed an unrelated conversation for nothing. The open paths
  // now only CHECK here that room could be made (409 up front when every
  // conversation is busy), create first, and evict in _finishOpen once the
  // new conversation actually exists.
  assertCapRoom() {
    if (this.entries.size + this._pendingOpens < this.maxOpen) return;
    const anyClosable = [...this.entries.values()].some(e => e.id !== this.defaultId && !activeOf(e));
    if (!anyClosable) throw new HostError(409, 'too many conversations open and all are busy');
  }
  // Register a freshly built conversation, evicting for the cap only now.
  // If the eviction candidate turned active while the factory ran, the NEW
  // conversation is closed again instead of an active one being forced out.
  _finishOpen(built) {
    try { this.enforceCap(); } catch (e) { try { built?.agent?.close?.(); } catch {} throw e; }
    return this.addPrepared(built);
  }
  // c27 #5: a creation that completes after closeAll() (or after a close()
  // for its id arrived mid-open) must not resurrect a conversation on a
  // stopped host: close the just-built agent and fail the open instead.
  _checkOpenLive(built, keys = []) {
    if (!this._shuttingDown && !keys.some(k => this._cancelledOpens.has(k))) return;
    try { built?.agent?.close?.(); } catch {}
    throw new HostError(503, 'session host is shutting down');
  }
  _trackOpen(promise) {
    this._inflight.add(promise);
    const done = () => this._inflight.delete(promise);
    promise.then(done, done);
    return promise;
  }

  async openNew({cwd, account, mode, maxAgents, maxAgentsTotal, focusEnabled, noFocus} = {}) {
    if (typeof cwd !== 'string' || !cwd) throw new HostError(400, 'cwd is required');
    let dir = false; try { dir = fs.statSync(cwd).isDirectory(); } catch {}
    if (!dir) throw new HostError(400, 'cwd is not an existing folder: ' + cwd);
    // c27 #3: the mode was passed to the factory unchecked, so a typo'd
    // 'Plan' / 'plan ' became agent.mode verbatim and policy.decide — which
    // matches 'plan' exactly — fell through to the default 'ask' behaviour:
    // a conversation meant to be read-only could edit after one approval.
    // /api/mode already rejects non-MODES values with 400; do the same here
    // (undefined/null still means "the factory decides", as before).
    if (mode !== undefined && mode !== null && !require('../policy').MODES.includes(mode))
      throw new HostError(400, 'mode must be one of: ' + require('../policy').MODES.join(', '));
    const attach = attachOptsOf({maxAgents, maxAgentsTotal, focusEnabled, noFocus});
    if (!this.create) throw new HostError(501, 'session hosting is not enabled');
    if (this._shuttingDown) throw new HostError(503, 'session host is shutting down');
    this.assertCapRoom();
    this._pendingOpens++;
    let counted = true; // _pendingOpens is released exactly once, before _finishOpen's cap check
    const opening = (async () => {
      try {
        // Third H3: pass the explicit NEW_SESSION sentinel, not undefined —
        // prepare() reads undefined as "not specified" and falls back to the
        // server process's startup resume flags, so a "new" conversation used
        // to silently continue the startup session (and replace the default).
        const built = await this.create({cwd, account, mode, session: NEW_SESSION, ...attach});
        this._checkOpenLive(built);
        counted = false; this._pendingOpens--;
        const entry = this._finishOpen(built);
        if (Object.keys(attach).length) entry.attachOpts = attach;
        return entry;
      } finally { if (counted) { counted = false; this._pendingOpens--; } }
    })();
    return this._trackOpen(opening);
  }

  async openExisting(ref, attachOpts = {}, {force = false} = {}) {
    if (!ref || typeof ref !== 'string') throw new HostError(400, 'session id is required');
    // serverfirst: same attach values as openNew (discovery sends them on
    // the /open route too). An already-open conversation is returned as-is —
    // the values can only shape a conversation the factory actually builds.
    const attach = attachOptsOf(attachOpts);
    const existing = this.entries.get(ref);
    if (existing) { this.touch(ref); if (attachDropped(attach, existing)) existing.attachDropped = true; return existing; }
    if (this._opening.has(ref)) return this._opening.get(ref).then(entry => { if (attachDropped(attach, entry)) entry.attachDropped = true; return entry; });
    let session;
    try { session = this.findSession(ref); } catch (e) { throw new HostError(400, e.message); }
    if (!session) throw new HostError(404, 'session not found: ' + ref);
    const already = this.entries.get(session.id);
    if (already) { this.touch(session.id); if (attachDropped(attach, already)) already.attachDropped = true; return already; }
    if (this._opening.has(session.id)) return this._opening.get(session.id).then(entry => { if (attachDropped(attach, entry)) entry.attachDropped = true; return entry; });
    if (!this.create) throw new HostError(501, 'session hosting is not enabled');
    if (this._shuttingDown) throw new HostError(503, 'session host is shutting down');
    // 2026-11-09: a chat a standalone window (or a muser exec) has open is not opened a
    // second time here — two devices on one chat lose each other's work. [force] is the
    // explicit override (the holder is known to be stuck).
    if (this.holders && !force) {
      let held = [];
      try { held = this.holders(session.id) || []; } catch {}
      if (held.length) { const e = new HostError(409, 'the conversation is open elsewhere on this PC'); e.code = 'held'; e.holders = held; throw e; }
    }
    this.assertCapRoom();
    this._pendingOpens++;
    let counted = true;
    const opening = (async () => {
      try {
        const built = await this.create({cwd: session.cwd, account: session.account, mode: undefined, session, ...attach});
        this._checkOpenLive(built, [ref, session.id]);
        counted = false; this._pendingOpens--;
        const entry = this._finishOpen(built);
        if (Object.keys(attach).length) entry.attachOpts = attach;
        return entry;
      } finally {
        if (counted) { counted = false; this._pendingOpens--; }
        this._opening.delete(ref); this._opening.delete(session.id);
        this._cancelledOpens.delete(ref); this._cancelledOpens.delete(session.id);
      }
    })();
    this._opening.set(ref, opening);
    this._opening.set(session.id, opening);
    return this._trackOpen(opening);
  }

  // Close one conversation: refuses (409) while it is active (working, waiting
  // on a modal, or running a background shell), unless forced.
  // The Agent's close() releases its node slot and device link.
  close(id, {force = false, reason = 'closed'} = {}) {
    const entry = this.entries.get(id);
    // c27 #5: an in-flight open has no entry yet; remember the close so the
    // creation is cancelled on completion instead of registering afterwards.
    if (!entry && this._opening.has(id)) this._cancelledOpens.add(id);
    if (!entry) throw new HostError(404, 'session not open: ' + id);
    if (!force && activeOf(entry)) throw new HostError(409, 'session is busy');
    this.closeSync(id, reason);
    return entry;
  }
  // Close one conversation now. The agent is closed gracefully when it knows how (its device
  // link goes down first, then its node id is unpaired before its client goes down); the
  // unpair runs in the background and the promise is returned, so closeAll can wait for it
  // before the server process exits. Agents without closeGracefully (test fakes) are closed
  // the plain way.
  // The entry is gone from the table either way, so a new conversation opening right after
  // may briefly see the old slot still held and take the next free one instead.
  closeSync(id, reason = 'closed') {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const wasDefault = this.defaultId === id;
    this.entries.delete(id);
    if (wasDefault) {
      this.defaultId = null;
      entry.isDefault = false;
      // Deep H13: promote the most recently used survivor, if any remain.
      if (this.entries.size) this.promoteDefault();
    }
    if (entry._unsubscribe) { try { entry._unsubscribe(); } catch {} entry._unsubscribe = null; }
    let closing = null;
    try {
      const graceful = entry.agent?.closeGracefully?.();
      if (graceful && typeof graceful.catch === 'function') { closing = graceful; graceful.catch(() => {}); }
      else entry.agent?.close?.();
    } catch { try { entry.agent?.close?.(); } catch {} }
    this.emitEvent({type: 'session-closed', sessionId: id, reason, at: Date.now()});
    return closing;
  }

  // Idle sweep: non-default, inactive conversations unused for idleMs are closed.
  closeIdle(now = Date.now()) {
    if (!(this.idleMs > 0)) return [];
    const closed = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.id === this.defaultId || activeOf(entry)) continue;
      // Fifth f3-4: a wall-clock age is inflated by a clock step forward
      // (NTP / manual change), closing just-used conversations. When the
      // monotonic stamp still belongs to this lastUsedAt (addPrepared/touch
      // set both together), use the monotonic age; a lastUsedAt assigned
      // from outside keeps the wall-clock reading.
      const age = entry._usedMono != null && entry._usedWall === entry.lastUsedAt ? performance.now() - entry._usedMono : now - entry.lastUsedAt;
      if (age >= this.idleMs) { this.closeSync(entry.id, 'idle'); closed.push(entry.id); }
    }
    return closed;
  }

  async closeAll() {
    // c27 #5: mark shutdown FIRST and wait out in-flight creations below:
    // one completing afterwards sees the flag, closes its just-built agent
    // and rejects, instead of registering on a host nobody sweeps again.
    this._shuttingDown = true;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    const closings = [];
    for (const id of [...this.entries.keys()]) {
      const entry = this.entries.get(id);
      try { if (entry?.agent?.busy && entry.agent.cancelAll) await entry.agent.cancelAll().catch(() => {}); } catch {}
      const p = this.closeSync(id, 'shutdown');
      if (p) closings.push(p);
    }
    if (this._inflight.size) await Promise.allSettled([...this._inflight]);
    for (const id of [...this.entries.keys()]) { const p = this.closeSync(id, 'shutdown'); if (p) closings.push(p); }
    // Wait out the graceful closes (each unpair is bounded) before the server process exits,
    // or the unpair would die with the socket and the node would linger until the next prune.
    if (closings.length) await Promise.allSettled(closings);
  }
}

module.exports = {SessionsHost, HostError, MAX_OPEN, IDLE_MS, NEW_SESSION, busyOf, approvalOf, activeOf, attachOptsOf};
