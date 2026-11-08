'use strict';
// GuiServer (docs/gui-protocol.md v1) against a fake Controller/Agent: the same
// subscribe/get/set store shape and ask() resolution values as the real Controller,
// without Ink, the gateway, or a device.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {execFileSync} = require('node:child_process');
const {GuiServer} = require('../src/gui-server');
const mention = require('../src/mentions');

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.cwd = 'C:\\work'; this.mode = 'default'; this.session = {id: 'sess-1', turns: 2};
    this.client = {status: 'connected'}; this.device = {connected: true}; this.nodeSlot = {slot: 2};
    this.interrupts = 0; this.killed = [];
    this.shells = {kill: id => { if (id !== 'bg1') throw new Error('No background shell ' + id); this.killed.push(id); return {id, killed: true}; }};
  }
  async interrupt() { this.interrupts++; }
}
FakeAgent.DEVICE = 'fake-device';

class FakeController {
  constructor(agent) {
    this.agent = agent; this.version = '9.9.9'; this.listeners = new Set(); this.submitted = [];
    this.s = {
      entries: [{id: 1, type: 'banner'}], busy: false, queue: [], approval: null, reasonFor: null,
      mode: 'default', shells: [{id: 'bg1', command: 'npm run dev', running: true, started: 1}], focus: null,
      todos: [{content: 'ship the GUI', status: 'in_progress'}],
      agents: [{tag: 'a1', state: 'running', title: 'slice 2'}],
      plan: {percentUsed: 42},
    };
    this.nextId = 2;
    // The real Controller's keepOutput store (controller.mjs this.outputs): plain
    // {id, at, command, summary, text} objects, newest last, NOT part of this.s.
    this.outputs = [];
    // v6: the real Controller's approval queue (this.pending, NOT part of this.s)
    // and the answerLimit / cancelMenu call log.
    this.pending = [];
    this.limitAnswers = [];
    this.menuCancels = 0;
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.s;
  set(patch) { this.s = {...this.s, ...patch}; for (const fn of this.listeners) fn(); }
  push(entry) { this.set({entries: [...this.s.entries, {id: this.nextId++, ...entry}]}); }
  async submit(text) { this.submitted.push(text); this.submittedAttachments = [...(this.s.attachments || [])]; this.push({type: 'user', text}); }
  // The real Controller.answerLimit, mirrored: null cancels through back(), a
  // number validates min/max (false, input stays open) then applies through done().
  answerLimit(value) {
    const edit = this.s.limitInput;
    if (!edit) return false;
    this.limitAnswers.push(value);
    if (value === null) { this.set({limitInput: null}); if (edit.back) edit.back(); return; }
    if (!Number.isSafeInteger(value) || value < 0 || (edit.min !== undefined && (value < edit.min || value > edit.max))) return false;
    this.set({limitInput: null});
    if (edit.done) edit.done(value);
  }
  // The real Controller.cancelMenu: close without picking, run cancel() if any.
  cancelMenu() { const m = this.s.menu; if (!m) return; this.menuCancels++; this.set({menu: null}); m.cancel?.(); }
  nextApproval() { this.promoted = (this.promoted || 0) + 1; }
  // The real Controller.submitReason: clears reasonFor and records the text.
  submitReason(text) { (this.reasons ||= []).push(text); this.set({reasonFor: null}); }
  setMode(m) { this.agent.mode = m; this.set({mode: m}); }
  // The real slashList filters COMMANDS by prefix; this fake's list is deliberately
  // smaller and differently ordered, so a test can tell the server used THIS list.
  slashList(text) { return ['/reload', '/resume', '/help'].filter(n => n.startsWith(text)); }
  // A pending ask in the real Controller's shape (controller.mjs ask()): the request the
  // state carries, with resolve() settling the promise ask() returned.
  askPending() {
    let settled = null;
    const req = {
      call: {command: 'system.run', agent: 'main', summary: 'npm test', params: {command: 'npm test'}},
      preview: null, index: 0, outside: false,
      options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}],
      resolve: v => { settled = v; },
    };
    this.set({approval: req});
    return {req, settled: () => settled};
  }
}

function makeServer(t) {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-'));
  const discoveryFile = path.join(dir, 'gui.json');
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {agent, controller, server, discoveryFile};
}
const AUTH = {authorization: 'Bearer test-token'};
function call(server, method, p, {headers = {}, body} = {}) {
  return fetch('http://127.0.0.1:' + server.port + p, {
    method, headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Collects SSE events from a fetch response as they arrive.
function eventStream(res) {
  const events = [], waiters = [];
  let buf = '';
  const reader = res.body.getReader(), decoder = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += decoder.decode(value, {stream: true});
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (line) { events.push(JSON.parse(line.slice(6))); for (const w of waiters.splice(0)) w(); }
        }
      }
    } catch {}
  })();
  return {
    events,
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > ms) throw new Error('timed out waiting for an SSE event; got ' + JSON.stringify(events));
        await new Promise(r => { waiters.push(r); setTimeout(r, 25); });
      }
    },
  };
}

test('requests without the token (or with a wrong one) are 401', async t => {
  const {server} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'GET', '/api/state')).status, 401);
  assert.equal((await call(server, 'GET', '/api/state', {headers: {authorization: 'Bearer nope'}})).status, 401);
  assert.equal((await call(server, 'POST', '/api/send', {body: {text: 'x'}})).status, 401);
  assert.equal((await call(server, 'GET', '/api/events')).status, 401);
});

test('GET /api/state returns the spec snapshot; the discovery file names it', async t => {
  const {server, discoveryFile} = makeServer(t);
  await server.start();
  const res = await call(server, 'GET', '/api/state', {headers: AUTH});
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.version, '9.9.9');
  assert.equal(state.cwd, 'C:\\work');
  assert.deepEqual(state.session, {id: 'sess-1', turns: 2, title: null});
  assert.equal(state.mode, 'default');
  assert.equal(state.busy, false);
  assert.deepEqual(state.queue, []);
  assert.equal(state.approval, null);
  assert.deepEqual(state.shells, [{id: 'bg1', command: 'npm run dev', running: true}]);
  assert.equal(state.focus, null);
  // v2: todos / agents / plan ride along as plain-JSON copies of the Controller state.
  assert.deepEqual(state.todos, [{content: 'ship the GUI', status: 'in_progress'}]);
  assert.deepEqual(state.agents, [{tag: 'a1', state: 'running', title: 'slice 2'}]);
  assert.deepEqual(state.plan, {percentUsed: 42});
  assert.deepEqual(state.entries, [{id: 1, type: 'banner'}]);
  // v4: who the user works with, and the spinner word Muse picked (none yet).
  assert.deepEqual(state.muse, {name: null});
  assert.equal(state.spinnerWord, null);
  // v6: the live block and friends, at their defaults when nothing is running.
  assert.deepEqual(state.live, {stream: null, running: null, bangRunning: null, status: '', activity: '', museRunning: '', agentWords: [], turnStart: 0, flash: '', deviceOk: false, loginNeeded: false});
  assert.equal(state.approvalQueue, 0);
  assert.equal(state.reasonFor, false);
  assert.equal(state.limitInput, null);
  assert.equal(state.clientStatus, 'connected');
  assert.deepEqual(state.device, {name: 'fake-device', slot: 2, connected: true});
  assert.equal(state.update, null);
  const found = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
  assert.equal(found.pid, process.pid);
  assert.equal(found.port, server.port);
  assert.equal(found.token, 'test-token');
  assert.equal(found.cwd, 'C:\\work');
  assert.equal(found.sessionId, 'sess-1');
  assert.equal(typeof found.startedAt, 'number');
  await server.close();
  assert.equal(fs.existsSync(discoveryFile), false, 'close removes the discovery file');
});

test('GET /api/state carries a selectable question: the choices in focus.ask and the picker state', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const ask = {questions: [{header: '猫', question: 'どの猫？', multi: false, options: [{label: '黒猫', description: '定番', preview: null}, {label: '三毛猫', description: null, preview: null}]}]};
  controller.set({focus: {id: 'f1', status: 'needs_input', ask}});
  controller.set({question: {questions: ask.questions, tab: 0, index: 1, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''}});
  const res = await call(server, 'GET', '/api/state', {headers: AUTH});
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.deepEqual(state.focus.ask, ask, 'the choices ride in the focus snapshot, as the TUI gets them');
  assert.equal(state.question.questions[0].options.length, 2);
  assert.equal(state.question.index, 1, 'the picker state crosses as plain data');
  controller.set({question: null, focus: null});
  const after = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(after.question, null, 'no picker open: null, like the menu');
});

