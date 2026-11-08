'use strict';
// 想定外ストップ (unexpected-stop), design docs/design/new-features.md §4.
//
// Before running a command, Muse writes down what it expects (the `expect`
// argument of system.run, fixed shapes only). When the result differs, the
// tool result carries a [muser: 想定外] line, the tool row shows 「想定外」, an
// `expect` event is recorded in the work log, and — only in 「止める」 mode —
// that agent's next write is stopped once so it has to rethink first.
//
// The mode lives in /settings (src/settings.js expectMode):
//   record (既定) — record only, work is never stopped;
//   stop          — also stop the next write once per mismatch;
//   off           — expect is ignored entirely (not even recorded).
// The user chose record as the default on 2026-11-07 (design §12 left the
// default open; §4's on/off becomes the three states above).
//
// The work log itself (turn / tool / edit / reply / focus events) is
// src/worklog.js, written from agent.js. This module's events go through
// that writer: agent.js hands its session Worklog to appendWorklogEvent,
// so an expect line is queued, sanitised, pruned and gap-counted exactly
// like every other line of the same file (%LOCALAPPDATA%\muser\worklog\
// <conversation id>.jsonl, 1 line = 1 event). Reading back goes through
// the writer's parser too.
// The event shape, as written:
//   {v: 1, at: <ISO time>, session, event: 'expect', agent, command,
//    expect: <spec as given>, matched: true|false|null (null = not judged,
//    e.g. a background start), expected: '<short text>', actual: '<short
//    text>', mode: 'record'|'stop'}
//   a stopped write:  event: 'expect-block'     {agent, command, expected, actual}
//   a reconcile:      event: 'expect-reconcile' {agent, reason, expected?, actual?}
// The reader accepts kind / type / event as the discriminator, so lines
// written before this wiring (kind: 'expect', ms-epoch at) still count.
//
// Safety (design §0 共通の決まり): records stay on this PC only, under
// %LOCALAPPDATA%\muser\. Nothing here sends anything anywhere. Raw tool
// output is never recorded: `actual` is derived (an exit code, whether a
// string was found, pass/fail counts), and the expected string Muse wrote
// is clipped and secret-shaped values are redacted, like focus-log.js.
// Recording never breaks a turn: appends are best-effort and swallow errors.
const path = require('node:path');
const {t} = require('./i18n');
const store = require('./secure-store');
const {Worklog, sanitizeText, fileFor} = require('./worklog.js');

// Retention premise for the work log as a whole (design §1, decided
// 2026-11-07: the proposal in §12 stands). Enforcing it is the work-log
// branch's job (`muser log`); the constants live here so the expect side
// and the merge share one spelling.
const WORKLOG_KEEP_DAYS = 30;
const WORKLOG_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const WORKLOG_DIR = path.join(store.DIR, 'worklog');
const BLOBS_DIR = path.join(WORKLOG_DIR, 'blobs'); // design §1: pre-edit full texts, by content hash (work-log branch)

const WRITE_COMMANDS = ['code.write', 'code.edit', 'code.apply_patch'];
const isWriteCommand = command => WRITE_COMMANDS.includes(command);

// --- the expect spec: fixed shapes only (design §4) ------------------------
const EXPECT_FORMS = '{exit: 0}, {exit: "nonzero"}, {contains: "..."}, {notContains: "..."}, {tests: "pass"|"fail"}';
const EXPECT_MAX_TEXT = 500;

// Accepts the object itself or its JSON text (the gateway may hand over
// either, as with todo.write). Returns {spec} or {error}.
function normalizeExpect(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return {error: 'expect must be one of ' + EXPECT_FORMS}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {error: 'expect must be one of ' + EXPECT_FORMS};
  const keys = Object.keys(v);
  if (keys.length !== 1) return {error: 'expect takes exactly one of exit / contains / notContains / tests: ' + EXPECT_FORMS};
  const k = keys[0];
  if (k === 'exit') {
    if (v.exit === 'nonzero') return {spec: {exit: 'nonzero'}};
    if (Number.isSafeInteger(v.exit)) return {spec: {exit: v.exit}};
    return {error: 'expect.exit must be an integer or "nonzero"'};
  }
  if (k === 'contains' || k === 'notContains') {
    const s = v[k];
    if (typeof s !== 'string' || !s || s.length > EXPECT_MAX_TEXT) return {error: 'expect.' + k + ' must be a non-empty string of at most ' + EXPECT_MAX_TEXT + ' characters'};
    return {spec: {[k]: s}};
  }
  if (k === 'tests') {
    if (v.tests === 'pass' || v.tests === 'fail') return {spec: {tests: v.tests}};
    return {error: 'expect.tests must be "pass" or "fail"'};
  }
  return {error: 'unknown expect key "' + k + '": ' + EXPECT_FORMS};
}

