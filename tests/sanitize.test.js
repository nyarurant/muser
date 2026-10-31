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
  // Consecutive embed lines collapse to a single placeholder line.
  assert.equal(sanitizeEmbeds('[[hatch_widget:widget-aaaaaaaa-0000-0000-0000-000000000000]]\n[[hatch_widget:widget-bbbbbbbb-0000-0000-0000-000000000000]]\n本文'), P + '\n本文');
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

test('partialEmbedTail: only an unfinished short [[ fragment is held back', async () => {
  const {partialEmbedTail} = await import('../src/ui/sanitize.mjs');
  assert.equal(partialEmbedTail('本文 [[hatch_wid'), '[[hatch_wid');
  assert.equal(partialEmbedTail('本文 [[hatch_widget:widget-123]]'), '');
  assert.equal(partialEmbedTail('普通の文'), '');
  assert.equal(partialEmbedTail('[[' + 'x'.repeat(200)), '');
});
