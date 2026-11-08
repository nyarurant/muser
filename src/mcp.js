'use strict';
// MCP client side of muser. Muse runs the agent loop, so MCP tools reach it as device commands:
// each enabled server's tools are registered as `mcp.<server>.<tool>` and calls are relayed to
// the server. Config: ~/.muser/mcp.json ({mcpServers: {name: {command,args,env,cwd} | {url,headers},
// enabled}}), importable from Claude Code (~/.claude.json) and Codex (~/.codex/config.toml).
// Secret values (env / headers) are NOT stored in mcp.json: save() moves them into the
// DPAPI-backed secure-store and leaves {"$secret": "<server>:<kind>:<key>"} references
// behind, which load() resolves back. Plaintext configs from before (or written by other
// tools) still load as-is; load() now migrates plaintext env/header values into the
// vault itself, best-effort (see migratePlaintext), instead of leaving them in the
// clear until some unrelated save() happens. Note: mcp.json should stay user-only —
// a failed migration (or an external edit after the last load) can still leave it
// briefly holding plaintext — so save() also chmods it 0600 where the OS honours that.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./secure-store');
const {t} = require('./i18n');

const DIR = path.join(os.homedir(), '.muser');
const FILE = path.join(DIR, 'mcp.json');
const SECRETS_FILE = 'mcp-secrets.enc';
const CONNECT_TIMEOUT = 15000, CALL_TIMEOUT = 120000, MAX_RESULT = 60000, MAX_LIST_PAGES = 20, MAX_LIST_TOOLS = 1000;

