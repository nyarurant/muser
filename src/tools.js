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
const {frames} = require('./tui/term');
const {t} = require('./i18n');

const MAX_READ_LINES = 2000, MAX_LINE = 2000, MAX_OUT = 60000;
const MAX_READ_BYTES = 10 * 1024 * 1024;

function resolve(ctx, p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) throw new Error('Invalid path');
  // As a shell would take them: a path in quotes ("C:\my docs\a.txt") was looked up with its
  // quotes, and ~ was a folder named "~".
  let s = p.trim();
  if (s.length > 1 && /^(["']).*\1$/.test(s)) s = s.slice(1, -1);
  if (s === '~' || /^~[\\/]/.test(s)) s = path.join(os.homedir(), s.slice(1));
  if (!s) throw new Error('Invalid path');
  // The file system's own spelling of the part that exists: Windows ignores case, but the
  // read-before-edit record compared strings, so a file read as SRC/APP.TS could not be edited as
  // src/App.ts ("read it first").
  return realOf(path.resolve(ctx.cwd, s));
}
// rg globs use '/' (a backslash escapes the next character there).
function globSlashes(g) { return String(g ?? '').replace(/\\/g, '/'); }
function inside(root, file) { const r = path.relative(root, file); return !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)); }
// ---- Sensitive-file guard (code.read / code.grep / code.glob and every read path below) ----
// muser's coding tools must never read secrets back to the model: env files, private keys,
// credential/secret files, SSH/AWS/GPG homes, .netrc, and muser's own encrypted store.
// One path segment as Windows itself resolves it: an NTFS alternate data stream suffix
// (name:stream) is not part of the file's name, and trailing dots and spaces are stripped
// by the file system, so '.ssh.' / '.ssh ' ARE '.ssh' and 'id_rsa.' IS 'id_rsa' (audit #214).
function winName(s) { return s.split(':')[0].replace(/[. ]+$/, ''); }
// A ':' in the last segment other than the drive letter itself ('C:') names an NTFS
// alternate data stream: 'notes.txt:hiddenstream' is not notes.txt, it is a second,
// hidden file riding on it. winName strips the stream off for the name rules above,
// which rightly catches 'id_rsa:stream' — but an innocent base name with a stream
// ('notes.txt:id_rsa') then passed as the plain file, so a stream component in the
// file-name segment is itself sensitive (fourth audit H2). Only the last segment is
// judged: a ':' earlier in the string is not a stream (git's 'HEAD:src/policy.js'
// rev:path tokens are checked through this same function by policy.js).
function hasStream(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last.includes(':') && !/^[a-z]:$/i.test(last);
}
// Backup copies of a secret are still the secret: id_rsa.bak, credentials.json.bak,
// .env.old, cert.pem.bak~ … (audit #215). The enumerated suffixes were only a start:
// id_rsa.bak2, credentials.json.txt and five stacked .bak suffixes all slipped past
// the list (deep audit c6 #4). So a suffix is stripped whenever it is see-through —
// a backup suffix (.bak/.old/.orig/.save/.swp/.tmp/.copy/~), a numbered variant of
// one (any suffix ending in a digit, like .bak2), or a plain-text wrapper (.txt /
// .text: the content is still the raw file, just renamed) — up to 8 deep. Any other
// suffix ENDS the chain: the outer extension defines what the file IS, so a markdown
// document about a secret is not the secret (credentials.md, logins.json.bak.md and
// src/id_util.js all stay readable), and a suffix that marks the file as public on
// purpose (.pub, .example, .sample) is never stripped past at all.
const SAFE_SUFFIXES = ['.pub', '.example', '.sample'];
function seeThrough(suffix) {
  return suffix === '~' || /^\.(bak|backup|old|orig|save|swp|tmp|copy|txt|text)$/i.test(suffix) || /\d$/.test(suffix);
}
function baseVariants(base) {
  const out = [base]; let b = base;
  for (let i = 0; i < 8; i++) {
    let stem, suffix;
    if (b.endsWith('~')) { stem = b.slice(0, -1); suffix = '~'; }
    else { const d = b.lastIndexOf('.'); if (d <= 0) break; stem = b.slice(0, d); suffix = b.slice(d); }
    if (!stem || stem === b) break;
    if (SAFE_SUFFIXES.includes(suffix.toLowerCase()) || !seeThrough(suffix)) break;
    b = stem; out.push(b);
  }
  return out;
}
// The file-name rules of isSensitivePath, for one candidate base name; `lower` is the
// (Windows-normalised, lower-cased) segment list, for the rules that pair a name with a folder.
function baseSensitive(base, lower) {
  if (base === '.netrc' || base === '_netrc') return true;
  if (base === 'web.enc') return true;
  // muser's own DPAPI files (~/.muser, %LOCALAPPDATA%\muser, the npm token in muser-release).
  if (lower.some(s => s === '.muser' || s === 'muser' || s === 'muser-release') && base.endsWith('.enc')) return true;
  // Tokens other tools keep in plain files: npm / yarn / pip, git's credential store, Codex,
  // Claude Code, GitHub CLI, Docker, kubectl.
  if (['.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.git-credentials', '.credentials.json'].includes(base)) return true;
  if (base === '.claude.json') return true; // Claude Code's OAuth store, directly in the home folder (audit #3)
  // Standard secret files of other tools: PostgreSQL, MySQL, AWS CLI (s3cmd / boto).
  if (['.pgpass', '.my.cnf', '.s3cfg', '.boto'].includes(base)) return true;
  // Codex keeps auth.json under ~/.codex — and under ~/.codex-accounts/<name>/ in the
  // multi-account layout — so any segment naming a Codex folder counts, not only the
  // exact '.codex' segment (audit #3). A plain src/auth.json stays readable.
  if (base === 'auth.json' && lower.some(s => s.includes('codex'))) return true;
  if (base === 'hosts.yml' && (lower.includes('github cli') || lower.includes('gh'))) return true;
  if (base === 'config.json' && lower.includes('.docker')) return true;
  if (base === 'config' && lower.includes('.kube')) return true;
  // kubectl's conventional KUBECONFIG names outside a .kube folder (audit wave5 B):
  // ~/kubeconfig, proj/kubeconfig.yaml. A kubeconfig_<tool>.js source file is not one.
  if (base === 'kubeconfig' || /^kubeconfig\.(ya?ml|json|toml|ini|conf|config)$/.test(base)) return true;
  // Terraform's canonical names (wave5 B): the CLI config is .terraformrc (home) or
  // terraform.rc (%APPDATA%) — the *.tfrc rule below misses both spellings — and state /
  // variable files hold plaintext secrets. *.tfstate.backup reaches *.tfstate through
  // baseVariants' see-through .backup suffix.
  if (base === '.terraformrc' || base === 'terraform.rc') return true;
  if (/\.(tfstate|tfvars)(\.json)?$/.test(base)) return true;
  // Browser credential stores (wave5 B): Chromium's 'Login Data' (passwords) and
  // 'Local State' (the DPAPI key that decrypts it) have distinctive names with a space;
  // Firefox's key4.db is the decryption key for the already-blocked logins.json, and
  // cookies.sqlite is its cookie store.
  if (/^login data($| )/.test(base) || base === 'local state') return true;
  if (base === 'key4.db' || base === 'cookies.sqlite') return true;
  // A file named plain 'Cookies' is a browser cookie store only in a browser-shaped
  // location (a Chrome/Edge 'User Data' tree, its 'Network' subfolder, a Firefox tree):
  // a project file that merely happens to be named Cookies stays readable.
  if (base === 'cookies' && lower.some(s => s === 'user data' || s === 'network' || s === 'edge' || s === 'safari' ||
    s.includes('chrome') || s.includes('chromium') || s.includes('brave') || s.includes('firefox') || s.includes('mozilla') || s.includes('opera') || s.includes('vivaldi'))) return true;
  if (base === 'wallet.dat') return true; // Bitcoin Core's wallet (wave5 B)
  // A repo's .git/config holds its remote URLs, and those URLs often embed a plain
  // access token (https://x-access-token:<PAT>@github.com/…) (deep audit c6 #3).
  if (base === 'config' && lower.includes('.git')) return true;
  // Certificate and key stores.
  if (/\.(p12|pfx|ppk|jks|keystore|kdbx)$/.test(base)) return true;
  if (/^\.env($|[^a-z])/.test(base) || base.startsWith('.env')) {
    if (/^\.env\.(example|sample)(\.|$)/.test(base) || base === '.env.example' || base === '.env.sample') return false;
    return true;
  }
  // The *.env extension form (wave5 B): app.env / prod.env / docker.env are the
  // standard env-file names for docker, systemd and python-dotenv, but the rule
  // above only sees the .env* prefix form. The bare stem 'env' counts too, so a
  // backup copy env.backup (whose .backup suffix baseVariants strips to 'env')
  // is judged by this same rule. A document about env files (app.env.md) is not
  // one: its outer suffix is not see-through, so only the full name reaches here.
  if (base === 'env' || base.endsWith('.env')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  // SSH private keys by their usual names: id_rsa, id_dsa, id_ecdsa, id_ed25519, id_xmss, …
  // (any id_<name> with no extension; the .pub half is public and stays readable).
  if (/^id_[^./]+$/.test(base) && !base.endsWith('.pub')) return true;
  if (base === 'logins.json') return true; // Firefox's saved-logins store
  // Credential files by their usual names only: a source file such as credentials_manager.js
  // or docs/secrets-handling.md is code to read, not a secret.
  if (base === 'credentials' || base === '.secrets') return true;
  if (/^credentials\.(json|ya?ml|toml|env|ini|xml|csv|tfrc\.json)$/.test(base)) return true;
  if (/\.tfrc(\.json)?$/.test(base)) return true; // Terraform's credential files (*.tfrc / *.tfrc.json)
  if (/^secrets?\.(json|ya?ml|toml|env|txt)$/.test(base)) return true;
  return false;
}
function isSensitivePath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (hasStream(p)) return true;
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean).map(winName);
  const base = (parts[parts.length - 1] || '').toLowerCase();
  const lower = parts.map(s => s.toLowerCase());
  // Whole credential-home folders: every file under .kube is cluster credentials
  // in some form (config.yaml, per-cluster files, cache), like .ssh/.aws (wave5 B:
  // .kube was previously only its exact 'config' basename).
  if (lower.some(s => s === '.ssh' || s === '.aws' || s === '.gnupg' || s === '.azure' || s === '.kube')) return true;
  // Google Cloud SDK credentials: ~/.config/gcloud on POSIX, but the Windows standard
  // layout is %APPDATA%\gcloud (parent 'Roaming') with no .config parent —
  // application_default_credentials.json and legacy_credentials\<account>\adc.json matched
  // no file-name rule and leaked (deep audit C1). A 'gcloud' segment in a credential-store
  // position (.config/gcloud, Roaming/gcloud, ~/gcloud) makes the path sensitive; a project
  // folder that merely happens to be named gcloud (work/gcloud/notes.txt, SEC5) does not.
  if (base === 'application_default_credentials.json') return true;
  const homeSegs = os.homedir().replace(/\\/g, '/').split('/').filter(Boolean).length;
  if (lower.some((s, i) => s === 'gcloud' && (lower[i - 1] === '.config' || lower[i - 1] === 'roaming' || i === homeSegs))) return true;
  // muser's own approval store, wherever it was moved to: policy.muserSettingsPath only
  // knows the two fixed roots, so a permissions.json relocated with MUSER_PERMISSIONS_FILE
  // could be rewritten through the coding tools to grant itself approvals (audit #220).
  // The store is muser's own state, never project code: the tools neither read nor write it.
  const permFile = process.env.MUSER_PERMISSIONS_FILE;
  if (permFile) {
    // A UNC admin-share spelling of the same local file (\\localhost\C$\…) resolves
    // to itself, never to the C: spelling, so the equality below missed it and the
    // relocated store could be read back through its UNC name (fourth audit M1,
    // tools.js side; policy.js's own muserSettingsPath is the policy owner's file).
    const uncDrive = s => s.replace(/^\/\/\?\/unc\/[^/]+\/([a-z])\$\//i, '$1:/').replace(/^\/\/[^/]+\/([a-z])\$\//, '$1:/');
    const normAbs = x => uncDrive(path.resolve(x).replace(/\\/g, '/').split('/').map(s => winName(s.toLowerCase())).join('/'));
    if (normAbs(p) === normAbs(permFile)) return true;
  }
  // muser's own control files in its state folders (~/.muser, %LOCALAPPDATA%\muser):
  // permissions.json maps every folder's mode (bypass included) and the remembered
  // approval keys, gui.json / server.json carry the running server's bearer token,
  // port and pid, and config.json / mcp.json describe the setup — reconnaissance
  // material that code.read handed over with no approval at all (fourth audit M4,
  // tools.js side; policy.js allowing reads in general is the policy owner's file).
  // A plain 'muser' segment is NOT enough (the project folder itself is ~/muser):
  // only the .muser folder, or AppData's Local\muser, counts as a state folder.
  if (['permissions.json', 'config.json', 'mcp.json', 'gui.json', 'server.json'].includes(base) &&
    (lower.includes('.muser') || lower.some((s, i) => s === 'muser' && lower[i - 1] === 'local'))) return true;
  return baseVariants(base).some(b => baseSensitive(b, lower));
}
// Where a path really leads: junctions and symlinks resolved on the deepest part that exists (the
// rest, not yet created, is kept as written). A junction inside the project that points at ~/.ssh
// read a private key through 's/mykey' (2026-11-01), and the same trick took writes outside the
// working folder past the "outside" check.
function realOf(p) {
  let cur = path.resolve(String(p)), rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(String(p));
    rest.unshift(path.basename(cur)); cur = up;
  }
}
// A hardlink is a second name for the same file: realpath returns the alias spelling
// unchanged, so no name or real-path check can see that 'hard-notes.txt' in the project
// IS ~/.ssh/id_rsa (fourth audit H1). The phase-1 fix refused EVERY file with more
// than one link, which broke pnpm trees (node_modules is built from hard links) and
// lied about ordinary files being secret. The follow-up rule: a linked file is
// refused only when one of its OTHER names is sensitive; when the other names
// cannot be listed at all, it is refused with an accurate message, not the secret
// one. Routing the unverifiable case through approval (ask) is not clean here:
// policy.decide() returns 'allow' for kind 'read' unconditionally, and edit
// approval happens before run() with no per-file verdict to ask about.
const HARDLINK_LIST_TIMEOUT_MS = 5000, HARDLINK_CACHE_MAX = 1000;
let hardlinkLister = null; // tests only: (file) => absolute names, or null when unlistable
const hardlinkCache = new Map();
function setHardlinkLister(fn) { hardlinkLister = typeof fn === 'function' ? fn : null; hardlinkCache.clear(); }
function clearHardlinkCache() { hardlinkCache.clear(); }
// Windows only: fsutil prints every name of the file, drive-relative
// (e.g. \Users\...\lib.js), so the volume of the queried path is prefixed.
function defaultListHardlinkNames(file) {
  if (process.platform !== 'win32') return null;
  let r;
  try { r = spawnSync('fsutil', ['hardlink', 'list', file], {encoding: 'utf8', windowsHide: true, timeout: HARDLINK_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024}); } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  const root = path.parse(file).root;
  return String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(name => path.isAbsolute(name) ? path.resolve(name) : path.resolve(root, name.replace(/^\\+/, '')));
}
function listHardlinkNames(file) {
  if (hardlinkLister) { try { const names = hardlinkLister(file); return Array.isArray(names) ? names : null; } catch { return null; } }
  return defaultListHardlinkNames(file);
}
// 'single' | 'ok' | 'sensitive' | 'unknown'. The verdict belongs to the inode, not
// to the alias asked about: from any alias, the other names are the same set minus
// itself, so a sensitive verdict for one alias holds for all of them -- and the cache
// key can be the inode, so a pnpm file met under several names is listed once.
// The key carries nlink/size/mtime too, so a link added or removed later re-lists
// instead of trusting a stale verdict. Files without a usable inode fall back to
// the resolved path in the key.
function hardlinkVerdict(file) {
  let st;
  try { st = fs.statSync(file); } catch { return 'single'; }
  if (!st.isFile() || st.nlink <= 1) return 'single';
  const key = st.ino ? [st.dev, st.ino, st.nlink, st.size, st.mtimeMs].join(':') : [path.resolve(file), st.nlink, st.size, st.mtimeMs].join(':');
  const hit = hardlinkCache.get(key);
  if (hit) return hit;
  const names = listHardlinkNames(file);
  let verdict;
  if (!names) verdict = 'unknown';
  else {
    const norm = s => process.platform === 'win32' ? s.toLowerCase() : s;
    const self = norm(path.resolve(file));
    verdict = names.map(n => path.resolve(n)).filter(n => norm(n) !== self).some(o => isSensitivePath(o) || isSensitivePath(realOf(o))) ? 'sensitive' : 'ok';
  }
  if (hardlinkCache.size >= HARDLINK_CACHE_MAX) hardlinkCache.clear();
  hardlinkCache.set(key, verdict);
  return verdict;
}
function sensitiveError(file) { return new Error(t('機密ファイルのため読み取りを拒否しました: {file}（.env・鍵・認証情報など機密ファイルは code.read / code.grep / code.glob では読み取れません）', {file})); }
function hardlinkUnknownError(file) { return new Error(t('このファイルは別の名前（ハードリンク）ともつながっていて、そのすべてを確かめられないため読めません: {file}', {file})); }
function assertNotSensitive(file) {
  if (isSensitivePath(file) || (typeof file === 'string' && file && isSensitivePath(realOf(file)))) throw sensitiveError(file);
  if (typeof file !== 'string' || !file) return;
  const verdict = hardlinkVerdict(file);
  if (verdict === 'sensitive') throw sensitiveError(file);
  if (verdict === 'unknown') throw hardlinkUnknownError(file);
}
function readBytes(file) {
  assertNotSensitive(file);
  let st; try { st = fs.statSync(file); } catch { /* let readFileSync raise the real error */ }
  if (st && st.size > MAX_READ_BYTES) throw new Error(t('ファイルが大きすぎるため読み取りを拒否しました: {file}（{size} バイト; 上限は 10MB / {max} バイトです）', {file, size: st.size, max: MAX_READ_BYTES}));
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_READ_BYTES) throw new Error(t('ファイルが大きすぎるため読み取りを拒否しました: {file}（上限は 10MB です）', {file}));
  return buf;
}
function decodeText(buf) {
  // UTF-16 with a BOM (what `>` writes in Windows PowerShell 5.1, and many Windows exports) is
  // text full of zero bytes; it was refused as binary. Writes keep the file's encoding (writeText).
  const utf16 = utf16Of(buf);
  if (utf16) return utf16;
  if (buf.includes(0)) throw new Error('Binary file; use system.run to inspect it');
  return buf.toString('utf8');
}
function readText(file) { return decodeText(readBytes(file)); }
// A UTF-8 decode that does not round-trip has replaced bytes that are not valid
// UTF-8 with U+FFFD. Writing that text back (an edit touching an unrelated line
// is enough) permanently replaces the original bytes with EF BF BD, the UTF-8
// encoding of U+FFFD — silent data destruction. Such a file is marked in the
// read state (recordRead) and code.edit / code.apply_patch refuse it; the file
// can still be read (with a warning) and rewritten whole with code.write, or
// fixed outside these tools. UTF-16 files are exempt: their decode is kept
// and restored by writeText, so an edit does not lose their bytes.
function isLossyUtf8(buf, text) {
  if (bomOf(buf)) return false;
  return !Buffer.from(text, 'utf8').equals(buf);
}
function lossyError(file) { return new Error('File contains bytes that are not valid UTF-8 (shown as � when read): ' + file + ' — code.edit / code.apply_patch are refused for this file, because writing the read text back would permanently replace those bytes with EF BF BD (the UTF-8 encoding of U+FFFD). Fix the file\'s encoding first (e.g. with system.run) and re-read it, or rewrite it whole with code.write.'); }
function assertNotLossy(ctx, file) { if (statsMap(ctx)?.get(file)?.lossy) throw lossyError(file); }
function staleError(file) { return new Error(t('File changed on disk since it was read（読み取り後にファイルが変更されています）: {file} — re-read it with code.read before writing/editing', {file})); }
function bomOf(buf) { return buf[0] === 0xff && buf[1] === 0xfe ? 'le' : buf[0] === 0xfe && buf[1] === 0xff ? 'be' : null; }
function utf16Of(buf) {
  const bom = bomOf(buf);
  if (!bom) return null;
  const body = Buffer.from(buf.subarray(2));
  if (bom === 'be') body.swap16();
  return body.toString('utf16le');
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
  // The hash is taken only up to the read cap: a file past it was never readable through
  // code.read, and hashing it whole re-read gigabytes just to remember it (audit #222).
  // An over-cap file is remembered by size/mtime only (hash null).
  try { const st = fs.statSync(file); let hash = null, lossy = false; if (st.size <= MAX_READ_BYTES) { const buf = fs.readFileSync(file); hash = crypto.createHash('sha256').update(buf).digest('hex'); try { lossy = isLossyUtf8(buf, decodeText(buf)); } catch { lossy = false; } } m.set(file, {mtimeMs: st.mtimeMs, size: st.size, hash, lossy}); } catch { m.delete(file); }
}
function forgetRead(ctx, file) { statsMap(ctx)?.delete(file); }
// A parallel agent starts from main's reads: what each file looked like goes with them, or the
// agent's code.write overwrote a change made on disk since (there was nothing to compare with).
function copyReads(from, to) {
  for (const f of from.readFiles || []) to.readFiles.add(f);
  const src = statsMap(from), dst = statsMap(to);
  if (src && dst) for (const [f, s] of src) dst.set(f, s);
}
function assertNotStale(ctx, file) {
  const m = statsMap(ctx); const prev = m?.get(file); if (!prev) return;
  let cur = null;
  try { const st = fs.statSync(file); cur = {mtimeMs: st.mtimeMs, size: st.size, hash: st.size <= MAX_READ_BYTES ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null}; } catch { return; }
  const changed = cur.size !== prev.size || (prev.hash || cur.hash ? cur.hash !== prev.hash : cur.mtimeMs !== prev.mtimeMs);
  if (changed) throw staleError(file);
}
// Read a file for an edit/write in ONE read, and check the staleness record against the
// very bytes the edit will be applied to. The check-then-read pair it replaces read the
// file twice, and a change landing between the two reads was treated as "seen": the
// staleness check passed on the first version and the edit silently applied to the
// second, never-read one (audit #222).
function readVerified(ctx, file) {
  const buf = readBytes(file);
  const prev = statsMap(ctx)?.get(file);
  if (prev && (buf.length !== prev.size || !prev.hash || crypto.createHash('sha256').update(buf).digest('hex') !== prev.hash)) throw staleError(file);
  return decodeText(buf);
}
// Edits keep the file's own line endings; Muse always works in \n.
function eol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function toLf(text) { return text.replace(/\r\n/g, '\n'); }
// A UTF-8 BOM decodes to a leading U+FEFF: that is the file's BOM, not its first
// character. Edits work on the body and writeText puts the BOM back, so an
// old_string copied from code.read (whose first shown line carries the U+FEFF)
// still matches the body, and the BOM survives an edit that replaces line 1.
function splitBom(text) { return text.startsWith('\uFEFF') ? {bom: true, body: text.slice(1)} : {bom: false, body: text}; }
// Restore each line's own ending in a mixed-ending file. The old rule (any CRLF
// in the file -> every line CRLF on write) rewrote the endings of lines the edit
// never touched. Unchanged prefix/suffix lines keep their original ending; a
// changed region paired line-for-line with the original region (same line
// count) inherits those endings too; genuinely new lines take `fallback`.
function restoreEndings(orig, lf, fallback) {
  const oParts = orig.split('\n'), nParts = lf.split('\n');
  const oEnds = oParts.map((p, i) => i === oParts.length - 1 ? '' : p.endsWith('\r') ? '\r\n' : '\n');
  const oText = oParts.map(p => p.endsWith('\r') ? p.slice(0, -1) : p);
  let pre = 0;
  while (pre < oText.length && pre < nParts.length && oText[pre] === nParts[pre]) pre++;
  let suf = 0;
  while (suf < oText.length - pre && suf < nParts.length - pre && oText[oText.length - 1 - suf] === nParts[nParts.length - 1 - suf]) suf++;
  const paired = oText.length - pre - suf === nParts.length - pre - suf;
  const fb = fallback === '\r\n' ? '\r\n' : '\n';
  return nParts.map((p, i) => {
    if (i === nParts.length - 1) return p; // the last part carries no terminator of its own
    let end;
    if (i < pre) end = oEnds[i];
    else if (i >= nParts.length - suf) end = oEnds[i - (nParts.length - oParts.length)];
    else if (paired) end = oEnds[i];
    else end = fb;
    return p + end;
  }).join('');
}
// Writes get the same ceiling as reads (audit #217): an unbounded content filled the
// disk or blew up the diff's memory. Checked before any diff is computed, and again in
// writeText as the backstop for every write path.
function checkWriteSize(text) {
  const n = Buffer.byteLength(String(text ?? ''), 'utf8');
  if (n > MAX_READ_BYTES) throw new Error('Content too large to write (' + n + ' bytes; the limit is ' + MAX_READ_BYTES + ' bytes, the same as the read limit)');
}
function writeText(file, lf, ending) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  let mode = null, size = null; try { const st = fs.statSync(file); mode = st.mode; size = st.size; } catch {}
  const temp = file + '.muser-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  // An existing UTF-16 file stays UTF-16 (with its BOM); everything else is written as UTF-8.
  let bom = null, utf8Bom = false; try { const fd = fs.openSync(file, 'r'), head = Buffer.alloc(3); const n = fs.readSync(fd, head, 0, 3, 0); fs.closeSync(fd); bom = bomOf(head); utf8Bom = n >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf; } catch {}
  // The BOM is not body text: a leading U+FEFF in the new text is the BOM marker,
  // held aside here and put back below (the UTF-16 branch re-adds its own BOM
  // bytes), so a file that had a UTF-8 BOM keeps it even when the edit consumed
  // the marker, and no path writes it twice.
  const split = splitBom(String(lf ?? ''));
  // An existing file's own line endings win, line by line (restoreEndings);
  // `ending` is only the fallback for new lines — and for new files, where it
  // keeps the old whole-file conversion.
  let orig = null; try { if (size !== null && size <= MAX_READ_BYTES) orig = decodeText(fs.readFileSync(file)); } catch {}
  let text = orig !== null ? restoreEndings(splitBom(orig).body, split.body, ending) : ending === '\r\n' ? split.body.replace(/\n/g, '\r\n') : split.body;
  if (!bom && (utf8Bom || split.bom)) text = '\uFEFF' + text;
  let data = text;
  if (bom) { const body = Buffer.from(text, 'utf16le'); if (bom === 'be') body.swap16(); data = Buffer.concat([Buffer.from(bom === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), body]); }
  const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8');
  if (bytes > MAX_READ_BYTES) throw new Error('File too large to write: ' + file + ' (' + bytes + ' bytes; the limit is ' + MAX_READ_BYTES + ' bytes, the same as the read limit)');
  try {
    fs.writeFileSync(temp, data);
    if (mode !== null) { try { fs.chmodSync(temp, mode); } catch {} }
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    throw e;
  }
}
function clip(s, n = MAX_OUT) { return s.length > n ? s.slice(0, n / 2) + '\n… (' + (s.length - n) + ' chars omitted) …\n' + s.slice(-n / 2) : s; }
// Cut a line for display at MAX_LINE without splitting a surrogate pair: a
// plain slice(0, MAX_LINE) can end on a high surrogate whose low half was cut
// away, handing the model a lone surrogate.
function cutLine(s) {
  if (s.length <= MAX_LINE) return s;
  let n = MAX_LINE;
  const hi = s.charCodeAt(n - 1), lo = s.charCodeAt(n);
  if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) n--;
  return s.slice(0, n) + '…';
}

