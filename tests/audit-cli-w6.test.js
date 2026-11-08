'use strict';
// audit-cli wave 6 (display / wording) regression tests for the wave-6 fixes:
//  (1) usage: formatPercent clamps to 0-100 and never rounds up to a 100 the
//      value has not reached nor down to a 0 it has passed (100.4 -> 100,
//      -3 -> 0, 0.04 -> 0.1, not 0); formatPlan words a reset time that is
//      already past as past, not in the future form.
//  (2) export: formatBytes promotes on the ROUNDED value, so 1048575 reads
//      '1.00 MB' (not '1024.0 KB') and 1 GB reads '1.00 GB' (not '1024.00 MB').
//  (3) race: validateRacerCount refuses 0 and 9 and passes 8 (also at the
//      estimate entrance); applyWinner on a still-running racer says the race
//      is still running — it does NOT say it was interrupted.
//  (4) expect: the expect / verdict lines go through t(), so under
//      MUSER_LANG=en they come out in English (checked in a child process,
//      because the language is picked at process start).
//  (5) overnight: a broken queue throws a worded Japanese error and the bad
//      file is moved aside as a .corrupt-* backup, not lost; the next load
//      starts from a fresh empty queue.
//  (6) tell: a failed inbox write answers with the worded message, never the
//      raw OS error (no EISDIR / EPERM text leaks to the sender).
// Isolation follows tests/setup.mjs; like tests/audit-cli-w5.test.js this
// file also pins its own temp HOME / LOCALAPPDATA before requiring any src
// module, because several of them resolve their files at require time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w6-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w6-test-home-'));

const usage = require('../src/usage');
const exporter = require('../src/export');
const race = require('../src/race');
const queue = require('../src/overnight/queue');
const tell = require('../src/tell');
const expectMod = require('../src/expect');

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'muser-w6-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// ---------- (1) usage: formatPercent + past reset wording ----------

test('w6 usage (1): formatPercent clamps to 0-100 and never rounds across the 0 / 100 edges', () => {
  assert.equal(usage.formatPercent(100.4), '100', 'over 100 clamps to 100');
  assert.equal(usage.formatPercent(-3), '0', 'below 0 clamps to 0');
  assert.equal(usage.formatPercent(0.04), '0.1', 'a value past 0 must not round down to 0');
  assert.notEqual(usage.formatPercent(0.04), '0');
  assert.equal(usage.formatPercent(99.999), '99.9', 'a value short of 100 must not round up to 100');
  assert.equal(usage.formatPercent(100), '100', 'control: a real 100 stays 100');
  assert.equal(usage.formatPercent(0), '0', 'control: a real 0 stays 0');
  assert.equal(usage.formatPercent(50), '50');
  assert.equal(usage.formatPercent(12.34), '12.3', 'at most one decimal');
});

test('w6 usage (1): formatPlan words a past reset time as past and a future one as future', () => {
  const past = usage.formatPlan({plan: 'Pro', percentUsed: 100.4, resetsAt: Date.now() - 60 * 60 * 1000, quotaStatus: 'SUFFICIENT'});
  assert.ok(past.includes('過ぎています'), 'a reset time already past is worded as past: ' + past);
  assert.ok(!past.includes('にリセット'), 'the future form is not used for a past time: ' + past);
  assert.ok(past.includes('100%'), 'the percent in the plan line is the clamped one: ' + past);
  assert.ok(!past.includes('100.4'), 'the raw server percent never reaches the screen');
  const future = usage.formatPlan({plan: 'Pro', percentUsed: 42, resetsAt: Date.now() + 60 * 60 * 1000, quotaStatus: 'SUFFICIENT'});
  assert.ok(future.includes('にリセット'), 'control: a future reset keeps the future form: ' + future);
  assert.ok(!future.includes('過ぎています'));
});

// ---------- (2) export: formatBytes rolls up on the rounded value ----------

test('w6 export (2): formatBytes promotes 1048575 to 1.00 MB and 1 GB to 1.00 GB', () => {
  assert.equal(exporter.formatBytes(1048575), '1.00 MB', 'one byte under 1 MB rounds to 1024.0 KB, so it promotes');
  assert.equal(exporter.formatBytes(1024 * 1024 * 1024), '1.00 GB', '1 GB is not shown as 1024.00 MB');
  assert.equal(exporter.formatBytes(512), '512 B', 'control: bytes stay bytes');
  assert.equal(exporter.formatBytes(2048), '2.0 KB', 'control: KB keeps one decimal');
  assert.equal(exporter.formatBytes(1024 * 1024), '1.00 MB', 'control: exactly 1 MB');
  assert.equal(exporter.formatBytes(3 * 1024 * 1024), '3.00 MB', 'control: MB keeps two decimals');
});

// ---------- (3) race: racer count + still-running apply wording ----------

test('w6 race (3): validateRacerCount refuses 0 and 9 and passes 8', () => {
  assert.throws(() => race.validateRacerCount(0), /参加者は 1〜8 体にしてください/);
  assert.throws(() => race.validateRacerCount(9), /参加者は 1〜8 体にしてください/);
  assert.equal(race.validateRacerCount(8), 8, 'the maximum itself passes');
  assert.equal(race.validateRacerCount(1), 1, 'control: the minimum passes');
  assert.throws(() => race.estimate({n: 9}), /参加者は 1〜8 体にしてください/, 'the pre-start estimate refuses an over-limit race at the entrance too');
});

