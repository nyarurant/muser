'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the store: secure-store resolves its DIR from LOCALAPPDATA at require time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-sessions-'));
process.env.LOCALAPPDATA = tmp;
for (const m of ['../src/secure-store', '../src/sessions']) delete require.cache[require.resolve(m)];
const sessions = require('../src/sessions');
const FILE = sessions.FILE;
const DIR = path.dirname(FILE);

function seed(id) { const s = sessions.create('C:\\work'); s.id = id; sessions.touch(s, 'hello'); return s; }
function leftovers() { return fs.readdirSync(DIR).filter(f => f.includes('.tmp-')); }

test('atomic save: file stays valid JSON and no temp files are left behind', () => {
  seed('11111111-aaaa');
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.ok(Array.isArray(list) && list.some(s => s.id === '11111111-aaaa'));
  assert.deepEqual(leftovers(), []);
});

test('find: exact match wins, unique prefix resolves, ambiguous prefix returns null + flag', () => {
  seed('aaaa-1111'); seed('aaaa-2222'); seed('ab'); seed('abcd'); seed('cccc-3333');
  assert.equal(sessions.find('cccc').id, 'cccc-3333');
  assert.equal(sessions.find.ambiguous, false);
  assert.equal(sessions.find('ab').id, 'ab', 'exact full-id match beats prefix ambiguity');
  assert.equal(sessions.find('aaaa'), null);
  assert.equal(sessions.find.ambiguous, true);
  assert.deepEqual(sessions.findAll('aaaa').map(s => s.id).sort(), ['aaaa-1111', 'aaaa-2222']);
  assert.equal(sessions.find('zzzz'), undefined);
  assert.equal(sessions.find.ambiguous, false);
});

test('corrupt JSON is backed up aside, not wiped, and the store recovers', () => {
  fs.writeFileSync(FILE, 'not json{{{');
  assert.deepEqual(sessions.recent(), []);
  const backups = fs.readdirSync(DIR).filter(f => f.startsWith('sessions.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(DIR, backups[0]), 'utf8'), 'not json{{{', 'original bytes survive in the backup');
  seed('dddd-4444');
  assert.equal(sessions.find('dddd').id, 'dddd-4444');
  assert.deepEqual(leftovers(), []);
});