// Total -/+ lines the all-removed/all-added fallback below may emit before
// it switches to a summary entry: on two large, wholly different files the
// fallback used to materialise every line of both sides (hundreds of
// thousands of entries) into the view, the history and the work log.
const DIFF_FALLBACK_MAX = 10000;
// Minimal line diff (LCS) for showing changes; inputs are bounded by the caller.
function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0; while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xm = x.slice(s, x.length - e), ym = y.slice(s, y.length - e);
  const out = [];
  if (xm.length * ym.length > 4e6) {
    if (xm.length + ym.length <= DIFF_FALLBACK_MAX) { xm.forEach((l, i) => out.push({t: '-', n: s + i + 1, l})); ym.forEach((l, i) => out.push({t: '+', n: s + i + 1, l})); }
    else {
      // Summary form: a head sample of each side plus one '…' entry that
      // carries the omitted counts (stats() and slim-call add them back in,
      // so the + / - totals stay true even though the lines are not shown).
      let kx = Math.min(xm.length, Math.floor(DIFF_FALLBACK_MAX / 2));
      const ky = Math.min(ym.length, DIFF_FALLBACK_MAX - kx);
      kx = Math.min(xm.length, DIFF_FALLBACK_MAX - ky);
      xm.slice(0, kx).forEach((l, i) => out.push({t: '-', n: s + i + 1, l}));
      ym.slice(0, ky).forEach((l, i) => out.push({t: '+', n: s + i + 1, l}));
      const remOmitted = xm.length - kx, addOmitted = ym.length - ky;
      out.push({t: '…', removed: remOmitted, added: addOmitted, l: '… (' + remOmitted + ' removed and ' + addOmitted + ' added lines omitted: the changed region is too large to show line by line)'});
    }
  }
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
  // Every line the diff carries — context lines included — is cut at
  // MAX_LINE (cutLine appends '…', so the cut is visible): the line COUNT
  // was capped elsewhere, but one 5MB line otherwise stayed whole in the
  // view, the slimmed history and the outputs store. slim-call cuts again
  // on its side, for diffs that did not come through here.
  return [...before, ...trimContext(out), ...after].map(d => d && typeof d.l === 'string' ? {...d, l: cutLine(d.l)} : d);
}
function trimContext(lines) {
  const keep = lines.map((l, i) => l.t !== ' ' || lines.slice(Math.max(0, i - 3), i + 4).some(m => m.t !== ' '));
  const out = []; let gap = false;
  lines.forEach((l, i) => { if (keep[i]) { out.push(l); gap = false; } else if (!gap) { out.push({t: '…'}); gap = true; } });
  return out;
}
function stats(diff) {
  let added = 0, removed = 0;
  for (const d of diff) {
    if (d.t === '+') added++;
    else if (d.t === '-') removed++;
    // A lineDiff summary entry ('…', from the fallback cap) carries the counts
    // of the lines it stands for; a trimContext gap marker carries none.
    else if (d.t === '…') { if (Number.isFinite(d.added)) added += d.added; if (Number.isFinite(d.removed)) removed += d.removed; }
  }
  return {added, removed};
}

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
    // An @@ anchor that matches nothing must not be silently ignored: the hunk then
    // applied wherever its context first fit, which may be another function entirely
    // (audit #216).
    let anchorAt = -1;
    if (h.anchor) { const a = findBlock(lines, [h.anchor], at); if (a < 0) throw new Error('Patch anchor not found in ' + name + ': ' + h.anchor.slice(0, 120)); at = a; anchorAt = a; }
    const old = h.lines.filter(l => l[0] !== '+').map(l => l.slice(1)), neu = h.lines.filter(l => l[0] !== '-').map(l => l.slice(1));
    // A pure-addition hunk (no context or removal lines) used to ignore the anchor
    // it had just verified and append at the end of the file, so '@@ function a() {'
    // followed by only '+' lines landed after the LAST function instead (deep audit
    // c6 #6). With an anchor, the new lines go right after the anchor line; without
    // one they still append at the end, as before.
    // A pure-addition hunk has no context to check for uniqueness (the check
    // below needs old lines), so a duplicated anchor silently picked the first
    // match and inserted there. The anchor is the only position information an
    // add-only hunk has: when it fits more than one place, refuse, as a
    // non-unique context is refused below.
    if (!old.length && anchorAt >= 0 && findBlock(lines, [h.anchor], anchorAt + 1) >= 0) throw new Error('Patch anchor in ' + name + ' fits more than one place: ' + h.anchor.slice(0, 80) + '; use a more specific @@ anchor line');
    const pos = old.length ? findBlock(lines, old, at) : anchorAt >= 0 ? anchorAt + 1 : lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
    if (pos < 0) throw new Error('Patch context not found in ' + name + ' near: ' + (old.find(l => l.trim()) || '').slice(0, 120));
    // A context that fits more than one place was applied at the first one, silently, as code.edit
    // refuses a non-unique old_string. It must fit one place only — an @@ anchor narrows
    // where the search starts, it does not waive the uniqueness check (audit #216).
    if (old.length && findBlock(lines, old, pos + 1) >= 0) throw new Error('Patch context in ' + name + ' fits more than one place (near: ' + (old.find(l => l.trim()) || '').slice(0, 80) + '); add more unchanged lines around the change, or an @@ line naming the function or section');
    lines.splice(pos, old.length, ...neu); at = pos + neu.length;
  }
  return lines.join('\n');
}

