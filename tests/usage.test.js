'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// usage.js resolves its store path from MUSER_USAGE_FILE on every call, so
// each test can point it at its own file inside one temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-usage-'));
require('node:test').after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const usage = require('../src/usage');

function useFile(name) {
  const f = path.join(tmp, name);
  process.env.MUSER_USAGE_FILE = f;
  return f;
}

test('record: accumulates into today and persists the documented shape', () => {
  const f = useFile('a.json');
  usage.record({turns: 1, toolCalls: 2, inChars: 100, outChars: 40});
  const day = usage.record({turns: 1, toolCalls: 1, inChars: 4, outChars: 8});
  assert.deepEqual(day, {turns: 2, toolCalls: 3, inChars: 104, outChars: 48});
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(typeof raw.updatedAt, 'string');
  assert.deepEqual(raw.days[usage.dayKey()], {turns: 2, toolCalls: 3, inChars: 104, outChars: 48});
  // Atomic save leaves no temp files behind.
  assert.deepEqual(fs.readdirSync(tmp).filter(x => x.includes('.tmp-')), []);
});

test('record: junk deltas count as zero, never NaN or negative', () => {
  useFile('b.json');
  const day = usage.record({turns: -3, toolCalls: 'x', inChars: NaN, outChars: 2.9});
  assert.deepEqual(day, {turns: 0, toolCalls: 0, inChars: 0, outChars: 2});
});

test('summary: today, last7 sum and approxTokens = round(chars / 4)', () => {
  useFile('c.json');
  usage.record({turns: 2, toolCalls: 3, inChars: 104, outChars: 48});
  const s = usage.summary();
  assert.equal(s.today.turns, 2);
  assert.equal(s.today.approxTokens, Math.round(152 / 4));
  assert.equal(s.last7.turns, 2, 'last7 includes today');
  assert.equal(s.last7.toolCalls, 3);
  assert.equal(s.last7.approxTokens, 38);
  assert.match(s.note, /概算/);
});

test('summary: last7 reaches back over earlier days', () => {
  useFile('d.json');
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  usage.save({days: {[usage.dayKey(threeDaysAgo)]: {turns: 5, toolCalls: 7, inChars: 40, outChars: 60}}});
  usage.record({turns: 1});
  const s = usage.summary();
  assert.equal(s.today.turns, 1);
  assert.equal(s.last7.turns, 6);
  assert.equal(s.last7.approxTokens, Math.round(100 / 4));
});

test('limits: env-driven, with the documented defaults', () => {
  delete process.env.MUSER_DAILY_TURN_LIMIT;
  delete process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
  assert.deepEqual(usage.limits(), {dailyTurns: 0, perTurnTools: 250});
  process.env.MUSER_DAILY_TURN_LIMIT = '10';
  process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = '5';
  assert.deepEqual(usage.limits(), {dailyTurns: 10, perTurnTools: 5});
  process.env.MUSER_DAILY_TURN_LIMIT = 'abc';
  assert.equal(usage.limits().dailyTurns, 0, 'garbage env falls back to unset');
  delete process.env.MUSER_DAILY_TURN_LIMIT;
  delete process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
});

