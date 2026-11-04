'use strict';
// Fix phase 2 (A22): src/usage.js + src/node-slots.js Medium findings —
// c19 #1/#2/#3/#4/#5/#10/#11/#14, first audit #16/#21, fifth audit f1-2/f3-5.
process.env.TZ = 'America/New_York';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-usage-'));
require('node:test').after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const usage = require('../src/usage');
const slots = require('../src/node-slots');

let seq = 0;
function useFile() {
  const dir = path.join(tmp, 'case' + (++seq));
  fs.mkdirSync(dir, {recursive: true});
  const f = path.join(dir, 'usage.json');
  process.env.MUSER_USAGE_FILE = f;
  return f;
}
const slotDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-slots-'));
const sleeper = t => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio: 'ignore'}); c.unref(); t.after(() => { try { c.kill(); } catch {} }); return c; };

// c19 #1: count-only and text records inside ONE day must both count.
test('c19#1 record: count-only then text in one day keeps both estimates', () => {
  useFile();
  usage.record({inChars: 400, outChars: 40}); // 100 / 10 by the /4 fallback
  usage.record({inText: 'abcd', outText: 'あ'.repeat(10)}); // 1 / 10 text-based
  const s = usage.summary();
  assert.equal(s.today.approxIn, 101);
  assert.equal(s.today.approxOut, 20);
  assert.equal(s.last7.approxIn, 101, 'last7 uses the same per-day split');
});
test('c19#1 record: text then count-only in one day keeps both estimates', () => {
  useFile();
  usage.record({inText: 'abcd'});
  usage.record({inChars: 400});
  assert.equal(usage.summary().today.approxIn, 101);
});
test('c19#1 record: a pre-split bucket starts its split from its current chars', () => {
  const f = useFile();
  // A bucket written before the split existed: inTokens with no textChars.
  fs.writeFileSync(f, JSON.stringify({version: 1, days: {[usage.dayKey()]: {turns: 0, toolCalls: 0, inChars: 100, outChars: 0, inTokens: 50}}, minutes: {}, totals: {realInTokens: 0, realOutTokens: 0}}));
  usage.record({inChars: 400});
  assert.equal(usage.summary().today.approxIn, 150, 'old estimate stands, new count-only chars add /4');
});

// c19 #2: a lock whose stat/unlink keeps failing must hit the budget, not spin.
test('c19#2 withLock: a directory at the lock path is refused within the budget, never an infinite loop', () => {
  const f = useFile();
  const lock = f + '.lock';
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(lock, old, old); // stale-aged, and unlink() cannot remove a directory
  let ran = false;
  const t0 = Date.now();
  usage.withLock(() => { ran = true; }, {budgetMs: 400, staleMs: 5000});
  assert.equal(ran, true, 'the stale directory lock is retired aside and the record proceeds');
  assert.ok(Date.now() - t0 < 5000, 'it finished promptly');
  assert.equal(fs.existsSync(lock), false, 'the lock was released afterwards');
});

// c19 #3: save() goes through the Windows rename retry like every other store.
test('c19#3 save: one EPERM from rename is retried and the record lands', () => {
  const f = useFile();
  const orig = fs.renameSync; let failed = false;
  fs.renameSync = (...a) => { if (!failed && String(a[1]) === f) { failed = true; const e = new Error('perm'); e.code = 'EPERM'; throw e; } return orig(...a); };
  try { assert.equal(usage.record({turns: 1}).turns, 1); } finally { fs.renameSync = orig; }
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).days[usage.dayKey()].turns, 1);
});

// fifth f1-2: a read failure is not an empty store.
test('f1-2 load: a read failure throws and record() preserves the stored history', () => {
  const f = useFile();
  usage.record({turns: 10, usage: {inputTokens: 1000, outputTokens: 500}});
  const orig = fs.readFileSync; let failed = false;
  fs.readFileSync = (...a) => { if (!failed && String(a[0]) === f) { failed = true; const e = new Error('acc'); e.code = 'EACCES'; throw e; } return orig(...a); };
  try { assert.throws(() => usage.record({turns: 1}), /EACCES|acc/); } finally { fs.readFileSync = orig; }
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.days[usage.dayKey()].turns, 10, 'the month of records was not overwritten');
  assert.equal(raw.totals.realInTokens, 1000, 'the all-time total survived');
  assert.equal(usage.summary().today.turns, 10, 'and summary reads it again once the failure clears');
});
test('f1-2 load: a missing store still starts fresh', () => {
  useFile();
  assert.deepEqual(usage.load().days, {});
});

