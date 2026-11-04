'use strict';
// Fix phase 2 regression tests for src/policy.js (deep c22 #5/#6, first #17,
// fourth M1/M2/M3 policy parts, third f1 U+2028/U+2029 candidate). Tests for
// items phase 1 had already fixed are marked lock-in: they passed before
// this phase too and guard against regression.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {decide, alwaysKey, readOnlyCommand, gitInternalPath, muserSettingsPath} = require('../src/policy');

const stubConfig = () => '';
const tmp = (t, label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), label)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
// The UNC admin-share spelling of an absolute local path (C:\a\b -> \\host\C$\a\b).
const uncOf = (abs, host) => '\\\\' + host + '\\' + abs.charAt(0) + '$\\' + abs.slice(3);

// Deep c22 #5: RUNS_ANYTHING was matched against the first token as typed, so
// a path-form interpreter (powershell.exe by full path, .\powershell.exe,
// C:powershell.exe) was remembered like an ordinary program, and one benign
// second word then covered every later call with that second word.
test('fix2 c22#5: a path-form interpreter is never remembered', () => {
  for (const c of [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe Get-Date',
    '.\\powershell.exe Get-Date',
    './powershell.exe Get-Date',
    'C:powershell.exe Get-Date',
    'C:\\tools\\pwsh.exe Get-Date',
    'C:/tools/node.exe build',
    '..\\bin\\python.exe run',
    '/usr/bin/python3 run',
  ]) assert.equal(alwaysKey('exec', {command: c}), null, c);
  // A key an older build could have saved for the path form must not allow it now.
  const stale = new Set(['exec:c:\\windows\\system32\\windowspowershell\\v1.0\\powershell get-date']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe Get-Date'}, always: stale, gitConfig: stubConfig}), 'ask');
  // Controls: ordinary programs keep their keys, path-form ones keep a
  // path-qualified key (unchanged), bare interpreters were already refused.
  assert.equal(alwaysKey('exec', {command: 'C:\\tools\\npm.cmd ls'}), 'exec:c:\\tools\\npm ls');
  assert.equal(alwaysKey('exec', {command: 'npm ls'}), 'exec:npm ls');
  assert.equal(alwaysKey('exec', {command: 'powershell Get-Date'}), null);
});

// Deep c22 #6 (lock-in; fixed in phase 1): gitInternalPath covers bare
// repositories (repo.git/…) and Windows trailing dot/space spellings, not
// just a literal .git segment.
test('fix2 c22#6 (lock-in): gitInternalPath covers bare repos and trailing dot/space', () => {
  for (const f of ['repo/.git/config', 'backup.git/config', 'backup.git/hooks/pre-commit', 'repo/.git./config', 'repo/.git /hooks/x'])
    assert.equal(gitInternalPath(f), true, f);
  assert.equal(gitInternalPath('src/app.js'), false);
  assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {path: 'backup.git/config'}, outside: false, targets: ['backup.git/config']}), 'ask');
});

// First #17: muserSettingsPath knew only the two fixed roots, so an approval
// store relocated with MUSER_PERMISSIONS_FILE (here: into the project) was
// not a settings path at all and auto-edit rewrote it unasked.
test('fix2 first#17: the relocated approval store is a settings path', (t) => {
  const dir = tmp(t, 'muser-fix2-perm-');
  const perm = path.join(dir, 'permissions.json');
  const prev = process.env.MUSER_PERMISSIONS_FILE;
  process.env.MUSER_PERMISSIONS_FILE = perm;
  try {
    assert.equal(muserSettingsPath(perm), true);
    assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {path: perm}, outside: false, targets: [perm], cwd: dir, root: dir}), 'ask');
    // Alias spellings of the same store: a trailing-dot directory segment
    // and the UNC admin-share form.
    assert.equal(muserSettingsPath(dir + '.\\permissions.json'), true, 'trailing-dot directory spelling');
    assert.equal(muserSettingsPath(uncOf(perm, 'localhost')), true, 'UNC spelling');
    // A sibling file in the same folder is not the store.
    const other = path.join(dir, 'notes.txt');
    assert.equal(muserSettingsPath(other), false);
    assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {path: other}, outside: false, targets: [other], cwd: dir, root: dir}), 'allow');
  } finally {
    if (prev === undefined) delete process.env.MUSER_PERMISSIONS_FILE; else process.env.MUSER_PERMISSIONS_FILE = prev;
  }
});