test('v4: GET /api/muse-avatar serves the image set on muse.ai, fetched once; 404 without one', async t => {
  const {server, agent} = makeServer(t);
  const calls = [];
  agent.client = {async request(method, p, body, opts) {
    calls.push(p);
    if (p === '/identity') return {name: 'kaguya', avatar: {image_exists: true, image_path: 'workspace/avatars/a b.webp'}};
    if (p === '/fs/raw/workspace/avatars/a%20b.webp' && opts?.raw) return {contentType: 'image/webp', data: Buffer.from('WEBPDATA')};
    throw new Error('unexpected ' + p);
  }};
  await server.start();
  for (let i = 0; i < 2; i++) {
    const res = await call(server, 'GET', '/api/muse-avatar', {headers: AUTH});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'WEBPDATA');
  }
  assert.deepEqual(calls, ['/identity', '/fs/raw/workspace/avatars/a%20b.webp'], 'fetched once, then kept');
  assert.equal((await call(server, 'GET', '/api/muse-avatar')).status, 401, 'needs the token like every route');
  const {server: s4, agent: a4} = makeServer(t);
  const vcalls = [];
  a4.client = {async request(m, p, b, opts) {
    vcalls.push(p);
    if (p === '/identity') return {avatar: {video_exists: true, video_variants: {working: 'workspace/avatars/w.mp4'}}};
    if (p === '/fs/raw/workspace/avatars/w.mp4' && opts?.raw) return {contentType: 'video/mp4', data: Buffer.from('MP4')};
    throw new Error('unexpected ' + p);
  }};
  await s4.start();
  const v = await call(s4, 'GET', '/api/muse-avatar?video=working', {headers: AUTH});
  assert.equal(v.status, 200); assert.equal(v.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await v.arrayBuffer()).toString(), 'MP4');
  assert.equal((await call(s4, 'GET', '/api/muse-avatar?video=idle', {headers: AUTH})).status, 404, 'a variant the Muse does not have');
  assert.equal((await call(s4, 'GET', '/api/muse-avatar?video=../x', {headers: AUTH})).status, 400);
  assert.deepEqual(vcalls, ['/identity', '/fs/raw/workspace/avatars/w.mp4'], 'identity read once for every variant');
  const {server: s2, agent: a2} = makeServer(t);
  a2.client = {async request(m, p) { return p === '/identity' ? {name: 'x', avatar: {image_exists: false}} : null; }};
  await s2.start();
  assert.equal((await call(s2, 'GET', '/api/muse-avatar', {headers: AUTH})).status, 404);
  const {server: s3, agent: a3} = makeServer(t);
  a3.client = {async request(m, p) { return p === '/identity' ? {avatar: {image_path: 'workspace/../secret.png'}} : null; }};
  await s3.start();
  assert.equal((await call(s3, 'GET', '/api/muse-avatar', {headers: AUTH})).status, 404, 'a path that climbs out is refused');
});

test('v4: state carries the Muse name and the spinner word Muse picked', async t => {
  const {server, controller} = makeServer(t);
  controller.museName = 'kaguya';
  controller.set({spinnerWord: 'Pondering'});
  await server.start();
  const state = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.deepEqual(state.muse, {name: 'kaguya'});
  assert.equal(state.spinnerWord, 'Pondering');
});

test('SSE: initial state (no entries), then a forwarded entry and a state change', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch('http://127.0.0.1:' + server.port + '/api/events', {headers: AUTH, signal: ac.signal});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const stream = eventStream(res);
  const first = await stream.waitFor(e => e.kind === 'state');
  assert.equal(first.state.busy, false);
  assert.equal('entries' in first.state, false, 'SSE state events never carry entries');
  controller.push({type: 'note', lines: ['hello gui']});
  const entry = await stream.waitFor(e => e.kind === 'entry');
  assert.equal(entry.entry.type, 'note');
  assert.deepEqual(entry.entry.lines, ['hello gui']);
  controller.set({entries: [{id: 99, type: 'banner'}]});
  // #56: the connect-time entries-reset (current list at connect) also matches
  // a bare kind check, so wait for the reset that carries THIS replacement.
  const reset = await stream.waitFor(e => e.kind === 'entries-reset' && e.entries?.some(x => x.id === 99));
  assert.deepEqual(reset.entries, [{id: 99, type: 'banner'}]);
  controller.set({busy: true});
  const changed = await stream.waitFor(e => e.kind === 'state' && e.state.busy === true);
  assert.equal(changed.state.busy, true);
  ac.abort();
});

test('POST /api/send calls Controller.submit and answers 202', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const res = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'hello from gui'}});
  assert.equal(res.status, 202);
  assert.deepEqual(controller.submitted, ['hello from gui']);
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '  '}})).status, 400);
  assert.deepEqual(controller.submitted, ['hello from gui'], 'an empty text is not submitted');
});

test('POST /api/approval resolves the pending ask with the TUI values; 409 when none', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}}})).status, 409);
  // Allow: answer() resolves {allow: true, always: <key|null>} — a bare allow means null.
  const one = controller.askPending();
  // The snapshot carries the approval without its resolve function (not JSON, never sent).
  const snap = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(snap.approval.call.command, 'system.run');
  assert.equal(snap.approval.options.length, 2);
  assert.equal('resolve' in snap.approval, false);
  const res = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}}});
  assert.equal(res.status, 200);
  assert.deepEqual(one.settled(), {allow: true, always: null});
  assert.equal(controller.s.approval, null);
  assert.equal(controller.promoted, 1, 'the next queued approval is promoted');
  // Decline with a reason: submitReason() resolves {allow: false, reason}.
  const two = controller.askPending();
  const res2 = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: false, reason: 'not now'}}});
  assert.equal(res2.status, 200);
  assert.deepEqual(two.settled(), {allow: false, reason: 'not now'});
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}}})).status, 409);
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {yes: true}}})).status, 400);
});

test('snapshot approval carries loreGrave and the call tellClaim (integrate-1108 seam)', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const grave = {path: 'src/x.js', how: 'deleted', score: 0.9};
  controller.set({approval: {call: {command: 'code.write', agent: 'main', tellClaim: {name: 'peer-a', file: 'src/x.js', pid: 42}}, preview: null, index: 0, outside: false, loreGrave: grave, options: [{label: 'はい', allow: true}], resolve: () => {}}});
  const snap = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.deepEqual(snap.approval.loreGrave, grave);
  assert.equal(snap.approval.call.tellClaim.name, 'peer-a');
});

test('POST /api/approval translates always:true to the pending option (key or auto-edit)', async t => {
  const {server, controller, agent} = makeServer(t);
  await server.start();
  const pend = options => { let settled = null; controller.set({approval: {call: {command: 'system.run', agent: 'main'}, preview: null, index: 0, outside: false, options, resolve: v => { settled = v; }}}); return () => settled; };
  // An option carrying an always key: the boolean becomes that key.
  const keyed = pend([{label: 'はい', allow: true}, {label: 'いつも許可', allow: true, always: 'exec:git *'}, {label: 'いいえ', allow: false}]);
  const r1 = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true, always: true}}});
  assert.equal(r1.status, 200);
  assert.deepEqual(keyed(), {allow: true, always: 'exec:git *'});
  // The auto-edit option instead: the mode switches like the TUI, the value stays always: null.
  const auto = pend([{label: 'はい', allow: true}, {label: '編集は自動で許可', allow: true, autoEdit: true}, {label: 'いいえ', allow: false}]);
  const r2 = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true, always: true}}});
  assert.equal(r2.status, 200);
  assert.deepEqual(auto(), {allow: true, always: null});
  assert.equal(agent.mode, 'auto-edit');
});

test('POST /api/approval refuses an always key the pending approval never offered (audit #70)', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const pend = options => { let settled = null; controller.set({approval: {call: {command: 'system.run', agent: 'main'}, preview: null, index: 0, outside: false, options, resolve: v => { settled = v; }}}); return () => settled; };
  const settled = pend([{label: 'はい', allow: true}, {label: 'いつも許可', allow: true, always: 'exec:git status'}, {label: 'いいえ', allow: false}]);
  for (const forged of ['edit', 'exec:git push', 'mcp:other_tool']) {
    const r = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true, always: forged}}});
    assert.equal(r.status, 400, forged);
    assert.equal(settled(), null, 'a forged key does not resolve the approval');
  }
  const rAuto = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true, autoEdit: true}}});
  assert.equal(rAuto.status, 400, 'auto-edit was not offered either');
  const ok = await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true, always: 'exec:git status'}}});
  assert.equal(ok.status, 200);
  assert.deepEqual(settled(), {allow: true, always: 'exec:git status'}, 'the offered key still resolves as before');
});

