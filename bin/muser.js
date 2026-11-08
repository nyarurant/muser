#!/usr/bin/env node
'use strict';
// Memory reduction stage 3 (docs/design/memory.md): bias V8 toward code size. On the
// stage-0 scenario this took the process from ~136 MB to ~80 MB Private Bytes with no
// measurable speed change, but only when set before any other module compiles — hence
// above every require. --max-semi-space-size measured as a no-op from here (the heap is
// already sized at startup), so it is not attempted; an explicit NODE_OPTIONS choice
// about this flag wins over the default.
if (!/optimize-for-size/.test(process.env.NODE_OPTIONS || '')) { try { require('v8').setFlagsFromString('--optimize-for-size'); } catch {} }
// libuv's thread pool (fs, dns.lookup, crypto, zlib) commits an 8 MB stack per thread on
// Windows: the default 4 threads were +32 MB Private Bytes on the first fs/dns call
// (measured 2026-11-05: 1 thread +10, 2 +18, 4 +34 MB). Two keep fs work going while a
// slow DNS lookup holds one. libuv reads the variable once, when the pool starts on the
// first queued work, so: set it, start the pool now, put the environment back — commands
// muser runs (npm test, MCP servers) keep Node's default. A user's own value wins.
if (process.env.UV_THREADPOOL_SIZE === undefined) {
  process.env.UV_THREADPOOL_SIZE = '2';
  try { require('fs').access(__filename, () => {}); } finally { delete process.env.UV_THREADPOOL_SIZE; }
}
// EPIPE (audit-cli wave 9): the reader at the other end of stdout going away
// (`muser exec ... | head`) is not a crash. A write to the closed pipe raises
// EPIPE, which used to land in the startup guard / the top-level catch, leave
// a crash record and flip a finished run's exit code to 1. The stdout 'error'
// listener below swallows the stream-level raise, and the startup guard is
// re-installed EPIPE-aware underneath, so an EPIPE that still surfaces as an
// uncaught error is neither recorded nor fatal: the process ends with the
// exit code already set (the one the status file carries).
function isEpipeError(e) { return !!e && (e.code === 'EPIPE' || /\bEPIPE\b/.test(String((e && e.message) || ''))); }
let stdoutBroken = false;
try { process.stdout.on('error', e => { if (isEpipeError(e)) stdoutBroken = true; }); } catch {}
// Startup guard (EXPORT.md stage 2): from here to the end of startup, a
// failure (a broken require, a syntax error, a missing dependency) still
// leaves a crash record and one short line, instead of nothing. Installed
// before every other require; src/startup-guard.js needs only the crash
// recorder, which is standard-library only. The TUI / Server crash
// handlers take over once a screen owns the process.
try {
  const guard = require('../src/startup-guard');
  guard.installStartupGuard({v: (() => { try { return require('../package.json').version; } catch { return ''; } })()});
  // Wave 9: the guard's own handlers record EVERY uncaught error, EPIPE
  // included. Replace them (nothing else has registered a handler yet) with
  // the same record-and-exit behaviour minus EPIPE: an EPIPE leaves no crash
  // record and does not exit 1 — the process drains and ends with the exit
  // code already set.
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  const onGuardFatal = e => { if (isEpipeError(e)) return; if (globalThis.__muserCrashHandledByApp) return; guard.recordStartupCrash(e); process.exit(1); };
  process.on('uncaughtException', onGuardFatal);
  process.on('unhandledRejection', onGuardFatal);
} catch {}
// `muser export` before anything else loads (EXPORT.md stage 2): the
// report exists for when the body will not start, so it runs in a child
// process whose entry (src/export-entry.js) reads no muser module before
// deciding — rich report when the body loads, a standard-library-only
// fallback when it does not. The first-word scan is the SGR scan's twin
// below; a leading `--` makes every word a prompt, never a command.
{
  const VALUED = ['--mode', '--cd', '--max-agents', '--max-agents-total', '--session', '--status-file', '--port', '--account', '--relay', '--window', '--agents', '--concurrent', '--fix', '--n', '--accounts', '--max-tokens', '--status', '--focus', '--why', '--event', '--hours', '--before', '--out', '--file'];
  const args = process.argv.slice(2);
  let first = null, firstAt = -1;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--') break; if (args[i].startsWith('--')) { const eqAt = args[i].indexOf('='); const name = eqAt >= 0 ? args[i].slice(0, eqAt) : args[i]; if (eqAt < 0 && VALUED.includes(name)) i++; continue; } if (args[i].startsWith('-')) continue; first = args[i]; firstAt = i; break; }
  if (first === 'export') {
    // `export --help` / `-h`: the child (src/export-cli.js runArgs) knows no
    // help flag and would call it an unknown option. Answer here, in bin,
    // with the flags export-cli actually accepts, and exit 0.
    const restArgs = args.slice(firstAt + 1);
    // A `--` ends the flags here too (wave 15): words after it are the child's
    // arguments as typed, never this scan's help flag — `export -- --help`
    // used to print this help and exit 0 instead of reaching export at all.
    const ddAt = restArgs.indexOf('--');
    const helpArgs = ddAt >= 0 ? restArgs.slice(0, ddAt) : restArgs;
    if (helpArgs.includes('--help') || helpArgs.includes('-h')) {
      // This block runs before any muser module may load, so the language is
      // read from MUSER_LANG and, failing that, the "lang" saved in
      // ~/.muser/config.json (normalised like src/i18n's norm: en-US counts
      // as en) — read with the standard library only, and a config that does
      // not parse simply keeps the old env-only behaviour (wave 15: the
      // config was ignored here, so a user who picked English on the first
      // run still got the Japanese help). Other languages keep the Japanese
      // text (wave 6).
      let helpLang = String(process.env.MUSER_LANG || '').trim().toLowerCase().split(/[-_]/)[0];
      if (helpLang !== 'en' && helpLang !== 'ja') {
        try {
          const cfg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:os').homedir(), '.muser', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
          const saved = String((cfg && cfg.lang) || '').toLowerCase().split(/[-_]/)[0];
          if (saved === 'en' || saved === 'ja') helpLang = saved;
        } catch {}
      }
      if (helpLang === 'en') {
        console.log('Usage: muser export [--session <ID>] [--with-conversation] [--dry-run] [--yes] [--window [pid]] [--cd <dir>]');
        console.log('  --session <ID>          Conversation to send (default: the most recent one)');
        console.log('  --with-conversation     Include the conversation text (not included by default)');
        console.log('  --dry-run               Do not send; write the JSON to a file and show where');
        console.log('  --yes                   Send without asking (conversation text only with --with-conversation)');
        console.log('  --window [pid]          Send a running window\'s report (no pid: pick from a list)');
        console.log('  --cd <dir>              Working folder');
      } else {
        console.log('使い方: muser export [--session <ID>] [--with-conversation] [--dry-run] [--yes] [--window [pid]] [--cd <dir>]');
        console.log('  --session <ID>          対象の会話（指定なしでは直前の会話）');
        console.log('  --with-conversation     会話の本文も含める（既定では含めない）');
        console.log('  --dry-run               送らずに、送るはずの JSON をファイルに書いて場所を表示する');
        console.log('  --yes                   確認なしで送る（会話の本文は --with-conversation を付けない限り含めない）');
        console.log('  --window [pid]          動いている窓の分を送る（pid なしでは一覧から選ぶ）');
        console.log('  --cd <dir>              作業フォルダー');
      }
      process.exit(0);
    }
    const {spawnSync} = require('node:child_process');
    const entry = require('node:path').join(__dirname, '..', 'src', 'export-entry.js');
    const r = spawnSync(process.execPath, [entry, ...args.slice(firstAt + 1)], {stdio: 'inherit'});
    process.exit(typeof r.status === 'number' ? r.status : 1);
  }
}
require('../src/fast-start'); // before anything loads Ink (src/fast-start.js)
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
// Dates bin prints follow the UI language, not the OS locale: a bare
// toLocaleString call follows the OS and drifted from the language on screen
// (wave 7; the same shape as usage.js formatPlan's locale pick).
const dateLocale = () => i18n.lang() === 'en' ? 'en-US' : 'ja-JP';
// --json exec errors before exec() starts (audit-cli wave 9): a parse error
// (an unknown flag, a missing --cd folder), a bad --mode, a flag used with the
// wrong command or a surplus word all died in parse()/main() with only a plain
// stderr line — a script driving `muser exec --json` got no result line at all
// (and no status file exists yet at that stage). main() below catches those
// for an exec --json invocation and emits the one result line on stdout.
// Whether this invocation is `muser exec` with --json given as a flag: scan
// argv the way parse() reads it (valued flags swallow their value, --status /
// --window swallow an optional one, and once exec's first prompt word is in,
// later flag-shaped words are prompt text, not flags).
let execJsonResultSent = false;
function isExecJsonRun(argv) {
  const VALUED = new Set(['mode', 'cd', 'max-agents', 'max-agents-total', 'session', 'status-file', 'port', 'account', 'relay', 'focus', 'why', 'event', 'hours', 'before', 'out', 'file', 'agents', 'concurrent', 'fix', 'n', 'accounts', 'max-tokens', 'path', 'kind', 'id']);
  let first = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break; // everything after -- is the prompt itself
    if (a.startsWith('--')) {
      const eqAt = a.indexOf('=');
      const name = a.slice(2, eqAt >= 0 ? eqAt : undefined);
      if (name === 'json') json = true;
      if (eqAt < 0 && VALUED.has(name)) i++;
      else if (eqAt < 0 && (name === 'status' || name === 'window') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') continue; // short flags take no value
    if (first === null) { first = a; if (first !== 'exec') return false; continue; }
    return json; // exec's first prompt word: flag-shaped words after it are text
  }
  return first === 'exec' && json;
}
function sendExecJsonError(message) {
  if (!execJsonResultSent) {
    execJsonResultSent = true;
    try { process.stdout.write(JSON.stringify({type: 'result', ok: false, error: message}) + '\n'); } catch (e) { if (!isEpipeError(e)) throw e; }
  }
  try { process.stderr.write('muser: ' + message + '\n'); } catch {}
  process.exitCode = 1;
}
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
  '    --proof                 返事の後ろに裏取り（証拠バッジ）を付け、状態ファイルにも入れる',
  '    --session <ID>          ID を指定して、その会話の続きとして実行（--json の結果にある session）',
  '    --status-file <パス>    実行の状態を JSON で書き続ける（実行中は running、終わると done と exit 0/2/1）。指定しなくても書き、場所を最初に表示します',
  '  muser exec --status [パス] 実行の状態を数行で（パスなしで一番新しい実行）。終了コード: 実行の結果 0/2/1、実行中 4、止まった・ない 5',
  '    （指示なし / -）        指示を標準入力から読む（例: type task.md | muser exec）',
  '  muser race "指示"         競争: 作業フォルダーを N 個作り、別のアカウント・違う方針で同じ指示を実行して比べる（利用者の作業ツリーには触らない）',
  '    --n <n> / --accounts a,b / --max-tokens <n> / --yes  参加者の数（1〜8、既定 3）・使うアカウント・トークンの上限・確認を省く',
  '  muser race apply <ID> <番号> [--yes]  競争の勝者の差分を表示し（--yes で当てる）、muser race clean <ID> で片付ける',
  '  muser serve [--port N]    GUI 用にサーバーとして起動（GUI 本体は 127.0.0.1。スマホ連携の Link は既定で LAN にも開きます（--no-lan で止められます）。接続情報は ~/.muser/gui.json と ~/.muser/server.json）',
  '  muser serve --demo        GUI 用のサーバーを Muse につながずに起動（デモの台本を流す。見た目の確認用）',
  '  muser server              常駐 Muser Server として起動（serve と同じ。すでに動いていれば、そのサーバーで会話を開く）',
  '  muser server status       動いている Muser Server と、開いている会話を表示',
  '  muser status [pid|会話id]  開いている窓・サーバーの会話・実行中の exec を一覧（id で1つを詳しく、--json で機械向け）',
  '  muser peers               動いている仲間の muser 一覧（名前・作業フォルダー・担当ファイル。--json で機械向け。MUSER_TELL=0 で tell ごと止められます）',
  '  muser tell <相手> "…"     ほかの muser に指示を送る（相手は名前・会話 id。--file <パス> でそのファイルの担当へ。MUSER_TELL=0 で止められます）',
  '  muser log [会話id]       作業ログを表示（ID なしで最近の会話の一覧。--clear で作業ログを消す。--focus <ID> / --why <理由> / --event <出来事> を付けると Focus の判定ログ、--json で機械向け）',
  '  muser worklog [会話id]   muser log と同じ（作業ログの別名）',
  '  muser lore [why <ファイル>:<行> | scars | graves | hunches | story <ファイル> | hunch … | share [on|off] | sync | forget …]  コードの言い伝え（この PC の中が既定。--json で機械向け）',
  '  muser hunt [範囲]         バグ狩り: 範囲のコードを並列エージェントで監査（結果は .muser/hunt/<日時>/。--agents <n> / --concurrent <n> / --account <name> / --yes）',
  '  muser hunt --fix <重要度>  バグ狩りの所見を修正（Critical / High / Medium。反証テストで確かめたものだけ「直した」と数える）',
  '  muser hunt status         直近のバグ狩りの進み具合と結果',
  '  muser overnight           夜間作業のキューを表示（add で積む）',
  '  muser overnight add "指示"  夜間作業に積む（start で順番に実行、report で朝の報告、clear で終わった頼みを片付ける）',
  '  muser parity snapshot [--out <ファイル>]  この PC の環境の指紋（OS・道具の版・PATH・環境変数の名前・依存の固定ファイルのハッシュ）を JSON で出す',
  '  muser parity diff <A.json> <B.json>  2 つの指紋の違いを、原因になりやすい順に出す',
  '  muser server stop         Muser Server を止める（作業中の会話があれば確認する）',
  '  muser server autostart on|off  ログオン時に Muser Server を起動するかどうか', 
  '  muser serve --relay <url>  スマホ連携のリレー（既定: プロジェクトのリレー。--no-link で連携なし、--no-lan で LAN 直結なし）',
  '  muser link                スマホ連携の状態と、ペアリング済みの端末を表示',
  '  muser link pair           スマホとペアリング（QR コードを表示。--wifi で同じ Wi-Fi 向けのコード方式）',
  '  muser link revoke <名前>  ペアリング済み端末を取り消す',
  '  muser link autostart on|off  ログオン時に Server（連携込み）を起動するかどうか',
  '  muser --client            動いている Muser Server の会話として対話する（Server が無ければエラー。既定でも Server につなぎますが、こちらは失敗したら止まります）',
  '  muser --direct            Muser Server につながず、単独で対話する（会話は GUI と共有されません）',
  '  muser login               muse.ai にログインし直す（Edge の窓が開きます。アカウント切替・ログイン切れのときに。端末登録が要れば続けて行います）',
  '  muser pc-login            この PC を端末として登録し直す（doctor で「PC の端末」が未登録のとき）',
  '  muser agent-skill [install|remove] [claude|codex]  Claude Code・Codex に muser-exec スキル（作業を Muse に任せる方法）を登録する／外す（なしで状況）',
  '  muser account             アカウント一覧（複数アカウントと、それぞれの週の使用量）',
  '  muser account add <名前>  アカウントを追加（ログインと端末登録まで続けて行います）',
  '  muser account use <名前>  既定のアカウントを切り替える',
  '  muser account remove <名前>  アカウントを削除（そのログイン情報も消します）',
  '  muser account auto [on|off]  アカウントの自動選択を表示／切り替える',
  '  --account <名前>          使うアカウントを指定して開始（指定なしでは使用量が少ない方を自動で選びます）',
  '  muser doctor              接続を確認',
  '  muser usage               Muse の利用状況（週の使用量）と muser の記録',
  '  muser export              不具合の調べに使うレポートを開発者に送る（中身を見せて、確認してから送る）',
  '    --session <ID>          対象の会話（指定なしでは直前の会話）',
  '    --with-conversation     会話の本文も含める（既定では含めない）',
  '    --dry-run               送らずに、送るはずの JSON をファイルに書いて場所を表示する',
  '    --yes                   確認なしで送る（会話の本文は --with-conversation を付けない限り含めない）',
  '    --window [窓のpid]      動いている窓の分を送る（pid なしでは一覧から選ぶ。応えない窓は固まった記録を送る）',
  '  muser crash [プロセス名]   クラッシュ調査（直近の落下と、落ちる直前の変更を突き合わせる）',
  '    --hours <n> / --before <分> / --json  期間（既定 1 時間）/ 落下の何分前の変更まで見るか（既定 30）/ 機械で読む形',
  '  muser demo                Muse につながずに画面を試す（--cd / --mode も渡せます）',
  '  muser demo login          ログインまわり（初回の準備・接続・ログイン切れ）をデモで見る',
  '  muser logout              muse.ai からログアウト（ログイン情報を消します）',
  '  muser help                このヘルプを表示（-h / --help も同じ）',
  '  muser -h, --help          このヘルプを表示',
  '  muser update              更新のしかたを表示（更新自体は、開いている窓の中で /update と入力して行います）',
  '  muser -V, --version       バージョンを表示（-v も同じ。単語形 muser version も同じ）',
  '',
  'オプション:',
  '  --mode <m>    承認モード: default（毎回確認）/ auto-edit / plan（読み取り専用）/ bypass',
  '  --cd <dir>    作業フォルダー（既定: 今のフォルダー）',
  '  --no-focus    完了条件の自動管理を無効にする（通常は有効）',
  '  --max-agents <n>        同時に動かすエージェント数の上限（既定 4、0 で無制限、最大 64。それより大きい値は 64 に切り詰められます。/settings でも変更できます）',
  '  --max-agents-total <n>  1タスクで起動できるエージェントの合計数の上限（既定 0 = 無制限、最大 1000。それより大きい値は 1000 に切り詰められます。/settings でも変更できます）',
  '                          環境変数 MUSER_MAX_AGENTS / MUSER_MAX_AGENTS_TOTAL や',
  '                          ~/.muser/config.json の {"maxAgents": 4, "maxAgentsTotal": 8} でも指定できます',
  '',
  '環境変数:',
  '  MUSER_LANG               表示言語（en / ja）',
  '  MUSER_CLIENT=1           --client と同じ（動いている Server の会話として対話。対話モード専用）',
  '  MUSER_DIRECT=1           --direct と同じ（Server につながず単独で起動）',
  '  MUSER_RELAY_URL          スマホ連携のリレーの URL（既定: プロジェクトのリレー。--relay でも指定できます）',
  '  MUSER_NO_BELL=1          承認・完了時のベルを止める',
  '  MUSER_NO_UPDATE_CHECK=1  新しい版の確認を止める',
  '  MUSER_UPDATE_CHECK=1     新しい版の確認を行う（設定で止めていても、こちらが優先します）',
  '  MUSER_REDUCED_MOTION=1   スピナーなどの動きを止める',
  '  MUSER_KITTY=1            拡張キー入力を使う',
  '  MUSER_CLASSIC=1          従来の画面（全画面表示を使わない）で起動する',
  '  MUSER_CODE_WRAP=1        長いコード行を折り返す',
  '  MUSER_MAX_AGENTS / MUSER_MAX_AGENTS_TOTAL           エージェント上限（--max-agents と同じ）',
  '  MUSER_ACCOUNT_THRESHOLD=N 週の使用量が N% で上限とみなす（既定 100）',
  '  MUSER_NO_ACCOUNT_AUTO=1  アカウントの自動選択とフェイルオーバーを止める（既定のアカウントだけを使う）',
  '  MUSER_MAX_TOOL_CALLS_PER_TURN / MUSER_DAILY_TURN_LIMIT  1ターンのツール上限 / 1日のターン上限',
  '  MUSER_REPORT_URL         muser export の送り先（既定: https://api.necco.xyz/muser/report）',
  '',
];

