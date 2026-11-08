'use strict';
// Wave 14 regression tests for the W13-12 / W13-14 fixes:
//  (1) a truncated md row no longer hides behind a bare '…': the fs entry
//      draw (drawMd), the fs live preview (drawPreview) and the classic
//      Entry each add ONE final line ' … ほか {n} 文字' counting the
//      graphemes the drawn lines hide, when (and only when) a table row,
//      or a code row with codeWrap off, is actually cut.
//  (2) copying a selection that covers a whole md entry in the fullscreen
//      screen returns the entry's Markdown source (e.src), not the
//      truncated drawn lines; a partial selection keeps the drawn text.
//  (3) a session id shared EXACTLY by two sessions (a hand-edited /
//      merged index) refuses at the bin level with the shared-id message
//      naming both folders — not the 'もう少し長く' prefix advice — and
//      an explicit --cd <folder> picks the duplicate in that folder.
//
// Homes: tests/setup.mjs already points USERPROFILE / HOME /
// LOCALAPPDATA at %TEMP% scratch dirs; the guard below is the wave-3
// lesson — this file must never run against the real home. The bin
// subprocesses get their own scratch dirs, also under %TEMP%.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {width, strip} = require('../src/tui/term.js');

const TMP = os.tmpdir();
for (const v of [process.env.USERPROFILE, process.env.LOCALAPPDATA]) {
  assert.ok(v && path.resolve(v).startsWith(path.resolve(TMP)), 'head guard: test homes must live under %TEMP%, got ' + v);
}

const LONG_TABLE = ['| 名前 | 説明 |', '| --- | --- |', '| りんご | ' + 'とても長い説明文です。'.repeat(6) + ' |'];
const NARROW_TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'];
const LONG_CODE = ['```', 'const veryLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour);', '```'];

// The expected hidden-character count, derived independently from the row
// texts and the total width a draw lays out at: a counted row's body is
// (total width - its drawn prefix '  ' + r.prefix, or '⏺ ' for a first
// row), and truncate-end keeps the graphemes that fit in bodyW - 1 cells
// (the last cell is its '…'), so the row hides (total - kept) graphemes.
// A row whose text fits its body hides nothing. `countRow(r)` says which
// rows the draw truncates (table rows always; code rows only when the
// draw will not wrap them).
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const graphemesOf = s => [...segmenter.segment(s)].map(g => g.segment);
function expectedHidden(rows, totalW, countRow, first = false) {
  let hidden = 0;
  rows.forEach((r, i) => {
    if (!countRow(r)) return;
    const prefix = (first && i === 0 ? '⏺ ' : '  ') + (r.prefix ?? '');
    const bodyW = Math.max(1, totalW - width(prefix));
    const text = r.text || ' ';
    if (width(text) <= bodyW) return;
    const gs = graphemesOf(strip(text));
    let w = 0, kept = 0;
    for (const g of gs) { const gw = width(g); if (w + gw > bodyW - 1) break; w += gw; kept++; }
    hidden += gs.length - kept;
  });
  return hidden;
}
// The notice count a draw printed, or null when there is no notice line.
function noticeOf(lines) {
  const plain = lines.map(l => strip(l));
  for (const l of plain) { const m = /… ほか (\d+) 文字/.exec(l); if (m) return {count: Number(m[1]), plain}; }
  return {count: null, plain};
}

// ---------- (1) fs drawMd ----------
test('w14 fs drawMd: a wide table at 80 cols adds the counted notice line', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const {drawMd} = await import('../src/ui/fs/draw/entries/md.mjs');
  const {hanging} = await import('../src/ui/fs/draw/primitives.mjs');
  const parity = await import('./helpers/parity.mjs');
  const rows = createMd(80).rows(LONG_TABLE);
  const e = {type: 'md', rows, first: false};
  // baseCtx(79): W = 79, cols = W + 1 = 80 — the entry lays out at cols.
  const lines = drawMd(e, parity.baseCtx(79, {codeWrap: true}));
  const expected = expectedHidden(rows, 80, r => !!r.table);
  assert.ok(expected > 0, 'the wide table really does hide characters at 80 cols');
  assert.equal(lines.length, 4, '3 table rows + 1 notice line: ' + JSON.stringify(lines.map(l => strip(l))));
  const {count, plain} = noticeOf(lines);
  assert.equal(count, expected, 'the notice (last line) counts exactly the hidden graphemes');
  assert.match(plain[3], /^ +… ほか \d+ 文字$/, 'the notice is the LAST line');
  const expectedRows = rows.map(r => hanging('  ' + (r.prefix ?? ''), r.text || ' ', {width: 80, wrapMode: 'truncate-end'})[0]);
  assert.deepEqual(lines.slice(0, 3), expectedRows, 'the table rows themselves are drawn as before');
});

