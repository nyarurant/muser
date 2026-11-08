'use strict';
// Focus fix: the selectable-question picker (focus.ask_user with options)
// in a --client (remote) window. gui-server's snapshot carries `question`
// (the server-side Controller's picker state), but RemoteController used to
// have no `question` in its initial state, never copied it in
// applySnapshot, and had no question key handling — so the picker could
// never open remotely. These tests pin the passthrough (with the local
// interactive state surviving re-sent snapshots, like menu/approval), the
// key handling mirrored from the local Controller, and answering by
// POST /send with the composed reply, the way gui-server documents a
// client answers.
const test = require('node:test');
const assert = require('node:assert');

function question(patch = {}) {
  return {
    questions: [{header: '色', question: 'どの色？', multi: false, options: [{label: '赤'}, {label: '青'}]}],
    tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: '',
    ...patch,
  };
}
function snapshot(patch = {}) {
  return {
    version: '9.9.9', cwd: 'C:\\work', mode: 'default', busy: false, queue: [],
    approval: null, approvalQueue: 0, reasonFor: false, limitInput: null, menu: null, question: null,
    todos: [], agents: [], shells: [], focus: null, plan: null,
    account: {id: 'default', label: 'Main'}, muse: {name: 'kaguya'}, spinnerWord: null,
    session: {id: 'sess-1', turns: 3, title: 'Chat'}, clientStatus: 'connected',
    device: {name: 'mizuki CLI (muser)', slot: 2, connected: true}, update: null,
    live: {stream: null, running: null, bangRunning: null, status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 0, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}],
    ...patch,
  };
}
function stubClient(snap = snapshot()) {
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
    posts(p) { return this.requests.filter(r => r.method === 'POST' && (!p || r.path === p)); },
  };
}
async function started(snap) {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const client = stubClient(snap);
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit: () => {}, onReload: () => {}});
  await ctrl.start();
  return {ctrl, client};
}
const state = (client, patch) => client.emit({kind: 'state', state: snapshot({...patch, entries: undefined})});
const SEND = '/api/s/sess-1/send';

test('question: the initial state has the field, and a snapshot question reaches it with the view fields intact', async () => {
  const {ctrl, client} = await started();
  assert.equal(ctrl.get().question, null, 'initial state carries question: null (the local Controller shape)');
  state(client, {question: question()});
  const q = ctrl.get().question;
  assert.ok(q, 'the snapshot question is copied onto the state the view reads');
  assert.equal(q.questions[0].question, 'どの色？');
  assert.deepEqual(q.questions[0].options.map(o => o.label), ['赤', '青']);
  // Every field view.mjs Question() dereferences:
  for (const f of ['questions', 'tab', 'index', 'checked', 'picked', 'custom', 'answers', 'notes', 'mode', 'typeText']) assert.ok(f in q, 'field ' + f);
  state(client, {question: null});
  assert.equal(ctrl.get().question, null, 'a null snapshot closes it');
  ctrl.stop();
});

test('question: a snapshot seeded at start() opens the picker, and missing picker fields get the openQuestion defaults', async () => {
  const bare = {questions: [{question: 'Q？', options: [{label: 'A'}]}]};
  const {ctrl} = await started(snapshot({question: bare}));
  const q = ctrl.get().question;
  assert.equal(q.tab, 0); assert.equal(q.index, 0); assert.equal(q.mode, 'list');
  assert.deepEqual(q.checked, {}); assert.deepEqual(q.picked, {}); assert.deepEqual(q.custom, {});
  assert.deepEqual(q.answers, {}); assert.equal(q.notes, ''); assert.equal(q.typeText, '');
  ctrl.stop();
});

test('question: re-sent snapshots of the SAME question keep the local highlight and picks; a different question replaces them', async () => {
  const {ctrl, client} = await started();
  state(client, {question: question()});
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().question.index, 1);
  state(client, {question: question()});
  assert.equal(ctrl.get().question.index, 1, 'a debounced state frame must not reset the highlight to the server copy');
  const other = question({questions: [{header: '形', question: 'どの形？', multi: false, options: [{label: '丸'}, {label: '四角'}]}]});
  state(client, {question: other});
  assert.equal(ctrl.get().question.index, 0, 'a different question starts from the snapshot state');
  assert.equal(ctrl.get().question.questions[0].question, 'どの形？');
  ctrl.stop();
});

test('question: single select — enter on the highlight posts the composed reply to /send and consumes the picker', async () => {
  const {ctrl, client} = await started();
  state(client, {question: question()});
  ctrl.key('x', {});
  assert.equal(ctrl.get().text, '', 'keys go to the picker, not the composer');
  ctrl.key('', {downArrow: true});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question, null, 'answered: consumed at once');
  assert.deepEqual(client.posts(SEND).at(-1).body, {text: 'どの色？ → 青'});
  // The server still re-sends its own (stale) copy until the answer's turn
  // replaces it: that must not reopen the picker the user just answered.
  state(client, {question: question()});
  assert.equal(ctrl.get().question, null, 'the answered question is not reopened by a re-sent snapshot');
  state(client, {question: null});
  state(client, {question: question()});
  assert.ok(ctrl.get().question, 'after the server clears it, the same question can open again');
  ctrl.stop();
});

