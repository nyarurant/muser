'use strict';
// Multi-account support: the registry and per-account file layout (src/accounts.js), the
// selection policy, the separation of saved logins, and the Agent's account switch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// The registry and the encrypted jars live in muser's real data folder, so point every
// folder at a throwaway one BEFORE loading any src module. `npm test` already does this
// via tests/setup.mjs, but a bare `node --test tests/accounts.test.js` skips that file —
// and did exactly that once (2026-11-03): its jar test failed on the user's real login
// jar and left its test account behind in the real registry.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-accounts-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-accounts-home-'));

const accounts = require('../src/accounts');
const store = require('../src/secure-store');

test('accounts: the default account is always there, on the historic flat files', () => {
  const list = accounts.list();
  assert.equal(list[0].id, 'default');
  assert.deepEqual(accounts.filesFor('default'), {web: 'web.enc', session: 'session.enc', device: 'device.enc', browser: store.file('browser')});
});

test('accounts: add / resolve / remove, with per-account file layout', () => {
  // The registry is shared by every test in this file: a failed assert midway
  // must not leave the account (or the active selection) behind (t8 #2).
  const a = accounts.add('Second Account');
  try {
    assert.equal(a.id, 'second-account');
    const files = accounts.filesFor(a.id);
    assert.equal(files.web, 'accounts/second-account/web.enc');
    assert.equal(files.device, 'accounts/second-account/device.enc');
    assert.equal(accounts.resolve('Second Account').id, a.id);
    assert.equal(accounts.resolve('second').id, a.id);
    assert.throws(() => accounts.add('second account'), /既にあります/);
    // Login presence is per account: a file for this one says nothing about the default.
    fs.mkdirSync(path.dirname(store.file(files.web)), {recursive: true});
    fs.writeFileSync(store.file(files.web), 'x');
    assert.equal(accounts.hasLogin(a.id), true);
    accounts.setActive(a.id);
    assert.equal(accounts.activeId(), a.id);
    assert.throws(() => accounts.remove('default'), /削除できません/);
    accounts.remove(a.id);
    assert.equal(accounts.get(a.id), null);
    assert.equal(accounts.hasLogin(a.id), false);
    assert.equal(accounts.activeId(), 'default');
  } finally {
    try { if (accounts.get(a.id)) accounts.remove(a.id); } catch {}
    try { accounts.setActive('default'); } catch {}
  }
});

test('accounts: saved jars stay apart per account', () => {
  const web = require('../src/web');
  const a = accounts.add('Jar Account');
  try {
    const files = accounts.filesFor(a.id);
    const jar = [{name: 's', value: 'v', domain: '.muse.ai', path: '/', expires: -1, secure: true}];
    web.saveJar(jar, files.web);
    assert.deepEqual(web.loadJar(files.web), jar);
    assert.deepEqual(web.loadJar(), [], 'the default account jar is untouched');
  } finally { try { accounts.remove(a.id); } catch {} }
});

// ---- the selection policy ----
const cand = (id, over = {}) => ({id, available: true, percentUsed: null, quotaStatus: null, ...over});

test('choose: nothing available -> null; one account -> that one', () => {
  assert.equal(accounts.choose([]), null);
  assert.equal(accounts.choose([cand('a', {available: false})]), null);
  assert.deepEqual(accounts.choose([cand('a')]), {id: 'a', reason: 'least-used'});
});

test('choose: a running conversation keeps its account (stickiness)', () => {
  const all = [cand('a', {percentUsed: 90}), cand('b', {percentUsed: 10})];
  assert.deepEqual(accounts.choose(all, {currentId: 'a'}), {id: 'a', reason: 'keep-current'});
  // At a fresh start a much lighter account wins; a slightly lighter one does not.
  assert.deepEqual(accounts.choose(all, {currentId: 'a', fresh: true}), {id: 'b', reason: 'least-used'});
  assert.deepEqual(accounts.choose([cand('a', {percentUsed: 30}), cand('b', {percentUsed: 25})], {currentId: 'a', fresh: true}), {id: 'a', reason: 'keep-current'});
});

test('choose: exhausted or unavailable current fails over to the lightest alive account', () => {
  const all = [cand('a', {percentUsed: 100}), cand('b', {percentUsed: 55}), cand('c', {percentUsed: 20})];
  assert.deepEqual(accounts.choose(all, {currentId: 'a'}), {id: 'c', reason: 'failover'});
  // A quota status other than SUFFICIENT is exhaustion even at a low percent.
  assert.deepEqual(accounts.choose([cand('a', {percentUsed: 10, quotaStatus: 'INSUFFICIENT'}), cand('b', {percentUsed: 80})], {currentId: 'a'}), {id: 'b', reason: 'failover'});
  assert.deepEqual(accounts.choose([cand('a', {available: false}), cand('b')], {currentId: 'a'}), {id: 'b', reason: 'failover'});
});

test('choose: when every account is exhausted the lightest is still picked, saying so', () => {
  const all = [cand('a', {percentUsed: 100}), cand('b', {percentUsed: 100, quotaStatus: 'INSUFFICIENT'})];
  const pick = accounts.choose(all, {currentId: 'a'});
  assert.equal(pick.reason, 'all-exhausted');
  assert.ok(['a', 'b'].includes(pick.id));
});

