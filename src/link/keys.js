'use strict';
// The PC's link identities (remote/DESIGN.md, "Identities and keys"): an X25519 static
// pair for Noise and an Ed25519 pair for authenticating to the relay. Both live in ONE
// entry of the DPAPI secure-store (src/secure-store.js), as JSON with base64 fields;
// the private keys never touch a plain file.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../secure-store');

const FILE = 'link.enc';

// Raw 32-byte keys <-> node:crypto KeyObjects, through JWK (x = public, d = private).
function rawPair(algorithm) {
  const {publicKey, privateKey} = crypto.generateKeyPairSync(algorithm);
  const pub = publicKey.export({format: 'jwk'}), priv = privateKey.export({format: 'jwk'});
  return {publicKey: Buffer.from(pub.x, 'base64url'), privateKey: Buffer.from(priv.d, 'base64url')};
}
function ed25519PrivateKey({publicKey, privateKey}) {
  return crypto.createPrivateKey({format: 'jwk', key: {
    kty: 'OKP', crv: 'Ed25519',
    x: Buffer.from(publicKey).toString('base64url'),
    d: Buffer.from(privateKey).toString('base64url'),
  }});
}
function ed25519PublicKey(publicKey) {
  return crypto.createPublicKey({format: 'jwk', key: {kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url')}});
}

// pcId = base64url(SHA-256(ed25519 public raw))[0..22] — the relay checks a PC's
// claimed id against exactly this derivation, so it is shared, not re-implemented.
function pcIdFor(relayPublicKey) {
  return crypto.createHash('sha256').update(Buffer.from(relayPublicKey)).digest().toString('base64url').slice(0, 22);
}

// Ed25519-sign data with the relay pair (raw Buffers, as loadOrCreateLinkKeys returns
// them; KeyObjects are also accepted). Returns the raw 64-byte signature.
function signRelay(keyPair, data) {
  const key = keyPair && keyPair.privateKey && Buffer.isBuffer(keyPair.privateKey) ? ed25519PrivateKey(keyPair) : (keyPair.privateKey || keyPair);
  return crypto.sign(null, Buffer.from(data), key);
}
function verifyRelay(keyPair, data, signature) {
  const pub = keyPair && keyPair.publicKey;
  const key = Buffer.isBuffer(pub) ? ed25519PublicKey(pub) : (pub || keyPair);
  try { return crypto.verify(null, Buffer.from(data), key, Buffer.from(signature)); } catch { return false; }
}

function encodePair(pair) { return {publicKey: pair.publicKey.toString('base64'), privateKey: pair.privateKey.toString('base64')}; }
function decodePair(value) {
  if (!value || typeof value !== 'object') return null;
  const publicKey = Buffer.from(String(value.publicKey || ''), 'base64');
  const privateKey = Buffer.from(String(value.privateKey || ''), 'base64');
  return publicKey.length === 32 && privateKey.length === 32 ? {publicKey, privateKey} : null;
}

// True when the stored public key is the one the stored private key actually
// derives (audit #105): a pair whose halves do not belong together would
// fail every handshake / relay authentication in ways that look like network
// trouble, so it is corruption, not a usable key.
function pairMatches(pair, algorithm) {
  try {
    const crv = algorithm === 'ed25519' ? 'Ed25519' : 'X25519';
    const priv = crypto.createPrivateKey({format: 'jwk', key: {
      kty: 'OKP', crv,
      x: pair.publicKey.toString('base64url'),
      d: pair.privateKey.toString('base64url'),
    }});
    const derived = crypto.createPublicKey(priv).export({format: 'jwk'});
    return Buffer.from(derived.x, 'base64url').equals(pair.publicKey);
  } catch { return false; }
}

// Read the stored pair set WITHOUT creating it: null when nothing is stored.
// A status display uses this — merely looking at `muser link` used to mint and
// persist a pcId/keypair as a side effect (recovery scan).
function loadLinkKeys({file = FILE, store: s = store} = {}) {
  const saved = s.load(file);
  if (saved === null || saved === undefined) return null;
  return readSaved(saved);
}
// An entry EXISTS: it must decode completely, with both pairs intact and each
// public key matching its private key. Regenerating only the broken half (the
// old behaviour, audit #105) silently changed the pcId and orphaned every
// pairing, so partial damage is a hard error instead.
function readSaved(saved) {
  const noise = decodePair(saved?.noise), relay = decodePair(saved?.relay);
  if (!noise || !relay) throw new Error('link keys: the stored link key entry is incomplete or corrupt; refusing to regenerate keys (that would change the pcId and orphan every pairing)');
  if (!pairMatches(noise, 'x25519') || !pairMatches(relay, 'ed25519')) throw new Error('link keys: a stored link key pair does not match itself (public key does not derive from the private key); refusing to regenerate keys (that would change the pcId and orphan every pairing)');
  return {keys: {noise, relay}, pcId: pcIdFor(relay.publicKey)};
}
// Load the stored pair set, generating and persisting it on first use. Returns
// {keys: {noise, relay}, pcId} with every key a raw 32-byte Buffer.
function loadOrCreateLinkKeys({file = FILE, store: s = store} = {}) {
  // secure-store.load: null when missing; a present-but-unreadable entry throws its
  // own clear error, which stands — silently minting new keys would change the pcId
  // and orphan every pairing.
  const saved = s.load(file);
  if (saved !== null && saved !== undefined) return readSaved(saved);
  return withCreateLock(s, file, () => createLinkKeys(file, s));
}

function createLinkKeys(file, s) {
  // Re-check under the lock: another process may have created the entry
  // while this one waited, and then its identity is the one to use.
  const now = s.load(file);
  if (now !== null && now !== undefined) return readSaved(now);
  const keys = {noise: rawPair('x25519'), relay: rawPair('ed25519')};
  s.save(file, {noise: encodePair(keys.noise), relay: encodePair(keys.relay)});
  const mine = {keys, pcId: pcIdFor(keys.relay.publicKey)};
  // Verify what actually landed (audit c30 #3): if a racing first-run process
  // saved after us — one that could not take the lock, e.g. a store with no
  // file path — the stored entry is what every later process will load, so
  // adopt it instead of running for this process's lifetime on an identity
  // that is not on disk (a phone pairing to it would be orphaned on restart).
  let stored;
  try { stored = s.load(file); } catch { stored = undefined; }
  if (stored !== null && stored !== undefined) {
    const winner = readSaved(stored);
    if (winner.pcId !== mine.pcId) return winner;
  }
  return mine;
}

// Inter-process lock around first creation (same shape as config.withLock):
// two muser processes started for the first time at once both saw "no entry",
// generated different permanent identities, and the loser's pairings were
// orphaned when only the winner's save survived (audit c30 #3). The lock
// file carries an ownership token and only its owner unlinks it; a lock older
// than 5 s is taken to be left by a crashed process. A store that cannot name
// a file (the test fakes) skips the lock — createLinkKeys' re-read is the
// safety net there. The critical section is one DPAPI save (~0.4 s), so a
// 10 s wait is generous; past it, creation proceeds unlocked rather than
// never starting.
function withCreateLock(s, file, fn) {
  let lock = null;
  try { if (typeof s.file === 'function') lock = s.file(file) + '.create.lock'; } catch { lock = null; }
  if (!lock) return fn();
  const token = crypto.randomBytes(16).toString('hex'), until = Date.now() + 10000;
  try { fs.mkdirSync(path.dirname(lock), {recursive: true}); } catch {}
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return fn();
      if (Date.now() > until) return fn();
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.unlinkSync(lock); continue; } } catch { /* lock vanished mid-check: retry */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {} }
}

module.exports = {FILE, loadOrCreateLinkKeys, loadLinkKeys, signRelay, verifyRelay, pcIdFor, ed25519PrivateKey, ed25519PublicKey};
