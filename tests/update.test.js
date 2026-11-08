'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const update = require('../src/update');

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-update-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

test('newer compares x.y.z and never offers a pre-release', () => {
  assert.equal(update.newer('0.3.2', '0.3.1'), true);
  assert.equal(update.newer('0.10.0', '0.9.9'), true, 'numeric, not string order');
  assert.equal(update.newer('1.0.0', '0.99.0'), true);
  assert.equal(update.newer('0.3.1', '0.3.1'), false);
  assert.equal(update.newer('0.3.0', '0.3.1'), false);
  assert.equal(update.newer('0.4.0-beta.1', '0.3.1'), false);
  // Audit #227: the release IS newer than its own pre-release (semver orders a
  // pre-release before the release); stripping b's suffix used to hide it, so a
  // 0.4.0-beta user was never offered 0.4.0. '-dev' is a pre-release suffix too.
  assert.equal(update.newer('0.4.0', '0.4.0-beta'), true);
  assert.equal(update.newer('0.4.0', '0.4.0-beta.1'), true);
  assert.equal(update.newer('0.3.1', '0.3.1-dev'), true);
  assert.equal(update.newer('0.4.0', '0.4.0'), false);
  assert.equal(update.newer('', '0.3.1'), false);
});

test('the check is off by env, by config, and for a git checkout even when forced', t => {
  const pkg = tmp(t), cfg = path.join(tmp(t), 'config.json'), none = path.join(pkg, 'none.json');
  assert.equal(update.enabled({env: {}, configFile: none, root: pkg}), true);
  assert.equal(update.enabled({env: {MUSER_NO_UPDATE_CHECK: '1'}, configFile: none, root: pkg}), false);
  fs.writeFileSync(cfg, JSON.stringify({updateCheck: false}));
  assert.equal(update.enabled({env: {}, configFile: cfg, root: pkg}), false);
  fs.mkdirSync(path.join(pkg, '.git'));
  assert.equal(update.enabled({env: {}, configFile: none, root: pkg}), false, 'npm must not overwrite a dev checkout');
  // Wave 7 spec update: a dev checkout is NEVER checked, not even when the
  // check is forced with MUSER_UPDATE_CHECK=1 — the forced check used to
  // return true here, the footer then offered /update, and /update refused
  // as development-only, a notice that could never be acted on. The
  // dev-checkout gate now wins over the env opt-in (this expectation was
  // `true` before wave 7).
  assert.equal(update.enabled({env: {MUSER_UPDATE_CHECK: '1'}, configFile: none, root: pkg}), false, 'forced check still off in a dev checkout');
  // Audit #228: the env opt-in also wins over a saved "updateCheck": false (it used
  // to be checked only against the dev-checkout gate, so the escape hatch did nothing
  // for the users who had turned the check off in /settings). Wave 7: this is
  // now exercised on a NON-dev root — with the .git above present, the dev
  // gate (not the config) is what would answer, and it answers false.
  const pkg2 = tmp(t);
  assert.equal(update.enabled({env: {MUSER_UPDATE_CHECK: '1'}, configFile: cfg, root: pkg2}), true, 'env opt-in beats the saved off');
  assert.equal(update.enabled({env: {MUSER_UPDATE_CHECK: '1', MUSER_NO_UPDATE_CHECK: '1'}, configFile: none, root: pkg}), false, 'the explicit off still wins over the opt-in');
});

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.mode = 'default'; this.cwd = process.cwd(); this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

test('at start the footer says it is checking, then shows a newer version or nothing', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const saved = {enabled: update.enabled, latest: update.latest, recentCheck: update.recentCheck, recordCheck: update.recordCheck};
  t.after(() => Object.assign(update, saved));
  update.enabled = () => true;
  // Wave 12: the throttle record is stubbed off here — this test exercises the
  // live check itself; throttling has its own tests (audit-cli-w12).
  update.recentCheck = () => null; update.recordCheck = () => {};
  const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}});

  let release; update.latest = () => new Promise(r => { release = r; });
  const p = ctrl.checkUpdate();
  assert.deepEqual(ctrl.get().update, {checking: true});
  release('0.3.2'); await p;
  assert.deepEqual(ctrl.get().update, {latest: '0.3.2'});

  update.latest = async () => '0.3.1';
  await ctrl.checkUpdate();
  assert.equal(ctrl.get().update, null, 'already the latest');

  update.latest = async () => { throw new Error('offline'); };
  await ctrl.checkUpdate();
  assert.equal(ctrl.get().update, null, 'a failed check just clears the footer');
});

test('a stuck npm is stopped, so /update can be tried again', async () => {
  // Cross-platform hang fixture (the old 'ping -n 30' is Windows-only): Node itself
  // sleeping for 30 s, stopped by install()'s 1 s timeout long before that. The bare
  // 'node' is deliberate: install() runs the command through cmd.exe /c, and a quoted
  // process.execPath does not survive that spawn (Node escapes the quotes and cmd
  // rejects them; unquoted, the path breaks on the space in 'Program Files').
  const sleeper = 'node -e setTimeout(function(){},30000)';
  const r = await update.install({timeoutMs: 1000, command: sleeper});
  assert.equal(r.ok, false);
  // Wave 6 wording update: install() timeouts are worded in Japanese now
  // (was the English 'npm did not finish in 1 s and was stopped').
  assert.match(r.output, /npm が 1 秒で終わらなかったので止めました/);
});

test('/update says "up to date" or "could not check" instead of running npm for nothing', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const saved = {devCheckout: update.devCheckout, latest: update.latest, install: update.install, recentCheck: update.recentCheck, recordCheck: update.recordCheck};
  t.after(() => Object.assign(update, saved));
  let installs = 0; const installArgs = [];
  update.recentCheck = () => null; update.recordCheck = () => {};
  update.devCheckout = () => false; update.install = async (opts) => { installs++; installArgs.push(opts); return {ok: true, output: '', installedVersion: opts?.version}; };
  const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}});
  const last = () => ctrl.get().entries.at(-1).lines.join(' ');
  update.latest = async () => '0.3.1';
  await ctrl.runUpdate();
  assert.match(last(), /最新版です/); assert.equal(installs, 0);
  update.latest = async () => { throw new Error('offline'); };
  await ctrl.runUpdate();
  assert.match(last(), /確認できませんでした（offline）/); assert.equal(installs, 0);
  update.latest = async () => '0.4.0';
  await ctrl.runUpdate();
  assert.match(last(), /v0\.4\.0 に更新しました/); assert.equal(installs, 1);
  // Wave 12: the checked version is passed to install(), pinned — not @latest.
  assert.deepEqual(installArgs, [{version: '0.4.0'}]);
  // Wave 12: the completion guidance names this folder's previous conversation
  // and its ID (the FakeAgent session id is 'x'; this window has no onReload,
  // so it takes the resident-Server wording with `muser resume`).
  assert.match(last(), /このフォルダーの直前の会話/); assert.match(last(), /muser resume x/);
});
