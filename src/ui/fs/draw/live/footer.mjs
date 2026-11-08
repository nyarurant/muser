// Draws the live footer.
// Mirrors view.mjs Footer (L653-765) exactly, branch by branch, in order:
// (1) @ mention list, (2) $ skill list, (3) '!' shell mode, (4) '/' command
// list, (5) the status lane. Layout notes (verified against renderToString
// in probes, 2026-11-06):
//  - the @ / $ / / lists live in a column Box with paddingX 2 inside Live's
//    width-W column, so their rows lay out at W - 4; a Line is truncate-end
//    at that width, a Text wraps there (wrapInk).
//  - the status lane is a row Box (paddingX 1, width W, justifyContent
//    space-between): the left Box is flexShrink 0 with marginRight 2 and
//    maxWidth floor(W / 2) when W < 48, the right Box is flexShrink 1 with a
//    truncate-end Text. Free space goes between the two halves (the gap);
//    when the right side does not fit it shrinks to the remaining width and
//    truncates. The left Text has no wrap prop, so a capped non-flash left
//    WRAPS (wrapInk) and the footer grows to two lines, the right side
//    staying on the first line; a capped flash left truncates instead.
//  - colours from Ink Text color props (DIM, ACCENT, the mode colour, the
//    flash gold) are hex() from primitives, the same pattern focus-row.mjs
//    uses; colours inside a row's text are the c.* spans view.mjs uses.
// t() is NOT exported by primitives.mjs, so it is required from i18n.js
// here (same createRequire pattern as primitives.mjs / prompt.mjs).
// switchValue comes from settings.js, the mention functions from
// mentions.js, COMMANDS from controller.mjs (an ESM import: controller has
// no top-level side effects and nothing in its tree imports view.mjs, so
// there is no cycle). No React / Ink imports; LF endings.
import {createRequire} from 'node:module';
import path from 'node:path';
import {c, width, pad, tailText, truncateMiddle, modeLabel, hex, truncateEnd, wrapInk, sgrState, sgrApply, sgrOpen} from '../primitives.mjs';
import {COMMANDS} from '../../../../ui/controller.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {switchValue} = require('../../../../settings.js');
const {fragmentAt: mentionAt, complete: mentionComplete, listDiag: mentionDiag, loading: mentionLoading} = require('../../../../mentions.js');

const ACCENT = '#b4a0ff', DIM = '#5f5f69', GRAY = '#8c8c96';
const DIMC = hex(DIM), ACCENTC = hex(ACCENT), GOLDC = hex('#e6be64');

// Ink's output stage trims trailing plain spaces off every rendered line; a
// trailing space survives only when the line ends with an escape sequence
// (same rule wrapInk applies). Pad spaces I add after a box's content are
// trailing once the right side is empty, so they go here.
const trimEnd = line => (line.endsWith(' ') ? line.replace(/ +$/, '') : line);

// The completion key hint: under 50 columns the long form was cut mid-word,
// so a short form that fits whole takes its place (view.mjs keyHint).
const keyHint = W => W < 50 ? t('↑↓ 選択 · enter/tab 補完') : t('   ↑↓ で選択 · enter / tab で補完').trim();

