'use strict';
// The per-turn token usage parser (src/turn-usage.js): muse.ai's [usage] line,
// its fallbacks and formatting, stripping, and one fake completion event
// through the agent producing usage on turn-end and in the TUI end line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-test-home-'));
// t7 #4 (deep audit): these two temp roots were never cleaned up.
test.after(() => { fs.rmSync(process.env.LOCALAPPDATA, {recursive: true, force: true}); fs.rmSync(process.env.USERPROFILE, {recursive: true, force: true}); });

const {parse, strip, formatTokens, usageFromTranscript} = require('../src/turn-usage');

// Wave 7 spec update (this file, wherever a formatted usage string is
// asserted): formatUsage's in/out words follow the UI language now — in
// Japanese they are 入 / 出 ('130.8k 入 / 395 出'), not the fixed English
// '130.8k in / 395 out' every assertion here used to pin. A stored
// `formatted` string with no numbers behind it still passes through
// verbatim (see the usageText test), so only re-formatted output changed.
test('parse: the documented example formats as 130.8k 入 / 395 出 and keeps source and cost', () => {
  const r = parse('done\n\n[usage] context_tokens=130841 response_tokens=395 source=provider cost=unavailable');
  assert.ok(r);
  assert.equal(r.body.trim(), 'done');
  assert.equal(r.usage.inputTokens, 130841);
  assert.equal(r.usage.outputTokens, 395);
  assert.equal(r.usage.source, 'provider');
  assert.equal(r.usage.cost, 'unavailable');
  assert.equal(r.usage.formatted, '130.8k 入 / 395 出');
});

test('formatTokens: under 1000 as-is, thousands with one decimal and no trailing .0', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(395), '395');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(2000), '2k');
  assert.equal(formatTokens(130841), '130.8k');
  assert.equal(formatTokens(1050), '1.1k');
});

test('formatTokens: from a million, M with one decimal ("6274.9k" was hard to read)', () => {
  assert.equal(formatTokens(999949), '999.9k');
  assert.equal(formatTokens(999960), '1M', 'what would round to 1000k is 1M');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(formatTokens(6274947), '6.3M');
  assert.equal(formatTokens(12345678), '12.3M');
  assert.equal(formatTokens(999960000), '1B', 'what would round to 1000M is 1B');
  assert.equal(formatTokens(1234567890), '1.2B');
});

test('usageText: a stored record is formatted again from its numbers', () => {
  const {usageText} = require('../src/turn-usage');
  assert.equal(usageText({inputTokens: 6274947, outputTokens: 48479, formatted: '6274.9k in / 48.5k out'}), '6.3M 入 / 48.5k 出', 'an old record reads in today\'s units (and language: the stored English text is re-formatted, not kept)');
  assert.equal(usageText({formatted: '1k in / 2 out'}), '1k in / 2 out', 'no numbers: the stored text');
  assert.equal(usageText(null), '');
});

test('parse: fallbacks skip 0 and unavailable, estimates win over plain keys', () => {
  assert.equal(parse('x\n[usage] context_tokens=0 input_tokens=500 response_tokens=0 output_tokens=7').usage.inputTokens, 500);
  assert.equal(parse('x\n[usage] context_tokens=unavailable input_tokens=500 response_tokens=3').usage.inputTokens, 500);
  assert.equal(parse('x\n[usage] context_tokens_estimate=900 context_tokens=100 response_tokens_estimate=9 response_tokens=1').usage.inputTokens, 900);
  assert.equal(parse('x\n[usage] prompt_tokens=11 completion_tokens=2').usage.inputTokens, 11);
  assert.equal(parse('x\n[usage] prompt_tokens=11 completion_tokens=2').usage.outputTokens, 2);
});

test('parse: quoted values, all-unavailable reads as 0, and no line at the end reads as null', () => {
  const q = parse('x\n[usage] context_tokens="130841" response_tokens="395"');
  assert.equal(q.usage.inputTokens, 130841);
  assert.equal(q.usage.outputTokens, 395);
  const none = parse('x\n[usage] context_tokens=unavailable response_tokens=unavailable');
  assert.equal(none.usage.inputTokens, 0);
  assert.equal(none.usage.outputTokens, 0);
  assert.equal(none.usage.formatted, '0 入 / 0 出');
  assert.equal(parse('plain reply, no usage line'), null);
  assert.equal(parse('x\n[usage] context_tokens=5 response_tokens=6\nmore reply after it'), null, 'a usage line followed by more text is not a usage line');
  assert.equal(parse(''), null);
  assert.equal(parse(null), null);
  const upper = parse('x\n[USAGE] context_tokens=2000 response_tokens=50');
  assert.equal(upper.usage.formatted, '2k 入 / 50 出');
});

