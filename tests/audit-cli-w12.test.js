'use strict';
// audit-cli wave 12 — regression tests for the wave-12 fixes in crash,
// exec-status and export (the /update half of wave 12 lives in
// tests/audit-cli-w12-update.test.js and is deliberately NOT repeated here):
//  (1) crash: an UNQUOTED Windows / home path and an email address are
//      scrubbed from a crash record (src/crash.js scrubSecretTextLine /
//      safeErrorText — quoted spans were already dropped whole); falls
//      that differ in how they fell (scope / record kind / error /
//      session) are NOT merged into one (src/crash-investigate.js
//      mergeCrashes); export's latestCrash skips broken records and
//      lands on the next valid one (src/export.js via buildReport).
//  (2) exec-status: latest() skips candidates it cannot read (corrupt
//      JSON, a directory wearing a status name, JSON that is not an
//      object) instead of crowning the future-named one; summary() puts
//      no exit on a dead run (and only an integer exit on a finished
//      one); a long reply is cut at 500 code points and the cut is said.
//  (3) export: when the session's turn counter and the number of turn
//      records carried disagree, session.turnsRecorded states the
//      carried count and a turnsNote (plus turnsMissing) says so; a
//      turn's sources ride in the report in both body modes.
// Isolation follows tests/audit-cli-w11.test.js: tests/setup.mjs has
// already pinned temp data/home folders before any src module loads, and
// every fixture below lives in its own temp dir or a cleaned shared one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}
function pinCrashDir(t) {
  const d = tmpdir(t, 'muser-w12-crash-');
  const saved = process.env.MUSER_CRASH_DIR;
  process.env.MUSER_CRASH_DIR = d;
  t.after(() => { if (saved === undefined) delete process.env.MUSER_CRASH_DIR; else process.env.MUSER_CRASH_DIR = saved; });
  return d;
}

// ---------- (1) crash: unquoted paths and emails are scrubbed ----------
const crash = require('../src/crash');

test('w12 crash (1): scrubSecretTextLine hides the user name in an UNQUOTED path (backslash, slash, /home)', () => {
  assert.equal(crash.scrubSecretTextLine('failed at C:\\Users\\W12Alice\\proj\\a.js while reading'),
    'failed at C:\\Users\\<user>\\proj\\a.js while reading');
  assert.equal(crash.scrubSecretTextLine('open C:/Users/W12Alice/proj/a.js now'), 'open C:/Users/<user>/proj/a.js now');
  assert.equal(crash.scrubSecretTextLine('open /home/w12alice/proj/a.js now'), 'open /home/<user>/proj/a.js now');
  assert.ok(!crash.scrubSecretTextLine('x C:\\Users\\W12Alice\\y').includes('W12Alice'), 'the user name itself is gone');
});

test('w12 crash (1): scrubSecretTextLine hides an email and a URL userinfo, benign wording stays', () => {
  assert.equal(crash.scrubSecretTextLine('contact w12alice@example.com for details'), 'contact <email> for details');
  const url = crash.scrubSecretTextLine('fetch https://w12bob:w12secret@api.example.com/x failed');
  assert.ok(url.includes('https://<redacted>@api.example.com/x'), url);
  assert.ok(!url.includes('w12bob') && !url.includes('w12secret'), 'neither credential half survives: ' + url);
  // An address used AS the user name cannot leave its password half behind:
  // the userinfo rule runs to the LAST @ before the path.
  const asUser = crash.scrubSecretTextLine('fetch https://w12alice@example.com@api.example.com/ failed');
  assert.equal(asUser, 'fetch https://<redacted>@api.example.com/ failed');
  assert.ok(!asUser.includes('w12alice') && !asUser.includes('example.com@'), asUser);
});

test('w12 crash (1): safeErrorText scrubs the first line (path + email) and never reaches the second', () => {
  const out = crash.safeErrorText(new Error('blew up at C:\\Users\\W12Alice\\x.js, mail w12alice@example.com\nsecond line W12SecondLine'));
  assert.ok(out.includes('blew up at C:\\Users\\<user>\\x.js, mail <email>'), out);
  assert.ok(!out.includes('W12Alice') && !out.includes('w12alice@example.com'), out);
  assert.ok(!out.includes('W12SecondLine'), 'only the first line is ever kept: ' + out);
  const typed = crash.safeErrorText(new TypeError('path C:\\Users\\W12Alice\\x'));
  assert.equal(typed, 'TypeError: path C:\\Users\\<user>\\x', 'the error name still leads, the path is scrubbed');
});

