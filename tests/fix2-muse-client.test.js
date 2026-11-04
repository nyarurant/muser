'use strict';
// Fix phase 2 regression tests for src/core/muse-client.js and src/desktop-import.js:
// deep (work2/c12) #94-#100, fifth f2-1 (client side), f2-3, f3-6 (client side).
// The ws and noise modules are faked through require.cache BEFORE muse-client
// loads, so open()/handshake tests run fully in-process (no real gateway).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');

const wait = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

class FakeWebSocket extends EventEmitter {
  static instances = [];
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { super(); this.url = String(url); this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(d) { if (this.throwOnSend) throw new Error('send boom'); this.sent.push(d); }
  close() { this.readyState = 2; }
  terminate() { this.readyState = 3; }
  ping() { this.pings = (this.pings || 0) + 1; }
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
  assert.ok(ws, 'open() created a socket');
  ws.readyState = 1; ws.emit('open'); ws.emit('message', Buffer.from('m2'));
  await p;
  assert.equal(c.status, 'connected');
  return ws;
}
function fakeConnected() {
  const c = new MuseClient({credentials: {appId: 'a', vmId: 'vm1'}, fetchJson: null});
  c.status = 'connected';
  let nextId = 0n;
  const sent = {frames: [], resets: []};
  c.ws = {readyState: 1, send: f => sent.frames.push(f), on() {}, once() {}, close() {}};
  c.transport = {request: () => ({id: ++nextId, frames: ['f']}), reset: id => { sent.resets.push(id); return ['r']; }, destroy() {}};
  return {c, sent};
}

// --- deep #94: probeLogin error classification --------------------------------
test('deep#94 muse-client: probeLogin treats parse/timeout/network failures as error, not a lapsed login', async () => {
  const thrower = props => async () => { throw Object.assign(new Error('x'), props); };
  const mk = fetchJson => new MuseClient({credentials: null, fetchJson});
  assert.equal(await mk(thrower({parse: true, status: 200})).probeLogin(), 'error', 'a 200 garbage body is not "waiting for login"');
  assert.equal(await mk(thrower({timeout: true, status: 200})).probeLogin(), 'error', 'a body-read timeout is not "waiting" either');
  assert.equal(await mk(thrower({status: 503})).probeLogin(), 'error');
  assert.equal(await mk(thrower({status: 401})).probeLogin(), 'waiting', 'an HTTP refusal still means not signed in');
  const tokenThrows = props => async route => {
    if (route.startsWith('/api/session')) return {endpoint_url: 'https://vm1.metaaivm.com', vm_id: 'vm1', vm_name: 'V'};
    throw Object.assign(new Error('x'), props);
  };
  assert.equal(await mk(tokenThrows({network: true})).probeLogin(), 'error', 'a network failure at the token stage is not a token problem');
  assert.equal(await mk(tokenThrows({parse: true, status: 200})).probeLogin(), 'error');
  assert.equal(await mk(tokenThrows({status: 503})).probeLogin(), 'error');
  assert.equal(await mk(tokenThrows({status: 401})).probeLogin(), 'token', 'an HTTP refusal at the token stage stays "token"');
});

// --- deep #98: status stuck at connecting -------------------------------------
test('deep#98 muse-client: a throw before the socket exists leaves status error, not connecting', async () => {
  const c = new MuseClient({credentials: {...CREDS, gateway: 'https://bad.example.com'}, fetchJson: null});
  const states = [];
  c.on('status', s => states.push(s.status));
  await assert.rejects(c.open(), /接続先を確認できません/);
  assert.equal(c.status, 'error');
  assert.deepEqual(states, ['connecting', 'error'], 'the failure was reported as a status event, so reconnect scheduling can start');
});

// --- deep #95: disconnect() vs an in-flight open() -----------------------------
test('deep#95 muse-client: disconnect during the credential-refresh wait stops open() before any socket', async () => {
  FakeWebSocket.instances = [];
  const hang = () => new Promise(() => {});
  const c = new MuseClient({credentials: {...CREDS, gateway: 'https://bad.example.com'}, fetchJson: hang});
  const p = c.open(); p.catch(() => {});
  await wait(100);
  c.disconnect(false);
  await assert.rejects(p, /接続が終了しました/, 'the cancelled open rejects instead of proceeding to the gateway check');
  assert.equal(FakeWebSocket.instances.length, 0, 'no socket was created after the disconnect');
});

test('deep#95 muse-client: disconnect during the handshake settles open() at once, not at the 20 s timeout', async () => {
  FakeWebSocket.instances = [];
  const c = new MuseClient({credentials: CREDS, fetchJson: null});
  const p = c.open(); p.catch(() => {});
  await wait(20);
  assert.equal(FakeWebSocket.instances.length, 1, 'the handshake is in flight');
  c.disconnect(false);
  const out = await Promise.race([p.then(() => 'resolved', e => 'rejected: ' + e.message), wait(2000).then(() => 'still pending')]);
  assert.equal(out, 'rejected: Muse の接続が終了しました。');
  assert.equal(c.status, 'disconnected');
});

// --- deep #96: consumer handler exceptions are not bad frames -----------------
test('deep#96 muse-client: a throwing event handler does not count as a bad frame or drop the stream', () => {
  const c = new MuseClient({credentials: {appId: 'a'}, fetchJson: null});
  c.status = 'connected';
  const warnings = [];
  c.on('warning', w => warnings.push(w));
  const origErr = console.error; console.error = () => {};
  try {
    const p = {settled: false, timer: null, resolve() {}, reject() {}, onEvent() { throw new Error('consumer bug'); }};
    for (let i = 0; i < 10; i++) c.recordLine(p, JSON.stringify({type: 'event', event: 'x', payload: {}}));
    assert.equal(c.badFrames, 0, 'handler exceptions never feed the bad-frame counter');
    assert.equal(c.status, 'connected', 'the healthy stream stays up');
    assert.equal(warnings.filter(w => w.type === 'handler-error').length, 10, 'each failure is still reported as a warning');
    const p2 = {settled: false, timer: null, resolve() {}, reject() {}};
    c.recordLine(p2, 'not json');
    assert.equal(c.badFrames, 1, 'a genuinely malformed record still counts');
  } finally { console.error = origErr; c.disconnect(false); }
});

// --- fifth f2-2: bad-frame streak must not survive a reconnect ------------------
test('fifth f2-2 muse-client: a reconnect resets the bad-frame streak', async () => {
  const c = new MuseClient({credentials: {appId: 'a'}, fetchJson: null});
  c.status = 'connected';
  const origErr = console.error; console.error = () => {};
  try {
    const p = () => ({settled: false, timer: null, resolve() {}, reject() {}});
    for (let i = 0; i < 10; i++) c.recordLine(p(), 'not json');
    assert.equal(c.badFrames, 10);
    assert.equal(c.status, 'disconnected', 'ten in a row dropped the old connection');
    FakeWebSocket.instances = [];
    const c2 = Object.assign(c, {credentials: CREDS});
    await establish(c2);
    assert.equal(c.badFrames, 0, 'the new connection starts a fresh streak');
    c.recordLine(p(), 'not json');
    assert.equal(c.badFrames, 1);
    assert.equal(c.status, 'connected', 'one bad record on the new connection is just skipped');
    c.disconnect(false);
  } finally { console.error = origErr; }
});

// --- deep #97: /chat/stream idle bound -----------------------------------------
test('deep#97 muse-client: send() uses a 15-minute stream idle bound; other streams keep 120 s', async () => {
  const {c} = fakeConnected();
  const p = c.send('hi', 's1', 'n1'); p.catch(() => {});
  assert.equal([...c.pending.values()][0].streamIdleMs, 900000, 'a silent long tool run (up to 600 s) is not idled out at 120 s');
  const p2 = c.request('POST', '/other-stream', {}, {stream: true}); p2.catch(() => {});
  assert.equal([...c.pending.values()][1].streamIdleMs, 120000, 'the generic stream default is unchanged');
  c.disconnect(false);
});

// --- deep #99: stream-error on timeout / send failure ---------------------------
test('deep#99 muse-client: a scoped stream timing out before its first record emits stream-error', async () => {
  const {c} = fakeConnected();
  const errors = [];
  c.on('stream-error', e => errors.push(e));
  await assert.rejects(
    c.request('POST', '/chat/subscribe', {session_id: 's1'}, {stream: true, subscriptionScope: 'scope-x', timeout: 40}),
    /タイムアウト/);
  assert.equal(errors.length, 1, 'the resubscribe logic was notified');
  assert.equal(errors[0].path, '/chat/subscribe');
  assert.equal(errors[0].scope, 'scope-x');
  const plain = [];
  c.on('stream-error', e => plain.push(e));
  await assert.rejects(c.request('GET', '/api/session/list', {}, {timeout: 40}), /タイムアウト/);
  assert.equal(plain.length, 0, 'a non-stream request timeout stays a plain rejection');
  c.disconnect(false);
});

test('deep#99 muse-client: a scoped subscription whose send fails emits stream-error', async () => {
  const {c} = fakeConnected();
  const errors = [];
  c.on('stream-error', e => errors.push(e));
  c.ws.send = () => { throw new Error('send boom'); };
  await assert.rejects(c.subscribeAgent('s1', 'scope-x'), /送信中に通信が切れました/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].scope, 'scope-x');
  c.disconnect(false);
});