test('choose: two accounts on one VM are one allowance (audit #47)', () => {
  // Current exhausted; its duplicate reads lower (a stale reading) — without
  // grouping the failover would land on the same used-up VM. The distinct
  // account must win.
  const all = [cand('a', {percentUsed: 100, vm: 'vm1'}), cand('b', {percentUsed: 92, vm: 'vm1'}), cand('c', {percentUsed: 60, vm: 'vm2'})];
  assert.deepEqual(accounts.choose(all, {currentId: 'a'}), {id: 'c', reason: 'failover'});
  // The group speaks with its most-exhausted reading: b at 92 is used up too,
  // because its VM-mate reads 100.
  const pick = accounts.choose([cand('a', {percentUsed: 100, vm: 'vm1'}), cand('b', {percentUsed: 92, vm: 'vm1'})], {currentId: 'b'});
  assert.equal(pick.reason, 'all-exhausted');
  assert.equal(pick.id, 'b', 'the current account represents its own group');
  // Stickiness survives grouping.
  assert.deepEqual(accounts.choose([cand('a', {percentUsed: 40, vm: 'vm1'}), cand('b', {percentUsed: 30, vm: 'vm1'}), cand('c', {percentUsed: 35, vm: 'vm2'})], {currentId: 'a'}), {id: 'a', reason: 'keep-current'});
  // An unknown vm is never grouped.
  assert.deepEqual(accounts.choose([cand('a', {percentUsed: 100}), cand('b', {percentUsed: 92})], {currentId: 'a'}), {id: 'b', reason: 'failover'});
});

test('exhausted: threshold is honoured', () => {
  assert.equal(accounts.exhausted({percentUsed: 90}, 100), false);
  assert.equal(accounts.exhausted({percentUsed: 90}, 90), true);
  assert.equal(accounts.exhausted({percentUsed: null, quotaStatus: null}), false);
  assert.equal(accounts.exhausted(null), true);
});

// ---- the Agent's switch ----
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.subscribe = async () => {};
  c.disconnect = () => { c.status = 'disconnected'; c.disconnected = true; };
  c.request = async () => ({});
  return c;
}
function bundleFor(id, label) {
  return {account: {id, label}, files: accounts.filesFor(id), web: {jar: []},
    auth: {saved: {nodeId: 'node-' + id}, vm: async () => ({vm_id: 'vm-' + id})}, client: stubClient()};
}

