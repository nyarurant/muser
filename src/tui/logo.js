'use strict';
// The muser wordmark: a two-row block font with a violet -> pink gradient across it.
// Same condition as term.js (fix2 c26 #10): under `muser serve` there is no TTY but
// MUSER_SGR=1 turns SGR on for the GUI, and the wordmark used to stay colourless there.
const on = (process.stdout.isTTY || process.env.MUSER_SGR === '1') && require('../settings').switchValue('color');
const GLYPHS = {
  m: ['█▀▄▀█', '█ ▀ █'], u: ['█ █', '█▄█'], s: ['█▀▀', '▄▄█'], e: ['█▀▀', '██▄'], r: ['█▀█', '█▀▄'],
};
const FROM = [168, 148, 255], TO = [255, 138, 196];
// Unknown characters render as a blank glyph of the usual glyph width instead of throwing.
const BLANK = ['   ', '   '];

function gradient(text, from = FROM, to = TO) {
  if (!on) return text;
  // Quantise like the rest of the UI (recovery scan): raw 38;2 sequences on a
  // non-truecolor terminal rendered the wordmark in fallback colours while
  // everything else used the 256 palette.
  const {truecolor, rgbTo256} = require('./term');
  const chars = [...text], n = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => {
    if (ch === ' ') return ch;
    const t = i / n, [r, g, b] = from.map((v, k) => Math.round(v + (to[k] - v) * t));
    return (truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`) + ch;
  }).join('') + '\x1b[0m';
}

function logo(word = 'muser') {
  return [0, 1].map(row => gradient([...word].map(ch => (GLYPHS[ch] || BLANK)[row]).join(' ')));
}

module.exports = {logo, gradient};
