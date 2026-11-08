'use strict';
// Counter-proof tests (design §3), part of /proof: for a turn that claims
// "fixed it and added a regression test", re-run the turn's new tests in a
// throwaway copy with ONLY the fix reverted (from the worklog blobs). If
// the tests still pass, they do not see the bug: ✗. If they fall: ✓.
// The user's working tree is never touched, and the temp copy is always
// removed. Running tests needs the user's go-ahead (the caller confirms,
// or passes confirmed:true — /proof --yes); without it this module only
// reports the plan.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {t} = require('../i18n.js');
const {readBlob} = require('./worklog.js');
const {sha256} = require('../worklog.js');

const EMPTY_HASH = sha256(''); // the beforeHash of a file the turn created

// Test-file judgement (design §3 step 1): by path, plus the project's own
// test command when it names files.
function isTestFile(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return /(^|\/)(tests?|__tests__)\//.test(s) || /\.(test|spec)\.[A-Za-z]+$/.test(s);
}
function splitChanges(turn) {
  const tests = [], fixes = [];
  for (const e of (turn && turn.edits) || []) (isTestFile(e.path) ? tests : fixes).push(e);
  return {tests, fixes};
}
// The FIRST edit of each path in the turn (wave 15): a file the turn
// edited twice must roll back to how it stood before the turn touched
// it at all, not to the in-between state the second edit started from
// (the old per-edit loop let the LAST edit's before-image win, so the
// "reverted" copy still carried the turn's first fix and a test that
// only saw that first fix wrongly passed). `keyOf` names the path for
// grouping; callers with a cwd resolve first, so a relative and an
// absolute spelling of the same file group together there.
function firstEdits(edits, keyOf) {
  const key = keyOf || (e => String((e && e.path) || '').replace(/\\/g, '/').toLowerCase());
  const seen = new Map();
  for (const e of edits || []) {
    if (!e) continue;
    const k = key(e);
    if (!k || seen.has(k)) continue;
    seen.set(k, e);
  }
  return [...seen.values()];
}
// The command the turn itself used to run tests (design §3 step 4): a
// system.run whose text mentions a test runner. Null when the turn never
// ran one — the caller then asks the user instead of guessing.
function testCommandFor(turn) {
  let found = null;
  for (const e of (turn && turn.tools) || []) {
    const cmd = String((e.params && e.params.command) || e.summary || '');
    // A summary is the work log's 200-char head of the command: at exactly
    // that length it may be cut mid-command, and running a truncated
    // command would judge a command that never ran. Treat it as unknown.
    if (cmd.length >= 200 && !(e.params && e.params.command)) continue;
    if (/\b(npm\s+(run\s+)?test|node\s+.*--test|npx\s+(jest|vitest|mocha)|pytest|cargo\s+test|dotnet\s+test)\b/i.test(cmd)) found = cmd;
  }
  return found;
}
// --- files changed after the turn (wave 10, widened in wave 15) ----------
// The counter-proof runs the turn's tests as they sit in the CURRENT
// tree (prepareCounterProof copies it). If a file that is material to
// the verdict has changed since the turn ended, the run judged a tree
// the turn never left, so its ✓/✗ cannot stand as the turn's verdict:
// it is downgraded to a reference-only '?' with the note
// 『テストがターン後に変わっています』.
// What is material is wider than the turn's own test edits (wave 15):
// the copy keeps the CURRENT contents of every file the turn did not
// revert — test files the turn only ran, sources it only read, files
// it never touched at all — so a post-turn change to any of them can
// move the verdict just as much. The scan therefore covers:
//   - the turn's test edits, judged by content first (below);
//   - every other file under cwd (test or not, touched or not), judged
//     by the only signal an unrecorded file offers: its mtime.
// The turn's non-test edits are the one exclusion: the copy overwrites
// them with their before-images, so their current state is immaterial.
// For a file the turn DID record, content outranks time: the file's
// current sha256 is compared with the afterHash of the turn's last
// edit of it (only real 64-hex hashes count; hand-written fixture
// hashes say nothing), and a file whose content still matches is NOT
// downgraded for an mtime alone (a touch, a checkout, a copy can move
// an mtime without changing a byte). With no recorded hash — or an
// unreadable file — mtime after the turn's end (its reply, else its
// last recorded event) is the signal. A file missing now when the
// turn left a hashed after-state counts as changed too.
const HASH_RE = /^[0-9a-f]{64}$/i;
function atMsOf(e) {
  if (!e || typeof e !== 'object') return 0;
  const v = e.atMs ?? e.at ?? e.ts ?? e.time;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : 0;
}
function turnEndMs(turn) {
  const events = (turn && turn.events) || [];
  const replies = events.filter(e => e && (e.type === 'reply' || e.event === 'reply'));
  const pool = replies.length ? replies : [...events, ...((turn && turn.edits) || []), ...((turn && turn.tools) || [])];
  return pool.reduce((m, e) => Math.max(m, atMsOf(e)), 0);
}
function staleTestFiles(turn, cwd) {
  if (!turn || !cwd) return [];
  const {tests} = splitChanges(turn);
  const end = turnEndMs(turn);
  const stale = [];
  const push = p => { if (p && !stale.includes(p)) stale.push(p); };
  const lastByPath = new Map();
  for (const e of tests) lastByPath.set(String(e.path || '').replace(/\\/g, '/').toLowerCase(), e);
  for (const e of lastByPath.values()) {
    if (/(?:delete|remove|unlink)/i.test(String(e.op || ''))) continue; // the turn itself removed it
    const abs = path.isAbsolute(e.path) ? path.resolve(e.path) : path.resolve(cwd, e.path);
    const hasHash = HASH_RE.test(String(e.afterHash || '')) && e.afterHash !== EMPTY_HASH;
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* missing: handled below */ }
    if (!stat) { if (hasHash) push(e.path); continue; }
    if (hasHash) {
      let content = null;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { /* unreadable: fall back to the time signal below */ }
      if (content !== null) {
        // Content decides (wave 15): a matching hash is a current file
        // however new its mtime is, and a differing one is changed
        // however old its mtime claims to be.
        if (sha256(content) !== String(e.afterHash).toLowerCase()) push(e.path);
        continue;
      }
    }
    if (end && stat.mtimeMs > end) push(e.path);
  }
  // The widened scan (wave 15): every other file under cwd, test or
  // not, whether the turn touched it or not. The turn's edits are
  // excluded — its test edits were judged above, and its other edits
  // are reverted from blobs in the copy, so their current state cannot
  // move the verdict. A scan needs the turn's end as its baseline;
  // without one (a hand-built turn with no timed events) there is no
  // "after the turn" to judge against and the scan does not run.
  if (end) {
    const edited = new Set();
    for (const e of (turn && turn.edits) || []) {
      if (!e || !e.path) continue;
      const abs = path.isAbsolute(e.path) ? path.resolve(e.path) : path.resolve(cwd, e.path);
      edited.add(abs.toLowerCase());
    }
    const found = [];
    let scanned = 0;
    const stack = [path.resolve(cwd)];
    while (stack.length && scanned <= 20000) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { continue; }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!SKIP.has(ent.name)) stack.push(abs); continue; }
        if (!ent.isFile()) continue; // symlinks and special files carry no verdict signal here
        scanned++;
        if (edited.has(abs.toLowerCase())) continue;
        let stat = null;
        try { stat = fs.statSync(abs); } catch { continue; }
        if (stat.mtimeMs > end) found.push(path.relative(cwd, abs).replace(/\\/g, '/'));
      }
    }
    found.sort();
    for (const f of found) push(f);
  }
  return stale;
}

