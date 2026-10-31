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
const {MODES, LABELS, alwaysKey} = require('../policy.js');
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
const {TOOLS: LOCAL} = require('../tools.js');
const i18n = require('../i18n.js');
const {t} = i18n;

export const COMMANDS = [
  ['/help', 'コマンドとキー操作（!コマンド・@ファイル も）'], ['/permissions', '承認モード（権限）を選ぶ'], ['/mode', '承認モードを選ぶ（/mode bypass で直接）'],
  ['/new', '新しい会話を始める'], ['/clear', '画面を消して新しい会話'], ['/resume', 'このフォルダーの過去の会話を再開'],
  ['/agent', '並列エージェントに任せる（/agent [explore|plan|review|test] <タスク>）'], ['/agents', '並列エージェントの一覧・結果・停止'], ['/bg', 'バックグラウンドの処理（/bg で一覧・出力、/bg kill bg1 で停止）'], ['/mcp', 'MCP サーバーのオン・オフと取り込み'], ['/image', '画像を添付（パスなしでクリップボードから）'], ['/todos', 'Muse の Todo'], ['/status', '接続とセッションの状態'], ['/init', 'AGENTS.md を Muse に書いてもらう'], ['/skills', 'スキルの一覧とオン・オフ（Claude Code / Codex のスキルも読めます）'], ['/skill', 'スキルを使って頼む（/skill <名前> <頼みたいこと>）'], ['/usage', 'Muse の利用状況（週の使用量）と muser の記録'], ['/login', 'muse.ai にログインし直す（Edge の窓が開きます）'], ['/lang', '表示言語を切り替える（English / 日本語）'], ['/update', 'muser を最新版に更新する（npm）'], ['/exit', '終了'],
];

let nextId = 1;
const MAX_QUEUE = 5, MAX_HISTORY = 200;
const HISTORY_FILE = path.join(os.homedir(), '.muser', 'history.json');
function loadHistory() {
  try { const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(h) ? h.filter(x => typeof x === 'string').slice(-MAX_HISTORY) : []; } catch { return []; }
}
function saveHistory(history) {
  try { fs.mkdirSync(path.dirname(HISTORY_FILE), {recursive: true}); fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY))); } catch {}
}

