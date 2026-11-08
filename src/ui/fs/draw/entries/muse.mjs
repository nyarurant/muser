// Draws the 'muse' entry: a Muse step line with its detail.
// Mirrors view.mjs Entry case 'muse': a column with marginBottom 1 and no
// explicit width, so it lays out at cols. The head is a Line (truncate-end at
// cols): a red '✗ ' (failed) or accent '⏺ ' mark, the bold title, and a faint
// '  (Muse)' / '  (Muse · 実行中のまま)' suffix. The detail, when present, is a
// hanging row: a DIM '  ⎿  ' prefix and the detail wrapped at cols-5, in
// #f06e6e (c.red) when failed and GRAY (c.gray) otherwise. A detail with
// newlines is wrapped line by line, its later lines starting under the text.
import {createRequire} from 'node:module';
import {c, hanging, truncateEnd} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawMuse(e, ctx) {
  const step = e.step || {};
  const head = (step.failed ? c.red('✗ ') : c.accent('⏺ ')) + c.bold(step.title) + c.faint(step.unfinished ? t('  (Muse · 実行中のまま)') : '  (Muse)');
  const out = [truncateEnd(head, ctx.cols)];
  if (step.detail) {
    const color = step.failed ? c.red : c.gray;
    const prefix = c.faint('  ⎿  ');
    String(step.detail).split('\n').forEach((seg, i) => {
      out.push(...hanging(i === 0 ? prefix : '     ', color(seg), {width: ctx.cols, wrapMode: 'wrap'}));
    });
  }
  out.push('');
  return out;
}
