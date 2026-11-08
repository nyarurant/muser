// Draws the live approval block (mirrors view.mjs Approval).
// Diffs go through ../diff.mjs; when it returns null the whole block returns
// null so the caller falls back to the React drawing.
import {createRequire} from 'node:module';
import {c, width, wrapInk, truncateEnd, roundBox, relPath} from '../primitives.mjs';
import {drawDiff} from '../diff.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

const GOLD = '#e6be64';
const TITLES = {'shell.output': 'Output', 'shell.kill': 'Kill', 'shell.list': 'Shells', 'code.read': 'Read', 'code.grep': 'Search', 'code.glob': 'Glob', 'code.edit': 'Update', 'code.write': 'Write', 'code.apply_patch': 'Patch', 'todo.write': 'Todo', 'skill.read': 'Skill'};
// view.mjs title(), same code.
const title = call => call.user ? '! ' + (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.kind === 'agent' ? (call.command === 'agent.spawn' ? 'Agent' : 'Wait') : call.kind === 'mcp' ? 'MCP' : call.command === 'system.run' ? (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.command === 'code.write' && call.view?.created ? 'Create' : TITLES[call.command] || call.command;
// Ink trims trailing spaces off every rendered line (unless the line ends
// with an escape sequence); plain rows built by hand need the same trim.
const trimLine = l => (l.endsWith(' ') ? l.replace(/ +$/, '') : l);

export function drawApproval(s, ctx) {
  const a = s?.approval;
  if (!a) return null;
  const call = a.call;
  const W = ctx.W;
  const rows = ctx?.rows ?? (process.stdout.rows || 30);
  const inner = W - 4;
  const rws = [];
  // The warning lines are part of the block's fixed part (below), so they
  // are built once, here, and pushed after the preview as before.
  const warnLines = [];
  if (a.outside) warnLines.push(...wrapInk(c.yellow(t('⚠ 作業フォルダーの外への書き込みです')), inner));
  if (a.loreGrave) warnLines.push(...wrapInk(c.yellow(t('⚠ 言い伝え（墓標）: この書き込みは、以前わざわざ消されたコードに似ています。消した理由が今も当てはまるなら、書き戻さないでください（詳しくは /lore）')), inner));
  if (call.tellClaim) warnLines.push(...wrapInk(c.yellow(t('このファイルは {name} が担当中です', {name: call.tellClaim.name})), inner));
  // Small terminal (wave 7): the preview's line budget is what remains of
  // the screen after the fixed part — the leading blank, the box borders,
  // the title, the question, the options, the keys hint and the warnings —
  // so those stay on screen and the preview is what shrinks. Ordinary
  // heights keep the per-branch budgets below, exactly as before.
  const small = rows < 20;
  const askText = call.kind === 'exec' || call.kind === 'mcp' ? t('実行していい？') : t('この変更をしていい？');
  const optLines = (a.options || []).reduce((n, o, i) => n + wrapInk(i === a.index ? c.accent('❯ ') + c.bold((i + 1) + '. ' + o.label) : '  ' + (i + 1) + '. ' + o.label, inner).length, 0);
  const fixed = 1 + 2 + 1 + 1 + 1 + wrapInk(c.bold(askText), inner).length + optLines + 1 + warnLines.length;
  const lineBudget = small ? Math.max(0, rows - fixed) : 0;
  if (call.kind === 'mcp') {
    const server = call.mcp?.server || '', tool = call.mcp?.tool || '';
    if (W < 44) {
      rws.push(truncateEnd(c.gray(t('サーバー ')) + server, inner));
      rws.push(truncateEnd(c.gray(t('   ツール ').trimStart()) + c.bold(tool), inner));
    } else {
      rws.push(truncateEnd(c.gray(t('サーバー ')) + server + c.gray(t('   ツール ')) + c.bold(tool), inner));
    }
    const entries = Object.entries(call.params || {});
    const serverLines = W < 44 ? 2 : 1;
    const shown = small ? entries.slice(0, Math.max(0, Math.min(12, lineBudget - serverLines - (entries.length > 1 ? 1 : 0)))) : entries.slice(0, 12);
    const each = small ? Math.max(8, Math.floor((W - 6) * Math.max(0, lineBudget - serverLines) / Math.max(1, shown.length))) : Math.max(24, Math.min(400, Math.floor((W - 6) * Math.max(4, rows - 16) / Math.max(1, shown.length))));
    for (const [k, v] of shown) {
      const str = String(typeof v === 'string' ? v : JSON.stringify(v));
      rws.push(...wrapInk(c.faint(k + ': ') + str.slice(0, each) + (str.length > each ? c.faint(t(' … ほか {n} 文字', {n: str.length - each})) : ''), inner));
    }
    if (entries.length > shown.length) rws.push(...wrapInk(c.yellow(t('… ほか {n} 個の引数', {n: entries.length - shown.length})), inner));
  } else if (call.kind === 'exec') {
    const cmd = String(call.params?.command ?? ''), cmdLines = cmd.split('\n');
    const lineCap = small ? Math.max(0, Math.min(12, lineBudget - 1)) : 12;
    const budget = small ? (W - 6) * Math.max(0, lineBudget - 1) : Math.max(200, (W - 6) * Math.max(4, rows - 18));
    let used = 0, shownLines = 0, partialChars = 0;
    for (const l of cmdLines.slice(0, lineCap)) {
      if (used >= budget) break;
      const part = l.length > budget - used ? l.slice(0, budget - used) : l;
      rws.push(...wrapInk(part, inner)); used += part.length; shownLines++; partialChars += l.length - part.length;
    }
    const hiddenLines = cmdLines.length - shownLines;
    if (hiddenLines > 0 && partialChars > 0) rws.push(...wrapInk(c.yellow(t('… ほか {n} 行と {m} 文字（全部で {total} 行。見えていない行も実行されます）', {n: hiddenLines, m: partialChars, total: cmdLines.length})), inner));
    else if (hiddenLines > 0) rws.push(...wrapInk(c.yellow(t('… ほか {n} 行（全部で {total} 行。見えていない行も実行されます）', {n: hiddenLines, total: cmdLines.length})), inner));
    else if (partialChars > 0) rws.push(...wrapInk(c.yellow(t('… ほか {n} 文字（全部で {total} 文字。見えていない部分も実行されます）', {n: partialChars, total: cmd.length})), inner));
    // When anything was cut, the command's TAIL is shown too (wave 6): the
    // dangerous part of a command — a trailing '; rm …', a final redirect —
    // sits at the end, exactly what a head-only preview hid while asking
    // for approval. The end of a partially shown line comes first, then
    // the last up-to-3 hidden lines.
    if ((hiddenLines > 0 || partialChars > 0) && (!small || lineBudget >= 5)) {
      const tail = [];
      if (partialChars > 0 && shownLines > 0) tail.push('…' + cmdLines[shownLines - 1].slice(-Math.max(10, inner - 1)));
      for (const l of cmdLines.slice(shownLines).slice(-3)) tail.push(l);
      if (tail.length) {
        rws.push(...wrapInk(c.faint(t('末尾:')), inner));
        for (const l of tail) rws.push(...wrapInk(l, inner));
      }
    }
    if (call.params?.cwd) rws.push(...wrapInk(c.gray(t('場所: {cwd}', {cwd: call.params.cwd})), inner));
  } else if (a.preview?.error) {
    rws.push(...wrapInk(c.red(t('プレビューできません: {error}', {error: a.preview.error})), inner));
  } else if (a.preview?.files) {
    const room = small ? Math.max(0, lineBudget - (a.preview.files.length > 1 ? 1 : 0)) : Math.max(8, rows - 16), name = f => relPath(ctx?.ctrl?.agent?.cwd, f.path);
    let used = 0, i = 0;
    for (const f of a.preview.files) {
      if (used + 4 > room) break;
      const max = Math.min(14, room - used - 2), fd = Array.isArray(f.diff) ? f.diff : [];
      rws.push(truncateEnd(c.bold(name(f)) + c.faint('  ' + f.op), inner));
      const d = drawDiff(fd, W - 4, max);
      if (d === null) return null;
      rws.push(...d);
      used += 2 + Math.min(fd.length, max); i++;
    }
    const rest = a.preview.files.slice(i);
    if (rest.length && (!small || lineBudget > 0)) {
      const allNames = rest.map(f => name(f) + ' (' + f.op + ')'), budget = small ? (W - 6) * Math.max(1, lineBudget) : (W - 6) * 3;
      let names = allNames.join(', '), omitted = 0;
      if (width(names) > budget) {
        const kept = [];
        for (const nm of allNames) { const trial = [...kept, nm].join(', '); if (width(trial) + width(' … ほか ' + (allNames.length - kept.length - 1) + ' ファイル') > budget) break; kept.push(nm); }
        omitted = allNames.length - kept.length; names = kept.join(', ');
      }
      rws.push(...wrapInk(c.yellow(t('… ほか {n} ファイル: {names}', {n: rest.length, names}) + (omitted ? ' ' + t('… ほか {n} ファイル', {n: omitted}) : '')), inner));
    }
  } else if (a.preview?.diff) {
    // With no budget at all even the omission count gives way: the fixed
    // part (warnings, options, hint) is the whole screen already.
    const d = small && lineBudget <= 0 ? [] : drawDiff(Array.isArray(a.preview.diff) ? a.preview.diff : [], W - 4, small ? Math.max(0, lineBudget - 1) : Math.max(8, rows - 18));
    if (d === null) return null;
    rws.push(...d);
  }
  rws.push(...warnLines);
  const head = call.kind === 'exec' ? title(call) + t(' コマンド') : title(call);
  const content = [
    truncateEnd((call.agent && call.agent !== 'main' ? c.accent(t('[エージェント {agent}] ', {agent: call.agent})) : '') + c.yellow(c.bold(head)) + (call.kind === 'exec' ? '' : '  ' + (call.summary || '')), inner),
    '',
    ...rws,
    '',
    ...wrapInk(c.bold(askText), inner),
    ...(a.options || []).map((o, i) => wrapInk(i === a.index ? c.accent('❯ ') + c.bold((i + 1) + '. ' + o.label) : '  ' + (i + 1) + '. ' + o.label, inner)).flat(),
  ];
  // The keys hint is a child of the bordered box in view.mjs (the JSX closes
  // the box after it), so it wraps at the inner width, inside the border.
  content.push(...wrapInk(c.faint(t('  ↑↓ で選んで enter · 1-{n} · esc で断る', {n: (a.options || []).length})), inner));
  const out = [
    '',
    ...roundBox(content.map(l => ' ' + l), {width: W, borderColor: GOLD}),
  ];
  return out.map(trimLine);
}
