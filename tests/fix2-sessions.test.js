'use strict';
// fix2 A18: c15 Mediums for sessions.js / muse-steps.js / agent-skill.js, plus
// fourth M7 / M17 / M18 / M19 and the sessions side of third M24.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the store: secure-store resolves its DIR from LOCALAPPDATA at require time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-sessions-'));
process.env.LOCALAPPDATA = tmp;
for (const m of ['../src/secure-store', '../src/sessions']) delete require.cache[require.resolve(m)];
const sessions = require('../src/sessions');
const FILE = sessions.FILE;
const DIR = path.dirname(FILE);
fs.mkdirSync(DIR, {recursive: true});
after(() => fs.rmSync(tmp, {recursive: true, force: true}));

function resetStore() {
  fs.rmSync(FILE, {force: true}); fs.rmSync(FILE + '.lock', {force: true});
  if (fs.existsSync(DIR)) for (const f of fs.readdirSync(DIR)) if (f.includes('.corrupt-') || f.includes('.tmp-')) fs.rmSync(path.join(DIR, f), {force: true});
}
function disk() { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }

test('c15 #1b: a failed salvage rewrite puts the corrupt original back — the index is not lost', () => {
  resetStore();
  const good = [{id: 'sv-1', cwd: 'C:/w', title: 'one', turns: 2, created: 1, updated: 2}];
  const raw = JSON.stringify(good) + ',{"id":"sv-2","cwd":"C';
  fs.writeFileSync(FILE, raw);
  const origRename = fs.renameSync;
  fs.renameSync = (src, dest) => { if (dest === FILE && String(src).includes('.tmp-')) { const e = new Error('busy'); e.code = 'EPERM'; throw e; } return origRename(src, dest); };
  try {
    assert.deepEqual(sessions.recent().map(s => s.id), ['sv-1'], 'the salvaged list is still served from memory');
    assert.equal(fs.readFileSync(FILE, 'utf8'), raw, 'the original corrupt bytes are back in place for the next retry');
  } finally { fs.renameSync = origRename; }
  assert.deepEqual(sessions.recent().map(s => s.id), ['sv-1']);
  assert.deepEqual(disk().map(s => s.id), ['sv-1'], 'with the failure gone the salvage persists as a valid index');
});

test('c15 #2: a live-pid lock older than the age cap is stale (pid reuse cannot block forever)', () => {
  resetStore();
  const lock = FILE + '.lock';
  fs.writeFileSync(lock, 'deadwindowtoken:' + process.pid); // pid alive (ours) — the reuse shape
  const old = new Date(Date.now() - 20 * 60 * 1000); fs.utimesSync(lock, old, old);
  const s = sessions.create('C:/reuse'); sessions.touch(s, 'after reuse');
  assert.ok(sessions.find(s.id), 'the ancient lock was claimed and the write landed');
  assert.equal(fs.existsSync(lock), false);
});

test('c15 #3: an unreadable lock sleeps to the deadline and throws — no busy spin', {timeout: 30000}, () => {
  resetStore();
  const lock = FILE + '.lock';
  fs.writeFileSync(lock, 'holder:' + process.pid);
  const origRead = fs.readFileSync;
  let calls = 0;
  fs.readFileSync = (...a) => { if (String(a[0]) === lock) { calls++; const e = new Error('sharing violation'); e.code = 'EPERM'; throw e; } return origRead(...a); };
  const s = sessions.create('C:/spin');
  try { assert.throws(() => sessions.touch(s, 'x'), /locked by another muser window/); }
  finally { fs.readFileSync = origRead; fs.rmSync(lock, {force: true}); }
  assert.ok(calls > 10 && calls < 2000, `retries slept instead of spinning (read attempts: ${calls})`);
});

