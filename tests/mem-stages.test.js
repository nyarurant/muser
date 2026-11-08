'use strict';
// Memory reduction stages 1+2 (docs/design/memory.md): history tool rows are slimmed
// (slimToolCall) without changing what renders, and the kept full outputs spill to a
// per-process folder past a total size cap without losing a byte.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');

// Same self-isolation guard as tests/mem-debug.test.js.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mem12-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mem12-home-'));
const tmpDirs = [process.env.LOCALAPPDATA, process.env.HOME];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

const diffLines = (n, plus = 0.6) => Array.from({length: n}, (_, i) => ({t: i % 5 === 4 ? ' ' : (i / n < plus ? '+' : '-'), l: 'line ' + i, n: i + 1}));
async function makeController(opts = {}) {
  const {Controller} = await import('../src/ui/controller.mjs');
  return new Controller({agent: new FakeAgent(process.env.HOME), museName: 'Muse', version: '0', ...opts});
}

test('slimToolCall: params keep heading-sized values only', () => {
  const {slimToolCall} = require('../src/slim-call.js');
  const call = {command: 'code.write', summary: 'a.js', params: {path: 'src/a.js', cwd: 'C:\\x', content: 'x'.repeat(5000), retries: 2, force: true, opts: {a: 1}, tags: ['t'], exact: 'y'.repeat(500), over: 'z'.repeat(501)}};
  const slim = slimToolCall(call);
  assert.deepEqual(slim.params, {path: 'src/a.js', cwd: 'C:\\x', retries: 2, force: true, exact: 'y'.repeat(500)});
  assert.equal(call.params.content.length, 5000); // the original is not mutated
});

test('slimToolCall: a lone diff keeps 30 lines, its omitted count and the + / - totals', () => {
  const {slimToolCall} = require('../src/slim-call.js');
  const diff = diffLines(200);
  const slim = slimToolCall({command: 'code.apply_patch', view: {diff}});
  assert.equal(slim.view.diff.length, 30);
  assert.deepEqual(slim.view.diff, diff.slice(0, 30));
  assert.equal(slim.view.diffOmitted, 170);
  let added = 0, removed = 0; for (const d of diff) { if (d.t === '+') added++; else if (d.t === '-') removed++; }
  assert.equal(slim.view.diffAdded, added);
  assert.equal(slim.view.diffRemoved, removed);
});

test('slimToolCall: file diffs trim the same way; short diffs and other calls pass through', () => {
  const {slimToolCall} = require('../src/slim-call.js');
  const big = diffLines(100), small = diffLines(10);
  const slim = slimToolCall({command: 'code.edit', view: {files: [{path: 'a.js', added: 60, removed: 40, diff: big}, {path: 'b.js', added: 5, removed: 5, diff: small}]}});
  assert.equal(slim.view.files[0].diff.length, 30);
  assert.equal(slim.view.files[0].diffOmitted, 70);
  assert.equal(slim.view.files[0].added, 60); // file headers already carry the totals
  assert.equal(slim.view.files[1].diff, small);
  assert.equal(slimToolCall(null), null);
  const plain = {command: 'code.read', view: {lines: 3}};
  assert.deepEqual(slimToolCall(plain).view, {lines: 3});
});

test('rendering: slimmed history rows render exactly like the full rows', async () => {
  const {slimToolCall} = require('../src/slim-call.js');
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Entry} = await import('../src/ui/view.mjs');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const ctrl = {agent: {cwd: process.env.HOME}};
  const render = call => strip(renderToString(React.createElement(Entry, {e: {type: 'tool', call}, ctrl, W: 100}), {columns: 100}));
  const cases = [
    {command: 'code.write', kind: 'edit', ok: true, summary: 'src/a.js', params: {path: 'src/a.js', content: 'x'.repeat(50000)}, view: {files: [{path: 'src/a.js', added: 96, removed: 64, diff: diffLines(160)}, {path: 'src/b.js', added: 3, removed: 2, diff: diffLines(5)}]}},
    {command: 'code.apply_patch', kind: 'edit', ok: true, summary: 'patch', params: {patch: 'p'.repeat(20000)}, view: {diff: diffLines(200)}},
    {command: 'system.run', kind: 'exec', ok: true, summary: 'npm test', params: {command: 'npm test'}, outputLines: 500, view: {tail: ['one', 'two'], exit: 0}},
    {command: 'system.run', kind: 'exec', ok: true, summary: 'npm run dev', params: {command: 'npm run dev', background: true}, view: {background: 'bg1', tail: ['listening']}},
    {command: 'code.grep', kind: 'read', ok: true, summary: 'needle', params: {pattern: 'needle'}, view: {count: 42}},
    {command: 'code.read', kind: 'read', ok: true, summary: 'a.js', params: {path: 'a.js'}, view: {lines: 123}},
    {command: 'todo.write', kind: 'local', ok: true, summary: '', params: {todos: [{content: 'x', status: 'pending'}]}, view: {todos: [{content: 'do it', status: 'in_progress'}, {content: 'done it', status: 'completed'}]}},
    {command: 'agent.spawn', kind: 'agent', ok: true, summary: 'explore', params: {task: 't'.repeat(3000)}, view: {tag: 'a1', type: 'explore'}},
    {command: 'some.mcp', kind: 'mcp', ok: true, summary: 'mcp', params: {}, view: {text: Array.from({length: 10}, (_, i) => 'row ' + i).join('\n')}},
    {command: 'shell.output', kind: 'exec', ok: true, summary: 'bg1', params: {id: 'bg1'}, view: {background: 'bg1', lines: 77, running: false}},
  ];
  for (const call of cases) assert.equal(render(slimToolCall(call)), render(call), call.command);
});

