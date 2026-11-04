'use strict';
// Fix phase 2, test-scope findings (deep audit t1-t4, Medium): coverage that
// the named test files lacked, added here so the original files keep their
// shape. Every test exercises the real production module; where a network
// boundary is unavoidable (NativeDevice.connect, the muse.ai web object)
// only that boundary is stubbed and the stub records what it was handed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

const tmp = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };

// --- t1#9: policy — muser's own settings under %LOCALAPPDATA%\muser --------
test('fix2 t1#9: writes to muser settings under the LOCALAPPDATA root ask too, not only ~/.muser', () => {
  const {decide, muserSettingsPath} = require('../src/policy');
  const root = path.join(process.env.LOCALAPPDATA, 'muser');
  const e = file => decide({mode: 'auto-edit', kind: 'edit', params: {path: file}, outside: false, targets: [file]});
  for (const name of ['config.json', 'permissions.json', 'mcp.json', 'mcp-secrets.enc', 'session.enc']) {
    const f = path.join(root, name);
    assert.equal(muserSettingsPath(f), true, f);
    assert.equal(e(f), 'ask', f + ' must ask even in auto-edit');
  }
  assert.equal(e(path.join(process.env.LOCALAPPDATA, 'other-app', 'config.json')), 'allow', 'another app\'s folder is not muser settings');
  assert.equal(e(path.join(root, '..', 'muser-lookalike', 'config.json')), 'allow', 'a lookalike folder name is not the settings root');
});

// --- t3#11: usage — plan() / formatPlan() / the action-id cache ------------
test('fix2 t3#11: usage.plan reads the real plan through a cached action id; formatPlan renders it', async t => {
  const dir = tmp(t, 'muser-usage-plan-');
  const usage = require('../src/usage');
  const saved = process.env.MUSER_USAGE_FILE;
  process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json');
  t.after(() => { process.env.MUSER_USAGE_FILE = saved; usage.resetWeb(); });
  usage.resetWeb();
  fs.writeFileSync(path.join(dir, 'subscription-action.json'), JSON.stringify({id: 'cached-id', at: new Date().toISOString()}));
  const seen = [];
  const web = {
    pageText: async () => { throw new Error('must not crawl while a cached id works'); },
    serverAction: async (id, args) => { seen.push([id, args]); return {ok: true, text: '1a:{"subscription":{"tier":{"name":"Pro","isPaid":true},"usage":{"percentUsed":42,"quotaStatus":"SUFFICIENT","resetsAt":1893456000},"topupBalance":5,"topupTotal":100}}'}; },
  };
  const plan = await usage.plan(web);
  assert.deepEqual(seen.map(s => s[0]), ['cached-id']);
  assert.equal(plan.plan, 'Pro');
  assert.equal(plan.paid, true);
  assert.equal(plan.percentUsed, 42);
  assert.equal(plan.resetsAt, 1893456000000, 'a seconds-shaped resetsAt is normalised to ms');
  assert.equal(plan.topupBalance, 5);
  const text = usage.formatPlan(plan);
  assert.match(text, /Pro/);
  assert.match(text, /42%/);
});

test('fix2 t3#11: a 404 on the cached action id finds the new id once, caches it, and uses it', async t => {
  const dir = tmp(t, 'muser-usage-plan404-');
  const usage = require('../src/usage');
  const saved = process.env.MUSER_USAGE_FILE;
  process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json');
  t.after(() => { process.env.MUSER_USAGE_FILE = saved; usage.resetWeb(); });
  usage.resetWeb();
  const cacheFile = path.join(dir, 'subscription-action.json');
  fs.writeFileSync(cacheFile, JSON.stringify({id: 'stale-id', at: new Date().toISOString()}));
  const newId = 'a'.repeat(40);
  const calls = [];
  const web = {
    pageText: async p => {
      if (p === '/') return '<script src="/_next/static/chunks/abc.js"></script>';
      return 'x createServerReference)("NEWID", "fetchSubscriptionAction")'.replace('NEWID', newId);
    },
    serverAction: async id => {
      calls.push(id);
      if (id === 'stale-id') return {ok: false, status: 404, text: ''};
      return {ok: true, text: '1a:{"subscription":{"tier":{"name":"Max","isPaid":true},"usage":{"percentUsed":7,"quotaStatus":"SUFFICIENT","resetsAt":1893456000000}}}'};
    },
  };
  const plan = await usage.plan(web);
  assert.equal(plan.percentUsed, 7);
  assert.deepEqual(calls, ['stale-id', newId], 'the stale id is dropped and the refound id is tried');
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).id, newId, 'the new id replaces the cached one');
});

