// Embed tokens Muse may emit ([[hatch_widget:...]] and friends) are rich-UI directives for
// the Muse app; a terminal cannot render them, so assistant text is passed through here first.
// sanitizeEmbeds swaps each token for one placeholder line; stripEmbeds removes them entirely
// (for plain/exec output that should carry no trace of them).
import {createRequire} from 'node:module';
const {t} = createRequire(import.meta.url)('../i18n.js');

// The placeholder text, written once: the export is the Japanese original and
// placeholder() is that same string in the current UI language.
const RAW = '（🪟 ウィジェット — ターミナルでは表示できません）';
export const WIDGET_PLACEHOLDER = RAW;
// Resolved when text is sanitized (display time), not when this module loads.
const placeholder = () => t(RAW);

// Terminal escape sequences and stray control characters are stripped before any
// of this reaches the screen (audit #184): tool output and file contents are data,
// and a raw ESC inside them — an OSC 52 clipboard write, a CSI that clears the
// screen or moves the cursor — would otherwise be executed by the user's terminal
// when Ink writes the text. Newlines and tabs are the only controls that survive;
// a sequence that never terminates degrades to inert literal text, never to a
// live escape (the leftover ESC itself is a control and is removed too).
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-Z\\-_])/g;
// Beyond C0/C1: bidi controls (U+061C, U+200E/200F, U+202A–202E, U+2066–2069)
// rewrite how text LOOKS without any escape sequence (Trojan-Source style,
// deep #109), and U+200B / U+FEFF are invisible zero-width noise. U+200D (ZWJ)
// is NOT stripped: emoji sequences need it.
const CTRL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
export function stripControls(text) {
  return String(text ?? '').replace(ESC_SEQ, '').replace(CTRL_CHARS, '');
}

// All embed-token patterns are built from these shared fragments:
// OPEN is the literal "[[", HEAD is "<word>:" (a token name and its colon).
const OPEN = '\\[\\[';
const HEAD = '[A-Za-z][\\w-]*:';
// A payload may contain a single ] (just not the closing ]]): excluding every ]
// made such tokens match neither pattern and leak raw (deep #110).
const BODY = '(?:[^\\]\\r\\n]|\\](?!\\]))';
// [[<word>:<payload>]] — covers hatch_widget, hatch_letter and any future sibling token.
const TOKEN = new RegExp(OPEN + HEAD + BODY + '{1,300}?\\]\\]', 'g');
// An embed token cut off at the very end of the text (stream ended mid-token).
const TRAILING_PARTIAL = new RegExp(OPEN + HEAD + BODY + '*$');
// A line that is nothing but an embed token or a bare embed_token reference.
const BARE_LINE = new RegExp('^\\s*(?:embed_token\\s*[:=]?\\s*)?(?:' + OPEN + HEAD + BODY + '+\\]\\]|(?:widget|letter)-[0-9a-fA-F-]{8,})\\s*$');
// A bare `embed_token:` line counts only when what follows is actually a token
// or a widget/letter id: prose that merely starts with the words (a format
// explanation, a log line) is ordinary text (third audit M17).
const BARE_EMBED_TOKEN = /^\s*embed_token\s*[:=]\s*(?:\[\[[A-Za-z][\w-]*:[^\]\r\n]{1,300}?\]\]|(?:widget|letter)-[0-9a-fA-F-]{8,})\s*$/;
const PARTIAL_TAIL = new RegExp(OPEN + '(?:' + HEAD + ')?[^\\]\\n]*$');

// Fence tracking (deep #107): the old single toggle flipped on ANY line starting
// with ``` or ~~~, so a one-line ```x``` fence, the other fence character inside
// a block, or a shorter run inside a longer fence all desynchronised the state
// (later tokens leaked raw, quoted tokens were scrubbed). A fence opens with a
// run of 3+ of one character, closes only on a bare line of the same character
// at least as long, and a line that opens and closes on itself changes nothing.
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
function makeFenceTracker() {
  let fence = null;
  return {
    get open() { return fence !== null; },
    // True when the line is a fence boundary (open, close, or self-contained).
    boundary(line) {
      const m = FENCE_OPEN.exec(line);
      if (!m) return false;
      const run = m[1], rest = m[2] || '';
      if (!fence) {
        const closes = run[0] === '`' ? new RegExp('`{' + run.length + ',}') : new RegExp('~{' + run.length + ',}');
        if (closes.test(rest)) return true;
        fence = {ch: run[0], len: run.length};
        return true;
      }
      if (run[0] === fence.ch && run.length >= fence.len && /^\s*$/.test(rest)) { fence = null; return true; }
      return false;
    },
  };
}
function endsInFence(text) {
  const tr = makeFenceTracker();
  for (const line of String(text ?? '').split('\n')) tr.boundary(line);
  return tr.open;
}

