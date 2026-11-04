'use strict';
// Audit 2026-11-03, section M (#188-#200): PcAuth / pc-login regression tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// pcLogin falls back to the real secure-store when no store is injected, so
// point every data folder at a throwaway one BEFORE loading any src module —
// the same isolation accounts.test.js uses (t8 #8). `npm test` also isolates
// via tests/setup.mjs, but a bare `node --test tests/pc-auth.test.js` does not.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-pcauth-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-pcauth-home-'));
test.after(() => { for (const d of [process.env.LOCALAPPDATA, process.env.USERPROFILE]) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });
const {PcAuth} = require('../src/core/pc-auth');

function auth(over = {}) {
  let disk = over.disk || {};
  const a = new PcAuth({
    load: () => disk, save: v => { disk = v; },
    request: over.request || (async () => { throw new Error('unexpected request'); }),
    listSdk: over.listSdk || (async () => ({tokens: [], maxActiveTokens: 2})),
    issueSdk: over.issueSdk || (async () => ({token: 'mgst_x', sdkToken: {id: 'id1'}})),
    expectedVm: over.expectedVm || (async () => 'vm1'),
  });
  return {a, disk: () => disk};
}
async function toCode(a) {
  await a.start(true);
  await a.send('a@b.c');
}
const okFlow = {
  request: async (scope, route) => {
    if (route.endsWith('/auth/start')) return {access_token: 'at'};
    if (route.endsWith('/login_options')) return {};
    if (route.endsWith('/send_otp')) return {auth_state: 'as'};
    if (route.endsWith('/confirm_otp')) return {abra_access_token: 'abra', abra_user_id: 'u1'};
    if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
    if (route.endsWith('/fetch_vms')) return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'vt'}]};
    throw new Error('unexpected ' + route);
  },
};

test('#188: malformed JSON shapes fail with stage errors, not bare TypeErrors', async () => {
  {
    const {a} = auth({listSdk: async () => null});
    await assert.rejects(a.start(true), e => !(e instanceof TypeError) && /発行状況を確認できません/.test(e.message));
  }
  {
    const {a} = auth({issueSdk: async () => null});
    await assert.rejects(a.start(true), e => !(e instanceof TypeError) && /発行結果を確認できません/.test(e.message));
  }
  {
    const {a} = auth({disk: {sdkToken: 'mgst_x'}, request: async () => null});
    await a.start(true);
    await assert.rejects(a.send('a@b.c'), e => !(e instanceof TypeError) && /認証を開始できませんでした/.test(e.message));
  }
  {
    const {a} = auth({disk: {sdkToken: 'mgst_x'}, request: async (s, route) => route.endsWith('/confirm_otp') ? null : okFlow.request(s, route)});
    await toCode(a);
    await assert.rejects(a.confirm('123456'), e => !(e instanceof TypeError) && /追加の認証が必要です/.test(e.message));
  }
  {
    const {a} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1'}, request: async (s, route) => route.endsWith('/device_token/mint') ? null : okFlow.request(s, route)});
    await toCode(a);
    await assert.rejects(a.confirm('123456'), e => !(e instanceof TypeError) && /認証情報を取得できませんでした/.test(e.message));
  }
  {
    const {pcLogin} = require('../src/pc-login');
    const web = {sdkRequest: async () => null, nativeRequest: async () => { throw new Error('must not reach'); }, fetchJson: async () => ({})};
    const ui = {info: () => {}, close() {}, ask: async () => 'a@b.c', confirm: async () => true, pick: async () => 0, busy: async (_l, fn) => fn()};
    await assert.rejects(pcLogin(web, ui, {file: 'pc-auth-test-null/device.enc'}), e => !(e instanceof TypeError) && /発行状況を確認できません/.test(e.message));
  }
});

