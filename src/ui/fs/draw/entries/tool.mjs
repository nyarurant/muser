// Draws the 'tool' entry: a tool call block.
// Mirrors view.mjs Tool({call, cwd, W}): a column with marginBottom 1 whose
// root has no explicit width, so it lays out at cols (= W + 1). The header is
// a Line (truncate-end at cols); each result block hangs under a dim
// '  ⎿  ' marker — 5 cells normally, but the marker can shrink under yoga
// flex when a block overflows (see resText / resBlock below). A diff block
// is a direct
// child of the column (drawDiff, no marker). Returns null when there is no
// call record to draw (the caller then falls back to React).
import {createRequire} from 'node:module';
import {c, width, hanging, truncateEnd, wrapInk, toolTitle, glyphFor, relPath} from '../primitives.mjs';
import {drawDiff} from '../diff.mjs';
const require = createRequire(import.meta.url);
const {truncate} = require('../../../../tui/term.js');
const {t} = require('../../../../i18n.js');

const MARK = c.faint('  ⎿  ');

// view.mjs todoLine, same construction.
const todoLine = td => {
  const content = String(td?.content ?? '');
  if (td?.status === 'completed') return c.faint('☒ ' + c.strike(content));
  if (td?.status === 'in_progress') return c.accent('◼ ') + c.bold(content);
  return c.gray('☐ ') + content;
};

