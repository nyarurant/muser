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
  assert.equal(update.newer('0.3.1', '0.3.1-dev'), false);
  assert.equal(update.newer('', '0.3.1'), false);
});

test('the check is off by env, by config, and for a git checkout unless forced', t => {
  const pkg = tmp(t), cfg = path.join(tmp(t), 'config.json'), none = path.join(pkg, 'none.json');
  assert.equal(update.enabled({env: {}, configFile: none, root: pkg}), true);
  assert.equal(update.enabled({env: {MUSER_NO_UPDATE_CHECK: '1'}, configFile: none, root: pkg}), false);
  fs.writeFileSync(cfg, JSON.stringify({updateCheck: false}));
  assert.equal(update.enabled({env: {}, configFile: cfg, root: pkg}), false);
  fs.mkdirSync(path.join(pkg, '.git'));
  assert.equal(update.enabled({env: {}, configFile: none, root: pkg}), false, 'npm must not overwrite a dev checkout');
  assert.equal(update.enabled({env: {MUSER_UPDATE_CHECK: '1'}, configFile: none, root: pkg}), true);
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
  const saved = {enabled: update.enabled, latest: update.latest};
  t.after(() => Object.assign(update, saved));
  update.enabled = () => true;
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
  const r = await update.install({timeoutMs: 1000, command: 'ping -n 30 127.0.0.1 >nul'});
  assert.equal(r.ok, false);
  assert.match(r.output, /did not finish in 1 s/);
});

test('/update says "up to date" or "could not check" instead of running npm for nothing', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const saved = {devCheckout: update.devCheckout, latest: update.latest, install: update.install};
  t.after(() => Object.assign(update, saved));
  let installs = 0;
  update.devCheckout = () => false; update.install = async () => { installs++; return {ok: true, output: ''}; };
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
});
