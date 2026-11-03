'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const EN = require('../src/i18n/en');

function sources(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(m?js)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

test('every t(\'…\') string in bin/ and src/ has an English entry with the same placeholders', () => {
  const root = path.join(__dirname, '..'), missing = [], badVars = [];
  const vars = s => [...s.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(',');
  for (const file of [...sources(path.join(root, 'bin')), ...sources(path.join(root, 'src'))]) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const ja = m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n');
      if (!Object.prototype.hasOwnProperty.call(EN, ja)) { missing.push(path.relative(root, file) + ': ' + ja); continue; }
      if (vars(ja) !== vars(EN[ja])) badVars.push(ja);
    }
  }
  assert.deepEqual(missing, [], 'add these to src/i18n/en.js');
  assert.deepEqual(badVars, [], 'placeholders differ between Japanese and English');
});

// Strings passed to t() through a variable (help lines, command tables, mode labels) escape the
// literal scan above: t(l) in bin/muser.js, t(d) / t(MODE_HELP[m]) / t(LABELS[m]) in the UI.
// They are checked here by reading the tables themselves.
test('variable-passed strings (HELP_LINES, COMMANDS, MODE_HELP, policy LABELS) have English entries', async () => {
  const root = path.join(__dirname, '..'), missing = [], badVars = [];
  const vars = s => [...s.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(',');
  const check = (where, ja) => {
    if (!ja) return;
    if (!Object.prototype.hasOwnProperty.call(EN, ja)) { missing.push(where + ': ' + ja); return; }
    if (vars(ja) !== vars(EN[ja])) badVars.push(ja);
  };
  const unquote = raw => raw.replace(/\\'/g, "'").replace(/\\n/g, '\n');
  // HELP_LINES in bin/muser.js: the array literal's quoted entries.
  const bin = fs.readFileSync(path.join(root, 'bin', 'muser.js'), 'utf8');
  const helpBlock = bin.slice(bin.indexOf('const HELP_LINES = ['), bin.indexOf('];', bin.indexOf('const HELP_LINES = [')));
  for (const m of helpBlock.matchAll(/'((?:[^'\\]|\\.)*)'/g)) check('HELP_LINES', unquote(m[1]));
  // COMMANDS descriptions and MODE_HELP values live in controller.mjs; COMMANDS is exported.
  const {COMMANDS} = await import('../src/ui/controller.mjs');
  for (const [, desc] of COMMANDS) check('COMMANDS ' + desc.slice(0, 12), desc);
  const ctrl = fs.readFileSync(path.join(root, 'src', 'ui', 'controller.mjs'), 'utf8');
  const modeBlock = ctrl.slice(ctrl.indexOf('const MODE_HELP = {'), ctrl.indexOf('};', ctrl.indexOf('const MODE_HELP = {')));
  for (const m of modeBlock.matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) check('MODE_HELP', unquote(m[1]));
  // policy LABELS are plain data: require them directly.
  for (const label of Object.values(require('../src/policy').LABELS)) check('LABELS', label);
  assert.deepEqual(missing, [], 'add these to src/i18n/en.js');
  assert.deepEqual(badVars, [], 'placeholders differ between Japanese and English');
});

// The reverse direction of the scans above: an entry whose Japanese string no longer exists
// anywhere (the string was renamed or its feature removed) is dead weight that misleads
// translators. 33 such keys had accumulated by 2026-11-01 (old policy labels, old help lines,
// the pre-/settings spawn-limit messages). A key counts as used when it appears in the sources
// raw, as a t('…') literal, or in its escaped form (the demo replies' \n sequences).
test('every English entry is still used: no dead keys', () => {
  const root = path.join(__dirname, '..');
  const files = [...sources(path.join(root, 'bin')), ...sources(path.join(root, 'src'))]
    .filter(f => !f.endsWith(path.join('i18n', 'en.js')));
  const raw = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const known = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g))
      known.add(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'));
  }
  const dead = Object.keys(EN).filter(k => {
    if (known.has(k) || raw.includes(k)) return false;
    const escaped = k.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'");
    return !raw.includes(escaped);
  });
  assert.deepEqual(dead, [], 'remove these from src/i18n/en.js (or restore the string they translated)');
});

// Audit #226: a duplicated key in en.js silently lets the later value win (the object
// literal keeps only one), and the scans above cannot see it — they read the parsed
// object. Scan the source text for repeated keys instead.
test('en.js has no duplicate keys', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.js'), 'utf8');
  const seen = new Map(), dups = [];
  for (const m of src.matchAll(/^  '((?:[^'\\]|\\.)*)':/gm)) {
    if (seen.has(m[1])) dups.push(m[1]); else seen.set(m[1], true);
  }
  assert.deepEqual(dups, [], 'duplicate keys in src/i18n/en.js (the later value silently wins)');
  assert.equal(EN['登録しました'], 'Registered', 'not the agent-skill install wording');
  assert.equal(EN['中断'], 'Interrupt', 'the esc keycap is a verb, not the stopped state');
});

// Audit #225: regional tags (en-US, ja-JP) name their language instead of being
// silently ignored for not being exactly 'en' / 'ja'.
test('MUSER_LANG accepts regional tags: en-US is English, ja-JP is Japanese', () => {
  const file = require.resolve('../src/i18n');
  const was = process.env.MUSER_LANG;
  const fresh = () => { delete require.cache[file]; return require('../src/i18n'); };
  try {
    process.env.MUSER_LANG = 'en-US';
    assert.equal(fresh().lang(), 'en');
    assert.equal(fresh().norm('ja-JP'), 'ja');
    assert.equal(fresh().norm('EN_gb'), 'en');
    assert.equal(fresh().norm('fr-FR'), null);
    process.env.MUSER_LANG = 'ja-JP';
    assert.equal(fresh().lang(), 'ja');
  } finally {
    if (was === undefined) delete process.env.MUSER_LANG; else process.env.MUSER_LANG = was;
    fresh(); // leave a pristine module in the cache for the other tests
  }
});

test('t() picks English or Japanese and fills placeholders', () => {
  const i18n = require('../src/i18n');
  assert.equal(i18n.t('再開: {title}', {title: 'x'}), '再開: x');
  i18n.setLang('en', {save: false});
  assert.equal(i18n.t('まだ訳のない文 {n}', {n: 1}), 'まだ訳のない文 1', 'missing entries fall back to the Japanese');
  i18n.setLang('ja', {save: false});
});
