'use strict';
// 依頼 SD: the contact entered for device registration is remembered
// (per account, in the encrypted store) once the verification code has
// passed, and offered as the initial value on the next registration.
// The store is injected through pcLogin's opts.store (a Map-backed fake in
// the PcAuth load/save shape); one test also round-trips the real DPAPI
// store under the scratch LOCALAPPDATA that tests/setup.mjs provides.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// clackUi is tested through a fake @clack/prompts, installed BEFORE
// src/tui/onboard is required (the require.cache pattern of
// fix2-muse-client.test.js). The fake's text() records its options and
// answers through textImpl, which each clack test sets.
let textOpts = null;
let textImpl = async opts => opts.initialValue;
const clackPath = require.resolve('@clack/prompts');
require.cache[clackPath] = {id: clackPath, filename: clackPath, loaded: true, exports: {
  text: async opts => { textOpts = opts; return textImpl(opts); },
  isCancel: () => false,
  cancel: () => {},
  log: {info: () => {}, message: () => {}, step: () => {}, success: () => {}},
  confirm: async () => true,
  select: async () => 0,
  spinner: () => ({start: () => {}, stop: () => {}, message: () => {}}),
  intro: () => {}, outro: () => {},
}};

const {pcLogin, contactFileFor} = require('../src/pc-login');
const {SetupFlow} = require('../src/server/setup');
const {clackUi} = require('../src/tui/onboard');
const accounts = require('../src/accounts');
const realStore = require('../src/secure-store');

// A Map-backed secure-store: load/save/remove over store names, cloned the
// way the real store's JSON round-trip clones. Hooks let a test make the
// contact entry unreadable without touching the device entry.
function fakeStore(over = {}) {
  const map = new Map();
  return {
    map,
    load(name) {
      if (over.load) { const r = over.load(name, map); if (r !== undefined) return r; }
      return map.has(name) ? structuredClone(map.get(name)) : null;
    },
    save(name, value) { map.set(name, structuredClone(value)); },
    remove(name) { map.delete(name); },
    file(name) { return name; },
  };
}

// Spec update (audit-cli wave 8): a remembered contact is now saved as
// {contact, savedAt} — savedAt is an ISO timestamp recording when the
// contact was proven, so the saved value is no longer deep-equal to a
// bare {contact}. This helper pins the new shape wherever a saved value
// is asserted below: the contact itself, a parseable savedAt, and no
// other keys. (Seeded inputs in {contact} shape stay as they are: the
// reader still tolerates the pre-stamp shape.)
function assertSavedContact(saved, contact) {
  assert.equal(saved && saved.contact, contact);
  assert.equal(typeof (saved && saved.savedAt), 'string', 'the saved value carries a savedAt stamp');
  assert.ok(!Number.isNaN(Date.parse(saved.savedAt)), 'savedAt is an ISO timestamp: ' + saved.savedAt);
  assert.deepEqual(Object.keys(saved).sort(), ['contact', 'savedAt']);
}

