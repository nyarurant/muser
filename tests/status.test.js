'use strict';
// `muser status` (src/server/status.js): the pure row building/formatting and
// the discovery aggregation, driven with fakes — no real server, no gateway.
// The live end-to-end shape is covered by tests/server.test.js (GuiServer +
// discovery); here the transport steps are injected.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {activityOf, accountLabelOf, buildRows, durationText, formatRow, formatStatus, gatherWindowStatus} = require('../src/server/status');
const discovery = require('../src/server/discovery');

const NOW = 1_800_000_000_000;
const ACCOUNTS = [{id: 'default', label: 'メイン'}, {id: '2', label: 'サブ'}];

test('status: activity precedence — approval over input over working over idle', () => {
  assert.equal(activityOf({busy: false, approval: false}, null), 'idle');
  assert.equal(activityOf({busy: true, approval: false}, null), 'working');
  assert.equal(activityOf({busy: true, approval: true}, null), 'approval', 'the session list alone already separates approval from work');
  assert.equal(activityOf({busy: false, approval: false}, {busy: false, approval: {call: {}}}), 'approval', 'a snapshot approval counts too');
  for (const state of [{menu: {title: 'x'}}, {reasonFor: true}, {limitInput: {key: 'k'}}, {approvalQueue: 2}]) {
    assert.equal(activityOf({busy: true, approval: false}, {busy: true, approval: null, ...state}), 'input', 'waiting on the user outranks busyness: ' + Object.keys(state)[0]);
  }
  assert.equal(activityOf({busy: false, approval: false}, {busy: true, approval: null}), 'working', 'a busy snapshot with no session flags still reads as working');
  assert.equal(activityOf(null, null), 'idle');
});

test('status: account label — own label, then the server account list, then the bare id', () => {
  assert.equal(accountLabelOf({account: '2', accountLabel: '直接のラベル'}, ACCOUNTS), '直接のラベル');
  assert.equal(accountLabelOf({account: '2', accountLabel: null}, ACCOUNTS), 'サブ');
  assert.equal(accountLabelOf({account: 'ghost', accountLabel: null}, ACCOUNTS), 'ghost');
  assert.equal(accountLabelOf({account: null, accountLabel: null}, ACCOUNTS), null);
  assert.equal(accountLabelOf({}, undefined), null);
});

test('status: buildRows joins the session list with the per-conversation snapshots', () => {
  const servers = [{
    kind: 'server', pid: 111, port: 2222, version: '1.0', startedAt: NOW - 60000,
    accounts: ACCOUNTS,
    sessions: [
      {id: 'abcdef01-2345-6789', cwd: 'C:\\a', turns: 3, mode: 'default', busy: true, approval: false, account: '2', accountLabel: null, museName: 'kaguya', createdAt: NOW - 50000, lastUsedAt: NOW - 5000, isDefault: true},
      {id: '99999999-aaaa', cwd: 'C:\\b', turns: 0, mode: 'plan', busy: false, approval: false, account: 'default', accountLabel: null, createdAt: NOW - 40000, lastUsedAt: NOW - 9000, isDefault: false},
    ],
    states: new Map([['abcdef01-2345-6789', {busy: true, approval: null, menu: {title: '選んで'}, live: {turnStart: NOW - 125000}, focus: {status: 'working'}}]]),
  }];
  const rows = buildRows(servers);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].shortId, 'abcdef01');
  assert.equal(rows[0].serverKind, 'server');
  assert.equal(rows[0].pid, 111);
  assert.equal(rows[0].accountLabel, 'サブ', 'resolved through the server account list');
  assert.equal(rows[0].activity, 'input', 'the open menu in the snapshot is a wait on the user, not work');
  assert.equal(rows[0].turnStart, NOW - 125000, 'the live turn start rides the snapshot');
  assert.equal(rows[0].focusStatus, 'working');
  assert.equal(rows[0].isDefault, true);
  assert.equal(rows[1].activity, 'idle');
  assert.equal(rows[1].accountLabel, 'メイン');
  assert.equal(rows[1].turnStart, null, 'no snapshot: no turn start, the row still stands');
  assert.deepEqual(buildRows([]), []);
  assert.deepEqual(buildRows(null), []);
});

test('status: durationText picks the largest whole unit', () => {
  assert.equal(durationText(0), '0 秒');
  assert.equal(durationText(59000), '59 秒');
  assert.equal(durationText(60000), '1 分');
  assert.equal(durationText(59 * 60000), '59 分');
  assert.equal(durationText(60 * 60000), '1 時間');
  assert.equal(durationText(23 * 3600000), '23 時間');
  assert.equal(durationText(24 * 3600000), '1 日');
  assert.equal(durationText(-5000), '0 秒', 'clock skew never goes negative');
});

