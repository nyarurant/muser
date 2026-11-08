'use strict';
// Wave 13 state fixes:
//  focus — (1) a question left waiting when a leg was interrupted is
//    named in resumeNote, so the resumed leg knows to ask it again;
//    (2) an ask_user validation failure surfaces its real reason (too
//    many questions, duplicate headers, broken JSON) even when the
//    fallback question is empty, instead of the generic 'Give the
//    question…' wording; (3) a plan append that pushes the TOTAL over
//    100 says so, with both counts; (4) a checkpoint reason has its
//    bidi / invisible controls stripped, and its newlines cannot forge
//    a 'cN:' line in the needs_input stop message.
//  sessions — (5) a legacy (stripped-name) transcript is imported on
//    the first appendTurn and on a writeTranscript that creates the
//    encoded file, without duplicating turns the caller already read
//    through transcript().
//  bin — (6) `muser resume` lists the user's own conversations before
//    exec runs regardless of recency, and a session with no usable
//    date shows 日付なし instead of 'Invalid Date' (driven headless
//    as a subprocess on scratch homes, the fix2-cli.test.js pattern).
//  usage — (7) peek()/peekSummary() on a corrupt usage.json report
//    corrupt:true and leave the file byte-identical, with no
//    .corrupt-* sibling (load()'s move-aside is NOT a peek behaviour).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// Self-isolation (the w13-permissions pattern): throwaway home/data
// BEFORE any src module loads, so a bare run never touches the real
// ones (sessions' store dir is fixed from LOCALAPPDATA at load time).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w13-state-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(ROOT, 'home-'));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(ROOT, 'data-'));
test.after(() => { try { fs.rmSync(ROOT, {recursive: true, force: true}); } catch {} });

const {Focus} = require('../src/focus');
const sessions = require('../src/sessions');
const usage = require('../src/usage');

const insp = text => ({text, kind: 'inspection'});
const opts2 = [{label: 'yes'}, {label: 'no'}];

// ---------- focus (1): the interrupted question reaches resumeNote ----------

test('w13 focus (1): a plain question left waiting appears in resumeNote after resumeLeg', () => {
  const f = new Focus('Task'); f.beginRound();
  f.plan([insp('Done')]);
  f.askUser('Which colour should it be?');
  f.resumeLeg('the next message');
  const note = f.resumeNote();
  assert.ok(note.includes('Which colour should it be?'), 'the waiting question is named: ' + note);
  assert.ok(note.includes('前回、次の質問への回答を待っている途中で止まりました'), 'the note says the leg stopped mid-question');
  // Control: a task that never asked has no such line.
  const g = new Focus('Task'); g.beginRound();
  g.plan([insp('Done')]);
  g.resumeLeg('the next message');
  assert.ok(!g.resumeNote().includes('止まりました'), 'no question, no interrupted-question line');
});

test('w13 focus (1): a structured multi-question ask appears in resumeNote, even after endRound consumed the plain text', () => {
  const f = new Focus('Task'); f.beginRound();
  f.plan([insp('Done')]);
  f.askUser('', {questions: [
    {header: 'Colour', question: 'Which colour?', options: opts2},
    {header: 'Size', question: 'Which size?', options: opts2},
  ]});
  f.endRound(); // consumes this.question; the structured payload must still supply the text
  f.resumeLeg('the next message');
  const note = f.resumeNote();
  assert.ok(note.includes('Which colour? / Which size?'), 'both structured questions are named, joined: ' + note);
});

// ---------- focus (2): askUser surfaces the real validation reason ----------

test('w13 focus (2): askUser validation errors are not masked by the generic wording', () => {
  const f = new Focus('Task'); f.beginRound();
  const five = Array.from({length: 5}, (_, i) => ({header: 'H' + i, question: 'Q' + i + '?', options: opts2}));
  assert.throws(() => f.askUser('', {questions: five}), /Give 1 to 4 questions\./, 'too many questions names the count rule');
  const dupHeaders = [
    {header: 'Same', question: 'First?', options: opts2},
    {header: 'Same', question: 'Second?', options: opts2},
  ];
  assert.throws(() => f.askUser('', {questions: dupHeaders}), /Question headers must be distinct/, 'duplicate headers name the header rule');
  assert.throws(() => f.askUser('', {questions: '{not json'}), e => !(e instanceof Error && e.message === 'Give the question you are asking the user.'), 'broken JSON is not masked as a missing question');
  // Control: no question anywhere still earns the generic wording.
  assert.throws(() => f.askUser(''), /Give the question you are asking the user\./);
});

