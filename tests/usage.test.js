'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// usage.js resolves its store path from MUSER_USAGE_FILE on every call, so
// each test can point it at its own file inside one temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-usage-'));
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
  assert.deepEqual(usage.load(), {version: 1, days: {}, updatedAt: null});
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

test('file: default store lives under ~/.muser, env wins', () => {
  delete process.env.MUSER_USAGE_FILE;
  assert.equal(usage.file(), path.join(os.homedir(), '.muser', 'usage.json'));
  useFile('h.json');
  assert.equal(usage.file(), path.join(tmp, 'h.json'));
});
