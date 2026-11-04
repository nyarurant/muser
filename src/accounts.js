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
// Entries readRegistry cannot use (an invalid id, a missing label — a hand edit or a restore
// merge) and top-level keys it does not know (a newer muser's fields) are not the reader's to
// throw away: they ride along on the parsed registry (fourth audit M21) and writeRegistry puts
// them back untouched, so a routine change like setActive no longer purges them silently with
// no backup. list()/get()/resolve() only ever see the valid entries.
function parseRegistry(v) {
  const valid = [], invalid = [];
  for (const a of v.accounts) (a && validId(a.id) && typeof a.label === 'string' ? valid : invalid).push(a);
  const extra = {};
  for (const k of Object.keys(v)) if (k !== 'accounts' && k !== 'activeId') extra[k] = v[k];
  return {accounts: valid, activeId: typeof v.activeId === 'string' ? v.activeId : null, _preservedInvalid: invalid, _preservedExtra: extra};
}
function emptyRegistry() { return {accounts: [], activeId: null, _preservedInvalid: [], _preservedExtra: {}}; }
function readRegistry({strict = false} = {}) {
  for (let i = 0; ; i++) {
    let raw;
    try { raw = fs.readFileSync(registryFile(), 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return emptyRegistry();
      if (i < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1)); continue; }
      if (!strict && lastGood) return structuredClone(lastGood);
      // First audit #20: with no last good registry to fall back to, an unreadable file is NOT
      // an empty registry. Returning empty made a fresh window silently run on the default
      // account and report real account names as not found, so surface the failure instead.
      throw e;
    }
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && Array.isArray(v.accounts)) {
        lastGood = parseRegistry(v);
        return structuredClone(lastGood);
      }
    } catch {}
    // Not a registry (a hand edit gone wrong): a change must not replace it with an empty one,
    // and a plain read must not call it empty either when this process has already read a good
    // one — a window that took corrupt for empty silently ran on the default account and
    // reported real account names as not found (audit #39). With no good read yet, the first
    // audit's #20 applies: throw, naming the file, rather than pretend there are no accounts.
    if (!strict && lastGood) return structuredClone(lastGood);
    throw new Error(t('アカウントの一覧 {file} を読めませんでした。中身を確認してください。', {file: registryFile()}));
  }
}
// Every change is read-modify-write of the one registry file, possibly from several processes at
// once (`muser account use`, add, remove). Unlocked, a setActive landing between
// `muser account add`'s read and write dropped the account just added.
// afterWrite, when given, still runs inside the lock after the registry write (remove()
// deletes the account's files there, so a same-name add cannot complete in between and have
// its fresh files deleted by the pending removal — deep audit c25 #3).
function changeRegistry(fn, afterWrite) {
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
    if (afterWrite) afterWrite();
    return out;
  });
}
// config.withLock goes ahead WITHOUT the lock after 2 s, or at once on any error but EEXIST —
// and Windows answers EPERM while the previous holder's lock file is being deleted. With four
// processes changing the registry, adds were still lost that way. The registry is changed rarely
// and briefly: wait longer, retry those errors, and never change it unlocked.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
function withRegistryLock(fn) {
  // The lock file carries the holder's pid next to the token (the sessions.js pattern): a lock
  // whose holder is still alive is never stolen, however long it is held, and a dead holder's
  // lock — or a legacy token-only lock over 10 s old — is claimed by atomically renaming it
  // away, so of two waiters who both judge it stale only one wins the rename and proceeds.
  // The old code unlinked whatever sat at the lock path after a bare stat, with no check that
  // it was still the file it had judged stale: the second waiter deleted the first stealer's
  // fresh lock and both believed they held it (deep audit c25 #2).
  const lock = registryFile() + '.lock', token = crypto.randomBytes(16).toString('hex') + ':' + process.pid, until = Date.now() + 10000;
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      try {
        const held = fs.readFileSync(lock, 'utf8');
        const ownerPid = Number((held.split(':')[1] || '').trim());
        const stale = ownerPid > 0 ? !pidAlive(ownerPid) : Date.now() - fs.statSync(lock).mtimeMs > 10000;
        if (stale) {
          const grave = lock + '.stale-' + crypto.randomBytes(6).toString('hex');
          let claimed = true;
          try { fs.renameSync(lock, grave); } catch { claimed = false; } // another waiter claimed it first
          if (claimed) { try { fs.unlinkSync(grave); } catch {} continue; }
        }
      } catch {}
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
  // The preserved entries/keys ride back out (fourth audit M21): the file keeps everything
  // readRegistry could not use, in case a hand edit or a newer muser put it there on purpose.
  const out = {...(reg._preservedExtra || {}), accounts: [...reg.accounts, ...(reg._preservedInvalid || [])], activeId: reg.activeId ?? null};
  try { fs.writeFileSync(temp, JSON.stringify(out, null, 2)); store.renameRetry(temp, f); lastGood = structuredClone({accounts: reg.accounts, activeId: out.activeId, _preservedInvalid: reg._preservedInvalid || [], _preservedExtra: reg._preservedExtra || {}}); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

// The default account is always there: it is the login every install before multi-account
// support already had. Registry entries for it only override its label.
function listFrom(reg) {
  const named = reg.accounts.find(a => a.id === DEFAULT_ID);
  const out = [{id: DEFAULT_ID, label: named?.label || 'default', createdAt: named?.createdAt || null}];
  for (const a of reg.accounts) if (a.id !== DEFAULT_ID) out.push({id: a.id, label: a.label, createdAt: a.createdAt || null});
  return out;
}
function list() { return listFrom(readRegistry()); }
function get(id) { return list().find(a => a.id === id) || null; }
// By id, by exact label, or by an unambiguous prefix of either.
function resolve(ref) {
  const all = list(), r = String(ref || '').trim().toLowerCase();
  if (!r) return null;
  // An exact match is held to the same standard as a prefix one (fourth audit M20): when two
  // accounts carry the exact label asked for (a hand-edited or merged registry — add() blocks
  // it in normal use), the first one used to win silently and work went to whichever Muse
  // happened to be listed first. Ambiguous is ambiguous: no match.
  const exacts = all.filter(a => a.id === r || a.label.toLowerCase() === r);
  if (exacts.length === 1) return exacts[0];
  if (exacts.length > 1) return null;
  const hits = all.filter(a => a.id.startsWith(r) || a.label.toLowerCase().startsWith(r));
  return hits.length === 1 ? hits[0] : null;
}
function activeId() {
  // One read, one snapshot (fourth audit M9): this used to read the registry twice — once
  // here, once inside get() — so a switch landing between the two reads was answered from a
  // mix of both registries (the old activeId, already removed, fell back to 'default'
  // although neither snapshot ever had the default account active).
  const reg = readRegistry();
  return reg.activeId && listFrom(reg).some(a => a.id === reg.activeId) ? reg.activeId : DEFAULT_ID;
}
function setActive(id) {
  // The existence check happens INSIDE the registry lock (deep audit c25 #1), like add()'s
  // and rename()'s since audits #37/#38: checked outside, a remove() landing in between was
  // undone by the locked change writing activeId back for an account that no longer exists —
  // "switch succeeded", but the id silently fell back to the default account (and a later
  // re-add of the same id suddenly became the active account).
  changeRegistry(reg => {
    if (id !== DEFAULT_ID && !reg.accounts.some(a => a.id === id)) throw new Error(t('アカウントが見つかりません: {id}', {id}));
    reg.activeId = id;
  });
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
  // The existence check, the registry change and the file deletion all happen under ONE lock
  // hold (deep audit c25 #3): the check used to sit outside the lock (the setActive pattern of
  // c25 #1), and the files were deleted after the lock was released, so a same-name add that
  // completed in between — registry entry plus a fresh login's files — could have those files
  // deleted by this pending removal. A lock that times out now changes nothing at all, so
  // removing again simply works.
  let leftover = null;
  const leftoverFiles = [];
  changeRegistry(reg => {
    if (!reg.accounts.some(a => a.id === id)) throw new Error(t('アカウントが見つかりません: {id}', {id}));
    reg.accounts = reg.accounts.filter(a => a.id !== id);
    if (reg.activeId === id) reg.activeId = DEFAULT_ID;
  }, () => {
    const files = filesFor(id);
    // store.remove swallows every unlink error, so each secret file's deletion is verified
    // here and retried once directly; whatever still exists is reported by path instead of
    // silently staying behind for a same-name re-add to inherit (c25 #3).
    const secretPaths = [files.web, files.session, files.device].map(name => store.file(name));
    for (const name of [files.web, files.session, files.device]) store.remove(name);
    for (const p of secretPaths) {
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
      if (fs.existsSync(p)) leftoverFiles.push(p);
    }
    // The folder holds the account's Edge profile, still logged in to muse.ai. Left behind (Edge
    // open on it), a new account of the same name got the same folder and came back logged in to
    // the removed account. Returned so the caller can say so.
    try { fs.rmSync(path.dirname(files.browser), {recursive: true, force: true}); } catch {}
    if (fs.existsSync(path.dirname(files.browser))) leftover = path.dirname(files.browser);
    // The folder removal may have finished off a secret file the direct retry could not.
    for (let i = leftoverFiles.length - 1; i >= 0; i--) if (!fs.existsSync(leftoverFiles[i])) leftoverFiles.splice(i, 1);
    if (!leftover && leftoverFiles.length) leftover = path.dirname(leftoverFiles[0]);
  });
  // Its Muse's name is not needed any more either. (Outside the lock: updateIdentity takes
  // the registry lock itself.)
  try { updateIdentity(v => { if (!v.byAccount?.[id]) return false; delete v.byAccount[id]; }); } catch {}
  return {leftover, leftoverFiles};
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
  withRegistryLock(token => {
    // identity.json is replaced by the same atomic rename as the registry, so its read gets
    // the same transient-error retries readRegistry has (deep audit c25 #4): one EPERM while
    // another window's rename lands used to abandon the update silently — the Muse name or
    // the /usage record was simply never saved, and nothing anywhere said so. A file that
    // exists but does not parse is still left alone, exactly as before.
    let v = {}, exists = false, raw = null;
    for (let i = 0; ; i++) {
      try { raw = fs.readFileSync(nameFile(), 'utf8'); break; }
      catch (e) {
        if (e?.code === 'ENOENT') { raw = null; break; }
        if (i < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1)); continue; }
        return;
      }
    }
    if (raw !== null) {
      exists = true;
      try { v = JSON.parse(raw); } catch { return; }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { if (exists) return; v = {}; }
    if (fn(v) === false) return;
    // Fencing, like changeRegistry (audit #40): a holder paused past the steal threshold
    // until its lock was taken must not write over the thief's identity update when it wakes
    // (deep audit c25 #2). Ownership is re-checked immediately before the write; losing the
    // lock abandons this update (the remember* callers retry on their next call).
    let owned = false;
    try { owned = fs.readFileSync(registryFile() + '.lock', 'utf8') === token; } catch {}
    if (!owned) throw new Error(t('アカウントの一覧が使用中のため変更できませんでした。もう一度実行してください。'));
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
