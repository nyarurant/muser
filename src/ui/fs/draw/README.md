# TUI 全画面表示の自前描画（src/ui/fs/draw/）

段階 2: fullscreen の会話の行と操作欄を、Ink / React の描画を使わず muser 自身で描く。
段階 A（土台）はこのフォルダの共有部分と、部品ごとの空ファイルと、1 種類の置き換え例（note）まで。
部品の置き換えは段階 B（3 人並行）、入口の分離と Ink / React / yoga の除去は段階 C。

## 契約（共有ファイルは段階 B では触らない）

- `ctx = {ctrl, W, cols, rows, now, codeWrap}`。`W` は app.mjs の幅（端末の列数 - 1）、
  `cols = W + 1` は `renderToString` の columns。`now` はミリ秒（`Date.now()` は使わない）、
  `rows` は端末の行数（試験では 30）。`codeWrap` は設定 `codeWrap` の値。
- 会話の行の描画関数は `(e, ctx) => string[] | null`。`null` は「まだ置き換えていない:
  呼び出し側が React の `renderToString` の描画に任せる」。
- 操作欄の部品は `(s, ctx) => string[] | null`。ただし `drawPrompt` と `drawLimitInput` は
  `{lines, caret} | null` を返す（`caret` は `{row, col}`、その部品の先頭行からの相対位置。
  カーソルが要らないときは `caret: null`）。
- `drawLive(s, ctx)` は `{lines, caret} | null` を返す。`caret` は操作欄全体での位置
  （部品の `caret.row` に部品の先頭行を足したもの）。今の状態で要る部品が1つでも `null`
  なら、操作欄全体が `null`（全体が代わりの描画になる）。要らない部品は呼ばない。
- 幅の決まり: React の根に幅を明示していない行（note、todos、past、muse、sources、help、
  status、shellout、end、gap）は `cols` で組まれる。幅を `W` と明示している行（user、progress、
  focus、agent など）は `W` で組まれる。部品を書くときは、元の `Entry` / `Live` の根に
  `width: W` があるかどうかを確かめること。
- 行の末尾の空白は落とす（Ink の出力が各行の末尾を `trimEnd` するため）。ただし行が
  エスケープ符号で終わる場合（色の範囲内の空白）は残る。`wrapInk` がこの扱いをする。
- ESM（`.mjs`）、改行は LF、React / Ink の import はなし。classic はこのフォルダを使わない。

## 共通部品（primitives.mjs）

- `c, width, strip, pad` は `src/tui/term.js` からの再出し。`hex(h)` は `#rrggbb` を term.js の色関数にする。
- `SPIN` / `THINKING_WORDS` / `WRITING_WORDS` / `spinnerWord` / `spinTick(now)`、`elapsed`、
  `focusLabel`、`modeLabel`、`toolTitle` + `TITLES`、`glyphFor`、`tailText`、`relPath` は
  view.mjs と同じ中身の写し（段階 C で view.mjs 側を消して一本化するまでは、両方を残す）。
- `wrapInk(s, max)`: Ink の折り返しを写したもの。wrap-ansi を `{trim: false, hard: true}` で
  呼んだものと同じ（ink/build/wrap-text.js）。単語で区切り、単語の前の空白は新しい行の先頭に
  来ることもある。幅より長い単語は、今の行に置くと次の行が増える場合だけ新しい行に移る。
- `truncateEnd(s, max)`: Ink の `truncate-end`。開いている色の内側に `…` を置く（term.js の
  `truncate` は `…` の前にリセットを入れるので違う）。
- `hanging(prefix, text, {width, wrapMode})`: Row（見出し + 折り返す本文、続きの行は見出しの幅だけ
  空ける）。本文の列は `width - 見出しの幅` で折り返し、続きの行の先頭の空白は列の位置であって
  折り返しの幅には入らない。`wrapMode: 'truncate-end'` は1行に切り詰める。
- `roundBox(lines, {width, borderColor})` / `singleBox(...)`: 枠。空の行には何も返さない
  （空の Box は何も描かない）。
- `cellsOf(line)` / `plainOf(cells)` / `cellsEqual(a, b)`: 1行をマスごとの
  `{ch, fg, bg, bold, dim, italic, under, strike, inverse}` に分ける（見た目比べ用）。
- `layout(text, pos, max)`: 入力欄の折り返しとカーソル位置（view.mjs と同じ計算）。

