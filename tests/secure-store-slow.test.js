'use strict';
// A slow Windows DPAPI call is not a broken file. Found on a real run: with ~20 muser
// processes starting at once (a parallel hunt), PowerShell took over 15 s and the
// error said "the file may be broken or made by another Windows user - log in again".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-slowdpapi-'));
test.after(() => { try { fs.rmSync(process.env.LOCALAPPDATA, {recursive: true, force: true}); } catch {} });

// secure-store takes spawnSync at load time: swap it in before the first require.
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
let plan = [];
cp.spawnSync = (...args) => (plan.length ? plan.shift()(...args) : realSpawnSync(...args));
const store = require('../src/secure-store.js');
test.after(() => { cp.spawnSync = realSpawnSync; });

const slow = () => ({error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), {code: 'ETIMEDOUT'}), status: null, stdout: '', stderr: ''});
const ok = json => () => ({status: 0, stdout: Buffer.from(json).toString('base64'), stderr: ''});
function seed(name) { fs.mkdirSync(store.DIR, {recursive: true}); fs.writeFileSync(store.file(name), 'ciphertext-' + name); }

test('one slow DPAPI call is retried and the value is read', () => {
  seed('a.enc');
  plan = [slow, ok('{"v":1}')];
  assert.deepEqual(store.load('a.enc'), {v: 1});
  assert.equal(plan.length, 0, 'retried exactly once');
});

test('still slow after the retry: a wait-and-retry message, not "broken / log in again"', () => {
  seed('b.enc');
  plan = [slow, slow];
  assert.throws(() => store.load('b.enc'), err => {
    assert.match(err.message, /応答が遅れています|responding slowly/);
    assert.doesNotMatch(err.message, /ログインし直して|壊れている/);
    return true;
  });
});

test('a real decryption failure still says the file may be broken', () => {
  seed('c.enc');
  plan = [() => ({status: 1, stdout: '', stderr: 'Key not valid for use in specified state.'})];
  assert.throws(() => store.load('c.enc'), /壊れているか|corrupted|broken/);
});
