'use strict';
// Wave 14: the shared permissions file vs a running window, round two.
//  (1) A window pinned with an explicit --mode (modeExplicit) adopts
//      another window's remembered keys but NEVER its mode.
//  (2) Deleting the permissions file resets a running window: the
//      remembered keys clear and an unpinned mode reverts to the
//      settings default; a file re-created later is picked up again
//      (the recorded stamp is null, so the new stamp is seen).
//  (3) A corrupt file is fail-closed the same way (keys clear, unpinned
//      mode reverts), while a VALID file that simply has no entry for
//      this folder leaves the window's mode untouched.
//  (4) Deny wording names the mode the call was judged under
//      (modeFor: 'plan' for a read-only-typed worker), not the window's
//      own mode — for code tools and for MCP tools alike — and an MCP
//      approval granted before a switch to plan is re-judged and
//      declined without the tool ever running (the wave-13 gap).
//  (5) ask(): an "always" answer whose file save fails still keeps the
//      key for this window, but now says so on a progress event
//      (許可をファイルに保存できませんでした…); a save that lands is silent.
//  (6) Controller: setMode whose saveMode fails reverts the mode and
//      notes the failure; the /permissions __forget action whose
//      clearAllow fails keeps the in-memory keys and notes that too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Tests read the Japanese UI strings (setup.mjs pins the same).
process.env.MUSER_LANG = 'ja';
// Self-isolation, the w13 pattern: point home, data and the permissions
// file at throwaway dirs BEFORE any src module loads, so a bare run of
// this file never touches the real ones.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w14-perm-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(ROOT, 'home-'));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(ROOT, 'data-'));
process.env.MUSER_PERMISSIONS_FILE = path.join(ROOT, 'permissions.json');
process.env.MUSER_HISTORY_FILE = path.join(ROOT, 'history.json');
// Head guard: abort unless every one of those lives under this %TEMP%
// root. The Resident Server and the real HOME stay untouched.
for (const [name, v] of Object.entries({USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, MUSER_PERMISSIONS_FILE: process.env.MUSER_PERMISSIONS_FILE})) {
  if (!v || !path.resolve(v).startsWith(path.resolve(ROOT))) throw new Error('w14 isolation guard: ' + name + ' is not under the temp root: ' + v);
}
test.after(() => { try { fs.rmSync(ROOT, {recursive: true, force: true}); } catch {} });

const {Agent} = require('../src/agent');
const {BUILTIN} = require('../src/agent-types');
const permissions = require('../src/permissions');
const settings = require('../src/settings');

const ORIG_PERM = process.env.MUSER_PERMISSIONS_FILE;
function resetFile() { fs.rmSync(ORIG_PERM, {force: true}); process.env.MUSER_PERMISSIONS_FILE = ORIG_PERM; }
function pointAtDir() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'permdir-'));
  process.env.MUSER_PERMISSIONS_FILE = dir; // a directory: every save/read of the "file" fails
  return dir;
}
function restoreFile() { process.env.MUSER_PERMISSIONS_FILE = ORIG_PERM; }

function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, cwd, opts = {}) {
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id: 's1', cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'default', ...opts});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  return a;
}
function projDir() { return fs.mkdtempSync(path.join(ROOT, 'proj-')); }
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
  return a.main.turn;
}
function seedEdit(a, name) {
  const file = path.join(a.cwd, name);
  fs.writeFileSync(file, 'old\n');
  a.ctx.readFiles.add(file);
  return file;
}
function fakeWorker(a, tag, over = {}) {
  const w = {tag, title: tag, by: 'muse', typeName: 'general', type: undefined, state: 'working', lastTool: '', text: '', result: '', error: '', started: Date.now(), ended: 0, collected: false,
    turn: {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0},
    main: false, session: {id: 'sess-' + tag}, ctx: a.ctx,
    snapshot() { return {tag: this.tag, type: this.typeName, state: this.state}; }, ...over};
  a.workers.set(tag, w);
  return w;
}
function fakeMcpHub() {
  const calls = [];
  return {calls, hub: {
    commands: new Map([['mcp.srv.do', {server: 'srv', tool: 'do', readOnly: false}]]),
    config: {mcpServers: {srv: {}}},
    call: async (cmd) => { calls.push(cmd); return {text: 'mcp-result', isError: false}; },
  }};
}

