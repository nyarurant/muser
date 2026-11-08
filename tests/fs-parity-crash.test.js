'use strict';
// Parity for the 'crash' entry (the crash investigation's panel): the
// fullscreen draw (src/ui/fs/draw/entries/crash.mjs) against the classic
// Ink view (src/ui/view.mjs Entry case 'crash'), written the way
// tests/fs-parity.test.js writes its cases.
//
// Env comes FIRST: both sides must colourise the same way.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawCrash;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawCrash} = await import('../src/ui/fs/draw/entries/crash.mjs'));
});

const crashCases = [
  {name: 'crash: one fall with an edit lined up', e: {type: 'crash', lines: ['直近 1 時間の落下: 1 件', '14:50、app.exe が 0xc0000005 で落ちました（モジュール core.dll）', '  イベントログ（ID 1000）、プロセス ID 10812', '  その3 分前、a2 が src/parse.js (function parse(input)) を変更']}},
  {name: 'crash: long wrapping line', e: {type: 'crash', lines: ['これは長い調査結果の行です。幅が狭いと折り返されます。English words wrap too when the line is long enough to exceed the width of the terminal.']}},
  {name: 'crash: nothing found', e: {type: 'crash', lines: ['直近 1 時間に、アプリの異常終了は見つかりませんでした。']}},
  {name: 'crash: no lines', e: {type: 'crash', lines: []}},
  {name: 'crash: empty line inside', e: {type: 'crash', lines: ['上', '', '下']}},
];
for (const c of crashCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('crash: drawEntry dispatches to drawCrash', () => {
  const e = {type: 'crash', lines: ['x']};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawCrash(e, parity.baseCtx(80)));
});
