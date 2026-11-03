'use strict';
// Third sweep of 2026-11-01, one test per bug.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {TOOLS} = require('../src/tools');
const BS = String.fromCharCode(92);

function tmp(t, p = 'muser-c-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }
function project(t) {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'src', 'ui'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'view.ts'), 'x\n'); fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'HIT\n');
  return {dir, ctx: {cwd: dir, readFiles: new Set(), todos: []}};
}

test('code.glob takes backslash and absolute patterns', async t => {
  const {dir, ctx} = project(t);
  const files = async pattern => (await TOOLS['code.glob'].run({pattern}, ctx)).payload.files.sort();
  const want = [path.join('src', 'a.ts'), path.join('src', 'ui', 'view.ts')];
  assert.deepEqual(await files('src' + BS + '**' + BS + '*.ts'), want);
  assert.deepEqual(await files(dir.split(BS).join('/') + '/**/*.ts'), want);
});

test("code.grep's glob takes backslashes", async t => {
  const {ctx} = project(t);
  assert.equal((await TOOLS['code.grep'].run({pattern: 'HIT', glob: 'src' + BS + '*.ts'}, ctx)).payload.matches, 1);
});

test('code.glob with path answers paths relative to the working folder', async t => {
  const {ctx} = project(t);
  assert.deepEqual((await TOOLS['code.glob'].run({pattern: '**/*.ts', path: 'src'}, ctx)).payload.files.sort(), [path.join('src', 'a.ts'), path.join('src', 'ui', 'view.ts')]);
});

test('system.run refuses a shell this PC does not have instead of running PowerShell', async t => {
  const {ctx} = project(t);
  await assert.rejects(TOOLS['system.run'].run({command: 'ls', shell: 'bash'}, ctx), /powershell or cmd/);
  const r = await TOOLS['system.run'].run({command: 'echo ok', shell: 'CMD'}, ctx);
  assert.match(r.payload.stdout, /ok/);
});

test('@ in backticks or code blocks is not a file mention', () => {
  const m = require('../src/mentions');
  assert.deepEqual(m.mentions('install `@babel/core` and\n```\nimport x from "@scope/pkg"\n```\nthen read @src/a.js'), ['src/a.js']);
});

test('an unknown short option before the prompt is an error; -v is the version; inside a prompt it is a word', () => {
  const bin = path.join(__dirname, '..', 'bin', 'muser.js');
  const run = (...args) => { try { return execFileSync(process.execPath, [bin, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, env: {...process.env, MUSER_LANG: 'en', MUSER_CLIENT: ''}}); } catch (e) { return String(e.stdout) + String(e.stderr); } };
  assert.match(run('-v'), /^\d+\.\d+\.\d+/);
  assert.match(run('-x'), /Unknown option: -x/);
  assert.doesNotMatch(run('fix', 'the', '-x', 'flag'), /Unknown option/);
});

test('paths in quotes and ~ paths resolve as a shell would take them', t => {
  const dir = tmp(t, 'muser p-'); fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const ctx = {cwd: process.cwd(), readFiles: new Set(), todos: []};
  assert.equal(TOOLS['code.read'].run({path: '"' + path.join(dir, 'a.txt') + '"'}, ctx).payload.total_lines, 1);
  const rel = path.relative(os.homedir(), path.join(dir, 'a.txt')).split(path.sep).join('/');
  assert.equal(TOOLS['code.read'].run({path: '~/' + rel}, ctx).payload.total_lines, 1);
});

test('todo statuses in common spellings are understood', () => {
  const c = {todos: []};
  TOOLS['todo.write'].run({todos: [{content: 'a', status: 'done'}, {content: 'b', status: 'in-progress'}, {content: 'c', status: 'In Progress'}, {content: 'd', status: 'todo'}]}, c);
  assert.deepEqual(c.todos.map(x => x.status), ['completed', 'in_progress', 'in_progress', 'pending']);
});

test('a file read (or sent with @) under one spelling can be edited under another (Windows ignores case)', t => {
  const dir = tmp(t); fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'App.ts'), 'one\n');
  const ctx = {cwd: dir, readFiles: new Set(), todos: []};
  TOOLS['code.read'].run({path: 'SRC/APP.TS'}, ctx);
  TOOLS['code.edit'].run({path: 'src/App.ts', old_string: 'one', new_string: 'two'}, ctx);
  const at = {cwd: dir, readFiles: new Set(), todos: []};
  require('../src/mentions').expand('@SRC/app.ts', dir, at.readFiles);
  TOOLS['code.edit'].run({path: 'src/App.ts', old_string: 'two', new_string: 'three'}, at);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'App.ts'), 'utf8'), 'three\n');
});

