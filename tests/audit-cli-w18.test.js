'use strict';
// audit-cli wave 18 — regression tests for the wave-18 fixes that a unit
// test can pin down deterministically:
//  (1) usage: a store written by another version round-trips — its version
//      number and its unknown top-level / day / minute / totals fields
//      survive a record() instead of being erased by the rewrite.
//  (2) term: the colour env spellings follow the envBool vocabulary —
//      FORCE_COLOR=no (and off / ' 0' / 'false ') does NOT force colour on
//      a dumb terminal, TERM='dumb ' (padded) is still dumb, and
//      COLORTERM=TrueColor (any case / padding) still means truecolor.
//      term.js reads env + isTTY at load, so these run in child processes.
//  (3) lore: relOf treats only a real '..' segment as outside the repo, so
//      a file NAMED '..notes.txt' at the repo top stays repo-relative.
//  (4) overnight queue: an item whose stored status is missing or unknown
//      is parked as deferred WITH its reason visible (invalidStatus +
//      note, counted by estimate, shown by formatQueue) instead of
//      falling out of every later step invisibly.
//  (5) sessions: legacy transcript turns ({role, content} and {text})
//      normalise to {user, reply} on read, and search matches them there.
//  (6) Focus.restore: a later version (v:2+) and absent criteria /
//      evidence / changes lists restore instead of throwing; a list that
//      is present in the wrong shape still throws.
//  (7) server client: an SSE stream that goes silent is cut at the
//      handlers' idleMs and reconnects, instead of hanging forever.
//  (8) export-window: two collectors collecting the same window at the
//      same time each get their own answer (per-collection request ids).
//  (9) mentions: a UNC ref is reported missing at once, with no probe.
//  (10) controller: a pushed agent entry keeps only a capped preview of
//      its result / error (slimEntry: 200 lines, 64K chars), full text
//      staying reachable through the outputs list.
//  (11) controller spill: a spilled output's size counts UTF-8 bytes,
//      and the disk cap counts the whole shared spill folder.
// The racy wave-18 fixes (tell double-drain, login multi-holder, worklog
// cross-window drain) are deliberately NOT pinned here: a deterministic
// unit test cannot stage them without inventing the race.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');

// Isolated homes under %TEMP%, set before any src module loads (the
// w15-w17 head-guard pattern), so the real HOME, the real sessions index
// and the resident Server state are never touched.
const TMP = os.tmpdir();
const REPO = path.join(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(TMP, 'muser-w18-data-'));
const homeRoot = fs.mkdtempSync(path.join(TMP, 'muser-w18-home-'));
process.env.LOCALAPPDATA = dataRoot;
process.env.USERPROFILE = homeRoot;
process.env.HOME = homeRoot;
for (const v of [process.env.LOCALAPPDATA, process.env.USERPROFILE, process.env.HOME]) assert.ok(v && path.resolve(v).startsWith(path.resolve(TMP)), 'head guard: test homes under %TEMP%: ' + v);
for (const m of ['../src/secure-store', '../src/sessions']) { try { delete require.cache[require.resolve(m)]; } catch {} }
after(() => { for (const d of [dataRoot, homeRoot]) fs.rmSync(d, {recursive: true, force: true}); });

const usage = require('../src/usage');
const lore = require('../src/lore');
const Q = require('../src/overnight/queue');
const overnightRun = require('../src/overnight/run');
const sessions = require('../src/sessions');
const {Focus} = require('../src/focus');
const mentions = require('../src/mentions');
const exportWindow = require('../src/export-window');
const {createClient} = require('../src/server/client');
const config = require('../src/config');
assert.ok(path.resolve(sessions.FILE).startsWith(path.resolve(dataRoot)), 'head guard: scratch sessions index: ' + sessions.FILE);
assert.ok(path.resolve(config.file()).startsWith(path.resolve(homeRoot)), 'head guard: scratch config file: ' + config.file());

