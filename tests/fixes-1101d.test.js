'use strict';
// Regression tests for the 2026-11-01 (batch d) fixes: policy optional-value
// flags / remote show / rev:path secrets / .git writes, tools sensitive-path
// coverage and grep post-filtering, agent invoke routing, spawn counting,
// turn.sent timing, instruction truncation marker and local date, skills
// SKILL.md guards, secure-store cache stamping, permissions locking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
// t6 #6 (deep audit): this file had NO data-folder isolation, yet the SEC9
// tests save into the real secure-store and A9b writes a real transcript —
// under `npm test` tests/setup.mjs isolates, but a bare
// `node --test tests/fixes-1101d.test.js` used the developer's real
// %LOCALAPPDATA%\muser. Point both roots at temp folders BEFORE any src
// module reads them (secure-store/sessions compute their DIR at load).
const isoData = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fixd-data-'));
const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fixd-home-'));
process.env.LOCALAPPDATA = isoData;
process.env.USERPROFILE = isoHome;
process.env.HOME = isoHome;
test.after(() => { fs.rmSync(isoData, {recursive: true, force: true}); fs.rmSync(isoHome, {recursive: true, force: true}); });
const {readOnlyCommand, decide} = require('../src/policy');
const {TOOLS, isSensitivePath, dropSensitiveLines} = require('../src/tools');
const {Agent, routeFor, projectInstructions, preamble, localToday} = require('../src/agent');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fixd-'));
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
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'fixd-main-' + Math.random().toString(36).slice(2), cwd, title: '', created: 0, updated: 0, turns: 0}, ...agentOpts});
  a.subscribed = true;
  return a;
}

// ---------- SEC1: optional-value git flags must not swallow the next token ----------

test('SEC1: a flag after an optional-value flag is validated, not consumed as its value', () => {
  assert.equal(readOnlyCommand('git grep --color --open-files-in-pager=less TODO'), false);
  assert.equal(readOnlyCommand('git grep --color --open-files-in-pager less TODO'), false);
  assert.equal(readOnlyCommand('git status --porcelain --unknown-flag'), false);
  assert.equal(readOnlyCommand('git grep --color=always TODO'), true, '--name=value still works');
  assert.equal(readOnlyCommand('git grep --color TODO'), true, 'the pattern is not eaten as the colour');
  assert.equal(readOnlyCommand('git status --porcelain'), true);
  assert.equal(readOnlyCommand('git status --porcelain=v2'), true);
  assert.equal(readOnlyCommand('git log --max-count 5'), true, 'required-value flags still take the next token');
  assert.equal(readOnlyCommand('git log --format=%H'), true);
});

// ---------- SEC2: git remote show contacts the remote unless -n ----------

test('SEC2: only `git remote show -n` is read-only', () => {
  assert.equal(readOnlyCommand('git remote show origin'), false, 'plain show runs repo-config ssh/credential helpers');
  assert.equal(readOnlyCommand('git remote show'), false);
  assert.equal(readOnlyCommand('git remote show -n origin'), true);
  assert.equal(readOnlyCommand('git remote show -n'), true);
  assert.equal(readOnlyCommand('git remote show origin -n'), true);
  assert.equal(readOnlyCommand('git remote show -n origin extra'), false);
  assert.equal(readOnlyCommand('git remote show -n --verbose'), false, 'no other flags ride along');
  assert.equal(readOnlyCommand('git remote'), true);
  assert.equal(readOnlyCommand('git remote -v'), true);
});

// ---------- SEC3: rev:path tokens are secret-checked after the ':' ----------

test('SEC3: git show HEAD:.env is not an unasked read', () => {
  const d = command => decide({mode: 'plan', kind: 'exec', params: {command}, gitConfig: () => ''});
  assert.equal(d('git show HEAD:.env'), 'deny');
  assert.equal(d('git show HEAD:src/.env'), 'deny');
  assert.equal(d('git show HEAD~2:.envrc'), 'deny');
  assert.equal(d('git show HEAD:src/policy.js'), 'allow');
  assert.equal(d('git show HEAD'), 'allow');
});

// ---------- SEC6: writes under .git/ always ask outside bypass ----------

test('SEC6: .git/config and .git/hooks writes ask even in auto-edit', () => {
  const proj = path.join(os.tmpdir(), 'someproj');
  const e = (mode, file, extra = {}) => decide({mode, kind: 'edit', params: {path: file}, outside: false, targets: [file], ...extra});
  assert.equal(e('auto-edit', path.join(proj, '.git', 'config')), 'ask');
  assert.equal(e('auto-edit', path.join(proj, '.git', 'hooks', 'pre-commit')), 'ask');
  assert.equal(e('default', path.join(proj, '.git', 'config')), 'ask');
  assert.equal(e('auto-edit', path.join(proj, '.git', 'config'), {always: new Set(['edit'])}), 'ask', 'a remembered edit does not cover it');
  assert.equal(e('auto-edit', path.join(proj, 'src', '.gitkeep')), 'allow', 'a name merely containing .git is fine');
  assert.equal(e('auto-edit', path.join(proj, 'src', 'app.js')), 'allow');
  assert.equal(e('bypass', path.join(proj, '.git', 'config')), 'allow', 'bypass stays the user\'s choice');
});

