'use strict';
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');

// Same self-isolation guard as tests/controller.test.js: src modules resolve the
// data folder from LOCALAPPDATA / the home folder, so point both at throwaway
// dirs BEFORE anything loads, keeping this file safe under a bare `node --test`.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mem-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mem-home-'));
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

test('summarizeEntries groups JSON size by entry type, biggest first, and survives circular data', async () => {
  const {summarizeEntries} = await import('../src/ui/mem-report.mjs');
  const circular = {type: 'note', lines: ['x']}; circular.self = circular;
  const r = summarizeEntries([
    {type: 'tool', call: {command: 'code.write', params: {content: 'a'.repeat(1000)}}},
    {type: 'tool', call: {command: 'code.read'}},
    {type: 'note', lines: ['hi']},
    circular,
    {lines: []},
  ]);
  assert.equal(r.count, 5);
  assert.equal(r.byType[0].type, 'tool');
  assert.equal(r.byType[0].count, 2);
  assert.ok(r.byType[0].chars > 1000);
  assert.equal(r.byType.find(x => x.type === 'note').count, 2, 'the circular entry is measured, not crashed on');
  assert.equal(r.byType.find(x => x.type === '(none)').count, 1);
  assert.equal(r.chars, r.byType.reduce((a, x) => a + x.chars, 0));
});

test('summarizeOutputs counts entries, total chars and the largest single output', async () => {
  const {summarizeOutputs} = await import('../src/ui/mem-report.mjs');
  assert.deepEqual(summarizeOutputs([{text: 'abc'}, {text: 'de'}, {}, {text: ''}]), {count: 4, chars: 5, max: 3});
  assert.deepEqual(summarizeOutputs([]), {count: 0, chars: 0, max: 0});
});

test('memReportLines shows memoryUsage, entries by type and outputs', async () => {
  const {memReportLines} = await import('../src/ui/mem-report.mjs');
  const mem = {rss: 100 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, heapUsed: 25 * 1024 * 1024, external: 1024 * 1024, arrayBuffers: 0};
  const text = memReportLines({entries: [{type: 'banner'}, {type: 'tool', call: {params: {content: 'x'.repeat(100)}}}], outputs: [{text: 'y'.repeat(42)}], mem}).join('\n');
  assert.match(text, /rss 100\.0 MB {2}heapTotal 50\.0 MB {2}heapUsed 25\.0 MB/);
  assert.match(text, /entries: 2, ~\d+ chars/);
  assert.match(text, /tool: 1, ~\d+ chars/);
  assert.match(text, /outputs: 1, 42 chars total, largest 42 chars/);
});

test('heapSnapshotPath lives in the temp folder and names the pid', async () => {
  const {heapSnapshotPath} = await import('../src/ui/mem-report.mjs');
  const p = heapSnapshotPath(path.join('some', 'tmp'), 4242);
  assert.equal(p, path.join('some', 'tmp', 'muser-heap-4242.heapsnapshot'));
  assert.equal(path.dirname(heapSnapshotPath()), os.tmpdir(), 'default: %TEMP%, never the config folder');
});

test('/debug advertises log, mem and heap; /debug mem notes the breakdown; a bad subcommand shows usage', async () => {
  const {Controller, COMMANDS} = await import('../src/ui/controller.mjs');
  // Wave 6 spec change: /debug mem and /debug heap ARE advertised now — they
  // were hidden slash commands, and the COMMANDS entry names them (the old
  // pin asserted they stay unadvertised).
  const listed = COMMANDS.find(([n]) => n === '/debug');
  assert.ok(listed && listed[1].includes('/debug mem') && listed[1].includes('/debug heap'), '/debug mem and /debug heap are advertised in /help and completion');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.push({type: 'tool', call: {command: 'code.write', params: {content: 'z'.repeat(500)}}});
  ctrl.outputs.push({id: '1', at: Date.now(), command: 'system.run', summary: '', text: 'q'.repeat(123)});
  ctrl.slash('/debug mem');
  const note = ctrl.get().entries.at(-1);
  assert.equal(note.type, 'note');
  const text = note.lines.join('\n');
  assert.match(text, /memory \(process\.memoryUsage\):/);
  assert.match(text, /heapUsed \d+\.\d MB/);
  assert.match(text, /tool: 1, ~\d+ chars/);
  assert.match(text, /outputs: 1, 123 chars total, largest 123 chars/);
  ctrl.slash('/debug nope');
  assert.match(ctrl.get().entries.at(-1).lines.join('\n'), /\/debug mem/);
});

test('/debug heap writes a real snapshot into the temp folder and notes where', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const ctrl = new Controller({agent: new FakeAgent(process.cwd()), museName: 'm', version: 't', onExit() {}});
  ctrl.slash('/debug heap');
  const text = ctrl.get().entries.at(-1).lines.join('\n');
  const m = /muser-heap-(\d+)\.heapsnapshot/.exec(text);
  assert.ok(m, 'the note names the snapshot file: ' + text);
  assert.equal(Number(m[1]), process.pid);
  const file = path.join(os.tmpdir(), m[0]);
  assert.ok(fs.statSync(file).size > 100000, 'a real heap snapshot, not an empty file');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('{"snapshot"'), 'the V8 snapshot format heap-summary parses');
  fs.unlinkSync(file);
});

