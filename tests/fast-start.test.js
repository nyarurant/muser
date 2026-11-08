'use strict';
// src/fast-start.js: Ink's `import {throttle} from 'es-toolkit/compat'` loaded the whole compat
// library (413 files, ~157 ms of a 0.5 s start on Windows). With the hook, loading Ink opens a
// handful of es-toolkit files, and throttle still works.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const mod = require('node:module');

const root = path.join(__dirname, '..');
const probe = withHook => `
  const fs = require('fs'); const orig = fs.openSync; let n = 0;
  fs.openSync = function (p, ...r) { if (String(p).includes('es-toolkit')) n++; return orig.call(this, p, ...r); };
  ${withHook ? "require('./src/fast-start');" : ''}
  import('ink').then(async () => {
    const {throttle} = await import('./src/ui/es-toolkit-throttle.mjs');
    let calls = 0; const f = throttle(() => calls++, 50); f(); f(); f();
    console.log(JSON.stringify({n, throttle: typeof throttle, calls}));
  });`;
const run = withHook => JSON.parse(spawnSync(process.execPath, ['-e', probe(withHook)], {cwd: root, encoding: 'utf8'}).stdout.trim().split('\n').pop());

test('fast-start: loading Ink no longer opens the whole es-toolkit compat library', {skip: typeof mod.registerHooks !== 'function' && 'module.registerHooks is not available'}, () => {
  const without = run(false), withHook = run(true);
  assert.ok(without.n > 100, 'without the hook the barrel loads hundreds of files (' + without.n + ')');
  assert.ok(withHook.n <= 10, 'with the hook only a few es-toolkit files open (' + withHook.n + ')');
  assert.equal(withHook.throttle, 'function');
  assert.equal(withHook.calls, 1, 'throttle runs the leading call once');
});
