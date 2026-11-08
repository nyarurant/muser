'use strict';
// HTTPS to muse.ai with the website login cookies from `muser login`, outside any browser.
// Plays the role of Electron's session.defaultSession.fetch in muse-desktop-community.
const crypto = require('node:crypto');
const store = require('./secure-store');
const {t} = require('./i18n');

const FILE = 'web.enc';

function jarFromCookies(cookies) {
  return cookies.filter(c => /(^|\.)muse\.ai$/.test(c.domain.replace(/^\./, '')))
    .map(({name, value, domain, path, expires, secure}) => ({name, value, domain, path, expires, secure}));
}
// file: the store name of this jar. One website login per Muse account (src/accounts.js):
// the default account keeps 'web.enc', the others live under accounts/<id>/.
function loadJar(file = FILE) { return store.load(file) || []; }
// The non-default account a jar file belongs to, or null for the default jar and for
// non-account names (the pool's 'web.enc.probe-…' scratch jars, audit #44).
function jarAccountId(file) {
  const m = /^accounts\/([a-z0-9][a-z0-9-]*)\/web\.enc$/.exec(String(file).replace(/\\/g, '/'));
  return m ? m[1] : null;
}
// A save must not resurrect a removed account's login (audit #42): remove() deletes
// web.enc, but a window still running on that account holds the jar in memory and its
// next absorbed Set-Cookie saved it straight back. The registry is the source of truth
// — remove() rewrites it BEFORE deleting the files, and accounts.get() re-reads it from
// disk on every call — so a non-default jar is only saved while its account is still
// registered. No tombstone is needed: re-adding the account makes its saves live again
// on its own, and the default account (which cannot be removed) is never checked, so
// the historic flat layout is untouched. The check runs again after the write because
// the DPAPI save is slow (~0.4 s): a remove() that lands mid-save has either already
// deleted the file by the time the re-check runs (it deletes after the registry), or
// the re-check sees the account gone and this save undoes itself.
function saveJar(jar, file = FILE) {
  const id = jarAccountId(file);
  if (!id) { store.save(file, jar); return true; }
  const accounts = require('./accounts');
  if (!accounts.get(id)) return false;
  store.save(file, jar);
  if (!accounts.get(id)) { store.remove(file); return false; }
  return true;
}

// Absorbed Set-Cookie refreshes are saved from call() below, where a save
// failure used to be swallowed whole (deep #71 / c10 #3): the in-memory jar
// held the fresh login, the disk kept the stale one, and the next launch
// silently reverted to it. The request itself succeeded, so the failure is
// reported (once per jar file per process) instead of failing the call —
// but never silently. (saveJar returning false for a removed account is by
// design and is not a failure; it does not reach this warning.)
const jarSaveWarned = new Set();
function warnJarSaveFailure(file, e) {
  if (jarSaveWarned.has(file)) return;
  jarSaveWarned.add(file);
  console.error(t('ログイン情報の保存に失敗しました（{detail}）。次回はログインし直しが必要になることがあります。', {detail: e?.message || String(e)}));
}

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
    if (a['max-age'] !== undefined) { const n = Number(a['max-age']); expires = Number.isFinite(n) ? Date.now() / 1000 + n : -1; }
    else if (a.expires) { const p = Date.parse(a.expires) / 1000; expires = Number.isFinite(p) ? p : -1; }
    // An unparsable expiry (a malformed Expires date, a non-numeric Max-Age) computed NaN and
    // was stored as the cookie's expiry, where every comparison with it is false; an expiry we
    // cannot read falls back to a session cookie (expires: -1).
    const i = jar.findIndex(c => c.name === name && c.domain === domain && (c.path || '/') === (a.path || '/'));
    // A deletion cookie (Max-Age=0, or an Expires already in the past) removes the
    // stored cookie instead of being stored itself (audit #207): the dead entry
    // otherwise stayed in the saved jar for good.
    if (expires !== -1 && expires <= Date.now() / 1000) { if (i >= 0) { jar.splice(i, 1); changed = true; } continue; }
    const cookie = {name, value, domain, path: a.path || '/', expires, secure: !!a.secure};
    if (i >= 0) jar[i] = cookie; else jar.push(cookie);
    changed = true;
  }
  return changed;
}

const isTimeout = e => e?.name === 'TimeoutError' || e?.name === 'AbortError';

// A successful response with no body (204, or a bodyless 200) is an empty
// result, not a parse failure (deep #72 / c10 #4): all three wrappers used
// to call r.json() unconditionally and throw {parse: true} for it. A 204
// needs no parsing at all, and an empty body surfaces from Response.json()
// as a SyntaxError 'Unexpected end of JSON input'. Anything else that
// fails to parse is rethrown for the caller's own parse/timeout handling.
async function readJson(r) {
  if (r.status === 204) return null;
  try { return await r.json(); }
  catch (e) { if (e instanceof SyntaxError && /unexpected end of json input/i.test(e.message || '')) return null; throw e; }
}