// UTF-8 text read as Shift-JIS/CP932 and saved again (Windows PowerShell 5.1's default) is full of
// kanji that real text hardly uses (the code points below: from kana, from — … ' ", from arrows and
// ⏺, from 日本語). They are not written out here, or reading this file would trip the check. Reads and
// writes that show them carry a warning, so Muse notices a mangled file instead of shipping it.
const MOJIBAKE = /[\u7e3a\u7e67\u7e5d\u7ab6\u7aca\u7ae2\u8b4c\u8b5b\u96b1]/g;
function encodingWarning(text) {
  return (String(text || '').match(MOJIBAKE) || []).length >= 2
    ? {warning: 'This text looks double-encoded (UTF-8 read as Shift-JIS/CP932: e.g. "' + String.fromCharCode(0x7ab6, 0x30fb) + '" for an em dash, "' + String.fromCharCode(0x8b4c, 0xff65, 0x8b5b, 0xff6c, 0x96b1, 0x30fb) + '" for the word Japanese written in kanji). Fix the file before going on; write files with code.write / code.edit, not PowerShell.'}
    : {};
}
// Same warning slot as encodingWarning, for a file whose bytes are not valid
// UTF-8 (isLossyUtf8): the read shows those bytes as U+FFFD and the originals
// cannot be recovered from the text, so edit/patch refuse the file outright.
function invalidUtf8Warning() {
  return {warning: 'This file contains bytes that are not valid UTF-8; they are shown as \uFFFD and the original bytes cannot be recovered from this text. code.edit / code.apply_patch are refused for this file: writing the read text back would permanently replace those bytes with EF BF BD. Fix the encoding first (e.g. with system.run), or rewrite the file whole with code.write.'};
}

