'use strict';
// Crash investigation (src/crash-investigate.js): every source is a sample
// file or string made here — the real event log, the real WER folders and
// the real work log (written by another branch) are never touched. The work
// log sample follows the designed shape (docs/design/new-features.md
// section 1): one JSONL per conversation, one event per line.
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ci = require('../src/crash-investigate');

const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime(); // local 2026-11-07 15:00
const min = m => m * 60000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-crash-test-'));
const iso = ms => new Date(ms).toISOString();

function eventsSample() {
  return JSON.stringify([
    {time: iso(NOW - min(10)), id: 1000, provider: 'Application Error',
     props: ['app.exe', '1.2.3.4', '6a000000', 'core.dll', '9.9.9.9', '6a000000', 'c0000005', '0000000000012345', '0x2a3c', '01dc000000000000'],
     message: '障害のあるアプリケーション名: app.exe、障害のあるモジュール名: core.dll、例外コード: 0xc0000005'},
    {time: iso(NOW - min(10) + 4000), id: 1001, provider: 'Windows Error Reporting', props: [],
     message: '障害のあるアプリケーション名: app.exe、障害のあるモジュール名: core.dll、例外コード: 0xc0000005'},
    {time: iso(NOW - min(20)), id: 1026, provider: '.NET Runtime', props: [],
     message: 'アプリケーション: tool.exe\nフレームワークのバージョン: v4.0\n説明: System.InvalidOperationException が処理されませんでした'},
    {time: iso(NOW - min(180)), id: 1000, provider: 'Application Error',
     props: ['old.exe', '1.0', '0', 'x.dll', '1.0', '0', 'c0000374', '0', '0x1111', '0'], message: ''},
  ]);
}

function werSample(dir, app, whenMs, {withDump = false} = {}) {
  const sub = path.join(dir, 'AppCrash_' + app.replace(/\W/g, '_') + '_xyz789');
  fs.mkdirSync(sub, {recursive: true});
  const ft = String(BigInt(whenMs) * 10000n + 116444736000000000n);
  const lines = [
    'Version=1', 'EventType=APPCRASH', 'EventTime=' + ft, 'ReportType=2',
    'Sig[0].Name=アプリケーション名', 'Sig[0].Value=' + app,
    'Sig[1].Name=アプリケーションのバージョン', 'Sig[1].Value=2.0.0.0',
    'Sig[2].Name=アプリケーションのタイムスタンプ', 'Sig[2].Value=6a000000',
    'Sig[3].Name=障害モジュールの名前', 'Sig[3].Value=engine.dll',
    'Sig[4].Name=障害モジュールのバージョン', 'Sig[4].Value=3.0.0.0',
    'Sig[5].Name=障害モジュールのタイムスタンプ', 'Sig[5].Value=6a000000',
    'Sig[6].Name=例外コード', 'Sig[6].Value=c0000005',
    'Sig[7].Name=例外オフセット', 'Sig[7].Value=000000000000abcd',
    'AppName=' + app, 'AppPath=C:\\Apps\\' + app,
    'LoadedModule[0]=C:\\Apps\\' + app,
  ];
  fs.writeFileSync(path.join(sub, 'Report.wer'), Buffer.from(lines.join('\r\n'), 'utf16le'));
  if (withDump) fs.writeFileSync(path.join(sub, 'memory.dmp'), 'DUMP-CONTENT-MUST-NEVER-BE-READ');
  return sub;
}

