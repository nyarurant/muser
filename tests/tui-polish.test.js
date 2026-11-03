'use strict';
// TUI layout fixes of 2026-11-03: tables set as a whole, and the rows that broke on a narrow terminal.
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');
// Colour codes on (term.js colours only a TTY otherwise), so the marker colours can be checked.
process.env.MUSER_SGR = '1';
const {width, strip} = require('../src/tui/term.js');

async function setup() {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Entry, Live} = await import('../src/ui/view.mjs');
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  agent.constructor.DEVICE = 'muser CLI';
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  const show = (el, columns) => strip(renderToString(el, {columns}));
  return {h: React.createElement, Entry, Live, ctrl, show};
}
const TABLE = ['| コマンド | 役割 |', '|:---|---:|', '| `npm test` | テスト全部 |', '| `muser demo` | **見た目** |'];
// Display columns of every │ / ┼ in a row: aligned columns put them in the same places.
const borders = row => { const out = []; let w = 0; for (const ch of strip(row)) { if (ch === '│' || ch === '┼') out.push(w); w += width(ch); } return out; };

test('a table is set as a whole: every row as wide, borders and the rule at the same columns', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const rows = createMd(80).rows(TABLE).map(r => r.text);
  assert.equal(rows.length, 4);
  const at = borders(rows[0]);
  for (const r of rows) assert.deepEqual(borders(r), at, 'column borders line up: ' + strip(r));
  assert.equal(new Set(rows.map(r => width(r))).size, 1, 'every row is as wide');
  assert.ok(strip(rows[2]).includes('npm test') && !rows[2].includes('`'), 'cells are still formatted');
  assert.match(strip(rows[3]), /\s見た目 $/, '---: aligns the column right');
});

test('table lines inside a code fence stay code', async () => {
  const {createMd} = await import('../src/ui/md.mjs');
  const rows = createMd(80).rows(['```', '| a | b |', '```']);
  assert.equal(strip(rows[1].text), '| a | b |');
});

test('a streamed table is held in the live area until it ends, then printed aligned', async () => {
  const {ctrl} = await setup();
  const reply = 'まえ\n' + TABLE.join('\n') + '\nあと';
  ctrl.onText({id: 'm', text: 'まえ\n' + TABLE.slice(0, 3).join('\n') + '\n| `mus'});
  const printed = () => ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows.map(r => strip(r.text)));
  assert.deepEqual(printed(), ['まえ'], 'no table row is printed while the table goes on');
  const preview = ctrl.previewRow();
  assert.equal(preview.table.length, 3, 'the held rows are shown in the live area');
  assert.equal(preview.row, null, 'the unfinished table row waits to join the table');
  ctrl.onText({id: 'm', text: reply}); ctrl.endMessage('m');
  const rows = printed();
  assert.equal(rows.length, 6);
  assert.equal(rows[5], 'あと');
  const at = borders(rows[1]);
  for (const r of rows.slice(1, 5)) assert.deepEqual(borders(r), at);
});

test('a table at the very end of a reply is printed when the message ends', async () => {
  const {ctrl} = await setup();
  ctrl.onText({id: 'm', text: TABLE.join('\n') + '\n'});
  ctrl.endMessage('m');
  assert.equal(ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows).length, 4);
});

test('on a 50-column terminal the footer is one row and the wordmark keeps its two rows together', async () => {
  const {h, Entry, Live, ctrl, show} = await setup();
  const live = show(h(Live, {s: ctrl.get(), ctrl, W: 49}), 50).split('\n');
  const foot = live.filter(l => l.trim()).pop();
  assert.match(foot, /毎回確認.*● muser CLI/, 'mode and status lane on the one last row: ' + foot);
  const banner = show(h(Entry, {e: {id: 1, type: 'banner'}, ctrl, W: 49}), 50).split('\n');
  const top = banner.findIndex(l => l.includes('█▀▄▀█'));
  assert.match(banner[top + 1], /█ ▀ █/, 'the second row of the wordmark is right under the first');
});

test('the selected / candidate has a ❯ (it was colour only) and the keys get their own row', async () => {
  const {h, Live, ctrl, show} = await setup();
  ctrl.set({text: '/s', pos: 2});
  const out = show(h(Live, {s: ctrl.get(), ctrl, W: 79}), 80).split('\n');
  assert.ok(out.some(l => /❯ \/settings/.test(l)));
  assert.ok(out.some(l => l.trim() === '↑↓ で選択 · enter / tab で補完'));
});

test('a command that exits non-zero is not marked green; a declined step is yellow, not red', async () => {
  const {c} = require('../src/tui/term.js');
  const {h, Entry, ctrl} = await setup();
  const {renderToString} = await import('ink');
  const row = call => renderToString(h(Entry, {e: {id: 1, type: 'tool', call}, ctrl, W: 79}), {columns: 80}).split('\n')[0];
  assert.notEqual(c.green('▶'), '▶', 'colour codes are on for this check');
  const passed = row({command: 'system.run', kind: 'exec', ok: true, summary: 'npm test', view: {tail: ['x'], exit: 0}});
  const failed = row({command: 'system.run', kind: 'exec', ok: true, summary: 'npm test', view: {tail: ['x'], exit: 1}});
  const declined = row({command: 'system.run', kind: 'exec', ok: false, declined: true, summary: 'rm', error: 'The user declined this.'});
  // Ink re-encodes the reset after a run, so compare the colour that opens the marker.
  const open = paint => paint('▶ ').split('▶ ')[0] + '▶ ';
  assert.ok(passed.startsWith(open(c.green)));
  assert.ok(failed.startsWith(open(c.red)), 'exit 1: red marker');
  assert.ok(declined.startsWith(open(c.yellow)), 'declined: yellow marker');
});
