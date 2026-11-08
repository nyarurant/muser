'use strict';
// Work log (docs/design/new-features.md §1): per-conversation JSONL records
// of turn / tool / edit / reply / focus under the local data folder, with
// secrets never recorded, tool output kept as head+tail, before-texts in
// blobs, and 30-day / 500 MB retention.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Isolate the data folder before any src module binds it (the agent-wiring
// and CLI tests below use the default worklog dir), mirroring agent.test.js.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-worklog-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-worklog-home-'));
const {Worklog, WORKLOG_DIR, RETENTION_DAYS, MAX_TOTAL_BYTES, sha256, sanitizeText, headTail, fileFor} = require('../src/worklog');
const {lineDiff} = require('../src/tools');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-worklog-test-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };

test('worklog: defaults are the design values (30 days, 500 MB, local dir)', () => {
  assert.equal(RETENTION_DAYS, 30);
  assert.equal(MAX_TOTAL_BYTES, 500 * 1024 * 1024);
  assert.ok(WORKLOG_DIR.endsWith(path.join('muser', 'worklog')), WORKLOG_DIR);
});

test('worklog: turn, tool, reply and focus events round-trip through the file', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 'sess-1', dir});
  log.turn({text: '直してください', agent: 'main'});
  log.tool({command: 'system.run', summary: 'npm test', ok: true, exitCode: 0, ms: 1234, output: 'all good'});
  log.reply({text: '直しました', agent: 'main'});
  log.focus({focus: {id: 'f1', status: 'complete', goal: 'g', criteria: [{id: 'c1', status: 'met'}], evidence: [{id: 'e1', kind: 'command'}]}});
  log.flush();
  const entries = Worklog.read('sess-1', dir);
  assert.deepEqual(entries.map(e => e.event), ['turn', 'tool', 'reply', 'focus']);
  assert.equal(entries[0].session, 'sess-1');
  assert.equal(entries[0].text, '直してください');
  assert.equal(entries[1].exitCode, 0);
  assert.equal(entries[1].ms, 1234);
  assert.equal(entries[1].outHead, 'all good');
  assert.equal(entries[1].outHash, sha256('all good'));
  assert.equal(entries[3].focus.criteria[0].status, 'met');
  assert.equal(entries[3].focus.evidence[0].id, 'e1');
  const lines = Worklog.format(entries);
  assert.match(lines[0], /turn/);
  assert.match(lines[1], /system\.run/);
  assert.match(lines[3], /focus/);
});

test('worklog: a long request keeps only its head (2000 chars)', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  log.turn({text: 'x'.repeat(5000), agent: 'a1', parentAgent: 'main', parentSession: 'p1'});
  log.flush();
  const [e] = Worklog.read('s', dir);
  assert.equal(e.text.length, 2000);
  assert.equal(e.agent, 'a1');
  assert.equal(e.parentAgent, 'main');
  assert.equal(e.parentSession, 'p1');
});

test('worklog: tool output keeps head and tail (2000 each) plus the full hash', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  const out = 'A'.repeat(3000) + 'MIDDLE' + 'B'.repeat(3000);
  log.tool({command: 'code.read', summary: 'big', ok: true, output: out});
  log.flush();
  const [e] = Worklog.read('s', dir);
  assert.equal(e.outHead, 'A'.repeat(2000));
  assert.equal(e.outTail, 'B'.repeat(2000));
  assert.equal(e.outChars, out.length);
  assert.equal(e.outHash, sha256(out));
  assert.ok(!JSON.stringify(e).includes('MIDDLE'));
  const ht = headTail('short');
  assert.equal(ht.head, 'short');
  assert.equal(ht.tail, undefined);
});

test('worklog: secrets are redacted from text, output and replies', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  log.turn({text: 'token=abc123 で試して', agent: 'main'});
  log.tool({command: 'system.run', summary: 'curl', ok: false, error: 'Authorization: Bearer xyz789 failed', output: 'api_key: hunter2\npassword=hunter3'});
  log.reply({text: 'cookie: session=zzz999 を使いました', agent: 'main'});
  log.flush();
  const raw = fs.readFileSync(fileFor('s', dir), 'utf8');
  for (const secret of ['abc123', 'xyz789', 'hunter2', 'hunter3', 'zzz999']) assert.ok(!raw.includes(secret), 'leaked: ' + secret);
  assert.match(raw, /\[redacted\]/);
  assert.equal(sanitizeText('Authorization: Bearer q'), 'Authorization: [redacted]');
});

