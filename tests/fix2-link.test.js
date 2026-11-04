'use strict';
// Fix phase 2, agent A23: deep-audit work2/c20 Medium items for
// src/link/link.js and src/link/proxy.js. Repro: audit2/fix2/repro-A23.cjs
// (before: #9 unrecoverable + U+FFFD, #5 virtual/link-local first, #2 two
// sockets for one cid, #1 stale socket opened a channel, #3 stop-during-
// start left a live LAN listener + discovery).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

// Same isolation as tests/link.test.js: never touch the real user store.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-link-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-link-home-'));

const noise = require('../src/link/noise');
const {loadOrCreateLinkKeys, pcIdFor} = require('../src/link/keys');
const {createRemoteStore} = require('../src/link/remote-store');
const {createProxy} = require('../src/link/proxy');
const {Link, lanCandidates, buildPairPayload} = require('../src/link/link');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stubProxy = {request: async () => ({status: 200, body: {}}), openSubscription: () => () => {}};
const tmpStore = () => createRemoteStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-link-')), 'remote.json'));
function pcKeys() { const k = {noise: noise.generateStaticKeyPair(), relay: noise.generateStaticKeyPair()}; return {keys: k, pcId: pcIdFor(k.relay.publicKey)}; }

function relayHarness(t) {
  const state = {controlWs: null, dataConns: 0};
  const wss = new WebSocket.WebSocketServer({host: '127.0.0.1', port: 0});
  wss.on('connection', (ws, req) => { if (req.url.startsWith('/a')) state.dataConns++; else if (!state.controlWs) state.controlWs = ws; });
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  return new Promise(resolve => wss.on('listening', () => resolve({state, url: 'ws://127.0.0.1:' + wss.address().port})));
}
async function controlLink(t, url, extra = {}) {
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: url, lanPort: null, keys: loadOrCreateLinkKeys(), store: tmpStore(), proxy: stubProxy, controlHeartbeatMs: 0, ...extra});
  link.stopped = false; // drive the control socket directly, as tests/link.test.js does
  link.connectControl();
  for (let i = 0; i < 100 && !link.controlOpen; i++) await sleep(20);
  assert.equal(link.controlOpen, true);
  t.after(() => link.stop());
  return link;
}

test('fix2 link #1 (c20): a message on a superseded control socket opens no data channel', {timeout: 30000}, async t => {
  const {state, url} = await relayHarness(t);
  const link = await controlLink(t, url);
  const healthy = new WebSocket(url);
  await new Promise((res, rej) => { healthy.once('open', res); healthy.once('error', rej); });
  t.after(() => healthy.close());
  link.control = healthy; // the original socket is now stale
  state.controlWs.send(JSON.stringify({open: 'cid-stale'}));
  await sleep(300);
  assert.equal(state.dataConns, 0);
  assert.equal(link.dataSockets.size, 0);
});

test('fix2 link #1 (c20): a stopped link ignores control {open} and direct openDataSocket calls', {timeout: 30000}, async t => {
  const {state, url} = await relayHarness(t);
  const link = await controlLink(t, url);
  await link.stop();
  assert.equal(link.openDataSocket('cid-after-stop'), false);
  state.controlWs.send(JSON.stringify({open: 'cid-after-stop'}));
  await sleep(250);
  assert.equal(state.dataConns, 0);
});

test('fix2 link #2 (c20): a duplicated {open} cid gets one data socket, not two', {timeout: 30000}, async t => {
  const {state, url} = await relayHarness(t);
  await controlLink(t, url);
  state.controlWs.send(JSON.stringify({open: 'cid-dup'}));
  await sleep(150);
  state.controlWs.send(JSON.stringify({open: 'cid-dup'}));
  state.controlWs.send(JSON.stringify({open: 'cid-dup'}));
  await sleep(300);
  assert.equal(state.dataConns, 1);
});

test('fix2 link #2 (c20): distinct {open} cids are rate-limited per window', {timeout: 30000}, async t => {
  const {state, url} = await relayHarness(t);
  const link = await controlLink(t, url, {maxDataOpensPerWindow: 3, dataOpenWindowMs: 60000});
  for (let i = 0; i < 6; i++) state.controlWs.send(JSON.stringify({open: 'cid-flood-' + i}));
  await sleep(400);
  assert.equal(state.dataConns, 3);
  assert.equal(link.openDataSocket('cid-flood-direct'), false);
});

