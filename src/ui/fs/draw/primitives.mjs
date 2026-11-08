// Shared drawing primitives for the fullscreen screen (stage 2, stage A).
// Pure functions: strings in, strings out. Colours come from src/tui/term.js
// (c / width); the layout here reproduces what Ink does, probed 2026-11-06
// (scratchpad/pty/probe-ink.mjs, FORCE_COLOR=3 + COLORTERM=truecolor):
//  - Ink hex colours come out as 38;2;r;g;b, exactly what term.js rgb() emits
//    with COLORTERM=truecolor (and both quantise to the same 38;5;n without it,
//    via the same 6x6x6 cube). Ink closes fg with 39m / bold with 22m where
//    term.js closes with 0m; the cells look the same, so the parity harness
//    compares per-cell styles, not raw bytes.
//  - wrap: faithful to wrap-ansi called with {trim: false, hard: true}
//    (ink/build/wrap-text.js) plus Ink's output stage, which trims trailing
//    spaces off every rendered line. Words split on spaces; the space before a
//    word is always added first, even on a fresh row, where it becomes a
//    leading space. A word longer than the width stays on this row when that
//    takes fewer new rows than starting it on the next row; otherwise it moves
//    and is cut into width-sized pieces. Styles close at every row break and
//    reopen on the next row (restoreStyles below).
//  - truncate-end: Ink keeps the open style across the '…' (term.js truncate
//    inserts a reset before it, so the '…' loses the style). truncateEnd below
//    keeps the style of a span that keeps a character; a span that starts
//    exactly at the cut does not reach the '…'.
//  - a border colours its whole top/bottom lines and its side bars; the content
//    is padded to the box width; a background fills the whole box width.
//  - a box with no content renders nothing at all (not even its margins).
import {createRequire} from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const {c, width, strip, pad, ESC, rgb} = require('../../../tui/term.js');
const {t} = require('../../../i18n.js');
const {LABELS} = require('../../../policy.js');
export {c, width, strip, pad};

