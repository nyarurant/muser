'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// One test below writes ~/.muser/AGENTS.md (the user's instructions for every
// project) in-process and deletes it afterwards without saving the prior
// content — and src/agent reads homedir-derived config/state dynamically.
// Point every folder at a throwaway one BEFORE loading any src module,
// mirroring tests/accounts.test.js: `npm test` already isolates via
// tests/setup.mjs, but a bare `node --test tests/agent.test.js` skips that
// file and would otherwise clobber the user's real AGENTS.md.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-agent-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-agent-test-home-'));

const {
  Agent, preamble, projectInstructions, routeFor, consumeToolCall, toolLimitMessage,
  resolveMaxToolCallsPerTurn, mcpEffectiveKind, pruneCollectedWorkers, MAX_PROJECT_INSTRUCTION_CHARS,
} = require('../src/agent');

const NOTE = '（プロジェクト指示が長いため一部省略しました）';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-agent-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function stubClient() {
  const c = new EventEmitter();
  c.status = 'connected'; c.ws = {readyState: 1};
  c.history = async () => ({chat_events: []});
  c.request = async () => ({session: {status: 'working'}});
  c.subscribeAgent = async () => {};
  c.closeAgentSubscription = () => {};
  c.cancel = async () => {};
  return c;
}
function makeAgent(t, agentOpts = {}) {
  const cwd = agentOpts.cwd || tmpdir(t);
  const client = stubClient();
  const a = new Agent({
    client,
    auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }},
    cwd,
    session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0},
    ...agentOpts,
  });
  a.subscribed = true; // as bin/muser.js marks it once its startup subscribe is done
  return a;
}
function startTurn(a) {
  a.main.turn = {controller: new AbortController(), baseline: new Set(), messages: new Map(), sources: new Map(), started: Date.now(), toolCalls: 0};
  return a.main.turn;
}
function fakeWorker(tag, over = {}) {
  return {tag, title: tag, by: 'muse', typeName: 'general', type: undefined, state: 'idle', lastTool: '', text: '', result: '', error: '', started: 0, ended: 0, collected: false, turn: null, main: tag === 'main', session: {id: 'sess-' + tag}, ctx: null, ...over};
}

// ---------- preamble / projectInstructions cap ----------

test('projectInstructions caps the TOTAL characters across all files', (t) => {
  const root = tmpdir(t);
  const sub = path.join(root, 'sub'), deep = path.join(sub, 'deep');
  fs.mkdirSync(deep, {recursive: true});
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'A'.repeat(9000));
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'B'.repeat(9000));
  fs.writeFileSync(path.join(deep, 'AGENTS.md'), 'C'.repeat(9000));
  const found = projectInstructions(deep);
  const total = found.reduce((n, e) => n + e.text.length, 0);
  // Ancestor files above the temp dir may add entries, but the cap is over the total.
  assert.ok(total <= MAX_PROJECT_INSTRUCTION_CHARS, 'total ' + total + ' exceeds cap ' + MAX_PROJECT_INSTRUCTION_CHARS);
  assert.equal(found.filter(e => e.text.includes(NOTE)).length, 1, 'exactly the truncated file carries the note');
  // The nearest file (the project's own, most specific) is kept whole; an outer one is cut.
  // Before, the budget went outermost-first and cut the project's own file.
  assert.equal(found[found.length - 1].file, path.join(deep, 'AGENTS.md'), 'listed last: general before specific');
  assert.equal(found[found.length - 1].text, 'C'.repeat(9000), "the project's own file is whole");
  assert.ok(found[0].text.includes(NOTE), 'the outermost included file carries the note');
});

test('projectInstructions leaves small instruction sets untouched', (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'be kind\n');
  const mine = projectInstructions(dir).filter(e => e.file.startsWith(dir));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, 'be kind\n');
});

test('preamble bans embedded widgets and carries the capped instructions', (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'X'.repeat(9000));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Y'.repeat(9000));
  fs.writeFileSync(path.join(dir, 'MUSE.md'), 'Z'.repeat(9000));
  const text = preamble(dir, []);
  assert.ok(text.includes('This terminal cannot render embedded widgets'));
  assert.ok(text.includes('[[hatch_widget:...]]'));
  assert.ok(text.includes('Present choices as plain numbered text lists.'));
});

