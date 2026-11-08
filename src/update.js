'use strict';
// Update check: on every interactive start muser asks the npm registry for the latest
// muser-cli in the background and shows a newer one in the footer; /update installs it. It never
// installs by itself (muser runs commands on this PC, so a new version goes in when the user says).
// Off with MUSER_NO_UPDATE_CHECK=1 or "updateCheck": false in ~/.muser/config.json, and for a git
// checkout (npm link while developing), which npm must not overwrite.
// The automatic (startup) check is throttled (wave 12): every check's time and outcome are
// recorded in ~/.muser/update-check.json, and a startup check is skipped while the last one is
// fresh — 6 hours after a successful check, 1 hour after a failed one — so an offline stretch
// does not re-pay the registry timeout on every start. A manual /update always checks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {t} = require('./i18n');

const NAME = 'muser-cli';
const REGISTRY = 'https://registry.npmjs.org/' + NAME + '/latest';
const PKG_ROOT = path.join(__dirname, '..');

function devCheckout(root = PKG_ROOT) { return fs.existsSync(path.join(root, '.git')); }

function enabled({env = process.env, configFile = path.join(os.homedir(), '.muser', 'config.json'), root = PKG_ROOT} = {}) {
  // The env booleans use the same spellings as every other settings surface
  // (wave 14, config.envBool): 1/true/yes/on count, 0/false/off do not.
  if (require('./config').envBool(env.MUSER_NO_UPDATE_CHECK) === true) return false;
  // Wave 7: a git checkout is never checked, not even when the check is forced
  // with MUSER_UPDATE_CHECK=1. The forced check used to run there, the footer
  // offered /update, and /update then refused as development-only — a notice
  // that could never be acted on. npm must not overwrite a dev checkout, so
  // this gate wins over the env opt-in below.
  if (devCheckout(root)) return false;
  // An explicit env opt-in wins over the saved setting: MUSER_UPDATE_CHECK=1
  // used to be powerless against "updateCheck": false, so the documented
  // escape hatch silently did nothing (audit #228).
  if (require('./config').envBool(env.MUSER_UPDATE_CHECK) === true) return true;
  try { if (require('./config').readJson(configFile)?.updateCheck === false) return false; } catch {}
  return !devCheckout(root);
}

// Is version a newer than b? Plain x.y.z; a pre-release (0.4.0-beta) is never offered.
// The same numbers ARE newer when b is a pre-release of them: a user on 0.4.0-beta was
// never offered the 0.4.0 release, because b's suffix was stripped before comparing
// (audit #227). Semver orders a pre-release before its release.
// Wave 16: a +build suffix is metadata, not part of the version: it is stripped
// from BOTH sides before classifying or comparing, so 0.4.0+build classifies and
// compares exactly like 0.4.0 (it used to fail the plain-version test outright,
// and a '-' inside build metadata used to look like a pre-release). A version
// that still has a pre-release part after stripping keeps today's treatment.
// Wave 16: components are compared as digit strings, not through Number():
// Number() rounds at 2^53, so 9007199254740993 and 9007199254740992 used to
// compare equal and collapse the order of huge components.
function compareComponent(x, y) {
  const a = String(x).replace(/^0+/, '') || '0';
  const b = String(y).replace(/^0+/, '') || '0';
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : (a > b ? 1 : -1);
}
function newer(a, b) {
  const stripBuild = v => String(v).replace(/\+[0-9A-Za-z.-]+$/, '');
  const parse = v => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.') : null;
  const aCore = stripBuild(a), bCore = stripBuild(b);
  const x = parse(aCore), y = parse(bCore.split('-')[0]);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { const c = compareComponent(x[i], y[i]); if (c !== 0) return c > 0; }
  return bCore.includes('-');
}

