'use strict';
// The fullscreen screen (src/ui/fs/): the virtualized history, the line-diff frame writer, the
// input decoding and the caret arithmetic. The end-to-end behaviour (a real pseudo terminal,
// resizes, scrolling, IME caret, leaving the alternate screen) was checked by hand with
// node-pty; these pin the pieces it is built from.
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');

const entriesOf = (n, linesEach = 3) => Array.from({length: n}, (_, i) => ({id: i, n: linesEach}));
const render = (e, W) => Array.from({length: e.n}, (_, k) => `e${e.id}.${k}@${W}`);

test('history: following shows the newest lines and lays out only what is visible', async () => {
  const {History} = await import('../src/ui/fs/history.mjs');
  const h = new History(render), entries = entriesOf(1000);
  const {lines} = h.view(entries, 80, 10);
  assert.equal(lines.length, 10);
  assert.equal(lines[9], 'e999.2@80');
  assert.equal(lines[0], 'e996.2@80');
  assert.ok(h.rendered <= 5, 'only the last few entries are laid out, not 1000 (' + h.rendered + ')');
  // A resize lays out the visible entries again at the new width — still a handful.
  const before = h.rendered;
  const {lines: wide} = h.view(entries, 120, 10);
  assert.equal(wide[9], 'e999.2@120');
  assert.ok(h.rendered - before <= 5);
});

test('history: a short conversation is padded at the top', async () => {
  const {History} = await import('../src/ui/fs/history.mjs');
  const h = new History(render);
  const {lines} = h.view(entriesOf(2), 80, 10);
  assert.deepEqual(lines.slice(0, 4), ['', '', '', '']);
  assert.equal(lines[9], 'e1.2@80');
});

test('history: scrolling up holds the view while new entries arrive, and scrolling back down follows again', async () => {
  const {History} = await import('../src/ui/fs/history.mjs');
  const h = new History(render); let entries = entriesOf(100);
  h.view(entries, 80, 10);
  h.scroll(-10, entries, 80, 10);
  assert.equal(h.follow, false);
  let v = h.view(entries, 80, 10);
  assert.equal(v.lines[9], 'e96.1@80', 'ten lines further up (line 289 of 300)');
  entries = [...entries, ...entriesOf(3).map(e => ({...e, id: 100 + e.id}))];
  v = h.view(entries, 80, 10);
  assert.equal(v.lines[9], 'e96.1@80', 'new output does not move the view');
  assert.equal(v.unseen, 3);
  h.scroll(100, entries, 80, 10);
  v = h.view(entries, 80, 10);
  assert.equal(h.follow, true);
  assert.equal(v.lines[9], 'e102.2@80');
  assert.equal(v.unseen, 0);
});

test('history: scrolling stops at the first line, skips entries that draw nothing, and /clear resets', async () => {
  const {History} = await import('../src/ui/fs/history.mjs');
  const h = new History(render);
  const entries = [{id: 0, n: 2}, {id: 1, n: 0}, {id: 2, n: 0}, ...entriesOf(20).map(e => ({...e, id: 3 + e.id}))];
  h.view(entries, 80, 5);
  h.scroll(-1000, entries, 80, 5);
  assert.deepEqual(h.anchor, {idx: 0, off: 0});
  assert.equal(h.view(entries, 80, 5).lines[0], 'e0.0@80');
  h.view(entriesOf(1), 80, 5); // fewer entries than before: a /clear
  assert.equal(h.follow, true);
});