test('strip: removes only a trailing usage line and passes other text through', () => {
  assert.equal(strip('done\n[usage] context_tokens=5 response_tokens=6'), 'done');
  assert.ok(!strip('done\n\n[usage] context_tokens=5 response_tokens=6').includes('[usage]'));
  assert.equal(strip('keep [usage] in the middle\nmore text'), 'keep [usage] in the middle\nmore text');
  assert.equal(strip('plain reply'), 'plain reply');
  assert.equal(strip(null), null);
});

test('usageFromTranscript: the last assistant message carries it; user messages do not', () => {
  const found = usageFromTranscript({messages: [
    {role: 'user', content: [{text: 'hi\n[usage] context_tokens=999 response_tokens=999'}]},
    {role: 'assistant', content: [{text: 'working…'}]},
    {role: 'assistant', content: [{text: 'answer'}, {text: '\n\n[usage] context_tokens=2000 response_tokens=50 source=estimate'}]},
  ]});
  assert.equal(found.usage.formatted, '2k 入 / 50 出');
  assert.equal(found.usage.source, 'estimate');
  assert.equal(usageFromTranscript({messages: [{role: 'assistant', content: [{text: 'no usage here'}]}]}), null);
  assert.equal(usageFromTranscript({}), null);
  assert.equal(usageFromTranscript(null), null);
});

// One fake completion event through the agent: the live event carries the
// usage line in transcript.messages (display_text and history do not), and it
// must surface on turn-end, in the transcript record, and in the TUI end line
// — while the [usage] line itself never reaches any shown or recorded text.
test('a fake completion event through the agent puts usage on turn-end and in the TUI end line', async t => {
  const {Agent} = require('../src/agent');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-agent-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  let replyReady = false;
  const client = new EventEmitter();
  client.status = 'connected'; client.ws = {readyState: 1};
  // Before the send, history is empty (the baseline); after it, the reply is
  // there — without any usage line, as the real history API behaves.
  // Phase-2 coordination (agent-reply): the reply wait now only accepts a
  // history message that answers the sent message (reply_to_message_id) or
  // whose completion was signalled — the real history carries the reply_to
  // link, so the fixture does too (its 'r1' is the reply to the sent 'm1').
  client.history = async () => replyReady ? {chat_events: [{role: 'assistant', message_id: 'r1', reply_to_message_id: 'm1', display_text: 'done', seq: 1, occurred_at_ms: Date.now()}]} : {chat_events: []};
  client.request = async () => ({session: {status: 'idle'}});
  client.subscribeAgent = async () => {};
  client.closeAgentSubscription = () => {};
  client.cancel = async () => {};
  client.disconnect = () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0}, focusEnabled: false});
  t.after(() => a.close()); // t7 #4: every other agent test in this file closes its Agent; this one leaked its timers/subscriptions
  a.subscribed = true;
  a.ensureConnected = async () => {};
  a.device = {connected: true, disconnect() {}, send: async () => { replyReady = true; return {message_id: 'm1'}; }}; // disconnect: Agent.close() calls it (t7 #4's close)
  const turnEnd = new Promise(r => a.once('turn-end', r));
  const sent = new Promise(r => a.once('sent', r));
  const turnP = a.send('hello');
  await sent;
  client.emit('event', {event: 'delta.message_done', payload: {session_id: 'main-session', message_id: 'm1', status: 'completed',
    transcript: {messages: [{role: 'assistant', content: [{text: 'done\n\n[usage] context_tokens=130841 response_tokens=395 source=provider cost=unavailable'}]}]}}});
  const reply = await turnP;
  const e = await turnEnd;
  assert.equal(reply.text, 'done', 'the reply itself never carries the usage line');
  assert.ok(!reply.text.includes('[usage]'));
  assert.equal(e.usage.formatted, '130.8k 入 / 395 出');
  assert.equal(e.usage.inputTokens, 130841);
  assert.equal(e.usage.outputTokens, 395);
  assert.equal(e.usage.rounds, 1, 'a single reply is a one-round user turn total');
  const stored = require('../src/sessions').transcript('main-session');
  const last = stored.at(-1);
  assert.equal(last.usage.inputTokens, 130841);
  assert.equal(last.usage.outputTokens, 395);
  assert.equal(last.usage.source, 'provider');
  assert.ok(!last.reply.includes('[usage]'), 'the transcript record is clean too');
  // The TUI end line, rendered from the very turn-end event above.
  const React = (await import('react')).default, {render} = await import('ink');
  const {Entry} = await import('../src/ui/view.mjs');
  const {Controller} = await import('../src/ui/controller.mjs');
  const fakeAgent = new EventEmitter();
  Object.assign(fakeAgent, {mode: 'default', cwd, session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  fakeAgent.constructor.DEVICE = 'test';
  const ctrl = new Controller({agent: fakeAgent, museName: 'm', version: 't', onExit() {}});
  const show = async el => {
    const out = new EventEmitter(); out.columns = 100; out.rows = 40; out.isTTY = false; out.out = '';
    out.write = d => { out.out += d; return true; };
    const app = render(el, {stdout: out, debug: true, patchConsole: false, exitOnCtrlC: false});
    const start = Date.now();
    while (!out.out) { if (Date.now() - start > 5000) throw new Error('timed out waiting for the first frame'); await new Promise(r => setTimeout(r, 20)); }
    app.unmount();
    return out.out;
  };
  const withUsage = await show(React.createElement(Entry, {e: {type: 'end', ...e}, ctrl, W: 100}));
  assert.match(withUsage, /✻ \d+s · 130\.8k 入 \/ 395 出/);
  const without = await show(React.createElement(Entry, {e: {type: 'end', ok: true, ms: 12000}, ctrl, W: 100}));
  assert.match(without, /✻ 12s/);
  assert.ok(!without.includes('入 /') && !without.includes('in /'), 'nothing extra when there is no usage');
});

