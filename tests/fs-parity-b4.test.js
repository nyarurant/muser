'use strict';
// Parity tests for the fullscreen redraw (stage 2, worker B4): the entries
// agent, focus, todos (TodoRow), status and banner (Banner / Keycap / logo).
// Same harness and rules as tests/fs-parity.test.js — see that file's header.
//
// Env comes FIRST: both sides must colourise the same way. setup.mjs does not
// set these, so this file does, before any import of ink / view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawAgent, drawFocus, drawTodos, drawStatus, drawBanner;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawAgent} = await import('../src/ui/fs/draw/entries/agent.mjs'));
  ({drawFocus} = await import('../src/ui/fs/draw/entries/focus.mjs'));
  ({drawTodos} = await import('../src/ui/fs/draw/entries/todos.mjs'));
  ({drawStatus} = await import('../src/ui/fs/draw/entries/status.mjs'));
  ({drawBanner} = await import('../src/ui/fs/draw/entries/banner.mjs'));
});

// One parity case: the React Entry is the truth, drawEntry must match it at
// widths 40 / 80 / 120 (or the given widths). `exceptions` defaults to none;
// a case that needs one must say why in a comment and in the worker report.
function entryCase(name, e, ctrl, opts = {}) {
  test(name, () => {
    const used = parity.checkParity({
      name,
      react: W => parity.reactLines(h(Entry, {e, ctrl, W}), W),
      draw: W => drawEntry(e, parity.baseCtx(W, {ctrl, ...(opts.ctx || {})})),
      ...(opts.widths ? {widths: opts.widths} : {}),
      ...(opts.exceptions ? {exceptions: opts.exceptions} : {}),
    });
    assert.equal(used.length, (opts.exceptions || []).length);
  });
}

// --- todos (TodoRow) ---------------------------------------------------------
entryCase('todos: one pending item', {type: 'todos', todos: [{content: '牛乳を買う', status: 'pending'}]}, {});
entryCase('todos: mixed statuses', {type: 'todos', todos: [
  {content: '終わった仕事', status: 'completed'},
  {content: '今やっている仕事', status: 'in_progress'},
  {content: 'まだの仕事', status: 'pending'},
]}, {});
entryCase('todos: long wrapping items', {type: 'todos', todos: [
  {content: 'これはとても長い todo です。幅 40 では何行にも折り返されます。English words wrap too when the line is long enough.', status: 'in_progress'},
  {content: '完了した長い項目です。取り消し線と薄い色で、折り返しの続きは本文の下にそろいます。もう少し長くします。', status: 'completed'},
]}, {});
entryCase('todos: empty content item', {type: 'todos', todos: [{content: '', status: 'pending'}, {content: '次の項目', status: 'pending'}]}, {});
entryCase('todos: no items', {type: 'todos', todos: []}, {});

// --- focus, compact ----------------------------------------------------------
entryCase('focus compact: running, some met', {type: 'focus', focus: {status: 'running', round: 1, maxRounds: 1, criteria: [
  {id: 'c1', status: 'met'}, {id: 'c2', status: 'pending'}, {id: 'c3', status: 'pending'},
]}}, {});
entryCase('focus compact: complete, rounds shown', {type: 'focus', focus: {status: 'complete', round: 3, maxRounds: 5, criteria: [
  {id: 'c1', status: 'met'}, {id: 'c2', status: 'met'},
]}}, {});
entryCase('focus compact: needs_input warns and wraps', {type: 'focus', focus: {status: 'needs_input', round: 2, maxRounds: 4, criteria: [
  {id: 'c1', status: 'met'}, {id: 'c2', status: 'pending'}, {id: 'c3', status: 'pending'}, {id: 'c4', status: 'pending'}, {id: 'c5', status: 'pending'}, {id: 'c6', status: 'pending'},
]}}, {});
entryCase('focus compact: no criteria', {type: 'focus', focus: {status: 'inactive', round: 1, maxRounds: 1, criteria: []}}, {});

