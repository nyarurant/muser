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

test('t() picks English or Japanese and fills placeholders', () => {
  const i18n = require('../src/i18n');
  assert.equal(i18n.t('再開: {title}', {title: 'x'}), '再開: x');
  i18n.setLang('en', {save: false});
  assert.equal(i18n.t('まだ訳のない文 {n}', {n: 1}), 'まだ訳のない文 1', 'missing entries fall back to the Japanese');
  i18n.setLang('ja', {save: false});
});
