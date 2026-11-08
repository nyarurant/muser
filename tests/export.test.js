'use strict';
// /export (EXPORT.md): the report builder, the redaction pass, and the
// sender. The sender is only ever pointed at a local http server here —
// the real receiver is not a test target.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const exporter = require('../src/export');
const sessions = require('../src/sessions');
const store = require('../src/secure-store');

const USER = 'nyaru';
const EMAIL = 'nyaru-secret@example.com';
const GHP = 'ghp_1234567890abcdefghijklmnopqrstuv';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3AAA';

function makeSession(t, {turns = []} = {}) {
  const s = sessions.create('C:\\Users\\' + USER + '\\work');
  s.turns = turns.length;
  sessions.save(s);
  for (const turn of turns) sessions.appendTurn(s.id, turn);
  t.after(() => {});
  return s;
}
function turn(over = {}) {
  return {v: 1, at: 1762470000000, user: '直してほしい', reply: '直しました',
    usage: {inputTokens: 111, outputTokens: 22, source: 'live'},
    tools: [{command: 'code.read', summary: 'src/a.js を読んだ', ok: true}],
    steps: [{title: '調査', detail: '内側の詳細は出さない', failed: false}],
    progress: [{agent: 'main', message: '調べています', at: 1762470000001}],
    focus: {status: 'complete', goal: '直す', criteria: [{id: 'c1', status: 'met'}]},
    todos: [{content: '直す', status: 'completed'}], ...over};
}

test('buildReport: schema 1 with every required section, conversation off by default', t => {
  const s = makeSession(t, {turns: [turn()]});
  const r = exporter.buildReport({session: s, username: USER});
  assert.equal(r.schema, 1);
  assert.equal(r.includesConversation, false);
  assert.equal(r.app.name, 'muser');
  assert.equal(typeof r.app.version, 'string');
  assert.equal(r.app.node, process.version);
  assert.ok(r.app.osRelease && r.app.platform && r.app.language && r.app.terminal && typeof r.app.terminal.kind === 'string');
  assert.ok(r.settings && typeof r.settings.fullscreen === 'boolean' && typeof r.settings.maxToolCallsPerTurn === 'number');
  assert.deepEqual(r.accounts, {count: 1, currentIndex: 1, current: '1 番目'});
  assert.equal(r.session.id, s.id);
  assert.equal(r.session.turns, 1);
  assert.equal(r.session.cwd, 'C:\\Users\\<user>\\work');
  assert.ok(r.session.createdAt);
  assert.equal(r.turns.length, 1);
  const one = r.turns[0];
  // No conversation body: prose fields keep only their shape — a summary
  // becomes its length plus the paths in it, a progress note a length.
  assert.deepEqual(one.tools, [{command: 'code.read', ok: true, summaryChars: 'src/a.js を読んだ'.length, paths: ['src/a.js']}]);
  assert.deepEqual(one.progress, [{agent: 'main', at: 1762470000001, chars: '調べています'.length}]);
  assert.deepEqual(one.usage, {inputTokens: 111, outputTokens: 22, source: 'live'});
  assert.equal(one.focus.status, 'complete');
  assert.equal(one.focus.goalChars, '直す'.length); // the goal text stays home without the body
  assert.deepEqual(one.steps, [{titleChars: '調査'.length}]); // title and detail stay home
  assert.deepEqual(one.todos, {count: 1, byStatus: {completed: 1}});
  assert.ok(!('user' in one) && !('reply' in one), 'conversation body is opt-in only');
  assert.ok(Array.isArray(r.focusLog) && r.state && Array.isArray(r.state.windows) && Array.isArray(r.state.servers));
});

test('buildReport: tool arguments and step details never ride along', t => {
  const withArgs = turn({tools: [{command: 'code.write', summary: 'f を書いた', ok: true, args: {path: 'f', content: 'FILE BODY THAT MUST NOT TRAVEL'}, params: {text: 'ALSO NOT'}}]});
  const s = makeSession(t, {turns: [withArgs]});
  const r = exporter.buildReport({session: s, username: USER});
  const json = JSON.stringify(r);
  assert.ok(!json.includes('FILE BODY THAT MUST NOT TRAVEL'));
  assert.ok(!json.includes('ALSO NOT'));
  assert.ok(!json.includes('内側の詳細は出さない'));
});

