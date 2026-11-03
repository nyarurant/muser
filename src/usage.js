'use strict';
// Local usage tally for this PC. There is no server-side Muse usage/limit
// endpoint (the gateway and muse.ai answer /usage, /api/usage,
// /api/subscription, /api/billing with 404 or the SPA shell), so turns and
// tool calls are counted here, on disk. Any real remaining allowance can only
// be read on muse.ai itself; formatSummary() says so.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {t} = require('./i18n');

// MUSER_USAGE_FILE redirects the store (tests, portable installs).
function file() {
  return process.env.MUSER_USAGE_FILE || path.join(os.homedir(), '.muser', 'usage.json');
}

function dayKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function emptyDay() { return {turns: 0, toolCalls: 0, inChars: 0, outChars: 0}; }
function fresh() { return {version: 1, days: {}, minutes: {}, totals: {realInTokens: 0, realOutTokens: 0}, updatedAt: null}; }

// Real-token windows beyond the day buckets (src/turn-usage.js numbers only):
// a per-minute tally makes "the last hour" a real trailing window, and a
// running total makes "all time" — the day buckets are pruned after a month,
// so neither can be derived from them.
function minuteKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return dayKey(d) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function cleanReal(b) {
  const d = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  return {realInTokens: num(d.realInTokens), realOutTokens: num(d.realOutTokens)};
}

// A corrupt store must never be silently wiped: move the bad file aside with a
// timestamp and only then start empty, so the original bytes survive.
function backupCorrupt(f) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(f, f + '.corrupt-' + stamp); } catch {}
}

// One day's bucket, healed: a hand-edited or corrupt value (turns as a string, a negative,
// a fraction) used to flow straight into +=, where a string concatenated and NaN poisoned
// the day for ever — the bad value was saved back on every record (audit #243). Every
// field goes through num(): numeric strings become numbers, junk becomes 0.
function cleanDay(day) {
  const d = day && typeof day === 'object' && !Array.isArray(day) ? day : {};
  const out = {turns: num(d.turns), toolCalls: num(d.toolCalls), inChars: num(d.inChars), outChars: num(d.outChars)};
  if (d.inTokens !== undefined) out.inTokens = num(d.inTokens);
  if (d.outTokens !== undefined) out.outTokens = num(d.outTokens);
  // Real per-turn tokens from live [usage] lines (src/turn-usage.js): kept apart
  // from the inTokens/outTokens estimates above, which stay estimate-only.
  if (d.realInTokens !== undefined) out.realInTokens = num(d.realInTokens);
  if (d.realOutTokens !== undefined) out.realOutTokens = num(d.realOutTokens);
  return out;
}

function load() {
  const f = file();
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return fresh(); }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.days && typeof data.days === 'object' && !Array.isArray(data.days)) {
      const days = {};
      for (const [k, v] of Object.entries(data.days)) if (v && typeof v === 'object' && !Array.isArray(v)) days[k] = cleanDay(v);
      const minutes = {};
      if (data.minutes && typeof data.minutes === 'object' && !Array.isArray(data.minutes)) {
        for (const [k, v] of Object.entries(data.minutes)) if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(k)) minutes[k] = cleanReal(v);
      }
      // A store written before the windows existed has no totals: seed them from
      // the days it still holds (real counting only began with those days, so
      // there is nothing older to miss).
      let totals;
      if (data.totals && typeof data.totals === 'object' && !Array.isArray(data.totals)) totals = cleanReal(data.totals);
      else { totals = {realInTokens: 0, realOutTokens: 0}; for (const d of Object.values(days)) { totals.realInTokens += d.realInTokens || 0; totals.realOutTokens += d.realOutTokens || 0; } }
      return {version: 1, days, minutes, totals, updatedAt: data.updatedAt || null};
    }
  } catch {}
  backupCorrupt(f);
  return fresh();
}

