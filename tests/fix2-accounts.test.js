'use strict';
// Fix phase 2, agent A27: src/accounts.js and src/server/client.js Medium findings —
// deep audit c25 #1/#2/#3/#4 (accounts) and #7/#8/#9 (client), first audit #20,
// fourth audit M9 / M20 / M21. Repros: audit2/fix2/repro-A27.cjs (all reproduced on the
// pre-fix tree, except c25 #3's strong form — see that test's comment).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

process.env.MUSER_LANG = 'ja';
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-home-'));

const accounts = require('../src/accounts');
const store = require('../src/secure-store');
const {createClient} = require('../src/server/client');

const regFile = store.file('accounts.json');
const lockFile = regFile + '.lock';
const idFile = store.file('identity.json');
fs.mkdirSync(path.dirname(regFile), {recursive: true});
const readRegFile = () => JSON.parse(fs.readFileSync(regFile, 'utf8'));
const writeRegFile = v => fs.writeFileSync(regFile, typeof v === 'string' ? v : JSON.stringify(v));

// NOTE: this test must stay FIRST in the file. First audit #20 is about the first read of a
// process that has never read a good registry (no lastGood fallback yet).
test('fix2 #20: a corrupt registry on the first read of a process throws instead of reading as empty', () => {
  writeRegFile('{"accounts": [broken');
  assert.throws(() => accounts.list(), /読めませんでした/, 'a corrupt registry is not an empty one');
  assert.throws(() => accounts.activeId(), /読めませんでした/);
  writeRegFile('{"accounts": {}}');
  assert.throws(() => accounts.list(), /読めませんでした/, 'a non-registry shape is not empty either');
  fs.unlinkSync(regFile);
  assert.deepEqual(accounts.list().map(a => a.id), ['default'], 'a missing file is still "no accounts yet"');
});

test('fix2 c25#1: setActive checks existence inside the lock, so a mid-flight remove is not undone', () => {
  const a = accounts.add('Race Target');
  const raw = fs.readFileSync(regFile, 'utf8');
  const ghostless = JSON.stringify({accounts: readRegFile().accounts.filter(x => x.id !== a.id), activeId: null});
  const origRead = fs.readFileSync;
  let reads = 0;
  // The pre-fix flow read once for get() and again inside the lock: the second read is where
  // the racing remove lands. The fixed flow decides from that same locked read alone.
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === regFile) { reads++; if (reads === 2) { fs.writeFileSync(regFile, ghostless); return ghostless; } }
    return origRead.call(fs, p, ...rest);
  };
  try { accounts.setActive(a.id); } finally { fs.readFileSync = origRead; }
  const reg = readRegFile();
  assert.ok(reg.accounts.some(x => x.id === a.id), 'the account the switch was based on is still registered');
  assert.equal(reg.activeId, a.id);
  assert.throws(() => accounts.setActive('no-such-id'), /見つかりません/);
  accounts.remove(a.id);
  assert.throws(() => accounts.setActive(a.id), /見つかりません/, 'a removed account cannot be switched to');
  void raw;
});

test('fix2 M9: activeId() answers from a single registry snapshot', () => {
  writeRegFile({accounts: [{id: 'aaa', label: 'AAA'}, {id: 'bbb', label: 'BBB'}], activeId: 'aaa'});
  const snap1 = fs.readFileSync(regFile, 'utf8');
  const snap2 = JSON.stringify({accounts: [{id: 'bbb', label: 'BBB'}], activeId: 'bbb'});
  const origRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === regFile) { reads++; return reads === 1 ? snap1 : snap2; }
    return origRead.call(fs, p, ...rest);
  };
  let got;
  try { got = accounts.activeId(); } finally { fs.readFileSync = origRead; }
  assert.equal(got, 'aaa', 'one snapshot: aaa was active and existed there (the double read answered default, which no snapshot had active)');
  writeRegFile({accounts: [], activeId: null});
});

test('fix2 M20: resolve() treats an exactly duplicated label as ambiguous, like a prefix', () => {
  writeRegFile({accounts: [{id: 'alpha', label: 'Team'}, {id: 'beta', label: 'Team'}, {id: 'solo', label: 'Solo'}], activeId: null});
  assert.equal(accounts.resolve('Team'), null, 'two exact label matches: no silent first win');
  assert.equal(accounts.resolve('Te'), null, 'the prefix was already ambiguous');
  assert.equal(accounts.resolve('Solo').id, 'solo', 'a unique exact label still resolves');
  assert.equal(accounts.resolve('alpha').id, 'alpha', 'a unique id still resolves');
  writeRegFile({accounts: [], activeId: null});
});