// c19 #4 + fifth f3-5: minute buckets are UTC-keyed and the last hour is bounded.
test('f3-5 minuteKey: the repeated DST hour produces two different keys', () => {
  const edt = new Date('2026-11-01T01:30:00-04:00'), est = new Date('2026-11-01T01:30:00-05:00');
  assert.equal(edt.getHours(), 1); assert.equal(est.getHours(), 1); // same local wall minute
  assert.notEqual(usage.minuteKey(edt), usage.minuteKey(est));
});
test('c19#4 summary: a future minute bucket is not counted as the last hour', () => {
  const f = useFile();
  const future = usage.minuteKey(new Date(Date.now() + 3600e3));
  const recent = usage.minuteKey(new Date(Date.now() - 10 * 60e3));
  fs.writeFileSync(f, JSON.stringify({version: 1, days: {}, minutes: {[future]: {realInTokens: 999, realOutTokens: 0}, [recent]: {realInTokens: 5, realOutTokens: 1}}, totals: {realInTokens: 1004, realOutTokens: 1}}));
  const s = usage.summary();
  assert.equal(s.lastHour.realInTokens, 5, 'only the real trailing hour counts');
  assert.equal(s.allTime.realInTokens, 1004, 'the future bucket still exists in the total');
});

// c19 #14 (usage side): a successor's lock, swapped in between the stale
// check and the removal, must survive — removal goes through a rename-aside
// whose content is verified.
test('c19#14 withLock: a successor lock swapped in during stale retirement is preserved', () => {
  const f = useFile();
  const lock = f + '.lock';
  fs.writeFileSync(lock, 'stale-holder');
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(lock, old, old);
  const orig = fs.renameSync; let swapped = false;
  fs.renameSync = (from, to) => { if (!swapped && from === lock && String(to).includes('.stale-')) { swapped = true; fs.writeFileSync(lock, 'successor'); } return orig(from, to); };
  let ran = false;
  try { assert.throws(() => usage.withLock(() => { ran = true; }, {budgetMs: 300, staleMs: 5000}), /usage store is busy/); }
  finally { fs.renameSync = orig; }
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'successor', 'the successor lock was put back, not deleted');
});

// ---- plan(): first audit #21 + c19 #5 ----
const ID1 = 'a'.repeat(40), ID2 = 'b'.repeat(40);
const subLine = '0:' + JSON.stringify({subscription: {tier: {name: 'Pro', isPaid: true}, usage: {percentUsed: 10, resetsAt: 1899999999}}}) + '\n';
function makeWeb(ids, okIds) {
  let crawl = 0, pageCalls = 0;
  return {
    get pageCalls() { return pageCalls; },
    async pageText(p) { pageCalls++; if (p === '/') return '<script src="/_next/static/chunks/c1.js"></script>'; crawl++; const id = ids[Math.min(crawl - 1, ids.length - 1)]; return `x createServerReference)("${id}","fetchSubscriptionAction") fetchSubscriptionAction`; },
    async serverAction(id) { return okIds.includes(id) ? {ok: true, text: subLine} : {ok: false, status: 404}; },
  };
}
test('first#21 plan: an id found in this call that then 404s is re-searched at once, not after an hour', async () => {
  const f = useFile(); usage.resetWeb();
  const web = makeWeb([ID1, ID2], [ID2]);
  const p = await usage.plan(web);
  assert.equal(p.percentUsed, 10);
  const p2 = await usage.plan(web);
  assert.equal(p2.percentUsed, 10, 'the next call uses the refound id from the cache');
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f), 'subscription-action.json'), 'utf8')).id, ID2, 'the dead id was dropped from the disk cache');
});
test('first#21 plan: a refound id that also 404s ends the call and gates the next one briefly', async () => {
  useFile(); usage.resetWeb();
  const web = makeWeb([ID1, ID2], []);
  await assert.rejects(() => usage.plan(web), /読み込めませんでした/);
  const calls = web.pageCalls;
  await assert.rejects(() => usage.plan(web), /読み込めませんでした/);
  assert.equal(web.pageCalls, calls, 'no second crawl inside the short retry delay');
});
test('c19#5 plan: concurrent plan() calls share one crawl', async () => {
  useFile(); usage.resetWeb();
  const web = makeWeb([ID2], [ID2]);
  const [a, b] = await Promise.all([usage.plan(web), usage.plan(web)]);
  assert.equal(a.percentUsed, 10); assert.equal(b.percentUsed, 10);
  assert.equal(web.pageCalls, 2, 'one index page + one chunk for both callers');
});

