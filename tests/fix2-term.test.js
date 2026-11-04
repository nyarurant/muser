'use strict';
// Fix phase 2, agent A4: src/tui/term.js, src/tui/logo.js, src/tui/onboard.js.
// Sources: deep audit #73-#81 (= work2/c10 #7-#16, Low items normalised to Medium),
// third audit M13 (VS16 width) and M14 (tokens() quadratic), c26 #10 (logo colour
// condition, None in its source report but assigned to this file group), and the
// onboard part of fifth audit c2-1 (askLanguage hangs without a terminal).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const {width, truncate, wrap, strip, frames} = require('../src/tui/term.js');
const ESC = '\x1b';

// ---- c10 #7 / deep #73: tokens() must measure grapheme clusters like width() ----
test('fix2 c10#7: truncate never splits a grapheme cluster and prices it as width() does', () => {
  assert.equal(width('👨‍👩‍👧'), 2);
  assert.equal(truncate('👨‍👩‍👧ab', 3), '👨‍👩‍👧…', 'the whole family fits in 2 cells + ellipsis, not a lone 👨');
  assert.equal(truncate('👍🏽ab', 3), '👍🏽…', 'a skin-tone cluster is one 2-cell glyph');
  assert.equal(truncate('e\u0301abcd', 3), 'e\u0301a…', 'a base + combining mark stays together');
});

test('fix2 c10#7: wrap breaks between clusters, never inside one', () => {
  const lines = wrap('👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧ab', 8);
  for (const l of lines) assert.ok(width(l) <= 8, 'line within 8 cells: ' + JSON.stringify(l));
  assert.equal(lines.join(''), '👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧ab', 'no cluster was split or lost');
  assert.ok(lines.length >= 2, 'four 2-cell glyphs + ab cannot fit on one 8-cell line');
});

// ---- c10 #8 / deep #74: combining marks beyond U+0300-036F are zero width ----
test('fix2 c10#8: decomposed dakuten and Indic / Arabic combining marks add no width', () => {
  assert.equal(width('か\u3099'), 2, 'か + U+3099 (decomposed dakuten) is one 2-cell glyph');
  assert.equal(width('は\u309A'), 2, 'は + U+309A (decomposed handakuten)');
  assert.equal(width('ب\u064B'), 1, 'Arabic letter + fathatan U+064B');
  assert.equal(width('क\u094D'), 1, 'Devanagari consonant + virama U+094D');
  assert.equal(width('क\u093E'), 1, 'spacing mark (Mc) also rides on its base');
  assert.equal(truncate('か\u3099か\u3099か\u3099', 5), 'か\u3099か\u3099…', 'truncate agrees with width()');
});

// ---- c10 #9 / deep #75: post-Emoji-13 pictographs are two cells ----
test('fix2 c10#9: newer emoji (U+1FA70-1FAFF) measure two cells', () => {
  for (const e of ['🫠', '🩷', '🫶', '🪴', '🫀']) assert.equal(width(e), 2, e);
  assert.equal(width('🟠'), 2, 'coloured circle U+1F7E0');
  assert.ok(width(truncate('🫠'.repeat(10), 10)) <= 10, 'truncate cannot overflow the budget with new emoji');
});

// ---- third M13: VS16 turns a narrow symbol into a 2-cell emoji ----
test('fix2 third M13: VS16 sequences measure two cells', () => {
  assert.equal(width('❤️'), 2, 'heart + VS16');
  assert.equal(width('☀️'), 2, 'sun + VS16');
  assert.equal(width('©️'), 2, 'copyright + VS16');
  assert.equal(width('❤'), 1, 'the bare heart stays one cell');
  const t = truncate('❤️'.repeat(6), 10);
  assert.ok(width(t) <= 10, 'six VS16 hearts truncated to a 10-cell budget, got width ' + width(t));
  assert.equal(t, '❤️❤️❤️❤️…');
});

