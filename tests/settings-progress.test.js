'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Agent, preamble} = require('../src/agent');
const {applyAgentLimits} = require('../src/settings');
const config = require('../src/config');
const sessions = require('../src/sessions');

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-settings-progress-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const client = new EventEmitter(); client.status = 'demo'; client.disconnect = () => {};
  const agent = new Agent({client, auth: {}, cwd, session: sessions.create(cwd), agentLimits: {maxAgents: 4, maxAgentsTotal: 0}});
  t.after(() => agent.close());
  return agent;
}
function start(agent) {
  return agent.main.turn = {controller: new AbortController(), started: Date.now(), toolCalls: 0, sources: new Map(), log: {tools: [], steps: []}};
}
async function controller(agent) {
  const {Controller} = await import('../src/ui/controller.mjs');
  return new Controller({agent, museName: 'Muse', version: '0.3.6', onExit() {}});
}

test('/settings edits both limits via keys without sending a prompt or losing the draft', async t => {
  const agent = setup(t), ctrl = await controller(agent);
  ctrl.setText('unfinished draft');
  ctrl.slash('/settings agents');
  ctrl.key('1', {}); // concurrent
  ctrl.key('8', {}); // replaces selected old value
  ctrl.key('', {return: true});
  ctrl.key('2', {}); // total
  ctrl.paste('20');
  ctrl.key('', {return: true});
  assert.deepEqual(agent.agentLimits, {concurrent: 4, perTurn: 0}, 'editing is only a draft');
  ctrl.key('3', {}); // apply session only
  assert.deepEqual(agent.agentLimits, {concurrent: 8, perTurn: 20});
  assert.equal(ctrl.get().text, 'unfinished draft');
  assert.equal(agent.main.turn, null);
});

test('/settings rejects empty/unsafe values and cancels without changing limits or interrupting work', async t => {
  const agent = setup(t), ctrl = await controller(agent), turn = start(agent);
  ctrl.set({busy: true});
  ctrl.slash('/settings agents'); ctrl.key('1', {});
  ctrl.key('', {backspace: true}); ctrl.key('', {return: true});
  assert.ok(ctrl.get().limitInput);
  ctrl.paste('9007199254740992'); ctrl.key('', {return: true});
  assert.ok(ctrl.get().limitInput);
  ctrl.key('', {escape: true}); ctrl.key('', {escape: true});
  assert.deepEqual(agent.agentLimits, {concurrent: 4, perTurn: 0});
  assert.equal(agent.main.turn, turn);
  assert.equal(turn.controller.signal.aborted, false);
  clearTimeout(ctrl.flashTimer);
});

test('saved settings preserve unrelated keys, save failure leaves live limits unchanged, invalid limits never save', t => {
  const agent = setup(t), original = config.update;
  t.after(() => { config.update = original; });
  const cfg = {lang: 'en', bell: false, skills: {disabled: ['example']}};
  config.update = fn => { fn(cfg); return cfg; };
  applyAgentLimits(agent, {concurrent: 2, perTurn: 7}, {save: true});
  assert.deepEqual(cfg, {lang: 'en', bell: false, skills: {disabled: ['example']}, maxAgents: 2, maxAgentsTotal: 7});
  config.update = () => { throw new Error('disk full'); };
  assert.throws(() => applyAgentLimits(agent, {concurrent: 8, perTurn: 0}, {save: true}), /disk full/);
  assert.deepEqual(agent.agentLimits, {concurrent: 2, perTurn: 7});
  for (const value of [-1, 1.5, NaN, Infinity, '4', 9007199254740992])
    assert.throws(() => applyAgentLimits(agent, {concurrent: value, perTurn: 0}, {save: true}), /integers/);
});

test('lowered limits govern new spawns without stopping existing workers or resetting task count', t => {
  const agent = setup(t);
  agent.runTurn = async w => { w.starting = true; }; // keep launches active without a remote request
  start(agent);
  const worker = agent.spawn('first');
  applyAgentLimits(agent, {concurrent: 1, perTurn: 0});
  assert.equal(worker.starting, true);
  assert.equal(agent.spawnedThisTurn, 1);
  assert.throws(() => agent.spawn('second'), /1/);
  worker.starting = false;
  applyAgentLimits(agent, {concurrent: 0, perTurn: 1});
  assert.throws(() => agent.spawn('second'), /1/);
  applyAgentLimits(agent, {concurrent: 0, perTurn: 0});
  agent.spawn('second');
  assert.equal(agent.spawnedThisTurn, 2);
});