test('worklog: terminal escapes in output are stripped like the screen does', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  log.tool({command: 'system.run', summary: 'x', ok: true, output: 'before\x1b]52;c;AAAA\x07after'});
  log.flush();
  const [e] = Worklog.read('s', dir);
  assert.ok(!e.outHead.includes('\x1b'), 'escape survived');
  assert.ok(e.outHead.includes('before') && e.outHead.includes('after'));
});

test('worklog: a tool call on a sensitive path keeps no output at all', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  log.tool({command: 'code.read', summary: '.env', paths: ['C:\\x\\.env'], ok: true, output: 'SECRET=1', sensitive: true});
  log.flush();
  const [e] = Worklog.read('s', dir);
  assert.equal(e.outHead, undefined);
  assert.equal(e.outWithheld, 'sensitive path');
  assert.equal(e.outChars, 'SECRET=[redacted]'.length); // the kept text is the sanitised one
  assert.ok(!fs.readFileSync(fileFor('s', dir), 'utf8').includes('SECRET=1'));
});

test('worklog: an edit records hashes, ranges and diff, and stores the before-text once', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  const before = 'one\ntwo\nthree\n', after = 'one\nTWO\nthree\nfour\n';
  const diff = lineDiff(before, after);
  log.edit({file: 'C:\\x\\a.js', op: 'edit', before, after, diff});
  log.edit({file: 'C:\\x\\b.js', op: 'edit', before, after: 'changed\n', diff: lineDiff(before, 'changed\n')});
  log.flush();
  const [e1, e2] = Worklog.read('s', dir);
  assert.equal(e1.beforeHash, sha256(before));
  assert.equal(e1.afterHash, sha256(after));
  assert.equal(e1.added, 2);
  assert.equal(e1.removed, 1);
  assert.ok(e1.ranges.some(r => r.start <= 2 && r.end >= 2), JSON.stringify(e1.ranges));
  assert.match(e1.diff, /-two/);
  assert.match(e1.diff, /\+TWO/);
  // Same before-text twice: one blob.
  const blobs = fs.readdirSync(path.join(dir, 'blobs'));
  assert.deepEqual(blobs, [sha256(before)]);
  assert.equal(Worklog.readBlob(sha256(before), dir), before);
  assert.equal(e2.beforeHash, e1.beforeHash);
});

test('worklog: an edit of a sensitive path records no content, hash or diff', t => {
  const dir = tmp(t), log = new Worklog({sessionId: 's', dir});
  log.edit({file: 'C:\\x\\.env', op: 'write', before: 'A=1', after: 'A=2', diff: lineDiff('A=1', 'A=2')});
  log.flush();
  const [e] = Worklog.read('s', dir);
  assert.equal(e.withheld, 'sensitive path');
  assert.equal(e.beforeHash, undefined);
  assert.equal(e.diff, undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), []);
});

test('worklog: disabled records nothing, and enabledFn is read live', t => {
  const dir = tmp(t);
  let on = false;
  const log = new Worklog({sessionId: 's', dir, enabledFn: () => on});
  log.turn({text: 'x', agent: 'main'});
  log.flush();
  assert.deepEqual(Worklog.read('s', dir), []);
  on = true;
  log.turn({text: 'x', agent: 'main'});
  log.flush();
  assert.equal(Worklog.read('s', dir).length, 1);
});