test('w14 fs drawMd: a narrow table adds no notice line', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const {drawMd} = await import('../src/ui/fs/draw/entries/md.mjs');
  const parity = await import('./helpers/parity.mjs');
  const rows = createMd(80).rows(NARROW_TABLE);
  assert.equal(expectedHidden(rows, 80, r => !!r.table), 0, 'nothing is hidden at 80 cols');
  const lines = drawMd({type: 'md', rows, first: false}, parity.baseCtx(79, {codeWrap: true}));
  assert.equal(lines.length, 3, 'just the 3 table rows: ' + JSON.stringify(lines.map(l => strip(l))));
  assert.equal(noticeOf(lines).count, null, 'no notice line');
});

test('w14 fs drawMd: a long code line is counted with codeWrap off, wrapped whole with it on', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const {drawMd} = await import('../src/ui/fs/draw/entries/md.mjs');
  const parity = await import('./helpers/parity.mjs');
  const rows = createMd(80).rows(LONG_CODE);
  const e = {type: 'md', rows, first: false};
  const off = drawMd(e, parity.baseCtx(79, {codeWrap: false}));
  const expectedOff = expectedHidden(rows, 80, r => !!r.code);
  assert.ok(expectedOff > 0, 'the code line really is cut at 80 cols');
  assert.equal(off.length, 4, '3 code rows + 1 notice line: ' + JSON.stringify(off.map(l => strip(l))));
  assert.equal(noticeOf(off).count, expectedOff, 'the notice counts the hidden graphemes of the code row');
  assert.ok(!noticeOf(off).plain.join('\n').includes('argumentFour);'), 'the cut code tail is not in the drawn lines');
  const on = drawMd(e, parity.baseCtx(79, {codeWrap: true}));
  assert.equal(noticeOf(on).count, null, 'codeWrap on: nothing is truncated, so no notice');
  assert.ok(on.length > 3, 'codeWrap on: the code row wraps onto more lines');
  assert.ok(noticeOf(on).plain.join('\n').includes('argumentFour);'), 'codeWrap on: the line tail is present, wrapped');
});

// ---------- (1) fs drawPreview ----------
test('w14 fs drawPreview: a wide table adds the counted notice line (its own width basis)', async () => {
  const {tableRows} = await import('../src/ui/md.mjs');
  const {drawPreview} = await import('../src/ui/fs/draw/live/preview.mjs');
  const {hanging} = await import('../src/ui/fs/draw/primitives.mjs');
  const parity = await import('./helpers/parity.mjs');
  const table = tableRows(LONG_TABLE);
  const ctrl = {previewRow: () => ({table, first: false})};
  const lines = drawPreview({}, parity.baseCtx(40, {codeWrap: true, ctrl}));
  // The preview's own basis: it draws at ctx.W = 40, NOT ctx.cols = 41, so
  // its bodies are one cell narrower than the finished entry's at the
  // same baseCtx — and its count is correspondingly larger.
  const expected = expectedHidden(table, 40, () => true);
  assert.ok(expected > 0, 'the wide preview table really does hide characters at W=40');
  assert.equal(lines.length, 4, '3 preview rows + 1 notice line: ' + JSON.stringify(lines.map(l => strip(l))));
  const {count, plain} = noticeOf(lines);
  assert.equal(count, expected, 'the notice counts the hidden graphemes at the preview width');
  assert.match(plain[3], /^ +… ほか \d+ 文字$/, 'the notice is the LAST line');
  assert.notEqual(count, expectedHidden(table, 41, () => true), 'sanity: the cols basis (41) would count differently — the preview did not use it');
  const expectedRows = table.map(r => hanging('  ' + (r.prefix ?? ''), r.text || ' ', {width: 40, wrapMode: 'truncate-end'})[0]);
  assert.deepEqual(lines.slice(0, 3), expectedRows, 'the preview rows themselves are drawn as before');
});