// --- fifth f2-1: close codes ----------------------------------------------------
test('fifth f2-1 muse-client: an established socket closed with 1008 reports auth_required, not a transient drop', async () => {
  FakeWebSocket.instances = [];
  const c = new MuseClient({credentials: CREDS, fetchJson: null});
  const ws = await establish(c);
  const states = [];
  c.on('status', s => states.push(s.status));
  ws.emit('close', 1008, Buffer.from('policy violation'));
  assert.equal(c.status, 'auth_required', 'the agent stops its reconnect backoff on auth_required');
  assert.deepEqual(states, ['auth_required']);
});

test('fifth f2-1 muse-client: an ordinary close (1006) stays a transient drop', async () => {
  FakeWebSocket.instances = [];
  const c = new MuseClient({credentials: CREDS, fetchJson: null});
  const ws = await establish(c);
  ws.emit('close', 1006, Buffer.from(''));
  assert.equal(c.status, 'disconnected');
});

test('fifth f2-1 muse-client: a 1008 close during the handshake fails as auth_required', async () => {
  FakeWebSocket.instances = [];
  const c = new MuseClient({credentials: CREDS, fetchJson: null});
  const p = c.open(); p.catch(() => {});
  await wait(20);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.emit('close', 1008, Buffer.from('policy violation'));
  await assert.rejects(p, /認証が切れています/);
  assert.equal(c.status, 'auth_required');
  const c2 = new MuseClient({credentials: CREDS, fetchJson: null});
  const p2 = c2.open(); p2.catch(() => {});
  await wait(20);
  const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws2.emit('close', 1006, Buffer.from(''));
  await assert.rejects(p2, /接続が閉じられました/);
  assert.equal(c2.status, 'error', 'a transient handshake close stays a plain error');
});