// --- focus, full -------------------------------------------------------------
entryCase('focus full: goal, criteria with reason and evidence, reason', {type: 'focus', full: true, focus: {
  status: 'complete', round: 2, maxRounds: 3, goal: '段階 B の担当 B4 を終わらせる',
  criteria: [
    {id: 'c1', status: 'met', text: '仕様を読む', reason: '読み終えた', evidence: ['e1', 'e2']},
    {id: 'c2', status: 'pending', text: '試験を通す'},
  ],
  reason: '残りは試験だけです',
}}, {});
entryCase('focus full: long goal and criterion wrap', {type: 'focus', full: true, focus: {
  status: 'running', round: 1, maxRounds: 2,
  goal: 'これはとても長い目標です。幅 40 では折り返され、続きの行は目標の本文の下にそろって表示されるはずです。',
  criteria: [
    {id: 'c1', status: 'pending', text: '長い条件の文です。折り返したときに印と番号の列が崩れないことを確かめます。', reason: '理由も長くします。折り返しの確認のためです。'},
  ],
}}, {});
entryCase('focus full: no criteria, no reason', {type: 'focus', full: true, focus: {status: 'stalled', round: 1, maxRounds: 1, goal: '目標だけ', criteria: []}}, {});
entryCase('focus full: empty goal', {type: 'focus', full: true, focus: {status: 'running', round: 1, maxRounds: 1, goal: '', criteria: [{id: 'c1', status: 'met', text: 'x'}]}}, {});

// --- agent -------------------------------------------------------------------
const snap = over => ({tag: 'a1', type: 'general', title: '調べもの', started: 1000, ended: 61000, ...over});
entryCase('agent: done, short result', {type: 'agent', snap: snap({state: 'done', result: '完了しました。'})}, {});
entryCase('agent: done, markdown result', {type: 'agent', snap: snap({state: 'done', result: '# 見出し\n\n- 項目 1\n- 項目 2\n\n**太字** を含む本文です。'})}, {});
entryCase('agent: done, code fence result', {type: 'agent', snap: snap({state: 'done', result: '```js\nconst x = 1;\nconsole.log(x);\n```'})}, {});
entryCase('agent: done, long code line is cut', {type: 'agent', snap: snap({state: 'done', result: '```js\nconst result = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour);\n```'})}, {});
entryCase('agent: done, blank line inside result', {type: 'agent', snap: snap({state: 'done', result: '1 行目\n\n3 行目'})}, {});
entryCase('agent: done, long wrapping result', {type: 'agent', snap: snap({state: 'done', result: 'これはとても長い結果の文章です。幅 40 の枠の中では何行にも折り返されます。English words wrap too when the line is long enough to exceed the box.'})}, {});
entryCase('agent: done, more than 12 lines', {type: 'agent', snap: snap({state: 'done', result: Array.from({length: 20}, (_, i) => '行 ' + (i + 1)).join('\n')})}, {});
entryCase('agent: done, full shows all lines', {type: 'agent', full: true, snap: snap({state: 'done', result: Array.from({length: 20}, (_, i) => '行 ' + (i + 1)).join('\n')})}, {});
entryCase('agent: stopped with error', {type: 'agent', snap: snap({state: 'stopped', error: '途中で止まりました'})}, {});
entryCase('agent: stopped without error', {type: 'agent', snap: snap({state: 'stopped'})}, {});
entryCase('agent: failed with long error', {type: 'agent', snap: snap({state: 'failed', error: '失敗の理由がここに長く書かれています。幅 40 の枠では折り返されるはずの文章です。'})}, {});
entryCase('agent: done, empty result', {type: 'agent', snap: snap({state: 'done', result: ''})}, {});
entryCase('agent: long title is cut', {type: 'agent', snap: snap({state: 'done', result: 'ok', title: 'とても長いタイトルのエージェント作業です。見出し行は幅に合わせて切り詰められます。'})}, {});

