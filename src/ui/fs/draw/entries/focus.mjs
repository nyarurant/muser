// Draws the 'focus' entry: compact Focus status line, or the full goal/criteria panel.
// Mirrors view.mjs Entry case 'focus'. Both forms lay out at width W (the root
// Box carries width: W). Compact: one wrapped line, yellow (#e6be64 = c.yellow)
// for needs_input / blocked / stalled / limit, DIM (#5f5f69 = c.faint) otherwise,
// no margins. Full: marginY 1; an accent title line, the goal as a hanging row
// after '目標: ', one hanging row per criterion (mark + id in a non-shrinking
// column; met rows green #78cd82 = c.green, the rest GRAY = c.gray), and the
// reason indented by 2 in DIM.
import {createRequire} from 'node:module';
import {c, focusLabel, hanging, wrapInk} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawFocus(e, ctx) {
  // An entry without its Focus snapshot is not a shape this draw covers:
  // return null so the caller falls back to the React drawing, exactly as
  // for a part that is not replaced yet.
  if (!e.focus) return null;
  const W = ctx.W;
  const f = e.focus;
  if (!e.full) {
    const cs = f.criteria || [];
    const met = cs.filter(x => x.status === 'met').length;
    const open = cs.filter(x => x.status !== 'met').map(x => x.id);
    const warn = ['needs_input', 'blocked', 'stalled', 'limit'].includes(f.status);
    const color = warn ? c.yellow : c.faint;
    const s = t('Focus: {status}', {status: focusLabel(f.status)}) + ' · ✓ ' + met + '/' + cs.length +
      (f.maxRounds > 1 ? ' · ' + f.round + '/' + f.maxRounds : '') +
      (open.length ? t(' · 未完: {ids}', {ids: open.join(', ')}) : '');
    return wrapInk(color(s), W);
  }
  const criteria = f.criteria || [];
  const out = [''];
  out.push(...wrapInk(c.accent(t('Focus: {status} · {round}/{max}', {status: focusLabel(f.status), round: f.round, max: f.maxRounds})), W));
  const goalText = String(f.goal ?? '');
  const goalLines = hanging(t('目標: {goal}', {goal: ''}), goalText, {width: W, wrapMode: 'wrap'});
  // An empty goal leaves only the plain prefix: Ink trims the line's trailing
  // space (the prefix carries no style that would keep it).
  if (!goalText && goalLines.length) goalLines[0] = goalLines[0].replace(/ +$/, '');
  out.push(...goalLines);
  if (criteria.length) {
    for (const check of criteria) {
      const paint = check.status === 'met' ? c.green : c.gray;
      const prefix = paint((check.status === 'met' ? '✓ ' : '□ ') + check.id + ' ');
      const body = paint(String(check.text ?? '') + (check.reason ? ' — ' + check.reason : '') + ((check.evidence || []).length ? ' [' + check.evidence.join(', ') + ']' : ''));
      out.push(...hanging(prefix, body, {width: W, wrapMode: 'wrap'}));
    }
  } else {
    out.push(...wrapInk(c.faint(t('条件: なし')), W));
  }
  if (f.reason) out.push(...hanging('  ', c.faint(String(f.reason)), {width: W, wrapMode: 'wrap'}));
  out.push('');
  return out;
}