test('/settings saves real defaults in an isolated home and the resolver loads them on next start', async t => {
  const agent = setup(t), ctrl = await controller(agent), originalHome = os.homedir;
  os.homedir = () => agent.cwd;
  try {
    assert.equal(config.file(), path.join(agent.cwd, '.muser', 'config.json'));
    fs.mkdirSync(path.dirname(config.file()), {recursive: true});
    fs.writeFileSync(config.file(), JSON.stringify({lang: 'ja', bell: false}));
    agent.client.status = 'connected';
    ctrl.slash('/settings agents'); ctrl.key('1', {}); ctrl.key('6', {}); ctrl.key('', {return: true}); ctrl.key('4', {});
    assert.deepEqual(config.read(), {lang: 'ja', bell: false, maxAgents: 6, maxAgentsTotal: 0});
    assert.deepEqual(require('../src/agent').resolveAgentLimits({}, {}), {concurrent: 6, perTurn: 0});
    assert.deepEqual(require('../src/agent').resolveAgentLimits({maxAgents: 3}, {MUSER_MAX_AGENTS_TOTAL: '12'}), {concurrent: 3, perTurn: 12});
  } finally { os.homedir = originalHome; }
});

test('progress.report displays during the turn, keeps a running tool intact, persists and replays on resume', async t => {
  const agent = setup(t), ctrl = await controller(agent), turn = start(agent);
  agent.mode = 'plan'; ctrl.set({busy: true});
  agent.emit('tool-start', {id: 'long-command', command: 'system.run', summary: 'checking'});
  let ended = false; agent.on('turn-end', () => { ended = true; });
  const result = await agent.execute('progress.report', {agent: 'main', message: 'Checked sessions; verifying the fix next.'}, 1000, 'report-1');
  assert.deepEqual(result, {ok: true, payload: {displayed: true}});
  assert.equal(ctrl.get().entries.at(-1).type, 'progress');
  assert.equal(ctrl.get().entries.at(-1).message, 'Checked sessions; verifying the fix next.');
  assert.equal(ctrl.get().running.call.id, 'long-command');
  assert.equal(ctrl.get().busy, true);
  assert.equal(ended, false);
  assert.equal(agent.main.turn, turn);
  assert.equal(turn.toolCalls, 1);
  agent.record(agent.main, turn, 'test progress', {reply: 'done'});
  assert.equal(sessions.transcript(agent.session.id)[0].progress[0].message, 'Checked sessions; verifying the fix next.');
  const resumed = await controller(agent);
  await resumed.showResumed(agent.session, {startup: true});
  assert.equal(resumed.get().entries.filter(e => e.type === 'progress').length, 1);
});

test('progress.report refuses invalid content and idle/mismatched workers; respects tool budget', async t => {
  const agent = setup(t); const reports = [];
  agent.on('progress', r => reports.push(r));
  assert.equal((await agent.execute('progress.report', {message: 'idle'})).ok, false);
  const turn = start(agent);
  for (const message of [null, 42, '', '   ', 'x'.repeat(2001)])
    assert.equal((await agent.execute('progress.report', {agent: 'main', message})).ok, false);
  assert.equal((await agent.execute('progress.report', {agent: 'missing', message: 'wrong tag'})).ok, false);
  assert.equal(reports.length, 0);
  assert.equal((await agent.execute('progress.report', {agent: 'main', message: '\x1b[31mchecking\x07'})).ok, true);
  assert.ok(!/[\x1b\x07]/.test(reports[0].message));
  agent.maxToolCallsPerTurn = turn.toolCalls;
  assert.equal((await agent.execute('progress.report', {agent: 'main', message: 'over budget'})).ok, false);
  assert.equal(reports.length, 1);
});

test('registered progress command and common prompt explain the interim reporting contract', t => {
  const agent = setup(t);
  assert.equal(agent.commands()['progress.report'].required.message.type, 'string');
  assert.equal(agent.commands()['progress.report'].optional.agent.type, 'string');
  assert.match(preamble(agent.cwd, []), /progress\.report/);
  assert.match(preamble(agent.cwd, []), /does not finish the turn/);
  assert.equal(require('../src/agent-types').allows(require('../src/agent-types').load(agent.cwd).explore, 'progress.report'), true);
});

// Picks a /settings row by its value (numbers shift whenever a row is added).
function choose(ctrl, value) {
  const m = ctrl.get().menu, i = m.options.findIndex(o => o.value === value);
  if (i < 0) throw new Error('no row ' + value);
  ctrl.set({menu: {...m, index: i}}); ctrl.key('', {return: true});
}

