'use strict';
// Connection to the Muse VM chat gateway (Noise XX over WebSocket), with credentials refreshed
// from the website login on every connect, as in muse-desktop-community.
const fs = require('node:fs');
const store = require('./secure-store');
const {MuseClient} = require('./core/muse-client');

const PINS = store.file('gateway-pins.json');

// The client, not yet connected: the TUI is drawn first and connects behind it.
// file: the store name of this account's gateway credentials (src/accounts.js).
function createChat(web, {file = 'session.enc'} = {}) {
  let pins = {};
  try { pins = JSON.parse(fs.readFileSync(PINS, 'utf8')); } catch {}
  const client = new MuseClient({
    credentials: store.load(file), fetchJson: web.fetchJson, requireLogin: true,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    // The VM key changes whenever the VM restarts (the pin file was rewritten twice on
    // 2026-10-31 alone) and the web client trusts the authenticated gateway, so a change is
    // recorded, not refused: refusing locked muser out until the pin file was deleted by hand.
    // Nothing is printed here — it would land on top of the TUI.
    checkPin: (id, fingerprint) => {
      if (pins[id] === fingerprint) return;
      // Re-read and write through a temp file: several muser windows record here.
      try { pins = {...JSON.parse(fs.readFileSync(PINS, 'utf8')), ...pins}; } catch {}
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

module.exports = {connectChat, createChat};
