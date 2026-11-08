'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// Self-isolation guard (B6), the same pattern as the top of tests/accounts.test.js:
// the account tests below call accounts.add() against muser's data folder, and
// src modules resolve that folder from LOCALAPPDATA / the home folder when they
// are first loaded (lazily, inside the tests). tests/setup.mjs already points
// both at throwaway dirs, but a bare `node --test tests/controller.test.js`
// skips setup.mjs — exactly how accounts.test.js once wrote a test account
// into the user's real registry (2026-11-03). Point both at throwaway dirs
// HERE, before any src module can load, so this file is safe either way.
const fsTop = require('node:fs');
const pathTop = require('node:path');
process.env.LOCALAPPDATA = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-controller-data-'));
process.env.USERPROFILE = process.env.HOME = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-controller-home-'));

// B8: the ~30 mkdtemp dirs this file creates (atDir, the account tests, /new)
// were never cleaned. Track every dir made through fs.mkdtempSync in this
// process (all call sites here, direct or via fs2 / a local require, share the
// one fs module object) and remove them all when the file finishes.
const createdTmpDirs = [];
const origMkdtempSync = fsTop.mkdtempSync.bind(fsTop);
fsTop.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdTmpDirs.push(dir); return dir; };
createdTmpDirs.push(process.env.LOCALAPPDATA, process.env.HOME); // the two guard dirs, made just above before the tracker existed
after(() => { for (const dir of createdTmpDirs) { try { fsTop.rmSync(dir, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

test('scrollback is never trimmed (Ink <Static> prints only past items.length)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const before = ctrl.get().entries.length;
  for (let i = 0; i < 400; i++) ctrl.push({type: 'note', lines: ['n' + i]});
  assert.equal(ctrl.get().entries.length, before + 400);
});

function atDir() {
  const fs = require('node:fs'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-atsel-'));
  for (const n of ['apple.txt', 'apricot.txt', 'banana.txt']) fs.writeFileSync(path.join(dir, n), 'x');
  return dir;
}

test('@ candidates: down arrow chooses, enter picks it, history is not touched', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(atDir()), museName: 'm', version: 't', onExit() {}});
  ctrl.history = ['previous prompt'];
  await require('../src/mentions').ready(ctrl.agent.cwd); // the list is built in the background while the user types
  ctrl.setText('@ap', 3);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().text, '@ap', 'arrows only move the highlight');
  assert.equal(ctrl.atIndex('ap', 2), 1);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '@apricot.txt ', 'enter completes the highlighted candidate instead of sending');
  assert.deepEqual(ctrl.history, ['previous prompt']);
});

test('@ candidates: tab still completes the first candidate', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(atDir()), museName: 'm', version: 't', onExit() {}});
  await require('../src/mentions').ready(ctrl.agent.cwd);
  ctrl.setText('@ap', 3);
  ctrl.key('', {tab: true});
  assert.equal(ctrl.get().text, '@apple.txt ');
});

test('starting in the home folder warns once that searches will cover all of it', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const home = new Controller({agent: new FakeAgent(os.homedir()), museName: 'm', version: 't', onExit() {}});
  assert.ok(home.get().entries.some(e => e.type === 'note' && /ホームかドライブ直下/.test(e.lines.join(''))));
  const repo = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  assert.ok(!repo.get().entries.some(e => e.type === 'note' && /ホームかドライブ直下/.test(e.lines.join(''))));
});

test('a menu opening (e.g. the re-login offer) keeps what the user was typing', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('half-written message', 20);
  ctrl.openMenu({title: 'x', options: [{value: 'a', label: 'a'}], pick() {}});
  assert.equal(ctrl.get().text, 'half-written message');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().menu, null);
  assert.equal(ctrl.get().text, 'half-written message');
});

// 2026-11-01 audit: the screen showed 4-12 lines of a tool's output and the rest could only be
// seen by running it again. /output shows a recent call in full and saves it to a file.
test('/output shows a tool call in full (long ones: the last 200 lines and a file)', async () => {
  const fs = require('node:fs');
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const long = Array.from({length: 500}, (_, i) => 'line ' + (i + 1)).join('\n');
  agent.emit('tool-end', {id: '1', command: 'system.run', summary: 'npm test', ok: true, view: {exit: 0, tail: ['line 500']}, output: long});
  const tool = ctrl.get().entries.at(-1);
  assert.equal(tool.call.outputLines, 500);
  assert.equal(tool.call.output, undefined, 'the full text is not kept in scrollback entries');
  ctrl.slash('/output');
  assert.equal(ctrl.get().menu.options.length, 1);
  ctrl.get().menu.pick(0);
  const note = ctrl.get().entries.at(-1).lines.join('\n');
  assert.match(note, /line 500/);
  assert.match(note, /line 301\n/);
  assert.ok(!/line 300\n/.test(note), 'only the last 200 lines on screen');
  const file = note.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).find(l => l.includes('muser-output')).replace(/^.*?: /, '').trim();
  assert.equal(fs.readFileSync(file, 'utf8'), long + '\n', 'the file has all of it');
  fs.unlinkSync(file);
});

test('↑↓ in the @ list re-render, so the highlight visibly moves', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(atDir()), museName: 'm', version: 't', onExit() {}});
  await require('../src/mentions').ready(ctrl.agent.cwd);
  ctrl.setText('@ap', 3);
  let renders = 0; ctrl.subscribe(() => { renders++; });
  ctrl.key('', {downArrow: true});
  assert.equal(renders, 1);
});

test('slash candidates: down arrow chooses, enter completes it, history is not touched', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.history = ['previous prompt'];
  ctrl.setText('/', 1);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().text, '/', 'arrows only move the highlight');
  assert.equal(ctrl.slashIndex('/', 7), 1);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '/settings', 'enter completes the highlighted candidate instead of running');
  assert.deepEqual(ctrl.history, ['previous prompt']);
});

test('↑↓ in the / list re-render, so the highlight visibly moves', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('/', 1);
  let renders = 0; ctrl.subscribe(() => { renders++; });
  ctrl.key('', {downArrow: true});
  assert.equal(renders, 1);
});

test('slash: enter on the highlighted exact command runs it; the longer one stays reachable by arrow', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  agent.types = () => require('../src/agent-types').load(process.cwd()); // /agent's usage lists the types
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.setText('/agent', 6);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '', 'the exact command was submitted, not completed to /agents');
  ctrl.setText('/agent', 6);
  ctrl.key('', {downArrow: true});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '/agents', 'arrowing to the longer candidate completes it');
});

test('after esc, queued messages go back into the input instead of being sent', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd()); const sent = [];
  agent.send = async text => { sent.push(text); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.set({busy: true});
  await ctrl.submit('next task'); await ctrl.submit('and this');
  agent.emit('turn-end', {ok: false, aborted: true, error: 'stopped'});
  assert.deepEqual(sent, []);
  assert.equal(ctrl.get().text, 'next task\nand this');
  ctrl.set({busy: true}); await ctrl.submit('queued');
  agent.emit('turn-end', {ok: true});
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(sent.map(s => s.split('\n')[0]), ['queued'], 'a turn that finished normally still sends the queue');
});

test('a message sent mid-turn is registered for steering and leaves the queue once delivered', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd()); const sent = [];
  agent.send = async text => { sent.push(text); };
  const steered = [];
  agent.queueSteer = text => steered.push(text);
  agent.dropSteer = () => {}; agent.clearSteer = () => {};
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.set({busy: true});
  await ctrl.submit('change of plan');
  assert.deepEqual(steered, ['change of plan'], 'registered to ride the next tool result');
  assert.deepEqual(ctrl.get().queue, ['change of plan'], 'still queued as the fallback');
  agent.emit('steer', {texts: ['change of plan']});
  assert.deepEqual(ctrl.get().queue, [], 'delivered mid-turn: no longer waiting');
  agent.emit('turn-end', {ok: true});
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(sent, [], 'and it is not sent again as its own message');
});

test('a message sent mid-turn is posted as a real chat message when that is possible', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd()); const steered = [];
  agent.queueSteer = text => steered.push(text); agent.dropSteer = () => {}; agent.clearSteer = () => {};
  agent.postSteer = async () => true;
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.set({busy: true});
  await ctrl.submit('one more thing');
  assert.deepEqual(ctrl.get().queue, [], 'posted: not queued for a second send at turn end');
  assert.deepEqual(steered, [], 'and not piggybacked on a tool result');
  assert.ok(ctrl.get().entries.some(e => e.type === 'user' && e.text === 'one more thing'), 'shown as the user message it is');
  agent.postSteer = async () => false;
  await ctrl.submit('fallback one');
  assert.deepEqual(ctrl.get().queue, ['fallback one'], 'when posting fails, the queue fallback remains');
  assert.deepEqual(steered, ['fallback one'], 'and only then does it ride a tool result');
});

test('slash candidates: / alone reaches every command; /r narrows to its matches', async () => {
  const {Controller, COMMANDS} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  assert.equal(ctrl.slashList('/').length, COMMANDS.length, 'no cap: every command is a candidate');
  assert.deepEqual(ctrl.slashList('/r'), ['/resume', '/reload', '/race']);
  ctrl.setText('/', 1);
  for (let i = 0; i < COMMANDS.length - 1; i++) ctrl.key('', {downArrow: true});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, COMMANDS[COMMANDS.length - 1][0], 'even the last command completes by arrows');
});

test('Enter after an @path typed out in full sends instead of completing it again', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(atDir()); const sent = [];
  agent.send = async text => { sent.push(text); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  await require('../src/mentions').ready(agent.cwd);
  ctrl.setText('look at @apple.txt', 18);
  ctrl.key('', {return: true});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sent.length, 1, 'sent on the first Enter');
  assert.match(sent[0], /^look at @apple\.txt/);
  ctrl.setText('look at @apr', 12);
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, 'look at @apricot.txt ', 'a partial path is still completed');
});

