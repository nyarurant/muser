'use strict';
// Audit 2026-11-03, section M (#200-#207): src/web.js regression tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The #42 test below adds/removes accounts in-process and calls
// store.remove('web.enc') on the DEFAULT store — the account registry and the
// encrypted jars live in muser's real data folder under %LOCALAPPDATA%.
// Point every folder at a throwaway one BEFORE loading any src module,
// mirroring tests/accounts.test.js: `npm test` already isolates via
// tests/setup.mjs, but a bare `node --test tests/web.test.js` skips that file
// and would otherwise delete the user's real saved web jar (web.enc) and
// mutate their real account registry.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-web-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-web-test-home-'));

const web = require('../src/web');

function stubFetch(t, impl) {
  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  global.fetch = impl;
}
const res = ({ok = true, status = 200, json = async () => ({}), text = async () => ''}) =>
  ({ok, status, headers: {getSetCookie: () => []}, json, text});

test('#207: absorb deletes the stored cookie on Max-Age=0 / a past Expires', () => {
  const jar = [];
  const r = lines => ({headers: {getSetCookie: () => lines}});
  web.absorb(jar, 'https://muse.ai/', r(['sid=abc; Path=/; Max-Age=3600']));
  assert.equal(jar.length, 1);
  assert.equal(web.absorb(jar, 'https://muse.ai/', r(['sid=; Path=/; Max-Age=0'])), true);
  assert.equal(jar.length, 0, 'Max-Age=0 removed the cookie instead of storing a dead one');
  web.absorb(jar, 'https://muse.ai/', r(['x=1; Path=/']));
  assert.equal(jar.length, 1);
  web.absorb(jar, 'https://muse.ai/', r(['x=; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT']));
  assert.equal(jar.length, 0, 'a past Expires removed the cookie too');
  assert.equal(web.cookieHeader(jar, 'https://muse.ai/'), '');
});

test('#201: call failures are classified — timeout / redirect / jar errors are not network errors', async t => {
  stubFetch(t, async () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.timeout === true && e.network === undefined);

  stubFetch(t, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.network === true, 'a real fetch failure stays a network error');

  stubFetch(t, async () => { throw new TypeError('Unexpected redirect'); });
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.redirect === true && e.network === undefined);

  // A malformed jar throws inside cookieHeader before fetch: a local TypeError, not "cannot connect".
  stubFetch(t, async () => { throw new Error('fetch must not be reached'); });
  await assert.rejects(web.createWeb([{name: 'x', value: '1'}]).fetchJson('/api/session'), e => e instanceof TypeError && e.network === undefined);
});

test('#200 web: a caller signal is passed to fetch and its abort is not relabelled', async t => {
  let fetchSignal;
  stubFetch(t, (url, opts) => { fetchSignal = opts.signal; return new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); }); });
  const ctrl = new AbortController();
  const p = web.createWeb([]).nativeRequest('device', '/fetch_vms', undefined, 'bearer', ctrl.signal);
  // t7 #17 (deep audit): was a fixed 10 ms sleep — under load fetch had not
  // been reached yet on correct code. Wait for the fetch call itself.
  for (let i = 0; i < 200 && !fetchSignal; i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(fetchSignal, 'fetch received a signal');
  ctrl.abort();
  await assert.rejects(p, e => e.name === 'AbortError' && e.network === undefined && e.timeout === undefined);
  assert.equal(fetchSignal.aborted, true, 'the combined signal fired with the caller’s');
});

test('#202: slow bodies are timeouts, not parse failures; pageText wraps them too', async t => {
  const slowJson = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  stubFetch(t, async () => res({json: slowJson}));
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.timeout === true && e.parse === undefined);
  await assert.rejects(web.createWeb([]).nativeRequest('device', '/fetch_vms', undefined, 'b'), e => e.timeout === true && e.parse === undefined);
  await assert.rejects(web.createWeb([]).sdkRequest('GET'), e => e.timeout === true && e.parse === undefined);

  const slowText = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  stubFetch(t, async () => res({text: slowText}));
  await assert.rejects(web.createWeb([]).pageText('/'), e => e.timeout === true && e.status === 200 && !(e instanceof DOMException));
  await assert.rejects(web.createWeb([]).serverAction('id1', []), e => e.timeout === true);

  // A genuine parse failure is still marked parse (existing behaviour).
  stubFetch(t, async () => res({json: async () => { throw new SyntaxError('nope'); }}));
  await assert.rejects(web.createWeb([]).nativeRequest('device', '/fetch_vms', undefined, 'b'), e => e.parse === true && e.status === 200);
});

