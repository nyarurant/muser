'use strict';
// Noise secure channel for muser link (remote/DESIGN.md, build step 1).
//
// Implements the Noise Protocol Framework (revision 34) patterns
//   Noise_XX_25519_AESGCM_SHA256
//   Noise_XXpsk3_25519_AESGCM_SHA256
// with node:crypto only: X25519 DH, AES-256-GCM, SHA-256 / HMAC-SHA-256.
// Keys cross the API as raw 32-byte buffers; internally they are imported
// as JWK OKP keys (x = public, d = private, base64url).
//
// Wire shape: each handshake or transport message is one Noise message
// (<= 65535 bytes). Application payloads larger than one transport message
// are framed by the link layer with encodeFrames()/FrameDecoder BEFORE
// writeTransport(): one frame per transport message, frame = 1 flags byte
// (bit0 = final) + a chunk of at most 65518 bytes, so a frame always fits
// the 65519-byte transport plaintext limit.
const crypto = require('node:crypto');

const HASHLEN = 32;
const TAGLEN = 16;
const MAX_MESSAGE = 65535; // Noise message length limit (spec section 12.3)
const MAX_TRANSPORT_PLAINTEXT = MAX_MESSAGE - TAGLEN; // 65519
const MAX_FRAME_CHUNK = MAX_TRANSPORT_PLAINTEXT - 1; // frame = flags byte + chunk
// Reassembly cap (audit #89): a peer streaming non-final frames forever must
// not grow the decoder without bound. 32 MiB is far above any legitimate
// link payload (requests are small JSON; the relay's own per-minute byte
// budget is 32 MiB), and the parts are dropped when the cap trips so the
// memory is actually released.
const MAX_ASSEMBLED_PAYLOAD = 32 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

const PROTOCOL_NAMES = {
  XX: 'Noise_XX_25519_AESGCM_SHA256',
  XXpsk3: 'Noise_XXpsk3_25519_AESGCM_SHA256',
};

// Message token patterns (Noise spec section 9). XXpsk3's modifier adds the
// "psk" token at the end of message 3: -> s, se, psk.
const MESSAGE_PATTERNS = [
  ['e'],
  ['e', 'ee', 's', 'es'],
  ['s', 'se'],
];
// Bytes a handshake message adds around the payload, per message index:
// msg1: e (32, payload still unencrypted); msg2: e (32) + encrypted s (48)
// + payload tag (16); msg3: encrypted s (48) + payload tag (16).
const HANDSHAKE_OVERHEAD = [32, 96, 64];

function hash(data) {
  return crypto.createHash('sha256').update(data).digest();
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// Noise HKDF (spec 4.3): salt is the chaining key, no info string.
// Returns an array of `numOutputs` 32-byte buffers.
function hkdfNoise(salt, ikm, numOutputs) {
  const tempKey = hmac(salt, ikm);
  const out1 = hmac(tempKey, Buffer.from([0x01]));
  if (numOutputs === 1) return [out1];
  const out2 = hmac(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  if (numOutputs === 2) return [out1, out2];
  const out3 = hmac(tempKey, Buffer.concat([out2, Buffer.from([0x03])]));
  return [out1, out2, out3];
}

// --- X25519 keys, raw <-> KeyObject ---------------------------------------

function generateStaticKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: Buffer.from(pubJwk.x, 'base64url'),
    privateKey: Buffer.from(privJwk.d, 'base64url'),
  };
}

function publicKeyObject(rawPublic) {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: rawPublic.toString('base64url') },
    format: 'jwk',
  });
}
function privateKeyObject(keyPair) {
  // JWK private OKP keys must carry x alongside d.
  return crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: keyPair.publicKey.toString('base64url'),
      d: keyPair.privateKey.toString('base64url'),
    },
    format: 'jwk',
  });
}
function dh(localKeyPair, rawRemotePublic) {
  if (!Buffer.isBuffer(rawRemotePublic) || rawRemotePublic.length !== 32) {
    throw new Error('noise: remote public key must be 32 bytes');
  }
  const shared = crypto.diffieHellman({
    privateKey: privateKeyObject(localKeyPair),
    publicKey: publicKeyObject(rawRemotePublic),
  });
  // Reject low-order remote keys (all-zero shared secret).
  if (shared.equals(Buffer.alloc(32))) throw new Error('noise: DH failed (low-order remote key)');
  return shared;
}

