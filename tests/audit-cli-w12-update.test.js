'use strict';
// audit-cli wave 12 — the /update path end to end (findings B4/C7/D1/E2 of the
// wave-12 E audit):
//  (1) /update installs the version it checked, pinned — never the floating
//      @latest; the completion note names the version that actually landed
//      (install()'s read-back), and an install whose version cannot be read
//      back (a broken package) is a failure, not a success.
//  (2) The completion note's resume guidance says the conversation resumed
//      is this folder's previous one, and includes its ID when there is one.
//  (3) The automatic (startup) check is throttled through
//      ~/.muser/update-check.json: 6 h after a successful check, 1 h after a
//      failed one. A manual /update always checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const update = require('../src/update');

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w12-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

class FakeAgent extends EventEmitter {
  constructor(session = {id: 'sess-w12', turns: 1}) {
    super();
    this.mode = 'default'; this.cwd = process.cwd(); this.session = session; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

// Stub the update module the way the other controller tests do, restoring
// everything afterwards. `recent` is what recentCheck() hands back.
function stubUpdate(t, {latest, install, recent = null}) {
  const saved = {devCheckout: update.devCheckout, latest: update.latest, install: update.install, recentCheck: update.recentCheck, recordCheck: update.recordCheck, enabled: update.enabled};
  t.after(() => Object.assign(update, saved));
  const calls = {latest: 0, install: [], recorded: []};
  update.devCheckout = () => false;
  update.enabled = () => true;
  update.recentCheck = typeof recent === 'function' ? recent : () => recent;
  update.recordCheck = (rec) => { calls.recorded.push(rec); };
  update.latest = async () => { calls.latest++; return latest(); };
  if (install) update.install = async (opts) => { calls.install.push(opts); return install(opts); };
  return calls;
}

// ---------- (3) the throttle record ----------

test('w12 throttle: the record round-trips and the windows are 6 h (success) / 1 h (failure)', t => {
  const file = path.join(tmp(t), 'update-check.json');
  const T = 1_700_000_000_000;
  assert.equal(update.recentCheck({file, now: T}), null, 'no file yet: a check is due');
  update.recordCheck({ok: true, latest: '0.4.0', file, now: T});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {checkedAt: T, ok: true, latest: '0.4.0'}, 'the file holds the time and the result');
  assert.deepEqual(update.readCheckRecord({file, now: T}), {checkedAt: T, ok: true, latest: '0.4.0'});
  assert.ok(update.recentCheck({file, now: T + update.RECHECK_SUCCESS_MS - 1}), 'just inside 6 h: still fresh');
  assert.equal(update.recentCheck({file, now: T + update.RECHECK_SUCCESS_MS}), null, 'at 6 h: due again');
  update.recordCheck({ok: false, file, now: T});
  assert.deepEqual(update.readCheckRecord({file, now: T}), {checkedAt: T, ok: false, latest: null});
  assert.ok(update.recentCheck({file, now: T + update.RECHECK_FAILURE_MS - 1}), 'just inside 1 h after a failure: still fresh');
  assert.equal(update.recentCheck({file, now: T + update.RECHECK_FAILURE_MS}), null, 'at 1 h after a failure: due again');
  assert.equal(update.RECHECK_SUCCESS_MS, 6 * 60 * 60 * 1000);
  assert.equal(update.RECHECK_FAILURE_MS, 60 * 60 * 1000);
});

test('w12 throttle: a broken or odd record reads as "no record", never as a fresh check', t => {
  const dir = tmp(t), file = path.join(dir, 'update-check.json');
  const T = 1_700_000_000_000;
  fs.writeFileSync(file, 'not json');
  assert.equal(update.recentCheck({file, now: T}), null);
  fs.writeFileSync(file, JSON.stringify({checkedAt: 'yesterday', ok: true, latest: '0.4.0'}));
  assert.equal(update.recentCheck({file, now: T}), null, 'an unreadable time is no record');
  fs.writeFileSync(file, JSON.stringify({checkedAt: T, ok: true, latest: 'not-a-version'}));
  assert.deepEqual(update.readCheckRecord({file, now: T}), {checkedAt: T, ok: true, latest: null}, 'a bogus recorded version is dropped, the time still counts');
  assert.ok(update.recentCheck({file, now: T + 1000}), 'and the check is still throttled by it');
});

test('w12 throttle: checkUpdate skips a fresh record, replays its footer, and records new checks', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  let recent = {checkedAt: Date.now(), ok: true, latest: '0.4.0'};
  let latestImpl = () => '0.9.9';
  const calls = stubUpdate(t, {latest: () => latestImpl(), recent: () => recent});
  const mk = () => new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}});
  // A fresh successful record offering 0.4.0: no registry call, footer replays it.
  let ctrl = mk();
  assert.equal(await ctrl.checkUpdate(), '0.4.0');
  assert.equal(calls.latest, 0, 'a fresh success record skips the automatic check');
  assert.deepEqual(ctrl.get().update, {latest: '0.4.0'}, 'the recorded newer version still reaches the footer');
  assert.deepEqual(calls.recorded, [], 'a skipped check records nothing new');
  // A fresh failure record: no registry call, footer clears.
  recent = {checkedAt: Date.now(), ok: false, latest: null};
  ctrl = mk();
  assert.equal(await ctrl.checkUpdate(), null);
  assert.equal(calls.latest, 0, 'a fresh failure record skips the automatic check too');
  assert.equal(ctrl.get().update, null);
  // No fresh record: the check runs and its outcome is recorded either way.
  recent = null; latestImpl = () => '0.4.0';
  ctrl = mk();
  assert.equal(await ctrl.checkUpdate(), '0.4.0');
  assert.equal(calls.latest, 1);
  assert.deepEqual(calls.recorded, [{ok: true, latest: '0.4.0'}], 'a successful automatic check is recorded');
  latestImpl = () => { throw new Error('offline'); };
  ctrl = mk();
  assert.equal(await ctrl.checkUpdate(), null);
  assert.deepEqual(calls.recorded, [{ok: true, latest: '0.4.0'}, {ok: false}], 'a failed automatic check is recorded as a failure');
});

