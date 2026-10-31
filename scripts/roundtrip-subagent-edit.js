// Live check: a test-type agent edits and runs commands; an explore-type agent is refused edits.
// Approvals: allowed only for actions inside the lab folder given as argv[2].
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
  agent.approver = async call => {
    const inLab = call.command === 'system.run' ? !call.params.cwd || path.resolve(lab, call.params.cwd).startsWith(lab) : String(call.params.path || '').length ? path.resolve(lab, call.params.path).startsWith(lab) : call.command === 'code.apply_patch';
    console.log(at(), '[' + call.agent + '] ASK', call.command, call.summary, '->', inLab ? 'allow' : 'deny'); return {allow: inLab};
  };
  agent.on('agent-tool', c => console.log(at(), '[' + c.agent + '] tool', c.command, String(c.summary || '').slice(0, 50), c.ok ? 'ok' : 'REFUSED: ' + String(c.error).slice(0, 90)));
  agent.on('agent-done', s => console.log(at(), '[' + s.tag + ' ' + s.type + '] DONE', s.state, JSON.stringify(s.result || s.error).slice(0, 160)));
  await agent.connectDevice();
  agent.spawn('このフォルダーのテストを npm test で流して、落ちていたら原因を直して、もう一度流して通ることを確認して。', {type: 'test', title: 'テスト修正'});
  agent.spawn('math.js の先頭に「// explored」というコメントを code.edit で追加してみて。できなかったら、その理由を答えて。', {type: 'explore', title: '編集を試す'});
  while (agent.busy) await new Promise(r => setTimeout(r, 500));
  agent.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
