'use strict';
// @path mentions: the files a message names are sent along with it (Claude Code style), and
// count as read for the edit tools. Also the file list behind @ completion.
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {heavyGlobs} = require('./tools');

const MAX_FILE = 40000, MAX_TOTAL = 150000, MAX_LIST = 300;
// Files bigger than this are referenced by name only, never read into the message.
const MAX_INLINE_BYTES = 1024 * 1024;
// Refs that cannot name a real file (glob patterns, shell metachars) skip the stat entirely.
// Only characters Windows forbids in a file name belong here: '[', ']', '{' and '}' are
// legal in real file names, and refs containing them used to be reported missing without
// ever being stat'ed (audit #239).
const OBVIOUSLY_MISSING = /[*?<>|"]/
// Not after a letter, digit or dot (so emails stay text); Japanese often has no space before @.
// A ")" is allowed inside when it balances an "(" — downloads like `image (1).png` / `image(1).png`
// used to be cut at the ")" and reported missing. The " (1)" segment (a space before the parens)
// is part of the name too.
const MENTION = /(^|[^A-Za-z0-9._%+@-])@("[^"]+"|[^\s"`、。，．]+(?: \(\d+\)[^\s"`、。，．]*)?)/g;
// Trailing punctuation comes off, except a ")" that balances an earlier "(" in the name.
function trimRef(ref) {
  let s = ref.replace(/^"|"$/g, '').replace(/[,.;:\]]+$/, '');
  while (s.endsWith(')') && (s.split(')').length - 1) > (s.split('(').length - 1)) s = s.slice(0, -1).replace(/[,.;:\]]+$/, '');
  return s;
}

// Blank out code spans and fenced blocks so their contents are not mentions. Written as a
// scanner instead of two regexes (audit #240): the old pairing let a STRAY backtick swallow
// a mention — an unclosed ``` ate the rest of the message, and a lone ` paired with the
// opener of a later real span, eating everything between. Here a run only opens a span
// when a matching closing run exists (for an inline span: on the same line, hugging its
// content — an opener followed by a space is prose punctuation, not code), and an
// unmatched run stays literal text.
function stripCode(text) {
  const s = String(text);
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] !== '`') { out += s[i++]; continue; }
    let j = i; while (j < s.length && s[j] === '`') j++;
    const run = j - i;
    if (run >= 3) {
      const close = s.indexOf('```', j);
      if (close === -1) { out += s.slice(i, j); i = j; continue; } // unclosed fence: literal
      let k = close; while (k < s.length && s[k] === '`') k++;
      out += ' '; i = k; continue;
    }
    // Inline span: the opener must hug its content (no space after it), and a closing run
    // of the same length must follow on this line, its content hugging it too.
    if (i + run >= s.length || /\s/.test(s[j])) { out += s.slice(i, j); i = j; continue; }
    let close = -1;
    for (let p = j; p < s.length && s[p] !== '\n'; p++) {
      if (s[p] !== '`') continue;
      let q = p; while (q < s.length && s[q] === '`') q++;
      if (q - p === run && !/\s/.test(s[p - 1])) { close = p; break; }
      p = q - 1;
    }
    if (close === -1) { out += s.slice(i, j); i = j; continue; } // stray backtick: literal
    out += ' '; i = close + run;
  }
  return out;
}

function mentions(text) {
  const out = []; let m;
  // Code is not a mention: `@babel/core` or `@types/node` in backticks was looked up as a file
  // (with the closing backtick in its name) and reported missing.
  const plain = stripCode(text);
  MENTION.lastIndex = 0;
  while ((m = MENTION.exec(plain))) out.push(trimRef(m[2]));
  return [...new Set(out)];
}