function tmp(t, prefix = 'muser-w18-') {
  const d = fs.mkdtempSync(path.join(TMP, prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}
function setEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

// ---------- (1) usage ----------

test('w18 usage: an unknown-version store round-trips its unknown fields through record', t => {
  const dir = tmp(t, 'muser-w18-usage-');
  const f = path.join(dir, 'usage.json');
  setEnv(t, {MUSER_USAGE_FILE: f});
  const today = usage.dayKey();
  const minute = usage.minuteKey();
  const store = {version: 99, futureTop: {note: 'from a newer build'}, days: {}, minutes: {}, totals: {realInTokens: 3, realOutTokens: 4, futureTotal: 'keep-me'}, realSince: today, updatedAt: null};
  store.days[today] = {turns: 1, toolCalls: 0, inChars: 0, outChars: 0, futureDay: {deep: [1, 2]}};
  store.minutes[minute] = {realInTokens: 1, realOutTokens: 2, futureMinute: 'keep-me-too'};
  fs.writeFileSync(f, JSON.stringify(store));
  usage.record({});
  const afterStore = usage.load();
  assert.equal(afterStore.version, 99, 'the version number itself is not downgraded');
  assert.deepEqual(afterStore.futureTop, {note: 'from a newer build'}, 'an unknown top-level field survives');
  assert.deepEqual(afterStore.days[today].futureDay, {deep: [1, 2]}, 'an unknown day field survives');
  assert.equal(afterStore.totals.futureTotal, 'keep-me', 'an unknown totals field survives');
  assert.equal(afterStore.minutes[minute].futureMinute, 'keep-me-too', 'an unknown minute field survives');
  assert.equal(afterStore.days[today].turns, 1, 'control: the known fields still read');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.version, 99, 'the file on disk keeps the newer version too');
  assert.deepEqual(raw.futureTop, {note: 'from a newer build'}, 'the rewrite writes the unknown fields back');
});

// ---------- (2) term (child processes: env + isTTY are read at load) ----------

function termProbe(env) {
  const script = "process.stdout.isTTY = true; const t = require('./src/tui/term');" +
    "console.log(JSON.stringify({on: t.on, truecolor: t.truecolor, bold: t.c.bold('x'), rgb: t.rgb(255, 0, 0)('x')}));";
  const childEnv = {...process.env, LOCALAPPDATA: dataRoot, USERPROFILE: homeRoot, HOME: homeRoot};
  for (const k of ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE', 'TERM', 'COLORTERM', 'MUSER_SGR', 'MUSER_COLOR']) delete childEnv[k];
  Object.assign(childEnv, env);
  const out = execFileSync(process.execPath, ['-e', script], {cwd: REPO, env: childEnv, encoding: 'utf8', timeout: 60000});
  return JSON.parse(out.trim().split('\n').at(-1));
}

test("w18 term: FORCE_COLOR=no / off / ' 0' / 'false ' does not force colour on a dumb terminal", () => {
  for (const spelling of ['no', 'off', ' 0', 'false ']) {
    const probe = termProbe({TERM: 'dumb', FORCE_COLOR: spelling});
    assert.equal(probe.on, false, 'FORCE_COLOR=' + JSON.stringify(spelling) + ' is an off spelling, not a force');
    assert.equal(probe.bold, 'x', 'no SGR is emitted');
  }
  const forced = termProbe({TERM: 'dumb', FORCE_COLOR: '1'});
  assert.equal(forced.on, true, "control: FORCE_COLOR=1 still forces colour on a dumb terminal");
  assert.ok(forced.bold.includes('\x1b['), 'control: the forced output really carries SGR');
});

test("w18 term: TERM='dumb ' (padded) is still a dumb terminal", () => {
  assert.equal(termProbe({TERM: 'dumb '}).on, false, 'the padded spelling is trimmed before the comparison');
  assert.equal(termProbe({TERM: 'DUMB'}).on, false, 'control: the case-folded spelling is dumb too');
  assert.equal(termProbe({TERM: 'xterm-256color'}).on, true, 'control: an ordinary terminal keeps colour');
});

test('w18 term: COLORTERM=TrueColor (any case or padding) means truecolor', () => {
  for (const spelling of ['TrueColor', ' truecolor', '24BIT']) {
    const probe = termProbe({COLORTERM: spelling});
    assert.equal(probe.truecolor, true, 'COLORTERM=' + JSON.stringify(spelling) + ' advertises 24-bit colour');
    assert.ok(probe.rgb.includes('38;2;255;0;0'), 'rgb() emits the 24-bit form: ' + JSON.stringify(probe.rgb));
  }
  const plain = termProbe({});
  assert.equal(plain.truecolor, false, 'control: no COLORTERM is not truecolor');
  assert.ok(plain.rgb.includes('38;5;'), 'control: rgb() quantises to the 256 palette');
});

// ---------- (3) lore ----------

test("w18 lore: relOf keeps a file named '..notes.txt' repo-relative", t => {
  const repo = tmp(t, 'muser-w18-lore-');
  assert.equal(lore.relOf(repo, path.join(repo, '..notes.txt')), '..notes.txt', "a '..' name prefix is a file inside the repo, not a parent step");
  assert.equal(lore.relOf(repo, path.join(repo, 'src', 'a.js')), 'src/a.js', 'control: an ordinary inside path stays relative');
  const outside = lore.relOf(repo, path.join(path.dirname(repo), 'outside-w18.txt'));
  assert.ok(outside.endsWith('/outside-w18.txt'), 'control: a real parent step stays the absolute path: ' + outside);
  assert.notEqual(outside, '../outside-w18.txt');
});

// ---------- (4) overnight queue ----------

test('w18 overnight: an item with a missing or unknown status is parked as deferred, visibly', t => {
  const baseDir = tmp(t, 'muser-w18-overnight-');
  fs.writeFileSync(Q.queueFile({baseDir}), JSON.stringify({version: 99, items: [
    {id: 'w18-nostatus', prompt: 'do the thing', cwd: 'C:\\w18', questions: []},
    {id: 'w18-badstatus', prompt: 'do the other', cwd: 'C:\\w18', status: 'mystery', questions: []},
    {id: 'w18-queued', prompt: 'do the third', cwd: 'C:\\w18', status: 'queued', questions: []},
  ]}));
  const q = Q.loadQueue({baseDir});
  const [a, b, c] = q.items;
  assert.equal(a.status, 'deferred', 'a status-less item is parked, not dropped');
  assert.equal(a.invalidStatus, null, 'there was no original value to keep');
  assert.match(a.note, /入っていない/, 'the reason rides on the note');
  assert.equal(b.status, 'deferred', 'an unknown status is parked the same way');
  assert.equal(b.invalidStatus, 'mystery', 'the original value is kept');
  assert.match(b.note, /mystery/, 'the note names the unreadable value');
  assert.equal(c.status, 'queued', 'control: a known status is untouched');
  assert.ok(!('invalidStatus' in c), 'control: a known status gains no marker');
  assert.equal(c.note, undefined, 'control: a known status gains no note');
  assert.equal(Q.estimate(q).tasks, 3, 'parked items are counted by the estimate, not invisible');
  const lines = overnightRun.formatQueue(q);
  assert.ok(lines.some(l => l.includes('w18-nostat') && l.includes('入っていない')), 'the queue list shows the reason: ' + lines.join(' | '));
  Q.saveQueue(q, {baseDir});
  const again = Q.loadQueue({baseDir});
  assert.equal(again.items[0].note, a.note, 'a second load does not pile the reason up again');
  assert.equal(again.items[0].status, 'deferred');
});

// ---------- (5) sessions ----------

function resetStore() { fs.rmSync(sessions.FILE, {force: true}); fs.rmSync(sessions.FILE + '.lock', {force: true}); fs.rmSync(sessions.TRANSCRIPTS, {recursive: true, force: true}); }
function makeSession(id) { const s = sessions.create('C:\\w18-work'); s.id = id; s.title = ''; s.turns = 5; s.updated = 1000; s.created = 1000; sessions.save(s); return s; }

test('w18 sessions: legacy {role, content} and {text} turns read back as {user, reply}', () => {
  resetStore();
  makeSession('w18-legacy-1');
  const lines = [
    {v: 1, at: 1, role: 'user', content: 'legacy user w18'},
    {v: 1, at: 2, role: 'assistant', content: 'legacy reply w18'},
    {v: 1, at: 3, text: 'bare text w18'},
    {v: 1, at: 4, role: 'assistant', text: 'assistant text w18'},
    {v: 1, at: 5, user: 'modern user w18', reply: 'modern reply w18'},
  ];
  fs.mkdirSync(path.dirname(sessions.transcriptFile('w18-legacy-1')), {recursive: true});
  fs.writeFileSync(sessions.transcriptFile('w18-legacy-1'), lines.map(o => JSON.stringify(o)).join('\n') + '\n');
  const turns = sessions.transcript('w18-legacy-1');
  assert.equal(turns.length, 5, 'every legacy line still counts as a turn');
  assert.equal(turns[0].user, 'legacy user w18');
  assert.equal(turns[0].reply, '', 'the side the body does not fill defaults to empty');
  assert.ok(!('role' in turns[0]) && !('content' in turns[0]), 'the legacy keys are consumed');
  assert.equal(turns[1].user, '');
  assert.equal(turns[1].reply, 'legacy reply w18', "an assistant's body lands in reply");
  assert.equal(turns[2].user, 'bare text w18', 'a role-less body is a user utterance');
  assert.equal(turns[2].reply, '');
  assert.equal(turns[3].reply, 'assistant text w18', 'text is the body when content is absent');
  assert.equal(turns[4].user, 'modern user w18', 'control: a modern turn is unchanged');
  assert.equal(turns[4].reply, 'modern reply w18');
  const hits = sessions.search('legacy reply w18');
  assert.ok(hits.some(h => h.session.id === 'w18-legacy-1'), 'search matches on the normalised reply too');
});

// ---------- (6) Focus.restore ----------

test('w18 focus: restore accepts a later version and absent lists', () => {
  const v2 = Focus.restore({v: 2, goal: 'future task'});
  assert.equal(v2.goal, 'future task');
  assert.deepEqual(v2.criteria, [], 'an absent criteria list falls back to empty');
  assert.deepEqual(v2.evidence, [], 'an absent evidence list falls back to empty');
  assert.deepEqual(v2.changes, [], 'an absent changes list falls back to empty');
  const bare = Focus.restore({v: 1, goal: 'old task', criteria: [{id: 'c1', text: 'Check it', kind: 'manual', status: 'pending', evidence: []}]});
  assert.equal(bare.criteria.length, 1, 'a present list is still read');
  assert.equal(bare.criteria[0].text, 'Check it');
  assert.deepEqual(bare.changes, [], 'only the changes list was absent here');
  const v9 = Focus.restore({v: 9, goal: 'newer task', criteria: [], evidence: [], changes: [], futureField: {x: 1}});
  assert.equal(v9.goal, 'newer task', 'fields this build does not know are simply never read');
});

test('w18 focus: restore still refuses present-but-wrong shapes', () => {
  for (const bad of [
    {v: 1, goal: 'x', criteria: 'no'},
    {v: 1, goal: 'x', evidence: {}},
    {v: 1, goal: 'x', changes: null},
    {v: 0, goal: 'x'},
    {v: 1.5, goal: 'x'},
    {v: '2', goal: 'x'},
    {goal: 'x'},
    {v: 2, goal: 42},
    null,
  ]) assert.throws(() => Focus.restore(bad), /Invalid Focus state/, 'still refused: ' + JSON.stringify(bad));
});

// ---------- (7) server client SSE idle ----------

test('w18 server client: a silent SSE stream is cut at idleMs and reconnects', async t => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/events')) { res.writeHead(404); res.end(); return; }
    connections++;
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
    res.write('data: {"kind":"server","n":1}\n\n');
    // Then silence: no pings, no close — the half-open stream wave 18 fixed.
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { try { server.closeAllConnections?.(); } catch {} try { server.close(); } catch {} });
  const client = createClient({port: server.address().port, token: 'w18-token'});
  const events = [];
  let closes = 0;
  const closeStream = client.events(null, {idleMs: 150, onEvent: e => events.push(e), onClose: () => { closes++; }});
  t.after(() => closeStream());
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(connections >= 2 && closes >= 1)) await new Promise(r => setTimeout(r, 25));
  closeStream();
  assert.ok(events.length >= 1, 'the first frame arrived before the silence');
  assert.ok(closes >= 1, 'the silent stream reported a close instead of hanging forever');
  assert.ok(connections >= 2, 'the client reconnected after the idle cut: ' + connections + ' connections');
});

