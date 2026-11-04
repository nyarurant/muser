'use strict';
// Muse sends a chat's tool calls to the device its message named (device_id = node id), not to
// whichever window registered last (verified live 2026-11-01: two devices working at once, every
// call reached its own one). Windows that all used the saved node id could not be told apart, so
// each window now takes a node id of its own. Every node id ever registered stays in the account's
// device list (no way to remove one was found), so they come from a small fixed pool: slot 1 is the
// saved node id, slot n is `<saved>-<n>`. A slot is held by %LOCALAPPDATA%\muser\instances\node-<saved>.<n>.lock,
// which names the window's pid; the lock of a window that is gone is taken over. The pool is per
// saved node id, i.e. per account: with one pool for every account, six default-account windows held
// all the locks, an account-2 window fell back to the shared id (2026-11-03), and Muse marked that id
// offline as soon as another window that had registered it last went away.
// Legacy locks node-<n>.lock (older muser, account unknown) still count as held for every account.
const fs = require('node:fs');
const path = require('node:path');
const {defaultDir, alive} = require('./relay');

const MAX_SLOTS = 6;
// A claimed lock is heartbeated (its mtime is touched every HB_MS): a lock
// whose pid is still alive but whose heartbeat stopped long ago is a crashed
// window whose pid Windows has since handed to an unrelated process — pid
// liveness alone kept such a slot blocked for ever (c19 #11). Locks without
// a heartbeat marker (written before this, or by hand) keep the old
// pid-liveness-only rule, so a still-running older window is never stolen.
const HB_MS = 4000, HB_STALE_MS = 30000;
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
    try { const pid = JSON.parse(raw).pid; if (typeof pid === 'number' && pid > 0) return alive(pid); } catch {}
  }
  // An empty or corrupt legacy lock is one an old window may be writing right
  // now: it counts as held while it is fresh (10 s, the same grace the
  // per-account locks below give a lock being written) and free only when
  // old. The old shape returned "free" for every read/parse failure, so a
  // new window took slot 1 out from under a starting old window (first
  // audit #16). A lock that cannot even be statted (and is not simply
  // absent) is treated as held — the safe direction for a shared node id.
  try { return Date.now() - fs.statSync(f).mtimeMs <= 10000; }
  catch (e) { return !(e.code === 'ENOENT' || e.code === 'ENOTDIR'); }
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

// {slot, nodeId, release()}. With every slot held, slot 0 is the saved node id shared with the
// other windows, as before (calls Muse sends there are handed over by src/relay.js).
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
          let raw = null, holder = null;
          try { raw = fs.readFileSync(file, 'utf8'); holder = JSON.parse(raw); } catch {}
          // A lock being written right now has no content yet; only an old unreadable one is stale.
          let stale = false;
          if (holder && typeof holder.pid === 'number') {
            if (!alive(holder.pid)) stale = true;
            else if (holder.hb) { try { stale = Date.now() - fs.statSync(file).mtimeMs > HB_STALE_MS; } catch { stale = false; } }
          } else { try { stale = Date.now() - fs.statSync(file).mtimeMs > 10000; } catch { stale = false; } }
          if (!stale) break;
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
        try {
          const held = JSON.parse(fs.readFileSync(rel, 'utf8'));
          const mine = held.token ? held.token === token : held.pid === pid;
          if (mine) { try { fs.unlinkSync(rel); } catch {} }
          else { try { fs.renameSync(rel, file); } catch { try { fs.unlinkSync(rel); } catch {} } }
        } catch {}
      }};
    }
  }
  return shared;
}

module.exports = {claim, nodeIdFor, lockName, LOCK, MAX_SLOTS};
