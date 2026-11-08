'use strict';
// audit-cli wave 16 — regression tests for the wave-16 fixes:
//  (1) update: a pinned install's verify rejects a pre-release that only
//      prefix-matches the pin; newer() orders huge components exactly
//      (digit-string compare, no Number() rounding at 2^53); latest()
//      accepts a version carrying +build metadata as the stable it names.
//  (2) skills: names with no ASCII name characters (翻訳, 要約) each get
//      their own hashed key instead of sharing one '--' collision key,
//      and stay readable by the name as written in their frontmatter.
//  (3) sessions: transcript() skips non-turn lines ({"type":"ping"})
//      like corrupt lines, and a BOM on the file keeps the first turn.
//  (4) crash: an error NAME is scrubbed like the message — a newline or
//      a secret shape inside it never reaches the record's error field.
//  (5) export-standalone: a sessions.json entry whose stored date is
//      garbage yields a report (createdAt null), not a RangeError.
//  (6) controller: while agent._switching is set (an agent-initiated
//      failover, not a controller-started switch), submit() holds the
//      text in the queue instead of sending it into the switch to be lost.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Isolated homes under %TEMP%, set before any src module loads (the
// w15-tell / w15-search head-guard pattern), so the real HOME, the real
// sessions index and the resident Server state are never touched.
const TMP = os.tmpdir();
const dataRoot = fs.mkdtempSync(path.join(TMP, 'muser-w16-data-'));
const homeRoot = fs.mkdtempSync(path.join(TMP, 'muser-w16-home-'));
process.env.LOCALAPPDATA = dataRoot;
process.env.USERPROFILE = homeRoot;
process.env.HOME = homeRoot;
for (const v of [process.env.LOCALAPPDATA, process.env.USERPROFILE, process.env.HOME]) assert.ok(v && path.resolve(v).startsWith(path.resolve(TMP)), 'head guard: test homes under %TEMP%: ' + v);
for (const m of ['../src/secure-store', '../src/sessions']) { try { delete require.cache[require.resolve(m)]; } catch {} }
after(() => { for (const d of [dataRoot, homeRoot]) fs.rmSync(d, {recursive: true, force: true}); });

const update = require('../src/update');
const skills = require('../src/skills');
const sessions = require('../src/sessions');
const crash = require('../src/crash');
const standalone = require('../src/export-standalone');
assert.ok(path.resolve(sessions.FILE).startsWith(path.resolve(dataRoot)), 'head guard: scratch sessions index: ' + sessions.FILE);