// ---------- (1) classic ----------
test('w14 classic: a wide table prints the same notice count as the fs side', async () => {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Entry} = await import('../src/ui/view.mjs');
  const {createMd} = await import('../src/ui/md.mjs');
  const {drawMd} = await import('../src/ui/fs/draw/entries/md.mjs');
  const parity = await import('./helpers/parity.mjs');
  const h = React.createElement;
  const show = (e, columns) => strip(renderToString(h(Entry, {e, ctrl: {}, W: columns - 1}), {columns})).split('\n').filter(l => l.trim());
  const rows = createMd(80).rows(LONG_TABLE);
  const e = {type: 'md', rows, first: false};
  process.env.MUSER_CODE_WRAP = '1';
  try {
    // Same total width on both sides: classic at columns = 80 lays its Md
    // out at 80; the fs entry at baseCtx(79) has cols = 80.
    const classic = show(e, 80);
    const fsLines = drawMd(e, parity.baseCtx(79, {codeWrap: true}));
    const expected = expectedHidden(rows, 80, r => !!r.table);
    assert.ok(expected > 0, 'the wide table really does hide characters at 80 cols');
    assert.equal(classic.length, 4, '3 table rows + 1 notice line: ' + JSON.stringify(classic));
    assert.equal(noticeOf(classic).count, expected, 'the classic notice counts the hidden graphemes');
    assert.equal(noticeOf(fsLines).count, expected, 'the fs notice counts the same');
    assert.equal(noticeOf(classic).count, noticeOf(fsLines).count, 'classic and fs report the same loss for the same input');
    assert.match(classic[3], /^ +… ほか \d+ 文字$/, 'the notice is the LAST line');
  } finally { delete process.env.MUSER_CODE_WRAP; }
});

// ---------- (2) copy returns the source for a whole md entry ----------
test('w14 fs copy: selecting a whole md entry returns its source; a partial selection returns the drawn text', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const {History} = await import('../src/ui/fs/history.mjs');
  const {selectedText} = await import('../src/ui/fs/select.mjs');
  const {drawEntry} = await import('../src/ui/fs/draw/index.mjs');
  const parity = await import('./helpers/parity.mjs');
  const TAIL = 'TAILMARKER';
  const SRC_ROWS = ['| 名前 | 説明 |', '| --- | --- |', '| りんご | ' + 'とても長い説明文です。'.repeat(6) + TAIL + ' |'];
  const src = SRC_ROWS.join('\n');
  const entry = {type: 'md', rows: createMd(80).rows(SRC_ROWS), first: false, src};
  const entries = [entry];
  // The History + renderEntry harness of the real screen (fs/run.mjs):
  // History calls render(entry, W) with W = columns - 1, and drawEntry's
  // ctx for that W has cols = W + 1 — here W = 79, so cols = 80.
  const history = new History((e, W) => drawEntry(e, parity.baseCtx(W)) ?? []);
  const drawn = history.lines(entry, 79);
  assert.equal(drawn.length, 4, 'the entry draws 3 table rows + the notice line');
  assert.ok(!strip(drawn.join('\n')).includes(TAIL), 'the drawn lines really do cut the source tail away');
  const lastOff = drawn.length - 1;
  // Whole entry: anchor at its first line, column 0; head at its last
  // line, past the end of that (short) notice line.
  const wholeRows = history.linesBetween(entries, 79, {idx: 0, off: 0}, {idx: 0, off: lastOff});
  assert.ok(wholeRows.length === drawn.length && wholeRows.every(r => r.src === src), 'linesBetween tags every row of the fully covered entry with its src');
  const whole = selectedText({anchor: {ref: {idx: 0, off: 0}, col: 0}, head: {ref: {idx: 0, off: lastOff}, col: 999}}, wholeRows);
  assert.equal(whole, src, 'a whole-entry selection copies the Markdown source, not the truncated drawing');
  assert.ok(whole.includes(TAIL), 'the source tail (cut from the drawing) is in the copy');
  // Partial: the selection starts mid-entry (its second drawn line), so
  // the span does not cover the entry whole and no src tag is attached.
  const partRows = history.linesBetween(entries, 79, {idx: 0, off: 1}, {idx: 0, off: lastOff});
  assert.ok(partRows.length > 0 && partRows.every(r => !('src' in r)), 'linesBetween tags nothing for a partial span');
  const part = selectedText({anchor: {ref: {idx: 0, off: 1}, col: 0}, head: {ref: {idx: 0, off: lastOff}, col: 999}}, partRows);
  assert.notEqual(part, src, 'a partial selection does not return the source');
  assert.ok(!part.includes(TAIL), 'the source tail marker is absent from the drawn copy');
  assert.equal(part, partRows.map(r => strip(r.line).replace(/\s+$/, '')).join('\n'), 'a partial selection returns the drawn text');
  assert.ok(part.includes('ほか'), 'the drawn copy includes the notice line itself, as drawn');
});

