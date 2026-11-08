'use strict';
// Focus weakness 9 (2026-11-06): the decision log — every Focus decision
// leaves a why line in %LOCALAPPDATA%\muser\logs\<session>.jsonl, local
// only, with secrets never recorded. The tests below cover the log itself,
// the Focus lines for each decision, the agent-side lines (wait / retry /
// error / auto-continuation), the `muser log` command and the /settings level.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {spawnSync} = require('node:child_process');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-log-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-log-home-'));

const {FocusLog, logFile} = require('../src/focus-log');
const {Focus} = require('../src/focus');
const {Agent} = require('../src/agent');
const {focusLogLevel, setFocusLogLevel} = require('../src/settings');

function tmpdir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-log-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
const read = p => ({command: 'code.read', kind: 'read', params: {path: p}, summary: p});
const run = (cmd, extra = {}) => ({command: 'system.run', kind: 'exec', params: {command: cmd, ...extra}, summary: cmd});
const ok0 = {ok: true, payload: {exit_code: 0}};
const insp = text => ({text, kind: 'inspection'});
const met = (id, evidence, reason = 'ok') => ({id, status: 'met', evidence, reason});
function makeFocus(t, {level = 'normal', maxRounds = 10} = {}) {
  const dir = tmpdir(t);
  const logger = new FocusLog({sessionId: 's1', level, dir});
  const f = new Focus('t', {maxRounds, logger, sessionId: 's1', sessionCwd: dir});
  return {f, logger, dir};
}
const entries = logger => FocusLog.readFile(logger.file());
const find = (logger, event, decision) => entries(logger).find(e => e.event === event && (!decision || e.decision === decision));

