'use strict';
// Focus debugging pass of 2026-11-02: one regression check per defect found (see DevNote
// 2026-11-02-focus-sensitivity). Unit checks drive Focus directly; the rest go through the
// real Agent + Controller with a fake Muse, as tests/focus.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Focus} = require('../src/focus');
const {Agent} = require('../src/agent');
const sessions = require('../src/sessions');

const plan = [{text: 'Source satisfies the requested behavior', kind: 'inspection'}];
const read = p => ({command: 'code.read', kind: 'read', params: {path: p}, summary: p});
const edit = p => ({command: 'code.edit', kind: 'edit', params: {path: p}, summary: p});
const run = cmd => ({command: 'system.run', kind: 'exec', params: {command: cmd}, summary: cmd});
const exit = code => ({ok: true, payload: {exit_code: code}});
const met = (id, evidence) => ({id, status: 'met', evidence, reason: 'observed'});

test('unmet work continues even when a manual check also waits for the user', () => {
  const f = new Focus('Fix and check'); f.beginRound(); f.observe(edit('a.js'), {ok: true});
  f.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}, {text: 'Looks right on the device', kind: 'manual'}]);
  f.checkpoint([{id: 'c1', status: 'unmet', reason: '2 failing'}, {id: 'c2', status: 'unknown', reason: 'user'}]);
  assert.equal(f.endRound().continue, true);
  f.beginRound(); const pass = f.observe(run('npm test'), exit(0));
  f.checkpoint([met('c1', [pass]), {id: 'c2', status: 'unknown', reason: 'user'}]);
  assert.equal(f.endRound().status, 'needs_input', 'only the user can settle what is left');
});

test('a resumed leg may start a different task with new_task, and only there', () => {
  const f = new Focus('Old task'); f.beginRound(); f.observe(edit('a.js'), {ok: true});
  f.plan([{text: 'Device ok', kind: 'manual'}]); f.checkpoint([{id: 'c1', status: 'unknown', reason: 'u'}]); f.endRound();
  assert.throws(() => f.plan([{text: 'Other', kind: 'inspection'}], {newTask: true}), /fixed/, 'not outside a resumed leg');
  const oldId = f.id, next = f.nextEvidence;
  f.resumeLeg('Now add a dark mode'); f.beginRound();
  assert.match(f.resumeNote(), /Old task[\s\S]*c1 \[unknown\] Device ok[\s\S]*new_task=true/);
  assert.throws(() => f.plan([{text: 'Dark mode works', kind: 'inspection'}]), /new_task=true/);
  f.plan([{text: 'Dark mode works', kind: 'inspection'}], {newTask: true});
  assert.equal(f.goal, 'Now add a dark mode'); assert.notEqual(f.id, oldId);
  assert.deepEqual(f.criteria.map(c => c.text), ['Dark mode works']);
  assert.equal(f.observe(read('a.js'), {ok: true}), 'e' + next, 'evidence IDs carry on, never reused');
  assert.throws(() => { f.goal = 'weaker'; }, TypeError);
  assert.throws(() => f.plan([{text: 'Something else', kind: 'inspection'}], {newTask: true}), /fixed/, 'once per leg');
});

test('a command that went to the background counts once shell.output shows it ended with exit 0', () => {
  const f = new Focus('Publish'); f.beginRound(); f.observe(edit('a.cs'), {ok: true});
  f.plan([{text: 'Publishes', kind: 'command', command: 'dotnet publish'}]);
  const started = f.observe(run('dotnet publish'), {ok: true, payload: {shell_id: 'bg1', backgrounded: true}});
  const out = (payload) => f.observe({command: 'shell.output', kind: 'read', params: {shell_id: payload.id}, summary: payload.id}, {ok: true, payload});
  const running = out({id: 'bg1', running: true, exit_code: null});
  const other = out({id: 'bg9', running: false, exit_code: 0});
  for (const ref of [started, running, other]) assert.throws(() => f.checkpoint([met('c1', [ref])]), /evidence/);
  const done = out({id: 'bg1', running: false, exit_code: 0});
  f.checkpoint([met('c1', [done])]);
  assert.equal(f.endRound().status, 'complete');
  const failed = new Focus('Publish'); failed.beginRound(); failed.plan([{text: 'Publishes', kind: 'command', command: 'dotnet publish'}]);
  failed.observe(run('dotnet publish'), {ok: true, payload: {shell_id: 'bg2'}});
  const bad = failed.observe({command: 'shell.output', kind: 'read', params: {shell_id: 'bg2'}}, {ok: true, payload: {id: 'bg2', running: false, exit_code: 1}});
  assert.throws(() => failed.checkpoint([met('c1', [bad])]), /cannot prove/);
});

