'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {claim, nodeIdFor, lockName} = require('../src/node-slots');
const {spawn} = require('node:child_process');
const {after} = require('node:test');

const madeDirs = [];
after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-slots-')); madeDirs.push(d); return d; };
// A pid that is guaranteed alive for the duration of a test. process.ppid is not:
// under reparenting it can be dead already, or an unrelated process.
const sleeper = t => { const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio: 'ignore'}); child.unref(); t.after(() => { try { child.kill(); } catch {} }); return child; };

test('each window takes its own node id; slot 1 is the saved one', () => {
  const dir = scratch();
  const a = claim('homelink-abc', {dir}), b = claim('homelink-abc', {dir}), c = claim('homelink-abc', {dir});
  assert.deepStrictEqual([a.nodeId, b.nodeId, c.nodeId], ['homelink-abc', 'homelink-abc-2', 'homelink-abc-3']);
  b.release();
  // A freed slot is reused before a new one is added to the account's device list.
  assert.strictEqual(claim('homelink-abc', {dir}).nodeId, 'homelink-abc-2');
});

test('the slot of a window that is gone is taken over', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, lockName('n', 1)), JSON.stringify({pid: 2 ** 30}));
  assert.strictEqual(claim('n', {dir}).slot, 1);
});

test('a lock still being written is not taken over', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, lockName('n', 1)), '');
  assert.strictEqual(claim('n', {dir}).slot, 2);
});

test('with every slot held, the saved node id is shared as before', () => {
  const dir = scratch();
  claim('n', {dir, max: 2}); claim('n', {dir, max: 2});
  const s = claim('n', {dir, max: 2});
  assert.deepStrictEqual([s.slot, s.nodeId], [0, 'n']);
  assert.strictEqual(claim(undefined, {dir}).nodeId, undefined);
});

test('release only removes the lock this window holds', () => {
  const dir = scratch();
  const a = claim('n', {dir});
  fs.writeFileSync(path.join(dir, lockName('n', 1)), JSON.stringify({pid: process.pid + 1}));
  a.release();
  assert.ok(fs.existsSync(path.join(dir, lockName('n', 1))));
  assert.strictEqual(nodeIdFor('n', 4), 'n-4');
});

test('an older muser window (relay entry, no node lock) keeps the saved node id to itself', t => {
  const dir = scratch();
  const pid = sleeper(t).pid;
  fs.writeFileSync(path.join(dir, 'muser-' + pid + '-abcdef012345.json'), '{}');
  assert.strictEqual(claim('n', {dir}).nodeId, 'n-2');
  // Once that window holds a node lock of its own, it is not an older one.
  const other = scratch();
  fs.writeFileSync(path.join(other, 'muser-' + pid + '-abcdef012345.json'), '{}');
  fs.writeFileSync(path.join(other, lockName('n', 3)), JSON.stringify({pid}));
  assert.strictEqual(claim('n', {dir: other}).nodeId, 'n');
});

test('each account has its own pool: windows of one account do not take the slots of another account', () => {
  const dir = scratch();
  for (let i = 0; i < 2; i++) claim('homelink-default', {dir, max: 2});
  assert.strictEqual(claim('homelink-default', {dir, max: 2}).slot, 0, 'the default account is full');
  const other = claim('homelink-acct2', {dir, max: 2});
  assert.deepStrictEqual([other.slot, other.nodeId], [1, 'homelink-acct2'], 'account 2 still gets its saved id to itself');
});

test('a legacy lock (older muser, node-<n>.lock) still holds that slot for every account', t => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'node-1.lock'), JSON.stringify({pid: sleeper(t).pid}));
  assert.strictEqual(claim('a', {dir}).slot, 2);
  assert.strictEqual(claim('b', {dir}).slot, 2);
  fs.writeFileSync(path.join(dir, 'node-1.lock'), JSON.stringify({pid: 2 ** 30}));
  assert.strictEqual(claim('c', {dir}).slot, 1, 'a legacy lock of a window that is gone is ignored');
});