test('weakness 9: append writes one JSON line with the common fields', t => {
  const dir = tmpdir(t);
  const log = new FocusLog({sessionId: 's1', dir});
  const e = log.append('observe', {focus: 'f123456789', leg: 1, round: 2, decision: 'no_change', why: 'read_only:get-content', detail: {command: 'Get-Content a.js'}, ref: 'e1', intent: 'read the file first'});
  assert.equal(e.event, 'observe');
  const lines = fs.readFileSync(log.file(), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const got = JSON.parse(lines[0]);
  assert.equal(got.session, 's1');
  assert.equal(got.focus, 'f123456789');
  assert.equal(got.leg, 1);
  assert.equal(got.round, 2);
  assert.equal(got.decision, 'no_change');
  assert.equal(got.why, 'read_only:get-content');
  assert.deepEqual(got.detail, {command: 'Get-Content a.js'});
  assert.equal(got.ref, 'e1');
  assert.equal(got.intent, 'read the file first');
  assert.ok(Date.parse(got.at), 'at is an ISO time');
});

test('weakness 9: level off records nothing', t => {
  const dir = tmpdir(t);
  const log = new FocusLog({sessionId: 's1', level: 'off', dir});
  assert.equal(log.append('observe', {decision: 'no_change', why: 'x'}), null);
  assert.equal(fs.existsSync(log.file()), false);
});

test('weakness 9: normal drops params and result, verbose keeps them', t => {
  const dir = tmpdir(t);
  const normal = new FocusLog({sessionId: 'n1', level: 'normal', dir});
  normal.append('observe', {decision: 'no_change', why: 'x', params: {command: 'ls'}, result: {ok: true}});
  const n = entries(normal)[0];
  assert.equal('params' in n, false);
  assert.equal('result' in n, false);
  const verbose = new FocusLog({sessionId: 'v1', level: 'verbose', dir});
  verbose.append('observe', {decision: 'no_change', why: 'x', params: {command: 'ls'}, result: {ok: true}});
  const v = entries(verbose)[0];
  assert.deepEqual(v.params, {command: 'ls'});
  assert.deepEqual(v.result, {ok: true});
});

test('weakness 9: verbose still records no secrets', t => {
  const dir = tmpdir(t);
  const log = new FocusLog({sessionId: 's1', level: 'verbose', dir});
  log.append('observe', {
    decision: 'no_change', why: 'x',
    detail: {password: 'hunter2-secret-value', token: 'tok-abc123-secret', note: 'Authorization: Bearer xyz-secret-value', cookie: 'session=abc-secret-value', path: 'vault.enc', content: 'enc-secret-value'},
    params: {command: 'curl -H "Authorization: Bearer xyz-secret-value" https://example.invalid', apiKey: 'key-secret-value'},
    result: {output: 'password=hunter2-secret-value'},
  });
  const raw = fs.readFileSync(log.file(), 'utf8');
  for (const secret of ['hunter2-secret-value', 'tok-abc123-secret', 'xyz-secret-value', 'abc-secret-value', 'key-secret-value', 'enc-secret-value'])
    assert.equal(raw.includes(secret), false, secret + ' must not be in the log');
  assert.ok(raw.includes('[redacted]'), 'redactions are visible');
  assert.ok(raw.includes('vault.enc'), 'the .enc path itself stays; only its content is redacted');
});

test('weakness 9: a long value keeps its head and its length', t => {
  const dir = tmpdir(t);
  const log = new FocusLog({sessionId: 's1', dir});
  log.append('observe', {decision: 'no_change', why: 'x', detail: {output: 'x'.repeat(2000)}});
  const kept = entries(log)[0].detail.output;
  assert.ok(kept.startsWith('x'.repeat(500)));
  assert.ok(kept.includes('… (2000 chars)'));
  assert.ok(kept.length < 600);
});

test('weakness 9: the per-file cap drops the oldest lines first', t => {
  const dir = tmpdir(t);
  const log = new FocusLog({sessionId: 's1', dir, maxLines: 5});
  for (let i = 0; i < 7; i++) log.append('observe', {decision: 'e' + i, why: 'x'});
  const got = entries(log);
  assert.equal(got.length, 5);
  assert.deepEqual(got.map(e => e.decision), ['e2', 'e3', 'e4', 'e5', 'e6']);
});

test('weakness 9: the total cap drops the oldest files first, never this session', t => {
  const dir = tmpdir(t);
  const oldLog = new FocusLog({sessionId: 'old', dir, maxTotalBytes: 400});
  oldLog.append('observe', {decision: 'old', why: 'x', detail: {pad: 'x'.repeat(200)}});
  fs.utimesSync(oldLog.file(), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const newLog = new FocusLog({sessionId: 'new', dir, maxTotalBytes: 400});
  newLog.append('observe', {decision: 'new', why: 'x', detail: {pad: 'y'.repeat(200)}});
  assert.equal(fs.existsSync(oldLog.file()), false, 'the oldest file is dropped');
  assert.equal(fs.existsSync(newLog.file()), true, 'this session keeps its file');
});

test('weakness 9: readFile filters by focus prefix, why and event, and limit keeps the last lines', t => {
  const dir = tmpdir(t);
  const log = new FocusLog({sessionId: 's1', dir});
  log.append('observe', {focus: 'fAAAA1111', decision: 'd1', why: 'w1'});
  log.append('observe', {focus: 'fBBBB2222', decision: 'd2', why: 'w2'});
  log.append('end_round', {focus: 'fAAAA1111', decision: 'complete', why: 'all_met'});
  log.append('observe', {focus: 'fAAAA1111', decision: 'd3', why: 'w1'});
  fs.appendFileSync(log.file(), 'not json\n');
  const file = log.file();
  assert.deepEqual(FocusLog.readFile(file, {focus: 'fAAA'}).map(e => e.decision), ['d1', 'complete', 'd3']);
  assert.deepEqual(FocusLog.readFile(file, {why: 'w1'}).map(e => e.decision), ['d1', 'd3']);
  assert.deepEqual(FocusLog.readFile(file, {event: 'end_round'}).map(e => e.decision), ['complete']);
  assert.deepEqual(FocusLog.readFile(file, {limit: 2}).map(e => e.decision), ['complete', 'd3']);
  assert.deepEqual(FocusLog.readFile(path.join(dir, 'missing.jsonl')), []);
});

test('weakness 9: format renders one readable line per entry', () => {
  const lines = FocusLog.format([{at: '2026-11-06T00:00:00.000Z', event: 'end_round', decision: 'complete', why: 'all_met', focus: 'f123456789', round: 2, detail: {met: 2}, intent: 'finish it'}]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('end_round'));
  assert.ok(lines[0].includes('complete'));
  assert.ok(lines[0].includes('all_met'));
  assert.ok(lines[0].includes('focus f1234567'));
  assert.ok(lines[0].includes('round 2'));
  assert.ok(lines[0].includes('intent: finish it'));
});

test('weakness 9: endRound logs complete with all_met', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('a.js has X'), insp('b.js has Y')]);
  const e1 = f.observe(read('a.js'), {ok: true}), e2 = f.observe(read('b.js'), {ok: true});
  f.checkpoint([met('c1', [e1]), met('c2', [e2])]);
  assert.equal(f.endRound().status, 'complete');
  const line = find(logger, 'end_round');
  assert.equal(line.decision, 'complete');
  assert.equal(line.why, 'all_met');
  assert.equal(line.detail.met, 2);
  assert.equal(line.detail.unmet, 0);
});

