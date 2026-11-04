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
// A trailing newline (or CRLF, or a blank last line) after the usage line is still the
// usage line: the gateway's raw text may end with one, and without it the line was neither
// parsed nor stripped, so the raw [usage] line reached the screen.
const USAGE_LINE = /\n?\[usage\][^\n]+(?:\r?\n)*$/i;
const PAIR = /(\w+)=("[^"]*"|[^\s]*)/g;
const INPUT_KEYS = ['context_tokens_estimate', 'context_tokens', 'input_tokens', 'prompt_tokens'];
const OUTPUT_KEYS = ['response_tokens_estimate', 'response_tokens', 'output_tokens', 'completion_tokens'];

function unquote(v) { return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v; }
// Thousands separators are provider formatting, not a decimal point: "1,000"
// is a thousand, and parseInt alone would read it as 1.
function num(v) { const n = Number.parseInt(String(v ?? '').replace(/,/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : 0; }
// A value counts as missing when it is absent, empty ("context_tokens=") or
// "unavailable" in any casing: the provider's capitalised "Unavailable" (and
// an empty value) used to pass the old exact-match test, read as 0 and shadow
// the real count in a later key (audit #26).
function missing(v) { return v === undefined || String(v).trim() === '' || String(v).trim().toLowerCase() === 'unavailable'; }
// The first value that is present and carries a real count, in key order;
// else the first value present at all (0 / unavailable both read as 0);
// else 0. A 0, an empty value or "unavailable" in an early key must not
// shadow a real value in a later one.
function pick(pairs, keys) {
  for (const k of keys) { const v = pairs[k]; if (!missing(v) && num(v) > 0) return num(v); }
  for (const k of keys) { const v = pairs[k]; if (!missing(v)) return num(v); }
  return 0;
}
// n < 1000 -> the number itself; else thousands with one decimal, a trailing
// ".0" removed, plus "k": 999 -> "999", 1000 -> "1k", 130841 -> "130.8k"; from
// a million, millions the same way: 6274947 -> "6.3M" ("6274.9k" was hard to
// read), and from a billion "B". A value that would round to "1000k" is "1M",
// one that would round to "1000M" is "1B".
function formatTokens(n) {
  const v = num(n);
  if (v < 1000) return String(v);
  const one = x => x.toFixed(1).replace(/\.0$/, '');
  for (const [size, unit] of [[1e3, 'k'], [1e6, 'M']]) {
    const x = Math.round(v / (size / 10)) / 10;
    if (x < 1000) return one(x) + unit;
  }
  return one(Math.round(v / 1e8) / 10) + 'B';
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
  // A [usage] line with no token key at all is reply content (a sentence about usage, a
  // quoted example), not a usage line: counting it fabricated a 0 / 0 usage and cut the
  // reply's last line. A line whose keys are present but all unavailable still counts.
  if (!INPUT_KEYS.some(k => pairs[k] !== undefined) && !OUTPUT_KEYS.some(k => pairs[k] !== undefined)) return null;
  const usage = {inputTokens: pick(pairs, INPUT_KEYS), outputTokens: pick(pairs, OUTPUT_KEYS)};
  if (pairs.source !== undefined) usage.source = pairs.source;
  if (pairs.cost !== undefined) usage.cost = pairs.cost;
  usage.formatted = formatUsage(usage);
  return {body: text.slice(0, m.index), usage};
}
// strip(text): the reply with a trailing [usage] line removed, or the text
// unchanged when it has none. Non-strings pass through untouched. It goes
// through parse() so a [usage] line that is reply content (no token keys)
// is kept, exactly as parse() treats it.
function strip(text) { if (typeof text !== 'string') return text; const p = parse(text); return p ? p.body : text; }

// The text of one transcript message: a string content, or text parts joined.
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return typeof msg.text === 'string' ? msg.text : typeof msg.display_text === 'string' ? msg.display_text : '';
}
// usageFromTranscript(transcript): the usage of the LAST assistant message
// that carries a [usage] line, or null. Only an explicit assistant role
// counts: a message with no role is not assumed to be the assistant, or a
// role-less user message quoting a [usage] line would overwrite the turn's
// real usage with the quoted numbers.
function usageFromTranscript(transcript) {
  const messages = transcript && Array.isArray(transcript.messages) ? transcript.messages : [];
  let found = null;
  for (const msg of messages) {
    if (msg?.role !== 'assistant') continue;
    const parsed = parse(messageText(msg));
    if (parsed) found = parsed;
  }
  return found;
}

// What a display shows for a stored usage: formatted again from the numbers, so a
// record written by an older muser reads in today's units; the stored text only
// when there are no numbers.
function usageText(usage) {
  if (!usage) return '';
  return Number.isFinite(usage.inputTokens) || Number.isFinite(usage.outputTokens) ? formatUsage(usage) : String(usage.formatted || '');
}

module.exports = {parse, strip, formatTokens, formatUsage, usageText, usageFromTranscript, USAGE_LINE};
