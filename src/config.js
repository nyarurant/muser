'use strict';
// ~/.muser/config.json, shared by the language choice, skills and the user's own settings
// (maxAgents, updateCheck, bell …). A file that does not parse (a hand edit with a stray comma)
// used to be read as {} and written back as just the one changed key, wiping every other
// setting. It is now moved aside as config.json.corrupt-<time> first, and writes go through a
// temp file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function file() { return path.join(os.homedir(), '.muser', 'config.json'); }

// JSON a person saved: Windows PowerShell's Set-Content -Encoding utf8 (and Notepad's "UTF-8 with
// BOM") puts a BOM first, and JSON.parse refuses it, so a hand-edited config.json was ignored
// whole and then moved aside as corrupt on the next /lang.
function parseJson(raw) { const s = String(raw); return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s); }
function readJson(f) { return parseJson(fs.readFileSync(f, 'utf8')); }

function read() {
  try { const v = readJson(file()); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

// Change it: fn gets the current settings and edits them in place.
function update(fn) {
  const f = file();
  let cfg = {}, raw = null;
  try { raw = fs.readFileSync(f, 'utf8'); } catch {}
  if (raw !== null && raw.trim()) {
    try { const v = parseJson(raw); cfg = v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch { try { fs.renameSync(f, f + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {} }
  }
  fn(cfg);
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const temp = f + '.tmp-' + process.pid + '-' + Date.now();
  try { fs.writeFileSync(temp, JSON.stringify(cfg, null, 2)); fs.renameSync(temp, f); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
  return cfg;
}

module.exports = {file, read, update, parseJson, readJson};
