'use strict';
// Fix phase 1 regression tests:
//  - Deep H6 (mentions.js): Japanese prose glued to an @file mention was swallowed
//    into the ref, so the real file was reported missing.
//  - Deep H7 (mcp.js): a $secret reference the vault did not have was resolved to
//    '' by load() and a later save() wrote that '' back permanently.
//  - Deep H20 (test gap, mentions.js): an @mention through a junction/symlink into
//    a sensitive folder (fake ~/.ssh) must not inline the target's content.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const m = require('../src/mentions');

const createdDirs = [];
function tmpdir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); createdDirs.push(dir); return dir; }
after(() => { for (const dir of createdDirs) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} } });

// Deep H6: sentence punctuation ends a ref at parse time; particles/kana glued to
// a ref are trimmed in expand() only when the full ref does not exist and a
// shorter ref does (longest existing file wins).
test('H6: Japanese particles/punctuation after @file do not swallow the ref', () => {
  const dir = tmpdir('muser-fix1-jp-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme-body');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'js-body');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a-body');
  // Fullwidth sentence punctuation is a hard stop, even without any file lookup.
  assert.deepEqual(m.mentions('@a.txt！'), ['a.txt']);
  assert.deepEqual(m.mentions('@a.txt？'), ['a.txt']);
  assert.deepEqual(m.mentions('@a.txt：次'), ['a.txt']);
  const read = new Set();
  const ex = m.expand('@README.mdを見て @src/a.jsを確認して @a.txt！', dir, read);
  assert.deepEqual(ex.missing, [], 'no real file is reported missing');
  assert.deepEqual(ex.files.map(f => f.ref), ['README.md', 'src/a.js', 'a.txt']);
  assert.ok(ex.block.includes('readme-body'));
  assert.ok(ex.block.includes('js-body'));
  assert.ok(ex.block.includes('a-body'));
  assert.ok(read.has(path.join(dir, 'README.md')), 'the trimmed file counts as read');
  // A genuinely missing file is still reported, exactly as written.
  const gone = m.expand('@gone.txtを見て', dir, new Set());
  assert.deepEqual(gone.missing, ['gone.txtを見て']);
  assert.deepEqual(gone.files, []);
});

// Deep H6, the other side: file names may legitimately contain Japanese
// characters, so trimming must never truncate a name that exists as written,
// and a Japanese name followed by prose resolves to that full name.
test('H6: Japanese file names are preserved, not truncated by trimming', () => {
  const dir = tmpdir('muser-fix1-jpname-');
  fs.writeFileSync(path.join(dir, '報告書.md'), 'report-body');
  fs.writeFileSync(path.join(dir, 'メモ.txt'), 'memo-body');
  fs.writeFileSync(path.join(dir, '日本語.txt'), 'nihongo-body');
  const ex = m.expand('@報告書.mdを見て @メモ.txt @日本語.txtを確認して', dir, new Set());
  assert.deepEqual(ex.missing, []);
  assert.deepEqual(ex.files.map(f => f.ref), ['報告書.md', 'メモ.txt', '日本語.txt']);
  assert.ok(ex.block.includes('report-body'));
  assert.ok(ex.block.includes('memo-body'));
  assert.ok(ex.block.includes('nihongo-body'));
});

// Deep H20: expand() checks isSensitivePath on realOf(ref), so a junction inside
// the project pointing at a (fake) ~/.ssh must not inline the target — even for
// a file whose own name is not sensitive (data.txt). The guard is the resolved
// path's .ssh segment.
test('H20: @mention through a junction into ~/.ssh is not inlined', (t) => {
  const dir = tmpdir('muser-fix1-proj-');
  const fakeHome = tmpdir('muser-fix1-home-');
  const ssh = path.join(fakeHome, '.ssh');
  fs.mkdirSync(ssh);
  fs.writeFileSync(path.join(ssh, 'data.txt'), 'SSH-SECRET-CONTENT');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain-notes');
  try {
    fs.symlinkSync(ssh, path.join(dir, 'link'), 'junction');
  } catch (e) {
    t.skip('cannot create a junction here: ' + e.message);
    return;
  }
  const ex = m.expand('@link/data.txt @notes.txt', dir, new Set());
  assert.ok(!ex.block.includes('SSH-SECRET-CONTENT'), 'content behind the junction never reaches the message');
  assert.deepEqual(ex.files.filter(f => f.kind === 'sensitive').map(f => f.ref), ['link/data.txt']);
  assert.deepEqual(ex.missing, []);
  assert.ok(ex.block.includes('plain-notes'), 'a normal project file still expands');
});