test('POST /api/interrupt and /api/shell-kill reach the agent', async t => {
  const {server, agent} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {}})).status, 200);
  assert.equal(agent.interrupts, 1);
  const kill = await call(server, 'POST', '/api/shell-kill', {headers: AUTH, body: {id: 'bg1'}});
  assert.equal(kill.status, 200);
  assert.deepEqual(await kill.json(), {ok: true, id: 'bg1', killed: true});
  assert.deepEqual(agent.killed, ['bg1']);
  assert.equal((await call(server, 'POST', '/api/shell-kill', {headers: AUTH, body: {id: 'bg9'}})).status, 404);
  assert.equal((await call(server, 'GET', '/api/nope', {headers: AUTH})).status, 404);
});

test('GET /api/complete?kind=slash mirrors Controller.slashList', async t => {
  const {server} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'GET', '/api/complete?kind=slash&q=/re')).status, 401, 'completion keeps the Bearer auth');
  const res = await call(server, 'GET', '/api/complete?kind=slash&q=' + encodeURIComponent('/re'), {headers: AUTH});
  assert.equal(res.status, 200);
  const {items} = await res.json();
  // The fake's own list (not the real 24 COMMANDS): prefix-filtered, in definition order.
  assert.deepEqual(items.map(i => i.text), ['/reload', '/resume']);
  assert.equal(typeof items[0].desc, 'string');
  assert.ok(items[0].desc.length > 0, 'a known command carries its COMMANDS description');
  const none = await (await call(server, 'GET', '/api/complete?kind=slash&q=' + encodeURIComponent('/zzz'), {headers: AUTH})).json();
  assert.deepEqual(none.items, []);
  assert.equal((await call(server, 'GET', '/api/complete?kind=bogus&q=x', {headers: AUTH})).status, 400);
});

test('GET /api/complete?kind=file returns the cached @ candidates', async t => {
  const {server, agent} = makeServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-files-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const name of ['alpha.txt', 'alpine.md', 'beta.txt']) fs.writeFileSync(path.join(dir, name), 'x');
  agent.cwd = dir;
  await mention.ready(dir); // warm the mentions cache the way the TUI's first @ render does
  await server.start();
  const res = await call(server, 'GET', '/api/complete?kind=file&q=alp', {headers: AUTH});
  assert.equal(res.status, 200);
  const {items} = await res.json();
  assert.deepEqual(items, [{text: 'alpha.txt'}, {text: 'alpine.md'}]);
  const one = await (await call(server, 'GET', '/api/complete?kind=file&q=beta', {headers: AUTH})).json();
  assert.deepEqual(one.items, [{text: 'beta.txt'}]);
});

test('GET /api/complete?kind=agent|skill|instructions answers the pickers a phone cannot read from the PC', async t => {
  const {server, agent} = makeServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-pick-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  agent.cwd = dir;
  agent.types = () => ({general: {description: 'any', readOnly: false}, explore: {description: 'read', readOnly: true}, review: {description: 'rev', readOnly: true}});
  await server.start();
  assert.equal((await call(server, 'GET', '/api/complete?kind=agent&q=')).status, 401, 'pickers keep the Bearer auth');
  const types = await (await call(server, 'GET', '/api/complete?kind=agent&q=', {headers: AUTH})).json();
  assert.deepEqual(types.items.map(i => i.text), ['general', 'explore', 'review']);
  assert.deepEqual(types.items[1], {text: 'explore', desc: 'read', readOnly: true});
  const ex = await (await call(server, 'GET', '/api/complete?kind=agent&q=ex', {headers: AUTH})).json();
  assert.deepEqual(ex.items.map(i => i.text), ['explore']);
  // No instruction file yet, then AGENTS.md written.
  assert.deepEqual((await (await call(server, 'GET', '/api/complete?kind=instructions', {headers: AUTH})).json()).items, []);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# x');
  assert.deepEqual((await (await call(server, 'GET', '/api/complete?kind=instructions', {headers: AUTH})).json()).items, [{text: 'AGENTS.md'}]);
  const sk = await call(server, 'GET', '/api/complete?kind=skill&q=', {headers: AUTH});
  assert.equal(sk.status, 200);
  assert.ok(Array.isArray((await sk.json()).items));
});

// app-ui: the account registry routes the phone uses (the GUI runs the CLI for these).
function fakeAccountsAdmin() {
  const reg = {list: [{id: 'default', label: 'main'}, {id: 'sub', label: 'sub'}, {id: 'gone', label: 'old'}], active: 'default', auto: true};
  const accounts = {
    DEFAULT_ID: 'default',
    list: () => reg.list.map(a => ({...a})),
    get: id => reg.list.find(a => a.id === id) || null,
    activeId: () => reg.active,
    setActive: id => { reg.active = id; },
    rename: (id, label) => { if (reg.list.some(a => a.id !== id && a.label === label)) throw new Error('exists'); reg.list.find(a => a.id === id).label = label; },
    remove: id => { reg.list = reg.list.filter(a => a.id !== id); return {leftover: null}; },
    threshold: () => 90,
  };
  const pool = {
    autoEnabled: () => reg.auto,
    statuses: async () => reg.list.map(a => ({id: a.id, label: a.label, hasLogin: a.id !== 'gone', device: a.id === 'default', available: a.id === 'default', vm: a.id === 'gone' ? null : 'vm1',
      percentUsed: a.id === 'default' ? 42 : null, quotaStatus: null, plan: a.id === 'default' ? {plan: 'Pro', percentUsed: 42, resetsAt: 1700000000000} : null})),
  };
  return {reg, admin: {accounts, pool, setAuto: on => { reg.auto = on; }}};
}

test('/api/accounts lists, sets the default, toggles auto, renames and removes (not in use, not the first)', async t => {
  const agent = new FakeAgent(), controller = new FakeController(agent);
  agent.accountId = 'sub';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-acct-'));
  const {reg, admin} = fakeAccountsAdmin();
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json'), accountsAdmin: admin});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  await server.start();
  assert.equal((await call(server, 'GET', '/api/accounts')).status, 401, 'accounts keep the Bearer auth');
  const list = await (await call(server, 'GET', '/api/accounts', {headers: AUTH})).json();
  assert.equal(list.auto, true);
  assert.equal(list.defaultId, 'default');
  assert.equal(list.threshold, 90);
  assert.deepEqual(list.accounts.map(a => [a.id, a.isDefault, a.inUse, a.available, a.removable]), [['default', true, false, true, false], ['sub', false, true, false, true], ['gone', false, false, false, true]]);
  assert.equal(list.accounts[0].percentUsed, 42);
  assert.equal(list.accounts[0].planName, 'Pro');
  assert.equal(list.accounts[0].sharedMuse, true, 'two logins on one VM share one allowance');
  assert.equal(list.accounts[2].sharedMuse, false);
  assert.equal((await call(server, 'POST', '/api/accounts/default', {headers: AUTH, body: {id: 'sub'}})).status, 200);
  assert.equal(reg.active, 'sub');
  assert.equal((await call(server, 'POST', '/api/accounts/default', {headers: AUTH, body: {id: 'nope'}})).status, 404);
  assert.equal((await call(server, 'POST', '/api/accounts/auto', {headers: AUTH, body: {on: 'yes'}})).status, 400);
  assert.equal((await call(server, 'POST', '/api/accounts/auto', {headers: AUTH, body: {on: false}})).status, 200);
  assert.equal(reg.auto, false);
  assert.equal((await call(server, 'POST', '/api/accounts/rename', {headers: AUTH, body: {id: 'gone', label: 'main'}})).status, 400, 'a duplicate name is refused');
  assert.equal((await call(server, 'POST', '/api/accounts/rename', {headers: AUTH, body: {id: 'gone', label: 'spare'}})).status, 200);
  assert.equal(reg.list.find(a => a.id === 'gone').label, 'spare');
  assert.equal((await call(server, 'POST', '/api/accounts/remove', {headers: AUTH, body: {id: 'default'}})).status, 400, 'the first account stays');
  assert.equal((await call(server, 'POST', '/api/accounts/remove', {headers: AUTH, body: {id: 'sub'}})).status, 409, 'an account a conversation uses stays');
  assert.equal((await call(server, 'POST', '/api/accounts/remove', {headers: AUTH, body: {id: 'gone'}})).status, 200);
  assert.deepEqual(reg.list.map(a => a.id), ['default', 'sub']);
});