function checkKeyPair(kp, what) {
  if (!kp || !Buffer.isBuffer(kp.publicKey) || kp.publicKey.length !== 32 ||
      !Buffer.isBuffer(kp.privateKey) || kp.privateKey.length !== 32) {
    throw new Error(`noise: ${what} must be {publicKey, privateKey} raw 32-byte buffers`);
  }
  return { publicKey: Buffer.from(kp.publicKey), privateKey: Buffer.from(kp.privateKey) };
}

// --- CipherState / SymmetricState (spec sections 5.1 / 5.2) ---------------

class CipherState {
  constructor() {
    this.k = null;
    this.n = 0n; // 64-bit nonce counter
  }
  initializeKey(key) {
    this.k = key ? Buffer.from(key) : null;
    this.n = 0n;
  }
  get hasKey() { return this.k !== null; }
  nonceBytes() {
    if (this.n >= (1n << 64n) - 1n) throw new Error('noise: nonce exhausted');
    const nonce = Buffer.alloc(12); // 4 leading zero bytes + 64-bit little-endian counter
    nonce.writeBigUInt64LE(this.n, 4);
    this.n += 1n;
    return nonce;
  }
  encryptWithAd(ad, plaintext) {
    if (!this.k) return plaintext;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.k, this.nonceBytes());
    cipher.setAAD(ad);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }
  decryptWithAd(ad, ciphertext) {
    if (!this.k) return ciphertext;
    if (ciphertext.length < TAGLEN) throw new Error('noise: ciphertext shorter than AEAD tag');
    const nonce = this.nonceBytes();
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.k, nonce);
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
    // final() throws on a bad tag; the nonce stays consumed, the state is dead either way.
    return Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)),
      decipher.final(),
    ]);
  }
}

class SymmetricState {
  constructor(protocolName) {
    const name = Buffer.from(protocolName, 'utf8');
    if (name.length <= HASHLEN) {
      this.h = Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]);
    } else {
      this.h = hash(name);
    }
    this.ck = this.h;
    this.cipher = new CipherState();
  }
  mixHash(data) {
    this.h = hash(Buffer.concat([this.h, data]));
  }
  mixKey(ikm) {
    const [ck, tempK] = hkdfNoise(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher.initializeKey(tempK.subarray(0, 32));
  }
  mixKeyAndHash(ikm) {
    const [ck, tempH, tempK] = hkdfNoise(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher.initializeKey(tempK.subarray(0, 32));
  }
  encryptAndHash(plaintext) {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }
  decryptAndHash(ciphertext) {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }
  split() {
    const [tempK1, tempK2] = hkdfNoise(this.ck, EMPTY, 2);
    const c1 = new CipherState();
    c1.initializeKey(tempK1.subarray(0, 32));
    const c2 = new CipherState();
    c2.initializeKey(tempK2.subarray(0, 32));
    return [c1, c2];
  }
}

// --- PSK from a pairing code ----------------------------------------------

// HKDF-SHA-256 over the typed pairing code (DESIGN.md: "the PSK is HKDF(code)").
function pskFromCode(code) {
  if (typeof code !== 'string') throw new Error('noise: pairing code must be a string');
  return Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.from(code, 'utf8'), Buffer.from('muser-link'), Buffer.alloc(0), 32));
}

// --- NoiseConnection -------------------------------------------------------

class NoiseConnection {
  constructor({ pattern, initiator, staticKeyPair, psk, prologue } = {}) {
    if (!Object.prototype.hasOwnProperty.call(PROTOCOL_NAMES, pattern)) {
      throw new Error(`noise: unsupported pattern ${JSON.stringify(pattern)} (want 'XX' or 'XXpsk3')`);
    }
    if (typeof initiator !== 'boolean') throw new Error('noise: initiator must be a boolean');
    this.pattern = pattern;
    this.initiator = initiator;
    this.s = checkKeyPair(staticKeyPair, 'staticKeyPair');
    if (pattern === 'XXpsk3') {
      if (!Buffer.isBuffer(psk) || psk.length !== 32) {
        throw new Error('noise: XXpsk3 requires a 32-byte psk (see pskFromCode)');
      }
      this.psk = Buffer.from(psk);
    } else {
      if (psk !== undefined && psk !== null) throw new Error('noise: pattern XX takes no psk');
      this.psk = null;
    }
    if (prologue !== undefined && prologue !== null && !Buffer.isBuffer(prologue)) {
      throw new Error('noise: prologue must be a Buffer');
    }
    this.e = null; // local ephemeral key pair
    this.re = null; // remote ephemeral public key
    this.rs = null; // remote static public key
    this.sym = new SymmetricState(PROTOCOL_NAMES[pattern]);
    this.sym.mixHash(prologue ? Buffer.from(prologue) : EMPTY);
    // XX has no pre-messages, so nothing else is mixed at init.
    this.messageIndex = 0; // next handshake message, 0..2
    this.finished = false;
    this.sending = null;
    this.receiving = null;
  }

