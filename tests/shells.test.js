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
  // t6 #8 (deep audit): the old assert here compared a against the START
  // result with an OR, and looked for 'tick 1\n' — PowerShell output is CRLF,
  // so that substring never occurs and the assert was always true. Compare
  // whole tick lines of the first read against the post-kill read instead:
  // no tick number may be delivered twice.
  const ticksOf = s => [...String(s).replace(/\r/g, '').matchAll(/tick (\d+)\n/g)].map(m => m[1]);
  const firstTicks = ticksOf(a.payload.output);
  assert.ok(firstTicks.length >= 1, 'the first read delivered at least one whole tick line: ' + JSON.stringify(a.payload.output));
  assert.equal(TOOLS['shell.list'].run({}, ctx).payload.shells[0].running, true);
  TOOLS['shell.kill'].run({shell_id: 'bg1'}, ctx);
  // A fixed 1500 ms sleep asserted the Windows process tree was gone by then; under
  // load it takes longer and a correct kill failed the test (audit #254). Poll instead.
  let b;
  for (let i = 0; i < 120; i++) {
    b = await TOOLS['shell.output'].run({shell_id: 'bg1'}, ctx);
    if (!b.payload.running) break;
    await new Promise(res => setTimeout(res, 250));
  }
  assert.equal(b.payload.running, false, 'the killed shell stopped');
  assert.deepEqual(ticksOf(b.payload.output).filter(n => firstTicks.includes(n)), [], 'the post-kill read does not repeat any tick the first read delivered');
  assert.ok(!/tick 50/.test(a.payload.output + b.payload.output), 'stopped before the end');
  await assert.rejects(TOOLS['shell.output'].run({shell_id: 'bg9'}, ctx), /No background shell/);
});

test('a finished background shell emits finished once, with a Claude-Code-style status', async () => {
  const shells = new Shells(), ctx = {cwd: process.cwd(), shells, readFiles: new Set()};
  const seen = [];
  shells.on('finished', s => seen.push(s));
  const s = shells.start('Write-Output done', {cwd: process.cwd()});
  for (let i = 0; i < 40 && s.running; i++) await new Promise(r => setTimeout(r, 250));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, s.id); assert.equal(seen[0].exit, 0); assert.equal(seen[0].status, 'completed');
  const bad = shells.start('exit 3', {cwd: process.cwd()});
  for (let i = 0; i < 40 && bad.running; i++) await new Promise(r => setTimeout(r, 250));
  assert.equal(seen.length, 2); assert.equal(seen[1].status, 'failed'); assert.equal(seen[1].exit, 3);
  const r = await TOOLS['system.run'].run({command: 'Start-Sleep -Seconds 30', background: true}, ctx);
  TOOLS['shell.kill'].run({shell_id: r.payload.shell_id}, ctx);
  for (let i = 0; i < 40 && seen.length < 3; i++) await new Promise(res => setTimeout(res, 250));
  assert.equal(seen.length, 3);
  assert.equal(seen[2].status, 'stopped', 'a stopped shell still reports, with status stopped');
});

test('runOnce hands a timed-out command to the background instead of killing it', async () => {
  const shells = new Shells();
  const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
  const r = await runOnce('Write-Output start; Start-Sleep -Seconds 2; Write-Output end', {cwd: process.cwd(), timeout: 800, maxOut: 60000, clip, adopt: (child, out) => shells.adopt('sleepy', {cwd: process.cwd()}, child, out)});
  assert.ok(r.backgrounded, 'moved to the background: ' + JSON.stringify(r).slice(0, 200));
  const s = shells.get(r.backgrounded);
  assert.equal(s.running, true, 'still running after the timeout');
  // This wait had no timeout: a shell that never finishes hung the whole suite with
  // no diagnosis (audit #255). Bound it and say what was being waited for.
  const done = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out after 60 s waiting for shell ' + s.id + ' to finish; output so far: ' + JSON.stringify(s.out).slice(0, 200))), 60000);
    timer.unref?.();
    shells.on('finished', x => { if (x.id === s.id) { clearTimeout(timer); res(x); } });
  });
  assert.equal(done.status, 'completed');
  assert.match(s.out, /start/); assert.match(s.out, /end/);
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