test('POST /api/account switches or adds; state.prompt / addFlow carry the add flow and /api/prompt answers it', async t => {
  const {server, controller} = makeServer(t);
  const calls = [];
  controller.accountCommand = async arg => { calls.push(['switch', arg]); };
  controller.addAccountFlow = async label => { calls.push(['add', label]); };
  let answered = null, cancelled = false;
  controller.submitPrompt = v => { answered = v; };
  controller.cancelPrompt = () => { cancelled = true; };
  await server.start();
  assert.equal((await call(server, 'POST', '/api/account', {headers: AUTH, body: {}})).status, 400);
  assert.equal((await call(server, 'POST', '/api/account', {headers: AUTH, body: {id: 'sub'}})).status, 202);
  assert.equal((await call(server, 'POST', '/api/account', {headers: AUTH, body: {add: ' work '}})).status, 202);
  assert.deepEqual(calls, [['switch', 'sub'], ['add', 'work']]);
  // No question waiting: the prompt route refuses.
  assert.equal((await call(server, 'POST', '/api/prompt', {headers: AUTH, body: {value: 'x'}})).status, 409);
  const st = controller.store?.s || controller.s;
  st.promptFor = {message: '認証コード', resolve() {}, reject() {}};
  st.addFlow = {lines: ['Edge でログインしてください'], busy: '登録しています'};
  const snap = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.deepEqual(snap.prompt, {message: '認証コード'});
  assert.deepEqual(snap.addFlow, {lines: ['Edge でログインしてください'], busy: '登録しています'});
  assert.equal((await call(server, 'POST', '/api/prompt', {headers: AUTH, body: {value: 7}})).status, 400);
  assert.equal((await call(server, 'POST', '/api/prompt', {headers: AUTH, body: {value: '123456'}})).status, 200);
  assert.equal(answered, '123456');
  assert.equal((await call(server, 'POST', '/api/prompt', {headers: AUTH, body: {cancel: true}})).status, 200);
  assert.equal(cancelled, true);
});

test('/api/settings reads the settings as data and applies one change (app-ui)', async t => {
  const {server, controller} = makeServer(t);
  const applied = [];
  controller.settingsModel = () => ({groups: ['作業の進め方'], items: [{key: 'bell', kind: 'switch', group: '作業の進め方', label: 'ベル', value: false}], skills: [], mcp: []});
  controller.applySetting = async (key, value) => {
    if (key === 'nope') { const e = new Error('unknown setting'); e.status = 404; throw e; }
    if (key === 'focusRounds' && value > 99) { const e = new Error('1〜99'); e.status = 400; throw e; }
    applied.push([key, value]); return controller.settingsModel();
  };
  await server.start();
  assert.equal((await call(server, 'GET', '/api/settings')).status, 401, 'settings keep the Bearer auth');
  const got = await (await call(server, 'GET', '/api/settings', {headers: AUTH})).json();
  assert.equal(got.items[0].key, 'bell');
  assert.equal((await call(server, 'POST', '/api/settings', {headers: AUTH, body: {value: true}})).status, 400, 'a key is required');
  assert.equal((await call(server, 'POST', '/api/settings', {headers: AUTH, body: {key: 'bell', value: true}})).status, 200);
  assert.deepEqual(applied, [['bell', true]]);
  assert.equal((await call(server, 'POST', '/api/settings', {headers: AUTH, body: {key: 'focusRounds', value: 1000}})).status, 400);
  assert.equal((await call(server, 'POST', '/api/settings', {headers: AUTH, body: {key: 'nope', value: 1}})).status, 404);
});

test('POST /api/mode sets a TUI mode name and 400s anything else', async t => {
  const {server, controller, agent} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/mode', {body: {mode: 'plan'}})).status, 401, 'mode keeps the Bearer auth');
  const res = await call(server, 'POST', '/api/mode', {headers: AUTH, body: {mode: 'plan'}});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {ok: true, mode: 'plan'});
  assert.equal(agent.mode, 'plan');
  assert.equal(controller.s.mode, 'plan');
  for (const mode of ['default', 'auto-edit', 'bypass']) {
    assert.equal((await call(server, 'POST', '/api/mode', {headers: AUTH, body: {mode}})).status, 200, mode);
    assert.equal(agent.mode, mode);
  }
  // Bogus values — and modeFrom's typed aliases — are not mode names: 400, mode untouched.
  for (const body of [{mode: 'bogus'}, {mode: 'yolo'}, {mode: 'auto'}, {mode: ''}, {}, {mode: 42}]) {
    assert.equal((await call(server, 'POST', '/api/mode', {headers: AUTH, body})).status, 400, JSON.stringify(body));
  }
  assert.equal(agent.mode, 'bypass', 'a rejected mode never reaches setMode');
});

// --- v3: /api/changes and /api/outputs ---------------------------------------------------

// The fixtures must not depend on the developer's global git config: a global
// commit.gpgsign=true makes every commit try (and fail or hang on) signing, and
// a global core.hooksPath can run arbitrary hooks on commit. Both helpers pin
// signing off and hooks to a per-process empty dir, and every git call gets a
// timeout so a stuck git fails the test instead of hanging the suite.
const emptyHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-nohooks-'));
process.on('exit', () => { try { fs.rmSync(emptyHooksDir, {recursive: true, force: true}); } catch {} });
const GIT_SAFE = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + emptyHooksDir.replace(/\\/g, '/')];
function gitIn(cwd, args) { return execFileSync('git', [...GIT_SAFE, ...args], {cwd, encoding: 'utf8', timeout: 60000}); }
function gitCommit(cwd, message) { return execFileSync('git', [...GIT_SAFE, '-c', 'user.name=Gui Test', '-c', 'user.email=gui@test.invalid', 'commit', '-qm', message], {cwd, encoding: 'utf8', timeout: 60000}); }

// A real temp repo: a committed file modified in the worktree, a new file staged,
// an untracked file, a pure rename, and one clean committed file (for the 404 check).
function makeGitRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-repo-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  gitIn(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'clean\n');
  fs.writeFileSync(path.join(dir, 'rename-src.txt'), 'same\ncontent\n');
  gitIn(dir, ['add', 'tracked.txt', 'clean.txt', 'rename-src.txt']);
  gitCommit(dir, 'base');
  fs.appendFileSync(path.join(dir, 'tracked.txt'), 'three\n');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'alpha\nbeta\n');
  gitIn(dir, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'loose\n');
  gitIn(dir, ['mv', 'rename-src.txt', 'rename-dst.txt']);
  return dir;
}

test('GET /api/changes lists a real repo: shape, statuses, counts and totals', async t => {
  const {server, agent} = makeServer(t);
  agent.cwd = makeGitRepo(t);
  await server.start();
  assert.equal((await call(server, 'GET', '/api/changes')).status, 401, 'changes keeps the Bearer auth');
  const res = await call(server, 'GET', '/api/changes', {headers: AUTH});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.repo, true);
  assert.equal(body.branch, 'main');
  for (const f of body.files) assert.deepEqual(Object.keys(f).sort(), ['added', 'deleted', 'path', 'status'], 'file entry shape for ' + f.path);
  const byPath = new Map(body.files.map(f => [f.path, f]));
  assert.deepEqual(byPath.get('tracked.txt'), {path: 'tracked.txt', status: 'modified', added: 1, deleted: 0});
  assert.deepEqual(byPath.get('staged.txt'), {path: 'staged.txt', status: 'added', added: 2, deleted: 0});
  assert.deepEqual(byPath.get('untracked.txt'), {path: 'untracked.txt', status: 'untracked', added: null, deleted: null});
  assert.deepEqual(byPath.get('rename-dst.txt'), {path: 'rename-dst.txt', status: 'renamed', added: 0, deleted: 0});
  assert.equal(byPath.has('clean.txt'), false, 'an unchanged file is not listed');
  assert.equal(body.added, 3, 'totals sum the non-null per-file counts');
  assert.equal(body.deleted, 0);
});

test('GET /api/changes?file= serves listed diffs only; untracked diff is null; unlisted is 404', async t => {
  const {server, agent} = makeServer(t);
  agent.cwd = makeGitRepo(t);
  await server.start();
  const tracked = await (await call(server, 'GET', '/api/changes?file=tracked.txt', {headers: AUTH})).json();
  assert.equal(tracked.repo, true);
  assert.equal(tracked.path, 'tracked.txt');
  assert.match(tracked.diff, /diff --git/);
  assert.match(tracked.diff, /\+three/);
  assert.equal('truncated' in tracked, false);
  const staged = await (await call(server, 'GET', '/api/changes?file=staged.txt', {headers: AUTH})).json();
  assert.match(staged.diff, /\+alpha/);
  const renamed = await (await call(server, 'GET', '/api/changes?file=rename-dst.txt', {headers: AUTH})).json();
  assert.match(renamed.diff, /rename from rename-src\.txt/);
  const untracked = await (await call(server, 'GET', '/api/changes?file=untracked.txt', {headers: AUTH})).json();
  assert.deepEqual(untracked, {repo: true, path: 'untracked.txt', diff: null});
  // Security: a committed-but-clean file, a missing file and a traversal attempt are
  // all outside the changed-files list, so none of them gets a diff.
  for (const p of ['clean.txt', 'missing.txt', '../outside.txt', 'tracked.txt/../../clean.txt']) {
    assert.equal((await call(server, 'GET', '/api/changes?file=' + encodeURIComponent(p), {headers: AUTH})).status, 404, p);
  }
});

