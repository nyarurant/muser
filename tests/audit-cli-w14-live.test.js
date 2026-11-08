'use strict';
// Wave 14: the classic Live area has a whole-area terminal-row budget, and
// an approval landing over the question picker says the question is waiting.
//  (1) The parts used to cap themselves one by one against the full
//      terminal height (preview rows-16, agent cards rows-20, composer
//      rows-14), so a stack of them ran taller than the terminal and every
//      frame leaked into the scrollback. Live now shares what is left after
//      the fixed parts (composer and footer included), shedding the stream
//      preview first, then the todos, then the agent cards.
//  (2) While the picker is up, an approval takes the keys and the screen
//      (approval first, as before) — one line under the approval now says a
//      question is waiting instead of the picker vanishing in silence.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

async function setupCtrl() {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  agent.constructor.DEVICE = 'muser CLI';
  return new Controller({agent, museName: 'Muse', version: '0.3.8', onExit() {}});
}

async function renderLive(ctrl, s, rows) {
  const React = (await import('react')).default;
  const {renderToString} = await import('ink');
  const {Live} = await import('../src/ui/view.mjs');
  const out = strip(renderToString(React.createElement(Live, {s, ctrl, W: 79, rows}), {columns: 80}));
  return out.replace(/\n+$/, '').split('\n');
}

function stackedState(ctrl) {
  const table = Array.from({length: 20}, (_, i) => ({prefix: '', text: 'TABLEROW ' + i}));
  ctrl.previewRow = () => ({table, row: {prefix: '', text: 'PREVIEWROW', code: false}, first: false});
  const todos = Array.from({length: 12}, (_, i) => ({content: 'todo ' + i, status: 'pending'}));
  const agents = Array.from({length: 10}, (_, i) => ({tag: 'a' + (i + 1), type: 'general', title: 'task ' + i, state: 'working', started: Date.now(), ended: 0, text: 'last line ' + i, lastTool: 'Read'}));
  return {...ctrl.get(), text: '', pos: 0, busy: false, running: null, bangRunning: null, queue: [], todos, agents, attachments: [], approval: null, question: null, menu: null, limitInput: null, flash: '', focus: null};
}

test('w14 live (1): a tall stack fits a short terminal, shedding preview, then todos, then cards', async () => {
  const ctrl = await setupCtrl();
  try {
    const s = stackedState(ctrl);
    const at18 = await renderLive(ctrl, s, 18);
    assert.ok(at18.length <= 18, 'the whole live area incl. the composer fits 18 rows, got ' + at18.length + ': ' + JSON.stringify(at18));
    assert.ok(at18.some(l => l.includes('a1')), 'agent cards are shed last: a card survives at 18 rows');
    assert.ok(at18.some(l => l.includes('ほか 12 件')), 'todos are shed to their count line at 18 rows');
    assert.ok(!at18.some(l => l.includes('PREVIEWROW') || l.includes('TABLEROW')), 'the stream preview is shed first at 18 rows');
    const at24 = await renderLive(ctrl, s, 24);
    assert.ok(at24.length <= 24, 'fits 24 rows, got ' + at24.length);
    assert.ok(at24.some(l => l.includes('todo 3')), 'todos get rows back before the preview does');
    assert.ok(at24.some(l => l.includes('ほか 6 件')), 'the hidden todos are counted at 24 rows');
    assert.ok(!at24.some(l => l.includes('PREVIEWROW')), 'the preview is still shed at 24 rows');
    const at12 = await renderLive(ctrl, s, 12);
    assert.ok(at12.length <= 12, 'fits 12 rows, got ' + at12.length + ': ' + JSON.stringify(at12));
    assert.ok(at12.some(l => l.includes('a1')), 'some agent cards survive even at 12 rows');
    assert.ok(at12.some(l => l.includes('ほか 5 件（/agents で一覧）')), 'cards past the budget are counted, not silently dropped');
    assert.ok(!at12.some(l => l.includes('todo 0')), 'todos are gone entirely before the cards give way');
    const at44 = await renderLive(ctrl, s, 44);
    assert.ok(at44.length <= 44, 'fits 44 rows, got ' + at44.length);
    assert.ok(at44.some(l => l.includes('PREVIEWROW')), 'with room to spare the preview shows');
    assert.ok(at44.some(l => l.includes('TABLEROW')), 'with room to spare the preview table shows');
    assert.ok(at44.some(l => l.includes('todo 7')), 'with room to spare the todos show in full');
  } finally { clearTimeout(ctrl.flashTimer); }
});

const QUESTION = {questions: [{question: 'どれにしますか？', options: [{label: 'A'}, {label: 'B'}]}], tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''};
const APPROVAL = {call: {kind: 'exec', agent: 'main', command: 'system.run', summary: 'echo hi', params: {command: 'echo hi'}}, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], index: 0, outside: false, preview: null};

test('w14 live (2): an approval over the picker says a question is waiting', async () => {
  const ctrl = await setupCtrl();
  try {
    ctrl.previewRow = () => null;
    const base = {...ctrl.get(), text: '', pos: 0, busy: false, running: null, bangRunning: null, queue: [], todos: [], agents: [], attachments: [], menu: null, limitInput: null, flash: '', focus: null};
    const both = await renderLive(ctrl, {...base, approval: APPROVAL, question: QUESTION}, 40);
    assert.ok(both.some(l => l.includes('実行していい？')), 'the approval itself shows');
    assert.ok(both.some(l => l.includes('質問が待っています。承認が終わると表示されます')), 'one line near the approval says the question is waiting');
    assert.ok(!both.some(l => l.includes('この件について話す')), 'the picker itself stays hidden behind the approval');
    assert.ok(!both.some(l => l.includes('どれにしますか？')), 'the picker question is not shown either');
    const alone = await renderLive(ctrl, {...base, approval: APPROVAL, question: null}, 40);
    assert.ok(!alone.some(l => l.includes('質問が待っています')), 'no waiting line when no question is open');
  } finally { clearTimeout(ctrl.flashTimer); }
});

test('w14 controller (2): an approval lands over an open question without losing it; approval keys win', async () => {
  const ctrl = await setupCtrl();
  try {
    ctrl.openQuestion({questions: [{question: 'どれにしますか？', options: [{label: 'A'}, {label: 'B'}]}]});
    assert.ok(ctrl.get().question, 'the picker is open');
    const p = ctrl.ask({command: 'system.run', kind: 'exec', params: {command: 'echo hi'}, summary: 'echo hi', agent: 'main'});
    assert.ok(ctrl.get().approval, 'the approval opened');
    assert.ok(ctrl.get().question, 'the question is still there under the approval');
    ctrl.key('1', {});
    const res = await p;
    assert.equal(res.allow, true, 'the key answered the approval (approval priority unchanged)');
    assert.equal(ctrl.get().approval, null, 'the approval closed');
    assert.ok(ctrl.get().question, 'the question is still waiting after the approval');
    ctrl.closeQuestion(false);
  } finally { clearTimeout(ctrl.flashTimer); }
});
