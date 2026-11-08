'use strict';
// Stage 2 (B1): crash records — including the startup guard's — carry the
// stack's SHAPE (function / file / line / column) and nothing more: no
// repeated message, no user name in a path, no path from outside the
// install beyond its file name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {parseStack, stackOf, shapePath} = require('../src/stack-format');
const crash = require('../src/crash');
const guard = require('../src/startup-guard');

test('parseStack: function, file, line, column — message line skipped', () => {
  // The inside-install path is built from this checkout's own root: the
  // shaping keeps it relative only when it really is inside the install,
  // and a hardcoded folder name would tie the test to one worktree's name.
  const inside = path.join(__dirname, '..', 'src', 'thing.js');
  const stack = ['TypeError: boom "secret words"', '    at doThing (' + inside + ':10:15)', '    at C:\\Users\\nyaru\\other\\place.js:3:7', '    at node:internal/timers:617:6'].join('\n');
  const frames = parseStack(stack, {username: 'nyaru'});
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], {fn: 'doThing', file: 'src\\thing.js', line: 10, column: 15});
  assert.deepEqual(frames[1], {fn: '(anonymous)', file: 'place.js', line: 3, column: 7});
  assert.equal(frames[2].file, 'node:internal/timers');
  const json = JSON.stringify(frames);
  assert.ok(!json.includes('nyaru') && !json.includes('secret'), 'no user name, no message text');
});

test('shapePath: inside the install is relative, outside is a file name', () => {
  const root = path.join(__dirname, '..');
  assert.equal(shapePath(path.join(root, 'src', 'a.js'), {root}), 'src\\a.js');
  assert.equal(shapePath('D:\\someone\\else\\b.js', {root}), 'b.js');
  assert.equal(shapePath('node:fs'), 'node:fs');
});

test('crash.write: the record gains a shaped stack, the message stays first-line only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-crash-stack-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const prev = process.env.MUSER_CRASH_DIR;
  process.env.MUSER_CRASH_DIR = dir;
  try {
    function markerBoom() { throw new Error('first line only "quoted secret"\nsecond line must not ride'); }
    let err = null;
    try { markerBoom(); } catch (e) { err = e; }
    const file = crash.write({version: '0.3.8', error: err});
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(rec.stack) && rec.stack.length >= 1);
    assert.ok(rec.stack.some(f => f.fn === 'markerBoom'), 'the throwing function is named');
    for (const f of rec.stack) { assert.ok('fn' in f && 'file' in f && 'line' in f && 'column' in f); }
    assert.ok(!JSON.stringify(rec).includes('second line'), 'only the first line of the message');
    assert.ok(!JSON.stringify(rec).includes('quoted secret'));
  } finally { if (prev === undefined) delete process.env.MUSER_CRASH_DIR; else process.env.MUSER_CRASH_DIR = prev; }
});

test('startup guard: writes a startup record and the short line', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-guard-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const prev = process.env.MUSER_CRASH_DIR;
  process.env.MUSER_CRASH_DIR = dir;
  const writes = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s, ...rest) => { writes.push(String(s)); if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1](); return true; };
  try {
    const file = guard.recordStartupCrash(new ReferenceError('not defined here'), '0.3.8');
    assert.ok(file && fs.existsSync(file));
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rec.scope, 'startup');
    assert.ok(rec.error.includes('ReferenceError'));
    const line = writes.join('');
    assert.ok(line.includes('起動できませんでした（ReferenceError）'));
    assert.ok(line.includes('muser export で開発者に送れます'));
    assert.ok(line.includes('記録: ' + file));
  } finally {
    process.stderr.write = origWrite;
    if (prev === undefined) delete process.env.MUSER_CRASH_DIR; else process.env.MUSER_CRASH_DIR = prev;
  }
});

test('a body module that throws while loading: one line, one record, exit 1', t => {
  const {spawnSync} = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-startup-crash-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  const REPO = path.join(__dirname, '..');
  fs.copyFileSync(path.join(REPO, 'bin', 'muser.js'), path.join(root, 'bin', 'muser.js'));
  for (const f of ['src/startup-guard.js', 'src/crash.js', 'src/stack-format.js']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  fs.writeFileSync(path.join(root, 'src', 'fast-start.js'), "throw new TypeError('fast-start is broken on purpose');\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'muser', version: '9.9.9-test'}));
  const crashDir = path.join(root, 'crash');
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'muser.js'), '--version'], {encoding: 'utf8', timeout: 30000, env: {...process.env, MUSER_CRASH_DIR: crashDir}});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('起動できませんでした（TypeError）'), r.stderr);
  assert.ok(r.stderr.includes('muser export で開発者に送れます'));
  const files = fs.readdirSync(crashDir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(crashDir, files[0]), 'utf8'));
  assert.equal(rec.scope, 'startup');
  assert.ok(rec.error.includes('TypeError'));
  assert.ok(Array.isArray(rec.stack) && rec.stack.length >= 1);
});

test('stackOf tolerates a non-error', () => {
  assert.deepEqual(stackOf('just a string'), []);
  assert.deepEqual(stackOf(null), []);
});
