// Draws the live Running rows: s.bangRunning then s.running, in order, when present.
// Mirrors view.mjs Running() (L344-352) + useTick (L324-329). The tick reads
// ctx.now (never Date.now()) so tests can fix the clock; with motion off the
// spinner stands still (n = 0). Each row is a Line (truncate-end); the root
// Box has no width, so it lays out inside Live's width-W Box and every row
// truncates at W. Title via primitives toolTitle (same code as view.mjs title).
import {createRequire} from 'node:module';
import {SPIN, spinTick, c, truncateEnd, toolTitle} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {switchValue} = require('../../../../settings.js');

export function drawRunning(s, ctx) {
  const state = s || {};
  const W = ctx?.W;
  const now = ctx?.now ?? 0;
  const n = switchValue('motion') ? spinTick(now) : 0;
  const out = [];
  for (const r of [state.bangRunning, state.running]) {
    if (!r) continue;
    const all = [...(r.tail || []), ...(r.now?.trim() ? [r.now] : [])];
    const shown = all.slice(-5);
    const hidden = all.length - shown.length;
    out.push(truncateEnd(c.accent(SPIN[n % SPIN.length]) + ' ' + c.bold(toolTitle(r.call)) + c.gray('(' + (r.call.summary || '') + ')'), W));
    if (hidden) out.push(truncateEnd(c.faint('  │ ' + t('… ほか {n} 行', {n: hidden})), W));
    for (const l of shown) out.push(truncateEnd(c.faint('  │ ' + l), W));
  }
  return out;
}
