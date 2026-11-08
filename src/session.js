'use strict';
// Connection to the Muse VM chat gateway (Noise XX over WebSocket), with credentials refreshed
// from the website login on every connect, as in muse-desktop-community.
const fs = require('node:fs');
const store = require('./secure-store');
const {MuseClient} = require('./core/muse-client');

const PINS = store.file('gateway-pins.json');

// The pins file is hand-editable and synced by outside tools, so valid JSON that is
// not an object (null, an array, a string) must read as "no pins": null used to make
// checkPin throw a TypeError on every connect until the file was deleted by hand,
// and a string spread its characters into numeric keys in the rewritten file
// (deep audit c18 #15).
function asPins(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

// muse.ai suspends an idle VM; the gateway then answers 502 until something wakes it.
// The page does it with POST /api/hatch/vm/wake {vm_id, retry_count}; do the same and wait
// for RUNNING (UPDATING is waited out without a wake). True when the VM came up.
const WAKE_WAIT_MS = 60000, WAKE_POLL_MS = 3000;
async function wakeVm(web, {waitMs = WAKE_WAIT_MS, pollMs = WAKE_POLL_MS, sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  if (!web || typeof web.fetchJson !== 'function') return false;
  const read = async () => { try { return await web.fetchJson('/api/session?vm_state=true'); } catch { return null; } };
  let s = await read();
  if (!s || !s.vm_id) return false;
  if (s.vm_state === 'RUNNING') return true;
  if (s.vm_state === 'SUSPENDED') {
    if (typeof web.postJson !== 'function') return false;
    try { await web.postJson('/api/hatch/vm/wake', {vm_id: s.vm_id, retry_count: 0}); } catch { return false; }
  } else if (s.vm_state !== 'UPDATING') return false;
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    s = await read();
    if (s && s.vm_state === 'RUNNING') return true;
  }
  return false;
}

// The client, not yet connected: the TUI is drawn first and connects behind it.
// file: the store name of this account's gateway credentials (src/accounts.js).
function createChat(web, {file = 'session.enc'} = {}) {
  let pins = {};
  try { pins = asPins(JSON.parse(fs.readFileSync(PINS, 'utf8'))); } catch {}
  const client = new MuseClient({
    credentials: store.load(file), fetchJson: web.fetchJson, requireLogin: true, wakeVm: () => wakeVm(web),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    // The VM key changes whenever the VM restarts (the pin file was rewritten twice on
    // 2026-10-31 alone) and the web client trusts the authenticated gateway, so a change is
    // recorded, not refused: refusing locked muser out until the pin file was deleted by hand.
    // Nothing is printed here — it would land on top of the TUI.
    checkPin: (id, fingerprint) => {
      if (pins[id] === fingerprint) return;
      // Re-read and write through a temp file: several muser windows record here.
      try { pins = {...asPins(JSON.parse(fs.readFileSync(PINS, 'utf8'))), ...pins}; } catch {}
      pins[id] = fingerprint;
      const temp = PINS + '.tmp-' + process.pid + '-' + Date.now();
      try { fs.mkdirSync(store.DIR, {recursive: true}); fs.writeFileSync(temp, JSON.stringify(pins)); fs.renameSync(temp, PINS); } catch { try { fs.unlinkSync(temp); } catch {} }
    },
  });
  // A failed save (DPAPI hiccup, a racing window) must not crash the client from inside an
  // event handler: the refreshed credentials stay in memory and the next refresh retries.
  client.on('credentials', c => { try { store.save(file, c); } catch {} });
  return client;
}

async function connectChat(web, opts) {
  const client = createChat(web, opts);
  await client.connect();
  return client;
}

module.exports = {connectChat, createChat, wakeVm};
