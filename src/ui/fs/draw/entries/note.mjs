// Draws the 'note' entry (stage A example for stage-B workers).
// Mirrors view.mjs Entry case 'note': a column with marginBottom 1; each line is
// a hanging row — a 2-cell mark ('✗ ' for errors, '  ' otherwise) plus the text
// wrapped at cols-2. The root has no explicit width, so it lays out at cols
// (the renderToString columns, W + 1), not at W. Error lines are #f06e6e
// (c.red), the rest GRAY (c.gray). An entry with no lines draws nothing
// (an empty box renders nothing).
import {c, hanging} from '../primitives.mjs';

export function drawNote(e, ctx) {
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
