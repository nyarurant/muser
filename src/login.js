'use strict';
// `muser login`: open muse.ai in a real Edge app window with its own profile, let the user
// sign in to Meta there, then take the muse.ai cookies. Edge is started without automation
// flags (Meta sign-in may refuse automated browsers) and we only attach over CDP to read
// cookies, which the page never sees.
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const store = require('./secure-store');
const web = require('./web');
const {t} = require('./i18n');

const EDGE = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  // A per-user install lives under %LOCALAPPDATA%: Edge exists there on some PCs and the
  // Program-Files-only search declared it missing (audit c17 #17).
  path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Microsoft\\Edge\\Application\\msedge.exe'),
];
const PROFILE = path.join(store.DIR, 'browser');
const HOSTS = ['https://muse.ai/', 'https://gadgets.muse.ai/'];

// Diagnostics for the "Edge window never opens" failure (依頼 SC): Edge's own log and a
// per-attempt JSON line live under <store.DIR>\logs, NOT inside the Edge profile, so they
// survive a profile wipe (logout / account remove). They carry only timestamps, pids,
// paths and exit codes — never cookies, tokens or passwords.
const LOGS_DIR = path.join(store.DIR, 'logs');
function loginLogsDir() { return LOGS_DIR; }

// The log path must be decided before spawn (it is an Edge argv flag), so the pid in the
// file name is muser's own (the spawner's) pid, not Edge's; Edge's pid is in login-diag.log.
function edgeLogPathFor(date = new Date(), pid = process.pid, dir = LOGS_DIR) {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return path.join(dir, 'edge-' + stamp + '-' + pid + '.log');
}

// Diagnostic logs are capped by TOTAL SIZE as well as by count (audit wave
// 8 B): Edge runs with --v=1, so ten kept logs could still be arbitrarily
// large, and the diag log's 200 lines could each be arbitrarily long.
const EDGE_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DIAG_LOG_MAX_LINES = 200;
const DIAG_LOG_MAX_BYTES = 256 * 1024;

// Keep only the newest `keep` Edge logs, and at most `maxBytes` of them in
// total (the oldest kept logs go first; the single newest log is always
// kept, so the latest attempt's diagnostics survive). The size limit may be
// passed as a number or as {maxBytes}. Best-effort: diagnostics never break
// a login.
function pruneEdgeLogs(dir = LOGS_DIR, keep = 10, sizeCap = EDGE_LOG_MAX_BYTES) {
  const maxBytes = typeof sizeCap === 'number' ? sizeCap : (sizeCap && typeof sizeCap.maxBytes === 'number' ? sizeCap.maxBytes : EDGE_LOG_MAX_BYTES);
  try {
    const files = fs.readdirSync(dir)
      .filter(n => /^edge-.*\.log$/.test(n))
      .map(n => { const p = path.join(dir, n); let m = 0, size = 0; try { const st = fs.statSync(p); m = st.mtimeMs; size = st.size; } catch {} return {p, n, m, size}; })
      .sort((a, b) => (b.m - a.m) || (a.n < b.n ? 1 : -1));
    const kept = files.slice(0, keep);
    for (const f of files.slice(keep)) { try { fs.unlinkSync(f.p); } catch {} }
    let total = kept.reduce((sum, f) => sum + f.size, 0);
    while (total > maxBytes && kept.length > 1) { const f = kept.pop(); total -= f.size; try { fs.unlinkSync(f.p); } catch {} }
  } catch {}
}

// Trim login-diag.log to the newest `maxLines` lines AND at most `maxBytes`
// in total (oldest lines go first; the newest line always stays). Returns
// nothing; best-effort like everything diagnostic.
function trimLoginDiag(dir = LOGS_DIR, maxLines = DIAG_LOG_MAX_LINES, maxBytes = DIAG_LOG_MAX_BYTES) {
  try {
    const file = path.join(dir, 'login-diag.log');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.length);
    let trimmed = lines.slice(-maxLines);
    let bytes = trimmed.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0);
    while (bytes > maxBytes && trimmed.length > 1) { bytes -= Buffer.byteLength(trimmed[0], 'utf8') + 1; trimmed = trimmed.slice(1); }
    if (trimmed.length !== lines.length) fs.writeFileSync(file, trimmed.join('\n') + '\n', 'utf8');
  } catch {}
}

