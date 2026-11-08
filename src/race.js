'use strict';
// muser race (競争): run the same task in N git worktrees, one Muse per
// worktree, each on its own account with a different strategy note, then run
// the same checks in every worktree and compare (design: docs/design/
// new-features.md section 7). The user's working tree is never touched while
// the race runs: a winner's diff is applied only after the user picks it and
// sees the diff. Worktrees and records live under %LOCALAPPDATA%\muser\race\
// <race id>\ — this PC only, nothing is sent anywhere.
//
// The Muse runner is replaceable (opts.runner) so tests never call a real
// Muse: the default runner shells out to `muser exec --json` in the
// worktree (the headless entry the rest of muser already uses).
//
// The worklog reader below reads the shape src/worklog.js writes:
// %LOCALAPPDATA%\muser\worklog\<conversation id>.jsonl, one JSON event per
// line ({v, at, session, event: turn / tool / edit / expect / reply /
// focus / gap}), with pre-edit full texts under worklog\blobs\<hash>.
// Race only reads it (for the proof badge); it never writes worklog events.
// The discriminator is `event`; `type` is still accepted so a log written
// by an older build does not read as empty.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile, spawn} = require('node:child_process');
const {t} = require('./i18n');
const {formatTokens} = require('./turn-usage.js');
const {durationText} = require('./server/status.js');
const {Worklog, fileFor} = require('./worklog.js');
const worktreePool = require('./worktree-pool.js');

const STRATEGIES = [
  {id: 'minimal', label: '最小の変更', instruction: '方針: 最小の変更で頼みを満たしてください。関係のない場所は触らないでください。'},
  {id: 'readable', label: '読みやすさ優先', instruction: '方針: 読みやすさを優先してください。分かりやすい名前と構成で、変更の意図が追えるようにしてください。'},
  {id: 'tests-first', label: 'テストを先に', instruction: '方針: 先にテストを書いて失敗を確認してから、実装してください。'},
  {id: 'patterns', label: '既存のパターン優先', instruction: '方針: 既存のコードのパターンと流儀を調べ、それに合わせて実装してください。新しい流儀は持ち込まないでください。'},
];
const MAX_RACERS = 8;
// The racer-count check, shared by the pre-start estimate and runRace.
// estimate() is what bin and the slash command show (and ask about) BEFORE
// anything runs, so validating there refuses an over-limit race in words
// at the entrance, instead of the count only failing once execution is
// already under way (audit-cli wave 6). Exported so callers can also check
// before they start; runRace still checks again on its own.
function validateRacerCount(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_RACERS) throw new Error(t('参加者は 1〜{max} 体にしてください。', {max: MAX_RACERS}));
  return n;
}

function localAppData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }
function raceRoot() { return path.join(localAppData(), 'muser', 'race'); }
function worklogDir() { return path.join(localAppData(), 'muser', 'worklog'); }
function newRaceId(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  // Seconds alone collide when two races start within the same second
  // (same id, same state dir, same worktree names) — a random suffix
  // keeps every race's folder its own (features-debug #28). The suffix
  // was 2 bytes (16 bit): two races in the same second collided after
  // only a few hundred tries, and the loser then shared (and on failure
  // deleted) the winner's state dir and worktrees. 8 bytes (64 bit,
  // 16 hex digits) makes an accidental same-second collision negligible
  // (audit-cli wave 10); an explicit id that is already taken is refused
  // outright in runRace below.
  return now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + '-' + crypto.randomBytes(8).toString('hex');
}
function stateDirFor(id) { return path.join(raceRoot(), path.basename(String(id))); }

// --- race state file -----------------------------------------------------------
// result.json is written from the moment the first worktree exists and is
// rewritten on every racer status change, not only when the race finishes:
// if the process is killed mid-race, loadRace can still find the race and
// cleanupRace can remove the orphaned worktrees (audit-cli wave 3). The
// writer's pid rides along so a later reader can tell a race that is still
// running (pid alive) from one that was interrupted (pid gone).
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function writeRaceState(dir, state) {
  const file = path.join(dir, 'result.json');
  // A unique tmp name (pid + random suffix, as the other stores use): the
  // fixed 'result.json.tmp' was shared by every writer, so two processes
  // writing the same race's state at once could rename each other's
  // half-written file into place (audit-cli wave 17).
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const text = JSON.stringify(state, null, 2) + '\n';
  // Write-then-rename, so a kill mid-write never leaves a torn state file
  // behind for loadRace to choke on.
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch { try { fs.writeFileSync(file, text); } catch {} try { fs.unlinkSync(tmp); } catch {} }
}