// ---------- (1) pinned mode ----------

test('w14 (1): a modeExplicit window keeps its pinned mode but adopts another window\'s new key', (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd, {mode: 'plan', modeExplicit: true});
  assert.equal(a.modeExplicit, true);
  // Another window remembers a key and chooses a different mode.
  permissions.saveMode(cwd, 'bypass');
  permissions.addAllow(cwd, 'exec:git status');
  assert.equal(a.refreshPermissions(), true, 'the key adoption is a change');
  assert.equal(a.mode, 'plan', 'the pinned mode is NOT overwritten by the file\'s bypass');
  assert.ok(a.allowAlways.has('exec:git status'), 'the new key IS adopted');
  assert.equal(a.refreshPermissions(), false, 'an unchanged stamp is a no-op');
  // A further mode change from elsewhere is likewise ignored, while
  // a further key is still adopted.
  permissions.saveMode(cwd, 'default');
  permissions.addAllow(cwd, 'edit');
  assert.equal(a.refreshPermissions(), true, 'the second key adoption is a change');
  assert.equal(a.mode, 'plan', 'still pinned, not the file\'s default');
  assert.ok(a.allowAlways.has('edit'));
});

// ---------- (2) deletion reset ----------

test('w14 (2): deleting the file clears the keys and reverts an unpinned mode to the settings default; a re-created file is adopted', (t) => {
  resetFile();
  assert.equal(settings.defaultMode(), 'default', 'the isolated home has no saved default mode');
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  permissions.addAllow(cwd, 'edit');
  permissions.saveMode(cwd, 'auto-edit');
  assert.equal(a.refreshPermissions(), true);
  assert.equal(a.mode, 'auto-edit');
  assert.ok(a.allowAlways.has('edit'));
  fs.rmSync(ORIG_PERM, {force: true}); // the file is deleted under the running window
  assert.equal(permissions.stamp(), null);
  assert.equal(a.refreshPermissions(), true, 'the deletion itself is a change');
  assert.equal(a.allowAlways.size, 0, 'the remembered key is gone');
  assert.equal(a.mode, 'default', 'the mode reverted to the settings default');
  assert.equal(a.refreshPermissions(), false, 'still no file: nothing more to reset');
  // Re-created later: the recorded stamp is null, so the new file is seen.
  permissions.addAllow(cwd, 'exec:git status');
  permissions.saveMode(cwd, 'plan');
  assert.equal(a.refreshPermissions(), true, 'the re-created file is picked up');
  assert.ok(a.allowAlways.has('exec:git status'), 'the new key is adopted');
  assert.equal(a.mode, 'plan', 'the new mode is adopted');
});

// ---------- (3) corrupt reset / valid-but-no-entry ----------

test('w14 (3): a corrupt file clears the keys and reverts an unpinned mode to the default', (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  permissions.addAllow(cwd, 'edit');
  permissions.saveMode(cwd, 'auto-edit');
  assert.equal(a.refreshPermissions(), true);
  assert.equal(a.mode, 'auto-edit');
  assert.ok(a.allowAlways.has('edit'));
  fs.writeFileSync(ORIG_PERM, '{not json,,'); // a hand edit breaks the file
  assert.equal(permissions.fileState(), 'corrupt');
  assert.equal(a.refreshPermissions(), true);
  assert.equal(a.allowAlways.size, 0, 'load() reads a corrupt file as no keys, and the window follows');
  assert.equal(a.mode, 'default', 'a corrupt file cannot vouch for the mode: back to the settings default');
});

test('w14 (3): a valid file with no entry for this folder leaves the mode untouched', (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd, {mode: 'bypass'});
  // A perfectly valid store — it just remembers a DIFFERENT folder.
  fs.writeFileSync(ORIG_PERM, JSON.stringify({version: 1, folders: {'some-other-folder': {mode: 'plan', allow: ['edit']}}}));
  assert.equal(permissions.fileState(), 'ok');
  assert.equal(a.refreshPermissions(), false, 'nothing for this folder changed');
  assert.equal(a.mode, 'bypass', 'no entry is not a reset: the window keeps its mode');
  assert.equal(a.allowAlways.size, 0);
});

