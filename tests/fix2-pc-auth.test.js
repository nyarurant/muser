'use strict';
// Fix phase 2 — c29 Medium findings (deep#242-248) for src/core/pc-auth.js and
// src/permissions.js. Each test fails on the pre-fix tree and passes after.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {PcAuth} = require('../src/core/pc-auth');
const permissions = require('../src/permissions');

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
const pairDisk = (token = 'tok') => ({nodeId: 'n', sdkToken: 's', device: {access_token: token, refresh_token: 'r:1'}});
const fetch401 = async (s, route) => {
  if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('401'), {status: 401});
  throw new Error('unexpected ' + route);
};

// ---- deep#242 (c29 #3): retryable refresh statuses are not a dead device ----

test('deep#242: a 429 refresh failure is not deadDevice and start() keeps the pair', async () => {
  const pair = {access_token: 'tok', refresh_token: 'r:1'};
  const {a, disk} = auth({disk: {nodeId: 'n', sdkToken: 's', device: {...pair}}, request: async (s, route) => {
    if (route.endsWith('/device_token/refresh')) throw Object.assign(new Error('slow down'), {status: 429});
    return fetch401(s, route);
  }});
  await assert.rejects(a.lookupVm(), e => e.status === 429 && e.deadDevice !== true, 'a rate limit must not mark the pair dead');
  await assert.rejects(a.start(true), e => e.status === 429);
  assert.deepEqual(disk().device, pair, 'start() kept the healthy pair after a 429');
});

test('deep#242: a 408 refresh failure is not deadDevice; a 400 still is (phase-1 behaviour)', async () => {
  const mk = status => auth({disk: pairDisk(), request: async (s, route) => {
    if (route.endsWith('/device_token/refresh')) throw Object.assign(new Error('refresh failed'), {status});
    return fetch401(s, route);
  }}).a;
  await assert.rejects(mk(408).lookupVm(), e => e.status === 408 && e.deadDevice !== true);
  await assert.rejects(mk(400).lookupVm(), e => e.status === 400 && e.deadDevice === true, 'a plain 4xx keeps the phase-1 deadDevice classification');
});

// ---- deep#243 (c29 #4): persist must not erase or roll back a newer pair ----

test('deep#243: a stale window dropping its dead pair does not erase a newer pair saved by another window', () => {
  let disk = {sdkToken: 's', device: {access_token: 'a1', refresh_token: 'r:1', access_token_saved_at: 100}};
  const mk = () => new PcAuth({load: () => disk, save: v => { disk = v; }, request: async () => {}, listSdk: async () => {}, issueSdk: async () => {}, expectedVm: async () => 'vm1'});
  const stale = mk();
  mk().persist({device: {access_token: 'a2', refresh_token: 'r:2', access_token_saved_at: 200}});
  stale.persist({device: undefined}); // stale window proved only ITS pair dead
  assert.equal(disk.device.access_token, 'a2', 'the newer pair survived the stale delete');
  assert.equal(disk.device.refresh_token, 'r:2');
});

test('deep#243: a pair deletion is still honoured when the disk holds the pair being dropped', () => {
  let disk = {sdkToken: 's', device: {access_token: 'a1', refresh_token: 'r:1', access_token_saved_at: 100}};
  const a = new PcAuth({load: () => disk, save: v => { disk = v; }, request: async () => {}, listSdk: async () => {}, issueSdk: async () => {}, expectedVm: async () => 'vm1'});
  a.persist({device: undefined});
  assert.equal(disk.device, undefined, 'the only window dropping its own pair still deletes it');
});

test('deep#243: on a same-second stamp tie an unrelated persist does not roll the disk pair back', () => {
  let disk = {sdkToken: 's', device: {access_token: 'a1', refresh_token: 'r:1', access_token_saved_at: 200}};
  const stale = new PcAuth({load: () => disk, save: v => { disk = v; }, request: async () => {}, listSdk: async () => {}, issueSdk: async () => {}, expectedVm: async () => 'vm1'});
  disk = {sdkToken: 's', device: {access_token: 'a2', refresh_token: 'r:2', access_token_saved_at: 200}}; // other window, same second
  stale.persist({nodeId: 'n-x'});
  assert.equal(disk.device.access_token, 'a2', 'the disk pair wins the tie');
  assert.equal(disk.nodeId, 'n-x');
});

