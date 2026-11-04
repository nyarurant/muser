
'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// Self-isolation guard, the same pattern as the top of tests/controller.test.js:
// point LOCALAPPDATA / HOME at throwaway dirs HERE, before any src module can
// load, so this file is safe with or without tests/setup.mjs.
const fsTop = require('node:fs');
const pathTop = require('node:path');
process.env.LOCALAPPDATA = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-fix2-data-'));
process.env.USERPROFILE = process.env.HOME = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-fix2-home-'));
const createdTmpDirs = [process.env.LOCALAPPDATA, process.env.HOME];
const origMkdtempSync = fsTop.mkdtempSync.bind(fsTop);
fsTop.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdTmpDirs.push(dir); return dir; };
after(() => { for (const dir of createdTmpDirs) { try { fsTop.rmSync(dir, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0};
    this.ctx = {readFiles: new Set(), todos: []};
    this.client = {status: 'demo'}; this.device = {connected: true};
    this.sent = []; this.busy = false;
  }
  async send(text, opts) { this.sent.push({text, opts}); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const tmpDir = () => fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-fix2-'));
async function mk(agentOpts = {}) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(tmpDir());
  Object.assign(agent, agentOpts);
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}, onReload: () => { ctrl.reloads = (ctrl.reloads || 0) + 1; }});
  ctrl.refreshPlan = () => Promise.resolve(null); // no muse.ai in tests
  return {agent, ctrl};
}
const ASK2 = {questions: [
  {question: '色は？', header: '色', options: [{label: '赤'}, {label: '青'}]},
  {question: '形は？', header: '形', options: [{label: '丸'}, {label: '四角'}]},
]};
const notesWith = (ctrl, re) => ctrl.get().entries.filter(e => e.type === 'note' && re.test(e.lines.join('\n')));
const clip = require('../src/clipboard.js');
function stubClip(images, text) {
  const oi = clip.clipboardImages, ot = clip.clipboardText;
  clip.clipboardImages = images; clip.clipboardText = text;
  return () => { clip.clipboardImages = oi; clip.clipboardText = ot; };
}

test('auto sends wait while a picker is open or a decline reason is pending (deep c1 #1)', async () => {
  const {agent, ctrl} = await mk();
  ctrl.openQuestion(ASK2);
  ctrl.shellNotes = ['<task-notification><task-id>bg1</task-id><status>completed</status></task-notification>'];
  await ctrl.sendShellNotes();
  assert.equal(agent.sent.length, 0, 'a shell note must not start a turn over an open picker');
  assert.equal(ctrl.shellPending, true, 'the note waits instead of being lost');
  ctrl.key('', {escape: true}); // closing the picker resumes it (first #26)
  await wait(20);
  assert.equal(agent.sent.length, 1, 'the waiting note is sent once the picker closes');
  const r2 = await mk();
  r2.ctrl.set({reasonFor: {resolve() {}}});
  r2.ctrl.bangNotes = ['note'];
  await r2.ctrl.sendBangNotes();
  assert.equal(r2.agent.sent.length, 0, 'a bang note must not start a turn while a decline reason is typed');
  assert.equal(r2.ctrl.bangPending, true);
});

test('/reload refuses with a picker, prompt, numeric input, unsent notes or a running shell (deep c1 #2)', async () => {
  const cases = [
    ['picker open', ctrl => ctrl.openQuestion(ASK2)],
    ['prompt open', ctrl => ctrl.set({promptFor: {resolve() {}, reject() {}, message: 'x'}})],
    ['numeric input open', ctrl => ctrl.set({limitInput: {key: 'k', text: '1'}})],
    ['unsent bang notes', ctrl => { ctrl.bangNotes = ['unsent']; }],
    ['unsent shell notes', ctrl => { ctrl.shellNotes = ['unsent']; }],
    ['background shell working', ctrl => ctrl.set({shells: [{id: 'bg1', state: 'working'}]})],
  ];
  for (const [name, setup] of cases) {
    const {ctrl} = await mk();
    setup(ctrl);
    ctrl.reload();
    assert.equal(ctrl.reloads || 0, 0, `reload must refuse while: ${name}`);
  }
  const {ctrl} = await mk();
  ctrl.reload();
  assert.equal(ctrl.reloads, 1, 'an idle window still reloads');
});