// Atomic save: uniquely named temp file + rename, so a crash mid-write can
// never leave a truncated usage.json behind.
function save(store) {
  const f = file();
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const data = {version: 1, days: store.days || {}, minutes: store.minutes || {}, totals: cleanReal(store.totals), updatedAt: new Date().toISOString()};
  const temp = f + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 1));
    fs.renameSync(temp, f);
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  return data;
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }

// Small lock around record's load+save (same shape as sessions.locked, kept local to this
// file): usage.json is shared by every muser window, and two windows recording at once used
// to drop one window's counts. The lock file carries an ownership token and only its owner
// unlinks it; a lock older than 5 s is taken to be left by a crashed window.
// Audit #244: the old shape defeated itself twice — it waited only 2 s (less than the 5 s
// stale age, so the takeover could never happen) and then ran the record WITHOUT the lock,
// reintroducing exactly the race the lock exists to prevent; and the wait was a busy-spin
// that froze the event loop for up to those 2 s on a call made after every tool call.
// Now the wait SLEEPS (Atomics.wait, as config.renameRetry does), lasts past the stale
// age so a crashed window's lock really is taken over, and on timeout it throws instead
// of running unlocked — every record() caller already treats a throw as "count dropped".
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) { Atomics.wait(WAIT_CELL, 0, 0, ms); }
function withLock(fn, {budgetMs = 6000, staleMs = 5000} = {}) {
  const f = file(), lock = f + '.lock', token = crypto.randomBytes(16).toString('hex'), until = Date.now() + budgetMs;
  try { fs.mkdirSync(path.dirname(f), {recursive: true}); } catch {}
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      // Windows answers EPERM / EBUSY / EACCES for a lock file its holder is just now
      // deleting: that is "taken", not "locks do not work here" (as config.withLock notes).
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error('usage store is busy: another window has held its lock for over ' + Math.round(budgetMs / 1000) + ' s');
      sleepMs(15);
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {} }
}

// Token estimate for a piece of text (audit #246): characters / 4 is an English-text
// rule of thumb. Non-ASCII text (Japanese above all for this user) tokenises at roughly
// one token per character, so those characters count 1 each and only the ASCII ones
// keep the /4 rate. Callers that pass just character counts keep the old /4 fallback —
// a stored count carries no script information to do better with.
function estTokens(text) {
  let ascii = 0, total = 0;
  for (const ch of String(text)) { total++; if (ch.codePointAt(0) < 0x80) ascii++; }
  return Math.round(ascii / 4) + (total - ascii);
}
// The estimate for one direction of a day bucket: the recorded text-based estimate
// when there is one, else the /4 fallback over the character count.
function dayTokens(day, charsKey, tokensKey) {
  return day[tokensKey] !== undefined ? day[tokensKey] : Math.round((day[charsKey] || 0) / 4);
}

