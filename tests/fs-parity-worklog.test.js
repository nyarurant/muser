'use strict';
// Parity tests for the work log's on-screen surfaces (design §1): the two
// /settings rows (作業ログを残す / 作業ログの保持日数) inside a settings-style
// menu, and the /worklog timeline shown as a note. Both must draw the same
// in the fullscreen renderer (src/ui/fs/draw) and the classic view
// (src/ui/view.mjs). Written in the fs-parity style: the React side is the
// truth, the draw side must match it line for line.
//
// Env comes FIRST: both sides must colourise the same way (see
// tests/fs-parity.test.js).
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Live, Entry, drawEntry, drawMenu;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Live, Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawMenu} = await import('../src/ui/fs/draw/live/menu.mjs'));
});

const CWD = 'C:\\Users\\nyaru\\muser-worklog';
const ctrlFor = () => ({
  previewRow: () => null,
  museName: 'kaguya',
  version: '0.3.8',
  agent: {cwd: CWD, constructor: {DEVICE: 'mizuki'}, session: {id: 'abcdef0123456789', title: '', turns: 0}, client: {status: 'demo'}, nodeSlot: null, device: {connected: true}},
  slashIndex: () => 0,
  atIndex: () => 0,
});

// --- the /settings rows, in a settings-style menu ---------------------------
// The rows are the exact label/desc/group the controller's settingsMenu
// builds for the worklog switch and the retention-days number.
const menuCases = [
  {name: 'worklog settings: switch selected', index: 0},
  {name: 'worklog settings: days selected', index: 1},
];
for (const c of menuCases) {
  test(c.name, () => {
    const s = {text: '', pos: 0, mode: 'default', agents: [], todos: [], focus: {}, menu: {title: '設定', index: c.index, options: [
      {value: 'worklog', group: '作業の進め方', label: '作業ログを残す', desc: 'オン'},
      {value: 'worklogDays', group: '作業の進め方', label: '作業ログの保持日数', desc: '30 日'},
      {value: 'bell', group: '通知と更新', label: '承認・完了時のベル', desc: 'オン'},
    ]}};
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Live, {s, ctrl: ctrlFor(), W}), W),
      draw: W => drawMenu(s, parity.baseCtx(W, {ctrl: ctrlFor()})),
    });
    assert.equal(used.length, 0);
  });
}

// --- the /worklog timeline, as a note ---------------------------------------
// The lines are Worklog.format's output for a conversation holding every
// event kind, under the controller's header line.
const {Worklog} = require('../src/worklog');
const entries = [
  {v: 1, at: '2026-11-07T06:40:00.000Z', session: 's1', event: 'turn', agent: 'main', text: '作業ログを作って'},
  {v: 1, at: '2026-11-07T06:40:05.000Z', session: 's1', event: 'tool', command: 'system.run', summary: 'npm test', ok: true, exitCode: 0, ms: 1234},
  {v: 1, at: '2026-11-07T06:40:09.000Z', session: 's1', event: 'edit', path: 'src/worklog.js', added: 322, removed: 0},
  {v: 1, at: '2026-11-07T06:41:00.000Z', session: 's1', event: 'tool', command: 'code.read', summary: 'missing.txt', ok: false},
  {v: 1, at: '2026-11-07T06:41:30.000Z', session: 's1', event: 'gap', dropped: 2, error: 'EACCES: permission denied'},
  {v: 1, at: '2026-11-07T06:42:00.000Z', session: 's1', event: 'reply', agent: 'main', text: '作りました。これは長い返事の行です。幅が狭い画面では折り返されますが、fullscreen でも classic でも同じ折り返しになるはずです。'},
];
const noteCases = [
  {name: 'worklog note: timeline', e: {type: 'note', lines: ['この会話の作業ログ（最新 6 件）:', ...Worklog.format(entries)]}},
  {name: 'worklog note: empty log message', e: {type: 'note', lines: ['この会話の作業ログはまだありません。']}},
];
for (const c of noteCases) {
  test(c.name, () => {
    const used = parity.checkParity({
      name: c.name,
      react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
      draw: W => drawEntry(c.e, parity.baseCtx(W)),
    });
    assert.equal(used.length, 0);
  });
}
