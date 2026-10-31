'use strict';
// MCP client side of muser. Muse runs the agent loop, so MCP tools reach it as device commands:
// each enabled server's tools are registered as `mcp.<server>.<tool>` and calls are relayed to
// the server. Config: ~/.muser/mcp.json ({mcpServers: {name: {command,args,env,cwd} | {url,headers},
// enabled}}), importable from Claude Code (~/.claude.json) and Codex (~/.codex/config.toml).
// Secret values (env / headers) are NOT stored in mcp.json: save() moves them into the
// DPAPI-backed secure-store and leaves {"$secret": "<server>:<kind>:<key>"} references
// behind, which load() resolves back. Plaintext configs from before (or written by other
// tools) still load as-is and migrate on the first save(). Note: mcp.json should stay
// user-only — it can briefly hold plaintext between an external edit and the next save —
// so save() also chmods it 0600 where the OS honours that.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./secure-store');

const DIR = path.join(os.homedir(), '.muser');
const FILE = path.join(DIR, 'mcp.json');
const SECRETS_FILE = 'mcp-secrets.enc';
const CONNECT_TIMEOUT = 15000, CALL_TIMEOUT = 120000, MAX_RESULT = 60000, MAX_LIST_PAGES = 20;

// Values that must never appear verbatim in an error message or a log line.
const knownSecrets = new Set();
function noteSecret(v) { if (typeof v === 'string' && v.length >= 4) knownSecrets.add(v); }
function redact(text) {
  let out = String(text ?? '');
  for (const v of knownSecrets) out = out.split(v).join('***');
  return out;
}
function isSecretRef(v) { return !!v && typeof v === 'object' && typeof v.$secret === 'string'; }

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return {mcpServers: {}}; }
  let cfg = null;
  try { cfg = JSON.parse(raw); } catch {}
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    // Corrupt config: keep the bytes for recovery instead of silently starting empty.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(FILE, FILE + '.corrupt-' + stamp); } catch {}
    return {mcpServers: {}};
  }
  return resolveSecrets(cfg);
}
// Replace {"$secret": key} references in env/headers with values from the secure-store.
// Plaintext values pass through untouched (backward compat) and are noted for redaction.
function resolveSecrets(cfg) {
  let hasRefs = false;
  for (const s of Object.values(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      for (const v of Object.values(s?.[kind] || {})) {
        if (isSecretRef(v)) hasRefs = true; else noteSecret(v);
      }
    }
  }
  if (!hasRefs) return cfg;
  const vault = store.load(SECRETS_FILE) || {};
  for (const s of Object.values(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      if (!s?.[kind]) continue;
      for (const [k, v] of Object.entries(s[kind])) {
        if (isSecretRef(v)) { const val = vault[v.$secret]; s[kind][k] = typeof val === 'string' ? val : ''; noteSecret(val); }
      }
    }
  }
  return cfg;
}
function save(cfg) {
  // Work on a copy: the caller's object keeps its resolved plaintext values.
  const out = JSON.parse(JSON.stringify(cfg ?? {mcpServers: {}}));
  const vault = {};
  let vaultLoaded = false, dirty = false;
  for (const [name, s] of Object.entries(out.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      if (!s?.[kind]) continue;
      for (const [k, v] of Object.entries(s[kind])) {
        if (isSecretRef(v) || typeof v !== 'string' || !v) continue;
        if (!vaultLoaded) { Object.assign(vault, store.load(SECRETS_FILE) || {}); vaultLoaded = true; }
        const key = name + ':' + kind + ':' + k;
        vault[key] = v; noteSecret(v); s[kind][k] = {$secret: key}; dirty = true;
      }
    }
  }
  // Secrets first: if the vault write fails, mcp.json is left untouched rather than
  // pointing at references that would resolve to nothing.
  if (dirty) store.save(SECRETS_FILE, vault);
  fs.mkdirSync(DIR, {recursive: true});
  const temp = FILE + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(out, null, 2));
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, FILE);
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

