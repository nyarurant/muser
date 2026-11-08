// Draws the live todo rows (up to 8, plus a count) when open todos exist.
// Mirrors view.mjs Live L818: a column Box with marginTop 1; each row is a
// Text with wrap 'truncate-end' holding '  ' + todoLine(t). The Live version
// does NOT use TodoRow's hanging indent, so a long todo is cut, not wrapped.
// Past 8 rows, one DIM line counts the rest. An empty list draws nothing
// (an empty Box renders nothing, not even its margin).
import {createRequire} from 'node:module';
import {c, truncateEnd, wrapInk, hex} from '../primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../../../i18n.js');
const DIM = hex('#5f5f69');

function todoLine(td) {
  const content = String(td?.content ?? '');
  if (td?.status === 'completed') return c.faint('☒ ' + c.strike(content));
  if (td?.status === 'in_progress') return c.accent('◼ ') + c.bold(content);
  return c.gray('☐ ') + content;
}

// Ink's output stage trims trailing plain spaces off every rendered line
// (a line ending in an escape sequence keeps its space); truncateEnd does
// not do that trimming, so do it here for rows whose content ends in a space.
const trimEnd = line => (line.endsWith(' ') ? line.replace(/ +$/, '') : line);

export function drawLiveTodos(s, ctx) {
  const todos = s?.todos || [];
  const shown = todos.slice(0, 8);
  if (!shown.length) return [];
  const W = ctx?.W ?? 40;
  const out = [''];
  for (const td of shown) out.push(trimEnd(truncateEnd('  ' + todoLine(td), W)));
  if (todos.length > 8) out.push(...wrapInk(DIM(t('  … ほか {n} 件', {n: todos.length - 8}) + ' (/todos)'), W));
  return out;
}