// A user turn of several replies: Focus rounds sum into one turn-end total,
// and the daily tally counts each reply once via turn-usage — never the
// turn-end total again on top of it.
test('a 2-round Focus run sums both rounds on turn-end and tallies each reply once', async t => {
  const {Agent} = require('../src/agent');
  const sessions = require('../src/sessions');
  const usage = require('../src/usage');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-focus-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  fs.writeFileSync(path.join(cwd, 'probe.txt'), 'probe');
  const prevUsageFile = process.env.MUSER_USAGE_FILE; process.env.MUSER_USAGE_FILE = path.join(cwd, 'usage.json'); t.after(() => { if (prevUsageFile === undefined) delete process.env.MUSER_USAGE_FILE; else process.env.MUSER_USAGE_FILE = prevUsageFile; }); // t7 #4: was left pointing at a deleted temp file for later tests
  const plan = [{text: 'Source satisfies the requested behavior', kind: 'inspection'}];
  const check = (status, evidence = []) => [{id: 'c1', status, evidence, reason: status}];
  const client = new EventEmitter(), events = [], sends = [];
  Object.assign(client, {status: 'connected', ws: {readyState: 1}, taskStatus: 'running', disconnect() {}, closeAgentSubscription() {}, async subscribeAgent() {}, async cancel() {}, async history() { return {chat_events: events}; }, async request() { return {session: {status: this.taskStatus}}; }});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)});
  agent.subscribed = true;
  t.after(() => agent.close());
  let inFlight = false;
  agent.device = {connected: true, disconnect() {}, async send(body, sessionId) {
    const round = sends.length + 1, id = 'user-' + round; sends.push({body, sessionId}); client.taskStatus = 'running';
    events.push({role: 'user', message_id: id, content: body, seq: round * 2});
    if (inFlight) return {message_id: id};
    inFlight = true;
    setImmediate(async () => {
      try {
        await agent.execute('focus.plan', {agent: 'main', criteria: JSON.stringify(plan)});
        const readResult = await agent.execute('code.read', {agent: 'main', path: 'probe.txt'}, 1000, 'read-' + round);
        await agent.execute('focus.checkpoint', {agent: 'main', checks: JSON.stringify(check(round === 1 ? 'unmet' : 'met', [readResult.payload.muser_evidence_id]))});
        if (agent.main.turn?.controller.signal.aborted) return;
        const inT = round === 1 ? 100000 : 50000, outT = round === 1 ? 100 : 250;
        const done = {event: 'delta.message_done', seq: round * 2 + 1, payload: {session_id: sessionId, message_id: 'reply-' + round, role: 'assistant', text: 'reply ' + round, status: 'completed',
          transcript: {messages: [{role: 'assistant', content: [{text: 'reply ' + round + '\n\n[usage] context_tokens=' + inT + ' response_tokens=' + outT + ' source=provider'}]}]}}};
        events.push(done); client.taskStatus = 'completed'; inFlight = false; client.emit('event', done);
      } catch (e) { client.taskStatus = 'failed'; inFlight = false; client.emit('event', {event: 'task.status', session_id: sessionId, payload: {status: 'failed'}}); }
    });
    return {message_id: id};
  }};
  // bin/muser.js's tally handlers, verbatim in shape: real tokens from
  // turn-usage, turns and the estimate from turn-end (no usage on turn-end).
  const turnUsages = [];
  agent.on('turn-usage', e => { turnUsages.push(e); try { usage.record({usage: e.usage}); } catch {} });
  let ends = 0, endEvent = null;
  agent.on('turn-end', e => { ends++; endEvent = e; try { if (e.ok) usage.record({turns: 1, outText: e.text || ''}); } catch {} });
  const answer = await agent.send('Original task wording');
  assert.equal(answer.focus.status, 'complete');
  assert.equal(answer.focus.round, 2);
  assert.equal(sends.length, 2);
  assert.equal(ends, 1, 'one turn-end for the whole user turn');
  assert.equal(endEvent.usage.inputTokens, 150000, 'both rounds, not just the last reply');
  assert.equal(endEvent.usage.outputTokens, 350);
  assert.equal(endEvent.usage.formatted, '150k 入 / 350 出');
  assert.equal(endEvent.usage.rounds, 2);
  assert.equal(turnUsages.length, 2, 'one turn-usage event per reply');
  assert.deepEqual(turnUsages.map(u => u.agent), ['main', 'main']);
  assert.equal(turnUsages[0].usage.inputTokens, 100000);
  assert.equal(turnUsages[1].usage.inputTokens, 50000);
  const s = usage.summary();
  assert.equal(s.today.realInTokens, 150000, 'each reply tallied once; the turn-end total is not tallied again');
  assert.equal(s.today.realOutTokens, 350);
  assert.equal(s.today.turns, 1, 'the user turn still counts as one turn');
});

