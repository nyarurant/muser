'use strict';
// Fix phase 1 (deep audit TEST-GAP Highs): real regression tests for behaviours
// the audit found unverified — #21 NoiseXX KAT, #23 focus manual legs, #24
// reconnect re-answer, #26 turn-usage missing-value parsing, #27 clipboard API
// contract, #30 transcript turnsFromHistory, #33 crash report redaction.
// Data-folder isolation first (same header as agent.test.js / turn-usage.test.js):
// several modules below resolve the data/home folders when loaded, and a bare
// `node --test tests/fix1-coverage.test.js` must never touch real user data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1-test-home-'));

const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, what, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > timeoutMs) assert.fail('timed out waiting for ' + what); await wait(15); }
};
function tmp(t, p = 'muser-fix1-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

// ---------- #26 turn-usage: empty / capitalised Unavailable / comma numbers ----------

const {parse} = require('../src/turn-usage');

test('#26 parse: an empty value is missing, so a later real key wins', () => {
  const r = parse('x\n[usage] context_tokens= input_tokens=500 response_tokens= output_tokens=7');
  assert.equal(r.usage.inputTokens, 500, 'context_tokens= must not shadow input_tokens');
  assert.equal(r.usage.outputTokens, 7, 'response_tokens= must not shadow output_tokens');
});

test('#26 parse: capitalised Unavailable is missing, in any casing', () => {
  assert.equal(parse('x\n[usage] context_tokens=Unavailable input_tokens=500 response_tokens=3').usage.inputTokens, 500);
  assert.equal(parse('x\n[usage] context_tokens=UNAVAILABLE input_tokens=501 response_tokens=3').usage.inputTokens, 501);
  // Wave 7 spec update: formatUsage words the counts in the UI language
  // （入 / 出 in Japanese), not fixed English 'in / out'.
  assert.equal(parse('x\n[usage] context_tokens=Unavailable response_tokens=Unavailable').usage.formatted, '0 入 / 0 出', 'all-unavailable still reads as 0');
});

test('#26 parse: comma-grouped numbers parse whole, not at the comma', () => {
  const r = parse('x\n[usage] context_tokens=1,000 response_tokens=2,500');
  assert.equal(r.usage.inputTokens, 1000);
  assert.equal(r.usage.outputTokens, 2500);
  assert.equal(r.usage.formatted, '1k 入 / 2.5k 出'); // wave 7: 入 / 出 wording, see above
  assert.equal(parse('x\n[usage] context_tokens="1,000" response_tokens=5').usage.inputTokens, 1000, 'quoted comma numbers too');
  assert.equal(parse('x\n[usage] context_tokens=0,000 input_tokens=700 response_tokens=1').usage.inputTokens, 700, 'a comma zero is still zero and must not shadow');
});

// ---------- #23 focus: manual criteria and the fromUser leg boundary ----------

const {Focus} = require('../src/focus');
const manualPlan = [{text: 'Visible in the headset', kind: 'manual'}];
const mCheck = (status, reason = status) => [{id: 'c1', status, evidence: [], reason}];
function manualAtNeedsInput() {
  const f = new Focus('Check headset'); f.beginRound(); f.plan(manualPlan);
  assert.throws(() => f.checkpoint(mCheck('met')), /user confirmation/, 'the first leg can never meet a manual criterion');
  f.checkpoint(mCheck('unknown', 'Please check the actual headset.'));
  assert.equal(f.endRound().status, 'needs_input');
  return f;
}

test('#23 focus manual: a user-resumed leg CAN checkpoint manual as met and complete', () => {
  const f = manualAtNeedsInput();
  f.resumeLeg('looks good', {fromUser: true}); f.beginRound();
  f.checkpoint(mCheck('met', 'the user confirmed it in the headset'));
  assert.equal(f.criteria[0].status, 'met');
  assert.equal(f.endRound().status, 'complete');
  const g = manualAtNeedsInput();
  g.resumeLeg('looks good'); g.beginRound(); // fromUser defaults to true: a plain resume is a user leg
  g.checkpoint(mCheck('met', 'confirmed'));
  assert.equal(g.endRound().status, 'complete');
});

test('#23 focus manual: an auto-continuation leg (fromUser:false) CANNOT checkpoint manual as met', () => {
  const f = manualAtNeedsInput();
  f.resumeLeg('', {fromUser: false}); f.beginRound();
  assert.throws(() => f.checkpoint(mCheck('met', 'pretending the user confirmed')), /user confirmation/, 'an automatic leg must not fabricate user confirmation (#33 boundary)');
  assert.equal(f.criteria[0].status, 'unknown', 'the refused met did not land');
  f.checkpoint(mCheck('unknown', 'still waiting for the user'));
  assert.equal(f.endRound().status, 'needs_input', 'the task stays parked for a real user message');
});

// ---------- #24 reconnect: a completed invoke re-asked is re-SENT from the record ----------

test('#24 native-device: a completed invoke re-asked after reconnect sends the cached result again, without re-running', async () => {
  const {NativeDevice} = require('../src/core/native-device');
  const invokes = {inflight: new Map(), completed: new Map()};
  let runs = 0;
  const execute = async () => { runs++; await wait(80); return {ok: true, payload: {n: runs}}; };
  const before = new NativeDevice({execute, invokes}), after = new NativeDevice({execute, invokes});
  const beforeSent = [], afterSent = [];
  before._sendResult = async (id, r) => { beforeSent.push([id, r]); return true; };
  after._sendResult = async (id, r) => { afterSent.push([id, r]); return true; };
  before._dispatchInvoke({id: 'inv1', command: 'code.edit', params: {}}); // socket drops mid-run
  after._dispatchInvoke({id: 'inv1', command: 'code.edit', params: {}});  // Muse re-sends it on the new device
  await waitFor(() => invokes.completed.has('inv1') && beforeSent.length === 1, 'the single run to complete and be answered once');
  after._dispatchInvoke({id: 'inv1', command: 'code.edit', params: {}});  // re-asked again, now completed
  await waitFor(() => afterSent.length === 1, 'the after device to re-send the cached result');
  assert.equal(runs, 1, 'the command ran exactly once');
  assert.deepEqual(afterSent, [['inv1', {ok: true, payload: {n: 1}}]], 'the cached result was actually sent on the reconnected device');
  assert.deepEqual(beforeSent, [['inv1', {ok: true, payload: {n: 1}}]]);
});

// ---------- #27 clipboard: the public API contract ----------

const clip = require('../src/clipboard');

test('#27 clipboard toItems: the exact chat-API shape, nothing more, nothing renamed', () => {
  const list = [{name: 'a.png', type: 'image/png', size: 3, data: 'AQID'}, {name: 'b.jpg', type: 'image/jpeg', size: 9, data: 'BAUG'}];
  assert.deepEqual(clip.toItems(list), [
    {type: 'image', mime_type: 'image/png', data_base64: 'AQID', filename: 'a.png'},
    {type: 'image', mime_type: 'image/jpeg', data_base64: 'BAUG', filename: 'b.jpg'},
  ]);
  assert.deepEqual(clip.toItems([]), []);
});

test('#27 clipboard toItems: a real attachment round-trips into an API item', t => {
  const dir = tmp(t), f = path.join(dir, 'shot.png');
  fs.writeFileSync(f, Buffer.from([10, 20, 30, 40]));
  const [item] = clip.toItems([clip.attachment(f)]);
  assert.deepEqual(item, {type: 'image', mime_type: 'image/png', data_base64: Buffer.from([10, 20, 30, 40]).toString('base64'), filename: 'shot.png'});
});

test('#27 clipboard isImage: image extensions only, case-insensitive', () => {
  for (const p of ['a.png', 'a.PNG', 'a.jpg', 'a.JPEG', 'a.gif', 'a.webp', 'a.bmp', 'C:\\x\\y.png']) assert.equal(clip.isImage(p), true, p);
  for (const p of ['a.txt', 'a.svg', 'a.png.txt', 'noextension', 'a.']) assert.equal(clip.isImage(p), false, p);
});

test('#27 clipboard pastedImagePaths: quoted / absolute / existing image paths only', t => {
  const dir = tmp(t);
  const png = path.join(dir, 'one.png'); fs.writeFileSync(png, 'x');
  const jpg = path.join(dir, 'two.jpg'); fs.writeFileSync(jpg, 'x');
  const txt = path.join(dir, 'notes.txt'); fs.writeFileSync(txt, 'x');
  const spaced = path.join(dir, 'my pics'); fs.mkdirSync(spaced);
  const spacedPng = path.join(spaced, 's p.png'); fs.writeFileSync(spacedPng, 'x');
  assert.deepEqual(clip.pastedImagePaths(png), [png], 'a bare absolute path');
  assert.deepEqual(clip.pastedImagePaths('"' + png + '"'), [png], 'double quotes are stripped');
  assert.deepEqual(clip.pastedImagePaths("'" + png + "'"), [png], 'single quotes are stripped');
  assert.deepEqual(clip.pastedImagePaths('"' + png + '" "' + jpg + '"'), [png, jpg], 'several quoted paths');
  assert.deepEqual(clip.pastedImagePaths('"' + spacedPng + '"'), [spacedPng], 'a quoted path containing spaces');
  assert.equal(clip.pastedImagePaths('one.png'), null, 'a relative path is not a drop');
  assert.equal(clip.pastedImagePaths(path.join(dir, 'missing.png')), null, 'a path that does not exist');
  assert.equal(clip.pastedImagePaths(txt), null, 'an existing non-image file');
  assert.equal(clip.pastedImagePaths(png + ' ' + txt), null, 'one non-image spoils the whole paste');
  assert.equal(clip.pastedImagePaths('just some words'), null, 'plain text');
  assert.equal(clip.pastedImagePaths(''), null, 'empty');
});

test('#27 clipboard clipboardText: resolves a string and never rejects', async () => {
  const v = await clip.clipboardText(); // whatever this PC's clipboard holds, the contract is the shape
  assert.equal(typeof v, 'string');
  assert.equal(typeof await clip.clipboardText(), 'string');
});

// ---------- #30 transcript turnsFromHistory ----------

const {turnsFromHistory} = require('../src/transcript');
const ev = (seq, role, id, text) => ({event_name: role === 'user' ? 'message.user' : 'message.assistant', role, message_id: id, seq, display_text: text, visibility: 'public', payload: {}});

test('#30 turnsFromHistory: synthetic continuation prefixes make no turns; their replies ride the real turn', () => {
  const turns = turnsFromHistory([
    ev(1, 'user', 'u1', 'real question'), ev(2, 'assistant', 'a1', 'first answer'),
    ev(3, 'user', 'u2', '[muser: automatic continuation]\nkeep going'), ev(4, 'assistant', 'a2', 'continuation answer'),
    ev(5, 'user', 'u3', '[muser: automatic /goal continuation]\ngoal leg'),
    ev(6, 'user', 'u4', '[muser Focus task: the goal]\nleg'), ev(7, 'assistant', 'a3', 'final answer'),
  ]);
  assert.equal(turns.length, 1, 'no ghost turns from muser-sent bodies');
  assert.equal(turns[0].user, 'real question');
  assert.equal(turns[0].reply, 'final answer', 'the reply is the last assistant message of the whole turn');
});

test('#30 turnsFromHistory: a user message with no reply yet merges into the next turn, not a new one', () => {
  const turns = turnsFromHistory([
    ev(1, 'user', 'u1', 'part one'), ev(2, 'user', 'u2', 'part two'), ev(3, 'assistant', 'a1', 'the answer'),
    ev(4, 'user', 'u3', 'next question'), ev(5, 'user', 'u4', 'an addendum'), ev(6, 'assistant', 'a2', 'next answer'),
  ]);
  assert.deepEqual(turns.map(x => [x.user, x.reply]), [
    ['part one\n\npart two', 'the answer'],
    ['next question\n\nan addendum', 'next answer'],
  ]);
});

test('#30 turnsFromHistory: duplicate message_ids are deduped, the later copy wins', () => {
  const turns = turnsFromHistory([
    ev(1, 'user', 'u1', 'hello'), ev(2, 'user', 'u1', 'hello'), // a retransmitted user event
    ev(3, 'assistant', 'a1', 'draft'), ev(4, 'assistant', 'a1', 'final'), // same id, updated copy
    ev(5, 'user', 'u2', 'next'), ev(6, 'assistant', 'a2', 'done'),
  ]);
  assert.deepEqual(turns.map(x => [x.user, x.reply]), [['hello', 'final'], ['next', 'done']]);
});

test('#30 turnsFromHistory: events are sorted by seq, whatever order the pages arrived in', () => {
  const turns = turnsFromHistory([
    ev(5, 'assistant', 'a2', 'done'), ev(4, 'user', 'u2', 'next'),
    ev(2, 'assistant', 'a1', 'hi!'), ev(1, 'user', 'u1', 'hello'), ev(3, 'assistant', 'a1b', 'hi again'),
  ]);
  assert.deepEqual(turns.map(x => [x.user, x.reply]), [['hello', 'hi again'], ['next', 'done']]);
});

// ---------- #21 NoiseXX known-answer vectors ----------
// The responder below is an INDEPENDENT minimal Noise XX implementation written
// from the protocol shape with node:crypto primitives only: it shares no code
// with src/core/noise, so a transcript (prologue / mix order) mistake in src
// cannot cancel out the way the fixes-1101g loopback could. Fixed responder
// keys and pinned hex vectors make it a known-answer test, not a round-trip.

const {NoiseXX, Cipher} = require('../src/core/noise');
const EMPTY = Buffer.alloc(0);
const cat = (...p) => Buffer.concat(p);
const sha256 = b => crypto.createHash('sha256').update(b).digest();
const hmac256 = (k, b) => crypto.createHmac('sha256', k).update(b).digest();
const hkdf2 = (k, input) => { const t = hmac256(k, input), a = hmac256(t, Buffer.from([1])); return [a, hmac256(t, cat(a, Buffer.from([2])))]; };
const rawPub = key => key.export({type: 'spki', format: 'der'}).subarray(-32);
const privFromSeed = hex => crypto.createPrivateKey({key: cat(Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(hex, 'hex')), format: 'der', type: 'pkcs8'});
const pubOf = priv => rawPub(crypto.createPublicKey(priv));
const xdh = (priv, raw) => crypto.diffieHellman({privateKey: priv, publicKey: crypto.createPublicKey({key: cat(Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(raw)), format: 'der', type: 'spki'})});

test('#21 noise KAT: pinned cipher vector and pinned initial hash chain', () => {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const ct = new Cipher(Buffer.from(key)).encrypt(Buffer.from('kat-ad'), Buffer.from('hello noise'));
  assert.equal(ct.toString('hex'), '66d9d9b2da0cedd261dbccfb3fd8fdcd0ec96a781c00aac0add748', 'AES-256-GCM, nonce = 4 zero bytes + BE64 counter starting at 0, tag appended');
  const probe = new NoiseXX();
  const h0 = Buffer.alloc(32); h0.write('Noise_XX_25519_AESGCM_SHA256');
  assert.deepEqual(Buffer.from(probe.ck), h0, 'ck starts as the protocol name padded to 32 bytes');
  assert.equal(Buffer.from(probe.h).toString('hex'), '5df72b67b965add1168f0a6c756df21c204f7e64fc682be6a3ab4b682c8db64b', 'h after the empty prologue mix: sha256(h0 || empty), computed independently and pinned');
});

class IndieResponder {
  constructor(ephSeed, staticSeed) {
    this.h = Buffer.alloc(32); this.h.write('Noise_XX_25519_AESGCM_SHA256');
    this.ck = Buffer.from(this.h); this.mixHash(EMPTY);
    this.key = null; this.n = 0n;
    this.eph = privFromSeed(ephSeed); this.stat = privFromSeed(staticSeed);
  }
  mixHash(b) { this.h = sha256(cat(this.h, b)); }
  mixKey(b) { const [ck, key] = hkdf2(this.ck, b); this.ck = ck; this.key = key; this.n = 0n; }
  nonce() { const b = Buffer.alloc(12); b.writeBigUInt64BE(this.n++, 4); return b; }
  encrypt(data) {
    if (!this.key) { this.mixHash(data); return data; }
    const c = crypto.createCipheriv('aes-256-gcm', this.key, this.nonce()); c.setAAD(this.h);
    const out = cat(c.update(data), c.final(), c.getAuthTag()); this.mixHash(out); return out;
  }
  decrypt(data) {
    if (!this.key) { this.mixHash(data); return Buffer.from(data); }
    const c = crypto.createDecipheriv('aes-256-gcm', this.key, this.nonce()); c.setAAD(this.h);
    c.setAuthTag(data.subarray(-16)); const out = cat(c.update(data.subarray(0, -16)), c.final()); this.mixHash(data); return out;
  }
  transport(key) {
    let n = 0n; const nonce = () => { const b = Buffer.alloc(12); b.writeBigUInt64BE(n++, 4); return b; };
    return {
      encrypt: pt => { const c = crypto.createCipheriv('aes-256-gcm', key, nonce()); c.setAAD(EMPTY); return cat(c.update(pt), c.final(), c.getAuthTag()); },
      decrypt: ct => { const c = crypto.createDecipheriv('aes-256-gcm', key, nonce()); c.setAAD(EMPTY); c.setAuthTag(ct.subarray(-16)); return cat(c.update(ct.subarray(0, -16)), c.final()); },
    };
  }
}

test('#21 noise KAT: src initiator completes XX against an independent responder with fixed keys', () => {
  const initiator = new NoiseXX();
  const msg1 = initiator.message1();
  const resp = new IndieResponder('11'.repeat(32), '22'.repeat(32));
  const ephI = Buffer.from(msg1.subarray(0, 32));
  resp.mixHash(ephI);
  const p1 = resp.decrypt(msg1.subarray(32));
  assert.equal(p1.length, 34, 'msg1 payload is a protobuf bytes field');
  assert.deepEqual([p1[0], p1[1]], [10, 32], 'field 1, wire type 2, 32 bytes of payload');
  const pubR = pubOf(resp.eph);
  resp.mixHash(pubR);
  resp.mixKey(xdh(resp.eph, ephI));
  const encStatic = resp.encrypt(pubOf(resp.stat));
  assert.equal(encStatic.length, 48, 'an encrypted static key is 32 bytes + a 16-byte tag');
  resp.mixKey(xdh(resp.stat, ephI));
  const payload2 = Buffer.from('kat payload two');
  const msg2 = cat(pubR, encStatic, resp.encrypt(payload2));
  const got2 = initiator.message2(msg2);
  assert.deepEqual(Buffer.from(got2), payload2, 'the initiator decrypted the independently built message 2');
  assert.deepEqual(Buffer.from(initiator.remoteStatic), pubOf(resp.stat), 'the initiator recovered the fixed responder static key');
  const payload3 = Buffer.from('kat payload three');
  const keys = initiator.message3(payload3);
  const staticI = resp.decrypt(keys.message.subarray(0, 48));
  resp.mixKey(xdh(resp.eph, staticI));
  assert.deepEqual(resp.decrypt(keys.message.subarray(48)), payload3, 'the independent responder decrypted message 3');
  const [k1, k2] = hkdf2(resp.ck, EMPTY); // initiator tx = k1, rx = k2; the responder mirrors them
  const rTx = resp.transport(k2), rRx = resp.transport(k1);
  assert.equal(rRx.decrypt(keys.tx.encrypt(EMPTY, Buffer.from('ping from initiator'))).toString(), 'ping from initiator', 'transport key split agrees with the independent HKDF');
  assert.equal(keys.rx.decrypt(EMPTY, rTx.encrypt(Buffer.from('pong from responder'))).toString(), 'pong from responder');
});

// ---------- #33 crash: error / trail content never reaches the report ----------

const crash = require('../src/crash');
function crashDir(t) {
  const dir = tmp(t, 'muser-fix1-crash-');
  process.env.MUSER_CRASH_DIR = dir;
  t.after(() => { delete process.env.MUSER_CRASH_DIR; });
  return dir;
}

test('#33 crash: secrets in the error stack, the error message and a trail payload stay out of the report', t => {
  crashDir(t);
  const err = new Error('backend failed for "hunter2-quoted" with token=hunter2-param\nsecond line carries hunter2-line2');
  err.stack = 'Error: backend failed\n    at run (C:\\secret\\x.js:1:1) while handling hunter2-stack';
  const file = crash.write({version: '9.9.9', error: err,
    trail: [[1, 'text,pos'], [2, 'agents'], [3, 'user typed hunter2-trail here']],
    state: {busy: true, text: 'hunter2-state', entries: [{type: 'md', rows: ['hunter2-state']}]}});
  const raw = fs.readFileSync(file, 'utf8'), r = JSON.parse(raw);
  assert.ok(!raw.includes('hunter2'), 'no secret from any of the four carriers appears in the report');
  assert.match(r.error, /backend failed/, 'the error is still identifiable');
  assert.deepEqual(r.trail, [[1, 'text,pos'], [2, 'agents'], [3, '<redacted>']], 'real key-name trail entries survive; a content-bearing one is stripped to its slot');
  assert.equal(r.state.textLength, 'hunter2-state'.length, 'state is still shape-only');
});

test('#33 crash: version fields are present and a benign error keeps its first line', t => {
  crashDir(t);
  // Wave 5 changed the TERM spec (reason for the updated assertion below):
  // the report records TERM as its KIND only ('xterm'), never the raw value
  // ('xterm-256color'), because TERM is operator-controlled text — see
  // termKind in src/crash.js. Pin a raw value here so the kind mapping is
  // what the assertion actually checks.
  const savedTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => { if (savedTerm === undefined) delete process.env.TERM; else process.env.TERM = savedTerm; });
  const file = crash.write({version: '9.9.9', error: new TypeError('kaboom happened'), trail: [], state: {}});
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(r.muser, '9.9.9');
  assert.equal(r.node, process.version, 'the node version field');
  assert.equal(r.windows, os.release(), 'the windows (OS release) field');
  assert.equal(typeof r.terminal, 'object');
  assert.equal(r.terminal.TERM, 'xterm', 'the terminal TERM field holds the kind only (wave 5: TERM is recorded as kind only, never its raw value)');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('xterm-256color'), 'the raw TERM value appears nowhere in the report');
  assert.equal(typeof r.terminal.windowsTerminal, 'boolean');
  assert.equal(typeof r.terminal.vscode, 'boolean');
  assert.equal(r.error, 'TypeError: kaboom happened', 'error type plus first line, no stack');
  const plain = crash.write({version: '9.9.9', error: new Error('Maximum update depth exceeded'), trail: [], state: {}});
  assert.match(JSON.parse(fs.readFileSync(plain, 'utf8')).error, /Maximum update depth/);
  const strErr = crash.write({version: '9.9.9', error: 'plain failure\nat fake (hunter2-string-line2)', trail: [], state: {}});
  const sr = JSON.parse(fs.readFileSync(strErr, 'utf8'));
  assert.equal(sr.error, 'plain failure', 'a string error keeps only its first line too');
});
