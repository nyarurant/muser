// Draws the 'race' entry （競争の結果）. Mirrors view.mjs Entry case 'race':
// a column with marginBottom 1; each line is a hanging row — a 2-cell blank
// mark plus the text wrapped at cols-2, all GRAY (c.gray). An entry with no
// lines draws nothing.
import {c, hanging} from '../primitives.mjs';

export function drawRace(e, ctx) {
  const lines = e.lines || [];
  if (!lines.length) return [];
  const out = [];
  for (const l of lines) out.push(...hanging(c.gray('  '), c.gray(String(l)), {width: ctx.cols, wrapMode: 'wrap'}));
  out.push('');
  return out;
}