// Fourth M1 (policy part): the settings roots in UNC admin-share spelling
// (\\localhost\C$\…, \\127.0.0.1\C$\…, \\?\UNC\…) matched no C: root, so
// muserSettingsPath said no. A remote host's share is a different machine
// and must stay no.
test('fix2 fourth M1: UNC admin-share spellings of the settings roots match', () => {
  const home = os.homedir();
  const plain = path.join(home, '.muser', 'permissions.json');
  assert.equal(muserSettingsPath(plain), true, 'control: plain spelling');
  for (const host of ['localhost', '127.0.0.1', os.hostname()])
    assert.equal(muserSettingsPath(uncOf(plain, host)), true, 'UNC via ' + host);
  assert.equal(muserSettingsPath('\\\\?\\UNC\\localhost\\' + plain.charAt(0) + '$\\' + plain.slice(3)), true, '\\\\?\\UNC form');
  assert.equal(muserSettingsPath(uncOf(plain, 'otherhost')), false, 'a remote host is not this machine');
  const local = process.env.LOCALAPPDATA;
  if (local && /^[a-z]:/i.test(local)) {
    const lp = path.join(local, 'muser', 'permissions.json');
    assert.equal(muserSettingsPath(uncOf(lp, 'localhost')), true, 'UNC via LOCALAPPDATA root');
  }
});

// Fourth M2: a trailing dot/space on the settings DIRECTORY segment
// (…\muser.\permissions.json, …\.muser \config.json) defeated the
// containment check while the file part alone was already handled.
test('fix2 fourth M2: trailing dot/space on the settings directory still asks', () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const seg of ['muser.', 'muser ']) {
    const f = path.join(local, seg, 'permissions.json');
    assert.equal(muserSettingsPath(f), true, seg);
    assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {path: f}, outside: false, targets: [f], cwd: local, root: local}), 'ask', seg);
  }
  assert.equal(muserSettingsPath(path.join(os.homedir(), '.muser.', 'config.json')), true, 'home .muser. directory');
  // Controls: lookalike names are not the settings folder.
  assert.equal(muserSettingsPath(path.join(local, 'muser2', 'permissions.json')), false);
  assert.equal(muserSettingsPath(path.join(os.homedir(), '.muser2', 'config.json')), false);
});

// Fourth M3 (policy part, lock-in; fixed in phase 1 by the real-path check):
// an 8.3 short name for a settings DIRECTORY resolves to its long name, so
// the store under it is still a settings path. Skips itself when this
// volume hands out no short name for the fixture.
test('fix2 fourth M3 (lock-in): an 8.3 directory alias of the settings root matches', (t) => {
  const base = tmp(t, 'muser-fix2-83-');
  const longLocal = path.join(base, 'verylonglocalappdata');
  fs.mkdirSync(path.join(longLocal, 'muser'), {recursive: true});
  const file = path.join(longLocal, 'muser', 'permissions.json');
  fs.writeFileSync(file, '{}');
  let short = '';
  try {
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', base], {encoding: 'utf8', windowsHide: true, timeout: 30000});
    const m = /(\S+~\S*)\s+verylonglocalappdata\b/i.exec(listing);
    if (m) short = path.join(base, m[1], 'muser', 'permissions.json');
  } catch {}
  if (!short) { t.skip('no 8.3 alias on this volume'); return; }
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = longLocal;
  try {
    assert.equal(muserSettingsPath(file), true, 'control: long spelling');
    assert.equal(muserSettingsPath(short), true, '8.3 spelling: ' + short);
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev;
  }
});

// Third audit f1 (unconfirmed Medium candidate): U+2028/U+2029 are line
// terminators in PowerShell's grammar, but tokensOf treated them as plain
// whitespace, so `git status<LS>Remove-Item …` screened as read-only and
// `npm test<LS>…` took the plain npm-test key. Fail closed on both.
test('fix2 third f1: U+2028/U+2029 never hide a second command', () => {
  assert.equal(readOnlyCommand('git status\u2028Remove-Item x'), false);
  assert.equal(readOnlyCommand('git status\u2029Remove-Item x'), false);
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: 'git status\u2028Remove-Item x'}, gitConfig: stubConfig}), 'deny');
  assert.equal(alwaysKey('exec', {command: 'npm test\u2028Remove-Item x'}), null);
  assert.equal(alwaysKey('exec', {command: 'npm test\u2029Remove-Item x'}), null);
  assert.equal(readOnlyCommand('git status'), true, 'control');
});
