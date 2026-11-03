'use strict';
// Fifth sweep of 2026-11-01 (reliability items 1-24 for the e-agent's files), one test per fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');

const wait = ms => new Promise(r => setTimeout(r, ms));
// Poll for a condition instead of sleeping a fixed time and hoping the margin held:
// under parallel load a fixed sleep either fires the assert before a slower-but-correct
// timer/completion, or hides a hang until the whole file times out (audit #251).
const waitFor = async (cond, what, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) assert.fail('timed out after ' + timeoutMs + ' ms waiting for ' + what);
    await wait(25);
  }
};
function tmp(t, p = 'muser-e-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

// 1. muse-client disconnect(): a stalled close handshake is terminated after ~2 s.
test('1: disconnect terminates a socket whose close handshake stalls', async () => {
  const {MuseClient} = require('../src/core/muse-client');
  const c = new MuseClient({credentials: {}, fetchJson: null});
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  let terminated = false;
  ws.close = () => {}; // never answers, never emits close
  ws.terminate = () => { terminated = true; ws.readyState = 3; };
  c.ws = ws;
  c.disconnect(false);
  assert.equal(terminated, false, 'close is tried first');
  // The grace period is ~2 s; a fixed 2300 ms sleep asserted on a 300 ms margin and
  // flaked under parallel load (audit #251). Poll for the outcome instead.
  await waitFor(() => terminated, 'the stalled socket to be terminated after the grace period');
  assert.equal(terminated, true, 'terminated after the grace period');
});

// 2. muse-client open(): a slow credential refresh no longer blocks connecting with cached
// login credentials, but the requireLogin gate still waits for the refresh when the cached
// credentials are not login-derived.
test('2: open races a slow refresh against connecting with cached login credentials', async () => {
  const {MuseClient} = require('../src/core/muse-client');
  const hang = () => new Promise((_, reject) => { const t = setTimeout(() => reject(Object.assign(new Error('down'), {network: true})), 8000); t.unref(); });
  const c = new MuseClient({credentials: {gateway: 'https://bad.example.com', vmId: 'v', appId: 'a', token: 'tok', source: 'login'}, fetchJson: hang, requireLogin: true});
  const t0 = Date.now();
  await assert.rejects(c.open(), /接続先を確認できません/, 'it got past the refresh and tried the cached gateway');
  assert.ok(Date.now() - t0 < 7000, 'did not wait out the 8 s refresh: ' + (Date.now() - t0) + ' ms');
  assert.ok(Date.now() - t0 >= 2500, 'it did give the refresh its ~3 s chance');
});

test('2b: open with requireLogin still waits for the refresh when cached credentials are not from a login', async () => {
  const {MuseClient} = require('../src/core/muse-client');
  const slow = async () => { await wait(3600); throw Object.assign(new Error('no'), {status: 401}); };
  const c = new MuseClient({credentials: {gateway: 'https://hatch.metaaivm.com', vmId: 'v', appId: 'a', token: 'tok', source: 'har'}, fetchJson: slow, requireLogin: true});
  const t0 = Date.now();
  await assert.rejects(c.open(), /ログインしてください/);
  assert.ok(Date.now() - t0 >= 3400, 'the gate waited for the refresh verdict: ' + (Date.now() - t0) + ' ms');
});

// 3. muse-client bad frames: consecutive count, reset by a good record, reconnect at 10.
test('3: bad frames count consecutively, a good record resets, 10 in a row disconnects', () => {
  const {MuseClient} = require('../src/core/muse-client');
  const c = new MuseClient({credentials: {}, fetchJson: null});
  c.status = 'connected';
  const err = console.error; console.error = () => {};
  try {
    const p = () => ({settled: false, timer: null, resolve() {}, reject() {}});
    for (let i = 0; i < 9; i++) c.recordLine(p(), 'not json');
    assert.equal(c.badFrames, 9);
    assert.equal(c.status, 'connected', 'nine in a row is still just skipped');
    c.recordLine(p(), '{}');
    assert.equal(c.badFrames, 0, 'a good record resets the streak');
    for (let i = 0; i < 10; i++) c.recordLine(p(), 'not json');
    assert.equal(c.badFrames, 10);
    assert.equal(c.status, 'disconnected', 'the tenth in a row drops the connection for a reconnect');
  } finally { console.error = err; }
});

// 4. native-device watchdog: a late real completion replaces the cached invoke_timeout.
test('4: a late invoke completion replaces the cached watchdog timeout', async () => {
  const {NativeDevice} = require('../src/core/native-device');
  const d = new NativeDevice({execute: async () => { await wait(150); return {ok: true, payload: {done: 1}}; }});
  d._watchdogGraceMs = 20;
  d._sendResult = async () => {};
  d._dispatchInvoke({id: 'inv-late', command: 'code.read', params: {}, timeout_ms: 10});
  // Fixed sleeps (70 ms for a 30 ms watchdog, +200 ms for a ~150 ms command) asserted on
  // tens-of-ms margins and flaked under load (audit #251). Poll for each state instead.
  await waitFor(() => d._completedInvokes.get('inv-late')?.error === 'invoke_timeout', 'the watchdog to answer invoke_timeout');
  assert.deepEqual(d._completedInvokes.get('inv-late'), {ok: false, error: 'invoke_timeout'});
  await waitFor(() => d._completedInvokes.get('inv-late')?.ok === true, 'the real completion to replace the cached timeout');
  assert.deepEqual(d._completedInvokes.get('inv-late'), {ok: true, payload: {done: 1}}, 'a later duplicate gets the real result');
});

// 5. pc-auth vm(): the 60 s cache is keyed by the expected VM.
test('5: the vm cache does not carry over when the expected VM changes', async () => {
  const {PcAuth} = require('../src/core/pc-auth');
  let expected = 'vm1', fetches = 0;
  const disk = {nodeId: 'n', sdkToken: 's', device: {access_token: 'tok', refresh_token: 'r:1'}};
  const a = new PcAuth({load: () => disk, save: () => {}, expectedVm: async () => expected,
    request: async (scope, route) => { if (route === '/fetch_vms') { fetches++; return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'x1'}, {vm_id: 'vm2', vm_auth_token: 'x2'}]}; } throw new Error('unexpected ' + route); }});
  assert.equal((await a.vm()).vm_id, 'vm1');
  assert.equal((await a.vm()).vm_id, 'vm1');
  assert.equal(fetches, 1, 'same expected VM: cached');
  expected = 'vm2';
  assert.equal((await a.vm()).vm_id, 'vm2', 'a different expected VM is looked up, not served from cache');
  assert.equal(fetches, 2);
});