test('deep#243: start() in a stale window adopts the newer disk pair instead of falling through to a fresh login', async () => {
  let disk = {sdkToken: 's', nodeId: 'n', device: {access_token: 'a1', refresh_token: 'r:1', access_token_saved_at: 100}};
  const stale = new PcAuth({load: () => disk, save: v => { disk = v; },
    request: async (s, route, body, bearer) => {
      if (route.endsWith('/fetch_vms')) return bearer === 'a1' ? {vm_list: [{vm_id: 'someone-else', vm_auth_token: 'vt'}]} : {vm_list: [{vm_id: 'vm1', vm_auth_token: 'vt'}]};
      throw new Error('unexpected ' + route);
    },
    listSdk: async () => ({tokens: [], maxActiveTokens: 2}), issueSdk: async () => ({token: 'mgst_x', sdkToken: {id: 'id1'}}), expectedVm: async () => 'vm1'});
  disk = {sdkToken: 's', nodeId: 'n', device: {access_token: 'a2', refresh_token: 'r:2', access_token_saved_at: 200}}; // another window re-paired
  const s = await stale.start(true);
  assert.equal(s.phase, 'authenticated', 'the surviving newer pair counts as registered');
  assert.equal(disk.device.access_token, 'a2', 'and it is still on disk');
});

// ---- deep#244 (c29 #5): the vm cache key is the target actually fetched ----

test('deep#244: an account switch between the cache-key read and the fetch does not poison the cache', async () => {
  let current = 'vm2', calls = 0;
  const {a} = auth({disk: pairDisk(),
    expectedVm: async () => { calls++; return calls === 1 ? 'vm1' : current; },
    request: async (s, route) => {
      if (route.endsWith('/fetch_vms')) return {vm_list: [{vm_id: 'vm1', vm_auth_token: 't1'}, {vm_id: 'vm2', vm_auth_token: 't2'}]};
      throw new Error('unexpected ' + route);
    }});
  const first = await a.vm();
  assert.equal(first.vm_id, 'vm1', 'vm() fetched the VM it keyed on');
  current = 'vm1'; calls = 99;
  const second = await a.vm();
  assert.equal(second.vm_id, 'vm1', 'the vm1 cache entry holds vm1');
  assert.equal(second.vm_auth_token, 't1');
});

test('deep#244: after a re-pairing the old pair cached VM is not served for the same account', async () => {
  let fetches = 0;
  const {a} = auth({disk: pairDisk('old-tok'), request: async (s, route, body, bearer) => {
    if (route.endsWith('/fetch_vms')) { fetches++; return {vm_list: [{vm_id: 'vm1', vm_auth_token: bearer === 'old-tok' ? 'old-vt' : 'new-vt'}]}; }
    throw new Error('unexpected ' + route);
  }});
  assert.equal((await a.vm()).vm_auth_token, 'old-vt');
  a.saved = {...a.saved, device: {access_token: 'new-tok', refresh_token: 'r:2'}};
  assert.equal((await a.vm()).vm_auth_token, 'new-vt', 'the cache is keyed by the pair too');
  assert.equal(fetches, 2);
});

test('deep#244: concurrent vm() calls for the same target still share one fetch', async () => {
  let fetches = 0;
  const {a} = auth({disk: pairDisk(), request: async (s, route) => {
    if (route.endsWith('/fetch_vms')) { fetches++; await new Promise(r => setTimeout(r, 10)); return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'x'}]}; }
    throw new Error('unexpected ' + route);
  }});
  const [v1, v2] = await Promise.all([a.vm(), a.vm()]);
  assert.equal(v1.vm_id, 'vm1'); assert.equal(v2.vm_id, 'vm1');
  assert.equal(fetches, 1, 'dedupe was not broken by the key change');
});

// ---- deep#245 (c29 #6): interval checks do not stretch on a clock rollback ----

test('deep#245: a vm cache timestamp from the wall clock future does not count as fresh', async () => {
  let fetches = 0;
  const {a} = auth({disk: pairDisk(), request: async (s, route) => {
    if (route.endsWith('/fetch_vms')) { fetches++; return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'x'}]}; }
    throw new Error('unexpected ' + route);
  }});
  await a.vm();
  assert.equal(fetches, 1);
  a.vmCache.at = Date.now() + 3600_000; // wall-clock rollback leaves the stamp in the future
  await a.vm();
  assert.equal(fetches, 2, 'the stale entry was refetched instead of served');
});