// --- worklog reading (through src/worklog.js; see the header note) ---------
function readWorklog(conversationId, opts = {}) {
  if (!conversationId) return [];
  const events = Worklog.readFile(fileFor(String(conversationId), opts.dir || worklogDir()));
  events.forEach((e, i) => { e._i = i; });
  return events;
}
const kindOf = e => e.event || e.type || '';
// A tool event counts as a test run only when its text names a test
// runner. The old /test|check/i substring also matched prose like "read
// the latest version" (la-test) on a plain read, stamping ✓ on work no
// test ever saw (features-debug #14; same recognizer in
// src/overnight/worklog-read.js).
const TEST_RUN_RE = /\bnpm\s+(?:run\s+)?test\b|\bnpm\s+run\s+check\b|\bnode\b[^\n]*--test\b|\b(?:jest|vitest|mocha|pytest)\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bgo\s+test\b/i;
const isTestRunText = s => TEST_RUN_RE.test(String(s || ''));
// …or the run's own output carries a full test summary (both a pass and a
// fail count, the shapes badge.parseTestCounts reads): a runner invoked
// through a wrapper still leaves its summary behind.
const {parseTestCounts} = require('./proof/badge.js');
const hasTestSummary = e => { const c = parseTestCounts([e.output, e.outHead, e.outTail].filter(Boolean).join('\n')); return c.pass !== null && c.fail !== null; };
// The light proof badge race attaches to each racer (the full /proof feature
// is its own branch): a test-like tool run after the last edit decides.
// ✓ the last such run passed, ✗ it failed, ? edits with no test run after
// them, — no worklog / nothing to judge.
function proofBadge(events) {
  if (!events || !events.length) return {mark: '—', code: 'none'};
  const isTest = e => kindOf(e) === 'tool' && (isTestRunText(String(e.command || '') + ' ' + String(e.summary || '')) || hasTestSummary(e));
  const okOf = e => e.ok === true || e.exitCode === 0;
  let lastEdit = -1;
  events.forEach((e, i) => { if (kindOf(e) === 'edit') lastEdit = i; });
  const tests = events.filter(isTest);
  const after = lastEdit >= 0 ? tests.filter(e => e._i > lastEdit) : tests;
  if (lastEdit >= 0 && !after.length) return {mark: '?', code: 'unverified'};
  if (!after.length) return {mark: '—', code: 'none'};
  return okOf(after[after.length - 1]) ? {mark: '✓', code: 'verified'} : {mark: '✗', code: 'contradicted'};
}

// --- git helpers -------------------------------------------------------------
function run(file, args, opts = {}) {
  return new Promise(resolve => {
    execFile(file, args, {cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: opts.timeoutMs || 0},
      (err, stdout, stderr) => resolve({code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : ''}));
  });
}
const git = (cwd, args, opts) => run('git', args, {cwd, ...opts});
async function isGitRepo(cwd) { return (await git(cwd, ['rev-parse', '--git-dir'])).code === 0; }
async function headSha(cwd) { const r = await git(cwd, ['rev-parse', 'HEAD']); return r.code === 0 ? r.stdout.trim() : null; }
async function dirtyFiles(cwd) {
  const r = await git(cwd, ['status', '--porcelain']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}
// The user's uncommitted state as one patch plus the untracked file list, so
// a race can start from it without ever writing to the user's tree.
async function dirtySnapshot(cwd) {
  const patch = await git(cwd, ['diff', 'HEAD', '--binary']);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return {patch: patch.code === 0 ? patch.stdout : '', untracked: untracked.stdout.split('\0').filter(Boolean)};
}
async function applyDirtySnapshot(cwd, wt, snapshot) {
  if (snapshot.patch.trim()) {
    const tmp = path.join(wt, '.race-dirty.patch');
    fs.writeFileSync(tmp, snapshot.patch);
    try { await git(wt, ['apply', '--whitespace=nowarn', tmp]); } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  for (const rel of snapshot.untracked) {
    const from = path.join(cwd, rel), to = path.join(wt, rel);
    try { fs.mkdirSync(path.dirname(to), {recursive: true}); fs.copyFileSync(from, to); } catch {}
  }
}
// The worktree machinery itself is shared with overnight in
// src/worktree-pool.js (detached trees for race; the junction sharing and
// the junction-first cleanup live there now). These wrappers keep race's
// own call shape: create also links node_modules, both stay awaitable.
async function createWorktree(repo, wt) {
  worktreePool.createWorktree({repoDir: repo, dir: wt});
  worktreePool.linkNodeModules({repoDir: repo, dir: wt});
  return wt;
}
async function removeWorktree(repo, wt) {
  worktreePool.removeWorktree({repoDir: repo, dir: wt});
}
// New files in the worktree that .gitignore keeps OUT of the patch: they
// are untracked and ignored, so `git add -A` never stages them and the
// patch a winner is applied from never carries them — until now they were
// invisible and cleanupRace deleted the only copy without a word
// (audit-cli wave 15). node_modules is not counted: race itself links it
// into every worktree (a junction to the repo's own), so its files are
// never a racer's work.
async function ignoredNewFiles(wt) {
  const r = await git(wt, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean).filter(rel => rel.split('/')[0] !== 'node_modules');
}
// Everything a racer changed, against the race's base commit: stage it all
// in the disposable worktree, then diff base..index (this also catches a
// racer that committed on its detached HEAD). Alongside the patch, the
// ignored new files (above) are counted and named — capped at 100 names so
// a worktree full of build output cannot bloat result.json — and ride the
// diff info into the race result and its state file.
async function collectDiff(wt, base) {
  const ignoredFiles = await ignoredNewFiles(wt);
  await git(wt, ['add', '-A']);
  const num = await git(wt, ['diff', '--cached', '--numstat', base]);
  let files = 0, added = 0, removed = 0;
  for (const line of num.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++; if (m[1] !== '-') added += Number(m[1]); if (m[2] !== '-') removed += Number(m[2]);
  }
  const patch = await git(wt, ['diff', '--cached', '--binary', base]);
  return {files, added, removed, patch: patch.stdout,
    ignored: ignoredFiles.length, ignoredFiles: ignoredFiles.slice(0, 100),
    ...(ignoredFiles.length > 100 ? {ignoredFilesTruncated: true} : {})};
}

// --- apply drift guard ---------------------------------------------------------
// The files a patch touches, from its diff --git / --- / +++ headers (both
// sides: a rename's source matters too, and /dev/null marks the absent side
// of an add/delete). Quoted paths (spaces, non-ASCII under core.quotePath)
// are not unescaped — a missed file only weakens the guard for that patch,
// and git apply --check still runs afterwards.
function patchFiles(patch) {
  const files = new Set();
  for (const line of String(patch || '').split('\n')) {
    let m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { files.add(m[1]); files.add(m[2]); continue; }
    m = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') files.add(m[1].trim());
  }
  return [...files];
}
// One file's content fingerprint in the user's tree: a sha256 of its bytes,
// or null when it is not there. Anything else that keeps the bytes from
// being read gets a stable marker, so a change in readability still reads
// as a change when the two snapshots are compared.
function hashTreeFile(cwd, rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, rel))).digest('hex'); }
  catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : '<unreadable>'; }
}
function snapshotPatchTargets(cwd, patch) {
  const out = {};
  for (const rel of patchFiles(patch)) out[rel] = hashTreeFile(cwd, rel);
  return out;
}

