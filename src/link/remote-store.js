'use strict';
// Paired phones, kept in ~/.muser/remote.json (remote/DESIGN.md): the phone's Noise
// static key IS its credential, so this list is the channel's allow-list, and removing
// a device revokes it. Plain JSON (public keys and names only — no secrets), written
// atomically under the config lock, like the other ~/.muser stores.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

function file() { return process.env.MUSER_REMOTE_FILE || path.join(os.homedir(), '.muser', 'remote.json'); }

// Device id = base64url(SHA-256(phone static public raw))[0..22], same shape as pcId.
function idFor(staticPubRaw) {
  return crypto.createHash('sha256').update(Buffer.from(staticPubRaw)).digest().toString('base64url').slice(0, 22);
}

// Stored keys are base64url text; callers hold raw Buffers. Accept either, plus a
// plain base64 string, and always normalise through the raw bytes.
function rawOf(staticPub) {
  if (Buffer.isBuffer(staticPub)) return staticPub;
  if (staticPub instanceof Uint8Array) return Buffer.from(staticPub);
  const s = String(staticPub || '');
  return Buffer.from(s, s.includes('+') || s.includes('/') || s.includes('=') ? 'base64' : 'base64url');
}
function pubText(staticPub) { return rawOf(staticPub).toString('base64url'); }

function createRemoteStore(storeFile) {
  const target = () => storeFile || file();
  function readAll() {
    // A MISSING file is an empty list; a CORRUPT one is not (audit #106):
    // silently reading damage as "no pairings" would let the next add/touch
    // overwrite the file and wipe every paired device for good. Refuse, and
    // leave the file exactly as it is for the user to inspect or restore.
    let text;
    try { text = fs.readFileSync(target(), 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
    let v;
    try { v = JSON.parse(text); } catch { throw new Error(`remote-store: ${target()} is corrupt (not valid JSON); refusing to treat it as an empty device list`); }
    if (!v || !Array.isArray(v.devices)) throw new Error(`remote-store: ${target()} is corrupt (no devices list); refusing to treat it as an empty device list`);
    return v.devices.filter(d => d && typeof d.id === 'string' && typeof d.staticPub === 'string');
  }
  function writeAll(devices) {
    const f = target();
    fs.mkdirSync(path.dirname(f), {recursive: true});
    const temp = f + '.tmp-' + process.pid + '-' + Date.now();
    try { fs.writeFileSync(temp, JSON.stringify({devices}, null, 2)); config.renameRetry(temp, f); }
    catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  }
  function update(fn) { return config.withLock(target(), () => { const devices = readAll(); const out = fn(devices); writeAll(devices); return out; }); }

  function list() { return readAll().map(d => ({...d})); }
  function findByStatic(staticPub) {
    const text = pubText(staticPub);
    return readAll().find(d => d.staticPub === text) || null;
  }
  // Add (or refresh) a pairing. The same static key re-pairing keeps its id and
  // createdAt; only the name and lastSeen move.
  function add({name, staticPub} = {}) {
    const raw = rawOf(staticPub);
    if (raw.length !== 32) throw new Error('remote-store: staticPub must be a raw 32-byte key');
    const now = new Date().toISOString();
    return update(devices => {
      const text = raw.toString('base64url');
      let device = devices.find(d => d.staticPub === text);
      if (device) { if (name) device.name = String(name); device.lastSeen = now; return {...device}; }
      device = {id: idFor(raw), name: String(name || 'phone'), staticPub: text, createdAt: now, lastSeen: now};
      devices.push(device);
      return {...device};
    });
  }
  function remove(idOrName) {
    return update(devices => {
      // Ids are exact and always win. A name matches only when it is
      // UNAMBIGUOUS (audit #107): several devices can share the default
      // name 'phone', and removing the first namesake would revoke the
      // wrong phone. An ambiguous name removes nothing.
      let i = devices.findIndex(d => d.id === idOrName);
      if (i < 0) {
        const named = devices.map((d, j) => d.name === idOrName ? j : -1).filter(j => j >= 0);
        if (named.length === 1) i = named[0];
      }
      if (i < 0) return null;
      return devices.splice(i, 1)[0];
    });
  }
  function touch(id) {
    return update(devices => {
      const device = devices.find(d => d.id === id);
      if (!device) return null;
      device.lastSeen = new Date().toISOString();
      return {...device};
    });
  }
  return {file: target, list, findByStatic, add, remove, touch};
}

const defaults = createRemoteStore();
module.exports = {file, idFor, createRemoteStore, list: defaults.list, findByStatic: defaults.findByStatic, add: defaults.add, remove: defaults.remove, touch: defaults.touch};