// Servers found in other agents' configs, not yet in ours. Secrets stay in the files they came from
// until imported; on import, save() moves them into the secure-store like any other secret.
function discover() {
  const found = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const [name, s] of Object.entries(j.mcpServers || {})) found.push({name, from: 'Claude Code', server: s});
  } catch {}
  try {
    const toml = require('smol-toml').parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8'));
    for (const [name, s] of Object.entries(toml.mcp_servers || {})) {
      if (s.enabled === false) continue;
      found.push({name, from: 'Codex', server: {...(s.url ? {type: 'http', url: s.url, ...(s.http_headers ? {headers: s.http_headers} : {})} : {command: s.command, args: s.args || [], ...(s.env ? {env: s.env} : {}), ...(s.cwd ? {cwd: s.cwd} : {})})}});
    }
  } catch {}
  // One entry per name; the same server is often in both.
  const seen = new Set(Object.keys(load().mcpServers || {}));
  return found.filter(f => !seen.has(f.name) && !seen.has(f.name.toLowerCase()) && (seen.add(f.name), true));
}
function importServers(list) {
  const cfg = load(); cfg.mcpServers = cfg.mcpServers || {};
  for (const f of list) cfg.mcpServers[f.name] = {...f.server, enabled: false, importedFrom: f.from};
  save(cfg); return cfg;
}
// The hub that has been start()ed in this process, if any. setEnabled() uses it to apply
// enable/disable live instead of only editing the config for the next restart.
let activeHub = null;
function setEnabled(name, enabled, hub = activeHub) {
  const cfg = load();
  if (cfg.mcpServers?.[name]) {
    cfg.mcpServers[name].enabled = enabled; save(cfg);
    if (hub && hub.started) hub.applyEnabled(name, enabled, cfg.mcpServers[name]);
  }
  return cfg;
}
// Remote MCP servers must be https: their headers may carry secrets, so plain http is
// only acceptable on loopback. Throws with a clear message; connect() surfaces it as
// the server's error status.
function checkRemoteUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid MCP server URL: ' + String(raw)); }
  if (u.protocol === 'https:') return u;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) return u;
  throw new Error('Refusing non-https MCP server URL (' + u.protocol + '//' + u.host + '): remote MCP servers must use https because headers may carry secrets; http is only allowed for localhost.');
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

// MCP JSON Schema -> commands_v2 params (flat; nested values travel as JSON strings).
// There is deliberately no 'number' device spec: every spec type used by the built-in
// tools is string/integer/boolean (see tools.js), and an 'integer' spec truncates floats
// in the gateway's coercion. So a JSON-schema 'number' (like object/array and any other
// non-simple type) travels as a JSON-encoded string and call() parses it back strictly,
// preserving floating point.
function params(schema = {}) {
  const props = schema.properties || {}, req = new Set(schema.required || []), required = {}, optional = {}, json = new Set(), types = {};
  for (const [k, p] of Object.entries(props)) {
    const t = Array.isArray(p.type) ? p.type.find(x => x !== 'null') : p.type;
    types[k] = t || 'value';
    const simple = ['string', 'integer', 'boolean'].includes(t) ? t : null;
    let desc = String(p.description || '').slice(0, 300);
    if (p.enum) desc += ' One of: ' + p.enum.slice(0, 20).join(', ') + '.';
    const spec = simple ? {type: simple, description: desc} : {type: 'string', description: (desc + ' (JSON-encoded ' + (t || 'value') + ')').trim()};
    if (!simple) json.add(k);
    (req.has(k) ? required : optional)[k] = spec;
  }
  return {required, optional, json, types};
}

