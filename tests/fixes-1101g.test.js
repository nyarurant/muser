'use strict';
// Seventh sweep of 2026-11-01: agent-reply outcomes, a Noise loopback, and a
// behavioural secure-store round-trip (replacing reliance on a source regex).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {waitForReply} = require('../src/core/agent-reply');
const {NoiseXX, Cipher, Transport, cat, bytes, uint, fields, first} = require('../src/core/noise');

const wait = ms => new Promise(r => setTimeout(r, ms));
const ev = (id, text, extra = {}) => ({message_id: id, role: 'assistant', display_text: text, seq: 1, ...extra});
function fakeClient({status = 'completed', events = []} = {}) {
  const c = new EventEmitter();
  c.history = async () => ({chat_events: typeof events === 'function' ? events() : events});
  c.request = async () => ({session: {status: typeof status === 'function' ? status() : status}});
  return c;
}
const opts = {sessionId: 's1', pollMs: 20, settleMs: 0, timeoutMs: 3000};

test('agent-reply: a FAILED session status ends the wait with the status named', async () => {
  for (const status of ['failed', 'cancelled']) {
    const w = waitForReply({client: fakeClient({status}), ...opts});
    w.accept('');
    await assert.rejects(w.promise, new RegExp('作業が終了しました \\(' + status + '\\)'));
  }
});

test('agent-reply: display_text_ready=false holds the reply until it flips ready', async () => {
  let ready = false;
  const client = fakeClient({events: () => [{...ev('m1', 'done'), display_text_ready: ready}]});
  const w = waitForReply({client, ...opts});
  let settled = false; void w.promise.then(() => { settled = true; }, () => { settled = true; });
  w.accept('');
  await wait(160);
  assert.equal(settled, false, 'not ready, not delivered');
  ready = true;
  assert.equal((await w.promise).text, 'done');
});

test('agent-reply: with accept(id), replies to a different message are skipped', async () => {
  const client = fakeClient({events: [
    ev('m1', 'wrong thread', {seq: 1, reply_to_message_id: 'other'}),
    ev('m2', 'right thread', {seq: 2, reply_to_message_id: 'want'}),
  ]});
  const w = waitForReply({client, ...opts});
  w.accept('want');
  const r = await w.promise;
  assert.equal(r.text, 'right thread');
});

test('agent-reply: auth_required ends the wait', async () => {
  const client = fakeClient({status: 'running'});
  const w = waitForReply({client, ...opts});
  w.accept('');
  client.emit('status', {status: 'auth_required'});
  await assert.rejects(w.promise, /ログインが切れた/);
});

test('agent-reply: abort rejects with AbortError', async () => {
  const controller = new AbortController();
  const w = waitForReply({client: fakeClient({status: 'running'}), ...opts, signal: controller.signal});
  w.accept('');
  controller.abort();
  await assert.rejects(w.promise, e => e && e.name === 'AbortError');
});

test('agent-reply: a busy session times out', async () => {
  const w = waitForReply({client: fakeClient({status: 'running'}), ...opts, timeoutMs: 120});
  w.accept('');
  await assert.rejects(w.promise, /タイムアウト/);
});

test('agent-reply: with no live reply segment, several assistant messages resolve to the latest only', async () => {
  // 2026-11-08 (reply-split): messages streamed in the turn's last segment
  // now join (tests/reply-split.test.js). Without that segment (a poll-only
  // recovery) earlier messages may be pre-tool narration, so the latest alone
  // stays the reply, as before.
  const client = fakeClient({events: [ev('m1', 'first', {seq: 1}), ev('m2', 'second', {seq: 2})]});
  const w = waitForReply({client, ...opts});
  w.accept('');
  const r = await w.promise;
  assert.equal(r.text, 'second', 'not a concatenation of the turn');
  assert.deepEqual(r.messageIds, ['m2']);
});

// --- Noise loopback: NoiseXX is initiator-only in the client, so the responder
// side is driven here with the same mixHash/mixKey/encrypt primitives plus
// node:crypto X25519 helpers, exactly as the gateway side behaves.
const EMPTY = Buffer.alloc(0);
const rawKey = key => key.export({type: 'spki', format: 'der'}).subarray(-32);
function dh(privateKey, raw) {
  const publicKey = crypto.createPublicKey({key: cat(Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(raw)), format: 'der', type: 'spki'});
  return crypto.diffieHellman({privateKey, publicKey});
}
function hkdfSplit(ck) {
  const hmac = (k, b) => crypto.createHmac('sha256', k).update(b).digest();
  const tmp = hmac(ck, EMPTY), a = hmac(tmp, Buffer.from([1]));
  return [a, hmac(tmp, cat(a, Buffer.from([2])))];
}
function wireFrame(bodyText) {
  const frame = cat(uint(1, 9n), bytes(4, cat(bytes(1, Buffer.from(bodyText)), uint(2, 1))));
  return cat(uint(1, 42n), uint(2, 0), uint(3, 1), bytes(4, bytes(1, frame)));
}

