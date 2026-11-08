'use strict';
// Parity tests for the 'proof' entry (/proof evidence badges): the React
// Entry in view.mjs is the truth, the fullscreen draw must match it cell
// by cell at widths 40/80/120. Same shape as tests/fs-parity.test.js.
//
// Env comes FIRST, as in fs-parity.test.js, before any import of ink /
// view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawProof;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawProof} = await import('../src/ui/fs/draw/entries/proof.mjs'));
});

const proofCases = [
  {name: 'proof: title + one backed line', e: {type: 'proof', title: '裏取り（ターン 1）', lines: ['✓ テスト 2 件通過しました。 — 最後の変更より後に流したテストの出力と一致します（pass 2 / fail 0）', '裏取り: ✓ 1 / ? 0 / ✗ 0（印なし 1 文）']}},
  {name: 'proof: all three marks', e: {type: 'proof', title: '裏取り（ターン 2）', lines: ['✓ src/a.js を直しました。 — 変更の記録があります', '? テスト 3 件通過しました。 — 最後の変更より後にテストを流した記録がありません', '✗ エラーはありません。 — 最後の変更より後に失敗した道具があります']}},
  {name: 'proof: long wrapping claim', e: {type: 'proof', title: '裏取り（ターン 3）', lines: ['✗ テストは全部通ったと書いてありますが、これは長い文です。幅が狭いと折り返されます。English words wrap too when the line is long enough.']}},
  {name: 'proof: counter-proof plain lines', e: {type: 'proof', title: '裏取り（ターン 1）', lines: ['反証テスト: 流すコマンドは npm test です', '反証テスト: ✓ このテストは修正を見ている（修正を外すと落ちました）']}},
  {name: 'proof: title only', e: {type: 'proof', title: '裏取り（ターン 1）', lines: []}},
  {name: 'proof: no claims line', e: {type: 'proof', title: '裏取り（ターン 1）', lines: ['この返事には、記録と突き合わせられる決まった形の主張がありませんでした。', '裏取り: ✓ 0 / ? 0 / ✗ 0（印なし 2 文）']}},
];
for (const c of proofCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('proof: drawEntry dispatches to drawProof', () => {
  const e = {type: 'proof', title: '裏取り（ターン 1）', lines: ['✓ x']};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawProof(e, parity.baseCtx(80)));
});