test('a finished background shell resumes the work on its own; while busy it waits for the turn end', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {Shells} = require('../src/shells');
  const sent = [];
  const agent = new FakeAgent(process.cwd());
  agent.shells = new Shells();
  agent.send = async (body, opts) => { sent.push({body, opts}); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.onShellFinished({id: 'bg1', exit: 0, status: 'completed', command: 'npm run build'});
  assert.equal(sent.length, 1, 'idle: the finish starts a turn at once');
  assert.match(sent[0].body, /<task-notification>/);
  assert.match(sent[0].body, /<task-id>bg1<\/task-id>/);
  assert.match(sent[0].body, /<status>completed<\/status>/);
  assert.match(sent[0].body, /Background command "npm run build" completed \(exit code 0\)/);
  ctrl.onShellFinished({id: 'bg2', exit: 2, status: 'failed', command: 'npm test'});
  assert.equal(sent.length, 1, 'busy: no second turn');
  assert.equal(ctrl.shellPending, true);
  ctrl.set({busy: false});
  await ctrl.sendShellNotes();
  assert.equal(sent.length, 2, 'delivered when the turn ended');
  assert.match(sent[1].body, /<status>failed<\/status>/);
  ctrl.onShellFinished({id: 'bg3', exit: -1, status: 'stopped', command: 'npm run dev'});
  assert.equal(sent.length, 2, 'busy again: the stopped note waits too');
  ctrl.set({busy: false});
  await ctrl.sendShellNotes();
  assert.equal(sent.length, 3, 'a stopped shell reports as well');
  assert.match(sent[2].body, /<status>stopped<\/status>/);
});

test('/mode and /perm are unlisted aliases: they open the same mode menu as /permissions', async () => {
  const {Controller, COMMANDS} = await import('../src/ui/controller.mjs');
  for (const cmd of ['/permissions', '/mode', '/perm']) {
    const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
    ctrl.slash(cmd);
    assert.ok(ctrl.get().menu, cmd + ' opens a menu');
    assert.match(ctrl.get().menu.title, /承認モード/);
  }
  const names = COMMANDS.map(([n]) => n);
  assert.ok(names.includes('/permissions'), '/permissions is the listed name');
  assert.ok(!names.includes('/mode'), '/mode is not listed in /help');
});

test('/reload restarts through the injected callback, and waits while work is running', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  let calls = 0;
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}, onReload: () => calls++});
  ctrl.slash('/reload');
  assert.equal(calls, 1, 'a quiet window reloads');
  ctrl.set({busy: true});
  ctrl.slash('/reload');
  assert.equal(calls, 1, 'a busy window refuses and says why');
  assert.ok(ctrl.get().entries.some(e => e.type === 'note' && /作業中は再起動できません/.test(e.lines.join(''))));
  const plain = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  plain.slash('/reload');
  assert.ok(plain.get().entries.some(e => e.type === 'note' && /この起動方法では/.test(e.lines.join(''))), 'no callback (demo): explained, not silent');
});

test('ctrl+o shows the newest tool output in full; with none it just says so', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.key('o', {ctrl: true});
  assert.match(ctrl.get().flash, /まだ PC 操作の出力はありません/);
  let shown = null;
  ctrl.showOutput = o => { shown = o; };
  ctrl.outputs.push({command: 'system.run', summary: 'first', text: 'one', at: 1});
  ctrl.outputs.push({command: 'code.read', summary: 'second', text: 'two', at: 2});
  ctrl.key('o', {ctrl: true});
  assert.equal(shown.summary, 'second', 'the newest output, not the first');
  clearTimeout(ctrl.flashTimer);
});

// ---------- /account: picker, reservation, quota warning ----------
const fs2 = require('node:fs');
function accountAgent(cwd) {
  const a = new FakeAgent(cwd);
  a.accountId = 'default'; a.accountLabel = 'default'; a.busy = false; a.switched = [];
  a.accountPool = {bundleFor: acc => ({account: acc, files: {}, web: {}, auth: {}, client: {status: 'connected'}})};
  a.switchAccount = async (next, opts) => { a.switched.push({next, opts}); a.accountId = next.account.id; a.accountLabel = next.account.label; a.emit('account', {from: 'default', fromSession: 'x', id: next.account.id, label: next.account.label, reason: opts?.reason}); };
  return a;
}
function accountCtrl(agent) {
  return import('../src/ui/controller.mjs').then(({Controller}) => {
    const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
    ctrl.refreshPlan = () => Promise.resolve(null); // no muse.ai in tests
    return ctrl;
  });
}
const notesWith = (ctrl, re) => ctrl.get().entries.filter(e => e.type === 'note' && re.test(e.lines.join('\n')));

test('/account opens a picker over the pool; an account without a login explains itself', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Menu Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-menu-'));
    const ctrl = await accountCtrl(accountAgent(dir));
    await ctrl.accountCommand('');
    const menu = ctrl.get().menu;
    assert.ok(menu, 'a picker opens');
    assert.equal(menu.title, 'アカウント');
    assert.deepEqual(menu.options.map(o => o.value), ['default', second.id, '__add__']);
    ctrl.set({menu: {...menu, index: 1}});
    ctrl.key('', {return: true});
    assert.equal(ctrl.get().menu, null, 'the pick closes the menu');
    assert.equal(notesWith(ctrl, /ログインしていません/).length, 1, 'the missing login is explained, with the remedy');
  } finally { accounts.remove(second.id); }
});

test('/account with a single account still opens the picker, with the add entry', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-one-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  await ctrl.accountCommand('');
  const menu = ctrl.get().menu;
  assert.ok(menu, 'a picker opens even for one account');
  assert.deepEqual(menu.options.map(o => o.value), ['default', '__add__']);
});

test('an account picked mid-turn is reserved, then switches at the turn end with a handoff', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-res-'));
    const agent = accountAgent(dir);
    const ctrl = await accountCtrl(agent);
    agent.busy = true; ctrl.set({busy: true});
    ctrl.requestAccountSwitch(second, {hasLogin: true, device: true});
    assert.equal(ctrl.get().accountReserved, 'Second');
    assert.equal(notesWith(ctrl, /このターンが終わったら/).length, 1);
    assert.equal(agent.switched.length, 0, 'no switch mid-turn');
    agent.busy = false;
    agent.emit('turn-end', {ok: true});
    await untilState(() => agent.switched.length === 1);
    assert.equal(agent.switched.length, 1, 'the reserved switch ran at the turn boundary');
    assert.equal(agent.switched[0].next.account.id, second.id);
    assert.equal(agent.switched[0].opts.reason, 'reserved');
    assert.equal(ctrl.get().accountReserved, null, 'the reservation is cleared by the switch');
    assert.ok(typeof agent.pendingHandoff === 'string' && /Second/.test(agent.pendingHandoff), 'a handoff note waits for the new account');
  } finally { accounts.remove(second.id); }
});

test('a reserved switch is cancelled when the turn is interrupted', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-res2-'));
    const agent = accountAgent(dir);
    const ctrl = await accountCtrl(agent);
    agent.busy = true; ctrl.set({busy: true});
    ctrl.requestAccountSwitch(second, {hasLogin: true, device: true});
    agent.busy = false;
    agent.emit('turn-end', {ok: false, aborted: true, error: 'stopped'});
    assert.equal(agent.switched.length, 0, 'no switch after an interrupt');
    assert.equal(ctrl.get().accountReserved, null);
    assert.equal(notesWith(ctrl, /予約を取り消しました/).length, 1);
  } finally { accounts.remove(second.id); }
});

test('the quota warning fires once per account and names the lighter next account', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Warn Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-warn-'));
    const agent = accountAgent(dir);
    agent.accountPool = {peek: async () => ({id: second.id, label: 'Warn Second'})};
    const ctrl = await accountCtrl(agent);
    await ctrl.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null});
    assert.equal(notesWith(ctrl, /週の使用量が 95%/).length, 1);
    assert.equal(notesWith(ctrl, /Warn Second/).length, 1, 'the next account is named');
    await ctrl.maybeWarnAccountQuota({percentUsed: 96, quotaStatus: null});
    assert.equal(notesWith(ctrl, /週の使用量が/).length, 1, 'once per account');
    const quiet = await accountCtrl(accountAgent(dir));
    quiet.agent.accountPool = {peek: async () => ({id: second.id, label: 'Warn Second'})};
    await quiet.maybeWarnAccountQuota({percentUsed: 50, quotaStatus: null});
    assert.equal(notesWith(quiet, /週の使用量が/).length, 0, 'nothing below the warning line');
  } finally { accounts.remove(second.id); }
});

test('/login signs in the window\'s own account (its Edge profile and jar), not the first one', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-login-'));
  const agent = accountAgent(dir);
  agent.accountFiles = {web: 'accounts/sub/web.enc', browser: 'C:/x/accounts/sub/browser'};
  let got = null;
  agent.loginFlow = async o => { got = o; };
  agent.ensureConnected = async () => {};
  const ctrl = await accountCtrl(agent);
  await ctrl.login();
  assert.equal(got.jarFile, 'accounts/sub/web.enc');
  assert.equal(got.profile, 'C:/x/accounts/sub/browser');
  clearTimeout(ctrl.flashTimer);
});

test('/account <name> to an account without a login explains itself instead of switching', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Named Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-named-'));
    const agent = accountAgent(dir);
    const ctrl = await accountCtrl(agent);
    await ctrl.accountCommand('named');
    assert.equal(agent.switched.length, 0, 'no switch to an account that cannot connect');
    assert.equal(notesWith(ctrl, /ログインしていません/).length, 1);
  } finally { accounts.remove(second.id); }
});

const untilState = async (fn) => { for (let i = 0; i < 1000 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); }; // 10 s budget (t2 #2): 200×10 ms elapsed under parallel load before slow state changes landed

test('/account add <name> runs the add flow on this window\'s prompts', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-add-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  const seen = {};
  ctrl.accountAddImpl = async ({label, ui}) => {
    seen.label = label;
    seen.email = await ui.ask('Muse にログインしているメールアドレス');
    seen.ok = await ui.confirm('この PC を登録しますか？');
    seen.idx = await ui.pick('追加認証の方法を選んでください', [{label: 'テキストメッセージ'}, {label: '認証アプリ'}]);
    return {account: {id: 'added', label}, same: null};
  };
  const done = ctrl.accountCommand('add Sub Two');
  await untilState(() => ctrl.get().promptFor);
  assert.ok(ctrl.get().promptFor, 'the ask waits for composer input');
  await ctrl.submit('me@example.com');
  await untilState(() => ctrl.get().menu);
  assert.ok(ctrl.get().menu, 'the confirm is a menu');
  ctrl.key('', {return: true}); // はい
  await untilState(() => ctrl.get().menu);
  ctrl.set({menu: {...ctrl.get().menu, index: 1}});
  ctrl.key('', {return: true}); // 認証アプリ
  await done;
  assert.equal(seen.label, 'Sub Two');
  assert.equal(seen.email, 'me@example.com');
  assert.equal(seen.ok, true);
  assert.equal(seen.idx, 1);
  assert.equal(ctrl.get().entries.filter(e => e.type === 'user').length, 0, 'prompt answers never become chat messages');
  assert.equal(notesWith(ctrl, /アカウント Sub Two を追加しました/).length, 1);
  assert.equal(ctrl.addingAccount, false);
  clearTimeout(ctrl.flashTimer);
});

