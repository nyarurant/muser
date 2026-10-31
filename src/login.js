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

const EDGE = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
];
const PROFILE = path.join(store.DIR, 'browser');
const HOSTS = ['https://muse.ai/', 'https://gadgets.muse.ai/'];

async function waitForPort(timeoutMs = 20000) {
  const portFile = path.join(PROFILE, 'DevToolsActivePort'), until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); if (port) return port; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Edge のログイン窓を開けませんでした。');
}

async function login({log = console.log, timeoutMs = 5 * 60 * 1000} = {}) {
  const edge = EDGE.find(p => fs.existsSync(p));
  if (!edge) throw new Error('Microsoft Edge が見つかりません。');
  fs.mkdirSync(PROFILE, {recursive: true});
  try { fs.unlinkSync(path.join(PROFILE, 'DevToolsActivePort')); } catch {}
  const proc = spawn(edge, ['--user-data-dir=' + PROFILE, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--app=https://muse.ai/', '--window-size=520,760'], {detached: true, stdio: 'ignore'});
  proc.unref();
  const {chromium} = require('playwright-core');
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + await waitForPort());
  } catch (e) {
    // No CDP handle exists to close Edge with, so kill the detached process tree instead.
    try { spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {windowsHide: true}); } catch {}
    try { proc.kill(); } catch {}
    throw e;
  }
  log('Edge の窓でログインを待っています');
  const until = Date.now() + timeoutMs;
  let last = '';
  try {
    while (Date.now() < until) {
      const context = browser.contexts()[0];
      const cookies = context ? await context.cookies(HOSTS) : [];
      if (cookies.some(c => c.domain.endsWith('muse.ai'))) {
        const jar = web.jarFromCookies(cookies);
        // Poll the session only: probe() also fetches the hatch token with force_refresh,
        // which is wasteful (and mints a token) on every 2s tick while the user signs in.
        // Run the full probe once the session looks usable (same checks as probe()).
        let stage;
        try {
          const session = await web.createWeb(jar).fetchJson('/api/session?vm_state=true');
          stage = session?.endpoint_url && session?.vm_id ? await web.probe(jar).catch(() => 'error') : 'session';
        } catch (e) { stage = e.network ? 'error' : 'waiting'; }
        if (stage !== last) { last = stage; if (stage !== 'waiting') log('  … ' + ({session: 'ログインを確認、VM 情報を取得中', token: '接続用トークンを取得中', ready: '完了', error: '確認中'})[stage]); }
        if (stage === 'ready') { web.saveJar(jar); return true; }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('ログインが完了する前に時間切れになりました。');
  } finally {
    // Closing over CDP really quits this Edge profile (killing the launcher pid does not).
    await browser.newBrowserCDPSession().then(s => s.send('Browser.close')).catch(() => {});
    await browser.close().catch(() => {});
  }
}

function logout() { store.remove('web.enc'); store.remove('session.enc'); }

module.exports = {login, logout, PROFILE};
