// Draws the live prompt block.
// Mirrors view.mjs Prompt (and promptCaret): a round-bordered box, width W,
// marginTop 1, paddingX 1. The head is '❯ ' (or t('理由 ') while refusing);
// the text is laid out with layout() and shown through a window of at most
// max rows around the caret, with DIM '↑/↓ ほか … 行' rows above/below.
// Returns {lines, caret} or null; caret is {row, col} relative to this block's
// first line (the margin blank line), col from the box's left edge (border 0,
// padding 1, head, then the caret column inside the text).
//
// Caret row, verified against renderToString + promptCaret (probe 2026-11-06):
// the React Live output is ['', top border, above?, text rows…, below?, bottom
// border, footer…], and promptCaret.row counts text rows from the first text
// row, so caret.row = 2 (margin + top border) + (above ? 1 : 0) +
// (cur.row - start). The task brief's '+1' formula would land on the border
// (or the above row); it omits the margin line that drawPrompt's lines
// include so that drawPrompt lines equal the first N React Live lines.
// t() is NOT exported by primitives.mjs, so it is required from i18n.js here
// (same createRequire pattern as primitives.mjs).
import {createRequire} from 'node:module';
import {width, layout, roundBox, truncateEnd, hex} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

const ACCENT = '#b4a0ff', DIM = '#5f5f69', GOLD = '#e6be64', BUSY_BORDER = '#3c3c44';

export function drawPrompt(s, ctx) {
  const state = s || {};
  const W = ctx?.W;
  const text = String(state.text ?? '');
  const pos = typeof state.pos === 'number' ? state.pos : 0;
  const reason = !!state.reasonFor;
  const bang = !reason && text.trimStart().startsWith('!');
  const head = reason ? t('理由 ') : '❯ ';
  const headW = width(head);
  const inner = W - 4 - headW;
  const {lines: all, cur} = layout(text, pos, inner);
  const max = Math.max(4, Math.min(30, (ctx?.rows ?? 30) - 14));
  const start = all.length <= max ? 0 : Math.max(0, Math.min(cur.row - Math.floor(max / 2), all.length - max));
  const lines = all.slice(start, start + max);
  const above = start, below = all.length - start - lines.length;
  const placeholder = state.addFlow ? (state.promptFor ? t('ここに入力して Enter') : t('アカウントを追加しています…')) : reason ? t('断る理由（空でも可）') : W < 44 ? (state.busy ? t('Muse が作業中') : t('何をしますか？')) : state.busy ? t('Muse が作業中 · 送ると伝えます') : t('何をしますか？   / でコマンド');
  const borderColor = reason || bang ? GOLD : state.busy ? BUSY_BORDER : DIM;
  const headColor = hex(reason ? GOLD : ACCENT);
  const dim = hex(DIM);
  const pad = ' '.repeat(headW);
  const content = [];
  if (above) content.push(' ' + dim(truncateEnd(pad + t('↑ ほか {n} 行（全部で {total} 行）', {n: above, total: all.length}), W - 4)));
  lines.forEach((l, i) => {
    const headText = i + start ? pad : head;
    const body = !text && i === 0 ? dim(truncateEnd(placeholder, inner)) : truncateEnd(l || ' ', inner);
    content.push(' ' + headColor(headText) + body);
  });
  if (below) content.push(' ' + dim(truncateEnd(pad + t('↓ ほか {n} 行', {n: below}), W - 4)));
  const boxed = roundBox(content, {width: W, borderColor});
  return {
    lines: ['', ...boxed],
    caret: {row: 2 + (above ? 1 : 0) + (cur.row - start), col: 2 + headW + cur.col},
  };
}
