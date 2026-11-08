// Draws the live limit-input block: label, inner prompt, and the enter/esc hint line.
// Mirrors the limitInput branch of view.mjs Live(): an accent label Text, the
// Prompt for the limit text (busy forced off, caret at the end), and a dim hint
// Text (the flash, when present, rides along with the enter/esc keys).
// The Prompt is drawn here, not via drawPrompt: its box is round-bordered
// (dim, or #e6be64 for a bang text), paddingX 1, width W, marginTop 1, with a
// window of layout rows around the caret and dim above/below count lines.
// Returns {lines, caret}; caret is {row, col} relative to this block's first line.
import {createRequire} from 'node:module';
import {c, width, pad, roundBox, truncateEnd, wrapInk, layout} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

export function drawLimitInput(s, ctx) {
  const li = s?.limitInput;
  if (!li) return null;
  const W = ctx.W, rows = ctx.rows || 30;
  const label = li.label || (li.key === 'concurrent' ? t('同時に動かすエージェント数') : t('1タスクで起動できる合計数'));
  const labelLines = wrapInk(c.accent(label), W);
  // --- the inner Prompt, with {...s, text: li.text, pos: end, busy: false, reasonFor: null}
  const text = String(li.text ?? ''), pos = text.length;
  const bang = text.trimStart().startsWith('!');
  const head = '❯ ', inner = W - 4 - width(head);
  const {lines: all, cur} = layout(text, pos, inner);
  const max = Math.max(4, Math.min(30, rows - 14));
  const start = all.length <= max ? 0 : Math.max(0, Math.min(cur.row - Math.floor(max / 2), all.length - max));
  const shown = all.slice(start, start + max), above = start, below = all.length - start - shown.length;
  const placeholder = W < 44 ? t('何をしますか？') : t('何をしますか？   / でコマンド');
  const contentW = W - 4;
  const contents = [];
  if (above) contents.push(...wrapInk(c.faint(' '.repeat(width(head)) + t('↑ ほか {n} 行（全部で {total} 行）', {n: above, total: all.length})), contentW));
  shown.forEach((l, i) => {
    const headPart = c.accent(i + start ? ' '.repeat(width(head)) : head);
    const body = !text && i === 0 ? c.faint(placeholder) : (l || ' ');
    contents.push(headPart + truncateEnd(body, inner));
  });
  if (below) contents.push(...wrapInk(c.faint(' '.repeat(width(head)) + t('↓ ほか {n} 行', {n: below})), contentW));
  const boxed = roundBox(contents.map(l => ' ' + pad(l, contentW) + ' '), {width: W, borderColor: bang ? '#e6be64' : '#5f5f69'});
  const hint = s.flash ? s.flash + ' · ' + t('enter で確定 · esc で戻る') : (li.hint || t('0 は無制限')) + ' · ' + t('enter で確定 · esc で戻る');
  const lines = [...labelLines, '', ...boxed, ...wrapInk(c.faint(hint), W)];
  const caret = {row: labelLines.length + 2 + (above ? 1 : 0) + (cur.row - start), col: 2 + width(head) + cur.col};
  return {lines, caret};
}
