'use strict';
// Fix phase 1 regression tests for src/policy.js (audit findings #1/#2/#4,
// deep C2/C3/H10/H11/H19, third C1, fourth H3). Each test names its finding.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {decide, alwaysKey, gitConfigRuns, gitInternalPath, muserSettingsPath} = require('../src/policy');

const stubConfig = () => '';
const plan = (command, extra = {}) => decide({mode: 'plan', kind: 'exec', params: {command}, gitConfig: stubConfig, ...extra});
const dflt = (command, extra = {}) => decide({mode: 'default', kind: 'exec', params: {command}, gitConfig: stubConfig, ...extra});
const tmp = (t, label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), label)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const fwd = p => p.replace(/\\/g, '/');
function gitInit(t) {
  const dir = tmp(t, 'muser-fix1-repo-');
  execFileSync('git', ['init', '-q', dir], {timeout: 30000});
  return dir;
}
function committedRepo(t, label, fileName) {
  const dir = tmp(t, label);
  execFileSync('git', ['init', '-q', dir], {timeout: 30000});
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'], {timeout: 30000});
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'], {timeout: 30000});
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], {timeout: 30000});
  fs.writeFileSync(path.join(dir, fileName), 'initial\n');
  execFileSync('git', ['-C', dir, 'add', '.'], {timeout: 30000});
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial'], {timeout: 30000});
  return dir;
}
function junction(t, target, link) {
  fs.symlinkSync(target, link, 'junction');
  t.after(() => { try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} } });
}

// #1: pattern searches whose (implicit or explicit) root holds a sensitive
// file dump its contents; patch output without a pathspec does the same.
test('#1 rg / git grep pattern search over a folder containing credentials.json asks', t => {
  const work = tmp(t, 'muser-fix1-rg-');
  fs.writeFileSync(path.join(work, 'credentials.json'), '{"api_key":"x"}');
  fs.writeFileSync(path.join(work, 'notes.txt'), 'api_key is mentioned here');
  assert.equal(plan('rg api_key', {cwd: work}), 'deny');
  assert.equal(dflt('rg api_key', {cwd: work}), 'ask');
  assert.equal(plan('git grep api_key', {cwd: work}), 'deny');
  // An explicit non-sensitive file restricts the search: stays read-only.
  assert.equal(plan('rg api_key notes.txt', {cwd: work}), 'allow');
  const clean = tmp(t, 'muser-fix1-clean-');
  fs.writeFileSync(path.join(clean, 'notes.txt'), 'hello');
  assert.equal(plan('rg hello', {cwd: clean}), 'allow', 'no sensitive file in root: plain rg stays allowed');
});

test('#1 git log -p / git show / git diff without pathspec downgrade only when the output includes a sensitive file (real repos)', t => {
  const sensitive = committedRepo(t, 'muser-fix1-sensitive-', 'credentials.json');
  const clean = committedRepo(t, 'muser-fix1-cleanrepo-', 'notes.txt');
  // Modify the committed files, so the working-tree diff names them too.
  fs.writeFileSync(path.join(sensitive, 'credentials.json'), 'changed\n');
  fs.writeFileSync(path.join(clean, 'notes.txt'), 'changed\n');
  // Sensitive repo: history (log -p / show) and the working-tree diff both
  // include credentials.json, so all three downgrade.
  assert.equal(plan('git log -p', {cwd: sensitive}), 'deny');
  assert.equal(dflt('git log -p', {cwd: sensitive}), 'ask');
  assert.equal(plan('git show HEAD', {cwd: sensitive}), 'deny');
  assert.equal(plan('git show', {cwd: sensitive}), 'deny');
  assert.equal(plan('git diff', {cwd: sensitive}), 'deny');
  assert.equal(plan('git diff HEAD', {cwd: sensitive}), 'deny');
  assert.equal(dflt('git diff', {cwd: sensitive}), 'ask');
  // Clean repo: the same commands touch only notes.txt and stay allowed
  // (the SEC3 shape: `git show HEAD` in a repo whose HEAD is clean).
  assert.equal(plan('git log -p', {cwd: clean}), 'allow');
  assert.equal(plan('git show HEAD', {cwd: clean}), 'allow');
  assert.equal(plan('git show', {cwd: clean}), 'allow');
  assert.equal(plan('git diff', {cwd: clean}), 'allow');
  assert.equal(plan('git diff HEAD', {cwd: clean}), 'allow');
  assert.equal(dflt('git diff', {cwd: clean}), 'allow');
  // Plain read-only commands are unchanged.
  assert.equal(plan('git status'), 'allow');
  assert.equal(plan('git log --oneline'), 'allow');
  // A non-sensitive pathspec / rev:path restricts the output.
  assert.equal(plan('git diff -- src/policy.js'), 'allow');
  assert.equal(plan('git log -p -- src/policy.js'), 'allow');
  assert.equal(plan('git show HEAD:src/policy.js'), 'allow');
});

