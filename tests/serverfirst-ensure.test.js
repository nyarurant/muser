'use strict';
// Server-first startup classification (src/server/ensure-server.js): ready /
// setup / protocol / failed, with exactly one background start attempt and a
// bounded wait when no server answers. All deps are fakes — no real server,
// no real spawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const {ensureServer, verdict} = require('../src/server/ensure-server');

const info = {pid: 4242, port: 53199, token: 'x'};
const liveOk = {protocol: 6, pid: 4242, setup: {phase: 'done'}};

function clock() { let t = 0; return {now: () => t, sleep: async ms => { t += ms; }}; }

test('sf-ensure: a live ready server is used as-is, no spawn', async () => {
  let spawns = 0;
  const r = await ensureServer({readServer: () => info, probeServer: async () => liveOk, spawnServer: () => { spawns++; }, ...clock()});
  assert.equal(r.status, 'ready');
  assert.equal(spawns, 0);
});

test('sf-ensure: a live server in first-run setup reports setup, no spawn', async () => {
  let spawns = 0;
  const r = await ensureServer({readServer: () => info, probeServer: async () => ({...liveOk, setup: {phase: 'login'}}), spawnServer: () => { spawns++; }, ...clock()});
  assert.equal(r.status, 'setup');
  assert.equal(r.phase, 'login');
  assert.equal(spawns, 0);
});

test('sf-ensure: an old-protocol server reports protocol and is NOT restarted', async () => {
  let spawns = 0;
  const r = await ensureServer({readServer: () => info, probeServer: async () => ({protocol: 5, pid: 4242}), spawnServer: () => { spawns++; }, ...clock()});
  assert.equal(r.status, 'protocol');
  assert.equal(r.protocol, 5);
  assert.equal(spawns, 0, 'ensure never stops/restarts a resident server');
});

test('sf-ensure: no server -> one spawn, waits until it answers', async () => {
  let spawns = 0, probes = 0;
  const r = await ensureServer({
    readServer: () => info,
    probeServer: async () => (++probes >= 3 ? liveOk : null),
    spawnServer: () => { spawns++; },
    pidAlive: () => false,
    timeoutMs: 20000, pollMs: 250, ...clock(),
  });
  assert.equal(r.status, 'ready');
  assert.equal(spawns, 1, 'exactly one start attempt');
});

test('sf-ensure: spawn failure is start-failed, no retry', async () => {
  let spawns = 0;
  const r = await ensureServer({readServer: () => null, probeServer: async () => null, spawnServer: () => { spawns++; throw new Error('no node'); }, ...clock()});
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'start-failed');
  assert.equal(spawns, 1);
});

test('sf-ensure: a spawned server that never answers times out as not-found (no file ever)', async () => {
  const c = clock();
  const r = await ensureServer({readServer: () => null, probeServer: async () => null, spawnServer: () => {}, timeoutMs: 1000, pollMs: 250, ...c});
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'not-found');
});

test('sf-ensure: a discovery file whose server never answers times out as unreachable', async () => {
  const c = clock();
  const r = await ensureServer({readServer: () => info, probeServer: async () => null, spawnServer: () => {}, timeoutMs: 1000, pollMs: 250, ...c});
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'unreachable');
});

test('sf-ensure (debug B6): the timeout bounds the whole ensure, slow probes included', async () => {
  let t = 0;
  const r = await ensureServer({
    readServer: () => info,
    probeServer: async () => { t += 1000; return null; }, // each probe eats 1s of the budget
    spawnServer: () => {},
    now: () => t, sleep: async ms => { t += ms; },
    timeoutMs: 2000, pollMs: 250,
  });
  assert.equal(r.status, 'failed');
  assert.ok(t <= 2000, 'elapsed on the fake clock is ' + t + ' — the 2000ms budget holds (was ~3000+)');
});

test('sf-ensure (debug B5): a spawned serve that dies at once is start-failed immediately, not a full-timeout wait', async () => {
  const handlers = {};
  const child = {once: (ev, fn) => { handlers[ev] = fn; }};
  const c = clock();
  const p = ensureServer({readServer: () => null, probeServer: async () => null, spawnServer: () => { queueMicrotask(() => handlers.exit(1)); return child; }, timeoutMs: 60000, pollMs: 250, ...c});
  const r = await p;
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'start-failed');
  assert.match(String(r.detail), /code 1/);
});

test('sf-ensure (debug B14): verdict normalises protocol and phase shapes', () => {
  assert.equal(verdict(info, {protocol: '6', pid: 4242, setup: {phase: 'done'}}).status, 'ready', 'a string protocol 6 is protocol 6');
  assert.equal(verdict(info, {protocol: 6, pid: 4242, setup: {phase: 'DONE'}}).status, 'ready', 'the phase match is case-insensitive');
  const s = verdict(info, {protocol: 6, pid: 4242, setup: {phase: 'Login'}});
  assert.equal(s.status, 'setup');
  assert.equal(s.phase, 'login');
});

test('sf-ensure (debug B1): a live-but-unanswering owner is waited for, never raced with a spawn', async () => {
  let spawns = 0, probes = 0;
  const r = await ensureServer({
    readServer: () => info,
    probeServer: async () => (++probes >= 3 ? liveOk : null),
    spawnServer: () => { spawns++; },
    pidAlive: () => true,
    timeoutMs: 20000, pollMs: 250, ...clock(),
  });
  assert.equal(r.status, 'ready');
  assert.equal(spawns, 0, 'no rival spawn against a live owner');
});

test('sf-ensure (debug B1): a live owner that never answers is unreachable, still no spawn', async () => {
  let spawns = 0;
  const r = await ensureServer({readServer: () => info, probeServer: async () => null, spawnServer: () => { spawns++; }, pidAlive: () => true, timeoutMs: 1000, pollMs: 250, ...clock()});
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'unreachable');
  assert.equal(spawns, 0);
});

test('sf-ensure (debug B2): two starters sharing a lock file spawn once between them', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-ensure-lock-'));
  const lockFile = path.join(dir, 'server.json.spawnlock');
  let probes = 0, spawns = 0, spawned = false;
  const deps = () => ({
    // The discovery file appears once someone spawned, and the spawned
    // server answers from its second probe on (still booting on the 1st).
    readServer: () => (spawned ? info : null),
    probeServer: async () => (++probes >= 2 ? liveOk : null),
    spawnServer: () => { spawns++; spawned = true; },
    pidAlive: pid => pid === process.pid,
    lockFile,
    timeoutMs: 5000, pollMs: 5,
  });
  const [a, b] = await Promise.all([ensureServer(deps()), ensureServer(deps())]);
  assert.equal(a.status, 'ready');
  assert.equal(b.status, 'ready');
  assert.equal(spawns, 1, 'exactly one spawn across both starters');
  assert.equal(fs.existsSync(lockFile), false, 'the lock is released afterwards');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('sf-ensure: verdict treats a missing protocol as old (5)', () => {
  assert.equal(verdict(info, {pid: 4242}).status, 'protocol');
  assert.equal(verdict(info, liveOk).status, 'ready');
});
