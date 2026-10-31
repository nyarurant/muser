'use strict';
// The coding tools this PC offers Muse as device commands (link.register commands_v2).
// Each tool: def (what Muse sees), kind (read | edit | exec, for approval), run(params, ctx).
// run returns a payload for Muse; edits also return `view` (a diff for the terminal).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const {runOnce} = require('./shells');

const MAX_READ_LINES = 2000, MAX_LINE = 2000, MAX_OUT = 60000;
const MAX_READ_BYTES = 10 * 1024 * 1024, MAX_GLOB_RESULTS = 2000;

function resolve(ctx, p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) throw new Error('Invalid path');
  return path.resolve(ctx.cwd, p);
}
function inside(root, file) { const r = path.relative(root, file); return !r.startsWith('..') && !path.isAbsolute(r); }
// ---- Sensitive-file guard (code.read / code.grep / code.glob and every read path below) ----
// muser's coding tools must never read secrets back to the model: env files, private keys,
// credential/secret files, SSH/AWS/GPG homes, .netrc, and muser's own encrypted store.
function isSensitivePath(p) {
  if (typeof p !== 'string' || !p) return false;
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const base = (parts[parts.length - 1] || '').toLowerCase();
  const lower = parts.map(s => s.toLowerCase());
  if (lower.some(s => s === '.ssh' || s === '.aws' || s === '.gnupg')) return true;
  if (base === '.netrc' || base === '_netrc') return true;
  if (base === 'web.enc') return true;
  if (lower.includes('.muser') && base.endsWith('.enc')) return true;
  if (/^\.env($|[^a-z])/.test(base) || base.startsWith('.env')) {
    if (/^\.env\.(example|sample)(\.|$)/.test(base) || base === '.env.example' || base === '.env.sample') return false;
    return true;
  }
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  if ((base.startsWith('id_rsa') || base.startsWith('id_ed25519')) && !base.endsWith('.pub')) return true;
  // Credential files by their usual names only: a source file such as credentials_manager.js
  // or docs/secrets-handling.md is code to read, not a secret.
  if (base === 'credentials' || base === 'credentials.json' || base === '.secrets') return true;
  if (/^secrets?\.(json|ya?ml|toml|env|txt)$/.test(base)) return true;
  return false;
}
function assertNotSensitive(file) {
  if (isSensitivePath(file)) throw new Error('機密ファイルのため読み取りを拒否しました: ' + file + '（.env・鍵・認証情報など機密ファイルは code.read / code.grep / code.glob では読み取れません）');
}
function readText(file) {
  assertNotSensitive(file);
  let st; try { st = fs.statSync(file); } catch { /* let readFileSync raise the real error */ }
  if (st && st.size > MAX_READ_BYTES) throw new Error('ファイルが大きすぎるため読み取りを拒否しました: ' + file + '（' + st.size + ' バイト; 上限は 10MB / ' + MAX_READ_BYTES + ' バイトです）');
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_READ_BYTES) throw new Error('ファイルが大きすぎるため読み取りを拒否しました: ' + file + '（上限は 10MB です）');
  if (buf.includes(0)) throw new Error('Binary file; use system.run to inspect it');
  return buf.toString('utf8');
}
// ---- Staleness: what code.read last saw on disk, keyed by the shared readFiles set ----
const readStatsBySet = new WeakMap();
function statsMap(ctx) {
  if (!ctx || !ctx.readFiles) return null;
  let m = readStatsBySet.get(ctx.readFiles);
  if (!m) { m = new Map(); readStatsBySet.set(ctx.readFiles, m); }
  return m;
}
function recordRead(ctx, file) {
  const m = statsMap(ctx); if (!m) return;
  try { const st = fs.statSync(file); m.set(file, {mtimeMs: st.mtimeMs, size: st.size, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}); } catch { m.delete(file); }
}
function forgetRead(ctx, file) { statsMap(ctx)?.delete(file); }
function assertNotStale(ctx, file) {
  const m = statsMap(ctx); const prev = m?.get(file); if (!prev) return;
  let cur = null;
  try { const st = fs.statSync(file); cur = {mtimeMs: st.mtimeMs, size: st.size, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}; } catch { return; }
  if (cur.size !== prev.size || cur.hash !== prev.hash) throw new Error('File changed on disk since it was read（読み取り後にファイルが変更されています）: ' + file + ' — re-read it with code.read before writing/editing');
}
// Edits keep the file's own line endings; Muse always works in \n.
function eol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function toLf(text) { return text.replace(/\r\n/g, '\n'); }
function writeText(file, lf, ending) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  let mode = null; try { mode = fs.statSync(file).mode; } catch {}
  const temp = file + '.muser-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, ending === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf);
    if (mode !== null) { try { fs.chmodSync(temp, mode); } catch {} }
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    throw e;
  }
}
function clip(s, n = MAX_OUT) { return s.length > n ? s.slice(0, n / 2) + '\n… (' + (s.length - n) + ' chars omitted) …\n' + s.slice(-n / 2) : s; }