// #2: the attached -L<range>:<path> form must be screened like the split form.
test('#2 git log -L1,100:credentials.json (attached) asks', () => {
  assert.equal(plan('git log -L1,100:credentials.json'), 'deny');
  assert.equal(plan('git log -L 1,100:credentials.json'), 'deny');
  assert.equal(dflt('git log -L1,100:credentials.json'), 'ask');
  assert.equal(plan('git log -L1,100:src/policy.js'), 'allow', 'a non-sensitive -L path stays read-only');
});

// #4: a command downgraded by readsSecrets / repo-config must not be let
// through by a remembered always-key; mutating git config/remote/branch must
// not share the listing key.
test('#4 downgraded read-only commands are not allowed by a remembered key', () => {
  const logAlways = new Set([alwaysKey('exec', {command: 'git log'})]);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git log -p -- credentials.json'}, always: logAlways, gitConfig: stubConfig}), 'ask');
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git log --oneline'}, always: logAlways, gitConfig: stubConfig}), 'allow', 'the remembered plain log still works');
  const statusAlways = new Set([alwaysKey('exec', {command: 'git status'})]);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git status'}, always: statusAlways, gitConfig: () => 'core.fsmonitor=evil.exe'}), 'ask', 'repo-config downgrade beats the remembered key');
});

test('#4 git config/remote/branch mutations do not ride the listing key', () => {
  const branchAlways = new Set(['exec:git branch']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git branch -D main'}, always: branchAlways, gitConfig: stubConfig}), 'ask');
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git branch new-feature'}, always: branchAlways, gitConfig: stubConfig}), 'ask');
  const remoteAlways = new Set(['exec:git remote']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git remote add evil https://example.invalid/x'}, always: remoteAlways, gitConfig: stubConfig}), 'ask');
  const configAlways = new Set(['exec:git config']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git config core.fsmonitor evil.exe'}, always: configAlways, gitConfig: stubConfig}), 'ask');
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git config --list'}, always: configAlways, gitConfig: stubConfig}), 'ask', 'git config is never key-allowed: listing and setting share the key');
});

// Deep C2: the git-lfs exemption must match the whole value; a value with
// extra lines must not be exempted.
test('C2 gitConfigRuns: lfs exemption is exact and multi-line values run', () => {
  assert.equal(gitConfigRuns('filter.lfs.clean=git-lfs clean -- %f'), false);
  assert.equal(gitConfigRuns('filter.lfs.smudge=git-lfs smudge -- %f'), false);
  assert.equal(gitConfigRuns('filter.lfs.process=git-lfs filter-process'), false);
  assert.equal(gitConfigRuns('filter.lfs.clean=git-lfs clean -- %f && C:\\evil\\payload.exe'), true);
  assert.equal(gitConfigRuns('filter.lfs.smudge=git-lfs smudge -- %f extra'), true);
  assert.equal(gitConfigRuns('filter.lfs.process=git-lfs filter-process --skip'), true);
  assert.equal(gitConfigRuns('core.fsmonitor=true\nC:\\evil\\payload.exe'), true, 'second line of an fsmonitor value is not exempt');
  assert.equal(gitConfigRuns('core.fsmonitor=true'), false);
});

// Deep C3: extensions.worktreeConfig=true is itself a danger signal, and
// repoGitConfig must enumerate the worktree config (real repo).
test('C3 gitConfigRuns flags extensions.worktreeConfig=true only', () => {
  assert.equal(gitConfigRuns('extensions.worktreeconfig=true'), true);
  assert.equal(gitConfigRuns('extensions.worktreeconfig=false'), false);
});

test('C3 a planted core.fsmonitor in config.worktree makes git status ask (real repo)', t => {
  const dir = gitInit(t);
  execFileSync('git', ['-C', dir, 'config', 'extensions.worktreeConfig', 'true'], {timeout: 30000});
  execFileSync('git', ['-C', dir, 'config', '--worktree', 'core.fsmonitor', 'echo pwned > pwned.txt'], {timeout: 30000});
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git status'}, cwd: dir}), 'ask');
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: 'git status'}, cwd: dir}), 'deny');
  assert.equal(fs.existsSync(path.join(dir, 'pwned.txt')), false, 'checking ran nothing');
});

// Deep H10: under shell:'cmd', %VAR% expansion must not be read-only-safe.
test('H10 cmd.exe %VAR% expansion downgrades a read-only command', t => {
  const work = tmp(t, 'muser-fix1-cmd-');
  const cmd = 'rg -e . %USERPROFILE%\\Documents';
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: cmd, shell: 'cmd'}, cwd: work, gitConfig: stubConfig}), 'deny');
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: cmd, shell: 'cmd'}, cwd: work, gitConfig: stubConfig}), 'ask');
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: cmd, shell: 'powershell'}, cwd: work, gitConfig: stubConfig}), 'allow', 'powershell does not expand %VAR%');
  const always = new Set(['exec:rg -e']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: cmd, shell: 'cmd'}, cwd: work, always, gitConfig: stubConfig}), 'ask');
});

