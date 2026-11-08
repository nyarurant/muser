'use strict';
// Fix phase 2 (agent A19): c16 Medium findings for src/shells.js,
// src/core/agent-reply.js and src/server/autostart.js (deep audit #133-#143),
// plus fifth audit f2-4 (agent-reply empty status). Each test names its finding.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {execFile} = require('node:child_process');
const {Shells, runOnce, killTreeAsync} = require('../src/shells');
const {waitForReply} = require('../src/core/agent-reply');
const autostart = require('../src/server/autostart');

const wait = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid; child.exitCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}

// ---- shells.js -------------------------------------------------------------

test('#133 (c16#1): cmd commands containing quotes run as written (finding NOT REPRODUCED; behaviour pinned)', async () => {
  const cases = [
    ['echo "hello world"', /"hello world"/],
    ['echo "a & b"', /"a & b"/],
    ['echo "one" "two"', /"one" "two"/],
    ['if "a"=="a" echo yes', /yes/],
    ['"' + process.execPath + '" -e "console.log(40+2)"', /42/],
    ['"' + process.execPath + '" --version', /v\d+\.\d+/],
  ];
  for (const [cmd, want] of cases) {
    const r = await runOnce(cmd, {shell: 'cmd', cwd: process.cwd(), timeout: 15000, maxOut: 60000, clip});
    assert.equal(r.code, 0, cmd + ' -> ' + JSON.stringify(r).slice(0, 160));
    assert.match(r.stdout, want, cmd);
  }
});

test('#136 (c16#4): a throwing onOutput callback does not take the run (or the host) down', async () => {
  const r = await runOnce('Write-Output hello', {cwd: process.cwd(), timeout: 15000, maxOut: 60000, clip, onOutput: () => { throw new Error('display broke'); }});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello/);
});

test('#136 (c16#4): throwing change/finished listeners do not break a tracked shell', async () => {
  const shells = new Shells();
  shells.on('change', () => { throw new Error('ui broke'); });
  shells.on('finished', () => { throw new Error('ui broke'); });
  const child = fakeChild();
  const s = shells.track(child, {command: 'x', cwd: process.cwd()});
  child.stdout.write('some output\n');
  await wait(50);
  assert.match(s.out, /some output/);
  child.emit('close', 0);
  await wait(50);
  assert.equal(s.running, false);
  assert.equal(s.exit, 0);
});

test('#135 (c16#3): killTreeAsync kills a live tree and reports a dead pid honestly', async () => {
  assert.equal(await killTreeAsync(999999), false, 'a pid that is already gone is not a kill');
  const shells = new Shells();
  const s = shells.start('Start-Sleep -Seconds 60', {cwd: process.cwd()});
  assert.equal(await killTreeAsync(s.pid), true);
  for (let i = 0; i < 40 && s.running; i++) await wait(250);
  assert.equal(s.running, false, 'the async kill stopped the shell');
});

test('#135 (c16#3): killAll stops live shells through the async path and marks them stopped', async () => {
  const shells = new Shells();
  const s = shells.start('Start-Sleep -Seconds 60', {cwd: process.cwd()});
  shells.killAll();
  for (let i = 0; i < 40 && s.running; i++) await wait(250);
  assert.equal(s.running, false);
  assert.equal(s.stopped, true, 'stopped is marked once the async kill lands');
});

// ---- agent-reply.js ----------------------------------------------------------

const ev = (id, text, extra = {}) => ({message_id: id, role: 'assistant', display_text: text, seq: 1, ...extra});
function replyClient({status = 'completed', events = [], historyError = null, detailError = null} = {}) {
  const c = new EventEmitter();
  c.history = async () => { if (historyError) throw historyError; return {chat_events: typeof events === 'function' ? events() : events}; };
  c.request = async () => { if (detailError) throw detailError; return {session: {status: typeof status === 'function' ? status() : status}}; };
  return c;
}
const ropts = {sessionId: 's1', pollMs: 20, settleMs: 0, timeoutMs: 4000};

test('#137 (c16#9): a FAILED detail status ends the wait even when history() keeps failing', async () => {
  const client = replyClient({status: 'failed', historyError: new Error('session gone')});
  const w = waitForReply({client, ...ropts});
  w.accept('');
  await assert.rejects(w.promise, /作業が終了しました \(failed\)/, 'the FAILED verdict survives the history failure (before: polled on to a misleading timeout)');
});

test('#137 (c16#9): a finished reply is adopted even when the detail request keeps failing', async () => {
  const client = replyClient({detailError: new Error('detail down'), events: [ev('m1', 'the reply')]});
  const w = waitForReply({client, ...ropts});
  w.accept('');
  assert.equal((await w.promise).text, 'the reply');
});

test('f2-4 (fifth audit): an empty session status does not hide a completed reply', async () => {
  const client = replyClient({status: '', events: [ev('m1', 'already answered')]});
  const w = waitForReply({client, ...ropts});
  w.accept('');
  assert.equal((await w.promise).text, 'already answered');
});

test('#138 (c16#10): flapping connecting/disconnected cannot reset the reconnect grace clock forever', async () => {
  const client = replyClient({status: 'running'});
  const w = waitForReply({client, ...ropts, timeoutMs: 30000, reconnectGraceMs: 300});
  w.accept('');
  const t0 = Date.now();
  const flap = setInterval(() => {
    client.emit('status', {status: 'connecting'});
    setTimeout(() => client.emit('status', {status: 'disconnected'}), 25);
  }, 60);
  try {
    await assert.rejects(w.promise, /接続が戻らない/);
    assert.ok(Date.now() - t0 < 5000, 'the lost verdict fired near the grace deadline, took ' + (Date.now() - t0) + 'ms (before: every connecting reset it)');
  } finally { clearInterval(flap); }
});

