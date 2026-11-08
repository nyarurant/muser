'use strict';
// First-run screen: wordmark, the steps still to do, and clack-style prompts for each.
const p = require('@clack/prompts');
const {logo, gradient} = require('./logo');
const {c} = require('./term');
const {t} = require('../i18n');

function header(steps) {
  console.log('');
  for (const l of logo()) console.log('  ' + l);
  console.log('  ' + c.gray(t('muse.ai を、ターミナルで。')) + c.faint('  ' + t('(非公式)')));
  console.log('');
  // ● done ─ ◆ now ─ ○ later
  const line = steps.map(s => s.state === 'done' ? c.green('● ' + t(s.label)) : s.state === 'now' ? c.accent(c.bold('◆ ' + t(s.label))) : c.faint('○ ' + t(s.label))).join(c.faint('  ─  '));
  console.log('  ' + line);
  console.log('');
}

function cancelled(v) { if (p.isCancel(v)) { p.cancel(t('中止しました。')); process.exit(130); } return v; }

// What to show when a step fails: code below may throw a string or an object, not only
// Error, and reading .message off those printed a red 'undefined' (fix2 c10 #16).
function errText(e) { return e && e.message ? String(e.message) : String(e); }

// A clack prompt whose input ends never settles on its own (audit-cli wave 14
// F-1): on an empty line Ctrl+D is EOF to the readline under the prompt, which
// closes that interface and leaves @clack/core's promise pending forever —
// in raw mode even Ctrl+C stops working, because the terminal raises no
// SIGINT and nothing is listening for the key any more. The same hang follows
// when the input stream itself ends mid-prompt. Watch the input while a
// prompt is open and abort it on EOF (clack turns an abort into its cancel
// symbol), so the prompt ends as a cancel like any other. Only an empty
// field treats Ctrl+D as EOF, exactly as readline does; inside typed text
// it keeps readline's own behaviour (delete a character). Emptiness is
// judged on the prompt readline's own line (rl.line), which readline
// itself keeps current through every edit — counting keypresses by hand
// missed the deletions Ctrl+W, Ctrl+K and Delete make, so a field emptied
// through them still read as holding text and its Ctrl+D hung the prompt
// again (audit-cli wave 18). The readline is clack's, created under run();
// capture it while the prompt is open. This listener is registered before
// that interface exists, so on the Ctrl+D keypress rl.line still shows
// the field as it was before the key — readline's own basis for the same
// decision.
function promptWithEof(run, {initial = ''} = {}) {
  const ac = new AbortController();
  const input = process.stdin;
  const readline = require('node:readline');
  const origCreateInterface = readline.createInterface;
  let rl = null;
  const captureCreateInterface = function (...args) {
    const iface = origCreateInterface.apply(this, args);
    const src = args[0] && typeof args[0] === 'object' && 'input' in args[0] ? args[0].input : args[0];
    if (src === input) rl = iface;
    return iface;
  };
  readline.createInterface = captureCreateInterface;
  const onKeypress = (str, key) => {
    if (!key) return;
    if (key.ctrl && key.name === 'd') {
      // No readline captured (run opened none on this input): fall back to
      // the initial value, the only content the field can hold then.
      const line = rl ? rl.line : String(initial || '');
      if (!line) ac.abort();
    }
  };
  const onEnd = () => ac.abort();
  input.on('keypress', onKeypress);
  input.once('end', onEnd);
  input.once('close', onEnd);
  const done = () => {
    input.off('keypress', onKeypress); input.off('end', onEnd); input.off('close', onEnd);
    if (readline.createInterface === captureCreateInterface) readline.createInterface = origCreateInterface;
  };
  let promise;
  try { promise = run(ac.signal); } catch (e) { done(); throw e; }
  return Promise.resolve(promise).finally(done);
}

function isCancelKey(str, key) {
  return str === '\u0003' || (key && key.sequence === '\u0003') || !!(key && key.ctrl && key.name === 'c');
}