test('w12 crash (1): a written crash record carries no unquoted user name or email', t => {
  const d = pinCrashDir(t);
  const file = crash.write({version: '9.9.9', error: new Error('died at C:\\Users\\W12Alice\\app.js, contact w12alice@example.com'), trail: [], state: {}});
  assert.ok(file && fs.existsSync(file), 'the record was written');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('W12Alice'), 'the user name is nowhere in the record');
  assert.ok(!raw.includes('w12alice@example.com'), 'the email is nowhere in the record');
  const rec = JSON.parse(raw);
  assert.ok(rec.error.includes('C:\\Users\\<user>\\app.js'), rec.error);
  assert.ok(rec.error.includes('<email>'), rec.error);
  assert.ok(fs.readdirSync(d).includes(path.basename(file)));
});

// ---------- (1) crash: falls that fell differently are not merged ----------
const ci = require('../src/crash-investigate');
const T0 = Date.parse('2026-11-08T12:00:00Z');
function muserFall(detailOver = {}, over = {}) {
  return {kind: 'muser', time: T0, app: 'muser', code: null, module: null,
    detail: {error: 'Error: boom', scope: 'turn', recordKind: '', sessionId: 'sess-w12', ...detailOver}, ...over};
}

test('w12 crash (1): mergeCrashes keeps falls apart when the scope differs (startup vs turn vs fatal)', () => {
  for (const scope of ['startup', 'fatal', 'session']) {
    const merged = ci.mergeCrashes([muserFall(), muserFall({scope}, {time: T0 + 5000})]);
    assert.equal(merged.length, 2, 'scope ' + scope + ' is a different fall from scope turn, 5 s apart or not');
  }
});

test('w12 crash (1): mergeCrashes keeps falls apart when the record kind, the error or the session differs', () => {
  assert.equal(ci.mergeCrashes([muserFall(), muserFall({recordKind: 'hang'}, {time: T0 + 5000})]).length, 2, 'a hang is not the same fall as a crash');
  assert.equal(ci.mergeCrashes([muserFall(), muserFall({error: 'Error: other failure'}, {time: T0 + 5000})]).length, 2, 'a different error is a different fall');
  assert.equal(ci.mergeCrashes([muserFall(), muserFall({sessionId: 'sess-other'}, {time: T0 + 5000})]).length, 2, 'a different conversation is a different fall');
  assert.equal(ci.mergeCrashes([muserFall(), muserFall({sessionId: null}, {time: T0 + 5000})]).length, 2, 'a fall with no session is not the session fall');
});

test('w12 crash (1): mergeCrashes still merges two records of the SAME fall (control)', () => {
  const merged = ci.mergeCrashes([muserFall(), muserFall({}, {time: T0 + 5000})]);
  assert.equal(merged.length, 1, 'identical fingerprint, seconds apart: one fall');
  assert.deepEqual(merged[0].kinds, ['muser']);
  // The Windows twin rule stays loose, but a field BOTH sides carry still blocks a conflict:
  const twin = (error) => ({kind: 'wer', time: T0 + 3000, app: 'app.exe', code: '0xc0000005', module: 'core.dll', detail: {error}});
  const evt = {kind: 'event', time: T0, app: 'app.exe', code: null, module: null, detail: {error: 'Error: boom'}};
  assert.equal(ci.mergeCrashes([evt, twin('Error: boom')]).length, 1, 'an event and its WER twin with the same error merge');
  assert.equal(ci.mergeCrashes([evt, twin('Error: different')]).length, 2, 'conflicting errors do not merge even for Windows sources');
});

test('w12 crash (1): readMuserCrashes carries scope / kind / session, and its falls merge only when identical', t => {
  const dir = tmpdir(t, 'muser-w12-ci-');
  const name = ms => new Date(ms).toISOString().replace(/[:.]/g, '-') + '-111-aaaa.json';
  const put = (ms, rec) => fs.writeFileSync(path.join(dir, name(ms)), JSON.stringify(rec));
  const base = {muser: '0.3.8', error: 'Error: boom', kind: 'crash', sessionId: 'sess-w12'};
  put(T0, {...base, scope: 'startup'});
  put(T0 + 5000, {...base, scope: 'turn'});
  const read = ci.readMuserCrashes({dir, since: T0 - 60000, until: T0 + 60000});
  assert.equal(read.length, 2);
  assert.deepEqual(read.map(c => c.detail.scope).sort(), ['startup', 'turn']);
  assert.ok(read.every(c => c.detail.recordKind === 'crash' && c.detail.sessionId === 'sess-w12'), 'the record kind and session ride along');
  assert.equal(ci.mergeCrashes(read).length, 2, 'the reader output keeps the two falls apart');
  const dir2 = tmpdir(t, 'muser-w12-ci2-');
  fs.writeFileSync(path.join(dir2, name(T0)), JSON.stringify({...base, scope: 'turn'}));
  fs.writeFileSync(path.join(dir2, name(T0 + 5000)), JSON.stringify({...base, scope: 'turn'}));
  assert.equal(ci.mergeCrashes(ci.readMuserCrashes({dir: dir2, since: T0 - 60000, until: T0 + 60000})).length, 1, 'control: identical records from disk merge');
});

