'use strict';
// Fix phase 1 (deep audit): H14 secure-store preload positional mapping,
// H15 pc-auth vm_list shape validation, H16 single-use refresh token race.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {PcAuth} = require('../src/core/pc-auth');

// ---------- H14: secure-store preload ----------
const store = require('../src/secure-store');
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

test('H14: parsePreloadOutput keeps empty slots positional (no filter(Boolean) shift)', () => {
  const lines = store.parsePreloadOutput(['', b64('{"b":1}'), b64('{"c":2}')].join('\r\n') + '\r\n', 3);
  assert.deepEqual(lines, ['', b64('{"b":1}'), b64('{"c":2}')], 'the empty first slot stays at index 0 and the trailing newline is not a slot');
  const decoded = store.decodePreload([{name: 'a.enc'}, {name: 'b.enc'}, {name: 'c.enc'}], lines);
  assert.equal(decoded.has('a.enc'), false, 'the empty file gets no cache entry');
  assert.equal(decoded.get('b.enc'), '{"b":1}', 'the second file keeps its own plaintext');
  assert.equal(decoded.get('c.enc'), '{"c":2}');
});

test('H14: decodePreload treats the ! placeholder as a failed slot without shifting later files', () => {
  const lines = store.parsePreloadOutput(['!', b64('{"secret":"good"}'), 'not-json!!!'].join('\n') + '\n', 3);
  const decoded = store.decodePreload([{name: 'empty.enc'}, {name: 'good.enc'}, {name: 'bad.enc'}], lines);
  assert.equal(decoded.has('empty.enc'), false);
  assert.equal(decoded.get('good.enc'), '{"secret":"good"}');
  assert.equal(decoded.has('bad.enc'), false, 'an undecodable slot is skipped, not shifted');
});

test('H14 e2e: preload with an empty first .enc file does not serve another file secret under its name', () => {
  const emptyName = 'fix1-h14-empty.enc', goodName = 'fix1-h14-good.enc';
  // Create the good file in a child process so this process has no cache entry for it.
  execFileSync(process.execPath, ['-e', `require('./src/secure-store').save(${JSON.stringify(goodName)}, {secret: 'good-value'})`],
    {cwd: path.join(__dirname, '..'), env: {...process.env}, encoding: 'utf8', timeout: 30000});
  fs.writeFileSync(store.file(emptyName), '');
  try {
    store.preload([emptyName, goodName]);
    assert.deepEqual(store.load(goodName), {secret: 'good-value'}, 'the good file loads its own secret');
    assert.throws(() => store.load(emptyName), /読み込めませんでした/, 'the empty file is an error, not the good file secret');
  } finally { store.remove(emptyName); store.remove(goodName); }
});

// ---------- pc-auth harness (same pattern as tests/pc-auth.test.js) ----------
function auth(over = {}) {
  let disk = over.disk || {};
  const a = new PcAuth({
    load: over.load || (() => disk), save: over.save || (v => { disk = v; }),
    request: over.request || (async () => { throw new Error('unexpected request'); }),
    listSdk: async () => ({tokens: [], maxActiveTokens: 2}),
    issueSdk: async () => ({token: 'mgst_x', sdkToken: {id: 'id1'}}),
    expectedVm: async () => 'vm1',
  });
  return {a, disk: () => disk};
}
const pairDisk = () => ({nodeId: 'n', sdkToken: 's', device: {access_token: 'tok', refresh_token: 'r:1'}});

// ---------- H15: vm_list shape ----------
test('H15: missing / empty / non-array vm_list is a retryable shape error, never deviceMismatch', async () => {
  for (const result of [{}, {vm_list: []}, {vm_list: 'vm1'}, {vm_list: {length: 1}}, {vm_list: null}]) {
    const {a, disk} = auth({disk: pairDisk(), request: async () => result});
    await assert.rejects(a.lookupVm(), e => !(e instanceof TypeError) && e.deviceMismatch !== true && e.deadDevice !== true && e.retryable === true,
      'shape problem must be retryable, not a mismatch: ' + JSON.stringify(result));
    assert.deepEqual(disk().device, pairDisk().device, 'the healthy pair is left on disk');
  }
});

test('H15: an expected VM present without an auth token (unprovisioned) is retryable, not a mismatch', async () => {
  const {a} = auth({disk: pairDisk(), request: async () => ({vm_list: [null, {vm_id: 'vm1'}]})});
  await assert.rejects(a.lookupVm(), e => e.deviceMismatch !== true && e.retryable === true);
});

