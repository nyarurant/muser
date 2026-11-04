'use strict';
// fix2 (agent A12): remote-controller.mjs Medium findings — c8 #4-#10,
// first #24 (ctrl+shift+v) and #25 (ctrl+o). Same scripted-stub style as
// tests/remote-controller.test.js. Repro: audit2/fix2/repro-A12.mjs
// (13 FAIL before, only its c8#8 column expectation was wrong — see the
// multi-line test below).
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
    live: {stream: null, running: null, bangRunning: null, status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 0, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}],
    ...patch,
  };
}
function stub(opts = {}) {
  return {
    requests: [], handlers: null, sendGates: null,
    request(method, p, body) {
      this.requests.push({method, path: p, body});
      if (method === 'GET' && p.endsWith('/state')) return Promise.resolve({status: 200, json: opts.snap || snapshot()});
      if (method === 'GET' && p.includes('/complete')) return Promise.resolve({status: 200, json: {items: []}});
      if (method === 'GET' && p.endsWith('/outputs')) return Promise.resolve({status: 200, json: {outputs: opts.outputs || []}});
      if (method === 'POST' && p.endsWith('/send') && opts.gateSend) return new Promise(res => { (this.sendGates ||= []).push(() => res({status: 202, json: {ok: true}})); });
      return Promise.resolve({status: 202, json: {ok: true}});
    },
    events(id, h) { this.handlers = h; return () => {}; },
    emit(ev) { this.handlers.onEvent(ev); },
    posts(p) { return this.requests.filter(r => r.method === 'POST' && r.path === p); },
    releaseSend() { for (const g of (this.sendGates || []).splice(0)) g(); },
  };
}
async function started(opts) {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const client = stub(opts);
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit: () => {}, onReload: () => {}});
  await ctrl.start();
  return {ctrl, client};
}
const state = (client, patch) => client.emit({kind: 'state', state: snapshot({...patch, entries: undefined})});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const menu12 = () => ({title: 'Pick', index: 0, options: Array.from({length: 12}, (_, i) => ({value: 'v' + i, label: 'L' + i}))});

test('c8#4: a buffered digit does not land on a different menu, but still lands when the same menu is re-sent', async () => {
  const {ctrl, client} = await started();
  state(client, {menu: menu12()});
  ctrl.key('1', {}); // buffers '1', timer armed for index 0
  state(client, {menu: {title: 'Other', index: 0, options: [{value: 'x', label: 'X'}, {value: 'y', label: 'Y'}]}});
  await sleep(500);
  assert.equal(client.posts('/api/s/sess-1/menu').length, 0, 'a different menu must not receive the buffered pick');
  state(client, {menu: menu12()});
  ctrl.key('1', {});
  state(client, {menu: menu12()}); // the SAME menu re-sent as a new object by a state frame
  await sleep(500);
  const posts = client.posts('/api/s/sess-1/menu');
  assert.equal(posts.length, 1, 'the same menu re-sent still receives it');
  assert.deepEqual(posts[0].body, {index: 0});
  ctrl.stop();
});

test('c8#4: browsing with the arrows cancels a buffered digit', async () => {
  const {ctrl, client} = await started();
  state(client, {menu: menu12()});
  ctrl.key('1', {});
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().menu.index, 1, 'the arrow still moves the highlight');
  await sleep(500);
  assert.equal(client.posts('/api/s/sess-1/menu').length, 0, 'the buffered digit was cancelled by browsing');
  ctrl.stop();
});

test('c8#5: a second submit while a send is in flight does not re-post the attachments', async () => {
  const {ctrl, client} = await started({gateSend: true});
  const att = {name: 'a.png', type: 'image/png', size: 3, data: 'AAAA'};
  ctrl.set({attachments: [att]});
  const p1 = ctrl.submit('');
  const p2 = ctrl.submit('');
  client.releaseSend();
  await p1; await p2;
  assert.equal(client.posts('/api/s/sess-1/send').length, 1, 'only one /send went out');
  assert.deepEqual(ctrl.get().attachments, [], 'the sent attachment is cleared on 2xx');
  const p3 = ctrl.submit('next'); // the guard is released once the flight ends
  client.releaseSend();
  await p3;
  assert.equal(client.posts('/api/s/sess-1/send').length, 2);
  ctrl.stop();
});

