'use strict';
// Second sweep of 2026-11-01, one test each.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {TOOLS, copyReads} = require('../src/tools');

function tmp(t, p = 'muser-b-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

// t5 #6/#7 (deep audit): poll for a condition instead of sleeping a fixed
// span (a loaded Windows box misses a 20 ms window on correct code), and
// never await a promise that only the mechanism under test can settle
// without a deadline (a regression there hung the whole suite silently).
async function waitFor(pred, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 10));
  }
}
function withTimeout(promise, what, ms = 10000) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for ' + what)), ms))]);
}

test("a parallel agent's code.write refuses a file changed on disk since main read it", t => {
  const dir = tmp(t), f = path.join(dir, 'a.txt'); fs.writeFileSync(f, 'one\n');
  const main = {cwd: dir, readFiles: new Set(), todos: []};
  TOOLS['code.read'].run({path: 'a.txt'}, main);
  const agent = {cwd: dir, readFiles: new Set(), todos: []}; copyReads(main, agent);
  fs.writeFileSync(f, 'one\nchanged outside\n');
  assert.throws(() => TOOLS['code.write'].run({path: 'a.txt', content: 'x\n'}, agent), /changed on disk/);
  assert.match(fs.readFileSync(f, 'utf8'), /changed outside/);
});

test('a file sent with @ counts as read with its content, so a later overwrite notices a change', t => {
  const dir = tmp(t), f = path.join(dir, 'a.txt'); fs.writeFileSync(f, 'one\n');
  const ctx = {cwd: dir, readFiles: new Set(), todos: []};
  require('../src/mentions').expand('@a.txt', dir, ctx.readFiles);
  fs.writeFileSync(f, 'one\nchanged outside\n');
  assert.throws(() => TOOLS['code.write'].run({path: 'a.txt', content: 'x\n'}, ctx), /changed on disk/);
});

test('code.grep with context counts hits, not the lines around them', async t => {
  const dir = tmp(t); fs.writeFileSync(path.join(dir, 'a.txt'), 'x\nkey: v\nHIT\nx\nx\nx\nx\nx\nHIT\nx\n');
  const ctx = {cwd: dir, readFiles: new Set(), todos: []};
  for (const p of [{pattern: 'HIT', context: 2}, {pattern: 'HIT', context: 2, path: 'a.txt'}, {pattern: 'HIT'}])
    assert.equal((await TOOLS['code.grep'].run(p, ctx)).payload.matches, 2, JSON.stringify(p));
});

