#!/usr/bin/env node
'use strict';
// `muser serve` feeds the GUI, which turns the SGR styling of reply rows into bold, headings
// and code: keep it on although there is no terminal (src/tui/term.js reads this at load).
// Only the SUBCOMMAND counts (recovery scan): a prompt that merely contains the word
// ("fix the server") used to get GUI styling forced on, and its escapes went to Muse.
if (process.env.MUSER_SGR === undefined) {
  const VALUED = ['--mode', '--cd', '--max-agents', '--max-agents-total', '--session', '--status-file', '--port', '--account', '--relay'];
  const args = process.argv.slice(2);
  let first = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--') break; if (args[i].startsWith('--')) { if (VALUED.includes(args[i])) i++; continue; } if (args[i].startsWith('-')) continue; first = args[i]; break; }
  if (first === 'serve' || first === 'server') process.env.MUSER_SGR = '1';
}
const VERSION = require('../package.json').version;
const i18n = require('../src/i18n');
const {t} = i18n;
// Help lines stay Japanese here; they are translated where they are printed (see main()).
const HELP_LINES = [
  'muser {version} — muse.ai のターミナル・コーディングエージェント（非公式）',
  '',
  '使い方:',
  '  muser [指示]              対話モードで開始（指示があれば最初に送る）',
  '  muser -c, --continue      このフォルダーの直前の会話を再開（一番手早い再開）',
  '  muser resume [ID] [指示]  会話を選んで再開（ID なしで一覧。後ろの言葉は最初の指示として送る）',
  '  muser exec "指示"         ヘッドレスで1回実行して、最後の返事を出力',
  '    --json                  JSON Lines で出力（最後の行が結果。会話 ID・PC 操作・使用量の変化つき）',
  '    --session <ID>          ID を指定して、その会話の続きとして実行（--json の結果にある session）',
  '    --status-file <パス>    実行の状態を JSON で書き続ける（実行中は running、終わると done と exit 0/2/1）。指定しなくても書き、場所を最初に表示します',
  '  muser exec --status [パス] 実行の状態を数行で（パスなしで一番新しい実行）。終了コード: 実行の結果 0/2/1、実行中 4、止まった・ない 5',
  '    （指示なし / -）        指示を標準入力から読む（例: type task.md | muser exec）',
  '  muser serve [--port N]    GUI 用にサーバーとして起動（127.0.0.1 のみ。接続情報は ~/.muser/gui.json）',
  '  muser serve --demo        GUI 用のサーバーを Muse につながずに起動（デモの台本を流す。見た目の確認用）',
  '  muser server              常駐 Muser Server として起動（serve と同じ。すでに動いていれば、そのサーバーで会話を開く）',
  '  muser server status       動いている Muser Server と、開いている会話を表示',
  '  muser status [pid|会話id]  開いている窓・サーバーの会話・実行中の exec を一覧（id で1つを詳しく、--json で機械向け）',
  '  muser server stop         Muser Server を止める（作業中の会話があれば確認する）',
  '  muser server autostart on|off  ログオン時に Muser Server を起動するかどうか', 
  '  muser serve --relay <url>  スマホ連携のリレー（既定: プロジェクトのリレー。--no-link で連携なし、--no-lan で LAN 直結なし）',
  '  muser link                スマホ連携の状態と、ペアリング済みの端末を表示',
  '  muser link pair           スマホとペアリング（QR コードを表示。--wifi で同じ Wi-Fi 向けのコード方式）',
  '  muser link revoke <名前>  ペアリング済み端末を取り消す',
  '  muser link autostart on|off  ログオン時に Server（連携込み）を起動するかどうか',
  '  muser --client            動いている Muser Server の会話として対話する（既定は単独動作。サーバーが無ければエラー）',  
  '  muser login               muse.ai にログインし直す（Edge の窓が開きます。アカウント切替・ログイン切れのときに。端末登録が要れば続けて行います）',
  '  muser agent-skill [install|remove] [claude|codex]  Claude Code・Codex に muser-exec スキル（作業を Muse に任せる方法）を登録する／外す（なしで状況）',
  '  muser account             アカウント一覧（複数アカウントと、それぞれの週の使用量）',
  '  muser account add <名前>  アカウントを追加（ログインと端末登録まで続けて行います）',
  '  muser account use <名前>  既定のアカウントを切り替える',
  '  --account <名前>          使うアカウントを指定して開始（指定なしでは使用量が少ない方を自動で選びます）',
  '  muser doctor              接続を確認',
  '  muser usage               Muse の利用状況（週の使用量）と muser の記録',
  '  muser demo                Muse につながずに画面を試す（--cd / --mode も渡せます）',
  '  muser demo login          ログインまわり（初回の準備・接続・ログイン切れ）をデモで見る',
  '  muser logout              muse.ai からログアウト（ログイン情報を消します）',
  '  muser help                このヘルプを表示（-h / --help も同じ）',
  '  muser -h, --help          このヘルプを表示',
  '  muser -V, --version       バージョンを表示（-v も同じ）',
  '',
  'オプション:',
  '  --mode <m>    承認モード: default（毎回確認）/ auto-edit / plan（読み取り専用）/ bypass',
  '  --cd <dir>    作業フォルダー（既定: 今のフォルダー）',
  '  --no-focus    完了条件の自動管理を無効にする（通常は有効）',
  '  --max-agents <n>        同時に動かすエージェント数の上限（既定 4、0 で無制限。/settings でも変更できます）',
  '  --max-agents-total <n>  1タスクで起動できるエージェントの合計数の上限（既定 0 = 無制限。/settings でも変更できます）',
  '                          環境変数 MUSER_MAX_AGENTS / MUSER_MAX_AGENTS_TOTAL や',
  '                          ~/.muser/config.json の {"maxAgents": 4, "maxAgentsTotal": 8} でも指定できます',
  '',
  '環境変数:',
  '  MUSER_LANG               表示言語（en / ja）',
  '  MUSER_NO_BELL=1          承認・完了時のベルを止める',
  '  MUSER_NO_UPDATE_CHECK=1  新しい版の確認を止める',
  '  MUSER_REDUCED_MOTION=1   スピナーなどの動きを止める',
  '  MUSER_KITTY=1            拡張キー入力（kitty プロトコル）を使う',
  '  MUSER_CODE_WRAP=1        長いコード行を折り返す',
  '  MUSER_MAX_AGENTS / MUSER_MAX_AGENTS_TOTAL           エージェント上限（--max-agents と同じ）',
  '  MUSER_ACCOUNT_THRESHOLD=N 週の使用量が N% で上限とみなす（既定 100）',
  '  MUSER_NO_ACCOUNT_AUTO=1  アカウントの自動選択とフェイルオーバーを止める（既定のアカウントだけを使う）',
  '  MUSER_MAX_TOOL_CALLS_PER_TURN / MUSER_DAILY_TURN_LIMIT  1ターンのツール上限 / 1日のターン上限',
  '',
];

const KNOWN_FLAGS = '--mode <m> / --cd <dir> / --no-focus / --demo / --max-agents <n> / --max-agents-total <n> / --json / --session <ID> / --status-file <path> / --status [path] / --port <n> / --account <name> / --client / --relay <url> / --no-link / --no-lan / --wifi / -c, --continue / -h, --help / -V, --version';
// The project's relay for muser link (remote/DESIGN.md); self-hosters point
// MUSER_RELAY_URL or --relay at their own.
const DEFAULT_RELAY_URL = process.env.MUSER_RELAY_URL || 'wss://necco.xyz/muser-relay';
let pendingPairing = null; // armed by `muser link pair` when it starts serve itself
function parse(argv) {
  const o = {_: [], mode: undefined, cwd: process.cwd()}; // mode: --mode, else the folder's remembered one
  // `--` ends the options: every word after it is positional, exactly as typed. And once a
  // prompt has begun (a first word that is not a subcommand, resume's words after the ID,
  // exec's words after the first prompt word), flag-shaped words in it are just words —
  // `muser fix the --json bug` used to switch modes and lose the word (audit #249). Flags
  // for those commands go before the prompt, as in --help.
  // o.literal: a `--` came before ANY word, so even a word spelled like a subcommand
  // is the prompt itself (`muser -- serve` asks Muse about "serve"; audit #29).
  // main() reads it and dispatches no subcommand for such a run.
  let literal = false, promptTail = false;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (literal || promptTail) { o._.push(a); continue; }
    if (a === '--') { literal = true; if (!o._.length) o.literal = true; continue; }
    // --flag=value is the same as --flag value (--mode=bypass was an unknown option).
    let eqValue;
    const eq = /^--(mode|cd|max-agents|max-agents-total|session|status-file|port|account|relay|status)=/.exec(a);
    if (eq) { eqValue = a.slice(a.indexOf('=') + 1); a = '--' + eq[1]; }
    const takeValue = flag => {
      if (eqValue !== undefined) {
        // An empty = value (--session=) used to be silently ignored downstream
        // (recovery scan): it is a missing value, like --session with nothing after.
        if (eqValue === '' || eqValue.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag}));
        return eqValue;
      }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag}));
      i++; return v;
    };
    if (a === '-c' || a === '--continue') o.continue = true;
    else if (a === '--mode' || a === '--cd' || a === '--max-agents' || a === '--max-agents-total' || a === '--port') {
      const v = takeValue(a);
      if (a === '--mode') o.mode = v;
      else if (a === '--cd') {
        o.cwd = require('node:path').resolve(v); o.cdGiven = true;
        let dir = false; try { dir = require('node:fs').statSync(o.cwd).isDirectory(); } catch {}
        if (!dir) throw new Error(t('--cd のフォルダーがありません: {dir}', {dir: o.cwd}));
      }
      else {
        if (!/^\d+$/.test(v)) throw new Error(t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag: a}));
        o[a === '--max-agents' ? 'maxAgents' : a === '--max-agents-total' ? 'maxAgentsTotal' : 'port'] = Number(v);
        // Checked here, not only inside serve(): `--port 70000` with any other command
        // used to pass silently and be ignored (audit #250).
        if (a === '--port' && o.port > 65535) throw new Error(t('--port は 65535 以下の整数を指定してください（0 で空きポート）。'));
      }
    }
    else if (a === '--json') o.json = true;
    else if (a === '--no-focus') o.noFocus = true;
    else if (a === '--client') o.client = true;
    else if (a === '--no-link') o.noLink = true;
    else if (a === '--no-lan') o.noLan = true;
    else if (a === '--wifi') o.wifi = true;
    else if (a === '--relay') o.relay = takeValue(a);
    else if (a === '--demo') o.demo = true;
    else if (a === '--session') o.resume = takeValue(a);
    // --status [file]: read a run back instead of starting one (the file is optional).
    else if (a === '--status') o.status = eqValue !== undefined ? (eqValue || true) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else if (a === '--status-file') o.statusFile = takeValue(a);
    else if (a === '--account') o.account = takeValue(a);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-V' || a === '--version' || (a === '-v' && !o._.length)) o.version = true;
    else if (a.startsWith('--')) throw new Error(t('知らないオプションです: {flag}（使えるのは {flags}）', {flag: a, flags: KNOWN_FLAGS}));
    // An unknown short option before the prompt (muser -x) went to Muse as a one-word prompt; inside
    // a prompt ("fix the -x flag") it is just a word.
    else if (/^-[A-Za-z]/.test(a) && !o._.length) throw new Error(t('知らないオプションです: {flag}（使えるのは {flags}）', {flag: a, flags: KNOWN_FLAGS}));
    else {
      o._.push(a);
      if (o._.length === 1 && !COMMAND_NAMES.includes(a)) promptTail = true; // a prompt, not a subcommand
      else if (o._[0] === 'resume' && o._.length === 2) promptTail = true; // the ID is in; the rest is the prompt
      else if (o._[0] === 'exec' && o._.length === 2) promptTail = true; // the first prompt word is in
    }
  }
  return o;
}

