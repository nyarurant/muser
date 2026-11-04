'use strict';
// The real-token windows of /usage and /status after the 2026-11-04 report "直近7日なんかへんじゃね":
// minute buckets saved with local keys before the UTC switch, the since-note on windows that
// began counting late, and the estimate no longer printed next to the real numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const usage = require('../src/usage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-usage-windows-'));
function useFile(name) { const f = path.join(tmp, name); process.env.MUSER_USAGE_FILE = f; return f; }
const p = n => String(n).padStart(2, '0');
const localKey = d => usage.dayKey(d) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());

test('a minute bucket saved with the old local key still counts in the last hour', () => {
  const f = useFile('legacy-minutes.json');
  const tenAgo = new Date(Date.now() - 10 * 60 * 1000);
  fs.writeFileSync(f, JSON.stringify({version: 1, days: {}, minutes: {[localKey(tenAgo)]: {realInTokens: 500, realOutTokens: 5}}, totals: {realInTokens: 500, realOutTokens: 5}}));
  assert.equal(usage.summary().lastHour.realInTokens, 500);
  // The next record writes the converted key; the old form is gone, nothing is counted twice.
  usage.record({usage: {inputTokens: 10, outputTokens: 1}});
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Object.keys(raw.minutes).every(k => k.endsWith('Z')), 'only UTC keys are written');
  assert.equal(usage.summary().lastHour.realInTokens, 510);
});

test('an old local key and a new UTC key for the same minute are added together', () => {
  const f = useFile('same-minute.json');
  const now = new Date();
  fs.writeFileSync(f, JSON.stringify({version: 1, days: {}, minutes: {[localKey(now)]: {realInTokens: 3, realOutTokens: 0}, [usage.minuteKey(now)]: {realInTokens: 4, realOutTokens: 0}}, totals: {realInTokens: 7, realOutTokens: 0}}));
  assert.equal(usage.summary().lastHour.realInTokens, 7);
});

test('7 days and all time say since when real counting began', () => {
  const f = useFile('since.json');
  const today = usage.dayKey(), two = new Date(); two.setDate(two.getDate() - 2);
  fs.writeFileSync(f, JSON.stringify({version: 1, days: {
    [usage.dayKey(two)]: {turns: 3, toolCalls: 1, inChars: 400, outChars: 40},
    [today]: {turns: 1, toolCalls: 0, inChars: 0, outChars: 0, realInTokens: 1200000, realOutTokens: 3000},
  }, minutes: {}, totals: {realInTokens: 1200000, realOutTokens: 3000}}));
  const s = usage.summary(), label = usage.sinceLabel(today);
  assert.equal(s.realSince, today);
  assert.equal(s.realSince7, today, 'counting began inside the 7 days');
  const text = usage.formatSummary();
  assert.match(text, new RegExp('直近7日の実績: 1\\.2M in / 3k out（Muse の実測値）（' + label + ' から記録）'));
  assert.match(text, new RegExp('累計の実績: 1\\.2M in / 3k out（Muse の実測値）（' + label + ' から記録）'));
  // The window lines carry no characters ÷ 4 estimate once real numbers exist.
  assert.match(text, /^直近7日: ターン 4 \/ ツール 1 回$/m);
  assert.ok(!/約 .* tokens/.test(text.split('\n').filter(l => l.startsWith('直近7日') || l.startsWith('今日')).join('\n')));
});

test('realSince survives the days being pruned, and the 7-day note goes once counting is older', () => {
  const f = useFile('since-old.json');
  fs.writeFileSync(f, JSON.stringify({version: 1, days: {}, minutes: {}, totals: {realInTokens: 9, realOutTokens: 1}, realSince: '2026-01-02'}));
  const s = usage.summary();
  assert.equal(s.realSince, '2026-01-02');
  assert.equal(s.realSince7, null, 'counting began before the 7 days: no note there');
  usage.record({usage: {inputTokens: 1, outputTokens: 0}});
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).realSince, '2026-01-02', 'kept on save');
});

test('the estimate still shows, in k/M form, where Muse measured nothing', () => {
  useFile('estimate-only.json');
  usage.record({turns: 1, inChars: 4000000, outChars: 0});
  assert.match(usage.formatSummary(), /^今日: ターン 1 \/ ツール 0 回 \/ 約 1M tokens（入 1M \/ 出 0）$/m);
});
