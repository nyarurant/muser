'use strict';
// Fix phase 2 (agent A3): src/ui/md.mjs + src/ui/sanitize.mjs Medium findings.
// Colours are off under `node --test` (not a TTY), so rows compare as plain text.
const test = require('node:test');
const assert = require('node:assert');
const BS = String.fromCharCode(92);

test('fix2 md: a long run of [ without ] is not quadratic (deep #209 / c24#4)', async () => {
  const {inline} = await import('../src/ui/md.mjs');
  const t0 = Date.now();
  const out = inline('['.repeat(100000));
  const ms = Date.now() - t0;
  assert.equal(out, '['.repeat(100000));
  assert.ok(ms < 1500, 'inline took ' + ms + 'ms for 100k brackets (was ~3500ms)');
  assert.equal(inline('[docs](https://example.com)'), 'docs https://example.com', 'ordinary links still format');
});

test('fix2 md: double-backtick spans and escaped backticks survive (deep #210 / c24#5)', async () => {
  const {inline} = await import('../src/ui/md.mjs');
  assert.equal(inline('``a `b` c``'), 'a `b` c');
  assert.equal(inline('a ' + BS + '`not code' + BS + '` b'), 'a `not code` b');
  assert.equal(inline('`x` and ``y ` z``'), 'x and y ` z');
  assert.equal(inline('a `unclosed'), 'a `unclosed', 'an unmatched run stays literal');
});

test('fix2 md: an escaped backslash does not escape the table delimiter (deep #211 / c24#6)', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const rows = tableRows(['| x' + BS + BS + '| z |', '|---|---|']);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].text.includes('z'), 'the second cell survives: ' + JSON.stringify(rows[0].text));
  assert.equal([...rows[0].text].filter(ch => ch === BS).length, 1, '\\\\ in a cell renders as one backslash');
  const esc = tableRows(['| a' + BS + '|b | c |', '|---|---|']);
  assert.ok(esc[0].text.includes('a|b'), 'an escaped pipe stays inside its cell');
});

test('fix2 md: a rule-shaped data row is only a rule in delimiter position (deep #212 / c24#7)', async () => {
  const {tableRows, createMd} = await import('../src/ui/md.mjs');
  const first = tableRows(['| - | - |', '| x | y |']);
  assert.ok(first[0].text.includes('-'), 'a leading | - | - | row is data, not a rule');
  assert.ok(!first[0].text.includes('┼'));
  const third = tableRows(['| a | b |', '|---|---|', '| - | - |']);
  assert.ok(third[2].text.includes('-'), 'a rule-shaped third row stays data');
  const sep = createMd(40).row('| --- | ---: |');
  assert.ok(sep.text.includes('┼'), 'a lone separator line still renders as a rule');
});

test('fix2 md: a fence closes only on a bare same-char run at least as long (first #28)', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(40);
  assert.equal(md.row('````md').text, 'md');
  assert.equal(md.row('```js').code, true, 'a shorter info fence inside is content');
  assert.equal(md.row('```').code, true, 'a shorter bare run inside is content');
  assert.deepEqual(md.row('````'), {prefix: '╰─', text: ''});
  assert.equal(md.row('after').text, 'after');
  const inner = createMd(40);
  inner.row('```');
  assert.equal(inner.row('```js').code, true, 'an info fence inside a block does not close it');
  assert.deepEqual(inner.row('```'), {prefix: '╰─', text: ''});
});

test('fix2 md: tabs in code blocks expand to 2-column stops (r1-14)', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(40);
  md.row('```');
  assert.equal(md.row('\tx').text, '  x');
  assert.equal(md.row('a\tb').text, 'a b');
  assert.equal(md.row('ab\tc').text, 'ab  c');
});

test('fix2 md: one-column tables keep their borders (r1-15)', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const rows = tableRows(['| only |', '|---|', '| v1 |']);
  assert.ok(rows[0].text.startsWith('│') && rows[0].text.endsWith('│'), JSON.stringify(rows.map(r => r.text)));
  assert.ok(rows[2].text.startsWith('│') && rows[2].text.endsWith('│'));
  assert.equal(rows[0].text.length, rows[1].text.length, 'rule and data rows line up');
});

test('fix2 md: a table without a delimiter row still gets a header rule (r1-16)', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const rows = tableRows(['| HA | HB |', '| v1 | v2 |']);
  assert.equal(rows.length, 3, 'a rule row is synthesised under the header');
  assert.ok(rows[1].text.includes('┼'));
  assert.ok(rows[0].text.includes('HA') && rows[2].text.includes('v1'));
});

