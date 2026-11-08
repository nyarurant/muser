// Draws the 'lore' entry (コードの言い伝え): a bold title, then one hanging
// gray row per line, with marginBottom 1 — the 'note' shape plus a heading.
// Mirrors view.mjs Entry case 'lore': a column with no explicit width, so it
// lays out at cols; each line is a 2-cell blank mark plus the text wrapped at
// cols-2 (c.gray, like a plain note). An entry with neither title nor lines
// draws nothing.
import {c, hanging} from '../primitives.mjs';

export function drawLore(e, ctx) {
  const lines = e.lines || [];
  if (!e.title && !lines.length) return [];
  const out = [];
  if (e.title) out.push(c.bold(String(e.title)));
  const mark = c.gray('  ');
  for (const l of lines) out.push(...hanging(mark, c.gray(String(l)), {width: ctx.cols, wrapMode: 'wrap'}));
  out.push('');
  return out;
}