test('noise: two peers complete XX, transports round-trip, a tampered cipher dies', () => {
  const initiator = new NoiseXX();
  const msg1 = initiator.message1();
  const responder = new NoiseXX();
  const remoteEph = Buffer.from(msg1.subarray(0, 32));
  responder.mixHash(remoteEph);
  assert.ok(responder.decrypt(msg1.subarray(32)).length > 0, 'msg1 payload readable');
  responder.ephemeral = crypto.generateKeyPairSync('x25519');
  const pubR = rawKey(responder.ephemeral.publicKey);
  responder.mixHash(pubR);
  responder.mixKey(dh(responder.ephemeral.privateKey, remoteEph));
  const staticR = crypto.generateKeyPairSync('x25519');
  const encStatic = responder.encrypt(rawKey(staticR.publicKey));
  responder.mixKey(dh(staticR.privateKey, remoteEph));
  const msg2 = cat(pubR, encStatic, responder.encrypt(bytes(1, Buffer.from('from responder'))));
  const payload = initiator.message2(msg2);
  assert.equal(first(fields(payload), 1).toString(), 'from responder');
  const keys = initiator.message3(bytes(1, Buffer.from('from initiator')));
  const staticI = responder.decrypt(keys.message.subarray(0, 48));
  responder.mixKey(dh(responder.ephemeral.privateKey, staticI));
  const payload3 = responder.decrypt(keys.message.subarray(48));
  assert.equal(first(fields(payload3), 1).toString(), 'from initiator');
  const [k1, k2] = hkdfSplit(responder.ck);
  const tInit = new Transport(keys.tx, keys.rx);
  const tResp = new Transport(new Cipher(k2), new Cipher(k1));
  const out1 = tInit.decode(tResp.tx.encrypt(EMPTY, wireFrame('hi')));
  assert.deepEqual([out1.type, out1.body.toString(), out1.end], ['body', 'hi', true]);
  const out2 = tResp.decode(tInit.tx.encrypt(EMPTY, wireFrame('yo')));
  assert.deepEqual([out2.type, out2.body.toString(), out2.end], ['body', 'yo', true]);
  tInit.destroy(); tResp.destroy();
  // Tamper: GCM verification fails and the cipher is dead from then on.
  const key = crypto.randomBytes(32);
  const enc = new Cipher(Buffer.from(key)), dec = new Cipher(Buffer.from(key));
  const ct = enc.encrypt(EMPTY, Buffer.from('secret'));
  const bad = Buffer.from(ct); bad[bad.length - 1] ^= 1;
  assert.throws(() => dec.decrypt(EMPTY, bad));
  assert.equal(dec.dead, true);
  assert.throws(() => dec.decrypt(EMPTY, ct), /unavailable/);
});

test('secure-store: save/load round-trip in the scratch dir, no temp file left', t => {
  const store = require('../src/secure-store');
  assert.ok(store.DIR.startsWith(os.tmpdir()), 'setup points LOCALAPPDATA at a scratch dir: ' + store.DIR);
  const name = 'fixes-1101g-roundtrip.json';
  t.after(() => store.remove(name));
  store.save(name, {n: 1, text: '日本語テスト'});
  assert.deepEqual(store.load(name), {n: 1, text: '日本語テスト'});
  // A fresh process has no in-memory cache, so this load really decrypts the file.
  const {execFileSync} = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/secure-store').load('fixes-1101g-roundtrip.json')))"] , {cwd: path.join(__dirname, '..'), env: {...process.env}, encoding: 'utf8', timeout: 30000});
  assert.deepEqual(JSON.parse(out.trim()), {n: 1, text: '日本語テスト'});
  store.save(name, {n: 2});
  assert.deepEqual(store.load(name), {n: 2});
  assert.deepEqual(fs.readdirSync(store.DIR).filter(f => f.includes('.tmp')), [], 'no leftover temp files');
  store.remove(name);
  assert.equal(store.load(name), null);
});