test('fix2 M21: a registry change preserves invalid entries and unknown top-level keys', () => {
  writeRegFile({version: 9, note: 'keep me', accounts: [{id: 'good', label: 'Good'}, {id: 'Bad ID!', label: 'Bad'}, {id: 'nolabel'}], activeId: null});
  assert.deepEqual(accounts.list().map(a => a.id), ['default', 'good'], 'only valid entries are listed');
  accounts.setActive('good');
  let reg = readRegFile();
  assert.equal(reg.activeId, 'good');
  assert.equal(reg.version, 9, 'unknown top-level keys survive a change');
  assert.equal(reg.note, 'keep me');
  assert.deepEqual(reg.accounts.map(x => x.id), ['good', 'Bad ID!', 'nolabel'], 'invalid entries survive a change instead of being purged without a backup');
  const added = accounts.add('Preserved Too');
  reg = readRegFile();
  assert.equal(reg.version, 9, 'and survive an add as well');
  assert.ok(reg.accounts.some(x => x.id === 'Bad ID!'));
  accounts.remove(added.id);
  writeRegFile({accounts: [], activeId: null});
});

test('fix2 c25#4: updateIdentity retries a transient read error instead of silently dropping the update', () => {
  try { fs.unlinkSync(idFile); } catch {}
  const origRead = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (p, ...rest) {
    if (armed && String(p) === idFile) { armed = false; const e = new Error('simulated EPERM'); e.code = 'EPERM'; throw e; }
    return origRead.call(fs, p, ...rest);
  };
  try { accounts.rememberMuseName('default', 'Transient Name'); } finally { fs.readFileSync = origRead; }
  assert.equal(accounts.museName('default'), 'Transient Name', 'the EPERM was retried and the name landed');
  fs.unlinkSync(idFile);
});

test('fix2 c25#2: updateIdentity is fenced — a holder whose lock was stolen does not write', () => {
  try { fs.unlinkSync(idFile); } catch {}
  accounts.rememberMuseName('default', 'Before Steal');
  const origRead = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (p, ...rest) {
    const v = origRead.call(fs, p, ...rest);
    if (armed && String(p) === idFile) { armed = false; fs.writeFileSync(lockFile, 'thief-token'); }
    return v;
  };
  try { accounts.rememberMuseName('default', 'Stolen Write'); }
  finally { fs.readFileSync = origRead; try { fs.unlinkSync(lockFile); } catch {} }
  assert.equal(accounts.museName('default'), 'Before Steal', 'the stolen holder wrote nothing over the thief');
  fs.unlinkSync(idFile);
});

test('fix2 c25#2: a dead holder\'s registry lock is stolen at once; a legacy stale lock still is', () => {
  const {spawnSync} = require('node:child_process');
  const child = spawnSync(process.execPath, ['-e', ''], {stdio: 'ignore'});
  assert.ok(child.pid > 0);
  // Fresh mtime: the old mtime-only rule would NOT steal this for 10 s even though the
  // holder is gone; the pid in the lock file settles it immediately.
  fs.writeFileSync(lockFile, 'sometoken:' + child.pid);
  const started = Date.now();
  try {
    const a = accounts.add('Dead Lock');
    assert.ok(Date.now() - started < 5000, 'the dead holder\'s lock was claimed without the 10 s wait');
    accounts.remove(a.id);
  } finally { try { fs.unlinkSync(lockFile); } catch {} }
  // Legacy locks (written by an older muser) carry no pid: the 10 s mtime rule still applies.
  fs.writeFileSync(lockFile, 'sometoken');
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lockFile, old, old);
  try {
    const a = accounts.add('Legacy Lock');
    accounts.remove(a.id);
  } finally { try { fs.unlinkSync(lockFile); } catch {} }
});