// A fake muse.ai web in the fix2-login.test.js / setup-flow.test.js shape.
function loginWeb(over = {}) {
  const counts = {confirm_otp: 0, send_otp: 0};
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route, body) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) { counts.send_otp++; if (over.sendOtp) return over.sendOtp(counts.send_otp); return {auth_state: 'as'}; }
      if (route.endsWith('/confirm_otp')) { counts.confirm_otp++; return over.confirm ? over.confirm(counts.confirm_otp, body) : {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/select_account')) return over.select ? over.select(body) : {abra_access_token: 'abra', abra_user_id: 'u1'};
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
  const infos = [], asks = [];
  const ui = {note: () => {}, info: s => infos.push(s), close() { this.closed = true; },
    confirm: async () => true, pick: over.pick || (async () => 0), busy: async (_l, fn) => fn(),
    ask: async (q, opts = {}) => { asks.push({q, hint: opts.hint, placeholder: opts.placeholder, initial: opts.initial ?? null}); if (over.ask) return over.ask(q, opts); const v = answers.shift(); if (v === undefined) throw new Error('no scripted answer for: ' + q); return v; }};
  return {ui, infos, asks};
}
const contactAsks = asks => asks.filter(a => a.q.includes('メールアドレス'));
let fileSeq = 0;
const nextFile = () => 'setup-contact-' + (++fileSeq) + '/device.enc';

test('setup-contact: the contact file sits next to the device file, per account', () => {
  assert.equal(contactFileFor('device.enc'), 'contact.enc');
  assert.equal(contactFileFor('accounts/work/device.enc'), 'accounts/work/contact.enc');
  assert.equal(contactFileFor(undefined), 'contact.enc');
  assert.equal(accounts.filesFor('default').contact, 'contact.enc');
  assert.equal(accounts.filesFor('work').contact, 'accounts/work/contact.enc');
  assert.equal(accounts.filesFor('work').device, 'accounts/work/device.enc');
});

test('setup-contact: a contact whose code passes is saved to the encrypted store', async () => {
  const store = fakeStore();
  const file = nextFile();
  const {web} = loginWeb();
  const {ui} = loginUi(['taro@example.com', '654321']);
  const auth = await pcLogin(web, ui, {file, store});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assertSavedContact(store.map.get(contactFileFor(file)), 'taro@example.com'); // wave 8: {contact, savedAt}, see assertSavedContact
});

test('setup-contact: a wrong code (all tries) saves nothing', async () => {
  const store = fakeStore();
  const file = nextFile();
  const {web} = loginWeb({confirm: () => { throw Object.assign(new Error('コードが違います'), {status: 400}); }});
  const {ui} = loginUi(['taro@example.com', '000000', '000000', '000000']);
  await assert.rejects(pcLogin(web, ui, {file, store}));
  assert.equal(store.map.has(contactFileFor(file)), false, 'no contact entry after a failed code');
});

test('setup-contact: a contact the code is never sent for saves nothing', async () => {
  const store = fakeStore();
  const file = nextFile();
  const {web} = loginWeb({sendOtp: () => { throw Object.assign(new Error('連絡先が違います'), {status: 400}); }});
  const {ui} = loginUi(['bad@example.com', 'bad@example.com', 'bad@example.com']);
  await assert.rejects(pcLogin(web, ui, {file, store}));
  assert.equal(store.map.has(contactFileFor(file)), false);
});

test('setup-contact: cancelling at the code prompt saves nothing', async () => {
  const store = fakeStore();
  const file = nextFile();
  const {web} = loginWeb();
  let n = 0;
  const {ui} = loginUi([], {ask: async () => { n++; if (n === 1) return 'taro@example.com'; throw new Error('中止しました。'); }});
  await assert.rejects(pcLogin(web, ui, {file, store}), /中止しました/);
  assert.equal(store.map.has(contactFileFor(file)), false, 'no contact entry after a cancel');
});

test('setup-contact: the next registration is asked with the saved contact as initial', async () => {
  const store = fakeStore();
  const file = nextFile();
  const first = loginWeb();
  await pcLogin(first.web, loginUi(['taro@example.com', '654321']).ui, {file, store});
  // The device registration is gone (re-registration) but the remembered
  // contact stays: the same store, the device entry removed.
  store.map.delete(file);
  const second = loginWeb();
  const run = loginUi(['taro@example.com', '654321']);
  await pcLogin(second.web, run.ui, {file, store});
  assert.equal(contactAsks(run.asks).length, 1);
  assert.equal(contactAsks(run.asks)[0].initial, 'taro@example.com', 'initial carries the saved contact');
});

test('setup-contact: clackUi passes initial to p.text as initialValue', async () => {
  // Wave 9 spec update: clackUi prompts require a terminal on stdin, so
  // this fake-prompt test now declares one (it simulates a terminal
  // prompt with the fake @clack/prompts above).
  const wasTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  try {
    textImpl = async opts => opts.initialValue;
    const v = await clackUi().ask('Muse にログインしているメールアドレス', {placeholder: 'you@example.com', initial: 'you@example.com'});
    assert.equal(textOpts.initialValue, 'you@example.com', 'the field starts filled, Enter sends it as-is');
    assert.equal(v, 'you@example.com');
    textImpl = async () => 'new@example.com';
    const v2 = await clackUi().ask('Muse にログインしているメールアドレス', {placeholder: 'you@example.com'});
    assert.equal(textOpts.initialValue, undefined, 'no saved contact: no initialValue');
    assert.equal(v2, 'new@example.com');
  } finally { process.stdin.isTTY = wasTTY; }
});

// Poll a SetupFlow's plain state until a condition holds (setup-flow.test.js).
async function waitFor(flow, pred, label) {
  for (let i = 0; i < 2000; i++) {
    const st = flow.state();
    if (pred(st)) return st;
    await new Promise(r => setImmediate(r));
  }
  throw new Error('timed out waiting for ' + label + '; last state: ' + JSON.stringify(flow.state()));
}
const waitPrompt = (flow, kind) => waitFor(flow, st => !!st.prompt && (!kind || st.prompt.kind === kind), 'prompt ' + (kind || ''));
const noLogin = {needs: async () => ({login: false, device: true}), login: async () => { throw new Error('login must not run'); }};

test('setup-contact: httpUi puts the saved contact in prompt.initial, and nowhere else in state', async () => {
  const store = fakeStore();
  const file = nextFile();
  store.map.set(contactFileFor(file), {contact: 'taro@example.com'});
  const {web} = loginWeb();
  const flow = new SetupFlow({...noLogin, register: ui => pcLogin(web, ui, {file, store})});
  const startP = flow.start();
  let st = await waitPrompt(flow, 'confirm');
  flow.answer({promptId: st.prompt.id, value: true});
  st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'contact');
  assert.equal(st.prompt.initial, 'taro@example.com', 'prompt.initial carries the saved contact');
  const json = JSON.stringify(st);
  assert.equal(json.split('taro@example.com').length - 1, 1, 'the full contact appears exactly once in state: prompt.initial only');
  flow.answer({promptId: st.prompt.id, value: 'taro@example.com'});
  st = await waitPrompt(flow, 'text');
  assert.equal(st.phase, 'code');
  assert.equal(st.prompt.initial, null, 'the code prompt has no initial');
  flow.answer({promptId: st.prompt.id, value: '654321'});
  await startP;
  st = flow.state();
  assert.equal(st.phase, 'done');
  assert.ok(!JSON.stringify(st).includes('taro@example.com'), 'once answered, the full contact is nowhere in state');
});