test('agent: switchAccount moves to the new account with a fresh session and says so', async () => {
  const {Agent} = require('../src/agent');
  const first = stubClient();
  const a = new Agent({client: first, auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    session: {id: 'old-session', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 3},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default')});
  a.connectDevice = async () => { a.device = {connected: true, disconnect() {}}; };
  const seen = [];
  a.on('account', ev => seen.push(ev));
  const oldSession = a.session;
  await a.switchAccount(bundleFor('second-account', 'Second'), {reason: 'manual'});
  assert.equal(a.accountId, 'second-account');
  assert.equal(a.accountLabel, 'Second');
  assert.notEqual(a.session.id, oldSession.id, 'a switch starts a new session: the other Muse has not seen this chat');
  assert.equal(a.session.account, 'second-account');
  assert.equal(first.disconnected, true, 'the old gateway client is disconnected');
  assert.deepEqual(seen, [{from: 'default', fromSession: 'old-session', id: 'second-account', label: 'Second', reason: 'manual'}]);
  a.close();
});

test('agent: failoverAccount asks the pool for the next account; switching is refused mid-turn', async () => {
  const {Agent} = require('../src/agent');
  const pool = {next: async exclude => exclude.has('default') ? bundleFor('second-account', 'Second') : null};
  const a = new Agent({client: stubClient(), auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default'), accountPool: pool});
  a.connectDevice = async () => { a.device = {connected: true, disconnect() {}}; };
  assert.equal(await a.failoverAccount('quota'), true);
  assert.equal(a.accountId, 'second-account');
  a.main.turn = {controller: new AbortController()};
  await assert.rejects(() => a.switchAccount(bundleFor('default', 'default')), /作業中はアカウントを切り替えられません/);
  assert.equal(await a.failoverAccount('quota'), false, 'no failover while a turn is running');
  a.main.turn = null;
  a.close();
});

// ---- account pool: peek + warm standby ----
// These tests use makePool with injected statusesFn / bundleFn / connectFn stubs, so
// nothing touches the network or the real store: statuses are literals, bundles are
// plain objects, and clients are counters. (The registry is this file's throwaway
// one — see the env-isolation header — and one extra account is added there only so
// the pool's real multi() gate passes.)
const poolMod = require('../src/account-pool');
const pstat = (id, over = {}) => ({id, label: id, available: true, percentUsed: null, quotaStatus: null, ...over});
function stubPoolClient() {
  return {connects: 0, disconnects: 0, disconnectArgs: [],
    async connect() { this.connects++; },
    disconnect(...args) { this.disconnects++; this.disconnectArgs.push(args); }};
}
function makeStubPool(statusList, {failConnect = false} = {}) {
  delete process.env.MUSER_NO_ACCOUNT_AUTO;
  if (!accounts.get('pool-peer')) accounts.add('Pool Peer');
  const made = [];
  let connectCalls = 0;
  const pool = poolMod.makePool({
    statusesFn: async () => statusList,
    bundleFn: account => {
      const b = {account, files: {}, web: {}, auth: {}, client: stubPoolClient()};
      made.push(b);
      return b;
    },
    connectFn: async b => { connectCalls++; if (failConnect) throw new Error('connect failed'); await b.client.connect(); },
  });
  return {pool, made, connectCalls: () => connectCalls};
}
const poolStatuses = () => [pstat('default', {percentUsed: 80}), pstat('pool-peer', {percentUsed: 10})];

test('pool peek: returns the lightest available status and respects exclusions', async () => {
  const {pool, made} = makeStubPool(poolStatuses());
  const lightest = await pool.peek(new Set());
  assert.equal(lightest.id, 'pool-peer');
  assert.equal(lightest.percentUsed, 10, 'peek returns the status object itself, not a bundle');
  assert.equal(made.length, 0, 'peek builds no bundle');
  assert.equal((await pool.peek(new Set(['pool-peer']))).id, 'default');
  assert.equal(await pool.peek(new Set(['pool-peer', 'default'])), null, 'everything excluded -> null');
});

test('pool: a quota failover leaves the whole VM, not just the account (audit #47)', async () => {
  const list = [pstat('default', {percentUsed: 100, vm: 'vm1'}), pstat('pool-peer', {percentUsed: 95, vm: 'vm1'})];
  const {pool} = makeStubPool(list);
  // Both accounts are the same allowance: nothing alive to peek or move to.
  assert.equal(await pool.peek(new Set(['default'])), null, 'the duplicate of an exhausted account is not a way out');
  assert.equal(await pool.next(new Set(['default']), {alive: true}), null);
});

test('pool: a merely unavailable account does not spread its exclusion to its VM duplicate (audit #47)', async () => {
  const list = [pstat('default', {available: false, percentUsed: 10, vm: 'vm1'}), pstat('pool-peer', {percentUsed: 10, vm: 'vm1'})];
  const {pool} = makeStubPool(list);
  const s = await pool.peek(new Set(['default']));
  assert.equal(s.id, 'pool-peer', 'failing over to the duplicate of a lapsed login is a real gain');
});

test('pool peek: null when nothing is available', async () => {
  const {pool} = makeStubPool([pstat('default', {available: false}), pstat('pool-peer', {available: false})]);
  assert.equal(await pool.peek(new Set()), null);
  const {pool: emptyPool} = makeStubPool([]);
  assert.equal(await emptyPool.peek(new Set()), null);
});

test('pool warm: connects the chosen bundle once; a second warm for the same pick does not reconnect', async () => {
  const {pool, made, connectCalls} = makeStubPool(poolStatuses());
  const status = await pool.warm(new Set());
  assert.equal(status.id, 'pool-peer');
  assert.equal(status.percentUsed, 10, 'warm returns the pick status, not the bundle');
  assert.equal(made.length, 1);
  assert.equal(connectCalls(), 1);
  assert.equal(made[0].client.connects, 1);
  assert.equal(pool.warmedId(), 'pool-peer');
  const again = await pool.warm(new Set());
  assert.equal(again.id, 'pool-peer');
  assert.equal(made.length, 1, 'already warmed: no new bundle is built');
  assert.equal(connectCalls(), 1, 'already warmed: no reconnect');
  pool.drop();
});

test('pool take: returns the warmed bundle and empties the cache', async () => {
  const {pool, made} = makeStubPool(poolStatuses());
  await pool.warm(new Set());
  const taken = pool.take('pool-peer');
  assert.equal(taken, made[0], 'take returns the very bundle warm built');
  assert.equal(pool.warmedId(), null);
  assert.equal(pool.take('pool-peer'), null, 'the cache is empty after take');
  assert.equal(pool.take('default'), null, 'never-warmed accounts take as null');
});

test('pool next: reuses the warmed bundle for its pick (same object identity)', async () => {
  const {pool, made, connectCalls} = makeStubPool(poolStatuses());
  await pool.warm(new Set());
  const got = await pool.next(new Set());
  assert.equal(got, made[0], 'next returns the warmed bundle itself, not a rebuild');
  assert.equal(made.length, 1, 'next built no second bundle');
  assert.equal(connectCalls(), 1, 'the warmed client was already connected');
  assert.equal(got.account.id, 'pool-peer');
  assert.equal(pool.warmedId(), null, 'next consumed the warmed bundle');
});

test('pool warm: a connect failure caches nothing and returns null', async () => {
  const {pool, made} = makeStubPool(poolStatuses(), {failConnect: true});
  assert.equal(await pool.warm(new Set()), null);
  assert.equal(made.length, 1, 'the bundle was built before the failed connect');
  assert.equal(pool.warmedId(), null);
  assert.equal(pool.take('pool-peer'), null, 'a failed warm leaves nothing to take');
});

test('pool drop: disconnects warmed clients and clears the cache', async () => {
  const {pool, made} = makeStubPool(poolStatuses());
  await pool.warm(new Set());
  pool.drop();
  assert.equal(made[0].client.disconnects, 1);
  assert.deepEqual(made[0].client.disconnectArgs, [[false]], 'drop disconnects with disconnect(false)');
  assert.equal(pool.warmedId(), null);
  assert.equal(pool.take('pool-peer'), null);
  pool.drop();
  assert.equal(made[0].client.disconnects, 1, 'dropping an empty cache disconnects nothing again');
});

test('agent: a switch drops stale warmed bundles and warms the next account after connecting', async () => {
  const {Agent} = require('../src/agent');
  const pool = {dropped: 0, warmedWith: [], drop() { this.dropped++; }, warm: async excl => { pool.warmedWith.push([...excl]); return null; }, next: async () => null};
  const a = new Agent({client: stubClient(), auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default'), accountPool: pool});
  a.connectDevice = async () => { a.device = {connected: true, disconnect() {}}; };
  await a.switchAccount(bundleFor('second-account', 'Second'), {reason: 'manual'});
  assert.equal(pool.dropped, 1, 'the switch dropped whatever was warmed for the old prediction');
  assert.deepEqual(pool.warmedWith, [['second-account']], 'after connecting, the pool warms the next account (excluding the new current)');
});

test('agent: a switch whose target cannot connect leaves the window on its account', async () => {
  const {Agent} = require('../src/agent');
  const first = stubClient();
  const a = new Agent({client: first, auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    session: {id: 'keep-session', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 1},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default')});
  let deviceDown = false;
  a.device = {connected: true, disconnect() { deviceDown = true; }};
  const target = bundleFor('second-account', 'Second');
  target.client.status = 'auth_required';
  target.client.connect = async () => { throw new Error('login expired'); };
  await assert.rejects(() => a.switchAccount(target), /login expired/);
  assert.equal(a.accountId, 'default');
  assert.equal(a.session.id, 'keep-session');
  assert.equal(a.client, first);
  assert.equal(first.disconnected, undefined, 'the working gateway stays up');
  assert.equal(deviceDown, false, 'the working device link stays up');
  a.device = null; a.close();
});

test('secure-store: a save sweeps temp files of dead writers and leaves none of its own', () => {
  const name = 'accounts/sweep-test/web.enc';
  const target = store.file(name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const dead = target + '.tmp-999999-1', live = target + '.tmp-' + process.ppid + '-1';
  fs.writeFileSync(dead, 'x'); fs.writeFileSync(live, 'x');
  store.save(name, [{name: 'a', value: 'b'}]);
  assert.equal(fs.existsSync(dead), false, 'a dead process\'s temp is removed');
  assert.equal(fs.existsSync(live), true, 'a live process\'s temp is left alone');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(), ['web.enc', path.basename(live)].sort());
  assert.deepEqual(store.load(name), [{name: 'a', value: 'b'}]);
  fs.unlinkSync(live);
});

test('secure-store: a rename that keeps failing removes its temp file and throws', () => {
  const name = 'accounts/rename-fail/web.enc';
  const target = store.file(name);
  fs.mkdirSync(target, {recursive: true}); // a folder where the file should be: the rename cannot succeed
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  assert.throws(() => store.save(name, ['v']));
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['web.enc']);
});

test('pool: a quota failover never moves to an account that is used up too', async () => {
  const pool = require('../src/account-pool');
  const second = accounts.add('Quota Second');
  try {
    const statusesFn = async () => [
      {id: 'default', available: true, percentUsed: 100, quotaStatus: 'INSUFFICIENT'},
      {id: second.id, available: true, percentUsed: 100, quotaStatus: 'INSUFFICIENT'},
    ];
    const p = pool.makePool({statusesFn, bundleFn: a => ({account: a})});
    assert.equal(await p.next(new Set(['default']), {alive: true}), null, 'nowhere with allowance left');
    assert.equal(await p.peek(new Set(['default'])), null, 'and no exhausted account is named as the next');
    assert.equal((await p.next(new Set(['default'])))?.account.id, second.id, 'a lapsed login may still move to it');
  } finally { accounts.remove(second.id); }
});

test('agent: a chat started on an account is tagged with it', () => {
  const {Agent} = require('../src/agent');
  const sessions = require('../src/sessions');
  const a = new Agent({client: stubClient(), auth: bundleFor('second-account', 'Second').auth, cwd: process.cwd(), web: {jar: []},
    accountId: 'second-account', accountLabel: 'Second', accountFiles: accounts.filesFor('second-account')});
  a.session = sessions.create(process.cwd()); // /new
  assert.equal(a.session.account, 'second-account');
  const old = {id: 'pre-multi', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 4};
  a.session = old; // a resumed chat keeps what it says (here: nothing)
  assert.equal(old.account, undefined);
  a.close();
});

test('pc-login: Muse Desktop Community\'s SDK token is shared only with the account it belongs to', async () => {
  const {pcLogin} = require('../src/pc-login');
  const desktop = require('../src/desktop-import');
  const orig = desktop.desktopSdkToken;
  desktop.desktopSdkToken = () => ({sdkToken: 'mgst_app', sdkTokenId: 'app-token'});
  const run = async (tokens, file) => {
    const infos = [];
    const web = {
      sdkRequest: async () => ({tokens, maxActiveTokens: 1}),
      nativeRequest: async () => { throw new Error('stop here'); },
      fetchJson: async () => ({}),
    };
    const ui = {info: s => infos.push(s), close() {}, ask: async () => 'a@b.c', confirm: async () => true, pick: async () => 0, busy: async (_l, fn) => fn()};
    const err = await pcLogin(web, ui, {file}).then(() => null, e => e);
    return {err, infos, saved: store.load(file)};
  };
  try {
    const other = await run([{id: 'someone-elses'}], 'accounts/pc-other/device.enc');
    assert.match(other.err.message, /上限/);
    assert.equal(other.saved, null, 'another account\'s token is never saved');
    const own = await run([{id: 'app-token'}], 'accounts/pc-own/device.enc');
    assert.ok(own.infos.some(s => /共有します/.test(s)), 'the account the app is signed in to still shares it');
    assert.equal(own.saved?.sdkToken, 'mgst_app');
  } finally { desktop.desktopSdkToken = orig; }
});

test('pc-login: a shared SDK token with no id is never adopted (audit #189)', async () => {
  const {pcLogin} = require('../src/pc-login');
  const desktop = require('../src/desktop-import');
  const orig = desktop.desktopSdkToken;
  desktop.desktopSdkToken = () => ({sdkToken: 'mgst_app', sdkTokenId: undefined});
  try {
    const web = {
      sdkRequest: async () => ({tokens: [{id: 'app-token'}], maxActiveTokens: 1}),
      nativeRequest: async () => { throw new Error('stop here'); },
      fetchJson: async () => ({}),
    };
    const ui = {info: () => {}, close() {}, ask: async () => 'a@b.c', confirm: async () => true, pick: async () => 0, busy: async (_l, fn) => fn()};
    const err = await pcLogin(web, ui, {file: 'accounts/pc-noid/device.enc'}).then(() => null, e => e);
    assert.match(err.message, /確認できません/);
    assert.equal(store.load('accounts/pc-noid/device.enc'), null, 'an unverifiable token is never saved into any account');
  } finally { desktop.desktopSdkToken = orig; }
});

test('agent: a turn sent while the login has lapsed fails over first (Focus on or off)', async () => {
  const {Agent} = require('../src/agent');
  for (const focusEnabled of [false, true]) {
    const lapsed = stubClient();
    lapsed.status = 'auth_required';
    lapsed.connect = async () => { throw Object.assign(new Error('login expired'), {loginExpired: true}); };
    const pool = {next: async exclude => exclude.has('default') ? bundleFor('second-account', 'Second') : null, drop() {}};
    const a = new Agent({client: lapsed, auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []}, focusEnabled,
      accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default'), accountPool: pool});
    a.connectDevice = async () => { a.device = {connected: true, disconnect() {}}; };
    let ranOn = null;
    a.runTurn = async () => { ranOn = a.accountId; throw new Error('stop'); };
    await assert.rejects(() => a.send('hello'), /stop/);
    assert.equal(ranOn, 'second-account', 'focus ' + focusEnabled + ': the turn runs on the account failed over to');
    a.close();
  }
});

test('accounts: rename refuses an account that does not exist (it used to create one)', () => {
  assert.throws(() => accounts.rename('no-such-account', 'X'), /見つかりません/);
  assert.equal(accounts.get('no-such-account'), null);
});

test('accounts: registry changes from several processes at once are not lost', async () => {
  const {spawn} = require('node:child_process');
  const script = "const a=require(process.argv[1]);for(let i=0;i<15;i++){a.add(process.argv[2]+'-'+i);a.setActive('default');}";
  // Children ran with stdio:'ignore' and no timeout (audit #256): a child that died or
  // hung under lock contention left no output to diagnose, or hung the suite. Capture
  // their output, bound the wait, and name the child in every failure.
  const run = tag => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'accounts.js'), tag], {env: {...process.env}});
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} rej(new Error('race child ' + tag + ' did not exit within 120 s; output: ' + out.slice(-500))); }, 120000);
    timer.unref?.();
    p.on('error', e => { clearTimeout(timer); rej(new Error('race child ' + tag + ' failed to start: ' + e.message)); });
    p.on('exit', c => { clearTimeout(timer); c === 0 ? res() : rej(new Error('race child ' + tag + ' exit ' + c + '; output: ' + out.slice(-500))); });
  });
  await Promise.all([run('racea'), run('raceb'), run('racec'), run('raced')]);
  const ids = accounts.list().map(a => a.id).filter(id => id.startsWith('race'));
  try { assert.equal(ids.length, 60, 'every add survived; found ' + ids.length + ': ' + ids.join(',')); }
  finally { for (const id of ids) accounts.remove(id); }
});

