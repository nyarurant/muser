'use strict';
// Headless GUI server (docs/gui-protocol.md v1 + the v2 and v3 additions): the third muser front-end. It hosts the
// same Agent + Controller as the TUI — the Controller never needed the Ink view (view.mjs
// only subscribes to it and forwards keys), so serve swaps the view for HTTP + SSE here.
// Binds 127.0.0.1 only; every request needs the per-process Bearer token.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {MODES} = require('./policy.js');
const {inside, isSensitivePath, realOf} = require('./tools.js');
const {buildUiConfig} = require('./ui-config.js');
const {renameRetry} = require('./config.js');
const mention = require('./mentions.js');

const MAX_ENTRIES = 200; // /api/state and entries-reset carry only the newest entries
const FOCUS_EVIDENCE_TAIL = 40; // focusfix: distributed focus state carries only the newest evidence entries (Focus.modelState's trim)
const MAX_BODY = 1024 * 1024;
const SEND_MAX_BODY = 16 * 1024 * 1024; // v6: POST /send alone may carry base64 images
const ATTACH_MAX_COUNT = 8, ATTACH_MAX_TOTAL = 11 * 1024 * 1024; // v6: decoded image bytes per send
const ATTACH_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const STATE_DEBOUNCE_MS = 50; // bursts of Controller changes coalesce into one state event
const PLAN_REFRESH_MS = 5 * 60 * 1000; // gui-serve: a plan older than this is re-read in the background when the GUI reads state (at most once per window per conversation)
const DIFF_CAP = 200000; // v3: a per-file diff body is capped at 200k chars (truncated: true when capped)
const GIT_TIMEOUT_MS = 15000, GIT_DIFF_TIMEOUT_MS = 30000; // generous but bounded
const GIT_MAX_BUFFER = 32 * 1024 * 1024; // room for a big status/numstat/diff before the JS-side caps apply
const MAX_SSE_CLIENTS = 64; // c4#6 (deep #33): an unbounded set of half-open SSE subscribers otherwise pins conversations and CPU
const CHANGES_CACHE_MS = 1000; // c4#7 (deep #34): /api/changes re-runs up to 6 git commands per call — coalesce + briefly cache per cwd
const AVATAR_CACHE_TTL_MS = 5 * 60 * 1000; // c4#10 (deep #37): an avatar changed on muse.ai is re-read within minutes, not never

function defaultDiscoveryFile() { return path.join(os.homedir(), '.muser', 'gui.json'); }

// Deep-copy a value into plain JSON. Functions, AbortSignals (approval calls carry one),
// timers (a pending approval holds one) and circular references are dropped: none of them
// can cross the wire, and the approval request object would not stringify at all otherwise.
function plain(value) {
  try {
    const ancestors = [];
    const out = JSON.stringify(value, function (key, v) {
      if (typeof v === 'function') return undefined;
      if (v && typeof v === 'object') {
        if (v instanceof AbortSignal) return undefined;
        if (typeof v._onTimeout === 'function') return undefined; // a Node timer
        while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(v)) return undefined;
        ancestors.push(v);
      }
      return v;
    });
    return out === undefined ? null : JSON.parse(out);
  } catch { return null; }
}

// plain() a list item by item (audit #82): one unserialisable entry (a BigInt
// field, a throwing getter) used to fail the whole plain() call, so a single
// bad entry wiped the conversation's entire entry list to []. Bad items are
// dropped; the rest survive.
// The magic-byte signatures of the four accepted image types (audit #80).
function imageMagicMatches(type, bytes) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') { const head = bytes.subarray(0, 6).toString('ascii'); return head === 'GIF87a' || head === 'GIF89a'; }
  if (type === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

// serverfirst-debug G5: a wire string — a string stays itself, null and
// undefined become null, anything else is String()-ed when it safely can
// be and null when it cannot (a BigInt stringifies fine here, where
// plain()'s JSON round-trip would have given up on the whole object).
function wireString(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  try { return String(v); } catch { return null; }
}

function plainList(list) {
  if (!Array.isArray(list)) return plain(list);
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) { out.push(item ?? null); continue; }
    const p = plain(item);
    if (p !== null) { out.push(p); continue; }
    // The item as a whole failed: salvage it field by field, so a single
    // bad field costs that field, not the entry or the whole list.
    if (typeof item === 'object') {
      const salvaged = {};
      for (const key of Object.keys(item)) {
        try { const v = plain(item[key]); if (v !== null || item[key] === null) salvaged[key] = v; } catch {}
      }
      if (Object.keys(salvaged).length) { out.push(salvaged); continue; }
    }
    // Nothing salvageable: drop just this item.
  }
  return out;
}

// focusfix: shape the Focus state for distribution. snapshot() below is the one
// place /api/state and every SSE state frame are built from, and it used to ship
// plain(s.focus) verbatim, which had three problems:
//  1. evidence was the FULL log (Focus caps it at 300 entries of commands, paths
//     and output digests). The model-facing Focus.modelState() deliberately trims
//     to the newest 40 for size; the wire gets the same trim, plus evidenceTotal
//     so a client can tell older entries exist. The trim happens on the plain()
//     copy here — the Controller's live state is never mutated.
//  2. A focus object that reached the Controller without goal/status (some
//     emitters send partial shapes) left GUI/phone clients unable to say what
//     task a window is on — window-status.js had to re-add the goal on its own.
//     A missing goal is filled from the standing goal (the Controller state's
//     goal, else the agent's), and a missing status from whether the task is
//     waiting on the user (an ask or an open picker) or still running. Fields
//     the focus object already carries are never overwritten.
//  3. ask (the selectable-question choices) rode along whatever the status, so
//     a COMPLETED task still distributed a live picker: a client keying the
//     picker on ask presence could show it, and answering it would start a new
//     task. The choices — and the picker's live state (snapshot's `question`) —
//     are only live while the status is 'needs_input'. A snapshot with NO focus
//     at all keeps a `question` the Controller opened some other way, as before.
function focusForWire(s, a) {
  if (!s.focus) return null;
  const f = plain(s.focus);
  if (!f || typeof f !== 'object') return f;
  if (Array.isArray(f.evidence)) {
    f.evidenceTotal = f.evidence.length;
    if (f.evidence.length > FOCUS_EVIDENCE_TAIL) f.evidence = f.evidence.slice(-FOCUS_EVIDENCE_TAIL);
  }
  if (typeof f.goal !== 'string' || !f.goal) {
    const goal = s.goal?.text ?? (typeof a?.standingGoal === 'function' ? a.standingGoal()?.text : null);
    if (typeof goal === 'string' && goal) f.goal = goal;
  }
  if (typeof f.status !== 'string' || !f.status) f.status = (f.ask || s.question) ? 'needs_input' : 'running';
  if (f.status !== 'needs_input') f.ask = null;
  return f;
}

// gui-serve: the standing goal (/goal) itself, for the snapshot's `goal` field.
// The focus object above only borrows the goal's TEXT for its own goal field, so
// a GUI reopening had no way to learn that a goal stands (or when it was set, or
// how many auto-continuation legs it has run). The sources are the same ones
// focusForWire reads: the Controller state (s.goal, kept live by the agent's
// 'goal' event) first, then the agent's standingGoal() (session.goal). Only the
// fields the goal object actually carries cross the wire (plain(): text, legs,
// setAt today) — nothing is invented, and no goal (or a goal without text) is null.
function goalForWire(s, a) {
  let g = s?.goal ?? null;
  if (!g && typeof a?.standingGoal === 'function') { try { g = a.standingGoal(); } catch { g = null; } }
  if (!g || typeof g !== 'object') return null;
  const out = plain(g);
  if (!out || typeof out.text !== 'string' || !out.text) return null;
  return out;
}

// --- v3 git helpers (/api/changes) -------------------------------------------------------
// Git is always run read-only, in the agent's cwd, through execFile with an argument
// array (never a shell string), and file paths always go after a `--` separator.
function gitRun(cwd, args, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, timeout, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8'}, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

// Porcelain v1 -z: records are NUL-separated `XY <path>`; a rename/copy record carries
// the DESTINATION in its own field and the source path as the NEXT NUL field.
function parseStatusZ(text) {
  const fields = String(text).split('\0'), out = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2), filePath = rec.slice(3);
    let origPath = null;
    if (xy.includes('R') || xy.includes('C')) origPath = fields[++i] || null;
    out.push({path: filePath, origPath, status: statusKind(xy)});
  }
  return out;
}
function statusKind(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('C') || xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  return 'modified';
}

// diff --numstat -z: records are NUL-separated `<added>\t<deleted>\t<path>`; binary
// files report `-` for both counts, and a rename reports an EMPTY path field followed
// by the source and destination paths as the next two NUL fields.
function parseNumstatZ(text) {
  const fields = String(text).split('\0'), map = new Map();
  for (let i = 0; i < fields.length; i++) {
    const m = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(fields[i]);
    if (!m) continue;
    const counts = m[1] === '-' || m[2] === '-' ? null : {added: Number(m[1]) || 0, deleted: Number(m[2]) || 0};
    if (m[3]) map.set(m[3], counts);
    else { const dest = fields[i + 2]; if (dest) map.set(dest, counts); i += 2; }
  }
  return map;
}

class GuiServer {
  // Injected like the /reload callback, so tests can drive it with fakes:
  // {controller, agent, token, port} — token/port default to a fresh random token and an
  // OS-assigned free port. discoveryFile / version are optional overrides (tests, embedding).
  // v5 (remote/SERVER.md): {host} instead hosts every conversation of a SessionsHost;
  // the unprefixed routes then point at the host's default conversation and the same
  // routes also live under /api/s/:id/... per conversation. serverDiscoveryFile (or
  // MUSER_SERVER_FILE) additionally writes ~/.muser/server.json; onStop backs
  // POST /api/server/stop; accounts/recent providers are injectable for tests.
  constructor({controller, agent, token, port, version, discoveryFile, host, serverDiscoveryFile, onStop, accountsProvider, recentProvider, execSessionIds, setup, accountsAdmin} = {}) {
    this.setup = setup || null;
    // app-ui: the account registry / pool / config the /api/accounts routes use (tests inject a fake).
    this.accountsAdmin = accountsAdmin || null;
    // Setup mode (first-run preparation over HTTP, /api/setup): the server opens
    // before any conversation exists, so a setup flow alone is enough to build
    // one — the host arrives later through setHost(). Without setup, a
    // controller/agent (or a host) is required, as before.
    if (!host && !controller && !this.setup) throw new Error('GuiServer needs a controller');
    if (!host && !agent && !this.setup) throw new Error('GuiServer needs an agent');
    this.host = host || null;
    this.controller = controller || null;
    this.agent = agent || null;
    // Single-conversation mode wraps its pair as one entry, so every route below
    // speaks of entries only. In host mode the entry is the host's default.
    this.ownEntry = host || !agent || !controller ? null : {id: agent.session?.id || 'default', agent, controller, museName: controller.museName ?? null};
    this.token = token || crypto.randomBytes(32).toString('hex');
    this.requestedPort = port ?? 0;
    this.port = null;
    this._explicitVersion = version != null;
    this.version = version ?? controller?.version ?? host?.defaultEntry()?.controller?.version ?? require('../package.json').version;
    this.discoveryFile = discoveryFile || process.env.MUSER_GUI_FILE || defaultDiscoveryFile();
    this.serverDiscoveryFile = serverDiscoveryFile || process.env.MUSER_SERVER_FILE || null;
    this.onStop = onStop || null;
    this.accountsProvider = accountsProvider || null;
    this.recentProvider = recentProvider || null;
    this.execSessionIds = execSessionIds || null; // () => Set of exec-run conversation ids (tests inject)
    this.link = null; // src/link/link.js Link, attached by serve() once it is up (muser link)
    this.clients = new Set(); // the default entry's SSE clients (kept for compat)
    this.serverClients = new Set(); // /api/server/events clients
    this.attached = new Map(); // entry -> {clients, unsubscribe}
    this.server = null;
    // Deep H1: every approval / menu shown gets a unique id (see snapshot()),
    // keyed by the object itself, so a POST can be bound to the object the
    // client actually saw. A replaced object gets a fresh id; the same object
    // keeps its id across snapshots.
    this._approvalIds = new WeakMap(); this._menuIds = new WeakMap(); this._questionIds = new WeakMap();
    this._approvalSeq = 0; this._menuSeq = 0; this._questionSeq = 0;
    // serverfirst: question ids a /send answer was already accepted for (see
    // the questionId guard in dispatch). Bounded: only the newest ids are
    // remembered, which covers any realistic double-answer window.
    this._answeredQuestionIds = new Set(); this._answeredQuestionOrder = [];
    this._changesCache = new Map(); // cwd -> {at, promise} (c4#7)
    this.changesCacheMs = CHANGES_CACHE_MS; // tests may shrink/disable it
    this.planRefreshMs = PLAN_REFRESH_MS; // tests may shrink it (see maybeRefreshPlan)
    this.avatarCacheMs = AVATAR_CACHE_TTL_MS;
    this._starting = null; // #64: the in-flight start() promise, shared by concurrent callers
    this.eventsHeartbeatMs = 25000; // SSE keep-alive cadence; an open stream also touches its host entry (#61)
    this.unsubscribe = null;
    this.startedAt = null;
    this._hostListener = null;
    this._setupListener = null;
  }

  // The setup flow's current plain state, or the finished state when this
  // server has no setup flow (preparation already done before it opened).
  setupState() {
    if (!this.setup) return {phase: 'done'};
    try { return this.setup.state() || {phase: 'done'}; } catch { return {phase: 'done'}; }
  }
  setupPhase() { return this.setupState()?.phase || 'done'; }

