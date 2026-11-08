'use strict';
// Fix phase 2, agent A20: c17 Medium items for src/skills.js / src/pc-login.js /
// src/login.js / src/core/chat-model.js, first-audit #34/#35/#36 (pc-login part),
// fourth-audit M22/M23/M25 (wording in these files). M27 is DEFERRED (see rows-A20).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------- skills ----------
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-login-'));
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const saved = {USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME};
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  const put = (dir, name, md) => { const d = path.join(dir, name); fs.mkdirSync(d, {recursive: true}); fs.writeFileSync(path.join(d, 'SKILL.md'), md); };
  return {home, proj, put};
}

test('fix2 skills #1: the preamble names skipped skills and why (collision + too-large)', t => {
  const {proj, put} = sandbox(t);
  const skills = require('../src/skills');
  const dir = path.join(proj, '.muser', 'skills');
  put(dir, 'Foo Bar', '---\nname: Foo Bar\ndescription: spaced\n---\n');
  put(dir, 'foo-bar', '---\nname: foo-bar\ndescription: dashed\n---\n');
  put(dir, 'huge', '---\nname: huge\ndescription: big\n---\n' + 'x'.repeat(256 * 1024));
  const pre = skills.preambleLines(proj).join('\n');
  assert.match(pre, /\(skipped\) foo-bar: another skill with the same name was kept/);
  assert.match(pre, /\(skipped\) huge: SKILL\.md is over the/);
});

test('fix2 skills #2: skill.read finds a skill by its frontmatter name, not only the normalised key', t => {
  const {proj, put} = sandbox(t);
  const skills = require('../src/skills');
  put(path.join(proj, '.muser', 'skills'), 'Foo Bar', '---\nname: Foo Bar\ndescription: spaced\n---\nDo it.\n');
  assert.equal(skills.read(proj, {name: 'Foo Bar'}).content.includes('Do it.'), true);
  assert.equal(skills.read(proj, {name: 'foo-bar'}).name, 'foo-bar');
});

test('fix2 skills #3: an unreadable SKILL.md is diagnosed and skill.read says so', t => {
  const {proj} = sandbox(t);
  const skills = require('../src/skills');
  const d = path.join(proj, '.muser', 'skills', 'broken');
  fs.mkdirSync(path.join(d, 'SKILL.md'), {recursive: true}); // a directory: readFileSync throws
  assert.deepEqual(skills.load(proj), []);
  assert.ok(skills.diagnostics().some(x => x.reason === 'read-error' && x.name === 'broken'));
  assert.throws(() => skills.read(proj, {name: 'broken'}), /could not be read/);
});

test('fix2 skills #4: frontmatter handles comments, plain continuations, block indicators and escapes', () => {
  const {frontmatter} = require('../src/skills');
  const fm = frontmatter('---\nname: foo # memo\ndescription: plain first\n  second line\nblock: |-2\n  kept\nesc: "a\\nb\\t\\"q\\""\nsq: \'it\'\'s\'\n---\nbody');
  assert.equal(fm.meta.name, 'foo');
  assert.equal(fm.meta.description, 'plain first second line');
  assert.equal(fm.meta.block, 'kept');
  assert.equal(fm.meta.esc, 'a\nb\t"q"');
  assert.equal(fm.meta.sq, "it's");
});

test('fix2 skills #5: a repo-source skill folder linked outside its source is refused and diagnosed', t => {
  const {home, proj} = sandbox(t);
  const skills = require('../src/skills');
  const outside = path.join(home, 'outside-skill');
  fs.mkdirSync(outside, {recursive: true});
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked\ndescription: outside\n---\n');
  const srcDir = path.join(proj, '.claude', 'skills');
  fs.mkdirSync(srcDir, {recursive: true});
  try { fs.symlinkSync(outside, path.join(srcDir, 'linked'), 'junction'); } catch { t.skip('symlinks unavailable'); return; }
  assert.deepEqual(skills.load(proj).map(s => s.name), []);
  assert.ok(skills.diagnostics().some(x => x.reason === 'linked-folder' && x.name === 'linked'));
});

