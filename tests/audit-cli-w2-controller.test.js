'use strict';
// audit-cli wave 2 (test stage): regression tests for the controller fixes in
// a43022b — W2F-1 (account switch expires pending approval/question/limit),
// W2F-4 (/race and /overnight double-start guards), W2F-5 (daily-limit
// warning re-arms when the limit changes) and W2F-6 (demo must not write the
// real skills/lang config). Style follows tests/controller.test.js:
// FakeAgent + the real Controller, isolated home/data folders.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// Self-isolation guard, the same pattern as the top of tests/controller.test.js:
// point LOCALAPPDATA and the home folder at throwaway dirs HERE, before any
// src module can load, so this file is safe with or without tests/setup.mjs.
const fsTop = require('node:fs');
const pathTop = require('node:path');
process.env.LOCALAPPDATA = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-w2ctrl-data-'));
process.env.USERPROFILE = process.env.HOME = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-w2ctrl-home-'));
const createdTmpDirs = [];
const origMkdtempSync = fsTop.mkdtempSync.bind(fsTop);
fsTop.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdTmpDirs.push(dir); return dir; };
createdTmpDirs.push(process.env.LOCALAPPDATA, process.env.HOME);
after(() => { for (const dir of createdTmpDirs) { try { fsTop.rmSync(dir, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

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
const tick = () => new Promise(r => setTimeout(r, 0));
const until = async fn => { for (let i = 0; i < 1000 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); };
const tmpDir = tag => fs2.mkdtempSync(pathTop.join(os.tmpdir(), tag));
const editCall = () => ({command: 'code.write', params: {path: 'x.txt', content: 'y'}, kind: 'edit', agent: 'main'});

// ---------- (1) W2F-1: an account switch expires pending approvals/questions ----------

test('W2F-1: an account switch expires the shown and queued approvals; answer() afterwards is a no-op', async () => {
  const ctrl = await accountCtrl(accountAgent(tmpDir('muser-w2-acct-')));
  const shown = ctrl.ask(editCall());
  const queued = ctrl.ask(editCall());
  assert.ok(ctrl.get().approval, 'the first approval is on screen');
  assert.equal((ctrl.pending || []).length, 1, 'the second approval waits in the queue');
  ctrl.agent.emit('account', {id: 'other', label: 'Other'});
  assert.deepEqual(await shown, {allow: false, expired: true}, 'the shown approval expires on the deny side');
  assert.deepEqual(await queued, {allow: false, expired: true}, 'the queued approval expires too, it is not carried to the new account');
  assert.equal(ctrl.get().approval, null, 'no approval stays on the new account screen');
  assert.equal((ctrl.pending || []).length, 0, 'the approval queue is emptied');
  ctrl.answer(0); // the old approval must not be allow-able after the switch
  assert.equal(ctrl.get().approval, null);
  assert.equal(ctrl.get().running, null, 'answering the expired approval starts nothing');
});

test('W2F-1: a switch also expires a decline-reason approval and clears question, limit input and prompt', async () => {
  const ctrl = await accountCtrl(accountAgent(tmpDir('muser-w2-acct2-')));
  const p = ctrl.ask(editCall());
  const decline = ctrl.get().approval.options.findIndex(o => !o.allow);
  ctrl.answer(decline); // into the decline-reason stage: same request, new state
  assert.ok(ctrl.get().reasonFor, 'the approval is in its decline-reason stage');
  ctrl.openQuestion({questions: [{header: '猫', question: 'どの猫？', multi: false, options: [{label: '黒猫'}, {label: '三毛猫'}]}]});
  assert.ok(ctrl.get().question, 'a selectable question is open');
  ctrl.set({limitInput: {key: 'dailyTurnLimit', text: '3'}});
  const prompt = ctrl.promptAsk('名前は？');
  const promptResult = prompt.catch(e => e); // cancelPrompt rejects it
  assert.ok(ctrl.get().promptFor, 'a composer prompt is waiting');
  ctrl.agent.emit('account', {id: 'other', label: 'Other'});
  assert.deepEqual(await p, {allow: false, expired: true}, 'the reason-stage approval expires instead of staying answerable');
  assert.ok((await promptResult) instanceof Error, 'the pending prompt is cancelled by the switch');
  const s = ctrl.get();
  assert.equal(s.approval, null);
  assert.equal(s.reasonFor, null, 'the decline-reason stage is gone');
  assert.equal(s.question, null, 'the old account question picker is closed');
  assert.equal(s.limitInput, null, 'the old account limit input is closed');
  assert.equal(s.promptFor, null, 'the composer prompt is gone');
  clearTimeout(ctrl.flashTimer); clearTimeout(ctrl.promptFlashTimer);
});

// ---------- (2) W2F-4: /race --yes double start ----------

test('W2F-4: two /race --yes in a row start runRace only once', async () => {
  const race = require('../src/race');
  const orig = {dirtyFiles: race.dirtyFiles, estimate: race.estimate, runRace: race.runRace, formatRaceResult: race.formatRaceResult};
  let calls = 0, release = null;
  race.dirtyFiles = async () => [];
  race.estimate = () => ({lines: ['見積もり']});
  race.runRace = () => { calls++; return new Promise(res => { release = () => res({id: 'race-w2', racers: []}); }); };
  race.formatRaceResult = () => ['結果'];
  try {
    const {Controller} = await import('../src/ui/controller.mjs');
    const ctrl = new Controller({agent: new FakeAgent(tmpDir('muser-w2-race-')), museName: 'm', version: 't', onExit() {}});
    ctrl.slash('/race --yes テストの頼み');
    ctrl.slash('/race --yes テストの頼み'); // synchronously, before the first start() could stand the old flag
    await until(() => calls === 1);
    await new Promise(r => setTimeout(r, 30)); // give a wrongly-started second race its chance to appear
    assert.equal(calls, 1, 'runRace ran exactly once');
    assert.equal(notesWith(ctrl, /競争は実行中です/).length, 1, 'the second start is refused with the running note');
    release();
    await until(() => ctrl.raceRun === false);
    assert.equal(calls, 1, 'still one race after it finishes');
    ctrl.cancelMenu();
  } finally { Object.assign(race, orig); }
});

// ---------- (3) W2F-4: /overnight start double start ----------

test('W2F-4: two /overnight start in a row run overnightCli only once, and the guard releases afterwards', async () => {
  const cliMod = require('../src/overnight/cli');
  const orig = cliMod.overnightCli;
  let calls = 0, release = null, gated = true;
  cliMod.overnightCli = () => { calls++; return gated ? new Promise(res => { release = () => res({lines: ['完了']}); }) : Promise.resolve({lines: ['完了']}); };
  try {
    const {Controller} = await import('../src/ui/controller.mjs');
    const ctrl = new Controller({agent: new FakeAgent(tmpDir('muser-w2-night-')), museName: 'm', version: 't', onExit() {}});
    const first = ctrl.slash('/overnight start');
    ctrl.slash('/overnight start'); // while the first run is still in flight
    await tick();
    assert.equal(calls, 1, 'overnightCli ran exactly once');
    assert.equal(notesWith(ctrl, /夜間作業は実行中です/).length, 1, 'the second start is refused with the running note');
    release();
    await first;
    assert.equal(ctrl.overnightRun, false, 'the guard is released when the run ends');
    assert.ok(ctrl.get().entries.some(e => e.type === 'overnight'), 'the finished run reports back');
    gated = false;
    await ctrl.slash('/overnight start');
    assert.equal(calls, 2, 'a start after the run finished is allowed again');
  } finally { cliMod.overnightCli = orig; }
});

// ---------- (4) W2F-5: the daily-limit warning re-arms ----------

test('W2F-5: the daily-limit warning fires once per limit value and re-arms when the limit changes', async t => {
  const usage = require('../src/usage');
  const dir = tmpDir('muser-w2-usage-');
  const prevFile = process.env.MUSER_USAGE_FILE, prevLimit = process.env.MUSER_DAILY_TURN_LIMIT;
  t.after(() => {
    if (prevFile === undefined) delete process.env.MUSER_USAGE_FILE; else process.env.MUSER_USAGE_FILE = prevFile;
    if (prevLimit === undefined) delete process.env.MUSER_DAILY_TURN_LIMIT; else process.env.MUSER_DAILY_TURN_LIMIT = prevLimit;
  });
  process.env.MUSER_USAGE_FILE = pathTop.join(dir, 'usage.json');
  process.env.MUSER_DAILY_TURN_LIMIT = '3';
  usage.record({turns: 5}); // today is already past both limits used below
  const ctrl = await accountCtrl(accountAgent(tmpDir('muser-w2-limit-')));
  const warned = n => notesWith(ctrl, new RegExp('今日のターン上限（' + n + '）に達しました')).length;
  ctrl.agent.emit('turn-end', {ok: true});
  assert.equal(warned(3), 1, 'the warning fires when the limit is reached');
  ctrl.agent.emit('turn-end', {ok: true});
  assert.equal(warned(3), 1, 'and only once for the same day and limit');
  process.env.MUSER_DAILY_TURN_LIMIT = '5'; // the user raises the limit (still reached)
  ctrl.agent.emit('turn-end', {ok: true});
  assert.equal(warned(5), 1, 'changing the limit re-arms the warning for the new limit');
  ctrl.agent.emit('turn-end', {ok: true});
  assert.equal(warned(5), 1, 'the new limit also warns only once');
});

// ---------- (5) W2F-6: demo writes no real config ----------

test('W2F-6: in demo, /lang applies only to this run and /skills refuses to save — the real config is untouched', async () => {
  const i18n = require('../src/i18n');
  const cwd = tmpDir('muser-w2-demo-');
  const skillDir = pathTop.join(cwd, '.muser', 'skills', 'w2demo');
  fs2.mkdirSync(skillDir, {recursive: true});
  fs2.writeFileSync(pathTop.join(skillDir, 'SKILL.md'), '---\nname: w2demo\ndescription: Demo skill for the wave2 test\n---\nDo the thing.\n');
  const configFile = pathTop.join(process.env.HOME, '.muser', 'config.json');
  const configBytes = () => { try { return fs2.readFileSync(configFile, 'utf8'); } catch { return null; } };
  const before = configBytes();
  i18n.setLang('ja', {save: false});
  try {
    const {Controller} = await import('../src/ui/controller.mjs');
    const agent = new FakeAgent(cwd);
    agent.client = {status: 'demo'};
    const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
    ctrl.refreshPlan = () => Promise.resolve(null);
    // /lang with an argument: switches this run, must not save.
    ctrl.slash('/lang en');
    assert.equal(i18n.lang(), 'en', 'the demo language switch still applies to this run');
    assert.equal(configBytes(), before, '/lang en in demo did not write the real config');
    // /lang through the menu pick: same rule.
    i18n.setLang('ja', {save: false});
    ctrl.slash('/lang');
    assert.ok(ctrl.get().menu, 'the language menu opens in demo');
    ctrl.set({menu: {...ctrl.get().menu, index: 0}}); // English
    ctrl.key('', {return: true});
    assert.equal(i18n.lang(), 'en', 'the menu pick also applies to this run');
    assert.equal(configBytes(), before, 'the /lang menu pick in demo did not write the real config');
    // /skills: picking a skill toggle is refused and saves nothing.
    i18n.setLang('ja', {save: false}); // back to Japanese so the refusal note reads as written
    ctrl.slash('/skills');
    const menu = ctrl.get().menu;
    assert.ok(menu, 'the skills menu opens in demo');
    assert.equal(menu.options[0].value, 'skill:w2demo');
    ctrl.key('', {return: true}); // pick the skill toggle
    assert.equal(notesWith(ctrl, /デモでは設定を保存しません/).length, 1, 'the demo toggle is refused with the demo note');
    assert.equal(configBytes(), before, 'the /skills pick in demo did not write the real config');
    // Picking a whole-source toggle goes through the same pick handler: refused too.
    const menu2 = ctrl.get().menu;
    assert.ok(menu2, 'the skills menu reopens after the refusal');
    ctrl.set({menu: {...menu2, index: menu2.options.length - 1}}); // the source toggle row
    ctrl.key('', {return: true});
    assert.equal(notesWith(ctrl, /デモでは設定を保存しません/).length, 2, 'the source toggle is refused too');
    assert.equal(configBytes(), before, 'the /skills source pick in demo did not write the real config');
    ctrl.cancelMenu();
  } finally { i18n.setLang('ja', {save: false}); }
});
