'use strict';
// Parity tests for stage-B B1: user, md, gap, end entries.
// Same shape as tests/fs-parity.test.js (note example): the React side is
// the truth, widths default to 40 / 80 / 120.
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

let parity, Entry, drawEntry, drawUser, drawMd, drawGap, drawEnd, createMd;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawUser} = await import('../src/ui/fs/draw/entries/user.mjs'));
  ({drawMd} = await import('../src/ui/fs/draw/entries/md.mjs'));
  ({drawGap} = await import('../src/ui/fs/draw/entries/gap.mjs'));
  ({drawEnd} = await import('../src/ui/fs/draw/entries/end.mjs'));
  ({createMd} = await import('../src/ui/md.mjs'));
});

// --- user -------------------------------------------------------------------
const USER_LONG = 'これはとても長いメッセージです。幅が狭いと何行にも折り返されます。English words wrap too when the line is long enough to exceed the available width.';
const USER_MENTION_LONG = 'こんにちは @tanaka さん、これはとても長いメッセージです。幅が狭いと折り返されます。English words wrap too when the line is long enough.';
const userCases = [
  {name: 'user: short', e: {type: 'user', text: 'こんにちは、これは短いメッセージです。'}},
  {name: 'user: long wrapping', e: {type: 'user', text: USER_LONG}},
  {name: 'user: mention short', e: {type: 'user', text: '@tanaka こんにちは'}},
  {name: 'user: mention long', e: {type: 'user', text: USER_MENTION_LONG}},
  {name: 'user: mention at start wrapping', e: {type: 'user', text: '@tanaka ' + USER_LONG}, exceptions: [
    {width: 40, line: 6, kind: 'text', reason: 'Ink/Yoga flex measurement: the Text inside the ❯ row measures one row taller than the raw wrap for this input at width 40 (one hard-split word fills two wrapped rows exactly), so the bubble gains a blank background row; the raw wrap matches (5 rows) and no fixed measure width reproduces it (width 37 wraps this text to 6 rows but wraps the mention-mid text to 5, which lays out 6 tall)'},
    {width: 40, line: 7, kind: 'length', reason: 'follows from the same extra blank row: the trailing margin line moves down one'},
  ]},
  {name: 'user: mention at end', e: {type: 'user', text: 'よろしくお願いします @tanaka'}},
  {name: 'user: mention only', e: {type: 'user', text: '@tanaka'}},
  {name: 'user: empty no text prop', e: {type: 'user'}},
  {name: 'user: empty text', e: {type: 'user', text: ''}},
  {name: 'user: empty images only', e: {type: 'user', images: ['pic.png']}},
  {name: 'user: empty files only', e: {type: 'user', files: [{ref: 'src/a.js', kind: 'file', lines: 12}]}},
  {name: 'user: empty both', e: {type: 'user', files: [{ref: 'src/a.js', kind: 'file', lines: 12}], images: ['pic.png']}},
  {name: 'user: file', e: {type: 'user', text: 'これを見て', files: [{ref: 'src/ui/view.mjs', kind: 'file', lines: 951}]}},
  {name: 'user: dir', e: {type: 'user', text: 'このフォルダ', files: [{ref: 'src/ui', kind: 'dir', count: 24}]}},
  {name: 'user: large', e: {type: 'user', text: '大きいファイル', files: [{ref: 'big.bin', kind: 'large'}]}},
  {name: 'user: binary', e: {type: 'user', text: 'バイナリ', files: [{ref: 'img.png', kind: 'binary'}]}},
  {name: 'user: file no kind', e: {type: 'user', text: '種類なし', files: [{ref: 'mystery.dat'}]}},
  {name: 'user: file long ref', e: {type: 'user', text: '見て', files: [{ref: 'src/ui/fs/draw/entries/very-long-file-name-for-truncation-check.mjs', kind: 'file', lines: 1234}]}},
  {name: 'user: files multi', e: {type: 'user', text: '複数', files: [{ref: 'src/a.js', kind: 'file', lines: 3}, {ref: 'src/ui', kind: 'dir', count: 24}]}},
  {name: 'user: missing', e: {type: 'user', text: '探して', missing: ['nope.txt']}},
  {name: 'user: missing long', e: {type: 'user', text: '探して', missing: ['a-very-long-missing-file-name-that-keeps-going.txt', 'second-missing.txt']}},
  {name: 'user: missing empty list', e: {type: 'user', text: '不足なし', missing: []}},
  {name: 'user: images', e: {type: 'user', text: '画像です', images: ['cat.png', 'dog.png']}},
  {name: 'user: image long name', e: {type: 'user', text: '画像', images: ['a-very-long-image-file-name-that-keeps-going-on-and-on.png']}},
  {name: 'user: images and missing', e: {type: 'user', text: '画像と不足', images: ['a.png'], missing: ['gone.txt']}},
  {name: 'user: all together', e: {type: 'user', text: USER_LONG, files: [{ref: 'src/a.js', kind: 'file', lines: 3}, {ref: 'src/ui', kind: 'dir', count: 24}], missing: ['gone.txt'], images: ['a.png']}},
  {name: 'user: multiline simple', e: {type: 'user', text: '1行目\n2行目\n3行目'}},
  {name: 'user: multiline wrapping', e: {type: 'user', text: USER_LONG + '\n' + USER_LONG}},
  {name: 'user: newline empty middle', e: {type: 'user', text: '上\n\n下'}},
  {name: 'user: newline leading', e: {type: 'user', text: '\n下から始まる'}},
  {name: 'user: newline trailing', e: {type: 'user', text: '上で終わる\n'}},
  {name: 'user: newline trailing two', e: {type: 'user', text: '上で終わる\n\n'}},
  {name: 'user: newline only', e: {type: 'user', text: '\n'}},
  {name: 'user: multiline mention space', e: {type: 'user', text: '@tanaka こんにちは\n@bob やあ'}},
  {name: 'user: spaces only', e: {type: 'user', text: '   '}},
  {name: 'user: tab text', e: {type: 'user', text: 'a\tb\tc'}},
  {name: 'user: long word', e: {type: 'user', text: 'a'.repeat(100)}},
  {name: 'user: emoji', e: {type: 'user', text: 'こんにちは 👋 これは絵文字のテストです 🎉'}},
  // At width 40 the text column is 36 wide; 18 full-width chars fill it exactly.
  {name: 'user: exact full row', e: {type: 'user', text: 'あ'.repeat(18) + ' 続きの言葉です。'}},
];
for (const c of userCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawUser(c.e, parity.baseCtx(W)),
      exceptions: c.exceptions || [],
    });
    assert.equal(used.length, (c.exceptions || []).length);
  });
}

