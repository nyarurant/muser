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
  try { return alive(JSON.parse(fs.readFileSync(path.join(dir, 'node-' + slot + '.lock'), 'utf8')).pid); } catch { return false; }
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx');
        try { fs.writeSync(fd, JSON.stringify({pid})); } finally { fs.closeSync(fd); }
        let released = false;
        return {slot, nodeId: nodeIdFor(base, slot), release() {
          if (released) return; released = true;
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.unlinkSync(file); } catch {}
        }};
      } catch (e) {
        if (e.code !== 'EEXIST') break;
        let holder = null; try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        // A lock being written right now has no content yet; only an old unreadable one is stale.
        let stale = holder ? !alive(holder.pid) : false;
        if (!holder) { try { stale = Date.now() - fs.statSync(file).mtimeMs > 10000; } catch { stale = false; } }
        if (!stale) break;
        try { fs.unlinkSync(file); } catch { break; }
      }
    }
  }
  return shared;
}

module.exports = {claim, nodeIdFor, lockName, LOCK, MAX_SLOTS};
