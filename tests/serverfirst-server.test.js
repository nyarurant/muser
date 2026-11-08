'use strict';
// serverfirst (out-CL §1/§6): the Server-side gaps the client TUI parity work
// depends on, against fake Agent/Controller pairs in the gui-server.test.js /
// server.test.js shape — no gateway, no device, no real Muse, no network
// beyond this process's own GuiServer on an OS-assigned port.
//  1. the snapshot carries promptFor / addFlow / accountReserved (the shapes
//     src/ui/controller.mjs keeps them in) and menu side / option group;
//  2. POST /send with a questionId is bound to the snapshot question's id:
//     first answer wins, a second one is 409 {code: 'question_answered'};
//  3. approvals are first-wins too (already true — locked in here);
//  4. SessionsHost accepts the attach values (maxAgents / maxAgentsTotal /
//     focusEnabled / noFocus), validates them, and forwards them to the
//     conversation factory, directly and over HTTP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {GuiServer} = require('../src/gui-server');
const {SessionsHost, HostError} = require('../src/server/sessions-host');

let seq = 0;
class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    seq++;
    this.cwd = cwd || 'C:\\work'; this.mode = 'default';
    this.session = {id: 'sess-' + seq, turns: 0};
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 1};
    this.accountId = 'default'; this.accountLabel = null; this.busy = false; this.closed = false;
    this.shells = {kill: id => ({id, killed: true})};
  }
  async interrupt() {}
  close() { this.closed = true; }
}
FakeAgent.DEVICE = 'fake-device';

class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.museName = 'kaguya';
    this.listeners = new Set(); this.submitted = []; this.pending = [];
    this.s = {
      entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null,
      promptFor: null, question: null, addFlow: null, accountReserved: null, menu: null, limitInput: null,
      mode: 'default', shells: [], focus: null, todos: [], agents: [], plan: null, account: null,
      attachments: [],
    };
    this.nextId = 2;
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  push(entry) { this.set({entries: [...this.s.entries, {id: this.nextId++, ...entry}]}); }
  // The real Controller.submit (controller.mjs): a plain send while the
  // picker is open IS its answer — the picker closes as the send proceeds.
  async submit(text) {
    this.submitted.push(text);
    if (this.s.question) this.set({question: null});
    this.push({type: 'user', text});
  }
  nextApproval() { this.promoted = (this.promoted || 0) + 1; }
  cancelPrompt() { this.promptCancels = (this.promptCancels || 0) + 1; if (this.s.promptFor) this.set({promptFor: null}); }
  setMode(m) { this.agent.mode = m; this.set({mode: m}); }
  slashList() { return []; }
  askPending() {
    let settled = null;
    const req = {call: {command: 'system.run', agent: 'main', summary: 'x'}, preview: null, index: 0, outside: false, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], resolve: v => { settled = v; }};
    this.set({approval: req});
    return {settled: () => settled};
  }
}
function makePair(cwd) { const agent = new FakeAgent(cwd); return {agent, controller: new FakeController(agent), museName: 'kaguya'}; }

function makeServer(t) {
  const {agent, controller} = makePair();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-serverfirst-'));
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p, {headers = {}, body} = {}) {
  return fetch('http://127.0.0.1:' + server.port + p, {method, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})}, body: body !== undefined ? JSON.stringify(body) : undefined});
}
async function state(server) { const res = await call(server, 'GET', '/api/state', {headers: AUTH}); assert.equal(res.status, 200); return res.json(); }
function tmpDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-cwd-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }

const ASK = {questions: [{header: '猫', question: 'どの猫？', multi: false, options: [{label: '黒猫'}, {label: '三毛猫'}]}]};
function openQuestion(controller) {
  controller.set({question: {questions: ASK.questions, tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''}});
}

// ---- 1. snapshot: promptFor / addFlow / accountReserved ----------------------

test('snapshot: promptFor crosses as {message} only — the resolve/reject closures stay server-side', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.equal((await state(server)).promptFor, null, 'no prompt pending: null');
  controller.set({promptFor: {resolve: () => {}, reject: () => {}, message: '追加するアカウントの名前'}});
  const snap = await state(server);
  assert.deepEqual(snap.promptFor, {message: '追加するアカウントの名前'});
});

