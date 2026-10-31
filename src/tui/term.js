'use strict';
// Terminal basics: colors, display width (CJK / emoji are two cells), wrapping, truncation.
const ESC = '\x1b[';
const on = process.stdout.isTTY && !process.env.NO_COLOR;
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
const bg = (r, g, b) => sgr(48, 2, r, g, b);

// One accent (Muse violet) on a monochrome base, like Claude Code / Codex.
const c = {
  accent: rgb(180, 160, 255), dim: sgr(2), bold: sgr(1), italic: sgr(3), under: sgr(4), strike: sgr(9),
  gray: rgb(140, 140, 150), faint: rgb(95, 95, 105), text: s => s,
  red: rgb(240, 110, 110), green: rgb(120, 205, 130), yellow: rgb(230, 190, 100), blue: rgb(120, 170, 240),
  code: rgb(215, 175, 255),
  addBg: s => bg(25, 60, 35)(rgb(170, 235, 170)(s)), delBg: s => bg(70, 28, 32)(rgb(245, 170, 170)(s)),
  userBg: s => bg(45, 45, 52)(s),
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
function strip(s) { return String(s).replace(ANSI, ''); }

function cp(ch) {
  const code = ch.codePointAt(0);
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f || (code >= 0xfe00 && code <= 0xfe0e)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x1f680 && code <= 0x1f6ff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}
function width(s) { let w = 0; for (const ch of strip(s)) w += cp(ch); return w; }

// Walk a styled string cell by cell, keeping escape codes attached.
function tokens(s) {
  const out = []; let i = 0; const str = String(s);
  while (i < str.length) {
    ANSI.lastIndex = i; const m = ANSI.exec(str);
    if (m && m.index === i) { out.push({esc: m[0]}); i += m[0].length; continue; }
    const ch = String.fromCodePoint(str.codePointAt(i)); out.push({ch, w: cp(ch)}); i += ch.length;
  }
  return out;
}
function truncate(s, max) {
  if (width(s) <= max) return s;
  let w = 0, out = '';
  for (const t of tokens(s)) { if (t.esc) { out += t.esc; continue; } if (w + t.w > max - 1) break; out += t.ch; w += t.w; }
  return out + (on ? ESC + '0m' : '') + '…';
}
// Wrap to `max` cells; continuation lines get `indent`. Breaks at spaces when it can.
function wrap(s, max, indent = '') {
  if (max < 8) max = 8;
  const lines = []; let line = '', w = 0, lastSpace = -1, open = '';
  for (const t of tokens(s)) {
    if (t.esc) { line += t.esc; open = t.esc === ESC + '0m' ? '' : open + t.esc; continue; }
    if (w + t.w > max) {
      let head = line, rest = '';
      if (lastSpace > 0 && lastSpace > line.length / 2) { head = line.slice(0, lastSpace); rest = line.slice(lastSpace + 1); }
      lines.push(head + (on && open ? ESC + '0m' : ''));
      line = indent + open + rest; w = width(line); lastSpace = -1;
    }
    if (t.ch === ' ') lastSpace = line.length;
    line += t.ch; w += t.w;
  }
  lines.push(line);
  return lines;
}
function pad(s, n) { return s + ' '.repeat(Math.max(0, n - width(s))); }
function cols() { return Math.max(40, (process.stdout.columns || 100)); }

module.exports = {c, strip, width, truncate, wrap, pad, cols, ESC, rgb, rgbTo256, truecolor};
