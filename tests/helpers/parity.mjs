// Parity harness for the fullscreen redraw (stage 2, stage A).
// Compares what Ink's renderToString produces for a React piece with what the
// new draw function produces, at widths 40 / 80 / 120:
//  - the plain text (ANSI removed) must match line by line, and
//  - the colour/decoration of every cell must match (fg, bg, bold, dim, italic,
//    underline, strike, inverse).
// Raw bytes are NOT compared: Ink closes fg with 39m / bold with 22m where
// term.js closes with 0m, and both look the same on screen.
//
// A difference that cannot be matched is registered as an exception with a
// reason: {width?, line?, kind?, reason}. The harness FAILS if an exception
// matches nothing (so exceptions cannot rot) and fails on any unmatched
// difference. Every exception must also be listed in the DevNote.
//
// Env note: the test file must set FORCE_COLOR=3, COLORTERM=truecolor and
// MUSER_SGR=1 BEFORE importing this module (or view.mjs / term.js), so both
// sides colourise the same way. See tests/fs-parity.test.js.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require = createRequire(import.meta.url);
// require.resolve returns a Windows path (C:\…); import() needs a file:// URL.
const ink = await import(pathToFileURL(require.resolve('ink')).href);
const {renderToString} = ink;
const {cellsOf, plainOf, cellsEqual} = await import('../../src/ui/fs/draw/primitives.mjs');

export const WIDTHS = [40, 80, 120];

// Ink's renderToString of one element, as lines. '' means no lines at all
// (an empty box, a null element); otherwise the string is split on '\n'.
export function reactLines(el, W) {
  const out = renderToString(el, {columns: W + 1});
  return out === '' ? [] : out.split('\n');
}

function styleDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x || !y) return {col: i, expected: y || null, actual: x || null};
    for (const k of ['ch', 'fg', 'bg', 'bold', 'dim', 'italic', 'under', 'strike', 'inverse']) {
      if (x[k] !== y[k]) return {col: i, field: k, expected: y[k], actual: x[k]};
    }
  }
  return null;
}

function collectDiffs(actual, expected) {
  const diffs = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i], e = expected[i];
    if (a === undefined) { diffs.push({line: i, kind: 'length', expected: plainOf(cellsOf(e)), actual: undefined}); continue; }
    if (e === undefined) { diffs.push({line: i, kind: 'length', expected: undefined, actual: plainOf(cellsOf(a))}); continue; }
    const ac = cellsOf(a), ec = cellsOf(e);
    if (plainOf(ac) !== plainOf(ec)) { diffs.push({line: i, kind: 'text', expected: plainOf(ec), actual: plainOf(ac)}); continue; }
    const sd = styleDiff(ac, ec);
    if (sd) diffs.push({line: i, kind: 'style', text: plainOf(ec), ...sd});
  }
  return diffs;
}

const short = s => s === undefined ? '(none)' : JSON.stringify(String(s).length > 120 ? String(s).slice(0, 117) + '…' : s);
function describe(d) {
  if (d.kind === 'style') return 'line ' + d.line + ' [style] text ' + short(d.text) + ' (first differing cell ' + d.col + (d.field ? ', ' + d.field : '') + ': expected ' + JSON.stringify(d.expected) + ' actual ' + JSON.stringify(d.actual) + ')';
  const base = 'line ' + d.line + ' [' + d.kind + '] expected ' + short(d.expected) + ' / actual ' + short(d.actual);
  return base;
}

// react(W) and draw(W) each return string[] for width W. `name` labels the case.
// Throws on unmatched differences or on stale exceptions; returns the list of
// exceptions that matched (with their reasons), for the test to report.
export function checkParity({name, react, draw, widths = WIDTHS, exceptions = []}) {
  const allDiffs = [];
  const used = new Set();
  for (const W of widths) {
    const expected = react(W);
    const actual = draw(W);
    for (const d of collectDiffs(actual, expected)) {
      const idx = exceptions.findIndex(x => (x.width === undefined || x.width === W) && (x.line === undefined || x.line === d.line) && (x.kind === undefined || x.kind === d.kind));
      if (idx >= 0) { used.add(idx); continue; }
      allDiffs.push({width: W, ...d});
    }
  }
  const stale = exceptions.filter((_, i) => !used.has(i));
  const problems = [];
  if (allDiffs.length) problems.push(allDiffs.map(d => 'width ' + d.width + ': ' + describe(d)).join('\n'));
  if (stale.length) problems.push('stale exceptions (matched nothing): ' + stale.map(s => JSON.stringify(s)).join(', '));
  if (problems.length) throw new Error('parity mismatch in ' + name + '\n' + problems.join('\n'));
  return exceptions.filter((_, i) => used.has(i));
}

// A base ctx for draw functions in tests: no controller state, fixed clock.
// cols is the renderToString columns (W + 1): entries whose React root has no
// explicit width lay out at cols, the ones with width: W at W.
export const baseCtx = (W, extra = {}) => ({ctrl: {}, W, cols: W + 1, rows: 30, now: 0, codeWrap: false, ...extra});
