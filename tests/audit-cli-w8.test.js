'use strict';
// audit-cli wave 8 regression tests for the wave-8 fixes:
//  (1) expect: test counts are read exactly as proof reads them —
//      "pass 128\nfail 0" matches {tests:'pass'} (the label-first shape
//      wins, no count is borrowed across a newline), "pass 0 / fail 0"
//      does NOT match (no test passed), a one-sided summary stays
//      unjudged instead of fabricating the missing side as 0, and the
//      colon / dotnet shapes read.
//  (2) proof badge: a test run followed by a file-changing system.run is
//      stale evidence (?), not a backing (✓); a deletion claim is backed
//      only by a deletion record — an ordinary edit to the same path
//      contradicts it (✗), while it still backs an ordinary claim.
//  (3) focus: restoring a saved state whose 'met' criterion cites expired
//      evidence demotes that criterion to pending and the task back to
//      running; a 'met' on still-current evidence survives the restore.
//  (4) agent: a failed worker read through agent.wait is collected and
//      pruned on the next wait (every terminal state, not only done),
//      and timeout_s: 0 polls once and returns at once.
//  (5) tell: a file spelled as a local admin-share UNC path and spelled
//      as a plain drive path get the SAME fileKey, so a claim cannot be
//      dodged by respelling the path.
//  (6) shells/tools: a >260-char cwd makes system.run resolve with a
//      worded failure and code.grep reject with a worded error — neither
//      takes the host process down; a grep whose rg output passes the
//      cap reports truncated + matches_at_least (a lower bound), never
//      the partial count as the exact total.
//  (7) OTP: normalizeOtpCode accepts only exactly 6 digits (fullwidth
//      digits and copy-paste spaces/hyphens are normalised), and a
//      malformed code never reaches confirm_otp in a real pcLogin run —
//      it is re-asked in words without spending a server try.
// Isolation follows tests/setup.mjs; like tests/audit-cli-w7.test.js this
// file also pins its own temp HOME / LOCALAPPDATA before requiring any
// src module, because several src modules resolve their files at require
// time. All canaries are fake W8* values; the fake web is the
// setup-contact.test.js shape and never leaves this process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

const NL = String.fromCharCode(10);
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w8-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w8-test-home-'));

const expectKit = require('../src/expect');
const badge = require('../src/proof/badge');
const {Focus} = require('../src/focus');
const {Agent, pruneCollectedWorkers} = require('../src/agent');
const tell = require('../src/tell');
const {TOOLS} = require('../src/tools');
const {runOnce} = require('../src/shells');
const {PcAuth, normalizeOtpCode} = require('../src/core/pc-auth');
const {pcLogin, contactFileFor} = require('../src/pc-login');

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'muser-w8-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// ---------- (1) expect ----------

test('w8 expect (1): "pass 128\\nfail 0" reads as {128, 0} and matches {tests: pass}', () => {
  assert.deepEqual(expectKit.testCounts('pass 128' + NL + 'fail 0'), {pass: 128, fail: 0},
    'the label-first shape wins: fail must not borrow the 128 from the line above (the old cross-line grab judged this all-pass run a failure)');
  assert.deepEqual(expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'pass 128' + NL + 'fail 0'}),
    {matched: true, actual: 'pass 128 / fail 0'});
  assert.deepEqual(expectKit.testCounts('pass 0' + NL + 'fail 3'), {pass: 0, fail: 3}, 'the mirror image reads straight too');
  assert.equal(expectKit.evaluateExpect({tests: 'pass'}, {exit: 1, output: 'pass 0' + NL + 'fail 3'}).matched, false);
  assert.equal(expectKit.evaluateExpect({tests: 'fail'}, {exit: 1, output: 'pass 0' + NL + 'fail 3'}).matched, true);
});