  // Hand the conversations to a server that opened in setup mode: the same
  // port/token keep serving, the hosted entries are attached, the host's
  // events start flowing, and the discovery file is rewritten so gui.json
  // names the default conversation's sessionId.
  setHost(host) {
    if (!host) throw new Error('GuiServer.setHost needs a host');
    this.host = host;
    if (!this._explicitVersion) {
      const v = host.defaultEntry()?.controller?.version;
      if (v != null) this.version = v;
    }
    for (const entry of this.allEntries()) this.attachEntry(entry);
    this.attachHostListener();
    if (this.port) this.writeDiscovery();
    return this;
  }
  attachHostListener() {
    if (!this.host || this._hostListener) return;
    this._hostListener = event => {
      if (event?.type === 'session-opened') { const e = this.host.get(event.sessionId); if (e) this.attachEntry(e); }
      if (event?.type === 'session-closed') this.detachEntry(event.sessionId);
      this.broadcastServerEvent(event);
    };
    this.host.on('event', this._hostListener);
  }
  attachSetupListener() {
    if (!this.setup || this._setupListener || typeof this.setup.on !== 'function') return;
    this._setupListener = () => this.broadcastSetup();
    this.setup.on('change', this._setupListener);
  }
  broadcastSetup() {
    if (!this.setup) return;
    const setup = this.setupState();
    for (const client of [...this.serverClients]) {
      try { client.res.write('data: ' + JSON.stringify({kind: 'setup', setup}) + '\n\n'); } catch { this.dropServerClient(client); }
    }
  }
  // Deep H1: the stable per-object id for an approval or menu, assigned on
  // first sight (in a snapshot or an answer attempt) and never reused.
  objectId(map, seqKey, prefix, obj) {
    if (!obj || typeof obj !== 'object') return null;
    let id = map.get(obj);
    if (!id) { id = prefix + (++this[seqKey]); map.set(obj, id); }
    return id;
  }
  approvalIdOf(ap) { return this.objectId(this._approvalIds, '_approvalSeq', 'approval-', ap); }
  menuIdOf(menu) { return this.objectId(this._menuIds, '_menuSeq', 'menu-', menu); }
  questionIdOf(q) { return this.objectId(this._questionIds, '_questionSeq', 'question-', q); }
  // Remember that a question answer was accepted, so a duplicate /send
  // carrying the same questionId is refused even while the picker is still
  // closing (or a same-shaped picker has opened since).
  markQuestionAnswered(id) {
    if (id === undefined || id === null) return;
    const key = String(id);
    if (!this._answeredQuestionIds.has(key)) { this._answeredQuestionIds.add(key); this._answeredQuestionOrder.push(key); }
    while (this._answeredQuestionOrder.length > 100) this._answeredQuestionIds.delete(this._answeredQuestionOrder.shift());
  }
  // Undo a mark (serverfirst-debug G1): the guard now burns the id BEFORE
  // submit, and a submit that then fails at once must hand the question
  // back — a refused send never eats the question it meant to answer.
  unmarkQuestionAnswered(id) {
    const key = String(id);
    if (!this._answeredQuestionIds.delete(key)) return;
    const i = this._answeredQuestionOrder.indexOf(key);
    if (i >= 0) this._answeredQuestionOrder.splice(i, 1);
  }
  get url() { return 'http://127.0.0.1:' + this.port; }
  defaultEntry() { return this.host ? this.host.defaultEntry() : this.ownEntry; }
  resolveEntry(id) { return this.host ? this.host.get(id) : (this.ownEntry && this.ownEntry.id === id ? this.ownEntry : null); }
  allEntries() { return this.host ? [...this.host.entries.values()] : this.ownEntry ? [this.ownEntry] : []; }
  state(entry) { const c = (entry || this.defaultEntry())?.controller; return c ? (c.s || c.get()) : {}; }

  // gui-serve: the weekly plan in the snapshot is only re-read by the Controller
  // at a turn's end (and a few other moments), so a conversation left open in
  // serve kept showing hours-old usage — and two conversations on one account
  // could disagree (66% here, 100% there). When the GUI reads state (GET
  // /api/state, or subscribing to the state SSE), a plan that is stale — never
  // read, or the same plan object has been on show for over planRefreshMs — is
  // re-read in the BACKGROUND: the answer is not waited for, and the fresh plan
  // reaches the GUI through the ordinary Controller-change state event once it
  // lands. The entry remembers (on itself, serve-side only) which plan object
  // was last seen and when, plus the last refresh attempt: attempts are capped
  // at one per planRefreshMs per conversation, so a failing read is not retried
  // on every poll (refreshPlan itself still shares one in-flight read). The
  // demo is offline and refreshPlan already no-ops there; it is skipped here
  // too, so a demo entry never even records an attempt.
  maybeRefreshPlan(entry) {
    const controller = entry?.controller;
    if (!entry || !controller || typeof controller.refreshPlan !== 'function') return false;
    if (entry.agent?.client?.status === 'demo') return false;
    const now = Date.now();
    let plan = null;
    try { plan = this.state(entry)?.plan ?? null; } catch { plan = null; }
    if (plan !== entry._planSeen) { entry._planSeen = plan; entry._planSeenAt = now; }
    if (plan && entry._planSeenAt && now - entry._planSeenAt < this.planRefreshMs) return false; // still fresh
    if (entry._planRefreshAt && now - entry._planRefreshAt < this.planRefreshMs) return false; // rate cap
    entry._planRefreshAt = now;
    try { Promise.resolve(controller.refreshPlan()).catch(() => {}); } catch {}
    return true;
  }

  // The /api/state snapshot (docs/gui-protocol.md). Entries are the Controller's own entry
  // objects (plain JSON, newest 200); approval is the pending request itself, minus the
  // parts that cannot cross JSON (resolve, its expiry timer, the call's abort signal).
  snapshot(entry, withEntries = true) {
    if (entry === undefined || typeof entry === 'boolean') { withEntries = entry === undefined ? true : entry; entry = this.defaultEntry(); }
    if (!entry) return {version: this.version, session: {id: null, turns: 0}, entries: withEntries ? [] : undefined, ...(this.setup ? {setup: {phase: this.setupPhase()}} : {})};
    const s = this.state(entry), a = entry.agent, ap = s.approval;
    const focus = focusForWire(s, a); // focusfix: trimmed evidence, goal/status filled, ask gated (see focusForWire)
    // serverfirst: the picker state (see the `question` field below), with its
    // Deep H1-style id folded in — a client answering through POST /send names
    // this id as `questionId`, and the server refuses a second answer.
    const question = s.question && (!focus || focus.status === 'needs_input') ? plain(s.question) : null;
    if (question && typeof question === 'object') question.id = this.questionIdOf(s.question);
    // serverfirst-debug G5/G6/Y1: the three fields below are picked field
    // by field, never whole-object passthroughs. promptFor's message is
    // normalised to a string like the menu label (a BigInt message used to
    // make plain() return null for the whole prompt, so a genuinely
    // pending prompt crossed as null); addFlow crosses as exactly the
    // {lines, busy} its comment always claimed (extra/internal fields no
    // longer leak to every client, and one bad field no longer nulls the
    // whole add screen); accountReserved goes through plain() like every
    // other field, so a non-JSON value cannot throw inside the snapshot's
    // own JSON.stringify and 500 the whole state read.
    let promptFor = null, addFlow = null;
    if (s.promptFor) { try { promptFor = {message: wireString(s.promptFor.message)}; } catch { promptFor = {message: null}; } }
    if (s.addFlow) {
      let lines = [], busy = null;
      try { if (Array.isArray(s.addFlow.lines)) lines = s.addFlow.lines.map(x => wireString(x)).filter(x => x !== null); } catch {}
      try { busy = wireString(s.addFlow.busy); } catch {}
      addFlow = {lines, busy};
    }
    const accountReserved = s.accountReserved != null ? plain(s.accountReserved) : null;
    const snap = {
      version: this.version,
      cwd: a.cwd ?? null,
      session: {id: a.session?.id ?? null, turns: a.session?.turns ?? 0, title: a.session?.title ?? null},
      mode: s.mode ?? a.mode ?? null,
      busy: !!s.busy,
      queue: [...(s.queue || [])],
      approval: ap ? plain({id: this.approvalIdOf(ap), call: ap.call, preview: ap.preview ?? null, options: ap.options, index: ap.index ?? 0, outside: !!ap.outside, loreGrave: ap.loreGrave ?? null}) : null,
      shells: (s.shells || []).map(sh => ({id: sh.id, command: sh.command, running: !!sh.running})),
      focus,
      goal: goalForWire(s, a),
      todos: plain(s.todos) || [],
      agents: plain(s.agents) || [],
      plan: s.plan ? plain(s.plan) : null,
      account: s.account ? plain(s.account) : null,
      // serverfirst (out-CL §1): the three fields the remote Controller
      // already consumes (remote-controller.mjs applySnapshot) but no
      // snapshot ever sent, so /account add's screen, its prompt and the
      // reserved-account lane could never appear in a client window.
      // promptFor's live object carries resolve/reject closures; the wire
      // shape is exactly the data a front-end renders: {message}.
      // addFlow is {lines, busy}; accountReserved is the label string of
      // the account a switch is reserved for, or null. All three are
      // picked and normalised above (see the G5/G6/Y1 note).
      promptFor,
      addFlow,
      accountReserved,
      // Who the user works with (the TUI's Muse name, e.g. "kaguya") and the word Muse picked
      // for its spinner this turn (spinner.set; null until it picks one).
      muse: {name: entry.controller.museName ?? entry.museName ?? null},
      spinnerWord: s.spinnerWord ?? null,
      // v5: the Controller's pick-one menu (src/ui/controller.mjs openMenu), in a
      // form that can cross JSON: options carry their plain values, and the pick
      // itself stays server-side — POST .../menu {value} resolves it (see menuPick).
      // Without this, /account, /settings, the quota choice and friends were
      // visible in the TUI but unreachable from any other front-end.
      menu: s.menu ? {
        id: this.menuIdOf(s.menu),
        title: s.menu.title ?? null,
        hint: s.menu.hint ?? null,
        index: s.menu.index ?? 0,
        current: plain(s.menu.current ?? null),
        // serverfirst (out-CL §1): the local menu's `side` is a paging
        // closure (controller.mjs menuKey: ←/→ turn the /resume folder
        // pages) and cannot cross JSON; the wire carries whether paging
        // exists, and POST .../menu {side: -1|1} invokes it server-side
        // (see menuSide). Each option's `group` (the /settings genre
        // heading, view.mjs) is plain data and rides along as-is.
        side: typeof s.menu.side === 'function',
        options: (s.menu.options || []).map(o => ({
          value: plain(o?.value ?? null),
          label: typeof o?.label === 'string' ? o.label : String(o?.value ?? ''),
          ...(typeof o?.desc === 'string' ? {desc: o.desc} : {}),
          ...(typeof o?.group === 'string' ? {group: o.group} : {}),
          ...(o?.danger ? {danger: true} : {}),
          ...(o?.mark ? {mark: true} : {}),
        })),
      } : null,
      // v6: the live bottom-of-screen state the TUI draws from (view.mjs) — a
      // client front-end (the CLI as a client) needs the running call, the
      // !command row, the stream tail and the status line, not just busy.
      // The stream carries only its tail: partial can grow without bound.
      live: {
        // `table`: the reply's table lines held back until the table ends (md.mjs feed), only
        // while there are some; bounded like partial.
        stream: s.stream ? {id: s.stream.id ?? null, started: s.stream.started ?? null, partial: String(s.stream.partial ?? '').slice(-8192),
          ...(s.stream.table?.length ? {table: s.stream.table.slice(-100).map(l => String(l).slice(0, 2000))} : {})} : null,
        running: plain(s.running),
        bangRunning: plain(s.bangRunning),
        status: s.status ?? '',
        activity: s.activity ?? '',
        museRunning: s.museRunning ?? '',
        agentWords: plain(s.agentWords) ?? [],
        turnStart: s.turnStart ?? 0,
        flash: s.flash ?? '',
        deviceOk: !!s.deviceOk,
        loginNeeded: !!s.loginNeeded,
      },
      // v6: approvals waiting behind the one on screen (Controller.pending,
      // ask() queues there while an approval or a reason prompt is open).
      approvalQueue: entry.controller.pending?.length ?? 0,
      reasonFor: !!s.reasonFor,
      // v6: the pending numeric input (limitKey), picked down to the fields a
      // client renders — text is the current edit buffer; back/done/limits and
      // the other closures stay server-side (POST /limit answers it).
      limitInput: s.limitInput ? plain({key: s.limitInput.key, label: s.limitInput.label, text: s.limitInput.text, min: s.limitInput.min, max: s.limitInput.max, hint: s.limitInput.hint}) : null,
      // The selectable question open in the TUI (focus.ask_user with options): the
      // choices themselves ride in focus.ask above; this is the picker's live state
      // (tab, checks, typed answers), plain data only — a client answers by sending
      // the composed reply as a normal message, like the phone page did.
      // focusfix: like focus.ask, the picker state is only distributed while the
      // focus status is 'needs_input' — a completed task must not ship a live
      // picker. With no focus at all there is no status to gate on, so a picker
      // the Controller opened some other way still rides, as before.
      // serverfirst: the object also carries `id` (assigned above); a client
      // that answers SHOULD send it back as `questionId` in the /send body —
      // the server then refuses a second answer with 409 (see dispatch).
      question,
      clientStatus: a.client?.status ?? null,
      device: {name: a.constructor?.DEVICE ?? null, slot: a.nodeSlot?.slot ?? null, connected: !!a.device?.connected},
      update: s.update ? plain(s.update) : null,
      // app-ui: a text question the Controller is waiting on (promptAsk: an account's name,
      // the contact / code of the device registration) — only its words; the answer is a
      // send or POST /api/prompt. The account-add screen (addFlow) and accountReserved
      // are the sanitised fields above (release-039 merge: app-ui had added raw copies of
      // both here, which overrode them and let a non-JSON value 500 the state read).
      prompt: promptFor ? {message: promptFor.message ?? ''} : null,
    };
    if (this.setup) snap.setup = {phase: this.setupPhase()};
    if (withEntries) snap.entries = plainList((s.entries || []).slice(-MAX_ENTRIES));
    return snap;
  }