function planCounterProof(turn, {command} = {}) {
  const {tests, fixes} = splitChanges(turn);
  if (!tests.length) return {status: '?', reason: t('このターンにテストの変更がありません'), tests, fixes};
  if (!fixes.length) return {status: '?', reason: t('このターンにテスト以外の変更がありません'), tests, fixes};
  const cmd = command || testCommandFor(turn);
  if (!cmd) return {status: '?', reason: t('テストのコマンドが分かりません'), tests, fixes};
  // Only each file's FIRST edit needs a before-image (wave 15): that is
  // the state the copy rolls back to. A later edit of the same file
  // without one no longer blocks the plan, and a first edit without one
  // still does — there is nothing to roll that file back to.
  const noBlob = firstEdits(fixes).filter(e => !e.beforeHash);
  if (noBlob.length) return {status: '?', reason: t('変更前の内容（blobs）がありません: {file}', {file: noBlob[0].path}), tests, fixes};
  return {status: 'ready', command: cmd, tests, fixes};
}

const SKIP = new Set(['node_modules', '.git']);
// Copy the tree without planting a live link into it (wave 18): cpSync
// copies a junction / symlink AS a link, so the copy was not isolated —
// a write through the copy's link (a reverted fix whose path crosses
// the link, or a test run inside the copy) landed on the REAL file
// outside the tree and stayed there after the copy was deleted. Every
// link found in the tree is therefore dereferenced instead: its target's
// contents are copied as ordinary files / folders of the copy, so writes
// inside the copy can only reach the copy. Two links are left out
// rather than copied: a broken one (its target does not exist, so there
// is nothing to copy — and a dangling link planted in the copy could be
// CREATED through onto the outside path) and one pointing back into a
// folder already being copied above it (following it would never end).
// node_modules is the one deliberate exception to all this: it stays
// skipped here and is linked back in by prepareCounterProof below, as
// the design allows sharing it.
function copyTreeIsolated(srcDir, destDir, ancestors) {
  fs.mkdirSync(destDir, {recursive: true});
  for (const ent of fs.readdirSync(srcDir, {withFileTypes: true})) {
    if (SKIP.has(ent.name)) continue;
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    const lst = fs.lstatSync(src);
    if (lst.isSymbolicLink()) {
      let target = null;
      try { target = fs.statSync(src); } catch { continue; } // broken link: left out, see above
      if (target.isDirectory()) {
        let real = src;
        try { real = fs.realpathSync(src); } catch {}
        const key = real.toLowerCase();
        if (ancestors.has(key)) continue; // a link back up the copy chain: left out, see above
        const next = new Set(ancestors);
        next.add(key);
        copyTreeIsolated(src, dest, next);
      } else if (target.isFile()) {
        fs.copyFileSync(src, dest); // the target's bytes, as a plain file of the copy
      }
      continue; // links to anything else carry no copyable content
    }
    if (lst.isDirectory()) {
      let real = src;
      try { real = fs.realpathSync(src); } catch {}
      const key = real.toLowerCase();
      if (ancestors.has(key)) continue;
      const next = new Set(ancestors);
      next.add(key);
      copyTreeIsolated(src, dest, next);
    } else if (lst.isFile()) {
      fs.copyFileSync(src, dest);
    }
    // Special files (sockets, devices, …) are not copied.
  }
}
// The throwaway copy (design §3 step 2's copy route): the current tree
// minus .git / node_modules (node_modules is linked back in, as the
// design allows), with ONLY the fix files reverted to the blob
// before-image of the turn's first edit of each. Test files keep their
// current (new) contents.
function prepareCounterProof({turn, cwd, base, tmpRoot}) {
  const {fixes} = splitChanges(turn);
  const root = tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'muser-proof-'));
  const dir = tmpRoot ? path.join(root, 'tree') : root;
  try {
    let rootReal = path.resolve(cwd);
    try { rootReal = fs.realpathSync(cwd); } catch {}
    copyTreeIsolated(cwd, dir, new Set([rootReal.toLowerCase()]));
    const nm = path.join(cwd, 'node_modules');
    if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'junction'); } catch {} }
    // Roll each fix file back to the state before the turn's FIRST edit
    // of it (wave 15, see firstEdits): grouping by the resolved path, so
    // a file edited twice — however its edits spell the path — is
    // reverted once, from its earliest before-image.
    const firstFixes = firstEdits(fixes, e => {
      const abs = path.isAbsolute(e.path) ? path.resolve(e.path) : path.resolve(cwd, e.path);
      return abs.toLowerCase();
    });
    for (const e of firstFixes) {
      // Real worklog edits carry ABSOLUTE paths (the write tools resolve
      // them before recording); test fixtures carry repo-relative ones.
      // Both name a file inside cwd — resolve the edit against cwd and
      // place it at the same relative spot in the copy. A fix outside the
      // working folder cannot be reverted inside the copy.
      const abs = path.isAbsolute(e.path) ? path.resolve(e.path) : path.resolve(cwd, e.path);
      const rel = path.relative(cwd, abs);
      // Only a '..' SEGMENT steps out of the working folder (wave 18):
      // the bare startsWith('..') also condemned a file sitting IN the
      // folder whose name merely begins with two dots ('..notes.txt'),
      // and aborted the whole counter-proof over it.
      if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../') || path.isAbsolute(rel)) { cleanupDir(root); return {error: t('作業フォルダーの外のファイルは反証できません: {file}', {file: e.path})}; }
      const dest = path.join(dir, rel);
      // A file the turn CREATED (beforeHash = the empty hash, no blob was
      // kept) is reverted by removing it from the copy.
      if (e.beforeHash === EMPTY_HASH) { try { fs.rmSync(dest, {force: true}); } catch {} continue; }
      const before = readBlob(e.beforeHash, {base});
      if (before === null) { cleanupDir(root); return {error: t('変更前の内容（blobs）がありません: {file}', {file: e.path})}; }
      fs.mkdirSync(path.dirname(dest), {recursive: true});
      fs.writeFileSync(dest, before);
    }
    return {dir, root};
  } catch (err) {
    // Any failure above (a copy error, a bad path) must not leave a whole
    // copy of the user's tree behind in the temp folder.
    cleanupDir(root);
    return {error: String((err && err.message) || err)};
  }
}
function cleanupDir(dir) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} }