test('question: digit keys pick directly; esc closes locally with no post and frees the composer', async () => {
  const {ctrl, client} = await started();
  state(client, {question: question()});
  ctrl.key('1', {});
  assert.deepEqual(client.posts(SEND).at(-1).body, {text: 'どの色？ → 赤'});
  state(client, {question: null});
  state(client, {question: question()});
  const posts = client.posts().length;
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().question, null);
  assert.equal(client.posts().length, posts, 'esc posts nothing — a typed reply can still resume the task');
  state(client, {question: question()});
  assert.equal(ctrl.get().question, null, 'the closed question is not reopened by a re-sent snapshot');
  ctrl.key('a', {});
  assert.equal(ctrl.get().text, 'a', 'composer keys work again after closing');
  ctrl.stop();
});

test('question: multi select — space toggles, enter sends the checked labels; two questions advance through the Submit tab', async () => {
  const {ctrl, client} = await started();
  const two = question({questions: [
    {header: '色', question: 'どの色？', multi: true, options: [{label: '赤'}, {label: '青'}, {label: '緑'}]},
    {header: '形', question: 'どの形？', multi: false, options: [{label: '丸'}, {label: '四角'}]},
  ]});
  state(client, {question: two});
  ctrl.key(' ', {}); // check 赤 (index 0)
  ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true});
  ctrl.key(' ', {}); // check 緑 (index 2)
  assert.deepEqual(ctrl.get().question.checked[0], [0, 2]);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question.tab, 1, 'multi enter advances to the next question, no post yet');
  assert.equal(client.posts(SEND).length, 0);
  ctrl.key('2', {}); // 四角 on question 2
  assert.equal(ctrl.get().question.tab, 2, 'the last pick lands on the Submit tab');
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts(SEND).at(-1).body, {text: 'どの色？ → 赤、緑\nどの形？ → 四角'});
  assert.equal(ctrl.get().question, null);
  ctrl.stop();
});

test('question: an unanswered question blocks the Submit tab send and jumps to it', async () => {
  const {ctrl, client} = await started();
  const two = question({questions: [
    {header: '色', question: 'どの色？', multi: false, options: [{label: '赤'}, {label: '青'}]},
    {header: '形', question: 'どの形？', multi: false, options: [{label: '丸'}, {label: '四角'}]},
  ]});
  state(client, {question: two});
  ctrl.key('', {tab: true}); ctrl.key('', {tab: true});
  assert.equal(ctrl.get().question.tab, 2, 'tab reaches the Submit tab');
  ctrl.key('', {return: true});
  assert.equal(client.posts(SEND).length, 0, 'nothing is sent while a question is unanswered');
  assert.equal(ctrl.get().question.tab, 0, 'and the picker jumps to the first unanswered one');
  assert.ok(ctrl.get().flash, 'the user is told why');
  ctrl.stop();
});

test('question: type-something — enter opens the editor, typing + enter answers a single question; paste lands in the editor', async () => {
  const {ctrl, client} = await started();
  state(client, {question: question()});
  ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().question.index, 2, 'the type-something row follows the options');
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question.mode, 'type');
  ctrl.paste('紫\nです');
  assert.equal(ctrl.get().question.typeText, '紫 です', 'paste is flattened into the picker editor, not the composer');
  ctrl.key('', {backspace: true}); ctrl.key('', {backspace: true});
  for (const ch of 'むらさき') ctrl.key(ch, {});
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts(SEND).at(-1).body, {text: 'どの色？ → 紫 むらさき'});
  assert.equal(ctrl.get().question, null);
  ctrl.stop();
});

test('question: notes — n edits a note that rides along with the answer', async () => {
  const {ctrl, client} = await started();
  state(client, {question: question()});
  ctrl.key('n', {});
  assert.equal(ctrl.get().question.mode, 'notes');
  for (const ch of 'memo') ctrl.key(ch, {});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question.mode, 'list');
  assert.equal(ctrl.get().question.notes, 'memo');
  ctrl.key('1', {});
  assert.deepEqual(client.posts(SEND).at(-1).body, {text: 'どの色？ → 赤\nメモ: memo'});
  ctrl.stop();
});

test('question: paste in list mode is swallowed by the picker (it does not reach the composer)', async () => {
  const {ctrl, client} = await started();
  state(client, {question: question()});
  ctrl.paste('hello');
  assert.equal(ctrl.get().text, '', 'no paste into the hidden composer');
  assert.equal(ctrl.get().question.typeText, '', 'and none into the closed editor');
  ctrl.stop();
});
