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

const MAX_TOTAL = 4000;      // the whole note is capped near this many code points
const MAX_TURNS = 6;         // transcript turns kept (the newest ones)
const MAX_TURN_CHARS = 300;  // per speaker text inside one transcript turn
const MAX_GIT_LINES = 30;    // `git status --porcelain` lines kept
// c21 #6: the caps above used to cover only the transcript and the git line COUNT.
// Focus criteria, Todos and single git lines had no count or length cap at all, so
// those blocks alone could exceed MAX_TOTAL and the final hard cut sliced the note
// mid-section — including the record pointer that must survive (see buildHandoff).
const MAX_CRITERIA = 20;     // focus criteria kept
const MAX_TODOS = 30;        // todo items kept
const MAX_ITEM_CHARS = 200;  // per focus criterion / todo item / git line
const MAX_GOAL_CHARS = 300;  // the focus goal line
const MAX_FIELD_CHARS = 500; // one-line fields: cwd, session title, labels, record path
const MAX_AGENTS = 10;       // finished, uncollected sub-agents summarised (wave11 (2))
const MAX_AGENT_HEAD = 200;  // per sub-agent result/error head kept

function str(v) { return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim(); }

// c21 #7: a one-line field must stay one line. str() only trims the ends, so a newline
// inside cwd / a title / a label / a focus or Todo text / the record path used to be
// embedded verbatim and could open a fake `■ …` section (even a fake record pointer)
// inside a note the new account's Muse reads as trusted first context. Collapse every
// run of line breaks (with surrounding space) to a single space.
// Budgets in this module count code points, not UTF-16 units (the same
// counting as src/tell.js): a unit count charges an astral character twice,
// so a 300-emoji turn used to be cut to 150 emoji against its 300 budget.
const cpLength = s => [...s].length;

// t7 #19: a cut at a fixed UTF-16 length can land between a surrogate pair and
// leave a lone high surrogate in the note. Cut one unit earlier instead.
// wave17: n is a code-point budget and the cut is grapheme-aware. Slicing by
// code points never splits a surrogate pair, and when Intl.Segmenter is
// available the cut backs off to a grapheme-cluster boundary, so it cannot
// sever a ZWJ sequence (leaving a dangling U+200D), a skin-tone modifier, a
// flag pair, or a base letter from its combining marks. Without a segmenter,
// keep the surrogate-safe code-point slice and additionally back off a
// trailing ZWJ, trailing combining marks (Unicode category M), and a final
// code point whose ZWJ / combining continuation was cut away.
function safeCut(s, n) {
  const cps = [...s];
  if (cps.length <= n) return s;
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
  if (segmenter) {
    let out = '', used = 0;
    for (const {segment} of segmenter.segment(s)) {
      const len = cpLength(segment);
      if (used + len > n) break;
      out += segment; used += len;
    }
    return out;
  }
  const out = cps.slice(0, n);
  while (out.length) {
    const last = out[out.length - 1], next = cps[out.length];
    if (last === '\u200d' || /\p{M}/u.test(last)) { out.pop(); continue; }
    if (next === '\u200d' || (next !== undefined && /\p{M}/u.test(next))) { out.pop(); continue; }
    break;
  }
  return out.join('');
}

function oneLine(v, n = MAX_FIELD_CHARS) {
  const s = str(v).replace(/\s*[\r\n]+\s*/g, ' ');
  return cpLength(s) > n ? safeCut(s, n) + '…' : s;
}

// Transcript prose keeps its line breaks (it is quoted conversation), but a line that
// starts with ■ inside it would be indistinguishable from a real section heading, so
// indent such lines: the text stays readable, the section structure stays ours.
function defangSections(s) { return s.replace(/^■/gm, ' ■'); }