test('status: formatRow shows state, account, cwd and the timing that fits the state', () => {
  const base = {shortId: 'abcdef01', cwd: 'C:\\a', accountLabel: 'サブ', isDefault: true, focusStatus: null, turnStart: null, lastUsedAt: NOW - 5 * 60000};
  const working = formatRow({...base, activity: 'working', turnStart: NOW - 2 * 60000}, NOW);
  assert.match(working, /^  abcdef01  作業中 \/ 既定 \/ アカウント: サブ  C:\\a  \(経過: 2 分 \/ 最終利用: 5 分前\)$/);
  const approval = formatRow({...base, activity: 'approval'}, NOW);
  assert.match(approval, /承認待ち/);
  assert.doesNotMatch(approval, /経過/, 'a waiting window shows no work elapsed');
  const input = formatRow({...base, activity: 'input', accountLabel: null, isDefault: false}, NOW);
  assert.match(input, /入力待ち/);
  assert.doesNotMatch(input, /アカウント/);
  const focused = formatRow({...base, activity: 'working', focusStatus: '上限で停止'}, NOW);
  assert.match(focused, /Focus: 上限で停止/);
});

test('status: formatStatus groups rows under their server; nothing open is one clear line', () => {
  assert.deepEqual(formatStatus([], NOW), ['開いている窓はありません。']);
  assert.deepEqual(formatStatus([{kind: 'server', pid: 1, port: 2, sessions: []}], NOW), ['開いている窓はありません。'], 'a live server with no conversations is still no windows');
  const lines = formatStatus([
    {kind: 'server', pid: 111, port: 2222, version: '1.0', startedAt: NOW - 60000, sessions: [{id: 'aaaaaaaa-1', cwd: 'C:\\a', busy: false, approval: false, account: null, lastUsedAt: NOW - 60000}]},
    {kind: 'serve', pid: 333, port: 4444, version: '1.0', startedAt: NOW - 30000, sessions: [{id: 'bbbbbbbb-2', cwd: 'C:\\b', busy: true, approval: true, account: null, lastUsedAt: NOW - 1000}]},
  ], NOW);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Muser Server: pid 111 \/ port 2222 \/ version 1\.0 \/ 起動 /);
  assert.match(lines[1], /^  aaaaaaaa  待機中  C:\\a/);
  assert.match(lines[2], /^単独 serve: pid 333 \/ port 4444 \/ version 1\.0 \/ 起動 /);
  assert.match(lines[3], /^  bbbbbbbb  承認待ち  C:\\b/);
});

test('status: gather dedupes the two discovery files, skips dead servers, tolerates a failed state fetch', async () => {
  const serverInfo = {pid: 111, port: 2222, token: 'tok-a'};
  const guiSame = {pid: 111, port: 2222, token: 'tok-a', cwd: 'C:\\a', sessionId: 'aaaaaaaa-1'};
  const probed = [], requested = [];
  const servers = await gatherWindowStatus({
    readServer: () => serverInfo,
    readGui: () => guiSame,
    probe: async info => { probed.push(info.port); return {pid: 111, port: 2222, version: '1.0', startedAt: NOW - 60000, accounts: ACCOUNTS, sessions: [{id: 'aaaaaaaa-1', cwd: 'C:\\a', busy: false, approval: false, account: 'default', accountLabel: null, lastUsedAt: NOW - 60000, isDefault: true}]}; },
    request: async (info, method, p) => { requested.push(p); return {status: 200, json: {busy: false, approval: null, live: {turnStart: 0}}}; },
  });
  assert.deepEqual(probed, [2222], 'gui.json naming the same server is not probed twice');
  assert.deepEqual(requested, ['/api/s/aaaaaaaa-1/state'], 'the snapshot comes from the existing per-conversation route');
  assert.equal(servers.length, 1);
  assert.equal(servers[0].kind, 'server');
  assert.equal(servers[0].states['aaaaaaaa-1'].live.turnStart, 0);

  const mixed = await gatherWindowStatus({
    readServer: () => ({pid: 111, port: 2222, token: 'tok-a'}),
    readGui: () => ({pid: 333, port: 4444, token: 'tok-b'}),
    probe: async info => info.port === 2222 ? null : {pid: 333, port: 4444, version: '1.0', startedAt: NOW, sessions: [{id: 'bbbbbbbb-2', cwd: 'C:\\b', busy: true, approval: false, account: null}]},
    request: async () => { throw new Error('wedged'); },
  });
  assert.equal(mixed.length, 1, 'the dead resident server is skipped, the standalone serve remains');
  assert.equal(mixed[0].kind, 'serve');
  assert.deepEqual(mixed[0].states, {}, 'a failed snapshot fetch leaves the session-list row intact');
  assert.equal(buildRows(mixed)[0].activity, 'working');

  const none = await gatherWindowStatus({readServer: () => null, readGui: () => null, probe: async () => null, request: async () => ({status: 404, json: null})});
  assert.deepEqual(none, []);
  assert.deepEqual(formatStatus(none, NOW), ['開いている窓はありません。']);
});

test('discovery: readGui reads the gui.json shape and rejects anything else', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-status-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'gui.json');
  assert.equal(discovery.readGui(file), null, 'no file yet');
  fs.writeFileSync(file, JSON.stringify({pid: 42, port: 5555, token: 'tok', cwd: 'C:\\a', sessionId: 'x', startedAt: 1}));
  const info = discovery.readGui(file);
  assert.equal(info.port, 5555);
  assert.equal(info.sessionId, 'x', 'the gui-only fields ride along');
  fs.writeFileSync(file, JSON.stringify({pid: 42}));
  assert.equal(discovery.readGui(file), null, 'a file without port/token is not a server');
});
