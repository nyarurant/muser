'use strict';
// Regression tests for the Focus-audit controller.mjs fixes (a8):
//  1. a plain submit() (a GUI / phone answer in serve mode) clears a stale
//     picker question instead of leaving s.question set forever;
//  2. the turn-end ask dedupe key includes the ask content, so the same
//     focus id/round/revision with a DIFFERENT ask reopens the picker;
//  3. picker answers (fromQuestion) are plain messages: a question whose
//     text starts with '/' or '!' must not run as a command, and an answer
//     submitted while an account is being added is queued, not dropped.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// Self-isolation guard, the same pattern as tests/fix2-controller.test.js:
// point LOCALAPPDATA / HOME at throwaway dirs before any src module loads.
const fsTop = require('node:fs');
const pathTop = require('node:path');
process.env.LOCALAPPDATA = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-focusfix-data-'));
process.env.USERPROFILE = process.env.HOME = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-focusfix-home-'));
const createdTmpDirs = [process.env.LOCALAPPDATA, process.env.HOME];
const origMkdtempSync = fsTop.mkdtempSync.bind(fsTop);
fsTop.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdTmpDirs.push(dir); return dir; };
after(() => { for (const dir of createdTmpDirs) { try { fsTop.rmSync(dir, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'demo'}; this.device = {connected: true};
    this.sent = []; this.busy = false;
  }
  async send(text, opts) { this.sent.push({text, opts}); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const tmpDir = () => fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-focusfix-'));
async function mk() {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(tmpDir());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null); // no muse.ai in tests
  return {agent, ctrl};
}
const ASK = {questions: [
  {question: '色は？', header: '色', options: [{label: '赤'}, {label: '青'}]},
]};
const ASK_OTHER = {questions: [
  {question: '形は？', header: '形', options: [{label: '丸'}, {label: '四角'}]},
]};

test('fix 1: a plain submit clears an open picker question and sends normally', async () => {
  const {agent, ctrl} = await mk();
  ctrl.openQuestion(ASK);
  assert.ok(ctrl.get().question, 'picker is open (as the server-side Controller leaves it in serve mode)');
  await ctrl.submit('スマホからの回答');
  assert.equal(ctrl.get().question, null, 'the stale question is cleared by the plain send');
  assert.equal(agent.sent.length, 1, 'the send itself goes through as the answer');
  assert.equal(agent.sent[0].text, 'スマホからの回答');
});

test('fix 1: clearing on submit does not drain the queue as a side effect', async () => {
  const {agent, ctrl} = await mk();
  ctrl.queue = ['waiting one']; ctrl.set({queue: ['waiting one']});
  ctrl.openQuestion(ASK);
  await ctrl.submit('GUI からの回答');
  assert.equal(ctrl.get().question, null);
  assert.equal(agent.sent.length, 1, 'only the incoming send went out');
  assert.equal(agent.sent[0].text, 'GUI からの回答');
  assert.deepEqual(ctrl.queue, ['waiting one'], 'the queued message still waits for this turn to end');
});

test('fix 2: same id/round/revision with different ask content reopens; the identical ask still dedupes', async () => {
  const {agent, ctrl} = await mk();
  const base = {id: 'f1', round: 1, revision: 1, status: 'needs_input'};
  agent.emit('turn-end', {ok: true, focus: {...base, ask: ASK}});
  assert.equal(ctrl.get().question?.questions?.[0]?.question, '色は？', 'the first ask opens');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().question, null, 'esc closes it');
  agent.emit('turn-end', {ok: true, focus: {...base, ask: ASK}});
  assert.equal(ctrl.get().question, null, 'the exact same ask re-delivered still dedupes');
  agent.emit('turn-end', {ok: true, focus: {...base, ask: ASK_OTHER}});
  assert.equal(ctrl.get().question?.questions?.[0]?.question, '形は？', 'a different ask under the same id/round/revision (a resumed leg) opens');
});

test('fix 3: a picker answer whose question starts with / is sent as a plain message, not a slash command', async () => {
  const {agent, ctrl} = await mk();
  ctrl.openQuestion({questions: [{question: '/help どっち？', header: 'Q', options: [{label: '赤'}, {label: '青'}]}]});
  ctrl.key('', {return: true}); // single-select, single question: the pick sends at once
  await wait(20);
  assert.equal(ctrl.get().question, null, 'the picker closed');
  assert.equal(agent.sent.length, 1, 'the composed answer was sent to Muse');
  assert.equal(agent.sent[0].text, '/help どっち？ → 赤');
  assert.equal(ctrl.get().menu, null, 'no slash command ran (no menu opened)');
});

test('fix 3: a picker answer whose question starts with ! is sent as a plain message, not a !command', async () => {
  const {agent, ctrl} = await mk();
  ctrl.openQuestion({questions: [{question: '!echo どっち？', header: 'Q', options: [{label: '赤'}, {label: '青'}]}]});
  ctrl.key('', {return: true});
  await wait(20);
  assert.equal(agent.sent.length, 1, 'the composed answer was sent to Muse');
  assert.equal(agent.sent[0].text, '!echo どっち？ → 赤');
  assert.ok(!ctrl.get().bangRunning, 'no !command ran');
});

test('fix 3: submit(..., {fromQuestion: true}) bypasses the slash and bang branches directly', async () => {
  // Separate controllers per text: a send leaves s.busy set (the FakeAgent
  // never ends the turn), and a second send would queue as a busy send.
  const a = await mk();
  await a.ctrl.submit('/model は？ → そのまま', {fromQuestion: true});
  assert.deepEqual(a.agent.sent.map(s => s.text), ['/model は？ → そのまま']);
  const b = await mk();
  await b.ctrl.submit('!dir は？ → そのまま', {fromQuestion: true});
  assert.deepEqual(b.agent.sent.map(s => s.text), ['!dir は？ → そのまま']);
  assert.ok(!b.ctrl.get().bangRunning, 'no !command ran');
});

test('fix 3: a picker answer during account-adding is queued, then delivered after the add', async () => {
  const {agent, ctrl} = await mk();
  ctrl.addingAccount = true;
  ctrl.openQuestion(ASK);
  ctrl.key('', {return: true}); // pick 赤: submitQuestionAnswers -> submit(..., {fromQuestion: true})
  await wait(20);
  assert.equal(ctrl.get().question, null, 'the picker still closed');
  assert.equal(agent.sent.length, 0, 'nothing is sent while the add runs');
  assert.deepEqual(ctrl.queue, ['色は？ → 赤'], 'the answer is queued instead of dropped');
  assert.deepEqual(ctrl.get().queue, ['色は？ → 赤']);
  ctrl.addingAccount = false;
  assert.equal(ctrl.drainQueueOnce(), true, 'the queue drains once the add is over');
  await wait(20);
  assert.equal(agent.sent.length, 1, 'the queued answer is delivered afterwards');
  assert.equal(agent.sent[0].text, '色は？ → 赤');
});

test('fix 3: a queued picker answer keeps its plain-message nature through the drain (slash question)', async () => {
  const {agent, ctrl} = await mk();
  ctrl.addingAccount = true;
  ctrl.openQuestion({questions: [{question: '/help どっち？', header: 'Q', options: [{label: '赤'}, {label: '青'}]}]});
  ctrl.key('', {return: true});
  await wait(20);
  assert.deepEqual(ctrl.queue, ['/help どっち？ → 赤']);
  ctrl.addingAccount = false;
  ctrl.drainQueueOnce();
  await wait(20);
  assert.equal(agent.sent.length, 1, 'the drained answer reaches Muse as text');
  assert.equal(agent.sent[0].text, '/help どっち？ → 赤');
  assert.equal(ctrl.get().menu, null, 'the drain did not re-route it as a slash command');
});

test('fix 3: a plain send during account-adding is still not queued (only picker answers are)', async () => {
  const {agent, ctrl} = await mk();
  ctrl.addingAccount = true;
  await ctrl.submit('普通の送信');
  assert.equal(agent.sent.length, 0);
  assert.deepEqual(ctrl.queue, [], 'plain sends keep the old wait behaviour');
});