// The account a --account flag names (by id or label); throws when there is no such account.
function accountFromFlag(o) {
  if (!o.account) return null;
  const a = require('../src/accounts').resolve(o.account);
  if (!a) throw new Error(t('アカウントが見つかりません: {id}', {id: o.account}));
  return a;
}
// The working set (web login, device auth, gateway client) a window starts on. An explicit
// --account wins; a resumed session's own account wins next (its Muse has the conversation);
// otherwise the pool picks (src/account-pool.js: least weekly use among ready accounts).
async function startBundle(o, session) {
  const pool = require('../src/account-pool'), accounts = require('../src/accounts');
  const forced = accountFromFlag(o);
  // A resumed chat lives on its own account's Muse. One saved before multi-account support
  // names none: it was the first account's. --account naming another one would have sent the
  // chat's id to a Muse that never saw it, as if it were the same conversation.
  const owner = session ? (session.account || accounts.DEFAULT_ID) : null;
  if (forced && owner && forced.id !== owner) {
    const a = accounts.get(owner);
    throw new Error(a ? t('この会話はアカウント {label} のものです。--account {id} で開くか、--account を外してください。', {label: a.label, id: a.id}) : t('この会話のアカウント（{id}）はもうありません。', {id: owner}));
  }
  if (forced) return {...pool.bundle(forced), reason: 'flag'};
  if (owner) { const a = accounts.get(owner); if (a) return {...pool.bundle(a), reason: 'resume'}; }
  return pool.initialBundle();
}
function sessionFromFlags(o) {
  const sessions = require('../src/sessions');
  if (o.resume) return resumeTarget(sessions, o.resume);
  if (o.continue) { const s = sessions.recent(o.cwd).find(s => s.turns); if (!s) throw new Error(t('再開できる会話はありません。新しい会話は `muser` を引数なしで実行すると始められます。')); return s; }
  return undefined;
}

// Web login -> chat gateway -> this PC's CLI device. Each step says what to run if it is missing.
async function connect(o, log) {
  const {probe} = require('../src/web');
  const pool = require('../src/account-pool');
  pool.preloadAll();
  let session = sessionFromFlags(o);
  let chosen = await startBundle(o, session);
  // Connect, with failover: an account whose login lapsed (or whose gateway refuses it) hands
  // over to the pool's next ready account instead of failing the whole run. A network failure
  // is not an account problem and is never failed over.
  let client = null;
  const tried = new Set();
  while (!client) {
    const {web, auth, files, account} = chosen;
    if (!web.jar.length) throw new Error(t('まず `muser login` で muse.ai にログインしてください。'));
    if (auth.snapshot().phase !== 'authenticated') throw new Error(t('この PC の CLI 端末がまだ登録されていません。`muser pc-login` を実行してください。'));
    log(t('Muse に接続しています…'));
    // The device's VM credentials do not depend on the chat gateway: fetch them meanwhile
    // (PcAuth keeps the result for the device link below).
    auth.vm().catch(() => {});
    try { client = await require('../src/session').connectChat(web, {file: files.session}); }
    catch (e) {
      if ((await probe(web.jar, files.web).catch(() => 'error')) === 'waiting') {
        tried.add(account.id);
        const next = await pool.makePool().next(tried).catch(() => null);
        // A conversation asked for by id (--session / -c) lives on this account's Muse only:
        // moving on started a new chat elsewhere and reported it as if it were that one.
        if (session) throw Object.assign(new Error(t('この会話のアカウント {label} はログインが切れています。`muser login --account {id}` でログインし直してください。', {label: account.label, id: account.id})), {loginExpired: true});
        // --account names the account to run on: a run asked for on sub moved to another one.
        if (o.account) throw Object.assign(new Error(t('アカウント {label} はログインが切れています。`muser login --account {id}` でログインし直してください。', {label: account.label, id: account.id})), {loginExpired: true});
        if (!next) throw Object.assign(new Error(t('muse.ai のログインが切れています。`muser login` を実行してください。')), {loginExpired: true});
        log(t('アカウント {label} はログインが切れているため、{next} に切り替えます。', {label: account.label, next: next.account.label}));
        chosen = next; continue;
      }
      throw e;
    }
  }
  const {web, auth, account, files} = chosen;
  // Assembly window (deep c3 #1): from subscribe() until the Agent exists, a throw
  // (an MCP server that will not start, the Agent constructor) leaked the gateway
  // client and the started MCP children — nothing owned them yet, so the process
  // could hang after printing the error. The Agent-owned try below starts later.
  const subscribed = client.subscribe();
  subscribed.catch(() => {}); // a cleanup disconnect may settle it as a rejection
  const {McpHub} = require('../src/mcp');
  const mcp = new McpHub();
  let agent;
  try {
    if (Object.values(mcp.config.mcpServers || {}).some(s => s.enabled)) { log(t('MCP サーバーに接続しています…')); await mcp.start(); }
    mcp.index();
    const {Agent} = require('../src/agent');
    const cwd = sessionFolder(session, o), remembered = require('../src/permissions').load(cwd);
    agent = new Agent({client, auth, cwd, mode: o.mode || remembered.mode || require('../src/settings').defaultMode(), allowAlways: remembered.allow, web, session, mcp, focusEnabled: !o.noFocus && require('../src/settings').switchValue('focus'), agentLimits: {maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal}, accountId: account.id, accountLabel: pool.multi() ? account.label : null, accountFiles: files, accountPool: pool.makePool()});
  } catch (e) {
    try { await mcp.close(); } catch {}
    try { client.disconnect(false); } catch {}
    throw e;
  }
  log(t('この PC の CLI 端末をつないでいます…'));
  // A failure from here on must not leak the half-built agent (recovery scan):
  // its MCP children, gateway client and node slot would keep the process alive
  // holding resources, and the caller never receives the agent to close it.
  let museName = 'Muse';
  try {
    const identity = client.request('GET', '/identity').catch(() => null);
    await Promise.all([subscribed.then(() => { agent.subscribed = true; }), agent.connectDevice()]);
    const r = await identity;
    if (typeof r?.name === 'string' && r.name.trim()) museName = r.name.trim().slice(0, 40);
  } catch (e) { try { agent.close(); } catch {} throw e; }
  // Local usage tally (there is no server-side usage API): count tool calls
  // and finished turns. Recording is wrapped so it can never break a session.
  try {
    const usage = require('../src/usage');
    agent.on('tool-end', () => { try { usage.record({toolCalls: 1}); } catch {} });
    agent.on('agent-tool', () => { try { usage.record({toolCalls: 1}); } catch {} });
    // Real tokens come from turn-usage, one record per Muse reply (main and
    // parallel alike): turn-end carries the user turn's summed usage for
    // display, and recording it too would count every reply twice over.
    agent.on('turn-usage', e => { try { if (e?.usage) usage.record({usage: e.usage}); } catch {} });
    agent.on('turn-end', e => { try { if (e && e.ok) usage.record({turns: 1, outText: e.text || ''}); } catch {} });
    // What was sent was never recorded: /usage showed "in 0" and too few tokens.
    // The text itself is recorded when the event carries it (audit #246): the token
    // estimate in usage.estTokens is language-aware, a bare character count is not.
    agent.on('sent', e => { try { usage.record(typeof e?.text === 'string' ? {inText: e.text} : {inChars: e?.chars || 0}); } catch {} });
  } catch {}
  return {agent, museName};
}

// Everything the TUI needs before Muse is reached: login and device checks (local), the chat
// client (not connected), the session, MCP servers, the agent. Muse's name is the one seen last
// time until /identity answers.
// Per account (src/accounts.js): each account has its own Muse, with its own name.
function rememberMuseName(name, accountId) { require('../src/accounts').rememberMuseName(accountId, name); }
function lastMuseName(accountId) { return require('../src/accounts').museName(accountId); }
// overrides (the Muser Server's per-conversation factory, remote/SERVER.md):
// {cwd, account, mode, session} build ONE conversation with those choices instead
// of the command line's; the interactive/exec paths pass none and behave as before.
async function prepare(o, overrides = {}) {
  const pool = require('../src/account-pool');
  pool.preloadAll();
  // Third H3: three distinct cases for overrides.session —
  //  - 'new' (NEW_SESSION from src/server/sessions-host, sent by openNew /
  //    POST /api/sessions): an EXPLICIT new conversation. It must NOT resume
  //    anything, whatever --session/-c flags this server process was started
  //    with, so the session is null (Agent treats it as a fresh session).
  //  - a stored session object: re-open that conversation.
  //  - absent/undefined: not specified (the CLI startup paths) — fall back
  //    to the startup flags exactly as before.
  const session = overrides.session === 'new' ? null : overrides.session !== undefined ? overrides.session : sessionFromFlags(o);
  const oo = {...o};
  if (overrides.cwd) {
    // Server-supplied cwd gets the same existence check --cd gets in parse()
    // (deep c3 #8): an unchecked folder made a conversation whose every file
    // operation and command then failed obscurely.
    let dir = false; try { dir = require('node:fs').statSync(overrides.cwd).isDirectory(); } catch {}
    if (!dir) throw new Error(t('この会話のフォルダーがありません: {cwd}（別のフォルダーで続けるなら --cd <フォルダー> を付けてください）', {cwd: overrides.cwd}));
    oo.cwd = overrides.cwd; oo.cdGiven = true;
  }
  if (overrides.account) oo.account = overrides.account;
  if (overrides.mode) oo.mode = overrides.mode;
  const chosen = await startBundle(oo, session);
  const {web, auth, client, account, files} = chosen;
  if (!web.jar.length) throw new Error(t('まず `muser login` で muse.ai にログインしてください。'));
  if (auth.snapshot().phase !== 'authenticated') throw new Error(t('この PC の CLI 端末がまだ登録されていません。`muser pc-login` を実行してください。'));
  auth.vm().catch(() => {}); // the device link's VM credentials, fetched while the screen comes up
  const {McpHub} = require('../src/mcp');
  const mcp = new McpHub();
  // Same assembly window as connect() (deep c3 #1): a throw from mcp.start() or
  // the Agent constructor leaked the started MCP children, as no Agent owned them.
  let agent;
  try {
    if (Object.values(mcp.config.mcpServers || {}).some(s => s.enabled)) await mcp.start(); // its tools are registered with the device
    mcp.index();
    const {Agent} = require('../src/agent');
    const cwd = sessionFolder(session, oo), remembered = require('../src/permissions').load(cwd);
    agent = new Agent({client, auth, cwd, mode: oo.mode || remembered.mode || require('../src/settings').defaultMode(), allowAlways: remembered.allow, web, session, mcp, focusEnabled: !o.noFocus && require('../src/settings').switchValue('focus'), agentLimits: {maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal}, accountId: account.id, accountLabel: pool.multi() ? account.label : null, accountFiles: files, accountPool: pool.makePool()});
  } catch (e) { try { await mcp.close(); } catch {} throw e; }
  try {
    const usage = require('../src/usage');
    agent.on('tool-end', () => { try { usage.record({toolCalls: 1}); } catch {} });
    agent.on('agent-tool', () => { try { usage.record({toolCalls: 1}); } catch {} });
    // Real tokens come from turn-usage, one record per Muse reply (main and
    // parallel alike): turn-end carries the user turn's summed usage for
    // display, and recording it too would count every reply twice over.
    agent.on('turn-usage', e => { try { if (e?.usage) usage.record({usage: e.usage}); } catch {} });
    agent.on('turn-end', e => { try { if (e && e.ok) usage.record({turns: 1, outText: e.text || ''}); } catch {} });
    // What was sent was never recorded: /usage showed "in 0" and too few tokens.
    // The text itself is recorded when the event carries it (audit #246): the token
    // estimate in usage.estTokens is language-aware, a bare character count is not.
    agent.on('sent', e => { try { usage.record(typeof e?.text === 'string' ? {inText: e.text} : {inChars: e?.chars || 0}); } catch {} });
  } catch {}
  return {agent, museName: lastMuseName(account.id), web};
}