test('w12 crash (1): formatLines names how the fall fell and which session it took', () => {
  const report = {windowHours: 1, beforeMin: 30, now: T0, process: null, sources: {},
    crashes: [{kind: 'muser', time: T0, app: 'muser', code: null, module: null, kinds: ['muser'], edits: [],
      detail: {file: 'crash.json', error: 'Error: boom', scope: 'startup', sessionId: 'sess-w12'}}]};
  const text = ci.formatText(report);
  assert.ok(text.includes('落ち方: startup'), text);
  assert.ok(text.includes('セッション: sess-w12'), text);
});

// ---------- (1)+(3) export: latestCrash skips broken records ----------
const exporter = require('../src/export');
const sessions = require('../src/sessions');
function makeSession(t, {counter = 0, turns = []} = {}) {
  const s = sessions.create('C:\\w12-work');
  s.turns = counter;
  sessions.save(s);
  for (const tn of turns) sessions.appendTurn(s.id, tn);
  return s;
}
function turn(over = {}) {
  return {v: 1, at: 1762470000000, user: '直してほしい', reply: '直しました',
    usage: {inputTokens: 111, outputTokens: 22, source: 'live'},
    tools: [{command: 'code.read', summary: 'src/a.js を読んだ', ok: true}],
    steps: [{title: '調査', failed: false}],
    progress: [{agent: 'main', message: '調べています', at: 1762470000001}],
    focus: {status: 'complete', goal: '直す', criteria: [{id: 'c1', status: 'met'}]},
    todos: [{content: '直す', status: 'completed'}], ...over};
}

test('w12 export (1): latestCrash skips a broken newest record and a non-object one, landing on the valid older record', t => {
  const d = pinCrashDir(t);
  const valid = '2026-11-08T01-00-00-000Z-4-valid.json';
  fs.writeFileSync(path.join(d, valid), JSON.stringify({error: 'VALID OLDER CRASH', muser: '0.3.8'}));
  fs.writeFileSync(path.join(d, '2026-11-08T02-00-00-000Z-2-scalar.json'), '"just a string"');
  fs.writeFileSync(path.join(d, '2026-11-08T02-30-00-000Z-3-array.json'), '[1,2]');
  fs.writeFileSync(path.join(d, '2026-11-08T03-00-00-000Z-1-broken.json'), '{not json');
  // Misleading mtimes: the valid record looks oldest by mtime too — the
  // embedded name time orders the sweep, the broken head is skipped.
  const ancient = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(d, valid), ancient, ancient);
  const s = makeSession(t);
  const r = exporter.buildReport({session: s, username: 'w12user'});
  assert.ok(r.crash, 'a crash section exists despite the broken newest record');
  assert.equal(r.crash.file, valid);
  assert.equal(r.crash.report.error, 'VALID OLDER CRASH');
  assert.equal(r.crash.at, '2026-11-08T01:00:00.000Z', 'the time comes from the file name, not the reset mtime');
});

test('w12 export (1): latestCrash is null when every record is broken or not an object', t => {
  const d = pinCrashDir(t);
  fs.writeFileSync(path.join(d, '2026-11-08T03-00-00-000Z-1-broken.json'), '{not json');
  fs.writeFileSync(path.join(d, '2026-11-08T02-00-00-000Z-2-number.json'), '42');
  fs.writeFileSync(path.join(d, '2026-11-08T01-00-00-000Z-3-array.json'), '[{"error":"in an array"}]');
  const s = makeSession(t);
  const r = exporter.buildReport({session: s, username: 'w12user'});
  assert.equal(r.crash, null, 'no valid record: the section is empty, not a broken or non-object one');
});

