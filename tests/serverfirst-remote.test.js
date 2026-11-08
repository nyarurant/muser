'use strict';
// Server-first parity for src/ui/remote-controller.mjs (investigation CL
// section 1, client-side items): $skill completion, /lang local apply,
// ctrl+d interrupts, menu side/group keys, the history read-failure guard,
// /entries paging, ctrl+o file saving, the paste guard, and question
// answers carrying a questionId with a 409 note. The client is a scripted
// stub like tests/remote-controller.test.js uses; no resident server, no
// real Muse.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function snapshot(patch = {}) {
  return {
    version: '9.9.9', cwd: 'C:\\work', mode: 'default', busy: false, queue: [],
    approval: null, approvalQueue: [], reasonFor: false, limitInput: null, menu: null, question: null,
    todos: [], agents: [], shells: [], focus: null, plan: null,
    account: {id: 'default', label: 'Main'}, muse: {name: 'kaguya'}, spinnerWord: null,
    session: {id: 'sess-1', turns: 3, title: 'Chat'}, clientStatus: 'connected',
    device: {name: 'mizuki CLI (muser)', slot: 2, connected: true}, update: null,
    live: {stream: null, running: null, bangRunning: null,
      status: '', activity: '', museRunning: '', agentWords: {}, turnStart: 0, flash: '', deviceOk: true, loginNeeded: false},
    entries: [{id: 1, type: 'banner'}, {id: 2, type: 'user', text: 'hi'}],
    ...patch,
  };
}
// routes(method, path, body) may return a response to override the default.
function stubClient(snap = snapshot(), routes = null) {
  return {
    info: {port: 1, token: 't'}, requests: [], handlers: null, eventsClosed: false,
    request(method, p, body) {
      this.requests.push({method, path: p, body});
      if (routes) { const r = routes(method, p, body); if (r) return Promise.resolve(r); }
      if (method === 'GET' && p.endsWith('/state')) return Promise.resolve({status: 200, json: snap});
      if (method === 'GET' && p.includes('/complete')) return Promise.resolve({status: 200, json: {items: [{text: '/help'}, {text: '/exit'}]}});
      return Promise.resolve({status: 202, json: {ok: true}});
    },
    events(id, handlers) { this.handlers = handlers; return () => { this.eventsClosed = true; }; },
    emit(ev) { this.handlers.onEvent(ev); },
    posts(p) { return this.requests.filter(r => r.method === 'POST' && (!p || r.path === p)); },
    gets(p) { return this.requests.filter(r => r.method === 'GET' && r.path.includes(p)); },
  };
}
async function started(snap, routes) {
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const client = stubClient(snap, routes);
  const calls = {exit: 0, reload: 0};
  const ctrl = new RemoteController({client, sessionId: 'sess-1', version: '9.9.9', onExit: () => calls.exit++, onReload: () => calls.reload++});
  await ctrl.start();
  return {ctrl, client, calls};
}
const state = (client, patch) => client.emit({kind: 'state', state: snapshot({...patch, entries: undefined})});

