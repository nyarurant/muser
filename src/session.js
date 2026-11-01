'use strict';
// Connection to the Muse VM chat gateway (Noise XX over WebSocket), with credentials refreshed
// from the website login on every connect, as in muse-desktop-community.
const fs = require('node:fs');
const store = require('./secure-store');
const {MuseClient} = require('./core/muse-client');

const PINS = store.file('gateway-pins.json');

// The client, not yet connected: the TUI is drawn first and connects behind it.
function createChat(web) {
  let pins = {};
  try { pins = JSON.parse(fs.readFileSync(PINS, 'utf8')); } catch {}
  const client = new MuseClient({
    credentials: store.load('session.enc'), fetchJson: web.fetchJson, requireLogin: true,
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
  client.on('credentials', c => store.save('session.enc', c));
  return client;
}

async function connectChat(web) {
  const client = createChat(web);
  await client.connect();
  return client;
}

module.exports = {connectChat, createChat};
