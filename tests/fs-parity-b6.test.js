'use strict';
// Parity tests for the fullscreen redraw, stage B,担当 B6 (live parts:
// prompt, footer, working, running, agent-cards, queue, todos, preview,
// focus-row). Same shape as tests/fs-parity.test.js: the React Live() side
// is the truth, the draw side must match it cell by cell at widths 40/80/120.
//
// Env comes FIRST, as in fs-parity.test.js, before any import of ink /
// view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before, after} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const React = require('react');
const h = React.createElement;
const {switchValue} = require('../src/settings.js');
const mentions = require('../src/mentions.js');

// Time is fixed for the whole file. React's spinner tick in renderToString
// is always 0 (clockTicks is only set by runFullscreen), while the draw side
// reads spinTick(ctx.now); they agree only when spinTick(now) % 10 === 0,
// i.e. now is a multiple of 1000. Date.now is stubbed in before() so the
// React side's elapsed times and Live's 8000ms agent filter agree too.
// (Footer's clock segment, footerClock=true in the user's real config, is
// read fresh with new Date() on both sides, so it matches except for a run
// straddling a minute boundary.)
const FIXED = 1700000000000;
const origNow = Date.now;
const CODE_WRAP = switchValue('codeWrap');

let parity, ink, Live, promptCaret, drawLive, drawPrompt, drawFooter, drawWorking, drawRunning, drawAgentCards, drawQueue, drawLiveTodos, drawPreview, drawFocusRow, P;
before(async () => {
  Date.now = () => FIXED;
  parity = await import('./helpers/parity.mjs');
  ink = await import(pathToFileURL(require.resolve('ink')).href);
  ({Live, promptCaret} = await import('../src/ui/view.mjs'));
  ({drawLive} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawPrompt} = await import('../src/ui/fs/draw/live/prompt.mjs'));
  ({drawFooter} = await import('../src/ui/fs/draw/live/footer.mjs'));
  ({drawWorking} = await import('../src/ui/fs/draw/live/working.mjs'));
  ({drawRunning} = await import('../src/ui/fs/draw/live/running.mjs'));
  ({drawAgentCards} = await import('../src/ui/fs/draw/live/agent-cards.mjs'));
  ({drawQueue} = await import('../src/ui/fs/draw/live/queue.mjs'));
  ({drawLiveTodos} = await import('../src/ui/fs/draw/live/todos.mjs'));
  ({drawPreview} = await import('../src/ui/fs/draw/live/preview.mjs'));
  ({drawFocusRow} = await import('../src/ui/fs/draw/live/focus-row.mjs'));
  P = await import('../src/ui/fs/draw/primitives.mjs');
});
after(() => { Date.now = origNow; });

// --- shared stubs -----------------------------------------------------------
const makeCtrl = (over = {}) => {
  const {agent: agentOver, ...rest} = over;
  return {
    previewRow: () => null,
    museName: 'Muse', version: '1.0.0',
    dollarContext: () => null, dollarIndex: () => 0,
    slashIndex: () => 0, atIndex: () => 0, set: () => {},
    ...rest,
    agent: {cwd: process.cwd(), session: {turns: 0}, client: {status: 'connected'}, constructor: {DEVICE: 'mizuki CLI (muser)'}, ...(agentOver || {})},
  };
};
const ctrl = makeCtrl();
const ctxFor = (W, c = ctrl, extra = {}) => parity.baseCtx(W, {now: FIXED, codeWrap: CODE_WRAP, ctrl: c, ...extra});
const liveLines = (s, c, W) => parity.reactLines(h(Live, {s, ctrl: c, W}), W);
const plainLines = lines => lines.map(l => P.plainOf(P.cellsOf(l)));

