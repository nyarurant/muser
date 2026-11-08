'use strict';
// (A) The fix after report 20261107-6add4cf739 was read back: with the
// conversation body OFF, prose that lives OUTSIDE the body — the Focus
// log's detail.goal (the user's request) and intent (Muse's progress
// sentence), progress notes, tool summaries and errors, todo texts, the
// Focus state's goal and criterion texts, and every field of OTHER
// windows — must not ride along at all. Each marker below is a unique
// sentence planted in one of those places; the no-body report's JSON
// must contain none of them, not one character of any sentence, while
// the shapes (lengths, counts, decisions, command names, paths) remain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const exporter = require('../src/export');
const sessions = require('../src/sessions');
const store = require('../src/secure-store');
const {FocusLog} = require('../src/focus-log');

const USER = 'nyaru';
const M = {
  goal: '/export 秘密の頼み文マーカー・スイカ畑を全部掘り返して。仕様は C:\Users\nyaru\spec.md',
  intent: '途中報告マーカー・src/farm.js を読んで、いま畑の半分まで掘りました',
  progress: '進み具合マーカー・掘る向きを変えています',
  summary: '要約マーカー・スイカ畑を掘る道具を出しました',
  error: 'エラーマーカー・畑の土が固くて進めません',
  todo: 'やることマーカー・スイカを数える',
  step: '手順マーカー・畑へ向かう',
  criteria: '条件マーカー・src/farm.js でスイカが全部掘れていること',
  reason: '理由マーカー・tests/farm.test.js がまだ半分しか通らないから',
  evidence: '証拠の要約マーカー・C:\farm\photo.png の写真を見た',
  otherTodo: 'ほかの窓のやることマーカー・畑の柵を直す',
  otherGoal: 'ほかの窓の目標マーカー・柵を直してから帰る',
  otherTitle: 'ほかの窓の題マーカー・柵の話',
  otherProgress: 'ほかの窓の進み具合マーカー・柵を見ています',
  otherSummary: 'ほかの窓の要約マーカー・柵の部品を読んだ',
  otherReason: 'ほかの窓の理由マーカー・柵が壊れているから',
  otherSession: 'othersessionid-marker-1234567890',
};
const ALL = Object.values(M);

