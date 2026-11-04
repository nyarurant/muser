'use strict';
// Fix phase 1 (deep audit TEST-GAP Highs), part 2: #28 agent preamble contents,
// #31 pc-login OTP/2FA retry caps, #32 spawn-cap reset through the real turn
// paths. Same data-folder isolation header as agent.test.js: this file loads
// src/agent and src/pc-login (secure-store), and a bare `node --test` run must
// never touch the user's real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1b-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix1b-test-home-'));

function tmp(t, p = 'muser-fix1b-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; }

// ---------- #28 preamble: the project instructions actually ride along ----------

const {preamble, MAX_PROJECT_INSTRUCTION_CHARS} = require('../src/agent');
const NOTE = '（プロジェクト指示が長いため一部省略しました）';

test('#28 preamble: instruction bodies from AGENTS.md / CLAUDE.md / MUSE.md appear in the preamble', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'FIX1-ALPHA: always frobnicate the widget before shipping.\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'FIX1-BETA: never touch the frobnicate lever on Fridays.\n');
  fs.writeFileSync(path.join(dir, 'MUSE.md'), 'FIX1-GAMMA: keep the changelog in the past tense.\n');
  const text = preamble(dir, []);
  for (const [file, body] of [['AGENTS.md', 'FIX1-ALPHA: always frobnicate the widget before shipping.'], ['CLAUDE.md', 'FIX1-BETA: never touch the frobnicate lever on Fridays.'], ['MUSE.md', 'FIX1-GAMMA: keep the changelog in the past tense.']]) {
    assert.ok(text.includes('Project instructions from ' + path.join(dir, file) + ':'), file + ' is headed');
    assert.ok(text.includes(body), file + ' body text itself is in the preamble, not just its name');
  }
});

test('#28 preamble: oversized instructions are capped in the preamble, with the note, nearest file whole', t => {
  const dir = tmp(t), empty = tmp(t);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'X'.repeat(9000));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Y'.repeat(9000));
  fs.writeFileSync(path.join(dir, 'MUSE.md'), 'Z'.repeat(9000));
  const text = preamble(dir, []);
  const base = preamble(empty, []).length; // the fixed preamble with no instructions at all
  assert.ok(text.includes('X'.repeat(4000)), 'the first instruction body is carried');
  assert.ok(text.includes('Y'.repeat(4000)), 'the second instruction body is carried');
  assert.ok(text.includes('Z'.repeat(4000)), 'the third body is carried at least in part');
  assert.ok(!text.includes('Z'.repeat(9000)), 'the furthest body does not ride whole past the cap');
  assert.ok(text.includes(NOTE), 'the truncation is said out loud');
  assert.ok(text.length - base <= MAX_PROJECT_INSTRUCTION_CHARS + 1000, 'instruction content in the preamble stays within the cap (plus file headers): ' + (text.length - base));
});

// ---------- #31 pc-login: OTP / 2FA retry caps, and resend costing no tries ----------

const {pcLogin} = require('../src/pc-login');
let fileSeq = 0;
const nextFile = () => 'fix1-pc-flow-' + (++fileSeq) + '/device.enc';
function loginWeb(over = {}) {
  const counts = {send_otp: 0, confirm_otp: 0, two_factor_codes: 0};
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route, body) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) { counts.send_otp++; return {auth_state: 'as'}; }
      if (route.endsWith('/confirm_otp')) { counts.confirm_otp++; if (over.confirm) return over.confirm(body, counts.confirm_otp); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/select_account')) return {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/two_factor/send_code')) return {};
      if (route.endsWith('/two_factor')) { counts.two_factor_codes++; if (over.twoFactor) return over.twoFactor(body, counts.two_factor_codes); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
      if (route.endsWith('/fetch_vms')) return {vm_list: []};
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  return {web, counts};
}
function loginUi(answers) {
  const asked = [];
  const ui = {note: () => {}, info: () => {}, close() {},
    confirm: async () => true, pick: async () => 0, busy: async (_l, fn) => fn(),
    ask: async q => { asked.push(q); const v = answers.shift(); if (v === undefined) throw new Error('no scripted answer for: ' + q); return v; }};
  return {ui, asked};
}
const wrongCode = () => { throw Object.assign(new Error('wrong code'), {status: 400}); };

test('#31 pc-login: three wrong OTP codes end the login at the cap', async () => {
  const {web, counts} = loginWeb({confirm: wrongCode});
  const answers = ['a@b.c', '000000', '000001', '000002', '999999'];
  const {ui, asked} = loginUi(answers);
  await assert.rejects(pcLogin(web, ui, {file: nextFile()}), /wrong code/);
  assert.equal(counts.confirm_otp, 3, 'exactly three attempts reached the server');
  assert.equal(asked.length, 4, 'contact plus three code prompts — a fourth code was never asked for');
  assert.equal(answers.length, 1, 'the spare answer was never consumed');
});

