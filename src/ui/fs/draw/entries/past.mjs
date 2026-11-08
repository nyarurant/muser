// Draws the 'past' entry: compact resumed-turn steps and tool lines.
// Mirrors view.mjs Entry case 'past': step lines (faint ⏺, red ✗ when failed)
// then tool lines (faint glyph, red when failed, with the error cut at
// max(60, W - 20) cells), at most 6 lines plus a dim '… ほか n 件', in a
// column with marginBottom 1 whose root has no explicit width (cols).
// Every line is a Line (truncate-end at cols). An entry with no steps and
// no tools returns null: the React side renders an empty box (nothing),
// and the fallback draws exactly that.
import {createRequire} from 'node:module';
import {c, truncateEnd, glyphFor} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {truncate} = require('../../../../tui/term.js');
const {t} = require('../../../../i18n.js');

export function drawPast(e, ctx) {
  if (!e) return null;
  const {W, cols} = ctx;
  const lines = [
    ...(Array.isArray(e.steps) ? e.steps : []).map(s => (s?.failed ? c.red('✗ ') : c.faint('⏺ ')) + c.gray(s?.title) + c.faint('  (Muse)')),
    ...(Array.isArray(e.tools) ? e.tools : []).map(tl => (tl?.ok ? c.faint(glyphFor(tl) + ' ') : c.red(glyphFor(tl) + ' ')) + c.gray(String(tl?.command).replace(/^code\./, '') + (tl?.summary ? ' ' + tl.summary : '')) + (tl?.ok ? '' : c.red('  ' + truncate(String(tl?.error || ''), Math.max(60, W - 20))))),
  ];
  if (!lines.length) return null;
  const out = lines.slice(0, 6).map(l => truncateEnd(l, cols));
  if (lines.length > 6) out.push(truncateEnd(c.faint(t('  … ほか {n} 件', {n: lines.length - 6})), cols));
  out.push('');
  return out;
}
