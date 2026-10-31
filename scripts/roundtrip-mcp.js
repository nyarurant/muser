// Live check: Muse calls tools of a local fixture MCP server through the CLI device.
// The fixture is attached for this run only; only its tools are approved.
const path = require('node:path');
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
const {McpHub} = require('../src/mcp');
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const mcp = new McpHub();
  await mcp.connect('fixture', {command: process.execPath, args: [path.join(__dirname, '..', 'tests', 'fixtures-mcp-server.js')]}); mcp.index();
  const agent = new Agent({client, auth: createAuth(web), cwd: process.cwd(), mode: 'default', mcp});
  agent.approver = async call => ({allow: call.command === 'mcp.fixture.add'});
  const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  agent.on('tool-start', c => console.log(at(), 'tool-start', c.command, JSON.stringify(c.params)));
  agent.on('tool-end', c => console.log(at(), 'tool-end', c.command, c.ok ? 'ok ' + JSON.stringify(c.view?.text || '').slice(0, 80) : 'ERR ' + c.error));
  agent.on('turn-end', e => console.log(at(), 'turn-end', e.ok ? 'ok' : 'ERR ' + e.error));
  await agent.connectDevice(); console.log(at(), 'device connected, commands:', Object.keys(agent.commands()).filter(k => k.startsWith('mcp.')).join(' '));
  const reply = await agent.send('テストです。MCP ツール mcp.fixture.echo で "hello" を送り、次に mcp.fixture.add で 2, 3, 4 を足してください（nums は JSON 配列の文字列）。両方の結果だけを短く答えてください。');
  console.log(at(), 'REPLY:', JSON.stringify(reply.text));
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
