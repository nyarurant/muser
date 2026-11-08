// Draws the 'hunt' entry: the bug-hunt lines (/hunt status, the estimate,
// the audit / fix summaries). Mirrors view.mjs Entry case 'hunt', which is
// the note shape: a column with marginBottom 1, each line a hanging row —
// a 2-cell mark ('✗ ' for errors, '  ' otherwise) plus the text wrapped at
// cols-2, GRAY (c.gray) or #f06e6e (c.red) for errors. An entry with no
// lines draws nothing.
import {c, hanging} from '../primitives.mjs';

export function drawHunt(e, ctx) {
  const lines = e.lines || [];
  if (!lines.length) return [];
  const error = e.level === 'error';
  const color = error ? c.red : c.gray;
  const mark = color(error ? '✗ ' : '  ');
  const out = [];
  for (const l of lines) out.push(...hanging(mark, color(String(l)), {width: ctx.cols, wrapMode: 'wrap'}));
  out.push('');
  return out;
}
