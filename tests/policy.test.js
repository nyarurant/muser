'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {decide, alwaysKey, readOnlyCommand} = require('../src/policy');

const ro = (c) => assert.equal(readOnlyCommand(c), true, c);
const notRo = (c) => assert.equal(readOnlyCommand(c), false, c);

test('legit git reads stay read-only', () => {
  for (const c of [
    'git status', 'git status --short', 'git status -s', 'git status --porcelain', 'git status -sb',
    'git -C C:/work/repo status', 'git --no-pager log --oneline',
    'git log', 'git log --oneline', 'git log --oneline -5', 'git log -n 5', 'git log --max-count=5',
    'git log --graph --all --oneline', 'git log --stat', 'git log --since=2026-01-01', 'git log --format=%H',
    'git log HEAD~3..HEAD', 'git show', 'git show HEAD', 'git show --stat HEAD', 'git show HEAD:src/policy.js',
    'git diff', 'git diff --cached', 'git diff --staged', 'git diff --stat', 'git diff HEAD', 'git diff --no-ext-diff',
    'git diff -- src/policy.js', 'git diff -U3', 'git blame src/policy.js', 'git blame -L 1,10 src/policy.js',
    'git ls-files', 'git ls-files --cached --others --exclude-standard', 'git rev-parse HEAD',
    'git rev-parse --abbrev-ref HEAD', 'git rev-parse --show-toplevel', 'git rev-parse --git-dir',
    'git describe', 'git describe --tags', 'git describe --tags --always --long', 'git describe --abbrev=7',
    'git shortlog', 'git shortlog -sn', 'git shortlog --summary --numbered',
    'git grep TODO', 'git grep -n TODO', 'git grep --line-number TODO src', 'git grep -i --fixed-strings todo',
    'git remote', 'git remote -v', 'git remote --verbose',
  ]) ro(c);
});

test('legit tool reads stay read-only', () => {
  for (const c of [
    'rg TODO', 'rg -n TODO src', 'rg --files', 'rg --ignore-case todo .', 'rg -i -F todo',
    'rg --max-count 2 TODO', 'rg --glob *.js TODO', 'rg --type js TODO',
    'node --version', 'node -v', 'python --version',
    'npm ls', 'npm ls --depth=0', 'npm ls -g', 'npm ls --json', 'npm view react', 'npm view react version',
    'npm view react --json', 'npm outdated', 'npm outdated --json',
  ]) ro(c);
});

test('git branch is read-only only as a listing, with no positional name', () => {
  for (const c of [
    'git branch', 'git branch -l', 'git branch --list', 'git branch -a', 'git branch -r', 'git branch -v',
    'git branch -vv', 'git branch -a -l', 'git branch -la', 'git branch --all', 'git branch --remotes',
    'git branch --verbose', 'git branch --show-current',
  ]) ro(c);
  for (const c of [
    'git branch new-feature', 'git branch --list new-feature', 'git branch main',
    'git branch -D main', 'git branch -d main', 'git branch --delete main', 'git branch --delete --force main',
    'git branch -m old new', 'git branch -M old new', 'git branch --move old new',
    'git branch -c old new', 'git branch -C old new', 'git branch --copy old new',
    'git branch -f main HEAD', 'git branch --force main', 'git branch -u origin/main',
    'git branch --set-upstream-to=origin/main', 'git branch --track new-feature', 'git branch --edit-description',
    'git branch --unset-upstream', 'git branch -a extra',
  ]) notRo(c);
});

test('git flags that run helpers or write files are not read-only', () => {
  for (const c of [
    'git diff --ext-diff', 'git diff --textconv', 'git diff --output=out.txt', 'git diff --output out.txt',
    'git show --ext-diff HEAD', 'git show --textconv HEAD', 'git show --output=out.txt HEAD',
    'git log --output=out.txt', 'git log --output out.txt', 'git log --ext-diff', 'git log --textconv',
    'git log --pager', 'git diff --pager=less', 'git show --pager HEAD',
    'git grep -O TODO', 'git grep -Oless TODO', 'git grep -nO TODO', 'git grep --open-files-in-pager TODO',
    'git grep --open-files-in-pager=less TODO', 'git grep --pager TODO', 'git grep --pager=less TODO',
    'git -c core.pager=evil log', 'git -c diff.external=evil diff', 'git -c core.fsmonitor=evil status',
    'git --config-env core.pager=FOO log', 'git -p log', 'git --paginate log',
  ]) notRo(c);
});