// While a clack spinner runs, @clack/prompts blocks input and its block()
// answers Ctrl+C with process.exit(0) and an English 'Canceled' (audit-cli
// wave 14 F-2): an interrupted preparation read as success to `&&` chains
// and scripts, unlike a prompt cancel. Guard the spinner's whole run: the
// keypress listener is registered before the spinner starts, so it runs
// before block()'s, and a real SIGINT — or SIGBREAK, the Ctrl+Break
// signal a Windows terminal raises instead — reaches this listener
// first too —
// both end the preparation as a cancel: the 中止しました。 line and exit
// 130, like a prompt cancel. Returns the disarm function.
function guardSpinner(spinner) {
  const stop = () => {
    try { if (typeof spinner.clear === 'function') spinner.clear(); else if (typeof spinner.stop === 'function') spinner.stop(); } catch {}
    p.cancel(t('中止しました。'));
    process.exit(130);
  };
  const onKeypress = (str, key) => { if (isCancelKey(str, key)) stop(); };
  process.stdin.on('keypress', onKeypress);
  process.once('SIGINT', stop);
  process.once('SIGBREAK', stop);
  return () => { process.stdin.off('keypress', onKeypress); process.removeListener('SIGINT', stop); process.removeListener('SIGBREAK', stop); };
}

// The header steps for a given state. Registration already in place is 'done' even while
// a login is still needed — it used to read 'later' (fix2 c10 #14) and then be skipped.
function stepsFor(needLogin, deviceNeeded) {
  return [
    {key: 'login', label: 'muse.ai にログイン', state: needLogin ? 'now' : 'done'},
    {key: 'device', label: 'この PC を登録', state: !deviceNeeded ? 'done' : needLogin ? 'later' : 'now'},
    {key: 'go', label: 'はじめる', state: 'later'},
  ];
}

// serverfirst-debug S8: with {onCancel}, a prompt cancel is handed back
// to the caller as the cancel symbol instead of exiting the process —
// the Server setup driver must ALSO cancel the server's flow, which an
// exit(130) from inside a prompt could never do (the flow stayed in its
// prompt on the server, orphaned). Without onCancel the old behaviour
// stands: print the cancel line and exit 130.
function makeCancelled(onCancel) {
  return v => {
    if (p.isCancel(v)) {
      p.cancel(t('中止しました。'));
      if (typeof onCancel === 'function') return v;
      process.exit(130);
    }
    return v;
  };
}

// A clack prompt with no terminal on stdin can never be answered: the
// prompt either waits for keys that cannot come or resolves at once and
// the caller reads that as a successful answer (audit-cli wave 9). Fail in
// words instead, the same precondition bin/muser.js puts on its other
// interactive entries. Checked at call time, per prompt.
function requireTerminal() {
  if (!process.stdin.isTTY) throw new Error(t('対話入力が必要です。端末から実行してください。'));
}

// The ui object pc-login.js drives.
function clackUi({onCancel} = {}) {
  const cancelledHere = makeCancelled(onCancel);
  const password = async (message, {hint} = {}) => { requireTerminal(); return cancelledHere(await promptWithEof(signal => p.password({message: message + (hint ? c.faint('  ' + hint) : ''), signal}))); };
  return {
    info: s => p.log.info(s),
    note: s => p.log.message(s),
    ask: async (message, opts = {}) => {
      requireTerminal();
      // serverfirst-debug S7: a secret prompt (a verification code) must
      // not echo in plain text — the setup driver passes secret through,
      // and the masked password ask is the only right surface for it.
      // (Before, ask dropped the flag and codes appeared on screen and
      // in scrollback.)
      if (opts.secret) return password(message, opts);
      const {hint, placeholder, initial} = opts;
      const initialValue = initial != null && String(initial) !== '' ? String(initial) : undefined;
      const v = cancelledHere(await promptWithEof(signal => p.text({message: message + (hint ? c.faint('  ' + hint) : ''), placeholder, initialValue, signal, validate: v => (!v || !v.trim()) ? t('入力してください') : undefined}), {initial: initialValue || ''}));
      return typeof v === 'string' ? v.trim() : v;
    },
    password,
    confirm: async message => { requireTerminal(); return cancelledHere(await promptWithEof(signal => p.confirm({message, signal}))); },
    // An empty list used to open a select with nothing to pick, leaving Ctrl+C as the
    // only way out and no word about why (fix2 c10 #15); descriptions ride along as hints.
    pick: async (message, items) => {
      if (!items || !items.length) throw new Error(t('選択肢がありません。'));
      requireTerminal();
      return cancelledHere(await promptWithEof(signal => p.select({message, signal, options: items.map((it, i) => ({value: i, label: it.label, ...(it.hint || it.description ? {hint: it.hint || it.description} : {})}))})));
    },
    async busy(label, fn) {
      const s = p.spinner(); const unguard = guardSpinner(s); s.start(label);
      try { const r = await fn(); s.stop(c.faint(label.replace(/しています$|っています$/, '') + ' ✓')); return r; }
      catch (e) { s.stop(c.red(errText(e)), 2); throw e; }
      finally { unguard(); }
    },
  };
}

