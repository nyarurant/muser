// Embed tokens Muse may emit ([[hatch_widget:...]] and friends) are rich-UI directives for
// the Muse app; a terminal cannot render them, so assistant text is passed through here first.
// sanitizeEmbeds swaps each token for one placeholder line; stripEmbeds removes them entirely
// (for plain/exec output that should carry no trace of them).

export const WIDGET_PLACEHOLDER = '（🪟 ウィジェット — ターミナルでは表示できません）';

// [[<word>:<payload>]] — covers hatch_widget, hatch_letter and any future sibling token.
const TOKEN = /\[\[[A-Za-z][\w-]*:[^\]\r\n]{1,300}?\]\]/g;
// An embed token cut off at the very end of the text (stream ended mid-token).
const TRAILING_PARTIAL = /\[\[[A-Za-z][\w-]*:[^\]\r\n]*$/;
// A line that is nothing but an embed token or a bare embed_token reference.
const BARE_LINE = /^\s*(?:embed_token\s*[:=]?\s*)?(?:\[\[[A-Za-z][\w-]*:[^\]\r\n]+\]\]|(?:widget|letter)-[0-9a-fA-F-]{8,})\s*$/;
const BARE_EMBED_TOKEN = /^\s*embed_token\s*[:=].*$/;

function mapLines(text, tokenReplacement) {
  return String(text ?? '').split('\n').map(line => {
    if (BARE_LINE.test(line) || BARE_EMBED_TOKEN.test(line)) return tokenReplacement;
    return line.replace(TOKEN, tokenReplacement);
  }).join('\n');
}

export function sanitizeEmbeds(text) {
  let out = mapLines(text, WIDGET_PLACEHOLDER);
  out = out.replace(TRAILING_PARTIAL, WIDGET_PLACEHOLDER);
  // Collapse runs of placeholder-only lines (consecutive embed lines) into a single one.
  const lines = out.split('\n'), kept = [];
  for (const line of lines) {
    if (line.trim() === WIDGET_PLACEHOLDER && kept.length && kept[kept.length - 1].trim() === WIDGET_PLACEHOLDER) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

export function stripEmbeds(text) {
  // Lines holding only a token go away entirely; tokens inside a line are cut out.
  const kept = [];
  for (const line of String(text ?? '').split('\n')) {
    if (BARE_LINE.test(line) || BARE_EMBED_TOKEN.test(line)) continue;
    kept.push(line.replace(TOKEN, ''));
  }
  return kept.join('\n').replace(TRAILING_PARTIAL, '').replace(/[ \t]+\n/g, '\n');
}

// The trailing unfinished `[[...` fragment of a streaming text, if it could still grow into an
// embed token: the controller holds it back until it resolves or passes `max` chars.
export function partialEmbedTail(text, max = 120) {
  const m = /\[\[[^\]\n]*$/.exec(String(text ?? ''));
  if (!m || m[0].includes(']]') || m[0].length > max) return '';
  return m[0];
}
