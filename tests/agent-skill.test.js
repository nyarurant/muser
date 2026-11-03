'use strict';
// `muser agent-skill` (src/agent-skill.js): muser-exec put into Claude Code's and Codex's skill
// folders, and taken out again, touching only what muser put there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../src/agent-skill');

const madeDirs = [];
require('node:test').after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-agent-skill-')); madeDirs.push(home);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.codex-accounts', 'acct1'), {recursive: true});
  fs.writeFileSync(path.join(home, '.codex-accounts', 'acct1', 'auth.json'), '{}');
  fs.mkdirSync(path.join(home, '.codex-accounts', 'notes'), {recursive: true}); // not a Codex home
  return {home, env: {}};
}

test('the targets: Claude Code, Codex, CODEX_HOME and each home of ~/.codex-accounts', () => {
  const {home} = sandbox();
  const extra = path.join(home, 'elsewhere');
  const dirs = s.targets({env: {CODEX_HOME: extra}, home}).map(t => t.agent + ':' + path.relative(home, t.dir));
  assert.deepEqual(dirs, ['claude:' + path.join('.claude', 'skills'), 'codex:' + path.join('.codex', 'skills'), 'codex:' + path.join('elsewhere', 'skills'), 'codex:' + path.join('.codex-accounts', 'acct1', 'skills')]);
});

test('install links the skill everywhere an agent is, keeps what is there, and remove takes out only muser\'s', () => {
  const {home, env} = sandbox();
  // Codex's own skill of another name stays; a foreign "muser-exec" (not ours) is left alone.
  const foreign = path.join(home, '.codex-accounts', 'acct1', 'skills', 'muser-exec');
  fs.mkdirSync(foreign, {recursive: true});
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: something-else\n---\n');
  let rows = s.install({env, home});
  assert.deepEqual(rows.map(r => r.done), ['link', 'link', 'skipped']);
  assert.equal(rows[2].state, 'foreign');
  const claude = path.join(home, '.claude', 'skills', 'muser-exec', 'SKILL.md');
  assert.match(fs.readFileSync(claude, 'utf8'), /name: muser-exec/);
  assert.deepEqual(s.status({env, home}).map(r => r.state), ['installed', 'installed', 'foreign']);
  assert.deepEqual(s.install({env, home}).map(r => r.done), ['kept', 'kept', 'skipped'], 'installing again changes nothing');
  rows = s.remove({env, home});
  assert.deepEqual(rows.map(r => r.done), ['removed', 'removed', 'none']);
  assert.ok(fs.existsSync(path.join(s.source(), 'SKILL.md')), 'removing a link never touches muser\'s own copy');
  assert.ok(fs.existsSync(path.join(foreign, 'SKILL.md')), 'the foreign skill is still there');
});

test('an older copy of muser-exec is replaced by the link; one agent only with its name', () => {
  const {home, env} = sandbox();
  const old = path.join(home, '.codex', 'skills', 'muser-exec');
  fs.mkdirSync(old, {recursive: true});
  fs.writeFileSync(path.join(old, 'SKILL.md'), '---\nname: muser-exec\ndescription: old\n---\nold body');
  assert.equal(s.status({env, home})[1].state, 'copy');
  const rows = s.install({env, home, agents: ['codex']});
  assert.deepEqual(rows.map(r => r.agent), ['codex', 'codex'], 'claude untouched');
  assert.equal(rows[0].done, 'link');
  assert.equal(s.status({env, home})[0].state, 'missing', 'Claude Code was not asked for');
  assert.doesNotMatch(fs.readFileSync(path.join(old, 'SKILL.md'), 'utf8'), /old body/);
});

test('no agent folder, no install there', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-agent-skill-none-')); madeDirs.push(home);
  const rows = s.install({env: {}, home});
  assert.deepEqual(rows.map(r => [r.state, r.done]), [['no-agent', 'skipped'], ['no-agent', 'skipped']]);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
});