export class Controller {
  constructor({agent, museName, version, onExit}) {
    this.heldSteps = [];
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
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
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
    a.on('tool-output', ({chunk}) => {
      const r = this.s.running; if (!r) return;
      const lines = ((r.rest || '') + stripEmbeds(chunk.replace(/\r/g, ''))).split('\n'), rest = lines.pop();
      this.set({running: {...r, rest, tail: [...r.tail, ...lines.filter(l => l.trim())].slice(-5)}});
    });
    a.on('tool-end', call => { this.set({running: null}); this.push({type: 'tool', call}); });
    a.on('todos', todos => this.set({todos}));
    // Parallel agents: live cards while they work, a result card in scrollback when they finish.
    const upsert = snap => this.set({agents: [...this.s.agents.filter(x => x.tag !== snap.tag), snap].sort((x, y) => x.tag.localeCompare(y.tag, 'en', {numeric: true}))});
    a.on('agent-update', upsert);
    a.on('shell', snap => this.set({shells: [...this.s.shells.filter(x => x.id !== snap.id), snap].sort((x, y) => x.started - y.started)}));
    a.on('agent-done', snap => { upsert(snap); this.push({type: 'agent', snap}); process.stdout.write('\x07'); });
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
      if (this.queue.length) this.submit(this.queue.shift());
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
    const fence = this.md.fence, row = this.md.row(st.partial); this.md.fence = fence;
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
    const word = String(call.params?.command || '').trim().split(/\s+/)[0] || '';
    const options = call.kind === 'mcp'
      ? [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは {tool} を聞かない', {tool: call.mcp.tool}), allow: true, always: alwaysKey('mcp', call.params, call.command)}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}]
      : call.kind === 'edit'
      ? [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは編集を自動に（承認モード「編集は自動」）'), allow: true, autoEdit: true}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}]
      : [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは {word} を聞かない', {word}), allow: true, always: alwaysKey('exec', call.params)}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}];
    const targets = tool.target ? [].concat(tool.target(call.params, this.agent.ctx) || []) : [];
    const outside = targets.some(t => path.relative(this.agent.cwd, t).startsWith('..'));
    process.stdout.write('\x07');
    return new Promise(resolve => {
      const req = {call, preview, options, index: 0, outside, resolve};
      if (this.s.approval || this.s.reasonFor) (this.pending ||= []).push(req);
      else this.set({...(call.agent === 'main' ? {running: null} : {}), approval: req});
    });
  }
  nextApproval() {
    const next = this.pending?.shift();
    if (next) this.set({approval: next});
  }
  answer(i) {
    const a = this.s.approval, o = a.options[i];
    if (!o.allow) return this.set({approval: null, reasonFor: a, text: '', pos: 0});
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
  openMenu(menu) { this.set({menu: {index: 0, ...menu}, text: '', pos: 0}); }
  menuKey(input, k) {
    const m = this.s.menu, n = m.options.length;
    if (k.upArrow) return this.set({menu: {...m, index: (m.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({menu: {...m, index: (m.index + 1) % n}});
    const pick = i => { this.set({menu: null}); m.pick(m.options[i].value); };
    if (/^[1-9]$/.test(input) && Number(input) <= n) return pick(Number(input) - 1);
    if (k.return) return pick(m.index);
    if (k.escape || (k.ctrl && input === 'c')) this.set({menu: null});
  }
  submitReason(text) { const a = this.s.reasonFor; this.set({reasonFor: null}); a.resolve({allow: false, reason: text.trim()}); this.nextApproval(); }
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
    try { const a = clip.attachment(file, temporary); this.set({attachments: [...this.s.attachments, a]}); this.flash(t('画像を添付: {name}', {name: a.name})); }
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
      if (text) return this.setText('');
      if (Date.now() - this.exitArmed < 1500) return this.onExit();
      this.exitArmed = Date.now(); return this.flash(t('もう一度 ctrl+c で終了'));
    }
    if (k.ctrl && input === 'd' && !text) return this.onExit();
    if (k.escape) {
      if (this.s.reasonFor) return this.submitReason('');
      if (this.s.busy) { this.agent.interrupt(); return this.flash(t('中断しています…')); }
      if (text) this.setText('');
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
      if (ctx?.list.length) return this.applyAtPick(ctx.at, ctx.list[this.atIndex(ctx.at.fragment, ctx.list.length)]);
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
        return;
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
    const body = (text || '（画像を見てください）') + (extra.length ? '\n\n' + extra.join('\n\n') : '');
    try { await this.agent.send(body, {attachments, display: text}); }
    catch (e) { if (this.s.busy) { this.set({busy: false}); this.push({type: 'end', ok: false, error: e.message}); } }
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
    this.set({running: {call, tail: []}});
    const onOut = chunk => { const r = this.s.running; if (!r || r.call !== call) return; const lines = chunk.replace(/\r/g, '').split('\n').filter(l => l.trim()); this.set({running: {...r, tail: [...r.tail, ...lines].slice(-5)}}); };
    try {
      const r = await LOCAL['system.run'].run({command: cmd}, this.agent.ctx, undefined, onOut);
      this.set({running: null});
      this.push({type: 'tool', call: {...call, ok: true, view: {...r.view, tail: stripEmbeds(r.payload.stdout + r.payload.stderr).trimEnd().split('\n').slice(-12)}}});
      (this.bangNotes ||= []).push('[The user ran this in the terminal: ' + cmd + ']\nexit ' + r.payload.exit_code + '\n' + stripEmbeds(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : '')).slice(0, 20000));
    } catch (e) { this.set({running: null}); this.push({type: 'tool', call: {...call, ok: false, error: e.message}}); }
  }
  // A resumed chat: its turns from the local transcript (Muse fills in only what is missing),
  // the last ones on screen, and the todo list as it was.
  async showResumed(s, {startup = false} = {}) {
    if (!s) return;
    const a = this.agent;
    if (!startup) { a.session = s; a.ctx.readFiles.clear(); this.set({todos: []}); }
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
    return this.planLoading ??= usage.plan().then(p => { this.set({plan: p}); return p; }).catch(() => null).finally(() => { this.planLoading = null; });
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
    this.updating = true; this.flash(t('muser を更新しています（npm install -g muser-cli@latest）…'), 300000);
    try {
      const r = await update.install();
      this.flash('');
      if (!r.ok) return this.note([t('更新できませんでした:'), ...r.output.split('\n').slice(-6)]);
      let v = ''; try { v = await update.latest(); } catch {}
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
    const [cmd, ...rest] = line.split(/\s+/), arg = rest.join(' '), a = this.agent;
    if (cmd === '/exit' || cmd === '/quit') return this.onExit();
    if (cmd === '/help') return this.push({type: 'help'});
    if (cmd === '/login') return this.login();
    if (cmd === '/update') return this.runUpdate();
    if (cmd === '/usage') {
      this.flash(t('Muse の利用状況を確認しています…'), 20000);
      return this.refreshPlan().then(p => {
        this.flash('');
        this.note([...(p ? usage.formatPlan(p).split('\n') : [t('Muse の利用状況を読み込めませんでした（muse.ai で確認できます）')]), '', ...usage.formatSummary().split('\n')]);
      });
    }
    if (cmd === '/lang') {
      return this.openMenu({
        title: t('表示言語'), hint: t('UI の表示言語'),
        options: [{value: 'en', label: 'English', desc: t('英語で表示')}, {value: 'ja', label: '日本語', desc: t('日本語で表示')}],
        index: i18n.lang() === 'en' ? 0 : 1, current: i18n.lang(),
        pick: v => { i18n.setLang(v); this.set({}); this.note(t('言語を {lang} に切り替えました', {lang: v === 'en' ? 'English' : '日本語'})); },
      });
    }
    if (cmd === '/mode' || cmd === '/permissions' || cmd === '/perm') {
      if (arg && !MODES.includes(arg)) return this.note(t('モードは {modes}', {modes: MODES.join(' / ')}));
      if (arg) { this.setMode(arg); return this.note(t('承認モード: {label}', {label: t(LABELS[a.mode])})); }
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
      a.session = sessions.create(a.cwd); a.ctx.readFiles.clear(); // allowAlways belongs to the folder, not the chat
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
      const s = list[Number(arg) - 1] || sessions.find(arg);
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
        pick: async id => { const r = await a.shells.output(id, {since: 0, maxChars: 4000}); this.push({type: 'shellout', id, running: r.running, exit: r.exit_code, lines: r.output.trimEnd().split('\n').slice(-30)}); }});
    }
    if (cmd === '/agent' || cmd === '/spawn') {
      const types = a.types();
      if (!arg) return this.note([t('使い方: /agent [型] <任せるタスク>   例: /agent explore 認証まわりの処理はどこ？'), t('型: {list}', {list: Object.entries(types).map(([k, v]) => k + '（' + t(v.description) + '）').join('  ')})]);
      const [first, ...words] = arg.split(/\s+/), typed = types[first.toLowerCase()] && words.length;
      try { const w = a.spawn(typed ? words.join(' ') : arg, {by: 'user', type: typed ? first : 'general'}); return this.note(t('エージェント {tag}（{type}）に任せました: {title}', {tag: w.tag, type: w.typeName, title: w.title})); }
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
      const p = path.resolve(a.cwd, arg.replace(/^["']|["']$/g, ''));
      if (!clip.isImage(p)) return this.note(t('画像ファイル（png / jpg / gif / webp / bmp）を指定してください'));
      return this.attach(p);
    }
    if (cmd === '/todos') return this.push({type: 'todos', todos: this.s.todos});
    if (cmd === '/skills') return this.skillsMenu();
    if (cmd === '/skill') {
      const [name, ...rest] = arg.split(/\s+/);
      const all = skills.load(a.cwd), s = all.find(x => x.name === String(name || '').toLowerCase());
      if (!name || !s) return this.note([t('使い方: /skill <名前> <頼みたいこと>'), t('スキル: {list}', {list: all.filter(x => x.enabled).map(x => x.name).join(', ') || t('（ありません）')})]);
      if (!s.enabled) return this.note(t('{name} はオフです（/skills でオンにできます）', {name: s.name}));
      return this.submit('Use the skill "' + s.name + '" (read it with skill.read first). ' + (rest.join(' ') || ''));
    }
    if (cmd === '/status') return this.push({type: 'status'});
    if (cmd === '/init') return this.submit('このリポジトリを調べて、AGENTS.md を作ってください（ビルド・テスト方法、構成、規約、注意点を簡潔に）。既にあれば足りないところを更新してください。');
    this.note(t('知らないコマンド: {cmd}  （/help で一覧）', {cmd}));
  }
}
