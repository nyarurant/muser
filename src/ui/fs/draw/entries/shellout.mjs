// Draws the 'shellout' entry: a shell-out block with its output lines.
// Mirrors view.mjs Entry case 'shellout': a header Line (accent ⚙, bold id,
// gray running / finished state), an optional dim 'cut' Line, then one gray
// '  │ ' Line per output line, in a column with marginBottom 1 whose root
// has no explicit width (cols); every line is truncate-end at cols. When no
// line has content, a single placeholder line stands in (waiting while
// running, '(出力なし)' when finished). Returns null without an id (not a
// drawable shell-out record; the caller falls back to React).
import {createRequire} from 'node:module';
import {c, truncateEnd} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');

export function drawShellout(e, ctx) {
  if (!e || e.id == null) return null;
  const {cols} = ctx;
  const slines = Array.isArray(e.lines) ? e.lines : [];
  const out = [truncateEnd(c.accent('⚙ ') + c.bold(e.id) + c.gray(e.running ? t('  実行中') : t('  終了 exit {exit}', {exit: e.exit})), cols)];
  if (e.cut) out.push(truncateEnd(c.faint('  │ ' + t('⋮ 前の出力は省略（/output で全文）')), cols));
  const body = slines.filter(l => l && l.length).length ? slines : [e.running ? t('（まだ出力がありません）') : t('(出力なし)')];
  for (const l of body) out.push(truncateEnd(c.gray('  │ ' + l), cols));
  out.push('');
  return out;
}