// ripgrep runs as a child process, never synchronously: a search over the whole home folder
// (OneDrive placeholders download when read, and Defender scans each one) once froze muser —
// the device link and the keyboard — for ten minutes. A search is stopped after RG_TIMEOUT_MS
// and reported, so Muse narrows it.
const RG_TIMEOUT_MS = 30000, RG_MAX_OUT = 32 * 1024 * 1024;
// Resolves {text, truncated}: when the output passes RG_MAX_OUT the child is
// killed and `text` is only the part that arrived, so callers must say the
// result was cut (truncated) and treat any count from it as a lower bound —
// the partial buffer used to be returned as if it were the whole output, so
// code.grep reported that partial count as the true number of matches.
function rg(args, cwd, {timeoutMs = RG_TIMEOUT_MS} = {}) {
  return new Promise((done, fail) => {
    let child, out = '', err = '', size = 0, settled = false, timer = null;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? fail(error) : done(value); };
    // A spawn failure (a cwd too long for the OS, a missing rg, ...) is a
    // worded error the caller can show, never an unhandled 'error' event:
    // the child AND each of its stdio streams can emit one, and a stream
    // 'error' with no listener took the whole process down.
    const spawnError = e => new Error('ripgrep (rg) could not run: ' + (e && e.message ? e.message : String(e || 'unknown error')).slice(0, 300));
    try { child = spawn('rg', args, {cwd, windowsHide: true}); } catch (e) { return finish(spawnError(e)); }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error(t('検索が {seconds} 秒で終わらなかったので止めました。path や glob で範囲を絞ってください（search timed out: narrow path / glob）。', {seconds: timeoutMs / 1000})));
    }, timeoutMs);
    child.on('error', e => finish(spawnError(e)));
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (!stream || typeof stream.on !== 'function') continue;
      stream.on('error', e => finish(spawnError(e)));
    }
    if (!child.stdout || !child.stderr) return finish(spawnError(new Error('rg stdio is not available')));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      size += d.length;
      if (size > RG_MAX_OUT) { try { child.kill(); } catch {} return finish(null, {text: out, truncated: true}); }
      out += d;
    });
    child.stderr.on('data', d => { if (err.length < 4000) err += d; });
    child.on('close', code => code > 1 ? finish(new Error((err || 'rg failed').slice(0, 500))) : finish(null, {text: out, truncated: false}));
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
// NOTE: there is deliberately no '!**/.env.*' here (wave5 B): it also hid the
// intentionally readable .env.example/.env.sample from directory grep, and rg globs
// have no exception syntax — a positive '**/.env.example' glob would switch rg to
// allowlist mode and hide everything else. The .env.* files are instead dropped by
// the canonical dropSensitiveLines post-filter through isSensitivePath below.
const SENSITIVE_GLOBS = ['!**/.env', '!**/.envrc', '!**/*.pem', '!**/*.key', '!**/id_*', '!**/credentials', '!**/credentials.*', '!**/logins.json', '!**/secret.*', '!**/secrets.*', '!**/.secrets', '!**/.ssh/**', '!**/.aws/**', '!**/.gnupg/**', '!**/.azure/**', '!**/.config/gcloud/**', '!**/Roaming/gcloud/**', '!**/application_default_credentials.json', '!**/.netrc', '!**/.muser/*.enc', '!**/web.enc', '!**/muser/*.enc', '!**/muser-release/*.enc', '!**/.npmrc', '!**/.yarnrc', '!**/.yarnrc.yml', '!**/.pypirc', '!**/.git-credentials', '!**/.credentials.json', '!**/.codex/auth.json', '!**/*codex*/auth.json', '!**/.claude.json', '!**/.pgpass', '!**/.my.cnf', '!**/.s3cfg', '!**/.boto', '!**/*.tfrc', '!**/*.tfrc.json', '!**/gh/hosts.yml', '!**/.docker/config.json', '!**/.kube/config', '!**/.git/config', '!**/*.p12', '!**/*.pfx', '!**/*.ppk', '!**/*.jks', '!**/*.keystore', '!**/*.kdbx',
  '!**/.muser/permissions.json', '!**/.muser/config.json', '!**/.muser/mcp.json', '!**/.muser/gui.json', '!**/.muser/server.json',
  '!**/Local/muser/permissions.json', '!**/Local/muser/config.json', '!**/Local/muser/mcp.json', '!**/Local/muser/gui.json', '!**/Local/muser/server.json',
  // Wave5 B additions, mirroring isSensitivePath (the post-filter below is still canonical):
  '!**/*.env', '!**/env.backup', '!**/.terraformrc', '!**/terraform.rc', '!**/*.tfstate', '!**/*.tfstate.backup', '!**/*.tfvars', '!**/.kube/**', '!**/kubeconfig', '!**/kubeconfig.yaml', '!**/kubeconfig.yml', '!**/kubeconfig.json',
  '!**/Login Data', '!**/Login Data *', '!**/Local State', '!**/key4.db', '!**/cookies.sqlite', '!**/wallet.dat', '!**/User Data/**/Cookies', '!**/Network/Cookies'];