test('fix2 t3#11: a failed action lookup is not retried for an hour — and not re-crawled inside the retry delay', async t => {
  const dir = tmp(t, 'muser-usage-planfail-');
  const usage = require('../src/usage');
  const saved = process.env.MUSER_USAGE_FILE;
  process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json');
  t.after(() => { process.env.MUSER_USAGE_FILE = saved; usage.resetWeb(); });
  usage.resetWeb();
  let crawls = 0;
  const web = {
    pageText: async () => { crawls++; return '<html>no chunks here</html>'; },
    serverAction: async () => { throw new Error('must not be called without an id'); },
  };
  await assert.rejects(usage.plan(web), /見つかりませんでした/, 'the first failure is the lookup\'s own error');
  assert.equal(crawls, 1);
  await assert.rejects(usage.plan(web), /読み込めませんでした/, 'inside the retry delay plan() gives up without crawling');
  assert.equal(crawls, 1, 'no second crawl inside the retry delay');
});

// --- t3#12: core/noise Transport — multi-chunk reassembly -------------------
const {Transport, Cipher, cat, uint, bytes} = require('../src/core/noise');
function chunk(id, index, count, payload) { return cat(uint(1, id), uint(2, index), uint(3, count), bytes(4, payload)); }
function transport() { return new Transport(new Cipher(), new Cipher()); }
function twoChunkFrame() {
  const frame = cat(uint(1, 9n), bytes(4, cat(bytes(1, Buffer.from('hi')), uint(2, 1))));
  const full = bytes(1, frame); // the encode-side envelope: field 1 wraps the frame
  const cut = 4;
  return [full.subarray(0, cut), full.subarray(cut)];
}

test('fix2 t3#12: a two-chunk frame reassembles, including out of order', () => {
  const [p0, p1] = twoChunkFrame();
  const tr = transport();
  assert.equal(tr.decode(chunk(42n, 1, 2, p1)), null, 'the second chunk alone completes nothing');
  assert.equal(tr.chunks.size, 1);
  const out = tr.decode(chunk(42n, 0, 2, p0));
  assert.equal(out.type, 'body');
  assert.equal(out.id, 9n);
  assert.equal(out.body.toString(), 'hi');
  assert.equal(out.end, true);
  assert.equal(tr.chunks.size, 0, 'the record is dropped once complete');
  tr.destroy();
});

test('fix2 t3#12: an identical retransmitted chunk is ignored; a conflicting one drops only its record', () => {
  const [p0, p1] = twoChunkFrame();
  const tr = transport();
  assert.equal(tr.decode(chunk(7n, 0, 2, p0)), null);
  assert.equal(tr.decode(chunk(7n, 0, 2, p0)), null, 'the same chunk again is a no-op, not an error');
  assert.equal(tr.chunks.get('7').parts.size, 1);
  const out = tr.decode(chunk(7n, 1, 2, p1));
  assert.equal(out.body.toString(), 'hi', 'the frame still completes after the duplicate');
  const bad = Buffer.from(p0); bad[bad.length - 1] ^= 0xff;
  assert.equal(tr.decode(chunk(8n, 0, 2, p0)), null);
  assert.equal(tr.decode(chunk(8n, 0, 2, bad)), null);
  assert.equal(tr.chunks.has('8'), false, 'a conflicting duplicate discards its reassembly');
  assert.equal(tr.decode(chunk(8n, 1, 2, p1)), null, 'the surviving chunk starts a fresh record');
  assert.equal(tr.chunks.get('8').parts.size, 1);
  tr.destroy();
});

test('fix2 t3#12: a chunk whose count disagrees with the record drops the record', () => {
  const [p0, p1] = twoChunkFrame();
  const tr = transport();
  assert.equal(tr.decode(chunk(9n, 0, 2, p0)), null);
  assert.equal(tr.decode(chunk(9n, 1, 3, p1)), null);
  assert.equal(tr.chunks.has('9'), false);
  tr.destroy();
});

