'use strict';
// audit-cli wave 3 — jobs regressions (overnight queue / race / hunt).
// Pins the wave-3 fixes 570bcfd (overnight: queue parse errors are reported
// in words, poisoned items are dropped), e5d35b7 (race: state is written
// while the race runs, so a killed race can be loaded as interrupted and
// its wt-* worktrees cleaned up) and c0025bb (hunt: a killed run reads as
// interrupted instead of running forever, and the 5000-file collectFiles
// cut is reported as truncated with an approximate total).
// Style mirrors tests/audit-cli-w2-agent-state.test.js: isolated homes are
// set BEFORE any src module loads, state files are seeded in the exact
// shape the product writes, and nothing touches the resident Server or
// the real home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-home-'));

const queue = require('../src/overnight/queue');
const race = require('../src/race');
const hunt = require('../src/hunt');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-test-'));
  if (t) t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
// A pid that is provably dead right now: a child that already exited, and
// (paranoia against instant reuse) stepped forward until race's own
// liveness check agrees it is gone.
function deadPid() {
  let pid = spawnSync(process.execPath, ['-e', '']).pid;
  while (race.isPidAlive(pid)) pid++;
  return pid;
}

// ---------- (1) overnight: a broken queue.json is an error in words ----------

test('w3-1: overnight loadQueue throws a worded error for a broken queue.json, not a raw parse failure', (t) => {
  const broken = [
    '{ this is not json',               // torn / hand-mangled JSON
    '{"version":1}',                   // items missing entirely
    '{"version":1,"items":{}}',      // items is not an array
    'null',                             // valid JSON, no queue at all
    '[]',                               // an array is not a queue either
  ];
  for (const text of broken) {
    const baseDir = tmpdir(t);
    fs.writeFileSync(path.join(baseDir, 'queue.json'), text, 'utf8');
    // Wave 6 wording update: the broken-queue error is now worded in Japanese
    // and the bad file is moved aside as a backup (the old pin matched the
    // English 'overnight queue.json is broken' sentence).
    assert.throws(
      () => queue.loadQueue({baseDir}),
      e => e instanceof Error
        && /壊れています/.test(e.message)
        && /退避しました/.test(e.message)
        && e.message.includes(queue.queueFile({baseDir})),
      'broken input is reported in words, with the file named: ' + JSON.stringify(text));
  }
  // Control: no file at all is not broken — it is just an empty queue.
  assert.deepEqual(queue.loadQueue({baseDir: tmpdir(t)}), {version: 1, items: []});
});

test('w3-2: overnight loadQueue drops poisoned items and keeps the valid ones, in order', (t) => {
  const baseDir = tmpdir(t);
  const good1 = {id: 'ongood1', prompt: 'first', cwd: 'C:\\work', status: 'queued', createdAt: 1, questions: []};
  const good2 = {id: 'ongood2', prompt: 'second', cwd: 'C:\\work', status: 'done', createdAt: 2, questions: []};
  const items = [
    good1,
    null,                 // a null slipped into the array
    'a bare string',
    42,
    true,
    ['an', 'array'],      // arrays are objects to typeof — still not an item
    {},                   // no id at all
    {id: ''},            // an empty id matches nothing and identifies nothing
    {id: 123},            // a non-string id
    {id: null},
    {prompt: 'no id here'},
    good2,
  ];
  fs.writeFileSync(path.join(baseDir, 'queue.json'), JSON.stringify({version: 1, items}) + '\n', 'utf8');
  const loaded = queue.loadQueue({baseDir});
  assert.deepEqual(loaded.items, [good1, good2], 'only the two well-formed items survive, in file order');
});

// ---------- (2) race: a mid-run state file loads as interrupted, cleanup takes wt-* ----------

