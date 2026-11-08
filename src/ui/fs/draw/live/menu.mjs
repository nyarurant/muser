// Draws the live menu block (mirrors view.mjs Menu).
import {createRequire} from 'node:module';
import {c, width, pad, wrapInk, truncateEnd, truncateMiddle, roundBox} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

const MENU_ROWS = 12;
const ACCENT = '#b4a0ff';
// Ink trims trailing spaces off every rendered line (unless the line ends
// with an escape sequence); plain rows built by hand need the same trim.
const trimLine = l => (l.endsWith(' ') ? l.replace(/ +$/, '') : l);

export function drawMenu(s, ctx) {
  const m = s?.menu;
  if (!m) return null;
  const W = ctx.W;
  const rows = ctx?.rows ?? 30;
  const inner = W - 4;
  const opts = m.options || [];
  const hintOwn = m.hint && width(String(m.title || '')) + 3 + width(m.hint) > W - 6;
  const labelW = Math.min(Math.floor(W * 0.45), opts.reduce((mx, o, i) => Math.max(mx, width((i + 1) + '. ' + o.label) + 4), 28));
  const narrow = W < 50;
  // Builds the box content for a window of `win` options around the selection.
  // Also reports where the selected option's first line lands, so the small-
  // terminal cap below can keep that line and cut description lines instead.
  const build = (win, ind = true, blank = true) => {
    const content = [];
    content.push(truncateEnd(c.accent(c.bold(m.title)) + (m.hint && !hintOwn ? c.faint('   ' + m.hint) : ''), inner));
    if (hintOwn) content.push(...wrapInk(c.faint(m.hint), inner));
    if (blank) content.push(' ');
    if (!opts.length) content.push(truncateEnd(c.faint(t('選択肢がありません')), inner));
    const n = opts.length, start = n <= win ? 0 : Math.max(0, Math.min(m.index - Math.floor(win / 2), n - win)), end = Math.min(n, start + win);
    let labelPos = -1;
    if (start > 0 && ind) content.push(...wrapInk(c.faint('  ' + t('↑ ほか {n} 件', {n: start})), inner));
    opts.slice(start, end).forEach((o, j) => {
      const i = start + j, on = i === m.index, mark = o.mark || o.value === m.current ? c.green(' ✓') : '';
      const label = (i + 1) + '. ' + o.label, col = o.danger ? c.red : c.text;
      const labelCell = on ? c.bold(col(label)) : col(label);
      const rowLines = [];
      if (narrow) {
        // Labels are cut in the MIDDLE (wave 6): an end cut dropped the
        // label's suffix — the part that tells options apart, like
        // '…（復元できません）' — and two options read as the same choice.
        rowLines.push((on ? c.accent('❯') + ' ' : '  ') + truncateMiddle(labelCell + mark, inner - 2));
        if (o.desc) {
          const dc = on ? c.gray : c.faint;
          const descLines = on ? wrapInk(o.desc, inner - 2) : [truncateEnd(o.desc, inner - 2)];
          for (const dl of descLines) rowLines.push('  ' + dc(dl));
        }
      } else {
        const lw = Math.max(4, labelW - 2);
        const labelPart = pad(truncateMiddle(labelCell + mark, lw), lw);
        const descW = inner - labelW - 2;
        const dc = on ? c.gray : c.faint;
        const desc = o.desc || '';
        const descLines = desc ? (on ? wrapInk(dc(desc), descW) : [truncateEnd(dc(desc), descW)]) : [];
        const markCell = on ? c.accent('❯') + ' ' : '  ';
        rowLines.push(markCell + labelPart + '  ' + (descLines[0] ?? ''));
        for (let k = 1; k < descLines.length; k++) rowLines.push(' '.repeat(labelW + 2) + descLines[k]);
      }
      if (o.group && (j === 0 || opts[i - 1]?.group !== o.group)) content.push(...wrapInk(c.accent(c.bold(o.group)), inner));
      if (on) labelPos = content.length;
      content.push(...rowLines);
    });
    if (end < n && ind) content.push(...wrapInk(c.faint('  ' + t('↓ ほか {n} 件', {n: n - end})), inner));
    return {content, labelPos};
  };
  const assemble = content => [
    '',
    ...roundBox(content.map(l => ' ' + l), {width: W, borderColor: ACCENT}),
    ...wrapInk(c.faint(opts.length ? t('  ↑↓ で選んで enter · 数字 · esc で閉じる') : t('  esc で閉じる')), W),
  ].map(trimLine);
  let win = MENU_ROWS;
  let {content, labelPos} = build(win);
  let out = assemble(content);
  // Small terminal (wave 7): the window shrinks to the rows actually
  // available, so the block fits the screen and the frame cut in app.mjs
  // cannot take the selection, the warnings or the footer off the bottom.
  // At ordinary heights (rows >= 20) the drawing above is untouched.
  if (rows < 20 && out.length > rows) {
    // Even one option can overflow when its description wraps far: cut
    // lines after the selected label (its description tail) until it fits.
    const capDesc = () => { while (out.length > rows && labelPos >= 0 && content.length > labelPos + 1) { content.splice(content.length - 1, 1); out = assemble(content); } };
    while (out.length > rows && win > 1) { win--; ({content, labelPos} = build(win)); out = assemble(content); }
    capDesc();
    // Still too tall: the hidden-count lines give way (the selection is
    // what must stay), then, below 8 rows, the blank under the title too.
    if (out.length > rows) { ({content, labelPos} = build(win, false)); out = assemble(content); capDesc(); }
    if (out.length > rows && rows < 8) { ({content, labelPos} = build(win, false, false)); out = assemble(content); capDesc(); }
  }
  return out;
}