// First run (or an expired login): do the missing steps right here, then start.
// Onboarding for ONE account (the active one, or the one named): its own Edge profile, jar
// and device registration. Other accounts' logins are never touched here.
// The default account is not changed here, not even by `muser login --account X` or `muser account add`:
// it stays the first account unless `muser account use` says otherwise.
async function onboard({forceLogin = false, forceDevice = false, accountId} = {}) {
  const {createWeb, loadJar} = require('../src/web');
  const {createAuth, pcLogin} = require('../src/pc-login');
  const accounts = require('../src/accounts');
  const account = (accountId && accounts.get(accountId)) || accounts.get(accounts.activeId()) || accounts.list()[0];
  const files = accounts.filesFor(account.id);
  // No login probe here (two muse.ai requests incl. a token refresh): connecting refreshes the
  // credentials anyway, and an expired login is caught there (loginExpired) and handled then.
  require('../src/secure-store').preload([files.web, files.device, files.session]); // one PowerShell start for all three
  const needLogin = forceLogin || !loadJar(files.web).length;
  // needDevice is a THUNK (recovery scan): it used to be snapshotted before the
  // login step ran, so a login completed as a DIFFERENT muse.ai user skipped (or
  // kept) a device registration decided under the old login. onboard() re-asks
  // after the login step, reading the jar as it then stands.
  // A pair can be phase 'authenticated' yet dead, or minted for another muse.ai
  // user (first audit #36): the phase check alone skipped registration here and
  // the failure only surfaced later at connect time. pcLogin() repairs exactly
  // those cases when it runs, so probe the pair the way it does — once, before
  // the screens — and let needDevice report it broken. (A network error is NOT
  // a broken pair: it falls through as registered, as before.)
  let deviceBroken = false;
  if (!forceDevice && loadJar(files.web).length) {
    const probeAuth = createAuth(createWeb(loadJar(files.web), {file: files.web}), {file: files.device});
    if (probeAuth.snapshot().phase === 'authenticated') {
      try { await probeAuth.vm(); } catch (e) { if (e.deviceMismatch || e.deadDevice || e.status === 401) deviceBroken = true; }
    }
  }
  const needDevice = () => forceDevice || deviceBroken || createAuth(createWeb(loadJar(files.web), {file: files.web}), {file: files.device}).snapshot().phase !== 'authenticated';
  await require('../src/tui/onboard').onboard({
    needLogin, needDevice,
    login: progress => require('../src/login').login({log: s => progress(s.trim().replace(/^…\s*/, '')), profile: files.browser, jarFile: files.web}),
    register: ui => pcLogin(createWeb(loadJar(files.web), {file: files.web}), ui, {file: files.device}),
  });
}
// The account a window will start on when that is already decided before the pool runs: a
// --account flag, else a resumed session's own account. Onboarding checked only the default
// account, so `muser --account sub` with sub's login lapsed failed with "run muser login"
// instead of opening sub's login window. Starting a window does not change the default.
function onboardFor(o) {
  const accountId = accountFromFlag(o)?.id || (() => {
    // A resume the user ASKED for that cannot be resolved (not found / ambiguous)
    // is an error to report, not a reason to onboard the default account first
    // (recovery scan): onboarding could open a login window before prepare()
    // re-ran the same lookup and threw the real error anyway.
    try { const s = sessionFromFlags(o); if (!s) return undefined; const id = s.account || 'default'; return require('../src/accounts').get(id) ? id : undefined; } catch (e) { if (o.resume || o.continue) throw e; return undefined; }
  })();
  // No fixed account and the pool picks: a default account without a login is no reason to
  // open the login window while another account is ready (the pool starts on that one).
  if (!accountId) {
    const accounts = require('../src/accounts'), pool = require('../src/account-pool');
    const ready = id => accounts.hasLogin(id) && accounts.hasDevice(id);
    if (pool.multi() && pool.autoEnabled() && !ready(accounts.activeId()) && accounts.list().some(a => ready(a.id))) return;
  }
  return onboard({accountId});
}

async function interactive(o, initial) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
  // Own the screen from the first frame: the shell prompt that launched us goes away.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // Something on screen at once, never a black screen while the modules and keys load.
  process.stdout.write('\n  \x1b[1m\x1b[38;5;177mmuser\x1b[0m\x1b[2m  ' + t('起動しています…') + '\x1b[0m');
  const view = import('../src/ui/view.mjs'); // Ink/React load meanwhile
  view.catch(() => {});
  // First run only: ask for the UI language before the onboarding screens.
  if (i18n.chosen() === null) await require('../src/tui/onboard').askLanguage();
  await onboardFor(o);
  const {agent, museName, web} = await prepare(o);
  // A view that fails to load must not strand the prepared agent (deep c3 #1).
  let run;
  try { ({run} = await view); } catch (e) { try { agent.close(); } catch {} throw e; }
  // The TUI comes up now; the gateway and the device link connect behind it.
  run({agent, museName, version: VERSION, initial, onReload: () => {
    // /reload: a fresh process on the current code, resuming this session. The flags that
    // shaped this window are carried over; the mode is the one in effect now.
    const args = [__filename];
    // Always carry the session id, not only once it has turns (third M21): a
    // conversation with a goal but no turn yet was dropped by /reload — the new
    // process started fresh, the goal was lost and the old conversation was not
    // even listed. The client path below already carried it unconditionally.
    if (agent.session?.id) args.push('--session', agent.session.id);
    if (agent.accountId) args.push('--account', agent.accountId);
    args.push('--cd', agent.cwd, '--mode', agent.mode);
    if (o.noFocus) args.push('--no-focus');
    if (o.maxAgents != null) args.push('--max-agents', String(o.maxAgents));
    if (o.maxAgentsTotal != null) args.push('--max-agents-total', String(o.maxAgentsTotal));
    require('node:child_process').spawn(process.execPath, args, {stdio: 'inherit'}).unref();
  }, connect: async () => {
    await agent.ensureConnected();
    const r = await agent.client.request('GET', '/identity').catch(() => null);
    const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : null;
    if (name) rememberMuseName(name, agent.accountId);
    return name;
  }});
}

// `muser --client`: the TUI as a client of the resident Muser Server
// (remote/DESIGN.md step 4). The standalone path above stays the default and
// the dev/recovery escape hatch: client mode never starts a server, never
// falls back silently, and refuses an old server whose protocol predates v6
// (a resident server keeps running the code it was started with).
async function clientInteractive(o, initial) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
  const discovery = require('../src/server/discovery');
  const info = discovery.readServer();
  const live = info && await discovery.probeServer(info).catch(() => null);
  if (!live) throw new Error(t('Muser Server が動いていません。`muser server` で起動するか、--client を外して単独で使ってください。'));
  // Exactly 6 (recovery scan): a NEWER server was accepted too and failed obscurely
  // mid-session instead of getting this clean refusal.
  if ((live.protocol ?? 5) !== 6) throw new Error(t('動いている Muser Server のプロトコル {p} には対応していません（この muser はプロトコル 6 です）。`muser server stop` してから起動し直すか、--client を外してください。', {p: live.protocol ?? 5}));
  let sessionId;
  if (o.resume || o.continue) sessionId = sessionFromFlags(o)?.id;
  // The agent limits and Focus flag travel with the attach (first audit #32):
  // discovery/sessions-host currently accept only cwd/account/mode/sessionId,
  // so until those sides take them the server's own settings apply — but the
  // values are at least offered here instead of dropped in bin. (Cross-file:
  // src/server/discovery.js + src/server/sessions-host.js.)
  const opened = await discovery.attachSession(info, {cwd: o.cwd, account: o.account, mode: o.mode, sessionId, maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal, noFocus: o.noFocus});
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  process.stdout.write('\n  \x1b[1m\x1b[38;5;177mmuser\x1b[0m\x1b[2m  ' + t('起動しています…') + '\x1b[0m');
  const {createClient} = require('../src/server/client');
  const client = createClient(info);
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const {run} = await import('../src/ui/view.mjs');
  const {c} = require('../src/tui/term');
  let ctrl;
  const onExit = () => {
    try { ctrl?.stop(); } catch {}
    process.stdout.write(c.faint(t('再開するには: muser --client resume {id}', {id: opened.id.slice(0, 8)})) + '\n');
    setTimeout(() => process.exit(0), 50);
  };
  const onReload = () => {
    // /reload in client mode restarts the CLIENT on the same conversation;
    // the server (and its code) is untouched by design.
    const args = [__filename, '--client'];
    args.push('--session', opened.id);
    if (o.account) args.push('--account', o.account);
    args.push('--cd', o.cwd);
    if (o.mode) args.push('--mode', o.mode);
    if (o.noFocus) args.push('--no-focus');
    if (o.maxAgents != null) args.push('--max-agents', String(o.maxAgents));
    if (o.maxAgentsTotal != null) args.push('--max-agents-total', String(o.maxAgentsTotal));
    require('node:child_process').spawn(process.execPath, args, {stdio: 'inherit'}).unref();
    setTimeout(() => process.exit(0), 50);
  };
  ctrl = new RemoteController({client, sessionId: opened.id, version: VERSION, onExit, onReload});
  await ctrl.start();
  run({remoteCtrl: ctrl, version: VERSION, initial});
}

