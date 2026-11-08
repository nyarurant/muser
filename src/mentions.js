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
// Fullwidth sentence punctuation (！？：； and closing brackets 』」）】〉》) also ends a ref:
// it is prose punctuation, not part of the file name in this context (deep H6). Japanese
// particles/kana glued to a ref (を見て, を確認して) are handled in expand() instead:
// they CAN be part of a real file name, so they are only trimmed when the full ref
// does not exist and a shorter ref does (see trimmedRefs).
const MENTION = /(^|[^A-Za-z0-9._%+@-])@("[^"]+"|[^\s"`、。，．！？：；』」）】〉》]+(?: \(\d+\)[^\s"`、。，．！？：；』」）】〉》]*)?)/g;
// Trailing punctuation comes off, except a ")" that balances an earlier "(" in the name.
function trimRef(ref) {
  let s = ref.replace(/^"|"$/g, '').replace(/[,.;:\]]+$/, '');
  while (s.endsWith(')') && (s.split(')').length - 1) > (s.split('(').length - 1)) s = s.slice(0, -1).replace(/[,.;:\]]+$/, '');
  return s;
}
// slice() that never splits a surrogate pair: cutting a body at MAX_FILE used to
// leave a lone high surrogate at the boundary when an emoji sat there (c13 #6).
function sliceSafe(s, n) {
  n = Math.max(0, Math.min(n, s.length));
  if (n > 0 && n < s.length) { const c = s.charCodeAt(n - 1); if (c >= 0xD800 && c <= 0xDBFF) n--; }
  return s.slice(0, n);
}
// Shorter refs obtained by dropping trailing non-ASCII characters one at a time,
// longest first (deep H6). Japanese prose is routinely glued to a mention with no
// space — '@README.mdを見て', '@src/a.jsを確認して' — and the regex cannot tell
// where the name ends, because a real file name may itself contain Japanese
// characters ('報告書.mdを見て' is that file plus を見て; 'メモ.txt' is a name on
// its own). So expand() tries the full ref first and only falls back to these
// candidates when the full ref does not exist: the longest existing file wins,
// and a Japanese-named file is never truncated when it exists as written.
function trimmedRefs(ref) {
  const out = [];
  const chars = Array.from(ref);
  while (chars.length > 1) {
    if (chars[chars.length - 1].codePointAt(0) < 128) break;
    chars.pop();
    const cand = trimRef(chars.join(''));
    if (cand && cand !== ref && !out.includes(cand)) out.push(cand);
  }
  return out;
}
function statOrNull(p) { try { return fs.statSync(p); } catch { return null; } }
// A UNC path (\\server\share\... or //server/share/...; path.resolve turns the
// second spelling — and the \\?\UNC\... spelling — into the first) is never
// probed: realOf()/stat below are synchronous, so resolving one makes Windows
// open an SMB connection to a host named by the message text — an unreachable
// host froze the send for ~21 s (measured), and a reachable one could be an
// attacker's server offered the user's NTLM credentials. The same rule as
// pasted paths in clipboard.js. A UNC ref is therefore reported missing
// exactly as written, without touching the network. That deliberately gives
// up the legitimate use of @mentioning a file on a reachable share: safety
// wins over reachability here, because the probe cannot be told apart from
// the attack and cannot be bounded while it is synchronous.
function isUnc(p) { return p.startsWith('\\\\') || p.startsWith('//'); }