const KNOWN_FLAGS = '--mode <m> / --cd <dir> / --no-focus / --demo / --max-agents <n> / --max-agents-total <n> / --json / --clear / --all / --session <ID> / --status-file <path> / --status [path] / --port <n> / --account <name> / --client / --direct / --relay <url> / --no-link / --no-lan / --wifi / --focus <ID> / --why <name> / --event <name> / --with-conversation / --dry-run / --yes / --window [pid] / --proof / --hours <n> / --before <min> / --out <file> / --file <path> / --agents <n> / --concurrent <n> / --fix <level> / --n <n> / --accounts <a,b> / --max-tokens <n> / --path <file> / --kind <kind> / --id <id> / -c, --continue / -h, --help / -V, -v, --version';
// The project's relay for muser link (remote/DESIGN.md); self-hosters point
// MUSER_RELAY_URL or --relay at their own.
const DEFAULT_RELAY_URL = (process.env.MUSER_RELAY_URL || '').trim() || 'wss://necco.xyz/muser-relay';
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
  // `exec --status --json <file>` (wave 12): --status took no value because the
  // next word was a flag, but the file may still come after those flags. It
  // stays pending (below) until a file-shaped word claims it; --status never
  // swallows a `--…` word as its value.
  let statusPending = false;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (literal || promptTail) { o._.push(a); continue; }
    if (a === '--') { literal = true; if (!o._.length) o.literal = true; if (o._[0] === 'race' && o.dashDashIndex === undefined) o.dashDashIndex = o._.length; continue; }
    // --flag=value is the same as --flag value (--mode=bypass was an unknown option).
    let eqValue;
    const eq = /^--(mode|cd|max-agents|max-agents-total|session|status-file|port|account|relay|status|focus|why|event|window|hours|before|out|file|agents|concurrent|fix|path|kind|id)=/.exec(a);
    if (eq) { eqValue = a.slice(a.indexOf('=') + 1); a = '--' + eq[1]; }
    const takeValue = flag => {
      if (eqValue !== undefined) {
        // An empty = value (--session=) used to be silently ignored downstream
        // (recovery scan): it is a missing value, like --session with nothing after.
        if (eqValue === '' || eqValue.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag}));
        return eqValue;
      }
      const v = argv[i + 1];
      // An empty separate value (`--session ''`) is a missing value too: the
      // = form already refuses `--session=`, and letting '' through made it
      // silently act as unspecified downstream instead (wave4-B asymmetry).
      if (v === undefined || v === '' || v.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag}));
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
        // --port's 0 is not "unlimited": it asks the OS for a free port (wave 6).
        if (!/^\d+$/.test(v)) throw new Error(a === '--port' ? t('{flag} には 0 以上の整数を指定してください（0 で空きポート）。', {flag: a}) : t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag: a}));
        // A digit string hundreds of digits long passes the \d+ check but
        // Number() turns it into Infinity, which downstream code silently
        // reinterpreted (wave 17). Refuse a non-finite conversion here.
        const num = Number(v);
        if (!Number.isFinite(num)) throw new Error(a === '--port' ? t('{flag} には 0 以上の整数を指定してください（0 で空きポート）。', {flag: a}) : t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag: a}));
        o[a === '--max-agents' ? 'maxAgents' : a === '--max-agents-total' ? 'maxAgentsTotal' : 'port'] = num;
        // Checked here, not only inside serve(): `--port 70000` with any other command
        // used to pass silently and be ignored (audit #250).
        if (a === '--port' && o.port > 65535) throw new Error(t('--port は 65535 以下の整数を指定してください（0 で空きポート）。'));
      }
    }
    else if (a === '--n' || a.startsWith('--n=')) { const v = a.startsWith('--n=') ? a.slice(4) : argv[i + 1]; if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 8) throw new Error('--n: ' + t('参加者は 1〜{max} 体にしてください。', {max: 8})); if (a === '--n') i++; o.n = Number(v); } // race's count: 1..MAX_RACERS (src/race.js); 0 used to fall through to the default 3 and 99 was shown in the estimate before runRace refused it (wave 6)
    else if (a === '--accounts' || a.startsWith('--accounts=')) { const v = a.startsWith('--accounts=') ? a.slice(11) : argv[i + 1]; if (v === undefined || v === '' || v.startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag: '--accounts'})); if (a === '--accounts') i++; o.accounts = v.split(',').map(s => s.trim()).filter(Boolean); }
    else if (a === '--max-tokens' || a.startsWith('--max-tokens=')) { const v = a.startsWith('--max-tokens=') ? a.slice(13) : argv[i + 1]; if (v === undefined || !/^\d+$/.test(v) || !Number.isFinite(Number(v))) throw new Error(t('{flag} には 0 以上の整数を指定してください（0 で無制限）。', {flag: '--max-tokens'})); if (a === '--max-tokens') i++; o.maxTokens = Number(v); }
    else if (a === '--yes') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--clear') o.clear = true;
    else if (a === '--all') o.all = true; // `muser lore forget --all` (src/lore.js reads the word back in loreCommand)
    else if (a === '--with-conversation') o.withConversation = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--proof') o.proof = true;
    else if (a === '--no-focus') o.noFocus = true;
    else if (a === '--client') o.client = true;
    else if (a === '--direct') o.direct = true;
    else if (a === '--no-link') o.noLink = true;
    else if (a === '--no-lan') o.noLan = true;
    else if (a === '--wifi') o.wifi = true;
    else if (a === '--relay') o.relay = takeValue(a);
    else if (a === '--demo') o.demo = true;
    else if (a === '--session') o.resume = takeValue(a);
    // --status [file]: read a run back instead of starting one (the file is optional).
    else if (a === '--status') { if (eqValue !== undefined) { o.status = eqValue || true; statusPending = !eqValue; } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { o.status = argv[++i]; statusPending = false; } else { o.status = true; statusPending = true; } }
    // --window [pid]: the window is optional-valued like --status (a pid names it, no pid lists them).
    else if (a === '--window') o.window = eqValue !== undefined ? (eqValue || true) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    else if (a === '--status-file') o.statusFile = takeValue(a);
    else if (a === '--account') o.account = takeValue(a);
    else if (a === '--focus' || a === '--why' || a === '--event') o[a.slice(2)] = takeValue(a); // `muser log` filters
    else if (a === '--agents' || a === '--concurrent') { const v = takeValue(a); if (!/^\d+$/.test(v) || !Number.isFinite(Number(v))) throw new Error(a === '--agents' ? t('{flag} には 0 以上の整数を指定してください（0 では対象に合わせて自動で分けます）。', {flag: a}) : t('{flag} には 0 以上の整数を指定してください（0 では既定の 3 になります）。', {flag: a})); o[a === '--agents' ? 'agents' : 'concurrent'] = Number(v); } // `muser hunt` caps: 0 is not "unlimited" for either — --agents 0 auto-splits in makeGroups, --concurrent 0 falls back to 3 in huntCommand (wave 6)
    else if (a === '--fix') o.fix = takeValue(a); // `muser hunt --fix <level>`
    else if (a === '--yes') o.yes = true; // `muser hunt --yes`
    else if (a === '--hours' || a === '--before') { const v = takeValue(a); if (!/^\d+$/.test(v) || !Number.isFinite(Number(v)) || Number(v) < (a === '--hours' ? 1 : 0)) throw new Error(t('{flag} には 1 以上の整数を指定してください。', {flag: a})); o[a.slice(2)] = Number(v); } // `muser crash` window
    else if (a === '--out') o.out = takeValue(a); // `muser parity snapshot` destination
    // `muser lore forget`'s selectors (wave 15): src/lore.js's own usage line
    // names --kind / --path / --id and runLoreCli implements them, but parse()
    // refused all three as unknown options, so through bin the only lore
    // forget that could ever run was --all. They are valued flags like the
    // rest; loreCommand hands the words back below.
    else if (a === '--path' || a === '--kind' || a === '--id') { const v = takeValue(a); if (a === '--path') o.path = v; else if (a === '--kind') o.kind = v; else o.loreId = v; }
    else if (a === '--file') { o.file = takeValue(a); // `muser tell --file <path>`: deliver to the file's claimant
      // A target word already read (`muser tell bob --file x ...`) is kept aside
      // instead of silently becoming the first word of the message: tellCommand
      // refuses the combination, like the tell tool does.
      if (o._[0] === 'tell' && o._.length === 2 && o.tellTarget === undefined) { o.tellTarget = o._[1]; o._.pop(); } }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-V' || a === '--version' || (a === '-v' && !o._.length)) o.version = true;
    else if (a.startsWith('--')) throw new Error(t('知らないオプションです: {flag}（使えるのは {flags}）', {flag: a, flags: KNOWN_FLAGS}));
    // An unknown short option before the prompt (muser -x) went to Muse as a one-word prompt; inside
    // a prompt ("fix the -x flag") it is just a word.
    else if (/^-[A-Za-z]/.test(a) && !o._.length) throw new Error(t('知らないオプションです: {flag}（使えるのは {flags}）', {flag: a, flags: KNOWN_FLAGS}));
    else {
      // A pending --status (wave 12, above) claims this word as its file when
      // the word names a file: a path (a separator or a .json name) or a file
      // that is actually there. A bare word stays a word, so
      // `exec --status --json extra` is still the extra-argument error it
      // always was, while `exec --status --json <path>` reads that run.
      if (statusPending && o.status === true && o._[0] === 'exec' && (/[\\/]/.test(a) || /\.json$/i.test(a) || (() => { try { return require('node:fs').statSync(a).isFile(); } catch { return false; } })())) { o.status = a; statusPending = false; continue; }
      o._.push(a);
      if (o._.length === 1 && !COMMAND_NAMES.includes(a)) promptTail = true; // a prompt, not a subcommand
      else if (o._[0] === 'resume' && o._.length === 2) promptTail = true; // the ID is in; the rest is the prompt
      else if (o._[0] === 'exec' && o._.length === 2) promptTail = true; // the first prompt word is in
      else if (o._[0] === 'race' && o._.length === 2) promptTail = true; // race's words too (its flags are re-read by raceCommand)
      else if (o._[0] === 'overnight' && o._[1] === 'add' && o._.length === 3) promptTail = true; // overnight add's prompt began
      else if (o._[0] === 'tell' && o._.length === (o.file !== undefined || o.tellTarget !== undefined ? 2 : 3)) promptTail = true; // tell: the message starts after the target (or, with --file, at the first word) — flags in between still parse, flags after the first message word are message text, as with exec
    }
  }
  return o;
}

// Resolve an account word (by id or label) or throw the error that fits:
// "not found" only when nothing matches, and the candidates when several
// do (wave 13 F4 — resolve() used to flatten both into one null, so an
// ambiguous prefix was reported as a missing account). Candidate labels
// go through safeName: a registry label is outside text on a terminal.
function resolveAccount(ref) {
  const d = require('../src/accounts').resolveDetailed(ref);
  if (d.status === 'found') return d.account;
  if (d.status === 'ambiguous') throw new Error(t('候補が複数あります: {list} — もう少し長く指定してください', {list: d.candidates.slice(0, 10).map(a => safeName(a.label) + ' (' + a.id + ')').join(', ')}));
  throw new Error(t('アカウントが見つかりません: {id}', {id: safeName(ref)}));
}
// The account a --account flag names (by id or label); throws when there is no such account.
function accountFromFlag(o) {
  if (!o.account) return null;
  return resolveAccount(o.account);
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
  if (o.resume) return resumeTarget(sessions, o.resume, o.cdGiven ? o.cwd : undefined);
  if (o.continue) { const s = sessions.recent(o.cwd).find(s => s.turns); if (!s) throw new Error(t('再開できる会話はありません。')); return s; }
  return undefined;
}