test('the quota warning without a resetsAt expires after a day instead of never (deep c1 #3)', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Fix2 Warn');
  try {
    const {agent, ctrl} = await mk();
    agent.accountId = 'default'; agent.accountLabel = 'default';
    agent.accountPool = {peek: async () => ({id: second.id, label: 'Fix2 Warn'})};
    await ctrl.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null});
    assert.equal(notesWith(ctrl, /週の使用量が/).length, 1, 'the first warning fires');
    const rec = ctrl.quotaWarnedFor.get('default');
    assert.ok(rec && typeof rec.resetsAt === 'number' && rec.resetsAt > Date.now(), 'a missing resetsAt becomes a future expiry, not a permanent mute');
    assert.ok(rec.resetsAt <= Date.now() + 24 * 3600 * 1000 + 5000, 'the fallback expiry is a day out');
    await ctrl.maybeWarnAccountQuota({percentUsed: 96, quotaStatus: null});
    assert.equal(notesWith(ctrl, /週の使用量が/).length, 1, 'still quiet inside the day');
    rec.resetsAt = Date.now() - 1000; // a day has passed
    await ctrl.maybeWarnAccountQuota({percentUsed: 96, quotaStatus: null});
    assert.equal(notesWith(ctrl, /週の使用量が/).length, 2, 'the warning can fire again after the day');
  } finally { accounts.remove(second.id); }
});

test('picker: an empty Enter in the type editor keeps the picked option (deep c1 #4)', async () => {
  const {ctrl} = await mk();
  ctrl.openQuestion(ASK2);
  ctrl.questionActivate({kind: 'option', i: 1}, 1, 'return'); // pick 青 for q0, advance
  ctrl.questionTab(-1);
  ctrl.questionActivate({kind: 'type', i: 2}, 2, 'return'); // open the editor, still empty
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question?.picked?.[0], 1, 'the earlier pick survives an empty confirm');
});

test('picker: backspace in the type editor deletes a whole grapheme cluster (deep c1 #5)', async () => {
  const {ctrl} = await mk();
  ctrl.openQuestion(ASK2);
  ctrl.setQuestion({...ctrl.get().question, mode: 'type', typeText: 'a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'});
  ctrl.key('', {backspace: true});
  assert.equal(ctrl.get().question.typeText, 'a', 'the family emoji goes in one press, no dangling ZWJ or surrogate');
});

test('openQuestion ignores unusable asks, and a broken ask does not break the turn end (deep c1 #6)', async () => {
  const {ctrl} = await mk();
  assert.doesNotThrow(() => ctrl.openQuestion({questions: [{question: '素の質問'}]}));
  assert.equal(ctrl.get().question, null, 'a question with no options opens nothing');
  assert.doesNotThrow(() => ctrl.openQuestion({questions: []}));
  assert.equal(ctrl.get().question, null, 'an empty ask opens nothing');
  ctrl.openQuestion({questions: [{question: '素の質問'}, {question: '色は？', options: [{label: '赤'}]}]});
  assert.equal(ctrl.get().question?.questions?.length, 1, 'only the usable question is kept');
  ctrl.closeQuestion();
  const t2 = await mk();
  t2.ctrl.queue = ['next task']; t2.ctrl.set({queue: ['next task']});
  assert.doesNotThrow(() => t2.agent.emit('turn-end', {ok: true, focus: {status: 'needs_input', id: 'f1', round: 1, revision: 1, ask: {questions: [{question: '素の質問'}]}}}));
  await wait(20);
  assert.equal(t2.agent.sent.length, 1, 'the queued message still goes out after the broken ask');
  assert.match(t2.agent.sent[0].text, /next task/);
});

