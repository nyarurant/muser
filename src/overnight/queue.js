'use strict';
// The overnight queue and its small pure helpers (design new-features.md §8).
// Storage: %LOCALAPPDATA%\muser\overnight\queue.json — {version:1, items:[…]}.
// An item: {id, prompt, cwd, account?, status, createdAt, startedAt?, endedAt?,
//   branch?, worktree?, session?, tokens?, agents?, questions: [], note?,
//   badge?, error?}. status: queued | running | done | blocked | deferred |
//   failed | skipped | uncommitted. Records live only on this PC; prompts are the user's own
//   words for the run and are stored nowhere else, and no secret file content
//   is ever copied into an item (results keep a one-line summary, not output).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {t} = require('../i18n');
const {renameRetry} = require('../config');
const pool = require('../worktree-pool.js');

function baseDir(opts = {}) {
  if (opts.baseDir) return opts.baseDir;
  if (opts.dir) return opts.dir;
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(root, 'muser', 'overnight');
}
function queueFile(opts = {}) { return path.join(baseDir(opts), 'queue.json'); }
function reportsDir(opts = {}) { return path.join(baseDir(opts), 'reports'); }
// The task worktrees live OUTSIDE %LOCALAPPDATA%\muser: that folder is muser's own
// settings/credentials and every write under it asks first (policy.js muserSettingsPath),
// so in the default edit-auto night mode every edit in a worktree there was refused and
// no task could change a file (found on a real run). A sibling folder is not protected.
function worktreesDir(opts = {}) {
  if (opts.baseDir || opts.dir) return path.join(baseDir(opts), 'worktrees');
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(root, 'muser-work', 'overnight');
}

// A broken queue must not be a dead end, and its bytes must not be lost:
// like sessions' corrupt-index backup, the bad file is moved aside with a
// timestamp first (its contents are the only copy of the queued prompts),
// and the error says so — the next run then starts from a fresh queue.
// When the move itself fails, the error still names the way out: move or
// delete the file by hand and a new queue is created.
function brokenQueueError(opts) {
  const file = queueFile(opts);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = file + '.corrupt-' + stamp;
  try {
    fs.renameSync(file, dest);
    return new Error(t('夜間作業のキュー ({file}) が壊れています。元のファイルは {backup} に退避しました。このままもう一度実行すれば、新しいキューを作り直します。', {file, backup: dest}));
  } catch {}
  return new Error(t('夜間作業のキュー ({file}) が壊れています。そのファイルを退避するか削除すれば、新しいキューを作り直せます。', {file}));
}
// The statuses this version knows (the header comment lists them). An item
// carrying anything else — no status at all, or a value a newer/older
// version wrote — used to pass loadQueue untouched and then fall out of
// EVERY later step: estimate and the run's pending list only pick up
// queued/deferred, and the early-stop unrun report is built from that same
// pending list, so the item showed in the list yet was never run, never
// counted and never reported (wave 18; a version:99 file with two
// status-less items kept them invisibly forever).
const KNOWN_STATUSES = ['queued', 'running', 'done', 'blocked', 'deferred', 'failed', 'skipped', 'uncommitted'];
function loadQueue(opts = {}) {
  let text;
  try { text = fs.readFileSync(queueFile(opts), 'utf8'); } catch { return {version: 1, items: []}; }
  let q;
  try { q = JSON.parse(text); } catch { throw brokenQueueError(opts); }
  if (!q || !Array.isArray(q.items)) throw brokenQueueError(opts);
  q.items = q.items.filter(i => i && typeof i === 'object' && !Array.isArray(i) && typeof i.id === 'string' && i.id.length > 0);
  // Park an unknown/missing status as deferred, visibly: the original value
  // is kept on invalidStatus (run.js reports the item as deferred with this
  // reason instead of running work whose state it cannot know), and the
  // reason itself rides on note so the list and the morning report show it.
  // The note is stored data, written once here — a later load sees the
  // parked 'deferred', which is known, and leaves the item alone, so the
  // reason never piles up. Known statuses are not touched at all.
  for (const item of q.items) {
    if (KNOWN_STATUSES.includes(item.status)) continue;
    const raw = typeof item.status === 'string' ? item.status.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
    item.invalidStatus = raw || null;
    item.status = 'deferred';
    const reason = raw
      ? '状態 (status) が「' + raw + '」で、この版では読めないため、実行せず判断待ちにしました。元の頼みを確かめてから積み直してください。'
      : '状態 (status) が入っていないため、実行せず判断待ちにしました。元の頼みを確かめてから積み直してください。';
    item.note = typeof item.note === 'string' && item.note ? item.note + ' ' + reason : reason;
  }
  return q;
}
function saveQueue(queue, opts = {}) {
  const file = queueFile(opts);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  // No direct-write fallback: a kill during one tears queue.json — the only
  // copy of the queued prompts — and bricks the queue. renameRetry rides out
  // a reader holding the file on Windows; if the rename still fails, throw
  // and leave the previous queue.json untouched.
  try {
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 1) + '\n', 'utf8');
    renameRetry(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return file;
}