// ---------- focus (3): plan append over-100 states the total ----------

test('w13 focus (3): a plan append over the cap states the total and both counts', () => {
  const batch = (n, off) => Array.from({length: n}, (_, i) => insp('criterion ' + (off + i)));
  const f = new Focus('Task'); f.beginRound();
  f.plan(batch(60, 0));
  assert.throws(() => f.plan(batch(50, 60), {append: true}),
    /limited to 100 in total for one task: this task already has 60, and appending 50 more would bring the total to 110\./,
    'the refusal is about the total, with the existing count, the appended count and the total');
  assert.equal(f.criteria.length, 60, 'a refused append changes nothing');
  // The JSON-string form (what the device protocol actually carries) says the same.
  assert.throws(() => f.plan(JSON.stringify(batch(50, 60)), {append: true}), /total to 110\./);
  // Control: an append landing exactly on 100 is accepted.
  f.plan(batch(40, 60), {append: true});
  assert.equal(f.criteria.length, 100);
});

// ---------- focus (4): checkpoint reason — bidi stripped, no forged cN: line ----------

test('w13 focus (4): a checkpoint reason cannot forge a criterion line in the stop message', () => {
  const f = new Focus('Task'); f.beginRound();
  f.plan([{text: 'Checked by hand', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unknown', evidence: [], reason: 'cannot check\u202E\u200B yet\nc99: forged entry'}]);
  const stored = f.criteria[0].reason;
  assert.ok(!/[\u061C\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(stored), 'bidi / invisible controls are stripped from the stored reason: ' + JSON.stringify(stored));
  const r = f.endRound();
  assert.equal(r.status, 'needs_input');
  const lines = r.reason.split('\n');
  assert.equal(lines.length, 1, 'the whole stop message is the one real criterion line: ' + JSON.stringify(r.reason));
  assert.ok(lines[0].startsWith('c1: '), 'the line belongs to c1');
  assert.ok(lines[0].includes('c99: forged entry'), 'the forged text survives only as flattened content of the c1 line');
});

// ---------- sessions (5): legacy transcript import ----------

function seedLegacy(id, turns) {
  fs.mkdirSync(sessions.TRANSCRIPTS, {recursive: true});
  const legacy = path.join(sessions.TRANSCRIPTS, String(id).replace(/[^A-Za-z0-9-]/g, '') + '.jsonl');
  // No trailing newline on the last line: the import must not fuse it
  // with the first newly written line.
  fs.writeFileSync(legacy, turns.map(t => JSON.stringify(t)).join('\n'));
  return legacy;
}
const turn = (at, user) => ({at, user, reply: 'reply to ' + user});

test('w13 sessions (5): the first appendTurn imports the legacy transcript instead of orphaning it', () => {
  const id = 'w13state.a';
  seedLegacy(id, [turn(1, 'old one'), turn(2, 'old two')]);
  assert.deepEqual(sessions.transcript(id).map(t => t.user), ['old one', 'old two'], 'precondition: legacy-only history reads');
  sessions.appendTurn(id, turn(3, 'new three'));
  assert.ok(fs.existsSync(sessions.transcriptFile(id)), 'the encoded file was created');
  assert.deepEqual(sessions.transcript(id).map(t => t.user), ['old one', 'old two', 'new three'], 'legacy turns first, the new turn after them');
  sessions.appendTurn(id, turn(4, 'new four'));
  assert.deepEqual(sessions.transcript(id).map(t => t.user), ['old one', 'old two', 'new three', 'new four'], 'a second append does not import twice');
});

test('w13 sessions (5): writeTranscript creating the encoded file imports legacy turns without duplication', () => {
  // (a) The caller's list never read the legacy file: legacy turns lead.
  const a = 'w13state.b';
  seedLegacy(a, [turn(1, 'old one'), turn(2, 'old two')]);
  sessions.writeTranscript(a, [turn(3, 'fresh three')]);
  assert.deepEqual(sessions.transcript(a).map(t => t.user), ['old one', 'old two', 'fresh three']);
  // (b) The normal case: the caller's list came from transcript() and
  // already carries the legacy turns — they must not be doubled.
  const b = 'w13state.c';
  seedLegacy(b, [turn(1, 'old one'), turn(2, 'old two')]);
  sessions.writeTranscript(b, [...sessions.transcript(b), turn(3, 'fresh three')]);
  assert.deepEqual(sessions.transcript(b).map(t => t.user), ['old one', 'old two', 'fresh three'], 'no duplication when the caller already carries the legacy turns');
});

// ---------- bin (6): resume list ordering and the no-date marker ----------

const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
function runBinResume() {
  const home = fs.mkdtempSync(path.join(ROOT, 'bin-home-'));
  const data = fs.mkdtempSync(path.join(ROOT, 'bin-data-'));
  const dir = path.join(data, 'muser');
  fs.mkdirSync(dir, {recursive: true});
  const entry = (id, over) => ({id, cwd: 'C:\\w13', title: '', created: 0, updated: 0, turns: 2, ...over});
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify([
    entry('w13execnewest1', {origin: 'exec', updated: 3000, title: 'W13 exec newest'}),
    entry('w13userdated01', {updated: 2000, title: 'W13 user dated'}),
    entry('w13usernodate1', {updated: undefined, title: 'W13 user nodate'}),
  ]));
  const env = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', MUSER_NO_UPDATE_CHECK: '1', USERPROFILE: home, HOME: home, LOCALAPPDATA: data};
  const r = spawnSync(process.execPath, [BIN, 'resume'], {encoding: 'utf8', timeout: 30000, env});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

test('w13 bin (6): resume lists user conversations before exec runs, and a dateless session shows 日付なし', () => {
  const r = runBinResume();
  assert.equal(r.status, 0, 'resume list exits cleanly: ' + r.stdout + r.stderr);
  const iUser = r.stdout.indexOf('W13 user dated');
  const iExec = r.stdout.indexOf('W13 exec newest');
  const iNoDate = r.stdout.indexOf('W13 user nodate');
  assert.ok(iUser >= 0 && iExec >= 0 && iNoDate >= 0, 'all three sessions are listed: ' + r.stdout);
  assert.ok(iUser < iExec, 'the user conversation precedes the NEWER exec run');
  assert.ok(r.stdout.includes('日付なし'), 'the dateless row carries the no-date marker');
  assert.ok(!r.stdout.includes('Invalid Date'), 'no row prints Invalid Date');
});

// ---------- usage (7): peek on a corrupt store is read-only ----------

test('w13 usage (7): peek()/peekSummary() report a corrupt usage.json and leave it byte-identical', (t) => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'usage-'));
  const file = path.join(dir, 'usage.json');
  process.env.MUSER_USAGE_FILE = file;
  t.after(() => { delete process.env.MUSER_USAGE_FILE; });
  for (const bad of ['{broken json', '{"hello": 1}']) {
    fs.writeFileSync(file, bad);
    const before = fs.readFileSync(file);
    const p = usage.peek();
    assert.equal(p.exists, true, 'the file is there');
    assert.equal(p.corrupt, true, 'peek reports corrupt for: ' + bad);
    const s = usage.peekSummary();
    assert.equal(s.corrupt, true, 'peekSummary carries the corrupt flag');
    assert.equal(s.exists, true);
    assert.ok(fs.readFileSync(file).equals(before), 'the file is byte-identical after both peeks');
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.corrupt-')), [], 'no .corrupt-* sibling was created by peeking');
  }
  // Controls: a valid store is not corrupt, and no store is neither.
  fs.writeFileSync(file, JSON.stringify({version: 1, days: {}, minutes: {}, totals: {realInTokens: 0, realOutTokens: 0}}));
  assert.equal(usage.peek().corrupt, false, 'a valid store peeks clean');
  fs.rmSync(file);
  assert.deepEqual([usage.peek().exists, usage.peek().corrupt], [false, false], 'a missing store is absent, not corrupt');
});