// Values that must never appear verbatim in an error message or a log line. Plaintext
// values are noted only under a secret-looking KEY (audit #234): noting every env value
// also redacted plain configuration — NODE_ENV=production, a port, a URL — from every
// error message. Secrets shorter than 4 characters ARE noted: they used to leak verbatim.
const knownSecrets = new Set();
const SECRET_KEY = /key|token|secret|passw|auth|cred|private|session|cookie/i;
function noteSecret(v, key) {
  if (typeof v !== 'string' || !v) return;
  if (key !== undefined && !SECRET_KEY.test(String(key))) return;
  knownSecrets.add(v);
}
// A value that came OUT of the vault (resolved from a $secret reference, being written
// into it by save(), or handed to a server that is actually starting) is secret
// material whatever KEY it sits under (wave5): a secret stored as CUSTOM_DATA was
// vaulted like any other, yet noting keyed on the NAME left it out, so a server
// echoing its own env on stderr handed it back in the clear. Such values are noted
// under any key — except ones plainly shaped like configuration, the #234 false
// positives (a common word, a boolean, a port, a URL, a host:port): save() vaults
// EVERY env/header string indiscriminately, so the vault alone cannot tell a token
// from NODE_ENV=production either, and redacting the word "production" from every
// error would be the same garbling #234 removed. A short (<5) or dictionary-word
// secret under an ordinary key therefore still goes unnoted — it cannot be told
// apart from plain configuration without that garbling.
function isPlainConfigValue(v) {
  if (/^https?:\/\//i.test(v)) return true;
  if (/^(true|false|yes|no|on|off|none|null)$/i.test(v)) return true;
  if (/^[a-z]+$/.test(v) && v.length <= 12) return true; // production, development, debug…
  if (/^[0-9]+$/.test(v) && v.length <= 8) return true; // a port / count, not a PIN-shaped secret
  if (/^[a-z0-9.-]+:\d+$/i.test(v)) return true; // host:port
  return false;
}
function noteVaultSecret(v, key) {
  if (typeof v !== 'string' || !v) return;
  if (key !== undefined && SECRET_KEY.test(String(key))) { knownSecrets.add(v); return; }
  if (v.length < 5 || isPlainConfigValue(v)) return;
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
// env/headers must be a plain name/value object. A string ("env": "FOO=bar") or an
// array used to pass Object.entries() as characters / indices: save() then threw a
// strict-mode TypeError on the string and silently rewrote an array env into
// numeric $secret keys, corrupting the config (deep c14 #5).
function isBag(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
// Validate one server's env/headers bag and return it with scalar values as
// strings (a TOML import can carry numbers). Anything else is a clear config
// error naming the server and field, not an opaque TypeError or silent damage.
function stringBag(name, kind, bag) {
  if (bag === undefined || bag === null) return {};
  if (!isBag(bag)) throw new Error('Invalid MCP server config for "' + name + '": "' + kind + '" must be an object of name/value pairs.');
  const out = {};
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else throw new Error('Invalid MCP server config for "' + name + '": "' + kind + '.' + k + '" must be a string value.');
  }
  return out;
}

// "mcpServers" itself must be a plain name -> config object. A string or an
// array used to pass load() untouched (Object.entries walked its characters /
// indices) and every server then vanished silently in hub.start(), or showed
// up under a numeric name. That is a problem with the FILE, not with any one
// server, so the error names mcp.json and says what shape it must have.
function checkMcpServers(servers) {
  if (servers === undefined) return;
  if (!isBag(servers)) throw new Error('Invalid MCP config in ' + FILE + ': "mcpServers" must be an object mapping server names to server configs.');
}
// The top-level shape error load() last saw, if any (wave15). load() used to
// throw it (checkMcpServers above, wave4), which took the whole session down
// with it: bin calls load() while assembling, so one hand-edited line
// ("mcpServers": [...]) kept muser itself from starting even though no valid
// server could be lost by ignoring the value. load() now records the error
// here instead, drops the malformed value, and everything else starts as
// usual; hub.start() surfaces the record as an error entry + log line, and
// configError() exposes it to other readers. save() still refuses the shape
// via checkMcpServers: writing a bad shape back is a different matter.
let lastConfigError = '';
function configError() { return lastConfigError; }
function mcpServersShapeError() {
  return t('「mcpServers」の形式が正しくありません（サーバー名と設定のオブジェクトである必要があります）: {file}。この値は無視して、MCP なしで起動します。', {file: FILE});
}
// "enabled" is a boolean in a well-formed config, but a hand-edited file can
// carry the string "false" — which is truthy, so the server the user meant to
// turn OFF connected anyway (wave15). load() normalises the flag to a real
// boolean: recognised true-words and non-zero numbers become true, everything
// else ("false", other strings, objects, null) becomes false — an unclear
// flag must not start a server.
function normalizeEnabled(cfg) {
  for (const s of Object.values(cfg.mcpServers || {})) {
    if (!isBag(s) || !('enabled' in s)) continue;
    const v = s.enabled;
    if (typeof v === 'boolean') continue;
    if (typeof v === 'string') { const w = v.trim().toLowerCase(); s.enabled = w === 'true' || w === '1' || w === 'yes' || w === 'on'; }
    else if (typeof v === 'number') s.enabled = v !== 0;
    else s.enabled = false;
  }
}
// One server's entry must be a plain object too. A null / string / array entry
// used to crash hub.start() wholesale (reading ".enabled" of null) and keep
// every healthy server from starting; callers either surface this error for
// the named entry (connect()/save()/setEnabled()) or record it as that
// entry's error status and carry on with the rest (hub.start()).
function invalidEntryError(name) {
  return new Error('Invalid MCP server config for "' + name + '": the entry must be an object (for example {"command": ...} or {"url": ...}).');
}

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { lastConfigError = ''; return {mcpServers: {}}; }
  let cfg = null;
  try { cfg = require('./config').parseJson(raw); } catch {}
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    // Corrupt config: keep the bytes for recovery instead of silently starting empty.
    lastConfigError = '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(FILE, FILE + '.corrupt-' + stamp); } catch {}
    return {mcpServers: {}};
  }
  // A wrong top-level "mcpServers" shape is recorded, not thrown (see
  // lastConfigError above): the malformed value is dropped, the rest of the
  // config (and the app) proceeds normally.
  if (cfg.mcpServers !== undefined && !isBag(cfg.mcpServers)) {
    lastConfigError = mcpServersShapeError();
    cfg = {...cfg, mcpServers: {}};
  } else lastConfigError = '';
  const hadPlaintext = hasPlaintextValues(cfg);
  const resolved = resolveSecrets(cfg);
  normalizeEnabled(resolved);
  // Wave5: a plaintext config used to stay in the clear until some unrelated
  // save() happened; close that window here, best-effort.
  if (hadPlaintext) migratePlaintext(resolved);
  return resolved;
}
// Any env/header value still written as a non-empty string in the file (as
// opposed to a {"$secret": …} reference)? Those are the values save() would
// vault, so they are what load-time migration looks for. '' is not one: save()
// leaves empty strings as they are, so treating one as plaintext would retry
// the migration on every load for ever.
function hasPlaintextValues(cfg) {
  for (const s of Object.values(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      if (!isBag(s?.[kind])) continue;
      for (const v of Object.values(s[kind])) if (typeof v === 'string' && v !== '') return true;
    }
  }
  return false;
}
// The file version (mtime + size) this process last attempted to migrate, so a
// migration that keeps failing (DPAPI down, an entry save() refuses) is tried
// once per file version per process instead of on every load() — hub.config
// alone calls load() on every access. A new process, or any change to the
// file, retries.
let lastMigrationStamp = null;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
// Who holds the mcp.json lock right now: 'ours' (this process is inside a
// withLock read-modify-write — setEnabled() / importServers() call load()
// there, and taking the lock again would wait out the whole budget and throw),
// 'other' (a live window is mid-save: its save vaults what it loaded, so skip
// this time WITHOUT recording the stamp — a later load retries if plaintext
// remains), or 'none' (no live holder; a stale lock file from a dead window
// counts as none, save() takes it over itself).
function lockState() {
  try {
    const pid = Number((fs.readFileSync(FILE + '.lock', 'utf8').split(':')[1] || '').trim());
    if (!(pid > 0)) return 'none';
    if (pid === process.pid) return 'ours';
    return pidAlive(pid) ? 'other' : 'none';
  } catch { return 'none'; }
}
// Best-effort: move a just-loaded config's plaintext env/header values into
// the vault by running it through the normal save path (which also notes the
// values for redaction). ANY failure is swallowed — load() must return the
// config it read even when the vault or the file is unwritable; the plaintext
// then simply stays, exactly as it did before this migration existed.
function migratePlaintext(resolved) {
  let stamp;
  try { const st = fs.statSync(FILE); stamp = st.mtimeMs + ':' + st.size; } catch { return; }
  if (stamp === lastMigrationStamp) return;
  const state = lockState();
  if (state === 'other') return;
  lastMigrationStamp = stamp;
  try {
    if (state === 'ours') saveUnlocked(resolved); // already under the lock: write directly
    else save(resolved);
  } catch { /* best-effort: never break load() */ }
}
// $secret references the vault did not have, per server, from the latest resolveSecrets().
// A missing entry used to become an empty string, so the server started with API_KEY=""
// and failed upstream with an opaque auth error (audit #233); connect() refuses with a
// clear message instead, using this record.
let missingByServer = new Map();
function missingSecrets(name) { return missingByServer.get(name) || []; }
// The original {"$secret": key} for every reference the vault did not have, keyed by
// server/kind/field (deep H7). resolveSecrets() still resolves a missing reference
// to '' in the loaded config (so connect() can refuse via missingByServer above),
// but save() must not write that '' back: an unrelated save (a setEnabled toggle,
// an importServers add) used to destroy the reference permanently, after which the
// missing-secret detection no longer fired and the server started with an empty
// value even if the vault was later restored. save() restores these references
// for fields that are still '' when it writes.
let unresolvedRefs = new Map();
const unresolvedKey = (name, kind, k) => name + '\0' + kind + '\0' + k;