test('/account add is refused while a turn runs, and esc at the name prompt cancels', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-add2-'));
  const agent = accountAgent(dir);
  const ctrl = await accountCtrl(agent);
  let called = 0;
  ctrl.accountAddImpl = async () => { called++; return {account: {id: 'x', label: 'x'}, same: null}; };
  agent.busy = true; ctrl.set({busy: true});
  await ctrl.accountCommand('add Busy');
  assert.equal(called, 0, 'no add while busy');
  assert.equal(notesWith(ctrl, /作業が終わってから/).length, 1);
  agent.busy = false; ctrl.set({busy: false});
  const done = ctrl.accountCommand('add');
  await untilState(() => ctrl.get().promptFor);
  assert.ok(ctrl.get().promptFor, 'no name asks for one first');
  ctrl.key('', {escape: true});
  await done;
  assert.equal(called, 0, 'a cancelled name prompt starts nothing');
  assert.equal(notesWith(ctrl, /追加を中止しました/).length, 1);
  clearTimeout(ctrl.flashTimer);
});

test('a slash command typed at the account-name prompt runs as a command, not as a name', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-add3-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  let called = 0;
  ctrl.accountAddImpl = async () => { called++; return {account: {id: 'x', label: 'x'}, same: null}; };
  const done = ctrl.accountCommand('add');
  await untilState(() => ctrl.get().promptFor);
  assert.ok(ctrl.get().promptFor, 'the name prompt waits');
  await ctrl.submit('/account');
  await done;
  assert.equal(called, 0, 'no account is added for a command');
  const menu = ctrl.get().menu;
  assert.ok(menu, 'the command runs: the /account picker opens');
  assert.deepEqual(menu.options.map(o => o.value), ['default', '__add__']);
  clearTimeout(ctrl.flashTimer);
});

test('a slash command typed at an auth prompt aborts the add instead of reaching the auth service', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-add4-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  ctrl.accountAddImpl = async ({ui}) => { await ui.ask('Muse にログインしているメールアドレス'); return {account: {id: 'x', label: 'x'}, same: null}; };
  const done = ctrl.accountCommand('add Named');
  await untilState(() => ctrl.get().promptFor);
  assert.ok(ctrl.get().promptFor, 'the auth ask waits');
  await ctrl.submit('/account');
  await done;
  assert.equal(notesWith(ctrl, /追加できませんでした: 中止しました/).length, 1, 'the add aborts as cancelled');
  assert.equal(ctrl.addingAccount, false);
  clearTimeout(ctrl.flashTimer);
});

test('a pending prompt shows a waiting line until it is answered', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-add5-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  ctrl.accountAddImpl = async () => ({account: {id: 'x', label: 'Named'}, same: null});
  const done = ctrl.accountCommand('add');
  await untilState(() => ctrl.get().promptFor);
  assert.match(ctrl.get().flash, /入力待ち: 追加するアカウントの名前/, 'the screen says what it is waiting for');
  await ctrl.submit('Named');
  await done;
  assert.doesNotMatch(ctrl.get().flash, /入力待ち/, 'the waiting line clears once answered');
  clearTimeout(ctrl.flashTimer);
});

test('the add runs on its own screen: questions land there, the chat keeps only the outcome', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-add6-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  ctrl.accountAddImpl = async ({ui}) => { ui.info('コードを送りました'); return {account: {id: 'x', label: 'Named'}, same: null}; };
  const done = ctrl.accountCommand('add');
  await untilState(() => ctrl.get().promptFor);
  const f = ctrl.get().addFlow;
  assert.ok(f, 'the add screen is up while the flow runs');
  assert.ok(f.lines.join('\n').includes('追加するアカウントの名前'), 'the question is on the screen');
  assert.equal(notesWith(ctrl, /追加するアカウントの名前/).length, 0, 'the question is not a chat note');
  await ctrl.submit('Named');
  await done;
  assert.equal(ctrl.get().addFlow, null, 'the screen closes when the add ends');
  assert.equal(notesWith(ctrl, /アカウント Named を追加しました/).length, 1, 'the outcome stays in the chat');
  clearTimeout(ctrl.flashTimer);
});

test('/resume of a chat that belongs to another account says which account holds it', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Resume Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-resume-'));
    const agent = accountAgent(dir);
    const ctrl = await accountCtrl(agent);
    const before = agent.session;
    await ctrl.showResumed({id: 'other-acct-chat', cwd: dir, title: 'x', turns: 2, account: second.id});
    assert.equal(agent.session, before, 'the chat is not continued on this account');
    assert.equal(notesWith(ctrl, /\/account resume-second/).length, 1);
  } finally { accounts.remove(second.id); }
});

test('a plan read for the account a switch just left never lands in the new account\'s footer', async () => {
  const usageMod = require('../src/usage');
  const orig = usageMod.plan;
  const pending = [];
  usageMod.plan = web => new Promise(r => pending.push({web, r}));
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-plan-'));
    const agent = accountAgent(dir);
    const webA = {jar: []}, webB = {jar: []};
    agent.web = webA;
    const {Controller} = await import('../src/ui/controller.mjs');
    const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
    const first = ctrl.refreshPlan();
    agent.web = webB; // switched meanwhile
    const second = ctrl.refreshPlan();
    assert.equal(pending.length, 2, 'the new account reads its own plan');
    pending[1].r({percentUsed: 5});
    await second;
    pending[0].r({percentUsed: 99});
    assert.equal(await first, null);
    assert.equal(ctrl.get().plan.percentUsed, 5);
  } finally { usageMod.plan = orig; }
});

test('an automatic failover\'s handoff names the session it left', async () => {
  const sessions = require('../src/sessions');
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-ho-'));
  const agent = accountAgent(dir);
  agent.pendingHandoff = null;
  const old = sessions.create(dir);
  sessions.touch(old, 'Fix the login bug');
  sessions.appendTurn(old.id, {v: 1, at: Date.now(), user: '直して', reply: '直します', tools: [], steps: [], sources: [], todos: []});
  const ctrl = await accountCtrl(agent);
  agent.emit('account', {from: 'default', fromSession: old.id, id: 'second', label: 'Second', reason: 'auth'});
  assert.match(agent.pendingHandoff || '', /Fix the login bug/);
  // The note also points at the full record on this PC, for the new Muse to read on demand.
  assert.ok((agent.pendingHandoff || '').includes(sessions.transcriptFile(old.id)), 'the handoff names the transcript file');
  assert.match(agent.pendingHandoff || '', /全部を読み込まないこと/);
});

test('/resume marks the chats of another account before one is picked', async () => {
  const sessions = require('../src/sessions');
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-rm-'));
  const agent = accountAgent(dir);
  const mine = {...sessions.create(dir), account: 'default'}; sessions.touch(mine, 'mine');
  const theirs = {...sessions.create(dir), account: 'other-acct'}; sessions.touch(theirs, 'theirs');
  const ctrl = await accountCtrl(agent);
  ctrl.slash('/resume');
  const opts = ctrl.get().menu.options;
  assert.doesNotMatch(opts.find(o => o.value === mine.id).desc, /アカウント/);
  assert.match(opts.find(o => o.value === theirs.id).desc, /アカウント other-acct/);
});

test('at the weekly limit the user chooses: go on with the extra, or hand over to another account', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Limit Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-limit-'));
    const agent = accountAgent(dir);
    agent.accountPool = {...agent.accountPool, peek: async () => ({id: second.id, label: 'Limit Second', percentUsed: 12})};
    const ctrl = await accountCtrl(agent);
    const plan = {percentUsed: 100, quotaStatus: 'SUFFICIENT', topupValue: '0% used (3B tokens left)', topupBalance: 120, resetsAt: Date.now() + 3600e3};
    // The turn end with the limit reached: a question, not a switch.
    ctrl.refreshPlan = () => Promise.resolve(plan);
    agent.emit('turn-end', {ok: true, text: 'done'});
    await untilState(() => ctrl.get().menu?.quotaChoice); // poll, not a fixed 20 ms (t2 #2)
    const menu = ctrl.get().menu;
    assert.ok(menu?.quotaChoice, 'the choice is asked');
    assert.equal(agent.switched.length, 0, 'nothing switches on its own');
    assert.match(menu.title, /週間リミットが 100% に到達しました/);
    assert.deepEqual(menu.options.map(o => o.label), ['このまま追加を利用する', '新しいアカウントで引き継ぐ']);
    assert.match(menu.options[0].desc, /3B tokens left/);
    assert.match(menu.options[1].desc, /Limit Second/);
    // Hand over: the same switch as /account, with its handoff.
    ctrl.key('', {downArrow: true}); ctrl.key('', {return: true});
    await untilState(() => agent.switched.length === 1);
    assert.equal(agent.switched.length, 1);
    assert.equal(agent.switched[0].next.account.id, second.id);
    assert.ok(agent.pendingHandoff, 'the work is handed over');
  } finally { accounts.remove(second.id); }
});

test('"go on with the extra" holds for that account until its week resets', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Keep Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-keep-'));
    const agent = accountAgent(dir);
    agent.accountPool = {...agent.accountPool, peek: async () => ({id: second.id, label: 'Keep Second'})};
    const ctrl = await accountCtrl(agent);
    const plan = {percentUsed: 100, quotaStatus: 'SUFFICIENT', topupBalance: 0, resetsAt: Date.now() + 3600e3};
    await ctrl.askQuotaChoice(plan);
    assert.match(ctrl.get().menu.options[0].desc, /追加購入分はありません/, 'no extra bought is said plainly');
    ctrl.key('', {return: true});
    assert.equal(agent.switched.length, 0);
    assert.equal(notesWith(ctrl, /このまま続けます/).length, 1);
    await ctrl.askQuotaChoice(plan);
    assert.equal(ctrl.get().menu, null, 'not asked again this week');
    ctrl.quotaKeep.set('default', {resetsAt: Date.now() - 1});
    await ctrl.askQuotaChoice(plan);
    assert.ok(ctrl.get().menu?.quotaChoice, 'asked again once the week has reset');
  } finally { accounts.remove(second.id); }
});