function worklogSample(dir) {
  const crashAt = NOW - min(10);
  // The shape src/worklog.js writes: `event` discriminator, ISO `at`, an
  // edit's ranges as {start, end} objects, and no agent on edit events.
  const lines = [
    {v: 1, at: iso(crashAt - min(5)), session: 'conv1', event: 'turn', text: '直して', agent: 'main'},
    {v: 1, at: iso(crashAt - min(4)), session: 'conv1', event: 'tool', command: 'system.run', summary: 'npm test', ok: true},
    {v: 1, at: iso(crashAt - min(3)), session: 'conv1', event: 'edit', path: 'src/parse.js', op: 'edit', beforeHash: 'aaa', afterHash: 'bbb', added: 1, removed: 1, ranges: [{start: 10, end: 20}],
     diff: '--- a/src/parse.js\n+++ b/src/parse.js\n@@ -10,3 +10,4 @@ function parse(input) {\n-old\n+new'},
    {v: 1, at: iso(crashAt - min(2)), session: 'conv1', event: 'edit', path: 'C:\\work\\.env', withheld: 'sensitive path'},
    {v: 1, at: iso(crashAt - min(90)), session: 'conv1', event: 'edit', path: 'src/old.js', op: 'edit', beforeHash: 'eee', afterHash: 'fff', added: 1, removed: 1, ranges: [{start: 1, end: 2}], diff: '@@ -1 +1 @@\n-x\n+y'},
    {v: 1, at: iso(crashAt - min(1)), session: 'conv1', event: 'reply', text: '直しました', agent: 'main'},
    'not json at all',
  ];
  fs.mkdirSync(path.join(dir, 'blobs'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'blobs', 'aaa'), 'BEFORE-TEXT-MUST-NEVER-BE-READ');
  fs.writeFileSync(path.join(dir, 'conv1.jsonl'), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
}

test('normalizeCode: hex, 0x and decimal spellings agree', () => {
  assert.equal(ci.normalizeCode('c0000005'), '0xc0000005');
  assert.equal(ci.normalizeCode('0xC0000005'), '0xc0000005');
  assert.equal(ci.normalizeCode('-1073741819'), '0xc0000005');
  assert.equal(ci.normalizeCode(''), null);
  assert.equal(ci.normalizeCode('not-a-code'), null);
});

test('parseEventLogJson: 1000 reads its properties, 1026 names the exception type', () => {
  const events = ci.parseEventLogJson(eventsSample());
  assert.equal(events.length, 4);
  const e1000 = events.find(e => e.detail.id === 1000 && e.app === 'app.exe');
  assert.equal(e1000.code, '0xc0000005');
  assert.equal(e1000.module, 'core.dll');
  assert.equal(e1000.detail.pid, 0x2a3c);
  const e1026 = events.find(e => e.detail.id === 1026);
  assert.equal(e1026.app, 'tool.exe');
  assert.equal(e1026.detail.exceptionType, 'System.InvalidOperationException');
  // A single event object (ConvertTo-Json of one) parses too, and junk is dropped.
  assert.equal(ci.parseEventLogJson(JSON.stringify({time: iso(NOW), id: 1000, props: [], message: ''})).length, 1);
  assert.deepEqual(ci.parseEventLogJson(''), []);
  assert.deepEqual(ci.parseEventLogJson('{"time":"nope"}'), []);
});

test('parseEventLogJson: a WER 1001 names its app from the signature, a kernel report from its event name', () => {
  const events = ci.parseEventLogJson(JSON.stringify([
    {time: iso(NOW - min(8)), id: 1001, provider: 'Windows Error Reporting', props: [],
     message: '障害バケット 123、種類 0\nイベント名: APPCRASH\n問題の署名:\nP1: game.exe\nP2: 1.0.0.0\nP4: engine.dll\nP7: c0000005'},
    {time: iso(NOW - min(9)), id: 1001, provider: 'Windows Error Reporting',
     props: ['LKD_0x117_Tdr:9_IMAGE_amdkmdag.sys-HWS:1-V', '0', 'LiveKernelEvent'],
     message: 'イベント名: LiveKernelEvent\n問題の署名:\nP1: 117'},
  ]));
  assert.equal(events[0].app, 'game.exe');
  assert.equal(events[0].module, 'engine.dll');
  assert.equal(events[0].code, '0xc0000005');
  assert.equal(events[1].app, 'LiveKernelEvent');
  assert.equal(events[1].module, 'amdkmdag.sys');
});

test('parseWerReport: Sig values come by index, EventTime is a FILETIME', () => {
  const ft = String(BigInt(NOW) * 10000n + 116444736000000000n);
  const r = ci.parseWerReport(['EventType=APPCRASH', 'EventTime=' + ft, 'Sig[0].Value=app.exe', 'Sig[3].Value=engine.dll', 'Sig[6].Value=c0000005', 'AppPath=C:\\secret\\app.exe'].join('\n'));
  assert.equal(r.app, 'app.exe');
  assert.equal(r.module, 'engine.dll');
  assert.equal(r.code, '0xc0000005');
  assert.ok(Math.abs(r.time - NOW) < 1000, 'filetime converts back to the same moment');
});

test('readMuserCrashes: the time is the file name, unknown fields are ignored', () => {
  const dir = tmp();
  const name = iso(NOW - min(5)).replace(/[:.]/g, '-') + '-999-abcd1234.json';
  fs.writeFileSync(path.join(dir, name), JSON.stringify({muser: '0.3.8', node: 'v22.0.0', windows: '10.0', error: 'TypeError: x is not a function', scope: 'session', sessionId: 's1', brandNewField: {nested: true}}));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{oops');
  fs.writeFileSync(path.join(dir, iso(NOW - min(500)).replace(/[:.]/g, '-') + '-998-eeee5555.json'), JSON.stringify({error: 'ancient'}));
  const out = ci.readMuserCrashes({dir, since: NOW - min(60), until: NOW + min(1)});
  assert.equal(out.length, 1);
  assert.equal(out[0].time, NOW - min(5));
  assert.equal(out[0].detail.error, 'TypeError: x is not a function');
  assert.equal(out[0].detail.version, '0.3.8');
});

test('readWorklogEdits: edits only, sensitive paths masked, blobs never read', () => {
  const dir = tmp();
  worklogSample(dir);
  const {edits} = ci.readWorklogEdits({dir, since: NOW - min(120), until: NOW});
  assert.equal(edits.length, 3);
  const parse = edits.find(e => e.path === 'src/parse.js');
  assert.equal(parse.agent, null); // a real edit event carries no agent
  assert.equal(parse.func, 'function parse(input)');
  assert.equal(parse.conversation, 'conv1');
  const env = edits.find(e => e.sensitive);
  assert.equal(env.path, null);
  assert.ok(!JSON.stringify(edits).includes('.env'), 'the sensitive path itself is not carried');
  assert.ok(!JSON.stringify(edits).includes('TOKEN'), 'diff text is not carried');
  assert.ok(!JSON.stringify(edits).includes('BEFORE-TEXT'), 'blob text is not carried');
});

test('mergeCrashes: an event and its WER twin are one fall', () => {
  const merged = ci.mergeCrashes([
    {kind: 'event', time: NOW, app: 'app.exe', code: null, module: null, detail: {}},
    {kind: 'wer', time: NOW + 3000, app: 'app.exe', code: '0xc0000005', module: 'core.dll', detail: {}},
    {kind: 'event', time: NOW + min(5), app: 'other.exe', code: '0xc0000374', module: null, detail: {}},
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.find(c => c.app === 'app.exe').kinds, ['event', 'wer']);
  assert.equal(merged.find(c => c.app === 'app.exe').code, '0xc0000005');
});

test('investigate: sources line up, edits attach to the fall before them', async () => {
  const root = tmp();
  const werDir = path.join(root, 'wer');
  fs.mkdirSync(werDir, {recursive: true});
  const werSub = werSample(werDir, 'game.exe', NOW - min(30), {withDump: true});
  const nodeDir = path.join(root, 'cwd');
  fs.mkdirSync(nodeDir, {recursive: true});
  const nodeFile = path.join(nodeDir, 'report.20261107.144500.4242.0.001.json');
  fs.writeFileSync(nodeFile, JSON.stringify({
    header: {trigger: 'fatalerror', processId: 4242, dumpEventTime: new Date(NOW - min(15)).toUTCString()},
    javascriptStack: {message: 'boom "quoted secret" token=abc123\n    at somewhere', stack: 'long stack'},
  }));
  fs.utimesSync(nodeFile, new Date(NOW - min(15)), new Date(NOW - min(15)));
  fs.utimesSync(path.join(werSub, 'Report.wer'), new Date(NOW - min(30)), new Date(NOW - min(30)));
  const crashDir = path.join(root, 'crash');
  fs.mkdirSync(crashDir, {recursive: true});
  const crashName = iso(NOW - min(5)).replace(/[:.]/g, '-') + '-999-abcd1234.json';
  fs.writeFileSync(path.join(crashDir, crashName), JSON.stringify({muser: '0.3.8', error: 'Error: render died', scope: 'fatal'}));
  const worklogDir = path.join(root, 'worklog');
  fs.mkdirSync(worklogDir, {recursive: true});
  worklogSample(worklogDir);

  const rep = await ci.investigate({now: NOW, eventsText: eventsSample(), werDirs: [werDir], nodeReportDirs: [nodeDir], crashDir, worklogDir, cwd: nodeDir});
  // app.exe (1000+1001 merged), tool.exe (1026), game.exe (WER), node, muser = 5 falls; the 3h-old event is outside.
  assert.equal(rep.crashes.length, 5, JSON.stringify(rep.crashes.map(c => [c.kind, c.app])));
  const appCrash = rep.crashes.find(c => c.app === 'app.exe');
  assert.deepEqual(appCrash.kinds, ['event']); // its 1001 twin has the same app/code/time and merges into kinds
  assert.ok(appCrash.edits.some(e => e.path === 'src/parse.js'), 'the parse.js edit 3 minutes before is attached');
  assert.ok(appCrash.edits.every(e => e.path !== 'src/old.js'), 'the 90-minutes-before edit is outside the 30-minute line-up');
  const game = rep.crashes.find(c => c.app === 'game.exe');
  assert.equal(game.module, 'engine.dll');
  assert.equal(game.detail.dumps.length, 1);
  const node = rep.crashes.find(c => c.kind === 'node');
  assert.equal(node.detail.error, 'boom <quoted> token=<redacted>');

  const text = ci.formatText(rep);
  assert.ok(text.includes('app.exe が 0xc0000005 で落ちました（モジュール core.dll）'), text);
  assert.ok(text.includes('その3 分前、src/parse.js (function parse(input)) を変更'), text); // no agent: a real edit event carries none
  assert.ok(text.includes('（機密ファイル）'), text);
  assert.ok(text.includes('ダンプ（読みません）'), text);
  assert.ok(!text.includes('DUMP-CONTENT'), 'dump contents never appear');
  assert.ok(!text.includes('AppPath'), 'WER paths and loaded modules never appear');
  assert.ok(!text.includes('abc123'), 'secrets in an error message are redacted');
  assert.ok(!text.includes('.env'), 'the sensitive file is never named');
  const prompt = ci.formatPrompt(rep);
  assert.ok(prompt.includes('この変更が原因か確かめてください'), prompt);
  assert.ok(prompt.includes('ダンプファイルは読まないでください'), prompt);
});

test('investigate: a process filter narrows the falls', async () => {
  const rep = await ci.investigate({now: NOW, eventsText: eventsSample(), werDirs: [], nodeReportDirs: [], crashDir: path.join(tmp(), 'none'), worklogDir: path.join(tmp(), 'none'), process: 'tool'});
  assert.deepEqual(rep.crashes.map(c => c.app), ['tool.exe']);
  assert.ok(ci.formatText(rep).includes('プロセス名 tool で絞り込みました'));
});

test('investigate: nothing found, and a broken source is a note, not a failure', async () => {
  const rep = await ci.investigate({now: NOW, runEvents: async () => { throw new Error('access denied'); }, werDirs: [], nodeReportDirs: [], crashDir: path.join(tmp(), 'none'), worklogDir: path.join(tmp(), 'none')});
  assert.equal(rep.crashes.length, 0);
  assert.equal(rep.sources.events.ok, false);
  const text = ci.formatText(rep);
  assert.ok(text.includes('見つかりませんでした'), text);
  assert.ok(text.includes('※ イベントログ は読めませんでした'), text);
});

test('formatTime: today is HH:MM, another day carries its date', () => {
  assert.equal(ci.formatTime(NOW - min(10), NOW), '14:50');
  assert.equal(ci.formatTime(new Date(2026, 10, 6, 9, 5).getTime(), NOW), '11/6 09:05');
});

// /crash in the TUI: the investigate function is swapped for a fixed report
// (the real one reads this machine's event log), submit is stubbed, and the
// panel + the hand-off to Muse are what is pinned.
test('/crash: the panel is pushed and the fall is handed to Muse; no fall, no turn', async () => {
  const {EventEmitter} = require('node:events');
  class FakeAgent extends EventEmitter {
    constructor() {
      super();
      this.mode = 'default'; this.cwd = process.cwd(); this.session = {id: 'x', turns: 0};
      this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
    }
  }
  FakeAgent.DEVICE = 'test';
  const {Controller, COMMANDS} = await import('../src/ui/controller.mjs');
  assert.ok(COMMANDS.some(([n]) => n === '/crash'), '/crash is in the command list');
  const orig = ci.investigate;
  try {
    ci.investigate = async () => ({generatedAt: NOW, now: NOW, windowHours: 1, beforeMin: 30, process: null,
      crashes: [{kind: 'event', time: NOW - min(10), app: 'app.exe', code: '0xc0000005', module: 'core.dll', detail: {id: 1000, pid: 7}, kinds: ['event'], edits: []}], sources: {}});
    const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: 't', onExit() {}});
    const sent = [];
    ctrl.submit = async text => { sent.push(text); };
    await ctrl.slash('/crash');
    const entry = ctrl.get().entries.find(e => e.type === 'crash');
    assert.ok(entry, 'a crash panel entry is pushed');
    assert.ok(entry.lines.some(l => l.includes('app.exe が 0xc0000005 で落ちました')), entry.lines.join(' / '));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('この変更が原因か確かめてください'), sent[0]);
    ci.investigate = async () => ({generatedAt: NOW, now: NOW, windowHours: 1, beforeMin: 30, process: null, crashes: [], sources: {}});
    const ctrl2 = new Controller({agent: new FakeAgent(), museName: 'm', version: 't', onExit() {}});
    ctrl2.submit = async text => { sent.push(text); };
    await ctrl2.slash('/crash app');
    assert.equal(sent.length, 1, 'no turn is started when nothing fell');
    assert.ok(ctrl2.get().entries.some(e => e.type === 'crash'));
  } finally { ci.investigate = orig; }
});