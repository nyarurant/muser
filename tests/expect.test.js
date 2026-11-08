'use strict';
// 想定外ストップ (src/expect.js + the agent.js wiring), design
// docs/design/new-features.md §4. The work log's writer side is another
// branch's work: here the reader is exercised against a hand-written
// sample work log in the design's shape, and the events this feature
// appends itself (expect / expect-block / expect-reconcile).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Same isolation as tests/agent.test.js, before any src module loads.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-expect-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-expect-test-home-'));

const expectKit = require('../src/expect');
const settings = require('../src/settings');
const {Agent, preamble} = require('../src/agent');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-expect-test-'));
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
  c.disconnect = () => {};
  return c;
}
let agentSeq = 0;
function makeAgent(t, agentOpts = {}) {
  const cwd = agentOpts.cwd || tmpdir(t);
  // A unique conversation id per agent: the work log is one file per
  // conversation, and tests must not read each other's records.
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'sess-expect-' + (++agentSeq), cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'bypass', ...agentOpts});
  a.subscribed = true;
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
  return a.main.turn;
}
function setMode(t, mode) {
  settings.setExpectMode(mode, {save: false});
  t.after(() => settings.setExpectMode('record', {save: false}));
}

// ---------- normalizeExpect: the fixed shapes only ----------

test('normalizeExpect accepts exactly the five fixed shapes, as object or JSON text', () => {
  assert.deepEqual(expectKit.normalizeExpect({exit: 0}).spec, {exit: 0});
  assert.deepEqual(expectKit.normalizeExpect({exit: 2}).spec, {exit: 2});
  assert.deepEqual(expectKit.normalizeExpect({exit: 'nonzero'}).spec, {exit: 'nonzero'});
  assert.deepEqual(expectKit.normalizeExpect({contains: 'ok'}).spec, {contains: 'ok'});
  assert.deepEqual(expectKit.normalizeExpect({notContains: 'Error'}).spec, {notContains: 'Error'});
  assert.deepEqual(expectKit.normalizeExpect({tests: 'pass'}).spec, {tests: 'pass'});
  assert.deepEqual(expectKit.normalizeExpect({tests: 'fail'}).spec, {tests: 'fail'});
  assert.deepEqual(expectKit.normalizeExpect('{"exit": 0}').spec, {exit: 0});
});

test('normalizeExpect refuses anything else', () => {
  for (const bad of [null, 42, [], {}, {exit: 0, contains: 'x'}, {foo: 1}, {exit: 'zero'}, {exit: 0.5}, {contains: ''}, {contains: 3}, {tests: 'green'}, 'not json', '{exit: 0}'])
    assert.ok(expectKit.normalizeExpect(bad).error, JSON.stringify(bad));
});

// ---------- evaluateExpect ----------

test('evaluateExpect: exit forms', () => {
  assert.deepEqual(expectKit.evaluateExpect({exit: 0}, {exit: 0, output: ''}), {matched: true, actual: 'exit 0'});
  assert.deepEqual(expectKit.evaluateExpect({exit: 0}, {exit: 3, output: ''}), {matched: false, actual: 'exit 3'});
  assert.equal(expectKit.evaluateExpect({exit: 'nonzero'}, {exit: 3, output: ''}).matched, true);
  assert.equal(expectKit.evaluateExpect({exit: 'nonzero'}, {exit: 0, output: ''}).matched, false);
  // No exit code yet (a background start): recorded, never judged.
  assert.equal(expectKit.evaluateExpect({exit: 0}, {exit: null, output: ''}).matched, null);
});

test('evaluateExpect: contains / notContains look at stdout+stderr text', () => {
  assert.equal(expectKit.evaluateExpect({contains: 'hello'}, {exit: 0, output: 'say hello world'}).matched, true);
  const miss = expectKit.evaluateExpect({contains: 'hello'}, {exit: 0, output: 'bye'});
  assert.equal(miss.matched, false);
  assert.match(miss.actual, /含まれなかった/);
  assert.equal(expectKit.evaluateExpect({notContains: 'Error'}, {exit: 0, output: 'all fine'}).matched, true);
  assert.equal(expectKit.evaluateExpect({notContains: 'Error'}, {exit: 0, output: 'Error: boom'}).matched, false);
});

