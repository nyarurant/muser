'use strict';
// The last six of the 100-improvement run (95-100), 2026-11-01. #95 (dead i18n keys)
// has its test in tests/i18n.test.js; the other five live here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('96: settings.numberValue clamps an env override to the setting maximum', () => {
  const settings = require('../src/settings');
  const was = process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
  process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = '999999999';
  try {
    assert.equal(settings.numberValue('maxToolCallsPerTurn'), 100000, 'an extra zero must not lift the cap past its max');
    process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = '42';
    assert.equal(settings.numberValue('maxToolCallsPerTurn'), 42, 'in-range env values pass through');
  } finally {
    if (was === undefined) delete process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
    else process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = was;
  }
});

test('97: web sdkRequest wraps a non-JSON reply and carries the HTTP status', async () => {
  const {createWeb} = require('../src/web');
  const was = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ok: true, status: 200, headers: {getSetCookie: () => []},
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }});
    await assert.rejects(() => createWeb([]).sdkRequest('GET'),
      e => e.parse === true && e.status === 200 && !/Unexpected token/.test(e.message));
    globalThis.fetch = async () => ({ok: false, status: 503, headers: {getSetCookie: () => []}, json: async () => ({})});
    await assert.rejects(() => createWeb([]).sdkRequest('GET'), e => e.status === 503);
  } finally { globalThis.fetch = was; }
});

test('98: usage.record prunes day entries older than a month', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-usage-prune-'));
  process.env.MUSER_USAGE_FILE = path.join(tmp, 'usage.json');
  const usage = require('../src/usage');
  const old = new Date(); old.setDate(old.getDate() - 40);
  const recent = new Date(); recent.setDate(recent.getDate() - 3);
  const bucket = {turns: 5, toolCalls: 7, inChars: 40, outChars: 60};
  usage.save({days: {[usage.dayKey(old)]: bucket, [usage.dayKey(recent)]: bucket}});
  usage.record({turns: 1});
  const days = usage.load().days;
  assert.ok(!(usage.dayKey(old) in days), 'the 40-day-old entry is pruned');
  assert.ok(usage.dayKey(recent) in days, 'recent days are kept');
  assert.equal(days[usage.dayKey()].turns, 1);
});

test('99: muser resume list prints no ANSI escapes when stdout is not a TTY', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-resume-list-'));
  const store = path.join(tmp, 'muser');
  fs.mkdirSync(store, {recursive: true});
  const now = Date.now();
  fs.writeFileSync(path.join(store, 'sessions.json'), JSON.stringify([
    {id: '12345678-1234-1234-1234-1234567890ab', cwd: tmp, title: 'test chat', created: now, updated: now, turns: 2},
  ]));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'muser.js'), 'resume'],
    {encoding: 'utf8', timeout: 30000, env: {...process.env, LOCALAPPDATA: tmp}});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('test chat'), r.stdout);
  assert.ok(!/\x1b\[/.test(r.stdout), 'no escape codes in piped output: ' + JSON.stringify(r.stdout));
});

test('100: an agent definition whose name sanitises to nothing warns instead of vanishing silently', () => {
  const types = require('../src/agent-types');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-types-noname-'));
  fs.mkdirSync(path.join(dir, '.muser', 'agents'), {recursive: true});
  const file = path.join(dir, '.muser', 'agents', 'レビュー.md');
  fs.writeFileSync(file, 'レビューを担当するエージェント。\n');
  const lines = [], orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { types.load(dir); } finally { console.error = orig; }
  const hit = lines.find(l => l.includes(file));
  assert.ok(hit, 'expected a console.error naming the skipped file, got: ' + lines.join(' | '));
  assert.ok(hit.startsWith('muser: エージェント定義をスキップしました'), hit);
});
