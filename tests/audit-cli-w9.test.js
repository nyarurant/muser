'use strict';
// Audit-cli wave 9: login/account edge fixes —
//  (1) PcAuth sdkIssuePending: manual-recovery wording + stale-flag clearing
//  (2) clackUi prompts require a terminal; plainUi questions fail on EOF
//  (3) pollLogin: a never-connected poll times out with a network wording
//  (4) pcLogin: the first SDK check retries transient failures twice
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
// Isolate the data folders before any src module loads (pc-auth.test.js pattern).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w9-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w9-home-'));
test.after(() => { for (const d of [process.env.LOCALAPPDATA, process.env.USERPROFILE]) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });
const ROOT = path.join(__dirname, '..');

// ---------- (1) pc-auth sdkIssuePending ----------
const {PcAuth, SDK_ISSUE_PENDING_STALE_MS} = require('../src/core/pc-auth');
function authWith(disk, over = {}) {
  let d = disk;
  const a = new PcAuth({
    load: () => d, save: v => { d = v; },
    request: over.request || (async () => { throw new Error('unexpected request'); }),
    listSdk: over.listSdk || (async () => ({tokens: [], maxActiveTokens: 2})),
    issueSdk: over.issueSdk || (async () => ({token: 'mgst_x', sdkToken: {id: 'id1'}})),
    expectedVm: async () => 'vm1',
    deviceFile: over.deviceFile,
  });
  return {a, disk: () => d};
}

test('w9 (1): a blocked pending flag names the manual recovery (file + delete + retry)', async () => {
  const {a} = authWith({sdkIssuePending: true}, {deviceFile: 'C:\\data\\muser\\device.enc'});
  await assert.rejects(a.start(true), e => {
    assert.match(e.message, /手動で回復するには/);
    assert.ok(e.message.includes('C:\\data\\muser\\device.enc'), 'the device save file is named: ' + e.message);
    assert.match(e.message, /削除してから、もう一度実行してください/);
    assert.match(e.message, /自動で再発行はしません/);
    return true;
  });
  const bare = authWith({sdkIssuePending: true});
  await assert.rejects(bare.a.start(true), /device\.enc/);
});

test('w9 (1): a stale pending flag beside a saved SDK token is cleared and the flow proceeds', async () => {
  const old = Date.now() - SDK_ISSUE_PENDING_STALE_MS - 60000;
  const {a, disk} = authWith({sdkToken: 'mgst_x', sdkIssuePending: true, sdkIssuePendingAt: old});
  const s = await a.start(true);
  assert.equal(s.phase, 'contact', 'proceeded with the saved token');
  assert.equal(disk().sdkIssuePending, false, 'the stale flag was cleared');
  assert.equal(disk().sdkToken, 'mgst_x', 'the token itself was kept');
});

test('w9 (1): a fresh pending flag is not cleared (the in-flight guard still holds)', async () => {
  const {a, disk} = authWith({sdkToken: 'mgst_x', sdkIssuePending: true, sdkIssuePendingAt: Date.now()});
  const s = await a.start(true);
  assert.equal(s.phase, 'contact');
  assert.equal(disk().sdkIssuePending, true, 'a fresh flag survives: another issue may be in flight');
});

test('w9 (1): setting the pending flag stamps it; a successful issue clears both', async () => {
  const {a, disk} = authWith({});
  await a.start(true);
  assert.equal(disk().sdkIssuePending, false);
  assert.equal(disk().sdkToken, 'mgst_x');
  const before = authWith({});
  const origIssue = before.a.issueSdk;
  before.a.issueSdk = async () => { throw new Error('issue died'); };
  await assert.rejects(before.a.start(true), /issue died/);
  assert.equal(before.disk().sdkIssuePending, true);
  assert.equal(typeof before.disk().sdkIssuePendingAt, 'number', 'the pending flag carries its stamp');
  assert.ok(Math.abs(Date.now() - before.disk().sdkIssuePendingAt) < 60000);
  void origIssue;
});

// ---------- (2) clackUi TTY guard + plainUi EOF ----------
test('w9 (2): clackUi ask/confirm/pick throw a clear error without a terminal on stdin', async () => {
  const {clackUi} = require('../src/tui/onboard');
  const was = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    await assert.rejects(clackUi().ask('質問'), /対話入力が必要です。端末から実行してください/);
    await assert.rejects(clackUi().confirm('よいですか'), /対話入力が必要です/);
    await assert.rejects(clackUi().pick('どれ', [{label: 'a'}]), /対話入力が必要です/);
    await assert.rejects(clackUi().password('秘密'), /対話入力が必要です/);
    // The empty-pick error still wins over the TTY error (fix2 c10 #15).
    await assert.rejects(clackUi().pick('どれ', []), /選択肢がありません/);
  } finally { process.stdin.isTTY = was; }
});

test('w9 (2): plainUi ask fails in words when stdin is already at EOF (child)', () => {
  const script = "const {plainUi} = require('./src/pc-login'); (async () => { const ui = plainUi();" +
    " try { const v = await ui.ask('連絡先', {initial: 'saved@example.com'}); console.log('ANSWERED:' + v); }" +
    " catch (e) { console.log('ERRORED:' + e.message); } finally { ui.close(); } })();";
  const r = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: {...process.env, MUSER_LANG: 'ja'}, input: ''});
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('ERRORED:') && out.includes('対話入力が必要です'), 'EOF ask errored instead of answering: ' + out);
  assert.ok(!out.includes('ANSWERED'), 'the remembered initial was not silently used: ' + out);
});

