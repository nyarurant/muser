#!/usr/bin/env node
'use strict';
const VERSION = require('../package.json').version;
const i18n = require('../src/i18n');
const {t} = i18n;
// Help lines stay Japanese here; they are translated where they are printed (see main()).
const HELP_LINES = [
  'muser {version} — muse.ai のターミナル・コーディングエージェント（非公式）',
  '',
  '使い方:',
  '  muser [指示]              対話モードで開始（指示があれば最初に送る）',
  '  muser -c, --continue      このフォルダーの直前の会話を再開',
  '  muser resume [ID]         会話を再開（ID なしで一覧）',
  '  muser exec "指示"         ヘッドレスで1回実行して、最後の返事を出力',
  '  muser login               muse.ai にログイン（Edge の窓が開きます）',
  '  muser pc-login            この PC の CLI を Muse の端末として登録',
  '  muser doctor              接続を確認',
  '  muser usage               Muse の利用状況（週の使用量）と muser の記録',
  '  muser demo                Muse につながずに画面を試す',
  '  muser demo login          ログインまわり（初回の準備・接続・ログイン切れ）をデモで見る',
  '  muser logout',
  '',
  'オプション:',
  '  --mode <m>    承認モード: default（毎回確認）/ auto-edit / plan（読み取り専用）/ bypass',
  '  --cd <dir>    作業フォルダー（既定: 今のフォルダー）',
  '  --max-agents <n>        並列エージェントを同時に動かす数の上限（既定 4、0 で無制限）',
  '  --max-agents-total <n>  1回の作業で起動できる並列エージェントの数の上限（既定 0 = 無制限）',
  '                          環境変数 MUSER_MAX_AGENTS / MUSER_MAX_AGENTS_TOTAL や',
  '                          ~/.muser/config.json の {"maxAgents": 4, "maxAgentsTotal": 8} でも指定できます',
  '',
];

const KNOWN_FLAGS = '--mode <m> / --cd <dir> / --max-agents <n> / --max-agents-total <n> / -c, --continue / -h, --help / -V, --version';
function parse(argv) {
  const o = {_: [], mode: undefined, cwd: process.cwd()}; // mode: --mode, else the folder's remembered one
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--continue') o.continue = true;
    else if (a === '--mode' || a === '--cd' || a === '--max-agents' || a === '--max-agents-total') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag: a}));
      if (a === '--mode') o.mode = argv[++i];
      else if (a === '--cd') o.cwd = require('node:path').resolve(argv[++i]);
      else {
        if (!/^\d+$/.test(v)) throw new Error(t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag: a}));
        o[a === '--max-agents' ? 'maxAgents' : 'maxAgentsTotal'] = Number(argv[++i]);
      }
    }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-V' || a === '--version') o.version = true;
    else if (a.startsWith('--')) throw new Error(t('知らないオプションです: {flag}（使えるのは {flags}）', {flag: a, flags: KNOWN_FLAGS}));
    else o._.push(a);
  }
  return o;
}

// Web login -> chat gateway -> this PC's CLI device. Each step says what to run if it is missing.
async function connect(o, log) {
  const {createWeb, loadJar, probe} = require('../src/web');
  require('../src/secure-store').preload(['web.enc', 'device.enc', 'session.enc']); // one PowerShell start for all three
  const jar = loadJar();
  if (!jar.length) throw new Error(t('まず `muser login` で muse.ai にログインしてください。'));
  const web = createWeb(jar);
  const {createAuth} = require('../src/pc-login');
  const auth = createAuth(web);
  if (auth.snapshot().phase !== 'authenticated') throw new Error(t('この PC の CLI 端末がまだ登録されていません。`muser pc-login` を実行してください。'));
  log(t('Muse に接続しています…'));
  // The device's VM credentials do not depend on the chat gateway: fetch them meanwhile
  // (PcAuth keeps the result for the device link below).
  auth.vm().catch(() => {});
  const {connectChat} = require('../src/session');
  let client;
  try { client = await connectChat(web); }
  catch (e) { if ((await probe(jar).catch(() => 'error')) === 'waiting') throw Object.assign(new Error(t('muse.ai のログインが切れています。`muser login` を実行してください。')), {loginExpired: true}); throw e; }
  const subscribed = client.subscribe();
  const sessions = require('../src/sessions');
  let session;
  if (o.resume) { session = sessions.find(o.resume); if (!session) throw new Error(t('会話が見つかりません: {id}', {id: o.resume})); }
  else if (o.continue) { session = sessions.recent(o.cwd).find(s => s.turns); if (!session) throw new Error(t('このフォルダーで再開できる会話がありません。')); }
  const {McpHub} = require('../src/mcp');
  const mcp = new McpHub();
  if (Object.values(mcp.config.mcpServers || {}).some(s => s.enabled)) { log(t('MCP サーバーに接続しています…')); await mcp.start(); }
  mcp.index();
  const {Agent} = require('../src/agent');
  const cwd = session?.cwd || o.cwd, remembered = require('../src/permissions').load(cwd);
  const agent = new Agent({client, auth, cwd, mode: o.mode || remembered.mode || 'default', allowAlways: remembered.allow, web, session, mcp, agentLimits: {maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal}});
  log(t('この PC の CLI 端末をつないでいます…'));
  const identity = client.request('GET', '/identity').catch(() => null);
  await Promise.all([subscribed, agent.connectDevice()]);
  let museName = 'Muse';
  const r = await identity;
  if (typeof r?.name === 'string' && r.name.trim()) museName = r.name.trim().slice(0, 40);
  // Local usage tally (there is no server-side usage API): count tool calls
  // and finished turns. Recording is wrapped so it can never break a session.
  try {
    const usage = require('../src/usage');
    agent.on('tool-end', () => { try { usage.record({toolCalls: 1}); } catch {} });
    agent.on('agent-tool', () => { try { usage.record({toolCalls: 1}); } catch {} });
    agent.on('turn-end', e => { try { if (e && e.ok) usage.record({turns: 1, outChars: (e.text || '').length}); } catch {} });
  } catch {}
  return {agent, museName};
}

