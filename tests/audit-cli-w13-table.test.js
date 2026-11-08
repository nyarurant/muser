'use strict';
// Wave 13: md / table preview fixes.
//  (1) nested list / quote prefixes are capped (a quarter of the row, at
//      least 8 cells) with a '…' depth mark, so the text column survives on
//      both screens (both read the prefix from md.row()).
//  (2) a streaming table preview keeps the column widths it first showed;
//      the finished table is printed at its true widths.
//  (3) table rows never wrap, even with codeWrap on; code rows still do.
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');
const {width, strip} = require('../src/tui/term.js');

// ---------- (1) prefix cap ----------
test('w13 md (1): a deeply nested list prefix is capped and keeps its marker', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(80); // cap = 20
  const deep = md.row(' '.repeat(60) + '- item');
  assert.ok(width(deep.prefix) <= 20, 'prefix fits the cap: ' + JSON.stringify(deep.prefix));
  assert.ok(deep.prefix.includes('…'), 'the overflow is marked');
  assert.ok(deep.prefix.trimEnd().endsWith('•'), 'the bullet marker survives');
  assert.equal(deep.text, 'item');
  const num = md.row(' '.repeat(60) + '12. item');
  assert.ok(width(num.prefix) <= 20 && num.prefix.includes('…') && num.prefix.trimEnd().endsWith('12.'), 'numbered: ' + JSON.stringify(num.prefix));
  const task = md.row(' '.repeat(60) + '- [ ] item');
  assert.ok(width(task.prefix) <= 20 && task.prefix.includes('…') && task.prefix.includes('☐'), 'task: ' + JSON.stringify(task.prefix));
  const narrow = createMd(40); // cap = 10
  assert.ok(width(narrow.row(' '.repeat(60) + '- item').prefix) <= 10, 'the cap follows the width');
  // Shallow nesting is byte-identical to before.
  assert.equal(md.row('  - x').prefix, '  • ');
  assert.equal(md.row('- x').prefix, '• ');
  assert.equal(md.row('    3. x').prefix, '    3. ');
});

test('w13 md (1): a deeply nested quote prefix is capped and keeps its bars', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const md = createMd(80);
  const deep = md.row('>'.repeat(30) + ' deep');
  assert.ok(width(deep.prefix) <= 20, 'prefix fits the cap: ' + JSON.stringify(deep.prefix));
  assert.ok(deep.prefix.startsWith('▎'), 'bars still lead');
  assert.ok(deep.prefix.includes('…'), 'the overflow is marked');
  assert.equal(deep.text, 'deep');
  assert.equal(md.row('> > x').prefix, '▎▎ ', 'shallow quotes are unchanged');
  assert.equal(md.row('> x').prefix, '▎ ');
});

test('w13 md (1): the capped prefix leaves a usable text column on the fs draw', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const {hanging} = await import('../src/ui/fs/draw/primitives.mjs');
  const r = createMd(40).row(' '.repeat(60) + '- abcdefghij klmnopqrst');
  const lines = hanging('  ' + r.prefix, r.text, {width: 40, wrapMode: 'wrap'});
  for (const l of lines) assert.ok(width(l) <= 40, 'line fits: ' + l);
  assert.ok(lines[0].includes('abcdefghij'), 'the text starts on the first line, not squeezed out: ' + lines[0]);
});

// ---------- (2) frozen preview widths ----------
const T1 = ['| a | bb |', '|---|---|', '| 1 | 22 |'];
const T2 = [...T1, '| a-much-wider-cell | bbbbbbbbbbbb |'];

test('w13 md (2): tableRows with frozen widths keeps the first alignment', async () => {
  const {tableRows, tableWidths} = await import('../src/ui/md.mjs');
  const first = tableRows(T1);
  const frozen = tableRows(T2, tableWidths(T1));
  assert.deepEqual(frozen.slice(0, 3).map(r => r.text), first.map(r => r.text), 'rows already shown do not move');
  assert.equal(new Set(frozen.map(r => width(r.text))).size, 1, 'every frozen row is as wide');
  assert.ok(frozen[3].text.includes('…'), 'the wider cell is cut to its frozen column');
  const whole = tableRows(T2);
  assert.ok(whole[3].text.includes('a-much-wider-cell'), 'unfrozen, the finished table uses its true widths');
  assert.notDeepEqual(whole.slice(0, 3).map(r => r.text), first.map(r => r.text), 'sanity: unfrozen rows do re-align');
});

