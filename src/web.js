'use strict';
// HTTPS to muse.ai with the website login cookies from `muser login`, outside any browser.
// Plays the role of Electron's session.defaultSession.fetch in muse-desktop-community.
const store = require('./secure-store');

const FILE = 'web.enc';

function jarFromCookies(cookies) {
  return cookies.filter(c => /(^|\.)muse\.ai$/.test(c.domain.replace(/^\./, '')))
    .map(({name, value, domain, path, expires, secure}) => ({name, value, domain, path, expires, secure}));
}
function loadJar() { return store.load(FILE) || []; }
function saveJar(jar) { store.save(FILE, jar); }

function cookieHeader(jar, url) {
  const u = new URL(url), now = Date.now() / 1000;
  return jar.filter(c => {
    const d = c.domain.replace(/^\./, '');
    const hostOk = c.domain.startsWith('.') ? (u.hostname === d || u.hostname.endsWith('.' + d)) : u.hostname === d;
    return hostOk && pathMatches(u.pathname, c.path || '/') && (!c.expires || c.expires < 0 || c.expires > now) && (!c.secure || u.protocol === 'https:');
  }).map(c => c.name + '=' + c.value).join('; ');
}

// RFC 6265 path-match: equal, or a prefix that ends at a path boundary, so a
// cookie scoped to '/api' is not sent to '/apixyz'.
function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

// A Set-Cookie Domain is only believable if it is the response host itself or a
// parent suffix of it with at least two labels — never a public-suffix-like
// single label ('ai', 'com', ...) and never an unrelated domain.
function domainAllowed(domain, host) {
  if (domain === host) return true;
  if (!domain.includes('.')) return false;
  return host.endsWith('.' + domain);
}

// Keep cookies the site refreshes (Set-Cookie) so the login lasts as long as it does in a browser.
function absorb(jar, url, response) {
  const set = response.headers.getSetCookie?.() || [];
  if (!set.length) return false;
  const host = new URL(url).hostname.toLowerCase();
  let changed = false;
  for (const line of set) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    const a = Object.fromEntries(attrs.map(x => { const i = x.indexOf('='); return i < 0 ? [x.trim().toLowerCase(), true] : [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()]; }));
    let domain = host;
    if (a.domain) {
      const wanted = String(a.domain).replace(/^\./, '').toLowerCase();
      if (!wanted || !domainAllowed(wanted, host)) continue;
      domain = '.' + wanted;
    }
    let expires = -1;
    if (a['max-age'] !== undefined) expires = Date.now() / 1000 + Number(a['max-age']);
    else if (a.expires) expires = Date.parse(a.expires) / 1000;
    const i = jar.findIndex(c => c.name === name && c.domain === domain && (c.path || '/') === (a.path || '/'));
    const cookie = {name, value, domain, path: a.path || '/', expires, secure: !!a.secure};
    if (i >= 0) jar[i] = cookie; else jar.push(cookie);
    changed = true;
  }
  return changed;
}

function createWeb(jar = loadJar()) {
  async function call(url, {method = 'GET', body, headers = {}, timeout = 12000, cookies = true} = {}) {
    let response;
    try {
      response = await fetch(url, {method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: {'Content-Type': 'application/json', ...(cookies ? {Cookie: cookieHeader(jar, url)} : {}), ...headers},
        ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    } catch { throw Object.assign(new Error(new URL(url).hostname + ' に接続できません。'), {network: true}); }
    if (cookies && absorb(jar, url, response)) { try { saveJar(jar); } catch {} }
    return response;
  }
  // MuseClient's fetchJson: muse.ai website API with the login cookies.
  async function fetchJson(route, body) {
    // muse.ai refuses /api/hatch/token (403) without the browser's Sec-Fetch headers.
    const r = await call('https://muse.ai' + route, {method: body ? 'POST' : 'GET', body,
      headers: {Origin: 'https://muse.ai', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}});
    if (!r.ok) throw Object.assign(new Error('Muse のログインが必要です。`muser login` を実行してください。'), {status: r.status});
    return r.json();
  }
  // PcAuth's request: native auth services, bearer only, never cookies.
  async function nativeRequest(scope, route, body, bearer) {
    const root = scope === 'auth' ? 'https://hatch-api.meta.ai' : 'https://api.muse.ai';
    const r = await call(root + route, {method: body === undefined ? 'GET' : 'POST', body, cookies: false, timeout: 25000,
      headers: {'X-API-Version': '1.0.0', ...(bearer ? {Authorization: 'Bearer ' + bearer} : {})}});
    let result; try { result = await r.json(); } catch { throw new Error('Muse の PC 認証応答を確認できません。'); }
    if (!r.ok) throw Object.assign(new Error('PC の認証を完了できませんでした（HTTP ' + r.status + '）。'), {status: r.status});
    return result;
  }
  async function sdkRequest(method) {
    const r = await call('https://gadgets.muse.ai/api/sdk-tokens', {method, timeout: 20000,
      headers: {Origin: 'https://gadgets.muse.ai', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'},
      ...(method === 'POST' ? {body: {label: 'muser CLI'}} : {})});
    if (!r.ok) throw new Error('SDK トークンを準備できませんでした（HTTP ' + r.status + '）。');
    return r.json();
  }
  // muse.ai page text (HTML, JS chunks), used to look up a Next.js server action id.
  async function pageText(route) {
    const r = await call('https://muse.ai' + route, {timeout: 15000, headers: {Accept: route === '/' ? 'text/html' : '*/*'}});
    if (!r.ok) throw Object.assign(new Error('muse.ai ' + route + ' HTTP ' + r.status), {status: r.status});
    return r.text();
  }
  // A Next.js server action on muse.ai. The reply is React Server Components text, one
  // `<id>:<json>` per line. Like /api/hatch/token it is refused without the Sec-Fetch headers.
  async function serverAction(id, args) {
    const r = await call('https://muse.ai/', {method: 'POST', body: args, timeout: 15000,
      headers: {'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://muse.ai', Referer: 'https://muse.ai/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}});
    return {ok: r.ok, status: r.status, text: await r.text()};
  }
  return {jar, fetchJson, nativeRequest, sdkRequest, pageText, serverAction};
}

// Same stages as MuseClient.probeLogin, for the login window.
async function probe(jar) {
  const w = createWeb(jar);
  let session;
  try { session = await w.fetchJson('/api/session?vm_state=true'); } catch (e) { return e.network ? 'error' : 'waiting'; }
  if (!session?.endpoint_url || !session?.vm_id) return 'session';
  let token;
  try { token = await w.fetchJson('/api/hatch/token', {vmAddress: session.endpoint_url, vmName: session.vm_name, force_refresh: true}); } catch { return 'token'; }
  return token?.token ? 'ready' : 'token';
}

module.exports = {createWeb, probe, jarFromCookies, loadJar, saveJar, cookieHeader, absorb};
