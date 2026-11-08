'use strict';
// Environment comparison, stage 1 (docs/design/new-features.md §10): a
// fingerprint of THIS PC only, and a diff of two fingerprints ordered by how
// likely each difference is to be the cause (tool versions first, then the
// dependency lock files, PATH, environment variables, OS settings last).
// Stage 2 (fetching a snapshot from another PC) is not built: nothing here
// connects anywhere, and a snapshot leaves this PC only as a file the user
// carries themselves.
//
// Common rules (§0): secrets are never recorded. Environment variables are
// names only, except a small allowlist whose values are safe to show; PATH
// entries have the user's profile folder replaced with %USERPROFILE%; lock
// files contribute a hash, never their contents, and a lock file whose path
// isSensitivePath is skipped whole. Snapshots muser saves itself live only
// under %LOCALAPPDATA%\muser\parity, pruned with the retention the design
// proposes for the work log (30 days, 500 MB in total, oldest first).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {t} = require('./i18n');

const SNAPSHOT_KIND = 'muser-parity';
const SNAPSHOT_VERSION = 1;
// The environment variables whose VALUES may be recorded (design: "values
// only for an allowlist such as NODE_ENV"). Everything else is a name only,
// so a variable that holds a token contributes its name and nothing else.
const ENV_VALUE_ALLOWLIST = ['NODE_ENV', 'CI', 'MUSER_LANG'];
// Dependency lock files whose hash identifies the project's dependencies.
const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'];
const RETENTION_DAYS = 30;
const RETENTION_MAX_BYTES = 500 * 1024 * 1024;
// The most PATH entries a snapshot may carry. A real PATH holds tens of
// entries; a hand-carried file with thousands is not a fingerprint but a
// payload for the PATH diff, whose move detection compares the shared
// entries pairwise. isSnapshot refuses anything past this cap.
const MAX_PATH_ENTRIES = 1000;

const dir = () => process.env.MUSER_PARITY_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser', 'parity');

// One external probe (a version line, a registry value): the command's whole
// stdout, or null when it cannot be run. Tests inject their own runner, so
// the collection flow is pinned without the real PC (design §13).
function defaultRun(file, args) {
  try {
    // .cmd shims (npm, yarn, pnpm) cannot be spawned directly on Windows
    // (EINVAL since the CVE-2024-27980 fix); they go through the shell. The
    // arguments are this module's own fixed words ('--version' and friends),
    // never user input, so the concatenation the shell does is safe here.
    if (/\.(cmd|bat)$/i.test(file)) {
      const r = spawnSync(file + ' ' + args.join(' '), {encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, shell: true});
      if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
      return r.stdout;
    }
    const r = spawnSync(file, args, {encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024});
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch { return null; }
}

// The version out of a tool's --version output: the first line's first
// dotted number ("git version 2.47.1.windows.1" -> "2.47.1.windows.1",
// "Python 3.12.7" -> "3.12.7"). Null when the output names no version.
function parseVersion(out) {
  if (typeof out !== 'string') return null;
  const line = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  if (!line) return null;
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?)/.exec(line);
  return m ? m[1] : null;
}