// ---------- (8) export-window ----------

test('w18 export-window: two collectors at once against one window both get their own answer', async t => {
  const dir = tmp(t, 'muser-w18-windows-');
  const answered = new Set();
  // A stand-in window: answer every request file with its own response
  // file, echoing the request id into the state so the test can tell the
  // two answers apart.
  const timer = setInterval(() => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const m = /^request-(\d+)-([0-9a-f]+)\.json$/.exec(name);
      if (!m || answered.has(m[2])) continue;
      let req;
      try { req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      answered.add(m[2]);
      try { fs.writeFileSync(path.join(dir, 'response-' + m[1] + '-' + m[2] + '.json'), JSON.stringify({id: req.id, state: {marker: req.id}, events: [{kind: 'probe'}]})); } catch {}
    }
  }, 10);
  t.after(() => clearInterval(timer));
  const [a, b] = await Promise.all([
    exportWindow.collectWindow(4242, {dir, timeoutMs: 8000, pollMs: 20}),
    exportWindow.collectWindow(4242, {dir, timeoutMs: 8000, pollMs: 20}),
  ]);
  assert.equal(a.answered, true, 'the first collector was answered');
  assert.equal(b.answered, true, 'the second collector was answered too (it used to time out)');
  assert.ok(a.state && b.state && a.state.marker && b.state.marker, 'both answers carry their state');
  assert.notEqual(a.state.marker, b.state.marker, 'each collector got its OWN answer, not a shared one');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('request-') || n.startsWith('response-')), [], 'no request/response files are left behind');
});

