'use strict';
// The account pool at runtime: build one account's {web, auth, client} bundle, read every
// account's status (login present? device registered? weekly plan), and let src/accounts.js'
// pure policy pick. Automatic selection only runs when more than one account exists and it
// is not switched off (config {"accountAuto": false} or MUSER_NO_ACCOUNT_AUTO=1): a
// single-account install behaves exactly as it always did, with no extra muse.ai calls.
const accounts = require('./accounts');
const store = require('./secure-store');
const {t} = require('./i18n');

function autoEnabled() {
  if (process.env.MUSER_NO_ACCOUNT_AUTO === '1') return false;
  try { if (require('./config').read().accountAuto === false) return false; } catch {}
  return true;
}
function multi() { return accounts.list().length > 1; }

// Every secret file the pool may touch, decrypted in one PowerShell start (secure-store).
function preloadAll() {
  const names = [];
  for (const a of accounts.list()) { const f = accounts.filesFor(a.id); names.push(f.web, f.device, f.session); }
  try { store.preload(names); } catch {}
}

// One account's working set. Nothing connects yet: the client is created unconnected,
// as in bin/muser.js prepare().
function bundle(account) {
  const files = accounts.filesFor(account.id);
  const {createWeb, loadJar} = require('./web');
  const web = createWeb(loadJar(files.web), {file: files.web});
  const auth = require('./pc-login').createAuth(web, {file: files.device});
  const client = require('./session').createChat(web, {file: files.session});
  return {account, files, web, auth, client};
}

// The scratch store file a throwaway web may save refreshed cookies into (audit #44):
// unique per call, removed by the caller's finally, and never the account's real web.enc.
function probeFileFor(webFile) {
  return webFile + '.probe-' + process.pid + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}

// Status per account for the policy and for /account listings. Reading a plan is one
// muse.ai server action per account; failures read as percentUsed: null (unknown),
// never as zero or as exhausted.
async function statuses({plans = true} = {}) {
  preloadAll();
  const usage = require('./usage');
  return Promise.all(accounts.list().map(async a => {
    const files = accounts.filesFor(a.id);
    const {createWeb, loadJar} = require('./web');
    // An account whose web.enc cannot be decrypted (corrupt, another Windows user) is shown as
    // not logged in; it used to reject the whole Promise.all: `muser account`, `muser usage`
    // and the /account picker all failed because of one unused account.
    let jar = [], unreadable = false;
    try { jar = loadJar(files.web); } catch { unreadable = true; }
    // A status read must never SAVE the jar (audit #44): these throwaway webs were bound to
    // the account's real web.enc, so a Set-Cookie absorbed by the plan read wrote this stale
    // snapshot back over the live window's newer jar and a healthy login rolled back to
    // "logged out". The webs below work on a copy whose refreshed cookies land in a scratch
    // store file that is removed afterwards; the account's own web owns persistence.
    const probeFile = probeFileFor(files.web);
    try {
      let device = false;
      try { device = require('./pc-login').createAuth(createWeb([...jar], {file: probeFile}), {file: files.device}).snapshot().phase === 'authenticated'; } catch {}
      let plan = null;
      if (plans && jar.length) { try { plan = await usage.plan(createWeb([...jar], {file: probeFile})); } catch {} }
      // The VM this login belongs to (audit #47): two accounts on the same VM share
      // one allowance, and the selection policy (accounts.choose / the pool's
      // failover exclusions) needs to know. Best effort — a failed read leaves vm
      // null and the account is treated as an allowance of its own, as before.
      let vm = null;
      if (plans && jar.length) { try { vm = (await createWeb([...jar], {file: probeFile}).fetchJson('/api/session'))?.vm_id || null; } catch {} }
      return {id: a.id, label: a.label, available: !!jar.length && device, hasLogin: !!jar.length, device, ...(unreadable ? {unreadable} : {}), vm,
        percentUsed: plan?.percentUsed ?? null, quotaStatus: plan?.quotaStatus ?? null, plan};
    } finally { try { store.remove(probeFile); } catch {} }
  }));
}

// The bundle a window should start on: the policy's pick when the pool is on, the active
// account otherwise. Falls back to the active account when every status read failed, so a
// muse.ai hiccup never blocks a start that would have worked before.
async function initialBundle(preferredId) {
  const active = accounts.get(preferredId || accounts.activeId()) || accounts.list()[0];
  if (!multi() || !autoEnabled()) return {...bundle(active), reason: 'only'};
  const all = await statuses().catch(() => []);
  const pick = accounts.choose(all, {currentId: active.id, fresh: true});
  if (!pick) return {...bundle(active), reason: 'only'};
  const chosen = accounts.get(pick.id) || active;
  // The pick is this window's only: the default account stays what `muser account use` made it.
  return {...bundle(chosen), reason: pick.reason, statuses: all};
}

