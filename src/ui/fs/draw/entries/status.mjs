// Draws the 'status' entry: the /status rows (gateway, terminal, conversation, cwd, approval).
// Mirrors view.mjs Entry case 'status': a column with marginBottom 1 whose root
// has no explicit width, so lines lay out at cols and are cut truncate-end.
// The label column is as wide as the widest label + 2 (at least 6). Under
// W < 40 the rows stack: a bold label line, then the value indented by 4 and
// cut at its start (tailText — style-aware in primitives since wave 6: the
// values carry c.faint / c.green spans, and a raw-text tail cut split their
// escape sequences and printed garbage). The usage rows repeat view.mjs usageWindowRows()
// against the same src/usage.js tally, so both sides read the same numbers.
import {createRequire} from 'node:module';
import {c, modeLabel, pad, tailText, truncateEnd, width} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

function usageWindowRows() {
  try {
    const s = require('../../../../usage.js').summary();
    if (!(s.allTime.realInTokens || s.allTime.realOutTokens)) return [];
    const f = require('../../../../turn-usage.js').formatTokens;
    const u = require('../../../../usage.js');
    const since = d => d ? c.faint('  ' + t('（{date} から記録）', {date: u.sinceLabel(d)})) : '';
    const fmt = b => f(b.realInTokens || 0) + ' in / ' + f(b.realOutTokens || 0) + ' out';
    return [[t('実績 1時間'), fmt(s.lastHour)], [t('実績 今日'), fmt(s.today)], [t('実績 7日'), fmt(s.last7) + since(s.realSince7)], [t('実績 累計'), fmt(s.allTime) + since(s.realSince)]];
  } catch { return []; }
}

export function drawStatus(e, ctx) {
  const ctrl = ctx.ctrl || {};
  const a = ctrl.agent || {};
  // Without a controller agent there is nothing to report: return null so
  // the caller falls back to the React drawing.
  if (!a.client || !a.session) return null;
  const W = ctx.W, cols = ctx.cols;
  const gwStatus = a.client.status === 'connected' ? t('接続中') : a.client.status === 'demo' ? 'demo' : String(a.client.status || '');
  const rows = [
    ['Muse', ctrl.museName + c.faint('  ' + t('ゲートウェイ') + ' ' + gwStatus)],
    [t('端末'), a.constructor.DEVICE + (a.nodeSlot?.slot ? c.faint('  ' + t('窓 {n}', {n: a.nodeSlot.slot})) : '') + '  ' + (a.device?.connected ? c.green(t('接続中')) : c.red(t('未接続')))],
    [t('会話'), (a.session.title || t('(新規)')) + c.faint('  ' + a.session.id)],
    [t('場所'), a.cwd],
    [t('承認'), modeLabel(a.mode)],
    ...(a.accountId ? [[t('アカウント'), a.accountLabel && a.accountLabel !== a.accountId ? a.accountLabel + c.faint('  ' + a.accountId) : a.accountId]] : []),
    ...usageWindowRows(),
  ];
  const kw = Math.max(6, ...rows.map(([k]) => width(k) + 2));
  if (W < 40) {
    const out = [];
    for (const [k, v] of rows) {
      out.push(truncateEnd(c.bold('  ' + k), cols));
      out.push(truncateEnd('    ' + tailText(v, Math.max(10, W - 4)), cols));
    }
    out.push('');
    return out;
  }
  const out = rows.map(([k, v]) => truncateEnd('  ' + c.gray(pad(k, kw)) + v, cols));
  out.push('');
  return out;
}