test('from 90% the plan is re-read after every tool call, and the limit is asked mid-task', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Watch Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-watch-'));
    const agent = accountAgent(dir);
    agent.accountPool = {...agent.accountPool, peek: async () => ({id: second.id, label: 'Watch Second', percentUsed: 5})};
    const ctrl = await accountCtrl(agent);
    let reads = 0, next = {percentUsed: 89, quotaStatus: 'SUFFICIENT'};
    ctrl.refreshPlan = () => { reads++; ctrl.set({plan: next}); return Promise.resolve(next); };
    ctrl.set({plan: {percentUsed: 85, quotaStatus: 'SUFFICIENT'}});
    agent.emit('tool-end', {command: 'code.read', ok: true});
    assert.equal(reads, 0, 'below 90% a tool call reads nothing');
    // Exactly 90% (t2 #3): the guard is percentUsed < threshold - 10 (= 90),
    // so 90 itself is already "from 90%" and reads — previously the test
    // only bracketed the boundary with 85 and 92.
    ctrl.set({plan: {percentUsed: 90, quotaStatus: 'SUFFICIENT'}, busy: true}); agent.busy = true;
    next = {percentUsed: 92, quotaStatus: 'SUFFICIENT'};
    agent.emit('tool-end', {command: 'code.read', ok: true});
    await untilState(() => reads === 1); // poll the read, not a fixed tick (t2 #2)
    assert.equal(reads, 1, 'at exactly 90% a tool call reads the plan');
    next = {percentUsed: 95, quotaStatus: 'SUFFICIENT'};
    agent.emit('agent-tool', {command: 'code.read', ok: true});
    await untilState(() => reads === 2);
    assert.equal(reads, 2, 'every tool call (parallel agents too) reads the plan');
    assert.equal(ctrl.get().menu, null, 'not at the limit yet');
    // The user is typing: the question waits (an Enter would pick an option).
    next = {percentUsed: 100, quotaStatus: 'SUFFICIENT', resetsAt: Date.now() + 3600e3};
    ctrl.set({text: 'half a message'});
    agent.emit('tool-end', {command: 'code.read', ok: true});
    await untilState(() => reads === 3);
    assert.equal(ctrl.get().menu, null);
    ctrl.set({text: ''});
    agent.emit('tool-end', {command: 'code.read', ok: true});
    await untilState(() => ctrl.get().menu?.quotaChoice);
    const menu = ctrl.get().menu;
    assert.ok(menu?.quotaChoice, 'asked while the task runs');
    assert.match(menu.options[1].desc, /この作業が終わったら Watch Second/);
    ctrl.key('', {downArrow: true}); ctrl.key('', {return: true});
    await untilState(() => ctrl.get().accountReserved === 'Watch Second');
    assert.equal(agent.switched.length, 0, 'no switch under a running turn');
    assert.equal(ctrl.get().accountReserved, 'Watch Second', 'reserved for the turn end');
  } finally { accounts.remove(second.id); }
});

test('an unanswered limit question follows /settings: by default go on with extra usage, else hand over and resume', async () => {
  const accounts = require('../src/accounts');
  const settings = require('../src/settings');
  const second = accounts.add('Away Second');
  const tick = ms => new Promise(r => setTimeout(r, ms));
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-away-'));
    const make = async () => {
      const agent = accountAgent(dir);
      agent.accountPool = {...agent.accountPool, peek: async () => ({id: second.id, label: 'Away Second'})};
      const ctrl = await accountCtrl(agent);
      ctrl.quotaWaitMs = 30;
      ctrl.sent = []; ctrl.submit = text => { ctrl.sent.push(text); };
      return {agent, ctrl};
    };
    const week = Date.now() + 3600e3;
    assert.equal(settings.quotaFallback(), 'auto');
    // Extra usage bought: nobody answers, the window goes on here.
    let {agent, ctrl} = await make();
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 120, resetsAt: week});
    assert.match(ctrl.get().menu.hint, /1 秒答えがなければ「このまま追加を利用する」/);
    await untilState(() => ctrl.get().menu === null); // the 30 ms fallback, polled (t2 #2)
    assert.equal(ctrl.get().menu, null);
    assert.equal(agent.switched.length, 0);
    await untilState(() => notesWith(ctrl, /1 秒答えがなかったので、default でこのまま続けます/).length === 1);
    assert.equal(notesWith(ctrl, /1 秒答えがなかったので、default でこのまま続けます/).length, 1);
    // None bought, idle window whose last turn failed: hand over, then the work resumes there.
    ({agent, ctrl} = await make());
    ctrl.lastTurnEnd = {ok: false, error: 'weekly limit'};
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 0, resetsAt: week});
    await untilState(() => agent.switched.length === 1);
    assert.equal(agent.switched.length, 1);
    assert.equal(agent.switched[0].opts.reason, 'quota');
    await untilState(() => ctrl.sent.length === 1); // the resume send lands after the switch
    assert.equal(ctrl.sent.length, 1, 'the unfinished work is picked up on the new account');
    assert.match(ctrl.sent[0], /引き継ぎました/);
    // Mid-task: reserved, then at the failed turn's end switched and resumed.
    ({agent, ctrl} = await make());
    agent.busy = true; ctrl.set({busy: true});
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 0, resetsAt: week});
    await untilState(() => ctrl.get().accountReserved === 'Away Second');
    assert.equal(ctrl.get().accountReserved, 'Away Second');
    agent.busy = false;
    agent.emit('turn-end', {ok: false, error: 'weekly limit'});
    await untilState(() => agent.switched.length === 1);
    assert.equal(agent.switched.length, 1);
    await untilState(() => ctrl.sent.length === 1);
    assert.equal(ctrl.sent.length, 1);
    // A turn that finished on its own: switched for the next one, nothing sent by itself.
    ({agent, ctrl} = await make());
    ctrl.lastTurnEnd = {ok: true, text: 'done'};
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 0, resetsAt: week});
    await untilState(() => agent.switched.length === 1);
    assert.equal(agent.switched.length, 1);
    assert.equal(ctrl.sent.length, 0);
    // "ask": nothing happens without an answer; an answer cancels the wait.
    settings.setQuotaFallback('ask', {save: false});
    ({agent, ctrl} = await make());
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 0, resetsAt: week});
    await tick(300); // negative: 10× the 30 ms fallback wait, so a fallback that wrongly fires has time to (t2 #2)
    assert.ok(ctrl.get().menu?.quotaChoice, 'still waiting for the user');
    settings.setQuotaFallback('auto', {save: false});
    ({agent, ctrl} = await make());
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 0, resetsAt: week});
    ctrl.key('', {return: true}); // the user picks "go on"
    await tick(300); // negative, as above: past the fallback window before asserting it never ran
    assert.equal(agent.switched.length, 0, 'the fallback never runs after an answer');
    assert.throws(() => settings.setQuotaFallback('bogus', {save: false}));
  } finally { accounts.remove(second.id); require('../src/settings').setQuotaFallback('auto', {save: false}); }
});

test('an automatic "go on" with no extra usage bought says the work may stop, not "using the extra"', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-nox-'));
  const agent = accountAgent(dir);
  agent.accountPool = {...agent.accountPool, peek: async () => null};
  const accounts = require('../src/accounts');
  const other = accounts.add('No Extra Other');
  try {
    const ctrl = await accountCtrl(agent);
    ctrl.quotaWaitMs = 20;
    await ctrl.askQuotaChoice({percentUsed: 100, topupBalance: 0, resetsAt: Date.now() + 3600e3});
    await untilState(() => notesWith(ctrl, /追加購入分はないため、上限で止まることがあります/).length === 1);
    assert.equal(notesWith(ctrl, /追加購入分はないため、上限で止まることがあります/).length, 1);
    assert.equal(notesWith(ctrl, /追加購入分を使います/).length, 0);
  } finally { accounts.remove(other.id); }
});

test('the near-limit warning is dropped when the account changed during its read', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Race Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-race-'));
    const agent = accountAgent(dir);
    agent.accountPool = {peek: async () => { agent.accountId = second.id; agent.accountLabel = 'Race Second'; return {id: 'default', label: 'default'}; }};
    const ctrl = await accountCtrl(agent);
    await ctrl.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null}, 'default');
    assert.equal(notesWith(ctrl, /週の使用量が/).length, 0);
  } finally { accounts.remove(second.id); }
});

test('a progress report mid-stream does not split or duplicate the reply (audit #172)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {strip} = require('../src/tui/term.js');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  agent.emit('text', {id: 'm', text: 'one\ntwo\npart'});
  agent.emit('progress', {agent: 'main', message: 'halfway'});
  agent.emit('text', {id: 'm', text: 'one\ntwo\nthree\n'});
  agent.emit('message-done', {id: 'm'});
  const printed = ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows.map(r => strip(r.text)));
  assert.deepEqual(printed, ['one', 'two', 'three'], 'every line printed exactly once');
  assert.equal(ctrl.get().entries.filter(e => e.type === 'progress').length, 1, 'the progress note still lands');
  assert.equal(ctrl.get().stream, null);
});

test('the near-limit warning is once per quota week, and a switch during the peek does not eat it (audit #49)', async () => {
  const accounts = require('../src/accounts');
  const other = accounts.add('Warn Week Other');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-warn-'));
    const agent = accountAgent(dir);
    agent.accountPool.peek = async () => null;
    const ctrl = await accountCtrl(agent);
    const warned = () => notesWith(ctrl, /週の使用量が/).length;
    // The stored week is keyed by resetsAt: a reset 400 ms out (not ~40 ms —
    // the old value gave the two calls below ~20 ms of scheduling slack on a
    // loaded machine) is still "this week" for both calls, then a 1000 ms
    // wait lets it roll over with ~600 ms of margin.
    await ctrl.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null, resetsAt: Date.now() + 400}, 'default');
    assert.equal(warned(), 1);
    await ctrl.maybeWarnAccountQuota({percentUsed: 96, quotaStatus: null, resetsAt: Date.now() + 400}, 'default');
    assert.equal(warned(), 1, 'same week: no second warning');
    await new Promise(r => setTimeout(r, 1000)); // the stored week rolls over
    await ctrl.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null, resetsAt: Date.now() + 3600e3}, 'default');
    assert.equal(warned(), 2, 'a new week warns again');
    const agent2 = accountAgent(dir);
    agent2.accountPool.peek = async () => { agent2.accountId = other.id; return null; };
    const ctrl2 = await accountCtrl(agent2);
    await ctrl2.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null, resetsAt: Date.now() + 3600e3}, 'default');
    assert.equal(notesWith(ctrl2, /週の使用量が/).length, 0, 'the note belongs to the old account');
    agent2.accountId = 'default'; agent2.accountPool.peek = async () => null;
    await ctrl2.maybeWarnAccountQuota({percentUsed: 95, quotaStatus: null, resetsAt: Date.now() + 3600e3}, 'default');
    assert.equal(notesWith(ctrl2, /週の使用量が/).length, 1, 'not consumed: it warns once the account settles');
  } finally { accounts.remove(other.id); }
});

