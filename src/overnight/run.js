'use strict';
// The overnight run itself (design new-features.md §8): queued tasks run one
// by one, each in its own git worktree + branch through `muser exec`, on the
// account with the most allowance left. Judgement calls do not stop the
// night: a runner may report questions (it picked the likeliest answer and
// went on) and they are saved on the item for the morning. Approvals follow
// the overnight setting — default 'edit-auto': edits run automatically,
// commands that need confirmation are declined by the headless exec, and a
// task that hits one is DEFERRED to the morning instead of being approved
// blind. Usage caps (tokens / tasks) stop the run cleanly between tasks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {renameRetry} = require('../config');
const {t, lang} = require('../i18n');
const {formatTokens} = require('../turn-usage');
const Q = require('./queue');
const W = require('./worktree');
const WL = require('./worklog-read');

const APPROVAL_TO_MODE = {'edit-auto': 'auto-edit', 'confirm-all': 'default', 'bypass': 'bypass'};
const oneLine = (s, n = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// The real runner: one `muser exec --json` child in the task's worktree.
// Its JSON lines give the session, the token usage and — crucial for the
// approval rule — the tool events the headless approver declined.
function makeExecRunner({binFile = path.join(__dirname, '..', '..', 'bin', 'muser.js'), spawnFn = spawn, timeoutMs = 2 * 60 * 60 * 1000} = {}) {
  return function execRunner({item, cwd, account, mode}) {
    return new Promise((resolve, reject) => {
      const args = [binFile, 'exec', '--json', '--cd', cwd, '--mode', mode, ...(account ? ['--account', account] : []), '--', item.prompt];
      let child;
      try { child = spawnFn(process.execPath, args, {cwd, windowsHide: true}); } catch (e) { reject(e); return; }
      let out = '', err = '', timedOut = false;
      // A hung child must not hang the whole night (features-debug #26).
      const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
      child.stdout?.on('data', d => { out += d; });
      child.stderr?.on('data', d => { err = (err + d).slice(-4000); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) { resolve({ok: false, error: 'muser exec timed out', needsConfirmation: false, declinedCommands: [], tokens: 0, questions: []}); return; }
        let result = null; const declined = [];
        for (const line of out.split(/\r?\n/)) {
          if (!line.trim().startsWith('{')) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === 'result') result = e;
          if (e.type === 'tool' && e.declined) declined.push(oneLine((e.command || '') + ' ' + (e.summary || ''), 120));
        }
        if (!result) { resolve({ok: false, error: oneLine(err || ('muser exec exited ' + code), 300), needsConfirmation: declined.length > 0, declinedCommands: declined, tokens: 0, questions: []}); return; }
        const u = result.turnUsage || result.usage || {};
        const tokens = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0);
        resolve({ok: !!result.ok && code !== 1, error: result.ok ? undefined : oneLine(result.error || err || ('muser exec exited ' + code), 300), reply: oneLine(result.reply, 500), session: result.session || null, tokens,
          needsConfirmation: declined.length > 0, declinedCommands: declined,
          focusStatus: result.focus?.status || (result.completed === false ? 'incomplete' : null), questions: []});
      });
    });
  };
}

async function defaultStatuses() { try { return await require('../account-pool').statuses(); } catch { return []; } }
const realSleep = ms => new Promise(r => setTimeout(r, ms));