// ---------- (9) mentions ----------

test('w18 mentions: a UNC ref is reported missing at once, without any probe', t => {
  const cwd = tmp(t, 'muser-w18-mentions-');
  fs.writeFileSync(path.join(cwd, 'real.txt'), 'real local content w18');
  const BS = String.fromCharCode(92);
  const uncBackslash = BS + BS + 'w18-no-such-host' + BS + 'share' + BS + 'secret.txt';
  const uncSlashes = '//w18-no-such-host/share/secret.txt';
  const started = Date.now();
  const a = mentions.expand('look @' + uncBackslash + ' please', cwd);
  const b = mentions.expand('look @' + uncSlashes + ' please', cwd);
  const elapsed = Date.now() - started;
  assert.deepEqual(a.missing, [uncBackslash], 'the backslash UNC spelling is missing exactly as written');
  assert.deepEqual(a.files, [], 'nothing was included for it');
  assert.deepEqual(b.missing, [uncSlashes], 'the // spelling is missing exactly as written');
  assert.deepEqual(b.files, []);
  assert.ok(elapsed < 5000, 'no SMB probe happened (an unreachable host used to freeze the send ~21 s): ' + elapsed + ' ms');
  const local = mentions.expand('look @real.txt please', cwd);
  assert.deepEqual(local.missing, [], 'control: a real local file is not missing');
  assert.ok(local.block.includes('real local content w18'), 'control: a real local file still expands');
});