test('$ completion: candidates come from the local skills files; ↑↓, enter, tab and esc behave like the local Controller', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-sf-skills-'));
  for (const [name, desc] of [['alpha-one', 'Alpha one'], ['alpha-two', 'Alpha two'], ['beta-one', 'Beta one']]) {
    const sd = path.join(dir, '.claude', 'skills', name);
    fs.mkdirSync(sd, {recursive: true});
    fs.writeFileSync(path.join(sd, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n# ' + name + '\n');
  }
  const {ctrl} = await started(snapshot({cwd: dir}));
  try {
    ctrl.setText('$al', 3);
    const ctx = ctrl.dollarContext(ctrl.get().text, ctrl.get().pos);
    assert.ok(ctx, 'a $fragment at the caret opens a context');
    assert.deepEqual(ctx.list.map(s => s.name), ['alpha-one', 'alpha-two'], 'enabled skills starting with the fragment, in name order');
    assert.equal(ctx.list[0].description, 'Alpha one', 'the view draws the description');
    assert.equal(ctx.noSkills, false);
    assert.equal(ctrl.dollarIndex('al', ctx.list.length), 0, 'a new fragment starts at the top');
    ctrl.key('', {downArrow: true});
    assert.equal(ctrl.dollarIndex('al', 2), 1, 'down moves the highlight in the skill list, not history');
    ctrl.key('', {return: true});
    assert.equal(ctrl.get().text, '$alpha-two ', 'enter completes to $name + space instead of sending');
    ctrl.setText('$be', 3);
    ctrl.completeTab(ctrl.get().text, ctrl.get().pos);
    assert.equal(ctrl.get().text, '$beta-one ', 'tab completes the highlighted $skill');
    ctrl.setText('$al', 3);
    assert.ok(ctrl.dollarContext('$al', 3), 'the list is open again for the fragment');
    ctrl.key('', {escape: true});
    assert.equal(ctrl.dollarContext('$al', 3), null, 'esc dismisses the list for this fragment');
    assert.equal(ctrl.get().text, '$al', 'and does not clear the draft');
    assert.equal(ctrl.dollarContext('plain', 5), null, 'no $fragment, no context');
  } finally { ctrl.stop(); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('/lang: a language argument is applied in this process AND still forwarded; a bare /lang changes nothing locally', async () => {
  const i18n = require('../src/i18n.js');
  const {ctrl, client} = await started();
  try {
    assert.equal(i18n.lang(), 'ja', 'tests pin Japanese at setup');
    await ctrl.submit('/lang en');
    assert.equal(i18n.lang(), 'en', 'the client window switches at once');
    assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: '/lang en'}, 'still forwarded to the server');
    i18n.setLang('ja');
    await ctrl.submit('/lang');
    assert.equal(i18n.lang(), 'ja', 'a bare /lang (the server menu) leaves the local language alone');
    assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: '/lang'});
    await ctrl.submit('/lang 日本語');
    assert.equal(i18n.lang(), 'ja', 'the Japanese spellings map too');
  } finally { i18n.setLang('ja'); ctrl.stop(); }
});

test('ctrl+d: bang and busy interrupt like ctrl+c; only an idle empty composer arms the exit', async () => {
  const {ctrl, client, calls} = await started();
  const last = () => client.posts('/api/s/sess-1/interrupt').at(-1).body;
  ctrl.set({busy: true});
  ctrl.key('d', {ctrl: true});
  assert.deepEqual(last(), {target: 'turn'}, 'ctrl+d interrupts a running turn');
  assert.equal(calls.exit, 0);
  ctrl.set({bangRunning: {call: {command: 'system.run'}, tail: []}});
  ctrl.key('d', {ctrl: true});
  // serverfirst-debug R15: with BOTH running the TURN is interrupted
  // first — the local Controller's order (the old expectation pinned
  // the inverted remote order, where the bang command won).
  assert.deepEqual(last(), {target: 'turn'}, 'the turn wins over the bang command, as in the local Controller');
  ctrl.set({busy: false});
  ctrl.key('d', {ctrl: true});
  assert.deepEqual(last(), {target: 'bang'}, 'with no turn running, ctrl+d stops the bang command');
  ctrl.set({bangRunning: null, busy: false});
  ctrl.setText('draft');
  const before = client.posts('/api/s/sess-1/interrupt').length;
  ctrl.key('d', {ctrl: true});
  assert.equal(client.posts('/api/s/sess-1/interrupt').length, before, 'with a draft and nothing running, ctrl+d does nothing');
  assert.equal(ctrl.get().text, 'draft');
  ctrl.setText('');
  ctrl.key('d', {ctrl: true});
  assert.equal(calls.exit, 0, 'the first idle ctrl+d only arms');
  ctrl.key('d', {ctrl: true});
  assert.equal(calls.exit, 1, 'the second exits');
  ctrl.stop();
});