// --- checks ------------------------------------------------------------------
function detectCommands(cwd) {
  const cmds = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) cmds.push('npm test');
    if (pkg.scripts && pkg.scripts.check) cmds.push('npm run check');
  } catch {}
  return cmds;
}
// Kills a spawned command's whole process tree. With shell:true the
// direct child is only the shell (cmd.exe / sh): killing just it leaves
// the command's own processes alive, and a grandchild that inherited the
// stdout pipe keeps 'close' from ever firing, so a timed-out check hung
// the whole race instead of timing out (audit-cli wave 10). Windows:
// taskkill /T takes the tree down by pid. POSIX: the child was spawned
// detached (its own process group), so a negative-pid kill reaches the
// group; fall back to the child alone when that fails.
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      k.on('error', () => { try { child.kill(); } catch {} });
    } catch { try { child.kill(); } catch {} }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}
function runShellCommand(command, cwd, timeoutMs = 10 * 60 * 1000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(command, {cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32'});
    let out = '';
    let timedOut = false, settled = false, grace = null;
    const finish = (code, tail) => {
      if (settled) return; settled = true;
      clearTimeout(timer); if (grace) clearTimeout(grace);
      resolve({command, code, ms: Date.now() - t0, tail, ...(timedOut ? {timedOut: true} : {})});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Even a tree kill can leave 'close' unsaid (taskkill missing, a
      // process outside the tree holding the pipe): resolve anyway after
      // a grace period, marked as the timeout it was, instead of hanging.
      grace = setTimeout(() => {
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        finish(1, out.slice(-500));
      }, 5000);
    }, timeoutMs);
    child.stdout.on('data', d => { out = (out + d).slice(-20000); });
    child.stderr.on('data', d => { out = (out + d).slice(-20000); });
    child.on('error', e => finish(1, String(e.message).slice(-500)));
    child.on('close', code => finish(code ?? 1, out.slice(-500)));
  });
}

