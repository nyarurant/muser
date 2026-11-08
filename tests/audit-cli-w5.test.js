'use strict';
// audit-cli wave 5 (secrets / security) regression tests for the wave-5 fixes:
//  (1) tools: app.env / .kube/config.yaml / terraform.tfstate / kubeconfig /
//      wallet.dat are blocked by isSensitivePath; .env.example stays readable.
//  (2) exec-status: a prompt / tool result carrying a secret shape never
//      lands in the status file raw.
//  (3) focus-log: why / decision / intent drop secret shapes.
//  (4) crash: safeErrorText drops Bearer / JWT / ghp_ values; the recorded
//      terminal.TERM is the terminal KIND only, never the raw value.
//  (5) export: space-form secrets and JSON-inside-a-string are redacted.
//  (6) mcp: redact() covers vault values even under an ordinary key name.
//  (7) policy: a remembered git log key does not cover --ext-diff; a
//      remembered findstr still asks when it reads a secret; git.bat has a
//      different alwaysKey from git.
//  (8) tell: drainInbox cuts a body over 2000 chars and says so (truncated +
//      originalLength), and delivers at most 5 per minute, leaving the rest.
//  (9) lore: a shared-origin note is marked as shared / unverified in
//      attachText.
//  (10) agent-types: an override with no tools line inherits the original
//      type's tools instead of widening to all tools.
//  (11) skills: a project-sourced skill's preamble line carries (project).
// Isolation follows tests/setup.mjs; this file ALSO pins its own temp
// HOME / LOCALAPPDATA before requiring any src module (like
// tests/audit-cli-w4.test.js), because src/mcp.js and src/secure-store.js
// resolve their files at require time. All canaries are fake W5* values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NL = String.fromCharCode(10);
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w5-test-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-w5-test-home-'));

const {TOOLS, isSensitivePath} = require('../src/tools');
const {ExecStatus} = require('../src/exec-status');
const focusLog = require('../src/focus-log');
const crash = require('../src/crash');
const exporter = require('../src/export');
const mcp = require('../src/mcp');
const policy = require('../src/policy');
const tell = require('../src/tell');
const lore = require('../src/lore');
const agentTypes = require('../src/agent-types');
const skills = require('../src/skills');

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3AAA';
const GHP = 'ghp_1234567890abcdefghijklmnopqrstuv';
const SK = 'sk-1234567890abcdefghijklmnopqrstuv';

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'muser-w5-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function pinHome(t, home) {
  const savedU = process.env.USERPROFILE, savedH = process.env.HOME;
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { process.env.USERPROFILE = savedU; process.env.HOME = savedH; });
}
function captureErrors(fn) {
  const lines = [], orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { return fn(); } finally { console.error = orig; }
}

// ---------- (1) tools: sensitive paths ----------

test('w5 tools (1): app.env / .kube / tfstate / kubeconfig / wallet.dat are sensitive', () => {
  for (const p of ['app.env', 'prod.env', 'docker.env',
    path.join('proj', '.kube', 'config.yaml'), path.join('.kube', 'config'),
    'terraform.tfstate', 'terraform.tfvars', path.join('state', 'terraform.tfstate.backup'),
    'kubeconfig', 'kubeconfig.yaml', path.join('proj', 'kubeconfig'),
    'wallet.dat', path.join('wallets', 'wallet.dat')])
    assert.equal(isSensitivePath(p), true, p);
});

test('w5 tools (1): .env.example and ordinary files stay readable (isSensitivePath false)', () => {
  for (const p of ['.env.example', '.env.sample', 'app.env.md', 'kubeconfig_tool.js', path.join('src', 'index.js')])
    assert.equal(isSensitivePath(p), false, p);
});

