'use strict';
// One turn's real token usage, as muse.ai shows it after "/usage on":
// "130.8k in / 395 out" under the reply. The line exists only in the live
// gateway event that completes the turn, at the end of the reply's raw text
// in payload.transcript.messages[].content[].text — never in display_text
// (what muser shows) and never in the history API. Its shape, copied from
// muse.ai's own parser:
//   \n\n[usage] context_tokens=130841 response_tokens=395 source=provider cost=unavailable
// This module is dependency-free so the CJS agent, the ESM view and the
// usage tally can all use the same parsing and formatting.
const USAGE_LINE = /\n?\[usage\][^\n]+$/i;
const PAIR = /(\w+)=("[^"]*"|[^\s]*)/g;
const INPUT_KEYS = ['context_tokens_estimate', 'context_tokens', 'input_tokens', 'prompt_tokens'];
const OUTPUT_KEYS = ['response_tokens_estimate', 'response_tokens', 'output_tokens', 'completion_tokens'];

function unquote(v) { return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v; }
function num(v) { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : 0; }
// The first value that is present and is neither "0" nor "unavailable", in key
// order; else the first value present at all (0 / unavailable both read as 0);
// else 0. A 0 or "unavailable" in an early key must not shadow a real value
// in a later one.
function pick(pairs, keys) {
  for (const k of keys) { const v = pairs[k]; if (v !== undefined && v !== '0' && v !== 'unavailable') return num(v); }
  for (const k of keys) { const v = pairs[k]; if (v !== undefined) return num(v); }
  return 0;
}
// n < 1000 -> the number itself; else thousands with one decimal, a trailing
// ".0" removed, plus "k": 999 -> "999", 1000 -> "1k", 130841 -> "130.8k".
function formatTokens(n) {
  const v = num(n);
  if (v < 1000) return String(v);
  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}
function formatUsage(usage) { return formatTokens(usage?.inputTokens || 0) + ' in / ' + formatTokens(usage?.outputTokens || 0) + ' out'; }

// parse(text) -> {body, usage} | null. body is the reply with the usage line
// cut off; usage is {inputTokens, outputTokens, source?, cost?, formatted}.
// Only a [usage] line at the very END of the text counts: one followed by
// more text is part of the reply, not a usage line.
function parse(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(USAGE_LINE);
  if (!m) return null;
  const pairs = {};
  for (const [, k, v] of m[0].matchAll(PAIR)) pairs[k] = unquote(v);
  const usage = {inputTokens: pick(pairs, INPUT_KEYS), outputTokens: pick(pairs, OUTPUT_KEYS)};
  if (pairs.source !== undefined) usage.source = pairs.source;
  if (pairs.cost !== undefined) usage.cost = pairs.cost;
  usage.formatted = formatUsage(usage);
  return {body: text.slice(0, m.index), usage};
}
// strip(text): the reply with a trailing [usage] line removed, or the text
// unchanged when it has none. Non-strings pass through untouched.
function strip(text) { return typeof text === 'string' ? text.replace(USAGE_LINE, '') : text; }

// The text of one transcript message: a string content, or text parts joined.
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return typeof msg.text === 'string' ? msg.text : typeof msg.display_text === 'string' ? msg.display_text : '';
}
// usageFromTranscript(transcript): the usage of the LAST assistant message
// that carries a [usage] line, or null. User messages are skipped: a user
// quoting a usage line is not a turn's usage.
function usageFromTranscript(transcript) {
  const messages = transcript && Array.isArray(transcript.messages) ? transcript.messages : [];
  let found = null;
  for (const msg of messages) {
    if (msg?.role && msg.role !== 'assistant') continue;
    const parsed = parse(messageText(msg));
    if (parsed) found = parsed;
  }
  return found;
}

module.exports = {parse, strip, formatTokens, formatUsage, usageFromTranscript, USAGE_LINE};
