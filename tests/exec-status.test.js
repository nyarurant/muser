'use strict';
// The state file of a `muser exec` run (src/exec-status.js): what another agent polls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ExecStatus, dir, prune, KEEP} = require('../src/exec-status');

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const madeDirs = [];
require('node:test').after(() => { for (const d of madeDirs) fs.rmSync(d, {recursive: true, force: true}); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exec-status-')); madeDirs.push(d); return d; };

test('sessionIds: the conversations of the exec runs on record, read from the status folder', () => {
  const ES = require('../src/exec-status');
  const d = ES.dir();
  fs.mkdirSync(d, {recursive: true});
  const a = path.join(d, '20990101-000000-1.json'), b = path.join(d, '20990101-000001-2.json'), c = path.join(d, '20990101-000002-3.json');
  fs.writeFileSync(a, JSON.stringify({version: 1, state: 'done', session: 'sess-a'}));
  fs.writeFileSync(b, JSON.stringify({version: 1, state: 'running', session: {id: 'sess-b'}}));
  fs.writeFileSync(c, '{not json');
  try {
    const ids = ES.sessionIds({ttlMs: 0});
    assert.ok(ids.has('sess-a') && ids.has('sess-b'));
  } finally { for (const f of [a, b, c]) fs.rmSync(f, {force: true}); }
});

test('running from the start, then done with the exit code, the reply and the session', () => {
  const f = path.join(tmp(), 'st.json');
  const s = new ExecStatus({file: f, prompt: 'do it', cwd: 'C:\w', mode: 'plan'}).start();
  let v = read(f);
  assert.equal(v.state, 'running');
  assert.equal(v.pid, process.pid);
  assert.equal(v.prompt, 'do it');
  s.update({session: 'sess-1', account: 'default'});
  s.tool({command: 'code.read', summary: 'package.json'});
  v = read(f);
  assert.deepEqual([v.session, v.tools, v.last], ['sess-1', 1, 'code.read package.json']);
  s.finish({exit: 2, ok: true, completed: false, reply: 'half done', focus: {status: 'needs_input'}});
  v = read(f);
  assert.equal(v.state, 'done');
  assert.equal(v.exit, 2);
  assert.equal(v.reply, 'half done');
  assert.ok(v.finishedAt && v.durationMs >= 0);
  s.update({session: 'late'}); // nothing after the end
  assert.equal(read(f).session, 'sess-1');
});

test('a run that ends without its result still says so (process exit)', () => {
  const {spawnSync} = require('node:child_process');
  const f = path.join(tmp(), 'st.json');
  const script = "const {ExecStatus}=require(process.argv[1]);new ExecStatus({file:process.argv[2],prompt:'x'}).start();process.exitCode=3;";
  spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'exec-status.js'), f], {timeout: 30000});
  const v = read(f);
  assert.equal(v.state, 'failed');
  assert.equal(v.exit, 3);
});

test('the state file is written while a reader has it open', {timeout: 30000}, async () => {
  const {spawn} = require('node:child_process');
  const f = path.join(tmp(), 'st.json');
  const s = new ExecStatus({file: f, prompt: 'x'}).start();
  const holder = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');console.log('open');setTimeout(()=>fs.closeSync(fd),300);", f]);
  // Both waits get a deadline (t3 #10): a holder that never starts or never
  // exits must fail this test, not hang the whole file.
  const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out: ' + what)), ms))]);
  try {
    await within(new Promise(r => holder.stdout.once('data', r)), 10000, 'the holder to open the file');
    s.finish({exit: 0, ok: true});
    await within(new Promise(r => holder.on('exit', r)), 10000, 'the holder to exit');
  } finally { try { holder.kill(); } catch {} }
  assert.equal(read(f).state, 'done');
});