// The Agent's failover source: next(excludeIds) answers a fresh bundle for the policy's
// pick among the accounts not excluded, or null when there is nowhere to go.
// makePool(opts) lets tests inject the three effectful pieces ({statusesFn, bundleFn,
// connectFn}); with no opts every caller gets the real statuses() / bundle() and a
// connect that connects the bundle's gateway client, exactly as before.
function makePool(opts = {}) {
  const statusesFn = opts.statusesFn || statuses;
  const bundleFn = opts.bundleFn || bundle;
  const connectFn = opts.connectFn || (b => b.client.connect());
  // Warm-standby cache: account id -> bundle whose gateway client is already connected.
  const warmed = new Map();
  // Pool generation (deep audit c24 #2): drop() bumps it, and a warm() that started in an
  // older generation must not cache its bundle when its connect finally lands — drop()
  // has already run (an Agent close, an account switch) and nobody would ever disconnect
  // a bundle resurrected into a dropped pool; next() could even hand it out as "fresh".
  let epoch = 0;
  function disconnectBundle(b) {
    try {
      const r = b && b.client ? b.client.disconnect(false) : null;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }
  // In-flight warm()s by account id, so concurrent warms share one connect (audit #45).
  const warming = new Map();
  // One statuses read serves a whole peek -> warm -> next sequence (audit #46): each used
  // to re-read every plan and re-pick, so the account peek named, the one warm connected
  // and the one next took could all differ, and the plan API was hit once per step.
  // currentStatus() below deliberately still reads fresh.
  const STATUS_TTL_MS = 15000;
  let statusCache = null;
  function readStatuses() {
    if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.promise;
    const promise = (async () => { try { const all = await statusesFn(); return Array.isArray(all) ? all : []; } catch { return []; } })();
    statusCache = {at: Date.now(), promise};
    return promise;
  }
  const excluded = excludeIds => {
    if (!excludeIds) return new Set();
    return typeof excludeIds.has === 'function' ? excludeIds : new Set(excludeIds);
  };
  // A quota move must leave the VM, not just the account (audit #47): when an
  // excluded account is EXHAUSTED, its same-VM duplicates share its allowance and
  // are excluded too. An excluded account that is merely unavailable does NOT
  // spread — failing over to its duplicate is a real gain there (a working login
  // on the same VM) — so only exhaustion spreads.
  function expandVmExclusions(all, skip) {
    for (const s of all) {
      if (!skip.has(s.id) || !s.vm || !accounts.exhausted(s)) continue;
      for (const o of all) if (o.vm === s.vm) skip.add(o.id);
    }
  }
  // The shared choice behind peek() / warm() / next(): the same gating as next() has
  // always had, then the policy's pick among the non-excluded statuses. Returns the
  // chosen STATUS object (not a bundle), or null.
  // alive: only an account with allowance left (no 'all-exhausted' pick).
  async function pickStatus(excludeIds, {alive = false} = {}) {
    if (!multi() || !autoEnabled()) return null;
    const all = await readStatuses();
    const skip = excluded(excludeIds);
    expandVmExclusions(all, skip);
    const rest = all.filter(s => !skip.has(s.id));
    const pick = accounts.choose(rest, {});
    if (!pick || (alive && pick.reason === 'all-exhausted')) return null;
    return {status: rest.find(s => s.id === pick.id) || null, reason: pick.reason};
  }
  function take(id) {
    if (!warmed.has(id)) return null;
    const b = warmed.get(id);
    warmed.delete(id);
    return b;
  }
  function bundleFor(account) {
    return take(account.id) || bundleFn(account);
  }
  return {
    // The account a quota failover would move to (named in the warning before the limit).
    async peek(excludeIds) {
      const picked = await pickStatus(excludeIds, {alive: true});
      return picked ? picked.status : null;
    },
    async warm(excludeIds) {
      const myEpoch = epoch;
      const picked = await pickStatus(excludeIds);
      if (!picked || !picked.status) return null;
      if (myEpoch !== epoch) return null; // dropped while picking: build nothing
      const status = picked.status;
      if (warmed.has(status.id)) return status;
      // Concurrent warms for the same pick share one build+connect (audit #45): both used
      // to connect, and the later warmed.set overwrote the earlier bundle, leaving a
      // connected client nothing could reach or disconnect.
      const pending = warming.get(status.id);
      if (pending) return (await pending) ? status : null;
      let settle;
      const gate = new Promise(resolve => { settle = resolve; });
      warming.set(status.id, gate);
      try {
        // Warming must NOT connect any device — bundleFn only builds {web, auth, client}; connectFn connects the gateway client only.
        const account = accounts.get(status.id) || status;
        const b = bundleFn(account);
        try { await connectFn(b); } catch { settle(false); return null; }
        // Dropped while connecting (c24 #2): the pool this bundle was warmed for is gone.
        // Disconnect what was just connected — leaving it cached leaks the connection,
        // and leaving it connected but uncached leaks it just the same.
        if (myEpoch !== epoch) { disconnectBundle(b); settle(false); return null; }
        b.reason = picked.reason;
        warmed.set(status.id, b);
        settle(true);
        return status;
      } catch { settle(false); return null; }
      finally { warming.delete(status.id); }
    },
    take,
    bundleFor,
    warmedId() {
      for (const id of warmed.keys()) return id;
      return null;
    },
    drop() {
      epoch++; // in-flight warm()s of this generation cache nothing when they land (c24 #2)
      for (const b of warmed.values()) disconnectBundle(b);
      warmed.clear();
    },
    async next(excludeIds, opts) {
      // A bundle warm() already connected for a non-excluded account IS the pick (audit
      // #46): re-picking could choose a different account and strand the warmed connection.
      const skipNext = excluded(excludeIds);
      // The warmed shortcut honours the same VM exclusion as pickStatus (audit #47):
      // a bundle warmed for a duplicate of the exhausted account is not a way out.
      if (warmed.size) expandVmExclusions(await readStatuses(), skipNext);
      for (const id of [...warmed.keys()]) {
        if (skipNext.has(id)) continue;
        // An alive-only pick (a quota failover) must not be handed a warmed bundle whose
        // account is used up: warm() picks without the alive rule, next({alive}) has one.
        if (opts?.alive) {
          const st = (await readStatuses()).find(s => s.id === id);
          if (!st || accounts.exhausted(st)) continue;
        }
        const b = take(id);
        if (b) return b;
      }
      const picked = await pickStatus(excludeIds, opts);
      if (!picked || !picked.status) return null;
      const chosen = accounts.get(picked.status.id) || picked.status;
      const b = bundleFor(chosen);
      if (!b) return null;
      b.reason = picked.reason;
      return b;
    },
    async currentStatus(id) {
      let all;
      try { all = await statusesFn(); } catch { all = []; }
      return (Array.isArray(all) ? all : []).find(s => s.id === id) || null;
    },
    statuses: statusesFn,
  };
}

// Another account logged in to the same muse.ai user as `id` (the same Muse VM), or null.
// vmOf(account) -> vm id is injectable for tests; the real one reads the account's /api/session.
async function sameMuse(id, {vmOf} = {}) {
  vmOf ||= async a => {
    const files = accounts.filesFor(a.id);
    const {createWeb, loadJar} = require('./web');
    const jar = loadJar(files.web);
    if (!jar.length) return null;
    // Deep audit c24 #1: this default vmOf was the one reader statuses() left behind when
    // it moved to a probe file for audit #44 — its web was bound to the account's REAL
    // web.enc, so a Set-Cookie absorbed by the /api/session read saved this call's stale
    // jar snapshot back over a live window's newer jar and rolled a healthy login back to
    // "logged out". Same shape as statuses(): a copy of the jar, a scratch probe file,
    // removed afterwards; the account's own web owns persistence.
    const probeFile = probeFileFor(files.web);
    try { return (await createWeb([...jar], {file: probeFile}).fetchJson('/api/session'))?.vm_id || null; }
    finally { try { store.remove(probeFile); } catch {} }
  };
  const me = accounts.get(id);
  if (!me) return null;
  // A failed check is not "no duplicate" (audit #47): every vmOf error used to be caught
  // into null, so an unreachable muse.ai read exactly like a distinct Muse and the caller
  // (account-add) reported nothing. Errors now propagate; only an account with no session
  // at all (vmOf -> null for itself) still reads as "cannot tell, nothing to compare".
  const mine = await vmOf(me);
  if (!mine) return null;
  for (const other of accounts.list()) {
    if (other.id === id) continue;
    let theirs;
    try { theirs = await vmOf(other); } catch (e) { throw new Error('sameMuse: could not check account ' + other.id + ' (' + (e?.message || e) + ')'); }
    if (theirs === mine) return other;
  }
  return null;
}

module.exports = {autoEnabled, multi, preloadAll, bundle, statuses, initialBundle, makePool, sameMuse};
