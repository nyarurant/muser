// Draws the 'md' entry: rendered markdown rows (e.rows, e.first).
// Mirrors view.mjs Md/Row: each row is a hanging row — the '⏺ ' / '  ' first
// marker plus the row's own prefix, then the text wrapped at cols minus the
// prefix width. Code rows (r.code) truncate instead of wrapping unless the
// codeWrap setting says otherwise; table rows (r.table) always truncate,
// even with codeWrap on, so their borders never break (wave 13). The Md
// root has no explicit width, so it lays out at ctx.cols (W + 1), not W.
// Rows [] (or missing) draw nothing
// (an empty box renders nothing). Row substitutes ' ' for empty text; hanging()
// does not, so the substitution is done here.
//
// Wave 14 (W13-12): a truncated row used to show only the bare '…' that
// truncateEnd appends, so the scale of the loss was invisible (a whole
// table column can hide behind it). When any table / truncated-code row
// of the entry is cut, ONE final line counts the characters the drawn
// lines hide, in the approval screen's idiom (' … ほか {n} 文字',
// src/ui/fs/draw/live/approval.mjs). The count is over the rows as given
// here — graphemes of the plain text that truncateEnd does not keep —
// so the finished entry and the live preview (draw/live/preview.mjs,
// the same rule over the rows it draws) each report what they hid.
import {createRequire} from 'node:module';
import {c, graphemesOf, hanging, strip, truncateEnd, width} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

// Characters (graphemes of the plain text) that drawing `text` truncated
// to a body of `bodyW` cells hides: everything truncateEnd does not keep
// (its trailing '…' is not part of the text, so it is not counted).
function hiddenChars(text, bodyW) {
  const body = String(text ?? ' ');
  if (width(body) <= bodyW) return 0;
  const kept = Math.max(0, graphemesOf(strip(truncateEnd(body, bodyW))).length - 1);
  return Math.max(0, graphemesOf(strip(body)).length - kept);
}

export function drawMd(e, ctx) {
  const rows = e?.rows || [];
  if (!rows.length) return [];
  const out = [];
  let hidden = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const prefix = (e.first && i === 0 ? '⏺ ' : '  ') + (r.prefix ?? '');
    const wrapMode = r.table ? 'truncate-end' : r.code && !ctx.codeWrap ? 'truncate-end' : 'wrap';
    if (wrapMode === 'truncate-end') hidden += hiddenChars(r.text || ' ', Math.max(1, ctx.cols - width(prefix)));
    out.push(...hanging(prefix, r.text || ' ', {width: ctx.cols, wrapMode}));
  }
  if (hidden > 0) out.push(truncateEnd(' ' + c.faint(t(' … ほか {n} 文字', {n: hidden})), ctx.cols));
  return out;
}
