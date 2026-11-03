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
const {t} = require('./i18n');

const DIR = path.join(os.homedir(), '.muser');
const FILE = path.join(DIR, 'mcp.json');
const SECRETS_FILE = 'mcp-secrets.enc';
const CONNECT_TIMEOUT = 15000, CALL_TIMEOUT = 120000, MAX_RESULT = 60000, MAX_LIST_PAGES = 20;

// Values that must never appear verbatim in an error message or a log line. Only values
// under a secret-looking KEY are noted (audit #234): noting every env value also redacted
// plain configuration — NODE_ENV=production, a port, a URL — from every error message.
// Secrets shorter than 4 characters ARE noted: they used to leak verbatim.
const knownSecrets = new Set();
const SECRET_KEY = /key|token|secret|passw|auth|cred|private|session|cookie/i;
function noteSecret(v, key) {
  if (typeof v !== 'string' || !v) return;
  if (key !== undefined && !SECRET_KEY.test(String(key))) return;
  knownSecrets.add(v);
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function redact(text) {
  let out = String(text ?? '');
  // Longest first: replacing a short secret that prefixes a longer one ('abcd' before
  // 'abcdefgh') left the longer one's tail in the clear (audit #234).
  for (const v of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    if (v.length >= 4) out = out.split(v).join('***');
    // A short secret is replaced only as a whole token, so a 2-3 character value does
    // not garble every word that happens to contain it.
    else out = out.replace(new RegExp('(^|[^A-Za-z0-9])' + escapeRe(v) + '(?![A-Za-z0-9])', 'g'), '$1***');
  }
  return out;
}
function isSecretRef(v) { return !!v && typeof v === 'object' && typeof v.$secret === 'string'; }

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return {mcpServers: {}}; }
  let cfg = null;
  try { cfg = require('./config').parseJson(raw); } catch {}
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    // Corrupt config: keep the bytes for recovery instead of silently starting empty.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(FILE, FILE + '.corrupt-' + stamp); } catch {}
    return {mcpServers: {}};
  }
  return resolveSecrets(cfg);
}
// $secret references the vault did not have, per server, from the latest resolveSecrets().
// A missing entry used to become an empty string, so the server started with API_KEY=""
// and failed upstream with an opaque auth error (audit #233); connect() refuses with a
// clear message instead, using this record.
let missingByServer = new Map();
function missingSecrets(name) { return missingByServer.get(name) || []; }

