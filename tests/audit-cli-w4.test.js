'use strict';
// audit-cli wave 4 regression tests for already-fixed defects:
//  (1) tools: an edit on a lossy (invalid) UTF-8 file is refused and the
//      bytes stay intact; a long line cut for display never splits a
//      surrogate pair.
//  (2) lore: `forget --path --all` must NOT delete everything (the --all
//      is --path's value); line number 4294967297 is a usage error;
//      formatRecord drops control characters from stored fields.
//  (3) mcp: a string `mcpServers` is a worded config error; a null entry
//      is recorded as that server's error while healthy servers start.
//  (4) policy: a folder named '..hidden' inside the project is INSIDE it.
//  (5) sessions: titles drop RLO / zero-width characters and are cut by
//      code points, not UTF-16 units.
//  (6) agent: resolveAgentLimits clamps 1000000 (64 concurrent / 1000
//      per turn) instead of treating it as effectively unlimited.
//  (7) overnight cli: max-tokens=0x10 is an error, not silently 16.
//  (8) skills: a quoted description with a trailing comment reads back
//      without the quotes (and a '#' inside the quotes survives).
// Isolation follows tests/setup.mjs (it already points HOME /
// LOCALAPPDATA at temp dirs); this file pins its own temp dirs BEFORE
// requiring any src module, like tests/mcp.test.js / sessions.test.js,
// because src/mcp.js and src/sessions.js resolve their files at
// require time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w4-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w4-test-home-'));

const {TOOLS} = require('../src/tools');
const lore = require('../src/lore');
const mcp = require('../src/mcp');
const {decide, alwaysKey} = require('../src/policy');
const sessions = require('../src/sessions');
const {resolveAgentLimits} = require('../src/agent');
const {overnightCli} = require('../src/overnight/cli');
const {frontmatter} = require('../src/skills');

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'muser-w4-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------- (1) tools: lossy UTF-8 edit refusal + surrogate-safe cut ----------

test('w4 tools (1): edit/patch on an invalid-UTF-8 file are refused and the bytes stay intact', (t) => {
  const cwd = tmpdir(t);
  const ctx = {cwd, readFiles: new Set()};
  // 'hello\n' + two stray continuation bytes + '\nworld\n': decoding to
  // text replaces 0x80 0x81 with U+FFFD, so writing the text back would
  // permanently replace them with EF BF BD.
  const bytes = Buffer.concat([Buffer.from('hello\n', 'utf8'), Buffer.from([0x80, 0x81]), Buffer.from('\nworld\n', 'utf8')]);
  fs.writeFileSync(path.join(cwd, 'bad.txt'), bytes);
  const read = TOOLS['code.read'].run({path: 'bad.txt'}, ctx);
  assert.match(read.payload.warning || '', /not valid UTF-8/, 'the read warns that the bytes are not valid UTF-8');
  assert.throws(() => TOOLS['code.edit'].run({path: 'bad.txt', old_string: 'hello', new_string: 'hi'}, ctx), /not valid UTF-8/);
  assert.throws(() => TOOLS['code.apply_patch'].run({patch: '*** Begin Patch\n*** Update File: bad.txt\n-hello\n+hi\n*** End Patch'}, ctx), /not valid UTF-8/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'bad.txt')), bytes, 'the original bytes are untouched');
});

test('w4 tools (1): a long line is cut without splitting a surrogate pair', (t) => {
  const cwd = tmpdir(t);
  const ctx = {cwd, readFiles: new Set()};
  // MAX_LINE is 2000: 1999 plain chars put the emoji's HIGH surrogate at
  // index 1999, so a plain slice(0, 2000) would end on a lone surrogate.
  const line = 'a'.repeat(1999) + '\uD83D\uDE00' + 'b'.repeat(100);
  fs.writeFileSync(path.join(cwd, 'long.txt'), line + '\n');
  const read = TOOLS['code.read'].run({path: 'long.txt'}, ctx);
  assert.deepEqual(read.payload.long_lines, [1], 'the line is reported as cut');
  assert.ok(!LONE_SURROGATE.test(read.payload.content), 'no lone surrogate in the shown content');
  assert.ok(!read.payload.content.includes('\uD83D\uDE00'), 'the pair at the cut point is dropped whole, not halved');
  assert.ok(read.payload.content.endsWith('\u2026'), 'the cut line ends with the ellipsis marker');
  assert.ok(read.payload.content.includes('a'.repeat(1999)), 'everything before the pair is shown');
});