// Blank out code spans and fenced blocks so their contents are not mentions. Written as a
// scanner instead of two regexes (audit #240): the old pairing let a STRAY backtick swallow
// a mention — an unclosed ``` ate the rest of the message, and a lone ` paired with the
// opener of a later real span, eating everything between. Here a run only opens a span
// when a matching closing run exists (for an inline span: on the same line, hugging its
// content — an opener followed by a space is prose punctuation, not code), and an
// unmatched run stays literal text.
function stripCode(text) {
  const s = String(text);
  // Output is assembled as literal segments joined once at the end, not by
  // per-character string concatenation: [segStart, i) is the pending literal
  // segment, flushed only where a code span replaces it with a single space.
  const parts = [];
  let i = 0, segStart = 0;
  const flush = end => { if (end > segStart) parts.push(s.slice(segStart, end)); };
  // Inline-span searches that found no closing run: failEol[len] is where the
  // failed search stopped (the end of its line). A later opener of the same
  // length on that same line searches a subset of the same text, so it must
  // fail too and can skip the scan — without this, a line full of unclosed
  // backticks cost openers x line length (third audit M15).
  const failEol = [0, 0, 0];
  while (i < s.length) {
    // Tilde fences hide their contents exactly like backtick fences (third
    // audit M16: a ~~~ example's @decorator was picked up as a mention).
    const fence = s[i] === '`' ? '`' : s[i] === '~' ? '~' : null;
    if (!fence) { i++; continue; }
    let j = i; while (j < s.length && s[j] === fence) j++;
    const run = j - i;
    if (run >= 3) {
      const close = s.indexOf(fence.repeat(3), j);
      if (close === -1) { i = j; continue; } // unclosed fence: literal
      let k = close; while (k < s.length && s[k] === fence) k++;
      flush(i); parts.push(' '); i = k; segStart = i; continue;
    }
    if (fence === '~') { i = j; continue; } // 1-2 tildes are prose (strikethrough), not a span
    // Inline span: the opener must hug its content (no space after it), and a closing run
    // of the same length must follow on this line, its content hugging it too.
    if (i + run >= s.length || /\s/.test(s[j])) { i = j; continue; }
    if (failEol[run] > i) { i = j; continue; } // known: no closing run of this length on this line
    let close = -1, p = j;
    for (; p < s.length && s[p] !== '\n'; p++) {
      if (s[p] !== '`') continue;
      let q = p; while (q < s.length && s[q] === '`') q++;
      if (q - p === run && !/\s/.test(s[p - 1])) { close = p; break; }
      p = q - 1;
    }
    if (close === -1) { failEol[run] = p; i = j; continue; } // stray backtick: literal
    flush(i); parts.push(' '); i = close + run; segStart = i;
  }
  flush(i);
  return parts.join('');
}

function mentions(text) {
  const out = []; let m;
  // Code is not a mention: `@babel/core` or `@types/node` in backticks was looked up as a file
  // (with the closing backtick in its name) and reported missing.
  const plain = stripCode(text);
  MENTION.lastIndex = 0;
  // An @ inside a URL is part of the link, not a file the user attached:
  // 'https://example.com/@user/profile' used to resolve to a local
  // user/profile file when one happened to exist, and otherwise just added
  // a bogus 'missing' entry (c13 #2). The @'s own word carries the scheme.
  // That check used to slice the whole prefix for every match to recover the
  // word before the @, which is quadratic on @-heavy text (40k mentions over
  // 960 KB took ~95 s and froze submit()). Matches arrive in order, so one
  // forward scan decides the same thing in linear time: scanPos only moves
  // forward across matches, and wordHasScheme tracks whether the word ending
  // just before the current @ (the run of non-whitespace behind it) contains
  // '://'. A '://' triple is three consecutive non-whitespace characters, so
  // it can never straddle a word boundary.
  let scanPos = 0, wordHasScheme = false;
  while ((m = MENTION.exec(plain))) {
    const at = m.index + m[1].length;
    while (scanPos < at) {
      const c = plain[scanPos];
      if (/\s/.test(c)) wordHasScheme = false;
      else if (c === '/' && scanPos >= 2 && plain[scanPos - 1] === '/' && plain[scanPos - 2] === ':') wordHasScheme = true;
      scanPos++;
    }
    if (wordHasScheme) continue;
    out.push(trimRef(m[2]));
  }
  return [...new Set(out)];
}