// Web login -> chat gateway -> this PC's CLI device. Each step says what to run if it is missing.
// An unattended `muser exec` waits this long for a node slot of its own (Agent.waitForOwnNode);
// MUSER_NODE_WAIT_MS overrides it (0 = share the id as before).
function nodeWaitMs(env = process.env) {
  // Strictly digits only (wave 17): parseInt read '1e6' as 1 and '250abc' as
  // 250, and a huge digit string came back uncapped. Anything that is not a
  // plain non-negative integer falls back to the default, and a valid value
  // is capped at one hour.
  const raw = String(env.MUSER_NODE_WAIT_MS ?? '').trim();
  if (!/^\d+$/.test(raw)) return 10 * 60 * 1000;
  return Math.min(Number(raw), 60 * 60 * 1000);
}
// sessionOrigin: the origin mark for a conversation this connection creates
// (exec passes 'exec'; a resumed conversation keeps the mark it already has).
async function connect(o, log, {waitForNodeMs = 0, sessionOrigin = null} = {}) {
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
    agent = new Agent({client, auth, cwd, mode: o.mode || remembered.mode || require('../src/settings').defaultMode(), modeExplicit: !!o.mode, allowAlways: remembered.allow, web, session, mcp, focusEnabled: !o.noFocus && require('../src/settings').switchValue('focus'), agentLimits: {maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal}, accountId: account.id, accountLabel: pool.multi() ? account.label : null, accountFiles: files, accountPool: pool.makePool(), sessionOrigin});
  } catch (e) {
    try { await mcp.close(); } catch {}
    try { client.disconnect(false); } catch {}
    throw e;
  }
  log(t('この PC の CLI 端末をつないでいます…'));
  agent.waitForNodeMs = waitForNodeMs; agent.nodeWaitLog = log;
  // A failure from here on must not leak the half-built agent (recovery scan):
  // its MCP children, gateway client and node slot would keep the process alive
  // holding resources, and the caller never receives the agent to close it.
  let museName = 'Muse';
  try {
    const identity = client.request('GET', '/identity').catch(() => null);
    await Promise.all([subscribed.then(() => { agent.subscribed = true; }), agent.connectDevice()]);
    const r = await identity;
    if (typeof r?.name === 'string' && r.name.trim()) museName = r.name.trim().slice(0, 40);
  } catch (e) { try { await agent.closeGracefully(); } catch {} throw e; }
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
  // Attach values from a client window (server-first): the sessions host now
  // forwards the opener's --max-agents / --max-agents-total / --no-focus, so
  // they shape THIS conversation's Agent instead of the server process's own
  // startup flags (the last leg of first audit #32).
  if (overrides.maxAgents !== undefined) oo.maxAgents = overrides.maxAgents;
  if (overrides.maxAgentsTotal !== undefined) oo.maxAgentsTotal = overrides.maxAgentsTotal;
  if (overrides.noFocus !== undefined) oo.noFocus = overrides.noFocus;
  if (overrides.focusEnabled !== undefined) oo.noFocus = !overrides.focusEnabled;
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
    agent = new Agent({client, auth, cwd, mode: oo.mode || remembered.mode || require('../src/settings').defaultMode(), modeExplicit: !!oo.mode, allowAlways: remembered.allow, web, session, mcp, focusEnabled: !oo.noFocus && require('../src/settings').switchValue('focus'), agentLimits: {maxAgents: oo.maxAgents, maxAgentsTotal: oo.maxAgentsTotal}, accountId: account.id, accountLabel: pool.multi() ? account.label : null, accountFiles: files, accountPool: pool.makePool()});
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
  // Set up before on this PC (a saved SDK token, or a pair that just proved broken): the
  // screen says it is redoing the setup, not greeting a first run (Discord report, 2026-11-06:
  // "アプデしてるのに始めましてはおかしい").
  let again = deviceBroken;
  try { again = again || createAuth(createWeb(loadJar(files.web), {file: files.web}), {file: files.device}).snapshot().hasSdkToken; } catch {}
  await require('../src/tui/onboard').onboard({
    needLogin, needDevice, again,
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
// SetupFlow deps for serve()'s setup mode (src/server/setup.js): the same
// judgement and pieces onboard() assembles for one account — needLogin (the
// jar is empty), the device-registration thunk (re-asked after the login,
// reading the jar as it then stands, with the broken-pair probe onboard()
// runs), login(progress) (src/login.js) and register(ui) (pcLogin with the
// ui the flow hands it). Returns null when this serve needs no first-run
// preparation at all: nothing missing, or onboardFor()'s pool rule — another
// ready account starts the window, so the default account's missing login
// is no reason to prepare. Throws exactly where onboardFor() would (an
// unresolvable --account / resume target).
async function serveSetupDeps(o) {
  const accountId = accountFromFlag(o)?.id || (() => {
    try { const s = sessionFromFlags(o); if (!s) return undefined; const id = s.account || 'default'; return require('../src/accounts').get(id) ? id : undefined; } catch (e) { if (o.resume || o.continue) throw e; return undefined; }
  })();
  if (!accountId) {
    const accounts = require('../src/accounts'), pool = require('../src/account-pool');
    const ready = id => accounts.hasLogin(id) && accounts.hasDevice(id);
    if (pool.multi() && pool.autoEnabled() && !ready(accounts.activeId()) && accounts.list().some(a => ready(a.id))) return null;
  }
  const accounts = require('../src/accounts');
  const account = (accountId && accounts.get(accountId)) || accounts.get(accounts.activeId()) || accounts.list()[0];
  if (!account) return null;
  const files = accounts.filesFor(account.id);
  const {createWeb, loadJar} = require('../src/web');
  const {createAuth, pcLogin} = require('../src/pc-login');
  require('../src/secure-store').preload([files.web, files.device, files.session]); // one PowerShell start for all three (as in onboard())
  // The broken-pair probe, as in onboard(): a pair that is 'authenticated'
  // yet dead, or minted for another muse.ai user, counts as needing
  // registration; a network error does not.
  let deviceBroken = false;
  if (loadJar(files.web).length) {
    const probeAuth = createAuth(createWeb(loadJar(files.web), {file: files.web}), {file: files.device});
    if (probeAuth.snapshot().phase === 'authenticated') {
      try { await probeAuth.vm(); } catch (e) { if (e.deviceMismatch || e.deadDevice || e.status === 401) deviceBroken = true; }
    }
  }
  const needDevice = () => deviceBroken || createAuth(createWeb(loadJar(files.web), {file: files.web}), {file: files.device}).snapshot().phase !== 'authenticated';
  const needs = async () => ({login: !loadJar(files.web).length, device: needDevice()});
  const first = await needs();
  if (!first.login && !first.device) return null;
  return {
    needs,
    login: (progress, signal) => require('../src/login').login({log: s => progress(s.trim().replace(/^…\s*/, '')), profile: files.browser, jarFile: files.web, signal}),
    register: ui => pcLogin(createWeb(loadJar(files.web), {file: files.web}), ui, {file: files.device}),
  };
}

async function interactive(o, initial, opts = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
  // Own the screen from the first frame: the shell prompt that launched us goes away.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // Something on screen at once, never a black screen while the modules and keys load.
  // The styling goes through term.c (wave 18): the raw SGR used to be written
  // unconditionally, so colour showed even on a dumb terminal, with NO_COLOR
  // set, or with the colour setting off — c.* prints plain text then.
  const {c} = require('../src/tui/term');
  process.stdout.write('\n  ' + c.bold(c.accent('muser')) + c.dim('  ' + t('起動しています…')));
  // A server-first fallback notice rides the splash line: printed before the
  // screen was owned it would be cleared away unseen (see serverFirst below).
  if (opts.notice) process.stdout.write('\n  ' + c.dim(opts.notice));
  // The fullscreen screen (the default) loads no Ink/React; the classic one does.
  const view = import(require('../src/settings').switchValue('fullscreen') ? '../src/ui/fs/run.mjs' : '../src/ui/view.mjs');
  view.catch(() => {});
  // First run only: ask for the UI language before the onboarding screens.
  if (i18n.chosen() === null) await require('../src/tui/onboard').askLanguage();
  await onboardFor(o);
  const {agent, museName, web} = await prepare(o);
  // A view that fails to load must not strand the prepared agent (deep c3 #1).
  let run;
  try { ({run} = await view); } catch (e) { try { await agent.closeGracefully(); } catch {} throw e; }
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
    // serverfirst-debug B7: a direct window stays direct across /reload
    // (a --direct start, or a server-first fallback marked as such) —
    // the flag used to be dropped, so the reloaded window silently
    // migrated onto the Server (or attached to one started meanwhile).
    if (o.direct) args.push('--direct');
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

// The client window itself: attach a conversation on a server that is known
// to be live and answering, and run the TUI against it. Shared by the strict
// --client entry and by the server-first default below.
async function runClientWindow(o, initial, info, resolvedSessionId) {
  const discovery = require('../src/server/discovery');
  let sessionId;
  // serverfirst-debug B13: the server-first entry resolves the requested
  // session BEFORE its attach retry loop and passes the id in — a bad
  // --resume/--continue target is the user's error (no such session) and
  // must surface as itself, not be retried and mislabelled a server
  // failure. The strict --client entry still resolves it here.
  if (o.resume || o.continue) sessionId = resolvedSessionId !== undefined ? resolvedSessionId : sessionFromFlags(o)?.id;
  // The agent limits and Focus flag travel with the attach (first audit #32);
  // discovery forwards them and the sessions host now applies them to the
  // conversation it builds (see prepare()'s overrides).
  const opened = await discovery.attachSession(info, {cwd: o.cwd, account: o.account, mode: o.mode, sessionId, maxAgents: o.maxAgents, maxAgentsTotal: o.maxAgentsTotal, noFocus: o.noFocus});
  // serverfirst-debug B3: everything after the attach can still fail
  // (the view failing to load, the controller failing to start), and the
  // attach already created a NEW conversation on the server. The catch
  // at the end closes that orphan again, so the caller's fallback does
  // not leave an empty conversation behind in the server's list.
  try {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // The styling goes through term.c (wave 18), exactly as in interactive():
  // the raw SGR used to be written unconditionally, so colour showed even
  // on a dumb terminal, with NO_COLOR set, or with the colour setting
  // off — c.* prints plain text then.
  const {c} = require('../src/tui/term');
  process.stdout.write('\n  ' + c.bold(c.accent('muser')) + c.dim('  ' + t('起動しています…')));
  // serverfirst-debug G9: the conversation was already open, built with
  // other attach values — the server says so (attachApplied: false); pass
  // it on under the splash instead of letting the flags silently no-op.
  if (opened.attachApplied === false) process.stdout.write('\n  ' + c.dim(t('すでに開いている会話のため、指定した上限や Focus の設定は反映されませんでした')));
  const {createClient} = require('../src/server/client');
  const client = createClient(info);
  const {RemoteController} = await import('../src/ui/remote-controller.mjs');
  const {run} = await import(require('../src/settings').switchValue('fullscreen') ? '../src/ui/fs/run.mjs' : '../src/ui/view.mjs');
  let ctrl;
  const onExit = () => {
    try { ctrl?.stop(); } catch {}
    // /exit (and the Ctrl+C double-press) close only this window: the
    // conversation — and any turn in flight — keeps living in the Server.
    process.stdout.write(c.faint(t('会話は Server で続いています。GUI か `muser` で開き直せます')) + '\n');
    setTimeout(() => process.exit(0), 50);
  };
  const onReload = () => {
    // /reload in client mode restarts the CLIENT on the same conversation;
    // the server (and its code) is untouched by design.
    const args = [__filename, '--client'];
    args.push('--session', opened.id);
    // serverfirst-debug B8: carry the LIVE account/mode — the
    // controller's agent mirror tracks both from snapshots and from
    // /mode — not the startup flags, which /reload used to silently
    // revert a mid-session mode change or account switch to.
    const liveAccount = ctrl?.agent?.accountId ?? o.account;
    if (liveAccount) args.push('--account', liveAccount);
    args.push('--cd', o.cwd);
    const liveMode = ctrl?.agent?.mode ?? o.mode;
    if (liveMode) args.push('--mode', liveMode);
    if (o.noFocus) args.push('--no-focus');
    if (o.maxAgents != null) args.push('--max-agents', String(o.maxAgents));
    if (o.maxAgentsTotal != null) args.push('--max-agents-total', String(o.maxAgentsTotal));
    require('node:child_process').spawn(process.execPath, args, {stdio: 'inherit'}).unref();
    setTimeout(() => process.exit(0), 50);
  };
  ctrl = new RemoteController({client, sessionId: opened.id, version: VERSION, onExit, onReload});
  await ctrl.start();
  run({remoteCtrl: ctrl, version: VERSION, initial});
  } catch (e) {
    // Only a conversation THIS attach created can be an orphan; one the
    // user asked to resume belongs to them whatever happens here.
    if (!sessionId && opened?.id) { try { await discovery.request(info, 'POST', '/api/sessions/' + encodeURIComponent(opened.id) + '/close', {}); } catch {} }
    throw e;
  }
}

// `muser --client`: the strict form (remote/DESIGN.md step 4). It never
// starts a server, never falls back, and refuses an old server whose
// protocol is not exactly 6 (a resident server keeps running the code it
// was started with). The default entry below is the lenient one.
async function clientInteractive(o, initial) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
  // serverfirst-debug B10: the first-run language question comes first,
  // exactly as on the default and direct entries — --client used to
  // skip it, so a first-ever --client run spent its session in the
  // OS-default language.
  if (i18n.chosen() === null) await require('../src/tui/onboard').askLanguage();
  const discovery = require('../src/server/discovery');
  const info = discovery.readServer();
  const live = info && await discovery.probeServer(info).catch(() => null);
  if (!live) throw new Error(t('Muser Server が動いていません。`muser server` で起動するか、--client を外して単独で使ってください。'));
  // Exactly 6 (recovery scan): a NEWER server was accepted too and failed obscurely
  // mid-session instead of getting this clean refusal.
  // serverfirst-debug B11 (+B14): the classification is ensureServer's
  // verdict — the same one the default entry uses, with its normalised
  // protocol number. A server still in first-run setup is refused with
  // a message that says so and names the way through, instead of the
  // attach dying later on a raw 'session hosting is not enabled'.
  const {verdict} = require('../src/server/ensure-server');
  const v = verdict(info, live);
  if (v.status === 'protocol') throw new Error(t('動いている Muser Server の版が合いません。`muser server stop` してから起動し直すか、--client を外してください。'));
  if (v.status === 'setup') throw new Error(t('Muser Server は初回準備の途中です。`muser`（--client なし）で起動すると、この端末で準備を進められます。'));
  return runClientWindow(o, initial, info);
}

// The one-line reason a server-first start fell back to a direct session.
function serverFallbackLine(reason, extra) {
  let line = t('Server とつながらないため、この会話は GUI と共有されません（{reason}）', {reason});
  if (extra) line += ' ' + extra;
  return line;
}

// Drive a running server's first-run setup from this terminal (the Server
// owns the flow, /api/setup; the CLI is only its screen — the same answers
// the GUI would give, so the account and conversations are shared after).
async function driveServerSetup(info) {
  const {createClient} = require('../src/server/client');
  const {clackUi} = require('../src/tui/onboard');
  const {driveSetup} = require('../src/tui/setup-client');
  // serverfirst-debug S8: onCancel keeps a prompt cancel from exiting
  // inside clack — the driver cancels the SERVER's flow first, then the
  // caller (serverFirstInteractive) ends the process as a cancel.
  return driveSetup({client: createClient(info), ui: clackUi({onCancel: () => {}}), output: line => process.stdout.write(String(line) + '\n')});
}

// The default interactive entry (server-first, 2026-11-07): try the Server
// first — starting it once in the background when it is absent — and only
// when that cannot work, open a direct (standalone) session instead, with
// one line saying the conversation will not be shared with the GUI. The
// Server is never stopped or restarted from here.
async function serverFirstInteractive(o, initial) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
  // First run only: ask for the UI language before anything else, exactly
  // as the direct path does (the client path used to skip this).
  if (i18n.chosen() === null) await require('../src/tui/onboard').askLanguage();
  const {ensureServer} = require('../src/server/ensure-server');
  const discovery = require('../src/server/discovery');
  // serverfirst-debug B2: the spawn lock sits next to the discovery
  // file, so two windows starting together spawn ONE server between them.
  const ensured = await ensureServer({lockFile: discovery.serverFile() + '.spawnlock'}).catch(() => ({status: 'failed', reason: 'unreachable'}));
  let reason = null, extra = null;
  if (ensured.status === 'ready' || ensured.status === 'setup') {
    let ready = ensured.status === 'ready';
    if (!ready) {
      // The server is mid first-run setup: answer it here, then attach.
      let driven = null;
      try { driven = await driveServerSetup(ensured.info); } catch (e) { driven = {done: false, error: e?.message}; }
      // serverfirst-debug S9: a setup the user cancelled is a cancel, not
      // a failed setup — the old code fell through to the direct start,
      // whose own onboarding could immediately ask for the very login
      // the user just backed out of. The cancel line is already printed.
      if (driven && driven.cancelled) process.exit(130);
      if (driven && driven.done) ready = true;
      else reason = t('初回準備が完了しませんでした');
    }
    if (ready) {
      // Right after setup the server still needs a moment to build its
      // first conversation (attach answers 501 until the host is set):
      // retry that one refusal briefly, fall back on anything else.
      // serverfirst-debug B4: the retry is bounded by a DEADLINE, not an
      // attempt count — each attempt can itself block for as long as a
      // request takes (the old 40 attempts at up to the 120s body
      // timeout could leave the terminal silent for far longer than the
      // nominal ~20s), and the refusal is recognised by its status, with
      // the message match kept only for servers that predate .status.
      const attachDeadline = Date.now() + 20000;
      // B13: resolved here, outside the retry loop, so its own error
      // (a --resume/--continue target that does not exist) reaches the
      // user as itself instead of being retried as a server failure.
      const resolvedSessionId = (o.resume || o.continue) ? sessionFromFlags(o)?.id : undefined;
      for (;;) {
        try { return await runClientWindow(o, initial, ensured.info, resolvedSessionId); }
        catch (e) {
          const msg = String(e?.message || e);
          const notEnabled = e?.status === 501 || /session hosting is not enabled/.test(msg);
          if (notEnabled && Date.now() < attachDeadline) { await new Promise(r => setTimeout(r, 500)); continue; }
          reason = t('Server で会話を開けませんでした');
          break;
        }
      }
    }
  } else if (ensured.status === 'protocol') {
    reason = t('動いている Server の版が古く、話が通じません');
    extra = t('Server を再起動すると共有できます。');
  } else {
    reason = ensured.reason === 'not-found' ? t('Server が見つかりませんでした')
      : ensured.reason === 'start-failed' ? t('Server を起動できませんでした')
      : t('Server に接続できませんでした');
  }
  const line = serverFallbackLine(reason || t('Server に接続できませんでした'), extra);
  // serverfirst-debug B12: the line rides the splash via the notice
  // (interactive prints it once the screen is owned) — writing it to
  // stderr as well showed it TWICE in the terminal (confirmed on the
  // pty path: once raw, once on the splash).
  // B7: from here on this window IS a direct window; say so on o so its
  // /reload stays direct instead of migrating onto a Server.
  o.direct = true;
  return interactive(o, initial, {notice: line});
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
// neither decode lossily as before. UTF-16 is judged BEFORE both (wave 18):
// PowerShell 5.1's default output encoding and its `>` redirection write
// UTF-16LE, UTF-16BE arrives from other Windows tools, and those bytes
// decoded as UTF-8/Shift-JIS came out lossy and full of NULs, so a real text
// prompt was refused as "not text" by stdinLooksBinary below.
function decodeStdin(buf) {
  const utf16 = utf16Text(buf);
  if (utf16 !== null) return utf16;
  try { return new TextDecoder('utf-8', {fatal: true}).decode(buf); } catch {}
  try { return new TextDecoder('shift-jis', {fatal: true}).decode(buf); } catch {}
  return buf.toString('utf8');
}
// The decoded text when buf is UTF-16, else null. A BOM (FF FE / FE FF) names
// the endianness outright. Without one, running text still shows it: the
// NULs of ASCII/Latin code units sit in ONE byte of each pair (the second in
// LE, the first in BE), so one parity holding most of the NULs, in a good
// share of the pairs, is UTF-16 — real UTF-8/Shift-JIS text holds no NUL
// bytes at all, and a binary holds its NULs on both parities.
function utf16Text(buf) {
  if (buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) return decodeUtf16(buf.subarray(2), false);
  if (buf[0] === 0xfe && buf[1] === 0xff) return decodeUtf16(buf.subarray(2), true);
  if (buf.length < 4 || buf.length % 2 !== 0) return null;
  let evenNul = 0, oddNul = 0;
  for (let i = 0; i < buf.length; i += 2) { if (buf[i] === 0) evenNul++; if (buf[i + 1] === 0) oddNul++; }
  const pairs = buf.length / 2;
  if (!evenNul && !oddNul) return null;
  if (oddNul >= evenNul * 4 && oddNul * 4 >= pairs) return decodeUtf16(buf, false);
  if (evenNul >= oddNul * 4 && evenNul * 4 >= pairs) return decodeUtf16(buf, true);
  return null;
}
function decodeUtf16(body, be) {
  const b = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
  if (be) b.swap16();
  return b.toString('utf16le');
}
// A binary piped in as the prompt (audit-cli wave 9): decodeStdin lossily
// decodes almost anything, so an executable or an image used to reach Muse
// as a page of replacement characters. A NUL in the decoded text, a run of
// control characters, or many U+FFFD replacements means it was never text.
function stdinLooksBinary(text) {
  if (!text) return false;
  if (text.includes('\0')) return true;
  let fffd = 0, ctrl = 0;
  for (const ch of text) {
    if (ch === '\uFFFD') fffd++;
    else if (ch < ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f') ctrl++;
  }
  if (fffd >= 4 || ctrl >= 4) return true;
  if (fffd >= 2 && fffd / text.length > 0.05) return true;
  if (ctrl >= 2 && ctrl / text.length > 0.05) return true;
  return false;
}
// A prompt given BOTH as an argument and on a piped stdin (audit-cli wave 9):
// the pipe used to be silently ignored, so which instruction Muse followed
// depended on how the launcher happened to be wired. A short wait only — a
// pipe that delivers nothing within it is ignored exactly as before, and a
// launcher holding an empty pipe open does not stall the run.
async function stdinHasDataWithin(ms) {
  if (!process.stdin || process.stdin.isTTY || process.stdin.destroyed || process.stdin.readableEnded) return false;
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); try { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onEnd); } catch {} try { process.stdin.pause(); } catch {} resolve(v); };
    const onData = c => finish(!!c && c.length > 0);
    const onEnd = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    process.stdin.once('data', onData); process.stdin.once('end', onEnd); process.stdin.once('error', onEnd);
    try { process.stdin.resume(); } catch {}
  });
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
  const out = obj => { if (obj && obj.type === 'result') execJsonResultSent = true; try { return process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { if (isEpipeError(e)) { stdoutBroken = true; return false; } throw e; } };
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
  const noteWriteError = () => { const e = status.takeWriteError(); if (e) process.stderr.write(t('状態ファイル {file} を書けませんでした: {error}', {file: status.file, error: e}) + '\n'); };
  if (status.writeError) noteWriteError(); else err(t('状態ファイル: {file}', {file: status.file}));
  // `type task.md | muser exec` (or `muser exec -`): the prompt comes from stdin. The read
  // is bounded: stdin that never ends fails the run (and says so in the status file)
  // instead of hanging it forever (audit #154).
  if ((!prompt || prompt === '-') && !process.stdin.isTTY) {
    try { prompt = await readStdinPrompt(STDIN_TIMEOUT_MS); if (stdinLooksBinary(prompt)) throw new Error(t('標準入力がテキストではないようです。テキストの指示だけを渡してください。')); }
    catch (e) {
      status.finish({exit: 1, ok: false, error: e.message}); noteWriteError();
      if (json) { out({type: 'result', ok: false, error: e.message, duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1; return; }
      throw e;
    }
    prompt = prompt.trim();
    if (prompt.charCodeAt(0) === 0xfeff) prompt = prompt.slice(1).trim(); // a BOM from PowerShell redirection
    if (prompt) status.update({prompt: prompt.slice(0, 500)});
  } else if (prompt && prompt !== '-' && !process.stdin.isTTY && await stdinHasDataWithin(200)) {
    // The prompt came as an argument AND data is arriving on the pipe: refuse
    // to pick one silently (wave 9, see stdinHasDataWithin).
    const msg = t('引数と標準入力の両方に指示があります。');
    status.finish({exit: 1, ok: false, error: msg}); noteWriteError();
    if (json) { out({type: 'result', ok: false, error: msg, duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1; return; }
    throw new Error(msg);
  }
  if (!prompt || prompt === '-') {
    status.finish({exit: 1, ok: false, error: t('exec には指示が必要です。')}); noteWriteError();
    if (json) { out({type: 'result', ok: false, error: t('exec には指示が必要です。'), duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1; return; }
    throw new Error(t('exec には指示が必要です。'));
  }
  let agent;
  try {
    // exec is the one caller of connect(): a conversation it creates is marked
    // origin 'exec' (see Agent's sessionOrigin); --session/-c resumes keep theirs.
    ({agent} = await connect(o, s => err('· ' + s), {waitForNodeMs: nodeWaitMs(), sessionOrigin: 'exec'}));
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
    await agent.closeGracefully();
    status.finish({state: 'interrupted', exit: 130, ok: false, session: agent.session.id, error: 'interrupted'});
    if (json) out({type: 'result', ok: false, session: agent.session.id, error: 'interrupted', duration_ms: Date.now() - t0, status_file: status.file});
    process.exit(130);
  });
  // SIGBREAK (Windows Ctrl+Break) gets the same cleanup (wave 18): it is a
  // separate signal from SIGINT there, and with no handler the process died
  // by the default action — no cancelAll, no result line, and the status
  // file left at running. (Registered on Windows only: the signal does not
  // exist elsewhere.)
  if (process.platform === 'win32') process.once('SIGBREAK', async () => {
    err(t('Muse の作業を止めています…'));
    await agent.cancelAll().catch(() => {});
    await agent.closeGracefully();
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
    await agent.closeGracefully();
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
  // --proof: keep this run's tool calls, so the reply can be judged even
  // before the worklog writer exists (src/proof/index.js syntheticTurn).
  const execTools = [];
  if (o.proof) { agent.on('tool-end', call => execTools.push(call)); agent.on('agent-tool', call => execTools.push(call)); }
  if (json) out({type: 'start', session: agent.session.id, cwd: agent.cwd, mode: agent.mode, status_file: status.file});
  let sources = [], turnUsage = null;
  agent.on('turn-end', e => { if (e?.sources) sources = e.sources; if (e?.usage) turnUsage = e.usage; });
  try {
    const reply = await agent.send(prompt);
    // The work log's last batch must be on disk before --proof reads it
    // (and before this short-lived process exits at all).
    try { agent.flushWorklogs?.(); } catch {}
    if (reply.focus && reply.focus.status !== 'complete') process.exitCode = 2;
    let text = reply.text;
    try { const {stripEmbeds} = await import('../src/ui/sanitize.mjs'); text = stripEmbeds(text); } catch {}
    text = require('../src/turn-usage').strip(text); // a [usage] line never reaches exec output or its status file
    // --proof (design §2): judge the reply against the worklog; while the
    // writer is not merged, fall back to this run's own tool events.
    let proofData = null, proofLines = [];
    if (o.proof) {
      try {
        const P = require('../src/proof/index.js'), B = require('../src/proof/badge.js');
        const conv = P.proofConversation(agent.session.id, {});
        if (!conv.missing && conv.result) { proofData = conv.result; proofLines = conv.lines; }
        else { proofData = B.proofTurn(P.syntheticTurn(text, execTools)); proofLines = B.formatProof(proofData); }
      } catch {}
    }
    const finalUsage = turnUsage || reply.usage || null;
    if (proofData) status.update({proof: proofData});
    status.finish({exit: process.exitCode || 0, ok: true, session: agent.session.id, reply: text.trim(), ...(finalUsage ? {usage: finalUsage} : {}), 
      ...(reply.focus ? {completed: reply.focus.status === 'complete', focus: reply.focus} : {}), sources: sources.map(s => ({label: s.label, uri: s.uri}))});
    noteWriteError();
    // Plain output never said which conversation this was: --session continues it.
    err(t('続きは: muser exec --session {id} "…"', {id: agent.session.id}));
    if (!json) {
      process.stdout.write(text.trim() + '\n');
      if (proofLines.length) process.stdout.write('\n' + proofLines.join('\n') + '\n');
      if (reply.focus) err(t('Focus 判定: {status} · {reason}', {status: reply.focus.status, reason: reply.focus.reason}));
      // The interactive UI shows sources under the reply; plain exec dropped them entirely.
      if (sources.length) process.stdout.write('\n' + t('出典:') + '\n' + sources.map((s, i) => '  ' + (i + 1) + '. ' + (s.label || s.domain || '') + (s.uri ? '  ' + s.uri : '')).join('\n') + '\n');
      return;
    }
    const [before, after] = await Promise.all([planBefore, usage.plan(agent.web).catch(() => null)]);
    out({type: 'result', ok: true, session: agent.session.id, status_file: status.file, reply: text.trim(), sources: sources.map(s => ({label: s.label, uri: s.uri})), ...(finalUsage ? {turnUsage: finalUsage} : {}), ...(proofData ? {proof: proofData} : {}), 
      ...(reply.focus ? {completed: reply.focus.status === 'complete', focus: reply.focus} : {}),
      duration_ms: Date.now() - t0, ...(before || after ? {usage: {week_percent_before: before?.percentUsed ?? null, week_percent_after: after?.percentUsed ?? null}} : {})});
  } catch (e) {
    status.finish({exit: 1, ok: false, session: agent.session.id, error: e.message}); noteWriteError();
    if (!json) throw e;
    out({type: 'result', ok: false, session: agent.session.id, error: e.message, duration_ms: Date.now() - t0, status_file: status.file}); process.exitCode = 1;
  } finally { await agent.closeGracefully(); }
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
  // MUSER_BACKGROUND=1 (the autostart launcher): a hidden console is still a TTY to node,
  // but nobody can answer a prompt there, so it counts as no terminal.
  const terminal = !!(process.stdin.isTTY && process.stdout.isTTY) && process.env.MUSER_BACKGROUND !== '1';
  if (i18n.chosen() === null && terminal) await require('../src/tui/onboard').askLanguage();
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
      // serverfirst-debug B14: the protocol number is normalised the
      // same way ensureServer's verdict normalises it (a string "6" is 6).
      if (Number(live.protocol ?? 5) !== 6) throw new Error(t('動いている Muser Server の版が合いません。`muser server stop` してから起動し直すか、--client を外してください。'));
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
  // #12: a server started at logon used to run its default conversation in
  // C:\WINDOWS\system32 (the logon working folder). Never start a server
  // conversation there; --cd still wins when the user gave one.
  if (!o.cdGiven) o.cwd = require('../src/server/default-cwd').resolveDefaultCwd(o.cwd);
  // An autostart launcher from before the CurrentDirectory fix is
  // rewritten at startup; a missing one means autostart is off.
  try { require('../src/server/autostart').refreshAutostartVbs({binFile: __filename}); } catch {}
  const {SessionsHost} = require('../src/server/sessions-host');
  const token = require('node:crypto').randomBytes(32).toString('hex'); // 32 bytes, per process
  let server, host, linkRef = null, stopping = false;
  // #11: one conversation's uncaught error must not take the whole server
  // down. An error that names a conversation closes only that one (the
  // handler, src/server/server-crash.js); anything else is recorded and
  // the server restarts, at most 5 times in 10 minutes. The listener is
  // closed first, so the restarted server can bind the port; a wedged
  // shutdown still exits on the fallback timer instead of hanging.
  const serverCrash = require('../src/server/server-crash');
  serverCrash.installServerCrashHandlers({version: VERSION, host: {get: id => host?.get(id), closeSync: (id, reason) => host?.closeSync(id, reason)}, onFatal: async () => {
    if (stopping) return; stopping = true;
    setTimeout(() => process.exit(1), 10000);
    await server?.close().catch(() => {});
    const restarted = serverCrash.tryRestart({});
    await linkRef?.stop().catch(() => {});
    await host?.closeAll().catch(() => {});
    try { process.stderr.write(restarted ? 'Muser Server を起動し直します。\n' : 'Muser Server が予期しないエラーで止まりました。\n'); } catch {}
    process.exit(restarted ? 0 : 1);
  }});
  const stop = async () => {
    if (stopping) return; stopping = true;
    await linkRef?.stop().catch(() => {});
    await server?.close().catch(() => {});
    // Leaving mid-turn only closed the sockets: Muse went on working for nobody.
    await host?.closeAll().catch(() => {});
    setTimeout(() => process.exit(0), 50);
  };
  // First-run preparation: on a terminal, onboard in the terminal exactly as
  // before (the CLI experience does not change). Without a terminal (the GUI
  // launched this serve, stdout is a pipe) and only when preparation is
  // actually needed, the HTTP server opens FIRST in setup mode — token
  // decided, GuiServer started, gui.json written at that point — and the
  // preparation questions are answered over /api/setup. When the flow
  // reports done, the usual preparation (prepare) runs and the SAME server
  // (same port/token) is handed the host below via setHost().
  let agent, museName;
  const setupDeps = terminal ? null : await serveSetupDeps(o);
  if (setupDeps) {
    const {SetupFlow} = require('../src/server/setup');
    const setupFlow = new SetupFlow(setupDeps);
    server = new GuiServer({setup: setupFlow, token, port: o.port, version: VERSION, serverDiscoveryFile: discovery.serverFile(), onStop: stop});
    const setupDone = new Promise(resolve => {
      const cleanup = () => { try { setupFlow.removeListener?.('done', onDone); setupFlow.removeListener?.('change', check); } catch {} };
      const onDone = () => { cleanup(); resolve(); };
      const check = () => { try { if (setupFlow.state()?.phase === 'done') onDone(); } catch {} };
      if (typeof setupFlow.once === 'function') setupFlow.once('done', onDone);
      if (typeof setupFlow.on === 'function') setupFlow.on('change', check);
      check();
    });
    await server.start();
    console.log(t('GUI サーバーを起動しました: {url}', {url: server.url}));
    console.log(t('接続情報（token）は ~/.muser/gui.json にあります。止めるときは ctrl+c。'));
    await setupDone;
    ({agent, museName} = await prepare(o));
  } else {
    await onboardFor(o);
    ({agent, museName} = await prepare(o));
  }
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
  // The server's open conversations share the node-slot cap (/settings 'maxNodeSlots'), so
  // every open conversation has a node slot of its own to register.
  host = new SessionsHost({maxOpen: require('../src/settings').numberValue('maxNodeSlots'), create: async ({cwd, account, mode, session, maxAgents, maxAgentsTotal, focusEnabled, noFocus}) => {
    // A conversation opened through the API onboards its own account first (its
    // login window opens if that account's login lapsed), like a window would.
    let accountId;
    if (account) { accountId = resolveAccount(account).id; }
    // Third H3: session === 'new' is the explicit-new sentinel, not a stored
    // session — it has no account of its own (the pool/flag logic below runs).
    else if (session && session !== 'new') accountId = session.account || 'default';
    // No fixed account: onboardFor's pool logic decides whose login to check
    // (a lapsed default login is no reason to open its window when the pool
    // would start on another ready account).
    if (accountId === undefined) await onboardFor({...o, account: undefined, resume: undefined, continue: false});
    else await onboard({accountId});
    const built = await prepare(o, {cwd, account, mode, session, maxAgents, maxAgentsTotal, focusEnabled, noFocus});
    const ctrl = makeController(built.agent, built.museName);
    wireConversation(built.agent, ctrl, {resumed: !!session && session !== 'new'}); // Third H3: 'new' resumed nothing
    return {agent: built.agent, controller: ctrl, museName: built.museName};
  }});
  const defCtrl = makeController(agent, museName);
  host.addPrepared({agent, controller: defCtrl, museName, isDefault: true});
  if (server) {
    // Setup mode: this server already opened (same port/token, gui.json
    // already written) — hand it the conversations and stay on it.
    server.setHost(host);
  } else {
    server = new GuiServer({host, token, port: o.port, version: VERSION, serverDiscoveryFile: discovery.serverFile(), onStop: stop});
    // A failed start must not strand the prepared agent (recovery scan): the
    // process would hang holding its MCP children and gateway client.
    try { await server.start(); } catch (e) { await host.closeAll().catch(() => {}); try { await agent.closeGracefully(); } catch {} throw e; }
    console.log(t('GUI サーバーを起動しました: {url}', {url: server.url}));
    console.log(t('接続情報（token）は ~/.muser/gui.json にあります。止めるときは ctrl+c。'));
  }
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
    console.log(t('Muser Server: pid {pid} / port {port} / version {version} / 起動 {at}', {pid: live.pid, port: live.port, version: live.version, at: new Date(live.startedAt).toLocaleString(dateLocale())}));
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
      if (live.pid !== info.pid) throw new Error(t('Server の pid が記録と一致しないため、強制終了はしませんでした。'));
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
  if (!hit) { process.exitCode = 1; const msg = t('{id} に当たる窓はありません。muser status で一覧を見られます。', {id});
    // --json stays JSON on the error paths too (wave 16), mirroring the
    // exec --status --json gone case in execStatus(): the object goes to
    // stdout, the exit code stays 1, and nothing plain reaches stdout.
    if (o.json) return console.log(JSON.stringify({error: msg}, null, 1)); throw new Error(msg); }
  if (hit.ambiguous) { process.exitCode = 1; const msg = t('{id} に当たるものが複数あります: {list} — もう少し長く指定してください', {id, list: hit.ambiguous.map(h => h.kind + ' ' + (h.item.pid || h.item.shortId)).join(', ')});
    if (o.json) return console.log(JSON.stringify({error: msg}, null, 1)); throw new Error(msg); }
  if (o.json) return console.log(JSON.stringify(hit, null, 1));
  for (const line of status.formatDetail(hit)) console.log(line);
}

// `muser peers` / `muser tell` (src/tell.js): the other muser conversations on
// this PC and a way for a person (or another agent's shell) to leave one a
// message. The sender here is the CLI itself, not a conversation: its messages
// arrive labelled with this name, and no conversation is its own target.
function peersCommand(rest, o) {
  if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')}));
  const tell = require('../src/tell');
  if (!tell.enabled()) { if (o.json) return console.log(JSON.stringify({peers: [], disabled: true}, null, 1)); return console.log(t('tell は MUSER_TELL=0 で止められています。')); }
  const peers = tell.listPeers();
  if (o.json) return console.log(JSON.stringify({peers: peers.map(tell.peerSummary)}, null, 1));
  for (const line of tell.formatPeers(peers)) console.log(safeLine(line));
}
function tellCommand(rest, o) {
  const tell = require('../src/tell');
  // The early refusals stay JSON under --json (wave 16), like the send
  // failure below already was: the disabled case takes the peers --json
  // shape ({disabled: true}), the rest an {error} object — all on stdout,
  // each keeping the exit code its plain-text form had (1, via the throw).
  if (!tell.enabled()) { const msg = t('tell は MUSER_TELL=0 で止められています。'); if (o.json) { process.exitCode = 1; return console.log(JSON.stringify({disabled: true, error: msg}, null, 1)); } throw new Error(msg); }
  if (o.tellTarget !== undefined) { const msg = t('相手とファイルの両方は指定できません。どちらか片方にしてください。'); if (o.json) { process.exitCode = 1; return console.log(JSON.stringify({error: msg}, null, 1)); } throw new Error(msg); }
  const target = o.file ? undefined : rest[0];
  const text = (o.file ? rest : rest.slice(1)).join(' ');
  if ((!o.file && !target) || !text.trim()) { const msg = t('使い方: muser tell <相手> "…" / muser tell --file <パス> "…"'); if (o.json) { process.exitCode = 1; return console.log(JSON.stringify({error: msg}, null, 1)); } throw new Error(msg); }
  const r = tell.send({from: {pid: process.pid, sessionId: 'cli-' + process.pid, name: 'muser tell (CLI)', cwd: o.cwd, title: null, activity: null}, target, file: o.file, text, cwd: o.cwd});
  if (!r.ok) { process.exitCode = 1; if (o.json) return console.log(JSON.stringify({ok: false, error: r.error, message: r.message}, null, 1));
    // The failure text reflects the target word / file path and peer names
    // (not-found, ambiguous, no-claimant): it reached the terminal raw, so a
    // crafted target carried ESC/OSC 52 and bidi controls straight through,
    // at full length. Cut the reflected word to a name first, then safeLine
    // the whole line and cap it (wave4-F).
    let msg = String(r.message ?? '');
    const raw = o.file ? o.file : target;
    if (raw && msg.includes(String(raw))) msg = msg.replace(String(raw), () => safeName(raw));
    msg = safeLine(msg);
    const mcp = [...msg]; if (mcp.length > 500) msg = mcp.slice(0, 500).join('') + '…';
    throw new Error(msg); }
  if (o.json) return console.log(JSON.stringify({ok: true, to: r.to, id: r.id, ...(r.truncated ? {truncated: true, originalLength: r.originalLength} : {})}, null, 1));
  console.log(t('{name} に送りました。', {name: safeName(r.to.name || r.to.title || String(r.to.sessionId).slice(0, 8))}));
  if (r.truncated) console.log(t('長すぎたため 2000 文字で切りました（元の長さ: {n}）。残りは届いていません。', {n: r.originalLength}));
}

// Text that came from outside this process (a phone's device name, a conversation
// title) is printed by the list commands with plain console.log: strip control
// characters first, or an ESC sequence in a name/title runs on the user's
// terminal (OSC 52 clipboard writes, fake lines) when they merely list (deep c3 #4).
// Bidi controls and zero-width characters are removed outright, not spaced:
// they carry no visible width of their own, and left in they rewrite how the
// surrounding text LOOKS (U+202E Trojan-Source style). The set mirrors
// src/ui/sanitize.mjs's CTRL_CHARS (U+061C, U+200E/200F, U+202A–U+202E,
// U+2066–U+2069, U+FEFF, U+200B), widened like src/sessions.js's title strip
// with the remaining zero-width marks (U+200C/U+200D joiners, U+2060) — a
// one-line name or title gains nothing from invisible joiners (wave4-F).
function safeLine(s) {
  return String(s ?? '')
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}
// A name reflected back to the terminal (an account label, a peer name, the
// word a failed lookup was for): safeLine-cleaned AND cut, so a 30,000-char
// name stored in the registry — or typed as a lookup word — cannot flood
// the terminal when a list or a not-found error merely echoes it (wave4-F).
function safeName(s) { const v = safeLine(s); const cp = [...v]; return cp.length > 80 ? cp.slice(0, 80).join('') + '…' : v; }

// Show a pairing: the QR (which carries everything) plus the code in plain
// text, or — for Wi-Fi pairing — the code alone, big enough to read aloud.
async function printPairing(link, mode, {code, expiresAt}) {
  const until = new Date(expiresAt).toLocaleTimeString(dateLocale());
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
  const until = new Date(r.expiresAt).toLocaleTimeString(dateLocale());
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
    for (const d of devices) console.log('  ' + safeLine(d.name) + '  (' + d.id.slice(0, 8) + ' / ' + t('最終接続: {at}', {at: d.lastSeen ? new Date(d.lastSeen).toLocaleString(dateLocale()) : t('まだなし')}) + ')');
    return;
  }
  throw new Error(t('「{word}」という link の操作はありません。使えるのは pair / revoke / autostart です', {word: sub}));
}

async function main() {
  try { return await mainDispatch(); }
  catch (e) {
    // EPIPE (wave 9): the stdout reader went away. No crash record (the
    // startup guard above is EPIPE-aware too) and no exit-1 override: the
    // run ends with the exit code already set, the one its status file got.
    if (isEpipeError(e)) return;
    // An exec --json invocation whose parse()/main()-stage check failed gets
    // its one result line on stdout as well as the plain stderr line (wave 9).
    if (!execJsonResultSent && isExecJsonRun(process.argv.slice(2))) { sendExecJsonError((e && e.message) || String(e)); return; }
    throw e;
  }
}

async function mainDispatch() {
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
  // serverfirst-debug B9: resume IS a subcommand spelling, so the old
  // !isCommand gate silently ignored both variables for exactly the
  // entry the comment above says they steer — the flags worked, the
  // variables did not. The variables steer what the flags steer.
  const envSteers = !isCommand || cmd === 'resume';
  if (!o.client && /^(1|true|yes|on)$/i.test(process.env.MUSER_CLIENT || '') && envSteers) o.client = true;
  if (o.client && isCommand && cmd !== 'resume') throw new Error(t('--client は対話モード専用です（exec / serve などとは併用できません）。'));
  // MUSER_DIRECT is --direct's pair (the escape hatch back to a standalone
  // session): it steers only the interactive entry, like MUSER_CLIENT.
  if (!o.direct && /^(1|true|yes|on)$/i.test(process.env.MUSER_DIRECT || '') && envSteers) o.direct = true;
  if (o.direct && isCommand && cmd !== 'resume') throw new Error(t('--direct は対話モード専用です（exec / serve などとは併用できません）。'));
  if (o.client && o.direct) throw new Error(t('--client と --direct は併用できません。'));
  // Flags that mean something for only one command used to be silently ignored by the
  // others (`muser --json <prompt>` started interactively; audit #250). Say so instead.
  // (--port's range is checked in parse(), so it is caught for every command.)
  const scoped = [
    // The session-shaping flags (wave 6): status / log / usage and friends used to
    // accept --mode / --cd / --max-agents / --account and silently ignore them.
    // Each row lists the commands that actually read the flag (family-level, like
    // the rows below: `server` includes its serve path, `link` its pair start).
    ['--mode', o.mode !== undefined, [undefined, 'exec', 'resume', 'serve', 'server', 'link', 'demo', 'race']],
    ['--cd', !!o.cdGiven, [undefined, 'exec', 'resume', 'serve', 'server', 'link', 'demo', 'race', 'hunt', 'lore', 'parity', 'crash', 'overnight', 'tell', 'export']],
    ['--max-agents', o.maxAgents !== undefined, [undefined, 'exec', 'resume', 'serve', 'server', 'link']],
    ['--max-agents-total', o.maxAgentsTotal !== undefined, [undefined, 'exec', 'resume', 'serve', 'server', 'link']],
    ['--no-focus', !!o.noFocus, [undefined, 'exec', 'resume', 'serve', 'server', 'link']],
    ['--account', o.account !== undefined, [undefined, 'exec', 'resume', 'serve', 'server', 'link', 'login', 'logout', 'pc-login', 'doctor', 'hunt', 'overnight']],
    ['--json', o.json, ['exec', 'status', 'log', 'worklog', 'lore', 'crash', 'parity', 'peers', 'tell']],
    ['--clear', o.clear, ['log', 'worklog']],
    ['--all', !!o.all, ['lore']],
    ['--proof', !!o.proof, ['exec']],
    ['--out', o.out !== undefined, ['parity']],
    ['--file', o.file !== undefined, ['tell']],
    ['--path', o.path !== undefined, ['lore']],
    ['--kind', o.kind !== undefined, ['lore']],
    ['--id', o.loreId !== undefined, ['lore']],
    ['--focus', o.focus !== undefined, ['log', 'worklog']],
    ['--why', o.why !== undefined, ['log', 'worklog']],
    ['--event', o.event !== undefined, ['log', 'worklog']],
    ['--hours', o.hours !== undefined, ['crash']],
    ['--before', o.before !== undefined, ['crash']],
    ['--status', o.status !== undefined, ['exec']],
    ['--status-file', o.statusFile !== undefined, ['exec']],
    ['--port', o.port !== undefined, ['serve', 'server', 'link']],
    ['--relay', o.relay !== undefined, ['serve', 'server', 'link']],
    ['--no-link', o.noLink, ['serve', 'server', 'link']],
    ['--no-lan', o.noLan, ['serve', 'server', 'link']],
    ['--wifi', o.wifi, ['link']],
    ['--agents', o.agents !== undefined, ['hunt']],
    ['--concurrent', o.concurrent !== undefined, ['hunt']],
    ['--fix', o.fix !== undefined, ['hunt']],
    // One row per flag: three separate --yes rows (one per feature branch) rejected
    // `hunt --yes` at the race row and `race --yes` at the hunt row.
    ['--yes', !!o.yes, ['hunt', 'race', 'export']],
    ['--n', o.n !== undefined, ['race']],
    ['--accounts', o.accounts !== undefined, ['race']],
    ['--max-tokens', o.maxTokens !== undefined, ['race']],
    ['--demo', o.demo, ['serve', 'server']],
    // The session selectors (first audit #30): doctor diagnosed the default
    // account and logout logged out the default account while a --session named
    // another conversation — both silently. They select a conversation for the
    // interactive / exec / serve paths (and the server that hosts them) only.
    ['--session', o.resume !== undefined, [undefined, 'exec', 'resume', 'serve', 'server', 'link', 'export']],
    ['--with-conversation', !!o.withConversation, ['export']],
    ['--dry-run', !!o.dryRun, ['export']],
    ['--window', o.window !== undefined, ['export']],
    ['--continue', !!o.continue, [undefined, 'exec', 'resume', 'serve', 'server', 'link']],
  ];
  for (const [flag, set, okFor] of scoped) {
    if (set && !okFor.includes(cmd)) throw new Error(t('{flag} はこの使い方では使えません。使い方: muser --help', {flag}));
  }
  // Trailing words are silently ignored by these subcommands (recovery scan):
  // `muser logout typo` logged out anyway. Ones that take no words say so.
  const noExtra = () => { if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')})); };
  // `muser version` is --version spelled as a word (wave 7): it used to fall
  // through to the interactive entry and be sent to Muse as a prompt.
  if (cmd === 'version') { noExtra(); return console.log(VERSION); }
  // `muser update` likewise went to Muse as a prompt (wave 7). Updating is
  // the /update command inside a window, so say that and end — in words a
  // non-interactive caller (a script, a pipe) can act on too.
  if (cmd === 'update') { noExtra(); return console.log(t('更新は、開いている muser の窓の中で /update と入力して行ってください（窓がなければ `muser` で開けます）。`muser update` では更新は行われません。')); }
  if (cmd === 'login') { noExtra(); return onboard({forceLogin: true, accountId: accountFromFlag(o)?.id}); }
  if (cmd === 'logout') { noExtra();
    // The default account, like `muser login`: without --account this logged out the FIRST
    // account whichever one was the default.
    const accounts = require('../src/accounts');
    const a = accountFromFlag(o) || accounts.get(accounts.activeId());
    require('../src/login').logout(accounts.filesFor(a.id));
    return console.log(accounts.list().length > 1 ? t('{label} からログアウトしました。', {label: safeName(a.label)}) : t('ログアウトしました。'));
  }
  if (cmd === 'pc-login') { noExtra(); return onboard({forceDevice: true, accountId: accountFromFlag(o)?.id}); }
  if (cmd === 'account') return accountCommand(rest, o);
  if (cmd === 'agent-skill') return agentSkillCommand(rest);
  if (cmd === 'doctor') { noExtra();
    // With a broken accounts.json, resolving --account throws before doctor
    // can run (wave 9): when the registry file itself is the broken one,
    // doctor proceeds on the default account and reports it instead.
    let acct = null;
    try { acct = accountFromFlag(o); } catch (e) { if (!configFileChecks().some(c => c.name === 'accounts.json' && c.state === 'broken')) throw e; }
    return doctor(acct); }
  if (cmd === 'usage') { noExtra();
    const usage = require('../src/usage');
    const pool = require('../src/account-pool');
    if (pool.multi()) {
      const all = await pool.statuses();
      // A fetch that failed is exit 1 (wave 15), as in the single-account
      // path below: the failure line alone, at exit 0, let a script read a
      // broken login as a successful usage check. An account that simply
      // is not logged in is a state, not a fetch failure.
      let fetchFailed = false;
      for (const s of all) {
        console.log((s.id === require('../src/accounts').activeId() ? '● ' : '○ ') + safeName(s.label) + (s.id === require('../src/accounts').activeId() ? t('（既定）') : ''));
        const broken = brokenStoreLines(s);
        if (broken.length) { fetchFailed = true; for (const line of broken) console.log(line); }
        else if (s.plan) console.log(usage.formatPlan(s.plan));
        else { if (s.hasLogin) fetchFailed = true; console.log(s.hasLogin ? t('Muse の利用状況を読み込めませんでした（muse.ai で確認できます）') : t('ログインしていません（`muser account add <名前>` で追加できます）')); }
        console.log('');
      }
      if (fetchFailed) process.exitCode = 1;
    } else {
      try { console.log(usage.formatPlan(await usage.plan()) + '\n'); } catch (e) { console.log(t('Muse の利用状況: {message}', {message: safeLine(e.message)}) + '\n'); process.exitCode = 1; }
    }
    return console.log(usage.formatSummary());
  }
  if (cmd === 'export') return require('../src/export-cli').run(rest, o);
  if (cmd === 'demo') {
    if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
    if (rest[0] && rest[0] !== 'login') {
      // An unknown demo word used to start the plain demo as if nothing was wrong.
      if (nearCommand(rest[0]) === 'login') throw new Error(t('「{word}」というデモはありません。もしかして: muser demo login', {word: rest[0]}));
      throw new Error(t('「{word}」というデモはありません。使えるのは muser demo と muser demo login です', {word: rest[0]}));
    }
    // The plain demo had no terminal guard (audit-cli wave 14 F-3): with no
    // terminal it drew one frame and exited 0 in silence. The other
    // interactive entries refuse in words (exit 1); `demo login` is not
    // guarded here — its prompts already fail in words (wave 9).
    if (rest[0] !== 'login' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error(t('対話モードには端末が必要です。パイプやスクリプトからは `muser exec` を使ってください。'));
    const d = await import('../src/ui/demo.mjs');
    return rest[0] === 'login' ? d.demoLogin({version: VERSION, cwd: o.cwd, mode: o.mode}) : d.demo({version: VERSION, cwd: o.cwd, mode: o.mode});
  }
  // Words after these commands were silently dropped (first audit #31): a
  // status read with prompt words ran no prompt, serve ignored its tail.
  if (cmd === 'exec' && o.status) { noExtra(); return execStatus(o.status, o); }
  if (cmd === 'exec') return exec(o, rest.join(' '));
  // parse() consumed a `--` after `race` (before its prompt tail began), so
  // race's own parser never saw it and re-read literal flag-shaped words as
  // flags (wave 17). Re-insert the token at the position it appeared so it
  // reaches raceCommand (and parseRaceArgs) in rest.
  if (cmd === 'race') { if (o.dashDashIndex !== undefined) rest.splice(Math.max(0, o.dashDashIndex - 1), 0, '--'); return raceCommand(rest, o); }
  if (cmd === 'serve') { noExtra(); return serve(o); }
  if (cmd === 'server') return serverCommand(rest, o);
  if (cmd === 'status') return statusCommand(rest, o);
  if (cmd === 'peers') return peersCommand(rest, o);
  if (cmd === 'tell') return tellCommand(rest, o);
  if (cmd === 'log' || cmd === 'worklog') return logCommand(rest, o); // worklog: the log command's alias (its data is the work log)
  if (cmd === 'lore') return loreCommand(rest, o);
  if (cmd === 'hunt') return huntCommand(rest, o);
  if (cmd === 'overnight') return overnightCommand(rest, o);
  if (cmd === 'crash') return crashCommand(rest, o);
  if (cmd === 'parity') return parityCommand(rest, o);
  if (cmd === 'link') return linkCommand(rest, o);
  if (cmd === 'resume') {
    // A positional id and --session naming DIFFERENT conversations (wave 16):
    // the flag used to be silently overwritten by the positional below. Both
    // refs go through resumeTarget — the same resolution a positional gets
    // (duplicate-id refusal, --cd disambiguation, title/body search fallback) —
    // and only refs that resolve to the same session may coexist; identical
    // spellings skip the resolution, as their target is trivially the same.
    if (rest[0] && o.resume !== undefined && rest[0] !== o.resume) {
      const sessions = require('../src/sessions');
      const cdFolder = o.cdGiven ? o.cwd : undefined;
      const a = resumeTarget(sessions, rest[0], cdFolder), b = resumeTarget(sessions, o.resume, cdFolder);
      if (a.id !== b.id) throw new Error(t('再開先が 2 つ指定されています: 引数の「{a}」と --session の「{b}」は違う会話です。どちらか片方にしてください。', {a: rest[0], b: o.resume}));
    }
    if (!rest[0] && (o.resume !== undefined || o.continue)) {
      // --session / --continue with no positional (wave 16): the flags were
      // accepted and then ignored — the branch listed instead of resuming.
      // o.resume already holds --session's id and sessionFromFlags resolves
      // it (and --continue's most recent session) on the interactive path,
      // exactly as it does for a positional id.
      return o.direct ? interactive(o, undefined) : o.client ? clientInteractive(o, undefined) : serverFirstInteractive(o, undefined);
    }
    if (!rest[0]) {
      // Wave 13: the user's own conversations come first and `muser exec`
      // runs (origin 'exec') fill only what is left of the cap — a day of
      // exec runs, each a session of its own, used to fill all 20 rows and
      // push the conversations the user actually wants to resume out of
      // the list entirely. Within each group the recent() order (newest
      // first) is kept, and the cap itself is unchanged.
      const usable = require('../src/sessions').recent().filter(s => s.turns);
      const list = [...usable.filter(s => s.origin !== 'exec'), ...usable.filter(s => s.origin === 'exec')].slice(0, 20);
      // One wording for "nothing to resume" at every bin entry (fourth M24;
      // the TUI /resume side is controller.mjs's own text).
      if (!list.length) return console.log(t('再開できる会話はありません。'));
      // The dimming goes through term.c like the rest of the UI: the raw escapes were printed
      // even into a pipe or with colours off (NO_COLOR / the color setting).
      const {c} = require('../src/tui/term');
      // A row whose updated is missing or unparseable (a hand-edited or
      // restored index) printed the literal text 'Invalid Date' (wave 13):
      // it gets a no-date marker in the same column instead.
      const when = s => { const d = s.updated === undefined || s.updated === null || s.updated === '' ? null : new Date(s.updated); return d && Number.isFinite(d.getTime()) ? d.toLocaleString(dateLocale()) : t('日付なし'); };
      for (const s of list) console.log(s.id.slice(0, 8) + '  ' + when(s).padEnd(22) + safeLine(s.title || '') + '  ' + c.dim(safeLine(s.cwd)));
      return console.log('\n' + t('muser resume <ID> で再開'));
    }
    o.resume = rest[0];
    const prompt = rest.slice(1).join(' ') || undefined;
    return o.direct ? interactive(o, prompt) : o.client ? clientInteractive(o, prompt) : serverFirstInteractive(o, prompt);
  }
  // A capitalised command (`muser Doctor`, wave 16) is not a prompt either:
  // nearCommand() lowercases its word, so an exact-but-for-case match read as
  // "already a command" there and the word fell through to an interactive
  // start. Name the exact command, in the typo guard's wording, and stop.
  const caseCmd = cmd && o._.length === 1 && !COMMAND_NAMES.includes(cmd) ? COMMAND_NAMES.find(c => c === String(cmd).toLowerCase()) : null;
  if (caseCmd) throw new Error(t('「{word}」というコマンドはありません。もしかして: muser {near}（Muse に頼むなら文章で書いてください）', {word: cmd, near: caseCmd}));
  // `muser doctro` used to go to Muse as a one-word prompt. A single word close to a command is a typo.
  const near = cmd && o._.length === 1 ? nearCommand(cmd) : null;
  if (near) throw new Error(t('「{word}」というコマンドはありません。もしかして: muser {near}（Muse に頼むなら文章で書いてください）', {word: cmd, near}));
  if (o.direct) return interactive(o, o._.join(' ') || undefined);
  if (o.client) return clientInteractive(o, o._.join(' ') || undefined);
  return serverFirstInteractive(o, o._.join(' ') || undefined);
}

const COMMAND_NAMES = ['login', 'logout', 'pc-login', 'doctor', 'usage', 'demo', 'exec', 'serve', 'server', 'status', 'log', 'link', 'resume', 'help', 'account', 'agent-skill', 'export', 'lore', 'hunt', 'crash', 'parity'];
// 'race' （競争） is appended rather than folded into the literal above: while
// sibling branches add their own subcommands to this file, each addition
// stays a pure append and the merges do not collide.
COMMAND_NAMES.push('race');
COMMAND_NAMES.push('overnight'); // night work (src/overnight/); pushed, not edited in, so parallel feature branches add theirs the same way without colliding
COMMAND_NAMES.push('peers'); // tell (src/tell.js): who else is working; pushed, not folded in, for the same reason
COMMAND_NAMES.push('tell'); // tell: send a peer a message; same append-only rule
COMMAND_NAMES.push('worklog'); // alias of `log` (muser worklog == muser log); same append-only rule
COMMAND_NAMES.push('version'); // --version as a word (wave 7); dispatched in main(), same append-only rule
COMMAND_NAMES.push('update'); // not an updater: main() points at the window's /update and ends (wave 7); same append-only rule
// `muser parity`: environment comparison, stage 1 (docs/design/new-features.md
// §10) — this PC only. snapshot prints the fingerprint as JSON (or writes it
// to --out); diff reads two fingerprint files the user carried between PCs
// and lists the differences likeliest-cause first. Stage 2 (fetching the
// other PC's snapshot for the user) is not built; nothing is sent anywhere.
function parityCommand(rest, o = {}) {
  const parity = require('../src/parity');
  const sub = rest[0];
  if (sub === 'snapshot') {
    if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
    const snap = parity.collectSnapshot({cwd: o.cwd});
    if (o.out) {
      const file = require('node:path').resolve(o.out);
      require('node:fs').writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
      return console.log(t('スナップショットを保存しました: {file}', {file}));
    }
    return console.log(JSON.stringify(snap, null, 2));
  }
  if (sub === 'diff') {
    // --out is snapshot's destination; on diff it was silently ignored (wave 17).
    if (o.out !== undefined) throw new Error(t('--out は parity snapshot でだけ使えます。'));
    if (rest.length !== 3) throw new Error(t('使い方: muser parity diff <A.json> <B.json>'));
    const a = parity.readSnapshotFile(require('node:path').resolve(rest[1]));
    const b = parity.readSnapshotFile(require('node:path').resolve(rest[2]));
    const items = parity.diffSnapshots(a, b);
    // Differences found is exit 1, like a diff tool (wave 15): the listing
    // alone left an automated check no way to notice the environments
    // differ. No differences stays exit 0.
    if (items.length) process.exitCode = 1;
    if (o.json) return console.log(JSON.stringify(items, null, 1));
    if (!items.length) return console.log(t('違いはありません。'));
    console.log(t('環境比較: {a} と {b}（違い {n} 件）', {a: rest[1], b: rest[2], n: items.length}));
    for (const sec of parity.diffSections(items)) {
      console.log(sec.heading);
      for (const [label, value] of sec.rows) console.log('  ' + label + ': ' + value);
    }
    return;
  }
  if (!sub) throw new Error(t('使い方: muser parity snapshot [--out <ファイル>] / muser parity diff <A.json> <B.json>') + '\n' + t('相手の PC と比べるには、相手の PC で muser parity snapshot --out を作り、ファイルを持ち運んで diff してください（この PC から取り寄せる機能は未実装です）'));
  throw new Error(t('「{word}」という parity の操作はありません。使えるのは snapshot / diff です', {word: sub}) + '\n' + t('相手の PC と比べるには、相手の PC で muser parity snapshot --out を作り、ファイルを持ち運んで diff してください（この PC から取り寄せる機能は未実装です）'));
}


// `muser export` lives in src/export-cli.js (stage 2): bin dispatches to it above,
// and the standalone entry src/export-entry.js calls it without loading bin at all.
// `muser log [会話id]`: the work log (design §1). No id lists the recent
// conversations that have one; an id shows that conversation's timeline;
// --json prints the raw entries; --clear deletes the work logs (the blobs
// too). The Focus decision log (weakness 9) held this command first, so it
// keeps its behaviour wherever the two do not overlap: --focus / --why /
// --event filter the decision log, and a conversation — or the newest
// log — with no work log yet falls back to the decision log.
function logCommand(rest, o = {}) {
  const {Worklog} = require('../src/worklog');
  if (o.clear) {
    if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')}));
    // --clear deletes EVERY work log (wave 16): combined with a filter flag
    // (--focus / --why / --event) it used to clear everything anyway, as if
    // the filter scoped the deletion. Refuse the combination instead and
    // delete nothing; an unfiltered --clear is unchanged.
    if (o.focus !== undefined || o.why !== undefined || o.event !== undefined) throw new Error(t('--clear は作業ログをすべて消します。--focus / --why / --event とは併用できません（絞り込んで消すことはできません）。'));
    const cleared = Worklog.clear();
    if (o.json) return console.log(JSON.stringify({files: cleared.files, blobs: cleared.blobs, bytes: cleared.bytes}, null, 2));
    return console.log(t('作業ログを消しました（{files} 件の会話、{mb} MB）。', {files: cleared.files, mb: (cleared.bytes / 1024 / 1024).toFixed(1)}));
  }
  if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
  const {FocusLog, logFile} = require('../src/focus-log');
  const sessions = require('../src/sessions');
  // Detail text (below the list) is printed through safeLine, capped at
  // 1,000 lines (wave 13 F2/F6): the formatters' lines were printed raw,
  // so a crafted entry in a hand-edited / restored log file (the writers
  // sanitise, the file can still be edited) carried terminal escapes
  // (OSC 52, bidi) straight to the screen — the list view above already
  // safeLines its lines — and a 3,000-entry log dumped all 3,000 lines at
  // once. --json is the machine path and stays whole and untouched.
  const LOG_DETAIL_LIMIT = 1000;
  const printDetail = lines => {
    const shown = lines.slice(0, LOG_DETAIL_LIMIT);
    for (const l of shown) console.log(safeLine(l));
    if (lines.length > shown.length) console.log(t('✂ {n} 行を省略', {n: lines.length - shown.length}));
  };
  const focusFiltered = o.focus !== undefined || o.why !== undefined || o.event !== undefined;
  if (!rest[0] && !focusFiltered) {
    const rows = Worklog.list();
    if (rows.length) {
      if (o.json) return console.log(JSON.stringify(rows.map(({file, ...r}) => r), null, 2));
      const {c} = require('../src/tui/term');
      for (const r of rows.slice(0, 20)) {
        const s = sessions.find(r.id);
        console.log(r.id.slice(0, 8) + '  ' + new Date(r.updated).toLocaleString(dateLocale()).padEnd(22) + safeLine(s?.title || r.title || '') + '  ' + c.dim(t('ターン {turns} ・ 出来事 {events}', {turns: r.turns, events: r.events}) + (r.gaps ? '  ' + t('記録の欠け {n} 件', {n: r.gaps}) : '')));
      }
      // The list was cut at 20 rows in silence (wave 16): say how many were
      // left out, in the detail view's truncation wording, and where the
      // whole list is (--json prints every row, as before).
      if (rows.length > 20) console.log(t('✂ {n} 件を省略（--json で全件表示）', {n: rows.length - 20}));
      return console.log('\n' + t('muser log <ID> で時系列を表示'));
    }
  }
  // The truly empty state (wave 15): no work log rows and no Focus log file
  // either. Every other command's empty state is a guidance line at exit 0
  // (resume / peers / hunt status…); this one used to fall through to the
  // Focus fallback below and exit 1 with a line about the decision log
  // only, as if the work log the user asked for had failed to load.
  if (!rest[0] && !focusFiltered && !FocusLog.latestFile()) {
    if (o.json) return console.log('[]');
    return console.log(t('作業ログも判定ログもまだありません。会話を進めると作業ログが、Focus のタスクを実行すると判定ログが記録されます。'));
  }
  let session = null;
  if (rest[0]) {
    session = sessions.find(rest[0]);
    if (sessions.find.ambiguous) throw new Error(t('会話 ID があいまいです: {ref}', {ref: rest[0]}));
    if (!session && !focusFiltered) {
      // A conversation whose session-ledger entry is gone (or that only
      // ever ran headless) still has its work log — the list above shows
      // it, so the detail view reads it too (features-debug #6).
      const rows = Worklog.list().filter(r => r.id === rest[0] || r.id.startsWith(rest[0]));
      // Several prefix matches and no exact one is ambiguous, not missing
      // (wave 13 F3): the session-ledger path above says so and the resume
      // path lists candidates — this fallback fell through to "not found"
      // instead. Say it the same way, with the candidates.
      if (rows.length > 1 && !rows.some(r => r.id === rest[0])) {
        throw new Error(t('会話 ID があいまいです: {ref}', {ref: rest[0]}) + '\n' + rows.slice(0, 10).map(r => '  ' + r.id + '  ' + safeLine(r.title || '')).join('\n'));
      }
      const row = rows.find(r => r.id === rest[0]) || (rows.length === 1 ? rows[0] : null);
      if (row) {
        const entries = Worklog.readFile(row.file);
        if (entries.length) {
          if (o.json) return console.log(JSON.stringify(entries, null, 2));
          printDetail(Worklog.format(entries));
          return;
        }
      }
    }
    if (!session) throw new Error(t('会話が見つかりません: {ref}', {ref: rest[0]}));
  }
  if (!focusFiltered && session) {
    const entries = Worklog.read(session.id);
    if (entries.length) {
      if (o.json) return console.log(JSON.stringify(entries, null, 2));
      printDetail(Worklog.format(entries));
      return;
    }
  }
  let file = null;
  if (session) file = logFile(session.id);
  else {
    file = FocusLog.latestFile();
    if (!file) throw new Error(t('判定ログがありません。Focus のタスクを実行すると記録されます。'));
  }
  const entries = FocusLog.readFile(file, {focus: o.focus, why: o.why, event: o.event});
  if (o.json) { console.log(JSON.stringify(entries, null, 2)); return; }
  const lines = FocusLog.format(entries);
  if (!lines.length) console.log(t('条件に合うログがありません。'));
  else printDetail(lines);
}
// `muser lore …`: the code memory for this folder (src/lore.js). Reading folds
// new work-log edits into records; --json prints the records themselves.
function loreCommand(rest, o = {}) {
  // Outside forget, the lore subcommands never checked their words (wave 17):
  // trailing positionals were ignored and the forget-only flags (--all /
  // --kind / --path / --id) were handed back below and silently dropped.
  // Refuse both, in the same wording as the other commands. `hunch` is the
  // one exception for positionals: its premise is free words after the target.
  const sub = rest[0] || 'list';
  if (sub !== 'forget') {
    const badFlag = o.all ? '--all' : o.kind !== undefined ? '--kind' : o.path !== undefined ? '--path' : o.loreId !== undefined ? '--id' : null;
    if (badFlag) throw new Error(t('{flag} はこの使い方では使えません。使い方: muser --help', {flag: badFlag}));
    const maxWords = {list: 0, scars: 0, graves: 0, hunches: 0, sync: 0, why: 1, story: 1, 'hunch-state': 2, share: 1}[sub];
    if (maxWords !== undefined && rest.length - 1 > maxWords) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1 + maxWords).join(' ')}));
  }
  // parse() took --all / --json out of the words; hand them back so
  // src/lore.js sees `forget --all` exactly as typed. The forget selectors
  // (--kind / --path / --id, wave 15) go back the same way, as separate
  // flag + value words: runLoreCli's scan reads that shape (never --kind=x).
  const words = [...rest];
  if (o.all) words.push('--all');
  if (o.json) words.push('--json');
  if (o.kind !== undefined) words.push('--kind', o.kind);
  if (o.path !== undefined) words.push('--path', o.path);
  if (o.loreId !== undefined) words.push('--id', o.loreId);
  const code = require('../src/lore').runLoreCli(words, {cwd: o.cwd});
  if (code) process.exitCode = code;
}
// `muser hunt [範囲] | --fix <重要度> | status`: bug hunt (design §6; the core
// is src/hunt.js). Agents run as `muser exec` children. The estimate (agents,
// account) is always printed first; the run starts only after a yes, or at
// once with --yes — without a terminal to answer in, it does not start.
async function huntCommand(rest, o = {}) {
  const hunt = require('../src/hunt');
  const cwd = o.cwd;
  const account = accountFromFlag(o);
  const accountId = account?.id, accountLabel = account?.label;
  if (rest[0] === 'status') {
    if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
    for (const l of hunt.formatStatusLines(hunt.readStatus(cwd))) console.log(l);
    return;
  }
  const confirm = async estimate => {
    for (const l of hunt.formatEstimateLines(estimate)) console.log(l);
    if (o.yes) return true;
    if (!process.stdin.isTTY) { console.log(t('確認できないため開始しません。--yes を付けると開始します。')); return false; }
    const rl = require('node:readline').createInterface({input: process.stdin, output: process.stdout});
    // stdin closing (Ctrl+D, terminal gone) resolves as "no", like the server
    // stop prompt above (wave 18): the bare question promise never settled on
    // EOF — the command hung, or ended silently with exit 0 when no handle was
    // left, bypassing the not-started exit 1 the callers set on a decline.
    try { const ans = await new Promise(res => { let done = false; const fin = v => { if (!done) { done = true; res(v); } }; rl.question(t('開始しますか？（y/N）: '), fin); rl.on('close', () => fin('')); }); return /^y(es)?$/i.test(String(ans).trim()); }
    finally { rl.close(); }
  };
  const runAgent = hunt.execRunAgent({cwd});
  const quota = hunt.makeDefaultQuota();
  if (o.fix !== undefined) {
    if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')}));
    const level = hunt.normSeverity(o.fix);
    if (!level || level === 'None') throw new Error(t('重要度の指定が正しくありません: {level}（Critical / High / Medium）', {level: o.fix}));
    const prepared = hunt.prepareFix({cwd, level});
    prepared.estimate.account = accountLabel || accountId || prepared.estimate.account;
    if (!prepared.targets.length) { console.log(t('修正できる所見がありません。')); return; }
    // Not starting is a failure the caller can see (wave 15): a declined or
    // unanswerable confirmation used to exit 0, so a script could not tell
    // "fixed nothing because it never ran" from a finished fix run.
    if (!await confirm(prepared.estimate)) { process.exitCode = 1; return; }
    const r = await hunt.runFix(prepared, {runAgent, quota, account: accountId,
      onProgress: ev => { if (ev.type === 'fix-start') console.log(ev.file); }});
    hunt.offerScarsToLore(r.outcomes, cwd);
    for (const l of hunt.formatFixSummaryLines(r.summary)) console.log(l);
    for (const l of hunt.formatStatusLines(r.state)) console.log(l);
    return;
  }
  const prepared = hunt.prepareAudit({cwd, scope: rest.join(' ') || undefined, agents: o.agents, account: accountId, accountLabel});
  if (!await confirm(prepared.estimate)) { process.exitCode = 1; return; } // not started: exit 1, as in the fix path above (wave 15)
  const state = await hunt.runAudit(prepared, {runAgent, quota, account: accountId, maxConcurrent: o.concurrent || 3,
    onProgress: ev => { if (ev.type === 'group-done') console.log(ev.tag + ': ' + ev.status); }});
  for (const l of hunt.formatStatusLines(state)) console.log(l);
}
// `muser race "指示"` （競争， src/race.js): the same task in N worktrees on
// different accounts/strategies, compared by the same checks. The winner is
// applied only after its diff is shown and confirmed; `apply` / `clean`
// finish a race that was left standing (e.g. by a piped run).
async function raceCommand(rest, o = {}) {
  const race = require('../src/race');
  const askText = async q => {
    if (!process.stdin.isTTY) return null;
    const rl = require('node:readline').createInterface({input: process.stdin, output: process.stderr});
    // stdin closing (Ctrl+D, terminal gone) resolves as null — the same "no
    // answer" the no-terminal case above returns — instead of never settling
    // (wave 18; the server stop / hunt confirm pattern): askYes then declines,
    // and a pick is left standing with the way back printed.
    try { return await new Promise(r => { let done = false; const fin = v => { if (!done) { done = true; r(v); } }; rl.question(q, fin); rl.on('close', () => fin(null)); }); } finally { rl.close(); }
  };
  const askYes = async q => { const a = await askText(q); return a !== null && /^y(es)?$/i.test(a.trim()); };
  // The pre-apply diff is capped for the terminal — and says so when it
  // is cut, so a 200+ line diff is never approved unseen (features-debug #31).
  const showDiff = diff => {
    if (!diff) return;
    const lines = diff.split('\n');
    console.log(lines.slice(0, 200).join('\n'));
    if (lines.length > 200) console.log(t('（差分は {total} 行あります。先頭 200 行だけを表示しました）', {total: lines.length}));
  };
  if (rest[0] === 'apply' || rest[0] === 'clean') {
    if (rest.includes('--yes')) o = {...o, yes: true}; // after the id/number it arrives as a word (promptTail), not a flag
    const args = rest.filter(w => w !== '--yes');
    // Extra words were silently ignored (clean) or read past (apply) (wave 17):
    // apply takes id + racer (+ --yes, removed above), clean only the id.
    const extra = args.slice(rest[0] === 'apply' ? 3 : 2);
    if (extra.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: extra.join(' ')}));
    const result = race.loadRace(args[1]);
    if (!result) throw new Error(t('競争が見つかりません: {id}', {id: args[1] || ''}));
    if (rest[0] === 'clean') { await race.cleanupRace(result); return console.log(t('片付けました: {id}', {id: result.id})); }
    // The racer number must be plain digits (wave 17): bare Number() read
    // '0x1' / '1.0' / '1e0' as racer 1.
    if (!/^\d+$/.test(args[2] ?? '') || !result.racers.some(x => x.index === Number(args[2]))) throw new Error(t('競争が見つかりません: {id}', {id: args[2] || ''}));
    const index = Number(args[2]);
    const diff = race.diffText(result, index);
    showDiff(diff);
    if (!o.yes && !(await askYes(t('この差分を今の作業ツリーに当てますか？ [y/N] ')))) return console.log(t('当てずに残してあります: {dir}', {dir: result.dir}));
    const applied = await race.applyWinner(result, index);
    if (!applied.ok) throw new Error(applied.error || t('当てられませんでした。'));
    await race.cleanupRace(result);
    return console.log(applied.empty ? t('変更はありませんでした。作業フォルダーを片付けました。') : t('当てました。作業フォルダーを片付けました。'));
  }
  const fromWords = race.parseRaceArgs(rest.join(' '));
  if (!fromWords.task) throw new Error(t('使い方: muser race [--n 3] [--accounts a,b] [--max-tokens N] [--yes] "指示"'));
  const opts = {n: o.n ?? fromWords.n ?? 3, accounts: o.accounts ?? fromWords.accounts, maxTokens: o.maxTokens ?? fromWords.maxTokens, yes: !!o.yes || fromWords.yes};
  // A --n written after the task words reaches here via parseRaceArgs, not parse():
  // validate it the same way before the estimate can print it (wave 6).
  if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 8) throw new Error('--n: ' + t('参加者は 1〜{max} 体にしてください。', {max: 8}));
  for (const l of race.estimate(opts).lines) console.log(l);
  const dirty = await race.dirtyFiles(o.cwd);
  let includeDirty = false;
  if (dirty.length) { console.log(t('未コミットの変更が {n} 件あります。含めた状態から始めます。', {n: dirty.length})); includeDirty = true; }
  // The race never started (no terminal to ask in, or a no): exit 1 like
  // hunt's not-started path, so a script can tell it from a finished race
  // (wave 15). The declines further down are different: that race already
  // ran, and its result is left standing on purpose.
  if (!opts.yes && !(await askYes(t('始めますか？ [y/N] ')))) { process.exitCode = 1; return console.log(t('やめました。')); }
  const result = await race.runRace({cwd: o.cwd, task: fromWords.task, n: opts.n, accounts: opts.accounts, maxTokens: opts.maxTokens, includeDirty, mode: o.mode, onProgress: m => console.error('· ' + m)});
  for (const l of race.formatRaceResult(result)) console.log(l);
  const pick = await askText(t('どれを使いますか？番号を入力（0 で使わない）: '));
  if (pick === null) return console.log(t('使うときは: muser race apply {id} <番号> --yes（片付けは muser race clean {id}）', {id: result.id}));
  // Only an explicit 0 throws the race away. A typo (or a bare Enter) used
  // to take the same path and delete every racer's work unasked; anything
  // that is not a racer number now leaves the race standing, with the way
  // back printed (features-debug #30).
  if (pick.trim() === '0') { await race.cleanupRace(result); return console.log(t('片付けました: {id}', {id: result.id})); }
  const index = Number(pick.trim());
  if (!result.racers.some(x => x.index === index)) {
    console.log(t('その番号の参加者はいません。そのまま残してあります: {dir}', {dir: result.dir}));
    return console.log(t('使うときは: muser race apply {id} <番号> --yes（片付けは muser race clean {id}）', {id: result.id}));
  }
  const diff = race.diffText(result, index);
  showDiff(diff);
  if (!(await askYes(t('この差分を今の作業ツリーに当てますか？ [y/N] ')))) return console.log(t('当てずに残してあります: {dir}', {dir: result.dir}));
  const applied = await race.applyWinner(result, index);
  if (!applied.ok) throw new Error(applied.error || t('当てられませんでした。'));
  await race.cleanupRace(result);
  return console.log(applied.empty ? t('変更はありませんでした。作業フォルダーを片付けました。') : t('当てました。作業フォルダーを片付けました。'));
}
// `muser overnight …`: the night-work queue and run (src/overnight/cli.js,
// shared with the /overnight slash command so both word it the same).
async function overnightCommand(rest, o = {}) {
  const {overnightCli} = require('../src/overnight/cli');
  const {lines} = await overnightCli(rest, {cwd: o.cwd, account: o.account}); // --account works like account= (it was silently ignored)
  for (const l of lines) console.log(l);
}
// `muser crash [プロセス名]`: the recent falls lined up with the edits that
// came before each one (src/crash-investigate.js). --hours widens the window
// (default 1), --before how far before a fall edits are lined up (default
// 30 minutes), --json prints the whole report for a machine reader.
function crashCommand(rest, o = {}) {
  if (rest.length > 1) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.slice(1).join(' ')}));
  const ci = require('../src/crash-investigate');
  return ci.investigate({process: rest[0], hours: o.hours, beforeMin: o.before, cwd: o.cwd}).then(rep => {
    if (o.json) { console.log(JSON.stringify(rep, null, 2)); return; }
    for (const l of ci.formatLines(rep)) console.log(l);
  });
}
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
    // The no-file line was English even in the Japanese UI (wave 7): word it
    // through t() like the rest of bin. (s.summary() below stays as it is —
    // its body is written for the agent polling this, by design.)
    // A file was named (or found) but could not be read (wave 12): that is
    // 読めません, not ありません — ありません is only for "there is no run
    // at all" (no file in the folder, below).
    else console.log(file ? t('gone · 状態ファイルが読めません: {file}', {file}) : t('gone · 状態ファイルがありません（{dir} 内）', {dir: s.dir()}));
    process.exitCode = s.GONE; return;
  }
  // --json was silently ignored here (recovery scan): a script asking for data
  // gets the status object itself; the exit code keeps its meaning either way.
  // The object carries the JUDGED state and exit (wave 12), the same ones the
  // text form prints and the process exits with: a "running" file whose
  // process is gone is dead / 5 in JSON too, not the file's raw running with
  // no exit — a poller reading only JSON drew the opposite conclusion from
  // a poller reading the text form of the very same run.
  const exitCode = s.code(v);
  if (o.json) {
    const judged = v && typeof v === 'object' && !Array.isArray(v)
      ? {...v, state: s.verdict(v), exit: exitCode}
      : {state: 'gone', ok: false, error: 'unreadable status file', file, exit: exitCode};
    console.log(JSON.stringify(judged, null, 1));
  }
  else console.log(s.summary(v));
  process.exitCode = exitCode;
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