function tmp(t, prefix = 'muser-w16-') {
  const d = fs.mkdtempSync(path.join(TMP, prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}

// ---------- (1) update ----------

test('w16 update: pinned install verify rejects an installed 0.4.0-beta.1 for pin 0.4.0', async t => {
  const lockFile = path.join(tmp(t), 'update.lock');
  const r = await update.install({version: '0.4.0', command: 'echo installing', verifyCommand: 'echo muser-cli@0.4.0-beta.1', lockFile});
  assert.equal(r.ok, false, 'a pre-release that prefix-matches the pin is not the pinned release: ' + r.output);
  assert.match(r.output, /0\.4\.0-beta\.1/, 'the failure names the version that actually landed');
});

test('w16 update: pinned install verify accepts the exact pinned release (control)', async t => {
  const lockFile = path.join(tmp(t), 'update.lock');
  const r = await update.install({version: '0.4.0', command: 'echo installing', verifyCommand: 'echo muser-cli@0.4.0', lockFile});
  assert.equal(r.ok, true, r.output);
  assert.equal(r.installedVersion, '0.4.0');
});

test('w16 update: newer() orders huge components exactly, without Number() rounding', () => {
  assert.equal(update.newer('1.0.9007199254740993', '1.0.9007199254740992'), true, '2^53+1 is newer than 2^53');
  assert.equal(update.newer('1.0.9007199254740992', '1.0.9007199254740993'), false, '2^53 is not newer than 2^53+1');
  assert.equal(update.newer('9007199254740993.0.0', '9007199254740992.0.0'), true, 'the same exactness in the first component');
  assert.equal(update.newer('1.0.9007199254740993', '1.0.9007199254740993'), false, 'equal huge components are not newer');
});

test('w16 update: latest() accepts 0.4.0+build.5 as the stable 0.4.0', async t => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  global.fetch = async () => ({ok: true, json: async () => ({version: '0.4.0+build.5'})});
  assert.equal(await update.latest(), '0.4.0', '+build is metadata: the stable version it names comes back, not a no-version failure');
});

// ---------- (2) skills ----------

// A scratch home + project in the skills.test.js sandbox shape: the two
// skills live in the user's own ~/.muser/skills under ASCII folder names,
// known only by the non-ASCII names in their frontmatter.
function skillSandbox(t) {
  const root = tmp(t, 'muser-w16-skills-');
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const saved = {USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME};
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { process.env.USERPROFILE = saved.USERPROFILE; process.env.HOME = saved.HOME; });
  const put = (folder, name, body) => {
    const d = path.join(home, '.muser', 'skills', folder);
    fs.mkdirSync(d, {recursive: true});
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + name + '\ndescription: desc for ' + name + '\n---\n' + body + '\n');
  };
  put('honyaku', '翻訳', 'Translate body w16');
  put('youyaku', '要約', 'Summarize body w16');
  return {home, proj};
}

test('w16 skills: 翻訳 and 要約 both load, under distinct keys', t => {
  const {proj} = skillSandbox(t);
  const all = skills.load(proj);
  assert.deepEqual(all.map(s => s.originalName).sort(), ['翻訳', '要約'].sort(), 'neither non-ASCII skill vanished as a false collision');
  const keys = all.map(s => s.name);
  assert.equal(new Set(keys).size, 2, 'the two skills have distinct keys: ' + keys.join(', '));
  assert.ok(keys.every(k => k && k !== '--'), 'no skill sits on the old shared dashes key');
});

test('w16 skills: both are readable by their original names, each with its own body', t => {
  const {proj} = skillSandbox(t);
  const honyaku = skills.read(proj, {name: '翻訳'});
  const youyaku = skills.read(proj, {name: '要約'});
  assert.match(honyaku.content, /Translate body w16/);
  assert.match(youyaku.content, /Summarize body w16/);
  assert.notEqual(honyaku.name, youyaku.name, 'read() resolved them to two different skills');
});

// ---------- (3) sessions ----------

function resetStore() { fs.rmSync(sessions.FILE, {force: true}); fs.rmSync(sessions.FILE + '.lock', {force: true}); fs.rmSync(sessions.TRANSCRIPTS, {recursive: true, force: true}); }
function writeRawTranscript(id, content) {
  fs.mkdirSync(sessions.TRANSCRIPTS, {recursive: true});
  fs.writeFileSync(sessions.transcriptFile(id), content);
}
const VALID_TURN = {v: 1, at: 1762470000000, user: 'hello w16', reply: 'hi w16', tools: [], steps: [], sources: [], todos: []};

test('w16 sessions: a ghost {"type":"ping"} line is skipped, the valid turn is returned alone', () => {
  resetStore();
  writeRawTranscript('w16-ghost-1', JSON.stringify({type: 'ping'}) + '\n' + JSON.stringify(VALID_TURN) + '\n');
  const turns = sessions.transcript('w16-ghost-1');
  assert.equal(turns.length, 1, 'only the valid turn comes back, not the ghost');
  assert.equal(turns[0].user, 'hello w16');
  assert.equal(turns[0].reply, 'hi w16');
});

test('w16 sessions: a BOM transcript keeps its first turn', () => {
  resetStore();
  writeRawTranscript('w16-bom-1', '\uFEFF' + JSON.stringify(VALID_TURN) + '\n');
  const turns = sessions.transcript('w16-bom-1');
  assert.equal(turns.length, 1, 'the BOM does not make the first line unparseable');
  assert.equal(turns[0].user, 'hello w16');
});

