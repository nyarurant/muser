'use strict';
// Update check: on every interactive start muser asks the npm registry for the latest
// muser-cli in the background and shows a newer one in the footer; /update installs it. It never
// installs by itself (muser runs commands on this PC, so a new version goes in when the user says).
// Off with MUSER_NO_UPDATE_CHECK=1 or "updateCheck": false in ~/.muser/config.json, and for a git
// checkout (npm link while developing), which npm must not overwrite.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const NAME = 'muser-cli';
const REGISTRY = 'https://registry.npmjs.org/' + NAME + '/latest';
const PKG_ROOT = path.join(__dirname, '..');

function devCheckout(root = PKG_ROOT) { return fs.existsSync(path.join(root, '.git')); }

function enabled({env = process.env, configFile = path.join(os.homedir(), '.muser', 'config.json'), root = PKG_ROOT} = {}) {
  if (env.MUSER_NO_UPDATE_CHECK === '1') return false;
  // An explicit env opt-in wins over the saved setting, as it already did over a dev
  // checkout: MUSER_UPDATE_CHECK=1 used to be powerless against "updateCheck": false,
  // so the documented escape hatch silently did nothing (audit #228).
  if (env.MUSER_UPDATE_CHECK === '1') return true;
  try { if (require('./config').readJson(configFile)?.updateCheck === false) return false; } catch {}
  return !devCheckout(root);
}

// Is version a newer than b? Plain x.y.z; a pre-release (0.4.0-beta) is never offered.
// The same numbers ARE newer when b is a pre-release of them: a user on 0.4.0-beta was
// never offered the 0.4.0 release, because b's suffix was stripped before comparing
// (audit #227). Semver orders a pre-release before its release.
function newer(a, b) {
  const parse = v => /^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null;
  const x = parse(a), y = parse(String(b).split('-')[0]);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return String(b).includes('-');
}

