'use strict';
// Stage 2 (B2): the freeze watchdog. A child process installs it with a
// short threshold, blocks its own main thread in a named function, and
// the hang record must appear in the crash folder with that function in
// the shaped stack — once, although the freeze is one long stall.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('watchdog: a blocked main thread leaves one hang record with its stack', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-watchdog-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const crashDir = path.join(dir, 'crash');
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, [
    "'use strict';",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const {startWatchdog} = require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'watchdog.js')) + ');',
    'const wd = startWatchdog({thresholdMs: 300, crashDir: ' + JSON.stringify(crashDir) + ', version: "test", sessionId: "s1"});',
    'function busyLoopMarker() { const end = Date.now() + 1600; while (Date.now() < end) {} }',
    'setTimeout(() => { busyLoopMarker(); }, 200);',
    'setTimeout(() => {',
    '  const files = fs.readdirSync(' + JSON.stringify(crashDir) + ').filter(f => f.includes("-hang-"));',
    '  const rec = files.length ? JSON.parse(fs.readFileSync(path.join(' + JSON.stringify(crashDir) + ', files[0]), "utf8")) : null;',
    '  console.log(JSON.stringify({count: files.length, rec}));',
    '  wd.stop();',
    '}, 3200);',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [child], {encoding: 'utf8', timeout: 30000});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.count, 1, 'one hang record for one freeze');
  assert.equal(out.rec.kind, 'hang');
  assert.equal(out.rec.sessionId, 's1');
  assert.ok(Array.isArray(out.rec.stack) && out.rec.stack.some(f => f.fn === 'busyLoopMarker'), 'the stack names the blocking function: ' + JSON.stringify(out.rec.stack));
  for (const f of out.rec.stack) { assert.ok('fn' in f && 'file' in f && 'line' in f && 'column' in f); }
});
