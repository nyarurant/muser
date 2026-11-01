// UI state for the Ink view: turns agent events into an append-only list of finished entries
// (rendered once into scrollback through <Static>) plus the small live state at the bottom.
// Key handling lives here too, so the view is only drawing.
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMd} from './md.mjs';
import {sanitizeEmbeds, stripEmbeds, partialEmbedTail} from './sanitize.mjs';
const require = createRequire(import.meta.url);
const {MODES, LABELS, alwaysKey, modeFrom} = require('../policy.js');
const MODE_HELP = {
  'default': '読むのは自動。編集とコマンドは毎回確認',
  'auto-edit': '作業フォルダー内の編集は自動。コマンドは確認',
  'plan': '読むだけ。編集と変更系のコマンドは断る',
  'bypass': '全部自動で実行（確認なし）',
};
const {TOOLS} = require('../tools.js');
const sessions = require('../sessions.js');
const mcpConfig = require('../mcp.js');
const clip = require('../clipboard.js');
const mention = require('../mentions.js');
const usage = require('../usage.js');
const transcript = require('../transcript.js');
const permissions = require('../permissions.js');
const skills = require('../skills.js');
const update = require('../update.js');
const {c, frames} = require('../tui/term.js');
const {TOOLS: LOCAL} = require('../tools.js');
const i18n = require('../i18n.js');
const {t} = i18n;

export const COMMANDS = [
  ['/help', 'コマンドとキー操作（!コマンド・@ファイル も）'], ['/permissions', '承認モード（権限）を選ぶ'], ['/mode', '承認モードを選ぶ（/mode bypass で直接）'],
  ['/new', '新しい会話を始める'], ['/clear', '画面を消して新しい会話'], ['/resume', 'このフォルダーの過去の会話を再開'],
  ['/agent', '並列エージェントに任せる（/agent [explore|plan|review|test] <タスク>）'], ['/agents', '並列エージェントの一覧・結果・停止'], ['/bg', 'バックグラウンドの処理（/bg で一覧・出力、/bg kill bg1 で停止）'], ['/mcp', 'MCP サーバーのオン・オフと取り込み'], ['/image', '画像を添付（パスなしでクリップボードから）'], ['/todos', 'Muse の Todo'], ['/status', '接続とセッションの状態'], ['/init', 'AGENTS.md を Muse に書いてもらう'], ['/skills', 'スキルの一覧とオン・オフ（Claude Code / Codex のスキルも読めます）'], ['/skill', 'スキルを使って頼む（/skill <名前> <頼みたいこと>）'], ['/usage', 'Muse の利用状況（週の使用量）と muser の記録'], ['/login', 'muse.ai にログインし直す（Edge の窓が開きます）'], ['/lang', '表示言語を切り替える（English / 日本語）'], ['/update', 'muser を最新版に更新する（npm）'], ['/output', 'PC 操作の出力を全文で見る（画面では一部だけ）'], ['/exit', '終了'],
];

let nextId = 1;
const ATTACH_TOTAL = 11 * 1024 * 1024; // images per message, before base64 (the device link takes ~16 MB)
// The terminal bell on approvals and finished agents; off with MUSER_NO_BELL=1 or "bell": false in ~/.muser/config.json.
const BELL = process.env.MUSER_NO_BELL !== '1' && (() => { try { return require('../config.js').read().bell !== false; } catch { return true; } })();
const bell = () => { if (BELL) process.stdout.write('\x07'); };
const MAX_QUEUE = 5, MAX_HISTORY = 200, BANG_NOTE = 20000; // characters of a !command's output sent to Muse
const HISTORY_FILE = process.env.MUSER_HISTORY_FILE || path.join(os.homedir(), '.muser', 'history.json'); // tests point it elsewhere
function loadHistory() {
  try { const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(h) ? h.filter(x => typeof x === 'string').slice(-MAX_HISTORY) : []; } catch { return []; }
}
// Appends to what is on disk now: every muser window wrote back its own copy from startup, so the
// last window to send a message erased what was typed in the others.
function saveHistory(history) {
  try {
    const text = history[history.length - 1], disk = loadHistory();
    if (typeof text === 'string' && disk[disk.length - 1] !== text) disk.push(text);
    fs.mkdirSync(path.dirname(HISTORY_FILE), {recursive: true});
    const temp = HISTORY_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(disk.slice(-MAX_HISTORY))); fs.renameSync(temp, HISTORY_FILE);
  } catch {}
}

export class Controller {
  constructor({agent, museName, version, onExit}) {
    this.heldSteps = []; this.outputs = [];
    this.agent = agent; this.museName = museName; this.version = version; this.onExit = onExit;
    this.listeners = new Set();
    this.s = {
      entries: [{id: nextId++, type: 'banner'}],
      stream: null, running: null, busy: false, turnStart: 0, status: '', activity: '', museRunning: '',
      approval: null, reasonFor: null, todos: [], flash: '', deviceOk: !!agent.device?.connected,
      text: '', pos: 0, mode: agent.mode, clearCount: 0, attachments: [], agents: [], shells: [],
    };
    this.history = loadHistory(); this.hIndex = -1; this.draft = ''; this.exitArmed = 0; this.queue = []; this.tabState = null; this.md = null; this.atPick = {key: null, idx: 0};
    this.wire();
    // Started from the home folder or a drive root, every search without a path walks all of it.
    const cwd = path.resolve(agent.cwd || '.');
    if (cwd.toLowerCase() === path.resolve(os.homedir()).toLowerCase() || cwd === path.parse(cwd).root) {
      this.note([t('作業フォルダーが {cwd} です（ホームかドライブ直下）。検索がフォルダー全体に広がるので、作業するフォルダーで起動するか muser --cd <フォルダー> を使ってください。', {cwd})]);
    }
  }
  // ---- store ----
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  // trail: which state keys changed, and when (no content), for the crash report (src/crash.js).
  set(patch) { this.s = {...this.s, ...patch}; this.trace(Object.keys(patch).join(',')); for (const fn of this.listeners) fn(); }
  trace(what) { (this.trail ||= []).push([Date.now(), what]); if (this.trail.length > 400) this.trail.splice(0, 100); }
  // Never trim this list: Ink's <Static> remembers how many items it has printed (items.length)
  // and prints only items.slice(that), so a capped list stops growing and nothing new appears.
  push(...entries) { this.set({entries: [...this.s.entries, ...entries.map(e => ({id: nextId++, ...e}))]}); }
  flash(msg, ms = 2500) { this.set({flash: msg}); clearTimeout(this.flashTimer); this.flashTimer = setTimeout(() => this.set({flash: ''}), ms); }