test('#139 (c16#11): after accept(id), a newer replyTo-less message from another turn is not adopted', async () => {
  const client = replyClient({events: [
    ev('m1', 'right thread', {seq: 1, reply_to_message_id: 'want'}),
    ev('m2', 'unrelated turn', {seq: 2}),
  ]});
  const w = waitForReply({client, ...ropts});
  w.accept('want');
  const r = await w.promise;
  assert.equal(r.text, 'right thread', 'the unrelated latest message must not reach the executor');
});

test('#139 (c16#11): a replyTo-less message signalled done on this wait\'s own event stream is still adopted', async () => {
  const client = replyClient({events: [ev('m9', 'signalled reply')]});
  const w = waitForReply({client, ...ropts});
  w.accept('want');
  client.emit('event', {event: 'delta.message_done', session_id: 's1', payload: {session_id: 's1', message_id: 'm9', status: 'completed'}});
  assert.equal((await w.promise).text, 'signalled reply');
});

test('#140 (c16#12): an abandoned wait does not hold the process open (timers are unref\'d)', async t => {
  const script = `
    const {EventEmitter} = require('node:events');
    const {waitForReply} = require('./src/core/agent-reply');
    const c = new EventEmitter();
    c.history = async () => ({chat_events: []});
    c.request = async () => ({session: {status: 'running'}});
    const w = waitForReply({client: c, sessionId: 's1', timeoutMs: 60000, pollMs: 5000, reconnectGraceMs: 60000});
    w.accept('');
    c.emit('status', {status: 'disconnected'});
    console.log('wait-created');
  `;
  const t0 = Date.now();
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..'), timeout: 20000}, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
  assert.match(out, /wait-created/);
  assert.ok(Date.now() - t0 < 15000, 'the child exited promptly instead of living out the 60 s timers, took ' + (Date.now() - t0) + 'ms');
});

// ---- autostart.js ------------------------------------------------------------

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-autostart-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  return home;
}

test('#141 (c16#15): the VBS launcher is written as BOM\'d UTF-16LE so non-ASCII paths survive wscript', async t => {
  const home = tmpHome(t);
  const run = async () => {};
  const nodePath = 'C:\\Users\\木村\\node.exe', binFile = 'C:\\Users\\木村\\muser\\bin\\muser.js';
  const on = await autostart.setAutostart(true, {binFile, nodePath, home, platform: 'win32', run});
  const bytes = fs.readFileSync(on.vbs);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe], 'UTF-16LE BOM present (wscript parses BOM-less files as ANSI/cp932)');
  const text = bytes.toString('utf16le').replace(/^\ufeff/, '');
  assert.equal(text, autostart.vbsContent(nodePath, binFile, home), 'the script round-trips exactly, Japanese path intact');
});

test('#142 (c16#16): autostart off reports a real removal failure and keeps the launcher', async t => {
  const home = tmpHome(t);
  const okRun = async () => {};
  const on = await autostart.setAutostart(true, {binFile: 'C:\\muser\\bin\\muser.js', home, platform: 'win32', run: okRun});
  assert.ok(fs.existsSync(on.vbs));
  const denied = Object.assign(new Error('schtasks failed'), {stderr: 'ERROR: Access is denied.'});
  const run = async (file) => { if (file === 'schtasks') throw denied; };
  await assert.rejects(() => autostart.setAutostart(false, {binFile: 'x', home, platform: 'win32', run}), /could not remove the scheduled task/);
  assert.ok(fs.existsSync(on.vbs), 'the VBS stays while its task registration remains, so the logon launch still works');
});

test('#142 (c16#16): autostart off treats a missing task/Run value as already off', async t => {
  const home = tmpHome(t);
  const okRun = async () => {};
  const on = await autostart.setAutostart(true, {binFile: 'C:\\muser\\bin\\muser.js', home, platform: 'win32', run: okRun});
  const notFound = Object.assign(new Error('not there'), {stderr: 'ERROR: The system cannot find the file specified.'});
  const run = async () => { throw notFound; };
  const off = await autostart.setAutostart(false, {binFile: 'x', home, platform: 'win32', run});
  assert.equal(off.on, false);
  assert.equal(fs.existsSync(on.vbs), false, 'the launcher is removed once nothing is registered');
});

test('#143 (c16#17): autostart on via task removes a stale Run-key registration (and vice versa)', async t => {
  const home = tmpHome(t);
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); };
  const on = await autostart.setAutostart(true, {binFile: 'C:\\muser\\bin\\muser.js', home, platform: 'win32', run});
  assert.equal(on.via, 'task');
  assert.ok(calls.some(c => c[0] === 'reg' && c[1] === 'delete'), 'the Run-key twin is removed: ' + JSON.stringify(calls));
  // Fallback path: task creation denied (stale elevated task may exist) ->
  // the task is deleted before the Run key is written.
  const calls2 = [];
  const run2 = async (file, args) => {
    calls2.push([file, ...args]);
    if (file === 'schtasks' && args[0] === '/Create') throw Object.assign(new Error('denied'), {stderr: 'ERROR: Access is denied.'});
  };
  const on2 = await autostart.setAutostart(true, {binFile: 'C:\\muser\\bin\\muser.js', home, platform: 'win32', run: run2});
  assert.equal(on2.via, 'run-key');
  const delAt = calls2.findIndex(c => c[0] === 'schtasks' && c[1] === '/Delete');
  const addAt = calls2.findIndex(c => c[0] === 'reg' && c[1] === 'add');
  assert.ok(delAt >= 0 && addAt > delAt, 'the task twin is deleted before the Run key is added: ' + JSON.stringify(calls2));
});