// ---------- audit 2026-11-03, cluster K/L (#156-#183) ----------

test('openMenu cancels the menu it displaces, so a promise-backed menu never hangs (audit #156)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const p = ctrl.menuPromise({title: 'confirm?', options: [{value: true, label: 'はい'}, {value: false, label: 'いいえ'}]});
  const rejected = assert.rejects(p, /中止しました/);
  ctrl.openMenu({title: 'other', options: [{value: 1, label: 'x'}], pick() {}});
  await rejected;
  assert.equal(ctrl.get().menu.title, 'other', 'the new menu is the one on screen');
});

test('a menu with no options does not crash menuKey (audit #166)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.openMenu({title: 'empty', options: [], pick() { throw new Error('must not pick'); }});
  ctrl.key('', {downArrow: true}); ctrl.key('', {return: true}); ctrl.key('3', {});
  assert.ok(ctrl.get().menu, 'still open, nothing picked, no NaN index');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().menu, null, 'escape still cancels');
});

test('ctrl+d shares ctrl+c guards before the double-press exit (audit #160)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  let exits = 0, interrupts = 0;
  const agent = new FakeAgent(process.cwd()); agent.interrupt = () => { interrupts++; };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() { exits++; }});
  ctrl.set({busy: true});
  ctrl.key('d', {ctrl: true}); ctrl.key('d', {ctrl: true});
  assert.equal(interrupts, 2, 'a running turn is interrupted, not exited');
  assert.equal(exits, 0);
  ctrl.set({busy: false});
  const p = ctrl.promptAsk('名前は？'); const cancelled = assert.rejects(p, /中止しました/);
  ctrl.key('d', {ctrl: true});
  await cancelled;
  assert.equal(exits, 0, 'a pending prompt is cancelled, not exited');
  ctrl.key('d', {ctrl: true}); ctrl.key('d', {ctrl: true});
  assert.equal(exits, 1, 'idle and empty: the double press still exits');
});

test('recovery: exit arming is per key — ctrl+c then one ctrl+d does not exit', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  let exits = 0;
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() { exits++; }});
  ctrl.key('c', {ctrl: true}); // arms ctrl+c
  ctrl.key('d', {ctrl: true}); // a DIFFERENT key: must not complete the exit
  assert.equal(exits, 0);
  ctrl.key('d', {ctrl: true}); // the second ctrl+d exits
  assert.equal(exits, 1);
});

test('recovery: paste strips terminal control sequences before they reach the draft', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.paste('a\x1b]52;c;AAAA\x07b\x1b[31mc');
  assert.ok(!ctrl.get().text.includes('\x1b'), 'no escape survives the paste');
  assert.equal(ctrl.get().text, 'abc');
});

test('recovery: backspace removes a whole grapheme cluster', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('x👨‍👩‍👧');
  ctrl.key('', {backspace: true});
  assert.equal(ctrl.get().text, 'x', 'the ZWJ family goes in one step, no dangling ZWJ');
});

test('recovery: up/down move the caret between lines of a multi-line draft', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.setText('ab\ncdef', 5); // caret on line 2, column 2
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().pos, 2, 'up keeps the column on the shorter first line');
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().pos, 5, 'down returns to the same column');
});

test('recovery: clearing a recalled history entry resets history browsing', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.history = ['one', 'two'];
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().text, 'two');
  ctrl.key('c', {ctrl: true}); // clears the draft
  assert.equal(ctrl.get().text, '');
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.get().text, 'two', 'up starts from the newest entry again, not the stale position');
});

test('a second foreground ! while one runs is refused (audit #161)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const stop = {abort() {}};
  ctrl.bangStop = stop; ctrl.set({bangRunning: {command: 'first'}});
  await ctrl.bang('echo second');
  assert.equal(ctrl.bangStop, stop, 'the running command keeps its abort handle');
  assert.match(ctrl.get().flash, /切り替えられません/);
});

test('connection recovery retires the login offer menu too (audit #169)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.set({loginNeeded: true});
  ctrl.openMenu({loginOffer: true, title: 'login?', options: [{value: 1, label: 'a'}], pick() {}});
  agent.emit('connection', {state: 'connected', first: false});
  assert.equal(ctrl.get().loginNeeded, false);
  assert.equal(ctrl.get().menu, null, 'no stale offer to start an unneeded Edge login');
});

test('an account switch closes the quota question and its timer (audit #159)', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-159-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  ctrl.openMenu({quotaChoice: Symbol('q'), title: 'q', options: [{value: 'keep', label: 'k'}], pick() {}});
  ctrl.quotaTimer = setTimeout(() => {}, 60000);
  ctrl.agent.emit('account', {id: 'other', label: 'Other'});
  assert.equal(ctrl.get().menu, null);
  assert.equal(ctrl.quotaTimer, null);
});

test('the quota question never opens over typing, and keep without a reset date expires in a day (audit #157/#164)', async () => {
  const accounts = require('../src/accounts');
  const second = accounts.add('Quota Guard Second');
  try {
    const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-157-'));
    const agent = accountAgent(dir);
    agent.accountPool = {...agent.accountPool, peek: async () => ({id: second.id, label: 'Quota Guard Second'})};
    const ctrl = await accountCtrl(agent);
    const plan = {percentUsed: 100, quotaStatus: 'SUFFICIENT', topupBalance: 5, resetsAt: null};
    ctrl.setText('half-typed message', 17);
    await ctrl.askQuotaChoice(plan, 'default', {midTurn: false});
    assert.equal(ctrl.get().menu, null, 'not over the composer, even from the turn-end path');
    ctrl.setText('', 0);
    await ctrl.askQuotaChoice(plan, 'default', {midTurn: false});
    assert.ok(ctrl.get().menu?.quotaChoice, 'asked once the composer is free');
    ctrl.key('', {return: true}); // keep
    const kept = ctrl.quotaKeep.get('default');
    assert.ok(kept?.resetsAt > Date.now() && kept.resetsAt <= Date.now() + 24 * 3600 * 1000 + 5000, 'no reset date: the hold is a day, not forever');
    clearTimeout(ctrl.quotaTimer);
  } finally { accounts.remove(second.id); }
});

test('turn-start resets sawText, so a non-streamed reply still shows at turn end (audit #167)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {strip} = require('../src/tui/term.js');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null);
  agent.emit('text', {id: 'a', text: 'first\n'}); agent.emit('message-done', {id: 'a'});
  agent.emit('turn-start', {});
  agent.emit('turn-end', {ok: true, text: 'second reply'});
  const printed = ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows.map(r => strip(r.text)));
  assert.ok(printed.includes('second reply'), 'the safety net was not disarmed by the previous turn');
});

test('ask() survives a throwing tool.target: an approval promise, flagged outside (audit #168)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {TOOLS} = require('../src/tools.js');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const orig = TOOLS['code.write'].target;
  TOOLS['code.write'].target = () => { throw new Error('dangling path'); };
  try {
    const p = ctrl.ask({command: 'code.write', params: {path: 'x', content: 'y'}, kind: 'edit', agent: 'main'});
    assert.ok(ctrl.get().approval, 'the approval UI opens instead of a synchronous throw');
    assert.equal(ctrl.get().approval.outside, true);
    ctrl.get().approval.resolve({allow: true});
    assert.deepEqual(await p, {allow: true});
  } finally { TOOLS['code.write'].target = orig; }
});

test('a decline reason owns the composer even when a menu opens over it (audit #158)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  let got = null;
  ctrl.set({reasonFor: {resolve: v => { got = v; }}});
  ctrl.openMenu({title: 'meanwhile', options: [{value: 'a', label: 'a'}, {value: 'b', label: 'b'}], pick() { throw new Error('menu must not eat the keys'); }});
  ctrl.key('x', {});
  assert.equal(ctrl.get().text, 'x', 'the key went to the reason, not the menu');
  assert.equal(ctrl.get().menu.index, 0);
  await ctrl.submit('not like that');
  assert.deepEqual(got, {allow: false, reason: 'not like that'}, 'a send answers the reason instead of chatting');
  assert.ok(ctrl.get().menu, 'the menu is still there afterwards');
  ctrl.cancelMenu();
});

test('shell notes wait out a prompt, and a failed auto-send keeps them (audit #162/#165)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  let sends = 0; agent.send = async () => { sends++; throw new Error('gateway down'); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.shellNotes = ['<task-notification>shell done</task-notification>'];
  ctrl.set({promptFor: {message: '名前は？', resolve() {}, reject() {}}});
  await ctrl.sendShellNotes();
  assert.equal(sends, 0, 'no automatic turn starts over a prompt');
  assert.equal(ctrl.shellPending, true);
  assert.equal(ctrl.shellNotes.length, 1, 'the note is still held');
  ctrl.set({promptFor: null});
  await ctrl.sendShellNotes();
  assert.equal(sends, 1);
  assert.deepEqual(ctrl.shellNotes, ['<task-notification>shell done</task-notification>'], 'a failed send does not lose the only copy of the notification');
});

test('a failed submit restores attachments and bang/shell notes (audit #174/#165)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  agent.send = async () => { throw new Error('gateway down'); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const att = {name: 'clip.png', size: 10};
  ctrl.set({attachments: [att]});
  ctrl.bangNotes = ['bang note']; ctrl.shellNotes = ['shell note'];
  await ctrl.submit('hello');
  assert.deepEqual(ctrl.get().attachments, [att], 'the in-memory-only attachment survives');
  assert.deepEqual(ctrl.bangNotes, ['bang note']);
  assert.deepEqual(ctrl.shellNotes, ['shell note']);
  assert.equal(ctrl.get().busy, false);
});

