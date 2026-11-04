'use strict';
// Eighth sweep of 2026-11-01: MCP connect/death/index/discover races, agent-type wildcard
// narrowing, a crash reporter that can never throw (and prunes), relay line caps + idle
// timeout, and desktop-import's DPAPI error path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawnSync} = require('node:child_process');
const {McpHub} = require('../src/mcp');
const types = require('../src/agent-types');
const crash = require('../src/crash');
const {Relay} = require('../src/relay');

const wait = ms => new Promise(r => setTimeout(r, ms));
// t7 #16 (deep audit): connect to a named pipe with retries until it is
// actually listening (5 s cap), instead of sleeping a fixed 100 ms after
// start() and hoping the listener won the race on a loaded box.
async function connectRetry(pipe, ms = 5000) {
  const net = require('node:net');
  const t0 = Date.now();
  for (;;) {
    const sock = net.connect(pipe);
    try { await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); }); return sock; }
    catch (e) { sock.destroy(); if (Date.now() - t0 > ms) throw new Error('pipe ' + pipe + ' never started listening: ' + e.message); await wait(25); }
  }
}
function tmp(t, prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }
function captureErrors(fn) { const lines = [], orig = console.error; console.error = (...a) => lines.push(a.map(String).join(' ')); try { return fn(); } finally { console.error = orig; } }