test('snapshot: addFlow crosses as plain {lines, busy}; accountReserved as the label or null', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const blank = await state(server);
  assert.equal(blank.addFlow, null);
  assert.equal(blank.accountReserved, null);
  controller.set({addFlow: {lines: ['手順1', '手順2'], busy: '登録しています'}, accountReserved: 'sub'});
  const snap = await state(server);
  assert.deepEqual(snap.addFlow, {lines: ['手順1', '手順2'], busy: '登録しています'});
  assert.equal(snap.accountReserved, 'sub');
  controller.set({addFlow: {lines: [], busy: null}, accountReserved: null});
  const done = await state(server);
  assert.deepEqual(done.addFlow, {lines: [], busy: null}, 'an open but idle add screen still crosses');
  assert.equal(done.accountReserved, null);
});

test('snapshot (debug G5/G6/Y1): promptFor message is normalised, addFlow is an allowlist, accountReserved cannot break the read', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  controller.set({promptFor: {resolve: () => {}, reject: () => {}, message: 42}});
  let snap = await state(server);
  assert.deepEqual(snap.promptFor, {message: '42'}, 'a non-string message crosses as a string, not as a vanished prompt');
  controller.set({promptFor: {resolve: () => {}, reject: () => {}, message: 10n}});
  snap = await state(server);
  assert.deepEqual(snap.promptFor, {message: '10'}, 'a BigInt message no longer nulls the whole prompt');
  controller.set({promptFor: null, addFlow: {lines: ['手順1'], busy: '登録中', internal: {secret: 'x'}, resolve: () => {}}});
  snap = await state(server);
  assert.deepEqual(snap.addFlow, {lines: ['手順1'], busy: '登録中'}, 'only {lines, busy} cross');
  controller.set({accountReserved: 10n});
  snap = await state(server);
  assert.equal(snap.accountReserved, null, 'a non-JSON reservation degrades to null instead of breaking the state read');
});

// ---- 1. snapshot: menu side / group -------------------------------------------

test('snapshot: menu options carry their group; side says whether the menu can page', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  controller.set({menu: {title: '設定', index: 0, options: [
    {value: 'focus', label: 'Focus', desc: 'オン', group: '作業の進め方'},
    {value: 'lang', label: '表示言語', group: '表示'},
    {value: 'plain', label: 'グループなし'},
  ], pick: () => {}}});
  const snap = await state(server);
  assert.equal(snap.menu.side, false, 'no side closure: not pageable');
  assert.deepEqual(snap.menu.options.map(o => o.group), ['作業の進め方', '表示', undefined]);
  assert.equal(snap.menu.options[0].desc, 'オン', 'existing option fields are untouched');
});

test('menu side: POST /menu {side} pages through the menu closure; stale id and bad dir refused', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const page = n => ({title: '会話を再開 · フォルダー' + n, index: 0, options: [{value: 's' + n, label: '会話' + n}], pick: () => {}, side: d => controller.set({menu: page(n + d)})});
  controller.set({menu: page(1)});
  const snap = await state(server);
  assert.equal(snap.menu.side, true, 'a side closure crosses as side: true');
  const paged = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {side: 1, menuId: snap.menu.id}});
  assert.equal(paged.status, 200);
  assert.equal((await state(server)).menu.title, '会話を再開 · フォルダー2', 'the next snapshot shows the paged menu');
  const stale = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {side: 1, menuId: snap.menu.id}});
  assert.equal(stale.status, 409, 'the pre-page menu id no longer binds');
  assert.equal((await (await call(server, 'POST', '/api/menu', {headers: AUTH, body: {side: 2}})).status), 400, 'side must be -1 or 1');
  controller.set({menu: {title: '単一ページ', index: 0, options: [{value: 1, label: 'x'}], pick: () => {}}});
  const noPaging = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {side: -1}});
  assert.equal(noPaging.status, 409);
  assert.match((await noPaging.json()).error, /no paging/);
  controller.set({menu: null});
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {side: 1}})).status, 409, 'no menu open');
});