test('w5 tools (1): code.read refuses app.env / wallet.dat but reads .env.example', (t) => {
  const cwd = tmpdir(t);
  const ctx = {cwd, readFiles: new Set()};
  fs.writeFileSync(path.join(cwd, 'app.env'), 'SECRET=1' + NL);
  fs.writeFileSync(path.join(cwd, 'wallet.dat'), 'wallet' + NL);
  fs.writeFileSync(path.join(cwd, '.env.example'), 'EXAMPLE=1' + NL);
  assert.throws(() => TOOLS['code.read'].run({path: 'app.env'}, ctx), /sensitive|機密/);
  assert.throws(() => TOOLS['code.read'].run({path: 'wallet.dat'}, ctx), /sensitive|機密/);
  const ok = TOOLS['code.read'].run({path: '.env.example'}, ctx);
  assert.ok(ok.payload.content.includes('EXAMPLE=1'), 'the example env file reads normally');
});

// ---------- (2) exec-status ----------

test('w5 exec-status (2): secret shapes in the prompt / tool results / reply never reach the file', (t) => {
  const file = path.join(tmpdir(t), 'status.json');
  const pass = 'W5ExecPass12345';
  const bearer = 'W5BearerToken1234567890';
  const replyTok = 'W5ReplyToken1234567';
  const s = new ExecStatus({file, prompt: 'please fix it password=' + pass + ' ' + GHP, cwd: 'C:/w', mode: 'default'});
  s.write();
  s.tool({command: 'code.read', summary: 'saw ' + JWT + ' and ' + SK, ok: true});
  s.log('Authorization: Bearer ' + bearer);
  s.finish({exit: 0, ok: true, reply: 'done token ' + replyTok});
  const raw = fs.readFileSync(file, 'utf8');
  for (const secret of [pass, GHP, JWT, SK, bearer, replyTok])
    assert.ok(!raw.includes(secret), 'leaked into the status file: ' + secret.slice(0, 10));
  assert.ok(raw.includes('[redacted]'), 'the redaction marker is what remains');
  assert.ok(raw.includes('please fix it'), 'the benign prompt wording stays');
  const v = JSON.parse(raw);
  assert.equal(v.state, 'done');
  assert.equal(v.tools, 1);
});

// ---------- (3) focus-log ----------

test('w5 focus-log (3): why / decision / intent drop secret shapes before they are stored', (t) => {
  const dir = tmpdir(t);
  const log = new focusLog.FocusLog({sessionId: 'w5sess', dir});
  const whyPass = 'W5FocusWhyPass12345';
  const intentTok = 'W5FocusIntent12345';
  const e = log.append('checkpoint', {
    decision: 'stop because ' + JWT,
    why: 'password ' + whyPass + ' and ' + GHP,
    intent: 'Authorization: Bearer ' + intentTok,
  });
  assert.ok(e, 'the entry was recorded');
  assert.ok(!e.why.includes(whyPass) && !e.why.includes(GHP), 'why is scrubbed');
  assert.ok(!e.decision.includes(JWT), 'decision is scrubbed');
  assert.ok(!e.intent.includes(intentTok), 'intent is scrubbed');
  const raw = fs.readFileSync(log.file(), 'utf8');
  for (const secret of [whyPass, GHP, JWT, intentTok]) assert.ok(!raw.includes(secret), 'leaked into the log file: ' + secret.slice(0, 10));
  assert.ok(raw.includes('[redacted]'));
  const clean = focusLog.sanitizeText('x ' + SK + ' y');
  assert.ok(!clean.includes(SK) && clean.includes('[redacted]'), 'sanitizeText drops a bare token shape too');
});

// ---------- (4) crash ----------

test('w5 crash (4): safeErrorText drops Bearer / JWT / ghp_ / labelled values', () => {
  const bearer = 'W5CrashBearer1234567890';
  const pass = 'W5CrashPass12345';
  const out = crash.safeErrorText(new Error('login failed Bearer ' + bearer + ' jwt ' + JWT + ' key ' + GHP + ' password: ' + pass));
  for (const secret of [bearer, JWT, GHP, pass]) assert.ok(!out.includes(secret), 'leaked: ' + secret.slice(0, 10));
  assert.ok(out.includes('<redacted>'), 'values are replaced, not kept');
  assert.ok(out.includes('login failed'), 'the benign wording that identifies the crash stays');
});

