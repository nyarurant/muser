'use strict';
// Fix phase 2 regression tests for src/mcp.js (deep audit c14 Medium items +
// fourth audit M6, the mcp.js part). Like tests/mcp.test.js, point the home /
// LOCALAPPDATA at throwaway folders BEFORE loading any src module, so a bare
// `node --test tests/fix2-mcp.test.js` can never touch the real ~/.muser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-mcp-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-mcp-home-'));

const {McpHub, params, listAllTools} = require('../src/mcp');
const REPO = path.join(__dirname, '..');

function runMcpChild(body, timeoutMs = 60000) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-mcp-home-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-mcp-local-'));
  const script = path.join(home, 'child.js');
  fs.writeFileSync(script, body);
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: timeoutMs,
    env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, MUSER_REPO: REPO}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /CHILD OK/);
  return {home, local};
}

// c14 #5: a string env used to crash save() with a strict-mode TypeError and
// an array env was silently rewritten into numeric $secret keys. Both are now
// refused with a clear message and the file on disk is left untouched; scalar
// values (a TOML import can carry numbers) are stored as strings, and a raw
// $secret reference in the saved object survives as a reference.
test('c14#5: save() refuses string/array env with a clear error and writes nothing; scalars stringify; $secret refs survive', () => {
  runMcpChild(`
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const assert = require('node:assert');
    const mcp = require(process.env.MUSER_REPO + '/src/mcp.js');
    const dir = path.join(os.homedir(), '.muser'), file = path.join(dir, 'mcp.json');
    fs.mkdirSync(dir, {recursive: true});
    const before = JSON.stringify({mcpServers: {keep: {command: 'node'}}});
    fs.writeFileSync(file, before);
    assert.throws(() => mcp.save({mcpServers: {s: {command: 'node', env: 'FOO=bar'}}}),
      e => e instanceof Error && !(e instanceof TypeError) && /"env" must be an object/.test(e.message), 'string env: clear non-TypeError');
    assert.throws(() => mcp.save({mcpServers: {s: {command: 'node', env: ['A=1', 'B=2']}}}), /"env" must be an object/, 'array env refused');
    assert.throws(() => mcp.save({mcpServers: {s: {command: 'node', headers: {X: {nested: 1}}}}}), /"headers\.X" must be a string/, 'object header value refused');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused save writes nothing');
    mcp.save({mcpServers: {n: {command: 'node', env: {PORT: 8080, DEBUG: true}}}});
    const loaded = mcp.load();
    assert.equal(loaded.mcpServers.n.env.PORT, '8080', 'number env value loads back as a string');
    assert.equal(loaded.mcpServers.n.env.DEBUG, 'true');
    mcp.save({mcpServers: {r: {command: 'node', env: {API_KEY: {$secret: 'elsewhere:env:API_KEY'}}}}});
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.mcpServers.r.env.API_KEY, {$secret: 'elsewhere:env:API_KEY'}, 'a raw $secret reference is kept, not refused or resolved');
    console.log('CHILD OK');
  `);
});

// c14 #5, connect side: a config that never went through save() (hand-edited)
// is validated in connect() too — a string args used to hang in the SDK until
// the 15 s connect timeout instead of saying what is wrong.
test('c14#5: connect() rejects malformed args/env/command immediately with a named field', async () => {
  const hub = new McpHub();
  const t0 = Date.now();
  await assert.rejects(hub.connect('badargs', {command: process.execPath, args: '--flag'}), /"args" must be an array of strings/);
  assert.ok(Date.now() - t0 < 5000, 'string args fails fast, not on the connect timeout');
  assert.equal(hub.servers.get('badargs').status, 'error');
  await assert.rejects(hub.connect('badenv', {command: process.execPath, args: [], env: 'FOO=bar'}), /"env" must be an object/);
  await assert.rejects(hub.connect('nocmd', {args: []}), /"command" must be a non-empty string/);
  await hub.close();
});

// c14 #2: two windows toggling different servers concurrently used to lose
// one change (each save wrote back its own stale load() snapshot, for the
// vault as well as mcp.json). setEnabled/importServers now load+save under
// the mcp.json lock, so both changes — and both secrets — survive.
test('c14#2: concurrent setEnabled from two processes keeps both toggles and both secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-race-home-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-race-local-'));
  const dir = path.join(home, '.muser'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({mcpServers: {
    aaa: {command: 'node', enabled: false, env: {API_TOKEN: 'token-aaa-1111'}},
    bbb: {command: 'node', enabled: false, env: {API_TOKEN: 'token-bbb-2222'}},
  }}));
  const childFile = path.join(home, 'child.cjs');
  fs.writeFileSync(childFile, `
    const mcp = require(${JSON.stringify(path.join(REPO, 'src/mcp.js'))});
    const fs = require('node:fs');
    const until = Date.now() + 30000; while (!fs.existsSync(process.env.GO) && Date.now() < until) {}
    for (let i = 0; i < 40; i++) mcp.setEnabled(process.env.SRV, i % 2 === 1);
    mcp.setEnabled(process.env.SRV, true);
  `);
  const go = path.join(home, 'go');
  const run = name => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [childFile], {env: {...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, GO: go, SRV: name}, stdio: 'pipe'});
    let err = ''; p.stderr.on('data', d => err += d);
    p.on('exit', c => c === 0 ? resolve() : reject(new Error(name + ' exit ' + c + ': ' + err.slice(0, 400))));
  });
  const pa = run('aaa'), pb = run('bbb');
  fs.writeFileSync(go, 'go');
  await Promise.all([pa, pb]);
  const final = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
  assert.equal(final.mcpServers.aaa.enabled, true, 'aaa toggle survived');
  assert.equal(final.mcpServers.bbb.enabled, true, 'bbb toggle survived (was lost before the fix)');
  assert.deepEqual(final.mcpServers.aaa.env.API_TOKEN, {$secret: 'aaa:env:API_TOKEN'});
  assert.deepEqual(final.mcpServers.bbb.env.API_TOKEN, {$secret: 'bbb:env:API_TOKEN'});
});

