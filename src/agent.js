'use strict';
// A muser coding session: one Muse side chat ("main"), plus parallel agents that each run in
// their own side chat (a1, a2, ...), all driven from this PC's CLI device. Messages go out on
// the device channel (so Muse knows which device to use), replies are followed on the chat
// subscription, and Muse's tool calls arrive as device invokes. Invokes do not say which chat
// they come from, so every command takes an `agent` tag and each parallel agent is told its own.
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
const {TOOLS, commandsV2, inside} = require('./tools');
const {decide} = require('./policy');
const sessions = require('./sessions');
const agentTypes = require('./agent-types');
const {Shells} = require('./shells');
const {t} = require('./i18n');

const DEVICE_NAME = os.hostname() + ' CLI (muser)';
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'MUSE.md', '.muser/instructions.md'];
const MAX_AGENTS = 4;
// Parallel-agent limits are the user's to set: a flag, else MUSER_MAX_AGENTS(_TOTAL), else
// ~/.muser/config.json {"maxAgents", "maxAgentsTotal"}. concurrent = running at once (default 4),
// perTurn = started during one main turn (default 0). 0 means no limit.
function resolveAgentLimits({maxAgents, maxAgentsTotal} = {}, env = process.env, configFile = path.join(os.homedir(), '.muser', 'config.json')) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) || {}; } catch {}
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

function projectInstructions(cwd) {
  const found = [];
  for (let dir = cwd, depth = 0; depth < 6; depth++) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) found.push({file, text: fs.readFileSync(file, 'utf8').slice(0, 12000)}); } catch {}
    }
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  // Cap the TOTAL across all files: a stack of ancestor instruction files must not
  // eat the whole context. The last file that still fits is truncated and marked.
  const capped = [];
  let remaining = MAX_PROJECT_INSTRUCTION_CHARS;
  for (const entry of found.reverse()) {
    if (remaining <= 0) break;
    if (entry.text.length <= remaining) { capped.push(entry); remaining -= entry.text.length; }
    else { const keep = Math.max(0, remaining - PROJECT_INSTRUCTION_TRUNCATION_NOTE.length - 1); capped.push({file: entry.file, text: entry.text.slice(0, keep) + '\n' + PROJECT_INSTRUCTION_TRUNCATION_NOTE}); remaining = 0; }
  }
  return capped;
}