test('/reload is refused while a reason, a !command or a login is in flight (audit #170)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  let reloads = 0;
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}, onReload: () => { reloads++; }});
  ctrl.set({reasonFor: {resolve() {}}}); ctrl.reload();
  ctrl.set({reasonFor: null, bangRunning: {command: 'x'}}); ctrl.reload();
  ctrl.set({bangRunning: null}); ctrl.loggingIn = true; ctrl.reload();
  assert.equal(reloads, 0);
  ctrl.loggingIn = false; ctrl.reload();
  assert.equal(reloads, 1, 'a quiet window reloads as before');
});

test('an empty submit at a prompt warns briefly, then the waiting line comes back (audit #171)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const p = ctrl.promptAsk('名前は？');
  await ctrl.submit('');
  assert.match(ctrl.get().flash, /入力してください/);
  // Poll for the restore instead of sleeping a fixed 2900 ms: the production
  // delay is 2600 ms (promptFlashTimer in controller.mjs), so the old sleep
  // had only ~300 ms of slack and failed on loaded machines despite the
  // restore working. Poll up to 10 s; the assert below still pins the outcome.
  for (let i = 0; i < 500 && !/入力待ち: 名前は？/.test(ctrl.get().flash || ''); i++) await new Promise(r => setTimeout(r, 20));
  assert.match(ctrl.get().flash, /入力待ち: 名前は？/, 'the standing waiting line is restored');
  await ctrl.submit('abc');
  assert.equal(await p, 'abc');
  clearTimeout(ctrl.flashTimer); clearTimeout(ctrl.promptFlashTimer);
});

test('/new leaves the old chat shell notes and goal behind (audit #175/#176)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-new-'));
  const agent = new FakeAgent(dir);
  agent.standingGoal = () => null;
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.shellNotes = ['old shell note']; ctrl.shellPending = true; ctrl.bangPending = true;
  ctrl.set({goal: {text: 'old goal'}});
  await ctrl.slash('/new');
  assert.deepEqual(ctrl.shellNotes, []);
  assert.equal(ctrl.shellPending, false);
  assert.equal(ctrl.get().goal, null, 'the old chat goal is not shown in the new chat');
});

test('/resume with an ambiguous prefix refuses and names the candidates (audit #178)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const sessions = require('../src/sessions');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const orig = sessions.recent;
  sessions.recent = () => [{id: 'abc111', title: 'one', turns: 1}, {id: 'abc222', title: 'two', turns: 1}];
  try {
    await ctrl.slash('/resume abc');
    assert.equal(notesWith(ctrl, /候補が複数あります/).length, 1);
    assert.equal(notesWith(ctrl, /再開:/).length, 0, 'nothing was silently resumed');
  } finally { sessions.recent = orig; }
});

test('finished agent cards and their spinner words are pruned (audit #182)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  agent.emit('agent-update', {tag: 'a1', state: 'done', ended: Date.now() - 60000, title: 'old'});
  agent.emit('spinner', {agent: 'a1', word: 'thinking'});
  agent.emit('agent-update', {tag: 'a2', state: 'working', title: 'live'});
  assert.deepEqual(ctrl.get().agents.map(x => x.tag), ['a2'], 'the long-finished card is gone');
  assert.deepEqual(ctrl.get().agentWords, {}, 'its spinner word goes with it');
});

test('the agent-limit number input carries a range, and out-of-range is refused (audit #183)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.agentLimitsMenu();
  ctrl.get().menu.pick('concurrent');
  const edit = ctrl.get().limitInput;
  assert.equal(edit.min, 0); assert.equal(edit.max, 1000);
  ctrl.set({limitInput: {...edit, text: '1001', selected: false}});
  ctrl.key('', {return: true});
  assert.ok(ctrl.get().limitInput, '1001 stays unanswered instead of applying a 10x limit');
  ctrl.set({limitInput: {...ctrl.get().limitInput, text: '10'}});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().limitInput, null);
  assert.ok(ctrl.get().menu, 'back at the limits menu');
});

test('streamed deltas print every line once, fast path or not (audit #173)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {strip} = require('../src/tui/term.js');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const full = Array.from({length: 30}, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';
  for (let n = 7; n < full.length; n += 7) agent.emit('text', {id: 's', text: full.slice(0, n)});
  agent.emit('text', {id: 's', text: full});
  agent.emit('message-done', {id: 's'});
  const printed = ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows.map(r => strip(r.text)));
  assert.deepEqual(printed, Array.from({length: 30}, (_, i) => 'line ' + (i + 1)));
  assert.equal(notesWith(ctrl, /書き直しました/).length, 0, 'no false revision note');
});

test('a send while a resume is still loading supersedes it (audit #177)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const transcript = require('../src/transcript');
  const agent = new FakeAgent(process.cwd()); agent.send = async () => {};
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  let release; const gate = new Promise(r => { release = r; });
  const orig = transcript.forResume;
  transcript.forResume = async () => { await gate; return {turns: [{user: 'old', reply: 'old reply', todos: [{content: 'stale', status: 'pending'}]}], from: 'local'}; };
  try {
    const resumed = ctrl.showResumed({id: 'fake-177', title: 'old chat', turns: 0});
    await ctrl.submit('fresh message');
    release(); await resumed;
    const {strip} = require('../src/tui/term.js');
    const printed = ctrl.get().entries.filter(e => e.type === 'md').flatMap(e => e.rows.map(r => strip(r.text)));
    assert.ok(!printed.includes('old reply'), 'the stale history was not spliced under the new turn');
    assert.deepEqual(ctrl.get().todos, [], 'its todos did not overwrite the new turn');
  } finally { transcript.forResume = orig; }
});

test('resume todos come from the newest turn that recorded any, not only the last (audit #179)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const transcript = require('../src/transcript');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const orig = transcript.forResume;
  const mine = [{content: 'keep me', status: 'pending'}];
  transcript.forResume = async () => ({turns: [{user: 'a', reply: 'one', todos: mine}, {user: 'b', reply: 'two', todos: []}], from: 'local'});
  try {
    await ctrl.showResumed({id: 'fake-179', title: 'chat', turns: 0});
    assert.deepEqual(ctrl.get().todos, mine, 'a remote last turn with todos:[] does not erase the list');
  } finally { transcript.forResume = orig; }
});

test('resume shows an automatic continuation body kept as user text as a short label (app-ui)', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const transcript = require('../src/transcript');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  const orig = transcript.forResume;
  transcript.forResume = async () => ({turns: [{user: 'fix it', reply: 'one'}, {user: '[muser: automatic continuation]\nThe previous leg of this task stopped…', reply: 'two'}], from: 'local'});
  try {
    await ctrl.showResumed({id: 'fake-synth', title: 'chat', turns: 0});
    const users = ctrl.get().entries.filter(e => e.type === 'user').map(e => e.text);
    assert.equal(users.length, 2);
    assert.equal(users[0], 'fix it');
    assert.ok(!users[1].includes('[muser:'), 'the instruction is not shown as the user\'s words');
    assert.match(users[1], /自動で続行|continued automatically/);
  } finally { transcript.forResume = orig; }
});

test('/account add typed at the name prompt runs after the outer flow closes (audit #163)', async () => {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-acct-163-'));
  const ctrl = await accountCtrl(accountAgent(dir));
  let implLabel = null, screenDuring = null;
  ctrl.accountAddImpl = async ({label}) => { implLabel = label; screenDuring = ctrl.get().addFlow; return {account: {id: 'x', label}, same: null}; };
  const done = ctrl.accountCommand('add');
  await untilState(() => ctrl.get().promptFor);
  await ctrl.submit('/account add Inner');
  await done;
  await untilState(() => implLabel);
  assert.equal(implLabel, 'Inner', 'the inner add ran with its own name');
  assert.ok(screenDuring, 'the inner add had its screen up while it ran');
});

// ---------- selectable questions (focus.ask_user with options) ----------
const ASK = {questions: [
  {header: '猫', question: 'どの猫？', multi: false, options: [{label: '黒猫', description: '定番', preview: '/_/\n( o.o )'}, {label: '三毛猫', description: null, preview: null}]},
  {header: '付け合わせ', question: '付け合わせは？', multi: true, options: [{label: 'ちゅ〜る', description: null, preview: null}, {label: '段ボール箱', description: null, preview: null}, {label: '日なたぼっこ', description: null, preview: null}]},
]};
async function questionCtrl() {
  const dir = fs2.mkdtempSync(require('node:path').join(os.tmpdir(), 'muser-question-'));
  const agent = new FakeAgent(dir);
  const sent = [];
  agent.send = async (body, opts) => { sent.push({body, opts}); };
  const ctrl = await accountCtrl(agent);
  return {ctrl, sent};
}
const tick = () => new Promise(r => setTimeout(r, 0));
// The picker alone, rendered the way the render tests do: ink's renderToString at 80 columns.
async function renderQuestion(ctrl, W = 79) {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Question} = await import('../src/ui/view.mjs');
  const {strip} = require('../src/tui/term.js');
  return strip(renderToString(React.createElement(Question, {q: ctrl.get().question, W}), {columns: 80}));
}

test('a turn ending on a selectable question opens the picker, once per ask; esc keeps a typed answer possible', async () => {
  const {ctrl, sent} = await questionCtrl();
  const focus = {id: 'f1', round: 1, revision: 5, status: 'needs_input', ask: ASK};
  ctrl.agent.emit('turn-end', {ok: true, focus});
  assert.ok(ctrl.get().question, 'the picker opens');
  assert.equal(ctrl.get().question.questions.length, 2);
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().question, null, 'esc closes it');
  ctrl.agent.emit('turn-end', {ok: true, focus});
  assert.equal(ctrl.get().question, null, 'the same ask does not reopen after the user closed it');
  // The question is not lost: a free typed reply still goes to Muse as the answer.
  ctrl.setText('自由回答');
  ctrl.key('', {return: true});
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, '自由回答');
});

test('a plain question (no choices) does not open the picker', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.agent.emit('turn-end', {ok: true, focus: {id: 'f2', round: 1, revision: 1, status: 'needs_input', ask: null}});
  assert.equal(ctrl.get().question, null, 'plain ask_user stays text-only, as before');
});

