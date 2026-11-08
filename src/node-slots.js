'use strict';
// Muse sends a chat's tool calls to the device its message named (device_id = node id), not to
// whichever window registered last (verified live 2026-11-01: two devices working at once, every
// call reached its own one). Windows that all used the saved node id could not be told apart, so
// each window now takes a node id of its own. A node id lives only while its window is open:
// opening registers it (link.register) and closing removes it again (POST /api/nodes/unpair,
// verified live 2026-11-06; the token is never revoked — the muser windows may share one,
// and revoking would log them all out). Slot 1 is the saved node id, slot n is `<saved>-<n>`.
// A slot is held by %LOCALAPPDATA%\muser\instances\node-<saved>.<n>.lock, which names the
// window's pid; the lock of a window that is gone is taken over. The pool is per saved node id,
// i.e. per account: with one pool for every account, six default-account windows held all the
// locks, an account-2 window fell back to the shared id (2026-11-03), and Muse marked that id
// offline as soon as another window that had registered it last went away. With the cap raised
// and sharing gone, a window that finds every slot held waits for one of its own instead.
// Legacy locks node-<n>.lock (older muser, account unknown) still count as held for every account.
const fs = require('node:fs');
const path = require('node:path');
const {defaultDir, alive} = require('./relay');

// Default cap on open windows per account (/settings 'maxNodeSlots' changes it, 1..MAX_SLOTS_LIMIT).
const MAX_SLOTS = 16;
const MAX_SLOTS_LIMIT = 64;
// How long closing waits for the gateway to answer an unpair before giving up and
// going on with the shutdown anyway; the next startup's prune removes leftovers.
const UNPAIR_TIMEOUT_MS = 5000;
// A claimed lock is heartbeated (its mtime is touched every HB_MS): a lock
// whose pid is still alive but whose heartbeat stopped long ago is a crashed
// window whose pid Windows has since handed to an unrelated process — pid
// liveness alone kept such a slot blocked for ever (c19 #11). Locks without
// a heartbeat marker (written before this, or by hand) keep the old
// pid-liveness-only rule, so a still-running older window is never stolen.
const HB_MS = 4000, HB_STALE_MS = 30000;
// Filesystem timestamp precision: on this PC a freshly written file's
// mtimeMs is often a fraction of a millisecond AHEAD of Date.now(), so a
// brand-new heartbeat lock can briefly read as future-dated. Allow a small
// future skew — an age down to -FUTURE_SKEW_MS counts as 0 (fresh). A
// genuinely future mtime (minutes/hours ahead, e.g. a clock set forward
// when the lock was written) is still not fresh / not live.
const FUTURE_SKEW_MS = 1000;
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) { try { Atomics.wait(WAIT_CELL, 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} } }
function uniq() { return process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

function nodeIdFor(base, slot) { return slot === 1 ? base : base + '-' + slot; }
const LOCK = /^node-(?:(.+)\.)?(\d+)\.lock$/; // [, base or undefined (legacy), slot]
function lockName(base, slot) { return 'node-' + String(base).replace(/[^A-Za-z0-9_-]/g, '_') + '.' + slot + '.lock'; }

// Windows of an older muser use the saved node id without a lock. They are seen by their relay
// entry (src/relay.js, muser-<pid>-*.json) with no node lock of that pid; slot 1 is then left to them.
function olderWindowRunning(dir, pid) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return false; }
  const holders = new Set();
  for (const n of names) if (LOCK.test(n)) { try { holders.add(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).pid); } catch {} }
  return names.some(n => { const m = /^muser-(\d+)-[0-9a-f]+\.json$/.exec(n); const p = m && Number(m[1]); return p && p !== pid && !holders.has(p) && alive(p); });
}