// The per-file way out for a status whose store files are broken (audit-cli wave 8):
// one line per broken file, naming its full path and the command that recreates it
// after the user deletes it by hand — the website login and the gateway credentials
// come back with login, the device pair with pc-login. Without this, a broken
// device.enc read as "device not registered" and a broken web.enc as "no login",
// and the prescribed login stopped on the same broken file.
function brokenStoreLines(s) {
  if (!Array.isArray(s?.unreadableFiles) || !s.unreadableFiles.length) return [];
  const store = require('../src/secure-store');
  const accounts = require('../src/accounts');
  return s.unreadableFiles.map(f => {
    const base = String(f).split(/[\\/]/).pop();
    const cmd = base === 'device.enc' || base === 'contact.enc' ? 'muser pc-login' : 'muser login';
    const command = '`' + cmd + (s.id && s.id !== accounts.DEFAULT_ID ? ' --account ' + s.id : '') + '`';
    return t('{path} が壊れています。ファイルを削除してから {command} を実行してください。', {path: safeLine(store.file(f)), command});
  });
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
      const broken = brokenStoreLines(s);
      const state = broken.length ? t('壊れています') : !s.hasLogin ? t('ログインなし') : !s.device ? t('端末登録なし') : t('利用できます');
      const use = s.plan ? t('週 {n}%', {n: s.plan.percentUsed ?? '?'}) : '';
      console.log((s.id === accounts.activeId() ? '● ' : '○ ') + safeName(s.label) + '  ' + state + (use ? '  ' + use : ''));
      for (const line of broken) console.log('  ' + line);
    }
    console.log('\n' + t('自動選択: {state}（`muser account auto on/off`、`--account <名前>` で個別指定もできます）', {state: pool.autoEnabled() ? 'on' : 'off'}));
    return;
  }
  if (sub === 'add') {
    const label = args.join(' ').trim();
    if (!label) throw new Error(t('使い方: muser account add <名前>'));
    const a = accounts.add(label);
    console.log(t('アカウント {label} を追加します。', {label: safeName(a.label)}));
    // A login window closed (or timed out) left the name registered with nothing behind it, and
    // `muser account add` with the same name then said it already existed.
    try { await onboard({forceLogin: true, forceDevice: true, accountId: a.id}); }
    catch (e) {
      if (!accounts.hasLogin(a.id)) { try { accounts.remove(a.id); } catch {} throw e; }
      // Login landed but device registration failed (first audit #33): the
      // half-registered account used to stay with no word on how to finish it,
      // and a re-add then just said the name already existed. Keep the login
      // (removing it would waste it) and name the finishing command.
      if (!accounts.hasDevice(a.id)) throw new Error(safeLine(e.message) + '\n' + t('アカウント {label} の端末登録が終わっていません。`muser login --account {id}` を実行すると、続きから行えます。', {label: safeName(a.label), id: a.id}));
      throw e;
    }
    // The same muse.ai user added under a second name is not a second allowance: the pool would
    // count one Muse twice. Said here, while the user can still remove it.
    const same = await pool.sameMuse(a.id).catch(() => null);
    if (same) console.log(t('注意: {label} は {other} と同じ muse.ai アカウントです。使用量は共通なので、別のアカウントでログインし直すか `muser account remove {id}` で消してください。', {label: safeName(a.label), other: safeName(same.label), id: a.id}));
    return;
  }
  if (sub === 'use') {
    if (!args.join(' ').trim()) throw new Error(t('使い方: muser account use <名前>'));
    // add takes the whole rest as the label; use/remove must resolve it whole
    // too (recovery scan) — a multi-word label could never be selected, and a
    // one-word account with the same first word was picked instead.
    const a = resolveAccount(args.join(' ') || '');
    accounts.setActive(a.id);
    return console.log(t('既定のアカウントを {label} にしました。', {label: safeName(a.label)}));
  }
  if (sub === 'remove') {
    if (!args.join(' ').trim()) throw new Error(t('使い方: muser account remove <名前>'));
    const a = resolveAccount(args.join(' ') || '');
    const {leftover} = accounts.remove(a.id) || {};
    console.log(t('アカウント {label} を削除しました（そのログイン情報も消しました）。', {label: safeName(a.label)}));
    if (leftover) console.log(t('Edge のログイン用フォルダーを消せませんでした（Edge が開いたままかもしれません）: {dir}　閉じてから削除してください。残っていると、同じ名前で追加したときに前のログインが戻ります。', {dir: safeLine(leftover)}));
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
  // #12: a stored session whose folder is a Windows system folder (the
  // default conversation a logon-started server created in system32) runs
  // in the home folder instead — system32 was never a chosen workspace.
  const {isWindowsSystemFolder, resolveDefaultCwd} = require('../src/server/default-cwd');
  if (isWindowsSystemFolder(session.cwd)) return resolveDefaultCwd(o.cwd);
  let ok = false; try { ok = require('node:fs').statSync(session.cwd).isDirectory(); } catch {}
  if (!ok) throw new Error(t('この会話のフォルダーがありません: {cwd}（別のフォルダーで続けるなら --cd <フォルダー> を付けてください）', {cwd: session.cwd}));
  return session.cwd;
}