// Returns {block, files, missing}: block is appended to the message for Muse.
function expand(text, cwd, readFiles) {
  const parts = [], files = [], missing = []; let total = 0;
  const seenPaths = new Set(); // resolved paths already handled, under any spelling (c13 #5)
  // MAX_TOTAL is a budget for the WHOLE block: every part counts toward it. Folder
  // listings and the large/binary/sensitive notices used to be free, so a block could
  // come out several times over the limit (audit #238).
  const push = part => { parts.push(part); total += part.length; };
  for (const rawRef of mentions(text)) {
    if (OBVIOUSLY_MISSING.test(rawRef)) { missing.push(rawRef); continue; }
    let ref = rawRef;
    const written = path.resolve(cwd, ref);
    // UNC refs are missing without any probe (see isUnc): this check runs
    // before realOf/stat — and before the sensitive check — so no network
    // access and no credential offer can happen for them at all. The check
    // covers the ref as written and as resolved (a // spelling, a \\?\UNC\
    // spelling, or a relative ref under a UNC cwd all resolve to \\).
    if (isUnc(rawRef) || isUnc(written)) { missing.push(rawRef); continue; }
    let p = require('./tools').realOf(written); // the file system's spelling, as the edit tools key reads
    // Secrets never ride along, however they were named: a pasted `@../../.ssh/id_rsa`
    // (or a symlink inside the project pointing at one) used to inline the key into the
    // message, past the guard every read tool enforces (audit #237). The check runs on
    // the path as written and on where it really leads, before anything is read or
    // listed — a sensitive folder's names are not listed either.
    let sensitive = require('./tools').isSensitivePath(written) || require('./tools').isSensitivePath(p);
    let st = sensitive ? null : statOrNull(p);
    // Deep H6: the full ref did not exist — it may be a real file with Japanese
    // prose glued to it. Try progressively shorter refs (longest first); the
    // first candidate that exists, or that turns out sensitive, wins. If none
    // does, the ref is reported missing exactly as written.
    if (!sensitive && !st) {
      for (const cand of trimmedRefs(rawRef)) {
        const candWritten = path.resolve(cwd, cand);
        if (isUnc(cand) || isUnc(candWritten)) continue; // a trimmed candidate is never probed on the network either
        const candReal = require('./tools').realOf(candWritten);
        if (require('./tools').isSensitivePath(candWritten) || require('./tools').isSensitivePath(candReal)) { ref = cand; p = candReal; sensitive = true; break; }
        const candSt = statOrNull(candReal);
        if (candSt) { ref = cand; p = candReal; st = candSt; break; }
      }
    }
    if (sensitive) {
      push('File ' + ref + ': sensitive file (key / credential / env) — not included. muser never sends secrets; refer to it by name only.');
      files.push({ref, kind: 'sensitive'});
      continue;
    }
    // The same hardlink rule as the read tools: a file is inlined only when none
    // of its other names is sensitive. @mentions never had the phase-1 check, so
    // a hardlinked secret would otherwise have ridden along here; an unverifiable
    // link is not called sensitive, it is reported as unverifiable and left out.
    if (st && !st.isDirectory()) {
      const verdict = require('./tools').hardlinkVerdict(p);
      if (verdict === 'sensitive') {
        push('File ' + ref + ': sensitive file (key / credential / env) — not included. muser never sends secrets; refer to it by name only.');
        files.push({ref, kind: 'sensitive'});
        continue;
      }
      if (verdict === 'unknown') {
        push('File ' + ref + ': linked under another name (hard link) and its other names could not all be verified — not included.');
        files.push({ref, kind: 'hardlink-unknown'});
        continue;
      }
    }
    if (!st) { missing.push(rawRef); continue; }
    // The same file under another spelling ('@a.txt @./a.txt @A.TXT': case and
    // './' differ, the resolved path does not) was expanded once per spelling
    // and ate the budget each time (c13 #5). Once per resolved path is enough.
    // (Below the sensitive/hardlink notices on purpose: each spelling the user
    // wrote still gets its own refusal line, as before.)
    if (seenPaths.has(p)) continue;
    seenPaths.add(p);
    if (!st.isDirectory() && st.size > MAX_INLINE_BYTES) {
      push('File ' + ref + ': ' + st.size + ' bytes — too large to include (over 1 MB); referenced by name only. Read it with code.read in chunks if needed.');
      files.push({ref, kind: 'large', size: st.size});
      continue;
    }
    if (st.isDirectory()) {
      // The whole count, and that the list is cut: a folder of 5,000 files was announced as "300 files".
      // A listing hands over names, so sensitive names are withheld here too:
      // '@.' used to name credentials.json, id_rsa & co. to the model even
      // though their contents are refused (first audit #18).
      const foundAll = listFiles(p);
      const found = foundAll.filter(f => !require('./tools').isSensitivePath(path.join(p, f)));
      const withheld = foundAll.length - found.length, list = found.slice(0, MAX_LIST);
      let part = 'Folder ' + ref + ' (' + found.length + ' files' + (found.length > list.length ? '; the first ' + list.length + ' listed, use code.glob for the rest' : '') + (withheld ? '; ' + withheld + ' sensitive name' + (withheld === 1 ? '' : 's') + ' withheld' : '') + '):\n' + list.join('\n');
      if (total + part.length > MAX_TOTAL) { const note = '\n… (truncated; use code.glob for the rest)'; part = sliceSafe(part, Math.max(0, MAX_TOTAL - total - note.length)) + note; }
      push(part);
      files.push({ref, kind: 'dir', count: found.length});
      continue;
    }
    // The read itself can still fail after a successful stat (locked, ACL, or
    // swapped for a folder in between): that used to throw out of expand() and
    // kill the whole send (c13 #3). Now the ref is reported missing by name,
    // like an absent file, and the other mentions still go. The read is also
    // bounded at the inline limit: a file that grew past 1 MB since the stat
    // is not read whole into memory first.
    let buf;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const chunks = []; let got = 0;
        while (got <= MAX_INLINE_BYTES) {
          const chunk = Buffer.alloc(Math.min(65536, MAX_INLINE_BYTES + 1 - got));
          const n = fs.readSync(fd, chunk, 0, chunk.length, null);
          if (n === 0) break;
          chunks.push(chunk.subarray(0, n)); got += n;
        }
        buf = Buffer.concat(chunks, got);
      } finally { fs.closeSync(fd); }
    } catch { missing.push(rawRef); continue; }
    if (buf.length > MAX_INLINE_BYTES) {
      const size = Math.max(st.size, buf.length);
      push('File ' + ref + ': ' + size + ' bytes — too large to include (over 1 MB); referenced by name only. Read it with code.read in chunks if needed.');
      files.push({ref, kind: 'large', size});
      continue;
    }
    const utf16 = require('./tools').utf16Of(buf); // UTF-16 (PowerShell `>`) is text, not binary
    if (!utf16 && buf.includes(0)) { push('File ' + ref + ': binary, ' + buf.length + ' bytes (not included).'); files.push({ref, kind: 'binary'}); continue; }
    const body = (utf16 ?? buf.toString('utf8')).replace(/\r\n/g, '\n');
    // MAX_TOTAL budgets what is actually sent: the header and the per-line
    // number prefixes count too. Counting the raw body alone let a file of
    // short lines produce a block about twice the budget (c13 #4).
    const render = (b, isCut) => { const ls = b.split('\n'); return {text: 'File ' + ref + ' (' + ls.length + ' lines' + (isCut ? ', truncated' : '') + '):\n' + ls.map((l, idx) => String(idx + 1).padStart(5) + '\t' + l).join('\n'), lines: ls.length}; };
    const full = render(body, false);
    let cut = body.length > MAX_FILE || total + full.text.length > MAX_TOTAL, part = full.text, lineCount = full.lines;
    if (cut) {
      const note = '\n… (truncated; use code.read for the rest)';
      let lo = 0, hi = Math.min(body.length, MAX_FILE);
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (total + render(sliceSafe(body, mid) + note, true).text.length <= MAX_TOTAL) lo = mid; else hi = mid - 1; }
      const r = render(sliceSafe(body, lo) + note, true); part = r.text; lineCount = r.lines;
    }
    push(part);
    files.push({ref, kind: 'file', lines: lineCount});
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
// Lines from rg output. When the output was cut short (byte cap or a timeout
// kill), its last line is a fragment of a name, not a name: drop it instead of
// offering a file that does not exist, and let the caller note the cut in
// listDiag (c13 #7 — both used to pass silently as a complete list).
const rgLines = (out, cutShort) => { const lines = out.split('\n'); if (cutShort && !out.endsWith('\n')) lines.pop(); return lines.filter(Boolean).map(f => f.replace(/\\/g, '/')); };
const fromRg = out => rgLines(out, false);
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
// capBytes is the rg-output guard (tests pass a small one to exercise it).
function listFilesAsync(dir, timeoutMs = 10000, capBytes = 16 * 1024 * 1024) {
  return new Promise(resolve => {
    let out = '', capped = false, done = false, child;
    const finish = files => { if (done) return; done = true; clearTimeout(timer); resolve(files); };
    try { child = spawn('rg', rgArgs(dir), {cwd: dir, windowsHide: true}); } catch (e) { return resolve(fallback(dir, String(e.code || e.message))); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} listDiag = {source: 'rg', error: 'stopped after ' + Math.round(timeoutMs / 1000) + ' s'}; finish(rgLines(out, true)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { if (capped) return; if (out.length + d.length > capBytes) { out += d.slice(0, Math.max(0, capBytes - out.length)); capped = true; } else out += d; });
    // After the timeout resolved with the partial list, the killed child's close event
    // still ran the full fallback walk (its result discarded by finish()) and overwrote
    // listDiag with the walk's outcome (audit #241). Once settled, handlers do nothing —
    // fallback() is only ever evaluated when its result will actually be used.
    child.on('error', e => { if (!done) finish(fallback(dir, String(e.code || e.message))); });
    child.on('close', code => { if (done) return; if (code === 0 || code === 1) { listDiag = {source: 'rg', error: capped ? 'output capped at ' + capBytes + ' bytes; list truncated' : ''}; finish(rgLines(out, capped)); } else finish(fallback(dir, 'rg exit ' + code)); });
  });
}
// Fallback when rg is unavailable: recursive walk with rg-like habits (hidden files and
// node_modules / .git skipped, '/' separators, sorted). It does not read .gitignore, so
// in a repo it can list files rg would have hidden. Not capped: a cap made the
// files past it permanently invisible to @ completion (fourth audit M12).
const WALK_SKIP = new Set(['node_modules', '.git']);
function walkFiles(dir) {
  const out = [], stack = [''];
  const norm = path.resolve(dir).replace(/\\/g, '/').toLowerCase();
  const skipOneDrive = !/\/onedrive[^/]*(\/|$)/.test(norm), atHome = norm === require('node:os').homedir().replace(/\\/g, '/').toLowerCase();
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || WALK_SKIP.has(e.name)) continue;
      if ((skipOneDrive && /^onedrive/i.test(e.name)) || (atHome && !rel && e.name === 'AppData')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

// @ completion: files and folders under cwd matching the typed fragment, best first. The list is
// built in the background: a synchronous rg inside the render froze the screen on "@" in a big
// folder. Until it is there, complete() returns [] and loading(cwd) is true; onReady (a re-render)
// is called when it arrives. A stale list keeps being used while a fresh one is built.
let cache = null, pending = null;
// The mtime of one folder, or null when it is gone / not a folder. One stat per
// folder: the cheap staleness probe below, never a rescan.
function dirMtime(p) { try { const st = fs.statSync(p); return st.isDirectory() ? st.mtimeMs : null; } catch { return null; } }
// Snapshot the mtimes of the root and every folder the list names, taken when
// the list is built. Creating, deleting or renaming an entry updates its
// folder's mtime, so a later mismatch proves an outside change (an editor, a
// checkout, another tool) without re-reading any folder's contents.
function captureDirStamps(cwd, dirs) {
  const stamps = new Map();
  stamps.set('', dirMtime(cwd));
  for (const d of dirs) { const rel = d.replace(/\/$/, ''); if (rel) stamps.set(rel, dirMtime(path.join(cwd, rel))); }
  return stamps;
}
// The folder a fragment is being completed inside: 'src/a' completes in src/,
// 'src/' in src/ itself, a bare name in the root ('').
function fragmentDir(fragment) {
  const q = String(fragment || '').replace(/\\/g, '/');
  if (q.endsWith('/')) return q.replace(/\/$/, '');
  const i = q.lastIndexOf('/');
  return i === -1 ? '' : q.slice(0, i);
}
// Has any folder the cached list rests on changed since the list was built?
// Compares the root, the folder the current fragment targets, and every other
// folder in the snapshot (stats only — no directory is read). A target folder
// the snapshot does not know counts as changed once and is then remembered, so
// a still-empty new folder does not retrigger a refresh on every keystroke.
function stampsChanged(cwd, fragment) {
  if (!cache || cache.cwd !== cwd || !cache.dirStamps) return false;
  const target = fragmentDir(fragment);
  if (target && !cache.dirStamps.has(target)) {
    const cur = dirMtime(path.join(cwd, target));
    if (cur !== null) { cache.dirStamps.set(target, cur); return true; }
  }
  for (const [rel, was] of cache.dirStamps) {
    if (dirMtime(rel ? path.join(cwd, rel) : cwd) !== was) return true;
  }
  return false;
}
function refresh(cwd, onReady) {
  if (pending?.cwd === cwd) { if (onReady) pending.waiters.add(onReady); return pending.promise; }
  const waiters = new Set(onReady ? [onReady] : []), entry = {cwd, waiters, rootAtStart: dirMtime(cwd), prevStamps: cache?.cwd === cwd ? cache.dirStamps : null};
  entry.promise = listFilesAsync(cwd).then(found => {
    // No slice: cutting the candidate list at 20,000 made every file past it
    // permanently invisible to @ completion, however often the list refreshed
    // (fourth audit M12). The list is only names; complete() stays responsive
    // because it memoises per fragment.
    const files = found, dirs = new Set();
    for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/'); }
    // A listing for a folder left meanwhile (resume into another one) must not replace the new one's.
    if (pending === entry || !cache || cache.cwd === cwd) {
      const stamps = captureDirStamps(cwd, dirs);
      // A folder that changed while this listing was being built (or since the
      // previous list, for folders the new snapshot no longer / newly names)
      // may not be reflected in it: keep the list, but mark it stale so the
      // next reuse rebuilds once more instead of trusting the snapshot.
      let moved = stamps.get('') !== entry.rootAtStart;
      if (!moved && entry.prevStamps) {
        if (stamps.size !== entry.prevStamps.size) moved = true;
        else for (const [rel, was] of entry.prevStamps) if (stamps.get(rel) !== was) { moved = true; break; }
      }
      cache = {cwd, at: moved ? 0 : Date.now(), list: [...dirs, ...files], dirStamps: stamps};
    }
  }).finally(() => {
    if (pending === entry) pending = null; // only its own: a newer folder's listing may be running
    for (const w of waiters) { try { w(); } catch {} }
  });
  pending = entry;
  return entry.promise;
}
function candidates(cwd, onReady, fragment) {
  // Reuse is not blind trust for 30 s: muser's own edits call invalidate(), but
  // a file created, deleted or renamed outside muser left the cached list
  // untouched and its ghost (or absence) was served for the whole cache life.
  // A cheap folder-mtime probe on reuse spots that; the stale list keeps being
  // served while refresh() rebuilds it in the background, exactly like the
  // 30 s expiry path — never a synchronous rescan per keystroke.
  if (!(cache?.cwd === cwd && Date.now() - cache.at < 30000) || stampsChanged(cwd, fragment)) refresh(cwd, onReady);
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
  const list = candidates(cwd, onReady, fragment);
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