function defaultRun(command, {cwd, testFiles}) {
  let cmd = command;
  const extra = (testFiles || []).filter(f => !cmd.includes(f));
  if (extra.length && /--test|jest|vitest|mocha|pytest/.test(cmd)) cmd += ' ' + extra.map(f => '"' + f + '"').join(' ');
  return new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
      {cwd, timeout: 300000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer'},
      (err, stdout, stderr) => {
        // cmd.exe speaks the console code page (CP932 on Japanese Windows):
        // decoded as UTF-8 its words are mojibake and no text check can see
        // them, so fall back to the legacy decoding when UTF-8 breaks.
        const buf = Buffer.concat([stdout || Buffer.alloc(0), stderr || Buffer.alloc(0)]);
        let output = buf.toString('utf8');
        if (output.includes('\uFFFD')) { try { output = new TextDecoder('shift-jis').decode(buf); } catch {} }
        resolve({exit: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output,
          // No numeric code means the command never ran as a test process at
          // all (spawn failure, timeout kill, output overflow): its exit 1
          // must not be read as "the tests fell".
          failed: !!err && typeof err.code !== 'number'});
      });
  });
}
// "The command does not exist" in the shell's own words, English or
// Japanese Windows alike — a failure to launch is not a failing test.
const NOT_LAUNCHED = /is not recognized as an internal or external command|command not found|No such file or directory|認識されていません/i;