// 6. pc-auth: a failed refresh re-loads the saved pair and retries fetch_vms once.
test('6: when the refresh fails, the pair another window saved is retried before giving up', async () => {
  const {PcAuth} = require('../src/core/pc-auth');
  let disk = {nodeId: 'n', sdkToken: 's', device: {access_token: 'old', refresh_token: 'r:1'}};
  const calls = [];
  const a = new PcAuth({load: () => disk, save: v => { disk = v; }, expectedVm: async () => 'vm1',
    request: async (scope, route, body, bearer) => {
      calls.push(route + ' ' + bearer);
      if (route === '/fetch_vms') { if (bearer === 'fresh') return {vm_list: [{vm_id: 'vm1', vm_auth_token: 'x'}]}; throw Object.assign(new Error('401'), {status: 401}); }
      if (route === '/device_token/refresh') { disk = {...disk, device: {access_token: 'fresh', refresh_token: 'r:9'}}; throw Object.assign(new Error('refresh used up'), {status: 401}); }
      throw new Error('unexpected ' + route);
    }});
  const vm = await a.lookupVm();
  assert.equal(vm.vm_id, 'vm1');
  assert.deepEqual(calls, ['/fetch_vms old', '/device_token/refresh hatch_refresh:1', '/fetch_vms fresh']);
});

