'use strict';
// Parity tests for the 想定外ストップ tool-row line (src/expect.js): the
// classic screen (view.mjs Tool) is the truth, the fullscreen redraw
// (src/ui/fs/draw/entries/tool.mjs) must match it cell by cell at widths
// 40/80/120 — same shape as tests/fs-parity-b3.test.js, which covers the
// tool entry's other branches.
//
// Env comes FIRST: both sides must colourise the same way, before any
// import of ink / view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry;
const CWD = 'C:\\Users\\nyaru\\muser-expect';
const ctrl = {agent: {cwd: CWD}};
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
});

function parityCase(name, e, exceptions = []) {
  test(name, () => {
    const used = parity.checkParity({
      name,
      react: W => parity.reactLines(h(Entry, {e, ctrl, W}), W),
      draw: W => drawEntry(e, parity.baseCtx(W, {ctrl})),
      exceptions,
    });
    assert.equal(used.length, exceptions.length);
  });
}

const run = (view, over = {}) => ({type: 'tool', call: {command: 'system.run', ok: true, summary: 'npm test', outputLines: 2, view, ...over}});

// A missed prediction: the 想定外 line under the run's own result rows.
parityCase('tool expect: miss, exit form', run({tail: ['boom output'], exit: 3, expect: {expected: 'exit 0', actual: 'exit 3', matched: false}}));
parityCase('tool expect: miss, tests form', run({tail: ['pass 9', 'fail 1'], exit: 1, expect: {expected: 'テスト全通過', actual: 'pass 9 / fail 1', matched: false}}));
parityCase('tool expect: miss, long strings wrap at narrow widths', {type: 'tool', call: {command: 'code.read', ok: true, summary: 'src/a.js', view: {lines: 12, expect: {expected: '出力に「テストが全部通ってビルドも成功すること」を含む', actual: '「テストが全部通ってビルドも成功すること」は含まれなかった', matched: false}}}});
parityCase('tool expect: miss on a no-output run', run({tail: [], exit: 0, expect: {expected: 'exit 非0', actual: 'exit 0', matched: false}}));
// A matched or unjudged prediction draws no extra line.
parityCase('tool expect: matched stays quiet', run({tail: ['ok'], exit: 0, expect: {expected: 'exit 0', actual: 'exit 0', matched: true}}));
parityCase('tool expect: unjudged (background) stays quiet', run({tail: ['ok'], exit: 0, expect: {expected: 'exit 0', actual: 'exit 不明（バックグラウンド）', matched: null}}));
// The line hangs under other branches too (it is drawn after the branch).
parityCase('tool expect: miss on code.read', {type: 'tool', call: {command: 'code.read', ok: true, summary: 'src/a.js', view: {lines: 12, expect: {expected: 'exit 0', actual: 'exit 3', matched: false}}}});
parityCase('tool expect: miss on code.edit diff', {type: 'tool', call: {command: 'code.edit', ok: true, summary: 'src/a.js', view: {diff: [{t: ' ', n: 1, l: 'const a = 1;'}, {t: '-', n: 2, l: 'old();'}, {t: '+', n: 2, l: 'new();'}], expect: {expected: 'テスト全通過', actual: 'pass 3 / fail 2', matched: false}}}});
