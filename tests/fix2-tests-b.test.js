'use strict';
// Fix phase 2, agent A34 (tests-b): the "missing test" Medium findings of the
// t7/t8 test audits. Each test names the finding it closes. Nothing here edits
// product code; where the product itself is wrong (t7 #19 handoff surrogate
// split) the evidence lives in audit2/fix2/repro-A34-handoff.cjs instead of a
// red test in the suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2b-'));
  t.after(() => { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} });
  return d;
}
function env(t, key, value) {
  const prev = process.env[key];
  process.env[key] = value;
  t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
}

test('t7 #2: usageFromTranscript — the LAST assistant usage wins; user and role-less messages never count', () => {
  const {usageFromTranscript} = require('../src/turn-usage');
  const line = (i, o) => 'reply\n\n[usage] context_tokens=' + i + ' response_tokens=' + o + ' source=provider';
  const tr = {messages: [
    {role: 'assistant', content: [{type: 'text', text: line(111, 11)}]},
    {role: 'user', content: line(999, 99)},
    {role: 'assistant', content: line(222, 22)},
    {content: line(333, 33)},
  ]};
  const u = usageFromTranscript(tr);
  assert.equal(u.usage.inputTokens, 222, 'the second assistant message wins over the first');
  assert.equal(u.usage.outputTokens, 22);
  assert.equal(usageFromTranscript({messages: []}), null);
  assert.equal(usageFromTranscript(null), null);
  assert.equal(usageFromTranscript({messages: [{role: 'user', content: line(5, 5)}]}), null, 'a user message alone has no usage');
});

test('t7 #3: usage aggregation — lastHour and allTime windows, accumulation onto an existing store, yesterday stays out of today', t => {
  const dir = tmp(t);
  const file = path.join(dir, 'usage.json');
  env(t, 'MUSER_USAGE_FILE', file);
  const usage = require('../src/usage');
  const today = usage.dayKey();
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yesterday = usage.dayKey(yd);
  // An existing store from a previous run: string counts (cleaned on load),
  // yesterday's real tokens, a current minute bucket, and running totals.
  fs.writeFileSync(file, JSON.stringify({version: 1,
    days: {
      [today]: {turns: '2', toolCalls: 1, inChars: 40, outChars: 8, realInTokens: '100', realOutTokens: 40},
      [yesterday]: {turns: 5, toolCalls: 0, inChars: 0, outChars: 0, realInTokens: 1000, realOutTokens: 500},
    },
    minutes: {[usage.minuteKey()]: {realInTokens: 7, realOutTokens: 3}},
    totals: {realInTokens: 5000, realOutTokens: 2000}, updatedAt: null}));
  const day = usage.record({turns: 1, usage: {inputTokens: 50, outputTokens: 5}});
  assert.equal(day.turns, 3, 'the stored string count was cleaned to a number and accumulated');
  assert.equal(day.realInTokens, 150);
  const s = usage.summary();
  assert.equal(s.today.realInTokens, 150, 'today counts only today');
  assert.equal(s.today.realOutTokens, 45);
  assert.equal(s.lastHour.realInTokens, 57, 'the seeded minute bucket plus the new record');
  assert.equal(s.lastHour.realOutTokens, 8);
  assert.equal(s.last7.realInTokens, 1150, 'last 7 days = today + yesterday');
  assert.equal(s.last7.realOutTokens, 545);
  assert.equal(s.allTime.realInTokens, 5050, 'all time accumulates onto the stored totals');
  assert.equal(s.allTime.realOutTokens, 2005);
});

test('t8 #16: usage retention — a day exactly 31 days old is kept, 32 days old is pruned on record', t => {
  const dir = tmp(t);
  env(t, 'MUSER_USAGE_FILE', path.join(dir, 'usage.json'));
  const usage = require('../src/usage');
  const keyAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return usage.dayKey(d); };
  const blank = {turns: 1, toolCalls: 0, inChars: 0, outChars: 0};
  fs.writeFileSync(process.env.MUSER_USAGE_FILE, JSON.stringify({version: 1,
    days: {[keyAgo(31)]: blank, [keyAgo(32)]: blank}, minutes: {}, totals: {realInTokens: 0, realOutTokens: 0}, updatedAt: null}));
  usage.record({turns: 1});
  const store = usage.load();
  assert.ok(store.days[keyAgo(31)], 'the day at the cutoff is kept');
  assert.equal(store.days[keyAgo(32)], undefined, 'the day past the cutoff is pruned');
  assert.ok(store.days[usage.dayKey()], 'today was recorded');
});

