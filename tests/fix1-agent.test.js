'use strict';
// Fix phase 1, agent I: first audit #9 (untagged invoke runs as main, bypassing a
// read-only parallel agent's restrictions) and deep audit H8 (the relay's account
// filter gets nothing for the default account). Harness mirrors tests/agent.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Isolate every homedir-derived folder BEFORE loading any src module (see agent.test.js).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-agent-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-agent-home-'));

const {Agent, routeFor, untaggedRestrictedConflict} = require('../src/agent');
const {BUILTIN} = require('../src/agent-types');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-agent-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async () => {};
  return c;
}
function makeAgent(t, agentOpts = {}) {
  const cwd = agentOpts.cwd || tmpdir(t);
  const a = new Agent({
    client: stubClient(),
    auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }},
    cwd,
    session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0},
    ...agentOpts,
  });
  a.subscribed = true;
  a.approver = async () => ({allow: true}); // default mode asks for edits; allow, so only the #9 rule can stop a write
  return a;
}
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
  return a.main.turn;
}
function fakeWorker(tag, over = {}) {
  return {tag, title: tag, by: 'muse', typeName: 'general', type: undefined, state: 'working', lastTool: '', text: '', result: '', error: '', started: Date.now(), ended: 0, collected: false, turn: {controller: new AbortController(), toolCalls: 0}, main: tag === 'main', session: {id: 'sess-' + tag}, ctx: null, ...over};
}
function addWorker(a, tag, over = {}) {
  const w = fakeWorker(tag, {ctx: a.ctx, ...over});
  a.workers.set(tag, w);
  return w;
}
function seedFile(a, name = 'f.txt', content = 'old\n') {
  const file = path.join(a.cwd, name);
  fs.writeFileSync(file, content);
  a.ctx.readFiles.add(file); // code.edit / code.write require a prior read
  return file;
}
const EXPLORE = {typeName: 'explore', type: BUILTIN.explore};

// ---------- #9: untagged write/exec while a restricted worker is active ----------

test('fix1 #9: untagged code.edit is refused while a read-only worker runs alongside main; the file is unchanged', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const file = seedFile(a);
  addWorker(a, 'a1', EXPLORE);
  const r = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'PWNED'}, 1000, 'inv-fix1-edit');
  assert.equal(r.ok, false, 'the untagged edit must not run as main');
  assert.match(r.error, /no agent tag/);
  assert.match(r.error, /a1 \(explore\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'no file change');
});

test('fix1 #9: untagged system.run (exec) is refused while a read-only worker is active', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  addWorker(a, 'a1', EXPLORE);
  const target = path.join(a.cwd, 'created.txt');
  const r = await a.execute('system.run', {command: "Set-Content -LiteralPath '" + target + "' -Value x"}, 1000, 'inv-fix1-run');
  assert.equal(r.ok, false);
  assert.match(r.error, /no agent tag/);
  assert.equal(fs.existsSync(target), false, 'the shell command never ran');
});

test('fix1 #9: routeFor with a write command returns null in the conflict, read commands and command-less routing still reach main', (t) => {
  const a = makeAgent(t);
  startTurn(a);
  addWorker(a, 'a1', EXPLORE);
  assert.equal(routeFor(a.workers, {}, 'code.edit'), null, 'write: unattributable, refused');
  assert.equal(routeFor(a.workers, {}, 'system.run'), null, 'exec: unattributable, refused');
  assert.equal(routeFor(a.workers, {}, 'code.read'), a.main, 'a pure read gains nothing from main\'s privileges');
  assert.equal(routeFor(a.workers, {}), a.main, 'no command known (relay takes check): routing is unchanged');
  assert.equal(a.route({agent: 'a1'}, 'code.edit')?.tag, 'a1', 'a tagged call still routes to its own worker (its type gate then applies)');
  const conflict = untaggedRestrictedConflict(a.workers, {}, 'code.edit');
  assert.deepEqual(conflict.restricted.map(w => w.tag), ['a1']);
  assert.equal(untaggedRestrictedConflict(a.workers, {}, 'code.read'), null);
  assert.equal(untaggedRestrictedConflict(a.workers, {agent: 'a1'}, 'code.edit'), null, 'tagged calls are attributable');
});