test('w8 expect (1): "pass 0 / fail 0" does not match {tests: pass} — no test passed', () => {
  assert.deepEqual(expectKit.testCounts('pass 0' + NL + 'fail 0'), {pass: 0, fail: 0});
  assert.deepEqual(expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'pass 0' + NL + 'fail 0'}),
    {matched: false, actual: 'pass 0 / fail 0'}, 'zero passes is a mismatch, not a pass');
  assert.equal(expectKit.evaluateExpect({tests: 'fail'}, {exit: 0, output: 'pass 0' + NL + 'fail 0'}).matched, false,
    'and it is not a failure either: no test failed');
});

test('w8 expect (1): the colon form and the dotnet form read like proof reads them', () => {
  assert.deepEqual(expectKit.testCounts('pass: 128 / fail: 0'), {pass: 128, fail: 0});
  assert.equal(expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'pass: 128 / fail: 0'}).matched, true);
  const dotnet = 'Passed!  - Failed:     0, Passed:   128, Skipped:     0, Total:   128, Duration: 12 ms';
  assert.deepEqual(expectKit.testCounts(dotnet), {pass: 128, fail: 0}, 'dotnet "Passed: N / Failed: N" is the same label-first shape');
  assert.deepEqual(badge.parseTestCounts(dotnet), {pass: 128, fail: 0}, 'proof reads the same counts from the same output');
  assert.equal(expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: dotnet}).matched, true);
});

test('w8 expect (1): a one-sided summary stays unjudged — the missing side is not fabricated as 0', () => {
  const failOnly = expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: 'fail 0'});
  assert.equal(failOnly.matched, null, '"fail 0" alone says nothing about how many passed (maybe none ran)');
  assert.equal(failOnly.actual, 'fail 0', 'the display shows only the count that was actually read');
  const passOnly = expectKit.evaluateExpect({tests: 'pass'}, {exit: 0, output: '10 passing (5ms)'});
  assert.equal(passOnly.matched, null, '"10 passing" alone says nothing about failures');
  assert.equal(passOnly.actual, 'pass 10');
});

// ---------- (2) proof badge ----------

const testRunEvent = output => ({type: 'tool', command: 'system.run', summary: 'npm test', output});
const genRunEvent = () => ({type: 'tool', command: 'system.run', summary: 'node gen.js', params: {command: 'node gen.js'}, output: 'generated'});

test('w8 proof (2): a file-changing system.run after the test run makes its counts stale evidence', () => {
  const claim = {kind: 'test', pass: 128, fail: 0, allPassed: true};
  const fresh = badge.judge(claim, {events: [testRunEvent('pass 128' + NL + 'fail 0')], edits: [], tools: []});
  assert.equal(fresh.mark, '✓', 'control: the same run with nothing after it backs the claim');
  const stale = badge.judge(claim, {events: [testRunEvent('pass 128' + NL + 'fail 0'), genRunEvent()], edits: [], tools: []});
  assert.equal(stale.mark, '?', 'a generator run after the tests is a change: the counts predate the final state');
  assert.match(stale.reason, /最後の変更より前なので古い証拠です/);
});

test('w8 proof (2): a deletion claim is backed only by a deletion record', () => {
  const claim = {kind: 'file', files: ['src/gone.js'], op: 'delete'};
  const editedOnly = badge.judge(claim, {events: [], edits: [{path: 'src/gone.js', op: 'edit'}], tools: []});
  assert.equal(editedOnly.mark, '✗', 'an ordinary edit to the same path does not back "削除しました"');
  assert.match(editedOnly.reason, /削除記録がありません/);
  const deleted = badge.judge(claim, {events: [], edits: [{path: 'src/gone.js', op: 'delete'}], tools: []});
  assert.equal(deleted.mark, '✓', 'a deletion record for the path backs it');
  const ordinary = badge.judge({kind: 'file', files: ['src/gone.js']}, {events: [], edits: [{path: 'src/gone.js', op: 'edit'}], tools: []});
  assert.equal(ordinary.mark, '✓', 'control: an ordinary change claim is still backed by any recorded change to the path');
});

// ---------- (3) focus restore ----------