test('c15 #5: read-only recent/find degrade to the last good index on a transient read error; save still throws', () => {
  resetStore();
  const s = sessions.create('C:/deg'); sessions.touch(s, 'hello');
  assert.equal(sessions.recent().length, 1, 'prime the last-good cache');
  const origRead = fs.readFileSync;
  fs.readFileSync = (...a) => { if (String(a[0]) === FILE) { const e = new Error('sharing violation'); e.code = 'EPERM'; throw e; } return origRead(...a); };
  try {
    assert.deepEqual(sessions.recent().map(x => x.id), [s.id], 'recent() serves the last good index instead of throwing');
    assert.equal(sessions.find(s.id).id, s.id, 'find() degrades the same way');
    assert.throws(() => sessions.save({id: 'other-1', cwd: 'C:/x'}), /sharing violation/, 'the write path must never act on a guessed index');
  } finally { fs.readFileSync = origRead; fs.rmSync(FILE + '.lock', {force: true}); }
});

test('fourth M7: write and writeTranscript retry a transient EPERM rename instead of losing the update', () => {
  resetStore();
  const origRename = fs.renameSync;
  let fails = 2;
  fs.renameSync = (src, dest) => { if (String(src).includes('.tmp-') && fails > 0) { fails--; const e = new Error('reader has it open'); e.code = 'EPERM'; throw e; } return origRename(src, dest); };
  try {
    const s = sessions.create('C:/retry'); sessions.touch(s, 'lands anyway');
    assert.ok(disk().some(x => x.id === s.id), 'the index update survived the transient rename failure');
    fails = 2;
    sessions.writeTranscript(s.id, [{v: 1, at: 1, user: 'u', reply: 'r'}]);
    assert.deepEqual(sessions.transcript(s.id).map(t => t.user), ['u'], 'the transcript rewrite survived it too');
  } finally { fs.renameSync = origRename; }
  assert.deepEqual(fs.readdirSync(DIR).filter(f => f.includes('.tmp-')), [], 'no temp files left behind');
});

test('fourth M17: save/touch replace ONE entry — a different conversation sharing the id survives', () => {
  resetStore();
  fs.writeFileSync(FILE, JSON.stringify([
    {id: 'dup', cwd: 'C:/a', title: 'A', turns: 5, created: 1, updated: 1},
    {id: 'dup', cwd: 'C:/b', title: 'B', turns: 9, created: 2, updated: 2},
  ]));
  sessions.save({id: 'dup', cwd: 'C:/a', title: 'A2', turns: 5});
  let list = disk().filter(x => x.id === 'dup');
  assert.equal(list.length, 2, 'save() kept both entries');
  assert.ok(list.some(x => x.title === 'B' && x.turns === 9), 'the untouched conversation is intact');
  const mine = disk().find(x => x.title === 'A2');
  sessions.touch({...mine}, 'one more');
  list = disk().filter(x => x.id === 'dup');
  assert.equal(list.length, 2, 'touch() kept both entries too');
  assert.ok(list.some(x => x.title === 'B' && x.turns === 9));
});

test('fourth M18: a top-level wrapper object yields its inner sessions, not a ghost wrapper', () => {
  resetStore();
  const raw = JSON.stringify({id: 'wrapper', sessions: [{id: 'inner', title: 'real', cwd: 'C:/a', turns: 3, created: 1, updated: 9}]});
  fs.writeFileSync(FILE, raw);
  assert.deepEqual(sessions.recent().map(s => s.id), ['inner']);
  assert.deepEqual(disk().map(s => s.id), ['inner'], 'the rewritten index holds the real session, not the wrapper');
  const backup = fs.readdirSync(DIR).find(f => f.startsWith('sessions.json.corrupt-'));
  assert.ok(backup && fs.readFileSync(path.join(DIR, backup), 'utf8') === raw, 'the original bytes were backed aside');
});

test('fourth M19: garbage turns heal to sane integers on touch ("abc" -> 1, -4 -> 1, "10" -> 11)', () => {
  resetStore();
  fs.writeFileSync(FILE, JSON.stringify([
    {id: 'w-abc', cwd: 'C:/a', title: 'a', turns: 'abc', created: 1, updated: 1},
    {id: 'w-neg', cwd: 'C:/a', title: 'n', turns: -4, created: 1, updated: 1},
    {id: 'w-str', cwd: 'C:/a', title: 's', turns: '10', created: 1, updated: 1},
  ]));
  for (const id of ['w-abc', 'w-neg', 'w-str']) sessions.touch({...disk().find(x => x.id === id)}, 'hi');
  const byId = Object.fromEntries(disk().map(x => [x.id, x.turns]));
  assert.deepEqual(byId, {'w-abc': 1, 'w-neg': 1, 'w-str': 11});
  for (const id of ['w-abc', 'w-neg', 'w-str']) sessions.touch({...disk().find(x => x.id === id)}, 'hi');
  assert.deepEqual(Object.fromEntries(disk().map(x => [x.id, x.turns])), {'w-abc': 2, 'w-neg': 2, 'w-str': 12}, 'and they keep counting normally');
});