// --- t1#15: shared node id — the REAL connectDevice claims the freed slot --
test('fix2 t1#15: connectDevice itself re-claims a freed slot and registers the device on its node id', async t => {
  const {Agent} = require('../src/agent');
  const sessions = require('../src/sessions');
  const nodeSlots = require('../src/node-slots');
  const {NativeDevice} = require('../src/core/native-device');
  // Hold every slot of base 'n' in this process's scratch instances dir, then
  // free slot 2 only: the state a shared-id window is in when a slot opens.
  const held = [];
  for (let i = 0; i < 6; i++) held.push(nodeSlots.claim('n'));
  assert.deepEqual(held.map(h => h.slot), [1, 2, 3, 4, 5, 6]);
  held[1].release();
  t.after(() => { for (const h of held) { try { h.release(); } catch {} } });
  // Only the network boundary is stubbed: connect() records the node id it
  // was asked to register, and send() completes the turn the way the gateway
  // would. Agent.runTurn (which nulls the shared slot and calls the REAL
  // connectDevice), node-slots.claim and the Relay are production code.
  const cwd = tmp(t, 'muser-rereg-real-');
  const client = new EventEmitter(), events = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() {}, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  let sendSeq = 0;
  const completeTurn = (body, sessionId) => {
    const n = ++sendSeq;
    setImmediate(() => { const done = {event: 'delta.message_done', seq: n * 2, payload: {session_id: sessionId, message_id: 'reply-' + n, role: 'assistant', text: 'ok', status: 'completed'}}; events.push(done); client.taskStatus = 'completed'; client.emit('event', done); });
    return {message_id: 'user-' + n};
  };
  const registered = [];
  const orig = {connect: NativeDevice.prototype.connect, disconnect: NativeDevice.prototype.disconnect, send: NativeDevice.prototype.send};
  NativeDevice.prototype.connect = async function ({nodeId}) { registered.push(nodeId); this._nodeId = nodeId; this._connected = true; };
  NativeDevice.prototype.disconnect = function () { this._connected = false; };
  NativeDevice.prototype.send = async function (body, sessionId) { return completeTurn(body, sessionId); };
  t.after(() => { NativeDevice.prototype.connect = orig.connect; NativeDevice.prototype.disconnect = orig.disconnect; NativeDevice.prototype.send = orig.send; });
  const agent = new Agent({client, auth: {saved: {nodeId: 'n'}, vm: async () => ({vm_id: 'vm1', vm_auth_token: 'tok'})}, cwd, session: sessions.create(cwd)});
  agent.subscribed = true; agent.focusEnabled = false;
  t.after(() => agent.close());
  let oldDisconnected = 0;
  agent.device = {connected: true, disconnect() { oldDisconnected++; }, send: completeTurn};
  agent.nodeSlot = {slot: 0, nodeId: 'n', base: 'n', release() {}}; // the shared id, as connectDevice left it when the house was full
  await agent.send('hello');
  assert.equal(oldDisconnected, 1, 'connectDevice disconnected the previous device');
  assert.equal(agent.nodeSlot.slot, 2, 'connectDevice claimed the freed slot (not a stub-assigned value)');
  assert.equal(agent.nodeSlot.nodeId, 'n-2');
  assert.deepEqual(registered, ['n-2'], 'the device registered on the newly claimed node id');
  assert.ok(agent.device instanceof NativeDevice);
  assert.equal(agent.device.nodeId, 'n-2');
});

test('fix2 t1#15: runTurn does not re-register while another worker is mid-turn, and does once it is not', async t => {
  const {Agent} = require('../src/agent');
  const sessions = require('../src/sessions');
  const cwd = tmp(t, 'muser-rereg-guard-');
  const client = new EventEmitter(), events = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() {}, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)});
  agent.subscribed = true; agent.focusEnabled = false;
  t.after(() => agent.close());
  const log = [];
  let sendSeq = 0;
  const device = {connected: true, disconnect() {}, async send(body, sessionId) {
    log.push('send');
    const n = ++sendSeq; // a reused reply id would be baseline to the next turn and hang it
    setImmediate(() => { const done = {event: 'delta.message_done', seq: n * 2, payload: {session_id: sessionId, message_id: 'reply-' + n, role: 'assistant', text: 'ok', status: 'completed'}}; events.push(done); client.taskStatus = 'completed'; client.emit('event', done); });
    return {message_id: 'user-' + n};
  }};
  agent.device = device;
  agent.nodeSlot = {slot: 0, nodeId: 'n', base: 'n', release() {}};
  let registers = 0;
  agent.connectDevice = async function () { registers++; this.nodeSlot = {slot: 2, nodeId: 'n-2', base: 'n', release() {}}; this.device = device; };
  const other = {tag: 'a1', main: false, turn: {controller: new AbortController()}, starting: false, session: {id: 'other-session'}, focusTask: null, snapshot() { return {tag: 'a1'}; }};
  agent.workers.set('a1', other);
  await agent.send('hello');
  assert.equal(registers, 0, 'no re-register while another worker holds a turn');
  assert.deepEqual(log, ['send']);
  other.turn = null;
  await agent.send('again');
  assert.equal(registers, 1, 'with no other turn running, the shared-id window registers before its turn');
  assert.equal(agent.nodeSlot.slot, 2);
});
