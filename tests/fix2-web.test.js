'use strict';
// Fix phase 2 (deep audit, work2/c10.md): src/web.js Medium regression tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same isolation guard as tests/web.test.js: a bare `node --test` run (without
// tests/setup.mjs) must never touch the user's real data folder.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-web-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-web-home-'));

const web = require('../src/web');
const store = require('../src/secure-store');

function stubFetch(t, impl) {
  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  global.fetch = impl;
}
const res = ({ok = true, status = 200, json = async () => ({}), text = async () => '', setCookie = []}) =>
  ({ok, status, headers: {getSetCookie: () => setCookie}, json, text});
const emptyJson = async () => { throw new SyntaxError('Unexpected end of JSON input'); };

test('deep #69 / c10 #1: probe ready-cache hits for a rebuilt jar with the same cookies (login poll pattern)', async t => {
  let tokenCalls = 0, sessionCalls = 0;
  stubFetch(t, async url => {
    if (String(url).includes('/api/hatch/token')) { tokenCalls++; return res({json: async () => ({token: 'tok'})}); }
    sessionCalls++; return res({json: async () => ({endpoint_url: 'https://vm.example', vm_id: 'vm1', vm_name: 'n'})});
  });
  // login.js pollLogin rebuilds the jar on every 2 s tick via jarFromCookies:
  // a NEW array (and new cookie objects) holding the SAME cookies each time.
  const cookies = [{name: 's', value: 'v69', domain: '.muse.ai', path: '/', expires: -1, secure: true}];
  const jarA = web.jarFromCookies(cookies);
  const jarB = web.jarFromCookies(cookies);
  assert.notEqual(jarA, jarB, 'the poll really does build a fresh jar object each tick');
  assert.equal(await web.probe(jarA, 'fix2-probe69.enc'), 'ready');
  assert.equal(await web.probe(jarB, 'fix2-probe69.enc'), 'ready');
  assert.equal(tokenCalls, 1, 'the second probe with identical cookies did not mint another token');
  assert.equal(sessionCalls, 1, 'the second probe was served from the ready cache');
  // A jar whose cookies actually changed must NOT be served the cached verdict.
  const jarC = web.jarFromCookies([{name: 's', value: 'v69-changed', domain: '.muse.ai', path: '/', expires: -1, secure: true}]);
  assert.equal(await web.probe(jarC, 'fix2-probe69.enc'), 'ready');
  assert.equal(tokenCalls, 2, 'changed cookies re-probe instead of reusing the cache');
});

test('deep #70 / c10 #2: fetchJson parse failure says the response could not be read, not that a login is needed', async t => {
  stubFetch(t, async () => res({json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); }}));
  await assert.rejects(web.createWeb([]).fetchJson('/api/session'),
    e => e.parse === true && e.status === 200 && !/ログインが必要/.test(e.message) && /応答を確認/.test(e.message),
    'a garbage 200 body is a parse failure with a neutral message');
});

test('deep #71 / c10 #3: a failed save of absorbed cookies is reported once, and the request still succeeds', async t => {
  const realSave = store.save;
  const realError = console.error;
  const logged = [];
  store.save = () => { throw new Error('disk full (stub)'); };
  console.error = (...args) => { logged.push(args.join(' ')); };
  t.after(() => { store.save = realSave; console.error = realError; });
  const w = web.createWeb([], {file: 'fix2-savefail.enc'});
  stubFetch(t, async () => res({setCookie: ['s=v71; Domain=.muse.ai; Path=/; Secure'], json: async () => ({ok: 1})}));
  assert.deepEqual(await w.fetchJson('/api/session'), {ok: 1}, 'the response itself still succeeds when only the save fails');
  assert.equal(logged.length, 1, 'the swallowed save failure is now reported');
  assert.match(logged[0], /保存に失敗/, 'the report says the login could not be saved');
  assert.match(logged[0], /disk full/, 'the report keeps the underlying reason');
  stubFetch(t, async () => res({setCookie: ['s=v71b; Domain=.muse.ai; Path=/; Secure'], json: async () => ({ok: 2})}));
  assert.deepEqual(await w.fetchJson('/api/session'), {ok: 2});
  assert.equal(logged.length, 1, 'the warning is not repeated on every absorbed response (once per jar file)');
});

test('deep #72 / c10 #4: an empty-body success (204 / empty 200) is not a parse failure in any wrapper', async t => {
  stubFetch(t, async () => res({status: 204, json: emptyJson}));
  assert.equal(await web.createWeb([]).fetchJson('/api/session'), null, 'fetchJson: 204 resolves as an empty result');
  assert.equal(await web.createWeb([]).nativeRequest('device', '/fetch_vms', undefined, 'b'), null, 'nativeRequest: 204 resolves as an empty result');
  assert.equal(await web.createWeb([]).sdkRequest('DELETE'), null, 'sdkRequest: 204 resolves as an empty result');

  stubFetch(t, async () => res({status: 200, json: emptyJson}));
  assert.equal(await web.createWeb([]).fetchJson('/api/session'), null, 'fetchJson: an empty 200 body resolves as an empty result');
  assert.equal(await web.createWeb([]).sdkRequest('GET'), null, 'sdkRequest: an empty 200 body resolves as an empty result');

  // An HTTP error with an empty body keeps its HTTP error (and detail-less
  // message) instead of being misreported as a parse failure.
  stubFetch(t, async () => res({ok: false, status: 400, json: emptyJson}));
  await assert.rejects(web.createWeb([]).nativeRequest('auth', '/hatch/auth/start', {}, 'b'),
    e => e.status === 400 && e.parse === undefined && /HTTP 400/.test(e.message),
    'nativeRequest: an empty-body 400 is an HTTP error, not a parse failure');
});