// How long `muser exec` waits for a stdin prompt to finish arriving. A pipe is fed at
// once by whatever launches the run; one that is still open after this is a launcher
// holding the pipe open, not a prompt on its way (audit #154).
const STDIN_TIMEOUT_MS = 30000;
// A byte cap as well as the time cap (deep c3 #2): a fast pipe could fill memory
// long before the 30 s timeout fired. 10 MB is far beyond any real task file.
const STDIN_MAX_BYTES = 10 * 1024 * 1024;
// Decode a stdin prompt (deep c3 #3): UTF-8 first, but a cp932 (Shift-JIS) file
// piped on a Japanese Windows box used to be silently mangled into U+FFFD and
// sent to Muse as-is. Invalid UTF-8 falls back to Shift-JIS; bytes that are
// neither decode lossily as before.
function decodeStdin(buf) {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(buf); } catch {}
  try { return new TextDecoder('shift-jis', {fatal: true}).decode(buf); } catch {}
  return buf.toString('utf8');
}
async function readStdinPrompt(timeoutMs) {
  const chunks = [];
  let bytes = 0;
  const reading = (async () => { for await (const c of process.stdin) { bytes += c.length; if (bytes > STDIN_MAX_BYTES) throw new Error(t('標準入力（stdin）の上限（{mb} MB）を超えました。', {mb: Math.round(STDIN_MAX_BYTES / 1024 / 1024)})); chunks.push(c); } return decodeStdin(Buffer.concat(chunks)); })();
  reading.catch(() => {}); // a timeout destroys stdin below; that rejection is expected
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(t('標準入力（stdin）を {sec} 秒待っても読み終えませんでした。送り側がパイプを閉じていない可能性があります。', {sec: Math.round(timeoutMs / 1000)}))), timeoutMs); timer.unref?.(); });
  try { return await Promise.race([reading, timeout]); }
  catch (e) { try { process.stdin.destroy(); } catch {} throw e; }
  finally { clearTimeout(timer); }
}

