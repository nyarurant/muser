'use strict';
// src/ui/remote-controller.mjs (remote/DESIGN.md step 4): the view-facing store
// seeded and fed by server snapshots/SSE, with keys turned into the protocol's
// POSTs. The client here is a scripted stub: it serves one v6 snapshot, records
// every request, and lets a test push events through the captured handlers.
const test = require('node:test');
const assert = require('node:assert');

function snapshot(patch = {}) {
  return {
    version: '9.9.9', cwd: 'C:\\work', mode: 'default', busy: false, queue: [],
    approval: null, approvalQueue: [], reasonFor: false, limitInput: null, menu: null,
    todos: [], agents: [], shells: [], focus: null, plan: null,
    account: {id: 'default', label: 'Main'}, muse: {name: 'kaguya'}, spinnerWord: null,
    session: {id: 'sess-1', turns: 3, title: 'Chat'}, clientStatus: 'connected',
    device: {name: 'mizuki CLI (muser)', slot: 2, connected: true}, update: null,
    live: {stream: {id: 'm1', started: true, partial: 'hello wor'}, running: null, bangRunning: null,
      status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 123, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}, {id: 2, type: 'user', text: 'hi'}],
    ...patch,
  };
}
function stubClient(snap = snapshot()) {
  return {
    info: {port: 1, token: 't'}, requests: [], handlers: null, eventsClosed: false,
    request(method, p, body) {
      this.requests.push({method, path: p, body});
      if (method === 'GET' && p.endsWith('/state')) return Promise.resolve({status: 200, json: snap});
      if (method === 'GET' && p.includes('/complete')) return Promise.resolve({status: 200, json: {items: [{text: '/help'}, {text: '/exit'}]}});
      return Promise.resolve({status: 202, json: {ok: true}});
    },
    events(id, handlers) { this.handlers = handlers; return () => { this.eventsClosed = true; }; },
    emit(ev) { this.handlers.onEvent(ev); },
    posts(p) { return this.requests.filter(r => r.method === 'POST' && (!p || r.path === p)); },
  };
}
async function started(snap) {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const client = stubClient(snap);
  const calls = {exit: 0, reload: 0};
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit: () => calls.exit++, onReload: () => calls.reload++});
  await ctrl.start();
  return {ctrl, client, calls};
}
const state = (ctrl, client, patch) => client.emit({kind: 'state', state: snapshot({...patch, entries: undefined})});

test('seeding: snapshot maps onto the flat state, the facade and previewRow', async () => {
  const {ctrl, client} = await started();
  const s = ctrl.get();
  assert.deepEqual(s.entries.map(e => e.id), [1, 2]);
  assert.equal(s.stream.partial, 'hello wor');
  assert.equal(s.busy, false); assert.equal(s.turnStart, 123); assert.equal(s.deviceOk, true); assert.equal(s.mode, 'default');
  assert.deepEqual(s.account, {id: 'default', label: 'Main'});
  const a = ctrl.agent;
  assert.equal(a.cwd, 'C:\\work');
  assert.deepEqual(a.session, {id: 'sess-1', turns: 3, title: 'Chat'});
  assert.equal(a.client.status, 'connected'); assert.equal(a.device.connected, true);
  assert.equal(a.nodeSlot.slot, 2); assert.equal(a.constructor.DEVICE, 'mizuki CLI (muser)');
  assert.equal(a.accountId, 'default'); assert.equal(a.accountLabel, 'Main');
  assert.equal(ctrl.museName, 'kaguya'); assert.equal(ctrl.version, '9.9.9');
  const preview = ctrl.previewRow();
  assert.equal(preview.first, false, 'stream already started');
  assert.match(preview.row.text, /hello wor/);
  assert.ok(client.handlers, 'events subscribed after the seed');
  ctrl.stop(); assert.equal(client.eventsClosed, true);
});

test('events: entry appends; entries-reset replaces, and every reset bumps clearCount', async () => {
  const {ctrl, client} = await started();
  client.emit({kind: 'entry', entry: {id: 3, type: 'user', text: 'more'}});
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [1, 2, 3]);
  const clears = ctrl.get().clearCount;
  client.emit({kind: 'entries-reset', entries: [{id: 9, type: 'banner'}]});
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [9]);
  assert.equal(ctrl.get().clearCount, clears + 1, 'a shorter reset remounts the scrollback');
  // Deep H3: the server sends entries-reset for ANY non-append replacement, not
  // only shrinks — a same-size or growing reset is a different conversation, so
  // it must clear too, or the old conversation stays on screen.
  client.emit({kind: 'entries-reset', entries: [{id: 9, type: 'banner'}, {id: 10, type: 'gap'}]});
  assert.equal(ctrl.get().clearCount, clears + 2, 'a growing reset clears too (deep H3)');
});