async function controller(t, cwd = tmp(t)) {
  const {EventEmitter} = require('node:events');
  const {Controller} = await import('../src/ui/controller.mjs');
  const a = new EventEmitter();
  Object.assign(a, {mode: 'default', cwd, session: {id: 'x', turns: 0}, ctx: {cwd, readFiles: new Set(), todos: []}, client: {status: 'connected'}, allowAlways: new Set(), device: {connected: true}, setMode(m) { this.mode = m; }});
  a.types = () => require('../src/agent-types').load(cwd);
  let spawned = null; a.spawn = (task, o) => { spawned = {task, ...o}; return {tag: 'a1', typeName: o.type, title: task}; };
  const ctrl = new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
  return {ctrl, a, spawned: () => spawned};
}

test('/agent with only a type name shows the usage instead of starting an agent', async t => {
  const {ctrl, spawned} = await controller(t);
  ctrl.slash('/agent explore');
  assert.equal(spawned(), null);
  ctrl.slash('/agent explore where is auth');
  assert.deepEqual([spawned().task, spawned().type], ['where is auth', 'explore']);
});

test('/mode takes any case and common words', async t => {
  const {ctrl, a} = await controller(t);
  for (const [arg, want] of [['Bypass', 'bypass'], ['auto', 'auto-edit'], ['readonly', 'plan'], ['ask', 'default']]) { ctrl.slash('/mode ' + arg); assert.equal(a.mode, want, arg); }
});

test('/resume <number> is a line of the list; an id is looked up in this folder only', async t => {
  const sessions = require('../src/sessions');
  const cwd = tmp(t), other = tmp(t);
  const {ctrl, a} = await controller(t, cwd);
  const shown = []; ctrl.showResumed = s => { shown.push(s && s.id); };
  const real = {recent: sessions.recent};
  t.after(() => { sessions.recent = real.recent; });
  const here = {id: '12aa-here', cwd, turns: 1, updated: 2}, away = {id: '12bb-away', cwd: other, turns: 1, updated: 3};
  sessions.recent = c => [here, away].filter(s => !c || s.cwd === c);
  ctrl.slash('/resume 12');
  assert.deepEqual(shown, [here.id], "the id prefix found this folder's chat, not the other project's");
  shown.length = 0; ctrl.slash('/resume 1');
  assert.deepEqual(shown, [here.id], 'a single digit is a line of the list');
});

test('leaving muser mid-turn cancels every turn of the window on Muse\'s side', async () => {
  const {EventEmitter} = require('node:events');
  const {Agent} = require('../src/agent');
  const cancelled = [];
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1}; client.cancel = async id => { cancelled.push(id); };
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('x'); }}, cwd: process.cwd(), session: {id: 'main-chat', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 0}});
  a.main.turn = {controller: new AbortController()};
  a.runTurn = async w => { w.turn = {controller: new AbortController()}; };
  const mine = a.spawn('user task', {by: 'user'});
  assert.equal(await a.cancelAll(), 2);
  assert.deepEqual(cancelled.sort(), ['main-chat', mine.session.id].sort());
});

test('a patch whose context fits two places is refused unless an @@ line or more context pins it', t => {
  const dir = tmp(t), f = path.join(dir, 'a.js');
  const orig = 'function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n';
  const apply = patch => { fs.writeFileSync(f, orig); const ctx = {cwd: dir, readFiles: new Set(), todos: []}; TOOLS['code.read'].run({path: 'a.js'}, ctx); TOOLS['code.apply_patch'].run({patch}, ctx); return fs.readFileSync(f, 'utf8'); };
  assert.throws(() => apply('*** Begin Patch\n*** Update File: a.js\n-  return 1;\n+  return 2;\n }\n*** End Patch'), /fits more than one place/);
  assert.equal(fs.readFileSync(f, 'utf8'), orig, 'nothing was changed');
  assert.match(apply('*** Begin Patch\n*** Update File: a.js\n@@ function second() {\n-  return 1;\n+  return 2;\n }\n*** End Patch'), /second\(\) \{\n  return 2;/);
});

test("a turn reports how much it sent, so /usage can count what went to Muse", async () => {
  const {EventEmitter} = require('node:events');
  const {Agent} = require('../src/agent');
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1};
  client.history = async () => ({chat_events: []}); client.request = async () => ({session: {status: 'running'}});
  client.subscribeAgent = async () => {}; client.closeAgentSubscription = () => {}; client.cancel = async () => {};
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-sent-'));
  const a = new Agent({client, auth: {saved: {}, vm: async () => ({})}, cwd, session: {id: 's1', cwd, title: '', created: 0, updated: 0, turns: 0}});
  a.subscribed = true; a.ensureConnected = async () => {};
  a.device = {connected: true, send: async () => ({message_id: 'm1'})};
  const sent = new Promise(r => a.once('sent', r));
  const turn = a.send('hello there').catch(() => {});
  const e = await sent;
  assert.ok(e.chars > 'hello there'.length, 'the first turn carries the preamble too: ' + e.chars);
  await a.interrupt(); await turn;
  fs.rmSync(cwd, {recursive: true, force: true});
});

