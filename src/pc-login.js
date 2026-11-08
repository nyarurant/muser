'use strict';
// Terminal version of the desktop app's "PC 接続の設定": get an SDK token, verify the account
// with an email / SMS code (account choice, 2FA as needed), mint this PC's device pair.
// The prompts come from `ui` (the onboarding screen); plain readline is the fallback.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const store = require('./secure-store');
const {PcAuth, normalizeOtpCode, isOtpExpiredError} = require('./core/pc-auth');
const {t} = require('./i18n');

// file: the store name of this account's device registration (src/accounts.js) — every
// account registers this PC separately, with its own SDK token and node id.
// `store` is injectable for tests (opts.store in pcLogin); the default is the real
// DPAPI store, exactly as before.
function createAuth(web, {file = 'device.enc', store: storeImpl} = {}) {
  const s = storeImpl || store;
  // The on-disk location of this registration, so PcAuth's blocked-pending
  // error can name the exact file the manual recovery deletes (wave 9).
  let deviceFile = file;
  try { if (typeof s.file === 'function') deviceFile = s.file(file) || file; } catch {}
  return new PcAuth({
    load: () => s.load(file),
    save: value => s.save(file, value),
    deviceFile,
    request: web.nativeRequest, listSdk: signal => web.sdkRequest('GET', signal), issueSdk: signal => web.sdkRequest('POST', signal),
    expectedVm: async () => (await web.fetchJson('/api/session'))?.vm_id,
  });
}

// The remembered contact lives next to the device registration, in the same
// per-account layout as src/accounts.js filesFor: device.enc -> contact.enc,
// accounts/<id>/device.enc -> accounts/<id>/contact.enc. Callers pass only
// {file: files.device}, so the contact name is derived from it (an explicit
// opts.contactFile wins, for tests and any future caller that knows it).
function contactFileFor(deviceFile, explicit) {
  if (typeof explicit === 'string' && explicit) return explicit;
  const f = typeof deviceFile === 'string' && deviceFile ? deviceFile : 'device.enc';
  if (f.endsWith('device.enc')) return f.slice(0, -'device.enc'.length) + 'contact.enc';
  return f.replace(/\.enc$/, '') + '-contact.enc';
}
// A saved contact is {contact: string, savedAt: ISO string}; a plain string
// and a {contact} without savedAt (written before the stamp existed) are
// tolerated so a value written either way still reads back, with savedAt null
// when the age is unknown. The stamp lives only in the stored value: the
// next-login hint keeps showing just the masked contact, as before.
function savedAtOf(v) {
  if (!v || typeof v !== 'object') return null;
  const at = v.savedAt;
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) return at;
  if (typeof at === 'string' && at && !Number.isNaN(Date.parse(at))) return at;
  return null;
}
// Move a corrupt contact entry aside (the .corrupt-<time> convention of
// accounts.js / config.js), best-effort, so it is not re-read — and silently
// swallowed — on every later login. The real store's encrypted file is
// renamed with its bytes intact; an injected store without a real file gets
// the bad value copied under a .corrupt- name before the original is removed.
// A removal is the last resort: even an unrecoverable entry must stop
// shadowing the next registration.
function quarantineContact(storeImpl, contactFile, value, hasValue) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let renamed = false;
  try {
    const p = typeof storeImpl.file === 'function' ? storeImpl.file(contactFile) : null;
    if (p && path.isAbsolute(p) && fs.existsSync(p)) { fs.renameSync(p, p + '.corrupt-' + stamp); renamed = true; }
  } catch {}
  if (!renamed && hasValue) { try { storeImpl.save(contactFile + '.corrupt-' + stamp, value); } catch {} }
  if (!renamed) { try { storeImpl.remove(contactFile); } catch {} }
}
// Corruption is reported once per file per process: after a successful
// quarantine the entry is gone and later reads stay quiet anyway, and when
// the quarantine itself failed the user is not told again on every login.
const contactCorruptNotified = new Set();
// Reads the saved contact as {contact, savedAt, corrupt}. A missing entry is
// {contact: null, corrupt: false}. An entry that exists but cannot be used —
// the store throws (decrypt / parse failure), or the value is present but
// malformed (not a string contact) — is corrupt: it is quarantined and
// flagged so pcLogin can say so once, instead of savedContact returning a
// silent null forever while the broken file stayed in place (audit wave 8 B).
// A SLOW store failure (DPAPI timeout, secure-store's `slow`) is transient,
// not corruption: nothing is quarantined and registration proceeds as before.
function savedContactInfo(storeImpl, contactFile) {
  let v;
  try { v = storeImpl.load(contactFile); }
  catch (e) {
    if (e && e.slow) return {contact: null, savedAt: null, corrupt: false};
    quarantineContact(storeImpl, contactFile, undefined, false);
    return {contact: null, savedAt: null, corrupt: true};
  }
  if (v === null || v === undefined) return {contact: null, savedAt: null, corrupt: false};
  const c = typeof v === 'string' ? v : (v && typeof v.contact === 'string' ? v.contact : null);
  if (c && c.trim()) return {contact: c.trim(), savedAt: savedAtOf(v), corrupt: false};
  quarantineContact(storeImpl, contactFile, v, true);
  return {contact: null, savedAt: null, corrupt: true};
}
function savedContact(storeImpl, contactFile) {
  return savedContactInfo(storeImpl, contactFile).contact;
}
// Best-effort: remembering must never fail a registration that succeeded.
// The value carries savedAt so the age of a remembered contact is knowable
// from the stored data, even though no screen displays it.
function rememberContact(storeImpl, contactFile, contact) {
  try {
    if (contact && String(contact).trim()) {
      storeImpl.save(contactFile, {contact: String(contact).trim(), savedAt: new Date().toISOString()});
      contactCorruptNotified.delete(contactFile);
    }
  } catch {}
}
// Masked form for hints (same masking as src/server/setup.js maskContact):
// the full contact never goes into a hint, a log line or an error.
function maskContact(contact) {
  const str = String(contact ?? '');
  if (!str) return str;
  const at = str.indexOf('@');
  if (at > 0) return str.slice(0, at).slice(0, 2) + '***@' + str.slice(at + 1);
  const digits = str.replace(/\D/g, '');
  if (/^\+?[\d\s-]+$/.test(str) && digits.length >= 7) {
    let seen = 0, out = '';
    for (let i = str.length - 1; i >= 0; i--) { const ch = str[i]; if (/\d/.test(ch)) { seen++; out = (seen <= 2 ? ch : '*') + out; } else out = '*' + out; }
    return out;
  }
  return str.slice(0, 2) + '***';
}

