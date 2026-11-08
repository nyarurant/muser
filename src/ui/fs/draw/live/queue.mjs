// Draws the live queue line naming the queued items.
// Mirrors view.mjs Live's queue line, except the item budget (wave 6): it
// was the literal 80 regardless of the screen, so on a 40-cell terminal
// whole items were named that could never fit, and on a wide one items
// were dropped that would have fit. The budget is now the real wrap width
// W - 4 minus the 'キュー N 件: ' prefix and the '… ほか M 件' suffix the
// line will carry; whole items are still dropped past it. The Text wraps
// (default wrap) at W - 4 (the Box's paddingX 2 on each side inside the
// width-W Live root), so the wrapped lines are wrapInk of the faint queue
// string at W - 4, each prefixed with the 2 plain padding spaces. The root
// Box's marginTop 1 is the leading '' line. Returns [] when there is no
// queue (drawLive only calls this when queue.length, so that case is not
// rendered either way).
import {createRequire} from 'node:module';
import {c, width, wrapInk} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

export function drawQueue(s, ctx) {
  const queue = s?.queue || [];
  if (!queue.length) return [];
  const W = ctx?.W ?? 80;
  const items = queue.map(q => { const ls = String(q).split('\n'); return ls[0] + (ls.length > 1 ? t('（全 {n} 行）', {n: ls.length}) : ''); });
  const prefixW = width(t('キュー {n} 件: ', {n: queue.length}));
  const suffixW = left => width(' ' + t('  … ほか {n} 件', {n: left}).trim());
  let out = '', usedN = 0;
  for (const it of items) {
    const trial = out ? out + ' · ' + it : it;
    const leftAfter = items.length - usedN - 1;
    if (usedN && prefixW + width(trial) + (leftAfter ? suffixW(leftAfter) : 0) > W - 4) break;
    out = trial; usedN++;
  }
  const first = usedN < items.length ? out + ' ' + t('  … ほか {n} 件', {n: items.length - usedN}).trim() : out;
  const text = t('キュー {n} 件: {first}', {n: queue.length, first});
  return ['', ...wrapInk(c.faint(text), W - 4).map(l => '  ' + l)];
}
