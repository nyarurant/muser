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

async function waitForPort(timeoutMs = 20000, profile = PROFILE) {
  const portFile = path.join(profile, 'DevToolsActivePort'), until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); if (port) return port; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(t('Edge のログイン窓を開けませんでした。'));
}

// profile / jarFile: one Edge profile and one saved jar per Muse account (src/accounts.js);
// the defaults are the first account's historic single profile and jar.
// One login at a time per profile, across processes (audit c17 #15): two muser
// processes sharing one Edge profile used to fight over the window and the jar, and
// the first to finish closed Edge under the other. The lock file carries the owner's
// pid; a lock whose owner is gone is stale and is taken over.
function acquireLoginLock(profile) {
  const lock = profile + '.login.lock';
  for (let a = 0; a < 2; a++) {
    try { fs.writeFileSync(lock, String(process.pid), {flag: 'wx'}); return lock; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let alive = false;
    try { const pid = Number(fs.readFileSync(lock, 'utf8')); if (pid) { process.kill(pid, 0); alive = true; } } catch (err) { alive = err && err.code === 'EPERM'; }
    if (alive) throw new Error(t('このプロファイルのログイン窓が既に開いています。先のログインを終えてから、もう一度実行してください。'));
    try { fs.unlinkSync(lock); } catch {}
  }
  throw new Error(t('このプロファイルのログイン窓が既に開いています。先のログインを終えてから、もう一度実行してください。'));
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

async function login({log = console.log, timeoutMs = 5 * 60 * 1000, profile = PROFILE, jarFile} = {}) {
  const edge = EDGE.find(p => fs.existsSync(p));
  if (!edge) throw new Error(t('Microsoft Edge が見つかりません。'));
  fs.mkdirSync(profile, {recursive: true});
  const lock = acquireLoginLock(profile);
  try {
    const leftover = await liveLeftoverPort(profile);
    let proc = null;
    if (!leftover) {
      try { fs.unlinkSync(path.join(profile, 'DevToolsActivePort')); } catch {}
      proc = spawn(edge, ['--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--app=https://muse.ai/', '--window-size=520,760'], {detached: true, stdio: 'ignore'});
      proc.unref();
    }
    const {chromium} = require('playwright-core');
    let browser;
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + (leftover || await waitForPort(20000, profile)));
    } catch (e) {
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
      return await pollLogin(browser, {log, timeoutMs, jarFile});
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
async function pollLogin(browser, {log = () => {}, timeoutMs = 5 * 60 * 1000, intervalMs = 2000, jarFile} = {}) {
  const until = Date.now() + timeoutMs;
  let last = '';
  let disconnected = false;
  try { browser.on?.('disconnected', () => { disconnected = true; }); } catch {}
  const gone = () => disconnected || (typeof browser.isConnected === 'function' && !browser.isConnected());
  const goneError = () => new Error(t('Edge のログイン窓を開けませんでした。'));
  while (Date.now() < until) {
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
      try {
        const session = await web.createWeb(jar, {file: jarFile}).fetchJson('/api/session?vm_state=true');
        stage = session?.endpoint_url && session?.vm_id ? await web.probe(jar, jarFile).catch(() => 'error') : 'session';
      // Same classification as web.probe() (first audit #34): a parse failure, a 5xx or a
      // 429 is an ERROR worth surfacing, not 'not logged in yet' — the old catch called
      // everything but a network error 'waiting' and retried silently for 5 minutes.
      } catch (e) { stage = (e.network || e.timeout || e.parse || e.status === 429 || e.status >= 500) ? 'error' : 'waiting'; }
      if (stage !== last) { last = stage; if (stage !== 'waiting') log('  … ' + ({session: t('ログインを確認、VM 情報を取得中'), token: t('接続用トークンを取得中'), ready: t('完了'), error: t('確認中')})[stage]); }
      if (stage === 'ready') { web.saveJar(jar, jarFile); return true; }
    }
    // Sleep in short slices so a disconnect during the wait is still prompt.
    const sleepUntil = Date.now() + intervalMs;
    while (Date.now() < sleepUntil && Date.now() < until) { if (gone()) throw goneError(); await new Promise(r => setTimeout(r, Math.min(100, intervalMs))); }
  }
  if (gone()) throw goneError();
  throw new Error(t('ログインが完了する前に時間切れになりました。'));
}

// Logout must clear the Edge profile too (first audit #35): it holds the muse.ai
// cookies, so leaving it made the next login silently resurrect the old account even
// though the user was told their login info was deleted. accounts.filesFor() passes
// the profile's full path as files.browser; the default is this module's PROFILE.
// Returns the profile path when it could not be removed, like accounts.remove().
function logout(files) {
  store.remove(files?.web || 'web.enc'); store.remove(files?.session || 'session.enc');
  const dir = files?.browser || PROFILE;
  try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
  try { return fs.existsSync(dir) ? dir : undefined; } catch { return undefined; }
}

module.exports = {login, logout, PROFILE, pollLogin, acquireLoginLock, liveLeftoverPort, EDGE};
