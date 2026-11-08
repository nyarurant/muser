'use strict';
// Integration across the ten 2026-11-07 features, on ONE conversation.
//
// The wiring problem this pins: feat-worklog's writer (src/worklog.js,
// driven from agent.js) writes one shape — {v, at, session, event, ...} —
// and every other feature was built against the design's *assumed* shape
// (a `type`/`kind` discriminator, a turn's `prompt`, an edit's singular
// `range`, a tool's `exit`). This test runs one conversation through the
// agent exactly as the features' own tests drive it (a stub Muse client,
// real tool execution), lets the real writer record it, and then reads
// the same file back through every feature that consumes the work log:
// `muser log` (the CLI, in a child process), /proof, /why + `muser lore`
// (the CLI too), `muser crash`'s reader, expect's outcome aggregation,
// race's proof badge and overnight's morning summary. If a reader drifts
// from the writer's shape again, this test is the one that goes red.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {execFileSync} = require('node:child_process');

// Same isolation as tests/agent.test.js / tests/expect.test.js, before any
// src module loads: the whole data root (work log, lore store) is a temp dir.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-integ-data-'));
process.env.LOCALAPPDATA = DATA;
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-integ-home-'));

const {Agent} = require('../src/agent');
const {Worklog, WORKLOG_DIR} = require('../src/worklog');
const expectKit = require('../src/expect');
const proof = require('../src/proof/index');
const lore = require('../src/lore');
const ci = require('../src/crash-investigate');
const race = require('../src/race');
const overnight = require('../src/overnight/worklog-read');

function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async () => {};
  c.disconnect = () => {};
  return c;
}
const tmpdir = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-integ-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; };