// --- fifth f2-3 + f3-6 (client side): ping watchdog liveness --------------------
test('fifth f2-3/f3-6 muse-client: frames count as liveness, total silence drops, and a wall-clock step does neither', () => {
  const c = new MuseClient({credentials: {appId: 'a'}, fetchJson: null});
  const ws = new EventEmitter();
  ws.readyState = 1; ws.ping = () => {}; ws.close = () => {}; ws.send = () => {}; ws.terminate = () => {};
  c.ws = ws; c.status = 'connected';
  let pingCb = null;
  const origSI = global.setInterval, origDN = Date.now, origPN = performance.now;
  let elapsed = 0, dateElapsed = 0;
  const perfBase = origPN.call(performance), dateBase = origDN();
  global.setInterval = fn => { pingCb = fn; return {unref() {}}; };
  performance.now = () => perfBase + elapsed;
  Date.now = () => dateBase + dateElapsed;
  try {
    c.startPing(ws);
    global.setInterval = origSI;
    elapsed += 50000; dateElapsed += 50000;
    ws.emit('message', Buffer.from('frame')); // a regular frame at +50 s, no pong ever
    pingCb();
    assert.equal(c.status, 'connected', 'a streaming gateway that never pongs is not dropped');
    dateElapsed += 3600000; // wall clock jumps an hour; monotonic time does not
    pingCb();
    assert.equal(c.status, 'connected', 'a wall-clock step is not a silence');
    elapsed += 50000; dateElapsed += 50000; // now 50 s of real silence since the frame
    pingCb();
    assert.equal(c.status, 'disconnected', 'total silence still drops the socket');
  } finally {
    global.setInterval = origSI; Date.now = origDN; performance.now = origPN;
    clearInterval(c.pingTimer); c.disconnect(false);
  }
});

