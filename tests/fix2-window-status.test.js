'use strict';
// Fix phase 2 (deep audit c28 + fifth audit f3-3): window-status prune/write,
// secure-store save cache verification, turn-usage parse boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ws = require('../src/window-status');
const tu = require('../src/turn-usage');
const store = require('../src/secure-store');

const T = Date.parse('2026-11-04T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-a30-'));
const winFile = (folder, pid, updatedAt) => {
  const f = path.join(folder, pid + '.json');
  fs.writeFileSync(f, JSON.stringify({version: 1, kind: 'window', pid, startedAt: iso(T - 60000), updatedAt: iso(updatedAt)}));
  return f;
};

// ---------- window-status: prune (c28 #1 / deep #234, fifth f3-3) ----------

test('prune: a file that cannot be read is left alone (a lock is not a dead window)', () => {
  const folder = tmp();
  const locked = winFile(folder, 4242, T - 1000);
  const broken = path.join(folder, '5555.json'); fs.writeFileSync(broken, '{broken');
  const readFile = f => { if (f === locked) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return fs.readFileSync(f, 'utf8'); };
  ws.prune({folder, isAlive: () => true, now: T, readFile});
  assert.ok(fs.existsSync(locked), 'the unreadable live window file survives');
  assert.ok(!fs.existsSync(broken), 'a readable but unparseable file is still pruned');
});

test('prune: a file rewritten between judgement and delete is left alone', () => {
  const folder = tmp();
  const f = winFile(folder, 4242, T - 5 * 60000); // dead pid, stale: judged prunable
  let calls = 0;
  const readFile = () => { calls++; return calls === 1 ? fs.readFileSync(f, 'utf8') : JSON.stringify({version: 1, kind: 'window', pid: 4242, startedAt: iso(T), updatedAt: iso(T)}); };
  ws.prune({folder, isAlive: () => false, now: T, readFile});
  assert.ok(fs.existsSync(f), 'content changed on re-read: the owner heartbeated, no delete');
});

test('prune: a clock step does not delete a live window; a long silence or a dead pid does', () => {
  const folder2 = tmp();
  const a = winFile(folder2, 4242, T);
  ws.prune({folder: folder2, isAlive: () => true, now: T + 31000});
  assert.ok(fs.existsSync(a), 'f3-3: live pid, heartbeat 31 s old after a clock step: kept');
  ws.prune({folder: folder2, isAlive: () => true, now: T + 300001});
  assert.ok(!fs.existsSync(a), 'live pid but silent past the prune grace (10x stale): pruned');
  const folder3 = tmp();
  const b = winFile(folder3, 4242, T);
  ws.prune({folder: folder3, isAlive: () => false, now: T + 1000});
  assert.ok(!fs.existsSync(b), 'dead pid: pruned even with a fresh heartbeat (pid reuse guard is for readers)');
});

// ---------- window-status: write() never breaks the window (c28 #2 / deep #235) ----------

test('write: a throwing ctrl.get() returns false instead of throwing', () => {
  const folder = tmp();
  const w = new ws.WindowStatus({ctrl: {get() { throw new Error('getter boom'); }}, agent: {}, file: path.join(folder, 'x.json')});
  assert.equal(w.write(), false);
});

test('write: a snapshot failure (non-finite startedAt) returns false instead of throwing', () => {
  const folder = tmp();
  const w = new ws.WindowStatus({ctrl: {get: () => ({})}, agent: {}, file: path.join(folder, 'x.json')});
  w.startedAt = Infinity; // iso() -> new Date(Infinity).toISOString() throws RangeError
  assert.equal(w.write(), false);
});

test('write: a healthy state still writes a parseable window file', () => {
  const folder = tmp();
  const file = path.join(folder, 'x.json');
  const w = new ws.WindowStatus({ctrl: {get: () => ({})}, agent: {}, file});
  assert.equal(w.write(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).kind, 'window');
});

// ---------- secure-store: preload alignment (c28 #5, phase 1 H14 — already fixed, pinned) ----------

test('secure-store preload: an empty slot stays positional and later files keep their own plaintext', () => {
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const todo = [{name: 'web.enc'}, {name: 'device.enc'}, {name: 'session.enc'}];
  const lines = store.parsePreloadOutput('!\n' + b64('{"who":"device"}') + '\n' + b64('{"who":"session"}') + '\n', 3);
  const dec = store.decodePreload(todo, lines);
  assert.equal(dec.has('web.enc'), false);
  assert.equal(dec.get('device.enc'), '{"who":"device"}');
  assert.equal(dec.get('session.enc'), '{"who":"session"}');
});