// ---------- (3) duplicate session ids at the bin level ----------
test('w14 bin: a duplicated session id refuses with both folders; --cd picks its folder', {timeout: 120000}, () => {
  const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
  const mk = prefix => fs.mkdtempSync(path.join(TMP, prefix));
  const data = mk('muser-w14dup-data-'), home = mk('muser-w14dup-home-');
  const folderA = mk('muser-w14dup-folderA-'), folderB = mk('muser-w14dup-folderB-');
  for (const d of [data, home, folderA, folderB]) assert.ok(path.resolve(d).startsWith(path.resolve(TMP)), 'head guard: scratch dir under %TEMP%: ' + d);
  const DUP = 'w14dup14-1111-2222-3333-444444444444';
  const prevLocal = process.env.LOCALAPPDATA;
  try {
    // Seed the index the way tests/sessions.test.js seeds its home: point
    // the store at the scratch data dir (its DIR is resolved from
    // LOCALAPPDATA at require time), create + touch two sessions in
    // different folders through the store, then hand-edit the index so
    // both entries carry the SAME id — nothing in normal operation
    // creates that; a merged / hand-edited index can.
    process.env.LOCALAPPDATA = data;
    for (const m of ['../src/secure-store', '../src/sessions']) delete require.cache[require.resolve(m)];
    const sessions = require('../src/sessions');
    assert.ok(path.resolve(sessions.FILE).startsWith(path.resolve(data)), 'head guard: the sessions index is the scratch one: ' + sessions.FILE);
    const a = sessions.create(folderA); a.id = DUP; sessions.touch(a, 'first chat in A');
    const b = sessions.create(folderB); sessions.touch(b, 'second chat in B');
    const list = JSON.parse(fs.readFileSync(sessions.FILE, 'utf8'));
    assert.equal(list.length, 2, 'two sessions were seeded');
    const other = list.find(s => s.id !== DUP);
    assert.ok(other && other.cwd === folderB, 'the second seeded session is folder B\'s');
    other.id = DUP;
    fs.writeFileSync(sessions.FILE, JSON.stringify(list));
    assert.equal(sessions.findAll(DUP).length, 2, 'the edited index now holds the id twice');
    process.env.LOCALAPPDATA = prevLocal;
    const runBin = args => {
      const env = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', MUSER_NO_UPDATE_CHECK: '1', USERPROFILE: home, HOME: home, LOCALAPPDATA: data, MUSER_SERVER_FILE: path.join(home, 'server.json')};
      const r = spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', timeout: 60000, env, input: 'hello'});
      return {status: r.status, out: (r.stdout || '') + (r.stderr || '')};
    };
    // No --cd: exec --session resolves through sessionFromFlags /
    // resumeTarget and must stop on the shared id, naming BOTH folders,
    // without the 'もう少し長く' advice (no longer spelling can help).
    const noCd = runBin(['exec', '--session', DUP]);
    assert.equal(noCd.status, 1, 'the duplicated id is refused: ' + noCd.out);
    assert.match(noCd.out, /共有されています/, 'the shared-id message is printed');
    assert.ok(noCd.out.includes(DUP), 'the message names the shared id');
    assert.ok(noCd.out.includes(folderA), 'the message names folder A');
    assert.ok(noCd.out.includes(folderB), 'the message names folder B');
    assert.ok(!noCd.out.includes('もう少し長く'), 'the longer-prefix advice is NOT printed');
    // With --cd <folderB>: the duplicate in B is picked, so the ambiguity
    // error must not appear. The run may then fail later (the scratch
    // home has no login / network) — assert only on the absence of the
    // ambiguity text, and that folder A is never the named candidate.
    const cdB = runBin(['--cd', folderB, 'exec', '--session', DUP]);
    assert.ok(!cdB.out.includes('共有されています'), 'no shared-id refusal with --cd folderB: ' + cdB.out);
    assert.ok(!cdB.out.includes('もう少し長く'), 'no ambiguity advice with --cd folderB');
    assert.ok(!cdB.out.includes(folderA), 'folder A is not named: if the output names a candidate folder, it is B\'s');
  } finally {
    process.env.LOCALAPPDATA = prevLocal;
    for (const d of [data, home, folderA, folderB]) fs.rmSync(d, {recursive: true, force: true});
  }
});