// Codex-style headless run: progress to stderr, final reply to stdout. Nothing interactive:
// what the mode would ask about is declined, and Muse is told why.
// --json: JSON Lines on stdout and nothing else, for scripts and other agents (like `codex exec
// --json`): start, then a line per tool call and per Muse-side step, and last a result line
// ({"type":"result","ok":…}). The session id it reports continues the chat with --session <id>.
async function exec(o, prompt) {
  const json = !!o.json, t0 = Date.now();
  const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
  let status = null; // the state file (below); every line the terminal shows also goes into it
  const err = s => { status?.log(s); if (!json) process.stderr.write(s + '\n'); };
  const usage = require('../src/usage');
  // The run's state in a file another agent can poll (src/exec-status.js): running until the
  // result, then done with the exit code. It is created FIRST, before the prompt is read
  // from stdin: a launcher that holds the pipe open without ever closing it used to hang
  // the run before the file existed, so there was nothing to poll and no way to see why
  // (audit #154). A failed write is said out loud with its reason instead of the bare
  // file name: polling a file that could not be written only ever reads "gone" (audit #151).
  const {ExecStatus} = require('../src/exec-status');
  status = new ExecStatus({file: o.statusFile, prompt: prompt && prompt !== '-' ? prompt : '', cwd: o.cwd, mode: o.mode}).start();
  const noteWriteError = () => { if (status.writeError) process.stderr.write(t('状態ファイル {file} を書けませんでした: {error}', {file: status.file, error: status.writeError}) + '\n'); };
  if (status.writeError) noteWriteError(); else err(t('状態ファイル: {file}', {file: status.file}));
  // `type task.md | muser exec` (or `muser exec -`): the prompt comes from stdin. The read
  // is bounded: stdin that never ends fails the run (and says so in the status file)
  // instead of hanging it forever (audit #154).
  if ((!prompt || prompt === '-') && !process.stdin.isTTY) {
    try { prompt = await readStdinPrompt(STDIN_TIMEOUT_MS); }
    catch (e) {
      status.finish({exit: 1, ok: false, error: e.message}); noteWriteError();
      if (json) { out({type: 'result', ok: false, error: e.message, duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1; return; }
      throw e;
    }
    prompt = prompt.trim();
    if (prompt.charCodeAt(0) === 0xfeff) prompt = prompt.slice(1).trim(); // a BOM from PowerShell redirection
    if (prompt) status.update({prompt: prompt.slice(0, 500)});
  }
  if (!prompt || prompt === '-') {
    status.finish({exit: 1, ok: false, error: t('exec には指示が必要です。')}); noteWriteError();
    if (json) { out({type: 'result', ok: false, error: t('exec には指示が必要です。'), duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1; return; }
    throw new Error(t('exec には指示が必要です。'));
  }
  let agent;
  try {
    ({agent} = await connect(o, s => err('· ' + s)));
  } catch (e) {
    status.finish({exit: 1, ok: false, error: e.message}); noteWriteError();
    if (!json) throw e;
    out({type: 'result', ok: false, error: e.message, duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1; return;
  }
  status.update({session: agent.session.id, account: agent.accountId, mode: agent.mode, cwd: agent.cwd});
  // The plan of the account this run is on (connect may have picked or failed over to one that
  // is not the default): usage.plan() alone read the default account's week.
  const planBefore = json ? usage.plan(agent.web).catch(() => null) : null;
  agent.approver = async call => {
    err(t('  ✗ 確認が必要なので断りました: {command} {summary}', {command: call.command, summary: call.summary || ''}));
    return {allow: false, reason: 'headless run; the user can allow this with --mode auto-edit or bypass'};
  };
  const tool = call => {
    status.tool(call);
    err((call.ok ? '  ✓ ' : '  ✗ ') + call.command + ' ' + String(call.summary || '').slice(0, 120));
    if (json) out({type: 'tool', agent: call.agent || 'main', command: call.command, summary: call.summary || '', ok: !!call.ok, ...(call.ok ? {} : {error: String(call.error || ''), ...(call.declined ? {declined: true} : {})})});
  };
  // Ctrl+C killed the process and left Muse working on the turn (and spending the allowance).
  process.once('SIGINT', async () => {
    err(t('Muse の作業を止めています…'));
    await agent.cancelAll().catch(() => {});
    agent.close();
    status.finish({state: 'interrupted', exit: 130, ok: false, session: agent.session.id, error: 'interrupted'});
    if (json) out({type: 'result', ok: false, session: agent.session.id, error: 'interrupted', duration_ms: Date.now() - t0, status_file: status.file});
    process.exit(130);
  });
  // SIGTERM gets the same cleanup (recovery scan): ExecStatus's own SIGTERM path
  // finishes the file and exits, which left the turn running server-side — exactly
  // what the SIGINT handler above exists to prevent.
  process.once('SIGTERM', async () => {
    err(t('Muse の作業を止めています…'));
    await agent.cancelAll().catch(() => {});
    agent.close();
    status.finish({state: 'interrupted', exit: 143, ok: false, session: agent.session.id, error: 'interrupted'});
    if (json) out({type: 'result', ok: false, session: agent.session.id, error: 'interrupted', duration_ms: Date.now() - t0, status_file: status.file});
    process.exit(143);
  });
  agent.on('tool-end', tool);
  agent.on('agent-tool', tool);
  agent.on('progress', report => { status.progress(report); if (json) out({type: 'progress', ...report}); else err((report.agent !== 'main' ? '[' + report.agent + '] ' : '') + report.message); });
  agent.on('focus', focus => { status.update({focus: focus || null}); if (json) out({type: 'focus', focus}); });
  agent.on('todos', todos => status.todos(todos));
  agent.on('muse-step', s => { status.step(s); if (json) for (const x of s.items || [s]) out({type: 'muse_step', title: x.title, ...(x.detail ? {detail: x.detail} : {}), ...(x.failed ? {failed: true} : {})}); });
  if (json) out({type: 'start', session: agent.session.id, cwd: agent.cwd, mode: agent.mode, status_file: status.file});
  let sources = [], turnUsage = null;
  agent.on('turn-end', e => { if (e?.sources) sources = e.sources; if (e?.usage) turnUsage = e.usage; });
  try {
    const reply = await agent.send(prompt);
    if (reply.focus && reply.focus.status !== 'complete') process.exitCode = 2;
    let text = reply.text;
    try { const {stripEmbeds} = await import('../src/ui/sanitize.mjs'); text = stripEmbeds(text); } catch {}
    text = require('../src/turn-usage').strip(text); // a [usage] line never reaches exec output or its status file
    const finalUsage = turnUsage || reply.usage || null;
    status.finish({exit: process.exitCode || 0, ok: true, session: agent.session.id, reply: text.trim(), ...(finalUsage ? {usage: finalUsage} : {}), 
      ...(reply.focus ? {completed: reply.focus.status === 'complete', focus: reply.focus} : {}), sources: sources.map(s => ({label: s.label, uri: s.uri}))});
    noteWriteError();
    // Plain output never said which conversation this was: --session continues it.
    err(t('続きは: muser exec --session {id} "…"', {id: agent.session.id}));
    if (!json) {
      process.stdout.write(text.trim() + '\n');
      if (reply.focus) err(t('Focus 判定: {status} · {reason}', {status: reply.focus.status, reason: reply.focus.reason}));
      // The interactive UI shows sources under the reply; plain exec dropped them entirely.
      if (sources.length) process.stdout.write('\n' + t('出典:') + '\n' + sources.map((s, i) => '  ' + (i + 1) + '. ' + (s.label || s.domain || '') + (s.uri ? '  ' + s.uri : '')).join('\n') + '\n');
      return;
    }
    const [before, after] = await Promise.all([planBefore, usage.plan(agent.web).catch(() => null)]);
    out({type: 'result', ok: true, session: agent.session.id, status_file: status.file, reply: text.trim(), sources: sources.map(s => ({label: s.label, uri: s.uri})), ...(finalUsage ? {turnUsage: finalUsage} : {}), 
      ...(reply.focus ? {completed: reply.focus.status === 'complete', focus: reply.focus} : {}),
      duration_ms: Date.now() - t0, ...(before || after ? {usage: {week_percent_before: before?.percentUsed ?? null, week_percent_after: after?.percentUsed ?? null}} : {})});
  } catch (e) {
    status.finish({exit: 1, ok: false, session: agent.session.id, error: e.message}); noteWriteError();
    if (!json) throw e;
    out({type: 'result', ok: false, session: agent.session.id, error: e.message, duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1;
  } finally { agent.close(); }
}

// Third front-end (docs/gui-protocol.md): interactive()'s assembly — onboard, prepare —
// with the Ink view replaced by GuiServer. The Controller is hosted as-is: it only ever
// needed an agent and its subscribe/get store, never the view (view.mjs subscribes to it
// and forwards keys), so nothing in the TUI's behaviour changes. /reload is not offered
// here (no onReload callback: the Controller says so itself, as in demo).
//
// v5 (remote/SERVER.md step 1): serve is the resident Muser Server. It hosts every
// open conversation (SessionsHost), the conversation it starts with is the default
// the unprefixed GUI API points at, and further conversations open through the API.
// A second `muser serve` attaches to the running server instead of rivalling it
// (unless --port or --demo asks for a standalone one). The standalone interactive
// CLI is untouched by all of this.
async function serve(o) {
  if (o.port != null && o.port > 65535) throw new Error(t('--port は 65535 以下の整数を指定してください（0 で空きポート）。'));
  // The language picker is a terminal UI (fifth c2-1): serve/link pair are often
  // launched piped (a script, a launcher), where the clack select never answers
  // and the command hung forever on a fresh home. Only ask on a real terminal;
  // piped, the default language applies and the GUI picks its own.
  if (i18n.chosen() === null && process.stdin.isTTY && process.stdout.isTTY) await require('../src/tui/onboard').askLanguage();
  const {Controller} = await import('../src/ui/controller.mjs');
  const {GuiServer} = require('../src/gui-server');
  // --demo: the GUI's look with nothing real behind it — the scripted DemoAgent of `muser demo`,
  // no login, no Muse, nothing sent anywhere. Muse's name is the one seen last time.
  // Demo keeps the single-conversation server: there is nothing to reside over.
  if (o.demo) {
    const {DemoAgent} = await import('../src/ui/demo.mjs');
    const agent = new DemoAgent(o.cwd || process.cwd());
    if (o.mode) agent.mode = o.mode;
    let server;
    const stop = async () => {
      await server?.close().catch(() => {});
      if (agent.busy && agent.cancelAll) await agent.cancelAll().catch(() => {});
      agent.close(); setTimeout(() => process.exit(0), 50);
    };
    const ctrl = new Controller({agent, museName: lastMuseName(), version: VERSION, onExit: stop});
    server = new GuiServer({controller: ctrl, agent, token: require('node:crypto').randomBytes(32).toString('hex'), port: o.port});
    await server.start();
    console.log(t('GUI サーバーを起動しました: {url}', {url: server.url}));
    console.log(t('接続情報（token）は ~/.muser/gui.json にあります。止めるときは ctrl+c。'));
    console.log(t('デモです（Muse にはつながず、何も送りません）。'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  // Double-start prevention: a live server in ~/.muser/server.json that answers
  // /api/server gets the conversation this invocation asked for, and we exit.
  const discovery = require('../src/server/discovery');
  if (o.port == null) {
    const info = discovery.readServer();
    const live = info && await discovery.probeServer(info);
    if (live) {
      // The same protocol gate as --client (recovery scan): attaching to an
      // incompatible resident server failed obscurely mid-session instead.
      if ((live.protocol ?? 5) !== 6) throw new Error(t('動いている Muser Server のプロトコル {p} には対応していません（この muser はプロトコル 6 です）。`muser server stop` してから起動し直すか、--client を外してください。', {p: live.protocol ?? 5}));
      let sessionId;
      if (o.resume || o.continue) { const target = sessionFromFlags(o); sessionId = target?.id; }
      const opened = await discovery.attachSession(info, {cwd: o.cwd, account: o.account, mode: o.mode, sessionId, maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal, noFocus: o.noFocus});
      console.log(t('Muser Server はすでに動いています（pid {pid}）。そのサーバーで会話を開きました: {id}', {pid: info.pid, id: opened.id}));
      // Link flags name THIS process's server; an attached one keeps its own
      // settings. Say so instead of silently ignoring them (recovery scan).
      // The agent limits / Focus flag are the same (first audit #32): they are
      // offered to attachSession above, but a resident server keeps the settings
      // it was started with until discovery/sessions-host learn to take them.
      if (o.noLink || o.noLan || o.relay || o.maxAgents != null || o.maxAgentsTotal != null || o.noFocus) console.log(t('すでに動いている Server につなぎました。--relay / --no-link / --no-lan / --max-agents / --max-agents-total / --no-focus はその Server の設定が使われます。'));
      // A pairing armed by `muser link pair` starts through the live server's
      // API instead of being dropped (deep c3 #7a): the earlier probe in
      // linkCommand may simply have raced this server's start.
      if (pendingPairing) {
        const mode = pendingPairing; pendingPairing = null;
        try {
          if (!live.link) throw new Error(t('動いている Server でスマホ連携が有効になっていません（--no-link で起動された可能性があります）。'));
          const resp = await discovery.request(info, 'POST', '/api/server/link/pair', {mode});
          if (resp.status !== 200 || !resp.json?.code) throw new Error(resp.json?.error || t('ペアリングを開始できませんでした（サーバー応答: {status}）', {status: resp.status}));
          await printPairingResult(mode, resp.json);
        } catch (e) { console.log(t('ペアリングを開始できませんでした: {message}', {message: e.message})); process.exitCode = 1; }
      }
      return;
    }
  }
  await onboardFor(o);
  const {agent, museName} = await prepare(o);
  const {SessionsHost} = require('../src/server/sessions-host');
  const token = require('node:crypto').randomBytes(32).toString('hex'); // 32 bytes, per process
  let server, host, linkRef = null, stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await linkRef?.stop().catch(() => {});
    await server?.close().catch(() => {});
    // Leaving mid-turn only closed the sockets: Muse went on working for nobody.
    await host?.closeAll().catch(() => {});
    setTimeout(() => process.exit(0), 50);
  };
  // Behind the server, like the TUI's connect-behind-the-screen: the gateway and the
  // device link connect here; then Muse's current name is remembered for next time.
  const wireConversation = (ag, ctrl, {resumed = false} = {}) => {
    if (resumed && ag.session?.turns) ctrl.showResumed(ag.session, {startup: true});
    (async () => {
      await ag.ensureConnected();
      const r = await ag.client.request('GET', '/identity').catch(() => null);
      const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : null;
      if (name) { rememberMuseName(name, ag.accountId); if (name !== ctrl.museName) { ctrl.museName = name; ctrl.set({}); } }
    })().catch(() => {});
    setTimeout(() => { try { ctrl.refreshPlan(); } catch {} }, 1500);
  };
  // /exit in a hosted conversation closes that conversation only — the resident
  // server (and the other front-ends on it) stays up. When the last conversation
  // goes, the server goes with it.
  const makeController = (ag, name) => new Controller({agent: ag, museName: name, version: VERSION, onExit: async () => {
    const id = ag.session?.id;
    if (id && host?.get(id)) {
      if (ag.busy && ag.cancelAll) await ag.cancelAll().catch(() => {});
      host.close(id, {force: true});
      if (!host.size) await stop();
    } else await stop();
  }});
  host = new SessionsHost({create: async ({cwd, account, mode, session}) => {
    // A conversation opened through the API onboards its own account first (its
    // login window opens if that account's login lapsed), like a window would.
    let accountId;
    if (account) { const a = require('../src/accounts').resolve(account); if (!a) throw new Error(t('アカウントが見つかりません: {id}', {id: account})); accountId = a.id; }
    // Third H3: session === 'new' is the explicit-new sentinel, not a stored
    // session — it has no account of its own (the pool/flag logic below runs).
    else if (session && session !== 'new') accountId = session.account || 'default';
    // No fixed account: onboardFor's pool logic decides whose login to check
    // (a lapsed default login is no reason to open its window when the pool
    // would start on another ready account).
    if (accountId === undefined) await onboardFor({...o, account: undefined, resume: undefined, continue: false});
    else await onboard({accountId});
    const built = await prepare(o, {cwd, account, mode, session});
    const ctrl = makeController(built.agent, built.museName);
    wireConversation(built.agent, ctrl, {resumed: !!session && session !== 'new'}); // Third H3: 'new' resumed nothing
    return {agent: built.agent, controller: ctrl, museName: built.museName};
  }});
  const defCtrl = makeController(agent, museName);
  host.addPrepared({agent, controller: defCtrl, museName, isDefault: true});
  server = new GuiServer({host, token, port: o.port, version: VERSION, serverDiscoveryFile: discovery.serverFile(), onStop: stop});
  // A failed start must not strand the prepared agent (recovery scan): the
  // process would hang holding its MCP children and gateway client.
  try { await server.start(); } catch (e) { await host.closeAll().catch(() => {}); try { agent.close(); } catch {} throw e; }
  console.log(t('GUI サーバーを起動しました: {url}', {url: server.url}));
  console.log(t('接続情報（token）は ~/.muser/gui.json にあります。止めるときは ctrl+c。'));
  // muser link (remote/DESIGN.md): the phone link lives in the server — the
  // relay control socket out, a LAN listener, pairing. Its failure must never
  // take the server down: the GUI and CLI work without it.
  if (!o.noLink) {
    try {
      const {Link} = require('../src/link/link');
      const link = new Link({serve: {port: server.port, token}, relayUrl: o.relay || DEFAULT_RELAY_URL, lanPort: o.noLan ? null : undefined});
      server.link = link;
      linkRef = link;
      await link.start();
      const st = link.state();
      console.log(t('スマホ連携を開始しました（pcId: {pcId} / リレー: {relay} / LAN: {lan}）', {pcId: st.pcId, relay: st.relayConnected ? t('接続済み') : t('接続中'), lan: st.lan.length ? st.lan.join(', ') : t('なし')}));
      // Pairing is a separate step from starting the link (deep c3 #7b): its
      // failure used to be reported as "link could not start" although the link
      // was up, and no code/QR was shown. Say which step failed.
      if (pendingPairing) {
        const mode = pendingPairing; pendingPairing = null;
        try { const p = link.startPairing({mode}); await printPairing(link, mode, p); }
        catch (e) { console.log(t('ペアリングを開始できませんでした: {message}', {message: e.message})); }
      }
    } catch (e) { console.log(t('スマホ連携を開始できませんでした: {message}', {message: e.message})); }
  }
  wireConversation(agent, defCtrl, {resumed: true});
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// `muser server`: serve under its resident name, plus status / stop / autostart.
// status and stop talk to the running server through its discovery file; neither
// prints the token.
async function serverCommand(rest, o) {
  const sub = rest[0];
  if (!sub) { if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')})); return serve(o); }
  // status / stop take no further words, autostart exactly one (first audit #31).
  if ((sub === 'status' || sub === 'stop') && rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
  if (sub === 'autostart' && rest.length > 2) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(2).join(' ')}));
  const discovery = require('../src/server/discovery');
  if (sub === 'status') {
    const info = discovery.readServer();
    const live = info && await discovery.probeServer(info);
    if (!live) return console.log(t('Muser Server は動いていません。'));
    console.log(t('Muser Server: pid {pid} / port {port} / version {version} / 起動 {at}', {pid: live.pid, port: live.port, version: live.version, at: new Date(live.startedAt).toLocaleString()}));
    for (const s of live.sessions || []) console.log('  ' + s.id.slice(0, 8) + '  ' + (s.busy ? t('作業中') : t('待機中')) + (s.approval ? ' / ' + t('承認待ち') : '') + (s.isDefault ? ' / ' + t('既定') : '') + '  ' + (s.cwd || ''));
    try { console.log(require('../src/usage').formatSummary()); } catch {}
    return;
  }
  if (sub === 'stop') {
    const info = discovery.readServer();
    const live = info && await discovery.probeServer(info);
    if (!live) return console.log(t('Muser Server は動いていません。'));
    const busy = (live.sessions || []).filter(s => s.busy);
    if (busy.length) {
      if (!process.stdin.isTTY) throw new Error(t('作業中の会話があるため止められません（端末から `muser server stop` を実行すると確認できます）。'));
      const {createInterface} = require('node:readline');
      const rl = createInterface({input: process.stdin, output: process.stdout});
      // stdin closing (Ctrl+D, terminal gone) resolves as "no" (recovery scan):
      // the bare question promise never settled and the command hung forever.
      const answer = await new Promise(r => { let done = false; const fin = v => { if (!done) { done = true; r(v); } }; rl.question(t('作業中の会話が {n} 件あります。止めますか？ [y/N] ', {n: busy.length}), fin); rl.on('close', () => fin('')); });
      rl.close();
      if (!/^y(es)?$/i.test(String(answer).trim())) return console.log(t('止めませんでした。'));
    }
    // The stop is only claimed when it happened (recovery scan): the response
    // status used to go unchecked and even a failed fallback kill was swallowed,
    // so a server believed stopped could still be running.
    const res = await discovery.request(info, 'POST', '/api/server/stop', {}).catch(() => null);
    if (!res || res.status >= 400) {
      // The fallback kill must only ever hit the process the probe just verified
      // (deep c3 #6): a stale or edited discovery file's pid can name an unrelated
      // process after pid reuse. (probeServer already refuses a pid mismatch;
      // this is the last check before the signal, including a race in between.)
      if (live.pid !== info.pid) throw new Error(t('Server の pid が発見ファイルと一致しないため、強制終了はしませんでした。'));
      let killed = false, gone = false;
      try { process.kill(info.pid, 'SIGTERM'); killed = true; } catch (e) { if (e?.code === 'ESRCH') gone = true; } // already exited: stopped, not a failure
      if (!killed && !gone) throw new Error(t('Muser Server を止められませんでした。'));
    }
    return console.log(t('Muser Server を止めました。'));
  }
  if (sub === 'autostart') {
    const on = rest[1];
    if (on !== 'on' && on !== 'off') throw new Error(t('使い方: muser server autostart on|off'));
    const r = await require('../src/server/autostart').setAutostart(on === 'on', {binFile: __filename});
    return console.log(on === 'on' ? t('ログオン時に Muser Server を起動するようにしました（タスク: {task}）。', {task: r.task}) : t('ログオン時の自動起動を外しました。'));
  }
  throw new Error(t('「{word}」という server の操作はありません。使えるのは status / stop / autostart です', {word: sub}));
}

// `muser status`: every open window across every server discovery can find
// (the resident server and any standalone serve), one row per conversation.
// Unlike `muser server status` it adds no usage summary and looks past the
// resident server; the gathering and formatting live in src/server/status.js.
// Plain windows (src/window-status.js) and running exec runs too, not only the server's
// conversations. `muser status <pid | conversation id>` shows one in detail; --json prints the
// same as data for another agent (Claude Code, Codex).
async function statusCommand(rest, o) {
  if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
  const status = require('../src/server/status');
  const all = await status.gatherAll();
  const id = rest[0];
  if (!id) {
    if (o.json) return console.log(JSON.stringify(all, null, 1));
    for (const line of status.formatAll(all)) console.log(line);
    return;
  }
  const hit = status.find(all, id);
  if (!hit) { process.exitCode = 1; throw new Error(t('{id} に当たる窓はありません。muser status で一覧を見られます。', {id})); }
  if (hit.ambiguous) { process.exitCode = 1; throw new Error(t('{id} に当たるものが複数あります: {list} — もう少し長く指定してください', {id, list: hit.ambiguous.map(h => h.kind + ' ' + (h.item.pid || h.item.shortId)).join(', ')})); }
  if (o.json) return console.log(JSON.stringify(hit, null, 1));
  for (const line of status.formatDetail(hit)) console.log(line);
}

// Text that came from outside this process (a phone's device name, a conversation
// title) is printed by the list commands with plain console.log: strip control
// characters first, or an ESC sequence in a name/title runs on the user's
// terminal (OSC 52 clipboard writes, fake lines) when they merely list (deep c3 #4).
function safeLine(s) { return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' '); }

// Show a pairing: the QR (which carries everything) plus the code in plain
// text, or — for Wi-Fi pairing — the code alone, big enough to read aloud.
async function printPairing(link, mode, {code, expiresAt}) {
  const until = new Date(expiresAt).toLocaleTimeString();
  if (mode === 'wifi') {
    console.log(t('Wi-Fi ペアリングのコード: {code}（{until} まで有効）', {code, until}));
    console.log(t('スマホを同じ Wi-Fi につなぎ、アプリの「Wi-Fi」でこのコードを入れてください。'));
    return;
  }
  const {buildPairPayload} = require('../src/link/link');
  const payload = buildPairPayload({pcId: link.pcId, staticPub: link.keys.noise.publicKey, relay: link.relayUrl, code, name: require('node:os').hostname(), lan: link.lanAddresses()});
  try { console.log(await require('qrcode').toString(payload, {type: 'terminal', small: true})); } catch {}
  console.log(t('スマホのアプリでこの QR を読み取ってください（コード: {code}、{until} まで有効）', {code, until}));
  console.log(payload);
}

// Show a pairing a server started through its API ({code, expiresAt, payload}):
// the Wi-Fi code alone, or the QR plus the code in plain text.
async function printPairingResult(mode, r) {
  const until = new Date(r.expiresAt).toLocaleTimeString();
  if (mode === 'wifi') {
    console.log(t('Wi-Fi ペアリングのコード: {code}（{until} まで有効）', {code: r.code, until}));
    console.log(t('スマホを同じ Wi-Fi につなぎ、アプリの「Wi-Fi」でこのコードを入れてください。'));
    return;
  }
  try { console.log(await require('qrcode').toString(r.payload, {type: 'terminal', small: true})); } catch {}
  console.log(t('スマホのアプリでこの QR を読み取ってください（コード: {code}、{until} まで有効）', {code: r.code, until}));
  console.log(r.payload);
}

// `muser link`: the phone link that lives inside the resident server. When the
// server is up, everything goes through its local API; when it is down, list /
// revoke still work on the local files, and pair starts the server with the
// pairing armed.
async function linkCommand(rest, o) {
  const sub = rest[0];
  const discovery = require('../src/server/discovery');
  const info = discovery.readServer();
  const live = info && await discovery.probeServer(info).catch(() => null);
  if (sub === 'pair') {
    if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
    // --no-link disables the link itself (recovery scan): the pairing was armed
    // and then silently never consumed, and the command became a plain server.
    if (o.noLink) throw new Error(t('--no-link のためペアリングできません。'));
    const mode = o.wifi || rest.includes('--wifi') ? 'wifi' : 'qr';
    if (live) {
      if (!live.link) throw new Error(t('動いている Server でスマホ連携が有効になっていません（--no-link で起動された可能性があります）。'));
      const resp = await discovery.request(info, 'POST', '/api/server/link/pair', {mode});
      if (resp.status !== 200 || !resp.json?.code) throw new Error(resp.json?.error || t('ペアリングを開始できませんでした（サーバー応答: {status}）', {status: resp.status}));
      await printPairingResult(mode, resp.json);
      return;
    }
    pendingPairing = mode;
    return serve(o);
  }
  if (sub === 'revoke') {
    const name = rest.slice(1).join(' '); // device names can contain spaces
    if (!name) throw new Error(t('使い方: muser link revoke <名前>'));
    if (live?.link) {
      // A rejected revoke used to print success anyway (recovery scan), leaving
      // a phone the user believes revoked still paired.
      const resp = await discovery.request(info, 'POST', '/api/server/link/revoke', {name});
      if (resp.status !== 200) throw new Error(resp.json?.error || t('ペアリングを取り消せませんでした（サーバー応答: {status}）', {status: resp.status}));
    } else {
      const removed = require('../src/link/remote-store').remove(name);
      if (!removed) throw new Error(t('「{name}」というペアリング済み端末はありません。', {name}));
    }
    return console.log(t('「{name}」のペアリングを取り消しました。', {name}));
  }
  if (sub === 'autostart') {
    if (rest.length > 2) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(2).join(' ')}));
    const on = rest[1];
    if (on !== 'on' && on !== 'off') throw new Error(t('使い方: muser link autostart on|off'));
    const r = await require('../src/server/autostart').setAutostart(on === 'on', {binFile: __filename});
    return console.log(on === 'on' ? t('ログオン時に Muser Server を起動するようにしました（タスク: {task}）。', {task: r.task}) : t('ログオン時の自動起動を外しました。'));
  }
  if (!sub || sub === 'status') {
    if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
    const st = live?.link || null;
    let pcId = st?.pcId, devices = st?.devices || [];
    if (!st) {
      try { pcId = require('../src/link/keys').loadLinkKeys()?.pcId; } catch {} // read-only: viewing status must not mint keys
      try { devices = require('../src/link/remote-store').list().map(d => ({id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen})); } catch {}
    }
    console.log(t('スマホ連携: {state}', {state: st ? t('Server で動作中') : t('Server は停止中')}));
    if (pcId) console.log('  pcId: ' + pcId);
    if (st) console.log('  ' + t('リレー: {relay}', {relay: st.relayConnected ? t('接続済み') : t('接続中')}) + ' / LAN: ' + (st.lan?.length ? st.lan.join(', ') : t('なし')));
    if (!devices.length) console.log('  ' + t('ペアリング済みの端末はありません（muser link pair で追加できます）'));
    for (const d of devices) console.log('  ' + safeLine(d.name) + '  (' + d.id.slice(0, 8) + ' / ' + t('最終接続: {at}', {at: d.lastSeen ? new Date(d.lastSeen).toLocaleString() : t('まだなし')}) + ')');
    return;
  }
  throw new Error(t('「{word}」という link の操作はありません。使えるのは pair / revoke / autostart です', {word: sub}));
}

async function main() {
  const o = parse(process.argv.slice(2));
  const [rawCmd, ...rest] = o._;
  // After a leading `--` every word is the prompt (audit #29): a word spelled
  // like a subcommand dispatches nothing and starts the conversation instead.
  const cmd = o.literal ? undefined : rawCmd;
  if (o.version) return console.log(VERSION);
  if (o.help || cmd === 'help') return process.stdout.write(HELP_LINES.map(l => t(l, {version: VERSION})).join('\n'));
  // The same spellings as /mode (--mode Bypass, --mode auto).
  if (o.mode !== undefined && !(o.mode = require('../src/policy').modeFrom(o.mode))) throw new Error(t('--mode は default / auto-edit / plan / bypass のどれかです。'));
  // MUSER_CLIENT steers only the interactive entry (no subcommand, a prompt, or resume):
  // a shell that inherited the variable (e.g. one opened from inside a client window)
  // must still be able to run `muser doctor` or `muser server status` — the variable used
  // to throw every subcommand into the client error (audit #248). The spellings 1 / true /
  // yes / on all count; anything else is off. An explicit --client with a real subcommand
  // is still an error, but a prompt is not a subcommand: `muser --client "fix the bug"`
  // used to throw that error and never reach clientInteractive (audit #247).
  const isCommand = !!cmd && COMMAND_NAMES.includes(cmd);
  if (!o.client && /^(1|true|yes|on)$/i.test(process.env.MUSER_CLIENT || '') && !isCommand) o.client = true;
  if (o.client && isCommand && cmd !== 'resume') throw new Error(t('--client は対話モード専用です（exec / serve などとは併用できません）。'));
  // Flags that mean something for only one command used to be silently ignored by the
  // others (`muser --json <prompt>` started interactively; audit #250). Say so instead.
  // (--port's range is checked in parse(), so it is caught for every command.)
  const scoped = [
    ['--json', o.json, ['exec', 'status']],
    ['--status', o.status !== undefined, ['exec']],
    ['--status-file', o.statusFile !== undefined, ['exec']],
    ['--port', o.port !== undefined, ['serve', 'server', 'link']],
    ['--relay', o.relay !== undefined, ['serve', 'server', 'link']],
    ['--no-link', o.noLink, ['serve', 'server', 'link']],
    ['--no-lan', o.noLan, ['serve', 'server', 'link']],
    ['--wifi', o.wifi, ['link']],
    ['--demo', o.demo, ['serve', 'server']],
    // The session selectors (first audit #30): doctor diagnosed the default
    // account and logout logged out the default account while a --session named
    // another conversation — both silently. They select a conversation for the
    // interactive / exec / serve paths (and the server that hosts them) only.
    ['--session', o.resume !== undefined, [undefined, 'exec', 'resume', 'serve', 'server', 'link']],
    ['--continue', !!o.continue, [undefined, 'exec', 'resume', 'serve', 'server', 'link']],
  ];
  for (const [flag, set, okFor] of scoped) {
    if (set && !okFor.includes(cmd)) throw new Error(t('{flag} はこの使い方では使えません。使い方: muser --help', {flag}));
  }
  // Trailing words are silently ignored by these subcommands (recovery scan):
  // `muser logout typo` logged out anyway. Ones that take no words say so.
  const noExtra = () => { if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')})); };
  if (cmd === 'login') { noExtra(); return onboard({forceLogin: true, accountId: accountFromFlag(o)?.id}); }
  if (cmd === 'logout') { noExtra();
    // The default account, like `muser login`: without --account this logged out the FIRST
    // account whichever one was the default.
    const accounts = require('../src/accounts');
    const a = accountFromFlag(o) || accounts.get(accounts.activeId());
    require('../src/login').logout(accounts.filesFor(a.id));
    return console.log(accounts.list().length > 1 ? t('{label} からログアウトしました。', {label: a.label}) : t('ログアウトしました。'));
  }
  if (cmd === 'pc-login') { noExtra(); return onboard({forceDevice: true, accountId: accountFromFlag(o)?.id}); }
  if (cmd === 'account') return accountCommand(rest, o);
  if (cmd === 'agent-skill') return agentSkillCommand(rest);
  if (cmd === 'doctor') { noExtra(); return doctor(accountFromFlag(o)); }
  if (cmd === 'usage') { noExtra();
    const usage = require('../src/usage');
    const pool = require('../src/account-pool');
    if (pool.multi()) {
      const all = await pool.statuses();
      for (const s of all) {
        console.log((s.id === require('../src/accounts').activeId() ? '● ' : '○ ') + s.label + (s.id === require('../src/accounts').activeId() ? t('（既定）') : ''));
        if (s.plan) console.log(usage.formatPlan(s.plan));
        else console.log(s.hasLogin ? t('Muse の利用状況を読み込めませんでした（muse.ai で確認できます）') : t('ログインしていません（`muser account add <名前>` で追加できます）'));
        console.log('');
      }
    } else {
      try { console.log(usage.formatPlan(await usage.plan()) + '\n'); } catch (e) { console.log(t('Muse の利用状況: {message}', {message: e.message}) + '\n'); }
    }
    return console.log(usage.formatSummary());
  }
  if (cmd === 'demo') {
    if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
    const d = await import('../src/ui/demo.mjs');
    if (rest[0] && rest[0] !== 'login') {
      // An unknown demo word used to start the plain demo as if nothing was wrong.
      if (nearCommand(rest[0]) === 'login') throw new Error(t('「{word}」というデモはありません。もしかして: muser demo login', {word: rest[0]}));
      throw new Error(t('「{word}」というデモはありません。使えるのは muser demo と muser demo login です', {word: rest[0]}));
    }
    return rest[0] === 'login' ? d.demoLogin({version: VERSION, cwd: o.cwd, mode: o.mode}) : d.demo({version: VERSION, cwd: o.cwd, mode: o.mode});
  }
  // Words after these commands were silently dropped (first audit #31): a
  // status read with prompt words ran no prompt, serve ignored its tail.
  if (cmd === 'exec' && o.status) { noExtra(); return execStatus(o.status, o); }
  if (cmd === 'exec') return exec(o, rest.join(' '));
  if (cmd === 'serve') { noExtra(); return serve(o); }
  if (cmd === 'server') return serverCommand(rest, o);
  if (cmd === 'status') return statusCommand(rest, o);
  if (cmd === 'link') return linkCommand(rest, o);
  if (cmd === 'resume') {
    if (!rest[0]) {
      const list = require('../src/sessions').recent().filter(s => s.turns).slice(0, 20);
      // One wording for "nothing to resume" at every bin entry, with the way
      // forward (fourth M24; the TUI /resume side is controller.mjs's own text).
      if (!list.length) return console.log(t('再開できる会話はありません。新しい会話は `muser` を引数なしで実行すると始められます。'));
      // The dimming goes through term.c like the rest of the UI: the raw escapes were printed
      // even into a pipe or with colours off (NO_COLOR / the color setting).
      const {c} = require('../src/tui/term');
      for (const s of list) console.log(s.id.slice(0, 8) + '  ' + new Date(s.updated).toLocaleString().padEnd(22) + safeLine(s.title || '') + '  ' + c.dim(safeLine(s.cwd)));
      return console.log('\n' + t('muser resume <ID> で再開'));
    }
    o.resume = rest[0];
    const prompt = rest.slice(1).join(' ') || undefined;
    return o.client ? clientInteractive(o, prompt) : interactive(o, prompt);
  }
  // `muser doctro` used to go to Muse as a one-word prompt. A single word close to a command is a typo.
  const near = cmd && o._.length === 1 ? nearCommand(cmd) : null;
  if (near) throw new Error(t('「{word}」というコマンドはありません。もしかして: muser {near}（Muse に頼むなら文章で書いてください）', {word: cmd, near}));
  if (o.client) return clientInteractive(o, o._.join(' ') || undefined);
  return interactive(o, o._.join(' ') || undefined);
}

const COMMAND_NAMES = ['login', 'logout', 'pc-login', 'doctor', 'usage', 'demo', 'exec', 'serve', 'server', 'status', 'link', 'resume', 'help', 'account', 'agent-skill'];

// `muser exec --status [file]`: a few lines on a run (src/exec-status.js summary), for an agent
// polling it; the exit code says running (4) / gone (5) / the run's own result.
function execStatus(ref, o = {}) {
  const s = require('../src/exec-status');
  const file = ref === true ? s.latest() : require('node:path').resolve(ref);
  let v;
  try { if (!file) throw new Error('no run'); v = s.read(file); }
  catch {
    // --json stays JSON even when there is no run to read (fifth c2-3): a
    // polling script's most common case used to get plain text and fail to parse.
    if (o.json) console.log(JSON.stringify({state: 'gone', ok: false, error: 'no status file', file: file || null}, null, 1));
    else console.log('gone · no status file' + (file ? ': ' + file : ' in ' + s.dir()));
    process.exitCode = s.GONE; return;
  }
  // --json was silently ignored here (recovery scan): a script asking for data
  // gets the status object itself; the exit code keeps its meaning either way.
  if (o.json) console.log(JSON.stringify(v, null, 1));
  else console.log(s.summary(v));
  process.exitCode = s.code(v);
}
// `muser agent-skill [install|remove] [claude|codex]`: muser's skill for other agents (src/agent-skill.js).
function agentSkillCommand(rest) {
  if (rest.length > 2) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(2).join(' ')}));
  const s = require('../src/agent-skill');
  const [sub = 'status', which] = rest;
  if (!['status', 'install', 'remove'].includes(sub)) throw new Error(t('使い方: muser agent-skill [install|remove] [claude|codex]'));
  if (which && !['claude', 'codex'].includes(which)) throw new Error(t('使い方: muser agent-skill [install|remove] [claude|codex]'));
  const agents = which ? [which] : ['claude', 'codex'];
  const label = r => (r.agent === 'claude' ? 'Claude Code' : 'Codex') + '  ' + r.path;
  const STATE = {installed: t('登録済み'), copy: t('登録済み（コピー。install で更新）'), missing: t('未登録'), broken: t('リンク切れ（install で直ります）'), foreign: t('同じ名前の別のスキルがあります（触りません）'), 'no-agent': t('このエージェントは見つかりません')};
  const DONE = {kept: t('登録済み'), link: t('登録しました'), copy: t('登録しました（コピー）'), skipped: null, removed: t('外しました'), none: null, failed: null};
  if (sub === 'status') {
    for (const r of s.status().filter(r => agents.includes(r.agent))) console.log(label(r) + '  ' + STATE[r.state]);
    return console.log('\n' + t('登録: muser agent-skill install　外す: muser agent-skill remove（claude / codex で片方だけ）'));
  }
  const rows = sub === 'install' ? s.install({agents}) : s.remove({agents});
  for (const r of rows) {
    const msg = r.done === 'failed' ? t('失敗しました: {error}', {error: r.error}) : DONE[r.done] || STATE[r.state];
    console.log(label(r) + '  ' + msg);
  }
  if (rows.some(r => r.done === 'failed')) process.exitCode = 1;
  if (sub === 'install' && rows.some(r => r.done === 'link' || r.done === 'copy')) console.log('\n' + t('Claude Code・Codex は次に起動したときからこのスキルを読みます。'));
}

// `muser account …`: the pool's housekeeping. No argument lists every account with its
// login/device state and weekly use; add walks the new account through login and device
// registration right away (that is what makes it usable by the pool).
async function accountCommand(rest, o) {
  const accounts = require('../src/accounts');
  const pool = require('../src/account-pool');
  const [sub, ...args] = rest;
  if ((!sub && args.length) || (sub === 'list' && args.length)) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: args.join(' ')}));
  if (sub === 'auto' && args.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: args.slice(1).join(' ')}));
  if (!sub || sub === 'list') {
    const all = await pool.statuses();
    if (all.length <= 1 && !accounts.hasLogin(accounts.DEFAULT_ID)) console.log(t('ログインしていません（`muser login` でログインできます）'));
    for (const s of all) {
      const state = !s.hasLogin ? t('ログインなし') : !s.device ? t('端末登録なし') : t('利用できます');
      const use = s.plan ? t('週 {n}%', {n: s.plan.percentUsed ?? '?'}) : '';
      console.log((s.id === accounts.activeId() ? '● ' : '○ ') + s.label + '  ' + state + (use ? '  ' + use : ''));
    }
    console.log('\n' + t('自動選択: {state}（`muser account auto on/off`、`--account <名前>` で個別指定もできます）', {state: pool.autoEnabled() ? 'on' : 'off'}));
    return;
  }
  if (sub === 'add') {
    const label = args.join(' ').trim();
    if (!label) throw new Error(t('使い方: muser account add <名前>'));
    const a = accounts.add(label);
    console.log(t('アカウント {label} を追加します。', {label: a.label}));
    // A login window closed (or timed out) left the name registered with nothing behind it, and
    // `muser account add` with the same name then said it already existed.
    try { await onboard({forceLogin: true, forceDevice: true, accountId: a.id}); }
    catch (e) {
      if (!accounts.hasLogin(a.id)) { try { accounts.remove(a.id); } catch {} throw e; }
      // Login landed but device registration failed (first audit #33): the
      // half-registered account used to stay with no word on how to finish it,
      // and a re-add then just said the name already existed. Keep the login
      // (removing it would waste it) and name the finishing command.
      if (!accounts.hasDevice(a.id)) throw new Error(e.message + '\n' + t('アカウント {label} の端末登録が終わっていません。`muser login --account {id}` を実行すると、続きから行えます。', {label: a.label, id: a.id}));
      throw e;
    }
    // The same muse.ai user added under a second name is not a second allowance: the pool would
    // count one Muse twice. Said here, while the user can still remove it.
    const same = await pool.sameMuse(a.id).catch(() => null);
    if (same) console.log(t('注意: {label} は {other} と同じ muse.ai アカウント（同じ Muse）です。使用量は共通なので、別のアカウントでログインし直すか `muser account remove {id}` で消してください。', {label: a.label, other: same.label, id: a.id}));
    return;
  }
  if (sub === 'use') {
    // add takes the whole rest as the label; use/remove must resolve it whole
    // too (recovery scan) — a multi-word label could never be selected, and a
    // one-word account with the same first word was picked instead.
    const a = accounts.resolve(args.join(' ') || '');
    if (!a) throw new Error(t('アカウントが見つかりません: {id}', {id: args.join(' ') || ''}));
    accounts.setActive(a.id);
    return console.log(t('既定のアカウントを {label} にしました。', {label: a.label}));
  }
  if (sub === 'remove') {
    const a = accounts.resolve(args.join(' ') || '');
    if (!a) throw new Error(t('アカウントが見つかりません: {id}', {id: args.join(' ') || ''}));
    const {leftover} = accounts.remove(a.id) || {};
    console.log(t('アカウント {label} を削除しました（そのログイン情報も消しました）。', {label: a.label}));
    if (leftover) console.log(t('Edge のログイン用フォルダーを消せませんでした（Edge が開いたままかもしれません）: {dir}　閉じてから削除してください。残っていると、同じ名前で追加したときに前のログインが戻ります。', {dir: leftover}));
    return;
  }
  if (sub === 'auto') {
    if (!args[0]) return console.log(t('自動選択: {state}', {state: pool.autoEnabled() ? 'on' : 'off'}));
    if (args[0] !== 'on' && args[0] !== 'off') throw new Error(t('使い方: muser account auto on/off'));
    require('../src/config').update(cfg => { cfg.accountAuto = args[0] === 'on'; });
    return console.log(t('自動選択: {state}', {state: args[0]}));
  }
  throw new Error(t('使い方: muser account [list] / add <名前> / use <名前> / remove <名前> / auto on|off'));
}
// The command a word was probably meant to be: at most 2 edits away (a swap counts as one).
function nearCommand(word) {
  const w = String(word).toLowerCase();
  if (w.length < 3 || COMMAND_NAMES.includes(w)) return null;
  const dist = (a, b) => {
    const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  };
  let best = null, bestD = 3;
  for (const c of COMMAND_NAMES) { const x = dist(w, c); if (x < bestD && x < c.length / 2) { best = c; bestD = x; } }
  return best;
}

