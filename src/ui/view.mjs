// The Ink view. Finished entries go through <Static> (written once into scrollback, never
// redrawn); the live part below is diffed line by line (incrementalRendering), so streaming,
// spinners and typing do not flicker. The caret is placed with useCursor so IME composes in place.
import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {render, Box, Text, Static, useInput, usePaste, useCursor, useWindowSize} from 'ink';
import chalk from 'chalk';
import {createRequire} from 'node:module';
import path from 'node:path';
import {Controller, COMMANDS} from './controller.mjs';
import {createMd} from './md.mjs';
import {sanitizeEmbeds} from './sanitize.mjs';
const require = createRequire(import.meta.url);
const {c, width, truncate, pad, wrap: wrapText} = require('../tui/term.js');
const {logo} = require('../tui/logo.js');
const {LABELS} = require('../policy.js');
const {fragmentAt: mentionAt, complete: mentionComplete, listDiag: mentionDiag, loading: mentionLoading, COMPLETE_LIMIT} = require('../mentions.js');
const {t} = require('../i18n.js');
// Grapheme clusters for the composer's caret math (audit recovery): layout()
// used to measure per code point, so a ZWJ emoji counted 6 cells instead of 2
// and the caret landed columns away from where the text was drawn.
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
const graphemesOf = s => graphemeSegmenter ? [...graphemeSegmenter.segment(s)].map(g => g.segment) : [...s];