// Everything the TUI needs before Muse is reached: login and device checks (local), the chat
// client (not connected), the session, MCP servers, the agent. Muse's name is the one seen last
// time until /identity answers.
const NAME_FILE = () => require('node:path').join(require('../src/secure-store').DIR, 'identity.json');
function rememberMuseName(name) { try { require('node:fs').writeFileSync(NAME_FILE(), JSON.stringify({name})); } catch {} }
function lastMuseName() { try { return JSON.parse(require('node:fs').readFileSync(NAME_FILE(), 'utf8')).name || 'Muse'; } catch { return 'Muse'; } }
async function prepare(o) {
  const {createWeb, loadJar} = require('../src/web');
  require('../src/secure-store').preload(['web.enc', 'device.enc', 'session.enc']);
  const jar = loadJar();
  if (!jar.length) throw new Error(t('まず `muser login` で muse.ai にログインしてください。'));
  const web = createWeb(jar);
  const {createAuth} = require('../src/pc-login');
  const auth = createAuth(web);
  if (auth.snapshot().phase !== 'authenticated') throw new Error(t('この PC の CLI 端末がまだ登録されていません。`muser pc-login` を実行してください。'));
  auth.vm().catch(() => {}); // the device link's VM credentials, fetched while the screen comes up
  const client = require('../src/session').createChat(web);
  const sessions = require('../src/sessions');
  let session;
  if (o.resume) { session = sessions.find(o.resume); if (!session) throw new Error(t('会話が見つかりません: {id}', {id: o.resume})); }
  else if (o.continue) { session = sessions.recent(o.cwd).find(s => s.turns); if (!session) throw new Error(t('このフォルダーで再開できる会話がありません。')); }
  const {McpHub} = require('../src/mcp');
  const mcp = new McpHub();
  if (Object.values(mcp.config.mcpServers || {}).some(s => s.enabled)) await mcp.start(); // its tools are registered with the device
  mcp.index();
  const {Agent} = require('../src/agent');
  const cwd = session?.cwd || o.cwd, remembered = require('../src/permissions').load(cwd);
  const agent = new Agent({client, auth, cwd, mode: o.mode || remembered.mode || 'default', allowAlways: remembered.allow, web, session, mcp, agentLimits: {maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal}});
  try {
    const usage = require('../src/usage');
    agent.on('tool-end', () => { try { usage.record({toolCalls: 1}); } catch {} });
    agent.on('agent-tool', () => { try { usage.record({toolCalls: 1}); } catch {} });
    agent.on('turn-end', e => { try { if (e && e.ok) usage.record({turns: 1, outChars: (e.text || '').length}); } catch {} });
  } catch {}
  return {agent, museName: lastMuseName(), web};
}

// First run (or an expired login): do the missing steps right here, then start.
async function onboard({forceLogin = false, forceDevice = false} = {}) {
  const {createWeb, loadJar, probe} = require('../src/web');
  const {createAuth, pcLogin} = require('../src/pc-login');
  // No login probe here (two muse.ai requests incl. a token refresh): connecting refreshes the
  // credentials anyway, and an expired login is caught there (loginExpired) and handled then.
  require('../src/secure-store').preload(['web.enc', 'device.enc', 'session.enc']); // one PowerShell start for all three
  const needLogin = forceLogin || !loadJar().length;
  const needDevice = forceDevice || createAuth(createWeb()).snapshot().phase !== 'authenticated';
  await require('../src/tui/onboard').onboard({
    needLogin, needDevice,
    login: progress => require('../src/login').login({log: s => progress(s.trim().replace(/^…\s*/, ''))}),
    register: ui => pcLogin(createWeb(), ui),
  });
}