// The prompt box is the LAST box in the Live output (an AddScreen box, when
// present, sits above it). Its margin blank line sits just before its top border.
function promptSlice(lines) {
  const pl = plainLines(lines);
  let top = -1, bot = -1;
  for (let i = 0; i < pl.length; i++) { if (pl[i].startsWith('╭')) top = i; if (pl[i].startsWith('╰')) bot = i; }
  return lines.slice(top - 1, bot + 1);
}
// The footer is everything after the prompt box's bottom border.
function footerSlice(lines) {
  const pl = plainLines(lines);
  let bot = -1;
  for (let i = 0; i < pl.length; i++) if (pl[i].startsWith('╰')) bot = i;
  return lines.slice(bot + 1);
}
// The parts above the prompt: everything before the first top border's margin line.
function beforePrompt(lines) {
  const pl = plainLines(lines);
  let top = -1;
  for (let i = 0; i < pl.length; i++) if (pl[i].startsWith('╭')) { top = i; break; }
  return lines.slice(0, top - 1);
}
function check(name, react, draw, widths) {
  const used = parity.checkParity({name, react, draw, widths});
  assert.equal(used.length, 0);
}
// For Working/Running/AgentCards/Queue, the part is the HEAD of the Live
// output; its length is whatever the draw side returns, and the next Live
// line must be the prompt's margin blank, so an under-count cannot hide.
function headCheck(name, s, c, drawFn, widths) {
  check(name,
    W => { const all = liveLines(s, c, W); const d = drawFn(W); assert.equal(all[d.length], ''); return all.slice(0, d.length); },
    drawFn, widths);
}

// --- prompt -----------------------------------------------------------------
const promptBase = {text: '', pos: 0, busy: false, mode: 'default', todos: [], agents: [], attachments: [], queue: [], focus: {}, deviceOk: true};
const promptCases = [
  {name: 'prompt: empty idle', s: {...promptBase}},
  {name: 'prompt: empty busy', s: {...promptBase, busy: true}},
  {name: 'prompt: short text', s: {...promptBase, text: 'hello world', pos: 5}},
  {name: 'prompt: long wrap caret mid', s: {...promptBase, text: 'a'.repeat(200), pos: 100}},
  {name: 'prompt: long wrap caret end', s: {...promptBase, text: 'a'.repeat(200), pos: 200}},
  {name: 'prompt: long wrap caret start', s: {...promptBase, text: 'a'.repeat(200), pos: 0}},
  {name: 'prompt: long words wrap', s: {...promptBase, text: 'word '.repeat(30).trim(), pos: 40}},
  {name: 'prompt: multiline paste caret mid', s: {...promptBase, text: 'first line here\nsecond line is longer than the first\n\nfourth line after blank', pos: 30}},
  {name: 'prompt: multiline caret end', s: {...promptBase, text: 'one\ntwo\nthree', pos: 13}},
  {name: 'prompt: above/below 3000 caret near end', s: {...promptBase, text: 'a'.repeat(3000), pos: 2900}},
  {name: 'prompt: above/below 3000 caret mid', s: {...promptBase, text: 'a'.repeat(3000), pos: 1500}},
  {name: 'prompt: many lines caret near end', s: {...promptBase, text: Array.from({length: 60}, (_, i) => 'line ' + (i + 1) + ' abcdefghij').join('\n'), pos: Array.from({length: 60}, (_, i) => 'line ' + (i + 1) + ' abcdefghij').join('\n').length - 3}},
  {name: 'prompt: reasonFor', s: {...promptBase, text: 'too risky', pos: 4, reasonFor: 'tool'}},
  {name: 'prompt: reasonFor empty', s: {...promptBase, text: '', pos: 0, reasonFor: 'tool'}},
  {name: 'prompt: bang', s: {...promptBase, text: '!ls -la', pos: 3}},
  {name: 'prompt: addFlow promptFor', s: {...promptBase, addFlow: {lines: ['アカウントを追加します'], busy: ''}, promptFor: true}},
  {name: 'prompt: addFlow no promptFor', s: {...promptBase, addFlow: {lines: ['アカウントを追加します'], busy: ''}}},
  {name: 'prompt: japanese emoji caret', s: {...promptBase, text: 'a🌏b こんにちは世界', pos: 3}},
  {name: 'prompt: japanese emoji caret end', s: {...promptBase, text: 'こんにちは 🌏👨‍👩‍👧‍👦 test', pos: 'こんにちは 🌏👨‍👩‍👧‍👦 test'.length}},
];
for (const c of promptCases) {
  test(c.name, () => {
    check(c.name,
      W => promptSlice(liveLines(c.s, ctrl, W)),
      W => drawPrompt(c.s, ctxFor(W)).lines);
    // The caret must agree with view.mjs promptCaret: the margin blank +
    // top border cost 2 rows above the first text row, plus the above row.
    for (const W of [40, 80, 120]) {
      const pc = promptCaret(c.s, W);
      assert.deepEqual(drawPrompt(c.s, ctxFor(W)).caret, {row: 2 + (pc.above ? 1 : 0) + pc.row, col: pc.col});
    }
  });
}
test('prompt: placeholder boundary', () => {
  for (const busy of [false, true]) {
    const s = {...promptBase, busy};
    check('prompt: placeholder boundary busy=' + busy,
      W => promptSlice(liveLines(s, ctrl, W)),
      W => drawPrompt(s, ctxFor(W)).lines, [43, 44]);
  }
});