test('only the newest default status files are kept', () => {
  fs.mkdirSync(dir(), {recursive: true});
  // dir() is the shared default status folder: clean up every file this test
  // creates (t3 #9) — the survivors used to leak into later tests' prune
  // windows and couple them to this test's leftovers.
  const names = [];
  for (let i = 0; i < KEEP + 5; i++) { const n = '20260101-0000' + String(i).padStart(2, '0') + '-1.json'; names.push(n); fs.writeFileSync(path.join(dir(), n), '{}'); }
  names.push('mine.json');
  fs.writeFileSync(path.join(dir(), 'mine.json'), '{}'); // not a default name: left alone
  try {
    prune();
    const left = fs.readdirSync(dir());
    assert.equal(left.filter(n => /^\d{8}-\d{6}-\d+\.json$/.test(n)).length, KEEP);
    assert.ok(left.includes('mine.json'));
    assert.ok(!left.includes('20260101-000000-1.json'), 'the oldest went first');
  } finally { for (const n of names) fs.rmSync(path.join(dir(), n), {force: true}); }
});

test('what the terminal shows is kept as shown, with todos, progress, Muse steps and the tool log as data', () => {
  const f = path.join(tmp(), 'st.json');
  const s = new ExecStatus({file: f, prompt: 'x'}).start();
  s.log('· Muse に接続しています…');
  s.todos([{content: 'read the code', status: 'in_progress'}, {text: 'report', status: 'pending'}]);
  s.progress({agent: 'main', message: 'reading src/agent.js'});
  s.step({items: [{title: 'Searching Ink version'}, {title: 'Reading code', detail: 'agent.js'}]});
  s.tool({agent: 'a1', command: 'code.grep', summary: 'TODO', ok: false, error: 'no match'});
  s.finish({exit: 0, ok: true});
  s.log('続きは: muser exec --session abc "…"');
  const v = read(f);
  assert.equal(v.state, 'done');
  assert.deepEqual(v.log, ['· Muse に接続しています…', '続きは: muser exec --session abc "…"']);
  assert.deepEqual(v.todos, [{content: 'read the code', status: 'in_progress'}, {content: 'report', status: 'pending'}]);
  assert.equal(v.progress[0].message, 'reading src/agent.js');
  assert.deepEqual(v.steps.map(x => x.title), ['Searching Ink version', 'Reading code']);
  assert.deepEqual([v.toolLog[0].agent, v.toolLog[0].ok, v.toolLog[0].error], ['a1', false, 'no match']);
});

test('the lists keep only their newest entries', () => {
  const {CAPS} = require('../src/exec-status');
  const f = path.join(tmp(), 'st.json');
  const s = new ExecStatus({file: f, prompt: 'x'}).start();
  for (let i = 0; i < CAPS.log + 10; i++) s.log('line ' + i);
  const v = read(f);
  assert.equal(v.log.length, CAPS.log);
  assert.equal(v.log.at(-1), 'line ' + (CAPS.log + 9));
  s.finish({exit: 0, ok: true});
});