// ---- Audit 2026-11-03, section J (#138-#148) regression tests ----
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const MAXB = 1024 * 1024;
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid; child.exitCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}
const waitFor = async (cond, ms = 15000) => { for (let i = 0; i < ms / 100 && !cond(); i++) await new Promise(r => setTimeout(r, 100)); };

test('#138: a spawn error emits finished exactly once (error and close both fire)', async () => {
  const shells = new Shells();
  const seen = [];
  shells.on('finished', s => seen.push(s));
  const s = shells.start('Write-Output x', {cwd: 'C:\\muser-no-such-dir-a29'});
  await waitFor(() => seen.length >= 1);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(seen.length, 1, 'finished fired once, got ' + seen.length);
  assert.equal(seen[0].id, s.id);
  assert.equal(seen[0].exit, -1, 'the error verdict is kept, not overwritten by close');
});

test('#139: stopped is set only when the kill lands, in kill() and killAll() alike', () => {
  const shells = new Shells();
  const seen = [];
  shells.on('finished', s => seen.push(s));
  const dead = shells.track(fakeChild(999999), {command: 'gone', cwd: process.cwd()});
  const r = shells.kill(dead.id);
  assert.equal(r.killed, false);
  assert.ok(!dead.stopped, 'a failed kill does not claim stopped');
  dead.child.emit('close', 1);
  assert.equal(seen[0].status, 'failed', 'a shell whose kill failed reports failed, not stopped');
  const dead2 = shells.track(fakeChild(999998), {command: 'gone2', cwd: process.cwd()});
  shells.killAll();
  assert.ok(!dead2.stopped, 'killAll does not claim stopped for a pid that is already gone');
  dead2.child.emit('close', 1);
});

test('#139: the shell.kill tool view reports the real kill result', () => {
  const shells = new Shells();
  const s = shells.track(fakeChild(999997), {command: 'gone', cwd: process.cwd()});
  const ctx = {cwd: process.cwd(), shells, readFiles: new Set()};
  const r = TOOLS['shell.kill'].run({shell_id: s.id}, ctx);
  assert.equal(r.payload.killed, false);
  assert.equal(r.view.killed, false, 'the view no longer hardcodes killed: true');
  s.child.emit('close', 1);
});

test('#141/#142: output() never loses text to the cap and an out-of-range since cannot rewind the cursor', async () => {
  const shells = new Shells();
  const s = shells.start('1..30 | ForEach-Object { Write-Output "line $_ end" }', {cwd: process.cwd()});
  await waitFor(() => !s.running);
  const full = s.out;
  assert.ok(full.length > 200, 'enough output to chunk: ' + full.length);
  let got = '', guard = 0;
  for (;;) {
    const r = await shells.output(s.id, {caller: 'chunk', maxChars: 100});
    got += r.output;
    if (!r.output) break;
    assert.ok(++guard < 50, 'chunked reads terminate');
  }
  assert.equal(got, full, 'chunked reads reassemble the whole buffer, in order');
  const future = await shells.output(s.id, {caller: 'future', since: full.length + 9999});
  assert.equal(future.output, '');
  assert.equal(future.next_offset, full.length, 'a since past the end clamps to the end');
  const again = await shells.output(s.id, {caller: 'future'});
  assert.equal(again.output, '', 'the cursor did not rewind: nothing is re-delivered');
  const neg = await shells.output(s.id, {caller: 'neg', since: -5});
  assert.match(neg.output, /line 1 end/, 'a negative since reads from the start');
});

test('#143: an adopted shell keeps stdout/stderr chronology and does not re-deliver the seed to main', async () => {
  const shells = new Shells();
  const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
  const r = await runOnce('Write-Output A; [Console]::Error.WriteLine("B"); Start-Sleep -Seconds 2; Write-Output C', {cwd: process.cwd(), timeout: 800, maxOut: 60000, clip, adopt: (child, out) => shells.adopt('mix', {cwd: process.cwd()}, child, out)});
  assert.ok(r.backgrounded, 'moved to the background');
  const s = shells.get(r.backgrounded);
  assert.ok(s.out.indexOf('A') >= 0 && s.out.indexOf('A') < s.out.indexOf('B'), 'seed keeps arrival order (A before B): ' + JSON.stringify(s.out));
  // t6 #9 (deep audit): this finished-wait had no timeout — the same
  // unbounded hang #255 fixed elsewhere in this file. Bound it the same way.
  const done = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out after 60 s waiting for adopted shell ' + s.id + ' to finish; output so far: ' + JSON.stringify(s.out).slice(0, 200))), 60000);
    timer.unref?.();
    shells.on('finished', x => { if (x.id === s.id) { clearTimeout(timer); res(x); } });
  });
  assert.equal(done.status, 'completed');
  const main = await shells.output(s.id, {});
  assert.match(main.output, /C/);
  assert.ok(!main.output.includes('A') && !main.output.includes('B'), 'main does not get the seed twice: ' + JSON.stringify(main.output));
  const other = await shells.output(s.id, {caller: 'other'});
  assert.match(other.output, /A/);
  assert.match(other.output, /C/);
});