test('w5 crash (4): the recorded terminal.TERM is the kind only, never the raw value', (t) => {
  const dir = tmpdir(t, 'muser-w5-crash-');
  const savedTerm = process.env.TERM, savedProg = process.env.TERM_PROGRAM;
  process.env.MUSER_CRASH_DIR = dir;
  process.env.TERM = 'xterm-256color';
  process.env.TERM_PROGRAM = 'W5CustomTermProgram';
  t.after(() => {
    delete process.env.MUSER_CRASH_DIR;
    if (savedTerm === undefined) delete process.env.TERM; else process.env.TERM = savedTerm;
    if (savedProg === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = savedProg;
  });
  const file = crash.write({version: '9.9.9', error: new Error('kaboom'), trail: [], state: {}});
  const raw = fs.readFileSync(file, 'utf8');
  const r = JSON.parse(raw);
  assert.equal(r.terminal.TERM, 'xterm', 'TERM is recorded as its family, not as xterm-256color');
  assert.equal(r.terminal.TERM_PROGRAM, 'other', 'an unrecognised TERM_PROGRAM is just other');
  assert.ok(!raw.includes('xterm-256color'), 'the raw TERM value is nowhere in the report');
  assert.ok(!raw.includes('W5CustomTermProgram'), 'the raw TERM_PROGRAM value is nowhere in the report');
  process.env.TERM = 'W5RawTermValue';
  const file2 = crash.write({version: '9.9.9', error: new Error('kaboom2'), trail: [], state: {}});
  const raw2 = fs.readFileSync(file2, 'utf8');
  assert.equal(JSON.parse(raw2).terminal.TERM, 'other', 'an unrecognised TERM collapses to other');
  assert.ok(!raw2.includes('W5RawTermValue'));
});

// ---------- (5) export ----------

test('w5 export (5): space-form secrets are redacted; prose survives', () => {
  const opts = {username: 'w5nomatchuser', homeDir: path.join('w5', 'nohome')};
  const long = 'W5ExportSpace12345';
  const out1 = exporter.redactString('the password ' + long + ' was used', opts);
  assert.ok(!out1.includes(long), 'a bare label + value loses the value');
  assert.ok(out1.includes('password <redacted>'));
  const out2 = exporter.redactString('secret ZXQ-7', opts);
  assert.ok(!out2.includes('ZXQ-7'), 'a short value with a digit is still a secret in a report that leaves the machine');
  assert.equal(exporter.redactString('token counts are fine', opts), 'token counts are fine', 'a value with neither length nor a digit is prose and stays');
});

test('w5 export (5): JSON inside a string is redacted (double- and single-quoted keys)', () => {
  const opts = {username: 'w5nomatchuser', homeDir: path.join('w5', 'nohome')};
  const v1 = 'W5ExportJson12345';
  const out1 = exporter.redactString('cfg {"password": "' + v1 + '"} end', opts);
  assert.ok(!out1.includes(v1), 'a double-quoted JSON value inside a string is redacted');
  assert.ok(out1.includes('<redacted>'));
  const v2 = 'W5ExportJson67890';
  const out2 = exporter.redactString("cfg {'api_key': '" + v2 + "'} end", opts);
  assert.ok(!out2.includes(v2), 'a single-quoted object value inside a string is redacted');
  const v3 = 'W5ExportJson11111';
  const deep = exporter.redact({note: 'cfg {"token": "' + v3 + '"} end'}, opts);
  assert.ok(!JSON.stringify(deep).includes(v3), 'redact() reaches the same string nested in an object');
});

// ---------- (6) mcp ----------

test('w5 mcp (6): redact() covers vault values under ordinary key names', (t) => {
  fs.mkdirSync(path.dirname(mcp.FILE), {recursive: true});
  t.after(() => fs.rmSync(mcp.FILE, {force: true}));
  const vaultVal = 'W5VaultSecret-Ordinary-98765';
  const keyedVal = 'W5VaultSecret-Keyed-12345';
  mcp.save({mcpServers: {demo: {command: 'node', args: [], enabled: true, env: {CUSTOM_DATA: vaultVal, API_KEY: keyedVal}}}});
  const raw = fs.readFileSync(mcp.FILE, 'utf8');
  assert.ok(!raw.includes(vaultVal) && !raw.includes(keyedVal), 'save() vaults the values; mcp.json holds only $secret refs');
  const loaded = mcp.load();
  assert.equal(loaded.mcpServers.demo.env.CUSTOM_DATA, vaultVal, 'load() resolves the vault value back under its ordinary key');
  const out = mcp.redact('server said: ' + vaultVal + ' / ' + keyedVal);
  assert.ok(!out.includes(vaultVal), 'a vault value under an ordinary key name is redacted from error text');
  assert.ok(!out.includes(keyedVal), 'a vault value under a secret-looking key is redacted too');
  assert.ok(out.includes('***'));
  mcp.save({mcpServers: {demo2: {command: 'node', args: [], enabled: true, env: {CUSTOM_DATA: 'production'}}}});
  assert.equal(mcp.redact('mode production here'), 'mode production here', 'control: a plain config word under an ordinary key is not redacted (audit #234 boundary)');
});

// ---------- (7) policy ----------

test('w5 policy (7): a remembered git log key does not cover --ext-diff / --textconv', (t) => {
  const cwd = tmpdir(t, 'muser-w5-policy-');
  assert.equal(policy.alwaysKey('exec', {command: 'git log --ext-diff'}), null, 'the flagged form itself is never remembered');
  assert.equal(policy.alwaysKey('exec', {command: 'git log --output=out.txt'}), null, 'an output-flag form is never remembered either');
  const always = new Set([policy.alwaysKey('exec', {command: 'git log'})]);
  assert.ok(always.has('exec:git log'), 'the plain form has the expected key');
  const d = command => policy.decide({mode: 'default', kind: 'exec', params: {command}, always, cwd, root: cwd, gitConfig: () => ''});
  assert.equal(d('git log --ext-diff'), 'ask', 'the remembered key does not cover a form that runs an external diff helper');
  assert.equal(d('git log --textconv'), 'ask');
  assert.equal(d('git log'), 'allow', 'control: the remembered plain form still passes');
});

test('w5 policy (7): a remembered findstr still asks when the target is a secret file', (t) => {
  const cwd = tmpdir(t, 'muser-w5-policy-');
  const key = policy.alwaysKey('exec', {command: 'findstr needle notes.txt'});
  assert.equal(key, 'exec:findstr needle', 'the key names only program + first word, so both forms share it');
  const always = new Set([key]);
  const d = command => policy.decide({mode: 'default', kind: 'exec', params: {command}, always, cwd, root: cwd, gitConfig: () => ''});
  assert.equal(d('findstr needle notes.txt'), 'allow', 'control: the remembered benign form passes');
  assert.equal(d('findstr needle id_rsa'), 'ask', 'the same key must not wave a secret read through');
  assert.equal(d('findstr needle credentials.json'), 'ask');
});

test('w5 policy (7): git.bat has a different alwaysKey from git; npm.cmd keeps the npm key', (t) => {
  const cwd = tmpdir(t, 'muser-w5-policy-');
  assert.equal(policy.alwaysKey('exec', {command: 'git status'}), 'exec:git status');
  assert.equal(policy.alwaysKey('exec', {command: 'git.bat status'}), 'exec:git.bat status', 'git has no .bat shim, so the extension stays in the key');
  assert.notEqual(policy.alwaysKey('exec', {command: 'git.bat status'}), policy.alwaysKey('exec', {command: 'git status'}));
  assert.equal(policy.alwaysKey('exec', {command: 'npm.cmd ls'}), policy.alwaysKey('exec', {command: 'npm ls'}), 'control: npm really ships as a .cmd shim, so its extension is not part of the key');
  const always = new Set(['exec:git status']);
  const d = command => policy.decide({mode: 'default', kind: 'exec', params: {command}, always, cwd, root: cwd, gitConfig: () => ''});
  assert.equal(d('git.bat status'), 'ask', 'a remembered git key does not allow git.bat');
  assert.equal(d('git status'), 'allow', 'control: git itself still passes');
});

// ---------- (8) tell ----------

function seedInbox(base, sessionId, messages) {
  const file = tell.inboxFile(sessionId, {base});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, messages.map(m => JSON.stringify(m)).join(NL) + NL);
  return file;
}
const peerMsg = (text, at) => ({text, at: new Date(at).toISOString(), from: {sessionId: 'w5-sender', pid: 4242}});