// Replace {"$secret": key} references in env/headers with values from the secure-store.
// Plaintext values pass through untouched (backward compat) and are noted for redaction
// under secret-looking keys only; values resolved FROM the vault are noted under any
// key via noteVaultSecret() — they are in the vault because they are secrets.
function resolveSecrets(cfg) {
  missingByServer = new Map();
  unresolvedRefs = new Map();
  let hasRefs = false;
  for (const s of Object.values(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      // Only a plain object is a name/value bag: a hand-edited string or array
      // env used to be walked entry by entry (characters / indices) here.
      if (!isBag(s?.[kind])) continue;
      for (const [k, v] of Object.entries(s[kind])) {
        if (isSecretRef(v)) hasRefs = true; else noteSecret(v, k);
      }
    }
  }
  if (!hasRefs) return cfg;
  const vault = store.load(SECRETS_FILE) || {};
  for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
    for (const kind of ['env', 'headers']) {
      if (!isBag(s?.[kind])) continue;
      for (const [k, v] of Object.entries(s[kind])) {
        if (isSecretRef(v)) {
          const val = vault[v.$secret];
          if (typeof val === 'string') { s[kind][k] = val; noteVaultSecret(val, k); }
          else { s[kind][k] = ''; if (!missingByServer.has(name)) missingByServer.set(name, []); missingByServer.get(name).push(v.$secret); unresolvedRefs.set(unresolvedKey(name, kind, k), v.$secret); }
        }
      }
    }
  }
  return cfg;
}
// save() is a read-modify-write of BOTH mcp.json and the vault, shared by every
// muser window: without a lock, two windows saving at once each wrote back their
// own stale snapshot and silently dropped the other's toggle / secret (deep
// c14 #2). The whole write runs under config.withLock on mcp.json, and the
// load->modify->save entry points (setEnabled / importServers) hold the same
// lock across their load too, so a change is never based on a stale snapshot.
function save(cfg) { return require('./config').withLock(FILE, () => saveUnlocked(cfg)); }
function saveUnlocked(cfg) {
  // Work on a copy: the caller's object keeps its resolved plaintext values.
  const out = JSON.parse(JSON.stringify(cfg ?? {mcpServers: {}}));
  checkMcpServers(out.mcpServers);
  // Shape first (deep c14 #5): a non-object env/headers, or a non-string value
  // inside one, is refused with a clear message before anything is written —
  // the old code threw a strict-mode TypeError (string env) or silently
  // rewrote the bag (array env) and vaulted values under numeric keys.
  for (const [name, s] of Object.entries(out.mcpServers || {})) {
    if (!isBag(s)) throw invalidEntryError(name);
    for (const kind of ['env', 'headers']) {
      if (s[kind] === undefined || s[kind] === null) continue;
      // The bag itself must be an object first (a string/array env is refused
      // here, not walked entry by entry as characters / indices).
      if (!isBag(s[kind])) stringBag(name, kind, s[kind]); // throws the clear error
      // $secret references are not values: set them aside, validate the rest,
      // and put them back untouched (stringBag() would refuse an object).
      const plain = {}, refs = {};
      for (const [k, v] of Object.entries(s[kind])) (isSecretRef(v) ? refs : plain)[k] = v;
      const bag = stringBag(name, kind, plain);
      for (const [k, v] of Object.entries(refs)) bag[k] = v;
      s[kind] = bag;
    }
  }
  // Deep H7: restore $secret references that load() could not resolve (the vault
  // had no entry) and therefore turned into ''. Only a field that is still ''
  // and still present is restored — a field the caller removed, or replaced with
  // a real value, is left exactly as the caller left it.
  if (unresolvedRefs.size) {
    for (const [name, s] of Object.entries(out.mcpServers || {})) {
      for (const kind of ['env', 'headers']) {
        if (!s?.[kind]) continue;
        for (const k of Object.keys(s[kind])) {
          if (s[kind][k] !== '') continue;
          const orig = unresolvedRefs.get(unresolvedKey(name, kind, k));
          if (orig) s[kind][k] = {$secret: orig};
        }
      }
    }
  }
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
        vault[key] = v; noteVaultSecret(v, k); s[kind][k] = {$secret: key}; dirty = true;
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
      if (s?.disabled === true || s?.enabled === false || (typeof s?.enabled === 'string' && s.enabled.trim().toLowerCase() === 'false')) continue;
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
  // Load + modify + save under the mcp.json lock (deep c14 #2): loading outside
  // the lock and saving a stale snapshot dropped another window's changes.
  let cfg;
  require('./config').withLock(FILE, () => {
    cfg = load(); cfg.mcpServers = cfg.mcpServers || {};
    for (const f of list) cfg.mcpServers[f.name] = {...f.server, enabled: false, importedFrom: f.from};
    saveUnlocked(cfg);
  });
  return cfg;
}
// The hub that has been start()ed in this process, if any. setEnabled() uses it to apply
// enable/disable live instead of only editing the config for the next restart.
let activeHub = null;
function setEnabled(name, enabled, hub = activeHub) {
  // Load + modify + save under the mcp.json lock (deep c14 #2), like importServers.
  let cfg, serverCfg;
  require('./config').withLock(FILE, () => {
    cfg = load();
    if (cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, name)) {
      // A non-object entry cannot take an "enabled" flag: in strict mode the
      // assignment itself threw a bare TypeError on a string entry.
      if (!isBag(cfg.mcpServers[name])) throw invalidEntryError(name);
      cfg.mcpServers[name].enabled = enabled; saveUnlocked(cfg);
      serverCfg = cfg.mcpServers[name];
    }
  });
  if (serverCfg && hub && hub.started) hub.applyEnabled(name, enabled, serverCfg);
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
  // A malformed schema from one server (a null property, a non-array enum, a
  // non-object properties bag) must not throw here: index() turns whatever
  // this returns into commands, and a throw used to take every server's
  // commands down with it (deep c14 #7). Odd pieces are treated as absent.
  const sch = schema && typeof schema === 'object' ? schema : {};
  const props = isBag(sch.properties) ? sch.properties : {}, req = new Set(Array.isArray(sch.required) ? sch.required : []), required = {}, optional = {}, json = new Set(), types = {};
  for (const [k, raw] of Object.entries(props)) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const t = Array.isArray(p.type) ? p.type.find(x => x !== 'null') : p.type;
    types[k] = t || 'value';
    const simple = ['string', 'integer', 'boolean'].includes(t) ? t : null;
    let desc = String(p.description || '').slice(0, 300);
    if (Array.isArray(p.enum)) desc += ' One of: ' + p.enum.slice(0, 20).map(x => String(x)).join(', ') + '.';
    else if (p.enum !== undefined && p.enum !== null) desc += ' One of: ' + String(p.enum) + '.';
    const spec = simple ? {type: simple, description: desc} : {type: 'string', description: (desc + ' (JSON-encoded ' + (t || 'value') + ')').trim()};
    if (!simple) json.add(k);
    (req.has(k) ? required : optional)[k] = spec;
  }
  return {required, optional, json, types};
}