test('key order (debug R3): with a menu and a limit input both open, keys go to the menu the user sees', async () => {
  const menu = {title: 'Menu', options: [{label: 'One', value: '1'}, {label: 'Two', value: '2'}], index: 0};
  const {ctrl, client} = await started(snapshot({menu, limitInput: {key: 'k1', label: '上限', text: '5', min: 0, max: 9}}));
  ctrl.key('2', {});
  assert.equal(client.posts('/api/s/sess-1/menu').length, 1, 'the digit picked from the menu');
  assert.equal(client.posts('/api/s/sess-1/limit').length, 0, 'the limit input did not take the key');
  assert.equal(ctrl.get().limitInput.text, '5', 'the limit text is untouched');
  ctrl.stop();
});

test('menu: ←/→ forward {key, side} through POST /menu without consuming the menu; group/side ride the snapshot and the fingerprint', async () => {
  const {ctrl, client} = await started();
  const menu = group => ({title: '会話を再開', hint: null, index: 0, current: null, side: true, options: [{value: 'a', label: 'A', group}, {value: 'b', label: 'B', group}]});
  state(client, {menu: menu('このフォルダー')});
  assert.equal(ctrl.get().menu.side, true, 'the side flag survives the snapshot');
  assert.equal(ctrl.get().menu.options[0].group, 'このフォルダー', 'option groups survive for the view headers');
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().menu.index, 1);
  state(client, {menu: menu('このフォルダー')});
  assert.equal(ctrl.get().menu.index, 1, 'the same menu (same groups) keeps the highlight');
  state(client, {menu: menu('ほかのフォルダー')});
  assert.equal(ctrl.get().menu.index, 0, 'a group change is a different menu: the highlight resets');
  ctrl.key('', {leftArrow: true});
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {key: 'left', side: -1});
  assert.ok(ctrl.get().menu, 'a page turn does not consume the local menu');
  ctrl.key('', {rightArrow: true});
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {key: 'right', side: 1});
  ctrl.stop();
});

test('history guard: a corrupt history file is backed up aside and recording resumes; a readable one still merges', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-sf-history-'));
  const file = path.join(dir, 'history.json');
  const savedEnv = process.env.MUSER_HISTORY_FILE;
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const make = () => new RemoteController({client: stubClient(), sessionId: 'sess-1', version: '9.9.9', onExit: () => {}, onReload: () => {}});
  try {
    process.env.MUSER_HISTORY_FILE = file;
    fs.writeFileSync(file, 'not json{');
    const bad = make();
    assert.deepEqual(bad.history, [], 'a corrupt file loads as empty in memory');
    bad.setText('do not lose the rest');
    bad.key('', {return: true});
    // Wave 13: the corrupt file was moved aside at load (its bytes survive
    // in the .corrupt-* backup) and the save records into a fresh file,
    // instead of the old guard refusing every save forever. The guard now
    // covers only a file that cannot be READ at all.
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['do not lose the rest'], 'the new entry is recorded in a fresh history');
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('history.json.corrupt-'));
    assert.equal(backups.length, 1, 'exactly one corrupt backup');
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), 'not json{', 'the corrupt bytes survive in the backup');
    fs.writeFileSync(file, JSON.stringify(['old']));
    const good = make();
    assert.deepEqual(good.history, ['old']);
    good.setText('new entry');
    good.key('', {return: true});
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['old', 'new entry'], 'a readable file merges as before');
  } finally {
    if (savedEnv === undefined) delete process.env.MUSER_HISTORY_FILE; else process.env.MUSER_HISTORY_FILE = savedEnv;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('/entries paging: loadOlderEntries prepends older pages, dedupes, tracks hasMore, and a 404 changes nothing', async () => {
  const pages = {'10': {entries: [{id: 8, type: 'user', text: 'o1'}, {id: 9, type: 'user', text: 'o2'}], hasMore: true},
    '8': {entries: [{id: 7, type: 'user', text: 'o0'}], hasMore: true},
    '7': {entries: [{id: 6, type: 'user', text: 'x'}, {id: 7, type: 'user', text: 'dup'}], hasMore: false}};
  const routes = (method, p) => {
    if (method === 'GET' && p.includes('/entries')) {
      const before = new URL(p, 'http://x').searchParams.get('before');
      return pages[before] ? {status: 200, json: pages[before]} : {status: 404, json: {error: 'unknown entry'}};
    }
    return null;
  };
  const {ctrl, client} = await started(snapshot({entries: [{id: 10, type: 'user', text: 'a'}, {id: 11, type: 'user', text: 'b'}]}), routes);
  const page1 = await ctrl.loadOlderEntries(2);
  assert.deepEqual(page1.entries.map(e => e.id), [8, 9]);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [8, 9, 10, 11], 'the page is prepended in order');
  assert.ok(client.gets('/entries')[0].path.includes('before=10'), 'paging is anchored at the oldest held entry');
  assert.ok(client.gets('/entries')[0].path.includes('limit=2'));
  await ctrl.loadOlderEntries(2);
  const page3 = await ctrl.loadOlderEntries(2);
  assert.deepEqual(page3.entries.map(e => e.id), [6], 'an overlapping page contributes only its new entries');
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [6, 7, 8, 9, 10, 11]);
  assert.equal(ctrl.entriesHasMore, false);
  const miss = await ctrl.loadOlderEntries(2);
  assert.equal(miss, null, 'an unknown before id (404) is a null page');
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [6, 7, 8, 9, 10, 11], 'and changes nothing');
  ctrl.stop();
});

