'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

test('real Ink components show Focus evidence and a verification-wait outcome', async () => {
  const React = (await import('react')).default, {render} = await import('ink');
  const {Entry, Live} = await import('../src/ui/view.mjs'), {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {cwd: process.cwd(), mode: 'plan', session: {id: 'preview', turns: 0}, ctx: {readFiles: new Set()}, client: {status: 'demo'}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  const focus = {goal: 'Fix the visible issue', status: 'needs_input', round: 1, maxRounds: 3, reason: 'Actual device confirmation needed',
    criteria: [{id: 'c1', text: 'Tests pass', status: 'met', evidence: ['e1'], reason: 'exit 0'}, {id: 'c2', text: 'Visible on device', status: 'unknown', evidence: [], reason: 'Please check the device'}]};
  const show = async (component, props) => {
    const stdout = new EventEmitter(); Object.assign(stdout, {columns: 80, rows: 30, isTTY: false, text: ''}); stdout.write = data => { stdout.text += data; return true; };
    const app = render(React.createElement(component, {...props, ctrl, W: 79}), {stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
    // Poll for the first frame instead of a fixed 100 ms sleep: under load the
    // frame can land later, and an empty capture would fail every assert below.
    const start = Date.now();
    while (!stdout.text) { if (Date.now() - start > 5000) throw new Error('timed out waiting for the first frame'); await new Promise(r => setTimeout(r, 20)); }
    app.unmount(); return stdout.text;
  };
  const final = await show(Entry, {e: {type: 'focus', focus, full: true}});
  assert.match(final, /確認・判断待ち/); assert.match(final, /Tests pass/); assert.match(final, /e1/); assert.match(final, /Please check the device/);
  // The automatic end-of-turn form is one compact line: status, met count, unmet ids — no panel.
  const compact = await show(Entry, {e: {type: 'focus', focus}});
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(strip(compact), /Focus: 確認・判断待ち · ✓ 1\/2 · 1\/3 · 未完: c2/);
  assert.equal(strip(compact).split('\n').filter(l => l.trim()).length, 1, 'one line only');
  assert.doesNotMatch(strip(compact), /Tests pass/);
  ctrl.set({busy: true, turnStart: Date.now(), focus: {...focus, status: 'running'}});
  const live = await show(Live, {s: ctrl.get()});
  assert.match(live, /Focus 1\/3/); assert.match(live, /根拠あり 1\/2/);
});