// Prune every diagnostic log in `dir`: Edge logs by count and total size,
// the diag log by lines and total size. login() runs this at its entry so the
// sweep happens on EVERY attempt — the old single call site sat just before
// the Edge spawn, so leftover-reuse and early-failure paths never pruned
// (audit wave 8 B).
function pruneLoginLogs(dir = LOGS_DIR, opts = {}) {
  pruneEdgeLogs(dir, opts.keep ?? 10, opts.edgeMaxBytes ?? EDGE_LOG_MAX_BYTES);
  trimLoginDiag(dir, opts.diagMaxLines ?? DIAG_LOG_MAX_LINES, opts.diagMaxBytes ?? DIAG_LOG_MAX_BYTES);
}

// One JSON line per login attempt in login-diag.log, trimmed to the newest
// 200 lines and 256 KB (see trimLoginDiag).
function appendLoginDiag(record, dir = LOGS_DIR) {
  try {
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, 'login-diag.log');
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    trimLoginDiag(dir);
  } catch {}
}

// Is a live msedge.exe using this profile? There was no process-listing code in src/ to
// mirror, so this follows secure-store.js's pattern (spawnSync powershell.exe) with CIM,
// which is the only stock way to see command lines. The profile path travels via an env
// var, never interpolated into the script. Any failure (non-Windows, CIM denied) is
// "not proven alive" and the caller falls back to the old delete-and-spawn path.
function profileEdgeAlive(profile) {
  if (process.platform !== 'win32') return false;
  try {
    const script = "$p=$env:MUSER_DIAG_PROFILE;Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
      'Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ' +
      'Select-Object -First 1 -ExpandProperty ProcessId';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      {env: {...process.env, MUSER_DIAG_PROFILE: profile}, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024});
    return !r.error && r.status === 0 && /^\s*\d+\s*$/m.test(String(r.stdout || ''));
  } catch { return false; }
}

function waitFailure(kind, {timeoutMs, exited, spawnError, edgeLogPath}) {
  let reason;
  if (kind === 'exited') reason = t('Edge がすぐ終了しました（終了コード {code}）', {code: exited && exited.code != null ? exited.code : (exited && exited.signal ? exited.signal : '不明')});
  else if (kind === 'spawn-error') reason = t('Edge を起動できませんでした（{message}）', {message: spawnError ? String(spawnError.message || spawnError) : '不明'});
  else { const sec = timeoutMs / 1000; reason = t('{seconds} 秒以内に応答がありませんでした', {seconds: Number.isInteger(sec) ? String(sec) : String(Math.round(sec * 10) / 10)}); }
  const parts = [t('Edge のログイン窓を開けませんでした。'), reason];
  if (edgeLogPath) parts.push(t('Edge ログ: {path}', {path: edgeLogPath}));
  const err = new Error(parts.join(' '));
  err.reasonKind = kind;
  if (exited) err.exitCode = exited.code;
  err.edgeLogPath = edgeLogPath || null;
  return err;
}

