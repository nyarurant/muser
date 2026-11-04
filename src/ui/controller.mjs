// UI state for the Ink view: turns agent events into an append-only list of finished entries
// (rendered once into scrollback through <Static>) plus the small live state at the bottom.
// Key handling lives here too, so the view is only drawing.
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMd, tableRows} from './md.mjs';
import {sanitizeEmbeds, stripEmbeds, stripControls, partialEmbedTail} from './sanitize.mjs';
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
const {applyAgentLimits, switchValue, savedValue, setSwitch, envOverride, NUMBERS, numberValue, setNumber, defaultMode, setDefaultMode, QUOTA_FALLBACKS, quotaFallback, setQuotaFallback} = require('../settings.js');
// The weekly-limit question's unanswered choice (/settings), and how long it waits for an answer.
const QUOTA_FALLBACK_LABELS = {auto: '追加購入分がなければ引き継ぐ', extra: 'このまま続ける', handover: '引き継ぐ', ask: '待つ（自動では決めない）'};
const QUOTA_FALLBACK_HELP = {auto: '追加購入分が残っていればこのまま続け、なければ一番軽いアカウントへ引き継ぐ', extra: '追加購入分を使って今のアカウントで続ける', handover: '追加購入分があっても、一番軽いアカウントへ引き継ぐ', ask: '答えるまで何もしない（追加購入分があれば作業はそのまま進む）'};
const QUOTA_WAIT_MS = 60000;
// A turn that ended without finishing on its own: failed (not stopped by the user).
function turnFailed(e) { return !!e && !e.ok && !e.aborted; }
const {c, frames} = require('../tui/term.js');
const {TOOLS: LOCAL} = require('../tools.js');
const i18n = require('../i18n.js');
const {t} = i18n;

export const COMMANDS = [
  ['/focus', '完了条件と根拠を確認（自動で有効。/focus off・on で切替）'],
  ['/settings', '設定（エージェント・Focus・ツール上限・承認モード・言語・ベル・更新確認・表示・スキル・MCP）'], ['/goal', '常設ゴールを設定（達成まで自動で続行。/goal で表示、/goal clear で解除）'],
  ['/help', 'コマンドとキー操作（!コマンド・@ファイル も）'], ['/permissions', '承認モード（権限）を選ぶ（/permissions bypass で直接）'],
  ['/new', '新しい会話を始める'], ['/clear', '画面を消して新しい会話'], ['/resume', 'このフォルダーの過去の会話を再開'],
  ['/agent', '並列エージェントに任せる（/agent [explore|plan|review|test] <タスク>）'], ['/agents', '並列エージェントの一覧・結果・停止'], ['/bg', 'バックグラウンドの処理（/bg で一覧・出力、/bg kill bg1 で停止）'], ['/mcp', 'MCP サーバーのオン・オフと取り込み'], ['/image', '画像を添付（パスなしでクリップボードから）'], ['/todos', 'Muse の Todo'], ['/status', '接続とセッションの状態'], ['/init', 'AGENTS.md を Muse に書いてもらう'], ['/skills', 'スキルを管理する（一覧とオン・オフ。使うのは /skill）'], ['/skill', 'スキルを指定して頼む（/skill <名前> <頼みたいこと>。管理は /skills）'], ['/usage', 'Muse の利用状況（週の使用量）と muser の記録'], ['/login', 'muse.ai にログインし直す（Edge の窓が開きます）'], ['/account', 'アカウントの確認と切替・追加（/account <名前> で切替、なしで一覧、/account add で追加）'], ['/lang', '表示言語を切り替える（English / 日本語）'], ['/update', 'muser を最新版に更新する（npm）'], ['/reload', '新しいコードで再起動（会話は引き継ぎ）'], ['/output', 'PC 操作の出力を全文で見る（画面では一部だけ）'], ['/exit', '終了'],
];

let nextId = 1;
const ATTACH_TOTAL = 11 * 1024 * 1024; // images per message, before base64 (the device link takes ~16 MB)
// The terminal bell on approvals and finished agents; off with MUSER_NO_BELL=1 or "bell": false in ~/.muser/config.json.
// Asked each time: /settings can turn it off while muser runs.
const bell = () => { let on = true; try { on = switchValue('bell'); } catch {} if (on) process.stdout.write('\x07'); };
const MAX_QUEUE = 5, MAX_HISTORY = 200, BANG_NOTE = 20000; // characters of a !command's output sent to Muse
const HISTORY_FILE = process.env.MUSER_HISTORY_FILE || path.join(os.homedir(), '.muser', 'history.json'); // tests point it elsewhere
// The most text the composer (or the picker's editor) will hold (deep c1 #11):
// the queue and the attachments are capped, but the draft was not — a multi-
// megabyte paste went in whole and every keystroke then re-rendered it. Past
// the cap, typing and pasting simply stop growing the text (paste says so).
const MAX_INPUT = 1000000;
function loadHistory() { return readHistoryDisk() || []; }
// The history on disk, or null when the file is there but could not be read or
// parsed: a read failure is not an empty history, and saving over it would
// replace everything with the newest entry alone (fifth audit f1-3, the
// read-side twin of the lost update below).
function readHistoryDisk() {
  try { const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(h) ? h.filter(x => typeof x === 'string').slice(-MAX_HISTORY) : []; }
  catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
}
// A short cross-window lock for the read-modify-write below (deep c1 #13):
// two windows saving at the same moment each merged from the same stale copy,
// and the later rename erased the earlier window's entry. The lock is a file
// created exclusively; a holder lives for milliseconds, so a lock older than
// 10 s is a crash leftover and is broken. When no lock can be had within a
// second the save still goes ahead unlocked (the old behaviour) rather than
// losing the entry outright.
function acquireHistoryLock() {
  const lock = HISTORY_FILE + '.lock';
  try { fs.mkdirSync(path.dirname(HISTORY_FILE), {recursive: true}); } catch { return null; }
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() >= deadline) return null;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch { return null; }
    }
  }
}
// Appends to what is on disk now: every muser window wrote back its own copy from startup, so the
// last window to send a message erased what was typed in the others.
function saveHistory(history) {
  const release = acquireHistoryLock();
  try {
    const text = history[history.length - 1], disk = readHistoryDisk();
    if (disk === null) return; // unreadable right now: never overwrite it with just the newest entry
    if (typeof text === 'string' && disk[disk.length - 1] !== text) disk.push(text);
    fs.mkdirSync(path.dirname(HISTORY_FILE), {recursive: true});
    const temp = HISTORY_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(disk.slice(-MAX_HISTORY))); fs.renameSync(temp, HISTORY_FILE);
  } catch {}
  finally { try { release?.(); } catch {} }
}

// Editing steps by grapheme cluster, not code point (recovery scan): one
// Backspace at the end of 👨‍👩‍👧 used to leave a dangling ZWJ, and the caret could
// sit inside a cluster. Falls back to code points where Intl.Segmenter is absent.
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
function lastClusterLen(s) { if (!graphemeSegmenter) return [...s].pop()?.length || 0; let n = 0; for (const g of graphemeSegmenter.segment(s)) n = g.segment.length; return n; }
function firstClusterLen(s) { if (!graphemeSegmenter) return [...s][0]?.length || 0; for (const g of graphemeSegmenter.segment(s)) return g.segment.length; return 0; }
// Column math for vertical movement, in the same grapheme units (fifth f4-1):
// a column counted in clusters, and the UTF-16 offset that many clusters into
// a line (clamped to the line's end). Falls back to code points, like above.
function clusterCount(s) { if (!graphemeSegmenter) return [...s].length; let n = 0; for (const g of graphemeSegmenter.segment(s)) n++; return n; }
function offsetAtClusterCol(s, col) { if (!graphemeSegmenter) return [...s].slice(0, col).join('').length; let n = 0, off = 0; for (const g of graphemeSegmenter.segment(s)) { if (n >= col) break; off += g.segment.length; n++; } return off; }