// ---------- chat-model ----------
test('fix2 chat-model #21: a [usage]-only assistant event is not a reply; a real reply survives', () => {
  const {messageFromEvent} = require('../src/core/chat-model');
  const usage = '[usage] context_tokens=10 response_tokens=2 source=provider';
  assert.equal(messageFromEvent({message_id: 'b', role: 'assistant', display_text: usage}), null);
  const real = messageFromEvent({message_id: 'a', role: 'assistant', display_text: 'answer\n\n' + usage});
  assert.equal(real.content.trim(), 'answer');
  assert.equal(messageFromEvent({message_id: 'c', role: 'assistant', display_text: 'plain'}).content, 'plain');
});

test('fix2 chat-model #19: a marker-shaped string typed inline or in code stays text; a lone-line marker is an attachment', () => {
  const {messageFromEvent} = require('../src/core/chat-model');
  const q = messageFromEvent({message_id: 'q', role: 'user', display_text: 'この形式 [image:image/png example.png] って何？'});
  assert.ok(q.content.includes('[image:image/png example.png]'), 'inline quoted marker kept as text');
  assert.deepEqual(q.attachments, []);
  const fenced = messageFromEvent({message_id: 'f', role: 'user', display_text: 'ログ:\n```\n[image:image/png example.png]\n```'});
  assert.deepEqual(fenced.attachments, [], 'a marker inside a fence is a quote');
  const real = messageFromEvent({message_id: 'r', role: 'user', display_text: '見て\n[image:image/png workspace/pic.png]'});
  assert.deepEqual(real.attachments, [{kind: 'image', mime: 'image/png', path: 'workspace/pic.png'}]);
  assert.equal(real.content, '見て');
});

test('fix2 chat-model #20: content as an array of text-part objects is joined, not dropped', () => {
  const {messageFromEvent} = require('../src/core/chat-model');
  const m = messageFromEvent({message_id: 'p', role: 'assistant', payload: {content: [{type: 'text', text: 'Hel'}, {text: 'lo'}]}});
  assert.equal(m.content, 'Hello');
  assert.equal(messageFromEvent({message_id: 's', role: 'user', display_text: ['x']}), null, 'a bare string array is not the parts shape (pinned by chat-model.test.js)');
});

