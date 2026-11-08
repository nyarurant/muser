'use strict';
// tell: a message that arrived while the window was idle waits for the next turn.
// An empty Enter must send it (found on a real two-window run: the arrival line
// showed, but Enter on an empty line did nothing and the message never ran).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Self-isolation guard, as in controller.test.js: throwaway data/home before any src module loads.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-tellenter-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-tellenter-home-'));
test.after(() => { for (const d of [process.env.LOCALAPPDATA, process.env.HOME]) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
    this.pendingTell = [];
  }
}
FakeAgent.DEVICE = 'test';

async function make() {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const sent = [];
  ctrl.submit = text => { sent.push(text); };
  return {agent, ctrl, sent};
}

test('empty Enter sends a tell that is waiting while idle', async () => {
  const {agent, ctrl, sent} = await make();
  agent.pendingTell.push({from: {name: 'peer'}, text: 'add sub too'});
  ctrl.key('', {return: true});
  assert.equal(sent.length, 1, 'one turn is started');
  assert.ok(sent[0].trim(), 'with a non-empty request (the waiting tell rides its head)');
});

test('empty Enter with nothing waiting still does nothing', async () => {
  const {ctrl, sent} = await make();
  ctrl.key('', {return: true});
  assert.deepEqual(sent, []);
});

test('empty Enter while Muse is working does not start a turn (the tell rides the next tool result)', async () => {
  const {agent, ctrl, sent} = await make();
  agent.pendingTell.push({from: {name: 'peer'}, text: 'x'});
  ctrl.set({busy: true});
  ctrl.key('', {return: true});
  assert.deepEqual(sent, []);
});

test('the arrival line says Enter goes ahead only when idle', async () => {
  const {agent, ctrl} = await make();
  agent.emit('tell', {messages: [{from: {name: 'peer'}, text: 'hello'}], working: false});
  agent.emit('tell', {messages: [{from: {name: 'peer'}, text: 'busy one'}], working: true});
  const notes = JSON.stringify(ctrl.get().items || ctrl.get());
  assert.match(notes, /hello[^"]*(空のまま Enter で進めます|press Enter on an empty line)/, 'the idle line has the hint');
  assert.ok(!/busy one[^"]*(空のまま Enter|press Enter)/.test(notes), 'the working-time line has no Enter hint');
});

test('a write held by the claim guard shows one line naming the other muser', async () => {
  const {agent, ctrl} = await make();
  agent.emit('tell-claim', {name: 'android-ui', file: 'C:/repo/app.js'});
  const notes = JSON.stringify(ctrl.get().items || ctrl.get());
  assert.match(notes, /android-ui[^"]*(書き込みを 1 回止めました|Held one write)|Held one write because android-ui/);
});
