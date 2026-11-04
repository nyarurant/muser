'use strict';
// Fix phase 2 (agent A7) — bin/muser.js Medium findings. Black-box like
// tests/fixes-1101e.test.js #25-#27: the real bin runs as a subprocess on paths
// that fail before any network/TTY use, in per-run scratch homes, so the error
// line / output / exit code is the observable behaviour. No run here sends
// anything to Muse: exec runs die at the (empty) login check in scratch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync, spawn} = require('node:child_process');
const BIN = path.join(__dirname, '..', 'bin', 'muser.js');

function scratch() {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-home-')),
    data: fs.mkdtempSync(path.join(os.tmpdir(), 'muser-fix2-data-')),
  };
}
function runBin(args, {env = {}, input, timeout = 30000, dirs} = {}) {
  const d = dirs || scratch();
  const e = {...process.env, MUSER_LANG: 'ja', MUSER_CLIENT: '', USERPROFILE: d.home, HOME: d.home, LOCALAPPDATA: d.data, ...env};
  if (env.MUSER_LANG === null) delete e.MUSER_LANG;
  const r = spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', timeout, env: e, input});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', dirs: d};
}
const lastJsonLine = out => JSON.parse(out.trim().split('\n').filter(Boolean).pop());

// --- first audit #29: a word after a leading `--` is the prompt, never a subcommand
test('fix2-cli #29: -- <command-name> starts a conversation, not the subcommand', () => {
  for (const word of ['usage', 'doctor', 'serve']) {
    const r = runBin(['--', word]);
    assert.equal(r.status, 1, word + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /端末が必要です/, word + ' reached interactive() as a prompt');
    assert.doesNotMatch(r.stdout, /利用状況|Muser Server は動いていません/, word + ' did not run as a subcommand');
  }
});

// --- first audit #30: --session / --continue are refused where they mean nothing
test('fix2-cli #30: session flags are refused by doctor/logout/usage, kept by exec', () => {
  const doc = runBin(['doctor', '--session', 'abc123']);
  assert.equal(doc.status, 1); assert.match(doc.stderr, /--session/);
  const out = runBin(['logout', '--session', 'abc123']);
  assert.equal(out.status, 1); assert.match(out.stderr, /--session/);
  assert.doesNotMatch(out.stdout, /ログアウトしました/, 'logout did not happen under a foreign --session');
  const use = runBin(['usage', '--continue']);
  assert.equal(use.status, 1); assert.match(use.stderr, /--continue/);
  const ok = runBin(['exec', '--status', '--json', '--session', 'abc123']);
  assert.equal(ok.status, 5, 'exec still accepts --session (status read of no run)');
  assert.equal(JSON.parse(ok.stdout).state, 'gone');
});

// --- first audit #31: extra positional words are errors, not silently dropped
test('fix2-cli #31: extra words after subcommands are refused', () => {
  const cases = [
    [['server', 'status', 'extra'], /余分な引数です: extra/],
    [['server', 'autostart', 'on', 'extra'], /余分な引数です: extra/],
    [['exec', '--status', '--json', 'extra'], /余分な引数です: extra/],
    [['serve', 'extra'], /余分な引数です: extra/],
    [['status', 'someid', 'extra'], /余分な引数です: extra/],
    [['link', 'status', 'extra'], /余分な引数です: extra/],
    [['link', 'pair', 'extra'], /余分な引数です: extra/],
    [['agent-skill', 'status', 'claude', 'extra'], /余分な引数です: extra/],
    [['account', 'auto', 'on', 'extra'], /余分な引数です: extra/],
    [['account', 'list', 'extra'], /余分な引数です: extra/],
    [['demo', 'login', 'extra'], /余分な引数です: extra/],
  ];
  for (const [args, want] of cases) {
    const r = runBin(args);
    assert.equal(r.status, 1, args.join(' ') + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, want, args.join(' '));
  }
});

// --- fifth c2-3: exec --status --json is JSON even when there is no run
test('fix2-cli c2-3: exec --status --json with no run prints JSON, exit 5', () => {
  const r = runBin(['exec', '--status', '--json']);
  assert.equal(r.status, 5);
  const v = JSON.parse(r.stdout); // throws (failing the test) on the old plain text
  assert.equal(v.state, 'gone'); assert.equal(v.ok, false);
  const plain = runBin(['exec', '--status']);
  assert.equal(plain.status, 5); assert.match(plain.stdout, /gone · no status file/);
  // A readable file still returns the status object itself, exit = its own code.
  const dirs = scratch();
  const file = path.join(dirs.data, 'run.json');
  fs.writeFileSync(file, JSON.stringify({version: 1, state: 'done', exit: 0, ok: true, pid: process.pid}));
  const ok = runBin(['exec', '--status', file, '--json'], {dirs});
  assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).state, 'done');
});

// --- deep c3 #3: a cp932 stdin prompt is decoded, not mangled into U+FFFD
test('fix2-cli c3-3: exec reads a Shift-JIS stdin prompt correctly', () => {
  const sjis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); // テスト
  const r = runBin(['exec', '--json'], {input: sjis});
  const res = lastJsonLine(r.stdout);
  assert.equal(res.ok, false, 'scratch home has no login: the run stops there');
  assert.ok(res.status_file, 'result line carries status_file');
  const st = JSON.parse(fs.readFileSync(res.status_file, 'utf8'));
  assert.equal(st.prompt, 'テスト');
  const u = runBin(['exec', '--json'], {input: Buffer.from('テスト指示', 'utf8')});
  const st2 = JSON.parse(fs.readFileSync(lastJsonLine(u.stdout).status_file, 'utf8'));
  assert.equal(st2.prompt, 'テスト指示', 'UTF-8 input still decodes as UTF-8');
});

