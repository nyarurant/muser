'use strict';
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

test('an idle window hands a call to the one window that takes it', async t => {
  const dir = tmp(t, 'muser-relay-');
  const idle = relay(t, dir, () => false, async () => assert.fail('the idle window must not run it'));
  relay(t, dir, p => p.pattern === '*', async (command, params, timeoutMs, id) => ({ok: true, payload: {command, params, timeoutMs, id}}));
  const r = await idle.forward('code.glob', {pattern: '*'}, 30000, 'inv-1');
  assert.deepEqual(r, {result: {ok: true, payload: {command: 'code.glob', params: {pattern: '*'}, timeoutMs: 30000, id: 'inv-1'}}});
});

test('no taker, or two of them, is reported instead of guessed', async t => {
  const dir = tmp(t, 'muser-relay-');
  const idle = relay(t, dir, () => false, async () => ({}));
  assert.deepEqual(await idle.forward('code.glob', {}, 1000, 'x'), {takers: 0});
  relay(t, dir, () => true, async () => assert.fail('ambiguous: must not run'));
  relay(t, dir, () => true, async () => assert.fail('ambiguous: must not run'));
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
