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
// The language the user picked (config.json), or null before the first run asked.
function chosen() { const l = readConfig().lang; return LANGS.includes(l) ? l : null; }
function lang() {
  if (current) return current;
  const env = String(process.env.MUSER_LANG || '').toLowerCase();
  return (current = LANGS.includes(env) ? env : chosen() || osLang());
}
function setLang(l, {save = true} = {}) {
  if (!LANGS.includes(l)) return;
  current = l;
  if (!save) return;
  try { require('./config').update(cfg => { cfg.lang = l; }); } catch {}
}
// {name} placeholders (e.g. {title}) are filled after the lookup.
function t(text, vars) {
  let s = String(text);
  if (lang() === 'en') { EN ??= require('./i18n/en'); if (Object.prototype.hasOwnProperty.call(EN, s)) s = EN[s]; }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  return s;
}

module.exports = {t, lang, setLang, chosen, osLang, LANGS};