test('accounts: the Muse name is remembered per account; the old single name is the first account\'s', () => {
  const f = store.file('identity.json');
  // Restore whatever was there before (or its absence) even when an assert
  // fails: the identity file is shared by every test in this file (t8 #2).
  const prior = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, JSON.stringify({name: 'Kaguya'}));
    assert.equal(accounts.museName('default'), 'Kaguya');
    assert.equal(accounts.museName('second-account'), 'Muse', 'another account never shows the first one\'s Muse');
    accounts.rememberMuseName('second-account', 'Mizuki');
    assert.equal(accounts.museName('second-account'), 'Mizuki');
    assert.equal(accounts.museName('default'), 'Kaguya');
  } finally {
    try { if (prior === null) fs.unlinkSync(f); else fs.writeFileSync(f, prior); } catch {}
  }
});

test('pool: sameMuse finds another account logged in to the same Muse', async () => {
  const pool = require('../src/account-pool');
  const b = accounts.add('Same B'), c = accounts.add('Same C');
  try {
    const vms = {default: 'vm-1', [b.id]: 'vm-2', [c.id]: 'vm-1'};
    assert.equal((await pool.sameMuse(c.id, {vmOf: async a => vms[a.id]})).id, 'default');
    assert.equal(await pool.sameMuse(b.id, {vmOf: async a => vms[a.id]}), null);
  } finally { accounts.remove(b.id); accounts.remove(c.id); }
});

