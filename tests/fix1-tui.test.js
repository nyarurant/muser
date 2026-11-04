'use strict';
// Fix phase 1 (agent G): TUI-1 preview display rows, TUI-2 /resume reach,
// TUI-3 @ completion reach + count, deep H3/H4/H5 remote-controller,
// fourth H4 MCP approval, deep H22 picker reopen for a different ask.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Self-isolation, the controller.test.js pattern: never the real ~/.muser.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-home-'));

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';
const tmpDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
async function makeCtrl(agent) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null); // no muse.ai in tests
  return ctrl;
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function renderEl(el, columns) {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {strip} = require('../src/tui/term.js');
  return strip(renderToString(el, {columns}));
}

// ---------- TUI-1: preview capped by display rows ----------
test('TUI-1: a one-line preview at width 30 stays bounded (display rows, with an omitted note)', async () => {
  const React = (await import('react')).default;
  const {Question} = await import('../src/ui/view.mjs');
  const ctrl = await makeCtrl(new FakeAgent(tmpDir('muser-fix1-pv-')));
  const long = 'プレビュー'.repeat(120); // one logical line, no newlines
  ctrl.openQuestion({questions: [{header: 'Q', question: 'どれ？', multi: false, options: [{label: 'A', preview: long}, {label: 'B'}]}]});
  const out = await renderEl(React.createElement(Question, {q: ctrl.get().question, W: 29}), 30);
  const lines = out.split('\n');
  assert.ok(lines.length <= 24, 'the whole picker fits a 30-row terminal at width 30 (was 237 rows), got ' + lines.length);
  const m = /✂ (\d+) 行を省略/.exec(out);
  assert.ok(m, 'the omitted note shows');
  // The count is in display rows. Phase 2 (first audit B6) stacked the preview pane
  // full-width under the options instead of the old narrow side pane, so this
  // 600-character preview now wraps to ~60 display rows rather than 200+; the
  // hidden count must still exceed a whole 24-row terminal on its own.
  assert.ok(Number(m[1]) > 24, 'the hidden count is in display rows, got ' + m[1]);
});

test('TUI-1: a many-line preview is still capped at 8 display rows', async () => {
  const React = (await import('react')).default;
  const {Question} = await import('../src/ui/view.mjs');
  const ctrl = await makeCtrl(new FakeAgent(tmpDir('muser-fix1-pv2-')));
  const many = Array.from({length: 20}, (_, i) => 'line ' + (i + 1)).join('\n');
  ctrl.openQuestion({questions: [{header: 'Q', question: 'どれ？', multi: false, options: [{label: 'A', preview: many}, {label: 'B'}]}]});
  const out = await renderEl(React.createElement(Question, {q: ctrl.get().question, W: 79}), 80);
  assert.match(out, /✂ 12 行を省略/, '20 logical rows at a wide pane: 8 shown, 12 hidden');
  assert.ok(!out.includes('line 9'), 'the ninth row is not rendered');
});

// ---------- TUI-2: /resume reaches every session ----------
test('TUI-2: /resume menu holds all 15 sessions and digit keys pick #15', async () => {
  const sessions = require('../src/sessions');
  const dir = tmpDir('muser-fix1-resume-');
  const ctrl = await makeCtrl(new FakeAgent(dir));
  const list = Array.from({length: 15}, (_, i) => ({id: 'sess-' + (i + 1), title: 'chat ' + (i + 1), turns: 1, updated: Date.now() - i * 1000, cwd: dir}));
  const origRecent = sessions.recent, origFind = sessions.find;
  sessions.recent = () => list;
  sessions.find = id => list.find(s => s.id === id);
  const picked = [];
  ctrl.showResumed = async s => { picked.push(s); };
  try {
    await ctrl.slash('/resume');
    const menu = ctrl.get().menu;
    assert.ok(menu, 'the resume menu opens');
    assert.equal(menu.options.length, 15, 'no slice at 9: every session is in the menu');
    assert.equal(menu.options[14].value, 'sess-15');
    ctrl.key('1', {}); // buffered: 1 could still grow into 10-15
    assert.ok(ctrl.get().menu, 'the first digit alone does not pick yet');
    ctrl.key('5', {});
    assert.equal(ctrl.get().menu, null, 'the pick closes the menu');
    assert.deepEqual(picked.map(s => s && s.id), ['sess-15'], 'digits 1,5 reached session #15');
    await ctrl.slash('/resume 15');
    assert.deepEqual(picked.map(s => s && s.id), ['sess-15', 'sess-15'], '/resume 15 names the same line');
  } finally { sessions.recent = origRecent; sessions.find = origFind; }
});