test('w6 race (3): applying a still-running racer says it is running, not that it was interrupted', async (t) => {
  const dir = tmpdir(t, 'muser-w6-race-');
  const running = {dir, cwd: dir, racers: [{index: 1, status: 'running'}, {index: 2, status: 'waiting'}]};
  for (const idx of [1, 2]) {
    await assert.rejects(race.applyWinner(running, idx), e => {
      assert.ok(e.message.includes('競争は実行中です'), 'the wording names the real cause: ' + e.message);
      assert.ok(!e.message.includes('中断しました'), 'a race that never stopped is not reported as interrupted: ' + e.message);
      return true;
    });
  }
  const stopped = {dir, cwd: dir, racers: [{index: 1, status: 'interrupted'}]};
  await assert.rejects(race.applyWinner(stopped, 1), /中断しました/, 'control: a genuinely interrupted racer keeps the interrupted wording');
});

// ---------- (4) expect: the lines are English under MUSER_LANG=en ----------

test('w6 expect (4): in this process (ja) the expect lines are the Japanese originals', () => {
  assert.equal(expectMod.expectText({contains: 'hello'}), '出力に「hello」を含む');
  assert.equal(expectMod.expectText({exit: 'nonzero'}), 'exit 非0');
  assert.equal(expectMod.expectText({tests: 'pass'}), 'テスト全通過');
});

test('w6 expect (4): a child process with MUSER_LANG=en gets the expect lines in English', () => {
  const file = path.join(__dirname, '..', 'src', 'expect.js');
  const script = 'const m = require(' + JSON.stringify(file) + ');'
    + 'console.log(m.expectText({contains: "hello"}));'
    + 'console.log(m.expectText({exit: "nonzero"}));'
    + 'console.log(m.expectText({tests: "pass"}));'
    + 'console.log(m.evaluateExpect({contains: "hello"}, {output: "say hello"}).actual);'
    + 'console.log(m.mismatchLine({contains: "hello"}, "actual"));';
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 30000,
    env: {...process.env, MUSER_LANG: 'en'}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes('the output contains "hello"'), 'contains line in English: ' + r.stdout);
  assert.ok(r.stdout.includes('exit nonzero'), 'exit line in English');
  assert.ok(r.stdout.includes('all tests pass'), 'tests line in English');
  assert.ok(r.stdout.includes('"hello" was present'), 'the verdict actual is English too: ' + r.stdout);
  assert.ok(r.stdout.includes('[muser: unexpected] expected:'), 'the mismatch line is English: ' + r.stdout);
  assert.ok(!r.stdout.includes('出力に') && !r.stdout.includes('想定外'), 'no Japanese original leaks through: ' + r.stdout);
});

// ---------- (5) overnight: a broken queue is worded and backed aside ----------

test('w6 overnight (5): a broken queue throws a worded Japanese error and leaves a .corrupt backup', (t) => {
  const baseDir = tmpdir(t, 'muser-w6-on-');
  const brokenText = '{ this is not json — the only copy of the queued prompts';
  fs.writeFileSync(path.join(baseDir, 'queue.json'), brokenText, 'utf8');
  let err = null;
  try { queue.loadQueue({baseDir}); } catch (e) { err = e; }
  assert.ok(err instanceof Error, 'a broken queue still throws');
  assert.ok(err.message.includes('壊れています'), 'the error is worded in Japanese: ' + err.message);
  assert.ok(err.message.includes('退避しました'), 'the error says the file was moved aside: ' + err.message);
  assert.ok(!err.message.includes('is broken'), 'the old English wording is gone: ' + err.message);
  const names = fs.readdirSync(baseDir);
  const backup = names.find(n => n.startsWith('queue.json.corrupt-'));
  assert.ok(backup, 'a .corrupt-* backup file was created: ' + names.join(', '));
  assert.equal(fs.readFileSync(path.join(baseDir, backup), 'utf8'), brokenText, 'the backup holds the broken bytes, not a rewrite');
  assert.ok(!names.includes('queue.json'), 'the broken file was moved aside, so the next run is not a dead end');
  assert.deepEqual(queue.loadQueue({baseDir}), {version: 1, items: []}, 'the next load starts from a fresh empty queue');
});

// ---------- (6) tell: a failed write is worded, never the raw OS error ----------

test('w6 tell (6): an inbox write failure answers in words without the raw EISDIR text', (t) => {
  const base = tmpdir(t, 'muser-w6-tell-');
  const h = new tell.PeerHandle({sessionId: 'sess-w6-target', cwd: base, base, pid: process.pid}).start();
  t.after(() => h.stop());
  h.write();
  // Make the inbox path a directory: appending to it fails on the OS level
  // (EISDIR / EPERM) — exactly the raw error the old code passed through.
  const inbox = tell.inboxFile('sess-w6-target', {base});
  fs.mkdirSync(inbox, {recursive: true});
  const from = {pid: 12345, sessionId: 'sess-w6-sender', name: 'sender', cwd: base};
  const res = tell.send({from, target: 'sess-w6-target', text: '届くはずの伝言', base});
  assert.equal(res.ok, false, 'the send failed');
  assert.equal(res.error, 'write-failed');
  assert.ok(res.message.includes('書き込めませんでした'), 'the failure is worded: ' + res.message);
  assert.ok(res.message.includes('もう一度'), 'the wording names the next step: ' + res.message);
  assert.ok(!res.message.includes('EISDIR'), 'the raw OS error code never reaches the sender: ' + res.message);
  assert.ok(!res.message.includes('EPERM'), 'no raw platform code either: ' + res.message);
});