class McpHub {
  constructor() { this.servers = new Map(); this.commands = new Map(); this.gens = new Map(); this.started = false; this.onChange = null; this._log = () => {}; }
  get config() { return load(); }
  // Connect every enabled server (in parallel, each bounded); failures are kept as status.
  async start(log = () => {}) {
    this._log = typeof log === 'function' ? log : () => {};
    this.started = true; activeHub = this;
    const cfg = load();
    await Promise.all(Object.entries(cfg.mcpServers || {}).filter(([, s]) => s.enabled).map(([name, s]) => this.connect(name, s).catch(e => log(name + ': ' + e.message))));
    this.index();
  }
  _notify(name) { try { this.onChange?.(name, this.servers.get(name)); } catch {} }
  // A connected server whose transport/client closes or errors is dead: it must not
  // stay 'connected' with callable commands. Mark it 'error' with the reason, drop its
  // tools, re-index, and surface the change the same way as other status changes
  // (entry status/error for the /mcp menu, the start() log, and onChange listeners).
  _markDead(entry, reason) {
    if (this.servers.get(entry.name) !== entry || entry.status !== 'connected') return;
    entry.status = 'error';
    entry.error = redact(reason?.message || String(reason || 'connection closed'));
    entry.client = undefined; entry.transport = undefined; entry.tools = [];
    this.index();
    this._log(entry.name + ': ' + entry.error);
    this._notify(entry.name);
  }
  // Live counterpart of setEnabled() for an already-started hub: enabling connects the
  // server now, disabling disconnects it now. Fire-and-forget; outcomes surface on the
  // server entry's status/error (connect() records them) and via _log/_notify.
  applyEnabled(name, enabled, serverCfg) {
    const run = enabled ? this.connect(name, serverCfg).then(() => this.index()) : this.disconnect(name).then(() => this.index());
    run.catch(e => { this._log(name + ': ' + redact(e.message)); this._notify(name); });
    this._notify(name);
  }
  async connect(name, s) {
    await this.disconnect(name);
    const gen = (this.gens.get(name) || 0) + 1;
    this.gens.set(name, gen);
    const entry = {name, status: 'connecting', tools: [], error: '', stderrTail: ''};
    this.servers.set(name, entry);
    // A connect/listTools that resolves after its timeout — or after a newer connect or
    // a disconnect for the same name — must not mutate hub state; `stale()` detects that.
    const stale = () => this.gens.get(name) !== gen || this.servers.get(name) !== entry;
    let client;
    try {
      for (const v of Object.values(s.env || {})) noteSecret(v);
      for (const v of Object.values(s.headers || {})) noteSecret(v);
      const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
      let transport;
      if (s.url || s.type === 'http' || s.type === 'sse') {
        const {StreamableHTTPClientTransport} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(checkRemoteUrl(s.url), {requestInit: {headers: s.headers || {}}});
      } else {
        const {StdioClientTransport, getDefaultEnvironment} = require('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({command: s.command, args: s.args || [], env: {...getDefaultEnvironment(), ...(s.env || {})}, cwd: s.cwd, stderr: 'pipe'});
        // Keep the server's stderr (bounded tail) so startup failures are diagnosable.
        const errStream = transport.stderr;
        if (errStream) errStream.on('data', d => { entry.stderrTail = (entry.stderrTail + d.toString()).slice(-2000); });
      }
      client = new Client({name: 'muser', version: require('../package.json').version});
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT, '接続がタイムアウトしました');
      if (stale()) { try { await client.close(); } catch {} return; }
      const tools = [], seenCursors = new Set();
      for (let cursor, pages = 0; ;) {
        if (++pages > MAX_LIST_PAGES) throw new Error('ツール一覧のページ数が上限 (' + MAX_LIST_PAGES + ') を超えました');
        const r = await withTimeout(client.listTools(cursor ? {cursor} : {}), CONNECT_TIMEOUT, 'ツール一覧がタイムアウトしました');
        if (stale()) { try { await client.close(); } catch {} return; }
        tools.push(...r.tools);
        if (!r.nextCursor) break;
        if (seenCursors.has(r.nextCursor)) throw new Error('ツール一覧のカーソルが繰り返されました: ' + r.nextCursor);
        seenCursors.add(r.nextCursor);
        cursor = r.nextCursor;
      }
      Object.assign(entry, {client, transport, tools, status: 'connected'});
      // Liveness: from here on, a close/error from the transport or client means the
      // server is gone (crash, exit, dropped connection) — see _markDead. Intentional
      // disconnects bump the generation / replace the entry first, so stale() wins.
      client.onclose = () => { if (!stale()) this._markDead(entry, new Error('MCP server connection closed')); };
      client.onerror = e => { if (!stale()) this._markDead(entry, e); };
    } catch (e) {
      const tail = entry.stderrTail ? entry.stderrTail.trim().slice(-500) : '';
      const msg = redact(e.message + (tail ? '\n[stderr] ' + tail : ''));
      if (!stale()) Object.assign(entry, {status: 'error', error: msg});
      try { await client?.close(); } catch {}
      throw new Error(msg);
    }
  }
  async disconnect(name) { this.gens.set(name, (this.gens.get(name) || 0) + 1); const e = this.servers.get(name); if (!e) return; this.servers.delete(name); this.index(); try { await e.client?.close(); } catch {} }
  async close() { this.started = false; if (activeHub === this) activeHub = null; await Promise.all([...this.servers.keys()].map(n => this.disconnect(n))); this.index(); }
  index() {
    this.commands.clear();
    const used = new Set();
    for (const e of this.servers.values()) for (const t of e.tools || []) {
      let key = 'mcp.' + slug(e.name) + '.' + slug(t.name);
      // Distinct servers/tools can slug to the same command name; suffix instead of overwriting.
      if (used.has(key)) { let n = 2; while (used.has(key + '-' + n)) n++; key = key + '-' + n; }
      used.add(key);
      const p = params(t.inputSchema);
      this.commands.set(key, {server: e.name, tool: t.name, json: p.json, types: p.types, readOnly: t.annotations?.readOnlyHint === true,
        def: {description: ('[MCP ' + e.name + '] ' + (t.description || t.name)).slice(0, 1500), required: p.required, optional: p.optional, timeout_ms: CALL_TIMEOUT + 5000}});
    }
  }
  defs() { return Object.fromEntries([...this.commands].map(([k, c]) => [k, c.def])); }
  async call(key, params, signal) {
    const c = this.commands.get(key); if (!c) throw new Error('Unknown MCP tool ' + key);
    const e = this.servers.get(c.server); if (!e?.client) throw new Error('MCP server ' + c.server + ' is not connected');
    const args = {};
    for (const [k, v] of Object.entries(params || {})) {
      const t = c.types?.[k];
      // A value that cannot be coerced to the schema type is a clear, local error
      // result — never silently forwarded as a raw string / NaN for the server to
      // reject (or, worse, misinterpret).
      const bad = () => ({isError: true, text: 'Invalid argument "' + k + '" for MCP tool ' + c.tool + ': expected ' + t + ', got ' + JSON.stringify(v)?.slice(0, 120)});
      if (v === undefined) { args[k] = v; continue; }
      if (typeof v === 'string' && (c.json.has(k) || t === 'number' || t === 'integer' || t === 'boolean')) {
        if (t === 'number' || t === 'integer') {
          let n; try { n = JSON.parse(v); } catch { n = undefined; }
          if (typeof n !== 'number') { const s = v.trim(); n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : NaN; }
          if (typeof n !== 'number' || !Number.isFinite(n) || (t === 'integer' && !Number.isInteger(n))) return bad();
          args[k] = n; continue;
        }
        if (t === 'boolean') {
          let b; try { b = JSON.parse(v); } catch { b = undefined; }
          if (typeof b !== 'boolean') return bad();
          args[k] = b; continue;
        }
        try {
          const parsed = JSON.parse(v);
          if (t === 'array' && !Array.isArray(parsed)) return bad();
          if (t === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) return bad();
          args[k] = parsed; continue;
        } catch {
          if (t === 'array' || t === 'object') return bad();
          args[k] = v; continue; // Untyped/complex schema: a bare string is a legitimate value.
        }
      }
      // Non-string values arrive already coerced by the gateway; still check them
      // against the schema type before forwarding.
      if (t === 'number' || t === 'integer') { if (typeof v !== 'number' || !Number.isFinite(v) || (t === 'integer' && !Number.isInteger(v))) return bad(); }
      else if (t === 'boolean' && typeof v !== 'boolean') return bad();
      else if (t === 'array' && !Array.isArray(v)) return bad();
      else if (t === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) return bad();
      args[k] = v;
    }
    const r = await e.client.callTool({name: c.tool, arguments: args}, undefined, {signal, timeout: CALL_TIMEOUT});
    // Keep every content block visible: non-text blocks become placeholder lines
    // instead of being dropped, and structuredContent is appended as a JSON block
    // even when text content is also present.
    const parts = (r.content || []).map(x => {
      if (x.type === 'text') return x.text ?? '';
      if (x.type === 'image') return '[image content]';
      if (x.type === 'audio') return '[audio content]';
      if (x.type === 'resource') return '[resource: ' + (x.resource?.uri || 'unknown') + ']' + (typeof x.resource?.text === 'string' ? '\n' + x.resource.text : '');
      if (x.type === 'resource_link') return '[resource: ' + (x.uri || 'unknown') + ']';
      return '[' + x.type + ' content]';
    });
    if (r.structuredContent !== undefined && r.structuredContent !== null) parts.push(JSON.stringify(r.structuredContent));
    let text = parts.join('\n');
    if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + '\n… (truncated)';
    return {isError: !!r.isError, text};
  }
}

function withTimeout(p, ms, msg) { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); }

module.exports = {McpHub, load, save, discover, importServers, setEnabled, FILE, redact, params, checkRemoteUrl};