// ---------- (4) crash ----------

test('w16 crash: an error name with a newline and a fake secret reaches the record as neither', t => {
  const dir = tmp(t, 'muser-w16-crash-');
  const saved = process.env.MUSER_CRASH_DIR;
  process.env.MUSER_CRASH_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.MUSER_CRASH_DIR; else process.env.MUSER_CRASH_DIR = saved; });
  const err = new Error('kaboom w16 crash');
  err.name = 'BadName password=CANARYW16SECRET123\nInjectedLine';
  const file = crash.write({version: '9.9.9', error: err, trail: [], state: {}});
  assert.ok(file && fs.existsSync(file), 'a crash record was written');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!/[\r\n]/.test(record.error), 'the error field is one line: ' + JSON.stringify(record.error));
  assert.ok(!record.error.includes('CANARYW16SECRET123'), 'the fake secret in the name is scrubbed out');
  assert.ok(!record.error.includes('InjectedLine'), 'nothing past the newline in the name rides along');
  assert.match(record.error, /BadName/, 'the scrubbed name still identifies the error');
  assert.match(record.error, /kaboom w16 crash/, 'the message wording still identifies the crash');
});

// ---------- (5) export-standalone ----------

test('w16 export-standalone: a sessions.json entry with created garbage does not throw', t => {
  const data = tmp(t, 'muser-w16-standalone-');
  fs.mkdirSync(path.join(data, 'muser'), {recursive: true});
  fs.writeFileSync(path.join(data, 'muser', 'sessions.json'), JSON.stringify([{id: 'w16-garbage-1', cwd: 'C:\\w16', created: 'garbage', updated: 1762470001000, turns: 1}]));
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = data;
  t.after(() => { process.env.LOCALAPPDATA = saved; });
  let report;
  assert.doesNotThrow(() => { report = standalone.buildStandaloneReport({sessionRef: 'w16-garbage-1'}); }, 'an invalid stored date must not kill the fallback report');
  assert.equal(report.session.id, 'w16-garbage-1');
  assert.equal(report.session.createdAt, null, 'the garbage date becomes null');
  assert.equal(report.session.updatedAt, new Date(1762470001000).toISOString(), 'the valid date still converts');
});

// ---------- (6) controller ----------

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'demo'}; this.device = {connected: true};
    this.sent = []; this.busy = false; this._switching = false;
  }
  async send(text, opts) { this.sent.push({text, opts}); }
}
FakeAgent.DEVICE = 'test';
async function mkCtrl(t) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(tmp(t, 'muser-w16-ctrl-'));
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}, onReload() {}});
  ctrl.refreshPlan = () => Promise.resolve(null); // no muse.ai in tests (fix2 pattern)
  t.after(() => clearTimeout(ctrl.flashTimer));
  return {agent, ctrl};
}

test('w16 controller: with agent._switching, submit(hello) queues the text instead of losing it', async t => {
  const {agent, ctrl} = await mkCtrl(t);
  agent._switching = true;
  await ctrl.submit('hello');
  assert.equal(agent.sent.length, 0, 'nothing is sent into the in-flight switch');
  assert.deepEqual(ctrl.queue, ['hello'], 'the text is held in the queue');
  assert.deepEqual(ctrl.get().queue, ['hello'], 'the held text is what the screen shows as queued');
});

test('w16 controller: repeated submits while agent._switching queue in order, none sent', async t => {
  const {agent, ctrl} = await mkCtrl(t);
  agent._switching = true;
  await ctrl.submit('hello');
  await ctrl.submit('second w16');
  assert.equal(agent.sent.length, 0);
  assert.deepEqual(ctrl.queue, ['hello', 'second w16'], 'both texts wait, in the order they were typed');
});
