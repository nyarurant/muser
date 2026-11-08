'use strict';
// Parity tests for the 'parity' entry (environment comparison, stage 1):
// the classic view.mjs drawing and the fullscreen src/ui/fs/draw drawing
// must agree line by line and cell by cell, at 40 / 80 / 120 and at the
// narrow widths where the rows stack (W < 40). Written in the style of
// tests/fs-parity.test.js; the entries are built by src/parity.js itself
// from hand-made snapshots, so both screens draw the real shape.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;
const parityCore = require('../src/parity');

let parity, Entry, drawEntry, drawParity;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawParity} = await import('../src/ui/fs/draw/entries/parity.mjs'));
});

const SNAP = {
  kind: 'muser-parity', version: 1, createdAt: '2026-11-07T00:00:00.000Z', project: 'x',
  os: {platform: 'win32', version: 'Windows 11 Pro', release: '10.0.26300', build: '26300', arch: 'x64'},
  locale: {language: 'ja-JP', codePage: 932},
  settings: {executionPolicy: 'RemoteSigned', longPaths: true},
  tools: {node: '22.1.0', npm: '10.2.3', git: '2.47.1.windows.1', python: null},
  path: ['%USERPROFILE%\\bin', 'C:\\Tools'],
  env: {names: ['NODE_ENV', 'PATH'], values: {NODE_ENV: 'development'}},
  locks: [{file: 'package-lock.json', sha256: 'abcdef0123456789'.repeat(4), bytes: 1234}],
};
const snapEntry = {type: 'parity', title: '環境比較（この PC）', sections: parityCore.snapshotSections(SNAP, 'C:\\Users\\x\\AppData\\Local\\muser\\parity\\snapshot-a.json')};
const OTHER = {...SNAP, tools: {...SNAP.tools, npm: '11.0.0', python: '3.12.7'}, settings: {executionPolicy: 'Restricted', longPaths: false}};
const diffEntry = {type: 'parity', title: '環境比較: a.json と b.json（違い 4 件）', sections: parityCore.diffSections(parityCore.diffSnapshots(SNAP, OTHER))};

const cases = [
  {name: 'parity: snapshot summary', e: snapEntry},
  {name: 'parity: diff sections', e: diffEntry},
  {name: 'parity: long values are cut, not wrapped over the rows', e: {type: 'parity', title: '環境比較（この PC）', sections: [{heading: null, rows: [['保存先', 'C:\\とても\\長い\\フォルダー\\名前が\\続く\\snapshot-2026-11-07.json'], ['OS', 'Windows 11 Pro (ビルド 26300)']]}]}},
  {name: 'parity: no title, one section', e: {type: 'parity', sections: [{heading: '道具の版', rows: [['node', '22.1.0 → 22.2.0']]}]}},
  {name: 'parity: empty entry draws nothing', e: {type: 'parity'}},
];
for (const c of cases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
  test(c.name + ' (narrow, rows stack)', () => {
    const used = parity.checkParity({
      name: c.name + ' narrow', widths: [24, 39],
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}

test('parity: drawEntry dispatches to drawParity', () => {
  assert.deepEqual(drawEntry(snapEntry, parity.baseCtx(80)), drawParity(snapEntry, parity.baseCtx(80)));
});
