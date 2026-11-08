'use strict';
// 依頼 SC: diagnostics for the "Edge login window never opens" failure.
// waitForPort is exercised with a fake Edge process (an EventEmitter, no real
// Edge) and a throwaway profile folder, in the style of tests/fix2-login.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

const {waitForPort, edgeLogPathFor, pruneEdgeLogs, appendLoginDiag, loginLogsDir} = require('../src/login');
const store = require('../src/secure-store');

function tmpProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-login-diag-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const writePort = (profile, port) => fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), String(port) + '\n/devtools/browser/x');

test('login-diag waitForPort: a port file that appears late is returned, and diag records when', async t => {
  const profile = tmpProfile(t);
  const diag = {};
  const proc = new EventEmitter();
  const timer = setTimeout(() => writePort(profile, 9333), 300);
  t.after(() => clearTimeout(timer));
  const started = Date.now();
  const port = await waitForPort(5000, profile, {proc, diag, edgeLogPath: 'X:\\diag\\edge-test.log'});
  assert.equal(port, 9333);
  assert.ok(Date.now() - started >= 250, 'it actually waited for the late file');
  assert.equal(diag.portAppeared, true);
  assert.ok(diag.portAppearedAt && !Number.isNaN(Date.parse(diag.portAppearedAt)), 'appearance time recorded: ' + diag.portAppearedAt);
  assert.equal(proc.listenerCount('exit'), 0, 'exit listener removed after success');
  assert.equal(proc.listenerCount('error'), 0, 'error listener removed after success');
});

test('login-diag waitForPort: no port file within the timeout fails with the timeout reason and the Edge log path', async t => {
  const profile = tmpProfile(t);
  const diag = {};
  const started = Date.now();
  await assert.rejects(
    waitForPort(600, profile, {proc: new EventEmitter(), diag, edgeLogPath: 'X:\\diag\\edge-test.log'}),
    err => {
      assert.match(err.message, /Edge のログイン窓を開けませんでした。/);
      assert.match(err.message, /応答がありませんでした/);
      assert.match(err.message, /edge-test\.log/, 'the Edge log path is named');
      assert.equal(err.reasonKind, 'timeout');
      return true;
    });
  assert.ok(Date.now() - started >= 550, 'it waited out the timeout');
  assert.equal(diag.portAppeared, undefined, 'no appearance was recorded');
});

test('login-diag waitForPort: Edge exiting first (delegation) fails at once with the exit code, not after the timeout', async t => {
  const profile = tmpProfile(t);
  const diag = {};
  const proc = new EventEmitter();
  const started = Date.now();
  const waiting = waitForPort(20000, profile, {proc, diag, edgeLogPath: 'X:\\diag\\edge-delegated.log'});
  setTimeout(() => proc.emit('exit', 0, null), 50);
  await assert.rejects(waiting, err => {
    assert.match(err.message, /Edge のログイン窓を開けませんでした。/);
    assert.match(err.message, /Edge がすぐ終了しました（終了コード 0）/);
    assert.match(err.message, /edge-delegated\.log/);
    assert.equal(err.reasonKind, 'exited');
    assert.equal(err.exitCode, 0);
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'failed fast, well before the 20 s timeout');
  assert.equal(diag.edgeExited, true);
  assert.equal(diag.exitCode, 0);
});

test('login-diag waitForPort: a spawn error fails at once with its message as the reason', async t => {
  const profile = tmpProfile(t);
  const proc = new EventEmitter();
  const started = Date.now();
  const waiting = waitForPort(20000, profile, {proc, edgeLogPath: 'X:\\diag\\edge-spawn.log'});
  setTimeout(() => proc.emit('error', new Error('spawn msedge.exe ENOENT')), 50);
  await assert.rejects(waiting, err => {
    assert.match(err.message, /Edge を起動できませんでした（spawn msedge\.exe ENOENT）/);
    assert.match(err.message, /edge-spawn\.log/);
    assert.equal(err.reasonKind, 'spawn-error');
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'failed fast');
});

test('login-diag waitForPort: without a process it keeps the old behaviour (late file works, absent file times out in detail)', async t => {
  const profile = tmpProfile(t);
  setTimeout(() => writePort(profile, 9444), 200);
  assert.equal(await waitForPort(5000, profile), 9444);
  const empty = tmpProfile(t);
  await assert.rejects(waitForPort(400, empty), /応答がありませんでした/);
});

test('login-diag helpers: the Edge log lives under <store.DIR>/logs (outside the profile) and pruning keeps the newest 10', t => {
  assert.equal(loginLogsDir(), path.join(store.DIR, 'logs'));
  const p = edgeLogPathFor(new Date('2026-11-07T11:13:29.000Z'), 4242, loginLogsDir());
  assert.equal(path.dirname(p), loginLogsDir());
  assert.match(path.basename(p), /^edge-2026-11-07T11-13-29-000Z-4242\.log$/);
  const dir = tmpProfile(t);
  for (let i = 0; i < 12; i++) {
    const f = path.join(dir, 'edge-2026-01-01T00-00-' + String(i).padStart(2, '0') + '-1.log');
    fs.writeFileSync(f, 'x');
    const when = new Date(2026, 0, 1, 0, 0, i);
    fs.utimesSync(f, when, when);
  }
  fs.writeFileSync(path.join(dir, 'login-diag.log'), 'keep me');
  pruneEdgeLogs(dir, 10);
  const left = fs.readdirSync(dir).filter(n => n.startsWith('edge-')).sort();
  assert.equal(left.length, 10);
  assert.ok(!left.includes('edge-2026-01-01T00-00-00-1.log') && !left.includes('edge-2026-01-01T00-00-01-1.log'), 'the two oldest are gone: ' + left.join(','));
  assert.ok(left.includes('edge-2026-01-01T00-00-11-1.log'), 'the newest survives');
  assert.ok(fs.existsSync(path.join(dir, 'login-diag.log')), 'pruning never touches the diag log');
});

test('login-diag helpers: appendLoginDiag writes one JSON line per attempt and trims to 200 lines, with no secret-shaped fields', t => {
  const dir = tmpProfile(t);
  appendLoginDiag({ts: '2026-11-07T00:00:00.000Z', edgePid: 111, profile: 'P', reusedLeftover: false, portAppeared: false, edgeExited: true, exitCode: 0, outcome: 'failed'}, dir);
  let lines = fs.readFileSync(path.join(dir, 'login-diag.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.edgePid, 111);
  assert.equal(rec.exitCode, 0);
  assert.ok(!/cookie|token|password/i.test(lines[0]), 'no secret-shaped keys or values');
  for (let i = 0; i < 205; i++) appendLoginDiag({n: i}, dir);
  lines = fs.readFileSync(path.join(dir, 'login-diag.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 200, 'trimmed to the newest 200 lines');
  assert.equal(JSON.parse(lines[lines.length - 1]).n, 204, 'the newest line survives');
});