test('menu side (debug G7): an async paging failure is surfaced on the conversation, not an unhandled rejection', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  controller.set({menu: {title: 'M', index: 0, options: [{value: 1, label: 'x'}], pick: () => {}, side: async () => { throw new Error('page blew up'); }}});
  const res = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {side: 1}});
  assert.equal(res.status, 200);
  await new Promise(r => setImmediate(r));
  const snap = await state(server);
  assert.ok(snap.entries.some(e => e.type === 'end' && e.ok === false && /page blew up/.test(e.error || '')), 'the failure lands as an error entry');
});

// ---- 2. questionId guard --------------------------------------------------------

test('question: the snapshot carries a stable id for the open picker', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.equal((await state(server)).question, null);
  openQuestion(controller);
  const one = await state(server);
  assert.match(one.question.id, /^question-\d+$/, 'the id rides inside the question object, like approval/menu ids');
  const two = await state(server);
  assert.equal(two.question.id, one.question.id, 'the same picker object keeps its id across snapshots');
});

test('question: first /send answer with its questionId wins; the second is 409 question_answered', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const {question} = await state(server);
  const first = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'どの猫？ → 黒猫', questionId: question.id}});
  assert.equal(first.status, 202);
  assert.deepEqual(controller.submitted, ['どの猫？ → 黒猫']);
  assert.equal(controller.s.question, null, 'the answer closed the picker (the real submit does the same)');
  const second = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'どの猫？ → 三毛猫', questionId: question.id}});
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.code, 'question_answered', 'distinguishable from other 409s (queue full, no approval…)');
  assert.equal(body.error, 'question already answered');
  assert.deepEqual(controller.submitted, ['どの猫？ → 黒猫'], 'the late answer never reached submit as a chat message');
});

test('question: a questionId naming another (or no) question is refused, and the open picker survives', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const noPicker = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え', questionId: 'question-1'}});
  assert.equal(noPicker.status, 409);
  assert.equal((await noPicker.json()).code, 'question_answered');
  openQuestion(controller);
  const stale = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え', questionId: 'question-999'}});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'question_answered');
  assert.deepEqual(controller.submitted, [], 'nothing was submitted');
  assert.ok(controller.s.question, 'the open picker is still open for its real answer');
});

test('question: a duplicate answer is refused even when a new picker has already opened', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const first = await state(server);
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え1', questionId: first.question.id}})).status, 202);
  openQuestion(controller); // a fresh picker (a new question object) opens right away
  const second = await state(server);
  assert.notEqual(second.question.id, first.question.id, 'the new picker has its own id');
  const dup = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え1（再送）', questionId: first.question.id}});
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).code, 'question_answered');
  assert.deepEqual(controller.submitted, ['答え1']);
  assert.ok(controller.s.question, 'the new picker was not answered by the duplicate');
});

test('question (debug G1): a concurrent duplicate is refused even while the picker is still closing', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const {question} = await state(server);
  // The queued/steered shape: submit clears the picker a tick AFTER it starts.
  controller.submit = async text => { controller.submitted.push(text); await new Promise(r => setImmediate(r)); if (controller.s.question) controller.set({question: null}); };
  const pair = await Promise.all([
    call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答えA', questionId: question.id}}),
    call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答えB', questionId: question.id}}),
  ]);
  assert.deepEqual(pair.map(r => r.status).sort(), [202, 409], 'exactly one of the racing answers lands');
  assert.equal(controller.submitted.length, 1, 'the second answer never reached submit');
});

test('question (debug G1): a submit that fails at once hands the questionId back', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const {question} = await state(server);
  const realSubmit = controller.submit.bind(controller);
  controller.submit = async () => { throw new Error('boom'); };
  const fail = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え', questionId: question.id}});
  assert.equal(fail.status, 500);
  controller.submit = realSubmit;
  const ok = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え', questionId: question.id}});
  assert.equal(ok.status, 202, 'the refused send did not burn the question');
  assert.deepEqual(controller.submitted, ['答え']);
});

