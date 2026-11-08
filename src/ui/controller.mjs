// UI state for the Ink view: turns agent events into an append-only list of finished entries
// (rendered once into scrollback through <Static>) plus the small live state at the bottom.
// Key handling lives here too, so the view is only drawing.
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMd, tableRows, tableWidths} from './md.mjs';
import {sanitizeEmbeds, stripEmbeds, stripControls, partialEmbedTail} from './sanitize.mjs';
import {memReportLines, writeHeapSnapshot} from './mem-report.mjs';
const require = createRequire(import.meta.url);
const {MODES, LABELS, alwaysKey, modeFrom} = require('../policy.js');
const MODE_HELP = {
  'default': '読むのは自動。編集とコマンドは毎回確認',
  'auto-edit': '作業フォルダー内の編集は自動。コマンドは確認',
  'plan': '読むだけ。編集と変更系のコマンドは断る',
  'bypass': '全部自動で実行（確認なし）',
};
const {TOOLS} = require('../tools.js');
const {slimToolCall} = require('../slim-call.js');
const sessions = require('../sessions.js');
const mcpConfig = require('../mcp.js');
const clip = require('../clipboard.js');
const mention = require('../mentions.js');
const usage = require('../usage.js');
const transcript = require('../transcript.js');
const permissions = require('../permissions.js');
const skills = require('../skills.js');
const update = require('../update.js');
const configStore = require('../config.js');
const {applyAgentLimits, switchValue, savedValue, setSwitch, envOverride, NUMBERS, numberValue, setNumber, defaultMode, setDefaultMode, QUOTA_FALLBACKS, quotaFallback, setQuotaFallback, FOCUS_LOG_LEVELS, focusLogLevel, setFocusLogLevel} = require('../settings.js');
const {FocusLog, logFile} = require('../focus-log.js');
// The 2026-11-07 feature cores (export, proof, lore, crash, parity, the
// work log's reader) are required inside the command methods that use
// them, not here: most windows never open those commands, and the
// modules should not ride every boot (the same pattern /hunt uses).
const {EXPECT_MODES, expectMode, setExpectMode} = require('../settings.js');
// 想定外ストップの動き (/settings)。record が既定（2026-11-07 に利用者が選択）。
const EXPECT_MODE_LABELS = {record: '記録だけ', stop: '記録して次の書き込みを1回止める', off: 'オフ'};
const EXPECT_MODE_HELP = {record: '予想が外れたら作業ログに記録し、結果と画面に「想定外」と出すだけ。作業は止めない（既定）', stop: '記録に加えて、次の書き込みを1回だけ止めて立て直させる', off: 'expect を受け取っても判定も記録もしない'};

// Focus の判定ログの記録のしかた (/settings)。
const FOCUS_LOG_LEVEL_LABELS = {off: '記録しない', normal: '判定と理由だけ', verbose: 'ツールの内容も（上限付き）'};
const FOCUS_LOG_LEVEL_HELP = {off: '判定ログを記録しません', normal: '判定とその理由だけを記録します（既定）', verbose: 'ツールの内容と結果の先頭も記録します（上限付き・秘密情報は記録しません）'};
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
  ['/focus', '完了条件と根拠を確認（自動で有効。/focus off・on で切替、/focus carry <会話の ID> で別会話のタスクを引き継ぎ）'],
  ['/settings', '設定（エージェント・Focus・ツール上限・承認モード・言語・ベル・更新確認・表示・スキル・MCP）'], ['/goal', '常設ゴールを設定（達成まで自動で続行。/goal で表示、/goal clear で解除）'],
  ['/help', 'コマンドとキー操作（!コマンド・@ファイル も）'], ['/permissions', '承認モード（権限）を選ぶ（/permissions bypass で直接。/mode・/perm でも可）'],
  ['/new', '新しい会話を始める'], ['/clear', '画面を消して新しい会話'], ['/resume', 'このフォルダーの過去の会話を再開'],
  ['/agent', '並列エージェントに任せる（/agent [explore|plan|review|test] <タスク>）'], ['/agents', '並列エージェントの一覧・結果・停止'], ['/bg', 'バックグラウンドの処理（/bg で一覧・出力、/bg kill bg1 で停止）'], ['/mcp', 'MCP サーバーのオン・オフと取り込み'], ['/image', '画像を添付（パスなしでクリップボードから）'], ['/todos', 'Muse の Todo'], ['/status', '接続とセッションの状態'], ['/init', 'AGENTS.md を Muse に書いてもらう'], ['/skills', 'スキルを管理する（一覧とオン・オフ。使うのは /skill）'], ['/skill', 'スキルを指定して頼む（/skill <名前> <頼みたいこと>。管理は /skills）'], ['/usage', 'Muse の利用状況（週の使用量）と muser の記録'], ['/export', '不具合の調べに使うレポートを開発者に送る（中身を見せてから）'], ['/login', 'muse.ai にログインし直す（Edge の窓が開きます）'], ['/account', 'アカウントの確認と切替・追加（/account <名前> で切替、なしで一覧、/account add で追加）'], ['/lang', '表示言語を切り替える（English / 日本語）'], ['/update', 'muser を最新版に更新する（npm）'], ['/reload', '新しいコードで再起動（会話は引き継ぎ）'], ['/output', 'PC 操作の出力を全文で見る（画面では一部だけ）'], ['/exit', '終了（/quit でも可）'], ['/debug', '判定ログを表示（/debug log、最新20件。/debug mem・/debug heap も）'], ['/worklog', 'この会話の作業ログを表示（最新20件）'],
  ['/proof', '裏取り（直前の返事を作業ログと突き合わせ。反証テストつき。/proof <ターン>・--yes）'],
  ['/lore', 'コードの言い伝えを見る（why・傷跡・墓標・仮説付箋）'], ['/why', 'その行がなぜ変わったか（/why <ファイル>:<行>）'],
  ['/hunt', 'バグ狩り（/hunt [範囲] で監査、/hunt fix High で修正、/hunt status で進み具合）'],
  ['/race', '競争（同じ頼みを N 体に違う方針でやらせて比べる。/race <頼み>）'],
  ['/overnight', '夜間作業（/overnight add <頼み> で積む。list・start・report）'],
  ['/crash', 'クラッシュ調査（直近の落下と直前の変更を突き合わせて Muse に調べさせる）'],
  ['/parity', '環境比較（この PC の指紋を表示。/parity diff <A> <B> で 2 つの指紋を比べる）'],
];