// Which tools a project uses, from the files at its root (design: "infer the
// tools from the project's config files and add them"). node / npm / git /
// python are always probed; the rest join when their file is there.
// Each entry: [snapshot key, executable, args].
function toolProbes(files) {
  // Marker names match case-insensitively: the snapshots live on Windows,
  // whose file system does not distinguish CARGO.TOML from Cargo.toml.
  const lowered = files.map(f => String(f).toLowerCase());
  const has = name => lowered.includes(name.toLowerCase());
  const anyExt = ext => files.some(f => f.toLowerCase().endsWith(ext));
  const probes = [
    ['node', null, []], // this process itself: no probe needed
    ['npm', 'npm.cmd', ['--version']],
    ['git', 'git', ['--version']],
    ['python', 'python', ['--version']],
  ];
  const add = (key, file, args) => { if (!probes.some(p => p[0] === key)) probes.push([key, file, args]); };
  if (has('yarn.lock')) add('yarn', 'yarn.cmd', ['--version']);
  if (has('pnpm-lock.yaml')) add('pnpm', 'pnpm.cmd', ['--version']);
  if (has('bun.lock') || has('bun.lockb')) add('bun', 'bun', ['--version']);
  if (has('deno.json') || has('deno.jsonc')) add('deno', 'deno', ['--version']);
  if (has('requirements.txt') || has('Pipfile') || has('pyproject.toml') || has('setup.py') || has('uv.lock') || has('poetry.lock')) add('pip', 'python', ['-m', 'pip', '--version']);
  if (has('Cargo.toml')) { add('rustc', 'rustc', ['--version']); add('cargo', 'cargo', ['--version']); }
  if (has('go.mod')) add('go', 'go', ['version']);
  if (has('Gemfile')) add('ruby', 'ruby', ['--version']);
  if (has('composer.json')) { add('php', 'php', ['--version']); add('composer', 'composer', ['--version']); }
  if (anyExt('.csproj') || anyExt('.fsproj') || anyExt('.vbproj') || anyExt('.sln')) add('dotnet', 'dotnet', ['--version']);
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) add('java', 'java', ['--version']);
  return probes;
}

// The package manager a package.json pins ("packageManager": "pnpm@9.1.0")
// is a tool the project uses, even with no lock file yet.
function packageManagerTool(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const m = /^(npm|yarn|pnpm|bun)@/.exec(String(pkg.packageManager || ''));
    return m ? m[1] : null;
  } catch { return null; }
}

// PATH with the user's own folder hidden: an entry under the profile becomes
// %USERPROFILE%\..., so two PCs compare by shape, not by user name. A
// C:\Users\<name> prefix is replaced the same way even when the profile
// itself lives on another drive.
function sanitizePathEntry(entry, home) {
  let e = String(entry || '').trim();
  if (!e) return '';
  const norm = s => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (home && norm(e).startsWith(norm(home))) e = '%USERPROFILE%' + e.slice(home.replace(/\/+$/, '').length);
  // Any <drive>:\Users\<name> prefix names a person's profile, so the name
  // is hidden whichever account it belongs to — restricting the wash to
  // the CURRENT home's name left the real name in the (portable) snapshot
  // whenever the process ran under a different profile, e.g. a temp home
  // (features-debug #40).
  e = e.replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '%USERPROFILE%');
  return e;
}