test('the demo does not ask muse.ai for the real plan', async () => {
  const {EventEmitter} = require('node:events');
  const usage = require('../src/usage');
  const saved = usage.plan; let asked = 0; usage.plan = async () => { asked++; return {percentUsed: 13}; };
  try {
    const {Controller} = await import('../src/ui/controller.mjs');
    const a = new EventEmitter();
    Object.assign(a, {mode: 'default', cwd: process.cwd(), session: {id: 'x', turns: 0}, ctx: {cwd: process.cwd(), readFiles: new Set(), todos: []}, client: {status: 'demo'}, allowAlways: new Set(), device: {connected: true}});
    const ctrl = new Controller({agent: a, museName: 'm', version: 't', onExit() {}});
    assert.equal(await ctrl.refreshPlan(), null);
    a.emit('turn-end', {ok: true, ms: 1});
    await new Promise(r => setTimeout(r, 10));
    assert.equal(asked, 0);
  } finally { usage.plan = saved; }
});

test('code.read says which lines it cut and how to read them whole', t => {
  const dir = tmp(t); fs.writeFileSync(path.join(dir, 'min.js'), 'short\n' + 'x'.repeat(5000) + '\nshort\n');
  const p = TOOLS['code.read'].run({path: 'min.js'}, {cwd: dir, readFiles: new Set(), todos: []}).payload;
  assert.deepEqual(p.long_lines, [2]);
  assert.match(p.note, /longer than 2000 characters are cut/);
  const plain = TOOLS['code.read'].run({path: 'min.js', offset: 3}, {cwd: dir, readFiles: new Set(), todos: []}).payload;
  assert.equal(plain.long_lines, undefined, 'no note when nothing in the range was cut');
});

test("agent.wait says when an agent's report was cut", async () => {
  const {EventEmitter} = require('node:events');
  const {Agent} = require('../src/agent');
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1};
  const a = new Agent({client, auth: {saved: {}, vm: async () => ({})}, cwd: process.cwd(), session: {id: 'm', cwd: process.cwd(), title: '', created: 0, updated: 0, turns: 0}});
  a.main.turn = {controller: new AbortController(), toolCalls: 0, log: {tools: [], steps: []}, calls: []};
  a.runTurn = async w => { w.state = 'done'; w.result = 'R'.repeat(9000); };
  const w = a.spawn('long report', {by: 'muse'});
  const r = await a.execute('agent.wait', {tags: w.tag, timeout_s: 1}, 5000, 'w');
  const got = r.payload.agents[0];
  assert.equal(got.result_truncated, true);
  assert.match(got.result, /cut: 1000 more characters of 9000/);
});

test('@folder gives the whole file count and says the list is cut', t => {
  const dir = tmp(t); fs.mkdirSync(path.join(dir, 'many'));
  for (let i = 0; i < 350; i++) fs.writeFileSync(path.join(dir, 'many', 'f' + i + '.txt'), '');
  const ex = require('../src/mentions').expand('@many', dir, new Set());
  assert.match(ex.block, /Folder many \(350 files; the first 300 listed, use code\.glob for the rest\)/);
  assert.equal(ex.files[0].count, 350);
});

test('/agent and /skill keep a multi-line task as typed', async t => {
  const {ctrl, spawned} = await controller(t);
  const task = 'fix these:' + String.fromCharCode(10) + '  - a()' + String.fromCharCode(10) + '  - b()';
  ctrl.slash('/agent review ' + task);
  assert.deepEqual([spawned().task, spawned().type], [task, 'review']);
  ctrl.slash('/agent ' + task);
  assert.deepEqual([spawned().task, spawned().type], [task, 'general']);
  ctrl.slash('/mode  bypass');
  assert.equal(ctrl.agent.mode, 'bypass', 'extra spaces still work');
});

