// Draws the live Working row while busy (and not running, with no approval).
// Mirrors view.mjs Working() (L336-343) + useTick (L324-329). The tick reads
// ctx.now (never Date.now()) so tests can fix the clock; with motion off the
// spinner stands still (n = 0). marginTop 1 is one blank line before the row.
// Width: the root Box has no width, so it lays out inside Live's width-W Box;
// the narrow Line truncates at W, the wide row lays its two Texts out the
// way Ink/Yoga does (wideRow below: proportional shrink, ceil/floor).
import {createRequire} from 'node:module';
import {SPIN, THINKING_WORDS, WRITING_WORDS, spinnerWord, spinTick, elapsed, c, truncateEnd, wrapInk, width, cellsOf} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {switchValue} = require('../../../../settings.js');

export function drawWorking(s, ctx) {
  const state = s || {};
  const W = ctx?.W;
  const now = ctx?.now ?? 0;
  const n = switchValue('motion') ? spinTick(now) : 0;
  const what = state.status === 'waiting_for_approval' ? t('Muse 側で承認待ち（muse.ai を確認）') : state.museRunning ? state.museRunning + '…' : state.activity ? state.activity + '…' : state.spinnerWord ? state.spinnerWord + '…' : state.stream?.partial ? spinnerWord(WRITING_WORDS, state.turnStart) : spinnerWord(THINKING_WORDS, state.turnStart);
  // Narrow: column Box, marginTop 1; the first row is a Line (truncate-end),
  // the second a plain Text (wrap). The wide branch of view.mjs uses
  // elapsed(Date.now() - s.turnStart) with NO fallback (NaN -> '0s' via
  // elapsed); the narrow branch uses (s.turnStart || Date.now()). Both are
  // reproduced with now in place of Date.now().
  if (W && W < 50) return ['', truncateEnd(c.accent(SPIN[n % SPIN.length] + ' ' + what), W), ...wrapInk(c.faint('  ' + elapsed(now - (state.turnStart || now)) + t(' · esc で中断')), W)];
  const C = W || (ctx?.cols ? ctx.cols - 1 : 80);
  return ['', ...wideRow(c.accent(SPIN[n % SPIN.length] + ' ' + what), c.faint('  ' + elapsed(now - state.turnStart) + t(' · esc で中断')), C)];
}

// --- wide row: two Texts in a row Box (Ink/Yoga flex layout) -----------------
// Each Text is measured at the container width C (its natural width, or the
// widest line of it wrapped at C). When the two do not fit, both shrink in
// proportion to their measured widths: fA = bA*C/(bA+bB). Yoga rounds the
// first item's width up and its left edge down, so the second item starts
// one cell inside the first item's width: Aw = ceil(fA), Bleft = floor(fA),
// Bw = C - Bleft. Each Text wraps at its own width, the rows are composed
// cell by cell (the Output grid), and a wide char straddling Bleft becomes
// a blank in the first item's style, exactly as Ink's overlapping write does.
// (Probed 2026-11-06 against Yoga directly and against renderToString:
// 35+ width pairs fit this rule with no min-content clamp.)
const ESC = '\u001b';
const PLAIN_CELL = {ch: ' ', fg: null, bg: null, bold: false, dim: false, italic: false, under: false, strike: false, inverse: false};
const PLAIN_KEY = [null, null, false, false, false, false, false, false].join('|');
const styleKey = cl => [cl.fg, cl.bg, cl.bold, cl.dim, cl.italic, cl.under, cl.strike, cl.inverse].join('|');
function openStyle(cl) {
  let s = '';
  const col = (v, ground) => {
    if (!v) return '';
    const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(v);
    if (rgb) return ESC + '[' + ground + ';2;' + rgb[1] + ';' + rgb[2] + ';' + rgb[3] + 'm';
    const pal = /^pal(\d+)$/.exec(v);
    if (pal) return ESC + '[' + ground + ';5;' + pal[1] + 'm';
    return '';
  };
  s += col(cl.fg, 38);
  s += col(cl.bg, 48);
  if (cl.bold) s += ESC + '[1m';
  if (cl.dim) s += ESC + '[2m';
  if (cl.italic) s += ESC + '[3m';
  if (cl.under) s += ESC + '[4m';
  if (cl.inverse) s += ESC + '[7m';
  if (cl.strike) s += ESC + '[9m';
  return s;
}
// Cells back to a string: the parity harness compares per-cell styles, not
// raw bytes, so any encoding with the same cells matches. Wide-char
// continuation cells (ch '') are skipped; the leading cell carries the glyph.
function cellsToString(cells) {
  let out = '', key = null, text = '', style = PLAIN_CELL, isOpen = false;
  const flush = () => {
    if (!text) return;
    if (key === PLAIN_KEY) {
      if (isOpen) { out += ESC + '[0m'; isOpen = false; }
      out += text;
    } else {
      out += ESC + '[0m' + openStyle(style) + text;
      isOpen = true;
    }
    text = '';
  };
  for (const cell of cells) {
    if (cell.ch === '') continue;
    const k = styleKey(cell);
    if (k !== key) { flush(); key = k; style = cell; }
    text += cell.ch;
  }
  flush();
  if (isOpen) out += ESC + '[0m';
  return out;
}
const widestLine = (styled, max) => {
  const n = width(styled);
  if (n <= max) return n;
  let w = 0;
  for (const l of wrapInk(styled, max)) w = Math.max(w, width(l));
  return w;
};
function wideRow(aStyled, bStyled, C) {
  const bA = widestLine(aStyled, C), bB = widestLine(bStyled, C);
  let aW, bLeft, bW;
  if (bA + bB <= C) { aW = bA; bLeft = bA; bW = bB; }
  else { const fA = (bA * C) / (bA + bB); aW = Math.ceil(fA); bLeft = Math.floor(fA); bW = C - bLeft; }
  const aLines = wrapInk(aStyled, aW), bLines = wrapInk(bStyled, bW);
  const out = [];
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    const aCells = i < aLines.length ? cellsOf(aLines[i]) : [];
    const bCells = i < bLines.length ? cellsOf(bLines[i]) : null;
    if (bCells === null) { out.push(cellsToString(aCells)); continue; }
    const row = aCells.slice(0, bLeft);
    if (bLeft > 0 && aCells.length > bLeft && aCells[bLeft]?.ch === '') row[bLeft - 1] = {...row[bLeft - 1], ch: ' '};
    while (row.length < bLeft) row.push({...PLAIN_CELL});
    out.push(cellsToString([...row, ...bCells]));
  }
  return out;
}
