'use strict';
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
const check = (status, evidence = [], reason = status) => [{id: 'c1', status, evidence, reason}];
const read = {command: 'code.read', kind: 'read', params: {path: 'probe.txt'}, summary: 'probe.txt'};
const command = cmd => ({command: 'system.run', kind: 'exec', params: {command: cmd}, summary: cmd});
const result = exit_code => ({ok: true, payload: {exit_code}});

test('automatic Focus leaves a simple question or single read alone', () => {
  for (const reads of [0, 1]) {
    const focus = new Focus('What is this file?'); focus.beginRound();
    for (let i = 0; i < reads; i++) focus.observe(read, {ok: true});
    assert.equal(focus.endRound().status, 'inactive');
  }
});

test('a question answered with several reads and searches is not turned into a task', () => {
  const focus = new Focus('Where is this function called?'); focus.beginRound();
  focus.observe({command: 'code.grep', kind: 'search', params: {path: 'src'}, summary: 'grep'}, {ok: true});
  focus.observe({command: 'code.glob', kind: 'search', params: {path: 'src'}, summary: 'glob'}, {ok: true});
  focus.observe(read, {ok: true}); focus.observe(command('git log -5'), result(0));
  assert.equal(focus.endRound().status, 'inactive');
  const edit = new Focus('Fix it'); edit.beginRound();
  edit.observe({command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true});
  assert.equal(edit.endRound().continue, true, 'a change still starts completion tracking');
});

test('two command criteria (build + publish) can both be current; other commands still expire evidence', () => {
  const focus = new Focus('Single-file exe'); focus.beginRound();
  focus.plan([{text: 'Builds', kind: 'command', command: 'dotnet build'}, {text: 'Publishes', kind: 'command', command: 'dotnet publish -c Release'},
    {text: 'Publish folder holds one file', kind: 'inspection'}]);
  const build = focus.observe(command('dotnet build'), result(0)), publish = focus.observe(command('dotnet publish -c Release'), result(0));
  const glob = focus.observe({command: 'code.glob', kind: 'search', params: {path: 'publish'}, summary: 'publish'}, {ok: true});
  const all = [{id: 'c1', status: 'met', evidence: [build], reason: 'ok'}, {id: 'c2', status: 'met', evidence: [publish], reason: 'ok'}, {id: 'c3', status: 'met', evidence: [glob], reason: 'ok'}];
  focus.checkpoint(all);
  assert.equal(focus.endRound().status, 'complete');
  focus.observe(command('dotnet clean'), result(0)); // not a declared check: anything may have changed
  assert.throws(() => focus.checkpoint(all), /current/);
});

test('a resumed task is not pushed on by a follow-up that does no work on it', () => {
  const focus = new Focus('Fix the bug'); focus.beginRound();
  focus.observe({command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true});
  focus.plan([{text: 'Works on the real device', kind: 'manual'}]);
  focus.checkpoint([{id: 'c1', status: 'unknown', reason: 'needs the user'}]);
  assert.equal(focus.endRound().status, 'needs_input');
  focus.resumeLeg(); focus.beginRound(); // "thanks" — no tools, no report
  const idle = focus.endRound();
  assert.equal(idle.continue, false); assert.equal(idle.status, 'needs_input', 'still open for the next message');
  focus.resumeLeg(); focus.beginRound(); // a follow-up that edits again is still tracked
  focus.observe({command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true});
  assert.equal(focus.endRound().continue, true);
});

test('a resumed leg that reaches for the task (a refused re-plan) continues instead of parking', () => {
  const focus = new Focus('Fix the bug'); focus.beginRound();
  focus.observe({command: 'code.edit', kind: 'edit', params: {path: 'a.js'}, summary: 'a.js'}, {ok: true});
  focus.plan([{text: 'Works on the real device', kind: 'manual'}]);
  focus.checkpoint([{id: 'c1', status: 'unknown', reason: 'needs the user'}]);
  assert.equal(focus.endRound().status, 'needs_input');
  focus.resumeLeg(); focus.beginRound(); // the follow-up clarifies the task; Muse reaches for it
  assert.throws(() => focus.plan([{text: 'A different task', kind: 'inspection'}]), /fixed/);
  assert.equal(focus.endRound().continue, true, 'an attempted re-plan is engagement with the task, not a side question');
});