test('#203: nativeRequest keeps the server error detail on HTTP errors', async t => {
  stubFetch(t, async () => res({ok: false, status: 400, json: async () => ({error: {message: 'otp code expired'}})}));
  await assert.rejects(web.createWeb([]).nativeRequest('auth', '/hatch/auth/confirm_otp', {}, 'b'),
    e => e.status === 400 && /otp code expired/.test(e.message) && e.serverError === 'otp code expired');
  stubFetch(t, async () => res({ok: false, status: 500, json: async () => ({})}));
  await assert.rejects(web.createWeb([]).nativeRequest('auth', '/hatch/auth/start', {}, 'b'),
    e => e.status === 500 && e.serverError === undefined, 'no detail in the body: bare HTTP error as before');
});

test('#204: fetchJson only calls auth statuses a lapsed login', async t => {
  stubFetch(t, async () => res({ok: false, status: 500}));
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.status === 500 && !/ログインが必要/.test(e.message) && /HTTP 500/.test(e.message));
  stubFetch(t, async () => res({ok: false, status: 429}));
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.status === 429 && !/ログインが必要/.test(e.message));
  stubFetch(t, async () => res({ok: false, status: 401}));
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'), e => e.status === 401 && /ログインが必要/.test(e.message));
});

test('#205/#206: probe treats garbage/token-network failures as error and does not re-mint when ready', async t => {
  // Session body that is not JSON -> 'error', never 'waiting'.
  stubFetch(t, async () => res({json: async () => { throw new SyntaxError('<html>portal</html>'); }}));
  assert.equal(await web.probe([]), 'error');

  // Session fine, token fetch network-fails -> 'error', not 'token'.
  stubFetch(t, async url => String(url).includes('/api/hatch/token') ? Promise.reject(new TypeError('fetch failed')) : res({json: async () => ({endpoint_url: 'https://vm.example', vm_id: 'vm1', vm_name: 'n'})}));
  assert.equal(await web.probe([]), 'error');

  // A ready probe is cached per jar: the token endpoint (force_refresh mint) runs once.
  let tokenCalls = 0, sessionCalls = 0;
  stubFetch(t, async url => {
    if (String(url).includes('/api/hatch/token')) { tokenCalls++; return res({json: async () => ({token: 'tok'})}); }
    sessionCalls++; return res({json: async () => ({endpoint_url: 'https://vm.example', vm_id: 'vm1', vm_name: 'n'})});
  });
  const jar = [];
  assert.equal(await web.probe(jar), 'ready');
  assert.equal(await web.probe(jar), 'ready');
  assert.equal(tokenCalls, 1, 'the second probe did not mint another token');
  assert.equal(sessionCalls, 1);
});

test('#42: a live web instance does not resurrect a removed account’s web.enc', async t => {
  const fs = require('node:fs');
  const accounts = require('../src/accounts');
  const store = require('../src/secure-store');
  const cookie = (name, value) => ({name, value, domain: '.muse.ai', path: '/', expires: -1, secure: true});
  const refresh = value => async () => ({ok: true, status: 200, headers: {getSetCookie: () => [`s=${value}; Domain=.muse.ai; Path=/; Secure`]}, json: async () => ({}), text: async () => ''});

  // A registered account saves normally, through the live instance's absorb path too.
  const live = accounts.add('Live Ghost');
  const liveFiles = accounts.filesFor(live.id);
  try {
    const w = web.createWeb([cookie('s', 'v1')], {file: liveFiles.web});
    stubFetch(t, refresh('v2'));
    await w.fetchJson('/api/session');
    assert.equal(fs.existsSync(store.file(liveFiles.web)), true, 'a registered account’s jar still saves');
    assert.deepEqual(web.loadJar(liveFiles.web), [cookie('s', 'v2')], 'the absorbed refresh is what was saved');
  } finally { accounts.remove(live.id); }

  // The window keeps running on its in-memory jar after its account is removed:
  // neither a direct saveJar nor the absorb/save on its next response may recreate web.enc.
  const gone = accounts.add('Gone Ghost');
  const goneFiles = accounts.filesFor(gone.id);
  const jar = [cookie('s', 'v1')];
  assert.equal(web.saveJar(jar, goneFiles.web), true);
  assert.equal(fs.existsSync(store.file(goneFiles.web)), true);
  const w = web.createWeb(jar, {file: goneFiles.web});
  accounts.remove(gone.id);
  assert.equal(fs.existsSync(store.file(goneFiles.web)), false, 'remove() deleted the jar');
  assert.equal(web.saveJar(jar, goneFiles.web), false, 'a direct save of a removed account’s jar is refused');
  assert.equal(fs.existsSync(store.file(goneFiles.web)), false);
  stubFetch(t, refresh('v3'));
  await w.fetchJson('/api/session');
  assert.equal(fs.existsSync(store.file(goneFiles.web)), false, 'the live window’s absorbed refresh did not resurrect web.enc');
  assert.equal(accounts.hasLogin(gone.id), false);

  // The default account’s flat file is never gated (it cannot be removed).
  assert.equal(web.saveJar([cookie('d', '1')]), true);
  assert.equal(fs.existsSync(store.file('web.enc')), true, 'the default flat web.enc still saves');
  store.remove('web.enc');
});
