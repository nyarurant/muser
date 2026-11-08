'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the store: secure-store resolves its DIR from LOCALAPPDATA at require time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-sessions-'));
process.env.LOCALAPPDATA = tmp;
for (const m of ['../src/secure-store', '../src/sessions']) delete require.cache[require.resolve(m)];
const sessions = require('../src/sessions');
const FILE = sessions.FILE;
const DIR = path.dirname(FILE);

after(() => fs.rmSync(tmp, {recursive: true, force: true})); // B8: the mkdtemp store is removed once the file is done

function seed(id) { const s = sessions.create('C:\\work'); s.id = id; sessions.touch(s, 'hello'); return s; }
function leftovers() { return fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.includes('.tmp-')) : []; }
function corruptBackups() { return fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.startsWith('sessions.json.corrupt-')) : []; }
// B1: every test starts from an EMPTY store. The tests used to share one mutable
// index, so e.g. the corrupt-backup count below only held because the salvage
// test ran before it and hand-deleted the backups it had created; run in any
// other order (or alone after a salvage) the count was wrong.
function resetStore() {
  fs.rmSync(FILE, {force: true}); fs.rmSync(FILE + '.lock', {force: true});
  for (const f of corruptBackups()) fs.rmSync(path.join(DIR, f), {force: true});
  for (const f of leftovers()) fs.rmSync(path.join(DIR, f), {force: true});
}

test('atomic save: file stays valid JSON and no temp files are left behind', () => {
  resetStore();
  seed('11111111-aaaa');
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.ok(Array.isArray(list) && list.some(s => s.id === '11111111-aaaa'));
  assert.deepEqual(leftovers(), []);
});

test('find: exact match wins, unique prefix resolves, ambiguous prefix returns null + flag', () => {
  resetStore();
  seed('aaaa-1111'); seed('aaaa-2222'); seed('ab'); seed('abcd'); seed('cccc-3333');
  assert.equal(sessions.find('cccc').id, 'cccc-3333');
  assert.equal(sessions.find.ambiguous, false);
  assert.equal(sessions.find('ab').id, 'ab', 'exact full-id match beats prefix ambiguity');
  assert.equal(sessions.find('aaaa'), null);
  assert.equal(sessions.find.ambiguous, true);
  assert.deepEqual(sessions.findAll('aaaa').map(s => s.id).sort(), ['aaaa-1111', 'aaaa-2222']);
  assert.equal(sessions.find('zzzz'), undefined);
  assert.equal(sessions.find.ambiguous, false);
});

test('#55: a truncated index is salvaged, not emptied — complete entries survive and the next touch keeps them', () => {
  resetStore();
  const good = [
    {id: 'salv-1', cwd: 'C:\\work', title: 'one', turns: 2, created: 1, updated: 2},
    {id: 'salv-2', cwd: 'C:\\work', title: 'two', turns: 1, created: 1, updated: 3},
  ];
  fs.writeFileSync(FILE, JSON.stringify(good) + ',{"id":"salv-3","cwd":"C:\\w');
  assert.deepEqual(sessions.recent().map(s => s.id), ['salv-2', 'salv-1'], 'the two complete entries are recovered');
  seed('salv-9');
  const ids = JSON.parse(fs.readFileSync(FILE, 'utf8')).map(s => s.id).sort();
  assert.deepEqual(ids, ['salv-1', 'salv-2', 'salv-9'], 'the salvaged entries were persisted, not overwritten by a 1-entry index');
  // No hand-cleanup of this test's corrupt backups: the corrupt test below
  // resets the store itself and counts relative to what it found (B1).
});

test('#53/#54: save/touch merge with the stored entry (other-window metadata and turns survive); a failed touch rolls the counter back', () => {
  resetStore();
  const s = seed('merge-1');
  // Another window enriches the stored entry behind this object's back.
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const stored = list.find(x => x.id === 'merge-1');
  stored.goal = 'other window goal'; stored.turns = 10;
  fs.writeFileSync(FILE, JSON.stringify(list));
  sessions.save(s);
  let now = JSON.parse(fs.readFileSync(FILE, 'utf8')).find(x => x.id === 'merge-1');
  assert.equal(now.goal, 'other window goal', 'stored-only metadata was not overwritten away');
  assert.equal(now.turns, 10, 'turns never moves backwards');
  sessions.touch(s, 'next');
  now = JSON.parse(fs.readFileSync(FILE, 'utf8')).find(x => x.id === 'merge-1');
  assert.equal(now.turns, 11, 'the new turn counts on top of the stored count');
  assert.equal(now.goal, 'other window goal');
  // A write that cannot land (the index path is a folder, so all() throws)
  // must not leave the in-memory counter ahead of disk.
  const victim = {...sessions.create('C:\\work'), turns: 5};
  fs.rmSync(FILE); fs.mkdirSync(FILE);
  try { assert.throws(() => sessions.touch(victim, 'boom')); assert.equal(victim.turns, 5, 'turns rolled back after the failed write'); }
  finally { fs.rmSync(FILE, {recursive: true, force: true}); }
});

