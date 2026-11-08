'use strict';
// lore's why / scar reason: a plain sentence from the reply, not its Markdown heading.
// Found on a real run: the reason for calc.js was "**バグと修正（`calc.js`）**" (the
// reply's heading, which names the file and says nothing).
const test = require('node:test');
const assert = require('node:assert');
const {pickReason} = require('../src/lore.js');

const REPLY = [
  'できました。',
  '',
  '**バグと修正（`calc.js`）**',
  '- `avg` が `sum / (list.length - 1)` で割っていました。',
  '- `sum / list.length` に直しました。',
  '',
  '## 回帰テスト',
  '- `avg([1,2,3])=2` を確かめるテストを追加。',
].join('\n');

test('a bold heading that names the file is not the reason', () => {
  const r = pickReason(REPLY, 'calc.js');
  assert.doesNotMatch(r, /バグと修正/);
  assert.match(r, /sum \/ list\.length に直しました/);
});

test('markdown marks are removed from the chosen sentence', () => {
  const r = pickReason(REPLY, 'calc.js');
  assert.doesNotMatch(r, /[`*]/);
});

test('a sentence naming the file and a change wins over a change sentence elsewhere', () => {
  const reply = 'README を直しました。\nparse.js の区切りの扱いを修正しました。';
  assert.match(pickReason(reply, 'parse.js'), /parse\.js の区切りの扱いを修正しました/);
});

test('falls back to a sentence naming the file, then to nothing', () => {
  assert.match(pickReason('util.js は前から遅かったです。', 'util.js'), /util\.js は前から遅かった/);
  assert.equal(pickReason('はい。', 'x.js'), '');
});