// --- footer -----------------------------------------------------------------
const footerBase = {text: '', pos: 0, mode: 'default', deviceOk: true};
const fakeSkills = [
  {name: 'review', description: 'コードをレビューする'}, {name: 'plan', description: '計画を立てる'},
  {name: 'test', description: 'テストを書く'}, {name: 'docs', description: '文書を書く'},
  {name: 'refactor', description: 'リファクタする'}, {name: 'debug', description: '不具合を調べる'},
  {name: 'design', description: '画面を設計する'}, {name: 'deploy', description: 'デプロイする'},
  {name: 'cleanup', description: '掃除する'},
];
const footerCases = [
  {name: 'footer: plain default', s: {...footerBase}},
  {name: 'footer: deviceOk false', s: {...footerBase, deviceOk: false}},
  {name: 'footer: mode bypass', s: {...footerBase, mode: 'bypass'}},
  {name: 'footer: mode plan', s: {...footerBase, mode: 'plan'}},
  {name: 'footer: mode auto-edit', s: {...footerBase, mode: 'auto-edit'}},
  {name: 'footer: account + reserved + plan', s: {...footerBase, account: {label: 'main'}, accountReserved: 'second', plan: {percentUsed: 61}}},
  {name: 'footer: login needed', s: {...footerBase, loginNeeded: true}},
  {name: 'footer: login needed + plan', s: {...footerBase, loginNeeded: true, mode: 'plan'}},
  {name: 'footer: running shells', s: {...footerBase, shells: [{running: true}, {running: true}, {running: false}]}},
  {name: 'footer: update checking', s: {...footerBase, update: {checking: true}}},
  {name: 'footer: update latest', s: {...footerBase, update: {latest: '1.2.3'}}},
  {name: 'footer: flash short', s: {...footerBase, flash: '保存しました'}},
  {name: 'footer: flash plan', s: {...footerBase, flash: '保存しました', mode: 'plan'}},
  {name: 'footer: flash long', s: {...footerBase, flash: 'これはとても長いフラッシュメッセージです。画面幅を超えると切り詰められます。'}},
  {name: 'footer: flash long bypass', s: {...footerBase, flash: 'これはとても長いフラッシュメッセージです。画面幅を超えると切り詰められます。', mode: 'bypass'}},
  {name: 'footer: bang', s: {...footerBase, text: '!dir', pos: 4}},
  {name: 'footer: slash all sel 0', s: {...footerBase, text: '/', pos: 1}, ctrlOver: {slashIndex: () => 0}},
  {name: 'footer: slash all mid', s: {...footerBase, text: '/', pos: 1}, ctrlOver: {slashIndex: () => 13}},
  {name: 'footer: slash all end', s: {...footerBase, text: '/', pos: 1}, ctrlOver: {slashIndex: () => 25}},
  {name: 'footer: slash /h', s: {...footerBase, text: '/h', pos: 2}, ctrlOver: {slashIndex: () => 0}},
  {name: 'footer: slash no match', s: {...footerBase, text: '/zzzz', pos: 5}},
  {name: 'footer: dollar list sel 0', s: {...footerBase, text: '$foo', pos: 4}, ctrlOver: {dollarContext: () => ({list: fakeSkills, frag: {fragment: 'foo'}, noSkills: false}), dollarIndex: () => 0}},
  {name: 'footer: dollar list mid', s: {...footerBase, text: '$foo', pos: 4}, ctrlOver: {dollarContext: () => ({list: fakeSkills, frag: {fragment: 'foo'}, noSkills: false}), dollarIndex: () => 4}},
  {name: 'footer: dollar list end', s: {...footerBase, text: '$foo', pos: 4}, ctrlOver: {dollarContext: () => ({list: fakeSkills, frag: {fragment: 'foo'}, noSkills: false}), dollarIndex: () => 8}},
  {name: 'footer: dollar no match', s: {...footerBase, text: '$zzz', pos: 4}, ctrlOver: {dollarContext: () => ({list: [], frag: {fragment: 'zzz'}, noSkills: false})}},
  {name: 'footer: dollar no skills', s: {...footerBase, text: '$', pos: 1}, ctrlOver: {dollarContext: () => ({list: [], frag: {fragment: ''}, noSkills: true})}},
  {name: 'footer: short lane ctrl', s: {...footerBase}, ctrlOver: {agent: {cwd: 'C:\\', constructor: {DEVICE: 'd'}}, museName: ''}},
];
for (const c of footerCases) {
  test(c.name, () => {
    const cc = c.ctrlOver ? makeCtrl(c.ctrlOver) : ctrl;
    check(c.name,
      W => footerSlice(liveLines(c.s, cc, W)),
      W => drawFooter(c.s, ctxFor(W, cc)));
  });
}
// @ cases need the mentions listing warmed for their exact cwd first:
// complete() builds its list asynchronously, and the cache holds one cwd.
test('footer: at no match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-footer-empty-'));
  try {
    await mentions.ready(dir);
    const cc = makeCtrl({agent: {cwd: dir}});
    const s = {...footerBase, text: '@zzz', pos: 4};
    check('footer: at no match',
      W => footerSlice(liveLines(s, cc, W)),
      W => drawFooter(s, ctxFor(W, cc)));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
for (const [name, idx] of [['footer: at matches sel 0', 0], ['footer: at matches sel 5', 5]]) {
  test(name, async () => {
    await mentions.ready(process.cwd());
    const cc = makeCtrl({atIndex: () => idx});
    const s = {...footerBase, text: '@src', pos: 4};
    check(name,
      W => footerSlice(liveLines(s, cc, W)),
      W => drawFooter(s, ctxFor(W, cc)));
  });
}

// --- working ----------------------------------------------------------------
const workingBase = {text: '', pos: 0, mode: 'auto-edit', busy: true};
const workingCases = [
  {name: 'working: approval', s: {...workingBase, status: 'waiting_for_approval', turnStart: FIXED}},
  {name: 'working: museRunning 65s', s: {...workingBase, museRunning: 'コードを書いています', turnStart: FIXED - 65000}},
  {name: 'working: activity 125s', s: {...workingBase, activity: 'ファイルを検索中', turnStart: FIXED - 125000}},
  {name: 'working: spinnerWord 0s', s: {...workingBase, spinnerWord: '考え中', turnStart: FIXED}},
  {name: 'working: writing 2s', s: {...workingBase, stream: {partial: 'hello world'}, turnStart: FIXED - 2002}},
  {name: 'working: writing 5s', s: {...workingBase, stream: {partial: 'hello'}, turnStart: FIXED - 5005}},
  {name: 'working: thinking seed1 65s', s: {...workingBase, turnStart: FIXED - 65001}},
  {name: 'working: thinking seed3 125s', s: {...workingBase, turnStart: FIXED - 125007}},
  {name: 'working: elapsed 0s', s: {...workingBase, turnStart: FIXED}},
  {name: 'working: elapsed 65s', s: {...workingBase, turnStart: FIXED - 65000}},
  {name: 'working: elapsed 125s', s: {...workingBase, turnStart: FIXED - 125000}},
  {name: 'working: turnStart undefined', s: {...workingBase}},
  {name: 'working: long museRunning', s: {...workingBase, museRunning: 'Reading the file and checking the contents carefully now', turnStart: FIXED - 30000}},
  {name: 'working: long japanese', s: {...workingBase, museRunning: '日本語の長いテキストで折り返しを確認するための文章です。さらに続きます。もっと続きます。', turnStart: FIXED - 30000}},
  {name: 'working: long single word', s: {...workingBase, museRunning: 'x'.repeat(100), turnStart: FIXED - 30000}},
  {name: 'working: long japanese word', s: {...workingBase, museRunning: 'あ'.repeat(60), turnStart: FIXED - 30000}},
  {name: 'working: many words', s: {...workingBase, museRunning: 'word '.repeat(20).trim(), turnStart: FIXED - 30000}},
  {name: 'working: long activity', s: {...workingBase, activity: 'Searching through many files in the project directory right now for the target', turnStart: FIXED - 30000}},
];
for (const c of workingCases) {
  test(c.name, () => {
    headCheck(c.name, c.s, ctrl, W => drawWorking(c.s, ctxFor(W)));
  });
}
test('working: boundary 49/50', () => {
  const s = {...workingBase, turnStart: FIXED - 65000};
  headCheck('working: boundary 49/50', s, ctrl, W => drawWorking(s, ctxFor(W)), [49, 50]);
});

// --- running ----------------------------------------------------------------
const runBase = {text: '', pos: 0, mode: 'auto-edit', busy: false};
const rCall = (call, tail = ['out'], now = '') => ({call, tail, now});
const runningCases = [
  {name: 'running: tail 0', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, [], '')}},
  {name: 'running: now set', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, [], 'const x = 1;')}},
  {name: 'running: tail 1 + now', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['first line'], 'second line')}},
  {name: 'running: tail 5', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['l1', 'l2', 'l3', 'l4', 'l5'], '')}},
  {name: 'running: tail 6', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'], '')}},
  {name: 'running: tail 10 + now', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'], 'current line')}},
  {name: 'running: now whitespace', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['a'], '   ')}},
  {name: 'running: now long', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, [], 'x'.repeat(120))}},
  {name: 'running: long tail lines', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['y'.repeat(150), 'short'], 'z'.repeat(90))}},
  {name: 'running: empty tail lines', s: {...runBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['', 'middle', ''], '')}},
  {name: 'running: no tail/now keys', s: {...runBase, running: {call: {command: 'code.read', summary: 'src/a.js'}}}},
  {name: 'running: code.edit', s: {...runBase, running: rCall({command: 'code.edit', summary: 'src/b.js'})}},
  {name: 'running: code.grep', s: {...runBase, running: rCall({command: 'code.grep', summary: 'pattern'})}},
  {name: 'running: system.run ps', s: {...runBase, running: rCall({command: 'system.run', summary: 'npm test'})}},
  {name: 'running: system.run cmd', s: {...runBase, running: rCall({command: 'system.run', summary: 'npm test', params: {shell: 'cmd'}})}},
  {name: 'running: agent.spawn', s: {...runBase, running: rCall({kind: 'agent', command: 'agent.spawn'})}},
  {name: 'running: agent.wait', s: {...runBase, running: rCall({kind: 'agent', command: 'agent.wait'})}},
  {name: 'running: mcp', s: {...runBase, running: rCall({kind: 'mcp', command: 'playwright.browser_navigate'})}},
  {name: 'running: user shell ps', s: {...runBase, running: rCall({user: true, command: 'system.run', summary: 'dir'})}},
  {name: 'running: user shell cmd', s: {...runBase, running: rCall({user: true, command: 'system.run', summary: 'dir', params: {shell: 'cmd'}})}},
  {name: 'running: code.write create', s: {...runBase, running: rCall({command: 'code.write', summary: 'new.js', view: {created: true}})}},
  {name: 'running: code.write update', s: {...runBase, running: rCall({command: 'code.write', summary: 'old.js'})}},
  {name: 'running: unknown tool', s: {...runBase, running: rCall({command: 'custom.tool', summary: 'x'})}},
  {name: 'running: summary empty', s: {...runBase, running: rCall({command: 'code.read', summary: ''})}},
  {name: 'running: summary long', s: {...runBase, running: rCall({command: 'code.read', summary: 's'.repeat(150)})}},
  {name: 'running: summary undefined', s: {...runBase, running: rCall({command: 'code.read'})}},
  {name: 'running: bang only', s: {...runBase, bangRunning: rCall({command: 'code.grep', summary: 'pattern'}, ['g1', 'g2'], 'g3')}},
  {name: 'running: both bang and running', s: {...runBase, busy: true, bangRunning: rCall({command: 'code.grep', summary: 'pattern'}, ['g1', 'g2', 'g3'], 'g4'), running: rCall({command: 'code.read', summary: 'src/a.js'}, ['r1'], 'r2')}},
];
for (const c of runningCases) {
  test(c.name, () => {
    headCheck(c.name, c.s, ctrl, W => drawRunning(c.s, ctxFor(W)));
  });
}

