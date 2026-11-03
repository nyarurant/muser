'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {Transport, Cipher, cat, uint, bytes} = require('../src/core/noise');

// A Cipher with no key is a passthrough, so chunk frames can be built by hand:
// a wire chunk is fields {1: stream/chunk id, 2: index, 3: count, 4: payload}.
function chunk(id, index, count, payload) {
  return cat(uint(1, id), uint(2, index), uint(3, count), bytes(4, payload));
}
function transport() { return new Transport(new Cipher(), new Cipher()); }

test('a complete single-chunk frame still decodes', () => {
  const t = transport();
  const frame = cat(uint(1, 9n), bytes(4, cat(bytes(1, Buffer.from('hi')), uint(2, 1))));
  const out = t.decode(chunk(42n, 0, 1, bytes(1, frame)));
  assert.equal(out.type, 'body');
  assert.equal(out.id, 9n);
  assert.equal(out.body.toString(), 'hi');
  assert.equal(out.end, true);
  assert.equal(t.chunks.size, 0);
  t.destroy();
});

test('a partial entry swept after 30s frees its slot', () => {
  const t = transport();
  assert.equal(t.decode(chunk(7n, 0, 2, Buffer.from('a'))), null);
  assert.equal(t.chunks.size, 1);
  const created = t.chunks.get('7').created;
  t.sweepChunks(created + 30001);
  assert.equal(t.chunks.size, 0);
  t.destroy();
});

test('a partial entry expires via its timer even if decode() never runs again', (t) => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  try {
    const tr = transport();
    assert.equal(tr.decode(chunk(8n, 0, 2, Buffer.from('a'))), null);
    assert.equal(tr.chunks.size, 1);
    t.mock.timers.tick(30002);
    assert.equal(tr.chunks.size, 0);
    tr.destroy();
  } finally {
    t.mock.timers.reset();
  }
});

test('the reassembly cap evicts the oldest entry instead of throwing, and a decode-time sweep frees stale slots', () => {
  // Audit #136: the cap used to be 16 with a fatal throw; 17 concurrent legal
  // multi-chunk responses killed the connection. Now the cap is 64 and the
  // oldest incomplete entry is evicted.
  const t = transport();
  for (let i = 1; i <= 64; i++) t.decode(chunk(BigInt(i), 0, 2, Buffer.from('a')));
  assert.equal(t.chunks.size, 64);
  assert.equal(t.decode(chunk(99n, 0, 2, Buffer.from('a'))), null, 'no throw past the cap');
  assert.equal(t.chunks.size, 64, 'still capped');
  assert.equal(t.chunks.has('1'), false, 'the oldest entry was evicted');
  assert.equal(t.chunks.has('99'), true, 'the new entry was kept');
  // A later decode sweeps entries older than 30s before the cap is checked,
  // by ageing the stored timestamps the way the wall clock would.
  const old = Date.now() - 31000;
  for (const v of t.chunks.values()) v.created = old;
  assert.equal(t.decode(chunk(100n, 0, 2, Buffer.from('a'))), null);
  assert.equal(t.chunks.size, 1);
  t.destroy();
});

// --- src/link/noise.js: Noise_XX / Noise_XXpsk3 for muser link -------------
const linkNoise = require('../src/link/noise');
const { NoiseConnection, generateStaticKeyPair: genLinkKeys, pskFromCode,
        chunkPayload, encodeFrames, FrameDecoder } = linkNoise;

function linkPair(pattern, opts = {}) {
  const aliceKeys = genLinkKeys();
  const bobKeys = genLinkKeys();
  const base = { pattern, staticKeyPair: null };
  const alice = new NoiseConnection({ ...base, ...opts.alice, initiator: true, staticKeyPair: aliceKeys });
  const bob = new NoiseConnection({ ...base, ...opts.bob, initiator: false, staticKeyPair: bobKeys });
  return { alice, bob, aliceKeys, bobKeys };
}
function runHandshake(alice, bob, payloads = [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)]) {
  const got = [];
  got.push(bob.readMessage(alice.writeMessage(payloads[0])));
  got.push(alice.readMessage(bob.writeMessage(payloads[1])));
  got.push(bob.readMessage(alice.writeMessage(payloads[2])));
  return got;
}
function patterned(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}