test('ctrl+o: showLatestOutput saves the full text to a file and names it in the note, like the local Controller', async () => {
  const routes = (method, p) => (method === 'GET' && p.endsWith('/outputs') ? {status: 200, json: {outputs: [{id: 'o1', title: 'system.run  ls', text: 'line1\nline2'}]}} : null);
  const {ctrl} = await started(snapshot(), routes);
  await ctrl.showLatestOutput();
  const note = ctrl.get().entries.at(-1);
  assert.equal(note.type, 'note');
  assert.equal(note.lines[0], 'system.run  ls');
  assert.ok(note.lines.includes('line1') && note.lines.includes('line2'));
  const full = note.lines.find(l => l.startsWith('全文: '));
  assert.ok(full, 'the note names the saved file');
  const file = full.slice('全文: '.length);
  try {
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\nline2\n', 'the file holds the full text');
  } finally { fs.rmSync(file, {force: true}); ctrl.stop(); }
});

test('ctrl+o (debug R12): the file name is stable per output, keeps Japanese titles, and capped text is not called 全文', async () => {
  const routes = (method, p) => (method === 'GET' && p.endsWith('/outputs') ? {status: 200, json: {outputs: [{id: 'o9', title: 'system.run 日本語の検査', text: 'body'}]}} : null);
  const {ctrl} = await started(snapshot(), routes);
  await ctrl.showLatestOutput();
  const first = ctrl.get().entries.at(-1).lines.find(l => l.startsWith('全文: ')).slice('全文: '.length);
  await ctrl.showLatestOutput();
  const second = ctrl.get().entries.at(-1).lines.find(l => l.startsWith('全文: ')).slice('全文: '.length);
  try {
    assert.equal(second, first, 'the same output overwrites the same file');
    assert.ok(first.includes('日本語の検査'), 'the Japanese title survives in the file name: ' + first);
  } finally { fs.rmSync(first, {force: true}); ctrl.stop(); }
  const routes2 = (method, p) => (method === 'GET' && p.endsWith('/outputs') ? {status: 200, json: {outputs: [{id: 'o10', title: 'system.run big', text: 'body', truncated: true}]}} : null);
  const t2 = await started(snapshot(), routes2);
  await t2.ctrl.showLatestOutput();
  const lines = t2.ctrl.get().entries.at(-1).lines;
  const saved = lines.find(l => l.startsWith('保存先: '));
  try {
    assert.ok(!lines.some(l => l.startsWith('全文: ')), 'capped text is not called the full text');
    assert.ok(saved && saved.includes('切り取られています'), 'the note says the text was capped');
  } finally { if (saved) fs.rmSync(saved.slice('保存先: '.length).replace(/（.*$/, ''), {force: true}); t2.ctrl.stop(); }
});