export const SPIN = ['✻', '✽', '✶', '✳', '✢', '·', '✢', '✳', '✶', '✽'];
export const THINKING_WORDS = ['Musing', 'Daydreaming', 'Mulling', 'Wondering', 'Stargazing', 'Imagining', 'Conjuring', 'Woolgathering', 'Tinkering', 'Sparking'];
export const WRITING_WORDS = ['Composing', 'Penning', 'Inking', 'Scribbling', 'Drafting', 'Weaving'];
export const spinnerWord = (list, seed) => list[Math.abs(Math.floor(Number(seed) || 0)) % list.length] + '…';
// The spinner frame for a moment in time: what useTick reads off the clock when
// clockTicks is on (view.mjs). Pass ctx.now.
export const spinTick = (now, ms = 100) => Math.floor(now / ms);
// Elapsed time with an hour unit once it reaches one (wave 6): the old form
// stopped at minutes, so a two-hour turn read '125m 0s'. Same shape as the
// minute form: largest unit first, the smaller ones after it.
export const elapsed = ms => { const n = Number(ms); const s = Math.floor((Number.isFinite(n) && n > 0 ? n : 0) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ' + (s % 60) + 's'; };
export const focusLabel = status => t(({running: '確認中', complete: '条件の根拠が揃いました', needs_input: '確認・判断待ち', stalled: '進展がないため停止', limit: '上限で停止', stopped: '中断しました', blocked: '続行できません', inactive: '追跡対象外'})[status] || '確認中');
export const modeLabel = m => t(LABELS[m]);

const TITLES = {'shell.output': 'Output', 'shell.kill': 'Kill', 'shell.list': 'Shells', 'code.read': 'Read', 'code.grep': 'Search', 'code.glob': 'Glob', 'code.edit': 'Update', 'code.write': 'Write', 'code.apply_patch': 'Patch', 'todo.write': 'Todo', 'skill.read': 'Skill'};
export const toolTitle = call => call.user ? '! ' + (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.kind === 'agent' ? (call.command === 'agent.spawn' ? 'Agent' : 'Wait') : call.kind === 'mcp' ? 'MCP' : call.command === 'system.run' ? (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.command === 'code.write' && call.view?.created ? 'Create' : TITLES[call.command] || call.command;
export const glyphFor = call => {
  if (call.user) return '▶';
  if (call.kind === 'agent') return '◆';
  if (call.kind === 'mcp') return '⚙';
  switch (call.command) {
    case 'system.run': return '▶';
    case 'shell.kill': return '■';
    case 'code.edit': case 'code.write': case 'code.apply_patch': return '✎';
    case 'code.grep': return '≡';
    case 'code.glob': return '☰';
    default: return call.command?.startsWith('shell.') ? '▶' : '⏺';
  }
};
// Keep the END of a string that is too wide (view.mjs tailText, same result
// for plain text). Wave 6: the walk is over tokens(), not raw graphemes —
// the old grapheme walk cut ANSI escape sequences in half on STYLED values
// (the /status rows carry c.faint / c.green spans), printing escape
// fragments as garbage and losing the style. Escape tokens are never
// split: every escape before the kept tail is replayed in order, so the
// tail renders in exactly the state the original string had there.
export const tailText = (str, max) => {
  const s = String(str ?? '');
  if (width(s) <= max) return s;
  if (max <= 1) return '…';
  const toks = tokens(s);
  let w = 0, start = toks.length;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.esc) continue;
    const tw = t.tab ? tabWidth(w) : t.w;
    if (w + tw > max - 1) break;
    w += tw; start = i;
  }
  const pre = toks.slice(0, start).filter(t => t.esc).map(t => t.esc).join('');
  return '…' + pre + toks.slice(start).map(t => t.esc ?? (t.tab ? '\t' : t.ch)).join('');
};
// Cut the MIDDLE of a string that is too wide, keeping the head and the
// tail (wave 6): for texts whose meaning sits at both ends — a flash whose
// last word is a negation, a menu label whose suffix says （復元できません）
// — an end cut silently drops the part that changes the meaning. Style-safe
// like tailText: escapes are walked as tokens, and the escapes before the
// kept tail are replayed so the tail keeps its style.
export function truncateMiddle(s, max) {
  const str = String(s ?? '');
  if (width(str) <= max) return str;
  if (max <= 2) return truncateEnd(str, max);
  // The tail gets slightly more than half: the suffix is usually the part
  // that changes the meaning, and a wide character stopping the head
  // early hands its leftover over anyway (below).
  const budget = max - 1, headB = Math.ceil(budget * 0.45);
  const toks = tokens(str);
  let out = '', w = 0; const pending = [];
  let headNext = toks.length;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.esc) { pending.push(t.esc); continue; }
    const tw = tokenWidth(t, w);
    if (w + tw > headB) { headNext = i; break; }
    out += pending.join('') + (t.tab ? '\t' : t.ch); pending.length = 0; w += tw; headNext = i + 1;
  }
  // The tail gets whatever the head did not use (a wide character can
  // leave the head a cell short of its half).
  const tailB = budget - w;
  let tw2 = 0, tailStart = toks.length;
  for (let i = toks.length - 1; i >= headNext; i--) {
    const t = toks[i];
    if (t.esc) continue;
    const twd = t.tab ? 1 : t.w;
    if (tw2 + twd > tailB) break;
    tw2 += twd; tailStart = i;
  }
  if (tailStart >= toks.length) return out + '…';
  const pre = toks.slice(0, tailStart).filter(t => t.esc).map(t => t.esc).join('');
  return out + '…' + pre + toks.slice(tailStart).map(t => t.esc ?? (t.tab ? '\t' : t.ch)).join('');
}
// A path inside the working folder is shown relative (view.mjs relPath, same code).
export const relPath = (cwd, p) => {
  if (typeof p !== 'string') return String(p ?? '');
  const r = path.relative(cwd, p);
  return r.startsWith('..') ? p : r || p;
};
// An arbitrary '#rrggbb' as a term.js colour function (Ink border colours etc.).
export const hex = h => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(h || ''));
  if (!m) return s => s;
  const n = parseInt(m[1], 16);
  return rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
};

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
export const graphemesOf = s => graphemeSegmenter ? [...graphemeSegmenter.segment(s)].map(g => g.segment) : [...s];

// --- tokens: a styled string walked cell by cell (same single-pass shape as
// term.js tokens(), which is not exported). ANSI_SRC is term.js's pattern.
const ANSI_SRC = '\\x1b\\[[0-?]*[ -/]*[@-~]' +
  '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\|$)' +
  '|\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\|$)' +
  '|\\x1b[ -/]*[0-~]';