// --- file locks (wave 15) ---------------------------------------------------
// Every queue writer used to load -> mutate -> save the whole file on its
// own, so two writers at once lost each other's work: a CLI `add` landing
// while a run (or another add) held an older copy in memory was silently
// erased by the next save (W1-11). Now every writer goes through
// updateQueue below, which holds this lock across the whole
// read-modify-write. The lock shape follows sessions.locked: the file
// carries `token:pid`, a live holder is never stolen, a dead holder's lock
// (or a pid-less lock older than a few seconds) is reclaimed by atomically
// renaming it aside, contention sleeps instead of spinning, and release
// renames aside first so a successor's lock is never deleted.
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { try { Atomics.wait(WAIT_CELL, 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} } }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
const heldLocks = new Map(); // lock path -> {token, content, depth}
function queueLockBusyError() { return new Error(t('夜間作業のキューが別の処理で使用中です。終わるまで待ってからもう一度試してください。')); }
function releaseFileLock(lock) {
  const held = heldLocks.get(lock);
  if (!held) return;
  if (--held.depth > 0) return;
  heldLocks.delete(lock);
  const rel = lock + '.rel-' + held.token;
  try { fs.renameSync(lock, rel); } catch { return; } // already gone (taken as stale)
  try {
    if (fs.readFileSync(rel, 'utf8') === held.content) { try { fs.unlinkSync(rel); } catch {} }
    else { try { fs.linkSync(rel, lock); try { fs.unlinkSync(rel); } catch {} } catch { try { fs.unlinkSync(rel); } catch {} } } // a successor's lock: put it back without overwriting a newer one
  } catch {}
}
function acquireFileLock(lock, {timeoutMs = 7000} = {}) {
  if (heldLocks.has(lock)) { heldLocks.get(lock).depth++; return () => releaseFileLock(lock); }
  const token = crypto.randomBytes(16).toString('hex');
  const content = token + ':' + process.pid;
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (e.code !== 'EEXIST') { if (Date.now() > until) throw e; sleepSync(25); continue; }
      let stale = false;
      try {
        const held = fs.readFileSync(lock, 'utf8');
        const ownerPid = Number((held.split(':')[1] || '').trim());
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        // Queue updates finish in milliseconds, so even a live holder's
        // lock is stale after 15 minutes (a recycled pid must not block
        // the queue forever); a pid-less legacy lock after 5 seconds.
        stale = ownerPid > 0 ? (!pidAlive(ownerPid) || age > 15 * 60 * 1000) : age > 5000;
      } catch { if (Date.now() > until) throw queueLockBusyError(); sleepSync(15); continue; }
      if (stale) { const grave = lock + '.stale-' + token; try { fs.renameSync(lock, grave); } catch { continue; } try { fs.unlinkSync(grave); } catch {} continue; }
      if (Date.now() > until) throw queueLockBusyError();
      sleepSync(15);
    }
  }
  heldLocks.set(lock, {token, content, depth: 1});
  return () => releaseFileLock(lock);
}
function queueLockFile(opts = {}) { return queueFile(opts) + '.lock'; }

// The one way to change the queue (wave 15): load, mutate and save under
// the queue lock, so concurrent writers — two CLI adds, an add during a
// run, a remove racing a run save — serialise instead of overwriting each
// other. The mutator's return value is passed through; when the mutator
// throws, nothing is saved. loadQueue/saveQueue stay as the raw
// primitives (reads, and the merge inside a run, which calls this).
function updateQueue(mutator, opts = {}) {
  const release = acquireFileLock(queueLockFile(opts));
  try {
    const queue = loadQueue(opts);
    const result = mutator(queue);
    saveQueue(queue, opts);
    return result !== undefined ? result : queue;
  } finally { release(); }
}

