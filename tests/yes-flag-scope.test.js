'use strict';
// --yes belongs to hunt, race and export. It used to have one scope row per feature
// branch, so `muser hunt --yes` (documented in the help) was always refused by the
// race row: "--yes はこの使い方では使えません". Found by running hunt for real.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-yes-scope-'));
test.after(() => { try { fs.rmSync(home, {recursive: true, force: true}); } catch {} });
const run = args => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', timeout: 30000, env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: home, MUSER_UPDATE_CHECK: '0'}});

test('hunt --yes passes the flag check (it fails later, on the bad severity, not on --yes)', () => {
  const r = run(['hunt', '--yes', '--fix', 'Bogus']);
  assert.doesNotMatch(r.stderr, /--yes はこの使い方では使えません/);
  assert.match(r.stderr, /重要度の指定が正しくありません/);
});

test('--yes is still refused where it does not belong', () => {
  const r = run(['status', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--yes はこの使い方では使えません/);
});

test('every flag has one scope row (no flag split across rows)', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const table = src.match(/const scoped = \[([\s\S]*?)\n  \];/)[1];
  const flags = [...table.matchAll(/\['(--[a-z-]+)'/g)].map(m => m[1]);
  assert.deepEqual(flags.filter((f, i) => flags.indexOf(f) !== i), []);
});
