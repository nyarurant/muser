// Line-at-a-time Markdown for streamed replies. Each completed source line becomes one row
// {prefix, text}; the view gives the text a hanging indent after the prefix and lets Ink wrap.
import {createRequire} from 'node:module';
const {c, width, pad} = createRequire(import.meta.url)('../tui/term.js');

// Tables. Rows printed one source line at a time could not line up: each row had its own cell
// widths and the rule under the header matched none of them. A table is now set as a whole —
// every column as wide as its widest cell (display cells, so CJK counts double), the header bold,
// the rule crossing exactly at the column borders, `---:` / `:---:` aligning right / centre.
const TABLE = /^\s*\|.*\|\s*$/, TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
export const isTableLine = src => TABLE.test(src);
// Cells split at | that is not escaped (\| is a literal bar inside a cell).
const cellsOf = src => src.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(x => x.trim().replace(/\\\|/g, '|'));
export function tableRows(lines) {
  const parsed = lines.map(l => TABLE_RULE.test(l) && l.includes('-')
    ? {rule: cellsOf(l).map(x => x.startsWith(':') && x.endsWith(':') ? 'center' : x.endsWith(':') ? 'right' : 'left')}
    : {cells: cellsOf(l).map(x => inline(x))});
  // No spread into Math.max (recovery scan): feed() accumulates a whole streamed
  // table before flushing, and a very large one (200k rows, verified) blew the
  // call stack with a RangeError. Fold instead.
  const n = parsed.reduce((m, p) => Math.max(m, (p.cells || p.rule).length), 1);
  const widths = Array.from({length: n}, () => 1);
  for (const p of parsed) if (p.cells) for (let j = 0; j < n; j++) widths[j] = Math.max(widths[j], width(p.cells[j] || ''));
  const ruleAt = parsed.findIndex(p => p.rule), align = ruleAt >= 0 ? parsed[ruleAt].rule : [];
  const fit = (s, j) => {
    const room = widths[j] - width(s);
    if (align[j] === 'right') return ' '.repeat(room) + s;
    if (align[j] === 'center') return ' '.repeat(Math.floor(room / 2)) + s + ' '.repeat(Math.ceil(room / 2));
    return pad(s, widths[j]);
  };
  return parsed.map((p, i) => {
    if (p.rule) return {prefix: '', text: c.faint(widths.map(w => '─'.repeat(w + 2)).join('┼')), code: true};
    const head = ruleAt > i;
    return {prefix: '', text: widths.map((_, j) => ' ' + (head ? c.bold(fit(p.cells[j] || '', j)) : fit(p.cells[j] || '', j)) + ' ').join(c.faint('│')), code: true};
  });
}

// Markup inside `code` is literal: `__init__.py` showed as "init.py" and `ls *.js *.md` as
// "ls .js .md". Code spans are set aside behind placeholders while the rest is formatted, so
// **bold with `code` inside** still works.
const HOLD = String.fromCharCode(0xe000), HOLD_END = String.fromCharCode(0xe001);
// A third private-use char marks HOLD/HOLD_END chars that were already in the source, so
// they can never be mistaken for a placeholder this function created.
const HOLD_ESC = String.fromCharCode(0xe002);
const HELD = new RegExp(HOLD + '([0-9]+)' + HOLD_END, 'g');
export function inline(src) {
  const spans = [];
  const escaped = String(src).split(HOLD).join(HOLD + HOLD_ESC).split(HOLD_END).join(HOLD_END + HOLD_ESC);
  const s = escaped.replace(/`([^`]+)`/g, (_, x) => HOLD + (spans.push(c.code(x)) - 1) + HOLD_END);
  const restored = format(s).replace(HELD, (_, i) => {
    const n = Number(i);
    // Unknown placeholder (index this call never created): leave it untouched,
    // never substitute spans[n] === undefined into the output.
    return Number.isInteger(n) && n >= 0 && n < spans.length ? spans[n] : HOLD + i + HOLD_END;
  });
  return restored.split(HOLD + HOLD_ESC).join(HOLD).split(HOLD_END + HOLD_ESC).join(HOLD_END);
}
function format(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/__([^_]+)__/g, (_, x) => c.bold(x))
    .replace(/~~([^~]+)~~/g, (_, x) => c.strike(x))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, (_, a, x) => a + c.italic(x))
    .replace(/(^|[^A-Za-z0-9_])_([^_\s][^_]*)_(?=[^A-Za-z0-9_]|$)/g, (_, a, x) => a + c.italic(x))
    // Link URLs may contain one level of balanced parentheses (e.g. Wikipedia titles).
    .replace(/\[([^\]]+)\]\((https?:(?:[^()\s]|\([^()\s]*\))+)\)/g, (_, t, u) => c.under(t) + c.faint(' ' + u));
}

export function createMd(width) {
  // No explicit width: follow the terminal, as the call sites (controller/view)
  // construct a renderer without knowing the current column count.
  const effWidth = width === undefined ? (process.stdout.columns || 40) : width;
  // Streaming re-renders the same source line repeatedly; cache the last inline() result.
  let lastSrc = null, lastResult = null;
  const inlineCached = src => { if (src === lastSrc) return lastResult; const r = inline(src); lastSrc = src; lastResult = r; return r; };
  const r = {
    fence: null,
    row(src) {
      const f = /^\s*(```|~~~)\s*([\w+-]*)/.exec(src);
      if (f) {
        if (!r.fence) { r.fence = f[1]; return {prefix: c.faint('╭─ ') , text: c.faint(f[2] || 'code')}; }
        if (src.trim().startsWith(r.fence)) { r.fence = null; return {prefix: c.faint('╰─'), text: ''}; }
      }
      if (r.fence) return {prefix: c.faint('│ '), text: c.code(src), code: true};
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(src))) { const inner = inlineCached(m[2]); return {prefix: '', text: c.bold(m[1].length <= 2 ? c.accent(inner) : inner)}; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(src)) return {prefix: '', text: c.faint('─'.repeat(Math.max(8, effWidth || 40)))};
      if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(src))) return {prefix: m[1] + (m[2] === ' ' ? c.gray('☐ ') : c.green('☒ ')), text: inlineCached(m[3])};
      if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(src))) return {prefix: m[1] + c.gray('• '), text: inlineCached(m[2])};
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(src))) return {prefix: m[1] + c.gray(m[2] + '. '), text: inlineCached(m[3])};
      if ((m = /^>\s?(.*)$/.exec(src))) return {prefix: c.faint('▎ '), text: c.italic(inlineCached(m[1]))};
      // One table line on its own (the unfinished line's preview); whole tables go through feed().
      if (isTableLine(src)) return tableRows([src])[0];
      return {prefix: '', text: inlineCached(src)};
    },
    // Completed source lines in, rows ready to print out. Table lines wait in `pending` until the
    // table ends (a line that is not a table row, or flush()), so the table is set as a whole.
    pending: [],
    feed(lines) {
      const out = [];
      for (const l of lines) { if (!r.fence && isTableLine(l)) { r.pending.push(l); continue; } out.push(...r.flush(), r.row(l)); }
      return out;
    },
    flush() { if (!r.pending.length) return []; const rows = tableRows(r.pending); r.pending = []; return rows; },
    // A whole text at once (a reply that is not streamed, an agent's result).
    rows(lines) { return [...r.feed(lines), ...r.flush()]; },
  };
  return r;
}
