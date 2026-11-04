'use strict';
// Fix phase 2, agent A26: the Medium findings for src/config.js and src/account-pool.js.
//   deep c24 #9   BOM variants / UTF-16 config.json read as {} and reset on the next update
//   deep c24 #10  withLock loops forever when a stale lock's stat/unlink keeps throwing
//   deep c24 #1   sameMuse's default vmOf binds the real web.enc (stale jar write-back)
//   deep c24 #2   drop() cannot stop an in-flight warm(); the bundle resurrects, connected
//   first #19     withLock gives up after 2 s and runs the update WITHOUT the lock
//   fourth M15    valid-JSON non-object config overwritten with no corrupt backup
//                 (= deep c24 #11, the same defect reported as None there)
//   fourth M16    string booleans ("false" / "0") fall back to the on-by-default value
//   fifth f1-1    a read failure is treated as "empty" and update wipes every setting
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same isolation as tests/accounts.test.js: point every data folder at a throwaway one
// BEFORE loading any src module, so a bare run of this file can never touch the real
// ~/.muser or the real account registry (tests/setup.mjs also does this under npm test).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-home-'));

const config = require('../src/config');
const BOM = '\uFEFF';

// Run fn with config.file() redirected under a fresh temp home; returns fn's result.
function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-cfg-'));
  const was = os.homedir;
  os.homedir = () => dir;
  try {
    const f = config.file();
    assert.ok(f.startsWith(dir), 'config redirected under the temp home: ' + f);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    return fn({dir, f});
  } finally { os.homedir = was; }
}
const corruptFiles = dir => fs.readdirSync(path.join(dir, '.muser')).filter(n => n.includes('.corrupt-'));

test('config: doubled / whitespace-led BOMs and UTF-16 files read as their settings (c24 #9)', () => {
  assert.deepStrictEqual(config.parseJson(BOM + BOM + '{"a":1}'), {a: 1});
  assert.deepStrictEqual(config.parseJson(' \n' + BOM + '{"a":1}'), {a: 1});
  assert.deepStrictEqual(config.parseJson(BOM + '{"a":1}'), {a: 1}, 'the original single-BOM case still works');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-enc-'));
  const le = path.join(dir, 'le.json'), be = path.join(dir, 'be.json');
  fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"lang":"en","maxAgents":3}', 'utf16le')]));
  const leBuf = Buffer.from('{"lang":"en","maxAgents":3}', 'utf16le'), swapped = Buffer.alloc(leBuf.length);
  for (let i = 0; i < leBuf.length; i += 2) { swapped[i] = leBuf[i + 1]; swapped[i + 1] = leBuf[i]; }
  fs.writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]));
  assert.deepStrictEqual(config.readJson(le), {lang: 'en', maxAgents: 3});
  assert.deepStrictEqual(config.readJson(be), {lang: 'en', maxAgents: 3});
  withHome(({dir: home, f}) => {
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"lang":"en","maxAgents":3}', 'utf16le')]));
    assert.deepStrictEqual(config.read(), {lang: 'en', maxAgents: 3});
    config.update(c => { c.bell = false; });
    assert.deepStrictEqual(config.read(), {lang: 'en', maxAgents: 3, bell: false}, 'the update kept every UTF-16 setting');
    assert.deepStrictEqual(corruptFiles(home), [], 'nothing was moved aside as corrupt');
  });
});

test('config: valid JSON that is not an object is moved aside as corrupt on update (M15 / c24 #11)', () => {
  for (const text of ['[{ "lang": "ja" }]', '"ja"', '42', 'null']) {
    withHome(({dir, f}) => {
      fs.writeFileSync(f, text);
      assert.deepStrictEqual(config.read(), {}, 'a non-object still reads as no settings: ' + text);
      config.update(c => { c.lang = 'ja'; });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), {lang: 'ja'});
      const aside = corruptFiles(dir);
      assert.equal(aside.length, 1, 'exactly one corrupt backup for ' + text);
      assert.equal(fs.readFileSync(path.join(dir, '.muser', aside[0]), 'utf8'), text, 'the original bytes survive in the backup');
    });
  }
});