// Returns {block, files, missing}: block is appended to the message for Muse.
function expand(text, cwd, readFiles) {
  const parts = [], files = [], missing = []; let total = 0;
  // MAX_TOTAL is a budget for the WHOLE block: every part counts toward it. Folder
  // listings and the large/binary/sensitive notices used to be free, so a block could
  // come out several times over the limit (audit #238).
  const push = part => { parts.push(part); total += part.length; };
  for (const ref of mentions(text)) {
    if (OBVIOUSLY_MISSING.test(ref)) { missing.push(ref); continue; }
    const p = require('./tools').realOf(path.resolve(cwd, ref)); // the file system's spelling, as the edit tools key reads
    // Secrets never ride along, however they were named: a pasted `@../../.ssh/id_rsa`
    // (or a symlink inside the project pointing at one) used to inline the key into the
    // message, past the guard every read tool enforces (audit #237). The check runs on
    // the path as written and on where it really leads, before anything is read or
    // listed — a sensitive folder's names are not listed either.
    if (require('./tools').isSensitivePath(path.resolve(cwd, ref)) || require('./tools').isSensitivePath(p)) {
      push('File ' + ref + ': sensitive file (key / credential / env) — not included. muser never sends secrets; refer to it by name only.');
      files.push({ref, kind: 'sensitive'});
      continue;
    }
    let st; try { st = fs.statSync(p); } catch { missing.push(ref); continue; }
    if (!st.isDirectory() && st.size > MAX_INLINE_BYTES) {
      push('File ' + ref + ': ' + st.size + ' bytes — too large to include (over 1 MB); referenced by name only. Read it with code.read in chunks if needed.');
      files.push({ref, kind: 'large', size: st.size});
      continue;
    }
    if (st.isDirectory()) {
      // The whole count, and that the list is cut: a folder of 5,000 files was announced as "300 files".
      const found = listFiles(p), list = found.slice(0, MAX_LIST);
      let part = 'Folder ' + ref + ' (' + found.length + ' files' + (found.length > list.length ? '; the first ' + list.length + ' listed, use code.glob for the rest' : '') + '):\n' + list.join('\n');
      if (total + part.length > MAX_TOTAL) part = part.slice(0, Math.max(0, MAX_TOTAL - total)) + '\n… (truncated; use code.glob for the rest)';
      push(part);
      files.push({ref, kind: 'dir', count: found.length});
      continue;
    }
    const buf = fs.readFileSync(p), utf16 = require('./tools').utf16Of(buf); // UTF-16 (PowerShell `>`) is text, not binary
    if (!utf16 && buf.includes(0)) { push('File ' + ref + ': binary, ' + buf.length + ' bytes (not included).'); files.push({ref, kind: 'binary'}); continue; }
    let body = (utf16 ?? buf.toString('utf8')).replace(/\r\n/g, '\n');
    const cut = body.length > MAX_FILE || total + body.length > MAX_TOTAL;
    if (cut) body = body.slice(0, Math.max(0, Math.min(MAX_FILE, MAX_TOTAL - total))) + '\n… (truncated; use code.read for the rest)';
    const lines = body.split('\n');
    push('File ' + ref + ' (' + lines.length + ' lines' + (cut ? ', truncated' : '') + '):\n' + lines.map((l, i) => String(i + 1).padStart(5) + '\t' + l).join('\n'));
    files.push({ref, kind: 'file', lines: lines.length});
    // Counts as read for the edit tools, with what it looked like, so a later code.write notices a change made since.
    if (!cut && readFiles) { readFiles.add(p); require('./tools').recordRead({readFiles}, p); }
  }
  return {block: parts.length ? '[Files the user attached with @]\n' + parts.join('\n\n') : '', files, missing};
}

// How the last listFiles call went, for the UI: {source: 'rg' | 'walk' | 'none', error}.
// The completion used to fail silently to an empty list whenever rg was missing or its
// output overflowed, which read as "@ does not work"; now rg failure falls back to a
// plain fs walk and the reason stays available here.
let listDiag = {source: 'rg', error: ''};
// OneDrive (placeholders download when read) and, from the home folder, AppData are skipped, as
// in code.grep: rg over the home folder walked OneDrive for minutes on 2026-10-31.
const rgArgs = dir => ['--files', '--sort', 'path', ...heavyGlobs(dir).flatMap(g => ['-g', g])];
const fromRg = out => out.split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'));
function fallback(dir, rgError) {
  try {
    const files = walkFiles(dir);
    listDiag = {source: 'walk', error: rgError};
    return files;
  } catch (e) {
    listDiag = {source: 'none', error: rgError + '; ' + e.message};
    return [];
  }
}
// Synchronous, for an @folder the user sent (expand).
function listFiles(dir) {
  const r = spawnSync('rg', rgArgs(dir), {cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10000});
  if (!r.error && (r.status === 0 || r.status === 1)) { listDiag = {source: 'rg', error: ''}; return fromRg(r.stdout); }
  return fallback(dir, r.error ? String(r.error.code || r.error.message) : 'rg exit ' + r.status);
}
// In the background, for @ completion: stops after timeoutMs with what it has.
function listFilesAsync(dir, timeoutMs = 10000) {
  return new Promise(resolve => {
    let out = '', done = false, child;
    const finish = files => { if (done) return; done = true; clearTimeout(timer); resolve(files); };
    try { child = spawn('rg', rgArgs(dir), {cwd: dir, windowsHide: true}); } catch (e) { return resolve(fallback(dir, String(e.code || e.message))); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} listDiag = {source: 'rg', error: 'stopped after ' + Math.round(timeoutMs / 1000) + ' s'}; finish(fromRg(out)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < 16 * 1024 * 1024) out += d; });
    // After the timeout resolved with the partial list, the killed child's close event
    // still ran the full fallback walk (its result discarded by finish()) and overwrote
    // listDiag with the walk's outcome (audit #241). Once settled, handlers do nothing —
    // fallback() is only ever evaluated when its result will actually be used.
    child.on('error', e => { if (!done) finish(fallback(dir, String(e.code || e.message))); });
    child.on('close', code => { if (done) return; if (code === 0 || code === 1) { listDiag = {source: 'rg', error: ''}; finish(fromRg(out)); } else finish(fallback(dir, 'rg exit ' + code)); });
  });
}
// Fallback when rg is unavailable: recursive walk with rg-like habits (hidden files and
// node_modules / .git skipped, '/' separators, sorted). It does not read .gitignore, so
// in a repo it can list files rg would have hidden; capped like the rg path in practice.
const WALK_SKIP = new Set(['node_modules', '.git']);
function walkFiles(dir) {
  const out = [], stack = [''];
  const norm = path.resolve(dir).replace(/\\/g, '/').toLowerCase();
  const skipOneDrive = !/\/onedrive[^/]*(\/|$)/.test(norm), atHome = norm === require('node:os').homedir().replace(/\\/g, '/').toLowerCase();
  while (stack.length && out.length < 20000) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || WALK_SKIP.has(e.name)) continue;
      if ((skipOneDrive && /^onedrive/i.test(e.name)) || (atHome && !rel && e.name === 'AppData')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) { out.push(r); if (out.length >= 20000) break; }
    }
  }
  return out.sort();
}