// The session `muser resume <id>` names. A prefix that fits several sessions said "not found";
// it lists them instead. An id held EXACTLY by several sessions (a hand-edited /
// merged index — nothing in normal operation creates one) is a different dead
// end: no longer spelling can tell them apart, so say the id itself is shared
// and list the candidates by date/title/folder instead of advising a longer
// id. An explicit --cd folder is a way through: it picks the duplicate entry
// that belongs to that folder, when exactly one does (the matchIndex rule in
// src/sessions.js: the cwd strings compared as stored, String(...) === String(...)).
// A prefix whose matches are all copies of that one id gets the same shared-id
// error (wave 15): lengthening the prefix only ever reaches the same dead end.
function resumeTarget(sessions, ref, cdFolder) {
  const session = sessions.find(ref);
  if (session) return session;
  if (sessions.find.ambiguous) {
    const candidates = sessions.findAll(ref);
    const exact = candidates.filter(s => s.id === ref);
    // The duplicated-id group this ref names (wave 15): the full id itself,
    // or — for a prefix — every candidate sharing ONE id. The prefix case
    // used to get the "specify more of the id" line below, but no length of
    // that id can tell its copies apart: the shared-id error is the truth
    // at every length, so say it (with the shared id, not the prefix).
    const dupes = exact.length > 1 ? exact : candidates.length > 1 && candidates.every(s => s.id === candidates[0].id) ? candidates : null;
    if (dupes) {
      if (cdFolder !== undefined) {
        const byCwd = dupes.filter(s => String(s.cwd || '') === String(cdFolder || ''));
        if (byCwd.length === 1) return byCwd[0];
      }
      const when = s => { const d = s.updated === undefined || s.updated === null || s.updated === '' ? null : new Date(s.updated); return d && Number.isFinite(d.getTime()) ? d.toLocaleString(dateLocale()) : t('日付なし'); };
      const list = dupes.slice(0, 10).map(s => '  ' + s.id + '  ' + when(s) + '  ' + (s.title || '') + '  ' + (s.cwd || ''));
      throw new Error([t('会話 ID「{id}」は {n} 件の会話で共有されています。長く指定しても区別できません:', {id: dupes[0].id, n: dupes.length}), ...list, t('フォルダーで選ぶには --cd <フォルダー> を付けてください。')].join(String.fromCharCode(10)));
    }
    const list = candidates.slice(0, 10).map(s => '  ' + s.id + '  ' + (s.title || '') + '  ' + s.cwd);
    throw new Error([t('「{id}」に当てはまる会話が複数あります。もう少し長く指定してください:', {id: ref}), ...list].join(String.fromCharCode(10)));
  }
  // W13-14 remainder: the ref is not an id (find returned undefined and was
  // not ambiguous) — treat it as title/body search text. One hit resumes it
  // exactly as a find hit would; several hits are listed, never auto-picked,
  // because exec --session shares this resolution and must not guess. A
  // pure-digit ref is not search text either (the wave-15 TUI rule, kept for
  // the --session routing in wave 16): it was an id or a list number, so a
  // digit-led miss stays a plain not-found.
  const hits = !/^\d+$/.test(String(ref)) && typeof sessions.search === 'function' ? sessions.search(ref) : [];
  if (!hits.length) throw new Error(t('会話が見つかりません: {id}', {id: ref}));
  if (hits.length === 1) return hits[0].session;
  const whenS = s => { const d = s.updated === undefined || s.updated === null || s.updated === '' ? null : new Date(s.updated); return d && Number.isFinite(d.getTime()) ? d.toLocaleString(dateLocale()) : t('日付なし'); };
  const list = hits.slice(0, 10).map(h => { const s = h.session; return '  ' + safeLine(s.id) + '  ' + safeLine(whenS(s)) + '  ' + safeLine(s.title || '') + '  ' + safeLine(s.cwd || '') + (h.matchedIn === 'body' && h.snippet ? ' / ' + safeLine(h.snippet) : ''); });
  throw new Error([t('「{q}」の検索に当てはまる会話が複数あります。ID で指定してください:', {q: ref}), ...list].join(String.fromCharCode(10)));
}

