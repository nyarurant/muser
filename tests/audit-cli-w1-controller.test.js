'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {EventEmitter} = require('node:events');

// Self-isolation guard, the same pattern as the top of tests/controller.test.js:
// /race resolves stored races under %LOCALAPPDATA%\muser\race and /worklog
// reads %LOCALAPPDATA%\muser\worklog, both resolved from LOCALAPPDATA when the
// src modules load. tests/setup.mjs already points it at a throwaway dir, but
// a bare `node --test tests/audit-cli-w1-controller.test.js` skips setup.mjs,
// so point LOCALAPPDATA and the home folder at throwaway dirs HERE, before
// any src module can load, so this file is safe either way. Isolation is also
// what makes the race ids below genuinely nonexistent and the worklog empty.
const fsTop = require('node:fs');
const pathTop = require('node:path');
process.env.LOCALAPPDATA = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-audit-w1-data-'));
process.env.USERPROFILE = process.env.HOME = fsTop.mkdtempSync(pathTop.join(os.tmpdir(), 'muser-audit-w1-home-'));

const createdTmpDirs = [process.env.LOCALAPPDATA, process.env.HOME];
const origMkdtempSync = fsTop.mkdtempSync.bind(fsTop);
fsTop.mkdtempSync = (...args) => { const dir = origMkdtempSync(...args); createdTmpDirs.push(dir); return dir; };
after(() => { for (const dir of createdTmpDirs) { try { fsTop.rmSync(dir, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

async function makeCtrl() {
  const {Controller} = await import('../src/ui/controller.mjs');
  return new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
}

// Every note the slash command left, as one string per note entry.
function notes(ctrl) {
  return ctrl.get().entries.filter(e => e.type === 'note').map(e => e.lines.join('\n'));
}
const tick = ms => new Promise(r => setTimeout(r, ms));

// audit-cli wave1 (fixed in 3591932): `apply <id> [n]` / `clean <id>` name a
// stored race. parseRaceArgs used to read them as a new task text instead, so
// a mistyped id silently opened the new-race start menu (after the async
// dirty-files check) rather than saying the race does not exist.
test('/race apply <nonexistent id> 1 is a not-found note, not the new-race start menu', async () => {
  const ctrl = await makeCtrl();
  ctrl.slash('/race apply no-such-race-w1 1');
  await tick(200); // the buggy path opened its menu only after dirtyFiles() resolved
  const all = notes(ctrl);
  assert.ok(all.some(n => n.includes('競争が見つかりません') && n.includes('no-such-race-w1')),
    'a not-found note naming the id, got: ' + JSON.stringify(all));
  const found = ctrl.get().entries.find(e => e.type === 'note' && e.lines.join('\n').includes('競争が見つかりません'));
  assert.equal(found.level, 'error');
  assert.ok(!ctrl.get().menu, 'no menu opens: neither the start menu nor a winner/apply menu');
  assert.ok(!all.some(n => n.includes('競争を始めます')), 'the new-race start flow never runs');
  assert.ok(!ctrl.racePending, 'no race is left pending');
});

test('/race clean <nonexistent id> is a not-found note, not the new-race start menu', async () => {
  const ctrl = await makeCtrl();
  ctrl.slash('/race clean no-such-race-w1');
  await tick(200); // as above: give the buggy async start flow its chance to open a menu
  const all = notes(ctrl);
  assert.ok(all.some(n => n.includes('競争が見つかりません') && n.includes('no-such-race-w1')),
    'a not-found note naming the id, got: ' + JSON.stringify(all));
  const found = ctrl.get().entries.find(e => e.type === 'note' && e.lines.join('\n').includes('競争が見つかりません'));
  assert.equal(found.level, 'error');
  assert.ok(!ctrl.get().menu, 'no menu opens');
  assert.ok(!all.some(n => n.includes('競争を始めます')), 'the new-race start flow never runs');
  assert.ok(!all.some(n => n.includes('片付けました')), 'nothing claims to have cleaned up a race that does not exist');
  assert.ok(!ctrl.racePending, 'no race is left pending');
});

// /worklog takes no argument (like /export): an argument used to be silently
// ignored and the log shown anyway, so a typo looked like an empty log.
test('/worklog bogus shows only the usage note and does not display the log', async () => {
  const ctrl = await makeCtrl();
  ctrl.slash('/worklog bogus');
  const all = notes(ctrl);
  assert.deepEqual(all, ['使い方: /worklog（引数はありません）']);
  assert.ok(!all.some(n => n.includes('作業ログはまだありません')), 'the (empty) log is not shown as if there were no argument');
  assert.ok(!all.some(n => n.includes('作業ログ（最新')), 'no log listing is shown');
});

test('/worklog with no argument still displays the log (the empty-log note when empty)', async () => {
  const ctrl = await makeCtrl();
  ctrl.slash('/worklog');
  const all = notes(ctrl);
  assert.deepEqual(all, ['この会話の作業ログはまだありません。']);
  assert.ok(!all.some(n => n.includes('使い方: /worklog')), 'no usage note for the argument-less form');
});
