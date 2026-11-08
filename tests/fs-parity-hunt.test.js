'use strict';
// Parity for the 'hunt' entry (bug hunt, design §6): the fullscreen draw
// (src/ui/fs/draw/entries/hunt.mjs) must match the classic view.mjs case
// exactly, in the style of tests/fs-parity.test.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawHunt;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawHunt} = await import('../src/ui/fs/draw/entries/hunt.mjs'));
});

const huntCases = [
  {name: 'hunt: status lines', e: {type: 'hunt', lines: ['バグ狩り: 監査が終わりました', '所見 3 件（Critical 1 · High 1 · Medium 1）', '担当 2/2 が完了', '結果: C:\\work\\.muser\\hunt\\20261107-120000']}},
  {name: 'hunt: estimate line', e: {type: 'hunt', lines: ['見込み: エージェント 3 体 · アカウント default · 対象 42 ファイル']}},
  {name: 'hunt: long wrapping line', e: {type: 'hunt', lines: ['直した 1 件 · 直せなかった 2 件 · 後回し 3 件 · 再現しなかった 4 件。これは長い要約です。幅が狭いと折り返されます。English words wrap too when the line is long enough.']}},
  {name: 'hunt: error', e: {type: 'hunt', level: 'error', lines: ['バグ狩りの結果がありません。先に /hunt を実行してください。']}},
  {name: 'hunt: empty line inside', e: {type: 'hunt', lines: ['上', '', '下']}},
  {name: 'hunt: no lines', e: {type: 'hunt', lines: []}},
];
for (const c of huntCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('hunt: drawEntry dispatches to drawHunt', () => {
  const e = {type: 'hunt', lines: ['x']};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawHunt(e, parity.baseCtx(80)));
  assert.notEqual(drawEntry(e, parity.baseCtx(80)), null);
});