test('original goal and criteria cannot be weakened; snapshots do not mutate live state', () => {
  const focus = new Focus('Keep my exact goal');
  assert.throws(() => { focus.goal = 'easier goal'; }, TypeError);
  focus.plan(plan); focus.plan(plan); // repeat is idempotent
  assert.throws(() => focus.plan([{text: 'Different goal', kind: 'inspection'}]), /fixed/);
  focus.snapshot().criteria[0].text = 'changed';
  assert.equal(focus.criteria[0].text, plan[0].text);
});

test('criteria may be appended when the user clarifies, never removed or changed', () => {
  const focus = new Focus('Task'); focus.beginRound(); focus.plan(plan);
  const proof = focus.observe(read, {ok: true}); focus.checkpoint(check('met', [proof]));
  focus.plan([...plan, {text: 'The follow-up the user just asked for', kind: 'inspection'}]);
  assert.equal(focus.criteria.length, 2);
  assert.equal(focus.criteria[0].status, 'met', 'appending does not disturb a verified criterion');
  assert.equal(focus.criteria[1].id, 'c2'); assert.equal(focus.criteria[1].status, 'pending');
  assert.throws(() => focus.plan([{text: 'Different goal', kind: 'inspection'}, {text: 'The follow-up the user just asked for', kind: 'inspection'}]), /fixed/);
  assert.throws(() => focus.plan(plan), /fixed/, 'dropping the appended criterion is a removal');
  assert.equal(focus.endRound().continue, true, 'the appended criterion keeps the task open');
});

test('claims require real successful current verification evidence, not edits or a fabricated ID', () => {
  const focus = new Focus('Verify'); focus.beginRound(); focus.plan(plan);
  for (const refs of [[], ['invented']]) assert.throws(() => focus.checkpoint(check('met', refs)), /evidence/);
  const edit = focus.observe({command: 'code.write', kind: 'edit'}, {ok: true});
  assert.throws(() => focus.checkpoint(check('met', [edit])), /evidence/);
  const proof = focus.observe(read, {ok: true}); focus.checkpoint(check('met', [proof]));
  assert.equal(focus.endRound().status, 'complete');
});

test('command checks reject failed/background/unrelated commands and reruns invalidate an old pass', () => {
  const focus = new Focus('Tests'); focus.beginRound(); focus.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}]);
  const failed = focus.observe(command('npm test'), result(1));
  const unrelated = focus.observe(command('npm --version'), result(0));
  const background = focus.observe(command('npm test'), {ok: true, payload: {shell_id: 'bg1', exit_code: 0}});
  for (const ref of [failed, unrelated, background]) assert.throws(() => focus.checkpoint(check('met', [ref])), /evidence|command/);
  const passed = focus.observe(command('npm test'), result(0)); focus.checkpoint(check('met', [passed]));
  focus.observe(command('npm test'), result(1));
  assert.equal(focus.criteria[0].status, 'pending');
  assert.equal(focus.endRound().continue, true);
});

test('changes after verification invalidate evidence; manual checks stop for user confirmation', () => {
  const focus = new Focus('Verify'); focus.beginRound(); focus.plan(plan);
  const proof = focus.observe(read, {ok: true}); focus.checkpoint(check('met', [proof]));
  focus.observe({command: 'code.edit', kind: 'edit'}, {ok: true});
  assert.equal(focus.criteria[0].status, 'pending');
  assert.throws(() => focus.checkpoint(check('met', [proof])), /current/);
  const manual = new Focus('Check headset'); manual.beginRound(); manual.plan([{text: 'Visible in the headset', kind: 'manual'}]);
  assert.throws(() => manual.checkpoint(check('met', [proof])), /user confirmation/);
  manual.checkpoint(check('unknown', [], 'Please check the actual headset.'));
  assert.equal(manual.endRound().status, 'needs_input');
});

