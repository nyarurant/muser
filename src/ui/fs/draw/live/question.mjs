// Draws the live question block (mirrors view.mjs Question).
import {createRequire} from 'node:module';
import {c, width, pad, wrapInk, truncateEnd, truncateMiddle, roundBox, singleBox, tailText, graphemesOf} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

const ACCENT = '#b4a0ff';
// truncateEnd can cut a styled string before its closing reset, leaving the
// style open into the box padding that follows; Ink closes it at the line end.
const trunc = (str, max) => { const r = truncateEnd(str, max); return r.includes('\x1b[') && !r.endsWith('\x1b[0m') ? r + '\x1b[0m' : r; };
// Ink trims trailing spaces off every rendered line (unless the line ends
// with an escape sequence); plain rows built by hand need the same trim.
const trimLine = l => (l.endsWith(' ') ? l.replace(/ +$/, '') : l);
// view.mjs wrapDisplayRows, same code.
function wrapDisplayRows(line, paneW) {
  const max = Math.max(1, paneW), rows = []; let cur = '', w = 0;
  for (const g of graphemesOf(line)) {
    const gw = width(g);
    if (cur && w + gw > max) { rows.push(cur); cur = ''; w = 0; }
    cur += g; w += gw;
  }
  rows.push(cur);
  return rows;
}