test('paste guard: pasteTarget names the current input, and a read already in flight blocks a second paste', async () => {
  const {ctrl} = await started();
  assert.equal(ctrl.pasteTarget(), 'composer');
  ctrl.set({menu: {title: 'M', index: 0, options: [{value: 1, label: 'x'}]}});
  assert.equal(ctrl.pasteTarget(), 'menu');
  ctrl.set({menu: null, question: {questions: [], mode: 'list'}});
  assert.equal(ctrl.pasteTarget(), 'question:list');
  ctrl.set({question: null});
  ctrl.pasting = true;
  const flashBefore = ctrl.get().flash;
  await ctrl.pasteImage();
  await ctrl.pasteFromClipboard();
  assert.equal(ctrl.get().flash, flashBefore, 'a second paste while one is in flight does not even start a read');
  assert.equal(ctrl.pasting, true, 'the in-flight read still owns the flag');
  ctrl.pasting = false;
  ctrl.stop();
});
test('question answer: the snapshot question id rides as questionId; without one the body is unchanged', async () => {
  const question = id => ({...(id ? {id} : {}), questions: [{question: 'Which?', header: 'W', options: [{label: 'Yes'}, {label: 'No'}]}], tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''});
  const a = await started();
  state(a.client, {question: question('q-123')});
  assert.equal(a.ctrl.get().question.id, 'q-123', 'the id survives the snapshot');
  await a.ctrl.key('', {return: true});
  assert.deepEqual(a.client.posts('/api/s/sess-1/send').at(-1).body, {text: 'Which? → Yes', questionId: 'q-123'});
  a.ctrl.stop();
  const b = await started();
  state(b.client, {question: question(null)});
  await b.ctrl.key('', {return: true});
  assert.deepEqual(b.client.posts('/api/s/sess-1/send').at(-1).body, {text: 'Which? → Yes'}, 'no id, no questionId field');
  b.ctrl.stop();
});

test('approval decline (debug R1/R7): the decline option opens the reason input instead of posting at once; the reason carries the approval id; the draft returns', async () => {
  const approval = {id: 'a1', call: {command: 'rm x'}, options: [{label: 'はい', allow: true}, {label: 'いいえ（Muse に伝えることを入力）', allow: false}], index: 0};
  const {ctrl, client} = await started(snapshot({approval}));
  ctrl.setText('下書き', 3);
  ctrl.answerApproval(1);
  assert.equal(client.posts('/api/s/sess-1/approval').length, 0, 'no immediate decline post — the reason comes first');
  assert.ok(ctrl.get().reasonFor, 'the reason input is open');
  assert.equal(ctrl.get().text, '', 'the composer now belongs to the reason');
  await ctrl.submitReason('危ないから');
  const posts = client.posts('/api/s/sess-1/approval');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.decision, {allow: false, reason: '危ないから'});
  assert.equal(posts[0].body.approvalId, 'a1', 'the reason answer names its approval (R2)');
  assert.equal(ctrl.get().text, '下書き', 'the stashed composer draft is back');
  ctrl.stop();
});

