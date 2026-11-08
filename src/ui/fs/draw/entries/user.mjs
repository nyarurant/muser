// Draws the 'user' entry: the user bubble with text, files, images and empty-text label.
// Mirrors view.mjs Entry case 'user': a Box with marginTop/marginBottom 1,
// backgroundColor '#2d2d34', paddingX 1, width W, column. The first row is '❯ ' (ACCENT)
// plus the text wrapped at W-4 (continuations hang under the text column); each file,
// the missing list and each image is one truncate-end Line at W-2. The empty-text
// label names what was actually sent: images only / files only / both / neither.
//
// Three probed Ink behaviours are worked around here (shared files are not touched):
//  - term.js colours close with 0m, which also clears the bubble background, while
//    Ink closes fg with 39m and keeps the background. bgLine() reopens the background
//    after every reset inside a bubble line, so text and padding keep bg #2d2d34.
//  - wrapInk carries the separator space onto the next row when the previous row is
//    exactly full; Ink drops that one space (1 space -> none, 2 -> 1, 3 -> 2, a tab
//    expanded to 8 -> 7). wrapTextColumn() drops exactly one leading space from a
//    wrapped row whose predecessor, as wrapInk laid it out, was exactly bodyW wide.
//  - truncateEnd leaves the style open across '…' (as Ink does), but the padding after
//    a Line is outside the Text, so attachmentLine() closes the style before padding
//    or the padding cells inherit the line's colour.
// Newlines in e.text split before wrapping (probed: each segment wraps on its own,
// continuations start under the text column, empty segments still paint a full-width
// background line, trailing newlines add background lines).
import {createRequire} from 'node:module';
import {c, width, pad, wrapInk, truncateEnd} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

const RESET = '\x1b[0m';
// The background open escape, derived from c.userBg so it quantises the same way
// term.js does (truecolor 48;2;45;45;52, otherwise the 256-colour form).
const BG_OPEN = (() => { const s = c.userBg(''); return s.endsWith(RESET) ? s.slice(0, -RESET.length) : ''; })();

function bgLine(s) {
  if (!BG_OPEN) return s;
  return BG_OPEN + String(s).split(RESET).join(RESET + BG_OPEN) + RESET;
}

function wrapTextColumn(text, bodyW) {
  const rows = wrapInk(text, bodyW);
  return rows.map((row, i) => {
    if (i === 0 || width(rows[i - 1]) !== bodyW) return row;
    return row.replace(/^((?:\x1b\[[0-9;]*m)*) /, '$1');
  });
}

function attachmentLine(s, max) {
  return truncateEnd(s, max) + RESET;
}

export function drawUser(e, ctx) {
  const W = ctx.W;
  const innerW = W - 2; // paddingX 1 on each side
  const bodyW = Math.max(1, innerW - 2); // the '❯ ' prefix column
  // The empty-text label names what was actually sent (deep r1 R1-9).
  const emptyLabel = e.images?.length && !e.files?.length ? t('（画像のみ）') : e.files?.length && !e.images?.length ? t('（ファイルのみ）') : e.files?.length || e.images?.length ? t('（添付のみ）') : t('（本文なし）');
  const text = e.text ? e.text.replace(/(^|\s)(@\S+)/g, (m, a, b) => a + c.accent(b)) : c.faint(emptyLabel);
  const content = [];
  String(text).split('\n').forEach((seg, si) => {
    wrapTextColumn(seg, bodyW).forEach((row, ri) => {
      content.push((si === 0 && ri === 0 ? c.accent('❯ ') : '  ') + row);
    });
  });
  for (const f of (e.files || [])) {
    content.push(attachmentLine('  ' + c.accent('◇ ') + c.gray(f.ref + (f.kind === 'dir' ? '/ ' + t('{n} ファイル', {n: f.count}) : f.kind === 'file' ? ' ' + t('{n} 行', {n: f.lines}) : f.kind === 'large' ? t(' 大きいため名前のみ') : t(' (バイナリ)'))), innerW));
  }
  if (e.missing?.length) content.push(attachmentLine('  ' + c.yellow(t('見つからない: {list}', {list: e.missing.join(', ')})), innerW));
  for (const [i, n] of (e.images || []).entries()) {
    content.push(attachmentLine('  ' + c.accent('▣ ') + c.gray(t('画像 {i} {name}', {i: i + 1, name: n})), innerW));
  }
  const out = [''];
  for (const l of content) out.push(bgLine(' ' + pad(l, innerW) + ' '));
  out.push('');
  return out;
}
