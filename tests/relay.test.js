'use strict';
// Standalone isolation guard (t2 #16): pin the scratch home/data folders
// here as well as relying on tests/setup.mjs, so running this file without
// the setup import never resolves against the real user's folders.
{
  const fs0 = require('node:fs'), os0 = require('node:os'), path0 = require('node:path');
  process.env.MUSER_LANG = 'ja';
  if (!/muser-test/.test(process.env.LOCALAPPDATA || '')) process.env.LOCALAPPDATA = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'muser-test-data-'));
  if (!/muser-test/.test(process.env.USERPROFILE || '')) process.env.USERPROFILE = process.env.HOME = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'muser-test-home-'));
}
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Relay} = require('../src/relay');
const {Agent} = require('../src/agent');

function tmp(t, prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }
function relay(t, dir, takes, run) { const r = new Relay({dir, takes, run}).start(); t.after(() => r.stop()); return r; }
// Relay.start() writes its entry file synchronously but listen() completes
// asynchronously (t2 #11): a forward issued in between hits ENOENT, which
// forward() reads as a dead peer and deletes the entry. Tests that forward
// to a relay must wait until it is actually listening.
async function ready(r) { const until = Date.now() + 5000; while (!r.server?.listening) { if (Date.now() > until) throw new Error('relay did not start listening'); await new Promise(res => setTimeout(res, 10)); } }

test('an idle window hands a call to the one window that takes it', async t => {
  const dir = tmp(t, 'muser-relay-');
  const idle = relay(t, dir, () => false, async () => assert.fail('the idle window must not run it'));
  const taker = relay(t, dir, p => p.pattern === '*', async (command, params, timeoutMs, id) => ({ok: true, payload: {command, params, timeoutMs, id}}));
  await ready(taker);
  const r = await idle.forward('code.glob', {pattern: '*'}, 30000, 'inv-1');
  assert.deepEqual(r, {result: {ok: true, payload: {command: 'code.glob', params: {pattern: '*'}, timeoutMs: 30000, id: 'inv-1'}}});
});

test('no taker, or two of them, is reported instead of guessed', async t => {
  const dir = tmp(t, 'muser-relay-');
  const idle = relay(t, dir, () => false, async () => ({}));
  assert.deepEqual(await idle.forward('code.glob', {}, 1000, 'x'), {takers: 0});
  const t1 = relay(t, dir, () => true, async () => assert.fail('ambiguous: must not run'));
  const t2 = relay(t, dir, () => true, async () => assert.fail('ambiguous: must not run'));
  await ready(t1); await ready(t2);
  assert.deepEqual(await idle.forward('code.glob', {}, 1000, 'x'), {takers: 2});
});

test('entries of windows that are gone are dropped', t => {
  const dir = tmp(t, 'muser-relay-');
  const me = relay(t, dir, () => false, async () => ({}));
  fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({pid: 999999, pipe: '\\\\.\\pipe\\muser-gone'}));
  assert.deepEqual(me.peers(), []);
  assert.equal(fs.existsSync(path.join(dir, '999999.json')), false);
});

function agent(t, cwd) {
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1};
  return new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm'); }}, cwd, mode: 'bypass',
    session: {id: 's-' + path.basename(cwd), cwd, title: '', created: 0, updated: 0, turns: 0}});
}

// The failure seen on 2026-11-01: window Y was mid-turn, window Z (idle) connected later and got
// Y's next tool call, which it refused with "muser is idle".
test('a call that lands on an idle window runs in the window whose turn it is', async t => {
  const dir = tmp(t, 'muser-relay-'), yDir = tmp(t, 'muser-y-'), zDir = tmp(t, 'muser-z-');
  fs.writeFileSync(path.join(yDir, 'mine.txt'), 'y');
  const y = agent(t, yDir), z = agent(t, zDir);
  y.relay = relay(t, dir, p => !!y.route(p), (c, p, ms, id) => y.execute(c, p, ms, id, {forwarded: true}));
  z.relay = relay(t, dir, p => !!z.route(p), (c, p, ms, id) => z.execute(c, p, ms, id, {forwarded: true}));
  await ready(y.relay); await ready(z.relay);
  y.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  const seen = []; y.on('tool-start', c => seen.push(c.command));

  const r = await z.execute('code.glob', {pattern: '*'}, 30000, 'inv-2');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.payload.files, ['mine.txt'], 'ran in the working window\'s folder');
  assert.deepEqual(seen, ['code.glob'], 'and shows up in that window');

  y.main.turn = null;
  assert.match((await z.execute('code.glob', {pattern: '*'}, 30000, 'inv-3')).error, /muser is idle/);
  assert.match((await z.execute('code.glob', {pattern: '*'}, 30000, 'inv-4', {forwarded: true})).error, /muser is idle/, 'a handed-over call is never handed on again');
});

