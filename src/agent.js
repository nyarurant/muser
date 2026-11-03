'use strict';
// A muser coding session: one Muse side chat ("main"), plus parallel agents that each run in
// their own side chat (a1, a2, ...), all driven from this PC's CLI device. Messages go out on
// the device channel (so Muse knows which device to use), replies are followed on the chat
// subscription, and Muse's tool calls arrive as device invokes. Invokes do not say which chat
// they come from, so every command takes an `agent` tag and each parallel agent is told its own.
// Muse sends them to the node id the chat's message named, so each window has its own (src/node-slots.js).
// UI-agnostic: the TUI and `exec` listen to the events this emits.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {NativeDevice} = require('./core/native-device');
const {MuseSteps, citations} = require('./muse-steps');
const {waitForReply} = require('./core/agent-reply');
const {messageFromEvent} = require('./core/chat-model');
const {TOOLS, commandsV2, inside, realOf} = require('./tools');
const {decide} = require('./policy');
const sessions = require('./sessions');
const agentTypes = require('./agent-types');
const {Shells} = require('./shells');
const {Relay} = require('./relay');
const nodeSlots = require('./node-slots');
const {t} = require('./i18n');
const {parse: parseTurnUsage, strip: stripTurnUsage, usageFromTranscript, formatUsage} = require('./turn-usage');
const {Focus, INSTRUCTION: FOCUS_INSTRUCTION, DEFINITIONS: FOCUS_TOOLS} = require('./focus');

const DEVICE_NAME = os.hostname() + ' CLI (muser)';
const INVOKE_GRACE_MS = 30000; // the device link's watchdog margin over Muse's timeout
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'MUSE.md', '.muser/instructions.md'];
const MAX_AGENTS = 4;
// Muse names its own spinner word (the terminal falls back to a word of its own until it does).
const SPINNER_INSTRUCTION = 'SPINNER: At the very start of each turn, call spinner.set once with a playful English -ing phrase of 1-3 words that fits what you are about to do (e.g. "Untangling regexes", "Polishing prose"); pass your agent tag if you are a parallel agent. It is display-only and costs nothing.';
const PROGRESS_INSTRUCTION = 'PROGRESS REPORTING: For any task requiring multiple actions, your FIRST device command MUST be progress.report with agent="main" and a short message to the user. This is the terminal\'s user-facing progress channel, and it is allowed in read-only tasks: it only displays and records your update. Call it again after meaningful findings, when changing approach, before verification, and between long waits. Use 1-3 sentences in the user\'s language explaining current work, observed findings, and the next step. Do not repeat empty updates or claim unverified success. A report does not finish the turn: continue working and give a separate final response when the task is finished.';
// Parallel-agent limits are the user's to set: a flag, else MUSER_MAX_AGENTS(_TOTAL), else
// ~/.muser/config.json {"maxAgents", "maxAgentsTotal"}. concurrent = running at once (default 4),
// perTurn = started during one main turn (default 0). 0 means no limit.
function resolveAgentLimits({maxAgents, maxAgentsTotal} = {}, env = process.env, configFile = path.join(os.homedir(), '.muser', 'config.json')) {
  let cfg = {};
  try { cfg = require('./config').readJson(configFile) || {}; } catch {}
  const pick = (...values) => {
    for (const v of values) {
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0) return n;
    }
    return undefined;
  };
  return {
    concurrent: pick(maxAgents, env.MUSER_MAX_AGENTS, cfg.maxAgents) ?? MAX_AGENTS,
    perTurn: pick(maxAgentsTotal, env.MUSER_MAX_AGENTS_TOTAL, cfg.maxAgentsTotal) ?? 0,
  };
}
function agentLimitText({concurrent, perTurn}) {
  return (concurrent ? 'up to ' + concurrent + ' parallel agents at a time' : 'parallel agents (no limit on how many at a time)') +
    (perTurn ? ', and at most ' + perTurn + ' started per task (the user\'s limit)' : '');
}
const MAX_PROJECT_INSTRUCTION_CHARS = 24000;
const PROJECT_INSTRUCTION_TRUNCATION_NOTE = '（プロジェクト指示が長いため一部省略しました）';

// The user's own instructions for every project, like Claude Code's ~/.claude/CLAUDE.md and
// Codex's ~/.codex/AGENTS.md: read wherever muser runs (the folder walk below stops after six
// levels and never reaches a project outside the home folder).
function userInstructionsFile() { return path.join(os.homedir(), '.muser', 'AGENTS.md'); }

function projectInstructions(cwd) {
  // Each file is capped at 12,000 chars; a longer file carries the truncation
  // note inside that budget, so a cut file never looks complete.
  const found = [];
  for (let dir = cwd, depth = 0; depth < 6; depth++) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) { const raw = fs.readFileSync(file, 'utf8'); found.push({file, text: raw.length > 12000 ? raw.slice(0, 12000 - PROJECT_INSTRUCTION_TRUNCATION_NOTE.length - 1) + '\n' + PROJECT_INSTRUCTION_TRUNCATION_NOTE : raw}); } } catch {}
    }
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  // Last in the budget (the project's own files are more specific), first in the listing.
  const userFile = userInstructionsFile();
  if (!found.some(x => path.resolve(x.file).toLowerCase() === userFile.toLowerCase())) {
    try { if (fs.statSync(userFile).isFile()) { const raw = fs.readFileSync(userFile, 'utf8'); found.push({file: userFile, user: true, text: raw.length > 12000 ? raw.slice(0, 12000 - PROJECT_INSTRUCTION_TRUNCATION_NOTE.length - 1) + '\n' + PROJECT_INSTRUCTION_TRUNCATION_NOTE : raw}); } } catch {}
  }
  // Cap the TOTAL across all files: a stack of ancestor instruction files must not eat the whole
  // context. The budget goes to the nearest files first (the project's own are the most specific;
  // outermost-first cut the project's AGENTS.md whenever a parent folder held a long one), and the
  // files are then listed outermost first, general before specific.
  const capped = [];
  let remaining = MAX_PROJECT_INSTRUCTION_CHARS;
  for (const entry of found) {
    if (remaining <= 0) break;
    if (entry.text.length <= remaining) { capped.push(entry); remaining -= entry.text.length; }
    else { const keep = Math.max(0, remaining - PROJECT_INSTRUCTION_TRUNCATION_NOTE.length - 1); capped.push({...entry, text: entry.text.slice(0, keep) + '\n' + PROJECT_INSTRUCTION_TRUNCATION_NOTE}); remaining = 0; }
  }
  return capped.reverse();
}