test('third M24 (sessions side): writeTranscript takes the sessions lock', {timeout: 30000}, () => {
  resetStore();
  const s = sessions.create('C:/tr');
  sessions.writeTranscript(s.id, [{v: 1, at: 1, user: 'u1', reply: 'r1'}]);
  assert.deepEqual(sessions.transcript(s.id).map(t => t.user), ['u1'], 'unlocked path works as before');
  const lock = FILE + '.lock';
  fs.writeFileSync(lock, 'otherwindow:' + process.pid); // live holder, fresh
  try { assert.throws(() => sessions.writeTranscript(s.id, [{v: 1, at: 2, user: 'u2', reply: 'r2'}]), /locked by another muser window/, 'a merge-back must not overwrite while another window holds the lock'); }
  finally { fs.rmSync(lock, {force: true}); }
  assert.deepEqual(sessions.transcript(s.id).map(t => t.user), ['u1'], 'the blocked rewrite changed nothing');
});

// ---- muse-steps.js: c15 #8 ----
const {MuseSteps} = require('../src/muse-steps');
const AK = 'goa' + 'l_actions'; // the feed key, split so it is written exactly
const act = (n, id, status, title) => ({action_index: n, id, status, title, subtitle: '', report: ''});

test('c15 #8 muse-steps: poisoned feed items are isolated — the valid step still shows', async () => {
  const feed = {days: [null, {activities: 'nope'}, {activities: [null, 42, {details: null}, {details: {activity_thread_agent_id: 'AG', [AK]: [null, 'x', act(1, 'pre-MSG-call_1', 'SUCCESS', 'Found 1 result')]}}, {details: {activity_thread_agent_id: 'AG', [AK]: 'nope'}}]}]};
  const steps = [];
  const s = new MuseSteps({request: async () => feed}, e => { if (e.step) steps.push(e.step.title); });
  const w = {turn: {}};
  try {
    s.note(w, {agent_id: 'AG', message_id: 'MSG'});
    await s.read();
    assert.deepEqual(steps, ['Found 1 result']);
  } finally { clearInterval(s.timer); clearTimeout(s.soon); }
});

test('c15 #8 muse-steps: a throwing onStep for one turn does not stop the next turn', async () => {
  const feed = {days: [{activities: [
    {details: {activity_thread_agent_id: 'A1', [AK]: [act(1, 'pre-M1-call', 'RUNNING', 'Running: First task')]}},
    {details: {activity_thread_agent_id: 'A2', [AK]: [act(1, 'pre-M2-call', 'RUNNING', 'Running: Second task')]}},
  ]}]};
  const running2 = [];
  const s = new MuseSteps({request: async () => feed}, e => {
    if (e.worker === w1) throw new Error('ui exploded');
    if (e.running !== undefined) running2.push(e.running);
  });
  const w1 = {turn: {}}, w2 = {turn: {}};
  try {
    s.note(w1, {agent_id: 'A1', message_id: 'M1'});
    s.note(w2, {agent_id: 'A2', message_id: 'M2'});
    await s.read();
    assert.deepEqual(running2, ['Second task'], 'turn 2 was processed after turn 1\'s callback threw');
    assert.equal(w2.turn.muse.running, 'Second task');
  } finally { clearInterval(s.timer); clearTimeout(s.soon); }
});