function legacyHeld(dir, slot) {
  const f = path.join(dir, 'node-' + slot + '.lock');
  let raw = null, readErr = null;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { readErr = e; }
  if (readErr) {
    if (readErr.code === 'ENOENT' || readErr.code === 'ENOTDIR') return false;
    // Present but unreadable right now: fall through to the freshness check.
  } else {
    try { const pid = JSON.parse(raw).pid; if (typeof pid === 'number' && pid > 0 && !alive(pid)) return false; } catch {}
  }
  // An empty or corrupt legacy lock is one an old window may be writing right
  // now: it counts as held while it is fresh (10 s, the same grace the
  // per-account locks below give a lock being written) and free only when
  // old. The old shape returned "free" for every read/parse failure, so a
  // new window took slot 1 out from under a starting old window (first
  // audit #16). A lock that cannot even be statted (and is not simply
  // absent) is treated as held — the safe direction for a shared node id.
  // Wave 17: a live pid alone no longer suffices either — it must pass this
  // same freshness check, or a legacy lock whose pid Windows has since
  // recycled was held for ever; and a genuinely future mtime (a negative
  // age beyond FUTURE_SKEW_MS, from a clock set forward when the lock was
  // written) is not fresh, or such a lock stayed "fresh" until that future
  // time arrived. A tiny negative age within the skew is just filesystem
  // timestamp precision on a brand-new lock and counts as fresh.
  try { const age = Date.now() - fs.statSync(f).mtimeMs; return age >= -FUTURE_SKEW_MS && age <= 10000; }
  catch (e) { return !(e.code === 'ENOENT' || e.code === 'ENOTDIR'); }
}

// Is the lock at `file` (already read as `raw`, null when unreadable) still held by a live
// window? The same judgement claim()'s EEXIST branch and the startup prune both use: a lock
// whose pid is gone is free; a live pid with a heartbeat counts only while the heartbeat is
// fresh (a crashed window whose pid Windows has since handed to an unrelated process must not
// block the slot for ever, c19 #11); a live pid without a heartbeat keeps the old pid-liveness
// rule, so a still-running older window is never stolen; an empty or corrupt lock counts as held
// only while it is fresh (10 s, a lock being written right now). Fresh means an age between
// -FUTURE_SKEW_MS and the window: a tiny negative age is filesystem timestamp precision on
// a brand-new lock and counts as fresh, while a genuinely future mtime (well beyond the
// skew) counts as not fresh, or a lock heartbeated while the clock was set forward stayed
// live until that future time (wave 17).
// An unreadable file that cannot
// even be statted counts as held, except when it is simply absent — the safe direction.
function lockHolderLive(file, raw) {
  let holder = null;
  if (typeof raw === 'string') { try { holder = JSON.parse(raw); } catch {} }
  if (holder && typeof holder.pid === 'number') {
    if (!alive(holder.pid)) return false;
    if (holder.hb) { try { const age = Date.now() - fs.statSync(file).mtimeMs; return age >= -FUTURE_SKEW_MS && age <= HB_STALE_MS; } catch { return true; } }
    return true;
  }
  try { const age = Date.now() - fs.statSync(file).mtimeMs; return age >= -FUTURE_SKEW_MS && age <= 10000; }
  catch (e) { return !(e.code === 'ENOENT' || e.code === 'ENOTDIR'); }
}

// Read-only version of the same judgement for one per-account lock: false when the lock file
// is absent, true when a live window holds it (or it is being written right now).
function perAccountLockLive(dir, base, slot) {
  const file = path.join(dir, lockName(base, slot));
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; }
  return lockHolderLive(file, raw);
}

// Is slot `slot` of account `base` held by a live window right now (any kind of lock, or, for
// slot 1, a live older window that uses the saved id without a lock)? The prune uses this to
// tell a node whose window is really gone from one whose window is only offline at the moment.
function slotLive(dir, base, slot, pid = process.pid) {
  if (legacyHeld(dir, slot)) return true;
  if (perAccountLockLive(dir, base, slot)) return true;
  if (slot === 1 && olderWindowRunning(dir, pid)) return true;
  return false;
}

// Move the lock at `file` aside and delete it only if the moved file is
// byte-for-byte the one that was judged (raw): if a successor replaced the
// lock between the judgement and the rename, its lock is put back untouched
// and false is returned (c19 #14, the shape sessions.locked uses).
function retireLock(file, raw) {
  const grave = file + '.stale-' + uniq();
  try { fs.renameSync(file, grave); } catch { return false; }
  let moved = null;
  try { moved = fs.readFileSync(grave, 'utf8'); } catch {}
  if (moved !== raw) {
    try { fs.renameSync(grave, file); } catch { try { fs.unlinkSync(grave); } catch {} }
    return false;
  }
  try { fs.unlinkSync(grave); } catch { try { fs.rmdirSync(grave); } catch {} }
  return true;
}