const ANSI_AT = new RegExp(ANSI_SRC, 'y');
const TAB = 8;
const tabWidth = col => TAB - (col % TAB);
// The SGR state of a cell: what the parity harness compares too.
// Tracked as a small object so the test helper can reuse the same transitions.
export function sgrState() { return {fg: null, bg: null, bold: false, dim: false, italic: false, under: false, strike: false, inverse: false}; }
export function sgrApply(st, esc) {
  const m = /^\x1b\[([0-9;]*)m$/.exec(esc);
  if (!m) return st;
  const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
  for (let i = 0; i < codes.length; i++) {
    const n = codes[i];
    if (n === 0) { st.fg = null; st.bg = null; st.bold = false; st.dim = false; st.italic = false; st.under = false; st.strike = false; st.inverse = false; }
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.under = true;
    else if (n === 7) st.inverse = true;
    else if (n === 9) st.strike = true;
    else if (n === 22) { st.bold = false; st.dim = false; }
    else if (n === 23) st.italic = false;
    else if (n === 24) st.under = false;
    else if (n === 27) st.inverse = false;
    else if (n === 29) st.strike = false;
    else if (n === 39) st.fg = null;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      const isFg = n === 38;
      if (codes[i + 1] === 2 && codes[i + 2] != null && codes[i + 3] != null && codes[i + 4] != null) {
        const v = 'rgb(' + codes[i + 2] + ',' + codes[i + 3] + ',' + codes[i + 4] + ')';
        if (isFg) st.fg = v; else st.bg = v;
        i += 4;
      } else if (codes[i + 1] === 5 && codes[i + 2] != null) {
        const v = 'pal' + codes[i + 2];
        if (isFg) st.fg = v; else st.bg = v;
        i += 2;
      }
    }
  }
  return st;
}
export const sgrOpen = st => st.fg != null || st.bg != null || st.bold || st.dim || st.italic || st.under || st.strike || st.inverse;

function tokens(s) {
  const out = []; const str = String(s);
  const pushRun = run => {
    if (!run) return;
    // The gate for segmenting: a run is segmented when anything in it can join a
    // grapheme cluster. The combining-mark part used to name only U+0300–U+036F, so
    // a base + a mark outside it — decomposed dakuten U+3099 / handakuten U+309A,
    // the Arabic vowel signs U+064B–U+0652 and U+0654–U+0655, Hebrew points, Indic
    // signs — was tokenised per code point and cellsOf gave the mark a cell of its
    // own (wave 10). The mark categories (Mn / Me / Mc) name them all at once;
    // ZWNJ joins clusters the same way ZWJ does.
    if (graphemeSegmenter && /[\p{Mn}\p{Me}\p{Mc}\u200c\u200d\u20e3\ufe00-\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]/u.test(run)) {
      for (const {segment} of graphemeSegmenter.segment(run)) out.push(segment === '\t' ? {ch: segment, w: 0, tab: true} : {ch: segment, w: width(segment)});
    } else {
      for (const ch of run) out.push(ch === '\t' ? {ch, w: 0, tab: true} : {ch, w: width(ch)});
    }
  };
  let i = 0, runStart = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      ANSI_AT.lastIndex = i; const m = ANSI_AT.exec(str);
      if (m) { pushRun(str.slice(runStart, i)); out.push({esc: m[0]}); i += m[0].length; runStart = i; continue; }
    }
    i++;
  }
  pushRun(str.slice(runStart));
  return out;
}
const tokenWidth = (t, col) => t.tab ? tabWidth(col) : t.w;

// One display cell per column: {ch, fg, bg, bold, dim, italic, under, strike,
// inverse}. A 2-cell grapheme fills two cells (the second has ch: ''); a tab
// expands to spaces. The parity harness compares these, not raw bytes.
export function cellsOf(line) {
  const cells = []; let st = sgrState();
  const snap = () => ({fg: st.fg, bg: st.bg, bold: st.bold, dim: st.dim, italic: st.italic, under: st.under, strike: st.strike, inverse: st.inverse});
  for (const t of tokens(String(line))) {
    if (t.esc) { sgrApply(st, t.esc); continue; }
    if (t.tab) { const n = TAB - (cells.length % TAB); for (let k = 0; k < n; k++) cells.push({ch: ' ', ...snap()}); continue; }
    // A zero-width token (a combining mark the segmenter still left on its own —
    // at the start of a line, say) prints on the previous glyph, so it adds no
    // cell of its own: it rides on the last cell, which keeps plainOf whole.
    // With no cell before it there is nothing to ride on; it keeps a cell so
    // the character itself is not lost.
    if (!t.w) { if (cells.length) cells[cells.length - 1].ch += t.ch; else cells.push({ch: t.ch, ...snap()}); continue; }
    const s = snap();
    cells.push({ch: t.ch, ...s});
    for (let k = 1; k < t.w; k++) cells.push({ch: '', ...s});
  }
  return cells;
}
export const plainOf = cells => cells.map(c => c.ch).join('');
export function cellsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.ch !== y.ch || x.fg !== y.fg || x.bg !== y.bg || x.bold !== y.bold || x.dim !== y.dim || x.italic !== y.italic || x.under !== y.under || x.strike !== y.strike || x.inverse !== y.inverse) return false;
  }
  return true;
}