// Accumulate a delta ({turns, toolCalls, inChars, outChars}) into today
// (local date) and persist. A delta may also carry the actual inText / outText, in
// which case a script-aware token estimate is stored alongside the character counts.
// Returns today's bucket.
function record(delta = {}) { return withLock(() => recordUnlocked(delta)); }
function recordUnlocked(delta = {}) {
  const store = load();
  const key = dayKey();
  const day = cleanDay(store.days[key]);
  day.turns += num(delta.turns);
  day.toolCalls += num(delta.toolCalls);
  day.inChars += typeof delta.inText === 'string' ? delta.inText.length : num(delta.inChars);
  day.outChars += typeof delta.outText === 'string' ? delta.outText.length : num(delta.outChars);
  if (typeof delta.inText === 'string') day.inTokens = (day.inTokens || 0) + estTokens(delta.inText);
  if (typeof delta.outText === 'string') day.outTokens = (day.outTokens || 0) + estTokens(delta.outText);
  // A turn that carried a live [usage] line: its real tokens accumulate here,
  // separately from the estimates above. delta.usage is the turn-usage object
  // ({inputTokens, outputTokens}); the explicit fields are the same numbers.
  const realIn = delta.usage?.inputTokens ?? delta.realInTokens;
  const realOut = delta.usage?.outputTokens ?? delta.realOutTokens;
  if (realIn !== undefined) day.realInTokens = (day.realInTokens || 0) + num(realIn);
  if (realOut !== undefined) day.realOutTokens = (day.realOutTokens || 0) + num(realOut);
  // The same real tokens into the minute bucket (the last-hour window) and the
  // running total (all time). Estimates never land here: these windows are
  // measured values only.
  if (realIn !== undefined || realOut !== undefined) {
    const mk = minuteKey();
    const bucket = cleanReal(store.minutes[mk]);
    bucket.realInTokens += num(realIn); bucket.realOutTokens += num(realOut);
    store.minutes[mk] = bucket;
    store.totals.realInTokens += num(realIn); store.totals.realOutTokens += num(realOut);
  }
  store.days[key] = day;
  // The tally grew one day entry forever: nothing ever removed an old day, though the
  // summary reads only the last 7. Keep a month (day keys sort as dates), pruned on record.
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - 31);
  const cutoff = dayKey(cutoffDate);
  for (const k of Object.keys(store.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k < cutoff) delete store.days[k];
  // Minute buckets only serve the last-hour window: keep a few hours of them
  // (keys sort as datetimes, like the day keys above).
  const mCutoff = minuteKey(new Date(Date.now() - 3 * 60 * 60 * 1000));
  for (const k of Object.keys(store.minutes)) if (k < mCutoff) delete store.minutes[k];
  save(store);
  return day;
}

function withTokens(day) {
  const d = cleanDay(day);
  const approxIn = dayTokens(d, 'inChars', 'inTokens'), approxOut = dayTokens(d, 'outChars', 'outTokens');
  return {...d, approxIn, approxOut, approxTokens: approxIn + approxOut};
}

function summary() {
  const store = load();
  const today = withTokens(store.days[dayKey()]);
  const last7 = emptyDay();
  let approxIn = 0, approxOut = 0, realIn = 0, realOut = 0; // summed per day, so text-estimated days and count-only days mix correctly
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const b = cleanDay(store.days[dayKey(d)]);
    last7.turns += b.turns;
    last7.toolCalls += b.toolCalls;
    last7.inChars += b.inChars;
    last7.outChars += b.outChars;
    approxIn += dayTokens(b, 'inChars', 'inTokens');
    approxOut += dayTokens(b, 'outChars', 'outTokens');
    realIn += b.realInTokens || 0;
    realOut += b.realOutTokens || 0;
  }
  // The last hour: the trailing 60 minute buckets (this minute and the 59
  // before it) out of the per-minute tally.
  const hour = {realInTokens: 0, realOutTokens: 0};
  const hCutoff = minuteKey(new Date(Date.now() - 59 * 60 * 1000));
  for (const [k, b] of Object.entries(store.minutes || {})) if (k >= hCutoff) { hour.realInTokens += b.realInTokens || 0; hour.realOutTokens += b.realOutTokens || 0; }
  return {today, last7: {...last7, approxIn, approxOut, approxTokens: approxIn + approxOut, realInTokens: realIn, realOutTokens: realOut}, lastHour: hour, allTime: cleanReal(store.totals), note: t('トークン数は文字数 ÷ 4 の概算です。')};
}

function limits() {
  return {
    // The environment variables, else the saved settings (/settings).
    dailyTurns: require('./settings').numberValue('dailyTurnLimit'),
    perTurnTools: require('./settings').numberValue('maxToolCallsPerTurn'),
  };
}

function bucketLine(b) {
  return t('ターン {turns} / ツール {toolCalls} 回 / 約 {tokens} tokens（入 {input} / 出 {output}）',
    {turns: b.turns, toolCalls: b.toolCalls, tokens: b.approxTokens, input: b.approxIn ?? Math.round(b.inChars / 4), output: b.approxOut ?? Math.round(b.outChars / 4)});
}