function collectSnapshot({cwd = process.cwd(), env = process.env, home = os.homedir(), run = defaultRun, now = new Date()} = {}) {
  // Only regular files count as markers (and as lock files): a DIRECTORY
  // named Cargo.toml or yarn.lock is not a project file and must not add
  // tools. statSync follows links, so a link to a real file still counts
  // while a link to a folder does not.
  let files = [];
  try {
    files = fs.readdirSync(cwd).filter(name => { try { return fs.statSync(path.join(cwd, name)).isFile(); } catch { return false; } });
  } catch {}
  const probes = toolProbes(files);
  const pm = packageManagerTool(cwd);
  if (pm && !probes.some(p => p[0] === pm)) probes.push([pm, pm === 'bun' ? 'bun' : pm + '.cmd', ['--version']]);
  const tools = {};
  for (const [key, file, args] of probes) tools[key] = key === 'node' ? parseVersion(process.version) : parseVersion(run(file, args));
  // OS and locale.
  const release = os.release();
  const codePageOut = run('chcp.com', []);
  const cpMatch = codePageOut ? /(\d{2,5})\s*$/.exec(String(codePageOut).trim()) || /(\d{3,5})/.exec(String(codePageOut)) : null;
  const policyOut = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy']);
  const policy = policyOut ? String(policyOut).split(/\r?\n/).map(s => s.trim()).find(Boolean) || null : null;
  const longOut = run('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled']);
  const longMatch = longOut ? /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(String(longOut)) : null;
  // Lock files: a hash and a size, never the contents (§0). A path the tools
  // call sensitive is skipped whole.
  let isSensitivePath = () => false;
  try { ({isSensitivePath} = require('./tools')); } catch {}
  const locks = [];
  for (const name of LOCK_FILES) {
    // Case-insensitive match (Windows file system), but the snapshot
    // records the file's real name as it lies on disk.
    const actual = files.find(f => f.toLowerCase() === name.toLowerCase());
    if (!actual) continue;
    const p = path.join(cwd, actual);
    if (isSensitivePath(p)) continue;
    try {
      const data = fs.readFileSync(p);
      locks.push({file: actual, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length});
    } catch {}
  }
  // Environment variables: names only, values for the allowlist alone. The
  // PATH value itself is recorded by its entries below, never raw.
  const rawPath = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : '';
  const names = Object.keys(env).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const values = {};
  for (const key of ENV_VALUE_ALLOWLIST) if (typeof env[key] === 'string') values[key] = String(env[key]).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  return {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    project: path.basename(path.resolve(cwd)),
    os: {
      platform: process.platform,
      version: os.version(),
      release,
      build: process.platform === 'win32' ? (release.split('.')[2] || null) : null,
      arch: os.arch(),
    },
    locale: {
      language: (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().locale) || null,
      codePage: cpMatch ? Number(cpMatch[1]) : null,
    },
    settings: {
      executionPolicy: /^(Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass|Undefined)$/.test(policy || '') ? policy : null,
      longPaths: longMatch ? parseInt(longMatch[1], 16) !== 0 : null,
    },
    tools,
    path: rawPath.split(';').map(e => sanitizePathEntry(e, home)).filter(Boolean),
    env: {names, values},
    locks,
  };
}

function isSnapshot(x) {
  if (!x || typeof x !== 'object' || x.kind !== SNAPSHOT_KIND || typeof x.tools !== 'object' || x.tools === null || typeof x.os !== 'object' || x.os === null || !Array.isArray(x.path) || !Array.isArray(x.locks)) return false;
  // The version and the elements are part of the shape: a newer format must
  // be refused in words (not silently diffed as 'no differences'), and a
  // malformed element must not crash the diff with a bare TypeError.
  if (x.version !== SNAPSHOT_VERSION) return false;
  // A tool's version is a string, or null when the tool could not run; any
  // other value (a number from a hand edit, an object) is not a snapshot.
  if (!Object.values(x.tools).every(v => typeof v === 'string' || v === null)) return false;
  if (x.path.length > MAX_PATH_ENTRIES) return false;
  if (!x.path.every(e => typeof e === 'string')) return false;
  if (!x.locks.every(l => !!l && typeof l === 'object' && typeof l.file === 'string' && typeof l.sha256 === 'string' && typeof l.bytes === 'number')) return false;
  // Duplicates are refused, not merged away: the diff reads locks and env
  // names through sets / first-match lookups, so a doubled entry would be
  // invisible there and two different fingerprints could diff as 'no
  // differences'. Names compare case-insensitively, as they do on the
  // Windows file system (lock files) and in the Windows environment.
  const lockNames = x.locks.map(l => l.file.toLowerCase());
  if (new Set(lockNames).size !== lockNames.length) return false;
  if (x.env !== undefined) {
    if (!x.env || typeof x.env !== 'object' || !Array.isArray(x.env.names) || !x.env.names.every(n => typeof n === 'string')) return false;
    const envNames = x.env.names.map(n => n.toLowerCase());
    if (new Set(envNames).size !== envNames.length) return false;
  }
  return true;
}

// Read a snapshot file the user carried over: parse and shape-check, with
// the refusal in words (the CLI and /parity both show them as they are).
function readSnapshotFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(t('ファイルが読めません: {file}', {file})); }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(t('スナップショットではありません（JSON として読めません）: {file}', {file})); }
  if (!isSnapshot(data)) throw new Error(t('スナップショットではありません: {file}', {file}));
  return data;
}