// ---- c10 #10 / deep #76: tabs advance to the next multiple-of-8 stop ----
test('fix2 c10#10: tabs have terminal width in width / truncate / wrap', () => {
  assert.equal(width('\t'), 8);
  assert.equal(width('a\tb'), 9, 'a(1) + tab to column 8 + b(1)');
  assert.equal(width('1234567\tx'), 9, 'a tab at column 7 advances one cell');
  assert.equal(width('12345678\tx'), 17, 'a tab at a stop advances a full 8');
  assert.equal(truncate('a\tbcdefgh', 4), 'a…', 'the tab alone blows the 4-cell budget');
  const lines = wrap('ab\tcdefghij', 8);
  assert.ok(lines.length >= 2, 'a line whose tab expands past 8 cells wraps');
  for (const l of lines) assert.ok(width(l) <= 8, 'wrapped line within budget: ' + JSON.stringify(l));
});

// ---- c10 #11 / deep #77: strip() knows ST-terminated and modern CSI forms ----
test('fix2 c10#11: strip removes OSC-ST, colon CSI, DCS/APC and keeps the text between', () => {
  const link = ESC + ']8;;https://example.com' + ESC + '\\' + 'link' + ESC + ']8;;' + ESC + '\\';
  assert.equal(strip(link), 'link', 'OSC 8 hyperlinks end at ST (ESC \\), not only BEL');
  assert.equal(width(link), 4);
  assert.equal(strip(ESC + '[38:2:1:2:3m' + 'ab' + ESC + '[m'), 'ab', "CSI with ':' parameters and a bare ESC[m");
  assert.equal(strip(ESC + '[>4;1m' + 'ab'), 'ab', "CSI with '>' parameter byte");
  assert.equal(strip(ESC + 'Pz$abc' + ESC + '\\' + 'ab'), 'ab', 'DCS ends at ST');
  assert.equal(strip(ESC + '_Gabc' + ESC + '\\' + 'ab'), 'ab', 'APC ends at ST');
  assert.equal(strip('a' + ESC + ']0;title' + '\u0007' + 'b'), 'ab', 'BEL-terminated OSC still works');
  assert.equal(strip(ESC + '[200~paste' + ESC + '[201~'), 'paste', 'bracketed-paste markers (final byte ~)');
  assert.equal(width(ESC + ']8;;https://example.com' + ESC + '\\' + 'x'), 1, 'an ST sequence no longer eats the text after it');
});

// ---- c10 #12 / deep #78: frames() replays a carriage return like a terminal ----
test('fix2 c10#12: frames keeps the tail a short overwrite does not erase', () => {
  assert.equal(frames('abcdef\rXY'), 'XYcdef');
  assert.equal(frames('abc\rXYZZ'), 'XYZZ', 'a longer overwrite replaces everything');
  assert.equal(frames('abc\rX\rYZ'), 'YZc', 'each CR restarts the overwrite');
  assert.equal(frames('  0%\r 40%'), ' 40%', 'same-length progress frames are unchanged');
  assert.equal(frames('a\r\nb\r'), 'a\nb', 'a CR before a line end changes nothing');
  assert.equal(frames('one\ntwo\rT'), 'one\nTwo', 'per line');
});

// ---- third M14: tokens() must not rescan the tail per character ----
test('fix2 third M14: truncate / wrap on long plain text are not quadratic', () => {
  const big = 'a'.repeat(300000);
  const t0 = Date.now();
  assert.equal(truncate(big, 80), 'a'.repeat(79) + '…');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, 'truncate of 300k plain chars took ' + ms + 'ms (was ~7s extrapolated)');
  const t1 = Date.now();
  const lines = wrap('word '.repeat(20000), 80);
  assert.ok(Date.now() - t1 < 3000, 'wrap of 100k plain chars stays fast');
  assert.ok(lines.every(l => width(l) <= 80));
});

// ---- c26 #10: logo colour follows MUSER_SGR like term.js ----
test('fix2 c26#10: the wordmark gradient is coloured under MUSER_SGR=1 without a TTY', () => {
  const env = {...process.env, MUSER_SGR: '1'}; delete env.NO_COLOR;
  const out = execFileSync(process.execPath, ['-e',
    "const {gradient, logo} = require('./src/tui/logo'); console.log(JSON.stringify(gradient('ab'))); console.log(JSON.stringify(logo()[0]));"],
    {cwd: ROOT, env, encoding: 'utf8', timeout: 60000});
  const [g, l] = out.trim().split('\n').map(s => JSON.parse(s));
  assert.ok(g.includes(ESC + '[38;'), 'gradient carries SGR colour under serve: ' + JSON.stringify(g));
  assert.ok(l.includes(ESC + '[38;'), 'the wordmark itself is coloured under serve');
});

