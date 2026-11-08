'use strict';
// Parity tests for the 'lore' entry （言い伝え）: the classic React view
// (src/ui/view.mjs Entry case 'lore') is the truth; the fullscreen draw
// (src/ui/fs/draw/entries/lore.mjs, reached through drawEntry) must match
// it cell for cell at widths 40 / 80 / 120.
//
// Env comes FIRST: both sides must colourise the same way (see
// tests/fs-parity-b1.test.js).
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawLore;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawLore} = await import('../src/ui/fs/draw/entries/lore.mjs'));
});

const LONG = 'この場所は 11/04 に直したバグ（境界で落ちる）の場所です。回帰テストが守っています。English words wrap too when the line is long enough to exceed the available width.';
const cases = [
  {name: 'lore: title and short line', e: {type: 'lore', title: '言い伝え', lines: ['11/04 傷跡 src/a.js:3 バグを修正（回帰テスト tests/a.test.js）']}},
  {name: 'lore: long wrapping line', e: {type: 'lore', title: '言い伝え', lines: [LONG]}},
  {name: 'lore: several lines', e: {type: 'lore', title: '言い伝え — src/a.js', lines: ['1行目', '2行目は少し長い文です。折り返しの確認も兼ねています。', '3行目']}},
  {name: 'lore: no title', e: {type: 'lore', lines: ['見出しなしの1行']}},
  {name: 'lore: title only', e: {type: 'lore', title: '言い伝え', lines: []}},
  {name: 'lore: empty', e: {type: 'lore', lines: []}},
  {name: 'lore: empty line inside', e: {type: 'lore', title: '言い伝え', lines: ['上の行', '', '下の行']}},
];
for (const c of cases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
      exceptions: c.exceptions || [],
    });
    assert.equal(used.length, (c.exceptions || []).length);
  });
}

test('lore: drawEntry dispatches to drawLore', () => {
  const e = {type: 'lore', title: '言い伝え', lines: ['x']};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawLore(e, parity.baseCtx(80)));
});