// --- deep #100: desktop-import structural validation -----------------------------
function dpapiProtect(buf) {
  const script = 'Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {input: buf.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000});
  assert.equal(r.status, 0, 'DPAPI protect works on this PC');
  return Buffer.from(r.stdout.trim(), 'base64');
}

test('deep#100 desktop-import: missing/corrupt desktop files fail with the friendly format messages', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-desktop-'));
  const appDir = path.join(dir, 'Muse App');
  fs.mkdirSync(appDir);
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = dir;
  const modPath = path.join(ROOT, 'src', 'desktop-import.js');
  delete require.cache[modPath];
  t.after(() => { process.env.APPDATA = prevAppData; delete require.cache[modPath]; fs.rmSync(dir, {recursive: true, force: true}); });
  const di = require(modPath);
  const KEY_MSG = /暗号鍵の形式が想定と違います/, DATA_MSG = /保存データの形式が想定と違います/;
  assert.throws(() => di.desktopSdkToken(), KEY_MSG, 'missing Local State is a friendly error, not ENOENT');
  fs.writeFileSync(path.join(appDir, 'Local State'), 'not json');
  assert.throws(() => di.desktopSdkToken(), KEY_MSG, 'garbage Local State is a friendly error, not a SyntaxError');
  fs.writeFileSync(path.join(appDir, 'Local State'), '{}');
  assert.throws(() => di.desktopSdkToken(), KEY_MSG, 'a Local State without os_crypt is a friendly error, not a TypeError');
  const key = crypto.randomBytes(32);
  const wrapped = Buffer.concat([Buffer.from('DPAPI'), dpapiProtect(key)]);
  fs.writeFileSync(path.join(appDir, 'Local State'), JSON.stringify({os_crypt: {encrypted_key: wrapped.toString('base64')}}));
  assert.throws(() => di.desktopSdkToken(), DATA_MSG, 'a missing device file is a friendly error, not ENOENT');
  fs.writeFileSync(path.join(appDir, 'muse-device.enc'), Buffer.from('v10ab'));
  assert.throws(() => di.desktopSdkToken(), DATA_MSG, 'a truncated blob is a friendly error, not a crypto error');
  // A well-formed blob still decrypts and returns the token (behaviour preserved).
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify({sdkToken: 'mgst_test123', sdkTokenId: 'id1'}), 'utf8'), cipher.final()]);
  fs.writeFileSync(path.join(appDir, 'muse-device.enc'), Buffer.concat([Buffer.from('v10'), nonce, data, cipher.getAuthTag()]));
  assert.deepEqual(di.desktopSdkToken(), {sdkToken: 'mgst_test123', sdkTokenId: 'id1'});
});