// Close the styles open at every row break and reopen them on the next row
// (wrap-ansi's restoreStylesAcrossRows). A row that is empty gets neither.
// A style is reopened with the same escapes that opened it; a full reset (0m)
// is used to close, which reads the same per cell as the per-style closes.
export function restoreStyles(text) {
  const lines = String(text).split('\n');
  let out = '', open = '', st = sgrState();
  const sgr = /^\u001b\[[0-9;]*m$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const t of tokens(line)) {
      if (!t.esc || !sgr.test(t.esc)) continue;
      if (t.esc === ESC + '0m') { open = ''; st = sgrState(); } else { open += t.esc; sgrApply(st, t.esc); }
    }
    out += line;
    if (i < lines.length - 1) {
      if (line.length > 0 && open) out += ESC + '0m';
      out += '\n';
      if (lines[i + 1].length > 0 && open) out += open;
    }
  }
  return out;
}

// Ink's wrap, faithful to wrap-ansi called with {trim: false, hard: true}
// (ink/build/wrap-text.js) plus Ink's output stage, which trims trailing
// spaces off every rendered line (ink/build/output.js): a trailing space
// survives only when the line ends with an escape sequence.
//  - words are split on spaces; the space before a word is always added first,
//    even on a fresh row, where it becomes a leading space. A word that fits
//    on an empty line moves to the next line when it does not fit here.
//  - a word longer than the width stays on this row when starting it here takes
//    fewer new rows than starting it on the next row (the breaks math below);
//    otherwise it moves to a fresh row and is cut into width-sized pieces.
//  - tabs expand to spaces first, as wrap-ansi does.
export function wrapInk(s, max) {
  if (max < 8) max = 8;
  let expanded = '';
  {
    let col = 0;
    for (const t of tokens(String(s))) {
      if (t.esc) { expanded += t.esc; continue; }
      if (t.tab) { const n = 8 - (col % 8); expanded += ' '.repeat(n); col += n; continue; }
      expanded += t.ch; col += tokenWidth(t, col);
    }
  }
  const words = [];
  let cur = {value: '', width: 0, toks: []};
  for (const t of tokens(expanded)) {
    if (t.esc) { cur.value += t.esc; cur.toks.push(t); continue; }
    if (t.ch === ' ') { words.push(cur); cur = {value: '', width: 0, toks: []}; continue; }
    cur.value += t.ch; cur.width += t.w; cur.toks.push(t);
  }
  words.push(cur);
  const rows = [''];
  let rowLength = 0;
  const wrapWord = (word, rowLen) => {
    let visible = rowLen;
    const wt = word.toks;
    for (let i = 0; i < wt.length; i++) {
      const token = wt[i];
      const tw = token.esc ? 0 : token.w;
      if (tw > 0 && visible > 0 && visible + tw > max) { rows.push(''); visible = 0; }
      rows[rows.length - 1] += token.esc ?? token.ch;
      visible += tw;
      if (visible === max && i < wt.length - 1) { rows.push(''); visible = 0; }
    }
    if (!visible && rows.at(-1).length > 0 && rows.length > 1) rows[rows.length - 2] += rows.pop();
    return width(rows.at(-1));
  };
  let isFirst = true;
  for (const word of words) {
    if (!isFirst) {
      if (rowLength >= max) { rows.push(''); rowLength = 0; }
      rows[rows.length - 1] += ' '; rowLength++;
    }
    isFirst = false;
    if (word.width > max) {
      const remainingColumns = max - rowLength;
      const breaksThis = 1 + Math.floor((word.width - remainingColumns - 1) / max);
      const breaksNext = Math.floor((word.width - 1) / max);
      if (breaksNext < breaksThis) { rows.push(''); rowLength = 0; }
      rowLength = wrapWord(word, rowLength);
      continue;
    }
    if (rowLength + word.width > max && rowLength > 0 && word.width > 0) {
      rows.push(''); rowLength = 0;
    }
    rows[rows.length - 1] += word.value;
    rowLength += word.width;
  }
  return restoreStyles(rows.join('\n')).split('\n').map(row => (row.endsWith(' ') ? row.replace(/ +$/, '') : row));
}

