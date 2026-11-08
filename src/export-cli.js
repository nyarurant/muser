'use strict';
// `muser export`: the /export report from the command line, for when the
// TUI itself will not open. Moved out of bin/muser.js in stage 2 so the
// standalone entry (src/export-entry.js) can run it without loading bin:
// bin's first-word branch hands `export` to that entry in a child process
// before any other module loads, and the entry falls back to
// src/export-standalone.js when THIS module (or anything it needs) fails
// to load. The building and redaction live in src/export.js; this only
// picks the conversation (or, with --window, the window), shows what will
// be sent, confirms, and prints the outcome. The conversation body is
// opt-in (--with-conversation) and stays off under --yes too: --yes skips
// the question, not the choice.
const {t} = require('./i18n');
const exporter = require('./export');
const sessions = require('./sessions');

// A yes/no question on the terminal, the server-stop shape: stdin closing
// (Ctrl+D, the terminal gone) answers "no", never a hang and never a yes.
async function askYesNo(question) {
  const {createInterface} = require('node:readline');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const answer = await new Promise(r => { let done = false; const fin = v => { if (!done) { done = true; r(v); } }; rl.question(question, fin); rl.on('close', () => fin('')); });
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}
async function askLine(question) {
  const {createInterface} = require('node:readline');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const answer = await new Promise(r => { let done = false; const fin = v => { if (!done) { done = true; r(v); } }; rl.question(question, fin); rl.on('close', () => fin('')); });
  rl.close();
  return String(answer).trim();
}

// Show the sizes, confirm (unless --yes / --dry-run), then send. Shared by
// the conversation report and the --window report. `extra` is the
// confirmation screen's "with the conversation body it would be this
// much" note, when the caller can compute it.
async function finish(report, o, label, extra = null) {
  if (o.dryRun) {
    const file = exporter.saveReport(report);
    console.log(t('送らずにファイルに書きました: {file}', {file}));
    for (const line of exporter.sizeLines(report)) console.log(line);
    return;
  }
  if (!o.yes) {
    // No terminal, no confirmation: refuse rather than send unseen (the
    // report exists only because its owner saw it and agreed).
    if (!process.stdin.isTTY) throw new Error(t('確認できないため送りません。送るなら --yes、ファイルに書くなら --dry-run を付けてください。'));
    console.log(t('送るレポートの中身（{label}）:', {label}));
    for (const line of exporter.sizeLines(report, extra)) console.log(line);
    if (!await askYesNo(t('このレポートを開発者に送りますか？ [y/N] '))) return console.log(t('送りませんでした。'));
  }
  try {
    const {id} = await exporter.sendReport(report);
    return console.log(exporter.sentMessage(id));
  } catch (e) {
    process.exitCode = 1;
    return console.log(exporter.failureMessage(e));
  }
}

function pickSession(o) {
  if (o.resume) {
    const session = sessions.find(o.resume);
    if (sessions.find.ambiguous) throw new Error(t('会話 ID があいまいです: {ref}', {ref: o.resume}));
    if (!session) throw new Error(t('会話が見つかりません: {ref}', {ref: o.resume}));
    return session;
  }
  // The most recent conversation: this folder's first, then any folder's
  // (the crash that needs reporting rarely happened in this exact folder).
  const session = sessions.recent(o.cwd).find(s => s.turns) || sessions.recent().find(s => s.turns);
  if (!session) throw new Error(t('送る会話がありません。まず muser で会話をしてから実行してください。'));
  return session;
}