test('fix1 #9: a tagged read-only worker\'s own code.edit is still refused by its type gate', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const file = seedFile(a);
  addWorker(a, 'a1', EXPLORE);
  const r = await a.execute('code.edit', {agent: 'a1', path: 'f.txt', old_string: 'old', new_string: 'PWNED'}, 1000, 'inv-fix1-tagged');
  assert.equal(r.ok, false);
  assert.match(r.error, /not available to the explore agent type/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
});

test('fix1 #9: untagged read-only calls still run as main while a restricted worker is active', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  seedFile(a, 'f.txt', 'data\n');
  addWorker(a, 'a1', EXPLORE);
  const r = await a.execute('code.read', {path: 'f.txt'}, 1000, 'inv-fix1-read');
  assert.equal(r.ok, true);
  assert.match(r.payload.content, /data/);
});

// ---------- #9: preserved main behaviour ----------

test('fix1 #9: main alone, untagged code.edit still works', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const file = seedFile(a);
  const r = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'new'}, 1000, 'inv-fix1-main-alone');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

test('fix1 #9: untagged code.edit still works while an unrestricted (general) worker is active', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const file = seedFile(a);
  addWorker(a, 'a1', {typeName: 'general', type: BUILTIN.general}); // readOnly: false, tools: null — not restricted
  const r = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'new'}, 1000, 'inv-fix1-general');
  assert.equal(r.ok, true, 'no restricted worker active: main\'s normal untagged usage is preserved');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

test('fix1 #9: once the restricted worker\'s turn ends, untagged code.edit works again', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const file = seedFile(a);
  const w = addWorker(a, 'a1', EXPLORE);
  const r1 = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'PWNED'}, 1000, 'inv-fix1-before');
  assert.equal(r1.ok, false);
  w.turn = null;
  const r2 = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'new'}, 1000, 'inv-fix1-after');
  assert.equal(r2.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

// ---------- deep H8: the relay gets an effective account id ----------

test('fix1 H8: effectiveAccountId is \'default\' when accountId is null and follows switches', (t) => {
  const a = makeAgent(t);
  assert.equal(a.accountId, null, 'the stored accountId still defaults to null');
  assert.equal(a.effectiveAccountId(), 'default', 'the effective id handed to the relay is the default account\'s real id');
  const b = makeAgent(t, {accountId: 'acc2'});
  assert.equal(b.effectiveAccountId(), 'acc2');
  b.accountId = 'acc3'; // what switchAccount assigns on a switch
  assert.equal(b.effectiveAccountId(), 'acc3', 'the effective value stays updated after a switch');
  b.accountId = null;
  assert.equal(b.effectiveAccountId(), 'default');
});

test('fix1 H8: the Relay built by connectDevice reports the effective account id, live', async (t) => {
  const a = makeAgent(t, {auth: {saved: {nodeId: 'fix1-test-node'}, vm: async () => ({})}});
  t.after(() => { try { a.relay?.stop(); } catch {} try { a.device?.disconnect(); } catch {} try { a.nodeSlot?.release(); } catch {} a.closed = true; });
  // The device connect itself cannot succeed in tests (no real VM credentials);
  // the Relay is constructed and started before that step, which is the wiring
  // under test — so any throw past it is expected and ignored.
  await a.connectDevice().catch(() => {});
  assert.ok(a.relay, 'connectDevice built the relay');
  assert.equal(a.relay.account(), 'default', 'a default-account window no longer reports null to the account filter');
  a.accountId = 'acc2'; // switchAccount assignment
  assert.equal(a.relay.account(), 'acc2', 'the relay sees the switched account without being rebuilt');
  a.accountId = null;
  assert.equal(a.relay.account(), 'default');
});