// Waits are slept in small chunks, re-reading the wall clock after every
// chunk (wave 11): one long sleep computed from a single clock reading
// ends at the wrong wall moment when the clock jumps — too early when it
// is set back, too late when it leaps forward past the target. The chunk
// count is capped generously past the planned number of chunks (a clock
// setback legitimately needs a few extra), so a fake sleep that never
// moves the clock cannot spin this loop forever.
const SLEEP_CHUNK_MS = 1000;
async function sleepUntil(targetMs, now, sleep) {
  const planned = targetMs - now();
  if (!(planned > 0)) return;
  // The chunk budget is RE-COMPUTED while a remainder is left (wave 15):
  // whenever the remaining time grows — the clock was set back, so the
  // wait legitimately got longer — the budget is extended from the new
  // remainder instead of the run waking at the old cap. A clock that
  // never moves and never grows the remainder still exhausts the budget,
  // so a fake sleep that does not advance time cannot spin forever.
  let maxChunks = Math.ceil(planned / SLEEP_CHUNK_MS) + 120;
  let prevRemaining = planned;
  for (let i = 0; i < maxChunks; i++) {
    const remaining = targetMs - now();
    if (!(remaining > 0)) return;
    if (remaining > prevRemaining) maxChunks = i + Math.ceil(remaining / SLEEP_CHUNK_MS) + 120;
    prevRemaining = remaining;
    await sleep(Math.min(remaining, SLEEP_CHUNK_MS));
  }
}

// Saving the queue mid-run is a three-way merge (wave 15, on top of the
// wave-11 re-read): the state this run loaded at the start (the baseline
// closure in runOvernight), the queue on disk now, and this run's memory
// are merged under the queue lock via updateQueue — items another process
// added survive, items it removed are dropped from the run's copy too,
// and the run's own item states win for the items it touched. A broken
// on-disk queue falls back to a plain save rather than losing the night's
// progress. The closure is built inside runOvernight; see saveRunQueue.

async function runOvernight(opts = {}) {
  // One run at a time across processes (wave 15): the run lock is held for
  // the whole night and released whatever happens; a live holder refuses
  // the second start in words, a dead holder's lock is reclaimed inside
  // acquireRunLock. opts.runLock === false is the test seam for a caller
  // that already serialises runs itself.
  const releaseRunLock = opts.runLock === false ? null : Q.acquireRunLock(opts);
  try { return await runOvernightLocked(opts); }
  finally { if (releaseRunLock) releaseRunLock(); }
}