// {slot, nodeId, release()}. Slot 0 means "no slot of its own": it is only returned when the
// lock folder cannot be used at all (or there is no base), and it carries the saved node id
// shared with the other windows, as before (calls Muse sends there are handed over by
// src/relay.js). With every slot held, claim returns slot 0 too, and the caller waits for a
// slot of its own instead of using it (src/agent.js waitForOwnNode).
function claim(base, {dir = defaultDir(), max = MAX_SLOTS, pid = process.pid} = {}) {
  const shared = {slot: 0, nodeId: base, release() {}};
  if (typeof base !== 'string' || !base) return shared;
  try { fs.mkdirSync(dir, {recursive: true}); } catch { return shared; }
  for (let slot = olderWindowRunning(dir, pid) ? 2 : 1; slot <= max; slot++) {
    const file = path.join(dir, lockName(base, slot));
    if (legacyHeld(dir, slot)) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      let fd;
      try { fd = fs.openSync(file, 'wx'); }
      catch (e) {
        if (e.code === 'EEXIST') {
          let raw = null;
          try { raw = fs.readFileSync(file, 'utf8'); } catch {}
          // A lock being written right now has no content yet; only an old unreadable one is stale.
          if (lockHolderLive(file, raw)) break;
          if (!retireLock(file, raw)) break;
          continue;
        }
        // Windows answers EPERM / EBUSY / EACCES transiently while a holder is
        // deleting its lock (usage.js's lock notes the same): that is neither
        // "held" nor "locks do not work here", so retry this slot a few
        // times instead of skipping a free slot (c19 #10).
        if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code) && attempt < 5) { sleepMs(15); continue; }
        break;
      }
      const token = pid + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10);
      const content = JSON.stringify({pid, hb: 1, at: Date.now(), token});
      try { fs.writeSync(fd, content); }
      catch {
        // The lock file was created but not written: remove it (it is this
        // attempt's own file) instead of leaving an orphan empty lock that
        // blocks the slot for the 10 s writing grace (c19 #10), then retry.
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(file); } catch {}
        if (attempt < 5) { sleepMs(15); continue; }
        break;
      }
      try { fs.closeSync(fd); } catch {}
      let released = false;
      const timer = setInterval(() => {
        if (released) return;
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token !== token) { clearInterval(timer); return; }
          const now = new Date(); fs.utimesSync(file, now, now);
        } catch { clearInterval(timer); }
      }, HB_MS);
      if (timer.unref) timer.unref();
      return {slot, nodeId: nodeIdFor(base, slot), release() {
        if (released) return; released = true; clearInterval(timer);
        // Rename-aside release (c19 #14): only the lock that is still this
        // window's (its token matches) is deleted; a successor's is restored.
        const rel = file + '.rel-' + uniq();
        try { fs.renameSync(file, rel); } catch { return; }
        // A lock that does not parse is NOT provably this window's — it is a
        // successor's half-written (still empty) lock — so it takes the restore
        // path too. The old bare catch dropped it here as an orphaned .rel-*
        // file, unlocking the slot under the successor (master-debug #11).
        let mine = false;
        try {
          const held = JSON.parse(fs.readFileSync(rel, 'utf8'));
          mine = held.token ? held.token === token : held.pid === pid;
        } catch {}
        if (mine) { try { fs.unlinkSync(rel); } catch {} }
        else { try { fs.renameSync(rel, file); } catch { try { fs.unlinkSync(rel); } catch {} } }
      }};
    }
  }
  return shared;
}

// --- The gateway's device registry (POST /api/nodes/* on the chat gateway, via the
// caller's client.request — never the website: muse.ai answers those paths with its SPA
// shell). Verified live 2026-11-06: list returns {nodes: [{node_id, display_name, online,
// connection_state, ...}]}, unpair takes {node_id} and the id can be registered again with
// link.register afterwards. No token is ever revoked here.