// --- agent cards ------------------------------------------------------------
const cardsBase = {text: '', pos: 0, mode: 'default', deviceOk: false, agents: [], queue: [], todos: [], attachments: []};
const mk = (tag, state, extra = {}) => ({tag, state, type: 'code', title: 'Title-' + tag, started: FIXED - 5000, ended: FIXED - 1000, text: 'last of ' + tag, ...extra});
const cardsCases = [
  {name: 'cards: no agents', agents: []},
  {name: 'cards: working + lastTool', agents: [mk('a1', 'working', {lastTool: 'code.read'})]},
  {name: 'cards: working no lastTool', agents: [mk('a1', 'working')]},
  {name: 'cards: working with agentWords', agents: [mk('a1', 'working')], agentWords: {a1: '調査中'}},
  {name: 'cards: done within 8000', agents: [mk('a1', 'done')]},
  {name: 'cards: done 7999 ago', agents: [mk('a1', 'done', {ended: FIXED - 7999})]},
  {name: 'cards: done exactly 8000 ago', agents: [mk('a1', 'done', {ended: FIXED - 8000})]},
  {name: 'cards: done long ago', agents: [mk('a1', 'done', {ended: FIXED - 20000})]},
  {name: 'cards: stopped', agents: [mk('a1', 'stopped')]},
  {name: 'cards: failed', agents: [mk('a1', 'failed')]},
  {name: 'cards: mixed done first', agents: [mk('a1', 'done'), mk('a2', 'working', {lastTool: 'code.read'})]},
  {name: 'cards: long title and last', agents: [mk('a1', 'working', {title: 'A very long title that keeps going and going and going and going', text: 'a very long last line that keeps going and going and going and going and going'})]},
  {name: 'cards: empty text', agents: [mk('a1', 'working', {text: ''})]},
  {name: 'cards: whitespace text', agents: [mk('a1', 'working', {text: '   \n  '})]},
  {name: 'cards: no type', agents: [mk('a1', 'working', {type: undefined})]},
  {name: 'cards: 12 agents', agents: Array.from({length: 12}, (_, i) => mk('a' + (i + 1), i % 3 === 0 ? 'done' : 'working', {text: 'last ' + (i + 1), lastTool: i % 2 ? 'code.read' : undefined}))},
  {name: 'cards: 6 agents', agents: Array.from({length: 6}, (_, i) => mk('a' + (i + 1), i % 3 === 0 ? 'done' : 'working', {text: 'last ' + (i + 1), lastTool: i % 2 ? 'code.read' : undefined}))},
  {name: 'cards: 5 agents', agents: Array.from({length: 5}, (_, i) => mk('a' + (i + 1), i % 3 === 0 ? 'done' : 'working', {text: 'last ' + (i + 1), lastTool: i % 2 ? 'code.read' : undefined}))},
  {name: 'cards: minutes elapsed', agents: [mk('a1', 'done', {started: FIXED - 125000, ended: FIXED})]},
  {name: 'cards: 11 agents', agents: Array.from({length: 11}, (_, i) => mk('a' + (i + 1), i % 3 === 0 ? 'done' : 'working', {text: 'last ' + (i + 1), lastTool: i % 2 ? 'code.read' : undefined}))},
];
for (const c of cardsCases) {
  test(c.name, () => {
    const s = {...cardsBase, agents: c.agents, ...(c.agentWords ? {agentWords: c.agentWords} : {})};
    check(c.name,
      W => { const all = liveLines(s, ctrl, W); const base = liveLines({...s, agents: [], queue: []}, ctrl, W); return all.slice(0, all.length - base.length); },
      W => drawAgentCards(s, ctxFor(W)));
  });
}