// --- the Muse runner ---------------------------------------------------------
// Default: one headless `muser exec --json` in the worktree. Racers run with
// --mode bypass inside their disposable worktree only (the estimate says
// so); the user's tree is untouched until a winner is picked and applied.
function execRunner({cwd, prompt, account, mode, timeoutMs = 30 * 60 * 1000}) {
  return new Promise(resolve => {
    const args = [path.join(__dirname, '..', 'bin', 'muser.js'), 'exec', '--json', '--cd', cwd, '--mode', mode || 'bypass'];
    if (account) args.push('--account', account);
    args.push(prompt);
    const child = spawn(process.execPath, args, {cwd, windowsHide: true});
    let out = '', errOut = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errOut = (errOut + d).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); resolve({ok: false, error: e.message}); });
    child.on('close', code => {
      clearTimeout(timer);
      let result = null;
      for (const line of out.split('\n')) { try { const j = JSON.parse(line); if (j && j.type === 'result') result = j; } catch {} }
      if (!result) return resolve({ok: false, error: (errOut.trim().split('\n').pop() || 'muser exec failed (exit ' + code + ')')});
      resolve({ok: !!result.ok, reply: result.reply || '', session: result.session || null, usage: result.turnUsage || null, error: result.ok ? '' : (result.error || 'exec failed')});
    });
  });
}
function tokensOf(usage) {
  if (!usage) return null;
  const a = Number(usage.inputTokens), b = Number(usage.outputTokens);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
}

// --- estimate / accounts -------------------------------------------------------
function accountIds() {
  try { return require('./accounts').list().map(a => a.id).filter(Boolean); } catch { return []; }
}
function assignAccounts(n, requested) {
  const pool = requested && requested.length ? requested : accountIds();
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool.length ? pool[i % pool.length] : null);
  return out;
}
function estimate(opts = {}) {
  const n = validateRacerCount(opts.n || 3);
  const accounts = assignAccounts(n, opts.accounts);
  const lines = [
    t('見込み: エージェント {n} 体（アカウント: {accounts}）', {n, accounts: accounts.map(a => a || t('既定')).join(', ')}),
    t('使用量は通常の {n} 倍ほどかかります。参加者は作業フォルダーの中だけで、承認なし（bypass）で動きます。', {n}),
  ];
  if (opts.maxTokens) lines.push(t('トークンの上限: {max}（達したら次の参加者は始めません）', {max: opts.maxTokens}));
  return {n, accounts, lines};
}