test('config: updates from several processes at once are not lost (EPERM on a lock being deleted is not "unlocked")', async () => {
  const {spawn} = require('node:child_process');
  const cfg = require('../src/config');
  const script = "const c=require(process.argv[1]);for(let i=0;i<40;i++)c.update(x=>{x['k_'+process.argv[2]+'_'+i]=1;});";
  // Same hardening as the accounts race above (audit #256): captured output, a bounded
  // wait, and the child named in every failure.
  const run = tag => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'config.js'), tag], {env: {...process.env}});
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} rej(new Error('config race child ' + tag + ' did not exit within 120 s; output: ' + out.slice(-500))); }, 120000);
    timer.unref?.();
    p.on('error', e => { clearTimeout(timer); rej(new Error('config race child ' + tag + ' failed to start: ' + e.message)); });
    p.on('exit', c => { clearTimeout(timer); c === 0 ? res() : rej(new Error('config race child ' + tag + ' exit ' + c + '; output: ' + out.slice(-500))); });
  });
  await Promise.all(['a', 'b', 'c', 'd'].map(run));
  const keys = Object.keys(cfg.read()).filter(k => k.startsWith('k_'));
  try { assert.equal(keys.length, 160, 'every update survived; found ' + keys.length); }
  finally { cfg.update(x => { for (const k of keys) delete x[k]; }); }
});

