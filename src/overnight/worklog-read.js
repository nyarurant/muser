'use strict';
// Overnight's own small reader for the work log (design new-features.md §1).
// The writer is src/worklog.js (driven from agent.js); this reader reads the
// shape it actually writes and degrades to "no log" when there is none:
//   %LOCALAPPDATA%\muser\worklog\<conversation id>.jsonl — one JSON event per
//   line ({v, at, session, event, ...}): turn {text, agent, parentAgent?,
//   parentSession?} / tool {command, summary, paths[], ok, exitCode, ms,
//   outChars, outHash, outHead?, outTail?} / edit {path, op, beforeHash,
//   afterHash, added, removed, ranges: [{start, end}], diff} with the full
//   before-text in worklog\blobs\<beforeHash> / expect {...} / reply {text,
//   agent} / focus {focus: {...}} / gap {dropped, error}.
// The discriminator is `event`; `type` is still accepted so a log written
// by an older build does not read as all bad lines.
// Malformed lines are counted, never thrown on: a half-written last line must
// not lose the morning report. Paths that look secret (tools.isSensitivePath)
// are dropped from every summary — their contents are never read here at all
// (blobs are not opened by this reader).
const fs = require('node:fs');
const path = require('node:path');
const {fileFor} = require('../worklog.js');

function worklogDir(baseDir) {
  if (baseDir) return baseDir;
  const root = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local');
  return path.join(root, 'muser', 'worklog');
}
// The writer's own file naming (src/worklog.js fileFor), so an id with
// characters the writer strips names the same file here.
function worklogFile(conversationId, baseDir) { return fileFor(String(conversationId ?? ''), worklogDir(baseDir)); }
const kindOf = e => (e && (e.event || e.type)) || '';

function readWorklog(conversationId, {baseDir} = {}) {
  let text;
  try { text = fs.readFileSync(worklogFile(conversationId, baseDir), 'utf8'); } catch { return {found: false, events: [], badLines: 0}; }
  const events = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && typeof kindOf(e) === 'string' && kindOf(e)) events.push(e); else badLines++; }
    catch { badLines++; }
  }
  return {found: true, events, badLines};
}

// The small slice of the log the morning report needs: how the run went and a
// proof-badge-shaped verdict (the full /proof feature is another branch's).
// badge: 'ok' when a passing test/tool run lands after the last edit, 'stale'
// when edits came after the last passing run, 'fail' when the last test-like
// run failed, 'none' when nothing test-like ran, 'no-log' without a log.
function summarizeWorklog(conversationId, opts = {}) {
  const {found, events, badLines} = readWorklog(conversationId, opts);
  if (!found) return {found: false, badge: 'no-log', turns: 0, tools: 0, edits: 0, badLines: 0, files: []};
  let sensitive = null;
  try { sensitive = require('../tools').isSensitivePath; } catch { sensitive = null; }
  // Same recognizer as src/race.js: a run counts only when its text names
  // a test runner — the /test|check/i substring matched "latest" in a
  // plain read's summary (features-debug #14).
  const TEST_RUN_RE = /\bnpm\s+(?:run\s+)?test\b|\bnpm\s+run\s+check\b|\bnode\b[^\n]*--test\b|\b(?:jest|vitest|mocha|pytest)\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bgo\s+test\b/i;
  const {parseTestCounts} = require('../proof/badge.js');
  const hasTestSummary = e => { const c = parseTestCounts([e.output, e.outHead, e.outTail].filter(Boolean).join('\n')); return c.pass !== null && c.fail !== null; };
  // A run that was refused (approval declined / never launched) proves nothing either way:
  // it is not a failing test (a deferred night task showed 'fail' for a test it never ran).
  const notRun = e => e.declined === true || (!e.ok && /declined this|確認が必要なので断りました/i.test(String(e.error || '')));
  const isTestRun = e => kindOf(e) === 'tool' && !notRun(e) && (TEST_RUN_RE.test(String(e.command || '') + ' ' + String(e.summary || '')) || hasTestSummary(e));
  let lastEditAt = -1, lastPassAt = -1, lastFailAt = -1;
  const files = new Set();
  let tools = 0, edits = 0, turns = 0;
  events.forEach((e, i) => {
    if (kindOf(e) === 'turn') turns++;
    if (kindOf(e) === 'tool') { tools++; if (isTestRun(e)) { if (e.ok) lastPassAt = i; else lastFailAt = i; } }
    if (kindOf(e) === 'edit') {
      edits++; lastEditAt = i;
      const p = typeof e.path === 'string' ? e.path : null;
      if (p && !(sensitive && (sensitive(p)))) files.add(p);
    }
  });
  let badge = 'none';
  if (lastFailAt > lastPassAt && lastFailAt > lastEditAt) badge = 'fail';
  else if (lastPassAt >= 0 && lastPassAt > lastEditAt) badge = 'ok';
  else if (lastPassAt >= 0 || lastFailAt >= 0) badge = 'stale';
  return {found: true, badge, turns, tools, edits, badLines, files: [...files].slice(0, 20)};
}

module.exports = {worklogDir, worklogFile, readWorklog, summarizeWorklog};