// One speaker's text, cut to the per-turn budget with an ellipsis when it was longer.
function clip(text, n = MAX_TURN_CHARS) {
  const s = defangSections(str(text));
  return cpLength(s) > n ? safeCut(s, n) + '…' : s;
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
    if (typeof t === 'string') { if (t.trim()) out.push({content: oneLine(t, MAX_ITEM_CHARS), status: 'pending'}); continue; }
    if (!t || typeof t !== 'object') continue;
    const content = oneLine(t.content ?? t.text, MAX_ITEM_CHARS);
    if (content) out.push({content, status: todoStatus(t.status)});
  }
  // Unfinished work first (in progress before not started), finished last; the order
  // inside each group is the caller's order, so the note stays deterministic.
  const rank = {in_progress: 0, pending: 1, completed: 2};
  // The count cap applies AFTER sorting, so the items dropped are the finished ones.
  return out.map((t, i) => [t, i]).sort((a, b) => rank[a[0].status] - rank[b[0].status] || a[1] - b[1]).map(([t]) => t).slice(0, MAX_TODOS);
}

function normFocus(focus) {
  if (!focus || typeof focus !== 'object') return null;
  const goal = oneLine(focus.goal, MAX_GOAL_CHARS);
  const criteria = (Array.isArray(focus.criteria) ? focus.criteria : []).map(c => {
    if (typeof c === 'string') return c.trim() ? {text: oneLine(c, MAX_ITEM_CHARS), status: ''} : null;
    if (!c || typeof c !== 'object') return null;
    const text = oneLine(c.text ?? c.content, MAX_ITEM_CHARS);
    return text ? {text, status: oneLine(c.status, 40)} : null;
  }).filter(Boolean).slice(0, MAX_CRITERIA);
  return goal || criteria.length ? {goal, criteria} : null;
}

function normGit(gitLines) {
  if (!Array.isArray(gitLines)) return [];
  // Porcelain lines start with status columns, so the front is never trimmed (oneLine
  // would eat it via str()); only trailing space goes. Then the one-line/length caps:
  // a file name can itself contain a newline, which must not become a fake section.
  return gitLines.map(l => {
    const s = String(l ?? '').replace(/\s+$/, '').replace(/\s*[\r\n]+\s*/g, ' ');
    return cpLength(s) > MAX_ITEM_CHARS ? safeCut(s, MAX_ITEM_CHARS) + '…' : s;
  }).filter(l => l.trim());
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

// Wave11 (2): sub-agents that finished on the old account but whose result was never
// collected (agent.wait) are dropped by the switch itself. Their outcome must not
// vanish silently: keep id, state and the head of the result (or error) as one line
// each. Tolerates snapshots ({tag, state, result, error, title}) and plain strings.
function normAgents(agents) {
  if (!Array.isArray(agents)) return [];
  const out = [];
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue;
    const tag = oneLine(a.tag ?? a.id, 60);
    if (!tag) continue;
    const state = oneLine(a.state, 40) || 'done';
    const title = oneLine(a.title, MAX_ITEM_CHARS);
    const head = oneLine(a.result || a.error || a.text, MAX_AGENT_HEAD);
    out.push({tag, state, title, head});
    if (out.length >= MAX_AGENTS) break;
  }
  return out;
}