const h = React.createElement;
// NO_COLOR (no-color.org): Ink colours everything through this chalk, which does not look at it.
if (!require('../settings.js').switchValue('color')) chalk.level = 0;
// Spinners stand still with "motion" off in /settings (or MUSER_REDUCED_MOTION=1).
const {switchValue} = require('../settings.js');
const ACCENT = '#b4a0ff', DIM = '#5f5f69', GRAY = '#8c8c96';
const SPIN = ['✻', '✽', '✶', '✳', '✢', '·', '✢', '✳', '✶', '✽'];
const TITLES = {'shell.output': 'Output', 'shell.kill': 'Kill', 'shell.list': 'Shells', 'code.read': 'Read', 'code.grep': 'Search', 'code.glob': 'Glob', 'code.edit': 'Update', 'code.write': 'Write', 'code.apply_patch': 'Patch', 'todo.write': 'Todo', 'skill.read': 'Skill'};
const title = call => call.user ? '! ' + (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.kind === 'agent' ? (call.command === 'agent.spawn' ? 'Agent' : 'Wait') : call.kind === 'mcp' ? 'MCP' : call.command === 'system.run' ? (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.command === 'code.write' && call.view?.created ? 'Create' : TITLES[call.command] || call.command;
// The marker in front of a tool row. It used to be ⏺ for everything, so what KIND of
// thing happened was carried only by the title text. Reads (and anything unlisted) keep
// ⏺; the rest get a glyph of their own. Colour still says ok (green) or failed (red).
export const glyphFor = call => {
  if (call.user) return '▶'; // a !command the user ran
  if (call.kind === 'agent') return '◆';
  if (call.kind === 'mcp') return '⚙';
  switch (call.command) {
    case 'system.run': return '▶';
    case 'shell.kill': return '■';
    case 'code.edit': case 'code.write': case 'code.apply_patch': return '✎';
    case 'code.grep': return '≡';
    case 'code.glob': return '☰';
    default: return call.command?.startsWith('shell.') ? '▶' : '⏺';
  }
};
const elapsed = ms => { const n = Number(ms); const s = Math.floor((Number.isFinite(n) && n > 0 ? n : 0) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
// A record read back from disk (resume, a remote snapshot from another version) can be
// missing fields the producers always set today; renderers take what is there instead of
// throwing, because a throw in render takes the whole screen down (deep c5 #1).
const safeDiff = d => Array.isArray(d) ? d : [];
// Keep the END of a string that is too wide (a file name, a changed diff tail, the text
// being typed): the identifying part of a path or line is usually at its end.
const tailText = (str, max) => {
  const s = String(str ?? '');
  if (width(s) <= max) return s;
  if (max <= 1) return '…';
  let w = 0, out = '';
  const gs = graphemesOf(s);
  for (let i = gs.length - 1; i >= 0; i--) { const gw = width(gs[i]); if (w + gw > max - 1) break; out = gs[i] + out; w += gw; }
  return '…' + out;
};
// A path inside the working folder is shown relative; one outside it is shown as the
// absolute path it is, not as a chain of ..\..\.. that has to be counted (deep r1 R1-6).
const relPath = (cwd, p) => {
  if (typeof p !== 'string') return String(p ?? '');
  const r = path.relative(cwd, p);
  return r.startsWith('..') ? p : r || p;
};
const T = (props, ...kids) => h(Text, props, ...kids);
const Line = ({children, ...p}) => h(Text, {wrap: 'truncate-end', ...p}, children);

// ---------- pieces ----------
function Row({prefix, text, code}) {
  // Opt-in ("wrap long code lines" in /settings, or MUSER_CODE_WRAP=1): long code/table rows wrap
  // instead of being cut.
  const wrap = code && !switchValue('codeWrap') ? 'truncate-end' : 'wrap';
  // The prefix (list marker, fence header) never shrinks: at narrow widths it was squeezed
  // into the text and the marker vanished (deep r1 R1-4, view side).
  return h(Box, null, h(Box, {flexShrink: 0}, h(Text, null, prefix)), h(Box, {flexShrink: 1}, h(Text, {wrap}, text || ' ')));
}
function Md({rows, first}) {
  return h(Box, {flexDirection: 'column'}, rows.map((r, i) => h(Row, {key: i, prefix: (first && i === 0 ? '⏺ ' : '  ') + r.prefix, text: r.text, code: r.code})));
}
function todoLine(t) {
  const content = String(t?.content ?? '');
  if (t.status === 'completed') return c.faint('☒ ' + c.strike(content));
  if (t.status === 'in_progress') return c.accent('◼ ') + c.bold(content);
  return c.gray('☐ ') + content;
}
// A todo as a hanging-indent row (the /todos entry): the marker keeps its own column, so a
// wrapped item continues under its text, not at the left edge (first B18, deep r3 R20).
function TodoRow({td}) {
  const content = String(td?.content ?? '');
  const mark = td.status === 'completed' ? c.faint('☒ ') : td.status === 'in_progress' ? c.accent('◼ ') : c.gray('☐ ');
  const text = td.status === 'completed' ? c.faint(c.strike(content)) : td.status === 'in_progress' ? c.bold(content) : content;
  return h(Box, null, h(Text, null, '  '), h(Box, {flexShrink: 0}, h(Text, null, mark)), h(Box, {flexShrink: 1}, h(Text, {wrap: 'wrap'}, text || ' ')));
}
function Diff({diff, W, max = 30}) {
  diff = safeDiff(diff);
  // Only the rows shown count: Math.max(...all rows) threw a RangeError past ~150,000 rows (a new
  // 200,000-line file), and a throw in render takes the whole screen down.
  const numW = Math.max(3, String(diff.slice(0, max).reduce((m, d) => Math.max(m, d.n || 0), 0)).length), bodyW = W - numW - 12;
  const lines = diff.slice(0, max).map((d, i) => {
    if (d.t === '…') return h(Line, {key: i, color: DIM}, '      ' + ' '.repeat(numW) + ' ⋮');
    // A changed line is cut at its END, where the change usually is: cutting the head made an
    // old and a new line that differ only at the end look identical (deep r1 R1-2).
    const raw = String(d.l ?? ''), cut = (d.t === '+' || d.t === '-') && width(raw) > bodyW ? tailText(raw, bodyW) : truncate(raw, bodyW);
    const num = String(d.n || '').padStart(numW), body = pad(cut, bodyW);
    if (d.t === '+') return h(Box, {key: i}, h(Text, null, '      '), h(Line, {backgroundColor: '#193c23', color: '#aaebaa'}, num + ' + ' + body));
    if (d.t === '-') return h(Box, {key: i}, h(Text, null, '      '), h(Line, {backgroundColor: '#461c20', color: '#f5aaaa'}, num + ' - ' + body));
    return h(Line, {key: i}, '      ' + c.faint(num) + '   ' + c.gray(truncate(raw, bodyW)));
  });
  if (diff.length > max) lines.push(h(Line, {key: 'more', color: DIM}, '      ' + t('… ほか {n} 行', {n: diff.length - max})));
  return h(Box, {flexDirection: 'column'}, lines);
}
function Tool({call, cwd, W}) {
  const v = call.view || {}, rel = p => relPath(cwd, p);
  const res = (kid, k = 'r') => h(Box, {key: k}, h(Text, {color: DIM}, '  ⎿  '), h(Box, {flexShrink: 1}, kid));
  if (call.command === 'todo.write' && call.ok) return h(Box, {flexDirection: 'column', marginBottom: 1},
    h(Text, null, c.green('⏺ ') + c.bold('Todo')), ...(v.todos || []).map((t, i) => h(Box, {key: i}, h(Text, {color: DIM}, i ? '     ' : '  ⎿  '), h(Text, {wrap: 'wrap'}, todoLine(t)))));
  // The marker's colour says how it went: a command that ran but exited non-zero is not green, and
  // a step the user declined is their choice (yellow), not a failure (red).
  const mark = call.declined ? c.yellow : !call.ok || (call.command === 'system.run' && v.exit) ? c.red : c.green;
  // The summary is usually a path: cut it at the START so the file name (its end) survives
  // at ordinary widths (deep r1 R1-5).
  const sumText = String(call.summary || ''), sumShown = tailText(sumText, Math.max(8, W - width(title(call)) - 5));
  const kids = [h(Line, {key: 'h'}, mark(glyphFor(call) + ' ') + c.bold(title(call)) + c.gray('(' + sumShown + ')'))];
  if (!call.ok) {
    const errText = String(call.error || '');
    // A decline carries the user's reason inside the error text (agent.js); the record used
    // to keep only the fact a reason existed, never the reason itself (deep r1 R1-18).
    const reason = errText.match(/declined this: ([\s\S]*?)(?:\. Do not retry|$)/)?.[1];
    kids.push(res(h(Text, {color: call.declined ? '#e6be64' : '#f06e6e', wrap: 'wrap'}, call.declined ? t('断りました') + (reason ? t('（理由: {reason}）', {reason: truncate(reason, 60)}) : errText.includes('declined this:') ? t('（理由を Muse に伝えました）') : '') : t('エラー: {error}', {error: errText}))));
  }
  else if (v.background && call.command === 'system.run') kids.push(res(h(Box, {flexDirection: 'column'}, h(Text, null, c.accent('⚙ ') + c.gray(t('バックグラウンドで実行中') + ' ') + c.bold(v.background) + c.faint('   ' + t('/bg で確認'))), ...(v.tail || []).filter(l => l.trim()).map((l, i) => h(Line, {key: i, color: DIM}, l)))));
  else if (call.command === 'shell.output') kids.push(res(h(Text, {color: GRAY}, v.background + ': ' + t('{n} 行', {n: v.lines}) + (v.running ? t('（実行中）') : t('（終了）')))));
  else if (call.command === 'shell.kill') kids.push(res(h(Text, {color: GRAY}, t('{id} を停止', {id: v.background}))));
  else if (call.command === 'shell.list') kids.push(res(h(Text, {color: GRAY}, t('{n} 個', {n: v.count}))));
  else if (call.kind === 'agent') kids.push(res(h(Text, {color: GRAY}, v.tag ? t('エージェント {tag}{type} を起動', {tag: v.tag, type: v.type ? '（' + v.type + '）' : ''}) : (v.agents || []).join(' · '))));
  else if (call.kind === 'mcp') { const lines = String(v.text || '').trim().split('\n').filter(l => l.trim()); kids.push(res(h(Box, {flexDirection: 'column'}, ...(lines.length ? lines.slice(0, 4) : [t('(結果なし)')]).map((l, i) => h(Line, {key: i, color: GRAY}, l)), ...(lines.length > 4 ? [h(Line, {key: 'm', color: DIM}, t('… ほか {n} 行', {n: lines.length - 4}))] : [])))); }
  else if (call.command === 'code.read') kids.push(res(h(Text, {color: GRAY}, t('{n} 行を読み込み', {n: v.lines}))));
  else if (call.command === 'code.grep' || call.command === 'code.glob') kids.push(res(h(Text, {color: GRAY}, call.command === 'code.grep' ? t('{n} 件ヒット', {n: v.count}) : t('{n} ファイル', {n: v.count}))));
  else if (v.files) v.files.forEach((f, i) => { kids.push(res(h(Text, null, c.bold(rel(f.path)) + '  ' + c.green('+' + (f.added || 0)) + ' ' + c.red('-' + (f.removed || 0))), 'f' + i)); kids.push(h(Diff, {key: 'd' + i, diff: safeDiff(f.diff), W, max: 24})); });
  else if (v.diff) { const vd = safeDiff(v.diff); let added = 0, removed = 0; for (const d of vd) { if (d.t === '+') added++; else if (d.t === '-') removed++; } kids.push(res(h(Text, null, c.green('+' + added) + ' ' + c.red('-' + removed)))); kids.push(h(Diff, {key: 'd', diff: vd, W})); }
  else if (call.command === 'system.run') {
    const tail = (v.tail || []).filter(l => l.trim());
    kids.push(res(h(Box, {flexDirection: 'column'}, ...(tail.length ? tail : [t('(出力なし)')]).map((l, i) => h(Line, {key: i, color: GRAY}, l)),
      ...(call.outputLines > tail.length ? [h(Text, {key: 'more', color: DIM}, t('… ほか {n} 行（/output で全文）', {n: call.outputLines - tail.length}))] : []),
      ...(v.exit ?[h(Text, {key: 'x', color: '#f06e6e'}, v.killed === 'timeout' ? t('タイムアウト') : v.killed === 'cancelled' ? t('中断しました') : 'exit ' + v.exit)] : []))));
  }
  return h(Box, {flexDirection: 'column', marginBottom: 1}, kids);
}
// One unit that never shrinks: the row wraps whole keycaps when the labels (English) run long.
function Keycap({k, label}) { return h(Box, {flexShrink: 0}, h(Text, null, h(Text, {backgroundColor: '#2d2d34', color: ACCENT}, ' ' + k + ' '), h(Text, {color: GRAY}, ' ' + label + '   '))); }
// Whether a banner opened a resumed chat is fixed when it is first drawn: a resize redraws the
// history (Root), and a banner reading the live turn count then called a fresh chat "resumed".
const bannerResumed = new WeakMap();
function Banner({e, ctrl, W}) {
  const a = ctrl.agent, mark = logo(), narrow = W && W < 50;
  if (e && !bannerResumed.has(e)) bannerResumed.set(e, a.session.turns ? {title: a.session.title || a.session.id, turns: a.session.turns} : null);
  const resumed = e ? bannerResumed.get(e) : (a.session.turns ? {title: a.session.title || a.session.id, turns: a.session.turns} : null);
  return h(Box, {flexDirection: 'column', marginTop: 1, marginBottom: 1},
    // The wordmark never shrinks: on a narrow terminal it was squeezed and its two rows split apart.
    h(Box, null, h(Box, {flexDirection: 'column', flexShrink: 0, marginLeft: 2, marginRight: 3}, h(Text, null, mark[0]), h(Text, null, mark[1])),
      h(Box, {flexDirection: 'column', flexShrink: 1},
        // At narrow widths the version gets its own line and the folder is cut at its start,
        // so both survive instead of being truncated away (first B13).
        h(Line, null, c.bold(ctrl.museName) + c.gray(t(' と作業します')) + (narrow ? '' : c.faint('   v' + ctrl.version))),
        narrow ? h(Line, null, c.faint('v' + ctrl.version)) : null,
        narrow ? null : h(Line, {color: GRAY}, a.cwd))),
    // Narrow: the folder gets a full-width line of its own under the wordmark, cut at its
    // start — beside the wordmark its column was a dozen cells and only the drive survived.
    narrow ? h(Box, {marginLeft: 2}, h(Line, {color: GRAY}, tailText(a.cwd, Math.max(10, W - 6)))) : null,
    resumed ? h(Box, {marginLeft: 2, marginTop: 1}, h(Line, null, c.accent('↺ ') + c.gray(t('再開: ')) + resumed.title + c.faint('   ' + t('{n} ターン', {n: resumed.turns})))) : null,
    h(Box, {marginLeft: 2, marginTop: 1, flexWrap: 'wrap'}, h(Keycap, {k: '/', label: t('コマンド')}), h(Keycap, {k: '⇧⇥', label: t('承認モード')}), h(Keycap, {k: 'esc', label: t('中断')}), h(Keycap, {k: '\\⏎', label: t('改行')}), h(Keycap, {k: 'alt+v', label: t('画像')}), h(Keycap, {k: '@', label: t('ファイル')}), h(Keycap, {k: '!', label: t('シェル')}), h(Keycap, {k: '^C^C', label: t('終了')})));
}
function Entry({e, ctrl, W}) {
  const a = ctrl.agent;
  switch (e.type) {
    case 'banner': return h(Banner, {e, ctrl, W});
    case 'user': {
      // The empty-text label names what was actually sent (deep r1 R1-9): files are not
      // "image only", and a send with nothing at all is not either.
      const emptyLabel = e.images?.length && !e.files?.length ? t('（画像のみ）') : e.files?.length && !e.images?.length ? t('（ファイルのみ）') : e.files?.length || e.images?.length ? t('（添付のみ）') : t('（本文なし）');
      // One attachment per line: joined on one line, the later ones were truncated away at
      // narrow widths and the send looked smaller than it was (first B20).
      return h(Box, {marginTop: 1, marginBottom: 1, backgroundColor: '#2d2d34', paddingX: 1, width: W, flexDirection: 'column'},
        h(Box, null, h(Text, {color: ACCENT}, '❯ '), h(Box, {flexShrink: 1}, h(Text, {wrap: 'wrap'}, e.text ? e.text.replace(/(^|\s)(@\S+)/g, (m, a, b) => a + c.accent(b)) : c.faint(emptyLabel)))),
        ...(e.files || []).map((f, i) => h(Line, {key: 'f' + i}, '  ' + c.accent('◇ ') + c.gray(f.ref + (f.kind === 'dir' ? '/ ' + t('{n} ファイル', {n: f.count}) : f.kind === 'file' ? ' ' + t('{n} 行', {n: f.lines}) : f.kind === 'large' ? t(' 大きいため名前のみ') : t(' (バイナリ)'))))),
        ...(e.missing?.length ? [h(Line, {key: 'miss'}, '  ' + c.yellow(t('見つからない: {list}', {list: e.missing.join(', ')})))] : []),
        ...(e.images || []).map((n, i) => h(Line, {key: 'img' + i}, '  ' + c.accent('▣ ') + c.gray(t('画像 {i} {name}', {i: i + 1, name: n})))));
    }
    case 'md': return h(Md, {rows: e.rows, first: e.first});
    case 'progress': return h(Box, {marginBottom: 1, width: W},
      h(Text, {color: ACCENT}, '⏺ '),
      h(Box, {flexShrink: 1, flexDirection: 'column'}, h(Text, {wrap: 'wrap'}, sanitizeEmbeds(e.message)),
        e.agent && e.agent !== 'main' ? h(Text, {color: DIM}, t('エージェント {tag}', {tag: e.agent})) : null));
    case 'focus': {
      // Compact by default: one dim line, so a turn ends with the reply text as its last
      // substantial block. The full panel (goal, every criterion, reasons, evidence) is what
      // /focus asks for explicitly (full: true).
      if (!e.full) {
        const cs = e.focus.criteria || [], met = cs.filter(x => x.status === 'met').length, open = cs.filter(x => x.status !== 'met').map(x => x.id);
        const warn = ['needs_input', 'blocked', 'stalled', 'limit'].includes(e.focus.status);
        return h(Box, {width: W}, h(Text, {color: warn ? '#e6be64' : DIM, wrap: 'wrap'},
          t('Focus: {status}', {status: focusLabel(e.focus.status)}) + ' · ✓ ' + met + '/' + cs.length + (e.focus.maxRounds > 1 ? ' · ' + e.focus.round + '/' + e.focus.maxRounds : '') + (open.length ? t(' · 未完: {ids}', {ids: open.join(', ')}) : '')));
      }
      const criteria = e.focus.criteria || [];
      // Wrapped lines keep a hanging indent (first B18): the goal and each criterion carry
      // their prefix in its own non-shrinking column, so a continuation starts under the text.
      return h(Box, {flexDirection: 'column', marginY: 1, width: W},
        h(Text, {color: ACCENT}, t('Focus: {status} · {round}/{max}', {status: focusLabel(e.focus.status), round: e.focus.round, max: e.focus.maxRounds})),
        h(Box, null, h(Box, {flexShrink: 0}, h(Text, {wrap: 'wrap'}, t('目標: {goal}', {goal: ''}))), h(Box, {flexShrink: 1}, h(Text, {wrap: 'wrap'}, String(e.focus.goal ?? '')))),
        ...(criteria.length ? criteria.map(check => h(Box, {key: check.id}, h(Box, {flexShrink: 0}, h(Text, {color: check.status === 'met' ? '#78cd82' : GRAY}, (check.status === 'met' ? '✓ ' : '□ ') + check.id + ' ')), h(Box, {flexShrink: 1}, h(Text, {wrap: 'wrap', color: check.status === 'met' ? '#78cd82' : GRAY}, String(check.text ?? '') + (check.reason ? ' — ' + check.reason : '') + ((check.evidence || []).length ? ' [' + check.evidence.join(', ') + ']' : '')))))
          : [h(Text, {key: 'none', color: DIM}, t('条件: なし'))]),
        e.focus.reason ? h(Box, {marginLeft: 2}, h(Text, {color: DIM, wrap: 'wrap'}, e.focus.reason)) : null);
    }
    case 'gap': return h(Text, null, ' ');
    case 'shellout': { const slines = e.lines || []; return h(Box, {flexDirection: 'column', marginBottom: 1},
      h(Line, null, c.accent('⚙ ') + c.bold(e.id) + c.gray(e.running ? t('  実行中') : t('  終了 exit {exit}', {exit: e.exit}))),
      ...(e.cut ? [h(Line, {key: 'cut', color: DIM}, '  │ ' + t('⋮ 前の出力は省略（/output で全文）'))] : []),
      // Still running with nothing yet is not "no output": it says it is waiting (deep r1 R1-17).
      ...(slines.filter(l => l.length).length ? slines : [e.running ? t('（まだ出力がありません）') : t('(出力なし)')]).map((l, i) => h(Line, {key: i, color: GRAY}, '  │ ' + l))); }
    case 'agent': {
      const x = e.snap || {}, ok = x.state === 'done', mark = ok ? c.green('✓') : x.state === 'stopped' ? c.yellow('■') : c.red('✗');
      // An empty result says so, like an empty MCP result does (deep r1 R1-12).
      const bodyText = String(ok ? x.result ?? '' : x.error || t('停止しました')).trim();
      const body = (bodyText ? sanitizeEmbeds(bodyText) : t('(結果なし)')).split('\n'), md = createMd(), max = e.full ? 200 : 12;
      return h(Box, {flexDirection: 'column', marginBottom: 1, borderStyle: 'round', borderColor: ok ? '#3c5a46' : '#5a3c3c', paddingX: 1, width: W},
        // The elapsed time sits before the (cuttable) title, so a narrow screen keeps it (first B19).
        h(Line, null, mark + ' ' + c.accent(c.bold(t('エージェント {tag}', {tag: x.tag}))) + c.faint(' ' + (x.type || '')) + c.faint('   ' + elapsed((x.ended || Date.now()) - (x.started || 0))) + c.gray('  ' + (x.title || ''))),

        ...md.rows(body.slice(0, max)).map((r, i) => h(Row, {key: i, prefix: r.prefix, text: r.text, code: r.code})),
        ...(body.length > max ? [h(Line, {key: 'more', color: DIM}, t('… ほか {n} 行（/agents で全文）', {n: body.length - max}))] : []));
    }
    case 'tool': return h(Tool, {call: e.call, cwd: a.cwd, W});
    case 'past': { // tools and Muse steps of a turn shown again on resume, compact
      const lines = [
        ...(e.steps || []).map(s => (s.failed ? c.red('⏺ ') : c.faint('⏺ ')) + c.gray(s.title) + c.faint('  (Muse)')),
        // The error cut follows the screen width and says it cut (deep r1 R1-7): a fixed
        // 60 chars with no ellipsis hid the reason even on a 200-wide terminal.
        ...(e.tools || []).map(t => (t.ok ? c.faint(glyphFor(t) + ' ') : c.red(glyphFor(t) + ' ')) + c.gray(String(t.command).replace(/^code\./, '') + (t.summary ? ' ' + t.summary : '')) + (t.ok ? '' : c.red('  ' + truncate(String(t.error || ''), Math.max(60, W - 20))))),
      ];
      return h(Box, {flexDirection: 'column', marginBottom: 1}, ...lines.slice(0, 6).map((l, i) => h(Line, {key: i}, l)),
        ...(lines.length > 6 ? [h(Line, {key: 'more', color: DIM}, t('  … ほか {n} 件', {n: lines.length - 6}))] : []));
    }
    case 'muse': return h(Box, {flexDirection: 'column', marginBottom: 1},
      h(Line, null, (e.step.failed ? c.red('⏺ ') : c.accent('⏺ ')) + c.bold(e.step.title) + c.faint(e.step.unfinished ? t('  (Muse · 実行中のまま)') : '  (Muse)')),
      e.step.detail ? h(Box, null, h(Text, {color: DIM}, '  ⎿  '), h(Box, {flexShrink: 1}, h(Text, {color: e.step.failed ? '#f06e6e' : GRAY, wrap: 'wrap'}, e.step.detail))) : null);
    case 'sources': return h(Box, {flexDirection: 'column', marginBottom: 1}, h(Text, {color: DIM}, t('  出典')),
      ...(e.items || []).slice(0, 6).map((s, i) => { const label = String(s.label || s.domain || ''), uri = String(s.uri || ''); const labelShown = truncate(label, Math.min(width(label), Math.max(6, W - 32))); const uriShown = tailText(uri, Math.max(10, W - 7 - width(labelShown))); return h(Line, {key: i, color: GRAY}, '  ' + (i + 1) + '. ' + labelShown + c.faint('  ' + uriShown)); }),
      ...((e.items || []).length > 6 ? [h(Line, {key: 'more', color: DIM}, t('  … ほか {n} 件', {n: e.items.length - 6}))] : []));
    case 'end': { const u = e.usage; const usage = u && (u.inputTokens || u.outputTokens || !(Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens))) ? require('../turn-usage').usageText(u) : null; return h(Box, null, e.ok ? h(Text, {color: DIM}, '  ✻ ' + elapsed(e.ms) + (usage ? ' · ' + usage : '')) : h(Text, {color: e.aborted ? '#e6be64' : '#f06e6e', wrap: 'wrap'}, '  ⎿  ' + (e.aborted ? t('中断しました') : String(e.error || '')))); }
    // A note wraps with a hanging indent (first B18), and an error note carries a mark as
    // well as its colour, so it stays an error with NO_COLOR (deep r4 R4-8).
    case 'note': return h(Box, {flexDirection: 'column', marginBottom: 1}, (e.lines || []).map((l, i) => h(Box, {key: i}, h(Box, {flexShrink: 0}, h(Text, {color: e.level === 'error' ? '#f06e6e' : GRAY}, e.level === 'error' ? '✗ ' : '  ')), h(Box, {flexShrink: 1}, h(Text, {color: e.level === 'error' ? '#f06e6e' : GRAY, wrap: 'wrap'}, String(l))))));
    case 'help': {
      // Descriptions wrap under themselves instead of being cut with …: /help is where they are read
      // in full. The keys are one per cell of a grid; as one run-on paragraph they wrapped to the
      // left edge and were hard to scan.
      const keys = [t('  enter 送信 · {bs}+enter / ctrl+j 改行 · ↑↓ 履歴（@ 補完中は候補の移動） · esc 中断 · esc ×2 入力を消す · shift+tab 承認モード · tab コマンド補完 · ctrl+c ×2 終了 · ctrl+d ×2 終了', {bs: '\\'}),
        t('  ctrl+a / ctrl+e 行頭・行末 · ctrl+u / ctrl+k カーソルの前・後ろを消す · ctrl+w 単語を消す · ctrl+o 直近の出力を全文 · alt+v / ctrl+v 画像を貼る · 空の入力で backspace 添付を外す · @ ファイル · ! シェル · $ スキル')]
        .flatMap(s => s.trim().split(' · '));
      const cellW = Math.min(W - 2, Math.max(...keys.map(k => width(k))) + 3);
      return h(Box, {flexDirection: 'column', marginBottom: 1}, h(Text, {bold: true}, t('コマンド')),
        // term.js wrap breaks at spaces and drops the one at the break (Ink's kept it, so English
        // continuation lines started one column in).
        ...COMMANDS.map(([n, d]) => h(Box, {key: n, paddingLeft: 2}, h(Box, {flexShrink: 0, width: 14}, h(Text, {color: ACCENT}, n)),
          h(Box, {flexShrink: 1, flexDirection: 'column'}, ...wrapText(t(d), Math.max(8, W - 17)).map((l, i) => h(Text, {key: i, color: GRAY, wrap: 'truncate-end'}, l))))),
        h(Text, null, ' '), h(Text, {bold: true}, t('キー')),
        // Narrow screens stack the key cells and wrap them whole: one truncated cell per
        // grid row lost the end of every phrase (first B12).
        ...(W < 56 ? keys.map((k, i) => h(Box, {key: 'k' + i, paddingLeft: 2}, h(Text, {color: GRAY, wrap: 'wrap'}, k)))
          : [h(Box, {key: 'keys', paddingLeft: 2, flexWrap: 'wrap', width: W}, ...keys.map((k, i) => h(Box, {key: i, width: cellW, flexShrink: 0}, h(Text, {color: GRAY, wrap: 'truncate-end'}, k))))]));
    }
    case 'todos': return h(Box, {flexDirection: 'column', marginBottom: 1}, (e.todos || []).length ? e.todos.map((td, i) => h(TodoRow, {key: i, td})) : h(Text, {color: GRAY}, t('  Todo はまだありません。')));
    case 'status': { const gwStatus = a.client.status === 'connected' ? t('接続中') : a.client.status === 'demo' ? 'demo' : String(a.client.status || ''); const rows = [
      ['Muse', ctrl.museName + c.faint('  ' + t('ゲートウェイ') + ' ' + gwStatus)], [t('端末'), a.constructor.DEVICE + (a.nodeSlot?.slot ? c.faint('  ' + t('窓 {n}', {n: a.nodeSlot.slot})) : '') + '  ' + (a.device?.connected ? c.green(t('接続中')) : c.red(t('未接続')))],
      [t('会話'), (a.session.title || t('(新規)')) + c.faint('  ' + a.session.id)], [t('場所'), a.cwd], [t('承認'), t(LABELS[a.mode])],
      // Which account's Muse this window talks to (several accounts: src/accounts.js).
      // The id is added only after a name: an unnamed account read "2  2".
      ...(a.accountId ? [[t('アカウント'), a.accountLabel && a.accountLabel !== a.accountId ? a.accountLabel + c.faint('  ' + a.accountId) : a.accountId]] : []),
      // The real token counts by window (the same numbers /usage shows), once
      // any turn has carried a live [usage] line.
      ...usageWindowRows(),
    ];
    // The label column fits the widest label (アカウント is wider than the old fixed 6).
    const kw = Math.max(6, ...rows.map(([k]) => width(k) + 2));
    // Under 40 columns the two-column form leaves a few cells per value and connected vs
    // signed-out look alike: label and value stack, the value cut at its start so a folder
    // still names itself (deep r3 R8, first U8's gateway wording).
    if (W < 40) return h(Box, {flexDirection: 'column', marginBottom: 1}, ...rows.flatMap(([k, v]) => [h(Line, {key: k, bold: true}, '  ' + k), h(Line, {key: k + 'v'}, '    ' + tailText(v, Math.max(10, W - 4)))]));
    return h(Box, {flexDirection: 'column', marginBottom: 1}, ...rows.map(([k, v]) => h(Line, {key: k}, '  ' + c.gray(pad(k, kw)) + v))); }
    default: return null;
  }
}

// The real token counts by window for /status (src/usage.js): the last hour,
// today, the last 7 days and all time. Empty until a turn has carried a live
// [usage] line; a broken tally must never break the status view.
function usageWindowRows() {
  try {
    const s = require('../usage.js').summary();
    if (!(s.allTime.realInTokens || s.allTime.realOutTokens)) return [];
    const f = require('../turn-usage').formatTokens;
    const u = require('../usage.js'), since = d => d ? c.faint('  ' + t('（{date} から記録）', {date: u.sinceLabel(d)})) : '';
    const fmt = b => f(b.realInTokens || 0) + ' in / ' + f(b.realOutTokens || 0) + ' out';
    return [[t('実績 1時間'), fmt(s.lastHour)], [t('実績 今日'), fmt(s.today)], [t('実績 7日'), fmt(s.last7) + since(s.realSince7)], [t('実績 累計'), fmt(s.allTime) + since(s.realSince)]];
  } catch { return []; }
}

// ---------- live area ----------
function focusLabel(status) {
  return t(({running: '確認中', complete: '条件の根拠が揃いました', needs_input: '確認・判断待ち', stalled: '進展がないため停止', limit: '上限で停止', stopped: '中断', blocked: '続行できません'})[status] || '確認中');
}
function useTick(active, ms = 100) {
  const [n, setN] = useState(0);
  const motion = switchValue('motion');
  useEffect(() => { if (!active || !motion) return; const t = setInterval(() => setN(x => x + 1), ms); return () => clearInterval(t); }, [active, ms, motion]);
  return n;
}
// The spinner word: Muse's own, from spinner.set; until it sends one, a word from this list —
// English in both languages, a different one each turn, kept for the whole turn (picked from when
// it started) so the line does not flicker between words.
export const THINKING_WORDS = ['Musing', 'Daydreaming', 'Mulling', 'Wondering', 'Stargazing', 'Imagining', 'Conjuring', 'Woolgathering', 'Tinkering', 'Sparking'];
export const WRITING_WORDS = ['Composing', 'Penning', 'Inking', 'Scribbling', 'Drafting', 'Weaving'];
export const spinnerWord = (list, seed) => list[Math.abs(Math.floor(Number(seed) || 0)) % list.length] + '…';
function Working({s, W}) {
  const n = useTick(true);
  const what = s.status === 'waiting_for_approval' ? t('Muse 側で承認待ち（muse.ai を確認）') : s.museRunning ? s.museRunning + '…' : s.activity ? s.activity + '…' : s.spinnerWord ? s.spinnerWord + '…' : s.stream?.partial ? spinnerWord(WRITING_WORDS, s.turnStart) : spinnerWord(THINKING_WORDS, s.turnStart);
  // Narrow screens put the elapsed / esc part on its own line: on one line it wrapped into
  // the sentence and scattered across three lines (first B11).
  if (W && W < 50) return h(Box, {flexDirection: 'column', marginTop: 1}, h(Line, {color: ACCENT}, SPIN[n % SPIN.length] + ' ' + what), h(Text, {color: DIM}, '  ' + elapsed(Date.now() - (s.turnStart || Date.now())) + t(' · esc で中断')));
  return h(Box, {marginTop: 1}, h(Text, {color: ACCENT}, SPIN[n % SPIN.length] + ' ' + what), h(Text, {color: DIM}, '  ' + elapsed(Date.now() - s.turnStart) + t(' · esc で中断')));
}
function Running({r}) {
  const n = useTick(true);
  const all = [...(r.tail || []), ...(r.now?.trim() ? [r.now] : [])], shown = all.slice(-5), hidden = all.length - shown.length;
  return h(Box, {flexDirection: 'column'},
    h(Line, null, c.accent(SPIN[n % SPIN.length]) + ' ' + c.bold(title(r.call)) + c.gray('(' + (r.call.summary || '') + ')')),
    // The last-5-lines window says how much it hides (first U6).
    ...(hidden ? [h(Line, {key: 'more', color: DIM}, '  │ ' + t('… ほか {n} 行', {n: hidden}))] : []),
    ...shown.map((l, i) => h(Line, {key: i, color: DIM}, '  │ ' + l)));
}
function Approval({a, ctrl, W}) {
  const call = a.call, rows = [];
  if (call.kind === 'mcp') {
    // The tool being approved is named even when the server name is long: under 44 columns
    // the two go on separate lines (deep r2 R2-6).
    if (W < 44) { rows.push(h(Line, {key: 's'}, c.gray(t('サーバー ')) + (call.mcp?.server || ''))); rows.push(h(Line, {key: 't'}, c.gray(t('   ツール ').trimStart()) + c.bold(call.mcp?.tool || ''))); }
    else rows.push(h(Line, {key: 's'}, c.gray(t('サーバー ')) + call.mcp.server + c.gray(t('   ツール ')) + c.bold(call.mcp.tool)));
    // What is not shown is said: an approval must not hide part of what it approves.
    // The values share the screen: 12 values of 400 characters pushed the options off it.
    // The per-value budget follows the width too: a flat 60-char floor made each value wrap
    // to 3-4 rows on a 30-wide screen and pushed the options off it (deep r2 R2-7).
    const entries = Object.entries(call.params || {}), shown = entries.slice(0, 12);
    const each = Math.max(24, Math.min(400, Math.floor((W - 6) * Math.max(4, (process.stdout.rows || 30) - 16) / Math.max(1, shown.length))));
    for (const [k, v] of shown) { const s = String(typeof v === 'string' ? v : JSON.stringify(v)); rows.push(h(Text, {key: 'p' + k, wrap: 'wrap'}, c.faint(k + ': ') + s.slice(0, each) + (s.length > each ? c.faint(t(' … ほか {n} 文字', {n: s.length - each})) : ''))); }
    if (entries.length > 12) rows.push(h(Text, {key: 'pmore', color: '#e6be64'}, t('… ほか {n} 個の引数', {n: entries.length - 12})));
  } else if (call.kind === 'exec') {
    // Lines and characters both: one 20,000-character line wrapped to hundreds of rows and pushed
    // the yes / no options off the screen. What is cut is said, with how much.
    const cmd = String(call.params?.command ?? ''), cmdLines = cmd.split('\n'), budget = Math.max(200, (W - 6) * Math.max(4, (process.stdout.rows || 30) - 18));
    let used = 0, shownLines = 0, partialChars = 0;
    for (const l of cmdLines.slice(0, 12)) {
      if (used >= budget) break;
      const part = l.length > budget - used ? l.slice(0, budget - used) : l;
      rows.push(h(Text, {key: 'c' + shownLines, wrap: 'wrap'}, part)); used += part.length; shownLines++; partialChars += l.length - part.length;
    }
    // What is cut is said in full: whole hidden lines AND the hidden tail of a partially
    // shown line both count (deep r2 R2-8 counted only one of the two).
    const hiddenLines = cmdLines.length - shownLines;
    if (hiddenLines > 0 && partialChars > 0) rows.push(h(Text, {key: 'cmore', color: '#e6be64'}, t('… ほか {n} 行と {m} 文字（全部で {total} 行。見えていない行も実行されます）', {n: hiddenLines, m: partialChars, total: cmdLines.length})));
    else if (hiddenLines > 0) rows.push(h(Text, {key: 'cmore', color: '#e6be64'}, t('… ほか {n} 行（全部で {total} 行。見えていない行も実行されます）', {n: hiddenLines, total: cmdLines.length})));
    else if (partialChars > 0) rows.push(h(Text, {key: 'cmore', color: '#e6be64'}, t('… ほか {n} 文字（全部で {total} 文字。見えていない部分も実行されます）', {n: partialChars, total: cmd.length})));
    if (call.params?.cwd) rows.push(h(Text, {key: 'cwd', color: GRAY}, t('場所: {cwd}', {cwd: call.params.cwd})));
  } else if (a.preview?.error) rows.push(h(Text, {key: 'e', color: '#f06e6e', wrap: 'wrap'}, t('プレビューできません: {error}', {error: a.preview.error})));
  else if (a.preview?.files) {
    // Diffs while they fit, then the other files by name: 15 files of 14 rows pushed the options off the screen.
    const room = Math.max(8, (process.stdout.rows || 30) - 16), name = f => relPath(ctrl.agent.cwd, f.path);
    let used = 0, i = 0;
    for (const f of a.preview.files) {
      if (used + 4 > room) break;
      const max = Math.min(14, room - used - 2), fd = safeDiff(f.diff);
      rows.push(h(Line, {key: 'f' + i}, c.bold(name(f)) + c.faint('  ' + f.op))); rows.push(h(Diff, {key: 'd' + i, diff: fd, W: W - 4, max}));
      used += 2 + Math.min(fd.length, max); i++;
    }
    const rest = a.preview.files.slice(i);
    if (rest.length) {
      // Names are dropped by COUNT, never cut mid-name in silence: what does not fit is
      // itself counted at the end (first B10).
      const allNames = rest.map(f => name(f) + ' (' + f.op + ')'), budget = (W - 6) * 3;
      let names = allNames.join(', '), omitted = 0;
      if (width(names) > budget) {
        const kept = [];
        for (const nm of allNames) { const trial = [...kept, nm].join(', '); if (width(trial) + width(' … ほか ' + (allNames.length - kept.length - 1) + ' ファイル') > budget) break; kept.push(nm); }
        omitted = allNames.length - kept.length; names = kept.join(', ');
      }
      rows.push(h(Text, {key: 'fmore', color: '#e6be64', wrap: 'wrap'}, t('… ほか {n} ファイル: {names}', {n: rest.length, names}) + (omitted ? ' ' + t('… ほか {n} ファイル', {n: omitted}) : '')));
    }
  }
  else if (a.preview?.diff) rows.push(h(Diff, {key: 'd', diff: safeDiff(a.preview.diff), W: W - 4, max: Math.max(8, (process.stdout.rows || 30) - 18)}));
  if (a.outside) rows.push(h(Text, {key: 'o', color: '#e6be64'}, t('⚠ 作業フォルダーの外への書き込みです')));
  return h(Box, {flexDirection: 'column', marginTop: 1},
    h(Box, {flexDirection: 'column', borderStyle: 'round', borderColor: '#e6be64', paddingX: 1, width: W},
      h(Line, null, (call.agent && call.agent !== 'main' ? c.accent(t('[エージェント {agent}] ', {agent: call.agent})) : '') + c.yellow(c.bold(call.kind === 'exec' ? title(call) + t(' コマンド') : title(call))) + (call.kind === 'exec' ? '' : '  ' + (call.summary || ''))),
      h(Box, {flexDirection: 'column', marginY: 1}, rows),
      h(Text, {bold: true}, call.kind === 'exec' || call.kind === 'mcp' ? t('実行していい？') : t('この変更をしていい？')),
      // Option labels wrap: the permanent-allow option names its target at its END, which
      // a truncated line hid exactly where it mattered (deep r2 R2-5).
      ...(a.options || []).map((o, i) => h(Text, {key: 'o' + i, wrap: 'wrap'}, i === a.index ? c.accent('❯ ') + c.bold((i + 1) + '. ' + o.label) : '  ' + (i + 1) + '. ' + o.label)),
    h(Text, {color: DIM}, t('  ↑↓ で選んで enter · 1-{n} · esc で断る', {n: (a.options || []).length}))));
}
const MENU_ROWS = 12;
function Menu({m, W}) {
  const opts = m.options || [];
  // A hint that does not fit beside the title gets its own wrapped line: on one truncated
  // line the 60-second auto-decision and the "picking stops it" warning vanished (r3 R3/R5).
  const hintOwn = m.hint && width(String(m.title || '')) + 3 + width(m.hint) > W - 6;
  return h(Box, {flexDirection: 'column', marginTop: 1},
    h(Box, {flexDirection: 'column', borderStyle: 'round', borderColor: ACCENT, paddingX: 1, width: W},
      h(Line, null, c.accent(c.bold(m.title)) + (m.hint && !hintOwn ? c.faint('   ' + m.hint) : '')),
      ...(hintOwn ? [h(Text, {key: 'hint', color: DIM, wrap: 'wrap'}, m.hint)] : []),
      h(Text, null, ' '),
      ...(opts.length ? [] : [h(Line, {key: 'none', color: DIM}, t('選択肢がありません'))]),
      // The label column fits the longest label (English ones run longer), within limits. Long
      // lists (/skills) show a window of MENU_ROWS around the cursor, so the box fits the screen.
      ...((labelW => {
        const n = opts.length, start = n <= MENU_ROWS ? 0 : Math.max(0, Math.min(m.index - Math.floor(MENU_ROWS / 2), n - MENU_ROWS)), end = Math.min(n, start + MENU_ROWS);
        // Under 50 columns the label column goes: the label takes the whole row and the
        // description goes under it, so rows sharing a long prefix stay tellable (first B4).
        const narrow = W < 50;
        return [
          ...(start > 0 ? [h(Text, {key: 'up', color: DIM}, '  ' + t('↑ ほか {n} 件', {n: start}))] : []),
          ...opts.slice(start, end).flatMap((o, j) => {
            const i = start + j, on = i === m.index, mark = o.mark || o.value === m.current ? c.green(' ✓') : '';
            const label = (i + 1) + '. ' + o.label, col = o.danger ? c.red : c.text;
            // The label box is 2 cells short of its column, so a label cut at the column
            // edge still leaves a gap before the description (deep r3 R6). The selected
            // row's description wraps whole instead of being cut (first I4).
            const row = narrow
              ? h(Box, {key: i, flexDirection: 'column'}, h(Box, null, h(Box, {flexShrink: 0, width: 2}, h(Text, null, on ? c.accent('❯') : ' ')), h(Box, {flexShrink: 1}, h(Line, null, (on ? c.bold(col(label)) : col(label)) + mark))),
                o.desc ? h(Box, {paddingLeft: 2}, h(Text, {color: on ? GRAY : DIM, wrap: on ? 'wrap' : 'truncate-end'}, o.desc)) : null)
              : h(Box, {key: i}, h(Box, {flexShrink: 0, width: 2}, h(Text, null, on ? c.accent('❯') : ' ')), h(Box, {width: Math.max(4, labelW - 2), flexShrink: 0, marginRight: 2}, h(Line, null, (on ? c.bold(col(label)) : col(label)) + mark)),
                h(Box, {flexShrink: 1}, h(Text, {color: on ? GRAY : DIM, wrap: on ? 'wrap' : 'truncate-end'}, o.desc || '')));
            // A genre header when the group changes (/settings groups its rows):
            // display only — numbering and picking stay per option. The first
            // visible row always gets its header, so a scrolled window still
            // says which genre it is in.
            return o.group && (j === 0 || opts[i - 1]?.group !== o.group) ? [h(Text, {key: 'h' + i, bold: true, color: ACCENT}, o.group), row] : [row];
          }),
          ...(end < n ? [h(Text, {key: 'down', color: DIM}, '  ' + t('↓ ほか {n} 件', {n: n - end}))] : []),
        ];
      })(Math.min(Math.floor(W * 0.45), opts.reduce((mx, o, i) => Math.max(mx, width((i + 1) + '. ' + o.label) + 4), 28))))),
    h(Text, {color: DIM}, opts.length ? t('  ↑↓ で選んで enter · 数字 · esc で閉じる') : t('  esc で閉じる')));
}
// Wrap one logical line into display rows of at most paneW cells, by grapheme
// cluster (a cluster wider than the pane gets a row of its own rather than
// vanishing). The question preview is capped with this: Ink wraps again at the
// pane width, so rows built any wider would multiply on screen.
function wrapDisplayRows(line, paneW) {
  const max = Math.max(1, paneW), rows = []; let cur = '', w = 0;
  for (const g of graphemesOf(line)) {
    const gw = width(g);
    if (cur && w + gw > max) { rows.push(cur); cur = ''; w = 0; }
    cur += g; w += gw;
  }
  rows.push(cur);
  return rows;
}
function Question({q, W}) {
  const qs = q.questions || [], onSubmit = q.tab >= qs.length, cur = onSubmit ? null : qs[q.tab];
  const innerW = Math.max(20, W - 4), submitTab = t('✓ 送信'), single = qs.length <= 1;
  // A header that merely fell back to the question text (focus.js: the first 16
  // chars, or the whole text) is not a header of its own: the tab would repeat
  // the question printed right below it, so the tab uses a short numbered label.
  const tabLabel = (qq, i) => qq.header && qq.header !== qq.question && qq.header !== String(qq.question || '').slice(0, 16) ? qq.header : t('質問 {n}', {n: i + 1});
  const answered = i => !!(q.answers?.[i] || (qs[i]?.multi ? (q.checked?.[i]?.length || q.custom?.[i]) : (q.picked?.[i] != null || q.custom?.[i])));
  const tabs = [...qs.map((qq, i) => { const label = (answered(i) ? '[✓] ' : '[ ] ') + tabLabel(qq, i); return i === q.tab ? c.accent(c.bold(label)) : c.gray(label); }),
    onSubmit ? c.accent(c.bold(submitTab)) : c.gray(submitTab)].join('  ');
  // The tab row wraps: truncated to one line, the later tabs and the submit tab itself
  // vanished at narrow widths (deep r2 R2-2).
  const kids = single ? [] : [h(Text, {key: 'tabs', wrap: 'wrap'}, tabs)];
  // The multi-select hint shows how many answers are checked (checked
  // options plus the typed answer, if any); with none it says so instead of
  // offering a send. Each hint is written out in full, because the i18n test
  // finds translated strings by their literal text.
  const multiCount = cur?.multi ? (q.checked?.[q.tab] || []).length + (q.custom?.[q.tab] ? 1 : 0) : 0;
  let footer;
  if (q.mode === 'type' || q.mode === 'notes') footer = t('enter で確定 · esc で戻る');
  else if (onSubmit) footer = t('↑↓ 移動 · enter 選択 · n メモ · tab 質問 · esc 閉じる');
  else if (cur?.multi && single) footer = multiCount > 0 ? t('space 切替 · enter 送信（{n} 件） · n メモ · esc 閉じる', {n: multiCount}) : t('space 切替 · enter 送信（1 つ以上選択） · n メモ · esc 閉じる');
  // With several questions, enter moves on (next question / the send tab), it does not send.
  else if (cur?.multi) footer = multiCount > 0 ? t('space 切替 · enter 次へ（{n} 件） · n メモ · tab 質問 · esc 閉じる', {n: multiCount}) : t('space 切替 · enter 次へ（1 つ以上選択） · n メモ · tab 質問 · esc 閉じる');
  else if (single) footer = t('↑↓ 移動 · enter 選択 · n メモ · esc 閉じる');
  else footer = t('↑↓ 移動 · enter 選択 · n メモ · tab 質問 · esc 閉じる');
  if (onSubmit) {
    kids.push(h(Text, {key: 'head', bold: true}, t('回答の確認')));
    // The confirmation names questions the same way the tabs do (the short 質問 n label for
    // a fallback header, deep r2 R2-3), wraps long answers whole (R2-4), and warns before
    // the send row when something is unanswered (first U11).
    qs.forEach((qq, i) => kids.push(h(Text, {key: 'a' + i, wrap: 'wrap'}, tabLabel(qq, i) + ': ' + (q.answers?.[i] ? q.answers[i] : c.faint(t('未回答'))))));
    if (qs.some((_, i) => !q.answers?.[i])) kids.push(h(Line, {key: 'warn', color: '#e6be64'}, t('未回答があります。このまま送りますか？')));
    kids.push(h(Line, {key: 'submit'}, q.index === 0 ? c.accent('❯ ') + c.bold(t('送信する')) : '  ' + t('送信する')));
  } else if (cur) {
    kids.push(h(Text, {key: 'q', bold: true}, cur.question + (cur.multi ? t('（複数選択）') : '')));
    const opts = cur.options || [], checked = q.checked?.[q.tab] || [], rows = [];
    opts.forEach((o, i) => {
      const on = i === q.index, box = cur.multi ? (checked.includes(i) ? '[✓] ' : '[ ] ') : '';
      const label = (i + 1) + '. ' + o.label;
      rows.push(h(Line, {key: 'o' + i}, (on ? c.accent('❯ ') : '  ') + box + (on ? c.bold(label) : label)));
      // The selected option's description wraps whole: it is the text being chosen between,
      // and a truncated description cannot be read anywhere else (first B5).
      if (o.description) rows.push(on ? h(Text, {key: 'd' + i, color: DIM, wrap: 'wrap'}, ' '.repeat(2 + box.length + String(i + 1).length + 2) + o.description) : h(Line, {key: 'd' + i, color: DIM}, ' '.repeat(2 + box.length + String(i + 1).length + 2) + o.description));
    });
    // Type-something is the last numbered choice (n+1), with a checkbox in
    // multi select that follows the typed answer, then a dim separator and
    // the dim chat row below it: visibly not a choice, still navigable.
    const typeOn = q.index === opts.length, typeBox = cur.multi ? (q.custom?.[q.tab] ? '[✓] ' : '[ ] ') : '';
    // While typing, the row shows the TAIL of the text with its caret: the head-only cut hid
    // what was being typed (deep r2 R2-9).
    const typeRaw = q.mode === 'type' ? (q.typeText || '') + '▌' : null;
    const typeLabel = (opts.length + 1) + '. ' + (typeRaw ? tailText(typeRaw, Math.max(8, innerW - 6 - typeBox.length - String(opts.length + 1).length)) : t('自分で書く…'));
    rows.push(h(Line, {key: 'type'}, (typeOn ? c.accent('❯ ') : '  ') + typeBox + (typeOn ? c.bold(typeLabel) : typeLabel)));
    rows.push(h(Line, {key: 'sep', color: DIM}, '  ' + '─'.repeat(12)));
    const chatOn = q.index === opts.length + 1, chatLabel = t('この件について話す');
    rows.push(h(Line, {key: 'chat', color: DIM}, (chatOn ? c.accent('❯ ') : '  ') + (chatOn ? c.bold(chatLabel) : chatLabel)));
    const sel = q.index < opts.length ? opts[q.index] : null, preview = sel?.preview ? String(sel.preview) : null;
    // Under 60 columns the preview goes UNDER the options at full width: side by side, its
    // pane was a few cells wide and every line broke mid-phrase (first B6).
    const vertical = !!preview && W < 60;
    const leftW = preview && !vertical ? Math.max(20, Math.floor(innerW * 0.45)) : innerW;
    const left = h(Box, {key: 'left', flexDirection: 'column', flexShrink: 0, width: leftW}, rows);
    let right = null, previewHidden = 0;
    if (preview) {
      // Cap by DISPLAY rows, not logical lines (deep Part B R2-1): one long
      // logical line at width 30 used to wrap to 237 rows because slice(0, 8)
      // counted lines before wrapping. Wrap each logical line to the preview
      // pane's text width first (the question box's border+padding and the
      // pane's own border+padding come off: W - leftW - 8), then keep the
      // first 8 display rows and say how many display rows were left out.
      const paneW = vertical ? Math.max(1, innerW - 4) : Math.max(1, W - leftW - 8);
      const displayRows = preview.split('\n').flatMap(l => wrapDisplayRows(l, paneW));
      const shown = displayRows.slice(0, 8);
      previewHidden = displayRows.length - shown.length;
      right = h(Box, {key: 'right', flexShrink: 1}, h(Box, {flexDirection: 'column', flexShrink: 1, borderStyle: 'single', paddingX: 1},
        ...shown.map((l, i) => h(Text, {key: 'p' + i, wrap: 'truncate-end'}, l || ' '))));
    }
    kids.push(vertical ? h(Box, {key: 'body', flexDirection: 'column'}, left, right) : h(Box, {key: 'body'}, left, right));
    // The omitted note goes under the body, not inside the pane: at width 30
    // the pane is a few cells wide and a note inside it was truncated away to
    // nothing, so the cut was silent exactly where it was largest.
    if (previewHidden > 0) kids.push(h(Line, {key: 'pcut', color: '#e6be64'}, '  ' + t('✂ {n} 行を省略', {n: previewHidden})));
    const note = q.mode === 'notes' ? t('メモ: {text}', {text: (q.typeText || '') + '▌'}) : q.notes ? t('メモ: {text}', {text: q.notes}) : t('メモ: n で追加');
    kids.push(h(Text, {key: 'notes', color: '#78aaf0', italic: true}, note));
  }
  return h(Box, {flexDirection: 'column', marginTop: 1},
    h(Box, {flexDirection: 'column', borderStyle: 'round', borderColor: ACCENT, paddingX: 1, width: W}, kids),
    // The footer wraps like the menu's does: truncated to one line, the esc key fell off
    // at narrow widths (first B15).
    h(Text, {color: DIM, wrap: 'wrap'}, '  ' + footer));
}
// Wraps the buffer by display cells so the caret position is exact.
function layout(text, pos, max) {
  const lines = [''], widths = [0]; let cur = {row: 0, col: 0}, i = 0;
  for (const ch of graphemesOf(text)) {
    if (i === pos) cur = {row: lines.length - 1, col: widths[widths.length - 1]};
    i += ch.length;
    if (ch === '\n') { lines.push(''); widths.push(0); continue; }
    const w = width(ch);
    if (widths[widths.length - 1] + w > max) { lines.push(''); widths.push(0); }
    lines[lines.length - 1] += ch; widths[widths.length - 1] += w;
  }
  if (i <= pos) cur = {row: lines.length - 1, col: widths[widths.length - 1]};
  return {lines, cur};
}
function Chips({list, W}) {
  if (!list?.length) return null;
  const kb = n => n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
  // One chip per line: side by side they wrapped INTO each other and the names and sizes
  // interleaved into nonsense; the hint gets a line of its own too (first B1). On a
  // narrow screen the SIZE is what goes: the name is the part that identifies the file.
  return h(Box, {flexDirection: 'column', marginTop: 1, paddingX: 1}, ...list.map((a, i) => { const badge = ' ▣ ' + t('画像 {n}', {n: i + 1}) + ' ', name = a.name || '', size = kb(a.size || 0), full = width(badge) + 1 + width(name) + 3 + width(size) <= (W ? W - 2 : Infinity); return h(Line, {key: i}, h(Text, {backgroundColor: '#2d2d34', color: ACCENT}, badge), h(Text, {color: GRAY}, full ? ' ' + name + ' · ' + size : name)); }),
    h(Text, {key: 'hint', color: DIM}, t('空の入力で backspace → 外す')));
}
// Where the input box sits, for the IME caret. Ink's useBoxMetrics re-measured in a microtask
// after every commit and set state from there; on a user's PC (2026-11-01, not reproduced here)
// that chained into React's "Maximum update depth exceeded" and killed muser. This measures after
// the box's own renders on a timer, never inside a commit, and stops following a box that keeps
// moving (over 20 moves in a second) instead of re-rendering without end.
function useBoxPosition(ref) {
  const [pos, setPos] = useState(null), moves = useRef([]);
  useEffect(() => {
    const id = setTimeout(() => {
      const l = ref.current?.yogaNode?.getComputedLayout();
      const next = l ? {left: l.left, top: l.top} : null;
      setPos(p => {
        if (p === next || (p && next && p.left === next.left && p.top === next.top)) return p;
        const now = Date.now(); moves.current = moves.current.filter(t => now - t < 1000); moves.current.push(now);
        return moves.current.length > 20 ? p : next;
      });
    }, 0);
    return () => clearTimeout(id);
  });
  return pos;
}
function Prompt({s, W}) {
  const ref = useRef(null), box = useBoxPosition(ref), {setCursorPosition} = useCursor();
  const reason = !!s.reasonFor, bang = !reason && s.text.trimStart().startsWith('!'), head = reason ? t('理由 ') : '❯ ', inner = W - 4 - width(head);
  const {lines: all, cur} = layout(s.text, s.pos, inner);
  // A window of rows around the caret: a 3,000-line paste drew 3,000 rows on every key (0.5 s a
  // frame, far taller than the terminal). The text itself is untouched.
  const max = Math.max(4, Math.min(30, (process.stdout.rows || 30) - 14));
  const start = all.length <= max ? 0 : Math.max(0, Math.min(cur.row - Math.floor(max / 2), all.length - max));
  const lines = all.slice(start, start + max), above = start, below = all.length - start - lines.length;
  // Set during render, not in an effect: Ink applies it to the frame being written, while an
  // effect lands one frame late and leaves the caret on the previous position.
  if (box) setCursorPosition({x: box.left + 2 + width(head) + cur.col, y: box.top + 1 + (above ? 1 : 0) + cur.row - start});
  // On the account-add screen the composer answers the screen, it does not chat: its hint
  // says so instead of the chat's placeholder.
  // Narrow screens get short placeholders that end as whole sentences: the long forms
  // were cut mid-phrase and lost exactly their point (deep r4 R4-7).
  const placeholder = s.addFlow ? (s.promptFor ? t('ここに入力して Enter') : t('アカウントを追加しています…')) : reason ? t('断る理由（空でも可）') : W < 44 ? (s.busy ? t('Muse が作業中') : t('何をしますか？')) : s.busy ? t('Muse が作業中 · 送ると作業中の Muse に伝えます') : t('何をしますか？   / でコマンド');
  return h(Box, {ref, flexDirection: 'column', borderStyle: 'round', borderColor: reason || bang ? '#e6be64' : s.busy ? '#3c3c44' : DIM, paddingX: 1, width: W, marginTop: 1},
    ...(above ? [h(Text, {key: 'above', color: DIM}, ' '.repeat(width(head)) + t('↑ ほか {n} 行（全部で {total} 行）', {n: above, total: all.length}))] : []),
    // The ❯ never shrinks: a placeholder wider than the box squeezed out the space after it.
    ...lines.map((l, i) => h(Box, {key: i}, h(Box, {flexShrink: 0}, h(Text, {color: reason ? '#e6be64' : ACCENT}, i + start ? ' '.repeat(width(head)) : head)),
      h(Text, {wrap: 'truncate-end', color: !s.text ? DIM : undefined}, !s.text && i === 0 ? placeholder : l || ' '))),
    ...(below ? [h(Text, {key: 'below', color: DIM}, ' '.repeat(width(head)) + t('↓ ほか {n} 行', {n: below}))] : []));
}
// The completion key hint: under 50 columns the long form was cut mid-word, so a short
// form that fits whole takes its place (deep r4 R4-3).
const keyHint = W => W < 50 ? t('↑↓ 選択 · enter/tab 補完') : t('   ↑↓ で選択 · enter / tab で補完').trim();
function Footer({s, ctrl, W}) {
  const m = s.mode, color = m === 'bypass' ? '#f06e6e' : m === 'plan' ? '#78aaf0' : m === 'auto-edit' ? ACCENT : GRAY;
  const at = mentionAt(s.text, s.pos);
  if (at) {
    // Every match, not mentions' COMPLETE_LIMIT of 6 (deep Part B R4-1): the
    // list below is a window that follows the selection, so all candidates
    // stay reachable by ↑↓ / tab and the total can be shown.
    const list = mentionComplete(at.fragment, ctrl.agent.cwd, 10000, () => ctrl.set({}));
    const diag = mentionDiag();
    // The listing diagnostic matters whenever it is not a clean rg run — a walk fallback or an
    // error explains odd results even when there ARE matches, not only when there are none.
    const diagNote = (diag.error || diag.source === 'walk' || diag.source === 'none')
      ? h(Text, {key: 'diag', color: DIM}, t('ファイル一覧: {source}{error}', {source: diag.source, error: diag.error ? '（' + diag.error + '）' : ''})) : null;
    if (!list.length) {
      if (mentionLoading(ctrl.agent.cwd)) return h(Box, {paddingX: 2}, h(Text, {color: DIM}, t('ファイルを探しています…')));
      return h(Box, {flexDirection: 'column', paddingX: 2},
        h(Text, {color: DIM}, diag.source === 'none' ? t('ファイル一覧を取得できませんでした（{error}）', {error: diag.error}) : t('一致するファイルがありません')), diagNote);
    }
    const sel = ctrl.atIndex(at.fragment, list.length);
    // A window of rows around the highlight, like the /command list: every
    // candidate is reachable, the footer never grows past the window, and
    // the lines around it say how many are hidden and the total count.
    const WIN = 6, start = Math.max(0, Math.min(sel - Math.floor(WIN / 2), Math.max(0, list.length - WIN)));
    const shown = list.slice(start, start + WIN);
    // The keys go on a line of their own: on the selected row they ran off a narrow screen.
    return h(Box, {flexDirection: 'column', paddingX: 2},
      ...(start > 0 ? [h(Line, {key: 'up', color: DIM}, '  ' + t('↑ ほか {n} 件', {n: start}))] : []),
      // A path longer than the screen keeps its END (the file name): the head cut showed
      // only the shared directory prefix of every candidate (first B14).
      ...shown.map((f, i) => h(Line, {key: f}, start + i === sel ? c.accent('◇ ' + tailText(f, Math.max(10, W - 6))) : c.gray('  ' + tailText(f, Math.max(10, W - 6))))),
      ...(start + WIN < list.length ? [h(Line, {key: 'down', color: DIM}, '  ' + t('↓ ほか {n} 件', {n: list.length - start - WIN}))] : []),
      h(Line, {key: 'count', color: DIM}, '  ' + t('全 {total} 件中 {n} 件目', {total: list.length, n: sel + 1})),
      h(Line, {key: 'keys', color: DIM}, '  ' + keyHint(W)), diagNote);
  }
  const dctx = typeof ctrl.dollarContext === 'function' ? ctrl.dollarContext(s.text, s.pos) : null;
  if (dctx) {
    if (!dctx.list.length) return h(Box, {paddingX: 2}, h(Line, {color: DIM}, dctx.noSkills ? t('スキルがありません（/skills）') : t('一致するスキルがありません')));
    const sel = ctrl.dollarIndex(dctx.frag.fragment, dctx.list.length);
    const WIN = 6, start = Math.max(0, Math.min(sel - Math.floor(WIN / 2), Math.max(0, dctx.list.length - WIN)));
    const shown = dctx.list.slice(start, start + WIN);
    return h(Box, {flexDirection: 'column', paddingX: 2},
      ...(start > 0 ? [h(Line, {key: 'up', color: DIM}, '  ' + t('↑ ほか {n} 件', {n: start}))] : []),
      ...shown.map((sk, i) => h(Line, {key: sk.name}, start + i === sel ? c.accent('❯ ' + pad('$' + sk.name, 16)) + c.gray(sk.description || '') : '  ' + c.gray(pad('$' + sk.name, 16)) + c.faint(sk.description || ''))),
      ...(start + WIN < dctx.list.length ? [h(Line, {key: 'down', color: DIM}, '  ' + t('↓ ほか {n} 件', {n: dctx.list.length - start - WIN}))] : []),
      h(Line, {key: 'keys', color: DIM}, '  ' + keyHint(W)));
  }
  if (s.text.trimStart().startsWith('!')) return h(Box, {paddingX: 1}, h(Line, null, c.yellow(t('! シェルモード')) + (W < 44 ? c.faint(' PowerShell') : c.faint(require('../settings.js').switchValue('bangAutoSend') ? t('   PowerShell で実行 · 終わったら出力を Muse へ') : t('   PowerShell で実行 · 出力は次のメッセージで Muse へ')))));
  if (s.text.startsWith('/') && !s.text.includes(' ')) {
    const list = COMMANDS.filter(([n]) => n.startsWith(s.text));
    const sel = ctrl.slashIndex(s.text, list.length);
    // A window of rows around the highlight: every command is reachable by ↑↓, but the footer
    // never shows more than 7 candidate rows (⋮ marks more above or below).
    const WIN = 7, start = Math.max(0, Math.min(sel - 3, list.length - WIN));
    const shown = list.slice(start, start + WIN);
    // The selected row has a ❯ (with colour off it was the only thing that told it apart), and the
    // keys go on a line of their own: after a long description they were cut off the screen.
    // The ⋮ marks said "more" without saying how much: they carry the hidden counts now,
    // in the words the other lists use (deep r4 R4-2). No match is said in words too (B16).
    return h(Box, {flexDirection: 'column', paddingX: 2},
      ...(start > 0 ? [h(Line, {key: 'up', color: DIM}, '  ' + t('↑ ほか {n} 件', {n: start}))] : []),
      // The SELECTED command's description wraps whole: it was cut with … at every width,
      // so the one command about to be run was the one whose explanation could not be
      // read (first U13).
      ...shown.map(([n, d], i) => start + i === sel ? h(Text, {key: n, wrap: 'wrap'}, c.accent('❯ ' + pad(n, 14)) + c.gray(t(d))) : h(Line, {key: n}, '  ' + c.gray(pad(n, 14)) + c.faint(t(d)))),
      ...(start + WIN < list.length ? [h(Line, {key: 'down', color: DIM}, '  ' + t('↓ ほか {n} 件', {n: list.length - start - WIN}))] : []),
      ...(list.length ? [h(Line, {key: 'keys', color: DIM}, '  ' + keyHint(W))] : [h(Line, {key: 'none', color: ACCENT}, t('一致するコマンドがありません'))]));
  }
  // The status lane, element by element (/settings): the window slot is internal
  // bookkeeping, so it starts hidden — /status and doctor still name it.
  const lane = [], slotNo = ctrl.agent.nodeSlot?.slot;
  // The lane is cut at its END when the screen is narrow, so what matters most goes FIRST:
  // which account is active, a pending account switch, and the weekly usage — the device
  // name and folder used to push exactly those off the screen (first B2, deep r3 R11).
  if (s.account?.label) lane.push(s.account.label);
  if (s.accountReserved) lane.push(t('→ {label} に切替予定', {label: s.accountReserved}));
  if (switchValue('footerUsage') && s.plan?.percentUsed != null) lane.push(t('週 {n}%', {n: s.plan.percentUsed}));
  if (switchValue('footerDevice')) lane.push(ctrl.agent.constructor.DEVICE + (switchValue('footerSlot') && slotNo ? ' ' + t('窓 {n}', {n: slotNo}) : ''));
  else if (switchValue('footerSlot') && slotNo) lane.push(t('窓 {n}', {n: slotNo}));
  if (switchValue('footerCwd') && ctrl.agent.cwd) lane.push(path.basename(ctrl.agent.cwd));
  if (switchValue('footerName')) lane.push(ctrl.museName);
  if (switchValue('footerSession') && ctrl.agent.session?.turns && ctrl.agent.client?.status !== 'demo') lane.push(ctrl.agent.session.id.slice(0, 8));
  if (switchValue('footerVersion')) lane.push('v' + ctrl.version);
  if (switchValue('footerClock')) { const d = new Date(); lane.push(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0')); }
  // One row at any width: on a narrow terminal both halves wrapped to two lines each. The
  // "shift+tab" hint goes first, then the status lane is cut at its end (the dot and the
  // warnings stay in front of it).
  const modeText = (m === 'default' ? '' : '⏵⏵ ') + t(LABELS[m]), hint = t('   shift+tab で切替');
  const running = (s.shells || []).filter(x => x.running).length;
  // Warnings first: the login warning leads the right side, so truncation at the lane's
  // end can never eat it; the update segment shortens on narrow screens (first B2).
  const right = [
    ...(s.loginNeeded ? [c.red(W < 48 ? t('ログインが必要（/login）  ').trimEnd() + ' ' : t('ログインが必要（/login）  '))] : []),
    ...(running ? [c.accent('⚙ ' + t('{n} 実行中', {n: running}) + '   ')] : []),
    ...(s.update?.checking ? [c.faint(t('更新を確認中…') + '   ')] : s.update?.latest ? [c.accent(W < 44 ? '⬆ v' + s.update.latest + ' /update   ' : '⬆ v' + s.update.latest + ' · /update   ')] : []),
    // Connected and disconnected differ by SHAPE, not only colour: with colour off (or
    // for a colour-blind reader) a red ● and a green ● are the same dot (first B3).
    (s.deviceOk ? c.green('● ') : c.red('○ ')) + c.faint(lane.join(' · ')),
  ].join('');
  // A flash keeps the mode mark: without it a plan/bypass flash looked like default mode
  // (deep r4 R4-6).
  const flashText = s.flash ? (m === 'default' ? '' : '⏵⏵ ') + s.flash : '';
  const leftW = s.flash ? width(flashText) : width(modeText) + width(hint);
  const showHint = !s.flash && width(modeText) + width(hint) + 2 + Math.min(width(right), 24) <= W - 2;
  // On a narrow screen a warning on the right (login, an update) outranks the mode label
  // on the left: with both, the warning's own command was the thing cut (first B2).
  const hideLeft = !s.flash && W < 48 && (s.loginNeeded || s.update?.latest);
  return h(Box, {paddingX: 1, width: W, justifyContent: 'space-between'},
    // On a narrow screen the left half is capped at half the width, so the connection dot
    // on the right always survives (deep r4 R4-4).
    h(Box, {flexShrink: 0, marginRight: 2, ...(W < 48 ? {maxWidth: Math.floor(W / 2)} : {})}, s.flash ? h(Text, {color: '#e6be64', wrap: 'truncate-end'}, leftW > W - 4 ? truncate(flashText, W - 4) : flashText)
      : hideLeft ? h(Text, null, '') : h(Text, null, h(Text, {color}, modeText), showHint ? h(Text, {color: DIM}, hint) : '')),
    h(Box, {flexShrink: 1}, h(Text, {wrap: 'truncate-end'}, right)));
}
function AgentCards({list, words}) {
  const n = useTick(list.some(x => x.state === 'working'));
  if (!list.length) return null;
  // As many as fit: 25 running agents (no limit set) took 50 rows and pushed the input off the
  // screen. Many agents get one line each; the rest are counted.
  const room = Math.max(3, (process.stdout.rows || 30) - 20), compact = list.length * 2 > room;
  const shown = [...list].sort((x, y) => (y.state === 'working') - (x.state === 'working')).slice(0, list.length > room ? room - 1 : room);
  // The overflow count goes AFTER the cards: above them it read as a header for whatever
  // sat above the cards, not as part of this list (first U12).
  return h(Box, {flexDirection: 'column', marginTop: 1},
    ...shown.map(x => {
      const working = x.state === 'working', mark = working ? c.accent(SPIN[(n + x.tag.length) % SPIN.length]) : x.state === 'done' ? c.green('✓') : x.state === 'stopped' ? c.yellow('■') : c.red('✗');
      const last = String(x.text || '').trim().split('\n').pop() || '';
      const what = working ? (x.lastTool ? c.gray(x.lastTool) : c.gray(words?.[x.tag] ? words[x.tag] + '…' : spinnerWord(THINKING_WORDS, x.started))) : c.faint(x.state === 'done' ? t('完了') : x.state === 'stopped' ? t('停止') : t('失敗'));
      return h(Box, {key: x.tag, flexDirection: 'column'},
        h(Line, null, mark + ' ' + c.bold(x.tag) + c.faint(' ' + (x.type || '')) + ' ' + x.title + c.faint('  ' + elapsed((working ? Date.now() : x.ended) - x.started)) + '  ' + what),
        working && last && !compact ? h(Line, {color: DIM}, '   ' + last) : null);
    }),
    ...(list.length > shown.length ? [h(Text, {key: 'more', color: DIM}, t('… ほか {n} 件（/agents で一覧）', {n: list.length - shown.length}))] : []));
}
// The account add's own screen: while it is up, the live region is this panel (plus the
// composer / menus that answer it) instead of the chat's working rows — the questions and
// steps land here, and the chat above only keeps the outcome.
function AddScreen({f, W}) {
  return h(Box, {flexDirection: 'column', marginTop: 1},
    h(Box, {flexDirection: 'column', borderStyle: 'round', borderColor: ACCENT, paddingX: 1, width: W},
      h(Line, null, c.accent(c.bold(t('アカウントを追加')))),
      h(Text, null, ' '),
      // Screen lines wrap whole: a URL or long error was cut at the screen edge (r3 R9).
      ...(f.lines || []).map((l, i) => h(Text, {key: i, wrap: 'wrap'}, l)),
      f.busy ? h(Line, {key: 'busy', color: DIM}, f.busy + '…') : null));
}
function Live({s, ctrl, W}) {
  if (s.addFlow) return h(Box, {flexDirection: 'column', width: W},
    h(AddScreen, {f: s.addFlow, W}),
    s.approval ? h(Approval, {a: s.approval, ctrl, W}) : s.menu ? h(Menu, {m: s.menu, W}) : h(Prompt, {s, W}),
    h(Footer, {s, ctrl, W}));
  const preview = ctrl.previewRow(), todos = s.todos || [], open = todos.filter(t => t.status !== 'completed');
  return h(Box, {flexDirection: 'column', width: W},
    // A table still being written: set as a whole here, printed above once it ends.
    ...(preview?.table || []).slice(-Math.max(4, (process.stdout.rows || 30) - 16)).map((r, i) => h(Row, {key: 'tb' + i, prefix: (preview.first && i === 0 ? '⏺ ' : '  ') + r.prefix, text: r.text, code: true})),
    preview?.row ? h(Row, {key: 'pv', prefix: (preview.first && !preview.table?.length ? '⏺ ' : '  ') + preview.row.prefix, text: preview.row.text, code: preview.row.code}) : null,
    s.bangRunning && !s.approval ? h(Running, {r: s.bangRunning}) : null,
    s.running && !s.approval ? h(Running, {r: s.running}) : null,
    s.busy && !s.running && !s.approval ? h(Working, {s, W}) : null,
    s.busy && s.focus?.status === 'running' && !s.approval ? h(Text, {color: DIM}, t('Focus {round}/{max} · 根拠あり {met}/{total}', {round: s.focus.round, max: s.focus.maxRounds, met: (s.focus.criteria || []).filter(c => c.status === 'met').length, total: (s.focus.criteria || []).length})) : null,
    // The queue line names each item's first line and says when an item has more lines;
    // over the width it drops WHOLE items and counts them — a mid-item cut made a queued
    // text look shorter and different from what will be sent (first B9, deep r2 R2-10).
    s.queue?.length && !s.approval ? h(Box, {marginTop: 1, paddingX: 2}, h(Text, {color: DIM}, t('キュー {n} 件: {first}', {n: s.queue.length, first: (() => { const items = s.queue.map(q => { const ls = String(q).split('\n'); return ls[0] + (ls.length > 1 ? t('（全 {n} 行）', {n: ls.length}) : ''); }); let out = '', usedN = 0; for (const it of items) { const trial = out ? out + ' · ' + it : it; if (usedN && width(trial) > 80) break; out = trial; usedN++; } return usedN < items.length ? out + ' ' + t('  … ほか {n} 件', {n: items.length - usedN}).trim() : out; })()}))) : null,
    // Eight todo rows at most, and the rest are counted: silently dropping rows past 8
    // hid exactly the tail of a long plan (first B8).
    todos.length && open.length && !s.approval ? h(Box, {flexDirection: 'column', marginTop: 1}, ...todos.slice(0, 8).map((t, i) => h(Text, {key: i, wrap: 'truncate-end'}, '  ' + todoLine(t))), ...(todos.length > 8 ? [h(Text, {key: 'more', color: DIM}, t('  … ほか {n} 件', {n: todos.length - 8}) + ' (/todos)')] : [])) : null,
    h(AgentCards, {words: s.agentWords, list: (s.agents || []).filter(x => x.state === 'working' || Date.now() - x.ended < 8000)}),
    s.approval || s.question || s.menu || s.limitInput ? null : h(Chips, {list: s.attachments, W}),
    s.approval ? h(Approval, {a: s.approval, ctrl, W}) : s.question ? h(Question, {q: s.question, W}) : s.menu ? h(Menu, {m: s.menu, W}) : s.limitInput ? h(Box, {flexDirection: 'column'},
      h(Text, {color: ACCENT}, s.limitInput.label || (s.limitInput.key === 'concurrent' ? t('同時に動かすエージェント数') : t('1タスクで起動できる合計数'))),
      h(Prompt, {s: {...s, text: s.limitInput.text, pos: s.limitInput.text.length, busy: false, reasonFor: null}, W}),
      // A flash (a validation error) keeps the enter/esc keys beside it: with the flash
      // alone the way to confirm or go back vanished (deep r3 R19).
      h(Text, {color: DIM}, s.flash ? s.flash + ' · ' + t('enter で確定 · esc で戻る') : (s.limitInput.hint || t('0 は無制限')) + ' · ' + t('enter で確定 · esc で戻る'))) : h(Prompt, {s, W}),
    s.approval || s.question || s.menu || s.limitInput ? null : h(Footer, {s, ctrl, W}));
}

const RESIZE_SETTLE_MS = 150; // a drag sends many sizes; redraw once it stops
function Root({ctrl}) {
  const s = useSyncExternalStore(ctrl.subscribe, ctrl.get);
  const {columns, rows} = useWindowSize(), W = Math.max(20, (columns || 100) - 1); // a floor wider than the terminal overflowed it
  useEffect(() => { ctrl.trace('size ' + columns + 'x' + rows); }, [columns, rows]);
  // No mouse reporting (?1000h / ?1006h): with it on, the terminal hands every mouse event
  // to muser — the wheel no longer scrolls back through the output (the history lives in the
  // terminal's scrollback) and selecting text needs Shift. Right-click paste and
  // Ctrl+Shift+V are the terminal's own (Windows Terminal, conhost) and arrive as a paste.
  useInput((input, key) => ctrl.key(input, key));
  usePaste(text => ctrl.paste(text));
  useEffect(() => { if (s.clearCount) process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); }, [s.clearCount]);
  // A resize redraws everything at the new width once it settles. The terminal rewraps what is
  // already on screen, so the frame Ink erases by line count no longer matches what is there:
  // narrowing left copies of the input box behind, and widening laid those out as boxes again
  // (seen in Windows Terminal). The clear goes out before the state change: Ink draws on
  // commit, before effects run, so a clear from an effect wiped the fresh frame for good.
  const [redraws, setRedraws] = useState(0), sized = useRef(null);
  useEffect(() => {
    const was = sized.current; sized.current = columns + 'x' + rows;
    if (was === null || was === sized.current || !process.stdout.isTTY) return;
    const id = setTimeout(() => { process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); setRedraws(n => n + 1); }, RESIZE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [columns, rows]);
  return h(React.Fragment, null,
    h(Static, {key: s.clearCount + ':' + redraws, items: s.entries}, e => h(Entry, {key: e.id, e, ctrl, W})),
    h(Live, {s, ctrl, W}));
}

export {Entry, Live, Question};

export function run({agent, museName, version, initial, connect, onReload, remoteCtrl}) {
  let app;
  // Client mode (remote/DESIGN.md step 4): the conversation lives in the
  // resident server and remoteCtrl (src/ui/remote-controller.mjs) already
  // mirrors it; the view renders it exactly like a local Controller. The
  // facade stands in for the agent everywhere the view reads one.
  if (remoteCtrl) agent = remoteCtrl.agent;
  const ctrl = remoteCtrl || new Controller({agent, museName, version, onExit: async () => {
    app.unmount();
    const id = agent.session.turns && agent.client.status !== 'demo' ? agent.session.id.slice(0, 8) : '';
    if (id) process.stdout.write(c.faint(t('再開するには: muser resume {id}', {id})) + '\n');
    // Leaving mid-turn only closed the sockets: Muse went on working for nobody.
    if (agent.busy && agent.cancelAll) { process.stdout.write(c.faint(t('Muse の作業を止めています…')) + '\n'); await agent.cancelAll().catch(() => {}); }
    agent.close(); setTimeout(() => process.exit(0), 50);
  }, onReload: onReload ? () => {
    // /reload: hand the terminal to a fresh process on the current code (it resumes this
    // session), then leave. Closing first frees this window's node slot for it.
    app.unmount();
    let ok = true;
    try { onReload(); } catch { ok = false; }
    if (!ok) { const id = agent.session.turns ? agent.session.id.slice(0, 8) : ''; if (id) process.stdout.write(c.faint(t('再開するには: muser resume {id}', {id})) + '\n'); }
    agent.close(); setTimeout(() => process.exit(0), 50);
  } : undefined});
  if (remoteCtrl) {
    // Detach, never close: /exit and /reload reach the RemoteController's own
    // callbacks; unmount first so the terminal is handed back cleanly.
    const userExit = remoteCtrl.onExit, userReload = remoteCtrl.onReload;
    remoteCtrl.onExit = async () => { try { app?.unmount(); } catch {} if (userExit) await userExit(); else setTimeout(() => process.exit(0), 50); };
    remoteCtrl.onReload = userReload ? () => { try { app?.unmount(); } catch {} userReload(); } : undefined;
  }
  // What this window is doing, live, for `muser status` and other agents (src/window-status.js).
  // A client window's conversation is the server's, which `muser status` lists already; the
  // demo talks to no Muse.
  if (!remoteCtrl && agent.client?.status !== 'demo') { try { new (require('../window-status.js').WindowStatus)({ctrl, agent}).start(); } catch {} }
  // An exception nothing caught ends muser: leave a report (src/crash.js) and the way back into the
  // chat instead of only a stack trace.
  const crashed = e => {
    let file = '';
    try { file = require('../crash.js').write({version, error: e, state: ctrl.s, trail: ctrl.trail}); } catch {}
    try { app?.unmount(); } catch {}
    const id = agent.session.turns && agent.client.status !== 'demo' ? agent.session.id.slice(0, 8) : '';
    process.stderr.write('\n' + String(e?.stack || e) + '\n\n' + t('muser が予期しないエラーで止まりました。') + '\n' +
      (file ? t('記録を保存しました（入力や会話の中身は含みません）: {file}', {file}) + '\n' : '') +
      // In client mode plain `muser resume` starts a LOCAL session instead of rejoining
      // the server's: the hint names the client form (third M22).
      (id ? (remoteCtrl ? t('続きから再開するには: muser --client resume {id}', {id}) : t('続きから再開するには: muser resume {id}', {id})) + '\n' : ''));
    // A crash mid-turn stops the work like a normal exit does, instead of leaving Muse
    // running for nobody (third M23). Bounded: a wedged cancel must not hang the exit.
    const finish = () => { try { agent.close(); } catch {} process.exit(1); };
    if (agent.busy && agent.cancelAll) { let done = false; const once = () => { if (!done) { done = true; finish(); } }; setTimeout(once, 2500); try { Promise.resolve(agent.cancelAll()).then(once, once); } catch { once(); } }
    else finish();
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  // Start on a clean screen, like Claude Code: the shell prompt and the onboarding output go.
  // The clear goes into Ink's first write, inside its synchronized update (ESC[?2026h … l), so
  // the splash turns into the first frame at once. Written on its own it came ~33 ms (one
  // throttled Ink frame) before that frame: a black flash.
  if (process.stdout.isTTY) {
    const CLEAR = '\x1b[2J\x1b[3J\x1b[H', original = process.stdout.write;
    process.stdout.write = function (chunk, ...rest) {
      process.stdout.write = original;
      const s = String(chunk);
      return original.call(this, s.startsWith('\x1b[?2026h') ? s + CLEAR : CLEAR + s, ...rest);
    };
  }
  app = render(h(Root, {ctrl}), {exitOnCtrlC: false, incrementalRendering: true, maxFps: 30, kittyKeyboard: {mode: require('../settings.js').switchValue('kitty') ? 'auto' : 'disabled'}, patchConsole: true});
  // Drawn before Muse is reached: connect behind the screen; a message sent meanwhile waits for
  // it (runTurn awaits ensureConnected). Then learn Muse's name for next time.
  if (connect) connect().then(name => { if (name && name !== ctrl.museName) { ctrl.museName = name; ctrl.set({}); } }).catch(() => {});
  if (agent.session.turns) ctrl.showResumed(agent.session, {startup: true}); // muser resume / -c
  if (initial) ctrl.submit(initial);
  if (agent.client.status !== 'demo') ctrl.checkUpdate(); // right away, in the background (src/update.js)
  setTimeout(() => ctrl.refreshPlan(), 1500); // after the first frame: loading the login cookies blocks briefly
  return app;
}
