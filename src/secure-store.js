'use strict';
// Small encrypted files under %LOCALAPPDATA%\muser, protected with Windows DPAPI
// (CurrentUser scope) through PowerShell, so no native module is needed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser');

function dpapi(op, input) {
  const script = `Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();` +
    `$b=[Convert]::FromBase64String($i);` +
    `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Console]::Out.Write([Convert]::ToBase64String($o))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    {input: input.toString('base64'), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15000});
  if (r.error) throw new Error('Windows の暗号化ストレージを使えませんでした。' + (r.error.code === 'ETIMEDOUT' ? '（タイムアウトしました）' : '（' + r.error.message + '）'));
  if (r.signal) throw new Error('Windows の暗号化ストレージを使えませんでした。（プロセスがシグナル ' + r.signal + ' で終了しました）');
  if (r.status !== 0) throw new Error('Windows の暗号化ストレージを使えませんでした。' + (r.stderr ? '（' + String(r.stderr).trim().slice(-200) + '）' : ''));
  return Buffer.from(r.stdout.trim(), 'base64');
}

function file(name) { return path.join(DIR, name); }

// Every DPAPI call starts PowerShell (~0.4 s, blocking), and startup used to decrypt the same
// files several times. Decrypted JSON is kept for this process, keyed by the file's mtime and
// size (another muser writing the file invalidates it), and an unchanged value is not saved.
const cache = new Map();
function stampOf(target) { try { const st = fs.statSync(target); return {mtimeMs: st.mtimeMs, size: st.size}; } catch { return null; } }
function fresh(name, st) { const c = cache.get(name); return c && st && c.mtimeMs === st.mtimeMs && c.size === st.size ? c : null; }

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
    'foreach($l in [Console]::In.ReadToEnd().Split([char]10)){$l=$l.Trim();if(!$l){continue};' +
    'try{$o=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($l),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.WriteLine([Convert]::ToBase64String($o))}catch{[Console]::Out.WriteLine(\'!\')}}';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    {input: todo.map(t => t.data.toString('base64')).join('\n'), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15000});
  if (r.error || r.status !== 0) return; // load() decrypts one by one and reports the real error
  const out = String(r.stdout).split(/\r?\n/).filter(Boolean);
  todo.forEach((t, i) => {
    if (!out[i] || out[i] === '!') return;
    try { const json = Buffer.from(out[i], 'base64').toString('utf8'); JSON.parse(json); cache.set(t.name, {...t.st, json}); } catch {}
  });
}

function save(name, value) {
  const target = file(name), json = JSON.stringify(value), c = fresh(name, stampOf(target));
  if (c && c.json === json) return;
  fs.mkdirSync(DIR, {recursive: true});
  const temp = target + '.tmp';
  fs.writeFileSync(temp, dpapi('Protect', Buffer.from(json, 'utf8')));
  fs.renameSync(temp, target);
  const st = stampOf(target); if (st) cache.set(name, {...st, json});
}

// Missing file -> null ("not logged in yet"). A file that exists but cannot be
// decrypted or parsed is a different, actionable problem: throw a clear error
// naming the file instead of crashing on a raw JSON.parse failure.
function load(name) {
  const target = file(name);
  const hit = fresh(name, stampOf(target));
  if (hit) return JSON.parse(hit.json);
  let data;
  try { data = fs.readFileSync(target); }
  catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
  try {
    const st = stampOf(target), json = dpapi('Unprotect', data).toString('utf8'), value = JSON.parse(json);
    if (st) cache.set(name, {...st, json});
    return value;
  } catch (e) {
    throw new Error('暗号化ファイル ' + target + ' を読み込めませんでした。ファイルが壊れているか、別の Windows ユーザーで作成された可能性があります。`muser login` でログインし直してください。（詳細: ' + e.message + '）');
  }
}

function remove(name) { cache.delete(name); try { fs.unlinkSync(file(name)); } catch {} }

module.exports = {DIR, file, save, load, remove, preload};