test('w9 (2): plainUi still answers from a pipe that has input, then errors after it ends (child)', () => {
  const script = "const {plainUi} = require('./src/pc-login'); (async () => { const ui = plainUi();" +
    " console.log('ONE:' + await ui.ask('一問目'));" +
    " try { await ui.ask('二問目'); console.log('TWO-ANSWERED'); } catch (e) { console.log('TWO-ERRORED:' + e.message); }" +
    " ui.close(); })();";
  const r = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: {...process.env, MUSER_LANG: 'ja'}, input: 'hello\n'});
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('ONE:hello'), 'the piped line was answered: ' + out);
  assert.ok(out.includes('TWO-ERRORED:') && out.includes('対話入力が必要です'), 'the post-EOF question errored instead of hanging: ' + out);
});

// ---------- (3) pollLogin never-connected wording ----------
const web = require('../src/web');
function stubWeb(t, fetchJson) {
  const saved = {createWeb: web.createWeb, probe: web.probe, jarFromCookies: web.jarFromCookies, saveJar: web.saveJar};
  web.jarFromCookies = cs => cs;
  web.createWeb = () => ({fetchJson});
  web.probe = async () => 'error'; web.saveJar = () => {};
  t.after(() => Object.assign(web, saved));
}
const cookieBrowser = () => ({contexts: () => [{cookies: async () => [{domain: '.muse.ai', name: 's', value: '1'}]}], on: () => {}, isConnected: () => true});

test('w9 (3): a poll that never connects times out with the network wording', async t => {
  const {pollLogin} = require('../src/login');
  stubWeb(t, async () => { throw Object.assign(new Error('fetch failed'), {network: true}); });
  await assert.rejects(pollLogin(cookieBrowser(), {timeoutMs: 250, intervalMs: 40}),
    e => /接続を確認できませんでした。ネットワークを確認してください/.test(e.message) && e.noConnection === true && e.reasonKind === 'poll-timeout');
  stubWeb(t, async () => { throw Object.assign(new Error('timed out'), {timeout: true}); });
  await assert.rejects(pollLogin(cookieBrowser(), {timeoutMs: 250, intervalMs: 40}), /接続を確認できませんでした/);
});

test('w9 (3): a poll that does connect keeps the plain slow-login wording', async t => {
  const {pollLogin} = require('../src/login');
  // The server answers (a plain 4xx = not logged in yet): a slow login.
  stubWeb(t, async () => { throw Object.assign(new Error('nope'), {status: 400}); });
  await assert.rejects(pollLogin(cookieBrowser(), {timeoutMs: 250, intervalMs: 40}),
    e => /ログインが完了する前に時間切れになりました/.test(e.message) && !e.noConnection);
  // The session endpoint answers but the login is incomplete: also a slow login.
  stubWeb(t, async () => ({}));
  await assert.rejects(pollLogin(cookieBrowser(), {timeoutMs: 250, intervalMs: 40}), /時間切れ/);
});

// ---------- (4) pcLogin first SDK check retries ----------
const {pcLogin} = require('../src/pc-login');
let fileSeq = 0;
const nextFile = () => 'w9-sdk-' + (++fileSeq) + '/device.enc';
function sdkWeb(getImpl) {
  const counts = {get: 0};
  const web = {
    sdkRequest: async method => { if (method === 'GET') { counts.get++; return getImpl(counts.get); } return {token: 'mgst_test', sdkToken: {id: 'id1'}}; },
    nativeRequest: async (scope, route) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) return {auth_state: 'as'};
      if (route.endsWith('/confirm_otp')) return {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
      if (route.endsWith('/fetch_vms')) return {vm_list: []};
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  return {web, counts};
}
function plainLoginUi(answers) {
  return {note: () => {}, info: () => {}, close() {}, confirm: async () => true, pick: async () => 0,
    busy: async (_l, fn) => fn(), ask: async () => { const v = answers.shift(); if (v === undefined) throw new Error('no scripted answer'); return v; }};
}

test('w9 (4): transient failures of the first SDK check are retried (up to 2 retries) and the login completes', async () => {
  const {web, counts} = sdkWeb(n => { if (n < 3) throw Object.assign(new Error('fetch failed'), {network: true}); return {tokens: [], maxActiveTokens: 2}; });
  const auth = await pcLogin(web, plainLoginUi(['a@b.c', '111111']), {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  // 3 GETs for the first check (initial attempt + 2 retries, succeeding on
  // the third) + 1 more GET inside auth.start()'s own listSdk call.
  assert.equal(counts.get, 4, 'the first check took 3 attempts; auth.start listed once more');
});

test('w9 (4): a persistent connection failure gives up after 2 retries', async () => {
  const {web, counts} = sdkWeb(() => { throw Object.assign(new Error('timed out'), {timeout: true}); });
  await assert.rejects(pcLogin(web, plainLoginUi(['a@b.c', '111111']), {file: nextFile()}), e => e.timeout === true);
  assert.equal(counts.get, 3, 'no endless retrying');
});

test('w9 (4): a permanent error of the first SDK check is not retried', async () => {
  const {web, counts} = sdkWeb(() => { throw Object.assign(new Error('forbidden'), {status: 403}); });
  await assert.rejects(pcLogin(web, plainLoginUi(['a@b.c', '111111']), {file: nextFile()}), e => e.status === 403);
  assert.equal(counts.get, 1);
});
