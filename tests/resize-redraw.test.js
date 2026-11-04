'use strict';
// A resize redraws the history (src/ui/view.mjs Root). Checked in Windows Terminal on
// 2026-11-04: narrowing left copies of the input box behind. Redrawing re-runs every history
// entry, so entries must draw what they showed the first time: the banner called a fresh chat
// "resumed" once its first turn had run. Also the /status account row read "2  2".
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-resize-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-resize-home-'));

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'sess-1', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';
async function makeCtrl(agent) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null);
  return ctrl;
}
async function draw(ctrl, e) {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Entry} = await import('../src/ui/view.mjs');
  const {strip} = require('../src/tui/term.js');
  return strip(renderToString(React.createElement(Entry, {e, ctrl, W: 79}), {columns: 80}));
}

test('a fresh chat\'s banner does not turn into "resumed" when it is drawn again after a turn', async () => {
  const agent = new FakeAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-resize-cwd-')));
  const ctrl = await makeCtrl(agent);
  const banner = ctrl.s.entries.find(e => e.type === 'banner');
  assert.ok(!(await draw(ctrl, banner)).includes('再開'));
  agent.session.turns = 1; // the first turn ran; then the window was resized
  assert.ok(!(await draw(ctrl, banner)).includes('再開'), 'the redraw shows what the banner showed first');
});

test('a resumed chat\'s banner keeps its resume line and turn count on a redraw', async () => {
  const agent = new FakeAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-resize-cwd-')));
  agent.session = {id: 'sess-2', title: '前の作業', turns: 3};
  const ctrl = await makeCtrl(agent);
  const banner = ctrl.s.entries.find(e => e.type === 'banner');
  assert.match(await draw(ctrl, banner), /再開: 前の作業\s+3 ターン/);
  agent.session.turns = 5;
  assert.match(await draw(ctrl, banner), /再開: 前の作業\s+3 ターン/);
});

test('/status names an unnamed account once, a named one with its id', async () => {
  const agent = new FakeAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-resize-cwd-')));
  const ctrl = await makeCtrl(agent);
  agent.accountId = '2'; agent.accountLabel = '2';
  const plain = await draw(ctrl, {id: 90, type: 'status'});
  assert.match(plain, /アカウント\s+2\s*$/m);
  agent.accountLabel = 'sub';
  assert.match(await draw(ctrl, {id: 91, type: 'status'}), /アカウント\s+sub\s+2\s*$/m);
});