// The user's calendar day, not UTC's: toISOString() named yesterday/tomorrow
// for the hours around midnight in the user's timezone.
function localToday(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function preamble(cwd, mcpNames, {tag, by, type, typeName, limits} = {}) {
  const lines = [
    '[muser: a terminal coding session from the device "' + DEVICE_NAME + '". This block is from the CLI, not typed by the user.]',
    'Work on the user\'s PC only through that device\'s commands: code.read, code.grep, code.glob, code.edit, code.apply_patch, code.write, system.run (PowerShell by default; background=true for servers and watchers, then shell.output / shell.kill / shell.list), todo.write.',
    'Working directory: ' + cwd + ' (relative paths resolve there). OS: Windows. Today: ' + localToday() + '.',
    'Read a file before editing it. Prefer code.edit / code.apply_patch over rewriting files. Use todo.write for multi-step work.',
    // As Claude Code does: a command only the user can run is handed over as one line to paste.
    'If the user must run a command themselves (an interactive sign-in, a password prompt, anything you cannot run through system.run), tell them to type it in muser\'s input prefixed with "!", e.g. `! gh auth login`. It runs in PowerShell on this PC and its output is sent to you when it finishes.',
    'Before saying a change is done, verify it at the layer the user will see: run the tests, and for UI changes run the project\'s UI / e2e tests when it has them (see its docs), adding one when practical. Say what you verified and what you did not.',
    'Write and edit files only with code.write / code.edit / code.apply_patch, not with PowerShell (Set-Content, Out-File, Get-Content piped into a write): this PC runs Windows PowerShell 5.1, which has corrupted UTF-8 files before. A tool result with a "warning" field needs fixing before you go on.',
    'Before reporting a change as done, read your whole diff (git diff) and re-read every file you wrote, then say what you verified and what you did not.',
    'Change what was asked and nothing more. If a change would make the program refuse, ask about, hide, cap or drop something it handled before, say what it costs and ask first.',
    'The user may decline a command; then do not retry it, ask or adapt. Keep replies short; the terminal renders Markdown.',
    'This terminal cannot render embedded widgets: never emit tokens like [[hatch_widget:...]], [[hatch_letter:...]] or option-widget markup. Present choices as plain numbered text lists.',
  ];
  if (tag) {
    lines.push('You are parallel agent "' + tag + '" (type: ' + typeName + '), started by ' + (by === 'muse' ? 'the main session' : 'the user') + '. Pass agent="' + tag + '" in EVERY command you call on this device. Do only the task below; other agents may be working in the same folder at the same time, so do not touch files outside your task. When done, reply with a concise summary of what you did or found.');
    if (type?.prompt) lines.push('Role: ' + type.prompt);
    if (type?.readOnly) lines.push('This agent is read-only: commands that modify files or state will be refused.');
    if (type?.tools) lines.push('Commands available to this agent: ' + type.tools.join(', ') + '.');
  } else {
    const types = agentTypes.load(cwd);
    lines.push('For independent subtasks you can run ' + agentLimitText(limits || {concurrent: MAX_AGENTS, perTurn: 0}) + ': agent.spawn starts one in its own chat (type: ' + Object.entries(types).map(([k, v]) => k + ' = ' + v.description).join('; ') + '), agent.wait collects results. Your own commands need no agent tag.');
  }
  if (mcpNames?.length) lines.push('MCP tools from the user' + "'" + 's MCP servers are also on this device as mcp.<server>.<tool> (servers: ' + mcpNames.join(', ') + ').');
  lines.push(...require('./skills').preambleLines(cwd));
  for (const {file, text, user} of projectInstructions(cwd)) lines.push('', (user ? 'The user\'s instructions for all projects, from ' : 'Project instructions from ') + file + ':', text.trim());
  lines.push('', SPINNER_INSTRUCTION);
  if (!tag) lines.push('', PROGRESS_INSTRUCTION);
  return lines.join('\n');
}

const AGENT_PARAM = {agent: {type: 'string', description: 'Your agent tag if you are a parallel agent (e.g. a1). Omit in the main session.'}};
const AGENT_TOOLS = {
  'spinner.set': {description: 'Set the word on the terminal spinner while you work. Display only: it costs nothing, is not a progress report, and never counts as an answer.',
    required: {word: {type: 'string', description: 'A playful English -ing phrase of 1-3 words that fits this task, e.g. "Untangling regexes" (at most 40 characters).'}}, optional: {}},
  'progress.report': {description: 'Show a short progress update to the user in the terminal while continuing the current task. Use at meaningful milestones; this is not a final response.',
    required: {message: {type: 'string', description: 'Brief user-facing update: current work, verified findings, and next step (1-3 sentences, at most 2000 characters).'}}, optional: {}},
  'agent.spawn': {description: 'Start a parallel agent in its own Muse chat on this PC (same folder and tools). Returns its tag immediately; collect the result with agent.wait. Use for independent subtasks.',
    required: {task: {type: 'string', description: 'Complete, self-contained instructions for the agent.'}}, optional: {title: {type: 'string', description: 'Short label shown to the user.'}, type: {type: 'string', description: 'Agent type: general (default), explore, plan, review, test, or a custom one.'}}},
  'agent.wait': {description: 'Wait for parallel agents to finish (up to timeout_s, default 60, max 120) and return their status and final replies. Call again while some are still running.',
    required: {}, optional: {tags: {type: 'string', description: 'Comma-separated tags; default all.'}, timeout_s: {type: 'integer', description: 'Seconds to wait, max 120.'}}, timeout_ms: 125000},
};

// Which worker a device invoke belongs to. An explicit agent tag is authoritative:
// a tagged call for an unknown worker, or for a worker with no active turn, is refused
// (null) instead of silently landing on main or on another worker's turn.
function routeFor(workers, params) {
  const list = workers instanceof Map ? [...workers.values()] : [...workers];
  const tag = typeof params?.agent === 'string' ? params.agent.trim() : '';
  if (tag) { const w = list.find(x => x.tag === tag); return w?.turn ? w : null; }
  // Untagged is the main session's call: it is told to omit the tag (AGENT_PARAM), and parallel
  // agents to pass theirs. Refusing untagged calls whenever an agent was running (2026-11-01 audit)
  // left main unable to use the device from its first agent.spawn on, every call "muser is idle".
  // Only with main idle and several agents running is an untagged call ambiguous (null), and never
  // guessed onto the first agent.
  const active = list.filter(w => w.turn);
  if (active.length === 1) return active[0];
  const main = list.find(w => w.tag === 'main');
  return main?.turn ? main : null;
}

// Per-turn tool budget. The counter lives on the turn object (created in runTurn), so
// it resets every turn. Returns true when this call exceeds the limit and must not run.
function consumeToolCall(turn, limit) {
  if (!turn) return false;
  turn.toolCalls = (turn.toolCalls || 0) + 1;
  return turn.toolCalls > limit;
}
function toolLimitMessage(limit) {
  return t('ツール呼び出しの上限（{limit}回/ターン）に達しました。作業をまとめて最終返信をしてください。', {limit});
}
// A flag, else MUSER_MAX_TOOL_CALLS_PER_TURN, else the saved setting (/settings), else 250.
function resolveMaxToolCallsPerTurn(option, envValue = process.env.MUSER_MAX_TOOL_CALLS_PER_TURN, saved = require('./settings').numberValue('maxToolCallsPerTurn')) {
  for (const v of [option, envValue, saved]) {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 250;
}

// MCP readOnly annotations come from the server itself and are NOT trusted: they only
// lower the tool to read kind when the user marked that server trustReadOnly in config.
function mcpEffectiveKind(mcp, m) {
  const trusted = mcp?.config?.mcpServers?.[m.server]?.trustReadOnly === true;
  return m.readOnly && trusted ? 'read' : 'mcp';
}

// Finished workers whose result was already collected via agent.wait are pruned, so a
// long session does not accumulate dead workers. Main and running workers stay.
function pruneCollectedWorkers(workers) {
  for (const [tag, w] of workers) if (tag !== 'main' && !w.main && w.collected && !w.turn && w.state === 'done') workers.delete(tag);
}

class Worker {
  constructor({tag, session, ctx, title, by, typeName, type}) {
    this.tag = tag; this.session = session; this.ctx = ctx; this.title = title || ''; this.by = by; this.typeName = typeName; this.type = type;
    this.turn = null; this.starting = false; this.stopRequested = false; this.resultOffset = 0; this.state = 'idle'; this.lastTool = ''; this.text = ''; this.result = ''; this.error = ''; this.started = 0; this.ended = 0; this.collected = false; this.usage = null;
  }
  get main() { return this.tag === 'main'; }
  snapshot() { return {tag: this.tag, title: this.title, by: this.by, type: this.typeName, state: this.state, lastTool: this.lastTool, text: this.text, result: this.result, error: this.error, started: this.started, ended: this.ended, ...(this.usage ? {usage: this.usage} : {})}; }
}

// One Muse reply's usage, in the shape a user turn's total takes: the same
// token counts, formatted, and rounds = 1 (one reply contributed).
function toTotal(usage) { return usage ? {inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, formatted: formatUsage(usage), rounds: 1} : null; }
// Merge two user-turn totals (a Focus leg's total into the running one, one
// round's reply into the loop's, or the parallel agents' pooled usage into
// the turn's): token counts add, rounds add, and the formatted string is
// derived from the sum. A reply's raw usage (no rounds yet) counts as one
// round. The pool is display-only: the daily tally counts turn-usage events,
// never a turn-end total, so a pooled reply is still counted exactly once.
function mergeTotals(a, b) {
  const A = a ? (a.rounds ? a : toTotal(a)) : null, B = b ? (b.rounds ? b : toTotal(b)) : null;
  if (!A) return B; if (!B) return A;
  const summed = {inputTokens: (A.inputTokens || 0) + (B.inputTokens || 0), outputTokens: (A.outputTokens || 0) + (B.outputTokens || 0), rounds: A.rounds + B.rounds};
  summed.formatted = formatUsage(summed);
  return summed;
}

class Agent extends EventEmitter {
  constructor({client, auth, cwd, mode = 'default', session, mcp, maxToolCallsPerTurn, agentLimits, allowAlways, web, focusEnabled = true, accountId = null, accountLabel = null, accountFiles = null, accountPool = null}) {
    super();
    this.auth = auth; this.cwd = cwd; this.mode = mode; this.mcp = mcp;
    // Multi-account (src/accounts.js): which account's Muse this window is talking to, and
    // the pool a failover may pull the next account from. Null pool = single-account window.
    this.accountId = accountId; this.accountLabel = accountLabel; this.accountFiles = accountFiles; this.accountPool = accountPool; this._switching = false;
    this.pendingHandoff = null; // a handoff note for the next account's Muse, consumed by the first turn after a switch (runTurn)
    this.maxToolCallsPerTurn = resolveMaxToolCallsPerTurn(maxToolCallsPerTurn);
    this.agentLimits = resolveAgentLimits(agentLimits); this.spawnedThisTurn = 0;
    this.userTurnSeq = 0; this.usagePool = null; // the parallel agents' pooled usage for the turn-end total (see beginUserTurn)
    this.focusEnabled = focusEnabled; this.focusRun = null; this.lastFocus = null; this.resumeFocus = null;
    this.shells = new Shells();
    this.shells.on('change', s => this.emit('shell', s));
    // Messages the user sends while the main turn runs: they ride the next tool result back to
    // Muse (see toolEnd), with the terminal's queue as the fallback if no tool call comes.
    this.steerQueue = [];
    this.ctx = {cwd, readFiles: new Set(), todos: [], shells: this.shells};
    this.workers = new Map([['main', new Worker({tag: 'main', session: session || sessions.create(cwd), ctx: this.ctx})]]);
    this.device = null; this.nextTag = 1;
    this.web = web; // its cookie jar is what the gateway logs in with (see reloadLogin)
    this.allowAlways = new Set(allowAlways || []); // "don't ask again" keys, remembered per folder (src/permissions.js)
    this.approver = async () => ({allow: false, reason: 'no approver'});
    this.retries = 0; this.retryTimer = null; this.reconnecting = null; this.closed = false;
    this.invokes = {inflight: new Map(), completed: new Map()};
    this.wireClient(client);
    if (this.accountId && this.main?.session && !this.main.session.account) this.main.session.account = this.accountId;
  }
  // The gateway client's listeners, (re)bound whenever the client is replaced by an account
  // switch. Handlers ignore events from a client that is no longer current: a switched-away
  // client is disconnected, but a late status event from it must not schedule a reconnect
  // (or mark the new connection unsubscribed).
  wireClient(client) {
    this.client = client;
    this.reconnecting = null; // #9: a deduped reconnect for the OLD client must not be handed to the new one
    client.on('event', e => { if (this.client === client) this.onChatEvent(e); });
    this.steps = new MuseSteps(client, e => this.onMuseStep(e));
    client.on('status', ({status}) => { if (this.client !== client) return; if (status !== 'connected') this.subscribed = false; if (!['connected', 'connecting', 'auth_required'].includes(status)) this.scheduleReconnect(); });
    client.on('stream-end', s => { if (this.client === client) this.onStreamClosed(s); }); client.on('stream-error', s => { if (this.client === client) this.onStreamClosed(s); });
  }
  get main() { return this.workers.get('main'); }
  get session() { return this.main.session; }
  // A chat started here (/new, /clear) belongs to this window's account: untagged, a later
  // resume could not tell which account's Muse holds it and started it on whichever the pool
  // picked. A resumed chat keeps the account it already names.
  set session(s) { if (s && this.accountId && !s.account && !s.turns) s.account = this.accountId; this.main.session = s; this.lastFocus = null; this.resumeFocus = null; }
  get turn() { return this.main.turn; }
  get busy() { return !!this.focusRun || [...this.workers.values()].some(w => w.turn || w.starting); }
  agents() { return [...this.workers.values()].filter(w => !w.main).map(w => w.snapshot()); }

  commands() {
    const all = {...commandsV2(), ...AGENT_TOOLS, ...FOCUS_TOOLS, ...(this.mcp ? this.mcp.defs() : {})};
    return Object.fromEntries(Object.entries(all).map(([k, d]) => [k, {...d, optional: {...(d.optional || {}), ...AGENT_PARAM}}]));
  }
  async connectDevice() {
    if (this.closed) throw new Error('closed');
    const vm = await this.auth.vm();
    if (this.closed) throw new Error('closed');
    // Other muser windows on this PC hand over calls that Muse sent here but belong to their turns.
    if (!this.relay && !this.closed) this.relay = new Relay({takes: p => !!this.route(p), account: () => this.accountId, run: (c, p, t, id) => this.execute(c, p, t, id, {forwarded: true})}).start();
    const old = this.device;
    // This window's own node id, kept across reconnects (taken again only when the login's changed).
    const base = this.auth.saved.nodeId;
    if (this.nodeSlot?.base !== base) { this.nodeSlot?.release(); this.nodeSlot = {...nodeSlots.claim(base), base}; }
    const {slot, nodeId} = this.nodeSlot;
    const device = this.device = new NativeDevice({commands: this.commands(), displayName: slot > 1 ? DEVICE_NAME + ' ' + slot : DEVICE_NAME, invokes: this.invokes, execute: (c, p, t, id) => this.execute(c, p, t, id)});
    old?.disconnect();
    device.on('status', s => { this.emit('device', s); if (!s.connected && s.message !== 'connecting' && device === this.device) this.scheduleReconnect(); });
    await device.connect({vm, nodeId});
    // A window closed meanwhile must not stay the device Muse sends calls to.
    if (this.closed) { device.disconnect(); throw new Error('closed'); }
    // A real device is up: the one place an automatic chat command belongs.
    // (Not in ensureConnected — that path also runs against stand-in devices,
    // whose sends are turns, and an extra send there corrupts their replies.)
    this.ensureUsageOn();
  }
  // Sleep, a network change or a gateway restart closes the sockets, and nothing reopened them:
  // every later turn failed with "not connected" until muser was restarted. Reopen whatever is
  // down before each turn, and in the background (backing off) as soon as a socket drops.
  // Connecting on the current account, with one automatic failover on top: when the failure
  // is an authentication one (the login lapsed, the account's device registration does not
  // match its VM) and a pool with another ready account exists, the window switches account
  // and connects there instead of dying. Only between turns — a running conversation lives
  // on the current account's Muse and is never moved silently (see switchAccount).
  async ensureConnected() {
    try { return await this.connectCurrent(); }
    catch (e) {
      // #15: `busy` includes the STARTING worker that called us (runTurn sets starting
      // before connecting), which made this failover unreachable from any turn. Only a
      // turn actually running (or a Focus run) blocks a switch, not a pre-turn start.
      const anyTurn = [...this.workers.values()].some(w => w.turn) || !!this.focusRun;
      if (!this.accountPool || this._switching || anyTurn || this.closed) throw e;
      // A device registration that no longer matches the account's VM (pc-auth deviceMismatch)
      // is an account problem like a lapsed login: it was rethrown and the turn died.
      if (this.client?.status !== 'auth_required' && !e?.loginExpired && !e?.deviceMismatch) throw e;
      const ok = await this.failoverAccount('auth').catch(() => false);
      if (!ok) throw e;
    }
  }
  async failoverAccount(reason) {
    // See ensureConnected (#15): a merely starting worker must not block failover;
    // a running turn still does (a live conversation is never moved silently).
    const anyTurn = [...this.workers.values()].some(w => w.turn) || !!this.focusRun;
    if (!this.accountPool || this._switching || anyTurn || this.closed) return false;
    // Quota: moving is only worth it to an account with allowance left. When every other one is
    // used up too, the switch started a fresh chat on an equally exhausted Muse, and the next
    // turn's check switched again: a new chat every turn, between dead accounts. (A lapsed login
    // still moves even then: an exhausted account that answers beats one that cannot connect.)
    const next = await this.accountPool.next(new Set([this.accountId]), {alive: reason === 'quota'}).catch(() => null);
    if (!next) return false;
    await this.switchAccount(next, {reason});
    return true;
  }
  // Move this window to another account's bundle ({account, files, web, auth, client} from
  // src/account-pool.js). The old gateway and device links go down, the new account connects,
  // and the main chat starts as a NEW session: the other account's Muse has never seen this
  // conversation, so carrying the old session id over would fake a continuation. The old
  // session stays in the local index (marked with its account) for /resume.
  async switchAccount(next, {reason = 'manual'} = {}) {
    if (this.busy || this.focusRun) throw new Error(t('作業中はアカウントを切り替えられません'));
    if (!next?.client || !next?.auth || !next?.web || !next?.account) throw new Error(t('アカウントの切り替え先を準備できませんでした。'));
    this._switching = true;
    try {
      // The other account's gateway first, while this one still works: a target whose login
      // lapsed used to fail AFTER this window's links were torn down, leaving it on an account
      // it could not reach. A warmed bundle is already connected.
      if (next.client.status !== 'connected') await next.client.connect();
      // The device side too (its registration must match the target's VM): checked here, it
      // fails while this window still works.
      await next.auth.vm();
      const from = this.accountId;
      const old = {client: this.client, steps: this.steps, web: this.web, auth: this.auth, accountFiles: this.accountFiles, accountId: this.accountId, accountLabel: this.accountLabel, session: this.session};
      // #8: what the teardown below drops, kept for the rollback: idle workers are
      // deleted outright, and the session setter clears the Focus stash — a failed
      // switch used to lose both even though the window stayed on the old account.
      const droppedWorkers = [...this.workers.entries()].filter(([, w]) => !w.main && !w.turn && !w.starting);
      const savedFocus = {resumeFocus: this.resumeFocus, lastFocus: this.lastFocus};
      for (const [tag, w] of this.workers) if (!w.main && !w.turn && !w.starting) this.workers.delete(tag);
      this.device?.disconnect(); this.device = null;
      this.nodeSlot?.release(); this.nodeSlot = null;
      this.client?.disconnect(false);
      this.web = next.web; this.auth = next.auth; this.accountFiles = next.files || null;
      this.wireClient(next.client);
      // The incoming bundle was already taken out of the warm cache by the pool; drop
      // whatever else was kept warm for the old prediction.
      try { this.accountPool?.drop?.(); } catch {}
      this.accountId = next.account.id; this.accountLabel = next.account.label;
      this.subscribed = false; this.everConnected = false;
      const fresh = sessions.create(this.cwd); fresh.account = next.account.id;
      this.session = fresh;
      try { await this.connectCurrent(); }
      catch (e) {
        // The links came down and the new account's did not come up (subscribe, the device
        // link): the window went on "switched" to an account it could not reach, with no
        // 'account' event, so the screen still named the old one. Back to the old account —
        // its links reconnect in the background — and the caller hears the error.
        this.device?.disconnect(); this.device = null;
        this.nodeSlot?.release(); this.nodeSlot = null;
        try { next.client.disconnect(false); } catch {}
        Object.assign(this, {client: old.client, steps: old.steps, web: old.web, auth: old.auth, accountFiles: old.accountFiles, accountId: old.accountId, accountLabel: old.accountLabel});
        this.main.session = old.session;
        for (const [tag, w] of droppedWorkers) if (!this.workers.has(tag)) this.workers.set(tag, w);
        Object.assign(this, savedFocus);
        this.subscribed = false;
        this.scheduleReconnect();
        throw e;
      }
      // This window moves; the default account does not (only `muser account use` changes it).
      this.emit('account', {from, fromSession: old.session?.id || null, id: this.accountId, label: this.accountLabel, reason});
      return true;
    } finally { this._switching = false; }
  }
  // Keep the pool's predicted next account connected in the background, so a switch
  // skips the gateway login handshake (its device link still connects at switch time).
  // Fire and forget: a failed warm-up only means the switch connects the slow way.
  warmStandby() {
    if (this.closed || !this.accountPool?.warm) return;
    this.accountPool.warm(new Set([this.accountId])).catch(() => {});
  }
  connectCurrent() {
    if (this.reconnecting) return this.reconnecting;
    const client = this.client; // #9: if a switch replaces the client mid-connect, this run is stale
    const run = (async () => {
      if (this.closed) throw new Error('closed');
      const down = this.client.status !== 'connected' || this.client.ws?.readyState !== 1 || !this.subscribed || !this.device?.connected;
      const first = !this.everConnected;
      if (down) this.emit('connection', {state: first ? 'connecting' : 'reconnecting'});
      if (this.client.status === 'connected' && this.client.ws?.readyState !== 1) this.client.disconnect(false);
      // A subscribe that failed after a good connect left the gateway "connected" but deaf, and the
      // next attempt skipped it: replies never streamed again. It is tracked on its own now.
      if (this.client.status !== 'connected' || !this.subscribed) {
        if (this.client.status !== 'connected') { this.subscribed = false; await this.client.connect(); }
        if (this.client !== client) throw new Error('connection superseded by an account switch');
        if (this.closed) throw new Error('closed');
        await this.client.subscribe(); this.subscribed = true; this.subscribedAt = Date.now();
        if (this.client !== client) throw new Error('connection superseded by an account switch');
        // Turns that were running follow their chats again (the old subscriptions died with the socket).
        for (const w of this.workers.values()) if (w.turn?.owner) { this.client.subscribeAgent(w.session.id, w.turn.owner).catch(() => {}); w.turn.waiting?.refresh(); }
      }
      if (this.closed) throw new Error('closed');
      if (!this.device?.connected) await this.connectDevice();
      if (this.client !== client) throw new Error('connection superseded by an account switch');
      this.retries = 0; this.everConnected = true;
      if (down) this.emit('connection', {state: 'connected', first});
      if (first) this.warmStandby();
    })().catch(e => { this.emit('connection', {state: this.client.status === 'auth_required' ? 'auth' : 'failed', error: e.message}); throw e; });
    this.reconnecting = run;
    run.then(
      () => { if (this.reconnecting === run) this.reconnecting = null; },
      () => {
        if (this.reconnecting === run) this.reconnecting = null;
        // #16: a failed attempt used to leave no retry behind when the request that
        // noticed the drop arrived while this run was in flight (scheduleReconnect
        // was dropped for `reconnecting`). The run itself now leaves the timer.
        if (!this.closed && this.client.status !== 'auth_required') this.scheduleReconnect();
      });
    return run;
  }
  // Muse attaches the real per-turn token counts (the [usage] line, see
  // src/turn-usage.js) only once the account has been told "/usage on" — a
  // chat command nobody sends by hand, so the counts simply never arrived.
  // muser sends it itself: once per account, on a scratch session (the
  // command applies account-wide; the user's conversations stay clean),
  // remembered in accounts' identity store. A turn that carries the counts
  // refreshes the record (see runTurn), so a working account is not asked
  // again; when the counts stop arriving — switched off on the web, say —
  // the command is retried, at most once an hour. Best effort throughout:
  // connectDevice calls it without awaiting, so a failure here must not cost
  // the user their turn. Returns the attempt's promise for tests.
  ensureUsageOn() {
    if (this._usageCmdBusy) return;
    this._usageCmdBusy = true;
    return (async () => {
      try {
        if (!this.device?.connected) return;
        const accounts = require('./accounts');
        const id = this.accountId || accounts.DEFAULT_ID;
        const rec = accounts.usageCmd(id);
        const now = Date.now();
        if (rec?.seen && now - rec.seen < 24 * 3600 * 1000) return;
        if (rec?.sent && now - rec.sent < 3600 * 1000) return;
        const session = rec?.session || crypto.randomUUID();
        await this.device.send('/usage on', session, {command: true, timeoutMs: 15000});
        accounts.rememberUsageCmdSent(id, session);
      } catch { /* retried on a later connect */ }
      finally { this._usageCmdBusy = false; }
    })();
  }
  scheduleReconnect() {
    if (this.closed || this.retryTimer || this.reconnecting) return;
    const delay = [1, 3, 10, 30, 60][Math.min(this.retries, 4)] * 1000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // A lapsed login will not fix itself; the next turn tries again and reports it.
      this.ensureConnected().catch(() => { this.retries++; if (this.client.status !== 'auth_required') this.scheduleReconnect(); });
    }, delay);
    this.retryTimer.unref?.();
  }
  // The gateway can end a /chat/subscribe stream while the socket stays up; nothing opened it
  // again, so replies stopped streaming (only the 5 s poll still found them) until a drop. The
  // main subscription is opened again, backing off when it keeps ending soon after it opened; a
  // running turn's own subscription is reopened for that turn.
  onStreamClosed({path, scope} = {}) {
    if (path !== '/chat/subscribe' || this.closed) return;
    if (scope) {
      // #11: a scoped stream that ends at once used to be resubscribed at once, for
      // as long as the gateway kept ending it — a tight loop. Per-scope backoff,
      // the same shape as the main subscription's below.
      const now = Date.now();
      this.scopeResubs ||= new Map();
      const prev = this.scopeResubs.get(scope) || {};
      const count = now - (prev.at || 0) < 30000 ? (prev.count || 0) + 1 : 0;
      clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        this.scopeResubs?.delete(scope);
        for (const w of this.workers.values()) if (w.turn?.owner === scope) { this.client.subscribeAgent(w.session.id, scope).catch(() => {}); w.turn.waiting?.refresh(); }
      }, Math.min(60000, 1000 * 2 ** count));
      timer.unref?.();
      this.scopeResubs.set(scope, {at: now, count, timer});
      return;
    }
    this.subscribed = false;
    this.resubscribes = Date.now() - (this.subscribedAt || 0) < 30000 ? (this.resubscribes || 0) + 1 : 0;
    clearTimeout(this.resubTimer);
    this.resubTimer = setTimeout(() => { this.ensureConnected().catch(() => this.scheduleReconnect()); }, Math.min(60000, 1000 * 2 ** this.resubscribes));
    this.resubTimer.unref?.();
  }
  // Commands are fixed at link.register, so a change in MCP servers re-registers the device.
  async reconnectDevice() { if (this.busy) throw new Error(t('作業中は切り替えられません')); await this.connectDevice(); }

  // Which chat a device invoke belongs to: its agent tag, else the only one working.
  // Outside any running turn, or with several running and no tag, nothing is done:
  // the call may come from another chat, and the user is not watching.
  route(params) { return routeFor(this.workers, params); }

  async execute(command, rawParams, timeoutMs, id, {forwarded = false} = {}) {
    const {agent: _tag, ...params} = rawParams || {};
    const w = this.route(rawParams);
    if (!w) {
      // Muse may have sent this to the wrong muser window on this PC (src/relay.js).
      const r = !forwarded && this.relay ? await this.relay.forward(command, rawParams, timeoutMs, id).catch(() => null) : null;
      if (r?.result) return r.result;
      if (r?.error) return {ok: false, error: 'This call went to another muser window on this PC, the one whose task it belongs to, and its answer did not come back (' + r.error + '). It may have run there; check before trying it again.'};
      if (r?.takers > 1) return {ok: false, error: 'Several muser windows on this PC are working at once, and this call could not be matched to its window. Try the call again; if it keeps failing, tell the user to run one muser task at a time.'};
      // Work is running here, so "idle" would be wrong: say what did not match.
      const running = [...this.workers.values()].filter(x => x.turn).map(x => x.tag);
      const tag = typeof rawParams?.agent === 'string' ? rawParams.agent.trim() : '';
      if (running.length && tag) return {ok: false, error: 'No running task here has the agent tag "' + tag + '" (running: ' + running.join(', ') + '). Use your own tag, or omit it in the main session.'};
      if (running.length) return {ok: false, error: 'Several parallel agents are running here (' + running.join(', ') + ') and this call has no agent tag: a parallel agent must pass its own tag as agent.'};
      return {ok: false, error: 'muser is idle: only a turn sent from this terminal may use this device.'};
    }
    if (command.startsWith('focus.') && FOCUS_TOOLS[command]) return this.executeFocusTool(w, command, params);
    if (command === 'agent.spawn' || command === 'agent.wait') return this.executeAgentTool(w, command, params);
    if (w.type && !agentTypes.allows(w.type, command)) {
      if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)}; // #13: refused calls still count
      const error = command + ' is not available to the ' + w.typeName + ' agent type (allowed: ' + w.type.tools.join(', ') + ').';
      this.emit('agent-tool', {id, agent: w.tag, command, params, summary: '', ok: false, error}); return {ok: false, error};
    }
    if (command === 'progress.report') return this.reportProgress(w, params, id);
    if (command === 'spinner.set') return this.setSpinner(w, params, id);
    if (command.startsWith('mcp.') && this.mcp?.commands.has(command)) return this.executeMcp(w, command, params, id, timeoutMs);
    const tool = TOOLS[command];
    if (!tool) { // #13: an unknown command used to cost no budget, so the 250/turn runaway guard never bit on a loop of them
      if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)};
      return {ok: false, error: 'Unknown command ' + command};
    }
    // #7: execute() strips the agent tag from params, so shell.output's per-caller
    // cursor always fell back to 'main' and one worker pre-read another's lines.
    // The routed worker IS the caller; an explicit caller id from Muse still wins.
    if (command === 'shell.output' && !params.caller) params.caller = w.tag;
    // deadline: when the device link answers Muse invoke_timeout for this call (Muse's timeout + the
    // link's 30 s watchdog, src/core/native-device.js); an approval past it is void.
    const call = {id, agent: w.tag, command, params, kind: tool.kind, summary: safe(() => tool.summary(params)) || '', ...(timeoutMs ? {deadline: Date.now() + timeoutMs + INVOKE_GRACE_MS} : {})};
    // Attach the approval preview (diff for edit/write/patch) BEFORE decide/ask, so the
    // approver and the UI can show what will change. A broken preview never blocks the call.
    if (typeof tool.preview === 'function') { const preview = safe(() => tool.preview(params, w.ctx)); if (preview !== undefined) call.preview = preview; }
    this.toolStart(w, call);
    if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return this.toolEnd(w, call, {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)});
    try {
      const targets = [].concat(tool.target ? safe(() => tool.target(params, w.ctx)) || [] : []);
      const cwd = realOf(typeof params.cwd === 'string' && params.cwd.trim() ? path.resolve(w.ctx.cwd, params.cwd) : w.ctx.cwd);
      // Compared where the paths really lead: a junction in the project must not carry a write outside it.
      const realTargets = targets.map(realOf), realCwd = realOf(this.cwd);
      const verdict = decide({mode: this.modeFor(w), kind: tool.kind, command, params, outside: realTargets.some(t => !inside(realCwd, t)), targets: realTargets, cwd, root: realCwd, always: this.allowAlways});
      if (verdict === 'deny') return this.toolEnd(w, call, {ok: false, error: (w.type?.readOnly ? 'This ' + w.typeName + ' agent is read-only' : 'Not allowed in ' + this.mode + ' mode (read-only)') + '. Explain what you would change instead.'});
      if (verdict === 'ask') { const no = await this.ask(w, call); if (no) return no; }
      const r = await tool.run(params, w.ctx, w.turn?.controller.signal, chunk => this.emit('tool-output', {id, agent: w.tag, chunk}));
      if (command === 'todo.write') { if (w.main) this.emit('todos', w.ctx.todos); else this.update(w); }
      return this.toolEnd(w, {...call, view: r.view}, {ok: true, payload: r.payload});
    } catch (e) { return this.toolEnd(w, call, {ok: false, error: e.message}); }
  }

  executeFocusTool(w, command, params) {
    const focus = w.main && w.turn?.focus;
    if (!focus) { // #13: with Focus inactive these calls were free, outside the budget entirely
      if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)};
      return {ok: false, error: 'Focus is not active for this turn.'};
    }
    if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)};
    try {
      const state = command === 'focus.plan' ? focus.plan(params.criteria, {newTask: params.new_task === true || params.new_task === 'true'}) : command === 'focus.checkpoint' ? focus.checkpoint(params.checks) : command === 'focus.ask_user' ? focus.askUser(params.question) : focus.snapshot();
      this.emit('focus', state);
      return {ok: true, payload: focus.modelState()};
    } catch (e) { return {ok: false, error: e.message}; }
  }

  // spinner.set: Muse picks the word on its own spinner. Display only, so it is not counted against
  // the tool-call limit; past five in one turn the rest are ignored.
  setSpinner(w, params, id) {
    if (typeof params.word !== 'string') return {ok: false, error: 'word must be a string.'};
    const word = params.word.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/(\u2026|\.\.\.)+$/, '').trim();
    if (!word || word.length > 40) return {ok: false, error: 'word must contain 1-40 characters.'};
    if (w.turn) { w.turn.spinnerSets = (w.turn.spinnerSets || 0) + 1; if (w.turn.spinnerSets > 5) return {ok: true, payload: {displayed: false}}; }
    (w.turn ? (w.turn.calls ||= []) : []).push({id, start: Date.now(), end: Date.now()}); // no duplicate Muse-side card
    this.emit('spinner', {agent: w.tag, word});
    return {ok: true, payload: {displayed: true}};
  }

  reportProgress(w, params, id) {
    if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)};
    if (typeof params.message !== 'string') return {ok: false, error: 'message must be a string.'};
    const message = params.message.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
    if (!message || message.length > 2000) return {ok: false, error: 'message must contain 1-2000 characters.'};
    const report = {agent: w.tag, message, at: Date.now()};
    // Suppress Muse's duplicate device-action card, just as for ordinary tools.
    (w.turn.calls ||= []).push({id, start: report.at, end: report.at});
    const logTurn = w.main ? w.turn : (w.spawnedIn === this.main.turn ? this.main.turn : w.turn);
    if (logTurn) {
      logTurn.log ||= {tools: [], steps: []};
      (logTurn.log.progress ||= []).push(report);
      if (logTurn.log.progress.length > 300) logTurn.log.progress.shift();
    }
    this.emit('progress', report);
    return {ok: true, payload: {displayed: true}};
  }

  async executeMcp(w, command, params, id, timeoutMs) {
    const m = this.mcp.commands.get(command);
    // #12: Focus's change detection saw the server's RAW readOnly annotation, which
    // policy deliberately distrusts (mcpEffectiveKind). Hand Focus the effective one:
    // a server that writes while claiming read-only no longer keeps evidence fresh.
    const call = {id, agent: w.tag, command, params, kind: 'mcp', mcp: {server: m.server, tool: m.tool, readOnly: mcpEffectiveKind(this.mcp, m) === 'read'}, summary: m.server + ' · ' + m.tool, ...(timeoutMs ? {deadline: Date.now() + timeoutMs + INVOKE_GRACE_MS} : {})};
    this.toolStart(w, call);
    if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return this.toolEnd(w, call, {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)});
    try {
      const verdict = decide({mode: this.modeFor(w), kind: mcpEffectiveKind(this.mcp, m), command, params, always: this.allowAlways});
      if (verdict === 'deny') return this.toolEnd(w, call, {ok: false, error: 'Not allowed in ' + this.mode + ' mode (read-only): this MCP tool may change things.'});
      if (verdict === 'ask') { const no = await this.ask(w, call); if (no) return no; }
      const r = await this.mcp.call(command, params, w.turn?.controller.signal);
      return this.toolEnd(w, {...call, view: {text: r.text}}, r.isError ? {ok: false, error: r.text} : {ok: true, payload: {result: r.text}});
    } catch (e) { return this.toolEnd(w, call, {ok: false, error: e.message}); }
  }

  async executeAgentTool(w, command, params) {
    if (!w.main) return {ok: false, error: 'Only the main session can manage parallel agents.'};
    const call = {id: crypto.randomUUID(), agent: 'main', command, params, kind: 'agent', summary: command === 'agent.spawn' ? String(params.title || params.task || '').slice(0, 60) : String(params.tags || 'all')};
    if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return this.toolEnd(w, call, {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)});
    if (command === 'agent.spawn') {
      try { const sub = this.spawn(String(params.task || ''), {title: params.title, by: 'muse', type: params.type}); return this.toolEnd(w, {...call, view: {tag: sub.tag, type: sub.typeName}}, {ok: true, payload: {tag: sub.tag, type: sub.typeName, started: true}}); }
      catch (e) { return this.toolEnd(w, call, {ok: false, error: e.message}); }
    }
    pruneCollectedWorkers(this.workers);
    this.toolStart(w, call);
    const tags = String(params.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    // #5: a tag naming main used to put main itself in the wait list, so main waited
    // on its own turn until the timeout. Main is never a waitable parallel agent.
    const list = (tags.length ? tags.map(t => this.workers.get(t)).filter(x => x && !x.main) : [...this.workers.values()].filter(x => !x.main));
    // A tag that names no agent was dropped without a word, and an empty answer read as "all done".
    const unknown = tags.filter(t => !this.workers.has(t) || this.workers.get(t).main);
    if (unknown.length && !list.length) return this.toolEnd(w, call, {ok: false, error: 'No parallel agent with tag ' + unknown.join(', ') + '. Running agents: ' + ([...this.workers.values()].filter(x => !x.main).map(x => x.tag).join(', ') || 'none') + '.'});
    const until = Date.now() + Math.min(120, Math.max(1, params.timeout_s | 0 || 60)) * 1000;
    // #4: a worker still connecting (starting, no turn yet) is work in flight, not
    // idle: waiting must wait for it too, or main reads "nothing happened" and
    // duplicates the work.
    while (list.some(x => x.turn || x.starting) && Date.now() < until && w.turn && !w.turn.controller.signal.aborted) await new Promise(r => setTimeout(r, 1000));
    // #6: a long result is handed out in 8000-char slices across waits (resultOffset),
    // and the worker counts as collected only once its tail has been delivered —
    // truncating at 8000 and pruning made the tail unrecoverable.
    const agents = list.map(x => {
      const state = x.starting && !x.turn ? 'starting' : x.state;
      if (x.state !== 'done') return {tag: x.tag, title: x.title, state, ...(x.error ? {error: x.error} : {}), ...(state === 'working' || state === 'starting' ? {last_tool: x.lastTool} : {})};
      const offset = x.resultOffset || 0, slice = x.result.slice(offset, offset + 8000), more = offset + slice.length < x.result.length;
      return {tag: x.tag, title: x.title, state, result: more ? slice + String.fromCharCode(10) + '… (cut: ' + (x.result.length - offset - slice.length) + ' more characters of ' + x.result.length + '; call agent.wait again for the rest)' : slice, ...(more ? {result_truncated: true, result_offset: offset + slice.length} : {}), ...(x.error ? {error: x.error} : {})};
    });
    for (const x of list) if (x.state === 'done') {
      const offset = (x.resultOffset || 0) + 8000;
      if (offset >= x.result.length) x.collected = true; // pruned on the next spawn / wait
      else x.resultOffset = offset;
    }
    return this.toolEnd(w, {...call, view: {agents: agents.map(a => a.tag + ' ' + a.state)}}, {ok: true, payload: {agents, ...(unknown.length ? {unknown_tags: unknown} : {})}});
  }

  // Read-only agent types run under plan rules whatever the session mode is.
  modeFor(w) { return w.type?.readOnly ? 'plan' : this.mode; }
  // Asks the user; returns the refusal to send back, or null when allowed.
  async ask(w, call) {
    // The approval belongs to this turn: stopped meanwhile (esc, /agents stop), the change must not
    // run when the approval comes later (it did, after the task was gone). The screen closes it too.
    const turn = w.turn;
    if (turn) Object.defineProperty(call, 'abortSignal', {value: turn.controller.signal, enumerable: false});
    const answer = await this.approver(call);
    if (!turn || w.turn !== turn || turn.controller.signal.aborted) return this.toolEnd(w, {...call, declined: true}, {ok: false, error: 'The task was stopped before the user answered; nothing was done.'});
    // Muse had already given up on the call (it got invoke_timeout): approving then ran the change
    // anyway, unseen by Muse, which may try it again. Nothing is done past the deadline.
    if (answer.expired || (call.deadline && Date.now() > call.deadline)) return this.toolEnd(w, {...call, declined: true}, {ok: false, error: 'Muse stopped waiting for this call before the user answered; nothing was done. Ask again if it is still needed.'});
    if (answer.always) { this.allowAlways.add(answer.always); require('./permissions').addAllow(this.cwd, answer.always); }
    if (answer.allow) return null;
    return this.toolEnd(w, {...call, declined: true}, {ok: false, error: 'The user declined this' + (answer.reason ? ': ' + answer.reason : '.') + ' Do not retry it unless the user asks.'});
  }
  toolStart(w, call) {
    if (w.turn) (w.turn.calls ||= []).push({id: call.id, start: Date.now(), end: null}); // see muse-steps duringToolCall
    if (w.main) this.emit('tool-start', call);
    else { w.lastTool = (call.kind === 'mcp' ? 'MCP ' : '') + call.command.replace(/^code\./, '') + (call.summary ? ' ' + call.summary : ''); this.update(w); }
  }
  toolEnd(w, call, result) {
    const tracking = w.turn?.focus || (w.focusTask === this.focusRun?.focus ? w.focusTask : null);
    const evidenceId = tracking?.observe(call, result);
    // Only results that can prove something carry an ID: an edit's ID, once cited, was refused
    // at the checkpoint and sent Muse round in circles.
    if (evidenceId && tracking.evidence.find(e => e.id === evidenceId)?.usable && result.ok && result.payload && typeof result.payload === 'object' && !Array.isArray(result.payload))
      result = {...result, payload: {...result.payload, muser_evidence_id: evidenceId}};
    // Steering: a message the user sent while this turn runs rides this result back to Muse —
    // the only channel into a running turn (Claude Code injects such messages between tool
    // calls). It is marked as the user's and outranks the earlier instruction where they clash.
    if (w.main && this.steerQueue.length && result.ok && result.payload && typeof result.payload === 'object' && !Array.isArray(result.payload)) {
      const texts = this.steerQueue.splice(0);
      result = {...result, payload: {...result.payload, user_message: 'The user sent this message while you were working. Read it now and follow it; where it conflicts with the earlier instruction, this message wins.\n\n' + texts.join('\n\n')}};
      this.emit('steer', {texts});
    }
    // output: the whole text Muse got back (the screen shows a few lines), for /output.
    const done = {...call, ok: result.ok, ...(result.ok ? {} : {error: result.error}), output: outputText(result)};
    if (w.turn) { const c = (w.turn.calls ||= []).find(x => x.id === call.id && x.end === null); if (c) c.end = Date.now(); else w.turn.calls.push({id: call.id, start: Date.now(), end: Date.now()}); }
    // #26: keep the LAST 300, not the first: the old length guard froze the log at
    // the first 300 calls, so a long turn's final calls (often the verification)
    // silently never reached the transcript. record()'s slice(-300) now has a tail.
    if (w.turn?.log) { w.turn.log.tools.push({command: call.command, summary: String(call.summary || '').slice(0, 200), ok: !!result.ok, ...(result.ok ? {} : {error: String(result.error || '').slice(0, 300)})}); if (w.turn.log.tools.length > 300) w.turn.log.tools.shift(); }
    if (w.main) this.emit('tool-end', done); else this.emit('agent-tool', done);
    return result;
  }
  update(w) { this.emit('agent-update', w.snapshot()); }

  onChatEvent(e) {
    const p = e.payload || {}, sid = p.session_id || e.session_id;
    // Side-chat events all carry parent_agent_id (the agent running the thread), so it is not a filter here.
    const w = [...this.workers.values()].find(x => x.turn && x.session.id === sid);
    if (!w) return;
    const t = w.turn, name = e.event || '';
    // The turn's real usage lives only in a live event's transcript.messages
    // (never in display_text or history): attach it to the turn — and to the
    // worker, so a parallel agent's snapshot carries it — as soon as it arrives.
    const foundUsage = usageFromTranscript(p.transcript);
    if (foundUsage?.usage) { t.usage = foundUsage.usage; w.usage = foundUsage.usage; }
    if (name.startsWith('delta.') && typeof p.message_id === 'string') {
      if (t.baseline.has(p.message_id)) return;
      const m = t.messages.get(p.message_id) || {text: '', seq: 0};
      if (p.seq && Number(p.seq) <= m.seq) return;
      m.seq = Number(p.seq) || m.seq;
      let changed = false;
      if (name === 'delta.text_append' && typeof p.text === 'string') { m.text = stripTurnUsage(m.text + p.text); changed = true; }
      else if (name === 'delta.presentation' && typeof p.display_text === 'string') { m.text = stripTurnUsage(p.display_text); changed = true; }
      else if (name === 'delta.message_done') {
        for (const c of citations(p.resources)) t.sources.set(c.uri, c);
        const tr = p.transcript, rawFinal = tr?.display_text ?? tr?.content ?? tr?.text;
        const parsedFinal = typeof rawFinal === 'string' ? parseTurnUsage(rawFinal) : null;
        if (parsedFinal?.usage) { t.usage = parsedFinal.usage; w.usage = parsedFinal.usage; }
        const final = parsedFinal ? parsedFinal.body : (typeof rawFinal === 'string' ? stripTurnUsage(rawFinal) : rawFinal);
        if (typeof final === 'string' && final !== m.text) { m.text = final; changed = true; }
      }
      t.messages.set(p.message_id, m);
      if (w.main) {
        if (changed) this.emit('text', {id: p.message_id, text: m.text});
        if (name === 'delta.message_done') this.emit('message-done', {id: p.message_id, text: m.text});
      } else if (changed) { w.text = m.text; this.update(w); }
    } else if (name === 'task.status' && w.main) this.emit('status', String(p.status || ''));
    else if (name === 'agent.status') {
      // What Muse is doing on its side ("Searching Ink version", "Reading code"; an emoji such as 🌐
      // only sometimes). Generic states arrive with Muse's name cut off ("は動作中です"): not steps.
      const text = String(p.activity_text || '').trim(), generic = /(は|is )?(動作中|応答中|working|responding)(です)?$/i.test(text);
      const step = p.activity_code === 'working' && text && !generic ? (p.activity_emoji ? p.activity_emoji + ' ' : '') + text : '';
      if (w.main) this.emit('activity', {code: String(p.activity_code || ''), step});
      else if (step) { w.lastTool = step; this.update(w); }
      this.steps.note(w, p);
    }
  }
  // Muse's own tool calls, read from its activity feed (src/muse-steps.js).
  onMuseStep({worker: w, step, running}) {
    if (!w) return;
    // #26: same first-N freeze as the tool log; keep the last 100 steps instead.
    for (const s of step ? (step.items || [step]) : []) if (w.turn?.log) { w.turn.log.steps.push({title: s.title, ...(s.detail ? {detail: s.detail} : {}), ...(s.failed ? {failed: true} : {})}); if (w.turn.log.steps.length > 100) w.turn.log.steps.shift(); }
    if (w.main) { if (step) this.emit('muse-step', step); if (running !== undefined) this.emit('muse-running', running); }
    else if (step || running) { w.lastTool = (step ? step.title : running) + ' (Muse)'; this.update(w); }
  }

  // One turn of one worker's chat.
  async runTurn(w, text, {attachments = [], display, focus, signal, turnStart = true} = {}) {
    display ??= text;
    if (w.turn || w.starting) throw new Error(t('Muse が作業中です。'));
    // Mark the worker as starting NOW, synchronously: w.turn is only assigned
    // after ensureConnected() resolves, and spawn()'s at-a-time limit counted
    // w.turn alone, so agents spawned in one burst each saw zero running and
    // the limit never bit. Cleared on the early exits below and in the
    // turn's finally; spawn() counts w.turn || w.starting.
    w.starting = true;
    try { await this.ensureConnected(); }
    catch (e) {
      w.starting = false;
      // #14: a worker whose connection failed at spawn used to stay 'idle' forever
      // with no agent-done: record the failure on the worker before throwing.
      const err = this.client.status === 'auth_required' ? new Error(t('muse.ai のログインが切れています。/login でログインし直してください。')) : new Error(t('この PC の CLI 端末が Muse に接続していません（再接続に失敗: {error}）。', {error: e.message}));
      Object.assign(w, {state: 'failed', error: err.message, ended: Date.now()});
      if (!w.main) this.emit('agent-done', w.snapshot()); else this.update?.(w);
      throw err;
    }
    if (w.turn) { w.starting = false; throw new Error(t('Muse が作業中です。')); } // another send got in while reconnecting
    // A window on the shared node id (every slot of its account held) registers it again before
    // its turn: Muse treats that id as offline once the window that registered it LAST goes away,
    // while this window's socket stays open (2026-11-03: "Device ... is offline", nothing reconnected).
    // It also takes a slot that has been freed since. Not while another turn of this window runs.
    if (w.main && this.nodeSlot?.slot === 0 && ![...this.workers.values()].some(x => x !== w && (x.turn || x.starting))) {
      this.nodeSlot = null;
      try { await this.connectDevice(); }
      catch {
        try { await this.ensureConnected(); }
        catch (e) { // #14, same as above: the failure lands on the worker, not in silence
          w.starting = false;
          const err = new Error(t('この PC の CLI 端末が Muse に接続していません（再接続に失敗: {error}）。', {error: e.message}));
          Object.assign(w, {state: 'failed', error: err.message, ended: Date.now()});
          if (!w.main) this.emit('agent-done', w.snapshot());
          throw err;
        }
      }
      if (w.turn) { w.starting = false; throw new Error(t('Muse が作業中です。')); }
    }
    // #2: stopAgent() while this worker was still connecting: the turn never starts.
    if (w.stopRequested) {
      w.stopRequested = false; w.starting = false;
      Object.assign(w, {state: 'stopped', ended: Date.now()});
      if (!w.main) this.emit('agent-done', w.snapshot());
      throw Object.assign(new Error(t('PC の操作を停止しました。')), {name: 'AbortError'});
    }
    const first = !w.session.turns;
    const mcpNames = this.mcp ? [...this.mcp.servers.values()].filter(s => s.status === 'connected').map(s => s.name) : [];
    let body = first ? preamble(this.cwd, mcpNames, w.main ? {limits: this.agentLimits} : {tag: w.tag, by: w.by, type: w.type, typeName: w.typeName}) + '\n\n' + (w.main ? 'User:\n' : 'Task:\n') + text : w.main ? '[muser: current limits: ' + agentLimitText(this.agentLimits) + '.]\n' + PROGRESS_INSTRUCTION + '\n\nUser:\n' + text : text;
    // A handoff left by an account switch: it rides the first turn on the new account,
    // ahead of the user's words, as a [muser: ...] block. `display` is untouched, so
    // the screen and the local transcript keep only what the user typed. It is consumed
    // only once the turn is actually sent (below), so a failed send does not lose it.
    const handoff = w.main && first ? this.pendingHandoff : null;
    if (handoff) {
      const at = body.indexOf('\nUser:\n');
      body = at >= 0 ? body.slice(0, at) + '\n\n[muser: 前のアカウントからの引き継ぎ]\n' + handoff + body.slice(at) : body + '\n\n[muser: 前のアカウントからの引き継ぎ]\n' + handoff;
    }
    if (focus) body = '[muser: automatic task control]\n' + FOCUS_INSTRUCTION + '\n\n' + (focus.resumed && focus.round === 1 ? focus.resumeNote() + '\n\n' : '') + body;
    const turn = w.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, usage: null, log: {tools: [], steps: []}, ...(focus ? {focus} : {})};
    const abort = () => turn.controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    Object.assign(w, {state: 'working', started: turn.started, error: '', usage: null}); if (!w.main) this.update(w);
    // Once `waiting` exists, EVERY exit path below (send failure, subscribe failure,
    // reply, abort) must cancel it and close the agent subscription, or both leak.
    let waiting = null, owner = null;
    try {
      turn.controller.signal.throwIfAborted();
      {
        // #22: the baseline is EVERY message already in the chat, not one 50-event
        // page — a late reply from beyond that page (with no replyTo) was mistaken
        // for this turn's. First turns fetch too: a chat continued from elsewhere
        // can hold messages this window has never seen. Paged like transcript.js.
        // No baseline = an old message could be mistaken for this turn's reply, so a
        // failed history fetch on a non-first turn aborts the turn instead of guessing;
        // on a first turn there is nothing local to protect, so it proceeds empty.
        try {
          let before;
          for (let page = 0; page < 10; page++) {
            const history = await this.client.history(w.session.id, before);
            const batch = history?.chat_events || [];
            for (const ev of batch) { const m = messageFromEvent(ev); if (m) turn.baseline.add(m.id); }
            const seqs = batch.map(e => e.seq).filter(Number.isFinite);
            if (!history?.has_more || !seqs.length) break;
            before = Math.min(...seqs);
          }
        } catch (e) { if (!first) throw new Error(t('履歴の取得に失敗したためターンを開始できませんでした。少し待ってからもう一度送信してください。（{error}）', {error: e.message})); }
      }
      waiting = waitForReply({client: this.client, sessionId: w.session.id, baseline: turn.baseline, signal: turn.controller.signal, timeoutMs: 3 * 3600 * 1000});
      owner = turn.owner = 'muser-' + crypto.randomUUID(); turn.waiting = waiting;
      try {
        const ack = await this.device.send(body, w.session.id, attachments.length ? {attachments: require('./clipboard').toItems(attachments)} : {});
        // The message is with Muse from this moment: mark it sent BEFORE the
        // follow-up steps, so a failure below still records the turn. And when
        // one of them does fail, cancel the turn on Muse's side before the
        // error propagates — Muse kept working (and spending the allowance)
        // on a turn this window had already reported as failed.
        turn.sent = true;
        waiting.accept(ack?.message_id);
        try {
          // #23/#24: count the turn (touch) and consume the handoff only once the
          // follow-ups have ALL landed. Before, a subscribe failure left the turn
          // recorded but uncounted — the next send was "first" again and resent the
          // preamble — and the handoff note was gone though its turn never ran.
          sessions.touch(w.session, display);
          await this.client.subscribeAgent(w.session.id, owner); waiting.refresh();
          if (handoff) this.pendingHandoff = null;
        } catch (e) { await this.client.cancel(w.session.id).catch(() => {}); throw e; }
        // The text rides along (audit #246): the tally's token estimate needs the actual
        // words — bin used to record only the character count, so the language-aware
        // estimate in usage.estTokens never saw a single real text.
        this.emit('sent', {agent: w.tag, chars: body.length, text: body}); // for the usage tally (what went to Muse)
        if (w.main && turnStart) this.emit('turn-start'); // #31: Focus rounds/legs pass turnStart:false — one user turn, one turn-start (planAtTurn is reset by it)
        const waited = await waiting.promise;
        turn.ending = true; // #28: postSteer from here on would land as an orphan message, not inside this turn
        await this.steps.finish(turn, w);
        const focusDecision = focus?.endRound({workersPending: [...this.workers.values()].some(x => !x.main && x.focusTask === focus && (x.turn || x.starting)), pendingUserInput: !!this.focusInputPending});
        // The reply itself comes from history, which never carries the [usage] line;
        // the usage (if any) arrived on the live event and sits on turn.usage. Strip
        // anyway, so a reply that did carry the line can never reach the screen,
        // the transcript, /resume or exec output.
        const parsedReply = parseTurnUsage(waited.text || '');
        if (parsedReply?.usage && !turn.usage) { turn.usage = parsedReply.usage; w.usage = parsedReply.usage; }
        const reply = {...waited, text: stripTurnUsage(waited.text || ''), ...(turn.usage ? {usage: turn.usage} : {})};
        // One event per reply that carried usage, main and parallel alike: the
        // daily tally listens to this, not to turn-end, so a user turn of
        // several replies counts every reply exactly once (a turn-end's summed
        // usage must never be tallied again on top of it).
        if (turn.usage) { try { const accounts = require('./accounts'); accounts.rememberUsageSeen(this.accountId || accounts.DEFAULT_ID); } catch {} this.emit('turn-usage', {agent: w.tag, usage: turn.usage}); }
        // A parallel reply pools into its user turn's total (the turn-end line
        // shows main + subagents); the tally above still counts it once, here.
        if (!w.main && turn.usage) this.poolUsage(w, turn.usage);
        Object.assign(w, {state: 'done', result: reply.text, text: reply.text, ...(turn.usage ? {usage: turn.usage} : {}), ended: Date.now()});
        if (w.main) { this.record(w, turn, display, {reply: reply.text, ...(turn.usage ? {usage: turn.usage} : {})}); if (!focus) { const total = mergeTotals(turn.usage ? toTotal(turn.usage) : null, this.usagePool); this.emit('turn-end', {ok: true, text: reply.text, ms: Date.now() - turn.started, sources: [...turn.sources.values()], ...(total ? {usage: total} : {})}); } } else this.emit('agent-done', w.snapshot());
        return focus ? {...reply, focusDecision, sources: [...turn.sources.values()]} : reply;
      } finally { waiting.cancel(); if (owner) this.client.closeAgentSubscription(owner); }
    } catch (e) {
      const aborted = e.name === 'AbortError';
      if (focus && focus.status === 'running') focus.stop(aborted ? 'stopped' : 'blocked', e.message);
      Object.assign(w, {state: aborted ? 'stopped' : 'failed', error: aborted ? '' : e.message, ended: Date.now()});
      // #25: keep whatever reply had already streamed before the failure/interrupt;
      // recording reply:'' made an hour of streamed work read as an empty reply on /resume.
      if (w.main && turn.sent) { const partial = stripTurnUsage([...turn.messages.values()].map(m => m.text).filter(Boolean).pop() || ''); this.record(w, turn, display, {reply: partial, error: aborted ? t('中断しました') : e.message, ...(turn.usage ? {usage: turn.usage} : {})}); }
      if (w.main) { if (!focus) this.emit('turn-end', {ok: false, error: e.message, aborted, ms: Date.now() - turn.started}); } else this.emit('agent-done', w.snapshot());
      throw e;
    } finally { signal?.removeEventListener('abort', abort); this.steps.finish(turn, w, false).catch(() => {}); if (w.turn === turn) w.turn = null; w.starting = false; }
  }
  // A mid-turn message can go as what it is — a real chat message — through the device.send
  // a turn starts with (runTurn). Posted, it reaches Muse as a user message; inside a tool
  // result it is only tool data and cannot be told apart from it. False when there is no live
  // turn to post into or the send fails — the caller then keeps the piggyback + queue route.
  async postSteer(text) {
    const w = this.main;
    // #28: once the reply has landed (turn.ending) a post no longer joins this turn;
    // it would arrive as a standalone message whose reply nobody records. Refuse
    // it so the caller keeps the queue route and it goes as a proper next turn.
    if (!w?.turn || w.turn.ending || !w.session?.id || !this.device?.send) return false;
    try { await this.device.send(text, w.session.id); return true; } catch { return false; }
  }
  // Mid-turn user messages (see the steer note in toolEnd). The terminal keeps the same texts
  // in its own queue as the fallback; these three keep the two lists in step.
  queueSteer(text) { this.steerQueue.push(text); }
  dropSteer(text) { const i = this.steerQueue.indexOf(text); if (i >= 0) this.steerQueue.splice(i, 1); }
  clearSteer() { this.steerQueue = []; }
  // A new user turn begins: parallel agents spawned from here belong to it
  // (spawn stamps them with the sequence), and their replies' usage pools
  // into this turn's turn-end total — the ✻ line shows main + subagents
  // together. An agent from an earlier turn that finishes late does not
  // enter a later turn's line; its usage still lands in the daily tally
  // through turn-usage, as every reply does.
  beginUserTurn() { this.userTurnSeq++; this.usagePool = null; }
  poolUsage(w, usage) { if (w.userTurn === this.userTurnSeq) this.usagePool = mergeTotals(this.usagePool, usage); }
  send(text, opts = {}) {
    if (this.focusRun || this.main.turn || this.main.starting) return Promise.reject(new Error(t('Muse が作業中です。')));
    this.spawnedThisTurn = 0; // #10: once per USER turn — automatic legs below must not reset it (they used to multiply the per-turn spawn cap by the leg count)
    this.beginUserTurn();
    if (this.focusEnabled) {
      // #29: ONE turn-end per user turn. Each Focus/goal leg used to emit its own,
      // so queue continuation, the daily turn tally and usage each counted one user
      // turn several times. Legs run with turnEnd suppressed; this wrapper closes
      // the whole chain once, with the final leg's result.
      const started = Date.now();
      return this.sendFocused(text, {...opts, automatic: true, turnEnd: false})
        .then(reply => this.afterFocus(reply)).then(reply => this.afterGoal(reply))
        .then(reply => { const total = mergeTotals(reply.usage, this.usagePool); this.emit('turn-end', {ok: true, text: reply.text, ms: Date.now() - started, ...(reply.sources ? {sources: reply.sources} : {}), ...(reply.focus ? {focus: reply.focus} : {}), ...(total ? {usage: total} : {})}); return total ? {...reply, usage: total} : reply; })
        .catch(e => { this.emit('turn-end', {ok: false, error: e.message, aborted: e.name === 'AbortError', ms: Date.now() - started}); throw e; });
    }
    return this.failoverBeforeTurn().then(() => this.runTurn(this.main, text, opts));
  }
  // A lapsed login is found when a turn reconnects, and by then the turn already counts as
  // work (starting / focusRun), which refuses any account switch: the failover to another
  // ready account never happened from a turn, only "log in again". So a gateway that is down
  // is reconnected before the turn claims the window, where a failover may still run. A
  // failure here is left to the turn's own reconnect, which reports it.
  async failoverBeforeTurn() {
    if (!this.accountPool || this.busy || this.closed || this.client?.status === 'connected') return;
    try { await this.ensureConnected(); } catch {}
  }
  async sendFocused(text, {display = text, attachments = [], automatic = false, continuation = false, turnEnd = true, maxRounds = require('./settings').numberValue('focusRounds'), timeoutMs = require('./settings').numberValue('focusMinutes') * 60 * 1000} = {}) {
    if (this.focusRun || this.main.turn || this.main.starting) throw new Error(t('Muse が作業中です。'));
    await this.failoverBeforeTurn();
    if (this.focusRun || this.main.turn || this.main.starting) throw new Error(t('Muse が作業中です。'));
    if (!continuation) { this.spawnedThisTurn = 0; this.beginUserTurn(); } // #10: a direct sendFocused is a user turn; an automatic leg (continuation) is the same turn continuing
    // A task that stopped for the user's own interjection — or unfinished at its round
    // limit — belongs to the message that comes next: resume that Focus (same goal,
    // same criteria, evidence intact) instead of starting an empty task named after
    // the follow-up. The stash is one-shot and dies with the session (see set session).
    let focus = null;
    // #33/#36: a resumed leg started by an automatic continuation carries NO user
    // message: it must not satisfy a manual criterion or replace the task via
    // new_task. Only a leg a real user send started may do either (fromUser).
    if (this.resumeFocus && this.resumeFocus.sessionId === this.session.id) { focus = this.resumeFocus.focus; focus.resumeLeg(display, {fromUser: !continuation}); }
    this.resumeFocus = null;
    focus ||= new Focus(display, {automatic, maxRounds});
    const run = {focus, controller: new AbortController()}, started = Date.now();
    this.focusRun = run;
    let reply, input = text, waitedMs = 0; // time spent waiting on this task's agents: not counted toward the time limit
    let totalUsage = null; // the main worker's replies this leg, summed (a leg is one sendFocused call; afterFocus/afterGoal merge leg totals)
    const sources = new Map();
    try {
      for (;;) {
        run.controller.signal.throwIfAborted(); focus.beginRound();
        const roundStarted = Date.now();
        reply = await this.runTurn(this.main, input, {display: focus.round === 1 ? display : t('Focus 続行（ラウンド {n}）', {n: focus.round}), attachments: focus.round === 1 ? attachments : [], focus, signal: run.controller.signal, turnStart: !continuation && focus.round === 1});
        totalUsage = mergeTotals(totalUsage, reply.usage);
        for (const source of reply.sources || []) sources.set(source.uri, source);
        if (focus.active) { this.lastFocus = focus.snapshot(); this.emit('focus', this.lastFocus); }
        if (!reply.focusDecision.continue) break;
        // The time limit caps automatic continuation, as /settings names it ("Focus の自動続行の
        // 時間"): no new round once it has passed. It used to be a timer that aborted whatever
        // was running — the user's own request too, even a plain answer with Focus inactive.
        // A round that ends with task agents still running was spent waiting on them,
        // not on the task's own work: its span goes to waitedMs (subtracted from the
        // elapsed total), and the limit does not bite while they run.
        const workersRunning = [...this.workers.values()].some(x => !x.main && x.focusTask === focus && (x.turn || x.starting));
        if (workersRunning) waitedMs += Date.now() - roundStarted;
        else if (Date.now() - started - waitedMs >= timeoutMs) { focus.stop('limit', 'The Focus time limit was reached.'); this.lastFocus = focus.snapshot(); this.emit('focus', this.lastFocus); break; }
        this.emit('progress', {agent: 'main', message: t('Focus: 未完了の条件を確認して続行します（{n}/{max}）。', {n: focus.round + 1, max: focus.maxRounds}), at: Date.now()});
        input = focus.prompt();
      }
      // Unfinished and waiting on the user (their interjection, an unanswerable check,
      // the round limit): keep the task itself for the next message to resume. A task
      // halted by a decline is not stashed — it needs a new direction, not a resumption.
      if (focus.active && !focus.halted && ['needs_input', 'limit', 'stalled'].includes(focus.status)) this.resumeFocus = {focus, sessionId: this.session.id};
      // The task's workers are NOT stopped when the run ends — not at a round or
      // time limit, not on stalled, not while waiting for the user. A limit only
      // means "start no new round": work already running finishes on its own
      // turn (its run signal is this run's controller, deliberately left
      // un-aborted), stays in this.workers, and a later leg — or the resumption
      // of this task — collects its results with agent.wait; pruning removes
      // only workers whose results were collected. Stopping an agent is
      // reserved for Esc (interrupt) and explicit stops (cancelAll / close).
      this.focusRun = null;
      if (turnEnd && !continuation) { const total = mergeTotals(totalUsage, this.usagePool); this.emit('turn-end', {ok: true, text: reply.text, ms: Date.now() - started, sources: [...sources.values()], ...(focus.active ? {focus: this.lastFocus} : {}), ...(total ? {usage: total} : {})}); }
      return {...reply, ...(totalUsage ? {usage: totalUsage} : {}), ...(focus.active ? {focus: this.lastFocus} : {})};
    } catch (e) {
      if (focus.status === 'running') focus.stop(e.name === 'AbortError' ? 'stopped' : 'blocked', e.message);
      // Same rule as the normal exit above: a failed run does not stop the task's
      // workers either. When the failure IS the user's Esc, interrupt() has
      // already stopped them itself; any other failure leaves them running for
      // the resumption stashed below.
      if (focus.active) this.lastFocus = focus.snapshot();
      // #17: an errored run stashes its task too (a gateway failure mid-task used to
      // leave nothing for the next message to resume). A halted (declined) task is
      // still not stashed: it needs a new direction, not a resumption.
      if (focus.active && !focus.halted) this.resumeFocus = {focus, sessionId: this.session.id};
      // #30: focusRun is cleared BEFORE turn-end is emitted, whatever Focus did:
      // handlers that answer turn-end by sending the queued message used to hit
      // "busy" against the leftover run and the queued message was dropped.
      this.focusRun = null;
      if (focus.active) this.emit('focus', this.lastFocus);
      if (turnEnd && !continuation) this.emit('turn-end', {ok: false, error: e.message, aborted: e.name === 'AbortError', ms: Date.now() - started, ...(focus.active ? {focus: this.lastFocus} : {})});
      throw e;
    } finally { if (this.focusRun === run) this.focusRun = null; }
  }
  focusStatus() {
    if (this.focusRun) return this.focusRun.focus.snapshot();
    return this.lastFocus || sessions.transcript(this.session.id).slice().reverse().find(turn => turn.focus)?.focus || null;
  }
  // ---- the standing goal (/goal): this conversation's "do not stop until it is done" ----
  // It rides the session record (sessions.save), so it survives /resume; a new chat
  // starts without one. While it stands, a focused task that stops at its round limit
  // — or finishes while the goal still stands — starts the next leg by itself instead
  // of parking for the user's next message. (afterFocus above does the same for a
  // task's own limits, goal or not; the goal adds legs for a task that finished
  // while the goal stands, and for the goal outliving any one task.) Stops that wait
  // for the user (a question, a decline, an interruption) still stop.
  standingGoal() { const g = this.session?.goal; return g && typeof g.text === 'string' && g.text ? g : null; }
  setGoal(text) {
    if (!this.session) return null;
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    this.session.goal = cleanText ? {text: cleanText, legs: 0, setAt: Date.now()} : null;
    try { sessions.save(this.session); } catch {}
    this.emit('goal', {goal: this.standingGoal()});
    return this.standingGoal();
  }
  // ---- a user turn ends only when its task is complete ----
  // A focused task that stops at its leg's own limits (the round or time cap, or a
  // round with no verified progress) is not finished, so the turn does not end
  // there: the next leg starts by itself, the way a standing goal's legs already
  // did — now as the default for every focused task, no /goal needed. Stops that
  // wait for the user (needs_input: their interjection, a question, a decline, an
  // unanswerable check) and completed tasks end the turn as before. FOCUS_MAX_LEGS
  // is the runaway guard; past it the task parks, stashed for the next message.
  async afterFocus(reply, legs = 0) {
    const f = reply?.focus;
    if (!f || this.closed || (f.status !== 'limit' && f.status !== 'stalled')) return reply;
    if (legs >= FOCUS_MAX_LEGS) {
      this.emit('progress', {agent: 'main', message: t('Focus: 自動続行が上限（{max} leg）に達したので止まります。続きはメッセージを送ると再開します。', {max: FOCUS_MAX_LEGS}), at: Date.now()});
      return reply;
    }
    this.emit('progress', {agent: 'main', message: t('Focus: 未完了のため自動で続行します（leg {n}）。', {n: legs + 1}), at: Date.now()});
    const body = '[muser: automatic continuation]\nThe previous leg of this task stopped before the task was complete (' + f.status + (f.reason ? ': ' + f.reason : '') + '). The same Focus task, goal and criteria carry over — do not call focus.plan again and do not change the criteria. Keep working until every criterion is met and reported with focus.checkpoint. If a criterion truly cannot be verified, report it unknown or blocked with its reason; if you need the user\'s decision, call focus.ask_user.';
    const next = await this.sendFocused(body, {display: f.goal, automatic: true, continuation: true});
    // The leg's total joins the user turn's total: without this merge the final
    // turn-end would show only the last leg's replies.
    const merged = mergeTotals(reply.usage, next.usage);
    return this.afterFocus({...next, ...(merged ? {usage: merged} : {})}, legs + 1);
  }
  async afterGoal(reply) {
    const g = this.standingGoal();
    if (!g || this.closed || !reply?.focus) return reply;
    const f = reply.focus;
    if (f.status === 'complete' && f.goal === g.text) {
      this.session.goal = null;
      try { sessions.save(this.session); } catch {}
      this.emit('goal', {goal: null, achieved: g.text});
      return reply;
    }
    if (f.status !== 'limit' && f.status !== 'complete') return reply;
    if ((g.legs || 0) >= GOAL_MAX_LEGS) { this.emit('goal', {goal: g, capped: true}); return reply; }
    this.session.goal = {...g, legs: (g.legs || 0) + 1};
    try { sessions.save(this.session); } catch {}
    this.emit('goal', {goal: this.standingGoal(), leg: this.session.goal.legs});
    this.emit('progress', {agent: 'main', message: t('Goal: 常設ゴールに向けて自動で続行します（leg {n}）。', {n: this.session.goal.legs}), at: Date.now()});
    const body = '[muser: automatic /goal continuation]\nStanding goal: ' + g.text + '\nThe previous task ended before this goal was met. Plan this leg with focus.plan — criteria that together mean the goal is achieved — and keep working until every criterion is met. If the goal is already achieved, say so briefly and finish with every criterion met.';
    const next = await this.sendFocused(body, {display: g.text, automatic: true, continuation: true});
    // Same merge as afterFocus: the goal leg's replies join the user turn's total.
    const merged = mergeTotals(reply.usage, next.usage);
    return this.afterGoal({...next, ...(merged ? {usage: merged} : {})});
  }
  // After `muser login` ran inside the TUI: the new cookies go into the jar the gateway client
  // and the device auth were created with (same array, refilled in place).
  reloadLogin() {
    if (!this.web?.jar) return;
    const fresh = require('./web').loadJar(this.accountFiles?.web);
    this.web.jar.splice(0, this.web.jar.length, ...fresh);
  }
  // One line of the main chat's transcript (src/sessions.js), so /resume can show the conversation.
  record(w, turn, display, {reply = '', error, usage} = {}) {
    // Capped per turn, so one huge reply or a tool storm does not bloat what /resume reads back.
    const cap = (s, n) => s.length > n ? s.slice(0, n) + '\n… (' + (s.length - n) + ' more characters not kept)' : s;
    const u = usage || turn.usage;
    // The transcript keeps only the token counts and source: the formatted string
    // is derived from them wherever it is shown, and cost is a live-event detail.
    const storedUsage = u ? {inputTokens: u.inputTokens, outputTokens: u.outputTokens, ...(u.source ? {source: u.source} : {})} : null;
    sessions.appendTurn(w.session.id, {v: 1, at: Date.now(), user: cap(String(display ?? ''), 50000), reply: cap(stripTurnUsage(String(reply || '')), 50000), ...(error ? {error: cap(String(error), 2000)} : {}), ...(storedUsage ? {usage: storedUsage} : {}), 
      tools: turn.log.tools.slice(-300), steps: turn.log.steps, progress: turn.log.progress || [], ...(turn.focus?.active ? {focus: turn.focus.modelState()} : {}), sources: [...turn.sources.values()].map(s => ({label: s.label, uri: s.uri})), todos: Array.isArray(w.ctx.todos) ? w.ctx.todos : []});
  }

  // A parallel agent: its own side chat, started now, reported through agent-update / agent-done.
  types() { return agentTypes.load(this.cwd); }
  spawn(task, {title, by = 'user', type = 'general'} = {}) {
    pruneCollectedWorkers(this.workers);
    if (!task.trim()) throw new Error(t('タスクが空です'));
    const types = this.types(), typeName = String(type || 'general').toLowerCase();
    if (!types[typeName]) throw new Error(t('知らないエージェントの型: {type}（{types}）', {type: typeName, types: Object.keys(types).join(' / ')}));
    const running = [...this.workers.values()].filter(w => !w.main && (w.turn || w.starting)).length;
    const {concurrent, perTurn} = this.agentLimits;
    if (concurrent && running >= concurrent) throw new Error(t('並列エージェントは同時に {n} つまでです（今変更: /settings ／ 起動時: --max-agents / MUSER_MAX_AGENTS / maxAgents）', {n: concurrent}));
    if (perTurn && this.spawnedThisTurn >= perTurn) throw new Error(t('この作業で起動できる並列エージェントは {n} つまでです。今いるエージェントで続けてください（今変更: /settings ／ 起動時: --max-agents-total / MUSER_MAX_AGENTS_TOTAL / maxAgentsTotal）', {n: perTurn}));
    this.spawnedThisTurn++;
    const tag = 'a' + this.nextTag++;
    const session = {...sessions.create(this.cwd), parent: this.session.id};
    // The worker gets its OWN readFiles set, seeded with a copy of main's: sharing the
    // set let one agent's reads silently mark files as read (and fresh) for everyone.
    const ctx = {cwd: this.cwd, readFiles: new Set(), todos: [], shells: this.shells};
    require('./tools').copyReads(this.ctx, ctx); // the files and what they looked like when read
    const w = new Worker({tag, session, ctx, title: (title || task).replace(/\s+/g, ' ').slice(0, 60), by, typeName, type: types[typeName]});
    w.spawnedIn = by === 'muse' ? this.main.turn : null; // stopped with that task on esc (interrupt)
    w.userTurn = this.userTurnSeq; // the user turn it belongs to: its usage pools into that turn's total
    w.focusTask = by === 'muse' ? this.main.turn?.focus : null;
    this.workers.set(tag, w);
    this.runTurn(w, task, {signal: w.focusTask ? this.focusRun?.controller.signal : undefined}).catch(() => {});
    return w;
  }
  async stopAgent(tag) {
    const w = this.workers.get(tag); if (!w) return;
    // #2: a worker still connecting has no turn to abort yet; flag it and runTurn
    // refuses to start the turn when its connection lands (it used to start work
    // after the user had already stopped it / after Esc).
    if (!w.turn) { if (w.starting) w.stopRequested = true; return; }
    w.turn.controller.abort(); await this.client.cancel(w.session.id).catch(() => {});
  }

  async interrupt() {
    this.focusRun?.controller.abort();
    const t = this.main.turn;
    // #3: no main turn is not "nothing to stop": agents Muse spawned for a task
    // (spawnedIn set) can still be running, and they used to be left working.
    if (t) t.controller.abort();
    // The agents Muse started for this task stop with it: after esc they went on editing files
    // and running commands under a screen that said "interrupted". /agent ones are the user's own.
    for (const w of this.workers.values()) if ((w.turn || w.starting) && (w.spawnedIn != null || (t && w.spawnedIn === t) || (this.focusRun && w.focusTask === this.focusRun.focus))) this.stopAgent(w.tag);
    if (t) await this.client.cancel(this.session.id).catch(() => {});
  }

  // On exit: every turn of this window is cancelled on Muse's side, so Muse does not keep working
  // (and spending the allowance) for a muser that is gone. Waits at most waitMs for the requests.
  async cancelAll(waitMs = 2000) {
    const jobs = [];
    if (this.main.turn || this.focusRun) jobs.push(this.interrupt());
    for (const w of this.workers.values()) if (!w.main && (w.turn || w.starting)) jobs.push(this.stopAgent(w.tag)); // #2: starting workers too
    if (jobs.length) await Promise.race([Promise.allSettled(jobs), new Promise(r => setTimeout(r, waitMs))]);
    return jobs.length;
  }
  close() { this.focusRun?.controller.abort(); this.closed = true; clearTimeout(this.retryTimer); clearTimeout(this.resubTimer); this.relay?.stop(); this.nodeSlot?.release(); this.shells.killAll(); this.device?.disconnect(); this.client.disconnect(false); try { this.accountPool?.drop?.(); } catch {} this.mcp?.close(); }
}

