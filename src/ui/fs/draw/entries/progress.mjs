// Draws the 'progress' entry: the progress message line, with the agent tag when present.
// Mirrors view.mjs Entry case 'progress': a row at width W (explicit width) with
// marginBottom 1 — an accent '⏺ ' mark, and a column beside it holding the
// sanitised message wrapped, then, for a non-main agent, a DIM (#5f5f69 =
// c.faint) 'エージェント {tag}' line in the same column.
// Quirk (measured against Ink): the column wraps at W-1, not W-2. Ink's text
// measurement counts '⏺' as 0 cells, so the mark's node is 1 cell wide (just
// the space) and the flex column gets W-1 — while the rendered indent of the
// continuation lines is the full 2 cells of '⏺ '. hanging() cannot express
// that split, so the wrapping is done here directly with wrapInk.
// A message containing newlines is wrapped line by line, as Ink lays out each
// line of a Text separately.
import {createRequire} from 'node:module';
import {c, wrapInk} from '../primitives.mjs';
import {sanitizeEmbeds} from '../../../sanitize.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawProgress(e, ctx) {
  const bodyW = Math.max(1, ctx.W - 1);
  const out = [];
  const pushColumn = (styled, firstPrefix) => {
    String(styled).split('\n').forEach(seg => {
      wrapInk(seg, bodyW).forEach((line, i) => {
        out.push((out.length === 0 && firstPrefix ? firstPrefix : '  ') + line);
        firstPrefix = null;
      });
    });
  };
  pushColumn(sanitizeEmbeds(e.message), c.accent('⏺ '));
  if (e.agent && e.agent !== 'main') pushColumn(c.faint(t('エージェント {tag}', {tag: e.agent})), null);
  out.push('');
  return out;
}