// Where a resumed chat runs: its own folder, or --cd when given. A folder deleted or moved since
// left every file and command of the chat failing; it is reported with the way out instead.
function sessionFolder(session, o) {
  if (!session || o.cdGiven) return o.cwd;
  // A stored session with no folder at all (a pre-cwd record) falls back to the
  // current folder (deep c3 #8): it used to fail with "…ありません: undefined".
  if (!session.cwd) return o.cwd;
  let ok = false; try { ok = require('node:fs').statSync(session.cwd).isDirectory(); } catch {}
  if (!ok) throw new Error(t('この会話のフォルダーがありません: {cwd}（別のフォルダーで続けるなら --cd <フォルダー> を付けてください）', {cwd: session.cwd}));
  return session.cwd;
}

// The session `muser resume <id>` names. A prefix that fits several sessions said "not found";
// it lists them instead.
function resumeTarget(sessions, ref) {
  const session = sessions.find(ref);
  if (session) return session;
  if (sessions.find.ambiguous) {
    const list = sessions.findAll(ref).slice(0, 10).map(s => '  ' + s.id + '  ' + (s.title || '') + '  ' + s.cwd);
    throw new Error([t('「{id}」に当てはまる会話が複数あります。もう少し長く指定してください:', {id: ref}), ...list].join(String.fromCharCode(10)));
  }
  throw new Error(t('会話が見つかりません: {id}', {id: ref}));
}