test('memScenario drives 200 tool calls through a Controller: 50 of each heavy shape', async () => {
  const {Controller} = await import('../src/ui/controller.mjs');
  const {DemoAgent} = await import('../src/ui/demo.mjs');
  const {summarizeEntries, summarizeOutputs} = await import('../src/ui/mem-report.mjs');
  const agent = new DemoAgent(process.cwd());
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  await agent.memScenario();
  const tools = ctrl.get().entries.filter(e => e.type === 'tool');
  assert.equal(tools.length, 200);
  const byCmd = {};
  for (const e of tools) byCmd[e.call.command] = (byCmd[e.call.command] || 0) + 1;
  assert.deepEqual(byCmd, {'code.write': 50, 'code.edit': 50, 'system.run': 50, 'code.read': 50});
  const write = tools.find(e => e.call.command === 'code.write');
  assert.equal(write.call.params.content, undefined, 'stage 1: a 50 KB file body no longer stays in the entry');
  const edit = tools.find(e => e.call.command === 'code.edit');
  assert.equal(edit.call.view.diff.length, 30, 'stage 1: a 2,000-line diff is kept to the displayed lines');
  assert.equal(edit.call.view.diffOmitted, 1970);
  const out = summarizeOutputs(ctrl.outputs);
  assert.equal(out.count, 30, 'the outputs cap');
  assert.equal(out.max, 99999, 'a 5,000-line run output is kept whole');
  assert.ok(summarizeEntries(ctrl.get().entries).chars < 1000000, 'stage 1: the retained entries are a fraction of the pre-stage-1 tens of MB of JSON');
  agent.close();
});

// A synthetic snapshot with a diamond (shared node reached from entries, left and
// right): the shared subtree must be retained by the ROOT, not by entries — that
// is what makes the dominator math (not a plain subtree sum) necessary.
function syntheticSnapshot() {
  const strings = ['(GC roots)', 'Object', 'Array', 'big-y', 'big-x', 'left', 'shared', 'big-z', 'right',
    's', 'outputs', 'entries', 'sharedRef', 'data', 'holder'];
  const S = Object.fromEntries(strings.map((s, i) => [s, i]));
  // node fields: type, name, id, self_size, edge_count, trace_node_id
  // types: 0 hidden, 1 object, 2 array, 3 string, 9 synthetic
  const N = (type, name, self, edges) => ({type, name, self, edges});
  const E = (type, name, to) => ({type, name, to});
  // edge types: 0 context, 1 element, 2 property, 3 internal, 4 hidden, 5 weak
  const list = [
    N(9, S['(GC roots)'], 0, [E(2, S.s, 1), E(2, S.outputs, 2), E(2, S.left, 6), E(2, S.right, 9)]),
    N(1, S.holder, 16, [E(2, S.entries, 3)]),
    N(2, S.Array, 24, [E(1, 0, 4)]),
    N(2, S.Array, 24, [E(1, 0, 5), E(1, 1, 7)]),
    N(3, S['big-y'], 5000, []),
    N(3, S['big-x'], 9000, []),
    N(1, S.left, 8, [E(2, S.sharedRef, 7)]),
    N(1, S.shared, 100, [E(2, S.data, 8)]),
    N(3, S['big-z'], 700, []),
    N(1, S.right, 8, [E(2, S.sharedRef, 7)]),
  ];
  const nodes = [], edges = [];
  list.forEach((n, i) => {
    nodes.push(n.type, n.name, i + 1, n.self, n.edges.length, 0);
    for (const e of n.edges) edges.push(e.type, e.name, e.to * 6);
  });
  return {
    snapshot: {node_count: list.length, edge_count: edges.length / 3, meta: {
      node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id'],
      node_types: [['hidden', 'object', 'array', 'string', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic'], 'string', 'number', 'number', 'number', 'number'],
      edge_fields: ['type', 'name_or_index', 'to_node'],
      edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'weak'], 'string_or_number', 'node'],
      location_fields: ['object', 'line', 'column', 'script_id'],
    }},
    nodes, edges, strings, locations: [],
  };
}

test('heap-summary reports retained sizes by type and by entries/outputs retainer (shared nodes stay with the root)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-heapsum-')); tmpDirs.push(dir);
  const file = path.join(dir, 'synthetic.heapsnapshot');
  fs.writeFileSync(file, JSON.stringify(syntheticSnapshot()));
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'heap-summary.mjs'), file, '--top', '10'], {encoding: 'utf8', timeout: 60000});
  assert.match(out, /total self size: 14\.53 KB/);
  assert.match(out, /entries: 8\.81 KB retained/, 'the entries array + its exclusive string; the shared node is NOT inside');
  assert.match(out, /outputs: 4\.91 KB retained/);
  assert.match(out, /other: 832 B/);
  // Strings aggregate by content (their snapshot "name"), so big-x stands alone:
  // 9,000 B retained by itself, and big-z (700 B) is retained by shared, not listed big.
  const stringRow = out.split('\n').find(l => l.includes('string big-x'));
  assert.ok(stringRow && stringRow.includes('8.79 KB'), 'big-x row: ' + stringRow);
});

test('mem-scenario script runs the script end to end and prints the comparable numbers', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', path.join(__dirname, '..', 'scripts', 'mem-scenario.mjs')], {encoding: 'utf8', timeout: 180000});
  assert.match(out, /entries: 201, ~[\d,]+ chars/);
  assert.match(out, /outputs: 30, [\d,]+ chars total, largest 99,999 chars/);
  assert.match(out, /heapUsed after GC: [\d.]+ MB/);
  assert.match(out, /Private Bytes: ([\d.]+ MB|unavailable)/);
});