## 見た目比べの仕組み（tests/helpers/parity.mjs、tests/fs-parity.test.js）

- `reactLines(el, W)`: `renderToString(el, {columns: W + 1})` を `\n` で分けたもの。
  空の Box や `null` は `[]` になる。
- `checkParity({name, react, draw, widths = [40, 80, 120], exceptions = []})`:
  幅ごとに、React の描画と自前描画を1行ずつ比べる。文字が違うか、色・装飾が違うか、
  行数が違うかを報告する。`exceptions` は `{width?, line?, kind?, reason}` で、
  揃えられない差を理由付きで登録するもの。登録した例外が1度も当たらなければ
  （直ったのに残っていると）試験が落ちる。
- `baseCtx(W, extra)`: 試験用の ctx（`ctrl: {}`、`rows: 30`、`now: 0`）。
- 試験ファイルの先頭で環境変数を入れること（`MUSER_SGR=1`、`COLORTERM=truecolor`、
  `FORCE_COLOR=3`、`MUSER_LANG=ja`、NO_COLOR を消す）。これがないと Ink 側に色が出ない。
  `require.resolve` の結果を `import()` に渡すときは `pathToFileURL(...).href` にする
  （Windows の `C:\…` をそのまま渡すと `ERR_UNSUPPORTED_ESM_URL_SCHEME` になる）。

### 試験の書き方（note の例）

```js
test('note: long wrapping line', () => {
  const e = {type: 'note', lines: ['これは長いメモです。幅が狭いと折り返されます。English words wrap too when the line is long enough to exceed the width.']};
  parity.checkParity({
    name: 'note: long wrapping line',
    react: W => parity.reactLines(h(Entry, {e, ctrl: {}, W}), W),
    draw: W => drawEntry(e, parity.baseCtx(W)),
  });
});
```

- `Entry` は `src/ui/view.mjs` から、`drawEntry` は `./index.mjs` から、`drawNote` は
  `./entries/note.mjs` から読む（`before()` で動的に読む）。
- 1種類につき、短い行・折り返す長い行・色の違う場合（note なら error）・空の行を含む場合・
  行がない場合を入れる。幅は既定の 40 / 80 / 120 で比べる。

## 担当の分け方（段階 B）

| 担当 | 会話の行（src/ui/fs/draw/entries/） | 操作欄（src/ui/fs/draw/live/） |
|---|---|---|
| B1 | user, md, gap, note（済み・例）, end, progress, sources, muse, help | — |
| B2 | tool, past, shellout, agent, focus, todos, status, banner | —（`diff.mjs` も B2。B3 の approval も使うので `null` 安全に） |
| B3 | — | working, running, approval, menu, question, chips, prompt, footer, agent-cards, add-screen, limit-input, queue, todos, preview, focus-row |

- 自分の部品のファイルと試験のファイルだけを触る。共有のファイル
  （`index.mjs`、`live/index.mjs`、`primitives.mjs`、`tests/helpers/parity.mjs`）は触らない。
  共有部分の変更が要るときは段階 A の担当に伝える。
- 部品は、できあがるまで `null` を返す。途中で置き換えた行だけが自前描画になる。
- 試験は関係するファイルだけを流す（`node --import ./tests/setup.mjs --test tests/fs-parity.test.js`）。
  全体の `npm test` は段階 C の最後に1回だけ流す。

## 段階 C（2026-11-07、済み）

- 入口の分離: 起動まわりは `src/ui/boot.mjs` に出して両画面で共有し、fullscreen の入口は
  `src/ui/fs/run.mjs` にした。`bin/muser.js` と `src/ui/demo.mjs` は fullscreen スイッチで
  入口を選ぶ。
- Ink / React / yoga は fullscreen の通り道から外れた（起動時に開くファイルで ink 0 /
  react 0 / yoga 0 を計測で確認）。入力パーサーは Ink のものを `src/ui/fs/` に写した。
  代わりの描画（`promptCaret` による枠探し）も消した。
- 変えた後の計測と全体の `npm test` は DevNote（段階 2 の記録）の段階 C の節に残した。
- 残り: `view.mjs` と `primitives.mjs` の重複（SPIN、見出し、色など）の整理はしていない。
  classic の描画が正本で、ここの写しが従う今の形のままにしてある。