// Waits for DevToolsActivePort. opts.proc (the spawned Edge, or a fake EventEmitter in
// tests) is watched for exit/error: if Edge ends before the port file appears — the
// delegation case, where a second Edge hands off to a running one and exits — fail at
// once instead of burning the whole timeout. opts.diag, when given, is mutated with
// what was observed (port appearance, Edge exit) for login()'s diagnostic record.
async function waitForPort(timeoutMs = 20000, profile = PROFILE, opts = {}) {
  const proc = opts.proc || null, edgeLogPath = opts.edgeLogPath || null, diag = opts.diag || null;
  const portFile = path.join(profile, 'DevToolsActivePort'), until = Date.now() + timeoutMs;
  let exited = null, spawnError = null, wake = null;
  const exitedPromise = new Promise(r => { wake = r; });
  const onExit = (code, signal) => {
    if (!exited && !spawnError) {
      exited = {code: code ?? null, signal: signal ?? null};
      if (diag) { diag.edgeExited = true; diag.exitCode = exited.code; diag.exitSignal = exited.signal; }
    }
    if (wake) wake();
  };
  const onError = e => {
    if (!spawnError && !exited) {
      spawnError = e || new Error('unknown');
      if (diag) { diag.edgeExited = true; diag.spawnError = String(spawnError.message || spawnError); }
    }
    if (wake) wake();
  };
  let listening = false;
  if (proc && typeof proc.on === 'function') {
    if (proc.exitCode != null) onExit(proc.exitCode, proc.signalCode || null); // already gone before we listened
    else { proc.on('exit', onExit); proc.on('error', onError); listening = true; }
  }
  const readPort = () => { try { return Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || 0; } catch { return 0; } };
  try {
    while (Date.now() < until) {
      const port = readPort();
      if (port) { if (diag) { diag.portAppeared = true; diag.portAppearedAt = new Date().toISOString(); diag.port = port; } return port; }
      if (spawnError) throw waitFailure('spawn-error', {timeoutMs, spawnError, edgeLogPath});
      if (exited) throw waitFailure('exited', {timeoutMs, exited, edgeLogPath});
      const remain = until - Date.now();
      if (remain <= 0) break;
      await Promise.race([new Promise(r => setTimeout(r, Math.min(250, remain))), exitedPromise]);
    }
    const port = readPort();
    if (port) { if (diag) { diag.portAppeared = true; diag.portAppearedAt = new Date().toISOString(); diag.port = port; } return port; }
    if (spawnError) throw waitFailure('spawn-error', {timeoutMs, spawnError, edgeLogPath});
    if (exited) throw waitFailure('exited', {timeoutMs, exited, edgeLogPath});
    throw waitFailure('timeout', {timeoutMs, edgeLogPath});
  } finally {
    if (listening && typeof proc.removeListener === 'function') { proc.removeListener('exit', onExit); proc.removeListener('error', onError); }
  }
}

// profile / jarFile: one Edge profile and one saved jar per Muse account (src/accounts.js);
// the defaults are the first account's historic single profile and jar.
// One login at a time per profile, across processes (audit c17 #15): two muser
// processes sharing one Edge profile used to fight over the window and the jar, and
// the first to finish closed Edge under the other. The lock file carries the owner's
// pid; a lock whose owner is gone is stale and is taken over.
const LOGIN_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
function loginLockSleep(ms) { try { Atomics.wait(LOGIN_LOCK_WAIT, 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} } }
// After a 'wx' create, is the file at the path still this process's own lock?
// A create can land in the empty-path gap of another contender's takeover or
// restore and be moved aside or replaced again a moment later; the creator is
// still inside acquireLoginLock then, so it can find out and back off — a
// process that already returned could not. Two reads a short spin apart must
// both show the creator's own content: a takeover/restore in flight settles
// within that spin, and a lock that is ours again by the second read (moved
// aside and put back) is still ours.
function loginLockStillMine(lock, mine) {
  for (let i = 0; i < 2; i++) {
    loginLockSleep(25);
    let cur = null;
    try { cur = fs.readFileSync(lock, 'utf8'); } catch {}
    if (cur !== mine) return false;
  }
  return true;
}
function acquireLoginLock(profile) {
  const lock = profile + '.login.lock';
  const mine = String(process.pid);
  const heldError = () => new Error(t('このプロファイルのログイン窓が既に開いています。先のログインを終えてから、もう一度実行してください。'));
  let created = false; // this call has put a lock of its own at the path at least once
  for (let a = 0; a < 3; a++) {
    try {
      fs.writeFileSync(lock, mine, {flag: 'wx'});
      created = true;
      if (loginLockStillMine(lock, mine)) return lock;
      continue; // displaced during contention: judge the current lock afresh
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    // Judge the lock that is there now, keeping the exact content seen: the
    // takeover below may only remove a lock still byte-for-byte this one.
    let raw = null, readErr = null;
    try { raw = fs.readFileSync(lock, 'utf8'); } catch (e) { readErr = e; }
    // Our own lock, moved aside by a contender's mis-aimed takeover and put
    // back since: it is this call's lock again, not another login's.
    if (!readErr && created && raw === mine) return lock;
    let alive = false;
    if (readErr) alive = readErr.code === 'EPERM';
    else {
      const pid = Number(raw);
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = !!(err && err.code === 'EPERM'); } }
    }
    if (alive) throw heldError();
    // No content was seen (the lock vanished mid-check, or cannot be read):
    // there is nothing whose takeover could be verified, so retry the create
    // instead of removing whatever happens to sit at the path now.
    if (readErr) continue;
    // Stale takeover by rename-aside + content check (audit wave 18; the
    // node-slots retireLock / sessions.locked shape): rename is atomic, so of
    // several processes that all judged the same lock stale only one moves
    // it. The old read -> unlink -> wx sequence let each of them delete the
    // next one's fresh lock and all believed they held it (measured: 3-6
    // simultaneous holders, 15/15 rounds). The judgement is re-confirmed by a
    // second read immediately before the rename: a successor's lock can only
    // appear at the path once the stale one has been removed, so a lock that
    // still reads as the judged stale content at that point cannot be a
    // successor's — while a changed (or vanished) lock aborts the takeover
    // and is judged afresh on the next attempt instead of being moved.
    let again = null;
    try { again = fs.readFileSync(lock, 'utf8'); } catch {}
    if (again !== raw) continue;
    const grave = lock + '.stale-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try { fs.renameSync(lock, grave); } catch { continue; } // another contender moved it first
    let moved = null;
    try { moved = fs.readFileSync(grave, 'utf8'); } catch {}
    if (moved !== raw) {
      // What was moved is a successor's fresh lock, not the stale one judged:
      // put it back, replacing any lock a third process created in the gap —
      // that creator is still inside its own acquire and backs off when its
      // settle check finds this lock at the path instead of its own, while
      // the restored lock's owner may already be running its login and could
      // never be told. Either way a live login holds this profile now (the
      // node-slots claim() break on a failed retire): report it, do not
      // contend on.
      try { fs.renameSync(grave, lock); } catch { try { fs.linkSync(grave, lock); } catch {} try { fs.unlinkSync(grave); } catch {} }
      throw heldError();
    }
    try { fs.unlinkSync(grave); } catch {}
  }
  throw heldError();
}

