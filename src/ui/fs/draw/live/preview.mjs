// Draws the live table preview rows; reads ctx.ctrl.previewRow() itself.
// Mirrors view.mjs Live L806-807: the table rows (code, always) then the
// single row, each as a Row (hanging indent, prefix never shrinks). The table
// is its last max(4, ctx.rows - 16) rows. No preview returns [] (not null:
// drawLive only bails to React when a preview actually exists).
//
// Wave 14 (W13-12): like the finished entry (draw/entries/md.mjs), when a
// table row or a truncated code row drawn here is cut, ONE final line
// counts the hidden characters in the approval idiom (' … ほか {n} 文字').
// The count is over the rows this draw was given and the width it drew
// them at — the frozen-width rows from md.mjs fit() arrive already cut to
// their frozen columns, so what this draw itself hides is what it counts,
// keeping the preview and the finished entry on the same rule.
import {createRequire} from 'node:module';
import {c, graphemesOf, hanging, strip, truncateEnd, width} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

// Same counting as draw/entries/md.mjs hiddenChars: graphemes of the
// plain text that truncateEnd does not keep (its '…' is not counted).
function hiddenChars(text, bodyW) {
  const body = String(text ?? ' ');
  if (width(body) <= bodyW) return 0;
  const kept = Math.max(0, graphemesOf(strip(truncateEnd(body, bodyW))).length - 1);
  return Math.max(0, graphemesOf(strip(body)).length - kept);
}

export function drawPreview(s, ctx) {
  const ctrl = ctx?.ctrl;
  const preview = typeof ctrl?.previewRow === 'function' ? ctrl.previewRow() : null;
  if (!preview) return [];
  const W = ctx?.W ?? 40;
  const rows = ctx?.rows ?? 30;
  const out = [];
  let hidden = 0;
  const table = (preview.table || []).slice(-Math.max(4, rows - 16));
  for (let i = 0; i < table.length; i++) {
    const r = table[i];
    // Table rows always truncate, even with codeWrap on (wave 13): wrapping
    // one breaks its column borders, as on the classic side (Row table).
    const prefix = (preview.first && i === 0 ? '⏺ ' : '  ') + r.prefix;
    hidden += hiddenChars(r.text || ' ', Math.max(1, W - width(prefix)));
    out.push(...hanging(prefix, r.text || ' ', {width: W, wrapMode: 'truncate-end'}));
  }
  if (preview.row) {
    const code = preview.row.code;
    const wrapMode = preview.row.table ? 'truncate-end' : code && !ctx?.codeWrap ? 'truncate-end' : 'wrap';
    const prefix = (preview.first && !preview.table?.length ? '⏺ ' : '  ') + preview.row.prefix;
    if (wrapMode === 'truncate-end') hidden += hiddenChars(preview.row.text || ' ', Math.max(1, W - width(prefix)));
    out.push(...hanging(prefix, preview.row.text || ' ', {width: W, wrapMode}));
  }
  if (hidden > 0) out.push(truncateEnd(' ' + c.faint(t(' … ほか {n} 文字', {n: hidden})), W));
  return out;
}