test('agent: a switch that fails after the links came down goes back to the old account', async () => {
  const {Agent} = require('../src/agent');
  const first = stubClient();
  const a = new Agent({client: first, auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    session: {id: 'stay-session', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 2},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default')});
  let calls = 0;
  a.connectDevice = async () => { calls++; throw new Error('device link refused'); };
  const seen = [];
  a.on('account', ev => seen.push(ev));
  const target = bundleFor('second-account', 'Second');
  await assert.rejects(() => a.switchAccount(target), /device link refused/);
  assert.equal(calls, 1);
  assert.equal(a.accountId, 'default');
  assert.equal(a.accountLabel, 'default');
  assert.equal(a.session.id, 'stay-session');
  assert.equal(a.client, first, 'the old gateway client is the current one again');
  assert.equal(target.client.disconnected, true, 'the new one is let go');
  assert.deepEqual(seen, [], 'no switch is announced');
  a.close();
});

test('agent: a target whose device registration does not match its VM is refused before teardown', async () => {
  const {Agent} = require('../src/agent');
  const first = stubClient();
  const a = new Agent({client: first, auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default')});
  const target = bundleFor('second-account', 'Second');
  target.auth.vm = async () => { throw Object.assign(new Error('mismatch'), {deviceMismatch: true}); };
  await assert.rejects(() => a.switchAccount(target), /mismatch/);
  assert.equal(first.disconnected, undefined);
  assert.equal(a.accountId, 'default');
  a.close();
});

test('agent: a device registration that no longer matches the VM fails over like a lapsed login', async () => {
  const {Agent} = require('../src/agent');
  const pool = {next: async exclude => exclude.has('default') ? bundleFor('second-account', 'Second') : null, drop() {}};
  const a = new Agent({client: stubClient(), auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
    accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default'), accountPool: pool});
  a.subscribed = true;
  let first = true;
  a.connectDevice = async () => { if (first) { first = false; throw Object.assign(new Error('PC 端末の認証先が一致しません'), {deviceMismatch: true}); } a.device = {connected: true, disconnect() {}}; };
  await a.ensureConnected();
  assert.equal(a.accountId, 'second-account');
  a.close();
});

test('pool: one account whose saved login cannot be read does not fail every status', async () => {
  const pool = require('../src/account-pool');
  const bad = accounts.add('Broken Jar');
  try {
    const f = store.file(accounts.filesFor(bad.id).web);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, 'not dpapi at all');
    const all = await pool.statuses({plans: false});
    const row = all.find(s => s.id === bad.id);
    assert.equal(row.hasLogin, false);
    assert.equal(row.unreadable, true);
    assert.ok(all.some(s => s.id === 'default'), 'the other accounts are still listed');
  } finally { accounts.remove(bad.id); }
});

test('accounts: a slug collision makes a valid id; rename refuses a label in use; remove leaves the registry first', () => {
  const long = 'x'.repeat(45);
  const a = accounts.add(long + 'a'), b = accounts.add(long + 'b');
  try {
    assert.ok(accounts.validId(b.id) && b.id.length <= 40, 'collision id ' + b.id);
    assert.ok(accounts.get(b.id), 'and it is still there after a re-read');
    assert.throws(() => accounts.rename(b.id, long + 'A'), /既にあります/);
    accounts.rename(b.id, 'renamed');
    assert.equal(accounts.get(b.id).label, 'renamed');
  } finally { accounts.remove(a.id); accounts.remove(b.id); }
  assert.equal(accounts.get(a.id), null);
});

test('settings: the unanswered-limit choice made in another window counts at once', () => {
  const settings = require('../src/settings');
  const cfg = require('../src/config');
  settings.reloadSwitches();
  assert.equal(settings.quotaFallback(), 'auto');
  cfg.update(x => { x.quotaFallback = 'handover'; }); // another window's /settings
  assert.equal(settings.quotaFallback(), 'handover');
  cfg.update(x => { delete x.quotaFallback; });
  settings.reloadSwitches();
});

test('agent: a switch moves the window, never the default account', async () => {
  const {Agent} = require('../src/agent');
  const second = accounts.add('Default Stays');
  try {
    assert.equal(accounts.activeId(), 'default');
    const a = new Agent({client: stubClient(), auth: bundleFor('default', 'default').auth, cwd: process.cwd(), web: {jar: []},
      accountId: 'default', accountLabel: 'default', accountFiles: accounts.filesFor('default')});
    a.connectDevice = async () => { a.device = {connected: true, disconnect() {}}; };
    await a.switchAccount(bundleFor(second.id, 'Default Stays'));
    assert.equal(a.accountId, second.id);
    assert.equal(accounts.activeId(), 'default', 'the default is still the first account');
    a.close();
  } finally { accounts.remove(second.id); }
});

// ---- audit 2026-11-03, section C (#37-#47) regression tests ----

test('choose: at a fresh start, all-unknown usage keeps the current account (audit #43)', () => {
  // Every plan read failed: both scores are Infinity, and Infinity + margin <= Infinity
  // used to "prove" the other account lighter and switch on no evidence at all.
  assert.deepEqual(accounts.choose([cand('b'), cand('a')], {currentId: 'a', fresh: true}), {id: 'a', reason: 'keep-current'});
  // A KNOWN lighter account still wins over an unknown current.
  assert.deepEqual(accounts.choose([cand('b', {percentUsed: 10}), cand('a')], {currentId: 'a', fresh: true}), {id: 'b', reason: 'least-used'});
});

test('accounts: concurrent adds of one label register it exactly once (audit #37)', async () => {
  const {spawn} = require('node:child_process');
  const script = "const a=require(process.argv[1]);const fs=require('fs');try{a.add('Same Race Label');fs.writeFileSync(process.argv[3],'ok');}catch(e){fs.writeFileSync(process.argv[3],'err');}";
  // Same hardening as the #256 race above (t8 #1): captured output, a bounded
  // wait, and the child named in every failure — stdio:'ignore' with no timeout
  // left a dead or hung child undiagnosable.
  const run = tag => new Promise((res, rej) => {
    const out = path.join(os.tmpdir(), 'muser-add-race-' + tag + '-' + Date.now() + '.txt');
    const p = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'accounts.js'), tag, out], {env: {...process.env}});
    let log = '';
    p.stdout.on('data', d => { log += d; });
    p.stderr.on('data', d => { log += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} rej(new Error('add-race child ' + tag + ' did not exit within 120 s; output: ' + log.slice(-500))); }, 120000);
    timer.unref?.();
    p.on('error', e => { clearTimeout(timer); rej(new Error('add-race child ' + tag + ' failed to start: ' + e.message)); });
    p.on('exit', c => { clearTimeout(timer); c === 0 ? res(out) : rej(new Error('add-race child ' + tag + ' exit ' + c + '; output: ' + log.slice(-500))); });
  });
  const outs = await Promise.all(['w', 'x', 'y', 'z'].map(run));
  try {
    const results = outs.map(f => fs.readFileSync(f, 'utf8'));
    assert.equal(results.filter(r => r === 'ok').length, 1, 'exactly one add of the label succeeded: ' + results.join(','));
    assert.equal(accounts.list().filter(a => a.label === 'Same Race Label').length, 1);
  } finally {
    for (const f of outs) { try { fs.unlinkSync(f); } catch {} }
    const a = accounts.resolve('Same Race Label'); if (a) accounts.remove(a.id);
  }
});

test('accounts: rename does not resurrect an account that vanished before the locked change (audit #38)', () => {
  const a = accounts.add('Rename Ghost');
  const regFile = store.file('accounts.json');
  const raw = fs.readFileSync(regFile, 'utf8');
  const parsed = JSON.parse(raw);
  const ghostless = JSON.stringify({...parsed, accounts: parsed.accounts.filter(x => x.id !== a.id)});
  const origRead = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (p, ...rest) {
    if (armed && String(p) === regFile) { armed = false; fs.writeFileSync(regFile, ghostless); return ghostless; }
    return origRead.call(fs, p, ...rest);
  };
  try { assert.throws(() => accounts.rename(a.id, 'Ghost Renamed'), /見つかりません/); }
  finally { fs.readFileSync = origRead; fs.writeFileSync(regFile, raw); }
  assert.equal(accounts.get(a.id)?.label, 'Rename Ghost', 'the account itself is untouched');
  accounts.remove(a.id);
});

test('accounts: renaming the default account only overrides its label (audit #38)', () => {
  accounts.rename('default', 'Main One');
  try { assert.equal(accounts.get('default').label, 'Main One'); }
  finally { accounts.rename('default', 'default'); }
});

test('accounts: a corrupt registry read falls back to the last good registry (audit #39)', () => {
  const a = accounts.add('Corrupt Guard');
  const regFile = store.file('accounts.json');
  const raw = fs.readFileSync(regFile, 'utf8');
  try {
    fs.writeFileSync(regFile, 'this is not json');
    assert.equal(accounts.get(a.id)?.label, 'Corrupt Guard', 'a corrupt file is not an empty registry');
  } finally { fs.writeFileSync(regFile, raw); accounts.remove(a.id); }
});

test('accounts: a holder whose registry lock was stolen does not write (audit #40 fencing)', () => {
  const regFile = store.file('accounts.json'), lockFile = regFile + '.lock';
  const origRead = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (p, ...rest) {
    const out = origRead.call(fs, p, ...rest);
    if (armed && String(p) === regFile) { armed = false; fs.writeFileSync(lockFile, 'thief-token'); }
    return out;
  };
  try { assert.throws(() => accounts.add('Fencing Victim'), /使用中/); }
  finally { fs.readFileSync = origRead; try { fs.unlinkSync(lockFile); } catch {} }
  assert.equal(accounts.resolve('Fencing Victim'), null, 'the stolen holder wrote nothing');
});

test('accounts: a corrupt identity file is left alone, not clobbered (audit #41)', () => {
  const f = store.file('identity.json');
  fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.writeFileSync(f, 'garbage{');
  accounts.rememberMuseName('default', 'Should Not Land');
  assert.equal(fs.readFileSync(f, 'utf8'), 'garbage{', 'the unreadable file survives for recovery');
  fs.unlinkSync(f);
  accounts.rememberMuseName('default', 'Lands Fine');
  assert.equal(accounts.museName('default'), 'Lands Fine');
  fs.unlinkSync(f);
});

test('accounts: Muse names remembered from several processes at once are not lost (audit #41)', async () => {
  const {spawn} = require('node:child_process');
  const script = "const a=require(process.argv[1]);for(let i=0;i<15;i++)a.rememberMuseName('conc-'+process.argv[2],'Name-'+process.argv[2]);";
  const run = tag => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'accounts.js'), tag], {env: {...process.env}});
    let log = '';
    p.stdout.on('data', d => { log += d; });
    p.stderr.on('data', d => { log += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} rej(new Error('name-race child ' + tag + ' did not exit within 120 s; output: ' + log.slice(-500))); }, 120000);
    timer.unref?.();
    p.on('error', e => { clearTimeout(timer); rej(new Error('name-race child ' + tag + ' failed to start: ' + e.message)); });
    p.on('exit', c => { clearTimeout(timer); c === 0 ? res() : rej(new Error('name-race child ' + tag + ' exit ' + c + '; output: ' + log.slice(-500))); });
  });
  await Promise.all(['0', '1', '2', '3'].map(run));
  try { for (const i of ['0', '1', '2', '3']) assert.equal(accounts.museName('conc-' + i), 'Name-' + i); }
  finally { try { fs.unlinkSync(store.file('identity.json')); } catch {} }
});