// --- the race ------------------------------------------------------------------
async function runRace(opts) {
  const cwd = opts.cwd;
  const task = String(opts.task || '').trim();
  if (!task) throw new Error(t('頼みが必要です。'));
  const n = validateRacerCount(opts.n || 3);
  if (!(await isGitRepo(cwd))) throw new Error(t('競争は git のリポジトリの中で実行してください。'));
  const base = await headSha(cwd);
  if (!base) throw new Error(t('競争は git のリポジトリの中で実行してください。'));
  const dirty = await dirtyFiles(cwd);
  if (dirty.length && opts.includeDirty === undefined) {
    const e = new Error(t('未コミットの変更が {n} 件あります。含めて始めるか、先にコミットしてください。', {n: dirty.length}));
    e.code = 'dirty'; e.dirtyFiles = dirty; throw e;
  }
  const id = opts.id || newRaceId();
  const dir = opts.stateDir || stateDirFor(id);
  // An id whose state dir already holds a race is TAKEN: re-running under
  // the same id used to walk into the earlier race's folder, and this
  // run's failure cleanup then deleted the earlier race's worktrees and
  // state dir along with its own (audit-cli wave 10). Refuse before
  // anything is created, and delete nothing. The id-derived dir is
  // checked for any existence; an explicitly passed stateDir counts as
  // taken once it holds a race record (result.json) — a bare folder the
  // caller prepared as this race's scratch dir is still usable.
  if (!opts.stateDir && fs.existsSync(dir)) throw new Error(t('その競争の ID はすでに使われています: {id}', {id}));
  if (opts.stateDir && fs.existsSync(path.join(dir, 'result.json'))) throw new Error(t('その競争の ID はすでに使われています: {id}', {id}));
  fs.mkdirSync(dir, {recursive: true});
  const snapshot = dirty.length && opts.includeDirty ? await dirtySnapshot(cwd) : null;
  const runner = opts.runner || execRunner;
  const accounts = assignAccounts(n, opts.accounts);
  // Only worktrees this run actually created: a path is added AFTER its
  // creation succeeds, so failure cleanup can never remove a tree that
  // was already there (a previous race's, or a folder blocking creation).
  const createdWorktrees = [];
  const racers = [];
  let raceStatus = 'running';
  const startedAt = opts.startedAt || new Date().toISOString();
  // The state file exists from the first worktree on and is refreshed on
  // every racer status change (see writeRaceState): a hard kill mid-race
  // no longer leaves worktrees that apply/clean can never reach. The
  // snapshot is rebuilt each time, so it always carries the racers'
  // latest statuses (and, for racers that finished, their patch files).
  const currentState = (finishedAt = null) => ({id, task, cwd, base, dir, startedAt, finishedAt,
    status: raceStatus, pid: process.pid,
    totalTokens: racers.reduce((s, r) => s + (r.tokens || 0), 0) || null,
    racers: racers.map(r => ({...r}))});
  const saveState = () => { try { writeRaceState(dir, currentState()); } catch {} };
  // A failure partway (the second worktree will not create, the snapshot
  // will not apply) must not orphan what was already made: an in-process
  // failure is cleaned up here, while the state file above covers the
  // process being killed outright (features-debug #29, audit-cli wave 3).
  // Clean up everything created so far and rethrow.
  const cleanupCreated = async () => {
    for (const wt of createdWorktrees) { try { await removeWorktree(cwd, wt); } catch {} }
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
  };
  try {
    for (let i = 0; i < n; i++) {
      const wt = path.join(dir, 'wt-' + (i + 1));
      await createWorktree(cwd, wt);
      createdWorktrees.push(wt);
      if (snapshot) await applyDirtySnapshot(cwd, wt, snapshot);
      racers.push({index: i + 1, strategy: STRATEGIES[i % STRATEGIES.length], account: accounts[i], worktree: wt, status: 'waiting'});
      saveState();
    }
  } catch (e) { await cleanupCreated(); throw e; }
  opts.onProgress && opts.onProgress(t('作業フォルダーを作りました（{n} 体）', {n}));
  let usedTokens = 0;
  const runOne = async r => {
    if (opts.maxTokens && usedTokens >= opts.maxTokens) { r.status = 'skipped'; saveState(); return; }
    r.status = 'running';
    saveState();
    const t0 = Date.now();
    let res;
    try { res = await runner({cwd: r.worktree, prompt: task + '\n\n' + r.strategy.instruction, account: r.account, mode: opts.mode, timeoutMs: opts.runnerTimeoutMs}); }
    catch (e) { res = {ok: false, error: e.message}; }
    r.durationMs = Date.now() - t0;
    r.ok = !!res.ok; r.error = res.error || ''; r.session = res.session || null;
    r.replyHead = String(res.reply || '').split('\n').find(s => s.trim())?.trim().slice(0, 120) || '';
    r.usage = res.usage || null; r.tokens = tokensOf(res.usage);
    if (r.tokens) usedTokens += r.tokens;
    try {
      const commands = opts.checkCommands !== undefined ? opts.checkCommands : detectCommands(r.worktree);
      r.checks = [];
      for (const cmd of commands) r.checks.push(await runShellCommand(cmd, r.worktree, opts.checkTimeoutMs));
      r.diff = await collectDiff(r.worktree, base);
      if (r.diff.patch) {
        r.patchFile = 'racer-' + r.index + '.patch';
        fs.writeFileSync(path.join(dir, r.patchFile), r.diff.patch);
        // Drift guard (audit-cli wave 10): fingerprint, in the USER's tree,
        // every file this patch touches, as of the race finishing.
        // applyWinner re-checks them (and HEAD against `base`) and refuses
        // when the tree moved on after the race, instead of silently
        // applying a patch made against older contents.
        r.baseFiles = snapshotPatchTargets(cwd, r.diff.patch);
      }
      const {patch, ...diffInfo} = r.diff; r.diff = diffInfo;
      const events = readWorklog(r.session, {dir: opts.worklogDir});
      r.badge = proofBadge(events); r.worklogEvents = events.length;
    } catch (e) {
      // One racer's checks or diff failing must not lose the whole race:
      // the racer is marked failed and the result still lands (#29).
      r.error = (r.error ? r.error + ' / ' : '') + e.message;
      r.ok = false;
      if (!Array.isArray(r.checks)) r.checks = [];
      if (!r.diff) r.diff = {files: 0, added: 0, removed: 0, ignored: 0, ignoredFiles: []};
      if (!r.badge) r.badge = {mark: '—', code: 'none'};
    }
    r.status = r.ok ? 'done' : 'failed';
    saveState();
    // The strategy name is translated here too, as formatRaceResult does
    // with t(r.strategy.label): the progress notice used to carry the raw
    // Japanese label into an otherwise English run (wave 12).
    opts.onProgress && opts.onProgress(t('{name} が終わりました', {name: t(r.strategy.label)}));
  };
  try {
    if (opts.maxTokens) { for (const r of racers) await runOne(r); }
    else await Promise.all(racers.map(runOne));
    raceStatus = 'finished';
    const result = currentState(new Date().toISOString());
    writeRaceState(dir, result);
    return result;
  } catch (e) { await cleanupCreated(); throw e; }
}