// A parallel agent's reply is tallied through turn-usage too. On its own
// (spawned outside a user turn) it emits no turn-end; pooled into a turn's
// total only when it belongs to that turn — the next test covers that.
test('a parallel agent reply is tallied via turn-usage, with no turn-end', async t => {
  const {Agent} = require('../src/agent');
  const usage = require('../src/usage');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-parallel-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const prevUsageFile = process.env.MUSER_USAGE_FILE; process.env.MUSER_USAGE_FILE = path.join(cwd, 'usage.json'); t.after(() => { if (prevUsageFile === undefined) delete process.env.MUSER_USAGE_FILE; else process.env.MUSER_USAGE_FILE = prevUsageFile; }); // t7 #4: was left pointing at a deleted temp file for later tests
  let replyReady = false, workerSession = null;
  const client = new EventEmitter();
  client.status = 'connected'; client.ws = {readyState: 1};
  client.history = async () => replyReady ? {chat_events: [{role: 'assistant', message_id: 'pr1', reply_to_message_id: 'pw1', display_text: 'parallel done', seq: 1, occurred_at_ms: Date.now()}]} : {chat_events: []}; // reply_to: same agent-reply gate as the main-turn fixture above
  client.request = async () => ({session: {status: 'idle'}});
  client.subscribeAgent = async () => {};
  client.closeAgentSubscription = () => {};
  client.cancel = async () => {};
  client.disconnect = () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0}, focusEnabled: false});
  a.subscribed = true;
  a.ensureConnected = async () => {};
  a.device = {connected: true, disconnect() {}, send: async (body, sessionId) => { workerSession = sessionId; replyReady = true; return {message_id: 'pw1'}; }};
  const usages = [];
  a.on('turn-usage', e => { usages.push(e); try { usage.record({usage: e.usage}); } catch {} });
  let turnEnds = 0;
  a.on('turn-end', () => { turnEnds++; });
  const doneP = new Promise(r => a.once('agent-done', r));
  const sentP = new Promise(r => a.once('sent', r));
  t.after(() => a.close());
  const worker = a.spawn('parallel task');
  await sentP;
  client.emit('event', {event: 'delta.message_done', payload: {session_id: workerSession, message_id: 'pw1', status: 'completed',
    transcript: {messages: [{role: 'assistant', content: [{text: 'parallel done\n\n[usage] context_tokens=2000 response_tokens=20 source=provider'}]}]}}});
  const snap = await doneP;
  assert.equal(worker.tag, 'a1');
  assert.equal(snap.usage.formatted, '2k 入 / 20 出');
  assert.equal(snap.usage.inputTokens, 2000);
  assert.equal(snap.usage.outputTokens, 20);
  assert.equal(usages.length, 1, 'exactly one turn-usage event for the parallel reply');
  assert.equal(usages[0].agent, 'a1');
  assert.equal(usages[0].usage.inputTokens, 2000);
  assert.equal(turnEnds, 0, 'a parallel reply emits no turn-end');
  const s = usage.summary();
  assert.equal(s.today.realInTokens, 2000);
  assert.equal(s.today.realOutTokens, 20);
});