// The last row of the LCS length table for a against every prefix of b,
// computed with two rows only (prev/curr), never the full (n+1)x(m+1) grid
// the old code allocated: a carried snapshot may hold up to
// MAX_PATH_ENTRIES entries per side, and the grid grew with their product.
function lcsLastRow(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  let curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    [prev, curr] = [curr, prev];
  }
  return prev;
}

// The entries of one longest common order of a and b (both duplicate-free:
// they come from the PATH sets), gathered by Hirschberg's divide and
// conquer over lcsLastRow: split a in half, find the b split where the two
// halves' LCS lengths add up best, and recurse. Memory stays at two rows
// per level plus the slices, however long the PATHs are. On a tie the
// LATER split wins, which keeps A's earliest entries — the same choice the
// old full-table walk made (ties keep A's order: the entry that jumped
// ahead in B is the moved one).
function collectLcs(a, b, out) {
  if (!a.length || !b.length) return;
  if (a.length === 1) { if (b.includes(a[0])) out.add(a[0]); return; }
  if (b.length === 1) { if (a.includes(b[0])) out.add(b[0]); return; }
  const mid = a.length >> 1;
  const left = a.slice(0, mid), right = a.slice(mid);
  const fwd = lcsLastRow(left, b);
  const rev = lcsLastRow(right.slice().reverse(), b.slice().reverse());
  let split = 0, best = -1;
  for (let j = 0; j <= b.length; j++) {
    const total = fwd[j] + rev[b.length - j];
    if (total >= best) { best = total; split = j; }
  }
  collectLcs(left, b.slice(0, split), out);
  collectLcs(right, b.slice(split), out);
}

const shown = v => (v === null || v === undefined || v === '' ? t('（なし）') : String(v));
const shownBool = v => (v === null || v === undefined ? t('（不明）') : v ? t('有効') : t('無効'));