test('fix2 c26#10: without a TTY and without MUSER_SGR the gradient stays plain', () => {
  const env = {...process.env}; delete env.MUSER_SGR; delete env.NO_COLOR;
  const out = execFileSync(process.execPath, ['-e',
    "const {gradient} = require('./src/tui/logo'); console.log(JSON.stringify(gradient('ab')));"],
    {cwd: ROOT, env, encoding: 'utf8', timeout: 60000});
  assert.equal(JSON.parse(out.trim()), 'ab');
});

// ---- c10 #14 / deep #79: header steps honour a registration already in place ----
test('fix2 c10#14: stepsFor marks registration done when it is already in place', () => {
  const {stepsFor} = require('../src/tui/onboard.js');
  const dev = steps => steps.find(s => s.key === 'device').state;
  assert.equal(dev(stepsFor(true, false)), 'done', 'login pending but device registered: done, not later');
  assert.equal(dev(stepsFor(true, true)), 'later', 'registration waits behind the login');
  assert.equal(dev(stepsFor(false, true)), 'now');
  assert.equal(dev(stepsFor(false, false)), 'done');
  assert.equal(stepsFor(true, true).find(s => s.key === 'login').state, 'now');
  assert.equal(stepsFor(false, true).find(s => s.key === 'login').state, 'done');
});

// ---- c10 #15 / deep #80: pick() with no items fails clearly instead of opening an empty select ----
test('fix2 c10#15: clackUi pick with zero items throws a clear error', async () => {
  const {clackUi} = require('../src/tui/onboard.js');
  await assert.rejects(() => clackUi().pick('どれですか', []), /選択肢がありません/);
  await assert.rejects(() => clackUi().pick('どれですか', undefined), /選択肢がありません/);
});

// ---- c10 #16 / deep #81: non-Error throws display their text, not 'undefined' ----
test('fix2 c10#16: errText renders non-Error throws', () => {
  const {errText} = require('../src/tui/onboard.js');
  assert.equal(errText(new Error('bad')), 'bad');
  assert.equal(errText('boom'), 'boom');
  assert.notEqual(errText('boom'), 'undefined');
});

test('fix2 c10#16: busy stops the spinner with the thrown text and rethrows it (child)', () => {
  const script = "process.env.MUSER_LANG='ja'; const {clackUi} = require('./src/tui/onboard');" +
    "clackUi().busy('確認しています', async () => { throw 'boom-string'; }).then(() => console.log('NO-THROW'), e => console.log('RETHREW:' + e));";
  const r = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: {...process.env, MUSER_LANG: 'ja'}});
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('RETHREW:boom-string'), 'the original throw propagates: ' + out);
  assert.ok(out.includes('boom-string'), 'the spinner stop line shows the thrown text');
  assert.ok(!/RETHREW:undefined/.test(out));
});

// ---- fifth c2-1 (onboard part): askLanguage must not hang without a terminal ----
test('fix2 fifth c2-1: askLanguage falls back to the OS language when there is no TTY', async () => {
  const saved = process.env.MUSER_LANG;
  delete process.env.MUSER_LANG;
  const i18n = require('../src/i18n.js');
  try {
    const raced = await Promise.race([
      (async () => { await require('../src/tui/onboard.js').askLanguage(); return 'returned'; })(),
      new Promise(res => setTimeout(() => res('hung'), 5000)),
    ]);
    assert.equal(raced, 'returned', 'askLanguage returned instead of waiting on a select no one can answer');
    assert.equal(i18n.lang(), i18n.osLang(), 'the OS language is in effect for this run');
  } finally {
    if (saved === undefined) delete process.env.MUSER_LANG; else process.env.MUSER_LANG = saved;
    i18n.setLang('ja', {save: false});
  }
});