// The turn-end line (✻) shows main + subagents: a parallel reply that lands
// while its user turn is still running pools into that turn's total. The
// tally still counts each reply once via turn-usage — never the pooled
// turn-end total on top of it.
test('a parallel reply during a user turn pools into the turn-end total', async t => {
  const {Agent} = require('../src/agent');
  const sessions = require('../src/sessions');
  const usage = require('../src/usage');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-pool-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const prevUsageFile = process.env.MUSER_USAGE_FILE; process.env.MUSER_USAGE_FILE = path.join(cwd, 'usage.json'); t.after(() => { if (prevUsageFile === undefined) delete process.env.MUSER_USAGE_FILE; else process.env.MUSER_USAGE_FILE = prevUsageFile; }); // t7 #4: was left pointing at a deleted temp file for later tests
  const histories = new Map(), sends = [];
  const client = new EventEmitter();
  client.status = 'connected'; client.ws = {readyState: 1};
  client.history = async sessionId => ({chat_events: histories.get(sessionId) || []});
  client.request = async () => ({session: {status: 'idle'}});
  client.subscribeAgent = async () => {};
  client.closeAgentSubscription = () => {};
  client.cancel = async () => {};
  client.disconnect = () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd, session: sessions.create(cwd), focusEnabled: false});
  a.subscribed = true;
  a.ensureConnected = async () => {};
  a.device = {connected: true, disconnect() {}, send: async (body, sessionId) => { sends.push(sessionId); return {message_id: 'm-' + sessionId}; }};
  const turnUsages = [];
  a.on('turn-usage', e => { turnUsages.push(e); try { usage.record({usage: e.usage}); } catch {} });
  const endP = new Promise(r => a.once('turn-end', r));
  const doneP = new Promise(r => a.once('agent-done', r));
  t.after(() => a.close());
  const complete = (sessionId, text, inT, outT) => {
    histories.set(sessionId, [{role: 'assistant', message_id: 'r-' + sessionId, display_text: text, seq: 1, occurred_at_ms: Date.now()}]);
    client.emit('event', {event: 'delta.message_done', payload: {session_id: sessionId, message_id: 'r-' + sessionId, status: 'completed',
      transcript: {messages: [{role: 'assistant', content: [{text: text + '\n\n[usage] context_tokens=' + inT + ' response_tokens=' + outT + ' source=provider'}]}]}}});
  };
  const until = async fn => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 5000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
  const mainId = a.session.id;
  const sendP = a.send('main task');
  await until(() => sends.includes(mainId));
  const worker = a.spawn('sub task');
  await until(() => sends.includes(worker.session.id));
  complete(worker.session.id, 'sub done', 2000, 20);
  await doneP; // the sub reply has landed (and pooled) before main ends
  complete(mainId, 'main done', 3000, 30);
  const end = await endP;
  await sendP;
  assert.equal(end.usage.inputTokens, 5000, 'main 3000 + sub 2000');
  assert.equal(end.usage.outputTokens, 50);
  assert.equal(end.usage.rounds, 2, 'two replies in the turn total');
  assert.equal(turnUsages.length, 2, 'one turn-usage per reply');
  const s = usage.summary();
  assert.equal(s.today.realInTokens, 5000, 'the tally counts each reply once — the pooled total is not tallied again');
  assert.equal(s.today.realOutTokens, 50);
});