test('unmet work continues, unchanged failure stops, and the round cap cannot imply success', () => {
  const focus = new Focus('Task'); focus.beginRound(); focus.plan(plan); focus.checkpoint(check('unmet'));
  assert.equal(focus.endRound().continue, true);
  focus.beginRound(); focus.checkpoint(check('unmet'));
  assert.equal(focus.endRound().status, 'stalled');
  const capped = new Focus('Task', {maxRounds: 1, automatic: false}); capped.beginRound();
  assert.equal(capped.endRound().status, 'limit');
  const workers = new Focus('Task'); workers.beginRound(); workers.plan(plan);
  const proof = workers.observe(read, {ok: true}); workers.checkpoint(check('met', [proof]));
  assert.equal(workers.endRound({workersPending: true}).continue, true);
  const queued = new Focus('Task'); queued.beginRound(); queued.plan(plan); queued.checkpoint(check('unmet'));
  assert.equal(queued.endRound({pendingUserInput: true}).status, 'needs_input');
  assert.equal(queued.awaitingInput, true, 'the stop is marked as waiting for the user, so the next message can resume this task');
});

test('waiting on task agents is neither stalled nor over the round limit', () => {
  const capped = new Focus('Task', {maxRounds: 1}); capped.beginRound(); capped.plan(plan); capped.checkpoint(check('unmet'));
  for (let i = 0; i < 3; i++) { assert.equal(capped.endRound({workersPending: true}).continue, true, 'a waiting round continues'); capped.beginRound(); }
  assert.equal(capped.stalled, 0, 'waiting rounds never count as stalled');
  assert.equal(capped.endRound().status, 'limit', 'once the agents are done the round cap applies again');
  const g = new Focus('Task'); g.beginRound(); g.plan(plan); g.checkpoint(check('unmet'));
  g.endRound({workersPending: true}); g.beginRound();
  assert.equal(g.endRound().continue, true, 'the first non-waiting round is not stalled yet');
  g.beginRound();
  assert.equal(g.endRound().status, 'stalled', 'the second unchanged round stalls as usual');
});

async function harness(t, work) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focus-test-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true})); fs.writeFileSync(path.join(cwd, 'probe.txt'), 'probe');
  const client = new EventEmitter(), events = [], sends = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() { this.cancelled = true; }, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)}); agent.subscribed = true;
  t.after(() => agent.close());
  let inFlight = false;
  agent.device = {connected: true, disconnect() {}, async send(body, sessionId) {
    const round = sends.length + 1, id = 'user-' + round; sends.push({body, sessionId}); client.taskStatus = 'running';
    events.push({role: 'user', message_id: id, content: body, seq: round * 2});
    // A send while a round is in flight is a post into the live conversation (postSteer):
    // it lands as a user message and starts no round of its own.
    if (inFlight) return {message_id: id};
    inFlight = true;
    setImmediate(async () => {
      try {
        await work(agent, round);
        if (agent.main.turn?.controller.signal.aborted) return;
        const done = {event: 'delta.message_done', seq: round * 2 + 1, payload: {session_id: sessionId, message_id: 'reply-' + round, role: 'assistant', text: 'reply ' + round, status: 'completed'}};
        events.push(done); client.taskStatus = 'completed'; inFlight = false; client.emit('event', done);
      } catch (e) { client.taskStatus = 'failed'; inFlight = false; client.emit('event', {event: 'task.status', session_id: sessionId, payload: {status: 'failed'}}); }
    });
    return {message_id: id};
  }};
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
  return {agent, ctrl, sends, client};
}