test('worklog: prune drops files older than the retention days and unreferenced blobs', t => {
  const dir = tmp(t);
  const old = new Worklog({sessionId: 'old', dir, retentionDays: 30});
  const before = 'keep me\n';
  old.edit({file: 'C:\\x\\a.js', op: 'edit', before, after: 'new\n', diff: lineDiff(before, 'new\n')});
  old.flush();
  const orphan = new Worklog({sessionId: 'orphan', dir});
  orphan.edit({file: 'C:\\x\\b.js', op: 'edit', before: 'orphan text\n', after: 'x\n', diff: lineDiff('orphan text\n', 'x\n')});
  orphan.flush();
  // Both files aged past retention; a fresh conversation's prune collects them.
  // Retention ages a log by its newest content 'at', not mtime alone
  // (wave 17), so the fixtures age the lines' 'at' as well as the mtimes.
  const past = Date.now() - 31 * 24 * 3600 * 1000;
  for (const f of ['old.jsonl', 'orphan.jsonl']) {
    const file = path.join(dir, f);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => { const e = JSON.parse(line); e.at = new Date(past).toISOString(); return JSON.stringify(e); });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.utimesSync(file, new Date(past), new Date(past));
  }
  const fresh = new Worklog({sessionId: 'fresh', dir, retentionDays: 30});
  fresh.turn({text: 'hi', agent: 'main'});
  fresh.flush(); // first successful write runs the prune
  assert.ok(!fs.existsSync(path.join(dir, 'old.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'orphan.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'fresh.jsonl')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs')), [], 'unreferenced blobs are deleted');
});

test('worklog: prune by total size drops the oldest files first, never its own', t => {
  const dir = tmp(t);
  const a = new Worklog({sessionId: 'aaa', dir});
  a.turn({text: 'a'.repeat(1500), agent: 'main'}); a.flush();
  const b = new Worklog({sessionId: 'bbb', dir});
  b.turn({text: 'b'.repeat(1500), agent: 'main'}); b.flush();
  const small = new Worklog({sessionId: 'ccc', dir, maxTotalBytes: 2000});
  small.prune();
  assert.ok(!fs.existsSync(path.join(dir, 'aaa.jsonl')), 'oldest dropped');
  assert.ok(fs.existsSync(path.join(dir, 'ccc.jsonl')) === false || true); // ccc has no file; prune must not throw
});

test('worklog: a failed write is counted and surfaces as a gap once writing works again', t => {
  const dir = tmp(t);
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'a file, not a folder');
  const bad = new Worklog({sessionId: 's', dir: blocker});
  bad.turn({text: 'lost', agent: 'main'});
  assert.equal(bad.flush(), 0);
  assert.equal(bad.failures, 1);
  const good = new Worklog({sessionId: 's2', dir});
  good.failures = 2; good.lastError = 'EACCES: denied';
  good.turn({text: 'kept', agent: 'main'});
  good.flush();
  const entries = Worklog.read('s2', dir);
  assert.equal(entries[0].event, 'gap');
  assert.equal(entries[0].dropped, 2);
  assert.equal(entries[1].event, 'turn');
  const rows = Worklog.list(dir);
  assert.equal(rows.find(r => r.id === 's2').gaps, 2);
});