// ---------- SEC5: the canonical sensitive list covers more key/credential stores ----------

test('SEC5: id_* keys, credentials.yaml/toml, logins.json, .azure and .config/gcloud are sensitive', () => {
  const home = os.homedir();
  for (const f of ['id_ecdsa', 'id_dsa', 'id_xmss', 'id_ed25519_sk', path.join(home, '.ssh', 'id_ecdsa'),
    'credentials.yaml', 'credentials.yml', 'credentials.toml', 'logins.json',
    path.join(home, '.azure', 'clouds.config'), path.join(home, '.config', 'gcloud', 'credentials.db'),
    path.join(home, '.config', 'gcloud', 'legacy_credentials', 'x', 'adc.json')])
    assert.equal(isSensitivePath(f), true, f);
  for (const f of ['id_rsa.pub', 'id_ecdsa.pub', 'src/id_util.js', 'credentials.md', 'docs/credentials-guide.md',
    path.join(home, 'work', 'gcloud', 'notes.txt'), 'src/logins.json.bak.md'])
    assert.equal(isSensitivePath(f), false, f);
});

// ---------- SEC4: code.grep output is post-filtered through isSensitivePath ----------

test('SEC4: grep never prints lines from sensitive files, however rg found them', async t => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, 'id_ecdsa'), 'KEYSECRET=1\n');
  fs.writeFileSync(path.join(dir, 'credentials.yaml'), 'YAMLSECRET=1\n');
  fs.writeFileSync(path.join(dir, 'logins.json'), 'LOGINSECRET=1\n');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'APPSECRET=1\n');
  const ctx = {cwd: dir, readFiles: new Set(), todos: []};
  const r = await TOOLS['code.grep'].run({pattern: 'SECRET'}, ctx);
  assert.match(r.payload.output, /APPSECRET/);
  for (const leaked of ['KEYSECRET', 'YAMLSECRET', 'LOGINSECRET', 'id_ecdsa', 'credentials.yaml', 'logins.json'])
    assert.ok(!r.payload.output.includes(leaked), 'leaked: ' + leaked);
  assert.equal(r.payload.matches, 1);
  const only = await TOOLS['code.grep'].run({pattern: 'SECRET', files_only: true}, ctx);
  assert.match(only.payload.output, /app\.txt/);
  assert.ok(!only.payload.output.includes('id_ecdsa'));
});

test('SEC4: dropSensitiveLines drops by the named path (hit, context and binary lines)', t => {
  const dir = tmpdir(t);
  const ctx = {cwd: dir};
  const lines = ['.\\sub\\.envrc:1:ENVRCSECRET', 'ok.txt:2:fine', 'notes-2026.txt:1:plain', 'Binary file credentials.toml matches', '--'];
  const kept = dropSensitiveLines(lines, ctx, false);
  assert.deepEqual(kept, ['ok.txt:2:fine', 'notes-2026.txt:1:plain', '--']);
  assert.deepEqual(dropSensitiveLines(['a.txt', '.envrc', 'id_ecdsa'], ctx, true), ['a.txt']);
});

// ---------- SEC7: untagged invokes are never guessed onto a parallel agent ----------
// Corrected 2026-11-01: refusing untagged calls whenever main and an agent were both working left
// the main session (which omits its tag) unable to use the device from its first agent.spawn on.

test('SEC7: routeFor does not guess between several active agents; an untagged call is main\'s', () => {
  const fake = (tag, active) => ({tag, turn: active ? {controller: new AbortController()} : null});
  const main = fake('main', true), a1 = fake('a1', true), a2 = fake('a2', true);
  assert.equal(routeFor([main, a1], {}), main, 'main + agent active: the main session omits its tag');
  assert.equal(routeFor([main, a1, a2], {}), main);
  assert.equal(routeFor([fake('main', false), a1, a2], {}), null, 'two workers, main idle: not the first');
  assert.equal(routeFor([fake('main', false), a1], {}), a1, 'exactly one active routes');
  assert.equal(routeFor([main], {}), main, 'only main active routes to main');
  assert.equal(routeFor([fake('main', false), fake('a1', false)], {}), null, 'nobody active');
  assert.equal(routeFor([main, a1], {agent: 'a1'}), a1, 'an explicit tag still routes');
});

