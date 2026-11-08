'use strict';
// /export in the TUI (EXPORT.md): the shared Controller's slash command.
// The confirmation is a menu; the tests answer it through the menu's own
// pick(), the same value the GUI/phone /api/menu path resolves. Sending is
// pointed at a local receiver stub via MUSER_REPORT_URL — never the real
// receiver. Env isolation first (the controller.test.js pattern): src
// modules resolve their stores from LOCALAPPDATA / home at load time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportslash-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportslash-home-'));
process.env.MUSER_EXPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportslash-out-'));

const sessions = require('../src/sessions');

class FakeAgent extends EventEmitter {
  constructor(cwd, session) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = session; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
    this.accountId = 'default'; this.busy = false;
  }
}
FakeAgent.DEVICE = 'test';

function seedConversation() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportslash-work-'));
  const s = sessions.create(cwd);
  s.turns = 1;
  sessions.save(s);
  sessions.appendTurn(s.id, {v: 1, at: Date.now(), user: 'ひみつの頼みごと', reply: '直しました', tools: [{command: 'code.read', summary: 'src/a.js', ok: true}], progress: [{agent: 'main', message: '調査中', at: 1}], usage: {inputTokens: 3, outputTokens: 1}});
  return {cwd, session: s};
}
async function makeCtrl() {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {cwd, session} = seedConversation();
  const ctrl = new Controller({agent: new FakeAgent(cwd, session), museName: 'm', version: '0.3.8', onExit() {}});
  return {ctrl, session};
}
function stubReceiver(t, reply = {status: 200, body: {id: '20261107-beef0123ab'}}) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push({headers: req.headers, body: Buffer.concat(chunks)}); res.writeHead(reply.status, {'content-type': 'application/json'}); res.end(JSON.stringify(reply.body)); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    resolve({url: 'http://127.0.0.1:' + server.address().port + '/muser/report', got});
  }));
}
const tick = () => new Promise(r => setImmediate(r));
async function untilMenu(ctrl) { for (let i = 0; i < 50 && !ctrl.get().menu; i++) await tick(); return ctrl.get().menu; }
// Pick by number key, the way the window itself does it: menuKey closes
// the menu first and then calls pick (a bare menu.pick() in a test would
// leave the menu standing and the next /export would refuse).
async function pickByKey(ctrl, digit) { await untilMenu(ctrl); ctrl.key(digit, {}); }
const notesText = ctrl => ctrl.get().entries.filter(e => e.type === 'note').map(e => e.lines.join('\n')).join('\n');

test('/export is in COMMANDS and in the completions', async () => {
  const {COMMANDS} = await import('../src/ui/controller.mjs');
  assert.ok(COMMANDS.some(([name]) => name === '/export'));
  const {ctrl} = await makeCtrl();
  assert.ok(ctrl.slashList('/exp').includes('/export'));
});

test('/export: sizes first, then the menu; picking send sends without the body and shows the id', async t => {
  const stub = await stubReceiver(t);
  const prev = process.env.MUSER_REPORT_URL; process.env.MUSER_REPORT_URL = stub.url;
  t.after(() => { if (prev === undefined) delete process.env.MUSER_REPORT_URL; else process.env.MUSER_REPORT_URL = prev; });
  const {ctrl, session} = await makeCtrl();
  const done = ctrl.slash('/export');
  const menu = await untilMenu(ctrl);
  assert.ok(menu, 'the confirmation menu opens');
  assert.deepEqual(menu.options.map(o => o.value), ['send', 'send-body', 'save', 'save-body', 'cancel']);
  const before = notesText(ctrl);
  assert.ok(before.includes('送るレポートの中身'), 'the contents are shown before the choice');
  assert.ok(before.includes('合計'), 'with per-section sizes and a total');
  ctrl.key('1', {}); // 1 = send
  await done;
  assert.equal(stub.got.length, 1);
  const parsed = JSON.parse(zlib.gunzipSync(stub.got[0].body).toString('utf8'));
  assert.equal(parsed.session.id, session.id);
  assert.equal(parsed.includesConversation, false);
  assert.ok(!JSON.stringify(parsed).includes('ひみつの頼みごと'));
  assert.ok(notesText(ctrl).includes('送りました。ID: 20261107-beef0123ab'));
  assert.ok(notesText(ctrl).includes('Discord'));
});

