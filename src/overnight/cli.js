'use strict';
// Command handling shared by `muser overnight` (bin/muser.js) and `/overnight`
// (src/ui/controller.mjs): both feed word arrays in and print/note the lines
// that come back, so the two surfaces can never drift apart in wording.
// Options are key=value words (max-tokens=, max-tasks=, at=, account=, cwd=,
// wait=1) — bin/muser.js' global flag parser stays untouched that way.
const {t} = require('../i18n');
const Q = require('./queue');
const R = require('./run');

function splitOpts(words) {
  const opts = {}, rest = [];
  // Only LEADING key=value words are options. Once the first non-option
  // word starts the prompt, every remaining word is prompt text verbatim
  // — 'add write the at=22:30 report' must queue that sentence whole, not
  // strip at= (which add never reads) or apply account=/cwd= mid-sentence.
  let inOpts = true;
  for (const w of words) {
    if (inOpts) {
      const m = /^([a-z][a-z-]*)=(.*)$/.exec(w);
      if (m && ['max-tokens', 'max-tasks', 'at', 'account', 'cwd', 'wait', 'approval'].includes(m[1])) { opts[m[1]] = m[2]; continue; }
      inOpts = false;
    }
    rest.push(w);
  }
  return {opts, rest};
}
function parseAt(v, now = Date.now()) {
  if (!v) return null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (hm) { const h = Number(hm[1]), m = Number(hm[2]); if (h > 23 || m > 59) throw new Error(t('at= の時刻が読めません: {v}（例: at=22:30）', {v})); const d = new Date(now); d.setHours(h, m, 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime(); }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(t('at= の時刻が読めません: {v}（例: at=22:30）', {v}));
  // A full ISO date-time names ONE moment, unlike HH:MM (a time of day,
  // which rolls to tomorrow above): a past ISO moment returning as-is
  // made run.js's `at > now` check skip the wait and start at once, the
  // opposite of what was asked (audit wave 9). Say so instead.
  if (ms <= now) throw new Error(t('過去の時刻です: {v}', {v}));
  return ms;
}
// start caps arrive as key=value strings: accept only what bin's valued
// flags accept (/^\d+$/), so spellings Number() would silently reinterpret
// — 0x10 -> 16, 1e3 -> 1000, -1, 1.5, and '' -> 0 (which even reads as
// "unlimited") — are refused in words instead of becoming a different cap.
function parseCap(raw, flag) {
  const bad = () => new Error(t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag}));
  if (!/^\d+$/.test(raw)) throw bad();
  const n = Number(raw);
  if (!Number.isFinite(n)) throw bad(); // an absurdly long digit string overflows to Infinity
  return n;
}
function usageError() { return new Error(t('使い方: muser overnight [add <頼み> | list | remove <id> | start [max-tokens=N] [max-tasks=N] [at=HH:MM] [wait=1] | report | estimate | config [approval=edit-auto|confirm-all|bypass]]')); }

// Returns {lines} (and {report} for start). Throws Error on bad input.
async function overnightCli(words, inj = {}) {
  const base = inj.baseDir ? {baseDir: inj.baseDir} : {};
  const [sub = 'list', ...tail] = words;
  const settings = inj.settings || require('../settings');
  if (sub === 'add') {
    const {opts, rest} = splitOpts(tail);
    // Through updateQueue (wave 15): the load-add-save happens under the
    // queue lock, so two adds at once — or an add while a run is saving —
    // can no longer erase each other.
    const item = Q.updateQueue(queue => Q.addItem(queue, {prompt: rest.join(' '), cwd: opts.cwd || inj.cwd || process.cwd(), account: opts.account || inj.account || null, ...(inj.runGit ? {runGit: inj.runGit} : {})}), base);
    return {lines: [t('夜間作業に積みました: {id}', {id: item.id}), oneQueueLine(item)]};
  }
  if (sub === 'list') {
    if (tail.length) throw usageError();
    return {lines: R.formatQueue(Q.loadQueue(base))};
  }
  if (sub === 'remove') {
    if (tail.length !== 1) throw usageError();
    let item;
    try { item = Q.updateQueue(queue => { const found = Q.removeItem(queue, tail[0]); if (!found) throw new Error(t('その ID の頼みはありません: {id}', {id: tail[0]})); return found; }, base); }
    catch (e) { if (e.code === 'ambiguous') throw new Error(t('その ID にあてはまる頼みが複数あります。もう少し長く指定してください。')); throw e; }
    return {lines: [t('夜間作業から外しました: {id}', {id: item.id})]};
  }
  if (sub === 'clear') {
    if (tail.length) throw usageError();
    const cleared = Q.updateQueue(queue => { const before = queue.items.length; queue.items = queue.items.filter(i => !['done', 'failed', 'skipped'].includes(i.status)); return before - queue.items.length; }, base);
    return {lines: [t('終わった頼みを {n} 件片付けました。', {n: cleared})]};
  }
  if (sub === 'estimate') {
    if (tail.length) throw usageError();
    const queue = Q.loadQueue(base);
    // Without an injected reader the real account pool answers, so the
    // estimate names the accounts like the design's common rule asks
    // (features-debug #37: bin passed nothing and the line vanished).
    let statuses = [];
    try { statuses = await (inj.statusesFn || R.defaultStatuses)(); } catch {}
    return {lines: R.formatEstimate(Q.estimate(queue, {statuses}), {maxTokens: settings.numberValue('overnightTokenCap'), maxTasks: settings.numberValue('overnightMaxTasks')})};
  }
  if (sub === 'report') {
    if (tail.length) throw usageError();
    return {lines: R.formatReport(R.loadLatestReport(base))};
  }
  if (sub === 'config') {
    const {opts, rest} = splitOpts(tail);
    if (rest.length) throw usageError();
    if (opts.approval) settings.setOvernightApproval(opts.approval);
    return {lines: [t('夜間作業の設定: 承認={approval} / トークン上限={tokens} / 件数上限={tasks}', {approval: settings.overnightApproval(), tokens: settings.numberValue('overnightTokenCap') || t('なし'), tasks: settings.numberValue('overnightMaxTasks') || t('なし')})]};
  }
  if (sub === 'start') {
    const {opts, rest} = splitOpts(tail);
    if (rest.length) throw usageError();
    const queue = Q.loadQueue(base);
    let statuses = [];
    try { statuses = await (inj.statusesFn || R.defaultStatuses)(); } catch {}
    const caps = {maxTokens: opts['max-tokens'] !== undefined ? parseCap(opts['max-tokens'], 'max-tokens=') : settings.numberValue('overnightTokenCap'), maxTasks: opts['max-tasks'] !== undefined ? parseCap(opts['max-tasks'], 'max-tasks=') : settings.numberValue('overnightMaxTasks')};
    if (!Number.isFinite(caps.maxTokens) || !Number.isFinite(caps.maxTasks)) throw usageError();
    const head = R.formatEstimate(Q.estimate(queue, {statuses}), caps);
    const report = await R.runOvernight({...base, ...(inj.statusesFn ? {statusesFn: inj.statusesFn} : {}), ...inj.run, approval: opts.approval || settings.overnightApproval(), account: opts.account || inj.account || null, maxTokens: caps.maxTokens, maxTasks: caps.maxTasks, at: parseAt(opts.at), waitForReset: opts.wait === '1'});
    return {lines: [...head, ...R.formatReport(report)], report};
  }
  throw usageError();
}
function oneQueueLine(i) { return i.id.slice(0, 10) + '  [' + R.statusLabel(i.status) + '] ' + R.oneLine(i.prompt, 100); }

module.exports = {overnightCli, splitOpts, parseAt};