// One shared single-pass line processor: a bare-token line is handed to onBare
// (return null to drop the line), every other line to replaceInLine. Inside a
// code fence the text is a quotation, not directives: an example token (or a
// widget-id-looking line) in a code block is content the user asked to see,
// and scrubbing it corrupted code examples and command output (audit #185).
function processLines(text, onBare, replaceInLine) {
  const out = [];
  const tr = makeFenceTracker();
  for (const line of String(text ?? '').split('\n')) {
    const wasOpen = tr.open;
    if (tr.boundary(line)) { out.push(line); continue; }
    if (wasOpen) { out.push(line); continue; }
    if (BARE_LINE.test(line) || BARE_EMBED_TOKEN.test(line)) {
      const r = onBare(line);
      if (r !== null) out.push(r);
    } else out.push(replaceInLine(line));
  }
  return out;
}

// A trailing embed token that is still streaming in across lines (first audit
// #27): partialEmbedTail now recognises the multi-line fragment, so it can be
// given the same placeholder treatment TRAILING_PARTIAL gives a single line.
function dropTrailingPartial(out, replacement) {
  if (endsInFence(out)) return out;
  const tail = partialEmbedTail(out, 5000);
  return tail && tail.includes('\n') ? out.slice(0, out.length - tail.length) + replacement : out;
}

export function sanitizeEmbeds(text) {
  const P = placeholder();
  let out = processLines(scrubLongTokens(stripControls(text), P), () => P, line => line.replace(TOKEN, P)).join('\n');
  if (!endsInFence(out)) out = out.replace(TRAILING_PARTIAL, P);
  out = dropTrailingPartial(out, P);
  // #187: placeholder-only lines are NOT collapsed into one any more. Collapsing made
  // sanitizeEmbeds non-prefix-stable: as a second widget token streamed in, the clean
  // text SHRANK where a placeholder line had already been emitted, so the controller's
  // revision check fired a false "Muse rewrote the reply" note, re-emitted the text,
  // and endMessage's slice landed at the wrong offset. One token, one placeholder line.
  return out;
}

export function stripEmbeds(text) {
  // Lines holding only a token go away entirely; tokens inside a line are cut out.
  const kept = processLines(scrubLongTokens(stripControls(text), ''), () => null, line => line.replace(TOKEN, ''));
  let out = kept.join('\n');
  if (!endsInFence(out)) out = out.replace(TRAILING_PARTIAL, '');
  out = dropTrailingPartial(out, '');
  return out.replace(/[ \t]+\n/g, '\n');
}

// #186: TOKEN's body is capped at 300 chars and cannot cross a newline, so a longer
// token — or one whose payload contains a line break — matched nothing and reached
// the terminal raw. Before the line pass, whole non-fence segments get a multi-line,
// length-generous token pass (up to the first closing ]]); fenced segments are
// quotations and stay untouched (#185), exactly as in processLines.
// Only hatch_* tokens get the generous pass (deep #108): with any word allowed
// as the head, ordinary prose that happened to write [[word: ... and, paragraphs
// later, a ]] (an array literal, a citation) was swallowed whole up to 5000
// chars. Real long/multi-line tokens are Muse's hatch_widget / hatch_letter
// family, and their payloads start with an id character, never a space.
const LONG_TOKEN = new RegExp(OPEN + 'hatch_[A-Za-z0-9_-]*:[A-Za-z0-9-][\\s\\S]{0,5000}?\\]\\]', 'g');
function scrubLongTokens(text, replacement) {
  const out = [], buf = [];
  const tr = makeFenceTracker();
  // Only the tokens the line pass cannot see are scrubbed here (multi-line, or longer
  // than TOKEN's 300-char body): a short single-line token is left for processLines,
  // which knows a bare-token LINE must vanish in stripEmbeds — replacing it here left
  // an empty line behind instead.
  const flush = () => { if (buf.length) { out.push(buf.join('\n').replace(LONG_TOKEN, m => (m.includes('\n') || m.length > 320) ? replacement : m)); buf.length = 0; } };
  for (const line of String(text ?? '').split('\n')) {
    const wasOpen = tr.open;
    if (tr.boundary(line)) { flush(); out.push(line); continue; }
    if (wasOpen) { out.push(line); continue; }
    buf.push(line);
  }
  flush();
  return out.join('\n');
}

// The trailing unfinished `[[...` fragment of a streaming text, if it could still grow into an
// embed token: the controller holds it back until it resolves or passes `max` chars.
// #181: the default hold-back (120) was SHORTER than a legal token (a 300-char body plus
// head and brackets), so a growing token leaked raw into scrollback mid-stream and was
// then "rewritten" when it completed. The default now covers the legal maximum.
export function partialEmbedTail(text, max = 340) {
  const s = String(text ?? '');
  const m = PARTIAL_TAIL.exec(s);
  if (m && !m[0].includes(']]') && m[0].length <= max) return m[0];
  // A token whose payload already crossed a newline (first audit #27): the
  // single-line pattern above cannot see it, so the fragment's earlier lines
  // leaked raw and the completed token then tripped the revision check. Hold
  // back the whole fragment from its `[[` when it carries a token head and no
  // closing ]] yet.
  const i = s.lastIndexOf('[[');
  if (i < 0) return '';
  const frag = s.slice(i);
  if (frag.includes(']]') || frag.length > max || !frag.includes('\n')) return '';
  return /^\[\[[A-Za-z][\w-]*:/.test(frag) ? frag : '';
}