// ---------- route() tag rules ----------

test('route: an explicit tag for an idle or unknown worker is refused, never falls through', (t) => {
  const a = makeAgent(t);
  const idle = fakeWorker('a1');
  const busy = fakeWorker('a2', {turn: {controller: new AbortController()}});
  a.workers.set('a1', idle); a.workers.set('a2', busy);
  assert.equal(a.route({agent: 'a1'}), null, 'existing worker without an active turn');
  assert.equal(a.route({agent: 'nope'}), null, 'unknown tag');
  assert.equal(a.route({agent: 'a2'}), busy, 'tagged worker with an active turn');
  assert.equal(a.route({agent: ' a2 '}), busy, 'tag is trimmed');
});

test('route: no-tag goes to the single active worker, else to main (main omits its tag); never guessed onto an agent', (t) => {
  const a = makeAgent(t);
  const w = fakeWorker('a1', {turn: {controller: new AbortController()}});
  a.workers.set('a1', w);
  assert.equal(a.route({}), w, 'the only active worker');
  assert.equal(a.route(), w);
  startTurn(a);
  assert.equal(a.route({}), a.main, 'main + an agent working: an untagged call is main\'s');
  a.main.turn = null; w.turn = null;
  assert.equal(a.route({}), null, 'nobody working');
  assert.equal(routeFor(a.workers, {agent: 'a1'}), null);
  w.turn = {controller: new AbortController()};
  assert.equal(routeFor([...a.workers.values()], {}), w, 'routeFor also accepts an array');
});

// ---------- per-turn tool budget ----------

test('tool budget: consumeToolCall counts on the turn and reports only the excess call', () => {
  const turn = {toolCalls: 0};
  assert.equal(consumeToolCall(turn, 2), false);
  assert.equal(consumeToolCall(turn, 2), false);
  assert.equal(turn.toolCalls, 2);
  assert.equal(consumeToolCall(turn, 2), true, 'the third call exceeds a limit of 2');
  assert.equal(consumeToolCall(null, 2), false, 'no turn, no budget');
  assert.equal(toolLimitMessage(2), 'ツール呼び出しの上限（2回/ターン）に達しました。作業をまとめて最終返信をしてください。');
  assert.equal(resolveMaxToolCallsPerTurn(5, '9'), 5, 'constructor option wins');
  assert.equal(resolveMaxToolCallsPerTurn(undefined, '9'), 9, 'env value next');
  assert.equal(resolveMaxToolCallsPerTurn(undefined, 'abc'), 250, 'garbage env falls back to 250');
  assert.equal(resolveMaxToolCallsPerTurn(0, '0'), 250);
});

test('tool budget: constructor option, env var, and the 250 default', (t) => {
  assert.equal(makeAgent(t, {maxToolCallsPerTurn: 3}).maxToolCallsPerTurn, 3);
  const saved = process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
  try {
    process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = '7';
    assert.equal(makeAgent(t).maxToolCallsPerTurn, 7);
    delete process.env.MUSER_MAX_TOOL_CALLS_PER_TURN;
    assert.equal(makeAgent(t).maxToolCallsPerTurn, 250);
  } finally { if (saved === undefined) delete process.env.MUSER_MAX_TOOL_CALLS_PER_TURN; else process.env.MUSER_MAX_TOOL_CALLS_PER_TURN = saved; }
});

test('execute refuses the call that exceeds the per-turn budget without running the tool', async (t) => {
  const a = makeAgent(t);
  a.maxToolCallsPerTurn = 1;
  const turn = startTurn(a); turn.toolCalls = 1;
  fs.writeFileSync(path.join(a.cwd, 'f.txt'), 'data\n');
  const r = await a.execute('code.read', {path: 'f.txt'}, 1000, 'inv-budget');
  assert.equal(r.ok, false);
  assert.equal(r.error, toolLimitMessage(1));
  assert.equal(a.ctx.readFiles.size, 0, 'the tool never ran');
});