// --window: report on a RUNNING window. Without a value, list the live
// windows and let the user pick (a terminal is required for that; a pid
// or a session-id prefix names one directly). The window is asked for
// its current state and events ring through its window-status folder
// (src/export-window.js); a window that does not answer contributes its
// last status file and the watchdog's hang record instead.
async function windowReport(o) {
  const winMod = require('./export-window');
  const windows = winMod.listWindows();
  if (!windows.length) throw new Error(t('動いている窓がありません。'));
  let target = null;
  if (o.window === true) {
    console.log(t('動いている窓:'));
    windows.forEach((w, i) => console.log('  ' + (i + 1) + '. pid ' + w.pid + '  ' + (w.activity || '') + '  ' + (w.session ? t('会話 {id}（{turns} ターン）', {id: String(w.session.id).slice(0, 8), turns: w.session.turns ?? 0}) : t('会話なし')) + '  ' + (w.updatedAt || '')));
    if (!process.stdin.isTTY) throw new Error(t('窓を選べません。--window <pid> で窓を指定してください。'));
    const pick = await askLine(t('どの窓の分を送りますか？ [番号] '));
    target = windows[Number(pick) - 1] || null;
    if (!target) throw new Error(t('窓が選べませんでした: {pick}', {pick}));
  } else {
    const want = String(o.window);
    target = windows.find(w => String(w.pid) === want) || windows.find(w => w.session && String(w.session.id).startsWith(want)) || null;
    if (!target) throw new Error(t('その窓が見つかりません: {want}（動いている窓は muser export --window で一覧できます）', {want}));
  }
  const includeConversation = !!o.withConversation;
  const collected = await winMod.collectWindow(target.pid);
  let accountList = [];
  try { accountList = require('./accounts').list(); } catch {}
  const ordinalOf = id => { const i = accountList.findIndex(a => a.id === id); return i >= 0 ? i + 1 : null; };
  const rawState = collected.answered && collected.state ? collected.state : target;
  const section = exporter.windowShape(rawState, true, includeConversation, ordinalOf);
  section.pid = target.pid;
  section.answered = collected.answered;
  if (collected.answered) section.events = collected.events;
  else section.hang = winMod.latestHang(target.pid);
  // The report's conversation is the window's own, when it is a saved one:
  // its turns and Focus records ride as usual, the live section rides as
  // `window`. A window without a saved conversation gets a bare stub.
  let session = null;
  if (target.session && target.session.id) { try { session = sessions.find(target.session.id); } catch {} }
  if (!session) session = {id: (target.session && target.session.id) || ('window-' + target.pid), cwd: target.cwd || null, created: target.startedAt ? Date.parse(target.startedAt) : null, updated: target.updatedAt ? Date.parse(target.updatedAt) : null, turns: target.session?.turns ?? 0};
  const report = exporter.buildReport({session, includeConversation, uiMode: 'cli', window: section});
  return finish(report, o, t('窓 pid {pid}', {pid: target.pid}));
}

async function run(rest, o) {
  if (rest.length) throw new Error(t('余分な引数です: {words}。使い方: muser --help', {words: rest.join(' ')}));
  if (o.dryRun && o.yes) throw new Error(t('--dry-run と --yes は一緒に使えません。'));
  if (o.window !== undefined) return windowReport(o);
  const session = pickSession(o);
  const includeConversation = !!o.withConversation;
  const report = exporter.buildReport({session, includeConversation, uiMode: 'cli'});
  const extra = !o.dryRun && !o.yes && !includeConversation
    ? {conversationBytes: Math.max(0, exporter.sectionSizes(exporter.buildReport({session, includeConversation: true, uiMode: 'cli'})).total - exporter.sectionSizes(report).total)}
    : null;
  return finish(report, o, t('会話 {id}', {id: session.id.slice(0, 8)}), extra);
}

// The standalone entry's path: parse just export's own flags from the raw
// words after `export` (bin's parse() never ran in that process).
async function runArgs(argv) {
  const o = {_: [], cwd: process.cwd()};
  const valued = {'--session': 'resume', '--window': 'window', '--cd': 'cwd'};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let eqValue;
    const eq = /^--(session|window|cd)=(.*)$/.exec(a);
    if (eq) { a = '--' + eq[1]; eqValue = eq[2]; }
    if (a === '--with-conversation') o.withConversation = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (valued[a]) {
      if (a === '--window' && eqValue === undefined) {
        const v = argv[i + 1];
        if (v !== undefined && !v.startsWith('-')) { o.window = v; i++; } else o.window = true;
      } else {
        const v = eqValue !== undefined ? eqValue : argv[++i];
        if (v === undefined || v === '' || String(v).startsWith('--')) throw new Error(t('{flag} には値が必要です。使い方: muser --help', {flag: a}));
        o[valued[a]] = v;
      }
    } else if (a.startsWith('--')) throw new Error(t('知らないオプションです: {flag}（使えるのは {flags}）', {flag: a, flags: '--session <ID> / --with-conversation / --dry-run / --yes / --window [pid] / --cd <dir>'}));
    else o._.push(a);
  }
  if (o.cwd) o.cwd = require('node:path').resolve(o.cwd);
  return run(o._, o);
}

module.exports = {run, runArgs, askYesNo};
