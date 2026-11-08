'use strict';
// Parity tests for the fullscreen redraw (stage 2).
//
// HOW TO WRITE A CASE (for stage B workers):
//  1. Pick a representative entry/state (the React side is the truth).
//  2. Call checkParity with react: W => reactLines(h(Entry, {e, ctrl, W}), W)
//     and draw: W => drawEntry(e, baseCtx(W)) (or the part function directly).
//  3. Widths default to 40 / 80 / 120. Add a narrow/wide case when the layout
//     changes with width.
//  4. If a difference cannot be matched, register it as an exception with a
//     reason: {width?, line?, kind?, reason}. The harness fails on stale
//     exceptions, so a fixed difference must remove its exception. Also list
//     it in the DevNote.
//
// Env comes FIRST: both sides must colourise the same way. setup.mjs does not
// set these, so this file does, before any import of ink / view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Text, Box, renderToString, Entry, drawEntry, drawLive, drawNote, P;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Text, Box, renderToString} = await import('ink'));
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry, drawLive} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawNote} = await import('../src/ui/fs/draw/entries/note.mjs'));
  P = await import('../src/ui/fs/draw/primitives.mjs');
});

// --- the harness itself -----------------------------------------------------
test('harness: a text mismatch is reported', () => {
  assert.throws(() => parity.checkParity({name: 'x', react: () => ['a'], draw: () => ['b']}), /line 0 \[text\]/);
});

test('harness: a style mismatch is reported', () => {
  assert.throws(() => parity.checkParity({
    name: 'x',
    react: W => parity.reactLines(h(Text, {color: '#f06e6e'}, 'x'), W),
    draw: () => ['x'],
  }), /\[style\]/);
});

test('harness: a registered exception lets a real mismatch pass, and goes stale when the mismatch is fixed', () => {
  const ex = [{reason: 'deliberate, for the harness test'}];
  const used = parity.checkParity({name: 'x', react: () => ['a'], draw: () => ['b'], exceptions: ex});
  assert.equal(used.length, 1);
  assert.throws(() => parity.checkParity({name: 'x', react: () => ['a'], draw: () => ['a'], exceptions: ex}), /stale exceptions/);
});

test('harness: reactLines of an empty box and of null is []', () => {
  assert.deepEqual(parity.reactLines(h(Box, {flexDirection: 'column', marginBottom: 1}), 40), []);
  assert.deepEqual(parity.reactLines(null, 40), []);
});

// --- shared primitives, pinned against Ink ----------------------------------
test('primitives: wrapInk matches Ink wrap on plain text', () => {
  const s = 'aa bb cc dd ee';
  parity.checkParity({
    name: 'wrap plain', widths: [10],
    react: W => renderToString(h(Text, {wrap: 'wrap'}, s), {columns: W}).split('\n'),
    draw: W => P.wrapInk(s, W),
  });
});

test('primitives: wrapInk keeps a break space inside a styled span, like Ink', () => {
  const s = 'aa ' + P.c.bold('bb cc dd ee') + ' ff';
  parity.checkParity({
    name: 'wrap styled cross', widths: [10],
    react: W => renderToString(h(Text, {wrap: 'wrap'}, s), {columns: W}).split('\n'),
    draw: W => P.wrapInk(s, W),
  });
  const whole = P.c.bold('aa bb cc dd ee');
  parity.checkParity({
    name: 'wrap styled whole', widths: [10],
    react: W => renderToString(h(Text, {wrap: 'wrap'}, whole), {columns: W}).split('\n'),
    draw: W => P.wrapInk(whole, W),
  });
});

test('primitives: wrapInk matches Ink on long words and spaces', () => {
  const cases = [
    'aaa bbbbbbbbbbbbbbbb',
    'aaa bbbbbbbbbbbbbbbbbb',
    'aaa bbb ccc dddddddddddddddddd eee',
    'aaa bbb ccc bbbbbbbbbbbbbbbb eee',
    'aaa  bbb   ccc',
    'aaa bbb ',
    ' aaa bbb',
    'aaa bbb cccccccccc',
  ];
  for (const s of cases) {
    parity.checkParity({
      name: 'wrap ' + JSON.stringify(s), widths: [10],
      react: W => renderToString(h(Text, {wrap: 'wrap'}, s), {columns: W}).split('\n'),
      draw: W => P.wrapInk(s, W),
    });
  }
});

