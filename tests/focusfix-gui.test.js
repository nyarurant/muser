'use strict';
// focusfix regression tests for the GuiServer snapshot shaping (src/gui-server.js
// focusForWire): the distributed focus state must (1) carry only the newest 40
// evidence entries plus evidenceTotal, without mutating the Controller's live
// state, (2) always carry the task goal (and status), filling them from the
// standing goal when a partial focus object lacks them, and (3) distribute the
// focus.ask choices and the picker state (`question`) only while the focus
// status is 'needs_input' — a completed task must not ship a live picker.
// Same fake Controller/Agent harness shape as tests/gui-server.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.cwd = 'C:\\work'; this.mode = 'default'; this.session = {id: 'sess-1', turns: 2};
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 2};
  }
}
FakeAgent.DEVICE = 'fake-device';

class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.listeners = new Set(); this.pending = [];
    this.s = {
      entries: [], busy: false, queue: [], approval: null, reasonFor: null,
      mode: 'default', shells: [], focus: null, goal: null, question: null,
      todos: [], agents: [], plan: null,
    };
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
}

function makeServer(t) {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-focusfix-'));
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server};
}
const AUTH = {authorization: 'Bearer test-token'};
const evidence = n => Array.from({length: n}, (_, i) => ({id: 'e' + (i + 1), command: 'system.run', summary: 'run ' + (i + 1)}));
const ASK = {questions: [{header: '猫', question: 'どの猫？', multi: false, options: [{label: '黒猫', description: null, preview: null}]}]};
const PICKER = {questions: ASK.questions, tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''};

test('focusfix: a full evidence log is trimmed to the newest 40 with evidenceTotal, live state untouched', async t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', status: 'running', criteria: [], evidence: evidence(300), ask: null}});
  await server.start();
  const state = await (await fetch('http://127.0.0.1:' + server.port + '/api/state', {headers: AUTH})).json();
  assert.equal(state.focus.evidenceTotal, 300, 'the total rides along so a client can tell older entries exist');
  assert.equal(state.focus.evidence.length, 40, 'only the newest 40 entries are distributed');
  assert.equal(state.focus.evidence[0].id, 'e261');
  assert.equal(state.focus.evidence[39].id, 'e300');
  assert.equal(controller.s.focus.evidence.length, 300, 'the Controller live evidence log is not mutated');
  assert.equal(controller.s.focus.evidence[0].id, 'e1');
  assert.equal(controller.s.focus.evidenceTotal, undefined, 'no shaping fields leak into the live state');
});

test('focusfix: a short evidence log rides whole, still with evidenceTotal', t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', status: 'running', criteria: [], evidence: evidence(5), ask: null}});
  const snap = server.snapshot();
  assert.equal(snap.focus.evidenceTotal, 5);
  assert.deepEqual(snap.focus.evidence.map(e => e.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('focusfix: an SSE state frame carries the same trimmed focus', async t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', status: 'running', criteria: [], evidence: evidence(50), ask: null}});
  await server.start();
  const res = await fetch('http://127.0.0.1:' + server.port + '/api/events', {headers: AUTH});
  assert.equal(res.status, 200);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buf = '', frame = null;
  const deadline = Date.now() + 3000;
  while (!frame && Date.now() < deadline) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    const i = buf.indexOf('\n\n');
    if (i >= 0) { const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: ')); if (line) frame = JSON.parse(line.slice(6)); }
  }
  await reader.cancel().catch(() => {});
  assert.ok(frame && frame.kind === 'state', 'the first SSE frame is the state frame');
  assert.equal(frame.state.focus.evidenceTotal, 50);
  assert.equal(frame.state.focus.evidence.length, 40);
  assert.equal(frame.state.focus.evidence[0].id, 'e11');
});

test('focusfix: goal and status the focus already carries are kept verbatim', t => {
  const {server, controller} = makeServer(t);
  controller.set({goal: {text: 'standing goal'}, focus: {id: 'f1', goal: 'the task itself', status: 'blocked', criteria: [], evidence: [], ask: null}});
  const snap = server.snapshot();
  assert.equal(snap.focus.goal, 'the task itself', 'the focus goal wins over the standing goal');
  assert.equal(snap.focus.status, 'blocked');
});

test('focusfix: a focus without goal/status gets the standing goal and a derived status', t => {
  const {server, controller} = makeServer(t);
  controller.set({goal: {text: 'standing goal text'}, focus: {id: 'f1', criteria: [], evidence: []}});
  const snap = server.snapshot();
  assert.equal(snap.focus.goal, 'standing goal text', 'clients can show what task the window is on');
  assert.equal(snap.focus.status, 'running', 'no ask and no picker: still running');
});

test('focusfix: the goal falls back to the agent standing goal when the Controller state has none', t => {
  const {server, controller, agent} = makeServer(t);
  agent.standingGoal = () => ({text: 'agent goal text'});
  controller.set({focus: {id: 'f1', criteria: [], evidence: []}});
  const snap = server.snapshot();
  assert.equal(snap.focus.goal, 'agent goal text');
  assert.equal(snap.focus.status, 'running');
});

test('focusfix: a completed task distributes no live picker (ask and question are nulled)', t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', status: 'complete', criteria: [], evidence: [], ask: ASK}, question: PICKER});
  const snap = server.snapshot();
  assert.equal(snap.focus.status, 'complete');
  assert.equal(snap.focus.ask, null, 'the choices must not ride a completed task');
  assert.equal(snap.question, null, 'the picker state must not ride a completed task');
  assert.deepEqual(controller.s.focus.ask, ASK, 'the live focus object is not mutated');
});

test('focusfix: a running task distributes no picker either', t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', status: 'running', criteria: [], evidence: [], ask: ASK}, question: PICKER});
  const snap = server.snapshot();
  assert.equal(snap.focus.ask, null);
  assert.equal(snap.question, null);
});

test('focusfix: needs_input keeps the choices and the picker state', t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', status: 'needs_input', criteria: [], evidence: [], ask: ASK}, question: PICKER});
  const snap = server.snapshot();
  assert.deepEqual(snap.focus.ask, ASK);
  // server-first: the picker also carries its question id (the double-answer
  // guard); everything else is the picker state verbatim.
  const {id: qid, ...pickerRest} = snap.question;
  assert.match(qid, /^question-/);
  assert.deepEqual(pickerRest, PICKER);
});

test('focusfix: a status-less focus carrying an ask reads as needs_input and keeps its picker', t => {
  const {server, controller} = makeServer(t);
  controller.set({focus: {id: 'f1', goal: 'g', criteria: [], evidence: [], ask: ASK}, question: PICKER});
  const snap = server.snapshot();
  assert.equal(snap.focus.status, 'needs_input', 'an ask waiting on the user means the task waits on the user');
  assert.deepEqual(snap.focus.ask, ASK);
  const {id: qid2, ...pickerRest2} = snap.question;
  assert.match(qid2, /^question-/);
  assert.deepEqual(pickerRest2, PICKER);
});