test('menu: arrows move the local highlight, enter posts {index}, esc and ctrl+c post {cancel:true}', async () => {
  const {ctrl, client} = await started();
  state(ctrl, client, {menu: {title: 'Pick', hint: null, index: 0, current: null, options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}, {value: 'c', label: 'C'}]}});
  assert.equal(ctrl.get().menu.index, 0, 'seeded from the snapshot');
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().menu.index, 1);
  assert.equal(client.posts().length, 0, 'arrows are local');
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {index: 1});
  // Deep H5: answering clears the local modal at once, so the esc / ctrl+c
  // cases below re-seed the menu from a fresh snapshot first (a repeated key
  // must not answer the NEXT modal).
  assert.equal(ctrl.get().menu, null, 'the answered menu is cleared locally');
  state(ctrl, client, {menu: {title: 'Pick', hint: null, index: 0, current: null, options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}, {value: 'c', label: 'C'}]}});
  ctrl.key('', {escape: true});
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {cancel: true});
  state(ctrl, client, {menu: {title: 'Pick', hint: null, index: 0, current: null, options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}, {value: 'c', label: 'C'}]}});
  ctrl.key('c', {ctrl: true});
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {cancel: true});
});

test('approval: enter maps the highlighted option (plain allow / always / autoEdit / deny)', async () => {
  const {ctrl, client} = await started();
  const approval = (id, options, index = 0) => state(ctrl, client, {approval: {call: {id, command: 'system.run', agent: 'main'}, preview: null, index, outside: false, options}});
  const last = () => client.posts('/api/s/sess-1/approval').at(-1).body;
  approval('c1', [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}]);
  ctrl.key('', {return: true});
  assert.deepEqual(last(), {decision: {allow: true}});
  approval('c2', [{label: 'はい', allow: true}, {label: '聞かない', allow: true, always: 'exec:git'}]);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().approval.index, 1, 'the highlight is local');
  ctrl.key('', {return: true});
  assert.deepEqual(last(), {decision: {allow: true, always: true}}, 'a string always goes as always: true (the server translates)');
  approval('c3', [{label: 'はい（編集は自動）', allow: true, autoEdit: true}]);
  ctrl.key('', {return: true});
  assert.deepEqual(last(), {decision: {allow: true, always: true}}, 'autoEdit maps the same way');
  approval('c4', [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}]);
  ctrl.key('', {downArrow: true}); ctrl.key('', {return: true});
  assert.deepEqual(last(), {decision: {allow: false}});
});

test('limitInput: digits edit the local echo, enter posts {value, key}, esc posts {cancel:true, key}', async () => {
  const {ctrl, client} = await started();
  state(ctrl, client, {limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '25', min: 1, max: 10000, hint: '1〜10000'}});
  ctrl.key('0', {});
  assert.equal(ctrl.get().limitInput.text, '250', 'typed digits stay local');
  assert.equal(client.posts().length, 0);
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts('/api/s/sess-1/limit').at(-1).body, {value: 250, key: 'maxToolCallsPerTurn'});
  assert.equal(ctrl.get().limitInput, null, 'the answered input is cleared locally (deep H5)');
  state(ctrl, client, {limitInput: {key: 'maxToolCallsPerTurn', label: '上限', text: '25', min: 1, max: 10000, hint: '1〜10000'}});
  ctrl.key('', {escape: true});
  assert.deepEqual(client.posts('/api/s/sess-1/limit').at(-1).body, {cancel: true, key: 'maxToolCallsPerTurn'});
});

test('reasonFor: enter posts the composer as the reason, esc posts an empty one', async () => {
  const {ctrl, client} = await started();
  state(ctrl, client, {reasonFor: true});
  assert.equal(ctrl.get().reasonFor, true);
  ctrl.setText('その変更は危ない');
  ctrl.key('', {return: true});
  assert.deepEqual(client.posts('/api/s/sess-1/approval').at(-1).body, {decision: {allow: false, reason: 'その変更は危ない'}});
  assert.equal(ctrl.get().text, '', 'the reason left the composer');
  assert.equal(ctrl.get().reasonFor, null, 'the answered reason prompt is cleared locally (deep H5)');
  state(ctrl, client, {reasonFor: true});
  ctrl.setText('x');
  ctrl.key('', {escape: true});
  assert.deepEqual(client.posts('/api/s/sess-1/approval').at(-1).body, {decision: {allow: false, reason: ''}});
});

