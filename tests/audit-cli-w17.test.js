'use strict';
// audit-cli wave 17 — regression tests for the wave-17 fixes:
//  (1) config: envBool('no') is false, and a hand-edited {accountAuto:'off'}
//      normalises to false (accountAuto is a boolean key).
//  (2) settings: an env var can turn a switch OFF (saved codeWrap true +
//      MUSER_CODE_WRAP=off -> switchValue false), and a numeric env of
//      ' ' (or '0x10') is not an override — the saved value decides.
//  (3) agent: resolveAgentLimits treats a whitespace-only env value as
//      absent and falls through to config.json.
//  (4) tell: enabled() honours the boolean word spellings — MUSER_TELL=false
//      turns tell off (not only '0').
//  (5) crash: future-named (2099) reports no longer evict real ones — with
//      20 future files filling the keep set, the report just written lives,
//      and so does a pre-existing real report named earlier today.
//  (6) node-slots: a lock whose mtime is in the future is not live (a
//      negative age is not fresh), per-account and legacy alike.
//  (7) usage: record({}) prunes far-future minute/day buckets as
//      clock-skew garbage while keeping today's bucket.
//  (8) lore: hashText hashes NFC and NFD spellings of the same line alike;
//      forget with kind + all deletes only that kind.
//  (9) sessions search: 'strasse' matches 'straße', and the snippet window
//      is computed in folded space, so a needle after İ expansion is in it.
//  (10) skills: normalizeName folds accents — 'aéb' -> 'aeb' (distinct from
//      'a-b'), 'İstanbul' -> 'istanbul'.
//  (11) parity: diffSnapshots matches locks / PATH / env names
//      case-insensitively, so a re-cased clone diffs to [].
//  (12) handoff: budgets count code points (a 300-emoji turn keeps all 300
//      emoji), and a git line cut at a ZWJ sequence leaves no lone
//      surrogate and no dangling ZWJ.
//  (13) worklog: headTail / cutText cuts never leave an unpaired surrogate
//      at the cut edges.
//  (14) race: parseRaceArgs accepts --n=2 anywhere ('fix bug --n=2'), and
//      '--accounts --yes' is a usage error, not a swallowed value.
//  (15) overnight: splitOpts reads only LEADING options, so
//      'add write the at=22:30 report' queues that prompt verbatim.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// Isolated homes under %TEMP%, set before any src module loads (the
// w15/w16 head-guard pattern), so the real HOME, the real sessions index
// and the resident Server state are never touched.
const TMP = os.tmpdir();
const dataRoot = fs.mkdtempSync(path.join(TMP, 'muser-w17-data-'));
const homeRoot = fs.mkdtempSync(path.join(TMP, 'muser-w17-home-'));
process.env.LOCALAPPDATA = dataRoot;
process.env.USERPROFILE = homeRoot;
process.env.HOME = homeRoot;
for (const v of [process.env.LOCALAPPDATA, process.env.USERPROFILE, process.env.HOME]) assert.ok(v && path.resolve(v).startsWith(path.resolve(TMP)), 'head guard: test homes under %TEMP%: ' + v);
for (const m of ['../src/secure-store', '../src/sessions']) { try { delete require.cache[require.resolve(m)]; } catch {} }
after(() => { for (const d of [dataRoot, homeRoot]) fs.rmSync(d, {recursive: true, force: true}); });

const config = require('../src/config');
const settings = require('../src/settings');
const {resolveAgentLimits} = require('../src/agent');
const tell = require('../src/tell');
const crash = require('../src/crash');
const slots = require('../src/node-slots');
const usage = require('../src/usage');
const lore = require('../src/lore');
const sessions = require('../src/sessions');
const skills = require('../src/skills');
const parity = require('../src/parity');
const {buildHandoff} = require('../src/handoff');
const worklog = require('../src/worklog');
const race = require('../src/race');
const {overnightCli, splitOpts} = require('../src/overnight/cli');
const Q = require('../src/overnight/queue');
assert.ok(path.resolve(sessions.FILE).startsWith(path.resolve(dataRoot)), 'head guard: scratch sessions index: ' + sessions.FILE);
assert.ok(path.resolve(config.file()).startsWith(path.resolve(homeRoot)), 'head guard: scratch config file: ' + config.file());

