'use strict';
// Parity tests for the fullscreen redraw (stage 2, stage B3): the tool
// entry (Tool / Diff), the past entry and the shellout entry.
// The React side (view.mjs Entry) is the truth; the draw side is
// src/ui/fs/draw/entries/{tool,past,shellout}.mjs and src/ui/fs/draw/diff.mjs
// (Diff is not exported from view.mjs, so it is compared through the tool
// entry's v.diff / v.files branches, plus direct null-safety checks).
//
// Env comes FIRST: both sides must colourise the same way. setup.mjs does not
// set these, so this file does, before any import of ink / view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawTool, drawPast, drawShellout, drawDiff, P;
const CWD = 'C:\\Users\\nyaru\\muser-b3';
const ctrl = {agent: {cwd: CWD}};
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawTool} = await import('../src/ui/fs/draw/entries/tool.mjs'));
  ({drawPast} = await import('../src/ui/fs/draw/entries/past.mjs'));
  ({drawShellout} = await import('../src/ui/fs/draw/entries/shellout.mjs'));
  ({drawDiff} = await import('../src/ui/fs/draw/diff.mjs'));
  P = await import('../src/ui/fs/draw/primitives.mjs');
});

function parityCase(name, e, exceptions = []) {
  test(name, () => {
    const used = parity.checkParity({
      name,
      react: W => parity.reactLines(h(Entry, {e, ctrl, W}), W),
      draw: W => drawEntry(e, parity.baseCtx(W, {ctrl})),
      exceptions,
    });
    assert.equal(used.length, exceptions.length);
  });
}

// --- tool: header + simple result rows --------------------------------------
parityCase('tool: code.read ok', {type: 'tool', call: {command: 'code.read', ok: true, summary: 'src/ui/view.mjs', view: {lines: 951}}});
parityCase('tool: code.read long path summary is tail-cut', {type: 'tool', call: {command: 'code.read', ok: true, summary: 'C:\\Users\\nyaru\\muser-b3\\src\\ui\\fs\\draw\\entries\\tool.mjs', view: {lines: 112}}});
parityCase('tool: code.grep hits', {type: 'tool', call: {command: 'code.grep', ok: true, summary: 'drawDiff', view: {count: 7}}});
parityCase('tool: code.glob files', {type: 'tool', call: {command: 'code.glob', ok: true, summary: 'src/**/*.mjs', view: {count: 23}}});
parityCase('tool: skill.read header only', {type: 'tool', call: {command: 'skill.read', ok: true, summary: 'browser', view: {}}});
parityCase('tool: unknown command header only', {type: 'tool', call: {command: 'focus.plan', ok: true, summary: '計画を記録', view: {}}});
parityCase('tool: long command name truncates the header', {type: 'tool', call: {command: 'some.very.long.command.name.that.exceeds', ok: true, summary: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', view: {}}});
parityCase('tool: shell.output running', {type: 'tool', call: {command: 'shell.output', ok: true, summary: 'bg1', view: {background: 'bg1', lines: 128, running: true}}});
parityCase('tool: shell.output finished', {type: 'tool', call: {command: 'shell.output', ok: true, summary: 'bg1', view: {background: 'bg1', lines: 42, running: false}}});
parityCase('tool: shell.kill', {type: 'tool', call: {command: 'shell.kill', ok: true, summary: 'bg2', view: {background: 'bg2'}}});
parityCase('tool: shell.list', {type: 'tool', call: {command: 'shell.list', ok: true, summary: '', view: {count: 3}}});
parityCase('tool: agent spawn', {type: 'tool', call: {kind: 'agent', command: 'agent.spawn', ok: true, summary: '調べもの', view: {tag: 'a1', type: 'explore'}}});
parityCase('tool: agent wait', {type: 'tool', call: {kind: 'agent', command: 'agent.wait', ok: true, summary: '', view: {agents: ['a1 完了', 'a2 実行中']}}});
parityCase('tool: user cmd command', {type: 'tool', call: {user: true, command: 'system.run', params: {shell: 'cmd'}, ok: true, summary: 'dir /b', outputLines: 2, view: {tail: ['a.txt', 'b.txt']}}});

// --- tool: system.run output -------------------------------------------------
parityCase('tool: system.run ok with long tail line and more lines', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'npm test', outputLines: 25, view: {tail: ['line one', 'a very long line of output that will exceed the width at forty columns easily yes indeed', 'last line'], exit: 0}}});
parityCase('tool: system.run no output', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'true', view: {tail: ['', '   ']}}});
parityCase('tool: system.run exit 2', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'node bad.js', outputLines: 1, view: {tail: ['boom output'], exit: 2}}});
parityCase('tool: system.run timeout', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'slow build', outputLines: 1, view: {tail: ['partial output'], exit: 1, killed: 'timeout'}}});
parityCase('tool: system.run cancelled', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'long task', outputLines: 1, view: {tail: ['partial output'], exit: 1, killed: 'cancelled'}}});
parityCase('tool: system.run background with tail', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'node server.js', view: {background: 'bg3', tail: ['first log', '', '   ', 'second log line that is quite long and wraps or cuts at narrow widths']}}});
parityCase('tool: system.run background, head wraps and tail is short', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'node server.js', view: {background: 'bg7', tail: ['only line']}}});
parityCase('tool: system.run single tail line near the column width', {type: 'tool', call: {command: 'system.run', ok: true, summary: 'x', outputLines: 1, view: {tail: ['a'.repeat(38)], exit: 0}}});