test('evidence older than the 300-entry change log counts as expired', () => {
  const f = new Focus('Many edits'); f.beginRound();
  const old = f.observe(read('a.js'), {ok: true});
  f.observe(edit('a.js'), {ok: true});
  for (let i = 0; i < 300; i++) f.observe(edit('b' + i + '.js'), {ok: true});
  assert.equal(f.evidenceCurrent({revision: 0, paths: ['a.js']}), false, 'the edit to a.js fell out of the log, so a.js evidence cannot be cleared');
  assert.ok(old);
});

test('what Muse is handed stays small and the instruction is not repeated in the continuation prompt', () => {
  const f = new Focus('Big task'); f.beginRound();
  for (let i = 0; i < 300; i++) f.observe(run('Get-ChildItem C:\\some\\long\\folder\\path -Recurse | Format-Table ' + i), exit(0));
  assert.ok(f.prompt().length < 20000, 'was ~100 KB with the whole evidence log');
  assert.ok(f.modelState().evidence.length <= 40);
  assert.equal(f.prompt().includes('AUTOMATIC FOCUS'), false, 'runTurn already prefixes the instruction');
  assert.equal(f.snapshot().evidence.length, 300, 'the full log stays available locally');
});

test('read-only MCP tools are not changes; others still are', () => {
  const q = new Focus('Find an item'); q.beginRound();
  for (let i = 0; i < 3; i++) q.observe({command: 'mcp.booth.search', kind: 'mcp', mcp: {readOnly: true}, summary: 'search'}, {ok: true, payload: {}});
  assert.equal(q.endRound().status, 'inactive');
  const w = new Focus('Buy it'); w.beginRound();
  const proof = w.observe(run('npm test'), exit(0));
  w.observe({command: 'mcp.booth.cart', kind: 'mcp', mcp: {readOnly: false}, summary: 'cart'}, {ok: true, payload: {}});
  assert.equal(w.endRound().continue, true);
  assert.equal(w.evidenceCurrent(w.evidence.find(e => e.id === proof)), false);
});

test('declared checks keep each other current but still date what files said before them', () => {
  const f = new Focus('Single-file exe'); f.beginRound();
  f.plan([{text: 'Builds', kind: 'command', command: 'dotnet build'}, {text: 'Publishes', kind: 'command', command: 'dotnet publish'}, {text: 'One file in publish/', kind: 'inspection'}]);
  const before = f.observe({command: 'code.glob', kind: 'read', params: {path: 'publish'}, summary: 'publish'}, {ok: true});
  const build = f.observe(run('dotnet build'), exit(0)), pub = f.observe(run('dotnet publish'), exit(0));
  assert.throws(() => f.checkpoint([met('c1', [build]), met('c2', [pub]), met('c3', [before])]), /e1 is out of date/);
  const after = f.observe({command: 'code.glob', kind: 'read', params: {path: 'publish'}, summary: 'publish'}, {ok: true});
  f.checkpoint([met('c1', [build]), met('c2', [pub]), met('c3', [after])]);
  assert.equal(f.endRound().status, 'complete');
});

test('a manual check can be met only after the user wrote back', () => {
  const f = new Focus('Check the headset'); f.beginRound(); f.observe(edit('a.js'), {ok: true});
  f.plan([{text: 'Visible in the headset', kind: 'manual'}]);
  assert.throws(() => f.checkpoint([met('c1', [])]), /user confirmation/);
  f.checkpoint([{id: 'c1', status: 'unknown', reason: 'please check'}]); assert.equal(f.endRound().status, 'needs_input');
  f.resumeLeg('見えたよ'); f.beginRound();
  f.checkpoint([{id: 'c1', status: 'met', evidence: [], reason: 'The user wrote: 見えたよ'}]);
  assert.equal(f.endRound().status, 'complete');
});

test('a refused checkpoint says which evidence is wrong and why', () => {
  const f = new Focus('Verify'); f.beginRound(); f.plan(plan);
  const r = f.observe(read('a.js'), {ok: true}), e = f.observe(edit('a.js'), {ok: true});
  assert.throws(() => f.checkpoint([met('c1', ['e99'])]), /e99 is not a known evidence ID/);
  assert.throws(() => f.checkpoint([met('c1', [e])]), new RegExp(e + ' \\(code\\.edit\\) cannot prove'));
  assert.throws(() => f.checkpoint([met('c1', [r])]), new RegExp(r + ' is out of date: a later change to a\\.js'));
  const c = new Focus('Tests'); c.beginRound(); c.plan([{text: 'Pass', kind: 'command', command: 'npm test'}]);
  const other = c.observe(read('x'), {ok: true});
  assert.throws(() => c.checkpoint([met('c1', [other])]), /exact verification command: npm test/);
});

