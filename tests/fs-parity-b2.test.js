'use strict';
// Parity tests for the fullscreen redraw (stage 2, worker B2):
// progress / sources / muse / help entries.
// Env comes FIRST (copied from tests/fs-parity.test.js): both sides must
// colourise the same way, before any import of ink / view.mjs / term.js.
process.env.MUSER_LANG = 'ja';
process.env.MUSER_SGR = '1';
process.env.COLORTERM = 'truecolor';
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;

const {test, before} = require('node:test');
const assert = require('node:assert');
const React = require('react');
const h = React.createElement;

let parity, Entry, drawEntry, drawProgress, drawSources, drawMuse, drawHelp;
before(async () => {
  parity = await import('./helpers/parity.mjs');
  ({Entry} = await import('../src/ui/view.mjs'));
  ({drawEntry} = await import('../src/ui/fs/draw/index.mjs'));
  ({drawProgress} = await import('../src/ui/fs/draw/entries/progress.mjs'));
  ({drawSources} = await import('../src/ui/fs/draw/entries/sources.mjs'));
  ({drawMuse} = await import('../src/ui/fs/draw/entries/muse.mjs'));
  ({drawHelp} = await import('../src/ui/fs/draw/entries/help.mjs'));
});

function cases(suite, list, drawFn) {
  for (const c of list) {
    test(c.name, () => {
      const used = parity.checkParity({
        name: c.name,
        react: W => parity.reactLines(h(Entry, {e: c.e, ctrl: {}, W}), W),
        draw: W => drawEntry(c.e, parity.baseCtx(W)),
        ...(c.widths ? {widths: c.widths} : {}),
        ...(c.exceptions ? {exceptions: c.exceptions} : {}),
      });
      assert.equal(used.length, (c.exceptions || []).length);
    });
  }
  test(suite + ': drawEntry dispatches', () => {
    const c = list[0];
    assert.deepEqual(drawEntry(c.e, parity.baseCtx(80)), drawFn(c.e, parity.baseCtx(80)));
  });
}

// --- progress ---------------------------------------------------------------
cases('progress', [
  {name: 'progress: short message', e: {type: 'progress', message: 'ファイルを読みました'}},
  {name: 'progress: long wrapping message', e: {type: 'progress', message: 'これは途中経過の長い報告です。幅が狭いと次の行へ折り返されます。English words wrap too when the line is long enough to exceed the width.'}},
  {name: 'progress: main agent shows no tag', e: {type: 'progress', message: '作業中です', agent: 'main'}},
  {name: 'progress: sub agent tag', e: {type: 'progress', message: '調べています', agent: 'a1'}},
  {name: 'progress: sub agent long wrapping', e: {type: 'progress', message: '並行して調べている途中の経過です。かなり長い文章なので狭い幅では何行にも分かれるはずです。追加の説明も続きます。', agent: 'explore-2'}},
  {name: 'progress: empty message', e: {type: 'progress', message: ''}},
  {name: 'progress: embed token is sanitised', e: {type: 'progress', message: '結果 [[hatch_widget:widget-12345678]] を受け取りました'}},
  {name: 'progress: multiline message', e: {type: 'progress', message: '1 行目の経過\n2 行目の経過は少し長くて、幅 40 では折り返される長さにしておきます'}},
], (e, ctx) => drawProgress(e, ctx));

// --- sources ----------------------------------------------------------------
cases('sources', [
  {name: 'sources: one item', e: {type: 'sources', items: [{label: 'Example', uri: 'https://example.com/page'}]}},
  {name: 'sources: domain fallback', e: {type: 'sources', items: [{domain: 'example.org', uri: 'https://example.org/a'}]}},
  {name: 'sources: several items', e: {type: 'sources', items: [{label: 'One', uri: 'https://one.example/'}, {label: 'Two', uri: 'https://two.example/'}, {label: 'Three', uri: 'https://three.example/'}]}},
  {name: 'sources: exactly six', e: {type: 'sources', items: [1, 2, 3, 4, 5, 6].map(n => ({label: 'Src' + n, uri: 'https://s' + n + '.example/'}))}},
  {name: 'sources: more than six collapses', e: {type: 'sources', items: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({label: 'Src' + n, uri: 'https://s' + n + '.example/'}))}},
  {name: 'sources: long label and uri', e: {type: 'sources', items: [{label: 'とても長いラベルの出典ドキュメントタイトルです', uri: 'https://example.com/very/long/path/to/the/document/page.html?query=abcdef'}]}},
  {name: 'sources: long ascii label', e: {type: 'sources', items: [{label: 'A very long source label that will not fit', uri: 'https://example.com/x'}]}},
  {name: 'sources: no items', e: {type: 'sources', items: []}},
  {name: 'sources: missing uri and label', e: {type: 'sources', items: [{}]}},
], (e, ctx) => drawSources(e, ctx));

