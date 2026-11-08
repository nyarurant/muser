'use strict';
// Wave 13: a running window must follow the shared permissions file.
//  (1) Another window's save / revoke / mode change applies from the next
//      judgment on (the file's stamp is checked on each judgment).
//  (2) A mode change while an approval waits that flatly forbids the call
//      (plan vs a write) stops it even after the user answers yes.
//  (3) The /permissions 「記憶した許可を消す」 entry is built from the file's
//      latest state, so keys another window remembered can be cleared here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Self-isolation, the permissions.test.js / fix2-agent.test.js pattern:
// point home, data and the permissions file at throwaway dirs BEFORE any
// src module loads, so a bare run of this file never touches the real ones.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w13-perm-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(ROOT, 'home-'));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(ROOT, 'data-'));
process.env.MUSER_PERMISSIONS_FILE = path.join(ROOT, 'permissions.json');
process.env.MUSER_HISTORY_FILE = path.join(ROOT, 'history.json');
test.after(() => { try { fs.rmSync(ROOT, {recursive: true, force: true}); } catch {} });

const {Agent} = require('../src/agent');
const permissions = require('../src/permissions');

function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, cwd) {
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id: 's1', cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'default'});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  return a;
}
function projDir() { return fs.mkdtempSync(path.join(ROOT, 'proj-')); }
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
}
function seedEdit(a, name) {
  const file = path.join(a.cwd, name);
  fs.writeFileSync(file, 'old\n');
  a.ctx.readFiles.add(file);
  return file;
}

test('w13 permissions: stamp() is null with no file and moves on every save', (t) => {
  fs.rmSync(process.env.MUSER_PERMISSIONS_FILE, {force: true});
  assert.equal(permissions.stamp(), null);
  const cwd = projDir();
  permissions.addAllow(cwd, 'edit');
  const s1 = permissions.stamp();
  assert.equal(typeof s1, 'string');
  permissions.saveMode(cwd, 'plan');
  assert.notEqual(permissions.stamp(), s1);
});

test('w13 (1): a running window picks up another window\'s additions, revocations and mode changes', (t) => {
  fs.rmSync(process.env.MUSER_PERMISSIONS_FILE, {force: true});
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  permissions.addAllow(cwd, 'exec:git status');
  permissions.saveMode(cwd, 'auto-edit');
  assert.equal(a.refreshPermissions(), true);
  assert.equal(a.mode, 'auto-edit');
  assert.ok(a.allowAlways.has('exec:git status'));
  assert.equal(a.refreshPermissions(), false, 'an unchanged stamp is a no-op');
  permissions.clearAllow(cwd);
  permissions.saveMode(cwd, 'plan');
  assert.equal(a.refreshPermissions(), true);
  assert.equal(a.allowAlways.size, 0, 'a revocation removes the key here too');
  assert.equal(a.mode, 'plan');
});

test('w13 (1): judgments use the fresh state — a key remembered elsewhere skips asking, its revocation asks again', async (t) => {
  fs.rmSync(process.env.MUSER_PERMISSIONS_FILE, {force: true});
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  startTurn(a);
  let asked = 0;
  a.approver = async () => { asked++; return {allow: true}; };
  permissions.addAllow(cwd, 'edit'); // remembered by ANOTHER window after this one started
  const f1 = seedEdit(a, 'g.txt');
  const r1 = await a.execute('code.edit', {path: 'g.txt', old_string: 'old', new_string: 'new'}, 5000, 'w13-j1');
  assert.equal(r1.ok, true);
  assert.equal(asked, 0, 'the fresh key judged the edit without an approval');
  assert.equal(fs.readFileSync(f1, 'utf8'), 'new\n');
  permissions.clearAllow(cwd); // revoked elsewhere
  seedEdit(a, 'h.txt');
  const r2 = await a.execute('code.edit', {path: 'h.txt', old_string: 'old', new_string: 'new'}, 5000, 'w13-j2');
  assert.equal(r2.ok, true);
  assert.equal(asked, 1, 'after the revocation the next judgment asks again');
});

test('w13 (2): a mode change to plan while an approval waits stops the approved write', async (t) => {
  fs.rmSync(process.env.MUSER_PERMISSIONS_FILE, {force: true});
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  startTurn(a);
  const file = seedEdit(a, 'f.txt');
  let release;
  a.approver = () => new Promise(res => { release = () => res({allow: true}); });
  const p = a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'PWNED'}, 5000, 'w13-wait');
  await new Promise(r => setTimeout(r, 50)); // the approval is open now
  permissions.saveMode(cwd, 'plan'); // another window switches to plan mid-wait
  release();
  const r = await p;
  assert.equal(r.ok, false, 'the yes given under the old mode does not run the write');
  assert.match(r.error, /mode changed to plan while waiting for approval/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'nothing was written');
  // Control: back in default, the same approved edit runs.
  permissions.saveMode(cwd, 'default');
  a.approver = async () => ({allow: true});
  const r2 = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'new'}, 5000, 'w13-ctl');
  assert.equal(r2.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

test('w13 (3): the /permissions forget entry is built from the file, and clearing there clears the file', async (t) => {
  fs.rmSync(process.env.MUSER_PERMISSIONS_FILE, {force: true});
  const cwd = projDir();
  class FakeAgent extends EventEmitter {
    constructor(c) { super(); this.mode = 'default'; this.cwd = c; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()}; this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true}; }
  }
  const agent = new FakeAgent(cwd); // this window remembers nothing yet
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  permissions.addAllow(cwd, 'exec:git status'); // another window remembers these
  permissions.addAllow(cwd, 'edit');
  ctrl.slash('/permissions');
  const menu = ctrl.get().menu;
  const forget = menu?.options.find(o => o.value === '__forget');
  assert.ok(forget, 'the forget entry appears from the file state alone');
  assert.match(forget.desc, /2 件/);
  assert.match(forget.desc, /git status/);
  menu.pick('__forget');
  assert.deepEqual(permissions.load(cwd).allow, [], 'clearing from this window clears the other window\'s keys in the file');
  assert.equal(agent.allowAlways.size, 0);
  agent.allowAlways.add('exec:stale'); // a key revoked elsewhere must not be listed
  ctrl.slash('/permissions');
  assert.ok(!ctrl.get().menu?.options.some(o => o.value === '__forget'), 'a stale in-memory key is not offered for clearing');
});
