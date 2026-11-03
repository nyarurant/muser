'use strict';
// Images for a turn: from the Windows clipboard (screenshot, copied image or copied files)
// or from a file path (drag and drop pastes the path). Muse receives them as message items.
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {t} = require('./i18n');

const IMAGE_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'};
const MAX = 10 * 1024 * 1024;

// Temp PNGs written by clipboardImages() (its IMG entries) that have not been
// converted into an attachment yet. attachment() takes its file out of this set
// when it converts (and unlinks) it; anything still tracked when a newer capture
// arrives was never used, so it is unlinked then instead of leaking in %TEMP%.
const pendingClipboardTemps = new Set();
function dropPendingClipboardTemps(except = new Set()) {
  for (const p of pendingClipboardTemps) {
    if (except.has(p)) continue;
    pendingClipboardTemps.delete(p);
    try { fs.unlinkSync(p); } catch {}
  }
}

const SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  'if([Windows.Forms.Clipboard]::ContainsImage()){$i=[Windows.Forms.Clipboard]::GetImage();$p=Join-Path $env:TEMP (\'muser-paste-\'+[guid]::NewGuid().ToString(\'N\')+\'.png\');$i.Save($p,[Drawing.Imaging.ImageFormat]::Png);\'IMG \'+$p}',
  'elseif([Windows.Forms.Clipboard]::ContainsFileDropList()){foreach($f in [Windows.Forms.Clipboard]::GetFileDropList()){\'FILE \'+$f}}',
  'else{\'NONE\'}',
].join(';');

// Files referenced by the clipboard: resolves {files, error} — error is null on success and a
// message when the clipboard could not be read at all, so "could not read" is not reported to
// the user as "no images" (the old code resolved [] for both).
function clipboardImages() {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], {windowsHide: true, encoding: 'utf8', timeout: 10000}, (err, out) => {
      if (err) return resolve({files: [], error: String(err.message || err)});
      const files = [];
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^(IMG|FILE) (.+)$/.exec(line.trim());
        if (m && isImage(m[2])) files.push({path: m[2], temporary: m[1] === 'IMG'});
      }
      // This capture supersedes the previous one: drop any earlier temp PNGs
      // that were never converted, and track this capture's temps instead.
      const freshTemps = new Set(files.filter(f => f.temporary).map(f => f.path));
      dropPendingClipboardTemps(freshTemps);
      for (const p of freshTemps) pendingClipboardTemps.add(p);
      resolve({files, error: null});
    });
  });
}

function isImage(p) { return !!IMAGE_TYPES[path.extname(p).toLowerCase()]; }

// A pasted string that is only one or more image paths (what dropping files into the terminal types).
function pastedImagePaths(text) {
  const parts = String(text).trim().match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const paths = parts.map(p => p.replace(/^["']|["']$/g, ''));
  return paths.length && paths.every(p => isImage(p) && path.isAbsolute(p) && fs.existsSync(p)) ? paths : null;
}

function attachment(file, temporary = false) {
  // The type comes from the extension, and an unsupported one used to fall back to
  // 'image/png' — a non-image file reached the API mislabelled as a PNG (audit #242).
  // The drag-and-drop path checked isImage() first; the phone path did not, so the
  // check belongs here. (The message string already exists for the controller's check.)
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(t('画像ファイル（png / jpg / gif / webp / bmp）を指定してください'));
  // Stat before reading: an oversized file is rejected from its size alone,
  // without first loading all of it into memory.
  if (fs.statSync(file).size > MAX) {
    if (temporary) { pendingClipboardTemps.delete(file); try { fs.unlinkSync(file); } catch {} }
    throw new Error(t('{file} は 10 MB を超えています', {file: path.basename(file)}));
  }
  const data = fs.readFileSync(file);
  if (data.length > MAX) throw new Error(t('{file} は 10 MB を超えています', {file: path.basename(file)}));
  const name = temporary ? 'clipboard.png' : path.basename(file);
  if (temporary) { pendingClipboardTemps.delete(file); try { fs.unlinkSync(file); } catch {} }
  return {name, type, size: data.length, data: data.toString('base64')};
}

// What the chat API takes (same shape as the muse.ai web client).
function toItems(list) { return list.map(a => ({type: 'image', mime_type: a.type, data_base64: a.data, filename: a.name})); }

module.exports = {clipboardImages, pastedImagePaths, attachment, toItems, isImage};