test('no-body report: no planted sentence rides along anywhere, shapes remain', async t => {
  const s = sessions.create('C:\\Users\\' + USER + '\\work');
  s.turns = 1;
  sessions.save(s);
  sessions.appendTurn(s.id, {
    v: 1, at: 1762470000000, user: M.goal, reply: '返事',
    usage: {inputTokens: 1, outputTokens: 2, source: 'live'},
    tools: [{command: 'system.run', summary: M.summary, ok: false, error: 'Error: ' + M.error}],
    progress: [{agent: 'main', message: M.progress, at: 1762470000001}],
    steps: [{title: M.step, failed: false}],
    todos: [{content: M.todo, status: 'in_progress'}],
    focus: {status: 'running', goal: M.goal, criteria: [{id: 'c1', text: M.criteria, kind: 'inspection', status: 'pending', reason: M.reason}]},
    error: 'TurnError: ' + M.error,
  });
  const log = new FocusLog({sessionId: s.id, level: 'verbose'});
  log.append('plan', {decision: 'keep-going', why: 'checkpoint-code', detail: {goal: M.goal, command: 'focus.plan', path: 'C:\\Users\\' + USER + '\\work\\a.js'}, intent: M.intent});
  sessions.saveFocus(s.id, {
    v: 1, goal: M.goal, status: 'running', round: 2, maxRounds: 10, reason: M.reason,
    criteria: [{id: 'c1', text: M.criteria, kind: 'inspection', status: 'pending', reason: M.reason, evidence: ['e1']}],
    evidence: [{id: 'e1', command: 'code.read', summary: M.evidence, ok: true}],
  });
  // Two live windows: this conversation's own, and another conversation's
  // (a second process stands in for its window; its pid must be alive for
  // window-status.readAll to list it).
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
  t.after(() => { try { child.kill(); } catch {} });
  await new Promise(r => child.on('spawn', r));
  const winDir = path.join(store.DIR, 'windows');
  fs.mkdirSync(winDir, {recursive: true});
  const nowIso = new Date().toISOString();
  const ownFile = path.join(winDir, process.pid + '.json');
  const otherFile = path.join(winDir, child.pid + '.json');
  fs.writeFileSync(ownFile, JSON.stringify({version: 1, kind: 'window', pid: process.pid, startedAt: nowIso, updatedAt: nowIso, cwd: 'C:\\Users\\' + USER + '\\work', mode: 'default', account: {id: 'default', label: 'x'}, session: {id: s.id, title: M.otherTitle, turns: 1}, connected: true, activity: 'working', todos: [{content: M.todo, status: 'pending'}], goal: M.goal, agents: [], shells: [], toolLog: [], progress: []}));
  fs.writeFileSync(otherFile, JSON.stringify({version: 1, kind: 'window', pid: child.pid, startedAt: nowIso, updatedAt: nowIso, cwd: 'C:\\Users\\' + USER + '\\other', mode: 'default', account: {id: 'default', label: 'x'}, session: {id: M.otherSession, title: M.otherTitle, turns: 3}, connected: false, activity: 'idle', slot: 2, todos: [{content: M.otherTodo, status: 'pending'}, {content: M.otherTodo, status: 'completed'}], goal: M.otherGoal, agents: [{tag: 'a1', type: 'general', title: M.otherTitle, state: 'working'}], shells: [{id: 'bg1', running: true}], toolLog: [{agent: 'main', command: 'code.read', summary: M.otherSummary, ok: true, at: nowIso}], progress: [{agent: 'main', message: M.otherProgress, at: nowIso}], focus: {status: 'running', round: 1, maxRounds: 5, met: 0, total: 2, open: ['c1', 'c2'], reason: M.otherReason}, running: {command: 'code.read', summary: M.otherSummary, since: nowIso}}));
  t.after(() => { for (const f of [ownFile, otherFile]) { try { fs.unlinkSync(f); } catch {} } });

  const r = exporter.buildReport({session: s, username: USER});
  assert.equal(r.includesConversation, false);
  const json = JSON.stringify(r);
  for (const marker of ALL) assert.ok(!json.includes(marker), 'marker leaked: ' + marker.slice(0, 12));
  // The shapes that replace the sentences.
  const entry = r.focusLog.find(e => e.event === 'plan');
  assert.ok(entry, 'focus log line present');
  assert.equal(entry.decision, 'keep-going');
  assert.equal(entry.why, 'checkpoint-code');
  assert.equal(entry.detail.goalChars, M.goal.length);
  assert.equal(entry.detail.command, 'focus.plan');
  assert.equal(entry.detail.path, 'C:\\Users\\<user>\\work\\a.js');
  assert.equal(entry.intentChars, M.intent.length);
  assert.equal(r.focusState.goalChars, M.goal.length);
  assert.equal(r.focusState.criteria[0].textChars, M.criteria.length);
  assert.equal(r.focusState.criteria[0].reasonChars, M.reason.length);
  assert.equal(r.focusState.evidence[0].summaryChars, M.evidence.length);
  assert.equal(r.focusState.evidence[0].command, 'code.read');
  const turn = r.turns[0];
  assert.deepEqual(turn.error, {name: 'TurnError', chars: ('TurnError: ' + M.error).length});
  assert.equal(turn.tools[0].summaryChars, M.summary.length);
  assert.ok(!('summary' in turn.tools[0]));
  assert.deepEqual(turn.tools[0].error, {name: 'Error', chars: ('Error: ' + M.error).length});
  assert.deepEqual(turn.progress, [{agent: 'main', at: 1762470000001, chars: M.progress.length}]);
  assert.deepEqual(turn.steps, [{titleChars: M.step.length}]);
  assert.deepEqual(turn.todos, {count: 1, byStatus: {in_progress: 1}});
  assert.equal(turn.focus.goalChars, M.goal.length);
  // Windows: the other one is shape only; the own one counts its todos.
  const other = r.state.windows.find(w => w.pid === child.pid);
  assert.ok(other, 'other window listed');
  assert.deepEqual(Object.keys(other).sort(), ['activity', 'agents', 'connected', 'eventsCount', 'focus', 'kind', 'mode', 'pid', 'progressCount', 'queue', 'shells', 'slot', 'startedAt', 'todos', 'toolLogCount', 'turnStartedAt', 'updatedAt', 'version'].sort());
  assert.deepEqual(other.todos, {count: 2, byStatus: {pending: 1, completed: 1}});
  assert.deepEqual(other.focus, {status: 'running', round: 1, maxRounds: 5, met: 0, total: 2, openCount: 2});
  const own = r.state.windows.find(w => w.pid === process.pid);
  assert.ok(own, 'own window listed');
  assert.deepEqual(own.todos, {count: 1, byStatus: {pending: 1}});
  assert.deepEqual(own.session, {turns: 1});
  assert.equal(own.goalChars, M.goal.length);
});

test('with-body report: the opt-in still carries the log detail and summaries', t => {
  const s = sessions.create('C:\\Users\\' + USER + '\\work');
  s.turns = 1;
  sessions.save(s);
  sessions.appendTurn(s.id, {v: 1, at: 1762470000000, user: M.goal, reply: '返事', tools: [{command: 'system.run', summary: M.summary, ok: true}], progress: [{agent: 'main', message: M.progress, at: 1}], steps: [], todos: [{content: M.todo, status: 'pending'}]});
  const log = new FocusLog({sessionId: s.id, level: 'normal'});
  log.append('plan', {decision: 'keep-going', detail: {goal: M.goal}, intent: M.intent});
  const r = exporter.buildReport({session: s, username: USER, includeConversation: true});
  const json = JSON.stringify(r);
  // The planted goal ends with a path holding the user name, which the redact pass still rewrites.
  assert.ok(json.includes(M.goal.split('。')[0]) && json.includes(M.intent) && json.includes(M.summary), 'the user opted in: the words ride, redacted as usual');
  assert.ok(!json.includes('\\' + USER + '\\'), 'the user name inside paths is still redacted');
});
