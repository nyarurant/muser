'use strict';
// Fifth audit c1-1: while the selectable-question picker is open, `muser status`
// showed the window as 待機中 (idle). The picker opens after the turn ended on
// needs_input, so busy is false and only s.question / the /api/state snapshot's
// question marks the wait — and neither activity classifier read it. Both now
// classify an open question as 'input' (入力待ち), the same user-waiting state
// as a menu / reason / limit prompt, so --json consumers see it too.
const test = require('node:test');
const assert = require('node:assert');
const ws = require('../src/window-status');
const status = require('../src/server/status');

const NOW = 1_800_000_000_000;
// The picker's live shape (controller.mjs openQuestion): questions plus the
// user's in-progress picks and typed drafts.
const QUESTION = {questions: [{question: 'Which?', options: [{label: 'A'}, {label: 'B'}]}], tab: 0, index: 0,
  checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''};
const pickerStore = {busy: false, approval: null, menu: null, promptFor: null, reasonFor: null, limitInput: null, question: QUESTION};

test('fix2 c1-1: window-status activityOf — an open picker is input, not idle', () => {
  assert.equal(ws.activityOf(pickerStore), 'input', 'picker open after the turn ended (busy false)');
  assert.equal(ws.activityOf({...pickerStore, busy: true}), 'input', 'a wait on the user outranks busyness, like a menu');
  assert.equal(ws.activityOf({...pickerStore, approval: {call: {}}}), 'approval', 'an approval still outranks the picker');
  assert.equal(ws.activityOf({...pickerStore, question: null}), 'idle', 'no picker and nothing else: still idle');
  assert.equal(ws.activityOf({...pickerStore, question: null, busy: true}), 'working');
});

test('fix2 c1-1: window-status snapshot carries the wait as activity, and never the picker contents', () => {
  const secret = {...QUESTION, custom: {0: 'typed-custom-answer'}, notes: 'typed-note', typeText: 'typed-draft'};
  const snap = ws.snapshot({s: {...pickerStore, question: secret, mode: 'default', deviceOk: true, queue: [], todos: [],
      focus: {status: 'needs_input', criteria: []}, goal: null, agents: [], shells: []},
    agent: {cwd: 'C:\\x', mode: 'default', session: {id: 's1', title: '', turns: 1}}, now: NOW});
  assert.equal(snap.activity, 'input');
  assert.equal(snap.focus.status, 'needs_input');
  const text = JSON.stringify(snap);
  for (const typed of ['typed-custom-answer', 'typed-note', 'typed-draft']) {
    assert.ok(!text.includes(typed), 'what the user is composing in the picker is not written to the window file: ' + typed);
  }
  // And what `muser status` prints for that file says 入力待ち, not 待機中.
  const head = status.formatWindow(snap, NOW)[0];
  assert.match(head, /入力待ち/);
  assert.doesNotMatch(head, /待機中/);
});

test('fix2 c1-1: server/status activityOf — a snapshot question is input, not idle', () => {
  const session = {busy: false, approval: false};
  const state = {busy: false, approval: null, menu: null, reasonFor: null, limitInput: null, approvalQueue: 0, question: QUESTION};
  assert.equal(status.activityOf(session, state), 'input', 'picker open, turn over');
  assert.equal(status.activityOf({busy: true, approval: false}, {...state, busy: true}), 'input', 'the wait outranks a busy snapshot too');
  assert.equal(status.activityOf({busy: false, approval: true}, state), 'approval', 'approval still outranks the picker');
  assert.equal(status.activityOf(session, {...state, question: null}), 'idle', 'question closed: back to idle');
  assert.equal(status.activityOf(session, null), 'idle', 'no snapshot at all: unchanged');
});

test('fix2 c1-1: buildRows + formatRow — a server conversation waiting on a question shows 入力待ち', () => {
  const servers = [{kind: 'server', pid: 111, port: 2222, version: '1.0', startedAt: NOW - 60000, accounts: [],
    sessions: [{id: 'abcdef01-2345', cwd: 'C:\\a', busy: false, approval: false, account: null, lastUsedAt: NOW - 60000}],
    states: {'abcdef01-2345': {busy: false, approval: null, question: QUESTION, focus: {status: 'needs_input'}}}}];
  const rows = status.buildRows(servers);
  assert.equal(rows[0].activity, 'input');
  assert.equal(rows[0].focusStatus, 'needs_input');
  const line = status.formatRow(rows[0], NOW);
  assert.match(line, /入力待ち/);
  assert.doesNotMatch(line, /待機中/);
  assert.match(status.formatStatus(servers, NOW).join('\n'), /入力待ち/);
});