test('controller: pushed tool rows are stored slimmed; other entries are untouched', async () => {
  const ctrl = await makeController();
  ctrl.push({type: 'tool', call: {command: 'code.write', summary: 'a.js', params: {path: 'a.js', content: 'x'.repeat(10000)}, view: {diff: diffLines(90)}}});
  const stored = ctrl.get().entries.at(-1);
  assert.equal(stored.call.params.content, undefined);
  assert.equal(stored.call.params.path, 'a.js');
  assert.equal(stored.call.view.diff.length, 30);
  assert.equal(stored.call.view.diffOmitted, 60);
  ctrl.push({type: 'note', lines: ['hello']});
  assert.deepEqual(ctrl.get().entries.at(-1).lines, ['hello']);
});

test('outputs: over the total cap the oldest spill to files and read back in full', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-outputs-')); tmpDirs.push(dir);
  const outputsDir = path.join(dir, 'outputs', '4242');
  const ctrl = await makeController({outputsDir, outputsMaxChars: 1000});
  const a = 'A'.repeat(600), b = 'B'.repeat(600), c = 'C'.repeat(600);
  ctrl.keepOutput({id: 'a', command: 'system.run', summary: 'a'}, a);
  ctrl.keepOutput({id: 'b', command: 'system.run', summary: 'b'}, b);
  ctrl.keepOutput({id: 'c', command: 'system.run', summary: 'c'}, c);
  const [oa, ob, oc] = ctrl.outputs;
  assert.equal(oa.text, undefined); assert.ok(oa.file && fs.existsSync(oa.file)); assert.equal(oa.size, 600);
  assert.equal(ob.text, undefined); assert.ok(ob.file && fs.existsSync(ob.file));
  assert.equal(oc.text, c); // the newest stays in memory
  assert.equal(ctrl.outputText(oa), a);
  assert.equal(ctrl.outputText(ob), b);
  assert.equal(ctrl.outputText(oc), c);
  ctrl.showOutput(oa); // a spilled output still opens in full
  ctrl.cleanupOutputs();
  assert.equal(fs.existsSync(outputsDir), false);
});

test('outputs: two controllers sharing one outputs dir never spill onto the same file (master-debug #10)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-outputs-')); tmpDirs.push(dir);
  const outputsDir = path.join(dir, 'shared');
  const c1 = await makeController({outputsDir, outputsMaxChars: 10});
  const c2 = await makeController({outputsDir, outputsMaxChars: 10});
  const realNow = Date.now; Date.now = () => 1700000000000; // same millisecond, same per-instance seq
  try {
    c1.keepOutput({id: 'a', command: 'system.run', summary: ''}, 'A'.repeat(50));
    c2.keepOutput({id: 'b', command: 'system.run', summary: ''}, 'B'.repeat(50));
  } finally { Date.now = realNow; }
  assert.ok(c1.outputs[0].file && c2.outputs[0].file, 'both outputs spilled');
  assert.notEqual(c1.outputs[0].file, c2.outputs[0].file, 'the spill files differ');
  assert.equal(c1.outputText(c1.outputs[0]), 'A'.repeat(50), 'each controller reads back its own text');
  assert.equal(c2.outputText(c2.outputs[0]), 'B'.repeat(50));
});

test('outputs: an entry dropped by the 30-item cap takes its spilled file with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-outputs-')); tmpDirs.push(dir);
  const ctrl = await makeController({outputsDir: path.join(dir, 'o'), outputsMaxChars: 100});
  ctrl.keepOutput({id: 'big', command: 'system.run', summary: ''}, 'X'.repeat(600));
  const file = ctrl.outputs[0].file;
  assert.ok(file && fs.existsSync(file));
  for (let i = 0; i < 30; i++) ctrl.keepOutput({id: 't' + i, command: 'system.run', summary: ''}, 'y');
  assert.equal(ctrl.outputs.length, 30);
  assert.equal(fs.existsSync(file), false);
});

test('cleanupStaleOutputDirs: dead owners are removed, live ones and other names stay', async () => {
  const {cleanupStaleOutputDirs} = await import('../src/ui/controller.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-stale-')); tmpDirs.push(base);
  const dead = spawnSync(process.execPath, ['-e', ''], {encoding: 'utf8'});
  assert.ok(dead.pid && dead.pid !== process.pid);
  fs.mkdirSync(path.join(base, String(dead.pid)), {recursive: true}); fs.writeFileSync(path.join(base, String(dead.pid), 'o.txt'), 'x');
  fs.mkdirSync(path.join(base, String(process.pid)), {recursive: true}); fs.writeFileSync(path.join(base, String(process.pid), 'o.txt'), 'x');
  fs.mkdirSync(path.join(base, 'scratch'), {recursive: true});
  cleanupStaleOutputDirs(base);
  assert.equal(fs.existsSync(path.join(base, String(dead.pid))), false);
  assert.equal(fs.existsSync(path.join(base, String(process.pid), 'o.txt')), true);
  assert.equal(fs.existsSync(path.join(base, 'scratch')), true);
});