// Fetch every tools/list page under ONE overall deadline (deep c14 #6): the
// timeout used to restart per page, so a server answering just inside each
// page's 15 s could hold connect() for MAX_LIST_PAGES x 15 s (~300 s), and a
// single page could carry an unbounded number of tools into memory. Returns
// null when stale() fires mid-listing (the caller then closes the client).
async function listAllTools(client, stale = () => false, timeoutMs = CONNECT_TIMEOUT, maxPages = MAX_LIST_PAGES, maxTools = MAX_LIST_TOOLS) {
  const tools = [], seenCursors = new Set();
  const deadline = Date.now() + timeoutMs;
  for (let cursor, pages = 0; ;) {
    if (++pages > maxPages) throw new Error(t('ツール一覧のページ数が上限 ({max}) を超えました', {max: maxPages}));
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(t('ツール一覧がタイムアウトしました'));
    const r = await withTimeout(client.listTools(cursor ? {cursor} : {}), left, t('ツール一覧がタイムアウトしました'));
    if (stale()) return null;
    if (!r || !Array.isArray(r.tools)) throw new Error('Invalid tools/list response from MCP server');
    tools.push(...r.tools);
    if (tools.length > maxTools) throw new Error(t('ツール一覧の件数が上限 ({max}) を超えました', {max: maxTools}));
    if (!r.nextCursor) break;
    if (seenCursors.has(r.nextCursor)) throw new Error(t('ツール一覧のカーソルが繰り返されました: {cursor}', {cursor: r.nextCursor}));
    seenCursors.add(r.nextCursor);
    cursor = r.nextCursor;
  }
  return tools;
}