test('one conversation, written by the real writer, read back by every feature', {timeout: 180000}, async (t) => {
  const cwd = tmpdir(t);
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  const sessionId = 'sess-integ-1';
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: sessionId, cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'bypass'});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  // `muser log <id>` resolves the id through the session index, as it does
  // for a real window's conversation.
  require('../src/sessions').save({id: sessionId, cwd, title: 'integration', created: Date.now(), updated: Date.now(), turns: 1});
  const turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, log: {tools: [], steps: [], progress: []}};
  a.main.turn = turn;
  const wl = a.worklogFor(a.main);
  assert.ok(wl, 'the session has a work log');

  // --- the conversation -------------------------------------------------
  // runTurn's own turn line, through the same builder it uses.
  wl.turn({text: 'parse.js の境界バグを直して、テストも回して', agent: 'main'});
  let r = await a.execute('code.write', {path: 'src/parse.js', content: 'export function parse(s) {\n  return s;\n}\n'}, 60000, 'inv-integ-1');
  assert.equal(r.ok, true, 'write ran');
  r = await a.execute('code.read', {path: 'src/parse.js'}, 60000, 'inv-integ-1b');
  assert.equal(r.ok, true, 'read before edit ran');
  r = await a.execute('code.edit', {path: 'src/parse.js', old_string: 'return s;', new_string: 'return s.trim();'}, 60000, 'inv-integ-2');
  assert.equal(r.ok, true, 'edit ran: ' + (r.error || ''));
  r = await a.execute('system.run', {command: "Write-Output 'Tests: 0 failed, 1 passed, 1 total'", expect: {tests: 'pass'}}, 60000, 'inv-integ-3');
  assert.equal(r.ok, true, 'the passing run ran');
  assert.equal(r.payload.expect_mismatch, undefined, 'the passing prediction stays quiet');
  r = await a.execute('system.run', {command: "Write-Output 'hello'", expect: {contains: 'goodbye'}}, 60000, 'inv-integ-4');
  assert.equal(r.ok, true, 'the missing run ran');
  assert.match(r.payload.expect_mismatch, /想定外/, 'the miss is marked in the result');
  r = await a.execute('expect.reconcile', {reason: '出力の文言が想定と違った'}, 60000, 'inv-integ-5');
  assert.equal(r.ok, true, 'reconcile recorded');
  r = await a.execute('lore.hunch', {path: 'src/parse.js', line: 2, text: 'trim の境界条件が怪しい'}, 60000, 'inv-integ-6');
  assert.equal(r.ok, true, 'the hunch tool recorded: ' + JSON.stringify(r));
  r = await a.execute('code.read', {path: 'src/parse.js'}, 60000, 'inv-integ-7');
  assert.equal(r.ok, true, 'read ran');
  assert.ok(String(r.payload.lore_notes || '').includes('言い伝え'), 'the open hunch rides the read result back to Muse');
  assert.ok(String(r.payload.lore_notes || '').includes('trim の境界条件が怪しい'), 'the hunch text itself is attached');
  // record() is the turn's end: the reply line lands, and the lore sync
  // folds this turn's edits into records.
  a.record(a.main, turn, 'parse.js の境界バグを直して、テストも回して', {reply: 'テスト 1 件通過しました。src/parse.js を直しました。'});
  wl.flush();

  // --- the file itself: the writer's real shape -------------------------
  const file = path.join(WORKLOG_DIR, sessionId + '.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.length >= 8, 'the conversation was recorded: ' + lines.length + ' lines');
  for (const e of lines) {
    assert.equal(e.v, 1, 'every line is stamped v1');
    assert.equal(e.session, sessionId, 'every line names its session');
    assert.equal(typeof e.at, 'string', 'every line carries an ISO time');
    assert.equal(typeof e.event, 'string', 'every line discriminates with `event`');
  }
  const kinds = lines.map(e => e.event);
  for (const want of ['turn', 'edit', 'tool', 'expect', 'expect-reconcile', 'reply'])
    assert.ok(kinds.includes(want), 'the log holds a ' + want + ' event: ' + kinds.join(','));
  assert.equal(lines.filter(e => e.event === 'edit').length, 2, 'write + edit are two edit events');
  const edit = lines.find(e => e.event === 'edit' && String(e.path).endsWith('parse.js'));
  assert.ok(Array.isArray(edit.ranges) && edit.ranges.length >= 1, 'an edit carries ranges as {start, end} objects');
  assert.ok(edit.beforeHash && edit.afterHash, 'an edit carries its hashes');

  // --- `muser log` reads it (the CLI itself, in a child process) --------
  const logOut = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'muser.js'), 'log', sessionId, '--json'],
    {encoding: 'utf8', env: {...process.env, LOCALAPPDATA: DATA}});
  const cliEvents = JSON.parse(logOut.slice(logOut.indexOf('['), logOut.lastIndexOf(']') + 1));
  assert.ok(cliEvents.some(e => e.event === 'expect' && e.matched === false), 'muser log --json shows the missed prediction');
  const rows = Worklog.list(WORKLOG_DIR);
  assert.equal(rows.find(x => x.id === sessionId)?.turns, 1, 'muser log lists the conversation with its turn');
  const formatted = Worklog.format(Worklog.read(sessionId, WORKLOG_DIR));
  assert.ok(formatted.some(l => l.includes('expect') && l.includes('想定外')), 'the timeline spells the miss as 想定外');

  // --- expect's aggregation reads it ------------------------------------
  assert.deepEqual(expectKit.countExpectOutcomes(expectKit.readWorklogEvents(sessionId)),
    {total: 2, matched: 1, mismatched: 1, unjudged: 0});

  // --- /proof reads it ----------------------------------------------------
  const judged = proof.proofConversation(sessionId, {base: DATA});
  assert.equal(judged.missing, false, '/proof finds the conversation');
  assert.equal(judged.result.counts.ok, 2, 'both claims in the reply are backed: ' + JSON.stringify(judged.result.counts));

  // --- /why and `muser lore` read it --------------------------------------
  const why = lore.whyFor(cwd, 'src/parse.js', 2);
  assert.ok(why.length >= 1, '/why finds why line 2 changed');
  const cliWhy = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'muser.js'), 'lore', 'why', 'src/parse.js:2'],
    {encoding: 'utf8', cwd, env: {...process.env, LOCALAPPDATA: DATA}});
  assert.ok(cliWhy.includes('parse.js'), 'muser lore why answers for the same edit');
  assert.ok(lore.attachText(cwd, 'src/parse.js').includes('未確認の前提'), 'the hunch is attachable after the turn');
  assert.ok(lore.attachText(cwd, 'src/parse.js').includes('trim の境界条件が怪しい'), 'the hunch text is in the attachment');

  // --- `muser crash`'s reader lines the edits up --------------------------
  const {edits} = ci.readWorklogEdits({dir: WORKLOG_DIR, since: 0, until: Date.now() + 60000});
  const parseEdits = edits.filter(e => e.path && e.path.endsWith('parse.js'));
  assert.equal(parseEdits.length, 2, 'crash lining-up finds both edits');
  assert.ok(parseEdits.every(e => !e.sensitive), 'nothing here is masked');
  const crashDir = tmpdir(t);
  const stamp = new Date(Date.now() + 60000).toISOString().replace(/[:.]/g, '-') + '-999-abcd1234.json';
  fs.writeFileSync(path.join(crashDir, stamp), JSON.stringify({muser: '0.3.8', error: 'Error: render died', scope: 'fatal'}));
  const rep = await ci.investigate({now: Date.now() + 120000, eventsText: '', werDirs: [], nodeReportDirs: [], crashDir, worklogDir: WORKLOG_DIR, cwd});
  const fall = rep.crashes.find(c => c.kind === 'muser');
  assert.ok(fall, 'the fabricated fall is investigated');
  assert.ok(fall.edits.some(e => e.path && e.path.endsWith('parse.js')), 'the edits line up before the fall');

  // --- race's badge and overnight's summary read it -----------------------
  assert.equal(race.proofBadge(race.readWorklog(sessionId, {dir: WORKLOG_DIR})).mark, '✓', 'race badge: a passing test run after the last edit');
  const sum = overnight.summarizeWorklog(sessionId, {baseDir: WORKLOG_DIR});
  assert.equal(sum.badge, 'ok', 'overnight badge agrees');
  assert.equal(sum.turns, 1);
  assert.equal(sum.edits, 2);
  assert.ok(sum.files.some(f => f.endsWith('parse.js')), 'overnight names the edited file');
});