// ---------- (2) lore ----------

function loreSetup(t) {
  const data = tmpdir(t, 'muser-w4-lore-data-');
  process.env.LOCALAPPDATA = data;
  const repo = tmpdir(t, 'muser-w4-lore-repo-');
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n');
  return {data, repo};
}
const loreRec = (id, p) => ({v: 1, kind: 'why', id, at: '2026-11-08T00:00:00.000Z', path: p, start: 1, end: 1, reason: 'r-' + id, agent: 'main'});

test('w4 lore (2): forget --path --all does not delete everything (the --all is the path value)', (t) => {
  const {repo} = loreSetup(t);
  lore.appendRecord(repo, loreRec('w4-a', 'src/a.js'));
  lore.appendRecord(repo, loreRec('w4-b', 'src/b.js'));
  assert.equal(lore.readRecords(repo).length, 2);
  const lines = [];
  const code = lore.runLoreCli(['forget', '--path', '--all'], {cwd: repo, out: l => lines.push(l), sync: false});
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /0 \u4EF6\u6D88\u3057\u307E\u3057\u305F/, 'nothing was deleted: --all was consumed as the --path value');
  assert.equal(lore.readRecords(repo).length, 2, 'both records survive');
  // Control: a real --path forget still deletes only that path.
  const code2 = lore.runLoreCli(['forget', '--path', 'src/a.js'], {cwd: repo, out: () => {}, sync: false});
  assert.equal(code2, 0);
  assert.deepEqual(lore.readRecords(repo).map(r => r.id), ['w4-b']);
});

test('w4 lore (2): line number 4294967297 is an error, not line 1', (t) => {
  const {repo} = loreSetup(t);
  assert.equal(lore.parseFileLine('src/a.js:4294967297'), null, '2^32+1 must not wrap through |0 to line 1');
  assert.equal(lore.parseFileLine('src/a.js:99999999999999999999'), null, 'an overflowing line number is refused too');
  assert.deepEqual(lore.parseFileLine('src/a.js:12-15'), {file: 'src/a.js', start: 12, end: 15}, 'an ordinary range still parses');
  const lines = [];
  const code = lore.runLoreCli(['why', 'src/a.js:4294967297'], {cwd: repo, out: l => lines.push(l), sync: false});
  assert.equal(code, 1, 'the CLI reports it as a usage error');
  assert.match(lines.join('\n'), /\u4F7F\u3044\u65B9/);
});

test('w4 lore (2): formatRecord drops control characters from stored fields', () => {
  const rec = {v: 1, kind: 'hunch', id: 'w4-ctrl', at: '2026-11-08T00:00:00.000Z', path: 'src/a.js', start: 1, end: 1, state: 'open',
    text: 'first\x1B[31mRED\x07 bell\nFORGED HEADING \x00end'};
  const out = lore.formatRecord(rec, null);
  assert.ok(!out.includes('\x1B'), 'no ESC survives into the printed line');
  assert.ok(!out.includes('\x07'), 'no BEL survives');
  assert.ok(!out.includes('\x00'), 'no NUL survives');
  assert.ok(!out.includes('\n'), 'a stored newline cannot forge a second line');
  assert.ok(out.includes('RED'), 'the visible text is kept');
  assert.ok(out.includes('FORGED HEADING'), 'the words are kept, as one line');
});

// ---------- (3) mcp ----------