test('config: a read failure aborts the update and leaves the file untouched (f1-1)', () => {
  withHome(({f}) => {
    const seedText = JSON.stringify({lang: 'ja', bell: false, note: 'keep-me'});
    fs.writeFileSync(f, seedText);
    const orig = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function (p, ...a) {
      if (!injected && String(p) === f) { injected = true; const e = new Error('denied (injected)'); e.code = 'EACCES'; throw e; }
      return orig.call(fs, p, ...a);
    };
    try { assert.throws(() => config.update(c => { c.lang = 'en'; }), e => e.code === 'EACCES'); }
    finally { fs.readFileSync = orig; }
    assert.ok(injected, 'the failure really was injected on the config read');
    assert.equal(fs.readFileSync(f, 'utf8'), seedText, 'the file is byte-for-byte what it was');
    assert.deepStrictEqual(config.read(), {lang: 'ja', bell: false, note: 'keep-me'});
    // And a missing file is still just "no settings yet", not an error.
    fs.unlinkSync(f);
    config.update(c => { c.lang = 'en'; });
    assert.deepStrictEqual(config.read(), {lang: 'en'});
  });
});

test('config: string booleans are read as the booleans they name (M16)', () => {
  delete process.env.MUSER_NO_BELL; delete process.env.MUSER_REDUCED_MOTION;
  withHome(({f}) => {
    fs.writeFileSync(f, JSON.stringify({bell: 'false', focus: 'false', motion: '0', updateCheck: 'false', codeWrap: '1', lang: 'en', future: {flag: 'false'}}));
    const cfg = config.read();
    assert.equal(cfg.bell, false);
    assert.equal(cfg.focus, false);
    assert.equal(cfg.motion, false, '"0" is off, not the on-by-default fallback');
    assert.equal(cfg.updateCheck, false);
    assert.equal(cfg.codeWrap, true);
    assert.equal(cfg.lang, 'en', 'ordinary strings are untouched');
    assert.deepStrictEqual(cfg.future, {flag: 'false'}, 'nested values are untouched');
    const settings = require('../src/settings');
    settings.reloadSwitches();
    assert.equal(settings.switchValue('bell'), false);
    assert.equal(settings.switchValue('focus'), false);
    assert.equal(settings.switchValue('motion'), false);
    assert.equal(settings.savedValue('bell'), false);
    config.update(c => { c.lang = 'ja'; });
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).bell, false, 'the rewritten file holds a real boolean');
  });
});

test('config lock: a foreign lock is never run without — it throws, and the lock survives (first #19)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-lock-'));
  const f = path.join(dir, 'held.json');
  fs.writeFileSync(f + '.lock', 'other-window');
  let ran = false;
  const t0 = Date.now();
  assert.throws(() => config.withLock(f, () => { ran = true; }, {budgetMs: 400, staleMs: 60000}), /locked by another muser window/);
  assert.equal(ran, false, 'the locked work never ran');
  assert.ok(Date.now() - t0 >= 350, 'it waited out the budget first');
  assert.ok(Date.now() - t0 < 4000, 'and gave up within the budget');
  assert.equal(fs.readFileSync(f + '.lock', 'utf8'), 'other-window', "the other window's lock was not unlinked");
});

test('config lock: a stale lock is taken over, used and released', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-lock-'));
  const f = path.join(dir, 'stale.json');
  fs.writeFileSync(f + '.lock', 'crashed-window');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f + '.lock', old, old);
  const out = config.withLock(f, () => 42, {budgetMs: 2000, staleMs: 1000});
  assert.equal(out, 42);
  assert.equal(fs.existsSync(f + '.lock'), false, 'the taken lock was released afterwards');
});

test('config lock: a lock whose holder is still alive is never stolen, however old it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-lock-'));
  const f = path.join(dir, 'live.json');
  const held = 'sometoken:' + process.pid; // this test process is, by construction, alive
  fs.writeFileSync(f + '.lock', held);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f + '.lock', old, old);
  let ran = false;
  assert.throws(() => config.withLock(f, () => { ran = true; }, {budgetMs: 400, staleMs: 50}), /locked by another muser window/);
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(f + '.lock', 'utf8'), held, 'the live holder lock was left exactly as it was');
});

