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
  await require('../src/mentions').ready(ctrl.agent.cwd); // the list is built in the background while the user types
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
  await require('../src/mentions').ready(ctrl.agent.cwd);
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

test('a menu opening (e.g. the re-login offer) keeps what the user was typing', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('half-written message', 20);
  ctrl.openMenu({title: 'x', options: [{value: 'a', label: 'a'}], pick() {}});
  assert.equal(ctrl.get().text, 'half-written message');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().menu, null);
  assert.equal(ctrl.get().text, 'half-written message');
});

// 2026-11-01 audit: the screen showed 4-12 lines of a tool's output and the rest could only be
// seen by running it again. /output shows a recent call in full and saves it to a file.
test('/output shows a tool call in full (long ones: the last 200 lines and a file)', async () => {
  const fs = require('node:fs');
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const long = Array.from({length: 500}, (_, i) => 'line ' + (i + 1)).join('\n');
  agent.emit('tool-end', {id: '1', command: 'system.run', summary: 'npm test', ok: true, view: {exit: 0, tail: ['line 500']}, output: long});
  const tool = ctrl.get().entries.at(-1);
  assert.equal(tool.call.outputLines, 500);
  assert.equal(tool.call.output, undefined, 'the full text is not kept in scrollback entries');
  ctrl.slash('/output');
  assert.equal(ctrl.get().menu.options.length, 1);
  ctrl.get().menu.pick(0);
  const note = ctrl.get().entries.at(-1).lines.join('\n');
  assert.match(note, /line 500/);
  assert.match(note, /line 301\n/);
  assert.ok(!/line 300\n/.test(note), 'only the last 200 lines on screen');
  const file = note.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).find(l => l.includes('muser-output')).replace(/^.*?: /, '').trim();
  assert.equal(fs.readFileSync(file, 'utf8'), long + '\n', 'the file has all of it');
  fs.unlinkSync(file);
});

test('↑↓ in the @ list re-render, so the highlight visibly moves', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(atDir()), museName: 'm', version: 't', onExit() {}});
  await require('../src/mentions').ready(ctrl.agent.cwd);
  ctrl.setText('@ap', 3);
  let renders = 0; ctrl.subscribe(() => { renders++; });
  ctrl.key('', {downArrow: true});
  assert.equal(renders, 1);
});

test('after esc, queued messages go back into the input instead of being sent', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd()); const sent = [];
  agent.send = async text => { sent.push(text); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.set({busy: true});
  await ctrl.submit('next task'); await ctrl.submit('and this');
  agent.emit('turn-end', {ok: false, aborted: true, error: 'stopped'});
  assert.deepEqual(sent, []);
  assert.equal(ctrl.get().text, 'next task\nand this');
  ctrl.set({busy: true}); await ctrl.submit('queued');
  agent.emit('turn-end', {ok: true});
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(sent.map(s => s.split('\n')[0]), ['queued'], 'a turn that finished normally still sends the queue');
});

test('Enter after an @path typed out in full sends instead of completing it again', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(atDir()); const sent = [];
  agent.send = async text => { sent.push(text); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  await require('../src/mentions').ready(agent.cwd);
  ctrl.setText('look at @apple.txt', 18);
  ctrl.key('', {return: true});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sent.length, 1, 'sent on the first Enter');
  assert.match(sent[0], /^look at @apple\.txt/);
  ctrl.setText('look at @apr', 12);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, 'look at @apricot.txt ', 'a partial path is still completed');
});