test('a message sent mid-turn rides the next tool result to Muse, once', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  fs.writeFileSync(path.join(a.cwd, 'f.txt'), 'data\n');
  const delivered = [];
  a.on('steer', ({texts}) => delivered.push(texts));
  a.queueSteer('change of plan: do Y instead');
  a.queueSteer('and skip the tests');
  const r = await a.execute('code.read', {path: 'f.txt'}, 1000, 'inv-steer-1');
  assert.equal(r.ok, true);
  assert.match(r.payload.user_message, /while you were working/);
  assert.match(r.payload.user_message, /change of plan: do Y instead/);
  assert.match(r.payload.user_message, /and skip the tests/);
  assert.deepEqual(delivered, [['change of plan: do Y instead', 'and skip the tests']]);
  assert.equal(a.steerQueue.length, 0, 'consumed by the delivery');
  const r2 = await a.execute('code.read', {path: 'f.txt'}, 1000, 'inv-steer-2');
  assert.equal(r2.payload.user_message, undefined, 'not delivered twice');
  a.queueSteer('dropped again');
  a.dropSteer('dropped again');
  const r3 = await a.execute('code.read', {path: 'f.txt'}, 1000, 'inv-steer-3');
  assert.equal(r3.payload.user_message, undefined, 'a dropped steer never rides');
});

test('postSteer sends a mid-turn message as a real chat message', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  a.main.session = {id: 'sess-1', turns: 1};
  const sent = [];
  a.device = {send: async (body, id) => { sent.push([body, id]); return {message_id: 'm-2'}; }};
  assert.equal(await a.postSteer('one more thing'), true);
  assert.deepEqual(sent, [['one more thing', 'sess-1']], 'posted verbatim to the live session');
  a.device = {send: async () => { throw new Error('busy'); }};
  assert.equal(await a.postSteer('again'), false, 'a failed send reports false, so the caller falls back');
  a.main.turn = null;
  assert.equal(await a.postSteer('too late'), false, 'no live turn, no post');
});

// ---------- approval preview ----------

test('execute attaches the tool preview to the call BEFORE the approver sees it', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  let seen = null;
  a.approver = async (call) => { seen = call; return {allow: true}; };
  const r = await a.execute('code.write', {path: 'out.txt', content: 'hello\n'}, 1000, 'inv-preview');
  assert.equal(r.ok, true);
  assert.ok(seen, 'approver was asked (default mode asks for edits)');
  assert.ok(seen.preview, 'the call the approver received already carries a preview');
  assert.equal(seen.preview.created, true);
  assert.ok('diff' in seen.preview);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'out.txt'), 'utf8'), 'hello\n');
});

test('a throwing preview does not break execution', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  let seen = null;
  a.approver = async (call) => { seen = call; return {allow: true}; };
  // code.edit on a file that was never read: its preview throws (computeEdit refuses),
  // and so does the run itself — the point is execute still flows through ask/run/toolEnd.
  fs.writeFileSync(path.join(a.cwd, 'e.txt'), 'old\n');
  const r = await a.execute('code.edit', {path: 'e.txt', old_string: 'old', new_string: 'new'}, 1000, 'inv-bad-preview');
  assert.equal(r.ok, false);
  assert.ok(seen, 'the approver was still asked');
  assert.equal(seen.preview, undefined, 'the failed preview is simply absent');
});

// ---------- MCP readOnly trust ----------

test('mcpEffectiveKind only trusts readOnly when the server config says trustReadOnly', () => {
  const tool = {server: 'srv', tool: 'look', readOnly: true};
  assert.equal(mcpEffectiveKind(null, tool), 'mcp');
  assert.equal(mcpEffectiveKind({config: {mcpServers: {srv: {}}}}, tool), 'mcp');
  assert.equal(mcpEffectiveKind({config: {mcpServers: {srv: {trustReadOnly: true}}}}, tool), 'read');
  assert.equal(mcpEffectiveKind({config: {mcpServers: {srv: {trustReadOnly: true}}}}, {...tool, readOnly: false}), 'mcp');
});