function focusState({revision, changes, evidenceRevision}) {
  return {v: 1, goal: 'w8 restore goal', status: 'complete', criteriaAllMet: true, revision, changes,
    criteria: [{id: 'c1', text: 'the thing is verified', kind: 'inspection', status: 'met', evidence: ['e1']}],
    evidence: [{id: 'e1', command: 'code.read', revision: evidenceRevision, usable: true, ok: true, paths: ['src/a.js']}]};
}

test('w8 focus (3): restore demotes a met whose cited evidence has expired back to pending', () => {
  // Evidence read at revision 1; a later change at revision 2 touched the
  // very path it covers, so at the saved revision 2 it no longer stands.
  const f = Focus.restore(focusState({revision: 2, changes: [{revision: 2, paths: ['src/a.js']}], evidenceRevision: 1}));
  assert.equal(f.criteria[0].status, 'pending', 'the expired met does not survive the restore');
  assert.deepEqual(f.criteria[0].evidence, [], 'the demoted criterion cites nothing');
  assert.equal(f.criteriaAllMet, false);
  assert.equal(f.status, 'running', 'a task demoted on restore is not complete');
});

test('w8 focus (3): restore keeps a met whose evidence is still current', () => {
  const f = Focus.restore(focusState({revision: 1, changes: [], evidenceRevision: 1}));
  assert.equal(f.criteria[0].status, 'met', 'control: fresh evidence restores as met');
  assert.equal(f.criteriaAllMet, true);
  assert.equal(f.status, 'complete');
});

// ---------- (4) agent workers ----------

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
function makeAgent(t) {
  const cwd = tmpdir(t, 'muser-w8-agent-');
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'sess-w8-' + (++agentSeq), cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'bypass'});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  return a;
}
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
  return a.main.turn;
}
function fakeWorker(tag, over = {}) {
  return {tag, title: tag, by: 'muse', typeName: 'general', type: undefined, state: 'idle', lastTool: '', text: '', result: '', error: '', started: 0, ended: 0, collected: false, turn: null, main: tag === 'main', session: {id: 'sess-' + tag}, ctx: null, ...over};
}

test('w8 agent (4): a failed worker read through wait is collected, then pruned on the next wait', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const failed = fakeWorker('w8f', {state: 'failed', error: 'boom W8', ended: Date.now()});
  a.workers.set('w8f', failed);
  const r1 = await a.executeAgentTool(a.main, 'agent.wait', {timeout_s: 1});
  assert.equal(r1.ok, true);
  const row = r1.payload.agents.find(x => x.tag === 'w8f');
  assert.ok(row, 'the failed worker is reported by the wait that reads it');
  assert.equal(row.state, 'failed');
  assert.equal(row.error, 'boom W8');
  assert.equal(failed.collected, true, 'reading a failed worker collects it, like a done one');
  assert.ok(a.workers.has('w8f'), 'pruning happens on the NEXT wait, not mid-collection');
  const r2 = await a.executeAgentTool(a.main, 'agent.wait', {timeout_s: 1});
  assert.ok(!r2.payload.agents.some(x => x.tag === 'w8f'), 'the collected failed worker is gone from the next wait');
  assert.ok(!a.workers.has('w8f'), 'and pruned from the worker map');
});

test('w8 agent (4): pruneCollectedWorkers prunes every collected terminal state, and nothing else', () => {
  const workers = new Map([
    ['main', fakeWorker('main', {state: 'done', collected: true})],
    ['w8done', fakeWorker('w8done', {state: 'done', collected: true})],
    ['w8fail', fakeWorker('w8fail', {state: 'failed', collected: true})],
    ['w8stop', fakeWorker('w8stop', {state: 'stopped', collected: true})],
    ['w8unread', fakeWorker('w8unread', {state: 'failed', collected: false})],
    ['w8busy', fakeWorker('w8busy', {state: 'failed', collected: true, turn: {controller: new AbortController()}})],
  ]);
  pruneCollectedWorkers(workers);
  assert.deepEqual([...workers.keys()].sort(), ['main', 'w8busy', 'w8unread'],
    'done/failed/stopped all prune once collected; main, an unread failure and a still-running worker stay');
});