test('link noise: static key pairs and pskFromCode', () => {
  const a = genLinkKeys();
  const b = genLinkKeys();
  assert.equal(a.publicKey.length, 32);
  assert.equal(a.privateKey.length, 32);
  assert.notDeepEqual(a.publicKey, b.publicKey);
  const psk = pskFromCode('K7Q2-PAIR');
  assert.equal(psk.length, 32);
  assert.deepEqual(psk, pskFromCode('K7Q2-PAIR'));
  assert.notDeepEqual(psk, pskFromCode('K7Q2-PAIX'));
  // Matches the exact HKDF formula the pairing code is specified to use.
  const expect = Buffer.from(require('node:crypto').hkdfSync(
    'sha256', Buffer.from('K7Q2-PAIR', 'utf8'), Buffer.from('muser-link'), Buffer.alloc(0), 32));
  assert.deepEqual(psk, expect);
  // Shared JS<->Kotlin interop vector: the Android app (NoiseHkdf.pskFromCode)
  // pins these exact bytes too, or Wi-Fi pairing breaks at message 3.
  assert.equal(pskFromCode('ABCD2345').toString('hex'),
    'ab41293bf6e4e74703597492eaee72a5c43a65a1910a802893b30fe5072bfd73');
});

test('link noise: full XX handshake with payloads, then bidirectional transport', () => {
  const { alice, bob, aliceKeys, bobKeys } = linkPair('XX');
  assert.equal(alice.handshakeFinished, false);
  assert.equal(alice.remoteStatic, null);
  assert.equal(bob.remoteStatic, null);
  const payloads = [Buffer.from('hello bob'), Buffer.from('hello alice'), Buffer.from('pairing done')];
  const m1 = alice.writeMessage(payloads[0]);
  assert.deepEqual(bob.readMessage(m1), payloads[0]);
  assert.equal(bob.handshakeFinished, false);
  const m2 = bob.writeMessage(payloads[1]);
  assert.deepEqual(alice.readMessage(m2), payloads[1]);
  assert.deepEqual(alice.remoteStatic, bobKeys.publicKey);
  assert.equal(alice.handshakeFinished, false);
  const m3 = alice.writeMessage(payloads[2]);
  assert.equal(alice.handshakeFinished, true);
  assert.deepEqual(bob.readMessage(m3), payloads[2]);
  assert.equal(bob.handshakeFinished, true);
  // Bidirectional transport, several messages each way (nonce sequencing),
  // including an empty message and a maximum-size one.
  for (const msg of [Buffer.from('ping'), Buffer.alloc(0), patterned(1000), patterned(65519)]) {
    assert.deepEqual(bob.readTransport(alice.writeTransport(msg)), msg);
  }
  for (const msg of [Buffer.from('pong'), patterned(42)]) {
    assert.deepEqual(alice.readTransport(bob.writeTransport(msg)), msg);
  }
});

test('link noise: remoteStatic matches the peer public key on both sides', () => {
  const { alice, bob, aliceKeys, bobKeys } = linkPair('XX');
  runHandshake(alice, bob);
  assert.deepEqual(alice.remoteStatic, bobKeys.publicKey);
  assert.deepEqual(bob.remoteStatic, aliceKeys.publicKey);
});

