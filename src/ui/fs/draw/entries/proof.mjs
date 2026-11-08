// Draws the 'proof' entry (/proof evidence badges).
// Mirrors view.mjs Entry case 'proof': a column with marginBottom 1; an
// accent title line, then each line as a hanging row — a 2-cell mark
// ('✓ ', '✗ ', '? ', or '  ') plus the text wrapped at cols-2. The mark
// carries the colour: ✓ green (#78cd82), ✗ red (#f06e6e), ? yellow
// (#e6be64), plain lines GRAY. The root has no explicit width, so it
// lays out at cols (the renderToString columns, W + 1), like 'note'.
import {c, hanging} from '../primitives.mjs';

export function drawProof(e, ctx) {
  const lines = e.lines || [];
  if (!e.title && !lines.length) return [];
  const out = [];
  if (e.title) out.push(...hanging('', c.accent(String(e.title)), {width: ctx.cols, wrapMode: 'wrap'}));
  for (const l of lines) {
    const s = String(l);
    const m = /^[✓?✗] /.test(s) ? s[0] : ' ';
    const color = m === '✓' ? c.green : m === '✗' ? c.red : m === '?' ? c.yellow : c.gray;
    out.push(...hanging(color(m === ' ' ? '  ' : m + ' '), color(m === ' ' ? s : s.slice(2)), {width: ctx.cols, wrapMode: 'wrap'}));
  }
  out.push('');
  return out;
}