test('w12 throttle: a manual /update always checks, even with a fresh record', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const calls = stubUpdate(t, {
    latest: () => '0.4.0',
    install: (opts) => ({ok: true, output: '', installedVersion: opts.version}),
    recent: {checkedAt: Date.now(), ok: true, latest: '0.4.0'},
  });
  const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}, onReload() {}});
  await ctrl.runUpdate();
  assert.equal(calls.latest, 1, '/update asked the registry despite the fresh record');
  assert.equal(calls.install.length, 1);
  assert.deepEqual(calls.recorded, [{ok: true, latest: '0.4.0'}], 'the manual check is recorded too, so later starts can throttle on it');
});

// ---------- (1) pinned install, landed version, broken package ----------

test('w12 /update: installs the checked version pinned and names the version that landed', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const calls = stubUpdate(t, {
    latest: () => '0.4.1',
    // The read-back is what counts: install() reports the version it verified.
    install: () => ({ok: true, output: '', installedVersion: '0.4.1'}),
  });
  const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}, onReload() {}});
  await ctrl.runUpdate();
  assert.deepEqual(calls.install, [{version: '0.4.1'}], 'install() got the checked version — no floating @latest');
  const last = ctrl.get().entries.at(-1).lines.join(' ');
  assert.match(last, /v0\.4\.1 に更新しました/);
  assert.equal(ctrl.updatedVersion, '0.4.1');
});

test('w12 install: a package whose version cannot be read back is not a success', async t => {
  const dir = tmp(t), lockFile = path.join(dir, 'update.lock');
  const broken = await update.install({version: '9.9.9', command: 'echo installing', verifyCommand: 'echo no-version-anywhere', lockFile});
  assert.equal(broken.ok, false, 'exit 0 with an unreadable installed version fails');
  assert.match(broken.output, /入った版を確認できませんでした/);
  const good = await update.install({version: '9.9.9', command: 'echo installing', verifyCommand: 'echo muser-cli@9.9.9', lockFile});
  assert.equal(good.ok, true, good.output);
  assert.equal(good.installedVersion, '9.9.9', 'the verified version rides the result');
});

test('w12 /update: a failed install is not remembered as updated, and a retry runs', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const calls = stubUpdate(t, {
    latest: () => '0.4.0',
    install: () => ({ok: false, output: 'muser-cli の入った版を確認できませんでした。'}),
  });
  const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}, onReload() {}});
  await ctrl.runUpdate();
  const last = () => ctrl.get().entries.at(-1).lines.join(' ');
  assert.match(last(), /更新できませんでした/);
  assert.equal(ctrl.updatedVersion, null, 'a broken install does not latch the "already updated" state');
  await ctrl.runUpdate();
  assert.equal(calls.install.length, 2, 'a second /update retries instead of pointing at a restart');
});

// ---------- (2) resume guidance ----------

test('w12 guidance: the standalone completion names this folder and the conversation ID', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  stubUpdate(t, {latest: () => '0.4.0', install: (opts) => ({ok: true, output: '', installedVersion: opts.version})});
  const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}, onReload() {}});
  await ctrl.runUpdate();
  const last = ctrl.get().entries.at(-1).lines.join(' ');
  assert.match(last, /muser -c で開き直すと、新しい版でこのフォルダーの直前の会話から使えます/);
  assert.match(last, /会話 ID: sess-w12/);
});

test('w12 guidance: without a conversation ID the folder wording stays, the ID goes', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  stubUpdate(t, {latest: () => '0.4.0', install: (opts) => ({ok: true, output: '', installedVersion: opts.version})});
  const ctrl = new Controller({agent: new FakeAgent({turns: 0}), museName: 'm', version: '0.3.1', onExit() {}, onReload() {}});
  await ctrl.runUpdate();
  const last = ctrl.get().entries.at(-1).lines.join(' ');
  assert.match(last, /このフォルダーの直前の会話から使えます/);
  assert.ok(!last.includes('会話 ID'), 'no ID is invented when the session has none');
});

test('w12 guidance: the Server completion resumes this folder conversation, with or without an ID', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  stubUpdate(t, {latest: () => '0.4.0', install: (opts) => ({ok: true, output: '', installedVersion: opts.version})});
  const withId = new Controller({agent: new FakeAgent(), museName: 'm', version: '0.3.1', onExit() {}});
  await withId.runUpdate();
  let last = withId.get().entries.at(-1).lines.join(' ');
  assert.match(last, /このフォルダーの直前の会話の続きから再開するには: muser resume sess-w12/);
  const noId = new Controller({agent: new FakeAgent({turns: 0}), museName: 'm', version: '0.3.1', onExit() {}});
  await noId.runUpdate();
  last = noId.get().entries.at(-1).lines.join(' ');
  assert.match(last, /このフォルダーの直前の会話は、muser -c で開き直すと再開できます/, 'with no ID the guidance falls back to the folder resume instead of vanishing');
});