test('link noise: XXpsk3 succeeds with the right psk and fails with a wrong one', () => {
  const psk = pskFromCode('WIFI-CODE-1');
  const good = linkPair('XXpsk3', { alice: { psk }, bob: { psk } });
  runHandshake(good.alice, good.bob, [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);
  assert.equal(good.alice.handshakeFinished, true);
  assert.equal(good.bob.handshakeFinished, true);
  const msg = Buffer.from('over the wifi channel');
  assert.deepEqual(good.bob.readTransport(good.alice.writeTransport(msg)), msg);

  const bad = linkPair('XXpsk3', { alice: { psk }, bob: { psk: pskFromCode('WIFI-CODE-2') } });
  bad.bob.readMessage(bad.alice.writeMessage(Buffer.alloc(0)));
  bad.alice.readMessage(bad.bob.writeMessage(Buffer.alloc(0)));
  const m3 = bad.alice.writeMessage(Buffer.alloc(0));
  assert.throws(() => bad.bob.readMessage(m3));
  assert.equal(bad.bob.handshakeFinished, false);
});

test('link noise: tampered transport ciphertext and tampered handshake are rejected', () => {
  const { alice, bob } = linkPair('XX');
  runHandshake(alice, bob);
  const wire = alice.writeTransport(Buffer.from('secret plans'));
  const tampered = Buffer.from(wire);
  tampered[3] ^= 0xff;
  assert.throws(() => bob.readTransport(tampered));

  const p2 = linkPair('XX');
  const hm1 = p2.alice.writeMessage(Buffer.alloc(0));
  p2.bob.readMessage(hm1);
  const hm2 = Buffer.from(p2.bob.writeMessage(Buffer.from('x')));
  hm2[hm2.length - 1] ^= 0x01;
  assert.throws(() => p2.alice.readMessage(hm2));
});

test('link noise: mismatched prologues cannot finish the handshake', () => {
  const { alice, bob } = linkPair('XX', {
    alice: { prologue: Buffer.from('muser-link-v1') },
    bob: { prologue: Buffer.from('muser-link-v2') },
  });
  bob.readMessage(alice.writeMessage(Buffer.alloc(0))); // message 1 is unencrypted
  const m2 = bob.writeMessage(Buffer.alloc(0));
  assert.throws(() => alice.readMessage(m2));
});

test('link noise: out-of-order calls and oversized messages throw', () => {
  const { alice, bob } = linkPair('XX');
  assert.throws(() => bob.writeMessage(Buffer.alloc(0)), /out-of-order/);
  assert.throws(() => alice.readMessage(Buffer.alloc(32)), /out-of-order/);
  assert.throws(() => alice.writeTransport(Buffer.from('early')), /not finished/);
  assert.throws(() => alice.writeMessage(Buffer.alloc(70000)), /65535/);
  runHandshake(alice, bob);
  assert.throws(() => alice.writeTransport(Buffer.alloc(65520)), /65519/);
  assert.throws(() => alice.readTransport(Buffer.alloc(65536)), /65535/);
  assert.throws(() => new NoiseConnection({ pattern: 'XXpsk3', initiator: true, staticKeyPair: genLinkKeys() }), /psk/);
});

test('link noise: encodeFrames/FrameDecoder and chunkPayload round-trips', () => {
  for (const n of [0, 65519, 65520, 200000]) {
    const buf = patterned(n);
    const pieces = chunkPayload(buf);
    assert.ok(pieces.every(p => p.length <= 65519), `chunk size for ${n}`);
    assert.deepEqual(Buffer.concat(pieces), buf);
    const frames = encodeFrames(buf);
    // Every frame must fit a single transport message (<= 65519 plaintext).
    assert.ok(frames.every(f => f.length <= 65519), `frame size for ${n}`);
    const dec = new FrameDecoder();
    let out = null;
    frames.forEach((f, i) => {
      const r = dec.push(f);
      if (i < frames.length - 1) assert.equal(r, null);
      else out = r;
    });
    assert.deepEqual(out, buf, `framing round-trip for ${n}`);
  }
});

test('link noise: a framed 200000-byte payload crosses a live XX connection', () => {
  const { alice, bob } = linkPair('XX');
  runHandshake(alice, bob);
  const buf = patterned(200000);
  const dec = new FrameDecoder();
  let out = null;
  for (const frame of encodeFrames(buf)) {
    out = dec.push(bob.readTransport(alice.writeTransport(frame))) || out;
  }
  assert.deepEqual(out, buf);
});