// --- tool: failures and declines ---------------------------------------------
parityCase('tool: failed edit with long error', {type: 'tool', call: {command: 'code.edit', ok: false, summary: 'src/x.js', error: 'ENOENT: no such file or directory, open src/x.js - a longer error that wraps at narrow widths for sure'}});
parityCase('tool: declined with reason', {type: 'tool', call: {command: 'system.run', ok: false, declined: true, summary: 'rm -rf build', error: 'declined this: 今日はやめておいて. Do not retry it, and do not ask again.'}});
parityCase('tool: declined, reason passed to Muse only', {type: 'tool', call: {command: 'system.run', ok: false, declined: true, summary: 'npm publish', error: 'declined this:'}});
parityCase('tool: declined without reason text', {type: 'tool', call: {command: 'system.run', ok: false, declined: true, summary: 'npm publish', error: 'user said no'}});
parityCase('tool: todo.write not ok falls back to the error row', {type: 'tool', call: {command: 'todo.write', ok: false, summary: '3 件', error: 'bad todos'}});

// --- tool: todo.write ----------------------------------------------------------
parityCase('tool: todo.write ok, mixed states, one long item', {type: 'tool', call: {command: 'todo.write', ok: true, summary: '3 件', view: {todos: [
  {content: '短い作業', status: 'completed'},
  {content: 'いま進めている長い作業の名前です。幅が狭いと折り返されます English words wrap too', status: 'in_progress'},
  {content: 'まだの作業', status: 'pending'},
]}}});
parityCase('tool: todo.write ok, no todos', {type: 'tool', call: {command: 'todo.write', ok: true, summary: '0 件', view: {todos: []}}});
// Ink measures a shrunk (indent-4) block's height at a narrower width than
// it renders it at, so some long unbroken texts gain one trailing blank
// line on the React side that the draw side does not reproduce. Registered
// as exceptions (line = the extra blank line's index).
const HEIGHT_QUIRK = 'Ink height measure: a shrunk block is measured narrower than rendered, adding one trailing blank line';
parityCase('tool: todo.write one very long unbroken item', {type: 'tool', call: {command: 'todo.write', ok: true, summary: '1 件', view: {todos: [{content: 'a'.repeat(400), status: 'pending'}]}}},
  [{width: 40, line: 13, kind: 'length', reason: HEIGHT_QUIRK}]);
parityCase('tool: todo.write item exactly filling the shrunk width', {type: 'tool', call: {command: 'todo.write', ok: true, summary: '1 件', view: {todos: [{content: 'a'.repeat(75), status: 'pending'}]}}},
  [{width: 80, line: 3, kind: 'length', reason: HEIGHT_QUIRK}]);
parityCase('tool: failed edit with a very long unbroken error', {type: 'tool', call: {command: 'code.edit', ok: false, summary: 'x', error: 'a'.repeat(400)}},
  [{width: 40, line: 14, kind: 'length', reason: HEIGHT_QUIRK}]);

// --- tool: mcp -----------------------------------------------------------------
parityCase('tool: mcp with more than four lines', {type: 'tool', call: {kind: 'mcp', command: 'mcp.playwright.browser_snapshot', ok: true, summary: 'snapshot', view: {text: 'line1\nline2\nline3\nline4\nline5\nline6'}}});
parityCase('tool: mcp empty result', {type: 'tool', call: {kind: 'mcp', command: 'mcp.playwright.browser_close', ok: true, summary: 'close', view: {text: '  \n '}}});
parityCase('tool: mcp long line is cut', {type: 'tool', call: {kind: 'mcp', command: 'mcp.playwright.browser_snapshot', ok: true, summary: 'snapshot', view: {text: 'a very long snapshot line that exceeds even the widest width we test here, one hundred and twenty cells and more'}}});