test('/settings lists every setting with its value; switches flip, are saved, and take effect at once', async t => {
  const settings = require('../src/settings');
  const agent = setup(t), ctrl = await controller(agent);
  agent.client.status = 'connected';
  const file = config.file();
  t.after(() => { fs.rmSync(file, {force: true}); settings.reloadSwitches(); });
  settings.reloadSwitches();
  ctrl.slash('/settings');
  const menu = () => ctrl.get().menu;
  const row = value => menu().options.find(o => o.value === value);
  assert.deepEqual(menu().options.map(o => o.value), ['agents', 'focus', 'focusRounds', 'focusMinutes', 'focusLogLevel', 'worklog', 'worklogDays', 'expectMode', 'lore', 'bangAutoSend', 'bgAutoResume', 'maxToolCallsPerTurn', 'maxNodeSlots', 'dailyTurnLimit', 'quotaFallback', 'mode', 'defaultMode', 'lang', 'motion', 'codeWrap', 'footerDevice', 'footerSlot', 'footerName', 'footerUsage', 'footerCwd', 'footerSession', 'footerVersion', 'footerClock', 'color', 'kitty', 'fullscreen', 'bell', 'updateCheck', 'skills', 'mcp']);
  // Every row carries its genre, each genre one contiguous block, in order.
  assert.ok(menu().options.every(o => typeof o.group === 'string' && o.group), 'every row carries its genre');
  assert.deepEqual([...new Set(menu().options.map(o => o.group))], ['作業の進め方', '上限と使用量', '承認', '表示', '通知と更新', '連携'], 'the genres, in display order');
  const genreRuns = menu().options.map(o => o.group).filter((g, i, all) => i && g !== all[i - 1]).length;
  assert.equal(genreRuns, 5, 'each genre is one contiguous block');
  assert.equal(row('bell').group, '通知と更新');
  assert.equal(row('color').group, '表示');
  assert.equal(row('footerCwd').desc, 'オン');
  assert.equal(row('footerSession').desc, 'オフ');
  assert.equal(row('footerClock').desc, 'オフ');
  assert.equal(row('footerSlot').desc, 'オフ', 'the window slot is internal: off by default');
  assert.equal(row('footerDevice').desc, 'オン');
  assert.equal(row('footerUsage').desc, 'オン');
  assert.equal(row('agents').desc, '同時 4 ／ タスク合計 無制限');
  assert.equal(row('bell').desc, 'オン');
  assert.equal(row('maxToolCallsPerTurn').desc, '250 回');
  assert.equal(row('maxNodeSlots').desc, '16 個', 'the device slot cap, 16 by default');
  assert.equal(row('maxNodeSlots').group, '上限と使用量');
  assert.match(row('color').desc, /次回起動から/);

  choose(ctrl, 'bell');
  assert.equal(settings.switchValue('bell'), false, 'in effect now');
  assert.equal(config.read().bell, false, 'and saved');
  assert.equal(menu().options[menu().index].value, 'bell', 'the menu stays on the same row');
  assert.equal(row('bell').desc, 'オフ');

  choose(ctrl, 'codeWrap');
  assert.equal(settings.switchValue('codeWrap'), true);
  choose(ctrl, 'focus');
  assert.equal(agent.focusEnabled, false);
  assert.equal(config.read().focus, false);
  settings.reloadSwitches();
  assert.equal(settings.switchValue('focus'), false, 'the next start reads it');

  choose(ctrl, 'agents');
  assert.equal(menu().title, 'エージェント上限');
});

test('/settings numbers: range-checked, saved, and the tool-call limit applies to this window at once', async t => {
  const settings = require('../src/settings');
  const agent = setup(t), ctrl = await controller(agent);
  agent.client.status = 'connected';
  t.after(() => { fs.rmSync(config.file(), {force: true}); settings.reloadSwitches(); });
  settings.reloadSwitches();
  ctrl.slash('/settings');
  choose(ctrl, 'maxToolCallsPerTurn');
  assert.equal(ctrl.get().limitInput.label, '1ターンのツール呼び出し上限');
  ctrl.paste('0'); ctrl.key('', {return: true});
  assert.ok(ctrl.get().limitInput, '0 is out of range (1 or more): still asking');
  ctrl.key('', {backspace: true}); ctrl.paste('400'); ctrl.key('', {return: true});
  assert.equal(ctrl.get().limitInput, null);
  assert.equal(agent.maxToolCallsPerTurn, 400, 'this window, from the next call');
  assert.equal(config.read().maxToolCallsPerTurn, 400);
  assert.equal(require('../src/agent').resolveMaxToolCallsPerTurn(undefined, undefined), 400, 'and the next start');
  assert.equal(require('../src/usage').limits().perTurnTools, 400);

  choose(ctrl, 'focusRounds');
  ctrl.paste('5'); ctrl.key('', {return: true});
  assert.equal(settings.numberValue('focusRounds'), 5);
  choose(ctrl, 'dailyTurnLimit');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().menu.title, '設定', 'esc goes back to the list');
  assert.equal(settings.numberValue('dailyTurnLimit'), 0);

  choose(ctrl, 'defaultMode');
  choose(ctrl, 'plan');
  assert.equal(settings.defaultMode(), 'plan');
  assert.equal(config.read().defaultMode, 'plan');
});