test('w8 agent (4): timeout_s 0 polls once and returns at once', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const busy = fakeWorker('w8busy', {state: 'working', turn: {controller: new AbortController()}});
  a.workers.set('w8busy', busy);
  const started = Date.now();
  const r = await a.executeAgentTool(a.main, 'agent.wait', {timeout_s: 0});
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  assert.equal(r.payload.timeout_s, 0, 'the result reports the effective timeout: an explicit 0 is not turned into the 60 s default');
  assert.ok(elapsed < 5000, 'timeout_s 0 returned at once, not after a wait (' + elapsed + ' ms)');
  const row = r.payload.agents.find(x => x.tag === 'w8busy');
  assert.ok(row, 'the poll still reports the current state');
  assert.equal(row.state, 'working');
});

// ---------- (5) tell fileKey ----------

test('w8 tell (5): the UNC admin-share spelling and the plain spelling get the same fileKey', (t) => {
  const dir = tmpdir(t, 'muser-w8-tell-');
  const file = path.join(dir, 'shared.txt');
  fs.writeFileSync(file, 'w8' + NL);
  const plain = tell.fileKey(file, dir);
  const uncSpelling = '\\\\localhost\\' + file[0] + '$' + file.slice(2);
  const unc = tell.fileKey(uncSpelling, dir);
  assert.equal(unc.key, plain.key, 'one file, one key, however spelled: a claim made under one spelling collides with the other');
  assert.equal(unc.path, plain.path, 'both spellings canonicalise to the same file');
  const other = tell.fileKey(path.join(dir, 'other.txt'), dir);
  assert.notEqual(other.key, plain.key, 'control: a different file keys differently');
});

// ---------- (6) shells / tools ----------