test('config lock: a stale lock that cannot be unlinked fails in budget instead of looping forever (c24 #10)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-lock-'));
  const f = path.join(dir, 'dirlock.json');
  fs.mkdirSync(f + '.lock'); // stat succeeds, unlink always throws: the old loop never reached its deadline
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f + '.lock', old, old);
  let ran = false;
  const t0 = Date.now();
  assert.throws(() => config.withLock(f, () => { ran = true; }, {budgetMs: 400, staleMs: 50}), /locked by another muser window/);
  assert.equal(ran, false);
  assert.ok(Date.now() - t0 < 3000, 'it failed within the budget instead of hanging the window');
  fs.rmSync(f + '.lock', {recursive: true, force: true});
});

// ---- account pool ----
const accounts = require('../src/accounts');
const poolMod = require('../src/account-pool');
const pstat = (id, over = {}) => ({id, label: id, available: true, percentUsed: null, quotaStatus: null, ...over});

test('pool: drop() during an in-flight warm() keeps the bundle out and disconnects it (c24 #2)', async () => {
  delete process.env.MUSER_NO_ACCOUNT_AUTO;
  if (!accounts.get('pool-peer')) accounts.add('Pool Peer');
  let release = null, entered = false, mode = 'hold';
  const bundle = {account: {id: 'pool-peer'}, client: {disconnects: 0, disconnect() { this.disconnects++; }}};
  const pool = poolMod.makePool({
    statusesFn: async () => [pstat('default', {percentUsed: 80}), pstat('pool-peer', {percentUsed: 10})],
    bundleFn: () => bundle,
    connectFn: () => mode === 'hold' ? new Promise(r => { entered = true; release = r; }) : Promise.resolve(),
  });
  const first = pool.warm(new Set());
  const second = pool.warm(new Set()); // shares the in-flight connect (audit #45)
  for (let i = 0; i < 200 && !entered; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(entered, 'the warm reached its connect');
  pool.drop();
  release();
  assert.equal(await first, null, 'a warm dropped mid-connect reports no warm standby');
  assert.equal(await second, null, 'the caller sharing that connect is not handed the dropped pick either');
  assert.equal(pool.warmedId(), null, 'nothing resurrected into the dropped pool');
  assert.equal(pool.take('pool-peer'), null);
  assert.equal(bundle.client.disconnects, 1, 'the just-connected bundle was disconnected, not leaked');
  mode = 'go';
  const again = await pool.warm(new Set());
  assert.equal(again.id, 'pool-peer', 'the pool still warms normally after a drop');
  assert.equal(pool.warmedId(), 'pool-peer');
  pool.drop();
});

test('pool: sameMuse reads /api/session through a probe file, never the real web.enc (c24 #1)', async () => {
  if (!accounts.get('pool-peer')) accounts.add('Pool Peer');
  const web = require('../src/web');
  const seen = [];
  const origCreate = web.createWeb, origLoad = web.loadJar;
  web.loadJar = () => [{name: 's', value: 'v', domain: '.muse.ai', path: '/', expires: -1, secure: true}];
  web.createWeb = (jar, opts) => { seen.push(opts && opts.file); return {fetchJson: async () => ({vm_id: 'vm-x'})}; };
  try {
    const dup = await poolMod.sameMuse('default');
    assert.equal(dup && dup.id, 'pool-peer', 'the duplicate on the same VM is still found');
  } finally { web.createWeb = origCreate; web.loadJar = origLoad; }
  assert.equal(seen.length, 2, 'both accounts were probed');
  for (const file of seen) assert.match(String(file), /\.probe-/, 'the session read is bound to a scratch probe file: ' + file);
  assert.ok(!seen.includes(accounts.filesFor('default').web) && !seen.includes(accounts.filesFor('pool-peer').web), 'never the real web.enc');
});
