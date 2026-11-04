'use strict';
// Terminal basics: colors, display width (CJK / emoji are two cells), wrapping, truncation.
const ESC = '\x1b[';
// Colours off with NO_COLOR or "color" off in /settings (from the next start). `muser serve` has
// no terminal, but the GUI reads these SGR codes as the bold / heading / code styling of a reply
// (md.mjs rows), so serve turns them on with MUSER_SGR=1 (set in bin/muser.js before this loads).
const on = (process.stdout.isTTY || process.env.MUSER_SGR === '1') && require('../settings').switchValue('color');
const sgr = (...codes) => s => on ? ESC + codes.join(';') + 'm' + s + ESC + '0m' : s;
// Colour depth: 24-bit only when the terminal advertises it (COLORTERM=truecolor/24bit or a
// *-direct / *-truecolor TERM); otherwise quantise to the xterm 256 palette (38;5;n).
const truecolor = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || /-(direct|truecolor)$/.test(process.env.TERM || '');
function rgbTo256(r, g, b) {
  if (r === g && g === b) { // grayscale ramp 232-255, with cube black/white at the extremes
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  return 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51); // 6x6x6 cube 16-231
}
const rgb = (r, g, b) => truecolor ? sgr(38, 2, r, g, b) : sgr(38, 5, rgbTo256(r, g, b));
const bg = (r, g, b) => truecolor ? sgr(48, 2, r, g, b) : sgr(48, 5, rgbTo256(r, g, b)); // bg bypassed the quantisation rgb() applies (recovery scan)

// One accent (Muse violet) on a monochrome base, like Claude Code / Codex.
const c = {
  accent: rgb(180, 160, 255), dim: sgr(2), bold: sgr(1), italic: sgr(3), under: sgr(4), strike: sgr(9),
  gray: rgb(140, 140, 150), faint: rgb(95, 95, 105), text: s => s,
  red: rgb(240, 110, 110), green: rgb(120, 205, 130), yellow: rgb(230, 190, 100), blue: rgb(120, 170, 240),
  code: rgb(215, 175, 255),
  addBg: s => bg(25, 60, 35)(rgb(170, 235, 170)(s)), delBg: s => bg(70, 28, 32)(rgb(245, 170, 170)(s)),
  userBg: s => bg(45, 45, 52)(s),
};

// Escape sequences (fix2 c10 #11): CSI takes parameter bytes 0x30-0x3F (so ':' / '<' / '>'
// forms count too) plus intermediates and any final byte; OSC ends at BEL *or* ST (ESC \) —
// OSC 8 hyperlinks use ST, and the old BEL-only pattern also swallowed real text up to a
// later BEL; DCS / SOS / PM / APC end at ST; the last branch takes the remaining two-byte
// escapes (ESC 7, ESC M, charset selects, …). Unterminated OSC / DCS at end of string count
// as sequences too, so width() never measures their bytes as text.
const ANSI_SRC = '\\x1b\\[[0-?]*[ -/]*[@-~]' +
  '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\|$)' +
  '|\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\|$)' +
  '|\\x1b[ -/]*[0-~]';
const ANSI = new RegExp(ANSI_SRC, 'g');
const ANSI_AT = new RegExp(ANSI_SRC, 'y'); // sticky twin for tokens(): match at one spot only
function strip(s) { return String(s).replace(ANSI, ''); }

// Combining marks (Unicode categories Mn / Me / Mc) print on their base glyph and add no
// cells. The old hand list stopped at U+036F, so decomposed dakuten (U+3099/U+309A), Arabic
// vowel signs (U+064B…) and Devanagari virama (U+094D) each counted a cell (fix2 c10 #8).
// The mark blocks sit below U+2E80, with a few strays inside the CJK range named singly.
const MARK = /[\p{Mn}\p{Me}\p{Mc}]/u;
function cp(ch) {
  const code = ch.codePointAt(0);
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f || (code >= 0xfe00 && code <= 0xfe0e) ||
      code === 0x61c || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb)) return 0;
  if (code === 0x302e || code === 0x302f || code === 0x3099 || code === 0x309a ||
      ((code >= 0x300 && code < 0x2e80) || (code >= 0xa700 && code <= 0xab5f) || (code >= 0xfe20 && code <= 0xfe2f)) && MARK.test(ch)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x1f680 && code <= 0x1f6ff) ||
      (code >= 0x1f7e0 && code <= 0x1f7f0) || (code >= 0x1fa70 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}