// The path an rg output line names, or null when the line carries none (a context
// separator, or a hit in the single explicit file target, which was already vetted).
// Hit lines are path:12:text, context lines path-12-text, files_only lines are the path.
function grepLinePath(line, filesOnly) {
  if (filesOnly) return line || null;
  const bin = /^Binary file (.+) matches$/.exec(line); if (bin) return bin[1];
  const m = /[:-]\d+[:-]/.exec(line);
  if (!m) return null;
  const named = line.slice(0, m.index);
  // A hit in the single explicit file target is printed as '12:text' (context as
  // '12-text') with NO path — that file was already vetted by the caller. When
  // such a line's text itself contains a ':30:'-like sequence (a time, as in
  // '1:meet at 10:30:00'), the first match lands inside the text and the slice
  // before it ('1:meet at 10') is hit text, not a path. A real path never starts
  // with '<digits>:' (a drive letter is a letter), so that slice names nothing.
  if (/^\d+:/.test(named)) return null;
  return named;
}
// The -g exclusions above are a first pass only: they are a hand-kept copy of
// isSensitivePath and the two diverged (.envrc, id_ecdsa, credentials.yaml all
// leaked). The output is therefore filtered again through the one canonical
// check — a line naming a sensitive path (as written, resolved, or through a
// junction) is dropped, text and all.
function dropSensitiveLines(lines, ctx, filesOnly) {
  // The verdict for a path is memoised for the whole result: the filter used to
  // re-run realpath (and a stat, inside hardlinkVerdict) for EVERY hit line, so a
  // file with 50,000 hits paid 50,000 realpaths and a broad search spent seconds
  // filtering lines that clip() then threw away (deep audit c6 #8, fourth audit
  // M11 — the same defect in both reports). One verdict per distinct path prefix
  // is enough: every line naming the same file gets the same answer.
  const cache = new Map();
  const sensitive = named => {
    const hit = cache.get(named);
    if (hit !== undefined) return hit;
    let verdict;
    if (isSensitivePath(named)) verdict = true;
    else {
      const abs = path.resolve(ctx.cwd, named);
      // A hardlinked hit is an alias of some other file: its line is dropped when
      // one of its other names is sensitive, or when the other names cannot be
      // listed at all (fail closed; an explicit read of the same file reports the
      // accurate hardlink message instead of dropping silently).
      const hv = hardlinkVerdict(abs);
      verdict = hv === 'sensitive' || hv === 'unknown' ? true : isSensitivePath(abs) || isSensitivePath(realOf(abs));
    }
    if (cache.size > 10000) cache.clear();
    cache.set(named, verdict);
    return verdict;
  };
  return lines.filter(line => {
    const named = grepLinePath(line, filesOnly);
    if (!named) return true;
    if (sensitive(named)) return false;
    if (filesOnly || line.startsWith('Binary file ')) return true;
    // Later '[:-]12[:-]' matches in the line are normally hit TEXT (a time, as
    // in 'a.txt:2:meet at 10:30:00 …'): the slice before them spans the whole
    // 'file:line:' prefix, so it is not a path — the old fail-closed check of
    // every such slice dropped ordinary lines wholesale, because the slice
    // 'a.txt:2:meet at 10' trips the alternate-data-stream rule on its ':'.
    // A later slice still counts as a path candidate while it stays
    // path-shaped — no ':' past a drive letter (a Windows path has none; the
    // ':' of ':2:' is the line-number separator, already consumed) — which
    // keeps catching a sensitive path whose own name holds a '-12-' segment
    // before the line number ('x-1-y/.ssh/id_rsa:5:…').
    const later = [...line.matchAll(/[:-]\d+[:-]/g)].slice(1).map(m => line.slice(0, m.index))
      .filter(cand => { const rest = /^[a-z]:/i.test(cand) ? cand.slice(2) : cand; return !rest.includes(':'); });
    return !later.some(sensitive);
  });
}