async function runOvernightLocked(opts = {}) {
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || realSleep;
  const runner = opts.runner || makeExecRunner();
  const statusesFn = opts.statusesFn || defaultStatuses;
  const checkPower = opts.checkPower || Q.defaultCheckPower;
  const approval = opts.approval || 'edit-auto';
  const mode = APPROVAL_TO_MODE[approval] || 'auto-edit';
  const maxTokens = Number(opts.maxTokens) || 0;
  const maxTasks = Number(opts.maxTasks) || 0;
  const queue = Q.loadQueue(opts);
  // The three-way merge baseline: the queue exactly as this run loaded it.
  // Every save during the run merges against the disk state and then
  // re-baselines to what was actually written.
  let baseline = Q.snapshotQueue(queue);
  const saveRunQueue = () => {
    try {
      Q.updateQueue(disk => { Q.mergeQueueForRun(queue, baseline, disk); disk.items = queue.items; }, opts);
    } catch { try { Q.saveQueue(queue, opts); } catch {} }
    baseline = Q.snapshotQueue(queue);
  };
  // An item still marked 'running' belongs to a run that died mid-task
  // (a run is one-shot per process, so nothing else can be running it):
  // put it back in line, or it would never run and never be reported
  // (features-debug #33).
  let recovered = 0;
  for (const i of queue.items) if (i.status === 'running') { i.status = 'queued'; recovered++; }
  if (recovered) saveRunQueue();
  const runId = 'run-' + new Date(now()).toISOString().replace(/[:.]/g, '-');
  const report = {version: 1, runId, startedAt: now(), endedAt: null, approval, mode, power: null, estimate: null, caps: {maxTokens, maxTasks}, totalTokens: 0, items: [], stoppedReason: null, recovered};
  const emit = r => { report.items.push(r); if (opts.onEvent) { try { opts.onEvent(r); } catch {} } };

  if (opts.at && opts.at > now()) { const waitStart = now(); await sleepUntil(opts.at, now, sleep); report.waitedMs = Math.max(0, now() - waitStart); }
  try { report.power = checkPower(); } catch { report.power = null; }
  let statuses = [];
  try { statuses = await statusesFn(); } catch { statuses = []; }
  report.estimate = Q.estimate(queue, {statuses});

  const pending = queue.items.filter(i => i.status === 'queued' || i.status === 'deferred');
  // The task cap counts items whose processing was ATTEMPTED, not items
  // that reached the runner (wave 11): a task that fails before the runner
  // starts — not a git repo, a worktree that cannot be made, a runner that
  // throws — still consumed one of the night's tries, so the next task
  // must not silently take its place under the same cap.
  let attempted = 0;
  for (const item of pending) {
    // Right before an item starts, the queue is re-read from disk (wave
    // 15): an item removed while the night was running must not run after
    // all. It leaves the run's copy as well, is reported as skipped (so
    // it is not listed as merely unrun either), and consumes no cap. A
    // re-read that fails proves nothing, so the item then runs as planned.
    let stillOnDisk = true;
    try { stillOnDisk = Q.loadQueue(opts).items.some(i => i.id === item.id); } catch { stillOnDisk = true; }
    if (!stillOnDisk) {
      const ix = queue.items.indexOf(item); if (ix >= 0) queue.items.splice(ix, 1);
      emit({id: item.id, prompt: oneLine(item.prompt, 120), status: 'skipped', branch: item.branch || null, worktree: null, session: null, tokens: 0, badge: 'no-log', questions: [], note: t('開始前にキューから外されていたため実行しませんでした'), error: null});
      continue;
    }
    // An item loadQueue parked as deferred because its stored status was
    // missing or unknown (wave 18, see queue.js) is reported, not run: its
    // real state is unknowable here (it may already have run under the
    // version that wrote it), so running it blind could do the work twice.
    // It gets a deferred record carrying loadQueue's reason, stays deferred
    // in the queue for the morning, and consumes no cap — like the skipped
    // case above, nothing was attempted. Being in `pending` (deferred is
    // pending) it is also counted by the estimate, and this record keeps it
    // out of `unrun` only because it IS in the report, with its reason.
    if ('invalidStatus' in item) {
      emit({id: item.id, prompt: oneLine(item.prompt, 120), status: 'deferred', branch: item.branch || null, worktree: null, session: null, tokens: 0, badge: 'no-log', questions: [], note: typeof item.note === 'string' && item.note ? item.note : null, error: null});
      continue;
    }
    if (maxTasks && attempted >= maxTasks) { report.stoppedReason = 'task-cap'; break; }
    if (maxTokens && report.totalTokens >= maxTokens) { report.stoppedReason = 'token-cap'; break; }
    attempted++;
    // Account for this task: a named account on the item wins; otherwise the
    // pool's least-used account with allowance. All exhausted -> wait for the
    // earliest reset when allowed, else stop with the rest still queued.
    const namedAccount = !!(item.account || opts.account); // a named account is never swapped out
    let account = item.account || opts.account || null;
    if (!account && statuses.length) {
      let pick = Q.pickAccount(statuses);
      if (pick.account) account = pick.account.id;
      else {
        // All exhausted. A reset time already in the past means the plan
        // this reading came from is stale — the reset it names should
        // already have happened — so re-read the plan once before
        // believing the exhaustion. The old code only handled a FUTURE
        // reset and otherwise fell through with account still null,
        // running the task on the default account (audit wave 9).
        if (!(pick.waitUntil > now())) {
          try { statuses = await statusesFn(); } catch {}
          pick = Q.pickAccount(statuses);
          if (pick.account) account = pick.account.id;
        }
        if (!account && pick.waitUntil && pick.waitUntil > now()) {
          if (opts.waitForReset) { const waitStart = now(); const waitTarget = Math.min(pick.waitUntil, waitStart + (opts.maxWaitMs || (pick.waitUntil - waitStart))); await sleepUntil(waitTarget, now, sleep); try { statuses = await statusesFn(); } catch {} const again = Q.pickAccount(statuses); if (again.account) account = again.account.id; else if (again.waitUntil) pick = again; }
        }
        // Still no account and no future reset is known: stop the night
        // with the rest queued instead of running on the default account.
        if (!account) { report.stoppedReason = 'accounts-exhausted'; if (pick.waitUntil) report.earliestReset = pick.waitUntil; break; }
      }
    }
    item.status = 'running'; item.startedAt = now(); item.account = account;
    saveRunQueue();
    // The report's questions are only this run's increase (wave 11): the
    // item keeps its earlier questions for the morning, but re-reporting
    // them every run made a re-run look like it asked everything again.
    if (!Array.isArray(item.questions)) item.questions = [];
    const questionsBefore = item.questions.length;
    const rec = {id: item.id, prompt: oneLine(item.prompt, 120), status: null, branch: null, worktree: null, session: null, tokens: 0, badge: 'no-log', questions: [], note: null, error: null};
    let wt = null;
    try {
      if (!W.isGitRepo({repoDir: item.cwd, runGit: opts.runGit})) throw new Error(t('git リポジトリではないため夜間作業を始められません: {dir}', {dir: item.cwd}));
      wt = W.createWorktree({repoDir: item.cwd, baseDir: path.join(Q.worktreesDir(opts), runId), taskId: item.id, runGit: opts.runGit});
      item.branch = wt.branch; item.worktree = wt.dir;
      let r = await runner({item, cwd: wt.dir, account, mode});
      // An account that could not connect at all (HTTP 5xx, nothing ran) is not the task's
      // fault: try the task once more on another account with allowance, unless the
      // account was named. (Found on a real run: the pool's least-used account answered
      // 502 and the night's only task failed as "run failed".)
      if (!r.ok && !namedAccount && !(Number(r.tokens) > 0) && /接続できませんでした|HTTP 5\d\d|ECONNREFUSED|ECONNRESET/i.test(String(r.error || '')) && statuses.length > 1) {
        const other = Q.pickAccount(statuses.filter(st => st.id !== account));
        if (other.account) { rec.note = t('アカウント {a} が接続できなかったため、{b} でやり直しました', {a: account, b: other.account.id}); account = other.account.id; item.account = account; r = await runner({item, cwd: wt.dir, account, mode}); }
      }
      rec.session = r.session || null; rec.tokens = Number(r.tokens) || 0;
      report.totalTokens += rec.tokens;
      if (Array.isArray(r.questions)) for (const q of r.questions) { const qq = typeof q === 'string' ? {text: oneLine(q, 300)} : {text: oneLine(q.text || q.question, 300), ...(q.chosen ? {chosen: oneLine(q.chosen, 120)} : {})}; if (qq.text) { item.questions.push(qq); rec.questions.push(qq); } }
      // Whatever the run produced is snapshotted onto the branch before the
      // folder goes away; a folder holding un-committable (secret-shaped)
      // files is kept and named in the report instead.
      let kept = false;
      let commitError = null, committed = false, sensitiveCount = 0, committedFiles = 0;
      try { const c = W.commitWorktree({dir: wt.dir, message: 'muser overnight: ' + oneLine(item.prompt, 80), runGit: opts.runGit}); committed = !!c.committed; sensitiveCount = Number(c.sensitive) || 0; committedFiles = Number(c.files) || 0; if (sensitiveCount) { kept = true; rec.note = t('秘密らしいファイルが {n} 件あるため、作業フォルダーを残しました（ブランチには入れていません）', {n: sensitiveCount}); } } catch (e) { commitError = e; kept = true; }
      // A task whose results did not land on the branch is NOT done (wave
      // 15, W1-12): a failed commit, or files kept back (secret-shaped),
      // makes it 'uncommitted' below — the worktree is kept and its path
      // goes into the report so the morning can still reach the results.
      // A clean tree is different again: nothing was produced, and the
      // report says so as 変更なし instead of implying a snapshot exists.
      const hasUncommitted = !!commitError || sensitiveCount > 0;
      const noChange = !commitError && !committed && sensitiveCount === 0 && committedFiles === 0;
      if (commitError) rec.note = (rec.note ? rec.note + ' ' : '') + t('成果をコミットできませんでした: {error}', {error: oneLine(commitError.message, 200)});
      if (noChange) rec.note = (rec.note ? rec.note + ' ' : '') + t('変更なし');
      if (!kept) { W.removeWorktree({repoDir: item.cwd, dir: wt.dir, runGit: opts.runGit}); item.worktree = null; }
      else { item.worktree = wt.dir; rec.worktree = wt.dir; }
      const sum = WL.summarizeWorklog(rec.session, {baseDir: opts.worklogDir});
      rec.badge = sum.badge;
      // An errored result is a failure even when it also needs
      // confirmation (wave 11): the old order reported it as merely
      // deferred and dropped the error text the morning needs.
      if (!r.ok) { item.status = 'failed'; rec.status = 'failed'; rec.error = oneLine(r.error || 'run failed', 300); }
      else if (r.needsConfirmation) { item.status = 'deferred'; rec.status = 'deferred'; rec.note = (rec.note ? rec.note + ' ' : '') + t('確認が要るコマンドがあったため朝に回しました: {list}', {list: (r.declinedCommands || []).join(' / ').slice(0, 200)}); item.questions.push({text: t('確認が要るコマンドを承認しますか: {list}', {list: (r.declinedCommands || []).join(' / ').slice(0, 200)})}); }
      else if (r.focusStatus && r.focusStatus !== 'complete') { item.status = 'blocked'; rec.status = 'blocked'; rec.note = (rec.note ? rec.note + ' ' : '') + t('Focus 判定は {status} でした', {status: r.focusStatus}); }
      else if (hasUncommitted) { item.status = 'uncommitted'; rec.status = 'uncommitted'; rec.note = (rec.note ? rec.note + ' ' : '') + t('成果が未コミットのため、作業フォルダーを残しました: {dir}', {dir: wt.dir}); }
      else { item.status = 'done'; rec.status = 'done'; }
      if (r.reply) rec.reply = r.reply;
    } catch (e) {
      item.status = 'failed'; rec.status = 'failed'; rec.error = oneLine(e.message, 300);
      if (wt && item.worktree) { /* keep the folder for a failed run: it is the only copy of partial work */ rec.worktree = wt.dir; rec.note = t('作業フォルダーを残しました: {dir}', {dir: wt.dir}); }
    }
    item.endedAt = now(); item.tokens = rec.tokens; item.badge = rec.badge; if (rec.error) item.error = rec.error;
    rec.branch = item.branch || null; rec.questions = item.questions.slice(questionsBefore);
    saveRunQueue();
    emit(rec);
    // Allowance is re-read after every task: the reading taken at the
    // start of the night goes stale as tasks consume it, and picking from
    // it all night would drain one account while the others sit idle
    // (features-debug #34). The first task uses the start-of-run reading,
    // which is fresh by definition.
    try { statuses = await statusesFn(); } catch {}
  }
  // An early stop names what it did not run (wave 11): the pending items
  // that never got a report record, with their prompts, so the morning
  // report shows the names and the count, not just a reason code.
  const reportedIds = new Set(report.items.map(r => r.id));
  report.unrun = pending.filter(i => !reportedIds.has(i.id)).map(i => ({id: i.id, prompt: oneLine(i.prompt, 120)}));
  report.unrunCount = report.unrun.length;
  report.remaining = report.unrun;
  report.endedAt = now();
  // A run that processed nothing must not overwrite last night's
  // latest.json with an empty report (wave 11): its own run file is
  // still written, but latest keeps pointing at the last real night.
  if (report.items.length) saveReport(report, opts);
  else saveReport(report, {...opts, updateLatest: false});
  return report;
}

