'use strict';
// parity diff: one PATH entry added at the front reported 37 differences on a real
// snapshot (every later entry "moved" by one, duplicates listed again, NODE_ENV twice).
const test = require('node:test');
const assert = require('node:assert');
const {diffSnapshots} = require('../src/parity.js');

const snap = (path, names = [], values = {}) => ({path, env: {names, values}, tools: {}, locks: [], os: {}});
const paths = items => items.filter(i => i.category === 'path').map(i => i.label);

test('an entry added in front is one difference, not a shift of every entry after it', () => {
  const a = snap(['C:\\a', 'C:\\b', 'C:\\c', 'C:\\b']);
  const b = snap(['C:\\new', 'C:\\a', 'C:\\b', 'C:\\c', 'C:\\b']);
  assert.deepEqual(paths(diffSnapshots(a, b)), ['C:\\new']);
});

test('a real reorder is still a difference', () => {
  const items = diffSnapshots(snap(['C:\\a', 'C:\\b', 'C:\\c']), snap(['C:\\c', 'C:\\a', 'C:\\b']));
  assert.deepEqual(paths(items), ['C:\\c'], 'c moved ahead of a and b');
});

test('a removed entry is one difference', () => {
  assert.deepEqual(paths(diffSnapshots(snap(['C:\\a', 'C:\\gone', 'C:\\b']), snap(['C:\\a', 'C:\\b']))), ['C:\\gone']);
});

test('an allowlisted variable that appears is reported once, with its value', () => {
  const items = diffSnapshots(snap([], []), snap([], ['NODE_ENV'], {NODE_ENV: 'production'})).filter(i => i.category === 'env');
  assert.equal(items.length, 1);
  assert.equal(items[0].b, 'production');
});