test('w4 mcp (3): a string mcpServers is recorded as a config error and load() starts without MCP (wave 15)', (t) => {
  t.after(() => fs.rmSync(mcp.FILE, {force: true}));
  fs.mkdirSync(path.dirname(mcp.FILE), {recursive: true});
  // Wave 15 contract: load() no longer throws for a non-object mcpServers.
  // It records the error, drops the malformed value, and starts without MCP;
  // save() still refuses the shape via checkMcpServers.
  fs.writeFileSync(mcp.FILE, JSON.stringify({mcpServers: 'oops'}));
  let cfg;
  assert.doesNotThrow(() => { cfg = mcp.load(); }, 'load() does not throw for a string mcpServers');
  assert.deepEqual(cfg.mcpServers, {}, 'a string mcpServers is replaced with {}');
  assert.ok(mcp.configError(), 'configError() is non-empty for a string mcpServers');
  assert.match(mcp.configError(), /mcpServers/, 'the recorded error mentions mcpServers');
  assert.match(mcp.configError(), /形式が正しくありません/, 'the recorded error names the wrong shape');
  assert.ok(mcp.configError().includes(mcp.FILE), 'the recorded error contains the config file path');
  fs.writeFileSync(mcp.FILE, JSON.stringify({mcpServers: ['oops']}));
  assert.doesNotThrow(() => { cfg = mcp.load(); }, 'load() does not throw for an array mcpServers');
  assert.deepEqual(cfg.mcpServers, {}, 'an array mcpServers is replaced with {}');
  assert.ok(mcp.configError(), 'configError() is non-empty for an array mcpServers');
  assert.match(mcp.configError(), /mcpServers/, 'the recorded error mentions mcpServers');
  assert.match(mcp.configError(), /形式が正しくありません/, 'the recorded error names the wrong shape');
  assert.ok(mcp.configError().includes(mcp.FILE), 'the recorded error contains the config file path');
  fs.writeFileSync(mcp.FILE, JSON.stringify({mcpServers: {demo: {command: 'node'}}}));
  assert.equal(mcp.load().mcpServers.demo.command, 'node', 'a proper object still loads');
  assert.equal(mcp.configError(), '', 'configError() is cleared after a valid config loads');
});

test('w4 mcp (3): hub.start records a null entry as its own error and still starts the healthy server', async (t) => {
  t.after(() => fs.rmSync(mcp.FILE, {force: true}));
  fs.mkdirSync(path.dirname(mcp.FILE), {recursive: true});
  fs.writeFileSync(mcp.FILE, JSON.stringify({mcpServers: {
    bad: null,
    good: {command: process.execPath, args: [path.join(__dirname, 'fixtures-mcp-server.js')], enabled: true},
  }}));
  const hub = new mcp.McpHub();
  t.after(() => hub.close());
  const logs = [];
  await hub.start(m => logs.push(m));
  const bad = hub.servers.get('bad');
  assert.ok(bad, 'the null entry gets a server entry of its own');
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /"bad"[\s\S]*must be an object/);
  assert.ok(logs.some(l => l.includes('bad')), 'the bad entry is logged by name');
  const good = hub.servers.get('good');
  assert.ok(good, 'the healthy server is present');
  assert.equal(good.status, 'connected', 'the healthy server connected despite the null sibling');
  assert.ok(good.tools.length > 0, 'its tools were listed');
  assert.ok(Object.keys(hub.defs()).some(k => k.startsWith('mcp.good.')), 'its tools are indexed');
  await hub.close();
});

// ---------- (4) policy: '..hidden' is inside ----------

test("w4 policy (4): a '..hidden' folder inside the project counts as inside for a remembered command", (t) => {
  const root = tmpdir(t, 'muser-w4-policy-');
  const hidden = path.join(root, '..hidden');
  fs.mkdirSync(hidden, {recursive: true});
  const outside = tmpdir(t, 'muser-w4-policy-out-');
  const params = {command: 'npm run build'};
  const key = alwaysKey('exec', params);
  assert.ok(key, 'the command is rememberable');
  const always = new Set([key]);
  assert.equal(decide({mode: 'default', kind: 'exec', params, always, cwd: hidden, root}), 'allow',
    "'..hidden' is a folder NAME inside the project, not a '..' escape");
  assert.equal(decide({mode: 'default', kind: 'exec', params, always, cwd: root, root}), 'allow', 'control: the project root itself is inside');
  assert.equal(decide({mode: 'default', kind: 'exec', params, always, cwd: outside, root}), 'ask', 'control: a folder outside the project still asks');
});