function createWeb(jar, {file = FILE} = {}) {
  jar ??= loadJar(file);
  async function call(url, {method = 'GET', body, headers = {}, timeout = 12000, cookies = true, signal} = {}) {
    let response;
    try {
      // The caller's signal (PcAuth cancellation, audit #200) rides along with the
      // timeout signal so closing a flow actually stops its HTTP.
      const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout);
      response = await fetch(url, {method, redirect: 'error', signal: fetchSignal,
        headers: {'Content-Type': 'application/json', ...(cookies ? {Cookie: cookieHeader(jar, url)} : {}), ...headers},
        ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    } catch (e) {
      // Not every failure is "cannot connect" (audit #201): timeouts, redirects and
      // local data errors (a malformed jar) were all flattened to {network:true},
      // which callers read as retry-forever. Only undici's actual fetch failure
      // (TypeError 'fetch failed': DNS, refused, reset) is a network error.
      if (signal?.aborted) throw e;
      const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
      if (isTimeout(e)) throw Object.assign(new Error(t('{host} に接続できません。', {host})), {timeout: true, cause: e});
      if (e instanceof TypeError && /redirect/i.test(e.message || '')) throw Object.assign(new Error(t('{host} に接続できません。', {host})), {redirect: true, cause: e});
      if (e instanceof TypeError && e.message === 'fetch failed') throw Object.assign(new Error(t('{host} に接続できません。', {host})), {network: true, cause: e});
      throw e;
    }
    if (cookies && absorb(jar, url, response)) { try { saveJar(jar, file); } catch (e) { warnJarSaveFailure(file, e); } }
    return response;
  }
  // MuseClient's fetchJson: muse.ai website API with the login cookies.
  async function fetchJson(route, body) {
    // muse.ai refuses /api/hatch/token (403) without the browser's Sec-Fetch headers.
    const r = await call('https://muse.ai' + route, {method: body ? 'POST' : 'GET', body,
      headers: {Origin: 'https://muse.ai', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}});
    // Only an auth status means the login lapsed (audit #204): a 429/5xx used to
    // send the user to re-login during what was really an outage.
    if (!r.ok) throw Object.assign(new Error(r.status === 401 || r.status === 403
      ? t('Muse のログインが必要です。`muser login` を実行してください。')
      : t('Muse に接続できませんでした (HTTP {status})。', {status: r.status})), {status: r.status});
    // A body that is not JSON (a proxy error page served with 200, a truncated reply) used to
    // escape as a bare SyntaxError with no status, so callers that classify by status/network
    // (probeLogin, the login poll) misread it as a lapsed login. Wrap it, marked as a parse
    // failure and carrying the HTTP status. A body that timed out mid-read is a
    // timeout, not a parse failure (audit #202).
    try { return await readJson(r); }
    catch (e) { if (isTimeout(e)) throw Object.assign(new Error(t('{host} に接続できません。', {host: 'muse.ai'})), {status: r.status, timeout: true, cause: e}); throw Object.assign(new Error(t('Muse の応答を確認できませんでした。')), {status: r.status, parse: true, cause: e}); }
  }
  // PcAuth's request: native auth services, bearer only, never cookies.
  async function nativeRequest(scope, route, body, bearer, signal) {
    const root = scope === 'auth' ? 'https://hatch-api.meta.ai' : 'https://api.muse.ai';
    const r = await call(root + route, {method: body === undefined ? 'GET' : 'POST', body, cookies: false, timeout: 25000, signal,
      headers: {'X-API-Version': '1.0.0', ...(bearer ? {Authorization: 'Bearer ' + bearer} : {})}});
    let result; try { result = await readJson(r); } catch (e) { if (isTimeout(e)) throw Object.assign(new Error(t('Muse の PC 認証応答を確認できません。')), {status: r.status, timeout: true, cause: e}); throw Object.assign(new Error(t('Muse の PC 認証応答を確認できません。')), {status: r.status, parse: true, cause: e}); }
    if (!r.ok) {
      // Keep the server's own error detail (audit #203): a bare "HTTP 400" hid
      // whether the code was merely wrong (retryable) or the state was fatal —
      // the real 400 behind the /account add failure stayed unknown this way.
      const detail = [result?.error?.message, result?.message, result?.error_description, typeof result?.error === 'string' ? result.error : null]
        .find(v => typeof v === 'string' && v.trim())?.trim().slice(0, 200);
      throw Object.assign(new Error(t('PC の認証を完了できませんでした（HTTP {status}）。', {status: r.status}) + (detail ? ' ' + detail : '')), {status: r.status, ...(detail ? {serverError: detail} : {})});
    }
    return result;
  }
  async function sdkRequest(method, signal) {
    const r = await call('https://gadgets.muse.ai/api/sdk-tokens', {method, timeout: 20000, signal,
      headers: {Origin: 'https://gadgets.muse.ai', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'},
      ...(method === 'POST' ? {body: {label: 'muser CLI'}} : {})});
    if (!r.ok) throw Object.assign(new Error(t('SDK トークンを準備できませんでした（HTTP {status}）。', {status: r.status})), {status: r.status});
    // Like fetchJson / nativeRequest above: a non-JSON body (a proxy error page with a 200)
    // escaped as a bare SyntaxError with no status, so the login flow showed a raw parser
    // message. Wrap it, marked as a parse failure and carrying the HTTP status.
    try { return await readJson(r); }
    catch (e) { if (isTimeout(e)) throw Object.assign(new Error(t('SDK トークンの応答を確認できませんでした。')), {status: r.status, timeout: true, cause: e}); throw Object.assign(new Error(t('SDK トークンの応答を確認できませんでした。')), {status: r.status, parse: true, cause: e}); }
  }
  // muse.ai page text (HTML, JS chunks), used to look up a Next.js server action id.
  async function pageText(route) {
    const r = await call('https://muse.ai' + route, {timeout: 15000, headers: {Accept: route === '/' ? 'text/html' : '*/*'}});
    if (!r.ok) throw Object.assign(new Error('muse.ai ' + route + ' HTTP ' + r.status), {status: r.status});
    // A slow body used to escape as a raw TimeoutError with no status (audit #202).
    try { return await r.text(); }
    catch (e) { if (isTimeout(e)) throw Object.assign(new Error('muse.ai ' + route + ' timed out'), {status: r.status, timeout: true, cause: e}); throw e; }
  }
  // A Next.js server action on muse.ai. The reply is React Server Components text, one
  // `<id>:<json>` per line. Like /api/hatch/token it is refused without the Sec-Fetch headers.
  async function serverAction(id, args) {
    const r = await call('https://muse.ai/', {method: 'POST', body: args, timeout: 15000,
      headers: {'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://muse.ai', Referer: 'https://muse.ai/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}});
    try { return {ok: r.ok, status: r.status, text: await r.text()}; }
    catch (e) { if (isTimeout(e)) throw Object.assign(new Error('muse.ai server action timed out'), {status: r.status, timeout: true, cause: e}); throw e; }
  }
  // POST a JSON body to a muse.ai route the way the page does, reading the JSON answer
  // (fetchJson only treats the answer as a session read). call() serialises the body
  // itself: passing JSON.stringify(value) here sent a JSON *string* and the wake route
  // answered 400 (found on a real SUSPENDED VM, 2026-11-09).
  async function postJson(route, value) {
    const r = await call('https://muse.ai' + route, {method: 'POST', body: value,
      headers: {'Content-Type': 'application/json', Origin: 'https://muse.ai', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}});
    const text = await r.text().catch(() => '');
    if (!r.ok) throw Object.assign(new Error(t('Muse に接続できませんでした (HTTP {status})。', {status: r.status})), {status: r.status});
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }
  return {jar, fetchJson, postJson, nativeRequest, sdkRequest, pageText, serverAction};
}

// Same stages as MuseClient.probeLogin, for the login window.
// A 'ready' verdict is reused for a short window per jar (audit #206): every
// probe used to re-fetch the session AND mint a fresh hatch token with
// force_refresh, so a 2 s poll that kept probing minted tokens endlessly.
// The cache is keyed by the jar's CONTENTS, not the array object (deep #69
// / c10 #1): the login poll (login.js pollLogin) rebuilds the jar with
// jarFromCookies on every tick, so an identity-keyed WeakMap never hit on
// that path and the token mint ran on every tick anyway. Two jars holding
// the same cookies are the same login, whichever array carries them; the
// cookie values are only kept as a SHA-256 digest, and the jar file is part
// of the key so different accounts never share a verdict.
const probeReadyCache = new Map();
function probeCacheKey(jar, file) {
  if (!Array.isArray(jar)) return null;
  const parts = jar.map(c => JSON.stringify([c?.name ?? null, c?.value ?? null, c?.domain ?? null, c?.path ?? null, c?.expires ?? null, c?.secure ?? null])).sort();
  return String(file) + '\n' + crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}
async function probe(jar, file = FILE) {
  const key = probeCacheKey(jar, file);
  const cached = key ? probeReadyCache.get(key) : null;
  if (cached && Date.now() - cached.at < 30000) return 'ready';
  const w = createWeb(jar, {file});
  let session;
  // A parse failure (a 200 garbage body from a portal/proxy) is an error, not
  // 'waiting' (audit #205): probe used to sit in 'waiting' on it forever.
  try { session = await w.fetchJson('/api/session?vm_state=true'); } catch (e) { return e.network || e.timeout || e.parse || e.status >= 500 || e.status === 429 ? 'error' : 'waiting'; }
  if (!session?.endpoint_url || !session?.vm_id) return 'session';
  let token;
  // Token-fetch failures keep their cause too: a network/parse failure is
  // 'error', not a token problem the user could fix.
  try { token = await w.fetchJson('/api/hatch/token', {vmAddress: session.endpoint_url, vmName: session.vm_name, force_refresh: true}); } catch (e) { return e.network || e.timeout || e.parse || e.status >= 500 || e.status === 429 ? 'error' : 'token'; }
  if (!token?.token) return 'token';
  if (key) { for (const [k, v] of probeReadyCache) if (Date.now() - v.at >= 30000) probeReadyCache.delete(k); probeReadyCache.set(key, {at: Date.now()}); }
  return 'ready';
}

module.exports = {createWeb, probe, jarFromCookies, loadJar, saveJar, cookieHeader, absorb};
