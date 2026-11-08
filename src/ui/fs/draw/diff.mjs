// Draws a diff block within width W, up to max lines.
// Mirrors view.mjs Diff({diff, W, max = 30}): the caller (the tool entry, and
// stage B3's approval screen) renders the returned lines inside a column
// laid out at cols (= W + 1); every line built here is at most W - 3 cells
// wide, so the Ink Line (wrap: truncate-end) around them never cuts.
// Null-safe (the approval screen and resumed records can hand it anything):
// a non-array diff draws nothing, and a nullish row draws as an empty
// context row instead of throwing the way the React side would.
// The number column fits the largest line number among the SHOWN rows only.
// A changed line that is too wide is cut keeping its HEAD (wave 6; it used
// to keep the tail, which hid what the line starts with — the change itself
// usually reads from the start); a context line is cut with term.js
// truncate (which resets before the '…'), exactly as view.mjs builds it.
// Tabs are expanded to spaces BEFORE measuring, at the column the body
// actually starts (after the indent + number + sign prefix): width()
// measures a tab from column 0, so a tabbed line's measured width was
// short of its rendered width and the +/- background band (pad to bodyW)
// ended early (wave 6).
import {createRequire} from 'node:module';
import {c, width, pad, truncateEnd, graphemesOf} from './primitives.mjs';
const require = createRequire(import.meta.url);
const {truncate} = require('../../../tui/term.js');
const {t} = require('../../../i18n.js');

// Expand tabs to spaces as the terminal renders them from `startCol`
// (tab stops are every 8 cells from the line's start, prefix included).
const expandTabs = (s, startCol) => {
  if (!s.includes('\t')) return s;
  let col = startCol, out = '';
  for (const g of graphemesOf(s)) {
    if (g === '\t') { const n = 8 - (col % 8); out += ' '.repeat(n); col += n; continue; }
    out += g; col += width(g);
  }
  return out;
};

export function drawDiff(diff, W, max = 30, omitted = 0) {
  const rows = Array.isArray(diff) ? diff : [];
  const shown = rows.slice(0, max);
  const numW = Math.max(3, String(shown.reduce((m, d) => Math.max(m, d?.n || 0), 0)).length);
  const bodyW = W - numW - 12;
  const out = [];
  for (const d of shown) {
    if (d?.t === '…') { out.push(c.faint('      ' + ' '.repeat(numW) + ' ⋮')); continue; }
    const raw = expandTabs(String(d?.l ?? ''), numW + 9); // 6 spaces + num + ' + ' / '   '
    const num = String(d?.n || '').padStart(numW);
    if (d?.t === '+' || d?.t === '-') {
      const cut = truncateEnd(raw, bodyW);
      const body = pad(cut, bodyW);
      out.push('      ' + (d.t === '+' ? c.addBg(num + ' + ' + body) : c.delBg(num + ' - ' + body)));
      continue;
    }
    out.push('      ' + c.faint(num) + '   ' + c.gray(truncate(raw, bodyW)));
  }
  // History entries keep only the first lines plus an omitted count (src/slim-call.js),
  // as view.mjs Diff does.
  const hidden = (rows.length > max ? rows.length - max : 0) + (omitted || 0);
  if (hidden > 0) out.push(c.faint('      ' + t('… ほか {n} 行', {n: hidden})));
  return out;
}