// ---------- TUI-3: @ completion reaches all candidates ----------
function atDir12() {
  const dir = tmpDir('muser-fix1-at-');
  for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(dir, 'zzat' + String(i).padStart(2, '0') + '.txt'), 'x');
  return dir;
}
test('TUI-3: @ completion lists all 12 matches, tab cycles to the 7th, the footer shows the count', async () => {
  const dir = atDir12();
  const mention = require('../src/mentions');
  await mention.ready(dir);
  const ctrl = await makeCtrl(new FakeAgent(dir));
  ctrl.setText('@zzat', 5);
  const ctx = ctrl.atContext(ctrl.get().text, ctrl.get().pos);
  assert.equal(ctx.list.length, 12, 'atContext is not capped at 6');
  // Tab cycling reaches past the old cap.
  for (let i = 0; i < 7; i++) ctrl.key('', {tab: true});
  assert.equal(ctrl.get().text, '@zzat07.txt ', 'the 7th tab lands on the 7th candidate');
  // Arrows + the rendered footer: the window follows the highlight and the total is shown.
  const ctrl2 = await makeCtrl(new FakeAgent(dir));
  ctrl2.setText('@zzat', 5);
  for (let i = 0; i < 6; i++) ctrl2.key('', {downArrow: true});
  assert.equal(ctrl2.atIndex('zzat', 12), 6);
  const React = (await import('react')).default;
  const {Live} = await import('../src/ui/view.mjs');
  const out = await renderEl(React.createElement(Live, {s: ctrl2.get(), ctrl: ctrl2, W: 79}), 80);
  assert.match(out, /全 12 件中 7 件目/, 'the footer shows the total count and the position');
  assert.match(out, /◇ zzat07\.txt/, 'the window followed the highlight to the 7th candidate');
  assert.match(out, /ほか \d+ 件/, 'hidden candidates above or below are counted');
});

// ---------- remote-controller: H3 / H4 / H5 ----------
function remoteSnapshot(patch = {}) {
  return {
    version: '9.9.9', cwd: 'C:\\work', mode: 'default', busy: false, queue: [],
    approval: null, approvalQueue: [], reasonFor: false, limitInput: null, menu: null,
    todos: [], agents: [], shells: [], focus: null, plan: null,
    account: {id: 'default', label: 'Main'}, muse: {name: 'kaguya'}, spinnerWord: null,
    session: {id: 'sess-1', turns: 3, title: 'Chat'}, clientStatus: 'connected',
    device: {name: 'mizuki CLI (muser)', slot: 2, connected: true}, update: null,
    live: {stream: null, running: null, bangRunning: null, status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 0, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}, {id: 2, type: 'user', text: 'hi'}],
    ...patch,
  };
}
function stubClient(snap = remoteSnapshot()) {
  return {
    requests: [], handlers: null,
    request(method, p, body) {
      this.requests.push({method, path: p, body});
      if (method === 'GET' && p.endsWith('/state')) return Promise.resolve({status: 200, json: snap});
      if (method === 'GET' && p.includes('/complete')) return Promise.resolve({status: 200, json: {items: []}});
      return Promise.resolve({status: 202, json: {ok: true}});
    },
    events(id, handlers) { this.handlers = handlers; return () => {}; },
    emit(ev) { this.handlers.onEvent(ev); },
    posts(p) { return this.requests.filter(r => r.method === 'POST' && r.path === p); },
  };
}
async function startedRemote() {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const client = stubClient();
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit() {}, onReload() {}});
  await ctrl.start();
  return {ctrl, client};
}
const remoteState = (client, patch) => client.emit({kind: 'state', state: remoteSnapshot({...patch, entries: undefined})});

test('Deep H3: entries-reset always bumps clearCount (same-size and growing resets too)', async () => {
  const {ctrl, client} = await startedRemote();
  const clears = ctrl.get().clearCount;
  client.emit({kind: 'entries-reset', entries: [{id: 9, type: 'banner'}, {id: 10, type: 'gap'}]});
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [9, 10]);
  assert.equal(ctrl.get().clearCount, clears + 1, 'a same-size wholesale replacement clears');
  client.emit({kind: 'entries-reset', entries: [{id: 9, type: 'banner'}, {id: 10, type: 'gap'}, {id: 11, type: 'gap'}]});
  assert.equal(ctrl.get().clearCount, clears + 2, 'a growing reset clears too');
  ctrl.stop();
});

test('Deep H4: remote paste strips control sequences like the local controller', async () => {
  const {ctrl} = await startedRemote();
  ctrl.paste('safe\x1b]52;c;AAAA\x07text\x1b[31mred\x1b[0m');
  assert.equal(ctrl.get().text, 'safetextred');
  assert.ok(!ctrl.get().text.includes('\x1b'), 'no escape reaches the composer');
  ctrl.stop();
});