test('setup-contact: httpUi prompt.initial is null when nothing is saved', async () => {
  const flow = new SetupFlow({...noLogin, register: async ui => { await ui.ask('Muse にログインしているメールアドレス', {placeholder: 'you@example.com'}); }});
  const startP = flow.start();
  const st = await waitPrompt(flow, 'text');
  assert.equal(st.prompt.initial, null);
  flow.answer({promptId: st.prompt.id, value: 'a@b.c'});
  await startP;
  assert.equal(flow.state().phase, 'done');
});

test('setup-contact: a store whose contact entry cannot be read means no initial, and registration still works', async () => {
  const file = nextFile();
  const contactFile = contactFileFor(file);
  const store = fakeStore({load: name => { if (name === contactFile) throw new Error('broken store'); return undefined; }});
  const {web} = loginWeb();
  const run = loginUi(['taro@example.com', '654321']);
  const auth = await pcLogin(web, run.ui, {file, store});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(contactAsks(run.asks)[0].initial, null, 'no initial from an unreadable store');
});

test('setup-contact: a malformed saved contact means no initial, and registration still works', async () => {
  const store = fakeStore();
  const file = nextFile();
  store.map.set(contactFileFor(file), {contact: 42});
  const {web} = loginWeb();
  const run = loginUi(['taro@example.com', '654321']);
  const auth = await pcLogin(web, run.ui, {file, store});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(contactAsks(run.asks)[0].initial, null, 'a non-string saved contact is ignored');
  assertSavedContact(store.map.get(contactFileFor(file)), 'taro@example.com'); // wave 8: {contact, savedAt} — the proven contact replaces the malformed one
});

test('setup-contact: contacts are remembered per account', async () => {
  const store = fakeStore();
  const fileA = 'setup-contact-acct-a/device.enc', fileB = 'setup-contact-acct-b/device.enc';
  await pcLogin(loginWeb().web, loginUi(['a@example.com', '111111']).ui, {file: fileA, store});
  await pcLogin(loginWeb().web, loginUi(['b@example.com', '222222']).ui, {file: fileB, store});
  assertSavedContact(store.map.get('setup-contact-acct-a/contact.enc'), 'a@example.com'); // wave 8: {contact, savedAt}
  assertSavedContact(store.map.get('setup-contact-acct-b/contact.enc'), 'b@example.com'); // wave 8: {contact, savedAt}
  store.map.delete(fileA);
  const run = loginUi(['a@example.com', '111111']);
  await pcLogin(loginWeb().web, run.ui, {file: fileA, store});
  assert.equal(contactAsks(run.asks)[0].initial, 'a@example.com', 'account A gets its own contact back, not B');
});

test('setup-contact: logout removes the remembered default-account contact', () => {
  const {logout} = require('../src/login');
  const base = 'setup-contact-logout-' + process.pid;
  const contact = base + '/contact.enc';
  const browser = realStore.file(base + '/browser');
  realStore.save(contact, {contact: 'saved@example.com'});
  assert.ok(fs.existsSync(realStore.file(contact)));
  logout({web: base + '/web.enc', session: base + '/session.enc', contact, browser});
  assert.ok(!fs.existsSync(realStore.file(contact)), 'logout deleted contact.enc');
  fs.rmSync(path.dirname(browser), {recursive: true, force: true});
});

test('setup-contact: removing an added account removes its remembered contact', () => {
  const account = accounts.add('Contact Removal ' + process.pid);
  const files = accounts.filesFor(account.id);
  try {
    realStore.save(files.contact, {contact: 'saved@example.com'});
    assert.ok(fs.existsSync(realStore.file(files.contact)));
    const result = accounts.remove(account.id);
    assert.deepEqual(result.leftoverFiles, []);
    assert.ok(!fs.existsSync(realStore.file(files.contact)), 'account removal deleted contact.enc');
  } finally {
    if (accounts.get(account.id)) accounts.remove(account.id);
  }
});

test('setup-contact: the real store keeps the contact encrypted on disk', async () => {
  const file = nextFile();
  const {web} = loginWeb();
  const {ui} = loginUi(['real@example.com', '654321']);
  await pcLogin(web, ui, {file});
  const contactFile = contactFileFor(file);
  const raw = fs.readFileSync(realStore.file(contactFile));
  assert.ok(raw.length > 0, 'the contact file exists in the store folder');
  assert.ok(!raw.includes(Buffer.from('real@example.com')), 'the contact is not in the file in plain text');
  assertSavedContact(realStore.load(contactFile), 'real@example.com'); // wave 8: {contact, savedAt}
});
