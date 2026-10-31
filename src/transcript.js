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
  const at = Math.max(s.lastIndexOf('\nUser:\n'), s.lastIndexOf('\nTask:\n'));
  return at < 0 ? s : s.slice(at + 7);
}

// Chat events -> turns: each user message starts one; its reply is the last assistant message after it.
function turnsFromHistory(events) {
  const byId = new Map();
  for (const e of events || []) { const m = messageFromEvent(e); if (m) byId.set(m.id, m); }
  const msgs = [...byId.values()].sort((a, b) => a.seq - b.seq || a.time - b.time);
  const turns = [];
  for (const m of msgs) {
    if (m.role === 'user') turns.push({v: 1, at: m.time || 0, user: userText(m.content), reply: '', tools: [], steps: [], sources: [], todos: [], from: 'muse'});
    else if (turns.length) turns[turns.length - 1].reply = m.content;
  }
  return turns;
}

async function forResume(session, client) {
  const local = sessions.transcript(session.id);
  if (local.length >= (session.turns || 0) || !client?.history) return {turns: local, from: 'local'};
  const history = await client.history(session.id);
  const remote = turnsFromHistory(history?.chat_events);
  if (!remote.length) return {turns: local, from: 'local'};
  // Keep the richer local record (tools, steps, todos) wherever the same user message is in both.
  const pool = [...local];
  const merged = remote.map(t => { const i = pool.findIndex(l => l.user === t.user); return i < 0 ? t : pool.splice(i, 1)[0]; });
  try { sessions.writeTranscript(session.id, merged); } catch {}
  return {turns: merged, from: 'muse', partial: !!history?.has_more};
}

module.exports = {forResume, turnsFromHistory, userText};