  get handshakeFinished() { return this.finished; }
  get remoteStatic() { return this.rs ? Buffer.from(this.rs) : null; }

  tokensFor(index) {
    const tokens = MESSAGE_PATTERNS[index].slice();
    if (this.pattern === 'XXpsk3' && index === 2) tokens.push('psk');
    return tokens;
  }
  // Message i is written by the initiator for even i, the responder for odd i.
  isMyWriteTurn(index) { return (index % 2 === 0) === this.initiator; }

  // One DH token, identical on the write and read paths: roles are fixed.
  applyDhToken(token) {
    if (token === 'ee') {
      this.sym.mixKey(dh(this.e, this.re));
    } else if (token === 'es') {
      // initiator: DH(e, rs); responder: DH(s, re)
      this.sym.mixKey(this.initiator ? dh(this.e, this.rs) : dh(this.s, this.re));
    } else if (token === 'se') {
      // initiator: DH(s, re); responder: DH(e, rs)
      this.sym.mixKey(this.initiator ? dh(this.s, this.re) : dh(this.e, this.rs));
    }
  }

  advance() {
    this.messageIndex += 1;
    if (this.messageIndex === 3) {
      const [c1, c2] = this.sym.split();
      this.sending = this.initiator ? c1 : c2;
      this.receiving = this.initiator ? c2 : c1;
      this.finished = true;
      this.sym = null;
    }
  }

  writeMessage(payload) {
    if (this.finished) throw new Error('noise: handshake already finished');
    if (!Buffer.isBuffer(payload)) throw new Error('noise: handshake payload must be a Buffer');
    const index = this.messageIndex;
    if (!this.isMyWriteTurn(index)) throw new Error(`noise: out-of-order writeMessage (message ${index + 1} is the peer's)`);
    if (payload.length + HANDSHAKE_OVERHEAD[index] > MAX_MESSAGE) {
      throw new Error('noise: handshake message would exceed 65535 bytes');
    }
    const parts = [];
    for (const token of this.tokensFor(index)) {
      if (token === 'e') {
        this.e = generateStaticKeyPair();
        parts.push(this.e.publicKey);
        this.sym.mixHash(this.e.publicKey);
      } else if (token === 's') {
        parts.push(this.sym.encryptAndHash(this.s.publicKey));
      } else if (token === 'psk') {
        this.sym.mixKeyAndHash(this.psk);
      } else { // ee / es / se
        this.applyDhToken(token);
      }
    }
    parts.push(this.sym.encryptAndHash(payload));
    const message = Buffer.concat(parts);
    if (message.length > MAX_MESSAGE) throw new Error('noise: handshake message exceeds 65535 bytes');
    this.advance();
    return message;
  }

  readMessage(message) {
    if (this.finished) throw new Error('noise: handshake already finished');
    if (!Buffer.isBuffer(message)) throw new Error('noise: handshake message must be a Buffer');
    const index = this.messageIndex;
    if (this.isMyWriteTurn(index)) throw new Error(`noise: out-of-order readMessage (message ${index + 1} is ours to write)`);
    if (message.length > MAX_MESSAGE) throw new Error('noise: handshake message exceeds 65535 bytes');
    let offset = 0;
    const take = (n, what) => {
      if (message.length - offset < n) throw new Error(`noise: handshake message too short for ${what}`);
      const part = message.subarray(offset, offset + n);
      offset += n;
      return part;
    };
    for (const token of this.tokensFor(index)) {
      if (token === 'e') {
        this.re = Buffer.from(take(32, 'ephemeral key'));
        this.sym.mixHash(this.re);
      } else if (token === 's') {
        const encLen = 32 + (this.sym.cipher.hasKey ? TAGLEN : 0);
        const rs = this.sym.decryptAndHash(take(encLen, 'static key'));
        if (rs.length !== 32) throw new Error('noise: decrypted static key is not 32 bytes');
        this.rs = Buffer.from(rs);
      } else if (token === 'psk') {
        this.sym.mixKeyAndHash(this.psk);
      } else { // ee / es / se
        this.applyDhToken(token);
      }
    }
    const payload = this.sym.decryptAndHash(message.subarray(offset));
    this.advance();
    return payload;
  }

