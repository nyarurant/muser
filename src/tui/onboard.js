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

// The ui object pc-login.js drives.
function clackUi() {
  return {
    info: s => p.log.info(s),
    note: s => p.log.message(s),
    ask: async (message, {hint, placeholder} = {}) => cancelled(await p.text({message: message + (hint ? c.faint('  ' + hint) : ''), placeholder, validate: v => (!v || !v.trim()) ? t('入力してください') : undefined})).trim(),
    confirm: async message => cancelled(await p.confirm({message})),
    pick: async (message, items) => cancelled(await p.select({message, options: items.map((it, i) => ({value: i, label: it.label}))})),
    async busy(label, fn) {
      const s = p.spinner(); s.start(label);
      try { const r = await fn(); s.stop(c.faint(label.replace(/しています$|っています$/, '') + ' ✓')); return r; }
      catch (e) { s.stop(c.red(e.message), 2); throw e; }
    },
  };
}

// Returns once web login and device registration are both in place.
async function onboard({needLogin, needDevice, login, register}) {
  if (!needLogin && !needDevice) return;
  const steps = [
    {key: 'login', label: 'muse.ai にログイン', state: needLogin ? 'now' : 'done'},
    {key: 'device', label: 'この PC を登録', state: needLogin ? 'later' : needDevice ? 'now' : 'done'},
    {key: 'go', label: 'はじめる', state: 'later'},
  ];
  header(steps);
  p.intro(gradient(t(' はじめまして ')) + c.gray(t(' 最初の準備をします（1回だけ）')));
  if (needLogin) {
    p.log.step(c.bold(t('muse.ai にログイン')));
    p.log.message(t('Edge の小さい窓が開きます。Muse（Meta アカウント）でログインしてください。') + '\n' + c.faint(t('パスワードは muser には渡りません。完了すると窓は自動で閉じます。')));
    const s = p.spinner(); s.start(t('ログインを待っています'));
    try { await login(msg => s.message(msg)); s.stop(t('ログインしました')); }
    catch (e) { s.stop(c.red(e.message), 2); throw e; }
  }
  if (needDevice) {
    p.log.step(c.bold(t('この PC を Muse の端末として登録')));
    p.log.message(t('Muse がこの PC でファイルを読んだりコマンドを動かしたりするための登録です。') + '\n' + c.faint(t('Muse の 設定 › デバイス に「{host} CLI (muser)」として出ます。', {host: require('node:os').hostname()})));
    await register(clackUi());
    p.log.success(t('登録しました'));
  }
  p.outro(c.green(t('準備完了')) + c.gray(t('  muser を起動します')));
}

// "Language / 言語", before anything else on a first run, and in the demos. MUSER_LANG skips it.
// save: false leaves an earlier choice untouched (the first-run demo asks every time).
async function askLanguage({save = true} = {}) {
  const i18n = require('../i18n');
  if (process.env.MUSER_LANG) return;
  const picked = await p.select({message: 'Language / 言語', options: [{value: 'en', label: 'English'}, {value: 'ja', label: '日本語'}], initialValue: i18n.chosen() || i18n.osLang()});
  if (p.isCancel(picked)) return i18n.setLang(i18n.chosen() || i18n.osLang(), {save: false});
  i18n.setLang(picked, {save});
}

module.exports = {onboard, header, askLanguage};