// Minimal line diff (LCS) for showing changes; inputs are bounded by the caller.
function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0; while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xm = x.slice(s, x.length - e), ym = y.slice(s, y.length - e);
  const out = [];
  if (xm.length * ym.length > 4e6) { xm.forEach((l, i) => out.push({t: '-', n: s + i + 1, l})); ym.forEach((l, i) => out.push({t: '+', n: s + i + 1, l})); }
  else {
    const L = Array.from({length: xm.length + 1}, () => new Int32Array(ym.length + 1));
    for (let i = xm.length - 1; i >= 0; i--) for (let j = ym.length - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < xm.length || j < ym.length) {
      if (i < xm.length && j < ym.length && xm[i] === ym[j]) { out.push({t: ' ', n: s + j + 1, l: ym[j]}); i++; j++; }
      // Removals before additions, as in unified diffs.
      else if (i < xm.length && (j >= ym.length || L[i + 1][j] >= L[i][j + 1])) { out.push({t: '-', n: s + i + 1, l: xm[i]}); i++; }
      else { out.push({t: '+', n: s + j + 1, l: ym[j]}); j++; }
    }
  }
  // Three lines of context around changes, like a unified diff.
  const before = x.slice(Math.max(0, s - 3), s).map((l, k) => ({t: ' ', n: Math.max(0, s - 3) + k + 1, l}));
  const after = y.slice(y.length - e, y.length - e + 3).map((l, k) => ({t: ' ', n: y.length - e + k + 1, l}));
  return [...before, ...trimContext(out), ...after];
}
function trimContext(lines) {
  const keep = lines.map((l, i) => l.t !== ' ' || lines.slice(Math.max(0, i - 3), i + 4).some(m => m.t !== ' '));
  const out = []; let gap = false;
  lines.forEach((l, i) => { if (keep[i]) { out.push(l); gap = false; } else if (!gap) { out.push({t: '…'}); gap = true; } });
  return out;
}
function stats(diff) { return {added: diff.filter(d => d.t === '+').length, removed: diff.filter(d => d.t === '-').length}; }

// ---- apply_patch (the Codex patch format) ----
function parsePatch(text) {
  const lines = toLf(text).split('\n');
  let i = lines.findIndex(l => l.trim() === '*** Begin Patch');
  if (i < 0) throw new Error('Patch must start with *** Begin Patch');
  const ops = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '*** End Patch') return ops;
    let m;
    if ((m = l.match(/^\*\*\* Add File: (.+)$/))) {
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith('+')) body.push(lines[++i].slice(1));
      ops.push({op: 'add', path: m[1].trim(), content: body.join('\n') + (body.length ? '\n' : '')});
    } else if ((m = l.match(/^\*\*\* Delete File: (.+)$/))) ops.push({op: 'delete', path: m[1].trim()});
    else if ((m = l.match(/^\*\*\* Update File: (.+)$/))) {
      const op = {op: 'update', path: m[1].trim(), hunks: []};
      if (lines[i + 1]?.startsWith('*** Move to: ')) op.moveTo = lines[++i].slice(13).trim();
      let hunk = null;
      while (i + 1 < lines.length && !lines[i + 1].startsWith('*** ')) {
        const h = lines[++i];
        if (h.startsWith('@@')) { hunk = {anchor: h.slice(2).trim(), lines: []}; op.hunks.push(hunk); continue; }
        if (!hunk) { hunk = {anchor: '', lines: []}; op.hunks.push(hunk); }
        if (h === '') hunk.lines.push(' ');
        else if (/^[ +-]/.test(h)) hunk.lines.push(h);
        else throw new Error('Bad patch line in ' + op.path + ': ' + h.slice(0, 80));
      }
      ops.push(op);
    } else if (l.trim()) throw new Error('Unexpected patch line: ' + l.slice(0, 80));
  }
  throw new Error('Patch must end with *** End Patch');
}
function findBlock(lines, block, from) {
  const eq = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()];
  for (const same of eq) for (let i = from; i + block.length <= lines.length; i++) if (block.every((b, k) => same(lines[i + k], b))) return i;
  return -1;
}
function applyHunks(text, hunks, name) {
  const lines = text.split('\n');
  let at = 0;
  for (const h of hunks) {
    if (h.anchor) { const a = findBlock(lines, [h.anchor], at); if (a >= 0) at = a; }
    const old = h.lines.filter(l => l[0] !== '+').map(l => l.slice(1)), neu = h.lines.filter(l => l[0] !== '-').map(l => l.slice(1));
    const pos = old.length ? findBlock(lines, old, at) : lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
    if (pos < 0) throw new Error('Patch context not found in ' + name + ' near: ' + (old.find(l => l.trim()) || '').slice(0, 120));
    lines.splice(pos, old.length, ...neu); at = pos + neu.length;
  }
  return lines.join('\n');
}