test('/image ~/… is the home folder, not a folder named ~', async t => {
  const {ctrl} = await controller(t);
  const os = require('node:os');
  const home = tmp(t), was = process.env.USERPROFILE; process.env.USERPROFILE = home; t.after(() => { process.env.USERPROFILE = was; });
  assert.equal(os.homedir(), home);
  const name = 'shot.png';
  fs.writeFileSync(path.join(home, name), Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
  ctrl.slash('/image ~/' + name);
  assert.deepEqual(ctrl.s.attachments.map(x => x.name), [name]);
});

test('Markdown inside `code` stays literal; bold around code still works', async () => {
  const {inline} = await import('../src/ui/md.mjs');
  const {strip} = require('../src/tui/term.js');
  const show = s => strip(inline(s));
  assert.equal(show('edit `__init__.py` now'), 'edit __init__.py now');
  assert.equal(show('run `ls *.js *.md`'), 'run ls *.js *.md');
  assert.equal(show('call `f(**kw)` and `g(**kw)`'), 'call f(**kw) and g(**kw)');
  assert.equal(show('**Run `npm test`** first'), 'Run npm test first');
});

test('a progress meter redrawn with carriage returns shows its latest frame, live and after', async t => {
  const {ctrl, a} = await controller(t);
  const CR = String.fromCharCode(13), NL = String.fromCharCode(10);
  a.emit('tool-start', {id: 'c1', command: 'system.run', summary: 'curl'});
  a.emit('tool-output', {id: 'c1', chunk: '  0%' + CR + ' 40%'});
  assert.equal(ctrl.s.running.now, ' 40%', 'the line being redrawn is on screen');
  a.emit('tool-output', {id: 'c1', chunk: CR + '100%' + CR + NL + 'done' + CR + NL});
  assert.deepEqual(ctrl.s.running.tail, ['100%', 'done']);
  a.emit('tool-end', {id: 'c1', command: 'system.run', summary: 'curl', ok: true, output: '  0%' + CR + '100%' + CR + NL + 'done'});
  assert.equal(ctrl.outputs.at(-1).text, '100%' + NL + 'done');
  const {frames} = require('../src/tui/term');
  assert.equal(frames('a' + CR + NL + 'b' + CR), 'a' + NL + 'b', 'a CR before a line end changes nothing');
});

test('--mode takes --mode=value and the same spellings as /mode', () => {
  const {modeFrom} = require('../src/policy');
  assert.deepEqual(['Bypass', 'auto', 'read-only', 'ask', 'plan', 'nope'].map(modeFrom), ['bypass', 'auto-edit', 'plan', 'default', 'plan', null]);
  const {spawnSync} = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'muser.js'), '--mode=nope', 'hi'], {encoding: 'utf8', timeout: 30000, env: {...process.env, MUSER_LANG: 'en', MUSER_CLIENT: ''}});
  assert.match(r.stderr + r.stdout, /--mode must be one of/, 'read as --mode nope, not as an unknown option');
});