// ---------- A9a: spawn limit counts workers still connecting ----------

test('A9a: a worker whose turn has not been assigned yet still counts toward the spawn limit', t => {
  const a = makeAgent(t, {agentLimits: {maxAgents: 1, maxAgentsTotal: 0}});
  a.ensureConnected = () => new Promise(() => {}); // reconnect hangs: runTurn never reaches the w.turn assignment
  const w = a.spawn('first');
  assert.equal(w.turn, null, 'the turn is not assigned yet');
  assert.equal(w.starting, true, 'but the worker is marked as starting, synchronously');
  assert.throws(() => a.spawn('second'), /同時に 1 つまで/);
});

// ---------- A9b: sent is marked at send; a later setup failure cancels remotely ----------

test('A9b: when subscribeAgent fails after the send, the turn is cancelled on Muse\'s side and recorded', async t => {
  const a = makeAgent(t);
  // t6 #6: the transcript this writes lives under the isolated data folder
  // (header above); still remove it explicitly so nothing test-shaped stays.
  t.after(() => { try { fs.rmSync(require('../src/sessions').transcriptFile(a.session.id), {force: true}); } catch {} });
  a.session.turns = 2;
  a.device = {connected: true, send: async () => ({message_id: 'm1'})};
  const cancelled = [];
  a.client.cancel = async id => { cancelled.push(id); };
  a.client.subscribeAgent = async () => { throw new Error('subscribe failed'); };
  await assert.rejects(a.send('hello'), /subscribe failed/);
  assert.deepEqual(cancelled, [a.session.id], 'the already-sent turn was cancelled remotely before the error propagated');
  const log = require('../src/sessions').transcript(a.session.id);
  assert.equal(log.length, 1, 'the sent turn is in the transcript even though setup failed');
  assert.match(log[0].error, /subscribe failed/);
  assert.equal(a.main.turn, null);
});

// ---------- A9c: the per-file instruction slice carries a truncation marker ----------

test('A9c: an instruction file over 12,000 chars is cut WITH the note, inside the budget', t => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, 'A'.repeat(13000));
  const entry = projectInstructions(dir).find(e => e.file === file);
  assert.ok(entry, 'the file is still included');
  assert.ok(entry.text.length <= 12000, 'within the per-file budget: ' + entry.text.length);
  assert.ok(entry.text.endsWith('（プロジェクト指示が長いため一部省略しました）'), 'the cut is marked, not silent');
});

// ---------- A9d: the preamble names the local date ----------