export function drawFooter(s, ctx) {
  const state = s || {};
  const ctrl = ctx?.ctrl || {};
  const W = ctx?.W ?? 40;
  const rows = ctx?.rows ?? 30;
  // Small terminal (wave 7): a completion window shrinks to the rows left
  // after the prompt box and the list's own hint / count lines, so the
  // selected row stays on screen. Ordinary heights keep the fixed windows.
  const winFor = legacy => rows >= 20 ? legacy : Math.max(1, Math.min(legacy, rows - 8));
  // Degenerate states (no text / no agent yet) must not throw: the live
  // area is drawn every frame, and a throw there takes the screen down.
  // Real states always carry text and an agent, so these fallbacks change
  // nothing for them.
  const text = String(state.text ?? '');
  const pos = typeof state.pos === 'number' ? state.pos : 0;
  const agent = ctrl.agent || {};
  const contentW = W - 4; // column Box paddingX 2 inside Live's width-W column
  // One Line (truncate-end, DIM) inside that column box.
  const dimLine = content => '  ' + truncateEnd(DIMC(content), contentW);
  // One wrapped Text (default wrap) inside that column box.
  const wrapLines = content => wrapInk(content, contentW).map(l => '  ' + l);

  const m = state.mode, color = m === 'bypass' ? '#f06e6e' : m === 'plan' ? '#78aaf0' : m === 'auto-edit' ? ACCENT : GRAY;
  const at = mentionAt(text, pos);
  if (at) {
    const list = mentionComplete(at.fragment, agent.cwd, 10000, () => ctrl.set({}));
    const diag = mentionDiag();
    const diagNote = (diag.error || diag.source === 'walk' || diag.source === 'none')
      ? t('ファイル一覧: {source}{error}', {source: diag.source, error: diag.error ? '（' + diag.error + '）' : ''}) : null;
    if (!list.length) {
      if (mentionLoading(agent.cwd)) return wrapLines(DIMC(t('ファイルを探しています…'))).map(trimEnd);
      return [
        ...wrapLines(DIMC(diag.source === 'none' ? t('ファイル一覧を取得できませんでした（{error}）', {error: diag.error}) : t('一致するファイルがありません'))),
        ...(diagNote ? wrapLines(DIMC(diagNote)) : []),
      ].map(trimEnd);
    }
    const sel = ctrl.atIndex(at.fragment, list.length);
    const WIN = winFor(6), start = Math.max(0, Math.min(sel - Math.floor(WIN / 2), Math.max(0, list.length - WIN)));
    const shown = list.slice(start, start + WIN);
    const out = [];
    if (start > 0) out.push(dimLine('  ' + t('↑ ほか {n} 件', {n: start})));
    for (let i = 0; i < shown.length; i++) {
      const f = shown[i];
      out.push('  ' + truncateEnd(start + i === sel ? c.accent('◇ ' + tailText(f, Math.max(10, W - 6))) : c.gray('  ' + tailText(f, Math.max(10, W - 6))), contentW));
    }
    if (start + WIN < list.length) out.push(dimLine('  ' + t('↓ ほか {n} 件', {n: list.length - start - WIN})));
    out.push(dimLine('  ' + t('全 {total} 件中 {n} 件目', {total: list.length, n: sel + 1})));
    out.push(dimLine('  ' + keyHint(W)));
    if (diagNote) out.push(...wrapLines(DIMC(diagNote)));
    return out.map(trimEnd);
  }
  const dctx = typeof ctrl.dollarContext === 'function' ? ctrl.dollarContext(text, pos) : null;
  if (dctx) {
    if (!dctx.list.length) return ['  ' + truncateEnd(DIMC(dctx.noSkills ? t('スキルがありません（/skills）') : t('一致するスキルがありません')), contentW)].map(trimEnd);
    const sel = ctrl.dollarIndex(dctx.frag.fragment, dctx.list.length);
    const WIN = winFor(6), start = Math.max(0, Math.min(sel - Math.floor(WIN / 2), Math.max(0, dctx.list.length - WIN)));
    const shown = dctx.list.slice(start, start + WIN);
    const out = [];
    if (start > 0) out.push(dimLine('  ' + t('↑ ほか {n} 件', {n: start})));
    for (let i = 0; i < shown.length; i++) {
      const sk = shown[i];
      out.push('  ' + truncateEnd(start + i === sel ? c.accent('❯ ' + pad('$' + sk.name, 16)) + c.gray(sk.description || '') : '  ' + c.gray(pad('$' + sk.name, 16)) + c.faint(sk.description || ''), contentW));
    }
    if (start + WIN < dctx.list.length) out.push(dimLine('  ' + t('↓ ほか {n} 件', {n: dctx.list.length - start - WIN})));
    out.push(dimLine('  ' + keyHint(W)));
    return out.map(trimEnd);
  }
  if (text.trimStart().startsWith('!')) return [' ' + truncateEnd(c.yellow(t('! シェルモード')) + (W < 44 ? c.faint(' PowerShell') : c.faint(switchValue('bangAutoSend') ? t('   PowerShell で実行 · 終わったら出力を Muse へ') : t('   PowerShell で実行 · 出力は次のメッセージで Muse へ'))), W - 2)].map(trimEnd);
  if (text.startsWith('/') && !text.includes(' ')) {
    const list = COMMANDS.filter(([n]) => n.startsWith(text));
    const sel = ctrl.slashIndex(text, list.length);
    const WIN = winFor(7), start = Math.max(0, Math.min(sel - Math.floor(WIN / 2), Math.max(0, list.length - WIN)));
    const shown = list.slice(start, start + WIN);
    const out = [];
    if (start > 0) out.push(dimLine('  ' + t('↑ ほか {n} 件', {n: start})));
    for (let i = 0; i < shown.length; i++) {
      const [n, d] = shown[i];
      if (start + i === sel) out.push(...wrapLines(c.accent('❯ ' + pad(n, 14)) + c.gray(t(d))));
      else out.push('  ' + truncateEnd('  ' + c.gray(pad(n, 14)) + c.faint(t(d)), contentW));
    }
    if (start + WIN < list.length) out.push(dimLine('  ' + t('↓ ほか {n} 件', {n: list.length - start - WIN})));
    if (list.length) out.push(dimLine('  ' + keyHint(W)));
    else out.push('  ' + truncateEnd(ACCENTC(t('一致するコマンドがありません')), contentW));
    return out.map(trimEnd);
  }
  // The status lane, element by element (/settings). The lane is cut at its
  // END when the screen is narrow, so what matters most goes FIRST.
  const lane = [], slotNo = agent.nodeSlot?.slot;
  if (state.account?.label) lane.push(state.account.label);
  if (state.accountReserved) lane.push(t('→ {label} に切替予定', {label: state.accountReserved}));
  if (switchValue('footerUsage') && state.plan?.percentUsed != null) lane.push(t('週 {n}%', {n: state.plan.percentUsed}));
  if (switchValue('footerDevice')) lane.push(agent.constructor?.DEVICE + (switchValue('footerSlot') && slotNo ? ' ' + t('窓 {n}', {n: slotNo}) : ''));
  else if (switchValue('footerSlot') && slotNo) lane.push(t('窓 {n}', {n: slotNo}));
  if (switchValue('footerCwd') && agent.cwd) lane.push(path.basename(agent.cwd));
  if (switchValue('footerName')) lane.push(ctrl.museName);
  if (switchValue('footerSession') && agent.session?.turns && agent.client?.status !== 'demo') lane.push(agent.session.id.slice(0, 8));
  if (switchValue('footerVersion')) lane.push('v' + ctrl.version);
  if (switchValue('footerClock')) { const d = new Date(); lane.push(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0')); }
  const modeText = (m === 'default' ? '' : '⏵⏵ ') + modeLabel(m), hint = t('   shift+tab で切替');
  const running = (state.shells || []).filter(x => x.running).length;
  // The right side is built from named segments so the status dot can be
  // protected at narrow widths (wave 6, at the cut below): the joined
  // string is still cut at its end — the lane's low-priority items go
  // first, as the lane comment above orders them — but when the segments
  // BEFORE the dot (login / running / update) would fill the whole box,
  // the cut erased the dot and the whole lane with it.
  let loginSeg = state.loginNeeded ? c.red(W < 48 ? t('ログインが必要（/login）  ').trimEnd() + ' ' : t('ログインが必要（/login）  ')) : '';
  const runningSeg = running ? c.accent('⚙ ' + t('{n} 実行中', {n: running}) + '   ') : '';
  const updateSeg = state.update?.checking ? c.faint(t('更新を確認中…') + '   ') : state.update?.latest ? c.accent(W < 44 ? '⬆ v' + state.update.latest + ' /update   ' : '⬆ v' + state.update.latest + ' · /update   ') : '';
  const dotSeg = (state.deviceOk ? c.green('● ') : c.red('○ ')) + c.faint(lane.join(' · '));
  let dropUpdate = false, dropRunning = false;
  const buildRight = () => (loginSeg + (dropRunning ? '' : runningSeg) + (dropUpdate ? '' : updateSeg) + dotSeg);
  let right = buildRight();
  const flashText = state.flash ? (m === 'default' ? '' : '⏵⏵ ') + state.flash : '';
  const leftW = state.flash ? width(flashText) : width(modeText) + width(hint);
  const showHint = !state.flash && width(modeText) + width(hint) + 2 + Math.min(width(right), 24) <= W - 2;
  const hideLeft = !state.flash && W < 48 && (state.loginNeeded || state.update?.latest);
  // Row Box: paddingX 1, width W, justifyContent space-between. The left
  // Box is flexShrink 0, marginRight 2, maxWidth floor(W / 2) when W < 48;
  // the right Box is flexShrink 1. Free space is the gap between them.
  // The left box's width is what its Text measures at the cap: a wrapping
  // Text measures its longest line, a truncate-end Text (the flash) its
  // content clamped to the cap — even when the cut lands a cell short of
  // the cap on a wide character, the box stays the cap wide. The flash cut
  // is truncateMiddle (wave 6, see the flash branch), whose '…' keeps the
  // style of the span it sits in, as truncateEnd's did.
  const cap = W < 48 ? Math.floor(W / 2) : Infinity;
  let leftLines, leftBoxW;
  if (state.flash) {
    // A flash is cut in the MIDDLE (wave 6): an end cut dropped the tail of
    // the sentence, which in Japanese is where the negation lives — '…でき
    // ません' read as its opposite. Head and tail both survive.
    const content = GOLDC(leftW > W - 4 ? truncateMiddle(flashText, W - 4) : flashText);
    const natural = width(content);
    leftBoxW = Math.min(natural, cap);
    leftLines = natural > leftBoxW ? [truncateMiddle(content, leftBoxW)] : [content];
  } else if (hideLeft) {
    leftLines = ['']; leftBoxW = 0;
  } else {
    const content = hex(color)(modeText) + (showHint ? DIMC(hint) : '');
    const natural = width(content);
    leftLines = natural > cap ? wrapInk(content, cap) : [content];
    leftBoxW = Math.max(0, ...leftLines.map(l => width(l)));
  }
  // A truncate-end line ends with its style still open (truncateEnd keeps
  // it across the '…'): close it before padding, or the pad spaces take
  // the style. A box of width 0 or less renders nothing, not '…'.
  const closeStyle = line => {
    const st = sgrState();
    for (const m of String(line).matchAll(/\x1b\[[0-9;]*m/g)) sgrApply(st, m[0]);
    return sgrOpen(st) ? line + '\x1b[0m' : line;
  };
  const rightBoxW = W - 2 - leftBoxW - 2;
  // Keep the status dot (wave 6): the end cut below keeps the HEAD of the
  // joined string, so when the login / running / update segments alone
  // fill the box, the dot — and the whole lane behind it — vanished. Drop
  // the lowest-priority pre-dot segments (update, then running) until the
  // dot fits; if the login notice alone is still too wide, cut IT so the
  // dot's 2 cells remain. The lane itself keeps the current treatment:
  // cut at its end, lowest priority last.
  if (rightBoxW > 0 && width(right) > rightBoxW) {
    const preW = () => width(loginSeg) + (dropRunning ? 0 : width(runningSeg)) + (dropUpdate ? 0 : width(updateSeg));
    if (preW() + 2 > rightBoxW && updateSeg) { dropUpdate = true; right = buildRight(); }
    if (preW() + 2 > rightBoxW && runningSeg) { dropRunning = true; right = buildRight(); }
    if (preW() + 2 > rightBoxW && loginSeg) {
      loginSeg = rightBoxW > 2 ? truncateEnd(loginSeg, rightBoxW - 2) : '';
      right = buildRight();
    }
  }
  const rightRendered = rightBoxW <= 0 ? '' : (width(right) > rightBoxW ? truncateEnd(right, rightBoxW) : right);
  const gap = Math.max(0, W - 2 - leftBoxW - 2 - width(right));
  return leftLines.map((l, i) => trimEnd(' ' + pad(closeStyle(l), leftBoxW) + (i === 0 ? ' '.repeat(2 + gap) + rightRendered : '')));
}
