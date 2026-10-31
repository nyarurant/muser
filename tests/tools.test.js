'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TOOLS, isSensitivePath} = require('../src/tools');
const {decide} = require('../src/policy');

function ctx() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-')); return {cwd, readFiles: new Set()}; }

test('edit requires a prior read, keeps CRLF, rejects ambiguous matches', () => {
  const c = ctx(); fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'one\r\ntwo\r\ntwo\r\n');
  assert.throws(() => TOOLS['code.edit'].run({path: 'a.txt', old_string: 'one', new_string: 'uno'}, c), /Read the file/);
  TOOLS['code.read'].run({path: 'a.txt'}, c);
  assert.throws(() => TOOLS['code.edit'].run({path: 'a.txt', old_string: 'two', new_string: 'dos'}, c), /occurs 2 times/);
  const r = TOOLS['code.edit'].run({path: 'a.txt', old_string: 'one\ntwo', new_string: 'uno\ndos'}, c);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'a.txt'), 'utf8'), 'uno\r\ndos\r\ntwo\r\n');
  assert.deepEqual([r.payload.added, r.payload.removed], [2, 2]);
});

test('apply_patch updates, adds, deletes; a bad hunk changes nothing', () => {
  const c = ctx(); fs.writeFileSync(path.join(c.cwd, 'm.js'), 'a\nb\nc\nd\n'); fs.writeFileSync(path.join(c.cwd, 'old.txt'), 'x\n');
  TOOLS['code.read'].run({path: 'm.js'}, c); TOOLS['code.read'].run({path: 'old.txt'}, c);
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: m.js\n b\n-c\n+C\n*** Update File: m.js\n zzz\n-q\n*** End Patch'}, c), /not found/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'm.js'), 'utf8'), 'a\nb\nc\nd\n');
  TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: m.js\n@@ a\n b\n-c\n+C\n+C2\n d\n*** Add File: n/new.txt\n+hi\n*** Delete File: old.txt\n*** End Patch'}, c);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'm.js'), 'utf8'), 'a\nb\nC\nC2\nd\n');
  assert.equal(fs.readFileSync(path.join(c.cwd, 'n/new.txt'), 'utf8'), 'hi\n');
  assert.ok(!fs.existsSync(path.join(c.cwd, 'old.txt')));
});

test('grep and glob go through ripgrep', async () => {
  const c = ctx(); fs.writeFileSync(path.join(c.cwd, 'x.ts'), 'const needle = 1;\n'); fs.writeFileSync(path.join(c.cwd, 'y.md'), 'no\n');
  assert.match((await TOOLS['code.grep'].run({pattern: 'need+le'}, c)).payload.output, /x\.ts:1:const needle/);
  assert.deepEqual((await TOOLS['code.glob'].run({pattern: '*.ts'}, c)).payload.files, ['x.ts']);
});

test('sensitive paths are refused by read, grep and glob; examples and .pub are allowed', async () => {
  const c = ctx();
  const bad = ['.env', '.env.local', 'cert.pem', 'private.key', 'id_rsa', 'credentials.json', 'secrets.json', '.netrc'];
  for (const name of bad) {
    fs.writeFileSync(path.join(c.cwd, name), 'needle secret-value\n');
    assert.throws(() => TOOLS['code.read'].run({path: name}, c), /機密ファイル/, name);
    await assert.rejects(TOOLS['code.grep'].run({pattern: 'needle', path: name}, c), /機密ファイル/, name);
    assert.ok(isSensitivePath(path.join(c.cwd, name)), name);
  }
  assert.ok(isSensitivePath('C:\\Users\\x\\.ssh\\id_rsa'));
  assert.ok(isSensitivePath('C:\\Users\\x\\.aws\\credentials'));
  assert.ok(isSensitivePath('C:\\Users\\x\\.gnupg\\pubring.gpg'));
  assert.ok(isSensitivePath('C:\\Users\\x\\.muser\\web.enc'));
  assert.ok(isSensitivePath('C:\\Users\\x\\.muser\\session.enc'));
  await assert.rejects(TOOLS['code.glob'].run({pattern: '*.pem'}, c), /機密ファイル/);
  await assert.rejects(TOOLS['code.glob'].run({pattern: '**/*', path: '.ssh'}, c), /機密ファイル/);
  // A directory grep must not leak sensitive files sitting in it.
  fs.writeFileSync(path.join(c.cwd, 'ok.ts'), 'const needle = 1;\n');
  const out = (await TOOLS['code.grep'].run({pattern: 'needle'}, c)).payload.output;
  assert.match(out, /ok\.ts/); assert.ok(!out.includes('secret-value'), out);
  // Allowed look-alikes stay readable / searchable.
  fs.writeFileSync(path.join(c.cwd, '.env.example'), 'KEY=example\n');
  fs.writeFileSync(path.join(c.cwd, 'id_rsa.pub'), 'ssh-rsa example\n');
  assert.ok(!isSensitivePath(path.join(c.cwd, '.env.example')));
  assert.ok(!isSensitivePath(path.join(c.cwd, '.env.sample')));
  assert.ok(!isSensitivePath(path.join(c.cwd, 'id_rsa.pub')));
  assert.match(TOOLS['code.read'].run({path: '.env.example'}, c).payload.content, /KEY=example/);
  assert.match((await TOOLS['code.grep'].run({pattern: 'ssh-rsa', path: 'id_rsa.pub'}, c)).payload.output, /ssh-rsa/);
});