// ripgrep runs as a child process, never synchronously: a search over the whole home folder
// (OneDrive placeholders download when read, and Defender scans each one) once froze muser —
// the device link and the keyboard — for ten minutes. A search is stopped after RG_TIMEOUT_MS
// and reported, so Muse narrows it.
const RG_TIMEOUT_MS = 30000, RG_MAX_OUT = 32 * 1024 * 1024;
function rg(args, cwd, {timeoutMs = RG_TIMEOUT_MS} = {}) {
  return new Promise((done, fail) => {
    let child, out = '', err = '', size = 0, settled = false, timer = null;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? fail(error) : done(value); };
    try { child = spawn('rg', args, {cwd, windowsHide: true}); } catch { return finish(new Error('ripgrep (rg) is not available')); }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('検索が ' + timeoutMs / 1000 + ' 秒で終わらなかったので止めました。path や glob で範囲を絞ってください（search timed out: narrow path / glob）。'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      size += d.length;
      if (size > RG_MAX_OUT) { try { child.kill(); } catch {} return finish(null, out); }
      out += d;
    });
    child.stderr.on('data', d => { if (err.length < 4000) err += d; });
    child.on('error', () => finish(new Error('ripgrep (rg) is not available')));
    child.on('close', code => code > 1 ? finish(new Error((err || 'rg failed').slice(0, 500))) : finish(null, out));
  });
}
// Folders a search does not walk unless it is aimed inside them: OneDrive (see rg above) and,
// when searching from the home folder itself, AppData.
function heavyGlobs(root) {
  const norm = path.resolve(root).replace(/\\/g, '/').toLowerCase();
  const globs = [];
  if (!/\/onedrive[^/]*(\/|$)/.test(norm)) globs.push('!**/OneDrive*/**');
  if (norm === os.homedir().replace(/\\/g, '/').toLowerCase()) globs.push('!AppData/**');
  return globs;
}
const SENSITIVE_GLOBS = ['!**/.env', '!**/.env.*', '!**/*.pem', '!**/*.key', '!**/id_rsa*', '!**/id_ed25519*', '!**/credentials', '!**/credentials.json', '!**/secret.*', '!**/secrets.*', '!**/.secrets', '!**/.ssh/**', '!**/.aws/**', '!**/.gnupg/**', '!**/.netrc', '!**/.muser/*.enc', '!**/web.enc'];