test('GET /api/changes outside a repo is {repo: false} with 200; its diff form is 404', async t => {
  const {server, agent} = makeServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-norepo-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  agent.cwd = dir;
  await server.start();
  const res = await call(server, 'GET', '/api/changes', {headers: AUTH});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {repo: false});
  assert.equal((await call(server, 'GET', '/api/changes?file=anything.txt', {headers: AUTH})).status, 404);
});

test('GET /api/changes caps a diff at 200k chars and marks it truncated', async t => {
  const {server, agent} = makeServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-bigdiff-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  gitIn(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'big.txt'), 'start\n');
  gitIn(dir, ['add', 'big.txt']);
  gitCommit(dir, 'base');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(250000) + '\n');
  agent.cwd = dir;
  await server.start();
  const body = await (await call(server, 'GET', '/api/changes?file=big.txt', {headers: AUTH})).json();
  assert.equal(body.diff.length, 200000);
  assert.equal(body.truncated, true);
});

// A background-shell store in the real src/shells.js shape: Shells.get throws for an
// unknown id, Shells.output (the shell.output tool's accessor) returns
// {id, running, exit_code, output, next_offset} from an absolute offset.
function fakeShells() {
  const records = new Map([['bg1', {id: 'bg1', command: 'npm run dev', running: true, out: 'hello from shell\nsecond line\n'}]]);
  return {
    kill: id => { if (!records.has(id)) throw new Error('No background shell ' + id); return {id, killed: true}; },
    get(id) { const s = records.get(String(id)); if (!s) throw new Error('No background shell ' + id + ' (see shell.list)'); return s; },
    async output(id, {since = 0} = {}) { const s = this.get(id); const text = s.out.slice(since); return {id: s.id, running: s.running, exit_code: null, output: text, next_offset: since + text.length}; },
  };
}

test('GET /api/outputs mirrors Controller.outputs newest first, with synthesized ids only when missing', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.deepEqual(await (await call(server, 'GET', '/api/outputs', {headers: AUTH})).json(), {outputs: []});
  assert.equal((await call(server, 'GET', '/api/outputs')).status, 401, 'outputs keeps the Bearer auth');
  // The keepOutput item shape: {id, at, command, summary, text}; the third entry has
  // no id, so the server synthesizes a stable one from its timestamp and position.
  controller.outputs = [
    {id: 'call-1', at: 1000, command: 'system.run', summary: 'npm test', text: 'first output'},
    {id: 'call-2', at: 2000, command: 'code.read', summary: 'src/agent.js', text: 'second\noutput'},
    {at: 3000, command: 'shell.output', summary: 'bg1', text: 'third output'},
  ];
  const body = await (await call(server, 'GET', '/api/outputs', {headers: AUTH})).json();
  assert.deepEqual(body.outputs, [
    {id: 'output-3000-2', title: 'shell.output  bg1', text: 'third output'},
    {id: 'call-2', title: 'code.read  src/agent.js', text: 'second\noutput'},
    {id: 'call-1', title: 'system.run  npm test', text: 'first output'},
  ]);
});

test('GET /api/outputs?shell= returns the buffered shell output; unknown id is 404', async t => {
  const {server, agent} = makeServer(t);
  agent.shells = fakeShells();
  await server.start();
  assert.equal((await call(server, 'GET', '/api/outputs?shell=bg1')).status, 401, 'shell output keeps the Bearer auth');
  const res = await call(server, 'GET', '/api/outputs?shell=bg1', {headers: AUTH});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {shell: {id: 'bg1', command: 'npm run dev', running: true, text: 'hello from shell\nsecond line\n'}});
  assert.equal((await call(server, 'GET', '/api/outputs?shell=bg9', {headers: AUTH})).status, 404);
});

// --- v6: protocol 6, the live snapshot block, attachments, interrupt targets,
// entry paging, /limit and menu cancel (docs/gui-protocol.md v6) ----------------

test('v6: GET /api/server carries protocol 6', async t => {
  const {server} = makeServer(t);
  await server.start();
  const info = await (await call(server, 'GET', '/api/server', {headers: AUTH})).json();
  assert.equal(info.protocol, 6);
});

test('v6: snapshot live block, approval queue, limitInput, session title and update', async t => {
  const {server, controller, agent} = makeServer(t);
  agent.session.title = 'My chat';
  controller.pending = [{}, {}];
  controller.set({
    stream: {id: 'stream-1', started: 123, partial: 'x'.repeat(9000) + 'tail', done: 0, emitted: '', raw: 'raw'},
    running: {call: {id: 'c1', command: 'system.run'}, tail: ['a']},
    bangRunning: {call: {id: 'b1', command: 'system.run'}, tail: []},
    status: 'working', activity: 'reading a file', museRunning: 'searching', agentWords: {a1: 'Digging'},
    turnStart: 999, flash: 'hi there', deviceOk: true, loginNeeded: true,
    reasonFor: {resolve() {}},
    limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '250', min: 1, max: 1000, hint: '1〜1000', selected: true, back() {}, done() {}, limits: {concurrent: 4}},
    update: {latest: '0.4.0'},
  });
  await server.start();
  const state = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(state.session.title, 'My chat');
  assert.equal(state.live.stream.id, 'stream-1');
  assert.equal(state.live.stream.started, 123);
  assert.equal(state.live.stream.partial.length, 8192, 'the stream partial is cut to its last 8192 chars');
  assert.ok(state.live.stream.partial.endsWith('tail'));
  assert.deepEqual(Object.keys(state.live.stream).sort(), ['id', 'partial', 'started'], 'nothing else of the stream object crosses');
  assert.deepEqual(state.live.running, {call: {id: 'c1', command: 'system.run'}, tail: ['a']});
  assert.deepEqual(state.live.bangRunning, {call: {id: 'b1', command: 'system.run'}, tail: []});
  assert.equal(state.live.status, 'working');
  assert.equal(state.live.activity, 'reading a file');
  assert.equal(state.live.museRunning, 'searching');
  assert.deepEqual(state.live.agentWords, {a1: 'Digging'});
  assert.equal(state.live.turnStart, 999);
  assert.equal(state.live.flash, 'hi there');
  assert.equal(state.live.deviceOk, true);
  assert.equal(state.live.loginNeeded, true);
  assert.equal(state.approvalQueue, 2);
  assert.equal(state.reasonFor, true);
  // Only the renderable fields of limitInput cross — no back/done/limits closures.
  assert.deepEqual(state.limitInput, {key: 'maxToolCallsPerTurn', label: '上限', text: '250', min: 1, max: 1000, hint: '1〜1000'});
  assert.deepEqual(state.update, {latest: '0.4.0'});
});

test('v6: POST /api/send with attachments sets them on the Controller right before submit', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('PNGDATA')]);
  const data = pngBytes.toString('base64');
  const res = await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'look at this', attachments: [{name: 'a.png', type: 'image/png', data}]}});
  assert.equal(res.status, 202);
  assert.deepEqual(controller.submitted, ['look at this']);
  assert.deepEqual(controller.submittedAttachments, [{name: 'a.png', type: 'image/png', size: pngBytes.length, data}], 'the clipboard.js attachment shape, size from the decoded bytes');
});

test('v6: POST /api/send rejects off-spec attachments with 400 and submits nothing', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const one = {name: 'a.png', type: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]).toString('base64')};
  const bad = [
    {attachments: Array.from({length: 9}, () => one)},
    {attachments: [{...one, type: 'image/bmp'}]},
    {attachments: [{...one, data: 'not!base64'}]},
    {attachments: [{...one, data: ''}]},
    {attachments: 'nope'},
    // 11 MB + 1 decoded byte: over the total, still under the 16 MB body cap.
    {attachments: [{name: 'big.png', type: 'image/png', data: Buffer.alloc(11 * 1024 * 1024 + 1).toString('base64')}]},
  ];
  for (const extra of bad) {
    assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'hi', ...extra}})).status, 400, JSON.stringify(Object.keys(extra)));
  }
  assert.deepEqual(controller.submitted, []);
  // Over the route's own 16 MB body cap entirely: 413, not 400.
  const huge = {text: 'hi', attachments: [{name: 'h.png', type: 'image/png', data: Buffer.alloc(13 * 1024 * 1024).toString('base64')}]};
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: huge})).status, 413);
  assert.deepEqual(controller.submitted, []);
});