test('#50: a live lock is never bypassed — touch waits, then throws, instead of writing unlocked', {timeout: 30000}, () => {
  resetStore();
  const lock = FILE + '.lock';
  fs.writeFileSync(lock, 'someone-else:' + process.pid); // a lock whose holder process is alive: never stale, never bypassed
  const s = sessions.create('C:\\work');
  const t0 = Date.now();
  try {
    // Wave 6 wording update: the lock error is worded in Japanese now (was
    // the English 'sessions index is locked by another muser window').
    assert.throws(() => sessions.touch(s, 'must not land'), /会話の一覧が別の muser の窓で使用中です/);
    assert.ok(Date.now() - t0 >= 5000, 'it waited past the stale threshold instead of spinning for 2 s and running unlocked');
    assert.equal(sessions.find(s.id), undefined, 'nothing was written without the lock');
  } finally { fs.rmSync(lock, {force: true}); }
});

test('corrupt JSON is backed up aside, not wiped, and the store recovers', () => {
  resetStore();
  const before = corruptBackups().length;
  fs.writeFileSync(FILE, 'not json{{{');
  assert.deepEqual(sessions.recent(), []);
  const backups = corruptBackups();
  assert.equal(backups.length, before + 1, 'exactly one new backup, whatever earlier tests left behind');
  const mine = backups.find(f => fs.readFileSync(path.join(DIR, f), 'utf8') === 'not json{{{');
  assert.ok(mine, 'original bytes survive in the new backup');
  seed('dddd-4444');
  assert.equal(sessions.find('dddd').id, 'dddd-4444');
  assert.deepEqual(leftovers(), []);
});

test('origin: create() marks only when asked, and the mark survives touch/save round-trips', () => {
  resetStore();
  const marked = sessions.create('C:\\work', 'exec');
  assert.equal(marked.origin, 'exec');
  const plain = sessions.create('C:\\work');
  assert.ok(!('origin' in plain), 'no origin key at all for an interactive conversation');
  assert.ok(!('origin' in sessions.create('C:\\work', '')), 'an empty origin is no mark');
  assert.ok(!('origin' in sessions.create('C:\\work', 42)), 'a non-string origin is no mark');
  sessions.touch(marked, 'hello from exec');
  let stored = JSON.parse(fs.readFileSync(FILE, 'utf8')).find(x => x.id === marked.id);
  assert.equal(stored.origin, 'exec', 'the mark is written to sessions.json');
  assert.equal(sessions.find(marked.id).origin, 'exec', 'the mark is read back');
  sessions.save(marked);
  stored = JSON.parse(fs.readFileSync(FILE, 'utf8')).find(x => x.id === marked.id);
  assert.equal(stored.origin, 'exec', 'save() keeps the mark');
  // A stored mark also survives a later save/touch from an object that does
  // not carry it (mergeStored: stored-only metadata wins over absence).
  const bare = {...marked}; delete bare.origin;
  sessions.save(bare);
  stored = JSON.parse(fs.readFileSync(FILE, 'utf8')).find(x => x.id === marked.id);
  assert.equal(stored.origin, 'exec', 'a stored mark is not erased by an unmarked object');
});

test('origin: an old index without the field, and one with it, both load; garbage marks heal away', () => {
  resetStore();
  const old = [
    {id: 'old-1', cwd: 'C:\\work', title: 'before origin existed', turns: 2, created: 1, updated: 2},
    {id: 'exec-1', cwd: 'C:\\agent', title: 'from exec', turns: '3', created: 1, updated: 5, origin: 'exec'},
    {id: 'junk-1', cwd: 'C:\\work', title: 'hand-edited', turns: 1, created: 1, updated: 4, origin: 42},
  ];
  fs.writeFileSync(FILE, JSON.stringify(old));
  const list = sessions.recent();
  assert.deepEqual(list.map(s => s.id), ['exec-1', 'junk-1', 'old-1'], 'every entry still loads');
  assert.equal(list.find(s => s.id === 'exec-1').origin, 'exec', 'a stored mark survives validEntries');
  assert.equal(list.find(s => s.id === 'exec-1').turns, 3, 'turns healing still applies alongside origin');
  assert.ok(!('origin' in list.find(s => s.id === 'old-1')), 'an entry without the field stays without it');
  assert.ok(!('origin' in list.find(s => s.id === 'junk-1')), 'a non-string origin is dropped, the entry kept');
});

test('origin: a salvaged entry keeps its mark', () => {
  resetStore();
  const good = [{id: 'salv-exec', cwd: 'C:\\agent', title: 'exec chat', turns: 1, created: 1, updated: 2, origin: 'exec'}];
  fs.writeFileSync(FILE, JSON.stringify(good) + ',{"id":"salv-tail","cwd":"C:\\w');
  const list = sessions.recent();
  assert.deepEqual(list.map(s => s.id), ['salv-exec'], 'the complete entry is recovered');
  assert.equal(list[0].origin, 'exec', 'salvage does not drop the mark');
});
