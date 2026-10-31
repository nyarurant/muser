// Live check: Muse runs a server in the background, talks to it, reads its log, stops it.
// Approvals: allowed only for commands run inside the lab folder (argv[2]).
const path = require('node:path');
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
const lab = path.resolve(process.argv[2]);
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const agent = new Agent({client, auth: createAuth(web), cwd: lab, mode: 'default'});
  const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
  agent.approver = async call => { const ok = !call.params.cwd || path.resolve(lab, call.params.cwd).startsWith(lab); console.log(at(), 'ASK', call.command, call.summary, ok ? 'allow' : 'deny'); return {allow: ok}; };
  agent.on('tool-end', c => console.log(at(), 'tool', c.command, String(c.summary || '').slice(0, 60), c.ok ? 'ok ' + JSON.stringify(c.view?.background || c.view?.tail?.slice(-1) || '') : 'ERR ' + c.error));
  await agent.connectDevice();
  const r = await agent.send('テストです。このフォルダーの server.js を system.run の background=true で起動して、Invoke-WebRequest -UseBasicParsing http://127.0.0.1:38999/hi で応答を確かめ、shell.output でサーバーのログを読み、最後に shell.kill で止めてください。応答の本文とログの行を短く答えて。');
  console.log(at(), 'REPLY:', JSON.stringify(r.text));
  console.log('shells after:', JSON.stringify(agent.shells.all().map(s => ({id: s.id, running: s.running}))));
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