// --- the run lock (wave 15) ---------------------------------------------------
// One overnight run at a time, across processes: two `start`s used to run
// the same queue twice, and each run's saves fought the other's. The lock
// is an exclusively-created file carrying the runner's pid; a live pid
// means a run really is in progress (however long it takes — no age-based
// stealing, a night run legitimately lasts hours), a dead pid's lock is
// reclaimed so a crashed night never blocks the next one.
function runLockFile(opts = {}) { return path.join(baseDir(opts), 'run.lock'); }
function runLockedError(pid) { const e = new Error(t('夜間作業はすでに実行中です（プロセス {pid}）。終わるまで待ってください。', {pid: pid || '?'})); e.code = 'overnight-running'; return e; }
function acquireRunLock(opts = {}) {
  const lock = runLockFile(opts);
  if (heldLocks.has(lock)) throw runLockedError(process.pid);
  const token = crypto.randomBytes(16).toString('hex');
  const content = token + ':' + process.pid;
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  const until = Date.now() + 2000; // grace only for a lock still being written
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx'); try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let ownerPid = 0, age = Infinity;
      try { ownerPid = Number((fs.readFileSync(lock, 'utf8').split(':')[1] || '').trim()) || 0; age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      if (ownerPid > 0 && pidAlive(ownerPid)) throw runLockedError(ownerPid);
      if (ownerPid > 0 || age > 5000) { const grave = lock + '.stale-' + token; try { fs.renameSync(lock, grave); } catch { continue; } try { fs.unlinkSync(grave); } catch {} continue; }
      if (Date.now() > until) throw runLockedError(ownerPid);
      sleepSync(25);
    }
  }
  heldLocks.set(lock, {token, content, depth: 1});
  return () => releaseFileLock(lock);
}

// --- three-way merge for a run's saves (wave 15) ------------------------------
// A run works on its in-memory copy for hours; meanwhile the queue on disk
// can gain items (add) and lose them (remove / clear). Saving must merge
// three states — the queue as the run loaded it (baseline), the queue on
// disk now, and the run's memory:
//   - an item gone from disk was removed on purpose: drop it, even when
//     the run's memory still carries it;
//   - an item new on disk (not in the baseline) was added during the run:
//     keep it, after the run's own items;
//   - an item the run has not touched takes the disk version; an item the
//     run changed takes the run's version (external writers never edit an
//     existing item's fields — they only add and remove).
// Memory objects keep their identity for surviving items (the run holds
// references to them); `memory.items` is rewritten to the merged list.
function snapshotQueue(queue) { return new Map((queue.items || []).map(i => [i.id, JSON.stringify(i)])); }
function mergeQueueForRun(memory, baseline, disk) {
  const diskById = new Map((disk.items || []).map(i => [i.id, i]));
  const memoryIds = new Set(memory.items.map(i => i.id));
  const result = [];
  for (const item of memory.items) {
    const onDisk = diskById.get(item.id);
    const baseJson = baseline.get(item.id);
    if (!onDisk) {
      if (baseJson !== undefined) continue; // removed from disk during the run: drop it
      result.push(item); // new in memory only (the run itself never adds, but keep the rule total)
      continue;
    }
    const memoryChanged = baseJson !== JSON.stringify(item);
    const diskChanged = baseJson !== JSON.stringify(onDisk);
    if (!memoryChanged && diskChanged) { // untouched by the run: the disk version wins, in place
      for (const k of Object.keys(item)) if (!(k in onDisk)) delete item[k];
      Object.assign(item, JSON.parse(JSON.stringify(onDisk)));
    }
    result.push(item);
  }
  for (const item of disk.items || []) {
    if (memoryIds.has(item.id)) continue;
    if (baseline.has(item.id)) continue; // was there at the start and memory dropped it: stays dropped
    result.push(item); // added on disk during the run
  }
  memory.items = result;
  return result;
}

let seq = 0;
// The random part comes FIRST: ids are matched by prefix (remove, reports),
// and two items queued in the same millisecond would otherwise share their
// whole time-based prefix and read as ambiguous.
function newId(now = Date.now()) { return 'on' + Math.floor(Math.random() * 2176782336).toString(36).padStart(6, '0') + now.toString(36) + (seq++).toString(36); }

