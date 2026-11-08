'use strict';
// Audit-cli wave 9b: retention / ordering regression tests filling the gaps
// left by tests/audit-cli-w9.test.js (the login/account wave-9 fixes) —
//  (1) exec-status: a corrupt JSON file counts towards KEEP and is pruned;
//      latest() prefers the content's startedAt over the file name.
//  (2) worklog: prune survives an unreadable *.jsonl entry (a broken link);
//      while a referencing log cannot be read, its blobs are kept.
//  (3) crash: a report whose NAME is newest survives an old mtime; a
//      directory named *.json does not eat a KEEP slot.
//  (4) tell: a live peer's inbox is never pruned; a peer whose updatedAt is
//      too far in the future is swept.
//  (5) overnight parseAt: a past ISO moment is an error; a past HH:MM
//      rolls to tomorrow.
//  (6) focus: rev grows on every persistFocus save; saveFocus with a stale
//      `expected` rev writes nothing.
// Isolation follows tests/audit-cli-w9.test.js: pin temp data/home folders
// before any src module loads (secure-store resolves its DIR at require).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.MUSER_LANG = 'ja';
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w9b-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w9b-home-'));
test.after(() => { for (const d of [process.env.LOCALAPPDATA, process.env.USERPROFILE]) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });

function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  return d;
}
const pad2 = n => String(n).padStart(2, '0');

// ---------- (1) exec-status: corrupt files prune; latest() by startedAt ----------
const es = require('../src/exec-status');
const STATUS_NAME = /^\d{8}-\d{6}-\d+\.json$/;
function cleanExecDir() {
  const d = es.dir();
  fs.mkdirSync(d, {recursive: true});
  for (const n of fs.readdirSync(d)) fs.rmSync(path.join(d, n), {recursive: true, force: true});
  return d;
}
const statusNames = d => fs.readdirSync(d).filter(n => STATUS_NAME.test(n));

test('w9b exec-status (1): a corrupt JSON file counts towards KEEP and is pruned as the oldest excess', () => {
  const d = cleanExecDir();
  const corrupt = '20250101-000000-111.json'; // oldest by name stamp; content unreadable
  fs.writeFileSync(path.join(d, corrupt), '{not json');
  for (let i = 0; i < es.KEEP; i++) {
    fs.writeFileSync(path.join(d, '20250102-0000' + pad2(i) + '-222.json'),
      JSON.stringify({version: 1, state: 'done', exit: 0, startedAt: '2025-01-02T00:00:00.000Z'}));
  }
  assert.equal(statusNames(d).length, es.KEEP + 1, 'setup: KEEP valid files plus the corrupt one');
  es.prune();
  assert.ok(!fs.existsSync(path.join(d, corrupt)), 'the corrupt file was counted and pruned (it is not exempt forever)');
  assert.equal(statusNames(d).length, es.KEEP, 'exactly the excess went; every valid file stayed');
});

test('w9b exec-status (1): latest() prefers the content startedAt over the file name stamp', () => {
  const d = cleanExecDir();
  // The name says 2027 (a clock once set forward) but the run actually
  // started in 2025; the other file's name is older, its run newer.
  const futureNamed = '20270101-000000-1.json';
  const trulyNewer = '20260101-000000-2.json';
  fs.writeFileSync(path.join(d, futureNamed), JSON.stringify({version: 1, state: 'done', exit: 0, startedAt: '2025-01-01T00:00:00.000Z'}));
  fs.writeFileSync(path.join(d, trulyNewer), JSON.stringify({version: 1, state: 'done', exit: 0, startedAt: '2026-01-01T00:00:00.000Z'}));
  assert.equal(path.basename(es.latest()), trulyNewer, 'the run that started latest wins, not the future-named old run');
});

// ---------- (2) worklog: prune vs broken entries and unreadable referrers ----------
const {Worklog, sha256} = require('../src/worklog');
// An entry named *.jsonl that cannot be read as a file: a dangling symlink
// where the platform allows making one, else a folder wearing the name —
// both hit the same per-entry failure in prune().
function brokenLogEntry(dir, name) {
  const p = path.join(dir, name);
  try { fs.symlinkSync(path.join(dir, 'no-such-target.jsonl'), p, 'file'); }
  catch { fs.mkdirSync(p); }
  return p;
}
const entryExists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };

