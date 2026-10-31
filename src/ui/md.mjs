// Line-at-a-time Markdown for streamed replies. Each completed source line becomes one row
// {prefix, text}; the view gives the text a hanging indent after the prefix and lets Ink wrap.
import {createRequire} from 'node:module';
const {c} = createRequire(import.meta.url)('../tui/term.js');

export function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.code(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/__([^_]+)__/g, (_, x) => c.bold(x))
    .replace(/~~([^~]+)~~/g, (_, x) => c.strike(x))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, (_, a, x) => a + c.italic(x))
    .replace(/(^|[^A-Za-z0-9_])_([^_\s][^_]*)_(?=[^A-Za-z0-9_]|$)/g, (_, a, x) => a + c.italic(x))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => c.under(t) + c.faint(' ' + u));
}

export function createMd(width = 40) {
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
      if ((m = /^(#{1,6})\s+(.*)$/.exec(src))) { const inner = inline(m[2]); return {prefix: '', text: c.bold(m[1].length <= 2 ? c.accent(inner) : inner)}; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(src)) return {prefix: '', text: c.faint('─'.repeat(Math.max(8, width || 40)))};
      if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(src))) return {prefix: m[1] + (m[2] === ' ' ? c.gray('☐ ') : c.green('☒ ')), text: inline(m[3])};
      if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(src))) return {prefix: m[1] + c.gray('• '), text: inline(m[2])};
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(src))) return {prefix: m[1] + c.gray(m[2] + '. '), text: inline(m[3])};
      if ((m = /^>\s?(.*)$/.exec(src))) return {prefix: c.faint('▎ '), text: c.italic(inline(m[1]))};
      if (/^\s*\|.*\|\s*$/.test(src)) return {prefix: '', text: /^\s*\|[\s:|-]+\|\s*$/.test(src) ? c.faint(src.replace(/[^|]/g, '─').replace(/\|/g, '┼')) : src.replace(/\|/g, c.faint('│')), code: true};
      return {prefix: '', text: inline(src)};
    },
  };
  return r;
}