test('/exit and /reload are local (never forwarded); /clear forwards and bumps clearCount', async () => {
  const {ctrl, client, calls} = await started();
  await ctrl.submit('/exit');
  assert.equal(calls.exit, 1);
  assert.equal(client.posts('/api/s/sess-1/send').length, 0, 'forwarding /exit would close the server conversation');
  await ctrl.submit('/quit');
  assert.equal(calls.exit, 2);
  await ctrl.submit('/reload');
  assert.equal(calls.reload, 1);
  assert.equal(client.posts('/api/s/sess-1/send').length, 0);
  const clears = ctrl.get().clearCount;
  await ctrl.submit('/clear');
  assert.equal(ctrl.get().clearCount, clears + 1);
  assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: '/clear'});
});

test('send: a plain message posts its text and attachments, then clears the attachments', async () => {
  const {ctrl, client} = await started();
  const att = {name: 'a.png', type: 'image/png', size: 3, data: 'AAAA'};
  ctrl.set({attachments: [att]});
  await ctrl.submit('hello');
  assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: 'hello', attachments: [att]});
  assert.deepEqual(ctrl.get().attachments, []);
  await ctrl.submit('again');
  assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: 'again'}, 'no attachments key when there are none');
});

test('ctrl+c picks its interrupt target: bang before turn; esc interrupts a turn', async () => {
  const {ctrl, client} = await started();
  const last = () => client.posts('/api/s/sess-1/interrupt').at(-1).body;
  ctrl.set({busy: true});
  ctrl.key('c', {ctrl: true});
  assert.deepEqual(last(), {target: 'turn'});
  ctrl.set({bangRunning: {call: {command: 'system.run'}, tail: []}});
  ctrl.key('c', {ctrl: true});
  assert.deepEqual(last(), {target: 'bang'}, 'bang wins when both are running');
  ctrl.set({bangRunning: null});
  ctrl.key('', {escape: true});
  assert.deepEqual(last(), {target: 'turn'}, 'esc while busy');
});

test('composer: typing, caret edits and history behave like the local Controller', async () => {
  const {ctrl, client} = await started();
  for (const ch of 'hi') ctrl.key(ch, {});
  assert.equal(ctrl.get().text, 'hi'); assert.equal(ctrl.get().pos, 2);
  ctrl.key('a', {ctrl: true}); assert.equal(ctrl.get().pos, 0);
  ctrl.key('', {backspace: true}); assert.equal(ctrl.get().text, 'hi', 'backspace at 0 changes nothing');
  ctrl.key('e', {ctrl: true}); ctrl.key('', {backspace: true});
  assert.equal(ctrl.get().text, 'h');
  ctrl.key('', {return: true}); // sends "h"
  assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: 'h'});
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().text, 'h', 'up recalls the sent line');
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().text, '', 'down returns to the draft');
  // paste keeps multi-line text at the caret
  ctrl.paste('a\nb');
  assert.equal(ctrl.get().text, 'a\nb');
});

async function startedWith(client) {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit: () => {}, onReload: () => {}});
  return ctrl;
}

test('#63: a failed send (404 for a closed conversation) keeps the attachments and returns the text to the composer', async () => {
  const client = stubClient();
  const base = client.request.bind(client);
  client.request = (method, p, body) => (p.endsWith('/send') ? Promise.resolve({status: 404, json: {error: 'session not open'}}) : base(method, p, body));
  const ctrl = await startedWith(client);
  await ctrl.start();
  const att = {name: 'a.png', type: 'image/png', size: 3, data: 'AAAA'};
  ctrl.set({attachments: [att]});
  const res = await ctrl.submit('do not lose me');
  assert.equal(res.status, 404, 'the failure is visible to the caller');
  assert.deepEqual(ctrl.get().attachments, [att], 'the attachments were NOT cleared on an error status');
  assert.equal(ctrl.get().text, 'do not lose me', 'the text went back into the composer instead of vanishing');
  ctrl.stop();
});

test('#67: a failed first start does not latch — start can be retried, and stop/start resubscribes', async () => {
  const client = stubClient();
  let stateCalls = 0, eventsCalls = 0;
  const base = client.request.bind(client);
  client.request = (method, p, body) => { if (method === 'GET' && p.endsWith('/state')) { stateCalls++; if (stateCalls === 1) return Promise.resolve({status: 500, json: {error: 'boom'}}); } return base(method, p, body); };
  const baseEvents = client.events.bind(client);
  client.events = (id, h) => { eventsCalls++; return baseEvents(id, h); };
  const ctrl = await startedWith(client);
  await assert.rejects(() => ctrl.start(), /boom/);
  await ctrl.start();
  assert.equal(eventsCalls, 1, 'the retry subscribed to events');
  assert.equal(ctrl.get().entries.length, 2, 'and seeded the snapshot');
  ctrl.stop();
  await ctrl.start();
  assert.equal(eventsCalls, 2, 'stop/start resubscribes instead of staying a zombie');
  ctrl.stop();
});