test('pool: concurrent warm()s build and connect once, leaking no bundle (audit #45)', async () => {
  delete process.env.MUSER_NO_ACCOUNT_AUTO;
  if (!accounts.get('pool-peer')) accounts.add('Pool Peer');
  const made = [];
  let connects = 0;
  const pool = poolMod.makePool({
    statusesFn: async () => poolStatuses(),
    bundleFn: account => { const b = {account, files: {}, web: {}, auth: {}, client: stubPoolClient()}; made.push(b); return b; },
    connectFn: async b => { connects++; await new Promise(r => setTimeout(r, 30)); await b.client.connect(); },
  });
  const [s1, s2] = await Promise.all([pool.warm(new Set()), pool.warm(new Set())]);
  assert.equal(s1.id, 'pool-peer');
  assert.equal(s2.id, 'pool-peer');
  assert.equal(made.length, 1, 'one bundle was built');
  assert.equal(connects, 1, 'one connect happened');
  pool.drop();
  assert.equal(made[0].client.disconnects, 1, 'the single warmed bundle stays reachable for drop()');
});

test('pool: peek, warm and next share one statuses read and one pick (audit #46)', async () => {
  delete process.env.MUSER_NO_ACCOUNT_AUTO;
  if (!accounts.get('pool-peer')) accounts.add('Pool Peer');
  let reads = 0;
  const made = [];
  const pool = poolMod.makePool({
    statusesFn: async () => { reads++; return poolStatuses(); },
    bundleFn: account => { const b = {account, files: {}, web: {}, auth: {}, client: stubPoolClient()}; made.push(b); return b; },
    connectFn: async b => { await b.client.connect(); },
  });
  assert.equal((await pool.peek(new Set())).id, 'pool-peer');
  assert.equal((await pool.warm(new Set())).id, 'pool-peer');
  const got = await pool.next(new Set());
  assert.equal(got, made[0], 'next took the very bundle warm connected');
  assert.equal(reads, 1, 'one statuses read served the whole sequence');
});