test('weakness 9: endRound logs a question with awaiting_user_answer', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound();
  f.askUser('which one?');
  assert.equal(f.endRound().status, 'needs_input');
  const line = find(logger, 'end_round');
  assert.equal(line.decision, 'needs_input');
  assert.equal(line.why, 'awaiting_user_answer');
});

test('weakness 9: endRound logs unfinished work with unmet_left', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('find the bug')]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]);
  assert.equal(f.endRound().status, 'running');
  const line = find(logger, 'end_round');
  assert.equal(line.decision, 'running');
  assert.equal(line.why, 'unmet_left');
  assert.equal(line.detail.unmet, 1);
});

test('weakness 9: endRound logs stalled with stalled_no_progress', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('find bug')]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]); f.endRound();
  f.beginRound(); f.observe(run('Select-String -Path x.js -Pattern foo'), ok0);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]);
  assert.equal(f.endRound().status, 'stalled');
  const line = find(logger, 'end_round', 'stalled');
  assert.equal(line.why, 'stalled_no_progress');
  assert.equal(line.detail.stalled, 1);
});

test('weakness 9: endRound logs the round limit with round_limit', t => {
  const {f, logger} = makeFocus(t, {maxRounds: 1});
  f.beginRound(); f.plan([insp('find the bug')]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]);
  assert.equal(f.endRound().status, 'limit');
  const line = find(logger, 'end_round');
  assert.equal(line.decision, 'limit');
  assert.equal(line.why, 'round_limit');
  assert.equal(line.detail.round, 1);
  assert.equal(line.detail.maxRounds, 1);
});

test('weakness 9: endRound logs no criteria with no_criteria', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound();
  assert.equal(f.endRound().status, 'inactive');
  const line = find(logger, 'end_round');
  assert.equal(line.decision, 'inactive');
  assert.equal(line.why, 'no_criteria');
});

test('weakness 9: endRound logs a worker wait with workers_pending', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('find the bug')]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: 'looking'}]);
  assert.equal(f.endRound({workersPending: true}).status, 'running');
  const line = find(logger, 'end_round');
  assert.equal(line.decision, 'running');
  assert.equal(line.why, 'workers_pending');
  assert.equal(line.detail.workersPending, true);
});

test('weakness 9: a checkpoint rejection logs the wording and its why', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('a.js has X')]);
  const proof = f.observe(read('a.js'), {ok: true});
  f.checkpoint([met('c1', [proof])]);
  f.observe(run('Set-Content a.js -Value x'), ok0);
  assert.throws(() => f.checkpoint([met('c1', [proof])]), /out of date/);
  const rejected = entries(logger).find(e => e.event === 'focus_tool' && e.decision === 'rejected');
  assert.ok(rejected, 'a rejected focus_tool line exists');
  assert.equal(rejected.why, 'evidence_out_of_date');
  assert.ok(rejected.detail.error.includes('out of date'), 'the rejection wording itself is recorded');
  assert.equal(rejected.detail.results[0].id, 'c1');
  const accepted = entries(logger).find(e => e.event === 'focus_tool' && e.decision === 'accepted' && e.detail.tool === 'focus.checkpoint');
  assert.equal(accepted.detail.results[0].reason, 'ok', 'the checkpoint reason is recorded');
});

test('weakness 9: evidence expiry names the criteria, the evidence and the change', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('a.js has X'), insp('b.js has Y')]);
  const e1 = f.observe(read('a.js'), {ok: true}), e2 = f.observe(read('b.js'), {ok: true});
  f.checkpoint([met('c1', [e1]), met('c2', [e2])]);
  // A code.edit names its file, so only the a.js criterion reverts (a shell
  // edit of unknown scope would revert both — see the repro trace below).
  f.observe({command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true});
  assert.equal(f.criteria[0].status, 'pending');
  assert.equal(f.criteria[1].status, 'met');
  const line = find(logger, 'evidence_expired');
  assert.ok(line, 'an evidence_expired line exists');
  assert.equal(line.decision, 'criteria_reset');
  assert.equal(line.why, 'classified_change:edit');
  assert.deepEqual(line.detail.criteria, ['c1']);
  assert.deepEqual(line.detail.evidence, [e1]);
  assert.equal(line.detail.change.command, 'code.edit');
  assert.deepEqual(line.detail.change.paths, ['a.js']);
});

