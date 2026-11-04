'use strict';
// Adding one account, headless: register the name, then walk the NEW account through the
// Edge login and this PC's device registration with its own files (src/accounts.js filesFor).
// The caller's ui drives pc-login.js (busy / info / ask / confirm / pick); the CLI's
// `muser account add` keeps its first-run-style onboard screens in bin, the TUI's
// /account add uses this with its own prompts, because Ink owns that screen.
// A failed add whose login never landed removes the registration again — a name left
// behind with nothing behind it blocked adding the same name later. A login that DID
// land keeps the account (its device registration can be finished later), exactly as
// the CLI's add behaved. Neither the window's account nor the default changes here.
const {t} = require('./i18n');

// Note something on a thrown value without ever replacing it: assigning to a
// string or a frozen object throws in strict mode, and the caller must see
// the original failure, not that TypeError (c13 #15).
const attach = (e, key, value) => { try { e[key] = value; } catch {} };

async function addAccount(label, {ui, log = () => {}, deps = {}} = {}) {
  const accounts = deps.accounts || require('./accounts');
  const a = accounts.add(label); // throws on a blank or duplicate name
  const files = accounts.filesFor(a.id);
  // Rollback is decided by whether login() itself completed, not by web.enc existing
  // (audit #48): the login poll absorbs Set-Cookies and saves a PARTIAL jar long before
  // the login is ready, so "a jar file exists" kept accounts whose login never landed —
  // and blocked re-adding the name. A login() that resolved is the landed login; only a
  // later device-registration failure keeps the account, as before.
  let loginLanded = false;
  try {
    const store = deps.store || require('./secure-store');
    try { store.preload([files.web, files.device, files.session]); } catch {}
    const web = deps.web || require('./web');
    const login = deps.login || (opts => require('./login').login(opts));
    await login({log, profile: files.browser, jarFile: files.web});
    loginLanded = true;
    const {pcLogin} = deps.pcLogin ? {pcLogin: deps.pcLogin} : require('./pc-login');
    await pcLogin(web.createWeb(web.loadJar(files.web), {file: files.web}), ui, {file: files.device});
  } catch (e) {
    if (!loginLanded) {
      // The rollback outcome travels with the error instead of being swallowed: a remove
      // that could not delete the Edge profile (still open) leaves a logged-in leftover
      // the caller needs to be able to name.
      let leftover, rollbackError;
      try { const r = accounts.remove(a.id); leftover = r?.leftover; }
      catch (re) { rollbackError = re?.message || String(re); }
      if (leftover) attach(e, 'rollbackLeftover', leftover);
      if (rollbackError) attach(e, 'rollbackError', rollbackError);
    } else {
      // The account stays (its login landed; only the device registration
      // failed). Say so on the error itself: the caller can tell the user the
      // name is now taken by this half-finished account and how to finish it,
      // instead of leaving a bare failure whose retry only reports that the
      // name 'already exists' (first audit #33).
      attach(e, 'accountKept', {id: a.id, label: a.label});
    }
    throw e;
  }
  // The same muse.ai user under a second name is not a second allowance: the pool would
  // count one Muse twice. Reported, not refused — the caller says it while the user can
  // still remove the account.
  // A failed duplicate check is reported as one (audit #47): it used to be swallowed into
  // the same `same: null` as a verified-distinct Muse, so a duplicate allowance could be
  // counted twice with nobody told the check never ran.
  let same = null, sameCheckFailed = false;
  try { same = await (deps.sameMuse || (id => require('./account-pool').sameMuse(id)))(a.id); } catch { sameCheckFailed = true; }
  return {account: a, same, ...(sameCheckFailed ? {sameCheckFailed: true} : {})};
}

module.exports = {addAccount};
