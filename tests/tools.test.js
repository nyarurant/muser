'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TOOLS, isSensitivePath, applyHunks} = require('../src/tools');
const {decide} = require('../src/policy');

const {after} = require('node:test');
const madeDirs = [];
after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
function ctx() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-')); madeDirs.push(cwd); return {cwd, readFiles: new Set()}; }

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
  // The second section is refused (audit #212: one operation per file per patch — it is
  // also a bad hunk); either way the patch changes nothing.
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: m.js\n b\n-c\n+C\n*** Update File: m.js\n zzz\n-q\n*** End Patch'}, c), /not found|written twice/);
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
  for (const p of ['lib/credentials_manager.js', 'src/secret_santa.js', 'docs/secrets-handling.md', 'C:\\proj\\lib\\cookie_store.js']) assert.ok(!isSensitivePath(p), p);
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
  assert.deepEqual((await TOOLS['code.glob'].run({pattern: '**/*.md', path: 'OneDrive'}, c)).payload.files, [path.join('OneDrive', 'Docs', 'note.md')], 'relative to the working folder, not to the folder searched');
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
  // Audit #213: shell.kill has its own kind, so a remembered edit allowance and
  // auto-edit mode no longer let a kill through unasked.
  assert.equal(TOOLS['shell.kill'].kind, 'kill');
  const kind = TOOLS['shell.kill'].kind, always = new Set(['edit']);
  assert.equal(decide({mode: 'default', kind, command: 'shell.kill', params: {}, always}), 'ask');
  assert.equal(decide({mode: 'auto-edit', kind, command: 'shell.kill', params: {}, always}), 'ask');
  assert.equal(decide({mode: 'bypass', kind, command: 'shell.kill', params: {}}), 'allow');
});

test('system.run captures output and exit code (powershell and cmd)', async () => {
  const c = ctx();
  const a = await TOOLS['system.run'].run({command: 'Write-Output "日本語"; exit 3'}, c);
  assert.equal(a.payload.exit_code, 3); assert.match(a.payload.stdout, /日本語/);
  const b = await TOOLS['system.run'].run({command: 'echo hi', shell: 'cmd'}, c);
  assert.equal(b.payload.exit_code, 0); assert.match(b.payload.stdout, /hi/);
});

test('audit #212: a patch refuses two operations on the same file instead of overwriting the first', () => {
  const c = ctx(); fs.writeFileSync(path.join(c.cwd, 'm.js'), 'a\nb\nc\n');
  TOOLS['code.read'].run({path: 'm.js'}, c);
  const two = '*** Begin Patch\n*** Update File: m.js\n-a\n+A\n*** Update File: m.js\n-b\n+B\n*** End Patch';
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: two}, c), /written twice/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'm.js'), 'utf8'), 'a\nb\nc\n', 'nothing was written');
  const updDel = '*** Begin Patch\n*** Update File: m.js\n-a\n+A\n*** Delete File: m.js\n*** End Patch';
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: updDel}, c), /written twice/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'm.js'), 'utf8'), 'a\nb\nc\n');
});

test('audit #214/#215: sensitive-path check follows Windows name rules and backup suffixes', () => {
  const bad = [
    'C:\\x\\.ssh.\\id_rsa', 'C:\\x\\.ssh \\config', 'C:\\x\\.aws.\\credentials',
    'proj/id_rsa::$DATA', 'proj/credentials.json:secret', 'proj/.env.', 'proj/.env ',
    'proj/id_rsa.bak', 'proj/id_ed25519.old', 'proj/credentials.json.bak', 'proj/.env.bak',
    'proj/cert.pem.bak', 'proj/secret.txt.bak', 'proj/.npmrc.bak',
  ];
  for (const p of bad) assert.ok(isSensitivePath(p), p);
  const ok = ['proj/notes.txt.bak', 'proj/.env.example.bak', 'proj/.env.sample.old', 'lib/credentials_manager.js.bak', 'proj/archive.bak'];
  for (const p of ok) assert.ok(!isSensitivePath(p), p);
});

test('audit #216: apply_patch anchors must exist and do not waive context uniqueness', () => {
  assert.throws(() => applyHunks('a\nb\n', [{anchor: 'nope', lines: ['-b', '+B']}], 'f.js'), /anchor not found/);
  const text = 'fa\ngo\nfb\ngo\nx\ngo\n';
  // Anchored at fb, the first 'go' after it is still not unique (another follows): refuse.
  assert.throws(() => applyHunks(text, [{anchor: 'fb', lines: ['-go', '+stop']}], 'f.js'), /more than one place/);
  // Anchored at the last section, the same change is unambiguous and applies there.
  assert.equal(applyHunks(text, [{anchor: 'x', lines: ['-go', '+stop']}], 'f.js'), 'fa\ngo\nfb\ngo\nx\nstop\n');
});