test('weakness 9: observe lines name the rule: read-only, tree-neutral, classified change', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('a.js has X')]);
  const rev = f.revision;
  f.observe(run('Get-Content a.js'), ok0);
  f.observe(run('git commit -m x'), ok0);
  f.observe(run('Set-Content a.js -Value x'), ok0);
  const lines = entries(logger).filter(e => e.event === 'observe');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].why, 'read_only:get-content');
  assert.equal(lines[0].decision, 'no_change');
  assert.equal(lines[1].why, 'tree_neutral:commit');
  assert.equal(lines[1].decision, 'tree_neutral');
  assert.equal(lines[2].why, 'classified_change:not_allowlisted');
  assert.equal(lines[2].decision, 'change');
  assert.equal(f.revision, rev + 2, 'the commit and the edit each advance the revision');
});

test('weakness 9: a blocked stop leaves a why line', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('find the bug')]);
  f.stop('blocked', 'no progress possible');
  const line = find(logger, 'stop');
  assert.equal(line.decision, 'blocked');
  assert.equal(line.why, 'blocked');
  assert.ok(line.detail.reason.includes('no progress possible'));
});

test('weakness 9: Muse intent rides on the observe line', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('a.js has X')]);
  const call = run('Get-Content a.js');
  call.intent = 'read a.js to check X';
  f.observe(call, ok0);
  const line = find(logger, 'observe');
  assert.equal(line.intent, 'read a.js to check X');
});

test('weakness 9 (repro trace): the item-1 repro is traceable in the log', t => {
  const {f, logger} = makeFocus(t);
  f.beginRound(); f.plan([insp('a.js has X'), insp('b.js has Y')]);
  const e1 = f.observe(read('a.js'), {ok: true}), e2 = f.observe(read('b.js'), {ok: true});
  f.checkpoint([met('c1', [e1]), met('c2', [e2])]);
  f.observe(run('Get-Content a.js'), ok0);
  assert.deepEqual(f.criteria.map(c => c.status), ['met', 'met'], 'the read leaves both met');
  f.observe(run('Set-Content a.js -Value x'), ok0);
  // A shell edit is of unknown scope, so both criteria revert — the log says
  // which ones, and by which rule (a code.edit would revert only a.js).
  assert.deepEqual(f.criteria.map(c => c.status), ['pending', 'pending'], 'the edit reverts both criteria');
  const got = FocusLog.readFile(logger.file());
  const readLine = got.find(e => e.event === 'observe' && e.why === 'read_only:get-content');
  assert.ok(readLine, 'the read-only rule is on the log');
  const expired = got.find(e => e.event === 'evidence_expired');
  assert.deepEqual(expired.detail.criteria, ['c1', 'c2']);
  assert.deepEqual(expired.detail.evidence, [e1, e2]);
  assert.equal(expired.detail.change.command, 'Set-Content a.js -Value x');
  const text = FocusLog.format(got).join('\n');
  assert.ok(text.includes('read_only:get-content'));
  assert.ok(text.includes('classified_change:not_allowlisted'));
  assert.ok(text.includes('c1'));
});

test('weakness 9: the log level is a setting, normal by default', () => {
  assert.equal(focusLogLevel(), 'normal');
  setFocusLogLevel('verbose', {save: false});
  assert.equal(focusLogLevel(), 'verbose');
  setFocusLogLevel('off', {save: false});
  assert.equal(focusLogLevel(), 'off');
  assert.throws(() => setFocusLogLevel('bogus', {save: false}), /Unknown focus log level/);
  setFocusLogLevel('normal', {save: false});
});

function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t) {
  const cwd = tmpdir(t);
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id: 's1', cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  if (t) t.after(() => { try { a.close(); } catch {} });
  return a;
}
function pendingWorker(a, focus, ms) {
  const wk = {tag: 'a1', main: false, focusTask: focus, turn: {}, starting: false};
  a.workers.set('a1', wk);
  if (ms != null) setTimeout(() => { wk.turn = null; }, ms);
  return wk;
}
const agentLog = () => FocusLog.readFile(logFile('s1'));

