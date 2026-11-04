'use strict';
// Fix phase 2, agent A29: c27 Medium items for sessions-host/settings/remote-store, plus fifth f3-4.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {SessionsHost, HostError} = require('../src/server/sessions-host');
let seq = 0;
class FakeAgent extends EventEmitter {
  constructor(cwd) { super(); seq++; this.cwd = cwd || 'C:\\work'; this.mode = 'default'; this.session = {id: 'sess-' + seq, turns: 0}; this.accountId = 'default'; this.accountLabel = null; this.busy = false; this.closed = false; }
  close() { this.closed = true; }
}
class FakeController {
  constructor(agent) { this.agent = agent; this.museName = 'kaguya'; this.listeners = new Set(); this.s = {entries: [], busy: false, queue: [], approval: null, reasonFor: null, promptFor: null, limitInput: null, addFlow: null, question: null, mode: 'default', shells: [], agents: []}; }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
}
function makePair(cwd) { const agent = new FakeAgent(cwd); return {agent, controller: new FakeController(agent), museName: 'kaguya'}; }
function tmpDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-a29-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function makeHost(t, hostOpts = {}) {
  const state = {fail: false, gate: null, calls: []};
  const stored = new Map();
  const host = new SessionsHost({
    create: async ({cwd, account, mode, session}) => { state.calls.push({cwd, account, mode, session}); if (state.gate) await state.gate; if (state.fail) throw new Error('factory failed (not logged in)'); const pair = makePair(cwd); if (session && typeof session === 'object') pair.agent.session = {...session}; return pair; },
    findSession: ref => stored.get(ref) || null,
    idleMs: 0,
    ...hostOpts,
  });
  t.after(async () => { await host.closeAll(); });
  return {host, state, stored};
}
test('fix2 c27#3: openNew rejects a non-MODES mode with 400 before the factory runs', async t => {
  const {host, state} = makeHost(t);
  const dir = tmpDir(t);
  for (const bad of ['Plan', 'plan ', 'auto_edit', 'PLAN', '', 42]) {
    await assert.rejects(() => host.openNew({cwd: dir, mode: bad}), err => err instanceof HostError && err.status === 400);
  }
  assert.equal(state.calls.length, 0, 'the factory never ran for a bad mode');
  const e = await host.openNew({cwd: dir, mode: 'plan'});
  assert.equal(state.calls[0].mode, 'plan');
  assert.ok(host.get(e.id));
  await host.openNew({cwd: dir});
  assert.equal(state.calls[1].mode, undefined, 'an omitted mode still means the factory decides');
});
test('fix2 c27#4: a failed open no longer evicts an unrelated conversation; a successful one still does', async t => {
  const {host, state, stored} = makeHost(t, {maxOpen: 2});
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  assert.equal(host.size, 2, 'at the cap');
  state.fail = true;
  await assert.rejects(() => host.openNew({cwd: dir}), /factory failed/);
  assert.ok(host.get(e1.id), 'the LRU conversation survived the FAILED openNew');
  assert.equal(e1.agent.closed, false);
  stored.set('past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'});
  await assert.rejects(() => host.openExisting('past-1'), /factory failed/);
  assert.ok(host.get(e1.id), 'the LRU conversation also survived the FAILED openExisting');
  assert.equal(e1.agent.closed, false);
  state.fail = false;
  const e2 = await host.openNew({cwd: dir});
  assert.equal(host.get(e1.id), null, 'a SUCCESSFUL open still evicts the LRU idle conversation');
  assert.equal(e1.agent.closed, true);
  assert.ok(host.get(e2.id));
  assert.equal(host.size, 2);
});
test('fix2 c27#4: cap with every non-default conversation busy is still a 409 up front', async t => {
  const {host, state} = makeHost(t, {maxOpen: 2});
  host.addPrepared({...makePair('C:\\a'), isDefault: true});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  e1.controller.set({busy: true});
  await assert.rejects(() => host.openNew({cwd: dir}), err => err instanceof HostError && err.status === 409);
  assert.equal(state.calls.length, 1, 'no second factory call was made');
  assert.ok(host.get(e1.id));
});
test('fix2 c27#5: closeAll during a slow openNew registers nothing', async t => {
  const {host, state} = makeHost(t);
  const dir = tmpDir(t);
  let release; state.gate = new Promise(r => { release = r; });
  const opening = host.openNew({cwd: dir});
  const closing = host.closeAll();
  release();
  await assert.rejects(opening, err => err instanceof HostError && err.status === 503);
  await closing;
  assert.equal(host.size, 0);
});
test('fix2 c27#5: close(id) during a slow openExisting cancels that open', async t => {
  const {host, state, stored} = makeHost(t);
  stored.set('past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'});
  let release; state.gate = new Promise(r => { release = r; });
  const opening = host.openExisting('past-1');
  assert.throws(() => host.close('past-1'), err => err.status === 404);
  release();
  await assert.rejects(opening, err => err instanceof HostError && err.status === 503);
  assert.equal(host.size, 0);
  assert.equal(host.get('past-1'), null);
});
test('fix2 f3-4: a 31-minute wall-clock step does not sweep a just-used conversation', async t => {
  const {host} = makeHost(t, {idleMs: 30 * 60 * 1000});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  assert.deepEqual(host.closeIdle(Date.now() + 31 * 60 * 1000), []);
  assert.ok(host.get(e1.id));
  assert.deepEqual(host.closeIdle(Date.now() + 29 * 60 * 1000), []);
});
test('fix2 f3-4: real monotonic idleness is swept; externally aged lastUsedAt keeps wall reading', async t => {
  const {host} = makeHost(t, {idleMs: 60});
  const dir = tmpDir(t);
  const e1 = await host.openNew({cwd: dir});
  await new Promise(r => setTimeout(r, 90));
  assert.deepEqual(host.closeIdle(), [e1.id]);
  const e2 = await host.openNew({cwd: dir});
  e2.lastUsedAt = Date.now() - 5000;
  assert.deepEqual(host.closeIdle(), [e2.id]);
});
const config = require('../src/config');
const settings = require('../src/settings');
function writeConfigRaw(text) { const f = config.file(); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, text); settings.reloadSwitches(); return f; }
test('fix2 c27#7: a save overwritten by another window right after is not resurrected in this window cache', t => {
  writeConfigRaw('{}');
  const orig = config.update;
  config.update = fn => { const out = orig(fn); orig(cfg => { cfg.bell = true; cfg.focusRounds = 4; cfg.defaultMode = 'plan'; }); return out; };
  t.after(() => { config.update = orig; });
  try {
    settings.setSwitch('bell', false);
    assert.equal(JSON.parse(fs.readFileSync(config.file(), 'utf8')).bell, true, 'the file holds the later window value');
    assert.equal(settings.savedValue('bell'), true, 'this window reads the file value, not its own stale save');
    settings.setNumber('focusRounds', 3);
    assert.equal(settings.numberValue('focusRounds'), 4, 'numbers: the later write wins');
    settings.setDefaultMode('bypass');
    assert.equal(settings.defaultMode(), 'plan', 'defaultMode: the later write wins');
  } finally { config.update = orig; }
  settings.setSwitch('bell', false, {save: false});
  assert.equal(settings.savedValue('bell'), false, 'save:false remains a session-only assignment');
});
test('fix2 c27#8: a same-size, same-mtime rewrite of config.json is still picked up', t => {
  const f = writeConfigRaw('{\n  "focusRounds": 3\n}');
  assert.equal(settings.numberValue('focusRounds'), 3);
  const before = fs.statSync(f);
  fs.writeFileSync(f, '{\n  "focusRounds": 4\n}');
  fs.utimesSync(f, before.atime, before.mtime);
  assert.equal(fs.statSync(f).size, before.size);
  assert.equal(settings.numberValue('focusRounds'), 4, 'the new stamp (inode + ns mtime/ctime) notices the rewrite');
});
const {createRemoteStore} = require('../src/link/remote-store');
const crypto = require('node:crypto');
test('fix2 c27#10: a malformed entry is refused like corruption, never silently dropped or written away', t => {
  const f = path.join(tmpDir(t), 'remote.json');
  const good = {id: 'dev-good', name: 'phone', staticPub: crypto.randomBytes(32).toString('base64url'), createdAt: 'x', lastSeen: 'x'};
  const bad = {id: 123, name: 'broken'};
  const text = JSON.stringify({devices: [good, bad]}, null, 2);
  fs.writeFileSync(f, text);
  const store = createRemoteStore(f);
  assert.throws(() => store.list(), /corrupt \(device entry 1/);
  assert.throws(() => store.remove('dev-good'), /corrupt \(device entry 1/);
  assert.throws(() => store.touch('dev-good'), /corrupt \(device entry 1/);
  assert.equal(fs.readFileSync(f, 'utf8'), text, 'the file is left exactly as it was');
});
test('fix2 c27#10: no-op remove/touch do not rewrite remote.json at all', t => {
  const f = path.join(tmpDir(t), 'remote.json');
  const store = createRemoteStore(f);
  const a = store.add({name: 'phone', staticPub: crypto.randomBytes(32)});
  const b = store.add({name: 'phone', staticPub: crypto.randomBytes(32)});
  const text = fs.readFileSync(f, 'utf8');
  const mtime = fs.statSync(f).mtimeMs;
  assert.equal(store.remove('no-such-id-or-name'), null);
  assert.equal(store.remove('phone'), null, 'an ambiguous name still removes nothing (#107)');
  assert.equal(store.touch('no-such-id'), null);
  assert.equal(fs.readFileSync(f, 'utf8'), text, 'no-op operations left the file content untouched');
  assert.equal(fs.statSync(f).mtimeMs, mtime, 'and did not rewrite it');
  assert.ok(store.touch(a.id), 'a real touch works');
  assert.notEqual(fs.readFileSync(f, 'utf8'), text, 'a real touch rewrites lastSeen');
  assert.equal(store.remove(b.id).id, b.id, 'remove by id still works');
  assert.deepEqual(store.list().map(d => d.id), [a.id]);
});