// ---------- (2) exec-status: latest skips unreadable candidates ----------
const es = require('../src/exec-status');
function cleanExecDir() {
  const d = es.dir();
  fs.mkdirSync(d, {recursive: true});
  for (const n of fs.readdirSync(d)) fs.rmSync(path.join(d, n), {recursive: true, force: true});
  return d;
}
const doneFile = startedAt => JSON.stringify({version: 1, state: 'done', exit: 0, startedAt});

test('w12 exec-status (2): latest() skips a corrupt file, a folder and a scalar, however future-named they are', () => {
  const d = cleanExecDir();
  try {
    fs.writeFileSync(path.join(d, '20260101-000000-1.json'), doneFile('2025-01-01T00:00:00.000Z'));
    const validNew = '20260201-000000-2.json';
    fs.writeFileSync(path.join(d, validNew), doneFile('2026-02-01T00:00:00.000Z'));
    fs.writeFileSync(path.join(d, '20270101-000000-3.json'), '{not json');
    fs.writeFileSync(path.join(d, '20290101-000000-4.json'), '42');
    fs.mkdirSync(path.join(d, '20280101-000000-5.json')); // a directory wearing a status name
    assert.equal(path.basename(es.latest()), validNew, 'the newest READABLE run wins; unreadable candidates are skipped, not crowned');
  } finally { cleanExecDir(); }
});

test('w12 exec-status (2): latest() skips JSON that is not a status object (number / string / null / boolean)', () => {
  const d = cleanExecDir();
  try {
    const valid = '20260101-000000-9.json';
    fs.writeFileSync(path.join(d, valid), doneFile('2026-01-01T00:00:00.000Z'));
    fs.writeFileSync(path.join(d, '20270101-000000-1.json'), '42');
    fs.writeFileSync(path.join(d, '20270201-000000-2.json'), '"hello"');
    fs.writeFileSync(path.join(d, '20270301-000000-3.json'), 'null');
    fs.writeFileSync(path.join(d, '20270401-000000-4.json'), 'true');
    assert.equal(path.basename(es.latest()), valid);
  } finally { cleanExecDir(); }
});

test('w12 exec-status (2): latest() returns null when no candidate can be read', () => {
  const d = cleanExecDir();
  try {
    fs.writeFileSync(path.join(d, '20270101-000000-1.json'), '{broken');
    fs.writeFileSync(path.join(d, '20270201-000000-2.json'), '42');
    fs.mkdirSync(path.join(d, '20270301-000000-3.json'));
    assert.equal(es.latest(), null, 'all candidates unreadable: no file, not the corrupt head');
  } finally { cleanExecDir(); }
});

test('w12 exec-status (2): the CLI --status falls back to the readable run behind a corrupt newest file', t => {
  const {spawnSync} = require('node:child_process');
  const appdata = tmpdir(t, 'muser-w12-exec-cli-');
  const d = path.join(appdata, 'muser', 'exec');
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(d, '20270101-000000-1.json'), '{not json');
  fs.writeFileSync(path.join(d, '20260101-000000-2.json'), JSON.stringify({state: 'done', exit: 2, durationMs: 1000, reply: 'readable one'}));
  const bin = path.join(__dirname, '..', 'bin', 'muser.js');
  const r = spawnSync(process.execPath, [bin, 'exec', '--status'], {env: {...process.env, LOCALAPPDATA: appdata, MUSER_LANG: 'en'}, encoding: 'utf8', timeout: 30000});
  assert.equal(r.status, 2, 'the exit code is the readable run\'s, not gone (5): ' + r.stdout + r.stderr);
  assert.match(r.stdout, /reply:\nreadable one/);
});

// ---------- (2) exec-status: summary exit and reply ----------
const NOW2 = Date.parse('2026-11-08T12:02:00Z');
const deadBase = {version: 1, state: 'running', pid: 424242, startedAt: '2026-11-08T12:00:00Z', updatedAt: '2026-11-08T12:01:57Z', tools: 3, session: 'sess-w12', account: 'sub'};

test('w12 exec-status (2): summary puts NO exit on a dead run, whatever exit value the file carries', () => {
  for (const exit of [0, 2, '0', 1.5, null]) {
    const v = {...deadBase, exit};
    const out = es.summary(v, {now: NOW2, isAlive: () => false});
    assert.match(out, /^dead · /, 'the run is dead for exit=' + JSON.stringify(exit));
    assert.ok(!out.split('\n')[0].includes('exit'), 'a dead run has no exit line (exit=' + JSON.stringify(exit) + '): ' + out.split('\n')[0]);
    assert.equal(es.code(v, {now: NOW2, isAlive: () => false}), 5);
  }
  // Dead by a stopped heartbeat (pid alive but reused) is the same:
  const stale = {...deadBase, exit: 2, updatedAt: '2026-11-08T11:00:00Z'};
  const out = es.summary(stale, {now: NOW2, isAlive: () => true});
  assert.match(out, /^dead · /);
  assert.ok(!out.split('\n')[0].includes('exit'), out.split('\n')[0]);
});