// --- muse -------------------------------------------------------------------
cases('muse', [
  {name: 'muse: step without detail', e: {type: 'muse', step: {title: 'ファイルを検索'}}},
  {name: 'muse: step with detail', e: {type: 'muse', step: {title: 'Read', detail: 'src/ui/view.mjs を読みました'}}},
  {name: 'muse: failed step', e: {type: 'muse', step: {title: 'テスト実行', failed: true, detail: '2 件失敗しました'}}},
  {name: 'muse: unfinished step', e: {type: 'muse', step: {title: 'ビルド', unfinished: true}}},
  {name: 'muse: long title truncates', e: {type: 'muse', step: {title: 'とても長いタイトルのステップです。これは幅に収まらないので末尾が切り詰められます。追加の文字も続きます。'}}},
  {name: 'muse: long detail wraps', e: {type: 'muse', step: {title: 'Search', detail: '詳細は長く続きます。幅が狭いと折り返されます。English words wrap too when the line is long enough to exceed the width.'}}},
  {name: 'muse: failed long detail wraps in red', e: {type: 'muse', step: {title: '実行', failed: true, detail: 'エラーが発生しました。原因は長いので説明が何行にもわたって続きます。もう少し詳しく書いておきます。'}}},
  {name: 'muse: multiline detail', e: {type: 'muse', step: {title: 'Output', detail: '1 行目\n2 行目は少し長くて幅 40 では折り返される長さにしておきます'}}},
], (e, ctx) => drawMuse(e, ctx));

// --- help -------------------------------------------------------------------
// The help entry ignores its entry object: the content is COMMANDS and the
// fixed key phrases. The default widths cover both layouts (stacked below
// 56, grid at and above); extra widths pin the boundary itself.
// Wave 6 intentional difference: the fullscreen help alone lists the
// scroll keys (pgup / pgdn, ctrl+home / ctrl+end, wheel — the fs screen owns
// the scrollback; the classic help has no such keys to list). Registered
// with the harness's exception mechanism: at stacked widths the extra key
// phrases are the trailing lines; at width 120 they also widen the key
// grid's first column, reflowing the key lines above them. Every line not
// listed here must still match exactly.
const SCROLL_KEYS = 'fullscreen-only scroll-key lines in the help (wave 6): the fs help lists pgup/pgdn, ctrl+home/ctrl+end and wheel scrolling, which the classic help does not have';
const scrollEx = (width, textLines, lengthLines) => [
  ...textLines.map(line => ({width, line, kind: 'text', reason: SCROLL_KEYS})),
  ...lengthLines.map(line => ({width, line, kind: 'length', reason: SCROLL_KEYS})),
];
cases('help', [
  {name: 'help: full listing', e: {type: 'help'}, exceptions: [
    ...scrollEx(40, [126], [127, 128, 129, 130, 131]),
    ...scrollEx(80, [70], [71, 72, 73]),
    ...scrollEx(120, [41, 42, 43, 44, 45, 46, 47, 48, 49, 50], [51, 52]),
  ]},
  {name: 'help: grid boundary widths', e: {type: 'help'}, widths: [55, 56, 57], exceptions: [
    ...scrollEx(55, [90], [91, 92, 93]),
    ...scrollEx(56, [89], [90, 91, 92]),
    ...scrollEx(57, [88], [89, 90, 91]),
  ]},
  {name: 'help: narrow stacked widths', e: {type: 'help'}, widths: [24, 39], exceptions: [
    ...scrollEx(24, [289], [290, 291, 292, 293, 294, 295, 296]),
    ...scrollEx(39, [129], [130, 131, 132, 133, 134, 135]),
  ]},
], (e, ctx) => drawHelp(e, ctx));