async function setupCtrl() {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  agent.constructor.DEVICE = 'muser CLI';
  return new Controller({agent, museName: 'Muse', version: '0.3.8', onExit() {}});
}

test('w13 controller (2): a streamed preview freezes its widths; the printed table does not', async () => {
  const ctrl = await setupCtrl();
  ctrl.onText({id: 'm', text: T1.join('\n') + '\n'});
  const p1 = ctrl.previewRow();
  assert.equal(p1.table.length, 3);
  ctrl.onText({id: 'm', text: T2.join('\n') + '\n'});
  const p2 = ctrl.previewRow();
  assert.equal(p2.table.length, 4);
  assert.deepEqual(p2.table.slice(0, 3).map(r => strip(r.text)), p1.table.map(r => strip(r.text)), 'already-shown rows keep their alignment');
  ctrl.endMessage('m');
  const printed = ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows.map(r => strip(r.text)));
  assert.ok(printed.some(l => l.includes('a-much-wider-cell')), 'the finished table prints the wide cell whole');
});

// ---------- (3) tables never wrap under codeWrap ----------
const LONG_TABLE = ['| 名前 | 説明 |', '| --- | --- |', '| りんご | ' + 'とても長い説明文です。'.repeat(6) + ' |'];
const LONG_CODE = ['```', 'const veryLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour);', '```'];

test('w13 fs (3): drawMd truncates table rows with codeWrap on, code rows still wrap', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const {drawMd} = await import('../src/ui/fs/draw/entries/md.mjs');
  const {hanging} = await import('../src/ui/fs/draw/primitives.mjs');
  const parity = await import('./helpers/parity.mjs');
  const e = {type: 'md', rows: createMd(80).rows(LONG_TABLE), first: false};
  const lines = drawMd(e, parity.baseCtx(40, {codeWrap: true}));
  // Wave 14 (W13-12): the 3 table rows plus ONE notice line counting what
  // the cuts hide. The expected count is derived here from the row texts
  // alone: drawMd draws at ctx.cols = 41, each row's body is 41 minus its
  // drawn prefix ('  ' + r.prefix), and truncate-end keeps the graphemes
  // that fit in bodyW - 1 cells (the last cell is its '…'), so a row hides
  // (total graphemes - kept graphemes); a row that fits hides nothing.
  const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  const graphemes = s => [...seg.segment(s)].map(g => g.segment);
  let expectedHidden = 0;
  for (const r of e.rows) {
    const bodyW = Math.max(1, 41 - width('  ' + (r.prefix ?? '')));
    const text = r.text || ' ';
    if (width(text) <= bodyW) continue;
    const gs = graphemes(strip(text));
    let w = 0, kept = 0;
    for (const g of gs) { const gw = width(g); if (w + gw > bodyW - 1) break; w += gw; kept++; }
    expectedHidden += gs.length - kept;
  }
  assert.ok(expectedHidden > 0, 'the wide table really does hide characters at 41 cols');
  assert.equal(lines.length, 4, 'one screen line per table row, plus the notice line: ' + JSON.stringify(lines));
  const notice = /… ほか (\d+) 文字/.exec(strip(lines[3]));
  assert.ok(notice, 'the last line is the counted notice: ' + JSON.stringify(strip(lines[3])));
  assert.equal(Number(notice[1]), expectedHidden, 'the notice counts exactly the graphemes the drawn rows hide');
  const expectedRows = e.rows.map(r => hanging('  ' + (r.prefix ?? ''), r.text || ' ', {width: 41, wrapMode: 'truncate-end'})[0]);
  assert.deepEqual(lines.slice(0, 3), expectedRows, 'the table rows themselves are drawn exactly as before');
  for (const l of lines) assert.ok(width(strip(l)) <= 41, 'fits the width');
  const code = {type: 'md', rows: createMd(80).rows(LONG_CODE), first: false};
  const codeLines = drawMd(code, parity.baseCtx(40, {codeWrap: true}));
  assert.ok(codeLines.length > 3, 'codeWrap still wraps plain code rows');
});

