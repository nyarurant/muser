// Live check: muser comes back after its sockets drop (sleep, network change), including in the
// middle of a turn. `--half-open` also checks that a socket whose pongs stop is noticed (~70 s).
// Sends two "テストです" turns; remove them from sessions.json afterwards.
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
const wait = ms => new Promise(r => setTimeout(r, ms));
const ASK = 'テストです。code.read で package.json を読んで、"name" の値だけを一言で答えてください。';
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const agent = new Agent({client, auth: createAuth(web), cwd: require('node:path').join(__dirname, '..'), mode: 'plan'});
  const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const drop = () => { agent.device._ws.terminate(); client.ws.terminate(); };
  agent.on('device', s => console.log(at(), 'device', s.message));
  agent.on('connection', c => console.log(at(), 'connection', c.state, c.error || ''));
  agent.on('tool-end', c => console.log(at(), 'tool-end', c.command, c.ok ? 'ok' : 'ERR ' + c.error));
  await agent.connectDevice(); console.log(at(), 'up');

  console.log('--- 1: both sockets drop while idle -> back in the background');
  drop(); await wait(9000);
  console.log(at(), 'gateway', client.status, '| device', agent.device.connected);

  console.log('--- 2: both drop right before a send -> the send reconnects');
  drop();
  const r1 = await agent.send(ASK); console.log(at(), 'REPLY', JSON.stringify(r1.text));

  console.log('--- 3: both drop in the middle of a turn -> the turn still finishes');
  agent.once('turn-start', () => setTimeout(() => { console.log(at(), 'dropping mid-turn'); drop(); }, 2000));
  const r2 = await agent.send('もう一度、' + ASK); console.log(at(), 'REPLY', JSON.stringify(r2.text));

  if (process.argv.includes('--half-open')) {
    console.log('--- 4: pongs stop (half-open socket) -> noticed and replaced');
    const dw = agent.device._ws, cw = client.ws;
    for (const ws of [dw, cw]) { ws.removeAllListeners('pong'); ws.ping = () => {}; }
    await wait(70000);
    console.log(at(), 'gateway', client.status, client.ws !== cw ? '(new socket)' : '(same socket!)', '| device', agent.device.connected, agent.device._ws !== dw ? '(new socket)' : '(same socket!)');
  }
  console.log('session', agent.session.id);
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