test('/settings says when an environment variable decides a switch', async t => {
  const settings = require('../src/settings');
  const agent = setup(t), ctrl = await controller(agent);
  const was = process.env.MUSER_NO_BELL; process.env.MUSER_NO_BELL = '1';
  t.after(() => { if (was === undefined) delete process.env.MUSER_NO_BELL; else process.env.MUSER_NO_BELL = was; settings.reloadSwitches(); });
  ctrl.slash('/settings');
  assert.match(ctrl.get().menu.options.find(o => o.value === 'bell').desc, /オフ.*MUSER_NO_BELL/);
  assert.match(ctrl.get().menu.hint, /デモでは設定を保存しません/, 'the demo saves nothing');
});

test('spinner.set: Muse names its own spinner word; display only, free, cleared when the turn ends', async t => {
  const {Live} = await import('../src/ui/view.mjs');
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const agent = setup(t), ctrl = await controller(agent), turn = start(agent);
  ctrl.set({busy: true, turnStart: Date.now()});
  const r = await agent.execute('spinner.set', {word: 'Untangling regexes…', agent: 'main'}, 30000, 'sp1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctrl.get().spinnerWord, 'Untangling regexes', 'a trailing ellipsis is dropped (the screen adds one)');
  assert.equal(turn.toolCalls, 0, 'not counted against the tool-call limit');
  const line = renderToString(React.createElement(Live, {s: ctrl.get(), ctrl, W: 79}), {columns: 80});
  assert.match(line, /Untangling regexes…/);
  assert.equal((await agent.execute('spinner.set', {word: '', agent: 'main'}, 30000, 'sp2')).ok, false);
  assert.equal((await agent.execute('spinner.set', {word: 'x'.repeat(41), agent: 'main'}, 30000, 'sp3')).ok, false);
  agent.emit('turn-end', {ok: true, text: 'done'});
  assert.equal(ctrl.get().spinnerWord, null, 'the next turn starts without it');
  assert.match(preamble(agent.cwd, []), /spinner\.set/);
  assert.ok(require('../src/agent-types').BUILTIN.explore.tools.includes('spinner.set'), 'read-only agents may use it');
});

test('/settings flips the SAVED value of a switch an environment variable decides, and says it does not show yet', async t => {
  const settings = require('../src/settings');
  const agent = setup(t), ctrl = await controller(agent);
  agent.client.status = 'connected';
  const file = config.file();
  const was = process.env.MUSER_NO_BELL; process.env.MUSER_NO_BELL = '1';
  t.after(() => { if (was === undefined) delete process.env.MUSER_NO_BELL; else process.env.MUSER_NO_BELL = was; fs.rmSync(file, {force: true}); settings.reloadSwitches(); });
  settings.reloadSwitches();
  const press = () => { ctrl.slash('/settings'); const m = ctrl.get().menu; ctrl.set({menu: {...m, index: m.options.findIndex(o => o.value === 'bell')}}); ctrl.key('', {return: true}); };
  press();
  assert.equal(config.read().bell, false, 'saved on -> off');
  press();
  assert.equal(config.read().bell, true, 'and back on: it used to stay "on" for ever');
  assert.equal(settings.switchValue('bell'), false, 'the environment still decides');
  assert.ok(ctrl.get().entries.some(e => e.type === 'note' && /MUSER_NO_BELL が優先されるので/.test(e.lines.join(''))));
  ctrl.slash('/settings');
  assert.match(ctrl.get().menu.options.find(o => o.value === 'bell').desc, /保存した値はオン/);
});

test('/settings: saving the agent limits says when MUSER_MAX_AGENTS will win at the next start', async t => {
  const agent = setup(t), ctrl = await controller(agent);
  agent.client.status = 'connected';
  const file = config.file();
  const was = process.env.MUSER_MAX_AGENTS; process.env.MUSER_MAX_AGENTS = '2';
  t.after(() => { if (was === undefined) delete process.env.MUSER_MAX_AGENTS; else process.env.MUSER_MAX_AGENTS = was; fs.rmSync(file, {force: true}); });
  ctrl.agentLimitsMenu({concurrent: 5, perTurn: 0});
  const m = ctrl.get().menu;
  ctrl.set({menu: {...m, index: m.options.findIndex(o => o.value === 'save')}});
  ctrl.key('', {return: true});
  assert.equal(config.read().maxAgents, 5);
  assert.ok(ctrl.get().entries.some(e => e.type === 'note' && /MUSER_MAX_AGENTS が保存した値より優先/.test(e.lines.join(''))));
});

test('config: a save waits out another process that has config.json open for a moment', async t => {
  const {spawn} = require('node:child_process');
  const file = config.file();
  t.after(() => fs.rmSync(file, {force: true}));
  config.update(c => { c.keep = 1; });
  // Another process opens the file and keeps it open for 300 ms (as another window reading it).
  const holder = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');console.log('open');setTimeout(()=>fs.closeSync(fd),300);", file]);
  await new Promise(r => holder.stdout.once('data', r));
  config.update(c => { c.saved = true; }); // threw EPERM before the retry
  await new Promise(r => holder.on('exit', r));
  assert.deepEqual(config.read(), {keep: 1, saved: true});
});

test('permissions: a folder\'s mode is saved even while another window has permissions.json open', async t => {
  const {spawn} = require('node:child_process');
  const permissions = require('../src/permissions');
  const f = permissions.file();
  t.after(() => fs.rmSync(f, {force: true}));
  permissions.saveMode('C:\one', 'auto-edit');
  const holder = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');console.log('open');setTimeout(()=>fs.closeSync(fd),300);", f]);
  await new Promise(r => holder.stdout.once('data', r));
  permissions.saveMode('C:\two', 'plan'); // failed silently (EPERM swallowed) before the retry
  await new Promise(r => holder.on('exit', r));
  assert.equal(permissions.load('C:\two').mode, 'plan');
  assert.equal(permissions.load('C:\one').mode, 'auto-edit', 'the other folder is kept');
});

test('/settings: "check for updates" says when this install is a development checkout that is never checked', async t => {
  const settings = require('../src/settings');
  const update = require('../src/update');
  const agent = setup(t), ctrl = await controller(agent);
  settings.reloadSwitches();
  const was = process.env.MUSER_UPDATE_CHECK; delete process.env.MUSER_UPDATE_CHECK;
  t.after(() => { if (was !== undefined) process.env.MUSER_UPDATE_CHECK = was; });
  ctrl.slash('/settings');
  const desc = ctrl.get().menu.options.find(o => o.value === 'updateCheck').desc;
  assert.equal(/開発用のチェックアウト/.test(desc), update.devCheckout(), desc);
});

// Audit #223: the settings cache is keyed on config.json's stamp, so a change another
// window saved is picked up on the next read — no restart, no reloadSwitches() call.
test('settings: a change saved by another window takes effect without a reload', t => {
  const settings = require('../src/settings');
  const file = config.file();
  t.after(() => { fs.rmSync(file, {force: true}); settings.reloadSwitches(); });
  fs.rmSync(file, {force: true});
  settings.reloadSwitches();
  assert.equal(settings.switchValue('bell'), true, 'default with no file');
  assert.equal(settings.numberValue('dailyTurnLimit'), 0);
  // Another window saves: the file is rewritten directly, this process is never told.
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({bell: false, dailyTurnLimit: 7, lang: 'ja'}));
  assert.equal(settings.switchValue('bell'), false, 'the other window\'s switch landed');
  assert.equal(settings.savedValue('bell'), false);
  assert.equal(settings.numberValue('dailyTurnLimit'), 7, 'and its number');
  fs.writeFileSync(file, JSON.stringify({bell: true, dailyTurnLimit: 0, lang: 'ja', extra: 'padding to change the size'}));
  assert.equal(settings.switchValue('bell'), true, 'and back again');
});

// Audit #224: NO_COLOR disables colour by being PRESENT, even when set empty
// (no-color.org); the code used to require a non-empty value.
test('settings: NO_COLOR set empty still turns colour off', t => {
  const settings = require('../src/settings');
  const was = process.env.NO_COLOR;
  t.after(() => { if (was === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = was; });
  delete process.env.NO_COLOR;
  assert.equal(settings.envOverride('color'), null);
  process.env.NO_COLOR = '';
  assert.equal(settings.envOverride('color'), 'NO_COLOR', 'present but empty counts');
  assert.equal(settings.switchValue('color'), false);
  process.env.NO_COLOR = '1';
  assert.equal(settings.switchValue('color'), false);
});