test('#188b: malformed shapes with the wrong field types fail with stage errors, not bare TypeErrors', async () => {
  // #188 covered null responses; the same stages also receive well-formed JSON
  // whose fields have the wrong types (t8 #9).
  {
    const {a} = auth({listSdk: async () => ({tokens: 'x', maxActiveTokens: 2})});
    await assert.rejects(a.start(true), e => !(e instanceof TypeError) && /発行状況を確認できません/.test(e.message));
  }
  {
    const {a} = auth({listSdk: async () => ({tokens: [], maxActiveTokens: '2'})});
    await assert.rejects(a.start(true), e => !(e instanceof TypeError) && /発行状況を確認できません/.test(e.message));
  }
  {
    const {a} = auth({issueSdk: async () => ({token: 42, sdkToken: {id: 'id1'}})});
    await assert.rejects(a.start(true), e => !(e instanceof TypeError) && /発行結果を確認できません/.test(e.message));
  }
  {
    const {a} = auth({issueSdk: async () => ({token: 'not-an-mgst-token', sdkToken: {id: 'id1'}})});
    await assert.rejects(a.start(true), e => !(e instanceof TypeError) && /発行結果を確認できません/.test(e.message));
  }
  {
    const {a} = auth({disk: {sdkToken: 'mgst_x'}, request: async () => ({access_token: 42})});
    await a.start(true);
    await assert.rejects(a.send('a@b.c'), e => !(e instanceof TypeError) && /認証を開始できませんでした/.test(e.message));
  }
  {
    const {a} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1'}, request: async (s, route) => route.endsWith('/device_token/mint') ? {access_token: 42, refresh_token: 'drt'} : okFlow.request(s, route)});
    await toCode(a);
    await assert.rejects(a.confirm('123456'), e => !(e instanceof TypeError) && /認証情報を取得できませんでした/.test(e.message));
  }
});

test('#190: a vm() failure after the pair is saved does not un-succeed the login', async () => {
  const {a, disk} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1'}, request: async (s, route) => {
    if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('boom'), {status: 500});
    return okFlow.request(s, route);
  }});
  await toCode(a);
  const s = await a.confirm('123456');
  assert.equal(s.phase, 'authenticated');
  assert.equal(disk().device.access_token, 'dat', 'the minted pair was persisted');
});

test('#193: start() drops a device pair that belongs to another account and logs in fresh', async () => {
  const {a, disk} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1', device: {access_token: 'old', refresh_token: 'r:1'}},
    request: async (s, route) => {
      if (route.endsWith('/fetch_vms')) return {vm_list: [{vm_id: 'someone-else', vm_auth_token: 'vt'}]};
      throw new Error('unexpected ' + route);
    }});
  const s = await a.start(true);
  assert.equal(s.phase, 'contact', 'fell through to a fresh login instead of failing forever');
  assert.equal(disk().device, undefined, 'the mismatched pair was dropped');
});

test('#193: a transient vm() failure keeps the saved pair', async () => {
  const pair = {access_token: 'old', refresh_token: 'r:1'};
  const {a, disk} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1', device: pair},
    request: async () => { throw Object.assign(new Error('fetch failed'), {network: true}); }});
  await assert.rejects(a.start(true), e => e.network === true);
  assert.deepEqual(disk().device, pair, 'a network blip must not delete a working registration');
});

test('#194: a non-device persist does not overwrite a newer pair saved by another window', async () => {
  let disk = {sdkToken: 'mgst_x', nodeId: 'n-old', device: {access_token: 'a1', refresh_token: 'r:1', access_token_saved_at: 100}};
  const mk = () => new PcAuth({load: () => disk, save: v => { disk = v; }, request: async () => {}, listSdk: async () => {}, issueSdk: async () => {}, expectedVm: async () => 'vm1'});
  const stale = mk();
  const other = mk();
  other.persist({device: {access_token: 'a2', refresh_token: 'r:2', access_token_saved_at: 200}});
  stale.persist({nodeId: 'n-new'});
  assert.equal(disk.device.access_token, 'a2', 'the newer pair survived');
  assert.equal(disk.nodeId, 'n-new', 'the stale window’s own update still landed');
});

test('#195: a failed save of an issued token keeps it in memory; a retry does not re-issue', async () => {
  let disk = {}, issues = 0, failTokenSave = true;
  const a = new PcAuth({load: () => disk,
    save: v => { if (failTokenSave && v.sdkToken) throw new Error('DPAPI unavailable'); disk = v; },
    request: async () => {}, listSdk: async () => ({tokens: [], maxActiveTokens: 2}),
    issueSdk: async () => { issues++; return {token: 'mgst_new', sdkToken: {id: 'id9'}}; },
    expectedVm: async () => 'vm1'});
  await assert.rejects(a.start(true), /DPAPI/);
  assert.equal(a.saved.sdkToken, 'mgst_new', 'the issued token is retained in memory despite the save failure');
  failTokenSave = false;
  const s = await a.start(true);
  assert.equal(s.phase, 'contact');
  assert.equal(issues, 1, 'the token was not issued twice');
  assert.equal(disk.sdkToken, 'mgst_new');
});

