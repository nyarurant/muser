'use strict';
// What /resume shows: the session's local transcript (src/sessions.js, one JSONL line per turn).
// Only when that file has fewer turns than the session (a chat from before transcripts existed,
// or one continued from another PC) is the chat read from Muse; the result is written back, so
// the next resume needs no request.
const sessions = require('./sessions');
const {messageFromEvent} = require('./core/chat-model');

// The first message of a muser chat carries the CLI preamble; the user's words follow "User:"
// (main chat) or "Task:" (a parallel agent).
function userText(content) {
  const s = String(content || '');
  if (!s.startsWith('[muser:')) return s;
  // The FIRST marker is the real delimiter: the preamble precedes it, and everything
  // after it is the user's words — including a "\nUser:\n" they pasted themselves,
  // which the old lastIndexOf cut away along with everything before it (#21).
  // Fix2 (c26 #6): the preamble EMBEDS project-instruction / skill text, which can
  // itself contain a "\nUser:\n" line; the first such line used to cut there and
  // show the middle of the instructions as the user's words. The real delimiter
  // is always sent as a blank line followed by the marker (preamble + '\n\nUser:\n'
  // in agent.js), so a blank-line marker wins; the bare first marker stays as the
  // fallback for shapes without one. (A marker after a blank line INSIDE embedded
  // text is indistinguishable from the real one — see the rows file.)
  const bu = s.indexOf('\n\nUser:\n'), bt = s.indexOf('\n\nTask:\n');
  if (bu >= 0 || bt >= 0) { const at = bu < 0 ? bt : bt < 0 ? bu : Math.min(bu, bt); return s.slice(at + 8); }
  const u = s.indexOf('\nUser:\n'), t = s.indexOf('\nTask:\n');
  const at = u < 0 ? t : t < 0 ? u : Math.min(u, t);
  return at < 0 ? s : s.slice(at + 7);
}

// Bodies muser itself sent into the chat (automatic Focus/goal continuations and Focus
// round prompts): not user turns. In history they used to start ghost turns, and the
// leg's reply overwrote the real turn's reply (#18/#20).
const SYNTHETIC_PREFIXES = ['[muser: automatic continuation]', '[muser: automatic /goal continuation]', '[muser Focus task:'];
const isSynthetic = content => SYNTHETIC_PREFIXES.some(p => String(content || '').startsWith(p));

// Chat events -> turns: each user message starts one; its reply is the last assistant message after it.
function turnsFromHistory(events) {
  const byId = new Map();
  for (const e of events || []) { const m = messageFromEvent(e); if (m) byId.set(m.id, m); }
  const msgs = [...byId.values()].sort((a, b) => a.seq - b.seq || a.time - b.time);
  const turns = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      if (isSynthetic(m.content)) continue; // a continuation leg rides the turn it belongs to
      // #20 (the postSteer half): a user message that lands while the previous turn
      // still has NO assistant reply is a mid-turn interjection in that turn (that
      // is exactly how postSteer delivers it), not a new turn — as a new turn it
      // stole the reply: the turn's answer was recorded on the interjection and
      // the original turn kept an empty/overwritten reply.
      const prev = turns[turns.length - 1];
      if (prev && !prev.reply) { prev.user = prev.user ? prev.user + '\n\n' + userText(m.content) : userText(m.content); continue; }
      turns.push({v: 1, at: m.time || 0, user: userText(m.content), reply: '', tools: [], steps: [], sources: [], todos: [], from: 'muse'});
    }
    else if (turns.length) turns[turns.length - 1].reply = m.content;
  }
  return turns;
}

// Muse's history comes 50 events a page, newest first; a few pages reach back far enough for
// most chats without fetching a whole long one.
const HISTORY_PAGES = 10;
async function fetchHistory(client, id) {
  let events = [], before, more = false;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const h = await client.history(id, before);
    const batch = h?.chat_events || [];
    events = batch.concat(events);
    more = !!h?.has_more;
    const seqs = batch.map(e => e.seq).filter(Number.isFinite);
    if (!more || !seqs.length) break;
    before = Math.min(...seqs);
  }
  return {events, more};
}