test('w9b worklog (2): a broken *.jsonl entry does not stop prune — the rest of the sweep still runs', t => {
  const dir = tmpdir(t, 'muser-w9b-wl-a-');
  fs.mkdirSync(path.join(dir, 'blobs'), {recursive: true});
  const oldFile = path.join(dir, 'old.jsonl');
  fs.writeFileSync(oldFile, JSON.stringify({v: 1, event: 'turn', text: 'old'}) + '\n');
  const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  fs.utimesSync(oldFile, past, past);
  const freshFile = path.join(dir, 'fresh.jsonl');
  fs.writeFileSync(freshFile, JSON.stringify({v: 1, event: 'turn', text: 'fresh'}) + '\n');
  const broken = brokenLogEntry(dir, 'broken.jsonl');
  const wl = new Worklog({sessionId: 'actor', dir, retentionDays: 30});
  assert.doesNotThrow(() => wl.prune(), 'one bad entry must not abort the whole retention sweep');
  assert.ok(!fs.existsSync(oldFile), 'the aged log was still collected');
  assert.ok(fs.existsSync(freshFile), 'the fresh log stayed');
  assert.ok(entryExists(broken), 'the broken entry itself was left alone');
});

test('w9b worklog (2): while a referencing log cannot be read, no blob is deleted; once readable, only the orphan goes', t => {
  const dir = tmpdir(t, 'muser-w9b-wl-b-');
  const blobDir = path.join(dir, 'blobs');
  fs.mkdirSync(blobDir, {recursive: true});
  const refHash = sha256('referenced before text');
  const orphanHash = sha256('orphan before text');
  fs.writeFileSync(path.join(blobDir, refHash), 'referenced before text');
  fs.writeFileSync(path.join(blobDir, orphanHash), 'orphan before text');
  const broken = brokenLogEntry(dir, 'refs.jsonl'); // the log that references refHash cannot be read this round
  const wl = new Worklog({sessionId: 'actor', dir});
  wl.prune();
  assert.ok(fs.existsSync(path.join(blobDir, refHash)), 'an unreadable referrer is not "references nothing": its blob survives');
  assert.ok(fs.existsSync(path.join(blobDir, orphanHash)), 'the GC does not run at all on an incomplete read');
  // Next round the referrer is readable again: the GC resumes — the
  // referenced blob stays, the truly unreferenced one is collected.
  fs.rmSync(broken, {recursive: true, force: true});
  fs.writeFileSync(path.join(dir, 'keeper.jsonl'), JSON.stringify({v: 1, event: 'edit', beforeHash: refHash}) + '\n');
  wl.prune();
  assert.ok(fs.existsSync(path.join(blobDir, refHash)), 'the referenced blob still survives');
  assert.ok(!fs.existsSync(path.join(blobDir, orphanHash)), 'the orphan blob is collected once reads are complete');
});

// ---------- (3) crash: embedded name time orders prune; *.json folders do not count ----------
const crash = require('../src/crash');
const CRASH_KEEP = 20; // src/crash.js KEEP (not exported)
function crashDir(t) {
  const d = tmpdir(t, 'muser-w9b-crash-');
  const saved = process.env.MUSER_CRASH_DIR;
  process.env.MUSER_CRASH_DIR = d;
  t.after(() => { if (saved === undefined) delete process.env.MUSER_CRASH_DIR; else process.env.MUSER_CRASH_DIR = saved; });
  return d;
}
const realJsonFiles = d => fs.readdirSync(d).filter(n => n.endsWith('.json') && fs.statSync(path.join(d, n)).isFile());