// --- queue ------------------------------------------------------------------
const queueCases = [
  {name: 'queue: one item', queue: ['hello world']},
  {name: 'queue: one item multi-line', queue: ['first line\nsecond line\nthird']},
  {name: 'queue: several fitting', queue: ['one', 'two', 'three']},
  {name: 'queue: dropped at 80', queue: ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(30)]},
  {name: 'queue: exact 80', queue: ['a'.repeat(30), 'b'.repeat(47), 'c'.repeat(10)]},
  {name: 'queue: japanese', queue: ['日本語のタスク', 'another task here']},
  {name: 'queue: empty', queue: []},
  {name: 'queue: long single wraps', queue: ['x'.repeat(150)]},
  {name: 'queue: multi-line dropped', queue: ['short\nsecond line here', 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)]},
  {name: 'queue: first item over 80', queue: ['x'.repeat(100), 'short']},
];
for (const c of queueCases) {
  test(c.name, () => {
    const s = {...cardsBase, queue: c.queue};
    check(c.name,
      W => { const all = liveLines(s, ctrl, W); const base = liveLines({...s, agents: [], queue: []}, ctrl, W); return all.slice(0, all.length - base.length); },
      W => drawQueue(s, ctxFor(W)));
  });
}

// --- live todos -------------------------------------------------------------
const td = (content, status) => ({content, status});
const todosBase = {text: '', pos: 0, mode: 'default', deviceOk: true};
const todosCases = [
  {name: 'todos: 1 pending', todos: [td('買い物に行く', 'pending')]},
  {name: 'todos: 1 in_progress', todos: [td('設計書を書く', 'in_progress')]},
  {name: 'todos: mixed 3', todos: [td('買い物に行く', 'pending'), td('設計書を書く', 'in_progress'), td('掃除をする', 'completed')]},
  {name: 'todos: exactly 8', todos: Array.from({length: 8}, (_, i) => td('タスク ' + (i + 1), i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'in_progress' : 'pending'))},
  {name: 'todos: 9 overflow 1', todos: Array.from({length: 9}, (_, i) => td('タスク ' + (i + 1), i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'in_progress' : 'pending'))},
  {name: 'todos: 10 overflow 2', todos: Array.from({length: 10}, (_, i) => td('タスク ' + (i + 1), i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'in_progress' : 'pending'))},
  {name: 'todos: long content', todos: [td('これはとても長いタスクの内容です。幅が狭いと切り詰められます。English words keep going and going and going on.', 'pending')]},
  {name: 'todos: empty content', todos: [td('', 'pending'), td('', 'in_progress'), td('', 'completed')]},
  {name: 'todos: trailing space', todos: [td('あとでやる ', 'pending')]},
];
for (const c of todosCases) {
  test(c.name, () => {
    const s = {...todosBase, todos: c.todos};
    check(c.name,
      W => beforePrompt(liveLines(s, ctrl, W)),
      W => drawLiveTodos(s, ctxFor(W)));
  });
}
test('todos: all-completed renders nothing', () => {
  const s = {...todosBase, todos: [td('a', 'completed'), td('b', 'completed')]};
  check('todos: all-completed renders nothing',
    W => beforePrompt(liveLines(s, ctrl, W)),
    W => []);
  // drawLiveTodos still renders the rows; the guard that hides them lives in
  // drawLive (mirroring Live). The React side is the same rows Live would
  // render: view.mjs todoLine (L89-94) in a truncate-end Text, under the
  // marginTop 1 Live gives the todos block.
  const todoLine = t => {
    const content = String(t?.content ?? '');
    if (t.status === 'completed') return P.c.faint('☒ ' + P.c.strike(content));
    if (t.status === 'in_progress') return P.c.accent('◼ ') + P.c.bold(content);
    return P.c.gray('☐ ') + content;
  };
  check('todos: all-completed rows match React',
    W => parity.reactLines(h(ink.Box, {flexDirection: 'column', marginTop: 1},
      ...s.todos.map((t, i) => h(ink.Text, {key: i, wrap: 'truncate-end'}, '  ' + todoLine(t)))), W),
    W => drawLiveTodos(s, ctxFor(W)));
});