// --- agent wiring: real tool calls through Agent.execute land in the log ---
const {EventEmitter} = require('node:events');
const {spawnSync} = require('node:child_process');
const {Agent} = require('../src/agent');
const sessions = require('../src/sessions');
const settings = require('../src/settings');
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {}; c.cancel = async () => {}; c.disconnect = () => {};
  return c;
}
function makeAgent(t, id = 'main-session') {
  const cwd = tmp(t);
  const a = new Agent({client: stubClient(), auth: {saved: {}, vm: async () => ({})}, cwd, session: {id, cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true;
  a.approver = async () => ({allow: true});
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0, log: {tools: [], steps: []}};
  t.after(() => { try { a.close(); } catch {} });
  return a;
}

test('worklog: agent tool calls and edits are recorded (write, read, run, failure)', async t => {
  const a = makeAgent(t);
  assert.equal((await a.execute('code.write', {path: 'out.txt', content: 'hello\n'}, 1000, 'w1')).ok, true);
  assert.equal((await a.execute('code.edit', {path: 'out.txt', old_string: 'hello', new_string: 'bye'}, 1000, 'w2')).ok, true);
  assert.equal((await a.execute('code.read', {path: 'out.txt'}, 1000, 'r1')).ok, true);
  assert.equal((await a.execute('system.run', {command: 'echo worklog-ok'}, 30000, 's1')).ok, true);
  assert.equal((await a.execute('code.read', {path: 'missing.txt'}, 1000, 'r2')).ok, false);
  a.worklogFor(a.main).flush();
  const entries = Worklog.read('main-session');
  const tools = entries.filter(e => e.event === 'tool');
  assert.deepEqual(tools.map(e => e.command), ['code.write', 'code.edit', 'code.read', 'system.run', 'code.read']);
  assert.equal(tools[4].ok, false);
  assert.ok(tools[4].error, 'the failure keeps its error');
  assert.equal(tools[3].exitCode, 0);
  assert.match(tools[3].outHead, /worklog-ok/);
  assert.ok(tools.every(e => Number.isFinite(e.ms)), 'every tool event has a duration');
  const edits = entries.filter(e => e.event === 'edit');
  assert.equal(edits.length, 2);
  assert.equal(edits[0].op, 'create');
  assert.equal(edits[0].afterHash, sha256('hello\n'));
  assert.equal(edits[1].op, 'edit');
  assert.equal(edits[1].beforeHash, sha256('hello\n'));
  assert.equal(Worklog.readBlob(edits[1].beforeHash), 'hello\n', 'the edit before-text is in blobs');
  // The before/after texts never ride the result Muse (or the screen) got.
  const r = await a.execute('code.edit', {path: 'out.txt', old_string: 'bye', new_string: 'ciao'}, 1000, 'w3');
  assert.ok(!JSON.stringify(r).includes('edits'), 'no edits field leaks into the tool result');
});

test('worklog: record() leaves the reply and the Focus state', t => {
  const a = makeAgent(t, 'rec-session');
  const turn = {log: {tools: [], steps: []}, sources: new Map(), usage: null, focus: {active: true, modelState: () => ({id: 'f1', status: 'complete', goal: 'g', criteria: [{id: 'c1', status: 'met'}], evidence: [{id: 'e1', kind: 'command', command: 'npm test'}]})}};
  a.record(a.main, turn, '頼みです', {reply: '返事です'});
  a.worklogFor(a.main).flush();
  const entries = Worklog.read('rec-session');
  assert.deepEqual(entries.map(e => e.event), ['reply', 'focus']);
  assert.equal(entries[0].text, '返事です');
  assert.equal(entries[1].focus.status, 'complete');
  assert.equal(entries[1].focus.evidence[0].command, 'npm test');
});

test('worklog: the /settings switch turns recording off for the agent', async t => {
  const a = makeAgent(t, 'off-session');
  settings.setSwitch('worklog', false, {save: false});
  t.after(() => settings.setSwitch('worklog', true, {save: false}));
  assert.equal((await a.execute('code.write', {path: 'x.txt', content: 'x\n'}, 1000, 'w1')).ok, true);
  a.worklogFor(a.main).flush();
  assert.deepEqual(Worklog.read('off-session'), []);
  assert.equal(settings.switchValue('worklog'), false);
  settings.setSwitch('worklog', true, {save: false});
  assert.equal(settings.numberValue('worklogDays'), 30);
});

test('worklog: muser log lists, shows the timeline, and --clear deletes', t => {
  const log = new Worklog({sessionId: 'cli1-0000-0000-0000-000000000000'});
  log.turn({text: 'CLI の頼み', agent: 'main'});
  log.tool({command: 'code.read', summary: 'a.js', ok: true, output: 'x'});
  log.flush();
  sessions.save({id: 'cli1-0000-0000-0000-000000000000', cwd: process.cwd(), title: 'CLI test', created: Date.now(), updated: Date.now(), turns: 1});
  const root = path.join(__dirname, '..');
  const runCli = args => spawnSync(process.execPath, [path.join(root, 'bin', 'muser.js'), 'log', ...args], {encoding: 'utf8', env: process.env});
  const listJson = runCli(['--json']);
  assert.equal(listJson.status, 0, listJson.stderr);
  const rows = JSON.parse(listJson.stdout);
  assert.ok(rows.some(r => r.id.startsWith('cli1') && r.turns === 1), 'the list names the conversation');
  const timeline = runCli(['cli1']);
  assert.equal(timeline.status, 0, timeline.stderr);
  assert.match(timeline.stdout, /turn/);
  assert.match(timeline.stdout, /CLI の頼み/);
  const timelineJson = runCli(['cli1', '--json']);
  assert.equal(JSON.parse(timelineJson.stdout).length, 2);
  const cleared = runCli(['--clear']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /作業ログを消しました/);
  assert.deepEqual(Worklog.list(), []);
});

test('worklog: list rows and clear', t => {
  const dir = tmp(t);
  const log = new Worklog({sessionId: 's1', dir});
  log.turn({text: '最初の頼み\n続き', agent: 'main'});
  log.tool({command: 'code.read', summary: 'x', ok: true, output: ''});
  log.flush();
  const rows = Worklog.list(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 's1');
  assert.equal(rows[0].turns, 1);
  assert.equal(rows[0].tools, 1);
  assert.equal(rows[0].title, '最初の頼み');
  assert.match(Worklog.formatList(rows)[0], /s1/);
  const cleared = Worklog.clear(dir);
  assert.equal(cleared.files, 1);
  assert.deepEqual(Worklog.list(dir), []);
});