test('/export: send-body includes the conversation text, only from that pick', async t => {
  const stub = await stubReceiver(t);
  const prev = process.env.MUSER_REPORT_URL; process.env.MUSER_REPORT_URL = stub.url;
  t.after(() => { if (prev === undefined) delete process.env.MUSER_REPORT_URL; else process.env.MUSER_REPORT_URL = prev; });
  const {ctrl} = await makeCtrl();
  const done = ctrl.slash('/export');
  await pickByKey(ctrl, '2'); // 2 = send with the conversation text
  await done;
  const parsed = JSON.parse(zlib.gunzipSync(stub.got[0].body).toString('utf8'));
  assert.equal(parsed.includesConversation, true);
  assert.ok(JSON.stringify(parsed).includes('ひみつの頼みごと'));
});

test('/export: save writes the file and sends nothing; cancel sends nothing', async t => {
  const stub = await stubReceiver(t);
  const prev = process.env.MUSER_REPORT_URL; process.env.MUSER_REPORT_URL = stub.url;
  t.after(() => { if (prev === undefined) delete process.env.MUSER_REPORT_URL; else process.env.MUSER_REPORT_URL = prev; });
  const {ctrl, session} = await makeCtrl();
  const doneSave = ctrl.slash('/export');
  await pickByKey(ctrl, '3'); // 3 = save to a file
  await doneSave;
  assert.equal(stub.got.length, 0);
  const m = /送らずにファイルに書きました: (.+)/.exec(notesText(ctrl));
  assert.ok(m, notesText(ctrl));
  const parsed = JSON.parse(fs.readFileSync(m[1].trim(), 'utf8'));
  assert.equal(parsed.session.id, session.id);
  const doneCancel = ctrl.slash('/export');
  await pickByKey(ctrl, '5'); // 5 = cancel
  await doneCancel;
  assert.equal(stub.got.length, 0);
  assert.ok(notesText(ctrl).includes('送りませんでした。'));
});

test('/export: Esc on the confirmation menu sends nothing', async t => {
  const stub = await stubReceiver(t);
  const prev = process.env.MUSER_REPORT_URL; process.env.MUSER_REPORT_URL = stub.url;
  t.after(() => { if (prev === undefined) delete process.env.MUSER_REPORT_URL; else process.env.MUSER_REPORT_URL = prev; });
  const {ctrl} = await makeCtrl();
  const done = ctrl.slash('/export');
  await untilMenu(ctrl);
  ctrl.cancelMenu();
  await done;
  assert.equal(stub.got.length, 0);
  assert.ok(notesText(ctrl).includes('送りませんでした。'));
});

test('/export refuses where no confirmation can be shown: busy, another menu open, demo', async () => {
  const {ctrl} = await makeCtrl();
  ctrl.set({busy: true});
  await ctrl.slash('/export');
  assert.ok(notesText(ctrl).includes('作業中は送れません'));
  assert.ok(!ctrl.get().menu);
  ctrl.set({busy: false});
  ctrl.openMenu({title: '別の選択', options: [{value: 'a', label: 'a'}], pick() {}});
  await ctrl.slash('/export');
  assert.ok(notesText(ctrl).includes('確認の画面が出せないため送りません'));
  assert.equal(ctrl.get().menu.title, '別の選択', 'the open menu is left alone');
  ctrl.cancelMenu();
  const {ctrl: demo} = await makeCtrl();
  demo.agent.client = {status: 'demo'};
  await demo.slash('/export');
  assert.ok(notesText(demo).includes('デモではレポートは送れません'));
});

test('/export with an argument explains itself and opens nothing', async () => {
  const {ctrl} = await makeCtrl();
  await ctrl.slash('/export please');
  assert.ok(notesText(ctrl).includes('使い方: /export'));
  assert.ok(!ctrl.get().menu);
});

test('/export: a receiver failure is shown with its reason', async t => {
  const stub = await stubReceiver(t, {status: 429, body: {error: 'too many reports'}});
  const prev = process.env.MUSER_REPORT_URL; process.env.MUSER_REPORT_URL = stub.url;
  t.after(() => { if (prev === undefined) delete process.env.MUSER_REPORT_URL; else process.env.MUSER_REPORT_URL = prev; });
  const {ctrl} = await makeCtrl();
  const done = ctrl.slash('/export');
  await pickByKey(ctrl, '1');
  await done;
  assert.ok(notesText(ctrl).includes('時間をおいて'));
});