test('a question with choices renders as a list (options, descriptions, preview, chat row)', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.openQuestion(ASK);
  const React = (await import('react')).default, {render} = await import('ink');
  const {Question} = await import('../src/ui/view.mjs');
  const {EventEmitter} = require('node:events');
  const out = new EventEmitter(); out.columns = 100; out.rows = 40; out.isTTY = false; out.buf = '';
  out.write = d => { out.buf += d; return true; };
  const app = render(React.createElement(Question, {q: ctrl.get().question, W: 100}), {stdout: out, debug: true, patchConsole: false, exitOnCtrlC: false});
  const start = Date.now();
  while (!out.buf) { if (Date.now() - start > 5000) throw new Error('no frame rendered'); await tick(); }
  app.unmount();
  const strip = require('../src/tui/term.js').strip || (s => s.replace(/\x1b\[[0-9;]*m/g, ''));
  const plain = strip(out.buf);
  assert.match(plain, /どの猫？/);
  assert.match(plain, /❯ 1\. 黒猫/, 'the highlighted row is marked ❯, like the other menus');
  assert.match(plain, /2\. 三毛猫/);
  assert.match(plain, /定番/);
  assert.match(plain, /\( o\.o \)/, 'the selected option preview shows beside the list');
  assert.match(plain, /3\. 自分で書く…/, 'type-your-own is the last numbered choice (n+1) of a single-select question');
  assert.match(plain, /この件について話す/, 'the chat row still renders (its separator position is checked below, without a preview)');
});

test('the Submit tab renders the review body: answers, unanswered marks, the warning and the submit row (t2 #4)', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.openQuestion(ASK);
  ctrl.key('', {return: true}); // 黒猫 for Q1; Q2 left unanswered
  ctrl.key('', {tab: true}); // to the Submit tab
  const plain = await renderQuestion(ctrl);
  assert.match(plain, /回答の確認/);
  assert.match(plain, /猫: 黒猫/, 'the answered question shows its pick');
  assert.match(plain, /付け合わせ: 未回答/, 'the unanswered question is marked');
  assert.match(plain, /未回答があります。このまま送りますか？/);
  assert.match(plain, /❯ 送信する/, 'the submit row is the cursor row');
});

test('an option preview longer than 8 display rows is cut with the omitted count (t2 #4)', async () => {
  const {ctrl} = await questionCtrl();
  const preview = Array.from({length: 12}, (_, i) => 'PVLINE-' + (i + 1)).join('\n');
  ctrl.openQuestion({questions: [{header: '猫', question: 'どの猫？', multi: false, options: [{label: '黒猫', description: null, preview}, {label: '三毛猫', description: null, preview: null}]}]});
  const plain = await renderQuestion(ctrl);
  assert.match(plain, /PVLINE-1/);
  assert.match(plain, /PVLINE-8/, 'the first 8 rows show');
  assert.ok(!plain.includes('PVLINE-9'), 'rows past 8 are not rendered');
  assert.ok(!plain.includes('PVLINE-12'));
  assert.match(plain, /✂ 4 行を省略/, 'the cut is announced with its count');
});

test('single picks advance, multi toggles with space, enter advances, the Submit tab sends the composed answers', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion(ASK);
  ctrl.key('', {return: true}); // 黒猫
  let q = ctrl.get().question;
  assert.equal(q.tab, 1, 'moved to the next question');
  assert.equal(q.answers[0], '黒猫', 'the Submit tab line is maintained');
  ctrl.key(' ', {}); // ちゅ〜る on (space toggles; enter would advance instead)
  ctrl.key('', {downArrow: true});
  ctrl.key(' ', {}); // 段ボール箱 on
  q = ctrl.get().question;
  assert.deepEqual(q.checked[1], [0, 1]);
  assert.equal(q.answers[1], 'ちゅ〜る、段ボール箱');
  ctrl.key('', {return: true}); // enter on a checked multi question advances, it does not send mid-list
  assert.equal(ctrl.get().question.tab, 2, 'on the Submit tab');
  ctrl.key('', {return: true});
  await tick();
  assert.equal(ctrl.get().question, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'どの猫？ → 黒猫\n付け合わせは？ → ちゅ〜る、段ボール箱');
});

test('type-something and notes ride along; chat-about-this closes without sending', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true});
  ctrl.key('', {return: true}); // Type something
  assert.equal(ctrl.get().question.mode, 'type');
  ctrl.paste('自家製');
  ctrl.key('!', {});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question.custom[0], '自家製!');
  ctrl.key('n', {});
  assert.equal(ctrl.get().question.mode, 'notes');
  for (const ch of 'memo') ctrl.key(ch, {});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question.notes, 'memo');
  ctrl.key('', {upArrow: true});
  ctrl.key('', {return: true}); // enter on a choice sends the single multi-select question at once, no Submit tab
  await tick();
  assert.equal(ctrl.get().question, null, 'enter sent the single multi-select question');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, '付け合わせは？ → 自家製!\nメモ: memo');
  // Chat about this: closes, sends nothing. (Rows now: options, type-your-own, chat.)
  ctrl.openQuestion({questions: [ASK.questions[0]]});
  ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question, null);
  assert.equal(sent.length, 1, 'still just the earlier send');
});

test('the Submit tab refuses while a question is unanswered and jumps to it', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[0], ASK.questions[0]]});
  ctrl.key('', {return: true}); // answer Q1 -> advance to Q2
  assert.equal(ctrl.get().question.tab, 1);
  ctrl.key('', {tab: true}); // Submit tab
  assert.equal(ctrl.get().question.tab, 2);
  ctrl.key('', {return: true});
  await tick();
  assert.equal(sent.length, 0, 'nothing sent');
  assert.equal(ctrl.get().question.tab, 1, 'jumped back to the unanswered question');
});

test('an answered question shows [✓] in the tab row', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.openQuestion(ASK);
  ctrl.key('', {return: true}); // answer Q1 (黒猫) -> advance to Q2
  const plain = await renderQuestion(ctrl);
  assert.match(plain, /\[✓\] 猫/, 'the answered tab is marked');
  assert.match(plain, /\[ \] 付け合わせ/, 'the unanswered tab is not');
});

test('a single single-select question sends on enter, with no Submit tab', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[0]]});
  ctrl.key('', {tab: true});
  assert.equal(ctrl.get().question.tab, 0, 'tab does not switch: there is no Submit tab');
  assert.ok(ctrl.get().question, 'still open');
  ctrl.key('', {return: true}); // 黒猫
  await tick();
  assert.equal(ctrl.get().question, null, 'the pick sent the answer at once');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'どの猫？ → 黒猫');
});

test('a single multi-select question sends on enter with the checked set', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  ctrl.key(' ', {}); // ちゅ〜る on
  assert.deepEqual(ctrl.get().question.checked[0], [0]);
  ctrl.key('', {return: true}); // enter sends the checked set at once, without a Submit tab
  await tick();
  assert.equal(ctrl.get().question, null, 'sent at once, without a Submit tab');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, '付け合わせは？ → ちゅ〜る');
});

test('a multi-select question refuses enter with nothing checked', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  ctrl.key('', {return: true}); // nothing checked: no send, no advance, no close
  await tick();
  assert.ok(ctrl.get().question, 'still open');
  assert.equal(sent.length, 0, 'nothing sent');
  const plain = await renderQuestion(ctrl);
  assert.match(plain, /enter 送信（1 つ以上選択）/, 'the hint says a selection is needed');
});

test('there is no 送信 row: rows are options, type-something, chat', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.openQuestion(ASK);
  assert.deepEqual(ctrl.questionRows(0).map(r => r.kind), ['option', 'option', 'type', 'chat']);
  assert.deepEqual(ctrl.questionRows(1).map(r => r.kind), ['option', 'option', 'option', 'type', 'chat']);
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  const lines = (await renderQuestion(ctrl)).split('\n');
  assert.ok(!lines.some(l => /^\s*(❯ )?送信\s*$/.test(l)), 'no standalone 送信 row in the render');
});

test('自分で書く… is numbered n+1, has a multi checkbox, and counts as an answer', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  let plain = await renderQuestion(ctrl);
  assert.match(plain, /\[ \] 4\. 自分で書く…/, 'the 3-option question numbers type-something 4, unchecked');
  ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().question.index, 3, 'on the type-something row');
  ctrl.key('4', {}); // the number key reaches type-something like any choice
  assert.equal(ctrl.get().question.mode, 'type', 'digit 4 opens the typed answer');
  ctrl.key('', {escape: true});
  ctrl.key('', {return: true}); // enter on type-something also opens it
  assert.equal(ctrl.get().question.mode, 'type');
  ctrl.paste('自家製');
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question.custom[0], '自家製');
  assert.equal(ctrl.get().question.answers[0], '自家製', 'the typed text counts as the answer');
  plain = await renderQuestion(ctrl);
  assert.match(plain, /\[✓\] 4\. 自分で書く…/, 'the typed answer checks the type-something box');
  assert.match(plain, /enter 送信（1 件）/, 'the hint counts the typed answer');
  ctrl.key('', {upArrow: true});
  ctrl.key('', {return: true}); // enter on a choice sends the typed answer with the checked set (here, just it)
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, '付け合わせは？ → 自家製');
});

test('この件について話す sits below a separator and still closes without sending', async () => {
  const {ctrl, sent} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  const plain = await renderQuestion(ctrl);
  const lines = plain.split('\n');
  const sep = lines.findIndex(l => l.replace(/[│\s]/g, '') === '─'.repeat(12));
  const type = lines.findIndex(l => l.includes('4. 自分で書く…'));
  const chat = lines.findIndex(l => l.includes('この件について話す'));
  assert.ok(sep > type && chat > sep, 'chat is below the separator line (type ' + type + ', separator ' + sep + ', chat ' + chat + ')');
  assert.ok(!/^\s*(❯ )?\d+\. この件について話す/m.test(plain), 'chat has no choice number');
  ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true}); ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().question.index, 4, 'down moves past the separator to chat');
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().question, null, 'chat closes the picker');
  assert.equal(sent.length, 0, 'chat sends nothing');
});

test('a multi-select question shows the （複数選択） mark, a single-select one does not', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[1]]});
  assert.match(await renderQuestion(ctrl), /付け合わせは？（複数選択）/);
  ctrl.openQuestion({questions: [ASK.questions[0]]});
  const plain = await renderQuestion(ctrl);
  assert.match(plain, /どの猫？/);
  assert.ok(!plain.includes('（複数選択）'), 'no mark on a single-select question: ' + plain);
});