// The differences, in the design's order (§10): tool versions, then the
// lock files, PATH, environment variables, and the OS settings last.
// Each item: {category, label, a, b} with a/b already display strings.
function diffSnapshots(a, b) {
  const items = [];
  const push = (category, label, av, bv) => { if (String(av) !== String(bv)) items.push({category, label, a: String(av), b: String(bv)}); };
  for (const key of [...new Set([...Object.keys(a.tools || {}), ...Object.keys(b.tools || {})])].sort())
    push('tools', key, shown(a.tools?.[key]), shown(b.tools?.[key]));
  // Lock files match case-insensitively, as in collectSnapshot / isSnapshot
  // (the Windows file system does not distinguish them): match by folded
  // name and report with the base (a-side) spelling, so a pure case change
  // is not a difference. The hash and size still compare exactly.
  const lockOf = (s, f) => (s.locks || []).find(l => String(l.file).toLowerCase() === f);
  for (const f of [...new Set([...(a.locks || []), ...(b.locks || [])].map(l => String(l.file).toLowerCase()))].sort()) {
    const la = lockOf(a, f), lb = lockOf(b, f);
    push('locks', la ? la.file : lb.file, la ? la.sha256.slice(0, 12) + ' (' + la.bytes + ' B)' : shown(null), lb ? lb.sha256.slice(0, 12) + ' (' + lb.bytes + ' B)' : shown(null));
  }
  const pa = a.path || [], pb = b.path || [];
  // PATH entries name folders on a case-insensitive file system, so they
  // match by folded key and report with the base (a-side) spelling: a pure
  // case change is not a difference. Each entry once, by folded key (a PATH
  // often lists the same folder twice; the first one wins anyway).
  const byFold = list => { const m = new Map(); for (const e of list) { const k = String(e).toLowerCase(); if (!m.has(k)) m.set(k, e); } return m; };
  const mapA = byFold(pa), mapB = byFold(pb);
  for (const [k, e] of mapA) if (!mapB.has(k)) items.push({category: 'path', label: e, a: t('{n} 番目', {n: pa.indexOf(e) + 1}), b: shown(null)});
  for (const [k, e] of mapB) if (!mapA.has(k)) items.push({category: 'path', label: e, a: shown(null), b: t('{n} 番目', {n: pb.indexOf(e) + 1})});
  // A move is an entry whose order RELATIVE TO THE OTHER SHARED ENTRIES changed (PATH
  // order decides which executable wins). Entries that only shifted because something
  // was added or removed in front of them are not moves: the shared entries' longest
  // common order is kept, and only the ones outside it are listed.
  const oa = [...mapA.keys()].filter(k => mapB.has(k)), ob = [...mapB.keys()].filter(k => mapA.has(k));
  const kept = new Set();
  collectLcs(oa, ob, kept);
  for (const k of oa) if (!kept.has(k)) items.push({category: 'path', label: mapA.get(k), a: t('{n} 番目', {n: pa.indexOf(mapA.get(k)) + 1}), b: t('{n} 番目', {n: pb.indexOf(mapB.get(k)) + 1})});
  const ea = a.env?.names || [], eb = b.env?.names || [];
  // Environment names are case-insensitive on Windows (isSnapshot already
  // treats them so), so membership and the allowlist match by folded name;
  // labels keep the spelling of the side that has the name.
  const fold = n => String(n).toLowerCase();
  const nameA = new Set(ea.map(fold)), nameB = new Set(eb.map(fold));
  // A name whose value is compared below (the allowlist) is reported there, once.
  const valued = new Set(ENV_VALUE_ALLOWLIST.map(fold));
  for (const n of ea) if (!nameB.has(fold(n)) && !valued.has(fold(n))) items.push({category: 'env', label: n, a: t('あり'), b: shown(null)});
  for (const n of eb) if (!nameA.has(fold(n)) && !valued.has(fold(n))) items.push({category: 'env', label: n, a: shown(null), b: t('あり')});
  for (const key of ENV_VALUE_ALLOWLIST) {
    const valueOf = s => { const vals = s.env?.values || {}; const hit = Object.keys(vals).find(k => fold(k) === fold(key)); return hit === undefined ? undefined : vals[hit]; };
    const va = valueOf(a), vb = valueOf(b);
    if (va !== undefined || vb !== undefined) push('env', key, shown(va), shown(vb));
  }
  push('os', t('OS'), shown(a.os?.version), shown(b.os?.version));
  push('os', t('ビルド'), shown(a.os?.build || a.os?.release), shown(b.os?.build || b.os?.release));
  push('os', t('アーキテクチャ'), shown(a.os?.arch), shown(b.os?.arch));
  push('os', t('言語'), shown(a.locale?.language), shown(b.locale?.language));
  push('os', t('コードページ'), shown(a.locale?.codePage), shown(b.locale?.codePage));
  push('os', t('PowerShell 実行ポリシー'), shown(a.settings?.executionPolicy), shown(b.settings?.executionPolicy));
  push('os', t('長いパス'), shownBool(a.settings?.longPaths), shownBool(b.settings?.longPaths));
  return items;
}

const CATEGORY_HEADINGS = {tools: '道具の版', locks: '依存関係の固定ファイル', path: 'PATH', env: '環境変数', os: 'OS の設定'};
const CATEGORY_ORDER = ['tools', 'locks', 'path', 'env', 'os'];