test('normal send automatically continues in the same session, keeps UI busy and persists the original goal', async t => {
  let ctrl;
  const fixture = await harness(t, async (agent, round) => {
    if (round === 2) assert.equal(ctrl.get().busy, true, 'intermediate reply did not finish the UI turn');
    if (round === 2) assert.equal(agent.spawnedThisTurn, 1, 'the per-task spawn budget survives continuation');
    if (round === 1) agent.spawnedThisTurn = 1;
    assert.equal((await agent.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)})).ok, true);
    const readResult = await agent.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-' + round);
    assert.equal(readResult.ok, true);
    assert.equal((await agent.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check(round === 1 ? 'unmet' : 'met', [readResult.payload.muser_evidence_id]))})).ok, true);
  });
  ({ctrl} = fixture); const {agent, sends} = fixture;
  ctrl.set({busy: true}); let ends = 0; agent.on('turn-end', () => { ends++; });
  const answer = await agent.send('Original task wording');
  assert.equal(answer.focus.status, 'complete'); assert.equal(answer.focus.round, 2);
  assert.equal(sends.length, 2); assert.equal(new Set(sends.map(s => s.sessionId)).size, 1);
  assert.ok(sends[1].body.includes('Original task wording'));
  assert.equal(ends, 1); assert.equal(ctrl.get().busy, false);
  assert.equal(agent.focusRun, null);
  const turns = sessions.transcript(agent.session.id);
  assert.equal(turns.length, 2); assert.equal(turns[1].focus.goal, 'Original task wording');
  assert.equal(turns[1].focus.status, 'complete');
  // The compact Focus line now precedes the end line, so the reply text stays the turn's last
  // substantial block (the full panel is /focus's).
  assert.equal(ctrl.get().entries.at(-2).type, 'focus');
  assert.equal(ctrl.get().entries.at(-1).type, 'end');
});

test('a user send does not end at the round limit: the next leg starts by itself and the turn ends complete', async t => {
  const fixture = await harness(t, async (a, round) => {
    if (round <= 3) { // three rounds of real progress, criterion still unmet: the leg hits its round cap
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('code.write', {agent: 'main', path: 'work.txt', content: 'step ' + round}, 1000, 'write-' + round);
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
    } else {
      const readResult = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-final');
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [readResult.payload.muser_evidence_id]))});
    }
  });
  fixture.agent.approver = async () => ({allow: true}); // the rounds write files
  let ends = 0; fixture.agent.on('turn-end', () => { ends++; });
  const answer = await fixture.agent.send('Long task');
  assert.equal(answer.focus.status, 'complete');
  assert.equal(fixture.sends.length, 4, 'three capped rounds, then one automatic leg round — no user message in between');
  assert.ok(fixture.sends[3].body.includes('automatic continuation'));
  assert.equal(ends, 1, 'one turn-end for the whole user turn, however many legs it took (audit #29: per-leg turn-ends double-counted the queue continuation, the daily tally and usage; direct sendFocused calls — /goal legs — still close their own run)');
  clearTimeout(fixture.ctrl.flashTimer);
});

test('a user send does not end when a leg stalls either: a fresh leg starts and can complete it', async t => {
  const fixture = await harness(t, async (a, round) => {
    if (round <= 2) { // two identical unmet reports, no progress: the leg stalls
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
    } else {
      const readResult = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-stall-final');
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [readResult.payload.muser_evidence_id]))});
    }
  });
  const answer = await fixture.agent.send('Stubborn task');
  assert.equal(answer.focus.status, 'complete');
  assert.equal(fixture.sends.length, 3, 'two stalled rounds, then one automatic leg round');
  assert.ok(fixture.sends[2].body.includes('automatic continuation'));
  clearTimeout(fixture.ctrl.flashTimer);
});

