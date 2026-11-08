'use strict';
// `muser status` (bin/muser.js): every open window/conversation across every
// server discovery can find, in one view — the resident Muser Server
// (~/.muser/server.json) plus a standalone serve named only by
// ~/.muser/gui.json when it is a different server. `muser server status`
// stays the resident server's own detailed view (it adds the usage summary);
// this is the cross-server list.
//
// Transport is only the existing surface: discovery.probeServer (GET
// /api/server, whose sessions list carries cwd / account / busy / approval /
// lastUsedAt per conversation) plus one GET /api/s/:id/state per conversation
// for the waiting states the list cannot express (a menu, a reason or limit
// prompt, a queued approval, an open selectable question) and the live turn
// start. No new IPC. The state
// fetch is best-effort: a conversation whose snapshot fails still gets a row
// from the session list alone. GETs never touch a host entry's lastUsedAt
// (audit #61), so asking is observation, not use.
//
// The row building and formatting are pure (given the gathered server
// descriptors and `now`) so tests drive them without any server.
const {t} = require('../i18n');

// Strings here come from servers and other windows (conversation titles, todos,
// progress reports, tool errors, cwds): they are data, not terminal control.
// Strip escape sequences (OSC 52 could rewrite the clipboard) and flatten
// newlines, so one field can never forge extra rows in the listing (c11 #2,
// the CLI counterpart of TUI audit #184). Mirrors src/ui/sanitize.mjs's
// stripControls, plus newline flattening because every field here is one line.
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-Z\\-_])/g;
function cleanText(v) {
  return String(v ?? '').replace(ESC_SEQ, '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// What a conversation is doing, most urgent first: an approval outranks
// work, and any other wait on the user outranks plain busyness. `session` is
// one /api/server sessions entry (busy/approval booleans only); `state` is
// the /api/state snapshot when it could be fetched, else null.
function activityOf(session, state) {
  if (session?.approval || state?.approval) return 'approval';
  // state.question: the selectable-question picker (focus.ask_user with options),
  // published by gui-server's /api/state. It opens after the turn ended, so busy
  // is false; without it the conversation read as idle while it waited for an
  // answer (fifth c1-1, the server counterpart of window-status.js).
  if (state && (state.menu || state.reasonFor || state.limitInput || state.question || state.approvalQueue > 0)) return 'input';
  if (session?.busy || state?.busy) return 'working';
  return 'idle';
}

// The account's display label: the session's own label when the server sent
// one, else the server's account list by id, else the bare id.
function accountLabelOf(session, accounts) {
  if (session?.accountLabel) return session.accountLabel;
  const id = session?.account ?? null;
  if (!id) return null;
  const found = (accounts || []).find(a => a && a.id === id);
  return found?.label || id;
}

function stateOf(states, id) {
  if (!states) return null;
  return (states instanceof Map ? states.get(id) : states[id]) || null;
}

// One row per open conversation, in server order then session order.
// Server descriptor: {kind: 'server'|'serve', pid, port, version, startedAt,
// sessions: [...], accounts: [...], states: {id: snapshot}|Map}.
function buildRows(servers) {
  const rows = [];
  for (const srv of servers || []) {
    for (const s of srv.sessions || []) {
      const state = stateOf(srv.states, s.id);
      rows.push({
        serverKind: srv.kind || 'server',
        pid: srv.pid ?? null,
        port: srv.port ?? null,
        id: s.id,
        shortId: String(s.id).slice(0, 8),
        cwd: s.cwd ?? state?.cwd ?? null,
        accountLabel: accountLabelOf(s, srv.accounts),
        activity: activityOf(s, state),
        isDefault: !!s.isDefault,
        turns: s.turns ?? state?.session?.turns ?? null,
        mode: s.mode ?? state?.mode ?? null,
        museName: s.museName ?? state?.muse?.name ?? null,
        createdAt: s.createdAt ?? null,
        lastUsedAt: s.lastUsedAt ?? null,
        turnStart: state?.live?.turnStart || null,
        focusStatus: typeof state?.focus?.status === 'string' ? state.focus.status : null,
      });
    }
  }
  return rows;
}

// A compact span for the timing notes ('5 分', '2 時間').
function durationText(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return t('{n} 秒', {n: sec});
  const min = Math.floor(sec / 60);
  if (min < 60) return t('{n} 分', {n: min});
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('{n} 時間', {n: hours});
  return t('{n} 日', {n: Math.floor(hours / 24)});
}

function formatRow(row, now = Date.now()) {
  const word = row.activity === 'approval' ? t('承認待ち')
    : row.activity === 'input' ? t('入力待ち')
    : row.activity === 'working' ? t('作業中') : t('待機中');
  let line = '  ' + row.shortId + '  ' + word;
  if (row.isDefault) line += ' / ' + t('既定');
  if (row.accountLabel) line += ' / ' + t('アカウント: {label}', {label: cleanText(row.accountLabel)});
  if (row.focusStatus) line += ' / ' + t('Focus: {status}', {status: cleanText(row.focusStatus)});
  line += '  ' + cleanText(row.cwd);
  const bits = [];
  if (row.activity === 'working' && row.turnStart) bits.push(t('経過: {span}', {span: durationText(now - row.turnStart)}));
  if (row.lastUsedAt) bits.push(t('最終利用: {ago}', {ago: t('{span}前', {span: durationText(now - row.lastUsedAt)})}));
  if (bits.length) line += '  (' + bits.join(' / ') + ')';
  return line;
}

// The whole report: one header per server that has windows, its rows under
// it; the no-windows message when no live server holds any conversation.
function formatStatus(servers, now = Date.now()) {
  const lines = [];
  for (const srv of servers || []) {
    const rows = buildRows([srv]);
    if (!rows.length) continue;
    const head = {pid: cleanText(srv.pid), port: cleanText(srv.port), version: cleanText(srv.version), at: srv.startedAt ? new Date(srv.startedAt).toLocaleString() : ''};
    lines.push(srv.kind === 'serve'
      ? t('単独 serve: pid {pid} / port {port} / version {version} / 起動 {at}', head)
      : t('Muser Server: pid {pid} / port {port} / version {version} / 起動 {at}', head));
    for (const row of rows) lines.push(formatRow(row, now));
  }
  return lines.length ? lines : [t('開いている窓はありません。')];
}

// Gather the live server descriptors: probe the resident server's discovery
// file first, then gui.json's target when it names a different pid+port
// (the two files usually name the same resident server — it writes both).
// Every transport step is injectable for tests.
async function gatherWindowStatus(deps = {}) {
  const discovery = deps.discovery || require('./discovery');
  const readServer = deps.readServer || (() => discovery.readServer());
  const readGui = deps.readGui || (() => (typeof discovery.readGui === 'function' ? discovery.readGui() : null));
  const probe = deps.probe || (info => discovery.probeServer(info));
  const request = deps.request || ((info, method, p, body, timeoutMs) => discovery.request(info, method, p, body, timeoutMs));
  const targets = [];
  const seen = new Set();
  const add = (info, kind) => {
    if (!info) return;
    const key = info.pid + ':' + info.port;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({info, kind});
  };
  add(readServer(), 'server');
  add(readGui(), 'serve');
  const servers = [];
  for (const {info, kind} of targets) {
    const live = await probe(info).catch(() => null);
    if (!live) continue;
    const sessions = Array.isArray(live.sessions) ? live.sessions : [];
    const states = {};
    // Fetch the snapshots in parallel (c11 #1): serially, N conversations cost
    // up to N x the 3 s timeout and `muser status` shows nothing at all until
    // every one has answered — the local windows included.
    await Promise.all(sessions.map(async s => {
      try {
        const r = await request(info, 'GET', '/api/s/' + encodeURIComponent(s.id) + '/state', undefined, 3000);
        if (r?.status === 200 && r.json) states[s.id] = r.json;
      } catch { /* the row falls back to the session list alone */ }
    }));
    servers.push({
      kind,
      pid: live.pid ?? info.pid,
      port: live.port ?? info.port,
      version: live.version ?? info.version ?? null,
      startedAt: live.startedAt ?? info.startedAt ?? null,
      sessions,
      accounts: live.accounts || [],
      states,
    });
  }
  return servers;
}

// ---- every window, not only the server's ----
// Plain `muser` windows run their own conversation and never show in a server's list; each
// writes its live state to %LOCALAPPDATA%\muser\windows\<pid>.json (src/window-status.js). A
// `muser exec` run keeps its own status file (src/exec-status.js). `muser status` lists all three.

const ACTIVITY = {approval: '承認待ち', input: '入力待ち', working: '作業中', idle: '待機中'};
const TODO_MARK = {completed: '✓', in_progress: '▶', pending: '☐'};
const sinceText = (iso, now) => { const at = Date.parse(iso); return Number.isFinite(at) ? durationText(now - at) : null; };
const callText = c => (c ? cleanText(c.command) + (c.summary ? '(' + cleanText(c.summary) + ')' : '') + (c.agent && c.agent !== 'main' ? ' [' + cleanText(c.agent) + ']' : '') : '');
function focusText(f) {
  if (!f) return null;
  return t('Focus: {status}', {status: cleanText(f.status)}) + (f.maxRounds ? ' ' + f.round + '/' + f.maxRounds : '') + (f.total ? ' ✓' + f.met + '/' + f.total : '');
}

// Running exec runs only: a finished run is in `muser exec --status`, not in the open windows.
function execRuns(deps = {}) {
  const es = deps.execStatus || require('../exec-status');
  let names = [];
  try { names = require('node:fs').readdirSync(es.dir()).filter(n => /^\d{8}-\d{6}-\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { const v = es.read(require('node:path').join(es.dir(), n)); if (es.verdict(v, deps) === 'running') out.push({...v, file: require('node:path').join(es.dir(), n)}); } catch {}
  }
  return out.sort((x, y) => String(x.startedAt).localeCompare(String(y.startedAt)));
}

async function gatherAll(deps = {}) {
  const windows = (deps.readWindows || (() => require('../window-status').readAll()))();
  const [servers, execs] = await Promise.all([gatherWindowStatus(deps).catch(() => []), Promise.resolve().then(() => (deps.readExecs || execRuns)())]);
  return {windows, servers, execs};
}

// One window: a head line, then what it is doing right now (only what there is).
function formatWindow(w, now = Date.now()) {
  const head = ['  pid ' + w.pid, t(ACTIVITY[w.activity] || '待機中')];
  // How long it has been like this: waiting on an approval since it was asked, working since the turn began.
  const since = w.activity === 'approval' ? w.approval?.since : w.activity === 'working' ? w.turnStartedAt : null;
  if (since) head[1] += ' ' + sinceText(since, now);
  if (w.account?.label || w.account?.id) head.push(t('アカウント: {label}', {label: cleanText(w.account.label || w.account.id)}));
  if (!w.connected) head.push(t('未接続'));
  const lines = [head.join('  ') + '  ' + cleanText(w.cwd)];
  const bits = [];
  if (w.session) bits.push(t('会話 {id}', {id: String(w.session.id).slice(0, 8)}) + (w.session.title ? ' 「' + cleanText(w.session.title) + '」' : ''));
  const ft = focusText(w.focus); if (ft) bits.push(ft);
  const working = (w.agents || []).filter(a => a.state === 'working').length;
  // One working agent takes the singular key so English reads "1 agent
  // working", not "1 agents working" (wave 12).
  if (working) bits.push(working === 1 ? t('エージェント 1 体が作業中') : t('エージェント {n} 体が作業中', {n: working}));
  if (w.queue) bits.push(t('キュー {n} 件', {n: w.queue}));
  if (bits.length) lines.push('    ' + bits.join(' · '));
  if (w.approval) lines.push('    ' + t('承認待ち: {call}', {call: callText(w.approval)}));
  else if (w.running) lines.push('    ' + t('実行中: {call}', {call: callText(w.running)}) + (w.running.since ? ' (' + sinceText(w.running.since, now) + ')' : ''));
  const doing = (w.todos || []).find(x => x.status === 'in_progress');
  if (doing) lines.push('    ' + t('Todo: {item}（{done}/{total} 完了）', {item: cleanText(doing.content), done: w.todos.filter(x => x.status === 'completed').length, total: w.todos.length}));
  return lines;
}
function formatExec(v, now = Date.now()) {
  const lines = ['  pid ' + v.pid + '  ' + t('作業中') + ' ' + (sinceText(v.startedAt, now) || '') + (v.account ? '  ' + t('アカウント: {label}', {label: cleanText(v.account)}) : '') + '  ' + cleanText(v.cwd)];
  const bits = [];
  if (v.prompt) bits.push('「' + cleanText(String(v.prompt).split('\n')[0]).slice(0, 60) + '」');
  bits.push(t('ツール {n} 回', {n: v.tools || 0}));
  if (v.focus?.status) bits.push(t('Focus: {status}', {status: cleanText(v.focus.status)}));
  lines.push('    ' + bits.join(' · '));
  if (v.last) lines.push('    ' + t('最後: {call}', {call: cleanText(v.last)}));
  return lines;
}
function formatAll({windows = [], servers = [], execs = []} = {}, now = Date.now()) {
  const lines = [];
  if (windows.length) { lines.push(t('muser の窓')); for (const w of windows) lines.push(...formatWindow(w, now)); }
  const srv = formatStatus(servers, now);
  if (buildRows(servers).length) lines.push(...srv);
  if (execs.length) { lines.push(t('muser exec（実行中）')); for (const v of execs) lines.push(...formatExec(v, now)); }
  return lines.length ? lines : [t('開いている窓はありません。')];
}

// `muser status <id>`: a pid, or the start of a conversation id, of a window, a server
// conversation or an exec run. Returns {kind, item} or null; several matches -> {ambiguous}.
function find(all, id) {
  const q = String(id || '').trim().toLowerCase();
  if (!q) return null;
  const hits = [];
  for (const w of all.windows || []) if (String(w.pid) === q || (w.session?.id && String(w.session.id).toLowerCase().startsWith(q))) hits.push({kind: 'window', item: w});
  for (const v of all.execs || []) if (String(v.pid) === q || (v.session && String(v.session).toLowerCase().startsWith(q))) hits.push({kind: 'exec', item: v});
  for (const row of buildRows(all.servers || [])) if (String(row.id).toLowerCase().startsWith(q)) hits.push({kind: 'server', item: row});
  if (hits.length > 1) return {ambiguous: hits};
  return hits[0] || null;
}
// The detail of one window: its rows plus the recent tools, every todo, the agents and the
// latest progress reports.
function formatDetail(hit, now = Date.now()) {
  if (hit.kind === 'server') return [formatRow(hit.item, now)];
  if (hit.kind === 'exec') return require('../exec-status').summary(hit.item, {now}).split('\n');
  const w = hit.item, lines = formatWindow(w, now);
  if (w.focus?.open?.length && w.focus.status !== 'complete') lines.push('    ' + t('未完: {ids}', {ids: w.focus.open.map(cleanText).join(', ')}) + (w.focus.reason ? ' — ' + cleanText(w.focus.reason) : ''));
  if (w.goal) lines.push('    ' + t('常設ゴール: {goal}', {goal: cleanText(w.goal)}));
  if (w.todos?.length) { lines.push(t('Todo')); for (const x of w.todos) lines.push('  ' + (TODO_MARK[x.status] || '☐') + ' ' + cleanText(x.content)); }
  if (w.agents?.length) {
    lines.push(t('エージェント'));
    for (const a of w.agents) lines.push('  ' + cleanText(a.tag) + (a.type ? ' ' + cleanText(a.type) : '') + '  ' + cleanText(a.state) + '  ' + cleanText(a.title) + (a.lastTool ? '  · ' + cleanText(a.lastTool) : '') + (a.startedAt ? '  (' + sinceText(a.state === 'working' ? a.startedAt : a.endedAt || a.startedAt, now) + ')' : ''));
  }
  if (w.toolLog?.length) {
    lines.push(t('最近のツール'));
    for (const x of w.toolLog.slice(-10)) lines.push('  ' + (x.ok ? '✓ ' : '✗ ') + callText(x) + (x.ok ? '' : '  ' + cleanText(x.error)) + '  ' + t('{span}前', {span: sinceText(x.at, now)}));
  }
  if (w.progress?.length) { lines.push(t('経過報告')); for (const p of w.progress.slice(-3)) lines.push('  ' + (p.agent && p.agent !== 'main' ? '[' + cleanText(p.agent) + '] ' : '') + cleanText(p.message)); }
  if (w.lastTurn) lines.push(t('前のターン: {state}', {state: w.lastTurn.ok ? t('完了') : w.lastTurn.aborted ? t('中断') : t('失敗: {error}', {error: cleanText(w.lastTurn.error)})}) + ' (' + t('{span}前', {span: sinceText(w.lastTurn.endedAt, now)}) + ')' + (w.lastTurn.usage ? ' · ' + require('../turn-usage').usageText(w.lastTurn.usage) : ''));
  return lines;
}

module.exports = {activityOf, accountLabelOf, buildRows, durationText, formatRow, formatStatus, gatherWindowStatus, cleanText,
  execRuns, gatherAll, formatWindow, formatExec, formatAll, find, formatDetail};