// Width by grapheme cluster (Intl.Segmenter): a ZWJ sequence (👨‍👩‍👧), a base + skin-tone modifier,
// or a letter + combining marks is ONE printed glyph, so only the cluster's first code point
// counts — the old per-code-point sum counted the modifier / ZWJ parts again and over-measured.
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
function clusterWidth(cluster) {
  if (cluster.includes('⃣')) return 2; // keycap sequences print wide
  // VS16 (U+FE0F) asks for emoji presentation: a narrow base (❤ U+2764, ☀ U+2600,
  // © U+00A9) then prints two cells wide, not one (fix2 third M13).
  if (cluster.includes('\uFE0F')) return 2;
  // A flag is two regional indicators in one cluster and prints 2 cells;
  // cp() scores a lone regional indicator 1 (it is below the emoji ranges),
  // so width('🇯🇵') came out 1 for a 2-cell glyph (recovery scan).
  const cps = [...cluster];
  if (cps.length >= 2 && cps[0].codePointAt(0) >= 0x1f1e6 && cps[0].codePointAt(0) <= 0x1f1ff && cps[1].codePointAt(0) >= 0x1f1e6 && cps[1].codePointAt(0) <= 0x1f1ff) return 2;
  return cp(String.fromCodePoint(cluster.codePointAt(0)));
}
// Can any code point here join a grapheme cluster (combining marks, ZWJ, variation
// selectors, skin tones, regional indicators, keycap / tag sequences)? Per-code-point
// widths are exact when not, and width() is called per character by the wrapping code,
// so segmenting everything was slow.
function needsCluster(str) {
  for (const ch of str) { const code = ch.codePointAt(0); if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || code === 0x20e3 || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x1f1e6 && code <= 0x1f1ff) || (code >= 0x1f3fb && code <= 0x1f3ff) || (code >= 0xe0020 && code <= 0xe007f)) return true; }
  return false;
}
const TAB = 8; // terminals advance a tab to the next multiple-of-8 stop (fix2 c10 #10)
const tabWidth = col => TAB - (col % TAB);
function width(s) {
  const str = strip(s);
  // A tab's width depends on the column it lands on, so measure the runs between tabs
  // and advance each tab to the next stop.
  if (str.includes('\t')) {
    let w = 0; const parts = str.split('\t');
    for (let i = 0; i < parts.length; i++) { w += width(parts[i]); if (i < parts.length - 1) w += tabWidth(w); }
    return w;
  }
  if (!needsCluster(str) || !segmenter) { let w = 0; for (const ch of str) w += cp(ch); return w; }
  let w = 0; for (const {segment} of segmenter.segment(str)) w += clusterWidth(segment); return w;
}

// Walk a styled string cell by cell, keeping escape codes attached. One token per
// grapheme cluster, measured with clusterWidth(), so wrap / truncate agree with width()
// (fix2 c10 #7: per-code-point tokens counted a family emoji as 6 cells and cut it in
// half). The scan is a single pass — escapes are tried with the sticky pattern only at an
// ESC byte; the old code re-ran the global pattern from every character, rescanning the
// whole tail each time and making plain text quadratic (fix2 third M14). Tabs are their
// own tokens: their width depends on the column, so wrap / truncate price them with
// tabWidth() at the position they land (fix2 c10 #10).
function tokens(s) {
  const out = []; const str = String(s);
  const pushRun = run => {
    if (!run) return;
    if (segmenter && needsCluster(run)) {
      for (const {segment} of segmenter.segment(run)) out.push(segment === '\t' ? {ch: segment, w: 0, tab: true} : {ch: segment, w: clusterWidth(segment)});
    } else {
      for (const ch of run) out.push(ch === '\t' ? {ch, w: 0, tab: true} : {ch, w: cp(ch)});
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
function truncate(s, max) {
  if (width(s) <= max) return s;
  let w = 0, out = '';
  for (const t of tokens(s)) { if (t.esc) { out += t.esc; continue; } const tw = tokenWidth(t, w); if (w + tw > max - 1) break; out += t.ch; w += tw; }
  return out + (on ? ESC + '0m' : '') + '…';
}
// Wrap to `max` cells; continuation lines get `indent`. Breaks at spaces when it can.
function wrap(s, max, indent = '') {
  if (max < 8) max = 8;
  const lines = []; let line = '', w = 0, lastSpace = -1, open = '';
  for (const t of tokens(s)) {
    if (t.esc) { line += t.esc; open = t.esc === ESC + '0m' ? '' : open + t.esc; continue; }
    let tw = tokenWidth(t, w);
    if (w + tw > max) {
      let head = line, rest = '';
      if (lastSpace > 0 && lastSpace > line.length / 2) { head = line.slice(0, lastSpace); rest = line.slice(lastSpace + 1); }
      lines.push(head + (on && open ? ESC + '0m' : ''));
      line = indent + open + rest; w = width(line); lastSpace = -1; tw = tokenWidth(t, w);
    }
    if (t.ch === ' ') lastSpace = line.length;
    line += t.ch; w += tw;
  }
  lines.push(line);
  return lines;
}
function pad(s, n) { return s + ' '.repeat(Math.max(0, n - width(s))); }
function cols() { return Math.max(40, (process.stdout.columns || 100)); }

// Command output as a terminal leaves it: a carriage return starts the line again (progress
// meters: curl, pip, cargo). Shown raw, the frames ran together ("  0%  12%  57% 100%") and a line
// still being redrawn never showed at all.
// A carriage return restarts the line, but on a real terminal it only overwrites: text
// past the end of the new frame stays visible ('abcdef\rXY' shows 'XYcdef'). Keeping
// only the text after the last \r dropped that tail (fix2 c10 #12), so replay the line
// cell by cell instead. Full-length redraws (curl & co.) come out exactly as before.
function frames(text) {
  return String(text).replace(/\r+\n/g, '\n').split('\n').map(l => {
    if (!l.includes('\r')) return l;
    const cells = []; let pos = 0;
    for (const ch of l) { if (ch === '\r') { pos = 0; continue; } cells[pos] = ch; pos++; }
    return cells.join('');
  }).join('\n');
}

module.exports = {frames, c, strip, width, truncate, wrap, pad, cols, ESC, rgb, rgbTo256, truecolor};
