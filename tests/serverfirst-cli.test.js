'use strict';
// Server-first CLI dispatch (bin/muser.js) and view-state parity.
// The bin runs as a subprocess on paths that stop at the terminal check —
// before any server spawn or network — with HOME / LOCALAPPDATA pointed at
// scratch dirs and MUSER_SERVER_FILE naming a scratch discovery file, so
// the resident server is never contacted. The parity half feeds a
// RemoteController a snapshot carrying the fields the server-first wire
// added (promptFor / addFlow / accountReserved / menu side+group) and
// checks the state both views (fullscreen and classic read the same
// Controller-shaped state) receive intact.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
function scratchEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-sf-cli-'));
  return {dir, env: {
    MUSER_LANG: 'en', MUSER_CLIENT: '', MUSER_DIRECT: '',
    USERPROFILE: dir, HOME: dir, LOCALAPPDATA: dir,
    MUSER_SERVER_FILE: path.join(dir, 'server.json'),
    ...extra,
  }};
}
const runBin = (args, env) => spawnSync(process.execPath, [BIN, ...args],
  {encoding: 'utf8', timeout: 30000, env: {...process.env, ...env}});

test('sf-cli: the default entry is server-first (terminal check first, no server spawned without a TTY)', () => {
  const {dir, env} = scratchEnv();
  const r = runBin(['fix', 'the', 'bug'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Interactive mode needs a terminal/);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false, 'no discovery file was written and no server was started');
});

test('sf-cli: --direct goes straight to the standalone entry', () => {
  const {env} = scratchEnv();
  const r = runBin(['--direct', 'fix', 'the', 'bug'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Interactive mode needs a terminal/);
  assert.doesNotMatch(r.stderr, /--direct is only/);
});

test('sf-cli: --client and --direct refuse each other; --direct refuses subcommands; MUSER_DIRECT does not hijack subcommands', () => {
  const {env} = scratchEnv();
  const both = runBin(['--client', '--direct', 'hi'], env);
  assert.match(both.stderr, /--client and --direct cannot be combined/);
  const sub = runBin(['--direct', 'exec', 'hi'], env);
  assert.match(sub.stderr, /--direct is only/);
  const envSub = runBin(['server', 'status'], scratchEnv({MUSER_DIRECT: '1'}).env);
  assert.doesNotMatch(envSub.stderr, /--direct is only/, 'MUSER_DIRECT=1 leaves subcommands alone');
});

test('sf-cli: MUSER_DIRECT=1 with a prompt takes the standalone entry', () => {
  const {env} = scratchEnv({MUSER_DIRECT: '1'});
  const r = runBin(['fix', 'the', 'bug'], env);
  assert.match(r.stderr, /Interactive mode needs a terminal/);
  assert.doesNotMatch(r.stderr, /--direct is only/);
});

test('sf-cli: --help documents the server-first default and the --direct escape hatch', () => {
  const {env} = scratchEnv();
  const r = runBin(['--help'], env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--direct/);
  assert.match(r.stdout, /not shared with the GUI/);
});

// --- view-state parity (the fs-parity harness's data level) -----------------
function snapshot(patch = {}) {
  return {
    version: '9.9.9', cwd: 'C:\\work', mode: 'default', busy: false, queue: [],
    approval: null, approvalQueue: [], reasonFor: false, limitInput: null, menu: null, question: null,
    todos: [], agents: [], shells: [], focus: null, plan: null,
    account: {id: 'default', label: 'Main'}, muse: {name: 'kaguya'}, spinnerWord: null,
    session: {id: 'sess-1', turns: 3, title: 'Chat'}, clientStatus: 'connected',
    device: {name: 'mizuki CLI (muser)', slot: 2, connected: true}, update: null,
    live: {stream: null, running: null, bangRunning: null,
      status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 0, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}, {id: 2, type: 'user', text: 'hi'}],
    ...patch,
  };
}

test('sf-parity: server-first wire fields reach the shared view state intact (fullscreen and classic read this same state)', async () => {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const snap = snapshot({
    promptFor: {message: '名前を入力してください'},
    addFlow: {lines: ['アカウントを追加します'], busy: null},
    accountReserved: 'Main',
    menu: {id: 'm1', title: 'settings', index: 0, side: true, options: [
      {value: 'a', label: '表示', group: '画面'},
      {value: 'b', label: '言語', group: '画面'},
    ]},
  });
  const client = {
    info: {port: 1, token: 't'}, handlers: null,
    request(method, p) {
      if (method === 'GET' && p.endsWith('/state')) return Promise.resolve({status: 200, json: snap});
      if (method === 'GET' && p.includes('/complete')) return Promise.resolve({status: 200, json: {items: []}});
      return Promise.resolve({status: 202, json: {ok: true}});
    },
    events(id, handlers) { this.handlers = handlers; return () => {}; },
  };
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit: () => {}, onReload: () => {}});
  await ctrl.start();
  try {
    const s = ctrl.get();
    assert.equal(s.promptFor?.message, '名前を入力してください', 'the /account add prompt screen has its question');
    assert.deepEqual(s.addFlow, {lines: ['アカウントを追加します'], busy: null});
    assert.equal(s.accountReserved, 'Main');
    assert.equal(s.menu?.side, true, 'menu paging presence survives for both views');
    assert.equal(s.menu?.options?.[0]?.group, '画面', 'menu genre headings survive for both views');
  } finally { ctrl.stop(); }
});