// A leftover Edge window for this profile (audit c17 #16): its DevToolsActivePort is
// still live. login() used to delete that file and spawn a second Edge, which merely
// delegated to the running one and exited — the port file was never rewritten, so
// every later login waited 20 s and failed while a usable window sat open. Reuse a
// live leftover instead; its Browser.close at the end clears the state for next time.
async function liveLeftoverPort(profile) {
  let port = 0;
  try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
  if (!port) return 0;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1500)});
    return r.ok ? port : 0;
  } catch { return 0; }
}

async function login({log = console.log, timeoutMs = 5 * 60 * 1000, profile = PROFILE, jarFile, signal} = {}) {
  // Sweep the diagnostic logs first, on every entry (audit wave 8 B): the
  // pre-spawn prune further down only runs when a fresh Edge is spawned, so
  // leftover-reuse, locked-profile and Edge-missing attempts never pruned
  // and the logs grew between the attempts that did.
  try { pruneLoginLogs(LOGS_DIR); } catch {}
  if (signal?.aborted) { const e = new Error(t('中止しました。')); e.reasonKind = 'cancelled'; throw e; }
  // The diag record exists from the very start (master-debug #17): an attempt
  // that failed before it was created — no Edge, or the profile lock held —
  // used to leave no record at all.
  const startedAt = new Date();
  const diag = {ts: startedAt.toISOString(), edgePid: null, profile, reusedLeftover: false, leftoverPort: 0,
    portAppeared: false, portAppearedAt: null, port: null, edgeExited: false, exitCode: null, exitSignal: null,
    edgeLogPath: null, outcome: null};
  let diagWritten = false;
  const writeDiag = outcome => { if (diagWritten) return; diagWritten = true; diag.outcome = outcome; appendLoginDiag(diag); };
  const edge = EDGE.find(p => fs.existsSync(p));
  if (!edge) { diag.failureReason = 'edge-missing'; writeDiag('failed'); throw new Error(t('Microsoft Edge が見つかりません。')); }
  fs.mkdirSync(profile, {recursive: true});
  let lock;
  try { lock = acquireLoginLock(profile); } catch (e) { diag.failureReason = 'locked'; writeDiag('failed'); throw e; }
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let hadPortFile = false;
    try { hadPortFile = fs.existsSync(portFile); } catch {}
    const leftover = await liveLeftoverPort(profile);
    diag.reusedLeftover = !!leftover; diag.leftoverPort = leftover || 0;
    let proc = null, edgeLogPath = null;
    if (!leftover) {
      // A port file whose CDP does not answer, with a live Edge still on this profile:
      // deleting the file and spawning would only delegate to that Edge and exit at
      // once (the waitForPort early-exit below would catch it, but this names the real
      // cause and asks the user to close the window instead).
      if (hadPortFile && profileEdgeAlive(profile)) {
        diag.failureReason = 'profile-in-use';
        writeDiag('profile-in-use');
        throw new Error(t('同じプロファイルの Edge が残っています。閉じてから再試行してください。'));
      }
      try { fs.unlinkSync(portFile); } catch {}
      edgeLogPath = edgeLogPathFor(startedAt, process.pid);
      diag.edgeLogPath = edgeLogPath;
      // Prune to 9 before spawn so the newest 10 including this attempt's log remain.
      try { fs.mkdirSync(path.dirname(edgeLogPath), {recursive: true}); pruneEdgeLogs(path.dirname(edgeLogPath), 9); } catch {}
      proc = spawn(edge, ['--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--app=https://muse.ai/', '--window-size=520,760',
        '--enable-logging', '--v=1', '--log-file=' + edgeLogPath], {detached: true, stdio: 'ignore'});
      diag.edgePid = proc.pid ?? null;
      try {
        proc.on('exit', (code, signal) => { diag.edgeExited = true; diag.exitCode = code ?? null; diag.exitSignal = signal ?? null; });
        proc.on('error', e => { diag.edgeExited = true; diag.spawnError = String((e && e.message) || e); });
      } catch {}
      proc.unref();
    } else {
      diag.portAppeared = true; diag.portAppearedAt = startedAt.toISOString(); diag.port = leftover;
    }
    const {chromium} = require('playwright-core');
    let browser;
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + (leftover || await waitForPort(20000, profile, {proc, edgeLogPath, diag})));
    } catch (e) {
      if (e && e.reasonKind) diag.failureReason = e.reasonKind;
      writeDiag('failed');
      // No CDP handle exists to close Edge with, so kill the detached process tree instead.
      // (Only our own spawn: a leftover window is not ours to kill.)
      if (proc) {
        try { spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {windowsHide: true}); } catch {}
        try { proc.kill(); } catch {}
      }
      throw e;
    }
    log(t('Edge の窓でログインを待っています'));
    try {
      const done = await pollLogin(browser, {log, timeoutMs, jarFile, signal});
      // The success outcome is written only once the login really completed
      // (master-debug #17): it used to be recorded before the poll, so a poll
      // timeout or a closed window still read 'connected' in the diag log.
      writeDiag(leftover ? 'reused-leftover' : 'connected');
      return done;
    } catch (e) {
      if (e && e.reasonKind) diag.failureReason = e.reasonKind;
      writeDiag('failed');
      throw e;
    } finally {
      // Closing over CDP really quits this Edge profile (killing the launcher pid does not).
      await browser.newBrowserCDPSession().then(s => s.send('Browser.close')).catch(() => {});
      await browser.close().catch(() => {});
    }
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