test('fix2 link #3 (c20): stop() during start() leaves no LAN listener and no discovery socket', {timeout: 30000}, async () => {
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: 0, discoveryPort: 18790 + (process.pid % 200), keys: pcKeys(), store: tmpStore(), proxy: stubProxy});
  const started = link.start();
  await link.stop(); // lands while start() is still awaiting the listen callback
  await started;
  assert.equal(link.lanServer, null);
  assert.equal(link.discovery, null);
  assert.equal(link.stopped, true);
  assert.equal(link.channels.size, 0);
});

test('fix2 link #3 (c20): a normal start/stop still works after the race fix', {timeout: 30000}, async () => {
  const link = new Link({serve: {port: 9, token: 't'}, relayUrl: null, lanPort: 0, discoveryPort: 0, keys: pcKeys(), store: tmpStore(), proxy: stubProxy});
  const st = await link.start();
  assert.ok(st.lanPort > 0);
  await link.stop();
  assert.equal(link.lanServer, null);
});

test('fix2 link #5 (c20): LAN candidates rank the physical home LAN first, virtual/VPN/link-local last', () => {
  const nets = {
    'vEthernet (Default Switch)': [{address: '172.20.0.1', family: 'IPv4', internal: false}],
    'VMware Network Adapter VMnet8': [{address: '192.168.200.1', family: 'IPv4', internal: false}],
    Ethernet: [{address: '169.254.10.20', family: 'IPv4', internal: false}],
    'Wi-Fi': [{address: '192.168.1.6', family: 'IPv4', internal: false}],
    Tailscale: [{address: '100.101.102.103', family: 'IPv4', internal: false}],
    Loopback: [{address: '127.0.0.1', family: 'IPv4', internal: true}],
  };
  const got = lanCandidates(nets);
  assert.equal(got[0], '192.168.1.6');
  assert.equal(got[got.length - 1], '100.101.102.103');
  assert.ok(got.indexOf('169.254.10.20') > got.indexOf('192.168.1.6'), 'link-local must not outrank the real LAN');
  assert.ok(!got.includes('127.0.0.1'));
  // The QR payload takes lan[0]: it must carry the reachable address.
  const payload = buildPairPayload({pcId: 'pcx', staticPub: Buffer.alloc(32, 1), relay: null, code: 'CODE1234', name: 'pc', lan: got.map(a => a + ':8734')});
  assert.ok(payload.includes('l=192.168.1.6%3A8734'), payload);
});

test('fix2 link #5 (c20): lanAddresses() uses the same ranking with the live port', () => {
  const orig = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'VMware Network Adapter VMnet1': [{address: '192.168.111.1', family: 'IPv4', internal: false}],
    'Wi-Fi': [{address: '10.0.0.8', family: 'IPv4', internal: false}],
  });
  try {
    const link = new Link({serve: {port: 9, token: 't'}, lanPort: 8734, keys: pcKeys(), store: tmpStore(), proxy: stubProxy});
    assert.deepEqual(link.lanAddresses(), ['10.0.0.8:8734', '192.168.111.1:8734']);
  } finally { os.networkInterfaces = orig; }
});

async function serveOnce(t, handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); });
  return createProxy({port: server.address().port, token: 't'});
}

test('fix2 proxy #9 (c20): a binary response round-trips byte-exact via base64 instead of U+FFFD corruption', async t => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x81, 0x00, 0xc3, 0x28]);
  const proxy = await serveOnce(t, (req, res) => { res.writeHead(200, {'content-type': 'image/png'}); res.end(png); });
  const out = await proxy.request({path: '/media'});
  assert.equal(out.contentType, 'image/png');
  assert.equal(out.bodyEncoding, 'base64');
  assert.ok(Buffer.from(out.body, 'base64').equals(png));
});

test('fix2 proxy #9 (c20): invalid UTF-8 under a text content-type is also returned as base64', async t => {
  const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
  const proxy = await serveOnce(t, (req, res) => { res.writeHead(200, {'content-type': 'text/plain'}); res.end(bytes); });
  const out = await proxy.request({path: '/x'});
  assert.equal(out.bodyEncoding, 'base64');
  assert.ok(Buffer.from(out.body, 'base64').equals(bytes));
});

test('fix2 proxy #9 (c20): JSON and plain-text responses keep their previous shape (no bodyEncoding)', async t => {
  const proxy = await serveOnce(t, (req, res) => {
    if (req.url === '/json') { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({ok: 1, msg: 'konnichiwa'})); }
    else { res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'}); res.end('hello'); }
  });
  const j = await proxy.request({path: '/json'});
  assert.deepEqual(j.body, {ok: 1, msg: 'konnichiwa'});
  assert.equal(j.bodyEncoding, undefined);
  const s = await proxy.request({path: '/text'});
  assert.equal(s.body, 'hello');
  assert.equal(s.bodyEncoding, undefined);
});