// Full flow. `run` is injectable for tests. Without confirmed:true nothing
// runs: the plan (with the exact command) comes back for the caller to
// show the user first (design §3: 確認してから動かす; --yes skips it).
async function runCounterProof({turn, cwd, base, command, confirmed = false, run = defaultRun, tmpRoot} = {}) {
  const plan = planCounterProof(turn, {command});
  if (plan.status !== 'ready') return {...plan, mark: '?'};
  if (!confirmed) return {status: 'needs-confirm', mark: null, command: plan.command, tests: plan.tests, fixes: plan.fixes};
  const prep = prepareCounterProof({turn, cwd, base, tmpRoot});
  if (prep.error) return {status: '?', mark: '?', reason: prep.error, command: plan.command};
  try {
    const r = await run(plan.command, {cwd: prep.dir, testFiles: plan.tests.map(e => e.path)});
    if (!r || typeof r.exit !== 'number' || r.failed) return {status: '?', mark: '?', reason: t('テストを実行できませんでした'), command: plan.command};
    if (r.exit !== 0 && (r.exit === 9009 || NOT_LAUNCHED.test(String(r.output || '')))) return {status: '?', mark: '?', reason: t('テストを実行できませんでした'), command: plan.command};
    // A file material to the verdict changed after the turn (wave 10,
    // widened in wave 15): the run above judged the current tree, not
    // the turn's, so whichever way it fell the conclusion is
    // reference-only — '?' with the note, never ✓/✗.
    const stale = staleTestFiles(turn, cwd);
    if (stale.length) return {status: 'done', mark: '?', staleTest: true, staleFiles: stale, reason: t('テストがターン後に変わっています'), command: plan.command, exit: r.exit};
    return r.exit !== 0
      ? {status: 'done', mark: '✓', command: plan.command, exit: r.exit}
      : {status: 'done', mark: '✗', command: plan.command, exit: r.exit};
  } catch (e) {
    return {status: '?', mark: '?', reason: String(e && e.message || e), command: plan.command};
  } finally { cleanupDir(prep.root); }
}

function formatCounter(result) {
  if (!result) return [];
  if (result.status === 'needs-confirm') return [t('反証テスト: 流すコマンドは {command} です', {command: result.command})];
  if (result.staleTest || result.reason === 'テストがターン後に変わっています') return [t('反証テスト: ? テストがターン後に変わっています')];
  if (result.mark === '✓') return [t('反証テスト: ✓ このテストは修正を見ている（修正を外すと落ちました）')];
  if (result.mark === '✗') return [t('反証テスト: ✗ 修正を外しても通ります（このテストは直したバグを見ていません）')];
  return [t('反証テスト: ? 流せませんでした: {reason}', {reason: result.reason || t('テストを実行できませんでした')})];
}

module.exports = {isTestFile, splitChanges, firstEdits, testCommandFor, planCounterProof, prepareCounterProof, runCounterProof, formatCounter, staleTestFiles, staleFiles: staleTestFiles};