test('w9b crash (3): the report newest by its name time survives even with the oldest mtime', t => {
  const d = crashDir(t);
  const oldNames = [];
  for (let i = 0; i < CRASH_KEEP - 1; i++) {
    const n = '2026-01-01T00-00-' + pad2(i) + '-000Z-111-a' + i + '.json';
    oldNames.push(n);
    fs.writeFileSync(path.join(d, n), '{}');
  }
  // The name time must stay in the past: since wave 17 a future-named
  // report is evicted before any real one, so a future "newest" would
  // test that rule instead of the name-beats-mtime one.
  const newest = '2026-06-30T23-59-59-999Z-111-newest.json';
  fs.writeFileSync(path.join(d, newest), '{}');
  const ancient = new Date('2020-01-01T00:00:00Z'); // a restore reset its mtime into the past
  fs.utimesSync(path.join(d, newest), ancient, ancient);
  const written = crash.write({version: '9.9.9', error: new Error('fresh crash'), trail: [], state: {}});
  assert.ok(written, 'the fresh report was written (and triggered the prune)');
  assert.ok(fs.existsSync(path.join(d, newest)), 'newest by embedded name time survived despite the oldest mtime');
  assert.ok(!fs.existsSync(path.join(d, oldNames[0])), 'the embedded-oldest report was pruned instead');
  assert.equal(realJsonFiles(d).length, CRASH_KEEP, 'pruned back to KEEP reports');
});

test('w9b crash (3): a directory named *.json does not eat a KEEP slot', t => {
  const d = crashDir(t);
  const folder = '2099-01-01T00-00-00-000Z-111-folder.json';
  fs.mkdirSync(path.join(d, folder));
  for (let i = 0; i < CRASH_KEEP; i++) {
    fs.writeFileSync(path.join(d, '2026-02-01T00-00-' + pad2(i) + '-000Z-111-b' + i + '.json'), '{}');
  }
  const written = crash.write({version: '9.9.9', error: new Error('fresh crash'), trail: [], state: {}});
  assert.ok(written);
  assert.equal(realJsonFiles(d).length, CRASH_KEEP, 'real reports still fill all KEEP slots (the folder counted for nothing)');
  assert.ok(fs.statSync(path.join(d, folder)).isDirectory(), 'the folder itself was left alone');
});

// ---------- (4) tell: live inboxes survive; far-future peers are swept ----------
const tell = require('../src/tell');

test('w9b tell (4): a live peer keeps its inbox however old it is; a dead conversation inbox is pruned', t => {
  const base = path.join(tmpdir(t, 'muser-w9b-tell-a-'), 'tell');
  fs.mkdirSync(tell.peersDir({base}), {recursive: true});
  fs.mkdirSync(tell.inboxDir({base}), {recursive: true});
  const now = Date.now();
  const live = {kind: 'tell-peer', pid: process.pid, sessionId: 'live-sess', startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), files: []};
  fs.writeFileSync(tell.peerFile(process.pid, 'live-sess', {base}), JSON.stringify(live));
  const aged = new Date(now - 40 * 24 * 3600 * 1000); // past the 30-day inbox horizon
  const liveInbox = tell.inboxFile('live-sess', {base});
  fs.writeFileSync(liveInbox, JSON.stringify({text: 'still waiting'}) + '\n');
  fs.utimesSync(liveInbox, aged, aged);
  const deadInbox = tell.inboxFile('dead-sess', {base});
  fs.writeFileSync(deadInbox, JSON.stringify({text: 'nobody will drain this'}) + '\n');
  fs.utimesSync(deadInbox, aged, aged);
  tell.prunePeers({base, now, isAlive: pid => pid === process.pid});
  assert.ok(fs.existsSync(liveInbox), 'the live peer inbox survived the 30-day sweep');
  assert.ok(fs.existsSync(tell.peerFile(process.pid, 'live-sess', {base})), 'the live peer record stayed');
  assert.ok(!fs.existsSync(deadInbox), 'the ended conversation inbox was pruned (control)');
});

test('w9b tell (4): a peer whose updatedAt is too far in the future is swept; a fresh peer stays', t => {
  const base = path.join(tmpdir(t, 'muser-w9b-tell-b-'), 'tell');
  fs.mkdirSync(tell.peersDir({base}), {recursive: true});
  fs.mkdirSync(tell.inboxDir({base}), {recursive: true});
  const now = Date.now();
  const future = {kind: 'tell-peer', pid: process.pid, sessionId: 'future-sess', updatedAt: new Date(now + 3600 * 1000).toISOString(), files: []};
  const futureFile = tell.peerFile(process.pid, 'future-sess', {base});
  fs.writeFileSync(futureFile, JSON.stringify(future));
  const fresh = {kind: 'tell-peer', pid: process.pid, sessionId: 'fresh-sess', updatedAt: new Date(now).toISOString(), files: []};
  const freshFile = tell.peerFile(process.pid, 'fresh-sess', {base});
  fs.writeFileSync(freshFile, JSON.stringify(fresh));
  tell.prunePeers({base, now, isAlive: () => true});
  assert.ok(!fs.existsSync(futureFile), 'a heartbeat an hour in the future is not live: the record was swept');
  assert.ok(fs.existsSync(freshFile), 'the fresh peer record stayed (control)');
});

