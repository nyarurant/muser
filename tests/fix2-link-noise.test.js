'use strict';
// Fix phase 2 regression tests for src/link/noise.js and src/link/keys.js
// (deep audit #249/#250/#251 = work2/c30 #1/#2/#3; fifth audit s2-1, and
// fifth s2-2 which is c30 #1 seen from msg3 — same defect, same fix).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NoiseConnection, generateStaticKeyPair, pskFromCode,
        FrameDecoder, ChunkReassembler, MAX_ASSEMBLED_PARTS } = require('../src/link/noise');
const { loadOrCreateLinkKeys } = require('../src/link/keys');

function pair(pattern = 'XX', opts = {}) {
  const aliceKeys = generateStaticKeyPair();
  const bobKeys = generateStaticKeyPair();
  return {
    alice: new NoiseConnection({ pattern, initiator: true, staticKeyPair: aliceKeys, ...opts }),
    bob: new NoiseConnection({ pattern, initiator: false, staticKeyPair: bobKeys, ...opts }),
    aliceKeys, bobKeys,
  };
}
function handshake(alice, bob) {
  bob.readMessage(alice.writeMessage(Buffer.alloc(0)));
  alice.readMessage(bob.writeMessage(Buffer.alloc(0)));
  bob.readMessage(alice.writeMessage(Buffer.alloc(0)));
}

// --- c30 #1 / deep #249: a failed message must not poison the connection ----

test('fix2 noise: a corrupted handshake message does not poison the connection — the correct retransmission succeeds', () => {
  const { alice, bob } = pair();
  bob.readMessage(alice.writeMessage(Buffer.alloc(0)));
  const m2 = bob.writeMessage(Buffer.from('hello alice'));
  const bad = Buffer.from(m2);
  bad[bad.length - 1] ^= 0x01;
  assert.throws(() => alice.readMessage(bad));
  assert.equal(alice.handshakeFinished, false);
  // The same message, uncorrupted (a link-layer retransmission):
  assert.deepEqual(alice.readMessage(m2), Buffer.from('hello alice'));
  // And the handshake can still complete and carry traffic.
  bob.readMessage(alice.writeMessage(Buffer.from('done')));
  assert.equal(alice.handshakeFinished, true);
  assert.equal(bob.handshakeFinished, true);
  assert.deepEqual(bob.readTransport(alice.writeTransport(Buffer.from('ping'))), Buffer.from('ping'));
});

test('fix2 noise: a corrupted msg3 does not poison the responder either (fifth s2-2, same root as c30 #1)', () => {
  const { alice, bob } = pair();
  bob.readMessage(alice.writeMessage(Buffer.alloc(0)));
  alice.readMessage(bob.writeMessage(Buffer.alloc(0)));
  const m3 = alice.writeMessage(Buffer.from('final'));
  const bad = Buffer.from(m3);
  bad[10] ^= 0x01; // inside the encrypted static key
  assert.throws(() => bob.readMessage(bad));
  assert.deepEqual(bob.readMessage(m3), Buffer.from('final'));
  assert.equal(bob.handshakeFinished, true);
});

test('fix2 noise: a corrupted transport frame does not consume the nonce — the genuine frame still decrypts', () => {
  const { alice, bob } = pair();
  handshake(alice, bob);
  const c1 = alice.writeTransport(Buffer.from('one'));
  const bad = Buffer.from(c1);
  bad[2] ^= 0xff;
  assert.throws(() => bob.readTransport(bad));
  assert.deepEqual(bob.readTransport(c1), Buffer.from('one'));
});

test('fix2 noise: a duplicated transport frame is rejected but the next genuine frame still decrypts', () => {
  const { alice, bob } = pair();
  handshake(alice, bob);
  const c1 = alice.writeTransport(Buffer.from('one'));
  const c2 = alice.writeTransport(Buffer.from('two'));
  assert.deepEqual(bob.readTransport(c1), Buffer.from('one'));
  assert.throws(() => bob.readTransport(Buffer.from(c1))); // replay / duplication
  assert.deepEqual(bob.readTransport(c2), Buffer.from('two'));
});

test('fix2 noise: a wrong-psk handshake still fails (rollback does not weaken authentication)', () => {
  const good = pskFromCode('RIGHT-CODE');
  const bad = pskFromCode('WRONG-CODE');
  const aliceKeys = generateStaticKeyPair();
  const bobKeys = generateStaticKeyPair();
  const alice = new NoiseConnection({ pattern: 'XXpsk3', initiator: true, staticKeyPair: aliceKeys, psk: good });
  const bob = new NoiseConnection({ pattern: 'XXpsk3', initiator: false, staticKeyPair: bobKeys, psk: bad });
  bob.readMessage(alice.writeMessage(Buffer.alloc(0)));
  alice.readMessage(bob.writeMessage(Buffer.alloc(0)));
  const m3 = alice.writeMessage(Buffer.alloc(0));
  assert.throws(() => bob.readMessage(m3));
  assert.equal(bob.handshakeFinished, false);
  // Retrying the same bad m3 keeps failing (it is not accepted on a retry).
  assert.throws(() => bob.readMessage(m3));
  assert.equal(bob.handshakeFinished, false);
});

// --- c30 #2 / deep #250: reassembly cap breach is sticky ---------------------

