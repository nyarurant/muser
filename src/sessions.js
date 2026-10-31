'use strict';
// Local index of muser sessions (each one is a Muse side chat), for resume / --continue.
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./secure-store');

const FILE = store.file('sessions.json');

// A corrupt index must never be silently wiped: move the bad file aside with a
// timestamp and only then start empty, so the original bytes survive for recovery.
function backupCorrupt() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(FILE, FILE + '.corrupt-' + stamp); } catch {}
}
function all() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  try { const list = JSON.parse(raw); if (Array.isArray(list)) return list; } catch {}
  backupCorrupt();
  return [];
}
// Atomic save: write a uniquely named temp file, then rename over the target, so a
// crash mid-write can never leave a truncated sessions.json behind.
function write(list) {
  fs.mkdirSync(store.DIR, {recursive: true});
  const temp = FILE + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(list.slice(-200), null, 1));
    fs.renameSync(temp, FILE);
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

function create(cwd) { return {id: crypto.randomUUID(), cwd, title: '', created: Date.now(), updated: Date.now(), turns: 0}; }
function touch(session, text) {
  session.turns++; session.updated = Date.now();
  if (!session.title) session.title = String(text).replace(/\s+/g, ' ').slice(0, 60);
  const list = all().filter(s => s.id !== session.id); list.push(session); write(list);
}
function recent(cwd) { return all().filter(s => !s.parent && (!cwd || s.cwd.toLowerCase() === cwd.toLowerCase())).sort((a, b) => b.updated - a.updated); }
// Every session whose id is `ref` (exact) or starts with `ref` (prefix).
function findAll(ref) {
  if (!ref) return [];
  const list = all();
  const exact = list.filter(s => s && s.id === ref);
  if (exact.length) return exact;
  return list.filter(s => s && typeof s.id === 'string' && s.id.startsWith(ref));
}
// Unique match or falsy, as callers expect. A prefix matching several sessions is
// ambiguous: return null and set find.ambiguous (use findAll to list candidates)
// instead of silently resuming an arbitrary one. An exact full-id match always wins.
function find(ref) {
  find.ambiguous = false;
  if (!ref) return undefined;
  const matches = findAll(ref);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) { find.ambiguous = true; return null; }
  return undefined;
}
find.ambiguous = false;

// ---- Transcripts: one JSONL file per session, one line per finished turn of the main chat
// ({at, user, reply, error?, tools, steps, sources, todos}). Appending a line is all a turn
// costs, and a crash can only cut the last line, which reading skips. /resume shows these
// instead of fetching the chat from Muse; Muse is asked only when the file has fewer turns.
const TRANSCRIPTS = require('node:path').join(store.DIR, 'transcripts');
function transcriptFile(id) { return require('node:path').join(TRANSCRIPTS, String(id).replace(/[^A-Za-z0-9-]/g, '') + '.jsonl'); }
function appendTurn(id, turn) {
  if (!id) return;
  try { fs.mkdirSync(TRANSCRIPTS, {recursive: true}); fs.appendFileSync(transcriptFile(id), JSON.stringify(turn) + '\n'); } catch {}
}
function transcript(id) {
  let raw;
  try { raw = fs.readFileSync(transcriptFile(id), 'utf8'); } catch { return []; }
  return raw.split('\n').map(line => { try { return line.trim() ? JSON.parse(line) : null; } catch { return null; } }).filter(t => t && typeof t === 'object');
}
function writeTranscript(id, turns) {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  const file = transcriptFile(id), temp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(temp, turns.map(t => JSON.stringify(t)).join('\n') + (turns.length ? '\n' : '')); fs.renameSync(temp, file); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}

module.exports = {create, touch, recent, find, findAll, FILE, appendTurn, transcript, writeTranscript, transcriptFile, TRANSCRIPTS};