class McpHub {
  constructor() { this.servers = new Map(); this.commands = new Map(); this.gens = new Map(); this.started = false; this.onChange = null; this._log = () => {}; this._connecting = new Map(); this.configError = ''; }
  get config() { return load(); }
  // Connect every enabled server (in parallel, each bounded); failures are kept as status.
  async start(log = () => {}) {
    this._log = typeof log === 'function' ? log : () => {};
    this.started = true; activeHub = this;
    const cfg = load();
    // A malformed top-level "mcpServers" (load() recorded it instead of
    // throwing, wave15) is this start's error record: a named error entry in
    // the same shape a failed connect leaves, plus a log line. No server can
    // come from the dropped value, and the rest of the app is unaffected.
    if (lastConfigError) {
      this.configError = lastConfigError;
      this.servers.set('mcpServers', {name: 'mcpServers', status: 'error', tools: [], error: lastConfigError, stderrTail: ''});
      log('mcpServers: ' + lastConfigError);
      this._notify('mcpServers');
    } else this.configError = '';
    // A non-object entry is that entry's error, not the whole start()'s: it is
    // recorded as an 'error' entry naming the entry (the same shape a failed
    // connect() leaves, so /mcp shows it) and logged, and the healthy servers
    // still connect. Reading ".enabled" of a null entry here used to throw a
    // bare TypeError out of start() and no server started at all.
    const jobs = [];
    for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
      if (!isBag(s)) {
        const msg = invalidEntryError(name).message;
        this.servers.set(name, {name, status: 'error', tools: [], error: msg, stderrTail: ''});
        log(name + ': ' + msg);
        this._notify(name);
        continue;
      }
      if (s.enabled) jobs.push(this.connect(name, s).catch(e => log(name + ': ' + e.message)));
    }
    await Promise.all(jobs);
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
    // A server that dies mid-session leaves its reason on stderr just like one
    // that fails to start, and connect()'s failure path appends that tail —
    // do the same here (wave15): without it the user only saw the generic
    // 'connection closed' and the actual reason sat unused in stderrTail.
    const tail = typeof entry.stderrTail === 'string' ? entry.stderrTail.trim().slice(-500) : '';
    entry.error = redact((reason?.message || String(reason || 'connection closed')) + (tail ? '\n[stderr] ' + tail : ''));
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
    // Enabling is idempotent (wave15): a server that is already connected or
    // mid-connect is not connected again. setEnabled() lands here, and the
    // /mcp pick handler then ALSO calls connect() itself — connect() joins
    // the in-flight attempt started here, so between the two paths the
    // server process used to be spawned twice.
    if (enabled) {
      const cur = this.servers.get(name);
      if (cur && (cur.status === 'connected' || cur.status === 'connecting')) { this.index(); this._notify(name); return; }
    }
    const run = enabled ? this.connect(name, serverCfg).then(() => this.index()) : this.disconnect(name).then(() => this.index());
    run.catch(e => { this._log(name + ': ' + redact(e.message)); this._notify(name); });
    this._notify(name);
  }
  // Idempotent front door for _connect() (wave15): a second enable for the
  // same name — setEnabled()'s live apply followed by the caller's own
  // connect(), or a repeated toggle — must not spawn the server twice. A
  // connect already in flight is joined (the same promise is returned, so
  // the caller still waits for the real outcome). Enabling an ALREADY
  // connected server is stopped one level up, in applyEnabled(); a direct
  // connect() on a connected entry keeps its old meaning (close the old
  // entry and reconnect), which callers and tests rely on.
  async connect(name, s) {
    if (!this._connecting) this._connecting = new Map();
    const inFlight = this._connecting.get(name);
    if (inFlight) return inFlight;
    const p = this._connect(name, s);
    this._connecting.set(name, p);
    const done = () => { if (this._connecting.get(name) === p) this._connecting.delete(name); };
    p.then(done, done);
    return p;
  }
  async _connect(name, s) {
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
    // Set when the entry carries BOTH url and command (wave15): the url wins
    // below, and that choice is said out loud — on the entry, in the log, and
    // in the failure message — instead of the command being silently ignored.
    let urlNote = '';
    try {
      // A direct connect() with a non-object entry (hub.start() pre-filters
      // these, but /mcp's toggle path connects directly) must fail with the
      // named config error, not a TypeError from reading ".env" of null.
      if (!isBag(s)) throw invalidEntryError(name);
      // A $secret reference the vault no longer has must not reach the server as an
      // empty string (audit #233): fail here, where the reason can be said plainly.
      const missing = missingSecrets(name);
      if (missing.length) throw new Error(t('秘密情報が安全な保管場所に見つかりませんでした: {missing}。空の値ではサーバーを起動しませんでした。秘密情報を保存し直すには、設定を保存し直してください。', {missing: missing.join(', ')}));
      // Shape (deep c14 #5): validate here too — a config that never went
      // through save() (hand-edited, or straight from discover()) reaches this
      // point directly, and a string "args" used to hang the SDK for the full
      // connect timeout instead of saying what is wrong.
      const env = stringBag(name, 'env', s.env), headers = stringBag(name, 'headers', s.headers);
      if (s.args !== undefined && s.args !== null && (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string')))
        throw new Error('Invalid MCP server config for "' + name + '": "args" must be an array of strings.');
      // Noted with the vault rule, not the plaintext one: this env is about to
      // be handed to a live server, whose stderr / errors / results echo it —
      // the exact path a token-shaped value under an ordinary key leaked by.
      for (const [k, v] of Object.entries(env)) noteVaultSecret(v, k);
      for (const [k, v] of Object.entries(headers)) noteVaultSecret(v, k);
      if (s.url && s.command) {
        urlNote = t('url と command の両方が設定されているため、url を優先して接続します');
        entry.warning = urlNote;
        this._log(name + ': ' + urlNote);
      }
      const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
      let transport;
      if (s.type === 'sse') {
        // Legacy SSE servers speak a different handshake (GET stream + endpoint
        // event for POSTs); StreamableHTTP cannot initialize against them, so
        // type:'sse' needs the SDK's SSE transport (deep c14 #3). Its
        // requestInit headers are merged into both the stream GET and the POSTs.
        const {SSEClientTransport} = require('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(checkRemoteUrl(s.url), {requestInit: {headers}});
      } else if (s.url || s.type === 'http') {
        const {StreamableHTTPClientTransport} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(checkRemoteUrl(s.url), {requestInit: {headers}});
      } else {
        if (typeof s.command !== 'string' || !s.command) throw new Error('Invalid MCP server config for "' + name + '": "command" must be a non-empty string for a stdio server.');
        // A cwd that does not exist makes spawn fail with a bare ENOENT that
        // reads as if the COMMAND were missing (wave15): check it here, where
        // the failure can name the cwd and its path for what they are.
        if (s.cwd !== undefined && s.cwd !== null && s.cwd !== '') {
          let isDir = false;
          try { isDir = typeof s.cwd === 'string' && fs.statSync(s.cwd).isDirectory(); } catch { isDir = false; }
          if (!isDir) throw new Error(t('作業フォルダー (cwd) が見つかりません: {cwd}', {cwd: String(s.cwd)}));
        }
        const {StdioClientTransport, getDefaultEnvironment} = require('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({command: s.command, args: s.args || [], env: {...getDefaultEnvironment(), ...env}, cwd: s.cwd, stderr: 'pipe'});
        // Keep the server's stderr (bounded tail) so startup failures are diagnosable.
        const errStream = transport.stderr;
        if (errStream) errStream.on('data', d => { entry.stderrTail = (entry.stderrTail + d.toString()).slice(-2000); });
        // Record how the child process ends (wave15): a server that exits at
        // once surfaced only as 'Connection closed', with no sign of its exit
        // code. The transport owns the process and nulls its handle on close,
        // so hook start() and attach to the process the moment it exists;
        // prepend so the record lands before the close propagates.
        try {
          const startOrig = transport.start.bind(transport);
          transport.start = async (...a) => {
            const started = startOrig(...a);
            const proc = transport._process;
            if (proc && typeof proc.on === 'function') {
              const rec = (code, signal) => { entry.exitCode = code; entry.exitSignal = signal; };
              if (typeof proc.prependListener === 'function') proc.prependListener('close', rec); else proc.on('close', rec);
            }
            return started;
          };
        } catch {}
      }
      client = new Client({name: 'muser', version: require('../package.json').version});
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT, t('接続がタイムアウトしました'));
      if (stale()) { try { await client.close(); } catch {} return; }
      const tools = await listAllTools(client, stale);
      if (tools === null) { try { await client.close(); } catch {} return; } // went stale mid-listing
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
      // Say how the process ended when that is known (wave15), and repeat the
      // url-over-command choice on the failure itself, not only in the log.
      let extra = '';
      if (entry.exitCode !== undefined && entry.exitCode !== null) extra += '\n' + t('サーバープロセスが終了コード {code} で終了しました', {code: entry.exitCode});
      else if (entry.exitSignal) extra += '\n' + t('サーバープロセスがシグナル {signal} で終了しました', {signal: entry.exitSignal});
      if (urlNote) extra += '\n' + urlNote;
      const msg = redact(e.message + extra + (tail ? '\n[stderr] ' + tail : ''));
      if (!stale()) Object.assign(entry, {status: 'error', error: msg});
      try { await client?.close(); } catch {}
      throw new Error(msg);
    }
  }
  async disconnect(name) { this.gens.set(name, (this.gens.get(name) || 0) + 1); const e = this.servers.get(name); if (!e) return; this.servers.delete(name); this.index(); try { await e.client?.close(); } catch {} }
  async close() { this.started = false; if (activeHub === this) activeHub = null; await Promise.all([...this.servers.keys()].map(n => this.disconnect(n))); this.index(); }
  index() {
    // Build the new index on the side and swap it in only when it is complete
    // (deep c14 #7): this used to clear() first and rebuild in place, so one
    // tool whose schema made params() throw left every server's commands
    // gone or half-registered. A single unusable tool is now skipped and the
    // previous index survives a failure anywhere else in the rebuild.
    const built = new Map();
    const used = new Set();
    // Allocate command keys deterministically: iterating the servers Map in insertion
    // order made slug-collision suffixes (-2, -3, ...) depend on connect order, so a
    // reconnect (delete + set moves a server to the end) swapped which server owned the
    // unsuffixed key. Sorting servers and tools by name (codepoint order, not locale)
    // keeps the assignment stable across reconnects and restarts.
    const byName = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    const entries = [...this.servers.values()].sort((x, y) => byName(x.name, y.name));
    for (const e of entries) for (const t of (Array.isArray(e.tools) ? e.tools : []).filter(x => x && typeof x === 'object').sort((x, y) => byName(x.name, y.name))) {
      let p;
      try { p = params(t.inputSchema); } catch { continue; } // one broken tool must not take the others down
      let key = 'mcp.' + slug(e.name) + '.' + slug(t.name);
      // Distinct servers/tools can slug to the same command name; suffix instead of overwriting.
      if (used.has(key)) { let n = 2; while (used.has(key + '-' + n)) n++; key = key + '-' + n; }
      used.add(key);
      built.set(key, {server: e.name, tool: t.name, json: p.json, types: p.types,
        // Fourth audit M6, the mcp.js part: the readOnly flag stored here is the
        // server's own annotation. A tool that ALSO declares itself destructive
        // contradicts its read-only claim, so the claim is not recorded — the
        // (separate, opt-in) trust decision in agent.js then has nothing to trust.
        readOnly: t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true,
        def: {description: ('[MCP ' + e.name + '] ' + (t.description || t.name)).slice(0, 1500), required: p.required, optional: p.optional, timeout_ms: CALL_TIMEOUT + 5000}});
    }
    this.commands.clear();
    for (const [k, v] of built) this.commands.set(k, v);
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
      const bad = () => ({isError: true, text: redact('Invalid argument "' + k + '" for MCP tool ' + c.tool + ': expected ' + t + ', got ' + JSON.stringify(v)?.slice(0, 120))});
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
    // Both directions of a tool call pass through redact() (deep c14 #4): a
    // server that echoes its own credentials in an error or a result used to
    // hand them verbatim to the agent and the logs, while every connect-path
    // error was already redacted.
    let r;
    try { r = await e.client.callTool({name: c.tool, arguments: args}, undefined, {signal, timeout: CALL_TIMEOUT}); }
    catch (err) { throw new Error(redact(err?.message || String(err))); }
    // Keep every content block visible: non-text blocks become placeholder lines
    // instead of being dropped, and structuredContent is appended as a JSON block
    // even when text content is also present.
    const parts = (r.content || []).map(x => {
      if (!x || typeof x !== 'object') return '[unknown content]';
      if (x.type === 'text') return x.text ?? '';
      if (x.type === 'image') return '[image content]';
      if (x.type === 'audio') return '[audio content]';
      if (x.type === 'resource') return '[resource: ' + (x.resource?.uri || 'unknown') + ']' + (typeof x.resource?.text === 'string' ? '\n' + x.resource.text : '');
      if (x.type === 'resource_link') return '[resource: ' + (x.uri || 'unknown') + ']';
      return '[' + x.type + ' content]';
    });
    if (r.structuredContent !== undefined && r.structuredContent !== null) parts.push(JSON.stringify(r.structuredContent));
    let text = redact(parts.join('\n'));
    if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + '\n… (truncated)';
    return {isError: !!r.isError, text};
  }
}

function withTimeout(p, ms, msg) { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); }

module.exports = {McpHub, load, save, discover, importServers, setEnabled, FILE, redact, params, checkRemoteUrl, missingSecrets, listAllTools, configError};