// --- deep c3 #2: stdin has a byte cap (a fast pipe cannot fill memory)
test('fix2-cli c3-2: exec refuses a stdin prompt over the cap', () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 4096, 0x61);
  const r = runBin(['exec', '--json'], {input: big, timeout: 60000});
  const res = lastJsonLine(r.stdout);
  assert.equal(res.ok, false);
  assert.match(res.error, /上限/, 'the cap, not the login, is what stopped the run');
  assert.ok(res.status_file, 'result line carries status_file');
});

// --- deep c3 #4 + fourth M24: resume list strips terminal escapes; one empty wording
test('fix2-cli c3-4/M24: resume list sanitizes titles and names the way forward when empty', () => {
  const dirs = scratch();
  const empty = runBin(['resume'], {dirs});
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /再開できる会話はありません。新しい会話は `muser` を引数なしで実行すると始められます。/);
  const dir = path.join(dirs.data, 'muser');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify([
    {id: '12345678-abcd-4def-8000-000000000001', title: 'evil\u001b[31m\nFAKE title', cwd: os.tmpdir(), turns: 2, updated: Date.now()},
  ]));
  const r = runBin(['resume'], {dirs});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('FAKE title'), 'the title itself is still shown');
  assert.doesNotMatch(r.stdout, /\u001b\[31m/, 'no raw colour escape from the title reaches the terminal');
  assert.doesNotMatch(r.stdout, /\nFAKE/, 'a newline in the title cannot forge a second list line');
});

// --- deep c3 #9: NOT REPRODUCED guard — logout with a dangling registry must not TypeError
test('fix2-cli c3-9: plain logout in an empty/scratch home succeeds (no null account)', () => {
  const r = runBin(['logout']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ログアウトしました/);
  assert.doesNotMatch(r.stderr, /TypeError|Cannot read properties of null/);
});

// --- fake resident server for the serve/link attach paths ----------------------
// A SEPARATE process: runBin uses spawnSync, which blocks this process's event
// loop — an in-process HTTP server could never answer the child's probes.
const FAKE_SERVER_SRC = `
const http = require('node:http'); const fs = require('node:fs');
const [portFile, countFile, failFirst] = process.argv.slice(2);
let gets = 0;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
  try { fs.appendFileSync(countFile, req.method + ' ' + req.url + '\\n'); } catch {}
  const j = (c, o) => { res.writeHead(c, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
  if (req.method === 'GET' && req.url === '/api/server') { gets++; if (failFirst === '1' && gets === 1) return j(500, {error: 'starting'}); return j(200, {pid: process.pid, protocol: 6, version: 't', startedAt: Date.now(), sessions: [], link: {pcId: 'pc-test', relayConnected: true, lan: [], devices: []}}); }
  if (req.method === 'POST' && req.url === '/api/sessions') return j(201, {id: 'sess-12345678'});
  if (req.method === 'POST' && req.url === '/api/server/link/pair') return j(200, {code: '654321', expiresAt: Date.now() + 60000, payload: 'PAIRPAYLOAD'});
  return j(404, {error: 'nope'});
}); });
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, JSON.stringify({pid: process.pid, port: srv.address().port})));
`;
async function fakeServer({failFirstGet = false} = {}) {
  const dirs = scratch();
  const src = path.join(dirs.home, 'fake-server.cjs');
  const portFile = path.join(dirs.home, 'port.json');
  const countFile = path.join(dirs.home, 'requests.log');
  fs.writeFileSync(src, FAKE_SERVER_SRC);
  const child = spawn(process.execPath, [src, portFile, countFile, failFirstGet ? '1' : '0'], {stdio: 'ignore'});
  let info = null;
  for (let i = 0; i < 100 && !info; i++) { try { info = JSON.parse(fs.readFileSync(portFile, 'utf8')); } catch { await new Promise(r => setTimeout(r, 50)); } }
  assert.ok(info, 'fake server started');
  const file = path.join(dirs.home, 'server.json');
  fs.writeFileSync(file, JSON.stringify({pid: info.pid, port: info.port, token: 'tok'}));
  const requests = () => { try { return fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return {dirs, env: {MUSER_SERVER_FILE: file}, pairCalls: () => requests().filter(l => l.includes('/api/server/link/pair')).length, close: async () => { child.kill(); }};
}

// --- fifth c2-1: serve with a pipe + fresh home must not hang on the language picker
test('fix2-cli c2-1: piped serve on a fresh home attaches instead of hanging on language choice', async () => {
  const f = await fakeServer();
  try {
    const r = runBin(['serve'], {dirs: f.dirs, env: {...f.env, MUSER_LANG: null}, timeout: 60000});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /すでに動いています/);
  } finally { await f.close(); }
});

// --- first audit #32 (bin side): attach says the limits/Focus flag stay the server's
test('fix2-cli #32: serve attach names --max-agents/--no-focus as server-side settings', async () => {
  const f = await fakeServer();
  try {
    const r = runBin(['serve', '--max-agents', '1', '--no-focus'], {dirs: f.dirs, env: f.env, timeout: 60000});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /--max-agents \/ --max-agents-total \/ --no-focus はその Server の設定が使われます/);
  } finally { await f.close(); }
});

// --- deep c3 #7a: link pair whose first probe raced the server start still pairs via the API
test('fix2-cli c3-7a: link pair retries through serve attach and starts pairing', async () => {
  const f = await fakeServer({failFirstGet: true});
  try {
    const r = runBin(['link', 'pair'], {dirs: f.dirs, env: f.env, timeout: 60000});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(f.pairCalls(), 1, 'pairing was requested from the live server');
    assert.match(r.stdout, /654321/);
    assert.doesNotMatch(r.stdout, /ペアリングは始まっていません/);
  } finally { await f.close(); }
});