test('load: corrupt file is backed up, not wiped, and recording recovers', () => {
  const f = useFile('e.json');
  fs.writeFileSync(f, 'not json {{{');
  const loaded = usage.load();
  assert.deepEqual(loaded.days, {});
  const backups = fs.readdirSync(tmp).filter(x => x.startsWith('e.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(tmp, backups[0]), 'utf8'), 'not json {{{');
  const day = usage.record({turns: 1});
  assert.equal(day.turns, 1);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).days[usage.dayKey()].turns, 1);
});

test('load: missing file starts fresh; wrong shape is treated as corrupt', () => {
  const f = useFile('f.json');
  assert.deepEqual(usage.load(), {version: 1, days: {}, minutes: {}, totals: {realInTokens: 0, realOutTokens: 0}, updatedAt: null});
  fs.writeFileSync(f, JSON.stringify({days: [1, 2, 3]}));
  assert.deepEqual(usage.load().days, {});
  assert.equal(fs.readdirSync(tmp).filter(x => x.startsWith('f.json.corrupt-')).length, 1);
});

test('formatSummary: Japanese block with today, last7 and limits (the real plan usage is formatPlan)', () => {
  useFile('g.json');
  delete process.env.MUSER_DAILY_TURN_LIMIT;
  delete process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
  usage.record({turns: 2, toolCalls: 3, inChars: 104, outChars: 48});
  const text = usage.formatSummary();
  assert.match(text, /^muser の記録（この PC で数えた目安）$/m);
  assert.match(text, /^今日: ターン 2 \/ ツール 3 回 \/ 約 38 tokens（入 26 \/ 出 12）$/m);
  assert.match(text, /^直近7日: ターン 2 \//m);
  assert.match(text, /1ターンのツール上限 250 回（MUSER_MAX_TOOL_CALLS_PER_TURN）/);
  assert.match(text, /1日のターン上限 なし/);
  process.env.MUSER_DAILY_TURN_LIMIT = '9';
  assert.match(usage.formatSummary(), /1日のターン上限 9/);
  delete process.env.MUSER_DAILY_TURN_LIMIT;
});

// Audit #243: a hand-edited bucket (turns as a string, junk, negatives) used to flow
// into += — concatenating or NaN-poisoning the day, then being saved back for ever.
test('record: corrupt stored buckets are healed to numbers, never concatenated', () => {
  const f = useFile('i.json');
  const y = new Date(); y.setDate(y.getDate() - 1);
  fs.writeFileSync(f, JSON.stringify({version: 1, updatedAt: null, days: {
    [usage.dayKey()]: {turns: '3', toolCalls: 'x', inChars: -5, outChars: 2.9},
    [usage.dayKey(y)]: {turns: '2', toolCalls: 1, inChars: 0, outChars: 0},
    bogus: 'not a bucket',
  }}));
  const day = usage.record({turns: 1});
  assert.deepEqual(day, {turns: 4, toolCalls: 0, inChars: 0, outChars: 2}, 'string "3" + 1 is 4, not "31"');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(typeof raw.days[usage.dayKey()].turns, 'number', 'the healed value is what gets saved back');
  assert.equal(raw.days.bogus, undefined, 'a non-object day is dropped');
  const s = usage.summary();
  assert.equal(s.last7.turns, 6, 'last7 sums numbers from both days');
  assert.ok(Number.isFinite(s.last7.approxTokens));
});

// Audit #244: the lock wait must not busy-spin, must not fall back to running unlocked
// (the race the lock exists to prevent), and a crashed window's stale lock must
// actually be taken over — the old 2 s budget was shorter than the 5 s stale age.
test('withLock: a held lock is waited out by sleeping, then refused — never run unlocked', () => {
  const f = useFile('j.json');
  const lock = f + '.lock';
  fs.writeFileSync(lock, 'other-window');
  let ran = false;
  const t0 = Date.now();
  assert.throws(() => usage.withLock(() => { ran = true; }, {budgetMs: 200, staleMs: 60000}), /usage store is busy/);
  assert.equal(ran, false, 'the record did not proceed without the lock');
  assert.ok(Date.now() - t0 >= 150, 'it waited on the lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other-window', 'the foreign lock was left alone');
  fs.rmSync(lock, {force: true});
});

test('record: a stale lock left by a crashed window is taken over', () => {
  const f = useFile('k.json');
  const lock = f + '.lock';
  fs.writeFileSync(lock, 'crashed-window');
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(lock, old, old); // older than the 5 s stale age
  const day = usage.record({turns: 1});
  assert.equal(day.turns, 1, 'the record landed');
  assert.equal(fs.existsSync(lock), false, 'the taken-over lock was released afterwards');
});

// Audit #246: the token estimate is script-aware when the text is recorded —
// Japanese counts at ~1 token per character, ASCII at /4; counts-only records keep /4.
test('record: text-based token estimates count Japanese per character', () => {
  useFile('l.json');
  assert.equal(usage.estTokens('abcdefgh'), 2);
  assert.equal(usage.estTokens('あいうえお'), 5);
  const day = usage.record({outText: 'あ'.repeat(100), inText: 'abcd'});
  assert.equal(day.outChars, 100);
  assert.equal(day.outTokens, 100, 'not 25 (the /4 rule)');
  assert.equal(day.inTokens, 1);
  const s = usage.summary();
  assert.equal(s.today.approxTokens, 101);
  assert.match(usage.formatSummary(), /約 101 tokens（入 1 \/ 出 100）/);
});

test('file: default store lives under ~/.muser, env wins', () => {
  delete process.env.MUSER_USAGE_FILE;
  assert.equal(usage.file(), path.join(os.homedir(), '.muser', 'usage.json'));
  useFile('h.json');
  assert.equal(usage.file(), path.join(tmp, 'h.json'));
});

test('record: real tokens from a live [usage] line accumulate separately from the estimates', () => {
  useFile('real.json');
  const day = usage.record({turns: 1, outText: 'done', usage: {inputTokens: 130841, outputTokens: 395, source: 'provider', formatted: '130.8k in / 395 out'}});
  assert.equal(day.realInTokens, 130841);
  assert.equal(day.realOutTokens, 395);
  usage.record({turns: 1, usage: {inputTokens: 1000, outputTokens: 5}});
  const s = usage.summary();
  assert.equal(s.today.realInTokens, 131841);
  assert.equal(s.today.realOutTokens, 400);
  assert.equal(s.last7.realInTokens, 131841);
  // The estimate is untouched by the real numbers: both are shown, labelled.
  assert.match(usage.formatSummary(), /今日: ターン 2 \/ ツール 0 回 \/ 約/);
  assert.match(usage.formatSummary(), /今日の実績: 131\.8k in \/ 400 out（Muse の実測値）/);
});

test('formatSummary: no real line when no turn carried usage', () => {
  useFile('noreal.json');
  usage.record({turns: 1, outText: 'hello'});
  assert.ok(!usage.formatSummary().includes('実績'), 'the estimate stands alone');
});

test('windows: real tokens land in the last hour and the all-time total; /usage shows all four windows', () => {
  useFile('windows.json');
  usage.record({turns: 1, usage: {inputTokens: 1000, outputTokens: 50}});
  usage.record({turns: 1, usage: {inputTokens: 2000, outputTokens: 25}});
  const s = usage.summary();
  assert.equal(s.lastHour.realInTokens, 3000);
  assert.equal(s.lastHour.realOutTokens, 75);
  assert.equal(s.allTime.realInTokens, 3000);
  assert.equal(s.allTime.realOutTokens, 75);
  const text = usage.formatSummary();
  assert.match(text, /直近1時間の実績: 3k in \/ 75 out（Muse の実測値）/);
  assert.match(text, /今日の実績: 3k in \/ 75 out（Muse の実測値）/);
  assert.match(text, /直近7日の実績: 3k in \/ 75 out（Muse の実測値）/);
  assert.match(text, /累計の実績: 3k in \/ 75 out（Muse の実測値）/);
});

test('windows: an old minute bucket leaves the last hour but stays in the total; record prunes the oldest', () => {
  const f = useFile('oldmin.json');
  const twoH = usage.minuteKey(new Date(Date.now() - 2 * 3600 * 1000));
  const fourH = usage.minuteKey(new Date(Date.now() - 4 * 3600 * 1000));
  fs.writeFileSync(f, JSON.stringify({version: 1, updatedAt: null, days: {}, minutes: {[twoH]: {realInTokens: 700, realOutTokens: 7}, [fourH]: {realInTokens: 300, realOutTokens: 3}}, totals: {realInTokens: 1000, realOutTokens: 10}}));
  let s = usage.summary();
  assert.equal(s.lastHour.realInTokens, 0, 'nothing in the trailing hour');
  assert.equal(s.allTime.realInTokens, 1000);
  usage.record({usage: {inputTokens: 10, outputTokens: 1}});
  s = usage.summary();
  assert.equal(s.lastHour.realInTokens, 10);
  assert.equal(s.allTime.realInTokens, 1010);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.minutes[fourH], undefined, 'buckets older than a few hours are pruned on record');
  assert.equal(raw.minutes[twoH].realInTokens, 700, 'recent buckets are kept');
  assert.equal(raw.totals.realInTokens, 1010, 'the total is persisted');
});

test('windows: a store written before the windows existed seeds its total from the days it holds', () => {
  const f = useFile('legacy.json');
  fs.writeFileSync(f, JSON.stringify({version: 1, updatedAt: null, days: {[usage.dayKey()]: {turns: 1, toolCalls: 0, inChars: 0, outChars: 0, realInTokens: 500, realOutTokens: 5}}}));
  assert.equal(usage.summary().allTime.realInTokens, 500, 'seeded from the retained days');
  usage.record({usage: {inputTokens: 100, outputTokens: 2}});
  assert.equal(usage.summary().allTime.realInTokens, 600);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).totals.realInTokens, 600, 'and the seeded total is what gets saved');
});