function formatSummary() {
  const s = summary();
  const lim = limits();
  const {formatTokens} = require('./turn-usage');
  // A window's real line, only when that window measured anything: the estimate
  // lines stand alone otherwise (as today's real line always behaved).
  const realLine = (label, b) => (b.realInTokens || b.realOutTokens)
    ? [t(label, {formatted: formatTokens(b.realInTokens || 0) + ' in / ' + formatTokens(b.realOutTokens || 0) + ' out'})] : [];
  return [
    t('muser の記録（この PC で数えた目安）'),
    t('今日: {line}', {line: bucketLine(s.today)}),
    // The real tokens, window by window, next to the estimates they belong to:
    // the last hour, today, the last 7 days and all time (Muse's measured
    // values, labelled as such, never mixed into the estimates).
    ...realLine('直近1時間の実績: {formatted}（Muse の実測値）', s.lastHour),
    ...realLine('今日の実績: {formatted}（Muse の実測値）', s.today),
    t('直近7日: {line}', {line: bucketLine(s.last7)}),
    ...realLine('直近7日の実績: {formatted}（Muse の実測値）', s.last7),
    ...realLine('累計の実績: {formatted}（Muse の実測値）', s.allTime),
    t('上限: 1ターンのツール上限 {perTurn} 回（MUSER_MAX_TOOL_CALLS_PER_TURN） / 1日のターン上限 {daily}',
      {perTurn: lim.perTurnTools, daily: lim.dailyTurns ? String(lim.dailyTurns) : t('なし')}),
  ].join('\n');
}

// ---- The real Muse plan usage (weekly %, reset time, top-up), as muse.ai and Muse Desktop
// Community show it. The web reads it from a Next.js server action, fetchSubscriptionAction;
// its id is a build hash, so it is found in the signed-in page's JS chunks once, cached on
// disk, and looked up again only when a call with the cached id fails (a new build).
function actionFile() { return path.join(path.dirname(file()), 'subscription-action.json'); }
function cachedAction() { try { return JSON.parse(fs.readFileSync(actionFile(), 'utf8')).id || null; } catch { return null; } }
function cacheAction(id) { try { fs.mkdirSync(path.dirname(actionFile()), {recursive: true}); fs.writeFileSync(actionFile(), JSON.stringify({id, at: new Date().toISOString()})); } catch {} }

async function findAction(web, maxChunks = 2000, deadlineMs = 30000) {
  // An aggregate deadline for the whole crawl: each pageText has its own 15 s timeout, so
  // without one a 2,000-chunk crawl could run for hours. Past ~30 s the lookup gives up with
  // the same not-found error a crawl that ran out of chunks gives.
  const until = Date.now() + deadlineMs;
  const html = await web.pageText('/');
  const queue = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m => m[1]))], seen = new Set();
  while (queue.length && seen.size < maxChunks) {
    if (Date.now() >= until) break;
    const f = queue.shift(); if (seen.has(f)) continue; seen.add(f);
    let text; try { text = await web.pageText('/_next/static/chunks/' + f); } catch { continue; }
    if (Date.now() >= until) break;
    const m = text.includes('fetchSubscriptionAction') && text.match(/createServerReference\)\("([0-9a-f]{40,44})"[^)]{0,160}"fetchSubscriptionAction"\)/);
    if (m) return m[1];
    for (const ref of text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) if (!seen.has(ref[1])) queue.push(ref[1]);
  }
  throw new Error(t('Muse の利用状況の取得先が見つかりませんでした'));
}

function parseSubscription(text) {
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^[0-9a-f]+:(\{.*\})\s*$/); if (!m) continue;
    try { const v = JSON.parse(m[1]); if (v && typeof v === 'object' && v.subscription) return v.subscription; } catch {}
  }
  return null;
}