// Deep H11: path checks resolve junctions/symlinks to their real target.
test('H11 readsSecrets: a junction search root pointing outside asks', t => {
  const outside = tmp(t, 'muser-fix1-out-');
  fs.writeFileSync(path.join(outside, 'credentials.json'), '{"api_key":"x"}');
  const work = tmp(t, 'muser-fix1-proj-');
  junction(t, outside, path.join(work, 'linkdir'));
  assert.equal(plan('rg api_key linkdir', {cwd: work}), 'deny');
});

test('H11 settings / .git protection follows junctions; remembered-key here follows the real cwd', t => {
  const home = os.homedir();
  const settingsDir = path.join(home, '.muser');
  fs.mkdirSync(settingsDir, {recursive: true});
  const settingsFile = path.join(settingsDir, 'fix1-config.json');
  fs.writeFileSync(settingsFile, '{}');
  t.after(() => fs.rmSync(settingsFile, {force: true}));
  const work = tmp(t, 'muser-fix1-links-');
  junction(t, settingsDir, path.join(work, 'settingslink'));
  const viaLink = path.join(work, 'settingslink', 'fix1-config.json');
  assert.equal(muserSettingsPath(viaLink), true);
  assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {path: viaLink}, outside: false, targets: [viaLink]}), 'ask');

  const repoLike = tmp(t, 'muser-fix1-gitdir-');
  fs.mkdirSync(path.join(repoLike, '.git'));
  junction(t, path.join(repoLike, '.git'), path.join(work, 'gitlink'));
  const gitViaLink = path.join(work, 'gitlink', 'config');
  assert.equal(gitInternalPath(gitViaLink), true);
  assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {path: gitViaLink}, outside: false, targets: [gitViaLink]}), 'ask');

  const other = tmp(t, 'muser-fix1-other-');
  junction(t, other, path.join(work, 'linkedproj'));
  const always = new Set(['exec:npm test']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'npm test'}, always, cwd: path.join(work, 'linkedproj'), root: work}), 'ask', 'a remembered key does not cross a junction into another project');
  const sub = path.join(work, 'sub'); fs.mkdirSync(sub);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'npm test'}, always, cwd: sub, root: work}), 'allow', 'a real subfolder keeps the remembered key');
});

// Third C1: glob patterns that could match a sensitive basename must ask,
// even when stripping the wildcards leaves a harmless-looking prefix.
test('C1 glob partial matches against sensitive names ask', () => {
  assert.equal(plan('git grep .* -- credential*'), 'deny');
  assert.equal(plan('rg --glob=credential* .*'), 'deny');
  assert.equal(plan('git grep .* -- .en*'), 'deny');
  assert.equal(dflt('rg --glob=credential* .*'), 'ask');
  assert.equal(plan('git grep .* -- *.js'), 'allow', 'a glob that cannot match a sensitive name stays read-only');
});

// Fourth H3: a remembered MCP key is by tool name only; args pointing at
// protected paths must still ask.
test('H3 remembered MCP tool asks when args reference .git / ~/.muser / sensitive paths', () => {
  const always = new Set(['mcp:write_file']);
  const home = os.homedir();
  const mcp = (params) => decide({mode: 'default', kind: 'mcp', command: 'write_file', params, always});
  assert.equal(mcp({arguments: {path: '.git/hooks/pre-commit', content: 'x'}}), 'ask');
  assert.equal(mcp({arguments: {path: fwd(path.join(home, '.muser', 'permissions.json'))}}), 'ask');
  assert.equal(mcp({path: '~/.muser/mcp.json'}), 'ask');
  assert.equal(mcp({arguments: {files: ['src/notes.txt', 'credentials.json']}}), 'ask');
  assert.equal(mcp({arguments: {path: 'src/notes.txt', content: 'hello'}}), 'allow', 'benign args keep the remembered allow');
  assert.equal(decide({mode: 'default', kind: 'mcp', command: 'write_file', params: {arguments: {path: '.git/config'}}}), 'ask', 'unremembered still asks');
});

// Deep H19 (test gap): the REAL repoGitConfig path (no stub) must find a
// planted core.fsmonitor for `git -C <repo>` and `--git-dir` forms alike.
test('H19 real repoGitConfig: git -C / --git-dir find a planted core.fsmonitor', t => {
  // The repo sits INSIDE the session cwd, so readsSecrets' outside-root rule
  // cannot mask whether repoGitConfig itself found the planted config.
  const elsewhere = tmp(t, 'muser-fix1-else-');
  const repo = path.join(elsewhere, 'repo');
  execFileSync('git', ['init', '-q', repo], {timeout: 30000});
  const viaC = `git -C ${fwd(repo)} status`;
  const viaGitDir = `git --git-dir ${fwd(path.join(repo, '.git'))} status`;
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: viaC}, cwd: elsewhere}), 'allow', 'clean repo: -C form is allowed');
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', 'echo pwned > pwned.txt'], {timeout: 30000});
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: viaC}, cwd: elsewhere}), 'ask');
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: viaGitDir}, cwd: elsewhere}), 'ask');
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: viaC}, cwd: elsewhere}), 'deny');
  assert.equal(fs.existsSync(path.join(repo, 'pwned.txt')), false, 'checking ran nothing');
});