test('screen: only changed lines are written, in one synchronized update, and the caret is placed', async () => {
  const {Screen} = await import('../src/ui/fs/screen.mjs');
  let out = '';
  const s = new Screen({columns: 20, rows: 3, write: x => { out += x; }});
  s.enter(); out = '';
  s.draw(['a', 'b', 'c'], null);
  assert.ok(out.startsWith('\x1b[?2026h') && out.endsWith('\x1b[?2026l'));
  // Each row is erased first, then written: an erase after a full-width line wiped its last column.
  assert.ok(out.includes('\x1b[1;1H\x1b[2Ka') && out.includes('\x1b[3;1H\x1b[2Kc'));
  assert.ok(!/a\x1b\[0m\x1b\[K/.test(out), 'no erase after the text');
  out = '';
  s.draw(['a', 'B', 'c'], {x: 4, y: 2});
  assert.ok(out.includes('\x1b[2;1H\x1b[2KB'));
  assert.ok(!out.includes('\x1b[1;1H') && !out.includes('\x1b[3;1H'), 'unchanged rows are not rewritten');
  assert.ok(out.includes('\x1b[3;5H\x1b[?25h'), 'caret at row 3, column 5, cursor shown');
  out = '';
  s.invalidate(); s.draw(['a', 'B', 'c'], null);
  assert.ok(out.includes('\x1b[2J') && out.includes('\x1b[1;1H\x1b[2Ka') && out.includes('\x1b[3;1H\x1b[2Kc'), 'after a resize the whole frame is written');
  out = '';
  s.leave();
  assert.ok(out.includes('\x1b[?1049l') && out.includes('\x1b[?25h') && out.includes('\x1b[?7h'));
});

test('input: keys decode like the classic screen, paste and the wheel are separate', async () => {
  const {toKey, attachInput} = await import('../src/ui/fs/input.mjs');
  assert.deepEqual(toKey('a').input, 'a');
  assert.equal(toKey('\x1b[5~').key.pageUp, true);
  assert.equal(toKey('\x1b[6~').key.pageDown, true);
  const d = toKey('\x04'); assert.equal(d.key.ctrl, true); assert.equal(d.input, 'd');
  assert.equal(toKey('\r').key.return, true);
  assert.equal(toKey('A').key.shift, true);
  const stdin = new EventEmitter(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
  const got = [];
  const detach = attachInput(stdin, {key: (i, k) => got.push(['key', i, !!k.upArrow]), paste: t => got.push(['paste', t]), wheel: n => got.push(['wheel', n])});
  stdin.emit('data', '\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;3;3M');
  stdin.emit('data', '\x1b[200~line 1\nline 2\x1b[201~');
  stdin.emit('data', 'x\x1b[A');
  detach();
  assert.deepEqual(got, [['wheel', -3], ['wheel', 3], ['paste', 'line 1\nline 2'], ['key', 'x', false], ['key', '', true]]);
});

test('input: a sequence split across reads still parses as one key; a lone ESC still flushes (master-debug #5)', async () => {
  const {attachInput} = await import('../src/ui/fs/input.mjs');
  const stdin = new EventEmitter(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
  const got = [];
  const detach = attachInput(stdin, {key: (i, k) => got.push([i, !!k.upArrow, !!k.escape]), paste: () => {}, wheel: () => {}});
  const wait = ms => new Promise(r => setTimeout(r, ms));
  stdin.emit('data', '\x1b[');
  await wait(60); // past the 20 ms flush: the fragment must NOT be typed as '['
  assert.deepEqual(got, []);
  stdin.emit('data', 'A');
  assert.deepEqual(got, [['', true, false]], 'the late final byte completes the Up arrow');
  stdin.emit('data', '\x1b');
  await wait(60);
  assert.deepEqual(got.at(-1), ['', false, true], 'a lone ESC is still the escape key');
  detach();
});

test('input: an unterminated bracketed paste lets Ctrl+C through and drops the partial paste (master-debug #2)', async () => {
  const {attachInput} = await import('../src/ui/fs/input.mjs');
  const stdin = new EventEmitter(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
  const got = [];
  const detach = attachInput(stdin, {key: (i, k) => got.push(['key', i, !!k.ctrl]), paste: t => got.push(['paste', t]), wheel: () => {}});
  stdin.emit('data', '\x1b[200~hello');
  stdin.emit('data', 'x');
  assert.deepEqual(got, [], 'keys are swallowed while the paste is open');
  stdin.emit('data', '\x03');
  assert.deepEqual(got, [['key', 'c', true]], 'Ctrl+C aborts the stuck paste and reaches the key handler');
  stdin.emit('data', 'y');
  assert.deepEqual(got.at(-1), ['key', 'y', false], 'input works again afterwards');
  stdin.emit('data', '\x1b[200~kept\x03inside\x1b[201~');
  assert.deepEqual(got.at(-1), ['paste', 'kept\x03inside'], 'a paste that DOES terminate keeps its bytes, ETX included');
  detach();
});

test('promptCaret: the caret sits after wide characters, and a long text keeps the caret row in its window', async () => {
  const {promptCaret} = await import('../src/ui/view.mjs');
  const c = promptCaret({text: 'abc日本', pos: 'abc日本'.length}, 80);
  assert.deepEqual(c, {row: 0, col: 2 + 2 + 3 + 4, above: false});
  const long = Array.from({length: 80}, (_, i) => 'line ' + i).join('\n');
  const end = promptCaret({text: long, pos: long.length}, 80);
  assert.equal(end.above, true);
  assert.ok(end.row >= 0 && end.row < 30);
});

test('select: cells, text between cells and highlight follow wide characters', async () => {
  const {cellsOf, textBetween, highlight, strip} = await import('../src/ui/fs/select.mjs');
  assert.deepEqual(cellsOf('a日b').map(c => [c.g, c.col, c.w]), [['a', 0, 1], ['日', 1, 2], ['b', 3, 1]]);
  assert.equal(textBetween('a日本b', 1, 3), '日', 'a grapheme counts when its first cell is in the range');
  assert.equal(textBetween('a日本b', 1, 5), '日本');
  const h = highlight('\x1b[31mred\x1b[0m 日本', 2, 6);
  assert.equal(strip(h), 'red 日本', 'the text is unchanged');
  assert.ok(h.includes('\x1b[7md 日\x1b[27m'), 'cells 2..5 are in reverse video');
});

test('select: a tab advances to the next 8-stop from where it lands (master-debug #8)', async () => {
  const {cellsOf, textBetween} = await import('../src/ui/fs/select.mjs');
  assert.deepEqual(cellsOf('ab\tc').map(c => [c.g, c.col, c.w]), [['a', 0, 1], ['b', 1, 1], ['\t', 2, 6], ['c', 8, 1]]);
  assert.equal(textBetween('ab\tc', 8, 9), 'c', 'the cell the terminal shows c at selects c');
  assert.deepEqual(cellsOf('\tx').map(c => [c.g, c.col, c.w]), [['\t', 0, 8], ['x', 8, 1]], 'a tab at column 0 still takes 8');
});

test('select: the copied text spans rows in reading order even when dragged upwards', async () => {
  const {selectedText} = await import('../src/ui/fs/select.mjs');
  const rows = [{ref: {idx: 1, off: 0}, line: '  first line  '}, {ref: {idx: 1, off: 1}, line: '\x1b[1msecond\x1b[0m'}, {ref: {idx: 2, off: 0}, line: 'third line'}];
  const down = {anchor: {ref: {idx: 1, off: 0}, col: 2}, head: {ref: {idx: 2, off: 0}, col: 4}};
  assert.equal(selectedText(down, rows), 'first line\nsecond\nthird');
  const up = {anchor: down.head, head: down.anchor};
  assert.equal(selectedText(up, rows), 'first line\nsecond\nthird', 'an upward drag copies the same text');
});

test('input: the left button press, drag and release reach the mouse handler, and so does the right button', async () => {
  const {attachInput} = await import('../src/ui/fs/input.mjs');
  const stdin = new EventEmitter(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
  const got = [];
  const detach = attachInput(stdin, {key: () => got.push('key'), paste: () => {}, wheel: n => got.push(['wheel', n]), mouse: m => got.push([m.kind, m.x, m.y, m.button])});
  stdin.emit('data', '\x1b[<0;3;6M\x1b[<32;10;7M\x1b[<0;10;7m\x1b[<2;1;1M\x1b[<2;1;1m\x1b[<64;1;1M');
  detach();
  // 波12で classic と揃えた: fullscreen でも右クリックは貼り付けとして扱われる —
  // the right button is no longer dropped here; its press and release reach the
  // mouse handler with button 'right', and app.mjs turns the release into a paste.
  assert.deepEqual(got, [['down', 2, 5, 'left'], ['drag', 9, 6, 'left'], ['up', 9, 6, 'left'], ['down', 0, 0, 'right'], ['up', 0, 0, 'right'], ['wheel', -3]], 'right button reaches the mouse handler as a paste gesture, wheel separate');
});

test('frame: on a short terminal the composer text row survives the live-area cut (master-debug #4)', async () => {
  const {runFullscreen} = await import('../src/ui/fs/app.mjs');
  const {EventEmitter: EE} = require('node:events');
  const mk = rows => {
    const out = new EE(); out.columns = 80; out.rows = rows; out.write = () => {};
    const stdin = new EE(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
    const state = {entries: [], busy: false, agents: []};
    const ctrl = {get: () => state, subscribe: () => () => {}, key: () => {}, paste: () => {}, note: () => {}, flash: () => {}};
    const renderLive = () => ({lines: ['', '╭──╮', '│ ❯ hi', '╰──╯', 'foot'], caret: {row: 2, col: 5}});
    return runFullscreen({ctrl, renderEntry: () => [], renderLive, out, stdin});
  };
  for (const rows of [5, 4, 3]) {
    const app = mk(rows);
    assert.ok(app.screen.prev.some(l => l.includes('❯ hi')), 'rows=' + rows + ': the composer text row is in the frame');
    if (rows === 5) assert.ok(app.screen.prev.some(l => l.includes('╭')), 'rows=5: the whole prompt box fits, top border included');
    app.unmount();
  }
});

test('frame: the first Esc / Ctrl+C after a drag-select reaches the controller (master-debug #7)', async () => {
  const {runFullscreen} = await import('../src/ui/fs/app.mjs');
  const {EventEmitter: EE} = require('node:events');
  const out = new EE(); out.columns = 80; out.rows = 10; out.write = () => {};
  const stdin = new EE(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
  const state = {entries: [{n: 0}, {n: 1}, {n: 2}], busy: false, agents: []};
  const keys = [];
  const ctrl = {get: () => state, subscribe: () => () => {}, key: (input, key) => keys.push([input, key]), paste: () => {}, note: () => {}, flash: () => {}};
  const app = runFullscreen({ctrl, renderEntry: e => ['A' + e.n], renderLive: () => ({lines: ['live'], caret: null}), out, stdin});
  // Drag across the blank tail of the last entry row (empty selection: the copy
  // is a no-op, so the real clipboard is never touched), then release.
  const dragSelect = () => stdin.emit('data', '\x1b[<0;71;9M\x1b[<32;76;9M\x1b[<0;76;9m');
  dragSelect();
  await new Promise(r => setTimeout(r, 30));
  stdin.emit('data', '\x1b'); // Esc — a lone ESC flushes after 20 ms (see #5)
  await new Promise(r => setTimeout(r, 80));
  assert.ok(keys.some(([, k]) => k.escape), 'Esc reached the controller: ' + JSON.stringify(keys));
  dragSelect();
  await new Promise(r => setTimeout(r, 30));
  stdin.emit('data', '\x03'); // Ctrl+C
  await new Promise(r => setTimeout(r, 30));
  assert.ok(keys.some(([input, k]) => input === 'c' && k.ctrl), 'Ctrl+C reached the controller');
  app.unmount();
});

test('frame: swapping the conversation drops the old scroll anchor (master-debug #9)', async () => {
  const {runFullscreen} = await import('../src/ui/fs/app.mjs');
  const {EventEmitter: EE} = require('node:events');
  const out = new EE(); out.columns = 80; out.rows = 10; out.write = () => {};
  const stdin = new EE(); stdin.setEncoding = () => {}; stdin.resume = () => {}; stdin.pause = () => {};
  const mkEntries = tag => Array.from({length: 20}, (_, i) => ({tag, i}));
  const state = {entries: mkEntries('A'), busy: false, agents: []};
  let notify = null;
  const ctrl = {agent: {session: {id: 'A'}}, get: () => state, subscribe: fn => { notify = fn; return () => {}; }, key: () => {}, paste: () => {}, note: () => {}, flash: () => {}};
  const app = runFullscreen({ctrl, renderEntry: e => [e.tag + e.i], renderLive: () => ({lines: ['live'], caret: null}), out, stdin});
  app.history.toTop(state.entries);
  assert.equal(app.history.follow, false, 'scrolled up in conversation A');
  ctrl.agent.session.id = 'B'; state.entries = mkEntries('B');
  notify();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(app.history.follow, true, 'conversation B opens followed at its newest output');
  app.unmount();
});

test('question draw: at W=20/21 every line fits the box width (master-debug #19)', async () => {
  const {drawQuestion} = await import('../src/ui/fs/draw/live/question.mjs');
  const {cellsOf, strip} = await import('../src/ui/fs/select.mjs');
  const lineW = l => cellsOf(strip(l)).reduce((m, c) => Math.max(m, c.col + c.w), 0);
  const s = {question: {tab: 0, index: 0, questions: [{question: 'which one?', options: [{label: 'Alpha', preview: 'preview text'}, {label: 'Beta'}]}]}};
  for (const W of [20, 21, 22]) {
    const lines = drawQuestion(s, {W});
    assert.ok(lines && lines.length > 3, 'the question drew at W=' + W);
    for (const l of lines) assert.ok(lineW(l) <= W, 'line fits W=' + W + ': ' + JSON.stringify(l));
    assert.ok(lines.some(l => l.includes('╮')), 'the top border keeps its right corner at W=' + W);
  }
});

test('sources draw: at narrow widths the URI tail survives whole (master-debug #20)', async () => {
  const {drawSources} = await import('../src/ui/fs/draw/entries/sources.mjs');
  const {cellsOf, strip} = await import('../src/ui/fs/select.mjs');
  const lineW = l => cellsOf(strip(l)).reduce((m, c) => Math.max(m, c.col + c.w), 0);
  const e = {items: [{label: 'documentation', uri: 'https://example.com/some/deep/page.html'}]};
  for (const W of [20, 24]) {
    const lines = drawSources(e, {W, cols: W});
    const item = strip(lines[1]);
    assert.ok(lineW(lines[1]) <= W, 'the item line fits W=' + W + ': ' + item);
    assert.ok(item.endsWith('.html'), 'the URI tail is intact at W=' + W + ': ' + item);
  }
  const wide = drawSources(e, {W: 80, cols: 80});
  assert.ok(strip(wide[1]).includes('page.html'), 'the wide draw still shows the URI tail');
});

test('todos draw: a null element renders as an empty pending row instead of throwing (master-debug #1)', async () => {
  const {drawTodos} = await import('../src/ui/fs/draw/entries/todos.mjs');
  const {drawLiveTodos} = await import('../src/ui/fs/draw/live/todos.mjs');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const rows = drawTodos({type: 'todos', todos: [null, {content: 'real', status: 'completed'}]}, {W: 39, cols: 40});
  assert.ok(rows.some(l => strip(l).includes('☐')), 'the null element draws the pending mark');
  assert.ok(rows.some(l => strip(l).includes('real')), 'the real element still draws');
  const live = drawLiveTodos({todos: [null, {content: 'x', status: 'in_progress'}]}, {W: 39});
  assert.equal(live.length, 3, 'margin plus two rows');
});

test('history: rows carry their entry refs, linesBetween walks them, toTop goes to the first line', async () => {
  const {History} = await import('../src/ui/fs/history.mjs');
  const h = new History(render), entries = entriesOf(10);
  const v = h.view(entries, 80, 4);
  assert.deepEqual(v.refs[3], {idx: 9, off: 2});
  assert.deepEqual(h.linesBetween(entries, 80, {idx: 9, off: 1}, {idx: 8, off: 2}).map(r => r.line), ['e8.2@80', 'e9.0@80', 'e9.1@80']);
  h.toTop(entries);
  assert.equal(h.view(entries, 80, 4).lines[0], 'e0.0@80');
});