test('a message whose postSteer outlives the turn is sent, not queued (deep c1 #7)', async () => {
  const {agent, ctrl} = await mk();
  ctrl.set({busy: true});
  agent.postSteer = async () => { ctrl.set({busy: false}); return false; }; // the turn ends during the await
  agent.queueSteer = () => {};
  await ctrl.submit('hello race');
  assert.equal(agent.sent.length, 1, 'the message is sent as a fresh turn');
  assert.equal(ctrl.queue.length, 0, 'nothing is left in a queue nobody drains');
});

test('a late /identity answer does not rename a different current account (deep c1 #8)', async () => {
  const {agent, ctrl} = await mk();
  agent.accountId = 'default'; agent.accountLabel = 'default';
  let resolveB;
  agent.client = {status: 'connected', request: () => agent.accountId === 'b-id' && !resolveB ? new Promise(r => { resolveB = () => r({name: 'Bee'}); }) : Promise.resolve({name: agent.accountId === 'b-id' ? 'Bee' : 'Ay'})};
  agent.accountId = 'b-id';
  agent.emit('account', {id: 'b-id', label: 'B'});
  agent.accountId = 'default';
  agent.emit('account', {id: 'default', label: 'A'});
  await wait(10);
  assert.equal(ctrl.museName, 'Ay');
  resolveB?.();
  await wait(10);
  assert.equal(ctrl.museName, 'Ay', 'the late answer for B is remembered for B, not shown as the current name');
});

test('sends are held and a second switch is refused while an account switch runs (deep c1 #9)', async () => {
  const {agent, ctrl} = await mk();
  agent.accountId = 'a-id'; agent.accountLabel = 'A';
  let switches = 0;
  agent.accountPool = {bundleFor: acc => ({account: acc, files: {}, web: {}, auth: {}, client: {status: 'connected'}})};
  agent.switchAccount = async next => { switches++; await wait(60); agent.accountId = next.account.id; };
  const p = ctrl.requestAccountSwitch({id: 'b-id', label: 'B'}, null);
  await wait(10);
  await ctrl.submit('during switch');
  assert.equal(agent.sent.length, 0, 'nothing is sent mid-switch');
  assert.equal(ctrl.queue.length, 1, 'the message is held in the queue');
  ctrl.requestAccountSwitch({id: 'c-id', label: 'C'}, null);
  assert.ok(notesWith(ctrl, /切り替えています/).length >= 1, 'the second switch is refused with a note');
  await p; await wait(100);
  assert.equal(switches, 1, 'only the first switch ran');
  assert.equal(agent.accountId, 'b-id');
  assert.equal(agent.sent.length, 1, 'the held message goes out on the new account');
  assert.match(agent.sent[0].text, /during switch/);
  assert.equal(ctrl.queue.length, 0);
});

test('clipboard paste lands in the input that asked for it, and only once (deep c1 #10)', async () => {
  // (A) the target changes while the read is in flight: the text goes nowhere.
  const undoA = stubClip(() => new Promise(r => setTimeout(() => r({files: [], error: null}), 60)), async () => 'TARGET TEXT');
  try {
    const {ctrl} = await mk();
    const p = ctrl.pasteFromClipboard(); // asked from the composer
    await wait(10);
    ctrl.openQuestion(ASK2);
    ctrl.setQuestion({...ctrl.get().question, mode: 'type', typeText: ''});
    await p;
    assert.equal(ctrl.get().question.typeText, '', 'the late text does not land in the picker editor');
    assert.equal(ctrl.get().text, '', 'nor back in the composer');
    assert.match(ctrl.get().flash || '', /切り替わったため/);
  } finally { undoA(); }
  // (B) two presses while one read is in flight insert the text once.
  const undoB = stubClip(async () => ({files: [], error: null}), async () => { await wait(20); return 'ONCE TEXT'; });
  try {
    const {ctrl} = await mk();
    const p1 = ctrl.pasteFromClipboard();
    const p2 = ctrl.pasteFromClipboard();
    await Promise.all([p1, p2]);
    assert.equal(ctrl.get().text, 'ONCE TEXT', 'the second press does not paste a second copy');
  } finally { undoB(); }
});