function preamble(cwd, mcpNames, {tag, by, type, typeName, limits} = {}) {
  const lines = [
    '[muser: a terminal coding session from the device "' + DEVICE_NAME + '". This block is from the CLI, not typed by the user.]',
    'Work on the user\'s PC only through that device\'s commands: code.read, code.grep, code.glob, code.edit, code.apply_patch, code.write, system.run (PowerShell by default; background=true for servers and watchers, then shell.output / shell.kill / shell.list), todo.write.',
    'Working directory: ' + cwd + ' (relative paths resolve there). OS: Windows. Today: ' + new Date().toISOString().slice(0, 10) + '.',
    'Read a file before editing it. Prefer code.edit / code.apply_patch over rewriting files. Use todo.write for multi-step work.',
    'Before saying a change is done, verify it at the layer the user will see: run the tests, and for UI changes run the project\'s UI / e2e tests when it has them (see its docs), adding one when practical. Say what you verified and what you did not.',
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
  for (const {file, text} of projectInstructions(cwd)) lines.push('', 'Project instructions from ' + file + ':', text.trim());
  return lines.join('\n');
}

const AGENT_PARAM = {agent: {type: 'string', description: 'Your agent tag if you are a parallel agent (e.g. a1). Omit in the main session.'}};
const AGENT_TOOLS = {
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
  const main = list.find(w => w.tag === 'main');
  const tag = typeof params?.agent === 'string' ? params.agent.trim() : '';
  if (tag) { const w = list.find(x => x.tag === tag); return w?.turn ? w : null; }
  const active = list.filter(w => w.turn);
  if (active.length === 1) return active[0];
  return main?.turn ? main : active[0] || null;
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
function resolveMaxToolCallsPerTurn(option, envValue = process.env.MUSER_MAX_TOOL_CALLS_PER_TURN) {
  for (const v of [option, envValue]) {
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
    this.turn = null; this.state = 'idle'; this.lastTool = ''; this.text = ''; this.result = ''; this.error = ''; this.started = 0; this.ended = 0; this.collected = false;
  }
  get main() { return this.tag === 'main'; }
  snapshot() { return {tag: this.tag, title: this.title, by: this.by, type: this.typeName, state: this.state, lastTool: this.lastTool, text: this.text, result: this.result, error: this.error, started: this.started, ended: this.ended}; }
}

class Agent extends EventEmitter {
  constructor({client, auth, cwd, mode = 'default', session, mcp, maxToolCallsPerTurn, agentLimits, allowAlways, web}) {
    super();
    this.client = client; this.auth = auth; this.cwd = cwd; this.mode = mode; this.mcp = mcp;
    this.maxToolCallsPerTurn = resolveMaxToolCallsPerTurn(maxToolCallsPerTurn);
    this.agentLimits = resolveAgentLimits(agentLimits); this.spawnedThisTurn = 0;
    this.shells = new Shells();
    this.shells.on('change', s => this.emit('shell', s));
    this.ctx = {cwd, readFiles: new Set(), todos: [], shells: this.shells};
    this.workers = new Map([['main', new Worker({tag: 'main', session: session || sessions.create(cwd), ctx: this.ctx})]]);
    this.device = null; this.nextTag = 1;
    this.web = web; // its cookie jar is what the gateway logs in with (see reloadLogin)
    this.allowAlways = new Set(allowAlways || []); // "don't ask again" keys, remembered per folder (src/permissions.js)
    this.approver = async () => ({allow: false, reason: 'no approver'});
    client.on('event', e => this.onChatEvent(e));
    this.retries = 0; this.retryTimer = null; this.reconnecting = null; this.closed = false;
    this.invokes = {inflight: new Map(), completed: new Map()};
    this.steps = new MuseSteps(client, e => this.onMuseStep(e));
    client.on('status', ({status}) => { if (!['connected', 'connecting', 'auth_required'].includes(status)) this.scheduleReconnect(); });
  }
  get main() { return this.workers.get('main'); }
  get session() { return this.main.session; }
  set session(s) { this.main.session = s; }
  get turn() { return this.main.turn; }
  get busy() { return [...this.workers.values()].some(w => w.turn); }
  agents() { return [...this.workers.values()].filter(w => !w.main).map(w => w.snapshot()); }

  commands() {
    const all = {...commandsV2(), ...AGENT_TOOLS, ...(this.mcp ? this.mcp.defs() : {})};
    return Object.fromEntries(Object.entries(all).map(([k, d]) => [k, {...d, optional: {...(d.optional || {}), ...AGENT_PARAM}}]));
  }
  async connectDevice() {
    const vm = await this.auth.vm();
    const old = this.device;
    const device = this.device = new NativeDevice({commands: this.commands(), displayName: DEVICE_NAME, invokes: this.invokes, execute: (c, p, t, id) => this.execute(c, p, t, id)});
    old?.disconnect();
    device.on('status', s => { this.emit('device', s); if (!s.connected && s.message !== 'connecting' && device === this.device) this.scheduleReconnect(); });
    await device.connect({vm, nodeId: this.auth.saved.nodeId});
  }
  // Sleep, a network change or a gateway restart closes the sockets, and nothing reopened them:
  // every later turn failed with "not connected" until muser was restarted. Reopen whatever is
  // down before each turn, and in the background (backing off) as soon as a socket drops.
  ensureConnected() {
    return this.reconnecting ??= (async () => {
      const down = this.client.status !== 'connected' || this.client.ws?.readyState !== 1 || !this.device?.connected;
      const first = !this.everConnected;
      if (down) this.emit('connection', {state: first ? 'connecting' : 'reconnecting'});
      if (this.client.status === 'connected' && this.client.ws?.readyState !== 1) this.client.disconnect(false);
      if (this.client.status !== 'connected') {
        await this.client.connect(); await this.client.subscribe();
        // Turns that were running follow their chats again (the old subscriptions died with the socket).
        for (const w of this.workers.values()) if (w.turn?.owner) { this.client.subscribeAgent(w.session.id, w.turn.owner).catch(() => {}); w.turn.waiting?.refresh(); }
      }
      if (!this.device?.connected) await this.connectDevice();
      this.retries = 0; this.everConnected = true;
      if (down) this.emit('connection', {state: 'connected', first});
    })().catch(e => { this.emit('connection', {state: this.client.status === 'auth_required' ? 'auth' : 'failed', error: e.message}); throw e; })
      .finally(() => { this.reconnecting = null; });
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
  // Commands are fixed at link.register, so a change in MCP servers re-registers the device.
  async reconnectDevice() { if (this.busy) throw new Error(t('作業中は切り替えられません')); await this.connectDevice(); }

  // Which chat a device invoke belongs to: its agent tag, else the only one working, else main.
  // Outside any running turn nothing is done: the call may come from another chat, and the user is not watching.
  route(params) { return routeFor(this.workers, params); }

  async execute(command, rawParams, timeoutMs, id) {
    const {agent: _tag, ...params} = rawParams || {};
    const w = this.route(rawParams);
    if (!w) return {ok: false, error: 'muser is idle: only a turn sent from this terminal may use this device.'};
    if (command === 'agent.spawn' || command === 'agent.wait') return this.executeAgentTool(w, command, params);
    if (w.type && !agentTypes.allows(w.type, command)) {
      const error = command + ' is not available to the ' + w.typeName + ' agent type (allowed: ' + w.type.tools.join(', ') + ').';
      this.emit('agent-tool', {id, agent: w.tag, command, params, summary: '', ok: false, error}); return {ok: false, error};
    }
    if (command.startsWith('mcp.') && this.mcp?.commands.has(command)) return this.executeMcp(w, command, params, id);
    const tool = TOOLS[command];
    if (!tool) return {ok: false, error: 'Unknown command ' + command};
    const call = {id, agent: w.tag, command, params, kind: tool.kind, summary: safe(() => tool.summary(params)) || ''};
    // Attach the approval preview (diff for edit/write/patch) BEFORE decide/ask, so the
    // approver and the UI can show what will change. A broken preview never blocks the call.
    if (typeof tool.preview === 'function') { const preview = safe(() => tool.preview(params, w.ctx)); if (preview !== undefined) call.preview = preview; }
    this.toolStart(w, call);
    if (consumeToolCall(w.turn, this.maxToolCallsPerTurn)) return this.toolEnd(w, call, {ok: false, error: toolLimitMessage(this.maxToolCallsPerTurn)});
    try {
      const targets = [].concat(tool.target ? safe(() => tool.target(params, w.ctx)) || [] : []);
      const verdict = decide({mode: this.modeFor(w), kind: tool.kind, command, params, outside: targets.some(t => !inside(this.cwd, t)), always: this.allowAlways});
      if (verdict === 'deny') return this.toolEnd(w, call, {ok: false, error: (w.type?.readOnly ? 'This ' + w.typeName + ' agent is read-only' : 'Not allowed in ' + this.mode + ' mode (read-only)') + '. Explain what you would change instead.'});
      if (verdict === 'ask') { const no = await this.ask(w, call); if (no) return no; }
      const r = await tool.run(params, w.ctx, w.turn?.controller.signal, chunk => this.emit('tool-output', {id, agent: w.tag, chunk}));
      if (command === 'todo.write') { if (w.main) this.emit('todos', w.ctx.todos); else this.update(w); }
      return this.toolEnd(w, {...call, view: r.view}, {ok: true, payload: r.payload});
    } catch (e) { return this.toolEnd(w, call, {ok: false, error: e.message}); }
  }

  async executeMcp(w, command, params, id) {
    const m = this.mcp.commands.get(command);
    const call = {id, agent: w.tag, command, params, kind: 'mcp', mcp: {server: m.server, tool: m.tool, readOnly: m.readOnly}, summary: m.server + ' · ' + m.tool};
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
    const list = (tags.length ? tags.map(t => this.workers.get(t)).filter(Boolean) : [...this.workers.values()].filter(x => !x.main));
    const until = Date.now() + Math.min(120, Math.max(1, params.timeout_s | 0 || 60)) * 1000;
    while (list.some(x => x.turn) && Date.now() < until && w.turn && !w.turn.controller.signal.aborted) await new Promise(r => setTimeout(r, 1000));
    const agents = list.map(x => ({tag: x.tag, title: x.title, state: x.state, ...(x.state === 'done' ? {result: x.result.slice(0, 8000)} : {}), ...(x.error ? {error: x.error} : {}), ...(x.state === 'working' ? {last_tool: x.lastTool} : {})}));
    for (const x of list) if (x.state === 'done') x.collected = true; // pruned on the next spawn / wait
    return this.toolEnd(w, {...call, view: {agents: agents.map(a => a.tag + ' ' + a.state)}}, {ok: true, payload: {agents}});
  }

  // Read-only agent types run under plan rules whatever the session mode is.
  modeFor(w) { return w.type?.readOnly ? 'plan' : this.mode; }
  // Asks the user; returns the refusal to send back, or null when allowed.
  async ask(w, call) {
    const answer = await this.approver(call);
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
    const done = {...call, ok: result.ok, ...(result.ok ? {} : {error: result.error})};
    if (w.turn) { const c = (w.turn.calls ||= []).find(x => x.id === call.id && x.end === null); if (c) c.end = Date.now(); else w.turn.calls.push({id: call.id, start: Date.now(), end: Date.now()}); }
    if (w.turn?.log && w.turn.log.tools.length < 300) w.turn.log.tools.push({command: call.command, summary: String(call.summary || '').slice(0, 200), ok: !!result.ok, ...(result.ok ? {} : {error: String(result.error || '').slice(0, 300)})});
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
    if (name.startsWith('delta.') && typeof p.message_id === 'string') {
      if (t.baseline.has(p.message_id)) return;
      const m = t.messages.get(p.message_id) || {text: '', seq: 0};
      if (p.seq && Number(p.seq) <= m.seq) return;
      m.seq = Number(p.seq) || m.seq;
      let changed = false;
      if (name === 'delta.text_append' && typeof p.text === 'string') { m.text += p.text; changed = true; }
      else if (name === 'delta.presentation' && typeof p.display_text === 'string') { m.text = p.display_text; changed = true; }
      else if (name === 'delta.message_done') {
        for (const c of citations(p.resources)) t.sources.set(c.uri, c);
        const tr = p.transcript, final = tr?.display_text ?? tr?.content ?? tr?.text;
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
    for (const s of step ? (step.items || [step]) : []) if (w.turn?.log && w.turn.log.steps.length < 100) w.turn.log.steps.push({title: s.title, ...(s.detail ? {detail: s.detail} : {}), ...(s.failed ? {failed: true} : {})});
    if (w.main) { if (step) this.emit('muse-step', step); if (running !== undefined) this.emit('muse-running', running); }
    else if (step || running) { w.lastTool = (step ? step.title : running) + ' (Muse)'; this.update(w); }
  }

  // One turn of one worker's chat.
  async runTurn(w, text, {attachments = [], display} = {}) {
    display ??= text;
    if (w.turn) throw new Error(t('Muse が作業中です。'));
    try { await this.ensureConnected(); }
    catch (e) {
      if (this.client.status === 'auth_required') throw new Error(t('muse.ai のログインが切れています。/login でログインし直してください。'));
      throw new Error(t('この PC の CLI 端末が Muse に接続していません（再接続に失敗: {error}）。', {error: e.message}));
    }
    if (w.turn) throw new Error(t('Muse が作業中です。')); // another send got in while reconnecting
    if (w.main) this.spawnedThisTurn = 0; // the per-task agent count starts over with each task
    const first = !w.session.turns;
    const mcpNames = this.mcp ? [...this.mcp.servers.values()].filter(s => s.status === 'connected').map(s => s.name) : [];
    const body = first ? preamble(this.cwd, mcpNames, w.main ? {limits: this.agentLimits} : {tag: w.tag, by: w.by, type: w.type, typeName: w.typeName}) + '\n\n' + (w.main ? 'User:\n' : 'Task:\n') + text : text;
    const turn = w.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, log: {tools: [], steps: []}};
    Object.assign(w, {state: 'working', started: turn.started, error: ''}); if (!w.main) this.update(w);
    // Once `waiting` exists, EVERY exit path below (send failure, subscribe failure,
    // reply, abort) must cancel it and close the agent subscription, or both leak.
    let waiting = null, owner = null;
    try {
      if (!first) {
        // No baseline = an old message could be mistaken for this turn's reply, so a
        // failed history fetch on a non-first turn aborts the turn instead of guessing.
        let history;
        try { history = await this.client.history(w.session.id); }
        catch (e) { throw new Error(t('履歴の取得に失敗したためターンを開始できませんでした。少し待ってからもう一度送信してください。（{error}）', {error: e.message})); }
        for (const ev of history?.chat_events || []) { const m = messageFromEvent(ev); if (m) turn.baseline.add(m.id); }
      }
      waiting = waitForReply({client: this.client, sessionId: w.session.id, baseline: turn.baseline, signal: turn.controller.signal, timeoutMs: 3 * 3600 * 1000});
      owner = turn.owner = 'muser-' + crypto.randomUUID(); turn.waiting = waiting;
      try {
        const ack = await this.device.send(body, w.session.id, attachments.length ? {attachments: require('./clipboard').toItems(attachments)} : {});
        waiting.accept(ack?.message_id);
        await this.client.subscribeAgent(w.session.id, owner); waiting.refresh();
        sessions.touch(w.session, display); turn.sent = true;
        if (w.main) this.emit('turn-start');
        const reply = await waiting.promise;
        await this.steps.finish(turn, w);
        Object.assign(w, {state: 'done', result: reply.text, text: reply.text, ended: Date.now()});
        if (w.main) { this.record(w, turn, display, {reply: reply.text}); this.emit('turn-end', {ok: true, text: reply.text, ms: Date.now() - turn.started, sources: [...turn.sources.values()]}); } else this.emit('agent-done', w.snapshot());
        return reply;
      } finally { waiting.cancel(); if (owner) this.client.closeAgentSubscription(owner); }
    } catch (e) {
      const aborted = e.name === 'AbortError';
      Object.assign(w, {state: aborted ? 'stopped' : 'failed', error: aborted ? '' : e.message, ended: Date.now()});
      if (w.main && turn.sent) this.record(w, turn, display, {error: aborted ? t('中断しました') : e.message});
      if (w.main) this.emit('turn-end', {ok: false, error: e.message, aborted, ms: Date.now() - turn.started}); else this.emit('agent-done', w.snapshot());
      throw e;
    } finally { this.steps.finish(turn, w, false).catch(() => {}); if (w.turn === turn) w.turn = null; }
  }
  send(text, opts) { return this.runTurn(this.main, text, opts); }
  // After `muser login` ran inside the TUI: the new cookies go into the jar the gateway client
  // and the device auth were created with (same array, refilled in place).
  reloadLogin() {
    if (!this.web?.jar) return;
    const fresh = require('./web').loadJar();
    this.web.jar.splice(0, this.web.jar.length, ...fresh);
  }
  // One line of the main chat's transcript (src/sessions.js), so /resume can show the conversation.
  record(w, turn, display, {reply = '', error} = {}) {
    sessions.appendTurn(w.session.id, {v: 1, at: Date.now(), user: String(display ?? ''), reply: String(reply || ''), ...(error ? {error: String(error)} : {}),
      tools: turn.log.tools, steps: turn.log.steps, sources: [...turn.sources.values()].map(s => ({label: s.label, uri: s.uri})), todos: Array.isArray(w.ctx.todos) ? w.ctx.todos : []});
  }

  // A parallel agent: its own side chat, started now, reported through agent-update / agent-done.
  types() { return agentTypes.load(this.cwd); }
  spawn(task, {title, by = 'user', type = 'general'} = {}) {
    pruneCollectedWorkers(this.workers);
    if (!task.trim()) throw new Error(t('タスクが空です'));
    const types = this.types(), typeName = String(type || 'general').toLowerCase();
    if (!types[typeName]) throw new Error(t('知らないエージェントの型: {type}（{types}）', {type: typeName, types: Object.keys(types).join(' / ')}));
    const running = [...this.workers.values()].filter(w => !w.main && w.turn).length;
    const {concurrent, perTurn} = this.agentLimits;
    if (concurrent && running >= concurrent) throw new Error(t('並列エージェントは同時に {n} つまでです（変更: --max-agents / MUSER_MAX_AGENTS / ~/.muser/config.json の maxAgents）', {n: concurrent}));
    if (perTurn && this.spawnedThisTurn >= perTurn) throw new Error(t('この作業で起動できる並列エージェントは {n} つまでです。今いるエージェントで続けてください（変更: --max-agents-total / MUSER_MAX_AGENTS_TOTAL / maxAgentsTotal）', {n: perTurn}));
    this.spawnedThisTurn++;
    const tag = 'a' + this.nextTag++;
    const session = {...sessions.create(this.cwd), parent: this.session.id};
    // The worker gets its OWN readFiles set, seeded with a copy of main's: sharing the
    // set let one agent's reads silently mark files as read (and fresh) for everyone.
    const w = new Worker({tag, session, ctx: {cwd: this.cwd, readFiles: new Set(this.ctx.readFiles), todos: [], shells: this.shells}, title: (title || task).replace(/\s+/g, ' ').slice(0, 60), by, typeName, type: types[typeName]});
    this.workers.set(tag, w);
    this.runTurn(w, task).catch(() => {});
    return w;
  }
  async stopAgent(tag) {
    const w = this.workers.get(tag); if (!w?.turn) return;
    w.turn.controller.abort(); await this.client.cancel(w.session.id).catch(() => {});
  }

  async interrupt() {
    const t = this.main.turn; if (!t) return;
    t.controller.abort();
    await this.client.cancel(this.session.id).catch(() => {});
  }

  close() { this.closed = true; clearTimeout(this.retryTimer); this.shells.killAll(); this.device?.disconnect(); this.client.disconnect(false); this.mcp?.close(); }
}

function safe(fn) { try { return fn(); } catch { return undefined; } }

Agent.DEVICE = DEVICE_NAME;
module.exports = {Agent, DEVICE_NAME, preamble, projectInstructions, routeFor, consumeToolCall, toolLimitMessage, resolveMaxToolCallsPerTurn, resolveAgentLimits, mcpEffectiveKind, pruneCollectedWorkers, MAX_PROJECT_INSTRUCTION_CHARS};