// The settings files doctor reports on (audit-cli wave 9): each is only READ
// here — doctor never repairs, moves or rewrites one. A file that does not
// exist yet is normal (nothing has needed it); one that exists but does not
// parse, or parses into the wrong shape, is broken. accounts.json lives in
// the secure store; the rest live in ~/.muser (mcp.json's path mirrors
// src/mcp.js's FILE, read off the module would load the MCP stack for a
// path string).
function configFileChecks() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../src/secure-store');
  const parsePlain = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const entries = [
    ['config.json', () => require('../src/config').file(), f => require('../src/config').readJson(f), isObj],
    ['accounts.json', () => store.file('accounts.json'), parsePlain, v => isObj(v) && Array.isArray(v.accounts)],
    ['mcp.json', () => path.join(os.homedir(), '.muser', 'mcp.json'), parsePlain, v => isObj(v) && (v.mcpServers === undefined || isObj(v.mcpServers))],
    ['permissions.json', () => require('../src/permissions').file(), parsePlain, isObj],
    ['sessions.json', () => require('../src/sessions').FILE, parsePlain, v => Array.isArray(v) || (isObj(v) && Array.isArray(v.sessions))],
  ];
  return entries.map(([name, fileOf, parse, valid]) => {
    let file;
    try { file = fileOf(); } catch { return {name, file: name, state: 'broken'}; }
    try { fs.readFileSync(file); } catch (e) { return {name, file, state: e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : 'broken'}; }
    try { return {name, file, state: valid(parse(file)) ? 'ok' : 'broken'}; } catch { return {name, file, state: 'broken'}; }
  });
}
// How to fix a broken accounts.json (wave 9): move the broken file aside so a
// fresh registry is created on the next start — and say plainly that the
// account list starts empty, so every account must log in again.
function accountsRepairLines(file) {
  return [
    t('  → 直し方: 壊れたファイル {file} を別の名前（例: accounts.json.corrupt）に退避（移動）してから、muser をもう一度起動してください。新しい accounts.json が作り直されます。', {file}),
    t('  注意: 退避すると登録済みのアカウント一覧は空に戻るため、各アカウントで `muser login` と `muser pc-login` を使ってログインし直してください。'),
  ];
}