test('stopping a background shell is no task by itself and leaves file evidence alone', () => {
  const q = new Focus('Stop the dev server'); q.beginRound();
  q.observe({command: 'shell.kill', kind: 'edit', params: {shell_id: 'bg1'}, summary: 'bg1'}, {ok: true, payload: {}});
  assert.equal(q.endRound().status, 'inactive');
  const f = new Focus('Task'); f.beginRound();
  const r = f.observe(read('a.js'), {ok: true}), c = f.observe(run('git status'), exit(0));
  f.observe({command: 'shell.kill', kind: 'edit', params: {shell_id: 'bg1'}, summary: 'bg1'}, {ok: true, payload: {}});
  assert.equal(f.evidenceCurrent(f.evidence.find(x => x.id === r)), true, 'no file changed');
  assert.equal(f.evidenceCurrent(f.evidence.find(x => x.id === c)), false, 'what a running process answered may have changed');
});

// ---- through the real Agent + Controller ----

async function harness(t, work) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-debug-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true})); fs.writeFileSync(path.join(cwd, 'probe.txt'), 'probe');
  const client = new EventEmitter(), events = [], sends = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() { this.cancelled = true; }, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)}); agent.subscribed = true;
  t.after(() => agent.close());
  let inFlight = false;
  agent.device = {connected: true, disconnect() {}, async send(body, sessionId) {
    const round = sends.length + 1, id = 'user-' + round; sends.push({body, sessionId}); client.taskStatus = 'running';
    events.push({role: 'user', message_id: id, content: body, seq: round * 2});
    if (inFlight) return {message_id: id};
    inFlight = true;
    setImmediate(async () => {
      try {
        await work(agent, round);
        if (agent.main.turn?.controller.signal.aborted) { inFlight = false; return; }
        const done = {event: 'delta.message_done', seq: round * 2 + 1, payload: {session_id: sessionId, message_id: 'reply-' + round, role: 'assistant', text: 'reply ' + round, status: 'completed'}};
        events.push(done); client.taskStatus = 'completed'; inFlight = false; client.emit('event', done);
      } catch (e) { client.taskStatus = 'failed'; inFlight = false; client.emit('event', {event: 'task.status', session_id: sessionId, payload: {status: 'failed'}}); }
    });
    return {message_id: id};
  }};
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  return {agent, ctrl, sends, client, cwd};
}
const json = x => JSON.stringify(x);

test('a resumed leg tells Muse about the open task, and new_task turns the follow-up into its own task', async t => {
  const fx = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('code.write', {agent: 'main', path: 'x.txt', content: 'x'}, 1000, 'w1');
      await a.execute('focus.plan', {agent: 'main', criteria: json([{text: 'Shows on the device', kind: 'manual'}])});
      await a.execute('focus.checkpoint', {agent: 'main', checks: json([{id: 'c1', status: 'unknown', reason: 'user'}])});
    } else {
      const r = await a.execute('focus.plan', {agent: 'main', new_task: true, criteria: json(plan)});
      assert.equal(r.ok, true, r.error);
      const proof = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'r2');
      await a.execute('focus.checkpoint', {agent: 'main', checks: json([met('c1', [proof.payload.muser_evidence_id])])});
    }
  });
  fx.agent.approver = async () => ({allow: true});
  const first = await fx.agent.send('Original task');
  assert.equal(first.focus.status, 'needs_input');
  const second = await fx.agent.send('Unrelated: read probe.txt');
  assert.match(fx.sends[1].body, /previous task in this chat is unfinished[\s\S]*Original task[\s\S]*c1 \[unknown\] Shows on the device/);
  assert.equal(second.focus.goal, 'Unrelated: read probe.txt');
  assert.equal(second.focus.status, 'complete');
});

test('only results that can prove something carry an evidence ID', async t => {
  let ids;
  const fx = await harness(t, async a => {
    await a.execute('focus.plan', {agent: 'main', criteria: json(plan)});
    const w = await a.execute('code.write', {agent: 'main', path: 'y.txt', content: 'y'}, 1000, 'w');
    const r = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'r');
    ids = {write: w.payload?.muser_evidence_id, read: r.payload?.muser_evidence_id};
    await a.execute('focus.checkpoint', {agent: 'main', checks: json([met('c1', [ids.read])])});
  });
  fx.agent.approver = async () => ({allow: true});
  await fx.agent.send('Write y');
  assert.equal(ids.write, undefined); assert.match(ids.read, /^e\d+$/);
});

