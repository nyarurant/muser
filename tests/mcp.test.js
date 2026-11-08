'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// src/mcp resolves ~/.muser/mcp.json (and discover() reads ~/.claude.json and
// ~/.codex) from the home dir, and the vault lives under %LOCALAPPDATA% — the
// discover/redact tests below write and DELETE those files in-process. Point
// every folder at a throwaway one BEFORE loading any src module, mirroring
// tests/accounts.test.js: `npm test` already isolates via tests/setup.mjs, but
// a bare `node --test tests/mcp.test.js` skips that file and would otherwise
// overwrite the user's real ~/.claude.json, rm -rf their real ~/.codex, delete
// their real ~/.muser/mcp.json and empty the real mcp-secrets.enc vault.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-test-home-'));

const {McpHub, params, checkRemoteUrl} = require('../src/mcp');

test('stdio MCP server: tools become device commands, nested args travel as JSON', async t => {
  const hub = new McpHub();
  t.after(() => hub.close()); // close on the failure path too, not only at the end (t8 #5)
  await hub.connect('Fix ture', {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')]});
  hub.index();
  const defs = hub.defs();
  assert.deepEqual(Object.keys(defs).sort(), ['mcp.fix_ture.add', 'mcp.fix_ture.crash', 'mcp.fix_ture.echo', 'mcp.fix_ture.report', 'mcp.fix_ture.scale']);
  assert.equal(defs['mcp.fix_ture.add'].required.nums.type, 'string');
  assert.ok(hub.commands.get('mcp.fix_ture.echo').readOnly);
  assert.ok(!hub.commands.get('mcp.fix_ture.add').readOnly);
  assert.equal((await hub.call('mcp.fix_ture.echo', {text: 'hi'})).text, 'echo: hi');
  assert.equal((await hub.call('mcp.fix_ture.add', {nums: '[1,2,3.5]', label: 'total'})).text, 'total=6.5');
  await hub.close();
});

test('slug collisions are suffixed (-2) instead of overwriting', async t => {
  const hub = new McpHub();
  t.after(() => hub.close());
  const fixture = {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')]};
  await hub.connect('Fix ture', fixture);
  await hub.connect('fix ture', fixture);
  hub.index();
  assert.deepEqual(Object.keys(hub.defs()).sort(),
    ['mcp.fix_ture.add', 'mcp.fix_ture.add-2', 'mcp.fix_ture.crash', 'mcp.fix_ture.crash-2', 'mcp.fix_ture.echo', 'mcp.fix_ture.echo-2', 'mcp.fix_ture.report', 'mcp.fix_ture.report-2', 'mcp.fix_ture.scale', 'mcp.fix_ture.scale-2']);
  assert.equal(hub.commands.get('mcp.fix_ture.echo').server, 'Fix ture');
  assert.equal(hub.commands.get('mcp.fix_ture.echo-2').server, 'fix ture');
  assert.equal((await hub.call('mcp.fix_ture.echo-2', {text: 'second'})).text, 'echo: second');
  await hub.close();
});

test('slug collisions within index(): same-slug servers and tools', () => {
  const hub = new McpHub();
  hub.servers.set('A B', {name: 'A B', status: 'connected', tools: [{name: 'do it', inputSchema: {}}]});
  hub.servers.set('a-b', {name: 'a-b', status: 'connected', tools: [{name: 'do_it', inputSchema: {}}]});
  hub.index();
  assert.deepEqual(Object.keys(hub.defs()).sort(), ['mcp.a_b.do_it', 'mcp.a_b.do_it-2']);
});

test('corrupt config is backed up; secrets move to the secure-store as $secret refs', () => {
  // load()/save() resolve their file from the home dir at require time, so exercise
  // them in a child process with USERPROFILE / LOCALAPPDATA pointed at temp dirs.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-home-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-local-'));
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert/strict');
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    const dir = path.join(os.homedir(), '.muser'), file = path.join(dir, 'mcp.json');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(file, '{oops not json');
    assert.deepEqual(mcp.load(), {mcpServers: {}});
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('mcp.json.corrupt-'));
    assert.equal(backups.length, 1, 'corrupt file backed up');
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{oops not json');
    mcp.save({mcpServers: {demo: {command: 'node', args: [], enabled: true,
      env: {API_KEY: 'sekrit-value-123'}, headers: {Authorization: 'Bearer abcdef'}}}});
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('sekrit-value-123') && !raw.includes('Bearer abcdef'), 'no plaintext secrets in mcp.json');
    const written = JSON.parse(raw);
    assert.equal(written.mcpServers.demo.env.API_KEY.$secret, 'demo:env:API_KEY');
    assert.equal(written.mcpServers.demo.headers.Authorization.$secret, 'demo:headers:Authorization');
    const loaded = mcp.load();
    assert.equal(loaded.mcpServers.demo.env.API_KEY, 'sekrit-value-123', '$secret resolved on load');
    assert.equal(loaded.mcpServers.demo.headers.Authorization, 'Bearer abcdef');
    fs.writeFileSync(file, JSON.stringify({mcpServers: {plain: {command: 'x', env: {TOKEN: 'plain-value-9'}}}}));
    assert.equal(mcp.load().mcpServers.plain.env.TOKEN, 'plain-value-9', 'legacy plaintext config still loads');
    console.log('CHILD OK');
  `);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 60000,
    env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, MUSER_REPO: path.join(__dirname, '..')}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /CHILD OK/);
});

test('number args keep floating point and bad values are a clear error, not a silent fallback', async t => {
  // params(): a JSON-schema 'number' must NOT become an 'integer' device spec (that
  // truncates floats downstream); it travels as a JSON-encoded string instead.
  const p = params({type: 'object', properties: {factor: {type: 'number'}}, required: ['factor']});
  assert.equal(p.required.factor.type, 'string');
  assert.ok(p.json.has('factor'));
  assert.equal(p.types.factor, 'number');
  const hub = new McpHub();
  t.after(() => hub.close());
  await hub.connect('fixture', {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')]});
  hub.index();
  assert.equal((await hub.call('mcp.fixture.scale', {factor: '2.5', value: '1.5'})).text, 'product=3.75');
  assert.equal((await hub.call('mcp.fixture.scale', {factor: 2.5, value: 1.5})).text, 'product=3.75');
  const bad = await hub.call('mcp.fixture.scale', {factor: 'abc', value: '1.5'});
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid argument "factor" for MCP tool scale: expected number, got "abc"/);
  await hub.close();
});

// Build a hub with a fake in-memory client so coercion / content / liveness logic can
// be unit-tested without a real server process.
function fakeHub(result) {
  const hub = new McpHub();
  const calls = [];
  const client = {callTool: async req => { calls.push(req); return result; }, close: async () => {}};
  const entry = {name: 'fake', status: 'connected', tools: [{name: 'do', inputSchema: {type: 'object', properties: {
    n: {type: 'number'}, i: {type: 'integer'}, b: {type: 'boolean'}, arr: {type: 'array'}, obj: {type: 'object'}, s: {type: 'string'},
  }}}], client, error: ''};
  hub.servers.set('fake', entry);
  hub.index();
  return {hub, calls, entry};
}

test('coercion errors: boolean/object/array/integer reject bad values before the server is called', async t => {
  const {hub, calls} = fakeHub({content: [{type: 'text', text: 'ok'}]});
  t.after(() => hub.close());
  for (const args of [{b: 'yes'}, {b: '1'}, {arr: '[1,'}, {arr: '{"a":1}'}, {obj: '[1,2]'}, {obj: '{bad'}, {i: '3.5'}, {i: 3.5}, {n: 'x'}, {n: NaN}]) {
    const r = await hub.call('mcp.fake.do', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, /Invalid argument/);
  }
  assert.equal(calls.length, 0, 'server never called with un-coercible args');
  const ok = await hub.call('mcp.fake.do', {b: 'true', arr: '[1,2]', obj: '{"a":1}', i: '3', n: '2.5', s: 'plain'});
  assert.equal(ok.isError, false);
  assert.deepEqual(calls[0].arguments, {b: true, arr: [1, 2], obj: {a: 1}, i: 3, n: 2.5, s: 'plain'});
  await hub.close();
});

test('result content: structuredContent is appended and non-text blocks become placeholders', async t => {
  const {hub} = fakeHub({content: [
    {type: 'text', text: 'hello'},
    {type: 'image', data: 'AA==', mimeType: 'image/png'},
    {type: 'audio', data: 'AA==', mimeType: 'audio/wav'},
    {type: 'resource_link', uri: 'https://example.com/doc'},
    {type: 'resource', resource: {uri: 'file:///x.txt', text: 'body'}},
  ], structuredContent: {total: 6.5}});
  t.after(() => hub.close());
  const r = await hub.call('mcp.fake.do', {s: 'x'});
  assert.equal(r.isError, false);
  assert.ok(r.text.startsWith('hello'));
  assert.ok(r.text.includes('[image content]'));
  assert.ok(r.text.includes('[audio content]'));
  assert.ok(r.text.includes('[resource: https://example.com/doc]'));
  assert.ok(r.text.includes('[resource: file:///x.txt]'));
  assert.ok(r.text.includes('body'));
  assert.ok(r.text.trimEnd().endsWith('{"total":6.5}'), 'structuredContent appended even though text exists: ' + r.text);
  await hub.close();
});

test('fixture report tool: structured + image + resource survive the real SDK round-trip', async t => {
  const hub = new McpHub();
  t.after(() => hub.close());
  await hub.connect('fixture', {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')]});
  hub.index();
  const r = await hub.call('mcp.fixture.report', {});
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('report text'));
  assert.ok(r.text.includes('[image content]'));
  assert.ok(r.text.includes('[resource: file:///fixture.txt]'));
  assert.ok(r.text.includes('{"total":6.5,"label":"sum"}'), r.text);
  await hub.close();
});

test('liveness: _markDead flips status to error, drops commands, and notifies', async t => {
  const {hub, entry} = fakeHub({content: []});
  t.after(() => hub.close());
  const seen = [];
  hub.onChange = (name, e) => seen.push([name, e?.status]);
  assert.ok(hub.commands.has('mcp.fake.do'));
  hub._markDead(entry, new Error('transport exploded'));
  assert.equal(entry.status, 'error');
  assert.equal(entry.error, 'transport exploded');
  assert.equal(entry.client, undefined);
  assert.ok(!hub.commands.has('mcp.fake.do'), 'dead server commands removed from the index');
  assert.deepEqual(seen, [['fake', 'error']]);
  hub._markDead(entry, new Error('again')); // idempotent: already dead
  assert.equal(seen.length, 1);
  await hub.close();
});

test('liveness: a fixture server that exits mid-session is marked error and de-indexed', async t => {
  const hub = new McpHub();
  t.after(() => hub.close());
  await hub.connect('fixture', {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')]});
  hub.index();
  assert.ok(hub.commands.has('mcp.fixture.crash'));
  await hub.call('mcp.fixture.crash', {}).catch(() => {}); // response may or may not beat the exit
  const until = Date.now() + 8000;
  while (Date.now() < until && hub.servers.get('fixture')?.status !== 'error') await new Promise(r => setTimeout(r, 50));
  assert.equal(hub.servers.get('fixture')?.status, 'error');
  assert.ok(hub.servers.get('fixture').error.length > 0);
  assert.ok(!hub.commands.has('mcp.fixture.echo'), 'commands removed after crash');
  await hub.close();
});

test('remote URL check: non-https is refused except loopback, and surfaces as error status', async t => {
  assert.throws(() => checkRemoteUrl('http://example.com/mcp'), /non-https/);
  assert.throws(() => checkRemoteUrl('ftp://example.com/mcp'), /non-https/);
  assert.throws(() => checkRemoteUrl('not a url'), /Invalid MCP server URL/);
  assert.equal(checkRemoteUrl('https://example.com/mcp').protocol, 'https:');
  assert.equal(checkRemoteUrl('http://localhost:8080/mcp').hostname, 'localhost');
  assert.equal(checkRemoteUrl('http://127.0.0.1:8080/mcp').hostname, '127.0.0.1');
  const hub = new McpHub();
  t.after(() => hub.close());
  await assert.rejects(hub.connect('remote', {url: 'http://example.com/mcp', headers: {Authorization: 'Bearer abcdef'}}), /non-https/);
  assert.equal(hub.servers.get('remote').status, 'error');
  assert.match(hub.servers.get('remote').error, /headers may carry secrets/);
  await hub.close();
});

// Audit #235: a 'string' parameter was the one schema type call() never checked, so a
// value the gateway had already coerced (123, true) reached the server type-changed.
test('coercion errors: a string parameter rejects non-string values before the server is called', async t => {
  const {hub, calls} = fakeHub({content: [{type: 'text', text: 'ok'}]});
  t.after(() => hub.close());
  for (const args of [{s: 123}, {s: true}, {s: null}, {s: ['x']}, {s: {a: 1}}]) {
    const r = await hub.call('mcp.fake.do', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, /Invalid argument "s" for MCP tool do: expected string/);
  }
  assert.equal(calls.length, 0, 'server never called');
  assert.equal((await hub.call('mcp.fake.do', {s: 'fine'})).isError, false);
  await hub.close();
});

// Audit #236: discover() imported servers the user had disabled in Claude Code
// (the Codex branch already honoured enabled:false; the Claude branch checked nothing).
test('discover: servers disabled in Claude Code or Codex are not imported', t => {
  const home = os.homedir();
  const claudeFile = path.join(home, '.claude.json'), codexDir = path.join(home, '.codex'), codexFile = path.join(codexDir, 'config.toml');
  t.after(() => { fs.rmSync(claudeFile, {force: true}); fs.rmSync(codexDir, {recursive: true, force: true}); });
  fs.rmSync(path.join(home, '.muser', 'mcp.json'), {force: true});
  fs.writeFileSync(claudeFile, JSON.stringify({mcpServers: {
    'claude-on': {command: 'a'},
    'claude-off': {command: 'b', disabled: true},
    'claude-off2': {command: 'c', enabled: false},
  }}));
  fs.mkdirSync(codexDir, {recursive: true});
  fs.writeFileSync(codexFile, '[mcp_servers.codex-on]\ncommand = "a"\n\n[mcp_servers.codex-off]\ncommand = "b"\nenabled = false\n');
  const {discover} = require('../src/mcp');
  assert.deepEqual(discover().map(f => f.name).sort(), ['claude-on', 'codex-on']);
});

// Audits #232/#233 (child process, temp home): save() prunes vault entries whose
// server/key is gone, and a $secret reference the vault lacks is reported — and
// refuses the connect — instead of reaching the server as an empty string.
// Wave 6 wording update: the refusal is now said in Japanese words without the
// internal store filename, so the pin below matches the new sentence, not the
// old English 'Secret(s) not found in the secure store (…enc)' text.
test('save prunes orphaned vault secrets; a missing vault entry refuses the connect (child process)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-home-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-local-'));
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert/strict');
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    const store = require(process.env.MUSER_REPO + '/src/secure-store.js');
    const dir = path.join(os.homedir(), '.muser'), file = path.join(dir, 'mcp.json');
    fs.mkdirSync(dir, {recursive: true});
    mcp.save({mcpServers: {demo: {command: 'node', env: {API_KEY: 'k1-value'}, headers: {Authorization: 'Bearer t1'}}}});
    let vault = store.load('mcp-secrets.enc');
    assert.deepEqual(Object.keys(vault).sort(), ['demo:env:API_KEY', 'demo:headers:Authorization']);
    mcp.save({mcpServers: {demo: {command: 'node', headers: {Authorization: 'Bearer t1'}}}}); // env key cleared
    vault = store.load('mcp-secrets.enc');
    assert.deepEqual(Object.keys(vault), ['demo:headers:Authorization'], 'the cleared key was pruned from the vault');
    mcp.save({mcpServers: {}}); // server deleted
    vault = store.load('mcp-secrets.enc');
    assert.deepEqual(vault, {}, 'the deleted server left no secrets behind');
    // A reference with nothing behind it: load reports it, connect refuses it.
    fs.writeFileSync(file, JSON.stringify({mcpServers: {ghost: {command: process.execPath, args: [], env: {API_KEY: {$secret: 'ghost:env:API_KEY'}}}}}));
    const loaded = mcp.load();
    assert.deepEqual(mcp.missingSecrets('ghost'), ['ghost:env:API_KEY']);
    (async () => {
      const hub = new mcp.McpHub();
      await assert.rejects(hub.connect('ghost', loaded.mcpServers.ghost), /秘密情報が安全な保管場所に見つかりませんでした/);
      assert.equal(hub.servers.get('ghost').status, 'error');
      await hub.close();
      console.log('CHILD OK');
    })().catch(e => { console.error(e); process.exit(1); });
  `);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 60000,
    env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, MUSER_REPO: path.join(__dirname, '..')}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /CHILD OK/);
});