test('buildReport: conversation body only when asked, and redacted even then', t => {
  const s = makeSession(t, {turns: [turn({user: '連絡は ' + EMAIL + ' まで。token=' + GHP, reply: '了解しました ' + EMAIL})]});
  const off = exporter.buildReport({session: s, username: USER});
  assert.ok(!JSON.stringify(off).includes(EMAIL));
  const on = exporter.buildReport({session: s, username: USER, includeConversation: true});
  assert.equal(on.includesConversation, true);
  assert.ok(on.turns[0].user.includes('<email>'));
  const json = JSON.stringify(on);
  assert.ok(!json.includes(EMAIL) && !json.includes(GHP), 'secrets are redacted even in the opt-in body');
});

test('redactString: emails, tokens, authorization, passwords, usernames, paths', () => {
  const o = {username: USER, homeDir: 'C:\\Users\\someoneelse'};
  assert.equal(exporter.redactString('mail me at ' + EMAIL, o), 'mail me at <email>');
  assert.equal(exporter.redactString('Authorization: Bearer abc.def-123', o), 'Authorization: <redacted>');
  assert.ok(!exporter.redactString('token=' + GHP, o).includes(GHP));
  assert.ok(!exporter.redactString('jwt ' + JWT, o).includes(JWT));
  assert.ok(!exporter.redactString('password: hunter2secret', o).includes('hunter2secret'));
  assert.ok(!exporter.redactString('https://x.test/?token=abc123&ok=1', o).includes('abc123'));
  assert.equal(exporter.redactString('C:\\Users\\' + USER + '\\proj\\a.js', o), 'C:\\Users\\<user>\\proj\\a.js');
  assert.equal(exporter.redactString('C:/Users/' + USER + '/proj', o), 'C:/Users/<user>/proj');
  assert.ok(!exporter.redactString('the user ' + USER + ' said so', o).includes(USER));
  // the home folder itself collapses to ~
  assert.equal(exporter.redactString('C:\\Users\\' + USER + '\\x', {username: USER, homeDir: 'C:\\Users\\' + USER}), '~\\x');
});

test('redact: secret-shaped keys, usage counts survive, sensitive file contents dropped', () => {
  const o = {username: USER, homeDir: 'C:\\Users\\someoneelse'};
  const out = exporter.redact({
    token: 'abc', nested: {apiKey: 'k', refreshToken: 'r', cookie: 'c'},
    usage: {inputTokens: 10, outputTokens: 5},
    read: {path: 'C:\\Users\\' + USER + '\\AppData\\Local\\muser\\session.enc', content: 'ENCRYPTED BLOB', summary: 'kept'},
    envFile: {path: 'C:\\work\\.env', text: 'SECRET=1', note: 'kept note'},
  }, o);
  assert.equal(out.token, '<redacted>');
  assert.equal(out.nested.apiKey, '<redacted>');
  assert.equal(out.nested.refreshToken, '<redacted>');
  assert.equal(out.nested.cookie, '<redacted>');
  assert.deepEqual(out.usage, {inputTokens: 10, outputTokens: 5});
  assert.equal(out.read.content, '<redacted>');
  assert.equal(out.read.summary, 'kept');
  assert.equal(out.envFile.text, '<redacted>');
  assert.equal(out.envFile.note, 'kept note');
});