test('executeMcp: untrusted readOnly annotation is denied in plan mode, trusted runs', async (t) => {
  const make = (trusted) => {
    const calls = [];
    return {calls, hub: {
      commands: new Map([['mcp.srv.look', {server: 'srv', tool: 'look', readOnly: true}]]),
      config: {mcpServers: {srv: trusted ? {trustReadOnly: true} : {}}},
      call: async (cmd) => { calls.push(cmd); return {text: 'mcp-result', isError: false}; },
    }};
  };
  const untrusted = make(false);
  const a1 = makeAgent(t, {mode: 'plan', mcp: untrusted.hub});
  startTurn(a1);
  const r1 = await a1.execute('mcp.srv.look', {}, 1000, 'inv-mcp-1');
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Not allowed in plan mode/);
  assert.equal(untrusted.calls.length, 0, 'the MCP tool never ran');

  const trusted = make(true);
  const a2 = makeAgent(t, {mode: 'plan', mcp: trusted.hub});
  startTurn(a2);
  const r2 = await a2.execute('mcp.srv.look', {}, 1000, 'inv-mcp-2');
  assert.equal(r2.ok, true);
  assert.equal(r2.payload.result, 'mcp-result');
  assert.equal(trusted.calls.length, 1);
});

// ---------- worker collection / pruning & spawn isolation ----------

test('agent.wait marks done workers collected; the next wait prunes them', async (t) => {
  const a = makeAgent(t);
  startTurn(a);
  const done = fakeWorker('a7', {state: 'done', result: 'finished-result', ended: Date.now()});
  a.workers.set('a7', done);
  const r1 = await a.executeAgentTool(a.main, 'agent.wait', {timeout_s: 1});
  assert.equal(r1.ok, true);
  assert.ok(r1.payload.agents.some(x => x.tag === 'a7' && x.result === 'finished-result'));
  assert.equal(done.collected, true, 'returning the result marks it collected');
  assert.ok(a.workers.has('a7'), 'pruning happens on the NEXT spawn/wait, not mid-collection');
  const r2 = await a.executeAgentTool(a.main, 'agent.wait', {timeout_s: 1});
  assert.ok(!r2.payload.agents.some(x => x.tag === 'a7'), 'default list is the workers still in the map');
  assert.ok(!a.workers.has('a7'), 'pruned at the start of the wait');
});

test('pruneCollectedWorkers never prunes main or running workers', () => {
  const workers = new Map([
    ['main', fakeWorker('main', {state: 'done', collected: true})],
    ['a1', fakeWorker('a1', {state: 'done', collected: true})],
    ['a2', fakeWorker('a2', {state: 'done', collected: true, turn: {controller: new AbortController()}})],
    ['a3', fakeWorker('a3', {state: 'done', collected: false})],
    ['a4', fakeWorker('a4', {state: 'failed', collected: true})],
  ]);
  pruneCollectedWorkers(workers);
  assert.deepEqual([...workers.keys()].sort(), ['a2', 'a3', 'a4', 'main']);
});

test('spawn prunes collected workers and gives the worker its own readFiles set', async (t) => {
  const a = makeAgent(t);
  a.ctx.readFiles.add('seed-file');
  a.workers.set('a77', fakeWorker('a77', {state: 'done', collected: true}));
  const w = a.spawn('do a small thing', {by: 'muse'});
  assert.ok(!a.workers.has('a77'), 'collected worker pruned by spawn');
  assert.notEqual(w.ctx.readFiles, a.ctx.readFiles, 'not the same Set object');
  assert.ok(w.ctx.readFiles.has('seed-file'), 'seeded with a copy of main\'s reads');
  w.ctx.readFiles.add('worker-only');
  assert.ok(!a.ctx.readFiles.has('worker-only'), 'worker reads do not leak back into main');
  assert.equal(w.ctx.shells, a.shells, 'shells stay shared');
  await new Promise(r => setImmediate(r)); // let the spawned turn fail quietly (no vm in tests)
});

// ---------- runTurn: history failure & cleanup on setup errors ----------

