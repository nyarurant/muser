'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const permissions = require('../src/permissions');
const {decide, alwaysKey} = require('../src/policy');

function useFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-perm-'));
  process.env.MUSER_PERMISSIONS_FILE = path.join(dir, 'permissions.json');
  t.after(() => { delete process.env.MUSER_PERMISSIONS_FILE; fs.rmSync(dir, {recursive: true, force: true}); });
  return process.env.MUSER_PERMISSIONS_FILE;
}

test('mode and always-allow keys are remembered per folder; folder case does not matter', t => {
  useFile(t);
  assert.deepEqual(permissions.load('C:\\proj\\a'), {mode: null, allow: []});
  permissions.saveMode('C:\\proj\\a', 'auto-edit');
  permissions.addAllow('C:\\proj\\a', 'exec:git status');
  permissions.addAllow('C:\\proj\\a', 'exec:git status');
  assert.deepEqual(permissions.load('c:\\PROJ\\a\\'), {mode: 'auto-edit', allow: ['exec:git status']});
  assert.deepEqual(permissions.load('C:\\proj\\b'), {mode: null, allow: []}, 'another folder starts fresh');
  permissions.clearAllow('C:\\proj\\a');
  assert.deepEqual(permissions.load('C:\\proj\\a').allow, []);
});

test('every mode is kept, bypass too; an unknown mode is ignored', t => {
  const f = useFile(t);
  permissions.saveMode('C:\\proj', 'bypass');
  assert.equal(permissions.load('C:\\proj').mode, 'bypass');
  permissions.saveMode('C:\\proj', 'nonsense');
  assert.equal(permissions.load('C:\\proj').mode, 'bypass');
  fs.writeFileSync(f, JSON.stringify({folders: {[permissions.key('C:\\proj')]: {mode: 'yolo', allow: []}}}));
  assert.equal(permissions.load('C:\\proj').mode, null);
});

test('a corrupt file reads as nothing remembered and is replaced on the next save', t => {
  const f = useFile(t);
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(permissions.load('C:\\x'), {mode: null, allow: []});
  permissions.saveMode('C:\\x', 'plan');
  assert.equal(permissions.load('C:\\x').mode, 'plan');
});

test('a remembered key skips the approval it was given for, and only that one', () => {
  const always = new Set([alwaysKey('exec', {command: 'git status --short'})]);
  assert.equal(decide({mode: 'default', kind: 'exec', command: 'system.run', params: {command: 'git status'}, always}), 'allow');
  assert.notEqual(decide({mode: 'default', kind: 'exec', command: 'system.run', params: {command: 'git push'}, always}), 'allow');
});