test('--status: a few lines on a running, a dead and a finished run, with the exit code to match', () => {
  const {summary, code} = require('../src/exec-status');
  const now = Date.parse('2026-11-03T10:02:13Z');
  const base = {version: 1, pid: 42, startedAt: '2026-11-03T10:00:00Z', updatedAt: '2026-11-03T10:02:10Z', session: 'sess-1', account: 'sub', tools: 14,
    last: 'code.read src/agent.js', todos: [{content: 'read', status: 'completed'}, {content: 'report', status: 'in_progress'}],
    progress: [{agent: 'main', message: 'old'}, {agent: 'main', message: 'reading the agent'}], log: ['a', 'b', 'c', 'd'], toolLog: new Array(100).fill({command: 'x'})};
  const running = summary({...base, state: 'running'}, {now, isAlive: () => true});
  assert.match(running, /^running · for 2m13s · account sub · session sess-1 · tools 14/);
  assert.match(running, /last: code.read src\/agent.js/);
  assert.match(running, /todos: ✓ read \| ▶ report/);
  assert.match(running, /progress: reading the agent/);
  assert.match(running, /log:\n  b\n  c\n  d$/, 'the last three lines only');
  assert.equal(code({...base, state: 'running'}, {now, isAlive: () => true}), 4); // now: verdict() is heartbeat-aware (#149), so the simulated clock applies here too
  const dead = summary({...base, state: 'running'}, {now, isAlive: () => false});
  assert.match(dead, /^dead · /);
  assert.match(dead, /pid 42\) is gone without a result; last update 3s ago/);
  assert.equal(code({...base, state: 'running'}, {isAlive: () => false}), 5);
  const done = {...base, state: 'done', exit: 2, durationMs: 133000, reply: 'line 1\nline 2', focus: {status: 'needs_input', reason: 'could not run git'}};
  const s = summary(done, {now});
  assert.match(s, /^done · took 133s · exit 2 \(Focus criteria not met\) · account sub/);
  assert.match(s, /focus: needs_input — could not run git/);
  assert.match(s, /reply:\nline 1\nline 2$/);
  assert.doesNotMatch(s, /log:|last:/, 'a finished run shows its result, not its progress');
  assert.equal(code(done), 2);
  assert.ok(s.length < JSON.stringify(done).length / 3, 'far smaller than the file');
});

test('muser exec --status: the newest run by default, gone (5) when there is none', () => {
  const {spawnSync} = require('node:child_process');
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exec-st-cli-')); madeDirs.push(appdata);
  const env = {...process.env, LOCALAPPDATA: appdata, MUSER_LANG: 'en'};
  const bin = path.join(__dirname, '..', 'bin', 'muser.js');
  let r = spawnSync(process.execPath, [bin, 'exec', '--status'], {env, encoding: 'utf8', timeout: 30000});
  assert.equal(r.status, 5);
  assert.match(r.stdout, /^gone · no status file/);
  const d = path.join(appdata, 'muser', 'exec');
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(d, '20261103-100000-1.json'), JSON.stringify({state: 'done', exit: 0, durationMs: 1000, reply: 'older'}));
  fs.writeFileSync(path.join(d, '20261103-110000-1.json'), JSON.stringify({state: 'done', exit: 2, durationMs: 1000, reply: 'newest'}));
  r = spawnSync(process.execPath, [bin, 'exec', '--status'], {env, encoding: 'utf8', timeout: 30000});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /reply:\nnewest/);
  r = spawnSync(process.execPath, [bin, 'exec', '--status', path.join(d, '20261103-100000-1.json')], {env, encoding: 'utf8', timeout: 30000});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /older/);
});

// ---- Audit 2026-11-03, section J (#149-#155) regression tests ----
const es = require('../src/exec-status');

test('#149: verdict() follows the heartbeat: a reused pid with a stopped heartbeat is dead', () => {
  const now = Date.parse('2026-11-03T10:10:00Z');
  const fresh = {state: 'running', pid: 42, startedAt: '2026-11-03T10:00:00Z', updatedAt: '2026-11-03T10:09:50Z'};
  assert.equal(es.verdict(fresh, {now, isAlive: () => true}), 'running');
  const stale = {...fresh, updatedAt: '2026-11-03T10:00:30Z'};
  assert.equal(es.verdict(stale, {now, isAlive: () => true}), 'dead', 'pid alive but heartbeat long stopped');
  assert.equal(es.code(stale, {now, isAlive: () => true}), 5);
  assert.match(es.summary(stale, {now, isAlive: () => true}), /^dead · /);
  assert.equal(es.verdict(fresh, {now, isAlive: () => false}), 'dead', 'a gone pid is dead even with a fresh heartbeat');
});