test('user: exact full tab', () => {
  const e = {type: 'user', text: 'これは長いテキストです。幅が狭いと折り返されます。English words wrap too\twhen the line is long enough to exceed the width.'};
  const used = parity.checkParity({
    name: 'user: exact full tab',
    react: W => parity.reactLines(h(Entry, {e, ctrl: {}, W}), W),
    draw: W => drawUser(e, parity.baseCtx(W)),
    exceptions: [{width: 80, line: 2, kind: 'text', reason: 'tab after a near-full row: wrapInk expands the tab from the string offset (72 -> 8 spaces), Ink from the absolute column (75 -> 5 spaces, row fills exactly, one space dropped at the boundary); draw keeps 1 extra leading space on the continuation row'}],
  });
  assert.equal(used.length, 1);
});

test('user: drawEntry dispatches to drawUser', () => {
  const e = {type: 'user', text: 'x'};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawUser(e, parity.baseCtx(80)));
});

// --- md ---------------------------------------------------------------------
const MD_LONG = 'これはとても長い段落です。幅が狭いと何行にも折り返されます。English words wrap too when the line is long enough to exceed the available width, and the hanging indent should stay aligned.';
const MD_LONGCODE = 'const veryLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour);';
const mdCases = [
  {name: 'md: plain short first=true', lines: ['こんにちは、これは短い段落です。'], first: true},
  {name: 'md: plain short first=false', lines: ['こんにちは、これは短い段落です。'], first: false},
  {name: 'md: plain long first=true', lines: [MD_LONG], first: true},
  {name: 'md: plain long first=false', lines: [MD_LONG], first: false},
  {name: 'md: heading #', lines: ['# 見出し1です'], first: true},
  {name: 'md: heading ###', lines: ['### 見出し3です'], first: false},
  {name: 'md: heading # long', lines: ['# ' + MD_LONG], first: true},
  {name: 'md: bullet list', lines: ['- りんご', '- バナナ', '- さくらんぼ'], first: true},
  {name: 'md: bullet nested', lines: ['- 親の項目です', '  - 子の項目1', '  - 子の項目2', '- 親2です'], first: false},
  {name: 'md: bullet long', lines: ['- ' + MD_LONG], first: true},
  {name: 'md: numbered list', lines: ['1. 一つ目', '2. 二つ目', '10. 十番目です'], first: true},
  {name: 'md: task list', lines: ['- [ ] 未完了のタスクです', '- [x] 完了したタスクです'], first: true},
  {name: 'md: blockquote', lines: ['> 引用文です。', '> 二行目の引用です。'], first: true},
  {name: 'md: blockquote nested', lines: ['>> 深い引用です。'], first: false},
  {name: 'md: blockquote long', lines: ['> ' + MD_LONG], first: true},
  {name: 'md: code fence', lines: ['```js', 'const x = 1;', 'console.log(x);', '```'], first: true},
  {name: 'md: code fence long line', lines: ['```', MD_LONGCODE, '```'], first: true},
  {name: 'md: code fence blank line', lines: ['```', 'const a = 1;', '', 'const b = 2;', '```'], first: true},
  {name: 'md: code fence tilde', lines: ['~~~', 'some text here', '~~~'], first: false},
  {name: 'md: table', lines: ['| 名前 | 値 |', '| --- | ---: |', '| りんご | 100 |', '| バナナ | 2500 |'], first: true},
  {name: 'md: table no rule', lines: ['| a | b |', '| c | d |'], first: false},
  {name: 'md: table long', lines: ['| 名前 | 説明 |', '| --- | --- |', '| りんご | ' + MD_LONG + ' |'], first: true},
  {name: 'md: hr', lines: ['---'], first: true},
  {name: 'md: inline styles', lines: ['これは **太字** と *斜体* と `code` と [リンク](https://example.com) と ~~取消線~~ です。'], first: true},
  {name: 'md: inline styles long', lines: ['これは **太字の長い文** と *斜体* と `someCode()` と [リンク](https://example.com) が混ざった長い行です。' + MD_LONG], first: false},
  {name: 'md: empty-text row', lines: [''], first: true},
  {name: 'md: empty row middle', lines: ['上の行です', '', '下の行です'], first: true},
  {name: 'md: empty row last', lines: ['上の行です', ''], first: false},
  {name: 'md: mixed doc', lines: ['# タイトル', '', '導入の段落です。' + MD_LONG, '', '- 箇条書き1', '- 箇条書き2', '', '> 引用です', '', '```js', 'f();', '```'], first: true},
  {name: 'md: rows empty', lines: [], first: true},
];
for (const c of mdCases) {
  test(c.name, () => {
    const e = {type: 'md', rows: createMd().rows(c.lines), first: c.first};
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e, ctrl: {}, W}), W),
      draw: W => drawMd(e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('md: code fence long line wraps when codeWrap is true', () => {
  const e = {type: 'md', rows: createMd().rows(['```', MD_LONGCODE, '```']), first: true};
  process.env.MUSER_CODE_WRAP = '1';
  try {
    const used = parity.checkParity({
      name: 'md: code fence long line wraps when codeWrap is true',
      react: W => parity.reactLines(h(Entry, {e, ctrl: {}, W}), W),
      draw: W => drawMd(e, parity.baseCtx(W, {codeWrap: true})),
    });
    assert.equal(used.length, 0);
  } finally {
    delete process.env.MUSER_CODE_WRAP;
  }
});

test('md: missing rows draws nothing', () => {
  assert.deepEqual(drawMd({type: 'md', first: false}, parity.baseCtx(80)), []);
});

test('md: drawEntry dispatches to drawMd', () => {
  const e = {type: 'md', rows: createMd().rows(['x']), first: true};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawMd(e, parity.baseCtx(80)));
});