test('pool: an alive-only next does not take a warmed bundle whose account is used up (audit #46)', async () => {
  delete process.env.MUSER_NO_ACCOUNT_AUTO;
  if (!accounts.get('pool-peer')) accounts.add('Pool Peer');
  const exhausted = [pstat('default', {percentUsed: 100, quotaStatus: 'INSUFFICIENT'}), pstat('pool-peer', {percentUsed: 100, quotaStatus: 'INSUFFICIENT'})];
  const {pool, made} = makeStubPool(exhausted);
  await pool.warm(new Set(['default'])); // warm picks without the alive rule
  assert.equal(pool.warmedId(), 'pool-peer');
  assert.equal(await pool.next(new Set(['default']), {alive: true}), null, 'nowhere with allowance left, warmed or not');
  assert.equal(pool.warmedId(), 'pool-peer', 'the warmed bundle was not handed out');
  assert.equal((await pool.next(new Set(['default']))), made[0], 'a plain next still takes it');
});

test('pool: statuses never writes the account jar back (audit #44)', async () => {
  const pool = require('../src/account-pool');
  const web = require('../src/web');
  const usage = require('../src/usage');
  const a = accounts.add('Probe Jar');
  const files = accounts.filesFor(a.id);
  const cookie = (name, value) => ({name, value, domain: '.muse.ai', path: '/', expires: -1, secure: true});
  const origPlan = usage.plan, origFetch = global.fetch;
  try {
    web.saveJar([cookie('s', 'v1')], files.web);
    // Mid-read, the live window saves its newer jar; the status read's own response then
    // carries a Set-Cookie. That refresh must land in the scratch jar, never in web.enc.
    usage.plan = async w => {
      web.saveJar([cookie('s', 'v2'), cookie('w', 'win')], files.web);
      await w.fetchJson('/api/session');
      return {percentUsed: 7, quotaStatus: 'SUFFICIENT'};
    };
    global.fetch = async () => ({ok: true, status: 200, headers: {getSetCookie: () => ['s=v3; Domain=.muse.ai; Path=/']}, json: async () => ({})});
    const all = await pool.statuses();
    assert.equal(all.find(s => s.id === a.id).percentUsed, 7);
    assert.deepEqual(web.loadJar(files.web), [cookie('s', 'v2'), cookie('w', 'win')], 'the window save stands; the status read saved nothing over it');
    assert.deepEqual(fs.readdirSync(path.dirname(store.file(files.web))).filter(n => n.includes('.probe-')), [], 'no scratch jar is left behind');
  } finally { usage.plan = origPlan; global.fetch = origFetch; accounts.remove(a.id); }
});

test('pool: sameMuse reports a failed check instead of calling it no-duplicate (audit #47)', async () => {
  const pool = require('../src/account-pool');
  const b = accounts.add('Same Err');
  try {
    await assert.rejects(pool.sameMuse(b.id, {vmOf: async a => { if (a.id === b.id) return 'vm-1'; throw new Error('network down'); }}), /could not check/);
    await assert.rejects(pool.sameMuse(b.id, {vmOf: async () => { throw new Error('network down'); }}), /network down/);
  } finally { accounts.remove(b.id); }
});