test('a single question renders with no tab row', async () => {
  const {ctrl} = await questionCtrl();
  ctrl.openQuestion({questions: [ASK.questions[0]]});
  const plain = await renderQuestion(ctrl);
  assert.ok(!plain.includes('✓ 送信'), 'no Submit tab label: ' + plain);
  assert.ok(!plain.includes('[ ] 猫'), 'no question tab either');
  assert.match(plain, /どの猫？/, 'the question itself still shows');
});

test('questions without a header of their own get the short 質問 n tab label', async () => {
  const {ctrl} = await questionCtrl();
  const opts = [{label: 'はい', description: null, preview: null}, {label: 'いいえ', description: null, preview: null}];
  // No header at all, and the production fallback (header copied from the question text).
  for (const questions of [
    [{question: '見出しなしの質問は？', multi: false, options: opts}, {question: '二つ目はどうする？', multi: true, options: opts}],
    [{header: '見出しなしの質問は？', question: '見出しなしの質問は？', multi: false, options: opts}, {header: '二つ目はどうする？', question: '二つ目はどうする？', multi: true, options: opts}],
  ]) {
    ctrl.openQuestion({questions});
    const plain = await renderQuestion(ctrl);
    assert.match(plain, /質問 1/, 'the first tab is the short label');
    assert.match(plain, /質問 2/, 'the second tab is the short label');
    assert.equal(plain.split('見出しなしの質問は？').length - 1, 1, 'the question text is shown once, not in the tab and the body');
    ctrl.closeQuestion();
  }
});

test('the question hint line fits 79 columns in every mode (80-column render)', async () => {
  const {width} = require('../src/tui/term.js');
  const hintOf = async ctrl => {
    const lines = (await renderQuestion(ctrl)).split('\n').filter(l => l.trim());
    return lines[lines.length - 1];
  };
  const modes = [];
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion(ASK); modes.push(['single-select, several questions', await hintOf(ctrl), true, '↑↓ 移動']); }
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion(ASK); ctrl.key('', {return: true}); modes.push(['multi-select, several questions, nothing checked', await hintOf(ctrl), true, 'space 切替']); }
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion(ASK); ctrl.key('', {return: true}); ctrl.key(' ', {}); ctrl.key('', {downArrow: true}); ctrl.key(' ', {}); modes.push(['multi-select, several questions, 2 checked', await hintOf(ctrl), true, 'space 切替']); }
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion(ASK); ctrl.key('', {tab: true}); ctrl.key('', {tab: true}); modes.push(['Submit tab', await hintOf(ctrl), true, '↑↓ 移動']); }
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion({questions: [ASK.questions[0]]}); modes.push(['single-select, one question', await hintOf(ctrl), false, '↑↓ 移動']); }
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion({questions: [ASK.questions[1]]}); modes.push(['multi-select, one question, nothing checked', await hintOf(ctrl), false, 'space 切替']); }
  { const {ctrl} = await questionCtrl(); ctrl.openQuestion({questions: [ASK.questions[1]]}); ctrl.key(' ', {}); ctrl.key('', {downArrow: true}); ctrl.key(' ', {}); modes.push(['multi-select, one question, 2 checked', await hintOf(ctrl), false, 'space 切替']); }
  for (const [name, hint, hasTab, start] of modes) {
    assert.ok(width(hint) <= 79, name + ': hint is ' + width(hint) + ' columns: ' + hint);
    assert.match(hint, new RegExp('^ {2}' + start), name + ': the hint is a single line from its start: ' + hint);
    assert.match(hint, /esc 閉じる$/, name + ': the hint ends on the same line (no wrap): ' + hint);
    assert.equal(hint.includes('tab 質問'), hasTab, name + ': the tab part shows only with several questions');
  }
  // These modes have several questions: enter moves on to the next question / the send tab.
  assert.match(modes[1][1], /enter 次へ（1 つ以上選択）/, 'the unchecked multi hint says a selection is needed');
  assert.match(modes[2][1], /enter 次へ（2 件）/, 'the checked multi hint shows the count');
  // The English hints are longer: the widest mode (multi, several questions,
  // nothing checked) must fit too.
  const i18n = require('../src/i18n');
  try {
    i18n.setLang('en', {save: false});
    const {ctrl} = await questionCtrl(); ctrl.openQuestion(ASK); ctrl.key('', {return: true});
    const hint = await hintOf(ctrl);
    assert.ok(width(hint) <= 79, 'English hint is ' + width(hint) + ' columns: ' + hint);
    assert.match(hint, /^ {2}space toggle/, 'the English hint is a single line from its start: ' + hint);
    assert.match(hint, /esc close$/, 'the English hint ends on the same line: ' + hint);
    assert.match(hint, /pick 1\+/, 'the English unchecked hint says a selection is needed');
    assert.ok(hint.includes('tab question'), 'the English several-question hint keeps the tab part');
  } finally { i18n.setLang('ja', {save: false}); }
});

test('ctrl+shift+v and a right-click paste from the clipboard; other clicks are swallowed', async () => {
  const {ctrl} = await questionCtrl();
  let fromClipboard = 0; ctrl.pasteFromClipboard = () => { fromClipboard++; };
  ctrl.key('V', {ctrl: true, shift: true});
  assert.equal(fromClipboard, 1, 'ctrl+shift+v goes to the clipboard paste');
  ctrl.key('\x1b[<2;10;5M', {});
  assert.equal(fromClipboard, 2, 'right-button press pastes');
  ctrl.key('\x1b[<0;10;5M', {});
  ctrl.key('\x1b[<2;10;5m', {}); // release
  assert.equal(fromClipboard, 2, 'left clicks and releases do nothing');
  assert.equal(ctrl.get().text, '', 'mouse sequences never reach the composer');
});

test('ctrl+shift+v and right-click insert clipboard text through paste() (sanitised)', async () => {
  const clip = require('../src/clipboard');
  const origImages = clip.clipboardImages, origText = clip.clipboardText;
  let textReads = 0;
  clip.clipboardImages = async () => ({files: [], error: null});
  clip.clipboardText = async () => { textReads++; return 'hello\x1b[31m world\r\nnext'; };
  try {
    const {ctrl} = await questionCtrl();
    ctrl.key('V', {ctrl: true, shift: true});
    for (let i = 0; i < 20 && !ctrl.get().text; i++) await tick();
    assert.equal(ctrl.get().text, 'hello world\nnext', 'ctrl+shift+v text went through paste(): escapes stripped, CRLF normalised');
    assert.equal(textReads, 1);
    ctrl.setText('');
    ctrl.key('\x1b[<2;10;5M', {});
    for (let i = 0; i < 20 && !ctrl.get().text; i++) await tick();
    assert.equal(ctrl.get().text, 'hello world\nnext', 'a right-click pastes the same way');
    assert.equal(textReads, 2);
  } finally { clip.clipboardImages = origImages; clip.clipboardText = origText; }
});

test('/resume pages through the other folders with ← / →, this folder first', async () => {
  const sessions = require('../src/sessions');
  const path = require('node:path');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'muser-resume-pages-'));
  const agent = accountAgent(dir);
  const otherA = path.join(dir, 'proj-a'), otherB = path.join(dir, 'proj-b');
  const here = sessions.create(dir); sessions.touch(here, 'here chat');
  const a1 = sessions.create(otherA); sessions.touch(a1, 'a chat');
  const b1 = sessions.create(otherB); sessions.touch(b1, 'b chat');
  const ctrl = await accountCtrl(agent);
  ctrl.slash('/resume');
  const menu = () => ctrl.get().menu, labels = () => menu().options.map(o => o.label);
  assert.match(menu().title, /このフォルダー/);
  assert.ok(labels().includes('here chat') && !labels().includes('b chat') && !labels().includes('a chat'), 'this folder first, only its chats');
  // Walk right until back at this folder: every other folder is a page with only its chats.
  const seen = [];
  for (let i = 0; i < 200; i++) {
    ctrl.key('', {rightArrow: true});
    if (/このフォルダー/.test(menu().title)) break;
    seen.push({title: menu().title, labels: labels(), hint: menu().hint});
  }
  assert.match(menu().title, /このフォルダー/, 'it wraps around to this folder');
  const pageB = seen.find(p => p.title.includes(otherB)), pageA = seen.find(p => p.title.includes(otherA));
  assert.ok(pageB && pageA, 'both other folders have a page');
  assert.deepEqual(pageB.labels, ['b chat']);
  assert.deepEqual(pageA.labels, ['a chat']);
  assert.ok(seen.indexOf(pageB) < seen.indexOf(pageA), 'the folder with the newer chat comes first');
  assert.match(pageB.hint, /この窓のフォルダーで続きます/);
  ctrl.key('', {leftArrow: true});
  assert.equal(menu().title, seen[seen.length - 1].title, '← from this folder goes to the last page');
  ctrl.key('', {escape: true});
});

test('/resume in a folder without chats opens the newest other folder instead of saying there are none', async () => {
  const sessions = require('../src/sessions');
  const path = require('node:path');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'muser-resume-empty-'));
  const agent = accountAgent(path.join(dir, 'empty-here'));
  const elsewhere = sessions.create(path.join(dir, 'proj')); sessions.touch(elsewhere, 'elsewhere chat');
  const ctrl = await accountCtrl(agent);
  ctrl.slash('/resume');
  assert.ok(ctrl.get().menu, 'a menu opens');
  assert.ok(ctrl.get().menu.options.some(o => o.label === 'elsewhere chat'));
  ctrl.key('', {escape: true});
});

// The GUI and the app draw a reply from its Markdown, not from the terminal rows: each md
// piece carries the source lines it was rendered from, and a message's pieces joined in
// order give back its Markdown exactly — a fence and a table that span pieces included.
test('md pieces carry their Markdown source; joined, they are the whole message', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  const full = '# Title\n\nSome **bold** text.\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n> more';
  // stream it in uneven chunks so the fence, the table and the quote each span pieces
  let shown = '';
  for (const n of [9, 13, 7, 15, 4, 11, 6, 14, 9, 3, 30, 200]) {
    shown = full.slice(0, Math.min(full.length, shown.length + n));
    agent.emit('text', {id: 'm', text: shown});
  }
  agent.emit('message-done', {id: 'm'});
  const pieces = ctrl.get().entries.filter(e => e.type === 'md');
  assert.ok(pieces.length > 3, 'the reply arrived in several pieces');
  assert.ok(pieces.every(p => typeof p.src === 'string'), 'every piece names its source');
  assert.equal(pieces[0].first, true);
  assert.equal(pieces.map(p => p.src).join('\n'), full);
});
