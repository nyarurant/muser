'use strict';
// Fix phase 1 regressions for src/tools.js (agent B): sensitive-path enumeration gaps,
// creation-side guard, hardlinks, ADS streams, and the junction test gap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TOOLS, isSensitivePath, dropSensitiveLines} = require('../src/tools');

const {after} = require('node:test');
const madeDirs = [];
after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
function ctx() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-')); madeDirs.push(cwd); return {cwd, readFiles: new Set()}; }
function lab(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-lab-')); madeDirs.push(base);
  const ssh = path.join(base, 'home', '.ssh'), proj = path.join(base, 'proj');
  fs.mkdirSync(ssh, {recursive: true}); fs.mkdirSync(proj, {recursive: true});
  return {base, ssh, proj, ctx: {cwd: proj, readFiles: new Set(), todos: []}};
}

test('fix1 first #3: .claude.json and .codex-accounts auth.json are sensitive; plain auth.json is not', async () => {
  const home = os.homedir();
  for (const f of [path.join(home, '.claude.json'), path.join(home, '.claude.json.bak'),
    path.join(home, '.codex-accounts', 'codex4', 'auth.json'), path.join(home, '.codex-accounts', 'auth.json'),
    path.join(home, '.codex', 'auth.json')])
    assert.equal(isSensitivePath(f), true, f);
  for (const f of ['src/auth.json', 'docs/auth.json', path.join(home, '.codex', 'config.toml'), 'notes.json'])
    assert.equal(isSensitivePath(f), false, f);
  const c = ctx();
  fs.writeFileSync(path.join(c.cwd, '.claude.json'), '{"token":"FAKE-CLAUDE"}\n');
  assert.throws(() => TOOLS['code.read'].run({path: '.claude.json'}, c), /機密ファイル/);
  fs.mkdirSync(path.join(c.cwd, '.codex-accounts', 'acct'), {recursive: true});
  fs.writeFileSync(path.join(c.cwd, '.codex-accounts', 'acct', 'auth.json'), '{"token":"FAKE-CODEX"}\n');
  fs.writeFileSync(path.join(c.cwd, 'ok.txt'), 'FAKE-CLAUDE FAKE-CODEX fine\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE'}, c)).payload.output;
  assert.match(out, /ok\.txt/);
  assert.ok(!out.includes('.claude.json') && !out.includes('auth.json'), out);
  const globbed = (await TOOLS['code.glob'].run({pattern: '**/auth.json'}, c)).payload.files;
  assert.deepEqual(globbed, [], 'glob must not list the codex-accounts auth.json: ' + globbed);
});

test('fix1 deep C1: any gcloud segment is sensitive (Windows %APPDATA% layout, not only .config/gcloud)', async () => {
  const home = os.homedir();
  for (const f of [path.join(home, 'AppData', 'Roaming', 'gcloud', 'application_default_credentials.json'),
    path.join(home, 'AppData', 'Roaming', 'gcloud', 'legacy_credentials', 'a@b.com', 'adc.json'),
    path.join(home, '.config', 'gcloud', 'credentials.db'), path.join(home, 'gcloud', 'adc.json')])
    assert.equal(isSensitivePath(f), true, f);
  const c = ctx();
  const dir = path.join(c.cwd, 'AppData', 'Roaming', 'gcloud'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'application_default_credentials.json'), '{"refresh_token":"FAKE-ADC"}\n');
  assert.throws(() => TOOLS['code.read'].run({path: path.join('AppData', 'Roaming', 'gcloud', 'application_default_credentials.json')}, c), /機密ファイル/);
  fs.writeFileSync(path.join(c.cwd, 'ok.txt'), 'FAKE-ADC fine\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE-ADC'}, c)).payload.output;
  assert.match(out, /ok\.txt/); assert.ok(!out.includes('gcloud'), out);
});