// --- preview ----------------------------------------------------------------
const longCode = 'const answer = 42; // this is a very long code line that should be cut at the screen edge when codeWrap is off';
const longText = 'これはとても長いプレビューの行です。幅が狭いと折り返されます。English words wrap too when the line is long enough.';
const table3 = [{prefix: '', text: 'aaa bbb ccc'}, {prefix: '▶ ', text: 'ddd eee fff'}, {prefix: '', text: 'ggg hhh'}];
const previewCases = [
  {name: 'preview: table 3 first true', preview: {table: table3, first: true}},
  {name: 'preview: table 3 first false', preview: {table: table3, first: false}},
  {name: 'preview: row code true first true', preview: {row: {prefix: '▶ ', text: longCode, code: true}, first: true}},
  {name: 'preview: row code true first false', preview: {row: {prefix: '▶ ', text: longCode, code: true}, first: false}},
  {name: 'preview: row code false first true', preview: {row: {prefix: '', text: longText, code: false}, first: true}},
  {name: 'preview: row code false first false', preview: {row: {prefix: '', text: longText, code: false}, first: false}},
  {name: 'preview: table + row', preview: {table: table3.slice(0, 2), row: {prefix: '', text: 'single row text', code: false}, first: true}},
  {name: 'preview: table 16 rows', preview: {table: Array.from({length: 16}, (_, i) => ({prefix: (i + 1) + '. ', text: 'row ' + (i + 1) + ' text'})), first: true}},
  {name: 'preview: table long truncate', preview: {table: [{prefix: '', text: longCode}], first: false}},
  {name: 'preview: table empty text', preview: {table: [{prefix: '', text: ''}], first: false}},
  {name: 'preview: empty object', preview: {}},
  {name: 'preview: null', preview: null},
  {name: 'preview: empty table no row', preview: {table: [], row: null}},
];
for (const c of previewCases) {
  test(c.name, () => {
    const cc = makeCtrl({previewRow: () => c.preview});
    const s = {...todosBase};
    check(c.name,
      W => beforePrompt(liveLines(s, cc, W)),
      W => drawPreview(s, ctxFor(W, cc)));
  });
}