test('a simple question does not create another turn, and Focus can be turned off', async t => {
  const {agent, sends, ctrl} = await harness(t, async () => {});
  const answer = await agent.send('Hello'); assert.equal(answer.focus, undefined); assert.equal(sends.length, 1);
  ctrl.slash('/focus off'); assert.equal(agent.focusEnabled, false);
  const second = await agent.send('Hello again'); assert.equal(second.focus, undefined); assert.equal(sends.length, 2);
  ctrl.slash('/focus on'); assert.equal(agent.focusEnabled, true);
});

test('declined actions stop automatic continuation without touching files', async t => {
  const {agent, sends} = await harness(t, async a => {
    a.approver = async () => ({allow: false});
    await a.execute('code.write', {agent: 'main', path: 'new.txt', content: 'not authorized'}, 1000, 'declined');
  });
  const answer = await agent.send('Write a file');
  assert.equal(answer.focus.status, 'needs_input'); assert.equal(sends.length, 1);
  assert.equal(fs.existsSync(path.join(agent.cwd, 'new.txt')), false);
});

test('a correction sent mid-turn is posted as a chat message and does not stop the task', async t => {
  // Delivered, Muse has it and answers it inside the work (2026-11-03: it used to end the
  // turn as "a new user message is queued" though nothing was waiting any more).
  const fixture = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
      await fixture.ctrl.submit('New clarification');
    } else if (round === 3) {
      const readResult = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-after-correction');
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [readResult.payload.muser_evidence_id]))});
    }
  });
  fixture.ctrl.set({busy: true});
  const answer = await fixture.agent.send('Original request');
  assert.ok(fixture.sends[1].body.includes('New clarification'));
  assert.deepEqual(fixture.ctrl.get().queue, [], 'posted, not queued for a second send');
  assert.equal(answer.focus.status, 'complete', 'Focus went on past the delivered correction');
  assert.equal(fixture.sends.length, 3, 'the original send, the posted correction, one continuation round');
  clearTimeout(fixture.ctrl.flashTimer);
});

test('a follow-up message resumes the task that stopped for it, criteria intact', async t => {
  const fixture = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
      await a.execute('focus.ask_user', {agent: 'main', question: 'Which file?'});
    } else if (round === 2) {
      // The resumed leg: no re-plan — the criteria are still there to checkpoint against.
      const readResult = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-resume');
      assert.equal((await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [readResult.payload.muser_evidence_id]))})).ok, true);
    }
  });
  const first = await fixture.agent.send('Original request');
  assert.equal(first.focus.status, 'needs_input');
  const second = await fixture.agent.send('Continue with that clarification');
  assert.equal(second.focus.id, first.focus.id, 'the follow-up resumed the same Focus task');
  assert.equal(second.focus.goal, 'Original request', 'the goal is the original request, not the follow-up wording');
  assert.equal(second.focus.status, 'complete');
  assert.equal(fixture.sends.length, 2, 'original send and the follow-up');
});

test('a task stopped at its round limit is resumed by the next send, not replaced', async t => {
  const fixture = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
    } else if (round === 2) {
      const readResult = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-limit-resume');
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [readResult.payload.muser_evidence_id]))});
    }
  });
  const first = await fixture.agent.sendFocused('Long task', {maxRounds: 1});
  assert.equal(first.focus.status, 'limit');
  const second = await fixture.agent.sendFocused('go', {maxRounds: 1});
  assert.equal(second.focus.id, first.focus.id, '"go" resumed the limited task instead of becoming its own task');
  assert.equal(second.focus.goal, 'Long task');
  assert.equal(second.focus.status, 'complete');
});

test('interrupt cancels the logical task and prevents another round', async t => {
  let agentRef;
  const {agent, sends, client} = await harness(t, async a => {
    await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
    await agentRef.interrupt();
  });
  agentRef = agent;
  await assert.rejects(agent.send('Work until done'), e => e.name === 'AbortError');
  assert.equal(client.cancelled, true); assert.equal(sends.length, 1);
  assert.equal(agent.focusRun, null); assert.equal(agent.lastFocus.status, 'stopped');
});

