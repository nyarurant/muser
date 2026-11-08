'use strict';
// Fullscreen buttons (src/ui/fs/buttons.mjs): labels are found by display column, an
// underline never changes a row's width or text, the prompt border keeps its width with
// [貼り付け] [送信 ⏎] on it, and the footer labels name the right actions.
process.env.MUSER_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const {width, strip} = require('../src/tui/term.js');

let B;
test.before(async () => { B = await import('../src/ui/fs/buttons.mjs'); });

test('findCols counts wide characters as two columns', () => {
  assert.deepEqual(B.findCols('  ⏵⏵ 編集は自動   ● 3', '● 3'), {x0: 18, x1: 21, at: 13});
  assert.equal(B.findCols('abc', 'x'), null);
  assert.equal(B.findCols('abc', ''), null);
});

test('underlineCols keeps the text and width, and closes the underline', () => {
  const line = '\x1b[38;2;1;2;3m 毎回確認\x1b[0m   rest';
  const out = B.underlineCols(line, 1, 9);
  assert.equal(strip(out), strip(line));
  assert.equal(width(out), width(line));
  assert.ok(out.includes('\x1b[4m') && out.includes('\x1b[24m'));
  assert.ok(out.indexOf('\x1b[4m') < out.indexOf('毎'), 'opens before the label');
});

test('the prompt border gets paste / send buttons at the same width', () => {
  const border = '\x1b[38;2;95;95;105m╰' + '─'.repeat(78) + '╯\x1b[0m';
  const b = B.promptBorderButtons(border, {canSend: true});
  assert.ok(b);
  assert.equal(width(b.line), width(border));
  const plain = strip(b.line);
  assert.match(plain, /^╰─+ \[貼り付け\] \[送信 ⏎\] ─╯$/);
  const paste = b.regions.find(r => r.id === 'paste'), send = b.regions.find(r => r.id === 'send');
  assert.equal(B.findCols(plain, '[貼り付け]').x0, paste.x0);
  assert.equal(B.findCols(plain, '[送信 ⏎]').x0, send.x0);
  assert.equal(B.promptBorderButtons('╰' + '─'.repeat(10) + '╯', {canSend: true}), null, 'too narrow: unchanged');
  assert.equal(B.promptBorderButtons('│ text │', {canSend: true}), null, 'not a border');
});

test('footer targets: mode, account, weekly usage', () => {
  const ids = B.footerTargets({mode: 'auto-edit', account: {label: '3'}, plan: {percentUsed: 42}});
  assert.deepEqual(ids.map(x => x[1]), ['mode', 'account', 'usage']);
  assert.equal(ids[0][0].startsWith('⏵⏵ '), true);
  assert.equal(ids[2][0], '週 42%');
});

test('runButton maps each id to the controller call', () => {
  const calls = [];
  const ctrl = {get: () => ({busy: true, text: ''}), key: (i, k) => calls.push(['key', i, Object.keys(k).join()]), pasteFromClipboard: () => calls.push(['paste']), pasteImage: () => calls.push(['image']), cycleMode: () => calls.push(['mode']), submit: x => calls.push(['submit', x])};
  for (const id of ['send', 'paste', 'image', 'mode', 'interrupt', 'slash', 'at', 'bang', 'account', 'usage']) B.runButton(id, ctrl);
  let scrolled = false; B.runButton('bottom', ctrl, {scrollToBottom: () => { scrolled = true; }});
  assert.ok(scrolled);
  assert.deepEqual(calls, [['key', '', 'return'], ['paste'], ['image'], ['mode'], ['key', '', 'escape'], ['key', '/', ''], ['key', '@', ''], ['key', '!', ''], ['submit', '/account'], ['submit', '/usage']]);
  const idle = []; B.runButton('interrupt', {get: () => ({busy: false}), key: () => idle.push(1)});
  assert.equal(idle.length, 0, 'interrupt does nothing while idle');
  const typed = []; B.runButton('slash', {get: () => ({text: 'abc'}), key: () => typed.push(1)});
  assert.equal(typed.length, 0, '/ only on an empty line');
});