test('v6: POST /api/interrupt targets turn (default), bang and all; unknown is 400', async t => {
  const {server, controller, agent} = makeServer(t);
  await server.start();
  const bang = () => { const b = {aborted: false, abort() { this.aborted = true; }}; controller.bangStop = b; return b; };
  let b = bang();
  const turn = await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {}});
  assert.equal(turn.status, 200);
  assert.deepEqual(await turn.json(), {ok: true, target: 'turn'});
  assert.equal(agent.interrupts, 1);
  assert.equal(b.aborted, false, 'a turn interrupt leaves the !command alone');
  b = bang();
  const only = await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {target: 'bang'}});
  assert.equal(only.status, 200);
  assert.deepEqual(await only.json(), {ok: true, target: 'bang'});
  assert.equal(agent.interrupts, 1, 'a bang interrupt never touches the turn');
  assert.equal(b.aborted, true);
  b = bang();
  assert.equal((await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {target: 'all'}})).status, 200);
  assert.equal(agent.interrupts, 2);
  assert.equal(b.aborted, true);
  assert.equal((await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {target: 'nope'}})).status, 400);
  assert.equal(agent.interrupts, 2);
  // No bang running at all: still 200 (bangStop is simply absent).
  controller.bangStop = undefined;
  assert.equal((await call(server, 'POST', '/api/interrupt', {headers: AUTH, body: {target: 'bang'}})).status, 200);
});

test('v6: GET /api/entries pages the full entry list backwards from `before`', async t => {
  const {server, controller} = makeServer(t);
  controller.set({entries: Array.from({length: 10}, (_, i) => ({id: i + 1, type: 'note', n: i + 1}))});
  await server.start();
  assert.equal((await call(server, 'GET', '/api/entries')).status, 401, 'entries keeps the Bearer auth');
  const newest = await (await call(server, 'GET', '/api/entries?limit=3', {headers: AUTH})).json();
  assert.deepEqual(newest.entries.map(e => e.id), [8, 9, 10]);
  assert.equal(newest.hasMore, true);
  const older = await (await call(server, 'GET', '/api/entries?before=8&limit=3', {headers: AUTH})).json();
  assert.deepEqual(older.entries.map(e => e.id), [5, 6, 7]);
  assert.equal(older.hasMore, true);
  const first = await (await call(server, 'GET', '/api/entries?before=3&limit=500', {headers: AUTH})).json();
  assert.deepEqual(first.entries.map(e => e.id), [1, 2]);
  assert.equal(first.hasMore, false);
  const all = await (await call(server, 'GET', '/api/entries?limit=9999', {headers: AUTH})).json();
  assert.equal(all.entries.length, 10, 'the limit is clamped to 500, not an error');
  assert.equal((await call(server, 'GET', '/api/entries?before=999', {headers: AUTH})).status, 404);
});

// t5 #1 (deep audit): the clamp above was untestable with only 10 entries —
// limit=9999 returned 10 whether the cap was 500, 5000 or gone entirely. With
// MORE than 500 entries on hand the cap itself is what the answer must show.
test('v6: GET /api/entries clamps an oversized limit to exactly 500 entries', async t => {
  const {server, controller} = makeServer(t);
  controller.set({entries: Array.from({length: 505}, (_, i) => ({id: i + 1, type: 'note', n: i + 1}))});
  await server.start();
  const all = await (await call(server, 'GET', '/api/entries?limit=9999', {headers: AUTH})).json();
  assert.equal(all.entries.length, 500, 'limit=9999 is clamped to 500, so the page stays bounded');
  assert.deepEqual([all.entries[0].id, all.entries[all.entries.length - 1].id], [6, 505], 'the newest 500, not the oldest');
  assert.equal(all.hasMore, true, 'entries older than the page remain');
  const exact = await (await call(server, 'GET', '/api/entries?limit=500', {headers: AUTH})).json();
  assert.equal(exact.entries.length, 500, 'a limit of exactly 500 is honoured as-is');
});

// t5 #2 (deep audit): call() only ever sends JSON.stringify output, so the
// malformed-JSON branch of readBody and the default 1 MB body cap on routes
// other than /send were never exercised from this file.
test('v6: a malformed JSON body is a 400, and a non-/send route keeps the 1 MB body cap', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const raw = (p, body) => fetch('http://127.0.0.1:' + server.port + p, {method: 'POST', headers: {...AUTH, 'content-type': 'application/json'}, body});
  const bad = await raw('/api/mode', '{"mode": ');
  assert.equal(bad.status, 400, 'truncated JSON is refused, not hung or 500');
  assert.deepEqual(await bad.json(), {error: 'invalid JSON'});
  assert.equal(controller.s.mode, 'default', 'nothing was applied from the broken body');
  // 1 MB + slack of valid JSON on /api/mode (which uses the default cap, not
  // /send's 16 MB): 413 before any parsing or applying happens.
  const big = await raw('/api/mode', JSON.stringify({mode: 'default', pad: 'x'.repeat(1024 * 1024)}));
  assert.equal(big.status, 413, 'over the default 1 MB cap');
  assert.equal(controller.s.mode, 'default');
});

test('v6: POST /api/limit answers the pending limitInput through answerLimit', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 5}})).status, 409, 'nothing pending');
  let done = null, backed = 0;
  controller.set({limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '250', min: 1, max: 1000, hint: '1〜1000', done: v => { done = v; }, back: () => { backed++; }}});
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: '5', key: 'maxToolCallsPerTurn'}})).status, 400, 'a non-number value');
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 0, key: 'maxToolCallsPerTurn'}})).status, 400, 'out of range (answerLimit refused)');
  assert.ok(controller.s.limitInput, 'a refused value leaves the input open');
  const ok = await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 42, key: 'maxToolCallsPerTurn'}});
  assert.equal(ok.status, 200);
  assert.equal(done, 42);
  assert.equal(controller.s.limitInput, null);
  controller.set({limitInput: {key: 'x', label: 'x', text: '1', back: () => { backed++; }}});
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {cancel: true, key: 'x'}})).status, 200);
  assert.deepEqual(controller.limitAnswers, [0, 42, null], 'the route went through answerLimit every time (the string never reached it)');
  assert.equal(backed, 1, 'cancel runs the back() fallback like Esc');
  assert.equal(controller.s.limitInput, null);
});

test('v6: POST /api/menu {cancel: true} closes the menu like Esc; 409 when none', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {cancel: true}})).status, 409);
  let picked = null, cancelled = 0;
  controller.set({menu: {title: 't', index: 0, options: [{value: 'a', label: 'a'}], pick: v => { picked = v; }, cancel: () => { cancelled++; }}});
  const res = await call(server, 'POST', '/api/menu', {headers: AUTH, body: {cancel: true}});
  assert.equal(res.status, 200);
  assert.equal(controller.s.menu, null);
  assert.equal(controller.menuCancels, 1, 'closed through cancelMenu()');
  assert.equal(cancelled, 1, 'the menu cancel() ran, as on Esc');
  assert.equal(picked, null, 'nothing was picked');
});

test('v6: the REAL Controller answers /limit and menu cancel end to end', async t => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent();
  agent.session = {id: 'real-1', turns: 0, title: 'Real chat'};
  agent.ctx = {readFiles: new Set()};
  agent.allowAlways = new Set();
  agent.shells = {kill: id => ({id, killed: true})};
  const ctrl = new Controller({agent, museName: 'kaguya', version: '9.9.9', onExit() {}});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-real-'));
  const server = new GuiServer({controller: ctrl, agent, token: 'test-token', port: 0, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  await server.start();
  // An agent-limit edit (no done/back): applying reopens the limits menu with the new value.
  ctrl.set({limitInput: {key: 'concurrent', limits: {concurrent: 4, perTurn: 0}, text: '4', selected: true}});
  const snap = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.equal(snap.session.title, 'Real chat');
  assert.equal(snap.limitInput.key, 'concurrent');
  assert.equal(snap.clientStatus, 'connected');
  assert.deepEqual(snap.device, {name: 'fake-device', slot: 2, connected: true});
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 7, key: 'concurrent'}})).status, 200);
  assert.equal(ctrl.s.limitInput, null);
  assert.equal(ctrl.s.menu?.options?.[0]?.desc, '7', 'the limits menu reopened with the applied value');
  // A /settings-style edit (min/max + done): range and type are refused, a good value lands.
  let got = null;
  ctrl.set({menu: null, limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '250', min: 1, max: 1000, hint: '1〜1000', done: v => { got = v; }}});
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 0, key: 'maxToolCallsPerTurn'}})).status, 400);
  assert.ok(ctrl.s.limitInput, 'still open after a refused value');
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 42, key: 'maxToolCallsPerTurn'}})).status, 200);
  assert.equal(got, 42);
  assert.equal(ctrl.s.limitInput, null);
  // Menu cancel: Esc semantics — no pick, cancel() runs.
  let picked = null, cancelled = 0;
  ctrl.openMenu({title: 't', options: [{value: 'a', label: 'a'}], pick: v => { picked = v; }, cancel: () => { cancelled++; }});
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {cancel: true}})).status, 200);
  assert.equal(ctrl.s.menu, null);
  assert.equal(picked, null);
  assert.equal(cancelled, 1);
});