test('w5 tell (8): drain cuts a body over 2000 chars and reports it on the message', (t) => {
  const base = tmpdir(t, 'muser-w5-tell-');
  const now = Date.now();
  const longText = 'x'.repeat(2500);
  seedInbox(base, 'w5-drain-long', [peerMsg(longText, now), peerMsg('short one', now)]);
  const out = tell.drainInbox('w5-drain-long', {base, now});
  assert.equal(out.length, 2);
  assert.equal([...out[0].text].length, tell.MAX_TEXT, 'the delivered body is cut at MAX_TEXT code points');
  assert.equal(out[0].truncated, true, 'the cut is reported on the message');
  assert.equal(out[0].originalLength, 2500, 'the pre-cut length rides along');
  assert.equal(out[1].text, 'short one');
  assert.equal(out[1].truncated, undefined, 'a short body carries no truncation report');
});

test('w5 tell (8): drain delivers at most 5 in a minute and leaves the rest in the inbox', (t) => {
  const base = tmpdir(t, 'muser-w5-tell-');
  const now = Date.now();
  const msgs = [];
  for (let i = 0; i < 7; i++) msgs.push(peerMsg('msg-' + i, now));
  seedInbox(base, 'w5-drain-rate', msgs);
  const out = tell.drainInbox('w5-drain-rate', {base, now});
  assert.equal(out.length, tell.RECEIVE_PER_MIN, 'only the per-minute allowance is delivered');
  assert.deepEqual(out.map(m => m.text), ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'], 'the oldest five go first');
  const left = tell.readInbox('w5-drain-rate', {base});
  assert.deepEqual(left.map(m => m.text), ['msg-5', 'msg-6'], 'the rest stay in the inbox for a later drain, not dropped');
  const again = tell.drainInbox('w5-drain-rate', {base, now});
  assert.equal(again.length, 0, 'a second drain inside the same minute delivers nothing more');
  assert.equal(tell.readInbox('w5-drain-rate', {base}).length, 2, 'and the deferred pair is still there');
});

// ---------- (9) lore ----------

test('w5 lore (9): a shared-origin note is marked as shared and unverified in attachText', (t) => {
  const savedData = process.env.LOCALAPPDATA;
  const data = tmpdir(t, 'muser-w5-lore-data-');
  process.env.LOCALAPPDATA = data;
  t.after(() => { process.env.LOCALAPPDATA = savedData; });
  const repo = tmpdir(t, 'muser-w5-lore-repo-');
  fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
  const lines = ['one', 'two', 'three'];
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), lines.join(NL) + NL);
  const local = lore.addHunch(repo, {path: 'src/a.js', line: 2, text: 'local assumption W5'});
  assert.ok(local, 'the local hunch was recorded');
  const ctx = lore.repoContext(repo);
  fs.mkdirSync(path.dirname(ctx.sharedFile), {recursive: true});
  const sharedRec = {v: 1, kind: 'hunch', id: 'w5-shared-1', at: '2026-11-08T00:00:00.000Z', path: 'src/a.js',
    ...lore.anchor(lines, 2, 2), text: 'shared assumption W5', state: 'open', origin: 'local'};
  fs.writeFileSync(ctx.sharedFile, JSON.stringify(sharedRec) + NL);
  const recs = lore.readRecords(repo);
  const shared = recs.find(r => r.id === 'w5-shared-1');
  assert.equal(shared.origin, 'shared', 'provenance comes from the file it was read from, not the stored bytes (which claim local)');
  assert.equal(shared.shared, true);
  assert.equal(recs.find(r => r.id === local.id).origin, 'local');
  const attach = lore.attachText(repo, 'src/a.js');
  assert.ok(attach.includes('shared assumption W5'), 'the shared note is still attached');
  assert.ok(attach.includes('（共有・未検証）'), 'each shared note carries the shared / unverified mark');
  assert.ok(attach.includes('リポジトリに共有された言い伝え（未検証）'), 'the shared notes ride under their own downgraded heading');
  const localAt = attach.indexOf('local assumption W5');
  const sharedAt = attach.indexOf('リポジトリに共有された');
  assert.ok(localAt >= 0 && sharedAt > localAt, 'the local note rides under the plain heading, before the shared section');
});