// ---------- pc-login ----------
const {pcLogin} = require('../src/pc-login');
let fileSeq = 0;
const nextFile = () => 'fix2-login-' + (++fileSeq) + '/device.enc';
function loginWeb(over = {}) {
  const counts = {send_otp: 0, select: 0, send_code: 0};
  const web = {
    sdkRequest: async method => method === 'GET' ? {tokens: [], maxActiveTokens: 2} : {token: 'mgst_test', sdkToken: {id: 'id1'}},
    nativeRequest: async (scope, route, body) => {
      if (route.endsWith('/auth/start')) return {access_token: 'at'};
      if (route.endsWith('/login_options')) return {};
      if (route.endsWith('/send_otp')) { counts.send_otp++; if (over.sendOtp) return over.sendOtp(counts.send_otp); return {auth_state: 'as'}; }
      if (route.endsWith('/confirm_otp')) return over.confirm ? over.confirm(body) : {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/select_account')) { counts.select++; if (over.select) return over.select(counts.select); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }
      if (route.endsWith('/two_factor/send_code')) { counts.send_code++; if (over.sendCode) return over.sendCode(counts.send_code); return {}; }
      if (route.endsWith('/two_factor')) return over.twoFactor ? over.twoFactor(body) : {abra_access_token: 'abra', abra_user_id: 'u1'};
      if (route.endsWith('/device_token/mint')) return {access_token: 'dat', refresh_token: 'drt'};
      if (route.endsWith('/fetch_vms')) return {vm_list: []};
      throw new Error('unexpected ' + route);
    },
    fetchJson: async () => ({}),
  };
  return {web, counts};
}
function loginUi(answers, over = {}) {
  const infos = [], asks = [];
  const ui = {note: () => {}, info: s => infos.push(s), close() { this.closed = true; },
    confirm: async () => true, pick: over.pick || (async () => 0), busy: async (_l, fn) => fn(),
    ask: async (q, opts = {}) => { asks.push({q, hint: opts.hint}); const v = answers.shift(); if (v === undefined) throw new Error('no scripted answer for: ' + q); return v; }};
  return {ui, infos, asks};
}
const netErr = () => Object.assign(new Error('network down'), {network: true});

test('fix2 pc-login #9+M23: resend is capped at 3, hinted at the prompt, and the login still completes', async () => {
  const {web, counts} = loginWeb();
  const {ui, asks} = loginUi(['a@b.c', 'resend', 'resend', 'resend', 'resend', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(counts.send_otp, 4, 'initial send + 3 resends, the 4th resend is refused');
  assert.ok(asks.some(a => /resend/.test(a.hint || '')), 'the code prompt says how to resend');
});

test('fix2 pc-login #9: a failed resend does not kill the login', async () => {
  const {web} = loginWeb({sendOtp: n => { if (n === 2) throw netErr(); return {auth_state: 'as'}; }});
  const {ui} = loginUi(['a@b.c', 'resend', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
});

test('fix2 pc-login #11: transient send failures retry the same contact without re-asking it', async () => {
  const {web, counts} = loginWeb({sendOtp: n => { if (n < 3) throw netErr(); return {auth_state: 'as'}; }});
  const {ui, asks} = loginUi(['a@b.c', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(counts.send_otp, 3);
  assert.equal(asks.filter(a => a.q.includes('メールアドレス')).length, 1, 'the contact was asked once');
});

test('fix2 pc-login #10: a transient select failure is retried, keeping the OTP stage', async () => {
  const acct = {account_selection_required: true, accounts: [{account_ref: 'r1', display_name: 'A'}], selection_state: 'ss'};
  const {web, counts} = loginWeb({confirm: () => acct, select: n => { if (n === 1) throw Object.assign(new Error('boom'), {status: 500}); return {abra_access_token: 'abra', abra_user_id: 'u1'}; }});
  const {ui} = loginUi(['a@b.c', '111111']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(counts.select, 2);
});

test('fix2 pc-login #10: a transient two-factor preparation failure is retried', async () => {
  const tf = {two_factor_required: true, two_factor_methods: [{method_id: 'm1', method_type: 'SMS', display_name: 'SMS'}], two_factor_state: 'ts'};
  const {web, counts} = loginWeb({confirm: () => tf, sendCode: n => { if (n === 1) throw netErr(); return {}; }});
  const {ui} = loginUi(['a@b.c', '111111', '999999']);
  const auth = await pcLogin(web, ui, {file: nextFile()});
  assert.equal(auth.snapshot().phase, 'authenticated');
  assert.equal(counts.send_code, 2);
});

test('fix2 pc-login M25: what an SDK token is is explained before consent is asked', async () => {
  const {web} = loginWeb();
  const {ui, infos} = loginUi(['a@b.c', '111111']);
  await pcLogin(web, ui, {file: nextFile()});
  assert.ok(infos.some(s => s.includes('SDK トークン') && s.includes('鍵')), 'a definition line was shown');
});

test('fix2 pc-login #12: when creating the auth object throws, the default UI path still closes', async () => {
  // A corrupt saved device file makes PcAuth's load() throw inside createAuth.
  const store = require('../src/secure-store');
  const file = nextFile();
  const p = store.file(file); fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, 'not an encrypted store');
  const {web} = loginWeb();
  const {ui} = loginUi([]);
  await assert.rejects(pcLogin(web, ui, {file}));
  assert.equal(ui.closed, true, 'ui.close ran even though createAuth threw');
});

// ---------- login (Edge) ----------
const web = require('../src/web');
function stubWeb(t, fetchJson) {
  const saved = {createWeb: web.createWeb, probe: web.probe, jarFromCookies: web.jarFromCookies, saveJar: web.saveJar};
  web.jarFromCookies = cs => ({cookies: cs});
  web.createWeb = () => ({fetchJson});
  web.probe = async () => 'error'; web.saveJar = () => {};
  t.after(() => Object.assign(web, saved));
}
const fakeBrowser = () => ({contexts: () => [{cookies: async () => [{domain: '.muse.ai', name: 's', value: '1'}]}], on: () => {}, isConnected: () => true});

test('fix2 login #34: pollLogin treats parse/429/5xx session errors as error, not waiting', async t => {
  const {pollLogin} = require('../src/login');
  for (const err of [{parse: true}, {status: 429}, {status: 500}]) {
    stubWeb(t, async () => { throw Object.assign(new Error('bad'), err); });
    const logs = [];
    await assert.rejects(pollLogin(fakeBrowser(), {log: s => logs.push(s), timeoutMs: 250, intervalMs: 40}), /時間切れ/);
    assert.ok(logs.some(l => l.includes('確認中')), 'error stage was logged for ' + JSON.stringify(err));
  }
  stubWeb(t, async () => { throw Object.assign(new Error('nope'), {status: 400}); });
  const logs = [];
  await assert.rejects(pollLogin(fakeBrowser(), {log: s => logs.push(s), timeoutMs: 250, intervalMs: 40}), /時間切れ/);
  assert.ok(!logs.some(l => l.includes('確認中')), 'a plain 4xx stays the waiting stage');
});

test('master-debug #3: pollLogin stops at once when the caller aborts, not at the timeout', async () => {
  const {pollLogin} = require('../src/login');
  const ac = new AbortController();
  const browser = {contexts: () => [{cookies: async () => []}], on: () => {}, isConnected: () => true};
  const t0 = Date.now();
  const p = pollLogin(browser, {timeoutMs: 60000, intervalMs: 2000, signal: ac.signal});
  setTimeout(() => ac.abort(), 120);
  await assert.rejects(p, e => e && e.reasonKind === 'cancelled');
  assert.ok(Date.now() - t0 < 5000, 'the poll stopped promptly after the abort');
});

test('master-debug #17: pollLogin names its failure reasons (window-closed / poll-timeout)', async () => {
  const {pollLogin} = require('../src/login');
  const closed = {contexts: () => [], on: () => {}, isConnected: () => false};
  await assert.rejects(pollLogin(closed, {timeoutMs: 1000, intervalMs: 40}), e => e && e.reasonKind === 'window-closed');
  const waiting = {contexts: () => [{cookies: async () => []}], on: () => {}, isConnected: () => true};
  await assert.rejects(pollLogin(waiting, {timeoutMs: 150, intervalMs: 40}), e => e && e.reasonKind === 'poll-timeout');
});

test('fix2 login #35: logout removes the Edge browser profile as well as the jars', t => {
  const {logout, PROFILE} = require('../src/login');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-logout-')), 'browser');
  fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, 'Cookies'), 'x');
  t.after(() => fs.rmSync(path.dirname(dir), {recursive: true, force: true}));
  assert.equal(logout({web: 'fix2-x/web.enc', session: 'fix2-x/session.enc', browser: dir}), undefined);
  assert.ok(!fs.existsSync(dir), 'profile folder gone');
  fs.mkdirSync(PROFILE, {recursive: true}); fs.writeFileSync(path.join(PROFILE, 'Cookies'), 'x');
  logout();
  assert.ok(!fs.existsSync(PROFILE), 'default profile gone');
});

test('fix2 login #15: the per-profile login lock excludes a second login and ignores a stale owner', t => {
  const {acquireLoginLock} = require('../src/login');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-lock-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const profile = path.join(dir, 'browser');
  const lock = acquireLoginLock(profile);
  assert.throws(() => acquireLoginLock(profile), /既に開いています/);
  fs.unlinkSync(lock);
  fs.writeFileSync(profile + '.login.lock', '999999'); // a pid that cannot be alive
  const lock2 = acquireLoginLock(profile);
  fs.unlinkSync(lock2);
});

test('fix2 login #16: a live leftover Edge port is detected for reuse; a dead one is not', async t => {
  const http = require('node:http');
  const {liveLeftoverPort} = require('../src/login');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-port-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const srv = http.createServer((req, res) => res.end('{}'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), String(srv.address().port) + '\n/devtools/browser/x');
  assert.equal(await liveLeftoverPort(dir), srv.address().port);
  await new Promise(r => srv.close(r));
  assert.equal(await liveLeftoverPort(dir), 0, 'the port no longer answers');
});

test('fix2 login #17: a per-user (%LOCALAPPDATA%) Edge install is among the candidates', () => {
  const {EDGE} = require('../src/login');
  assert.ok(EDGE.some(p => p.startsWith(process.env.LOCALAPPDATA)), 'LOCALAPPDATA candidate present: ' + EDGE.join(' | '));
});