// Poll the Edge window until the login is usable. If the user closes the window (or Edge
// otherwise disconnects) the poll used to keep waiting on an empty context list until the
// 5-minute timeout; it now aborts at once with a clear message.
async function pollLogin(browser, {log = () => {}, timeoutMs = 5 * 60 * 1000, intervalMs = 2000, jarFile, signal} = {}) {
  const until = Date.now() + timeoutMs;
  let last = '';
  let disconnected = false;
  try { browser.on?.('disconnected', () => { disconnected = true; }); } catch {}
  const gone = () => disconnected || (typeof browser.isConnected === 'function' && !browser.isConnected());
  const goneError = () => { const e = new Error(t('Edge のログイン窓を開けませんでした。')); e.reasonKind = 'window-closed'; return e; };
  // Cancellation from the caller (SetupFlow's cancel, master-debug #3): the poll
  // used to run to its 5-minute timeout because nothing reached it.
  const aborted = () => { try { return !!signal?.aborted; } catch { return false; } };
  const cancelledError = () => { const e = new Error(t('中止しました。')); e.reasonKind = 'cancelled'; return e; };
  // Whether any attempt ever got an answer from muse.ai (audit-cli wave 9):
  // a poll where every session check failed to connect at all (network /
  // timeout on every tick) is not a slow login, and its timeout must not be
  // worded like one. Any response at all — a usable session, a plain 4xx
  // 'waiting', a parse / 429 / 5xx 'error' — proves the connection worked.
  let attempted = false;
  let connected = false;
  while (Date.now() < until) {
    if (aborted()) throw cancelledError();
    if (gone()) throw goneError();
    let cookies = [];
    try {
      const context = browser.contexts()[0];
      cookies = context ? await context.cookies(HOSTS) : [];
    } catch (e) { if (gone()) throw goneError(); throw e; }
    if (cookies.some(c => c.domain.endsWith('muse.ai'))) {
      const jar = web.jarFromCookies(cookies);
      // Poll the session only: probe() also fetches the hatch token with force_refresh,
      // which is wasteful (and mints a token) on every 2s tick while the user signs in.
      // Run the full probe once the session looks usable (same checks as probe()).
      let stage;
      attempted = true;
      try {
        const session = await web.createWeb(jar, {file: jarFile}).fetchJson('/api/session?vm_state=true');
        connected = true; // the session endpoint answered
        stage = session?.endpoint_url && session?.vm_id ? await web.probe(jar, jarFile).catch(() => 'error') : 'session';
      // Same classification as web.probe() (first audit #34): a parse failure, a 5xx or a
      // 429 is an ERROR worth surfacing, not 'not logged in yet' — the old catch called
      // everything but a network error 'waiting' and retried silently for 5 minutes.
      } catch (e) { if (!(e.network || e.timeout)) connected = true; stage = (e.network || e.timeout || e.parse || e.status === 429 || e.status >= 500) ? 'error' : 'waiting'; }
      if (stage !== last) { last = stage; if (stage !== 'waiting') log('  … ' + ({session: t('ログインを確認、VM 情報を取得中'), token: t('接続用トークンを取得中'), ready: t('完了'), error: t('確認中')})[stage]); }
      if (stage === 'ready') { web.saveJar(jar, jarFile); return true; }
    }
    // Sleep in short slices so a disconnect during the wait is still prompt.
    const sleepUntil = Date.now() + intervalMs;
    while (Date.now() < sleepUntil && Date.now() < until) { if (aborted()) throw cancelledError(); if (gone()) throw goneError(); await new Promise(r => setTimeout(r, Math.min(100, intervalMs))); }
  }
  if (gone()) throw goneError();
  // Never connected at all (wave 9): say so, and point at the network —
  // the plain slow-login wording sent users back to the Edge window when
  // nothing they did there could have helped. reasonKind stays
  // 'poll-timeout' (it is still the poll expiring); noConnection marks it.
  if (attempted && !connected) {
    const noConnError = new Error(t('接続を確認できませんでした。ネットワークを確認してください。'));
    noConnError.reasonKind = 'poll-timeout';
    noConnError.noConnection = true;
    throw noConnError;
  }
  const timeoutError = new Error(t('ログインが完了する前に時間切れになりました。'));
  timeoutError.reasonKind = 'poll-timeout';
  throw timeoutError;
}

// Logout must clear the Edge profile too (first audit #35): it holds the muse.ai
// cookies, so leaving it made the next login silently resurrect the old account even
// though the user was told their login info was deleted. accounts.filesFor() passes
// the profile's full path as files.browser; the default is this module's PROFILE.
// Returns the profile path when it could not be removed, like accounts.remove().
function logout(files) {
  store.remove(files?.web || 'web.enc'); store.remove(files?.session || 'session.enc');
  store.remove(files?.contact || 'contact.enc');
  const dir = files?.browser || PROFILE;
  try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
  try { return fs.existsSync(dir) ? dir : undefined; } catch { return undefined; }
}

module.exports = {login, logout, PROFILE, pollLogin, acquireLoginLock, liveLeftoverPort, EDGE, waitForPort, edgeLogPathFor, pruneEdgeLogs, pruneLoginLogs, trimLoginDiag, appendLoginDiag, profileEdgeAlive, loginLogsDir, LOGS_DIR, EDGE_LOG_MAX_BYTES, DIAG_LOG_MAX_LINES, DIAG_LOG_MAX_BYTES};