test('c8#5: an attachment added while a send is in flight survives that send clearing', async () => {
  const {ctrl, client} = await started({gateSend: true});
  const a1 = {name: 'a.png', type: 'image/png', size: 3, data: 'AAAA'};
  const a2 = {name: 'b.png', type: 'image/png', size: 3, data: 'BBBB'};
  ctrl.set({attachments: [a1]});
  const p1 = ctrl.submit('hi');
  ctrl.set({attachments: [...ctrl.get().attachments, a2]});
  client.releaseSend();
  await p1;
  assert.deepEqual(ctrl.get().attachments, [a2], 'only the sent attachment was removed');
  ctrl.stop();
});

test('c8#6: while a decline reason is typed, keys and paste go to the composer, not a menu that opened meanwhile', async () => {
  const {ctrl, client} = await started();
  state(client, {reasonFor: true, menu: {title: 'Pick', index: 0, options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]}});
  ctrl.key('x', {});
  assert.equal(ctrl.get().text, 'x');
  assert.equal(client.posts('/api/s/sess-1/menu').length, 0, 'the key did not pick from the menu');
  ctrl.paste('理由テキスト');
  assert.ok(ctrl.get().text.includes('理由'), 'paste reaches the reason composer too');
  ctrl.stop();
});

test('c8#6: ctrl+c and ctrl+d while a reason is pending submit an empty reason instead of arming an exit', async () => {
  const {ctrl, client} = await started();
  state(client, {reasonFor: true});
  ctrl.key('c', {ctrl: true});
  let posts = client.posts('/api/s/sess-1/approval');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, {decision: {allow: false, reason: ''}});
  assert.equal(ctrl.get().reasonFor, null, 'the reason wait is resolved');
  state(client, {reasonFor: true});
  ctrl.setText('下書き');
  ctrl.key('d', {ctrl: true});
  posts = client.posts('/api/s/sess-1/approval');
  assert.equal(posts.length, 2, 'ctrl+d resolves it too, even with text in the composer');
  assert.deepEqual(posts[1].body, {decision: {allow: false, reason: ''}});
  ctrl.stop();
});

test('c8#7: a local flash survives a state frame carrying flash:"", and a later server flash is not erased by the local timer', async () => {
  const {ctrl, client} = await started();
  ctrl.flash('ローカル通知', 2500);
  state(client, {});
  assert.equal(ctrl.get().flash, 'ローカル通知', 'the snapshot flash:"" did not erase the local notice');
  ctrl.flash('短い通知', 40);
  const live = {...snapshot().live, flash: 'サーバー通知'};
  client.emit({kind: 'state', state: snapshot({live, entries: undefined})});
  assert.equal(ctrl.get().flash, 'サーバー通知', 'a real server flash replaces the local one');
  await sleep(80);
  assert.equal(ctrl.get().flash, 'サーバー通知', 'the expired local timer did not erase the server flash');
  ctrl.stop();
});

test('c8#8: up/down move the caret between lines of a multi-line draft, keeping the column', async () => {
  const {ctrl} = await started();
  // 'abc\nde\nfghi': pos 6 is line 2 ('de'), column 2. (repro-A12 expected
  // column 1 / pos 1 here, which contradicts its own down-check; the local
  // Controller's algorithm — copied here — keeps the column: 6 -> 2 -> 6.)
  ctrl.setText('abc\nde\nfghi', 6);
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().pos, 2, 'up: same column on the previous line');
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, 6, 'down: back to the same column');
  ctrl.setText('a\nlongline', 1);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, 3, 'down clamps to a shorter line start + column');
  ctrl.stop();
});

