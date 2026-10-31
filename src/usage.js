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

// MUSER_USAGE_FILE redirects the store (tests, portable installs).
function file() {
  return process.env.MUSER_USAGE_FILE || path.join(os.homedir(), '.muser', 'usage.json');
}

function dayKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function emptyDay() { return {turns: 0, toolCalls: 0, inChars: 0, outChars: 0}; }
function fresh() { return {version: 1, days: {}, updatedAt: null}; }

// A corrupt store must never be silently wiped: move the bad file aside with a
// timestamp and only then start empty, so the original bytes survive.
function backupCorrupt(f) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(f, f + '.corrupt-' + stamp); } catch {}
}

function load() {
  const f = file();
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return fresh(); }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.days && typeof data.days === 'object' && !Array.isArray(data.days)) {
      return {version: 1, days: data.days, updatedAt: data.updatedAt || null};
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
  const data = {version: 1, days: store.days || {}, updatedAt: new Date().toISOString()};
  const temp = f + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 1));
    fs.renameSync(temp, f);
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  return data;
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }

// Accumulate a delta ({turns, toolCalls, inChars, outChars}) into today
// (local date) and persist. Returns today's bucket.
function record(delta = {}) {
  const store = load();
  const key = dayKey();
  const day = {...emptyDay(), ...(store.days[key] || {})};
  day.turns += num(delta.turns);
  day.toolCalls += num(delta.toolCalls);
  day.inChars += num(delta.inChars);
  day.outChars += num(delta.outChars);
  store.days[key] = day;
  save(store);
  return day;
}

function withTokens(day) {
  const d = {...emptyDay(), ...day};
  return {...d, approxTokens: Math.round((d.inChars + d.outChars) / 4)};
}

function summary() {
  const store = load();
  const today = withTokens(store.days[dayKey()]);
  const last7 = emptyDay();
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const b = {...emptyDay(), ...(store.days[dayKey(d)] || {})};
    last7.turns += b.turns;
    last7.toolCalls += b.toolCalls;
    last7.inChars += b.inChars;
    last7.outChars += b.outChars;
  }
  return {today, last7: withTokens(last7), note: 'トークン数は文字数 ÷ 4 の概算です。'};
}

function limits() {
  return {
    dailyTurns: Number(process.env.MUSER_DAILY_TURN_LIMIT) || 0,
    perTurnTools: Number(process.env.MUSER_MAX_TOOL_CALLS_PER_TURN) || 250,
  };
}

function bucketLine(b) {
  return 'ターン ' + b.turns + ' / ツール ' + b.toolCalls + ' 回 / 約 ' + b.approxTokens +
    ' tokens（入 ' + Math.round(b.inChars / 4) + ' / 出 ' + Math.round(b.outChars / 4) + '）';
}

function formatSummary() {
  const s = summary();
  const lim = limits();
  return [
    'muser の記録（この PC で数えた目安）',
    '今日: ' + bucketLine(s.today),
    '直近7日: ' + bucketLine(s.last7),
    '上限: 1ターンのツール上限 ' + lim.perTurnTools + ' 回（MUSER_MAX_TOOL_CALLS_PER_TURN） / 1日のターン上限 ' +
      (lim.dailyTurns ? String(lim.dailyTurns) : 'なし'),
  ].join('\n');
}

// ---- The real Muse plan usage (weekly %, reset time, top-up), as muse.ai and Muse Desktop
// Community show it. The web reads it from a Next.js server action, fetchSubscriptionAction;
// its id is a build hash, so it is found in the signed-in page's JS chunks once, cached on
// disk, and looked up again only when a call with the cached id fails (a new build).
function actionFile() { return path.join(path.dirname(file()), 'subscription-action.json'); }
function cachedAction() { try { return JSON.parse(fs.readFileSync(actionFile(), 'utf8')).id || null; } catch { return null; } }
function cacheAction(id) { try { fs.mkdirSync(path.dirname(actionFile()), {recursive: true}); fs.writeFileSync(actionFile(), JSON.stringify({id, at: new Date().toISOString()})); } catch {} }

async function findAction(web, maxChunks = 2000) {
  const html = await web.pageText('/');
  const queue = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m => m[1]))], seen = new Set();
  while (queue.length && seen.size < maxChunks) {
    const f = queue.shift(); if (seen.has(f)) continue; seen.add(f);
    let text; try { text = await web.pageText('/_next/static/chunks/' + f); } catch { continue; }
    const m = text.includes('fetchSubscriptionAction') && text.match(/createServerReference\)\("([0-9a-f]{40,44})"[^)]{0,160}"fetchSubscriptionAction"\)/);
    if (m) return m[1];
    for (const ref of text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) if (!seen.has(ref[1])) queue.push(ref[1]);
  }
  throw new Error('Muse の利用状況の取得先が見つかりませんでした');
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
function resetWeb() { sharedWeb = null; } // after a new login: read the new cookies next time
async function plan(web) {
  web ??= sharedWeb ??= require('./web').createWeb();
  let id = cachedAction();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!id) { id = await findAction(web); cacheAction(id); }
    let r = null;
    try { r = await web.serverAction(id, [{includeAgreement: true}]); } catch (e) { if (attempt) throw e; }
    const sub = r && r.ok ? parseSubscription(r.text) : null;
    if (sub) return shapePlan(sub);
    id = null; // the cached id belongs to an older build: look it up again, once
  }
  throw new Error('Muse の利用状況を読み込めませんでした');
}

function formatPlan(p) {
  const at = p.resetsAt ? new Date(p.resetsAt).toLocaleString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '?';
  return [
    'Muse の利用状況（muse.ai と同じ値）',
    (p.plan || 'プラン不明') + ' · 週の使用量 ' + (p.percentUsed ?? '?') + '%（' + at + ' にリセット）' + (p.quotaStatus && p.quotaStatus !== 'SUFFICIENT' ? ' · ' + p.quotaStatus : ''),
    ...(p.topupValue ? ['追加分: ' + p.topupValue] : []),
  ].join('\n');
}

module.exports = {record, load, save, summary, limits, formatSummary, file, dayKey, plan, resetWeb, formatPlan, parseSubscription, shapePlan, findAction};