test('w12 exec-status (2): summary shows an exit only on a finished run and only when it is an integer (control)', () => {
  const done = {version: 1, state: 'done', pid: 1, startedAt: '2026-11-08T12:00:00Z', updatedAt: '2026-11-08T12:01:00Z', durationMs: 60000, tools: 1};
  assert.match(es.summary({...done, exit: 0}, {now: NOW2}).split('\n')[0], /exit 0/);
  assert.match(es.summary({...done, exit: 2}, {now: NOW2}).split('\n')[0], /exit 2 \(Focus criteria not met\)/);
  assert.match(es.summary({...done, state: 'interrupted', exit: 130}, {now: NOW2}).split('\n')[0], /exit 130/);
  assert.match(es.summary({...done, state: 'failed', exit: 1}, {now: NOW2}).split('\n')[0], /exit 1/);
  for (const exit of ['0', 1.5, null, NaN]) {
    const head = es.summary({...done, exit}, {now: NOW2}).split('\n')[0];
    assert.ok(!head.includes('exit'), 'a non-integer exit is not printed even on a done run (exit=' + String(exit) + '): ' + head);
  }
});

test('w12 exec-status (2): summary cuts a long reply at 500 code points and says so', () => {
  const done = {version: 1, state: 'done', exit: 0, pid: 1, startedAt: '2026-11-08T12:00:00Z', updatedAt: '2026-11-08T12:01:00Z', durationMs: 1000, tools: 0};
  const long = es.summary({...done, reply: 'a'.repeat(600)}, {now: NOW2});
  assert.ok(long.endsWith('reply:\n' + 'a'.repeat(500) + '\n… (truncated)'), 'exactly 500 characters ride, then the cut is named');
  assert.ok(!long.includes('a'.repeat(501)), 'the 501st character is gone');
  const at500 = es.summary({...done, reply: 'x'.repeat(500)}, {now: NOW2});
  assert.ok(at500.endsWith('reply:\n' + 'x'.repeat(500)) && !at500.includes('truncated'), 'exactly 500 is NOT cut (control)');
  const at501 = es.summary({...done, reply: 'x'.repeat(501)}, {now: NOW2});
  assert.ok(at501.includes('… (truncated)') && !at501.includes('x'.repeat(501)), '501 is cut');
  const short = es.summary({...done, reply: 'short answer'}, {now: NOW2});
  assert.ok(short.endsWith('reply:\nshort answer') && !short.includes('truncated'), 'a short reply rides whole (control)');
});

test('w12 exec-status (2): the reply cut counts code points — a surrogate pair at the boundary stays whole', () => {
  const done = {version: 1, state: 'done', exit: 0, pid: 1, startedAt: '2026-11-08T12:00:00Z', updatedAt: '2026-11-08T12:01:00Z', durationMs: 1000, tools: 0};
  const reply = 'a'.repeat(499) + '\u{1F600}' + 'b'.repeat(20); // the emoji is code point 500
  const out = es.summary({...done, reply}, {now: NOW2});
  assert.ok(out.endsWith('reply:\n' + 'a'.repeat(499) + '\u{1F600}' + '\n… (truncated)'), 'the pair is kept whole at the cut, never split');
  assert.ok(!out.includes('b'), 'everything past code point 500 is gone');
  // A non-string reply is stringified, not crashed on:
  assert.ok(es.summary({...done, reply: 42}, {now: NOW2}).endsWith('reply:\n42'));
});

// ---------- (3) export: turn-count gaps are named ----------

