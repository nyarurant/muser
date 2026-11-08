// Draws the 'help' entry: the command list and key grid.
// Mirrors view.mjs Entry case 'help': a column with marginBottom 1 and no
// explicit width, so it lays out at cols.
//  - A bold 'コマンド' heading, then one row per COMMANDS entry: 2 cells of
//    padding, the name in ACCENT (#b4a0ff = c.accent) in a 14-cell box, and the
//    description beside it. The description is pre-wrapped with term.js wrap
//    at max(8, W-17) (the same call view.mjs makes — term.js wrap drops the
//    break space, unlike Ink's) and each resulting line is drawn GRAY; the
//    continuation lines sit under the description, past the name box.
//    primitives.mjs does not re-export term.js wrap, so it is required here.
//  - A blank line, a bold 'キー' heading, then the key phrases (the two long
//    strings in view.mjs, split on ' · '). Below W=56 each phrase is its own
//    wrapped GRAY row at padding 2; at W>=56 they sit in a wrap grid of width
//    W (padding 2 included): each cell is cellW = min(W-2, widest phrase + 3)
//    wide and its text is cut truncate-end, the padding after a row's last
//    cell being trimmed away by Ink's output stage, so it is not emitted.
import {createRequire} from 'node:module';
import {c, width, pad, hanging, truncateEnd} from '../primitives.mjs';
import {COMMANDS} from '../../../controller.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const {wrap: wrapText} = require('../../../../tui/term.js');

export function drawHelp(e, ctx) {
  const W = ctx.W;
  const keys = [t('  enter 送信 · {bs}+enter / ctrl+j 改行 · ↑↓ 履歴（@ 補完中は候補の移動） · esc 中断 · esc ×2 入力を消す · shift+tab 承認モード · tab コマンド補完 · ctrl+c ×2 終了 · ctrl+d ×2 終了', {bs: '\\'}),
    t('  ctrl+a / ctrl+e 行頭・行末 · ctrl+u / ctrl+k カーソルの前・後ろを消す · ctrl+w 単語を消す · ctrl+o 直近の出力を全文 · alt+v / ctrl+v 画像を貼る · 空の入力で backspace 添付を外す · @ ファイル · ! シェル · $ スキル'),
    // Fullscreen-only scroll keys (wave 6): the fs screen owns the scrollback
    // (src/ui/fs/app.mjs: pageUp / pageDown scroll a page, ctrl+home / ctrl+end
    // jump, the wheel scrolls), and the classic help above never mentioned
    // them, so in fullscreen there was no way to learn how to look back.
    t('  pgup / pgdn 履歴をスクロール（全画面のみ） · ctrl+home / ctrl+end 履歴の最初・最後へ（全画面のみ） · ホイール 履歴をスクロール（全画面のみ）')]
    .flatMap(s => s.trim().split(' · '));
  const out = [c.bold(t('コマンド'))];
  for (const [n, d] of COMMANDS) {
    const desc = wrapText(t(d), Math.max(8, W - 17));
    desc.forEach((l, i) => {
      const name = i === 0 ? c.accent(n) + ' '.repeat(Math.max(0, 14 - width(n))) : ' '.repeat(14);
      out.push('  ' + name + c.gray(l));
    });
  }
  out.push(''); // view.mjs puts a ' ' Text here; Ink's output stage trims it to ''
  out.push(c.bold(t('キー')));
  if (W < 56) {
    for (const k of keys) out.push(...hanging('  ', c.gray(k), {width: ctx.cols, wrapMode: 'wrap'}));
  } else {
    const cellW = Math.min(W - 2, Math.max(...keys.map(k => width(k))) + 3);
    const perRow = Math.max(1, Math.floor((W - 2) / cellW));
    for (let i = 0; i < keys.length; i += perRow) {
      const row = keys.slice(i, i + perRow);
      out.push('  ' + row.map((k, j) => {
        const cell = truncateEnd(c.gray(k), cellW);
        return j === row.length - 1 ? cell : pad(cell, cellW);
      }).join(''));
    }
  }
  out.push('');
  return out;
}