async function forResume(session, client) {
  const local = sessions.transcript(session.id);
  if (local.length >= (session.turns || 0) || !client?.history) return {turns: local, from: 'local'};
  // A failed history fetch (offline, a gateway hiccup) is not a reason to fail the resume:
  // the local transcript is right there and is what /resume would have shown anyway.
  let fetched;
  try { fetched = await fetchHistory(client, session.id); } catch { return {turns: local, from: 'local'}; }
  const {events, more} = fetched;
  const remote = turnsFromHistory(events);
  if (!remote.length) return {turns: local, from: 'local'};
  // Keep the richer local record (tools, steps, todos) wherever the same user message is in both,
  // and the local turns Muse's pages did not reach. Writing only what Muse returned replaced a
  // long local transcript with the last page or so of it (2026-11-01 audit).
  // The same turn rarely matches verbatim: locally the turn is the DISPLAY text, in
  // history it is the sent body (preamble stripped by userText, but mentions expanded,
  // bang/shell notes appended, a handoff block inserted). Exact equality missed those,
  // duplicated the turn and grafted the reply onto the wrong one (#18). A substantial
  // prefix/suffix overlap counts as the same turn too.
  // Fix2 (c26 #5 / deep #224, fourth M10): matching used to compare raw text only,
  // pairwise over every local for every remote (remote x local x text length).
  // - An attachment-only turn has empty text on BOTH sides and never matched, so
  //   it duplicated on every fetch; two empty turns now match when their replies
  //   agree (the reply is the evidence the text cannot give).
  // - A bare prefix/suffix overlap of as little as 8 chars grafted one turn's
  //   record onto a different turn that merely starts the same way; a weak
  //   overlap now needs to be substantial (>= 24 chars and at least half the
  //   longer text) or corroborated by an identical reply.
  // - Exact texts go through a map first, so the common case (the same long
  //   turns on both sides) is linear instead of quadratic; trimmed texts and
  //   replies are computed once, not per pair.
  const lText = local.map(l => String(l.user || '').trim());
  const lReply = local.map(l => String(l.reply || '').trim());
  const sameTurnAt = (li, t, b) => {
    const a = lText[li];
    if (!a || !b) return !a && !b && !!lReply[li] && lReply[li] === String(t.reply || '').trim();
    if (a === b) return true;
    const min = Math.min(a.length, b.length), max = Math.max(a.length, b.length);
    if (min < 8) return false;
    if (!(a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a))) return false;
    if (min >= 24 && min * 2 >= max) return true;
    return !!lReply[li] && lReply[li] === String(t.reply || '').trim();
  };
  const used = new Set(), pairs = []; // [localIndex, remoteIndex], in remote order
  const byText = new Map(); // exact trimmed text -> queue of local indexes
  lText.forEach((a, i) => { if (a) { const q = byText.get(a); if (q) q.push(i); else byText.set(a, [i]); } });
  const byReplyForEmpty = new Map(); // empty-text locals, keyed by their reply
  lText.forEach((a, i) => { if (!a && lReply[i]) { const q = byReplyForEmpty.get(lReply[i]); if (q) q.push(i); else byReplyForEmpty.set(lReply[i], [i]); } });
  const takeFrom = q => { while (q && q.length) { const i = q.shift(); if (!used.has(i)) return i; } return -1; };
  const merged = remote.map((t, ri) => {
    const b = String(t.user || '').trim();
    let li = b ? takeFrom(byText.get(b)) : takeFrom(byReplyForEmpty.get(String(t.reply || '').trim()));
    if (li < 0) li = local.findIndex((l, i) => !used.has(i) && sameTurnAt(i, t, b));
    if (li < 0) return t;
    used.add(li); pairs.push([li, ri]);
    return local[li]; // the richer local record stands in for its remote twin
  });
  const pool = local.filter((_, i) => !used.has(i)); // unmatched locals, in local order
  // Unmatched local turns are not only an older prefix: a local turn Muse's pages skipped (or
  // whose text differs) can sit between, or after, the fetched ones. When both sides carry
  // real timestamps, slot every leftover in by time across the whole range instead of
  // dropping the ones that are not older than everything Muse returned.
  const timed = pool.length && merged.length && pool.every(l => Number.isFinite(l.at) && l.at > 0) && merged.every(t => Number.isFinite(t.at) && t.at > 0);
  let keptUnmatched, turns;
  if (timed) {
    keptUnmatched = pool;
    turns = [...merged, ...pool].map((t, i) => [t, i]).sort((a, b) => (a[0].at - b[0].at) || (a[1] - b[1])).map(([t]) => t);
  } else {
    // No usable timestamps (history events often carry none): the old rule dropped EVERY
    // unmatched local turn when the fetch looked complete, and the stripped remote list
    // was then written back over the richer local record (#19). Never drop a local turn
    // for lack of a clock: merge the two sequences around their matched anchors, locals
    // before remotes inside each gap (both sides are chronological; exact interleaving
    // inside a gap is unknowable, preservation beats order).
    keptUnmatched = pool;
    const anchors = []; let lastLi = -1;
    for (const [li, ri] of pairs) if (li > lastLi) { anchors.push([li, ri]); lastLi = li; }
    turns = [];
    let liFrom = 0, riFrom = 0;
    for (const [li, ri] of anchors) {
      for (let i = liFrom; i < li; i++) if (!used.has(i)) turns.push(local[i]);
      for (let i = riFrom; i < ri; i++) turns.push(merged[i]);
      turns.push(local[li]);
      liFrom = li + 1; riFrom = ri + 1;
    }
    for (let i = liFrom; i < local.length; i++) if (!used.has(i)) turns.push(local[i]);
    for (let i = riFrom; i < merged.length; i++) turns.push(merged[i]);
  }
  // Fix2 (c26 #4, scenario 2): when the fetch stopped at the page cap (more), the
  // merged result is missing the older side Muse never returned; writing it
  // back made the local count the gate at the top compares against, so the
  // missing turns could never be fetched later. A partial merge is shown, not
  // cached. (Scenario 1 — a chat continued on ANOTHER device never raises this
  // PC's session.turns, so the gate still cannot see it; that needs a periodic
  // revalidation policy, recorded as DEFERRED in the rows file.)
  // Fix2 (third M24, transcript.js part): transcript files have no lock, so a
  // second window can append a finished turn while this merge runs. Re-read the
  // file just before writing and keep any turn that arrived after the snapshot
  // this merge started from, instead of overwriting it away. (The matching lock
  // in src/sessions.js itself belongs to that file's owner — cross-file note.)
  if (!more && turns.length >= local.length) {
    try {
      const fresh = sessions.transcript(session.id);
      const keyOf = t => JSON.stringify([t.at || 0, String(t.user || ''), String(t.reply || '')]);
      const have = new Map();
      for (const t of turns) have.set(keyOf(t), (have.get(keyOf(t)) || 0) + 1);
      const extra = [];
      for (const t of fresh) { const k = keyOf(t); if (have.get(k)) have.set(k, have.get(k) - 1); else extra.push(t); }
      let out = turns;
      if (extra.length) {
        out = [...turns, ...extra];
        if (out.every(t => Number.isFinite(t.at) && t.at > 0)) out = out.map((t, i) => [t, i]).sort((a, b) => (a[0].at - b[0].at) || (a[1] - b[1])).map(([t]) => t);
      }
      sessions.writeTranscript(session.id, out);
      turns = out;
    } catch {}
  }
  // Wave 15: `partial` must say "the display is missing turns the session
  // has" in BOTH shapes the controller's missingNote relies on it for:
  // - the fetch stopped at the page cap (more): Muse holds older turns
  //   these pages never reached. Unmatched local turns riding along in the
  //   merge do NOT make the fetch complete — the old
  //   `more && !keptUnmatched.length` went silent exactly there.
  // - the fetch completed (no more) yet the merged result still holds fewer
  //   turns than the session counts: some turns are simply not in either
  //   source, and with from:'muse' + partial:false the header counted the
  //   full session.turns with no note at all.
  return {turns, from: 'muse', partial: more || turns.length < (session.turns || 0)};
}

module.exports = {forResume, turnsFromHistory, userText, isSynthetic};