function tmp(t, prefix = 'muser-w17-') {
  const d = fs.mkdtempSync(path.join(TMP, prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}
function setEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------- (1) config ----------

test('w17 config: envBool reads no as false, like the other off spellings', () => {
  assert.equal(config.envBool('no'), false, "'no' turns an override off");
  assert.equal(config.envBool('No'), false, 'case does not matter');
  assert.equal(config.envBool(' off '), false, 'padding does not matter');
  assert.equal(config.envBool('yes'), true, 'control: yes is still on');
  assert.equal(config.envBool('maybe'), null, 'control: an unknown word is not a boolean');
  assert.equal(config.envBool(undefined), null, 'control: absent is not a boolean');
});

test('w17 config: {accountAuto: off} normalises to false on read', t => {
  const f = path.join(tmp(t), 'config.json');
  fs.writeFileSync(f, JSON.stringify({accountAuto: 'off'}));
  assert.equal(config.readJson(f).accountAuto, false, "the string 'off' becomes the boolean it names");
  fs.writeFileSync(f, JSON.stringify({accountAuto: 0}));
  assert.equal(config.readJson(f).accountAuto, false, 'the number 0 becomes false too');
  fs.writeFileSync(f, JSON.stringify({accountAuto: 'yes'}));
  assert.equal(config.readJson(f).accountAuto, true, 'control: an on spelling becomes true');
});

// ---------- (2) settings ----------

function writeHomeConfig(obj) {
  const f = config.file();
  fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.writeFileSync(f, JSON.stringify(obj));
  settings.reloadSwitches();
  return f;
}

test('w17 settings: saved codeWrap true + MUSER_CODE_WRAP=off -> switchValue false', t => {
  writeHomeConfig({codeWrap: true});
  setEnv(t, {MUSER_CODE_WRAP: undefined});
  assert.equal(settings.switchValue('codeWrap'), true, 'control: with no env, the saved value decides');
  process.env.MUSER_CODE_WRAP = 'off';
  assert.equal(settings.switchValue('codeWrap'), false, 'the env can turn a saved-on switch off');
  process.env.MUSER_CODE_WRAP = '0';
  assert.equal(settings.switchValue('codeWrap'), false, "'0' turns it off too");
  process.env.MUSER_CODE_WRAP = 'no';
  assert.equal(settings.switchValue('codeWrap'), false, "'no' turns it off too");
});

test('w17 settings: MUSER_CODE_WRAP=off does not rewrite the saved value', t => {
  writeHomeConfig({codeWrap: true});
  setEnv(t, {MUSER_CODE_WRAP: 'off'});
  assert.equal(settings.switchValue('codeWrap'), false);
  assert.equal(settings.savedValue('codeWrap'), true, 'the file still holds what the user saved');
});

test("w17 settings: numeric env ' ' falls through to the saved value", t => {
  writeHomeConfig({maxToolCallsPerTurn: 42});
  setEnv(t, {MUSER_MAX_TOOL_CALLS_PER_TURN: ' '});
  assert.equal(settings.numberValue('maxToolCallsPerTurn'), 42, 'a whitespace-only env is not 0: the saved value decides');
  process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = '0x10';
  assert.equal(settings.numberValue('maxToolCallsPerTurn'), 42, 'a hex spelling is not an override either');
  process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = '7';
  assert.equal(settings.numberValue('maxToolCallsPerTurn'), 7, 'control: a plain decimal still overrides');
});

// ---------- (3) agent limits ----------

test("w17 agent: resolveAgentLimits env ' ' falls through to config", t => {
  const cfgFile = path.join(tmp(t), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({maxAgents: 7, maxAgentsTotal: 9}));
  const blank = resolveAgentLimits({}, {MUSER_MAX_AGENTS: ' ', MUSER_MAX_AGENTS_TOTAL: ' '}, cfgFile);
  assert.deepEqual(blank, {concurrent: 7, perTurn: 9}, 'whitespace env is absent, so config decides (not Number( ) === 0)');
  const named = resolveAgentLimits({}, {MUSER_MAX_AGENTS: '3', MUSER_MAX_AGENTS_TOTAL: '5'}, cfgFile);
  assert.deepEqual(named, {concurrent: 3, perTurn: 5}, 'control: a real env value still wins over config');
});

// ---------- (4) tell ----------

test('w17 tell: MUSER_TELL=false -> enabled() false', t => {
  setEnv(t, {MUSER_TELL: 'false'});
  assert.equal(tell.enabled(), false, "the word 'false' turns tell off");
  process.env.MUSER_TELL = 'no';
  assert.equal(tell.enabled(), false, "'no' turns it off too");
  process.env.MUSER_TELL = '0';
  assert.equal(tell.enabled(), false, "'0' still turns it off");
  process.env.MUSER_TELL = '1';
  assert.equal(tell.enabled(), true, 'control: 1 leaves it on');
  delete process.env.MUSER_TELL;
  assert.equal(tell.enabled(), true, 'control: absent leaves it on');
});

// ---------- (5) crash prune ----------

test('w17 crash: 20 future-named (2099) files + 1 real -> the real file survives', t => {
  const dir = tmp(t, 'muser-w17-crash-');
  setEnv(t, {MUSER_CRASH_DIR: dir});
  for (let i = 0; i < 20; i++)
    fs.writeFileSync(path.join(dir, '2099-01-01T00-00-00-000Z-future-' + String(i).padStart(2, '0') + '.json'), '{}');
  const file = crash.write({version: '9.9.9', error: new Error('real w17 crash'), trail: [], state: {}});
  assert.ok(file && fs.existsSync(file), 'the report just written survives its own prune: ' + file);
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  assert.equal(names.length, 20, 'the keep set stays at KEEP=20: ' + names.length);
  assert.equal(names.filter(n => n.startsWith('2099-')).length, 19, 'a future-named file was pruned in its place');
});

test('w17 crash: 20 future-named (2099) files + a pre-existing real file from earlier today -> both real files survive', t => {
  const dir = tmp(t, 'muser-w17-crash-pre-');
  setEnv(t, {MUSER_CRASH_DIR: dir});
  // Futures carry distinct embedded times (2099-01-01 .. 2099-01-20), so
  // the eviction order among futures — largest embedded time first — is
  // observable in which ones remain.
  for (let i = 0; i < 20; i++)
    fs.writeFileSync(path.join(dir, '2099-01-' + String(i + 1).padStart(2, '0') + 'T00-00-00-000Z-future-' + String(i).padStart(2, '0') + '.json'), '{}');
  // A pre-existing real report, NOT written by the write() under test:
  // named earlier today (noon UTC when that is already past, else today
  // at 00:00 UTC, so the name is never itself a future name).
  const realDate = new Date();
  realDate.setUTCMinutes(0, 0, 0);
  realDate.setUTCHours(realDate.getUTCHours() > 12 ? 12 : 0);
  const realName = realDate.toISOString().replace(/[:.]/g, '-') + '-preexisting.json';
  assert.ok(!realName.startsWith('2099-'), 'control: the real file is not future-named: ' + realName);
  fs.writeFileSync(path.join(dir, realName), '{}');
  const file = crash.write({version: '9.9.9', error: new Error('real w17 crash after pre-existing'), trail: [], state: {}});
  assert.ok(file && fs.existsSync(file), 'the report just written survives its own prune: ' + file);
  assert.ok(fs.existsSync(path.join(dir, realName)), 'the pre-existing real file survives too: ' + realName);
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  // 20 futures + 1 pre-existing real + 1 just written = 22 files, KEEP=20,
  // so exactly 2 files go — and both must be futures, leaving 18 futures
  // alongside the 2 real files.
  assert.equal(names.length, 20, 'the keep set stays at KEEP=20: ' + names.length);
  const futures = names.filter(n => n.startsWith('2099-'));
  assert.equal(futures.length, 18, 'two future-named files were pruned, no real one: ' + futures.length);
  assert.ok(!futures.some(n => n.includes('2099-01-20')), 'the largest future time was evicted first');
  assert.ok(!futures.some(n => n.includes('2099-01-19')), 'the second-largest future time was evicted next');
  assert.ok(futures.some(n => n.includes('2099-01-01')), 'control: the smallest future time remains');
});

// ---------- (6) node-slots ----------

test('w17 node-slots: a heartbeat lock with a future mtime is not live', t => {
  const dir = tmp(t, 'muser-w17-slots-');
  const file = path.join(dir, slots.lockName('w17acct', 2));
  fs.writeFileSync(file, JSON.stringify({pid: process.pid, hb: true}));
  // The control's mtime is pinned 1 s into the past (a heartbeat's usual
  // age): on this PC a just-written file's mtimeMs sits a fraction of a
  // millisecond AHEAD of Date.now() (measured 47/50 writes), so an
  // unpinned 'fresh' control would race the filesystem clock, not the fix.
  const fresh = new Date(Date.now() - 1000);
  fs.utimesSync(file, fresh, fresh);
  assert.equal(slots.slotLive(dir, 'w17acct', 2), true, 'control: a fresh heartbeat lock from a live pid is live');
  const future = new Date(Date.now() + 60 * 60 * 1000);
  fs.utimesSync(file, future, future);
  assert.equal(slots.slotLive(dir, 'w17acct', 2), false, 'a future mtime is a negative age: not fresh, not live');
});

test('w17 node-slots: a legacy lock with a future mtime is not live either', t => {
  const dir = tmp(t, 'muser-w17-slots-legacy-');
  const file = path.join(dir, 'node-2.lock');
  fs.writeFileSync(file, JSON.stringify({pid: process.pid}));
  const future = new Date(Date.now() + 60 * 60 * 1000);
  fs.utimesSync(file, future, future);
  assert.equal(slots.slotLive(dir, 'w17acct', 2), false, 'the legacy freshness check is bounded on both sides too');
});

// ---------- (7) usage ----------

test('w17 usage: far-future minute/day buckets are pruned by record({})', t => {
  const dir = tmp(t, 'muser-w17-usage-');
  const f = path.join(dir, 'usage.json');
  setEnv(t, {MUSER_USAGE_FILE: f});
  const today = usage.dayKey();
  const store = {version: 1, days: {}, minutes: {}, totals: {realInTokens: 0, realOutTokens: 0}, updatedAt: null};
  store.days['2099-01-01'] = {turns: 5, toolCalls: 0, inChars: 0, outChars: 0};
  store.days[today] = {turns: 1, toolCalls: 0, inChars: 0, outChars: 0};
  store.minutes['2099-01-01T00:00Z'] = {realInTokens: 3, realOutTokens: 4};
  fs.writeFileSync(f, JSON.stringify(store));
  usage.record({});
  const afterStore = usage.load();
  assert.ok(!(('2099-01-01') in afterStore.days), 'the far-future day bucket is pruned');
  assert.ok(!('2099-01-01T00:00Z' in afterStore.minutes), 'the far-future minute bucket is pruned');
  assert.ok(today in afterStore.days, "today's bucket is kept");
});

// ---------- (8) lore ----------

function loreSetup(t) {
  const data = tmp(t, 'muser-w17-lore-data-');
  const repo = tmp(t, 'muser-w17-lore-repo-');
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = data;
  t.after(() => { process.env.LOCALAPPDATA = saved; });
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\ny\n');
  return {data, repo};
}
let loreSeq = 0;
function loreRec(kind, fields) { return {v: 1, kind, id: 'w17-' + (++loreSeq) + '-' + Math.random().toString(36).slice(2), at: '2026-11-09T00:00:00.000Z', ...fields}; }

test('w17 lore: hashText hashes the NFC and NFD spellings of a line alike', () => {
  const nfc = 'café w17';            // é as one code point
  const nfd = 'cafe\u0301 w17';   // e + combining acute
  assert.notEqual(nfc, nfd, 'the two spellings really are different strings');
  assert.equal(lore.hashText(nfc), lore.hashText(nfd), 'the same visible line hashes the same');
});

test('w17 lore: forget with kind + all deletes only that kind', t => {
  const {repo} = loreSetup(t);
  lore.appendRecord(repo, loreRec('scar', {path: 'src/a.js', start: 1, end: 1, bug: 'バグ w17'}));
  lore.appendRecord(repo, loreRec('hunch', {path: 'src/a.js', start: 1, end: 1, text: '前提 w17', state: 'open'}));
  lore.appendRecord(repo, loreRec('why', {path: 'src/a.js', start: 1, end: 1, reason: '理由 w17'}));
  assert.equal(lore.readRecords(repo).length, 3);
  assert.equal(lore.forget(repo, {kind: 'scar', all: true}), 1, 'only the scar is deleted');
  assert.deepEqual(lore.readRecords(repo).map(r => r.kind).sort(), ['hunch', 'why'], 'the other kinds survive a kind-narrowed --all');
  assert.equal(lore.forget(repo, {all: true}), 2, 'control: a bare --all still deletes everything');
  assert.equal(lore.readRecords(repo).length, 0);
});

// ---------- (9) sessions search ----------

function resetStore() { fs.rmSync(sessions.FILE, {force: true}); fs.rmSync(sessions.FILE + '.lock', {force: true}); fs.rmSync(sessions.TRANSCRIPTS, {recursive: true, force: true}); }
function makeSession(id, {title = '', updated = 1000} = {}) { const s = sessions.create('C:\\w17-work'); s.id = id; s.title = title; s.turns = 1; s.updated = updated; s.created = updated; sessions.save(s); return s; }
function addTurn(id, user, reply = '') { sessions.appendTurn(id, {v: 1, at: Date.now(), user, reply, tools: [], steps: [], sources: [], todos: []}); }

test("w17 sessions search: 'strasse' matches 'straße'", () => {
  resetStore();
  makeSession('w17-str-1', {title: 'unrelated'});
  addTurn('w17-str-1', 'Ich wohne in der Straße 5 in Berlin', '');
  const hits = sessions.search('strasse');
  assert.equal(hits.length, 1, 'ß folds to ss for the query and the field alike');
  assert.equal(hits[0].session.id, 'w17-str-1');
  assert.equal(hits[0].matchedIn, 'body');
});

test('w17 sessions search: the snippet window contains the needle after İ expansion', () => {
  resetStore();
  makeSession('w17-i-1', {title: 'unrelated'});
  // 30 İ's: each lowercases to i + U+0307, so an index taken in plain
  // lowercase space sits 30 code points past the real match and a window
  // centred on it misses the needle entirely.
  addTurn('w17-i-1', 'İ'.repeat(30) + 'a'.repeat(50) + ' NeedleAfterI ' + 'b'.repeat(50), '');
  const hits = sessions.search('needleafteri');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchedIn, 'body');
  assert.ok(hits[0].snippet.includes('NeedleAfterI'), 'the snippet is centred on the real match: ' + hits[0].snippet);
});

// ---------- (10) skills ----------

test("w17 skills: normalizeName folds accents — 'aéb' -> 'aeb', distinct from 'a-b'", () => {
  assert.equal(skills.normalizeName('aéb'), 'aeb', 'the accented letter folds to its base letter');
  assert.equal(skills.normalizeName('a-b'), 'a-b', 'control: a real dash stays a dash');
  assert.notEqual(skills.normalizeName('aéb'), skills.normalizeName('a-b'), 'the two names do not collide');
});

test("w17 skills: normalizeName('İstanbul') -> 'istanbul'", () => {
  assert.equal(skills.normalizeName('İstanbul'), 'istanbul', 'İ lowercases to i + a combining dot, which folds away');
});

// ---------- (11) parity ----------

test('w17 parity: a re-cased clone diffs to []', () => {
  const sha = 'abcdef0123456789'.repeat(4);
  const a = {
    tools: {node: '22.0.0'},
    locks: [{file: 'Package-Lock.JSON', sha256: sha, bytes: 123}],
    path: ['C:\\Tools', 'C:\\Bin'],
    env: {names: ['Path', 'MY_W17_VAR', 'NODE_ENV'], values: {NODE_ENV: 'production'}},
    os: {version: '10.0', build: '26100', arch: 'x64'},
    locale: {language: 'ja', codePage: 65001},
    settings: {executionPolicy: 'RemoteSigned', longPaths: true},
  };
  const b = {
    tools: {node: '22.0.0'},
    locks: [{file: 'package-lock.json', sha256: sha, bytes: 123}],
    path: ['c:\\tools', 'c:\\bin'],
    env: {names: ['PATH', 'my_w17_var', 'node_env'], values: {node_env: 'production'}},
    os: {version: '10.0', build: '26100', arch: 'x64'},
    locale: {language: 'ja', codePage: 65001},
    settings: {executionPolicy: 'RemoteSigned', longPaths: true},
  };
  assert.deepEqual(parity.diffSnapshots(a, b), [], 'only the casing changed, so there is no difference');
  const c = {...b, locks: [{file: 'package-lock.json', sha256: 'f'.repeat(64), bytes: 123}]};
  assert.equal(parity.diffSnapshots(a, c).filter(i => i.category === 'locks').length, 1, 'control: a real hash change under the folded name still diffs');
});

// ---------- (12) handoff ----------

const hTurn = (user, reply) => ({v: 1, at: 1762470000000, user, reply, tools: [], steps: [], sources: [], todos: []});

test('w17 handoff: a 300-emoji turn keeps all 300 emoji (code-point budget)', () => {
  const note = buildHandoff({fromLabel: 'a', toLabel: 'b', turns: [hTurn('🦊'.repeat(300), 'ok')]});
  assert.equal([...note].filter(c => c === '🦊').length, 300, 'the per-turn budget counts code points, not UTF-16 units');
});

test('w17 handoff: a git line cut at a ZWJ sequence leaves no lone surrogate and no dangling ZWJ', () => {
  // The family cluster starts at code point 197 of the line, so a cut at
  // the 200-code-point item cap lands inside it: the cut must back off to
  // before the cluster instead of keeping a partial sequence.
  const line = ' M ' + 'x'.repeat(194) + '👨\u200d👩\u200d👧\u200d👦' + 'y'.repeat(50);
  const note = buildHandoff({fromLabel: 'a', turns: [], gitLines: [line]});
  assert.ok(!LONE_SURROGATE.test(note), 'no unpaired surrogate anywhere in the note');
  assert.ok(!note.includes('\u200d'), 'no ZWJ survives: the cluster was kept whole or not at all');
  assert.ok(note.includes('x'.repeat(100)), 'the head of the line is still there');
});

// ---------- (13) worklog ----------

test('w17 worklog: headTail cuts leave no unpaired surrogate at the edges', () => {
  const head = worklog.headTail('a'.repeat(9) + '🦊' + 'b'.repeat(50), 10);
  assert.equal(head.head, 'a'.repeat(9), 'the head cut backs off the surrogate pair it would split');
  assert.ok(!LONE_SURROGATE.test(head.head));
  assert.ok(head.tail && !LONE_SURROGATE.test(head.tail));
  const tail = worklog.headTail('b'.repeat(50) + '🦊' + 'a'.repeat(9), 10);
  assert.equal(tail.tail, 'a'.repeat(9), 'the tail cut skips the low surrogate it would start on');
  assert.ok(!LONE_SURROGATE.test(tail.tail));
  assert.ok(!LONE_SURROGATE.test(tail.head));
});

test('w17 worklog: cutText leaves no unpaired surrogate at the cut', () => {
  const cut = worklog.cutText('a'.repeat(9) + '🦊' + 'b'.repeat(50), 10);
  assert.equal(cut, 'a'.repeat(9) + '…', 'the cut backs off the pair and marks itself');
  assert.ok(!LONE_SURROGATE.test(cut));
});

// ---------- (14) race ----------

test("w17 race: parseRaceArgs('fix bug --n=2') -> task 'fix bug', n 2", () => {
  const out = race.parseRaceArgs('fix bug --n=2');
  assert.equal(out.task, 'fix bug', 'the = spelling is a flag wherever it appears, not task text');
  assert.equal(out.n, 2);
  assert.equal(out.yes, false);
});

test("w17 race: parseRaceArgs('--accounts --yes') errors instead of swallowing the next flag", () => {
  assert.throws(() => race.parseRaceArgs('--accounts --yes'), /--accounts/, 'a value-taking flag never takes a -- word as its value');
  assert.throws(() => race.parseRaceArgs('fix --accounts'), /--accounts/, 'a missing value at the end errors too');
});

// ---------- (15) overnight ----------

test('w17 overnight: splitOpts reads only leading options', () => {
  const mid = splitOpts(['write', 'the', 'at=22:30', 'report']);
  assert.deepEqual(mid.opts, {}, 'at= after the prompt starts is prompt text, not an option');
  assert.deepEqual(mid.rest, ['write', 'the', 'at=22:30', 'report']);
  const lead = splitOpts(['at=22:30', 'write', 'the', 'report']);
  assert.equal(lead.opts.at, '22:30', 'control: a leading at= is still an option');
  assert.deepEqual(lead.rest, ['write', 'the', 'report']);
});

test("w17 overnight: 'add write the at=22:30 report' queues the prompt verbatim", async t => {
  const baseDir = tmp(t, 'muser-w17-overnight-');
  const repo = tmp(t, 'muser-w17-overnight-repo-');
  const git = args => { const r = spawnSync('git', args, {cwd: repo, encoding: 'utf8'}); assert.equal(r.status, 0, args.join(' ') + ': ' + r.stderr); };
  git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n'); git(['add', '-A']); git(['commit', '-m', 'init']);
  const settingsStub = {numberValue: () => 0, overnightApproval: () => 'edit-auto', setOvernightApproval: () => {}};
  await overnightCli(['add', 'write', 'the', 'at=22:30', 'report'], {baseDir, cwd: repo, settings: settingsStub});
  const items = Q.loadQueue({baseDir}).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].prompt, 'write the at=22:30 report', 'the whole sentence is the prompt, at= included');
});