test('deep#245: the refresh suppression does not stretch on a clock rollback either', async () => {
  let refreshes = 0;
  const {a} = auth({disk: pairDisk(), request: async (s, route) => {
    if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('401'), {status: 401});
    if (route.endsWith('/device_token/refresh')) { refreshes++; return {access_token: 't2', refresh_token: 'r:2'}; }
    throw new Error('unexpected ' + route);
  }});
  a.refreshedAccess = 'tok'; a.refreshedAt = Date.now() + 3600_000;
  await assert.rejects(a.lookupVm(), e => e.status === 401);
  assert.equal(refreshes, 1, 'the refresh was attempted instead of suppressed');
});

// ---- deep#246 (c29 #7): element and token types are validated ----

test('deep#246: snapshot degrades malformed account/method elements to fallback labels', () => {
  const {a} = auth({disk: {sdkToken: 'mgst_x'}});
  a.phase = 'account'; a.pending = {accounts: [null, 42], selection_state: 'ss'};
  const s1 = a.snapshot();
  assert.equal(s1.accounts.length, 2);
  assert.match(s1.accounts[0].label, /アカウント 1/);
  a.phase = 'two_factor'; a.pending = {two_factor_methods: [null], two_factor_state: 'ts'};
  const s2 = a.snapshot();
  assert.match(s2.methods[0].label, /認証方法 1/);
});

test('deep#246: accept rejects an account list whose elements are not objects', async () => {
  const {a} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1'}, request: async (s, route) => {
    if (route.endsWith('/auth/start')) return {access_token: 'at'};
    if (route.endsWith('/login_options')) return {};
    if (route.endsWith('/send_otp')) return {auth_state: 'as'};
    if (route.endsWith('/confirm_otp')) return {account_selection_required: true, accounts: [null], selection_state: 'ss'};
    throw new Error('unexpected ' + route);
  }});
  await a.start(true); await a.send('a@b.c');
  await assert.rejects(a.confirm('123456'), e => !(e instanceof TypeError) && /アカウント候補を確認できません/.test(e.message));
});

test('deep#246: select and twoFactor reject malformed elements with stage errors, not TypeErrors', async () => {
  const {a} = auth({disk: {sdkToken: 'mgst_x'}, request: async () => ({})});
  a.login = {token: 'x', deviceId: 'd', waterfall: 'w'};
  a.phase = 'account'; a.pending = {accounts: [null], selection_state: 'ss'};
  await assert.rejects(a.select(0), e => !(e instanceof TypeError) && /アカウント候補を確認できません/.test(e.message));
  const {a: b} = auth({disk: {sdkToken: 'mgst_x'}, request: async () => ({})});
  b.login = {token: 'x', deviceId: 'd', waterfall: 'w'};
  b.phase = 'two_factor'; b.pending = {two_factor_methods: [null], two_factor_state: 'ts'};
  await assert.rejects(b.twoFactor(0), e => !(e instanceof TypeError) && /追加認証の方法を確認できません/.test(e.message));
});

test('deep#246: a mint response with non-string tokens is rejected and nothing is persisted', async () => {
  const {a, disk} = auth({disk: {sdkToken: 'mgst_x', nodeId: 'n1'}, request: async (s, route) => {
    if (route.endsWith('/auth/start')) return {access_token: 'at'};
    if (route.endsWith('/login_options')) return {};
    if (route.endsWith('/send_otp')) return {auth_state: 'as'};
    if (route.endsWith('/confirm_otp')) return {abra_access_token: 'abra', abra_user_id: 'u1'};
    if (route.endsWith('/device_token/mint')) return {access_token: 123, refresh_token: 456};
    throw new Error('unexpected ' + route);
  }});
  await a.start(true); await a.send('a@b.c');
  await assert.rejects(a.confirm('123456'), /認証情報を取得できませんでした/);
  assert.equal(disk().device, undefined, 'the broken pair was not written to the store');
});