// 1. connect() reserved its generation only after awaiting disconnect(), so a disable that
// landed during that await was overtaken and the server came back connected.
test('mcp connect: a disconnect during the previous close does not get overtaken', async () => {
  const hub = new McpHub();
  let releaseClose; const gate = new Promise(r => { releaseClose = r; });
  hub.servers.set('srv', {name: 'srv', status: 'connected', tools: [], error: '', client: {close: () => gate}});
  hub.index();
  const p = hub.connect('srv', {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')]});
  await hub.disconnect('srv'); // the disable/close landing while connect closes the old entry
  releaseClose();
  await p; // must give up, not proceed to connect the fixture
  assert.equal(hub.servers.has('srv'), false, 'server stays disconnected');
  assert.equal(hub.commands.size, 0);
  await hub.close();
});

// 2. _markDead dropped client/transport without closing them (stdio child processes leaked).
test('mcp _markDead: closes the client and transport handles it drops', async () => {
  const hub = new McpHub();
  const closed = [];
  const entry = {name: 'fake', status: 'connected', error: '',
    tools: [{name: 'do', inputSchema: {}}],
    client: {close: () => { closed.push('client'); }},
    transport: {close: () => { closed.push('transport'); }}};
  hub.servers.set('fake', entry);
  hub.index();
  assert.ok(hub.commands.has('mcp.fake.do'));
  hub._markDead(entry, new Error('transport exploded'));
  assert.equal(entry.status, 'error');
  assert.equal(entry.client, undefined);
  assert.equal(entry.transport, undefined);
  assert.deepEqual(closed.sort(), ['client', 'transport'], 'both handles closed, not just dropped');
  assert.ok(!hub.commands.has('mcp.fake.do'));
  // A close that throws must not break _markDead either.
  const hub2 = new McpHub();
  const entry2 = {name: 'fake2', status: 'connected', error: '', tools: [], client: {close: () => { throw new Error('nope'); }}};
  hub2.servers.set('fake2', entry2);
  assert.doesNotThrow(() => hub2._markDead(entry2, new Error('dead')));
  assert.equal(entry2.status, 'error');
  await hub.close(); await hub2.close();
});

// 3. index() allocated slug-collision suffixes in Map insertion order, so a reconnect
// (delete + set) swapped which server owned the unsuffixed command key.
test('mcp index: command keys are deterministic and stable across a reconnect', () => {
  const mk = () => {
    const hub = new McpHub();
    hub.servers.set('a-srv', {name: 'a-srv', status: 'connected', tools: [{name: 'do it', inputSchema: {}}, {name: 'alpha', inputSchema: {}}]});
    hub.servers.set('A srv', {name: 'A srv', status: 'connected', tools: [{name: 'do_it', inputSchema: {}}]});
    return hub;
  };
  const hub = mk(); hub.index();
  const keys = [...hub.commands.keys()];
  assert.deepEqual(keys, ['mcp.a_srv.do_it', 'mcp.a_srv.alpha', 'mcp.a_srv.do_it-2']);
  assert.equal(hub.commands.get('mcp.a_srv.do_it').server, 'A srv');
  assert.equal(hub.commands.get('mcp.a_srv.do_it-2').server, 'a-srv');
  // Simulate a reconnect of a-srv: delete + set moves it to the end of the Map.
  const e = hub.servers.get('a-srv'); hub.servers.delete('a-srv'); hub.servers.set('a-srv', e); hub.index();
  assert.deepEqual([...hub.commands.keys()], keys, 'same keys, same owners after reconnect');
  assert.equal(hub.commands.get('mcp.a_srv.do_it-2').server, 'a-srv');
  // And insertion order does not matter in the first place.
  const hub2 = new McpHub();
  hub2.servers.set('A srv', {name: 'A srv', status: 'connected', tools: [{name: 'do_it', inputSchema: {}}]});
  hub2.servers.set('a-srv', {name: 'a-srv', status: 'connected', tools: [{name: 'alpha', inputSchema: {}}, {name: 'do it', inputSchema: {}}]});
  hub2.index();
  assert.deepEqual([...hub2.commands.keys()], keys);
});

// 4. discover() dedupe: the seen set held raw names but was queried with lowercase ones,
// so case variants of configured/found servers were reported as new.
test('mcp discover: dedupe is case-insensitive for configured and found names', t => {
  const home = tmp(t, 'muser-disc-home-'), local = tmp(t, 'muser-disc-local-');
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert');
    const home = os.homedir();
    fs.mkdirSync(path.join(home, '.muser'), {recursive: true});
    fs.writeFileSync(path.join(home, '.muser', 'mcp.json'), JSON.stringify({mcpServers: {Existing: {command: 'x'}}}));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({mcpServers: {EXISTING: {command: 'a'}, Fresh: {command: 'b'}, fresh: {command: 'c'}}}));
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    assert.deepEqual(mcp.discover().map(f => f.name), ['Fresh']);
    console.log('CHILD OK');
  `);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 30000, env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, MUSER_REPO: path.join(__dirname, '..')}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /CHILD OK/);
});

// 5. Project narrowing of a read-only type used allowed.includes(), ignoring wildcards:
// 'mcp.*' in the allowed list must cover concrete tools and narrower patterns it contains.
test('agent-types: project narrowing keeps tools covered by an allowed wildcard', t => {
  assert.equal(types.patternCovers('mcp.*', 'mcp.fixture.echo'), true);
  assert.equal(types.patternCovers('mcp.*', 'mcp.foo.*'), true);
  assert.equal(types.patternCovers('mcp.foo.*', 'mcp.*'), false, 'a broader pattern than allowed is not covered');
  assert.equal(types.patternCovers('code.read', 'code.write'), false);
  const dir = tmp(t, 'muser-types-');
  fs.mkdirSync(path.join(dir, '.muser', 'agents'), {recursive: true});
  fs.writeFileSync(path.join(dir, '.muser', 'agents', 'review.md'),
    '---\nname: review\nreadonly: false\ntools: code.read, mcp.fixture.echo, mcp.custom.*, code.write\n---\nReview prompt.\n');
  const loaded = captureErrors(() => types.load(dir));
  assert.equal(loaded.review.readOnly, true);
  assert.ok(loaded.review.tools.includes('mcp.fixture.echo'), 'concrete tool covered by mcp.* is kept: ' + loaded.review.tools);
  assert.ok(loaded.review.tools.includes('mcp.custom.*'), 'narrower pattern covered by mcp.* is kept');
  assert.ok(!loaded.review.tools.includes('code.write'), 'uncovered tool is still dropped');
});

// 6. crash.write() ran inside uncaughtException handlers but could itself throw on odd
// state/trail shapes or an unwritable directory.
test('crash write: never throws — toxic inputs still report, unwritable dir returns null', t => {
  const dir = tmp(t, 'muser-crash-');
  t.after(() => { delete process.env.MUSER_CRASH_DIR; });
  process.env.MUSER_CRASH_DIR = dir;
  let file;
  assert.doesNotThrow(() => { file = crash.write({version: '1.0', error: new Error('boom'), trail: 'not-an-array',
    state: {agents: [null, {state: 'working'}], entries: 'nope', stream: 'a string', running: {tail: 'x'}, shells: [null, {running: true}]}}); });
  assert.ok(file && fs.existsSync(file), 'a report is still written');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(r.trail, []);
  assert.equal(r.state.shells, 1);
  assert.doesNotThrow(() => { assert.ok(crash.write(null)); });
  assert.doesNotThrow(() => { assert.ok(crash.write()); });
  // Unwritable location (a regular file stands in the way): null, not a throw.
  const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'x');
  process.env.MUSER_CRASH_DIR = path.join(blocker, 'sub');
  let out = 'unset';
  assert.doesNotThrow(() => { out = crash.write({version: '1.0', error: new Error('boom')}); });
  assert.equal(out, null);
});

// 7. Crash reports accumulated forever; writing now prunes to the newest 20.
test('crash write: reports are pruned to the newest 20', t => {
  const dir = tmp(t, 'muser-crash-prune-');
  t.after(() => { delete process.env.MUSER_CRASH_DIR; });
  process.env.MUSER_CRASH_DIR = dir;
  const base = Date.now() - 100000;
  for (let i = 0; i < 30; i++) {
    const f = path.join(dir, 'old-' + String(i).padStart(2, '0') + '.json');
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, new Date(base + i * 1000), new Date(base + i * 1000));
  }
  const file = crash.write({version: '1.0', error: new Error('fresh crash')});
  const left = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(left.length, 20, 'pruned to 20, got ' + left.length);
  assert.ok(left.includes(path.basename(file)), 'the newest report is kept');
  assert.ok(!left.includes('old-00.json'), 'the oldest reports are gone');
});

// 8a. Relay server sockets: an unfinished line used to buffer without limit and idle
// forever. Both are bounded now (shrunk here via the constructor for the test).
test('relay server: an over-long unfinished line and an idle socket are destroyed', async t => {
  const dir = tmp(t, 'muser-relay-cap-');
  const relay = new Relay({dir, takes: () => false, run: async () => ({}), idleTimeoutMs: 150, maxLineBytes: 1024}).start();
  t.after(() => relay.stop());
  const closed = sock => new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error('socket not closed')), 3000); sock.on('close', () => { clearTimeout(to); resolve(); }); sock.on('error', () => {}); });
  const big = await connectRetry(relay.pipe);
  const bigClosed = closed(big);
  big.write(Buffer.alloc(4096, 'a')); // no newline, over the cap
  await bigClosed;
  const idleSock = await connectRetry(relay.pipe);
  await closed(idleSock); // sends nothing: the idle timeout destroys it
});

// 8b. Relay request(): the response buffer was unbounded too; an oversized reply from the
// taker is now an error for forward(), not endless growth.
test('relay request: an oversized response is rejected instead of buffered forever', async t => {
  const dir = tmp(t, 'muser-relay-resp-');
  const pipe = String.raw`\\.\pipe\muser-test-cap-` + process.pid + '-' + Date.now();
  const socks = new Set();
  const server = net.createServer(sock => {
    socks.add(sock); sock.on('close', () => socks.delete(sock)); sock.on('error', () => {});
    let buf = ''; sock.setEncoding('utf8');
    sock.on('data', d => { buf += d; if (!buf.includes('\n')) return; const msg = JSON.parse(buf); buf = '';
      if (msg.type === 'takes') sock.end('{"takes":true}\n'); else sock.write(Buffer.alloc(4096, 'x')); });
  }).listen(pipe);
  t.after(() => { for (const s of socks) s.destroy(); server.close(); });
  await new Promise(r => server.once('listening', r)); // t7 #16: was a fixed wait(100) for the listener
  fs.writeFileSync(path.join(dir, 'muser-cap.json'), JSON.stringify({pid: process.pid, pipe}));
  const relay = new Relay({dir, takes: () => false, run: async () => ({}), maxLineBytes: 1024}).start();
  t.after(() => relay.stop());
  const r = await relay.forward('code.glob', {pattern: '*'}, 1000, 'cap-1');
  assert.equal(r.takers, 1);
  assert.match(r.error, /too large/);
});

// 9. unprotect() only checked r.status: a spawn failure (r.error set, stdout null) fell
// through to r.stdout.trim() and threw a TypeError instead of the friendly error.
test('desktop-import unprotect: spawn failure / null stdout throws the friendly error', t => {
  const home = tmp(t, 'muser-di-home-');
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, `
    const cp = require('node:child_process');
    let impl = () => ({error: new Error('spawn powershell.exe ENOENT'), status: null, stdout: null});
    cp.spawnSync = (...a) => impl(...a);
    const di = require(process.env.MUSER_REPO + '/src/desktop-import.js');
    const attempt = label => { try { const v = di.unprotect(Buffer.from('AAAA')); console.log(label + ' OK ' + (Buffer.isBuffer(v) ? v.toString() : String(v))); } catch (e) { console.log(label + ' ' + e.constructor.name + ': ' + e.message); } };
    attempt('spawn-error');
    impl = () => ({status: 0, stdout: null});
    attempt('null-stdout');
    impl = () => ({status: 0, stdout: Buffer.from('keybytes').toString('base64')});
    attempt('success');
  `);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 30000, env: {...process.env, MUSER_REPO: path.join(__dirname, '..')}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /spawn-error Error: デスクトップ版の暗号鍵を開けませんでした。/);
  assert.match(r.stdout, /null-stdout Error: デスクトップ版の暗号鍵を開けませんでした。/);
  assert.doesNotMatch(r.stdout, /TypeError/);
  assert.match(r.stdout, /success OK keybytes/);
});