// 7. session.js: a failing credentials save does not crash the client event handler.
test('7: a credentials save failure is swallowed by the session listener', t => {
  const store = require('../src/secure-store');
  const saved = store.save;
  t.after(() => { store.save = saved; });
  const {createChat} = require('../src/session');
  const client = createChat({fetchJson: async () => {}});
  store.save = () => { throw new Error('DPAPI unavailable'); };
  assert.doesNotThrow(() => client.emit('credentials', {token: 'x'}));
});

// 8. sessions all(): only ENOENT means an empty index; other read errors surface.
test('8: a sessions index that cannot be read for another reason is an error, not an empty list', t => {
  const sessions = require('../src/sessions');
  const file = sessions.FILE, backup = file + '.bak-e';
  let had = false;
  try { fs.renameSync(file, backup); had = true; } catch {}
  t.after(() => { try { fs.rmSync(file, {recursive: true, force: true}); } catch {} if (had) try { fs.renameSync(backup, file); } catch {} });
  fs.mkdirSync(file, {recursive: true}); // reading a directory fails with a non-ENOENT code
  assert.throws(() => sessions.recent(), e => e.code !== 'ENOENT');
});

// 9. sessions locked(): only the lock owner unlinks the lock file.
test("9: locked() does not unlink a lock that was taken over by another window", () => {
  const sessions = require('../src/sessions');
  const lock = sessions.FILE + '.lock';
  try { fs.unlinkSync(lock); } catch {}
  const r = sessions.locked(() => { fs.writeFileSync(lock, 'other-window-token'); return 42; });
  assert.equal(r, 42);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other-window-token', "the next window's lock survived our exit");
  fs.unlinkSync(lock);
  sessions.locked(() => {});
  assert.equal(fs.existsSync(lock), false, 'our own lock is removed as before');
});

// 10. sessions transcripts: retained turns/bytes are capped with an atomic rewrite.
test('10: a transcript is trimmed to the cap once it grows past the byte budget', t => {
  const sessions = require('../src/sessions');
  const id = 'cap-' + crypto.randomUUID();
  t.after(() => { try { fs.unlinkSync(sessions.transcriptFile(id)); } catch {} });
  const big = 'x'.repeat(5000);
  for (let i = 0; i < 430; i++) sessions.appendTurn(id, {v: 1, at: i, user: 'u' + i, reply: big, tools: [], steps: [], todos: []});
  const kept = sessions.transcript(id);
  assert.ok(kept.length < 430, 'older turns were dropped: ' + kept.length);
  assert.ok(kept.length <= sessions.MAX_TRANSCRIPT_TURNS);
  assert.equal(kept.at(-1).user, 'u429', 'the newest turn is kept');
  assert.ok(fs.statSync(sessions.transcriptFile(id)).size <= sessions.MAX_TRANSCRIPT_BYTES + 8192, 'the file is back within the byte cap');
});

// 11. transcript forResume(): a failed history fetch falls back to the local turns.
test('11: resume falls back to the local transcript when fetching history fails', async t => {
  const sessions = require('../src/sessions');
  const {forResume} = require('../src/transcript');
  const id = 'fb-' + crypto.randomUUID();
  t.after(() => { try { fs.unlinkSync(sessions.transcriptFile(id)); } catch {} });
  sessions.appendTurn(id, {v: 1, at: 1, user: 'only', reply: 'local', tools: [], steps: [], todos: []});
  const r = await forResume({id, turns: 5}, {history: async () => { throw new Error('offline'); }});
  assert.equal(r.from, 'local');
  assert.deepEqual(r.turns.map(x => x.user), ['only']);
});

