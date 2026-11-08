'use strict';
// Wave 13 (sanitize / close):
//  (1) The sanitize passes must finish in linear time on a long
//      separator-free string: worklog's SECRET_VALUE / SECRET_JSON (and
//      their focus-log mirrors, export's quoted-key rules, the standalone
//      email rule and crash's key=value rule) backtracked quadratically —
//      a 1 MB single token froze the event loop for minutes. The bounds
//      must not cost the redaction the older tests pin down.
//  (2) Agent.close() alone stops the workers (local abort + Muse-side
//      cancel, stop flag for a worker still connecting), and stopping
//      twice — cancelAll() first, as the exit path does — stays safe.
//  (3) An agent.wait refused by the per-turn tool limit says the
//      collection is unfinished and results remain, instead of reading
//      as the generic "wrap up" limit message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Self-isolation (the w13-permissions pattern): throwaway home/data
// BEFORE any src module loads.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w13-sc-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(ROOT, 'home-'));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(ROOT, 'data-'));
test.after(() => { try { fs.rmSync(ROOT, {recursive: true, force: true}); } catch {} });

const worklog = require('../src/worklog');
const focusLog = require('../src/focus-log');
const exporter = require('../src/export');
const standalone = require('../src/export-standalone');
const crash = require('../src/crash');
const {Agent, toolLimitMessage} = require('../src/agent');

// ---------- (1) sanitize: linear on long separator-free strings ----------

test('w13 sanitize (1): worklog sanitizeText is fast on a 1 MB single token and still redacts', () => {
  const inputs = [
    'a'.repeat(1024 * 1024),
    'token'.repeat(200 * 1024),
    '"' + 'token'.repeat(200 * 1024) + '" x',
    '"' + 'a'.repeat(1024 * 1024) + '" x',
  ];
  for (const input of inputs) {
    const t0 = Date.now();
    const out = worklog.sanitizeText(input);
    const ms = Date.now() - t0;
    assert.equal(out.length, input.length, 'plain text passes through unchanged');
    assert.ok(ms < 5000, 'sanitizeText took ' + ms + ' ms on ' + input.length + ' chars (quadratic before the fix)');
  }
  // The redaction the fix must keep (the features-debug / worklog canaries):
  assert.equal(worklog.sanitizeText('Authorization: Bearer q'), 'Authorization: [redacted]');
  assert.equal(worklog.sanitizeText('token counts are fine'), 'token counts are fine', 'prose is left alone');
  assert.equal(worklog.sanitizeText('MY_SECRET_VALUE=hunter2secret'), 'MY_SECRET_VALUE=[redacted]');
  assert.equal(worklog.sanitizeText('SECRET=1'), 'SECRET=[redacted]');
  assert.ok(!worklog.sanitizeText('{"token": "jsonsecretvalue123"}').includes('jsonsecretvalue123'), 'a JSON value under a secret key is redacted');
  assert.ok(!worklog.sanitizeText('api_key: hunter2').includes('hunter2'));
  assert.ok(!worklog.sanitizeText('x=1;password=hunter3').includes('hunter3'), 'a key after a separator is redacted');
  assert.ok(!worklog.sanitizeText('config.token=abc123').includes('abc123'), 'a dotted key is redacted');
});

test('w13 sanitize (1): focus-log sanitizeText (the mirror) is fast and still redacts', () => {
  const input = '"' + 'token'.repeat(40 * 1024) + '" x';
  const t0 = Date.now();
  focusLog.sanitizeText(input);
  assert.ok(Date.now() - t0 < 5000, 'focus-log sanitizeText stayed fast on a quoted keyword string');
  const t1 = Date.now();
  focusLog.sanitizeText('a'.repeat(200 * 1024));
  assert.ok(Date.now() - t1 < 5000, 'focus-log sanitizeText stayed fast on a single token');
  assert.ok(!focusLog.sanitizeText('password=hunter2-secret-value').includes('hunter2-secret-value'));
  assert.ok(!focusLog.sanitizeText('{"token": "jsonsecretvalue123"}').includes('jsonsecretvalue123'));
  assert.ok(!focusLog.sanitizeText("token='abc123xyz'").includes('abc123xyz'), 'a quoted value is redacted');
});