test('fix2 noise: FrameDecoder byte-cap breach is sticky — the tail is never delivered as a payload', () => {
  const dec = new FrameDecoder();
  const frame = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(65518, 7)]);
  let threwAt = -1;
  for (let i = 0; i < 600 && threwAt < 0; i++) {
    try { dec.push(frame); } catch { threwAt = i; }
  }
  assert.ok(threwAt > 0, 'the 32 MiB cap still trips');
  // The rest of that oversized payload, ending in a final frame, must throw —
  // not come back as a complete (truncated) payload.
  assert.throws(() => dec.push(Buffer.from([0x01, 65, 66])), /already failed/);
  assert.throws(() => dec.push(frame), /already failed/);
  // A fresh decoder is unaffected.
  const fresh = new FrameDecoder();
  assert.deepEqual(fresh.push(Buffer.from([0x01, 65, 66])), Buffer.from('AB'));
});

test('fix2 noise: ChunkReassembler byte-cap breach is sticky too', () => {
  const re = new ChunkReassembler();
  const piece = Buffer.alloc(65519, 7);
  let threwAt = -1;
  for (let i = 0; i < 600 && threwAt < 0; i++) {
    try { re.push(piece, false); } catch { threwAt = i; }
  }
  assert.ok(threwAt > 0, 'the 32 MiB cap still trips');
  assert.throws(() => re.push(Buffer.from('AB'), true), /already failed/);
});

// --- fifth s2-1: part-count cap (empty frames must not grow memory) ---------

test('fix2 noise: FrameDecoder caps the part count — empty non-final frames cannot accumulate without bound', () => {
  const dec = new FrameDecoder();
  const empty = Buffer.from([0x00]);
  for (let i = 0; i < MAX_ASSEMBLED_PARTS; i++) assert.equal(dec.push(empty), null);
  assert.throws(() => dec.push(empty), /parts/);
  // Sticky, like the byte cap: nothing is delivered afterwards either.
  assert.throws(() => dec.push(Buffer.from([0x01, 65])), /already failed/);
});

test('fix2 noise: a payload using exactly the part-count cap still assembles', () => {
  const dec = new FrameDecoder();
  const empty = Buffer.from([0x00]);
  for (let i = 0; i < MAX_ASSEMBLED_PARTS - 1; i++) assert.equal(dec.push(empty), null);
  assert.deepEqual(dec.push(Buffer.from([0x01, 0x58])), Buffer.from('X'));
});

test('fix2 noise: ChunkReassembler caps the part count as well', () => {
  const re = new ChunkReassembler();
  const empty = Buffer.alloc(0);
  for (let i = 0; i < MAX_ASSEMBLED_PARTS; i++) assert.equal(re.push(empty, false), null);
  assert.throws(() => re.push(empty, false), /parts/);
  assert.throws(() => re.push(Buffer.from('AB'), true), /already failed/);
});

// --- c30 #3 / deep #251: first-creation race in keys.js ----------------------

const enc = p => ({ publicKey: p.publicKey.toString('base64'), privateKey: p.privateKey.toString('base64') });
function mintViaFakeStore() {
  const s = { v: null, load: () => s.v, save: (f, val) => { s.v = val; } };
  return loadOrCreateLinkKeys({ store: s });
}

test('fix2 keys: when a racing process wins the save, the loser adopts the stored identity', () => {
  const competitor = mintViaFakeStore();
  const competitorSaved = { noise: enc(competitor.keys.noise), relay: enc(competitor.keys.relay) };
  // Our save lands, then the competitor's rename lands after it, before our
  // post-save re-read: the disk now holds the competitor's identity.
  const race = { v: null, load: () => race.v, save: () => { race.v = competitorSaved; } };
  const mine = loadOrCreateLinkKeys({ store: race });
  assert.equal(mine.pcId, competitor.pcId);
  assert.deepEqual(mine.keys.noise, competitor.keys.noise);
  assert.deepEqual(mine.keys.relay, competitor.keys.relay);
});

test('fix2 keys: an entry created while waiting for the lock is used, not overwritten', () => {
  const competitor = mintViaFakeStore();
  const competitorSaved = { noise: enc(competitor.keys.noise), relay: enc(competitor.keys.relay) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-keys-'));
  let loads = 0;
  const s = {
    file: () => path.join(dir, 'link.enc'),
    load: () => { loads += 1; return loads === 1 ? null : competitorSaved; }, // appears during the lock wait
    save: () => { throw new Error('must not save over the winner'); },
  };
  const got = loadOrCreateLinkKeys({ store: s });
  assert.equal(got.pcId, competitor.pcId);
  assert.equal(fs.existsSync(path.join(dir, 'link.enc.create.lock')), false, 'the lock was released');
});

test('fix2 keys: a stale create-lock left by a crashed process is taken over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-keys-'));
  const target = path.join(dir, 'link.enc');
  const lock = target + '.create.lock';
  fs.writeFileSync(lock, 'dead-process-token');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lock, past, past);
  const s = { v: null, file: () => target, load: () => s.v, save: (f, val) => { s.v = val; } };
  const got = loadOrCreateLinkKeys({ store: s });
  assert.equal(got.keys.noise.publicKey.length, 32);
  assert.ok(s.v, 'keys were saved');
  assert.equal(fs.existsSync(lock), false, 'the lock was released afterwards');
  // And the created identity is stable across loads.
  const again = loadOrCreateLinkKeys({ store: s });
  assert.equal(again.pcId, got.pcId);
});

test('fix2 keys: plain first creation through a path-less store still works (no lock available)', () => {
  const a = mintViaFakeStore();
  assert.equal(a.keys.relay.publicKey.length, 32);
  assert.equal(typeof a.pcId, 'string');
  assert.equal(a.pcId.length, 22);
});
