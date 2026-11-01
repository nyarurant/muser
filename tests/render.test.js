'use strict';
// muser's own components rendered into a fake terminal (Ink, debug mode).
const test = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('node:events');

function fakeOut() {
  const s = new EventEmitter(); s.columns = 100; s.rows = 40; s.isTTY = false; s.out = '';
  s.write = d => { s.out += d; return true; };
  return s;
}
async function setup() {
  const React = (await import('react')).default, {render} = await import('ink');
  const {Entry, Live} = await import('../src/ui/view.mjs');
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  agent.constructor.DEVICE = 'test';
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const show = async el => {
    const out = fakeOut();
    const app = render(el, {stdout: out, debug: true, patchConsole: false, exitOnCtrlC: false});
    await new Promise(r => setTimeout(r, 200)); app.unmount();
    return out.out;
  };
  return {h: React.createElement, Entry, Live, ctrl, show};
}

// Math.max(...rows) threw a RangeError past ~150,000 rows, and a throw in render takes the screen down.
test('writing a 200,000-line file renders its diff (first rows and a count)', async () => {
  const {h, Entry, ctrl, show} = await setup();
  const {lineDiff} = require('../src/tools');
  const diff = lineDiff('', Array.from({length: 200000}, (_, i) => 'line ' + i).join('\n'));
  const out = await show(h(Entry, {e: {type: 'tool', call: {id: '1', command: 'code.write', kind: 'edit', ok: true, summary: 'big.txt', view: {diff, created: true}}}, ctrl, W: 100}));
  assert.match(out, /line 0/);
  assert.match(out, /ほか \d+ 行/);
});

// The approval box showed the first 12 lines of a command and said nothing about the rest.
test('an approval for a long command says how many lines it does not show', async () => {
  const {h, Live, ctrl, show} = await setup();
  const command = Array.from({length: 20}, (_, i) => 'echo step ' + (i + 1)).join('\n');
  ctrl.set({approval: {call: {command: 'system.run', kind: 'exec', params: {command}, summary: 'echo'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}});
  const out = await show(h(Live, {s: ctrl.get(), ctrl, W: 100}));
  assert.ok(out.includes('echo step 12'));
  assert.ok(!out.includes('echo step 13'));
  assert.match(out, /ほか 8 行（全部で 20 行/);
});

// With open todos, the running agents were not shown at all (the live area showed one or the other).
test('running agents show beside an open todo list', async () => {
  const {h, Live, ctrl, show} = await setup();
  ctrl.set({busy: true, turnStart: Date.now(), todos: [{content: 'step one', status: 'in_progress'}], agents: [{tag: 'a1', title: 'look into auth', type: 'explore', state: 'working', lastTool: 'Read', text: '', started: Date.now(), ended: 0}]});
  const out = await show(h(Live, {s: ctrl.get(), ctrl, W: 100}));
  assert.match(out, /step one/);
  assert.match(out, /look into auth/);
});

// A 3,000-line paste drew 3,000 rows on every key (half a second a frame, taller than the terminal).
test('a long paste shows a window of the input around the caret, not every line', async () => {
  const {h, Live, ctrl, show} = await setup();
  ctrl.paste(Array.from({length: 3000}, (_, i) => 'log line ' + i).join('\n'));
  const t0 = Date.now(), out = await show(h(Live, {s: ctrl.get(), ctrl, W: 100}));
  assert.ok(out.includes('log line 2999'), 'the caret line is shown');
  assert.ok(!out.includes('log line 100\n') && !out.includes('log line 10 '), 'far lines are not drawn');
  assert.match(out, /↑ ほか \d+ 行（全部で 3000 行）/);
  assert.ok(Date.now() - t0 < 400, 'drawn quickly');
  assert.equal(ctrl.get().text.split('\n').length, 3000, 'the text itself is whole');
});

// A 60,000-character line streaming (no newline yet) was drawn whole on every delta.
test('an unfinished long line streams as its tail only', async () => {
  const {h, Live, ctrl, show} = await setup();
  ctrl.set({busy: true, turnStart: Date.now()});
  ctrl.agent.emit('text', {id: 'm1', text: 'START' + 'x'.repeat(60000) + 'END'});
  const out = await show(h(Live, {s: ctrl.get(), ctrl, W: 100}));
  assert.ok(out.includes('END'));
  assert.ok(!out.includes('START'));
  assert.ok(out.split('\n').length < 400, out.split('\n').length + ' rows');
});

// One 20,000-character command wrapped to hundreds of rows and pushed the options off the screen.
test('an approval for a very long one-line command keeps the options on screen and says what is cut', async () => {
  const {h, Live, ctrl, show} = await setup();
  ctrl.set({approval: {call: {command: 'system.run', kind: 'exec', params: {command: 'Write-Output ' + 'a'.repeat(20000)}, summary: 'x'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}});
  const frame = (await show(h(Live, {s: ctrl.get(), ctrl, W: 100}))).split('\n');
  const at = frame.findIndex(l => l.includes('1. yes'));
  assert.ok(at > 0 && at < 40, 'options at row ' + at);
  assert.ok(frame.some(l => /ほか \d+ 文字（全部で 20013 文字/.test(l)));
});

test('approvals for a 15-file patch and a 12-argument MCP call keep the options on screen', async () => {
  const {h, Live, ctrl, show} = await setup();
  const {lineDiff} = require('../src/tools');
  const rowOf = async () => (await show(h(Live, {s: ctrl.get(), ctrl, W: 100}))).split('\n').findIndex(l => l.includes('1. yes'));
  const files = Array.from({length: 15}, (_, i) => ({path: process.cwd() + '/f' + i + '.js', op: 'update', diff: lineDiff('a\nb\nc\nd\ne\nf\n', 'A\nB\nC\nD\nE\nF\n')}));
  ctrl.set({approval: {call: {command: 'code.apply_patch', kind: 'edit', params: {patch: 'x'}, summary: 'f0.js'}, preview: {files}, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}});
  let at = await rowOf(); assert.ok(at > 0 && at < 40, 'patch: options at row ' + at);
  const listed = await show(h(Live, {s: ctrl.get(), ctrl, W: 100}));
  assert.match(listed, /ほか \d+ ファイル: /); assert.ok(listed.includes('f14.js'), 'the files not shown are named');
  const params = Object.fromEntries(Array.from({length: 12}, (_, i) => ['arg' + i, 'v'.repeat(400)]));
  ctrl.set({approval: {call: {command: 'mcp.s.t', kind: 'mcp', mcp: {server: 's', tool: 't'}, params, summary: 's · t'}, preview: null, options: [{label: 'yes'}, {label: 'no'}], index: 0, resolve() {}}});
  at = await rowOf(); assert.ok(at > 0 && at < 40, 'mcp: options at row ' + at);
});

test('25 running agents fit the screen with the input still visible', async () => {
  const {h, Live, ctrl, show} = await setup();
  const agents = Array.from({length: 25}, (_, i) => ({tag: 'a' + (i + 1), title: 'task ' + i, type: 'general', state: 'working', lastTool: 'Read', text: 'working on it', started: Date.now(), ended: 0}));
  ctrl.set({busy: true, turnStart: Date.now(), agents, todos: [{content: 'one', status: 'in_progress'}]});
  const frame = (await show(h(Live, {s: ctrl.get(), ctrl, W: 100}))).split('\n');
  const at = frame.findIndex(l => l.includes('Muse が作業中'));
  assert.ok(at > 0 && at < 40, 'input at row ' + at);
  assert.ok(frame.some(l => /ほか \d+ 件（\/agents で一覧）/.test(l)));
});
