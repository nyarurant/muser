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
  try { if (JSON.parse(fs.readFileSync(configFile, 'utf8'))?.updateCheck === false) return false; } catch {}
  return !devCheckout(root) || env.MUSER_UPDATE_CHECK === '1';
}

// Is version a newer than b? Plain x.y.z; a pre-release (0.4.0-beta) is never offered.
function newer(a, b) {
  const parse = v => /^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null;
  const x = parse(a), y = parse(String(b).split('-')[0]);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

async function latest({timeoutMs = 5000} = {}) {
  const r = await fetch(REGISTRY, {signal: AbortSignal.timeout(timeoutMs), headers: {accept: 'application/json'}});
  if (!r.ok) throw new Error('npm registry: HTTP ' + r.status);
  return String((await r.json()).version || '');
}

// npm is a .cmd on Windows, which Node no longer spawns without a shell. A stuck npm (network,
// a lock) is stopped after timeoutMs, so /update can be tried again.
function install({timeoutMs = 5 * 60 * 1000, command = 'npm install -g ' + NAME + '@latest'} = {}) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {windowsHide: true});
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { require('node:child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true}); } catch {}
      finish({ok: false, output: (out.trim() + '\nnpm did not finish in ' + Math.round(timeoutMs / 1000) + ' s and was stopped.').trim()});
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => finish({ok: false, output: e.message}));
    child.on('close', code => finish({ok: code === 0, output: out.trim()}));
  });
}

module.exports = {enabled, devCheckout, newer, latest, install};