// --- tool: diffs (v.diff and v.files) ------------------------------------------
parityCase('tool: v.diff small', {type: 'tool', call: {command: 'code.edit', ok: true, summary: 'src/a.js', view: {diff: [
  {t: ' ', n: 1, l: 'const a = 1;'},
  {t: '-', n: 2, l: 'old line'},
  {t: '+', n: 2, l: 'new line'},
  {t: ' ', n: 3, l: 'const b = 2;'},
]}}});
parityCase('tool: v.diff long changed and context lines, ellipsis row, big numbers', {type: 'tool', call: {command: 'code.edit', ok: true, summary: 'src/big.js', view: {diff: [
  {t: ' ', n: 118, l: 'short context'},
  {t: '-', n: 119, l: 'const value = computeSomething(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive);'},
  {t: '+', n: 119, l: 'const value = computeSomething(argumentOne, argumentTwo, argumentThree, argumentFour, argumentSix);'},
  {t: '…', n: 0, l: ''},
  {t: ' ', n: 240, l: 'a very long context line that keeps going and going and going and going and going and going and going'},
  {t: '+', n: 241, l: 'short add'},
]}}});
{
  const rows = [];
  for (let i = 1; i <= 35; i++) rows.push({t: ' ', n: i, l: 'row ' + i});
  parityCase('tool: v.diff over 30 rows shows the more line', {type: 'tool', call: {command: 'code.write', ok: true, summary: 'src/many.js', view: {diff: rows}}});
}
parityCase('tool: v.files two files, one with an empty diff', {type: 'tool', call: {command: 'code.apply_patch', ok: true, summary: '2 ファイル', view: {files: [
  {path: CWD + '\\src\\a.js', added: 3, removed: 1, diff: [{t: ' ', n: 1, l: 'const a = 1;'}, {t: '-', n: 2, l: 'old line'}, {t: '+', n: 2, l: 'new line'}]},
  {path: CWD + '\\src\\b.js', added: 0, removed: 0, diff: []},
]}}});
parityCase('tool: code.write created shows Create and its diff', {type: 'tool', call: {command: 'code.write', ok: true, summary: 'src/new.js', view: {created: true, diff: [{t: '+', n: 1, l: 'new file line'}, {t: '+', n: 2, l: 'second line'}]}}});

// --- diff: direct null-safety (Diff itself is not exported from view.mjs) -----
test('diff: nullish and non-array diffs draw nothing', () => {
  assert.deepEqual(drawDiff(null, 80), []);
  assert.deepEqual(drawDiff(undefined, 80), []);
  assert.deepEqual(drawDiff('not an array', 80), []);
  assert.deepEqual(drawDiff(42, 80), []);
  assert.deepEqual(drawDiff([], 80), []);
});
test('diff: nullish rows do not throw', () => {
  const out = drawDiff([null, undefined, {t: '+', n: 1, l: 'x'}], 80);
  assert.equal(out.length, 3);
});
test('diff: max caps the rows and adds the more line', () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push({t: ' ', n: i, l: 'row ' + i});
  const out = drawDiff(rows, 80, 3);
  assert.equal(out.length, 4);
  assert.ok(P.strip(out[3]).includes('ほか 7 行'));
});
test('diff: default max is 30', () => {
  const rows = [];
  for (let i = 1; i <= 35; i++) rows.push({t: ' ', n: i, l: 'row ' + i});
  assert.equal(drawDiff(rows, 80).length, 31);
});

// --- past ----------------------------------------------------------------------
parityCase('past: steps only, one failed', {type: 'past', steps: [{title: 'コードを調べる'}, {title: 'テストで失敗', failed: true}]});
parityCase('past: tools ok and failed', {type: 'past', tools: [
  {command: 'code.read', ok: true, summary: 'src/a.js'},
  {command: 'system.run', ok: false, summary: 'npm test', error: 'exit 1: 2 tests failed'},
]});
parityCase('past: more than six lines shows the more line', {type: 'past',
  steps: [{title: '手順 1'}, {title: '手順 2'}, {title: '手順 3'}, {title: '手順 4'}],
  tools: [{command: 'code.read', ok: true, summary: 'a'}, {command: 'code.grep', ok: true, summary: 'b'}, {command: 'code.glob', ok: true, summary: 'c'}, {command: 'todo.write', ok: true, summary: 'd'}]});