// ---------- (4) deny wording + MCP re-judge ----------

test('w14 (4): a read-only worker\'s MCP call is denied in the name of plan, not the window\'s bypass mode', async (t) => {
  resetFile();
  const cwd = projDir();
  const {calls, hub} = fakeMcpHub();
  const a = makeAgent(t, cwd, {mode: 'bypass', mcp: hub});
  startTurn(a);
  fakeWorker(a, 'a1', {typeName: 'explore', type: BUILTIN.explore});
  assert.equal(a.modeFor(a.workers.get('a1')), 'plan', 'a read-only type is judged under plan rules');
  const r = await a.execute('mcp.srv.do', {agent: 'a1'}, 5000, 'w14-mcp-deny');
  assert.equal(r.ok, false);
  assert.match(r.error, /Not allowed in plan mode/, 'the deny names the judging mode');
  assert.doesNotMatch(r.error, /bypass/, 'not the window\'s own mode');
  assert.equal(calls.length, 0, 'the MCP tool never ran');
  assert.equal(a.mode, 'bypass', 'the window mode itself is untouched');
});

test('w14 (4): a read-only worker\'s write via system.run is denied as read-only, never under the window mode', async (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd, {mode: 'bypass'});
  startTurn(a);
  fakeWorker(a, 'a1', {typeName: 'explore', type: BUILTIN.explore});
  let asked = 0;
  a.approver = async () => { asked++; return {allow: true}; };
  const target = path.join(cwd, 'pwn.txt');
  const r = await a.execute('system.run', {agent: 'a1', command: 'echo PWNED > pwn.txt'}, 5000, 'w14-ro-deny');
  assert.equal(r.ok, false);
  assert.match(r.error, /read-only/, 'the deny is the read-only worker\'s, judged under plan rules');
  assert.doesNotMatch(r.error, /bypass/);
  assert.equal(asked, 0, 'a flat deny never reaches the approver');
  assert.equal(fs.existsSync(target), false, 'nothing ran');
});

test('w14 (4): executeMcp re-judges after the wait — approval granted, mode switched to plan, the tool never runs', async (t) => {
  resetFile();
  const cwd = projDir();
  const {calls, hub} = fakeMcpHub();
  const a = makeAgent(t, cwd, {mode: 'default', mcp: hub});
  startTurn(a);
  let release;
  a.approver = () => new Promise(res => { release = () => res({allow: true}); });
  const p = a.execute('mcp.srv.do', {}, 5000, 'w14-mcp-wait');
  await new Promise(r => setTimeout(r, 50)); // the approval is open now
  permissions.saveMode(cwd, 'plan'); // another window switches to plan mid-wait
  release();
  const r = await p;
  assert.equal(r.ok, false, 'the yes given under the old mode does not run the MCP call');
  assert.match(r.error, /approval mode changed to plan while waiting for approval/);
  assert.match(r.error, /MCP tool may change things/);
  assert.equal(calls.length, 0, 'the MCP tool never ran');
  assert.equal(a.mode, 'plan', 'the window adopted the new mode at the re-judgment');
  // Control: back in default, the same approved call runs.
  permissions.saveMode(cwd, 'default');
  a.approver = async () => ({allow: true});
  const r2 = await a.execute('mcp.srv.do', {}, 5000, 'w14-mcp-ctl');
  assert.equal(r2.ok, true);
  assert.equal(r2.payload.result, 'mcp-result');
  assert.equal(calls.length, 1);
});

// ---------- (5) ask() save failure / success ----------

