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

function atDir() {
  const fs = require('node:fs'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-atsel-'));
  for (const n of ['apple.txt', 'apricot.txt', 'banana.txt']) fs.writeFileSync(path.join(dir, n), 'x');
  return dir;
}

test('@ candidates: down arrow chooses, enter picks it, history is not touched', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(atDir()), museName: 'm', version: 't', onExit() {}});
  ctrl.history = ['previous prompt'];
  ctrl.setText('@ap', 3);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().text, '@ap', 'arrows only move the highlight');
  assert.equal(ctrl.atIndex('ap', 2), 1);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '@apricot.txt ', 'enter completes the highlighted candidate instead of sending');
  assert.deepEqual(ctrl.history, ['previous prompt']);
});

test('@ candidates: tab still completes the first candidate', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(atDir()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('@ap', 3);
  ctrl.key('', {tab: true});
  assert.equal(ctrl.get().text, '@apple.txt ');
});

test('starting in the home folder warns once that searches will cover all of it', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const home = new Controller({agent: new FakeAgent(os.homedir()), museName: 'm', version: 't', onExit() {}});
  assert.ok(home.get().entries.some(e => e.type === 'note' && /ホームかドライブ直下/.test(e.lines.join(''))));
  const repo = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  assert.ok(!repo.get().entries.some(e => e.type === 'note' && /ホームかドライブ直下/.test(e.lines.join(''))));
});