test('approval decline (debug R7): cancelling the reason discards the half-typed reason and restores the draft', async () => {
  const approval = {id: 'a2', call: {command: 'rm y'}, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], index: 0};
  const {ctrl, client} = await started(snapshot({approval}));
  ctrl.setText('元の下書き', 5);
  ctrl.answerApproval(1);
  ctrl.setText('やっぱり途中まで', 8);
  ctrl.key('c', {ctrl: true});
  const posts = client.posts('/api/s/sess-1/approval');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.decision, {allow: false, reason: ''}, 'the cancel answers with an empty reason');
  assert.equal(ctrl.get().text, '元の下書き', 'the pre-decline draft returns, not the half-typed reason');
  ctrl.stop();
});

test('modal answers (debug R2): an approval allow and a menu pick name the modal they answer', async () => {
  const approval = {id: 'a9', call: {command: 'ls'}, options: [{label: 'はい', allow: true}], index: 0};
  const a = await started(snapshot({approval}));
  a.ctrl.answerApproval(0);
  assert.equal(a.client.posts('/api/s/sess-1/approval').at(-1).body.approvalId, 'a9');
  a.ctrl.stop();
  const menu = {id: 'm7', title: 'Menu', options: [{label: 'One', value: '1'}, {label: 'Two', value: '2'}], index: 0};
  const b = await started(snapshot({menu}));
  b.ctrl.key('2', {});
  const mp = b.client.posts('/api/s/sess-1/menu').at(-1);
  assert.deepEqual(mp.body, {index: 1, menuId: 'm7'});
  b.ctrl.stop();
});

test('/lang (debug R5): a refused /lang send does not switch this window language', async () => {
  const i18n = require('../src/i18n.js');
  const before = i18n.lang();
  const routes = (method, p) => (method === 'POST' && p.endsWith('/send') ? {status: 500, json: {error: 'send failed'}} : null);
  const {ctrl} = await started(snapshot(), routes);
  await ctrl.submit('/lang ' + (before === 'en' ? 'ja' : 'en'));
  assert.equal(i18n.lang(), before, 'the local language follows the send result, not the attempt');
  ctrl.stop();
});

test('prompt (debug R4): with a prompt open, text is its answer (even "/exit") and ctrl+c cancels the prompt', async () => {
  const {ctrl, client, calls} = await started(snapshot({promptFor: {message: 'コードは？'}}));
  await ctrl.submit('/exit');
  assert.equal(calls.exit, 0, '/exit as a prompt answer does not close the window');
  assert.deepEqual(client.posts('/api/s/sess-1/send').at(-1).body, {text: '/exit'}, 'the text is forwarded as the prompt answer');
  ctrl.key('c', {ctrl: true});
  assert.deepEqual(client.posts('/api/s/sess-1/prompt').at(-1).body, {cancel: true}, 'ctrl+c cancels the server prompt');
  assert.equal(ctrl.get().promptFor, null);
  assert.equal(calls.exit, 0, 'and the window stays open');
  ctrl.stop();
});

test('question answer: a 409 from /send flashes that it was answered on another screen', async () => {
  const routes = (method, p) => (method === 'POST' && p.endsWith('/send') ? {status: 409, json: {error: 'question already answered'}} : null);
  const {ctrl, client} = await started(snapshot(), routes);
  state(client, {question: {id: 'q-9', questions: [{question: 'Which?', options: [{label: 'Yes'}, {label: 'No'}]}], tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''}});
  await ctrl.key('', {return: true});
  assert.equal(ctrl.get().question, null, 'the picker still closes locally');
  assert.equal(ctrl.get().flash, 'ほかの画面で答えられました');
  ctrl.stop();
});

test('question answer (debug R20): a 409 that is not the question guard flashes the server reason', async () => {
  const routes = (method, p) => (method === 'POST' && p.endsWith('/send') ? {status: 409, json: {error: 'queue is full'}} : null);
  const {ctrl, client} = await started(snapshot(), routes);
  state(client, {question: {id: 'q-9', questions: [{question: 'Which?', options: [{label: 'Yes'}, {label: 'No'}]}], tab: 0, index: 0, checked: {}, picked: {}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''}});
  await ctrl.key('', {return: true});
  assert.equal(ctrl.get().flash, 'queue is full', 'another 409 keeps its own reason instead of claiming it was answered elsewhere');
  ctrl.stop();
});