function addItem(queue, {prompt, cwd, account = null, runGit}, now = Date.now(), opts = {}) {
  // A caller may pass its options in the `now` slot; keep the old
  // addItem(queue, fields, timestamp) shape working either way.
  if (now && typeof now === 'object') { opts = now; now = Date.now(); }
  const text = String(prompt || '').trim();
  if (!text) throw new Error('overnight: a prompt is required');
  const cwdText = String(cwd || '');
  const storedPrompt = text.slice(0, 4000);
  // No double registration (wave 11): the same prompt for the same folder
  // already waiting (queued or deferred) would run the same work twice in
  // one night. A finished/failed copy is history and does not block a
  // deliberate re-queue.
  const dupe = queue.items.find(i => i && (i.status === 'queued' || i.status === 'deferred') && i.prompt === storedPrompt && String(i.cwd || '') === cwdText);
  if (dupe) throw new Error(t('同じ頼みがすでに積まれているため、二重登録はできません: {prompt}', {prompt: text.slice(0, 120)}));
  // The folder is checked when the item is QUEUED, not first at run time
  // (wave 11): it must exist and be a git repository, or the night would
  // only discover at 3am that the task can never start.
  const gitCheck = opts.runGit || runGit;
  if (opts.checkGit !== false && opts.skipGitCheck !== true) {
    let isRepo = false;
    try { isRepo = pool.isGitRepo({repoDir: cwdText, ...(gitCheck ? {runGit: gitCheck} : {})}); } catch { isRepo = false; }
    if (!cwdText || !isRepo) throw new Error(t('git リポジトリではないため夜間作業に積めません: {dir}', {dir: cwdText}));
  }
  const item = {id: newId(now), prompt: storedPrompt, cwd: cwdText, account, status: 'queued', createdAt: now, questions: []};
  queue.items.push(item);
  return item;
}
// Ids match by prefix, like session ids elsewhere in muser; ambiguous or
// missing prefixes are reported, never guessed.
function findItem(queue, ref) {
  const hits = queue.items.filter(i => i.id === ref || i.id.startsWith(String(ref || '')));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) { const e = new Error('ambiguous'); e.code = 'ambiguous'; e.hits = hits; throw e; }
  return null;
}
function removeItem(queue, ref) {
  const item = findItem(queue, ref);
  if (!item) return null;
  queue.items.splice(queue.items.indexOf(item), 1);
  return item;
}

// The estimate shown before a run (common rule: Muse-calling features show
// the expected agents/accounts and accept a cap). One agent per task is the
// floor; a task whose prompt asks for parallel agents is still ONE overnight
// agent from the cap's point of view — the cap counts tasks and tokens.
function estimate(queue, {statuses = null} = {}) {
  const pending = queue.items.filter(i => i.status === 'queued' || i.status === 'deferred');
  const accounts = statuses ? statuses.filter(s => s && s.available !== false).map(s => s.label || s.id) : [];
  return {tasks: pending.length, agents: pending.length, accounts, ids: pending.map(i => i.id)};
}

// Account choice (§8.3): among accounts with allowance left, the least weekly
// use wins (accounts.js' policy in spirit, kept pure here so tests can drive
// it). percentUsed unknown (null) ranks below every known value but above
// exhausted. When every account is exhausted, the answer is the earliest
// reset so the run can wait for it: {waitUntil} instead of {account}.
function pickAccount(statuses, {exhaustedAt = 100} = {}) {
  const list = (statuses || []).filter(s => s && s.available !== false && s.hasLogin !== false);
  if (!list.length) return {account: null, waitUntil: null};
  const isOut = s => s.quotaStatus && s.quotaStatus !== 'SUFFICIENT' ? true : (typeof s.percentUsed === 'number' && s.percentUsed >= exhaustedAt);
  const alive = list.filter(s => !isOut(s));
  if (alive.length) {
    const score = s => typeof s.percentUsed === 'number' ? s.percentUsed : Number.POSITIVE_INFINITY;
    const best = [...alive].sort((a, b) => score(a) - score(b))[0];
    return {account: best, waitUntil: null};
  }
  let waitUntil = null;
  for (const s of list) { const r = s.plan?.resetsAt ?? s.resetsAt ?? null; if (typeof r === 'number' && (waitUntil === null || r < waitUntil)) waitUntil = r; }
  return {account: null, waitUntil};
}

// Power note (§8): starting a night run on a PC that sleeps in 30 minutes is
// pointless, so the check is reported — the setting itself is never changed.
// The runner is injectable; the real one asks powercfg for the AC sleep timeout.
function parseSleepSeconds(powercfgText) {
  const m = /0x([0-9a-fA-F]+)/g;
  const vals = [...String(powercfgText || '').matchAll(m)].map(x => parseInt(x[1], 16));
  // powercfg /query prints the AC then DC index for STANDBYIDLE; AC is first.
  return vals.length ? vals[0] : null;
}
function defaultCheckPower() {
  try {
    const {spawnSync} = require('node:child_process');
    const r = spawnSync('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], {encoding: 'utf8', windowsHide: true});
    if (r.status !== 0) return {sleepSeconds: null, note: 'power settings could not be read'};
    const s = parseSleepSeconds(r.stdout);
    return {sleepSeconds: s, note: s === 0 ? 'AC sleep is off' : s == null ? 'AC sleep timeout unknown' : 'PC sleeps after ' + Math.round(s / 60) + ' min on AC'};
  } catch { return {sleepSeconds: null, note: 'power settings could not be read'}; }
}

module.exports = {baseDir, queueFile, reportsDir, worktreesDir, loadQueue, saveQueue, updateQueue, queueLockFile, runLockFile, acquireRunLock, snapshotQueue, mergeQueueForRun, pidAlive, addItem, findItem, removeItem, estimate, pickAccount, parseSleepSeconds, defaultCheckPower, newId};
