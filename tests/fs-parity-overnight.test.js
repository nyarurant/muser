'use strict';
// Parity for the 'overnight' entry: the fullscreen draw side
// (src/ui/fs/draw/entries/overnight.mjs) must match the classic React Entry
// in view.mjs cell by cell, the same way tests/fs-parity.test.js pins 'note'.
// Env comes FIRST, as there, before any import of ink / view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawOvernight;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawOvernight} = await import('../src/ui/fs/draw/entries/overnight.mjs'));
});

const cases = [
  {name: 'overnight: one short line', e: {type: 'overnight', lines: ['夜間作業のキューは空です。']}},
  {name: 'overnight: queue list', e: {type: 'overnight', lines: ['onabc12345  [待ち] テストを直す', 'onxyz98765  [待ち] 資料をまとめる']}},
  {name: 'overnight: long wrapping line', e: {type: 'overnight', lines: ['夜間作業の報告（2026/11/8 7:00:00）これは長い報告の行です。幅が狭いと折り返されます。English words wrap too when the line is long enough.']}},
  {name: 'overnight: report with branches', e: {type: 'overnight', lines: ['- [終わった] テストを直す', 'ブランチ: overnight/20261108-0700-onabc · トークン: 1200 · 裏取り: ok', '判断待ち: 確認が要るコマンドを承認しますか: system.run npm test']}},
  {name: 'overnight: empty line inside', e: {type: 'overnight', lines: ['上', '', '下']}},
  {name: 'overnight: no lines', e: {type: 'overnight', lines: []}},
];
for (const c of cases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}
test('overnight: drawEntry dispatches to drawOvernight', () => {
  const e = {type: 'overnight', lines: ['x']};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawOvernight(e, parity.baseCtx(80)));
});