function plainUi() {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  // Input that ends (EOF: a pipe that ran out, Ctrl+D) used to wedge every
  // later question forever — rl.question never settles once the interface
  // has closed — or, on the first question, came back as an empty answer
  // that silently fell back to the remembered initial value (audit-cli
  // wave 9). Race every question against the close and fail in words.
  const eofError = () => new Error(t('入力が閉じられました。対話入力が必要です。端末から実行してください。'));
  let closed = false;
  let rejectClose = () => {};
  const closePromise = new Promise((_, reject) => { rejectClose = reject; });
  closePromise.catch(() => {}); // a close with no question pending is not an error
  rl.on('close', () => { if (!closed) { closed = true; rejectClose(eofError()); } });
  const question = q => {
    if (closed) return Promise.reject(eofError());
    return Promise.race([rl.question(q), closePromise]);
  };
  return {
    note: s => console.log(s), info: s => console.log(s),
    ask: async (q, {hint, initial} = {}) => { const shown = [hint, initial ? t('前回: {masked}', {masked: maskContact(initial)}) : null].filter(Boolean).join(' / '); const v = (await question(q + (shown ? ' (' + shown + ')' : '') + ': ')).trim(); return v || (initial ? String(initial).trim() : v); },
    confirm: async q => /^y(es)?$/i.test((await question(q + ' [y/N] ')).trim()),
    pick: async (q, items) => { items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}`)); return Number(await question(q + t(' 番号: '))) - 1; },
    busy: async (_label, fn) => fn(),
    close: () => rl.close(),
  };
}

async function pcLogin(web, ui, opts = {}) {
  // plainUi() is created INSIDE the try: as a default argument it ran before the try, so
  // when createAuth() threw (a broken saved device file) the readline was never closed
  // and the process hung instead of exiting (audit c17 #12).
  if (!ui) ui = plainUi();
  const storeImpl = opts.store || store;
  const contactFile = contactFileFor(opts.file, opts.contactFile);
  let auth;
  try { auth = createAuth(web, opts); } catch (e) { ui.close?.(); throw e; }
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
      // The first SDK check is one bare request today, so a single network
      // blip ends the whole login before it starts (audit-cli wave 9): a
      // transient connection failure (network / timeout, plus the 429 / 5xx
      // the rest of this flow already treats as transient) is retried up to
      // twice at a short interval; a permanent error (a 4xx refusal, a parse
      // failure) is not retried and surfaces at once.
      const sdkCheckTransient = e => !!(e && (e.network || e.timeout || e.status === 429 || e.status >= 500));
      let list;
      for (let attempt = 1; ; attempt++) {
        try { list = await ui.busy(t('SDK トークンを確認しています'), () => web.sdkRequest('GET')); break; }
        catch (e) { if (attempt >= 3 || !sdkCheckTransient(e)) throw e; await new Promise(r => setTimeout(r, 200)); }
      }
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
      } else {
        // 'SDK token' was used with no definition anywhere (fourth audit M25): say what it
        // is before asking for consent to issue one.
        ui.info(t('SDK トークンは、この PC を Muse の端末として認めるための鍵です。発行すると、この PC から Muse に接続できるようになります。'));
        if (!(await ui.confirm(t('SDK トークン「muser CLI」を発行します。利用規約に同意しますか？')))) throw new Error(t('中止しました。'));
      }
    }
    s = await ui.busy(t('準備しています'), () => auth.start(true));
    // Only a failure that a fresh code could fix is retried (audit #190): a fatal
    // or network error, or a failure after the phase already advanced (the device
    // pair was saved and only vm() failed), must surface as-is, not as a code
    // re-entry prompt. A wrong code is a 4xx answer while the phase is unchanged
    // (a 429 is a rate limit, not a wrong code: it must not burn the re-entries —
    // master-debug #14; the contact loop below likewise rethrows transient errors
    // that retryBusy already retried, instead of blaming the contact).
    const codeRetryable = (e, phase) => !e.network && !e.timeout && !e.parse && e.status !== 429 && !(e.status >= 500) && auth.snapshot().phase === phase;
    // A failure a retry of the SAME request can fix (audit c17 #10/#11): network blips,
    // timeouts, 429 and 5xx are not the user's input being wrong.
    const transient = e => !!(e.network || e.timeout || e.status === 429 || e.status >= 500);
    // Retry one stage's request itself, instead of throwing away every stage before it:
    // select() and the twoFactor() preparation used to be one-shot, so one blip there
    // discarded the completed OTP stage (audit c17 #10).
    const retryBusy = async (label, fn) => {
      for (let a = 1; ; a++) {
        try { return await ui.busy(label, fn); }
        catch (e) { if (a >= 3 || !transient(e)) throw e; }
      }
    };
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
    const saved = savedContactInfo(storeImpl, contactFile);
    // A corrupt remembered contact was quarantined by the read above: say so
    // once, here where a user is looking, instead of silently dropping the
    // pre-fill (audit wave 8 B). The hint itself is unchanged.
    if (saved.corrupt && !contactCorruptNotified.has(contactFile)) {
      contactCorruptNotified.add(contactFile);
      ui.info(t('保存されていた連絡先が壊れていたため、退避しました。連絡先はあらためて入力してください。'));
    }
    const initialContact = saved.contact;
    for (let attempt = 1; ; attempt++) {
      contact = await ui.ask(t('Muse にログインしているメールアドレス'), {hint: t('電話番号なら +81…'), placeholder: 'you@example.com', initial: initialContact});
      try { s = await retryBusy(t('認証コードを送っています'), () => auth.send(contact)); break; }
      // Transient failures retry the SAME contact inside retryBusy and never reach here;
      // re-asking the contact is only for failures the input could actually fix. The old
      // loop spent its 3 attempts on network/429 errors and blamed the contact (c17 #11).
      catch (e) { if (attempt >= 3 || transient(e) || e.status === 401 || e.status === 403) throw e; ui.info(t('{message} もう一度入力してください。', {message: e.message})); }
    }
    ui.info(t('{contact} にコードを送りました。', {contact}));
    let resends = 0;
    for (let tries = 0; ;) {
      // The resend word was a hidden feature (fourth audit M23): name it in the hint.
      const raw = await ui.ask(t('届いた認証コード'), {placeholder: '123456', hint: t('届かないときは resend と入力すると送り直せます')});
      const word = typeof raw === 'string' ? raw.trim() : raw;
      // Resend path (audit #191): typing resend asks for a fresh code instead of
      // burning the remaining tries on a code that never arrived. It is capped and a
      // failed resend no longer kills the login (audit c17 #9): unlimited resends ran
      // into muse.ai rate limits and invalidated codes, making login LESS likely.
      // A successful resend restarts the try count (audit wave 8 B): the code the
      // earlier tries were spent on is dead, and the fresh code deserves its own
      // three tries — two wrong codes, a resend, then one more wrong code used to
      // end the whole login. A FAILED resend delivered no new code, so it resets
      // nothing.
      if (word === 'resend' || word === '再送') {
        if (resends >= 3) { ui.info(t('再送は3回までです。届いたコードを入力するか、しばらく待ってから最初からやり直してください。')); continue; }
        resends++;
        try { s = await retryBusy(t('認証コードを送っています'), () => auth.send(contact)); ui.info(t('{contact} にコードを送りました。', {contact})); tries = 0; }
        catch (e) { ui.info(t('{message} 再送できませんでした。届いているコードがあれば入力してください。', {message: e.message})); }
        continue;
      }
      // Format first (audit wave 8 B): a short / lettered / empty code used to be
      // sent to the server as-is and burn one of the three tries, even though only
      // the user can fix it and no server round-trip is needed to know. Normalize
      // (fullwidth digits become halfwidth) and validate locally; a format slip is
      // said in words and re-asked WITHOUT spending a try.
      const code = normalizeOtpCode(raw);
      if (code === null) { ui.info(t('認証コードは6桁の数字で入力してください。')); continue; }
      try { s = await ui.busy(t('確認しています'), () => auth.confirm(code)); break; }
      catch (e) {
        // PcAuth rejected the format locally after all: no server try was spent.
        if (e && e.codeFormat) { ui.info(t('認証コードは6桁の数字で入力してください。')); continue; }
        // An expired code cannot become right by re-entering it (audit wave 8 B):
        // point at resend instead of the generic re-entry line, and do not spend
        // a try on a code that is dead rather than wrong.
        if (isOtpExpiredError(e)) { ui.info(t('認証コードの有効期限が切れています。resend と入力すると、新しいコードを送り直せます。')); continue; }
        tries++;
        if (tries >= 3 || !codeRetryable(e, 'code')) throw e;
        ui.info(t('{message} もう一度入力してください。', {message: e.message}));
      }
    }
    // The code passed and the phase moved on from 'code': only now is the
    // contact proven, so only now is it remembered for the next registration.
    // A wrong code (the loop above throws), a wrong contact (send never
    // reached this loop) and a cancel (ask threw) never reach this line.
    if (s && s.phase !== 'code') rememberContact(storeImpl, contactFile, contact);
    for (let guard = 0; s.phase !== 'authenticated' && guard < 6; guard++) {
      if (s.phase === 'account') { const i = await pickIndex(t('どのアカウントで Muse を使っていますか？'), s.accounts); s = await retryBusy(t('確認しています'), () => auth.select(i)); }
      else if (s.phase === 'two_factor') {
        const i = await pickIndex(t('追加認証の方法'), s.methods);
        s = await retryBusy(t('追加認証を準備しています'), () => auth.twoFactor(i));
        if (s.message) ui.info(s.message);
        // Same format rule as the OTP loop (audit wave 8 B): a malformed 2FA
        // code is re-asked in words without spending one of the three tries.
        for (let tries = 0; ;) {
          const raw = await ui.ask(t('追加認証コード'));
          const code = normalizeOtpCode(raw);
          if (code === null) { ui.info(t('認証コードは6桁の数字で入力してください。')); continue; }
          try { s = await ui.busy(t('確認しています'), () => auth.twoFactor(i, code)); break; }
          catch (e) {
            if (e && e.codeFormat) { ui.info(t('認証コードは6桁の数字で入力してください。')); continue; }
            tries++;
            if (tries >= 3 || !codeRetryable(e, 'two_factor')) throw e;
            ui.info(t('{message} もう一度入力してください。', {message: e.message}));
          }
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

module.exports = {createAuth, pcLogin, plainUi, contactFileFor, savedContact, savedContactInfo, rememberContact, maskContact, normalizeOtpCode};
