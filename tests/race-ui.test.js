'use strict';
// Parity for the 'race' entry （競争の結果）: the fullscreen draw
// (src/ui/fs/draw/entries/race.mjs) must match the classic Ink view
// (src/ui/view.mjs case 'race') line for line, in the fs-parity style.
// Env comes FIRST, as in tests/fs-parity.test.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;
const race = require('../src/race');

let parity, Entry, drawEntry, COMMANDS;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({COMMANDS} = await import('../src/ui/controller.mjs'));
});

const cases = [
  {name: 'race: short result lines', e: {type: 'race', lines: ['競争の結果（20261107-150000）: a.txt を伸ばす', '1. 最小の変更 / a1', '   完了 ・ 検査 2/2 通過 ・ 差分 1 ファイル +1 −0 ・ 3 秒 ・ トークン 15 ・ 裏取り ✓']}},
  {name: 'race: a long line wraps the same', e: {type: 'race', lines: ['これは長い競争の結果の行です。幅が狭いと折り返されます。English words wrap too when the line is long enough to exceed the width.']}},
  {name: 'race: several lines with an empty one', e: {type: 'race', lines: ['1 行目', '', '3 行目']}},
  {name: 'race: no lines', e: {type: 'race', lines: []}},
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

test('race: drawEntry draws a well-formed race entry', () => {
  assert.notEqual(drawEntry({type: 'race', lines: ['x']}, parity.baseCtx(80)), null);
});

test('race: the formatted result of a real-shaped result object renders identically on both sides', () => {
  const result = {id: '20261107-150000', task: 'a.txt を伸ばす', dir: 'C:\\race', totalTokens: 75,
    racers: [{index: 1, strategy: race.STRATEGIES[0], account: 'a1', status: 'done', ok: true, durationMs: 3000, tokens: 15,
      checks: [{command: 'npm test', code: 0}], diff: {files: 1, added: 1, removed: 0}, badge: {mark: '✓'}}]};
  const e = {type: 'race', lines: race.formatRaceResult(result)};
  const used = parity.checkParity({
    name: 'race: formatted result',
    react: W => parity.reactLines(h(Entry, {e, ctrl: {}, W}), W),
    draw: W => drawEntry(e, parity.baseCtx(W)),
  });
  assert.equal(used.length, 0);
});

test('race: /race is in the slash command list', () => {
  assert.ok(COMMANDS.some(([n]) => n === '/race'));
});