// Automatic /goal legs per standing goal before the run parks for the user: a guard
// against an unattended run burning the allowance forever, not a work quota — ten legs
// of up to focusMinutes each is hours of work, and any message resumes from there.
const GOAL_MAX_LEGS = 10;
// Automatic continuation legs per user message for ANY focused task (afterFocus):
// the same guard, the same size. A turn is meant to end only when its task is
// complete, so hitting a leg's own limits starts the next leg instead of parking —
// up to this many legs, after which the task parks and a message resumes it.
const FOCUS_MAX_LEGS = 10;
function safe(fn) { try { return fn(); } catch { return undefined; } }
// A tool result as text: command output, search hits, file text, else the payload as JSON.
function outputText(result) {
  const cap = s => s.length > 200000 ? s.slice(0, 200000) + '\n… (cut at 200,000 characters)' : s;
  if (!result.ok) return cap(String(result.error || ''));
  const p = result.payload || {};
  if (typeof p.stdout === 'string' || typeof p.stderr === 'string') return cap([p.stdout || '', p.stderr ? '[stderr]\n' + p.stderr : ''].filter(Boolean).join('\n'));
  for (const k of ['output', 'content', 'result']) if (typeof p[k] === 'string') return cap(p[k]);
  try { return cap(JSON.stringify(p, null, 1)); } catch { return ''; }
}

Agent.DEVICE = DEVICE_NAME;
module.exports = {Agent, DEVICE_NAME, preamble, projectInstructions, routeFor, consumeToolCall, toolLimitMessage, resolveMaxToolCallsPerTurn, resolveAgentLimits, mcpEffectiveKind, pruneCollectedWorkers, MAX_PROJECT_INSTRUCTION_CHARS, localToday, GOAL_MAX_LEGS, FOCUS_MAX_LEGS};
