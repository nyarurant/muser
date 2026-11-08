'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {claim, nodeIdFor, lockName, slotOfNodeId, listNodes, unpairNode, isMuserNode, pruneStaleNodes, MAX_SLOTS, MAX_SLOTS_LIMIT} = require('../src/node-slots');
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

test('with every slot held, the claim has no slot of its own (the caller waits instead of sharing)', () => {
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

test('release restores a successor lock that is still being written, instead of orphaning it (master-debug #11)', () => {
  const dir = scratch();
  const a = claim('n', {dir});
  fs.writeFileSync(path.join(dir, lockName('n', 1)), ''); // a successor's half-written (empty) lock
  a.release();
  assert.ok(fs.existsSync(path.join(dir, lockName('n', 1))), 'the successor lock is back in place');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.rel-')), [], 'no orphaned .rel- file');
});

test('pruneStaleNodes re-checks before unpairing: a node that came back online is left alone (master-debug #12)', async () => {
  const dir = scratch();
  const base = 'homelink-688df1';
  let lists = 0;
  const unpairs = [];
  const request = async (verb, p, params) => {
    if (p === '/api/nodes/list') { lists++; return {nodes: [{node_id: base + '-4', display_name: 'mizuki CLI (muser) 4', online: lists > 1}]}; }
    if (p === '/api/nodes/unpair') { unpairs.push(params.node_id); return {}; }
    throw new Error('unexpected path ' + p);
  };
  const result = await pruneStaleNodes({base, dir, request});
  assert.deepStrictEqual(result.unpaired, []);
  assert.deepStrictEqual(unpairs, [], 'the live-again node was not unpaired');
  assert.deepStrictEqual(result.skipped, [{id: base + '-4', reason: 'changed'}]);
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

test('a relay entry whose pid is dead is stale: it does not hold the saved node id (t4 #15)', async () => {
  const dir = scratch();
  const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  await new Promise(r => child.on('exit', r)); // a real pid that was alive and is now gone
  fs.writeFileSync(path.join(dir, 'muser-' + child.pid + '-abcdef012345.json'), '{}');
  const s = claim('n', {dir});
  assert.deepStrictEqual([s.slot, s.nodeId], [1, 'n'], 'the dead window’s entry is ignored, unlike the live one above');
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

test('the pool has 16 slots by default; the 17th claim gets no slot of its own', () => {
  assert.strictEqual(MAX_SLOTS, 16, 'the default cap is 16, not 6');
  assert.strictEqual(MAX_SLOTS_LIMIT, 64, 'the hard cap against a runaway is 64');
  const dir = scratch();
  const slots = [];
  for (let i = 0; i < 16; i++) slots.push(claim('n', {dir}).slot);
  assert.deepStrictEqual(slots, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const extra = claim('n', {dir});
  assert.deepStrictEqual([extra.slot, extra.nodeId], [0, 'n'], 'no 17th slot: the caller waits instead of taking one');
});

test('slotOfNodeId reads the slot number out of a node id', () => {
  assert.strictEqual(slotOfNodeId('b', 'b'), 1, 'the base id is slot 1');
  assert.strictEqual(slotOfNodeId('b', 'b-2'), 2);
  assert.strictEqual(slotOfNodeId('b', 'b-7'), 7);
  assert.strictEqual(slotOfNodeId('b', 'b-16'), 16);
  assert.strictEqual(slotOfNodeId('b', 'b-1'), 0, 'there is no -1 slot');
  assert.strictEqual(slotOfNodeId('b', 'b-x'), 0);
  assert.strictEqual(slotOfNodeId('b', 'b-'), 0);
  assert.strictEqual(slotOfNodeId('b', 'other-2'), 0, 'another account’s id is not one of ours');
  assert.strictEqual(slotOfNodeId('b', 'homelink-26c73d'), 0, 'the official app’s id is not a slot');
});

test('isMuserNode only accepts this account’s own muser windows, slot >= 2', () => {
  const base = 'homelink-688df1';
  assert.strictEqual(isMuserNode({node_id: base + '-3', display_name: 'mizuki CLI (muser) 3'}, base), true);
  assert.strictEqual(isMuserNode({node_id: base, display_name: 'mizuki CLI (muser)'}, base), false, 'the base id itself is the standing device, never a target');
  assert.strictEqual(isMuserNode({node_id: base + '-3', display_name: 'mizuki CLI (muser) 4'}, base), false, 'a name that does not match its number is left alone');
  assert.strictEqual(isMuserNode({node_id: base + '-3', display_name: 'mizuki CLI (muser)'}, base), false, 'a name without a number is not a slot');
  assert.strictEqual(isMuserNode({node_id: 'homelink-26c73d', display_name: 'mizuki (Windows PC)'}, base), false, 'the official Windows PC app is never a target');
  assert.strictEqual(isMuserNode({node_id: '41543facb5ca4d99', display_name: 's26 Ultra'}, base), false, 'a phone is never a target');
  assert.strictEqual(isMuserNode({node_id: 'homelink-e5ef31-2', display_name: 'mizuki CLI (muser) 2'}, base), false, 'another account’s window is never a target');
  assert.strictEqual(isMuserNode(null, base), false);
});

test('listNodes keeps only listed nodes with an id; a bad list is empty, not an error', async () => {
  const request = async () => ({nodes: [{node_id: 'b-2', display_name: 'x', online: true}, {display_name: 'no id'}, null, 'b-3']});
  assert.deepStrictEqual(await listNodes(request), [{node_id: 'b-2', display_name: 'x', online: true}]);
  assert.deepStrictEqual(await listNodes(async () => ({})), []);
  assert.deepStrictEqual(await listNodes(async () => ({nodes: 'nope'})), []);
});

test('unpairNode posts the node id to /api/nodes/unpair and nothing else', async () => {
  const calls = [];
  const request = async (verb, path, params, options) => { calls.push([verb, path, params, options]); return {}; };
  assert.strictEqual(await unpairNode(request, 'b-4'), true);
  assert.deepStrictEqual(calls, [['POST', '/api/nodes/unpair', {node_id: 'b-4'}, undefined]]);
  await assert.rejects(() => unpairNode(request, ''), /node id is required/);
  assert.strictEqual(calls.length, 1, 'no second call for the rejected id');
});

test('pruneStaleNodes unpairs only offline muser nodes whose window is really gone', async t => {
  const dir = scratch();
  const base = 'homelink-688df1';
  const pid = sleeper(t).pid;
  // Slot 5: a live window (its lock has a fresh heartbeat). Slot 6: an older muser's legacy lock, also live.
  fs.writeFileSync(path.join(dir, lockName(base, 5)), JSON.stringify({pid, hb: 1, at: Date.now()}));
  fs.writeFileSync(path.join(dir, 'node-6.lock'), JSON.stringify({pid}));
  // Slot 7: a lock whose holder is gone, so the node may go.
  fs.writeFileSync(path.join(dir, lockName(base, 7)), JSON.stringify({pid: 2 ** 30}));
  const nodes = [
    {node_id: base + '-4', display_name: 'mizuki CLI (muser) 4', online: false},
    {node_id: base + '-5', display_name: 'mizuki CLI (muser) 5', online: false},
    {node_id: base + '-6', display_name: 'mizuki CLI (muser) 6', online: false},
    {node_id: base + '-7', display_name: 'mizuki CLI (muser) 7', online: false},
    {node_id: base + '-3', display_name: 'mizuki CLI (muser) 3', online: true},
    {node_id: base, display_name: 'mizuki CLI (muser)', online: false},
    {node_id: 'homelink-26c73d', display_name: 'mizuki (Windows PC)', online: false},
    {node_id: '41543facb5ca4d99', display_name: 's26 Ultra', online: false},
    {node_id: 'homelink-e5ef31-2', display_name: 'mizuki CLI (muser) 2', online: false},
  ];
  const unpairs = [];
  const request = async (verb, path, params) => {
    if (path === '/api/nodes/list') return {nodes};
    if (path === '/api/nodes/unpair') { unpairs.push(params.node_id); return {}; }
    throw new Error('unexpected path ' + path);
  };
  const result = await pruneStaleNodes({base, dir, request});
  assert.deepStrictEqual(result.unpaired, [base + '-4', base + '-7']);
  assert.deepStrictEqual(unpairs, [base + '-4', base + '-7']);
  assert.strictEqual(result.error, null);
  const skipped = Object.fromEntries(result.skipped.map(s => [s.id, s.reason]));
  assert.deepStrictEqual(skipped, {
    [base + '-5']: 'lock-held',
    [base + '-6']: 'lock-held',
    [base + '-3']: 'online',
    [base]: 'not-muser',
    'homelink-26c73d': 'not-muser',
    '41543facb5ca4d99': 'not-muser',
    'homelink-e5ef31-2': 'not-muser',
  });
});

test('pruneStaleNodes unpairs nothing when the list cannot be read', async () => {
  const unpairs = [];
  const request = async (verb, path, params) => {
    if (path === '/api/nodes/list') throw new Error('gateway down');
    unpairs.push(params.node_id);
    return {};
  };
  const result = await pruneStaleNodes({base: 'b', dir: scratch(), request});
  assert.strictEqual(result.error, 'gateway down');
  assert.deepStrictEqual(result.unpaired, []);
  assert.deepStrictEqual(unpairs, [], 'unknown is not a reason to unpair');
});