test('modal keys (debug R9/R10/R11): escape works with no options, \'\\n\' confirms, batched digits replay', async () => {
  // R9: an option-less approval can still be escaped.
  const a = await started(snapshot({approval: {id: 'a0', call: {command: 'system.run'}, options: [], index: 0}}));
  a.ctrl.key('', {escape: true});
  assert.deepEqual(a.client.posts('/api/s/sess-1/approval').at(-1).body.decision, {allow: false});
  a.ctrl.stop();
  // R9: an option-less menu can still be cancelled.
  const m = await started(snapshot({menu: {options: [], index: 0}}));
  m.ctrl.key('', {escape: true});
  assert.deepEqual(m.client.posts('/api/s/sess-1/menu').at(-1).body, {cancel: true});
  m.ctrl.stop();
  // R10: a bare '\n' confirms the highlighted approval.
  const b = await started(snapshot({approval: {id: 'a2', call: {command: 'system.run'}, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], index: 0}}));
  b.ctrl.key('\n', {});
  assert.deepEqual(b.client.posts('/api/s/sess-1/approval').at(-1).body.decision, {allow: true});
  b.ctrl.stop();
  const c = await started(snapshot({approval: {id: 'a3', call: {command: 'system.run'}, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], index: 0}}));
  c.ctrl.key('12', {});
  assert.deepEqual(c.client.posts('/api/s/sess-1/approval').at(-1).body.decision, {allow: true}, 'a batched digit run answers by its first digit');
  c.ctrl.stop();
  // R11: a batched '12' in a 12-item menu picks item 12.
  const opts = Array.from({length: 12}, (_, i) => ({label: '項目' + (i + 1)}));
  const d = await started(snapshot({menu: {options: opts, index: 0}}));
  d.ctrl.key('12', {});
  assert.deepEqual(d.client.posts('/api/s/sess-1/menu').at(-1).body, {index: 11});
  d.ctrl.stop();
});

test('entries paging (debug R16/R17): a page fetched across a replacement is discarded; a replacement resets hasMore', async () => {
  let ctrlRef = null;
  const routes = (method, p) => {
    if (method === 'GET' && p.includes('/entries')) {
      ctrlRef.handleEvent({kind: 'entries-reset', entries: [{id: 99, type: 'note', lines: []}]});
      return {status: 200, json: {entries: [{id: 8, type: 'user', text: 'old'}], hasMore: true}};
    }
    return null;
  };
  const {ctrl} = await started(snapshot({entries: [{id: 10, type: 'user', text: 'a'}, {id: 11, type: 'user', text: 'b'}]}), routes);
  ctrlRef = ctrl;
  ctrl.entriesHasMore = false;
  const page = await ctrl.loadOlderEntries(2);
  assert.equal(page, null, 'the stale page is discarded');
  assert.deepEqual(ctrl.get().entries.map(e => e.id), [99], 'only the replacement entries remain');
  assert.equal(ctrl.entriesHasMore, null, 'the replacement reset hasMore instead of keeping the stale false');
  ctrl.stop();
});

test('slash completion (debug R18): a failed /complete response is not cached as an empty list', async () => {
  let fail = true;
  const routes = (method, p) => (method === 'GET' && p.includes('/complete') ? (fail ? {status: 500, json: {error: 'boom'}} : {status: 200, json: {items: [{text: '/help'}, {text: '/exit'}]}}) : null);
  const {ctrl} = await started(snapshot(), routes);
  assert.deepEqual(await ctrl.refreshSlash(), []);
  assert.equal(ctrl._allSlash, null, 'the failure left the cache unset, not an empty list');
  fail = false;
  assert.deepEqual(await ctrl.refreshSlash(), ['/help', '/exit'], 'a later success still fills the cache');
  ctrl.stop();
});