// Ink's truncate-end: cut to max-1 cells, then '…' in the style of the last
// kept character (term.js truncate() inserts a reset before the '…', losing
// the style). Every escape after that character is dropped: a span that
// starts at the cut does not reach the '…', and a reset after it does not
// clear it either.
export function truncateEnd(s, max) {
  if (width(s) <= max) return s;
  if (max <= 1) return '…';
  let w = 0, out = '';
  const pending = [];
  for (const t of tokens(s)) {
    if (t.esc) { pending.push(t.esc); continue; }
    const tw = tokenWidth(t, w);
    if (w + tw > max - 1) break;
    out += pending.join('') + t.ch; pending.length = 0; w += tw;
  }
  return out + '…';
}

// A hanging-indent row (view.mjs Row): the prefix never shrinks; the text wraps
// under itself. `wrapMode` is 'wrap' or 'truncate-end' (code rows cut unless the
// codeWrap setting says otherwise — the caller passes codeWrap in ctx).
export function hanging(prefix, text, {width: W, wrapMode = 'wrap'} = {}) {
  const pre = String(prefix ?? ''); const preW = width(pre); const bodyW = Math.max(1, W - preW);
  const body = String(text ?? '');
  // Ink's output stage trims trailing spaces off every rendered line (a line
  // ending in an escape sequence keeps them, as in wrapInk's own trim).
  const trim = line => (line.endsWith(' ') ? line.replace(/ +$/, '') : line);
  if (wrapMode === 'truncate-end') return [trim(pre + truncateEnd(body, bodyW))];
  // The text column is bodyW wide; continuation lines fill it, and the offset
  // (the column's own x) is added here, outside the wrapped width — Ink lays
  // the text out the same way, so a continuation is preW + bodyW cells wide.
  return wrapInk(body, bodyW).map((l, i) => trim((i === 0 ? pre : ' '.repeat(preW)) + l));
}
// NOTE: hanging() does not substitute a space for empty text. view.mjs Row does
// (`text || ' '`); callers that mirror Row (the md entry) pass the substituted
// text themselves. The line-end trim above is part of hanging() itself, so
// callers do not trim its lines again.

// A bordered box around already-laid-out lines (Ink borderStyle + paddingX 1).
// The border is `borderColor` (a '#rrggbb' string or null for uncoloured); the
// content is padded to the box width. Returns [] when there is nothing to box
// (an empty box renders nothing).
function box(lines, {width: W, borderColor = null, round = true} = {}) {
  if (!lines.length) return [];
  const inner = Math.max(0, W - 2);
  const paint = borderColor ? hex(borderColor) : s => s;
  const tl = round ? '╭' : '┌', tr = round ? '╮' : '┐', bl = round ? '╰' : '└', br = round ? '╯' : '┘', h = '─', v = round ? '│' : '│';
  const out = [paint(tl + h.repeat(inner) + tr)];
  for (const l of lines) out.push(paint(v) + pad(l, inner) + paint(v));
  out.push(paint(bl + h.repeat(inner) + br));
  return out;
}
export const roundBox = (lines, opts) => box(lines, {...opts, round: true});
export const singleBox = (lines, opts) => box(lines, {...opts, round: false});

// Wraps the buffer by display cells so the caret position is exact
// (view.mjs layout(), same code). Returns {lines, cur: {row, col}}.
export function layout(text, pos, max) {
  const lines = [''], widths = [0]; let cur = {row: 0, col: 0}, i = 0;
  for (const ch of graphemesOf(text)) {
    if (i === pos) cur = {row: lines.length - 1, col: widths[widths.length - 1]};
    i += ch.length;
    if (ch === '\n') { lines.push(''); widths.push(0); continue; }
    const w = width(ch);
    if (widths[widths.length - 1] + w > max) { lines.push(''); widths.push(0); }
    lines[lines.length - 1] += ch; widths[widths.length - 1] += w;
  }
  if (i <= pos) cur = {row: lines.length - 1, col: widths[widths.length - 1]};
  return {lines, cur};
}