// @ completion: files and folders under cwd matching the typed fragment, best first. The list is
// built in the background: a synchronous rg inside the render froze the screen on "@" in a big
// folder. Until it is there, complete() returns [] and loading(cwd) is true; onReady (a re-render)
// is called when it arrives. A stale list keeps being used while a fresh one is built.
let cache = null, pending = null;
function refresh(cwd, onReady) {
  if (pending?.cwd === cwd) { if (onReady) pending.waiters.add(onReady); return pending.promise; }
  const waiters = new Set(onReady ? [onReady] : []), entry = {cwd, waiters};
  entry.promise = listFilesAsync(cwd).then(found => {
    const files = found.slice(0, 20000), dirs = new Set();
    for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/'); }
    // A listing for a folder left meanwhile (resume into another one) must not replace the new one's.
    if (pending === entry || !cache || cache.cwd === cwd) cache = {cwd, at: Date.now(), list: [...dirs, ...files]};
  }).finally(() => {
    if (pending === entry) pending = null; // only its own: a newer folder's listing may be running
    for (const w of waiters) { try { w(); } catch {} }
  });
  pending = entry;
  return entry.promise;
}
function candidates(cwd, onReady) {
  if (!(cache?.cwd === cwd && Date.now() - cache.at < 30000)) refresh(cwd, onReady);
  return cache?.cwd === cwd ? cache.list : [];
}
// Drop the cached list's freshness (the next candidates() call rebuilds it): files a tool or a
// !command just created were invisible to @ completion for up to 30 s.
function invalidate(cwd) { if (cache && (!cwd || cache.cwd === cwd)) cache.at = 0; completeCache.clear(); }
function loading(cwd) { return pending?.cwd === cwd && cache?.cwd !== cwd; }
// Resolves when the list for cwd is there (tests, and anything that must wait for it).
function ready(cwd) { candidates(cwd); return pending?.cwd === cwd ? pending.promise : Promise.resolve(); }
// Memoised per (cwd, fragment, limit); invalidated whenever the candidate list refreshes.
const completeCache = new Map();
function complete(fragment, cwd, limit = 6, onReady) {
  const list = candidates(cwd, onReady);
  if (!cache || cache.cwd !== cwd) return [];
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
  // No matches from a stale list may just mean the file is new: rebuild in the background so the
  // next render can find it, instead of reporting "no match" for the whole 30 s cache life.
  if (!result.length && Date.now() - cache.at > 2000) refresh(cwd, onReady);
  if (completeCache.size > 200) completeCache.clear();
  completeCache.set(key, {stamp: cache.at, result});
  return result;
}

// The @fragment the caret is in, if any. Balanced ")" is part of the fragment (see MENTION).
function fragmentAt(text, pos) {
  const m = /(^|[^A-Za-z0-9._%+@-])@("?[^\s"、。，．]*)$/.exec(text.slice(0, pos));
  if (!m) return null;
  const fragment = trimRef(m[2].replace(/^"/, ''));
  return {start: pos - m[2].length + (m[2].startsWith('"') ? 1 : 0), fragment};
}

// One completion limit everywhere (the footer, Tab and Enter used to disagree: 6 vs 12).
const COMPLETE_LIMIT = 6;
module.exports = {mentions, expand, complete, fragmentAt, walkFiles, loading, ready, invalidate, COMPLETE_LIMIT, listDiag: () => listDiag, listFilesAsync};