test('evaluateExpect: tests forms read the pass/fail counts of common runners', () => {
  const nodeStyle = 'ℹ tests 10\nℹ pass 9\nℹ fail 1\n';
  assert.deepEqual(expectKit.evaluateExpect({tests: 'pass'}, {exit: 1, output: nodeStyle}), {matched: false, actual: 'pass 9 / fail 1'});
  assert.equal(expectKit.evaluateExpect({tests: 'fail'}, {exit: 1, output: nodeStyle}).matched, true);
  assert.equal(expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'ℹ pass 12\nℹ fail 0\n'}).matched, true);
  assert.equal(expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'Tests: 2 failed, 8 passed, 10 total'}).matched, false);
  // Spec update (audit-cli wave 8): '10 passing' ALONE used to pin
  // matched:true, but a one-sided summary says nothing about failures —
  // expect now reads counts exactly like proof and leaves it unjudged
  // (matched:null, actual shows only the side actually read), instead of
  // fabricating the missing side as 0. The two-sided pins above stand.
  const oneSided = expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: '10 passing (5ms)'});
  assert.equal(oneSided.matched, null, 'a pass count with no fail count is unjudged, not a pass');
  assert.equal(oneSided.actual, 'pass 10');
  const unreadable = expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'done, trust me'});
  assert.equal(unreadable.matched, null, 'unreadable counts are unjudged, not a mismatch (features-debug #15)');
  assert.match(unreadable.actual, /読み取れなかった/);
});

test('expectText and mismatchLine spell the prediction the same everywhere', () => {
  assert.equal(expectKit.expectText({exit: 0}), 'exit 0');
  assert.equal(expectKit.expectText({exit: 'nonzero'}), 'exit 非0');
  assert.equal(expectKit.expectText({tests: 'pass'}), 'テスト全通過');
  assert.equal(expectKit.mismatchLine({exit: 0}, 'exit 3'), '[muser: 想定外] 予想: exit 0 / 実際: exit 3');
});

// ---------- the work-log reader, against a hand-written sample ----------

test('the reader parses a sample work log in the shape src/worklog.js writes and counts outcomes', (t) => {
  const dir = tmpdir(t);
  const at = s => '2026-11-07T00:00:0' + s + '.000Z';
  const sample = [
    {v: 1, event: 'turn', at: at(1), session: 'conv-1', text: 'テストを直して', agent: 'main'},
    {v: 1, event: 'tool', at: at(2), session: 'conv-1', command: 'system.run', summary: 'npm test', ok: true},
    {v: 1, event: 'expect', at: at(3), session: 'conv-1', agent: 'main', command: 'system.run', expect: {tests: 'pass'}, matched: false, expected: 'テスト全通過', actual: 'pass 9 / fail 1', mode: 'record'},
    {v: 1, event: 'edit', at: at(4), session: 'conv-1', path: 'src/a.js', op: 'edit', beforeHash: 'hash-a', afterHash: 'hash-b'},
    {v: 1, event: 'expect', at: at(5), session: 'conv-1', agent: 'main', command: 'system.run', expect: {exit: 0}, matched: true, expected: 'exit 0', actual: 'exit 0', mode: 'record'},
    {kind: 'expect', at: 6, expect: {exit: 0}, matched: null, expected: 'exit 0', actual: 'exit 不明（バックグラウンド）', mode: 'record'}, // a pre-wiring line still counts
    {v: 1, event: 'reply', at: at(7), session: 'conv-1', text: '直しました', agent: 'main'},
    {v: 1, event: 'focus', at: at(8), session: 'conv-1', focus: {status: 'complete'}},
  ];
  fs.mkdirSync(dir, {recursive: true});
  // One broken line in the middle: skipped, never fatal.
  const text = sample.slice(0, 3).map(e => JSON.stringify(e)).join('\n') + '\n{broken json\n' + sample.slice(3).map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'conv-1.jsonl'), text);
  const events = expectKit.readWorklogEvents('conv-1', {dir});
  assert.equal(events.length, sample.length);
  assert.equal(expectKit.readExpectEvents('conv-1', {dir}).length, 3, 'event and legacy kind discriminators both read');
  assert.deepEqual(expectKit.countExpectOutcomes(events), {total: 3, matched: 1, mismatched: 1, unjudged: 1});
  assert.deepEqual(expectKit.readWorklogEvents('no-such-conversation', {dir}), [], 'a missing log is empty, not an error');
  // The retention premise the merge shares (design §1: 30 days / 500MB).
  assert.equal(expectKit.WORKLOG_KEEP_DAYS, 30);
  assert.equal(expectKit.WORKLOG_MAX_TOTAL_BYTES, 500 * 1024 * 1024);
  assert.ok(expectKit.worklogFile('conv-1', dir).endsWith(path.join('conv-1.jsonl')));
});