test('fix1 deep H2: creation paths refuse sensitive destinations; normal creation still works', () => {
  const c = ctx();
  for (const p of ['.aws/credentials', '.ssh/authorized_keys', '.npmrc', 'cert.pem', '.claude.json'])
    assert.throws(() => TOOLS['code.write'].run({path: p, content: 'FAKE\n'}, c), /機密ファイル/, p);
  for (const p of ['.aws/credentials', '.ssh/authorized_keys', '.npmrc', 'cert.pem', '.claude.json'])
    assert.ok(!fs.existsSync(path.join(c.cwd, p)), 'must not have been created: ' + p);
  assert.throws(() => TOOLS['code.write'].preview({path: '.aws/credentials', content: 'FAKE\n'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Add File: .ssh/authorized_keys\n+ssh-rsa FAKE\n*** End Patch'}, c), /機密ファイル/);
  assert.ok(!fs.existsSync(path.join(c.cwd, '.ssh', 'authorized_keys')));
  // Move destination is a creation path too.
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'hello\n');
  TOOLS['code.read'].run({path: 'a.txt'}, c);
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: .aws/credentials\n-hello\n+hi\n*** End Patch'}, c), /機密ファイル/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'a.txt'), 'utf8'), 'hello\n', 'the source file is untouched');
  assert.ok(!fs.existsSync(path.join(c.cwd, '.aws', 'credentials')));
  // Ordinary creation / add / move keep working.
  TOOLS['code.write'].run({path: 'normal-new.txt', content: 'fine\n'}, c);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'normal-new.txt'), 'utf8'), 'fine\n');
  TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Add File: added.txt\n+new\n*** Update File: a.txt\n*** Move to: moved.txt\n-hello\n+hi\n*** End Patch'}, c);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'added.txt'), 'utf8'), 'new\n');
  assert.equal(fs.readFileSync(path.join(c.cwd, 'moved.txt'), 'utf8'), 'hi\n');
});

test('fix1 third C2: standard secret filenames (.pgpass, credentials.csv/.tfrc.json, .my.cnf, .s3cfg, .boto, gh hosts.yml)', () => {
  const home = os.homedir();
  for (const f of [path.join(home, '.pgpass'), 'credentials.csv', 'credentials.tfrc.json', 'app.tfrc', 'app.tfrc.json',
    path.join(home, '.my.cnf'), path.join(home, '.s3cfg'), path.join(home, '.boto'),
    path.join(home, '.config', 'gh', 'hosts.yml'), path.join(home, '.config', 'github cli', 'hosts.yml')])
    assert.equal(isSensitivePath(f), true, f);
  for (const f of ['credentials.md', 'docs/credentials-guide.md', 'lib/credentials_manager.js', 'config/hosts.yml', 'notes.txt'])
    assert.equal(isSensitivePath(f), false, f);
  const c = ctx(); fs.writeFileSync(path.join(c.cwd, '.pgpass'), 'host:*:*:user:FAKE\n');
  assert.throws(() => TOOLS['code.read'].run({path: '.pgpass'}, c), /機密ファイル/);
});

