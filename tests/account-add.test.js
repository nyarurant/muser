'use strict';
// Adding an account headless (src/account-add.js): the registry entry, the login and the
// device registration all use the NEW account's files, a login that never landed rolls
// the registration back, and a landed login keeps the account when registration fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Same isolation as tests/accounts.test.js: never the real data folder (see its header).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-acctadd-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-acctadd-home-'));

const accounts = require('../src/accounts');
const store = require('../src/secure-store');
const {addAccount} = require('../src/account-add');

const ui = {busy: async (label, fn) => fn(), info() {}, note() {}, ask: async () => '', confirm: async () => true, pick: async () => 0, close() {}};
// A login that landed: the new account's web jar now exists (hasLogin's only test).
const landedLogin = files => async () => { fs.mkdirSync(path.dirname(store.file(files.web)), {recursive: true}); fs.writeFileSync(store.file(files.web), 'x'); };
function deps(over = {}) {
  return {accounts, store: {preload() {}}, web: {createWeb: () => ({}), loadJar: () => ({})}, sameMuse: async () => null, ...over};
}

test('account-add: success walks login then device registration with the new account files', async () => {
  const calls = [];
  let files;
  const out = await addAccount('Add One', {ui, deps: deps({
    login: async o => { calls.push(['login', o.jarFile, o.profile]); files = accounts.filesFor(accounts.resolve('Add One').id); await landedLogin(files)(o); },
    pcLogin: async (web, u, opts) => { calls.push(['pc', opts.file]); assert.equal(u, ui); },
  })});
  try {
    assert.equal(out.account.label, 'Add One');
    assert.equal(out.same, null);
    assert.deepEqual(calls.map(c => c[0]), ['login', 'pc'], 'login first, registration second');
    assert.equal(calls[0][1], files.web, 'the login writes the new account jar');
    assert.equal(calls[0][2], files.browser, 'the login uses the new account Edge profile');
    assert.equal(calls[1][1], files.device, 'the registration writes the new account device file');
    assert.equal(accounts.hasLogin(out.account.id), true);
  } finally { accounts.remove(out.account.id); }
});

test('account-add: a login that never lands removes the registration again', async () => {
  await assert.rejects(addAccount('Add Two', {ui, deps: deps({
    login: async () => { throw new Error('window closed'); },
    pcLogin: async () => { throw new Error('must not run'); },
  })}), /window closed/);
  assert.equal(accounts.resolve('Add Two'), null, 'the name is free again');
});

test('account-add: a landed login keeps the account when registration fails', async () => {
  let id;
  await assert.rejects(addAccount('Add Three', {ui, deps: deps({
    login: async () => { id = accounts.resolve('Add Three').id; await landedLogin(accounts.filesFor(id))(); },
    pcLogin: async () => { throw new Error('code never arrived'); },
  })}), /code never arrived/);
  try { assert.ok(accounts.get(id), 'the account stays, half set up, as with the CLI'); }
  finally { accounts.remove(id); }
});

test('account-add: a partial jar left by a failed login does not keep the account (audit #48)', async () => {
  await assert.rejects(addAccount('Add Partial', {ui, deps: deps({
    // The login poll saves a partial jar before the login is ready; the login then fails.
    login: async () => { await landedLogin(accounts.filesFor(accounts.resolve('Add Partial').id))(); throw new Error('browser closed'); },
    pcLogin: async () => { throw new Error('must not run'); },
  })}), /browser closed/);
  assert.equal(accounts.resolve('Add Partial'), null, 'the name is free again despite the partial jar');
});

test('account-add: a rollback leftover is reported on the thrown error (audit #48)', async () => {
  const fakeAccounts = {
    add: () => ({id: 'fake-1'}),
    filesFor: () => ({web: 'fake/web.enc', device: 'fake/device.enc', session: 'fake/session.enc', browser: 'fake/browser'}),
    remove: () => ({leftover: 'C:\\ leftover'}),
  };
  const err = await addAccount('Fake', {ui, deps: {
    accounts: fakeAccounts, store: {preload() {}}, web: {createWeb: () => ({}), loadJar: () => []},
    login: async () => { throw new Error('no login'); }, pcLogin: async () => {}, sameMuse: async () => null,
  }}).then(() => null, e => e);
  assert.match(err.message, /no login/);
  assert.equal(err.rollbackLeftover, 'C:\\ leftover');
});

test('account-add: a failed same-Muse check is flagged, not reported as distinct (audit #47)', async () => {
  const out = await addAccount('Add Five', {ui, deps: deps({
    login: async () => { await landedLogin(accounts.filesFor(accounts.resolve('Add Five').id))(); },
    pcLogin: async () => {},
    sameMuse: async () => { throw new Error('muse.ai unreachable'); },
  })});
  try {
    assert.equal(out.same, null);
    assert.equal(out.sameCheckFailed, true);
  } finally { accounts.remove(out.account.id); }
});

test('account-add: the same-Muse warning is passed through', async () => {
  const out = await addAccount('Add Four', {ui, deps: deps({
    login: async () => { await landedLogin(accounts.filesFor(accounts.resolve('Add Four').id))(); },
    pcLogin: async () => {},
    sameMuse: async () => ({id: 'default', label: 'default'}),
  })});
  try { assert.equal(out.same.label, 'default'); }
  finally { accounts.remove(out.account.id); }
});