test('embedded newline / CR can never hide a second command', () => {
  notRo('git status\nRemove-Item -Recurse .');
  notRo('git status\rRemove-Item .');
  notRo('git status\r\ngit push');
  notRo('rg TODO\nmalicious');
  notRo('npm ls\ndel /q .');
});

test('shell metacharacters and PowerShell syntax are not read-only', () => {
  for (const c of [
    'git status; git push', 'git status | tee out.txt', 'git log && git push', 'git log || git push',
    'git diff > out.txt', 'git diff >> out.txt', 'git log < input.txt', 'git status & git push',
    'git log $(git push)', 'git log `git push`', 'git log $HOME', 'git status ${HOME}',
    'git log (HEAD)', 'git log {HEAD}', 'git show HEAD@{1}', 'git status # comment',
    'git log --format="%H"', "git log --format='%H'", 'git log "HEAD"', 'rg "two words"',
    'git status [abc]', 'npm ls; npm install evil', 'node --version; del x',
  ]) notRo(c);
});

test('mutating or unknown git subcommands and programs fail closed', () => {
  for (const c of [
    'git push', 'git push origin main', 'git commit -m x', 'git add .', 'git checkout main', 'git switch main',
    'git restore .', 'git reset --hard', 'git clean -fd', 'git stash', 'git pull', 'git fetch', 'git merge main',
    'git rebase main', 'git rm file', 'git mv a b', 'git config user.name x', 'git init', 'git clone https://x',
    'git tag v1', 'git unknowncmd', 'git', 'git --version',
    'echo hi', 'dir', 'ls', 'cat file.txt', 'Get-ChildItem', 'Get-Date', 'powershell Get-Date',
    'cmd /c dir', 'sudo git status', './git status', 'env git status',
    'GIT_EXTERNAL_DIFF=evil git diff', 'GIT_PAGER=evil git log', 'PAGER=evil git log',
    '', '   ', 'npm', 'rg', 'node', 'git status --unknown-flag', 'git log --frobnicate', 'rg --frobnicate x',
  ]) notRo(c);
  assert.equal(readOnlyCommand(), false);
  assert.equal(readOnlyCommand(null), false);
});

test('rg flags that run a preprocessor are not read-only', () => {
  for (const c of [
    'rg --pre=evil TODO', 'rg --pre evil TODO', 'rg --pre-glob=*.pdf TODO', 'rg --pre-glob *.pdf TODO',
    'rg --hostname-bin=evil TODO',
  ]) notRo(c);
});

test('npm / node are read-only only for the listed forms', () => {
  for (const c of [
    'npm run build', 'npm exec evil', 'npm install', 'npm i react', 'npm ci', 'npm test', 'npm publish',
    'npm uninstall react', 'npm update', 'npm audit fix', 'npm ls --frobnicate', 'npm view react --frobnicate',
    'node script.js', 'node -e console.log(1)', 'node --version extra', 'node --eval x', 'python script.py',
    'python -c pass', 'python --version extra',
  ]) notRo(c);
});