// A direct write can leave a torn file behind if the process dies or the
// disk hiccups mid-write, so both report files go through tmp + rename
// (the saveQueue idiom): readers only ever see the old file or the new one.
// No direct-write fallback (wave 17, as in saveQueue): a kill during one
// tears the report file — and a torn newest run file is then silently
// skipped by loadLatestReport's readers. renameRetry rides out a reader
// holding the file on Windows; if the rename still fails, throw and leave
// the previous file untouched. The tmp name is unique per write, so two
// writers at once never share (and tear) one tmp file.
function writeAtomic(file, body) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    renameRetry(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
function saveReport(report, opts = {}) {
  const dir = Q.reportsDir(opts);
  fs.mkdirSync(dir, {recursive: true});
  const body = JSON.stringify(report, null, 1) + '\n';
  writeAtomic(path.join(dir, report.runId + '.json'), body);
  if (opts.updateLatest !== false) writeAtomic(path.join(dir, 'latest.json'), body);
  return path.join(dir, report.runId + '.json');
}
// A report's own start time, in ms (null when it carries none that
// parses): reports store startedAt as a ms number; an ISO string is
// accepted for hand-written files.
function startedAtMs(report) {
  const v = report && typeof report === 'object' ? report.startedAt : null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  return null;
}
function loadLatestReport(opts = {}) {
  const dir = Q.reportsDir(opts);
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')); } catch {}
  // latest.json is only a shortcut to the newest <runId>.json; when it is
  // missing or corrupt, the run files themselves are still intact, so fall
  // back to the newest one that parses instead of reporting "no report".
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  // The newest run is chosen by the report's own startedAt, not by its
  // file name (wave 17): runIds embed the wall clock at run start, so a
  // run made while the clock was set forward keeps a future name
  // (run-2099-…) that out-sorted every later real report forever, even
  // though the run itself is old. A startedAt in the future counts as
  // now — never newer than now — for the same reason. File mtimes must
  // not decide either (wave 11): a copy/restore rewrites them, and the
  // copied older run would otherwise pass itself off as the newest.
  const now = Date.now();
  const dated = [], undated = [];
  for (const name of names) {
    if (!/^run-.+\.json$/.test(name)) continue;
    let report;
    try {
      if (!fs.statSync(path.join(dir, name)).isFile()) continue;
      report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch { continue; } // a file that does not parse is skipped, as before
    const t = startedAtMs(report);
    if (t === null) undated.push({name, report});
    else dated.push({name, report, at: Math.min(t, now)});
  }
  // Reports whose startedAt does not parse are considered last; among
  // them name order is the only order left (runIds embed their start
  // time, wave 11), and it is the tie-break for equal startedAts too.
  const byNameDesc = (a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  dated.sort((a, b) => (b.at - a.at) || byNameDesc(a, b));
  undated.sort(byNameDesc);
  const ordered = dated.concat(undated);
  return ordered.length ? ordered[0].report : null;
}

const STATUS_JA = {done: '終わった', blocked: '詰まった', deferred: '判断待ち', failed: '失敗', running: '実行中', queued: '待ち', uncommitted: '未コミット', skipped: '取りやめ'};
const statusLabel = s => t(STATUS_JA[s] || s);
// Early-stop reasons reach the morning in Japanese, not as the raw code
// the run records in stoppedReason (wave 11).
const STOPPED_JA = {'task-cap': '処理件数の上限に達しました', 'token-cap': 'トークンの上限に達しました', 'accounts-exhausted': '使えるアカウントがありません（アカウントの利用枠が尽きました）'};
const stoppedLabel = s => t(STOPPED_JA[s] || s);
function formatReport(report) {
  if (!report) return [t('夜間作業の報告はまだありません。')];
  // The heading date takes the UI language's locale (the usage.js formatPlan
  // idiom): a bare toLocaleString() followed the OS, so it could disagree
  // with the language the rest of the report is written in (wave 7). The
  // token counts go through formatTokens like every other surface: they
  // were raw numbers here (1234567 for 1.2M).
  const lines = [t('夜間作業の報告（{at}）', {at: new Date(report.endedAt || report.startedAt).toLocaleString(lang() === 'en' ? 'en-US' : 'ja-JP')}),
    ...(report.recovered ? [t('前回の実行で途中だった頼み {n} 件を待ちに戻しました', {n: report.recovered})] : []),
    t('合計トークン: {n}', {n: formatTokens(report.totalTokens || 0)}) + (report.stoppedReason ? ' · ' + t('止まった理由: {reason}', {reason: stoppedLabel(report.stoppedReason)}) : ''),
    ...(report.power?.note ? [t('電源: {note}', {note: report.power.note})] : [])];
  const unrun = report.unrun || report.remaining || report.unexecuted || [];
  if (Array.isArray(unrun) && unrun.length) {
    lines.push(t('未実行の頼みが {n} 件あります', {n: unrun.length}));
    for (const u of unrun) lines.push('  ' + t('未実行: {prompt}', {prompt: typeof u === 'string' ? u : (u.prompt || u.id || '')}));
  }
  for (const r of report.items || []) {
    lines.push('- [' + statusLabel(r.status) + '] ' + r.prompt);
    lines.push('  ' + t('ブランチ: {branch}', {branch: r.branch || '-'}) + ' · ' + t('トークン: {n}', {n: formatTokens(r.tokens || 0)}) + ' · ' + t('裏取り: {badge}', {badge: r.badge || 'no-log'}));
    if (r.worktree) lines.push('  ' + t('作業フォルダー: {dir}', {dir: r.worktree}));
    if (r.note) lines.push('  ' + r.note);
    if (r.error) lines.push('  ' + t('エラー: {error}', {error: r.error}));
    for (const q of r.questions || []) lines.push('  ' + t('判断待ち: {q}', {q: q.text + (q.chosen ? '（' + q.chosen + '）' : '')}));
  }
  if (!(report.items || []).length) lines.push(t('この実行で処理した頼みはありません。'));
  return lines;
}
function formatQueue(queue) {
  if (!queue.items.length) return [t('夜間作業のキューは空です。')];
  // An item's note rides along when it has one: loadQueue parks an item
  // whose stored status was missing/unknown as deferred with the reason on
  // note (wave 18), and a bare [判断待ち] in the list would not say why.
  return queue.items.map(i => i.id.slice(0, 10) + '  [' + statusLabel(i.status) + '] ' + oneLine(i.prompt, 100) + (i.branch ? '  (' + i.branch + ')' : '') + (typeof i.note === 'string' && i.note ? '  (' + oneLine(i.note, 100) + ')' : ''));
}
function formatEstimate(est, caps = {}) {
  const lines = [t('夜間作業の見込み: 頼み {tasks} 件・エージェント {agents} 体', {tasks: est.tasks, agents: est.agents})];
  if (est.accounts?.length) lines.push(t('使うアカウント: {list}', {list: est.accounts.join(' / ')}));
  if (caps.maxTokens) lines.push(t('トークン上限: {n}', {n: caps.maxTokens}));
  if (caps.maxTasks) lines.push(t('件数上限: {n}', {n: caps.maxTasks}));
  if (!caps.maxTokens && !caps.maxTasks) lines.push(t('上限: なし（start のときに max-tokens= / max-tasks= で付けられます）'));
  return lines;
}

module.exports = {runOvernight, makeExecRunner, defaultStatuses, saveReport, loadLatestReport, formatReport, formatQueue, formatEstimate, APPROVAL_TO_MODE, oneLine, statusLabel, sleepUntil, stoppedLabel};
