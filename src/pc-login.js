'use strict';
// Terminal version of the desktop app's "PC 接続の設定": get an SDK token, verify the account
// with an email / SMS code (account choice, 2FA as needed), mint this PC's device pair.
// The prompts come from `ui` (the onboarding screen); plain readline is the fallback.
const readline = require('node:readline/promises');
const store = require('./secure-store');
const {PcAuth} = require('./core/pc-auth');
const {t} = require('./i18n');

// file: the store name of this account's device registration (src/accounts.js) — every
// account registers this PC separately, with its own SDK token and node id.
function createAuth(web, {file = 'device.enc'} = {}) {
  return new PcAuth({
    load: () => store.load(file),
    save: value => store.save(file, value),
    request: web.nativeRequest, listSdk: signal => web.sdkRequest('GET', signal), issueSdk: signal => web.sdkRequest('POST', signal),
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

async function pcLogin(web, ui = plainUi(), opts = {}) {
  const auth = createAuth(web, opts);
  try {
    let s = auth.snapshot();
    if (s.phase === 'authenticated') {
      try { await ui.busy(t('確認しています'), () => auth.vm()); ui.info(t('この PC は登録済みです。')); return auth; }
      // A pair for another account / a dead pair is not "registered" (audit #193):
      // fall through and let auth.start() drop it and run a fresh login, instead
      // of failing every run until the user deletes the file by hand.
      catch (e) { if (!(e.deviceMismatch || e.deadDevice || e.status === 401)) throw e; }
    }
    if (!s.hasSdkToken) {
      const list = await ui.busy(t('SDK トークンを確認しています'), () => web.sdkRequest('GET'));
      if (list && Array.isArray(list.tokens) && list.tokens.length >= list.maxActiveTokens) {
        // One SDK token per account, already held by Muse Desktop Community: share it and
        // register this CLI as a second device with its own node id.
        // Without that app (anyone but its users) the account's tokens are simply used up: say so.
        // The app's token is shared only when it is one of THIS account's tokens: the app is
        // signed in to one Muse account, and a second muser account used to take its token too.
        let shared;
        try { shared = require('./desktop-import').desktopSdkToken(); } catch {}
        if (!shared) throw new Error(t('この muse.ai アカウントの SDK トークンが上限（{max} 個）に達しています。使っていないトークンを muse.ai 側で削除してから、もう一度 `muser pc-login` を実行してください。', {max: list.maxActiveTokens}));
        // Ownership is proven by the token id alone. An older desktop save has none,
        // and adopting its token unverified saved the DESKTOP app's Muse account
        // token into a different muser account (audit #189): unverifiable is refused.
        if (!shared.sdkTokenId) throw new Error(t('デスクトップ版に保存された SDK トークンに ID がなく、このアカウントのものか確認できません。Muse Desktop Community でサインインし直してから、もう一度 `muser pc-login` を実行してください。'));
        if (!list.tokens.some(x => x?.id === shared.sdkTokenId)) throw new Error(t('この muse.ai アカウントの SDK トークンが上限（{max} 個）に達しています。使っていないトークンを muse.ai 側で削除してから、もう一度 `muser pc-login` を実行してください。', {max: list.maxActiveTokens}));
        ui.info(t('SDK トークンは Muse Desktop Community のものを共有します（この CLI は別の端末として登録）。'));
        auth.persist(shared);
      } else if (!(await ui.confirm(t('SDK トークン「muser CLI」を発行します。利用規約に同意しますか？')))) throw new Error(t('中止しました。'));
    }
    s = await ui.busy(t('準備しています'), () => auth.start(true));
    // Only a failure that a fresh code could fix is retried (audit #190): a fatal
    // or network error, or a failure after the phase already advanced (the device
    // pair was saved and only vm() failed), must surface as-is, not as a code
    // re-entry prompt. A wrong code is a 4xx answer while the phase is unchanged.
    const codeRetryable = (e, phase) => !e.network && !e.timeout && !e.parse && !(e.status >= 500) && auth.snapshot().phase === phase;
    // A pick that is not a number (plain UI: Number('')/NaN) used to kill the whole
    // login, completed OTP stage included (audit #192): re-ask for the choice.
    const pickIndex = async (q, items) => {
      for (let a = 1; ; a++) {
        const i = await ui.pick(q, items);
        if (Number.isSafeInteger(i) && i >= 0 && i < items.length) return i;
        if (a >= 3) throw new Error(t('表示された認証項目を選択してください。'));
        ui.info(t('表示された認証項目を選択してください。'));
      }
    };
    // The contact/send stage gets the same second chance the code stage had
    // (audit #192): re-ask the contact instead of ending the login on one slip.
    let contact;
    for (let attempt = 1; ; attempt++) {
      contact = await ui.ask(t('Muse にログインしているメールアドレス'), {hint: t('電話番号なら +81…'), placeholder: 'you@example.com'});
      try { s = await ui.busy(t('認証コードを送っています'), () => auth.send(contact)); break; }
      catch (e) { if (attempt >= 3 || e.status === 401 || e.status === 403) throw e; ui.info(t('{message} もう一度入力してください。', {message: e.message})); }
    }
    ui.info(t('{contact} にコードを送りました。', {contact}));
    for (let tries = 0; ;) {
      const code = await ui.ask(t('届いた認証コード'), {placeholder: '123456'});
      // Resend path (audit #191): typing resend asks for a fresh code instead of
      // burning the remaining tries on a code that never arrived.
      if (code === 'resend' || code === '再送') { s = await ui.busy(t('認証コードを送っています'), () => auth.send(contact)); ui.info(t('{contact} にコードを送りました。', {contact})); continue; }
      tries++;
      try { s = await ui.busy(t('確認しています'), () => auth.confirm(code)); break; }
      catch (e) { if (tries >= 3 || !codeRetryable(e, 'code')) throw e; ui.info(t('{message} もう一度入力してください。', {message: e.message})); }
    }
    for (let guard = 0; s.phase !== 'authenticated' && guard < 6; guard++) {
      if (s.phase === 'account') { const i = await pickIndex(t('どのアカウントで Muse を使っていますか？'), s.accounts); s = await ui.busy(t('確認しています'), () => auth.select(i)); }
      else if (s.phase === 'two_factor') {
        const i = await pickIndex(t('追加認証の方法'), s.methods);
        s = await ui.busy(t('追加認証を準備しています'), () => auth.twoFactor(i));
        if (s.message) ui.info(s.message);
        for (let tries = 1; ; tries++) {
          const code = await ui.ask(t('追加認証コード'));
          try { s = await ui.busy(t('確認しています'), () => auth.twoFactor(i, code)); break; }
          catch (e) { if (tries >= 3 || !codeRetryable(e, 'two_factor')) throw e; ui.info(t('{message} もう一度入力してください。', {message: e.message})); }
        }
      } else if (s.phase === 'checkpoint') throw new Error(s.checkpointUrl ? t('Muse 側で追加の確認が必要です: {url}', {url: s.checkpointUrl}) : t('Muse 側で追加の確認が必要です。muse.ai で確認してください。'));
      else throw new Error(t('想定外の認証状態です: {phase}', {phase: s.phase}));
    }
    // The guard can run out with the flow still mid-way (e.g. account choice keeps coming
    // back): that is not a completed login, so say so instead of returning as if it were.
    if (s.phase !== 'authenticated') throw new Error(t('想定外の認証状態です: {phase}', {phase: s.phase}));
    return auth;
  } finally { ui.close?.(); }
}

module.exports = {createAuth, pcLogin};