// Returns once web login and device registration are both in place.
// needDevice may be a function: it is asked again AFTER the login step, because
// the login can change whose device registration is in place (recovery scan).
async function onboard({needLogin, needDevice, login, register, again = false, ui}) {
  const deviceWanted = () => typeof needDevice === 'function' ? !!needDevice() : !!needDevice;
  let deviceNow = deviceWanted();
  if (!needLogin && !deviceNow) return;
  header(stepsFor(needLogin, deviceNow));
  // A PC that was set up before is redoing a step (a lapsed login, a device unlinked on
  // muse.ai), not meeting muser for the first time.
  if (again) p.intro(gradient(t(' おかえりなさい ')) + c.gray(needLogin && deviceNow ? t(' ログインと端末の登録をやり直します') : needLogin ? t(' ログインをやり直します') : t(' 端末の登録をやり直します')));
  else p.intro(gradient(t(' はじめまして ')) + c.gray(t(' 最初の準備をします（1回だけ）')));
  if (needLogin) {
    p.log.step(c.bold(t('muse.ai にログイン')));
    p.log.message(t('Edge の小さい窓が開きます。Muse（Meta アカウント）でログインしてください。') + '\n' + c.faint(t('パスワードは muser には渡りません。完了すると窓は自動で閉じます。')));
    const s = p.spinner(); const unguard = guardSpinner(s); s.start(t('ログインを待っています'));
    try { await login(msg => s.message(msg)); s.stop(t('ログインしました')); }
    catch (e) { s.stop(c.red(errText(e)), 2); throw e; }
    finally { unguard(); }
    deviceNow = deviceWanted(); // re-ask under the login that just landed
  }
  if (deviceNow) {
    p.log.step(c.bold(t('この PC を Muse の端末として登録')));
    p.log.message(t('Muse がこの PC でファイルを読んだりコマンドを動かしたりするための登録です。') + '\n' + c.faint(t('Muse の 設定 › デバイス に「{host} CLI (muser)」として出ます。', {host: require('node:os').hostname()})));
    // A caller outside the terminal (the GUI serve's SetupFlow) can drive
    // the registration through its own ui; with none given, clack as before.
    await register(ui || clackUi());
    p.log.success(t('登録しました'));
  }
  p.outro(c.green(t('準備完了')) + c.gray(t('  muser を起動します')));
}

// "Language / 言語", before anything else on a first run, and in the demos. A valid MUSER_LANG skips it.
// save: false leaves an earlier choice untouched (the first-run demo asks every time).
async function askLanguage({save = true} = {}) {
  const i18n = require('../i18n');
  if (i18n.norm(process.env.MUSER_LANG)) return;
  // No terminal (serve, a pipe, a script): a clack select waits for keys that can never
  // come and the command hangs with no error (fix2 fifth c2-1, onboard part). Fall back
  // to the OS language for this run, like a cancelled pick, and let the caller proceed.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return i18n.setLang(i18n.chosen() || i18n.osLang(), {save: false});
  const picked = await promptWithEof(signal => p.select({message: 'Language / 言語', options: [{value: 'en', label: 'English'}, {value: 'ja', label: '日本語'}], initialValue: i18n.chosen() || i18n.osLang(), signal}));
  if (p.isCancel(picked)) return i18n.setLang(i18n.chosen() || i18n.osLang(), {save: false});
  i18n.setLang(picked, {save});
}

module.exports = {onboard, header, askLanguage, clackUi, stepsFor, errText};
