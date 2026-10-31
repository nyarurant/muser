// Live check: one real turn through the same path as `muser exec`, logging what the UI would get.
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const agent = new Agent({client, auth: createAuth(web), cwd: process.cwd(), mode: 'plan'});
  const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  let deltas = 0;
  agent.on('text', e => { deltas++; if (deltas <= 3 || deltas % 20 === 0) console.log(at(), 'text', e.id.slice(0, 18), JSON.stringify(e.text.slice(-40))); });
  agent.on('message-done', e => console.log(at(), 'message-done', JSON.stringify(e.text.slice(0, 120))));
  agent.on('tool-start', c => console.log(at(), 'tool-start', c.command, c.summary));
  agent.on('tool-end', c => console.log(at(), 'tool-end', c.command, c.ok ? 'ok' : 'ERR ' + c.error));
  agent.on('status', s => console.log(at(), 'status', s));
  agent.on('turn-end', e => console.log(at(), 'turn-end', e.ok ? 'ok' : 'ERR ' + e.error));
  await agent.connectDevice(); console.log(at(), 'device connected');
  const reply = await agent.send(process.argv[2] || 'テストです。code.read で package.json を読んで、"name" の値だけを一言で答えてください。');
  console.log(at(), 'REPLY:', JSON.stringify(reply.text), '| text events:', deltas);
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