  // Audit #64: the http server used to be assigned to this.server BEFORE
  // listen() succeeded, so a listen error (port in use) left this.server set
  // and every later start() silently "succeeded" without listening — a retry
  // was impossible. A concurrent start() likewise returned at once with
  // this.port still null. Now one in-flight attempt is shared by concurrent
  // callers, and a failed attempt clears its state so start() can be retried.
  start() {
    if (this.server && this.port) return Promise.resolve(this);
    if (this._starting) return this._starting;
    const starting = (async () => {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        try { if (!res.headersSent) res.writeHead(500, {'content-type': 'application/json'}); res.end(JSON.stringify({error: 'internal error'})); } catch {}
      });
    });
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.requestedPort, '127.0.0.1', resolve);
      });
    } catch (e) {
      if (this.server === server) this.server = null;
      try { server.close(() => {}); } catch {}
      throw e;
    }
    this.port = server.address().port;
    this.startedAt = Date.now();
    for (const entry of this.allEntries()) this.attachEntry(entry);
    this.attachHostListener();
    this.attachSetupListener();
    await this.writeDiscoveryChecked();
    return this;
    })();
    this._starting = starting;
    const clearStarting = () => { if (this._starting === starting) this._starting = null; };
    starting.then(clearStarting, clearStarting);
    return starting;
  }

  // Per-entry SSE bookkeeping: each hosted conversation forwards its own
  // Controller changes to its own /api/s/:id/events (or /api/events) clients.
  attachEntry(entry) {
    if (!entry || this.attached.has(entry)) return;
    const att = {clients: new Set(), unsubscribe: null};
    if (entry === this.defaultEntry()) this.clients = att.clients;
    att.unsubscribe = typeof entry.controller?.subscribe === 'function' ? entry.controller.subscribe(() => this.onControllerChange(entry, att)) : null;
    this.attached.set(entry, att);
  }
  detachEntry(id) {
    for (const [entry, att] of [...this.attached]) {
      if (entry.id !== id) continue;
      if (att.unsubscribe) { try { att.unsubscribe(); } catch {} }
      for (const client of [...att.clients]) this.dropClient(client, att);
      this.attached.delete(entry);
    }
  }

  async close() {
    if (this.setup && this._setupListener) { try { this.setup.removeListener('change', this._setupListener); } catch {} this._setupListener = null; }
    if (this.host && this._hostListener) { try { this.host.removeListener('event', this._hostListener); } catch {} this._hostListener = null; }
    for (const [, att] of [...this.attached]) {
      if (att.unsubscribe) { try { att.unsubscribe(); } catch {} att.unsubscribe = null; }
      for (const client of [...att.clients]) this.dropClient(client, att);
    }
    this.attached.clear();
    for (const client of [...this.serverClients]) this.dropServerClient(client);
    this.removeDiscovery();
    if (this.server) {
      const server = this.server; this.server = null;
      await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
    }
  }

  // Audit #65 (gui-server side): whether a discovery file already belongs to
  // a DIFFERENT process that is still alive. probeServer (discovery.js) now
  // retries before calling a server dead, but a rival that still reaches
  // start() must not overwrite the live server's file here — that overwrite
  // orphaned the real server (discovery, and with it `server stop`, pointed
  // at the rival). Same ownership test removeDiscoveryFile() already uses.
  discoveryOwnedByLiveOther(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data.pid !== 'number' || data.pid === process.pid) return false;
      try { process.kill(data.pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
    } catch { return false; }
  }
  writeDiscoveryFile(file, data, force = false) {
    if (!force && this.discoveryOwnedByLiveOther(file)) return;
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(tmp, JSON.stringify(data));
      renameRetry(tmp, file);
    } catch { try { fs.unlinkSync(tmp); } catch {} }
  }
  // c4#9 (deep #36): "the pid in the file is alive" alone is not ownership —
  // after a crash the pid can be REUSED by an unrelated process, and the
  // pid-only test then stopped the real (new) server from ever writing
  // discovery again. Probe the address the file advertises: it is a live
  // muser server only if it answers /api/server with the file's own token
  // and reports the file's pid. Anything else (refused, another program,
  // a stale port) means the file is stale and may be overwritten.
  probeDiscoveryServer(data) {
    return new Promise(resolve => {
      if (!data || typeof data.port !== 'number' || !data.token) return resolve(false);
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      let req;
      try {
        req = http.get({host: '127.0.0.1', port: data.port, path: '/api/server', headers: {authorization: 'Bearer ' + data.token}, timeout: 400}, res => {
          let text = '';
          res.on('data', c => { text += c; if (text.length > 65536) req.destroy(); });
          res.on('end', () => { try { finish(res.statusCode === 200 && JSON.parse(text)?.pid === data.pid); } catch { finish(false); } });
        });
      } catch { return finish(false); }
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
    });
  }
  // The start()-time discovery write, with the probe above: a file owned by
  // a VERIFIED live server is left alone (audit #65); a file whose pid was
  // merely reused is overwritten.
  async writeDiscoveryChecked() {
    const def = this.defaultEntry();
    const jobs = [[this.discoveryFile, {pid: process.pid, port: this.port, token: this.token, cwd: def?.agent?.cwd ?? null, sessionId: def?.agent?.session?.id ?? null, startedAt: this.startedAt}]];
    if (this.serverDiscoveryFile) jobs.push([this.serverDiscoveryFile, {pid: process.pid, port: this.port, token: this.token, version: this.version, startedAt: this.startedAt}]);
    for (const [file, data] of jobs) {
      if (!this.discoveryOwnedByLiveOther(file)) { this.writeDiscoveryFile(file, data); continue; }
      let stale = null;
      try { stale = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (await this.probeDiscoveryServer(stale)) continue; // a real live server owns it
      this.writeDiscoveryFile(file, data, true);
    }
  }
  // ~/.muser/gui.json, written atomically (temp + rename) so a reader never sees half a file.
  // v5 adds ~/.muser/server.json ({pid, port, token, version, startedAt}) for the
  // resident server: `muser server status/stop` and the second-serve attach read it.
  writeDiscovery() {
    const def = this.defaultEntry();
    this.writeDiscoveryFile(this.discoveryFile, {pid: process.pid, port: this.port, token: this.token, cwd: def?.agent?.cwd ?? null, sessionId: def?.agent?.session?.id ?? null, startedAt: this.startedAt});
    if (this.serverDiscoveryFile) this.writeDiscoveryFile(this.serverDiscoveryFile, {pid: process.pid, port: this.port, token: this.token, version: this.version, startedAt: this.startedAt});
  }
  removeDiscoveryFile(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.token === this.token && data.pid === process.pid) fs.unlinkSync(file);
    } catch {}
  }
  removeDiscovery() {
    this.removeDiscoveryFile(this.discoveryFile);
    if (this.serverDiscoveryFile) this.removeDiscoveryFile(this.serverDiscoveryFile);
  }

  authorized(req) {
    const header = req.headers.authorization || '';
    const expected = Buffer.from('Bearer ' + this.token), given = Buffer.from(header);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async handle(req, res) {
    if (!this.authorized(req)) return this.json(res, 401, {error: 'unauthorized'});
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    // First-run setup (setup mode): server-level routes, answered before any
    // conversation route — like /api/server/* below, and deliberately NOT in
    // the phone channel's allowlist (src/link/channel-server.js), so a paired
    // phone can never answer setup questions. Answers carry credentials, so
    // every setup response is no-store. The Bearer check above applies as usual.
    if (req.method === 'GET' && p === '/api/setup') return this.jsonNoStore(res, 200, this.setupState());
    if (req.method === 'POST' && p === '/api/setup/answer') {
      const body = await this.readBody(req, res); if (body === null) return;
      if (!this.setup) return this.jsonNoStore(res, 409, {error: 'setup is not running'});
      const arg = {promptId: body.promptId};
      if ('value' in body) arg.value = body.value;
      if ('index' in body) arg.index = body.index;
      try { await this.setup.answer(arg); } catch (e) { return this.jsonNoStore(res, e.status || 400, {error: e.message}); }
      return this.jsonNoStore(res, 200, {ok: true});
    }
    if (req.method === 'POST' && p === '/api/setup/start') {
      const body = await this.readBody(req, res).catch(() => null); if (body === null) return;
      if (!this.setup) return this.jsonNoStore(res, 409, {error: 'setup is not running'});
      let started;
      try { started = this.setup.start(); } catch (e) { return this.jsonNoStore(res, e.status || 400, {error: e.message}); }
      if (started && typeof started.then === 'function') {
        // Do not wait for the flow to finish — only surface an immediate
        // refusal (already running -> 409), which settles within a tick.
        let refusal = null;
        started.then(() => {}, e => { refusal = e; });
        await new Promise(r => setImmediate(r));
        if (refusal) return this.jsonNoStore(res, refusal.status || 400, {error: refusal.message});
      }
      return this.jsonNoStore(res, 200, {ok: true});
    }
    if (req.method === 'POST' && p === '/api/setup/cancel') {
      const body = await this.readBody(req, res).catch(() => null); if (body === null) return;
      if (!this.setup) return this.jsonNoStore(res, 409, {error: 'setup is not running'});
      try { this.setup.cancel(); } catch (e) { return this.jsonNoStore(res, e.status || 400, {error: e.message}); }
      return this.jsonNoStore(res, 200, {ok: true});
    }
    // v5 server-wide routes (remote/SERVER.md): about the server itself, not one
    // conversation. They answer in single-conversation mode too (one session),
    // except the session-opening ones, which need a SessionsHost.
    if (req.method === 'GET' && p === '/api/server') return this.json(res, 200, this.serverInfo());
    // app-ux: the GUI theme for paired clients (read-only; see ui-config.js).
    if (req.method === 'GET' && p === '/api/ui-config') return this.json(res, 200, buildUiConfig());
    if (req.method === 'GET' && p === '/api/server/events') return this.serverEvents(req, res);
    if (req.method === 'POST' && p === '/api/server/stop') {
      // c4#2 (deep #29): a body readBody already refused (400/413, null) must
      // not run the side effect — the stop used to be scheduled anyway.
      const stopBody = await this.readBody(req, res).catch(() => null);
      if (stopBody === null) return;
      if (!this.onStop) return this.json(res, 501, {error: 'stop is not available'});
      this.json(res, 200, {ok: true});
      setTimeout(() => { Promise.resolve(this.onStop()).catch(() => {}); }, 10).unref?.();
      return;
    }
    // muser link (remote/DESIGN.md): pairing and paired-device management for
    // the phone link running inside this server. Local token only, like the rest.
    if (req.method === 'GET' && p === '/api/server/link') {
      if (!this.link) return this.json(res, 501, {error: 'link is not running'});
      return this.json(res, 200, {link: this.linkState()});
    }
    if (req.method === 'POST' && p === '/api/server/link/pair') {
      const body = await this.readBody(req, res); if (body === null) return;
      if (!this.link) return this.json(res, 501, {error: 'link is not running'});
      const mode = body.mode === 'wifi' ? 'wifi' : 'qr';
      try {
        const {code, expiresAt} = this.link.startPairing({mode});
        const {buildPairPayload} = require('./link/link');
        const payload = mode === 'qr' ? buildPairPayload({pcId: this.link.pcId, staticPub: this.link.keys.noise.publicKey, relay: this.link.relayUrl, code, name: require('node:os').hostname(), lan: this.link.lanAddresses()}) : null;
        return this.json(res, 200, {mode, code, expiresAt, payload});
      } catch (e) { return this.json(res, 400, {error: e.message}); }
    }
    if (req.method === 'POST' && p === '/api/server/link/revoke') {
      const body = await this.readBody(req, res); if (body === null) return;
      if (!this.link) return this.json(res, 501, {error: 'link is not running'});
      const target = body.id || body.name;
      if (!target) return this.json(res, 400, {error: 'id or name is required'});
      const removed = this.link.remoteStore.remove(String(target));
      if (!removed) return this.json(res, 404, {error: 'no such device'});
      // First #5: removing the store entry alone left a CONNECTED device's
      // channel alive indefinitely (channel-server only checked the store
      // at connect time). Revocation must also terminate that device's live
      // channels; D's channel revalidation is the backstop for channels this
      // best-effort sweep cannot identify (see terminateRevokedDevice).
      const terminated = this.terminateRevokedDevice(removed.id || String(target), removed);
      return this.json(res, 200, {ok: true, terminated});
    }
    if (req.method === 'GET' && p === '/api/sessions') return this.sessionList(url, res);
    if (req.method === 'POST' && p === '/api/sessions') {
      const body = await this.readBody(req, res); if (body === null) return;
      if (!this.host) return this.json(res, 501, {error: 'session hosting is not enabled'});
      // serverfirst (out-CL §1): the attach values discovery.js forwards
      // (--max-agents / --max-agents-total / --no-focus) ride along to the
      // host, which validates and passes them to the conversation factory.
      try { const entry = await this.host.openNew({cwd: body.cwd, account: body.account, mode: body.mode, maxAgents: body.maxAgents, maxAgentsTotal: body.maxAgentsTotal, focusEnabled: body.focusEnabled, noFocus: body.noFocus}); return this.json(res, 201, {id: entry.id}); }
      catch (e) { return this.json(res, e.status || 400, {error: e.message}); }
    }
    const openMatch = /^\/api\/sessions\/([^/]+)\/open$/.exec(p);
    if (req.method === 'POST' && openMatch) {
      const openBody = await this.readBody(req, res).catch(() => null);
      if (openBody === null) return; // c4#2: refused body, no open
      if (!this.host) return this.json(res, 501, {error: 'session hosting is not enabled'});
      try { const entry = await this.host.openExisting(decodeURIComponent(openMatch[1]), {maxAgents: openBody.maxAgents, maxAgentsTotal: openBody.maxAgentsTotal, focusEnabled: openBody.focusEnabled, noFocus: openBody.noFocus}); return this.json(res, 200, {id: entry.id, ...(entry.attachDropped ? {attachApplied: false} : {})}); }
      catch (e) { return this.json(res, e.status || 400, {error: e.message}); }
    }
    const closeMatch = /^\/api\/sessions\/([^/]+)\/close$/.exec(p);
    if (req.method === 'POST' && closeMatch) {
      const closeBody = await this.readBody(req, res).catch(() => null);
      if (closeBody === null) return; // c4#2: refused body, no close
      if (!this.host) return this.json(res, 501, {error: 'session hosting is not enabled'});
      try { this.host.close(decodeURIComponent(closeMatch[1])); return this.json(res, 200, {ok: true}); }
      catch (e) { return this.json(res, e.status || 400, {error: e.message}); }
    }
    // app-ui: the account registry (muser account list / use / auto / remove, and rename),
    // for clients that cannot run the CLI on this PC (the phone). Switching a
    // conversation's account and adding one are per-conversation (POST /api/account).
    if (p === '/api/accounts' || p.startsWith('/api/accounts/')) return this.accountsRoute(req, res, p);
    // Per-conversation routes: /api/s/:id/... names a conversation; the unprefixed
    // routes (v1-v4) keep pointing at the default conversation, unchanged.
    const sMatch = /^\/api\/s\/([^/]+)(\/.*)$/.exec(p);
    if (sMatch) {
      const entry = this.resolveEntry(decodeURIComponent(sMatch[1]));
      if (!entry) return this.json(res, 404, {error: 'unknown session'});
      return this.dispatch(entry, req, res, url, '/api' + sMatch[2]);
    }
    const entry = this.defaultEntry();
    if (!entry) {
      // Setup mode (no conversation yet, a first-run setup still running):
      // /api/state answers the empty snapshot plus the setup phase; every other
      // conversation route keeps the usual no-conversation 404. Without a
      // pending setup (e.g. the default conversation was closed, gui #59) the
      // unprefixed state route stays a 404 as before.
      if (req.method === 'GET' && p === '/api/state' && this.setup && this.setupPhase() !== 'done') return this.json(res, 200, this.snapshot());
      return this.json(res, 404, {error: 'no conversation open'});
    }
    return this.dispatch(entry, req, res, url, p);
  }

  // Everything one conversation answers (the v1-v4 routes, plus v5's menu pick),
  // against one hosted entry.
  async dispatch(entry, req, res, url, p) {
    // Audit #61: "used" used to mean ANY request reaching here, at its start
    // only. Observation is not use: a forgotten GET poller (state/entries/…)
    // refreshed the idle timer forever, while a conversation watched only
    // through its long-lived SSE stream was never touched again after the
    // stream opened and was idle-closed at 30 min. Actions (every POST)
    // touch; the SSE stream touches for as long as it stays open (events()).
    if (req.method !== 'GET') this.host?.touch(entry.id);
    const controller = entry.controller, agent = entry.agent;
    if (req.method === 'GET' && p === '/api/state') { this.maybeRefreshPlan(entry); return this.json(res, 200, this.snapshot(entry, true)); }
    if (req.method === 'GET' && p === '/api/events') return this.events(entry, req, res);
    if (req.method === 'GET' && p === '/api/complete') return this.complete(entry, url, res);
    if (req.method === 'GET' && p === '/api/changes') return this.changes(entry, url, res);
    if (req.method === 'GET' && p === '/api/muse-avatar') return this.museAvatar(entry, res, url.searchParams.get('video'));
    if (req.method === 'GET' && p === '/api/image') return this.workspaceImage(entry, res, url.searchParams.get('path'));
    if (req.method === 'GET' && p === '/api/outputs') return this.outputs(entry, url, res);
    if (req.method === 'GET' && p === '/api/entries') return this.entriesPage(entry, url, res);
    if (req.method === 'POST' && p === '/api/send') {
      // v6: this route alone gets the bigger body cap — base64 images ride in it.
      const body = await this.readBody(req, res, SEND_MAX_BODY); if (body === null) return;
      if (body.text !== undefined && typeof body.text !== 'string') return this.json(res, 400, {error: 'text must be a string'});
      const text = typeof body.text === 'string' ? body.text : '';
      let attachments = null;
      if (body.attachments !== undefined) {
        attachments = this.validateAttachments(body.attachments);
        if (!attachments) return this.json(res, 400, {error: 'attachments must be at most 8 images (image/png, image/jpeg, image/gif or image/webp, base64, 11 MB total)'});
      }
      const hasAttachments = !!(attachments && attachments.length);
      // Audit #77: an image-only send is valid — the Controller itself falls
      // back to its "look at this image" wording for a text-less turn.
      if (!text.trim() && !hasAttachments) return this.json(res, 400, {error: 'text is required'});
      const st0 = this.state(entry);
      // serverfirst (out-CL §6): the ask_user double-answer guard. A question
      // answer is a plain /send, so without correlation the second front-end's
      // answer landed as an ordinary chat message after the first answer had
      // already closed the picker. A body may carry `questionId` — the `id`
      // of the snapshot's question object it answers. When it does, the send
      // is bound to that question exactly like an approvalId: no question
      // open, a different question open, or this id already answered are all
      // the same refusal — 409 {error: 'question already answered',
      // code: 'question_answered'} — and the send never reaches submit().
      // First answer wins. Sends without questionId are unchanged (legacy
      // clients, the phone page, plain chat while a picker is open).
      // serverfirst-debug G2: only a non-empty STRING engages the guard.
      // The old String() coercion let ["question-1"] pass as a valid id and
      // made "" / 0 / false / {} count as "present", refusing plain chat
      // sends with a bogus question_answered; any other shape is ignored,
      // exactly like a send without the field.
      const questionId = typeof body.questionId === 'string' && body.questionId !== '' ? body.questionId : null;
      if (questionId !== null) {
        // serverfirst-debug G3: the guard judges the same question the
        // snapshot shows — gated on the Focus status (needs_input), like
        // snapshot() — not the raw state field, so an id picked up while
        // the task waited cannot be answered after the status moved on.
        const focus0 = focusForWire(st0, entry.agent);
        const open = st0?.question && (!focus0 || focus0.status === 'needs_input') ? st0.question : null;
        if (this._answeredQuestionIds.has(questionId) || !open || questionId !== this.questionIdOf(open))
          return this.json(res, 409, {error: 'question already answered', code: 'question_answered'});
        // serverfirst-debug G4: the answer must actually REACH the
        // question. submit() answers a pending decline reason or prompt
        // first and drops plain sends during an account add (after closing
        // the picker), so in those states this send would burn the id and
        // close the picker without answering it. Refuse instead; the
        // picker stays open for a later answer.
        if (st0?.reasonFor || st0?.promptFor || controller.addingAccount)
          return this.json(res, 409, {error: 'question already answered', code: 'question_answered'});
        // serverfirst-debug G1: burn the id BEFORE submit, not after.
        // submit clears the picker asynchronously (a queued/steered answer
        // can lag a tick), and a duplicate racing that window used to pass
        // this guard and submit a second answer. A submit that fails at
        // once un-burns the id below, so the question survives a refusal.
        this.markQuestionAnswered(questionId);
      }
      // Audit #79: a busy submit whose queue is already full (Controller
      // MAX_QUEUE = 5) is dropped by submit() with only a flash — the API
      // must not answer 202 for a message it knows will never be queued.
      if (st0?.busy && Array.isArray(st0.queue) && st0.queue.length >= 5) return this.json(res, 409, {error: 'queue is full'});
      // Audit #78: attachments are consumed only by the plain-message path
      // of submit() (not busy, no prompt pending, not a slash/! command, not
      // mid account-add). Writing them into the shared state for any other
      // path left them attached to the NEXT unrelated send, and an empty
      // list wiped images the TUI had prepared — so an empty list is a
      // no-op here, and a non-empty one on a non-consuming path is refused
      // instead of being silently parked in the shared state.
      // c4#3 (deep #30): reasonFor belongs in this list — submit() answers a
      // pending decline reason BEFORE the plain-message path, so it never
      // consumes attachments; accepting them here parked the image in the
      // shared state and attached it to the NEXT unrelated send. This is
      // also the server-side half of third M33.
      const consuming = !st0?.busy && !st0?.promptFor && !st0?.reasonFor && !controller.addingAccount && !text.startsWith('/') && !text.trimStart().startsWith('!');
      if (hasAttachments && !consuming) return this.json(res, 400, {error: 'attachments can only be sent with a new message (not while busy, answering a prompt or a decline reason, or as a command)'});
      // The attachments land in the Controller's send state immediately before
      // submit, exactly where the TUI's attach() puts them: submit() reads
      // s.attachments and clears them as the turn starts.
      let prevAttachments;
      if (hasAttachments) {
        prevAttachments = st0?.attachments;
        if (typeof controller.set === 'function') controller.set({attachments}); else if (st0) st0.attachments = attachments;
      }
      // Not awaited to completion: submit() resolves only when the whole
      // turn ends, and the TUI fires it the same way from its key handler.
      // Audit #79 (second half): a submit that fails at once — a synchronous
      // throw or an immediately rejected promise — must not still answer
      // 202, so the promise is watched for one tick before answering; a
      // rejection after that belongs to the turn and is only swallowed.
      let submitError = null, submitPromise = null;
      try { submitPromise = Promise.resolve(controller.submit(text)); } catch (e) { submitError = e; }
      if (submitPromise) {
        // c4#4 (deep #31): the one-tick watch below can only catch failures
        // that land before the 202. A rejection AFTER it used to be written
        // into submitError, which nobody ever read again — the client was
        // told "accepted" and the failure vanished. Late failures are now
        // surfaced as an error entry on the conversation itself (the same
        // {type: 'end', ok: false} shape Controller.submit uses for a failed
        // agent.send), so every connected front-end can see them.
        let answered = false;
        submitPromise.catch(e => {
          if (!submitError) submitError = e;
          if (answered) this.surfaceAsyncError(entry, e);
        });
        if (!submitError) await new Promise(r => setImmediate(r));
        answered = true;
      }
      if (submitError) {
        if (hasAttachments) { if (typeof controller.set === 'function') controller.set({attachments: prevAttachments || []}); else if (st0) st0.attachments = prevAttachments || []; }
        // serverfirst-debug G1: the send was refused, so the questionId
        // burned at the guard is handed back — the picker is still open
        // and its real answer must still be able to land.
        if (questionId !== null) this.unmarkQuestionAnswered(questionId);
        return this.json(res, 500, {error: 'send failed: ' + (submitError.message || String(submitError))});
      }
      return this.json(res, 202, {ok: true});
    }
    if (req.method === 'POST' && p === '/api/approval') {
      const body = await this.readBody(req, res); if (body === null) return;
      // Deep H1: body.approvalId (or decision.approvalId) binds the answer to
      // the approval the client saw; approval() rejects a mismatch with 409.
      return this.approval(entry, body.decision, res, body?.approvalId ?? body?.decision?.approvalId);
    }
    if (req.method === 'POST' && p === '/api/account') {
      // {id}: switch this conversation (Controller.accountCommand — checks login and device,
      // reserves the switch for the turn's end when busy). {add: label}: start adding an
      // account (the Edge login opens on THIS PC; its questions arrive as state.prompt).
      const body = await this.readBody(req, res); if (body === null) return;
      if (typeof body.add === 'string') {
        if (typeof controller.addAccountFlow !== 'function') return this.json(res, 501, {error: 'adding accounts is not available'});
        if (controller.addingAccount || controller.loggingIn) return this.json(res, 409, {error: 'an account is already being added or logged in'});
        Promise.resolve(controller.addAccountFlow(body.add.trim())).catch(() => {});
        return this.json(res, 202, {ok: true});
      }
      if (typeof body.id !== 'string' || !body.id) return this.json(res, 400, {error: 'id or add is required'});
      if (typeof controller.accountCommand !== 'function') return this.json(res, 501, {error: 'switching accounts is not available'});
      Promise.resolve(controller.accountCommand(body.id)).catch(() => {});
      return this.json(res, 202, {ok: true});
    }
    if (req.method === 'POST' && p === '/api/prompt') {
      const body = await this.readBody(req, res); if (body === null) return;
      // One route for both sides of the release-039 merge: {cancel: true} cancels the
      // pending typed prompt (serverfirst-debug R4: a client window could not), and
      // {value} answers it (app-ui: the phone types the account name / code). Any other
      // shape is refused before the pending check.
      if (body?.cancel !== true && typeof body?.value !== 'string') return this.json(res, 400, {error: 'prompt route takes {cancel: true} or {value: string}'});
      const st = this.state(entry);
      if (!st?.promptFor) return this.json(res, 409, {error: 'no question is waiting'});
      if (body.cancel === true) {
        if (typeof controller.cancelPrompt !== 'function') return this.json(res, 500, {error: 'cancelPrompt is not available'});
        controller.cancelPrompt();
        return this.json(res, 200, {ok: true});
      }
      controller.submitPrompt(body.value);
      return this.json(res, 200, {ok: true});
    }
    if (req.method === 'POST' && p === '/api/mode') {
      const body = await this.readBody(req, res); if (body === null) return;
      // Only the mode names themselves (src/policy.js MODES, the names the TUI shows);
      // modeFrom's typed aliases (auto, yolo, ...) are not accepted here.
      if (typeof body.mode !== 'string' || !MODES.includes(body.mode)) return this.json(res, 400, {error: 'mode must be one of: ' + MODES.join(', ')});
      if (typeof controller.setMode !== 'function') return this.json(res, 500, {error: 'setMode is not available'});
      controller.setMode(body.mode);
      return this.json(res, 200, {ok: true, mode: body.mode});
    }
    if (req.method === 'POST' && p === '/api/menu') {
      const body = await this.readBody(req, res); if (body === null) return;
      if (body?.cancel === true) return this.menuCancel(entry, res, body);
      if (body?.side !== undefined) return this.menuSide(entry, body, res);
      return this.menuPick(entry, body, res);
    }
    if (req.method === 'POST' && p === '/api/limit') {
      const body = await this.readBody(req, res); if (body === null) return;
      return this.limitAnswer(entry, body, res);
    }
    if (req.method === 'POST' && p === '/api/interrupt') {
      const body = await this.readBody(req, res); if (body === null) return;
      // v6: target picks what stops — 'turn' (no body / the v1 behaviour) is
      // agent.interrupt(), 'bang' aborts only the running !command through
      // the Controller's bangStop, 'all' does both.
      const target = body?.target ?? 'turn';
      if (target !== 'turn' && target !== 'bang' && target !== 'all') return this.json(res, 400, {error: 'target must be turn, bang or all'});
      if (target === 'turn' || target === 'all') {
        if (typeof agent.interrupt !== 'function') return this.json(res, 500, {error: 'interrupt is not available'});
        Promise.resolve(agent.interrupt()).catch(() => {});
      }
      if (target === 'bang' || target === 'all') { try { controller.bangStop?.abort(); } catch {} }
      return this.json(res, 200, {ok: true, target});
    }
    if (req.method === 'POST' && p === '/api/shell-kill') {
      const body = await this.readBody(req, res); if (body === null) return;
      if (typeof body.id !== 'string' || !body.id) return this.json(res, 400, {error: 'id is required'});
      try { const r = agent.shells.kill(body.id); return this.json(res, 200, {ok: true, ...r}); }
      catch (e) { return this.json(res, 404, {error: e.message}); }
    }
    return this.json(res, 404, {error: 'not found'});
  }

  // GET /api/server (v5): the resident server itself — version, pid, start time,
  // the open conversations, the default conversation's Muse, and the accounts.
  serverInfo() {
    const def = this.defaultEntry();
    let sessions;
    if (this.host) sessions = this.host.list();
    else if (def) { const s = this.state(def); sessions = [{id: def.id, cwd: def.agent.cwd ?? null, title: def.agent.session?.title ?? null, turns: def.agent.session?.turns ?? 0, mode: s.mode ?? def.agent.mode ?? null, busy: !!s.busy, approval: !!s.approval, account: def.agent.accountId ?? null, accountLabel: def.agent.accountLabel ?? null, museName: def.controller.museName ?? null, isDefault: true}]; }
    else sessions = [];
    let accounts = [];
    try {
      if (this.accountsProvider) accounts = this.accountsProvider() || [];
      else { const a = require('./accounts'); const active = a.activeId(); accounts = a.list().map(x => ({id: x.id, label: x.label, active: x.id === active})); }
    } catch {}
    return {protocol: 6, version: this.version, pid: process.pid, startedAt: this.startedAt, port: this.port, sessions, muse: {name: def?.controller?.museName ?? def?.museName ?? null}, accounts, link: this.linkState(), setup: {phase: this.setupPhase()}};
  }

  // The link as the local API may show it: state() carries the pairing code for
  // the pairing flow, but the standing /api/server view must not — a code is a
  // credential. Device entries likewise lose their static keys here.
  // First #5 (gui-server side): terminate the live channels of a just-revoked
  // device. Preferred route: a per-device close API on the Link object
  // (revokeDevice / closeChannelsForDevice / disconnectDevice /
  // terminateDeviceChannels / closeDeviceChannels). NOTE for the link owner
  // (agent D): src/link/link.js currently exposes NO such API — its
  // `channels` is an unlabelled Set of sockets and channel-server never
  // reports which device a socket belongs to back to Link, so a per-device
  // close cannot be targeted from here yet. Until Link tracks
  // deviceId -> sockets (or exposes one of the methods above), the fallback
  // below can only close channel entries that carry a device id
  // (ws.deviceId / ws.device.id), and D's channel-side revalidation of the
  // store on each request is what actually ends an unlabelled channel.
  // Returns how many channels were terminated (0 when none could be
  // identified). Never throws: revocation itself already succeeded.
  terminateRevokedDevice(deviceId, removedDevice) {
    const link = this.link;
    if (!link || !deviceId) return 0;
    try {
      for (const name of ['revokeDevice', 'closeChannelsForDevice', 'disconnectDevice', 'terminateDeviceChannels', 'closeDeviceChannels']) {
        if (typeof link[name] === 'function') {
          const r = link[name](deviceId, removedDevice);
          return typeof r === 'number' && Number.isFinite(r) ? r : 1;
        }
      }
      let channels = null;
      if (typeof link.channelsForDevice === 'function') channels = link.channelsForDevice(deviceId);
      else if (link.channels) channels = link.channels;
      if (!channels) return 0;
      let terminated = 0;
      const closeOne = ch => {
        if (!ch || typeof ch !== 'object') return;
        // Only an entry that names THIS device may be closed: an unlabelled
        // socket might be another device's channel, and revoking one phone
        // must not disconnect the rest.
        const owner = ch.deviceId || ch.device?.id || null;
        if (owner !== deviceId) return;
        try { if (typeof ch.terminate === 'function') ch.terminate(); else if (typeof ch.close === 'function') ch.close(4403); else return; terminated++; } catch {}
      };
      if (channels instanceof Map) {
        for (const [key, value] of channels) {
          if (key !== deviceId) continue; // only this device's bucket
          if (value && typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') for (const ch of value) closeOne(ch);
          else closeOne(value);
        }
      } else if (typeof channels[Symbol.iterator] === 'function') {
        for (const ch of channels) closeOne(ch);
      } else if (typeof channels === 'object') closeOne(channels);
      return terminated;
    } catch { return 0; }
  }

  linkState() {
    if (!this.link) return null;
    try {
      const s = this.link.state();
      return {...s, pairing: s.pairing ? {mode: s.pairing.mode, expiresAt: s.pairing.expiresAt, attempts: s.pairing.attempts} : null, devices: (s.devices || []).map(d => ({id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen}))};
    } catch { return null; }
  }

  // Surface a failure that arrived after its API answer was already sent
  // (a late submit rejection, c4#4; an async menu pick rejection, c4#5) as
  // an error entry on the conversation, where every front-end renders it —
  // instead of swallowing it into a variable nobody reads. The entry text
  // is the failure's own message; no new UI wording is introduced here.
  surfaceAsyncError(entry, e) {
    try {
      const controller = entry?.controller;
      if (!controller) return;
      const error = e?.message || String(e);
      if (typeof controller.push === 'function') controller.push({type: 'end', ok: false, error});
      else if (typeof controller.note === 'function') controller.note(error, 'error');
      else if (typeof controller.set === 'function') controller.set({flash: error});
    } catch {}
  }

  // GET /api/sessions?cwd=&limit= (v5): the stored conversations (src/sessions.js
  // recent), each marked with whether it is open here, and busy when it is.
  // origin is the conversation's creation mark ('exec' for one `muser exec`
  // created); an interactive conversation has none and reports null, so a
  // caller can keep exec-made folders out of its project candidates. A conversation made
  // before the mark existed still reads 'exec' when an exec run on record names it.
  sessionList(url, res) {
    const cwd = url.searchParams.get('cwd') || undefined;
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    let recent;
    try { recent = this.recentProvider ? this.recentProvider(cwd) : require('./sessions').recent(cwd); }
    catch (e) { return this.json(res, 500, {error: e.message}); }
    let execIds = null;
    try { execIds = this.execSessionIds ? this.execSessionIds() : require('./exec-status').sessionIds(); } catch {}
    const sessions = (recent || []).slice(0, limit).map(s => {
      const entry = this.resolveEntry(s.id);
      const origin = typeof s.origin === 'string' && s.origin ? s.origin : (execIds && execIds.has(s.id) ? 'exec' : null);
      return {id: s.id, cwd: s.cwd ?? null, title: s.title || '', turns: s.turns ?? 0, created: s.created ?? null, updated: s.updated ?? null, account: s.account ?? null, origin, open: !!entry, busy: entry ? !!this.state(entry).busy : false};
    });
    return this.json(res, 200, {sessions});
  }

  // POST .../menu {value} or {index} (v5): pick from the menu in the snapshot.
  // Exactly the TUI's menuKey pick (controller.mjs): the menu closes first, then
  // its pick() runs with the chosen option's own value — closures never cross.
  menuPick(entry, body, res) {
    const controller = entry.controller, s = this.state(entry), menu = s?.menu;
    if (!menu) return this.json(res, 409, {error: 'no menu open'});
    // Deep H1: same identity binding as approvals — a supplied menuId that
    // is not the open menu's id is a 409 and the open menu is NOT picked.
    // No menuId = legacy client, accepted as before.
    if (body?.menuId !== undefined && body?.menuId !== null && String(body.menuId) !== String(this.menuIdOf(menu))) return this.json(res, 409, {error: 'menu has changed'});
    const options = menu.options || [];
    let index = -1;
    if (Number.isInteger(body?.index)) index = body.index;
    else if (body && 'value' in body) {
      const wanted = JSON.stringify(plain(body.value));
      const matches = [];
      options.forEach((o, i) => { if (JSON.stringify(plain(o?.value ?? null)) === wanted) matches.push(i); });
      // Audit #73: plain() collapses values JSON cannot tell apart
      // (undefined / a function / a circular object / a BigInt all become
      // null), so several distinct options can share one wire value.
      // Picking the first would pick a different option than the client
      // meant — an ambiguous value is refused, never guessed.
      if (matches.length > 1) return this.json(res, 400, {error: 'menu value is ambiguous; pick by index'});
      index = matches.length ? matches[0] : -1;
    }
    if (index < 0 || index >= options.length) return this.json(res, 400, {error: 'no such menu option'});
    if (typeof controller.set === 'function') controller.set({menu: null}); else s.menu = null;
    // Audit #74: the menu used to be consumed before pick() ran, so a
    // synchronous throw from pick() left a 500 with the menu already gone
    // (and its cancel() never called). A throwing pick restores the menu,
    // so the client can still pick again or cancel it.
    let picked;
    try { picked = menu.pick(options[index].value); }
    catch (e) {
      if (typeof controller.set === 'function') controller.set({menu}); else s.menu = menu;
      return this.json(res, 500, {error: e.message});
    }
    // c4#5 (deep #32): an ASYNC pick failure used to be swallowed by an
    // empty catch after the 200 was already sent — the menu was gone and
    // the client believed the pick had run. Now the failure restores the
    // menu (when no newer menu has opened in the meantime, mirroring the
    // synchronous-throw restore above) and is surfaced as an error entry.
    Promise.resolve(picked).catch(e => {
      try {
        const cur = this.state(entry);
        if (!cur?.menu) { if (typeof controller.set === 'function') controller.set({menu}); else if (cur) cur.menu = menu; }
      } catch {}
      this.surfaceAsyncError(entry, e);
    });
    return this.json(res, 200, {ok: true, index});
  }

  // POST .../menu {cancel: true} (v6): close the open menu the way the TUI's
  // Esc does (menuKey's escape branch) — Controller.cancelMenu() is that
  // branch; the fallback mirrors it for a controller without the method.
  menuCancel(entry, res, body) {
    const controller = entry.controller, s = this.state(entry), menu = s?.menu;
    if (!menu) return this.json(res, 409, {error: 'no menu open'});
    // Deep H1: a cancel that names a menu (body.menuId) binds to that menu
    // only — a stale cancel must not Esc-close the NEXT menu either.
    if (body?.menuId !== undefined && body?.menuId !== null && String(body.menuId) !== String(this.menuIdOf(menu))) return this.json(res, 409, {error: 'menu has changed'});
    if (typeof controller.cancelMenu === 'function') controller.cancelMenu();
    else {
      if (typeof controller.set === 'function') controller.set({menu: null}); else s.menu = null;
      menu.cancel?.();
    }
    return this.json(res, 200, {ok: true});
  }

  // POST .../menu {side: -1|1} (serverfirst): turn the open menu's page —
  // exactly the TUI's menuKey ←/→ branch (controller.mjs), which calls the
  // menu's own side(dir); the closure stays server-side and the paged menu
  // reaches clients through the next snapshot (its id changes with the new
  // menu object, as for any replaced menu). Same identity binding as a
  // pick: a supplied menuId that is not the open menu's is a 409.
  menuSide(entry, body, res) {
    const s = this.state(entry), menu = s?.menu;
    if (!menu) return this.json(res, 409, {error: 'no menu open'});
    if (body?.menuId !== undefined && body?.menuId !== null && String(body.menuId) !== String(this.menuIdOf(menu))) return this.json(res, 409, {error: 'menu has changed'});
    if (body.side !== -1 && body.side !== 1) return this.json(res, 400, {error: 'side must be -1 or 1'});
    if (typeof menu.side !== 'function') return this.json(res, 409, {error: 'menu has no paging'});
    let paged;
    try { paged = menu.side(body.side); } catch (e) { return this.json(res, 500, {error: e.message}); }
    // serverfirst-debug G7: an ASYNC paging failure gets menuPick's
    // treatment (surfaced as an error entry on the conversation) instead
    // of an unhandled rejection behind a 200 the client already believed.
    Promise.resolve(paged).catch(e => this.surfaceAsyncError(entry, e));
    return this.json(res, 200, {ok: true, side: body.side});
  }

  // POST /limit {value, key} or {cancel: true, key} (v6): answer the pending
  // limitInput through Controller.answerLimit — the same code path as
  // limitKey's return/escape, so validation and the back/done fallbacks
  // cannot drift.
  limitAnswer(entry, body, res) {
    const controller = entry.controller, s = this.state(entry);
    if (!s?.limitInput) return this.json(res, 409, {error: 'no limit input pending'});
    if (typeof controller.answerLimit !== 'function') return this.json(res, 500, {error: 'limit input is not available'});
    // Audit #75 / first #22: a client answering a dialog it saw earlier must
    // name the input it means. When the open input carries a key (every real
    // limitInput does — see controller.mjs), the request key is REQUIRED:
    // a missing key is refused exactly like a mismatched one, because a
    // keyless answer carries no identity and a stale dialog's answer (or
    // cancel) otherwise landed on whatever NEW limit input had opened
    // since. An open input WITHOUT a key has nothing to bind to, so keyless
    // answers stay accepted for it (least-breaking fallback; no in-tree
    // producer creates one). Rejection happens before answerLimit, so a
    // refused answer has no side effect and the current input stays open.
    if (s.limitInput.key !== undefined && s.limitInput.key !== null && body?.key !== s.limitInput.key) return this.json(res, 409, {error: 'limit input has changed'});
    if (body?.cancel === true) { controller.answerLimit(null); return this.json(res, 200, {ok: true}); }
    if (typeof body?.value !== 'number' || !Number.isFinite(body.value)) return this.json(res, 400, {error: 'value must be a number'});
    // Audit #76: non-integers and integers JSON cannot represent exactly
    // are their own error, not "out of range" — 1.5 used to be reported as
    // a range failure, and an unsafe integer arrives already rounded by
    // JSON.parse, so it is refused here instead of silently applying a
    // different value through a lenient answerLimit.
    if (!Number.isSafeInteger(body.value)) return this.json(res, 400, {error: 'value must be a safe integer'});
    if (controller.answerLimit(body.value) === false) return this.json(res, 400, {error: 'value is out of range'});
    return this.json(res, 200, {ok: true, value: body.value});
  }

  // GET /entries?before=<entryId>&limit=<n> (v6): one page of the Controller's
  // FULL entry list, older than the snapshot's newest-200 window. Entries are
  // strictly before the entry whose id is `before` (the newest page when it
  // is absent), in the list's own newest-last order; hasMore says older ones
  // remain. An unknown `before` id is a 404 — paging from a position the
  // server no longer holds would silently return the wrong page.
  entriesPage(entry, url, res) {
    const all = this.state(entry).entries || [];
    const limitRaw = Number(url.searchParams.get('limit'));
    // Audit #81: floor() turned limit=0.5 into 0, which paged as
    // {entries: [], hasMore: true} forever — a positive limit is at least 1.
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 200;
    const before = url.searchParams.get('before');
    let end = all.length;
    if (before !== null) {
      const idx = all.findIndex(e => String(e?.id) === before);
      if (idx < 0) return this.json(res, 404, {error: 'unknown entry'});
      end = idx;
    }
    const start = Math.max(0, end - limit);
    return this.json(res, 200, {entries: plainList(all.slice(start, end)), hasMore: start > 0});
  }

  // v6 /send attachments, in the Controller's own attachment shape
  // (src/clipboard.js attachment(): {name, type, size, data} with base64
  // data). Returns the validated list, or null for anything off-spec.
  validateAttachments(list) {
    if (!Array.isArray(list) || list.length > ATTACH_MAX_COUNT) return null;
    let total = 0;
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || !ATTACH_TYPES.has(item.type)) return null;
      if (typeof item.data !== 'string' || !item.data || item.data.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) return null;
      const bytes = Buffer.from(item.data, 'base64');
      const size = bytes.length;
      total += size;
      if (total > ATTACH_MAX_TOTAL) return null;
      // Audit #80: the declared MIME used to be the only check, so any
      // bytes at all could be stored and forwarded as image/png. The
      // magic bytes must agree with the declared type.
      if (!imageMagicMatches(item.type, bytes)) return null;
      out.push({name: typeof item.name === 'string' && item.name ? item.name : 'image', type: item.type, size, data: item.data});
    }
    return out;
  }

  // GET /api/server/events (v5): the server-wide SSE stream the phone's
  // notifications are built from — session open/close, busy start/end, and
  // approval pending/cleared, as {kind: 'event', event: {...}} after an initial
  // {kind: 'server', server} snapshot.
  // c4#6 (deep #33): one heartbeat write, shared by both SSE streams. A
  // failed or impossible write means the subscriber is gone (a half-open
  // tunnel/NAT connection may never fire req 'close'): the caller drops
  // the client instead of keeping it — and its host touch — alive forever.
  // Returns false when the client should be dropped.
  pingClient(client) {
    const res = client.res;
    if (!res || res.destroyed || res.writableEnded) return false;
    try { res.write(': ping\n\n'); return true; } catch { return false; }
  }

  serverEvents(req, res) {
    if (this.serverClients.size >= MAX_SSE_CLIENTS) return this.json(res, 503, {error: 'too many event clients'});
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no'});
    const client = {res, heartbeat: null};
    try { res.write('data: ' + JSON.stringify({kind: 'server', server: this.serverInfo()}) + '\n\n'); } catch {}
    client.heartbeat = setInterval(() => { if (!this.pingClient(client)) this.dropServerClient(client); }, this.eventsHeartbeatMs);
    client.heartbeat.unref?.();
    this.serverClients.add(client);
    req.on('close', () => this.dropServerClient(client));
    res.on?.('close', () => this.dropServerClient(client));
  }
  dropServerClient(client) {
    if (!this.serverClients.delete(client)) return;
    if (client.heartbeat) clearInterval(client.heartbeat);
    try { client.res.end(); } catch {}
  }
  broadcastServerEvent(event) {
    if (!event) return;
    for (const client of [...this.serverClients]) {
      try { client.res.write('data: ' + JSON.stringify({kind: 'event', event}) + '\n\n'); } catch { this.dropServerClient(client); }
    }
  }

  // Resolve the pending approval with exactly the values the TUI resolves Controller.ask()
  // with (src/ui/controller.mjs): answer() -> {allow: true, always: <key|null>} (choosing
  // the auto-edit option also switches the mode first), submitReason() ->
  // {allow: false, reason: <text>}, esc in the approval box -> {allow: false}.
  approval(entry, decision, res, approvalId) {
    const d = decision;
    if (!d || typeof d !== 'object' || typeof d.allow !== 'boolean') return this.json(res, 400, {error: 'decision.allow (boolean) is required'});
    if (d.reason !== undefined && typeof d.reason !== 'string') return this.json(res, 400, {error: 'decision.reason must be a string'});
    const s = this.state(entry), a = s.approval;
    // Deep H1: identity binding. A client that saw approval A and answers
    // late (after A closed and B opened), or duplicates its POST, must not
    // have that answer land on B: a supplied id that is not the CURRENT
    // approval's id is a 409 and the current approval stays unresolved.
    // The reason wait carries the same object, so it is bound the same way.
    // No id supplied = a legacy client: accepted as before (existing
    // clients/tests predate the id), the check binds only answers that
    // claim a specific approval.
    if (approvalId !== undefined && approvalId !== null) {
      const current = a || (s.reasonFor && typeof s.reasonFor === 'object' ? s.reasonFor : null);
      if (current && String(approvalId) !== String(this.approvalIdOf(current))) return this.json(res, 409, {error: 'approval has changed'});
    }
    // A client that does not know the option keys (the C# shell) sends always: true for
    // its "always" button: translate it to the pending approval's own always option —
    // its key, or the auto-edit option (marked on the decision for the branch below) —
    // which is exactly what choosing that option in the TUI resolves with.
    if (d.always === true) {
      const opts = a?.options || [];
      const keyed = opts.find(o => o && typeof o.always === 'string');
      if (keyed) d.always = keyed.always;
      else if (opts.some(o => o && o.autoEdit)) { d.always = null; d.autoEdit = true; }
      else d.always = null;
    }
    if (d.always !== undefined && d.always !== null && typeof d.always !== 'string') return this.json(res, 400, {error: 'decision.always must be a string or null'});
    if (!a) {
      // The TUI already took the decline and is waiting for its reason text: that wait is
      // Controller.submitReason, and a GUI decision with a reason completes it.
      if (s.reasonFor && typeof entry.controller.submitReason === 'function') {
        // Audit #72: ANY decision used to complete the reason wait with an
        // empty reason — including {allow: true}, which never declined
        // anything. Only a decline decision may answer a reason prompt.
        if (d.allow !== false) return this.json(res, 400, {error: 'only a decline decision can answer a reason prompt'});
        entry.controller.submitReason(typeof d.reason === 'string' ? d.reason : '');
        return this.json(res, 200, {ok: true});
      }
      return this.json(res, 409, {error: 'no approval pending'});
    }
    // The always key is the PENDING approval's to offer, not the client's to invent:
    // any string used to be accepted, so an API caller could hand itself a key that
    // was never asked about ('edit', or another command's exec key) and have it
    // remembered (audit #70). The auto-edit option is the approval's to offer too.
    const offeredAlways = new Set((a.options || []).filter(o => o && typeof o.always === 'string').map(o => o.always));
    if (typeof d.always === 'string' && !offeredAlways.has(d.always)) return this.json(res, 400, {error: 'decision.always is not an option for this approval'});
    if (d.autoEdit && !(a.options || []).some(o => o && o.autoEdit)) return this.json(res, 400, {error: 'decision.autoEdit is not an option for this approval'});
    const resolved = d.allow ? {allow: true, always: d.always || null} : d.reason !== undefined ? {allow: false, reason: d.reason} : {allow: false};
    if (d.allow && d.autoEdit && entry.agent.mode === 'default' && typeof entry.controller.setMode === 'function') entry.controller.setMode('auto-edit');
    // The same state clearing answer()/approvalKey() do, then the next queued approval opens.
    if (typeof entry.controller.set === 'function') entry.controller.set({approval: null, ...(resolved.allow && a.call?.agent === 'main' ? {running: {call: a.call, tail: []}} : {})});
    else s.approval = null;
    a.resolve(resolved);
    entry.controller.nextApproval?.();
    return this.json(res, 200, {ok: true});
  }

  // ---- app-ui: /api/accounts ----
  admin() {
    if (this.accountsAdmin) return this.accountsAdmin;
    return {
      accounts: require('./accounts'),
      pool: require('./account-pool'),
      setAuto: on => require('./config').update(cfg => { cfg.accountAuto = !!on; }),
    };
  }
  // The accounts an open conversation is using (they must not be removed under it).
  accountsInUse() {
    const used = new Set();
    for (const e of this.allEntries()) { const id = e.agent?.accountId ?? e.agent?.account?.id; if (id) used.add(id); }
    return used;
  }
  async accountsRoute(req, res, p) {
    const {accounts, pool, setAuto} = this.admin();
    if (req.method === 'GET' && p === '/api/accounts') {
      // statuses() reads each account's weekly plan (one muse.ai call each); a failure
      // there reads as unknown, and a total failure falls back to the bare registry.
      let all;
      try { all = await pool.statuses(); }
      catch { all = accounts.list().map(a => ({id: a.id, label: a.label, hasLogin: null, device: null, available: null, percentUsed: null})); }
      const def = accounts.activeId(), used = this.accountsInUse();
      const vms = new Map();
      for (const s of all) if (s.vm) vms.set(s.vm, (vms.get(s.vm) || 0) + 1);
      const items = all.map(s => ({
        id: s.id, label: s.label, isDefault: s.id === def, inUse: used.has(s.id),
        hasLogin: s.hasLogin ?? null, device: s.device ?? null, available: s.available ?? null,
        percentUsed: s.percentUsed ?? s.plan?.percentUsed ?? null, quotaStatus: s.quotaStatus ?? null,
        resetsAt: s.plan?.resetsAt ?? null, planName: s.plan?.plan ?? null,
        sharedMuse: !!(s.vm && vms.get(s.vm) > 1), removable: s.id !== accounts.DEFAULT_ID,
      }));
      let threshold = null; try { threshold = accounts.threshold(); } catch {}
      return this.json(res, 200, {accounts: items, auto: !!pool.autoEnabled(), defaultId: def, threshold});
    }
    if (req.method !== 'POST') return this.json(res, 404, {error: 'not found'});
    const body = await this.readBody(req, res); if (body === null) return;
    try {
      if (p === '/api/accounts/auto') {
        if (typeof body.on !== 'boolean') return this.json(res, 400, {error: 'on must be true or false'});
        setAuto(body.on);
        return this.json(res, 200, {ok: true, auto: body.on});
      }
      const target = typeof body.id === 'string' ? accounts.get(body.id) : null;
      if (!target) return this.json(res, 404, {error: 'unknown account'});
      if (p === '/api/accounts/default') { accounts.setActive(target.id); return this.json(res, 200, {ok: true}); }
      if (p === '/api/accounts/rename') {
        if (typeof body.label !== 'string' || !body.label.trim()) return this.json(res, 400, {error: 'label is required'});
        accounts.rename(target.id, body.label.trim());
        return this.json(res, 200, {ok: true});
      }
      if (p === '/api/accounts/remove') {
        if (target.id === accounts.DEFAULT_ID) return this.json(res, 400, {error: 'the first account cannot be removed'});
        if (this.accountsInUse().has(target.id)) return this.json(res, 409, {error: 'a conversation is using this account'});
        const {leftover} = accounts.remove(target.id) || {};
        return this.json(res, 200, {ok: true, ...(leftover ? {leftover: true} : {})});
      }
    } catch (e) {
      return this.json(res, 400, {error: String(e?.message || e)});
    }
    return this.json(res, 404, {error: 'not found'});
  }

  // GET /api/complete (docs/gui-protocol.md v2): the same candidates the TUI offers.
  // kind=slash reuses Controller.slashList (the ↑↓ candidate source; descriptions are
  // looked up in that same COMMANDS table, loaded lazily — never a copy of the list).
  // kind=file reuses mentions.complete, the @ completion machinery: it answers from its
  // cache synchronously and only kicks off a background refresh, so a cold or stale
  // cache yields [] (or the stale list) instead of blocking the request.
  async complete(entry, url, res) {
    const kind = url.searchParams.get('kind');
    const q = url.searchParams.get('q') ?? '';
    if (kind === 'slash') {
      if (typeof entry.controller.slashList !== 'function') return this.json(res, 500, {error: 'slash completion is not available'});
      const names = entry.controller.slashList(q) || [];
      const descs = await this.commandDescriptions();
      return this.json(res, 200, {items: names.map(text => { const item = {text}; const desc = descs.get(text); if (typeof desc === 'string') item.desc = desc; return item; })});
    }
    if (kind === 'file') {
      const list = mention.complete(q, entry.agent.cwd, mention.COMPLETE_LIMIT) || [];
      return this.json(res, 200, {items: list.map(text => ({text}))});
    }
    // app-ui: the pickers the GUI fills from its own reading of the PC (SkillCatalog /
    // AgentTypes) — a phone cannot read the PC's files, so the serve answers them.
    // kind=agent: the /agent types for this cwd (built-in + .muser/agents), as the TUI's
    // /agent usage line lists them. kind=skill: the ENABLED skills /skill accepts.
    // kind=instructions: which project instruction files exist (the empty chat's /init card).
    if (kind === 'agent' || kind === 'skill' || kind === 'instructions') {
      const {t} = require('./i18n');
      const cwd = entry.agent.cwd;
      const match = name => !q || name.startsWith(q.toLowerCase());
      try {
        if (kind === 'agent') {
          const types = typeof entry.agent.types === 'function' ? entry.agent.types() : require('./agent-types').load(cwd);
          return this.json(res, 200, {items: Object.entries(types || {}).filter(([name]) => match(name)).map(([name, def]) => ({text: name, desc: t(String(def?.description || name)), readOnly: !!def?.readOnly}))});
        }
        if (kind === 'skill') {
          const list = require('./skills').load(cwd) || [];
          return this.json(res, 200, {items: list.filter(s => s.enabled && match(s.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(s => ({text: s.name, desc: String(s.description || '')}))});
        }
        const files = ['AGENTS.md', 'CLAUDE.md', 'MUSE.md', '.muser/instructions.md'];
        return this.json(res, 200, {items: files.filter(f => { try { return !!cwd && fs.statSync(path.join(cwd, f)).isFile(); } catch { return false; } }).map(text => ({text}))});
      } catch (e) {
        return this.json(res, 500, {error: String(e?.message || e)});
      }
    }
    return this.json(res, 400, {error: 'kind must be slash, file, agent, skill or instructions'});
  }

  // name -> description from controller.mjs's COMMANDS (the single definition), cached.
  // Best-effort: if the module cannot load, candidates simply carry no desc.
  commandDescriptions() {
    if (!this._commandDescs) this._commandDescs = import('./ui/controller.mjs').then(m => new Map(m.COMMANDS || [])).catch(() => new Map());
    return this._commandDescs;
  }

  // GET /api/changes (docs/gui-protocol.md v3): the changed-files list for the agent's
  // cwd, or one file's diff with ?file=<path>. Line counts come from a single
  // `diff --numstat -z HEAD` (staged + unstaged together); untracked and binary files
  // carry null counts, and the totals sum only the non-null values.
  // c4#7 (deep #34): the cached/coalescing entry point — concurrent and
  // closely-spaced /api/changes calls for one cwd share a single run of
  // the git commands below instead of each spawning up to six. A failed
  // run is never cached, so a transient git failure retries on the next call.
  changedFiles(cwd) {
    if (!cwd || typeof cwd !== 'string') return Promise.resolve(null);
    const now = Date.now();
    const hit = this._changesCache.get(cwd);
    if (hit && now - hit.at < this.changesCacheMs) return hit.promise;
    const promise = this.computeChangedFiles(cwd);
    const rec = {at: now, promise};
    this._changesCache.set(cwd, rec);
    // The TTL runs from when the run FINISHES: stamped at the start, a git run slower
    // than the TTL (routine under load) left no cache window at all, and the c4#7 test
    // flaked whenever a cold git run crossed 1 s during the full suite.
    promise.then(() => { if (this._changesCache.get(cwd) === rec) rec.at = Date.now(); }, () => {});
    promise.catch(() => { if (this._changesCache.get(cwd) === rec) this._changesCache.delete(cwd); });
    return promise;
  }

  // Returns null ONLY for "not a repository" — c4#8 (deep #35): every other
  // git failure (a timeout, a vanished cwd, a locked index) used to be
  // flattened into the same null, so /api/changes answered {repo: false}
  // for a slow or temporarily broken repo. Real failures now throw a
  // GIT_FAILED error and changes() answers 502 for them.
  async computeChangedFiles(cwd) {
    let inside;
    try { inside = (await gitRun(cwd, ['rev-parse', '--is-inside-work-tree'])).trim(); }
    catch (e) {
      if (/not a git repository/i.test(String(e?.stderr || '') + '\n' + String(e?.message || ''))) return null;
      const err = new Error('could not read repository status'); err.code = 'GIT_FAILED'; err.cause = e; throw err;
    }
    if (inside !== 'true') return null;
    let branch = null;
    try { branch = (await gitRun(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null; } catch { branch = null; }
    let parsed;
    try { parsed = parseStatusZ(await gitRun(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])); }
    catch (e) { const err = new Error('could not read repository status'); err.code = 'GIT_FAILED'; err.cause = e; throw err; }
    const counts = await this.numstatMap(cwd);
    const files = parsed.map(f => {
      if (f.status === 'untracked') return {...f, added: null, deleted: null};
      const c = counts.get(f.path);
      if (c === null) return {...f, added: null, deleted: null}; // binary
      if (c) return {...f, added: c.added, deleted: c.deleted};
      return {...f, added: 0, deleted: 0};
    });
    return {branch, files};
  }

  // Whether HEAD names a commit at all. The staged+unstaged fallbacks in
  // numstatMap()/changes() exist ONLY for an unborn HEAD (audit #86): they
  // used to fire on ANY git error, so a failing `diff HEAD` in a normal
  // repo was silently replaced by the sum of two partial diffs, double-
  // counting files that are both staged and modified.
  async headExists(cwd) {
    try { await gitRun(cwd, ['rev-parse', '--verify', '-q', 'HEAD']); return true; } catch { return false; }
  }

  async numstatMap(cwd) {
    try { return parseNumstatZ(await gitRun(cwd, ['diff', '--numstat', '-z', 'HEAD'])); } catch {}
    if (await this.headExists(cwd)) return new Map();
    // No HEAD yet (unborn branch): staged and unstaged diffs separately, summed.
    const merged = new Map();
    for (const args of [['diff', '--cached', '--numstat', '-z'], ['diff', '--numstat', '-z']]) {
      let part;
      try { part = parseNumstatZ(await gitRun(cwd, args)); } catch { continue; }
      for (const [p, c] of part) {
        if (!merged.has(p)) { merged.set(p, c); continue; }
        const prev = merged.get(p);
        merged.set(p, prev === null || c === null ? null : {added: prev.added + c.added, deleted: prev.deleted + c.deleted});
      }
    }
    return merged;
  }

  // GET /api/muse-avatar[?video=idle|working|...]: the image (or one of the looping videos)
  // the user set for their Muse on muse.ai (identity.avatar), read through the chat gateway's
  // workspace files (/fs/raw/...) as Muse Desktop Community does. Each is fetched once per
  // serve and kept; 404 when the Muse has no such image or video.
  async museAvatar(entry, res, video = null) {
    try {
      if (video !== null && !/^[a-z_]{1,40}$/.test(video)) return this.json(res, 400, {error: 'bad video name'});
      // The identity/avatar cache is per conversation in v5: two conversations can
      // be on different accounts, with different Muses.
      // c4#10 (deep #37): the cache used to live for the entry's whole life,
      // so an account switch (which swaps agent.client on the same entry)
      // kept serving the OLD account's Muse, and an avatar changed on
      // muse.ai never appeared. The cache is now keyed by the client object
      // and the account id, and expires after avatarCacheMs.
      const client = entry.agent.client;
      const accountKey = entry.agent.accountId ?? entry.agent.account?.id ?? null;
      let cache = entry._avatarCache;
      if (!cache || cache.client !== client || cache.accountKey !== accountKey || Date.now() - (cache.createdAt || 0) > this.avatarCacheMs) {
        cache = entry._avatarCache = {client, accountKey, createdAt: Date.now(), identity: null, avatars: new Map()};
      }
      cache.identity ||= Promise.resolve(client?.request ? client.request('GET', '/identity') : null)
        .catch(e => { cache.identity = null; throw e; });
      const key = video || 'image';
      if (!cache.avatars.has(key)) cache.avatars.set(key, (async () => {
        const av = (await cache.identity)?.avatar;
        const p = video === null
          ? (av?.image_exists !== false && typeof av?.image_path === 'string' ? av.image_path : '')
          : (av?.video_exists !== false && typeof av?.video_variants?.[video] === 'string' ? av.video_variants[video] : '');
        const parts = p.replace(/^\/+/, '').split('/');
        if (!p || p.length > 512 || parts.some(x => !x || x === '.' || x === '..')) return null;
        const r = await client.request('GET', '/fs/raw/' + parts.map(encodeURIComponent).join('/'), {}, {raw: true});
        const type = String(r?.contentType || '').split(';')[0].trim().toLowerCase();
        const ok = video === null ? /^image\/(png|jpeg|webp|gif)$/.test(type) : /^video\/(mp4|webm)$/.test(type);
        if (!ok || !r.data || r.data.length > (video === null ? 8 : 32) * 1024 * 1024) return null;
        return {type, data: Buffer.from(r.data)};
      })().catch(e => { cache.avatars.delete(key); throw e; }));
      const a = await cache.avatars.get(key);
      if (!a) return this.json(res, 404, {error: video ? 'no such avatar video' : 'no avatar'});
      res.writeHead(200, {'content-type': a.type, 'content-length': a.data.length, 'cache-control': 'private, max-age=3600'});
      res.end(a.data);
    } catch (e) { return this.json(res, 502, {error: 'avatar unavailable: ' + e.message}); }
  }

  // GET /api/image?path=<p>: one image file from inside the conversation's
  // working folder, read-only (app-md: the phone previews images Muse saw
  // or made). The real path must stay inside the real working folder
  // (symlinks resolved on both sides), sensitive paths are refused, only
  // the four attachment image types pass, the magic bytes must match the
  // extension's type, and the body is capped at 8 MB.
  async workspaceImage(entry, res, rel) {
    const IMAGE_EXTS = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};
    const IMAGE_MAX = 8 * 1024 * 1024;
    try {
      if (typeof rel !== 'string' || !rel || rel.length > 1024) return this.json(res, 400, {error: 'path is required'});
      const cwd = entry.agent?.cwd;
      if (!cwd) return this.json(res, 404, {error: 'no working folder'});
      const type = IMAGE_EXTS[path.extname(rel).toLowerCase()];
      if (!type) return this.json(res, 400, {error: 'not an image file'});
      const joined = path.resolve(cwd, rel);
      if (isSensitivePath(joined)) return this.json(res, 403, {error: 'sensitive path'});
      const real = realOf(joined);
      const realCwd = realOf(cwd);
      if (!real || !realCwd || !inside(realCwd, real) || real === realCwd) return this.json(res, 404, {error: 'not found'});
      if (isSensitivePath(real)) return this.json(res, 403, {error: 'sensitive path'});
      const st = await fs.promises.stat(real).catch(() => null);
      if (!st || !st.isFile()) return this.json(res, 404, {error: 'not found'});
      // app-debug #6: a hardlink inside the folder can BE a file outside it
      // (same inode under a second name) — the realpath check cannot see it,
      // so a multiply-linked file is not provably "inside only".
      if (st.nlink > 1) return this.json(res, 404, {error: 'not found'});
      if (st.size > IMAGE_MAX) return this.json(res, 413, {error: 'image too large'});
      const data = await fs.promises.readFile(real);
      // The size is re-checked on the bytes actually read: the stat above
      // and this read are not atomic (the file can grow between them).
      if (data.length > IMAGE_MAX) return this.json(res, 413, {error: 'image too large'});
      if (!imageMagicMatches(type, data)) return this.json(res, 400, {error: 'not an image file'});
      res.writeHead(200, {'content-type': type, 'content-length': data.length, 'cache-control': 'private, max-age=3600'});
      res.end(data);
    } catch (e) { return this.json(res, 502, {error: 'image unavailable: ' + e.message}); }
  }

  async changes(entry, url, res) {
    const cwd = entry.agent.cwd ?? null;
    const fileParam = url.searchParams.get('file');
    if (fileParam === null) {
      // c4#8: a real git failure is a 502, not {repo: false}.
      const info = await this.changedFiles(cwd).catch(e => { if (e?.code === 'GIT_FAILED') { this.json(res, 502, {error: 'could not read repository status'}); return undefined; } throw e; });
      if (info === undefined) return;
      if (!info) return this.json(res, 200, {repo: false});
      const files = info.files.map(f => ({path: f.path, status: f.status, added: f.added, deleted: f.deleted}));
      let added = 0, deleted = 0;
      for (const f of files) { if (f.added !== null) added += f.added; if (f.deleted !== null) deleted += f.deleted; }
      return this.json(res, 200, {repo: true, branch: info.branch, files, added, deleted});
    }
    // A diff is served ONLY for a path in the current changed-files list (never an
    // arbitrary path): an unlisted path — or a non-repo cwd — is a 404.
    const wanted = fileParam.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    const info = await this.changedFiles(cwd).catch(e => { if (e?.code === 'GIT_FAILED') { this.json(res, 502, {error: 'could not read repository status'}); return undefined; } throw e; });
    if (info === undefined) return;
    const fileEntry = info ? info.files.find(f => f.path === wanted) : null;
    if (!fileEntry) return this.json(res, 404, {error: 'file not in changed files'});
    if (fileEntry.status === 'untracked') return this.json(res, 200, {repo: true, path: fileEntry.path, diff: null});
    const paths = fileEntry.origPath && fileEntry.origPath !== fileEntry.path ? [fileEntry.origPath, fileEntry.path] : [fileEntry.path];
    let diff;
    try { diff = await gitRun(cwd, ['diff', 'HEAD', '--', ...paths], GIT_DIFF_TIMEOUT_MS); }
    catch {
      // Audit #86: the unborn fallback only when HEAD really is unborn —
      // any other diff failure is reported, not masked by two partial
      // diffs concatenated (which double-lists a staged-and-modified file).
      if (await this.headExists(cwd)) return this.json(res, 500, {error: 'could not read diff'});
      // No HEAD yet: the staged diff plus the unstaged diff for the same paths.
      const parts = [];
      for (const args of [['diff', '--cached', '--', ...paths], ['diff', '--', ...paths]]) {
        try { const part = await gitRun(cwd, args, GIT_DIFF_TIMEOUT_MS); if (part) parts.push(part); } catch {}
      }
      diff = parts.join('');
    }
    const truncated = diff.length > DIFF_CAP;
    return this.json(res, 200, {repo: true, path: fileEntry.path, diff: truncated ? diff.slice(0, DIFF_CAP) : diff, ...(truncated ? {truncated: true} : {})});
  }

  // GET /api/outputs (docs/gui-protocol.md v3): without a query, the Controller's
  // keepOutput store (this.outputs: {id, at, command, summary, text}, newest last in
  // the store) newest first, each as {id, title, text} where title is the line
  // showOutput() heads the entry with (command + summary). With ?shell=<id>, one
  // background shell's buffered output via the same accessor the shell.output tool
  // uses (src/shells.js Shells.output, from offset 0 under a GUI-only read cursor so
  // the main cursor is not consumed), with command/running from Shells.get.
  async outputs(entry, url, res) {
    const shellId = url.searchParams.get('shell');
    if (shellId === null) {
      const raw = Array.isArray(entry.controller.outputs) ? entry.controller.outputs : [];
      const outputs = raw.map((o, i) => {
        const id = o && o.id !== undefined && o.id !== null && o.id !== '' ? String(o.id) : (o && o.at ? 'output-' + o.at + '-' + i : 'output-' + i);
        const title = o && typeof o.title === 'string' && o.title ? o.title : [o?.command, o?.summary].filter(v => typeof v === 'string' && v).join('  ');
        // Stage 2 (memory): an output over the Controller's total cap lives in a file;
        // resolve it through the Controller so the GUI still receives the full text.
        const full = o && typeof o.text === 'string' ? o.text : (entry.controller && typeof entry.controller.outputText === 'function' ? entry.controller.outputText(o) : String(o?.text ?? ''));
        // Audit #84: the list form returned every stored output in full
        // (up to 30, unbounded each) while the shell form caps at 1 MB.
        // The list form now caps each text the same way, flagged.
        const truncated = full.length > 1024 * 1024;
        return {id, title, text: truncated ? full.slice(0, 1024 * 1024) : full, ...(truncated ? {truncated: true} : {})};
      }).reverse();
      return this.json(res, 200, {outputs});
    }
    if (!shellId) return this.json(res, 404, {error: 'unknown shell'});
    const shells = entry.agent.shells;
    if (!shells || (typeof shells.output !== 'function' && typeof shells.get !== 'function')) return this.json(res, 404, {error: 'unknown shell'});
    let record = null;
    if (typeof shells.get === 'function') { try { record = shells.get(shellId); } catch { return this.json(res, 404, {error: 'unknown shell'}); } }
    if (typeof shells.output === 'function') {
      let r;
      try { r = await shells.output(shellId, {since: 0, caller: 'gui', maxChars: 1024 * 1024}); } catch { return this.json(res, 404, {error: 'unknown shell'}); }
      // Audit #85: Shells.output flags a capped log with truncated:true;
      // dropping it made a partial log look complete.
      return this.json(res, 200, {shell: {id: r?.id ?? record?.id ?? shellId, command: record?.command ?? r?.command ?? '', running: typeof r?.running === 'boolean' ? r.running : !!record?.running, text: typeof r?.output === 'string' ? r.output : (typeof r?.text === 'string' ? r.text : ''), ...(r?.truncated ? {truncated: true} : {})}});
    }
    return this.json(res, 200, {shell: {id: record.id ?? shellId, command: record.command ?? '', running: !!record.running, text: typeof record.out === 'string' ? record.out : ''}});
  }

  events(entry, req, res) {
    this.maybeRefreshPlan(entry); // gui-serve: subscribing reads state too — a stale plan is re-read in the background (see maybeRefreshPlan)
    if (!this.attached.has(entry)) this.attachEntry(entry);
    const att = this.attached.get(entry);
    // c4#6 (deep #33): cap subscribers per conversation, like the server stream.
    if (att.clients.size >= MAX_SSE_CLIENTS) return this.json(res, 503, {error: 'too many event clients'});
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no'});
    const initialEntries = this.state(entry).entries || [];
    const client = {res, entry, lastEntries: initialEntries, lastEntriesCount: initialEntries.length, lastEntriesTailId: initialEntries.length ? initialEntries[initialEntries.length - 1]?.id : undefined, lastStateJson: '', stateTimer: null, heartbeat: null};
    const state = this.snapshot(entry, false);
    client.lastStateJson = JSON.stringify(state);
    this.sendEvent(client, {kind: 'state', state});
    // Audit #56: lastEntries starts at the CURRENT list, so entries added
    // while this client was disconnected were never sent to it — the initial
    // state frame carries no entries, and onControllerChange only diffs from
    // the current list. Every (re)connect therefore re-syncs the entry list
    // with an entries-reset, the same frame a wholesale replacement sends.
    this.sendEvent(client, {kind: 'entries-reset', entries: plainList(client.lastEntries.slice(-MAX_ENTRIES))});
    // Audit #61: an open stream is a viewer — it counts as use for as long as
    // it stays open (touch at connect and on every heartbeat), and stops
    // counting the moment it drops.
    this.host?.touch(entry.id);
    // c4#6 (deep #33): a heartbeat whose write fails drops the client —
    // and only a successful ping touches the host entry, so a dead
    // subscriber no longer keeps its conversation "watched" (and un-evicted)
    // forever.
    client.heartbeat = setInterval(() => { if (!this.pingClient(client)) { this.dropClient(client); return; } this.host?.touch(entry.id); }, this.eventsHeartbeatMs);
    client.heartbeat.unref?.();
    att.clients.add(client);
    req.on('close', () => this.dropClient(client));
    res.on?.('close', () => this.dropClient(client));
  }

  dropClient(client, att) {
    att = att || this.attached.get(client.entry);
    if (att && !att.clients.delete(client)) return;
    if (!att && !this.clients.delete(client)) return;
    if (client.stateTimer) clearTimeout(client.stateTimer);
    if (client.heartbeat) clearInterval(client.heartbeat);
    try { client.res.end(); } catch {}
  }

  sendEvent(client, obj) {
    try { client.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { this.dropClient(client); }
  }

  // Controller.subscribe fires on every set(): entry appends (and wholesale list
  // replacements — /new, /resume, /clear) go out at once; other state changes are
  // debounced ~50 ms and sent without entries.
  // Wave18: the append check is O(1) per client instead of scanning every
  // previously sent id (O(entries) per client per change). Each client keeps
  // the count of entries it was last sent and the id of the last one; the new
  // list is an append iff it did not shrink and the entry now at the old
  // boundary (prevCount - 1 — also the tail when nothing was added) still
  // carries that id. Any other shape is a replacement and goes out as an
  // entries-reset, as before. A set() that does not replace the entries array
  // still skips this entirely via the lastEntries identity check below.
  onControllerChange(entry, att) {
    att = att || this.attached.get(entry);
    if (!att) return;
    for (const client of [...att.clients]) {
      const entries = this.state(entry).entries || [];
      if (client.lastEntries !== entries) {
        const prev = client.lastEntries || [];
        const prevCount = typeof client.lastEntriesCount === 'number' ? client.lastEntriesCount : prev.length;
        const prevTailId = typeof client.lastEntriesCount === 'number' ? client.lastEntriesTailId : (prev.length ? prev[prev.length - 1]?.id : undefined);
        const appended = entries.length >= prevCount && (prevCount === 0 || entries[prevCount - 1]?.id === prevTailId);
        if (appended) for (const ent of entries.slice(prevCount)) this.sendEvent(client, {kind: 'entry', entry: plain(ent)});
        else this.sendEvent(client, {kind: 'entries-reset', entries: plainList(entries.slice(-MAX_ENTRIES))});
        client.lastEntries = entries;
        client.lastEntriesCount = entries.length;
        client.lastEntriesTailId = entries.length ? entries[entries.length - 1]?.id : undefined;
      }
      if (!client.stateTimer) {
        client.stateTimer = setTimeout(() => {
          client.stateTimer = null;
          const state = this.snapshot(entry, false), json = JSON.stringify(state);
          if (json !== client.lastStateJson) { client.lastStateJson = json; this.sendEvent(client, {kind: 'state', state}); }
        }, STATE_DEBOUNCE_MS);
        client.stateTimer.unref?.();
      }
    }
  }

  json(res, status, obj, headers) {
    if (res.writableEnded) return;
    // Audit #83: stringify BEFORE writeHead — a value JSON cannot carry
    // (a BigInt, a throwing getter) used to throw after the 200 head was
    // already sent, and the error JSON was then appended to that head as
    // a second, corrupt body. A stringify failure is a clean 500 instead.
    let body;
    try { body = JSON.stringify(obj); } catch { status = 500; body = JSON.stringify({error: 'internal error'}); }
    res.writeHead(status, {'content-type': 'application/json', ...(headers || {})});
    res.end(body);
  }
  jsonNoStore(res, status, obj) { return this.json(res, status, obj, {'cache-control': 'no-store'}); }

  // Reads and parses a JSON body; on any problem it answers (400/413) and returns null.
  // maxBody overrides the global cap for the one route that needs it (v6 /send).
  readBody(req, res, maxBody = MAX_BODY) {
    return new Promise(resolve => {
      const chunks = []; let size = 0, settled = false, overflow = false;
      const fail = (status, error) => { if (!settled) { settled = true; this.json(res, status, {error}); resolve(null); } };
      req.on('data', chunk => {
        // Past the cap the 413 is already answered; the rest is drained and
        // dropped instead of destroying the request — destroying it reset
        // the connection and the client never saw the 413 (v6: a 17 MB send).
        if (overflow) return;
        size += chunk.length;
        if (size > maxBody) { overflow = true; chunks.length = 0; fail(413, 'body too large'); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return; settled = true;
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        // Audit #69: a body of literally `null` parsed to null, which is
        // this function's own error sentinel — every caller then returned
        // without answering and the request hung. A parsed null is an
        // empty object body (every route then reports its missing fields
        // as a normal 400); only a real read/parse failure resolves null.
        try { const parsed = JSON.parse(text); resolve(parsed === null ? {} : parsed); } catch { this.json(res, 400, {error: 'invalid JSON'}); resolve(null); }
      });
      req.on('error', () => fail(400, 'could not read body'));
    });
  }
}

module.exports = {GuiServer};