test('w14 (5): an always answer whose save fails keeps the key for this window and says so on progress', async (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  startTurn(a);
  const progress = [];
  a.on('progress', e => progress.push(e));
  a.approver = async () => ({allow: true, always: 'edit'});
  const file = seedEdit(a, 'f.txt');
  pointAtDir(); // addAllow cannot save: the permissions path is a directory
  try {
    const r = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'new'}, 5000, 'w14-ask-fail');
    assert.equal(r.ok, true, 'the approved edit itself still runs');
  } finally { restoreFile(); }
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
  assert.ok(a.allowAlways.has('edit'), 'the key is kept in this window\'s allowAlways');
  const said = progress.filter(e => /保存できませんでした/.test(e.message || ''));
  assert.equal(said.length, 1, 'exactly one progress event reports the failed save');
  assert.equal(said[0].message, '許可をファイルに保存できませんでした。この窓の間だけ覚えます。');
  assert.deepEqual(permissions.load(cwd).allow, [], 'nothing was persisted to the real file');
});

test('w14 (5): an always answer whose save lands emits no save-failure progress event', async (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  startTurn(a);
  const progress = [];
  a.on('progress', e => progress.push(e));
  a.approver = async () => ({allow: true, always: 'edit'});
  seedEdit(a, 'f.txt');
  const r = await a.execute('code.edit', {path: 'f.txt', old_string: 'old', new_string: 'new'}, 5000, 'w14-ask-ok');
  assert.equal(r.ok, true);
  assert.ok(a.allowAlways.has('edit'));
  assert.ok(permissions.load(cwd).allow.includes('edit'), 'the key was persisted');
  assert.equal(progress.filter(e => /保存できませんでした/.test(e.message || '')).length, 0, 'the success path stays silent');
});

// ---------- (6) controller ----------

class CtrlFakeAgent extends EventEmitter {
  constructor(c) { super(); this.mode = 'default'; this.cwd = c; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set(), todos: []}; this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true}; }
}
async function mkController(cwd) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new CtrlFakeAgent(cwd);
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  return {agent, ctrl};
}
const noteLines = ctrl => ctrl.get().entries.filter(e => e.type === 'note').flatMap(e => e.lines);

test('w14 (6): setMode reverts and notes the failure when saveMode cannot save; a later save succeeds', async (t) => {
  resetFile();
  const cwd = projDir();
  const {agent, ctrl} = await mkController(cwd);
  pointAtDir(); // saveMode cannot save: the permissions path is a directory
  let ret;
  try { ret = ctrl.setMode('plan'); } finally { restoreFile(); }
  assert.equal(ret, false, 'setMode reports the failure');
  assert.equal(agent.mode, 'default', 'the agent mode reverted');
  assert.equal(ctrl.get().mode, 'default', 'the shown mode reverted too');
  assert.ok(noteLines(ctrl).includes('承認モードを保存できませんでした。ファイルを確認してください。'), 'the failure is noted');
  // Control: with a working file the same call sticks and is remembered.
  assert.equal(ctrl.setMode('plan'), true);
  assert.equal(agent.mode, 'plan');
  assert.equal(ctrl.get().mode, 'plan');
  assert.equal(permissions.load(cwd).mode, 'plan');
  assert.equal(noteLines(ctrl).filter(l => l === '承認モードを保存できませんでした。ファイルを確認してください。').length, 1, 'no second failure note');
});

test('w14 (6): the __forget action keeps allowAlways and notes the failure when clearAllow cannot clear the file', async (t) => {
  resetFile();
  const cwd = projDir();
  const {agent, ctrl} = await mkController(cwd);
  permissions.addAllow(cwd, 'edit'); // remembered by another window
  permissions.addAllow(cwd, 'exec:git status');
  ctrl.slash('/permissions');
  const menu = ctrl.get().menu;
  const forget = menu?.options.find(o => o.value === '__forget');
  assert.ok(forget, 'the forget entry is built from the file state');
  assert.deepEqual([...agent.allowAlways].sort(), ['edit', 'exec:git status'], 'the menu build synced this window from the file');
  pointAtDir(); // clearAllow cannot clear: the permissions path is a directory
  try { menu.pick('__forget'); } finally { restoreFile(); }
  assert.deepEqual([...agent.allowAlways].sort(), ['edit', 'exec:git status'], 'the in-memory keys are kept when the file clear fails');
  assert.ok(noteLines(ctrl).includes('記憶した許可をファイルから消せませんでした。'), 'the failure is noted');
  assert.ok(!noteLines(ctrl).includes('このフォルダーで記憶した許可を消しました。'), 'the success note is not shown');
  // Control: with a working file the same action clears both.
  ctrl.slash('/permissions');
  const menu2 = ctrl.get().menu;
  assert.ok(menu2?.options.some(o => o.value === '__forget'));
  menu2.pick('__forget');
  assert.equal(agent.allowAlways.size, 0);
  assert.deepEqual(permissions.load(cwd).allow, [], 'the file is cleared too');
  assert.ok(noteLines(ctrl).includes('このフォルダーで記憶した許可を消しました。'));
});

