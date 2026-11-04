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
    // wscript reads a script as ANSI (cp932 on Japanese Windows) unless it
    // carries a BOM, so a plain UTF-8 write garbled any non-ASCII path (a
    // Japanese user name, a Japanese install folder) and the logon launch
    // pointed at a path that does not exist. UTF-16LE with a BOM is the
    // encoding WSH detects as Unicode, so the paths survive as written.
    fs.writeFileSync(vbs, '\ufeff' + vbsContent(nodePath, binFile), 'utf16le');
    try {
      await run('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', 'wscript.exe "' + vbs + '"', '/F']);
      // Registered via the task now: drop any Run-key registration an earlier
      // (unelevated) run left behind, or both fire at logon and `muser serve`
      // starts twice. Best effort — the task alone already does the job.
      await run('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']).catch(() => {});
      return {on: true, task: TASK_NAME, vbs, via: 'task'};
    } catch (e) {
      // Creating even a per-user logon task needs elevation on some machines
      // (observed on the author's PC: access denied). The per-user Run key
      // starts the same hidden VBS at logon and needs no admin — use it as
      // the fallback rather than failing the feature. A task that an earlier
      // (elevated) run did register is removed first, for the same
      // double-start reason as above.
      await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']).catch(() => {});
      await run('reg', ['add', RUN_KEY, '/v', TASK_NAME, '/t', 'REG_SZ', '/d', 'wscript.exe "' + vbs + '"', '/f']);
      return {on: true, task: TASK_NAME, vbs, via: 'run-key'};
    }
  }
  // "Not there" is a successful off; a real removal failure (e.g. the task was
  // created elevated and this run may not delete it) is not: it used to be
  // swallowed while the VBS was still unlinked, leaving a registered task
  // pointing at a missing script that errored at every logon. Report it and
  // keep the launcher in place, so what remains registered still works.
  const notFound = e => /cannot find|could not find|unable to find|not found|見つかりません/i.test(String((e && (e.stderr || e.message)) || e || ''));
  const failed = [];
  await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']).catch(e => { if (!notFound(e)) failed.push('scheduled task'); });
  await run('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']).catch(e => { if (!notFound(e)) failed.push('Run key'); });
  if (failed.length) throw new Error('autostart off: could not remove the ' + failed.join(' and ') + ' registration; the launcher was left in place');
  try { fs.unlinkSync(vbs); } catch {}
  return {on: false, task: TASK_NAME};
}

module.exports = {TASK_NAME, vbsPath, vbsContent, setAutostart};