  writeTransport(plaintext) {
    if (!this.finished) throw new Error('noise: handshake not finished');
    if (!Buffer.isBuffer(plaintext)) throw new Error('noise: transport plaintext must be a Buffer');
    if (plaintext.length > MAX_TRANSPORT_PLAINTEXT) {
      throw new Error(`noise: transport plaintext exceeds ${MAX_TRANSPORT_PLAINTEXT} bytes`);
    }
    return this.sending.encryptWithAd(EMPTY, plaintext);
  }

  readTransport(message) {
    if (!this.finished) throw new Error('noise: handshake not finished');
    if (!Buffer.isBuffer(message)) throw new Error('noise: transport message must be a Buffer');
    if (message.length > MAX_MESSAGE) throw new Error('noise: transport message exceeds 65535 bytes');
    return this.receiving.decryptWithAd(EMPTY, message);
  }
}

// --- Application framing (link layer, before writeTransport) ---------------

// Split an application payload into pieces of at most 65519 bytes.
// An empty payload yields one empty piece, so it still sends as one message.
function chunkPayload(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('noise: chunkPayload expects a Buffer');
  if (buf.length === 0) return [Buffer.alloc(0)];
  const chunks = [];
  for (let off = 0; off < buf.length; off += MAX_TRANSPORT_PLAINTEXT) {
    chunks.push(Buffer.from(buf.subarray(off, Math.min(off + MAX_TRANSPORT_PLAINTEXT, buf.length))));
  }
  return chunks;
}

// Frame an application payload for the link layer: each frame is
// [1 byte flags (bit0 = final)] + a chunk of at most 65518 bytes, so every
// frame fits one transport message. A 0-byte payload is one final empty frame.
function encodeFrames(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('noise: encodeFrames expects a Buffer');
  if (buf.length === 0) return [Buffer.from([0x01])];
  const frames = [];
  for (let off = 0; off < buf.length; off += MAX_FRAME_CHUNK) {
    const end = Math.min(off + MAX_FRAME_CHUNK, buf.length);
    const header = Buffer.from([end === buf.length ? 0x01 : 0x00]);
    frames.push(Buffer.concat([header, buf.subarray(off, end)]));
  }
  return frames;
}

class FrameDecoder {
  constructor() {
    this.parts = [];
    this.bytes = 0;
  }
  // Returns the full payload when the final frame arrives, otherwise null.
  push(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 1) throw new Error('noise: frame must be at least 1 byte');
    const flags = frame[0];
    if (flags & ~0x01) throw new Error(`noise: unknown frame flags 0x${flags.toString(16)}`);
    this.bytes += frame.length - 1;
    if (this.bytes > MAX_ASSEMBLED_PAYLOAD) {
      this.parts = [];
      this.bytes = 0;
      throw new Error(`noise: assembled payload exceeds ${MAX_ASSEMBLED_PAYLOAD} bytes`);
    }
    this.parts.push(Buffer.from(frame.subarray(1)));
    if (!(flags & 0x01)) return null;
    const payload = Buffer.concat(this.parts);
    this.parts = [];
    this.bytes = 0;
    return payload;
  }
}

// Same reassembly with the split kept explicit; FrameDecoder is the framed form.
class ChunkReassembler {
  constructor() {
    this.parts = [];
    this.bytes = 0;
  }
  push(piece, isLast) {
    if (!Buffer.isBuffer(piece)) throw new Error('noise: chunk piece must be a Buffer');
    this.bytes += piece.length;
    if (this.bytes > MAX_ASSEMBLED_PAYLOAD) {
      this.parts = [];
      this.bytes = 0;
      throw new Error(`noise: assembled payload exceeds ${MAX_ASSEMBLED_PAYLOAD} bytes`);
    }
    this.parts.push(Buffer.from(piece));
    if (!isLast) return null;
    const payload = Buffer.concat(this.parts);
    this.parts = [];
    this.bytes = 0;
    return payload;
  }
}

module.exports = {
  generateStaticKeyPair,
  pskFromCode,
  NoiseConnection,
  chunkPayload,
  encodeFrames,
  FrameDecoder,
  ChunkReassembler,
  MAX_MESSAGE,
  MAX_TRANSPORT_PLAINTEXT,
  MAX_ASSEMBLED_PAYLOAD,
};