// c14 #3: type:'sse' servers were connected with StreamableHTTP and always
// failed. A legacy SSE-only server (SDK SSEServerTransport over HTTP) must
// now connect and answer a call.
test('c14#3: a legacy SSE-only server connects via type sse and answers calls', async () => {
  const {Server} = require('@modelcontextprotocol/sdk/server/index.js');
  const {SSEServerTransport} = require('@modelcontextprotocol/sdk/server/sse.js');
  const {ListToolsRequestSchema, CallToolRequestSchema} = require('@modelcontextprotocol/sdk/types.js');
  let transport = null;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/sse') {
      const low = new Server({name: 'legacy', version: '1.0.0'}, {capabilities: {tools: {}}});
      low.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{name: 'ping', description: 'ping', inputSchema: {type: 'object', properties: {}}}]}));
      low.setRequestHandler(CallToolRequestSchema, async () => ({content: [{type: 'text', text: 'pong'}]}));
      transport = new SSEServerTransport('/messages', res);
      await low.connect(transport);
    } else if (req.method === 'POST' && u.pathname === '/messages' && transport) { await transport.handlePostMessage(req, res); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const hub = new McpHub();
  try {
    await hub.connect('legacy', {type: 'sse', url: 'http://127.0.0.1:' + srv.address().port + '/sse'});
    assert.equal(hub.servers.get('legacy').status, 'connected');
    hub.index();
    assert.equal((await hub.call('mcp.legacy.ping', {})).text, 'pong');
  } finally { await hub.close(); srv.close(); }
});

// c14 #4: call() results and errors bypassed redact() entirely, so a server
// echoing its own credentials handed them verbatim to the agent and logs.
test('c14#4: call() redacts known secrets from results, structured content and thrown errors', async () => {
  const mcp = require('../src/mcp');
  mcp.save({mcpServers: {demo: {command: 'node', env: {API_TOKEN: 'sekrit-fix2-4242'}}}});
  mcp.load(); // notes the secret for redaction
  const hub = new McpHub();
  const client = {callTool: async () => ({content: [{type: 'text', text: 'key is sekrit-fix2-4242 ok'}], structuredContent: {echo: 'sekrit-fix2-4242'}}), close: async () => {}};
  hub.servers.set('fake', {name: 'fake', status: 'connected', tools: [{name: 'do', inputSchema: {type: 'object', properties: {}}}], client, error: ''});
  hub.index();
  const r = await hub.call('mcp.fake.do', {});
  assert.ok(!r.text.includes('sekrit-fix2-4242'), 'result text redacted: ' + r.text);
  assert.ok(r.text.includes('***'));
  client.callTool = async () => { throw new Error('auth failed for sekrit-fix2-4242'); };
  await assert.rejects(hub.call('mcp.fake.do', {}), e => !e.message.includes('sekrit-fix2-4242') && e.message.includes('auth failed for ***'));
  await hub.close();
});

// c14 #6: the list timeout restarted per page (up to ~300 s total) and a page
// could carry any number of tools. listAllTools now runs under one deadline
// and a total tool cap.
test('c14#6: listAllTools enforces one overall deadline, a tool cap and cursor sanity', async () => {
  const tool = n => ({name: 't' + n, inputSchema: {}});
  // Slow drip: every page answers inside a per-page budget but the total overruns.
  let page = 0;
  const drip = {listTools: async () => { await new Promise(r => setTimeout(r, 40)); return {tools: [tool(page)], nextCursor: 'c' + (++page)}; }};
  await assert.rejects(listAllTools(drip, () => false, 150, 20, 1000), /タイムアウト/, 'one deadline for the whole listing, not per page');
  // One huge page hits the total cap.
  const huge = {listTools: async () => ({tools: Array.from({length: 50}, (_, i) => tool(i))})};
  await assert.rejects(listAllTools(huge, () => false, 5000, 20, 10), /件数が上限/, 'total tool count is capped');
  // A repeating cursor is still refused, and a normal multi-page list works.
  const loop = {listTools: async () => ({tools: [tool(1)], nextCursor: 'same'})};
  await assert.rejects(listAllTools(loop, () => false, 5000, 20, 1000), /カーソルが繰り返されました/);
  const ok = {listTools: async ({cursor} = {}) => cursor ? {tools: [tool(2)]} : {tools: [tool(1)], nextCursor: 'n'}};
  assert.deepEqual((await listAllTools(ok, () => false, 5000, 20, 1000)).map(t => t.name), ['t1', 't2']);
  // Stale mid-listing resolves to null instead of tools.
  const slow = {listTools: async () => ({tools: [tool(1)], nextCursor: 'n'})};
  assert.equal(await listAllTools(slow, () => true, 5000, 20, 1000), null);
});

