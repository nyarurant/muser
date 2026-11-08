'use strict';
// Wave 13: the sanitize passes must stay fast AND correct on long strings.
// The unbounded SECRET_VALUE / SECRET_JSON rules (worklog, and their
// focus-log mirror) and export's quoted-key rules backtracked
// quadratically on a long separator-free string: ~200 KB of plain letters
// or of keyword fragments inside one quoted string took seconds before
// the fix. These tests pin a generous wall-clock bound (< 2 s for inputs
// that took ~5 s+ before) together with the redaction itself: a real
// secret buried in the middle of a long string is still redacted, and
// ordinary prose is left byte-identical.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Self-isolation (the w13-permissions pattern): throwaway home/data
// BEFORE any src module loads, so a bare run never touches the real ones.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w13-san-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(ROOT, 'home-'));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(ROOT, 'data-'));
test.after(() => { try { fs.rmSync(ROOT, {recursive: true, force: true}); } catch {} });

const worklog = require('../src/worklog');
const focusLog = require('../src/focus-log');
const exporter = require('../src/export');

const BOUND_MS = 2000;
const PLAIN = 'a'.repeat(200 * 1024); // 200 KB, no separator, no keyword
const QUOTED_FRAGMENTS = '"' + 'token'.repeat(40 * 1024) + '" x'; // 200 KB quoted, full of keyword fragments
const PROSE = 'token counts are fine and the password is wrong';

function timed(fn, input) {
  const t0 = Date.now();
  const out = fn(input);
  return {out, ms: Date.now() - t0};
}
function assertFast(ms, what, len) {
  assert.ok(ms < BOUND_MS, what + ' took ' + ms + ' ms on ' + len + ' chars (bound ' + BOUND_MS + ' ms; quadratic before the wave-13 fix)');
}
// A secret form buried between two 100 KB walls of plain letters.
function buried(form) { return 'x'.repeat(100 * 1024) + ' ' + form + ' ' + 'y'.repeat(100 * 1024); }

// ---------- worklog sanitizeText ----------

test('w13 sanitize: worklog sanitizeText is fast on 200 KB separator-free strings', () => {
  for (const [name, input] of [['plain letters', PLAIN], ['quoted keyword fragments', QUOTED_FRAGMENTS]]) {
    const {out, ms} = timed(worklog.sanitizeText, input);
    assertFast(ms, 'worklog sanitizeText (' + name + ')', input.length);
    assert.equal(out, input, name + ': nothing to redact, the string passes through unchanged');
  }
});

test('w13 sanitize: worklog sanitizeText still redacts secrets buried in a long string', () => {
  const cases = [
    ['password: form', 'password: W13HUNTERVALUE99', 'W13HUNTERVALUE99'],
    ['JSON form', '{"password": "W13JSONSECRET99"}', 'W13JSONSECRET99'],
    ['Bearer form', 'Authorization: Bearer W13BEARERTOKEN99', 'W13BEARERTOKEN99'],
  ];
  for (const [name, form, canary] of cases) {
    const input = buried(form);
    const {out, ms} = timed(worklog.sanitizeText, input);
    assertFast(ms, 'worklog sanitizeText (' + name + ')', input.length);
    assert.ok(!out.includes(canary), name + ': the value is redacted even mid-string');
    assert.ok(out.includes('[redacted]'), name + ': the redaction marker is there');
    assert.ok(out.startsWith('x'.repeat(1000)) && out.endsWith('y'.repeat(1000)), name + ': the surrounding plain text survives');
  }
  // Short-string correctness the long-string bounds must not cost.
  assert.ok(!worklog.sanitizeText('password: hunter2secret').includes('hunter2secret'));
  assert.equal(worklog.sanitizeText(PROSE), PROSE, 'normal prose is untouched');
});

// ---------- focus-log sanitizeText (the mirror) ----------

test('w13 sanitize: focus-log sanitizeText is fast on 200 KB separator-free strings', () => {
  assert.equal(typeof focusLog.sanitizeText, 'function', 'focus-log exports sanitizeText');
  for (const [name, input] of [['plain letters', PLAIN], ['quoted keyword fragments', QUOTED_FRAGMENTS]]) {
    const {out, ms} = timed(focusLog.sanitizeText, input);
    assertFast(ms, 'focus-log sanitizeText (' + name + ')', input.length);
    assert.equal(out, input, name + ': nothing to redact, the string passes through unchanged');
  }
});

test('w13 sanitize: focus-log sanitizeText still redacts secrets buried in a long string', () => {
  const cases = [
    ['password: form', 'password: W13HUNTERVALUE99', 'W13HUNTERVALUE99'],
    ['JSON form', '{"password": "W13JSONSECRET99"}', 'W13JSONSECRET99'],
    ['Bearer form', 'Authorization: Bearer W13BEARERTOKEN99', 'W13BEARERTOKEN99'],
  ];
  for (const [name, form, canary] of cases) {
    const input = buried(form);
    const {out, ms} = timed(focusLog.sanitizeText, input);
    assertFast(ms, 'focus-log sanitizeText (' + name + ')', input.length);
    assert.ok(!out.includes(canary), name + ': the value is redacted even mid-string');
    assert.ok(out.includes('[redacted]'), name + ': the redaction marker is there');
  }
  assert.equal(focusLog.sanitizeText(PROSE), PROSE, 'normal prose is untouched');
});

// ---------- export redactString ----------

const EXPORT_OPTS = {username: 'zz-no-match-w13', homeDir: 'C:\\zz-no-match-w13'};
const redact = s => exporter.redactString(s, EXPORT_OPTS);

test('w13 sanitize: export redactString is fast on 200 KB separator-free strings', () => {
  assert.equal(typeof exporter.redactString, 'function', 'export exports redactString');
  for (const [name, input] of [['plain letters', PLAIN], ['quoted keyword fragments', QUOTED_FRAGMENTS]]) {
    const {out, ms} = timed(redact, input);
    assertFast(ms, 'export redactString (' + name + ')', input.length);
    assert.equal(out, input, name + ': nothing to redact, the string passes through unchanged');
  }
});

test('w13 sanitize: export redactString still redacts secrets buried in a long string', () => {
  const cases = [
    ['password: form', 'password: W13HUNTERVALUE99', 'W13HUNTERVALUE99'],
    ['JSON form', '{"password": "W13JSONSECRET99"}', 'W13JSONSECRET99'],
    ['Bearer form', 'Authorization: Bearer W13BEARERTOKEN99', 'W13BEARERTOKEN99'],
  ];
  for (const [name, form, canary] of cases) {
    const input = buried(form);
    const {out, ms} = timed(redact, input);
    assertFast(ms, 'export redactString (' + name + ')', input.length);
    assert.ok(!out.includes(canary), name + ': the value is redacted even mid-string');
    assert.ok(out.includes('<redacted>'), name + ': the redaction marker is there');
  }
  assert.equal(redact(PROSE), PROSE, 'normal prose is untouched');
});
