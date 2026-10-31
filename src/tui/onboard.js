'use strict';
// First-run screen: wordmark, the steps still to do, and clack-style prompts for each.
const p = require('@clack/prompts');
const {logo, gradient} = require('./logo');
const {c} = require('./term');

function header(steps) {
  console.log('');
  for (const l of logo()) console.log('  ' + l);
  console.log('  ' + c.gray('muse.ai を、ターミナルで。') + c.faint('  (非公式)'));
  console.log('');
  // ● done ─ ◆ now ─ ○ later
  const line = steps.map(s => s.state === 'done' ? c.green('● ' + s.label) : s.state === 'now' ? c.accent(c.bold('◆ ' + s.label)) : c.faint('○ ' + s.label)).join(c.faint('  ─  '));
  console.log('  ' + line);
  console.log('');
}

function cancelled(v) { if (p.isCancel(v)) { p.cancel('中止しました。'); process.exit(130); } return v; }

// The ui object pc-login.js drives.
function clackUi() {
  return {
    info: s => p.log.info(s),
    note: s => p.log.message(s),
    ask: async (message, {hint, placeholder} = {}) => cancelled(await p.text({message: message + (hint ? c.faint('  ' + hint) : ''), placeholder, validate: v => (!v || !v.trim()) ? '入力してください' : undefined})).trim(),
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
  p.intro(gradient(' はじめまして ') + c.gray(' 最初の準備をします（1回だけ）'));
  if (needLogin) {
    p.log.step(c.bold('muse.ai にログイン'));
    p.log.message('Edge の小さい窓が開きます。Muse（Meta アカウント）でログインしてください。\n' + c.faint('パスワードは muser には渡りません。完了すると窓は自動で閉じます。'));
    const s = p.spinner(); s.start('ログインを待っています');
    try { await login(msg => s.message(msg)); s.stop('ログインしました'); }
    catch (e) { s.stop(c.red(e.message), 2); throw e; }
  }
  if (needDevice) {
    p.log.step(c.bold('この PC を Muse の端末として登録'));
    p.log.message('Muse がこの PC でファイルを読んだりコマンドを動かしたりするための登録です。\n' + c.faint('Muse の 設定 › デバイス に「' + require('node:os').hostname() + ' CLI (muser)」として出ます。'));
    await register(clackUi());
    p.log.success('登録しました');
  }
  p.outro(c.green('準備完了') + c.gray('  muser を起動します'));
}

module.exports = {onboard, header};