test('w13 sanitize (1): export / standalone / crash passes are fast on the same shapes', () => {
  const opts = {username: 'zz-no-match', homeDir: 'C:\\zz-no-match'};
  const qtok = '"' + 'token'.repeat(40 * 1024) + '" x';
  let t0 = Date.now();
  exporter.redactString(qtok, opts);
  assert.ok(Date.now() - t0 < 5000, 'export redactString stayed fast on a quoted keyword string');
  assert.ok(!exporter.redactString('cfg {"password": "v123456789"} end', opts).includes('v123456789'), 'export still redacts a quoted JSON value');
  assert.equal(exporter.redactString('mail me at alice@example.com', opts), 'mail me at <email>');
  t0 = Date.now();
  standalone.redactString('a'.repeat(200 * 1024));
  assert.ok(Date.now() - t0 < 5000, 'standalone redactString stayed fast on a single token');
  assert.equal(standalone.redactString('mail me at alice@example.com'), 'mail me at <email>', 'standalone still redacts an email');
  t0 = Date.now();
  crash.scrubSecretTextLine('a'.repeat(200 * 1024));
  assert.ok(Date.now() - t0 < 5000, 'crash scrub stayed fast on a single token');
  assert.equal(crash.scrubSecretTextLine('boom foo=bar123 now'), 'boom foo=<redacted> now', 'crash still redacts a key=value value');
});

// ---------- (2) Agent.close() stops the workers on its own ----------

function stubClient(cancels) {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async id => { cancels.push(id); };
  c.disconnect = () => {};
  return c;
}
let agentSeq = 0;
function makeAgent(t, cancels) {
  const cwd = fs.mkdtempSync(path.join(ROOT, 'proj-'));
  const a = new Agent({client: stubClient(cancels), auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'sess-w13sc-' + (++agentSeq), cwd, title: '', created: 0, updated: 0, turns: 0}, mode: 'bypass'});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  return a;
}
function fakeWorker(tag, over = {}) {
  return {tag, title: tag, by: 'muse', typeName: 'general', type: undefined, state: 'working', lastTool: '', text: '', result: '', error: '', started: 0, ended: 0, collected: false, turn: null, starting: false, stopRequested: false, main: false, session: {id: 'sess-' + tag}, ctx: null, ...over};
}

test('w13 close (2): close() alone aborts and cancels every worker, and flags a starting one', async (t) => {
  const cancels = [];
  const a = makeAgent(t, cancels);
  a.main.turn = {controller: new AbortController(), toolCalls: 0};
  const busy = fakeWorker('w13busy', {turn: {controller: new AbortController()}});
  const starting = fakeWorker('w13starting', {starting: true});
  a.workers.set('w13busy', busy);
  a.workers.set('w13starting', starting);
  a.close(); // no cancelAll first: close() itself must do the stopping
  assert.equal(a.main.turn.controller.signal.aborted, true, 'the main turn is aborted locally');
  assert.equal(busy.turn.controller.signal.aborted, true, 'the worker turn is aborted locally');
  assert.equal(starting.stopRequested, true, 'a still-connecting worker gets the stop flag');
  await new Promise(r => setImmediate(r));
  assert.ok(cancels.includes('sess-w13busy'), 'the worker is cancelled on Muse\'s side: ' + cancels.join(','));
  assert.ok(cancels.includes(a.session.id), 'the main session is cancelled on Muse\'s side');
});

test('w13 close (2): cancelAll() then close() (the exit path) stops twice without harm', async (t) => {
  const cancels = [];
  const a = makeAgent(t, cancels);
  a.main.turn = {controller: new AbortController(), toolCalls: 0};
  const busy = fakeWorker('w13busy2', {turn: {controller: new AbortController()}});
  a.workers.set('w13busy2', busy);
  await a.cancelAll(50);
  assert.doesNotThrow(() => a.close(), 'close after cancelAll does not throw');
  assert.doesNotThrow(() => a.close(), 'a second close does not throw either');
  assert.equal(busy.turn.controller.signal.aborted, true);
});

// ---------- (3) agent.wait refused by the tool limit ----------

test('w13 agent.wait (3): a tool-limit refusal says the collection is unfinished and results remain', async (t) => {
  const cancels = [];
  const a = makeAgent(t, cancels);
  a.maxToolCallsPerTurn = 1;
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 1};
  const done = fakeWorker('w13done', {state: 'done', result: 'the finished report', resultOffset: 0});
  a.workers.set('w13done', done);
  const r = await a.executeAgentTool(a.main, 'agent.wait', {timeout_s: 0});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('回収は途中'), 'the refusal says the collection is in the middle, got: ' + r.error);
  assert.ok(r.error.includes('未回収の結果が残っている'), 'the refusal says uncollected results remain');
  assert.equal(done.resultOffset, 0, 'nothing was collected by the refused wait');
  assert.equal(done.collected, false, 'the worker was not marked collected');
  const r2 = await a.executeAgentTool(a.main, 'agent.spawn', {task: 'x'});
  assert.equal(r2.ok, false);
  assert.equal(r2.error, toolLimitMessage(1), 'other agent tools keep the generic limit message');
});
