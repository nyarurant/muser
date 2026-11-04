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
const {renameRetry} = require('./config');

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
// so neither can be derived from them. The minute buckets are keyed in UTC:
// a local wall-clock key collided with itself when a DST fall-back repeated
// an hour (and when the clock or timezone moved backwards), merging two
// different real minutes into one bucket (fifth audit f3-5, c19 #4). The day
// buckets stay local — "today" is a calendar day by design. The trailing Z marks the UTC form:
// the earlier local keys had the same shape without it, and read as UTC they sat hours in the
// future, so "the last hour" showed 0 right after the switch. load() converts them (legacyMinute).
function minuteKey(d = new Date()) {
  return d.toISOString().slice(0, 16) + 'Z';
}
// A minute key written before the UTC form: local wall-clock time, no Z.
function legacyMinute(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(k);
  return m ? minuteKey(new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : null;
}
// The first day that holds real tokens: when real counting began, as far as the kept days tell.
function firstRealDay(days) {
  return Object.keys(days).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (days[k].realInTokens || days[k].realOutTokens)).sort()[0] || null;
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
  // How many of the characters the text-based estimate covers (c19 #1): the
  // rest of inChars/outChars arrived as bare counts and estimates at /4.
  if (d.inTextChars !== undefined) out.inTextChars = num(d.inTextChars);
  if (d.outTextChars !== undefined) out.outTextChars = num(d.outTextChars);
  // Real per-turn tokens from live [usage] lines (src/turn-usage.js): kept apart
  // from the inTokens/outTokens estimates above, which stay estimate-only.
  if (d.realInTokens !== undefined) out.realInTokens = num(d.realInTokens);
  if (d.realOutTokens !== undefined) out.realOutTokens = num(d.realOutTokens);
  return out;
}