test('#150: prune() keeps the status file of a run that is still live', () => {
  fs.mkdirSync(dir(), {recursive: true});
  const names = [];
  const runningName = '20250101-000000-' + process.pid + '.json';
  fs.writeFileSync(path.join(dir(), runningName), JSON.stringify({state: 'running', pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()}));
  names.push(runningName);
  for (let i = 0; i < KEEP + 2; i++) { const n = '20250102-0000' + String(i).padStart(2, '0') + '-1.json'; fs.writeFileSync(path.join(dir(), n), JSON.stringify({state: 'done', exit: 0})); names.push(n); }
  try {
    prune();
    assert.ok(fs.existsSync(path.join(dir(), runningName)), 'the live run survived pruning');
  } finally { for (const n of names) { try { fs.unlinkSync(path.join(dir(), n)); } catch {} } }
});

test('#151: a failed status write is observable (writeError / false), a good one is not', () => {
  const base = tmp();
  const blocker = path.join(base, 'block');
  fs.writeFileSync(blocker, 'x');
  const bad = new ExecStatus({file: path.join(blocker, 'st.json'), prompt: 'x'});
  assert.equal(bad.write(), false);
  assert.ok(typeof bad.writeError === 'string' && bad.writeError.length > 0, 'the reason is kept: ' + bad.writeError);
  const good = new ExecStatus({file: path.join(base, 'ok.json'), prompt: 'x'});
  assert.equal(good.write(), true);
  assert.equal(good.writeError, null);
});

test('#152: latest() compares the pid in the file name numerically', () => {
  fs.mkdirSync(dir(), {recursive: true});
  const a = '20990101-000000-9999.json', b = '20990101-000000-10000.json', c = '20990101-000001-1.json';
  for (const n of [a, b, c]) fs.writeFileSync(path.join(dir(), n), '{}');
  try {
    assert.equal(path.basename(es.latest()), c, 'the later second wins over any pid');
    fs.unlinkSync(path.join(dir(), c));
    assert.equal(path.basename(es.latest()), b, 'same second: pid 10000 is newer than 9999');
  } finally { for (const n of [a, b, c]) { try { fs.unlinkSync(path.join(dir(), n)); } catch {} } }
});

test('recovery: a status file claiming a bogus state with exit 0 is gone (5), not success', () => {
  assert.equal(es.verdict({state: 'bogus', exit: 0}), 'dead');
  assert.equal(es.code({state: 'bogus', exit: 0}), 5);
  assert.equal(es.verdict({state: 'done', exit: 0}), 'done');
  assert.equal(es.code({state: 'done', exit: 0}), 0);
  assert.equal(es.verdict({state: 'interrupted', exit: 130}), 'interrupted');
});

test('#153: a parseable but invalid status file is gone (5), never an exception', () => {
  assert.equal(es.verdict(null), 'dead');
  assert.equal(es.code(null), 5);
  assert.equal(es.code({}), 5);
  assert.equal(es.code('running'), 5);
  assert.match(es.summary(null), /^gone · /);
  const weird = {state: 'running', pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), todos: 'nope', log: 42, progress: 'x', tools: 1};
  assert.doesNotThrow(() => es.summary(weird, {isAlive: () => true}));
  assert.match(es.summary(weird, {isAlive: () => true}), /^running · /);
});

test('#155: an interrupt before the caller installs its own handler still finalizes the file', () => {
  const f = path.join(tmp(), 'st.json');
  const before = process.listenerCount('SIGINT');
  const s = new ExecStatus({file: f, prompt: 'x'}).start();
  assert.equal(process.listenerCount('SIGINT'), before + 1, 'the handler is registered from the start');
  const dummy = () => {};
  process.on('SIGINT', dummy); // stands in for bin's later handler: it owns exiting, so onSigint must not
  try { s.onSigint(); } finally { process.removeListener('SIGINT', dummy); }
  const v = read(f);
  assert.equal(v.state, 'interrupted');
  assert.equal(v.exit, 130);
  assert.equal(process.listenerCount('SIGINT'), before, 'finish removed the handler again');
});