// ---------- (10) + (11) controller ----------

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';
async function makeController(opts = {}) {
  const {Controller} = await import('../src/ui/controller.mjs');
  return new Controller({agent: new FakeAgent(homeRoot), museName: 'm', version: 't', onExit() {}, ...opts});
}

test('w18 controller: a pushed agent entry keeps only a capped preview of its result', async () => {
  const ctrl = await makeController();
  const big = Array.from({length: 500}, (_, i) => 'line ' + i).join('\n');
  const snap = {tag: 'a1', title: 'probe', state: 'done', result: big};
  ctrl.push({type: 'agent', snap});
  const stored = ctrl.get().entries.at(-1);
  assert.equal(stored.type, 'agent');
  assert.ok(stored.snap.result.split('\n').length <= 200, 'the stored preview is capped at 200 lines');
  assert.equal(stored.snap.resultOmitted, 300, 'the omitted line count is recorded on the entry');
  assert.ok(stored.snap.result.startsWith('line 0'), 'the preview is the head of the result');
  assert.equal(snap.result, big, "the caller's snap object is not mutated");
  const errSnap = {tag: 'a2', title: 'probe', state: 'failed', error: 'x'.repeat(100000)};
  ctrl.push({type: 'agent', snap: errSnap});
  const storedErr = ctrl.get().entries.at(-1);
  assert.equal(storedErr.snap.error.length, 64 * 1024, 'a single over-long line is hard-cut at the char budget');
  const small = {tag: 'a3', title: 'probe', state: 'done', result: 'short result'};
  ctrl.push({type: 'agent', snap: small});
  const storedSmall = ctrl.get().entries.at(-1);
  assert.equal(storedSmall.snap.result, 'short result', 'control: a short result is kept whole');
  assert.equal(storedSmall.snap.resultOmitted, undefined, 'control: nothing is marked omitted');
});