// Replace {"$secret": key} references in env/headers with values from the secure-store.
// Plaintext values pass through untouched (backward compat) and are noted for redaction.
function resolveSecrets(cfg) {
  missingByServer = new Map();
  let hasRefs = false;
  for (const s of Object.values(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      for (const [k, v] of Object.entries(s?.[kind] || {})) {
        if (isSecretRef(v)) hasRefs = true; else noteSecret(v, k);
      }
    }
  }
  if (!hasRefs) return cfg;
  const vault = store.load(SECRETS_FILE) || {};
  for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      if (!s?.[kind]) continue;
      for (const [k, v] of Object.entries(s[kind])) {
        if (isSecretRef(v)) {
          const val = vault[v.$secret];
          if (typeof val === 'string') { s[kind][k] = val; noteSecret(val, k); }
          else { s[kind][k] = ''; if (!missingByServer.has(name)) missingByServer.set(name, []); missingByServer.get(name).push(v.$secret); }
        }
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
  const loadVault = () => { if (!vaultLoaded) { Object.assign(vault, store.load(SECRETS_FILE) || {}); vaultLoaded = true; } };
  for (const [name, s] of Object.entries(out.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      if (!s?.[kind]) continue;
      for (const [k, v] of Object.entries(s[kind])) {
        if (isSecretRef(v) || typeof v !== 'string' || !v) continue;
        loadVault();
        const key = name + ':' + kind + ':' + k;
        vault[key] = v; noteSecret(v, k); s[kind][k] = {$secret: key}; dirty = true;
      }
    }
  }
  // Prune the vault to the references this config actually keeps (audit #232): deleting a
  // server or clearing a key used to leave the old secret in mcp-secrets.enc for ever.
  // If the vault cannot be read, skip pruning rather than fail the config save.
  let pruned = false;
  try {
    loadVault();
    const live = new Set();
    for (const s of Object.values(out.mcpServers || {})) for (const kind of ['env', 'headers']) for (const v of Object.values(s?.[kind] || {})) if (isSecretRef(v)) live.add(v.$secret);
    for (const key of Object.keys(vault)) if (!live.has(key)) { delete vault[key]; pruned = true; }
  } catch { pruned = false; }
  // Secrets first: if the vault write fails, mcp.json is left untouched rather than
  // pointing at references that would resolve to nothing.
  if (dirty || pruned) store.save(SECRETS_FILE, vault);
  fs.mkdirSync(DIR, {recursive: true});
  const temp = FILE + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(out, null, 2));
    try { fs.chmodSync(temp, 0o600); } catch {}
    // Retried: EPERM while another window has mcp.json open for reading (src/config.js).
    require('./config').renameRetry(temp, FILE);
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

// Servers found in other agents' configs, not yet in ours. Secrets stay in the files they came from
// until imported; on import, save() moves them into the secure-store like any other secret.
function discover() {
  const found = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const [name, s] of Object.entries(j.mcpServers || {})) {
      // A server the user disabled in Claude Code stays disabled here: the Codex branch
      // below already honours enabled:false, the Claude branch imported them anyway (#236).
      if (s?.disabled === true || s?.enabled === false) continue;
      found.push({name, from: 'Claude Code', server: s});
    }
  } catch {}
  try {
    const toml = require('smol-toml').parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8'));
    for (const [name, s] of Object.entries(toml.mcp_servers || {})) {
      if (s.enabled === false) continue;
      found.push({name, from: 'Codex', server: {...(s.url ? {type: 'http', url: s.url, ...(s.http_headers ? {headers: s.http_headers} : {})} : {command: s.command, args: s.args || [], ...(s.env ? {env: s.env} : {}), ...(s.cwd ? {cwd: s.cwd} : {})})}});
    }
  } catch {}
  // One entry per name; the same server is often in both. Names compare case-insensitively
  // (server names are matched loosely elsewhere too), so the seen set holds lowercase only:
  // it used to hold raw names while the check looked up lowercase, so a case variant of an
  // already-configured (or already-found) server slipped through as a duplicate.
  const seen = new Set(Object.keys(load().mcpServers || {}).map(n => String(n).toLowerCase()));
  return found.filter(f => { const key = String(f.name).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
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
    // Capture the handles before clearing them and close them best-effort: dropping the
    // references alone leaked the transport (and, for stdio, the server process behind it).
    const client = entry.client, transport = entry.transport;
    entry.client = undefined; entry.transport = undefined; entry.tools = [];
    this.index();
    this._log(entry.name + ': ' + entry.error);
    this._notify(entry.name);
    for (const h of [client, transport]) {
      if (!h || typeof h.close !== 'function') continue;
      try { const r = h.close(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {}
    }
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
    // Reserve the generation synchronously, as the first statement: this used to await
    // disconnect() before minting it, so a disable/close (or a newer connect) that landed
    // during that await was overtaken by this connect when it resumed and minted a fresh
    // generation afterwards. The previous entry is closed inline instead of via
    // disconnect(), which would bump the generation again and invalidate this one.
    const gen = (this.gens.get(name) || 0) + 1;
    this.gens.set(name, gen);
    const prev = this.servers.get(name);
    if (prev) {
      this.servers.delete(name);
      this.index();
      try { await prev.client?.close(); } catch {}
      if (this.gens.get(name) !== gen) return; // overtaken while closing the old entry
    }
    const entry = {name, status: 'connecting', tools: [], error: '', stderrTail: ''};
    this.servers.set(name, entry);
    // A connect/listTools that resolves after its timeout — or after a newer connect or
    // a disconnect for the same name — must not mutate hub state; `stale()` detects that.
    const stale = () => this.gens.get(name) !== gen || this.servers.get(name) !== entry;
    let client;
    try {
      // A $secret reference the vault no longer has must not reach the server as an
      // empty string (audit #233): fail here, where the reason can be said plainly.
      const missing = missingSecrets(name);
      if (missing.length) throw new Error('Secret(s) not found in the secure store (' + SECRETS_FILE + '): ' + missing.join(', ') + '. The server was not started with an empty value; save its config again to store the secret.');
      for (const [k, v] of Object.entries(s.env || {})) noteSecret(v, k);
      for (const [k, v] of Object.entries(s.headers || {})) noteSecret(v, k);
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
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT, t('接続がタイムアウトしました'));
      if (stale()) { try { await client.close(); } catch {} return; }
      const tools = [], seenCursors = new Set();
      for (let cursor, pages = 0; ;) {
        if (++pages > MAX_LIST_PAGES) throw new Error(t('ツール一覧のページ数が上限 ({max}) を超えました', {max: MAX_LIST_PAGES}));
        const r = await withTimeout(client.listTools(cursor ? {cursor} : {}), CONNECT_TIMEOUT, t('ツール一覧がタイムアウトしました'));
        if (stale()) { try { await client.close(); } catch {} return; }
        tools.push(...r.tools);
        if (!r.nextCursor) break;
        if (seenCursors.has(r.nextCursor)) throw new Error(t('ツール一覧のカーソルが繰り返されました: {cursor}', {cursor: r.nextCursor}));
        seenCursors.add(r.nextCursor);
        cursor = r.nextCursor;
      }
      Object.assign(entry, {client, transport, tools, status: 'connected'});
      // Liveness: from here on, a close/error from the transport or client means the
      // server is gone (crash, exit, dropped connection) — see _markDead. Intentional
      // disconnects bump the generation / replace the entry first, so stale() wins.
      client.onclose = () => { if (!stale()) this._markDead(entry, new Error('MCP server connection closed')); };
      // Only onclose counts as death: onerror also fires for non-fatal protocol/request
      // errors on a connection that is still usable, and marking the server dead for each
      // one dropped a working server (and its tools) until a manual reconnect. A fatal
      // error is always followed by a close, which _markDead handles.
      client.onerror = e => { if (!stale()) this._log(name + ': ' + redact(e?.message || String(e || 'error'))); };
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
    // Allocate command keys deterministically: iterating the servers Map in insertion
    // order made slug-collision suffixes (-2, -3, ...) depend on connect order, so a
    // reconnect (delete + set moves a server to the end) swapped which server owned the
    // unsuffixed key. Sorting servers and tools by name (codepoint order, not locale)
    // keeps the assignment stable across reconnects and restarts.
    const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const entries = [...this.servers.values()].sort((x, y) => byName(x.name, y.name));
    for (const e of entries) for (const t of [...(e.tools || [])].sort((x, y) => byName(x.name, y.name))) {
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
      // A string parameter was the one type never checked: a value the gateway had
      // already coerced to a number/boolean ("123" -> 123, "true" -> true) was forwarded
      // with its type changed (audit #235).
      else if (t === 'string' && typeof v !== 'string') return bad();
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

module.exports = {McpHub, load, save, discover, importServers, setEnabled, FILE, redact, params, checkRemoteUrl, missingSecrets};
