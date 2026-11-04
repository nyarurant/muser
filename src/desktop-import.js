'use strict';
// Read the SDK token from Muse Desktop Community (read-only), because an account may hold only
// one SDK token. Its files are Electron safeStorage blobs: "v10" + 12-byte nonce + AES-256-GCM
// ciphertext + 16-byte tag, keyed by os_crypt.encrypted_key in "Local State" (DPAPI-protected).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {t} = require('./i18n');

const APP_DIR = path.join(process.env.APPDATA || '', 'Muse App');

function unprotect(buf) {
  const script = 'Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {input: buf.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000});
  // A spawn failure (powershell missing/blocked, timeout) sets r.error and leaves stdout
  // null; checking only r.status fell through to r.stdout.trim() and surfaced a bare
  // TypeError instead of the friendly message below.
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') throw new Error(t('デスクトップ版の暗号鍵を開けませんでした。'));
  // The base64 input and r.stdout are JS strings and cannot be zeroed; the returned
  // Buffer is the decrypted key and the caller zeroes it (fill(0)) after use.
  return Buffer.from(r.stdout.trim(), 'base64');
}

const keyFormatError = () => new Error(t('デスクトップ版の暗号鍵の形式が想定と違います。'));
const dataFormatError = () => new Error(t('デスクトップ版の保存データの形式が想定と違います。'));

function readDesktopFile(name) {
  // Deep #100: only the magic prefixes used to be checked, so a missing or
  // corrupt desktop file escaped as a bare ENOENT / SyntaxError / TypeError /
  // crypto error. Validate the structure (fields present, key 32 bytes, blob
  // long enough for v10 + nonce + tag) and map every structural failure onto
  // the friendly format messages above; unprotect's own friendly error and
  // the token check in desktopSdkToken() pass through unchanged.
  let key, blob, plain, wrapped;
  try {
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8')); } catch { throw keyFormatError(); }
    if (typeof state?.os_crypt?.encrypted_key !== 'string' || !state.os_crypt.encrypted_key) throw keyFormatError();
    wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64');
    if (wrapped.length <= 5 || wrapped.subarray(0, 5).toString() !== 'DPAPI') throw keyFormatError();
    key = unprotect(wrapped.subarray(5));
    if (!Buffer.isBuffer(key) || key.length !== 32) throw keyFormatError();
    try { blob = fs.readFileSync(path.join(APP_DIR, name)); } catch { throw dataFormatError(); }
    if (blob.length < 31 || blob.subarray(0, 3).toString() !== 'v10') throw dataFormatError();
    const nonce = blob.subarray(3, 15), tag = blob.subarray(blob.length - 16), data = blob.subarray(15, blob.length - 16);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce); d.setAuthTag(tag);
      plain = Buffer.concat([d.update(data), d.final()]);
      // plain.toString() is a JS string and cannot be zeroed; the Buffer is filled in finally.
      return JSON.parse(plain.toString('utf8'));
    } catch { throw dataFormatError(); }
  } finally {
    // Zero decrypted key/plaintext material; filling blob also clears its nonce/tag/data views.
    plain?.fill(0);
    blob?.fill(0);
    key?.fill(0);
    wrapped?.fill(0);
  }
}

// Only the SDK token is taken; the desktop app's own device pair and node id are left alone.
function desktopSdkToken() {
  // saved.sdkToken is a JS string and cannot be zeroed; only Buffer copies are filled after use.
  const saved = readDesktopFile('muse-device.enc');
  if (typeof saved?.sdkToken !== 'string' || !saved.sdkToken.startsWith('mgst_')) throw new Error(t('デスクトップ版に SDK トークンが見つかりません。'));
  return {sdkToken: saved.sdkToken, sdkTokenId: saved.sdkTokenId};
}

module.exports = {desktopSdkToken, APP_DIR, unprotect};
