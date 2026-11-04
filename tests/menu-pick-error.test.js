'use strict';
// A menu pick that throws (a store refusing to write while another window holds its lock, phase 2)
// is shown as a note; it used to escape the key handler as an uncaught error and end muser.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-menu-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-menu-home-'));

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'm', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

test('a throwing pick becomes an error note, the menu closes, nothing escapes', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(os.tmpdir()), museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null);
  ctrl.openMenu({title: 'x', options: [{value: 'a', label: 'A'}], pick: () => { throw new Error('config.json is locked by another muser window'); }});
  assert.doesNotThrow(() => ctrl.key('', {return: true}));
  assert.equal(ctrl.get().menu, null);
  assert.ok(ctrl.get().entries.some(e => /locked by another muser window/.test((e.lines || []).join(' '))), 'the error is shown');
});

test('a pick whose promise rejects is shown too', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(os.tmpdir()), museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null);
  ctrl.openMenu({title: 'x', options: [{value: 'a', label: 'A'}], pick: async () => { throw new Error('busy'); }});
  ctrl.key('', {return: true});
  await new Promise(r => setTimeout(r, 0));
  assert.ok(ctrl.get().entries.some(e => /busy/.test((e.lines || []).join(' '))));
});