test('alwaysKey narrows exec by a plain subcommand word', () => {
  assert.equal(alwaysKey('edit', {path: 'x'}), 'edit');
  assert.equal(alwaysKey('mcp', {}, 'some_tool'), 'mcp:some_tool');
  assert.equal(alwaysKey('exec', {command: 'npm ls'}), 'exec:npm ls');
  assert.equal(alwaysKey('exec', {command: 'npm ls --depth=0'}), 'exec:npm ls');
  assert.equal(alwaysKey('exec', {command: 'npm exec evil'}), 'exec:npm exec');
  assert.notEqual(alwaysKey('exec', {command: 'npm ls'}), alwaysKey('exec', {command: 'npm exec evil'}));
  assert.equal(alwaysKey('exec', {command: 'npm run build'}), 'exec:npm run');
  assert.equal(alwaysKey('exec', {command: 'npm install react'}), 'exec:npm install');
  assert.equal(alwaysKey('exec', {command: 'git status'}), 'exec:git status');
  assert.equal(alwaysKey('exec', {command: 'git push origin main'}), 'exec:git push');
  assert.equal(alwaysKey('exec', {command: 'git commit -m x'}), 'exec:git commit');
  assert.notEqual(alwaysKey('exec', {command: 'git status'}), alwaysKey('exec', {command: 'git push'}));
  // A flag or a value is not a subcommand, so the key stays at the program.
  assert.equal(alwaysKey('exec', {command: 'node --version'}), null, 'node runs anything: never remembered');
  assert.equal(alwaysKey('exec', {command: 'git -C C:/repo status'}), null, 'subcommand not where it can be told');
  assert.equal(alwaysKey('exec', {command: 'npm'}), 'exec:npm');
  assert.equal(alwaysKey('exec', {command: '  NPM   LS  '}), 'exec:npm ls');
  assert.equal(alwaysKey('exec', {command: ''}), null);
  assert.equal(alwaysKey('read', {command: 'npm ls'}), null);
});

test('decide: plan mode allows only provably read-only exec', () => {
  const d = (mode, kind, command, extra = {}) => decide({mode, kind, command, params: {command}, ...extra});
  assert.equal(d('plan', 'exec', 'git status'), 'allow');
  assert.equal(d('plan', 'exec', 'git log --oneline'), 'allow');
  assert.equal(d('plan', 'exec', 'npm ls'), 'allow');
  assert.equal(d('plan', 'exec', 'npm run build'), 'deny');
  assert.equal(d('plan', 'exec', 'echo hi'), 'deny');
  assert.equal(d('plan', 'exec', 'Get-ChildItem'), 'deny');
  assert.equal(d('plan', 'exec', 'git push'), 'deny');
  assert.equal(d('plan', 'exec', 'git branch new-feature'), 'deny');
  assert.equal(d('plan', 'exec', 'git diff --ext-diff'), 'deny');
  assert.equal(d('plan', 'exec', 'git status\n git push'), 'deny');
  assert.equal(d('plan', 'edit', ''), 'deny');
  assert.equal(decide({mode: 'plan', kind: 'mcp', command: 'tool_x', params: {}}), 'deny');
  assert.equal(decide({mode: 'plan', kind: 'read', params: {}}), 'allow');
});

test('decide: remembered exec keys are per-subcommand', () => {
  const always = new Set([alwaysKey('exec', {command: 'npm ls'})]);
  const d = (command) => decide({mode: 'default', kind: 'exec', params: {command}, always});
  assert.equal(d('npm ls'), 'allow');
  assert.equal(d('npm exec evil'), 'ask');
  assert.equal(d('npm run build'), 'ask');
  assert.equal(d('npm install react'), 'ask');
  const gitAlways = new Set([alwaysKey('exec', {command: 'git status'})]);
  const g = (command) => decide({mode: 'default', kind: 'exec', params: {command}, always: gitAlways});
  assert.equal(g('git status'), 'allow');
  assert.equal(g('git push'), 'ask');
  assert.equal(g('git commit -m x'), 'ask');
});

test('decide: other modes keep their shape', () => {
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git status'}}), 'allow');
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'npm run build'}}), 'ask');
  assert.equal(decide({mode: 'bypass', kind: 'exec', params: {command: 'npm run build'}}), 'allow');
  assert.equal(decide({mode: 'bypass', kind: 'edit', params: {}, outside: true}), 'allow');
  assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {}, outside: false}), 'allow');
  assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {}, outside: true}), 'ask');
  assert.equal(decide({mode: 'default', kind: 'read', params: {}}), 'allow');
  assert.equal(decide({mode: 'default', kind: 'mcp', command: 'tool_x', params: {}}), 'ask');
  assert.equal(decide({mode: 'default', kind: 'mcp', command: 'tool_x', params: {}, always: new Set(['mcp:tool_x'])}), 'allow');
});