export function drawTool(e, ctx) {
  const call = e?.call;
  if (!call) return null;
  const {W, cols} = ctx;
  const v = call.view || {};
  const cwd = ctx.ctrl?.agent?.cwd;
  const rel = p => (typeof cwd === 'string' && cwd ? relPath(cwd, p) : String(p ?? ''));
  // One result block (view.mjs res()): the first chunk carries the marker,
  // later chunks and wrapped continuations sit under the marker's indent.
  // A chunk is {wrap: styledText} (a Text, wrap: wrap) or {trunc: styledText}
  // (a Line, truncate-end).
  //
  // The marker is NOT flexShrink: 0 in view.mjs (unlike Row's prefix), so
  // when a block's measured basis overflows the row, Ink/yoga shrinks the
  // marker and widens the content (probed 2026-11-06 at cols 31..201):
  //  - a lone wrap Text keeps wrapping at cols - 5, but its indent is
  //    round(5 - overflow * 5 / (5 + basis)) — 4 at cols <= 44 when the text
  //    wraps to a full-cols line in the measure pass, else 5;
  //  - a column block (Lines, or a wrap head plus Lines) that holds a line
  //    wider than cols - 5 lays out at cols - 4 instead, with the same
  //    indent rule (its basis is the widest child: a Line claims
  //    min(its width, cols), a wrap child its widest measured line).
  // basis = the widest line of the text wrapped at cols (Ink's measure).
  const basisOf = styled => wrapInk(styled, cols).reduce((m, l) => Math.max(m, width(l)), 0);
  const indentFor = basis => Math.round(5 - (Math.max(0, 5 + basis - cols) * 5) / (5 + basis));
  const markAt = left => (left < 5 ? c.faint('  ⎿ ') : MARK);
  const resText = styled => {
    const left = indentFor(basisOf(styled));
    return hanging(markAt(left), styled, {width: left + cols - 5, wrapMode: 'wrap'});
  };
  const resBlock = chunks => {
    const basis = chunks.reduce((m, ch) => Math.max(m, ch.wrap !== undefined ? basisOf(ch.wrap) : Math.min(width(ch.trunc), cols)), 0);
    const wide = basis > cols - 5;
    const colW = wide ? cols - 4 : cols - 5;
    const left = wide ? indentFor(basis) : 5;
    const lines = [];
    let first = true;
    for (const ch of chunks) {
      const pre = first ? markAt(left) : ' '.repeat(left);
      if (ch.wrap !== undefined) lines.push(...hanging(pre, ch.wrap, {width: left + colW, wrapMode: 'wrap'}));
      else lines.push(pre + truncateEnd(ch.trunc, colW));
      first = false;
    }
    return lines;
  };

  if (call.command === 'todo.write' && call.ok) {
    const out = [c.green('⏺ ') + c.bold('Todo')];
    (v.todos || []).forEach((td, i) => {
      // The marker Text is dim even when it is only spaces (i > 0). A row
      // whose text is wider than cols - 5 overflows its row box (the text
      // is a bare Text here, no flexShrink wrapper): Ink then lays the
      // row out at indent 4 with the text wrapping at cols - 4, at every
      // width (probed 2026-11-06). Shorter rows keep indent 5 / cols - 5.
      const line = todoLine(td);
      if (width(line) > cols - 5) out.push(...hanging(i ? c.faint('    ') : c.faint('  ⎿ '), line, {width: cols, wrapMode: 'wrap'}));
      else out.push(...hanging(i ? c.faint('     ') : MARK, line, {width: cols, wrapMode: 'wrap'}));
    });
    out.push('');
    return out;
  }

  const mark = call.declined ? c.yellow : !call.ok || (call.command === 'system.run' && v.exit) ? c.red : c.green;
  const title = toolTitle(call);
  // The summary is cut at its END (wave 6): keeping the tail (tailText) hid
  // the command's verb — 'npm test' read as '…test' — which is the part that
  // says what the call does. The header Line truncates at cols anyway.
  const sumShown = truncateEnd(String(call.summary || ''), Math.max(8, W - width(title) - 5));
  const out = [truncateEnd(mark(glyphFor(call) + ' ') + c.bold(title) + c.gray('(' + sumShown + ')'), cols)];

  if (!call.ok) {
    const errText = String(call.error || '');
    const reason = errText.match(/declined this: ([\s\S]*?)(?:\. Do not retry|$)/)?.[1];
    const msg = call.declined
      ? t('断りました') + (reason ? t('（理由: {reason}）', {reason: truncate(reason, 60)}) : errText.includes('declined this:') ? t('（理由を Muse に伝えました）') : '')
      : t('エラー: {error}', {error: errText});
    out.push(...resText(call.declined ? c.yellow(msg) : c.red(msg)));
  } else if (v.background && call.command === 'system.run') {
    const head = c.accent('⚙ ') + c.gray(t('バックグラウンドで実行中') + ' ') + c.bold(v.background) + c.faint('   ' + t('/bg で確認'));
    out.push(...resBlock([{wrap: head}, ...(v.tail || []).filter(l => l.trim()).map(l => ({trunc: c.faint(l)}))]));
  } else if (call.command === 'shell.output') {
    out.push(...resText(c.gray(v.background + ': ' + t('{n} 行', {n: v.lines}) + (v.running ? t('（実行中）') : t('（終了）')))));
  } else if (call.command === 'shell.kill') {
    out.push(...resText(c.gray(t('{id} を停止', {id: v.background}))));
  } else if (call.command === 'shell.list') {
    out.push(...resText(c.gray(t('{n} 個', {n: v.count}))));
  } else if (call.kind === 'agent') {
    out.push(...resText(c.gray(v.tag ? t('エージェント {tag}{type} を起動', {tag: v.tag, type: v.type ? '（' + v.type + '）' : ''}) : (v.agents || []).join(' · '))));
  } else if (call.kind === 'mcp') {
    const lines = String(v.text || '').trim().split('\n').filter(l => l.trim());
    const shown = lines.length ? lines.slice(0, 4) : [t('(結果なし)')];
    out.push(...resBlock([
      ...shown.map(l => ({trunc: c.gray(l)})),
      ...(lines.length > 4 ? [{trunc: c.faint(t('… ほか {n} 行', {n: lines.length - 4}))}] : []),
    ]));
  } else if (call.command === 'code.read') {
    out.push(...resText(c.gray(t('{n} 行を読み込み', {n: v.lines}))));
  } else if (call.command === 'code.grep' || call.command === 'code.glob') {
    out.push(...resText(c.gray(call.command === 'code.grep' ? t('{n} 件ヒット', {n: v.count}) : t('{n} ファイル', {n: v.count}))));
  } else if (v.files) {
    v.files.forEach(f => {
      out.push(...resText(c.bold(rel(f.path)) + '  ' + c.green('+' + (f.added || 0)) + ' ' + c.red('-' + (f.removed || 0))));
      out.push(...drawDiff(f.diff, W, 24, f.diffOmitted || 0));
    });
  } else if (v.diff) {
    const vd = Array.isArray(v.diff) ? v.diff : [];
    let added = 0, removed = 0;
    if (typeof v.diffAdded === 'number' && typeof v.diffRemoved === 'number') { added = v.diffAdded; removed = v.diffRemoved; }
    else for (const d of vd) { if (d?.t === '+') added++; else if (d?.t === '-') removed++; }
    out.push(...resText(c.green('+' + added) + ' ' + c.red('-' + removed)));
    out.push(...drawDiff(vd, W, 30, v.diffOmitted || 0));
  } else if (call.command === 'system.run') {
    const tail = (v.tail || []).filter(l => l.trim());
    out.push(...resBlock([
      ...(tail.length ? tail : [t('(出力なし)')]).map(l => ({trunc: c.gray(l)})),
      ...(call.outputLines > tail.length ? [{wrap: c.faint(t('… ほか {n} 行（/output で全文）', {n: call.outputLines - tail.length}))}] : []),
      ...(v.exit ? [{wrap: c.red(v.killed === 'timeout' ? t('タイムアウト') : v.killed === 'cancelled' ? t('中断しました') : 'exit ' + v.exit)}] : []),
    ]));
  }
  // Mirrors view.mjs Tool: the 想定外 line under the result, only on a miss.
  if (v.expect && v.expect.matched === false) out.push(...resText(c.yellow(t('想定外: 予想 {expected} / 実際 {actual}', {expected: v.expect.expected, actual: v.expect.actual}))));
  out.push('');
  return out;
}