test('path-tied evidence survives an unrelated edit, but not an edit to what it covers', () => {
  const focus = new Focus('Verify'); focus.beginRound(); focus.plan(plan);
  const proof = focus.observe(read, {ok: true}); // covers probe.txt
  focus.observe({command: 'code.edit', kind: 'edit', params: {path: 'other.txt'}}, {ok: true});
  focus.checkpoint(check('met', [proof])); // still current: the edit touched another file
  assert.equal(focus.criteria[0].status, 'met');
  focus.observe({command: 'code.edit', kind: 'edit', params: {path: 'probe.txt'}}, {ok: true});
  assert.equal(focus.criteria[0].status, 'pending'); // reset: the file it covers changed
  assert.throws(() => focus.checkpoint(check('met', [proof])), /evidence/);
});

test('a change of unknown scope still expires path-tied evidence; system.run evidence stays strict', () => {
  const focus = new Focus('Verify'); focus.beginRound(); focus.plan(plan);
  const proof = focus.observe(read, {ok: true});
  focus.observe(command('Set-Content other.txt x'), result(0)); // a shell write: its scope is unknowable
  assert.throws(() => focus.checkpoint(check('met', [proof])), /evidence/);
  const focus2 = new Focus('Tests'); focus2.beginRound();
  focus2.plan([{text: 'Tests pass', kind: 'command', command: 'npm test'}]);
  const passed = focus2.observe(command('npm test'), result(0));
  focus2.observe({command: 'code.edit', kind: 'edit', params: {path: 'other.txt'}}, {ok: true});
  assert.throws(() => focus2.checkpoint(check('met', [passed])), /evidence/); // command evidence expires on ANY later change
});

// A task agent registered the way spawn() registers it: focusTask set, a live turn.
function fakeWorker(a) {
  const w = {tag: 'aTest', main: false, focusTask: a.main.turn.focus, spawnedIn: a.main.turn, turn: {controller: new AbortController()}, starting: false, state: 'working', result: '', session: {id: 'worker-session'}, snapshot() { return {tag: this.tag, state: this.state}; }};
  a.workers.set('aTest', w);
  return w;
}

test('a run that ends at its round limit does not stop the task agents it spawned', async t => {
  const stopped = [];
  let worker;
  const fixture = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
      worker = fakeWorker(a);
      a.stopAgent = async tag => { stopped.push(tag); };
    } else if (round === 2) {
      worker.turn = null; worker.state = 'done'; worker.result = 'worker result';
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
    }
  });
  const answer = await fixture.agent.sendFocused('Long task', {maxRounds: 1});
  assert.equal(answer.focus.status, 'limit');
  assert.deepEqual(stopped, [], 'ending at the limit must not stop the task agents');
  assert.equal(fixture.agent.workers.get('aTest'), worker, 'the worker stays registered, result ready for a later agent.wait');
  assert.equal(worker.result, 'worker result');
});

test('the Focus time limit does not bite while task agents are still running', async t => {
  let worker;
  const fixture = await harness(t, async (a, round) => {
    if (round === 1) {
      await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
      worker = fakeWorker(a);
    } else if (round === 2) {
      worker.turn = null; worker.state = 'done'; worker.result = 'worker result';
      const readResult = await a.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-time-limit');
      await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('met', [readResult.payload.muser_evidence_id]))});
    }
  });
  const answer = await fixture.agent.sendFocused('Long task', {maxRounds: 5, timeoutMs: 1});
  assert.equal(answer.focus.status, 'complete', 'the round spent waiting on the agent did not consume the time limit');
});