test('fix1 fourth H1: a hardlink to a secret (id_rsa) is refused on read, grep, glob, edit, write and patch', async t => {
  const {ssh, proj, ctx: c} = lab(t);
  const key = path.join(ssh, 'id_rsa'); fs.writeFileSync(key, 'FAKE-PRIVATE-KEY\n');
  const alias = path.join(proj, 'hard-notes.txt'); fs.linkSync(key, alias);
  assert.ok(fs.statSync(alias).nlink > 1, 'fixture really is hardlinked');
  // Follow-up rule (src/tools.js hardlinkVerdict): the alias is refused because its
  // OTHER name, id_rsa, is sensitive -- not because it merely has nlink>1. An
  // ordinary hardlinked file stays readable; see tests/hardlink-followup.test.js.
  assert.throws(() => TOOLS['code.read'].run({path: 'hard-notes.txt'}, c), /機密ファイル/);
  await assert.rejects(TOOLS['code.grep'].run({pattern: 'FAKE', path: 'hard-notes.txt'}, c), /機密ファイル/);
  fs.writeFileSync(path.join(proj, 'ok.txt'), 'FAKE-PRIVATE-KEY mentioned in a normal file\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE-PRIVATE-KEY'}, c)).payload.output;
  assert.match(out, /ok\.txt/); assert.ok(!out.includes('hard-notes'), out);
  const globbed = (await TOOLS['code.glob'].run({pattern: '*.txt'}, c)).payload.files;
  assert.ok(globbed.includes('ok.txt') && !globbed.some(f => f.includes('hard-notes')), globbed.join(','));
  assert.deepEqual(dropSensitiveLines(['hard-notes.txt:1:FAKE-PRIVATE-KEY', 'ok.txt:1:fine'], {cwd: proj}, false), ['ok.txt:1:fine']);
  // Writes through the alias must not reach the secret either (readFiles is primed
  // directly, as if the file had been read before it was linked / by another route).
  const real = fs.realpathSync.native(alias);
  for (const target of [alias, real]) c.readFiles.add(target);
  assert.throws(() => TOOLS['code.edit'].run({path: 'hard-notes.txt', old_string: 'FAKE', new_string: 'PWNED'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.write'].run({path: 'hard-notes.txt', content: 'PWNED\n'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: hard-notes.txt\n-FAKE-PRIVATE-KEY\n+PWNED\n*** End Patch'}, c), /機密ファイル/);
  assert.equal(fs.readFileSync(key, 'utf8'), 'FAKE-PRIVATE-KEY\n', 'the secret behind the alias is untouched');
  // A normal single-link file in the same folder still reads and edits fine.
  assert.match(TOOLS['code.read'].run({path: 'ok.txt'}, c).payload.content, /normal file/);
  TOOLS['code.edit'].run({path: 'ok.txt', old_string: 'normal', new_string: 'ordinary'}, c);
  assert.match(fs.readFileSync(path.join(proj, 'ok.txt'), 'utf8'), /ordinary file/);
});

test('fix1 fourth H2: an ADS stream component (name:stream) is sensitive and blocked for read and write', () => {
  assert.equal(isSensitivePath('notes.txt:hiddenstream'), true);
  assert.equal(isSensitivePath('C:\\x\\notes.txt:id_rsa'), true);
  assert.equal(isSensitivePath('C:\\x\\notes.txt'), false);
  assert.equal(isSensitivePath('notes.txt'), false);
  const c = ctx(); const note = path.join(c.cwd, 'notes.txt'); fs.writeFileSync(note, 'plain\n');
  fs.writeFileSync(note + ':hiddenstream', 'FAKE-ADS-SECRET\n');
  fs.writeFileSync(note + ':id_rsa', 'FAKE-ADS-KEY\n');
  assert.throws(() => TOOLS['code.read'].run({path: 'notes.txt:hiddenstream'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.read'].run({path: 'notes.txt:id_rsa'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.write'].run({path: 'evil.txt:stream', content: 'x\n'}, c), /機密ファイル/);
  assert.match(TOOLS['code.read'].run({path: 'notes.txt'}, c).payload.content, /plain/, 'the plain file itself stays readable');
});

test('fix1 deep H25: a junction into a fake .ssh is refused by code.read and dropped by grep filtering', async t => {
  const {ssh, proj, ctx: c} = lab(t);
  fs.writeFileSync(path.join(ssh, 'mykey'), 'FAKE-JUNCTION-KEY\n');
  fs.symlinkSync(ssh, path.join(proj, 's'), 'junction');
  fs.writeFileSync(path.join(proj, 'ok.txt'), 'fine\n');
  assert.throws(() => TOOLS['code.read'].run({path: 's/mykey'}, c), /機密ファイル|sensitive/);
  await assert.rejects(TOOLS['code.grep'].run({pattern: 'FAKE', path: 's'}, c), /機密ファイル|sensitive/);
  assert.deepEqual(dropSensitiveLines(['s/mykey:1:FAKE-JUNCTION-KEY', 'ok.txt:1:fine'], {cwd: proj}, false), ['ok.txt:1:fine'],
    'grep output filtering drops the junction line by its real path (realOf)');
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE-JUNCTION-KEY'}, c)).payload.output;
  assert.ok(!out.includes('FAKE-JUNCTION-KEY'), out);
});
