'use strict';
// 2026-11-08: one logical reply arrived as two history messages — the first
// half as message.assistant, the rest as delta.presentation under another id —
// and the transcript kept only the second half, while the TUI/server entries
// printed the first half twice (its final update landed after the second
// half had started). These tests pin the combined reply and the display.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-replysplit-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-replysplit-home-'));

const {waitForReply, combineMessages} = require('../src/core/agent-reply');

const user = (id, seq) => ({seq, message_id: id, role: 'user', display_text: 'task'});
const reply = (id, text, seq, extra = {}) => ({seq, message_id: id, role: 'assistant', display_text: text, ...extra});
// The second half as it really arrived: a delta.presentation history event
// whose payload carries the assistant role and its own message id.
const presentation = (id, text, seq) => ({seq, event: 'delta.presentation', payload: {message_id: id, role: 'assistant', display_text: text}});
function client({status = 'completed', events}) {
  const c = new EventEmitter();
  c.history = async () => ({chat_events: events});
  c.request = async () => ({session: {status}});
  return c;
}
const opts = {sessionId: 's1', pollMs: 20, settleMs: 0, timeoutMs: 1500};

test('a reply split across two messages keeps both halves', async () => {
  const events = [user('u1', 1), reply('a1', '[setup.exe](C:/Windows/notepad.exe) and', 2), presentation('a2', '[site](https://example.com)', 3)];
  // As agent.js passes it: both halves streamed live in the turn's last segment.
  const w = waitForReply({client: client({events}), ...opts, segmentIds: () => new Set(['a1', 'a2'])});
  w.accept('ack');
  const r = await w.promise;
  // Joined as a new paragraph, the way Muse's page shows two messages.
  assert.equal(r.text, '[setup.exe](C:/Windows/notepad.exe) and\n\n[site](https://example.com)');
  assert.deepEqual(r.messageIds, ['a1', 'a2']);
});

test('the same text under two ids is kept once, not repeated', async () => {
  const events = [user('u1', 1), reply('a1', 'done', 2), reply('a2', 'done', 3)];
  const w = waitForReply({client: client({events}), ...opts});
  w.accept('ack');
  assert.equal((await w.promise).text, 'done');
});

test('a snapshot a fuller copy extends is dropped', async () => {
  const events = [user('u1', 1), reply('a1', 'hello wo', 2), reply('a2', 'hello world', 3)];
  const w = waitForReply({client: client({events}), ...opts});
  w.accept('ack');
  assert.equal((await w.promise).text, 'hello world');
});

test('only the last segment joins: narration before a tool call stays out', async () => {
  const events = [user('u1', 1), reply('n1', 'ファイルを読みます', 2), reply('a1', '前半', 3), presentation('a2', '後半', 4)];
  const w = waitForReply({client: client({events}), ...opts, segmentIds: () => new Set(['a1', 'a2'])});
  w.accept('ack');
  const r = await w.promise;
  assert.equal(r.text, '前半\n\n後半');
  assert.deepEqual(r.messageIds, ['a1', 'a2']);
});

test('an empty live segment keeps only the newest message (no narration pulled in)', async () => {
  const events = [user('u1', 1), reply('a1', 'one', 2), reply('a2', 'two', 3)];
  const w = waitForReply({client: client({events}), ...opts, segmentIds: () => new Set()});
  w.accept('ack');
  assert.equal((await w.promise).text, 'two');
});

test('combineMessages: fragment joins respect boundaries and punctuation', () => {
  const M = (...texts) => texts.map((content, i) => ({id: 'm' + i, content}));
  assert.equal(combineMessages(M('and', '[site](x)')).text, 'and\n\n[site](x)', 'no whitespace at the cut: a new paragraph');
  assert.equal(combineMessages(M('## 見出し', '- 項目')).text, '## 見出し\n\n- 項目', 'a heading and a list stay apart');
  assert.equal(combineMessages(M('and ', '[site](x)')).text, 'and [site](x)', 'a trailing space joins as-is');
  assert.equal(combineMessages(M('終わり', '。次です')).text, '終わり。次です', 'closing punctuation takes no space');
  assert.equal(combineMessages(M('one\n', 'two')).text, 'one\ntwo', 'a newline boundary joins as-is');
  assert.deepEqual(combineMessages(M('x', 'x', 'y')).ids, ['m0', 'm2'], 'an identical copy is dropped');
});

test('controller: a late final update for the first half does not print it twice', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  class FakeAgent extends EventEmitter {
    constructor() {
      super();
      this.mode = 'default'; this.cwd = process.cwd(); this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
      this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
    }
  }
  FakeAgent.DEVICE = 'test';
  const agent = new FakeAgent();
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  // The order the split reply really streamed in (2026-11-08 probe): first
  // half, second half, then the first half's final text (a trailing space
  // more) and its message-done.
  agent.emit('text', {id: 'a', text: '[setup.exe](C:/Windows/notepad.exe) and'});
  agent.emit('text', {id: 'b', text: '[site](https://example.com)'});
  agent.emit('text', {id: 'a', text: '[setup.exe](C:/Windows/notepad.exe) and '});
  agent.emit('message-done', {id: 'a'});
  agent.emit('turn-end', {ok: true, text: '[setup.exe](C:/Windows/notepad.exe) and [site](https://example.com)'});
  const srcs = ctrl.get().entries.filter(e => e.type === 'md').map(e => e.src);
  assert.deepEqual(srcs, ['[setup.exe](C:/Windows/notepad.exe) and', '[site](https://example.com)'], 'each half printed exactly once, in order');
});

test('agent: narration before a tool call never rejoins the reply segment, even on a late update', () => {
  const {Agent} = require('../src/agent');
  const c = new EventEmitter();
  Object.assign(c, {status: 'connected', ws: {readyState: 1}, history: async () => ({chat_events: []}), request: async () => ({}), subscribeAgent: async () => {}, closeAgentSubscription: () => {}, cancel: async () => {}, disconnect: () => {}});
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-replysplit-cwd-'));
  const a = new Agent({client: c, auth: {saved: {}, vm: async () => { throw new Error('no vm'); }}, cwd, session: {id: 'S', cwd, title: '', created: 0, updated: 0, turns: 0}});
  try {
    const turn = a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, segmentIds: new Set()};
    const delta = (id, text, seq) => a.onChatEvent({event: 'delta.text_append', payload: {session_id: 'S', message_id: id, text, seq}});
    delta('n1', 'ファイルを読みます', 1);
    a.toolStart(a.main, {id: 'c1', command: 'code.read'});
    delta('n1', '。', 2); // the narration's late final update, after the tool started
    delta('r1', '答え', 1);
    assert.deepEqual([...turn.segmentIds], ['r1']);
  } finally { try { a.close(); } catch {} }
});