async function latest({timeoutMs = 5000} = {}) {
  const r = await fetch(REGISTRY, {signal: AbortSignal.timeout(timeoutMs), headers: {accept: 'application/json'}});
  if (!r.ok) throw new Error('npm registry: HTTP ' + r.status);
  const version = String((await r.json())?.version || '');
  // First audit #37: a 200 response WITHOUT a usable version (a proxy's error
  // page as JSON, an empty object) used to return '' here, and newer('', v) is
  // false, so /update reported "already the latest" for a check that never
  // happened. A response we cannot read a plain x.y.z version from is a failed
  // check, and callers already turn a throw into "could not check".
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('npm registry: no version in response');
  return version;
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
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
function acquireInstallLock(lockFile) {
  const token = require('node:crypto').randomBytes(16).toString('hex');
  const content = token + ':' + process.pid;
  try { fs.mkdirSync(path.dirname(lockFile), {recursive: true}); } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = fs.openSync(lockFile, 'wx'); try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); } return {lockFile, content}; }
    catch (e) {
      if (e.code !== 'EEXIST') return null;
      let stale = false;
      try {
        const held = fs.readFileSync(lockFile, 'utf8');
        const ownerPid = Number((held.split(':')[1] || '').trim());
        stale = ownerPid > 0 ? !pidAlive(ownerPid) : Date.now() - fs.statSync(lockFile).mtimeMs > 60000;
      } catch { stale = false; }
      if (!stale) return null;
      const grave = lockFile + '.stale-' + token;
      try { fs.renameSync(lockFile, grave); } catch { return null; }
      try { fs.unlinkSync(grave); } catch {}
    }
  }
  return null;
}
function releaseInstallLock(lock) {
  if (!lock) return;
  const rel = lock.lockFile + '.rel-' + lock.content.split(':')[0];
  try { fs.renameSync(lock.lockFile, rel); } catch { return; }
  try {
    if (fs.readFileSync(rel, 'utf8') === lock.content) { try { fs.unlinkSync(rel); } catch {} }
    else { try { fs.renameSync(rel, lock.lockFile); } catch { try { fs.unlinkSync(rel); } catch {} } } // a successor's lock: put it back
  } catch {}
}
// Fix2 (c26 #7 / deep #226): after a pinned install, read back what actually
// landed (`npm list -g`) instead of trusting the exit code alone.
function verifyInstalled(version, verifyCommand, spawnOpts) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn('cmd.exe', ['/d', '/s', '/c', verifyCommand], spawnOpts); } catch (e) { resolve({ok: false, output: 'Could not verify the installed version: ' + e.message}); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ok: false, output: 'Could not verify the installed version: npm list did not finish.'}); }, 60000);
    timer.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ok: false, output: 'Could not verify the installed version: ' + e.message}); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(new RegExp(NAME + '@(\\d+\\.\\d+\\.\\d+)'));
      if (!m) resolve({ok: false, output: 'Could not verify the installed version of ' + NAME + '.'});
      else if (m[1] !== version) resolve({ok: false, output: 'Installed version is v' + m[1] + ', not the v' + version + ' that was offered.'});
      else resolve({ok: true, output: ''});
    });
  });
}
function install({timeoutMs = 5 * 60 * 1000, command, version, lockFile = path.join(os.homedir(), '.muser', 'update.lock'), verifyCommand = 'npm list -g ' + NAME + ' --depth=0'} = {}) {
  // The version goes into a shell command, so it is admitted only as a plain
  // x.y.z (the same shape latest() now guarantees) — never as free text.
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(version))) return Promise.resolve({ok: false, output: 'Invalid update version: ' + version});
  // Fix2 (c26 #7 / deep #226): install the version latest() checked and the
  // user accepted, pinned — not the floating @latest tag, which can move (or
  // be rolled back) between the check and the install. Fix2 (fourth M26): the
  // registry is pinned on the command AND in the environment, and the child
  // runs from the home folder (see spawn below), so a project .npmrc in the
  // user's working folder cannot redirect the global install elsewhere.
  if (command === undefined) command = 'npm install -g ' + NAME + '@' + (version || 'latest') + ' --registry=' + REGISTRY_ORIGIN;
  // A previous install whose process could not be stopped is still holding the global install:
  // a second npm on top of it would race the same files, so retries are blocked until it exits.
  if (installStuck) return Promise.resolve({ok: false, output: 'A previous update could not be stopped and is still running; wait for it to finish before trying again.'});
  if (installRunning) return Promise.resolve({ok: false, output: 'An update is already running.'});
  const lock = acquireInstallLock(lockFile);
  if (!lock) return Promise.resolve({ok: false, output: 'An update is already running in another muser window.'});
  installRunning = true;
  let lockHeld = true;
  const releaseLock = () => { if (lockHeld) { lockHeld = false; releaseInstallLock(lock); } };
  return new Promise(resolve => {
    let out = '', done = false, timedOut = false, childClosed = false;
    const exitWaiters = [];
    const spawnOpts = {windowsHide: true, cwd: os.homedir() || PKG_ROOT, env: {...process.env, npm_config_registry: REGISTRY_ORIGIN}};
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], spawnOpts);
    const finish = r => { if (done) return; done = true; clearTimeout(timer); if (!installStuck) { installRunning = false; releaseLock(); } resolve(r); };
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
      finish({ok: false, output: (out.trim() + '\nnpm did not finish in ' + Math.round(timeoutMs / 1000) + ' s and was stopped.').trim()});
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { childClosed = true; for (const w of exitWaiters.splice(0)) w(true); if (installStuck) { installStuck = false; installRunning = false; releaseLock(); } if (!timedOut) finish({ok: false, output: e.message}); });
    child.on('close', code => { childClosed = true; for (const w of exitWaiters.splice(0)) w(true); if (installStuck) { installStuck = false; installRunning = false; releaseLock(); } if (timedOut) return; if (code === 0 && version) { verifyInstalled(version, verifyCommand, spawnOpts).then(vr => finish(vr.ok ? {ok: true, output: out.trim()} : {ok: false, output: (out.trim() + '\n' + vr.output).trim()})); } else finish({ok: code === 0, output: out.trim()}); });
  });
}

module.exports = {enabled, devCheckout, newer, latest, install};