function shapePlan(s) {
  const str = v => typeof v === 'string' ? v.slice(0, 200) : null, n = v => Number.isFinite(v) ? v : null;
  const resets = n(s.usage?.resetsAt);
  return {
    plan: str(s.tier?.name), paid: s.tier?.isPaid === true,
    percentUsed: n(s.usage?.percentUsed), quotaStatus: str(s.usage?.quotaStatus), state: str(s.usage?.state),
    resetsAt: resets === null ? null : resets < 1e12 ? resets * 1000 : resets,
    status: str(s.statusSubtitle), usageValue: str(s.usageRowValueLabel), topupValue: str(s.topupRowValueLabel),
    topupBalance: n(s.topupBalance), topupTotal: n(s.topupTotal),
  };
}

let sharedWeb = null;
function resetWeb() { sharedWeb = null; lastFind = 0; lastFindFail = 0; } // after a new login: new cookies, and the id may be looked up at once
// Any failed read (a lapsed login too) was taken for a new build and crawled up to 2,000 page
// chunks, after every turn and at every start. The id is looked up again at most once an hour.
const FIND_EVERY_MS = 3600 * 1000;
// A FAILED lookup used to stamp the same once-an-hour gate (lastFind was set before the
// crawl even ran), so one transient failure blocked every retry for an hour and, after
// the site recovered, plan() still just threw the generic error (audit #245). A success
// stamps the hour; a failure stamps only this short retry delay.
const FIND_RETRY_MS = 60 * 1000;
let lastFind = 0, lastFindFail = 0;
async function plan(web) {
  web ??= sharedWeb ??= require('./web').createWeb();
  let id = cachedAction();
  let found = false, retried = false;
  for (let step = 0; step < 5; step++) {
    if (!id) {
      if (found) break;
      const now = Date.now();
      if (now - lastFind < FIND_EVERY_MS || now - lastFindFail < FIND_RETRY_MS) break;
      found = true;
      try { id = await findAction(web); } catch (e) { lastFindFail = Date.now(); throw e; }
      lastFind = Date.now(); cacheAction(id);
    }
    let r = null, err = null;
    try { r = await web.serverAction(id, [{includeAgreement: true}]); } catch (e) { err = e; }
    const sub = r && r.ok ? parseSubscription(r.text) : null;
    if (sub) return shapePlan(sub);
    // A 404/410 names the action id itself as gone: it is stale, look it up again (once).
    // Anything else (a thrown network error, a 401/5xx, an unparseable reply) may be a
    // passing failure of a perfectly good id: retry the SAME id once before discarding
    // it — a valid cached id used to be thrown away on any temporary failure (#245).
    if (!err && r && !r.ok && (r.status === 404 || r.status === 410)) { id = null; retried = false; continue; }
    if (!retried) { retried = true; continue; }
    if (!found) { id = null; retried = false; continue; } // the refound id gets its own try above; a found id that fails twice ends here
    break;
  }
  throw new Error(t('Muse の利用状況を読み込めませんでした'));
}

function formatPlan(p) {
  const locale = require('./i18n').lang() === 'en' ? 'en-US' : 'ja-JP'; // the date was Japanese in the English UI too
  const at = p.resetsAt ? new Date(p.resetsAt).toLocaleString(locale, {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '?';
  return [
    t('Muse の利用状況（muse.ai と同じ値）'),
    t('{plan} · 週の使用量 {percent}%（{at} にリセット）{quota}', {plan: p.plan || t('プラン不明'), percent: p.percentUsed ?? '?', at, quota: p.quotaStatus && p.quotaStatus !== 'SUFFICIENT' ? ' · ' + p.quotaStatus : ''}),
    ...(p.topupValue ? [t('追加分: {value}', {value: p.topupValue})] : []),
  ].join('\n');
}

module.exports = {record, load, save, summary, limits, formatSummary, file, dayKey, minuteKey, plan, resetWeb, formatPlan, parseSubscription, shapePlan, findAction, withLock, estTokens, cleanDay};