test('buildReport: focus log without params/result, focus state redacted, newest crash only', async t => {
  const s = makeSession(t, {turns: [turn()]});
  const {FocusLog} = require('../src/focus-log');
  const log = new FocusLog({sessionId: s.id, level: 'verbose'});
  log.append('checkpoint', {decision: 'met', why: 'tests passed', detail: 'ok', params: {command: 'npm test', text: 'PARAM BODY'}, result: 'RESULT BODY'});
  sessions.saveFocus(s.id, {v: 1, goal: '直す', status: 'running', criteria: [], evidence: [], token: 'state-secret', fileRef: {path: 'C:\\Users\\' + USER + '\\.muser\\web.enc', content: 'ENC BLOB'}});
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-export-crash-'));
  t.after(() => fs.rmSync(crashDir, {recursive: true, force: true}));
  const old = path.join(crashDir, '2026-11-06T00-00-00-000Z-1-aaaa.json');
  const fresh = path.join(crashDir, '2026-11-07T00-00-00-000Z-2-bbbb.json');
  fs.writeFileSync(old, JSON.stringify({error: 'OLD CRASH', muser: '0.3.7'}));
  fs.writeFileSync(fresh, JSON.stringify({error: 'NEW CRASH', muser: '0.3.8'}));
  fs.utimesSync(old, new Date(1000), new Date(1000));
  fs.utimesSync(fresh, new Date(2000), new Date(2000));
  const prev = process.env.MUSER_CRASH_DIR;
  process.env.MUSER_CRASH_DIR = crashDir;
  try {
    const r = exporter.buildReport({session: s, username: USER});
    assert.equal(r.focusLog.length, 1);
    assert.equal(r.focusLog[0].decision, 'met');
    assert.ok(!('params' in r.focusLog[0]) && !('result' in r.focusLog[0]));
    const json = JSON.stringify(r);
    assert.ok(!json.includes('PARAM BODY') && !json.includes('RESULT BODY'));
    assert.equal(r.focusState.token, '<redacted>');
    // Without the body the focus state is shape-only: the goal is a length
    // and a sensitive file's content field is gone entirely (its length
    // is not the content, and the content itself never rides).
    assert.equal(r.focusState.goalChars, '直す'.length);
    assert.ok(!('goal' in r.focusState));
    assert.ok(!('content' in r.focusState.fileRef));
    assert.equal(r.focusState.fileRef.contentChars, 'ENC BLOB'.length);
    assert.ok(!json.includes('ENC BLOB'));
    assert.equal(r.crash.report.error, 'NEW CRASH');
    assert.ok(!json.includes('OLD CRASH'));
  } finally { if (prev === undefined) delete process.env.MUSER_CRASH_DIR; else process.env.MUSER_CRASH_DIR = prev; }
});

test('buildReport: window/server state carries no token, no label, no title', t => {
  const s = makeSession(t, {turns: [turn()]});
  const winDir = path.join(store.DIR, 'windows');
  fs.mkdirSync(winDir, {recursive: true});
  const winFile = path.join(winDir, process.pid + '.json');
  fs.writeFileSync(winFile, JSON.stringify({version: 1, kind: 'window', pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: 'C:\\Users\\' + USER + '\\work', mode: 'default', account: {id: 'default', label: EMAIL}, session: {id: s.id, title: 'PRIVATE TITLE', turns: 1}, connected: true, activity: 'idle'}));
  t.after(() => { try { fs.unlinkSync(winFile); } catch {} });
  const srvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-export-srv-')), 'server.json');
  fs.writeFileSync(srvFile, JSON.stringify({port: 4321, token: 'SERVER-BEARER-TOKEN-xyz', pid: 999, version: '0.3.8', startedAt: '2026-11-07T00:00:00.000Z'}));
  const prevSrv = process.env.MUSER_SERVER_FILE, prevGui = process.env.MUSER_GUI_FILE;
  process.env.MUSER_SERVER_FILE = srvFile; process.env.MUSER_GUI_FILE = srvFile + '.missing';
  try {
    const r = exporter.buildReport({session: s, username: USER});
    const json = JSON.stringify(r);
    assert.ok(!json.includes('SERVER-BEARER-TOKEN-xyz'), 'discovery token must not travel');
    assert.ok(!json.includes('PRIVATE TITLE'), 'window session title must not travel');
    assert.ok(!json.includes(EMAIL));
    const w = r.state.windows.find(x => x.pid === process.pid);
    assert.ok(w, 'own window is listed');
    assert.deepEqual(w.account, {index: 1});
    assert.deepEqual(w.session, {turns: 1}); // the id stays home even for the own window
    assert.ok(!('cwd' in w) && !('goal' in w) && !('todos' in w && 'items' in (w.todos || {})));
    assert.equal(r.state.servers.length, 1);
    assert.equal(r.state.servers[0].port, 4321);
    assert.ok(!('token' in r.state.servers[0]));
    assert.ok(!('sessionId' in r.state.servers[0]), 'the server session id stays home');
  } finally {
    if (prevSrv === undefined) delete process.env.MUSER_SERVER_FILE; else process.env.MUSER_SERVER_FILE = prevSrv;
    if (prevGui === undefined) delete process.env.MUSER_GUI_FILE; else process.env.MUSER_GUI_FILE = prevGui;
  }
});