parityCase('past: long error is cut by width', {type: 'past', tools: [
  {command: 'system.run', ok: false, summary: 'build', error: 'Error: something went very wrong in the build pipeline and the message keeps going with more and more detail about what failed and why it failed'},
]});
parityCase('past: long step title is cut at cols', {type: 'past', steps: [{title: 'とても長い手順のタイトルです。幅 40 では切り詰められます。English title words also get cut at the end of the line for sure'}]});
parityCase('past: tool without summary, code. prefix stripped', {type: 'past', tools: [{command: 'code.grep', ok: true}]});
test('past: no steps and no tools falls back (null)', () => {
  assert.equal(drawPast({type: 'past', steps: [], tools: []}, parity.baseCtx(80)), null);
  assert.equal(drawEntry({type: 'past'}, parity.baseCtx(80)), null);
});

// --- shellout ------------------------------------------------------------------
parityCase('shellout: running with output', {type: 'shellout', id: 'bg1', running: true, lines: ['starting up', 'listening on 8787']});
parityCase('shellout: finished exit 0 with an empty line inside', {type: 'shellout', id: 'bg2', running: false, exit: 0, lines: ['done', '', 'end']});
parityCase('shellout: finished exit 1, no output', {type: 'shellout', id: 'bg3', running: false, exit: 1, lines: []});
parityCase('shellout: running, no output yet', {type: 'shellout', id: 'bg4', running: true, lines: []});
parityCase('shellout: cut output', {type: 'shellout', id: 'bg5', running: false, exit: 0, cut: true, lines: ['latest line']});
parityCase('shellout: long lines are cut at cols', {type: 'shellout', id: 'bg6', running: false, exit: 0, lines: ['a very long shell output line that exceeds the width at forty columns and also at eighty for sure yes', '短い行']});
test('shellout: no id falls back (null)', () => {
  assert.equal(drawShellout({type: 'shellout', lines: ['x']}, parity.baseCtx(80)), null);
  assert.equal(drawEntry({type: 'shellout'}, parity.baseCtx(80)), null);
});

// --- dispatch --------------------------------------------------------------------
test('dispatch: drawEntry routes tool / past / shellout to the part functions', () => {
  const tool = {type: 'tool', call: {command: 'code.read', ok: true, summary: 'x', view: {lines: 1}}};
  assert.deepEqual(drawEntry(tool, parity.baseCtx(80, {ctrl})), drawTool(tool, parity.baseCtx(80, {ctrl})));
  const past = {type: 'past', steps: [{title: 'x'}]};
  assert.deepEqual(drawEntry(past, parity.baseCtx(80)), drawPast(past, parity.baseCtx(80)));
  const shell = {type: 'shellout', id: 'bg1', running: true, lines: []};
  assert.deepEqual(drawEntry(shell, parity.baseCtx(80)), drawShellout(shell, parity.baseCtx(80)));
});
test('dispatch: a tool entry without a call falls back (null)', () => {
  assert.equal(drawEntry({type: 'tool'}, parity.baseCtx(80)), null);
});

// --- tool: history rows slimmed by slimToolCall (src/slim-call.js) -----------
// The history keeps only the first diff lines plus diffOmitted / diffAdded / diffRemoved;
// both sides must show the same "… ほか n 行" count and +/- totals as the full diff did.
{
  const {slimToolCall} = require('../src/slim-call.js');
  const big = Array.from({length: 120}, (_, i) => ({t: i % 3 ? '+' : '-', n: i + 1, l: 'line ' + i}));
  const slimDiff = slimToolCall({command: 'code.write', ok: true, summary: 'src/huge.js', params: {}, view: {diff: big}});
  parityCase('tool: slimmed v.diff keeps the hidden count and the +/- totals', {type: 'tool', call: slimDiff});
  const slimFiles = slimToolCall({command: 'code.apply_patch', ok: true, summary: '1 ファイル', params: {}, view: {files: [{path: 'src/huge.js', added: 80, removed: 40, diff: big}]}});
  parityCase('tool: slimmed v.files keeps the hidden count', {type: 'tool', call: slimFiles});
  test('slimmed and full diffs draw the same rows (fullscreen side)', async () => {
    const {drawEntry: draw} = await import('../src/ui/fs/draw/index.mjs');
    const full = {type: 'tool', call: {command: 'code.write', ok: true, summary: 'src/huge.js', params: {}, view: {diff: big}}};
    for (const W of [40, 80, 120]) assert.deepEqual(draw({type: 'tool', call: slimDiff}, parity.baseCtx(W, {ctrl})), draw(full, parity.baseCtx(W, {ctrl})));
  });
}