// ---- node-slots ----
test('first#16 legacyHeld: a fresh empty legacy lock holds its slot; an old one does not', () => {
  const dir = slotDir();
  fs.writeFileSync(path.join(dir, 'node-1.lock'), '');
  assert.equal(slots.claim('n', {dir}).slot, 2, 'a lock being written by an old window is not stolen');
  const dir2 = slotDir();
  const f2 = path.join(dir2, 'node-1.lock');
  fs.writeFileSync(f2, '');
  const old = new Date(Date.now() - 20000); fs.utimesSync(f2, old, old);
  assert.equal(slots.claim('n', {dir: dir2}).slot, 1, 'an old unreadable legacy lock is free');
  const dir3 = slotDir();
  fs.writeFileSync(path.join(dir3, 'node-1.lock'), 'not json');
  assert.equal(slots.claim('n', {dir: dir3}).slot, 2, 'a fresh corrupt legacy lock is held too');
});
test('c19#10 claim: a transient EPERM while a holder deletes its lock retries the same slot', () => {
  const dir = slotDir();
  const orig = fs.openSync; let failed = false;
  fs.openSync = (p, ...r) => { if (!failed && String(p).endsWith('.1.lock')) { failed = true; const e = new Error('perm'); e.code = 'EPERM'; throw e; } return orig(p, ...r); };
  let c;
  try { c = slots.claim('n', {dir}); } finally { fs.openSync = orig; }
  assert.equal(c.slot, 1, 'the free slot was not skipped');
  c.release();
});
test('c19#10 claim: a failed lock write removes its own orphan file and retries', () => {
  const dir = slotDir();
  const orig = fs.writeSync; let failed = false;
  fs.writeSync = (...a) => { if (!failed) { failed = true; const e = new Error('io'); e.code = 'EIO'; throw e; } return orig(...a); };
  let c;
  try { c = slots.claim('n', {dir}); } finally { fs.writeSync = orig; }
  assert.equal(c.slot, 1);
  const held = JSON.parse(fs.readFileSync(path.join(dir, slots.lockName('n', 1)), 'utf8'));
  assert.equal(held.pid, process.pid, 'slot 1 holds this window’s real lock, not an empty orphan');
  c.release();
});
test('c19#11 claim: a heartbeat lock whose pid was reused is taken over once its heartbeat is long dead', t => {
  const dir = slotDir();
  const pid = sleeper(t).pid;
  const f = path.join(dir, slots.lockName('n', 1));
  fs.writeFileSync(f, JSON.stringify({pid, hb: 1, at: Date.now() - 3600e3, token: 'dead-window'}));
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(f, old, old);
  assert.equal(slots.claim('n', {dir}).slot, 1, 'alive pid alone no longer blocks the slot for ever');
});
test('c19#11 claim: a heartbeat lock with a fresh heartbeat is not stolen from its live window', t => {
  const dir = slotDir();
  const pid = sleeper(t).pid;
  fs.writeFileSync(path.join(dir, slots.lockName('n', 1)), JSON.stringify({pid, hb: 1, at: Date.now(), token: 'live-window'}));
  assert.equal(slots.claim('n', {dir}).slot, 2);
});
test('c19#14 claim: a successor lock swapped in during stale retirement is preserved', t => {
  const dir = slotDir();
  const pid = sleeper(t).pid;
  const f = path.join(dir, slots.lockName('n', 1));
  fs.writeFileSync(f, JSON.stringify({pid: 2 ** 30})); // dead holder: stale
  const orig = fs.renameSync; let swapped = false;
  fs.renameSync = (from, to) => { if (!swapped && from === f && String(to).includes('.stale-')) { swapped = true; fs.writeFileSync(f, JSON.stringify({pid})); } return orig(from, to); };
  let c;
  try { c = slots.claim('n', {dir}); } finally { fs.renameSync = orig; }
  assert.equal(c.slot, 2, 'the successor keeps slot 1');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, pid, 'the successor lock file is back in place');
});