// --- audit 2026-11-03 section F (#69, #72-#86; #70/#71 are covered above) ------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const pngAtt = () => ({name: 'a.png', type: 'image/png', data: PNG.toString('base64')});

test('audit #69: a JSON null body is answered (400), never a hang', async t => {
  const {server} = makeServer(t);
  await server.start();
  // call() JSON.stringifies the body, so body: null sends the literal `null`.
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: null})).status, 400);
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: null})).status, 400);
  assert.equal((await call(server, 'POST', '/api/mode', {headers: AUTH, body: null})).status, 400);
});

test('audit #72: only a decline decision can answer a reason prompt', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  controller.set({reasonFor: {resolve() {}}});
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: true}}})).status, 400, 'an allow must not complete the reason wait');
  assert.equal(controller.reasons, undefined, 'submitReason was not called');
  assert.ok(controller.s.reasonFor, 'the reason prompt is still open');
  assert.equal((await call(server, 'POST', '/api/approval', {headers: AUTH, body: {decision: {allow: false, reason: 'not safe'}}})).status, 200);
  assert.deepEqual(controller.reasons, ['not safe']);
  assert.equal(controller.s.reasonFor, null);
});

test('audit #73: a menu value plain() cannot tell apart is refused as ambiguous', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  let picked = 'none';
  controller.set({menu: {title: 't', index: 0, options: [{value: undefined, label: 'undef'}, {value: null, label: 'null'}, {value: 'x', label: 'x'}], pick: v => { picked = v; }, cancel() {}}});
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {value: null}})).status, 400, 'undefined and null collapse to the same wire value');
  assert.equal(picked, 'none', 'no option was guessed');
  assert.ok(controller.s.menu, 'the menu stayed open');
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {value: 'x'}})).status, 200, 'an unambiguous value still picks');
  assert.equal(picked, 'x');
});

test('audit #74: a menu pick that throws synchronously restores the menu', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  let cancelled = 0;
  const menu = {title: 't', index: 0, options: [{value: 'a', label: 'a'}], pick: () => { throw new Error('pick boom'); }, cancel: () => { cancelled++; }};
  controller.set({menu});
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {index: 0}})).status, 500);
  assert.equal(controller.s.menu, menu, 'the menu was not consumed by the failed pick');
  assert.equal(cancelled, 0);
  assert.equal((await call(server, 'POST', '/api/menu', {headers: AUTH, body: {cancel: true}})).status, 200, 'the restored menu can still be cancelled');
  assert.equal(cancelled, 1);
});

test('audit #75/#76: /limit checks the input key and requires a safe integer', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  let done = null;
  controller.set({limitInput: {key: 'maxToolCallsPerTurn', label: 'x', text: '250', min: 1, max: 1000, done: v => { done = v; }, back() {}}});
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 42, key: 'otherKey'}})).status, 409, 'a stale dialog key is refused');
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {cancel: true, key: 'otherKey'}})).status, 409, 'a stale cancel is refused too');
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 42}})).status, 409, 'first #22: a missing key is refused too');
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {cancel: true}})).status, 409, 'first #22: a keyless cancel is refused too');
  assert.ok(controller.s.limitInput, 'the current input stayed open');
  const frac = await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 1.5, key: 'maxToolCallsPerTurn'}});
  assert.equal(frac.status, 400);
  assert.match((await frac.json()).error, /safe integer/, 'a fraction is not misreported as out of range');
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 9007199254740992, key: 'maxToolCallsPerTurn'}})).status, 400, 'an unsafe integer is refused at the API');
  assert.equal(done, null);
  assert.equal((await call(server, 'POST', '/api/limit', {headers: AUTH, body: {value: 42, key: 'maxToolCallsPerTurn'}})).status, 200, 'the matching key still answers');
  assert.equal(done, 42);
});

test('audit #77/#78/#79/#80: /send image-only, attachment placement, honest failures, magic bytes', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  // #77 + #80 happy path: no text, a real PNG.
  const only = await call(server, 'POST', '/api/send', {headers: AUTH, body: {attachments: [pngAtt()]}});
  assert.equal(only.status, 202, 'an image-only send is accepted');
  assert.deepEqual(controller.submitted, ['']);
  assert.equal(controller.submittedAttachments.length, 1);
  // #80: bytes that are not a PNG under a png label are refused.
  controller.submitted = [];
  const forged = {name: 'f.png', type: 'image/png', data: Buffer.from('definitely not a png').toString('base64')};
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'hi', attachments: [forged]}})).status, 400);
  assert.deepEqual(controller.submitted, []);
  // #78: an empty attachment list does not wipe TUI-prepared attachments.
  const preset = {name: 'tui.png', type: 'image/png', size: PNG.length, data: PNG.toString('base64')};
  controller.set({attachments: [preset]});
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'plain', attachments: []}})).status, 202);
  assert.deepEqual(controller.submittedAttachments, [preset], 'the prepared attachment rode the plain send');
  controller.set({attachments: []});
  // #78: attachments on a non-consuming path (a slash command) are refused, not parked.
  controller.submitted = [];
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: '/help', attachments: [pngAtt()]}})).status, 400);
  assert.deepEqual(controller.submitted, []);
  assert.deepEqual(controller.s.attachments, [], 'nothing leaked into the shared state');
  // #79: a full queue while busy is a 409, not a 202.
  controller.set({busy: true, queue: ['1', '2', '3', '4', '5']});
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'queued?'}})).status, 409);
  assert.deepEqual(controller.submitted, [], 'submit was not even called');
  controller.set({busy: false, queue: []});
  // #79: a submit that rejects at once is a 500, not a 202.
  const realSubmit = controller.submit.bind(controller);
  controller.submit = async () => { throw new Error('submit boom'); };
  assert.equal((await call(server, 'POST', '/api/send', {headers: AUTH, body: {text: 'hi'}})).status, 500);
  controller.submit = realSubmit;
});

test('audit #81/#82: /entries fractional limit progresses; one bad entry does not wipe the list', async t => {
  const {server, controller} = makeServer(t);
  controller.set({entries: [{id: 1, type: 'note'}, {id: 2, type: 'note', amount: 10n}, {id: 3, type: 'note'}]});
  await server.start();
  const state = await (await call(server, 'GET', '/api/state', {headers: AUTH})).json();
  assert.deepEqual(state.entries.map(e => e.id), [1, 2, 3], 'no entry is wiped by one bad field (#82)');
  assert.equal('amount' in state.entries[1], false, 'only the unserialisable field is dropped');
  const page = await (await call(server, 'GET', '/api/entries?limit=0.5', {headers: AUTH})).json();
  assert.equal(page.entries.length, 1, 'limit=0.5 clamps to one entry instead of an empty forever-page (#81)');
  assert.equal(page.hasMore, true);
  const next = await (await call(server, 'GET', '/api/entries?before=' + page.entries[0].id + '&limit=0.5', {headers: AUTH})).json();
  assert.equal(next.entries.length, 1, 'paging from there progresses');
  assert.notEqual(next.entries[0].id, page.entries[0].id);
});

test('audit #83: json() stringifies before writeHead, so a bad value is one clean 500', async t => {
  const {server} = makeServer(t);
  const calls = [];
  const res = {writableEnded: false, writeHead(status) { calls.push(['head', status]); }, end(body) { calls.push(['end', body]); this.writableEnded = true; }};
  server.json(res, 200, {v: 10n});
  assert.deepEqual(calls[0], ['head', 500], 'the head carries the failure status, not the intended 200');
  assert.equal(calls.length, 2, 'exactly one head and one body');
  assert.deepEqual(JSON.parse(calls[1][1]), {error: 'internal error'}, 'the body is a single valid JSON document');
});

test('audit #84/#85: /outputs caps list texts at 1 MB and keeps the shell truncated flag', async t => {
  const {server, controller, agent} = makeServer(t);
  await server.start();
  controller.outputs = [{id: 'big', at: 1, command: 'system.run', summary: 'big', text: 'x'.repeat(1024 * 1024 + 5)}];
  const list = await (await call(server, 'GET', '/api/outputs', {headers: AUTH})).json();
  assert.equal(list.outputs[0].text.length, 1024 * 1024);
  assert.equal(list.outputs[0].truncated, true);
  agent.shells = {
    kill: () => ({}),
    get: id => ({id, command: 'npm test', running: false}),
    output: async id => ({id, running: false, output: 'partial log', truncated: true}),
  };
  const shell = await (await call(server, 'GET', '/api/outputs?shell=bg1', {headers: AUTH})).json();
  assert.equal(shell.shell.text, 'partial log');
  assert.equal(shell.shell.truncated, true, 'a capped shell log is not presented as complete');
});