test('#196: a login_options failure clears the half-started login; the next send starts over', async () => {
  let starts = 0, options = 0;
  const {a} = auth({disk: {sdkToken: 'mgst_x'}, request: async (s, route) => {
    if (route.endsWith('/auth/start')) { starts++; return {access_token: 'at' + starts}; }
    if (route.endsWith('/login_options')) { options++; if (options === 1) throw Object.assign(new Error('bad state'), {status: 400}); return {}; }
    if (route.endsWith('/send_otp')) return {auth_state: 'as'};
    throw new Error('unexpected ' + route);
  }});
  await a.start(true);
  await assert.rejects(a.send('a@b.c'), /bad state/);
  const s = await a.send('a@b.c');
  assert.equal(s.phase, 'code');
  assert.equal(starts, 2, 'auth/start ran again instead of reusing the dead token');
  assert.equal(options, 2, 'login_options ran again');
});

test('#197: the vm cache is not served when expectedVm() cannot be determined', async () => {
  let fail = false;
  const {a} = auth({disk: {nodeId: 'n', sdkToken: 's', device: {access_token: 'tok', refresh_token: 'r:1'}},
    expectedVm: async () => { if (fail) throw new Error('session unreadable'); return 'vm1'; },
    request: async (s, route) => { if (route.endsWith('/fetch_vms')) return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'x'}]}; throw new Error('unexpected ' + route); }});
  assert.equal((await a.vm()).vm_id, 'vm1');
  fail = true;
  await assert.rejects(a.vm(), /session unreadable|ログインしてください/, 'no unchecked VM from the undefined-keyed cache');
});

test('#198: a malformed fetch_vms body does not burn the single-use refresh token', async () => {
  let refreshes = 0;
  const {a} = auth({disk: {nodeId: 'n', sdkToken: 's', device: {access_token: 'tok', refresh_token: 'r:1'}},
    request: async (s, route) => {
      if (route.endsWith('/fetch_vms')) return null;
      if (route.endsWith('/device_token/refresh')) { refreshes++; return {access_token: 't2', refresh_token: 'r:2'}; }
      throw new Error('unexpected ' + route);
    }});
  await assert.rejects(a.lookupVm(), /認証情報を取得できませんでした/);
  assert.equal(refreshes, 0);
});

test('#198: after a refresh, a still-failing fetch does not refresh again on the next lookup', async () => {
  let refreshes = 0;
  const {a} = auth({disk: {nodeId: 'n', sdkToken: 's', device: {access_token: 'tok', refresh_token: 'r:1'}},
    request: async (s, route) => {
      if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('401'), {status: 401});
      if (route.endsWith('/device_token/refresh')) { refreshes++; return {access_token: 't2', refresh_token: 'r:2'}; }
      throw new Error('unexpected ' + route);
    }});
  await assert.rejects(a.lookupVm(), e => e.status === 401);
  assert.equal(refreshes, 1, 'first lookup refreshed once, then the post-refresh fetch failed');
  await assert.rejects(a.lookupVm(), e => e.status === 401);
  assert.equal(refreshes, 1, 'second lookup did not burn another refresh token');
});

test('#199: mint registers a node id when the flow never went through start()', async () => {
  let mintBody;
  const {a, disk} = auth({disk: {sdkToken: 'mgst_x'}, request: async (s, route, body) => {
    if (route.endsWith('/device_token/mint')) { mintBody = body; return {access_token: 'dat', refresh_token: 'drt'}; }
    return okFlow.request(s, route);
  }});
  await toCode(a);
  delete disk().nodeId; a.saved = {...a.saved}; delete a.saved.nodeId;
  const s = await a.confirm('123456');
  assert.equal(s.phase, 'authenticated');
  assert.match(mintBody.device_id, /^homelink-/, 'mint was sent the generated node id, not undefined');
  assert.equal(disk().nodeId, mintBody.device_id);
});