// The shape src/race.js writeRaceState/currentState writes from the first
// worktree on: finishedAt still null, status 'running', the writer's pid
// recorded, racers mid-flight.
function seedRaceState(t, pid) {
  const repo = tmpdir(t);
  const dir = path.join(tmpdir(t), 'race-state');
  fs.mkdirSync(dir, {recursive: true});
  const state = {
    id: '20261108-010203-abcd',
    task: 'w3 race task',
    cwd: repo,
    base: '0'.repeat(40),
    dir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    pid,
    totalTokens: null,
    racers: [
      {index: 1, strategy: race.STRATEGIES[0], account: null, worktree: path.join(dir, 'wt-1'), status: 'running'},
      {index: 2, strategy: race.STRATEGIES[1], account: null, worktree: path.join(dir, 'wt-2'), status: 'waiting'},
      {index: 3, strategy: race.STRATEGIES[2], account: null, worktree: path.join(dir, 'wt-3'), status: 'done', ok: true},
    ],
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return {repo, dir, state};
}

test('w3-3: race loadRace reads a running state whose writer died as interrupted', (t) => {
  const {dir} = seedRaceState(t, deadPid());
  const loaded = race.loadRace(dir);
  assert.ok(loaded, 'the mid-run race is loadable at all (its worktrees are reachable, not orphaned)');
  assert.equal(loaded.dir, dir);
  assert.equal(loaded.status, 'interrupted');
  assert.equal(loaded.interrupted, true);
  assert.equal(loaded.ownerAlive, false);
  assert.deepEqual(loaded.racers.map(r => r.status), ['interrupted', 'interrupted', 'done'],
    'waiting/running racers read as interrupted; a finished racer keeps its result');

  // Control: the same shape with a LIVE writer pid is a race still running,
  // not an interrupted one.
  const live = seedRaceState(t, process.pid);
  const liveLoaded = race.loadRace(live.dir);
  assert.equal(liveLoaded.status, 'running');
  assert.equal(liveLoaded.running, true);
  assert.ok(!liveLoaded.interrupted);
  assert.deepEqual(liveLoaded.racers.map(r => r.status), ['running', 'waiting', 'done']);
});

test('w3-4: race cleanupRace removes the wt-* worktrees of an interrupted race', async (t) => {
  const {repo, dir} = seedRaceState(t, deadPid());
  // wt-1 / wt-3 are listed by the racers; wt-2 exists on disk as the folder
  // of a racer the killed process had created but not yet recorded —
  // cleanup must take every wt-* folder in the state dir, listed or not.
  for (const name of ['wt-1', 'wt-2', 'wt-3']) {
    fs.mkdirSync(path.join(dir, name), {recursive: true});
    fs.writeFileSync(path.join(dir, name, 'marker.txt'), name + '\n', 'utf8');
  }
  const loaded = race.loadRace(dir);
  assert.equal(loaded.interrupted, true);
  await race.cleanupRace(loaded);
  assert.equal(fs.existsSync(path.join(dir, 'wt-1')), false, 'a listed worktree is gone');
  assert.equal(fs.existsSync(path.join(dir, 'wt-2')), false, 'an unlisted wt-* folder is gone too');
  assert.equal(fs.existsSync(dir), false, 'the whole race state folder is removed');
  assert.equal(fs.existsSync(repo), true, "the user's own tree is untouched");
});

// ---------- (3) hunt: a dead pid's running state reads as interrupted ----------

// The shape src/hunt.js saveState writes mid-run: phase 'audit', a group
// still 'running', updatedAt fresh, and the writer's pid recorded.
function seedHunt(t, pid) {
  const cwd = tmpdir(t);
  const dir = path.join(cwd, '.muser', 'hunt', '20261108-010203');
  fs.mkdirSync(dir, {recursive: true});
  const now = new Date().toISOString();
  const state = {
    version: 1, cwd, dir, phase: 'audit',
    startedAt: now, updatedAt: now, pid,
    estimate: null, findings: [],
    groups: [
      {index: 1, tag: 'h1', files: ['a.js'], status: 'running', findings: 0},
      {index: 2, tag: 'h2', files: ['b.js'], status: 'done', findings: 1},
    ],
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return {cwd, dir, state};
}

test('w3-5: hunt readStatus reads a running state with a dead pid as interrupted', (t) => {
  const {cwd, dir, state} = seedHunt(t, deadPid());
  assert.equal(hunt.staleRunning(state), true, 'a dead writer pid makes the running phase stale');
  const status = hunt.readStatus(cwd);
  assert.ok(status, 'the hunt state is readable');
  assert.equal(status.dir, dir);
  assert.equal(status.phase, 'interrupted', 'it no longer claims the hunt is still auditing');
  assert.equal(status.interrupted, true);
  assert.deepEqual(status.groups.map(g => g.status), ['interrupted', 'done'],
    'the still-running group reads as interrupted; the done group is unchanged');
  assert.match(hunt.formatStatusLines(status).join('\n'), /中断されました/, 'the status text says interrupted');

  // Control: a live writer pid with a fresh save is genuinely still running.
  const live = seedHunt(t, process.pid);
  assert.equal(hunt.staleRunning(live.state), false);
  assert.equal(hunt.readStatus(live.cwd).phase, 'audit');
});

// ---------- (4) hunt: collectFiles past the cap reports truncated + an approximate total ----------

test('w3-6: hunt collectFiles over the 5000 cap returns truncated and the approximate total', {timeout: 120000}, (t) => {
  assert.equal(hunt.MAX_FILES, 5000, 'the cap this test seeds past');
  // Small control first: under the cap nothing is truncated and the
  // approximate total is exact.
  const small = tmpdir(t);
  for (const name of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(small, name), '', 'utf8');
  const smallFiles = hunt.collectFiles(small);
  assert.equal(smallFiles.length, 3);
  assert.equal(smallFiles.truncated, false);
  assert.equal(smallFiles.totalApprox, 3);

  // MAX_FILES is a module-internal const with no injection seam, so the
  // over-cap case seeds real files just past it (5003 tiny empties).
  const big = tmpdir(t);
  const total = hunt.MAX_FILES + 3;
  for (let i = 0; i < total; i++) {
    fs.writeFileSync(path.join(big, 'f' + String(i).padStart(5, '0') + '.js'), '', 'utf8');
  }
  const files = hunt.collectFiles(big);
  assert.ok(Array.isArray(files));
  assert.equal(files.length, hunt.MAX_FILES, 'the collection stops at the cap');
  assert.equal(files.truncated, true, 'the cut is reported instead of silently passing as the whole tree');
  assert.equal(files.totalApprox, total, 'the walk kept counting past the cap, so the total approximates the full scope');
  // The metadata rides as non-enumerable properties: the result still
  // compares and serialises as a plain array of paths.
  assert.equal(JSON.parse(JSON.stringify(files)).length, hunt.MAX_FILES);
});