test('fix2 c25#3: remove deletes and verifies the secret files, and reports what it could not delete', () => {
  const a = accounts.add('Remove Verify');
  const files = accounts.filesFor(a.id);
  for (const n of [files.web, files.session, files.device]) {
    const f = store.file(n);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, 'x');
  }
  const r = accounts.remove(a.id);
  assert.equal(r.leftover, null);
  assert.deepEqual(r.leftoverFiles, [], 'every secret file is gone, verified');
  assert.equal(accounts.hasLogin(a.id), false);

  // Deletion blocked at every step (unlink refused, folder removal silently ineffective):
  // the failure must be reported by path, not swallowed. (The pre-fix strong form — a plain
  // store.remove failure leaving web.enc behind — did NOT reproduce: the account folder's
  // recursive removal deletes the .enc files with it and its leftover check fires. What was
  // missing is the per-file verification/report below.)
  const b = accounts.add('Remove Blocked');
  const bFiles = accounts.filesFor(b.id);
  for (const n of [bFiles.web, bFiles.session, bFiles.device]) {
    const f = store.file(n);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, 'x');
  }
  const webPath = store.file(bFiles.web);
  const folder = path.dirname(bFiles.browser); // filesFor().browser is already a store.file() path
  const origUnlink = fs.unlinkSync, origRm = fs.rmSync;
  fs.unlinkSync = function (p, ...rest) {
    if (String(p) === webPath) { const e = new Error('simulated EPERM'); e.code = 'EPERM'; throw e; }
    return origUnlink.call(fs, p, ...rest);
  };
  fs.rmSync = function (p, ...rest) { if (String(p) === folder) return; return origRm.call(fs, p, ...rest); };
  let r2;
  try { r2 = accounts.remove(b.id); } finally { fs.unlinkSync = origUnlink; fs.rmSync = origRm; }
  assert.ok(r2.leftoverFiles.includes(webPath), 'the undeletable secret file is reported by path: ' + JSON.stringify(r2));
  assert.equal(r2.leftover, folder, 'and surfaces through the existing leftover channel too');
  assert.equal(accounts.get(b.id), null, 'the registry entry is gone either way');
  origRm.call(fs, folder, {recursive: true, force: true});
});

test('fix2 c25#2: a live holder\'s registry lock is never stolen, however old it looks', () => {
  // This process is alive and its pid is in the lock: even with a 20 s old mtime, another
  // change must wait and then give up with the busy error, not steal. Takes ~10 s (the
  // lock wait) on the fixed tree; the pre-fix tree stole it at once and succeeded.
  fs.writeFileSync(lockFile, 'sometoken:' + process.pid);
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lockFile, old, old);
  try { assert.throws(() => accounts.add('Live Lock'), /使用中/); }
  finally { try { fs.unlinkSync(lockFile); } catch {} }
  assert.equal(accounts.resolve('Live Lock'), null, 'nothing was written');
});

// ---- src/server/client.js ----
async function waitFor(cond, what, timeoutMs = 8000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 20));
  }
}
function stubSse(t, handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    resolve({server, info: {port: server.address().port, token: 'test-token', pid: process.pid}});
  }));
}

test('fix2 c25#8: close() inside onEvent stops the rest of the same chunk from being delivered', async t => {
  const {info} = await stubSse(t, (req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: {"kind":"entry","n":1}\n\ndata: {"kind":"entry","n":2}\n\n');
  });
  const client = createClient(info);
  const got = [];
  let closeFn;
  closeFn = client.events('s1', {onEvent: ev => { got.push(ev.n); if (ev.n === 1) closeFn(); }, onClose: () => {}});
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(got, [1], 'nothing is delivered after close()');
});

test('fix2 c25#7: a server that snapshots then instantly drops does not hot-loop the reconnect', async t => {
  let hits = 0;
  const {info} = await stubSse(t, (req, res) => {
    hits++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end('data: {"kind":"state","state":{}}\n\n');
  });
  const client = createClient(info);
  const close = client.events('s1', {onEvent: () => {}, onClose: () => {}});
  await waitFor(() => hits >= 2, 'the reconnect loop to cycle');
  const windowStart = hits;
  await new Promise(r => setTimeout(r, 3200));
  close();
  const inWindow = hits - windowStart;
  assert.ok(inWindow <= 4, 'the snapshot alone did not reset the backoff (saw ' + inWindow + ' connections in 3.2 s; the pre-fix loop made 6+)');
});

test('fix2 c25#9: an unterminated oversize frame drops the connection instead of growing the buffer forever', async t => {
  let hits = 0;
  const {info} = await stubSse(t, (req, res) => {
    hits++;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (hits === 1) res.write('data: ' + 'x'.repeat(33 * 1024 * 1024)); // no blank-line terminator, ever
  });
  const client = createClient(info);
  const events = [];
  const close = client.events('s1', {onEvent: ev => events.push(ev), onClose: () => {}});
  await waitFor(() => hits >= 2, 'the oversize frame to drop and reconnect');
  close();
  assert.deepEqual(events, [], 'the oversize frame was never delivered');
});
