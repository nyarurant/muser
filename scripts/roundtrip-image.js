// Live check: an image attachment reaches Muse through the device channel.
const {createWeb} = require('../src/web');
const {connectChat} = require('../src/session');
const {createAuth} = require('../src/pc-login');
const {Agent} = require('../src/agent');
const clip = require('../src/clipboard');
(async () => {
  const web = createWeb(), client = await connectChat(web); await client.subscribe();
  const agent = new Agent({client, auth: createAuth(web), cwd: process.cwd(), mode: 'plan'});
  await agent.connectDevice();
  const t0 = Date.now();
  const reply = await agent.send('テストです。添付した画像に書いてある文字だけを答えてください。ツールは使わないで。', {attachments: [clip.attachment(process.argv[2])]});
  console.log(((Date.now() - t0) / 1000).toFixed(1) + 's REPLY:', JSON.stringify(reply.text));
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
