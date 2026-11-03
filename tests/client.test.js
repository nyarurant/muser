'use strict';
// src/server/client.js (remote/DESIGN.md step 4): plain requests delegate to
// discovery.request, and the SSE streams parse `data:` frames (split chunks,
// multi-line data, keep-alive comments) and reconnect on their own until closed.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {createClient} = require('../src/server/client');

async function waitFor(cond, what, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 20));
  }
}

// A stub server: /api/server answers JSON; the two SSE routes run the given
// per-connection script (connection number, response).
function stubServer(t, {onEvents, onServerEvents} = {}) {
  const seen = {auth: [], events: 0, serverEvents: 0};
  const server = http.createServer((req, res) => {
    seen.auth.push(req.headers.authorization);
    if (req.url === '/api/server') { res.writeHead(200, {'content-type': 'application/json'}); return res.end(JSON.stringify({version: '9.9.9', protocol: 6})); }
    if (req.url === '/api/s/s1/events') { seen.events++; res.writeHead(200, {'content-type': 'text/event-stream'}); return onEvents?.(seen.events, res); }
    if (req.url === '/api/server/events') { seen.serverEvents++; res.writeHead(200, {'content-type': 'text/event-stream'}); return onServerEvents?.(seen.serverEvents, res); }
    res.writeHead(404); res.end('{}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    resolve({server, seen, info: {port: server.address().port, token: 'test-token', pid: process.pid}});
  }));
}

test('request delegates to discovery.request (Bearer token, {status, json})', async t => {
  const {seen, info} = await stubServer(t, {});
  const client = createClient(info);
  assert.equal(client.info, info);
  const r = await client.request('GET', '/api/server');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {version: '9.9.9', protocol: 6});
  assert.deepEqual(seen.auth, ['Bearer test-token']);
  assert.throws(() => createClient({port: 1}), /server info/);
});

test('events: split chunks, multi-line data and pings parse; a drop reconnects; close() stops it', async t => {
  const {seen, info} = await stubServer(t, {
    onEvents(n, res) {
      if (n === 1) {
        // The initial state frame, split mid-JSON across two writes.
        res.write('data: {"kind":"sta');
        setTimeout(() => {
          res.write('te","state":{"busy":false}}\n\n');
          res.write(': ping\n\n'); // keep-alive comment: not an event
          // One event whose JSON is split across two data: lines of one frame.
          res.write('data: {"kind":"entry",\ndata: "entry":{"id":7,"type":"user"}}\n\n');
          setTimeout(() => res.end(), 30); // the drop the client must recover from
        }, 30);
      } else {
        res.write('data: ' + JSON.stringify({kind: 'state', state: {busy: true}}) + '\n\n');
        // stays open until close() aborts it
      }
    },
  });
  const client = createClient(info);
  const events = []; let closes = 0;
  const close = client.events('s1', {onEvent: ev => events.push(ev), onClose: () => closes++});
  await waitFor(() => events.length >= 3 && seen.events >= 2, 'the reconnect and its state frame');
  assert.deepEqual(events[0], {kind: 'state', state: {busy: false}}, 'the initial state frame is delivered');
  assert.deepEqual(events[1], {kind: 'entry', entry: {id: 7, type: 'user'}}, 'multi-line data joined and parsed');
  assert.deepEqual(events[2], {kind: 'state', state: {busy: true}});
  assert.ok(closes >= 1, 'onClose fired for the dropped connection');
  close();
  const atClose = seen.events;
  // Negative assertion, so there is no state signal to poll: the failure mode
  // (a reconnect despite close()) would fire on the FIRST backoff step
  // (250 ms in src/server/client.js). Wait several backoff steps (250+500 ms)
  // plus margin for a loaded machine, then check nothing arrived.
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(seen.events, atClose, 'no reconnect after close()');
});

test('#66: a permanent error (404) stops the reconnect loop instead of retrying forever', async t => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.writeHead(404); res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  const client = createClient({port: server.address().port, token: 'test-token', pid: process.pid});
  let closes = 0;
  const close = client.events('gone', {onEvent: () => {}, onClose: () => closes++});
  await waitFor(() => closes === 1, 'the 404 close to be reported'); // poll the positive signal instead of sleeping a fixed 1200 ms
  // The no-retry half is a negative assertion with no signal to poll: a retry
  // would land after the first backoff step (250 ms), so waiting past several
  // steps (250+500+1000 ms) plus margin is what makes "still 1" meaningful.
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(hits, 1, 'no retry after a 404: the conversation is gone for good');
  assert.equal(closes, 1, 'the single close was reported');
  close();
});

test('#66: a stream that accepts and instantly drops does not hot-loop — backoff only resets after a real event', async t => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  const client = createClient({port: server.address().port, token: 'test-token', pid: process.pid});
  const close = client.events('s1', {onEvent: () => {}, onClose: () => {}});
  // Poll the positive signal (connections ARE happening) instead of assuming
  // a fixed 1600 ms was enough on a loaded machine; then measure over a WIDER
  // window so the bound is not decided by a few tens of ms of scheduling jitter.
  // Backoff is 250,500,1000,2000,... ms, so a healthy loop makes ~4 connections
  // in 3.2 s; a reset-on-accept loop (~250 ms each) would make ~13.
  await waitFor(() => hits >= 2, 'the reconnect loop to cycle');
  const windowStart = hits;
  await new Promise(r => setTimeout(r, 3200));
  close();
  const inWindow = hits - windowStart;
  assert.ok(inWindow <= 4, 'growing backoff kept the accept/drop cycle slow (saw ' + inWindow + ' connections in 3.2 s; a reset-on-accept loop would make ~13)');
});

test('serverEvents streams /api/server/events the same way', async t => {
  const {seen, info} = await stubServer(t, {
    onServerEvents(n, res) { res.write('data: ' + JSON.stringify({kind: 'server', server: {version: '9.9.9'}}) + '\n\n'); },
  });
  const client = createClient(info);
  const events = [];
  const close = client.serverEvents({onEvent: ev => events.push(ev), onClose: () => {}});
  await waitFor(() => events.length >= 1, 'the initial server frame');
  assert.deepEqual(events[0], {kind: 'server', server: {version: '9.9.9'}});
  assert.equal(seen.serverEvents, 1);
  close();
});
