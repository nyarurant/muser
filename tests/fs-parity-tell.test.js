'use strict';
// Parity for the tell addition to the approval box: when a write's file is
// claimed by another muser, the approval call carries tellClaim and both
// renderers (fullscreen drawApproval, classic view.mjs Live) must draw the
// same claimant line. Same harness shape as tests/fs-parity-b5.test.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Live, drawApproval;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Live} = await import('../src/ui/view.mjs'));
  ({drawApproval} = await import('../src/ui/fs/draw/live/approval.mjs'));
});

const CWD = 'C:\\Users\\nyaru\\muser-tell';
const ctrlFor = () => ({
  previewRow: () => null,
  museName: 'kaguya',
  version: '0.3.8',
  agent: {cwd: CWD, constructor: {DEVICE: 'mizuki'}, session: {id: 'abcdef0123456789', title: '', turns: 0}, client: {status: 'demo'}, nodeSlot: null, device: {connected: true}},
  slashIndex: () => 0,
  atIndex: () => 0,
});
const liveReact = s => W => parity.reactLines(h(Live, {s, ctrl: ctrlFor(), W}), W);
const check = (name, s, exceptions = []) => {
  const used = parity.checkParity({name, react: liveReact(s), draw: W => drawApproval(s, parity.baseCtx(W, {ctrl: ctrlFor()})), exceptions});
  assert.equal(used.length, exceptions.length);
};
const base = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}};

test('approval: a tellClaim line draws the same in fullscreen and classic', () => {
  const s = {...base, approval: {call: {command: 'code.edit', summary: 'src/shared.txt', tellClaim: {name: 'android-ui', file: 'C:\\Users\\nyaru\\muser-tell\\src\\shared.txt', pid: 1234}}, preview: {diff: [{t: '+', n: 1, l: 'new'}]}, options: [{label: 'はい'}, {label: 'いいえ'}], index: 0}};
  check('approval tellClaim with diff', s);
});
test('approval: tellClaim together with the outside warning', () => {
  const s = {...base, approval: {call: {command: 'code.write', summary: 'outside.txt', tellClaim: {name: 'theme-work'}}, outside: true, options: [{label: 'はい'}], index: 0}};
  check('approval tellClaim outside', s);
});
