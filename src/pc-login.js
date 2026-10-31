'use strict';
// Terminal version of the desktop app's "PC 接続の設定": get an SDK token, verify the account
// with an email / SMS code (account choice, 2FA as needed), mint this PC's device pair.
// The prompts come from `ui` (the onboarding screen); plain readline is the fallback.
const readline = require('node:readline/promises');
const store = require('./secure-store');
const {PcAuth} = require('./core/pc-auth');
const {t} = require('./i18n');

function createAuth(web) {
  return new PcAuth({
    load: () => store.load('device.enc'),
    save: value => store.save('device.enc', value),
    request: web.nativeRequest, listSdk: () => web.sdkRequest('GET'), issueSdk: () => web.sdkRequest('POST'),
    expectedVm: async () => (await web.fetchJson('/api/session'))?.vm_id,
  });
}

function plainUi() {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  return {
    note: s => console.log(s), info: s => console.log(s),
    ask: async (q, {hint} = {}) => (await rl.question(q + (hint ? ' (' + hint + ')' : '') + ': ')).trim(),
    confirm: async q => /^y(es)?$/i.test((await rl.question(q + ' [y/N] ')).trim()),
    pick: async (q, items) => { items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}`)); return Number(await rl.question(q + t(' 番号: '))) - 1; },
    busy: async (_label, fn) => fn(),
    close: () => rl.close(),
  };
}

async function pcLogin(web, ui = plainUi()) {
  const auth = createAuth(web);
  try {
    let s = auth.snapshot();
    if (s.phase === 'authenticated') { await ui.busy(t('確認しています'), () => auth.vm()); ui.info(t('この PC は登録済みです。')); return auth; }
    if (!s.hasSdkToken) {
      const list = await ui.busy(t('SDK トークンを確認しています'), () => web.sdkRequest('GET'));
      if (Array.isArray(list.tokens) && list.tokens.length >= list.maxActiveTokens) {
        // One SDK token per account, already held by Muse Desktop Community: share it and
        // register this CLI as a second device with its own node id.
        // Without that app (anyone but its users) the account's tokens are simply used up: say so.
        let shared;
        try { shared = require('./desktop-import').desktopSdkToken(); }
        catch { throw new Error(t('この muse.ai アカウントの SDK トークンが上限（{max} 個）に達しています。使っていないトークンを muse.ai 側で削除してから、もう一度 `muser pc-login` を実行してください。', {max: list.maxActiveTokens})); }
        ui.info(t('SDK トークンは Muse Desktop Community のものを共有します（この CLI は別の端末として登録）。'));
        auth.persist(shared);
      } else if (!(await ui.confirm(t('SDK トークン「muser CLI」を発行します。利用規約に同意しますか？')))) throw new Error(t('中止しました。'));
    }
    s = await ui.busy(t('準備しています'), () => auth.start(true));
    const contact = await ui.ask(t('Muse にログインしているメールアドレス'), {hint: t('電話番号なら +81…'), placeholder: 'you@example.com'});
    s = await ui.busy(t('認証コードを送っています'), () => auth.send(contact));
    ui.info(t('{contact} にコードを送りました。', {contact}));
    for (let tries = 1; ; tries++) {
      const code = await ui.ask(t('届いた認証コード'), {placeholder: '123456'});
      try { s = await ui.busy(t('確認しています'), () => auth.confirm(code)); break; }
      catch (e) { if (tries >= 3) throw e; ui.info(t('{message} もう一度入力してください。', {message: e.message})); }
    }
    for (let guard = 0; s.phase !== 'authenticated' && guard < 6; guard++) {
      if (s.phase === 'account') { const i = await ui.pick(t('どのアカウントで Muse を使っていますか？'), s.accounts); s = await ui.busy(t('確認しています'), () => auth.select(i)); }
      else if (s.phase === 'two_factor') {
        const i = await ui.pick(t('追加認証の方法'), s.methods);
        s = await ui.busy(t('追加認証を準備しています'), () => auth.twoFactor(i));
        if (s.message) ui.info(s.message);
        const code = await ui.ask(t('追加認証コード'));
        s = await ui.busy(t('確認しています'), () => auth.twoFactor(i, code));
      } else if (s.phase === 'checkpoint') throw new Error(s.checkpointUrl ? t('Muse 側で追加の確認が必要です: {url}', {url: s.checkpointUrl}) : t('Muse 側で追加の確認が必要です。muse.ai で確認してください。'));
      else throw new Error(t('想定外の認証状態です: {phase}', {phase: s.phase}));
    }
    return auth;
  } finally { ui.close?.(); }
}

module.exports = {createAuth, pcLogin};