let nextId = 1;
const ATTACH_TOTAL = 11 * 1024 * 1024; // images per message, before base64 (the device link takes ~16 MB)
// The terminal bell on approvals and finished agents; off with MUSER_NO_BELL=1 or "bell": false in ~/.muser/config.json.
// Asked each time: /settings can turn it off while muser runs.
const bell = () => { let on = true; try { on = switchValue('bell'); } catch {} if (on) process.stdout.write('\x07'); };
const MAX_QUEUE = 5, MAX_HISTORY = 200, BANG_NOTE = 20000; // characters of a !command's output sent to Muse
const HISTORY_FILE = process.env.MUSER_HISTORY_FILE || path.join(os.homedir(), '.muser', 'history.json'); // tests point it elsewhere
const HISTORY_FILE_GIVEN = !!process.env.MUSER_HISTORY_FILE; // an explicitly redirected file is not the user's real history
// Memory reduction (docs/design/memory.md): history tool rows are slimmed on the way in
// (stage 1, src/slim-call.js), and the kept full outputs carry two separate caps on top
// of the 30-item one (stage 2). The memory cap (outputsMaxChars) governs only the text
// held in memory: overflow spills, oldest first, to this process's own folder under
// %LOCALAPPDATA%\muser\outputs\<pid> and is read back in full when /output asks for it —
// entries are never dropped to satisfy it. The disk cap bounds the spill folder itself:
// total spilled bytes stay within 4x the memory cap; past that the oldest spilled
// entries lose their files and remain as no-text entries (see spillOutputs).
const OUTPUTS_MAX_ITEMS = 30, OUTPUTS_MAX_CHARS = 4 * 1024 * 1024;
// Wave 18 (B): a finished agent's entry used to keep snap.result / snap.error
// in full, forever — scrollback entries are never trimmed, so 25 results of
// 1 MB held ~24 MB in entries long after the outputs caps had spilled or
// dropped the same text on the /output side. An agent entry now keeps only a
// preview: at most the 200 lines any draw shows (the e.full view) within a
// char budget. The full text lives in the outputs list — agent-done keeps it
// there via keepOutput and the stored snap points at it via snap.outputId —
// and /output reads it back in full. Untruncated snaps pass through by
// reference, like other entries.
const AGENT_PREVIEW_LINES = 200, AGENT_PREVIEW_CHARS = 64 * 1024;
function previewText(text) {
  const lines = text.split('\n');
  if (lines.length <= AGENT_PREVIEW_LINES && text.length <= AGENT_PREVIEW_CHARS) return text;
  const kept = []; let chars = 0;
  for (const line of lines) {
    if (kept.length >= AGENT_PREVIEW_LINES || chars + line.length + 1 > AGENT_PREVIEW_CHARS) break;
    kept.push(line); chars += line.length + 1;
  }
  if (!kept.length) kept.push(lines[0].slice(0, AGENT_PREVIEW_CHARS)); // a single line over the whole budget: hard-cut it
  return kept.join('\n');
}
function slimAgentSnap(snap) {
  if (!snap) return snap;
  let out = null;
  for (const field of ['result', 'error']) {
    if (typeof snap[field] !== 'string') continue;
    const p = previewText(snap[field]);
    if (p === snap[field]) continue;
    out = out || {...snap};
    out[field] = p; out[field + 'Omitted'] = snap[field].split('\n').length - p.split('\n').length;
  }
  return out || snap;
}
const slimEntry = e => {
  if (!e) return e;
  if (e.type === 'tool' && e.call) return {...e, call: slimToolCall(e.call)};
  if (e.type === 'agent' && e.snap) { const snap = slimAgentSnap(e.snap); return snap === e.snap ? e : {...e, snap}; }
  return e;
};
function defaultOutputsDir() { return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser', 'outputs', String(process.pid)); }
// Folders whose owning process is gone are removed by the next window that starts (the
// window-status rule). A folder whose pid was reused by a live process survives until
// that pid ends; it holds only tool output, and the owning window removes its own folder
// at exit, so leftovers stay bounded and harmless.
export function cleanupStaleOutputDirs(baseDir) {
  let names; try { names = fs.readdirSync(baseDir); } catch { return; }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let alive = false; try { process.kill(Number(name), 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
    if (!alive) { try { fs.rmSync(path.join(baseDir, name), {recursive: true, force: true}); } catch {} }
  }
}
// /output and ctrl+o copy the full text to %TEMP%\muser-output\<time>-<command>.txt
// on EVERY view (showOutput below): a convenience copy the user can open in an
// editor. Unlike the spill folder above it had no deletion path at all, so the
// copies piled up in the temp folder forever — and command output can hold
// secrets (audit-cli wave 5-A). They are swept when a Controller starts: a copy
// is kept only while it is BOTH fresh (modified within the last 24 h) and among
// the newest 50; anything older or beyond that count is deleted. The 24 h window
// leaves a file a note just pointed at openable for the rest of the day and the
// next morning; the count caps a single busy day. The spill files under
// %LOCALAPPDATA%\muser\outputs are a different store (stage 2 above) and are
// NOT touched here. Only *.txt files directly inside the folder are swept —
// every copy made here (and by the remote controller, which shares the folder)
// is one — other files and subfolders are left alone. Best-effort: a missing
// folder, a locked file or a racing window never fails startup.
export const TEMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TEMP_OUTPUT_MAX_FILES = 50;
export function cleanupStaleTempOutputs(dir = path.join(os.tmpdir(), 'muser-output'), now = Date.now()) {
  let names; try { names = fs.readdirSync(dir); } catch { return 0; }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    const file = path.join(dir, name);
    try { const st = fs.statSync(file); if (st.isFile()) files.push({file, mtimeMs: st.mtimeMs}); } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  files.forEach(({file, mtimeMs}, i) => {
    if (now - mtimeMs <= TEMP_OUTPUT_MAX_AGE_MS && i < TEMP_OUTPUT_MAX_FILES) return;
    try { fs.unlinkSync(file); removed++; } catch {}
  });
  return removed;
}
let outputsExitHook = false;
function hookOutputsExit(dir) { if (outputsExitHook) return; outputsExitHook = true; process.on('exit', () => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} }); }
// The most text the composer (or the picker's editor) will hold (deep c1 #11):
// the queue and the attachments are capped, but the draft was not — a multi-
// megabyte paste went in whole and every keystroke then re-rendered it. Past
// the cap, typing and pasting simply stop growing the text (paste says so).
const MAX_INPUT = 1000000;
function loadHistory() { return readHistoryDisk() || []; }
// Move a corrupt history file aside, in the sessions.json style
// (src/sessions.js backupCorruptFile): the original bytes survive as
// history.json.corrupt-<time> and the caller starts from an empty history,
// so new entries are recorded again from that moment on.
function backupCorruptHistory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.corrupt-' + stamp); return true; } catch { return false; }
}
// The history on disk, or null when the file is there but could not be READ
// (a lock, a permission problem): a read failure is not an empty history,
// and saving over it would replace everything with the newest entry alone
// (fifth audit f1-3, the read-side twin of the lost update below). A file
// that reads fine but is corrupt — unparseable, or valid JSON that is not
// an array — is a different case (wave 13): the old code returned null for
// a parse failure, so saveHistory refused every save and the input history
// was never recorded again, and a wrong-shaped file was silently replaced
// with no copy kept. Now it is moved aside (backupCorruptHistory) and the
// read answers empty, exactly as sessions.json treats a corrupt index —
// the bytes survive in the .corrupt-* file and recording resumes at once.
// (If the move itself fails, the read still answers empty: the save's own
// temp+rename then replaces the bad file instead of staying stuck.)
function readHistoryDisk() {
  let raw;
  try { raw = fs.readFileSync(HISTORY_FILE, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
  let h;
  try { h = JSON.parse(raw); } catch { backupCorruptHistory(); return []; }
  if (Array.isArray(h)) return h.filter(x => typeof x === 'string').slice(-MAX_HISTORY);
  backupCorruptHistory(); return [];
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
  let temp = null;
  try {
    const text = history[history.length - 1], disk = readHistoryDisk();
    if (disk === null) return; // unreadable right now: never overwrite it with just the newest entry
    if (typeof text === 'string' && disk[disk.length - 1] !== text) disk.push(text);
    fs.mkdirSync(path.dirname(HISTORY_FILE), {recursive: true});
    temp = HISTORY_FILE + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    // renameRetry, not a plain rename: a momentarily locked history.json (another window or a
    // reader holding it open) made the rename throw EPERM and the entry was silently lost, with
    // the temp file left behind. The swallow stays — history must not crash a turn — but only
    // after the retries are exhausted, and the temp is removed when the write ultimately fails.
    fs.writeFileSync(temp, JSON.stringify(disk.slice(-MAX_HISTORY))); configStore.renameRetry(temp, HISTORY_FILE); temp = null;
  } catch { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
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
  constructor({agent, museName, version, onExit, onReload, outputsDir, outputsMaxChars}) {
    this.heldSteps = []; this.outputs = [];
    this.outputsDir = outputsDir || defaultOutputsDir(); this.outputsMaxChars = outputsMaxChars || OUTPUTS_MAX_CHARS; this.outputSeq = 0;
    // Spill names carry a per-Controller tag: the default outputs dir is per-pid, so every
    // conversation in one resident Server shares it, and two Controllers spilling in the
    // same millisecond with the same per-instance seq used to write the SAME file — one
    // conversation's /output then served the other's text (master-debug #10).
    this.outputTag = Math.random().toString(36).slice(2, 8);
    cleanupStaleOutputDirs(path.dirname(this.outputsDir));
    cleanupStaleTempOutputs(); // wave 5-A: sweep stale /output copies in %TEMP%\muser-output (see above)
    if (!outputsDir) hookOutputsExit(this.outputsDir);
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
    this.history = loadHistory(); this.hIndex = -1; this.draft = ''; this.histEdits = {}; this.exitArmed = {key: null, at: 0}; this.queue = []; this.tabState = null; this.md = null; this.atPick = {key: null, idx: 0}; this.slashPick = {key: null, idx: 0}; this.dollarPick = {key: null, idx: 0}; this.dollarDismissed = null; this._skillCache = null;
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
  // Wave 18 (A) — why push still copies the whole array (O(N) per push, O(N²)
  // over a long conversation) instead of pushing in place: two consumers key
  // on the entries array's IDENTITY, so a mutated-in-place array silently
  // stops updating them.
  //  - Ink's <Static> (view.mjs) memoises items.slice(index) on [items,
  //    index] and advances index in an effect keyed on [items.length]: with
  //    the same reference the memo never recomputes for the new tail, and
  //    the advanced index then skips that tail for good — the entry never
  //    reaches the classic scrollback.
  //  - gui-server's onControllerChange streams appends only when the array
  //    reference changes (client.lastEntries !== entries): same reference,
  //    and remote / GUI clients are never sent the new entries.
  // The fullscreen renderer (fs/history.mjs) is length-based and would be
  // safe, but every view shares this one array, and both consumers above
  // live outside this file — in-place push waits on them learning a change
  // signal (a state version counter would do). Until then the copy IS the
  // change notification, so (A) is deliberately NOT fixed here.
  push(...entries) { this.set({entries: [...this.s.entries, ...entries.map(e => ({id: nextId++, ...slimEntry(e)}))]}); }
  flash(msg, ms = 2500) { this.set({flash: msg}); clearTimeout(this.flashTimer); this.flashTimer = setTimeout(() => this.set({flash: ''}), ms); }

  // ---- agent events ----
  wire() {
    const a = this.agent;
    a.approver = call => this.ask(call);
    a.on('device', d => this.set({deviceOk: !!d.connected}));
    // Wave 13: another window's mode change, picked up by the agent's next
    // judgment (refreshPermissions), reaches the footer too.
    a.on('permissions', ({mode}) => { if (mode && mode !== this.s.mode) this.set({mode}); });
    // Every node slot held: this window waits for one of its own instead of sharing the saved
    // id, and says so (the same words `muser exec` prints to its log).
    a.on('node-wait', ({max}) => this.flash(t('この PC の muser の端末枠（{max} 個）がすべて使用中です。空くのを待っています…', {max}), 60000));
    a.on('node-wait-done', ({slot}) => this.flash(t('端末枠 {slot} が空いたので使います。', {slot}), 10000));
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
      // The view's tail is the tool's own cut of its raw output (src/tools.js) and the
      // finished row draws it as-is: sanitise it line by line, exactly as the streaming
      // display above does, or an escape in the output (OSC 52, a screen-clearing CSI)
      // reaches the terminal when the row is written to scrollback.
      const done = {...call, outputLines: this.keepOutput(call, full)};
      if (Array.isArray(dv.tail)) done.view = {...dv, tail: dv.tail.map(l => stripEmbeds(frames(String(l ?? ''))))};
      this.push({type: 'tool', call: done});
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
      // Wave 18 (B): the entry itself stores only slimEntry's preview of the
      // snap; the full text is the outputs entry named by snap.outputId.
      let entrySnap = snap;
      if (body.trim()) {
        const outputId = 'agent-' + snap.tag + '-' + (snap.ended || Date.now());
        this.keepOutput({id: outputId, command: 'agent.spawn', summary: snap.tag + ' ' + (snap.title || '')}, body);
        entrySnap = {...snap, outputId};
      }
      this.push({type: 'agent', snap: entrySnap}); bell();
    });
    // #167: sawText is per-turn state. Resetting it only in submit() left auto-continued
    // legs and turns driven from other surfaces judged by the PREVIOUS turn's flag, so a
    // reply that never streamed was never shown by the turn-end safety net either.
    a.on('turn-start', () => { this.sawText = false; this.resumeEpoch = (this.resumeEpoch || 0) + 1; this.planAtTurn = this.s.plan?.percentUsed ?? null; this.doneStreams?.clear(); });
    // An account switch (automatic failover or /account): the plan on screen belonged to the
    // old account, and the new account's Muse may carry another name.
    a.on('account', ev => {
      usage.resetWeb?.();
      // Wave11 (1): shell-completion notes still pending belong to the OLD session.
      // They must not be sent to the new account's Muse as an automatic turn (nor
      // ride the next user message via submit's extra): show them on screen as a
      // plain note only, and clear shellNotes/shellPending for the new session.
      const pendingShell = this.shellNotes || [];
      if (pendingShell.length) {
        const cmds = pendingShell.map(n => { const id = (/<task-id>([^<]*)<\/task-id>/.exec(n) || [])[1] || ''; const st = (/<status>([^<]*)<\/status>/.exec(n) || [])[1] || ''; return (id + ' ' + st).trim(); }).filter(Boolean);
        this.note(t('前の会話のバックグラウンド処理の完了通知は、新しい会話には送りませんでした') + (cmds.length ? ': ' + cmds.join(', ') : ''));
      }
      this.shellNotes = []; this.shellPending = false;
      // Any switch satisfies a pending reservation, whichever account it landed on.
      this.accountSwitchReservation = null;
      // #159: a quota question (and its unattended fallback timer) belongs to the account
      // that hit the limit. Left open across a switch, its timer/keep would decide for the
      // OLD account on the new account's screen.
      clearTimeout(this.quotaTimer); this.quotaTimer = null;
      if (this.s.menu?.quotaChoice) this.set({menu: null});
      // W2F-1: the same goes for every other pending answer of the OLD
      // account — an approval (shown, in its decline-reason stage, or
      // queued), a selectable question, a numeric limit input and a
      // composer prompt. Left open across the switch, the old approval
      // could still be allowed on the new account's screen. Expire them
      // on the deny / cancel side, like a timeout does.
      for (const req of [this.s.approval, this.s.reasonFor, ...(this.pending || [])]) if (req && !req.done) { try { req.resolve({allow: false, expired: true}); } catch {} }
      this.pending = [];
      if (this.s.reasonFor) this.restoreDraft();
      if (this.s.promptFor) this.cancelPrompt();
      if (this.s.approval || this.s.reasonFor || this.s.question || this.s.limitInput) this.set({approval: null, reasonFor: null, question: null, limitInput: null});
      // Wave 16 (4): attachments composed for the old account's chat are
      // cleared too — left in place, the next send silently carried them
      // into the new account's chat.
      this.set({account: {id: ev.id, label: ev.label}, plan: null, accountReserved: null, attachments: []});
      // A switch the agent started itself (failover) has no handoff yet: build it from
      // the session it just left, so the new account's Muse still gets the context.
      if (!a.pendingHandoff && ev.fromSession) {
        // The session as saved (its title too: the note named no session after a failover).
        let from = null; try { from = sessions.find(ev.fromSession); } catch {}
        try { a.pendingHandoff = this.buildAccountHandoff({label: ev.label}, from || {id: ev.fromSession, title: ''}, require('../accounts.js').get(ev.from)?.label || ev.from || '', {agents: ev.orphans || a.lastSwitchOrphans || []}) || undefined; } catch {}
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
      // Wave 16 (3): the expirations above are what blocked the held queue
      // (deep c1 #9), but nothing ever drained it after a failover — held
      // messages sat until some later turn happened to end. Drain now,
      // the way closeQuestion resumes held work. The agent emits 'account'
      // before its own _switching clears (and a controller-side switch
      // clears accountSwitching only after that promise settles), so a
      // message drained here may be re-held by submit's switch guard;
      // retry once on the next tick, when both flags are down.
      if (!this.drainQueueOnce() && this.bangPending) this.sendBangNotes();
      if (this.queue.length && (this.accountSwitching || a._switching)) setTimeout(() => { if (!this.drainQueueOnce() && this.bangPending) this.sendBangNotes(); }, 0);
    });
    // A background shell that ends starts the work again on its own (see onShellFinished).
    a.shells?.on?.('finished', s => this.onShellFinished(s));
    // A message sent mid-turn reached Muse inside a tool result: it leaves the queue, so the
    // turn's end does not send it a second time.
    a.on('steer', ({texts} = {}) => {
      // The queue holds what the user typed (see submit: a $skill text is
      // queued in its typed form), while the agent's steer texts are the
      // expanded sendText — match a delivered text against the expansion
      // of each queued entry as well as against the entry itself.
      for (const tx of texts || []) { let i = this.queue.indexOf(tx); if (i < 0) i = this.queue.findIndex(q => this.sendTextFor(q) === tx); if (i >= 0) this.queue.splice(i, 1); }
      // Delivered: Muse has it and answers it inside the work, so Focus goes on. Only messages
      // still waiting in the queue stop the task after this round (2026-11-03: a clarification
      // Muse had already answered ended the turn as "a new user message is queued").
      this.agent.focusInputPending = this.queue.length > 0;
      this.set({queue: [...this.queue]});
      this.note(t('作業中の Muse に伝えました'));
    });
    // tell: one line per delivery batch, whichever surface renders this controller
    // (fullscreen, classic, and the GUI through the server snapshot of its entries).
    a.on('tell', ({messages, working} = {}) => {
      const m = (messages || [])[0]; if (!m) return;
      // Peer-controlled strings: strip terminal escapes like any other
      // outside text (sanitize.mjs), and cut by code points so an emoji at
      // the boundary is not split into a lone surrogate.
      const who = stripControls(m.from?.name || m.from?.title || String(m.from?.sessionId || '').slice(0, 8) || '?');
      const text = [...stripControls(String(m.text || '')).replace(/\s+/g, ' ')].slice(0, 80).join('');
      this.note(t('別の muser（{name}）から指示が届きました: {text}', {name: who, text}) + (messages.length > 1 ? t(' ほか {n} 件', {n: messages.length - 1}) : '') + (working ? '' : t('（空のまま Enter で進めます）')));
    });
    // tell: the claim guard stopped a write once. Muse is told in the tool result; the user
    // sees it here too (with bypass there is no approval screen to show the claimant).
    a.on('tell-claim', ({name, file} = {}) => {
      this.note(t('{name} が担当中のファイルなので、書き込みを 1 回止めました: {file}', {name: stripControls(String(name || '?')), file: stripControls(String(file || ''))}));
    });
    a.on('turn-end', e => {
      this.lastTurnEnd = e; // an automatic handover resumes a turn that failed (askQuotaChoice)
      this.set({activity: '', museRunning: '', spinnerWord: null});
      this.flushStream();
      // Safety net: if no text streamed this turn, show the final reply that the turn ended with.
      if (e.ok && !this.sawText && e.text?.trim()) {
        const md = createMd();
        const src = sanitizeEmbeds(e.text.trimEnd());
        this.push({type: 'md', rows: md.rows(src.split('\n')), src, first: true}, {type: 'gap'});
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
        // Focus fix: the ask content is part of the key — resumeLeg restarts
        // rounds at 1 and ask/plan/checkpoint do not bump revision, so the
        // bare id:round:revision key repeats when the same question is
        // re-asked early in a resumed leg and the dedupe swallowed the new
        // ask. The exact same ask re-delivered in the same state still
        // serialises identically and dedupes as before.
        const askKey = e.focus.id + ':' + e.focus.round + ':' + e.focus.revision + ':' + JSON.stringify(e.focus.ask ?? null);
        if (this.questionShownFor !== askKey) { this.questionShownFor = askKey; this.openQuestion(e.focus.ask); }
      }
      // Local tally heads-up: today's turns reached the daily limit (if one is set).
      // W2F-5: the warned key is the day AND the limit, not a lifetime flag —
      // a new day, or a changed limit, re-arms the warning.
      try { const lim = usage.limits(); const warnKey = new Date().toDateString() + ':' + lim.dailyTurns; if (e.ok && lim.dailyTurns > 0 && this.usageWarned !== warnKey && usage.summary().today.turns >= lim.dailyTurns) { this.usageWarned = warnKey; this.note(t('今日のターン上限（{n}）に達しました', {n: lim.dailyTurns})); } } catch {}
      // The real weekly usage, refreshed after every turn; say how much this turn moved it.
      const before = this.planAtTurn;
      const accountAtEnd = this.agent.accountId;
      this.refreshPlan().then(p => {
        // The diff is rounded to one decimal (the most the plan's own percent carries,
        // usage.js formatPercent): the raw subtraction printed float artifacts such as
        // +0.20000000000000107% for a 41.9 → 42.1 move.
        if (p && before !== null && before !== undefined && p.percentUsed > before) this.note(t('Muse の週の使用量 {before}% → {after}%（この作業で +{diff}%）', {before, after: p.percentUsed, diff: Math.round((p.percentUsed - before) * 10) / 10}));
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
        } else if (this.queue.length && !this.s.question) { const next = this.queue.shift(); this.agent.dropSteer?.(this.sendTextFor(next)); this.agent.focusInputPending = this.queue.length > 0; this.set({queue: [...this.queue]}); this.submit(next); }
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
    if (!st) {
      this.md = createMd();
      // A message that already ended this turn can still get a late update
      // (2026-11-08: the first half's final text arrived after the second
      // half had started, and a fresh stream re-printed the whole first
      // half). Resume from what was already shown: only the new suffix is
      // emitted, and an unchanged text emits nothing.
      const prev = this.doneStreams?.get(id);
      st = prev ? {id, done: prev.clean.length, partial: '', started: true, emitted: prev.clean, raw: prev.raw, clean: prev.clean, resumed: true} : {id, done: 0, partial: '', started: false, emitted: '', raw: '', clean: ''};
    }
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
    let started = st.started, done = st.done, srcHeld = st.srcHeld || '';
    if (nl >= 0) {
      // Table lines are held by the renderer until the table ends (shown meanwhile in the live
      // area, via stream.table), so a chunk can complete lines and still print nothing yet.
      const src = rest.slice(0, nl);
      const rows = this.md.feed(src.split('\n'));
      // A table's lines are held (no rows yet), but their source must still travel: it rides
      // the next piece that has rows, or the message's last piece (endMessage).
      srcHeld = srcHeld ? srcHeld + '\n' + src : src;
      if (rows.length) { this.push({type: 'md', rows, src: srcHeld, first: !started}); srcHeld = ''; started = true; }
      done += nl + 1;
    }
    this.set({stream: {id, done, started, partial: clean.slice(done), emitted: clean.slice(0, done), raw: text, clean, table: [...this.md.pending], srcHeld}});
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
    // Wave 13: the preview keeps the column widths it first showed for this
    // table. tableRows() alone re-sets the whole table from the lines present,
    // so a wider row arriving later moved every border in the rows already on
    // screen. The widths freeze at the first preview of the table (keyed by
    // the stream id and the table's first line; a shorter table than the
    // frozen one is a new table) and wider cells are cut to them; the printed
    // table at the end is set again at its true widths (md.flush, no freeze).
    let table = [];
    if (st.table?.length) {
      const fz = this._pvTable;
      if (!fz || fz.id !== st.id || fz.head !== st.table[0] || st.table.length < fz.len) this._pvTable = {id: st.id, head: st.table[0], len: st.table.length, widths: tableWidths(st.table)};
      else fz.len = st.table.length;
      table = tableRows(st.table, this._pvTable.widths);
    } else this._pvTable = null;
    return {row, first: !st.started, table};
  }
  flushStream() { if (this.s.stream) this.endMessage(this.s.stream.id); }
  endMessage(id) {
    const st = this.s.stream; if (!st || st.id !== id) return;
    // Flush from the raw text so a fragment held back mid-token resolves here (sanitize turns an
    // unfinished trailing token into the placeholder instead of leaking `[[hatch_...`).
    const tail = st.raw != null ? sanitizeEmbeds(st.raw).slice(st.done) : st.partial;
    const rows = [...(tail ? this.md.feed(tail.split('\n')) : []), ...this.md.flush()];
    const src = [st.srcHeld, tail].filter(x => x).join('\n');
    // A whitespace-only tail (a resumed message whose late update only added
    // a trailing space) is not an entry of its own.
    if (rows.length && (tail.trim() || (st.srcHeld || '').trim())) this.push({type: 'md', rows, src, first: !st.started});
    // Remember what this message has shown in full, so a late update for the
    // same id resumes instead of re-printing (see onText).
    if (typeof st.raw === 'string') {
      this.doneStreams ??= new Map();
      this.doneStreams.set(id, {raw: st.raw, clean: sanitizeEmbeds(st.raw)});
      while (this.doneStreams.size > 50) this.doneStreams.delete(this.doneStreams.keys().next().value);
    }
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
      const req = {call, preview, options, index: 0, outside, loreGrave: call.loreGrave || null};
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
    if (why === 'stopped') this.note(t('承認待ちだった {what} は取りやめました。', {what}));
    else this.note(t('{what} は行いませんでした（承認が間に合いませんでした）。', {what}));
    if (!this.s.approval && !this.s.reasonFor) this.nextApproval();
  }
  // Declining with a reason borrows the input; what the user was typing comes back after.
  restoreDraft() { const d = this.reasonDraft; this.reasonDraft = null; if (d) this.setText(d.text, d.pos); }
  nextApproval() {
    const next = this.pending?.shift();
    if (next) this.set({approval: next});
  }
  answer(i) {
    const a = this.s.approval, o = a?.options?.[i];
    if (!a || !o) return; // already expired (e.g. an account switch took it): nothing to answer
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
    // Wave 15: importing writes the real mcp.json — in the demo it refuses,
    // like the other demo guards (the toggle below already refuses there:
    // the demo agent has no mcp hub).
    if (v.import) { if (a.client?.status === 'demo') return this.note(t('デモでは MCP サーバーを取り込めません。')); mcpConfig.importServers(mcpConfig.discover()); this.note(t('取り込みました（すべてオフ）。')); return this.mcpMenu(); }
    if (this.s.busy) return this.flash(t('作業中は切り替えられません'));
    const cfg = mcpConfig.setEnabled(v.toggle, v.on), s = cfg.mcpServers[v.toggle];
    try {
      if (v.on) {
        this.flash(t('{name} に接続しています…', {name: v.toggle}), 15000);
        // Wave 15: no second connect here — setEnabled() above already applied
        // the toggle live (the hub's applyEnabled started the connect; mcp.js
        // joins an in-flight connect now, but the extra front-door call was
        // still a duplicate). Wait for the entry that live apply started to
        // settle instead, and surface its error the way the direct connect's
        // throw was surfaced.
        const deadline = Date.now() + 30000;
        for (;;) {
          const cur = a.mcp.servers.get(v.toggle);
          if (!cur || cur.status === 'connected') break;
          if (cur.status === 'error') throw new Error(cur.error || v.toggle);
          if (Date.now() > deadline) break;
          await new Promise(r => setTimeout(r, 100));
        }
      }
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
    // Wave 14: a broken config.json (read as the defaults, or already moved aside by a
    // save) is said once, here where the defaults are on show — not silently.
    try { configStore.read(); const cn = configStore.takeCorruptNotice(); if (cn) this.note(cn.dest ? t('設定ファイルが壊れていたため、{dest} に退避しました。いまは既定値で表示しています。', {dest: String(cn.dest).split(/[\\/]/).pop()}) : t('設定ファイルが壊れていて読めなかったため、既定値で表示しています。保存すると、壊れたファイルは退避されます。'), 'error'); } catch {}
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
      {value: 'focus', group: G.work, label: t('Focus（完了条件の自動管理）'), desc: onOff(savedValue('focus')) + '  ' + t('（保存した値です。選ぶと保存も切り替わります。/focus はこの窓だけの切替です）')},
      {value: 'focusRounds', group: G.work, label: t('Focus の自動続行の回数'), desc: num('focusRounds')},
      {value: 'focusMinutes', group: G.work, label: t('Focus の自動続行の時間'), desc: num('focusMinutes', n => t('{n} 分', {n}))},
      {value: 'focusLogLevel', group: G.work, label: t('Focus の判定ログ'), desc: t(FOCUS_LOG_LEVEL_LABELS[focusLogLevel()])},
      {value: 'worklog', group: G.work, label: t('作業ログを残す'), desc: sw('worklog')},
      {value: 'worklogDays', group: G.work, label: t('作業ログの保持日数'), desc: num('worklogDays', n => t('{n} 日', {n}))},
      {value: 'expectMode', group: G.work, label: t('想定外ストップ'), desc: t(EXPECT_MODE_LABELS[expectMode()])},
      {value: 'lore', group: G.work, label: t('コードの言い伝え（lore）'), desc: sw('lore')},
      {value: 'bangAutoSend', group: G.work, label: t('! の結果を Muse に送る'), desc: sw('bangAutoSend')},
      {value: 'bgAutoResume', group: G.work, label: t('バックグラウンド完了で自動再開'), desc: sw('bgAutoResume')},
      {value: 'maxToolCallsPerTurn', group: G.limits, label: t('1ターンのツール呼び出し上限'), desc: num('maxToolCallsPerTurn', n => t('{n} 回', {n}))},
      {value: 'maxNodeSlots', group: G.limits, label: t('端末枠の上限'), desc: num('maxNodeSlots', n => t('{n} 個', {n}))},
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
      {value: 'kitty', group: G.display, label: t('拡張キー入力'), desc: nextStart('kitty')},
      {value: 'fullscreen', group: G.display, label: t('全画面表示（スクロールは muser 内）'), desc: nextStart('fullscreen')},
      {value: 'bell', group: G.notify, label: t('承認・完了時のベル'), desc: sw('bell')},
      // A git checkout (npm link while developing) is never checked (src/update.js): "on" alone was not true there.
      {value: 'updateCheck', group: G.notify, label: t('起動時に更新を確認'), desc: sw('updateCheck') + '  ' + t('（次回起動から）') + (switchValue('updateCheck') && update.devCheckout() ? '  ' + t('（開発用のチェックアウトなので確認しません）') : '')},
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
      if (key === 'focusLogLevel') {
        return this.openMenu({title: t('Focus の判定ログ'),
          options: FOCUS_LOG_LEVELS.map(v => ({value: v, label: t(FOCUS_LOG_LEVEL_LABELS[v]), desc: t(FOCUS_LOG_LEVEL_HELP[v])})), index: FOCUS_LOG_LEVELS.indexOf(focusLogLevel()), current: focusLogLevel(),
          pick: v => { try { setFocusLogLevel(v, {save: !demo}); } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); } this.settingsMenu(at); }});
      }
      if (key === 'expectMode') {
        return this.openMenu({title: t('想定外ストップ'),
          options: EXPECT_MODES.map(v => ({value: v, label: t(EXPECT_MODE_LABELS[v]), desc: t(EXPECT_MODE_HELP[v])})), index: EXPECT_MODES.indexOf(expectMode()), current: expectMode(),
          pick: v => { try { setExpectMode(v, {save: !demo}); } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); } this.settingsMenu(at); }});
      }
      if (key === 'defaultMode') {
        return this.openMenu({title: t('新しいフォルダーの承認モード'),
          options: MODES.map(m => ({value: m, label: t(LABELS[m]), desc: t(MODE_HELP[m]), danger: m === 'bypass'})), index: MODES.indexOf(defaultMode()), current: defaultMode(),
          pick: m => { try { setDefaultMode(m, {save: !demo}); } catch (e) { this.note(t('設定を変更できませんでした: {error}', {error: e.message}), 'error'); } this.settingsMenu(at); }});
      }
      if (key === 'focus') {
        if (this.s.busy) { this.note(t('Focus の切替は作業が終わってから行ってください。')); return this.settingsMenu(at); }
        // Saved first, then this window follows: a failed save used to leave the window
        // switched while the note said nothing had changed. Wave 14: the flip is of the
        // SAVED value (the row shows it too), not this window's state — a window that
        // /focus had switched alone used to flip from its own state and save the
        // opposite of what the row showed.
        const next = !savedValue('focus');
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
    // A menu with pages to the side (/resume: other folders) turns them with ← / →.
    if ((k.leftArrow || k.rightArrow) && typeof m.side === 'function') return m.side(k.leftArrow ? -1 : 1);
    // A pick that throws becomes a note instead of an uncaught error that ends muser: the
    // config and sessions stores now refuse to write when another window holds their lock
    // (phase 2), and some picks (/skills on/off) wrote without a catch of their own.
    const failed = e => this.note(t('設定を変更できませんでした: {error}', {error: e?.message || String(e)}), 'error');
    // The picked option itself rides along as pick's second argument: a menu
    // whose values are not unique (two /resume entries sharing one session
    // id, wave 8 (3)) can then act on the very row the user picked instead
    // of looking its value up again. Picks that take one argument are
    // unaffected.
    const pick = i => { this.menuBuf = ''; clearTimeout(this.menuTimer); this.set({menu: null}); try { const r = m.pick(m.options[i].value, m.options[i]); if (r && typeof r.catch === 'function') r.catch(failed); } catch (e) { failed(e); } };
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
  // Wave 16 (4): drop the held queue for a conversation transition (/new,
  // /resume): the entries were written for the chat being left and must not
  // be delivered into the new one. The drop is said out loud — how many
  // were cancelled — never silent.
  dropQueueForTransition() {
    const n = this.queue.length;
    if (!n) return;
    this.queue = [];
    this.queuedQuestionAnswers = [];
    this.agent.focusInputPending = false;
    this.set({queue: []});
    this.note(t('前の会話で待っていた {n} 件を取り消しました', {n}));
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
  // Wave 14: a window started with an explicit --mode (modeExplicit) is
  // per-window: its mode changes apply to this window only and are NOT
  // saved to the shared file, so they never rewrite every other window's
  // (and every future window's) remembered default. Callers that announce
  // the change check modeExplicit and say it is this window only.
  // A save can also fail by THROWING (a lock held by another window, an
  // EEXIST from the lock's mkdir): that is a failed save too — permissions
  // now reports it as false, and the try here keeps any other throw from
  // escaping to the screen's generic catch as raw lock text. Either way
  // the window rolls back to the previous mode and notes the failure.
  setMode(m) {
    const prev = this.agent.mode;
    this.agent.mode = m; this.set({mode: m});
    if (this.agent.modeExplicit || this.agent.client?.status === 'demo') return true;
    let saved;
    try { saved = permissions.saveMode(this.agent.cwd, m); } catch { saved = false; }
    if (!saved) {
      this.agent.mode = prev; this.set({mode: prev});
      this.note(t('承認モードを保存できませんでした。ファイルを確認してください。'));
      return false;
    }
    return true;
  }
  cycleMode() {
    const next = MODES[(MODES.indexOf(this.agent.mode) + 1) % MODES.length];
    const ok = this.setMode(next);
    // Cycling is normally silent (the footer shows the new mode), but in a
    // --mode window the change is this window only — say so, or it looks
    // like the shared default moved. A failed save already noted itself
    // (and rolled back) inside setMode.
    if (ok && this.agent.modeExplicit) this.note(t('承認モード: {label}（この窓だけです）', {label: t(LABELS[next])}));
    return ok;
  }

  // ---- input ----
  setText(text, pos = text.length) { this.set({text, pos}); }
  insert(t) { const {text, pos} = this.s; const add = t.slice(0, Math.max(0, MAX_INPUT - text.length)); this.setText(text.slice(0, pos) + add + text.slice(pos), pos + add.length); }
  // Wave 10: the per-entry draft of a history entry being browsed (the shell's
  // behaviour). An entry recalled with ↑ and then edited used to lose the edit
  // the moment ↑/↓ moved away — setText simply replaced it. The edit is kept
  // here, keyed by history index, while browsing lasts; the stored history is
  // untouched (sending still appends the edited text as a new entry, and the
  // map is dropped then, since a push can shift the indices it keys on).
  saveHistEdit() {
    if (this.hIndex < 0 || this.hIndex >= this.history.length) return;
    if (this.s.text === this.history[this.hIndex]) { if (this.histEdits) delete this.histEdits[this.hIndex]; }
    else (this.histEdits ||= {})[this.hIndex] = this.s.text;
  }
  histText(i) { return this.histEdits?.[i] ?? this.history[i]; }
  paste(t) {
    if (this.s.limitInput) {
      const edit = this.s.limitInput, digits = t.trim();
      if (!/^\d+$/.test(digits)) return this.flash(i18n.t('0 以上の整数を入力してください（0 は無制限）'));
      return this.set({limitInput: {...edit, selected: false, text: (edit.selected ? '' : edit.text) + digits}});
    }
    // #158: while a decline reason is being typed the composer belongs to it, even if a
    // menu opened meanwhile — the paste goes to the reason, not nowhere.
    // Wave 8 (4): a bracketed paste landing on an approval, a menu or the
    // question list used to be dropped in silence — the user could not tell
    // it had not gone anywhere. Refusals now say so on the flash line; the
    // paste itself still goes nowhere on those screens.
    if (this.s.approval || (this.s.menu && !this.s.reasonFor)) return this.flash(i18n.t('この画面では貼り付けできません')); // i18n.t: this method's argument is named t
    if (this.s.question) {
      // Into the picker's text modes (type-something / notes); the list itself takes no paste.
      // Sanitised like any paste (stripControls), then flattened to one line, as typed input is.
      const q = this.s.question;
      if (q.mode === 'list') return this.flash(i18n.t('この画面では貼り付けできません'));
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
    // The events ring records the KIND of key only (src/ui/event-ring.js):
    // a typed character is 'char', never the character itself.
    try { this.eventRing?.recordKey(input, k); } catch {}
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
      // Wave 10: the $ and @ completions belong to chat lines only. On a ! line
      // $ is a shell variable (completing it rewrote the command instead of
      // running it) and on a / line neither $ nor @ is expanded at submit, so
      // Enter there must send the line as typed. The line's mode is read the
      // same way submit reads it: trimStart, then the first mark decides.
      const lead = text.trimStart();
      const chatLine = !lead.startsWith('!') && !lead.startsWith('/');
      // Enter while the $skill list is open completes to '$name ' instead of
      // sending, exactly as with @ above.
      const dctx = chatLine ? this.dollarContext(text, pos) : null;
      if (dctx?.list.length) return this.applyDollarPick(dctx.frag, dctx.list[this.dollarIndex(dctx.frag.fragment, dctx.list.length)]);
      const ctx = chatLine ? this.atContext(text, pos) : null;
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
      this.setText(''); this.hIndex = -1; this.histEdits = {}; // browsing ends; a push below can shift the indices the edits key on
      if (this.s.reasonFor) return this.submitReason(text);
      if (this.s.promptFor) return this.submitPrompt(text);
      if (!text.trim() && !this.s.attachments.length) {
        // tell: a message that arrived while idle waits for the next turn; an empty Enter
        // sends it on its own (the arrival line says so). Nothing waiting: Enter does nothing.
        if (!this.s.busy && this.agent?.pendingTell?.length) return this.submit(t('別の muser から届いた指示を進めてください。'));
        return;
      }
      if (this.history[this.history.length - 1] !== text) { this.history.push(text); if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY); if (this.agent.client?.status !== 'demo' || HISTORY_FILE_GIVEN) saveHistory(this.history); } // wave 15: in the demo the history stays in memory only — a demo run must not write the real history file (an explicitly redirected file is not the real one)
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
        if (!lineStart) {
          // Wave 8 (5): the text on screen is a recalled history entry
          // (hIndex >= 0) — line movement owned ↑ on every line, so from
          // the first line there was no way back to the older entries and
          // the user was trapped in this one. On the first line, ↑ keeps
          // browsing history instead, exactly as in a single-line entry.
          if (this.hIndex > 0) { this.saveHistEdit(); this.hIndex--; return this.setText(this.histText(this.hIndex)); }
          return;
        }
        const prevEnd = lineStart - 1, prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
        return this.set({pos: prevStart + offsetAtClusterCol(text.slice(prevStart, prevEnd), col)});
      }
      const lineEnd = text.indexOf('\n', pos);
      if (lineEnd < 0) {
        // The way back down mirrors the single-line branch: on the last
        // line of a recalled entry, ↓ moves to the newer entry (or back
        // to the draft past the newest), instead of being a dead key.
        if (this.hIndex >= 0) {
          this.saveHistEdit();
          this.hIndex++;
          if (this.hIndex >= this.history.length) { this.hIndex = -1; return this.setText(this.draft || ''); }
          return this.setText(this.histText(this.hIndex));
        }
        return;
      }
      const nextStart = lineEnd + 1, nextEnd = text.indexOf('\n', nextStart);
      return this.set({pos: nextStart + offsetAtClusterCol(text.slice(nextStart, nextEnd < 0 ? text.length : nextEnd), col)});
    }
    if ((k.upArrow || k.downArrow) && !text.includes('\n')) {
      if (!this.history.length) return;
      if (k.upArrow) {
        if (this.hIndex < 0) this.draft = text; // keep the in-progress draft for the way back down
        else this.saveHistEdit(); // an edited entry keeps its edit as its draft (see saveHistEdit)
        this.hIndex = this.hIndex < 0 ? this.history.length - 1 : Math.max(0, this.hIndex - 1);
        return this.setText(this.histText(this.hIndex));
      }
      if (this.hIndex < 0) return;
      this.saveHistEdit();
      this.hIndex++;
      if (this.hIndex >= this.history.length) { this.hIndex = -1; return this.setText(this.draft || ''); }
      return this.setText(this.histText(this.hIndex));
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
    // Wave 10 follow-up: Tab gets the same chat-line gate Enter got — $ and @
    // completion only on a normal chat line (mode read via trimStart, as in
    // the Enter branch and submit). On a ! line $ is a shell variable and on
    // a / line neither is expanded, so Tab there must leave the text alone
    // (! $rev + Tab used to rewrite it to $review ). / completion below is
    // unchanged, and cycling an already-open / list still works.
    const lead = text.trimStart();
    const chatLine = !lead.startsWith('!') && !lead.startsWith('/');
    const prev = this.tabState;
    if (prev && prev.text === text && prev.end === pos && prev.list.length > 1 && (prev.kind === 'slash' || chatLine)) {
      const idx = (prev.idx + 1) % prev.list.length, ins = prev.format(prev.list[idx]);
      const nt = text.slice(0, prev.start) + ins + text.slice(prev.end);
      this.tabState = {...prev, idx, text: nt, end: prev.start + ins.length};
      return this.setText(nt, prev.start + ins.length);
    }
    const dctx = chatLine ? this.dollarContext(text, pos) : null;
    if (dctx) {
      // Tab completes the highlighted $skill to '$name ' (no list, no completion).
      if (!dctx.list.length) return;
      return this.applyDollarPick(dctx.frag, dctx.list[this.dollarIndex(dctx.frag.fragment, dctx.list.length)]);
    }
    const at = chatLine ? mention.fragmentAt(text, pos) : null;
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
  // The $name expansion of a typed text: the sentence(s) Muse is sent for
  // its $skill references, followed by the text as typed. Queue entries hold
  // the typed text only (that is what the queue line shows); this expansion
  // is computed where a text is actually sent (submit) or matched against a
  // text that was sent (the agent's steer queue holds expansions).
  sendTextFor(text) {
    const drefs = (() => { try { return skills.dollarRefs(text, this.agent.cwd); } catch { return {names: [], disabled: []}; } })();
    return drefs.names.length ? drefs.names.map(n => skills.skillSentence(n)).join(' ') + ' ' + text : text;
  }
  async submit(text, {fromQuestion = false} = {}) {
    this.resumeEpoch = (this.resumeEpoch || 0) + 1; // a send supersedes a resume still loading (#177)
    // Focus fix: a picker answer held in the queue while an account was
    // being added (the addingAccount branch below) keeps its fromQuestion
    // nature when the queue later drains it through a plain submit() —
    // the drain must not re-route it as a decline reason, a slash command
    // or a !command, or the queueing below would only delay the loss.
    if (!fromQuestion && this.queuedQuestionAnswers?.includes(text)) { this.queuedQuestionAnswers.splice(this.queuedQuestionAnswers.indexOf(text), 1); fromQuestion = true; }
    // Focus fix: in serve mode the picker state lives on this server-side
    // Controller, but a GUI / phone answer arrives as a plain submit() —
    // nothing here cleared s.question, so it stayed set forever: later
    // pickers never opened (the !s.question condition above), the queue
    // never auto-sent, and bang / shell notes kept waiting. A plain send
    // while a picker is open IS the user's answer to it: clear the stale
    // question first (closeQuestion(false): the same state update, without
    // the queue / bang / shell resumption — this send proceeds as the
    // resumption itself) and let the send go through normally. A picker
    // submission (fromQuestion) already closed its question beforehand.
    if (!fromQuestion && this.s.question) this.closeQuestion(false);
    // #158: a send from any surface (GUI /send included) answers a pending decline
    // reason first — it used to fall through and go to Muse as a chat message.
    // fromQuestion (submitQuestionAnswers) is the one exception, third M25:
    // those answers belong to the Focus question that was asked, and a reason
    // pending at the same time stays pending instead of eating them.
    if (!fromQuestion) {
      if (this.s.reasonFor) return this.submitReason(text);
      if (this.s.promptFor) return this.submitPrompt(text);
    }
    if (this.addingAccount) {
      // Focus fix: a picker answer (fromQuestion) submitted while an account
      // add runs used to be dropped here — after submitQuestionAnswers had
      // already closed the picker, so the answer was lost entirely. Queue it
      // on the same queue a busy send uses instead; it is delivered after
      // the add, at the next queue drain. Plain sends still just wait.
      if (fromQuestion) {
        if (this.queue.length >= MAX_QUEUE) { this.note(t('キューがいっぱいです（最大 {max} 件）。', {max: MAX_QUEUE}), 'error'); return this.flash(t('キューがいっぱいです')); }
        this.queue.push(text); (this.queuedQuestionAnswers ||= []).push(text); this.agent.focusInputPending = true; this.set({queue: [...this.queue]}); return this.flash(t('アカウントを追加しています。完了するまでお待ちください。'));
      }
      return this.flash(t('アカウントを追加しています。完了するまでお待ちください。'));
    }
    // Focus fix: picker answers are plain messages, never commands — their
    // first line is the QUESTION text (submitQuestionAnswers), so a question
    // starting with '/' or '!' ran itself as a slash command / !command and
    // corrupted its own answer. fromQuestion skips both branches entirely.
    if (!fromQuestion) {
      // Wave 10: both mode marks skip leading blanks the same way — the / branch used
      // to test the raw text while ! used trimStart, so ' /help' (or a leading newline)
      // went to Muse as chat while ' !cmd' ran. One trimStart basis for both.
      // Wave 16 (2): a slash line used to run BEFORE the account-switch hold
      // below, so /new (or any command) executed mid-switch, against the
      // account/session being left. While a switch is in flight on either
      // side, hold the line in the queue like plain text instead; the
      // drain re-enters submit() once the switch settles and runs it then.
      if (text.trimStart().startsWith('/') && (this.accountSwitching || this.agent?._switching)) {
        if (this.queue.length >= MAX_QUEUE) { this.note(t('キューがいっぱいです（最大 {max} 件）。', {max: MAX_QUEUE}), 'error'); return this.flash(t('キューがいっぱいです')); }
        this.queue.push(text); this.agent.focusInputPending = true; this.set({queue: [...this.queue]}); return this.flash(t('アカウントを切り替えています。そのあと送ります'));
      }
      if (text.trimStart().startsWith('/')) return this.slash(text.trim());
      // Leading spaces too: a "! command" copied from Muse's reply on screen comes with its indent.
      if (text.trimStart().startsWith('!')) return this.bang(text.trimStart().slice(1).trim());
    }
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
    // Wave 16 (1): the hold covered only a controller-started switch
    // (this.accountSwitching). During an AGENT-initiated failover
    // (agent._switching, e.g. a quota failover inside agent.send) the
    // message fell through, agent.send rejected it mid-switch, and the
    // catch below restored the bang/shell notes and attachments but
    // never the text — the send was lost. Hold on either side's switch,
    // mirroring sendShellNotes' guard.
    if (this.accountSwitching || this.agent?._switching) {
      if (this.queue.length >= MAX_QUEUE) { this.note(t('キューがいっぱいです（最大 {max} 件）。', {max: MAX_QUEUE}), 'error'); return this.flash(t('キューがいっぱいです')); }
      this.queue.push(text); this.agent.focusInputPending = true; this.set({queue: [...this.queue]}); return this.flash(t('アカウントを切り替えています。そのあと送ります'));
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
      if (this.s.busy) { this.queue.push(text); this.agent.queueSteer?.(sendText); this.agent.focusInputPending = true; this.set({queue: [...this.queue]}); return this.flash(t('作業中です。次のツール実行で Muse に伝えます（キュー {n} 件目）', {n: this.queue.length})); }
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
    // Wave 16 (6): guard parity with sendShellNotes — an account switch in
    // flight on either side holds the notes as bangPending too, instead of
    // starting an automatic turn agent.send refuses mid-switch.
    if (this.s.busy || this.addingAccount || this.loggingIn || this.s.promptFor || this.s.question || this.s.reasonFor || this.accountSwitching || this.agent?._switching) { this.bangPending = true; return; }
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
    // Wave11 (1): while an account switch is being prepared, do not even try to
    // send — agent.send refuses mid-switch, and the failed send used to print a
    // bogus turn-end and leave the note dangling. Hold it as pending; the
    // 'account' handler then shows it as a screen note only and clears it.
    if (this.s.busy || this.addingAccount || this.loggingIn || this.s.promptFor || this.s.question || this.s.reasonFor || this.accountSwitching || this.agent?._switching) { this.shellPending = true; return; }
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
  // The full output of a call, for /output (the last 30; at most outputsMaxChars of
  // text is held in memory, the rest spilled to disk — stage 2); returns its line
  // count for the "… N more" hint.
  keepOutput(call, output) {
    // Sanitised on the way in (frames first, for the \r collapse — see tool-output):
    // what is kept here is drawn again by /output and ctrl+o as plain terminal text,
    // so a raw escape kept verbatim (an OSC 52 in command output) would be executed
    // by the terminal then, long after the call itself finished.
    const text = stripEmbeds(frames(String(output || ''))).trimEnd();
    if (text) {
      this.outputs.push({id: call.id, at: Date.now(), command: call.command, summary: call.summary || '', text});
      if (this.outputs.length > OUTPUTS_MAX_ITEMS) this.discardOutput(this.outputs.shift());
      this.spillOutputs();
    }
    return text ? text.split('\n').length : 0;
  }
  // Two caps, kept separate. Memory: at most outputsMaxChars of text is held in
  // memory; past that the oldest in-memory texts spill, oldest first, to this
  // process's outputs folder (the entry keeps {file, size}) and still read back
  // in full — no entry is ever dropped to satisfy this cap. A write failure keeps
  // the text in memory instead: losing output is worse than holding it.
  // Disk: the spill folder is bounded at 4x outputsMaxChars of spilled bytes
  // in total — the folder total across every Controller sharing it, counted
  // in real UTF-8 bytes (wave 18 (C)); past that the oldest SPILLED entries
  // of this conversation lose their spill — the file is
  // deleted and the entry remains with neither text nor file, which is how a
  // kept output whose text is gone already presents (outputText reads it as '').
  // A single output larger than the disk cap has no truncation convention in
  // this module — kept outputs are lossless — so it spills whole and stays as
  // the only spilled entry, alone over the disk cap.
  spillOutputs() {
    let held = 0; for (const o of this.outputs) if (o.text) held += o.text.length;
    for (const o of this.outputs) {
      if (held <= this.outputsMaxChars) break;
      if (!o.text) continue;
      const n = o.text.length;
      if (this.spillOutput(o)) held -= n;
    }
    // Wave 18 (C): the disk cap bounds the FOLDER, not this conversation.
    // The default outputs dir is per-pid, so every conversation of one
    // resident Server spills into the same folder; counting only this
    // Controller's entries let the folder reach the cap times the number of
    // conversations. Count every spill file in the folder — eviction can
    // still only drop THIS conversation's files (another conversation's
    // spills are its own to drop), so the loop also stops when this side is
    // down to its last spilled entry, as with one oversize entry above.
    const diskMax = this.outputsMaxChars * 4;
    let folderBytes = this.spillFolderBytes();
    while (folderBytes > diskMax) {
      const spilledEntries = this.outputs.filter(o => o.file);
      if (spilledEntries.length <= 1) break; // one oversize entry, kept whole (above)
      const oldest = spilledEntries[0];
      folderBytes -= oldest.size || 0;
      this.discardOutput(oldest); delete oldest.file; delete oldest.size;
    }
  }
  // Total bytes of the spill files in this Controller's outputs folder —
  // this conversation's and every other Controller sharing the folder alike,
  // measured on disk (real UTF-8 bytes). Falls back to this conversation's
  // own spilled sizes when the folder cannot be listed.
  spillFolderBytes() {
    let names = null;
    try { names = fs.readdirSync(this.outputsDir); } catch {}
    if (!names) { let own = 0; for (const o of this.outputs) if (o.file) own += o.size || 0; return own; }
    let total = 0;
    for (const name of names) { try { const st = fs.statSync(path.join(this.outputsDir, name)); if (st.isFile()) total += st.size; } catch {} }
    return total;
  }
  spillOutput(o) {
    try {
      fs.mkdirSync(this.outputsDir, {recursive: true});
      const file = path.join(this.outputsDir, String(o.at) + '-' + this.outputTag + '-' + (++this.outputSeq) + '.txt');
      fs.writeFileSync(file, o.text);
      // Wave 18 (C): size is the file's real size in UTF-8 bytes, not the
      // UTF-16 length — Japanese text is 3 bytes per character on disk, so
      // the length understated it up to 3x and the disk cap under-enforced.
      o.file = file; o.size = Buffer.byteLength(o.text, 'utf8'); delete o.text;
      return true;
    } catch { return false; }
  }
  discardOutput(o) { if (o && o.file) { try { fs.unlinkSync(o.file); } catch {} } }
  // The full text of a kept output, wherever it currently lives.
  outputText(o) {
    if (!o) return '';
    if (typeof o.text === 'string') return o.text;
    if (o.file) { try { return fs.readFileSync(o.file, 'utf8'); } catch { return ''; } }
    return '';
  }
  cleanupOutputs() { try { fs.rmSync(this.outputsDir, {recursive: true, force: true}); } catch {} }
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
    // The live tail is sanitised per line, like Muse's streaming tool output: drawn
    // raw, an escape in the command's output would be executed by the terminal live.
    const onOut = chunk => { const r = this.s.bangRunning; if (!r || r.call !== call) return; const lines = frames(chunk).split('\n').map(l => stripEmbeds(frames(l))).filter(l => l.trim()); this.set({bangRunning: {...r, tail: [...r.tail, ...lines].slice(-5)}}); };
    try {
      const stop = this.bangStop = new AbortController();
      const r = await LOCAL['system.run'].run({command: cmd}, this.agent.ctx, stop.signal, onOut);
      this.set({bangRunning: null});
      mention.invalidate?.(this.agent.cwd); // a !command may have created files too
      // Kept for /output like Muse's commands: past the 12 lines on screen it could not be seen at all.
      const outputLines = this.keepOutput(call, stripEmbeds(frames(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : ''))));
      // Wave 10: the row's ok follows the exit code, as Muse's own tool rows do —
      // a command that failed (or was stopped) used to show ok:true whatever happened.
      // A run adopted into the background on timeout has no exit code yet and is not a failure.
      const ok = r.payload.backgrounded ? true : r.payload.exit_code === 0;
      this.push({type: 'tool', call: {...call, ok, outputLines, view: {...r.view, tail: stripEmbeds(frames(r.payload.stdout + r.payload.stderr)).trimEnd().split('\n').slice(-12)}}});
      // The end is kept too, and the cut is said: the first 20,000 characters alone dropped the
      // errors at the bottom of a long build and all of stderr, without a word.
      const out = stripEmbeds(r.payload.stdout + (r.payload.stderr ? '\n' + r.payload.stderr : ''));
      const sent = out.length > BANG_NOTE ? out.slice(0, BANG_NOTE * 0.3) + '\n… (' + (out.length - BANG_NOTE) + ' characters cut here) …\n' + out.slice(-BANG_NOTE * 0.7) : out;
      // Wave 10: a command the user stopped reads in the note exactly like any other
      // nonzero exit, so Muse could not tell "it failed" from "the user stopped it".
      // Say so, in so many words, ahead of the exit line.
      const stopped = r.payload.killed === 'cancelled' || r.view?.killed === 'cancelled';
      (this.bangNotes ||= []).push('[The user ran this in the terminal: ' + cmd + ']\n' + (stopped ? 'The user stopped this command before it finished (cancelled).\n' : '') + 'exit ' + r.payload.exit_code + '\n' + sent);
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
    // Wave 16 (5): the session used to be repointed HERE, synchronously —
    // a send during the load below then landed in the resumed chat even
    // when the epoch/busy guard afterwards suppressed the resume display
    // itself. Remember the session being left instead; the repoint (and
    // the per-chat clearing under it) happens only after the guard has
    // passed, so a bailed resume leaves the conversation state exactly
    // as it was before the call.
    const prevSession = a.session;
    // Reading the chat from Muse needs the gateway, which may still be connecting at startup.
    if (sessions.transcript(s.id).length < (s.turns || 0)) { try { await a.ensureConnected?.(); } catch {} }
    let res;
    try { res = await transcript.forResume(s, a.client); } catch { res = {turns: sessions.transcript(s.id), from: 'local'}; }
    if (!startup && (epoch !== this.resumeEpoch || this.s.busy || a.session !== prevSession)) return;
    // #175/#176: shell notes and the standing goal belong to the chat being left, the
    // same as bangNotes/todos already were: the old chat's shell completion must not leak
    // into the new chat's first message, and the goal shown must be the resumed chat's.
    // Wave 16 (4): attachments and the held queue are the old chat's too —
    // clear the attachments, and drop the queue with a note saying how
    // many entries were cancelled (dropQueueForTransition).
    if (!startup) { a.session = s; a.ctx.readFiles.clear(); a.ctx.todos = []; this.bangNotes = []; this.shellNotes = []; this.shellPending = false; this.dropQueueForTransition(); this.set({todos: [], goal: a.standingGoal?.() || null, attachments: []}); }
    const turns = res.turns, shown = turns.slice(-10);
    // Wave 13: the local transcript held fewer turns than the conversation
    // has AND the missing ones could not be fetched either (forResume fell
    // back to the local file — no client, a failed fetch, an empty reply —
    // or the fetch stopped at its page cap, res.partial): the header above
    // still counts the conversation's full turns, so without a note the
    // short display reads as if nothing were missing. Say how many of the
    // turns are actually being shown.
    const missingNote = (s.turns || 0) > turns.length && (res.from !== 'muse' || res.partial)
      ? ' ' + t('{n} ターンのうち {m} ターンだけ表示しています', {n: s.turns || 0, m: shown.length}) : '';
    if (!startup || turns.length) this.note(t('↺ 再開: {title} · {n} ターン', {title: s.title || s.id, n: Math.max(s.turns || 0, turns.length)}) +
      (turns.length > shown.length || res.partial ? t('（直近 {n} ターンを表示）', {n: shown.length}) : '') + (res.from === 'muse' ? t(' · Muse から読み込み') : '') + missingNote);
    for (const t of shown) {
      // A body muser itself sent (an automatic Focus / goal continuation) that an older
      // transcript kept as the turn's user text reads as a short label, not as the
      // whole English instruction in the user's bubble.
      this.push({type: 'user', text: transcript.isSynthetic(t.user) ? i18n.t('（自動で続行）') : (t.user || '')});
      if (t.tools?.length || t.steps?.length) this.push({type: 'past', tools: t.tools || [], steps: t.steps || []});
      for (const report of t.progress || []) this.push({type: 'progress', ...report});
      if (t.focus) this.push({type: 'focus', focus: t.focus});
      if (t.reply) { const md = createMd(), src = sanitizeEmbeds(String(t.reply).trimEnd()); this.push({type: 'md', rows: md.rows(src.split('\n')), src, first: true}, {type: 'gap'}); }
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
    // Wave 15: the plain demo has no scripted login flow, so /login used to
    // fall through to the REAL Edge login (login.js). Refuse instead; the
    // login demo carries its own scripted flow (agent.loginFlow) and is
    // unaffected.
    if (this.agent.client?.status === 'demo' && !this.agent.loginFlow) return this.note(t('デモではログインできません。'));
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
      ask: async (message, opts = {}) => { let o = opts; if (opts && opts.initial) { const str = String(opts.initial); const at = str.indexOf('@'); const masked = at > 0 ? str.slice(0, at).slice(0, 2) + '***@' + str.slice(at + 1) : str.slice(0, 2) + '***'; o = {...opts, hint: [opts.hint, t('前回: {masked}', {masked})].filter(Boolean).join(' / ')}; } const v = await this.promptAsk(message, o); if (String(v).startsWith('/')) throw new Error(t('中止しました。')); return v; },
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
        const {account, same, sameCheckFailed} = await impl({label: name, ui: this.accountUi(), log: s => { const line = String(s).trim().replace(/^…\s*/, ''); if (!this.flowLine(line)) this.flash(line, 300000); }});
        this.flash('');
        this.note(t('アカウント {label} を追加しました。/account で切り替えられます。', {label: account.label}));
        if (same) this.note(t('注意: {label} は {other} と同じ muse.ai アカウントです。使用量は共通なので、別のアカウントでログインし直すか `muser account remove {id}` で消してください。', {label: account.label, other: same.label, id: account.id}));
        // Wave 15: a duplicate check that never ran is not "no duplicate" —
        // account-add flags it (sameCheckFailed) and it is said here, while
        // the user can still act on it.
        if (sameCheckFailed) this.note(t('注意: 同じ Muse かどうかの確認ができませんでした。別のアカウントと同じ Muse だった場合、使用量は共通です。'));
      } catch (e) {
        this.flash('');
        this.note(t('アカウントを追加できませんでした: {error}', {error: e.message}), 'error');
        // Wave 15: account-add's attached outcome travels with the error
        // (src/account-add.js) — show it: an account whose login landed
        // STAYS (with the command that finishes its device registration),
        // a rollback leftover is named, and a failed rollback is said too.
        // Without these the bare failure hid all three, and a retry only
        // met "that name already exists".
        if (e.accountKept) this.note(t('アカウント {label} は残っています（ログインは済んでいます）。端末登録の続きは `muser login --account {id}` で行えます。', {label: e.accountKept.label, id: e.accountKept.id}));
        if (e.rollbackLeftover) this.note(t('巻き戻しで消せなかったものが残っています: {dir}　Edge を閉じてから削除してください。残っていると、同じ名前で追加したときに前のログインが戻ります。', {dir: e.rollbackLeftover}));
        if (e.rollbackError) this.note(t('巻き戻しにも失敗しました: {error}', {error: e.rollbackError}), 'error');
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
    // Wave11 (4): the reservation is cleared ONLY on success. It used to be
    // cleared before the attempt, so a failed switch silently abandoned the
    // (possibly unattended) handover. On failure it stays — with its screen
    // marker restored — and the next turn end retries it.
    // Wave 15: the reserved account is GONE (removed after the reservation
    // was made) — that is settled, not a failure to retry. Keeping the
    // reservation re-noted this at every later turn end forever; clear it
    // and say so once.
    if (!target) { this.clearAccountReservation(); this.note(t('アカウントが見つかりません: {id}', {id: r.label}), 'error'); return; }
    try { await this.switchToAccount(target, {reason: 'reserved'}); }
    catch (e) { this.set({accountReserved: r.label}); this.note(t('アカウントを切り替えられませんでした: {error}', {error: e.message}), 'error'); return; }
    this.clearAccountReservation();
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
  buildAccountHandoff(target, fromSession, fromLabel, extra = {}) {
    const a = this.agent;
    const sess = fromSession || a.session;
    // Wave11 (2): finished-but-uncollected sub-agent results dropped by the switch
    // are summarised in the note. A manual switch builds the note BEFORE the
    // switch, so read them live; a failover builds it in the 'account' handler,
    // after the workers are gone, so the caller passes the switch's summaries.
    let agents = extra?.agents;
    if (!agents) { try { agents = fromSession ? (a.lastSwitchOrphans || []) : (typeof a.uncollectedAgentSummaries === 'function' ? a.uncollectedAgentSummaries() : []); } catch { agents = []; } }
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
      sessionTitle: sess?.title || '', turns, todos: this.s.todos || [], focus, gitLines, recordPath, agents,
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
    // Wave 9 (1): a plan whose resetsAt is already in the past must not become
    // the keep record's expiry — a past expiry never suppresses, so the
    // question would come back after every turn. Re-read the plan; a fresh
    // plan naming a future reset replaces this one. If no future reset can
    // be learned, "keep" is held in memory only (Infinity): once for this
    // process, instead of a past timestamp that never holds at all. A
    // missing resetsAt is different (audit #164): it keeps the day-long hold
    // in decide() below and needs no re-read.
    let keepResetsAt = null;
    if (Number.isFinite(p?.resetsAt) && p.resetsAt <= Date.now()) {
      let fresh = null;
      try { fresh = await this.refreshPlan(); } catch {}
      if (a.accountId !== id || this.accountSwitchReservation || this.s.menu?.quotaChoice) return;
      if (this.s.approval || this.s.reasonFor || this.s.question || this.s.menu || this.s.text || this.s.promptFor || this.s.limitInput) return;
      if (fresh && Number.isFinite(fresh.resetsAt) && fresh.resetsAt > Date.now()) p = fresh;
      else keepResetsAt = Infinity;
    }
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
    // Wave 8 (1): with nowhere to hand over to, the hint lumped every cause
    // together ("all at their limit or not set up") and never said when any
    // account comes back. Say the breakdown instead — which accounts are at
    // their weekly limit, which have a lapsed login — plus the earliest
    // reset among the exhausted ones, when one is known. peek() only names
    // a winner, so the breakdown reads every status; a pool without
    // statuses() (or a status that fits neither cause) keeps the lumped
    // wording rather than guessing.
    let deadHint = null;
    if (!target && typeof a.accountPool.statuses === 'function') {
      let all = null;
      try { all = await a.accountPool.statuses(); } catch {}
      if (a.accountId !== id || this.accountSwitchReservation || this.s.menu?.quotaChoice) return;
      if (this.s.approval || this.s.reasonFor || this.s.question || this.s.menu || this.s.text || this.s.promptFor || this.s.limitInput) return;
      if (Array.isArray(all)) {
        const others = all.filter(s => s && s.id !== id);
        // Wave 15: an account whose store files cannot be read (statuses()
        // marks it unreadable) is BROKEN, not logged out — its jar reads as
        // empty, so it used to land in the login-lapsed bucket and the hint
        // prescribed a login that would stop on the same broken file. It
        // gets its own bucket, as the /account list already shows it
        // (「壊れています」).
        const brokenDead = others.filter(s => s.unreadable || (Array.isArray(s.unreadableFiles) && s.unreadableFiles.length));
        const loginDead = others.filter(s => !brokenDead.includes(s) && (s.available === false || s.hasLogin === false || s.device === false));
        const quotaDead = others.filter(s => !brokenDead.includes(s) && !loginDead.includes(s) && accounts.exhausted(s));
        if (others.length && quotaDead.length + loginDead.length + brokenDead.length === others.length) {
          const parts = [];
          if (quotaDead.length) parts.push(t('上限に到達: {list}', {list: quotaDead.map(s => s.label || s.id).join('、')}));
          if (loginDead.length) parts.push(t('ログイン切れ: {list}', {list: loginDead.map(s => s.label || s.id).join('、')}));
          if (brokenDead.length) parts.push(t('壊れています: {list}', {list: brokenDead.map(s => s.label || s.id).join('、')}));
          deadHint = t('引き継げるアカウントがありません（{breakdown}）', {breakdown: parts.join('／')});
          const resets = [p.resetsAt, ...quotaDead.map(s => s.plan?.resetsAt ?? s.resetsAt)].filter(v => Number.isFinite(v) && v > 0);
          if (resets.length) deadHint += ' · ' + t('最も早いリセットは {at} です', {at: new Date(Math.min(...resets)).toLocaleString(i18n.lang(), {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})});
        }
      }
    }
    // Muse's own line for the extra ("0% used (3B tokens left)"); none bought is said plainly.
    const extra = p.topupBalance === 0 ? t('（追加購入分はありません）') : p.topupValue ? t('（追加: {value}）', {value: p.topupValue}) : '';
    // Wave 8 (1): with no extra bought, the keep option contradicted itself —
    // its label and description both said "use the extra" and the description
    // then appended "(no extra was bought)". With none bought it says
    // plainly: go on here, and the work may stop at the limit.
    const options = [p.topupBalance === 0
      ? {value: 'keep', label: t('このまま続ける'), desc: t('{label} で続けます（追加購入分はありません。上限で止まることがあります）', {label})}
      : {value: 'keep', label: t('このまま追加を利用する'), desc: t('{label} で続けます。追加購入分を使います', {label}) + extra}];
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
        this.quotaKeep.set(id, {resetsAt: keepResetsAt ?? (p.resetsAt || Date.now() + 24 * 3600 * 1000)});
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
    // The title must match WHY this is exhausted (accounts.exhausted): the percent
    // reaching the threshold is only one basis — a quotaStatus other than SUFFICIENT
    // reaches it on its own, at 42% or with the percent unreadable. The old title
    // always claimed the percent ('週間リミットが 42% に到達') and fabricated 100%
    // when percentUsed was null. Say the percent reached it only when it did; a
    // status-only reach names the usage as a fact, and an unknown percent is not shown.
    const quotaTitle = typeof p.percentUsed === 'number' && p.percentUsed >= accounts.threshold()
      ? t('週間リミットが {n}% に到達しました', {n: p.percentUsed})
      : typeof p.percentUsed === 'number'
        ? t('週間リミットに到達しました（週の使用量 {n}%）', {n: p.percentUsed})
        : t('週間リミットに到達しました');
    this.openMenu({quotaChoice: token, title: quotaTitle,
      hint: (target ? (p.topupBalance === 0 ? t('このまま続けるか、新しいアカウントで引き継ぐか選んでください') : t('このまま追加を利用するか、新しいアカウントで引き継ぐか選んでください')) : deadHint || t('引き継げるアカウントがありません（どれも上限か未設定です。追加は `muser account add <名前>`）'))
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
    // Wave 9 (1): whether this plan's resetsAt is already past is judged
    // HERE, on the plan as handed in — a reset still in the future at this
    // point is this week's key even if it lapses during the peek below.
    const planStale = Number.isFinite(p?.resetsAt) && p.resetsAt <= Date.now();
    let multi = false;
    try { multi = require('../account-pool.js').multi(); } catch {}
    if (!multi) return;
    let next = null;
    try { next = a.accountPool.peek ? await a.accountPool.peek(new Set([a.accountId])) : null; } catch {}
    // A switch during the read: this plan and this prediction belong to the old account.
    if (accountId && accountId !== a.accountId) return;
    // Wave 9 (1): a stale plan (planStale above) must not be saved as the
    // record's expiry — a past timestamp never suppresses, so the warning
    // would repeat after every turn. Re-read the plan and save the fresh
    // future reset when one is known; when none is, hold the warning in
    // memory only (Infinity): once for this process.
    let resetsAt = p.resetsAt;
    if (planStale) {
      let fresh = null;
      try { fresh = await this.refreshPlan(); } catch {}
      if (accountId && accountId !== a.accountId) return; // a switch during the re-read: do not eat the warning
      if (fresh && Number.isFinite(fresh.resetsAt) && fresh.resetsAt > Date.now()) resetsAt = fresh.resetsAt;
      else resetsAt = Infinity;
    }
    // deep c1 #3: without a resetsAt the record used to hold forever (the guard
    // above treats null as unexpired), so the warning never came again — across
    // week boundaries, until a restart. quotaKeep's #164 fix is the twin: a day.
    this.quotaWarnedFor.set(a.accountId, {resetsAt: resetsAt || Date.now() + 24 * 3600 * 1000});
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
    const text = this.outputText(o); // a spilled output (stage 2) is read back from its file
    let file = '';
    try {
      const dir = path.join(os.tmpdir(), 'muser-output'); fs.mkdirSync(dir, {recursive: true});
      file = path.join(dir, new Date(o.at).toISOString().replace(/[:.]/g, '-') + '-' + o.command.replace(/[^\w.-]/g, '') + '.txt');
      fs.writeFileSync(file, text + '\n');
    } catch {}
    const lines = text.split('\n'), long = lines.length > 400;
    this.note([c.bold(o.command + '  ' + o.summary), ...(long ? [c.faint(t('… 先頭の {n} 行は省略', {n: lines.length - 200}))] : []), ...(long ? lines.slice(-200) : lines),
      ...(file ? ['', c.faint(t('全文: {file}', {file}))] : [])]);
  }
  // At every start (src/update.js): the footer says "checking for updates…", then shows a newer
  // version until /update installs it. A failed check just clears the footer.
  // Wave 12 throttling: the last check (time + outcome) is recorded in
  // ~/.muser/update-check.json, and while it is fresh — 6 h after a success,
  // 1 h after a failure — this automatic check is skipped and the recorded
  // result stands in for it, so an offline stretch does not re-pay the
  // registry timeout on every start. /update (runUpdate) never consults the
  // record: a manual check always asks the registry.
  checkUpdate() {
    if (!update.enabled()) return Promise.resolve(null);
    const recent = update.recentCheck();
    if (recent) {
      this.set({update: recent.ok && update.newer(recent.latest, this.version) ? {latest: recent.latest} : null});
      return Promise.resolve(recent.ok ? recent.latest : null);
    }
    this.set({update: {checking: true}});
    return update.latest().then(v => { update.recordCheck({ok: true, latest: v}); this.set({update: update.newer(v, this.version) ? {latest: v} : null}); return v; }, () => { update.recordCheck({ok: false}); this.set({update: null}); return null; });
  }
  async runUpdate() {
    // Wave 15: /update installs for real — in the demo it refuses, like the
    // other demo guards, before anything is checked or installed.
    if (this.agent.client?.status === 'demo') return this.note(t('デモでは更新できません。'));
    if (update.devCheckout()) return this.note(t('この muser は git から動いている開発用なので、/update では更新しません（git pull で更新してください）。'));
    // Like the other heavy commands (/export, /reload): never install over
    // work in flight — say so instead of running anyway (wave 7).
    if (this.s.busy || this.agent.busy) return this.note(t('作業中は更新できません。終わってから /update してください。'));
    if (this.updating) return;
    // A successful install does not change THIS window: it keeps running the
    // old version until it is reopened. Remember the installed version, so a
    // second /update in the same window prompts a restart instead of
    // installing all over again (wave 7).
    if (this.updatedVersion) return this.note(t('すでに {version} に更新済みです。muser を再起動して開き直してください。', {version: 'v' + this.updatedVersion}));
    this.updating = true;
    try {
      // Ask npm first: "already the latest" and "could not check" read the same before.
      this.flash(t('新しい版を確認しています…'), 20000);
      let v;
      try { v = await update.latest(); update.recordCheck({ok: true, latest: v}); }
      catch (e) { update.recordCheck({ok: false}); this.flash(''); return this.note(t('npm で新しい版を確認できませんでした（{error}）。', {error: e.message}), 'error'); }
      if (!update.newer(v, this.version)) {
        this.flash(''); this.set({update: null});
        // The registry behind this build (a private / pre-release build, or a
        // registry rollback): say the local version is AHEAD of it, instead of
        // calling it "the latest" (wave 7).
        if (v && update.newer(this.version, v)) return this.note(t('レジストリより新しい版を使っています（v{version}。レジストリの最新は v{registry} です）。', {version: this.version, registry: v}));
        return this.note(t('muser は最新版です（v{version}）。', {version: this.version}));
      }
      // Wave 12: install the version just checked and shown, pinned — not the
      // floating @latest, which can move between the check and the install
      // and would leave the completion note naming a version that never landed.
      this.flash(t('muser を更新しています（npm install -g muser-cli@{version}）…', {version: v}), 300000);
      const r = await update.install({version: v});
      this.flash('');
      if (!r.ok) {
        const lines = String(r.output || '').split('\n');
        // Only the last 6 lines are shown: say how much was left out,
        // instead of cutting the rest silently (wave 7).
        return this.note([t('更新できませんでした:'), ...(lines.length > 6 ? [t('… 先頭の {n} 行は省略', {n: lines.length - 6})] : []), ...lines.slice(-6)], 'error');
      }
      this.set({update: null});
      // Say the version that actually landed, as install() read it back —
      // not just the version the check saw (wave 12).
      const installed = r.installedVersion || v;
      this.updatedVersion = installed || null;
      const id = this.agent.session?.id;
      // A window attached to the resident Server (a hosted Controller has no
      // onReload of its own: serve / the Server build it that way) keeps
      // talking to the Server's old code — reopening the window alone does
      // not make it the new version. Name the way back into this conversation.
      // Wave 12: the resume guidance names what is resumed — this folder's
      // previous conversation — and its ID when there is one: `muser -c`
      // resumes by folder, so opening again from another folder would resume
      // a different conversation, and the ID is the unambiguous way back.
      if (!this.onReload) {
        return this.note([t('muser を {version} に更新しました。', {version: installed ? 'v' + installed : t('最新版')}),
          t('この窓は常駐 Server に繋がっているため、Server を入れ直すまで新版にはなりません。'),
          ...(id ? [t('このフォルダーの直前の会話の続きから再開するには: muser resume {id}', {id})] : [t('このフォルダーの直前の会話は、muser -c で開き直すと再開できます。')])]);
      }
      this.note(id
        ? t('muser を {version} に更新しました。muser -c で開き直すと、新しい版でこのフォルダーの直前の会話から使えます（会話 ID: {id}）。', {version: installed ? 'v' + installed : t('最新版'), id})
        : t('muser を {version} に更新しました。muser -c で開き直すと、新しい版でこのフォルダーの直前の会話から使えます。', {version: installed ? 'v' + installed : t('最新版')}));
    } finally { this.updating = false; }
  }
  // /skills: every skill found (muser's own, the project's, Claude Code's, Codex's), each one a
  // toggle; whole sources can be switched off too. What a toggle changes, and when (wave 10):
  // the preamble's list is built when a conversation starts, so the LIST follows from the next
  // conversation; skill.read and the $name candidates call load() again on every use, so
  // reading and candidates follow at once, in this conversation too. The old hint said only
  // 'from the next conversation', which hid the immediate half.
  skillsMenu() {
    const a = this.agent, all = skills.load(a.cwd);
    // Skills load() skipped (a same-name loser, oversized, unreadable, a link out of its
    // source): the menu used to just not have them, so a skipped skill looked like a
    // missing one. They get rows of their own, with the reason and the folder, so the
    // user can find the file; picking a row only explains — it toggles nothing.
    const skipped = skills.diagnostics().filter(d => ['name-collision', 'too-large', 'read-error', 'linked-folder'].includes(d.reason));
    if (!all.length && !skipped.length) return this.note([t('スキルがありません。'), t('~/.muser/skills/<名前>/SKILL.md に置くか、Claude Code（~/.claude/skills）や Codex（~/.codex/skills）のスキルがあればそのまま読みます。')]);
    const bySource = {};
    for (const s of all) (bySource[s.source] ||= []).push(s);
    // Descriptions are cut the way preambleLines cuts them (140 chars, wave 10): the menu
    // used to carry the full text, so one long description pushed the other rows away.
    const cutDesc = d => d.length > 140 ? d.slice(0, 139) + '…' : d;
    const skipReason = d => d.reason === 'name-collision' ? t('同名のスキルが優先されたため読み込まれませんでした（保持されたフォルダー: {dir}）', {dir: d.keptDir || ''})
      : d.reason === 'too-large' ? t('SKILL.md が大きすぎるため読み込まれませんでした')
      : d.reason === 'read-error' ? t('SKILL.md を読めなかったため読み込まれませんでした')
      : d.reason === 'linked-folder' ? t('スキルフォルダーが読み込み元フォルダーの外へのリンクのため読み込まれませんでした')
      : d.reason;
    const options = [
      ...all.map(s => ({value: 'skill:' + s.name, label: (s.enabled ? '● ' : '○ ') + s.name, desc: '[' + s.source + '] ' + cutDesc(s.description)})),
      ...skipped.map((d, i) => ({value: 'skipped:' + i, label: '✕ ' + d.name + t('（スキップ）'), desc: '[' + (d.source || '') + '] ' + skipReason(d) + (d.dir ? ' ' + d.dir : '')})),
      ...Object.entries(bySource).map(([src, list]) => {
        const on = list.some(s => s.enabled);
        return {value: 'source:' + src + ':' + (on ? 'off' : 'on'), label: t(on ? '{source} をまとめてオフ' : '{source} をまとめてオン', {source: src}), desc: t('{n} 件', {n: list.length})};
      }),
    ];
    return this.openMenu({title: t('スキル'), hint: t('一覧は次の会話から、読み込みと候補はすぐ反映'), options, index: 0, pick: v => {
      const [kind, id, mode] = v.split(':');
      // A skipped row is an explanation, not a setting: it writes nothing, in demo too.
      if (kind === 'skipped') { const d = skipped[Number(id)]; if (d) this.note(d.name + ': ' + skipReason(d)); return this.skillsMenu(); }
      // W2F-6: skills.setEnabled / setSourceEnabled always write the real
      // config (they have no save flag), so in demo the toggle is refused
      // like the other settings paths refuse to persist.
      if (a.client?.status === 'demo') { this.note(t('デモでは設定を保存しません。')); return this.skillsMenu(); }
      if (kind === 'skill') { const s = skills.load(a.cwd).find(x => x.name === id); if (s) { skills.setEnabled(id, !s.enabled); this.note(t(s.enabled ? '{name} をオフにしました（一覧は次の会話から、読み込みと候補は今の会話でもすぐ効きます）' : '{name} をオンにしました（一覧は次の会話から、読み込みと候補は今の会話でもすぐ効きます）', {name: id})); } }
      else { skills.setSourceEnabled(id, mode === 'on'); this.note(t(mode === 'on' ? '{source} のスキルをオンにしました（一覧は次の会話から、読み込みと候補は今の会話でもすぐ効きます）' : '{source} のスキルをオフにしました（一覧は次の会話から、読み込みと候補は今の会話でもすぐ効きます）', {source: id})); }
      this.skillsMenu();
    }});
  }
  // /export: build this conversation's bug report (src/export.js), show what
  // it holds section by section, and let its owner choose: send it (with or
  // without the conversation text), save it to a file instead, or drop it.
  // The confirmation is a menu on purpose: menus travel the snapshot
  // protocol, so the GUI and the phone can answer exactly like this window
  // (fullscreen and classic share this Controller). Where a confirmation
  // cannot be shown — another menu / question / approval is already up, a
  // turn is running, or this is the demo — the command refuses instead of
  // sending anything unseen.
  async exportReport() {
    const exporter = require('../export.js');
    const a = this.agent;
    if (this.exporting) return;
    if (a.client?.status === 'demo') return this.note(t('デモではレポートは送れません。'));
    if (!a.session?.id) return this.note(t('送る会話がまだありません。'));
    if (this.s.busy || a.busy) return this.note(t('作業中は送れません。終わってから /export してください。'));
    if (this.s.menu || this.s.question || this.s.approval || this.s.promptFor || this.s.limitInput) return this.note(t('確認の画面が出せないため送りません。開いている選択や確認を終わらせてから /export してください。'));
    this.exporting = true;
    try {
      const session = {...a.session, cwd: a.cwd || a.session.cwd, account: a.accountId || a.session.account};
      const uiMode = switchValue('fullscreen') ? 'fullscreen' : 'classic';
      const events = (() => { try { return this.eventRing?.list(); } catch { return undefined; } })();
      const base = exporter.buildReport({session, includeConversation: false, uiMode, events});
      const full = exporter.buildReport({session, includeConversation: true, uiMode, events});
      const conversationBytes = Math.max(0, exporter.sectionSizes(full).total - exporter.sectionSizes(base).total);
      this.note([t('送るレポートの中身（会話 {id}）:', {id: String(a.session.id).slice(0, 8)}), ...exporter.sizeLines(base, {conversationBytes})]);
      let pick;
      try {
        pick = await this.menuPromise({title: t('レポートを開発者に送りますか？'), hint: t('秘密（トークン・メールアドレス・ユーザー名）は除いてあります'), options: [
          {value: 'send', label: t('送る（会話の本文は含めない）')},
          {value: 'send-body', label: t('会話の本文も含めて送る'), desc: t('あなたの頼みと Muse の返事も入ります')},
          {value: 'save', label: t('送らずにファイルに保存して中身を見る')},
          {value: 'save-body', label: t('会話の本文も含めてファイルに保存')},
          {value: 'cancel', label: t('やめる')},
        ]});
      } catch { return this.note(t('送りませんでした。')); }
      if (pick === 'cancel') return this.note(t('送りませんでした。'));
      const report = pick === 'send-body' || pick === 'save-body' ? full : base;
      if (pick === 'save' || pick === 'save-body') {
        try { const file = exporter.saveReport(report); return this.note([t('送らずにファイルに書きました: {file}', {file}), t('中身を確認してから、必要なら送ってください。')]); }
        catch (e) { return this.note(t('ファイルに書けませんでした: {error}', {error: e.message}), 'error'); }
      }
      this.flash(t('レポートを送っています…'), 30000);
      try { const {id} = await exporter.sendReport(report); this.flash(''); return this.note(exporter.sentMessage(id)); }
      catch (e) { this.flash(''); return this.note(exporter.failureMessage(e), 'error'); }
    } catch (e) {
      return this.note(t('レポートを作れませんでした: {error}', {error: e.message}), 'error');
    } finally { this.exporting = false; }
  }
  // level: 'error' notes render red in the view; plain notes are gray.
  note(lines, level) { this.push({type: 'note', lines: [].concat(lines), ...(level ? {level} : {})}); }
  // /parity (environment comparison, stage 1; docs/design/new-features.md §10):
  // this PC's fingerprint, saved under %LOCALAPPDATA%\muser\parity so it can
  // be carried to another PC and diffed there (or here, with /parity diff).
  // Naming the other PC is stage 2, which is not built: it is explained, not
  // fetched — nothing leaves this PC.
  parityCommand(arg) {
    const parity = require('../parity.js');
    const a = this.agent;
    if (!arg || arg === 'snapshot') {
      // Wave 15: taking the snapshot SAVES it under %LOCALAPPDATA%\muser\parity
      // — in the demo it refuses, like the other demo guards. /parity diff
      // below only reads files and stays available.
      if (a.client?.status === 'demo') return this.note(t('デモでは環境の指紋を保存しません。'));
      let snap, file;
      try { snap = parity.collectSnapshot({cwd: a.cwd}); file = parity.saveSnapshot(snap); }
      catch (err) { return this.note(t('環境の指紋を取れませんでした: {error}', {error: err.message}), 'error'); }
      return this.push({type: 'parity', title: t('環境比較（この PC）'), sections: parity.snapshotSections(snap, file)});
    }
    if (arg === 'diff' || arg.startsWith('diff ')) {
      const files = arg.slice(4).trim().split(/\s+/).filter(Boolean);
      if (files.length !== 2) return this.note(t('使い方: /parity diff <A.json> <B.json>'));
      try {
        const pa = parity.readSnapshotFile(path.resolve(a.cwd, files[0]));
        const pb = parity.readSnapshotFile(path.resolve(a.cwd, files[1]));
        const items = parity.diffSnapshots(pa, pb);
        if (!items.length) return this.note(t('違いはありません。'));
        return this.push({type: 'parity', title: t('環境比較: {a} と {b}（違い {n} 件）', {a: files[0], b: files[1], n: items.length}), sections: parity.diffSections(items)});
      } catch (err) { return this.note(err.message, 'error'); }
    }
    if (!/\s/.test(arg)) return this.note([t('「{name}」の指紋の取り寄せは段階 2 で、まだ作っていません。', {name: arg}), t('相手の PC で muser parity snapshot --out <ファイル> を実行し、そのファイルを持ってきて比べてください: /parity diff <A.json> <B.json>')]);
    return this.note(t('使い方: /parity（この PC の指紋） /parity diff <A.json> <B.json>'));
  }
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
  // /proof (design §2/§3): judge the last reply (or /proof <turn>) against
  // this conversation's worklog and show the badges; when the turn added a
  // regression test, offer the counter-proof run first (it executes tests,
  // so it asks — /proof --yes skips the asking).
  proofCommand(arg) {
    const proofCore = require('../proof/index.js');
    if (this.s.busy) return this.note(t('作業が終わってから裏取りしてください。'));
    const id = this.agent.session?.id;
    if (!id) return this.note(t('この会話の作業ログはありません。'));
    const {turn, yes} = proofCore.parseProofArg(arg);
    // The just-finished turn's lines may still sit in the writer's batch:
    // flush first (as /worklog does), or the badges judge the previous
    // turn's record (features-debug #41).
    try { this.agent.flushWorklogs?.(); } catch {}
    const r = proofCore.proofConversation(id, {turn});
    if (r.missing) return this.note(proofCore.noWorklogLine());
    if (r.empty) return this.note(t('その会話の作業ログは空です。'));
    if (r.outOfRange) return this.note(proofCore.outOfRangeLine(r.want, r.count));
    if (r.noReply) return this.note(proofCore.noReplyLine());
    this.push({type: 'proof', title: r.lines[0], lines: r.lines.slice(1)});
    if (r.counterPlan && r.counterPlan.status === 'ready') {
      if (yes) { this.runCounterProof(r); return; }
      return this.openMenu({title: t('反証テストを流しますか'), hint: r.counterPlan.command,
        options: [{value: 'run', label: t('流す'), desc: r.counterPlan.command}, {value: 'skip', label: t('流さない'), desc: t('裏取りだけにします')}],
        pick: v => { if (v === 'run') this.runCounterProof(r); }});
    }
  }
  async runCounterProof(r) {
    const proofCounter = require('../proof/counter.js');
    this.flash(t('反証テストを流しています…'), 120000);
    try {
      const res = await proofCounter.runCounterProof({turn: r.turn, cwd: this.agent.cwd, confirmed: true});
      this.flash('');
      this.note(proofCounter.formatCounter(res));
    } catch (e) { this.flash(''); this.note(e.message, 'error'); }
  }
  // /lore and /why: this folder's code memory (src/lore.js). Reading folds any
  // new work-log edits into records first (best effort, local only).
  loreSync() { try { if (switchValue('lore')) require('../lore.js').syncFromWorklog(this.agent.cwd); } catch {} }
  loreShow(lines) { this.push({type: 'lore', title: t('言い伝え'), lines: [].concat(lines)}); }
  loreCommand(arg) {
    const lore = require('../lore.js');
    if (!switchValue('lore')) return this.note(t('言い伝えは /settings でオフになっています。'));
    const cwd = this.agent.cwd;
    // Wave 15 (demo guards): loreSync folds the work log into records — a
    // write — and hunch / share on|off / forget write or delete records.
    // In the demo none of them touch the real store; the read subcommands
    // (list, scars, graves, hunches, story, share with no argument) work.
    const demo = this.agent.client?.status === 'demo';
    if (!demo) this.loreSync();
    const [sub, ...rest] = String(arg || '').split(/\s+/).filter(Boolean);
    try {
      if (!sub) {
        const records = lore.readRecords(cwd), ctx = lore.repoContext(cwd);
        const count = k => records.filter(r => r.kind === k).length;
        return this.loreShow([
          t('why {why} / 傷跡 {scar} / 墓標 {grave} / 仮説付箋 {hunch}', {why: count('why'), scar: count('scar'), grave: count('grave'), hunch: count('hunch')}),
          t('置き場所: {place}', {place: ctx.shared ? t('リポジトリの .muser/lore.jsonl（共有）') : ctx.localFile}),
          t('使い方: /lore scars /lore graves /lore hunches /lore story <ファイル> /why <ファイル>:<行>'),
        ]);
      }
      if (sub === 'scars' || sub === 'graves' || sub === 'hunches') {
        const hits = lore.listKind(cwd, {scars: 'scar', graves: 'grave', hunches: 'hunch'}[sub]);
        if (!hits.length) return this.note(t('まだありません。'));
        return this.loreShow(hits.slice(0, 20).map(x => lore.formatRecord(x.rec, x.loc)));
      }
      if (sub === 'story') {
        if (!rest[0]) return this.note(t('使い方: /lore story <ファイル>'));
        const hits = lore.storyFor(cwd, rest[0]);
        if (!hits.length) return this.note(t('そのファイルの言い伝えはまだありません。'));
        return this.loreShow(hits.map(x => lore.formatRecord(x.rec, x.loc)));
      }
      if (sub === 'hunch') {
        if (demo) return this.note(t('デモでは言い伝えを変更できません。'));
        const target = lore.parseFileLine(rest[0]), text = rest.slice(1).join(' ');
        if (!target || !text) return this.note(t('使い方: /lore hunch <ファイル>:<行> <前提>'));
        const rec = lore.addHunch(cwd, {path: target.file, line: target.start, text});
        return rec ? this.note(t('仮説付箋を書きました: {id}', {id: rec.id})) : this.note(t('仮説付箋を書けませんでした（機密ファイルには書きません）。'), 'error');
      }
      if (sub === 'share') {
        if (rest[0] === 'on' || rest[0] === 'off') {
          if (demo) return this.note(t('デモでは言い伝えを変更できません。'));
          const ctx = lore.setShared(cwd, rest[0] === 'on');
          return this.note(ctx.shared ? t('これからの言い伝えはリポジトリの .muser/lore.jsonl に書きます（秘密は書く前に無害化します）。') : t('これからの言い伝えはこの PC の中にだけ書きます。'));
        }
        const ctx = lore.repoContext(cwd);
        return this.note(ctx.shared ? t('共有: オン（リポジトリの .muser/lore.jsonl）') : t('共有: オフ（この PC の中だけ）'));
      }
      if (sub === 'forget') {
        if (demo) return this.note(t('デモでは言い伝えを変更できません。'));
        // A word swallowed as another flag's value is not itself a flag:
        // in `forget --path --all` the `--all` is the path's value, so it
        // must not set off a delete-everything. Scan in order and let the
        // value-taking flags consume the word after them.
        const opts = {all: false};
        for (let i = 0; i < rest.length; i++) { if (rest[i] === '--all') opts.all = true; else if (rest[i] === '--kind') opts.kind = rest[++i]; else if (rest[i] === '--path') opts.path = rest[++i]; else if (rest[i] === '--id') opts.id = rest[++i]; }
        if (!opts.all && !opts.kind && !opts.path && !opts.id) return this.note(t('使い方: /lore forget --all | --kind <種類> | --path <ファイル> | --id <id>'));
        if (opts.path) opts.path = lore.relOf(lore.repoRoot(cwd), opts.path);
        return this.note(t('{n} 件消しました。', {n: lore.forget(cwd, opts)}));
      }
      return this.note(t('使い方: /lore [scars|graves|hunches|story <ファイル>|hunch <ファイル>:<行> <前提>|share [on|off]|forget …]'));
    } catch (e) { return this.note(t('言い伝えを扱えませんでした: {error}', {error: e.message}), 'error'); }
  }
  whyCommand(arg) {
    const lore = require('../lore.js');
    if (!switchValue('lore')) return this.note(t('言い伝えは /settings でオフになっています。'));
    const cwd = this.agent.cwd, target = lore.parseFileLine(arg);
    if (!target) return this.note(t('使い方: /why <ファイル>:<行>'));
    this.loreSync();
    try {
      const hits = lore.whyFor(cwd, target.file, target.start), b = lore.blame(cwd, target.file, target.start), lines = [];
      if (b) lines.push(t('git blame: {author} {date} {summary}', {author: b.author, date: b.date, summary: b.summary}));
      if (!hits.length) lines.push(t('その行の言い伝えはまだありません。'));
      for (const x of hits) lines.push(lore.formatRecord(x.rec, x.loc));
      return this.loreShow(lines);
    } catch (e) { return this.note(t('言い伝えを扱えませんでした: {error}', {error: e.message}), 'error'); }
  }
  // ---- bug hunt (/hunt; design §6, the core lives in src/hunt.js) ----
  // The runner the hunt core drives: one spawned agent per assignment,
  // polled through the same snapshots /agents shows. Audit uses the
  // read-only explore type; fixing uses general.
  huntRunAgent() {
    const a = this.agent;
    return async ({prompt, kind, tag}) => {
      const w = a.spawn(prompt, {by: 'hunt', type: kind === 'fix' ? 'general' : 'explore', title: t('バグ狩り {tag}', {tag: tag || ''})});
      const deadline = Date.now() + 30 * 60 * 1000;
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        const snap = a.agents().find(x => x.tag === w.tag);
        if (!snap) throw new Error('hunt agent not found: ' + w.tag);
        if (snap.state === 'done') return snap.result || '';
        if (snap.state === 'failed' || snap.state === 'stopped') throw new Error(snap.error || ('hunt agent ' + snap.state + ': ' + w.tag));
        if (Date.now() > deadline) { try { a.stopAgent(w.tag); } catch {} throw new Error('hunt agent timed out: ' + w.tag); }
      }
    };
  }
  huntCommand(arg) {
    const hunt = require('../hunt.js');
    const a = this.agent;
    const words = String(arg || '').trim();
    if (!words || words === 'status') {
      // While a hunt runs, its state.json on disk is the freshest picture.
      const state = hunt.readStatus(a.cwd) || this.huntState;
      return this.push({type: 'hunt', lines: hunt.formatStatusLines(state)});
    }
    if (this.huntRunning) return this.note(t('バグ狩りが実行中です。'));
    if (this.s.busy || a.busy) return this.note(t('作業中はバグ狩りを始められません。'));
    const fixMatch = /^fix(?:\s+(\S+))?$/.exec(words);
    if (fixMatch) {
      let prepared;
      try { prepared = hunt.prepareFix({cwd: a.cwd, level: fixMatch[1] || 'High'}); } catch (e) { return this.note(e.message, 'error'); }
      if (!prepared.targets.length) return this.note(t('修正できる所見がありません。'));
      prepared.estimate.account = a.accountLabel || a.accountId || 'default';
      return this.openMenu({title: t('バグ狩りの修正を開始しますか？'),
        options: [{value: 'start', label: t('開始する'), desc: hunt.formatEstimateLines(prepared.estimate)[0] + ' · ' + (prepared.targets.length === 1 ? t('対象 1 件') : t('対象 {n} 件', {n: prepared.targets.length}))},
          {value: 'cancel', label: t('やめる')}],
        pick: v => { if (v === 'start') this.startHuntFix(prepared); }});
    }
    let prepared;
    try { prepared = hunt.prepareAudit({cwd: a.cwd, scope: words, account: a.accountId, accountLabel: a.accountLabel || a.accountId}); } catch (e) { return this.note(e.message, 'error'); }
    return this.openMenu({title: t('バグ狩りを開始しますか？'),
      options: [{value: 'start', label: t('開始する'), desc: hunt.formatEstimateLines(prepared.estimate)[0]},
        {value: 'cancel', label: t('やめる')}],
      pick: v => { if (v === 'start') this.startHuntAudit(prepared); }});
  }
  startHuntAudit(prepared) {
    const hunt = require('../hunt.js');
    const a = this.agent;
    this.huntRunning = true;
    this.note(prepared.estimate.agents === 1 ? t('バグ狩りを開始しました（エージェント 1 体）。') : t('バグ狩りを開始しました（エージェント {agents} 体）。', {agents: prepared.estimate.agents}));
    hunt.runAudit(prepared, {runAgent: this.huntRunAgent(), quota: hunt.makeDefaultQuota(), account: a.accountId})
      .then(state => { this.huntRunning = false; this.huntState = state; this.push({type: 'hunt', lines: hunt.formatStatusLines(state)}); this.note(t('バグ狩りが終わりました。')); })
      .catch(e => { this.huntRunning = false; this.note(e.message, 'error'); });
  }
  startHuntFix(prepared) {
    const hunt = require('../hunt.js');
    const a = this.agent;
    this.huntRunning = true;
    this.note(prepared.targets.length === 1 ? t('修正を開始しました（対象 1 件）。') : t('修正を開始しました（対象 {n} 件）。', {n: prepared.targets.length}));
    hunt.runFix(prepared, {runAgent: this.huntRunAgent(), quota: hunt.makeDefaultQuota(), account: a.accountId})
      .then(r => { this.huntRunning = false; this.huntState = r.state; hunt.offerScarsToLore(r.outcomes, a.cwd); this.push({type: 'hunt', lines: hunt.formatFixSummaryLines(r.summary)}); this.note(t('修正が終わりました。')); })
      .catch(e => { this.huntRunning = false; this.note(e.message, 'error'); });
  }
  // /crash [プロセス名]: line the recent falls up with the changes that came
  // before them (src/crash-investigate.js) and hand the whole thing to Muse
  // as a turn, as the design asks. The panel is pushed first, so the user
  // sees the same lines even while the turn queues behind work in flight;
  // when nothing fell, the panel is all there is (no turn is started).
  crashCommand(arg) {
    const crashInvestigate = require('../crash-investigate.js');
    const filter = String(arg || '').trim();
    this.flash(t('クラッシュを調べています…'), 20000);
    return crashInvestigate.investigate({process: filter || undefined, cwd: this.agent.cwd}).then(rep => {
      this.flash('');
      this.push({type: 'crash', lines: crashInvestigate.formatLines(rep)});
      if (rep.crashes.length) return this.submit(crashInvestigate.formatPrompt(rep));
    }).catch(e => {
      this.flash('');
      this.note(t('クラッシュ調査に失敗しました: {error}', {error: e.message}), 'error');
    });
  }
  slash(line) {
    // The argument is the rest of the line as typed: a multi-line task after /agent or /skill had
    // its line breaks and indentation squeezed into single spaces.
    const m = /^(\S+)\s*([\s\S]*)$/.exec(line), cmd = m[1], arg = m[2], a = this.agent;
    if (cmd === '/exit' || cmd === '/quit') return this.onExit();
    if (cmd === '/help') return this.push({type: 'help'});
    // Wave 15: commands whose work lives in agent methods the demo's
    // scripted agent does not have (/goal → setGoal, /agent → types/spawn,
    // /agents → agents, /hunt → spawn/agents, /focus carry → adoptFocus)
    // used to die with a raw TypeError in the demo. They answer with the
    // demo refusal instead. The check is the method's absence, so a
    // stand-in that HAS the method is unaffected.
    if (a.client?.status === 'demo') {
      const needs = cmd === '/goal' ? ['setGoal']
        : cmd === '/agent' || cmd === '/spawn' ? ['types', 'spawn']
        : cmd === '/agents' ? ['agents']
        : cmd === '/hunt' ? ['spawn', 'agents']
        : cmd === '/focus' && (arg === 'carry' || arg.startsWith('carry ')) ? ['adoptFocus']
        : null;
      if (needs && needs.some(n => typeof a[n] !== 'function')) return this.note(t('デモでは {cmd} は使えません。', {cmd}));
    }
    if (cmd === '/settings') return arg === 'agents' ? this.agentLimitsMenu() : this.settingsMenu();
    if (cmd === '/focus') {
      if (arg === 'off' || arg === 'on') {
        if (this.s.busy) return this.note(t('Focus の切替は作業が終わってから行ってください。'));
        a.focusEnabled = arg === 'on';
        a.resumeFocus = null; // an unfinished task from before the switch is not picked up by a later message
        return this.note(t('Focus 自動管理: {state}（このウィンドウのみ）', {state: a.focusEnabled ? 'on' : 'off'}));
      }
      // Weakness 5 (2026-11-06): carry an unfinished task saved under another
      // conversation into this one (after that conversation's Muse started
      // refusing the work). The next message resumes it from where it stopped.
      if (arg === 'carry' || arg.startsWith('carry ')) {
        const ref = arg.slice('carry'.length).trim();
        if (!ref) return this.note(t('使い方: /focus carry <会話の ID>'));
        if (this.s.busy) return this.note(t('作業が終わってから引き継いでください。'));
        const r = a.adoptFocus(ref);
        if (r.ok) { this.push({type: 'focus', focus: r.focus, full: true}); return this.note(t('タスクを引き継ぎました。次のメッセージで続きから再開します。')); }
        if (r.error === 'ambiguous') return this.note(t('その ID にあてはまる会話が複数あります。もう少し長く指定してください。'));
        if (r.error === 'not-found') return this.note(t('その会話が見つかりません。'));
        return this.note(t('その会話に引き継げるタスクがありません。'));
      }
      if (arg) return this.note(t('使い方: /focus（状態） /focus on /focus off /focus carry <会話の ID>'));
      const focus = a.focusStatus?.();
      if (focus && focus.status !== 'inactive') return this.push({type: 'focus', focus, full: true});
      return this.note(t('Focus: {state}', {state: a.focusEnabled === false ? 'off' : 'on'}));
    }
    if (cmd === '/proof') return this.proofCommand(arg);
    if (cmd === '/debug') {
      // Weakness 9: this conversation's recent decision log — the last 20
      // lines, in file order (oldest first).
      if (arg === 'log') {
        const id = a.session?.id;
        if (!id) return this.note(t('この会話の判定ログはありません。'));
        const entries = FocusLog.readFile(logFile(id), {limit: 20});
        if (!entries.length) return this.note(t('この会話の判定ログはまだありません。Focus のタスクを実行すると記録されます。'));
        return this.note([t('この会話の判定ログ（最新 {n} 件）:', {n: entries.length}), ...FocusLog.format(entries)]);
      }
      // Measurement subcommands (docs/design/memory.md, stage 0); COMMANDS now names mem/heap too (wave 6: they were hidden slashes).
      if (arg === 'mem') return this.note(memReportLines({entries: this.s.entries, outputs: this.outputs, mem: process.memoryUsage()}));
      if (arg === 'heap') {
        try { const {file, bytes} = writeHeapSnapshot(); return this.note(t('ヒープスナップショットを保存しました: {file}（{mb} MB）', {file, mb: (bytes / 1024 / 1024).toFixed(1)})); }
        catch (e) { return this.note(t('ヒープスナップショットを保存できませんでした: {error}', {error: e.message}), 'error'); }
      }
      return this.note([t('使い方: /debug log（この会話の判定ログ）'), t('使い方: /debug mem（メモリの内訳） /debug heap（ヒープスナップショットを保存）')]);
    }
    if (cmd === '/worklog') {
      // No arguments (like /export): an argument used to be silently ignored
      // and the log shown anyway, so a typo looked like an empty log.
      if (arg) return this.note(t('使い方: /worklog（引数はありません）'));
      // This conversation's work log (design §1): the last 20 events, in
      // file order — the same shape as /debug log for the decision log.
      // This window's own writer batches its appends, so flush it first;
      // another window's writes to the same conversation may still be queued there.
      const id = a.session?.id;
      if (!id) return this.note(t('この会話の作業ログはありません。'));
      try { a.worklogFor?.(a.main)?.flush(); } catch {}
      const {Worklog} = require('../worklog.js');
      const entries = Worklog.read(id).slice(-20);
      if (!entries.length) return this.note(t('この会話の作業ログはまだありません。'));
      return this.note([t('この会話の作業ログ（最新 {n} 件）:', {n: entries.length}), ...Worklog.format(entries)]);
    }
    if (cmd === '/lore') return this.loreCommand(arg);
    if (cmd === '/why') return this.whyCommand(arg);
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
        options: list.map((o, i) => ({value: i, label: o.command.replace(/^code\./, '') + '  ' + String(o.summary).slice(0, 60), desc: t('{n} 行', {n: this.outputText(o).split('\n').length})})),
        pick: i => this.showOutput(list[i])});
    }
    if (cmd === '/usage') {
      this.flash(t('Muse の利用状況を確認しています…'), 20000);
      return this.refreshPlan().then(p => {
        this.flash('');
        this.note([...(p ? usage.formatPlan(p).split('\n') : [t('Muse の利用状況を読み込めませんでした（muse.ai で確認できます）')]), '', ...usage.formatSummary().split('\n')]);
      });
    }
    if (cmd === '/export') {
      if (arg) return this.note(t('使い方: /export（引数はありません）'));
      return this.exportReport();
    }
    if (cmd === '/lang') {
      // With MUSER_LANG set the environment wins on the next start, so a change here is only
      // for this run — say so, instead of letting the user think it was saved for good.
      // W2F-6: in demo the switch applies to this run only — setLang's save
      // is off, like the other settings paths ({save: !demo}).
      const demo = a.client?.status === 'demo';
      const langNote = (v, saved = true) => t('言語を {lang} に切り替えました', {lang: v === 'en' ? 'English' : '日本語'}) +
        // Wave 7: in demo the switch is not saved either — say so, like the
        // MUSER_LANG note below, instead of letting it look saved.
        (demo ? ' ' + t('（デモでは保存されません）') : '') +
        // Wave 14: a save that FAILED says so too — the window has switched, but
        // nothing was written, so the next start goes back (setLang now reports it).
        (!demo && !saved ? ' ' + t('（保存できませんでした。この窓では切り替わりましたが、次回起動では元に戻ります）') : '') +
        (process.env.MUSER_LANG ? ' ' + t('（MUSER_LANG が設定されているため、環境変数が優先されます。この切り替えは今回の実行中だけです）') : '');
      // /lang en switches at once (the argument used to be ignored and the menu opened).
      const want = ({en: 'en', english: 'en', ja: 'ja', jp: 'ja', japanese: 'ja', '日本語': 'ja'})[arg.toLowerCase()];
      if (want) { const saved = i18n.setLang(want, {save: !demo}); this.set({}); return this.note(langNote(want, saved)); }
      return this.openMenu({
        title: t('表示言語'),
        options: [{value: 'en', label: 'English', desc: t('英語で表示')}, {value: 'ja', label: '日本語', desc: t('日本語で表示')}],
        index: i18n.lang() === 'en' ? 0 : 1, current: i18n.lang(),
        pick: v => { const saved = i18n.setLang(v, {save: !demo}); this.set({}); this.note(langNote(v, saved)); },
      });
    }
    if (cmd === '/mode' || cmd === '/permissions' || cmd === '/perm') {
      // Any case, and the words people use for them (/mode Bypass, /mode auto, /mode readonly).
      const want = arg && modeFrom(arg);
      if (arg && !want) return this.note(t('モードは {modes}', {modes: MODES.join(' / ')}));
      // Wave 14: only announce the mode when setMode actually took it. A
      // failed save already noted the failure and rolled back; following it
      // with this success-shaped note (naming the rolled-back old mode)
      // read as if the change had landed. In a --mode window the change is
      // this window only — the note says so instead of implying a save.
      if (want) { if (!this.setMode(want)) return; return this.note(a.modeExplicit ? t('承認モード: {label}（この窓だけです）', {label: t(LABELS[a.mode])}) : t('承認モード: {label}', {label: t(LABELS[a.mode])})); }
      // Wave 13 (3): the menu — above all the 「記憶した許可を消す」 entry — is
      // built from the permissions file's latest state, not this window's
      // startup snapshot: keys another window remembered since then are
      // listed here (and clearable from here), and keys it revoked are gone.
      // The agent's refreshPermissions does the sync when it has one; a
      // plainer agent (demo, tests) is synced straight from the file here.
      if (a.client?.status !== 'demo') {
        if (typeof a.refreshPermissions === 'function') a.refreshPermissions();
        else { try { const fresh = permissions.load(a.cwd); a.allowAlways.clear(); for (const k of fresh.allow || []) a.allowAlways.add(k); if (!a.modeExplicit && fresh.mode && fresh.mode !== a.mode) { a.mode = fresh.mode; this.set({mode: fresh.mode}); } } catch {} }
      }
      return this.openMenu({
        title: t('承認モード（権限）'),
        options: [...MODES.map(m => ({value: m, label: t(LABELS[m]), desc: t(MODE_HELP[m]), danger: m === 'bypass'})),
          ...(a.allowAlways.size ? [{value: '__forget', label: t('記憶した許可を消す'), desc: t('{n} 件: {list}', {n: a.allowAlways.size, list: [...a.allowAlways].map(k => k.replace(/^exec:/, '').replace(/^mcp:/, 'MCP ')).join(' · ').slice(0, 120)})}] : [])],
        index: MODES.indexOf(a.mode), current: a.mode,
        pick: m => {
          if (m === '__forget') {
            // Wave 14: a clear that THROWS (lock contention, EEXIST) is a
            // failed clear too — permissions reports it as false now, and
            // the try keeps any other throw from reaching the menu's
            // generic catch as raw text. Nothing is forgotten then: the
            // in-memory keys stay and the failure is noted, as for false.
            let cleared = true;
            if (a.client?.status !== 'demo') { try { cleared = permissions.clearAllow(a.cwd); } catch { cleared = false; } }
            if (!cleared) return this.note(t('記憶した許可をファイルから消せませんでした。'));
            a.allowAlways.clear(); return this.note(t('このフォルダーで記憶した許可を消しました。'));
          }
          // Wave 14: in a --mode window setMode saved nothing (this window
          // only), so the remembered-for-this-folder note would be a lie;
          // say it is this window only. A failed save already noted itself.
          if (this.setMode(m)) this.note(a.modeExplicit ? t('承認モード: {label}（この窓だけです）', {label: t(LABELS[m])}) : t('承認モード: {label}（このフォルダーで覚えておきます）', {label: t(LABELS[m])}));
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
      // Wave 16 (4): attachments and the held queue belong to the old chat
      // too — an image composed for it was silently sent into the new chat,
      // and queued text for it was delivered there. Clear the attachments,
      // and drop the queue with a note saying how many were cancelled.
      this.dropQueueForTransition();
      this.set({todos: [], focus: null, goal: a.standingGoal?.() || null, attachments: []});
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
      // Another account's chat is marked before it is picked (it cannot be continued here; see showResumed).
      const elsewhere = s => { const id = s.account || 'default'; if (!a.accountId || id === a.accountId) return ''; try { return ' · ' + t('アカウント {label}', {label: require('../accounts.js').get(id)?.label || id}); } catch { return ''; } };
      if (!arg) {
        // Every folder's chats, a page per folder: this folder first, then the others by their
        // newest chat; ← / → turn the pages (the list only ever showed this exact folder, so
        // chats from a window opened elsewhere looked lost).
        const here = String(a.cwd || '').toLowerCase(), byFolder = new Map();
        for (const s of sessions.recent().filter(x => x.turns)) {
          const key = String(s.cwd || '').toLowerCase();
          if (!byFolder.has(key)) byFolder.set(key, {cwd: s.cwd || '', list: []});
          byFolder.get(key).list.push(s);
        }
        const folders = [...byFolder.values()], hi = folders.findIndex(f => f.cwd.toLowerCase() === here);
        if (hi > 0) folders.unshift(folders.splice(hi, 1)[0]);
        if (!folders.length) return this.note(t('このフォルダーの過去の会話はありません。'));
        const page = fi => {
          const f = folders[fi], other = f.cwd.toLowerCase() !== here;
          const where = other ? (f.cwd || t('（フォルダー不明）')) : t('このフォルダー');
          this.openMenu({title: t('会話を再開') + ' · ' + where + (folders.length > 1 ? '  (' + (fi + 1) + '/' + folders.length + ')' : ''),
            hint: [folders.length > 1 ? t('← → でほかのフォルダー') : '', other ? t('ほかのフォルダーの会話は、この窓のフォルダーで続きます') : ''].filter(Boolean).join(' · ') || undefined,
            // Wave 8 (3): the row itself is the resume target (carried on the
            // option, handed back by menuKey as pick's second argument). The
            // old pick re-looked the id up with sessions.find, which refuses
            // an id held by two entries as ambiguous and returns null — so
            // with a duplicated id in the list, picking either row silently
            // resumed nothing. The id lookup stays only as a fallback for a
            // pick invoked without its option.
            options: f.list.map(s => ({value: s.id, session: s, label: s.title || s.id, desc: new Date(s.updated).toLocaleString(i18n.lang()) + ' · ' + t('{n} ターン', {n: s.turns}) + elsewhere(s)})),
            pick: (id, opt) => this.showResumed(opt?.session || sessions.find(id)),
            side: d => page((fi + d + folders.length) % folders.length)});
        };
        return page(0);
      }
      if (!list.length) return this.note(t('このフォルダーの過去の会話はありません。'));
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
      // W13-14: an exact id shared by 2+ of this folder's chats (a hand-edited /
      // merged index) must not silently pick the newest exact match below —
      // no longer spelling can tell them apart either. Refuse, naming the
      // sharing, in the same style as the ambiguous-prefix note below. (The
      // number path above yields a single row, so it is unaffected, as is the
      // no-argument menu, whose rows carry their own session object.)
      const exactMatches = matches.filter(x => x.id === arg);
      if (exactMatches.length > 1) return this.note(t('候補が複数あります: {list} — その ID はこのフォルダーの {n} 件の会話で共有されています', {list: exactMatches.map(x => x.id).join(', '), n: exactMatches.length}), 'error');
      const s = matches.find(x => x.id === arg) || (matches.length === 1 ? matches[0] : null);
      if (!s && matches.length > 1) return this.note(t('候補が複数あります: {list} — もう少し長く指定してください', {list: matches.map(x => x.id).join(', ')}), 'error');
      if (!s) {
        // W13-14 remainder: the arg is not an id in this folder (the numeric,
        // exact-id, duplicate-guard and prefix-ambiguity outcomes above are
        // all settled) — fall back to title/body search in this folder. A
        // pure-digit arg fell through from the numeric path and is not
        // treated as search text. Several hits open a menu whose options
        // carry their session object, so a duplicated id still resumes the
        // row picked, never a re-lookup by id.
        if (!/^\d+$/.test(arg) && typeof sessions.search === 'function') {
          const hits = sessions.search(arg, {cwd: a.cwd});
          if (hits.length === 1) return this.showResumed(hits[0].session);
          if (hits.length > 1) return this.openMenu({title: t('検索: {q}', {q: arg}), options: hits.map(h => { const hs = h.session; return {value: hs.id, session: hs, label: hs.title || hs.id, desc: new Date(hs.updated).toLocaleString(i18n.lang()) + ' · ' + t('{n} ターン', {n: hs.turns}) + elsewhere(hs) + (h.matchedIn === 'body' && h.snippet ? ' · ' + h.snippet : '')}; }), pick: (id, opt) => this.showResumed(opt?.session || sessions.find(id))});
        }
        return this.note(t('見つかりません: {arg}', {arg}));
      }
      return this.showResumed(s);
    }
    if (cmd === '/mcp') return this.mcpMenu();
    if (cmd === '/bg' || cmd === '/shells') {
      const [sub, id] = arg.split(/\s+/);
      // Wave 8 (2): Shells.kill reports whether the kill actually landed
      // ({killed}) — a shell that had already finished (or whose pid was
      // already gone) answers killed:false, and the old code announced
      // "stopped it" anyway. Only a landed kill is announced as one.
      if (sub === 'kill' && id) { try { const r = a.shells.kill(id); return r?.killed ? this.note(t('{id} を止めました', {id})) : this.note(t('{id} はすでに終わっています', {id})); } catch (e) { return this.note(e.message, 'error'); } }
      const list = a.shells.all();
      if (!list.length) return this.note(t('バックグラウンドの処理はありません。'));
      return this.openMenu({title: t('バックグラウンドの処理'), hint: t('/bg kill <id> で停止'), options: list.map(x => ({value: x.id, label: x.id + '  ' + x.command.slice(0, 22), desc: (x.running ? t('● 実行中 ') : t('○ 終了 exit {exit} ', {exit: x.exit})) + stripEmbeds(x.tail.filter(Boolean).pop() || '')})),
        pick: async id => {
          const r = await a.shells.output(id, {since: 0, maxChars: 200000});
          // Sanitised like any other command output shown on screen: the shellout
          // entry below draws these lines as-is, escapes and all otherwise.
          const full = stripEmbeds(frames(r.output)).trimEnd();
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
      // The name is matched the way skill.read matches it — skills.normalizeName, the one
      // normalisation load() registers under (wave 10). The old toLowerCase-only lookup
      // missed names whose non-name characters became '-' at load ('Foo@Bar' is registered
      // 'foo-bar'), so /skill said there was no such skill for one skill.read finds.
      const all = skills.load(a.cwd), s = all.find(x => x.name === skills.normalizeName(name));
      if (!name || !s) return this.note([t('使い方: /skill <名前> <頼みたいこと>'), t('スキル: {list}', {list: all.filter(x => x.enabled).map(x => x.name).join(', ') || t('（ありません）')})]);
      if (!s.enabled) return this.note(t('{name} はオフです（/skills でオンにできます）', {name: s.name}));
      return this.submit(skills.skillSentence(s.name) + ' ' + request);
    }
    if (cmd === '/status') return this.push({type: 'status'});
    if (cmd === '/hunt') return this.huntCommand(arg);
    if (cmd === '/crash') return this.crashCommand(arg);
    if (cmd === '/parity') return this.parityCommand(arg);
    // In the user's language: it is their message in the chat, and AGENTS.md came out in Japanese for English users.
    if (cmd === '/init') return this.submit(t('このリポジトリを調べて、AGENTS.md を作ってください（ビルド・テスト方法、構成、規約、注意点を簡潔に）。既にあれば足りないところを更新してください。'));
    if (cmd === '/race') return this.raceCommand(arg);
    if (cmd === '/overnight') {
      // Night work (src/overnight/cli.js, shared with `muser overnight`). add /
      // list / remove / report answer at once as an 'overnight' entry; start
      // runs in the background (its own muser exec children, in worktrees)
      // and the morning report lands as another entry when it finishes.
      const words = arg ? arg.split(/\s+/).filter(Boolean) : [];
      // Wave 15: the write subcommands (add / remove / clear / start /
      // config) touch the real queue and config — in the demo they refuse,
      // like the other demo guards. list / estimate / report only read.
      if (a.client?.status === 'demo' && ['add', 'remove', 'clear', 'start', 'config'].includes(words[0] || 'list')) return this.note(t('デモでは夜間作業を変更できません。'));
      const {overnightCli} = require('../overnight/cli.js');
      if ((words[0] || 'list') === 'start') {
        // W2F-4: no guard existed — a second start ran concurrently. The
        // flag stands synchronously at the entrance, before any await.
        if (this.overnightRun) return this.note(t('夜間作業は実行中です。終わるまで待ってください。'), 'error');
        this.overnightRun = true;
        this.note(t('夜間作業を開始しました。終わったら報告をここに出します。'));
        return overnightCli(['start', ...words.slice(1)], {cwd: a.cwd}).then(r => this.push({type: 'overnight', lines: r.lines})).catch(e => this.note(String(e.message || e), 'error')).finally(() => { this.overnightRun = false; });
      }
      return overnightCli(words.length ? words : ['list'], {cwd: a.cwd}).then(r => this.push({type: 'overnight', lines: r.lines})).catch(e => this.note(String(e.message || e), 'error'));
    }
    const near = nearSlashCommand(cmd);
    if (near) return this.note(t('知らないコマンド: {cmd}。もしかして: {near}（/help で一覧）', {cmd, near}), 'error');
    this.note(t('知らないコマンド: {cmd}  （/help で一覧）', {cmd}), 'error');
  }
  // /race <頼み> （競争, src/race.js): show the estimate first and confirm in
  // a menu, then run the race behind this window (child `muser exec`
  // processes in their own worktrees). The result lands as a 'race' entry;
  // the worktrees stay until the user picks a winner or discards them.
  raceCommand(arg) {
    // Wave 15: a race runs real child processes in real worktrees (and
    // apply / clean write and delete there) — in the demo it refuses, like
    // the other demo guards, before any of that is touched.
    if (this.agent.client?.status === 'demo') return this.note(t('デモでは競争は使えません。'));
    const race = require('../race.js');
    // `apply <id> [n]` / `clean <id>` finish a race that was left standing
    // (the CLI's `muser race apply/clean`): they name a stored race, not a
    // new task — parseRaceArgs below would read them as task text and show
    // the new-race start menu. They also work while another race runs here.
    const words = String(arg || '').split(/\s+/).filter(Boolean);
    if (words[0] === 'apply' || words[0] === 'clean') return this.raceApplyCommand(race, words);
    if (this.raceRun) return this.note(t('競争は実行中です。終わるまで待ってください。'), 'error');
    const opts = race.parseRaceArgs(arg);
    if (!opts.task) return this.note(t('使い方: /race [--n 3] [--accounts a,b] [--max-tokens N] [--yes] <頼み>'));
    // W2F-4: reserve synchronously here, at the entrance. The flag used to
    // stand only inside start(), which runs after the async dirtyFiles /
    // estimate / menu steps — a second /race --yes in that window passed
    // the guard above and started a second race. Released by start()'s
    // finally, by cancelling the confirm menu, or if the estimate fails.
    this.raceRun = true;
    const cwd = this.agent.cwd;
    const start = async includeDirty => {
      this.raceRun = true;
      this.note(t('競争を始めます: {task}', {task: opts.task.slice(0, 60)}));
      try {
        const result = await race.runRace({cwd, task: opts.task, n: opts.n || 3, accounts: opts.accounts, maxTokens: opts.maxTokens, includeDirty, onProgress: m => this.flash(m, 4000)});
        this.racePending = result;
        this.push({type: 'race', lines: race.formatRaceResult(result)});
        this.raceWinnerMenu(result);
      } catch (e) { this.note(t('競争に失敗しました: {error}', {error: e.message}), 'error'); }
      finally { this.raceRun = false; }
    };
    race.dirtyFiles(cwd).then(dirty => {
      const lines = [...race.estimate({n: opts.n || 3, accounts: opts.accounts, maxTokens: opts.maxTokens}).lines];
      if (dirty.length) lines.push(t('未コミットの変更が {n} 件あります。含めた状態から始めます。', {n: dirty.length}));
      this.note(lines);
      if (opts.yes) return start(dirty.length > 0);
      this.openMenu({title: t('競争を始めますか？'), options: [
        {value: 'start', label: t('始める')},
        {value: 'cancel', label: t('やめる')},
      ], pick: v => { if (v === 'start') start(dirty.length > 0); else this.raceRun = false; }, cancel: () => { this.raceRun = false; }});
    }).catch(e => { this.raceRun = false; this.note(e.message, 'error'); });
  }
  // /race apply <id> [n] [--yes] and /race clean <id>: the slash form of the
  // CLI's finish-a-standing-race path (bin/muser.js raceCommand). With a
  // racer number, the diff is shown and confirmed here — the same second
  // step raceWinnerMenu takes after a pick, without opening that menu too.
  // Without a number, the winner menu itself opens on the loaded race.
  raceApplyCommand(race, words) {
    const yes = words.includes('--yes');
    const [id, num] = words.slice(1).filter(w => w !== '--yes');
    if (!id) return this.note(t('使い方: /race apply <ID> <番号> /race clean <ID>'));
    const result = race.loadRace(id);
    if (!result) return this.note(t('競争が見つかりません: {id}', {id}), 'error');
    if (words[0] === 'clean') {
      return race.cleanupRace(result).then(() => {
        if (this.racePending?.id === result.id) this.racePending = null;
        this.note(t('片付けました: {id}', {id: result.id}));
      }).catch(e => this.note(e.message, 'error'));
    }
    if (num === undefined) { this.racePending = result; return this.raceWinnerMenu(result); }
    const index = Number(num);
    if (!result.racers.some(r => r.index === index)) return this.note(t('競争が見つかりません: {id}', {id: num}), 'error');
    const apply = async () => {
      const applied = await race.applyWinner(result, index);
      if (!applied.ok) return this.note(applied.error || t('当てられませんでした。'), 'error');
      await race.cleanupRace(result);
      if (this.racePending?.id === result.id) this.racePending = null;
      // applyWinner reports empty for a winner whose patch is empty (it changed
      // nothing): '当てました' claimed a change that never happened.
      this.note(applied.empty ? t('変更はありませんでした。作業フォルダーを片付けました。') : t('当てました。作業フォルダーを片付けました。'));
    };
    const diff = race.diffText(result, index);
    if (diff) this.note([t('{n} の差分:', {n: index}), ...diff.split('\n').slice(0, 60)]);
    if (yes) return apply().catch(e => this.note(e.message, 'error'));
    return this.openMenu({title: t('この差分を当てますか？'), options: [
      {value: 'apply', label: t('当てる')},
      {value: 'keep', label: t('当てずに残す')},
    ], pick: async w => {
      if (w !== 'apply') return this.note(t('当てずに残してあります: {dir}', {dir: result.dir}));
      try { await apply(); } catch (e) { this.note(e.message, 'error'); }
    }});
  }
  raceWinnerMenu(result) {
    const race = require('../race.js');
    this.openMenu({title: t('競争の結果が出ました。どれを使いますか？'), options: [
      ...result.racers.filter(r => r.status !== 'skipped').map(r => ({value: r.index, label: t('{n}. {strategy}', {n: r.index, strategy: t(r.strategy.label)}), desc: t('差分 {files} ファイル +{added} −{removed}', {files: r.diff?.files || 0, added: r.diff?.added || 0, removed: r.diff?.removed || 0})})),
      {value: 0, label: t('どれも使わない（片付ける）')},
    ], pick: async v => {
      if (!v) { await race.cleanupRace(result); this.racePending = null; return this.note(t('片付けました: {id}', {id: result.id})); }
      const diff = race.diffText(result, v);
      if (diff) this.note([t('{n} の差分:', {n: v}), ...diff.split('\n').slice(0, 60)]);
      this.openMenu({title: t('この差分を当てますか？'), options: [
        {value: 'apply', label: t('当てる')},
        {value: 'keep', label: t('当てずに残す')},
      ], pick: async w => {
        if (w !== 'apply') return this.note(t('当てずに残してあります: {dir}', {dir: result.dir}));
        const applied = await race.applyWinner(result, v);
        if (!applied.ok) return this.note(applied.error || t('当てられませんでした。'), 'error');
        await race.cleanupRace(result); this.racePending = null;
        this.note(applied.empty ? t('変更はありませんでした。作業フォルダーを片付けました。') : t('当てました。作業フォルダーを片付けました。'));
      }});
    }});
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
