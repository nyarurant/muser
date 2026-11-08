'use strict';
// Stage 2 (B1): the standalone export fallback. It must (a) depend on
// Node built-ins only, and (b) keep working when the muser body cannot
// be loaded at all — proven by running bin/muser.js from a copy whose
// src/export-cli.js throws on require, with a crash record waiting in
// the store: the report still comes out, minimal and body-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const REPO = path.join(__dirname, '..');

test('export-standalone requires Node built-ins only', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'export-standalone.js'), 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)|require\("([^"]+)"\)/g)].map(m => m[1] || m[2]);
  assert.ok(reqs.length > 0);
  for (const r of reqs) assert.ok(r.startsWith('node:'), 'non-builtin require: ' + r);
});

test('export with a broken body: the fallback writes the minimal report', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-broken-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  // A minimal copy of the install: bin, the guard chain, the entry — and a
  // body that throws the moment anything requires it.
  fs.mkdirSync(path.join(root, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  for (const f of ['bin/muser.js']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  for (const f of ['src/startup-guard.js', 'src/crash.js', 'src/stack-format.js', 'src/export-entry.js', 'src/export-standalone.js']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  fs.writeFileSync(path.join(root, 'src', 'export-cli.js'), "throw new Error('body is broken on purpose');\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'muser', version: '9.9.9-test'}));
  // The store the fallback reads: one conversation, one transcript, one
  // crash record — the startup crash this whole stage exists for.
  const data = path.join(root, 'data');
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.mkdirSync(path.join(data, 'muser', 'transcripts'), {recursive: true});
  fs.mkdirSync(path.join(data, 'muser', 'crash'), {recursive: true});
  fs.writeFileSync(path.join(data, 'muser', 'sessions.json'), JSON.stringify([{id: sid, cwd: 'C:\\Users\\someone\\work', created: 1762470000000, updated: 1762470001000, turns: 1}]));
  fs.writeFileSync(path.join(data, 'muser', 'transcripts', sid + '.jsonl'), JSON.stringify({v: 1, at: 1762470000000, user: 'words that must not ride', reply: 'x', tools: [{command: 'code.read'}]}) + '\n');
  fs.writeFileSync(path.join(data, 'muser', 'crash', '2026-11-07T00-00-00-000Z-1-abcd.json'), JSON.stringify({muser: '9.9.9-test', error: 'ReferenceError: thing is not defined', scope: 'startup', stack: [{fn: 'main', file: 'bin\\muser.js', line: 1, column: 1}]}));
  const outDir = path.join(root, 'out');
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'muser.js'), 'export', '--dry-run'], {
    encoding: 'utf8', timeout: 30000,
    env: {...process.env, LOCALAPPDATA: data, MUSER_EXPORT_DIR: outDir, USERPROFILE: root, HOME: root},
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok((r.stderr || '').includes('最小限のレポート'), 'the fallback announced itself: ' + r.stderr);
  const file = fs.readdirSync(outDir).find(f => f.endsWith('.json'));
  assert.ok(file, 'a report file was written');
  const report = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
  assert.equal(report.standalone, true);
  assert.equal(report.includesConversation, false);
  assert.equal(report.app.version, '9.9.9-test');
  assert.equal(report.session.id, sid);
  assert.equal(report.session.cwd, 'C:\\Users\\<user>\\work');
  assert.equal(report.crashes.length, 1);
  assert.equal(report.crashes[0].report.scope, 'startup');
  assert.equal(report.loadError.name, 'Error');
  assert.ok(!JSON.stringify(report).includes('words that must not ride'), 'no conversation words in the fallback report');
});

test('standalone unit: shapes from disk, secrets redacted', t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-standalone-unit-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  const sid = 'sess-standalone-1';
  fs.mkdirSync(path.join(data, 'muser', 'crash'), {recursive: true});
  fs.mkdirSync(path.join(data, 'muser', 'logs'), {recursive: true});
  fs.writeFileSync(path.join(data, 'muser', 'sessions.json'), JSON.stringify([{id: sid, cwd: 'C:\\x', created: 1, updated: 2, turns: 1}]));
  fs.writeFileSync(path.join(data, 'muser', 'crash', 'x.json'), JSON.stringify({error: 'Error: mail me at hidden@example.com', token: 'abc123'}));
  fs.writeFileSync(path.join(data, 'muser', 'logs', sid + '.jsonl'), JSON.stringify({at: '2026-11-07T00:00:00.000Z', event: 'plan', decision: 'keep', detail: {goal: 'the request itself'}}) + '\n');
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = data;
  try {
    const standalone = require('../src/export-standalone');
    const report = standalone.buildStandaloneReport({});
    assert.equal(report.session.id, sid);
    assert.equal(report.focusLog.length, 1);
    assert.deepEqual(Object.keys(report.focusLog[0]).sort(), ['at', 'decision', 'event', 'leg', 'round', 'why'].sort());
    const json = JSON.stringify(report);
    assert.ok(!json.includes('hidden@example.com') && !json.includes('abc123') && !json.includes('the request itself'));
    assert.equal(report.crashes[0].report.token, '<redacted>');
  } finally { if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev; }
});