function computeEdit(p, ctx) {
  const file = resolve(ctx, p.path);
  if (!ctx.readFiles.has(file)) throw new Error('Read the file with code.read before editing it');
  assertNotStale(ctx, file);
  const raw = readText(file), text = toLf(raw), old = toLf(String(p.old_string ?? '')), neu = toLf(String(p.new_string ?? ''));
  if (!old) throw new Error('old_string is empty');
  if (old === neu) throw new Error('old_string and new_string are the same');
  const count = text.split(old).length - 1;
  if (!count) throw new Error('old_string not found in the file (it must match exactly; re-read the file)');
  if (count > 1 && !p.replace_all) throw new Error('old_string occurs ' + count + ' times; add surrounding context to make it unique, or set replace_all');
  const after = p.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu);
  return {file, raw, text, after, count: p.replace_all ? count : 1};
}
function planPatch(p, ctx) {
  // Pre-validate EVERY file/hunk and stage the results before anything is written,
  // so any error (bad hunk, unread file, existing move destination, stale file)
  // leaves every file in the patch untouched.
  const ops = parsePatch(String(p.patch || ''));
  const dests = new Set();
  return ops.map(o => {
    const file = resolve(ctx, o.path);
    if (o.op === 'add') {
      if (fs.existsSync(file)) throw new Error(o.path + ' already exists');
      if (dests.has(file)) throw new Error(o.path + ' is written twice by this patch');
      dests.add(file);
      return {...o, file, before: '', after: o.content, ending: '\n'};
    }
    // Update / Delete must have been read first, like code.edit (Add of a new file is the only exception).
    if (!ctx.readFiles.has(file)) throw new Error('Read the file with code.read before patching it: ' + o.path);
    assertNotStale(ctx, file);
    const raw = readText(file), before = toLf(raw);
    if (o.op === 'delete') return {...o, file, before, after: ''};
    const after = applyHunks(before, o.hunks, o.path);
    const dest = o.moveTo ? resolve(ctx, o.moveTo) : file;
    if (o.moveTo) {
      if (dest !== file && fs.existsSync(dest)) throw new Error('Move destination already exists（移動先が既に存在します）: ' + o.moveTo);
      if (dest !== file && dests.has(dest)) throw new Error('Move destination is written twice by this patch: ' + o.moveTo);
    }
    dests.add(dest);
    return {...o, file, before, after, ending: eol(raw), dest};
  });
}