test('w13 fs (3): the live preview truncates table rows with codeWrap on', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const {drawPreview} = await import('../src/ui/fs/draw/live/preview.mjs');
  const {hanging} = await import('../src/ui/fs/draw/primitives.mjs');
  const parity = await import('./helpers/parity.mjs');
  const table = tableRows(LONG_TABLE);
  const ctrl = {previewRow: () => ({table, first: false})};
  const lines = drawPreview({}, parity.baseCtx(40, {codeWrap: true, ctrl}));
  // Wave 14 (W13-12): the 3 preview rows plus ONE notice line. The preview
  // draws at ctx.W = 40 (not ctx.cols), so each row's body is 40 minus its
  // drawn prefix ('  ' + r.prefix); the expected hidden count is derived
  // from the row texts exactly as in the drawMd test above (truncate-end
  // keeps the graphemes fitting in bodyW - 1 cells, the rest is hidden).
  const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  const graphemes = s => [...seg.segment(s)].map(g => g.segment);
  let expectedHidden = 0;
  for (const r of table) {
    const bodyW = Math.max(1, 40 - width('  ' + (r.prefix ?? '')));
    const text = r.text || ' ';
    if (width(text) <= bodyW) continue;
    const gs = graphemes(strip(text));
    let w = 0, kept = 0;
    for (const g of gs) { const gw = width(g); if (w + gw > bodyW - 1) break; w += gw; kept++; }
    expectedHidden += gs.length - kept;
  }
  assert.ok(expectedHidden > 0, 'the wide preview table really does hide characters at 40 cols');
  assert.equal(lines.length, 4, 'one screen line per preview row, plus the notice line: ' + JSON.stringify(lines));
  const notice = /… ほか (\d+) 文字/.exec(strip(lines[3]));
  assert.ok(notice, 'the last line is the counted notice: ' + JSON.stringify(strip(lines[3])));
  assert.equal(Number(notice[1]), expectedHidden, 'the notice counts exactly the graphemes the drawn rows hide');
  const expectedRows = table.map(r => hanging('  ' + (r.prefix ?? ''), r.text || ' ', {width: 40, wrapMode: 'truncate-end'})[0]);
  assert.deepEqual(lines.slice(0, 3), expectedRows, 'the preview rows themselves are drawn exactly as before');
});

test('w13 classic (3): an md entry truncates table rows with codeWrap on, code rows still wrap', async () => {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Entry} = await import('../src/ui/view.mjs');
  const {createMd} = await import('../src/ui/md.mjs');
  const h = React.createElement;
  const show = (e, columns) => strip(renderToString(h(Entry, {e, ctrl: {}, W: columns - 1}), {columns})).split('\n').filter(l => l.trim());
  process.env.MUSER_CODE_WRAP = '1';
  try {
    const tableRowsMd = createMd(80).rows(LONG_TABLE);
    const table = show({type: 'md', rows: tableRowsMd, first: false}, 40);
    // Wave 14 (W13-12): the 3 table rows plus ONE notice line. The classic
    // Md lays out at the renderToString columns (40), so each row's body
    // is 40 minus its drawn prefix ('  ' + r.prefix); the expected hidden
    // count is derived from the row texts exactly as in the fs tests
    // above (truncate-end keeps the graphemes fitting in bodyW - 1 cells).
    const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
    const graphemes = s => [...seg.segment(s)].map(g => g.segment);
    let expectedHidden = 0;
    for (const r of tableRowsMd) {
      const bodyW = Math.max(1, 40 - width('  ' + (r.prefix ?? '')));
      const text = r.text || ' ';
      if (width(text) <= bodyW) continue;
      const gs = graphemes(strip(text));
      let w = 0, kept = 0;
      for (const g of gs) { const gw = width(g); if (w + gw > bodyW - 1) break; w += gw; kept++; }
      expectedHidden += gs.length - kept;
    }
    assert.ok(expectedHidden > 0, 'the wide table really does hide characters at 40 cols');
    assert.equal(table.length, 4, 'one screen line per table row, plus the notice line: ' + JSON.stringify(table));
    const notice = /… ほか (\d+) 文字/.exec(table[3]);
    assert.ok(notice, 'the last line is the counted notice: ' + JSON.stringify(table[3]));
    assert.equal(Number(notice[1]), expectedHidden, 'the notice counts exactly the graphemes the drawn rows hide');
    const {hanging} = await import('../src/ui/fs/draw/primitives.mjs');
    const expectedRows = tableRowsMd.map(r => strip(hanging('  ' + (r.prefix ?? ''), r.text || ' ', {width: 40, wrapMode: 'truncate-end'})[0]));
    assert.deepEqual(table.slice(0, 3), expectedRows, 'the table rows themselves are drawn exactly as before');
    for (const l of table) assert.ok(width(l) <= 40, 'fits the width: ' + l);
    const code = show({type: 'md', rows: createMd(80).rows(LONG_CODE), first: false}, 40);
    assert.ok(code.length > 3, 'codeWrap still wraps plain code rows');
  } finally { delete process.env.MUSER_CODE_WRAP; }
});
