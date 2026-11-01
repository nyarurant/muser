'use strict';
// Runs with %LOCALAPPDATA% pointed at a temp folder, so the real sessions.json is never touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-store-'));
process.env.LOCALAPPDATA = home;
const sessions = require('../src/sessions');
const {forResume} = require('../src/transcript');
test.after(() => fs.rmSync(home, {recursive: true, force: true}));

const ev = (seq, role, id, text) => ({event_name: role === 'user' ? 'message.user' : 'message.assistant', role, message_id: id, seq, display_text: text, visibility: 'public', payload: {}});

// 2026-11-01 audit: resume replaced a long local transcript with what one page of Muse's history held.
test('resume keeps the local turns Muse did not return, and pages back through history', async () => {
  const id = 'keep-' + Date.now();
  for (let i = 1; i <= 4; i++) sessions.appendTurn(id, {v: 1, at: i, user: 'u' + i, reply: 'r' + i, tools: [], steps: [], todos: []});
  const pages = [];
  const client = {history: async (sid, before) => {
    pages.push(before);
    if (before === undefined) return {chat_events: [ev(11, 'user', 'm5', 'u5'), ev(12, 'assistant', 'a5', 'r5'), ev(13, 'user', 'm6', 'u6'), ev(14, 'assistant', 'a6', 'r6')], has_more: true};
    return {chat_events: [ev(9, 'user', 'm4', 'u4'), ev(10, 'assistant', 'a4', 'r4')], has_more: false};
  }};
  const r = await forResume({id, turns: 6}, client);
  assert.deepEqual(pages, [undefined, 11], 'second page asked for events before the oldest seen');
  assert.deepEqual(r.turns.map(x => x.user), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.deepEqual(sessions.transcript(id).map(x => x.user), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'], 'the file lost nothing');
});

test('sessions dropped from the 200-entry index take their transcripts with them', () => {
  const made = [];
  for (let i = 0; i < 203; i++) {
    const s = sessions.create('C:/x'); made.push(s);
    sessions.appendTurn(s.id, {v: 1, at: i, user: 'u', reply: 'r', tools: [], steps: [], todos: []});
    sessions.touch(s, 'task ' + i);
  }
  const kept = new Set(sessions.recent().map(s => s.id));
  assert.equal(kept.size, 200);
  for (const s of made.slice(0, 3)) assert.equal(fs.existsSync(sessions.transcriptFile(s.id)), false, 'dropped: transcript removed');
  for (const s of made.slice(-3)) assert.equal(fs.existsSync(sessions.transcriptFile(s.id)), true, 'kept: transcript stays');
});

test('a stale lock left by a crashed window does not block saving', () => {
  const lock = sessions.FILE + '.lock';
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  const s = sessions.create('C:/y'); sessions.touch(s, 'after a crash');
  assert.ok(sessions.find(s.id));
  assert.equal(fs.existsSync(lock), false);
});

test("parallel-agent sessions do not push the user's own sessions out of the index", () => {
  const mine = sessions.create('C:/mine'); sessions.appendTurn(mine.id, {v: 1, at: 1, user: 'mine', reply: 'r', tools: [], steps: [], todos: []});
  sessions.touch(mine, 'my own chat');
  for (let i = 0; i < 260; i++) { const s = {...sessions.create('C:/mine'), parent: mine.id}; sessions.touch(s, 'agent ' + i); }
  assert.ok(sessions.find(mine.id), 'still listed after 260 agent sessions');
  assert.ok(fs.existsSync(sessions.transcriptFile(mine.id)), 'and its transcript is kept');
  const all = JSON.parse(fs.readFileSync(sessions.FILE, 'utf8'));
  assert.equal(all.filter(s => s.parent).length, 50);
});
