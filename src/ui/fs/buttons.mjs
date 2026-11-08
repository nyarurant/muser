// Clickable buttons on the fullscreen screen. The drawing parts (draw/) stay exactly as
// they are — the parity tests hold them cell for cell against the classic screen — and
// this module works on the finished frame instead:
//   - it finds the labels that already read like buttons (the banner's key hints, the
//     footer's approval mode / account / weekly usage) and makes their cells clickable,
//     underlining them so they look clickable;
//   - it puts [貼り付け] [送信 ⏎] on the prompt box's bottom border and [↓ 最新へ] on the
//     "scrolled" band.
// Each frame returns its regions ({y, x0, x1, id}); app.mjs maps a click to one.
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {c, width, strip} = require('../../tui/term.js');
const {t} = require('../../i18n.js');
const {LABELS} = require('../../policy.js');

// The banner's key hints (draw/entries/banner.mjs keycap: ' key ' + ' label'), the ones a
// click can do: / opens the command list, ⇧⇥ switches the approval mode, esc interrupts,
// alt+v attaches a clipboard image, @ and ! start a mention / a shell line.
export const HINTS = [['/', 'コマンド', 'slash'], ['⇧⇥', '承認モード', 'mode'], ['esc', '中断', 'interrupt'], ['alt+v', '画像', 'image'], ['@', 'ファイル', 'at'], ['!', 'シェル', 'bang']];

// Column span of `needle` in the plain text of a line (display columns, wide characters
// counted as 2), or null.
export function findCols(plain, needle, from = 0) {
  if (!needle) return null;
  const i = plain.indexOf(needle, from);
  if (i < 0) return null;
  const x0 = width(plain.slice(0, i));
  return {x0, x1: x0 + width(needle), at: i};
}

// Insert SGR at display columns a (underline on) and b (off) of a styled line, without
// touching its escape sequences or its width.
export function underlineCols(line, a, b) {
  const s = String(line);
  let col = 0, out = '', opened = false, closed = false;
  const ESC_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\/y;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') { ESC_RE.lastIndex = i; const m = ESC_RE.exec(s); if (m) { out += m[0]; i += m[0].length; continue; } }
    const ch = String.fromCodePoint(s.codePointAt(i));
    if (!opened && col >= a) { out += '\x1b[4m'; opened = true; }
    if (opened && !closed && col >= b) { out += '\x1b[24m'; closed = true; }
    out += ch; col += width(ch); i += ch.length;
  }
  if (opened && !closed) out += '\x1b[24m';
  return out;
}

// The prompt box's bottom border with the paste / send buttons near its right end.
// Returns {line, regions: [{x0, x1, id}]} or null when the row is not a border or too narrow.
export function promptBorderButtons(line, {canSend}) {
  const plain = strip(String(line));
  if (!/^╰─*╯$/.test(plain)) return null;
  const W = width(plain);
  const paste = '[' + t('貼り付け') + ']', send = '[' + t('送信 ⏎') + ']';
  const tail = ' ' + paste + ' ' + send + ' ─╯';
  const fill = W - 1 - width(tail);
  if (fill < 8) return null;
  // The border's own colour: whatever SGR opens the line before the first border glyph.
  const lead = (String(line).match(/^(?:\x1b\[[0-9;]*m)*/) || [''])[0];
  const x0p = 1 + fill + 1, x1p = x0p + width(paste), x0s = x1p + 1, x1s = x0s + width(send);
  const out = lead + '╰' + '─'.repeat(fill) + '\x1b[0m ' + c.accent(paste) + ' ' + (canSend ? c.accent(send) : c.faint(send)) + ' ' + lead + '─╯\x1b[0m';
  return {line: out, regions: [{x0: x0p, x1: x1p, id: 'paste'}, {x0: x0s, x1: x1s, id: 'send'}]};
}

// The scrolled band's jump button.
export const jumpLabel = () => '[' + t('↓ 最新へ') + ']';

// Footer labels that act like buttons: the approval mode (switches it), the account
// (opens /account) and the weekly usage (opens /usage).
export function footerTargets(s) {
  const m = s?.mode;
  const out = [];
  if (m && LABELS[m]) out.push([(m === 'default' ? '' : '⏵⏵ ') + t(LABELS[m]), 'mode']);
  if (s?.account?.label) out.push([s.account.label, 'account']);
  if (s?.plan?.percentUsed != null) out.push([t('週 {n}%', {n: s.plan.percentUsed}), 'usage']);
  return out;
}

// Run a button. ctrl is the (local or remote) Controller; scrollToBottom moves the history.
export function runButton(id, ctrl, {scrollToBottom} = {}) {
  const s = ctrl.get?.() || {};
  const quiet = p => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
  switch (id) {
    case 'bottom': return scrollToBottom?.();
    case 'send': return ctrl.key('', {return: true});
    case 'paste': return quiet(ctrl.pasteFromClipboard?.());
    case 'image': return quiet(ctrl.pasteImage?.());
    case 'mode': return quiet(ctrl.cycleMode?.());
    case 'interrupt': return s.busy ? ctrl.key('', {escape: true}) : undefined;
    case 'slash': case 'at': case 'bang': {
      const ch = id === 'slash' ? '/' : id === 'at' ? '@' : '!';
      // / and ! only mean something at the start of an empty line; @ works anywhere.
      if (id !== 'at' && String(s.text || '').length) return;
      return ctrl.key(ch, {});
    }
    case 'account': return quiet(ctrl.submit?.('/account'));
    case 'usage': return quiet(ctrl.submit?.('/usage'));
    default: return undefined;
  }
}