// --- gap --------------------------------------------------------------------
test('gap', () => {
  const e = {type: 'gap'};
  const used = parity.checkParity({
    name: 'gap',
    react: W => parity.reactLines(h(Entry, {e, ctrl: {}, W}), W),
    draw: W => drawEntry(e, parity.baseCtx(W)),
  });
  assert.equal(used.length, 0);
});

test('gap: drawEntry dispatches to drawGap', () => {
  const e = {type: 'gap'};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawGap(e, parity.baseCtx(80)));
});

// --- end --------------------------------------------------------------------
const endCases = [
  {name: 'end: ok basic', e: {type: 'end', ok: true, ms: 1234}},
  {name: 'end: ok with usage numbers', e: {type: 'end', ok: true, ms: 1234, usage: {inputTokens: 12345, outputTokens: 678}}},
  {name: 'end: ok with usage formatted only', e: {type: 'end', ok: true, ms: 1234, usage: {formatted: '12.3k in / 456 out'}}},
  {name: 'end: ok silent', e: {type: 'end', ok: true, ms: 1234, silent: true}},
  {name: 'end: ok ms 0', e: {type: 'end', ok: true, ms: 0}},
  {name: 'end: ok ms undefined', e: {type: 'end', ok: true}},
  {name: 'end: ok long usage wrapping', e: {type: 'end', ok: true, ms: 59999, usage: {formatted: '123.4k in / 5.6k out plus a long tail of words to force the line to wrap at width forty'}}},
  {name: 'end: ok silent with usage', e: {type: 'end', ok: true, ms: 59999, silent: true, usage: {inputTokens: 130841, outputTokens: 395}}},
  {name: 'end: ok long elapsed', e: {type: 'end', ok: true, ms: 125000}},
  {name: 'end: aborted', e: {type: 'end', ok: false, aborted: true}},
  {name: 'end: aborted ignores error', e: {type: 'end', ok: false, aborted: true, error: 'some error text that must not show'}},
  {name: 'end: error short', e: {type: 'end', ok: false, error: 'Something went wrong'}},
  {name: 'end: error long wrapping', e: {type: 'end', ok: false, error: 'A very long error message that keeps going and going so it must wrap onto several lines at width 40, and the continuation lines start at column zero.'}},
  {name: 'end: error empty string', e: {type: 'end', ok: false, error: ''}},
  {name: 'end: error missing', e: {type: 'end', ok: false}},
  {name: 'end: usage zero zero', e: {type: 'end', ok: true, ms: 1234, usage: {inputTokens: 0, outputTokens: 0}}},
  {name: 'end: usage input only', e: {type: 'end', ok: true, ms: 1234, usage: {inputTokens: 100}}},
];
for (const c of endCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEnd(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('end: drawEntry dispatches to drawEnd', () => {
  const e = {type: 'end', ok: true, ms: 1234};
  assert.deepEqual(drawEntry(e, parity.baseCtx(80)), drawEnd(e, parity.baseCtx(80)));
});