// ---- agent-skill.js: c15 #12–#16 ----
const ask = require('../src/agent-skill');
const madeDirs = [];
after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
function skillHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-ask-')); madeDirs.push(home);
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.codex'));
  return home;
}
const MARKER_BODY = '# Delegate to Muse with `muser exec`\n\nbody\n';
function putSkill(home, rel, md, extra) {
  const dir = path.join(home, rel, 'muser-exec');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  if (extra) fs.writeFileSync(path.join(dir, extra), 'mine\n');
  return dir;
}

test('c15 #14 agent-skill: a BOM copy and a name with a trailing comment still read as a copy', () => {
  const home = skillHome();
  putSkill(home, path.join('.claude', 'skills'), '\ufeff---\nname: muser-exec\n---\n' + MARKER_BODY);
  assert.equal(ask.status({env: {}, home})[0].state, 'copy', 'BOM no longer strands a genuine copy as foreign');
  putSkill(home, path.join('.claude', 'skills'), '---\nname: muser-exec # installed by muser\n---\n' + MARKER_BODY);
  assert.equal(ask.status({env: {}, home})[0].state, 'copy', 'a trailing comment is not part of the name');
});

test('c15 #12 agent-skill: a same-named foreign skill with its own files is never replaced or removed', () => {
  const home = skillHome();
  const dir = putSkill(home, path.join('.claude', 'skills'), '---\nname: muser-exec\n---\nmy own skill\n', 'helper-notes.md');
  assert.equal(ask.status({env: {}, home})[0].state, 'foreign');
  assert.equal(ask.install({env: {}, home, agents: ['claude']})[0].done, 'skipped');
  assert.equal(ask.remove({env: {}, home, agents: ['claude']})[0].done, 'none');
  assert.ok(fs.existsSync(path.join(dir, 'helper-notes.md')), 'the foreign skill is untouched');
});

test('c15 #12 agent-skill: a dangling link is ours only when it points at a muser-exec folder', () => {
  const home = skillHome();
  const skillsDir = path.join(home, '.claude', 'skills'); fs.mkdirSync(skillsDir, {recursive: true});
  const gone = path.join(home, 'gone');
  fs.mkdirSync(path.join(gone, 'skills', 'muser-exec'), {recursive: true});
  fs.mkdirSync(path.join(gone, 'other', 'other-skill'), {recursive: true});
  fs.symlinkSync(path.join(gone, 'skills', 'muser-exec'), path.join(skillsDir, 'muser-exec'), 'junction');
  fs.rmSync(path.join(gone, 'skills'), {recursive: true, force: true});
  assert.equal(ask.status({env: {}, home})[0].state, 'broken', 'a dangling link to a muser-exec is replaceable');
  assert.equal(ask.remove({env: {}, home, agents: ['claude']})[0].done, 'removed');
  fs.symlinkSync(path.join(gone, 'other', 'other-skill'), path.join(skillsDir, 'muser-exec'), 'junction');
  fs.rmSync(path.join(gone, 'other'), {recursive: true, force: true});
  assert.equal(ask.status({env: {}, home})[0].state, 'foreign', 'a dangling link to something else is left alone');
  assert.equal(ask.remove({env: {}, home, agents: ['claude']})[0].done, 'none');
});

test('c15 #15 agent-skill: a symlinked .codex-accounts home is listed', () => {
  const home = skillHome();
  const real = path.join(home, 'real-acct'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'auth.json'), '{}');
  fs.mkdirSync(path.join(home, '.codex-accounts'), {recursive: true});
  fs.symlinkSync(real, path.join(home, '.codex-accounts', 'linked'), 'junction');
  const dirs = ask.targets({env: {}, home}).map(t => path.relative(home, t.dir));
  assert.ok(dirs.includes(path.join('.codex-accounts', 'linked', 'skills')), 'the linked account is a target: ' + dirs.join(', '));
});

test('c15 #16 agent-skill: a junction alias of ~/.codex is ONE target, and install lands once', () => {
  const home = skillHome();
  const alias = path.join(home, 'codex-alias');
  fs.symlinkSync(path.join(home, '.codex'), alias, 'junction');
  const rows = ask.targets({env: {CODEX_HOME: alias}, home});
  assert.equal(rows.filter(r => r.agent === 'codex').length, 1, 'the alias does not double-process the same folder');
  const done = ask.install({env: {CODEX_HOME: alias}, home, agents: ['codex']});
  assert.deepEqual(done.map(r => r.done), ['link']);
  assert.equal(ask.status({env: {CODEX_HOME: alias}, home}).find(r => r.agent === 'codex').state, 'installed');
});