test('#68: modal identity needs more than a missing id / title+count / key — a different modal resets the local highlight', async () => {
  const {ctrl, client} = await started();
  const approval = (summary, index = 0) => state(ctrl, client, {approval: {call: {command: 'system.run', agent: 'main', summary}, preview: null, index, outside: false, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}]}});
  approval('first');
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().approval.index, 1);
  approval('first');
  assert.equal(ctrl.get().approval.index, 1, 'the SAME id-less approval keeps the highlight');
  approval('second');
  assert.equal(ctrl.get().approval.index, 0, 'a DIFFERENT id-less approval does not inherit it');
  const menu = labels => state(ctrl, client, {menu: {title: 'Pick', index: 0, options: labels.map(l => ({value: l, label: l}))}});
  menu(['A', 'B', 'C']);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().menu.index, 1);
  menu(['A', 'B', 'C']);
  assert.equal(ctrl.get().menu.index, 1, 'the same menu keeps the highlight');
  menu(['X', 'Y', 'Z']);
  assert.equal(ctrl.get().menu.index, 0, 'same title and count but different options is a different menu');
  state(ctrl, client, {limitInput: {key: 'k', label: '上限', text: '25', min: 1, max: 100}});
  ctrl.key('0', {});
  assert.equal(ctrl.get().limitInput.text, '250');
  state(ctrl, client, {limitInput: {key: 'k', label: '上限', text: '9', min: 1, max: 999}});
  assert.equal(ctrl.get().limitInput.text, '9', 'the same key with a different range is a new dialog: the old local echo is not kept');
  ctrl.stop();
});

test('completion glue: slash list is fetched once and cached; Tab cycles; @ picks quote and pad (t4 #6)', async () => {
  const {ctrl, client} = await started();
  await ctrl.refreshSlash();
  const fetches = () => client.requests.filter(r => r.method === 'GET' && r.path.includes('/complete'));
  assert.equal(fetches().length, 1, 'one /complete fetch (start() already asked)');
  assert.ok(fetches()[0].path.includes('kind=slash'), 'for the slash kind');
  await ctrl.refreshSlash();
  assert.equal(fetches().length, 1, 'cached: no second fetch');
  assert.deepEqual(ctrl.slashList('/'), ['/help', '/exit']);
  assert.deepEqual(ctrl.slashList('/h'), ['/help']);
  assert.deepEqual(ctrl.slashList('/x'), []);
  // Tab on a lone slash word cycles the candidates and wraps.
  ctrl.setText('/', 1);
  ctrl.completeTab(ctrl.get().text, ctrl.get().pos);
  assert.equal(ctrl.get().text, '/help');
  ctrl.completeTab(ctrl.get().text, ctrl.get().pos);
  assert.equal(ctrl.get().text, '/exit');
  ctrl.completeTab(ctrl.get().text, ctrl.get().pos);
  assert.equal(ctrl.get().text, '/help', 'the cycle wraps');
  // @ picks: whitespace is quoted, a trailing space follows a file pick, a
  // folder pick (trailing /) gets none, and the caret lands after the insert.
  ctrl.setText('see @fi', 7);
  ctrl.applyAtPick({start: 4, fragment: '@fi'}, 'my file.txt');
  assert.equal(ctrl.get().text, 'see "my file.txt" ');
  assert.equal(ctrl.get().pos, ctrl.get().text.length);
  ctrl.setText('see @do', 7);
  ctrl.applyAtPick({start: 4, fragment: '@do'}, 'docs/');
  assert.equal(ctrl.get().text, 'see docs/');
  assert.equal(ctrl.get().pos, ctrl.get().text.length);
  // atIndex wraps the highlight within the list and resets per fragment.
  ctrl.atPick = {key: '@a', idx: 5};
  assert.equal(ctrl.atIndex('@a', 3), 2, 'wraps modulo the list length');
  assert.equal(ctrl.atIndex('@b', 3), 0, 'a new fragment starts at the top');
  ctrl.stop();
});

test('no-ops and link-down: server-owned helpers stay harmless; a silent stream flags linkDown', async () => {
  const {ctrl, client} = await started();
  assert.equal(await ctrl.checkUpdate(), null);
  assert.equal(await ctrl.refreshPlan(), null);
  await ctrl.showResumed({id: 'x'}); // must not throw or duplicate entries
  assert.equal(ctrl.get().entries.length, 2);
  ctrl.linkDownDelayMs = 30;
  client.handlers.onClose();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(ctrl.get().linkDown, true);
  assert.ok(ctrl.get().flash, 'the user is told');
  client.emit({kind: 'entry', entry: {id: 5, type: 'gap'}});
  assert.equal(ctrl.get().linkDown, false, 'any event recovers the flag');
});