function buildHandoff(input) {
  const {fromLabel, toLabel, cwd, sessionTitle, turns, todos, focus, gitLines, recordPath, agents} = input || {};
  const from = oneLine(fromLabel, 100), to = oneLine(toLabel, 100);
  const head = from && to
    ? 'これは前のアカウント（' + from + '）から新しいアカウント（' + to + '）への引き継ぎメモです。ここまでの作業を、このアカウントで続けてください。'
    : from
      ? 'これは前のアカウント（' + from + '）からの引き継ぎメモです。ここまでの作業を、このアカウントで続けてください。'
      : 'これは前のアカウントからの引き継ぎメモです。ここまでの作業を、このアカウントで続けてください。';

  // Every section except the transcript, in a fixed order; empty sections are omitted.
  const blocks = [head];
  if (oneLine(cwd)) blocks.push('■ 作業フォルダー\n' + oneLine(cwd));
  if (oneLine(sessionTitle)) blocks.push('■ セッション\n' + oneLine(sessionTitle));
  const f = normFocus(focus);
  if (f) {
    const lines = ['■ 進行中の作業'];
    if (f.goal) lines.push('目標: ' + f.goal);
    for (const c of f.criteria) lines.push('- ' + (c.status ? '[' + c.status + '] ' : '') + c.text);
    blocks.push(lines.join('\n'));
  }
  const todoList = normTodos(todos);
  if (todoList.length) {
    const lines = ['■ Todo', ...todoList.map(t => '- ' + TODO_MARK[t.status] + ' ' + t.content)];
    const given = Array.isArray(todos) ? todos.filter(t => (typeof t === 'string' && !!t.trim()) || (t && typeof t === 'object' && !!oneLine(t.content ?? t.text, MAX_ITEM_CHARS))).length : 0;
    if (given > todoList.length) lines.push('… ほか ' + (given - todoList.length) + ' 件');
    blocks.push(lines.join('\n'));
  }
  const git = normGit(gitLines);
  if (git.length) {
    const lines = ['■ 変更中のファイル', ...git.slice(0, MAX_GIT_LINES)];
    if (git.length > MAX_GIT_LINES) lines.push('… ほか ' + (git.length - MAX_GIT_LINES) + ' 件');
    blocks.push(lines.join('\n'));
  }
  const agentList = normAgents(agents);
  if (agentList.length) {
    const lines = ['■ 終わったサブエージェント（未回収）', ...agentList.map(a => '- ' + a.tag + ' [' + a.state + ']' + (a.title ? ' ' + a.title : '') + (a.head ? ': ' + a.head : ''))];
    const given = Array.isArray(agents) ? agents.filter(a => a && typeof a === 'object' && oneLine(a.tag ?? a.id, 60)).length : 0;
    if (given > agentList.length) lines.push('… ほか ' + (given - agentList.length) + ' 件');
    blocks.push(lines.join('\n'));
  }
  // A pointer to the full transcript, not the transcript itself: the new account's Muse
  // runs on this same PC and can read the file, so it pays only for the parts it actually
  // needs instead of burning its fresh allowance on the whole history up front. It sits in
  // blocks (not the transcript section), so the cap trimming below never drops it first.
  // c21 #6: the pointer is kept OUT of the droppable blocks below — when the other
  // blocks alone exceed the cap, they are dropped (lowest sections first) and the
  // pointer is appended intact; the old hard cut could slice it away entirely.
  const record = oneLine(recordPath, 1000);
  const recordBlock = record ? '■ 前のセッションの記録\n' + record + '\n会話の全文が1ターン1行（JSONL）で残っています。必要なときだけ、要る箇所を検索・読み取りしてください（全部を読み込まないこと）。' : null;

  // The transcript goes last and is what gets cut when the note would run over the cap:
  // drop its oldest turns one at a time (the newest exchange matters most). If the
  // other blocks alone still exceed the cap, drop whole sections from the end (git,
  // then Todo, then focus, …) instead of hard-cutting mid-section; only as a last
  // resort hard-cut what precedes the record pointer, which stays intact.
  const recent = normTurns(turns);
  const assemble = (keptBlocks, keep) => {
    const parts = [...keptBlocks];
    if (recordBlock) parts.push(recordBlock);
    if (keep) parts.push('■ 直近のやり取り\n' + recent.slice(recent.length - keep).map(renderTurn).join('\n\n'));
    return parts.join('\n\n');
  };
  for (let keep = recent.length; keep >= 0; keep--) {
    const note = assemble(blocks, keep);
    if (cpLength(note) <= MAX_TOTAL) return note;
    if (!keep) {
      const kept = [...blocks];
      while (kept.length > 1 && cpLength(assemble(kept, 0)) > MAX_TOTAL) kept.pop();
      const trimmed = assemble(kept, 0);
      if (cpLength(trimmed) <= MAX_TOTAL) return trimmed;
      if (recordBlock) {
        const room = MAX_TOTAL - cpLength(recordBlock) - 2;
        return (room > 0 ? safeCut(kept.join('\n\n'), Math.max(0, room - 1)) + '…' : '') + '\n\n' + safeCut(recordBlock, MAX_TOTAL);
      }
      return safeCut(trimmed, MAX_TOTAL - 1) + '…';
    }
  }
  return blocks.join('\n\n'); // unreachable: keep = 0 always returns above
}

module.exports = {buildHandoff};