test('apply_patch is atomic across files, refuses unread files and existing move destinations', () => {
  const c = ctx();
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'a1\na2\n'); fs.writeFileSync(path.join(c.cwd, 'b.txt'), 'b1\nb2\n');
  // Update without a prior read is refused (Add of a new file is the only exception).
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: a.txt\n-a1\n+A1\n*** End Patch'}, c), /Read the file/);
  TOOLS['code.read'].run({path: 'a.txt'}, c); TOOLS['code.read'].run({path: 'b.txt'}, c);
  // Second file has a bad hunk: the first file must stay untouched.
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: a.txt\n-a1\n+A1\n*** Update File: b.txt\n nope\n-b1\n+B1\n*** End Patch'}, c), /not found/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'a.txt'), 'utf8'), 'a1\na2\n');
  assert.equal(fs.readFileSync(path.join(c.cwd, 'b.txt'), 'utf8'), 'b1\nb2\n');
  // Move onto an existing file is refused and changes nothing.
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n-a1\n+A1\n*** End Patch'}, c), /already exists/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'a.txt'), 'utf8'), 'a1\na2\n');
  assert.equal(fs.readFileSync(path.join(c.cwd, 'b.txt'), 'utf8'), 'b1\nb2\n');
});

test('write and edit refuse when the file changed on disk after the read', () => {
  const c = ctx(); const f = path.join(c.cwd, 's.txt'); fs.writeFileSync(f, 'original long content\n');
  TOOLS['code.read'].run({path: 's.txt'}, c);
  fs.writeFileSync(f, 'externally changed, different\n');
  assert.throws(() => TOOLS['code.edit'].run({path: 's.txt', old_string: 'externally', new_string: 'x'}, c), /changed on disk|変更/);
  assert.throws(() => TOOLS['code.write'].run({path: 's.txt', content: 'overwrite\n'}, c), /changed on disk|変更/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'externally changed, different\n');
  // Re-reading refreshes the baseline, then editing works again (and our own write is not stale).
  TOOLS['code.read'].run({path: 's.txt'}, c);
  TOOLS['code.edit'].run({path: 's.txt', old_string: 'externally', new_string: 'locally'}, c);
  TOOLS['code.edit'].run({path: 's.txt', old_string: 'locally', new_string: 'finally'}, c);
  assert.match(fs.readFileSync(f, 'utf8'), /finally changed/);
});

test('source files named after credentials or secrets are not treated as secrets', () => {
  for (const p of ['lib/credentials_manager.js', 'src/secret_santa.js', 'docs/secrets-handling.md', 'C:\\Avatool\\lib\\booth_cookie_store.js']) assert.ok(!isSensitivePath(p), p);
  for (const p of ['credentials', 'credentials.json', 'secrets.json', 'secret.yaml', '.secrets']) assert.ok(isSensitivePath(p), p);
});

test('grep and glob skip OneDrive unless aimed inside it, and do not block the event loop', async () => {
  const c = ctx();
  fs.mkdirSync(path.join(c.cwd, 'OneDrive', 'Docs'), {recursive: true});
  fs.writeFileSync(path.join(c.cwd, 'OneDrive', 'Docs', 'note.md'), 'needle in onedrive\n');
  fs.writeFileSync(path.join(c.cwd, 'here.md'), 'needle here\n');
  const pending = TOOLS['code.grep'].run({pattern: 'needle'}, c);
  assert.ok(pending instanceof Promise, 'grep runs asynchronously');
  let ticked = false; setImmediate(() => { ticked = true; });
  const wide = (await pending).payload.output;
  assert.ok(ticked, 'the event loop kept running during the search');
  assert.match(wide, /here\.md/); assert.ok(!/onedrive/i.test(wide), wide);
  assert.match((await TOOLS['code.grep'].run({pattern: 'needle', path: 'OneDrive'}, c)).payload.output, /note\.md/);
  assert.deepEqual((await TOOLS['code.glob'].run({pattern: '*.md'}, c)).payload.files, ['here.md']);
  assert.deepEqual((await TOOLS['code.glob'].run({pattern: '**/*.md', path: 'OneDrive'}, c)).payload.files, [path.join('Docs', 'note.md')]);
});

test('code.read refuses files over 10MB', () => {
  const c = ctx(); const f = path.join(c.cwd, 'big.txt'); fs.writeFileSync(f, 'x\n'); fs.truncateSync(f, 10 * 1024 * 1024 + 1);
  assert.throws(() => TOOLS['code.read'].run({path: 'big.txt'}, c), /10MB|大きすぎ/);
});

test('shell.kill is not read-kind (plan mode must deny it); todo.write is, it only updates the list on screen', () => {
  assert.equal(TOOLS['todo.write'].kind, 'read');
  assert.equal(decide({mode: 'plan', kind: 'read', command: 'todo.write', params: {}}), 'allow');
  for (const name of ['shell.kill']) {
    assert.notEqual(TOOLS[name].kind, 'read', name);
    assert.equal(decide({mode: 'plan', kind: TOOLS[name].kind, command: name, params: {}}), 'deny', name);
    assert.notEqual(decide({mode: 'default', kind: TOOLS[name].kind, command: name, params: {}}), 'allow', name);
  }
});

test('system.run captures output and exit code (powershell and cmd)', async () => {
  const c = ctx();
  const a = await TOOLS['system.run'].run({command: 'Write-Output "日本語"; exit 3'}, c);
  assert.equal(a.payload.exit_code, 3); assert.match(a.payload.stdout, /日本語/);
  const b = await TOOLS['system.run'].run({command: 'echo hi', shell: 'cmd'}, c);
  assert.equal(b.payload.exit_code, 0); assert.match(b.payload.stdout, /hi/);
});