// Each check runs on its own: one failure used to abort doctor before the later checks (and
// their remedies) could even print, so the user saw a stack-free error and no way forward.
// account: the one --account names; the default account otherwise (the flag was accepted and ignored).
async function doctor(account) {
  const {createWeb, loadJar, probe} = require('../src/web');
  const accounts = require('../src/accounts');
  // A broken accounts.json used to kill doctor right here (wave 9): the
  // registry read throws, and the one command that should diagnose it died
  // before printing a single check. Fall back to the default account and let
  // the settings-file check below report the broken file and its remedy.
  const fileChecks = configFileChecks();
  const brokenChecks = fileChecks.filter(c => c.state === 'broken');
  let id = account?.id || accounts.DEFAULT_ID, registryBroken = false;
  try { id = account?.id || accounts.activeId(); } catch { registryBroken = true; }
  if (registryBroken) console.log(t('アカウント    : accounts.json を読めなかったため、既定のアカウントで点検します'));
  else { try { if (accounts.list().length > 1) console.log(t('アカウント    : {label}', {label: accounts.get(id)?.label || id})); } catch {} }
  const files = accounts.filesFor(id);
  // The remedies name the account checked: a bare `muser login` signs in the default one.
  let activeSafe = accounts.DEFAULT_ID; try { activeSafe = accounts.activeId(); } catch {}
  const flag = id !== activeSafe ? ' --account ' + id : '';
  // The jar and the web client are loaded lazily, inside the steps that use
  // them (wave 15): a broken web.enc (loadJar throws out of the secure
  // store) used to kill doctor right here, before a single check printed —
  // the one command meant to diagnose that file showed none of its checks.
  // Now the load failure lands in the web steps' own failure lines, with
  // their remedies, and every other check still runs.
  let jar = null, web = null, jarError = null, jarTried = false;
  const loadWeb = () => {
    if (!jarTried) { jarTried = true; try { jar = loadJar(files.web); web = createWeb(jar, {file: files.web}); } catch (e) { jarError = e; } }
    if (jarError) throw jarError;
    return {jar, web};
  };
  // The login state the first step finds decides the gateway step's remedy
  // (fifth c2-2): an expired login (probe 'waiting') used to get "check your
  // network" on the gateway line and no remedy at all on its own line, so the
  // one action that fixes it — `muser login` — was never named.
  let loginState = null;
  const loginRemedy = t('  → 直し方: `{cmd}` でログインし直してください', {cmd: 'muser login' + flag});
  const steps = [
    [t('設定ファイル'), async () => {
      const lines = fileChecks.map(c => '  ' + c.name + ': ' + (c.state === 'ok' ? t('読めます') : c.state === 'missing' ? t('まだありません') : t('壊れています')) + '（' + c.file + '）');
      const acc = fileChecks.find(c => c.name === 'accounts.json');
      if (acc && acc.state === 'broken') lines.push(...accountsRepairLines(acc.file));
      return [t('設定ファイル  : {n} 件を確認しました', {n: fileChecks.length}), ...lines].join('\n');
    }, t('  → 設定ファイルを確認できませんでした'), false, () => brokenChecks.length > 0],
    [t('Web ログイン'), async () => { loginState = await probe(loadWeb().jar, files.web); const line = t('Web ログイン  : {state}', {state: loginState}); return loginState === 'ready' ? line : line + '\n' + loginRemedy; }, loginRemedy, false, () => loginState !== null && loginState !== 'ready'],
    [t('ゲートウェイ'), async () => {
      const {connectChat} = require('../src/session');
      const client = await connectChat(loadWeb().web, {file: files.session});
      try { return t('ゲートウェイ  : 接続できました（会話 {n} 件）', {n: (await client.sessions())?.sessions?.length ?? '?'}); }
      finally { client.disconnect(false); }
    }, () => jarError || (loginState && loginState !== 'ready') ? loginRemedy : t('  → 直し方: ネットワークを確認して、もう一度 `muser doctor` を実行してください')], 
    [t('PC の端末'), async () => {
      const auth = require('../src/pc-login').createAuth(loadWeb().web, {file: files.device});
      const pc = auth.snapshot();
      // The raw phase code ('start', 'code', …) is an internal name: say it in words (wave 6).
      const phaseWords = {start: t('まだ始まっていません（未登録）'), contact: t('連絡先の入力待ち'), code: t('認証コードの入力待ち'), account: t('アカウントの選択待ち'), two_factor: t('追加認証の待ち'), checkpoint: t('Muse 側で追加の確認が必要'), authenticated: t('認証済み')};
      const phase = phaseWords[pc.phase] || pc.phase;
      return t('PC の端末     : {phase}', {phase: phase + (pc.phase === 'authenticated' ? ' (vm ' + ((await auth.vm()).vm_id ? 'ok' : '?') + ')' : '')});
    }, t('  → 直し方: `{cmd}` でこの PC を端末として登録し直してください', {cmd: 'muser pc-login' + flag})],
    // Read through usage.peekSummary(), never summary() (wave 13 F1):
    // summary()'s load() moves a corrupt usage.json aside, so the check
    // itself renamed the file and then reported a clean "0 turns" over
    // it. Doctor only looks: a broken store is reported as broken and the
    // file stays exactly where it was.
    [t('今日の利用'), async () => { const s = require('../src/usage').peekSummary(); if (s.corrupt) return t('今日の利用') + '    : ' + t('壊れています'); const u = s.today; return t('今日の利用    : {turns} ターン、PC 操作 {tools} 回', {turns: u.turns, tools: u.toolCalls}); }, t('  → 利用記録は読めませんでした（なくても作業はできます）'), true],
    [t('ウィンドウ'), async () => {
      // Which windows are open and which node slot each holds (src/node-slots.js): the way
      // to see why a chat's calls land in a particular window.
      const fs = require('node:fs'), path = require('node:path');
      const {defaultDir, alive} = require('../src/relay');
      const dir = defaultDir();
      const {LOCK} = require('../src/node-slots');
      // No instances folder yet (a new environment) means no windows, not a failure (wave 6).
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return t('ウィンドウ    : 開いている muser はありません'); throw e; }
      const locks = names.filter(n => LOCK.test(n)).map(n => { try { const m = LOCK.exec(n); return {slot: (m[1] ? m[1] + ' ' : '') + m[2], pid: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).pid}; } catch { return null; } }).filter(Boolean);
      if (!locks.length) return t('ウィンドウ    : 開いている muser はありません');
      return t('ウィンドウ    : {list}', {list: locks.map(l => t('窓 {slot}（pid {pid}{state}）', {slot: l.slot, pid: l.pid, state: alive(l.pid) ? '' : t('・終了済み')})).join('、')});
    }, t('  → ウィンドウ一覧は読めませんでした（なくても作業はできます）'), true],
  ];
  // A failed check is a failed doctor (recovery scan): the exit code used to be
  // 0 whatever happened, so scripts wrapping `muser doctor` could not detect a
  // broken login or device. The two informational steps (marked soft) do not
  // fail it — their remedies say the work goes on without them.
  let failed = false;
  for (const [name, run, remedy, soft, isBad] of steps) {
    try { console.log(await run()); if (isBad && isBad()) failed = true; }
    catch (e) { console.log(t('{name}を確認できませんでした: {error}', {name, error: e.message})); console.log(typeof remedy === 'function' ? remedy() : remedy); if (!soft) failed = true; }
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
main().catch(e => { if (isEpipeError(e)) return; // wave 9: a closed stdout is not a failure — keep the exit code already set
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h'); console.error('muser: ' + ((e && e.message) || String(e))); process.exitCode = 1; });