export class Controller {
  constructor({agent, museName, version, onExit, onReload}) {
    this.heldSteps = []; this.outputs = [];
    this.agent = agent; this.museName = museName; this.version = version; this.onExit = onExit; this.onReload = onReload;
    this.listeners = new Set();
    this.s = {
      entries: [{id: nextId++, type: 'banner'}],
      stream: null, running: null, busy: false, turnStart: 0, status: '', activity: '', museRunning: '',
      approval: null, reasonFor: null, promptFor: null, question: null, addFlow: null, todos: [], flash: '', deviceOk: !!agent.device?.connected,
      account: agent.accountLabel ? {id: agent.accountId, label: agent.accountLabel} : null, accountReserved: null, goal: agent.standingGoal?.() || null,
      text: '', pos: 0, mode: agent.mode, clearCount: 0, attachments: [], agents: [], shells: [], queue: [],
    };
    // exitArmed is per-key (recovery scan): ctrl+c arming must not make one ctrl+d an exit.
    this.history = loadHistory(); this.hIndex = -1; this.draft = ''; this.exitArmed = {key: null, at: 0}; this.queue = []; this.tabState = null; this.md = null; this.atPick = {key: null, idx: 0}; this.slashPick = {key: null, idx: 0}; this.dollarPick = {key: null, idx: 0}; this.dollarDismissed = null; this._skillCache = null;
    this.accountSwitchReservation = null; this.quotaWarnedFor = new Map(); this.quotaKeep = new Map(); this.quotaWaitMs = QUOTA_WAIT_MS; this.quotaTimer = null; this.lastTurnEnd = null; this.questionShownFor = '';
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
      // #169: recovery also retires the login offer — clearing loginNeeded alone left the
      // menu up, inviting an Edge login nobody needs any more.
      else if (c.state === 'connected') { this.flash(c.first ? '' : t('Muse に再接続しました')); if (this.s.loginNeeded) this.set({loginNeeded: false}); if (this.s.menu?.loginOffer) this.set({menu: null}); }
      else if (c.state === 'auth') {
        // Once per lapse (the background connect and a send both report it): offer to log in here.
        this.flash('');
        if (this.s.loginNeeded) return;
        this.set({loginNeeded: true});
        this.openMenu({loginOffer: true, title: t('muse.ai のログインが切れています'),
          options: [{value: 'login', label: t('ログインし直す'), desc: t('Edge の窓が開きます。ログインすると、そのまま接続します')}, {value: 'later', label: t('あとで'), desc: t('/login でいつでも')}],
          index: 0, pick: v => { if (v === 'login') this.login(); }});
      }
      else this.flash(t('再接続できませんでした（自動で再試行します）: {error}', {error: c.error}), 10000);
    });
    a.on('text', e => this.onText(e));
    // Muse's own spinner word (spinner.set): main's for the working line, an agent's for its card.
    a.on('spinner', ({agent, word}) => agent === 'main' || !agent ? this.set({spinnerWord: word}) : this.set({agentWords: {...this.s.agentWords, [agent]: word}}));
    // A progress report must NOT flush the stream: it is a side channel that does
    // not end Muse's message, and endMessage finalizes it — the next text delta
    // for the same message then started a fresh stream at offset 0 and re-emitted
    // everything, printing the whole reply twice (audit #172). The note simply
    // takes its chronological place among the entries; the stream flows on.
    a.on('progress', report => { this.push({type: 'progress', ...report}); });
    a.on('focus', focus => this.set({focus}));
    a.on('goal', e => { this.set({goal: e.goal || null}); if (e.achieved) this.note(t('ゴールを達成しました: {goal}', {goal: e.achieved})); else if (e.capped) this.note(t('Goal の自動続行が上限（{max} leg）に達したので止まります。続きはメッセージを送ると再開します。', {max: require('../agent.js').GOAL_MAX_LEGS})); });
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
      // The \r collapse runs on the raw chunk BEFORE sanitising: stripEmbeds removes \r as a
      // control character, which glued every frame of a meter into one line (the #184 control
      // stripping broke this; the collapsed frame is what gets sanitised for display instead).
      const lines = ((r.rest || '') + String(chunk ?? '')).split('\n'), last = lines.pop();
      const rest = last.slice(last.replace(/\r+$/, '').lastIndexOf('\r') + 1); // only the latest frame is kept
      this.set({running: {...r, rest, now: stripEmbeds(frames(rest)), tail: [...r.tail, ...lines.map(l => stripEmbeds(frames(l))).filter(l => l.trim())].slice(-5)}});
    });
    // The full output stays here (the last 30), not in scrollback entries; the screen shows a tail.
    a.on('tool-end', ({output, ...call}) => {
      this.set({running: null});
      mention.invalidate?.(this.agent.cwd); // the call may have created / changed files: @ completion refreshes
      // Edit calls carry their diff in view, not in output: without it the rows the screen cut
      // (Diff shows at most 30) were nowhere in the /output entry either.
      let full = String(output || '');
      const dv = call.view || {};
      const renderDiff = diff => (diff || []).map(d => d.t === '…' ? '⋮' : (d.t === '+' ? '+ ' : d.t === '-' ? '- ' : '  ') + (d.l || '')).join('\n');
      const diffParts = Array.isArray(dv.files) ? dv.files.map(f => (f.path || '') + '\n' + renderDiff(f.diff)) : Array.isArray(dv.diff) ? [renderDiff(dv.diff)] : [];
      if (diffParts.length && diffParts.join('').trim()) full = (full ? full + '\n' : '') + diffParts.join('\n');
      this.push({type: 'tool', call: {...call, outputLines: this.keepOutput(call, full)}});
    });
    // Near the weekly limit (90%+), the plan is read again after every tool call of any agent,
    // so the limit is met mid-task instead of only at the turn's end (see watchQuota).
    a.on('tool-end', () => this.watchQuota());
    a.on('agent-tool', () => this.watchQuota());
    a.on('todos', todos => this.set({todos}));
    // Parallel agents: live cards while they work, a result card in scrollback when they finish.
    // #182: finished agents/shells (and their spinner words) were kept for the window's
    // whole life. The view only shows a finished card for 8 s after it ends, so state older
    // than that is pruned on every new event; results live on in scrollback and /output.
    const fresh = x => x.state === 'working' || x.running || !x.ended || Date.now() - x.ended < 8000;
    const upsert = snap => { const agents = [...this.s.agents.filter(x => x.tag !== snap.tag), snap].filter(fresh).sort((x, y) => x.tag.localeCompare(y.tag, 'en', {numeric: true})); const words = {...(this.s.agentWords || {})}; for (const tag of Object.keys(words)) if (!agents.some(x => x.tag === tag)) delete words[tag]; this.set({agents, agentWords: words}); };
    a.on('agent-update', upsert);
    a.on('shell', snap => this.set({shells: [...this.s.shells.filter(x => x.id !== snap.id), snap].filter(fresh).sort((x, y) => x.started - y.started)}));
    a.on('agent-done', snap => {
      upsert(snap);
      // Results over the card's 200-line full view were unreachable: keep the whole result for /output too.
      const body = String(snap.state === 'done' ? snap.result || '' : snap.error || '');
      if (body.trim()) this.keepOutput({id: 'agent-' + snap.tag + '-' + (snap.ended || Date.now()), command: 'agent.spawn', summary: snap.tag + ' ' + (snap.title || '')}, body);
      this.push({type: 'agent', snap}); bell();
    });
    // #167: sawText is per-turn state. Resetting it only in submit() left auto-continued
    // legs and turns driven from other surfaces judged by the PREVIOUS turn's flag, so a
    // reply that never streamed was never shown by the turn-end safety net either.
    a.on('turn-start', () => { this.sawText = false; this.resumeEpoch = (this.resumeEpoch || 0) + 1; this.planAtTurn = this.s.plan?.percentUsed ?? null; });
    // An account switch (automatic failover or /account): the plan on screen belonged to the
    // old account, and the new account's Muse may carry another name.
    a.on('account', ev => {
      usage.resetWeb?.();
      // Any switch satisfies a pending reservation, whichever account it landed on.
      this.accountSwitchReservation = null;
      // #159: a quota question (and its unattended fallback timer) belongs to the account
      // that hit the limit. Left open across a switch, its timer/keep would decide for the
      // OLD account on the new account's screen.
      clearTimeout(this.quotaTimer); this.quotaTimer = null;
      if (this.s.menu?.quotaChoice) this.set({menu: null});
      this.set({account: {id: ev.id, label: ev.label}, plan: null, accountReserved: null});
      // A switch the agent started itself (failover) has no handoff yet: build it from
      // the session it just left, so the new account's Muse still gets the context.
      if (!a.pendingHandoff && ev.fromSession) {
        // The session as saved (its title too: the note named no session after a failover).
        let from = null; try { from = sessions.find(ev.fromSession); } catch {}
        try { a.pendingHandoff = this.buildAccountHandoff({label: ev.label}, from || {id: ev.fromSession, title: ''}, require('../accounts.js').get(ev.from)?.label || ev.from || '') || undefined; } catch {}
      }
      this.note(t('アカウントを {label} に切り替えました。Muse 側の会話は新しいチャットから始まります。', {label: ev.label}));
      this.refreshPlan();
      // The name last seen for this account until /identity answers (the old account's Muse
      // stayed on screen), and the answer is remembered for this account's next window.
      try { const known = require('../accounts.js').museName(ev.id); if (known !== 'Muse' && known !== this.museName) { this.museName = known; this.set({}); } } catch {}
      // deep c1 #8: the answer is remembered for ev.id either way, but it only
      // goes on screen while that account is still the current one — a slow
      // answer for the account just left used to rename the one just arrived.
      Promise.resolve(a.client?.request?.('GET', '/identity')).then(r => { const n = typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : null; if (n) { try { require('../accounts.js').rememberMuseName(ev.id, n); } catch {} } if (n && a.accountId === ev.id && n !== this.museName) { this.museName = n; this.set({}); } }).catch(() => {});
    });
    // A background shell that ends starts the work again on its own (see onShellFinished).
    a.shells?.on?.('finished', s => this.onShellFinished(s));
    // A message sent mid-turn reached Muse inside a tool result: it leaves the queue, so the
    // turn's end does not send it a second time.
    a.on('steer', ({texts} = {}) => {
      for (const tx of texts || []) { const i = this.queue.indexOf(tx); if (i >= 0) this.queue.splice(i, 1); }
      // Delivered: Muse has it and answers it inside the work, so Focus goes on. Only messages
      // still waiting in the queue stop the task after this round (2026-11-03: a clarification
      // Muse had already answered ended the turn as "a new user message is queued").
      this.agent.focusInputPending = this.queue.length > 0;
      this.set({queue: [...this.queue]});
      this.note(t('作業中の Muse に伝えました'));
    });
    a.on('turn-end', e => {
      this.lastTurnEnd = e; // an automatic handover resumes a turn that failed (askQuotaChoice)
      this.set({activity: '', museRunning: '', spinnerWord: null});
      this.flushStream();
      // Safety net: if no text streamed this turn, show the final reply that the turn ended with.
      if (e.ok && !this.sawText && e.text?.trim()) {
        const md = createMd();
        this.push({type: 'md', rows: md.rows(sanitizeEmbeds(e.text.trimEnd()).split('\n')), first: true}, {type: 'gap'});
      }
      this.set({busy: false});
      if (e.sources?.length) this.push({type: 'sources', items: e.sources});
      // The compact Focus line goes before the end line, so the turn closes with the small ✻
      // footer and the reply text stays the last substantial block on screen.
      if (e.focus) this.push({type: 'focus', focus: e.focus});
      this.push({type: 'end', ...e});
      // A selectable question the turn ended on (focus.ask_user with options): open the
      // picker over the input. The key keeps a duplicate turn-end for the same ask from
      // reopening a picker the user already closed — closing it loses nothing, the
      // question stays in the Focus state and a typed reply still resumes the task.
      if (e.focus?.status === 'needs_input' && e.focus.ask && !this.s.question) {
        const askKey = e.focus.id + ':' + e.focus.round + ':' + e.focus.revision;
        if (this.questionShownFor !== askKey) { this.questionShownFor = askKey; this.openQuestion(e.focus.ask); }
      }
      // Local tally heads-up: today's turns reached the daily limit (if one is set).
      try { const lim = usage.limits(); if (e.ok && lim.dailyTurns > 0 && !this.usageWarned && usage.summary().today.turns >= lim.dailyTurns) { this.usageWarned = true; this.note(t('今日のターン上限（{n}）に達しました', {n: lim.dailyTurns})); } } catch {}
      // The real weekly usage, refreshed after every turn; say how much this turn moved it.
      const before = this.planAtTurn;
      const accountAtEnd = this.agent.accountId;
      this.refreshPlan().then(p => {
        if (p && before !== null && before !== undefined && p.percentUsed > before) this.note(t('Muse の週の使用量 {before}% → {after}%（この作業で +{diff}%）', {before, after: p.percentUsed, diff: p.percentUsed - before}));
        if (p) this.maybeWarnAccountQuota(p, accountAtEnd);
        // A switch the user reserved for this turn boundary runs first (below); quota
        // failover does not override the user's own pick. And if a switch already
        // happened since this turn ended, this plan is the OLD account's: acting on
        // it could switch a second time, away from the account just moved to.
        if (this.accountSwitchReservation) return;
        if (this.agent.accountId !== accountAtEnd) return;
        // The weekly limit reached: the user chooses (askQuotaChoice) — go on with the
        // purchased extra on this account, or hand the work over to another account. It
        // used to switch on its own, into a fresh chat, even with extra usage bought.
        if (p && this.agent.accountPool) {
          // #157: this callback is async — a queued message may already have started the
          // next turn, or the user may be typing. Asking then with turn-end semantics let
          // an Enter meant for the composer pick "keep/switch" instead. Downgrade to the
          // mid-turn guards in that case; the question is deferred, not lost.
          try { if (require('../accounts.js').exhausted({percentUsed: p.percentUsed, quotaStatus: p.quotaStatus})) this.askQuotaChoice(p, accountAtEnd, {midTurn: !!(this.s.busy || this.s.text)}); } catch {}
        }
      });
      // The task this marker was for has ended: left set, it stopped the next automatic send
      // (a finished !command or background shell) after one round as "a user message is queued".
      if (!this.queue.length) this.agent.focusInputPending = false;
      // What normally happens right away at a turn's end (queued messages, finished
      // !commands and shells). A reserved account switch runs BEFORE this: the queued
      // message then starts the new account's chat, with the handoff attached.
      const continueTurn = () => {
        // After esc (an interrupted turn) the queued messages go back into the input instead of being
        // sent: the user stopped the work, and the next queued task started right away regardless.
        if (this.queue.length && e.aborted) {
          const n = this.queue.length, back = this.queue.splice(0).join('\n'), cur = this.s.text;
          this.agent.clearSteer?.();
          this.agent.focusInputPending = false;
          this.set({queue: []});
          this.setText(cur ? back + '\n' + cur : back);
          this.flash(t('待っていた {n} 件を入力欄に戻しました', {n}), 5000);
        } else if (this.queue.length && !this.s.question) { const next = this.queue.shift(); this.agent.dropSteer?.(next); this.agent.focusInputPending = this.queue.length > 0; this.set({queue: [...this.queue]}); this.submit(next); }
        // A !command that finished during the turn: its output now (after esc it waits for the next message).
        else if (this.bangPending && !e.aborted) this.sendBangNotes();
        // A background shell that finished during the turn: the work resumes now, the same way.
        else if (this.shellPending && !e.aborted) this.sendShellNotes();
        if (e.aborted) { this.bangPending = false; this.shellPending = false; }
      };
      if (this.accountSwitchReservation && e.aborted) {
        // The user stopped the work: a switch reserved for its end is cancelled, not run.
        const r = this.accountSwitchReservation;
        this.clearAccountReservation();
        this.note(t('アカウント切替の予約を取り消しました（{label}）', {label: r.label}));
        continueTurn();
      } else if (this.accountSwitchReservation) {
        // A handover made automatically (nobody answered the limit question) picks the work up
        // on the new account when the turn that just ended failed — unattended, nobody else would.
        this.executeAccountReservation().then(r => { if (r?.resume && !this.queue.length) this.resumeAfterHandover(); else continueTurn(); }, continueTurn);
      } else continueTurn();
    });
  }
  onText({id, text}) {
    this.sawText = true;
    let st = this.s.stream;
    if (st && st.id !== id) { this.endMessage(st.id); st = null; }
    if (!st) { this.md = createMd(); st = {id, done: 0, partial: '', started: false, emitted: '', raw: '', clean: ''}; }
    // An embed token may be split across deltas: hold back a trailing unfinished `[[...`
    // fragment until it resolves; past the legal token size it is treated as literal text
    // (the hold-back limit lives in sanitize.mjs, audit #181).
    const held = partialEmbedTail(text);
    // #173: re-sanitizing the CUMULATIVE text on every delta is O(n²) over a reply.
    // Fast path: a plain append (no '[', no control characters, the previous text not
    // ending inside a token / bare-token line) sanitizes to previous-clean + delta, by
    // construction a prefix extension — so the revision check below cannot fire either.
    const prevTail = st.raw ? st.raw.split('\n').pop() : '';
    const delta = st.raw != null && st.clean != null && text.startsWith(st.raw) ? text.slice(st.raw.length) : null;
    // deep c1 #12: the tail checks only cover the line the delta CONTINUES. A
    // bare-token line that starts inside the delta itself is one sanitizeEmbeds
    // would replace, so the fast path must not take it either. The first delta
    // line is checked joined with prevTail, which is the line it completes.
    const bareInDelta = delta !== null && delta.split('\n').some((l, i) => /^\s*(?:(?:widget|letter)-[0-9a-fA-F-]{8,}|embed_token\b)/.test(i === 0 ? prevTail + l : l));
    const fast = delta !== null && !held && !bareInDelta && !/[\[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(delta) && !partialEmbedTail(st.raw, 1000000) && !/(?:widget|letter)-[0-9a-fA-F-]{8,}$/.test(prevTail) && !prevTail.includes('embed_token');
    const clean = fast ? st.clean + delta : sanitizeEmbeds(held ? text.slice(0, text.length - held.length) : text);
    // Revision check: the new text must extend exactly the prefix already emitted to scrollback.
    // (The old check compared the text against its own slice, so it could never fire.) Scrollback
    // is append-only (<Static>), so a rewrite cannot be edited in place: mark it and re-emit the
    // revised text below the marker.
    if (!fast && (clean.length < st.done || clean.slice(0, st.done) !== st.emitted)) {
      if (st.done > 0 || st.started) this.push({type: 'note', lines: [t('（Muse が返信を書き直しました — 以下が新しい内容です）')]});
      this.md = createMd();
      st = {id, done: 0, partial: '', started: false, emitted: '', raw: '', clean: ''};
    }
    const rest = clean.slice(st.done), nl = rest.lastIndexOf('\n');
    let started = st.started, done = st.done;
    if (nl >= 0) {
      // Table lines are held by the renderer until the table ends (shown meanwhile in the live
      // area, via stream.table), so a chunk can complete lines and still print nothing yet.
      const rows = this.md.feed(rest.slice(0, nl).split('\n'));
      if (rows.length) { this.push({type: 'md', rows, first: !started}); started = true; }
      done += nl + 1;
    }
    this.set({stream: {id, done, started, partial: clean.slice(done), emitted: clean.slice(0, done), raw: text, clean, table: [...this.md.pending]}});
  }
  // Preview of the unfinished line; must not move the fence state of the real render.
  previewRow() {
    const st = this.s.stream; if (!st?.partial && !st?.table?.length) return null;
    // deep Part B R4-9: a stream state set without onText (a snapshot, a future
    // producer) has no md yet; remote-controller guards this, the original did not.
    this.md ||= createMd();
    // Only the tail of an unfinished line that would not fit the screen: a 60,000-character line
    // (minified JSON) streamed as thousands of rows redrawn on every delta. Cut before Markdown
    // styling, so no escape sequence is split. The whole line is kept once it ends.
    const room = (process.stdout.columns || 100) * Math.max(3, (process.stdout.rows || 30) - 16);
    const shown = st.partial.length > room ? '…' + st.partial.slice(-room) : st.partial;
    // The unfinished next row of a held table shows once it is whole (in the table, aligned).
    const fence = this.md.fence, row = shown && !(st.table?.length && /^\s*\|/.test(shown)) ? this.md.row(shown) : null; this.md.fence = fence;
    return {row, first: !st.started, table: st.table?.length ? tableRows(st.table) : []};
  }
  flushStream() { if (this.s.stream) this.endMessage(this.s.stream.id); }
  endMessage(id) {
    const st = this.s.stream; if (!st || st.id !== id) return;
    // Flush from the raw text so a fragment held back mid-token resolves here (sanitize turns an
    // unfinished trailing token into the placeholder instead of leaking `[[hatch_...`).
    const tail = st.raw != null ? sanitizeEmbeds(st.raw).slice(st.done) : st.partial;
    const rows = [...(tail ? this.md.feed(tail.split('\n')) : []), ...this.md.flush()];
    if (rows.length) this.push({type: 'md', rows, first: !st.started});
    this.push({type: 'gap'});
    this.set({stream: null});
    for (const step of this.heldSteps.splice(0)) this.push({type: 'muse', step});
  }
  ask(call) {
    const tool = TOOLS[call.command];
    let preview = null;
    if (call.demoPreview) preview = call.demoPreview;
    // MCP calls (mcp.<server>.<tool>) have no TOOLS entry: reading .preview off
    // undefined threw synchronously, the approval never opened and write MCP
    // tools were unusable in default mode (fourth audit H4). Their preview is
    // built by the view from the call itself (server / tool / params, as the
    // agent provides them in call.mcp), so preview stays null here; a missing
    // call.mcp is derived from the command name so the view can name both.
    else if (tool?.preview) { try { preview = tool.preview(call.params, this.agent.ctx); } catch (e) { preview = {error: e.message}; } }
    if (call.kind === 'mcp' && !call.mcp) { const parts = String(call.command || '').split('.'); call = {...call, mcp: {server: parts[1] || '', tool: parts.slice(2).join('.') || parts[1] || ''}}; }
    // Commands with shell syntax, or programs that run anything (powershell, node …), get no
    // "don't ask again": a remembered key must not cover more than the user saw (src/policy.js).
    const key = call.kind === 'exec' ? alwaysKey('exec', call.params) : null, word = key ? key.slice('exec:'.length) : '';
    const options = call.kind === 'mcp'
      ? [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは {tool} を聞かない', {tool: call.mcp.tool}), allow: true, always: alwaysKey('mcp', call.params, call.command)}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}]
      : call.kind === 'edit'
      ? [{label: t('はい'), allow: true}, {label: t('はい、このフォルダーでは編集を自動に（承認モード「編集は自動」）'), allow: true, autoEdit: true}, {label: t('いいえ（Muse に伝えることを入力）'), allow: false}]
      : [{label: t('はい'), allow: true}, ...(key ? [{label: t('はい、このフォルダーでは {word} を聞かない', {word}), allow: true, always: key}] : []), {label: t('いいえ（Muse に伝えることを入力）'), allow: false}];
    // #168: a throwing target()/realOf() (a dangling path, an odd param shape) escaped as a
    // SYNCHRONOUS exception instead of an approval promise — no approval UI, the call broke
    // or hung. A target that cannot be judged is treated as OUTSIDE (the approval shows the
    // outside-folder warning; the call itself still goes through the normal policy checks).
    let outside = false;
    try {
      const targets = tool?.target ? [].concat(tool.target(call.params, this.agent.ctx) || []) : [];
      // As muser itself judges it (agent.execute): where the path really leads. startsWith('..') missed
      // another drive (D:\ from C:\ is not "..") and writes through a junction.
      const {inside, realOf} = require('../tools.js'), realCwd = realOf(this.agent.cwd);
      outside = targets.some(t => !inside(realCwd, realOf(t)));
    } catch { outside = true; }
    // An approval landing over a menu freezes that menu (fifth f4-2): its
    // buffered digit and timer die here, instead of picking a menu item
    // behind the approval.
    this.menuBuf = ''; clearTimeout(this.menuTimer);
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
    this.openMenu({title: t('MCP サーバー'), options: options.map(o => ({...o, mark: o.current ? true : false})), pick: v => this.mcpPick(v)});
  }
  async mcpPick(v) {
    const a = this.agent;
    if (!this.agent.mcp && !v.import) return this.note(t('このモードでは MCP を使えません。'));
    if (v.import) { mcpConfig.importServers(mcpConfig.discover()); this.note(t('取り込みました（すべてオフ）。')); return this.mcpMenu(); }
    if (this.s.busy) return this.flash(t('作業中は切り替えられません'));
    const cfg = mcpConfig.setEnabled(v.toggle, v.on), s = cfg.mcpServers[v.toggle];
    try {
      if (v.on) { this.flash(t('{name} に接続しています…', {name: v.toggle}), 15000); await a.mcp.connect(v.toggle, s); }
      else await a.mcp.disconnect(v.toggle);
      a.mcp.index(); await a.reconnectDevice();
      const live = a.mcp.servers.get(v.toggle);
      this.flash('');
      this.note(v.on ? t('{name}: {n} ツールを Muse に渡しました', {name: v.toggle, n: live.tools.length}) : t('{name} をオフにしました', {name: v.toggle}));
    } catch (e) { this.flash(''); this.note(v.toggle + ': ' + e.message, 'error'); try { a.mcp.index(); await a.reconnectDevice(); } catch {} }
  }
  // A pick-one menu in place of the input box (/permissions, /resume).
  // The draft stays: a menu can open by itself (the re-login offer) while the user is typing, and a
  // slash command was already taken out of the input when it was sent.
  openMenu(menu) {
    // #156: the single menu slot was overwritten unconditionally, and a displaced menu's
    // cancel() never ran. For promise-backed menus (menuPromise: account add confirm/pick)
    // that promise then never settled — addingAccount stayed set and every send was
    // blocked until a restart. Cancel the displaced menu (and its buffered digit) first.
    const old = this.s.menu;
    this.menuBuf = ''; clearTimeout(this.menuTimer);
    if (old && old !== menu) { try { old.cancel?.(); } catch {} }
    this.set({menu: {index: 0, ...menu}});
  }
  // /settings: every setting in one place, each with its current value. The on/off ones switch here
  // and are saved in ~/.muser/config.json; the rest open their own menus (/lang, /mode, /skills, /mcp).
  settingsMenu(index = 0) {
    const a = this.agent, demo = a.client?.status === 'demo';
    const count = n => n === 0 ? t('無制限') : String(n);
    const limits = a.agentLimits || {concurrent: 4, perTurn: 0};
    const onOff = v => v ? t('オン') : t('オフ');
    // A switch that an environment variable decides says so: changing it here would not show.
    const sw = (name, value = switchValue(name)) => onOff(value) + (envOverride(name) ? '  ' + t('（環境変数 {name} が優先・保存した値は{saved}）', {name: envOverride(name), saved: onOff(savedValue(name))}) : '');
    const enabledSkills = (() => { try { return skills.load(a.cwd).filter(x => x.enabled).length; } catch { return 0; } })();
    const mcpOn = (() => { try { return Object.values(mcpConfig.load().mcpServers || {}).filter(x => x.enabled).length; } catch { return 0; } })();
    const num = (name, show = String) => show(numberValue(name)) + (envOverride(name) ? '  ' + t('（環境変数 {name} が優先）', {name: envOverride(name)}) : '');
    const nextStart = name => sw(name) + '  ' + t('（次回起動から）');
    // The rows are grouped by genre; the menu shows a header where the group
    // changes (src/ui/view.mjs). Grouping is display only: each row keeps its
    // value, and picking / numbering work exactly as before.
    const G = {work: t('作業の進め方'), limits: t('上限と使用量'), approvals: t('承認'), display: t('表示'), notify: t('通知と更新'), link: t('連携')};
    const options = [
      {value: 'agents', group: G.work, label: t('エージェント上限'), desc: t('同時 {concurrent} ／ タスク合計 {perTurn}', {concurrent: count(limits.concurrent), perTurn: count(limits.perTurn)})},
      {value: 'focus', group: G.work, label: t('Focus（完了条件の自動管理）'), desc: onOff(a.focusEnabled !== false)},
      {value: 'focusRounds', group: G.work, label: t('Focus の自動続行の回数'), desc: num('focusRounds')},
      {value: 'focusMinutes', group: G.work, label: t('Focus の自動続行の時間'), desc: num('focusMinutes', n => t('{n} 分', {n}))},
      {value: 'bangAutoSend', group: G.work, label: t('! の結果を Muse に送る'), desc: sw('bangAutoSend')},
      {value: 'bgAutoResume', group: G.work, label: t('バックグラウンド完了で自動再開'), desc: sw('bgAutoResume')},
      {value: 'maxToolCallsPerTurn', group: G.limits, label: t('1ターンのツール呼び出し上限'), desc: num('maxToolCallsPerTurn', n => t('{n} 回', {n}))},
      {value: 'dailyTurnLimit', group: G.limits, label: t('1日のターン数の警告'), desc: num('dailyTurnLimit', n => n ? t('{n} ターン', {n}) : t('オフ'))},
      {value: 'quotaFallback', group: G.limits, label: t('週の上限で応答がないとき'), desc: t(QUOTA_FALLBACK_LABELS[quotaFallback()])},
      {value: 'mode', group: G.approvals, label: t('承認モード（このフォルダー）'), desc: t(LABELS[a.mode] || a.mode)},
      {value: 'defaultMode', group: G.approvals, label: t('新しいフォルダーの承認モード'), desc: t(LABELS[defaultMode()])},
      {value: 'lang', group: G.display, label: t('表示言語'), desc: i18n.lang() === 'en' ? 'English' : '日本語'},
      {value: 'motion', group: G.display, label: t('スピナーのアニメーション'), desc: sw('motion')},
      {value: 'codeWrap', group: G.display, label: t('長いコード行を折り返す'), desc: sw('codeWrap')},
      {value: 'footerDevice', group: G.display, label: t('フッターに端末名'), desc: sw('footerDevice')},
      {value: 'footerSlot', group: G.display, label: t('フッターに窓番号'), desc: sw('footerSlot')},
      {value: 'footerName', group: G.display, label: t('フッターに Muse の名前'), desc: sw('footerName')},
      {value: 'footerUsage', group: G.display, label: t('フッターに週の使用量'), desc: sw('footerUsage')},
      {value: 'footerCwd', group: G.display, label: t('フッターにフォルダー名'), desc: sw('footerCwd')},
      {value: 'footerSession', group: G.display, label: t('フッターにセッションID'), desc: sw('footerSession')},
      {value: 'footerVersion', group: G.display, label: t('フッターにバージョン'), desc: sw('footerVersion')},
      {value: 'footerClock', group: G.display, label: t('フッターに時刻'), desc: sw('footerClock')},
      {value: 'color', group: G.display, label: t('色を使う'), desc: nextStart('color')},
      {value: 'kitty', group: G.display, label: t('拡張キー入力（kitty プロトコル）'), desc: nextStart('kitty')},
      {value: 'bell', group: G.notify, label: t('承認・完了時のベル'), desc: sw('bell')},
      // A git checkout (npm link while developing) is never checked (src/update.js): "on" alone was not true there.
      {value: 'updateCheck', group: G.notify, label: t('起動時に更新を確認'), desc: sw('updateCheck') + (switchValue('updateCheck') && update.devCheckout() && process.env.MUSER_UPDATE_CHECK !== '1' ? '  ' + t('（開発用のチェックアウトなので確認しません）') : '')},
      {value: 'skills', group: G.link, label: t('スキル'), desc: t('{n} 個オン', {n: enabledSkills})},
      {value: 'mcp', group: G.link, label: t('MCP サーバー'), desc: t('{n} 個オン', {n: mcpOn})},
    ];
    this.openMenu({title: t('設定'), hint: demo ? t('デモでは設定を保存しません。') : undefined, index, options, pick: key => {
      const at = options.findIndex(o => o.value === key);
      if (key === 'agents') return this.agentLimitsMenu();
      if (key === 'mode') return this.slash('/mode');
      if (key === 'lang') return this.slash('/lang');
      if (key === 'skills') return this.skillsMenu();
      if (key === 'mcp') return this.mcpMenu();
      if (NUMBERS[key]) {
        const d = NUMBERS[key], label = options[at].label;
        return this.set({limitInput: {key, label, text: String(numberValue(key)), selected: true, min: d.min, max: d.max,
          hint: t('{min}〜{max}', {min: d.min, max: d.max}) + (key === 'dailyTurnLimit' ? t('（0 は警告なし）') : ''),
          back: () => this.settingsMenu(at),
          done: v => {
            try {
              setNumber(key, v, {save: !demo});
              if (key === 'maxToolCallsPerTurn') a.maxToolCallsPerTurn = numberValue(key); // from the next call on
              if (envOverride(key)) this.note(t('保存しましたが、環境変数 {name} が優先されるので、今は {value} のままです。', {name: envOverride(key), value: numberValue(key)}));
            } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); }
            this.settingsMenu(at);
          }}});
      }
      if (key === 'quotaFallback') {
        return this.openMenu({title: t('週の上限で応答がないとき'), hint: t('上限の確認に {n} 秒答えがなかったときの動き', {n: QUOTA_WAIT_MS / 1000}),
          options: QUOTA_FALLBACKS.map(v => ({value: v, label: t(QUOTA_FALLBACK_LABELS[v]), desc: t(QUOTA_FALLBACK_HELP[v])})), index: QUOTA_FALLBACKS.indexOf(quotaFallback()), current: quotaFallback(),
          pick: v => { try { setQuotaFallback(v, {save: !demo}); } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); } this.settingsMenu(at); }});
      }
      if (key === 'defaultMode') {
        return this.openMenu({title: t('新しいフォルダーの承認モード'),
          options: MODES.map(m => ({value: m, label: t(LABELS[m]), desc: t(MODE_HELP[m]), danger: m === 'bypass'})), index: MODES.indexOf(defaultMode()), current: defaultMode(),
          pick: m => { try { setDefaultMode(m, {save: !demo}); } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); } this.settingsMenu(at); }});
      }
      if (key === 'focus') {
        if (this.s.busy) { this.note(t('Focus の切替は作業が終わってから行ってください。')); return this.settingsMenu(at); }
        // Saved first, then this window follows: a failed save used to leave the window
        // switched while the note said nothing had changed.
        const next = a.focusEnabled === false;
        // #180: the /focus route also drops resumeFocus; this route forgot, so an
        // off→on here resurrected a task the user had meant to discard.
        try { setSwitch('focus', next, {save: !demo}); a.focusEnabled = next; a.resumeFocus = null; } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); }
        return this.settingsMenu(at);
      }
      try {
        setSwitch(key, !savedValue(key), {save: !demo});
        if (envOverride(key)) this.note(t('保存しましたが、環境変数 {name} が優先されるので、今は{value}のままです。', {name: envOverride(key), value: onOff(switchValue(key))}));
      } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); }
      this.set({}); return this.settingsMenu(at);
    }});
  }
  // The two agent limits: edited as a draft, then applied for this run or saved as defaults.
  agentLimitsMenu(draft) {
    const limits = {...(draft || this.agent.agentLimits || {concurrent: 4, perTurn: 0})};
    const count = n => n === 0 ? t('無制限') : String(n);
    this.openMenu({title: t('エージェント上限'),
      options: [
        {value: 'concurrent', label: t('同時に動かすエージェント数'), desc: count(limits.concurrent)},
        {value: 'perTurn', label: t('1タスクで起動できる合計数'), desc: count(limits.perTurn)},
        {value: 'apply', label: t('今回だけ適用')},
        {value: 'save', label: t('適用して既定値として保存')},
      ], pick: key => {
        // #183: this numeric input alone had no range — every /settings number carries
        // min/max (and limitKey/answerLimit enforce them), this one let any magnitude
        // through, so one extra 0 keypress silently made the limit 10×.
        if (key === 'concurrent' || key === 'perTurn') return this.set({limitInput: {key, limits, text: String(limits[key]), selected: true, min: 0, max: 1000, hint: t('{min}〜{max}', {min: 0, max: 1000})}});
        try {
          applyAgentLimits(this.agent, limits, {save: key === 'save' && this.agent.client?.status !== 'demo'});
          this.note(t('エージェント上限を適用しました: 同時 {concurrent} ／ タスク合計 {perTurn}', {concurrent: count(limits.concurrent), perTurn: count(limits.perTurn)}));
          if (key === 'save') this.note(this.agent.client?.status === 'demo' ? t('デモでは設定を保存しません。') : t('既定値として保存しました。'));
          // At the next start MUSER_MAX_AGENTS / MUSER_MAX_AGENTS_TOTAL win over the saved values.
          const envs = ['MUSER_MAX_AGENTS', 'MUSER_MAX_AGENTS_TOTAL'].filter(n => process.env[n] !== undefined && process.env[n] !== '');
          if (key === 'save' && envs.length) this.note(t('次回の起動では環境変数 {names} が保存した値より優先されます。', {names: envs.join(' / ')}));
        } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); }
      }});
  }
  // The pending limitInput answered from outside the keyboard (the GUI's
  // POST /limit, docs/gui-protocol.md v6): exactly limitKey's return/escape.
  // A number applies it (false when it fails the same validation limitKey
  // applies — the input stays open then, as in the TUI); null cancels it.
  answerLimit(value) {
    const edit = this.s.limitInput;
    if (!edit) return false;
    // back / done: another setting's number (/settings); without them, an agent limit.
    if (value === null) { this.set({limitInput: null}); return edit.back ? edit.back() : this.agentLimitsMenu(edit.limits); }
    const range = () => this.flash(t('{min}〜{max} の整数を入力してください', {min: edit.min, max: edit.max}));
    if (!Number.isSafeInteger(value) || value < 0) { edit.min !== undefined ? range() : this.flash(t('0 以上の整数を入力してください（0 は無制限）')); return false; }
    if (edit.min !== undefined && (value < edit.min || value > edit.max)) { range(); return false; }
    this.set({limitInput: null}); return edit.done ? edit.done(value) : this.agentLimitsMenu({...edit.limits, [edit.key]: value});
  }
  limitKey(input, k) {
    const edit = this.s.limitInput;
    if (k.escape || (k.ctrl && input === 'c')) return this.answerLimit(null);
    if (k.return || input === '\n') { // '\n': ctrl+j, fifth f4-4
      const value = Number(edit.text);
      const range = () => this.flash(t('{min}〜{max} の整数を入力してください', {min: edit.min, max: edit.max}));
      if (!/^\d+$/.test(edit.text) || !Number.isSafeInteger(value)) return edit.min !== undefined ? range() : this.flash(t('0 以上の整数を入力してください（0 は無制限）'));
      return this.answerLimit(value);
    }
    if ((k.ctrl && (input === 'a' || input === 'u')) || k.backspace || k.delete)
      return this.set({limitInput: {...edit, selected: false, text: edit.selected || k.ctrl ? '' : edit.text.slice(0, -1)}});
    if (!k.ctrl && !k.meta && /^\d+$/.test(input)) this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + input}});
  }
  menuKey(input, k) {
    const m = this.s.menu, n = m.options.length;
    // #166: a menu with no options (pc-login's empty pick list) made the modulo NaN and
    // Enter read options[0] of nothing. Escape still cancels; everything else is a no-op.
    if (!n) { if (k.escape || (k.ctrl && input === 'c')) return this.cancelMenu(); return; }
    // Fifth f4-3: fast typing can arrive as ONE input event holding several
    // characters. The digit test below is single-character, so a chunk like
    // '12' matched nothing and was dropped whole; feed it digit by digit
    // instead (stopping if a pick closed or replaced this menu on the way).
    if (/^[0-9]{2,}$/.test(input)) { for (const ch of input) { if (this.s.menu !== m) break; this.menuKey(ch, {}); } return; }
    // Third M19: any non-digit key abandons a buffered first digit. The timer's
    // identity guard only saved keys that REPLACED the menu object (arrows);
    // an ignored key (a letter) left buffer and timer untouched, and the digit
    // picked its item 400 ms later anyway.
    if (!/^[0-9]$/.test(input)) { this.menuBuf = ''; clearTimeout(this.menuTimer); }
    if (k.upArrow) return this.set({menu: {...m, index: (m.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({menu: {...m, index: (m.index + 1) % n}});
    // A pick that throws becomes a note instead of an uncaught error that ends muser: the
    // config and sessions stores now refuse to write when another window holds their lock
    // (phase 2), and some picks (/skills on/off) wrote without a catch of their own.
    const failed = e => this.note(t('設定を変更できませんでした: {error}', {error: e?.message || String(e)}), 'error');
    const pick = i => { this.menuBuf = ''; clearTimeout(this.menuTimer); this.set({menu: null}); try { const r = m.pick(m.options[i].value); if (r && typeof r.catch === 'function') r.catch(failed); } catch (e) { failed(e); } };
    // Two-digit picks: menus with 10+ options (/skills, /resume) could not be picked by number
    // at all. A first digit that could still grow (1 with 10+ options) is buffered briefly; a
    // second digit — or the timeout — settles it.
    if (/^[0-9]$/.test(input)) {
      const buf = (this.menuBuf || '') + input, val = Number(buf);
      if (val >= 1 && val <= n && (buf.length === 2 || val * 10 > n)) return pick(val - 1);
      if (val >= 1 && val * 10 <= n) {
        this.menuBuf = buf; clearTimeout(this.menuTimer);
        // Fifth f4-2: the timeout must not fire while an approval, a picker, a
        // numeric input or a decline reason covers the menu — the pick would
        // land unseen. (ask / openQuestion also clear the timer on open.)
        this.menuTimer = setTimeout(() => { this.menuBuf = ''; if (this.s.menu === m && !this.s.approval && !this.s.question && !this.s.limitInput && !this.s.reasonFor) pick(val - 1); }, 400); this.menuTimer.unref?.();
        return this.set({});
      }
      if (buf.length > 1) { this.menuBuf = ''; return this.menuKey(input, k); }
      return;
    }
    if (k.return || input === '\n') return pick(m.index); // '\n': ctrl+j, fifth f4-4
    if (k.escape || (k.ctrl && input === 'c')) return this.cancelMenu();
  }
  // Closing the open menu without picking, exactly menuKey's escape (the
  // GUI's POST /menu {cancel: true}, docs/gui-protocol.md v6): the buffered
  // digit and its timer go away, the menu closes, its cancel() runs if any.
  cancelMenu() {
    const m = this.s.menu;
    if (!m) return;
    this.menuBuf = ''; clearTimeout(this.menuTimer); this.set({menu: null}); m.cancel?.();
  }
  // ---- selectable questions (focus.ask_user with options) ----
  // Row layout per question tab, shared with the view: the options, then the
  // type-something row as the last numbered choice (n+1, with a checkbox in
  // multi select, its typed text counting as an answer), then — below a dim
  // separator line the view draws, not a row here — the chat-about-this row.
  // There is no submit row: multi select sends on enter (or advances, with
  // 2+ questions), single select sends / advances on picking a choice.
  // With 2+ questions, tab index questions.length is the Submit tab, with a
  // single submit row; a single question has no Submit tab at all.
  questionRows(qi) {
    const item = this.s.question.questions[qi];
    const rows = item.options.map((o, i) => ({kind: 'option', i}));
    rows.push({kind: 'type', i: item.options.length});
    rows.push({kind: 'chat'});
    return rows;
  }
  openQuestion(ask) {
    // deep c1 #6: the ask's shape was trusted whole — a question without options
    // (a plain question mixed in) or an empty questions list threw here, inside
    // the turn-end handler, and the rest of that handler (queue, bang / shell
    // notes) never ran for the turn. Keep only questions the picker can
    // actually ask (options with labels); with none left, no picker opens and
    // the reply is typed in the composer instead, as for a plain question.
    const questions = [];
    for (const item of Array.isArray(ask?.questions) ? ask.questions : []) {
      if (!item || !Array.isArray(item.options)) continue;
      const options = item.options.map(o => typeof o === 'string' ? {label: o} : {...o}).filter(o => typeof o?.label === 'string' && o.label);
      if (options.length) questions.push({...item, options});
    }
    if (!questions.length) return;
    // A picker landing over a menu freezes that menu (fifth f4-2), like ask().
    this.menuBuf = ''; clearTimeout(this.menuTimer);
    this.set({question: {questions, tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''}});
  }
  setQuestion(q) { this.set({question: q}); }
  closeQuestion(resume = true) {
    this.set({question: null});
    // First audit #26: the picker opened at a turn's end is what stopped the
    // queue and the bang / shell notes (continueTurn skips them while a
    // question is up). Closing the picker without answering must let them run
    // again, or they sit until some later turn happens to end.
    // submitQuestionAnswers passes resume=false: its own submit is the
    // resumption, and the queued messages keep waiting for that turn's end.
    if (!resume) return;
    if (this.drainQueueOnce()) return;
    if (this.bangPending) this.sendBangNotes();
    else if (this.shellPending) this.sendShellNotes();
  }
  // Send the oldest queued message as a fresh turn, when nothing is running
  // and no picker is up. Shared by closeQuestion (#26) and the end of an
  // account switch (deep c1 #9's held messages).
  drainQueueOnce() {
    if (this.s.busy || this.s.question || !this.queue.length) return false;
    const next = this.queue.shift();
    this.agent.focusInputPending = this.queue.length > 0;
    this.set({queue: [...this.queue]});
    this.submit(next);
    return true;
  }
  // The answer text for one question, from a given state (defaults to the live one):
  // picked labels in option order, then the typed answer, joined the way the reply reads.
  questionAnswerText(qi, from = this.s.question) {
    const item = from.questions[qi], parts = [];
    if (item.multi) parts.push(...[...(from.checked[qi] || [])].sort((a, b) => a - b).map(i => item.options[i].label));
    else if (from.picked[qi] != null) parts.push(item.options[from.picked[qi]].label);
    if (from.custom[qi]) parts.push(from.custom[qi]);
    return parts.join('、');
  }
  // Store a patched question state, refreshing the Submit tab's answer line for one question.
  patchQuestion(patch, qi) {
    const next = {...this.s.question, ...patch};
    if (qi != null) next.answers = {...next.answers, [qi]: this.questionAnswerText(qi, next)};
    this.setQuestion(next);
  }
  questionTab(dir) {
    const q = this.s.question;
    if (q.questions.length <= 1) return; // one question: no tab row, no Submit tab to switch to
    const n = q.questions.length + 1;
    this.setQuestion({...q, tab: (q.tab + dir + n) % n, index: 0});
  }
  questionKey(input, k) {
    const q = this.s.question;
    if (q.mode !== 'list') return this.questionEditKey(input, k);
    const rows = q.tab >= q.questions.length ? [{kind: 'submit'}] : this.questionRows(q.tab);
    if (k.upArrow) return this.setQuestion({...q, index: (q.index + rows.length - 1) % rows.length});
    if (k.downArrow) return this.setQuestion({...q, index: (q.index + 1) % rows.length});
    if (k.tab) return this.questionTab(k.shift ? -1 : 1);
    if (k.escape || (k.ctrl && input === 'c')) return this.closeQuestion();
    if (input === 'n' && !k.ctrl && !k.meta) return this.setQuestion({...q, mode: 'notes', typeText: q.notes});
    // Number keys reach the choices only (options, then type-something as
    // n+1): the chat row below the separator is not a choice and has no number.
    if (/^[0-9]$/.test(input)) {
      if (q.tab >= q.questions.length) { if (input === '1') return this.questionActivate(rows[0], 0, 'return'); return; }
      const choices = rows.filter(r => r.kind !== 'chat'), i = Number(input) - 1;
      if (i >= 0 && i < choices.length) return this.questionActivate(choices[i], i, 'return');
      return;
    }
    const row = rows[q.index];
    if (!row) return;
    // Return acts, space toggles: on a multi-select option return sends (or
    // advances, with 2+ questions) while space only toggles it. On the
    // type-something row space toggles its typed answer off, or opens the
    // editor when there is none yet; return always opens the editor.
    if (k.return || input === '\n') return this.questionActivate(row, q.index, 'return'); // '\n': ctrl+j, fifth f4-4
    if (input === ' ' && (row.kind === 'option' || row.kind === 'type')) return this.questionActivate(row, q.index, 'space');
  }
  questionActivate(row, at, trigger = 'return') {
    const q = this.s.question;
    if (q.tab >= q.questions.length) return this.submitQuestionAnswers();
    const qi = q.tab, item = q.questions[qi];
    if (row.kind === 'chat') { this.closeQuestion(); return this.flash(t('入力欄で答えてください')); }
    if (row.kind === 'type') {
      if (trigger === 'space' && item.multi && q.custom[qi]) {
        const custom = {...q.custom}; delete custom[qi];
        return this.patchQuestion({custom, index: at}, qi);
      }
      return this.setQuestion({...q, mode: 'type', typeText: q.custom[qi] || '', index: at});
    }
    if (item.multi) {
      if (trigger === 'return') {
        // Enter sends what is checked (plus the typed answer, if any). With
        // nothing checked it does nothing — the hint already says 1つ以上選択.
        if (!this.questionAnswerText(qi)) return;
        if (q.questions.length <= 1) return this.submitQuestionAnswers();
        const answered = i => this.questionAnswerText(i);
        let next = qi + 1;
        while (next < q.questions.length && answered(next)) next++;
        return this.setQuestion({...q, tab: next, index: 0});
      }
      const cur = new Set(q.checked[qi] || []);
      if (cur.has(row.i)) cur.delete(row.i); else cur.add(row.i);
      return this.patchQuestion({checked: {...q.checked, [qi]: [...cur]}, index: at}, qi);
    }
    // Single select: picking an option answers the question and moves on, like Claude's
    // picker — the next unanswered tab, or the Submit tab when none is left. A single
    // question has nowhere to move on to and no Submit tab: the pick sends at once.
    const custom = {...q.custom}; delete custom[qi];
    this.patchQuestion({picked: {...q.picked, [qi]: row.i}, custom}, qi);
    if (q.questions.length <= 1) return this.submitQuestionAnswers();
    const answered = i => this.questionAnswerText(i, this.s.question);
    let next = qi + 1;
    while (next < q.questions.length && answered(next)) next++;
    this.setQuestion({...this.s.question, tab: next, index: 0});
  }
  questionEditKey(input, k) {
    const q = this.s.question;
    // First audit #23: every key routes to the picker while it is open, so the
    // composer's paste keys never fired here and Ctrl+Shift+V / Ctrl+V were
    // silently dropped in the editor. Mirror them: the clipboard read lands in
    // typeText through paste() (which routes to the picker's text modes).
    if (k.ctrl && k.shift && (input === 'V' || input === 'v')) { this.pasteFromClipboard(); return; }
    if ((k.meta && input === 'v') || (k.ctrl && input === 'v') || input === '\x16') { this.pasteImage(); return; }
    if (k.escape || (k.ctrl && input === 'c')) return this.setQuestion({...q, mode: 'list', typeText: ''});
    if (k.return || input === '\n') { // '\n' is ctrl+j: it confirms like Enter instead of entering the one-line text (fifth f4-4)
      const text = q.typeText.trim();
      if (q.mode === 'notes') return this.setQuestion({...q, mode: 'list', notes: text, typeText: ''});
      const qi = q.tab, custom = {...q.custom};
      if (text) custom[qi] = text; else delete custom[qi];
      const patch = {mode: 'list', custom, typeText: ''};
      // deep c1 #4: an empty confirm only closes the editor — it must not also
      // delete the option picked earlier for this question. A typed answer is
      // what replaces the pick. (Deleting an existing custom still works: the
      // editor opened with it as typeText, and picked is already unset then.)
      if (!q.questions[qi].multi && text) { const picked = {...q.picked}; delete picked[qi]; patch.picked = picked; }
      this.patchQuestion(patch, qi);
      // A lone single-select question has no Submit tab, so a typed answer
      // sends on confirm, just as picking an option does. (Multi sends on
      // enter, so its typed answer only joins the checked picks until then.)
      if (text && q.questions.length <= 1 && !q.questions[qi].multi) return this.submitQuestionAnswers();
      return;
    }
    // deep c1 #5: step by grapheme cluster, like the composer — a code-unit
    // slice left a lone surrogate / dangling ZWJ from an emoji, and the broken
    // string was then sent as the answer.
    if (k.backspace || k.delete) { const t = q.typeText; return this.setQuestion({...q, typeText: t.slice(0, t.length - lastClusterLen(t))}); }
    if (input && !k.ctrl && !k.meta) return this.setQuestion({...q, typeText: (q.typeText + input.replace(/\r\n?/g, ' ').replace(/\n/g, ' ')).slice(0, MAX_INPUT)});
  }
  submitQuestionAnswers() {
    const q = this.s.question;
    const missing = q.questions.findIndex((_, i) => !this.questionAnswerText(i));
    if (missing >= 0) { this.flash(t('未回答の質問があります')); return this.setQuestion({...q, tab: missing, index: 0}); }
    const lines = q.questions.map((item, i) => item.question + ' → ' + this.questionAnswerText(i));
    if (q.notes) lines.push(t('メモ: {text}', {text: q.notes}));
    this.closeQuestion(false);
    // Third M25: the answers are the Focus reply, never a decline reason that
    // happens to be pending — submit's reasonFor branch is bypassed, and the
    // reason stays pending for the composer afterwards.
    this.submit(lines.join('\n'), {fromQuestion: true});
  }
  submitReason(text) { const a = this.s.reasonFor; this.set({reasonFor: null}); this.restoreDraft(); a.resolve({allow: false, reason: text.trim()}); this.nextApproval(); }
  // The mode is remembered for this folder (src/permissions.js).
  setMode(m) { this.agent.mode = m; this.set({mode: m}); if (this.agent.client?.status !== 'demo') permissions.saveMode(this.agent.cwd, m); }
  cycleMode() { this.setMode(MODES[(MODES.indexOf(this.agent.mode) + 1) % MODES.length]); }

  // ---- input ----
  setText(text, pos = text.length) { this.set({text, pos}); }
  insert(t) { const {text, pos} = this.s; const add = t.slice(0, Math.max(0, MAX_INPUT - text.length)); this.setText(text.slice(0, pos) + add + text.slice(pos), pos + add.length); }
  paste(t) {
    if (this.s.limitInput) {
      const edit = this.s.limitInput, digits = t.trim();
      if (!/^\d+$/.test(digits)) return this.flash(i18n.t('0 以上の整数を入力してください（0 は無制限）'));
      return this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + digits}});
    }
    // #158: while a decline reason is being typed the composer belongs to it, even if a
    // menu opened meanwhile — the paste goes to the reason, not nowhere.
    if (this.s.approval || (this.s.menu && !this.s.reasonFor)) return;
    if (this.s.question) {
      // Into the picker's text modes (type-something / notes); the list itself takes no paste.
      // Sanitised like any paste (stripControls), then flattened to one line, as typed input is.
      const q = this.s.question;
      if (q.mode === 'list') return;
      return this.setQuestion({...q, typeText: (q.typeText + stripControls(t).replace(/\r\n?/g, ' ').replace(/\n/g, ' ')).slice(0, MAX_INPUT)});
    }
    // Dropping image files into the terminal pastes their paths: attach them instead.
    const paths = clip.pastedImagePaths(t);
    if (paths) return paths.forEach(p => this.attach(p));
    // Pasted text is untrusted (recovery scan): it was inserted with only \r
    // normalised, so an OSC 52 / CSI sequence in a paste executed in the user's
    // terminal at render time — the #184 class, on the one input path
    // sanitize.mjs was never applied to. stripControls keeps \n and \t.
    const cleaned = stripControls(t.replace(/\r\n?/g, '\n'));
    const room = MAX_INPUT - this.s.text.length;
    this.insert(cleaned);
    if (cleaned.length > room) this.flash(i18n.t('入力が長すぎるため、{max} 文字までで切れました', {max: MAX_INPUT}), 6000); // i18n.t: this method's argument is named t
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
  // Which input a paste would land in right now (deep c1 #10): a clipboard
  // read can take a while (a process spawn on Windows), and the paste must go
  // to the input that was current when the user asked — or nowhere — never
  // into whatever happens to be open when the read finishes.
  pasteTarget() { const s = this.s; return s.approval ? 'approval' : s.question ? 'question:' + s.question.mode : s.limitInput ? 'limit' : s.reasonFor ? 'reason' : s.menu ? 'menu' : 'composer'; }
  async pasteImage() {
    if (this.pasting) return; // a second press while a read is in flight would attach the same image twice
    this.pasting = true;
    const target = this.pasteTarget();
    try {
      this.flash(t('クリップボードを確認しています…'), 5000);
      const {files, error} = await clip.clipboardImages();
      if (this.pasteTarget() !== target) return this.flash(t('画面が切り替わったため、貼り付けませんでした'));
      // A clipboard that could not be read at all is not "no images".
      if (error) return this.flash(t('クリップボードを読めませんでした: {error}', {error}), 6000);
      if (!files.length) return this.flash(t('クリップボードに画像がありません'));
      files.forEach(f => this.attach(f.path, f.temporary));
    } finally { this.pasting = false; }
  }
  // Paste whatever the clipboard holds (ctrl+shift+v, a right-click): whether the terminal
  // pastes on those depends on the host, so with mouse reporting on (view enables it), they
  // ask the clipboard itself — an image attaches, text inserts at the caret through paste()
  // (the sanitised path), exactly like the paste keys.
  async pasteFromClipboard() {
    if (this.pasting) return; // deep c1 #10: one read at a time (see pasteImage)
    this.pasting = true;
    const target = this.pasteTarget();
    try {
      const {files, error} = await clip.clipboardImages();
      if (this.pasteTarget() !== target) return this.flash(t('画面が切り替わったため、貼り付けませんでした'));
      if (!error && files.length) return files.forEach(f => this.attach(f.path, f.temporary));
      const text = await clip.clipboardText().catch(() => '');
      if (this.pasteTarget() !== target) return this.flash(t('画面が切り替わったため、貼り付けませんでした'));
      if (text) return this.paste(text);
      if (error) return this.flash(t('クリップボードを読めませんでした: {error}', {error}), 6000);
      this.flash(t('クリップボードに貼れるものがありません'));
    } finally { this.pasting = false; }
  }
  // SGR mouse sequences (ESC [ < b ; x ; y M/m) arrive as input text once reporting is on.
  // Only a right-button press means anything here; every sequence is swallowed so clicks
  // never land in the composer as garbage characters.
  mouseInput(input) {
    const re = /\x1b\[<\d+;\d+;\d+[Mm]/g;
    let right = false;
    for (const seq of input.match(re) || []) if (/\x1b\[<2;\d+;\d+M/.test(seq)) right = true;
    if (right && !this.s.approval && !this.s.menu && !this.s.limitInput && !(this.s.question && this.s.question.mode === 'list')) this.pasteFromClipboard();
  }
  key(input, k) {
    if (input && input.includes('\x1b[<')) return this.mouseInput(input);
    if (this.s.approval) return this.approvalKey(input, k);
    if (this.s.question) return this.questionKey(input, k);
    // Third M18: the overlay order here must match the view's (view.mjs Live
    // draws approval, then question, then menu, then limitInput): with a menu
    // open over a numeric input, the screen showed the menu while the keys
    // silently edited the invisible number. The menu the user sees takes the
    // keys; the numeric input is still there when the menu closes.
    if (this.s.menu && !this.s.reasonFor) return this.menuKey(input, k);
    if (this.s.limitInput) return this.limitKey(input, k);
    // #158: reasonFor was second-class in key routing — a menu opening while a decline
    // reason was being typed stole every key, and a deadline-less call stayed unresolved
    // forever. While a reason is pending the composer keys win; the menu is still there
    // when the reason is submitted or escaped.
    if (!k.tab) this.tabState = null;
    const {text, pos} = this.s;
    if (k.ctrl && input === 'c') {
      if (this.s.promptFor) return this.cancelPrompt();
      if (this.s.reasonFor) return this.submitReason('');
      if (this.s.busy) { this.agent.interrupt(); return this.flash(t('中断しています…')); }
      // A !command could not be stopped at all: `!npm run dev` without & held the screen for its full 120 s.
      if (this.s.bangRunning) { this.bangStop?.abort(); return this.flash(t('中断しています…')); }
      if (text) { this.hIndex = -1; return this.setText(''); } // a cleared draft leaves history browsing behind too (recovery scan)
      if (this.exitArmed.key === 'c' && Date.now() - this.exitArmed.at < 1500) return this.onExit();
      this.exitArmed = {key: 'c', at: Date.now()}; return this.flash(t('もう一度 ctrl+c で終了'));
    }
    // Twice, like ctrl+c: one stray ctrl+d closed muser at once, a running turn included.
    // #160: the double press also bypassed ALL of ctrl+c's guards (prompt cancel, turn
    // interrupt, bang abort) — it shares them now, before the exit arming is even reached.
    if (k.ctrl && input === 'd') {
      if (this.s.promptFor) return this.cancelPrompt();
      if (this.s.reasonFor) return this.submitReason('');
      if (this.s.busy) { this.agent.interrupt(); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.bangStop?.abort(); return this.flash(t('中断しています…')); }
      if (!text) {
        if (this.exitArmed.key === 'd' && Date.now() - this.exitArmed.at < 1500) return this.onExit();
        this.exitArmed = {key: 'd', at: Date.now()}; return this.flash(t('もう一度 ctrl+d で終了'));
      }
      return;
    }
    // ctrl+o: the newest tool output in full, without the /output menu round trip.
    if (k.ctrl && input === 'o') {
      if (!this.outputs.length) return this.flash(t('まだ PC 操作の出力はありません。'));
      return this.showOutput(this.outputs[this.outputs.length - 1]);
    }
    if (k.escape) {
      if (this.s.reasonFor) return this.submitReason('');
      if (this.s.promptFor) return this.cancelPrompt();
      if (this.s.busy) { this.agent.interrupt(); return this.flash(t('中断しています…')); }
      if (this.s.bangRunning) { this.bangStop?.abort(); return this.flash(t('中断しています…')); }
      // Esc closes an open $skill list first (it is not an input-clearing esc).
      const dctx = this.dollarContext(text, pos);
      if (dctx) { this.dollarDismissed = dctx.key; return this.set({}); }
      // Twice to clear: one esc (closing the @ list, say) wiped a long draft.
      if (text) {
        if (Date.now() - (this.escArmed || 0) < 1500) { this.escArmed = 0; this.hIndex = -1; this.setText(''); return; }
        this.escArmed = Date.now(); return this.flash(t('もう一度 esc で入力を消す'), 1500);
      }
      return;
    }
    if (k.tab && k.shift) return this.cycleMode();
    // ctrl+shift+v (when the terminal passes it through instead of pasting itself): paste
    // whatever the clipboard holds — text through paste(), an image as an attachment.
    if (k.ctrl && k.shift && (input === 'V' || input === 'v')) { this.pasteFromClipboard(); return; }
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
      // Enter while the $skill list is open completes to '$name ' instead of
      // sending, exactly as with @ above.
      const dctx = this.dollarContext(text, pos);
      if (dctx?.list.length) return this.applyDollarPick(dctx.frag, dctx.list[this.dollarIndex(dctx.frag.fragment, dctx.list.length)]);
      const ctx = this.atContext(text, pos);
      const pick = ctx?.list.length ? ctx.list[this.atIndex(ctx.at.fragment, ctx.list.length)] : null;
      // A path already typed out in full sends, as Enter normally does (it took a second Enter).
      if (pick && pick !== ctx.at.fragment) return this.applyAtPick(ctx.at, pick);
      // Slash commands, like @: Enter on a strict prefix of the highlighted candidate
      // completes it instead of running the unknown prefix as a command. When the
      // highlighted candidate IS what was typed, Enter runs it as usual.
      if (text.startsWith('/') && !text.includes(' ')) {
        const list = this.slashList(text);
        const pick = list[this.slashIndex(text, list.length)];
        if (pick && pick !== text) return this.setText(pick, pick.length);
      }
    }
    if (k.return) {
      if (k.shift || k.meta) return this.insert('\n');
      if (text.slice(0, pos).endsWith('\\')) return this.setText(text.slice(0, pos - 1) + '\n' + text.slice(pos), pos);
      this.setText(''); this.hIndex = -1;
      if (this.s.reasonFor) return this.submitReason(text);
      if (this.s.promptFor) return this.submitPrompt(text);
      if (!text.trim() && !this.s.attachments.length) return;
      if (this.history[this.history.length - 1] !== text) { this.history.push(text); if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY); saveHistory(this.history); }
      this.draft = '';
      return this.submit(text);
    }
    if (input === '\n') return this.insert('\n'); // ctrl+j
    if (k.backspace) { if (pos) { const n = lastClusterLen(text.slice(0, pos)); this.setText(text.slice(0, pos - n) + text.slice(pos), pos - n); } return; }
    if (k.delete) { const n = firstClusterLen(text.slice(pos)); if (n) this.setText(text.slice(0, pos) + text.slice(pos + n), pos); return; }
    if (k.leftArrow) { if (pos) this.set({pos: pos - lastClusterLen(text.slice(0, pos))}); return; }
    if (k.rightArrow) { const n = firstClusterLen(text.slice(pos)); if (n) this.set({pos: pos + n}); return; }
    if (k.home || (k.ctrl && input === 'a')) return this.set({pos: text.lastIndexOf('\n', pos - 1) + 1});
    if (k.end || (k.ctrl && input === 'e')) { const e = text.indexOf('\n', pos); return this.set({pos: e < 0 ? text.length : e}); }
    if (k.ctrl && input === 'u') return this.setText(text.slice(pos), 0);
    if (k.ctrl && input === 'k') return this.setText(text.slice(0, pos), pos);
    if (k.ctrl && input === 'w') { const b = text.slice(0, pos).replace(/\S+\s*$/, ''); return this.setText(b + text.slice(pos), b.length); }
    // ↑↓ while an @fragment is being typed moves in the candidate list the footer shows,
    // not through history (history used to swallow the keys, so the list looked unselectable).
    if (k.upArrow || k.downArrow) {
      // ↑↓ while a $fragment is being typed moves in the skill list, not history.
      const dctx = this.dollarContext(text, pos);
      if (dctx?.list.length) {
        const idx = this.dollarIndex(dctx.frag.fragment, dctx.list.length);
        this.dollarPick.idx = (idx + (k.upArrow ? -1 : 1) + dctx.list.length) % dctx.list.length;
        return this.set({}); // dollarPick is not store state: without a render the highlight did not move
      }
      const ctx = this.atContext(text, pos);
      if (ctx?.list.length) {
        const idx = this.atIndex(ctx.at.fragment, ctx.list.length);
        this.atPick.idx = (idx + (k.upArrow ? -1 : 1) + ctx.list.length) % ctx.list.length;
        return this.set({}); // atPick is not store state: without a render the highlight did not move
      }
      // The same for a /command prefix: the footer shows the candidates, so ↑↓ move in
      // that list instead of history (they used to, so the list looked unselectable).
      if (text.startsWith('/') && !text.includes(' ')) {
        const list = this.slashList(text);
        if (list.length) {
          const idx = this.slashIndex(text, list.length);
          this.slashPick.idx = (idx + (k.upArrow ? -1 : 1) + list.length) % list.length;
          return this.set({}); // slashPick is not store state either
        }
      }
    }
    // In a multi-line draft ↑/↓ move the caret between lines (recovery scan):
    // they used to be dead keys there — history is single-line only, and no
    // line movement existed, so a pasted multi-line prompt could not be edited.
    if ((k.upArrow || k.downArrow) && text.includes('\n')) {
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      // The column is in grapheme clusters, not UTF-16 units (fifth f4-1):
      // a UTF-16 column could land inside a ZWJ emoji / flag / combining
      // sequence on the target line, and typing there split the cluster.
      // Counting and landing by cluster (offsetAtClusterCol clamps to the
      // target line's cluster count) keeps the caret on a boundary, the
      // same unit ←/→ and Backspace already stepped by.
      const col = clusterCount(text.slice(lineStart, pos));
      if (k.upArrow) {
        if (!lineStart) return;
        const prevEnd = lineStart - 1, prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
        return this.set({pos: prevStart + offsetAtClusterCol(text.slice(prevStart, prevEnd), col)});
      }
      const lineEnd = text.indexOf('\n', pos);
      if (lineEnd < 0) return;
      const nextStart = lineEnd + 1, nextEnd = text.indexOf('\n', nextStart);
      return this.set({pos: nextStart + offsetAtClusterCol(text.slice(nextStart, nextEnd < 0 ? text.length : nextEnd), col)});
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
    // All matches, not the default limit of 6 (deep Part B R4-1): ↑↓ and the
    // footer's window move through this whole list, so no candidate is
    // silently unreachable. The view asks mentions for the same full list.
    return at ? {at, list: mention.complete(at.fragment, this.agent.cwd, 10000)} : null;
  }
  // The highlighted candidate for a fragment; resets whenever the fragment changes.
  atIndex(fragment, n) {
    if (this.atPick.key !== fragment) this.atPick = {key: fragment, idx: 0};
    return n ? ((this.atPick.idx % n) + n) % n : 0;
  }
  // The /command candidates for a bare prefix — every match, no cap: the footer draws a
  // window of this list around the highlight, so the two never disagree.
  slashList(text) {
    return COMMANDS.map(([n]) => n).filter(n => n.startsWith(text));
  }
  // The highlighted slash candidate; resets whenever the typed prefix changes.
  slashIndex(text, n) {
    if (this.slashPick.key !== text) this.slashPick = {key: text, idx: 0};
    return n ? ((this.slashPick.idx % n) + n) % n : 0;
  }
  // Skills on this PC, cached briefly: the footer asks on every render while a
  // $fragment is being typed, and skills.load reads every SKILL.md it finds.
  skillList() {
    if (this._skillCache && Date.now() - this._skillCache.at < 3000 && this._skillCache.cwd === this.agent.cwd) return this._skillCache.list;
    let list = [];
    try { list = skills.load(this.agent.cwd); } catch { list = []; }
    this._skillCache = {at: Date.now(), cwd: this.agent.cwd, list};
    return list;
  }
  // The $skill fragment at the caret plus its candidates (enabled skills whose name
  // starts with the fragment) — the list the footer draws. Null when the caret is
  // not in a $fragment, or when Esc closed the list for this fragment.
  dollarContext(text, pos) {
    const frag = skills.dollarFragmentAt(text, pos);
    if (!frag) return null;
    const key = frag.start + ':' + frag.fragment;
    if (this.dollarDismissed === key) return null;
    const all = this.skillList();
    const q = frag.fragment;
    const list = all.filter(s => s.enabled && s.name.startsWith(q)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return {frag, key, list, noSkills: !all.some(s => s.enabled)};
  }
  // The highlighted $ candidate; resets whenever the fragment changes (atIndex's twin).
  dollarIndex(fragment, n) {
    if (this.dollarPick.key !== fragment) this.dollarPick = {key: fragment, idx: 0};
    return n ? ((this.dollarPick.idx % n) + n) % n : 0;
  }
  applyDollarPick(frag, pick) {
    const {text, pos} = this.s;
    const ins = pick.name + ' ';
    const nt = text.slice(0, frag.start) + ins + text.slice(pos);
    this.tabState = null;
    return this.setText(nt, frag.start + ins.length);
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
    const dctx = this.dollarContext(text, pos);
    if (dctx) {
      // Tab completes the highlighted $skill to '$name ' (no list, no completion).
      if (!dctx.list.length) return;
      return this.applyDollarPick(dctx.frag, dctx.list[this.dollarIndex(dctx.frag.fragment, dctx.list.length)]);
    }
    const at = mention.fragmentAt(text, pos);
    if (at) {
      // Tab cycles the same full list atContext returns (see there): cycling
      // only the first 6 made the rest unreachable however often Tab was hit.
      const list = mention.complete(at.fragment, this.agent.cwd, 10000);
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
    // Fifth f4-3: a chunk of digits in one input event — approvals take a
    // single digit, so the first keystroke is the answer; the rest were typed
    // before it landed and must not answer whatever opens next.
    if (/^[0-9]{2,}$/.test(input)) input = input[0];
    if (k.upArrow) return this.set({approval: {...a, index: (a.index + n - 1) % n}});
    if (k.downArrow || k.tab) return this.set({approval: {...a, index: (a.index + 1) % n}});
    if (/^[1-9]$/.test(input) && Number(input) <= n) return this.answer(Number(input) - 1);
    if (k.return || input === '\n') return this.answer(a.index); // '\n': ctrl+j, fifth f4-4
    if (k.escape || (k.ctrl && input === 'c')) { this.set({approval: null}); a.resolve({allow: false}); this.nextApproval(); }
  }

  // ---- commands ----
  async submit(text, {fromQuestion = false} = {}) {
    this.resumeEpoch = (this.resumeEpoch || 0) + 1; // a send supersedes a resume still loading (#177)
    // #158: a send from any surface (GUI /send included) answers a pending decline
    // reason first — it used to fall through and go to Muse as a chat message.
    // fromQuestion (submitQuestionAnswers) is the one exception, third M25:
    // those answers belong to the Focus question that was asked, and a reason
    // pending at the same time stays pending instead of eating them.
    if (!fromQuestion) {
      if (this.s.reasonFor) return this.submitReason(text);
      if (this.s.promptFor) return this.submitPrompt(text);
    }
    if (this.addingAccount) return this.flash(t('アカウントを追加しています。完了するまでお待ちください。'));
    if (text.startsWith('/')) return this.slash(text.trim());
    // Leading spaces too: a "! command" copied from Muse's reply on screen comes with its indent.
    if (text.trimStart().startsWith('!')) return this.bang(text.trimStart().slice(1).trim());
    // $name skill calls (Codex style), here in submit so the resident server's
    // submits from clients expand the same way: Muse gets one 'Use the skill …'
    // sentence per enabled $name followed by the text as typed, while the screen
    // and the transcript keep showing what the user typed. A disabled $name stays
    // plain text and is noted; unknown names, $HOME, $env:PATH, $5 never match.
    const drefs = (() => { try { return skills.dollarRefs(text, this.agent.cwd); } catch { return {names: [], disabled: []}; } })();
    for (const name of drefs.disabled) this.note(t('{name} はオフです（/skills でオンにできます）', {name}));
    const sendText = drefs.names.length ? drefs.names.map(n => skills.skillSentence(n)).join(' ') + ' ' + text : text;
    // deep c1 #9: an account switch in flight — the message would reach the
    // agent mid-switch (the closing session of the old account, or ahead of
    // the handoff on the new one). Hold it in the queue instead; the switch's
    // completion sends it on the new account (see requestAccountSwitch).
    if (this.accountSwitching) {
      if (this.queue.length >= MAX_QUEUE) { this.note(t('キューがいっぱいです（最大 {max} 件）。', {max: MAX_QUEUE}), 'error'); return this.flash(t('キューがいっぱいです')); }
      this.queue.push(sendText); this.agent.focusInputPending = true; this.set({queue: [...this.queue]}); return this.flash(t('アカウントを切り替えています。そのあと送ります'));
    }
    if (this.s.busy) {
      if (this.queue.length >= MAX_QUEUE) { this.note(t('キューがいっぱいです（最大 {max} 件）。', {max: MAX_QUEUE}), 'error'); return this.flash(t('キューがいっぱいです')); }
      // First try to send it as what it is — a real chat message, through the same send a
      // turn starts with. Inside a tool result the text is only tool data and cannot be told
      // apart from it; posted, it is a user message. The piggyback + queue stay as the
      // fallback for when posting is not possible.
      let posted = false;
      try { posted = !!(await this.agent.postSteer?.(sendText)); } catch {}
      if (posted) { this.agent.focusInputPending = this.queue.length > 0; this.push({type: 'user', text}); return this.flash(t('作業中の会話にメッセージとして送りました')); }
      // deep c1 #7: the turn may have ENDED during the postSteer await — then
      // this is a fresh send, not a queue entry. Queueing it anyway left it in
      // a queue nothing drains until some later turn ends.
      if (this.s.busy) { this.queue.push(sendText); this.agent.queueSteer?.(sendText); this.agent.focusInputPending = true; this.set({queue: [...this.queue]}); return this.flash(t('作業中です。次のツール実行で Muse に伝えます（キュー {n} 件目）', {n: this.queue.length})); }
    }
    const attachments = this.s.attachments;
    this.agent.clearSteer?.(); // a fresh send supersedes any steer copy whose queue twin is gone
    // and the pending-input marker a posted steer set — but not while more messages wait in the
    // queue: this send's Focus must stop for them instead of running its rounds first.
    this.agent.focusInputPending = this.queue.length > 0;
    // @path mentions go along with the message; ! command output since the last turn too.
    const ex = mention.expand(text, this.agent.cwd, this.agent.ctx.readFiles);
    this.push({type: 'user', text, images: attachments.map(a => a.name), files: ex.files, missing: ex.missing}); this.sawText = false;
    this.set({busy: true, turnStart: Date.now(), status: '', attachments: []});
    const savedBang = this.bangNotes || [], savedShell = this.shellNotes || [];
    const extra = [...savedBang, ...savedShell, ex.block].filter(Boolean); this.bangNotes = []; this.shellNotes = [];
    // In the user's language: it is the user's message in the Muse chat (the app shows it too).
    const body = (sendText || t('（画像を見てください）')) +(extra.length ? '\n\n' + extra.join('\n\n') : '');
    try { await this.agent.send(body, {attachments, display: text}); }
    // #165/#174: a failed send used to take the notes AND the attachments with it — the
    // shell's task-notification existed nowhere else, and a clipboard image lived only in
    // memory. Both go back (ahead of anything that arrived meanwhile) for the next send.
    catch (e) { this.bangNotes = [...savedBang, ...(this.bangNotes || [])]; this.shellNotes = [...savedShell, ...(this.shellNotes || [])]; if (this.s.busy) { this.set({busy: false, attachments: this.s.attachments.length ? this.s.attachments : attachments}); this.push({type: 'end', ok: false, error: e.message}); } }
  }
  // A finished !command's output to Muse on its own, like Claude Code: Muse answers it without the
  // user having to send "done". During a turn it waits for the turn's end (sendBangNotes runs again
  // there); a message queued meanwhile carries it instead.
  async sendBangNotes() {
    // #162: busy was the only guard — during account add / a prompt, this started an
    // automatic turn whose input then answered the prompt instead. Wait like a busy turn.
    // deep c1 #1: a picker answer or a decline reason in progress is the same
    // kind of wait (#162 covered promptFor only).
    if (this.s.busy || this.addingAccount || this.loggingIn || this.s.promptFor || this.s.question || this.s.reasonFor) { this.bangPending = true; return; }
    this.bangPending = false;
    const notes = this.bangNotes || [];
    if (!notes.length) return;
    this.bangNotes = [];
    const cmds = notes.map(n => (/^\[The user ran this in the terminal: ([^\n]*)\]/.exec(n) || [])[1]).filter(Boolean);
    this.sawText = false;
    this.set({busy: true, turnStart: Date.now(), status: ''});
    try { await this.agent.send(notes.join('\n\n'), {display: cmds.map(c => '! ' + c).join('\n')}); }
    catch (e) { this.bangNotes = [...notes, ...(this.bangNotes || [])]; if (this.s.busy) { this.set({busy: false}); this.push({type: 'end', ok: false, error: e.message}); } }
  }
  // A background shell ended: tell Muse at once, so the work it was started for resumes without
  // the user having to say "done" — stopped shells report too (status 'stopped'), as in Claude
  // Code. During a turn the note waits for the turn's end, like a finished !command.
  onShellFinished(s) {
    if (!switchValue('bgAutoResume')) return;
    // Claude Code's shape: a task-notification with the facts only — task-id, status, and a
    // summary whose sentence carries the exit code. Nothing in it tells Muse to continue; the
    // injected turn itself is the resumption.
    const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const summary = s.status === 'stopped' ? 'Background command "' + s.command + '" was stopped' : 'Background command "' + s.command + '" ' + s.status + ' (exit code ' + s.exit + ')';
    (this.shellNotes ||= []).push('<task-notification>\n<task-id>' + s.id + '</task-id>\n<status>' + s.status + '</status>\n<summary>' + esc(summary) + '</summary>\n</task-notification>');
    this.sendShellNotes();
  }
  async sendShellNotes() {
    // deep c1 #1: same guard as sendBangNotes — a picker answer or a decline
    // reason in progress waits, instead of an unrelated automatic turn starting.
    if (this.s.busy || this.addingAccount || this.loggingIn || this.s.promptFor || this.s.question || this.s.reasonFor) { this.shellPending = true; return; }
    this.shellPending = false;
    const notes = this.shellNotes || [];
    if (!notes.length) return;
    this.shellNotes = [];
    const cmds = notes.map(n => { const id = (/<task-id>([^<]*)<\/task-id>/.exec(n) || [])[1] || ''; const st = (/<status>([^<]*)<\/status>/.exec(n) || [])[1] || ''; return (id + ' ' + st).trim(); }).filter(Boolean);
    this.note(t('バックグラウンドの処理が終わったので、続きを Muse に送りました'));
    this.sawText = false;
    this.set({busy: true, turnStart: Date.now(), status: ''});
    try { await this.agent.send(notes.join('\n\n'), {display: cmds.map(c => '⏺ ' + c).join('\n')}); }
    catch (e) { this.shellNotes = [...notes, ...(this.shellNotes || [])]; if (this.s.busy) { this.set({busy: false}); this.push({type: 'end', ok: false, error: e.message}); } }
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
    // #161: a second foreground ! while one runs overwrote bangStop and the output guard;
    // the first command's end then cleared the second's row (and its abort hit the wrong
    // command). One foreground bang at a time — the & form above is unaffected.
    if (this.s.bangRunning) return this.flash(t('作業中は切り替えられません'));
    const call = {id: 'bang-' + Date.now(), agent: 'main', command: 'system.run', params: {command: cmd}, kind: 'exec', summary: cmd, user: true};
    // Its own row, not `running`: during a turn Muse's next call took the row over, and the
    // command's end then cleared the row of the call Muse still had running.
    this.set({bangRunning: {call, tail: []}});
    const onOut = chunk => { const r = this.s.bangRunning; if (!r || r.call !== call) return; const lines = frames(chunk).split('\n').filter(l => l.trim()); this.set({bangRunning: {...r, tail: [...r.tail, ...lines].slice(-5)}}); };
    try {
      const stop = this.bangStop = new AbortController();
      const r = await LOCAL['system.run'].run({command: cmd}, this.agent.ctx, stop.signal, onOut);
      this.set({bangRunning: null});
      mention.invalidate?.(this.agent.cwd); // a !command may have created files too
      // Kept for /output like Muse's commands: past the 12 lines on screen it could not be seen at all.
      const outputLines = this.keepOutput(call, stripEmbeds(frames(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : ''))));
      this.push({type: 'tool', call: {...call, ok: true, outputLines, view: {...r.view, tail: stripEmbeds(frames(r.payload.stdout + r.payload.stderr)).trimEnd().split('\n').slice(-12)}}});
      // The end is kept too, and the cut is said: the first 20,000 characters alone dropped the
      // errors at the bottom of a long build and all of stderr, without a word.
      const out = stripEmbeds(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : ''));
      const sent = out.length > BANG_NOTE ? out.slice(0, BANG_NOTE * 0.3) + '\n… (' + (out.length - BANG_NOTE) + ' characters cut here) …\n' + out.slice(-BANG_NOTE * 0.7) : out;
      (this.bangNotes ||= []).push('[The user ran this in the terminal: ' + cmd + ']\nexit ' + r.payload.exit_code + '\n' + sent);
      if (switchValue('bangAutoSend')) this.sendBangNotes();
    } catch (e) { this.set({bangRunning: null}); this.push({type: 'tool', call: {...call, ok: false, error: e.message}}); }
  }
  // A resumed chat: its turns from the local transcript (Muse fills in only what is missing),
  // the last ones on screen, and the todo list as it was.
  async showResumed(s, {startup = false} = {}) {
    if (!s) return;
    const a = this.agent;
    // A chat lives on the Muse of the account it was started on: continuing it here, on another
    // account, sent its id to a Muse that never saw it. Say which account holds it instead.
    // A chat saved before multi-account support names no account: it was the first one's.
    const ownerId = s.account || 'default';
    if (!startup && a.accountId && ownerId !== a.accountId) {
      const owner = require('../accounts.js').get(ownerId);
      return this.note(owner ? t('この会話はアカウント {label} のものです。/account {id} で切り替えてから再開してください。', {label: owner.label, id: owner.id})
                             : t('この会話のアカウント（{id}）はもうありません。', {id: ownerId}), 'error');
    }
    // #177: everything below awaits (gateway, transcript). A send in the meantime bumps
    // resumeEpoch (submit / turn-start) — the history is then NOT spliced under the new
    // turn and its todos are not overwritten mid-turn.
    const epoch = this.resumeEpoch = (this.resumeEpoch || 0) + 1;
    // #175/#176: shell notes and the standing goal belong to the chat being left, the
    // same as bangNotes/todos already were: the old chat's shell completion must not leak
    // into the new chat's first message, and the goal shown must be the resumed chat's.
    if (!startup) { a.session = s; a.ctx.readFiles.clear(); a.ctx.todos = []; this.bangNotes = []; this.shellNotes = []; this.shellPending = false; this.set({todos: [], goal: a.standingGoal?.() || null}); }
    // Reading the chat from Muse needs the gateway, which may still be connecting at startup.
    if (sessions.transcript(s.id).length < (s.turns || 0)) { try { await a.ensureConnected?.(); } catch {} }
    let res;
    try { res = await transcript.forResume(s, a.client); } catch { res = {turns: sessions.transcript(s.id), from: 'local'}; }
    if (!startup && (epoch !== this.resumeEpoch || this.s.busy || a.session !== s)) return;
    const turns = res.turns, shown = turns.slice(-10);
    if (!startup || turns.length) this.note(t('↺ 再開: {title} · {n} ターン', {title: s.title || s.id, n: Math.max(s.turns || 0, turns.length)}) +
      (turns.length > shown.length || res.partial ? t('（直近 {n} ターンを表示）', {n: shown.length}) : '') + (res.from === 'muse' ? t(' · Muse から読み込み') : ''));
    for (const t of shown) {
      this.push({type: 'user', text: t.user || ''});
      if (t.tools?.length || t.steps?.length) this.push({type: 'past', tools: t.tools || [], steps: t.steps || []});
      for (const report of t.progress || []) this.push({type: 'progress', ...report});
      if (t.focus) this.push({type: 'focus', focus: t.focus});
      if (t.reply) { const md = createMd(); this.push({type: 'md', rows: md.rows(sanitizeEmbeds(String(t.reply).trimEnd()).split('\n')), first: true}, {type: 'gap'}); }
      if (t.error) this.push({type: 'end', ok: false, error: t.error, ms: 0});
    }
    if (!turns.length && (s.turns || 0) > 0) this.note(t('この会話の中身は読み込めませんでした。続きは送れます。'));
    // #179: only the last MERGED turn was consulted; turns that came from another device
    // carry todos: [] as a placeholder, so when one of those was last, the in-progress
    // todos silently vanished. The newest turn that actually recorded todos wins.
    const todos = [...turns].reverse().find(x => Array.isArray(x.todos) && x.todos.length)?.todos;
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
      // This window's account: its own Edge profile and jar. Without them /login always signed
      // the FIRST account in again (web.enc), and a window on another account kept its lapsed login.
      const files = this.agent.accountFiles;
      await flow({log: s => this.flash(String(s).trim().replace(/^…\s*/, ''), 300000), ...(files?.web ? {profile: files.browser, jarFile: files.web} : {})});
      this.agent.reloadLogin?.(); usage.resetWeb?.();
      this.flash(t('ログインしました。Muse に接続しています…'), 60000);
      await this.agent.ensureConnected();
      this.flash(''); this.set({loginNeeded: false, ...(this.s.menu?.loginOffer ? {menu: null} : {})});
      this.note(t('muse.ai にログインし直して、接続しました。'));
      this.refreshPlan();
    } catch (e) { this.flash(''); this.note(t('ログインできませんでした: {error}（/login でもう一度）', {error: e.message}), 'error'); }
    finally { this.loggingIn = false; }
  }
  // ---- prompts: one question at a time, answered in the composer (or by a menu) ----
  // reasonFor's shape, generalised: the question goes to the scrollback as a note, the
  // answer comes back through submit()/the return key and never enters the chat or the
  // input history — an auth code is not a message. Esc / ctrl+c cancels.
  // While the add screen is up, the flow's lines go to the screen, not the chat: the add
  // runs on its own screen (see addAccountFlow) and the chat only keeps the outcome.
  flowLine(x) {
    const f = this.s.addFlow;
    if (!f) return false;
    const add = (Array.isArray(x) ? x : [x]).map(String);
    this.set({addFlow: {...f, lines: [...f.lines, ...add].slice(-30)}});
    return true;
  }
  promptAsk(message, {hint, placeholder} = {}) {
    const lines = [message];
    if (hint) lines.push(hint);
    if (placeholder) lines.push(t('入力例: {example}', {example: placeholder}));
    if (!this.flowLine(lines)) this.note(lines);
    // The question in the scrollback alone reads as a plain note — nothing on screen said
    // the composer was waiting for an answer, so a picked menu item looked like it did
    // nothing. Keep the question on the (amber, always-visible) flash line until answered.
    this.flash(t('入力待ち: {message}（Enter で送信、Esc で中止）', {message}), 300000);
    return new Promise((resolve, reject) => this.set({promptFor: {resolve, reject, message}}));
  }
  submitPrompt(text) {
    const p = this.s.promptFor;
    if (!p) return;
    // #171: the empty-input flash replaced promptAsk's standing "waiting for input"
    // flash, which then timed out and vanished while the prompt was still unanswered.
    // Warn briefly, then put the standing flash back if this prompt is still open.
    if (!text.trim()) {
      this.flash(t('入力してください'));
      clearTimeout(this.promptFlashTimer);
      this.promptFlashTimer = setTimeout(() => { if (this.s.promptFor === p) this.flash(t('入力待ち: {message}（Enter で送信、Esc で中止）', {message: p.message}), 300000); }, 2600); this.promptFlashTimer.unref?.();
      return;
    }
    this.set({promptFor: null});
    this.flash('');
    p.resolve(text.trim());
  }
  cancelPrompt() {
    const p = this.s.promptFor;
    if (!p) return;
    this.set({promptFor: null});
    this.flash('');
    p.reject(new Error(t('中止しました。')));
  }
  // openMenu as a promise: pick resolves, esc / ctrl+c rejects (menuKey's cancel hook).
  menuPromise({title, hint, options}) {
    return new Promise((resolve, reject) => this.openMenu({title, hint, options,
      pick: v => resolve(v), cancel: () => reject(new Error(t('中止しました。')))}));
  }
  // The ui object pc-login.js drives (src/tui/onboard.js's clackUi is the CLI's version),
  // spoken through this window: busy is a flash, questions are prompts and menus.
  accountUi() {
    const busyLine = busy => { const f = this.s.addFlow; if (f) this.set({addFlow: {...f, busy}}); };
    return {
      busy: async (label, fn) => { this.flash(label + '…', 300000); busyLine(label); try { const r = await fn(); this.flash(''); busyLine(null); return r; } catch (e) { this.flash(''); busyLine(null); throw e; } },
      info: s => { if (!this.flowLine(String(s))) this.note(String(s)); },
      note: s => { if (!this.flowLine(String(s))) this.note(String(s)); },
      // An auth answer (an email, a code) never starts with '/': a slash command typed at
      // one of these prompts is a command, and feeding it to the auth service as a contact
      // or a code only earns a bare HTTP 400. Abort the add instead; the user can rerun it.
      ask: async (message, opts) => { const v = await this.promptAsk(message, opts); if (String(v).startsWith('/')) throw new Error(t('中止しました。')); return v; },
      confirm: message => this.menuPromise({title: message, options: [{value: true, label: t('はい')}, {value: false, label: t('いいえ')}]}),
      pick: (message, items) => this.menuPromise({title: message, options: items.map((it, i) => ({value: i, label: it.label}))}),
      close: () => {},
    };
  }
  // /account add: the CLI's account add, in here. The Edge login window takes minutes and
  // the registration asks questions, so a turn must not be running; the steps themselves
  // (register, log in, register this PC, roll back, same-Muse warning) live in
  // src/account-add.js. The window's account and the default do not change.
  async addAccountFlow(label) {
    const a = this.agent;
    if (a.client?.status === 'demo') return this.note(t('デモではアカウントを追加できません。'));
    if (this.addingAccount || this.loggingIn) return;
    if (this.s.busy || a.busy) return this.note(t('アカウントの追加は作業が終わってから行ってください。'));
    // The add runs on its own screen, not in the chat: the name question, the Edge login
    // wait and the registration steps all show there (state.addFlow, drawn by the view),
    // and the chat only keeps the outcome — added, cancelled or failed.
    this.set({addFlow: {lines: [], busy: null}});
    let slashCmd = null;
    try {
      let name = String(label || '').trim();
      if (!name) {
        try { name = await this.promptAsk(t('追加するアカウントの名前')); }
        catch { return this.note(t('アカウントの追加を中止しました。')); }
        // A slash command typed at the name prompt is a command, not a name: run it as one
        // instead of registering an account literally called '/account' (login window and
        // all), which is what the answer used to become.
        // #163: it used to run WHILE this flow's finally was still pending — submitting
        // '/account add foo' re-entered addAccountFlow, and this flow's finally then set
        // the INNER flow's addFlow screen to null, so the add ran with no screen and its
        // progress spilled into the chat. Run it only after this flow has fully closed.
        if (name.startsWith('/')) slashCmd = name;
      }
      if (!slashCmd) {
      this.addingAccount = true;
      this.flash(t('アカウント {label} を追加します。', {label: name}), 300000);
      try {
        const impl = this.accountAddImpl || (opts => require('../account-add.js').addAccount(opts.label, opts));
        const {account, same} = await impl({label: name, ui: this.accountUi(), log: s => { const line = String(s).trim().replace(/^…\s*/, ''); if (!this.flowLine(line)) this.flash(line, 300000); }});
        this.flash('');
        this.note(t('アカウント {label} を追加しました。/account で切り替えられます。', {label: account.label}));
        if (same) this.note(t('注意: {label} は {other} と同じ muse.ai アカウント（同じ Muse）です。使用量は共通なので、別のアカウントでログインし直すか `muser account remove {id}` で消してください。', {label: account.label, other: same.label, id: account.id}));
      } catch (e) {
        this.flash('');
        this.note(t('アカウントを追加できませんでした: {error}', {error: e.message}), 'error');
      } finally { this.addingAccount = false; }
      }
    } finally { this.set({addFlow: null}); }
    if (slashCmd) return this.submit(slashCmd);
  }
  // /account: a picker over the pool, or a switch by name. A switch is only ever run
  // between turns — picked mid-turn it becomes a reservation for the turn's end (see the
  // turn-end handler) — and it always starts a fresh chat on the other account's Muse,
  // announced by the 'account' event. Adding is /account add (see addAccountFlow above).
  async accountCommand(arg) {
    const a = this.agent;
    if (a.client?.status === 'demo') return this.note(t('アカウントは1つだけです（追加は `muser account add <名前>`）'));
    const accounts = require('../accounts.js');
    if (arg) {
      const add = /^add(?:\s+([\s\S]*))?$/.exec(arg.trim());
      if (add) return this.addAccountFlow(add[1] || '');
      const target = accounts.resolve(arg);
      if (!target) return this.note(t('アカウントが見つかりません: {id}', {id: arg}), 'error');
      // By name too, the target's login and device are checked first (local files only, no
      // plan reads): without them a switch to an account that was never set up went ahead.
      let st = null;
      if (target.id !== a.accountId) { try { st = (await require('../account-pool.js').statuses({plans: false})).find(s => s.id === target.id) || null; } catch {} }
      return this.requestAccountSwitch(target, st);
    }
    this.flash(t('Muse の利用状況を確認しています…'), 30000);
    let all;
    try { all = await require('../account-pool.js').statuses(); }
    catch (e) { this.flash(''); return this.note(t('アカウントを確認できませんでした: {error}', {error: e.message}), 'error'); }
    this.flash('');
    const line = s => (!s.hasLogin ? t('ログインなし') : !s.device ? t('端末登録なし') : t('利用できます')) +
      (s.plan ? ' · ' + t('週 {n}%', {n: s.plan.percentUsed ?? '?'}) : '');
    const options = all.map(s => ({value: s.id, label: (s.id === a.accountId ? '● ' : '○ ') + s.label, desc: line(s), mark: s.id === a.accountId}));
    if (this.accountSwitchReservation) options.push({value: '__cancel__', label: t('切替予約を取り消す'), desc: t('{label} へ切替予定', {label: this.accountSwitchReservation.label})});
    options.push({value: '__add__', label: t('＋ アカウントを追加'), desc: t('ログインと端末登録を行います')});
    this.openMenu({title: t('アカウント'), hint: t('{threshold}% で、続けるか引き継ぐかを確認します', {threshold: accounts.threshold()}), options, pick: v => {
      if (v === '__add__') return this.addAccountFlow('');
      if (v === '__cancel__') { const r = this.accountSwitchReservation; this.clearAccountReservation(); return this.note(t('アカウント切替の予約を取り消しました（{label}）', {label: r?.label || ''})); }
      const target = accounts.get(v);
      if (target) this.requestAccountSwitch(target, all.find(s => s.id === v) || null);
    }});
  }
  // One pick, from the menu or by name: unusable accounts say what is missing, the current
  // account cancels any reservation, and a pick made mid-turn is reserved for the turn's
  // end instead of being refused.
  requestAccountSwitch(target, st, {auto = false} = {}) {
    const a = this.agent;
    // deep c1 #9: a switch already in flight — a second one would overwrite
    // a.pendingHandoff mid-await and mix the two handoffs up.
    if (this.accountSwitching) return this.note(t('アカウントを切り替えています…'));
    if (st && !st.hasLogin) return this.note(t('{label} はログインしていません。`muser login --account {id}` でログインしてください。', {label: target.label, id: target.id}), 'error');
    if (st && !st.device) return this.note(t('{label} はこの PC が未登録です。`muser pc-login --account {id}` で登録してください。', {label: target.label, id: target.id}), 'error');
    if (target.id === a.accountId) {
      if (this.accountSwitchReservation) { const r = this.accountSwitchReservation; this.clearAccountReservation(); return this.note(t('アカウント切替の予約を取り消しました（{label}）', {label: r.label})); }
      return this.note(t('今のアカウントが {label} です。', {label: target.label}));
    }
    if (this.s.busy || a.busy) {
      this.accountSwitchReservation = {id: target.id, label: target.label, auto};
      this.set({accountReserved: target.label});
      return this.note(t('このターンが終わったら {label} に切り替えます', {label: target.label}));
    }
    return this.switchToAccount(target, {reason: auto ? 'quota' : 'manual'})
      .then(() => { if (!this.drainQueueOnce() && auto && turnFailed(this.lastTurnEnd) && !this.queue.length) this.resumeAfterHandover(); })
      .catch(e => this.note(t('アカウントを切り替えられませんでした: {error}', {error: e.message}), 'error'));
  }
  clearAccountReservation() {
    this.accountSwitchReservation = null;
    this.set({accountReserved: null});
  }
  // The switch itself, through the pool so a pre-connected (warmed) bundle is reused.
  // The handoff note for the new account's Muse is built BEFORE the old session is
  // dropped and left on the agent: it rides the first turn there (see Agent).
  async switchToAccount(target, {reason = 'manual'} = {}) {
    // deep c1 #9: one switch at a time, marked for the whole await — submit()
    // holds messages while this is set, and requestAccountSwitch refuses a
    // second switch instead of overwriting the handoff below.
    if (this.accountSwitching) throw new Error(t('アカウントを切り替えています…'));
    this.accountSwitching = true;
    const a = this.agent;
    try {
      try { a.pendingHandoff = this.buildAccountHandoff(target) || undefined; } catch { a.pendingHandoff = undefined; }
      const pool = a.accountPool;
      const next = pool?.bundleFor ? pool.bundleFor(target) : require('../account-pool.js').bundle(target);
      try { await a.switchAccount(next, {reason}); }
      catch (e) { a.pendingHandoff = undefined; throw e; }
    } finally { this.accountSwitching = false; }
  }
  // A reserved switch at a turn boundary. If the agent got busy again in the meantime
  // (a background resume beat us to it), the reservation stays for the next turn end.
  async executeAccountReservation() {
    const r = this.accountSwitchReservation;
    if (!r) return;
    const a = this.agent;
    if (a.busy || this.accountSwitching) return; // a manual switch in flight: the reservation stays for the next turn end (deep c1 #9)
    const target = require('../accounts.js').get(r.id);
    this.clearAccountReservation();
    if (!target) { this.note(t('アカウントが見つかりません: {id}', {id: r.label}), 'error'); return; }
    try { await this.switchToAccount(target, {reason: 'reserved'}); }
    catch (e) { this.note(t('アカウントを切り替えられませんでした: {error}', {error: e.message}), 'error'); return; }
    return {resume: !!r.auto && turnFailed(this.lastTurnEnd)};
  }
  // After an automatic handover: the first turn on the new account (the handoff note rides it).
  resumeAfterHandover() {
    this.submit(t('前のアカウントが週の上限に達したので、このアカウントで作業を引き継ぎました。引き継ぎメモをもとに、終わっていない作業を続けてください。'));
  }
  // The deterministic handoff for a switch: folder, the Focus work in flight, the todos
  // on screen, the files being changed, and the last turns of the old chat — everything
  // the other account's Muse needs to pick the work up (src/handoff.js). Best effort:
  // any piece that fails to read is simply left out.
  buildAccountHandoff(target, fromSession, fromLabel) {
    const a = this.agent;
    const sess = fromSession || a.session;
    let turns = [];
    try { turns = require('../sessions.js').transcript(sess?.id) || []; } catch {}
    // The full record stays on this PC: hand the new Muse the file's path (only when it
    // exists — a session with no finished turn has nothing to point at) and let it read
    // just the parts it needs, instead of folding the whole history into the note.
    let recordPath = '';
    try { const f = require('../sessions.js').transcriptFile(sess?.id); if (f && fs.existsSync(f)) recordPath = f; } catch {}
    let gitLines = null;
    try {
      const out = require('node:child_process').execFileSync('git', ['-C', a.cwd, 'status', '--porcelain'], {encoding: 'utf8', timeout: 3000, windowsHide: true});
      gitLines = String(out).split('\n').filter(Boolean);
    } catch {}
    let focus = null;
    try {
      const snap = a.focusRun?.focus?.snapshot?.() || a.lastFocus;
      if (snap && (snap.goal || snap.criteria?.length)) focus = {goal: snap.goal || '', criteria: (snap.criteria || []).map(c => ({text: c.text, status: c.status || ''}))};
    } catch {}
    return require('../handoff.js').buildHandoff({
      fromLabel: fromLabel || a.accountLabel || a.accountId || '', toLabel: target.label, cwd: a.cwd,
      sessionTitle: sess?.title || '', turns, todos: this.s.todos || [], focus, gitLines, recordPath,
    });
  }
  // From 10 points below the limit (90% by default) every tool call re-reads the plan (one
  // read at a time — refreshPlan shares one in flight; a read takes ~0.2-0.3 s), so the
  // footer follows the week and the limit question comes up while the task still runs.
  // Below that line nothing is read: the turn's end refresh is enough.
  watchQuota() {
    const a = this.agent, p = this.s.plan;
    if (!a.accountPool || !a.accountId || typeof p?.percentUsed !== 'number') return;
    let accounts;
    try { accounts = require('../accounts.js'); } catch { return; }
    if (p.percentUsed < Math.max(accounts.threshold() - 10, 0) && !accounts.exhausted({percentUsed: p.percentUsed, quotaStatus: p.quotaStatus})) return;
    const id = a.accountId;
    this.refreshPlan().then(np => {
      if (!np || a.accountId !== id) return;
      this.maybeWarnAccountQuota(np, id);
      if (accounts.exhausted({percentUsed: np.percentUsed, quotaStatus: np.quotaStatus})) this.askQuotaChoice(np, id, {midTurn: true});
    }).catch(() => {});
  }
  // The weekly limit reached on this window's account (accounts.exhausted): ask once per
  // account and week whether to keep going on the extra usage bought for it, or to move to
  // the lightest other account with a handoff (the same switch as /account, reserved for the
  // turn's end while one runs). "Keep" holds until the week resets; esc decides nothing and
  // the question comes back after the next turn. One account only: nothing to choose.
  // midTurn (from watchQuota): not over an approval, a question or another menu, and not while
  // the user is typing — an Enter meant for the input would pick an option. The next tool call
  // (or the turn's end) asks again.
  async askQuotaChoice(p, accountId, {midTurn = false} = {}) {
    const a = this.agent, id = a.accountId;
    if (!a.accountPool || !id || (accountId && accountId !== id) || this.accountSwitchReservation) return;
    // #157: these guards used to apply only to the mid-turn call — but the turn-end call
    // is async too (plan refresh + peek below), so it could open over an approval, a
    // reason, another menu, a prompt, or half-typed text just the same. They now guard
    // every call, before AND after the peek; the question simply comes back later.
    if (this.s.approval || this.s.reasonFor || this.s.question || this.s.menu || this.s.text || this.s.promptFor || this.s.limitInput) return;
    const kept = this.quotaKeep.get(id);
    if (kept && (!kept.resetsAt || Date.now() < kept.resetsAt)) return;
    if (this.s.menu?.quotaChoice) return;
    let multi = false;
    try { multi = require('../account-pool.js').multi(); } catch {}
    if (!multi) return;
    let next = null;
    try { next = a.accountPool.peek ? await a.accountPool.peek(new Set([id])) : null; } catch {}
    if (a.accountId !== id || this.accountSwitchReservation || this.s.menu?.quotaChoice) return;
    if (this.s.approval || this.s.reasonFor || this.s.question || this.s.menu || this.s.text || this.s.promptFor || this.s.limitInput) return;
    const accounts = require('../accounts.js');
    const target = next ? accounts.get(next.id) : null;
    const label = a.accountLabel || id;
    // Muse's own line for the extra ("0% used (3B tokens left)"); none bought is said plainly.
    const extra = p.topupBalance === 0 ? t('（追加購入分はありません）') : p.topupValue ? t('（追加: {value}）', {value: p.topupValue}) : '';
    const options = [{value: 'keep', label: t('このまま追加を利用する'), desc: t('{label} で続けます。追加購入分を使います', {label}) + extra}];
    // Mid-task the switch waits for the turn's end (a running turn lives on this account's Muse).
    if (target) options.push({value: 'switch', label: t('新しいアカウントで引き継ぐ'), desc: (this.s.busy || a.busy ? t('この作業が終わったら {label} に切り替え、引き継いだ新しいチャットで続けます', {label: target.label}) : t('{label} に切り替え、ここまでの作業を引き継いだ新しいチャットで続けます', {label: target.label})) + (typeof next.percentUsed === 'number' ? t('（週 {n}%）', {n: next.percentUsed}) : '')});
    // Unattended windows: after quotaWaitMs (60 s) without an answer, the /settings choice
    // decides (default: go on when extra usage was bought, otherwise hand over). Muse keeps
    // working while the question is up; only the switch waits for someone.
    const mode = quotaFallback();
    const fallback = mode === 'ask' ? null : mode === 'extra' || !target ? 'keep' : mode === 'handover' ? 'switch' : p.topupBalance > 0 ? 'keep' : 'switch';
    const decide = (v, auto = false) => {
      clearTimeout(this.quotaTimer);
      const waited = {n: Math.ceil(this.quotaWaitMs / 1000), label};
      if (v === 'keep') {
        // #164: with no resetsAt on the plan, "keep" used to hold FOREVER (the check
        // above treats a null resetsAt as unexpired) — one answer silenced the question
        // across week boundaries. Without a known reset, hold for a day and ask again.
        this.quotaKeep.set(id, {resetsAt: p.resetsAt || Date.now() + 24 * 3600 * 1000});
        // With nothing bought (and nowhere to hand over to), "using the extra" was not true.
        if (p.topupBalance === 0) return this.note(auto ? t('{n} 秒答えがなかったので、{label} でこのまま続けます（追加購入分はないため、上限で止まることがあります）。', waited) : t('{label} でこのまま続けます（追加購入分はないため、上限で止まることがあります）。', {label}));
        return this.note(auto ? t('{n} 秒答えがなかったので、{label} でこのまま続けます（追加購入分を使います）。', waited) : t('{label} でこのまま続けます（追加購入分を使います）。', {label}));
      }
      if (v === 'switch' && target) {
        if (auto) this.note(t('{n} 秒答えがなかったので、{target} に引き継ぎます。', {...waited, target: target.label}));
        return this.requestAccountSwitch(target, {hasLogin: true, device: true}, {auto});
      }
    };
    const fallbackLabel = fallback && options.find(o => o.value === fallback)?.label;
    const token = Symbol('quota');
    this.openMenu({quotaChoice: token, title: t('週間リミットが {n}% に到達しました', {n: p.percentUsed ?? 100}),
      hint: (target ? t('このまま追加を利用するか、新しいアカウントで引き継ぐか選んでください') : t('引き継げるアカウントがありません（どれも上限か未設定です。追加は `muser account add <名前>`）'))
        + (fallbackLabel ? ' · ' + t('{n} 秒答えがなければ「{action}」', {n: Math.ceil(this.quotaWaitMs / 1000), action: fallbackLabel}) : ''),
      options, pick: v => decide(v)});
    clearTimeout(this.quotaTimer);
    if (fallback) {
      this.quotaTimer = setTimeout(() => {
        if (this.s.menu?.quotaChoice !== token) return; // answered, or closed with esc
        this.menuBuf = ''; this.set({menu: null});
        decide(fallback, true);
      }, this.quotaWaitMs);
      this.quotaTimer.unref?.();
    }
  }
  // Once per account per quota week: when the weekly usage gets within 10 points of the limit,
  // say so — and name the account a handoff would move to — instead of the question
  // arriving unannounced at the limit. The week is the plan's resetsAt (the same
  // key quotaKeep uses): a bare per-account flag never warned again after a
  // reset, and marking before the peek() await ate the warning entirely when a
  // switch landed during the read (audit #49).
  async maybeWarnAccountQuota(p, accountId) {
    const a = this.agent;
    if (!a.accountPool || !a.accountId || this.accountSwitchReservation) return;
    if (accountId && accountId !== a.accountId) return; // the plan belongs to the account that was current when it was read
    const accounts = require('../accounts.js');
    const threshold = accounts.threshold();
    if (p.percentUsed == null || p.percentUsed < Math.max(threshold - 10, 0)) return;
    if (accounts.exhausted({percentUsed: p.percentUsed, quotaStatus: p.quotaStatus}, threshold)) return;
    const warned = this.quotaWarnedFor.get(a.accountId);
    if (warned && (!warned.resetsAt || Date.now() < warned.resetsAt)) return;
    let multi = false;
    try { multi = require('../account-pool.js').multi(); } catch {}
    if (!multi) return;
    let next = null;
    try { next = a.accountPool.peek ? await a.accountPool.peek(new Set([a.accountId])) : null; } catch {}
    // A switch during the read: this plan and this prediction belong to the old account.
    if (accountId && accountId !== a.accountId) return;
    // deep c1 #3: without a resetsAt the record used to hold forever (the guard
    // above treats null as unexpired), so the warning never came again — across
    // week boundaries, until a restart. quotaKeep's #164 fix is the twin: a day.
    this.quotaWarnedFor.set(a.accountId, {resetsAt: p.resetsAt || Date.now() + 24 * 3600 * 1000});
    const base = {label: a.accountLabel || a.accountId, n: p.percentUsed, threshold};
    this.note(next ? t('{label} の週の使用量が {n}% です（{threshold}% で、続けるか引き継ぐかを確認します）。引き継ぐなら {next} が軽いです。', {...base, next: next.label})
                   : t('{label} の週の使用量が {n}% です（{threshold}% で、続けるか引き継ぐかを確認します）。', base));
  }
  // Muse's real plan usage (src/usage.js plan()); one request at a time, failures keep the old value.
  refreshPlan() {
    // The demo is offline: it asked muse.ai for the real plan with the saved login (the footer of
    // `muser demo` showed the user's own weekly usage) at start and after every turn.
    if (this.agent.client?.status === 'demo') return Promise.resolve(null);
    // One request per account: a read still running for the account a switch just left was
    // shared with the new account's refresh, and its week landed in the new account's footer.
    const web = this.agent.web || undefined;
    if (this.planLoading && this.planLoadingWeb === web) return this.planLoading;
    this.planLoadingWeb = web;
    const loading = this.planLoading = usage.plan(web).then(p => { if ((this.agent.web || undefined) !== web) return null; this.set({plan: p}); return p; }).catch(() => null)
      .finally(() => { if (this.planLoading === loading) this.planLoading = null; });
    return loading;
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
      catch (e) { this.flash(''); return this.note(t('npm で新しい版を確認できませんでした（{error}）。', {error: e.message}), 'error'); }
      if (!update.newer(v, this.version)) { this.flash(''); this.set({update: null}); return this.note(t('muser は最新版です（v{version}）。', {version: this.version})); }
      this.flash(t('muser を更新しています（npm install -g muser-cli@latest）…'), 300000);
      const r = await update.install();
      this.flash('');
      if (!r.ok) return this.note([t('更新できませんでした:'), ...r.output.split('\n').slice(-6)], 'error');
      this.set({update: null});
      this.note(t('muser を {version} に更新しました。muser -c で開き直すと新しい版で続きから使えます。', {version: v ? 'v' + v : t('最新版')}));
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
    return this.openMenu({title: t('スキル'), hint: t('新しい会話から反映'), options, index: 0, pick: v => {
      const [kind, id, mode] = v.split(':');
      if (kind === 'skill') { const s = skills.load(a.cwd).find(x => x.name === id); if (s) { skills.setEnabled(id, !s.enabled); this.note(t(s.enabled ? '{name} をオフにしました' : '{name} をオンにしました', {name: id})); } }
      else { skills.setSourceEnabled(id, mode === 'on'); this.note(t(mode === 'on' ? '{source} のスキルをオンにしました' : '{source} のスキルをオフにしました', {source: id})); }
      this.skillsMenu();
    }});
  }
  // level: 'error' notes render red in the view; plain notes are gray.
  note(lines, level) { this.push({type: 'note', lines: [].concat(lines), ...(level ? {level} : {})}); }
  // /reload: restart on the current code and pick this conversation back up, so a fix made
  // during the session stops waiting for a manual restart. Work in flight would be cut
  // (and the queue lost), so it waits for a quiet moment instead of forcing it.
  reload() {
    if (!this.onReload) return this.note(t('この起動方法では /reload は使えません。'));
    // #170: the guard missed a pending decline reason, a running !command and an Edge
    // login in flight — a /reload arriving via the GUI send path cut all three silently.
    // deep c1 #2: the guard also missed a prompt (the account-add name question
    // is promptFor before addingAccount stands), an open picker (its picks and
    // notes live only here), a numeric input, bang / shell notes not yet sent
    // (they live only in memory), and a running background shell.
    if (this.s.busy || this.s.approval || this.s.reasonFor || this.s.bangRunning || this.loggingIn || this.addingAccount || this.queue.length || this.s.promptFor || this.s.question || this.s.limitInput || (this.bangNotes || []).length || (this.shellNotes || []).length || (this.s.shells || []).some(sh => sh.state === 'working' || sh.running) || (this.s.agents || []).some(a => a.state === 'working'))
      return this.note(t('作業中は再起動できません。終わってから /reload してください（キューや実行中の作業が消えてしまいます）。'));
    this.note(t('再起動します…'));
    return this.onReload();
  }
  slash(line) {
    // The argument is the rest of the line as typed: a multi-line task after /agent or /skill had
    // its line breaks and indentation squeezed into single spaces.
    const m = /^(\S+)\s*([\s\S]*)$/.exec(line), cmd = m[1], arg = m[2], a = this.agent;
    if (cmd === '/exit' || cmd === '/quit') return this.onExit();
    if (cmd === '/help') return this.push({type: 'help'});
    if (cmd === '/settings') return arg === 'agents' ? this.agentLimitsMenu() : this.settingsMenu();
    if (cmd === '/focus') {
      if (arg === 'off' || arg === 'on') {
        if (this.s.busy) return this.note(t('Focus の切替は作業が終わってから行ってください。'));
        a.focusEnabled = arg === 'on';
        a.resumeFocus = null; // an unfinished task from before the switch is not picked up by a later message
        return this.note(t('Focus 自動管理: {state}（このウィンドウのみ）', {state: a.focusEnabled ? 'on' : 'off'}));
      }
      if (arg) return this.note(t('使い方: /focus（状態） /focus on /focus off'));
      const focus = a.focusStatus?.();
      if (focus && focus.status !== 'inactive') return this.push({type: 'focus', focus, full: true});
      return this.note(t('Focus: {state}', {state: a.focusEnabled === false ? 'off' : 'on'}));
    }
    if (cmd === '/goal') {
      const g = a.standingGoal?.();
      if (!arg) return this.note(g ? [t('現在のゴール: {goal}', {goal: g.text}), t('（自動続行 {legs} leg ／ 解除は /goal clear）', {legs: g.legs || 0})] : t('ゴールは設定されていません。/goal <テキスト> で設定します'));
      if (arg === 'clear' || arg === 'done') { a.setGoal(null); return this.note(g ? t('ゴールを解除しました: {goal}', {goal: g.text}) : t('ゴールは設定されていません。/goal <テキスト> で設定します')); }
      const set = a.setGoal(arg);
      if (this.s.busy || a.busy) return this.note(t('ゴールを設定しました: {goal}（今の作業が終わったあと、ゴールに向けて続行します）', {goal: set.text}));
      this.note(t('ゴールを設定しました: {goal}', {goal: set.text}));
      if (!a.focusEnabled) return this.note(t('Focus がオフなので自動続行はしません。/focus on で有効になります。'));
      return this.submit(set.text);
    }
    if (cmd === '/login') return this.login();
    if (cmd === '/account') return this.accountCommand(arg);
    if (cmd === '/update') return this.runUpdate();
    if (cmd === '/reload') return this.reload();
    if (cmd === '/output') {
      if (!this.outputs.length) return this.note(t('まだ PC 操作の出力はありません。'));
      const list = [...this.outputs].reverse();
      return this.openMenu({title: t('PC 操作の出力'), index: 0,
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
      // With MUSER_LANG set the environment wins on the next start, so a change here is only
      // for this run — say so, instead of letting the user think it was saved for good.
      const langNote = v => t('言語を {lang} に切り替えました', {lang: v === 'en' ? 'English' : '日本語'}) +
        (process.env.MUSER_LANG ? ' ' + t('（MUSER_LANG が設定されているため、環境変数が優先されます。この切り替えは今回の実行中だけです）') : '');
      // /lang en switches at once (the argument used to be ignored and the menu opened).
      const want = ({en: 'en', english: 'en', ja: 'ja', jp: 'ja', japanese: 'ja', '日本語': 'ja'})[arg.toLowerCase()];
      if (want) { i18n.setLang(want); this.set({}); return this.note(langNote(want)); }
      return this.openMenu({
        title: t('表示言語'),
        options: [{value: 'en', label: 'English', desc: t('英語で表示')}, {value: 'ja', label: '日本語', desc: t('日本語で表示')}],
        index: i18n.lang() === 'en' ? 0 : 1, current: i18n.lang(),
        pick: v => { i18n.setLang(v); this.set({}); this.note(langNote(v)); },
      });
    }
    if (cmd === '/mode' || cmd === '/permissions' || cmd === '/perm') {
      // Any case, and the words people use for them (/mode Bypass, /mode auto, /mode readonly).
      const want = arg && modeFrom(arg);
      if (arg && !want) return this.note(t('モードは {modes}', {modes: MODES.join(' / ')}));
      if (want) { this.setMode(want); return this.note(t('承認モード: {label}', {label: t(LABELS[a.mode])})); }
      return this.openMenu({
        title: t('承認モード（権限）'),
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
      // #175/#176: shell notes/pending and the goal are the old chat's too — they were
      // left behind, so its shell completion leaked into the new chat's first message
      // and its goal stayed on screen (auto-continuing) in a chat that never set it.
      a.session = sessions.create(a.cwd); a.ctx.readFiles.clear(); a.ctx.todos = []; this.bangNotes = []; this.shellNotes = []; this.shellPending = false; this.bangPending = false; // allowAlways belongs to the folder, not the chat
      this.set({todos: [], focus: null, goal: a.standingGoal?.() || null});
      if (cmd === '/clear') return this.set({clearCount: this.s.clearCount + 1, entries: [{id: nextId++, type: 'banner'}]});
      return this.note(t('新しい会話を始めます。'));
    }
    if (cmd === '/resume') {
      // Switching chats under a running turn re-pointed that turn at the other chat (its reply
      // stopped streaming); until a turn can move to the background, wait for it.
      if (this.s.busy) return this.flash(t('作業中は切り替えられません'));
      // All of this folder's chats, not the first 9 (deep Part B R3 R1): the
      // menu itself windows long lists (12 rows plus a count of the rest) and its
      // digit buffer picks 10+ by number, so no slice is needed here — with
      // it, chats past the ninth were silently unreachable from the menu.
      const list = sessions.recent(a.cwd).filter(s => s.turns);
      if (!list.length) return this.note(t('このフォルダーの過去の会話はありません。'));
      // Another account's chat is marked before it is picked (it cannot be continued here; see showResumed).
      const elsewhere = s => { const id = s.account || 'default'; if (!a.accountId || id === a.accountId) return ''; try { return ' · ' + t('アカウント {label}', {label: require('../accounts.js').get(id)?.label || id}); } catch { return ''; } };
      if (!arg) return this.openMenu({title: t('会話を再開'), options: list.map(s => ({value: s.id, label: s.title || s.id, desc: new Date(s.updated).toLocaleString() + ' · ' + t('{n} ターン', {n: s.turns}) + elsewhere(s)})),
        pick: id => this.showResumed(sessions.find(id))});
      // A number is a line of the list; an id is looked up among this folder's chats only ("/resume 12"
      // matched any session whose id began with 12, another project's included).
      // #178: the hand-rolled prefix find silently resumed the NEWEST match, bypassing
      // sessions.find's ambiguity refusal. An exact id wins; a prefix matching several
      // of this folder's chats is refused and the candidates are named.
      const recentAll = sessions.recent(a.cwd);
      // A number within the list's range is its line (10+ included, now that
      // the list is no longer cut at 9); a number past the range falls
      // through to the id lookup, as a digit-led id prefix did before.
      const matches = /^\d+$/.test(arg) && Number(arg) >= 1 && Number(arg) <= list.length ? [list[Number(arg) - 1]] : recentAll.filter(x => x.id === arg || x.id.startsWith(arg));
      const s = matches.find(x => x.id === arg) || (matches.length === 1 ? matches[0] : null);
      if (!s && matches.length > 1) return this.note(t('候補が複数あります: {list} — もう少し長く指定してください', {list: matches.map(x => x.id).join(', ')}), 'error');
      if (!s) return this.note(t('見つかりません: {arg}', {arg}));
      return this.showResumed(s);
    }
    if (cmd === '/mcp') return this.mcpMenu();
    if (cmd === '/bg' || cmd === '/shells') {
      const [sub, id] = arg.split(/\s+/);
      if (sub === 'kill' && id) { try { a.shells.kill(id); return this.note(t('{id} を止めました', {id})); } catch (e) { return this.note(e.message, 'error'); } }
      const list = a.shells.all();
      if (!list.length) return this.note(t('バックグラウンドの処理はありません。'));
      return this.openMenu({title: t('バックグラウンドの処理'), hint: t('/bg kill <id> で停止'), options: list.map(x => ({value: x.id, label: x.id + '  ' + x.command.slice(0, 22), desc: (x.running ? t('● 実行中 ') : t('○ 終了 exit {exit} ', {exit: x.exit})) + (x.tail.filter(Boolean).pop() || '')})),
        pick: async id => {
          const r = await a.shells.output(id, {since: 0, maxChars: 200000});
          const full = frames(r.output).trimEnd();
          // The whole output is kept for /output; on screen only the last 30 lines, with the cut said.
          this.keepOutput({id: 'bg-' + id + '-' + Date.now(), command: 'shell.output', summary: id}, full);
          const lines = full.split('\n');
          this.push({type: 'shellout', id, running: r.running, exit: r.exit_code, cut: !!r.truncated || lines.length > 30, lines: lines.slice(-30)});
        }});
    }
    if (cmd === '/agent' || cmd === '/spawn') {
      const types = a.types();
      if (!arg) return this.note([t('使い方: /agent [型] <任せるタスク>   例: /agent explore 認証まわりの処理はどこ？'), t('型: {list}', {list: Object.entries(types).map(([k, v]) => k + '（' + t(v.description) + '）').join('  ')})]);
      const [, first, task] = /^(\S+)\s*([\s\S]*)$/.exec(arg), typed = types[first.toLowerCase()] && task;
      // A type name alone (/agent explore) started a general agent whose whole task was "explore".
      if (types[first.toLowerCase()] && !task) return this.note(t('使い方: /agent [型] <任せるタスク>   例: /agent explore 認証まわりの処理はどこ？'));
      try { const w = a.spawn(typed ? task : arg, {by: 'user', type: typed ? first : 'general'}); return this.note(t('エージェント {tag}（{type}）に任せました: {title}', {tag: w.tag, type: w.typeName, title: w.title})); }
      catch (e) { return this.note(e.message, 'error'); }
    }
    if (cmd === '/agents') {
      const list = a.agents();
      if (!list.length) return this.note(t('並列エージェントはいません。'));
      return this.openMenu({title: t('並列エージェント'), hint: t('作業中のものは選ぶと停止'), options: list.map(x => ({value: x.tag, label: x.tag + ' ' + x.type + '  ' + x.title, desc: ({working: t('作業中 {tool}', {tool: x.lastTool || ''}), done: t('完了'), failed: t('失敗 {error}', {error: x.error}), stopped: t('停止')})[x.state] || x.state})),
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
      return this.submit(skills.skillSentence(s.name) + ' ' + request);
    }
    if (cmd === '/status') return this.push({type: 'status'});
    // In the user's language: it is their message in the chat, and AGENTS.md came out in Japanese for English users.
    if (cmd === '/init') return this.submit(t('このリポジトリを調べて、AGENTS.md を作ってください（ビルド・テスト方法、構成、規約、注意点を簡潔に）。既にあれば足りないところを更新してください。'));
    const near = nearSlashCommand(cmd);
    if (near) return this.note(t('知らないコマンド: {cmd}。もしかして: {near}（/help で一覧）', {cmd, near}), 'error');
    this.note(t('知らないコマンド: {cmd}  （/help で一覧）', {cmd}), 'error');
  }
}

// The slash command a word was probably meant to be: at most 2 edits away (a swap counts as
// one) — the same rule as bin/muser.js's nearCommand for CLI subcommands.
export function nearSlashCommand(word) {
  const w = String(word || '').replace(/^\//, '').toLowerCase();
  if (w.length < 3) return null;
  const names = COMMANDS.map(([n]) => n.slice(1));
  if (names.includes(w)) return null;
  const dist = (a, b) => {
    const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  };
  let best = null, bestD = 3;
  for (const c of names) { const x = dist(w, c); if (x < bestD && x <= 2) { best = c; bestD = x; } }
  return best ? '/' + best : null;
}