test('w12 export (3): syncTurnsCount states turnsRecorded always and notes a gap in either direction', () => {
  const short = {session: {turns: 5}, turns: [{}, {}]};
  exporter.syncTurnsCount(short);
  assert.equal(short.session.turnsRecorded, 2, 'the carried count is stated');
  assert.equal(short.session.turnsMissing, 3);
  assert.match(short.session.turnsNote, /turns count differs: session\.turns is 5 but this report carries 2/);
  const over = {session: {turns: 1}, turns: [{}, {}, {}]};
  exporter.syncTurnsCount(over);
  assert.equal(over.session.turnsRecorded, 3);
  assert.match(over.session.turnsNote, /the transcript carries 2 more turn record\(s\) than the counter says/);
  assert.ok(!('turnsMissing' in over.session), 'nothing is "missing" when the transcript carries MORE');
  const even = {session: {turns: 2, turnsNote: 'stale note', turnsMissing: 9}, turns: [{}, {}]};
  exporter.syncTurnsCount(even);
  assert.equal(even.session.turnsRecorded, 2);
  assert.ok(!('turnsNote' in even.session) && !('turnsMissing' in even.session), 'a matching count clears any stale note (control)');
});

test('w12 export (3): syncTurnsCount re-syncs after turns are dropped (the post-trim pass)', () => {
  const rep = {session: {turns: 4}, turns: [{}, {}, {}, {}]};
  exporter.syncTurnsCount(rep);
  assert.ok(!('turnsNote' in rep.session), 'no gap before the trim');
  rep.turns.splice(0, 2); // what trimToFit does to the oldest turns
  exporter.syncTurnsCount(rep);
  assert.equal(rep.session.turnsRecorded, 2, 'turnsRecorded describes the turns NOW carried');
  assert.equal(rep.session.turnsMissing, 2);
  assert.match(rep.session.turnsNote, /session\.turns is 4 but this report carries 2/);
});

test('w12 export (3): buildReport names the gap when the counter and the records disagree', t => {
  const s = makeSession(t, {counter: 5, turns: [turn(), turn()]});
  const r = exporter.buildReport({session: s, username: 'w12user'});
  assert.equal(r.session.turns, 5, 'the counter rides as counted');
  assert.equal(r.turns.length, 2);
  assert.equal(r.session.turnsRecorded, 2);
  assert.equal(r.session.turnsMissing, 3);
  assert.match(r.session.turnsNote, /turns count differs/);
});

test('w12 export (3): buildReport notes a transcript longer than the counter, and stays silent when they agree', t => {
  const over = exporter.buildReport({session: makeSession(t, {counter: 1, turns: [turn(), turn()]}), username: 'w12user'});
  assert.equal(over.session.turnsRecorded, 2);
  assert.match(over.session.turnsNote, /turns count differs/);
  assert.ok(!('turnsMissing' in over.session));
  const even = exporter.buildReport({session: makeSession(t, {counter: 2, turns: [turn(), turn()]}), username: 'w12user'});
  assert.equal(even.session.turnsRecorded, 2);
  assert.ok(!('turnsNote' in even.session) && !('turnsMissing' in even.session), 'agreement needs no note (control)');
});

// ---------- (3) export: sources ride along ----------

test('w12 export (3): turnSnapshot carries the turn sources in BOTH body modes, junk dropped', () => {
  const srcs = [{label: 'Guide', uri: 'https://example.com/guide'}, 'https://example.com/plain',
    null, 42, {}, {label: '', uri: ''}, {label: 'Only label'}];
  for (const includeConversation of [false, true]) {
    const out = exporter.turnSnapshot(turn({sources: srcs}), includeConversation);
    assert.deepEqual(out.sources, [
      {label: 'Guide', uri: 'https://example.com/guide'},
      {label: '', uri: 'https://example.com/plain'},
      {label: 'Only label', uri: ''},
    ], 'sources ride with includeConversation=' + includeConversation);
  }
  assert.ok(!('sources' in exporter.turnSnapshot(turn(), false)), 'no sources recorded: no sources key (control)');
  assert.ok(!('sources' in exporter.turnSnapshot(turn({sources: []}), true)), 'an empty list stays out too');
});

test('w12 export (3): buildReport carries sources (redacted like everything) with and without the body', t => {
  const srcs = [{label: 'Guide', uri: 'https://example.com/guide'},
    {label: 'mail w12alice@example.com', uri: 'https://example.com/contact'}];
  for (const includeConversation of [false, true]) {
    const s = makeSession(t, {counter: 1, turns: [turn({sources: srcs})]});
    const r = exporter.buildReport({session: s, username: 'w12user', includeConversation});
    assert.deepEqual(r.turns[0].sources, [
      {label: 'Guide', uri: 'https://example.com/guide'},
      {label: 'mail <email>', uri: 'https://example.com/contact'},
    ], 'sources survive the whole report path, includeConversation=' + includeConversation);
    assert.ok(!JSON.stringify(r).includes('w12alice@example.com'), 'an email inside a source is redacted on the way out');
  }
});