test('Deep H5: answering a remote modal clears it at once, so repeat keys cannot answer the next modal', async () => {
  const {ctrl, client} = await startedRemote();
  // approval
  remoteState(client, {approval: {call: {id: 'c1', command: 'system.run', agent: 'main'}, preview: null, index: 0, outside: false, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}]}});
  ctrl.key('', {return: true});
  assert.equal(client.posts('/api/s/sess-1/approval').length, 1);
  assert.equal(ctrl.get().approval, null, 'the answered approval is consumed locally');
  ctrl.key('', {return: true}); ctrl.key('1', {});
  assert.equal(client.posts('/api/s/sess-1/approval').length, 1, 'repeat keys post no second approval answer');
  ctrl.setText('');
  // menu
  remoteState(client, {menu: {title: 'Pick', index: 0, options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]}});
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {index: 0});
  assert.equal(ctrl.get().menu, null, 'the picked menu is consumed locally');
  ctrl.key('', {escape: true});
  assert.equal(client.posts('/api/s/sess-1/menu').length, 1, 'a repeat esc posts no cancel for a menu already answered');
  // limitInput
  remoteState(client, {limitInput: {key: 'k', label: '上限', text: '25', min: 1, max: 100}});
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts('/api/s/sess-1/limit').at(-1).body, {value: 25, key: 'k'});
  assert.equal(ctrl.get().limitInput, null, 'the answered limit input is consumed locally');
  ctrl.key('', {escape: true});
  assert.equal(client.posts('/api/s/sess-1/limit').length, 1, 'a repeat esc posts no cancel');
  // reasonFor (through the composer, as submitReason)
  remoteState(client, {reasonFor: true});
  ctrl.setText('その変更は危ない');
  ctrl.key('', {return: true});
  assert.equal(client.posts('/api/s/sess-1/approval').length, 2, 'the reason itself was posted');
  assert.equal(ctrl.get().reasonFor, null, 'the answered reason is consumed locally');
  ctrl.key('', {return: true});
  assert.equal(client.posts('/api/s/sess-1/approval').length, 2, 'a repeat enter posts no second reason');
  ctrl.stop();
});

// ---------- fourth H4: MCP approval ----------
test('Fourth H4: ask() for an mcp.* call opens the approval and key 1 answers allow', async () => {
  const ctrl = await makeCtrl(new FakeAgent(tmpDir('muser-fix1-mcp-')));
  const p = ctrl.ask({command: 'mcp.demo.echo', kind: 'mcp', params: {text: 'hi'}, mcp: {server: 'demo', tool: 'echo'}, summary: 'demo · echo', agent: 'main'});
  const a = ctrl.get().approval;
  assert.ok(a, 'the approval opens instead of throwing on TOOLS[command] being undefined');
  assert.equal(a.call.mcp.tool, 'echo');
  ctrl.key('1', {});
  assert.deepEqual(await p, {allow: true, always: null});
  assert.equal(ctrl.get().approval, null);
  // Without call.mcp the server/tool are derived from the command name, so the view can name them.
  const p2 = ctrl.ask({command: 'mcp.demo.echo', kind: 'mcp', params: {text: 'hi'}, agent: 'main'});
  assert.deepEqual(ctrl.get().approval.call.mcp, {server: 'demo', tool: 'echo'});
  ctrl.get().approval.resolve({allow: false});
  assert.deepEqual(await p2, {allow: false});
});

// ---------- deep H22: a different ask reopens the picker ----------
test('Deep H22: after answering one ask, a different ask (new id/round/revision) opens the picker again', async () => {
  const agent = new FakeAgent(tmpDir('muser-fix1-ask-'));
  const sent = [];
  agent.send = async body => { sent.push(body); };
  const ctrl = await makeCtrl(agent);
  const ask1 = {questions: [{header: '色', question: '色は？', multi: false, options: [{label: '赤'}, {label: '青'}]}]};
  const ask2 = {questions: [{header: '形', question: '形は？', multi: false, options: [{label: '丸'}, {label: '四角'}]}]};
  const focus1 = {id: 'f1', round: 1, revision: 1, status: 'needs_input', ask: ask1};
  agent.emit('turn-end', {ok: true, focus: focus1});
  assert.ok(ctrl.get().question, 'the first ask opens the picker');
  ctrl.key('', {return: true}); // pick 赤: a lone single-select question sends at once
  await tick();
  assert.equal(ctrl.get().question, null, 'answering closed the picker');
  assert.equal(sent.length, 1);
  agent.emit('turn-end', {ok: true, focus: focus1});
  assert.equal(ctrl.get().question, null, 'the SAME ask still does not reopen');
  agent.emit('turn-end', {ok: true, focus: {id: 'f2', round: 2, revision: 1, status: 'needs_input', ask: ask2}});
  assert.ok(ctrl.get().question, 'a different ask opens the picker again');
  assert.equal(ctrl.get().question.questions[0].question, '形は？');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().question, null, 'esc closes the second picker');
  agent.emit('turn-end', {ok: true, focus: {id: 'f2', round: 2, revision: 2, status: 'needs_input', ask: ask2}});
  assert.ok(ctrl.get().question, 'the same id with a new revision is a new ask and opens again');
  ctrl.key('', {escape: true});
});