test('question (debug G2): a non-string or empty questionId never engages the guard', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const {question} = await state(server);
  const arr = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '普通の文1', questionId: [question.id]}});
  assert.equal(arr.status, 202, 'an array questionId is ignored, not String()-coerced into a match');
  openQuestion(controller);
  const empty = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '普通の文2', questionId: ''}});
  assert.equal(empty.status, 202, 'an empty questionId does not refuse a plain send');
  const zero = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '普通の文3', questionId: 0}});
  assert.equal(zero.status, 202);
  assert.deepEqual(controller.submitted, ['普通の文1', '普通の文2', '普通の文3']);
});

test('question (debug G4): while a decline reason is pending, a questionId answer is refused and the picker survives', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const {question} = await state(server);
  controller.set({reasonFor: {call: {command: 'system.run'}}});
  const refused = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え', questionId: question.id}});
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'question_answered');
  assert.deepEqual(controller.submitted, [], 'the answer was not consumed as the reason');
  assert.ok(controller.s.question, 'the picker stays open for its real answer');
  controller.set({reasonFor: null});
  const ok = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '答え', questionId: question.id}});
  assert.equal(ok.status, 202, 'once the reason is gone the same answer lands');
});

test('question: sends without questionId behave exactly as before (backward compat)', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  openQuestion(controller);
  const plain = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'どの猫？ → 黒猫'}});
  assert.equal(plain.status, 202, 'a legacy/phone answer still goes through with no id');
  assert.deepEqual(controller.submitted, ['どの猫？ → 黒猫']);
  const chat = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '普通のメッセージ'}});
  assert.equal(chat.status, 202);
  assert.deepEqual(controller.submitted, ['どの猫？ → 黒猫', '普通のメッセージ']);
});

// ---- 3. approval first-wins (verification, locked in) ---------------------------

test('approval: first answer wins — a duplicate is 409 and a stale id cannot land on the next approval', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const first = controller.askPending();
  const snap1 = await state(server);
  const ok = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}, approvalId: snap1.approval.id}});
  assert.equal(ok.status, 200);
  assert.deepEqual(first.settled(), {allow: true, always: null});
  const dup = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: false}, approvalId: snap1.approval.id}});
  assert.equal(dup.status, 409, 'nothing pending any more: the duplicate is refused, not applied');
  assert.deepEqual(first.settled(), {allow: true, always: null}, 'the first answer stands');
  const second = controller.askPending();
  const stale = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: false}, approvalId: snap1.approval.id}});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'approval has changed');
  assert.equal(second.settled(), null, 'the stale answer did not resolve the new approval');
});

test('prompt route (debug R4): POST /api/prompt {cancel: true} cancels the pending prompt', async t => {
  const {controller, server} = makeServer(t);
  await server.start();
  controller.set({promptFor: {message: 'コードは？'}});
  const ok = await call(server, 'POST', '/api/prompt', {headers: AUTH, body: {cancel: true}});
  assert.equal(ok.status, 200);
  assert.equal(controller.promptCancels, 1);
  assert.equal(controller.s.promptFor, null);
  const bad = await call(server, 'POST', '/api/prompt', {headers: AUTH, body: {}});
  assert.equal(bad.status, 400, 'anything but {cancel: true} is refused');
});

// ---- 4. SessionsHost attach values ----------------------------------------------

function makeHost(t, captured, stored = new Map()) {
  const host = new SessionsHost({
    create: async args => { captured.push(args); const pair = makePair(args.cwd); if (args.session && typeof args.session === 'object') pair.agent.session = {...args.session}; return pair; },
    findSession: ref => stored.get(ref) || null,
    idleMs: 0,
  });
  t.after(async () => { await host.closeAll(); });
  return host;
}

test('host: openNew forwards the attach values to the factory and keeps them on the entry', async t => {
  const captured = [];
  const host = makeHost(t, captured);
  const dir = tmpDir(t);
  const e = await host.openNew({cwd: dir, maxAgents: 2, maxAgentsTotal: 5, noFocus: true});
  assert.equal(captured.length, 1);
  assert.equal(captured[0].maxAgents, 2);
  assert.equal(captured[0].maxAgentsTotal, 5);
  assert.equal(captured[0].noFocus, true);
  assert.equal(captured[0].focusEnabled, false, 'focusEnabled is derived as !noFocus');
  assert.deepEqual(e.attachOpts, {maxAgents: 2, maxAgentsTotal: 5, noFocus: true, focusEnabled: false});
  const plain = await host.openNew({cwd: dir});
  assert.equal(captured.length, 2);
  assert.ok(!('maxAgents' in captured[1]) && !('focusEnabled' in captured[1]) && !('noFocus' in captured[1]), 'no attach values: the factory sees the exact old argument shape');
  assert.equal(plain.attachOpts, undefined);
  const explicit = await host.openNew({cwd: dir, focusEnabled: true, noFocus: true});
  assert.equal(captured[2].focusEnabled, true, 'an explicit focusEnabled wins over the derived one');
  assert.equal(explicit.attachOpts.focusEnabled, true);
});

