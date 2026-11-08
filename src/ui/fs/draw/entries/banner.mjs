// Draws the 'banner' entry: the top banner.
// Mirrors view.mjs Banner (+ Keycap): a column with marginTop 1 / marginBottom 1
// and no explicit width, so it lays out at cols. The wordmark (src/tui/logo.js,
// the same two gradient lines) never shrinks: marginLeft 2, marginRight 3, then
// a text column with the name line and either the version (faint, its own line
// when narrow, W < 50) plus a full-width folder line, or the folder beside the
// wordmark. A resumed chat adds a marginTop 1 line (accent ↺, gray label, faint
// turn count). The keycaps follow after another marginTop 1: whole units
// (key on #2d2d34 with the accent colour, gray label, 3 trailing spaces) wrap
// inside cols - 2. Whether a banner opened a resumed chat is fixed on first
// draw, like view.mjs's WeakMap, so a resize cannot change the answer.
import {createRequire} from 'node:module';
import {c, hex, tailText, truncateEnd, width} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {logo} = require('../../../../tui/logo.js');
const {ESC, rgbTo256, truecolor, on} = require('../../../../tui/term.js');

const GRAY_HEX = '#8c8c96';
// term.js has no background helper exported, so the Keycap key background
// (#2d2d34) is built here the same way term.js bg() builds one, under term.js's
// own on/off decision, imported not re-derived (wave 18): the copy here lacked
// term's dumb-terminal term, so the key background printed on TERM=dumb while
// term.js itself kept colours off.
const keyBg = !on ? '' : truecolor ? ESC + '48;2;45;45;52m' : ESC + '48;5;' + rgbTo256(45, 45, 52) + 'm';
// The accent span's own reset closes the background again, like Ink's nested
// Text (background on the outer span, colour on the key text).
const keycap = (k, label) => keyBg + c.accent(' ' + k + ' ') + c.gray(' ' + label + '   ');

const bannerResumed = new WeakMap();

export function drawBanner(e, ctx) {
  const ctrl = ctx.ctrl || {};
  const a = ctrl.agent || {};
  // Without a session and a Muse name there is no banner to draw: return
  // null so the caller falls back to the React drawing.
  if (!a.session || ctrl.museName == null || ctrl.version == null) return null;
  const W = ctx.W, cols = ctx.cols;
  const mark = logo();
  const narrow = W && W < 50;
  if (e && !bannerResumed.has(e)) bannerResumed.set(e, a.session?.turns ? {title: a.session.title || a.session.id, turns: a.session.turns} : null);
  const resumed = e ? bannerResumed.get(e) : (a.session?.turns ? {title: a.session.title || a.session.id, turns: a.session.turns} : null);
  const logoW = width(mark[0]);
  const rightW = Math.max(1, cols - 2 - logoW - 3);
  const line1 = c.bold(ctrl.museName) + c.gray(t(' と作業します')) + (narrow ? '' : c.faint('   v' + ctrl.version));
  const right0 = truncateEnd(line1, rightW);
  const right1 = narrow ? truncateEnd(c.faint('v' + ctrl.version), rightW) : truncateEnd(hex(GRAY_HEX)(a.cwd), rightW);
  const out = ['', '  ' + mark[0] + '   ' + right0, '  ' + mark[1] + '   ' + right1];
  if (narrow) out.push('  ' + truncateEnd(hex(GRAY_HEX)(tailText(String(a.cwd ?? ''), Math.max(10, W - 6))), Math.max(1, cols - 2)));
  if (resumed) {
    out.push('');
    out.push('  ' + truncateEnd(c.accent('↺ ') + c.gray(t('再開: ')) + resumed.title + c.faint('   ' + t('{n} ターン', {n: resumed.turns})), Math.max(1, cols - 2)));
  }
  out.push('');
  const caps = [
    keycap('/', t('コマンド')), keycap('⇧⇥', t('承認モード')), keycap('esc', t('中断')), keycap('\\⏎', t('改行')),
    keycap('alt+v', t('画像')), keycap('@', t('ファイル')), keycap('!', t('シェル')), keycap('^C^C', t('終了')),
  ];
  const avail = Math.max(1, cols - 2);
  let cur = '', curW = 0;
  for (const unit of caps) {
    const uw = width(unit);
    if (curW > 0 && curW + uw > avail) { out.push('  ' + cur); cur = ''; curW = 0; }
    cur += unit; curW += uw;
  }
  if (cur) out.push('  ' + cur);
  out.push('');
  return out;
}