function longDir(t) {
  const base = tmpdir(t, 'muser-w8-long-');
  let dir = base;
  const seg = 'd'.repeat(36);
  while (dir.length < 290) dir = path.join(dir, seg);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

test('w8 shells (6): a >260-char cwd resolves system.run as a worded failure, not a process crash', async (t) => {
  const dir = longDir(t);
  assert.ok(dir.length > 260, 'fixture: the cwd is past the classic limit (' + dir.length + ' chars)');
  const r = await runOnce('Write-Output w8hi', {cwd: dir, timeout: 15000});
  assert.equal(r.code, -1, 'the run resolves with a failure code instead of taking the host down with an unhandled stdio error');
  assert.match(String(r.stderr), /spawn|ENO/, 'the failure is worded: ' + r.stderr);
});

test('w8 tools (6): a >260-char cwd rejects code.grep with a worded error, not a process crash', async (t) => {
  const dir = longDir(t);
  const ctx = {cwd: dir, readFiles: new Set()};
  await assert.rejects(TOOLS['code.grep'].run({pattern: 'w8needle'}, ctx), /ripgrep \(rg\) could not run/,
    'the spawn failure reaches the caller as words');
});

test('w8 tools (6): a grep past the output cap reports a truncated lower bound, not the partial count as exact', async (t) => {
  const dir = tmpdir(t, 'muser-w8-grep-');
  const total = 90000;
  const line = 'needle ' + 'x'.repeat(470) + NL; // ~430 output chars per hit after rg's column cap: 90k hits pass the 32 MB cap
  fs.writeFileSync(path.join(dir, 'big.txt'), line.repeat(total));
  const ctx = {cwd: dir, readFiles: new Set()};
  const r = await TOOLS['code.grep'].run({pattern: 'needle'}, ctx);
  assert.equal(r.payload.truncated, true, 'the result says it was cut');
  assert.equal(r.payload.matches_at_least, r.payload.matches, 'the count is labelled a lower bound');
  assert.ok(r.payload.matches > 0 && r.payload.matches < total,
    'the partial count (' + r.payload.matches + ') is below the true total (' + total + '), and is not presented as it');
});

// ---------- (7) OTP ----------

test('w8 otp (7): normalizeOtpCode accepts only exactly 6 digits, normalising typing variants', () => {
  assert.equal(normalizeOtpCode('123456'), '123456');
  assert.equal(normalizeOtpCode('１２３４５６'), '123456', 'fullwidth digits become halfwidth');
  assert.equal(normalizeOtpCode('123 456'), '123456', 'copy-paste spaces are dropped');
  assert.equal(normalizeOtpCode('12-34-56'), '123456', 'copy-paste hyphens are dropped');
  for (const bad of ['12', 'abcdef', '', '12345678', '12345a', 123456, null, undefined])
    assert.equal(normalizeOtpCode(bad), null, JSON.stringify(bad) + ' is not a 6-digit code');
});

test('w8 otp (7): PcAuth refuses a malformed code locally — no request is made', async () => {
  let requests = 0;
  const auth = new PcAuth({load: () => ({}), save: () => {}, request: async () => { requests++; return {}; }});
  assert.equal(auth.code('１２３４５６'), '123456', 'code() returns the normalised code for a typing variant');
  assert.throws(() => auth.code('12'), e => e && e.codeFormat === true, 'a short code is a marked format error');
  await assert.rejects(auth.confirm('abcdef'), e => e && e.codeFormat === true,
    'confirm() validates before it acts: the format error surfaces as-is');
  assert.equal(requests, 0, 'no server request was made for either malformed code');
});

// A Map-backed secure-store and a fake muse.ai web, in the
// setup-contact.test.js shape.
function fakeStore() {
  const map = new Map();
  return {map,
    load(name) { return map.has(name) ? structuredClone(map.get(name)) : null; },
    save(name, value) { map.set(name, structuredClone(value)); },
    remove(name) { map.delete(name); },
    file(name) { return name; }};
}
function loginWeb() {
  const counts = {confirm_otp: 0, send_otp: 0};
  const codes = [];
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route, body) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) { counts.send_otp++; return {auth_state: 'as'}; }
      if (route.endsWith('/confirm_otp')) { counts.confirm_otp++; codes.push(body && body.otp_code); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/select_account')) return {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/two_factor/send_code')) return {};
      if (route.endsWith('/two_factor')) return {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
      if (route.endsWith('/fetch_vms')) return {vm_list: []};
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  return {web, counts, codes};
}
function loginUi(answers) {
  const infos = [];
  const ui = {note: () => {}, info: s => infos.push(s), close() { this.closed = true; },
    confirm: async () => true, pick: async () => 0, busy: async (_l, fn) => fn(),
    ask: async q => { const v = answers.shift(); if (v === undefined) throw new Error('no scripted answer for: ' + q); return v; }};
  return {ui, infos};
}

test('w8 otp (7): malformed codes in a real pcLogin never reach confirm_otp and spend no try', async () => {
  const store = fakeStore();
  const file = 'w8-otp/device.enc';
  const {web, counts, codes} = loginWeb();
  // Four malformed codes first (short / letters / empty / 8 digits), then
  // the right code typed in fullwidth digits. If a malformed code spent a
  // try, three of them would already have ended the login.
  const {ui, infos} = loginUi(['w8@example.com', '12', 'abcdef', '', '12345678', '１２３４５６']);
  const auth = await pcLogin(web, ui, {file, store});
  assert.equal(auth.snapshot().phase, 'authenticated', 'the login still succeeds after four format slips');
  assert.equal(counts.confirm_otp, 1, 'confirm_otp was called exactly once: only the well-formed code reached the server');
  assert.deepEqual(codes, ['123456'], 'and it arrived normalised (fullwidth -> halfwidth)');
  assert.equal(infos.filter(s => s.includes('6桁')).length, 4, 'each malformed code was re-asked in words');
  assert.ok(store.map.has(contactFileFor(file)), 'the proven contact was remembered as usual');
});
