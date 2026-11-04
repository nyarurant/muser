'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

// Ink (debug mode) writes the frame synchronously-ish, but on a loaded machine
// the first frame can land well after a fixed 100-200 ms sleep. Poll the
// captured output for what the test is about to assert instead.
async function waitForText(stdout, re, what) {
  const start = Date.now();
  while (!re.test(stdout.text)) {
    if (Date.now() - start > 5000) throw new Error('timed out waiting for ' + what + '; got: ' + stdout.text.slice(0, 200));
    await new Promise(r => setTimeout(r, 20));
  }
}

test('the account-add screen renders in the real Ink components', async () => {
  const React = (await import('react')).default;
  const {render} = await import('ink');
  const {Controller} = await import('../src/ui/controller.mjs');
  const {Live} = await import('../src/ui/view.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {cwd: process.cwd(), mode: 'default', session: {id: 'preview', turns: 0}, ctx: {readFiles: new Set()}, client: {status: 'demo'}, agentLimits: {concurrent: 4, perTurn: 0}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  ctrl.set({addFlow: {lines: ['追加するアカウントの名前', 'Muse にログインしているメールアドレス'], busy: '認証コードを送っています'}});
  const stdout = new EventEmitter(); Object.assign(stdout, {columns: 100, rows: 40, isTTY: false, text: ''});
  stdout.write = data => { stdout.text += data; return true; };
  const app = render(React.createElement(Live, {s: ctrl.get(), ctrl, W: 99}), {stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
  // Cleanup in finally (t3 #19): an assertion failure used to skip unmount
  // and the flash timer, leaving Ink mounted into the next test.
  try {
    await waitForText(stdout, /アカウントを追加しています…/, 'the add-screen frame');
    assert.match(stdout.text, /アカウントを追加/);
    assert.match(stdout.text, /追加するアカウントの名前/);
    assert.match(stdout.text, /認証コードを送っています/);
    assert.match(stdout.text, /アカウントを追加しています…/, 'the composer hint is the add one, not the chat one');
    assert.ok(!stdout.text.includes('何をしますか'), 'the chat placeholder never shows on the add screen');
  } finally { try { app.unmount(); } catch {} clearTimeout(ctrl.flashTimer); }
});

test('on the add screen, a pending question makes the composer say what to do', async () => {
  const React = (await import('react')).default;
  const {render} = await import('ink');
  const {Controller} = await import('../src/ui/controller.mjs');
  const {Live} = await import('../src/ui/view.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {cwd: process.cwd(), mode: 'default', session: {id: 'preview', turns: 0}, ctx: {readFiles: new Set()}, client: {status: 'demo'}, agentLimits: {concurrent: 4, perTurn: 0}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  ctrl.set({addFlow: {lines: ['追加するアカウントの名前'], busy: null}, promptFor: {resolve() {}, reject() {}, message: '追加するアカウントの名前'}});
  const stdout = new EventEmitter(); Object.assign(stdout, {columns: 100, rows: 40, isTTY: false, text: ''});
  stdout.write = data => { stdout.text += data; return true; };
  const app = render(React.createElement(Live, {s: ctrl.get(), ctrl, W: 99}), {stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
  try {
    await waitForText(stdout, /ここに入力して Enter/, 'the prompt-hint frame');
    assert.match(stdout.text, /ここに入力して Enter/);
    assert.ok(!stdout.text.includes('何をしますか'));
  } finally { try { app.unmount(); } catch {} clearTimeout(ctrl.flashTimer); }
});