async function interactive(o, initial) {
  if (!process.stdin.isTTY) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
  // Own the screen from the first frame: the shell prompt that launched us goes away.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // Something on screen at once, never a black screen while the modules and keys load.
  process.stdout.write('\n  \x1b[1m\x1b[38;5;177mmuser\x1b[0m\x1b[2m  ' + t('起動しています…') + '\x1b[0m');
  const view = import('../src/ui/view.mjs'); // Ink/React load meanwhile
  view.catch(() => {});
  // First run only: ask for the UI language before the onboarding screens.
  if (i18n.chosen() === null) await require('../src/tui/onboard').askLanguage();
  await onboard();
  const {agent, museName, web} = await prepare(o);
  const {run} = await view;
  // The TUI comes up now; the gateway and the device link connect behind it.
  run({agent, museName, version: VERSION, initial, connect: async () => {
    await agent.ensureConnected();
    const r = await agent.client.request('GET', '/identity').catch(() => null);
    const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : null;
    if (name) rememberMuseName(name);
    return name;
  }});
}

// Codex-style headless run: progress to stderr, final reply to stdout. Nothing interactive:
// what the mode would ask about is declined, and Muse is told why.
async function exec(o, prompt) {
  if (!prompt) throw new Error(t('exec には指示が必要です。'));
  const err = s => process.stderr.write(s + '\n');
  const {agent} = await connect(o, s => err('· ' + s));
  agent.approver = async call => { err(t('  ✗ 確認が必要なので断りました: {command} {summary}', {command: call.command, summary: call.summary || ''})); return {allow: false, reason: 'headless run; the user can allow this with --mode auto-edit or bypass'}; };
  agent.on('tool-end', call => err((call.ok ? '  ✓ ' : '  ✗ ') + call.command + ' ' + String(call.summary || '').slice(0, 120)));
  try {
    const reply = await agent.send(prompt);
    let text = reply.text;
    try { const {stripEmbeds} = await import('../src/ui/sanitize.mjs'); text = stripEmbeds(text); } catch {}
    process.stdout.write(text.trim() + '\n');
  } finally { agent.close(); }
}

async function main() {
  const o = parse(process.argv.slice(2));
  const [cmd, ...rest] = o._;
  if (o.version) return console.log(VERSION);
  if (o.help || cmd === 'help') return process.stdout.write(HELP_LINES.map(l => t(l, {version: VERSION})).join('\n'));
  if (o.mode !== undefined && !require('../src/policy').MODES.includes(o.mode)) throw new Error(t('--mode は default / auto-edit / plan / bypass のどれかです。'));
  if (cmd === 'login') return onboard({forceLogin: true});
  if (cmd === 'logout') { require('../src/login').logout(); return console.log(t('ログアウトしました。')); }
  if (cmd === 'pc-login') return onboard({forceDevice: true});
  if (cmd === 'doctor') return doctor();
  if (cmd === 'usage') {
    const usage = require('../src/usage');
    try { console.log(usage.formatPlan(await usage.plan()) + '\n'); } catch (e) { console.log(t('Muse の利用状況: {message}', {message: e.message}) + '\n'); }
    return console.log(usage.formatSummary());
  }
  if (cmd === 'demo') { const d = await import('../src/ui/demo.mjs'); return rest[0] === 'login' ? d.demoLogin({version: VERSION}) : d.demo({version: VERSION}); }
  if (cmd === 'exec') return exec(o, rest.join(' '));
  if (cmd === 'resume') {
    if (!rest[0]) {
      const list = require('../src/sessions').recent().filter(s => s.turns).slice(0, 20);
      if (!list.length) return console.log(t('再開できる会話はありません。'));
      for (const s of list) console.log(s.id.slice(0, 8) + '  ' + new Date(s.updated).toLocaleString().padEnd(22) + (s.title || '') + '  \x1b[2m' + s.cwd + '\x1b[0m');
      return console.log('\n' + t('muser resume <ID> で再開'));
    }
    o.resume = rest[0];
    return interactive(o, rest.slice(1).join(' ') || undefined);
  }
  return interactive(o, o._.join(' ') || undefined);
}

async function doctor() {
  const {createWeb, loadJar, probe} = require('../src/web');
  const jar = loadJar();
  console.log('web login   :', await probe(jar));
  const web = createWeb(jar);
  const {connectChat} = require('../src/session');
  const client = await connectChat(web);
  console.log('gateway     : connected, chats', (await client.sessions())?.sessions?.length ?? '?');
  client.disconnect(false);
  const auth = require('../src/pc-login').createAuth(web);
  const pc = auth.snapshot();
  console.log('pc device   :', pc.phase, pc.phase === 'authenticated' ? '(vm ' + ((await auth.vm()).vm_id ? 'ok' : '?') + ')' : '');
  try { const u = require('../src/usage').summary().today; console.log('usage       :', 'today turns ' + u.turns + ', tools ' + u.toolCalls); } catch {}
}

main().catch(e => { process.stdout.write('\x1b[?25h'); console.error('muser: ' + e.message); process.exitCode = 1; });