// ---- Audit #151 (bin half) / #154: bin/muser.js exec startup -------------------------
// These run the real bin as a subprocess; both paths end before any network use.
const {spawn} = require('node:child_process');
const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
const binEnv = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: ''};
const pollFor = async (cond, what, timeoutMs = 20000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) assert.fail('timed out after ' + timeoutMs + ' ms waiting for ' + what);
    await new Promise(r => setTimeout(r, 100));
  }
};

test('#151 (bin): an unwritable status file is announced with its reason, not a bare file name', async () => {
  const base = tmp();
  const blocker = path.join(base, 'block');
  fs.writeFileSync(blocker, 'x');
  const badFile = path.join(blocker, 'st.json');
  const p = spawn(process.execPath, [BIN, 'exec', '--status-file', badFile, 'hi'], {env: binEnv});
  const exited = new Promise(r => p.on('exit', r));
  let errText = '';
  p.stderr.on('data', d => { errText += d; });
  p.stdout.on('data', () => {});
  try {
    await pollFor(() => errText.includes('書けませんでした'), 'the write-failure warning on stderr');
    assert.ok(errText.includes(badFile), 'the warning names the file: ' + errText.slice(0, 300));
    assert.match(errText, /E[A-Z]{2,}|errno/, 'the OS reason is included: ' + errText.slice(0, 300));
    assert.ok(!errText.includes('状態ファイル: '), 'the success line is not printed for a file that was never written');
  } finally { try { p.kill(); } catch {} }
  // Await the exit itself: racing it against a sleep used to let this test pass
  // even when the killed child never actually exited.
  await exited;
});

test('#154: the status file exists while stdin is still open, and a stdin that never ends times out', {timeout: 120000}, async () => {
  const f = path.join(tmp(), 'st.json');
  const p = spawn(process.execPath, [BIN, 'exec', '--status-file', f], {env: binEnv});
  const exited = new Promise(r => p.on('exit', r));
  let errText = '';
  p.stderr.on('data', d => { errText += d; });
  p.stdout.on('data', () => {});
  // p.stdin is deliberately never written to or ended: the launcher holds the pipe open.
  try {
    await pollFor(() => fs.existsSync(f), 'the status file to be created before stdin closes');
    assert.equal(read(f).state, 'running', 'the run is observable while it waits for stdin');
    const code = await Promise.race([
      exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error('the run did not end within 60 s; stderr: ' + errText.slice(-300))), 60000)),
    ]);
    assert.equal(code, 1, 'the stdin timeout fails the run');
    assert.match(errText, /stdin/, 'the reason is said on stderr');
    const v = read(f);
    assert.equal(v.state, 'done');
    assert.equal(v.exit, 1);
    assert.match(v.error, /stdin/, 'the reason is in the status file too');
  } finally { try { p.stdin.end(); } catch {} try { p.kill(); } catch {} }
});

test('summary: a finished run with turn usage shows its formatted tokens; without usage nothing extra', () => {
  const {summary} = require('../src/exec-status');
  const now = Date.now();
  const withUsage = {version: 1, state: 'done', exit: 0, pid: process.pid, startedAt: new Date(now - 5000).toISOString(), updatedAt: new Date(now).toISOString(), durationMs: 5000, tools: 1, usage: {inputTokens: 130841, outputTokens: 395, formatted: '130.8k in / 395 out'}};
  // Wave 7 spec update: summary() re-formats the stored usage from its
  // numbers via usageText/formatUsage, so the words are the UI language's
  // （入 / 出） — the fixture's stored English 'formatted' is not what prints.
  assert.match(summary(withUsage, {now}), /tokens: 130\.8k 入 \/ 395 出/);
  const without = {...withUsage}; delete without.usage;
  assert.ok(!summary(without, {now}).includes('tokens:'), 'no tokens line without usage');
});
