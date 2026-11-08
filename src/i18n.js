'use strict';
// UI language: English or Japanese. The user picks one on the first run (bin/muser.js) and it is
// kept in ~/.muser/config.json ("lang"); MUSER_LANG overrides it; before any choice the OS locale
// decides. The code keeps its strings in Japanese: t(<Japanese text>) looks it up in the
// English table (src/i18n/en.js) when the language is English, and falls back to the Japanese
// text itself. tests/i18n.test.js checks that every such literal in the code has an entry.
// Translate at display time, never at module load: modules load before the language is picked.
const os = require('node:os');
const path = require('node:path');

const LANGS = ['en', 'ja'];
let EN = null, current = null;

function configFile() { return path.join(os.homedir(), '.muser', 'config.json'); }
function readConfig() { try { return require('./config').readJson(configFile()) || {}; } catch { return {}; } }
function osLang() { return /^ja\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale || '') ? 'ja' : 'en'; }
// A regional tag names its language: en-US / ja-JP / en_GB mean en / ja / en. Only the exact
// 'en' / 'ja' used to be accepted, so MUSER_LANG=en-US was silently ignored (audit #225).
function norm(l) { const p = String(l || '').trim().toLowerCase().split(/[-_]/)[0]; return LANGS.includes(p) ? p : null; }
// The language the user picked (config.json), or null before the first run asked.
function chosen() { return norm(readConfig().lang); }
function lang() {
  if (current) return current;
  return (current = norm(process.env.MUSER_LANG) || chosen() || osLang());
}
// Returns whether the choice is saved (or saving was not asked for). Wave 14: a failed
// save used to be swallowed whole — the window switched, nothing said so, and the next
// start quietly went back. Callers that tell the user (/lang) read the result and say
// the switch is for this window only when it is false.
function setLang(l, {save = true} = {}) {
  const n = norm(l);
  if (!n) return false;
  current = n; l = n;
  if (!save) return true;
  try { require('./config').update(cfg => { cfg.lang = l; }); return true; } catch { return false; }
}
// {name} placeholders (e.g. {title}) are filled after the lookup.
function t(text, vars) {
  let s = String(text);
  if (lang() === 'en') { EN ??= require('./i18n/en'); if (Object.prototype.hasOwnProperty.call(EN, s)) s = EN[s]; }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  return s;
}

module.exports = {t, lang, setLang, chosen, osLang, LANGS, norm};
