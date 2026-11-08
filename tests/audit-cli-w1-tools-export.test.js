'use strict';
// audit-cli wave 1 regression tests for the tools and export fixes
// (20a8f20 / 33c033e): grep time-like lines, per-line EOL preservation,
// add-only patch anchor ambiguity, todo truncated/blocked, BOM-safe edits,
// export send timeout, and the trimToFit hard cap on a single huge turn.
// The export sender is only ever pointed at a local http server here —
// no external network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {TOOLS} = require('../src/tools');
const exporter = require('../src/export');

const {after} = require('node:test');
const madeDirs = [];
after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
function ctx() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-')); madeDirs.push(cwd); return {cwd, readFiles: new Set()}; }

test('audit-cli w1: grep does not drop a line whose text holds a time (meet at 10:30)', async () => {
  const c = ctx();
  fs.writeFileSync(path.join(c.cwd, 'notes.txt'), 'meet at 10:30\nplain line\n');
  // Directory search: the hit line is 'notes.txt:1:meet at 10:30' — the
  // ':30' inside the hit text used to make a prefix of the line read as a
  // sensitive path, and the whole line was filtered out.
  const wide = (await TOOLS['code.grep'].run({pattern: 'meet'}, c)).payload.output;
  assert.match(wide, /meet at 10:30/);
  // Single explicit file: the hit line is '1:meet at 10:30' with no path at
  // all, and it must survive the same filtering.
  const single = (await TOOLS['code.grep'].run({pattern: 'meet', path: 'notes.txt'}, c)).payload.output;
  assert.match(single, /meet at 10:30/);
});

test('audit-cli w1: an edit in a mixed-EOL file keeps the endings of lines it did not touch', () => {
  const c = ctx();
  fs.writeFileSync(path.join(c.cwd, 'mixed.txt'), 'alpha\r\nbeta\ngamma\r\ndelta\n');
  TOOLS['code.read'].run({path: 'mixed.txt'}, c);
  TOOLS['code.edit'].run({path: 'mixed.txt', old_string: 'beta', new_string: 'BETA'}, c);
  // Only the edited line may change; every other line keeps its own ending
  // (the old any-CRLF rule rewrote the LF lines to CRLF).
  assert.equal(fs.readFileSync(path.join(c.cwd, 'mixed.txt'), 'utf8'), 'alpha\r\nBETA\ngamma\r\ndelta\n');
});

test('audit-cli w1: an add-only patch whose anchor fits two places is an error, not a silent first match', () => {
  const c = ctx();
  fs.writeFileSync(path.join(c.cwd, 'dup.js'), 'go\nx\ngo\ny\n');
  TOOLS['code.read'].run({path: 'dup.js'}, c);
  const patch = '*** Begin Patch\n*** Update File: dup.js\n@@ go\n+added\n*** End Patch';
  assert.throws(() => TOOLS['code.apply_patch'].run({patch}, c), /fits more than one place/);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'dup.js'), 'utf8'), 'go\nx\ngo\ny\n', 'nothing was written');
});

test('audit-cli w1: todo.write with 60 items reports truncated:true and keeps blocked as blocked', () => {
  const c = ctx();
  const todos = Array.from({length: 60}, (_, i) => ({content: 'task ' + i, status: 'pending'}));
  todos[1] = {content: 'task 1', status: 'in_progress'};
  todos[2] = {content: 'task 2', status: 'blocked'};
  const r = TOOLS['todo.write'].run({todos: JSON.stringify(todos)}, c);
  assert.equal(r.payload.truncated, true);
  assert.equal(r.payload.count, 50);
  assert.equal(r.view.todos.length, 50);
  assert.equal(r.view.todos.find(t => t.content === 'task 2').status, 'blocked');
});

test('audit-cli w1: editing line 1 of a BOM file keeps exactly one BOM', () => {
  const c = ctx(); const f = path.join(c.cwd, 'bom.txt');
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\nsecond\n', 'utf8')]));
  TOOLS['code.read'].run({path: 'bom.txt'}, c);
  // old/new carry the U+FEFF exactly as copied from code.read's first line.
  TOOLS['code.edit'].run({path: 'bom.txt', old_string: '\uFEFFfirst', new_string: '\uFEFFFIRST'}, c);
  const raw = fs.readFileSync(f);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the UTF-8 BOM is still there');
  const text = raw.toString('utf8');
  assert.equal(text, '\uFEFFFIRST\nsecond\n');
  assert.equal(text.split('\uFEFF').length - 1, 1, 'the BOM was not written twice');
});

test('audit-cli w1: sendReport gives up quickly on a receiver that never answers, when timeoutMs is given', async t => {
  const server = http.createServer((req, res) => { req.resume(); /* accept and never respond */ });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  const url = 'http://127.0.0.1:' + server.address().port + '/muser/report';
  const started = Date.now();
  const err = await exporter.sendReport({schema: 1}, {url, timeoutMs: 250}).then(() => null, e => e);
  const elapsed = Date.now() - started;
  assert.ok(err instanceof exporter.ExportSendError, 'the send failed instead of hanging');
  assert.equal(err.status, 0);
  assert.ok(elapsed < 5000, 'it gave up on the timeout, not eventually (took ' + elapsed + 'ms)');
});

test('audit-cli w1: trimToFit brings even a single 7MB turn under 6MB and notes the trim', () => {
  const report = {schema: 1, includesConversation: true, turns: [{user: 'x'.repeat(7 * 1024 * 1024), reply: 'ok'}]};
  exporter.trimToFit(report);
  const bytes = Buffer.byteLength(JSON.stringify(report), 'utf8');
  assert.ok(bytes <= 6 * 1024 * 1024, 'the JSON fits the 6MB cap, got ' + bytes);
  assert.ok(bytes <= exporter.MAX_JSON_BYTES);
  assert.ok(Array.isArray(report.trimmed) && report.trimmed.length > 0, 'the trim is noted in report.trimmed');
  assert.ok(report.turns[0].user.includes('[trimmed]'), 'the cut string carries the trimmed marker');
});