test('audit #217: writes refuse content over the read limit, before anything is written', () => {
  const c = ctx(); const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
  assert.throws(() => TOOLS['code.write'].run({path: 'big.txt', content: huge}, c), /too large/);
  assert.ok(!fs.existsSync(path.join(c.cwd, 'big.txt')));
  assert.throws(() => TOOLS['code.write'].preview({path: 'big.txt', content: huge}, c), /too large/);
  fs.writeFileSync(path.join(c.cwd, 's.txt'), 'small\n');
  TOOLS['code.read'].run({path: 's.txt'}, c);
  assert.throws(() => TOOLS['code.edit'].run({path: 's.txt', old_string: 'small', new_string: huge}, c), /too large/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 's.txt'), 'utf8'), 'small\n');
});

test('audit #218: code.read output is bounded by the shared character budget and pages with next_offset', () => {
  const c = ctx(); const lines = Array.from({length: 2000}, (_, i) => 'line-' + i + ' ' + 'y'.repeat(90));
  fs.writeFileSync(path.join(c.cwd, 'many.txt'), lines.join('\n') + '\n');
  const r = TOOLS['code.read'].run({path: 'many.txt'}, c);
  assert.ok(r.payload.content.length <= 60000, 'content is within MAX_OUT, got ' + r.payload.content.length);
  assert.equal(r.payload.truncated, true);
  assert.ok(r.payload.next_offset > 1 && r.payload.next_offset < 2000, 'next_offset points into the file');
  const r2 = TOOLS['code.read'].run({path: 'many.txt', offset: r.payload.next_offset}, c);
  assert.match(r2.payload.content, new RegExp('line-' + (r.payload.next_offset - 1) + ' '));
});

test('audit #220: a permissions store relocated with MUSER_PERMISSIONS_FILE is off-limits to the coding tools', t => {
  const c = ctx(); const store = path.join(c.cwd, 'elsewhere', 'permissions.json');
  fs.mkdirSync(path.dirname(store), {recursive: true}); fs.writeFileSync(store, '{}');
  process.env.MUSER_PERMISSIONS_FILE = store;
  t.after(() => { delete process.env.MUSER_PERMISSIONS_FILE; });
  assert.ok(isSensitivePath(store));
  assert.ok(!isSensitivePath(path.join(c.cwd, 'elsewhere', 'notes.txt')), 'its neighbours stay readable');
  assert.throws(() => TOOLS['code.read'].run({path: store}, c), /機密ファイル/);
  // A write is refused too (the store was never readable, so it can never be overwritten).
  assert.throws(() => TOOLS['code.write'].run({path: store, content: '{"folders":{}}'}, c), /機密ファイル|Read the file/);
  assert.equal(fs.readFileSync(store, 'utf8'), '{}', 'the store is untouched');
});

test('audit #221: a timed-out cmd run keeps shell: cmd when it moves to the background', async () => {
  let adopted = null;
  const shells = {adopt: (command, opts, child, out) => { adopted = opts; return {id: 'bg9'}; }};
  const c = {cwd: process.cwd(), readFiles: new Set(), shells};
  const r = await TOOLS['system.run'].run({command: 'ping -n 4 127.0.0.1 >nul', shell: 'cmd', timeout_ms: 1000}, c);
  assert.equal(r.payload.backgrounded, true);
  assert.equal(r.payload.shell, 'cmd');
  assert.equal(adopted?.shell, 'cmd', 'the shell choice reaches the background record');
});

test('audit #222: an edit refuses a same-size change made after the read (hash checked on the bytes edited)', () => {
  const c = ctx(); const f = path.join(c.cwd, 'h.txt'); fs.writeFileSync(f, 'aaaa bbbb\n');
  TOOLS['code.read'].run({path: 'h.txt'}, c);
  fs.writeFileSync(f, 'aaaa cccc\n'); // same size, and old_string still matches
  assert.throws(() => TOOLS['code.edit'].run({path: 'h.txt', old_string: 'aaaa', new_string: 'zzzz'}, c), /changed on disk|変更/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'aaaa cccc\n');
});