test('A9d: Today is the local calendar date, not UTC', t => {
  assert.equal(localToday(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localToday(new Date(2026, 10, 1, 0, 1)), '2026-11-01');
  const dir = tmpdir(t);
  assert.ok(preamble(dir, []).includes('Today: ' + localToday() + '.'));
});

// ---------- SEC8: SKILL.md itself passes the skill.read guards; load() caps its read ----------

function skillSandbox(t) {
  const root = tmpdir(t);
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const saved = {USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME};
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  return {home, proj};
}

test('SEC8: load() skips a SKILL.md over the size cap instead of reading it whole', t => {
  const {home, proj} = skillSandbox(t);
  const big = path.join(home, '.muser', 'skills', 'big'); fs.mkdirSync(big, {recursive: true});
  fs.writeFileSync(path.join(big, 'SKILL.md'), '---\nname: big\ndescription: x\n---\n' + 'B'.repeat(300 * 1024));
  const small = path.join(home, '.muser', 'skills', 'small'); fs.mkdirSync(small, {recursive: true});
  fs.writeFileSync(path.join(small, 'SKILL.md'), '---\nname: small\ndescription: y\n---\nbody');
  const skills = require('../src/skills');
  assert.deepEqual(skills.load(proj).map(s => s.name), ['small']);
  // Audit #230: the read says WHY the skill was skipped, not a bare "No skill named"
  // (the skill exists — it was the old generic answer that hid the size cap).
  assert.throws(() => skills.read(proj, {name: 'big'}), /was skipped: its SKILL\.md is \d+ bytes, over the 262144-byte limit/);
});

test('SEC8: reading a skill whose folder really lives in ~/.ssh is refused', t => {
  const {home, proj} = skillSandbox(t);
  const real = path.join(home, '.ssh', 'evilskill'); fs.mkdirSync(real, {recursive: true});
  fs.writeFileSync(path.join(real, 'SKILL.md'), '---\nname: evil\ndescription: x\n---\nbody');
  const linkParent = path.join(proj, '.muser', 'skills'); fs.mkdirSync(linkParent, {recursive: true});
  fs.symlinkSync(real, path.join(linkParent, 'evil'), 'junction');
  const skills = require('../src/skills');
  // Phase-2 coordination (skills c17 #5): a project-source skill folder that
  // is a link out of its root is now refused at LOAD time, so the junctioned
  // ~/.ssh skill never becomes a skill at all — read() then reports it as
  // unknown instead of reaching the sensitive-path guard. The security claim
  // is unchanged and stronger: the skill is neither listed nor readable.
  assert.ok(!skills.load(proj).some(s => s.name === 'evil'), 'the junctioned skill is not listed');
  assert.throws(() => skills.read(proj, {name: 'evil'}), /No skill named/, 'and cannot be read');
});

// ---------- SEC9: secure-store caches only the bytes it decrypted ----------

test('SEC9: a file replaced while load() decrypts is not cached under the new stamp', t => {
  const ss = require('../src/secure-store');
  const name = 'race-' + process.pid + '.enc', target = ss.file(name);
  t.after(() => ss.remove(name)); // t6 #6: cleanup also when an assert above fails (was success-path only)
  ss.save(name, {v: 1}); const ct1 = fs.readFileSync(target);
  ss.save(name, {v: 2}); const ct2 = fs.readFileSync(target);
  fs.writeFileSync(target, ct1); // back to v1 under a fresh stamp: the cached v2 misses
  const origRead = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (p, ...rest) {
    const out = origRead.call(fs, p, ...rest);
    if (!swapped && String(p) === target) { swapped = true; fs.writeFileSync(target, ct2); } // "another window" writes mid-load
    return out;
  };
  try { assert.deepEqual(ss.load(name), {v: 1}, 'the bytes actually read are the ones decrypted'); }
  finally { fs.readFileSync = origRead; }
  assert.deepEqual(ss.load(name), {v: 2}, 'the next load serves the new value, not the stale cached one');
  ss.remove(name);
});

test('SEC9: an unchanged file is still served from the cache on the second load', t => {
  const ss = require('../src/secure-store');
  const name = 'plain-' + process.pid + '.enc';
  t.after(() => ss.remove(name)); // t6 #6: cleanup also on failure
  ss.save(name, {ok: true});
  assert.deepEqual(ss.load(name), {ok: true});
  assert.deepEqual(ss.load(name), {ok: true});
  ss.remove(name);
});

// ---------- SEC10: permissions updates are serialized with a lock file ----------

test('SEC10: a stale lock is taken over and a held lock does not lose the update', t => {
  const dir = tmpdir(t);
  const f = path.join(dir, 'permissions.json');
  process.env.MUSER_PERMISSIONS_FILE = f;
  t.after(() => { delete process.env.MUSER_PERMISSIONS_FILE; });
  const permissions = require('../src/permissions');
  const lock = f + '.lock';
  fs.writeFileSync(lock, '');
  const longAgo = new Date(Date.now() - 60000);
  fs.utimesSync(lock, longAgo, longAgo); // left by a crashed window
  permissions.saveMode('C:\\proj', 'plan');
  assert.equal(permissions.load('C:\\proj').mode, 'plan');
  assert.equal(fs.existsSync(lock), false, 'the lock is released afterwards');
  fs.writeFileSync(lock, ''); // a live window holds it: the update waits, then still lands
  permissions.addAllow('C:\\proj', 'exec:git status');
  assert.deepEqual(permissions.load('C:\\proj').allow, ['exec:git status']);
  fs.rmSync(lock, {force: true});
});

test('main keeps using the device while its parallel agent works (the 2026-11-01 "muser is idle" regression)', async () => {
  const {EventEmitter} = require('node:events');
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1}; client.disconnect = () => {};
  const a = new Agent({client, auth: {saved: {}}, cwd: process.cwd(), session: {id: 's', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 0}});
  a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: [], baseline: new Set()};
  a.workers.set('a1', {tag: 'a1', turn: {controller: new AbortController()}, ctx: a.main.ctx});
  const r = await a.execute('code.glob', {pattern: 'package.json'}, 30000, 'x1');
  assert.equal(r.ok, true, JSON.stringify(r));
  // Main idle, two agents working, no tag: refused, and the reason is said instead of "idle".
  a.main.turn = null; a.workers.set('a2', {tag: 'a2', turn: {controller: new AbortController()}, ctx: a.main.ctx});
  const amb = await a.execute('code.glob', {pattern: 'x'}, 30000, 'x2');
  assert.equal(amb.ok, false);
  assert.doesNotMatch(amb.error, /idle/);
  assert.match(amb.error, /a1, a2/);
  const wrong = await a.execute('code.glob', {pattern: 'x', agent: 'a9'}, 30000, 'x3');
  assert.match(wrong.error, /agent tag "a9"/);
});
