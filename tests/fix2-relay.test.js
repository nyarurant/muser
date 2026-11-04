'use strict';
// Fix phase 2, agent A21: c18 Mediums for src/relay.js, src/clipboard.js,
// src/session.js and src/ui/demo.mjs (plus first-audit #14, see the relay note).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {Relay} = require('../src/relay');
const clip = require('../src/clipboard');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function tmp(t, prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

// Open a raw client socket to a relay and collect everything it sends back.
async function rawClient(t, pipe) {
  const sock = net.connect(pipe);
  sock.setEncoding('utf8');
  let out = '';
  sock.on('data', d => { out += d; });
  await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
  t.after(() => { try { sock.destroy(); } catch {} });
  return {sock, out: () => out};
}
const invokeLine = id => JSON.stringify({type: 'invoke', command: 'code.read', params: {}, timeoutMs: 1000, id}) + '\n';

// c18 #6 (a): two request lines arriving in ONE chunk — the second used to be
// discarded silently (buf was cleared). One request per connection: only the
// first may run, and exactly one reply comes back.
test('fix2 relay #6a: two lines in one chunk run only the first request', async t => {
  const dir = tmp(t, 'muser-f2-relay-');
  let runs = 0;
  const r = new Relay({dir, takes: () => true, run: async () => { runs++; await sleep(30); return {ok: true, n: runs}; }}).start();
  t.after(() => r.stop());
  await sleep(100);
  const c = await rawClient(t, r.pipe);
  c.sock.write(invokeLine('1') + invokeLine('2'));
  await sleep(500);
  assert.equal(runs, 1, 'the second pipelined request must not run');
  assert.equal(c.out().trim().split('\n').filter(Boolean).length, 1, 'exactly one reply');
  assert.match(c.out(), /"n":1/);
});

// c18 #6 (b): a second line arriving in a LATER chunk, while the first invoke is
// still running (e.g. waiting on an approval), used to run in parallel; both
// then raced to end the socket and one result was lost.
test('fix2 relay #6b: a second line while the first invoke runs does not run in parallel', async t => {
  const dir = tmp(t, 'muser-f2-relay-');
  let runs = 0;
  const r = new Relay({dir, takes: () => true, run: async () => { runs++; await sleep(700); return {ok: true, n: runs}; }}).start();
  t.after(() => r.stop());
  await sleep(100);
  const c = await rawClient(t, r.pipe);
  c.sock.write(invokeLine('1'));
  await sleep(150);
  c.sock.write(invokeLine('2'));
  await sleep(1200);
  assert.equal(runs, 1, 'the second request must not run alongside the first');
  assert.equal(c.out().trim().split('\n').filter(Boolean).length, 1, 'exactly one reply');
  assert.match(c.out(), /"n":1/);
});

// c18 #15: a gateway-pins.json whose content is valid JSON but not an object
// (null / array / string) must read as "no pins" — null used to make checkPin
// throw a TypeError on every connect, and a string polluted the rewritten file
// with numeric keys.
test('fix2 session #15: a non-object gateway-pins.json does not crash or pollute checkPin', t => {
  const pinsPath = path.join(process.env.LOCALAPPDATA, 'muser', 'gateway-pins.json');
  fs.mkdirSync(path.dirname(pinsPath), {recursive: true});
  const had = fs.existsSync(pinsPath) ? fs.readFileSync(pinsPath) : null;
  t.after(() => { try { had ? fs.writeFileSync(pinsPath, had) : fs.rmSync(pinsPath, {force: true}); } catch {} });
  const {createChat} = require('../src/session');
  for (const content of ['null', '[]', '"str"', '42']) {
    fs.writeFileSync(pinsPath, content);
    const client = createChat({fetchJson: async () => {}});
    assert.doesNotThrow(() => client.checkPin('gw1', 'fp1'), 'pins=' + content);
    assert.deepEqual(JSON.parse(fs.readFileSync(pinsPath, 'utf8')), {gw1: 'fp1'}, 'pins=' + content + ' rewrites as a clean object');
  }
  // A normal pins object still round-trips (the fix must not eat real pins).
  fs.writeFileSync(pinsPath, JSON.stringify({other: 'keep'}));
  const client = createChat({fetchJson: async () => {}});
  client.checkPin('gw1', 'fp1');
  assert.deepEqual(JSON.parse(fs.readFileSync(pinsPath, 'utf8')), {other: 'keep', gw1: 'fp1'});
});

// c18 #10: pastedImagePaths must never stat a UNC path — existsSync on
// \\server\share\... opens an SMB connection to a host named by untrusted
// pasted text (TUI stall, possible NTLM leak). The stub makes every path
// "exist", so only the UNC guard can reject these.
test('fix2 clipboard #10: a pasted UNC image path is never probed and never accepted', t => {
  const seen = [];
  const orig = fs.existsSync;
  fs.existsSync = p => { seen.push(String(p)); return true; };
  t.after(() => { fs.existsSync = orig; });
  assert.equal(clip.pastedImagePaths('\\\\attacker.example\\share\\a.png'), null);
  assert.equal(clip.pastedImagePaths('//attacker.example/share/a.png'), null);
  assert.deepEqual(seen, [], 'no filesystem probe of a network path at all');
  // A local absolute image path is still accepted when it exists.
  const local = 'C:\\Users\\someone\\pic.png';
  assert.deepEqual(clip.pastedImagePaths(local), [local]);
  assert.deepEqual(seen, [local]);
});

// c18 #11: the text read gets the same timeout as the image read, and the
// detailed form distinguishes "could not read" from "no text" while the
// plain clipboardText() string contract (pinned in phase 1) stays intact.
test('fix2 clipboard #11: clipboard text read is not the 5 s weak path any more', async () => {
  assert.equal(clip.TEXT_TIMEOUT_MS, 10000, 'aligned with clipboardImages()');
  const detailed = await clip.clipboardTextDetailed();
  assert.equal(typeof detailed.text, 'string');
  assert.equal(detailed.error, null, 'this PC can read its clipboard');
  assert.equal(typeof await clip.clipboardText(), 'string', 'string contract kept');
});

// c18 demo #1: declining an approval must stop the scripted success story —
// no completed todos, no "tests passed" reply.
test('fix2 demo #1: declining the edit ends the demo turn without the success story', async () => {
  const {DemoAgent} = await import('../src/ui/demo.mjs');
  const a = new DemoAgent(process.cwd());
  a.approver = async () => ({allow: false});
  const todosSeen = [];
  let turnEnd = null;
  a.on('todos', td => todosSeen.push(td.map(x => x.status)));
  a.on('turn-end', te => { turnEnd = te; });
  const res = await a.send();
  assert.doesNotMatch(res.text, /テストも通りました/, 'must not claim the tests passed');
  const last = todosSeen[todosSeen.length - 1];
  assert.ok(!last.includes('in_progress'), 'no todo left spinning');
  assert.notEqual(last[1], 'completed', 'the declined fix is not marked done');
  assert.notEqual(last[2], 'completed', 'the never-run test step is not marked done');
  assert.equal(turnEnd.ok, true);
});

// c18 demo #1 (second half): the edit is approved but the test run is declined —
// the reply still must not claim the tests passed.
test('fix2 demo #1b: declining the test run keeps the success claim out of the reply', async () => {
  const {DemoAgent} = await import('../src/ui/demo.mjs');
  const a = new DemoAgent(process.cwd());
  let calls = 0;
  a.approver = async () => ({allow: ++calls === 1}); // approve edit, decline system.run
  const res = await a.send();
  assert.doesNotMatch(res.text, /テストも通りました/);
});

// c18 demo #2: an interrupt during the tool sequence must abort the turn
// before the next approval dialog opens.
test('fix2 demo #2: interrupting during the tools aborts before any approval opens', async () => {
  const {DemoAgent} = await import('../src/ui/demo.mjs');
  const a = new DemoAgent(process.cwd());
  let approvals = 0;
  a.approver = async () => { approvals++; return {allow: true}; };
  let started = false;
  a.on('tool-start', () => { started = true; });
  const p = a.send();
  while (!started) await sleep(20);
  await a.interrupt();
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.equal(approvals, 0, 'no approval dialog after the interrupt');
});
