'use strict';
// md.mjs renders with term.js colours, which are off when stdout is not a TTY
// (as under `node --test`), so rows compare as plain text here.
const test = require('node:test');
const assert = require('node:assert');

test('md row: fenced blocks, and a mismatched fence does not close the block', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(40);
  assert.deepEqual(md.row('```js'), {prefix: '╭─ ', text: 'js'});
  assert.deepEqual(md.row('const x = 1;'), {prefix: '│ ', text: 'const x = 1;', code: true});
  assert.deepEqual(md.row('~~~'), {prefix: '│ ', text: '~~~', code: true}, '~~~ inside a ``` block is content');
  assert.deepEqual(md.row('```'), {prefix: '╰─', text: ''});
  assert.equal(md.row('after').text, 'after', 'back to normal lines');
  const tilde = createMd(40);
  assert.equal(tilde.row('~~~').text, 'code');
  assert.deepEqual(tilde.row('```'), {prefix: '│ ', text: '```', code: true}, '``` inside a ~~~ block is content');
  assert.deepEqual(tilde.row('~~~'), {prefix: '╰─', text: ''});
});

test('md row: headings, task list and quote', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(40);
  assert.equal(md.row('# Title').text, 'Title');
  assert.equal(md.row('### Sub heading').text, 'Sub heading');
  const todo = md.row('- [ ] write tests');
  assert.match(todo.prefix, /☐/); assert.equal(todo.text, 'write tests');
  const done = md.row('- [x] ship it');
  assert.match(done.prefix, /☒/); assert.equal(done.text, 'ship it');
  const bullet = md.row('- plain');
  assert.match(bullet.prefix, /•/); assert.equal(bullet.text, 'plain');
  const quote = md.row('> quoted **words**');
  assert.equal(quote.prefix, '▎ '); assert.equal(quote.text, 'quoted words');
});

test('md row: table separator is a rule, data cells go through inline()', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(40);
  const head = md.row('| Name | **Value** |');
  assert.match(head.text, /Name/); assert.match(head.text, /Value/);
  assert.ok(!head.text.includes('**'), 'header markup is formatted, not raw');
  const sep = md.row('| --- | ---: |');
  assert.match(sep.text, /┼/); assert.match(sep.text, /─/); assert.equal(sep.code, true);
  const data = md.row('| `x.js` | [docs](https://example.com) |');
  assert.ok(!data.text.includes('`'), 'code span in a cell is formatted');
  assert.match(data.text, /x\.js/); assert.match(data.text, /docs https:\/\/example\.com/);
});

test('md inline: pre-existing U+E000/U+E001 placeholders survive and never print undefined', async () => {
  const {inline} = await import('../src/ui/md.mjs');
  const alien = 'a \uE0005\uE001 b';
  assert.equal(inline(alien), alien);
  assert.equal(inline('\uE00099\uE001'), '\uE00099\uE001');
  assert.equal(inline('`x` and \uE0000\uE001'), 'x and \uE0000\uE001');
  assert.ok(!inline('pre \uE0001\uE001 post').includes('undefined'));
});

test('md inline: link URLs keep balanced parentheses', async () => {
  const {inline} = await import('../src/ui/md.mjs');
  const out = inline('[Wiki](https://en.wikipedia.org/wiki/A_(b))');
  assert.match(out, /Wiki https:\/\/en\.wikipedia\.org\/wiki\/A_\(b\)/);
  assert.equal(inline('[x](https://example.com/plain)'), 'x https://example.com/plain');
});

test('recovery: a very large streamed table does not blow the stack', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const lines = ['| a | b |', '|---|---|'];
  for (let i = 0; i < 100000; i++) lines.push('| x' + i + ' | y |');
  const rows = tableRows(lines); // used to throw RangeError via Math.max(...spread)
  assert.equal(rows.length, 100002);
});

test('md createMd: default width follows the terminal columns', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const expected = Math.max(8, process.stdout.columns || 40);
  assert.equal(createMd().row('---').text, '─'.repeat(expected));
  assert.equal(createMd(20).row('---').text, '─'.repeat(20), 'explicit width still wins');
});