test('deep#246: a refresh response with non-string tokens is rejected and the saved pair is untouched', async () => {
  const pair = {access_token: 'tok', refresh_token: 'r:1'};
  const {a, disk} = auth({disk: {nodeId: 'n', sdkToken: 's', device: {...pair}}, request: async (s, route) => {
    if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('401'), {status: 401});
    if (route.endsWith('/device_token/refresh')) return {access_token: 123, refresh_token: 456};
    throw new Error('unexpected ' + route);
  }});
  await assert.rejects(a.lookupVm(), /認証を更新できません/);
  assert.deepEqual(disk().device, pair, 'the broken refreshed pair was not persisted over the old one');
});

// ---- deep#247 (c29 #8): phase follows the dropped pair immediately ----

test('deep#247: after start() drops a dead pair, a later throw does not leave phase at authenticated', async () => {
  const {a} = auth({disk: {nodeId: 'n1', device: {access_token: 'old', refresh_token: 'r:1'}},
    request: async (s, route) => {
      if (route.endsWith('/fetch_vms')) return {vm_list: [{vm_id: 'someone-else', vm_auth_token: 'vt'}]};
      throw new Error('unexpected ' + route);
    }});
  await assert.rejects(a.start(false), /利用規約を確認してください/);
  const snap = a.snapshot();
  assert.equal(snap.hasDevice, false, 'the pair really was dropped');
  assert.equal(snap.phase, 'start', 'the snapshot no longer claims authenticated');
});

// ---- deep#248 (c29 #10): a folder key is the folder real identity ----

function useFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-perm2-'));
  process.env.MUSER_PERMISSIONS_FILE = path.join(dir, 'permissions.json');
  t.after(() => { delete process.env.MUSER_PERMISSIONS_FILE; fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, file: process.env.MUSER_PERMISSIONS_FILE};
}

test('deep#248: a junction to a folder shares its remembered mode', t => {
  const {dir} = useFile(t);
  const real = fs.mkdtempSync(path.join(dir, 'Real-'));
  const link = path.join(dir, 'linkdir');
  fs.symlinkSync(real, link, 'junction');
  assert.equal(permissions.key(link), permissions.key(real), 'the junction and its target are one key');
  permissions.saveMode(real, 'bypass');
  assert.equal(permissions.load(link).mode, 'bypass', 'the mode applies through the junction spelling');
  permissions.addAllow(link, 'exec:git status');
  assert.deepEqual(permissions.load(real).allow, ['exec:git status'], 'and back through the real path');
});

test('deep#248: case spellings of one existing folder still share a key; different folders do not', t => {
  const {dir} = useFile(t);
  const aDir = fs.mkdtempSync(path.join(dir, 'Alpha-'));
  const bDir = fs.mkdtempSync(path.join(dir, 'Beta-'));
  assert.equal(permissions.key(aDir.toUpperCase()), permissions.key(aDir), 'on-disk casing unifies case variants');
  permissions.saveMode(aDir.toUpperCase(), 'plan');
  assert.equal(permissions.load(aDir).mode, 'plan');
  assert.notEqual(permissions.key(aDir), permissions.key(bDir));
  assert.equal(permissions.load(bDir).mode, null, 'no mode leaks to a different folder');
});

test('deep#248: entries remembered under the old lexical key are still read and migrate on the next save', t => {
  const {dir, file} = useFile(t);
  const real = fs.mkdtempSync(path.join(dir, 'Legacy-'));
  const legacy = path.resolve(real).replace(/[\\/]+$/, '').toLowerCase();
  fs.writeFileSync(file, JSON.stringify({version: 1, folders: {[legacy]: {mode: 'plan', allow: ['exec:x']}}}));
  assert.deepEqual(permissions.load(real), {mode: 'plan', allow: ['exec:x']}, 'the pre-fix entry is still found');
  assert.equal(permissions.saveMode(real, 'auto-edit'), true);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.folders[permissions.key(real)].mode, 'auto-edit', 'the entry now lives under the canonical key');
  assert.deepEqual(stored.folders[permissions.key(real)].allow, ['exec:x'], 'its allow keys were carried over');
  assert.equal(stored.folders[legacy], undefined, 'the legacy key was migrated, not duplicated');
});

test('deep#248: a folder that does not exist yet keeps the case-insensitive lexical key', () => {
  assert.equal(permissions.key('C:\\proj\\a'), permissions.key('c:\\PROJ\\a\\'));
  assert.notEqual(permissions.key('C:\\proj\\a'), permissions.key('C:\\proj\\b'));
});