// 12. transcript merge: unmatched local turns slot in by timestamp across the whole range.
test('12: an unmatched local turn between two fetched turns is kept, in time order', async t => {
  const sessions = require('../src/sessions');
  const {forResume} = require('../src/transcript');
  const id = 'merge-' + crypto.randomUUID();
  t.after(() => { try { fs.unlinkSync(sessions.transcriptFile(id)); } catch {} });
  for (const [at, user] of [[10, 'a'], [20, 'b'], [30, 'c']]) sessions.appendTurn(id, {v: 1, at, user, reply: 'local-' + user, tools: [{command: 'code.read'}], steps: [], todos: []});
  const ev = (seq, role, mid, text, at) => ({event_name: role === 'user' ? 'message.user' : 'message.assistant', role, message_id: mid, seq, display_text: text, visibility: 'public', payload: {}, occurred_at_ms: at});
  const client = {history: async () => ({chat_events: [ev(1, 'user', 'u1', 'a', 10), ev(2, 'assistant', 'a1', 'ra', 10), ev(3, 'user', 'u3', 'c', 30), ev(4, 'assistant', 'a3', 'rc', 30)], has_more: false})};
  const r = await forResume({id, turns: 9}, client);
  assert.deepEqual(r.turns.map(x => x.user), ['a', 'b', 'c'], 'b (at 20) survived between a and c instead of being dropped as not-old-enough');
  assert.equal(r.turns[1].tools.length, 1, 'and it is the richer local record');
});

// 13. update install(): on timeout the kill and the child's exit are awaited before resolving;
// a retry is blocked only while a previous install is running / unstoppable.
test('13: a timed-out install is really stopped before it resolves, and a retry then works', async () => {
  const update = require('../src/update');
  const slow = update.install({timeoutMs: 1200, command: 'ping -n 30 127.0.0.1 >nul'});
  const blocked = await update.install({timeoutMs: 1000, command: 'echo nope'});
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /already running/, 'a concurrent install is blocked while one is running');
  const r = await slow;
  assert.equal(r.ok, false);
  assert.match(r.output, /did not finish in 1 s/);
  const again = await update.install({timeoutMs: 15000, command: 'echo hello-update'});
  assert.equal(again.ok, true, 'the retry was not blocked and the old process was gone: ' + again.output);
  assert.match(again.output, /hello-update/);
});

// 14. config update(): the read-modify-write runs under a lock; a foreign lock is left alone.
test('14: config.update locks, and does not remove a lock it does not own', async t => {
  const dir = tmp(t);
  const was = process.env.USERPROFILE;
  process.env.USERPROFILE = dir;
  t.after(() => { process.env.USERPROFILE = was; });
  const config = require('../src/config');
  const f = config.file();
  assert.ok(f.startsWith(dir), 'config redirected under the temp home: ' + f);
  config.update(cfg => { cfg.lang = 'en'; });
  assert.equal(config.read().lang, 'en');
  assert.equal(fs.existsSync(f + '.lock'), false, 'its own lock was released');
  fs.writeFileSync(f + '.lock', 'other-window');
  const t0 = Date.now();
  config.update(cfg => { cfg.lang = 'ja'; });
  assert.ok(Date.now() - t0 >= 1500, 'it waited on the foreign lock before proceeding');
  assert.equal(fs.readFileSync(f + '.lock', 'utf8'), 'other-window', "the other window's lock was not unlinked");
  assert.equal(config.read().lang, 'ja', 'the update still landed');
});

