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
// Cells split at | that is not escaped (\| is a literal bar inside a cell). The split
// counts the backslash run before each |: an even run (\\ is an escaped backslash)
// leaves the | a delimiter, an odd run escapes it (deep #211).
const cellsOf = src => {
  const body = src.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '', run = 0;
  for (const ch of body) {
    if (ch === '\\') { cur += ch; run++; continue; }
    if (ch === '|' && run % 2 === 0) { cells.push(cur); cur = ''; run = 0; continue; }
    cur += ch; run = 0;
  }
  cells.push(cur);
  return cells.map(x => x.trim().replace(/\\(\\|\|)/g, '$1'));
};
const isRuleLine = (l, i, total) => {
  // A delimiter row is only a rule in delimiter position: the second row of a
  // table, or a lone line rendered on its own. The same shape anywhere else
  // (| - | - | as data) is data and must not vanish into a rule (deep #212).
  if (!(i === 1 || (total === 1 && i === 0))) return false;
  if (!TABLE_RULE.test(l) || !l.includes('-')) return false;
  return cellsOf(l).every(x => /^:?-+:?$/.test(x));
};
export function tableRows(lines) {
  const parsed = lines.map((l, i) => isRuleLine(l, i, lines.length)
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
  const ruleRow = () => ({prefix: '', text: c.faint(n === 1 ? '─'.repeat(widths[0] + 4) : widths.map(w => '─'.repeat(w + 2)).join('┼')), code: true});
  const out = [];
  parsed.forEach((p, i) => {
    if (p.rule) { out.push(ruleRow()); return; }
    // No delimiter row anywhere: the first row is the header (bold it and give it
    // a rule), otherwise it renders exactly like a data row (r1-16).
    const head = ruleAt >= 0 ? ruleAt > i : i === 0 && parsed.length > 1;
    const seg = widths.map((_, j) => ' ' + (head ? c.bold(fit(p.cells[j] || '', j)) : fit(p.cells[j] || '', j)) + ' ').join(c.faint('│'));
    // A one-column table has no join, so without explicit end borders it reads
    // as plain lines under a rule (r1-15).
    out.push({prefix: '', text: n === 1 ? c.faint('│') + seg + c.faint('│') : seg, code: true});
    if (head && ruleAt < 0) out.push(ruleRow());
  });
  return out;
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
  // Code spans are scanned, not regexed (deep #210): a span opens with a run of
  // N backticks and closes at the next run of exactly N, so ``code with ` inside``
  // works; a backtick escaped by an odd backslash run is literal text, and its
  // backslash is consumed.
  let s = '';
  for (let i = 0; i < escaped.length;) {
    const ch = escaped[i];
    if (ch === '\\') {
      let n = 0; while (escaped[i + n] === '\\') n++;
      if (escaped[i + n] === '`' && n % 2 === 1) { s += '\\'.repeat(n - 1) + '`'; i += n + 1; continue; }
      s += '\\'.repeat(n); i += n; continue;
    }
    if (ch !== '`') { s += ch; i++; continue; }
    let n = 0; while (escaped[i + n] === '`') n++;
    let close = -1;
    for (let j = i + n; j < escaped.length;) {
      if (escaped[j] !== '`') { j++; continue; }
      let m = 0; while (escaped[j + m] === '`') m++;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) { s += '`'.repeat(n); i += n; continue; }
    let content = escaped.slice(i + n, close).replace(/\n/g, ' ');
    if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
    s += HOLD + (spans.push(c.code(content)) - 1) + HOLD_END;
    i = close + n;
  }
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
    // The link text may not contain '[' either: with ']' absent, [^\]]+ rescanned to
    // end-of-line from every '[', making a long bracket run quadratic (deep #209).
    // Excluding '[' fails each stray bracket immediately instead.
    .replace(/\[([^\]\[]{1,200})\]\((https?:(?:[^()\s]|\([^()\s]*\))+)\)/g, (_, t, u) => c.under(t) + c.faint(' ' + u));
}

// Tabs inside a code block expand to a 2-column tab stop before rendering:
// the terminal would otherwise use 8-column stops and push the code itself
// off a narrow screen (r1-14). (Module level: createMd's own `width`
// parameter shadows the term.js width this needs.)
const expandTabs = s => { let out = '', col = 0; for (const ch of s) { if (ch === '\t') { const n = 2 - (col % 2); out += ' '.repeat(n); col += n; } else { out += ch; col += width(ch); } } return out; };

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
      // A fence closes only on a bare line of the same character repeated at
      // least as many times as the opener (first audit #28): a ```js example or
      // a shorter ``` run inside a ```` block is content, not the end.
      if (r.fence) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(src);
        if (close && close[1][0] === r.fence[0] && close[1].length >= r.fence.length) { r.fence = null; return {prefix: c.faint('╰─'), text: ''}; }
        return {prefix: c.faint('│ '), text: c.code(expandTabs(src)), code: true};
      }
      const f = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(src);
      if (f) { r.fence = f[1]; return {prefix: c.faint('╭─ ') , text: c.faint(f[2] || 'code')}; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(src))) { const inner = inlineCached(m[2]); return {prefix: '', text: c.bold(m[1].length <= 2 ? c.accent(inner) : inner)}; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(src)) return {prefix: '', text: c.faint('─'.repeat(Math.max(8, effWidth || 40)))};
      if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(src))) return {prefix: m[1] + (m[2] === ' ' ? c.gray('☐ ') : c.green('☒ ')), text: inlineCached(m[3])};
      if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(src))) return {prefix: m[1] + c.gray('• '), text: inlineCached(m[2])};
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(src))) return {prefix: m[1] + c.gray(m[2] + '. '), text: inlineCached(m[3])};
      // Nested quotes repeat the bar per level instead of leaving a raw '>'
      // in the text (r1-19).
      if ((m = /^((?:>\s?)+)(.*)$/.exec(src))) { const depth = m[1].split('>').length - 1; return {prefix: c.faint('▎'.repeat(depth) + ' '), text: c.italic(inlineCached(m[2]))}; }
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