test('H15: a proper non-empty vm_list without the expected VM is still deviceMismatch; null entries do not crash .find', async () => {
  const {a} = auth({disk: pairDisk(), request: async () => ({vm_list: [null, {vm_id: 'someone-else', vm_auth_token: 'vt'}]})});
  await assert.rejects(a.lookupVm(), e => e.deviceMismatch === true);
  const {a: a2} = auth({disk: pairDisk(), request: async () => ({vm_list: [null, {vm_id: 'vm1', vm_auth_token: 'vt'}]})});
  assert.equal((await a2.lookupVm()).vm_auth_token, 'vt', 'a valid entry after a null entry still resolves');
});

test('H15: start() keeps the saved pair when vm_list is malformed', async () => {
  const {a, disk} = auth({disk: pairDisk(), request: async () => ({vm_list: []})});
  await assert.rejects(a.start(true), e => e.retryable === true);
  assert.deepEqual(disk().device, pairDisk().device, 'start() did not persist-clear the pair');
});

// ---------- H16: refresh race ----------
test('H16: a loser of the refresh race adopts the winner pair after repeated disk re-reads and keeps it', async () => {
  const oldPair = {access_token: 'old', refresh_token: 'r:old', access_token_saved_at: 100};
  const newPair = {access_token: 'new', refresh_token: 'r:new', access_token_saved_at: 200};
  let realDisk = {nodeId: 'n', sdkToken: 's', device: {...oldPair}};
  let staleReads = 0, refreshes = 0;
  const loser = new PcAuth({
    // The losers view of the disk lags the winners save for the first reads after the race.
    load: () => staleReads > 0 ? (staleReads--, {nodeId: 'n', sdkToken: 's', device: {...oldPair}}) : realDisk,
    save: v => { realDisk = v; },
    request: async (scope, route, body, bearer) => {
      if (route.endsWith('/fetch_vms')) {
        if (bearer === 'new') return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'vt'}]};
        throw Object.assign(new Error('401'), {status: 401});
      }
      if (route.endsWith('/device_token/refresh')) {
        refreshes++;
        // The winner instance refreshes first, consumes the token and persists its pair;
        // this instances refresh then fails as already-used.
        realDisk = {...realDisk, device: {...newPair}};
        staleReads = 2;
        throw Object.assign(new Error('refresh token already used'), {status: 400});
      }
      throw new Error('unexpected ' + route);
    },
    listSdk: async () => ({}), issueSdk: async () => ({}), expectedVm: async () => 'vm1',
  });
  const vm = await loser.lookupVm();
  assert.equal(vm.vm_auth_token, 'vt', 'the loser completed the lookup with the adopted pair');
  assert.equal(refreshes, 1);
  assert.equal(loser.saved.device.access_token, 'new', 'the winner pair was adopted');
  assert.deepEqual(realDisk.device, newPair, 'the winner pair on disk was not wiped');
});

test('H16: when the adopted disk pair still cannot fetch, the refresh error is not marked deadDevice', async () => {
  const newPair = {access_token: 'new', refresh_token: 'r:new', access_token_saved_at: 200};
  let realDisk = {nodeId: 'n', sdkToken: 's', device: {access_token: 'old', refresh_token: 'r:old', access_token_saved_at: 100}};
  const loser = new PcAuth({
    load: () => realDisk, save: v => { realDisk = v; },
    request: async (scope, route) => {
      if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('401'), {status: 401});
      if (route.endsWith('/device_token/refresh')) { realDisk = {...realDisk, device: {...newPair}}; throw Object.assign(new Error('refresh token already used'), {status: 400}); }
      throw new Error('unexpected ' + route);
    },
    listSdk: async () => ({}), issueSdk: async () => ({}), expectedVm: async () => 'vm1',
  });
  await assert.rejects(loser.lookupVm(), e => e.status === 400 && e.deadDevice !== true, 'a disk pair newer than ours means race, not death');
  assert.deepEqual(realDisk.device, newPair, 'the winner pair survives for start() / the next attempt');
});

test('H16: with no other instance, a 4xx refresh failure is still deadDevice (single-instance behaviour unchanged)', async () => {
  const {a, disk} = auth({disk: pairDisk(), request: async (scope, route) => {
    if (route.endsWith('/fetch_vms')) throw Object.assign(new Error('401'), {status: 401});
    if (route.endsWith('/device_token/refresh')) throw Object.assign(new Error('invalid refresh'), {status: 400});
    throw new Error('unexpected ' + route);
  }});
  await assert.rejects(a.lookupVm(), e => e.status === 400 && e.deadDevice === true);
  assert.deepEqual(disk().device, pairDisk().device, 'lookupVm itself does not clear the pair; dropping is start()s decision');
});