function load() {
  const f = file();
  let raw;
  // Only "there is no store yet" may start fresh. Any other read failure
  // (EACCES/EPERM while another window or a scanner holds the file) used to
  // be read as an empty store, and record() then saved that empty store plus
  // one turn over a month of history and the all-time total (fifth f1-2).
  // Throw instead: record() drops this one count, the data survives.
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return fresh(); throw e; }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.days && typeof data.days === 'object' && !Array.isArray(data.days)) {
      const days = {};
      for (const [k, v] of Object.entries(data.days)) if (v && typeof v === 'object' && !Array.isArray(v)) days[k] = cleanDay(v);
      const minutes = {};
      if (data.minutes && typeof data.minutes === 'object' && !Array.isArray(data.minutes)) {
        for (const [k, v] of Object.entries(data.minutes)) {
          const key = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(k) ? k : legacyMinute(k);
          if (!key) continue;
          const b = cleanReal(v), had = minutes[key];
          minutes[key] = had ? {realInTokens: had.realInTokens + b.realInTokens, realOutTokens: had.realOutTokens + b.realOutTokens} : b;
        }
      }
      // A store written before the windows existed has no totals: seed them from
      // the days it still holds (real counting only began with those days, so
      // there is nothing older to miss).
      let totals;
      if (data.totals && typeof data.totals === 'object' && !Array.isArray(data.totals)) totals = cleanReal(data.totals);
      else { totals = {realInTokens: 0, realOutTokens: 0}; for (const d of Object.values(days)) { totals.realInTokens += d.realInTokens || 0; totals.realOutTokens += d.realOutTokens || 0; } }
      // When real counting began: kept once known, so it survives the month of days being pruned.
      const realSince = typeof data.realSince === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.realSince) ? data.realSince : firstRealDay(days);
      return {version: 1, days, minutes, totals, realSince, updatedAt: data.updatedAt || null};
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
  const data = {version: 1, days: store.days || {}, minutes: store.minutes || {}, totals: cleanReal(store.totals), ...(store.realSince ? {realSince: store.realSince} : {}), updatedAt: new Date().toISOString()};
  const temp = f + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 1));
    // Windows refuses to replace a file another window has open for reading
    // (EPERM) — the same renameRetry every other store uses (c19 #3).
    renameRetry(temp, f);
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
function removePath(p) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch {} } }
// Move a lock file aside and check it really is the file the caller judged:
// the rename is atomic (only one contender wins it), and if the moved file
// turns out to be a successor's fresh lock (replaced between the check and
// the rename), it is put back instead of deleted (c19 #14, the shape
// sessions.locked already uses). Returns true when the observed file — and
// only it — was removed.
function retireLock(lock, aside, observed) {
  try { fs.renameSync(lock, aside); } catch { return false; }
  let moved = null;
  try { moved = fs.readFileSync(aside, 'utf8'); } catch {}
  if (moved !== observed) {
    try { fs.renameSync(aside, lock); } catch { removePath(aside); }
    return false;
  }
  removePath(aside);
  return true;
}
function withLock(fn, {budgetMs = 6000, staleMs = 5000} = {}) {
  const f = file(), lock = f + '.lock', token = crypto.randomBytes(16).toString('hex'), until = Date.now() + budgetMs;
  try { fs.mkdirSync(path.dirname(f), {recursive: true}); } catch {}
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      // Windows answers EPERM / EBUSY / EACCES for a lock file its holder is just now
      // deleting: that is "taken", not "locks do not work here" (as config.withLock notes).
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      // A stale lock is retired by renaming it aside (never by unlinking the
      // shared name, which could by then be a successor's lock). Every path
      // that does not retire a lock falls through to the budget check and
      // the sleep: the old `catch { continue; }` skipped both, so a lock
      // whose stat/unlink kept failing (a directory at the lock path, a
      // file held without delete sharing) spun at 100% CPU for ever and
      // froze the window (c19 #2).
      let retired = false;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          let observed = null;
          try { observed = fs.readFileSync(lock, 'utf8'); } catch {}
          retired = retireLock(lock, lock + '.stale-' + token, observed);
        }
      } catch {}
      if (retired) continue;
      if (Date.now() > until) throw new Error('usage store is busy: another window has held its lock for over ' + Math.round(budgetMs / 1000) + ' s');
      sleepMs(15);
    }
  }
  try { return fn(); }
  finally {
    // Release by the same rename-aside check, so a lock this window lost as
    // stale is never deleted from under its successor (c19 #14).
    const rel = lock + '.rel-' + token;
    try { fs.renameSync(lock, rel); } catch {}
    try { if (fs.readFileSync(rel, 'utf8') === token) removePath(rel); else { try { fs.renameSync(rel, lock); } catch { removePath(rel); } } } catch {}
  }
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
// The estimate for one direction of a day bucket (c19 #1): the text-based
// estimate covers only the characters that arrived WITH their text (tracked
// in inTextChars/outTextChars); characters that arrived as bare counts keep
// the /4 fallback. The old shape returned the text estimate alone as soon as
// it existed, so mixing the two kinds inside one day silently dropped the
// count-only part (or froze it out for the rest of the day). A bucket written
// before the split was tracked has no textChars: its estimate stands as-is
// (its mix is unknowable) and the split starts with its current char count.
function dayTokens(day, charsKey, tokensKey, textCharsKey) {
  if (day[tokensKey] === undefined) return Math.round((day[charsKey] || 0) / 4);
  if (day[textCharsKey] === undefined) return day[tokensKey];
  return day[tokensKey] + Math.round(Math.max(0, (day[charsKey] || 0) - day[textCharsKey]) / 4);
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
  // The text-char split for a bucket that has text estimates but predates
  // the split (c19 #1): everything it already holds counts as text-covered,
  // so only characters from now on are split. A bucket with no estimate yet
  // starts at 0, keeping the count-only characters it holds on the /4 side.
  let inTextChars = day.inTextChars, outTextChars = day.outTextChars;
  if (inTextChars === undefined && day.inTokens !== undefined) inTextChars = day.inChars;
  if (outTextChars === undefined && day.outTokens !== undefined) outTextChars = day.outChars;
  day.turns += num(delta.turns);
  day.toolCalls += num(delta.toolCalls);
  day.inChars += typeof delta.inText === 'string' ? delta.inText.length : num(delta.inChars);
  day.outChars += typeof delta.outText === 'string' ? delta.outText.length : num(delta.outChars);
  if (typeof delta.inText === 'string') { day.inTokens = (day.inTokens || 0) + estTokens(delta.inText); inTextChars = (inTextChars || 0) + delta.inText.length; }
  if (typeof delta.outText === 'string') { day.outTokens = (day.outTokens || 0) + estTokens(delta.outText); outTextChars = (outTextChars || 0) + delta.outText.length; }
  if (inTextChars !== undefined && day.inTokens !== undefined) day.inTextChars = inTextChars;
  if (outTextChars !== undefined && day.outTokens !== undefined) day.outTextChars = outTextChars;
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
    if (!store.realSince && (num(realIn) || num(realOut))) store.realSince = key;
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
  const approxIn = dayTokens(d, 'inChars', 'inTokens', 'inTextChars'), approxOut = dayTokens(d, 'outChars', 'outTokens', 'outTextChars');
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
    approxIn += dayTokens(b, 'inChars', 'inTokens', 'inTextChars');
    approxOut += dayTokens(b, 'outChars', 'outTokens', 'outTextChars');
    realIn += b.realInTokens || 0;
    realOut += b.realOutTokens || 0;
  }
  // The last hour: the trailing 60 minute buckets (this minute and the 59
  // before it) out of the per-minute tally. Both bounds: buckets from a
  // clock that has since been set back are in the future and must not count
  // as "the last hour" until real time reaches them (c19 #4).
  const hour = {realInTokens: 0, realOutTokens: 0};
  const hCutoff = minuteKey(new Date(Date.now() - 59 * 60 * 1000));
  const hEnd = minuteKey();
  for (const [k, b] of Object.entries(store.minutes || {})) if (k >= hCutoff && k <= hEnd) { hour.realInTokens += b.realInTokens || 0; hour.realOutTokens += b.realOutTokens || 0; }
  const start7 = new Date(); start7.setDate(start7.getDate() - 6);
  return {today, last7: {...last7, approxIn, approxOut, approxTokens: approxIn + approxOut, realInTokens: realIn, realOutTokens: realOut}, lastHour: hour, allTime: cleanReal(store.totals),
    // The real windows count only from realSince: a 7-day line that began counting 2 days ago
    // read like 7 days, and equal to "today" and "all time" it looked broken.
    realSince: store.realSince || null, realSince7: store.realSince && store.realSince > dayKey(start7) ? store.realSince : null,
    note: t('トークン数は文字数 ÷ 4 の概算です。')};
}
// "11/4": the day real counting began, for the since-notes.
function sinceLabel(day) { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || ''); return m ? (+m[1]) + '/' + (+m[2]) : ''; }

