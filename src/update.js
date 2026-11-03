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
  return String((await r.json()).version || '');
}

// npm is a .cmd on Windows, which Node no longer spawns without a shell. A stuck npm (network,
// a lock) is stopped after timeoutMs, so /update can be tried again.
let installRunning = false, installStuck = false;
function install({timeoutMs = 5 * 60 * 1000, command = 'npm install -g ' + NAME + '@latest'} = {}) {
  // A previous install whose process could not be stopped is still holding the global install:
  // a second npm on top of it would race the same files, so retries are blocked until it exits.
  if (installStuck) return Promise.resolve({ok: false, output: 'A previous update could not be stopped and is still running; wait for it to finish before trying again.'});
  if (installRunning) return Promise.resolve({ok: false, output: 'An update is already running.'});
  installRunning = true;
  return new Promise(resolve => {
    let out = '', done = false, timedOut = false, childClosed = false;
    const exitWaiters = [];
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {windowsHide: true});
    const finish = r => { if (done) return; done = true; clearTimeout(timer); if (!installStuck) installRunning = false; resolve(r); };
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
    child.on('error', e => { childClosed = true; for (const w of exitWaiters.splice(0)) w(true); if (installStuck) { installStuck = false; installRunning = false; } if (!timedOut) finish({ok: false, output: e.message}); });
    child.on('close', code => { childClosed = true; for (const w of exitWaiters.splice(0)) w(true); if (installStuck) { installStuck = false; installRunning = false; } if (!timedOut) finish({ok: code === 0, output: out.trim()}); });
  });
}

module.exports = {enabled, devCheckout, newer, latest, install};