test('fix2 md: nested quotes repeat the bar per level (r1-19)', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(40);
  const a = md.row('> > nested');
  assert.equal(a.prefix, '▎▎ '); assert.equal(a.text, 'nested');
  const b = md.row('>> nested');
  assert.equal(b.prefix, '▎▎ '); assert.equal(b.text, 'nested');
  assert.equal(md.row('> flat').prefix, '▎ ', 'a single level is unchanged');
});

test('fix2 md: ragged tables render with uniform row widths (r1-3, whole-table path)', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const rows = tableRows(['| A | B | C |', '|---|---|---|', '| 1 | 2 |', '| 4 | 5 | 6 | 7 |']);
  const lens = rows.map(r => r.text.length);
  assert.ok(lens.every(n => n === lens[0]), 'all rows share one width: ' + JSON.stringify(rows.map(r => r.text)));
});

test('fix2 sanitize: fence state survives one-line, mixed and longer fences (deep #107 / c13#10)', async () => {
  const {sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  const tok = '[[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]';
  assert.equal(sanitizeEmbeds('```x```\n' + tok), '```x```\n' + P, 'a token after a one-line fence is still scrubbed');
  const mixed = '```\n~~~\n' + tok + '\n```';
  assert.equal(sanitizeEmbeds(mixed), mixed, 'the other fence char inside a block does not close it');
  const longer = '````\n```\n' + tok + '\n````';
  assert.equal(sanitizeEmbeds(longer), longer, 'a shorter run inside a longer fence does not close it');
  const tilde = '~~~\n' + tok + '\n~~~\n' + tok;
  assert.equal(sanitizeEmbeds(tilde), '~~~\n' + tok + '\n~~~\n' + P, '~~~ fences quote too');
  assert.equal(stripEmbeds('```x```\n' + tok + '\n後'), '```x```\n後');
});

test('fix2 sanitize: prose [[word: ... ]] is not a long token (deep #108 / c13#11)', async () => {
  const {sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  const prose = '説明 [[foo: 開始\n大事な本文です\n末尾 arr[i]] の後';
  assert.equal(sanitizeEmbeds(prose), prose);
  assert.equal(stripEmbeds(prose), prose);
  const long = '[[hatch_widget:widget-' + 'a'.repeat(400) + ']]';
  assert.equal(sanitizeEmbeds('前 ' + long + ' 後'), '前 ' + P + ' 後', 'a genuine long hatch token is still scrubbed');
  const multi = '[[hatch_widget:widget-abc\ndef]]';
  assert.equal(sanitizeEmbeds('前 ' + multi + ' 後'), '前 ' + P + ' 後', 'a genuine multi-line hatch token is still scrubbed');
});

test('fix2 sanitize: bidi and zero-width controls are stripped, ZWJ survives (deep #109 / c13#12)', async () => {
  const {stripControls} = await import('../src/ui/sanitize.mjs');
  assert.equal(stripControls('a\u202Etxt'), 'atxt');
  assert.equal(stripControls('x\u200B\uFEFF\u2066\u2069\u061C\u200Fy'), 'xy');
  assert.equal(stripControls('a\u200Db'), 'a\u200Db', 'ZWJ (emoji sequences) is kept');
});

test('fix2 sanitize: a token whose payload contains a single ] is scrubbed (deep #110 / c13#13)', async () => {
  const {sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  assert.equal(sanitizeEmbeds('[[hatch_widget:widget-ab]cd-1234]]'), P);
  assert.equal(stripEmbeds('a [[hatch_widget:widget-ab]cd-1234]] b'), 'a  b');
});

test('fix2 sanitize: an embed_token: prose line is ordinary text (third M17)', async () => {
  const {sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  assert.equal(sanitizeEmbeds('embed_token: hello world'), 'embed_token: hello world');
  assert.equal(stripEmbeds('embed_token: hello world\n残る'), 'embed_token: hello world\n残る');
  assert.equal(sanitizeEmbeds('embed_token: widget-123e4567-e89b-12d3-a456-426614174000'), P, 'a bare id reference is still a placeholder');
  assert.equal(stripEmbeds('embed_token: widget-123e4567\n残る'), '残る', 'a bare id line still vanishes in stripEmbeds');
});

test('fix2 sanitize: a multi-line streaming token is held back whole (first #27)', async () => {
  const {partialEmbedTail, sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  const frag = '[[hatch_widget:widget-abc\ndef';
  assert.equal(partialEmbedTail('本文 ' + frag), frag);
  assert.equal(partialEmbedTail('本文 ' + frag, 1000000), frag);
  assert.equal(sanitizeEmbeds('本文 ' + frag), '本文 ' + P, 'a trailing multi-line partial becomes the placeholder, not raw text');
  assert.equal(stripEmbeds('本文 ' + frag), '本文 ');
  assert.equal(partialEmbedTail('普通の文\n次の行'), '', 'ordinary multi-line text is not held');
});
