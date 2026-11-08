// Text selection for the fullscreen screen: muser owns the mouse there (for the wheel), so the
// terminal's own selection needs Shift and copies whatever frame happens to be drawn. This
// selects by dragging, kept in conversation terms (entry index + line + cell) so a drag past the
// top or bottom edge can scroll and keep growing, and copies on release.
import {createRequire} from 'node:module';
const {width} = createRequire(import.meta.url)('../../tui/term.js');

const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const strip = s => String(s).replace(ANSI, '');
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

// The graphemes of a plain line with the cell each starts at and how many cells it takes.
export function cellsOf(plain) {
  const out = []; let col = 0;
  // A tab advances to the next multiple-of-8 stop, so its width depends on the
  // column it lands on — measuring it alone (width('\t') = 8, from column 0)
  // put every character after a tab too far right (master-debug #8).
  for (const {segment} of segmenter.segment(plain)) { const w = segment === '\t' ? 8 - (col % 8) : Math.max(0, width(segment)); out.push({g: segment, col, w}); col += w; }
  return out;
}
// The text of cells [c0, c1): a grapheme counts when its first cell is inside the range.
export function textBetween(plain, c0, c1) {
  let s = '';
  for (const c of cellsOf(plain)) if (c.col >= c0 && c.col < c1) s += c.g;
  return s;
}
// The row drawn plainly with cells [c0, c1) in reverse video (its own colours give way while
// it is selected, so the highlight reads the same on every row).
export function highlight(line, c0, c1) {
  let before = '', mid = '', after = '';
  for (const c of cellsOf(strip(line))) (c.col < c0 ? (before += c.g) : c.col < c1 ? (mid += c.g) : (after += c.g));
  return before + (mid ? '\x1b[7m' + mid + '\x1b[27m' : '') + after;
}
const cmp = (a, b) => a.idx - b.idx || a.off - b.off;
// a, b: {ref: {idx, off}, col}. Returns them in reading order.
export function ordered(a, b) { const d = cmp(a.ref, b.ref); return d < 0 || (d === 0 && a.col <= b.col) ? [a, b] : [b, a]; }
// Which cells of the row at ref are selected: [c0, c1), or null.
export function rowRange(sel, ref) {
  if (!sel || !ref) return null;
  const [a, b] = ordered(sel.anchor, sel.head);
  if (cmp(ref, a.ref) < 0 || cmp(ref, b.ref) > 0) return null;
  return [cmp(ref, a.ref) === 0 ? a.col : 0, cmp(ref, b.ref) === 0 ? b.col + 1 : Infinity];
}
// The selected text, from rows given as [{ref, line}] in reading order (History.linesBetween).
// Wave 14 (W13-12): a group of rows tagged with an md entry's src
// (History.linesBetween tags an entry only when the span covers all of
// its lines) is copied as that src — the drawn lines are truncated, the
// source is not — provided the selection's columns also cover the entry
// whole: at the start when this group is the selection's first (col 0),
// and at the end when it is the last (the head reaches the last drawn
// line's final grapheme). A group in the middle is covered whole by
// position alone. Every other group keeps the drawn-text behaviour
// below, per line, exactly as before; segments join with '\n' in order,
// so a mixed selection yields src for whole md entries and drawn lines
// for the rest.
export function selectedText(sel, rows) {
  const [a, b] = ordered(sel.anchor, sel.head);
  const drawn = ({ref, line}) => {
    const plain = strip(line);
    const c0 = cmp(ref, a.ref) === 0 ? a.col : 0, c1 = cmp(ref, b.ref) === 0 ? b.col + 1 : Infinity;
    return textBetween(plain, c0, c1).replace(/\s+$/, '');
  };
  const segments = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && rows[j].ref.idx === rows[i].ref.idx && rows[j].src === rows[i].src) j++;
    const group = rows.slice(i, j);
    let useSrc = typeof group[0].src === 'string' && !!group[0].src;
    if (useSrc && i === 0 && a.col !== 0) useSrc = false;
    if (useSrc && j === rows.length) {
      const cells = cellsOf(strip(group[group.length - 1].line));
      const lastStart = cells.length ? cells[cells.length - 1].col : 0;
      if (b.col < lastStart) useSrc = false;
    }
    segments.push(useSrc ? group[0].src : group.map(drawn).join('\n'));
    i = j;
  }
  return segments.join('\n');
}