// --- status ------------------------------------------------------------------
function statusCtrl(over = {}, agentOver = {}) {
  const a = {
    client: {status: 'connected'},
    session: {title: '作業中の会話', id: 'sess-1'},
    cwd: 'C:\\Users\\nyaru\\muser-b4',
    mode: 'default',
    device: {connected: true},
    nodeSlot: {slot: 2},
    ...agentOver,
  };
  a.constructor = {DEVICE: 'mizuki CLI (muser)'};
  return {museName: 'Muse', version: '0.3.8', agent: a, ...over};
}
entryCase('status: connected', {type: 'status'}, statusCtrl());
entryCase('status: demo, disconnected, new session', {type: 'status'}, statusCtrl({}, {client: {status: 'demo'}, device: {connected: false}, nodeSlot: null, session: {title: '', id: 'sess-2'}, mode: 'plan'}));
entryCase('status: unknown gateway status', {type: 'status'}, statusCtrl({}, {client: {status: 'connecting'}, mode: 'bypass'}));
entryCase('status: with named account', {type: 'status'}, statusCtrl({}, {accountId: '2', accountLabel: '仕事用'}));
entryCase('status: with unnamed account', {type: 'status'}, statusCtrl({}, {accountId: '2', accountLabel: '2'}));
entryCase('status: long cwd is cut at its start when narrow', {type: 'status'}, statusCtrl({}, {cwd: 'C:\\Users\\nyaru\\Documents\\projects\\a-very-long-folder-name\\muser-b4'}), {widths: [30]});
entryCase('status: stacked under 40', {type: 'status'}, statusCtrl({}, {device: {connected: false}}), {widths: [24, 30, 39]});

// --- banner ------------------------------------------------------------------
// A fresh entry object per case: whether the chat was resumed is fixed on
// first draw (view.mjs WeakMap), and both sides must fix it from the same
// session state.
function bannerCtrl(turns, over = {}) {
  return {museName: 'Muse', version: '0.3.8', agent: {cwd: 'C:\\Users\\nyaru\\muser-b4', session: {title: '前の会話', id: 'sess-9', turns}, ...over}};
}
entryCase('banner: fresh chat', {type: 'banner'}, bannerCtrl(0));
entryCase('banner: resumed chat', {type: 'banner'}, bannerCtrl(5));
entryCase('banner: resumed with long title', {type: 'banner'}, bannerCtrl(12, {session: {title: 'とても長いタイトルの会話です。再開の行は幅に合わせて切り詰められます。', id: 'sess-9', turns: 12}}));
entryCase('banner: long cwd', {type: 'banner'}, bannerCtrl(0, {cwd: 'C:\\Users\\nyaru\\Documents\\projects\\a-very-long-folder-name\\another-long-folder\\muser-b4'}));

// --- fallback for payload-less entries ---------------------------------------
// A draw returns null for an entry that lacks the data it draws (no Focus
// snapshot, no todo list, no agent snapshot, no controller state): the caller
// then uses the React drawing, exactly as for a part not replaced yet. Real
// entries always carry their payload, so this never changes a real screen.
test('b4: entries without their payload fall back (null)', () => {
  const bare = parity.baseCtx(80);
  assert.equal(drawEntry({type: 'focus'}, bare), null);
  assert.equal(drawEntry({type: 'todos'}, bare), null);
  assert.equal(drawEntry({type: 'agent'}, bare), null);
  assert.equal(drawEntry({type: 'status'}, bare), null);
  assert.equal(drawEntry({type: 'banner'}, bare), null);
  // …while the smallest well-formed shapes do draw.
  assert.notEqual(drawEntry({type: 'focus', focus: {status: 'running', round: 1, maxRounds: 1, criteria: []}}, bare), null);
  assert.notEqual(drawEntry({type: 'todos', todos: []}, bare), null);
  assert.notEqual(drawEntry({type: 'agent', snap: {state: 'done', result: 'ok'}}, bare), null);
});

// --- dispatch ----------------------------------------------------------------
test('b4: drawEntry dispatches to the part functions', () => {
  const ctxOf = ctrl => parity.baseCtx(80, {ctrl});
  const td = {type: 'todos', todos: [{content: 'x', status: 'pending'}]};
  assert.deepEqual(drawEntry(td, ctxOf({})), drawTodos(td, ctxOf({})));
  const fo = {type: 'focus', focus: {status: 'running', round: 1, maxRounds: 1, criteria: []}};
  assert.deepEqual(drawEntry(fo, ctxOf({})), drawFocus(fo, ctxOf({})));
  const ag = {type: 'agent', snap: snap({state: 'done', result: 'ok'})};
  assert.deepEqual(drawEntry(ag, ctxOf({})), drawAgent(ag, ctxOf({})));
  const st = {type: 'status'};
  assert.deepEqual(drawEntry(st, ctxOf(statusCtrl())), drawStatus(st, ctxOf(statusCtrl())));
  const ba = {type: 'banner'};
  const bc = bannerCtrl(0);
  assert.deepEqual(drawEntry(ba, ctxOf(bc)), drawBanner(ba, ctxOf(bc)));
});