const TOOLS = {
  'code.read': {
    kind: 'read',
    def: {description: 'Read a text file with line numbers (cat -n style). Use offset/limit for big files. Always read a file before editing it.',
      required: {path: {type: 'string', description: 'File path, relative to the working directory or absolute.'}},
      optional: {offset: {type: 'integer', description: 'First line (1-based), default 1.'}, limit: {type: 'integer', description: 'Lines to read, default and max 2000.'}}},
    summary: p => p.path,
    run(p, ctx) {
      const file = resolve(ctx, p.path), text = toLf(readText(file)), all = text.split('\n');
      const start = Math.max(1, p.offset | 0 || 1), n = Math.min(MAX_READ_LINES, Math.max(1, p.limit | 0 || MAX_READ_LINES));
      const shown = all.slice(start - 1, start - 1 + n).map((l, i) => String(start + i).padStart(6) + '\t' + (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l));
      ctx.readFiles.add(file); recordRead(ctx, file);
      return {payload: {path: file, total_lines: all.length, content: shown.join('\n'), ...(start - 1 + n < all.length ? {next_offset: start + n} : {})}, view: {lines: shown.length}};
    },
  },
  'code.write': {
    kind: 'edit',
    def: {description: 'Create or overwrite a whole text file. Prefer code.edit or code.apply_patch for changes to existing files.',
      required: {path: {type: 'string', description: 'File path.'}, content: {type: 'string', description: 'The complete file content.'}}, optional: {}},
    summary: p => p.path,
    target: (p, ctx) => resolve(ctx, p.path),
    preview(p, ctx) { const file = resolve(ctx, p.path); if (fs.existsSync(file)) assertNotStale(ctx, file); return {diff: lineDiff(fs.existsSync(file) ? toLf(readText(file)) : '', toLf(String(p.content ?? ''))), created: !fs.existsSync(file)}; },
    run(p, ctx) {
      const file = resolve(ctx, p.path);
      if (typeof p.content !== 'string') throw new Error('content is required');
      const exists = fs.existsSync(file);
      if (exists && !ctx.readFiles.has(file)) throw new Error('Read the file with code.read before overwriting it');
      if (exists) assertNotStale(ctx, file);
      const rawBefore = exists ? readText(file) : '', before = toLf(rawBefore);
      writeText(file, toLf(p.content), exists ? eol(rawBefore) : (os.EOL === '\r\n' && /\r\n/.test(p.content) ? '\r\n' : '\n'));
      ctx.readFiles.add(file); recordRead(ctx, file);
      const diff = lineDiff(before, toLf(p.content));
      return {payload: {path: file, created: !exists, ...stats(diff)}, view: {diff, created: !exists}};
    },
  },
  'code.edit': {
    kind: 'edit',
    def: {description: 'Replace an exact string in a file. old_string must match the file exactly (indentation included) and be unique unless replace_all is true. Read the file first.',
      required: {path: {type: 'string', description: 'File path.'}, old_string: {type: 'string', description: 'Exact text to replace.'}, new_string: {type: 'string', description: 'Replacement text.'}},
      optional: {replace_all: {type: 'boolean', description: 'Replace every occurrence; default false.'}}},
    summary: p => p.path,
    target: (p, ctx) => resolve(ctx, p.path),
    preview(p, ctx) { const e = computeEdit(p, ctx); return {diff: lineDiff(e.text, e.after)}; },
    run(p, ctx) {
      const e = computeEdit(p, ctx);
      writeText(e.file, e.after, eol(e.raw)); recordRead(ctx, e.file);
      const diff = lineDiff(e.text, e.after);
      return {payload: {path: e.file, replacements: e.count, ...stats(diff)}, view: {diff}};
    },
  },
  'code.apply_patch': {
    kind: 'edit',
    def: {description: 'Apply a multi-file patch in this format:\n*** Begin Patch\n*** Update File: path\n@@ optional line to anchor near\n context line\n-removed line\n+added line\n*** Add File: path\n+new file line\n*** Delete File: path\n*** End Patch\nUpdate hunks need a few unchanged context lines (prefixed with a space). "*** Move to: newpath" may follow an Update File line.',
      required: {patch: {type: 'string', description: 'The whole patch text.'}}, optional: {}},
    summary: p => { try { return parsePatch(p.patch).map(o => o.path).join(', '); } catch { return 'patch'; } },
    preview: (p, ctx) => ({files: planPatch(p, ctx).map(c => ({path: c.dest || c.file, op: c.op, diff: lineDiff(c.before, c.after)}))}),
    target: (p, ctx) => { try { return parsePatch(p.patch).flatMap(o => [o.path, o.moveTo].filter(Boolean)).map(x => resolve(ctx, x)); } catch { return []; } },
    run(p, ctx) {
      // planPatch pre-validates and stages every change in memory first, so a bad
      // hunk (in any file) leaves all files untouched. The commit below also keeps
      // in-memory backups and rolls back if a write itself fails midway.
      const plan = planPatch(p, ctx);
      const affected = new Set();
      for (const c of plan) { affected.add(c.file); if (c.dest) affected.add(c.dest); }
      const backup = new Map();
      for (const f of affected) { try { backup.set(f, fs.readFileSync(f)); } catch { backup.set(f, null); } }
      const files = [];
      try {
        for (const c of plan) {
          if (c.op === 'delete') fs.unlinkSync(c.file);
          else { writeText(c.dest || c.file, c.after, c.ending); if (c.dest && c.dest !== c.file) fs.unlinkSync(c.file); }
          const diff = lineDiff(c.before, c.after);
          files.push({path: c.dest || c.file, op: c.op, ...stats(diff), diff});
        }
      } catch (e) {
        for (const [f, buf] of backup) { try { if (buf === null) fs.unlinkSync(f); else { fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, buf); } } catch {} }
        throw e;
      }
      for (const c of plan) {
        if (c.op === 'delete') { ctx.readFiles.delete(c.file); forgetRead(ctx, c.file); }
        else { ctx.readFiles.add(c.dest || c.file); recordRead(ctx, c.dest || c.file); if (c.dest && c.dest !== c.file) { ctx.readFiles.delete(c.file); forgetRead(ctx, c.file); } }
      }
      return {payload: {files: files.map(({diff, ...f}) => f)}, view: {files}};
    },
  },
  'code.grep': {
    kind: 'read',
    def: {description: 'Search file contents with ripgrep (regex). Respects .gitignore. Returns path:line:text, or only file paths with files_only. OneDrive folders (and AppData when searching from the home folder) are skipped unless path points inside them. Stops after 30 s: narrow path or glob.',
      required: {pattern: {type: 'string', description: 'Regular expression (ripgrep syntax).'}},
      optional: {path: {type: 'string', description: 'Directory or file to search; default the working directory.'}, glob: {type: 'string', description: 'Only files matching this glob, e.g. *.ts'},
        ignore_case: {type: 'boolean', description: 'Case-insensitive.'}, files_only: {type: 'boolean', description: 'List matching files only.'}, context: {type: 'integer', description: 'Lines of context around matches.'}}},
    summary: p => p.pattern + (p.path ? ' in ' + p.path : ''),
    async run(p, ctx) {
      if (p.path) assertNotSensitive(resolve(ctx, p.path));
      if (p.glob && isSensitivePath(String(p.glob))) assertNotSensitive(String(p.glob));
      const args = ['--no-heading', '--line-number', '--color=never', '-M', '400', '--max-columns-preview'];
      // Never let a directory search leak a sensitive file that happens to sit in it.
      // (Skipped for an explicit single file: assertNotSensitive above already vets it,
      // and an allowed file such as .env.example / id_rsa.pub must stay searchable.)
      let targetIsFile = false; try { targetIsFile = !!p.path && fs.statSync(resolve(ctx, p.path)).isFile(); } catch {}
      if (!targetIsFile) for (const g of [...SENSITIVE_GLOBS, ...heavyGlobs(p.path ? resolve(ctx, p.path) : ctx.cwd)]) args.push('-g', g);
      if (p.ignore_case) args.push('-i');
      if (p.files_only) args.push('-l');
      if (p.glob) args.push('-g', String(p.glob));
      if (p.context) args.push('-C', String(Math.min(10, p.context | 0)));
      args.push('-e', String(p.pattern), p.path ? resolve(ctx, p.path) : '.');
      const out = (await rg(args, ctx.cwd)).trimEnd(), n = out ? out.split('\n').length : 0;
      return {payload: {matches: n, output: clip(out) || '(no matches)'}, view: {count: n}};
    },
  },
  'code.glob': {
    kind: 'read',
    def: {description: 'Find files by glob pattern (e.g. src/**/*.ts). Respects .gitignore. Newest first. OneDrive folders (and AppData when searching from the home folder) are skipped unless path points inside them. Stops after 30 s: narrow path or glob.',
      required: {pattern: {type: 'string', description: 'Glob pattern.'}}, optional: {path: {type: 'string', description: 'Directory to search; default the working directory.'}}},
    summary: p => p.pattern,
    async run(p, ctx) {
      const root = p.path ? resolve(ctx, p.path) : ctx.cwd;
      assertNotSensitive(root);
      if (isSensitivePath(String(p.pattern))) assertNotSensitive(String(p.pattern));
      const raw = (await rg(['--files', '-g', String(p.pattern), ...heavyGlobs(root).flatMap(g => ['-g', g])], root)).split('\n').filter(Boolean);
      // Cap before statSync so a huge tree cannot blow up on stat calls; sensitive hits are dropped.
      const capped = raw.slice(0, MAX_GLOB_RESULTS).filter(f => !isSensitivePath(f) && !isSensitivePath(path.join(root, f)));
      const files = capped
        .map(f => { let t = 0; try { t = fs.statSync(path.join(root, f)).mtimeMs; } catch {} return [f, t]; })
        .sort((a, b) => b[1] - a[1]).map(([f]) => f);
      const truncated = raw.length > MAX_GLOB_RESULTS || files.length > 500;
      return {payload: {count: files.length, files: files.slice(0, 500), ...(truncated ? {truncated: true} : {})}, view: {count: files.length}};
    },
  },
  'system.run': {
    kind: 'exec',
    def: {description: 'Run a shell command on this Windows PC and return stdout, stderr and exit code. shell is powershell (default) or cmd. Use for builds, tests, git and anything the code tools do not cover. For dev servers, watchers and other long-running processes set background=true: it returns a shell id at once; read output with shell.output, stop with shell.kill.',
      required: {command: {type: 'string', description: 'The command.'}},
      optional: {shell: {type: 'string', description: 'powershell or cmd; default powershell.'}, cwd: {type: 'string', description: 'Working directory; default the session working directory.'}, timeout_ms: {type: 'integer', description: 'Default 120000, max 600000 (not for background).'}, background: {type: 'boolean', description: 'Keep running in the background and return immediately.'}},
      timeout_ms: 605000},
    summary: p => p.command,
    async run(p, ctx, signal, onOutput) {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new Error('command is required');
      const cwd = p.cwd ? resolve(ctx, p.cwd) : ctx.cwd, timeout = Math.min(600000, Math.max(1000, p.timeout_ms | 0 || 120000));
      if (p.background) {
        if (!ctx.shells) throw new Error('Background shells are not available here');
        const s = ctx.shells.start(p.command, {shell: p.shell, cwd});
        await new Promise(r => setTimeout(r, 1500)); // let startup errors and the first lines show
        const first = await ctx.shells.output(s.id);
        return {payload: {shell_id: s.id, pid: s.pid, ...first, hint: 'Running in the background. Use shell.output with shell_id to read more, shell.kill to stop.'}, view: {background: s.id, tail: first.output.trimEnd().split('\n').slice(-4)}};
      }
      const r = await runOnce(p.command, {shell: p.shell, cwd, timeout, signal, onOutput, maxOut: MAX_OUT, clip});
      return {payload: {exit_code: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr, MAX_OUT / 3), ...(r.killed ? {killed: r.killed} : {})}, view: {exit: r.code, killed: r.killed, tail: (r.stdout + r.stderr).trimEnd().split('\n').slice(-4)}};
    },
  },
  'shell.output': {
    kind: 'read',
    def: {description: 'Read new output of a background shell started with system.run background=true. Returns what was printed since your last read, whether it is still running, and its exit code.',
      required: {shell_id: {type: 'string', description: 'e.g. bg1'}},
      optional: {wait_s: {type: 'integer', description: 'Wait up to this many seconds (max 30) for new output.'}, since: {type: 'integer', description: 'Read from this offset (next_offset of an earlier read) instead.'}, caller: {type: 'string', description: 'Caller id for the per-caller read cursor; default main.'}}, timeout_ms: 35000},
    summary: p => p.shell_id,
    async run(p, ctx) { const r = await ctx.shells.output(p.shell_id, {since: Number.isSafeInteger(p.since) ? p.since : undefined, waitS: p.wait_s | 0, caller: p.caller || p.agent}); return {payload: r, view: {background: r.id, lines: r.output ? r.output.trimEnd().split('\n').length : 0, running: r.running}}; },
  },
  'shell.kill': {
    // kind 'edit', not 'read'/'exec': policy.decide() auto-allows 'read' everywhere (incl. plan mode and
    // read-only sub-agents), while 'exec' with no params.command is judged a read-only command and also
    // allowed in plan mode. 'edit' is denied in plan mode and asks in default mode — killing a process
    // changes state, so that is the kind that actually gates it with the existing decide() logic.
    kind: 'edit',
    def: {description: 'Stop a background shell (and its child processes).', required: {shell_id: {type: 'string', description: 'e.g. bg1'}}, optional: {}},
    summary: p => p.shell_id,
    run(p, ctx) { const r = ctx.shells.kill(p.shell_id); return {payload: r, view: {background: r.id, killed: true}}; },
  },
  'shell.list': {
    kind: 'read',
    def: {description: 'List background shells with their status.', required: {}, optional: {}},
    summary: () => '',
    run(p, ctx) { const all = ctx.shells ? ctx.shells.all() : []; return {payload: {shells: all.map(({tail, ...s}) => s)}, view: {count: all.length}}; },
  },
  'todo.write': {
    // 'read': it only updates muser's own task list on screen and touches nothing on the PC.
    // As 'edit' it asked for approval on every update in default mode and was refused in plan
    // mode and to read-only agents, while the preamble asks Muse to use it for multi-step work.
    kind: 'read',
    def: {description: 'Keep the task list for this coding session, shown to the user. Send the whole list each time. Use it for work with 3+ steps; mark exactly one item in_progress.',
      required: {todos: {type: 'string', description: 'JSON array of {"content": string, "status": "pending"|"in_progress"|"completed"}.'}}, optional: {}},
    summary: () => '',
    run(p, ctx) {
      let todos; try { todos = JSON.parse(p.todos); } catch { throw new Error('todos must be a JSON array string'); }
      if (!Array.isArray(todos)) throw new Error('todos must be a JSON array');
      ctx.todos = todos.slice(0, 50).map(t => ({content: String(t.content || '').slice(0, 300), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending'}));
      return {payload: {ok: true, count: ctx.todos.length}, view: {todos: ctx.todos}};
    },
  },
};

function commandsV2() { return Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, t.def])); }

module.exports = {TOOLS, commandsV2, lineDiff, parsePatch, applyHunks, inside, isSensitivePath};