test('t7 #7/#8: clipboard.attachment — jpg/jpeg/bmp types, exact bytes as data, size, the 10 MB boundary, temporary cleanup', t => {
  const clip = require('../src/clipboard');
  const dir = tmp(t);
  const bytes = Buffer.from([0x89, 0x50, 1, 2, 3, 250]);
  for (const [name, type] of [['a.jpg', 'image/jpeg'], ['b.jpeg', 'image/jpeg'], ['c.bmp', 'image/bmp'], ['d.png', 'image/png']]) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, bytes);
    const att = clip.attachment(f, false);
    assert.equal(att.type, type, name + ' maps to ' + type);
    assert.equal(att.name, name);
    assert.equal(att.size, bytes.length, 'size is the byte length');
    assert.equal(att.data, bytes.toString('base64'), 'data is the base64 of the exact bytes');
    assert.deepEqual(Buffer.from(att.data, 'base64'), bytes);
  }
  const MAX = 10 * 1024 * 1024;
  const exact = path.join(dir, 'exact.png');
  fs.writeFileSync(exact, Buffer.alloc(MAX, 7));
  assert.equal(clip.attachment(exact, false).size, MAX, 'a file of exactly 10 MB is accepted');
  const over = path.join(dir, 'over.png');
  fs.writeFileSync(over, Buffer.alloc(MAX + 1, 7));
  assert.throws(() => clip.attachment(over, false), /10 MB/, 'one byte over the cap is refused');
  const capOk = path.join(dir, 'capture.png');
  fs.writeFileSync(capOk, bytes);
  const att2 = clip.attachment(capOk, true);
  assert.equal(att2.name, 'clipboard.png', 'a temporary capture is renamed');
  assert.equal(fs.existsSync(capOk), false, 'a converted temporary file is deleted');
  const capBig = path.join(dir, 'capture-big.png');
  fs.writeFileSync(capBig, Buffer.alloc(MAX + 1, 7));
  assert.throws(() => clip.attachment(capBig, true), /10 MB/);
  assert.equal(fs.existsSync(capBig), false, 'an oversized temporary file is deleted, not left behind');
  assert.deepEqual(clip.toItems([att2]), [{type: 'image', mime_type: 'image/png', data_base64: att2.data, filename: 'clipboard.png'}]);
});

test('t7 #25: transcript.forResume — a complete local transcript is returned without any history fetch', async t => {
  const sessions = require('../src/sessions');
  const {forResume} = require('../src/transcript');
  const id = 'test-' + crypto.randomUUID();
  t.after(() => { try { fs.unlinkSync(sessions.transcriptFile(id)); } catch {} });
  sessions.appendTurn(id, {user: 'a', reply: 'A'});
  sessions.appendTurn(id, {user: 'b', reply: 'B'});
  let calls = 0;
  const client = {history: async () => { calls++; return {chat_events: []}; }};
  const r = await forResume({id, turns: 2}, client);
  assert.equal(r.from, 'local');
  assert.equal(calls, 0, 'no history request when the local transcript covers the session');
  assert.deepEqual(r.turns.map(x => x.user), ['a', 'b']);
  const r2 = await forResume({id, turns: 2}, null);
  assert.equal(r2.from, 'local', 'no client at all takes the same path');
});

test('t7 #21: update.install — success, failure, invalid version, cross-window lock, and the in-process guard', async t => {
  const {install} = require('../src/update');
  const {spawnSync} = require('node:child_process');
  const dir = tmp(t);
  const lockFile = path.join(dir, 'update.lock');
  const ok = await install({command: 'echo hello-update', lockFile});
  assert.equal(ok.ok, true, ok.output);
  assert.match(ok.output, /hello-update/);
  assert.equal(fs.existsSync(lockFile), false, 'the lock is released after a finished install');
  const bad = await install({command: 'exit 3', lockFile});
  assert.equal(bad.ok, false, 'a non-zero exit is a failed install');
  const inv = await install({command: 'echo x', version: 'not-a-version', lockFile});
  assert.equal(inv.ok, false);
  // Wave 6 wording update: update.install messages are worded in Japanese now
  // (was English 'Invalid update version' / 'already running in another window').
  assert.match(inv.output, /更新の版の形式が違います/);
  // Another window holding the lock (a live pid in token:pid form) blocks us.
  fs.writeFileSync(lockFile, 'cafe:' + process.pid);
  const blocked = await install({command: 'echo x', lockFile});
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /別の muser の窓で更新が実行中です/);
  fs.unlinkSync(lockFile);
  // A dead holder's lock is claimed instead of blocking for ever.
  const dead = spawnSync(process.execPath, ['-e', '']);
  fs.writeFileSync(lockFile, 'beef:' + dead.pid);
  const claimed = await install({command: 'echo claimed', lockFile});
  assert.equal(claimed.ok, true, claimed.output);
  // In-process concurrency: a second install while one runs is refused at once.
  const slow = install({command: 'ping -n 6 127.0.0.1 > nul', timeoutMs: 30000, lockFile});
  const second = await install({command: 'echo x', lockFile});
  assert.equal(second.ok, false);
  assert.match(second.output, /更新はすでに実行中です/); // wave 6: Japanese wording (was 'already running')
  const first = await slow;
  assert.equal(first.ok, true, first.output);
});

// Last on purpose: the timeout path can leave the module's stuck guard set if
// the killed child does not exit promptly, and nothing after this test may
// depend on install() being usable again in this process.
test('t7 #21: update.install — a command that never finishes is stopped at timeoutMs', async t => {
  const {install} = require('../src/update');
  const dir = tmp(t);
  const r = await install({command: 'ping -n 31 127.0.0.1 > nul', timeoutMs: 500, lockFile: path.join(dir, 'update.lock')});
  assert.equal(r.ok, false);
  assert.match(r.output, /npm が 1 秒で終わらなかったので止めました/); // wave 6: Japanese wording (was 'did not finish')
});