// ---------- (7) stamp() is a content hash, not a timestamp ----------

test('w14 (7): stamp() differs for two different same-size payloads, every time, over rapid alternations', () => {
  resetFile();
  const payloadA = JSON.stringify({version: 1, folders: {folder: {mode: null, allow: ['aaaa']}}});
  const payloadB = JSON.stringify({version: 1, folders: {folder: {mode: null, allow: ['bbbb']}}});
  assert.equal(Buffer.byteLength(payloadA), Buffer.byteLength(payloadB), 'the two payloads are padded to identical length: only the key differs');
  let firstA, firstB;
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(ORIG_PERM, payloadA);
    const sa = permissions.stamp();
    fs.writeFileSync(ORIG_PERM, payloadB);
    const sb = permissions.stamp();
    assert.notEqual(sa, sb, 'iteration ' + i + ': a same-size key swap written back-to-back must move the stamp (the old mtime stamp collided within the ~1ms quantum)');
    assert.equal(typeof sa, 'string');
    assert.equal(sa.split(':')[0], String(Buffer.byteLength(payloadA)), 'the stamp carries the byte length');
    if (i === 0) { firstA = sa; firstB = sb; }
    else {
      assert.equal(sa, firstA, 'iteration ' + i + ': identical content A keeps the same stamp');
      assert.equal(sb, firstB, 'iteration ' + i + ': identical content B keeps the same stamp');
    }
  }
});

test('w14 (7): identical content rewritten keeps the stamp; a missing file stamps null', () => {
  resetFile();
  fs.rmSync(ORIG_PERM, {force: true});
  assert.equal(permissions.stamp(), null, 'a missing file stamps null');
  const payload = JSON.stringify({version: 1, folders: {folder: {mode: null, allow: ['aaaa']}}});
  fs.writeFileSync(ORIG_PERM, payload);
  const s1 = permissions.stamp();
  assert.equal(typeof s1, 'string');
  fs.writeFileSync(ORIG_PERM, payload); // identical bytes, rewritten
  assert.equal(permissions.stamp(), s1, 'rewriting identical content does not move the stamp');
  fs.rmSync(ORIG_PERM, {force: true});
  assert.equal(permissions.stamp(), null, 'deleting the file returns the stamp to null');
});

test('w14 (7): a real Agent refresh adopts a same-size key swap written immediately after its previous refresh', (t) => {
  resetFile();
  const cwd = projDir();
  const a = makeAgent(t, cwd);
  const k = permissions.key(cwd);
  const payA = JSON.stringify({version: 1, folders: {[k]: {mode: null, allow: ['aaaa']}}});
  const payB = JSON.stringify({version: 1, folders: {[k]: {mode: null, allow: ['bbbb']}}});
  assert.equal(Buffer.byteLength(payA), Buffer.byteLength(payB), 'the swap is same-size');
  fs.writeFileSync(ORIG_PERM, payA);
  assert.equal(a.refreshPermissions(), true, 'the first payload is adopted');
  assert.ok(a.allowAlways.has('aaaa'));
  assert.ok(!a.allowAlways.has('bbbb'));
  // No sleep, no tick wait: the swap lands immediately after the refresh.
  fs.writeFileSync(ORIG_PERM, payB);
  assert.equal(a.refreshPermissions(), true, 'the same-size swap is seen at once, not missed as an unchanged timestamp');
  assert.ok(a.allowAlways.has('bbbb'), 'the new key is adopted');
  assert.ok(!a.allowAlways.has('aaaa'), 'the swapped-out key is gone');
  assert.equal(a.refreshPermissions(), false, 'control: with no further write, a refresh is a no-op');
});