test('an entry whose pid is alive but whose pipe is gone (pid reused) is removed when asked', async t => {
  const dir = tmp(t, 'muser-relay-');
  const me = relay(t, dir, () => false, async () => ({}));
  const ghost = path.join(dir, 'muser-ghost.json');
  fs.writeFileSync(ghost, JSON.stringify({pid: process.pid, pipe: '\\\\.\\pipe\\muser-ghost-' + Date.now()}));
  assert.deepEqual(await me.forward('code.glob', {}, 1000, 'x'), {takers: 0});
  assert.equal(fs.existsSync(ghost), false);
});

test('a handed call waits as long as the other window may still run it', async t => {
  const dir = tmp(t, 'muser-relay-');
  const idle = relay(t, dir, () => false, async () => ({}));
  // Muse's timeout 100 ms; the working window answers 5.5 s later (an approval taken late, but
  // inside its deadline of timeout + 30 s). The handing window gave up at timeout + 5 s.
  const worker = relay(t, dir, () => true, () => new Promise(r => setTimeout(() => r({ok: true, payload: 'ran'}), 5500)));
  await ready(worker);
  assert.deepEqual(await idle.forward('system.run', {}, 100, 'late'), {result: {ok: true, payload: 'ran'}});
});

test('a handed call whose answer is lost is not reported as "muser is idle"', async t => {
  const dir = tmp(t, 'muser-relay-'), zDir = tmp(t, 'muser-z-');
  const net = require('node:net');
  // A window that takes the call and then drops the connection (closed mid-call).
  const pipe = String.raw`\\.\pipe\muser-test-drop-` + process.pid;
  const server = net.createServer(sock => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => { buf += d; if (!buf.includes('\n')) return; const msg = JSON.parse(buf); buf = ''; msg.type === 'takes' ? sock.end('{"takes":true}\n') : sock.destroy(); });
  }).listen(pipe);
  await new Promise(r => server.listening ? r() : server.once('listening', r)); // same listen race as Relay.start(), on the raw server
  t.after(() => server.close());
  fs.writeFileSync(path.join(dir, 'muser-drop.json'), JSON.stringify({pid: process.pid, pipe}));
  const z = agent(t, zDir);
  z.relay = relay(t, dir, p => !!z.route(p), (c, p, ms, id) => z.execute(c, p, ms, id, {forwarded: true}));
  const r = await z.execute('code.glob', {pattern: '*'}, 30000, 'inv-drop');
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /muser is idle/);
  assert.match(r.error, /another muser window/);
});

// Multi-account: a call is never handed to a window on another Muse account, while windows that
// do not say their account (older muser) are still reached.
test('a call is not handed to a window on another account', async t => {
  const dir = tmp(t, 'muser-relay-');
  const idle = new Relay({dir, takes: () => false, run: async () => ({}), account: () => 'default'}).start(); t.after(() => idle.stop());
  const other = new Relay({dir, takes: () => true, run: async () => assert.fail('another account must not run it'), account: () => 'second'}).start(); t.after(() => other.stop());
  await ready(other); // the account filter, not a not-yet-listening entry, must be what refuses it
  assert.deepEqual(await idle.forward('code.glob', {}, 1000, 'x'), {takers: 0});
  other.stop();
  const same = relay(t, dir, () => true, async () => ({ok: true}));
  await ready(same);
  assert.deepEqual(await idle.forward('code.glob', {}, 1000, 'y'), {result: {ok: true}});
});