test('multiline caret (debug R14): up/down keep the grapheme-cluster column across an emoji line', async () => {
  const {ctrl} = await started(snapshot());
  const text = 'ab\n👨‍👩‍👧x';
  ctrl.setText(text, 2); // caret after 'ab' — cluster column 2
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, text.length, 'column 2 on the emoji line is its end, not inside the emoji');
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().pos, 2, 'and back up to the same column');
  ctrl.stop();
});

test('composer insert (debug R13): the result is capped at MAX_INPUT', async () => {
  const {ctrl} = await started(snapshot());
  ctrl.setText('a'.repeat(999_999));
  ctrl.insert('bb');
  assert.equal(ctrl.get().text.length, 1_000_000, 'the composer never grows past the cap');
  assert.equal(ctrl.get().pos, 1_000_000);
  ctrl.stop();
});

test('menu digit buffer (debug R8): a non-digit key drops the buffer; the timer stands down under another modal', async () => {
  const opts = Array.from({length: 12}, (_, i) => ({label: '項目' + (i + 1)}));
  const {ctrl, client} = await started(snapshot({menu: {options: opts, index: 0}}));
  ctrl.key('1', {}); // buffered for a two-digit pick
  ctrl.key('x', {}); // any non-digit key drops the buffer
  ctrl.key('2', {}); // a fresh '2', not the tail of '12'
  assert.deepEqual(client.posts('/api/s/sess-1/menu').at(-1).body, {index: 1});
  ctrl.stop();
  const opts15 = Array.from({length: 15}, (_, i) => ({label: '項目' + (i + 1)}));
  const t2 = await started(snapshot({menu: {options: opts15, index: 0}}));
  t2.ctrl.key('1', {}); // buffered; the 400ms timer would answer item 1
  t2.ctrl.set({approval: {id: 'a1', call: {command: 'system.run'}, options: [{label: 'はい', allow: true}], index: 0}});
  await new Promise(r => setTimeout(r, 500));
  assert.equal(t2.client.posts('/api/s/sess-1/menu').length, 0, 'the buffered digit does not fire under the approval');
  t2.ctrl.stop();
});

test('question answer (debug R19): the answer joins the composer send guard', async () => {
  const {ctrl, client} = await started(snapshot());
  state(client, {question: {id: 'q-9', questions: [{question: 'Which?', options: [{label: 'Yes'}, {label: 'No'}]}], tab: 0, index: 0, checked: {}, picked: {0: 0}, custom: {}, answers: {}, notes: '', mode: 'list', typeText: ''}});
  ctrl._sending = true; // a composer send is in flight
  await ctrl.submitQuestionAnswers();
  assert.equal(client.posts('/api/s/sess-1/send').length, 0, 'no second send while one is in flight');
  assert.ok(ctrl.get().question, 'the picker stays open');
  ctrl._sending = false;
  await ctrl.submitQuestionAnswers();
  assert.equal(client.posts('/api/s/sess-1/send').length, 1, 'once the guard clears, the answer goes out');
  assert.equal(ctrl._sending, false, 'and the guard is released after the post');
  ctrl.stop();
});

test('refusals (debug R6): a refused send and a refused approval flash the server error, not a fake disconnect', async () => {
  const routes = (method, p) => {
    if (method === 'POST' && p.endsWith('/send')) return {status: 500, json: {error: 'send failed: boom'}};
    if (method === 'POST' && p.endsWith('/approval')) return {status: 409, json: {error: 'approval has changed'}};
    return null;
  };
  const {ctrl} = await started(snapshot({approval: {id: 'a1', call: {command: 'system.run'}, options: [{label: 'はい', allow: true}, {label: 'いいえ', allow: false}], index: 0}}), routes);
  await ctrl.submit('hello');
  assert.equal(ctrl.get().flash, 'send failed: boom');
  await ctrl.key('1', {});
  assert.equal(ctrl.get().flash, 'approval has changed');
  ctrl.stop();
});