test('sectionSizes and sizeLines: per-section bytes and a total', t => {
  const s = makeSession(t, {turns: [turn()]});
  const r = exporter.buildReport({session: s, username: USER});
  const {sections, total} = exporter.sectionSizes(r);
  assert.ok(sections.some(x => x.key === 'turns' && x.bytes > 0));
  assert.equal(total, Buffer.byteLength(JSON.stringify(r), 'utf8'));
  const lines = exporter.sizeLines(r);
  assert.ok(lines.some(l => l.includes('合計')));
});

test('saveReport: writes the JSON to a file and names the place', t => {
  const s = makeSession(t, {turns: [turn()]});
  const r = exporter.buildReport({session: s, username: USER});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-export-save-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = exporter.saveReport(r, {dir});
  assert.ok(fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.session.id, s.id);
});

// A receiver stand-in on localhost: records what arrived, answers as told.
function stubReceiver(t, reply) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      got.push({headers: req.headers, body: Buffer.concat(chunks)});
      const r = typeof reply === 'function' ? reply(got[got.length - 1]) : reply;
      res.writeHead(r.status, {'content-type': 'application/json'});
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    resolve({url: 'http://127.0.0.1:' + server.address().port + '/muser/report', got});
  }));
}

test('sendReport: gzipped JSON with the version header, id comes back', async t => {
  const s = makeSession(t, {turns: [turn()]});
  const r = exporter.buildReport({session: s, username: USER});
  const stub = await stubReceiver(t, {status: 200, body: {id: '20261107-abcdef0123'}});
  const out = await exporter.sendReport(r, {url: stub.url});
  assert.equal(out.id, '20261107-abcdef0123');
  assert.equal(stub.got.length, 1);
  assert.equal(stub.got[0].headers['content-type'], 'application/gzip');
  assert.equal(stub.got[0].headers['x-muser-version'], r.app.version);
  const parsed = JSON.parse(zlib.gunzipSync(stub.got[0].body).toString('utf8'));
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.session.id, s.id);
});

test('sendReport: receiver errors keep their status and read as guidance', async t => {
  const stub = await stubReceiver(t, {status: 429, body: {error: 'too many reports from this address, try again later'}});
  const err = await exporter.sendReport({schema: 1}, {url: stub.url}).then(() => null, e => e);
  assert.ok(err instanceof exporter.ExportSendError);
  assert.equal(err.status, 429);
  assert.ok(exporter.failureMessage(err).includes('時間をおいて'));
  const stub413 = await stubReceiver(t, {status: 413, body: {error: 'report too large'}});
  const err413 = await exporter.sendReport({schema: 1}, {url: stub413.url}).then(() => null, e => e);
  assert.equal(err413.status, 413);
  assert.ok(exporter.failureMessage(err413).includes('大きすぎ'));
});

test('sendReport: an over-8MB gzip is refused before anything is sent', async t => {
  const stub = await stubReceiver(t, {status: 200, body: {id: 'never'}});
  const big = {schema: 1, blob: crypto.randomBytes(9 * 1024 * 1024).toString('base64')};
  const err = await exporter.sendReport(big, {url: stub.url}).then(() => null, e => e);
  assert.ok(err instanceof exporter.ExportSendError && err.status === 413);
  assert.equal(stub.got.length, 0);
});

test('reportUrl: MUSER_REPORT_URL wins, default is the real receiver', () => {
  assert.equal(exporter.reportUrl({}), exporter.DEFAULT_REPORT_URL);
  assert.equal(exporter.reportUrl({MUSER_REPORT_URL: 'http://127.0.0.1:9/x'}), 'http://127.0.0.1:9/x');
});

test('sentMessage names the id and tells the user to pass it on', () => {
  const m = exporter.sentMessage('20261107-abcdef0123');
  assert.ok(m.includes('20261107-abcdef0123') && m.includes('Discord'));
});
