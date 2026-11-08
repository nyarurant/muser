// Draws the 'crash' entry: the crash investigation's lines (src/crash-investigate.js).
// Mirrors view.mjs Entry case 'crash': a column with marginBottom 1 and no
// explicit width, so it lays out at cols; a bold 'クラッシュ調査' heading,
// then each line as a hanging row — a 2-cell GRAY mark plus the text GRAY,
// wrapped at cols-2 (the 'note' shape).
import {createRequire} from 'node:module';
import {c, hanging} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawCrash(e, ctx) {
  const out = [c.bold(t('クラッシュ調査'))];
  const mark = c.gray('  ');
  for (const l of e.lines || []) out.push(...hanging(mark, c.gray(String(l)), {width: ctx.cols, wrapMode: 'wrap'}));
  out.push('');
  return out;
}