test('w18 controller: a spilled output size counts UTF-8 bytes, not characters', async t => {
  const dir = tmp(t, 'muser-w18-spill-');
  const outputsDir = path.join(dir, 'outputs');
  const ctrl = await makeController({outputsDir, outputsMaxChars: 100});
  const jp = 'あ'.repeat(60); // 60 UTF-16 chars, 180 bytes on disk
  ctrl.keepOutput({id: 'a', command: 'system.run', summary: 'a'}, jp);
  ctrl.keepOutput({id: 'b', command: 'system.run', summary: 'b'}, jp);
  const [oa] = ctrl.outputs;
  assert.ok(oa.file, 'the oldest output spilled once the memory cap was passed');
  assert.equal(oa.size, 180, 'size is the UTF-8 byte count, not the character count');
  assert.equal(fs.statSync(oa.file).size, 180, 'size agrees with the file on disk');
  assert.equal(ctrl.outputText(oa), jp, 'the spilled text reads back in full');
});

test('w18 controller: the spill disk cap counts the whole shared folder', async t => {
  const dir = tmp(t, 'muser-w18-spillfolder-');
  const outputsDir = path.join(dir, 'outputs');
  fs.mkdirSync(outputsDir, {recursive: true});
  // Another conversation's spill, sharing the folder: 1000 bytes the old
  // per-conversation accounting never counted.
  fs.writeFileSync(path.join(outputsDir, 'another-conversation.txt'), 'F'.repeat(1000));
  const ctrl = await makeController({outputsDir, outputsMaxChars: 100}); // folder disk cap: 400 bytes
  ctrl.keepOutput({id: 'a', command: 'system.run', summary: 'a'}, 'A'.repeat(60));
  ctrl.keepOutput({id: 'b', command: 'system.run', summary: 'b'}, 'B'.repeat(60));
  ctrl.keepOutput({id: 'c', command: 'system.run', summary: 'c'}, 'C'.repeat(60));
  const [oa, ob] = ctrl.outputs;
  assert.equal(oa.file, undefined, "the oldest of this conversation's spills was dropped: the folder as a whole is over the cap");
  assert.ok(ob.file && fs.existsSync(ob.file), 'the newest spill stays (eviction stops at the last one)');
  assert.ok(fs.existsSync(path.join(outputsDir, 'another-conversation.txt')), "another conversation's spill is never ours to delete");
});