test('audit #86: the unborn-HEAD fallback fires only when HEAD is really unborn', async t => {
  const {server, agent} = makeServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-unborn-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  gitIn(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'alpha\nbeta\n');
  gitIn(dir, ['add', 'new.txt']);
  agent.cwd = dir;
  await server.start();
  const body = await (await call(server, 'GET', '/api/changes', {headers: AUTH})).json();
  assert.equal(body.repo, true);
  assert.deepEqual(body.files, [{path: 'new.txt', status: 'added', added: 2, deleted: 0}], 'unborn: staged counts come from the fallback, once');
  const diff = await (await call(server, 'GET', '/api/changes?file=new.txt', {headers: AUTH})).json();
  assert.match(diff.diff, /\+alpha/);
  // With HEAD reported as existing, a failing diff HEAD must NOT fall back.
  server.headExists = async () => true;
  const gated = await call(server, 'GET', '/api/changes?file=new.txt', {headers: AUTH});
  assert.equal(gated.status, 500, 'a HEAD diff failure is reported instead of masked by partial diffs');
});

test('audit #56: an SSE (re)connect re-syncs the entries added while it was away', async t => {
  const {server, controller} = makeServer(t);
  await server.start();
  const ac1 = new AbortController(); t.after(() => ac1.abort());
  const res1 = await fetch('http://127.0.0.1:' + server.port + '/api/events', {headers: AUTH, signal: ac1.signal});
  const s1 = eventStream(res1);
  const reset1 = await s1.waitFor(e => e.kind === 'entries-reset');
  assert.deepEqual(reset1.entries, [{id: 1, type: 'banner'}], 'connect itself syncs the current list');
  ac1.abort();
  await new Promise(r => setTimeout(r, 50));
  controller.push({type: 'note', lines: ['while away 1']});
  controller.push({type: 'note', lines: ['while away 2']});
  const ac2 = new AbortController(); t.after(() => ac2.abort());
  const res2 = await fetch('http://127.0.0.1:' + server.port + '/api/events', {headers: AUTH, signal: ac2.signal});
  const s2 = eventStream(res2);
  const reset2 = await s2.waitFor(e => e.kind === 'entries-reset');
  assert.deepEqual(reset2.entries.map(e => e.id), [1, 2, 3], 'entries added during the disconnect arrive on reconnect');
  assert.deepEqual(reset2.entries.slice(1).map(e => e.lines), [['while away 1'], ['while away 2']]);
  ac2.abort();
});

test('audit #64: a failed start() can be retried, and concurrent start() shares one attempt', async t => {
  const http = require('node:http');
  const blocker = http.createServer((req, res) => res.end('x'));
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(done => { blocker.closeAllConnections?.(); blocker.close(() => done()); }));
  const busyPort = blocker.address().port;
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const server = new GuiServer({controller, agent, token: 'test-token', port: busyPort, discoveryFile: path.join(dir, 'gui.json')});
  t.after(async () => { await server.close(); });
  await assert.rejects(server.start(), /EADDRINUSE/, 'the listen error reaches the caller');
  assert.equal(server.server, null, 'a failed start leaves no half-started server behind');
  assert.equal(server.port, null);
  await new Promise(done => blocker.close(done));
  await server.start();
  assert.equal(server.port, busyPort, 'the retry actually listens');
  assert.equal((await call(server, 'GET', '/api/state', {headers: AUTH})).status, 200);
  await server.close();
  const {server: s2} = makeServer(t);
  const p1 = s2.start(), p2 = s2.start();
  assert.equal(p1, p2, 'concurrent callers share the in-flight attempt');
  await p2;
  assert.ok(s2.port > 0, 'the second caller returns only once the port is known');
});

test('audit #65 (gui-server side): start() does not overwrite a live other server’s discovery files', async t => {
  const {spawn} = require('node:child_process');
  // The fixture must be a REAL answering server (fix2 A8/A34): ownership is no
  // longer decided by pid-liveness alone — start() probes the advertised port
  // and only a server that answers /api/server with the file's own pid owns
  // the file. A bare sleeper process on a dead port is indistinguishable from
  // a reused pid and its file is (correctly) treated as stale now.
  // The fixture prints its port as a STRING on purpose: under FORCE_COLOR
  // (which npm sets for scripts run in a terminal) console.log(number) wraps
  // the port in ANSI colour and the reader below never matches it.
  const childScript = "const http = require('http'); const s = http.createServer((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({pid: process.pid})); }); s.listen(0, '127.0.0.1', () => console.log(String(s.address().port))); setTimeout(() => {}, 30000);";
  const child = spawn(process.execPath, ['-e', childScript], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { try { child.kill(); } catch {} });
  const foreignPort = await new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('the fixture server did not report a port; output: ' + buf)), 15000);
    child.stdout.on('data', d => { buf += d; const m = buf.match(/(\d+)\r?\n/); if (m) { clearTimeout(timer); res(Number(m[1])); } });
    child.on('error', e => { clearTimeout(timer); rej(e); });
    child.on('exit', c => { clearTimeout(timer); rej(new Error('the fixture server exited early: ' + c + '; output: ' + buf)); });
  });
  const agent = new FakeAgent(), controller = new FakeController(agent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const guiFile = path.join(dir, 'gui.json'), srvFile = path.join(dir, 'server.json');
  const foreign = JSON.stringify({pid: child.pid, port: foreignPort, token: 'other-token', startedAt: 1});
  fs.writeFileSync(guiFile, foreign); fs.writeFileSync(srvFile, foreign);
  const server = new GuiServer({controller, agent, token: 'test-token', port: 0, discoveryFile: guiFile, serverDiscoveryFile: srvFile});
  t.after(async () => { await server.close(); });
  await server.start();
  assert.equal(fs.readFileSync(guiFile, 'utf8'), foreign, 'gui.json still names the live server, not this rival');
  assert.equal(fs.readFileSync(srvFile, 'utf8'), foreign, 'server.json still names the live server, not this rival');
  await server.close();
  child.kill();
  await new Promise(r => child.once('exit', r));
  const {server: s2} = makeServer(t);
  s2.discoveryFile = guiFile;
  await s2.start();
  const written = JSON.parse(fs.readFileSync(guiFile, 'utf8'));
  assert.equal(written.token, 'test-token', 'once the other pid is dead the file is stale and a start writes its own');
  assert.equal(written.pid, process.pid);
});

// app-md: GET /api/image serves one image from inside the conversation's
// working folder, and nothing else.
test('image route: workspace images only, sensitive and oversize refused', async t => {
  const {agent, server} = makeServer(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-gui-img-'));
  t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  agent.cwd = work;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(path.join(work, 'shot.png'), PNG);
  fs.mkdirSync(path.join(work, 'sub'));
  fs.writeFileSync(path.join(work, 'sub', 'pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]));
  fs.writeFileSync(path.join(work, 'fake.png'), Buffer.from('not a png at all'));
  fs.writeFileSync(path.join(work, '.env.png'), PNG); // sensitive basename with an image extension
  fs.writeFileSync(path.join(work, 'big.png'), Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
  // app-debug #5: a file whose NAME starts with '..' but lives inside.
  fs.writeFileSync(path.join(work, '..dots.png'), PNG);
  // app-debug #6: a hardlink inside the folder pointing at a file outside it.
  const outsidePng = path.join(path.dirname(work), 'outside-hard.png');
  fs.writeFileSync(outsidePng, PNG);
  t.after(() => fs.rmSync(outsidePng, {force: true}));
  fs.linkSync(outsidePng, path.join(work, 'hard.png'));
  await server.start();
  const get = p => call(server, 'GET', '/api/image?path=' + encodeURIComponent(p), {headers: AUTH});
  const ok = await get('shot.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
  const nested = await get('sub/pic.jpg');
  assert.equal(nested.status, 200);
  const abs = await get(path.join(work, 'shot.png'));
  assert.equal(abs.status, 200, 'an absolute path inside the folder also serves');
  assert.equal((await get('../outside.png')).status, 404, 'outside the folder is not served');
  assert.equal((await get(path.join(path.dirname(work), 'outside.png'))).status, 404);
  assert.equal((await get('.env.png')).status, 403, 'sensitive paths are refused');
  assert.equal((await get('fake.png')).status, 400, 'magic bytes must match the extension');
  assert.equal((await get('big.png')).status, 413, 'over the 8 MB cap');
  assert.equal((await get('missing.png')).status, 404);
  assert.equal((await get('..dots.png')).status, 200, 'app-debug #5: a name starting with .. inside the folder serves');
  assert.equal((await get('hard.png')).status, 404, 'app-debug #6: a hardlink to outside the folder is not served');
  assert.equal((await get('notes.txt')).status, 400, 'non-image extensions are refused');
  assert.equal((await call(server, 'GET', '/api/image', {headers: AUTH})).status, 400, 'path is required');
});