test('c8#9: backspace/delete/caret move by grapheme cluster, not code point', async () => {
  const {ctrl} = await started();
  const fam = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // family ZWJ emoji, one cluster
  ctrl.setText(fam);
  ctrl.key('', {backspace: true});
  assert.equal(ctrl.get().text, '', 'backspace removes the whole ZWJ cluster');
  ctrl.setText('a\u{1F1EF}\u{1F1F5}'); // 'a' + flag (regional-indicator pair)
  ctrl.key('', {backspace: true});
  assert.equal(ctrl.get().text, 'a', 'backspace removes the whole flag');
  ctrl.setText(fam + 'x');
  ctrl.key('', {leftArrow: true});
  assert.equal(ctrl.get().pos, fam.length, 'left arrow crosses the whole cluster at once');
  ctrl.key('', {rightArrow: true});
  assert.equal(ctrl.get().pos, fam.length + 1);
  ctrl.setText(fam, 0);
  ctrl.key('', {delete: true});
  assert.equal(ctrl.get().text, '', 'delete removes the whole cluster forward');
  ctrl.stop();
});

test('c8#10: snapshot promptFor / addFlow / accountReserved map onto the state (and clear again)', async () => {
  const {ctrl, client} = await started();
  state(client, {promptFor: {message: 'コードを入力'}, addFlow: {lines: ['hi'], busy: null}, accountReserved: 'Sub'});
  const s = ctrl.get();
  assert.deepEqual(s.promptFor, {message: 'コードを入力'});
  assert.deepEqual(s.addFlow, {lines: ['hi'], busy: null});
  assert.equal(s.accountReserved, 'Sub');
  state(client, {promptFor: null, addFlow: null, accountReserved: null});
  assert.equal(ctrl.get().promptFor, null);
  assert.equal(ctrl.get().addFlow, null);
  assert.equal(ctrl.get().accountReserved, null);
  ctrl.stop();
});

test('first#24: ctrl+shift+v routes to pasteFromClipboard; a right-click does too, a left-click does not', async () => {
  const {ctrl} = await started();
  assert.equal(typeof ctrl.pasteFromClipboard, 'function');
  let pasted = 0, imaged = 0;
  ctrl.pasteFromClipboard = () => { pasted++; };
  ctrl.pasteImage = () => { imaged++; };
  ctrl.key('V', {ctrl: true, shift: true});
  assert.equal(pasted, 1, 'ctrl+shift+v pastes whatever the clipboard holds');
  assert.equal(imaged, 0, 'it is not the image-only paste');
  ctrl.key('v', {ctrl: true});
  assert.equal(imaged, 1, 'plain ctrl+v stays image-only');
  ctrl.key('\x1b[<2;10;5M', {});
  assert.equal(pasted, 2, 'a right-button press pastes');
  ctrl.key('\x1b[<0;10;5M', {});
  assert.equal(pasted, 2, 'a left-button press is swallowed, not pasted');
  assert.equal(ctrl.get().text, '', 'mouse sequences never land in the composer');
  ctrl.stop();
});

test('first#25: ctrl+o fetches /outputs and shows the newest as a note entry; empty still flashes the no-output message', async () => {
  const {ctrl, client} = await started({outputs: [{id: 'o1', title: 'system.run  ls', text: 'file1\nfile2'}]});
  await ctrl.key('o', {ctrl: true});
  assert.ok(client.requests.some(r => r.method === 'GET' && r.path.endsWith('/outputs')), 'ctrl+o asked the server');
  const notes = ctrl.get().entries.filter(e => e.type === 'note');
  assert.equal(notes.length, 1);
  assert.ok(notes[0].lines.join('\n').includes('file1'), 'the output text is shown');
  assert.ok(notes[0].lines.join('\n').includes('system.run'), 'headed by its title');
  ctrl.stop();
  const empty = await started({outputs: []});
  await empty.ctrl.key('o', {ctrl: true});
  assert.equal(empty.ctrl.get().flash, 'まだ PC 操作の出力はありません。', 'no outputs on the server: the old message, now truthful');
  assert.equal(empty.ctrl.get().entries.filter(e => e.type === 'note').length, 0);
  empty.ctrl.stop();
});