// Short spellings in the display language (via t() at call time, never at
// load), shared by the tool-result line, the screen row and the work-log
// record, so all three always agree.
function clip(s, n = 80) { const t = String(s ?? ''); return t.length <= n ? t : t.slice(0, n) + '…'; }
function expectText(spec) {
  if (!spec || typeof spec !== 'object') return '';
  if ('exit' in spec) return spec.exit === 'nonzero' ? t('exit 非0') : 'exit ' + spec.exit;
  if ('contains' in spec) return t('出力に「{text}」を含む', {text: clip(spec.contains)});
  if ('notContains' in spec) return t('出力に「{text}」を含まない', {text: clip(spec.notContains)});
  if ('tests' in spec) return spec.tests === 'pass' ? t('テスト全通過') : t('テストが失敗する');
  return '';
}

// pass / fail counts in a test run's output, read exactly as proof does
// (src/proof/badge.js parseTestCounts, incl. the Japanese shapes): the
// two judges must agree on the same output. Priority is by pattern, not
// by position across patterns: the label-first shape ("pass 128",
// "pass: 128", dotnet's "Passed: 128") wins over the number-first shape
// ("128 passed"), and within the winning shape the LAST match wins (a
// tool's summary sits at the end, and the reader's stored output is
// head+tail, so an earlier summary is stale). Letting every pattern
// overwrite in turn (the old find) mixed shapes up: the number-first
// pattern read across a newline, so "pass 128\nfail 0" came back as
// fail 128 and an all-pass run was judged a failure (and vice versa).
// Whitespace inside a shape is horizontal only, so a count can never be
// borrowed from the neighbouring line.
function testCounts(output) {
  const s = String(output ?? '');
  const pick = pats => { for (const p of pats) { const ms = [...s.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'))]; if (ms.length) return Number(ms[ms.length - 1][1]); } return null; };
  const pass = pick([/pass(?:ed|ing)?[ \t]*:?[ \t]*(\d+)/i, /(\d+)[ \t]*(?:tests?[ \t]+)?pass(?:ed|ing)?\b/i, /(\d+)\s*件[^。\n]{0,6}?(?:通過|合格|パス)/, /(?:通過|合格)[^。\n]{0,4}?(\d+)\s*件/]);
  const fail = pick([/fail(?:ed|ing|s)?[ \t]*:?[ \t]*(\d+)/i, /(\d+)[ \t]*fail(?:ed|ing|ures?)?\b/i, /(\d+)\s*件[^。\n]{0,6}?失敗/, /失敗[^。\n]{0,4}?(\d+)\s*件/]);
  return {pass, fail};
}

// Judges a finished foreground run. `exit` is the process exit code (null
// when the run has none, e.g. it was moved to the background: then the
// result is {matched: null} — recorded, never judged, never stops a write).
// Returns {matched: true|false|null, actual: '<short factual text>'}.
function evaluateExpect(spec, {exit, output} = {}) {
  if ('exit' in spec) {
    if (!Number.isSafeInteger(exit)) return {matched: null, actual: t('exit 不明（バックグラウンド）')};
    const matched = spec.exit === 'nonzero' ? exit !== 0 : exit === spec.exit;
    return {matched, actual: 'exit ' + exit};
  }
  if ('contains' in spec || 'notContains' in spec) {
    const key = 'contains' in spec ? 'contains' : 'notContains';
    const found = String(output ?? '').includes(spec[key]);
    const matched = key === 'contains' ? found : !found;
    return {matched, actual: found ? t('「{text}」が含まれていた', {text: clip(spec[key])}) : t('「{text}」は含まれなかった', {text: clip(spec[key])})};
  }
  if ('tests' in spec) {
    const {pass, fail} = testCounts(output);
    // No counts in the output means the prediction cannot be judged —
    // the same null the exit form gives for a background run. Calling it
    // a mismatch made stop mode block writes over output that simply
    // had no summary to read (features-debug #15).
    if (pass == null && fail == null) return {matched: null, actual: t('テスト結果を読み取れなかった（pass / fail の件数なし）')};
    // The display shows only the counts that were actually read: filling
    // an unread side in with 0 (the old `?? 0`) invented a result nobody
    // observed — "fail 0" alone displayed as "pass 0 / fail 0".
    const shown = [];
    if (pass !== null) shown.push('pass ' + pass);
    if (fail !== null) shown.push('fail ' + fail);
    const actual = shown.join(' / ');
    // A one-sided summary cannot be judged either way: "fail 0" says
    // nothing about how many passed (maybe none ran), and "pass 10"
    // says nothing about failures. It stays unjudged, like the no-counts
    // case above, instead of counting as a pass.
    if (pass == null || fail == null) return {matched: null, actual};
    // "pass" is matched only by an actually-read pass > 0 with fail == 0:
    // pass 0 / fail 0 means no test passed, so it is a mismatch, not a
    // pass. "fail" is matched only by an actually-read fail > 0.
    const matched = spec.tests === 'pass' ? (pass > 0 && fail === 0) : (fail > 0);
    return {matched, actual};
  }
  return {matched: null, actual: ''};
}

// The line appended to the tool result Muse sees (design §4, step 1).
function mismatchLine(spec, actual) {
  return t('[muser: 想定外] 予想: {expected} / 実際: {actual}', {expected: expectText(spec), actual});
}

// --- the work log: this feature's own small reader + expect appends --------
function worklogDir(dir) { return dir || WORKLOG_DIR; }
function worklogFile(conversationId, dir) {
  // The writer's own naming (src/worklog.js fileFor), so reader and
  // writer always name the same file for the same conversation.
  return fileFor(String(conversationId ?? ''), worklogDir(dir));
}
function eventKind(e) { return e && typeof e === 'object' ? (e.kind || e.type || e.event || '') : ''; }

// Parses a conversation's work log (the writer's own parser: missing
// file = no events; a broken line is skipped, never fatal).
function readWorklogEvents(conversationId, {dir} = {}) {
  return Worklog.readFile(worklogFile(conversationId, dir));
}
function readExpectEvents(conversationId, opts) {
  return readWorklogEvents(conversationId, opts).filter(e => eventKind(e) === 'expect');
}
// Design §4 確かめること: count, from the record, how often a stop would
// have been (or was) a false alarm — mismatches over judged expects.
function countExpectOutcomes(events) {
  const c = {total: 0, matched: 0, mismatched: 0, unjudged: 0};
  for (const e of events || []) {
    if (eventKind(e) !== 'expect') continue;
    c.total++;
    if (e.matched === true) c.matched++;
    else if (e.matched === false) c.mismatched++;
    else c.unjudged++;
  }
  return c;
}

const SECRET_KEY = /(token|password|passwd|secret|cookie|authorization|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|bearer)/i;
function cleanValue(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  // A spec or a reason is free text Muse wrote: it goes through the work
  // log's sanitiser (secret shapes included), not just the key check below.
  if (typeof v === 'string') { const s = sanitizeText(v); return s.length <= EXPECT_MAX_TEXT ? s : s.slice(0, EXPECT_MAX_TEXT) + '…'; }
  if (Array.isArray(v)) return depth > 3 ? [] : v.map(x => cleanValue(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 3) return {};
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : cleanValue(x, depth + 1);
    return out;
  }
  return undefined;
}
// Records one expect event through the work log's writer (src/worklog.js).
// The caller spells the event with `event:` ('expect' / 'expect-block' /
// 'expect-reconcile'); the older `kind:` / `type:` spelling is translated.
// With {worklog} — the session's own Worklog, as agent.js passes — the
// line joins that instance's queue, so it lands in order with the turn's
// tool/edit lines and under the same on/off switch; the queue is flushed
// at once, so the record is on disk when the call returns (the behaviour
// the direct appends this replaced always had). Without an instance, a
// throwaway Worklog writes it at once. The writer stamps {v, at, session}
// itself, so a caller-supplied `at` is dropped. Values are cleaned here
// first (secret-shaped keys redacted, long strings clipped), as before.
// Best-effort: returns false instead of throwing, so a full disk or a
// locked file never breaks the turn it was recording.
function appendWorklogEvent(conversationId, event, {dir, worklog} = {}) {
  try {
    if (!event || typeof event !== 'object') return false;
    const kind = event.event || event.kind || event.type || '';
    if (!kind) return false;
    const fields = cleanValue({...event, event: kind});
    delete fields.kind; delete fields.type; delete fields.at;
    if (worklog) { const queued = !!worklog.append(fields); if (queued) worklog.flush(); return queued; }
    const id = String(conversationId ?? '');
    if (!id) return false; // no usable conversation id
    const wl = new Worklog({sessionId: id, dir: worklogDir(dir)});
    if (!wl.append(fields)) return false;
    return wl.flush() > 0;
  } catch { return false; }
}

module.exports = {WORKLOG_DIR, BLOBS_DIR, WORKLOG_KEEP_DAYS, WORKLOG_MAX_TOTAL_BYTES, WRITE_COMMANDS, isWriteCommand, EXPECT_FORMS, normalizeExpect, expectText, testCounts, evaluateExpect, mismatchLine, worklogDir, worklogFile, eventKind, readWorklogEvents, readExpectEvents, countExpectOutcomes, appendWorklogEvent};
