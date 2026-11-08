// Draws the 'sources' entry: the source list, up to 6 items plus a count.
// Mirrors view.mjs Entry case 'sources': a column with marginBottom 1 and no
// explicit width, so it lays out at cols. First a DIM (#5f5f69 = c.faint)
// '  出典' heading, then up to 6 items, each a Line (GRAY, truncate-end at
// cols): '  {n}. ' + the label cut to at most max(6, W-32) cells + a faint
// '  ' + the uri kept at its end (tailText) in the remaining width.
// Items past the sixth collapse to a DIM '  … ほか {n} 件' line.
// The label cut uses truncateEnd (which keeps the style across the …) rather
// than term.js truncate (which resets before it): inside the GRAY line, Ink /
// chalk reopens the colour after a reset, so the … stays GRAY either way.
import {createRequire} from 'node:module';
import {c, width, truncateEnd, tailText} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawSources(e, ctx) {
  const W = ctx.W;
  const items = e.items || [];
  const out = [c.faint(t('  出典'))];
  items.slice(0, 6).forEach((s, i) => {
    const label = String(s.label || s.domain || '');
    const uri = String(s.uri || '');
    const labelShown = truncateEnd(label, Math.min(width(label), Math.max(6, W - 32)));
    // The URI keeps its tail in whatever width the prefix, label and gap leave
    // (master-debug #20): a 10-cell floor overflowed narrow terminals, and the
    // line-end truncate below then cut the very tail tailText had preserved.
    // Too little room drops the URI instead of mangling it.
    const uriBudget = W - 7 - width(labelShown);
    const uriShown = uriBudget >= 4 ? tailText(uri, uriBudget) : '';
    const line = c.gray('  ' + (i + 1) + '. ' + labelShown) + c.faint('  ' + uriShown);
    out.push(truncateEnd(line, ctx.cols));
  });
  if (items.length > 6) out.push(truncateEnd(c.faint(t('  … ほか {n} 件', {n: items.length - 6})), ctx.cols));
  out.push('');
  return out;
}