test('a broken permissions.json is moved aside, not overwritten with one folder', t => {
  const dir = tmp(t), f = path.join(dir, 'permissions.json');
  const was = process.env.MUSER_PERMISSIONS_FILE; process.env.MUSER_PERMISSIONS_FILE = f; t.after(() => { process.env.MUSER_PERMISSIONS_FILE = was; });
  const broken = '{"version":1,"folders":{"c:\\a":{"mode":"bypass","allow":["edit"]},}}';
  fs.writeFileSync(f, broken);
  const permissions = require('../src/permissions');
  permissions.saveMode(path.join(dir, 'b'), 'plan');
  const aside = fs.readdirSync(dir).filter(n => n.startsWith('permissions.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), broken, 'the original bytes are kept');
  assert.equal(permissions.load(path.join(dir, 'b')).mode, 'plan');
});

test('a long !command output reaches Muse with its end and stderr, and says where it was cut', async t => {
  const {ctrl} = await controller(t);
  const settings = require('../src/settings'); settings.setSwitch('bangAutoSend', false, {save: false}); t.after(() => settings.reloadSwitches());
  // 30,000 lines of stdout, then an error on stderr.
  await ctrl.bang('1..3000 | % { "line $_ of the build output" }; [Console]::Error.WriteLine("ERROR at the end")');
  const note = ctrl.bangNotes.at(-1);
  assert.match(note, /ERROR at the end/);
  assert.match(note, /line 3000 of the build output/);
  assert.match(note, /characters cut here/);
  assert.ok(note.length < 21000, 'still about 20,000 characters: ' + note.length);
});

test('a !command\'s whole output can be read with /output', async t => {
  const {ctrl} = await controller(t);
  const settings = require('../src/settings'); settings.setSwitch('bangAutoSend', false, {save: false}); t.after(() => settings.reloadSwitches());
  await ctrl.bang('1..40 | % { "row $_" }');
  const kept = ctrl.outputs.at(-1);
  assert.equal(kept.text.split('\n').length, 40);
  assert.equal(ctrl.s.entries.at(-1).call.outputLines, 40, 'the "… N more (/output)" hint has the count');
});

test('a !command during a turn keeps its own row; Muse\'s running call keeps its row', async t => {
  const {ctrl, a} = await controller(t);
  const done = ctrl.bang('Start-Sleep -Milliseconds 1500; "bang done"');
  await new Promise(r => setTimeout(r, 100));
  a.emit('tool-start', {id: 'c1', command: 'code.grep', summary: 'TODO'});
  assert.equal(ctrl.s.bangRunning.call.user, true, 'the user\'s command is still on screen');
  await done;
  assert.equal(ctrl.s.running?.call.id, 'c1', 'Muse\'s call is still shown as running');
  assert.equal(ctrl.s.bangRunning, null);
});

test('esc stops a running !command', async t => {
  const {ctrl} = await controller(t);
  const t0 = Date.now(), done = ctrl.bang('Start-Sleep -Seconds 30');
  await new Promise(r => setTimeout(r, 300));
  ctrl.key('', {escape: true});
  await done;
  assert.ok(Date.now() - t0 < 10000, 'stopped, not waited out: ' + (Date.now() - t0) + ' ms');
  assert.equal(ctrl.s.bangRunning, null);
});

test('a "! command" pasted with the indent it had on screen still runs in the shell', async t => {
  const {ctrl} = await controller(t);
  const ran = []; ctrl.bang = async cmd => { ran.push(cmd); };
  await ctrl.submit('    ! git status');
  assert.deepEqual(ran, ['git status']);
  const {preamble} = require('../src/agent');
  assert.match(preamble(tmp(t), []), /prefixed with "!"/, 'Muse is told to hand such commands over as "! …"');
});

test('a finished !command goes to Muse on its own, as in Claude Code; during a turn, when the turn ends', async t => {
  const {ctrl, a} = await controller(t);
  const settings = require('../src/settings'); settings.reloadSwitches(); t.after(() => settings.reloadSwitches());
  const sent = []; a.send = async (body, opts) => { sent.push({body, display: opts.display}); };
  await ctrl.bang('"hello from the shell"');
  assert.equal(sent.length, 1, 'sent without the user typing anything');
  assert.match(sent[0].body, /The user ran this in the terminal: "hello from the shell"/);
  assert.match(sent[0].body, /hello from the shell/);
  assert.equal(sent[0].display, '! "hello from the shell"');
  assert.equal(ctrl.s.entries.filter(e => e.type === 'user').length, 0, 'no extra message bubble');
  assert.equal(ctrl.s.busy, true, 'Muse is answering');

  // During a turn: held until the turn ends, then sent.
  await ctrl.bang('"second"');
  assert.equal(sent.length, 1);
  a.emit('turn-end', {ok: true, text: 'ok'});
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /second/);

  // A turn stopped with esc: the output waits for the next message instead.
  await ctrl.bang('"third"');
  a.emit('turn-end', {ok: false, aborted: true});
  assert.equal(sent.length, 2);
  assert.equal(ctrl.bangNotes.length, 1);

  // Off in /settings: kept for the next message, as before.
  settings.setSwitch('bangAutoSend', false, {save: false});
  ctrl.bangNotes = [];
  await ctrl.bang('"fourth"');
  assert.equal(sent.length, 2);
  assert.equal(ctrl.bangNotes.length, 1);
});

test('the spinner word comes from muser\'s own list, changes between turns and holds within one', async () => {
  const {THINKING_WORDS, WRITING_WORDS, spinnerWord} = await import('../src/ui/view.mjs');
  const seen = new Set();
  for (let start = 1730000000000; start < 1730000000000 + 50; start++) {
    const w = spinnerWord(THINKING_WORDS, start);
    assert.ok(THINKING_WORDS.includes(w.slice(0, -1)), w);
    assert.equal(spinnerWord(THINKING_WORDS, start), w, 'the same turn keeps its word');
    seen.add(w);
  }
  assert.equal(seen.size, THINKING_WORDS.length, 'every word turns up over consecutive turns');
  assert.ok(WRITING_WORDS.includes(spinnerWord(WRITING_WORDS, 7).slice(0, -1)));
  assert.equal(spinnerWord(THINKING_WORDS, undefined), THINKING_WORDS[0] + '…', 'no start time: still a word');
});
