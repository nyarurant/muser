'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const types = require('../src/agent-types');

test('agent types: builtins, custom .md types, tool allowlist with mcp.* pattern', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-types-'));
  fs.mkdirSync(path.join(dir, '.muser', 'agents'), {recursive: true});
  fs.writeFileSync(path.join(dir, '.muser', 'agents', 'docs.md'), '---\nname: docs\ndescription: Writes docs\ntools: code.read, code.edit\nreadonly: false\n---\nYou write documentation.\n');
  const t = types.load(dir);
  assert.ok(t.explore.readOnly && t.plan.readOnly && !t.test.readOnly);
  assert.equal(t.docs.prompt, 'You write documentation.');
  assert.ok(types.allows(t.docs, 'code.edit') && !types.allows(t.docs, 'system.run'));
  assert.ok(types.allows(t.explore, 'mcp.fixture.echo') && !types.allows(t.explore, 'code.edit'));
  assert.ok(types.allows(t.general, 'anything'));
});

// Run fn with console.error captured; returns the lines it printed.
function captureErrors(fn) {
  const lines = [], orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { fn(); } finally { console.error = orig; }
  return lines;
}

test('agent types: unclosed frontmatter is reported, not loaded as a prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-types-'));
  fs.mkdirSync(path.join(dir, '.muser', 'agents'), {recursive: true});
  const bad = path.join(dir, '.muser', 'agents', 'broken.md');
  fs.writeFileSync(bad, '---\nname: broken\ndescription: No closing delimiter\nThis was meant to be the prompt.\n');
  let t;
  const lines = captureErrors(() => { t = types.load(dir); });
  assert.ok(!t.broken, 'broken type must not be registered');
  const hit = lines.find(l => l.includes(bad));
  assert.ok(hit, 'expected a console.error naming the bad file, got: ' + lines.join(' | '));
  assert.ok(hit.startsWith('muser: エージェント定義を読み込めませんでした: '));
  assert.ok(hit.includes('frontmatter'));
});

test('agent types: overriding a builtin name prints a shadow notice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-types-'));
  fs.mkdirSync(path.join(dir, '.muser', 'agents'), {recursive: true});
  const file = path.join(dir, '.muser', 'agents', 'general.md');
  fs.writeFileSync(file, '---\nname: general\ndescription: Custom general\n---\nCustom general prompt.\n');
  let t;
  const lines = captureErrors(() => { t = types.load(dir); });
  assert.equal(t.general.prompt, 'Custom general prompt.');
  assert.ok(lines.includes(`muser: 組み込みエージェント general は ${file} で上書きされます`), 'got: ' + lines.join(' | '));
});
