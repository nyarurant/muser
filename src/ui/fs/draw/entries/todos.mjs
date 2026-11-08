// Draws the 'todos' entry: the todo list rows.
// Mirrors view.mjs Entry case 'todos': a column with marginBottom 1 whose root
// has no explicit width, so it lays out at cols. Each row is TodoRow: a plain
// 2-cell indent, a non-shrinking mark ('☒ ' faint, '◼ ' accent, '☐ ' gray) and
// the content wrapped under itself (hanging). Completed text is faint + struck,
// in-progress is bold, pending is plain. No todos draws one gray line.
import {createRequire} from 'node:module';
import {c, hanging, wrapInk} from '../primitives.mjs';
const {t} = createRequire(import.meta.url)('../../../../i18n.js');

export function drawTodos(e, ctx) {
  // An entry without its todo list is not a shape this draw covers: return
  // null so the caller falls back to the React drawing (which shows the
  // same empty-list line for a missing list).
  if (!Array.isArray(e.todos)) return null;
  const list = e.todos;
  if (!list.length) return [...wrapInk(c.gray(t('  Todo はまだありません。')), ctx.cols), ''];
  const out = [];
  for (const td of list) {
    const content = String(td?.content ?? '');
    const mark = td?.status === 'completed' ? c.faint('☒ ') : td?.status === 'in_progress' ? c.accent('◼ ') : c.gray('☐ ');
    const text = td?.status === 'completed' ? c.faint(c.strike(content)) : td?.status === 'in_progress' ? c.bold(content) : content;
    out.push(...hanging('  ' + mark, text || ' ', {width: ctx.cols, wrapMode: 'wrap'}));
  }
  out.push('');
  return out;
}
