// Draws the 'overnight' entry (night work: queue lists and morning reports).
// Mirrors view.mjs Entry case 'overnight': like 'note', a column with
// marginBottom 1 where each line is a hanging row — a 2-cell moon mark in the
// accent colour plus the text in GRAY wrapped at cols-2. An entry with no
// lines draws nothing.
import {c, hanging} from '../primitives.mjs';

export function drawOvernight(e, ctx) {
  const lines = e.lines || [];
  if (!lines.length) return [];
  const mark = c.accent('☾ ');
  const out = [];
  for (const l of lines) out.push(...hanging(mark, c.gray(String(l)), {width: ctx.cols, wrapMode: 'wrap'}));
  out.push('');
  return out;
}