test('the transcript keeps a trimmed Focus record, not the whole evidence log', async t => {
  const fx = await harness(t, async a => {
    await a.execute('focus.plan', {agent: 'main', criteria: json(plan)});
    let last;
    for (let i = 0; i < 60; i++) last = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'r' + i);
    await a.execute('focus.checkpoint', {agent: 'main', checks: json([met('c1', [last.payload.muser_evidence_id])])});
  });
  await fx.agent.send('Read a lot');
  const turn = sessions.transcript(fx.agent.session.id).slice(-1)[0];
  assert.ok(turn.focus.evidence.length <= 40, 'was every entry, up to 300 per round');
});

test('the Focus time limit never cuts a round short, not even a plain answer; an unfinished task then continues in a new leg', async t => {
  const plain = await harness(t, async () => { await new Promise(r => setTimeout(r, 300)); });
  const answer = await plain.agent.send('Explain this codebase in depth', {timeoutMs: 100});
  assert.equal(answer.text, 'reply 1', 'was aborted at the limit ("PC の操作を停止しました") with Focus not even active');
  const ends = [];
  const fx = await harness(t, async (a, round) => {
    if (round !== 1) return;
    await a.execute('code.write', {agent: 'main', path: 'z.txt', content: 'z'}, 1000, 'w');
    await a.execute('focus.plan', {agent: 'main', criteria: json(plan)});
    await new Promise(r => setTimeout(r, 300));
  });
  fx.agent.approver = async () => ({allow: true});
  fx.agent.on('turn-end', e => ends.push(e));
  const slow = await fx.agent.send('Slow task', {timeoutMs: 100});
  // The limit still never cuts the round itself (ends[0] is its completed turn-end).
  // What changed since: the unfinished task no longer ENDS at the limit — a new leg
  // starts by itself (afterFocus). This harness does no work on round 2, so that leg
  // parks as a side-question leg, open for the next message.
  assert.equal(fx.sends.length, 2, 'the limit leg, then one automatic continuation leg');
  assert.equal(slow.focus.status, 'needs_input'); assert.equal(ends[0].ok, true);
  assert.ok(fx.agent.resumeFocus, 'the next message picks the task up');
});

test('focus.ask_user makes muser wait for the answer instead of sending "continue"', async t => {
  const fx = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('code.write', {agent: 'main', path: 'q.txt', content: 'q'}, 1000, 'w');
      assert.equal((await a.execute('focus.ask_user', {agent: 'main', question: 'Blue or green?'})).ok, true);
    } else {
      await a.execute('focus.plan', {agent: 'main', criteria: json(plan)});
      const r = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'r');
      await a.execute('focus.checkpoint', {agent: 'main', checks: json([met('c1', [r.payload.muser_evidence_id])])});
    }
  });
  fx.agent.approver = async () => ({allow: true});
  const first = await fx.agent.send('Make the button nicer');
  assert.equal(fx.sends.length, 1, 'was a continuation round pushing Muse past its own question');
  assert.equal(first.focus.status, 'needs_input'); assert.match(first.focus.reason, /Blue or green\?/);
  const second = await fx.agent.send('Green');
  assert.equal(second.focus.id, first.focus.id, 'the answer resumes the same task');
  assert.equal(second.focus.status, 'complete');
});

test('controller: a delivered steer does not stop auto-continuation, a queued message does', async t => {
  const fx = await harness(t, async () => {});
  const {agent, ctrl} = fx;
  agent.emit('steer', {texts: ['wait, also do X']});
  assert.equal(agent.focusInputPending, false, 'delivered inside a tool result: Muse has it, the task goes on');
  ctrl.queue.push('later'); ctrl.set({queue: ['later']});
  agent.emit('steer', {texts: ['wait, also do X']});
  assert.equal(agent.focusInputPending, true, 'a message still waiting in the queue stops the task after its round');
  ctrl.queue.length = 0; ctrl.set({queue: []});
  agent.emit('turn-end', {ok: true, text: ''});
  assert.equal(agent.focusInputPending, false, 'cleared once that task ended, so an automatic send is not stopped by it');
  let seen;
  const fx2 = await harness(t, async a => { seen ??= a.focusInputPending; });
  fx2.ctrl.queue.push('second'); fx2.ctrl.set({queue: ['second']});
  await fx2.ctrl.submit('first');
  assert.equal(seen, true, 'a message still waiting in the queue stops this send after its round');
  clearTimeout(ctrl.flashTimer); clearTimeout(fx2.ctrl.flashTimer);
});

test('controller: /focus off drops the unfinished task so a later message does not resume it', async t => {
  const {agent, ctrl} = await harness(t, async () => {});
  agent.resumeFocus = {focus: new Focus('old'), sessionId: agent.session.id};
  ctrl.slash('/focus off');
  assert.equal(agent.resumeFocus, null);
  ctrl.slash('/focus on');
});
