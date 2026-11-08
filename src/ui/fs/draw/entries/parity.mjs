// Draws the 'parity' entry: the /parity snapshot summary and diff result.
// Mirrors view.mjs Entry case 'parity': a column with marginBottom 1 whose
// root has no explicit width, so lines lay out at cols and are cut
// truncate-end. A bold title line, then per section an optional bold
// heading and its label/value rows; the label column is as wide as the
// widest label + 2 (at least 6). Under W < 40 the rows stack like /status:
// a bold label line, then the value indented by 4 and cut at its start.
import {c, pad, tailText, truncateEnd, width} from '../primitives.mjs';

export function drawParity(e, ctx) {
  const sections = e.sections || [];
  const rows = sections.flatMap(s => s.rows || []);
  if (!e.title && !rows.length) return [];
  const W = ctx.W, cols = ctx.cols;
  const kw = Math.max(6, ...rows.map(([k]) => width(k) + 2));
  const out = [];
  if (e.title) out.push(truncateEnd(c.bold('  ' + e.title), cols));
  for (const s of sections) {
    if (s.heading) out.push(truncateEnd(c.bold('  ' + s.heading), cols));
    for (const [k, v] of s.rows || []) {
      if (W < 40) {
        out.push(truncateEnd(c.bold('  ' + k), cols));
        out.push(truncateEnd('    ' + tailText(v, Math.max(10, W - 4)), cols));
      } else out.push(truncateEnd('  ' + c.gray(pad(k, kw)) + v, cols));
    }
  }
  out.push('');
  return out;
}