// The gateway's node list, as it stands. Throws when the gateway cannot be reached, so a
// caller that must not act blind (the prune) can tell "unknown" from "empty".
async function listNodes(request) {
  const res = await request('POST', '/api/nodes/list', {});
  const nodes = res?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(n => n && typeof n === 'object' && typeof n.node_id === 'string');
}

// Remove one node id from the account's device list. The id can be registered again later.
async function unpairNode(request, nodeId) {
  if (typeof nodeId !== 'string' || !nodeId) throw new Error('node id is required');
  await request('POST', '/api/nodes/unpair', {node_id: nodeId});
  return true;
}

// Which slot of account `base` a node id belongs to: 1 for the base id itself, n for
// `<base>-n`, 0 when it is not one of this base's ids at all.
function slotOfNodeId(base, nodeId) {
  if (typeof nodeId !== 'string' || typeof base !== 'string' || !base) return 0;
  if (nodeId === base) return 1;
  const rest = nodeId.startsWith(base + '-') ? nodeId.slice(base.length + 1) : null;
  if (rest === null || !/^\d+$/.test(rest)) return 0;
  const n = Number(rest);
  return Number.isSafeInteger(n) && n >= 2 ? n : 0;
}

// Is this listed node one of this PC's muser windows (as opposed to the official Windows PC
// app, a phone, or another account's window)? Both halves must agree: the id is `<base>-n`
// with n >= 2, and the display name is '<host> CLI (muser) n' for that same n. The base id
// itself (slot 1) is the account's standing device and is never a target, and a node whose
// name does not match its number is left alone — the safe direction when in doubt.
function isMuserNode(node, base) {
  if (!node || typeof node !== 'object') return false;
  const slot = slotOfNodeId(base, node.node_id);
  if (slot < 2) return false;
  const m = typeof node.display_name === 'string' ? / CLI \(muser\) (\d+)$/.exec(node.display_name) : null;
  return !!m && Number(m[1]) === slot;
}

// Startup cleanup: remove the muser nodes of account `base` whose window is really gone —
// offline in the list AND with no live lock holder in `dir`. A node that is online, or whose
// lock is still held (its window is alive but its device link is down at the moment), is left
// alone, as is every node that is not one of this account's muser windows. Never throws:
// a list failure means "unknown", and nothing is unpaired then. Returns what happened, so the
// caller can say so in one line.
async function pruneStaleNodes({base, dir = defaultDir(), request, pid = process.pid} = {}) {
  const result = {checked: 0, unpaired: [], skipped: [], error: null};
  if (typeof base !== 'string' || !base || typeof request !== 'function') return result;
  let nodes;
  try { nodes = await listNodes(request); }
  catch (e) { result.error = e?.message || String(e); return result; }
  for (const node of nodes) {
    result.checked++;
    if (!isMuserNode(node, base)) { result.skipped.push({id: node.node_id, reason: 'not-muser'}); continue; }
    if (node.online !== false) { result.skipped.push({id: node.node_id, reason: 'online'}); continue; }
    if (slotLive(dir, base, slotOfNodeId(base, node.node_id), pid)) { result.skipped.push({id: node.node_id, reason: 'lock-held'}); continue; }
    // Re-check just before unpairing (master-debug #12): while the list above was
    // being walked, a window may have claimed this slot and registered — unpairing
    // then would cut a live window's registration. A failed re-list is "unknown",
    // and unknown never unpairs.
    let fresh;
    try { fresh = await listNodes(request); } catch { result.skipped.push({id: node.node_id, reason: 'recheck-failed'}); continue; }
    const now = fresh.find(n => n.node_id === node.node_id);
    if (!now || !isMuserNode(now, base) || now.online !== false || slotLive(dir, base, slotOfNodeId(base, node.node_id), pid)) { result.skipped.push({id: node.node_id, reason: 'changed'}); continue; }
    try { await unpairNode(request, node.node_id); result.unpaired.push(node.node_id); }
    catch { result.skipped.push({id: node.node_id, reason: 'unpair-failed'}); }
  }
  return result;
}

module.exports = {claim, nodeIdFor, slotOfNodeId, lockName, LOCK, MAX_SLOTS, MAX_SLOTS_LIMIT, UNPAIR_TIMEOUT_MS, listNodes, unpairNode, isMuserNode, slotLive, pruneStaleNodes};
