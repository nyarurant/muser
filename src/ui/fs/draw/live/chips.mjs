// Draws the live attachment chips row.
// Mirrors view.mjs Chips({list, W}): a column with marginTop 1 and paddingX 1;
// one chip per line (a Line, truncate-end at the content width W - 2), then the
// hint as a dim Text. The badge is accent text on the #2d2d34 background
// (term.js userBg paints exactly that background, accent paints the fg).
import {createRequire} from 'node:module';
import {c, width, truncateEnd, wrapInk} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

export function drawChips(s, ctx) {
  const list = s?.attachments;
  if (!list?.length) return [];
  const W = ctx.W;
  const kb = n => n < 1024 ? Math.round(n) + ' B' : Math.round(n / 1024) < 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
  const out = [''];
  list.forEach((a, i) => {
    const badge = ' ▣ ' + t('画像 {n}', {n: i + 1}) + ' ', name = a.name || '', size = kb(a.size || 0);
    const full = width(badge) + 1 + width(name) + 3 + width(size) <= (W ? W - 2 : Infinity);
    const content = c.userBg(c.accent(badge)) + c.gray(full ? ' ' + name + ' · ' + size : name);
    out.push(' ' + truncateEnd(content, W - 2));
  });
  for (const l of wrapInk(c.faint(t('空の入力で backspace → 外す')), W - 2)) out.push(' ' + l);
  return out;
}