// Sections for the screens (classic and fullscreen draw the same shape) and,
// flattened, for the CLI: [{heading, rows: [[label, value], ...]}].
function snapshotSections(snap, savedFile) {
  const rows = [
    [t('OS'), String(snap.os?.version || '') + (snap.os?.build ? ' (' + t('ビルド') + ' ' + snap.os.build + ')' : '')],
    [t('言語'), shown(snap.locale?.language) + ' / ' + t('コードページ') + ' ' + shown(snap.locale?.codePage)],
    [t('PowerShell 実行ポリシー'), shown(snap.settings?.executionPolicy)],
    [t('長いパス'), shownBool(snap.settings?.longPaths)],
  ];
  for (const key of Object.keys(snap.tools || {}).sort()) rows.push([key, shown(snap.tools[key])]);
  rows.push(['PATH', t('{n} 件', {n: (snap.path || []).length})]);
  rows.push([t('環境変数'), t('{n} 件（値は許可したものだけ）', {n: (snap.env?.names || []).length})]);
  for (const l of snap.locks || []) rows.push([l.file, l.sha256.slice(0, 12) + ' (' + l.bytes + ' B)']);
  if (savedFile) rows.push([t('保存先'), savedFile]);
  return [{heading: null, rows}];
}

function diffSections(items) {
  const out = [];
  for (const cat of CATEGORY_ORDER) {
    const rows = items.filter(i => i.category === cat).map(i => [i.label, i.a + ' → ' + i.b]);
    if (rows.length) out.push({heading: t(CATEGORY_HEADINGS[cat]), rows});
  }
  return out;
}

// Save under %LOCALAPPDATA%\muser\parity (this PC only), then prune with
// the retention the design proposes (§12, as the user directed): files
// older than 30 days go, then the oldest until the folder is under 500 MB.
// The file just saved is never pruned by its own save.
function saveSnapshot(snap, {baseDir = dir(), now = Date.now()} = {}) {
  fs.mkdirSync(baseDir, {recursive: true});
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  // The stamp is only millisecond-precise and the pid is shared by every
  // save in this process, so two saves in the same millisecond used to land
  // on the same name and the second silently overwrote the first. A random
  // suffix keeps each save its own file (same fix as export's saveReport).
  const suffix = crypto.randomBytes(4).toString('hex');
  const file = path.join(baseDir, 'snapshot-' + stamp + '-' + process.pid + '-' + suffix + '.json');
  // Atomic write (lore.js's writeState is the model): a uniquely named temp
  // file in the same folder, then rename over the target, so a crash
  // mid-write can never leave a truncated snapshot behind. The temp name
  // does not end in .json, so pruneSnapshots never picks it up.
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  pruneSnapshots(baseDir, {keep: file, now});
  return file;
}

function pruneSnapshots(baseDir, {keep = null, now = Date.now(), maxAgeDays = RETENTION_DAYS, maxTotalBytes = RETENTION_MAX_BYTES} = {}) {
  let files;
  try {
    files = fs.readdirSync(baseDir).filter(f => /^snapshot-.*\.json$/.test(f))
      .map(f => { const p = path.join(baseDir, f); const st = fs.statSync(p); return {p, size: st.size, mtimeMs: st.mtimeMs}; })
      .sort((x, y) => x.mtimeMs - y.mtimeMs);
  } catch { return 0; }
  let removed = 0;
  const drop = x => { try { fs.unlinkSync(x.p); removed++; return x.size; } catch { return 0; } };
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  files = files.filter(x => { if (x.p !== keep && x.mtimeMs < cutoff) { drop(x); return false; } return true; });
  let total = files.reduce((n, x) => n + x.size, 0);
  for (const x of files) {
    if (total <= maxTotalBytes) break;
    if (x.p === keep) continue;
    total -= drop(x);
  }
  return removed;
}

module.exports = {SNAPSHOT_KIND, SNAPSHOT_VERSION, ENV_VALUE_ALLOWLIST, LOCK_FILES, RETENTION_DAYS, RETENTION_MAX_BYTES, MAX_PATH_ENTRIES, dir, collectSnapshot, parseVersion, sanitizePathEntry, toolProbes, isSnapshot, readSnapshotFile, diffSnapshots, snapshotSections, diffSections, saveSnapshot, pruneSnapshots};
