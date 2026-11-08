'use strict';
// `muser export` (EXPORT.md): the real bin as a subprocess, in scratch
// homes, against a local receiver stub. Nothing here reaches the real
// receiver: MUSER_REPORT_URL always points at the stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const {spawnSync, spawn} = require('node:child_process');
const BIN = path.join(__dirname, '..', 'bin', 'muser.js');
const SESSIONS_JS = path.join(__dirname, '..', 'src', 'sessions.js');

function scratch() {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportcli-home-')),
    data: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportcli-data-')),
    work: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportcli-work-')),
    out: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-exportcli-out-')),
  };
}
function envFor(d, extra = {}) {
  return {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', USERPROFILE: d.home, HOME: d.home, LOCALAPPDATA: d.data, MUSER_EXPORT_DIR: d.out, ...extra};
}
// Async spawn, never spawnSync: the receiver stub lives in THIS process,
// and a blocked event loop would leave the child's POST unanswered until
// the timeout — a deadlock that looks like a hang in the bin.
function runBin(args, {dirs, env = {}, input, timeout = 60000} = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, ...args], {env: envFor(dirs, env), cwd: dirs.work});
    let stdout = '', stderr = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); resolve({status: code, stdout, stderr}); });
    p.stdin.end(input ?? '');
  });
}
// Seed one finished conversation into the scratch store, in its own
// process (the store paths come from the env, like the real bin's).
function seed(dirs, {user = '直してほしい', reply = '直しました'} = {}) {
  const script = 'const s = require(' + JSON.stringify(SESSIONS_JS) + ');'
    + 'const x = s.create(process.cwd()); x.turns = 1; s.save(x);'
    + 's.appendTurn(x.id, {v: 1, at: Date.now(), user: ' + JSON.stringify(user) + ', reply: ' + JSON.stringify(reply) + ', tools: [{command: "code.read", summary: "src/a.js", ok: true}], progress: [], usage: {inputTokens: 3, outputTokens: 1}});'
    + 'console.log(x.id);';
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 30000, env: envFor(dirs), cwd: dirs.work});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').pop();
}
function stubReceiver(t, reply = {status: 200, body: {id: '20261107-cafe0123ab'}}) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push({headers: req.headers, body: Buffer.concat(chunks)}); res.writeHead(reply.status, {'content-type': 'application/json'}); res.end(JSON.stringify(reply.body)); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    resolve({url: 'http://127.0.0.1:' + server.address().port + '/muser/report', got});
  }));
}

test('export --yes: sends the most recent conversation to MUSER_REPORT_URL, body excluded', async t => {
  const dirs = scratch();
  const id = seed(dirs, {user: 'ひみつの頼みごと'});
  const stub = await stubReceiver(t);
  const r = await runBin(['export', '--yes'], {dirs, env: {MUSER_REPORT_URL: stub.url}});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('送りました。ID: 20261107-cafe0123ab'));
  assert.ok(r.stdout.includes('Discord'));
  assert.equal(stub.got.length, 1);
  const parsed = JSON.parse(zlib.gunzipSync(stub.got[0].body).toString('utf8'));
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.session.id, id);
  assert.equal(parsed.includesConversation, false);
  assert.ok(!JSON.stringify(parsed).includes('ひみつの頼みごと'), 'the conversation body stays out without --with-conversation');
});

test('export --yes --with-conversation: the body rides, only because it was asked for', async t => {
  const dirs = scratch();
  seed(dirs, {user: 'ひみつの頼みごと'});
  const stub = await stubReceiver(t);
  const r = await runBin(['export', '--yes', '--with-conversation'], {dirs, env: {MUSER_REPORT_URL: stub.url}});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(zlib.gunzipSync(stub.got[0].body).toString('utf8'));
  assert.equal(parsed.includesConversation, true);
  assert.ok(JSON.stringify(parsed).includes('ひみつの頼みごと'));
});

test('export --dry-run: writes the JSON to a file, sends nothing, names the place', async t => {
  const dirs = scratch();
  const id = seed(dirs);
  const stub = await stubReceiver(t);
  const r = await runBin(['export', '--dry-run'], {dirs, env: {MUSER_REPORT_URL: stub.url}});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(stub.got.length, 0, 'dry-run sends nothing');
  const m = /送らずにファイルに書きました: (.+)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  const file = m[1].trim();
  assert.ok(file.startsWith(dirs.out), file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.session.id, id);
  assert.ok(r.stdout.includes('合計'), 'the sizes are shown');
});

test('export without --yes on a non-TTY refuses to send unseen', async t => {
  const dirs = scratch();
  seed(dirs);
  const stub = await stubReceiver(t);
  const r = await runBin(['export'], {dirs, env: {MUSER_REPORT_URL: stub.url}, input: ''});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok((r.stdout + r.stderr).includes('確認できないため送りません'));
  assert.equal(stub.got.length, 0);
});

test('export --session: an unknown id is an error, a prefix finds its conversation', async t => {
  const dirs = scratch();
  const id = seed(dirs);
  const stub = await stubReceiver(t);
  const bad = await runBin(['export', '--yes', '--session', 'deadbeefdeadbeef'], {dirs, env: {MUSER_REPORT_URL: stub.url}});
  assert.equal(bad.status, 1);
  assert.ok((bad.stdout + bad.stderr).includes('会話が見つかりません'));
  const ok = await runBin(['export', '--yes', '--session', id.slice(0, 8)], {dirs, env: {MUSER_REPORT_URL: stub.url}});
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const parsed = JSON.parse(zlib.gunzipSync(stub.got[0].body).toString('utf8'));
  assert.equal(parsed.session.id, id);
});

test('export: receiver failure is reported with its reason and a nonzero exit', async t => {
  const dirs = scratch();
  seed(dirs);
  const stub = await stubReceiver(t, {status: 429, body: {error: 'too many reports from this address, try again later'}});
  const r = await runBin(['export', '--yes'], {dirs, env: {MUSER_REPORT_URL: stub.url}});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('時間をおいて'));
});

test('export: argument hygiene — extra words, flag conflicts, foreign flags, no conversation', async t => {
  const dirs = scratch();
  seed(dirs);
  const extra = await runBin(['export', 'extra'], {dirs});
  assert.equal(extra.status, 1); assert.ok((extra.stdout + extra.stderr).includes('余分な引数です'));
  const conflict = await runBin(['export', '--dry-run', '--yes'], {dirs});
  assert.equal(conflict.status, 1); assert.ok((conflict.stdout + conflict.stderr).includes('--dry-run と --yes'));
  const foreign = await runBin(['usage', '--yes'], {dirs});
  assert.equal(foreign.status, 1); assert.ok((foreign.stdout + foreign.stderr).includes('--yes'));
  const empty = await runBin(['export', '--yes'], {dirs: scratch()});
  assert.equal(empty.status, 1); assert.ok((empty.stdout + empty.stderr).includes('送る会話がありません'));
});

test('help lists muser export', async t => {
  const dirs = scratch();
  const r = await runBin(['--help'], {dirs});
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('muser export'));
  assert.ok(r.stdout.includes('MUSER_REPORT_URL'));
});