test('a task that spends its time budget on its own work stops at the time limit (t3 #3)', async t => {
  // The firing path of the timeoutMs check: above, agent-waiting is excluded
  // and never fires it; here the round's own work (no worker to wait on)
  // consumes the budget, so the loop must stop with status 'limit'.
  const fixture = await harness(t, async a => {
    await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
    await a.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check('unmet'))});
    await new Promise(r => setTimeout(r, 30));
  });
  const answer = await fixture.agent.sendFocused('Long task', {maxRounds: 5, timeoutMs: 5});
  assert.equal(answer.focus.status, 'limit');
  assert.match(answer.focus.reason, /Focus time limit/);
  assert.equal(fixture.sends.length, 1, 'no continuation round was sent after the limit');
});

test('Esc (interrupt) still stops the task agents — it is the explicit stop', async t => {
  const stopped = [];
  const fixture = await harness(t, async a => {
    await a.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
    fakeWorker(a);
    a.stopAgent = async tag => { stopped.push(tag); };
    await a.interrupt();
  });
  await assert.rejects(fixture.agent.send('Work until done'), e => e.name === 'AbortError');
  assert.deepEqual(stopped, ['aTest'], 'interrupt stops the agents it owns');
});

test('askUser with options: normalised into the snapshot, survives endRound as needs_input', () => {
  const focus = new Focus('Pick a cat'); focus.beginRound(); focus.plan(plan);
  const snap = focus.askUser('Which cat?', {options: [{label: '黒猫', description: '定番', preview: '/_/\n( o.o )'}, {label: '三毛猫'}]});
  assert.equal(snap.ask.questions.length, 1);
  const q = snap.ask.questions[0];
  assert.equal(q.question, 'Which cat?');
  assert.equal(q.multi, false);
  assert.equal(q.header, 'Which cat?');
  assert.deepEqual(q.options[0], {label: '黒猫', description: '定番', preview: '/_/\n( o.o )'});
  assert.deepEqual(q.options[1], {label: '三毛猫', description: null, preview: null});
  const stop = focus.endRound();
  assert.equal(stop.status, 'needs_input');
  const after = focus.snapshot();
  assert.equal(after.ask.questions[0].options.length, 2, 'the picker data is still there after the round ends');
  focus.resumeLeg('Black');
  assert.equal(focus.snapshot().ask, null, 'a resumed leg drops the answered question');
});

test('askUser: questions form (JSON string) wins, multi is honoured, bad shapes throw', () => {
  const focus = new Focus('Two questions'); focus.beginRound(); focus.plan(plan);
  const snap = focus.askUser('ignored?', {questions: JSON.stringify([
    {header: '色', question: '色は？', options: [{label: '青'}, {label: '緑'}]},
    {header: '付け合わせ', question: '付け合わせは？', multi: true, options: [{label: 'A'}, {label: 'B'}, {label: 'C'}]},
  ])});
  assert.equal(snap.ask.questions.length, 2);
  assert.equal(snap.ask.questions[0].header, '色');
  assert.equal(snap.ask.questions[1].multi, true);
  assert.throws(() => focus.askUser('x', {options: [{label: 'only one'}]}), /2 to 6 options/);
  assert.throws(() => focus.askUser('x', {options: [{label: ''}, {label: 'b'}]}), /label/);
  // t3 #2: a failed askUser must not clobber the question already recorded,
  // and the second question's options survive normalisation.
  assert.deepEqual(focus.snapshot().ask.questions.map(q => q.header), ['色', '付け合わせ'], 'the failed calls left the recorded questions untouched');
  assert.deepEqual(snap.ask.questions[1].options.map(o => o.label), ['A', 'B', 'C']);
  // Header fallback: no header given, the tab label is the question's first 16 chars.
  const fb = new Focus('Fallback'); fb.beginRound(); fb.plan(plan);
  const longQ = '1234567890abcdefGHIJ and more';
  assert.equal(fb.askUser(longQ, {options: [{label: 'a'}, {label: 'b'}]}).ask.questions[0].header, longQ.slice(0, 16));
  const plain = new Focus('Plain'); plain.beginRound(); plain.plan(plan);
  assert.equal(plain.askUser('Free text?').ask, null, 'no options: the plain question, as before');
});
