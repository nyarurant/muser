'use strict';
// audit-cli wave 3 (I/O) regression tests for already-fixed defects:
//  (1) standalone export: a reply cut off mid-body must fail in finite
//      time instead of leaving sendReport pending forever.
//  (2) saveReport (src/export.js and the standalone fallback): two saves
//      in the same second must produce two files, not one overwrite.
//  (3) a broken 200 reply (unparseable body, or JSON with no id) must be
//      reported with the unconfirmed wording — the report may have
//      arrived — never as a plain failure.
//  (4) tell: a legacy peer record (no `kind` field, `files` as an array
//      of bare absolute path strings) must work through listPeers and
//      conflictsFor exactly like a current-format record.
//  (5) mentions: @-heavy text must stay linear — correctness on small
//      inputs plus a generous time cap on a medium @-heavy input.
// Everything is local: fake http servers on 127.0.0.1 and isolated temp
// homes / tell bases. No real receiver, no resident Server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Isolated home / data dirs, set before any src module is required
// (tests/setup.mjs already points these at temp dirs; pin our own too,
// like tests/tell.test.js and the wave-2 tests do).
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-test-home-'));

const standalone = require('../src/export-standalone');
const exporter = require('../src/export');
const tell = require('../src/tell');
const {mentions} = require('../src/mentions');

const UNCONFIRMED = '応答が読めなかったため、届いたか確認できませんでした。再送すると重複することがあります。';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w3-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
// Start a fake receiver on 127.0.0.1 with an ephemeral port.
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }));
  return 'http://127.0.0.1:' + server.address().port;
}
// Race a promise against a hard deadline so a hanging send fails this
// test quickly (with a clear message) instead of hanging the suite.
function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' did not settle within ' + ms + 'ms')), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
// Consume the request body, then answer — the way the real receiver does.
function answerOnEnd(req, res, answer) {
  req.on('error', () => {});
  res.on('error', () => {});
  req.resume();
  req.on('end', () => answer(req, res));
}

// ---------- (1) standalone export: mid-body cut-off ----------

test('w3 io (1): standalone sendReport fails in finite time when the reply is cut off mid-body', async (t) => {
  const base = await listen(t, (req, res) => answerOnEnd(req, res, () => {
    // Promise far more body than will ever arrive, send a fragment of a
    // valid reply, then cut the socket: no 'end' event on the client.
    res.writeHead(200, {'content-type': 'application/json', 'content-length': 128});
    res.write('{"id":"cut-off');
    setTimeout(() => { try { res.socket.destroy(); } catch {} }, 50);
  }));
  const started = Date.now();
  const err = await within(standalone.sendReport({schema: 1}, base + '/muser/report', {timeoutMs: 8000}).then(() => null, e => e), 5000, 'standalone sendReport');
  const elapsed = Date.now() - started;
  assert.ok(err instanceof Error, 'the send failed instead of resolving or hanging');
  assert.equal(err.status, 0, 'an incomplete reply is a connection-style (status 0) failure');
  assert.notEqual(err.unconfirmed, true, 'a cut-off reply is not the unconfirmed case — nothing was ever answered');
  assert.match(standalone.failureMessage(err), /送り先に接続できませんでした/);
  assert.ok(elapsed < 5000, 'it failed on the cut, not eventually (took ' + elapsed + 'ms)');
});

// ---------- (2) saveReport: same second, two saves, two files ----------

test('w3 io (2): exporter.saveReport twice in the same second keeps both files', (t) => {
  const dir = tmpdir(t);
  const report = {schema: 1, session: {id: 'sess-w3-save'}};
  // Back-to-back synchronous saves land in the same second (the stamp is
  // only second-precise and the session id is shared): the old naming
  // made the second save silently overwrite the first.
  const first = exporter.saveReport(report, {dir});
  const second = exporter.saveReport(report, {dir});
  assert.notEqual(first, second, 'each save gets its own file name');
  assert.ok(fs.existsSync(first), 'the first save is still there');
  assert.ok(fs.existsSync(second), 'the second save is there');
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  assert.equal(names.length, 2, 'the folder holds both reports');
  assert.deepEqual(JSON.parse(fs.readFileSync(first, 'utf8')), report);
  assert.deepEqual(JSON.parse(fs.readFileSync(second, 'utf8')), report);
});