// Audit #234: redaction notes only secret-looking keys, replaces longest first (a
// short prefix must not leave a longer secret's tail), and covers short secrets as
// whole tokens.
test('redact: secret keys only, longest first, short secrets as whole tokens', t => {
  const mcp = require('../src/mcp');
  const store = require('../src/secure-store');
  t.after(() => { fs.rmSync(mcp.FILE, {force: true}); try { store.save('mcp-secrets.enc', {}); } catch {} });
  mcp.save({mcpServers: {demo: {command: 'node', env: {API_TOKEN: 'abcdefgh', ALT_TOKEN: 'abcd', SHORT_TOKEN: 'ab', NODE_ENV: 'production'}}}});
  mcp.load(); // noting happens on resolve
  assert.equal(mcp.redact('the token abcdefgh leaked'), 'the token *** leaked', 'longest first: no tail survives');
  assert.equal(mcp.redact('running in production mode'), 'running in production mode', 'a plain config value under a non-secret key is not redacted');
  assert.equal(mcp.redact('pin ab here'), 'pin *** here', 'a short secret is redacted as a whole token');
  assert.equal(mcp.redact('abc stays'), 'abc stays', 'but not as a substring of a longer word');
});

test('setEnabled on a started hub connects/disconnects live (child process, temp home)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-home-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mcp-local-'));
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert/strict');
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    const dir = path.join(os.homedir(), '.muser');
    fs.mkdirSync(dir, {recursive: true});
    const fixture = path.join(process.env.MUSER_REPO, 'tests', 'fixtures-mcp-server.js');
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({mcpServers: {demo: {command: process.execPath, args: [fixture], enabled: false}}}));
    const waitFor = async (fn, what) => { const until = Date.now() + 8000; while (Date.now() < until) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout waiting for ' + what); };
    (async () => {
      const hub = new mcp.McpHub();
      await hub.start(); // nothing enabled yet; hub is now the started/active one
      assert.equal(hub.servers.has('demo'), false);
      mcp.setEnabled('demo', true);
      await waitFor(() => hub.servers.get('demo')?.status === 'connected', 'live connect on enable');
      await waitFor(() => hub.commands.has('mcp.demo.echo'), 'commands indexed on enable');
      assert.equal((await hub.call('mcp.demo.echo', {text: 'live'})).text, 'echo: live');
      mcp.setEnabled('demo', false);
      await waitFor(() => !hub.servers.has('demo'), 'live disconnect on disable');
      assert.ok(!hub.commands.has('mcp.demo.echo'), 'commands removed on disable');
      await hub.close();
      console.log('CHILD OK');
    })().catch(e => { console.error(e); process.exit(1); });
  `);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 30000,
    env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, MUSER_REPO: path.join(__dirname, '..')}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /CHILD OK/);
});