// 15. usage record(): load+save run under a lock; a foreign lock is left alone.
test('15: usage.record locks, counts accumulate, and a foreign lock survives', async t => {
  const dir = tmp(t);
  const was = process.env.MUSER_USAGE_FILE;
  process.env.MUSER_USAGE_FILE = path.join(dir, 'usage.json');
  t.after(() => { process.env.MUSER_USAGE_FILE = was; });
  const usage = require('../src/usage');
  usage.record({turns: 2, toolCalls: 1});
  const day = usage.record({turns: 3});
  assert.equal(day.turns, 5);
  assert.equal(fs.existsSync(usage.file() + '.lock'), false);
  fs.writeFileSync(usage.file() + '.lock', 'other-window');
  // Audit #244: a record that cannot take the lock no longer proceeds WITHOUT it
  // (that was the race the lock exists to prevent): withLock throws, and record()'s
  // callers all drop the count on a throw. A short budget keeps this fast; the
  // default 6 s budget outlasts the 5 s stale age so a crashed window's lock is
  // taken over instead (covered in tests/usage.test.js).
  let ran = false;
  assert.throws(() => usage.withLock(() => { ran = true; }, {budgetMs: 200, staleMs: 60000}), /usage store is busy/);
  assert.equal(ran, false, 'nothing ran without the lock');
  assert.equal(fs.readFileSync(usage.file() + '.lock', 'utf8'), 'other-window');
  assert.equal(usage.load().days[usage.dayKey()].turns, 5, 'the refused attempt changed nothing');
});

// 16. usage findAction(): the chunk crawl has an aggregate deadline.
test('16: findAction gives up at its aggregate deadline instead of crawling every chunk', async () => {
  const usage = require('../src/usage');
  const names = Array.from({length: 300}, (_, i) => 'c' + i + '.js');
  let fetched = 0;
  const web = {pageText: async route => {
    if (route === '/') return names.map(n => '/_next/static/chunks/' + n).join('\n');
    fetched++; await wait(20); return 'nothing here';
  }};
  const t0 = Date.now();
  await assert.rejects(usage.findAction(web, 2000, 150), /見つかりませんでした/);
  assert.ok(Date.now() - t0 < 5000, 'gave up near the deadline: ' + (Date.now() - t0) + ' ms');
  assert.ok(fetched < 100, 'only a few chunks were fetched, not 300: ' + fetched);
});

// 17. login poll: a disconnected/closed Edge aborts promptly with a clear message.
test('17: the login poll aborts at once when Edge is gone', async () => {
  const {pollLogin} = require('../src/login');
  const dead = {isConnected: () => false, contexts: () => [], on: () => {}};
  const t0 = Date.now();
  await assert.rejects(pollLogin(dead, {timeoutMs: 60000, intervalMs: 50}), /Edge/);
  assert.ok(Date.now() - t0 < 3000, 'prompt, not the full timeout');
  let onDisconnect = null;
  const closing = {isConnected: () => true, contexts: () => [], on: (ev, fn) => { if (ev === 'disconnected') onDisconnect = fn; }};
  const t1 = Date.now();
  const p = pollLogin(closing, {timeoutMs: 60000, intervalMs: 2000});
  setTimeout(() => onDisconnect && onDisconnect(), 200);
  await assert.rejects(p, /Edge/);
  assert.ok(Date.now() - t1 < 3000, 'a disconnect during the wait is prompt too');
});

// 18. pc-login: running out of phase-loop guards without authenticating is an error.
test('18: pcLogin throws when the phase loop ends without reaching authenticated', async () => {
  const {pcLogin} = require('../src/pc-login');
  const acct = {account_selection_required: true, accounts: [{account_ref: 'r1', display_name: 'A'}], selection_state: 'ss'};
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) return {auth_state: 'as'};
      if (route.endsWith('/confirm_otp')) return acct;
      if (route.endsWith('/select_account')) return acct;
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  const ui = {note: () => {}, info: () => {}, close: () => {},
    ask: async (q, opts = {}) => opts.placeholder === '123456' ? '123456' : 'a@b.c',
    confirm: async () => true, pick: async () => 0, busy: async (_label, fn) => fn()};
  await assert.rejects(pcLogin(web, ui), /想定外の認証状態です: account/);
});