function loadRace(idOrDir) {
  const dir = idOrDir && fs.existsSync(path.join(idOrDir, 'result.json')) ? idOrDir : stateDirFor(idOrDir);
  const file = path.join(dir, 'result.json');
  let result;
  try { result = {...JSON.parse(fs.readFileSync(file, 'utf8')), dir}; } catch {
    // A missing file simply means no such race. A file that exists but
    // does not parse is torn (writeRaceState's direct-write fallback can
    // leave one): move it aside as result.json.corrupt-<stamp> before
    // answering null, so the loss is visible and its bytes stay
    // recoverable instead of the race silently reading as never run
    // (audit-cli wave 17).
    try { if (fs.existsSync(file)) fs.renameSync(file, file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {}
    return null;
  }
  // A state file with no finishedAt was last written by a race still in
  // flight — or by one whose process was killed before it could write the
  // final state. The recorded pid tells the two apart: alive means the
  // race is genuinely still running; gone means it was interrupted, and
  // its unfinished racers are marked so, so the leftovers are never
  // mistaken for a live race. Either way the race IS loadable, so clean
  // (and apply, for a racer that did finish) can reach it instead of its
  // worktrees being orphaned forever.
  if (!result.finishedAt) {
    result.ownerAlive = isPidAlive(result.pid);
    result.interrupted = !result.ownerAlive;
    if (result.interrupted) {
      result.status = 'interrupted';
      for (const r of result.racers || []) if (r.status === 'waiting' || r.status === 'running') r.status = 'interrupted';
    } else result.running = true;
  }
  return result;
}
function diffText(result, index) {
  const r = (result.racers || []).find(x => x.index === index);
  if (!r || !r.patchFile) return '';
  try { return fs.readFileSync(path.join(result.dir, r.patchFile), 'utf8'); } catch { return ''; }
}
async function applyWinner(result, index) {
  const r = (result.racers || []).find(x => x.index === index);
  if (!r) throw new Error(t('競争が見つかりません: {id}', {id: index}));
  // A skipped racer never ran, so it has no patch at all: the empty-patch
  // success below is only for a done racer that genuinely changed nothing.
  // Returning it for a skipped racer reported a no-op apply as success.
  if (r.status === 'skipped') throw new Error(t('その参加者は上限で見送られたため、差分がありません: {n}', {n: index}));
  // A failed racer's patch is whatever it managed before it failed —
  // half-done work the comparison never vouched for. Only a racer that
  // finished (status 'done') may be applied (audit-cli wave 10); every
  // other status is refused by one of the guards here.
  if (r.status === 'failed') throw new Error(t('その参加者は失敗したため、差分を当てられません: {n}', {n: index}));
  // A racer that never finished (the race was killed while it waited or
  // ran) has no complete patch either: the empty-patch success below must
  // not report applying its nothing as a win. A racer marked done in an
  // interrupted race DOES carry its patch file, and stays applicable.
  if (r.status === 'interrupted') throw new Error(t('中断しました'));
  if (r.status === 'waiting' || r.status === 'running') {
    // loadRace has already turned a dead writer's waiting/running racers
    // into 'interrupted' above, so one still waiting/running here belongs
    // to a race that is still going (or was never marked interrupted):
    // it has not finished yet, it was not interrupted — naming the wrong
    // cause sent the user looking at a crash that never happened
    // (audit-cli wave 6). A result explicitly marked interrupted keeps
    // the interrupted wording even if its racer statuses were not.
    if (result.interrupted || result.status === 'interrupted') throw new Error(t('中断しました'));
    throw new Error(t('競争は実行中です。終わるまで待ってください。'));
  }
  const patch = diffText(result, index);
  if (!patch.trim()) return {ok: true, empty: true};
  // Drift guard (audit-cli wave 10): the patch was made against the tree
  // as it stood when the race finished. If HEAD has moved since, or any
  // file the patch touches has changed in the user's tree, refuse and
  // say why, rather than applying onto contents the race never saw (git
  // apply --check alone would still pass some of these and silently land
  // the patch in a new context). Races recorded before the guard existed
  // carry no baseFiles and skip the per-file half; `base` has always been
  // recorded, and a missing/unreadable HEAD skips the HEAD half too.
  if (result.base) {
    const head = await headSha(result.cwd);
    if (head && head !== result.base) return {ok: false, error: t('HEAD が競争の開始後に変わっています。当てられませんでした。')};
  }
  if (r.baseFiles) {
    const changed = Object.keys(r.baseFiles).filter(rel => hashTreeFile(result.cwd, rel) !== r.baseFiles[rel]);
    if (changed.length) return {ok: false, error: t('当てようとしたファイルが競争の開始後に変わっています: {files}', {files: changed.join(', ')})};
  }
  const file = path.join(result.dir, r.patchFile);
  const check = await git(result.cwd, ['apply', '--check', '--whitespace=nowarn', file]);
  if (check.code !== 0) return {ok: false, error: (check.stderr || check.stdout).trim()};
  const applied = await git(result.cwd, ['apply', '--whitespace=nowarn', file]);
  return applied.code === 0 ? {ok: true} : {ok: false, error: (applied.stderr || applied.stdout).trim()};
}
// Where a cleaned race's record is kept: an `archive` folder NEXT TO the
// state folders (a sibling of <race id>\, under the same parent), holding
// that race's patches and result.json. It deliberately does not live
// inside the state dir, so the state dir itself still goes away whole —
// only the worktrees and scratch go; the record survives (audit-cli
// wave 15).
function archiveDirFor(dir) { return path.join(path.dirname(dir), 'archive', path.basename(dir)); }
async function cleanupRace(result) {
  const racers = result.racers || [];
  const wts = new Set(racers.map(r => r.worktree).filter(Boolean));
  // A race killed while it was still creating its worktrees may list
  // fewer racers than the wt-* folders on disk; take those too, or the
  // plain folder delete below would leave their git worktree
  // registrations orphaned in the user's repository.
  try { for (const name of fs.readdirSync(result.dir)) if (/^wt-\d+$/.test(name)) wts.add(path.join(result.dir, name)); } catch {}
  // Salvage BEFORE anything is removed (audit-cli wave 15): a racer of an
  // interrupted race that never reached collectDiff has no patch file,
  // so its worktree holds the only copy of its partial work. Try to take
  // its diff now, the same way runRace does; what comes out is written
  // as its patch file and archived below like any other racer's.
  const salvagedFiles = [];
  const raceInterrupted = !!(result.interrupted || result.status === 'interrupted');
  for (const r of racers) {
    if (r.patchFile) continue;
    if (!raceInterrupted && r.status !== 'interrupted') continue;
    if (!r.worktree || !fs.existsSync(r.worktree)) continue;
    try {
      const d = await collectDiff(r.worktree, result.base || 'HEAD');
      if (d && d.patch && d.patch.trim()) {
        const name = 'racer-' + r.index + '.patch';
        fs.writeFileSync(path.join(result.dir, name), d.patch);
        r.patchFile = name;
        const {patch, ...diffInfo} = d; r.diff = diffInfo;
        r.salvaged = true;
        salvagedFiles.push(name);
      }
    } catch {}
  }
  // Archive BEFORE the worktrees go (audit-cli wave 15, the old wave-1
  // W1-10 data loss): every racer's patch — the losers' above all, whose
  // only copy this was — plus result.json are copied to the archive
  // folder first. The archived result.json is the on-disk state with any
  // salvaged racers filled in, stamped with where and when it was kept.
  // If the copy fails, the state dir is left standing for a retry instead
  // of deleting the only copy of a failed archive.
  const archivedFiles = [];
  let patchCount = 0;
  let archiveDir = null;
  let archiveFailed = false;
  try {
    const patchNames = new Set();
    for (const r of racers) if (r.patchFile) patchNames.add(path.basename(String(r.patchFile)));
    try { for (const name of fs.readdirSync(result.dir)) if (/^racer-\d+\.patch$/.test(name)) patchNames.add(name); } catch {}
    const patches = [...patchNames].filter(name => fs.existsSync(path.join(result.dir, name)));
    patchCount = patches.length;
    const stateFile = path.join(result.dir, 'result.json');
    if (patches.length || fs.existsSync(stateFile)) {
      archiveDir = archiveDirFor(result.dir);
      fs.mkdirSync(archiveDir, {recursive: true});
      for (const name of patches) { fs.copyFileSync(path.join(result.dir, name), path.join(archiveDir, name)); archivedFiles.push(name); }
      let state = null;
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      if (!state || typeof state !== 'object' || Array.isArray(state)) state = {...result};
      if (Array.isArray(state.racers)) for (const sr of state.racers) {
        const r = racers.find(x => x.index === sr.index);
        if (r && r.salvaged) { sr.patchFile = r.patchFile; sr.diff = r.diff; sr.salvaged = true; }
      }
      state.archivedAt = new Date().toISOString();
      state.archiveDir = archiveDir;
      fs.writeFileSync(path.join(archiveDir, 'result.json'), JSON.stringify(state, null, 2) + '\n');
      archivedFiles.push('result.json');
    }
  } catch { archiveFailed = true; }
  for (const wt of wts) await removeWorktree(result.cwd, wt);
  if (!archiveFailed) try { fs.rmSync(result.dir, {recursive: true, force: true}); } catch {}
  return {archiveDir, archivedFiles, archivedCount: archivedFiles.length, patchCount,
    salvagedFiles, salvagedCount: salvagedFiles.length};
}

// --- presentation ----------------------------------------------------------------
function formatRaceResult(result) {
  const lines = [t('競争の結果（{id}）: {task}', {id: result.id, task: String(result.task).slice(0, 60)})];
  for (const r of result.racers) {
    lines.push(t('{n}. {strategy} / {account}', {n: r.index, strategy: t(r.strategy.label), account: r.account || t('既定')}));
    if (r.status === 'skipped') { lines.push('   ' + t('上限で見送り')); continue; }
    if (r.status === 'interrupted') { lines.push('   ' + t('中断しました')); continue; }
    const status = r.ok ? t('完了') : t('失敗');
    const passed = (r.checks || []).filter(x => x.code === 0).length;
    const checks = (r.checks || []).length ? t('検査 {passed}/{total} 通過', {passed, total: r.checks.length}) : t('検査なし');
    // Numbers read at the other screens' level, not raw: the shared
    // durationText picks the largest whole unit (90061 s is not shown as
    // '90061 秒') and formatTokens shortens counts (1234567 -> '1.2M').
    lines.push('   ' + [status, checks,
      t('差分 {files} ファイル +{added} −{removed}', {files: r.diff?.files || 0, added: r.diff?.added || 0, removed: r.diff?.removed || 0}),
      durationText(r.durationMs || 0), t('トークン {tokens}', {tokens: r.tokens == null ? '—' : formatTokens(r.tokens)}), t('裏取り {badge}', {badge: r.badge?.mark || '—'})].join(' ・ '));
    // A timed-out check is not an ordinary failure: it ran out of time,
    // which says something different about the work, so it stays visible
    // by name instead of sinking into the pass count (audit-cli wave 10).
    for (const c of r.checks || []) if (c.timedOut) lines.push('   ' + t('検査が時間切れになりました: {command}', {command: c.command}));
    // Ignored new files are in no patch: the user should hear that they
    // exist (and that cleanup will not bring them over) instead of the
    // worktree silently being their only copy (audit-cli wave 15).
    if (r.diff && r.diff.ignored) lines.push('   ' + t('差分に含まれないファイル（gitignore 対象）が {n} 件あります', {n: r.diff.ignored}));
    if (!r.ok && r.error) lines.push('   ' + String(r.error).slice(0, 120));
  }
  if (result.totalTokens) lines.push(t('合計トークン: {total}', {total: formatTokens(result.totalTokens)}));
  lines.push(t('作業フォルダー: {dir}', {dir: result.dir}));
  return lines;
}
// `muser race` / `/race` argument text: <task> [--n 3] [--accounts a,b]
// [--max-tokens N] [--yes] — the design writes the flags after the task, so
// the known race flags are taken out wherever they appear (a task that
// literally contains the words `--n 3` loses them; quote the task and put
// the flags first if that ever matters). A `--` ends flag parsing.
// The `--flag=value` spellings bin's parse() accepts work here too, in
// either position, and values are judged exactly as bin judges them
// before the task: a bad or missing value is a usage error, never task
// text, and a value-taking flag never swallows a word starting with
// `--` as its value (audit-cli wave 17).
function parseRaceArgs(text) {
  const out = {task: '', yes: false};
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const rest = [];
  let literal = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (literal) { rest.push(w); continue; }
    if (w === '--') { literal = true; continue; }
    if (w === '--yes') { out.yes = true; continue; }
    if (w === '--n' || w.startsWith('--n=')) { const v = w.startsWith('--n=') ? w.slice(4) : words[i + 1]; if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > MAX_RACERS) throw new Error('--n: ' + t('参加者は 1〜{max} 体にしてください。', {max: MAX_RACERS})); if (w === '--n') i++; out.n = Number(v); continue; }
    if (w === '--accounts' || w.startsWith('--accounts=')) { const v = w.startsWith('--accounts=') ? w.slice(11) : words[i + 1]; if (v === undefined || v === '' || v.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag: '--accounts'})); if (w === '--accounts') i++; out.accounts = v.split(',').map(s => s.trim()).filter(Boolean); continue; }
    if (w === '--max-tokens' || w.startsWith('--max-tokens=')) { const v = w.startsWith('--max-tokens=') ? w.slice(13) : words[i + 1]; if (v === undefined || !/^\d+$/.test(v) || !Number.isFinite(Number(v))) throw new Error(t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag: '--max-tokens'})); if (w === '--max-tokens') i++; out.maxTokens = Number(v); continue; }
    rest.push(w);
  }
  out.task = rest.join(' ');
  return out;
}

module.exports = {STRATEGIES, MAX_RACERS, validateRacerCount, raceRoot, worklogDir, stateDirFor, newRaceId,
  readWorklog, proofBadge, isGitRepo, headSha, dirtyFiles, createWorktree, removeWorktree, collectDiff, ignoredNewFiles, archiveDirFor,
  detectCommands, runShellCommand, patchFiles, snapshotPatchTargets, execRunner, tokensOf, accountIds, assignAccounts, estimate,
  runRace, loadRace, diffText, applyWinner, cleanupRace, formatRaceResult, parseRaceArgs, isPidAlive};