function computeEdit(p, ctx) {
  const file = resolve(ctx, p.path);
  if (!ctx.readFiles.has(file)) throw new Error('Read the file with code.read before editing it');
  const raw = readVerified(ctx, file);
  assertNotLossy(ctx, file);
  // The file's BOM (a leading U+FEFF) is not body text: matching runs on the
  // body, and a leading U+FEFF on old/new (copied from code.read's first line)
  // is the marker, not a character to find or write — writeText restores the
  // BOM on the way out, so replacing line 1 no longer deletes it.
  const bomSplit = splitBom(raw), text = toLf(bomSplit.body);
  const strip = s => bomSplit.bom && s.startsWith('\uFEFF') ? s.slice(1) : s;
  const old = toLf(strip(String(p.old_string ?? ''))), neu = toLf(strip(String(p.new_string ?? '')));
  checkWriteSize(neu);
  if (!old) throw new Error('old_string is empty');
  if (old === neu) throw new Error('old_string and new_string are the same');
  const count = text.split(old).length - 1;
  if (!count) throw new Error('old_string not found in the file (it must match exactly; re-read the file)');
  if (count > 1 && !p.replace_all) throw new Error('old_string occurs ' + count + ' times; add surrounding context to make it unique, or set replace_all');
  const after = p.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu);
  checkWriteSize(after);
  return {file, raw, text, after, count: p.replace_all ? count : 1};
}
// The identity of a patch destination, as the file system sees it: on Windows,
// 'NewFile.txt', 'newfile.txt' and 'newfile.txt.' are ONE file, but the string sets
// in planPatch treated them as three — two Adds in one patch both passed, and the
// second commit silently overwrote the first (deep audit c6 #5, the case/trailing-
// dot bypass of the #212 fix). realOf can only canonicalise the part that exists,
// so a not-yet-created name keeps its written spelling and needs this key instead.
function destKey(file) {
  return process.platform === 'win32' ? file.replace(/\\/g, '/').split('/').map(s => winName(s).toLowerCase()).join('/') : file;
}
function planPatch(p, ctx) {
  // Pre-validate EVERY file/hunk and stage the results before anything is written,
  // so any error (bad hunk, unread file, existing move destination, stale file)
  // leaves every file in the patch untouched.
  const ops = parsePatch(String(p.patch || ''));
  const dests = new Set(), seen = new Set();
  return ops.map(o => {
    const file = resolve(ctx, o.path);
    // One file, one operation per patch (audit #212): two operations on the same file
    // were both planned against the original content and the later write silently
    // discarded the earlier one's result at commit time.
    if (seen.has(destKey(file)) || dests.has(destKey(file))) throw new Error(o.path + ' is written twice by this patch; combine its changes into a single operation for that file');
    if (o.op === 'add') {
      // Creation is a write path too: a still-missing sensitive file must not be
      // creatable just because no read ever vetted it (deep audit H2).
      assertNotSensitive(file);
      checkWriteSize(o.content);
      if (fs.existsSync(file)) throw new Error(o.path + ' already exists');
      dests.add(destKey(file));
      return {...o, file, before: '', after: o.content, ending: '\n'};
    }
    // Update / Delete must have been read first, like code.edit (Add of a new file is the only exception).
    if (!ctx.readFiles.has(file)) throw new Error('Read the file with code.read before patching it: ' + o.path);
    seen.add(destKey(file));
    const raw = readVerified(ctx, file); assertNotLossy(ctx, file);
    const before = toLf(raw);
    if (o.op === 'delete') return {...o, file, before, after: ''};
    const after = applyHunks(before, o.hunks, o.path);
    checkWriteSize(after);
    let dest = o.moveTo ? resolve(ctx, o.moveTo) : file;
    // A move whose destination is the same file under another spelling (a case-only
    // rename) is an in-place update, not a move onto an existing file.
    if (o.moveTo && destKey(dest) === destKey(file)) dest = file;
    if (o.moveTo) {
      if (dest !== file) assertNotSensitive(dest); // the move destination is a creation path (deep audit H2)
      if (dest !== file && fs.existsSync(dest)) throw new Error(t('Move destination already exists（移動先が既に存在します）: {path}', {path: o.moveTo}));
      if (dest !== file && (dests.has(destKey(dest)) || seen.has(destKey(dest)))) throw new Error('Move destination is written twice by this patch: ' + o.moveTo);
    }
    dests.add(destKey(dest));
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
      const file = resolve(ctx, p.path), text = toLf(readText(file));
      // The final newline ends the last line; it does not start another ("a\nb\n" read as 3 lines
      // with an empty line 3, and an empty file as 1 line).
      const all = text === '' ? [] : text.split('\n'); if (all.length > 1 && all[all.length - 1] === '') all.pop();
      const start = Math.max(1, p.offset | 0 || 1), n = Math.min(MAX_READ_LINES, Math.max(1, p.limit | 0 || MAX_READ_LINES));
      const slice = all.slice(start - 1, start - 1 + n);
      // The window is also bounded by characters, like every other tool's output
      // (audit #218): 2,000 lines x 2,000 characters was ~4M characters in one reply,
      // ~65x the MAX_OUT the exec/grep outputs are clipped to. Lines stop at the
      // budget and next_offset points at the first line not shown, so paging through
      // with offset reads the rest exactly where this stopped.
      const shown = []; let used = 0;
      for (let i = 0; i < slice.length; i++) {
        const line = String(start + i).padStart(6) + '\t' + cutLine(slice[i]);
        if (shown.length && used + line.length + 1 > MAX_OUT) break;
        shown.push(line); used += line.length + 1;
      }
      ctx.readFiles.add(file); recordRead(ctx, file);
      // Cut lines were marked with one "…" and nothing said how to read the rest (offset counts
      // lines, so a minified line could not be read past 2,000 characters).
      const cut = slice.slice(0, shown.length).map((l, i) => l.length > MAX_LINE ? start + i : 0).filter(Boolean);
      const longNote = cut.length ? {long_lines: cut.slice(0, 20), note: cut.length + ' line(s) longer than ' + MAX_LINE + ' characters are cut here (ending in …). To see one whole, use system.run, e.g. (Get-Content -LiteralPath <file>)[<line - 1>].Substring(<from>, 4000), or code.grep with a pattern from it.'} : {};
      const shownEnd = start - 1 + shown.length;
      return {payload: {path: file, total_lines: all.length, content: shown.join('\n'), ...(shownEnd < all.length ? {next_offset: start + shown.length} : {}), ...(shown.length < slice.length ? {truncated: true} : {}), ...longNote, ...(statsMap(ctx)?.get(file)?.lossy ? invalidUtf8Warning() : encodingWarning(text))}, view: {lines: shown.length}};
    },
  },
  'code.write': {
    kind: 'edit',
    def: {description: 'Create or overwrite a whole text file. Prefer code.edit or code.apply_patch for changes to existing files.',
      required: {path: {type: 'string', description: 'File path.'}, content: {type: 'string', description: 'The complete file content.'}}, optional: {}},
    summary: p => p.path,
    target: (p, ctx) => resolve(ctx, p.path),
    preview(p, ctx) { const file = resolve(ctx, p.path); assertNotSensitive(file); checkWriteSize(p.content ?? ''); const exists = fs.existsSync(file); return {diff: lineDiff(exists ? toLf(readVerified(ctx, file)) : '', toLf(String(p.content ?? ''))), created: !exists}; },
    run(p, ctx) {
      const file = resolve(ctx, p.path);
      // A new sensitive file (one that does not exist yet, so no read ever vetted it)
      // must not be creatable through code.write either (deep audit H2).
      assertNotSensitive(file);
      if (typeof p.content !== 'string') throw new Error('content is required');
      checkWriteSize(p.content);
      const exists = fs.existsSync(file);
      if (exists && !ctx.readFiles.has(file)) throw new Error('Read the file with code.read before overwriting it');
      const rawBefore = exists ? readVerified(ctx, file) : '', before = toLf(rawBefore);
      writeText(file, toLf(p.content), exists ? eol(rawBefore) : (os.EOL === '\r\n' && /\r\n/.test(p.content) ? '\r\n' : '\n'));
      ctx.readFiles.add(file); recordRead(ctx, file);
      const diff = lineDiff(before, toLf(p.content));
      // edits: the before/after texts this run already held, for the work
      // log's edit event (src/worklog.js). Internal — agent.js forwards it
      // non-enumerably, so it reaches neither the screen nor Muse.
      return {payload: {path: file, created: !exists, ...stats(diff), ...encodingWarning(p.content)}, view: {diff, created: !exists}, edits: [{file, op: exists ? 'write' : 'create', before, after: toLf(p.content)}]};
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
      return {payload: {path: e.file, replacements: e.count, ...stats(diff), ...encodingWarning(e.after)}, view: {diff}, edits: [{file: e.file, op: 'edit', before: e.text, after: e.after}]};
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
      return {payload: {files: files.map(({diff, ...f}) => f), ...encodingWarning(plan.map(c => c.after || '').join('\n'))}, view: {files}, edits: plan.map(c => ({file: c.dest || c.file, op: c.op, before: c.before, after: c.after}))};
    },
  },
  'code.grep': {
    kind: 'read',
    def: {description: 'Search file contents with ripgrep (regex). Respects .gitignore. Hidden files and folders are searched too (except .git internals and sensitive files). Returns path:line:text, or only file paths with files_only. OneDrive folders (and AppData when searching from the home folder) are skipped unless path points inside them. Stops after 30 s: narrow path or glob.',
      required: {pattern: {type: 'string', description: 'Regular expression (ripgrep syntax).'}},
      optional: {path: {type: 'string', description: 'Directory or file to search; default the working directory.'}, glob: {type: 'string', description: 'Only files matching this glob, e.g. *.ts'},
        ignore_case: {type: 'boolean', description: 'Case-insensitive.'}, files_only: {type: 'boolean', description: 'List matching files only.'}, context: {type: 'integer', description: 'Lines of context around matches.'}}},
    summary: p => p.pattern + (p.path ? ' in ' + p.path : ''),
    async run(p, ctx) {
      if (p.path) assertNotSensitive(resolve(ctx, p.path));
      if (p.glob && isSensitivePath(String(p.glob))) assertNotSensitive(String(p.glob));
      // --hidden: without it, rg's default made dot-folders and dot-files silently
      // invisible from a search rooted above them — .github/workflows, .husky and
      // .config never matched, and "no hits" read as "not there" (deep audit c6 #7).
      // The sensitive-file boundary does not depend on rg's defaults: the -g
      // exclusions below are the first pass and dropSensitiveLines re-filters every
      // returned line through isSensitivePath. .git is excluded outright (rg
      // --hidden DOES walk it): its internals are not project text.
      const args = ['--hidden', '--no-heading', '--line-number', '--color=never', '-M', '400', '--max-columns-preview'];
      // Never let a directory search leak a sensitive file that happens to sit in it.
      // (Skipped for an explicit single file: assertNotSensitive above already vets it,
      // and an allowed file such as .env.example / id_rsa.pub must stay searchable.)
      let targetIsFile = false; try { targetIsFile = !!p.path && fs.statSync(resolve(ctx, p.path)).isFile(); } catch {}
      if (!targetIsFile) for (const g of ['!**/.git/**', ...SENSITIVE_GLOBS, ...heavyGlobs(p.path ? resolve(ctx, p.path) : ctx.cwd)]) args.push('-g', g);
      if (p.ignore_case) args.push('-i');
      if (p.files_only) args.push('-l');
      if (p.glob) args.push('-g', globSlashes(p.glob)); // "src\*.ts" matched nothing
      if (p.context) args.push('-C', String(Math.min(10, p.context | 0)));
      args.push('-e', String(p.pattern), p.path ? resolve(ctx, p.path) : '.');
      // With context, rg also prints the lines around a hit (file-12-text) and "--" between groups;
      // counting every line reported 10 matches for 2. Hits are file:12:text (12:text for one file).
      const res = await rg(args, ctx.cwd);
      const raw = res.text.trimEnd();
      const lines = dropSensitiveLines(raw ? raw.split('\n') : [], ctx, !!p.files_only);
      const out = lines.join('\n');
      const n = p.context && !p.files_only ? lines.filter(l => /^(?:(?:[A-Za-z]:)?[^:\r\n]*:)?\d+:/.test(l)).length : lines.length;
      // When rg was killed at the output cap, n counts only the part that
      // arrived: it is a lower bound, not the total, and the payload says so
      // (truncated + matches_at_least) instead of presenting it as exact.
      return {payload: {matches: n, ...(res.truncated ? {truncated: true, matches_at_least: n} : {}), output: clip(out) || '(no matches)'}, view: {count: n}};
    },
  },
  'code.glob': {
    kind: 'read',
    def: {description: 'Find files by glob pattern (e.g. src/**/*.ts). Respects .gitignore. Hidden files and folders are included too (except .git internals and sensitive files). Newest first; count is the total number of matches, files shows the newest 500. OneDrive folders (and AppData when searching from the home folder) are skipped unless path points inside them. Stops after 30 s: narrow path or glob.',
      required: {pattern: {type: 'string', description: 'Glob pattern.'}}, optional: {path: {type: 'string', description: 'Directory to search; default the working directory.'}}},
    summary: p => p.pattern,
    async run(p, ctx) {
      // rg globs take '/', and a pattern is relative to the folder searched: "src\**\*.ts" and
      // "C:/proj/**/*.ts" both found nothing. Backslashes become '/', and an absolute pattern is
      // split into the folder before its first wildcard and the rest.
      let pattern = globSlashes(p.pattern), root = p.path ? resolve(ctx, p.path) : ctx.cwd;
      if (path.isAbsolute(pattern)) {
        const parts = pattern.split('/'), at = parts.findIndex(x => /[*?[{]/.test(x));
        if (at > 0) { root = path.resolve(parts.slice(0, at).join('/') + '/'); pattern = parts.slice(at).join('/'); }
        else if (at < 0) { root = path.dirname(pattern); pattern = path.basename(pattern); }
      }
      assertNotSensitive(root);
      if (isSensitivePath(pattern)) assertNotSensitive(pattern);
      // --hidden for the same reason as code.grep (c6 #7): '**/*.yml' used to miss
      // .github/workflows entirely. .git internals stay excluded, and every result
      // is re-filtered through isSensitivePath below.
      const rgRes = await rg(['--hidden', '--files', '-g', pattern, '-g', '!**/.git/**', ...heavyGlobs(root).flatMap(g => ['-g', g])], root);
      const raw = rgRes.text.split('\n').filter(Boolean);
      // The result used to be cut to the first MAX_GLOB_RESULTS rg lines BEFORE
      // sorting by age, and count reported that cut size: on a 100k-file tree the
      // answer was count=2000 with the newest 500 OF AN ARBITRARY SUBSET, and the
      // other 98k files existed in neither count nor files, with no way to page
      // (fourth audit M13). Now every match is counted and age-sorted, count is
      // the true number of non-sensitive matches, and files are the newest 500
      // of ALL of them — unless rg itself was killed at its 32MB output cap, in
      // which case count is only a lower bound and the payload says so
      // (truncated + count_at_least), as in code.grep. The
      // expensive checks (realpath, hardlink listing) run only for the candidates
      // actually returned, newest first, backfilling past any they drop.
      const listed = raw.filter(f => !isSensitivePath(f) && !isSensitivePath(path.join(root, f)));
      const stated = listed
        .map(f => { let t = 0; try { t = fs.statSync(path.join(root, f)).mtimeMs; } catch {} return [f, t]; })
        .sort((a, b) => b[1] - a[1]);
      const files = []; let dropped = 0;
      for (const [f] of stated) {
        if (files.length >= 500) break;
        const abs = path.join(root, f);
        if (isSensitivePath(realOf(abs)) || ['sensitive', 'unknown'].includes(hardlinkVerdict(abs))) { dropped++; continue; }
        // Relative to the working folder (absolute outside it), as every other tool takes paths:
        // relative to the folder searched, with that folder not in the result, they named other files.
        files.push(inside(ctx.cwd, abs) ? path.relative(ctx.cwd, abs) : abs);
      }
      const count = listed.length - dropped;
      const truncated = rgRes.truncated || count > files.length;
      return {payload: {count, files, ...(truncated ? {truncated: true} : {}), ...(rgRes.truncated ? {count_at_least: count} : {})}, view: {count}};
    },
  },
  'system.run': {
    kind: 'exec',
    def: {description: 'Run a shell command on this Windows PC and return stdout, stderr and exit code. shell is powershell (default) or cmd. Use for builds, tests, git and anything the code tools do not cover. For dev servers, watchers and other long-running processes set background=true: it returns a shell id at once; read output with shell.output, stop with shell.kill.',
      required: {command: {type: 'string', description: 'The command.'}},
      optional: {shell: {type: 'string', description: 'powershell or cmd; default powershell.'}, cwd: {type: 'string', description: 'Working directory; default the session working directory.'}, timeout_ms: {type: 'integer', description: 'Default 120000, max 600000 (not for background).'}, background: {type: 'boolean', description: 'Keep running in the background and return immediately.'}, expect: {type: 'string', description: 'What you expect this run to do, in one fixed shape only: {"exit": 0}, {"exit": "nonzero"}, {"contains": "..."}, {"notContains": "..."} or {"tests": "pass"|"fail"} (as JSON text or an object). Attach it to tests and builds. If the result differs, the result says so ([muser: 想定外]) and, in stop mode, your next write is held once while you rethink.'}},
      timeout_ms: 605000},
    summary: p => p.command,
    async run(p, ctx, signal, onOutput) {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new Error('command is required');
      // Anything but cmd ran in PowerShell without a word ("bash" too), and the output was read as bash's.
      if (p.shell !== undefined && p.shell !== null && p.shell !== '' && !['powershell', 'cmd'].includes(String(p.shell).toLowerCase())) throw new Error('shell must be powershell or cmd (this PC runs Windows; there is no ' + p.shell + ')');
      if (p.shell) p = {...p, shell: String(p.shell).toLowerCase()};
      const cwd = p.cwd ? resolve(ctx, p.cwd) : ctx.cwd, timeout = Math.min(600000, Math.max(1000, p.timeout_ms | 0 || 120000));
      // A missing cwd made Node report "spawn powershell.exe ENOENT", which read as "PowerShell is missing".
      let dirOk = false; try { dirOk = fs.statSync(cwd).isDirectory(); } catch {}
      if (!dirOk) throw new Error('cwd is not an existing folder: ' + cwd);
      if (p.background) {
        if (!ctx.shells) throw new Error('Background shells are not available here');
        const s = ctx.shells.start(p.command, {shell: p.shell, cwd});
        await new Promise(r => setTimeout(r, 1500)); // let startup errors and the first lines show
        const first = await ctx.shells.output(s.id);
        return {payload: {shell_id: s.id, pid: s.pid, shell: p.shell || 'powershell', ...first, hint: 'Command running in background with ID: ' + s.id + '. You will be notified when it completes. To check interim output, use shell.output with shell_id ' + s.id + '; shell.kill stops it.'}, view: {background: s.id, tail: frames(first.output).trimEnd().split('\n').slice(-4)}};
      }
      // On timeout the run moves to the background instead of being killed (as in Claude Code),
      // except a sleep-led command, whose whole point was the wait. Interrupts still kill.
      const sleepLed = /^\s*(start-sleep|sleep)\b/i.test(p.command);
      // The adopt call carries the shell choice with the run (audit #221): it used to pass
      // only {cwd}, so a timed-out shell:'cmd' run was recorded and reported as a default
      // PowerShell shell from then on.
      const r = await runOnce(p.command, {shell: p.shell, cwd, timeout, signal, onOutput, maxOut: MAX_OUT, clip, adopt: (!sleepLed && ctx.shells) ? (child, out) => ctx.shells.adopt(p.command, {cwd, shell: p.shell}, child, out) : undefined});
      if (r.backgrounded) return {payload: {shell_id: r.backgrounded, backgrounded: true, shell: p.shell || 'powershell', stdout: clip(r.stdout), stderr: clip(r.stderr, MAX_OUT / 3), hint: 'The command reached its timeout and was moved to the background as ' + r.backgrounded + ' instead of being stopped. You will be notified when it completes; shell.output reads it, shell.kill stops it.'}, view: {background: r.backgrounded, tail: frames(r.stdout + r.stderr).trimEnd().split('\n').slice(-4)}};
      return {payload: {exit_code: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr, MAX_OUT / 3), ...(r.killed ? {killed: r.killed} : {})}, view: {exit: r.code, killed: r.killed, tail: frames(r.stdout + r.stderr).trimEnd().split('\n').slice(-4)}};
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
    // kind 'kill', its own: 'read' is auto-allowed everywhere (incl. plan mode and read-only
    // sub-agents), and 'edit' was worse than it looked (audit #213) — auto-edit mode allowed
    // every kill unasked, and a remembered "don't ask again" for edits (alwaysKey 'edit')
    // silently covered kills too. decide() treats an unknown kind conservatively with no
    // policy change: denied in plan mode, asked in default AND auto-edit mode, never
    // remembered (alwaysKey returns null for it), allowed only in bypass.
    kind: 'kill',
    def: {description: 'Stop a background shell (and its child processes).', required: {shell_id: {type: 'string', description: 'e.g. bg1'}}, optional: {}},
    summary: p => p.shell_id,
    run(p, ctx) { const r = ctx.shells.kill(p.shell_id); return {payload: r, view: {background: r.id, killed: r.killed}}; },
  },
  'shell.list': {
    kind: 'read',
    def: {description: 'List background shells with their status.', required: {}, optional: {}},
    summary: () => '',
    run(p, ctx) { const all = ctx.shells ? ctx.shells.all() : []; return {payload: {shells: all.map(({tail, ...s}) => s)}, view: {count: all.length}}; },
  },
  'skill.read': {
    kind: 'read',
    def: {description: 'Read one of the user\'s skills (listed in the session preamble): its SKILL.md and the list of its files, or with path one file inside the skill folder. Read a skill before following it.',
      required: {name: {type: 'string', description: 'Skill name from the list.'}}, optional: {path: {type: 'string', description: 'A file inside the skill folder, relative to it (e.g. references/guide.md).'}}},
    summary: p => String(p.name || '') + (p.path ? ' ' + p.path : ''),
    run(p, ctx) {
      const r = require('./skills').read(ctx.cwd, p);
      return {payload: r, view: {name: r.name, path: r.path || '', lines: String(r.content || '').split('\n').length}};
    },
  },
  'todo.write': {
    // 'read': it only updates muser's own task list on screen and touches nothing on the PC.
    // As 'edit' it asked for approval on every update in default mode and was refused in plan
    // mode and to read-only agents, while the preamble asks Muse to use it for multi-step work.
    kind: 'read',
    def: {description: 'Keep the task list for this coding session, shown to the user. Send the whole list each time. Use it for work with 3+ steps; mark exactly one item in_progress.',
      required: {todos: {type: 'string', description: 'JSON array of {"content": string, "status": "pending"|"in_progress"|"completed"|"blocked"}.'}}, optional: {}},
    summary: () => '',
    run(p, ctx) {
      // The gateway may hand over the array itself instead of its JSON text (JSON.parse of an array
      // threw "must be a JSON array string"), and a null entry crashed on t.content.
      let todos = p.todos;
      if (typeof todos === 'string') { try { todos = JSON.parse(todos); } catch { throw new Error('todos must be a JSON array string'); } }
      if (!Array.isArray(todos)) throw new Error('todos must be a JSON array');
      // "done" / "in-progress" and the like showed as pending: the common spellings are understood.
      // 'blocked' is kept as itself: it used to fall through to 'pending', so a task
      // waiting on something read as merely not started. (Unknown spellings still
      // fall back to 'pending', as before.)
      const status = s => { const k = String(s || '').toLowerCase().replace(/[\s-]+/g, '_'); return ['completed', 'complete', 'done', 'finished'].includes(k) ? 'completed' : ['in_progress', 'inprogress', 'active', 'doing', 'started', 'working'].includes(k) ? 'in_progress' : k === 'blocked' ? 'blocked' : 'pending'; };
      const valid = todos.filter(x => x && typeof x === 'object');
      ctx.todos = valid.slice(0, 50).map(t => ({content: String(t.content || '').slice(0, 300), status: status(t.status)}));
      // The 50-item cut used to be silent; say so, the way code.glob does.
      return {payload: {ok: true, count: ctx.todos.length, ...(valid.length > ctx.todos.length ? {truncated: true} : {})}, view: {todos: ctx.todos}};
    },
  },
};

function commandsV2() { return Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, t.def])); }

module.exports = {TOOLS, commandsV2, lineDiff, parsePatch, applyHunks, inside, isSensitivePath, realOf, heavyGlobs, copyReads, recordRead, utf16Of, dropSensitiveLines, hardlinkVerdict, setHardlinkLister, clearHardlinkCache, cutLine, stats, DIFF_FALLBACK_MAX, RG_MAX_OUT};