test('appendWorklogEvent writes through the worklog writer and never records a secret value', (t) => {
  const dir = tmpdir(t);
  const ok = expectKit.appendWorklogEvent('conv-2', {kind: 'expect', at: 1, matched: false, token: 'sekrit-value', nested: {api_key: 'also-sekrit', note: 'fine'}}, {dir});
  assert.equal(ok, true);
  const raw = fs.readFileSync(path.join(dir, 'conv-2.jsonl'), 'utf8');
  assert.ok(!raw.includes('sekrit'), 'no secret value reaches the file');
  assert.match(raw, /\[redacted\]/);
  const events = expectKit.readWorklogEvents('conv-2', {dir});
  assert.equal(events.length, 1);
  assert.equal(events[0].nested.note, 'fine');
  // The line on disk is the writer's shape: the legacy kind/at spelling was
  // translated and stamped by the Worklog itself.
  assert.equal(events[0].event, 'expect');
  assert.equal(events[0].kind, undefined);
  assert.equal(events[0].v, 1);
  assert.equal(events[0].session, 'conv-2');
  assert.equal(typeof events[0].at, 'string');
  // With a session Worklog handed over (as agent.js does), the line joins
  // that instance's queue and lands in the same file on flush.
  const {Worklog} = require('../src/worklog');
  const wl = new Worklog({sessionId: 'conv-2', dir});
  assert.equal(expectKit.appendWorklogEvent('conv-2', {event: 'expect-reconcile', agent: 'main', reason: 'もともと落ちていた'}, {worklog: wl}), true);
  wl.flush();
  const after = expectKit.readWorklogEvents('conv-2', {dir});
  assert.equal(after.length, 2);
  assert.equal(after[1].event, 'expect-reconcile');
  assert.equal(after[1].reason, 'もともと落ちていた');
});

// ---------- the setting ----------

test('expectMode defaults to record and only takes the three modes', (t) => {
  assert.equal(settings.expectMode(), 'record');
  settings.setExpectMode('stop', {save: false});
  t.after(() => settings.setExpectMode('record', {save: false}));
  assert.equal(settings.expectMode(), 'stop');
  assert.throws(() => settings.setExpectMode('loud', {save: false}), /Unknown expect mode/);
  assert.equal(settings.expectMode(), 'stop', 'a refused value changes nothing');
});

test('the preamble carries the EXPECT instruction unless the mode is off', (t) => {
  const dir = tmpdir(t);
  assert.match(preamble(dir, []), /EXPECT: When you run tests or a build/);
  setMode(t, 'off');
  assert.ok(!preamble(dir, []).includes('EXPECT: When you run tests'), 'off: Muse is not asked for predictions');
});

// ---------- through the agent: record mode (the default) ----------

test('record mode: a miss is marked in the result and the view, recorded, and stops nothing', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const ends = [];
  a.on('tool-end', e => ends.push(e));
  const r = await a.execute('system.run', {command: 'exit 3', expect: {exit: 0}}, 60000, 'inv-expect-1');
  assert.equal(r.ok, true, 'the run itself ran');
  assert.equal(r.payload.exit_code, 3);
  assert.match(r.payload.expect_mismatch, /\[muser: 想定外\] 予想: exit 0 \/ 実際: exit 3/);
  const end = ends.find(e => e.command === 'system.run');
  assert.deepEqual(end.view.expect, {expected: 'exit 0', actual: 'exit 3', matched: false}, 'the tool row carries the mark for both screens');
  const events = expectKit.readExpectEvents(a.session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].matched, false);
  assert.equal(events[0].mode, 'record');
  // Nothing is held: the next write goes straight through.
  const w = await a.execute('code.write', {path: 'after.txt', content: 'x\n'}, 1000, 'inv-expect-2');
  assert.equal(w.ok, true);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'after.txt'), 'utf8'), 'x\n');
});

test('record mode: a matched prediction stays quiet but is still recorded', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const r = await a.execute('system.run', {command: 'Write-Output hello', expect: {contains: 'hello'}}, 60000, 'inv-expect-3');
  assert.equal(r.ok, true);
  assert.equal(r.payload.expect_mismatch, undefined);
  const events = expectKit.readExpectEvents(a.session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].matched, true);
});

test('an invalid expect shape is refused before the command runs', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const target = path.join(a.cwd, 'should-not-exist.txt');
  const r = await a.execute('system.run', {command: "Set-Content -LiteralPath '" + target + "' -Value x", expect: {exit: 'zero'}}, 60000, 'inv-expect-4');
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid expect/);
  assert.equal(fs.existsSync(target), false, 'the command never ran');
  assert.equal(expectKit.readExpectEvents(a.session.id).length, 0, 'nothing was recorded');
});

// ---------- through the agent: stop mode ----------

