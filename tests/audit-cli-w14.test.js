'use strict';
// Audit-cli wave 14 regression tests:
// (1) secure-store: a .enc file holding its ciphertext as base64 TEXT (BOM /
//     line breaks included) is recovered on load and rewritten in raw form;
//     plainly different contents (plain JSON) keep the broken-file error, whose
//     wording now also mentions the file may merely be in a different format.
// (2) muse-client: a socket closed with 4401 (auth expired) rejects pending
//     requests with the auth-expired message, distinct from a plain drop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

const ROOT = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- secure-store (DPAPI faked via spawnSync, as in secure-store-slow) ----------
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w14-'));
test.after(() => { try { fs.rmSync(process.env.LOCALAPPDATA, {recursive: true, force: true}); } catch {} });
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
let plan = [];
cp.spawnSync = (...args) => (plan.length ? plan.shift()(...args) : realSpawnSync(...args));
const store = require('../src/secure-store.js');
test.after(() => { cp.spawnSync = realSpawnSync; });
const fail = () => ({status: 1, stdout: '', stderr: 'Key not valid for use in specified state.'});
const ok = json => () => ({status: 0, stdout: Buffer.from(json).toString('base64'), stderr: ''});
function seed(name, content) { fs.mkdirSync(store.DIR, {recursive: true}); fs.writeFileSync(store.file(name), content); }

test('w14 secure-store: base64-text .enc (BOM + line breaks) recovers and is rewritten raw', () => {
  const cipher = Buffer.from([0x01, 0x00, 0x00, 0x00, 0xd0, 0x8c, 0x9d, 0xdf, 0x01, 0x02, 0x03, 0xfa, 0xfb, 0x00, 0x77, 0x42]);
  const b64 = cipher.toString('base64');
  const wrapped = b64.match(/.{1,8}/g).join('\r\n');
  seed('w14a.enc', '\uFEFF' + wrapped + '\n');
  plan = [fail, ok('{"v":2}')]; // raw attempt fails, decoded-bytes attempt succeeds
  assert.deepEqual(store.load('w14a.enc'), {v: 2});
  assert.equal(plan.length, 0, 'exactly the raw + decoded attempts ran');
  assert.deepEqual(fs.readFileSync(store.file('w14a.enc')), cipher, 'the file was rewritten in the proper raw-binary form');
});

test('w14 secure-store: plain JSON content still errors, wording mentions a mere format difference', () => {
  seed('w14b.enc', JSON.stringify({plain: true}));
  plan = [fail];
  assert.throws(() => store.load('w14b.enc'), err => {
    assert.match(err.message, /壊れているか/);
    assert.match(err.message, /保存形式が想定と違うだけ/);
    return true;
  });
  assert.equal(plan.length, 0, 'no guessing DPAPI call was spent on non-base64 content');
  assert.equal(fs.readFileSync(store.file('w14b.enc'), 'utf8'), JSON.stringify({plain: true}), 'the file was left untouched');
});

test('w14 secure-store: base64 text whose decoded bytes do not decrypt still errors and is not rewritten', () => {
  const text = Buffer.from('not a dpapi blob at all').toString('base64');
  seed('w14c.enc', text);
  plan = [fail, fail];
  assert.throws(() => store.load('w14c.enc'), /保存形式が想定と違うだけ/);
  assert.equal(plan.length, 0, 'both the raw and decoded attempts ran');
  assert.equal(fs.readFileSync(store.file('w14c.enc'), 'utf8'), text, 'a failed recovery does not rewrite the file');
});

// ---------- muse-client (ws + noise faked through require.cache) ----------
class FakeWebSocket extends EventEmitter {
  static instances = [];
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { super(); this.url = String(url); this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 2; }
  terminate() { this.readyState = 3; }
  ping() {}
}
const wsPath = require.resolve('ws', {paths: [path.join(ROOT, 'src', 'core')]});
require.cache[wsPath] = {id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket};
class FakeNoise {
  constructor() { this.remoteStatic = Buffer.alloc(32, 7); }
  message1() { return Buffer.from('m1'); }
  message2() { return Buffer.from('payload'); }
  message3() { return {message: Buffer.from('m3'), tx: {}, rx: {}}; }
}
class FakeTransport { decode(d) { return d; } destroy() {} reset() { return []; } request() { return {id: 1n, frames: []}; } }
const noisePath = path.join(ROOT, 'src', 'core', 'noise.js');
require.cache[noisePath] = {id: noisePath, filename: noisePath, loaded: true, exports: {NoiseXX: FakeNoise, Transport: FakeTransport, fields: () => null, first: () => null}};
const {MuseClient} = require('../src/core/muse-client');
const CREDS = {gateway: 'https://hatch.metaaivm.com', vmId: 'vm1', appId: 'a', token: 'tok', source: 'login'};
async function establish(c) {
  const p = c.open(); p.catch(() => {});
  await wait(20);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.readyState = 1; ws.emit('open'); ws.emit('message', Buffer.from('m2'));
  await p;
  assert.equal(c.status, 'connected');
  return ws;
}

test('w14 muse-client: a 4401 close rejects pending requests as auth-expired, not a plain drop', async () => {
  FakeWebSocket.instances = [];
  const c = new MuseClient({credentials: CREDS, fetchJson: null});
  const ws = await establish(c);
  const p = c.request('GET', '/api/session/list'); p.catch(() => {});
  assert.equal(c.pending.size, 1);
  ws.emit('close', 4401, Buffer.from('auth expired'));
  await assert.rejects(p, /認証が切れています/);
  assert.equal(c.status, 'auth_required');
});

test('w14 muse-client: an ordinary close still rejects pending requests with the generic message', async () => {
  FakeWebSocket.instances = [];
  const c = new MuseClient({credentials: CREDS, fetchJson: null});
  const ws = await establish(c);
  const p = c.request('GET', '/api/session/list'); p.catch(() => {});
  ws.emit('close', 1006, Buffer.from(''));
  await assert.rejects(p, err => {
    assert.match(err.message, /接続が終了しました/);
    assert.doesNotMatch(err.message, /認証が切れています/);
    return true;
  });
  assert.equal(c.status, 'disconnected');
});