// The Focus path's one turn-end (emitted by send()'s wrapper) merges the
// pool the same way; an agent stamped with an earlier turn never pools.
test('the Focus wrapper adds the pool to the one turn-end it emits', async t => {
  const {Agent} = require('../src/agent');
  const sessions = require('../src/sessions');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-turn-usage-focus-pool-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const client = new EventEmitter();
  Object.assign(client, {status: 'connected', disconnect() {}, closeAgentSubscription() {}});
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd)});
  t.after(() => agent.close());
  agent.sendFocused = async () => {
    agent.poolUsage({userTurn: agent.userTurnSeq - 1}, {inputTokens: 999, outputTokens: 999}); // an earlier turn's agent: refused
    agent.poolUsage({userTurn: agent.userTurnSeq}, {inputTokens: 50, outputTokens: 5});
    return {text: 'done', usage: {inputTokens: 100, outputTokens: 10, formatted: '100 in / 10 out', rounds: 1}};
  };
  const endP = new Promise(r => agent.once('turn-end', r));
  const reply = await agent.send('task');
  const end = await endP;
  assert.equal(end.usage.inputTokens, 150, 'main 100 + this turn\'s sub 50 (the stale 999 refused)');
  assert.equal(end.usage.outputTokens, 15);
  assert.equal(reply.usage.inputTokens, 150, 'the returned reply carries the same total');
});

// The "/usage on" chat command is what makes Muse attach the counts at
// all; muser sends it itself, once per account (src/agent.js ensureUsageOn),
// on a scratch session, and remembers the state in accounts' identity store.
function usageAgent(t, accountId, sends) {
  const {Agent} = require('../src/agent');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-usage-on-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const client = new EventEmitter();
  client.status = 'connected'; client.ws = {readyState: 1};
  client.history = async () => ({chat_events: []});
  client.request = async () => ({});
  client.subscribeAgent = async () => {};
  client.closeAgentSubscription = () => {};
  client.cancel = async () => {};
  client.disconnect = () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm in tests'); }}, cwd,
    session: {id: 'main-session', cwd, title: '', created: 0, updated: 0, turns: 0}, focusEnabled: false, accountId});
  t.after(() => a.close());
  a.device = {connected: true, disconnect() {}, send: async (text, session, extra) => { sends.push({text, session, extra}); return {message_id: 'c1'}; }};
  return a;
}

test('ensureUsageOn: sends /usage on once, as a chat command on a scratch session', async t => {
  const accounts = require('../src/accounts');
  assert.equal(accounts.usageCmd('usage-auto'), null);
  const sends = [];
  const a = usageAgent(t, 'usage-auto', sends);
  await a.ensureUsageOn();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, '/usage on');
  assert.equal(sends[0].extra.command, true);
  assert.notEqual(sends[0].session, 'main-session', 'the command goes on its own scratch session');
  const rec = accounts.usageCmd('usage-auto');
  assert.ok(rec.sent > 0, 'the send is remembered');
  assert.equal(rec.session, sends[0].session, 'the scratch session is remembered for the retry');
  await a.ensureUsageOn();
  assert.equal(sends.length, 1, 'a recent send is not repeated');
});

test('ensureUsageOn: counts seen within a day skip the command entirely', async t => {
  const accounts = require('../src/accounts');
  accounts.rememberUsageSeen('usage-seen');
  const sends = [];
  const a = usageAgent(t, 'usage-seen', sends);
  await a.ensureUsageOn();
  assert.equal(sends.length, 0);
});

test('ensureUsageOn: stale records retry on the remembered scratch session', async t => {
  const accounts = require('../src/accounts');
  const store = require('../src/secure-store');
  accounts.rememberUsageCmdSent('usage-stale', 'scratch-1');
  accounts.rememberUsageSeen('usage-stale');
  const f = store.file('identity.json');
  const v = JSON.parse(fs.readFileSync(f, 'utf8'));
  v.usageCmd['usage-stale'].sent = Date.now() - 2 * 3600 * 1000;
  v.usageCmd['usage-stale'].seen = Date.now() - 48 * 3600 * 1000;
  fs.writeFileSync(f, JSON.stringify(v));
  const sends = [];
  const a = usageAgent(t, 'usage-stale', sends);
  await a.ensureUsageOn();
  assert.equal(sends.length, 1, 'counts stopped arriving and the last send is old: ask again');
  assert.equal(sends[0].session, 'scratch-1', 'the retry reuses the same scratch session');
});

test('ensureUsageOn: a failed send is not remembered and does not throw', async t => {
  const accounts = require('../src/accounts');
  const a = usageAgent(t, 'usage-fail', []);
  a.device = {connected: true, disconnect() {}, send: async () => { throw new Error('gateway said no'); }};
  await a.ensureUsageOn();
  assert.equal(accounts.usageCmd('usage-fail'), null);
});
