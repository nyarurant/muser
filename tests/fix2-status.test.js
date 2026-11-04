'use strict';
// Fix phase 2 (agent A14): c11 Medium items for src/server/status.js,
// src/agent-types.js and src/crash.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const st = require('../src/server/status');
const types = require('../src/agent-types');
const crash = require('../src/crash');
const {after} = require('node:test');
const made = [];
const tmp = p => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true}); });
function loadCapturing(cwd) { const lines = [], orig = console.error; console.error = (...a) => lines.push(a.map(String).join(' ')); let out; try { out = types.load(cwd); } finally { console.error = orig; } return {out, lines}; }

test('fix2 status #1: per-conversation state fetches run in parallel, not serially', async () => {
  let inflight = 0, peak = 0;
  const servers = await st.gatherWindowStatus({
    readServer: () => ({pid: 1, port: 1111, token: 'x'}), readGui: () => null,
    probe: async () => ({pid: 1, port: 1111, sessions: [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}]}),
    request: async () => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 20)); inflight--; return {status: 200, json: {busy: false}}; },
  });
  assert.equal(peak, 4, 'all four snapshots should be in flight at once (serial gave peak 1)');
  assert.deepEqual(Object.keys(servers[0].states).sort(), ['a', 'b', 'c', 'd']);
});

test('fix2 status #2: server/window strings cannot inject newlines or terminal escapes', () => {
  const evil = 'x\nFAKE ROW\x1b]52;c;evil\x07\x1b[31m';
  const row = st.formatRow({shortId: 'abcd1234', activity: 'idle', cwd: 'C:\\' + evil, accountLabel: evil, focusStatus: evil, isDefault: false, turnStart: null, lastUsedAt: null}, Date.now());
  assert.ok(!row.includes('\n') && !row.includes('\x1b'), 'formatRow stays one clean line: ' + JSON.stringify(row));
  const win = st.formatWindow({pid: 42, activity: 'idle', connected: true, cwd: evil, session: {id: 'abcd1234-zz', title: evil}, todos: [{status: 'in_progress', content: evil}], queue: 0, agents: []}, Date.now());
  for (const line of win) assert.ok(!line.includes('\x1b'), 'no escape reaches the terminal');
  assert.ok(!win.some(l => l.startsWith('FAKE ROW')), 'a title newline cannot forge a row');
  const ex = st.formatExec({pid: 7, startedAt: new Date().toISOString(), cwd: evil, account: evil, prompt: evil + '\nsecond', tools: 1, last: evil}, Date.now());
  for (const line of ex) assert.ok(!line.includes('\x1b') && !line.startsWith('FAKE ROW'), 'exec line clean: ' + JSON.stringify(line));
  const det = st.formatDetail({kind: 'window', item: {pid: 42, activity: 'idle', connected: true, cwd: 'C:\\a', session: {id: 'abcd1234'}, todos: [{status: 'pending', content: evil}], agents: [{tag: 'a1', type: 'general', state: 'done', title: evil}], toolLog: [{command: 'code.read', ok: false, error: evil, at: new Date().toISOString()}], progress: [{message: evil}], goal: evil, focus: {status: 'working', open: ['c1'], reason: evil}}}, Date.now());
  for (const line of det) assert.ok(!line.includes('\x1b'), 'detail line clean: ' + JSON.stringify(line));
  assert.ok(!det.some(l => l.startsWith('FAKE ROW')));
  assert.equal(st.cleanText('a\r\nb\x1b[31mc'), 'a bc');
});

test('fix2 agent-types #7: a project type replacing a user type warns (prompt still replaced)', () => {
  const home = os.homedir(); // isolated by tests/setup.mjs
  const userAgents = path.join(home, '.muser', 'agents');
  fs.mkdirSync(userAgents, {recursive: true});
  const userFile = path.join(userAgents, 'mydocs.md');
  fs.writeFileSync(userFile, '---\nname: mydocs\n---\nUSER PROMPT\n');
  const proj = tmp('muser-fix2-proj-');
  fs.mkdirSync(path.join(proj, '.muser', 'agents'), {recursive: true});
  const projFile = path.join(proj, '.muser', 'agents', 'mydocs.md');
  fs.writeFileSync(projFile, '---\nname: mydocs\n---\nPROJECT PROMPT\n');
  try {
    const {out, lines} = loadCapturing(proj);
    assert.equal(out.mydocs.prompt, 'PROJECT PROMPT', 'existing precedence is unchanged');
    assert.ok(lines.some(l => l.includes('mydocs') && l.includes(projFile)), 'expected a shadow warning naming the project file, got: ' + lines.join(' | '));
  } finally { fs.rmSync(userFile, {force: true}); }
});

test('fix2 agent-types #8: an upper-case .MD definition file is loaded, with its name intact', () => {
  const proj = tmp('muser-fix2-upper-');
  fs.mkdirSync(path.join(proj, '.muser', 'agents'), {recursive: true});
  fs.writeFileSync(path.join(proj, '.muser', 'agents', 'Reviewer.MD'), '---\ndescription: Upper case ext\n---\nReview things.\n');
  const {out} = loadCapturing(proj);
  assert.ok(out.reviewer, 'Reviewer.MD should define type "reviewer", got: ' + Object.keys(out).join(','));
  assert.equal(out.reviewer.prompt, 'Review things.');
});

test('fix2 crash #11: two crashes in the same millisecond keep two reports', t => {
  const dir = tmp('muser-fix2-crash-');
  process.env.MUSER_CRASH_DIR = dir;
  t.after(() => { delete process.env.MUSER_CRASH_DIR; });
  const orig = Date.prototype.toISOString;
  Date.prototype.toISOString = () => '2026-01-01T00-00-00.000Z';
  let f1, f2;
  try { f1 = crash.write({error: new Error('one')}); f2 = crash.write({error: new Error('two')}); } finally { Date.prototype.toISOString = orig; }
  assert.ok(f1 && f2 && f1 !== f2, 'same-millisecond reports must not share a path');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 2);
  assert.match(JSON.parse(fs.readFileSync(f1, 'utf8')).error, /one/);
  assert.match(JSON.parse(fs.readFileSync(f2, 'utf8')).error, /two/);
});