export function drawQuestion(s, ctx) {
  const q = s?.question;
  if (!q) return null;
  const W = ctx.W;
  const rows = ctx?.rows ?? 30;
  // No floor here (master-debug #19): a 20-cell floor on a W=20 terminal made
  // every row wider than the box, and the box's right border fell off screen.
  const innerW = Math.max(1, W - 4), inner = Math.max(1, W - 4);
  const qs = q.questions || [], onSubmit = q.tab >= qs.length, cur = onSubmit ? null : qs[q.tab];
  const single = qs.length <= 1;
  const tabLabel = (qq, i) => qq.header && qq.header !== qq.question && qq.header !== String(qq.question || '').slice(0, 16) ? qq.header : t('質問 {n}', {n: i + 1});
  const answered = i => !!(q.answers?.[i] || (qs[i]?.multi ? (q.checked?.[i]?.length || q.custom?.[i]) : (q.picked?.[i] != null || q.custom?.[i])));
  const head = [];
  if (!single) {
    const tabs = [...qs.map((qq, i) => { const label = (answered(i) ? '[✓] ' : '[ ] ') + tabLabel(qq, i); return i === q.tab ? c.accent(c.bold(label)) : c.gray(label); }),
      onSubmit ? c.accent(c.bold(t('✓ 送信'))) : c.gray(t('✓ 送信'))].join('  ');
    head.push(...wrapInk(tabs, inner));
  }
  const multiCount = cur?.multi ? (q.checked?.[q.tab] || []).length + (q.custom?.[q.tab] ? 1 : 0) : 0;
  let footer;
  if (q.mode === 'type' || q.mode === 'notes') footer = t('enter で確定 · esc で戻る');
  else if (onSubmit) footer = t('↑↓ 移動 · enter 選択 · n メモ · tab 質問 · esc 閉じる');
  else if (cur?.multi && single) footer = multiCount > 0 ? t('space 切替 · enter 送信（{n} 件） · n メモ · esc 閉じる', {n: multiCount}) : t('space 切替 · enter 送信（1 つ以上選択） · n メモ · esc 閉じる');
  else if (cur?.multi) footer = multiCount > 0 ? t('space 切替 · enter 次へ（{n} 件） · n メモ · tab 質問 · esc 閉じる', {n: multiCount}) : t('space 切替 · enter 次へ（1 つ以上選択） · n メモ · tab 質問 · esc 閉じる');
  else if (single) footer = t('↑↓ 移動 · enter 選択 · n メモ · esc 閉じる');
  else footer = t('↑↓ 移動 · enter 選択 · n メモ · tab 質問 · esc 閉じる');
  const footerLines = wrapInk(c.faint('  ' + footer), W);
  const assemble = kids => [
    '',
    ...roundBox(kids.map(l => ' ' + l), {width: W, borderColor: ACCENT}),
    ...footerLines,
  ].map(trimLine);
  if (onSubmit) {
    const kids = [...head];
    kids.push(...wrapInk(c.bold(t('回答の確認')), inner));
    const ansStart = kids.length;
    qs.forEach((qq, i) => kids.push(...wrapInk(tabLabel(qq, i) + ': ' + (q.answers?.[i] ? q.answers[i] : c.faint(t('未回答'))), inner)));
    let ansCount = kids.length - ansStart;
    if (qs.some((_, i) => !q.answers?.[i])) kids.push(trunc(c.yellow(t('未回答があります。このまま送りますか？')), inner));
    kids.push(trunc(q.index === 0 ? c.accent('❯ ') + c.bold(t('送信する')) : '  ' + t('送信する'), inner));
    let out = assemble(kids);
    // Small terminal (wave 7): answer rows give way from the top so the
    // warning and the submit row stay on screen; a count line marks the gap.
    if (rows < 20 && out.length > rows) {
      let dropped = 0, at = ansStart;
      while (out.length > rows && ansCount > 0) {
        kids.splice(at, 1); ansCount--; dropped++;
        if (dropped === 1) { kids.splice(at, 0, trunc(c.faint('  ' + t('↑ ほか {n} 件', {n: 0})), inner)); at++; }
        out = assemble(kids);
      }
      if (dropped) kids[ansStart] = trunc(c.faint('  ' + t('↑ ほか {n} 件', {n: dropped})), inner);
      out = assemble(kids);
      // Every answer is already gone and it still does not fit: the count
      // line gives way too, so the warning and the submit row stay.
      if (out.length > rows && dropped && ansCount === 0) { kids.splice(ansStart, 1); out = assemble(kids); }
    }
    return out;
  }
  if (!cur) return assemble(head);
  const opts = cur.options || [], checked = q.checked?.[q.tab] || [];
  const sel = q.index < opts.length ? opts[q.index] : null, preview = sel?.preview ? String(sel.preview) : null;
  const vertical = !!preview && W < 60;
  const leftW = preview && !vertical ? Math.max(20, Math.floor(innerW * 0.45)) : innerW;
  // The selectable rows as items (one per option, then the type row, then
  // the separator + chat row), so the small-terminal window below can move
  // in whole choices and always keep the selected one whole.
  const items = [];
  opts.forEach((o, i) => {
    const on = i === q.index, box = cur.multi ? (checked.includes(i) ? '[✓] ' : '[ ] ') : '';
    // The label is cut in the MIDDLE when it does not fit (wave 6): an end
    // cut dropped its suffix — the part that tells options apart, like
    // '…（復元できません）' — and two options read as the same choice.
    const label = truncateMiddle((i + 1) + '. ' + o.label, Math.max(4, leftW - 2 - width(box)));
    const lines = [trunc((on ? c.accent('❯ ') : '  ') + box + (on ? c.bold(label) : label), leftW)];
    if (o.description) {
      const ind = ' '.repeat(2 + box.length + String(i + 1).length + 2);
      if (on) lines.push(...wrapInk(c.faint(ind + o.description), leftW));
      else lines.push(trunc(c.faint(ind + o.description), leftW));
    }
    items.push(lines);
  });
  const typeOn = q.index === opts.length, typeBox = cur.multi ? (q.custom?.[q.tab] ? '[✓] ' : '[ ] ') : '';
  const typeRaw = q.mode === 'type' ? (q.typeText || '') + '▌' : null;
  const typeLabel = (opts.length + 1) + '. ' + (typeRaw ? tailText(typeRaw, Math.max(8, innerW - 6 - typeBox.length - String(opts.length + 1).length)) : t('自分で書く…'));
  items.push([trunc((typeOn ? c.accent('❯ ') : '  ') + typeBox + (typeOn ? c.bold(typeLabel) : typeLabel), leftW)]);
  const chatOn = q.index === opts.length + 1, chatLabel = t('この件について話す');
  // The chat row is a Line coloured DIM in view.mjs: the whole row is faint,
  // the cursor keeps its accent, and a selected label is bold AND faint.
  items.push([trunc(c.faint('  ' + '─'.repeat(12)), leftW), trunc(chatOn ? c.accent('❯ ') + c.bold(c.faint(chatLabel)) : c.faint('  ' + chatLabel), leftW)]);
  const selItem = Math.min(Math.max(0, q.index || 0), items.length - 1);
  const paneW = preview ? (vertical ? Math.max(1, innerW - 4) : Math.max(1, W - leftW - 8)) : 0;
  const displayRows = preview ? preview.split('\n').flatMap(l => wrapDisplayRows(l, paneW)) : [];
  const note = q.mode === 'notes' ? t('メモ: {text}', {text: (q.typeText || '') + '▌'}) : q.notes ? t('メモ: {text}', {text: q.notes}) : t('メモ: n で追加');
  const questionLines = wrapInk(c.bold(cur.question + (cur.multi ? t('（複数選択）') : '')), inner);
  // win: null for every item, or the item list to show (indicators included
  // as plain rows). cap: how many preview rows to show.
  const buildKids = (cap, win) => {
    const kids = [...head, ...questionLines];
    const itemLines = win ?? items.flat();
    let previewHidden = 0;
    if (preview) {
      const shown = displayRows.slice(0, cap);
      previewHidden = displayRows.length - shown.length;
      // The bordered pane shrink-wraps its longest shown row in Ink (a
      // flexShrink box inside the flexShrink right half): its outer width is
      // that row + border + padding, not the whole right half.
      const paneContentW = Math.max(1, ...shown.map(l => width(l || ' ')));
      const paneOuter = Math.min(vertical ? innerW : innerW - leftW, paneContentW + 4);
      const pane = singleBox(shown.map(l => ' ' + pad(l || ' ', paneContentW)), {width: paneOuter, borderColor: null});
      if (vertical) {
        kids.push(...itemLines, ...pane);
      } else {
        const n = Math.max(itemLines.length, pane.length);
        for (let k = 0; k < n; k++) kids.push(trimLine(pad(itemLines[k] ?? '', leftW) + (pane[k] ?? '')));
      }
    } else {
      kids.push(...itemLines);
    }
    if (previewHidden > 0) kids.push(trunc(c.yellow('  ' + t('✂ {n} 行を省略', {n: previewHidden})), inner));
    kids.push(...wrapInk(c.blue(c.italic(note)), inner));
    return kids;
  };
  let out = assemble(buildKids(8, null));
  // Small terminal (wave 7): first the preview gives way, then the option
  // list becomes a window around the selection (indicators count the hidden
  // choices). Ordinary heights keep the drawing above, line for line.
  if (rows < 20 && out.length > rows) {
    for (let cap = 7; cap >= 0 && out.length > rows; cap--) out = assemble(buildKids(cap, null));
    if (out.length > rows) {
      // Lines outside the item list in the cap-0 drawing: head, question,
      // the preview-omission note and the memo line.
      const cap0 = buildKids(0, null);
      const outside = cap0.length - items.flat().length;
      let budget = Math.max(1, rows - 1 - 2 - footerLines.length - outside);
      let a = selItem, b = selItem + 1, used = items[selItem].length;
      let grew = true;
      while (grew) {
        grew = false;
        if (b < items.length && used + items[b].length + ((a > 0 ? 1 : 0) + (b + 1 < items.length ? 1 : 0)) <= budget) { used += items[b].length; b++; grew = true; continue; }
        if (a > 0 && used + items[a - 1].length + ((a - 1 > 0 ? 1 : 0) + (b < items.length ? 1 : 0)) <= budget) { used += items[a - 1].length; a--; grew = true; }
      }
      // The indicators give way before the selection does: when even the
      // selected item plus both counts cannot fit, the counts go (down
      // first). The chat item keeps its LAST line under a cap — its first
      // line is only the separator; the label is the selection.
      let showUp = a > 0, showDown = b < items.length;
      const indCount = () => (showUp ? 1 : 0) + (showDown ? 1 : 0);
      let keep = items[selItem].length;
      while (keep + indCount() > budget && (showUp || showDown)) { if (showDown) showDown = false; else showUp = false; }
      keep = Math.min(keep, Math.max(1, budget - indCount()));
      const win = [];
      if (showUp) win.push(trunc(c.faint('  ' + t('↑ ほか {n} 件', {n: a})), leftW));
      for (let i = a; i < b; i++) {
        let lines = items[i];
        if (i === selItem && lines.length > keep) lines = selItem === items.length - 1 ? lines.slice(lines.length - keep) : lines.slice(0, keep);
        win.push(...lines);
      }
      if (showDown) win.push(trunc(c.faint('  ' + t('↓ ほか {n} 件', {n: items.length - b})), leftW));
      out = assemble(buildKids(0, win));
    }
  }
  return out;
}