// ---------- (5) sessions: title sanitising + code-point cut ----------

test('w4 sessions (5): a title drops RLO and zero-width characters', () => {
  const s = sessions.create('C:\\work');
  sessions.touch(s, 'ab\u202Ecd\u200Be\u2060f\uFEFF g\u200Fh');
  assert.equal(s.title, 'abcdef gh');
  assert.ok(!/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/.test(s.title), 'no bidi / zero-width character survives');
});

test('w4 sessions (5): a title is cut by code points, never mid-surrogate-pair', () => {
  const emoji = '\uD83D\uDE00';
  const s1 = sessions.create('C:\\work');
  sessions.touch(s1, 'x'.repeat(59) + emoji + 'y'.repeat(10));
  assert.equal([...s1.title].length, 60, 'the title holds 60 code points');
  assert.equal(s1.title, 'x'.repeat(59) + emoji, 'the pair at the boundary is kept whole');
  assert.ok(!LONE_SURROGATE.test(s1.title));
  const s2 = sessions.create('C:\\work');
  sessions.touch(s2, emoji.repeat(61));
  assert.equal(s2.title, emoji.repeat(60));
  assert.ok(!LONE_SURROGATE.test(s2.title));
});

// ---------- (6) agent limits clamp ----------

test('w4 agent (6): resolveAgentLimits clamps 1000000 to 64 concurrent / 1000 per turn', (t) => {
  const dir = tmpdir(t, 'muser-w4-agent-');
  const cfg = path.join(dir, 'config.json'); // does not exist: no config source
  assert.deepEqual(resolveAgentLimits({maxAgents: 1000000, maxAgentsTotal: 1000000}, {}, cfg), {concurrent: 64, perTurn: 1000});
  assert.deepEqual(resolveAgentLimits({}, {MUSER_MAX_AGENTS: '1000000', MUSER_MAX_AGENTS_TOTAL: '1000000'}, cfg), {concurrent: 64, perTurn: 1000}, 'env values clamp the same way');
  assert.deepEqual(resolveAgentLimits({maxAgents: 0, maxAgentsTotal: 0}, {}, cfg), {concurrent: 0, perTurn: 0}, 'an explicit 0 still means no limit');
});

// ---------- (7) overnight cli: strict cap spelling ----------

test('w4 overnight (7): start with max-tokens=0x10 is an error, not silently 16', async (t) => {
  const baseDir = tmpdir(t, 'muser-w4-overnight-');
  const settings = {numberValue: () => 0, overnightApproval: () => 'edit-auto', setOvernightApproval: () => {}};
  await assert.rejects(
    overnightCli(['start', 'max-tokens=0x10'], {baseDir, settings, statusesFn: async () => []}),
    /max-tokens=.*0 \u4EE5\u4E0A\u306E\u6574\u6570/,
    'a hex spelling is refused in words instead of becoming 16');
  await assert.rejects(
    overnightCli(['start', 'max-tasks=1e3'], {baseDir, settings, statusesFn: async () => []}),
    /max-tasks=.*0 \u4EE5\u4E0A\u306E\u6574\u6570/,
    'an exponent spelling is refused the same way');
});

// ---------- (8) skills: quoted value + trailing comment ----------

test('w4 skills (8): a quoted description with a trailing comment reads back without the quotes', () => {
  const dq = frontmatter('---\nname: demo\ndescription: "hello world" # the greeting\n---\nbody\n');
  assert.equal(dq.meta.description, 'hello world');
  const sq = frontmatter("---\nname: demo\ndescription: 'it works' # memo\n---\nbody\n");
  assert.equal(sq.meta.description, 'it works');
  const hash = frontmatter('---\nname: demo\ndescription: "a # b" # note\n---\nbody\n');
  assert.equal(hash.meta.description, 'a # b', "a '#' inside the quotes is part of the value, not a comment");
});
