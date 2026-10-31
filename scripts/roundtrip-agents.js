// Live check: parallel agents. Mode plan (read-only). With --muse, the main session spawns them itself.
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const agent = new Agent({client, auth: createAuth(web), cwd: process.cwd(), mode: 'plan'});
  const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
  agent.on('agent-tool', c => console.log(at(), '[' + c.agent + '] tool', c.command, c.summary, c.ok ? 'ok' : 'ERR ' + c.error));
  agent.on('tool-end', c => console.log(at(), '[main] tool', c.command, c.summary, c.ok ? 'ok' : 'ERR ' + c.error));
  agent.on('agent-done', s => console.log(at(), '[' + s.tag + '] DONE', s.state, JSON.stringify(s.result || s.error).slice(0, 100)));
  await agent.connectDevice();
  if (process.argv.includes('--muse')) {
    const r = await agent.send('テストです。agent.spawn で並列エージェントを2つ起動してください。1つ目は code.read で package.json を読んで "name" を答える、2つ目は code.read で LICENSE を読んで1行目を答える。そのあと agent.wait で両方の結果を集めて、短くまとめて答えてください。');
    console.log(at(), 'MAIN REPLY:', JSON.stringify(r.text));
  } else {
    agent.spawn('code.read で package.json を読んで、"name" の値だけ答えて。', {title: 'name'});
    agent.spawn('code.read で LICENSE を読んで、1行目だけ答えて。', {title: 'license'});
    while (agent.busy) await new Promise(r => setTimeout(r, 500));
  }
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