test('host: openExisting forwards the attach values when it builds the conversation', async t => {
  const stored = new Map([['past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'}]]);
  const captured = [];
  const host = makeHost(t, captured, stored);
  const e = await host.openExisting('past-1', {maxAgentsTotal: 8, focusEnabled: false});
  assert.equal(e.id, 'past-1');
  assert.equal(captured[0].maxAgentsTotal, 8);
  assert.equal(captured[0].focusEnabled, false);
  assert.ok(!('noFocus' in captured[0]), 'only the supplied values ride along');
});

test('host (debug G8): a contradictory focusEnabled/noFocus pair is normalised — focusEnabled wins', async t => {
  const captured = [];
  const host = makeHost(t, captured);
  const dir = tmpDir(t);
  await host.openNew({cwd: dir, focusEnabled: true, noFocus: true});
  assert.equal(captured[0].focusEnabled, true);
  assert.equal(captured[0].noFocus, false, 'noFocus is rewritten to agree with the explicit focusEnabled');
  await host.openNew({cwd: dir, focusEnabled: false, noFocus: false});
  assert.equal(captured[1].focusEnabled, false);
  assert.equal(captured[1].noFocus, true);
});

test('host (debug G9): opening an already-open conversation with different attach values flags the drop', async t => {
  const stored = new Map([['past-1', {id: 'past-1', cwd: 'C:\\old', turns: 3, account: 'default'}]]);
  const captured = [];
  const host = makeHost(t, captured, stored);
  const e1 = await host.openExisting('past-1', {maxAgents: 2});
  assert.equal(e1.attachDropped, undefined, 'the building open applies its values');
  await host.openExisting('past-1', {maxAgents: 2});
  assert.equal(e1.attachDropped, undefined, 'the same values again: nothing was dropped');
  const e3 = await host.openExisting('past-1', {maxAgents: 9});
  assert.equal(e3.attachDropped, true, 'different values for an open conversation are reported, not silently dropped');
});

test('host: bad attach values are a 400 before the factory runs', async t => {
  const captured = [];
  const host = makeHost(t, captured);
  const dir = tmpDir(t);
  await assert.rejects(() => host.openNew({cwd: dir, maxAgents: -1}), err => err instanceof HostError && err.status === 400);
  await assert.rejects(() => host.openNew({cwd: dir, maxAgentsTotal: 1.5}), err => err.status === 400);
  await assert.rejects(() => host.openNew({cwd: dir, focusEnabled: 'yes'}), err => err.status === 400);
  await assert.rejects(() => host.openExisting('past-1', {noFocus: 1}), err => err.status === 400);
  assert.equal(captured.length, 0, 'the factory never ran');
});

test('host over HTTP: POST /api/sessions carries the attach values; a bad one is a 400', async t => {
  const captured = [];
  const host = makeHost(t, captured);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-serverfirst-http-'));
  const server = new GuiServer({host, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json'), serverDiscoveryFile: path.join(dir, 'server.json'), accountsProvider: () => [], recentProvider: () => []});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  await server.start();
  const cwd = tmpDir(t);
  const created = await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd, maxAgents: 3, noFocus: false}});
  assert.equal(created.status, 201);
  assert.equal(captured[0].maxAgents, 3);
  assert.equal(captured[0].noFocus, false);
  assert.equal(captured[0].focusEnabled, true);
  const bad = await call(server, 'POST', '/api/sessions', {headers: AUTH, body: {cwd, maxAgents: 'three'}});
  assert.equal(bad.status, 400);
  assert.equal(captured.length, 1, 'the bad attach never reached the factory');
});