// The failures latest() can throw, already worded for the user: /update puts
// e.message straight into its "could not check" note, so a raw English error
// (undici's 'fetch failed', a TimeoutError's 'The operation was aborted…',
// 'npm registry: HTTP 503') used to reach the user as-is (wave 7). Network
// failures become a worded reason, an HTTP failure keeps only its status,
// and the original error stays on `cause` for anything that logs it.
function checkError(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return Object.assign(new Error(t('時間内に返事がありませんでした')), {timeout: true, cause: e});
  return Object.assign(new Error(t('ネットワークに接続できませんでした')), {network: true, cause: e});
}
function noVersionError(cause) {
  return Object.assign(new Error(t('返事に版の情報がありませんでした')), cause ? {cause} : {});
}

// The latest STABLE version on the registry, as plain x.y.z, or null when the
// registry's latest is not a stable release (below). Throws a worded
// checkError / noVersionError, or an 'HTTP <status>' error, when the check
// itself failed — callers turn a throw into "could not check", which must
// stay distinct from "checked, nothing stable to offer".
async function latest({timeoutMs = 5000} = {}) {
  let r;
  try { r = await fetch(REGISTRY, {signal: AbortSignal.timeout(timeoutMs), headers: {accept: 'application/json'}}); }
  catch (e) { throw checkError(e); }
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), {status: r.status});
  let data;
  try { data = await r.json(); }
  catch (e) { throw (e?.name === 'TimeoutError' || e?.name === 'AbortError') ? checkError(e) : noVersionError(e); }
  // A leading v is packaging, not part of the version ('v0.4.0' means 0.4.0):
  // stripping it keeps such a response a successful check instead of the
  // "no version" failure it used to be (wave 7).
  const rawVersion = String(data?.version || '').trim().replace(/^v/, '');
  // Wave 16: +build is metadata (see newer): strip a well-formed build suffix
  // before classifying, so 0.4.0+build.5 is the stable 0.4.0 it names instead
  // of the "no version" failure it used to throw. A malformed suffix is not
  // stripped, so the checks below still reject it as no usable version.
  const version = rawVersion.replace(/\+[0-9A-Za-z.-]+$/, '');
  // A pre-release as the registry's latest (0.4.0-beta.1) is not a failed
  // check and not a stable version either: return null for "no stable
  // version to offer". Callers already cope: checkUpdate's newer(null, v)
  // is false, so the footer stays clear, and /update's newer check is false,
  // so it reports up-to-date and installs nothing.
  if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)) return null;
  // First audit #37: a 200 response WITHOUT a usable version (a proxy's error
  // page as JSON, an empty object) used to return '' here, and newer('', v) is
  // false, so /update reported "already the latest" for a check that never
  // happened. A response we cannot read a plain x.y.z version from is a failed
  // check, and callers already turn a throw into "could not check".
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw noVersionError();
  return version;
}

// ---- Check throttling (wave 12) -------------------------------------------
// ~/.muser/update-check.json holds the last check as {checkedAt, ok, latest}:
// when it happened (ms), whether the registry answered, and the stable version
// it offered (null when there was none). A record that cannot be read or does
// not parse is "no record" — the check simply runs.
const RECHECK_SUCCESS_MS = 6 * 60 * 60 * 1000;
const RECHECK_FAILURE_MS = 60 * 60 * 1000;
// Wave 15: a checkedAt may sit slightly in the future (the clock was nudged
// between the write and a later read), so a small skew is tolerated — but a
// stamp far in the future is not trusted at all (see recentCheck).
const FUTURE_SKEW_MS = 5 * 60 * 1000;
function checkFile() { return path.join(os.homedir(), '.muser', 'update-check.json'); }
function readCheckRecord({file, now = Date.now()} = {}) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file || checkFile(), 'utf8')); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const at = Number(v.checkedAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {checkedAt: at, ok: v.ok === true, latest: typeof v.latest === 'string' && /^\d+\.\d+\.\d+$/.test(v.latest) ? v.latest : null};
}
function recordCheck({ok, latest = null, file, now = Date.now()} = {}) {
  const rec = {checkedAt: now, ok: !!ok, latest: typeof latest === 'string' && /^\d+\.\d+\.\d+$/.test(latest) ? latest : null};
  // Best effort only: a check that cannot be recorded must not fail the check
  // itself (a read-only home, a racing window) — the next start just checks again.
  try { const f = file || checkFile(); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, JSON.stringify(rec) + '\n'); } catch {}
  return rec;
}
// The recorded check while it is still fresh enough to stand in for a new one,
// or null when a new automatic check is due: 6 hours after a successful check,
// 1 hour after a failed one. A timestamp slightly in the future (the clock
// moved back a little) counts as fresh rather than due, so a small clock
// change never causes a re-check storm on every start — but only up to
// FUTURE_SKEW_MS (wave 15): a stamp further in the future than that (the
// clock was set forward when it was written, or the file was crafted) would
// otherwise suppress every automatic check for as long as it stays ahead,
// so past the tolerance the record counts as due and a real check runs.
function recentCheck({file, now = Date.now()} = {}) {
  const rec = readCheckRecord({file, now});
  if (!rec) return null;
  if (rec.checkedAt - now > FUTURE_SKEW_MS) return null;
  return now - rec.checkedAt < (rec.ok ? RECHECK_SUCCESS_MS : RECHECK_FAILURE_MS) ? rec : null;
}

