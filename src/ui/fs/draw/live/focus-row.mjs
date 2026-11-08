// Draws the live Focus progress row while Focus is running.
// Mirrors view.mjs Live L811: a single Text, colour DIM, no wrap prop — so
// Ink's default wrap applies at the Live width W.
import {createRequire} from 'node:module';
import {wrapInk, hex} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const DIM = hex('#5f5f69');

export function drawFocusRow(s, ctx) {
  const focus = s?.focus || {};
  const criteria = focus.criteria || [];
  const met = criteria.filter(c => c.status === 'met').length;
  const text = t('Focus {round}/{max} · 根拠あり {met}/{total}', {round: focus.round, max: focus.maxRounds, met, total: criteria.length});
  return wrapInk(DIM(text), ctx?.W ?? 40);
}