// Each check runs on its own: one failure used to abort doctor before the later checks (and
// their remedies) could even print, so the user saw a stack-free error and no way forward.
// account: the one --account names; the default account otherwise (the flag was accepted and ignored).
async function doctor(account) {
  const {createWeb, loadJar, probe} = require('../src/web');
  const accounts = require('../src/accounts');
  const id = account?.id || accounts.activeId();
  if (accounts.list().length > 1) console.log(t('アカウント    : {label}', {label: accounts.get(id)?.label || id}));
  const files = accounts.filesFor(id);
  // The remedies name the account checked: a bare `muser login` signs in the default one.
  const flag = id !== accounts.activeId() ? ' --account ' + id : '';
  const jar = loadJar(files.web);
  const web = createWeb(jar, {file: files.web});
  // The login state the first step finds decides the gateway step's remedy
  // (fifth c2-2): an expired login (probe 'waiting') used to get "check your
  // network" on the gateway line and no remedy at all on its own line, so the
  // one action that fixes it — `muser login` — was never named.
  let loginState = null;
  const loginRemedy = t('  → 直し方: `{cmd}` でログインし直してください', {cmd: 'muser login' + flag});
  const steps = [
    [async () => { loginState = await probe(jar, files.web); const line = t('Web ログイン  : {state}', {state: loginState}); return loginState === 'ready' ? line : line + '\n' + loginRemedy; }, loginRemedy, false, () => loginState !== null && loginState !== 'ready'],
    [async () => {
      const {connectChat} = require('../src/session');
      const client = await connectChat(web, {file: files.session});
      try { return t('ゲートウェイ  : 接続できました（会話 {n} 件）', {n: (await client.sessions())?.sessions?.length ?? '?'}); }
      finally { client.disconnect(false); }
    }, () => loginState && loginState !== 'ready' ? loginRemedy : t('  → 直し方: ネットワークを確認して、もう一度 `muser doctor` を実行してください')], 
    [async () => {
      const auth = require('../src/pc-login').createAuth(web, {file: files.device});
      const pc = auth.snapshot();
      return t('PC の端末     : {phase}', {phase: pc.phase + (pc.phase === 'authenticated' ? ' (vm ' + ((await auth.vm()).vm_id ? 'ok' : '?') + ')' : '')});
    }, t('  → 直し方: `{cmd}` でこの PC を端末として登録し直してください', {cmd: 'muser pc-login' + flag})],
    [async () => { const u = require('../src/usage').summary().today; return t('今日の利用    : {turns} ターン、PC 操作 {tools} 回', {turns: u.turns, tools: u.toolCalls}); }, t('  → 利用記録は読めませんでした（なくても作業はできます）'), true],
    [async () => {
      // Which windows are open and which node slot each holds (src/node-slots.js): the way
      // to see why a chat's calls land in a particular window.
      const fs = require('node:fs'), path = require('node:path');
      const {defaultDir, alive} = require('../src/relay');
      const dir = defaultDir();
      const {LOCK} = require('../src/node-slots');
      const locks = fs.readdirSync(dir).filter(n => LOCK.test(n)).map(n => { try { const m = LOCK.exec(n); return {slot: (m[1] ? m[1] + ' ' : '') + m[2], pid: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).pid}; } catch { return null; } }).filter(Boolean);
      if (!locks.length) return t('ウィンドウ    : 開いている muser はありません');
      return t('ウィンドウ    : {list}', {list: locks.map(l => t('窓 {slot}（pid {pid}{state}）', {slot: l.slot, pid: l.pid, state: alive(l.pid) ? '' : t('・終了済み')})).join('、')});
    }, t('  → ウィンドウ一覧は読めませんでした（なくても作業はできます）'), true],
  ];
  // A failed check is a failed doctor (recovery scan): the exit code used to be
  // 0 whatever happened, so scripts wrapping `muser doctor` could not detect a
  // broken login or device. The two informational steps (marked soft) do not
  // fail it — their remedies say the work goes on without them.
  let failed = false;
  for (const [run, remedy, soft, isBad] of steps) {
    try { console.log(await run()); if (isBad && isBad()) failed = true; }
    catch (e) { console.log(t('確認できませんでした: {error}', {error: e.message})); console.log(typeof remedy === 'function' ? remedy() : remedy); if (!soft) failed = true; }
  }
  if (failed) process.exitCode = 1;
}

// Node >= 22 is required (package.json engines); on an older Node the failure used to be a
// cryptic syntax / module error deep inside a dependency instead of this one clear line.
if (Number.parseInt(process.versions.node, 10) < 22) {
  console.error('muser: ' + t('Node.js 22 以上が必要です（今は {version}）。https://nodejs.org から新しい Node.js を入れてください。', {version: process.versions.node}));
  process.exit(1);
}
// The cursor comes back only on a terminal: piped (an agent reading `muser exec`), the escape was junk in its output.
main().catch(e => { if (process.stdout.isTTY) process.stdout.write('\x1b[?25h'); console.error('muser: ' + ((e && e.message) || String(e))); process.exitCode = 1; });
