'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

// Regression (Focus audit): focusLabel had no 'inactive' entry, so an inactive
// task fell back to the running label 確認中; and 'stopped' reused 中断, which
// en.js maps to 'Interrupt' (the Esc-key verb), rendering 'Focus: Interrupt'.
test('focus labels: inactive is 追跡対象外 and stopped is 中断しました', async () => {
  const React = (await import('react')).default, {render} = await import('ink');
  const {Entry} = await import('../src/ui/view.mjs'), {Controller} = await import('../src/ui/controller.mjs');
  const agent = new EventEmitter();
  Object.assign(agent, {cwd: process.cwd(), mode: 'plan', session: {id: 'preview', turns: 0}, ctx: {readFiles: new Set()}, client: {status: 'demo'}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const show = async focus => {
    const stdout = new EventEmitter(); Object.assign(stdout, {columns: 80, rows: 30, isTTY: false, text: ''}); stdout.write = data => { stdout.text += data; return true; };
    const app = render(React.createElement(Entry, {e: {type: 'focus', focus}, ctrl, W: 79}), {stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
    const start = Date.now();
    while (!stdout.text) { if (Date.now() - start > 5000) throw new Error('timed out waiting for the first frame'); await new Promise(r => setTimeout(r, 20)); }
    app.unmount(); return strip(stdout.text);
  };
  const base = {goal: 'Some task', round: 1, maxRounds: 3, criteria: [{id: 'c1', text: 'Tests pass', status: 'met', evidence: ['e1']}]};
  const inactive = await show({...base, status: 'inactive'});
  assert.match(inactive, /Focus: 追跡対象外/, 'inactive renders its own label');
  assert.doesNotMatch(inactive, /Focus: 確認中/, 'inactive must not fall back to the running label');
  const stopped = await show({...base, status: 'stopped'});
  assert.match(stopped, /Focus: 中断しました/, 'stopped renders the distinct past-tense label');
  assert.doesNotMatch(stopped, /Focus: 中断(?!しました)/, 'stopped must not use the bare Esc-key verb 中断');
});
