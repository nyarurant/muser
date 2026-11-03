'use strict';
// `muser server autostart on/off` (remote/SERVER.md step 1): a hidden logon task
// that starts `muser serve`, so the phone/GUI find the resident server whenever the
// PC is on. Windows only: the scheduled task runs a small VBS launcher because
// schtasks cannot start a console program hidden by itself; the VBS uses
// WScript.Shell.Run with window style 0. The runner is injectable for tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');

const TASK_NAME = 'muser-server';

function vbsPath(home = os.homedir()) { return path.join(home, '.muser', 'autostart.vbs'); }

function vbsContent(nodePath, binFile) {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  return 'Set sh = CreateObject("WScript.Shell")\r\n' +
    'sh.Run ' + q(q(nodePath) + ' ' + q(binFile) + ' serve') + ', 0, False\r\n';
}

function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {windowsHide: true, encoding: 'utf8'}, (err, stdout, stderr) => err ? reject(Object.assign(err, {stderr})) : resolve(stdout));
  });
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

async function setAutostart(on, {binFile, nodePath = process.execPath, home = os.homedir(), platform = process.platform, run = defaultRun} = {}) {
  if (platform !== 'win32') throw new Error('autostart is Windows-only');
  if (!binFile) throw new Error('binFile is required');
  const vbs = vbsPath(home);
  if (on) {
    fs.mkdirSync(path.dirname(vbs), {recursive: true});
    fs.writeFileSync(vbs, vbsContent(nodePath, binFile));
    try {
      await run('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', 'wscript.exe "' + vbs + '"', '/F']);
      return {on: true, task: TASK_NAME, vbs, via: 'task'};
    } catch (e) {
      // Creating even a per-user logon task needs elevation on some machines
      // (observed on the author's PC: access denied). The per-user Run key
      // starts the same hidden VBS at logon and needs no admin — use it as
      // the fallback rather than failing the feature.
      await run('reg', ['add', RUN_KEY, '/v', TASK_NAME, '/t', 'REG_SZ', '/d', 'wscript.exe "' + vbs + '"', '/f']);
      return {on: true, task: TASK_NAME, vbs, via: 'run-key'};
    }
  }
  await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']).catch(() => {});
  await run('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']).catch(() => {});
  try { fs.unlinkSync(vbs); } catch {}
  return {on: false, task: TASK_NAME};
}

module.exports = {TASK_NAME, vbsPath, vbsContent, setAutostart};
