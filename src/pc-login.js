'use strict';
// Terminal version of the desktop app's "PC 接続の設定": get an SDK token, verify the account
// with an email / SMS code (account choice, 2FA as needed), mint this PC's device pair.
// The prompts come from `ui` (the onboarding screen); plain readline is the fallback.
const readline = require('node:readline/promises');
const store = require('./secure-store');
const {PcAuth} = require('./core/pc-auth');

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
    pick: async (q, items) => { items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}`)); return Number(await rl.question(q + ' 番号: ')) - 1; },
    busy: async (_label, fn) => fn(),
    close: () => rl.close(),
  };
}

async function pcLogin(web, ui = plainUi()) {
  const auth = createAuth(web);
  try {
    let s = auth.snapshot();
    if (s.phase === 'authenticated') { await ui.busy('確認しています', () => auth.vm()); ui.info('この PC は登録済みです。'); return auth; }
    if (!s.hasSdkToken) {
      const list = await ui.busy('SDK トークンを確認しています', () => web.sdkRequest('GET'));
      if (Array.isArray(list.tokens) && list.tokens.length >= list.maxActiveTokens) {
        // One SDK token per account, already held by Muse Desktop Community: share it and
        // register this CLI as a second device with its own node id.
        // Without that app (anyone but its users) the account's tokens are simply used up: say so.
        let shared;
        try { shared = require('./desktop-import').desktopSdkToken(); }
        catch { throw new Error('この muse.ai アカウントの SDK トークンが上限（' + list.maxActiveTokens + ' 個）に達しています。使っていないトークンを muse.ai 側で削除してから、もう一度 `muser pc-login` を実行してください。'); }
        ui.info('SDK トークンは Muse Desktop Community のものを共有します（この CLI は別の端末として登録）。');
        auth.persist(shared);
      } else if (!(await ui.confirm('SDK トークン「muser CLI」を発行します。利用規約に同意しますか？'))) throw new Error('中止しました。');
    }
    s = await ui.busy('準備しています', () => auth.start(true));
    const contact = await ui.ask('Muse にログインしているメールアドレス', {hint: '電話番号なら +81…', placeholder: 'you@example.com'});
    s = await ui.busy('認証コードを送っています', () => auth.send(contact));
    ui.info(contact + ' にコードを送りました。');
    for (let tries = 1; ; tries++) {
      const code = await ui.ask('届いた認証コード', {placeholder: '123456'});
      try { s = await ui.busy('確認しています', () => auth.confirm(code)); break; }
      catch (e) { if (tries >= 3) throw e; ui.info(e.message + ' もう一度入力してください。'); }
    }
    for (let guard = 0; s.phase !== 'authenticated' && guard < 6; guard++) {
      if (s.phase === 'account') { const i = await ui.pick('どのアカウントで Muse を使っていますか？', s.accounts); s = await ui.busy('確認しています', () => auth.select(i)); }
      else if (s.phase === 'two_factor') {
        const i = await ui.pick('追加認証の方法', s.methods);
        s = await ui.busy('追加認証を準備しています', () => auth.twoFactor(i));
        if (s.message) ui.info(s.message);
        const code = await ui.ask('追加認証コード');
        s = await ui.busy('確認しています', () => auth.twoFactor(i, code));
      } else if (s.phase === 'checkpoint') throw new Error('Muse 側で追加の確認が必要です' + (s.checkpointUrl ? ': ' + s.checkpointUrl : '。muse.ai で確認してください。'));
      else throw new Error('想定外の認証状態です: ' + s.phase);
    }
    return auth;
  } finally { ui.close?.(); }
}

module.exports = {createAuth, pcLogin};