// --- focus row --------------------------------------------------------------
const focusCases = [
  {name: 'focus: 1/3 met 0/2', focus: {status: 'running', round: 1, maxRounds: 3, criteria: [{status: 'pending'}, {status: 'pending'}]}},
  {name: 'focus: 2/5 met 3/3', focus: {status: 'running', round: 2, maxRounds: 5, criteria: [{status: 'met'}, {status: 'met'}, {status: 'met'}]}},
  {name: 'focus: 1/1 met 0/0', focus: {status: 'running', round: 1, maxRounds: 1, criteria: []}},
  {name: 'focus: criteria missing', focus: {status: 'running', round: 1, maxRounds: 3}},
  {name: 'focus: long line wraps', focus: {status: 'running', round: 123456789, maxRounds: 987654321, criteria: []}},
];
for (const c of focusCases) {
  test(c.name, () => {
    const s = {...todosBase, busy: true, turnStart: FIXED - 65000, focus: c.focus};
    check(c.name,
      W => { const all = beforePrompt(liveLines(s, ctrl, W)); const working = beforePrompt(liveLines({...s, focus: {status: 'complete'}}, ctrl, W)); return all.slice(working.length); },
      W => drawFocusRow(s, ctxFor(W)));
  });
}

// --- drawLive: parts composed -----------------------------------------------
test('drawLive: idle prompt + footer', () => {
  const s = {...promptBase};
  check('drawLive: idle prompt + footer',
    W => liveLines(s, ctrl, W),
    W => drawLive(s, ctxFor(W)).lines);
  const res = drawLive(s, ctxFor(80));
  assert.deepEqual(res.caret, drawPrompt(s, ctxFor(80)).caret);
});
test('drawLive: busy working', () => {
  const s = {...workingBase, turnStart: FIXED - 65000, focus: {}};
  check('drawLive: busy working',
    W => liveLines(s, ctrl, W),
    W => drawLive(s, ctxFor(W)).lines);
});
test('drawLive: running + queue + cards', () => {
  const s = {...cardsBase, running: rCall({command: 'code.read', summary: 'src/a.js'}, ['out1'], 'now1'), queue: ['first task', 'second task'], agents: [mk('a1', 'working', {lastTool: 'code.read'})]};
  check('drawLive: running + queue + cards',
    W => liveLines(s, ctrl, W),
    W => drawLive(s, ctxFor(W)).lines);
});
test('drawLive: preview + focus + todos', () => {
  const cc = makeCtrl({previewRow: () => ({table: table3.slice(0, 2), first: true})});
  const s = {...todosBase, busy: true, turnStart: FIXED - 65000, focus: {status: 'running', round: 1, maxRounds: 3, criteria: [{status: 'met'}, {status: 'pending'}]}, todos: [td('買い物に行く', 'pending'), td('設計書を書く', 'in_progress')]};
  check('drawLive: preview + focus + todos',
    W => liveLines(s, cc, W),
    W => drawLive(s, ctxFor(W, cc)).lines);
});
test('drawLive: todos + queue + focus', () => {
  const s = {...todosBase, busy: true, turnStart: FIXED - 65000, focus: {status: 'running', round: 2, maxRounds: 5, criteria: [{status: 'met'}, {status: 'met'}, {status: 'pending'}]}, todos: Array.from({length: 9}, (_, i) => td('タスク ' + (i + 1), i % 2 ? 'pending' : 'in_progress')), queue: ['queued one', 'queued two\nsecond line']};
  check('drawLive: todos + queue + focus',
    W => liveLines(s, ctrl, W),
    W => drawLive(s, ctxFor(W)).lines);
});
