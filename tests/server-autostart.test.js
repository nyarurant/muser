'use strict';
// Autostart + default cwd (FOCUS-WEAKNESSES.md #12): a server started at
// logon must run its default conversation in the home folder, not
// C:\WINDOWS\system32. Nothing here touches the real ~/.muser: every
// write goes to a temp home, and schtasks/reg are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const autostart = require('../src/server/autostart');
const {isWindowsSystemFolder, resolveDefaultCwd} = require('../src/server/default-cwd');

function tmpDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-autostart-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
function readVbs(file) { return fs.readFileSync(file, 'utf16le').replace(/^\ufeff/, ''); }

const WIN = {platform: 'win32', systemRoot: 'C:\\Windows'};

test('default cwd: Windows system folders become home, real folders stay', () => {
  const home = 'C:\\Users\\nyaru';
  assert.equal(resolveDefaultCwd('C:\\WINDOWS\\system32', home, WIN), home);
  assert.equal(resolveDefaultCwd('c:\\windows\\SYSTEM32\\', home, WIN), home);
  assert.equal(resolveDefaultCwd('C:\\Windows\\System32\\drivers', home, WIN), home);
  assert.equal(resolveDefaultCwd('C:\\Windows\\SysWOW64', home, WIN), home);
  assert.equal(resolveDefaultCwd('C:\\Windows', home, WIN), home);
  assert.equal(resolveDefaultCwd('C:\\Users\\nyaru\\muser', home, WIN), 'C:\\Users\\nyaru\\muser');
  assert.equal(resolveDefaultCwd('C:\\WindowsSystem32', home, WIN), 'C:\\WindowsSystem32');
  assert.equal(isWindowsSystemFolder('C:\\Windows\\system32', WIN), true);
  assert.equal(isWindowsSystemFolder('C:\\Users\\nyaru', WIN), false);
  assert.equal(resolveDefaultCwd('/usr/bin', home, {platform: 'darwin'}), '/usr/bin');
});

test('vbsContent sets the working folder to home before running serve hidden', () => {
  const home = 'C:\\Users\\nyaru';
  const vbs = autostart.vbsContent('C:\\node\\node.exe', 'C:\\muser\\bin\\muser.js', home);
  assert.match(vbs, /WScript\.Shell/);
  assert.ok(vbs.includes('sh.CurrentDirectory = "' + home + '"'));
  assert.match(vbs, /serve/);
  assert.match(vbs, /, 0, False/, 'window style 0 = hidden');
  assert.ok(vbs.indexOf('CurrentDirectory') < vbs.indexOf('sh.Run'), 'the folder is set before the launch');
  // The hidden console is a TTY to node: serve must be told it runs in the background,
  // before the launch, or it waits on a prompt nobody can see.
  assert.ok(vbs.includes('sh.Environment("PROCESS")("MUSER_BACKGROUND") = "1"'));
  assert.ok(vbs.indexOf('MUSER_BACKGROUND') < vbs.indexOf('sh.Run'), 'the variable is set before the launch');
});

test('setAutostart on writes a launcher whose working folder is home', async t => {
  const home = tmpDir(t);
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); };
  const on = await autostart.setAutostart(true, {binFile: 'C:\\muser\\bin\\muser.js', nodePath: 'C:\\node\\node.exe', home, platform: 'win32', run});
  assert.equal(on.task, 'muser-server');
  const vbsFile = path.join(home, '.muser', 'autostart.vbs');
  assert.ok(fs.existsSync(vbsFile));
  const content = readVbs(vbsFile);
  assert.ok(content.includes('sh.CurrentDirectory = "' + home + '"'));
  assert.equal(content, autostart.vbsContent('C:\\node\\node.exe', 'C:\\muser\\bin\\muser.js', home));
});

test('refreshAutostartVbs rewrites a stale launcher, leaves a current one alone, and never creates one', async t => {
  const home = tmpDir(t);
  const vbsFile = path.join(home, '.muser', 'autostart.vbs');
  const binFile = 'C:\\muser\\bin\\muser.js', nodePath = 'C:\\node\\node.exe';
  // No launcher (autostart off): nothing is created.
  const missing = autostart.refreshAutostartVbs({binFile, nodePath, home, platform: 'win32'});
  assert.equal(missing.rewritten, false);
  assert.equal(missing.reason, 'no launcher');
  assert.equal(fs.existsSync(vbsFile), false);
  // A launcher from before the fix (no CurrentDirectory line) is rewritten.
  const q = s => '"' + s + '"';
  const stale = 'Set sh = CreateObject("WScript.Shell")\r\n' + 'sh.Run ' + q(q(nodePath) + ' ' + q(binFile) + ' serve') + ', 0, False\r\n';
  fs.mkdirSync(path.dirname(vbsFile), {recursive: true});
  fs.writeFileSync(vbsFile, '\ufeff' + stale, 'utf16le');
  const fixed = autostart.refreshAutostartVbs({binFile, nodePath, home, platform: 'win32'});
  assert.equal(fixed.rewritten, true);
  assert.equal(readVbs(vbsFile), autostart.vbsContent(nodePath, binFile, home));
  // A current launcher is left alone.
  const before = readVbs(vbsFile);
  const again = autostart.refreshAutostartVbs({binFile, nodePath, home, platform: 'win32'});
  assert.equal(again.rewritten, false);
  assert.equal(readVbs(vbsFile), before);
  // Off the platform, nothing happens.
  const other = autostart.refreshAutostartVbs({binFile, nodePath, home, platform: 'linux'});
  assert.equal(other.rewritten, false);
  assert.equal(other.reason, 'non-windows');
});