function limits() {
  return {
    // The environment variables, else the saved settings (/settings).
    dailyTurns: require('./settings').numberValue('dailyTurnLimit'),
    perTurnTools: require('./settings').numberValue('maxToolCallsPerTurn'),
  };
}

// With Muse's real numbers for the window, the characters ÷ 4 estimate is left out: it sees
// only the text muser sends and receives, not what Muse reads again on every step, so it came
// out about a thousand times smaller than the real line under it.
function bucketLine(b) {
  if (b.realInTokens || b.realOutTokens) return t('ターン {turns} / ツール {toolCalls} 回', {turns: b.turns, toolCalls: b.toolCalls});
  const {formatTokens} = require('./turn-usage');
  return t('ターン {turns} / ツール {toolCalls} 回 / 約 {tokens} tokens（入 {input} / 出 {output}）',
    {turns: b.turns, toolCalls: b.toolCalls, tokens: formatTokens(b.approxTokens), input: formatTokens(b.approxIn ?? Math.round(b.inChars / 4)), output: formatTokens(b.approxOut ?? Math.round(b.outChars / 4))});
}

function formatSummary() {
  const s = summary();
  const lim = limits();
  const {formatTokens} = require('./turn-usage');
  // A window's real line, only when that window measured anything: the estimate
  // lines stand alone otherwise (as today's real line always behaved).
  const realLine = (label, b, since) => (b.realInTokens || b.realOutTokens)
    ? [t(label, {formatted: formatTokens(b.realInTokens || 0) + ' in / ' + formatTokens(b.realOutTokens || 0) + ' out'}) + (since ? t('（{date} から記録）', {date: sinceLabel(since)}) : '')] : [];
  return [
    t('muser の記録（この PC で数えた目安）'),
    t('今日: {line}', {line: bucketLine(s.today)}),
    // The real tokens, window by window, next to the estimates they belong to:
    // the last hour, today, the last 7 days and all time (Muse's measured
    // values, labelled as such, never mixed into the estimates).
    ...realLine('直近1時間の実績: {formatted}（Muse の実測値）', s.lastHour),
    ...realLine('今日の実績: {formatted}（Muse の実測値）', s.today),
    t('直近7日: {line}', {line: bucketLine(s.last7)}),
    ...realLine('直近7日の実績: {formatted}（Muse の実測値）', s.last7, s.realSince7),
    ...realLine('累計の実績: {formatted}（Muse の実測値）', s.allTime, s.realSince),
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
// Written atomically (temp + renameRetry, like save()): a direct writeFileSync
// could be read mid-write by another window, which took the torn file for "no
// cache" and crawled again (c19 #5).
function cacheAction(id) {
  const f = actionFile(), temp = f + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try { fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(temp, JSON.stringify({id, at: new Date().toISOString()})); renameRetry(temp, f); }
  catch { try { fs.unlinkSync(temp); } catch {} }
}
function clearCachedAction(id) {
  try { const cur = JSON.parse(fs.readFileSync(actionFile(), 'utf8')).id; if (cur && cur !== id) return; } catch {}
  try { fs.unlinkSync(actionFile()); } catch {}
}

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
function resetWeb() { sharedWeb = null; lastFind = 0; lastFindFail = 0; findInFlight = null; } // after a new login: new cookies, and the id may be looked up at once
// Any failed read (a lapsed login too) was taken for a new build and crawled up to 2,000 page
// chunks, after every turn and at every start. The id is looked up again at most once an hour.
const FIND_EVERY_MS = 3600 * 1000;
// A FAILED lookup used to stamp the same once-an-hour gate (lastFind was set before the
// crawl even ran), so one transient failure blocked every retry for an hour and, after
// the site recovered, plan() still just threw the generic error (audit #245). A success
// stamps the hour; a failure stamps only this short retry delay.
const FIND_RETRY_MS = 60 * 1000;
let lastFind = 0, lastFindFail = 0;
// One crawl at a time per process, shared by every concurrent plan(): the
// gate stamps used to be set only after the crawl's await returned, so
// parallel plan() calls (several windows' worth of callers in one process:
// account-pool probes, the TUI, bin's before/after reads) all crawled at
// once (c19 #5). Cross-process crawls can still overlap; the atomic cache
// write above keeps those from tearing each other's cache.
let findInFlight = null;
function findActionShared(web) {
  if (findInFlight) return findInFlight;
  const p = (async () => {
    try { const id = await findAction(web); lastFind = Date.now(); cacheAction(id); return id; }
    catch (e) { lastFindFail = Date.now(); throw e; }
    finally { if (findInFlight === p) findInFlight = null; }
  })();
  findInFlight = p;
  return p;
}
async function plan(web) {
  web ??= sharedWeb ??= require('./web').createWeb();
  let id = cachedAction();
  let found = false, retried = false, refoundAfter404 = false, needRefind = false;
  for (let step = 0; step < 5; step++) {
    if (!id) {
      if (found && !needRefind) break;
      const now = Date.now();
      if (!needRefind && (now - lastFind < FIND_EVERY_MS || now - lastFindFail < FIND_RETRY_MS)) break;
      needRefind = false;
      found = true;
      id = await findActionShared(web);
    }
    let r = null, err = null;
    try { r = await web.serverAction(id, [{includeAgreement: true}]); } catch (e) { err = e; }
    const sub = r && r.ok ? parseSubscription(r.text) : null;
    if (sub) return shapePlan(sub);
    // A 404/410 names the action id itself as gone: it is stale, look it up again (once).
    // Anything else (a thrown network error, a 401/5xx, an unparseable reply) may be a
    // passing failure of a perfectly good id: retry the SAME id once before discarding
    // it — a valid cached id used to be thrown away on any temporary failure (#245).
    if (!err && r && !r.ok && (r.status === 404 || r.status === 410)) {
      // Drop the dead id everywhere it is remembered (first audit #21): the
      // disk cache used to keep serving it, and the success stamp from when
      // it was found gated every re-search for up to an hour — including
      // when the id had been found seconds earlier in this very call, which
      // also broke the "look it up again" path above via `found`. One
      // re-search is allowed straight away; a refound id that also 404s
      // ends the call and stamps the short retry delay instead.
      clearCachedAction(id);
      id = null; retried = false; lastFind = 0;
      if (refoundAfter404) { lastFindFail = Date.now(); break; }
      refoundAfter404 = true; needRefind = true; continue;
    }
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

module.exports = {record, load, save, summary, limits, formatSummary, file, dayKey, minuteKey, sinceLabel, plan, resetWeb, formatPlan, parseSubscription, shapePlan, findAction, withLock, estTokens, cleanDay};
