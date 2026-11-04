'use strict';
// Follow-up to phase-1 fourth H1: a hard link is refused only when one of its
// OTHER names is sensitive. An ordinary hardlinked file (the pnpm case: a plain
// lib.js with a second link) must stay readable, and a link whose other names
// cannot be listed must be refused with an accurate message, not the secret one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TOOLS, dropSensitiveLines, setHardlinkLister, clearHardlinkCache} = require('../src/tools');
const {expand} = require('../src/mentions');
const i18n = require('../src/i18n');
const {after} = require('node:test');
const madeDirs = [];
after(() => { setHardlinkLister(null); for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
function lab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-hardlink-')); madeDirs.push(base);
  const proj = path.join(base, 'proj'); fs.mkdirSync(proj, {recursive: true});
  return {base, proj, ctx: {cwd: proj, readFiles: new Set(), todos: []}};
}
function link(a, b) { fs.linkSync(a, b); assert.ok(fs.statSync(b).nlink > 1, 'fixture really is hardlinked'); }

test('ordinary hardlinked file is readable: read, edit, grep, glob and @mentions', async () => {
  const {proj, ctx: c} = lab();
  const lib = path.join(proj, 'lib.js'); fs.writeFileSync(lib, 'export const lib = 1; // LIBMARKER');
  const copy = path.join(proj, 'lib-copy.js'); link(lib, copy);
  assert.match(TOOLS['code.read'].run({path: 'lib.js'}, c).payload.content, /LIBMARKER/);
  assert.match(TOOLS['code.read'].run({path: 'lib-copy.js'}, c).payload.content, /LIBMARKER/);
  TOOLS['code.edit'].run({path: 'lib.js', old_string: 'lib = 1', new_string: 'lib = 2'}, c);
  assert.match(fs.readFileSync(lib, 'utf8'), /lib = 2/);
  assert.match(fs.readFileSync(copy, 'utf8'), /lib = 1/, 'writeText renames a temp file in, so the edit breaks the link instead of reaching the alias');
  const out = (await TOOLS['code.grep'].run({pattern: 'LIBMARKER', path: 'lib.js'}, c)).payload.output;
  assert.match(out, /LIBMARKER/); // a single-file grep prints lines without the file name
  const dirOut = (await TOOLS['code.grep'].run({pattern: 'LIBMARKER'}, c)).payload.output;
  assert.match(dirOut, /lib\.js/); assert.match(dirOut, /lib-copy\.js/);
  const globbed = (await TOOLS['code.glob'].run({pattern: '*.js'}, c)).payload.files;
  assert.ok(globbed.includes('lib.js') && globbed.includes('lib-copy.js'), globbed.join(','));
  const m = expand('@lib.js', proj, new Set());
  assert.match(m.block, /LIBMARKER/); assert.ok(!m.block.includes('sensitive'), m.block);
});

test('hard link whose other name is sensitive (id_rsa, credentials.json) is refused', async () => {
  const {base, proj, ctx: c} = lab();
  const secretDir = path.join(base, 'secret'); fs.mkdirSync(secretDir, {recursive: true});
  const key = path.join(secretDir, 'id_rsa'); fs.writeFileSync(key, 'FAKE-PRIVATE-KEY');
  const alias = path.join(proj, 'notes.txt'); link(key, alias);
  fs.writeFileSync(path.join(proj, 'ok.txt'), 'FAKE-PRIVATE-KEY mentioned in a normal file');
  assert.throws(() => TOOLS['code.read'].run({path: 'notes.txt'}, c), /機密ファイル/);
  await assert.rejects(TOOLS['code.grep'].run({pattern: 'FAKE', path: 'notes.txt'}, c), /機密ファイル/);
  const out = (await TOOLS['code.grep'].run({pattern: 'FAKE-PRIVATE-KEY'}, c)).payload.output;
  assert.match(out, /ok\.txt/); assert.ok(!out.includes('notes'), out);
  const globbed = (await TOOLS['code.glob'].run({pattern: '*.txt'}, c)).payload.files;
  assert.ok(globbed.includes('ok.txt') && !globbed.some(f => f.includes('notes')), globbed.join(','));
  assert.deepEqual(dropSensitiveLines(['notes.txt:1:FAKE-PRIVATE-KEY', 'ok.txt:1:fine'], {cwd: proj}, false), ['ok.txt:1:fine']);
  const real = fs.realpathSync.native(alias);
  for (const target of [alias, real]) c.readFiles.add(target);
  assert.throws(() => TOOLS['code.edit'].run({path: 'notes.txt', old_string: 'FAKE', new_string: 'PWNED'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.write'].run({path: 'notes.txt', content: 'PWNED'}, c), /機密ファイル/);
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: notes.txt\n-FAKE-PRIVATE-KEY\n+PWNED\n*** End Patch'}, c), /機密ファイル/);
  assert.equal(fs.readFileSync(key, 'utf8'), 'FAKE-PRIVATE-KEY', 'the secret behind the alias is untouched');
  const m = expand('@notes.txt', proj, new Set());
  assert.ok(m.files.some(f => f.kind === 'sensitive'), JSON.stringify(m.files));
  assert.ok(!m.block.includes('FAKE-PRIVATE-KEY'), m.block);
  // The same refusal through an injected lister naming credentials.json.
  const {proj: proj2, ctx: c2} = lab();
  const plain = path.join(proj2, 'plain.txt'); fs.writeFileSync(plain, 'plain');
  const plainCopy = path.join(proj2, 'plain-copy.txt'); link(plain, plainCopy);
  try {
    setHardlinkLister(() => [plain, path.join(base, 'credentials.json')]);
    assert.throws(() => TOOLS['code.read'].run({path: 'plain.txt'}, c2), /機密ファイル/);
  } finally { setHardlinkLister(null); }
});

test('unlistable hard link is refused with the accurate message, in Japanese and English', async () => {
  const {proj, ctx: c} = lab();
  const file = path.join(proj, 'plain.txt'); fs.writeFileSync(file, 'plain content');
  const copy = path.join(proj, 'plain-copy.txt'); link(file, copy);
  try {
    setHardlinkLister(() => null);
    assert.throws(() => TOOLS['code.read'].run({path: 'plain.txt'}, c), /別の名前（ハードリンク）ともつながっていて/);
    assert.throws(() => TOOLS['code.read'].run({path: 'plain.txt'}, c), (e) => !/機密ファイル/.test(e.message));
    assert.deepEqual(dropSensitiveLines(['plain.txt:1:plain', 'ok.txt:1:fine'], {cwd: proj}, false), ['ok.txt:1:fine']);
    const m = expand('@plain.txt', proj, new Set());
    assert.ok(m.files.some(f => f.kind === 'hardlink-unknown'), JSON.stringify(m.files));
    assert.ok(!m.block.includes('plain content'), m.block);
    assert.match(m.block, /could not all be verified/);
  } finally { setHardlinkLister(null); }
  try {
    setHardlinkLister(() => { throw new Error('fsutil gone'); });
    assert.throws(() => TOOLS['code.read'].run({path: 'plain.txt'}, c), /別の名前（ハードリンク）ともつながっていて/);
  } finally { setHardlinkLister(null); }
  try {
    setHardlinkLister(() => null);
    i18n.setLang('en', {save: false});
    assert.throws(() => TOOLS['code.read'].run({path: 'plain.txt'}, c), /another name/);
    assert.throws(() => TOOLS['code.read'].run({path: 'plain.txt'}, c), (e) => !/sensitive/.test(e.message));
  } finally { i18n.setLang('ja', {save: false}); setHardlinkLister(null); }
});

test('cache: one listing per inode, shared across aliases, refreshed when nlink changes', () => {
  const {proj, ctx: c} = lab();
  const file = path.join(proj, 'a.js'); fs.writeFileSync(file, 'a');
  const copy = path.join(proj, 'b.js'); link(file, copy);
  let calls = 0;
  try {
    setHardlinkLister((f) => { calls++; return [file, copy]; });
    TOOLS['code.read'].run({path: 'a.js'}, c);
    TOOLS['code.read'].run({path: 'a.js'}, c);
    TOOLS['code.read'].run({path: 'b.js'}, c);
    assert.equal(calls, 1, 'same inode under both names, listed once');
    const third = path.join(proj, 'c.js'); fs.linkSync(file, third);
    TOOLS['code.read'].run({path: 'a.js'}, c);
    assert.equal(calls, 2, 'nlink changed, so the cached verdict is not trusted');
    clearHardlinkCache();
    TOOLS['code.read'].run({path: 'a.js'}, c);
    assert.equal(calls, 3, 'explicit cache clear re-lists');
  } finally { setHardlinkLister(null); }
});
