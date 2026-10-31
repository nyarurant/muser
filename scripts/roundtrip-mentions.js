// Live check: the message body the TUI builds for @file and !command reaches Muse.
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
const mention = require('../src/mentions');
const {TOOLS} = require('../src/tools');
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const agent = new Agent({client, auth: createAuth(web), cwd: process.cwd(), mode: 'plan'});
  await agent.connectDevice();
  const r = await TOOLS['system.run'].run({command: 'Write-Output "BANG-OK-7"'}, agent.ctx);
  const note = '[The user ran this in the terminal: Write-Output "BANG-OK-7"]\nexit ' + r.payload.exit_code + '\n' + r.payload.stdout;
  const text = 'テストです。ツールは使わずに、@package.json の "version" と、私がターミナルで実行したコマンドの出力を答えてください。';
  const ex = mention.expand(text, agent.cwd, agent.ctx.readFiles);
  const used = [];
  agent.on('tool-end', c => used.push(c.command));
  const reply = await agent.send(text + '\n\n' + [note, ex.block].join('\n\n'), {display: text});
  console.log('REPLY:', JSON.stringify(reply.text), '| tools used:', used.join(',') || 'none');
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
