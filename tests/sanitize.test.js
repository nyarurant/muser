'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('sanitizeEmbeds: widget/letter/generic tokens become one placeholder line', async () => {
  const {sanitizeEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  assert.equal(sanitizeEmbeds('前\n[[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]\n後'), '前\n' + P + '\n後');
  assert.equal(sanitizeEmbeds('[[hatch_letter:letter-123e4567-e89b-12d3-a456-426614174000]]'), P);
  assert.equal(sanitizeEmbeds('[[any_word:some-uuid-ish-value-1234]]'), P);
  // Inline token inside a sentence is replaced in place.
  assert.equal(sanitizeEmbeds('見て [[hatch_widget:widget-abcdef01-2345-6789-abcd-ef0123456789]] ね'), '見て ' + P + ' ね');
  // Consecutive embed lines each keep their own placeholder line (audit #187: collapsing
  // them made sanitizeEmbeds shrink text already emitted while streaming — see below).
  assert.equal(sanitizeEmbeds('[[hatch_widget:widget-aaaaaaaa-0000-0000-0000-000000000000]]\n[[hatch_widget:widget-bbbbbbbb-0000-0000-0000-000000000000]]\n本文'), P + '\n' + P + '\n本文');
  // Bare embed_token line.
  assert.equal(sanitizeEmbeds('embed_token: widget-123e4567-e89b-12d3-a456-426614174000'), P);
  // A token cut off at the end of the stream still becomes the placeholder.
  assert.equal(sanitizeEmbeds('本文\n[[hatch_widget:widget-123e'), '本文\n' + P);
  // Ordinary text, including [[brackets]] without a word:payload shape, is untouched.
  assert.equal(sanitizeEmbeds('普通の文 [[メモ]] と [リンク](https://x)'), '普通の文 [[メモ]] と [リンク](https://x)');
});

test('stripEmbeds: tokens vanish entirely', async () => {
  const {stripEmbeds} = await import('../src/ui/sanitize.mjs');
  assert.equal(stripEmbeds('前\n[[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]\n後'), '前\n後');
  assert.equal(stripEmbeds('a [[hatch_letter:letter-123e4567-e89b-12d3-a456-426614174000]] b'), 'a  b');
  assert.equal(stripEmbeds('embed_token: widget-123e4567\n残る'), '残る');
  assert.equal(stripEmbeds('何もない'), '何もない');
});

test('sanitize: escape sequences and control characters never reach the terminal (audit #184)', async () => {
  const {sanitizeEmbeds, stripEmbeds, stripControls} = await import('../src/ui/sanitize.mjs');
  const ESC = '\x1b';
  assert.equal(stripControls('a' + ESC + '[31mred' + ESC + '[0m b'), 'ared b');
  assert.equal(stripControls('x' + ESC + ']52;c;SGVsbG8=' + '\x07' + 'y'), 'xy', 'an OSC 52 clipboard write is removed whole');
  assert.equal(stripControls('x' + ESC + ']8;;https://evil.example' + ESC + '\\link' + ESC + ']8;;' + ESC + '\\'), 'xlink', 'OSC 8 hyperlinks too');
  assert.equal(stripControls('a\x00\x07\x0b\x7fb'), 'ab', 'stray C0/DEL controls go, the text stays');
  assert.equal(stripControls('keep\tme\nlines'), 'keep\tme\nlines', 'tab and newline survive');
  assert.equal(sanitizeEmbeds('out ' + ESC + '[2J' + ESC + '[Hcleared'), 'out cleared');
  assert.equal(stripEmbeds(ESC + '[31merror' + ESC + '[0m'), 'error');
});

test('sanitize: code fences quote tokens instead of scrubbing them (audit #185)', async () => {
  const {sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  const example = '例:\n```\n[[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]\nwidget-123e4567-e89b-12d3-a456-426614174000\n```\n以上';
  assert.equal(sanitizeEmbeds(example), example, 'a fenced example is shown as written');
  assert.equal(stripEmbeds(example), example);
  const mixed = '本文 [[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]\n```\n[[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]\n```';
  assert.equal(sanitizeEmbeds(mixed), '本文 ' + P + '\n```\n[[hatch_widget:widget-123e4567-e89b-12d3-a456-426614174000]]\n```', 'prose is scrubbed, the fence is not');
});

test('partialEmbedTail: an unfinished fragment is held back up to a legal token size (audit #181)', async () => {
  const {partialEmbedTail} = await import('../src/ui/sanitize.mjs');
  assert.equal(partialEmbedTail('本文 [[hatch_wid'), '[[hatch_wid');
  assert.equal(partialEmbedTail('本文 [[hatch_widget:widget-123]]'), '');
  assert.equal(partialEmbedTail('普通の文'), '');
  // A legal token body can be 300 chars: a 200-char fragment may still become one, so it
  // is held back instead of leaking raw into scrollback (the old 120-char cap leaked it).
  assert.equal(partialEmbedTail('[[' + 'x'.repeat(200)), '[[' + 'x'.repeat(200));
  assert.equal(partialEmbedTail('[[' + 'x'.repeat(400)), '', 'past the legal maximum it is literal text');
});

test('sanitize: long and multi-line tokens are scrubbed too (audit #186)', async () => {
  const {sanitizeEmbeds, stripEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  const long = '[[hatch_widget:widget-' + 'a'.repeat(400) + ']]';
  assert.equal(sanitizeEmbeds('前 ' + long + ' 後'), '前 ' + P + ' 後', 'a >300-char token does not leak raw');
  assert.equal(stripEmbeds('前 ' + long + ' 後'), '前  後');
  const multiline = '[[hatch_widget:widget-abc\ndef]]';
  assert.equal(sanitizeEmbeds('前 ' + multiline + ' 後'), '前 ' + P + ' 後', 'a token spanning a newline is scrubbed whole');
  assert.ok(!stripEmbeds('前 ' + multiline + ' 後').includes('[['));
  const fenced = '```\n' + long + '\n```';
  assert.equal(sanitizeEmbeds(fenced), fenced, 'inside a fence even a long token is a quotation (#185)');
});

test('sanitizeEmbeds is prefix-stable as a second widget streams in (audit #187)', async () => {
  const {sanitizeEmbeds, WIDGET_PLACEHOLDER: P} = await import('../src/ui/sanitize.mjs');
  const one = sanitizeEmbeds('[[hatch_widget:widget-aaaaaaaa-0000-0000-0000-000000000000]]\n');
  const two = sanitizeEmbeds('[[hatch_widget:widget-aaaaaaaa-0000-0000-0000-000000000000]]\n[[hatch_widget:widget-bbbbbbbb-0000-0000-0000-000000000000]]\n本文');
  assert.ok(two.startsWith(one), 'the clean text only grows: ' + JSON.stringify({one, two}));
  assert.equal(two, P + '\n' + P + '\n本文');
});