test('images over the per-message total are refused when attached, with the reason', async t => {
  const dir = tmp(t);
  const {Controller} = await import('../src/ui/controller.mjs');
  const a = new EventEmitter();
  Object.assign(a, {mode: 'default', cwd: dir, session: {id: 'x', turns: 0}, ctx: {readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  const ctrl = new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
  for (const n of ['a.png', 'b.png']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(6 * 1024 * 1024, 1));
  ctrl.attach(path.join(dir, 'a.png'));
  ctrl.attach(path.join(dir, 'b.png'));
  assert.equal(ctrl.get().attachments.length, 1, 'the second would make 12 MB');
  assert.match(ctrl.get().flash, /合計 11 MB まで/);
});

test('a session index with broken entries still lists the good ones', t => {
  const dir = tmp(t);
  const {execFileSync} = require('node:child_process');
  fs.mkdirSync(path.join(dir, 'muser'));
  fs.writeFileSync(path.join(dir, 'muser', 'sessions.json'), JSON.stringify([null, {id: 'x'}, {id: 'abc-1', cwd: 'C:/p', turns: 1, updated: 1}]));
  const out = execFileSync(process.execPath, ['-e', "const s=require('./src/sessions');console.log(s.recent().length, s.recent('C:/p').length)"], {cwd: path.join(__dirname, '..'), env: {...process.env, LOCALAPPDATA: dir}, encoding: 'utf8', timeout: 30000});
  assert.equal(out.trim(), '2 1');
});

test('a UTF-16 file (PowerShell `>`) is read as text and stays UTF-16 when edited', t => {
  const dir = tmp(t), f = path.join(dir, 'out.txt');
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('こんにちは\r\nsecond\r\n', 'utf16le')]));
  const ctx = {cwd: dir, readFiles: new Set(), todos: []};
  assert.match(TOOLS['code.read'].run({path: 'out.txt'}, ctx).payload.content, /こんにちは/);
  TOOLS['code.edit'].run({path: 'out.txt', old_string: 'second', new_string: '2行目'}, ctx);
  const b = fs.readFileSync(f);
  assert.deepEqual([...b.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(b.subarray(2).toString('utf16le'), 'こんにちは\r\n2行目\r\n');
});

// t5 #5 (deep audit): this used to assert two regexes over the source text —
// a refactor to another unique-temp scheme failed it innocently, and the
// shared ".tmp" could have returned inside a comment while it stayed green.
// Exercise the claim instead: two PROCESSES saving the same file at the same
// time both succeed, the survivor is one writer's whole value, and no temp
// file is left behind.
test('secure-store writes through a temp file of its own (no shared ".tmp")', async t => {
  const dir = tmp(t);
  const {spawn} = require('node:child_process');
  const script = "const ss=require('./src/secure-store');const who=Number(process.argv[1]);for(let i=0;i<6;i++)ss.save('race-b.enc',{who,i});";
  const run = who => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script, String(who)], {cwd: path.join(__dirname, '..'), env: {...process.env, LOCALAPPDATA: dir}, stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', c => c === 0 ? resolve() : reject(new Error('saver ' + who + ' exit ' + c + ': ' + err)));
  });
  await Promise.all([run(0), run(1)]);
  const storeDir = path.join(dir, 'muser');
  assert.deepEqual(fs.readdirSync(storeDir).filter(n => n.includes('.tmp')), [], 'no temp file is left behind by either saver');
  const {execFileSync} = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "const ss=require('./src/secure-store');console.log(JSON.stringify(ss.load('race-b.enc')))"], {cwd: path.join(__dirname, '..'), env: {...process.env, LOCALAPPDATA: dir}, encoding: 'utf8', timeout: 30000});
  const v = JSON.parse(out.trim());
  assert.ok(v.who === 0 || v.who === 1, 'the surviving value is one whole writer value, not a mix: ' + out);
  assert.ok(Number.isInteger(v.i) && v.i >= 0 && v.i < 6, 'and one of its actual saves');
});

test('a UTF-16 file sent with @ goes as text, not "binary"', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'log.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('エラー: 42\r\n', 'utf16le')]));
  const ex = require('../src/mentions').expand('@log.txt', dir, new Set());
  assert.equal(ex.files[0].kind, 'file');
  assert.match(ex.block, /エラー: 42/);
});

test('code.read counts lines as an editor does: the final newline does not add an empty line', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'a\nb'); fs.writeFileSync(path.join(dir, 'e.txt'), '');
  const read = f => TOOLS['code.read'].run({path: f}, {cwd: dir, readFiles: new Set(), todos: []}).payload;
  assert.equal(read('a.txt').total_lines, 2);
  assert.ok(!/\n\s+3\t/.test(read('a.txt').content));
  assert.equal(read('b.txt').total_lines, 2);
  assert.equal(read('e.txt').total_lines, 0);
});

test('a remembered command is allowed only when it runs inside the working folder', () => {
  const {decide} = require('../src/policy');
  const always = new Set(['exec:npm test']), root = path.resolve('C:/work/proj');
  const d = cwd => decide({mode: 'default', kind: 'exec', params: {command: 'npm test'}, always, root, cwd: path.resolve(cwd), gitConfig: () => ''});
  assert.equal(d('C:/work/proj'), 'allow');
  assert.equal(d('C:/work/proj/sub'), 'allow');
  assert.equal(d('C:/other/project'), 'ask', "another project's test script");
  assert.equal(d('D:/x'), 'ask');
});

async function ctrlWith(t) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const a = new EventEmitter();
  const cwd = tmp(t);
  Object.assign(a, {mode: 'default', cwd, session: {id: 'x', turns: 0}, ctx: {cwd, readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}});
  return new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
}