// c14 #6 at connect() level: a single page carrying 5000 tools is refused
// instead of being indexed wholesale.
test('c14#6: connect() refuses a server whose one page carries more tools than the cap', async () => {
  const fx = path.join(os.tmpdir(), 'muser-fix2-bigpage-' + process.pid + '.cjs');
  fs.writeFileSync(fx, `
    const {Server} = require(${JSON.stringify(path.join(REPO, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js'))});
    const {StdioServerTransport} = require(${JSON.stringify(path.join(REPO, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js'))});
    const {ListToolsRequestSchema} = require(${JSON.stringify(path.join(REPO, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js'))});
    const low = new Server({name: 'big', version: '1.0.0'}, {capabilities: {tools: {}}});
    low.setRequestHandler(ListToolsRequestSchema, async () => ({tools: Array.from({length: 5000}, (_, i) => ({name: 't' + i, description: 'x', inputSchema: {type: 'object', properties: {}}}))}));
    low.connect(new StdioServerTransport());
  `);
  const hub = new McpHub();
  await assert.rejects(hub.connect('big', {command: process.execPath, args: [fx]}), /件数が上限/);
  assert.equal(hub.servers.get('big').status, 'error');
  await hub.close();
});

// c14 #7: one broken tool schema (non-array enum, null property) used to make
// params() throw inside index(), which had already cleared every command.
test('c14#7: broken tool schemas do not throw in params()/index() and do not wipe other commands', () => {
  assert.doesNotThrow(() => params({type: 'object', properties: {x: {type: 'string', enum: 42}}}));
  assert.doesNotThrow(() => params({type: 'object', properties: {x: null}}));
  assert.doesNotThrow(() => params(null));
  assert.doesNotThrow(() => params({properties: 'nope', required: 'x'}));
  const p = params({type: 'object', properties: {x: {type: 'string', enum: ['a', 'b']}}});
  assert.match(p.optional.x.description, /One of: a, b\./, 'a well-formed enum still renders');
  const hub = new McpHub();
  hub.servers.set('good', {name: 'good', status: 'connected', tools: [{name: 'ok', inputSchema: {type: 'object', properties: {}}}]});
  hub.servers.set('bad', {name: 'bad', status: 'connected', tools: [
    {name: 'enum-num', inputSchema: {type: 'object', properties: {x: {type: 'string', enum: 42}}}},
    {name: 'null-prop', inputSchema: {type: 'object', properties: {x: null}}},
    null,
    {name: 'no-schema'},
  ]});
  assert.doesNotThrow(() => hub.index());
  assert.ok(hub.commands.has('mcp.good.ok'), 'the healthy server keeps its commands');
  assert.ok(hub.commands.has('mcp.bad.enum_num'));
  assert.ok(hub.commands.has('mcp.bad.null_prop'));
  // A tool whose schema accessor itself throws is skipped, not fatal, and a
  // re-index keeps the previously built commands for the other servers.
  const evil = {name: 'evil'};
  Object.defineProperty(evil, 'inputSchema', {get() { throw new Error('boom'); }});
  hub.servers.set('bad', {name: 'bad', status: 'connected', tools: [evil]});
  assert.doesNotThrow(() => hub.index());
  assert.ok(hub.commands.has('mcp.good.ok'), 'commands survive a tool that throws during indexing');
  assert.ok(![...hub.commands.keys()].some(k => k.includes('evil')), 'the throwing tool itself is skipped');
});

// Fourth audit M6 (mcp.js part): index() stores the server's self-declared
// readOnlyHint as the command's readOnly flag. A tool that also declares
// destructiveHint contradicts that claim, so the claim is not recorded.
// (Whether a recorded claim is trusted at all stays the opt-in trustReadOnly
// decision in agent.js; that part is outside src/mcp.js.)
test('fourth M6: a destructiveHint tool does not get readOnly from its readOnlyHint', () => {
  const hub = new McpHub();
  hub.servers.set('s', {name: 's', status: 'connected', tools: [
    {name: 'look', inputSchema: {}, annotations: {readOnlyHint: true}},
    {name: 'sneaky', inputSchema: {}, annotations: {readOnlyHint: true, destructiveHint: true}},
    {name: 'plain', inputSchema: {}},
  ]});
  hub.index();
  assert.equal(hub.commands.get('mcp.s.look').readOnly, true, 'a consistent read-only claim is recorded');
  assert.equal(hub.commands.get('mcp.s.sneaky').readOnly, false, 'readOnlyHint + destructiveHint is a contradiction: not recorded as read-only');
  assert.equal(hub.commands.get('mcp.s.plain').readOnly, false);
});
