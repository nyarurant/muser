'use strict';
// Account-switch handoff note: when the user switches Muse accounts, the new account's
// Muse starts from a fresh chat and knows nothing of the work so far. buildHandoff turns
// the old session's state (folder, focus, todos, git status, recent transcript, and a
// pointer to the full transcript file the new Muse can read on demand) into one
// deterministic Japanese note that is handed to that new chat as its first context.
//
// Pure: no I/O, no clock, no randomness — the same input always gives the same note, and
// this module never touches the secure store or the filesystem.
//
// NOTE (i18n): the note's text is plain Japanese constants on purpose, NOT wrapped in
// t() from ./i18n. The note is content handed to Muse (like a transcript), not UI chrome,
// and its wording must stay byte-identical regardless of the display language; the
// integrator can revisit this if the note ever becomes user-facing UI.

const MAX_TOTAL = 4000;      // the whole note is capped near this many characters
const MAX_TURNS = 6;         // transcript turns kept (the newest ones)
const MAX_TURN_CHARS = 300;  // per speaker text inside one transcript turn
const MAX_GIT_LINES = 30;    // `git status --porcelain` lines kept

function str(v) { return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim(); }

// One speaker's text, cut to the per-turn budget with an ellipsis when it was longer.
function clip(text, n = MAX_TURN_CHARS) {
  const s = str(text);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Todo statuses arrive as pending / in_progress / completed (see todo.write in src/tools.js,
// which normalizes the same synonyms); anything unrecognized counts as pending.
function todoStatus(s) {
  const k = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['completed', 'complete', 'done', 'finished'].includes(k)) return 'completed';
  if (['in_progress', 'inprogress', 'active', 'doing', 'started', 'working'].includes(k)) return 'in_progress';
  return 'pending';
}
const TODO_MARK = {completed: '☑', in_progress: '◼', pending: '☐'};

// Tolerate plain strings ("do X") as well as {content, status} objects.
function normTodos(todos) {
  if (!Array.isArray(todos)) return [];
  const out = [];
  for (const t of todos) {
    if (typeof t === 'string') { if (t.trim()) out.push({content: t.trim(), status: 'pending'}); continue; }
    if (!t || typeof t !== 'object') continue;
    const content = str(t.content ?? t.text);
    if (content) out.push({content, status: todoStatus(t.status)});
  }
  // Unfinished work first (in progress before not started), finished last; the order
  // inside each group is the caller's order, so the note stays deterministic.
  const rank = {in_progress: 0, pending: 1, completed: 2};
  return out.map((t, i) => [t, i]).sort((a, b) => rank[a[0].status] - rank[b[0].status] || a[1] - b[1]).map(([t]) => t);
}

function normFocus(focus) {
  if (!focus || typeof focus !== 'object') return null;
  const goal = str(focus.goal);
  const criteria = (Array.isArray(focus.criteria) ? focus.criteria : []).map(c => {
    if (typeof c === 'string') return c.trim() ? {text: c.trim(), status: ''} : null;
    if (!c || typeof c !== 'object') return null;
    const text = str(c.text ?? c.content);
    return text ? {text, status: str(c.status)} : null;
  }).filter(Boolean);
  return goal || criteria.length ? {goal, criteria} : null;
}

function normGit(gitLines) {
  if (!Array.isArray(gitLines)) return [];
  return gitLines.map(l => String(l ?? '').replace(/\s+$/, '')).filter(l => l.trim());
}

// Transcript turns are the objects sessions.transcript(id) returns, one per finished turn
// of the main chat (src/sessions.js / src/agent.js record()):
//   {v, at, user, reply, error?, tools, steps, progress?, focus?, sources, todos}
// Only user / reply / error carry prose; a turn with none of them has nothing to hand over.
function normTurns(turns) {
  if (!Array.isArray(turns)) return [];
  const out = [];
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue;
    const user = str(t.user), reply = str(t.reply), error = str(t.error);
    if (!user && !reply && !error) continue;
    out.push({user, reply, error});
  }
  return out.slice(-MAX_TURNS);
}

function renderTurn(t) {
  const lines = [];
  if (t.user) lines.push('ユーザー: ' + clip(t.user));
  if (t.reply) lines.push('Muse: ' + clip(t.reply));
  if (t.error) lines.push('エラー: ' + clip(t.error));
  return lines.join('\n');
}

function buildHandoff(input) {
  const {fromLabel, toLabel, cwd, sessionTitle, turns, todos, focus, gitLines, recordPath} = input || {};
  const from = str(fromLabel), to = str(toLabel);
  const head = from && to
    ? 'これは前のアカウント（' + from + '）から新しいアカウント（' + to + '）への引き継ぎメモです。ここまでの作業を、このアカウントで続けてください。'
    : from
      ? 'これは前のアカウント（' + from + '）からの引き継ぎメモです。ここまでの作業を、このアカウントで続けてください。'
      : 'これは前のアカウントからの引き継ぎメモです。ここまでの作業を、このアカウントで続けてください。';

  // Every section except the transcript, in a fixed order; empty sections are omitted.
  const blocks = [head];
  if (str(cwd)) blocks.push('■ 作業フォルダー\n' + str(cwd));
  if (str(sessionTitle)) blocks.push('■ セッション\n' + str(sessionTitle));
  const f = normFocus(focus);
  if (f) {
    const lines = ['■ 進行中の作業'];
    if (f.goal) lines.push('目標: ' + f.goal);
    for (const c of f.criteria) lines.push('- ' + (c.status ? '[' + c.status + '] ' : '') + c.text);
    blocks.push(lines.join('\n'));
  }
  const todoList = normTodos(todos);
  if (todoList.length) blocks.push(['■ Todo', ...todoList.map(t => '- ' + TODO_MARK[t.status] + ' ' + t.content)].join('\n'));
  const git = normGit(gitLines);
  if (git.length) {
    const lines = ['■ 変更中のファイル', ...git.slice(0, MAX_GIT_LINES)];
    if (git.length > MAX_GIT_LINES) lines.push('… ほか ' + (git.length - MAX_GIT_LINES) + ' 件');
    blocks.push(lines.join('\n'));
  }
  // A pointer to the full transcript, not the transcript itself: the new account's Muse
  // runs on this same PC and can read the file, so it pays only for the parts it actually
  // needs instead of burning its fresh allowance on the whole history up front. It sits in
  // blocks (not the transcript section), so the cap trimming below never drops it first.
  const record = str(recordPath);
  if (record) blocks.push('■ 前のセッションの記録\n' + record + '\n会話の全文が1ターン1行（JSONL）で残っています。必要なときだけ、要る箇所を検索・読み取りしてください（全部を読み込まないこと）。');

  // The transcript goes last and is what gets cut when the note would run over the cap:
  // drop its oldest turns one at a time (the newest exchange matters most), and only if
  // even that is not enough fall back to a hard cut of the whole note.
  const recent = normTurns(turns);
  for (let keep = recent.length; keep >= 0; keep--) {
    const parts = keep ? [...blocks, '■ 直近のやり取り\n' + recent.slice(recent.length - keep).map(renderTurn).join('\n\n')] : blocks;
    const note = parts.join('\n\n');
    if (note.length <= MAX_TOTAL) return note;
    if (!keep) return note.slice(0, MAX_TOTAL - 1) + '…';
  }
  return blocks.join('\n\n'); // unreachable: keep = 0 always returns above
}

module.exports = {buildHandoff};
