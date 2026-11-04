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

// t5 #11 (deep audit): the stale-lock test above only covers the legacy
// no-pid branch. The pid branches are the safety-critical ones: a lock whose
// holder is ALIVE must never be stolen (however old it looks), and a lock
// whose holder is dead must be claimable at once.
test('a lock held by a live pid is never stolen, however old it is', () => {
  const lock = sessions.FILE + '.lock';
  const content = 'a34livetoken:' + process.pid; // this process is alive by definition
  fs.writeFileSync(lock, content);
  const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  const s = sessions.create('C:/live');
  assert.throws(() => sessions.touch(s, 'must not land'), /locked by another muser window/, 'a live holder blocks until the acquire deadline instead of being robbed');
  assert.equal(fs.readFileSync(lock, 'utf8'), content, 'the live lock file is untouched');
  assert.equal(sessions.find(s.id), undefined, 'the blocked write never landed');
  fs.unlinkSync(lock);
});

test('a lock whose holder pid is dead is claimed at once', async () => {
  const {spawn} = require('node:child_process');
  const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  const deadPid = child.pid;
  await new Promise((res, rej) => { child.on('exit', res); child.on('error', rej); });
  const lock = sessions.FILE + '.lock';
  fs.writeFileSync(lock, 'a34deadtoken:' + deadPid);
  const s = sessions.create('C:/dead'); sessions.touch(s, 'after the holder died');
  assert.ok(sessions.find(s.id), 'the dead holder lock was stolen and the write landed');
  assert.equal(fs.existsSync(lock), false, 'the claimed lock is released afterwards');
});

// t5 #12 (deep audit): the corrupt-index salvage (backupCorrupt/salvage in
// src/sessions.js) had no test anywhere in this file: a truncated
// sessions.json must keep every complete entry, move the bad bytes aside,
// and rewrite a valid index so the next touch cannot wipe the survivors.
test('a truncated sessions.json is salvaged, backed aside and rewritten valid', () => {
  const good1 = {id: 'salv-a34-1', cwd: 'C:/s', title: 'first', created: 1, updated: 3000, turns: 1};
  const good2 = {id: 'salv-a34-2', cwd: 'C:/s', title: 'second', created: 2, updated: 2000, turns: 2};
  const raw = '[' + JSON.stringify(good1) + ',' + JSON.stringify(good2) + ',{"id":"salv-a34-3","tit';
  fs.writeFileSync(sessions.FILE, raw);
  const dir = path.dirname(sessions.FILE);
  const before = new Set(fs.readdirSync(dir));
  const ids = sessions.recent().map(s => s.id);
  assert.ok(ids.includes('salv-a34-1') && ids.includes('salv-a34-2'), 'both complete entries survive a truncated tail');
  assert.ok(!ids.includes('salv-a34-3'), 'the cut-off entry is dropped, not half-parsed');
  const backup = fs.readdirSync(dir).find(n => !before.has(n) && n.startsWith('sessions.json.corrupt-'));
  assert.ok(backup, 'the corrupt bytes were moved aside, not deleted');
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), raw, 'the backup holds the original corrupt bytes');
  const rewritten = JSON.parse(fs.readFileSync(sessions.FILE, 'utf8'));
  assert.deepEqual(rewritten.map(s => s.id).sort(), ['salv-a34-1', 'salv-a34-2'], 'the index on disk is valid JSON with the salvaged entries');
  const s = sessions.create('C:/after-salvage'); sessions.touch(s, 'next write');
  assert.ok(sessions.find('salv-a34-1'), 'a later touch does not wipe the salvaged entries');
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
