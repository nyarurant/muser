'use strict';
// Multiple Muse accounts, one pool. Every account keeps its own website login (web.enc),
// gateway credentials (session.enc), PC device registration (device.enc) and Edge profile:
// they belong to different muse.ai users (different VMs), so sharing any one of them across
// accounts is what used to break a window after an account switch (it grabbed the previous
// account's VM). The FIRST account ('default') keeps the historic flat file layout, so an
// existing install migrates by doing nothing at all; later accounts live under accounts/<id>/.
// This module is metadata and the selection policy only — no network, no decryption of other
// accounts' files beyond an existence check. The registry is plain JSON (labels and ids are
// not secrets) in the secure-store folder.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./secure-store');
const {t} = require('./i18n');

const DEFAULT_ID = 'default';

function registryFile() { return store.file('accounts.json'); }

function validId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id); }

function slug(label) {
  const s = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'account-' + crypto.randomBytes(2).toString('hex');
}

// Only a missing file is "no accounts yet". Windows refuses a read for a moment while another
// window renames the new registry over it (EPERM, reproduced with four processes at once); read
// as empty, the locked change below then wrote that emptiness back and every added account was
// gone. Such a read is retried, then the last good registry of this process is used, and a
// change gives up (throws) rather than write over a registry it could not read.
let lastGood = null;
function readRegistry({strict = false} = {}) {
  for (let i = 0; ; i++) {
    let raw;
    try { raw = fs.readFileSync(registryFile(), 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return {accounts: [], activeId: null};
      if (i < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1)); continue; }
      if (!strict && lastGood) return structuredClone(lastGood);
      if (strict) throw e;
      return {accounts: [], activeId: null};
    }
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && Array.isArray(v.accounts)) {
        lastGood = {accounts: v.accounts.filter(a => a && validId(a.id) && typeof a.label === 'string'), activeId: typeof v.activeId === 'string' ? v.activeId : null};
        return structuredClone(lastGood);
      }
    } catch {}
    // Not a registry (a hand edit gone wrong): a change must not replace it with an empty one,
    // and a plain read must not call it empty either when this process has already read a good
    // one — a window that took corrupt for empty silently ran on the default account and
    // reported real account names as not found (audit #39).
    if (!strict && lastGood) return structuredClone(lastGood);
    if (strict) throw new Error(t('アカウントの一覧 {file} を読めませんでした。中身を確認してください。', {file: registryFile()}));
    return {accounts: [], activeId: null};
  }
}
// Every change is read-modify-write of the one registry file, possibly from several processes at
// once (`muser account use`, add, remove). Unlocked, a setActive landing between
// `muser account add`'s read and write dropped the account just added.
function changeRegistry(fn) {
  return withRegistryLock(token => {
    const reg = readRegistry({strict: true});
    const out = fn(reg);
    // Fencing (audit #40): a holder paused past the 10 s steal threshold must not write over
    // the thief's change when it resumes. The token check at unlock only stopped it deleting
    // the thief's lock, not this write, so ownership is re-checked immediately before it.
    let owned = false;
    try { owned = fs.readFileSync(registryFile() + '.lock', 'utf8') === token; } catch {}
    if (!owned) throw new Error(t('アカウントの一覧が使用中のため変更できませんでした。もう一度実行してください。'));
    writeRegistry(reg);
    return out;
  });
}
// config.withLock goes ahead WITHOUT the lock after 2 s, or at once on any error but EEXIST —
// and Windows answers EPERM while the previous holder's lock file is being deleted. With four
// processes changing the registry, adds were still lost that way. The registry is changed rarely
// and briefly: wait longer, retry those errors, and never change it unlocked.
function withRegistryLock(fn) {
  const lock = registryFile() + '.lock', token = crypto.randomBytes(16).toString('hex'), until = Date.now() + 10000;
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() > until) throw new Error(t('アカウントの一覧が使用中のため変更できませんでした。もう一度実行してください。'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(token); } finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {} }
}
function writeRegistry(reg) {
  const f = registryFile();
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const temp = f + '.tmp-' + process.pid + '-' + Date.now();
  try { fs.writeFileSync(temp, JSON.stringify(reg, null, 2)); store.renameRetry(temp, f); lastGood = structuredClone(reg); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

// The default account is always there: it is the login every install before multi-account
// support already had. Registry entries for it only override its label.
function list() {
  const reg = readRegistry();
  const named = reg.accounts.find(a => a.id === DEFAULT_ID);
  const out = [{id: DEFAULT_ID, label: named?.label || 'default', createdAt: named?.createdAt || null}];
  for (const a of reg.accounts) if (a.id !== DEFAULT_ID) out.push({id: a.id, label: a.label, createdAt: a.createdAt || null});
  return out;
}
function get(id) { return list().find(a => a.id === id) || null; }
// By id, by exact label, or by an unambiguous prefix of either.
function resolve(ref) {
  const all = list(), r = String(ref || '').trim().toLowerCase();
  if (!r) return null;
  const exact = all.find(a => a.id === r || a.label.toLowerCase() === r);
  if (exact) return exact;
  const hits = all.filter(a => a.id.startsWith(r) || a.label.toLowerCase().startsWith(r));
  return hits.length === 1 ? hits[0] : null;
}
function activeId() {
  const reg = readRegistry();
  return reg.activeId && get(reg.activeId) ? reg.activeId : DEFAULT_ID;
}
function setActive(id) {
  if (!get(id)) throw new Error(t('アカウントが見つかりません: {id}', {id}));
  changeRegistry(reg => { reg.activeId = id; });
}
function add(label) {
  const name = String(label || '').trim();
  if (!name) throw new Error(t('アカウント名を入力してください。'));
  // The duplicate check and the id generation happen INSIDE the registry lock (audit #37):
  // checked outside, two processes adding at once both passed, both took the same slug id,
  // and one remove() then deleted both registrations (they share one files folder).
  let created = null;
  changeRegistry(reg => {
    const namedDefault = reg.accounts.find(a => a.id === DEFAULT_ID)?.label || 'default';
    if (namedDefault.toLowerCase() === name.toLowerCase() || reg.accounts.some(a => a.label.toLowerCase() === name.toLowerCase()))
      throw new Error(t('その名前のアカウントは既にあります: {label}', {label: name}));
    let id = slug(name);
    // The suffix fits inside validId's 40 characters: a 36+ character slug plus '-xxxx' was an
    // invalid id that readRegistry dropped, so the account vanished right after being added.
    const taken = new Set([DEFAULT_ID, ...reg.accounts.map(a => a.id)]);
    while (taken.has(id)) id = slug(name).slice(0, 35).replace(/-+$/, '') + '-' + crypto.randomBytes(2).toString('hex');
    created = {id, label: name, createdAt: new Date().toISOString()};
    reg.accounts.push(created);
  });
  return get(created.id);
}
function rename(id, label) {
  const name = String(label || '').trim();
  if (!name) throw new Error(t('アカウント名を入力してください。'));
  // Existence and the duplicate-label check happen INSIDE the registry lock (audit #38):
  // checked outside, a remove() landing in between was undone by the fallback push below,
  // resurrecting the deleted account as an empty registration. That push is legitimate
  // only for the default account, whose registry entry is just a label override.
  changeRegistry(reg => {
    const found = reg.accounts.find(a => a.id === id);
    if (!found && id !== DEFAULT_ID) throw new Error(t('アカウントが見つかりません: {id}', {id}));
    // Two accounts with one label made `--account <name>` pick whichever came first.
    const others = reg.accounts.filter(a => a.id !== id);
    if (id !== DEFAULT_ID) others.push({id: DEFAULT_ID, label: reg.accounts.find(a => a.id === DEFAULT_ID)?.label || 'default'});
    if (others.some(a => a.label.toLowerCase() === name.toLowerCase())) throw new Error(t('その名前のアカウントは既にあります: {label}', {label: name}));
    if (found) found.label = name; else reg.accounts.push({id, label: name, createdAt: new Date().toISOString()});
  });
  return get(id);
}
// The store names / folders one account's secrets and browser profile live in.
function filesFor(id) {
  if (id === DEFAULT_ID) return {web: 'web.enc', session: 'session.enc', device: 'device.enc', browser: store.file('browser')};
  const base = 'accounts/' + id;
  return {web: base + '/web.enc', session: base + '/session.enc', device: base + '/device.enc', browser: store.file(base + '/browser')};
}
function hasLogin(id) { try { return fs.existsSync(store.file(filesFor(id).web)); } catch { return false; } }
function hasDevice(id) { try { return fs.existsSync(store.file(filesFor(id).device)); } catch { return false; } }
function remove(id) {
  if (id === DEFAULT_ID) throw new Error(t('最初のアカウントは削除できません（ログアウトは `muser logout` です）。'));
  if (!get(id)) throw new Error(t('アカウントが見つかりません: {id}', {id}));
  // Out of the registry first: a lock that times out then leaves the files (removing it again
  // works), not a listed account with nothing behind it that blocks adding the name again.
  changeRegistry(reg => {
    reg.accounts = reg.accounts.filter(a => a.id !== id);
    if (reg.activeId === id) reg.activeId = DEFAULT_ID;
  });
  const files = filesFor(id);
  for (const name of [files.web, files.session, files.device]) store.remove(name);
  // The folder holds the account's Edge profile, still logged in to muse.ai. Left behind (Edge
  // open on it), a new account of the same name got the same folder and came back logged in to
  // the removed account. Returned so the caller can say so.
  let leftover = null;
  try { fs.rmSync(path.dirname(files.browser), {recursive: true, force: true}); } catch {}
  if (fs.existsSync(path.dirname(files.browser))) leftover = path.dirname(files.browser);
  // Its Muse's name is not needed any more either.
  try { updateIdentity(v => { if (!v.byAccount?.[id]) return false; delete v.byAccount[id]; }); } catch {}
  return {leftover};
}

// The name of each account's Muse, as last seen, so a window shows it before /identity answers.
// One shared name showed the other account's Muse after a switch or on a window started on
// another account. The old {name} (the first account's) is kept as that account's.
function nameFile() { return store.file('identity.json'); }
function museName(id = DEFAULT_ID) {
  try {
    const v = JSON.parse(fs.readFileSync(nameFile(), 'utf8'));
    return v?.byAccount?.[id] || (id === DEFAULT_ID ? v?.name : null) || 'Muse';
  } catch { return 'Muse'; }
}
// identity.json updates go through the registry lock and an atomic rename (audit #41):
// unlocked and written in place, two windows remembering names at once lost one update,
// and a crash mid-write left a truncated file whose next remember() then replaced every
// account's name with just its own. A file that exists but cannot be read is left alone
// rather than clobbered, for the same reason readRegistry refuses to overwrite one.
function writeIdentity(v) {
  const f = nameFile();
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const temp = f + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  try { fs.writeFileSync(temp, JSON.stringify(v)); store.renameRetry(temp, f); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
function updateIdentity(fn) {
  withRegistryLock(() => {
    let v = {}, exists = false;
    try { v = JSON.parse(fs.readFileSync(nameFile(), 'utf8')) || {}; exists = true; } catch (e) { if (e?.code !== 'ENOENT') return; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { if (exists) return; v = {}; }
    if (fn(v) === false) return;
    writeIdentity(v);
  });
}
function rememberMuseName(id = DEFAULT_ID, name) {
  if (!name) return;
  try {
    updateIdentity(v => {
      v.byAccount = {...(v.byAccount || {}), [id]: name};
      if (id === DEFAULT_ID) v.name = name;
    });
  } catch {}
}

// "/usage on" is a chat command on Muse's side: with it, every reply carries
// the real token counts (src/turn-usage.js). muser sends it itself, once per
// account; this record — when the command was last sent, on which scratch
// session, and when counts were last actually seen — keeps a working account
// from being asked again and lets an account that stops sending counts (it
// was switched off on the web, say) be retried. Same file and lock as the
// Muse names above.
function usageCmd(id = DEFAULT_ID) {
  try {
    const v = JSON.parse(fs.readFileSync(nameFile(), 'utf8'));
    const r = v?.usageCmd?.[id];
    return r && typeof r === 'object' ? r : null;
  } catch { return null; }
}
function rememberUsageCmd(id = DEFAULT_ID, patch) {
  try {
    updateIdentity(v => {
      v.usageCmd = {...(v.usageCmd || {}), [id]: {...(v.usageCmd?.[id] || {}), ...patch}};
    });
  } catch {}
}
function rememberUsageCmdSent(id = DEFAULT_ID, session) { rememberUsageCmd(id, {sent: Date.now(), ...(session ? {session} : {})}); }
function rememberUsageSeen(id = DEFAULT_ID) { rememberUsageCmd(id, {seen: Date.now()}); }

// ---- Selection policy (pure; tested) ----
// An account is exhausted when its plan says the quota is not SUFFICIENT, or its weekly use
// reached the threshold (config accountThreshold / env MUSER_ACCOUNT_THRESHOLD, default 100%).
function threshold() {
  const env = Number(process.env.MUSER_ACCOUNT_THRESHOLD);
  if (Number.isFinite(env) && env > 0 && env <= 100) return env;
  try { const v = Number(require('./config').read().accountThreshold); if (Number.isFinite(v) && v > 0 && v <= 100) return v; } catch {}
  return 100;
}
function exhausted(c, at = threshold()) {
  if (!c) return true;
  if (typeof c.percentUsed === 'number' && c.percentUsed >= at) return true;
  if (c.quotaStatus && c.quotaStatus !== 'SUFFICIENT') return true;
  return false;
}
// Rank: available beats not, alive beats exhausted, then lowest weekly use. An unknown use
// (the plan could not be read) ranks below every known one but above exhausted: not knowing
// is not a reason to declare an account dead.
function score(c) { return typeof c.percentUsed === 'number' ? c.percentUsed : Number.POSITIVE_INFINITY; }
function rank(list) {
  return [...list].sort((a, b) => score(a) - score(b));
}
// Audit #47 (runtime half): two accounts logged in to the same Muse VM share ONE
// weekly allowance — statuses() tags each status with its vm. Collapse every vm
// group to a single candidate before the policy runs: the representative is the
// current account when it belongs to the group (stickiness survives), else the
// best-ranked member, and the group speaks with its most-exhausted reading, so a
// stale low reading on one duplicate cannot make a used-up VM look light.
// Candidates without a vm (unknown) are never grouped.
function collapseVm(pool, currentId) {
  const groups = new Map();
  for (const c of pool) {
    if (!c.vm) continue;
    const g = groups.get(c.vm);
    if (g) g.push(c); else groups.set(c.vm, [c]);
  }
  if (![...groups.values()].some(g => g.length > 1)) return pool;
  const out = [], emitted = new Set();
  for (const c of pool) {
    if (!c.vm) { out.push(c); continue; }
    if (emitted.has(c.vm)) continue;
    emitted.add(c.vm);
    const g = groups.get(c.vm);
    if (g.length === 1) { out.push(c); continue; }
    const rep = g.find(x => x.id === currentId) || rank(g)[0];
    const known = g.map(x => x.percentUsed).filter(v => typeof v === 'number');
    const worstStatus = g.map(x => x.quotaStatus).find(q => q && q !== 'SUFFICIENT') || rep.quotaStatus;
    out.push({...rep, percentUsed: known.length ? Math.max(...known) : rep.percentUsed, quotaStatus: worstStatus});
  }
  return out;
}
// choose(candidates, {currentId, fresh, margin}) -> {id, reason} | null.
// candidates: [{id, available, percentUsed|null, quotaStatus, vm?}].
// Stickiness is deliberate: a running conversation lives on ONE account's Muse (its chat
// history is there, not here), so the current account is kept unless it is exhausted or
// unavailable — or, at a fresh start only, another account is lighter by `margin` points.
function choose(candidates, {currentId = null, fresh = false, margin = 20, at} = {}) {
  const pool = collapseVm((candidates || []).filter(c => c && c.available), currentId);
  if (!pool.length) return null;
  const alive = pool.filter(c => !exhausted(c, at));
  const current = pool.find(c => c.id === currentId) || null;
  if (current && alive.includes(current)) {
    if (fresh && alive.length > 1) {
      const best = rank(alive)[0];
      // An unknown use scores Infinity (audit #43): with EVERY plan read failed, best and
      // current were both Infinity and Infinity + margin <= Infinity silently "proved"
      // an arbitrary other account the lightest. Only a KNOWN best may win by margin —
      // a known best still beats an unknown current, which ranking already intends.
      if (best.id !== current.id && Number.isFinite(score(best)) && score(best) + margin <= score(current)) return {id: best.id, reason: 'least-used'};
    }
    return {id: current.id, reason: 'keep-current'};
  }
  const usable = alive.length ? alive : pool;
  const best = rank(usable)[0];
  if (!best) return null;
  // A named current that cannot be used (exhausted, or not even in the available pool) is a
  // failover, not a fresh pick.
  const hadCurrent = currentId != null && (candidates || []).some(c => c && c.id === currentId);
  return {id: best.id, reason: !alive.length ? 'all-exhausted' : hadCurrent ? 'failover' : 'least-used'};
}

module.exports = {DEFAULT_ID, list, get, resolve, add, rename, remove, activeId, setActive, filesFor, hasLogin, hasDevice, threshold, exhausted, choose, slug, validId, museName, rememberMuseName, usageCmd, rememberUsageCmdSent, rememberUsageSeen};