test('w3 io (2): standalone saveReport twice in the same second keeps both files', (t) => {
  const dir = tmpdir(t);
  const prev = process.env.MUSER_EXPORT_DIR;
  process.env.MUSER_EXPORT_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.MUSER_EXPORT_DIR; else process.env.MUSER_EXPORT_DIR = prev; });
  const report = {schema: 1, standalone: true, session: {id: 'sess-w3-save'}};
  const first = standalone.saveReport(report);
  const second = standalone.saveReport(report);
  assert.notEqual(first, second, 'each save gets its own file name');
  assert.ok(fs.existsSync(first), 'the first save is still there');
  assert.ok(fs.existsSync(second), 'the second save is there');
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  assert.equal(names.length, 2, 'the folder holds both reports');
  assert.deepEqual(JSON.parse(fs.readFileSync(second, 'utf8')), report);
});

// ---------- (3) broken 200 reply: unconfirmed wording ----------

test('w3 io (3): a broken 200 reply is unconfirmed, in both export senders', async (t) => {
  const handler = (req, res) => answerOnEnd(req, res, () => {
    if (req.url.includes('noid')) { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({ok: true})); }
    else { res.writeHead(200, {'content-type': 'application/json'}); res.end('this is not json at all'); }
  });
  const base = await listen(t, handler);
  // Standalone sender: invalid JSON body on a 200.
  const errA = await standalone.sendReport({schema: 1}, base + '/broken', {timeoutMs: 5000}).then(() => null, e => e);
  assert.ok(errA, 'the standalone send failed');
  assert.equal(errA.status, 200);
  assert.equal(errA.unconfirmed, true, 'a 2xx whose body cannot be read is unconfirmed, not a plain failure');
  assert.equal(standalone.failureMessage(errA), UNCONFIRMED);
  // Standalone sender: valid JSON on a 200, but no id in it.
  const errB = await standalone.sendReport({schema: 1}, base + '/noid', {timeoutMs: 5000}).then(() => null, e => e);
  assert.ok(errB, 'the standalone send failed');
  assert.equal(errB.unconfirmed, true);
  assert.equal(standalone.failureMessage(errB), UNCONFIRMED);
  // Rich exporter (fetch-based): same two broken-200 shapes.
  for (const suffix of ['/broken', '/noid']) {
    const err = await exporter.sendReport({schema: 1}, {url: base + suffix, timeoutMs: 5000}).then(() => null, e => e);
    assert.ok(err instanceof exporter.ExportSendError, suffix + ': the send failed with an ExportSendError');
    assert.equal(err.status, 200, suffix);
    assert.equal(err.unconfirmed, true, suffix + ': unconfirmed');
    assert.equal(exporter.failureMessage(err), UNCONFIRMED, suffix + ': the user hears the unconfirmed wording');
  }
});

// ---------- (4) tell: legacy peer record ----------