test('#200: cancel() aborts the in-flight request', async () => {
  let seenSignal, release;
  const {a} = auth({disk: {sdkToken: 'mgst_x'}, request: (s, route, body, bearer, signal) => {
    seenSignal = signal;
    return new Promise((resolve, reject) => { release = resolve; signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
  }});
  await a.start(true);
  const p = a.send('a@b.c');
  await new Promise(r => setTimeout(r, 10));
  a.cancel();
  await assert.rejects(p, e => e.name === 'AbortError' || /閉じました/.test(e.message));
  assert.equal(seenSignal.aborted, true, 'the request received a signal and it fired');
  release?.({});
});

test('#200: a mint that lands after cancel() is not persisted', async () => {
  let aRef;
  const {a, disk} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1'}, request: async (s, route) => {
    if (route.endsWith('/device_token/mint')) { aRef.cancel(); return {access_token: 'dat', refresh_token: 'drt'}; }
    return okFlow.request(s, route);
  }});
  aRef = a;
  await toCode(a);
  await assert.rejects(a.confirm('123456'), /閉じました/);
  assert.equal(disk().device, undefined, 'no device pair was saved after cancellation');
});

// ---- pc-login flow (audit #190-#192) ----
const {pcLogin} = require('../src/pc-login');
let fileSeq = 0;
function loginWeb(over = {}) {
  const counts = {send_otp: 0, confirm_otp: 0};
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route, body) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) { counts.send_otp++; return {auth_state: 'as'}; }
      if (route.endsWith('/confirm_otp')) { counts.confirm_otp++; if (over.confirm) return over.confirm(body, counts.confirm_otp); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/select_account')) return over.select ? over.select() : {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/two_factor/send_code')) return {};
      if (route.endsWith('/two_factor')) return over.twoFactor ? over.twoFactor(body) : {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
      if (route.endsWith('/fetch_vms')) return {vm_list: []};
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  return {web, counts};
}
function loginUi(answers, over = {}) {
  const asked = [];
  const ui = {note: () => {}, info: () => {}, close() {},
    confirm: async () => true, pick: over.pick || (async () => 0), busy: async (_l, fn) => fn(),
    ask: async (q, opts = {}) => { asked.push(opts.placeholder === '123456' ? 'code' : q); const v = answers.shift(); if (v === undefined) throw new Error('no scripted answer for: ' + q); return v; }};
  return {ui, asked};
}
const nextFile = () => 'pc-auth-test-flow-' + (++fileSeq) + '/device.enc';

test('#191 pc-login: typing resend at the code prompt sends a fresh code and does not burn a try', async () => {
  const {web, counts} = loginWeb();
  const {ui} = loginUi(['a@b.c', 'resend', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(counts.send_otp, 2, 'the initial send plus one resend');
});

test('#190 pc-login: a fatal confirm error is not retried as a wrong code', async () => {
  const {web, counts} = loginWeb({confirm: () => { throw Object.assign(new Error('server exploded'), {status: 500}); }});
  const {ui, asked} = loginUi(['a@b.c', '111111', '222222', '333333']);
  await assert.rejects(pcLogin(web, ui, {file: nextFile()}), e => e.status === 500);
  assert.equal(counts.confirm_otp, 1, 'no pointless re-entry attempts');
  assert.equal(asked.filter(x => x === 'code').length, 1);
});

test('#190 pc-login: a wrong code (4xx, phase unchanged) is retried, then succeeds', async () => {
  const {web, counts} = loginWeb({confirm: (body, n) => { if (n === 1) throw Object.assign(new Error('wrong code'), {status: 400}); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }});
  const {ui} = loginUi(['a@b.c', '000000', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(counts.confirm_otp, 2);
});

test('#192 pc-login: a non-numeric account pick is re-asked instead of killing the login', async () => {
  const acct = {account_selection_required: true, accounts: [{account_ref: 'r1', display_name: 'A'}], selection_state: 'ss'};
  const {web} = loginWeb({confirm: () => acct});
  let picks = 0;
  const {ui} = loginUi(['a@b.c', '111111'], {pick: async () => { picks++; return picks === 1 ? NaN : 0; }});
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(picks, 2);
});

test('#192 pc-login: a wrong 2FA code is retried within the same login', async () => {
  const tf = {two_factor_required: true, two_factor_methods: [{method_id: 'm1', method_type: 'SMS', display_name: 'SMS'}], two_factor_state: 'ts'};
  let tfCalls = 0;
  const {web} = loginWeb({confirm: () => tf, twoFactor: () => { tfCalls++; if (tfCalls === 1) throw Object.assign(new Error('wrong 2fa'), {status: 400}); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }});
  const {ui} = loginUi(['a@b.c', '111111', '000000', '999999']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(tfCalls, 2, 'the completed OTP stage was not thrown away');
});