// 19. web nativeRequest(): a JSON parse failure throws an error carrying the HTTP status.
test('19: nativeRequest parse failures carry the response status', async t => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => ({ok: true, status: 502, headers: {getSetCookie: () => []}, json: async () => { throw new SyntaxError('not json'); }});
  const web = require('../src/web');
  const w = web.createWeb([]);
  await assert.rejects(w.nativeRequest('device', '/fetch_vms', undefined, 'bearer'), e => e.status === 502 && /PC 認証応答/.test(e.message));
});

// 20. web fetchJson(): parse failures are wrapped, marked, and carry the status.
test('20: fetchJson parse failures are wrapped with status and a parse mark', async t => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => ({ok: true, status: 200, headers: {getSetCookie: () => []}, json: async () => { throw new SyntaxError('Unexpected token <'); }});
  const web = require('../src/web');
  const w = web.createWeb([]);
  await assert.rejects(w.fetchJson('/api/session'), e => e.status === 200 && e.parse === true && !(e instanceof SyntaxError));
});

// 21. web absorb(): an unparsable expiry falls back to a session cookie (expires: -1).
test('21: absorb stores expires -1 for an unparsable expiry', () => {
  const {absorb} = require('../src/web');
  const jar = [];
  const res = lines => ({headers: {getSetCookie: () => lines}});
  assert.equal(absorb(jar, 'https://muse.ai/', res(['sid=abc; Expires=not-a-date; Path=/'])), true);
  assert.equal(jar.find(c => c.name === 'sid').expires, -1);
  absorb(jar, 'https://muse.ai/', res(['x=1; Max-Age=bogus; Path=/']));
  assert.equal(jar.find(c => c.name === 'x').expires, -1);
  absorb(jar, 'https://muse.ai/', res(['y=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/']));
  assert.ok(jar.find(c => c.name === 'y').expires > Date.now() / 1000, 'a real date still parses');
});

// 22. shells killTree/kill(): killed is reported from the actual taskkill outcome.
test('22: shell kill reports killed only when taskkill actually killed something', async t => {
  const {Shells, killTree} = require('../src/shells');
  assert.equal(killTree(999999), false, 'no such pid: not a kill');
  const shells = new Shells();
  t.after(() => shells.killAll());
  shells.list.set('bgx', {id: 'bgx', command: 'x', cwd: process.cwd(), title: 'x', pid: 999999, started: Date.now(), ended: 0, running: true, exit: null, out: '', dropped: 0, read: 0, reads: new Map(), child: null});
  assert.deepEqual(shells.kill('bgx'), {id: 'bgx', killed: false}, 'a running flag alone is not a kill');
  const s = shells.start('Start-Sleep -Seconds 20', {cwd: process.cwd()});
  assert.deepEqual(shells.kill(s.id), {id: s.id, killed: true});
  await wait(300);
});

// 23. shells: finished shells beyond the keep count are evicted, buffers dropped.
test('23: the oldest finished shells are evicted beyond the keep count', () => {
  const {Shells} = require('../src/shells');
  const shells = new Shells();
  const made = [];
  for (let i = 1; i <= 12; i++) { const s = {id: 'bgf' + i, command: 'x', cwd: process.cwd(), title: 'x', pid: 0, started: i, ended: i, running: false, exit: 0, out: 'buffer-' + i, dropped: 0, read: 0, reads: new Map(), child: null}; shells.list.set(s.id, s); made.push(s); }
  shells.evictFinished();
  assert.equal(shells.list.size, 8);
  assert.equal(shells.list.has('bgf1'), false, 'the oldest finished shell went');
  assert.equal(shells.list.has('bgf12'), true, 'the newest finished shell stayed');
  assert.equal(made[0].out, '', 'its buffer was dropped with it');
});

// --- audit 2026-11-03 #247-#250: bin/muser.js argument handling -----------------------
// These run the real bin as a subprocess on paths that fail before any network or TTY
// use, so the error line itself is the observable behaviour.
const {spawnSync} = require('node:child_process');
const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
const runBin = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args],
  {encoding: 'utf8', timeout: 30000, env: {...process.env, MUSER_LANG: 'en', MUSER_CLIENT: '', ...env}});

