'use strict';
// Standalone isolation guard (t2 #16): isSensitivePath consults the muser
// settings roots, so pin the scratch home/data folders here as well as
// relying on tests/setup.mjs — run without the setup import this file must
// not resolve paths against the real user's folders.
{
  const fs0 = require('node:fs'), os0 = require('node:os'), path0 = require('node:path');
  process.env.MUSER_LANG = 'ja';
  if (!/muser-test/.test(process.env.LOCALAPPDATA || '')) process.env.LOCALAPPDATA = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'muser-test-data-'));
  if (!/muser-test/.test(process.env.USERPROFILE || '')) process.env.USERPROFILE = process.env.HOME = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'muser-test-home-'));
}
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {TOOLS, isSensitivePath, realOf} = require('../src/tools');

function lab(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-jn-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const ssh = path.join(base, 'home', '.ssh'), outside = path.join(base, 'elsewhere'), proj = path.join(base, 'proj');
  for (const d of [ssh, outside, proj]) fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(ssh, 'mykey'), 'PRIVATE KEY');
  fs.symlinkSync(ssh, path.join(proj, 's'), 'junction');
  fs.symlinkSync(outside, path.join(proj, 'out'), 'junction');
  return {base, ssh, outside, proj, ctx: {cwd: proj, readFiles: new Set(), todos: []}};
}

// 2026-11-01: a junction in the project pointing at ~/.ssh read a private key as 's/mykey'.
test('a junction does not get secrets past the guard (read, grep, glob)', async t => {
  const {ctx} = lab(t);
  assert.throws(() => TOOLS['code.read'].run({path: 's/mykey'}, ctx), /sensitive|機密/);
  await assert.rejects(TOOLS['code.grep'].run({pattern: 'PRIVATE', path: 's'}, ctx), /sensitive|機密/);
  await assert.rejects(TOOLS['code.glob'].run({pattern: '*', path: 's'}, ctx), /sensitive|機密/);
});

test('realOf follows junctions, also for a file not created yet', t => {
  const {proj, outside} = lab(t);
  assert.equal(realOf(path.join(proj, 'out', 'new', 'file.txt')).toLowerCase(), path.join(fs.realpathSync.native(outside), 'new', 'file.txt').toLowerCase());
  assert.equal(realOf(path.join(proj, 'a.txt')).toLowerCase(), path.join(fs.realpathSync.native(proj), 'a.txt').toLowerCase());
});

test('a write through a junction to outside the working folder asks, even in auto-edit', async t => {
  const {proj} = lab(t);
  const {Agent} = require('../src/agent');
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm'); }}, cwd: proj, mode: 'auto-edit',
    session: {id: 's', cwd: proj, title: '', created: 0, updated: 0, turns: 0}});
  a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  const asked = []; a.approver = async c => { asked.push(c.params.path); return {allow: false}; };
  await a.execute('code.write', {path: 'out/evil.txt', content: 'x'}, 30000, '1');
  await a.execute('code.write', {path: 'inside.txt', content: 'x'}, 30000, '2');
  assert.deepEqual(asked, ['out/evil.txt'], 'only the write that really lands outside asks');
  assert.equal(fs.existsSync(path.join(proj, 'out', 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(proj, 'inside.txt')), true);
});

test('token and key files other tools keep are sensitive; ordinary files are not', () => {
  const home = os.homedir();
  for (const f of [path.join(home, '.npmrc'), path.join(home, '.git-credentials'), path.join(home, '.codex', 'auth.json'),
    path.join(home, '.claude', '.credentials.json'), path.join(home, 'AppData', 'Roaming', 'GitHub CLI', 'hosts.yml'),
    path.join(home, '.docker', 'config.json'), path.join(home, '.kube', 'config'), 'C:/certs/site.pfx', 'C:/keys/putty.ppk', 'store.p12',
    path.join(home, 'AppData', 'Local', 'muser', 'device.enc'), path.join(home, 'AppData', 'Local', 'muser-release', 'npm-token.enc')])
    assert.equal(isSensitivePath(f), true, f);
  for (const f of ['src/auth.json', 'config.json', 'package.json', 'docs/config', path.join(home, '.codex', 'config.toml'), 'notes.enc.md'])
    assert.equal(isSensitivePath(f), false, f);
});