test('c15 #13 agent-skill: an empty remnant folder is replaced, the copy fallback is whole, and no lock/temp is left', () => {
  const home = skillHome();
  const skillsDir = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(skillsDir, 'muser-exec'), {recursive: true}); // interrupted-copy remnant
  assert.equal(ask.status({env: {}, home})[0].state, 'broken');
  assert.equal(ask.install({env: {}, home, agents: ['claude']})[0].done, 'link');
  assert.equal(ask.status({env: {}, home})[0].state, 'installed');
  assert.deepEqual(fs.readdirSync(skillsDir).filter(f => f.includes('.muser-tmp-') || f === '.muser-agent-skill.lock'), [], 'no temp copy or lock file left behind');
  // Fallback path: links unavailable -> the copy must arrive whole via temp+rename.
  const home2 = skillHome();
  const origSymlink = fs.symlinkSync;
  fs.symlinkSync = () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; };
  try { assert.equal(ask.install({env: {}, home: home2, agents: ['claude']})[0].done, 'copy'); }
  finally { fs.symlinkSync = origSymlink; }
  const copied = fs.readFileSync(path.join(home2, '.claude', 'skills', 'muser-exec', 'SKILL.md'), 'utf8');
  assert.equal(copied, fs.readFileSync(path.join(ask.source(), 'SKILL.md'), 'utf8'), 'the fallback copy is the whole distribution file');
  assert.equal(ask.status({env: {}, home: home2})[0].state, 'copy');
});

test('c15 #1a: salvage while the lock is already held persists in place — no window can read a momentarily missing index', () => {
  resetStore();
  const raw = JSON.stringify([{id: 'sv-a', cwd: 'C:/w', title: 'one', turns: 1, created: 1, updated: 1}, {id: 'sv-b', cwd: 'C:/w', title: 'two', turns: 2, created: 1, updated: 2}]) + ',{"id":"sv-c","cw';
  sessions.locked(() => {
    fs.writeFileSync(FILE, raw);
    assert.deepEqual(sessions.recent().map(s => s.id).sort(), ['sv-a', 'sv-b']);
    assert.deepEqual(disk().map(s => s.id).sort(), ['sv-a', 'sv-b'], 'persisted under the held lock, before any other window can look');
  });
});

test('c15 #4: lock release restoring a successor lock cannot overwrite a third lock created in the gap', () => {
  resetStore();
  fs.writeFileSync(FILE, '[]');
  const lock = FILE + '.lock';
  const origRename = fs.renameSync;
  let armed = true;
  fs.renameSync = (a, b) => { const r = origRename(a, b); if (armed && String(b).includes('.rel-')) { armed = false; fs.writeFileSync(lock, 'third-token:99999'); } return r; };
  try {
    sessions.locked(() => { // our lock was taken over as stale mid-hold; a successor lock sits there now
      fs.rmSync(lock, {force: true});
      fs.writeFileSync(lock, 'successor-token:12345');
    });
  } finally { fs.renameSync = origRename; }
  assert.equal(fs.readFileSync(lock, 'utf8'), 'third-token:99999', 'the third window lock survived the restore attempt');
  assert.deepEqual(fs.readdirSync(DIR).filter(f => f.includes('.rel-')), [], 'the moved-aside successor copy was dropped, not left');
  fs.rmSync(lock, {force: true});
});

test('third M24 (sessions side): appendTurn compaction re-reads inside the lock and keeps the just-finished turn', () => {
  resetStore();
  sessions.writeTranscript('big-1', [{v: 1, at: 1, user: 'old', reply: 'y'.repeat(2_200_000)}]);
  sessions.appendTurn('big-1', {v: 1, at: 2, user: 'newest', reply: 'small'});
  assert.deepEqual(sessions.transcript('big-1').map(t => t.user), ['newest'], 'over the byte cap the oldest drops, the newest turn is never the one cut');
});