// Muse gives up on a call after its timeout; approving later still ran the change, unseen by Muse.
test('an approval still open when Muse stops waiting closes itself and nothing runs', async t => {
  const ctrl = await ctrlWith(t);
  const answer = ctrl.ask({command: 'system.run', kind: 'exec', params: {command: 'npm test'}, summary: 'npm test', deadline: Date.now() + 150});
  assert.ok(ctrl.get().approval);
  const r = await withTimeout(answer, 'the deadline to expire the approval');
  assert.equal(r.expired, true);
  assert.equal(ctrl.get().approval, null);
  assert.match(ctrl.get().entries.at(-1).lines.join(' '), /行いませんでした/);
});

test('the agent does nothing for an approval that comes after the deadline', async () => {
  const {Agent} = require('../src/agent');
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-late-'));
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('x'); }}, cwd: dir, session: {id: 's', cwd: dir, title: '', created: 0, updated: 0, turns: 0}});
  a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  a.approver = async call => { assert.ok(call.deadline > Date.now() + 29000, 'deadline = timeout + the link watchdog'); call.deadline = Date.now() - 1; return {allow: true}; }; // answered after it
  const r = await a.execute('code.write', {path: 'late.txt', content: 'x'}, 50, 'id1');
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped waiting/);
  assert.equal(fs.existsSync(path.join(dir, 'late.txt')), false);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('declining with a reason gives the half-written input back afterwards', async t => {
  const ctrl = await ctrlWith(t);
  ctrl.setText('my draft', 8);
  const answer = ctrl.ask({command: 'system.run', kind: 'exec', params: {command: 'npm test'}, summary: 'npm test'});
  ctrl.answer(ctrl.get().approval.options.length - 1); // "no (tell Muse why)"
  assert.equal(ctrl.get().text, '');
  ctrl.submitReason('not now');
  assert.deepEqual(await answer, {allow: false, reason: 'not now'});
  assert.equal(ctrl.get().text, 'my draft');
});

test('a change waiting for approval does not run once its task was stopped; the approval closes', async t => {
  const {Agent} = require('../src/agent');
  const dir = tmp(t);
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1}; client.cancel = async () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('x'); }}, cwd: dir, session: {id: 's', cwd: dir, title: '', created: 0, updated: 0, turns: 0}});
  const turn = a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  const ctrl = await ctrlWith(t);
  a.approver = call => ctrl.ask(call);
  const p = a.execute('code.write', {path: 'after-stop.txt', content: 'x'}, 30000, 'i1');
  await waitFor(() => ctrl.get().approval, 'the approval to be asked');
  assert.ok(ctrl.get().approval, 'asked');
  turn.controller.abort(); a.main.turn = null; // esc
  const r = await withTimeout(p, 'the stopped execute() to settle');
  assert.equal(r.ok, false);
  assert.equal(ctrl.get().approval, null, 'the approval went away');
  assert.equal(fs.existsSync(path.join(dir, 'after-stop.txt')), false);
});

test("a parallel agent's command output does not show under main's running command", async t => {
  const ctrl = await ctrlWith(t), a = ctrl.agent;
  a.emit('tool-start', {id: 'main-1', agent: 'main', command: 'system.run', params: {command: 'npm test'}, kind: 'exec', summary: 'npm test'});
  a.emit('tool-output', {id: 'main-1', agent: 'main', chunk: 'main line\n'});
  a.emit('tool-output', {id: 'agent-7', agent: 'a1', chunk: 'agent line\n'});
  assert.deepEqual(ctrl.get().running.tail, ['main line']);
});

test("/new drops !command output meant for the old chat's next message", async t => {
  const ctrl = await ctrlWith(t);
  ctrl.bangNotes = ['[The user ran this in the terminal: git log]'];
  ctrl.slash('/new');
  assert.deepEqual(ctrl.bangNotes, []);
});

test('one esc does not wipe a draft; a second one does', async t => {
  const ctrl = await ctrlWith(t);
  ctrl.setText('a long request', 14);
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().text, 'a long request');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().text, '');
});