test('weakness 9: a worker wait leaves a wait line', async t => {
  const a = makeAgent(t);
  let round = 0;
  a.runTurn = async (w, input, opts) => {
    round++;
    if (round === 1) {
      pendingWorker(a, opts.focus, 300);
      return {text: 'ok', sources: [], usage: null, focusDecision: {continue: true, workersPending: true}};
    }
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}};
  };
  await a.sendFocused('task', {turnEnd: false});
  const wait = agentLog().find(e => e.event === 'wait');
  assert.ok(wait, 'a wait line exists');
  assert.equal(wait.decision, 'waited');
  assert.equal(wait.why, 'workers_pending');
  assert.ok(wait.detail.ms >= 200, 'the wait lasted: ' + wait.detail.ms + 'ms');
  assert.ok(agentLog().some(e => e.event === 'leg' && e.decision === 'leg_started'));
  assert.ok(agentLog().some(e => e.event === 'leg' && e.decision === 'leg_ended'));
});

test('weakness 9: a retryable failure leaves a retry line', async t => {
  const a = makeAgent(t);
  a.focusRetryDelaysMs = [1];
  let calls = 0;
  a.runTurn = async () => {
    if (++calls === 1) { const e = new Error('gateway hiccup'); e.turnRetryable = true; throw e; }
    return {text: 'ok', sources: [], usage: null, focusDecision: {continue: false}};
  };
  await a.sendFocused('task', {turnEnd: false});
  const retry = agentLog().find(e => e.event === 'retry');
  assert.ok(retry, 'a retry line exists');
  assert.equal(retry.decision, 'retrying');
  assert.equal(retry.why, 'turn_retryable');
  assert.equal(retry.detail.attempt, 1);
  assert.equal(retry.detail.max, 1);
  assert.equal(retry.detail.waitMs, 1);
  assert.ok(retry.detail.error.includes('gateway hiccup'));
});

test('weakness 9: an erroring leg leaves error and stashed lines', async t => {
  const a = makeAgent(t);
  a.runTurn = async () => { throw new Error('boom'); };
  await assert.rejects(a.sendFocused('task', {turnEnd: false}), /boom/);
  const error = agentLog().find(e => e.event === 'error');
  assert.ok(error, 'an error line exists');
  assert.equal(error.decision, 'blocked');
  assert.equal(error.why, 'aborted');
  assert.ok(error.detail.error.includes('boom'));
  assert.equal(error.detail.retryable, false);
  const stashed = agentLog().find(e => e.event === 'resume' && e.decision === 'stashed');
  assert.ok(stashed, 'the task is stashed for the next message');
});

test('weakness 9: afterFocus auto-continuation leaves a leg line', async t => {
  const a = makeAgent(t);
  a.sendFocused = async () => ({text: '', sources: [], usage: null, focus: {status: 'complete', goal: 'task'}});
  await a.afterFocus({focus: {status: 'limit', goal: 'task', reason: 'rounds'}, usage: null}, 0);
  const line = agentLog().find(e => e.event === 'leg' && e.decision === 'auto_continue');
  assert.ok(line, 'an auto_continue line exists');
  assert.equal(line.why, 'limit');
  assert.equal(line.detail.legs, 1);
  await a.afterFocus({focus: {status: 'limit', goal: 'task'}, usage: null}, 99);
  const capped = agentLog().find(e => e.event === 'leg' && e.decision === 'auto_continue_stopped');
  assert.ok(capped, 'a capped line exists');
  assert.equal(capped.why, 'leg_limit');
});

test('weakness 9: muser log shows the log as JSON and filters by why', () => {
  const log = new FocusLog({sessionId: 'cli1'});
  log.append('end_round', {focus: 'fAAAA1111', decision: 'complete', why: 'all_met', detail: {met: 1}});
  log.append('end_round', {focus: 'fAAAA1111', decision: 'running', why: 'unmet_left', detail: {unmet: 1}});
  const root = path.join(__dirname, '..');
  const runCli = args => spawnSync(process.execPath, [path.join(root, 'bin', 'muser.js'), 'log', ...args], {encoding: 'utf8', env: process.env});
  const all = runCli(['--json']);
  assert.equal(all.status, 0, all.stderr);
  const parsed = JSON.parse(all.stdout);
  assert.ok(parsed.some(e => e.why === 'all_met'));
  assert.ok(parsed.some(e => e.why === 'unmet_left'));
  const filtered = runCli(['--json', '--why', 'all_met']);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(JSON.parse(filtered.stdout).map(e => e.why), ['all_met']);
  const missing = runCli(['no-such-session']);
  assert.notEqual(missing.status, 0, 'an unknown session fails');
});