test('#31 pc-login: resend does not consume tries (resend x2 + wrong x2 + correct succeeds)', async () => {
  const {web, counts} = loginWeb({confirm: (body, n) => { if (n <= 2) wrongCode(); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }});
  const {ui} = loginUi(['a@b.c', 'resend', 'resend', '000000', '000001', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated', 'two resends plus two wrong codes still leave the third try');
  assert.equal(counts.send_otp, 3, 'the initial send plus both resends');
  assert.equal(counts.confirm_otp, 3, 'two wrong codes and the correct one');
});

test('#31 pc-login: three wrong 2FA codes end the login at the cap', async () => {
  const tf = {two_factor_required: true, two_factor_methods: [{method_id: 'm1', method_type: 'SMS', display_name: 'SMS'}], two_factor_state: 'ts'};
  const {web, counts} = loginWeb({confirm: () => tf, twoFactor: () => { throw Object.assign(new Error('wrong 2fa'), {status: 400}); }});
  const {ui} = loginUi(['a@b.c', '111111', '000000', '000001', '000002', '999999']);
  await assert.rejects(pcLogin(web, ui, {file: nextFile()}), /wrong 2fa/);
  assert.equal(counts.two_factor_codes, 3, 'exactly three 2FA attempts reached the server');
});

// ---------- #32 limits: the per-task spawn cap resets through the real turn paths ----------
// agent.js:953 (send) resets spawnedThisTurn once per USER turn; agent.js:981
// (sendFocused) resets it only for a non-continuation call — an automatic
// continuation leg is the same turn continuing and must NOT reset it. Both are
// driven here through send()/sendFocused() themselves with only runTurn
// stubbed (the layer that talks to Muse), never by writing the counter.

const {Agent} = require('../src/agent');
function cappedAgent(t) {
  const cwd = tmp(t);
  const client = new EventEmitter(); client.status = 'connected'; client.ws = {readyState: 1}; client.disconnect = () => {};
  const a = new Agent({client, auth: {saved: {}, vm: async () => { throw new Error('no vm'); }}, cwd,
    session: {id: 'main', cwd, title: '', created: 0, updated: 0, turns: 0}, focusEnabled: false,
    agentLimits: {maxAgents: 0, maxAgentsTotal: 3}}); // no at-a-time limit; per-task cap 3
  t.after(() => { try { a.close(); } catch {} });
  let script = null;
  a.runTurn = async (w) => {
    if (!w.main) { w.turn = {controller: new AbortController()}; return {text: ''}; } // a spawned agent, now running
    const s = script; script = null;
    if (s) s();
    return {text: 'ok', focusDecision: {continue: false}, sources: []};
  };
  return {a, onMainTurn: fn => { script = fn; }};
}
function spawnOutcomes(a, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    try { a.spawn('task'); out.push('ok'); } catch (e) { out.push(/3 つまで/.test(e.message) ? 'cap' : 'other: ' + e.message); }
  }
  return out;
}

test('#32 limits: the spawn cap resets on a new user turn driven through send()', async t => {
  const {a, onMainTurn} = cappedAgent(t);
  onMainTurn(() => assert.deepEqual(spawnOutcomes(a, 4), ['ok', 'ok', 'ok', 'cap'], 'first task: 3 spawns, the 4th refused'));
  await a.send('task one');
  assert.equal(a.spawnedThisTurn, 3);
  onMainTurn(() => assert.deepEqual(spawnOutcomes(a, 4), ['ok', 'ok', 'ok', 'cap'], 'second task: the cap is fresh again — send() reset it, not the test'));
  await a.send('task two');
  assert.equal(a.spawnedThisTurn, 3);
  assert.equal([...a.workers.values()].filter(w => !w.main).length, 6, 'both tasks really spawned their three');
});

test('#32 limits: sendFocused resets for a user call but NOT for an automatic continuation leg', async t => {
  const {a, onMainTurn} = cappedAgent(t);
  onMainTurn(() => assert.deepEqual(spawnOutcomes(a, 2), ['ok', 'ok']));
  await a.sendFocused('focused task');
  assert.equal(a.spawnedThisTurn, 2, 'a direct sendFocused is a user turn: it reset, then spent 2');
  onMainTurn(() => assert.deepEqual(spawnOutcomes(a, 2), ['ok', 'cap'], 'the continuation leg shares the same task budget: one more fits, the next is refused'));
  await a.sendFocused('[muser: automatic continuation]\nkeep going', {continuation: true});
  assert.equal(a.spawnedThisTurn, 3, 'the leg did not reset the counter');
  onMainTurn(() => assert.deepEqual(spawnOutcomes(a, 1), ['ok'], 'a fresh user sendFocused resets again'));
  await a.sendFocused('another task');
  assert.equal(a.spawnedThisTurn, 1);
});
