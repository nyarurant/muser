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
async function login({log = console.log, timeoutMs = 5 * 60 * 1000, profile = PROFILE, jarFile} = {}) {
  const edge = EDGE.find(p => fs.existsSync(p));
  if (!edge) throw new Error(t('Microsoft Edge が見つかりません。'));
  fs.mkdirSync(profile, {recursive: true});
  try { fs.unlinkSync(path.join(profile, 'DevToolsActivePort')); } catch {}
  const proc = spawn(edge, ['--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--app=https://muse.ai/', '--window-size=520,760'], {detached: true, stdio: 'ignore'});
  proc.unref();
  const {chromium} = require('playwright-core');
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + await waitForPort(20000, profile));
  } catch (e) {
    // No CDP handle exists to close Edge with, so kill the detached process tree instead.
    try { spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {windowsHide: true}); } catch {}
    try { proc.kill(); } catch {}
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
      } catch (e) { stage = e.network ? 'error' : 'waiting'; }
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

function logout(files) { store.remove(files?.web || 'web.enc'); store.remove(files?.session || 'session.enc'); }

module.exports = {login, logout, PROFILE, pollLogin};