test('stop mode: a write is held until reconcile or a read — a bare retry is held again', async (t) => {
  setMode(t, 'stop');
  const a = makeAgent(t);
  startTurn(a);
  const r = await a.execute('system.run', {command: 'exit 3', expect: {exit: 0}}, 60000, 'inv-expect-5');
  assert.match(r.payload.expect_mismatch, /will be stopped once/);
  const file = path.join(a.cwd, 'held.txt');
  const w1 = await a.execute('code.write', {path: 'held.txt', content: 'x\n'}, 1000, 'inv-expect-6');
  assert.equal(w1.ok, false);
  assert.match(w1.error, /想定外.*stopped once/);
  assert.equal(fs.existsSync(file), false, 'the held write did not happen');
  // Design §4 step 3: the refusal alone must not lift the hold — thinking
  // (reconcile) or looking (a read) is what releases it (features-debug #16).
  const w2 = await a.execute('code.write', {path: 'held.txt', content: 'x\n'}, 1000, 'inv-expect-7');
  assert.equal(w2.ok, false, 'an immediate retry without reconcile/read is held again');
  assert.equal(fs.existsSync(file), false);
  const rec = await a.execute('expect.reconcile', {reason: 'the command was meant to fail'}, 1000, 'inv-expect-7b');
  assert.equal(rec.ok, true);
  const w3 = await a.execute('code.write', {path: 'held.txt', content: 'x\n'}, 1000, 'inv-expect-7c');
  assert.equal(w3.ok, true, 'after reconciling, the write goes through');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
  const kinds = expectKit.readWorklogEvents(a.session.id).map(e => expectKit.eventKind(e));
  assert.ok(kinds.includes('expect') && kinds.includes('expect-block'), 'the miss and the hold are both in the record: ' + kinds.join(','));
});

test('stop mode: expect.reconcile clears the hold and records the one-line reason', async (t) => {
  setMode(t, 'stop');
  const a = makeAgent(t);
  startTurn(a);
  await a.execute('system.run', {command: 'exit 3', expect: {exit: 0}}, 60000, 'inv-expect-8');
  const bad = await a.execute('expect.reconcile', {reason: '  '}, 1000, 'inv-expect-9');
  assert.equal(bad.ok, false, 'an empty reason is no reconciliation');
  const rec = await a.execute('expect.reconcile', {reason: 'the suite was already red on main'}, 1000, 'inv-expect-10');
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.payload, {reconciled: true, was_blocked: true});
  const w = await a.execute('code.write', {path: 'after-reconcile.txt', content: 'y\n'}, 1000, 'inv-expect-11');
  assert.equal(w.ok, true, 'the first write after reconciling passes');
  const recs = expectKit.readWorklogEvents(a.session.id).filter(e => expectKit.eventKind(e) === 'expect-reconcile');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, 'the suite was already red on main');
});

test('stop mode: investigating with a read clears the hold', async (t) => {
  setMode(t, 'stop');
  const a = makeAgent(t);
  startTurn(a);
  fs.writeFileSync(path.join(a.cwd, 'look.txt'), 'data\n');
  await a.execute('system.run', {command: 'exit 3', expect: {exit: 0}}, 60000, 'inv-expect-12');
  const rd = await a.execute('code.read', {path: 'look.txt'}, 1000, 'inv-expect-13');
  assert.equal(rd.ok, true);
  const w = await a.execute('code.write', {path: 'after-read.txt', content: 'z\n'}, 1000, 'inv-expect-14');
  assert.equal(w.ok, true, 'a read in between releases the write');
});

test('stop mode: a hold never outlives its turn', async (t) => {
  setMode(t, 'stop');
  const a = makeAgent(t);
  startTurn(a);
  await a.execute('system.run', {command: 'exit 3', expect: {exit: 0}}, 60000, 'inv-expect-15');
  startTurn(a); // a new turn: the old hold is gone with the old turn object
  const w = await a.execute('code.write', {path: 'next-turn.txt', content: 'n\n'}, 1000, 'inv-expect-16');
  assert.equal(w.ok, true);
});

// ---------- off mode, and background starts ----------

test('off mode: expect is ignored entirely — no mark, no record', async (t) => {
  setMode(t, 'off');
  const a = makeAgent(t);
  startTurn(a);
  const r = await a.execute('system.run', {command: 'exit 3', expect: {exit: 0}}, 60000, 'inv-expect-17');
  assert.equal(r.ok, true);
  assert.equal(r.payload.expect_mismatch, undefined);
  assert.equal(expectKit.readExpectEvents(a.session.id).length, 0);
});

test('a background start is recorded as unjudged, never a miss', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const r = await a.execute('system.run', {command: 'Write-Output bg-hello', background: true, expect: {exit: 0}}, 60000, 'inv-expect-18');
  assert.equal(r.ok, true);
  assert.ok(r.payload.shell_id, 'the shell started');
  assert.equal(r.payload.expect_mismatch, undefined);
  const events = expectKit.readExpectEvents(a.session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].matched, null);
  await a.execute('shell.kill', {shell_id: r.payload.shell_id}, 1000, 'inv-expect-19');
});