// ---------- (5) overnight parseAt ----------
const {parseAt} = require('../src/overnight/cli');

test('w9b overnight parseAt (5): a past ISO moment is an error; a future ISO returns as-is', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0, 0).getTime();
  const pastIso = new Date(now - 3600 * 1000).toISOString();
  assert.throws(() => parseAt(pastIso, now), /過去の時刻/, 'a past ISO moment must not silently mean "start now"');
  const futureIso = new Date(now + 3600 * 1000).toISOString();
  assert.equal(parseAt(futureIso, now), Date.parse(futureIso), 'a future ISO moment is returned unchanged');
});

test('w9b overnight parseAt (5): a past HH:MM rolls to tomorrow; a future HH:MM stays today', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0, 0).getTime();
  const rolled = parseAt('11:00', now);
  assert.ok(rolled > now, 'the result is in the future');
  const rd = new Date(rolled);
  assert.deepEqual([rd.getFullYear(), rd.getMonth(), rd.getDate(), rd.getHours(), rd.getMinutes()], [2026, 10, 9, 11, 0], 'same time of day, next day');
  const sameDay = new Date(parseAt('12:30', now));
  assert.deepEqual([sameDay.getDate(), sameDay.getHours(), sameDay.getMinutes()], [8, 12, 30], 'a later time of day stays today (control)');
});

// ---------- (6) focus: rev growth and stale-expected saves ----------
const sessions = require('../src/sessions');
const {Focus} = require('../src/focus');
const {Agent} = require('../src/agent');
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.subscribe = async () => {}; c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, id) {
  const cwd = tmpdir(t, 'muser-w9b-focus-cwd-');
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id, cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  t.after(() => { try { a.close(); } catch {} });
  return a;
}

test('w9b focus (6): rev grows by one on every persistFocus save', t => {
  const a = makeAgent(t, 'w9b-rev');
  const f = new Focus('w9b goal', {sessionCwd: a.cwd, sharedBackground: a.focusBackground});
  f.plan([{text: 'Do the thing', kind: 'manual'}]);
  a.persistFocus(f);
  let saved = sessions.loadFocus('w9b-rev');
  assert.ok(saved, 'the running task was saved');
  assert.equal(saved.rev, 1, 'the first save lands at rev 1');
  assert.equal(f.rev, 1);
  a.persistFocus(f);
  saved = sessions.loadFocus('w9b-rev');
  assert.equal(saved.rev, 2, 'the second save lands at rev 2');
  assert.equal(f.rev, 2);
  sessions.clearFocus('w9b-rev');
});

test('w9b focus (6): saveFocus with a stale expected rev writes nothing; the matching rev writes', () => {
  const id = 'w9b-stale';
  sessions.clearFocus(id);
  assert.equal(sessions.saveFocus(id, {rev: 2, marker: 'current'}), true);
  assert.equal(sessions.saveFocus(id, {rev: 3, marker: 'stale-write'}, {exists: true, rev: 1}), false, 'a save based on rev 1 is refused once the file is at rev 2');
  assert.deepEqual(sessions.loadFocus(id), {rev: 2, marker: 'current'}, 'the refused save changed nothing on disk');
  assert.equal(sessions.saveFocus(id, {rev: 9, marker: 'ghost'}, {exists: false, rev: 0}), false, 'a save expecting no file is refused while one exists');
  assert.deepEqual(sessions.loadFocus(id), {rev: 2, marker: 'current'}, 'still unchanged');
  assert.equal(sessions.saveFocus(id, {rev: 3, marker: 'next'}, {exists: true, rev: 2}), true, 'the current rev may save (control)');
  assert.deepEqual(sessions.loadFocus(id), {rev: 3, marker: 'next'});
  sessions.clearFocus(id);
});
