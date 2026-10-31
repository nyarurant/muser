'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

test('scrollback is never trimmed (Ink <Static> prints only past items.length)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const before = ctrl.get().entries.length;
  for (let i = 0; i < 400; i++) ctrl.push({type: 'note', lines: ['n' + i]});
  assert.equal(ctrl.get().entries.length, before + 400);
});

test('starting in the home folder warns once that searches will cover all of it', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const home = new Controller({agent: new FakeAgent(os.homedir()), museName: 'm', version: 't', onExit() {}});
  assert.ok(home.get().entries.some(e => e.type === 'note' && /ホームかドライブ直下/.test(e.lines.join(''))));
  const repo = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  assert.ok(!repo.get().entries.some(e => e.type === 'note' && /ホームかドライブ直下/.test(e.lines.join(''))));
});