function turnReadyAgent(t) {
  const a = makeAgent(t);
  a.session.turns = 2; // non-first turn: the history baseline matters
  a.device = {connected: true, send: async () => ({message_id: 'm1'})};
  return a;
}

test('runTurn refuses to start a non-first turn when the history fetch fails', async (t) => {
  const a = turnReadyAgent(t);
  a.client.history = async () => { throw new Error('gateway down'); };
  await assert.rejects(a.send('hello'), /履歴の取得に失敗したためターンを開始できませんでした/);
  assert.equal(a.main.turn, null, 'the turn slot is released');
  assert.equal(a.main.state, 'failed');
});

test('runTurn cancels the reply wait and closes the subscription when device.send throws', async (t) => {
  const a = turnReadyAgent(t);
  const closed = [];
  a.client.closeAgentSubscription = (owner) => closed.push(owner);
  a.device.send = async () => { throw new Error('send failed'); };
  await assert.rejects(a.send('hello'), /send failed/);
  assert.equal(closed.length, 1, 'closeAgentSubscription ran on the send-failure path');
  assert.ok(closed[0].startsWith('muser-'));
  assert.equal(a.main.turn, null);
});

test('runTurn cancels the reply wait and closes the subscription when subscribeAgent throws', async (t) => {
  const a = turnReadyAgent(t);
  const closed = [];
  a.client.closeAgentSubscription = (owner) => closed.push(owner);
  a.client.subscribeAgent = async () => { throw new Error('subscribe failed'); };
  await assert.rejects(a.send('hello'), /subscribe failed/);
  assert.equal(closed.length, 1, 'closeAgentSubscription ran on the subscribe-failure path');
  assert.equal(a.main.turn, null);
});

test('~/.muser/AGENTS.md applies in every project, even outside the home folder', (t) => {
  const os = require('node:os');
  const home = os.homedir(), dir = tmpdir(t);
  fs.mkdirSync(path.join(home, '.muser'), {recursive: true});
  fs.writeFileSync(path.join(home, '.muser', 'AGENTS.md'), 'write a DevNote\n');
  t.after(() => fs.rmSync(path.join(home, '.muser', 'AGENTS.md'), {force: true}));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'project rule\n');
  const found = projectInstructions(dir);
  assert.equal(found[0].file, path.join(home, '.muser', 'AGENTS.md'), 'listed first: the most general');
  assert.equal(found[0].user, true);
  assert.equal(found.at(-1).text, 'project rule\n');
  const p = preamble(dir, []);
  assert.match(p, /instructions for all projects, from .*AGENTS\.md:\nwrite a DevNote/);
});

test('a pending handoff rides the first turn after an account switch, once, and stays out of the transcript', async (t) => {
  const a = makeAgent(t); // session.turns is 0, as on the fresh session a switch creates
  a.ensureConnected = async () => {};
  const bodies = [];
  a.device = {connected: true, send: async body => { bodies.push(body); return {message_id: 'm' + bodies.length}; }};
  a.pendingHandoff = 'HANDOFF-MARKER';
  const sent1 = new Promise(r => a.once('sent', r));
  const turn1 = a.send('first task').catch(() => {});
  await sent1;
  assert.ok(bodies[0].includes('[muser: 前のアカウントからの引き継ぎ]\nHANDOFF-MARKER'), 'the handoff block is in the body sent to Muse');
  assert.ok(bodies[0].indexOf('HANDOFF-MARKER') < bodies[0].indexOf('first task'), 'ahead of the user text');
  assert.equal(a.pendingHandoff, null, 'consumed once the turn is sent');
  await a.interrupt(); await turn1;
  const stored = require('../src/sessions').transcript('main-session');
  assert.ok(stored.every(x => !String(x.user || '').includes('HANDOFF-MARKER')), 'the local transcript keeps only what the user typed');
  const sent2 = new Promise(r => a.once('sent', r));
  const turn2 = a.send('second task').catch(() => {});
  await sent2;
  assert.ok(!bodies[1].includes('HANDOFF-MARKER'), 'not sent twice');
  await a.interrupt(); await turn2;
});
