'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runOnce} = require('../src/shells');
const {TOOLS} = require('../src/tools');

// The exact operation that corrupted a README on 2026-10-31: Get-Content -Raw of a UTF-8 file
// (no BOM) written back with WriteAllText. Windows PowerShell 5.1 read it as Shift-JIS.
test('PowerShell run by muser reads UTF-8 files as UTF-8 (Get-Content, then written back)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-enc-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const text = '[日本語](README.ja.md) — … ⏺ › ↑↓\n';
  fs.writeFileSync(path.join(dir, 'part1.md'), text);
  const r = await runOnce('$p1 = Get-Content part1.md -Raw; [IO.File]::WriteAllText((Join-Path (Get-Location) "out.md"), $p1)', {cwd: dir, timeout: 30000});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'out.md'), 'utf8'), text);
});

test('reads and writes of double-encoded text carry a warning; normal Japanese does not', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-enc-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const ctx = {cwd: dir, readFiles: new Set(), todos: []};
  const mangled = 'a ' + String.fromCharCode(0x7ab6, 0x30fb) + ' b ' + String.fromCharCode(0x8b4c, 0xff65, 0x8b5b, 0xff6c, 0x96b1, 0x30fb);
  fs.writeFileSync(path.join(dir, 'bad.md'), mangled + '\n');
  fs.writeFileSync(path.join(dir, 'ok.md'), '日本語の普通の文章です。— … ⏺ ↑↓\n');
  assert.match(TOOLS['code.read'].run({path: 'bad.md'}, ctx).payload.warning || '', /double-encoded/);
  assert.equal(TOOLS['code.read'].run({path: 'ok.md'}, ctx).payload.warning, undefined);
  assert.match(TOOLS['code.write'].run({path: 'new.md', content: mangled}, ctx).payload.warning || '', /double-encoded/);
  assert.equal(TOOLS['code.write'].run({path: 'fine.md', content: 'ふつう — …'}, ctx).payload.warning, undefined);
});

test('the preamble tells Muse how to write files, to review its diff, and to keep to the request', () => {
  const p = require('../src/agent').preamble(process.cwd(), [], {});
  assert.match(p, /only with code\.write \/ code\.edit \/ code\.apply_patch, not with PowerShell/);
  assert.match(p, /read your whole diff/);
  assert.match(p, /Change what was asked and nothing more/);
});

// 2026-11-01: output was decoded chunk by chunk, so a Japanese character split between two chunks
// turned into U+FFFD (10 of them in 160,000 characters).
const BROKEN = new RegExp(String.fromCharCode(0xfffd), 'g');
test('long Japanese command output arrives without broken characters (one-shot and background)', async () => {
  const {Shells} = require('../src/shells');
  const cmd = '$s = ("' + '日本語のテキスト' + '" * 20000); Write-Output $s';
  const r = await runOnce(cmd, {cwd: process.cwd(), timeout: 60000, maxOut: 10 ** 7, clip: s => s});
  assert.equal((r.stdout.match(BROKEN) || []).length, 0);
  assert.ok(r.stdout.length >= 160000);
  const sh = new Shells(), s = sh.start(cmd, {cwd: process.cwd()});
  while (s.running) await new Promise(res => setTimeout(res, 100));
  assert.equal((s.out.match(BROKEN) || []).length, 0);
});
