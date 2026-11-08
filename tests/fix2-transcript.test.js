'use strict';
// Fix phase 2 (agent A28): src/transcript.js, src/update.js, src/core/noise.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sessions = require('../src/sessions');
const {forResume, userText} = require('../src/transcript');
const update = require('../src/update');
const {Transport, Cipher, cat, uint, bytes, MAX_REASSEMBLY_TOTAL_BYTES} = require('../src/core/noise');
function sessionId(t) { const id = 'fix2-' + crypto.randomUUID(); t.after(() => { try { fs.unlinkSync(sessions.transcriptFile(id)); } catch {} }); return id; }
const ev = (seq, role, id, text, at) => ({event_name: role === 'user' ? 'message.user' : 'message.assistant', role, message_id: id, seq, display_text: text, visibility: 'public', payload: {}, ...(at ? {occurred_at_ms: at} : {})});
const turn = (at, user, reply, extra = {}) => ({v: 1, at, user, reply, tools: [], steps: [], sources: [], todos: [], ...extra});
test('fix2 userText: a marker inside embedded project instructions is not the delimiter', () => {
  const s = '[muser: session]\nProject instructions:\n例:\nUser:\nこれは指示内の例\n\nUser:\n本物の依頼';
  assert.equal(userText(s), '本物の依頼');
  assert.equal(userText('[muser: x]\n\nUser:\nfirst\n\nUser:\npasted'), 'first\n\nUser:\npasted');
  assert.equal(userText('[muser: x]\nUser:\nhello'), 'hello');
  assert.equal(userText('[muser: x]\n\nTask:\ndo it'), 'do it');
});
test('fix2 forResume: an attachment-only (empty-text) turn is not duplicated', async t => {
  const id = sessionId(t);
  sessions.appendTurn(id, turn(1, '', '写真ですね', {tools: [{command: 'code.read'}]}));
  sessions.appendTurn(id, turn(2, 'hello', 'hi'));
  const client = {history: async () => ({chat_events: [ev(1, 'user', 'u1', '[image:image/png workspace/a.png]'), ev(2, 'assistant', 'a1', '写真ですね'), ev(3, 'user', 'u2', 'hello'), ev(4, 'assistant', 'a2', 'hi')], has_more: false})};
  const r = await forResume({id, turns: 5}, client);
  assert.equal(r.turns.length, 2, 'no duplicated empty turn');
  assert.equal(r.turns[0].tools.length, 1, 'the richer local record stands in');
  assert.deepEqual(sessions.transcript(id).map(x => x.user), ['', 'hello']);
});
test('fix2 forResume: a short shared prefix alone does not graft a different turn', async t => {
  const id = sessionId(t);
  sessions.appendTurn(id, turn(1, 'このファイルを直してください、そして全テストを実行して結果を表にまとめてください', 'Aの返事'));
  const client = {history: async () => ({chat_events: [ev(1, 'user', 'u1', 'このファイルを直してください'), ev(2, 'assistant', 'a1', '別の返事')], has_more: false})};
  const r = await forResume({id, turns: 3}, client);
  assert.equal(r.turns.length, 2, 'both turns survive');
  assert.ok(r.turns.some(x => x.reply === '別の返事'));
  assert.ok(r.turns.some(x => x.reply === 'Aの返事'));
});
test('fix2 forResume: a partial (page-capped) fetch is shown but not written back', async t => {
  const id = sessionId(t);
  sessions.appendTurn(id, turn(1, 'old-local-turn', 'local reply'));
  const page = {chat_events: [ev(1, 'user', 'u1', 'remote-turn-with-plenty-of-text'), ev(2, 'assistant', 'a1', 'remote reply')], has_more: true};
  const r = await forResume({id, turns: 9}, {history: async () => page});
  assert.ok(r.turns.some(x => x.user === 'remote-turn-with-plenty-of-text'), 'the fetched turns are shown');
  assert.deepEqual(sessions.transcript(id).map(x => x.user), ['old-local-turn'], 'the file was NOT overwritten by the partial merge');
});
test('fix2 forResume: a turn appended by another window during the fetch survives the write-back', async t => {
  const id = sessionId(t);
  sessions.appendTurn(id, turn(1, 'first-turn-text', 'first reply'));
  const client = {history: async () => { sessions.appendTurn(id, turn(2, 'second-window-turn', 'second reply')); return {chat_events: [ev(1, 'user', 'u1', 'first-turn-text', 1), ev(2, 'assistant', 'a1', 'first reply', 1)], has_more: false}; }};
  const r = await forResume({id, turns: 5}, client);
  assert.deepEqual(r.turns.map(x => x.user), ['first-turn-text', 'second-window-turn']);
  assert.deepEqual(sessions.transcript(id).map(x => x.user), ['first-turn-text', 'second-window-turn'], 'the file kept both turns');
});
test('fix2 forResume: merging many long turns with a shared prefix stays fast (exact-match map)', async t => {
  const id = sessionId(t);
  const prefix = '共通の長い指示文です。'.repeat(200);
  const N = 300, events = [];
  for (let i = 0; i < N; i++) { const user = prefix + ' 依頼番号' + i + '番の固有の末尾です'; sessions.appendTurn(id, turn(i + 1, user, 'reply ' + i)); events.push(ev(i * 2 + 1, 'user', 'u' + i, user, i + 1), ev(i * 2 + 2, 'assistant', 'a' + i, 'reply ' + i, i + 1)); }
  const started = Date.now();
  const r = await forResume({id, turns: N + 1}, {history: async () => ({chat_events: events, has_more: false})});
  const elapsed = Date.now() - started;
  assert.equal(r.turns.length, N);
  assert.ok(elapsed < 5000, 'merge took ' + elapsed + 'ms');
});
test('fix2 latest: a registry response without a valid version is a failed check, not "up to date"', async t => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  // Wave 7 spec update: latest() throws a worded error now — the Japanese
  // '返事に版の情報がありませんでした' — instead of the raw English
  // 'npm registry: no version in response' this used to match, because
  // /update prints e.message straight to the user.
  for (const body of [{}, [], {version: ''}, {version: 'not-a-version'}, null]) { global.fetch = async () => ({ok: true, json: async () => body}); await assert.rejects(() => update.latest(), /返事に版の情報がありませんでした/, 'body: ' + JSON.stringify(body)); }
  global.fetch = async () => ({ok: true, json: async () => ({version: '0.3.9'})});
  assert.equal(await update.latest(), '0.3.9');
});
test('fix2 install: a pinned version is verified after install; a mismatch or bad version fails', async () => {
  const ok = await update.install({version: '9.9.9', command: 'echo installing', verifyCommand: 'echo muser-cli@9.9.9'});
  assert.equal(ok.ok, true, ok.output);
  const bad = await update.install({version: '9.9.9', command: 'echo installing', verifyCommand: 'echo muser-cli@9.9.8'});
  assert.equal(bad.ok, false);
  // Wave 6 wording update: update.install / verify messages are worded in
  // Japanese now (was English 'Installed version is v… not the v…' /
  // 'Invalid update version' / 'already running in another muser window').
  assert.match(bad.output, /入った版は v9\.9\.8 で、案内した v9\.9\.9 と違います/);
  const invalid = await update.install({version: '1.2.3; echo pwned', command: 'echo should-not-run'});
  assert.equal(invalid.ok, false);
  assert.match(invalid.output, /更新の版の形式が違います/);
});
test('fix2 install: the registry is pinned in the child environment and the cwd is the home folder', async () => {
  const reg = await update.install({command: 'echo %npm_config_registry%'});
  assert.equal(reg.ok, true, reg.output);
  assert.match(reg.output, /registry\.npmjs\.org/);
  const cwd = await update.install({command: 'cd'});
  assert.equal(cwd.ok, true, cwd.output);
  assert.equal(cwd.output.trim().toLowerCase(), os.homedir().toLowerCase());
});
test('fix2 install: a live other-window lock blocks, a dead holder lock is claimed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-lock-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const lockFile = path.join(dir, 'update.lock');
  fs.writeFileSync(lockFile, 'sometoken:' + process.pid);
  const blocked = await update.install({command: 'echo should-not-run', lockFile});
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /別の muser の窓で更新が実行中です/); // wave 6: Japanese wording (see above)
  fs.writeFileSync(lockFile, 'sometoken:999999');
  const ran = await update.install({command: 'echo lock-claimed', lockFile});
  assert.equal(ran.ok, true, ran.output);
  assert.match(ran.output, /lock-claimed/);
  assert.equal(fs.existsSync(lockFile), false, 'the lock is released afterwards');
});
function chunk(id, index, count, payload) { return cat(uint(1, id), uint(2, index), uint(3, count), bytes(4, payload)); }
test('fix2 noise: a multi-chunk frame reassembles out of order; an identical duplicate is ignored', () => {
  const tr = new Transport(new Cipher(), new Cipher());
  const frame = cat(uint(1, 9n), bytes(4, cat(bytes(1, Buffer.from('hi')), uint(2, 1))));
  const full = bytes(1, frame);
  const p0 = full.subarray(0, 3), p1 = full.subarray(3);
  assert.equal(tr.decode(chunk(42n, 1, 2, p1)), null);
  assert.equal(tr.decode(chunk(42n, 1, 2, p1)), null, 'identical retransmission is ignored');
  const out = tr.decode(chunk(42n, 0, 2, p0));
  assert.equal(out.type, 'body'); assert.equal(out.body.toString(), 'hi'); assert.equal(out.end, true);
  assert.equal(tr.chunks.size, 0);
  tr.destroy();
});
test('fix2 noise: total buffered reassembly bytes are capped, evicting the oldest record', () => {
  const tr = new Transport(new Cipher(), new Cipher());
  const payload = Buffer.alloc(65489, 1);
  const perRecordChunks = 16;
  const records = Math.ceil(MAX_REASSEMBLY_TOTAL_BYTES / (65489 * perRecordChunks)) + 8;
  for (let id = 1; id <= records; id++) for (let i = 0; i < perRecordChunks; i++) tr.decode(chunk(BigInt(id), i, 256, payload));
  let total = 0; for (const v of tr.chunks.values()) total += v.size;
  assert.ok(total <= MAX_REASSEMBLY_TOTAL_BYTES, 'held ' + total + ' bytes, cap is ' + MAX_REASSEMBLY_TOTAL_BYTES);
  assert.equal(tr.chunks.has('1'), false, 'the oldest reassembly was evicted');
  assert.equal(tr.chunks.has(String(records)), true, 'the newest reassembly was kept');
  tr.destroy();
});