  // ---- agent events ----
  wire() {
    const a = this.agent;
    a.approver = call => this.ask(call);
    a.on('device', d => this.set({deviceOk: !!d.connected}));
    a.on('connection', c => {
      if (c.state === 'connecting') this.flash(t('Muse に接続しています…'), 60000);
      else if (c.state === 'reconnecting') this.flash(t('Muse に再接続しています…'), 60000);
      else if (c.state === 'connected') { this.flash(c.first ? '' : t('Muse に再接続しました')); if (this.s.loginNeeded) this.set({loginNeeded: false}); }
      else if (c.state === 'auth') {
        // Once per lapse (the background connect and a send both report it): offer to log in here.
        this.flash('');
        if (this.s.loginNeeded) return;
        this.set({loginNeeded: true});
        this.openMenu({loginOffer: true, title: t('muse.ai のログインが切れています'), hint: t('muser を閉じずにログインし直せます'),
          options: [{value: 'login', label: t('ログインし直す'), desc: t('Edge の窓が開きます。ログインすると、そのまま接続します')}, {value: 'later', label: t('あとで'), desc: t('/login でいつでも')}],
          index: 0, pick: v => { if (v === 'login') this.login(); }});
      }
      else this.flash(t('再接続できませんでした（自動で再試行します）: {error}', {error: c.error}), 10000);
    });
    a.on('text', e => this.onText(e));
    a.on('message-done', e => this.endMessage(e.id));
    a.on('status', status => this.set({status}));
    // Muse's own side: its status on the spinner, and each of its tool calls (searches etc.) once in
    // scrollback. Calls that finish while a reply streams wait for it, so the reply is not split.
    a.on('activity', ({step}) => this.set({activity: step}));
    a.on('muse-running', running => this.set({museRunning: running}));
    a.on('muse-step', step => { if (this.s.stream) this.heldSteps.push(step); else this.push({type: 'muse', step}); });
    a.on('tool-start', call => { this.flushStream(); this.set({running: {call, tail: []}}); });
    a.on('tool-output', ({id, chunk}) => {
      // Only the running call's own output: a parallel agent's command printed into main's display.
      const r = this.s.running; if (!r || (id && r.call.id && r.call.id !== id)) return;
      // The unfinished last line is shown as its latest frame: a progress meter redraws one line with \r.
      const lines = ((r.rest || '') + stripEmbeds(chunk)).split('\n'), last = lines.pop();
      const rest = last.slice(last.replace(/\r+$/, '').lastIndexOf('\r') + 1); // only the latest frame is kept
      this.set({running: {...r, rest, now: frames(rest), tail: [...r.tail, ...lines.map(frames).filter(l => l.trim())].slice(-5)}});
    });
    // The full output stays here (the last 30), not in scrollback entries; the screen shows a tail.
    a.on('tool-end', ({output, ...call}) => {
      this.set({running: null}); this.push({type: 'tool', call: {...call, outputLines: this.keepOutput(call, output)}});
    });
    a.on('todos', todos => this.set({todos}));
    // Parallel agents: live cards while they work, a result card in scrollback when they finish.
    const upsert = snap => this.set({agents: [...this.s.agents.filter(x => x.tag !== snap.tag), snap].sort((x, y) => x.tag.localeCompare(y.tag, 'en', {numeric: true}))});
    a.on('agent-update', upsert);
    a.on('shell', snap => this.set({shells: [...this.s.shells.filter(x => x.id !== snap.id), snap].sort((x, y) => x.started - y.started)}));
    a.on('agent-done', snap => { upsert(snap); this.push({type: 'agent', snap}); bell(); });
    a.on('turn-start', () => { this.planAtTurn = this.s.plan?.percentUsed ?? null; });
    a.on('turn-end', e => {
      this.set({activity: '', museRunning: ''});
      this.flushStream();
      // Safety net: if no text streamed this turn, show the final reply that the turn ended with.
      if (e.ok && !this.sawText && e.text?.trim()) {
        const md = createMd();
        this.push({type: 'md', rows: sanitizeEmbeds(e.text.trimEnd()).split('\n').map(l => md.row(l)), first: true}, {type: 'gap'});
      }
      this.set({busy: false});
      if (e.sources?.length) this.push({type: 'sources', items: e.sources});
      this.push({type: 'end', ...e});
      // Local tally heads-up: today's turns reached the daily limit (if one is set).
      try { const lim = usage.limits(); if (e.ok && lim.dailyTurns > 0 && !this.usageWarned && usage.summary().today.turns >= lim.dailyTurns) { this.usageWarned = true; this.note(t('今日のターン上限（{n}）に達しました', {n: lim.dailyTurns})); } } catch {}
      // The real weekly usage, refreshed after every turn; say how much this turn moved it.
      const before = this.planAtTurn;
      this.refreshPlan().then(p => {
        if (p && before !== null && before !== undefined && p.percentUsed > before) this.note(t('Muse の週の使用量 {before}% → {after}%（この作業で +{diff}%）', {before, after: p.percentUsed, diff: p.percentUsed - before}));
      });
      // After esc (an interrupted turn) the queued messages go back into the input instead of being
      // sent: the user stopped the work, and the next queued task started right away regardless.
      if (this.queue.length && e.aborted) {
        const n = this.queue.length, back = this.queue.splice(0).join('\n'), cur = this.s.text;
        this.setText(cur ? back + '\n' + cur : back);
        this.flash(t('中断したので、待っていた {n} 件は送らずに入力欄に戻しました', {n}), 5000);
      } else if (this.queue.length) this.submit(this.queue.shift());
    });
  }
  onText({id, text}) {
    this.sawText = true;
    let st = this.s.stream;
    if (st && st.id !== id) { this.endMessage(st.id); st = null; }
    if (!st) { this.md = createMd(); st = {id, done: 0, partial: '', started: false, emitted: '', raw: ''}; }
    // An embed token may be split across deltas: hold back a trailing unfinished `[[...`
    // fragment (up to 120 chars) until it resolves; past that it is treated as literal text.
    const held = partialEmbedTail(text);
    const clean = sanitizeEmbeds(held ? text.slice(0, text.length - held.length) : text);
    // Revision check: the new text must extend exactly the prefix already emitted to scrollback.
    // (The old check compared the text against its own slice, so it could never fire.) Scrollback
    // is append-only (<Static>), so a rewrite cannot be edited in place: mark it and re-emit the
    // revised text below the marker.
    if (clean.length < st.done || clean.slice(0, st.done) !== st.emitted) {
      if (st.done > 0 || st.started) this.push({type: 'note', lines: [t('（Muse が返信を書き直しました — 以下が新しい内容です）')]});
      this.md = createMd();
      st = {id, done: 0, partial: '', started: false, emitted: '', raw: ''};
    }
    const rest = clean.slice(st.done), nl = rest.lastIndexOf('\n');
    let started = st.started, done = st.done;
    if (nl >= 0) {
      const rows = rest.slice(0, nl).split('\n').map(l => this.md.row(l));
      this.push({type: 'md', rows, first: !started});
      started = true; done += nl + 1;
    }
    this.set({stream: {id, done, started, partial: clean.slice(done), emitted: clean.slice(0, done), raw: text}});
  }
  // Preview of the unfinished line; must not move the fence state of the real render.
  previewRow() {
    const st = this.s.stream; if (!st?.partial) return null;
    // Only the tail of an unfinished line that would not fit the screen: a 60,000-character line
    // (minified JSON) streamed as thousands of rows redrawn on every delta. Cut before Markdown
    // styling, so no escape sequence is split. The whole line is kept once it ends.
    const room = (process.stdout.columns || 100) * Math.max(3, (process.stdout.rows || 30) - 16);
    const shown = st.partial.length > room ? '…' + st.partial.slice(-room) : st.partial;
    const fence = this.md.fence, row = this.md.row(shown); this.md.fence = fence;
    return {row, first: !st.started};
  }
  flushStream() { if (this.s.stream) this.endMessage(this.s.stream.id); }
  endMessage(id) {
    const st = this.s.stream; if (!st || st.id !== id) return;
    // Flush from the raw text so a fragment held back mid-token resolves here (sanitize turns an
    // unfinished trailing token into the placeholder instead of leaking `[[hatch_...`).
    const tail = st.raw != null ? sanitizeEmbeds(st.raw).slice(st.done) : st.partial;
    if (tail) this.push({type: 'md', rows: tail.split('\n').map(l => this.md.row(l)), first: !st.started});
    this.push({type: 'gap'});
    this.set({stream: null});
    for (const step of this.heldSteps.splice(0)) this.push({type: 'muse', step});
  }
  ask(call) {
    const tool = TOOLS[call.command];
    let preview = null;
    if (call.demoPreview) preview = call.demoPreview;
    else if (tool.preview) { try { preview = tool.preview(call.params, this.agent.ctx); } catch (e) { preview = {error: e.message}; } }
    // Commands with shell syntax, or programs that run anything (powershell, node …), get no
    // "don't ask again": a remembered key must not cover more than the user saw (src/policy.js).
    const key = call.kind === 'exec' ? alwaysKey('exec', call.params) : null, word = key ? key.slice('exec:'.length) : '';
    const options = call.kind === 'mcp'
      ? [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは {tool} を聞かない', {tool: call.mcp.tool}), allow: true, always: alwaysKey('mcp', call.params, call.command)}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}]
      : call.kind === 'edit'
      ? [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは編集を自動に（承認モード「編集は自動」）'), allow: true, autoEdit: true}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}]
      : [{label: t('はい'), allow: true}, ...(key ? [{label: t('はい、このフォルダーでは {word} を聞かない', {word}), allow: true, always: key}] : []), {label: t('いいえ（Muse に伝えることを入力）'), allow: false}];
    const targets = tool.target ? [].concat(tool.target(call.params, this.agent.ctx) || []) : [];
    // As muser itself judges it (agent.execute): where the path really leads. startsWith('..') missed
    // another drive (D:\ from C:\ is not "..") and writes through a junction.
    const {inside, realOf} = require('../tools.js'), realCwd = realOf(this.agent.cwd);
    const outside = targets.some(t => !inside(realCwd, realOf(t)));
    bell();
    return new Promise(resolve => {
      const req = {call, preview, options, index: 0, outside};
      req.resolve = v => { if (req.done) return; req.done = true; clearTimeout(req.timer); resolve(v); };
      // Muse stops waiting at call.deadline; the approval closes then instead of staying open
      // for a change that would run unseen by Muse.
      if (call.deadline) { req.timer = setTimeout(() => this.expireApproval(req), Math.max(0, call.deadline - Date.now())); req.timer.unref?.(); }
      // Its task stopped (esc, an agent stopped): the approval goes away instead of waiting for a "yes" that would do nothing.
      call.abortSignal?.addEventListener('abort', () => this.expireApproval(req, 'stopped'), {once: true});
      if (this.s.approval || this.s.reasonFor) (this.pending ||= []).push(req);
      else this.set({...(call.agent === 'main' ? {running: null} : {}), approval: req});
    });
  }
  expireApproval(req, why = 'timeout') {
    if (req.done) return;
    if (this.s.approval === req) this.set({approval: null});
    else if (this.s.reasonFor === req) { this.set({reasonFor: null}); this.restoreDraft(); }
    else this.pending = (this.pending || []).filter(x => x !== req);
    req.resolve({allow: false, expired: true});
    const what = ((req.call.command || '') + ' ' + (req.call.summary || '')).trim();
    if (why === 'stopped') this.note(t('作業を止めたので、承認待ちだった {what} は取りやめました。', {what}));
    else this.note(t('承認が間に合わず Muse が待つのをやめたので、{what} は行いませんでした。', {what}));
    if (!this.s.approval && !this.s.reasonFor) this.nextApproval();
  }
  // Declining with a reason borrows the input; what the user was typing comes back after.
  restoreDraft() { const d = this.reasonDraft; this.reasonDraft = null; if (d) this.setText(d.text, d.pos); }
  nextApproval() {
    const next = this.pending?.shift();
    if (next) this.set({approval: next});
  }
  answer(i) {
    const a = this.s.approval, o = a.options[i];
    if (!o.allow) { this.reasonDraft = {text: this.s.text, pos: this.s.pos}; return this.set({approval: null, reasonFor: a, text: '', pos: 0}); }
    if (o.autoEdit && this.agent.mode === 'default') this.setMode('auto-edit');
    this.set({approval: null, ...(a.call.agent === 'main' ? {running: {call: a.call, tail: []}} : {})});
    a.resolve({allow: true, always: o.always || null});
    this.nextApproval();
  }
  // /mcp: each configured server with its state; picking one turns it on or off (the device
  // re-registers so Muse sees the new tool list). Servers found in Claude Code / Codex can be imported.
  mcpMenu() {
    const a = this.agent, hub = a.mcp, cfg = mcpConfig.load(), found = mcpConfig.discover();
    const options = Object.entries(cfg.mcpServers || {}).map(([name, s]) => {
      const live = hub?.servers.get(name);
      const state = live?.status === 'connected' ? '● ' + t('{n} ツール', {n: live.tools.length}) : live?.status === 'error' ? '✗ ' + live.error : s.enabled ? t('… 接続待ち') : t('○ オフ');
      return {value: {toggle: name, on: !s.enabled}, label: name, desc: state + (s.url ? '  ' + s.url : '  ' + [s.command, ...(s.args || [])].join(' ')), current: s.enabled ? {toggle: name} : null};
    });
    if (found.length) options.push({value: {import: true}, label: t('取り込む（{n} 件）', {n: found.length}), desc: found.map(f => f.name + ' (' + f.from + ')').join(', ')});
    if (!options.length) return this.note([t('MCP サーバーがありません。{file} に mcpServers を書くか、Claude Code / Codex に設定してください。', {file: mcpConfig.FILE})]);
    this.openMenu({title: t('MCP サーバー'), hint: t('選ぶとオン・オフ（{file}）', {file: mcpConfig.FILE}), options: options.map(o => ({...o, mark: o.current ? true : false})), pick: v => this.mcpPick(v)});
  }
  async mcpPick(v) {
    const a = this.agent;
    if (!this.agent.mcp && !v.import) return this.note(t('このモードでは MCP を使えません。'));
    if (v.import) { mcpConfig.importServers(mcpConfig.discover()); this.note(t('取り込みました（すべてオフ）。使うものを選んでオンにしてください。')); return this.mcpMenu(); }
    if (this.s.busy) return this.flash(t('作業中は切り替えられません'));
    const cfg = mcpConfig.setEnabled(v.toggle, v.on), s = cfg.mcpServers[v.toggle];
    try {
      if (v.on) { this.flash(t('{name} に接続しています…', {name: v.toggle}), 15000); await a.mcp.connect(v.toggle, s); }
      else await a.mcp.disconnect(v.toggle);
      a.mcp.index(); await a.reconnectDevice();
      const live = a.mcp.servers.get(v.toggle);
      this.flash('');
      this.note(v.on ? t('{name}: {n} ツールを Muse に渡しました', {name: v.toggle, n: live.tools.length}) : t('{name} をオフにしました', {name: v.toggle}));
    } catch (e) { this.flash(''); this.note(v.toggle + ': ' + e.message); try { a.mcp.index(); await a.reconnectDevice(); } catch {} }
  }
  // A pick-one menu in place of the input box (/permissions, /resume).
  // The draft stays: a menu can open by itself (the re-login offer) while the user is typing, and a
  // slash command was already taken out of the input when it was sent.
  openMenu(menu) { this.set({menu: {index: 0, ...menu}}); }
  menuKey(input, k) {
    const m = this.s.menu, n = m.options.length;
    if (k.upArrow) return this.set({menu: {...m, index: (m.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({menu: {...m, index: (m.index + 1) % n}});
    const pick = i => { this.set({menu: null}); m.pick(m.options[i].value); };
    if (/^[1-9]$/.test(input) && Number(input) <= n) return pick(Number(input) - 1);
    if (k.return) return pick(m.index);
    if (k.escape || (k.ctrl && input === 'c')) this.set({menu: null});
  }
  submitReason(text) { const a = this.s.reasonFor; this.set({reasonFor: null}); this.restoreDraft(); a.resolve({allow: false, reason: text.trim()}); this.nextApproval(); }
  // The mode is remembered for this folder (src/permissions.js).
  setMode(m) { this.agent.mode = m; this.set({mode: m}); if (this.agent.client?.status !== 'demo') permissions.saveMode(this.agent.cwd, m); }
  cycleMode() { this.setMode(MODES[(MODES.indexOf(this.agent.mode) + 1) % MODES.length]); }

  // ---- input ----
  setText(text, pos = text.length) { this.set({text, pos}); }
  insert(t) { const {text, pos} = this.s; this.setText(text.slice(0, pos) + t + text.slice(pos), pos + t.length); }
  paste(t) {
    if (this.s.approval || this.s.menu) return;
    // Dropping image files into the terminal pastes their paths: attach them instead.
    const paths = clip.pastedImagePaths(t);
    if (paths) return paths.forEach(p => this.attach(p));
    this.insert(t.replace(/\r\n?/g, '\n'));
  }
  attach(file, temporary) {
    try {
      const a = clip.attachment(file, temporary);
      // A message carries at most ~16 MB, base64 adds a third: two 9 MB images failed at send time
      // with a bare "message_too_large", and the attachments were already gone from the input.
      const total = this.s.attachments.reduce((n, x) => n + x.size, 0) + a.size;
      if (total > ATTACH_TOTAL) return this.flash(t('画像は合計 {max} MB までです（{name} を足すと {mb} MB）', {max: ATTACH_TOTAL / 1024 / 1024, name: a.name, mb: (total / 1024 / 1024).toFixed(1)}), 6000);
      this.set({attachments: [...this.s.attachments, a]}); this.flash(t('画像を添付: {name}', {name: a.name}));
    }
    catch (e) { this.flash(e.message); }
  }
  async pasteImage() {
    this.flash(t('クリップボードを確認しています…'), 5000);
    const files = await clip.clipboardImages();
    if (!files.length) return this.flash(t('クリップボードに画像がありません'));
    files.forEach(f => this.attach(f.path, f.temporary));
  }
  key(input, k) {
    if (this.s.approval) return this.approvalKey(input, k);
    if (this.s.menu) return this.menuKey(input, k);
    if (!k.tab) this.tabState = null;
    const {text, pos} = this.s;
    if (k.ctrl && input === 'c') {
      if (this.s.busy) { this.agent.interrupt(); return this.flash(t('中断しています…')); }
      // A !command could not be stopped at all: `!npm run dev` without & held the screen for its full 120 s.
      if (this.s.bangRunning) { this.bangStop?.abort(); return this.flash(t('中断しています…')); }
      if (text) return this.setText('');
      if (Date.now() - this.exitArmed < 1500) return this.onExit();
      this.exitArmed = Date.now(); return this.flash(t('もう一度 ctrl+c で終了'));
    }
    // Twice, like ctrl+c: one stray ctrl+d closed muser at once, a running turn included.
    if (k.ctrl && input === 'd' && !text) {
      if (Date.now() - this.exitArmed < 1500) return this.onExit();
      this.exitArmed = Date.now(); return this.flash(t('もう一度 ctrl+d で終了'));
    }
    if (k.escape) {
      if (this.s.reasonFor) return this.submitReason('');
      if (this.s.busy) { this.agent.interrupt(); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.bangStop?.abort(); return this.flash(t('中断しています…')); }
      // Twice to clear: one esc (closing the @ list, say) wiped a long draft.
      if (text) {
        if (Date.now() - (this.escArmed || 0) < 1500) { this.escArmed = 0; this.setText(''); return; }
        this.escArmed = Date.now(); return this.flash(t('もう一度 esc で入力を消す'), 1500);
      }
      return;
    }
    if (k.tab && k.shift) return this.cycleMode();
    // alt+v (and ctrl+v when the terminal passes it through): image from the clipboard.
    if ((k.meta && input === 'v') || (k.ctrl && input === 'v') || input === '\x16') { this.pasteImage(); return; }
    // Backspace on an empty input removes the last attachment.
    if (k.backspace && !text && this.s.attachments.length) return this.set({attachments: this.s.attachments.slice(0, -1)});
    if (k.tab && !k.shift) return this.completeTab(text, pos);
    // Enter while the caret sits in an @fragment picks the highlighted candidate instead
    // of sending: the footer shows the list, so Enter meaning "send" here surprised people
    // into thinking @ selection did not exist. A second Enter (after the pick, caret past
    // the completed path) sends as usual.
    if (k.return && !k.shift && !k.meta) {
      const ctx = this.atContext(text, pos);
      const pick = ctx?.list.length ? ctx.list[this.atIndex(ctx.at.fragment, ctx.list.length)] : null;
      // A path already typed out in full sends, as Enter normally does (it took a second Enter).
      if (pick && pick !== ctx.at.fragment) return this.applyAtPick(ctx.at, pick);
    }
    if (k.return) {
      if (k.shift || k.meta) return this.insert('\n');
      if (text.slice(0, pos).endsWith('\\')) return this.setText(text.slice(0, pos - 1) + '\n' + text.slice(pos), pos);
      this.setText(''); this.hIndex = -1;
      if (this.s.reasonFor) return this.submitReason(text);
      if (!text.trim() && !this.s.attachments.length) return;
      if (this.history[this.history.length - 1] !== text) { this.history.push(text); if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY); saveHistory(this.history); }
      this.draft = '';
      return this.submit(text);
    }
    if (input === '\n') return this.insert('\n'); // ctrl+j
    if (k.backspace) { if (pos) { const ch = [...text.slice(0, pos)].pop(); this.setText(text.slice(0, pos - ch.length) + text.slice(pos), pos - ch.length); } return; }
    if (k.delete) { const ch = [...text.slice(pos)][0]; if (ch) this.setText(text.slice(0, pos) + text.slice(pos + ch.length), pos); return; }
    if (k.leftArrow) { if (pos) this.set({pos: pos - [...text.slice(0, pos)].pop().length}); return; }
    if (k.rightArrow) { const ch = [...text.slice(pos)][0]; if (ch) this.set({pos: pos + ch.length}); return; }
    if (k.home || (k.ctrl && input === 'a')) return this.set({pos: text.lastIndexOf('\n', pos - 1) + 1});
    if (k.end || (k.ctrl && input === 'e')) { const e = text.indexOf('\n', pos); return this.set({pos: e < 0 ? text.length : e}); }
    if (k.ctrl && input === 'u') return this.setText(text.slice(pos), 0);
    if (k.ctrl && input === 'k') return this.setText(text.slice(0, pos), pos);
    if (k.ctrl && input === 'w') { const b = text.slice(0, pos).replace(/\S+\s*$/, ''); return this.setText(b + text.slice(pos), b.length); }
    // ↑↓ while an @fragment is being typed moves in the candidate list the footer shows,
    // not through history (history used to swallow the keys, so the list looked unselectable).
    if (k.upArrow || k.downArrow) {
      const ctx = this.atContext(text, pos);
      if (ctx?.list.length) {
        const idx = this.atIndex(ctx.at.fragment, ctx.list.length);
        this.atPick.idx = (idx + (k.upArrow ? -1 : 1) + ctx.list.length) % ctx.list.length;
        return this.set({}); // atPick is not store state: without a render the highlight did not move
      }
    }
    if ((k.upArrow || k.downArrow) && !text.includes('\n')) {
      if (!this.history.length) return;
      if (k.upArrow) {
        if (this.hIndex < 0) this.draft = text; // keep the in-progress draft for the way back down
        this.hIndex = this.hIndex < 0 ? this.history.length - 1 : Math.max(0, this.hIndex - 1);
        return this.setText(this.history[this.hIndex]);
      }
      if (this.hIndex < 0) return;
      this.hIndex++;
      if (this.hIndex >= this.history.length) { this.hIndex = -1; return this.setText(this.draft || ''); }
      return this.setText(this.history[this.hIndex]);
    }
    if (input && !k.ctrl && !k.meta) this.insert(input.replace(/\r\n?/g, '\n'));
  }
  // The @fragment at the caret plus its candidates — the same list (same limit) the footer
  // draws, so the highlight there and the pick here never disagree.
  atContext(text, pos) {
    const at = mention.fragmentAt(text, pos);
    return at ? {at, list: mention.complete(at.fragment, this.agent.cwd)} : null;
  }
  // The highlighted candidate for a fragment; resets whenever the fragment changes.
  atIndex(fragment, n) {
    if (this.atPick.key !== fragment) this.atPick = {key: fragment, idx: 0};
    return n ? ((this.atPick.idx % n) + n) % n : 0;
  }
  applyAtPick(at, pick) {
    const {text, pos} = this.s;
    const q = /\s/.test(pick) ? '"' + pick + '"' : pick;
    const ins = pick.endsWith('/') ? q : q + ' ';
    const nt = text.slice(0, at.start) + ins + text.slice(pos);
    this.tabState = null;
    return this.setText(nt, at.start + ins.length);
  }
  // Tab completion for @files and /commands (the old code checked @ first and returned either
  // way, so the / branch below it never ran for most inputs, and nothing could cycle). Repeated
  // Tab cycles candidates: tabState remembers the applied text and the range it occupies.
  completeTab(text, pos) {
    const prev = this.tabState;
    if (prev && prev.text === text && prev.end === pos && prev.list.length > 1) {
      const idx = (prev.idx + 1) % prev.list.length, ins = prev.format(prev.list[idx]);
      const nt = text.slice(0, prev.start) + ins + text.slice(prev.end);
      this.tabState = {...prev, idx, text: nt, end: prev.start + ins.length};
      return this.setText(nt, prev.start + ins.length);
    }
    const at = mention.fragmentAt(text, pos);
    if (at) {
      const list = mention.complete(at.fragment, this.agent.cwd, 12);
      if (!list.length) return;
      const format = pick => { const q = /\s/.test(pick) ? '"' + pick + '"' : pick; return pick.endsWith('/') ? q : q + ' '; };
      const ins = format(list[0]), nt = text.slice(0, at.start) + ins + text.slice(pos);
      this.tabState = {kind: 'at', start: at.start, idx: 0, list, format, text: nt, end: at.start + ins.length};
      return this.setText(nt, at.start + ins.length);
    }
    if (text.startsWith('/') && !text.slice(0, pos).includes(' ')) {
      const word = text.slice(0, pos);
      const list = COMMANDS.map(([n]) => n).filter(n => n.startsWith(word) && n !== word);
      if (!list.length) return;
      const format = name => list.length === 1 ? name + ' ' : name;
      const ins = format(list[0]), nt = ins + text.slice(pos);
      this.tabState = {kind: 'slash', start: 0, idx: 0, list, format, text: nt, end: ins.length};
      return this.setText(nt, ins.length);
    }
  }
  approvalKey(input, k) {
    const a = this.s.approval, n = a.options.length;
    if (k.upArrow) return this.set({approval: {...a, index: (a.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({approval: {...a, index: (a.index + 1) % n}});
    if (/^[1-9]$/.test(input) && Number(input) <= n) return this.answer(Number(input) - 1);
    if (k.return) return this.answer(a.index);
    if (k.escape || (k.ctrl && input === 'c')) { this.set({approval: null}); a.resolve({allow: false}); this.nextApproval(); }
  }

  // ---- commands ----
  async submit(text) {
    if (text.startsWith('/')) return this.slash(text.trim());
    if (text.startsWith('!')) return this.bang(text.slice(1).trim());
    if (this.s.busy) {
      if (this.queue.length >= MAX_QUEUE) { this.note(t('キューがいっぱいです（最大 {max} 件まで）。現在の作業が終わってから送ってください。', {max: MAX_QUEUE})); return this.flash(t('キューがいっぱいです')); }
      this.queue.push(text); return this.flash(t('作業中なので、終わったら送ります（キュー {n} 件目）', {n: this.queue.length}));
    }
    const attachments = this.s.attachments;
    // @path mentions go along with the message; ! command output since the last turn too.
    const ex = mention.expand(text, this.agent.cwd, this.agent.ctx.readFiles);
    this.push({type: 'user', text, images: attachments.map(a => a.name), files: ex.files, missing: ex.missing}); this.sawText = false;
    this.set({busy: true, turnStart: Date.now(), status: '', attachments: []});
    const extra = [...(this.bangNotes || []), ex.block].filter(Boolean); this.bangNotes = [];
    // In the user's language: it is the user's message in the Muse chat (the app shows it too).
    const body = (text || t('（画像を見てください）')) +(extra.length ? '\n\n' + extra.join('\n\n') : '');
    try { await this.agent.send(body, {attachments, display: text}); }
    catch (e) { if (this.s.busy) { this.set({busy: false}); this.push({type: 'end', ok: false, error: e.message}); } }
  }
  // The full output of a call, for /output (the last 30); returns its line count for the "… N more" hint.
  keepOutput(call, output) {
    const text = frames(String(output || '')).trimEnd();
    if (text) { this.outputs.push({id: call.id, at: Date.now(), command: call.command, summary: call.summary || '', text}); if (this.outputs.length > 30) this.outputs.shift(); }
    return text ? text.split('\n').length : 0;
  }
  // !command: the user's own shell command, run here without Muse or approval. Its output
  // goes to Muse with the next message, as in Claude Code's bash mode.
  async bang(cmd) {
    if (!cmd) return this.note(t('使い方: !<コマンド>   （例: !git status · 裏で動かすなら !npm run dev &）'));
    if (/\s&$/.test(cmd)) {
      const command = cmd.replace(/\s&$/, '');
      try { const s = this.agent.shells.start(command, {cwd: this.agent.cwd}); this.push({type: 'tool', call: {id: 'bang-' + Date.now(), agent: 'main', command: 'system.run', params: {command}, kind: 'exec', summary: command, user: true, ok: true, view: {background: s.id, tail: []}}});
        (this.bangNotes ||= []).push('[The user started this in the background as ' + s.id + ': ' + command + ' — read it with shell.output]'); }
      catch (e) { this.note(e.message); }
      return;
    }
    const call = {id: 'bang-' + Date.now(), agent: 'main', command: 'system.run', params: {command: cmd}, kind: 'exec', summary: cmd, user: true};
    // Its own row, not `running`: during a turn Muse's next call took the row over, and the
    // command's end then cleared the row of the call Muse still had running.
    this.set({bangRunning: {call, tail: []}});
    const onOut = chunk => { const r = this.s.bangRunning; if (!r || r.call !== call) return; const lines = frames(chunk).split('\n').filter(l => l.trim()); this.set({bangRunning: {...r, tail: [...r.tail, ...lines].slice(-5)}}); };
    try {
      const stop = this.bangStop = new AbortController();
      const r = await LOCAL['system.run'].run({command: cmd}, this.agent.ctx, stop.signal, onOut);
      this.set({bangRunning: null});
      // Kept for /output like Muse's commands: past the 12 lines on screen it could not be seen at all.
      const outputLines = this.keepOutput(call, stripEmbeds(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : '')));
      this.push({type: 'tool', call: {...call, ok: true, outputLines, view: {...r.view, tail: frames(stripEmbeds(r.payload.stdout + r.payload.stderr)).trimEnd().split('\n').slice(-12)}}});
      // The end is kept too, and the cut is said: the first 20,000 characters alone dropped the
      // errors at the bottom of a long build and all of stderr, without a word.
      const out = stripEmbeds(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : ''));
      const sent = out.length > BANG_NOTE ? out.slice(0, BANG_NOTE * 0.3) + '\n… (' + (out.length - BANG_NOTE) + ' characters cut here) …\n' + out.slice(-BANG_NOTE * 0.7) : out;
      (this.bangNotes ||= []).push('[The user ran this in the terminal: ' + cmd + ']\nexit ' + r.payload.exit_code + '\n' + sent);
    } catch (e) { this.set({bangRunning: null}); this.push({type: 'tool', call: {...call, ok: false, error: e.message}}); }
  }
  // A resumed chat: its turns from the local transcript (Muse fills in only what is missing),
  // the last ones on screen, and the todo list as it was.
  async showResumed(s, {startup = false} = {}) {
    if (!s) return;
    const a = this.agent;
    if (!startup) { a.session = s; a.ctx.readFiles.clear(); a.ctx.todos = []; this.bangNotes = []; this.set({todos: []}); }
    // Reading the chat from Muse needs the gateway, which may still be connecting at startup.
    if (sessions.transcript(s.id).length < (s.turns || 0)) { try { await a.ensureConnected?.(); } catch {} }
    let res;
    try { res = await transcript.forResume(s, a.client); } catch { res = {turns: sessions.transcript(s.id), from: 'local'}; }
    const turns = res.turns, shown = turns.slice(-10);
    if (!startup || turns.length) this.note(t('↺ 再開: {title} · {n} ターン', {title: s.title || s.id, n: Math.max(s.turns || 0, turns.length)}) +
      (turns.length > shown.length || res.partial ? t('（直近 {n} ターンを表示）', {n: shown.length}) : '') + (res.from === 'muse' ? t(' · Muse から読み込み') : ''));
    for (const t of shown) {
      this.push({type: 'user', text: t.user || ''});
      if (t.tools?.length || t.steps?.length) this.push({type: 'past', tools: t.tools || [], steps: t.steps || []});
      if (t.reply) { const md = createMd(); this.push({type: 'md', rows: sanitizeEmbeds(String(t.reply).trimEnd()).split('\n').map(l => md.row(l)), first: true}, {type: 'gap'}); }
      if (t.error) this.push({type: 'end', ok: false, error: t.error, ms: 0});
    }
    if (!turns.length && (s.turns || 0) > 0) this.note(t('この会話の中身は読み込めませんでした（Muse に接続できないか、記録がありません）。続きは送れます。'));
    const todos = turns[turns.length - 1]?.todos;
    if (Array.isArray(todos) && todos.length) { this.set({todos}); a.ctx.todos = todos; }
    if (shown.length) this.note(t('── ここから続き ──'));
  }
  // `muser login` without leaving the TUI: the Edge window, then the new cookies into the running
  // client, then connect.
  async login() {
    if (this.loggingIn) return;
    this.loggingIn = true;
    this.flash(t('Edge の窓で muse.ai にログインしてください…'), 300000);
    try {
      const flow = this.agent.loginFlow || (o => require('../login.js').login(o)); // demo: a scripted stand-in
      await flow({log: s => this.flash(String(s).trim().replace(/^…\s*/, ''), 300000)});
      this.agent.reloadLogin?.(); usage.resetWeb?.();
      this.flash(t('ログインしました。Muse に接続しています…'), 60000);
      await this.agent.ensureConnected();
      this.flash(''); this.set({loginNeeded: false, ...(this.s.menu?.loginOffer ? {menu: null} : {})});
      this.note(t('muse.ai にログインし直して、接続しました。'));
      this.refreshPlan();
    } catch (e) { this.flash(''); this.note(t('ログインできませんでした: {error}（/login でもう一度）', {error: e.message})); }
    finally { this.loggingIn = false; }
  }
  // Muse's real plan usage (src/usage.js plan()); one request at a time, failures keep the old value.
  refreshPlan() {
    // The demo is offline: it asked muse.ai for the real plan with the saved login (the footer of
    // `muser demo` showed the user's own weekly usage) at start and after every turn.
    if (this.agent.client?.status === 'demo') return Promise.resolve(null);
    return this.planLoading ??= usage.plan().then(p => { this.set({plan: p}); return p; }).catch(() => null).finally(() => { this.planLoading = null; });
  }
  // /output: a tool call's whole output. Saved to a file every time; shown in full up to 400 lines,
  // else its last 200 lines and where the file is.
  showOutput(o) {
    let file = '';
    try {
      const dir = path.join(os.tmpdir(), 'muser-output'); fs.mkdirSync(dir, {recursive: true});
      file = path.join(dir, new Date(o.at).toISOString().replace(/[:.]/g, '-') + '-' + o.command.replace(/[^\w.-]/g, '') + '.txt');
      fs.writeFileSync(file, o.text + '\n');
    } catch {}
    const lines = o.text.split('\n'), long = lines.length > 400;
    this.note([c.bold(o.command + '  ' + o.summary), ...(long ? [c.faint(t('… 先頭の {n} 行は省略', {n: lines.length - 200}))] : []), ...(long ? lines.slice(-200) : lines),
      ...(file ? ['', c.faint(t('全文: {file}', {file}))] : [])]);
  }
  // At every start (src/update.js): the footer says "checking for updates…", then shows a newer
  // version until /update installs it. A failed check just clears the footer.
  checkUpdate() {
    if (!update.enabled()) return Promise.resolve(null);
    this.set({update: {checking: true}});
    return update.latest().then(v => { this.set({update: update.newer(v, this.version) ? {latest: v} : null}); return v; }, () => { this.set({update: null}); return null; });
  }
  async runUpdate() {
    if (update.devCheckout()) return this.note(t('この muser は git から動いている開発用なので、/update では更新しません（git pull で更新してください）。'));
    if (this.updating) return;
    this.updating = true;
    try {
      // Ask npm first: "already the latest" and "could not check" read the same before.
      this.flash(t('新しい版を確認しています…'), 20000);
      let v;
      try { v = await update.latest(); }
      catch (e) { this.flash(''); return this.note(t('npm に新しい版を確認できませんでした（{error}）。つながる環境で /update するか、npm install -g muser-cli@latest を実行してください。', {error: e.message})); }
      if (!update.newer(v, this.version)) { this.flash(''); this.set({update: null}); return this.note(t('muser は最新版です（v{version}）。', {version: this.version})); }
      this.flash(t('muser を更新しています（npm install -g muser-cli@latest）…'), 300000);
      const r = await update.install();
      this.flash('');
      if (!r.ok) return this.note([t('更新できませんでした:'), ...r.output.split('\n').slice(-6)]);
      this.set({update: null});
      this.note(t('muser を {version} に更新しました。いったん終了して muser -c で開き直すと、この会話の続きから新しい版で使えます。', {version: v ? 'v' + v : t('最新版')}));
    } finally { this.updating = false; }
  }
  // /skills: every skill found (muser's own, the project's, Claude Code's, Codex's), each one a
  // toggle; whole sources can be switched off too. Changes apply to chats started afterwards.
  skillsMenu() {
    const a = this.agent, all = skills.load(a.cwd);
    if (!all.length) return this.note([t('スキルがありません。'), t('~/.muser/skills/<名前>/SKILL.md に置くか、Claude Code（~/.claude/skills）や Codex（~/.codex/skills）のスキルがあればそのまま読みます。')]);
    const bySource = {};
    for (const s of all) (bySource[s.source] ||= []).push(s);
    const options = [
      ...all.map(s => ({value: 'skill:' + s.name, label: (s.enabled ? '● ' : '○ ') + s.name, desc: '[' + s.source + '] ' + s.description})),
      ...Object.entries(bySource).map(([src, list]) => {
        const on = list.some(s => s.enabled);
        return {value: 'source:' + src + ':' + (on ? 'off' : 'on'), label: t(on ? '{source} をまとめてオフ' : '{source} をまとめてオン', {source: src}), desc: t('{n} 件', {n: list.length})};
      }),
    ];
    return this.openMenu({title: t('スキル'), hint: t('選ぶとオン・オフ（新しい会話から反映）'), options, index: 0, pick: v => {
      const [kind, id, mode] = v.split(':');
      if (kind === 'skill') { const s = skills.load(a.cwd).find(x => x.name === id); if (s) { skills.setEnabled(id, !s.enabled); this.note(t(s.enabled ? '{name} をオフにしました' : '{name} をオンにしました', {name: id})); } }
      else { skills.setSourceEnabled(id, mode === 'on'); this.note(t(mode === 'on' ? '{source} のスキルをオンにしました' : '{source} のスキルをオフにしました', {source: id})); }
      this.skillsMenu();
    }});
  }
  note(lines) { this.push({type: 'note', lines: [].concat(lines)}); }
  slash(line) {
    // The argument is the rest of the line as typed: a multi-line task after /agent or /skill had
    // its line breaks and indentation squeezed into single spaces.
    const m = /^(\S+)\s*([\s\S]*)$/.exec(line), cmd = m[1], arg = m[2], a = this.agent;
    if (cmd === '/exit' || cmd === '/quit') return this.onExit();
    if (cmd === '/help') return this.push({type: 'help'});
    if (cmd === '/login') return this.login();
    if (cmd === '/update') return this.runUpdate();
    if (cmd === '/output') {
      if (!this.outputs.length) return this.note(t('まだ PC 操作の出力はありません。'));
      const list = [...this.outputs].reverse();
      return this.openMenu({title: t('PC 操作の出力'), hint: t('選ぶと全文を表示（ファイルにも保存）'), index: 0,
        options: list.map((o, i) => ({value: i, label: o.command.replace(/^code\./, '') + '  ' + String(o.summary).slice(0, 60), desc: t('{n} 行', {n: o.text.split('\n').length})})),
        pick: i => this.showOutput(list[i])});
    }
    if (cmd === '/usage') {
      this.flash(t('Muse の利用状況を確認しています…'), 20000);
      return this.refreshPlan().then(p => {
        this.flash('');
        this.note([...(p ? usage.formatPlan(p).split('\n') : [t('Muse の利用状況を読み込めませんでした（muse.ai で確認できます）')]), '', ...usage.formatSummary().split('\n')]);
      });
    }
    if (cmd === '/lang') {
      // /lang en switches at once (the argument used to be ignored and the menu opened).
      const want = ({en: 'en', english: 'en', ja: 'ja', jp: 'ja', japanese: 'ja', '日本語': 'ja'})[arg.toLowerCase()];
      if (want) { i18n.setLang(want); this.set({}); return this.note(t('言語を {lang} に切り替えました', {lang: want === 'en' ? 'English' : '日本語'})); }
      return this.openMenu({
        title: t('表示言語'), hint: t('UI の表示言語'),
        options: [{value: 'en', label: 'English', desc: t('英語で表示')}, {value: 'ja', label: '日本語', desc: t('日本語で表示')}],
        index: i18n.lang() === 'en' ? 0 : 1, current: i18n.lang(),
        pick: v => { i18n.setLang(v); this.set({}); this.note(t('言語を {lang} に切り替えました', {lang: v === 'en' ? 'English' : '日本語'})); },
      });
    }
    if (cmd === '/mode' || cmd === '/permissions' || cmd === '/perm') {
      // Any case, and the words people use for them (/mode Bypass, /mode auto, /mode readonly).
      const want = arg && modeFrom(arg);
      if (arg && !want) return this.note(t('モードは {modes}', {modes: MODES.join(' / ')}));
      if (want) { this.setMode(want); return this.note(t('承認モード: {label}', {label: t(LABELS[a.mode])})); }
      return this.openMenu({
        title: t('承認モード（権限）'), hint: t('Muse がこの PC で何をするときに確認するか'),
        options: [...MODES.map(m => ({value: m, label: t(LABELS[m]), desc: t(MODE_HELP[m]), danger: m === 'bypass'})),
          ...(a.allowAlways.size ? [{value: '__forget', label: t('記憶した許可を消す'), desc: t('{n} 件: {list}', {n: a.allowAlways.size, list: [...a.allowAlways].map(k => k.replace(/^exec:/, '').replace(/^mcp:/, 'MCP ')).join(' · ').slice(0, 120)})}] : [])],
        index: MODES.indexOf(a.mode), current: a.mode,
        pick: m => {
          if (m === '__forget') { a.allowAlways.clear(); permissions.clearAllow(a.cwd); return this.note(t('このフォルダーで記憶した許可を消しました。')); }
          this.setMode(m); this.note(t('承認モード: {label}（このフォルダーで覚えておきます）', {label: t(LABELS[m])}));
        },
      });
    }
    if (cmd === '/new' || cmd === '/clear') {
      if (this.s.busy) return this.flash(t('作業中は切り替えられません'));
      // The old chat's todo list went into the new chat's first transcript line (only the screen was cleared).
      a.session = sessions.create(a.cwd); a.ctx.readFiles.clear(); a.ctx.todos = []; this.bangNotes = []; // allowAlways belongs to the folder, not the chat
      this.set({todos: []});
      if (cmd === '/clear') return this.set({clearCount: this.s.clearCount + 1, entries: [{id: nextId++, type: 'banner'}]});
      return this.note(t('新しい会話を始めます。'));
    }
    if (cmd === '/resume') {
      // Switching chats under a running turn re-pointed that turn at the other chat (its reply
      // stopped streaming); until a turn can move to the background, wait for it.
      if (this.s.busy) return this.flash(t('作業中は切り替えられません（終わってから、または esc で止めてから）'));
      const list = sessions.recent(a.cwd).filter(s => s.turns).slice(0, 9);
      if (!list.length) return this.note(t('このフォルダーの過去の会話はありません。'));
      if (!arg) return this.openMenu({title: t('会話を再開'), hint: t('このフォルダーの過去の会話'), options: list.map(s => ({value: s.id, label: s.title || s.id, desc: new Date(s.updated).toLocaleString() + ' · ' + t('{n} ターン', {n: s.turns})})),
        pick: id => this.showResumed(sessions.find(id))});
      // A number is a line of the list; an id is looked up among this folder's chats only ("/resume 12"
      // matched any session whose id began with 12, another project's included).
      const s = /^\d$/.test(arg) ? list[Number(arg) - 1] : sessions.recent(a.cwd).find(x => x.id === arg || x.id.startsWith(arg));
      if (!s) return this.note(t('見つかりません: {arg}', {arg}));
      return this.showResumed(s);
    }
    if (cmd === '/mcp') return this.mcpMenu();
    if (cmd === '/bg' || cmd === '/shells') {
      const [sub, id] = arg.split(/\s+/);
      if (sub === 'kill' && id) { try { a.shells.kill(id); return this.note(t('{id} を止めました', {id})); } catch (e) { return this.note(e.message); } }
      const list = a.shells.all();
      if (!list.length) return this.note(t('バックグラウンドの処理はありません。Muse に「開発サーバーを裏で起動して」と頼むか、!npm run dev & のように & を付けて実行します。'));
      return this.openMenu({title: t('バックグラウンドの処理'), hint: t('選ぶと出力を表示 · 止めるのは /bg kill <id>'), options: list.map(x => ({value: x.id, label: x.id + '  ' + x.command.slice(0, 22), desc: (x.running ? t('● 実行中 ') : t('○ 終了 exit {exit} ', {exit: x.exit})) + (x.tail.filter(Boolean).pop() || '')})),
        pick: async id => { const r = await a.shells.output(id, {since: 0, maxChars: 4000}); this.push({type: 'shellout', id, running: r.running, exit: r.exit_code, lines: frames(r.output).trimEnd().split('\n').slice(-30)}); }});
    }
    if (cmd === '/agent' || cmd === '/spawn') {
      const types = a.types();
      if (!arg) return this.note([t('使い方: /agent [型] <任せるタスク>   例: /agent explore 認証まわりの処理はどこ？'), t('型: {list}', {list: Object.entries(types).map(([k, v]) => k + '（' + t(v.description) + '）').join('  ')})]);
      const [, first, task] = /^(\S+)\s*([\s\S]*)$/.exec(arg), typed = types[first.toLowerCase()] && task;
      // A type name alone (/agent explore) started a general agent whose whole task was "explore".
      if (types[first.toLowerCase()] && !task) return this.note(t('使い方: /agent [型] <任せるタスク>   例: /agent explore 認証まわりの処理はどこ？'));
      try { const w = a.spawn(typed ? task : arg, {by: 'user', type: typed ? first : 'general'}); return this.note(t('エージェント {tag}（{type}）に任せました: {title}', {tag: w.tag, type: w.typeName, title: w.title})); }
      catch (e) { return this.note(e.message); }
    }
    if (cmd === '/agents') {
      const list = a.agents();
      if (!list.length) return this.note(t('並列エージェントはまだいません。/agent <タスク> で任せられます。'));
      return this.openMenu({title: t('並列エージェント'), hint: t('選ぶと結果を表示（作業中なら停止）'), options: list.map(x => ({value: x.tag, label: x.tag + ' ' + x.type + '  ' + x.title, desc: ({working: t('作業中 {tool}', {tool: x.lastTool || ''}), done: t('完了'), failed: t('失敗 {error}', {error: x.error}), stopped: t('停止')})[x.state] || x.state})),
        pick: tag => { const x = a.agents().find(y => y.tag === tag); if (x?.state === 'working') { a.stopAgent(tag); this.note(t('{tag} を止めています…', {tag})); } else if (x) this.push({type: 'agent', snap: x, full: true}); }});
    }
    if (cmd === '/image') {
      if (!arg) { this.pasteImage(); return; }
      // ~ is the home folder, as in the tools' paths (/image ~\Pictures\a.png looked in <cwd>\~).
      const given = arg.replace(/^["']|["']$/g, '');
      const p = path.resolve(a.cwd, given === '~' || /^~[\\/]/.test(given) ? path.join(os.homedir(), given.slice(1)) : given);
      if (!clip.isImage(p)) return this.note(t('画像ファイル（png / jpg / gif / webp / bmp）を指定してください'));
      return this.attach(p);
    }
    if (cmd === '/todos') return this.push({type: 'todos', todos: this.s.todos});
    if (cmd === '/skills') return this.skillsMenu();
    if (cmd === '/skill') {
      const [, name, request] = /^(\S*)\s*([\s\S]*)$/.exec(arg);
      const all = skills.load(a.cwd), s = all.find(x => x.name === String(name || '').toLowerCase());
      if (!name || !s) return this.note([t('使い方: /skill <名前> <頼みたいこと>'), t('スキル: {list}', {list: all.filter(x => x.enabled).map(x => x.name).join(', ') || t('（ありません）')})]);
      if (!s.enabled) return this.note(t('{name} はオフです（/skills でオンにできます）', {name: s.name}));
      return this.submit('Use the skill "' + s.name + '" (read it with skill.read first). ' + request);
    }
    if (cmd === '/status') return this.push({type: 'status'});
    // In the user's language: it is their message in the chat, and AGENTS.md came out in Japanese for English users.
    if (cmd === '/init') return this.submit(t('このリポジトリを調べて、AGENTS.md を作ってください（ビルド・テスト方法、構成、規約、注意点を簡潔に）。既にあれば足りないところを更新してください。'));
    this.note(t('知らないコマンド: {cmd}  （/help で一覧）', {cmd}));
  }
}