// mcp.js resolves ~/.muser/mcp.json and the vault from the home dir /
// %LOCALAPPDATA% at require time, so — like tests/mcp.test.js — exercise
// load/save in a child process pointed at throwaway folders.
function runMcpChild(body) {
  const home = tmpdir('muser-fix1-mcp-home-');
  const local = tmpdir('muser-fix1-mcp-local-');
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, body);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 60000,
    env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, MUSER_REPO: path.join(__dirname, '..')}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /CHILD OK/);
}

// Deep H7: with no vault entry, load() resolves the references to '' (and records
// them missing); a later setEnabled()/importServers() save must write the
// references back, not the empty strings.
test('H7: unresolved $secret refs survive load -> setEnabled / importServers save', () => {
  runMcpChild(`
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert');
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    const dir = path.join(os.homedir(), '.muser'), file = path.join(dir, 'mcp.json');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(file, JSON.stringify({mcpServers: {srv: {command: 'node', enabled: false,
      env: {API_KEY: {$secret: 'srv:env:API_KEY'}}, headers: {Authorization: {$secret: 'srv:headers:Authorization'}}}}}));
    const loaded = mcp.load();
    assert.equal(loaded.mcpServers.srv.env.API_KEY, '', 'missing vault entry still resolves to empty for connect()');
    assert.deepEqual(mcp.missingSecrets('srv').sort(), ['srv:env:API_KEY', 'srv:headers:Authorization']);
    mcp.setEnabled('srv', true);
    let written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.mcpServers.srv.enabled, true);
    assert.deepEqual(written.mcpServers.srv.env.API_KEY, {$secret: 'srv:env:API_KEY'}, 'env $secret ref preserved after setEnabled save');
    assert.deepEqual(written.mcpServers.srv.headers.Authorization, {$secret: 'srv:headers:Authorization'}, 'headers $secret ref preserved after setEnabled save');
    // Still detectable as missing after the round trip (the #233 guard still fires).
    mcp.load();
    assert.deepEqual(mcp.missingSecrets('srv').sort(), ['srv:env:API_KEY', 'srv:headers:Authorization']);
    mcp.importServers([{name: 'other', from: 'Test', server: {command: 'node', env: {TOKEN: 'plain-value-999'}}}]);
    written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.mcpServers.srv.env.API_KEY, {$secret: 'srv:env:API_KEY'}, 'env $secret ref preserved after importServers save');
    assert.deepEqual(written.mcpServers.srv.headers.Authorization, {$secret: 'srv:headers:Authorization'}, 'headers $secret ref preserved after importServers save');
    assert.ok(written.mcpServers.other, 'the imported server was added');
    console.log('CHILD OK');
  `);
});

// Deep H7, round-trip form: the preserved reference is the original key string
// verbatim — it is not reconstructed from server/kind/field names.
test('H7: load -> save round trip restores the original $secret key verbatim', () => {
  runMcpChild(`
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert');
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    const dir = path.join(os.homedir(), '.muser'), file = path.join(dir, 'mcp.json');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(file, JSON.stringify({mcpServers: {srv: {command: 'node',
      env: {API_KEY: {$secret: 'custom-key-xyz'}}}}}));
    const cfg = mcp.load();
    assert.equal(cfg.mcpServers.srv.env.API_KEY, '');
    mcp.save(cfg);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.mcpServers.srv.env.API_KEY, {$secret: 'custom-key-xyz'}, 'original $secret key restored verbatim');
    console.log('CHILD OK');
  `);
});
