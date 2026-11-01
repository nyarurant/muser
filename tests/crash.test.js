'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a crash report keeps versions, the terminal, the error and state shapes, never content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-crash-'));
  t.after(() => { fs.rmSync(dir, {recursive: true, force: true}); delete process.env.MUSER_CRASH_DIR; });
  process.env.MUSER_CRASH_DIR = dir;
  const crash = require('../src/crash');
  const secret = 'my password is hunter2';
  const file = crash.write({version: '9.9.9', error: new Error('Maximum update depth exceeded'), trail: [[1, 'text,pos'], [2, 'agents']],
    state: {busy: true, text: secret, entries: [{type: 'md', rows: [secret]}], stream: {partial: secret}, agents: [{state: 'working', title: secret}], running: {call: {command: 'system.run', params: {command: secret}}, tail: [secret]}}});
  const raw = fs.readFileSync(file, 'utf8'), r = JSON.parse(raw);
  assert.equal(r.muser, '9.9.9');
  assert.match(r.error, /Maximum update depth/);
  assert.deepEqual(r.state.agents, ['working']);
  assert.equal(r.state.textLength, secret.length);
  assert.equal(r.state.running.command, 'system.run');
  assert.deepEqual(r.trail, [[1, 'text,pos'], [2, 'agents']]);
  assert.ok(!raw.includes('hunter2'), 'nothing typed or said ends up in the report');
});