// 25. (#247/#248) --client / MUSER_CLIENT: a prompt is not a subcommand, and the env var
// does not leak into subcommands.
test('25: --client takes an initial prompt; MUSER_CLIENT does not hijack subcommands', () => {
  const prompt = runBin(['--client', 'fix', 'the', 'bug']);
  assert.equal(prompt.status, 1);
  assert.match(prompt.stderr, /Interactive mode needs a terminal/, 'the prompt reached clientInteractive: ' + prompt.stderr);
  assert.doesNotMatch(prompt.stderr, /--client is only/);
  const sub = runBin(['--client', 'exec', 'hi']);
  assert.match(sub.stderr, /--client is only/, 'an explicit --client with a real subcommand is still refused');
  const envPrompt = runBin(['fix', 'the', 'bug'], {MUSER_CLIENT: '1'});
  assert.match(envPrompt.stderr, /Interactive mode needs a terminal/);
  assert.doesNotMatch(envPrompt.stderr, /--client is only/, 'MUSER_CLIENT=1 with a prompt goes to client mode, not the error');
  const envSub = runBin(['server', 'status'], {MUSER_CLIENT: '1'});
  assert.doesNotMatch(envSub.stderr, /--client is only/, 'MUSER_CLIENT=1 no longer throws subcommands into client mode');
});

// 26. (#249) `--` ends the options, and flag-shaped words inside a prompt stay words.
test('26: -- ends option parsing and prompt words are not eaten as flags', () => {
  const term = runBin(['--', '--help']);
  assert.equal(term.status, 1);
  assert.match(term.stderr, /Interactive mode needs a terminal/, '--help after -- is a prompt, not the help flag');
  assert.doesNotMatch(term.stdout, /terminal coding agent/, 'help was not printed');
  assert.doesNotMatch(term.stderr, /Unknown option/);
  const inPrompt = runBin(['fix', '--json', 'bug']);
  assert.match(inPrompt.stderr, /Interactive mode needs a terminal/, '--json inside the prompt stayed a word');
  const beforePrompt = runBin(['--json', 'fix', 'bug']);
  assert.match(beforePrompt.stderr, /--json/, 'the same flag before the prompt is a flag (and is refused here, #250)');
  assert.doesNotMatch(beforePrompt.stderr, /Interactive mode needs a terminal/);
});

// 27. (#250) flags scoped to one command are refused by the others; --port is
// range-checked for every command, not only inside serve().
test('27: command-scoped flags are refused elsewhere and --port is always range-checked', () => {
  assert.match(runBin(['--port', '70000', 'hi']).stderr, /up to 65535/, 'an out-of-range port is caught outside serve');
  assert.match(runBin(['doctor', '--json']).stderr, /--json/, '--json outside exec is refused, not ignored');
  assert.match(runBin(['usage', '--port', '1234']).stderr, /--port/, '--port outside serve/server/link is refused, not ignored');
  assert.match(runBin(['--wifi', 'hi']).stderr, /--wifi/, '--wifi outside link is refused, not ignored');
});

// 24. shells output(): the truncated flag compares against the cursor actually used.
test('24: output is flagged truncated when the buffer dropped output before the caller cursor', async () => {
  const {Shells} = require('../src/shells');
  const shells = new Shells();
  shells.list.set('bgt', {id: 'bgt', command: 'x', cwd: process.cwd(), title: 'x', pid: 0, started: 1, ended: 2, running: false, exit: 0, out: 'hello', dropped: 100, read: 0, reads: new Map([['main', 0]]), child: null});
  const r = await shells.output('bgt', {});
  assert.equal(r.output, 'hello');
  assert.equal(r.truncated, true, 'bytes 0-99 were dropped before this caller read anything');
  assert.equal(r.next_offset, 105);
});