test('w3 io (4): a legacy peer (no kind, files as bare strings) is listed and holds its claims', (t) => {
  const root = tmpdir(t);
  const base = path.join(root, 'tell'); // <root>/tell, so window/exec state resolves under the same isolated root
  const dir = tmpdir(t);
  const claimed = path.join(dir, 'legacy.txt');
  fs.writeFileSync(claimed, 'x\n');
  const now = new Date().toISOString();
  const putPeer = (sessionId, record) => {
    const f = tell.peerFile(process.pid, sessionId, {base});
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, JSON.stringify(record));
  };
  // The legacy record: written before the `kind` field existed, and its
  // claims are the pre-object format — bare absolute path strings.
  putPeer('sess-w3-legacy', {version: 1, pid: process.pid, sessionId: 'sess-w3-legacy', name: 'legacy-win', cwd: dir, files: [claimed], startedAt: now, updatedAt: now});
  // A bare RELATIVE string was never that format: it stays junk, claims nothing.
  putPeer('sess-w3-reljunk', {version: 1, pid: process.pid, sessionId: 'sess-w3-reljunk', name: 'rel-win', cwd: dir, files: ['legacy.txt'], startedAt: now, updatedAt: now});
  // A kind that IS present but is not 'tell-peer' is a different shape: refused.
  putPeer('sess-w3-wrongkind', {version: 1, kind: 'something-else', pid: process.pid, sessionId: 'sess-w3-wrongkind', name: 'wrong-win', cwd: dir, files: [claimed], startedAt: now, updatedAt: now});
  const peers = tell.listPeers({base});
  const legacy = peers.find(p => p.sessionId === 'sess-w3-legacy');
  assert.ok(legacy, 'the kind-less legacy peer is listed as a live peer');
  assert.equal(legacy.name, 'legacy-win');
  const fk = tell.fileKey(claimed, dir);
  assert.equal(legacy.files.length, 1, 'the bare-string claim is rebuilt as a claim');
  assert.equal(legacy.files[0].key, fk.key);
  assert.equal(legacy.files[0].path, fk.path);
  const reljunk = peers.find(p => p.sessionId === 'sess-w3-reljunk');
  assert.ok(reljunk, 'the relative-claim peer itself is still a live peer');
  assert.deepEqual(reljunk.files, [], 'a bare relative string claims nothing');
  assert.ok(!peers.some(p => p.sessionId === 'sess-w3-wrongkind'), 'a present-but-wrong kind stays refused');
  // …and the rebuilt claim protects the file like a current-format one.
  const conflicts = tell.conflictsFor(claimed, 'sess-w3-other', {base, cwd: dir});
  assert.equal(conflicts.length, 1, 'exactly the legacy peer conflicts (the junk and wrong-kind records add none)');
  assert.equal(conflicts[0].peer.sessionId, 'sess-w3-legacy');
  assert.equal(conflicts[0].file.key, fk.key);
  assert.deepEqual(tell.conflictsFor(claimed, 'sess-w3-legacy', {base, cwd: dir}), [], 'a peer never conflicts with itself');
});

// ---------- (5) mentions: @-heavy text stays linear ----------

test('w3 io (5): mentions results on small inputs (URLs, mail addresses and code spans are not mentions)', () => {
  assert.deepEqual(mentions('@src/a.js and @README.md please'), ['src/a.js', 'README.md']);
  assert.deepEqual(mentions('see https://example.com/@user/profile and @real.txt'), ['real.txt'], 'an @ inside a URL is part of the link');
  assert.deepEqual(mentions('mail me@example.com about @file.txt'), ['file.txt'], 'an email address is not a mention');
  assert.deepEqual(mentions('run `@inside.js` then check @outside.js'), ['outside.js'], 'code spans are not mentions');
  assert.deepEqual(mentions('@a.txt @a.txt @b.txt'), ['a.txt', 'b.txt'], 'duplicates collapse, order is kept');
});

test('w3 io (5): mentions over @-heavy text finishes well inside a generous time cap', () => {
  const N = 12000;
  const parts = [];
  for (let i = 0; i < N; i++) parts.push('@f' + i + '.txt', 'https://example.com/@u' + i);
  const text = parts.join(' '); // ~500 KB, 24k @ signs, half of them in URLs
  const started = Date.now();
  const got = mentions(text);
  const elapsed = Date.now() - started;
  assert.equal(got.length, N, 'every real mention is found and every URL @ is skipped');
  assert.equal(got[0], 'f0.txt');
  assert.equal(got[N - 1], 'f' + (N - 1) + '.txt');
  // The pre-fix scan re-sliced the whole prefix for every match
  // (quadratic: tens of seconds at this scale). Linear time is a
  // fraction of a second; 5s is a loose cap, not a benchmark.
  assert.ok(elapsed < 5000, 'mentions stayed linear (took ' + elapsed + 'ms for ' + N + ' mentions)');
});
