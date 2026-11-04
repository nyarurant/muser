'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// Self-isolation guard, the same pattern as tests/fix2-controller.test.js:
// point LOCALAPPDATA / HOME at throwaway dirs before any src module loads.
const fsTop = require('node:fs');
const pathTop = require('node:path');
process.env.LOCALAPPDATA = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-fix2c2-data-'));
process.env.USERPROFILE = process.env.HOME = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-fix2c2-home-'));
const createdTmpDirs = [process.env.LOCALAPPDATA, process.env.HOME];
const origMkdtempSync = fsTop.mkdtempSync.bind(fsTop);
fsTop.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdTmpDirs.push(dir); return dir; };
after(() => { for (const dir of createdTmpDirs) { try { fsTop.rmSync(dir, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'demo'}; this.device = {connected: true};
    this.sent = [];
  }
  async send(text, opts) { this.sent.push({text, opts}); }
}
async function mk() {
  const {Controller} = await import('../src/ui/controller.mjs');
  const dir = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-fix2c2-'));
  const ctrl = new Controller({agent: new FakeAgent(dir), museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null);
  return ctrl;
}
const ZWJ = '\u200D';
const FAM = '\u{1F468}' + ZWJ + '\u{1F469}' + ZWJ + '\u{1F467}'; // one grapheme cluster, 8 UTF-16 units
const FLAG = '\u{1F1EF}\u{1F1F5}'; // one cluster, 4 UTF-16 units
const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const insideCluster = (text, pos) => [...seg.segment(text)].some(g => pos > g.index && pos < g.index + g.segment.length);

test('fifth f4-1: down onto a ZWJ family line never lands inside the cluster, and typing does not split it', async () => {
  const ctrl = await mk();
  ctrl.setText('abc\n' + FAM + 'yz', 3); // line 1, cluster column 3
  ctrl.key('', {downArrow: true});
  const pos = ctrl.get().pos;
  assert.equal(insideCluster(ctrl.get().text, pos), false, `caret must be on a cluster boundary, got pos=${pos}`);
  assert.equal(pos, 4 + FAM.length + 2, 'cluster column 3 clamps to the target line\'s 3 clusters (family, y, z) — its end');
  ctrl.key('X', {});
  assert.equal(ctrl.get().text, 'abc\n' + FAM + 'yzX', 'typing inserts at a boundary, the family stays whole');
  assert.equal(ctrl.get().text.includes(ZWJ + 'X'), false);
});

test('fifth f4-1: up onto a flag line never lands inside the regional-indicator pair', async () => {
  const ctrl = await mk();
  const line1 = 'a' + FLAG + 'bc'; // clusters: a, flag, b, c (7 UTF-16 units)
  ctrl.setText(line1 + '\nxyz', line1.length + 1 + 2); // line 2, cluster column 2
  ctrl.key('', {upArrow: true});
  const pos = ctrl.get().pos;
  assert.equal(insideCluster(ctrl.get().text, pos), false, `caret must be on a cluster boundary, got pos=${pos}`);
  assert.equal(pos, 1 + FLAG.length, 'cluster column 2 is after a + flag');
});

test('fifth f4-1: the vertical column is counted in clusters, not UTF-16 units', async () => {
  const ctrl = await mk();
  ctrl.setText(FAM + 'ab\nxyz', FAM.length + 1); // after family + a: cluster column 2 (UTF-16 column 9)
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, FAM.length + 3 + 2, 'down keeps cluster column 2 on the plain line, not UTF-16 column 9 clamped to its end');
  // Skin-tone modifier and combining mark count as one cluster each too.
  const thumb = '\u{1F44D}\u{1F3FD}'; // 👍🏽, one cluster, 4 units
  ctrl.setText(thumb + 'ab\nwxyz', thumb.length + 1);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, thumb.length + 3 + 2, 'cluster column 2 after a skin-tone cluster + a');
  const accented = 'e\u0301'; // é as e + combining acute, one cluster, 2 units
  ctrl.setText(accented + 'ab\nwxyz', accented.length + 1);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, accented.length + 3 + 2, 'cluster column 2 after a combining cluster + a');
});

test('fifth f4-1: vertical movement clamps by cluster count on a shorter target line', async () => {
  const ctrl = await mk();
  ctrl.setText('abcd\n' + FAM, 4); // cluster column 4, target line has a single cluster
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, 5 + FAM.length, 'clamped to the end of the one-cluster line, on its boundary');
  assert.equal(insideCluster(ctrl.get().text, ctrl.get().pos), false);
});

test('fifth f4-1: plain ASCII vertical movement and round-trip are unchanged', async () => {
  const ctrl = await mk();
  ctrl.setText('abc\nde\nfghi', 6);
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().pos, 2);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, 6);
  // Round-trip between two emoji lines returns to the same caret.
  const start = FAM.length + 2;
  ctrl.setText(FAM + 'ab\n' + FAM + 'cd', start);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, (FAM.length + 3) + FAM.length + 2, 'down keeps cluster column 3 on the emoji line');
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().pos, start, 'up returns to the original caret');
});
