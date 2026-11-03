'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

test('settings menu, number entry and interim report render in the real Ink components', async () => {
  const React = (await import('react')).default;
  const {render} = await import('ink');
  const {Controller} = await import('../src/ui/controller.mjs');
  const {Entry, Live} = await import('../src/ui/view.mjs');
  const i18n = require('../src/i18n');
  const agent = new EventEmitter();
  Object.assign(agent, {cwd: process.cwd(), mode: 'plan', session: {id: 'preview', turns: 0}, ctx: {readFiles: new Set()}, client: {status: 'demo'}, agentLimits: {concurrent: 4, perTurn: 0}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  const show = async (component, props, columns) => {
    const stdout = new EventEmitter(); Object.assign(stdout, {columns, rows: 40, isTTY: false, text: ''});
    stdout.write = data => { stdout.text += data; return true; };
    const app = render(React.createElement(component, {...props, ctrl, W: columns - 1}), {stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
    // Poll for the first frame instead of a fixed 150 ms sleep (slow under load).
    const start = Date.now();
    while (!stdout.text) { if (Date.now() - start > 5000) throw new Error('timed out waiting for the first frame'); await new Promise(r => setTimeout(r, 20)); }
    app.unmount();
    return stdout.text;
  };
  ctrl.slash('/settings agents');
  let out = await show(Live, {s: ctrl.get()}, 100);
  assert.match(out, /同時に動かすエージェント数/);
  assert.match(out, /今回だけ適用/);
  assert.match(out, /既定値として保存/);
  ctrl.key('1', {}); ctrl.key('12', {});
  out = await show(Live, {s: ctrl.get()}, 60);
  assert.match(out, /12/);
  assert.match(out, /enter/);
  assert.match(out, /esc/);
  ctrl.key('', {return: true}); ctrl.key('3', {});
  agent.emit('progress', {agent: 'main', message: '保存処理を確認しました。次にテストを実行します。'});
  out = await show(Entry, {e: ctrl.get().entries.at(-1)}, 60);
  assert.match(out, /保存処理を確認しました/);
  assert.match(out, /次にテストを実行します/);
  assert.ok(!out.includes('progress.report'), 'report appears as prose, not tool chrome');
  i18n.setLang('en', {save: false});
  try {
    ctrl.slash('/settings agents');
    out = await show(Live, {s: ctrl.get()}, 100);
    assert.match(out, /Apply for this run/);
    assert.match(out, /Apply and save defaults/);
  } finally { i18n.setLang('ja', {save: false}); }
});

test('the settings menu renders a header where the genre changes', async () => {
  const React = (await import('react')).default;
  const {render} = await import('ink');
  const {Controller} = await import('../src/ui/controller.mjs');
  const {Live} = await import('../src/ui/view.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {cwd: process.cwd(), mode: 'plan', session: {id: 'preview', turns: 0}, ctx: {readFiles: new Set()}, client: {status: 'demo'}, agentLimits: {concurrent: 4, perTurn: 0}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  const show = async (component, props, columns) => {
    const stdout = new EventEmitter(); Object.assign(stdout, {columns, rows: 40, isTTY: false, text: ''});
    stdout.write = data => { stdout.text += data; return true; };
    const app = render(React.createElement(component, {...props, ctrl, W: columns - 1}), {stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
    const start = Date.now();
    while (!stdout.text) { if (Date.now() - start > 5000) throw new Error('timed out waiting for the first frame'); await new Promise(r => setTimeout(r, 20)); }
    app.unmount();
    return stdout.text;
  };
  ctrl.slash('/settings');
  let out = await show(Live, {s: ctrl.get()}, 100);
  assert.match(out, /作業の進め方/, 'the first genre header leads the list');
  assert.match(out, /上限と使用量/, 'the second genre header is in the first window too');
  assert.match(out, /エージェント上限/, 'the rows still render under their header');
  // Scrolled to a display row, the window still leads with that genre's header.
  const m = ctrl.get().menu, i = m.options.findIndex(o => o.value === 'color');
  ctrl.set({menu: {...m, index: i}});
  out = await show(Live, {s: ctrl.get()}, 100);
  assert.match(out, /表示/, 'the display genre header leads the scrolled window');
  assert.match(out, /色を使う/);
});