// ---------- secure-store: save() cache verification (c28 #6 / deep #236) ----------

test('secure-store save: a competing rename landing after ours is not cached over', () => {
  const name = 'fix2-a30-race.enc';
  const target = store.file(name);
  store.save(name, {who: 'B'});
  const encB = fs.readFileSync(target); // B's ciphertext, replayed as the competing write
  const origRename = fs.renameSync;
  fs.renameSync = (from, to) => { const r = origRename(from, to); if (to === target) fs.writeFileSync(to, encB); return r; };
  try { store.save(name, {who: 'A'}); } finally { fs.renameSync = origRename; }
  try {
    assert.deepEqual(store.load(name), {who: 'B'}, 'load serves the value actually on disk, not the stale cached A');
  } finally { store.remove(name); }
});

test('secure-store save/load: an ordinary roundtrip still works and caches', () => {
  const name = 'fix2-a30-roundtrip.enc';
  try {
    store.save(name, {v: 42});
    assert.deepEqual(store.load(name), {v: 42});
    store.save(name, {v: 43});
    assert.deepEqual(store.load(name), {v: 43});
  } finally { store.remove(name); }
});

// ---------- turn-usage: trailing newline (c28 #9 / deep #238) ----------

test('turn-usage: a trailing newline or CRLF does not hide the usage line', () => {
  const r = tu.parse('done\n\n[usage] context_tokens=130841 response_tokens=395 source=provider\n');
  assert.ok(r); assert.equal(r.usage.inputTokens, 130841); assert.equal(r.usage.outputTokens, 395);
  assert.equal(r.body.trim(), 'done');
  assert.equal(tu.strip('done\n[usage] context_tokens=5 response_tokens=6\r\n'), 'done');
  assert.equal(tu.strip('done\n[usage] context_tokens=5 response_tokens=6\n\n'), 'done');
  assert.equal(tu.parse('x\n[usage] context_tokens=5 response_tokens=6\nmore reply after it'), null, 'text after the line still disqualifies it');
});

// ---------- turn-usage: no token keys, no fabricated usage (c28 #11 / deep #240) ----------

test('turn-usage: a [usage] line with no token keys is reply content, not 0 / 0 usage', () => {
  assert.equal(tu.parse('answer\n[usage] is explained in the docs'), null);
  assert.equal(tu.strip('answer\n[usage] is explained in the docs'), 'answer\n[usage] is explained in the docs');
  const allUnavail = tu.parse('x\n[usage] context_tokens=unavailable response_tokens=unavailable');
  assert.ok(allUnavail, 'keys present but unavailable still counts as a usage line');
  assert.equal(allUnavail.usage.formatted, '0 in / 0 out');
  const found = tu.usageFromTranscript({messages: [
    {role: 'assistant', content: [{text: 'real\n\n[usage] context_tokens=2000 response_tokens=50'}]},
    {role: 'assistant', content: [{text: 'later reply\n[usage] is a feature of the gateway'}]},
  ]});
  assert.equal(found.usage.inputTokens, 2000, 'a later content [usage] line does not overwrite real usage with 0 / 0');
});

// ---------- turn-usage: role-less messages are not the assistant (c28 #12 / deep #241) ----------

test('turn-usage: usageFromTranscript ignores role-less and user messages', () => {
  const found = tu.usageFromTranscript({messages: [
    {role: 'assistant', content: [{text: 'real\n\n[usage] context_tokens=2000 response_tokens=50'}]},
    {content: [{text: 'quoted by the user\n[usage] context_tokens=999999 response_tokens=999'}]},
    {role: 'user', content: [{text: 'also quoted\n[usage] context_tokens=888888 response_tokens=888'}]},
  ]});
  assert.equal(found.usage.inputTokens, 2000);
  assert.equal(tu.usageFromTranscript({messages: [{content: [{text: 'x\n[usage] context_tokens=5 response_tokens=6'}]}]}), null);
});

// ---------- turn-usage: shadowing variants (c28 #10 / deep #239 — already fixed in phase 1, pinned) ----------

test('turn-usage: empty / Unavailable / unknown / 00 estimates and comma counts do not shadow the real value', () => {
  for (const bad of ['', 'Unavailable', 'unknown', '00']) {
    const r = tu.parse('x\n[usage] context_tokens_estimate=' + bad + ' context_tokens=130841 response_tokens=3');
    assert.equal(r.usage.inputTokens, 130841, 'estimate=' + JSON.stringify(bad));
  }
  assert.equal(tu.parse('x\n[usage] context_tokens=130,841 response_tokens=3').usage.inputTokens, 130841);
});
