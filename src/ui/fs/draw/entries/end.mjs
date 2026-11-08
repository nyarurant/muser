// Draws the 'end' entry: the turn end line with elapsed time, usage and abort/error text.
// Mirrors view.mjs Entry case 'end': a root Box with no width and no margin, so the
// single Text child lays out at cols (the renderToString columns, W + 1), not at W.
// The ok line is DIM (c.faint, #5f5f69): '  ✻ ' + elapsed + optional ' · ' + usage +
// optional ' · ' + t('返事がありませんでした'). The not-ok line is yellow (#e6be64,
// c.yellow) when aborted, red (#f06e6e, c.red) otherwise: '  ⎿  ' + the abort text or
// the error. Both branches wrap at ctx.cols with no hanging indent (continuation
// lines start at column 0). t() comes from src/i18n.js and usageText from
// src/turn-usage.js, both plain CJS with no React/Ink dependency.
import {createRequire} from 'node:module';
import {c, elapsed, wrapInk} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {usageText} = require('../../../../turn-usage.js');

export function drawEnd(e, ctx) {
  const u = e.usage;
  const usage = u && (u.inputTokens || u.outputTokens || !(Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens))) ? usageText(u) : null;
  if (e.ok) {
    return wrapInk(c.faint('  ✻ ' + elapsed(e.ms) + (usage ? ' · ' + usage : '') + (e.silent ? ' · ' + t('返事がありませんでした') : '')), ctx.cols);
  }
  return wrapInk((e.aborted ? c.yellow : c.red)('  ⎿  ' + (e.aborted ? t('中断しました') : String(e.error || ''))), ctx.cols);
}