// ---------- (10) agent-types ----------

test('w5 agent-types (10): an override without a tools line inherits the original tools', (t) => {
  const root = tmpdir(t, 'muser-w5-types-');
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(home, '.muser', 'agents'), {recursive: true});
  fs.mkdirSync(path.join(proj, '.muser', 'agents'), {recursive: true});
  pinHome(t, home);
  const md = (name, extra, prompt) => ['---', 'name: ' + name, ...(extra ? [extra] : []), '---', prompt, ''].join(NL);
  fs.writeFileSync(path.join(home, '.muser', 'agents', 'worker.md'), md('worker', 'tools: code.read, code.grep', 'User worker prompt.'));
  fs.writeFileSync(path.join(proj, '.muser', 'agents', 'worker.md'), md('worker', null, 'Project worker prompt.'));
  let types = captureErrors(() => agentTypes.load(proj));
  assert.equal(types.worker.prompt, 'Project worker prompt.', 'the override prompt wins');
  assert.deepEqual(types.worker.tools, ['code.read', 'code.grep'], 'no tools line: the original tools are inherited, not widened to all tools');
  assert.equal(agentTypes.allows(types.worker, 'code.read'), true);
  assert.equal(agentTypes.allows(types.worker, 'code.write'), false, 'the inherited allowlist still binds');
  fs.writeFileSync(path.join(proj, '.muser', 'agents', 'fresh.md'), md('fresh', null, 'Fresh prompt.'));
  types = captureErrors(() => agentTypes.load(proj));
  assert.equal(types.fresh.tools, null, 'control: a brand-new type with no tools line keeps the all-tools default');
  fs.writeFileSync(path.join(proj, '.muser', 'agents', 'worker.md'), md('worker', 'tools: code.grep', 'Project worker prompt 2.'));
  types = captureErrors(() => agentTypes.load(proj));
  assert.deepEqual(types.worker.tools, ['code.grep'], 'control: an explicit tools line in the override is honoured as written');
});

// ---------- (11) skills ----------

test('w5 skills (11): project-sourced skills are marked (project) in the preamble', (t) => {
  const root = tmpdir(t, 'muser-w5-skills-');
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(proj, {recursive: true});
  pinHome(t, home);
  const put = (dir, name, desc) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, {recursive: true});
    fs.writeFileSync(path.join(d, 'SKILL.md'), ['---', 'name: ' + name, 'description: ' + desc, '---', 'Body', ''].join(NL));
  };
  put(path.join(proj, '.muser', 'skills'), 'projskill', 'from the project');
  put(path.join(proj, '.claude', 'skills'), 'claudeskill', 'from claude project');
  put(path.join(home, '.muser', 'skills'), 'userskill', 'from the user');
  const text = skills.preambleLines(proj).join(NL);
  assert.ok(text.includes('- projskill (project): from the project'), 'project (.muser) skill is marked: ' + text);
  assert.ok(text.includes('- claudeskill (project): from claude project'), 'project (.claude) skill is marked');
  assert.ok(text.includes('- userskill: from the user'), 'the user skill is listed plainly');
  assert.ok(!text.includes('- userskill (project)'), 'the user skill is not marked as project');
});