test('#144/#146: adopt() trims an oversized seed at once, without splitting a surrogate pair or an ANSI sequence', () => {
  const shells = new Shells();
  const emojiChar = String.fromCodePoint(0x1F600), esc = String.fromCharCode(27);
  const ch1 = fakeChild(), ch2 = fakeChild();
  const emoji = shells.adopt('emoji', {cwd: process.cwd()}, ch1, 'x' + emojiChar + 'y'.repeat(MAXB - 1));
  assert.ok(emoji.out.length <= MAXB, 'the cap applies to the seed immediately');
  assert.equal(emoji.dropped, 3, 'the cut moved past the whole surrogate pair');
  assert.ok(emoji.out.startsWith('y'));
  const ansi = shells.adopt('ansi', {cwd: process.cwd()}, ch2, 'aaa' + esc + '[31m' + 'b'.repeat(MAXB - 3));
  assert.equal(ansi.dropped, 8, 'the cut moved past the whole escape sequence');
  assert.ok(ansi.out.startsWith('b'));
  ch1.emit('close', 0); ch2.emit('close', 0);
});

test('#145: change events are coalesced under a flood of small chunks', async () => {
  const shells = new Shells();
  const child = fakeChild();
  const s = shells.track(child, {command: 'flood', cwd: process.cwd()});
  let changes = 0;
  shells.on('change', () => changes++);
  for (let i = 0; i < 300; i++) child.stdout.write('x'.repeat(10) + i + ';');
  await new Promise(r => setTimeout(r, 400));
  child.emit('close', 0);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(changes <= 5, 'change events stayed bounded under 300 chunks, got ' + changes);
  assert.ok(s.out.includes('chunk') || s.out.length > 3000, 'all output still arrived');
  assert.match(s.out, /299;/);
});

test('#147 check: cmd commands containing quotes run as written', async () => {
  const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
  const r = await runOnce('echo "hello world"', {shell: 'cmd', cwd: process.cwd(), timeout: 15000, maxOut: 60000, clip});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"hello world"/);
});

test('#148: runOnce works with no timeout/maxOut/clip (defaults, not instant kill or a crash)', async () => {
  const r = await runOnce('Start-Sleep -Seconds 2; Write-Output late', {cwd: process.cwd()});
  assert.ok(!r.killed, 'not killed by a zero default timeout');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /late/);
});

test('#221: the record keeps the shell a run was started / adopted with', async () => {
  const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
  const shells = new Shells();
  const cmd = shells.start('echo hi', {shell: 'cmd', cwd: process.cwd()});
  assert.equal(cmd.shell, 'cmd', 'start() records the cmd choice');
  assert.equal(shells.snapshot(cmd).shell, 'cmd', 'the snapshot carries it');
  const ps = shells.start('Write-Output hi', {cwd: process.cwd()});
  assert.equal(ps.shell, 'powershell', 'no choice reads as the PowerShell default');
  // The adoption path (a foreground run timing out into the background) is where the
  // choice used to be lost: tools.js passes {cwd, shell} and adopt dropped the shell.
  const r = await runOnce('echo bg & ping -n 3 127.0.0.1>nul', {shell: 'cmd', cwd: process.cwd(), timeout: 300, maxOut: 60000, clip, adopt: (child, out) => shells.adopt('bgcmd', {cwd: process.cwd(), shell: 'cmd'}, child, out)});
  assert.ok(r.backgrounded, 'the cmd run was adopted on timeout');
  assert.equal(shells.get(r.backgrounded).shell, 'cmd', 'adopt() keeps the shell on the record');
  shells.killAll();
});
