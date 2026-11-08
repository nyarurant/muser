'use strict';
// Small encrypted files under %LOCALAPPDATA%\muser, protected with Windows DPAPI
// (CurrentUser scope) through PowerShell, so no native module is needed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const crypto = require('node:crypto');
const {t} = require('./i18n');

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser');

// Under the test runner, never the real login folder. tests/setup.mjs moves
// LOCALAPPDATA to a temp folder, but a file run as `node --test tests/x.test.js`
// skips it: on 2026-11-08 an audit did exactly that and fix2-login's logout()
// deleted the user's real session.enc / web.enc and Edge profile.
if (process.env.NODE_TEST_CONTEXT) {
  const tmp = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
  if (!path.resolve(DIR).toLowerCase().startsWith(tmp)) {
    throw new Error('muser tests must run with --import ./tests/setup.mjs: the data folder is not a temp folder (' + DIR + ')');
  }
}

// A slow DPAPI call is not a broken file: under load (many muser processes starting at
// once, as a parallel hunt does) PowerShell alone can take longer than 15 s to start.
// Such a failure is marked `slow`, retried once with a longer wait, and worded as a
// wait-and-retry, not as "the file is broken, log in again" (found on a real run).
function dpapi(op, input) {
  try { return dpapiOnce(op, input, 15000); }
  catch (e) { if (!e.slow) throw e; return dpapiOnce(op, input, 45000); }
}
function dpapiOnce(op, input, timeout) {
  const script = `Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();` +
    `$b=[Convert]::FromBase64String($i);` +
    `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Console]::Out.Write([Convert]::ToBase64String($o))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    {input: input.toString('base64'), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout});
  if (r.error) { const err = new Error(r.error.code === 'ETIMEDOUT' ? t('Windows の暗号化ストレージを使えませんでした。（タイムアウトしました）') : t('Windows の暗号化ストレージを使えませんでした。（{message}）', {message: r.error.message})); if (r.error.code === 'ETIMEDOUT') err.slow = true; throw err; }
  if (r.signal) throw Object.assign(new Error(t('Windows の暗号化ストレージを使えませんでした。（プロセスがシグナル {signal} で終了しました）', {signal: r.signal})), {slow: true});
  if (r.status !== 0) throw new Error(t('Windows の暗号化ストレージを使えませんでした。{detail}', {detail: r.stderr ? '（' + String(r.stderr).trim().slice(-200) + '）' : ''}));
  return Buffer.from(r.stdout.trim(), 'base64');
}

function file(name) { return path.join(DIR, name); }

// Every DPAPI call starts PowerShell (~0.4 s, blocking), and startup used to decrypt the same
// files several times. Decrypted JSON is kept for this process, keyed by the file's mtime and
// size (another muser writing the file invalidates it), and an unchanged value is not saved.
const cache = new Map();
function stampOf(target) { try { const st = fs.statSync(target); return {mtimeMs: st.mtimeMs, size: st.size}; } catch { return null; } }
function fresh(name, st) { const c = cache.get(name); return c && st && c.mtimeMs === st.mtimeMs && c.size === st.size ? c : null; }

// The batch hand-off is positional: line i of PowerShell's output belongs to file i of the
// input. An empty .enc file (or an empty plaintext) used to vanish from BOTH sides — the
// PowerShell loop skipped empty input lines and JS dropped empty output lines with
// filter(Boolean) — so every later file's plaintext was cached under the previous file's
// name and load() returned another file's secret (deep H14). Empty slots now travel as the
// '!' failure placeholder, and the JS side maps lines strictly by index.
function parsePreloadOutput(stdout, count) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // one trailing newline, not a slot
  const out = new Array(count).fill(undefined);
  for (let i = 0; i < count && i < lines.length; i++) out[i] = lines[i];
  return out;
}
function decodePreload(todo, lines) {
  const decoded = new Map();
  todo.forEach((t, i) => {
    const line = lines[i];
    if (!line || line === '!') return;
    try { const json = Buffer.from(line, 'base64').toString('utf8'); JSON.parse(json); decoded.set(t.name, json); } catch {}
  });
  return decoded;
}

// Audit-cli wave 14: a .enc file is raw DPAPI ciphertext, but some writer (an editor,
// a copy tool, an older build) can leave the SAME ciphertext as base64 TEXT instead —
// sometimes with a BOM and line breaks. That file is not broken: decode the text back
// to the ciphertext bytes and it decrypts as usual. Plainly different contents (plain
// JSON, prose, random binary) are NOT base64 text: the strict alphabet + canonical
// re-encode check below rejects them, so they keep the old broken-file error and no
// second DPAPI call is wasted on guessing.
function tryDecodeBase64Text(data) {
  let text;
  try { text = data.toString('utf8'); } catch { return null; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // UTF-8 BOM
  const cleaned = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned || cleaned.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  let decoded;
  try { decoded = Buffer.from(cleaned, 'base64'); } catch { return null; }
  if (!decoded.length) return null;
  if (decoded.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) return null;
  if (decoded.equals(data)) return null;
  return decoded;
}
// Rewrite a recovered base64-text file in the proper raw-binary form, in place, with
// the same temp + rename care as save(). A failed rewrite must not lose the value
// that was just recovered, so failures are reported as `false`, never thrown.
function healBase64TextFile(target, ciphertext) {
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(temp, ciphertext);
    renameRetry(temp, target);
    sweepTemps(target);
    return true;
  } catch { try { fs.unlinkSync(temp); } catch {} return false; }
}

// Decrypt several files with one PowerShell start (startup needs three).
function preload(names) {
  const todo = [];
  for (const name of names) {
    const target = file(name), st = stampOf(target);
    if (!st || fresh(name, st)) continue;
    try { todo.push({name, st, data: fs.readFileSync(target)}); } catch {}
  }
  if (!todo.length) return;
  const script = 'Add-Type -AssemblyName System.Security;' +
    'foreach($l in [Console]::In.ReadToEnd().Split([char]10)){$l=$l.Trim();if(!$l){[Console]::Out.WriteLine(\'!\');continue};' +
    'try{$o=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($l),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);if($o.Length -eq 0){[Console]::Out.WriteLine(\'!\')}else{[Console]::Out.WriteLine([Convert]::ToBase64String($o))}}catch{[Console]::Out.WriteLine(\'!\')}}';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    {input: todo.map(t => t.data.toString('base64')).join('\n'), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15000});
  if (r.error || r.status !== 0) return; // load() decrypts one by one and reports the real error
  const decoded = decodePreload(todo, parsePreloadOutput(r.stdout, todo.length));
  for (const t of todo) { const json = decoded.get(t.name); if (json !== undefined) cache.set(t.name, {...t.st, json}); }
}

function save(name, value) {
  const target = file(name), json = JSON.stringify(value), c = fresh(name, stampOf(target));
  if (c && c.json === json) return;
  // Names may carry a folder (accounts/<id>/web.enc): create the target's own folder, not just DIR.
  fs.mkdirSync(path.dirname(target), {recursive: true});
  // A temp name per process: two muser windows saving the same file collided on one '.tmp' and
  // the second rename failed (ENOENT) inside the gateway's credentials event.
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  const enc = dpapi('Protect', Buffer.from(json, 'utf8'));
  fs.writeFileSync(temp, enc);
  // Windows refuses the rename (EPERM / EBUSY / EACCES) while another window or a scanner has the
  // target open for a moment; the failed save then left its temp file behind for good (four of
  // them sat next to web.enc / session.enc on 2026-11-03). Retry briefly, and never leave the temp.
  try { renameRetry(temp, target); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  sweepTemps(target);
  // Cache the saved value only when the file still holds exactly the ciphertext written
  // here: load() verifies stamp + ciphertext hash for this race, and save() used to pair
  // its json with whatever stamp a competing window's rename left behind, after which
  // load() served the stale value as fresh until the file changed again. When the check
  // fails nothing is cached and the next load() reads the file that is really there.
  const before = stampOf(target);
  if (before) {
    let same = false;
    try { same = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === crypto.createHash('sha256').update(enc).digest('hex'); } catch {}
    const after = stampOf(target);
    if (same && after && before.mtimeMs === after.mtimeMs && before.size === after.size) cache.set(name, {...after, json});
  }
}
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}
// Temp files of saves that died before their rename (killed window, older muser): removed once
// the process that wrote them is gone. A live writer's temp is left alone.
function sweepTemps(target) {
  const dir = path.dirname(target), prefix = path.basename(target) + '.tmp-';
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const pid = Number(n.slice(prefix.length).split('-')[0]);
    if (pid === process.pid || (Number.isInteger(pid) && pid > 0 && alive(pid))) continue;
    try { fs.unlinkSync(path.join(dir, n)); } catch {}
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Missing file -> null ("not logged in yet"). A file that exists but cannot be
// decrypted or parsed is a different, actionable problem: throw a clear error
// naming the file instead of crashing on a raw JSON.parse failure.
function load(name) {
  const target = file(name);
  const hit = fresh(name, stampOf(target));
  if (hit) return JSON.parse(hit.json);
  const before = stampOf(target);
  let data;
  try { data = fs.readFileSync(target); }
  catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
  try {
    const json = dpapi('Unprotect', data).toString('utf8'), value = JSON.parse(json);
    // Cache only when the file still holds exactly the bytes that were
    // decrypted: the stamp used to be taken between reading the file and the
    // (slow, ~0.4 s) DPAPI call, so another muser writing the file in between
    // left the cache mapping the NEW file's stamp to the OLD value, and every
    // later load served the stale secret. Stat before and after, and compare
    // the ciphertext hash, before trusting the pairing.
    const after = stampOf(target);
    if (before && after && before.mtimeMs === after.mtimeMs && before.size === after.size) {
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      let same = false;
      try { same = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === digest; } catch {}
      if (same) cache.set(name, {...after, json});
    }
    return value;
  } catch (e) {
    if (e && e.slow) throw Object.assign(new Error(t('暗号化ファイル {file} を読めませんでした。Windows の暗号化ストレージの応答が遅れています（ほかに多くの処理が動いているときに起きます）。少し待ってからやり直してください。', {file: target})), {slow: true});
    // Wave 14 recovery: the raw bytes did not decrypt, but the file may hold the
    // same ciphertext as base64 text (BOM / line breaks included). If so, decrypt
    // the decoded bytes, rewrite the file in the proper raw form, and return the
    // value as if nothing was wrong. Plainly different contents (plain JSON etc.)
    // are rejected by tryDecodeBase64Text, and a decoded attempt that still fails
    // falls through to the broken-file error below with the RAW attempt's detail.
    const decoded = tryDecodeBase64Text(data);
    if (decoded) {
      try {
        const json = dpapi('Unprotect', decoded).toString('utf8'), value = JSON.parse(json);
        if (healBase64TextFile(target, decoded)) {
          const afterHeal = stampOf(target);
          if (afterHeal) {
            let same = false;
            try { same = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === crypto.createHash('sha256').update(decoded).digest('hex'); } catch {}
            if (same) cache.set(name, {...afterHeal, json});
          }
        }
        return value;
      } catch (e2) {
        if (e2 && e2.slow) throw Object.assign(new Error(t('暗号化ファイル {file} を読めませんでした。Windows の暗号化ストレージの応答が遅れています（ほかに多くの処理が動いているときに起きます）。少し待ってからやり直してください。', {file: target})), {slow: true});
      }
    }
    // The way out is per file (audit-cli wave 8): the old text sent every failure to
    // `muser login`, but a broken device.enc / session.enc makes login itself stop on
    // this same error — a loop with no exit. Name the file, say to delete THAT file
    // by hand first, and name the command that recreates it: the website login and
    // the gateway credentials come back with login, the device pair and the
    // remembered contact with pc-login. Any other store file just says delete it
    // by hand and retry.
    const base = path.basename(name);
    const recreate = base === 'device.enc' || base === 'contact.enc' ? '`muser pc-login`' : base === 'web.enc' || base === 'session.enc' ? '`muser login`' : null;
    if (recreate) throw new Error(t('暗号化ファイル {file} を読み込めませんでした。ファイルが壊れているか、別の Windows ユーザーで作成されたか、保存形式が想定と違うだけの可能性があります。このままでは同じエラーで止まるため、まずこのファイル {file} を手で削除してから、{command} を実行して作り直してください。（詳細: {detail}）', {file: target, command: recreate, detail: e.message}));
    throw new Error(t('暗号化ファイル {file} を読み込めませんでした。ファイルが壊れているか、別の Windows ユーザーで作成されたか、保存形式が想定と違うだけの可能性があります。このままでは同じエラーで止まるため、まずこのファイル {file} を手で削除してから、もう一度実行してください。（詳細: {detail}）', {file: target, detail: e.message}));
  }
}

function remove(name) { cache.delete(name); try { fs.unlinkSync(file(name)); } catch {} }

module.exports = {DIR, file, save, load, remove, preload, renameRetry, parsePreloadOutput, decodePreload, tryDecodeBase64Text};
