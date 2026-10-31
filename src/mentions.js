'use strict';
// @path mentions: the files a message names are sent along with it (Claude Code style), and
// count as read for the edit tools. Also the file list behind @ completion.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const MAX_FILE = 40000, MAX_TOTAL = 150000, MAX_LIST = 300;
// Files bigger than this are referenced by name only, never read into the message.
const MAX_INLINE_BYTES = 1024 * 1024;
// Refs that cannot name a real file (glob patterns, shell metachars) skip the stat entirely.
const OBVIOUSLY_MISSING = /[*?<>|[\]{}]/;
// Not after a letter, digit or dot (so emails stay text); Japanese often has no space before @.
const MENTION = /(^|[^A-Za-z0-9._%+@-])@("[^"]+"|[^\s"、。，．）)]+)/g;

function mentions(text) {
  const out = []; let m;
  MENTION.lastIndex = 0;
  while ((m = MENTION.exec(text))) out.push(m[2].replace(/^"|"$/g, '').replace(/[,.;:)\]]+$/, ''));
  return [...new Set(out)];
}

// Returns {block, files, missing}: block is appended to the message for Muse.
function expand(text, cwd, readFiles) {
  const parts = [], files = [], missing = []; let total = 0;
  for (const ref of mentions(text)) {
    if (OBVIOUSLY_MISSING.test(ref)) { missing.push(ref); continue; }
    const p = path.resolve(cwd, ref);
    let st; try { st = fs.statSync(p); } catch { missing.push(ref); continue; }
    if (!st.isDirectory() && st.size > MAX_INLINE_BYTES) {
      parts.push('File ' + ref + ': ' + st.size + ' bytes — too large to include (over 1 MB); referenced by name only. Read it with code.read in chunks if needed.');
      files.push({ref, kind: 'large', size: st.size});
      continue;
    }
    if (st.isDirectory()) {
      const list = listFiles(p).slice(0, MAX_LIST);
      parts.push('Folder ' + ref + ' (' + list.length + ' files):\n' + list.join('\n'));
      files.push({ref, kind: 'dir', count: list.length});
      continue;
    }
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) { parts.push('File ' + ref + ': binary, ' + buf.length + ' bytes (not included).'); files.push({ref, kind: 'binary'}); continue; }
    let body = buf.toString('utf8').replace(/\r\n/g, '\n');
    const cut = body.length > MAX_FILE || total + body.length > MAX_TOTAL;
    if (cut) body = body.slice(0, Math.max(0, Math.min(MAX_FILE, MAX_TOTAL - total))) + '\n… (truncated; use code.read for the rest)';
    total += body.length;
    const lines = body.split('\n');
    parts.push('File ' + ref + ' (' + lines.length + ' lines' + (cut ? ', truncated' : '') + '):\n' + lines.map((l, i) => String(i + 1).padStart(5) + '\t' + l).join('\n'));
    files.push({ref, kind: 'file', lines: lines.length});
    if (!cut) readFiles?.add(p);
  }
  return {block: parts.length ? '[Files the user attached with @]\n' + parts.join('\n\n') : '', files, missing};
}

function listFiles(dir) {
  const r = spawnSync('rg', ['--files', '--sort', 'path'], {cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  return r.status === 0 || r.status === 1 ? r.stdout.split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/')) : [];
}

// @ completion: files and folders under cwd matching the typed fragment, best first.
let cache = null;
function candidates(cwd) {
  if (cache?.cwd === cwd && Date.now() - cache.at < 30000) return cache.list;
  const files = listFiles(cwd).slice(0, 20000), dirs = new Set();
  for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/'); }
  cache = {cwd, at: Date.now(), list: [...dirs, ...files]};
  return cache.list;
}
// Memoised per (cwd, fragment, limit); invalidated whenever the candidate list refreshes.
const completeCache = new Map();
function complete(fragment, cwd, limit = 6) {
  const list = candidates(cwd);
  const key = cwd + '\0' + fragment + '\0' + limit;
  const hit = completeCache.get(key);
  if (hit && hit.stamp === cache.at) return hit.result;
  const q = fragment.toLowerCase().replace(/\\/g, '/');
  const score = f => {
    const l = f.toLowerCase(), base = l.split('/').filter(Boolean).pop() || l;
    if (l.startsWith(q)) return 0;
    if (base.startsWith(q)) return 1;
    if (l.includes(q)) return 2;
    let i = 0; for (const ch of l) if (ch === q[i]) i++;
    return i === q.length ? 3 : 9;
  };
  const result = list.map(f => [f, score(f)]).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1] || a[0].length - b[0].length).slice(0, limit).map(([f]) => f);
  if (completeCache.size > 200) completeCache.clear();
  completeCache.set(key, {stamp: cache.at, result});
  return result;
}

// The @fragment the caret is in, if any.
function fragmentAt(text, pos) {
  const m = /(^|[^A-Za-z0-9._%+@-])@("?[^\s"、。，．）)]*)$/.exec(text.slice(0, pos));
  return m ? {start: pos - m[2].length, fragment: m[2].replace(/^"/, '')} : null;
}

module.exports = {mentions, expand, complete, fragmentAt};