// 2026-11-01: a remembered "npm test" let `npm test && Remove-Item -Recurse …` run unasked, and a
// remembered "powershell -File x" let any `powershell -Command …` run.
test('remembered commands never cover chained commands or programs that run anything', () => {
  for (const c of ['npm test && Remove-Item -Recurse -Force C:/x', 'npm test; del x', 'npm test | Out-File x', 'npm test > x', 'git status $(evil)', 'npm test `n evil'])
    assert.equal(alwaysKey('exec', {command: c}), null, c);
  for (const c of ['powershell -Command x', 'powershell Remove-Item x', 'pwsh -c x', 'cmd /c del x', 'node -e x', 'node build', 'python -c x', 'npx something', 'Start-Process x', 'iex x'])
    assert.equal(alwaysKey('exec', {command: c}), null, c);
  const always = new Set(['exec:npm test', 'exec:powershell', 'exec:git']); // the last two: keys older versions could save
  const d = command => decide({mode: 'default', kind: 'exec', params: {command}, always, gitConfig: () => ''});
  assert.equal(d('npm test'), 'allow');
  assert.equal(d('npm test && Remove-Item -Recurse -Force C:/x'), 'ask');
  assert.equal(d('powershell -Command Remove-Item -Recurse C:/x'), 'ask');
  assert.equal(d('git -C . push --force'), 'ask');
});

test('a git read runs unasked only when the repo config cannot make it run a program', () => {
  const d = (mode, config) => decide({mode, kind: 'exec', params: {command: 'git status'}, gitConfig: () => config});
  assert.equal(d('default', ''), 'allow');
  assert.equal(d('default', 'core.repositoryformatversion=0\ncore.fsmonitor=true\nremote.origin.url=x'), 'allow', 'the built-in fsmonitor daemon is fine');
  for (const bad of ['core.fsmonitor=echo pwned > x', 'diff.external=evil.exe', 'diff.x.textconv=evil', 'filter.lfs.process=evil', 'core.pager=evil', 'include.path=../evil'])
    assert.equal(d('default', bad), 'ask', bad);
  assert.equal(d('plan', 'core.fsmonitor=evil'), 'deny');
  assert.equal(d('default', null), 'ask', 'config that cannot be read is not trusted');
});

test('a planted core.fsmonitor in a real repo makes git status ask', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), {execFileSync} = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fsmon-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', dir]);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git status'}, cwd: dir}), 'allow');
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', 'echo pwned > pwned.txt']);
  assert.equal(decide({mode: 'default', kind: 'exec', params: {command: 'git status'}, cwd: dir}), 'ask');
  assert.equal(decide({mode: 'plan', kind: 'exec', params: {command: 'git status'}, cwd: dir}), 'deny');
  assert.equal(fs.existsSync(path.join(dir, 'pwned.txt')), false, 'checking ran nothing');
});

test("writes to muser's own settings ask, even in auto-edit; bypass is the user's choice", () => {
  const os = require('node:os'), path = require('node:path');
  const perms = path.join(os.homedir(), '.muser', 'permissions.json'), mcp = path.join(os.homedir(), '.muser', 'mcp.json');
  const e = (mode, file) => decide({mode, kind: 'edit', params: {path: file}, outside: false, targets: [file]});
  assert.equal(e('auto-edit', perms), 'ask');
  assert.equal(e('auto-edit', mcp), 'ask');
  assert.equal(e('default', perms), 'ask');
  assert.equal(e('bypass', perms), 'allow');
  assert.equal(e('auto-edit', path.join(os.homedir(), 'project', 'a.js')), 'allow');
  assert.equal(decide({mode: 'auto-edit', kind: 'edit', params: {}, outside: false, targets: [perms], always: new Set(['edit'])}), 'ask', '"edit" remembered does not cover it');
});