// npm is a .cmd on Windows, which Node no longer spawns without a shell. A stuck npm (network,
// a lock) is stopped after timeoutMs, so /update can be tried again.
let installRunning = false, installStuck = false;
const REGISTRY_ORIGIN = 'https://registry.npmjs.org/';
// Fix2 (c26 #8 / deep #227): the guards above are per-process, so two muser
// windows could run two `npm install -g` against the same global tree at once.
// A lock file under ~/.muser (shared by every window of this user) serializes
// installs across processes: a live holder blocks, a dead holder's lock is
// claimed by renaming it away (only one claimant wins the rename).
// Wave 15: however alive its pid looks, a lock untouched for this long is
// stale — a holder that crashed without exiting, a pid since reused by an
// unrelated process, or an install that will never finish must not block
// every later /update for ever.
const LOCK_STALE_MS = 30 * 60 * 1000;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
function acquireInstallLock(lockFile) {
  const token = require('node:crypto').randomBytes(16).toString('hex');
  const content = token + ':' + process.pid;
  try { fs.mkdirSync(path.dirname(lockFile), {recursive: true}); } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = fs.openSync(lockFile, 'wx'); try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); } return {lockFile, content}; }
    catch (e) {
      // Wave 16: an existing lock path may refuse the 'wx' open with a code
      // other than EEXIST (a directory lock, above all) — what matters for
      // the stale decision below is that SOMETHING is there, not the code.
      let exists = e.code === 'EEXIST';
      if (!exists) { try { fs.statSync(lockFile); exists = true; } catch {} }
      if (!exists) return null;
      let stale = false;
      try {
        const held = fs.readFileSync(lockFile, 'utf8');
        const ownerPid = Number((held.split(':')[1] || '').trim());
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        // A dead holder is always stale; a lock with no readable pid keeps
        // the 60 s rule; and (wave 15) any lock older than LOCK_STALE_MS is
        // stale even when its pid is still alive.
        // Wave 17: a lock whose mtime is in the future (age < 0 — the clock
        // was set forward when it was written, or it was crafted) satisfies
        // neither age rule, so it blocked /update until that future time
        // plus LOCK_STALE_MS. Its age says nothing, so judge it by pid
        // liveness alone: a live pid still blocks, anything else (a dead
        // pid, or no readable pid at all) is taken over.
        stale = age < 0 ? !(ownerPid > 0 && pidAlive(ownerPid)) : (ownerPid > 0 ? !pidAlive(ownerPid) : age > 60000) || age > LOCK_STALE_MS;
      } catch {
        // Wave 16: the lock path may not be readable as a lock file at all —
        // it can be a DIRECTORY (or otherwise unreadable), where the read
        // above always throws. That used to read as never-stale, so such a
        // lock blocked every later update for ever. Decide from the stat age
        // alone instead: older than LOCK_STALE_MS is stale, however it looks.
        // Wave 17: a future mtime is stale here too — no pid can be read from
        // such a lock, so under the pid-only rule above nothing live holds it.
        try { const age = Date.now() - fs.statSync(lockFile).mtimeMs; stale = age < 0 || age > LOCK_STALE_MS; } catch { stale = false; }
      }
      if (!stale) return null;
      const grave = lockFile + '.stale-' + token;
      try { fs.renameSync(lockFile, grave); } catch { return null; }
      // Wave 16: the grave may be a directory (a reclaimed directory lock),
      // which unlink cannot remove — remove it recursively either way.
      try { fs.rmSync(grave, {recursive: true, force: true}); } catch {}
    }
  }
  return null;
}
function releaseInstallLock(lock) {
  if (!lock) return;
  // Wave 16: read the lock BEFORE touching it, and remove it only when its
  // content is still this holder's own token. The old rename-first release
  // moved whatever sat at the lock path aside — including a SUCCESSOR's lock
  // (this holder's lock stale-claimed, a new holder now owning the path) —
  // and its rename-back fallback could delete that successor's lock outright,
  // letting two installs run at once. An unreadable or different lock is not
  // this holder's to move: leave it exactly as it stands.
  let held;
  try { held = fs.readFileSync(lock.lockFile, 'utf8'); } catch { return; }
  if (held !== lock.content) return;
  try { fs.unlinkSync(lock.lockFile); } catch {}
}
// Fix2 (c26 #7 / deep #226): after a pinned install, read back what actually
// landed (`npm list -g`) instead of trusting the exit code alone. With no
// pinned version (undefined) any readable version token counts, and the version read
// back rides the result as `version`, so the caller can say what actually
// landed; no readable version at all is a failure (wave 12: a broken package
// whose version cannot be read must not count as a successful install).
function verifyInstalled(version, verifyCommand, spawnOpts) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn('cmd.exe', ['/d', '/s', '/c', verifyCommand], spawnOpts); } catch (e) { resolve({ok: false, output: t('入った版を確認できませんでした: {detail}', {detail: e.message})}); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ok: false, output: t('入った版を確認できませんでした（npm list が終わりませんでした）。')}); }, 60000);
    timer.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ok: false, output: t('入った版を確認できませんでした: {detail}', {detail: e.message})}); });
    child.on('close', () => {
      clearTimeout(timer);
      // Wave 16: capture the FULL installed version token, including any
      // -prerelease / +build suffix, and compare it whole against the pinned
      // version: the old core-only pattern prefix-matched, so an installed
      // 0.4.0-beta.1 passed a pinned 0.4.0 install as if the release had landed.
      const m = out.match(new RegExp(NAME + '@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)'));
      if (!m) resolve({ok: false, output: t('{name} の入った版を確認できませんでした。', {name: NAME})});
      else if (version && m[1] !== version) resolve({ok: false, output: t('入った版は v{actual} で、案内した v{expected} と違います。', {actual: m[1], expected: version})});
      else resolve({ok: true, output: '', version: m[1]});
    });
  });
}
// ---- Rollback record (wave 15) --------------------------------------------
// Before an install replaces the current package, install() records what is
// there now — its version (from its own package.json) and its location — in
// update-backup.json next to the lock, and, for a real (default-command,
// non-checkout) install, also copies the package aside into update-backup/.
// A failure after the replacement (a non-zero exit, a verification failure)
// then has a way back: the copy is restored when there is one, and every
// failure note names the previous version and the exact command that puts
// it back, so a half-replaced install never strands the user with neither
// version working and no record of what was there.
// Wave 16: the CURRENT version is recorded as full semver, pre-release and
// +build included: the plain x.y.z-only gate used to record a current
// 0.4.0-beta.1 as version:null, evacuate nothing for it, and degrade its
// failure note to the "could not identify" placeholder. (The version an
// install TARGETS stays plain x.y.z — see install() — only what is already
// installed is admitted in full here.)
const FULL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function currentInstallVersion(root = PKG_ROOT) {
  try { const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))?.version; return FULL_VERSION_RE.test(String(v || '')) ? String(v) : null; } catch { return null; }
}
// Wave 16: an evacuation's manifest — every file under the root as
// {path, size}, paths '/'-separated and sorted — is written into
// update-backup.json with the record. It is what lets a later evacuation
// tell a torn tree from a whole one, and lets a restore prove it put the
// whole tree back instead of trusting the version string alone.
function collectManifest(root) {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { out.push({path: path.relative(root, full).split(path.sep).join('/'), size: fs.statSync(full).size}); } catch {} }
    }
  };
  walk(root);
  return out;
}
function manifestPathSet(manifest) { return new Set((Array.isArray(manifest) ? manifest : []).map(e => (e && typeof e.path === 'string' ? e.path : '')).filter(Boolean)); }
function treeHasManifestFiles(root, manifest) {
  if (!Array.isArray(manifest)) return true;
  for (const e of manifest) {
    if (!e || typeof e.path !== 'string' || !e.path) continue;
    try { if (!fs.statSync(path.join(root, ...e.path.split('/'))).isFile()) return false; } catch { return false; }
  }
  return true;
}
function rollbackCommandFor(version) { return 'npm install -g ' + NAME + '@' + version + ' --registry=' + REGISTRY_ORIGIN; }
function recordInstallBackup({lockFile, targetVersion, currentVersion, root = PKG_ROOT, evacuate = false} = {}) {
  const dir = path.dirname(lockFile);
  const backupFile = path.join(dir, 'update-backup.json');
  const prev = {version: typeof currentVersion === 'string' && FULL_VERSION_RE.test(currentVersion) ? currentVersion : currentInstallVersion(root), location: root, targetVersion: targetVersion || null, backupDir: null, manifest: null, at: Date.now()};
  // The file copy is the evacuation the restore below puts back. It is made
  // for a real install (the default command) or an explicitly named package
  // root (an isolated-prefix install) — never for a bare caller-supplied
  // command against this code's own root, whose target cannot be known, and
  // never for a dev checkout, which must not be copied over itself.
  if (evacuate && prev.version && !devCheckout(root)) {
    const backupDir = path.join(dir, 'update-backup');
    // Wave 16: never evacuate a torn tree over the last good backup. When an
    // earlier backup for this root exists with a manifest, and the tree now
    // standing here is MISSING files that manifest lists (a previous install
    // failed halfway and left it torn), the older backup is kept as it is and
    // stays the rollback target — copying the torn tree over it would destroy
    // the only whole copy, and the restore would then "succeed" onto a tree
    // that is still missing files.
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(backupFile, 'utf8')); } catch {}
    const existingManifest = existing && existing.backupDir === backupDir && (!existing.location || existing.location === root) && Array.isArray(existing.manifest) ? existing.manifest : null;
    const currentManifest = collectManifest(root);
    const currentPaths = manifestPathSet(currentManifest);
    const missing = existingManifest ? [...manifestPathSet(existingManifest)].filter(p => !currentPaths.has(p)) : [];
    if (existingManifest && missing.length > 0 && fs.existsSync(path.join(backupDir, 'package.json'))) {
      if (typeof existing.version === 'string' && FULL_VERSION_RE.test(existing.version)) prev.version = existing.version;
      prev.backupDir = backupDir;
      prev.manifest = existingManifest;
    } else {
      try { fs.rmSync(backupDir, {recursive: true, force: true}); fs.cpSync(root, backupDir, {recursive: true}); prev.backupDir = backupDir; prev.manifest = currentManifest; } catch { prev.backupDir = null; prev.manifest = null; }
    }
  }
  try { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(backupFile, JSON.stringify({name: NAME, ...prev}) + '\n'); } catch {}
  return {...prev, backupFile};
}
function restoreFromBackup(prev) {
  if (!prev?.backupDir || !prev?.location) return false;
  try {
    if (!fs.existsSync(path.join(prev.backupDir, 'package.json'))) return false;
    fs.rmSync(prev.location, {recursive: true, force: true});
    fs.cpSync(prev.backupDir, prev.location, {recursive: true});
    // Wave 16: version equality alone is not proof the tree came back — a
    // backup that was itself torn also matches its own version. When the
    // record carries a manifest, every file it lists must be present in the
    // restored tree, or the restore reports false and the failure note falls
    // back to the manual reinstall command.
    return currentInstallVersion(prev.location) === prev.version && treeHasManifestFiles(prev.location, prev.manifest);
  } catch { return false; }
}
// The way back, worded for a failure note: the previous version, where the
// pre-replacement record lives, and the command that reinstalls that version.
function rollbackNote(prev, restored) {
  if (!prev?.version) return t('置換前の版を特定できなかったため、自動では戻せませんでした。npm install -g {name}@（前の版）で前の版を入れ直してください。', {name: NAME});
  if (restored) return t('置換前の版 v{version} に自動で戻しました（退避先: {backup}）。', {version: prev.version, backup: prev.backupDir || prev.backupFile});
  return t('前の版 v{version} に戻すには、次のコマンドを実行してください: {command}（置換前の版と場所は {file} に記録しました）', {version: prev.version, command: rollbackCommandFor(prev.version), file: prev.backupFile});
}
function install({timeoutMs = 5 * 60 * 1000, command, version, lockFile = path.join(os.homedir(), '.muser', 'update.lock'), verifyCommand = 'npm list -g ' + NAME + ' --depth=0', currentVersion, packageRoot = PKG_ROOT} = {}) {
  // The version goes into a shell command, so it is admitted only as a plain
  // x.y.z (the same shape latest() now guarantees) — never as free text.
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(version))) return Promise.resolve({ok: false, output: t('更新の版の形式が違います: {version}', {version: String(version)})});
  // Fix2 (c26 #7 / deep #226): install the version latest() checked and the
  // user accepted, pinned — not the floating @latest tag, which can move (or
  // be rolled back) between the check and the install. Fix2 (fourth M26): the
  // registry is pinned on the command AND in the environment, and the child
  // runs from the home folder (see spawn below), so a project .npmrc in the
  // user's working folder cannot redirect the global install elsewhere.
  const defaultCommand = command === undefined;
  if (defaultCommand) command = 'npm install -g ' + NAME + '@' + (version || 'latest') + ' --registry=' + REGISTRY_ORIGIN;
  // A previous install whose process could not be stopped is still holding the global install:
  // a second npm on top of it would race the same files, so retries are blocked until it exits.
  if (installStuck) return Promise.resolve({ok: false, output: t('前の更新を止められず、まだ動いています。終わるまで待ってからもう一度試してください。')});
  if (installRunning) return Promise.resolve({ok: false, output: t('更新はすでに実行中です。')});
  const lock = acquireInstallLock(lockFile);
  // Wave 15: the blocked note says how the lock can be cleared — which file
  // it is — and that an old-enough lock is reclaimed on its own (LOCK_STALE_MS
  // above), instead of leaving the user stuck behind a lock they cannot see.
  if (!lock) return Promise.resolve({ok: false, output: t('別の muser の窓で更新が実行中です。終わらない場合は、その窓を閉じてからロックファイル {file} を削除すると解除できます（30分以上たったロックは古いものとして自動で回収します）。', {file: lockFile})});
  // Wave 15: record (and, for a real install, evacuate) what is installed
  // now, BEFORE the replacement below can touch it.
  const prev = recordInstallBackup({lockFile, targetVersion: version || null, currentVersion, root: packageRoot, evacuate: defaultCommand || packageRoot !== PKG_ROOT});
  installRunning = true;
  let lockHeld = true;
  const releaseLock = () => { if (lockHeld) { lockHeld = false; releaseInstallLock(lock); } };
  return new Promise(resolve => {
    let out = '', done = false, timedOut = false, childClosed = false;
    const exitWaiters = [];
    const spawnOpts = {windowsHide: true, cwd: os.homedir() || PKG_ROOT, env: {...process.env, npm_config_registry: REGISTRY_ORIGIN}};
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], spawnOpts);
    const finish = r => { if (done) return; done = true; clearTimeout(timer); if (!installStuck) { installRunning = false; releaseLock(); } resolve(r); };
    // Wave 15: every failure after the replacement may have happened goes
    // out with the way back attached — the recorded previous version, the
    // restore outcome when an evacuated copy was put back, and the command
    // that reinstalls the previous version when it was not (or could not
    // be). `attemptRestore` is for failures where npm itself has finished
    // (a non-zero exit, a verification failure); a spawn error means the
    // replacement never ran, so it only carries the note. Wave 16: a timeout
    // attempts the restore too when the child is confirmed exited (nothing
    // is still holding the tree then); only a child that is still running
    // after the kill keeps the note-only behaviour.
    const failWithRollback = (output, attemptRestore = false) => {
      const restored = attemptRestore ? restoreFromBackup(prev) : false;
      const note = rollbackNote(prev, restored);
      finish({ok: false, output: ((output || '').trim() + '\n' + note).trim(), previousVersion: prev.version || null, rollbackCommand: prev.version ? rollbackCommandFor(prev.version) : null, backupFile: prev.backupFile, restored});
    };
    const waitChildExit = ms => childClosed ? Promise.resolve(true) : new Promise(r => { const w = ok => r(ok); exitWaiters.push(w); setTimeout(() => r(childClosed), ms); });
    const timer = setTimeout(async () => {
      timedOut = true;
      // Await the kill itself and the child's exit before resolving: resolving as soon as
      // taskkill was *issued* let a retry start while the old npm was still shutting down.
      try {
        await new Promise(r => {
          const k = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true});
          k.on('error', () => r()); k.on('close', () => r()); setTimeout(r, 5000);
        });
      } catch {}
      const exited = await waitChildExit(2000);
      if (!exited) installStuck = true; // resolved below, but retries stay blocked until it really exits
      // Wave 16: a confirmed-dead child no longer holds the tree, so this
      // timeout restores from the backup exactly like the non-zero-exit path
      // below; a still-running child (exited === false) must not be restored
      // over, so it keeps the note-only failure.
      failWithRollback((out.trim() + '\n' + t('npm が {seconds} 秒で終わらなかったので止めました。', {seconds: Math.round(timeoutMs / 1000)})).trim(), exited);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { childClosed = true; for (const w of exitWaiters.splice(0)) w(true); if (installStuck) { installStuck = false; installRunning = false; releaseLock(); } if (!timedOut) failWithRollback(e.message); });
    child.on('close', code => { childClosed = true; for (const w of exitWaiters.splice(0)) w(true); if (installStuck) { installStuck = false; installRunning = false; releaseLock(); } if (timedOut) return; if (code !== 0) { failWithRollback(out, true); return; }
      // Wave 12: an exit-0 install is verified whenever a version was pinned
      // (the mismatch check) and whenever the real default install ran (a
      // broken package whose version cannot be read back is not a success,
      // and the version that actually landed rides the result as
      // installedVersion). A caller-supplied command is a test seam and keeps
      // the exit-code-only behaviour it had.
      if (version || defaultCommand) { verifyInstalled(version, verifyCommand, spawnOpts).then(vr => vr.ok ? finish({ok: true, output: out.trim(), installedVersion: vr.version || version}) : failWithRollback((out.trim() + '\n' + vr.output).trim(), true)); } else finish({ok: true, output: out.trim()}); });
  });
}

module.exports = {enabled, devCheckout, newer, latest, install, checkFile, readCheckRecord, recordCheck, recentCheck, RECHECK_SUCCESS_MS, RECHECK_FAILURE_MS, FUTURE_SKEW_MS, LOCK_STALE_MS, rollbackCommandFor};