test('the composer caps at a million characters (deep c1 #11)', async () => {
  const {ctrl} = await mk();
  ctrl.paste('x'.repeat(2_000_000));
  assert.equal(ctrl.get().text.length, 1_000_000, 'a huge paste is cut at the cap');
  assert.match(ctrl.get().flash || '', /長すぎる/, 'and the cut is said out loud');
});

test('the stream fast path does not leak a bare token line inside a delta (deep c1 #12)', async () => {
  const {ctrl} = await mk();
  ctrl.onText({id: 'm1', text: 'hello\nwidget-12345678abcd\nmore'});
  const clean = ctrl.get().stream?.clean || '';
  assert.ok(!clean.includes('widget-12345678abcd'), 'the bare token never reaches the rendered text raw');
  assert.ok(clean.includes('hello') && clean.includes('more'), 'the surrounding text is intact');
});

test('history saves wait for another window, and never overwrite an unreadable file (deep c1 #13)', {timeout: 60000}, async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const {spawn} = require('node:child_process');
  const dir = tmpDir();
  const ctrlUrl = require('node:url').pathToFileURL(path.join(__dirname, '..', 'src', 'ui', 'controller.mjs')).href;
  const childPath = path.join(dir, 'child.mjs');
  fs.writeFileSync(childPath, [
    'process.env.MUSER_HISTORY_FILE = process.env.FIX2_HISTORY_FILE;',
    "import fs from 'node:fs';",
    "const {EventEmitter} = await import('node:events');",
    "const os = await import('node:os');",
    'class FakeAgent extends EventEmitter { constructor() { super(); this.mode = \'default\'; this.cwd = os.tmpdir(); this.session = {id: \'x\', turns: 0}; this.ctx = {readFiles: new Set(), todos: []}; this.client = {status: \'demo\'}; this.device = {connected: true}; } async send() {} }',
    `const {Controller} = await import(${JSON.stringify(ctrlUrl)});`,
    "const ctrl = new Controller({agent: new FakeAgent(), museName: 'm', version: 't', onExit() {}});",
    'ctrl.refreshPlan = () => Promise.resolve(null);',
    "fs.writeFileSync(process.env.FIX2_MARKER, 'started');",
    "ctrl.setText('child-entry', 11);",
    "ctrl.key('', {return: true});",
    'await new Promise(r => setTimeout(r, 100));',
    'process.exit(0);',
  ].join('\n'));
  const run = (histFile, markerFile) => {
    const child = spawn(process.execPath, [childPath], {env: {...process.env, FIX2_HISTORY_FILE: histFile, FIX2_MARKER: markerFile}, stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', d => { err += d; });
    const done = new Promise(res => child.on('exit', code => res({code, err})));
    return {child, done};
  };
  // Another window holds the lock: this window's entry must wait, then merge.
  const hist = path.join(dir, 'history.json');
  fs.writeFileSync(hist, JSON.stringify(['seed-entry']));
  fs.writeFileSync(hist + '.lock', '');
  const marker = path.join(dir, 'marker');
  const first = run(hist, marker);
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await wait(25);
  assert.ok(fs.existsSync(marker), 'the child window started');
  await wait(300);
  assert.ok(!fs.readFileSync(hist, 'utf8').includes('child-entry'), 'the save waits while the other window holds the lock');
  fs.unlinkSync(hist + '.lock');
  const r1 = await first.done;
  assert.equal(r1.code, 0, r1.err);
  const saved = JSON.parse(fs.readFileSync(hist, 'utf8'));
  assert.ok(saved.includes('seed-entry') && saved.includes('child-entry'), 'both windows keep their entries');
  // An unreadable history file is left exactly as it is (fifth f1-3, the read-side twin).
  const hist2 = path.join(dir, 'history2.json');
  fs.writeFileSync(hist2, 'not json{');
  const r2 = await run(hist2, path.join(dir, 'marker2')).done;
  assert.equal(r2.code, 0, r2.err);
  assert.equal(fs.readFileSync(hist2, 'utf8'), 'not json{', 'a corrupt history is never replaced by the newest entry alone');
});

test('picker edit: ctrl+shift+v pastes text and ctrl+v looks for an image (first #23)', async () => {
  const undo = stubClip(async () => ({files: [], error: null}), async () => 'PASTED');
  try {
    const {ctrl} = await mk();
    ctrl.openQuestion(ASK2);
    ctrl.setQuestion({...ctrl.get().question, mode: 'type', typeText: ''});
    ctrl.key('V', {ctrl: true, shift: true});
    await wait(30);
    assert.equal(ctrl.get().question.typeText, 'PASTED', 'ctrl+shift+v pastes into the editor, like the composer');
    ctrl.key('v', {ctrl: true});
    await wait(30);
    assert.match(ctrl.get().flash || '', /画像がありません/, 'ctrl+v runs the image paste instead of being dropped');
    assert.equal(ctrl.get().question.typeText, 'PASTED', 'the image paste does not type a stray v');
  } finally { undo(); }
});

test('closing the picker resumes the queue and pending shell notes (first #26)', async () => {
  const {agent, ctrl} = await mk();
  ctrl.queue = ['queued one']; ctrl.set({queue: ['queued one']});
  ctrl.openQuestion(ASK2);
  ctrl.key('', {escape: true});
  await wait(20);
  assert.equal(agent.sent.length, 1, 'the queued message is sent when the picker closes');
  assert.match(agent.sent[0].text, /queued one/);
  assert.equal(ctrl.queue.length, 0);
  const t2 = await mk();
  t2.ctrl.shellPending = true;
  t2.ctrl.shellNotes = ['<task-notification><task-id>bg9</task-id><status>completed</status></task-notification>'];
  t2.ctrl.openQuestion(ASK2);
  t2.ctrl.questionActivate({kind: 'chat'}, 0, 'return');
  await wait(20);
  assert.equal(t2.agent.sent.length, 1, 'pending shell notes resume when the picker closes');
});

test('the menu takes keys over a numeric input, matching the screen (third M18)', async () => {
  const {ctrl} = await mk();
  let applied = null, picked = null;
  ctrl.set({limitInput: {key: 'k', label: 'L', text: '4', done: v => { applied = v; }}});
  ctrl.openMenu({title: 'M', options: [{value: 'a', label: 'A'}], pick: v => { picked = v; }});
  ctrl.key('5', {});
  assert.equal(ctrl.get().limitInput?.text, '4', 'the digit goes to the menu the user sees, not the hidden number');
  ctrl.key('', {return: true});
  assert.equal(picked, 'a', 'enter picks the menu item');
  assert.equal(applied, null, 'the numeric input was not applied by keys meant for the menu');
  assert.equal(ctrl.get().limitInput?.text, '4', 'the numeric input is still there when the menu closes');
});

test('the menu digit buffer dies on an ignored key or under an approval (third M19, fifth f4-2)', async () => {
  const opts = Array.from({length: 12}, (_, i) => ({value: 'v' + i, label: 'item ' + (i + 1)}));
  const a = await mk(); let pickedA = null;
  a.ctrl.openMenu({title: 'M', options: opts, pick: v => { pickedA = v; }});
  a.ctrl.key('1', {});
  a.ctrl.key('x', {}); // an ignored key: the half-typed number is abandoned
  await wait(500);
  assert.equal(pickedA, null, 'the timer does not pick item 1 after another key was pressed');
  const b = await mk(); let pickedB = null;
  b.ctrl.openMenu({title: 'M', options: opts, pick: v => { pickedB = v; }});
  b.ctrl.key('1', {});
  const approval = b.ctrl.ask({command: 'code.read', kind: 'read', params: {path: 'x'}, agent: 'main'});
  approval.catch(() => {});
  await wait(500);
  assert.equal(pickedB, null, 'the timer does not pick a menu item hidden under an approval');
  assert.ok(b.ctrl.get().approval, 'the approval is still open');
  b.ctrl.answer(0);
  await approval;
});

test('picker answers are not consumed as a decline reason (third M25)', async () => {
  const {agent, ctrl} = await mk();
  ctrl.openQuestion({questions: [{question: '色は？', header: '色', multi: true, options: [{label: '赤'}, {label: '青'}]}]});
  const p = ctrl.ask({command: 'code.read', kind: 'read', params: {path: 'x'}, agent: 'worker1'});
  ctrl.answer(1); // decline: a reason is now being asked for
  let resolved = null; p.then(v => { resolved = v; });
  ctrl.questionActivate({kind: 'option', i: 0}, 0, 'space'); // check 赤
  ctrl.questionActivate({kind: 'option', i: 0}, 0, 'return'); // send the answers
  await wait(20);
  assert.equal(agent.sent.length, 1, 'the answers go to the chat as the question reply');
  assert.match(agent.sent[0].text, /赤/);
  assert.equal(resolved, null, 'the decline is still waiting for its reason');
  assert.ok(ctrl.get().reasonFor, 'the reason prompt survives the picker answers');
  ctrl.submitReason('理由です');
  await wait(10);
  assert.deepEqual(resolved, {allow: false, reason: '理由です'}, 'the typed reason still answers the decline');
});

test('chunked digits pick menu items and answer approvals once (fifth f4-3)', async () => {
  const opts = Array.from({length: 12}, (_, i) => ({value: 'v' + i, label: 'item ' + (i + 1)}));
  const {ctrl} = await mk(); let picked = null;
  ctrl.openMenu({title: 'M', options: opts, pick: v => { picked = v; }});
  ctrl.key('12', {}); // both digits arrive in one input event
  assert.equal(picked, 'v11', 'the chunk is read as the two-digit pick it was typed as');
  const b = await mk();
  const p = b.ctrl.ask({command: 'code.read', kind: 'read', params: {path: 'x'}, agent: 'main'});
  let resolved = null; p.then(v => { resolved = v; });
  b.ctrl.key('12', {});
  await wait(10);
  assert.ok(resolved && resolved.allow === true, 'the approval takes the first digit as its answer');
  assert.equal(b.ctrl.get().approval, null, 'and the second digit does not linger for the next approval');
});

test('ctrl+j confirms in menus and in the picker editor (fifth f4-4)', async () => {
  const {ctrl} = await mk();
  ctrl.openQuestion(ASK2);
  ctrl.setQuestion({...ctrl.get().question, mode: 'type', typeText: 'a'});
  ctrl.key('\n', {});
  const q = ctrl.get().question;
  assert.equal(q.mode, 'list', 'ctrl+j confirms the typed answer like enter');
  assert.ok(!String(q.typeText || '').includes('\n'), 'no newline leaks into the one-line editor');
  assert.equal(q.custom?.[0], 'a', 'the typed answer is kept');
  const m = await mk(); let picked = null;
  m.ctrl.openMenu({title: 'M', options: [{value: 'a', label: 'A'}], pick: v => { picked = v; }});
  m.ctrl.key('\n', {});
  assert.equal(picked, 'a', 'ctrl+j picks the highlighted menu item');
});

test('previewRow survives a stream state whose md is not built yet (deep R4-9)', async () => {
  const {ctrl} = await mk();
  ctrl.md = null;
  ctrl.set({stream: {id: 's', done: 0, partial: 'hello', started: false, emitted: '', raw: 'hello', clean: 'hello', table: []}});
  assert.doesNotThrow(() => ctrl.previewRow());
});

test('@ completion returns every match, not a capped page (deep R4-1, already fixed)', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const dir = tmpDir();
  for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(dir, 'match' + String(i).padStart(2, '0') + '.txt'), 'x');
  await require('../src/mentions').ready(dir);
  const {ctrl} = await mk();
  ctrl.agent.cwd = dir;
  const ctx = ctrl.atContext('@match', 6);
  assert.ok(ctx, 'a context is found');
  assert.ok(ctx.list.length >= 10, `all matches come back (got ${ctx.list.length})`);
});
