'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {TOOLS} = require('../src/tools');
const {Shells, runOnce} = require('../src/shells');

test('background shell: starts at once, output is read incrementally, kill stops it', async () => {
  const shells = new Shells(), ctx = {cwd: process.cwd(), shells, readFiles: new Set()};
  const cmd = 'for ($i = 1; $i -le 50; $i++) { Write-Output "tick $i"; Start-Sleep -Milliseconds 200 }';
  const t0 = Date.now(), r = await TOOLS['system.run'].run({command: cmd, background: true}, ctx);
  assert.ok(Date.now() - t0 < 5000, 'returns without waiting for the command');
  assert.equal(r.payload.shell_id, 'bg1'); assert.ok(r.payload.running);
  const a = await TOOLS['shell.output'].run({shell_id: 'bg1', wait_s: 3}, ctx);
  assert.match(a.payload.output, /tick \d+/);
  assert.ok(!a.payload.output.includes('tick 1\n') || !r.payload.output.includes('tick 1\n'), 'second read does not repeat the first');
  assert.equal(TOOLS['shell.list'].run({}, ctx).payload.shells[0].running, true);
  TOOLS['shell.kill'].run({shell_id: 'bg1'}, ctx);
  await new Promise(res => setTimeout(res, 1500));
  const b = await TOOLS['shell.output'].run({shell_id: 'bg1'}, ctx);
  assert.equal(b.payload.running, false);
  assert.ok(!/tick 50/.test(a.payload.output + b.payload.output), 'stopped before the end');
  await assert.rejects(TOOLS['shell.output'].run({shell_id: 'bg9'}, ctx), /No background shell/);
});

test('shell.output read cursors are per caller (default is the shared main cursor)', async () => {
  const shells = new Shells();
  const s = shells.start('Write-Output "line1"; Write-Output "line2"', {cwd: process.cwd()});
  for (let i = 0; i < 40 && shells.all()[0].running; i++) await new Promise(r => setTimeout(r, 250));
  assert.equal(shells.all()[0].running, false);
  const a = await shells.output(s.id, {caller: 'a1'});
  assert.match(a.output, /line1/); assert.match(a.output, /line2/);
  // A different caller has its own cursor: it sees the same output a1 already consumed.
  const b = await shells.output(s.id, {caller: 'a2'});
  assert.match(b.output, /line1/); assert.match(b.output, /line2/);
  // And a1 does not see it twice.
  const aAgain = await shells.output(s.id, {caller: 'a1'});
  assert.equal(aAgain.output, '');
  // The TOOLS wrapper forwards params.caller the same way.
  const ctx = {cwd: process.cwd(), shells, readFiles: new Set()};
  const viaTool = await TOOLS['shell.output'].run({shell_id: s.id, caller: 'a3'}, ctx);
  assert.match(viaTool.payload.output, /line1/);
  // The default (main) cursor is independent of a1/a2/a3 and backward compatible.
  const main = await shells.output(s.id, {});
  assert.match(main.output, /line1/);
  const mainAgain = await shells.output(s.id, {});
  assert.equal(mainAgain.output, '');
});

test('runOnce resolves on timeout and on abort instead of hanging', async () => {
  const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
  const t0 = Date.now();
  const r = await runOnce('Start-Sleep -Seconds 30', {cwd: process.cwd(), timeout: 1000, maxOut: 60000, clip});
  assert.equal(r.killed, 'timeout');
  assert.ok(Date.now() - t0 < 15000, 'timeout result arrives promptly, took ' + (Date.now() - t0) + 'ms');
  const ac = new AbortController();
  const t1 = Date.now();
  const p = runOnce('Start-Sleep -Seconds 30', {cwd: process.cwd(), timeout: 60000, signal: ac.signal, maxOut: 60000, clip});
  setTimeout(() => ac.abort(), 300);
  const r2 = await p;
  assert.equal(r2.killed, 'cancelled');
  assert.ok(Date.now() - t1 < 15000, 'abort result arrives promptly, took ' + (Date.now() - t1) + 'ms');
});

test('a background command that asks for input gets end-of-input instead of waiting forever', async () => {
  const shells = new Shells();
  const s = shells.start('set /p X=name? & echo got [%X%]', {shell: 'cmd', cwd: process.cwd()});
  try {
    const r = await shells.output(s.id, {waitS: 0});
    for (let i = 0; i < 40 && s.running; i++) await new Promise(res => setTimeout(res, 250));
    assert.equal(s.running, false, 'it ended: ' + JSON.stringify(r));
    assert.match(s.out, /got \[/);
  } finally { shells.killAll(); }
});