test('primitives: truncateEnd keeps the open style across the …', () => {
  const bold = P.c.bold('aaa bbb ccc ddd');
  parity.checkParity({
    name: 'truncate styled', widths: [10],
    react: W => renderToString(h(Text, {wrap: 'truncate-end'}, bold), {columns: W}).split('\n'),
    draw: W => [P.truncateEnd(bold, W)],
  });
  const coloured = P.c.accent('aaa bbb ccc ddd');
  parity.checkParity({
    name: 'truncate coloured', widths: [10],
    react: W => renderToString(h(Text, {wrap: 'truncate-end'}, coloured), {columns: W}).split('\n'),
    draw: W => [P.truncateEnd(coloured, W)],
  });
  // The '…' carries the style of the last kept character: a span that starts
  // exactly at the cut does not reach it, and a reset after the last kept
  // character does not clear it (stage C; B4 pinned the boundary against
  // Ink first).
  const boundary = P.c.gray('aaaa') + P.c.accent('bbbb cccc');
  parity.checkParity({
    name: 'truncate span at the cut', widths: [5],
    react: W => renderToString(h(Text, {wrap: 'truncate-end'}, boundary), {columns: W}).split('\n'),
    draw: W => [P.truncateEnd(boundary, W)],
  });
  const reset = P.c.gray('aaaa') + 'bbbb cccc';
  parity.checkParity({
    name: 'truncate reset at the cut', widths: [5],
    react: W => renderToString(h(Text, {wrap: 'truncate-end'}, reset), {columns: W}).split('\n'),
    draw: W => [P.truncateEnd(reset, W)],
  });
  const second = P.c.accent('aa') + P.c.gray('bb') + 'cccc dddd';
  parity.checkParity({
    name: 'truncate second span kept', widths: [5],
    react: W => renderToString(h(Text, {wrap: 'truncate-end'}, second), {columns: W}).split('\n'),
    draw: W => [P.truncateEnd(second, W)],
  });
});

test('primitives: hanging trims the line end like Ink\'s output stage', () => {
  assert.deepEqual(P.hanging('  ', 'x ', {width: 10}), ['  x']);
  assert.deepEqual(P.hanging('  ', 'a b ', {width: 10, wrapMode: 'truncate-end'}), ['  a b']);
});

// --- the registry: every kind is implemented (stage C) -----------------------
// Stage A/B replaced every entry kind and every live part. A well-formed
// entry of any kind draws; what still falls back (null) is an entry that
// lacks the data it draws, which the per-worker files pin down (b3/b4).
test('registry: every entry kind draws for a well-formed entry', () => {
  const ctx = parity.baseCtx(80);
  const entries = [
    {type: 'user', text: 'hi'},
    {type: 'md', text: 'x'},
    {type: 'gap'},
    {type: 'end'},
    {type: 'progress'},
    {type: 'tool', call: {command: 'code.read', ok: true, summary: 'x', view: {lines: 1}}},
    {type: 'past', steps: [{title: 'x'}]},
    {type: 'focus', focus: {status: 'running', round: 1, maxRounds: 1, criteria: []}},
    {type: 'todos', todos: []},
    {type: 'agent', snap: {state: 'done', result: 'ok'}},
    {type: 'shellout', id: 'bg1', running: true, lines: []},
    {type: 'muse'},
    {type: 'sources'},
    {type: 'help'},
    {type: 'note', lines: ['x']},
  ];
  for (const e of entries) assert.notEqual(drawEntry(e, ctx), null, e.type);
  // status and banner draw from the controller's state.
  const agent = {client: {status: 'connected'}, session: {title: 't', id: 'sess-1', turns: 0}, cwd: 'C:\\x', mode: 'default', device: {connected: true}, nodeSlot: {slot: 2}};
  agent.constructor = {DEVICE: 'mizuki CLI (muser)'};
  const ctrl = {museName: 'Muse', version: '0.3.8', agent};
  assert.notEqual(drawEntry({type: 'status'}, parity.baseCtx(80, {ctrl})), null);
  assert.notEqual(drawEntry({type: 'banner'}, parity.baseCtx(80, {ctrl})), null);
});

test('registry: drawLive draws the live area, idle and busy', () => {
  const ctrl = {previewRow: () => null};
  for (const st of [{busy: false, focus: {}}, {busy: true, focus: {status: 'running'}}]) {
    const frame = drawLive(st, parity.baseCtx(80, {ctrl}));
    assert.ok(frame && Array.isArray(frame.lines) && frame.lines.length > 0);
  }
});

// --- example: note (stage A shows how to write a case) ----------------------
const noteCases = [
  {name: 'note: one short line', e: {type: 'note', lines: ['あとで見直す']}},
  {name: 'note: long wrapping line', e: {type: 'note', lines: ['これは長いメモです。幅が狭いと折り返されます。English words wrap too when the line is long enough to exceed the width.']}},
  {name: 'note: error', e: {type: 'note', level: 'error', lines: ['失敗しました。もう一度ためしてください。']}},
  {name: 'note: error long', e: {type: 'note', level: 'error', lines: ['エラーが起きました。とても長い説明がここに続きます。幅 40 でも 120 でも同じ見た目になるはずです。']}},
  {name: 'note: several lines', e: {type: 'note', lines: ['1 行目', '2 行目', '3 行目']}},
  {name: 'note: empty line inside', e: {type: 'note', lines: ['上', '', '下']}},
  {name: 'note: no lines', e: {type: 'note', lines: []}},
];
for (const c of noteCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('note: drawEntry dispatches to drawNote', () => {
  const e = {type: 'note', lines: ['x']};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawNote(e, parity.baseCtx(80)));
});
