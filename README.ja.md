# muser

**日本語** | [English](README.md)

[Muse](https://muse.ai) のための、ターミナルで動く**非公式**コーディングエージェントです。
この PC を Muse の「端末」として登録し、Muse がこの PC のファイルを読み書きしたりコマンドを実行したりしながら、対話形式で作業を進めます。見た目と操作は Claude Code / Codex CLI に近づけています。

https://github.com/user-attachments/assets/15b00680-02a7-4f61-8841-81b0cbcafa59

> **非公式です。** muser は Meta / Muse とは関係のない個人のプロジェクトです。Muse の Web 版が使っている非公開の通信方式を使っているため、Muse 側の変更でいつでも動かなくなる可能性があり、利用規約に照らしてアカウントに影響が出る可能性もゼロではありません。ご自身の判断で使ってください。

## 動作環境

- Windows 10 / 11
- Node.js 22 以上
- Microsoft Edge（ログインの窓に使います）
- [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`。コード検索に使います: `winget install BurntSushi.ripgrep.MSVC`）
- Muse（muse.ai）のアカウント

## インストール

```powershell
npm install -g muser-cli
```

コマンド名は `muser` です。

## はじめかた

**作業したいフォルダーで**起動します（ホームフォルダーやドライブ直下で起動すると、検索がフォルダー全体に広がります）。

```powershell
cd C:\path\to\project
muser
```

初回は、その場で準備をします。最初に表示言語（English / 日本語）を聞きます。選んだ言語は `~/.muser/config.json` に保存され、`/lang` でいつでも切り替えられます（環境変数 `MUSER_LANG=en|ja` が優先）。

1. **muse.ai にログイン** — Edge の小さい窓が開きます。Muse（Meta アカウント）でログインしてください。パスワードは muser には渡りません。
2. **この PC を Muse の端末として登録** — メールアドレスに届く認証コードで登録します。Muse の 設定 › デバイス に「<PC 名> CLI (muser)」として出ます。

準備の流れは `muser demo login` で、実際にはログインせずに見られます。

## 使い方

入力欄に頼みたいことを書いて Enter。Muse がこの PC で作業し、その様子が流れます。

- `⏺ Read(src/app.js)` などは muser がこの PC で行った操作です。
- `⏺ Found 18 web results for … (Muse)` は Muse 自身の作業（Web 検索・メモリー検索など）です。回答の下には出典も出ます。
- 画面下部に承認モード、接続状態、Muse の週の使用量（`週 8%`）が出ます。

| キー / 入力 | 動き |
|---|---|
| Enter / `\`+Enter または Ctrl+J | 送信 / 改行 |
| Esc | 作業を中断 |
| Shift+Tab | 承認モードを切り替え |
| `@ファイル` | ファイルを添付（Tab で補完） |
| `!コマンド` | Muse を通さずに PowerShell で直接実行。終わると出力が Muse に送られ、Muse がそれに応えます（Claude Code と同じ。`/settings` でオフにすると次のメッセージに添えて送ります）。末尾に ` &` で裏で実行 |
| Alt+V / Ctrl+V | クリップボードの画像を添付 |
| Ctrl+Shift+V | クリップボードを貼り付け（画像は添付）。端末がこのキーを muser に渡す場合 |
| Ctrl+O | 直近のツール出力を全文表示（/output で一覧から）。`--client` では出力がサーバー側にあり、クライアントは取得しないため Ctrl+O は常に空です。サーバーへ転送される `/output` を使ってください |
| ↑↓ | 入力履歴（次回起動後も残ります） |

主なスラッシュコマンド: `/help` `/settings` `/focus` `/goal` `/new` `/clear` `/resume` `/permissions` `/agent` `/agents` `/bg` `/mcp` `/image` `/todos` `/usage` `/lang` `/login` `/account` `/update` `/reload` `/status` `/init` `/skills` `/skill` `/output` `/exit`

`/settings` では、すべての設定を今の値つきで1画面にまとめて見られます（エージェント上限、Focus とその自動続行の回数・時間、1ターンのツール呼び出し上限、1日のターン数の警告、このフォルダーと新しいフォルダーの承認モード、表示言語、ベル、起動時の更新確認、スピナーのアニメーション、長いコード行の折り返し、色、kitty キー入力（この2つは次回起動から）、スキル、MCP サーバー）。オン・オフの項目は選ぶと切り替わり、数値は範囲内の整数を入力します。どれも `~/.muser/config.json`（`focus`、`focusRounds`、`focusMinutes`、`maxToolCallsPerTurn`、`dailyTurnLimit`、`defaultMode`、`bell`、`updateCheck`、`motion`、`codeWrap`、`color`、`kitty`）に保存されます。`MUSER_NO_BELL=1`、`NO_COLOR`、`MUSER_MAX_TOOL_CALLS_PER_TURN` などの環境変数があればそちらが優先され、画面にもそう表示されます。`/settings agents` でエージェント上限を直接開けます。ここでは、起動中にエージェントの同時実行数と1タスクでの合計起動数を変更できます。0以上の整数（0 は無制限）を入力し、「今回だけ適用」か「適用して既定値として保存」を選びます。実行中のエージェントはそのまま動き、新しく起動するときから制限が反映されます。保存先は `~/.muser/config.json` で、次回起動時は起動オプション・環境変数が優先されます。

作業中のスピナーの言葉は、Muse が `spinner.set` でその作業に合わせて決めます（「Untangling regexes…」など）。決まるまでは muser の言葉（「Musing…」「Daydreaming…」など）を出します。
複数段階の作業では、Muse に `progress.report` を呼んで節目の経過報告をするよう指示します。報告はその場で表示し、`/resume` でも読めるようローカルのターン履歴に保存します。通常の `exec` では stderr、`exec --json` では `type: "progress"` で出力します。報告のタイミングはモデルに依存し、一定秒数ごとの表示は保証しません。この独自コマンドが Muse の Activity にどう表示・保存されるかは未確認です。

答えの候補が決まっているとき、Muse は選択肢つきで質問します（最大 4 問、複数選択・説明・プレビューつき）。↑↓ と Enter で選ぶか、「自分で書く…」で選択肢にない答えを入力します。`n` でメモを添えられます。答えは返信として送られ、作業が再開します。

**Focus の完了条件管理は既定で自動有効です。** 複数操作やコード変更を伴う作業で、Muse が完了条件を記録し、実際のツール実行結果を根拠として紐づけます。明確な未達は同じ会話で続行し、最大3ラウンド・15分で止まります。軽い質問や単発の読み取りは計画不要です。確認不能・人の確認待ち・操作の拒否・進展のない繰り返し・追加メッセージの到着では自動続行を止めます。既存の作業用エージェントは利用でき、判定専用の別セッションは起動しません。

常設ゴールはタスクの上に立つ層です。`/goal <テキスト>` で設定すると、タスクがラウンド上限で止まったり、ゴールが立ったまま終わったりするたびに、ユーザーを待たずに次の区間（leg）を自動で始めます。ゴール自身を目標にしたタスクが完了すれば達成として解除されます。進捗のない繰り返し、ユーザーの回答が要る質問、自動 leg 10回までの上限では止まります。`/goal` で表示、`/goal clear` で解除。ゴールは会話に保存され、再開時にも残ります。

`/focus` で目標・条件・根拠を表示し、`/focus off`・`/focus on` でこのウィンドウだけ切り替えられます。起動時は `--no-focus` でも無効化できます。記録後の条件は固定し、依頼の訂正は新しい作業として扱います。Muser は根拠となる実行記録の存在やコマンドの成功を検査しますが、その根拠が条件を満たすか・条件が依頼を網羅しているかの解釈は Muse に依存します。見ていない画面や実機の正常動作は保証しません。結果は履歴に残りますが、再起動時に停止した作業を自動再開はしません。JSON exec は `type: "focus"` の更新と、対象タスクの結果に `completed`・`focus` を追加します。`ok` は要求処理の終了、`completed` は記録した条件の確認状態を示し、条件が未完了なら終了コードは非ゼロになります。

起動するたびに、裏で npm に新しい版があるかを確認し、あれば下の情報欄に出します（`⬆ v… · /update`）。`/update` で `npm install -g muser-cli@latest` を実行して更新します。勝手にインストールはしません。確認を止めるには、環境変数 `MUSER_NO_UPDATE_CHECK=1` か、`~/.muser/config.json` の `{"updateCheck": false}` を使います。

表示を静かにするには、`NO_COLOR=1` で色を消し、`MUSER_NO_BELL=1`（または `{"bell": false}`）で承認や並列エージェントの完了のときのベルを止め、`MUSER_REDUCED_MOTION=1` でスピナーを止められます。

## コマンド

| コマンド | 説明 |
|---|---|
| `muser` / `muser "指示"` | 対話モードで開始（最初の指示も渡せます） |
| `muser -c` / `--continue` | このフォルダーの直前の会話を再開 |
| `muser resume [ID] ["指示"]` | 会話を再開（ID なしで一覧。ID の後ろの言葉は最初の指示として送ります） |
| `muser --session <ID> ["指示"]` | その会話を対話モードで再開（`exec` と同じ `--session`） |
| `muser exec "指示"` | 1回だけ実行して、最後の返事を標準出力へ（出典があればその一覧も。確認が必要な操作は断ります）。指示なし、または `-` のときは標準入力から指示を読みます（例: `type task.md \| muser exec`） |
| `muser exec --json "…"` | 同じことを JSON Lines で。PC 操作と Muse 側の手順が1行ずつ、最後の行が結果（会話 ID・返事・出典・週の使用量の前後）。失敗時は終了コード 1 |
| `muser exec --session <ID> "…"` | その会話の続きとして実行（`--json` の結果の `session`） |
| `muser exec --status-file <パス> "…"` | 実行の状態を JSON ファイルに書き続け、別のエージェント（Codex・Claude Code）から読めるようにします。実行中は `"state":"running"` で、会話 ID・ツールの履歴・Todo・経過報告・Muse 側の手順・画面に出た行（`log`）を入れ、10 秒ごと以上に更新します。終わると `"state":"done"` と `exit`（0 完了 / 2 Focus の条件未達 / 1 失敗）・返事・Focus の判定。指定しなくても `%LOCALAPPDATA%\muser\exec\` に書き、場所を最初に表示します |
| `muser status` / `muser status <pid か会話 ID>` / `--json` | この PC の muser が今なにをしているかを一覧します。普通の窓・常駐サーバーの会話・実行中の `muser exec` について、作業中 / 承認待ち / 入力待ち / 待機中、動いているツール、進行中の Todo、Focus、並列エージェントを表示します。pid か会話 ID を付けると1つを詳しく（最近のツール・Todo 全部・エージェント・最新の経過報告）。`--json` は同じ内容を別のエージェント向けのデータで出します。各窓は今の状態を `%LOCALAPPDATA%\muser\windows\<pid>.json` に書きます（入力中の文や返事は書きません） |

**Claude Code・Codex から使う:** スキル `skills/muser-exec`（このリポジトリと npm パッケージに同梱）は、コード全体の調査・不具合探し・レビュー・調べものといった読み込みの多い作業を `muser exec` で Muse に任せる方法をエージェントに教えます。作業は Muse のプランで動くので、エージェント自身の使用量を抑えられます。`muser agent-skill install` で、この PC の Claude Code と Codex のスキルフォルダー（`~/.claude/skills`・`~/.codex/skills`・`$CODEX_HOME/skills`・`~/.codex-accounts/*/skills`）に、muser 本体のスキルへのリンクとして登録します（muser を更新すればスキルも新しくなります）。`muser agent-skill` で登録状況、`muser agent-skill remove` で muser が入れたものだけを外します（`claude` / `codex` を付けると片方だけ）。muser 自身はこのスキルを Muse には見せません。
| `muser login` / `muser logout` | muse.ai へのログイン / ログアウト（`logout` でログイン情報を消します） |
| `muser help` / `muser -h` / `--help` | 組み込みのヘルプを表示 |
| `muser -V` / `--version` / `-v` | バージョンを表示 |
| `muser pc-login` | この PC を端末として登録し直す |
| `muser usage` | Muse の利用状況と muser の記録 |
| `muser doctor` | 接続の確認 |
| `muser demo` / `muser demo login` | Muse につながずに画面 / ログインまわりを試す |
| `muser serve [--port N]` | GUI とスマホアプリがつなぐ常駐 Muser Server を起動（127.0.0.1 のみ。接続情報は `~/.muser/gui.json` と `~/.muser/server.json` に書かれます） |
| `muser server` / `muser server status` / `muser server stop` / `muser server autostart on\|off` | 常駐サーバーをその名前で操作: 起動 / 状態と開いている会話の表示 / 停止 / ログオン時の自動起動 |
| `muser link` / `muser link pair [--wifi]` / `muser link revoke <名前>` / `muser link autostart on\|off` | スマホ連携: 状態とペアリング済み端末の表示 / ペアリング（QR コード、`--wifi` で同じ Wi-Fi 向けのコード方式） / 端末の取り消し / ログオン時に Server（連携込み）を起動 |
| `muser --client` | 単独で起動せず、動いている Muser Server の会話につないで対話（サーバーが動いていなければエラー） |

| オプション | 説明 |
|---|---|
| `--mode <m>` | 承認モード（下表）。付けないときは、そのフォルダーで前回選んだモード |
| `--cd <dir>` | 作業フォルダー（既定: 今のフォルダー） |
| `--max-agents <n>` | 並列エージェントを同時に動かす数の上限（既定 4、0 で無制限） |
| `--max-agents-total <n>` | 1回の作業で起動できる並列エージェントの数の上限（既定 0 = 無制限） |
| `--port <n>` | `serve` / `server` のポート（既定: OS 任せの空きポート） |
| `--relay <url>` | スマホ連携のリレー（`serve` / `server` / `link` で使用。環境変数 `MUSER_RELAY_URL` でも指定可） |
| `--no-link` / `--no-lan` | スマホ連携なし / 連携の LAN 待ち受けなしでサーバーを起動 |
| `--wifi` | `link pair` で、QR コードでなく同じ Wi-Fi 向けのコードでペアリング |

## 承認モード

| モード | 表示 | 挙動 |
|---|---|---|
| `default` | 毎回確認 | 読むのは自動。編集とコマンドは毎回確認 |
| `auto-edit` | 編集は自動 | 作業フォルダー内の編集は自動。コマンドは確認 |
| `plan` | 読み取り専用 | 読むだけ。編集と変更系のコマンドは断る |
| `bypass` | すべて自動 | 全部確認なしで実行 |

- 承認モードと、確認で「このフォルダーでは … を聞かない」を選んだものは、**フォルダーごとに保存**され、次回も引き継がれます（`~/.muser/permissions.json`。bypass も含む）。`/permissions` で一覧・消去できます。
- 読み取り専用と判定するコマンドは、git / rg / npm の安全と確かめられたサブコマンドとフラグだけです（許可リスト方式）。分からないものは確認に回ります。
- 作業フォルダーの外への編集は、bypass 以外では必ず確認します。

## 並列エージェント

Muse は独立したサブタスクを並列エージェントに任せられます（`/agent <タスク>` で自分から任せることもできます）。各エージェントは Muse の別のサイドチャットで、同じフォルダー・同じツールを使って動きます。

| 型 | 内容 |
|---|---|
| `general` | 何でもやる（既定） |
| `explore` / `plan` / `review` | 調べる / 計画を立てる / レビューする（読み取り専用） |
| `test` | テストを流して、落ちたら直す |

カスタムの型は `~/.muser/agents/*.md` か `<プロジェクト>/.muser/agents/*.md` に置けます（Claude Code 形式。frontmatter: `name` `description` `tools` `readonly`）。
エージェントは Muse の使用量を多く使うので、数は `--max-agents` / `--max-agents-total`、環境変数 `MUSER_MAX_AGENTS` / `MUSER_MAX_AGENTS_TOTAL`、`~/.muser/config.json` の `{"maxAgents": 4, "maxAgentsTotal": 8}` で制限できます。

## スキル

`SKILL.md`（frontmatter の `name` と `description`、続けて手順）を置いたフォルダーを「スキル」として読みます。読む場所は、プロジェクトの `.muser/skills` と `.claude/skills`、`~/.muser/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` です。Claude Code や Codex で使っているスキルが、そのまま使えます（muser はそれらのフォルダーに書き込みません）。

Muse には各スキルの名前と短い説明だけを渡し、必要になったら `skill.read` で中身を読ませます。`/skills` でスキル（や読み込み元ごと）のオン・オフ、`/skill <名前> <頼みたいこと>` でスキルを使った依頼ができ、メッセージの中で `$名前` と書いても（補完が出ます）そのスキルで依頼できます。オンのスキルは新しい会話の最初のメッセージに1行ずつ載るので、使わないものはオフにしてください。

## MCP

`~/.muser/mcp.json` に書くか、`/mcp` から Claude Code（`~/.claude.json`）や Codex（`~/.codex/config.toml`）の設定を取り込めます。

```json
{ "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "enabled": true } } }
```

有効にしたサーバーのツールは `mcp.<サーバー>.<ツール>` として Muse に渡ります。`env` / `headers` の値は保存時に暗号化した保管庫へ移り、`mcp.json` には参照だけが残ります。

## 利用状況

`/usage`・`muser usage`・画面下部に、muse.ai と同じ **Muse の週の使用量（%）、リセット時刻、追加分の残り**を出します。作業が終わるたびに取り直し、増えていれば「この作業で +2%」と知らせます。トークン数そのものは Muse が公開していないため出せません。

**複数アカウント:** `muser account add <名前>` で別の Muse アカウントを追加できます（Edge プロファイル・ログイン・端末登録はアカウントごとに分離）。2つ以上あると、起動時は週の使用量が少ない方を選び、今のアカウントのログインが切れたら別アカウントへ自動で切り替えて、画面に知らせます。週の上限に達したときは「このまま追加を利用する」か「新しいアカウントで引き継ぐ」かを選べます（90% からはツールの使用ごとに確認。60 秒答えがなければ `/settings` の「週の上限で応答がないとき」に従い、既定では追加購入分が残っていれば続け、なければ引き継いで、終わっていない作業をそのまま再開します）。切替先の Muse は会話を見ていないので、切替は常に新しいチャット（ここまでの作業の引き継ぎメモ付き）から始まり、作業の途中では切り替えません。既定のアカウント（`muser login` などが対象にするもの）は最初のアカウントのままで、変えるのは `muser account use <名前>` だけです（自動選択や切替、追加では変わりません）。`/account` で一覧と手動切替、`--account <名前>` で固定、`MUSER_NO_ACCOUNT_AUTO=1`（または `muser account auto off`）で自動選択を止められます。

## データの置き場所

| 場所 | 中身 |
|---|---|
| `%LOCALAPPDATA%\muser\*.enc` | ログイン情報・端末の認証（Windows DPAPI で暗号化） |
| `%LOCALAPPDATA%\muser\sessions.json` | 会話の一覧 |
| `%LOCALAPPDATA%\muser\transcripts\*.jsonl` | 会話の記録（再開時の表示に使い、足りない分だけ Muse から読み込みます） |
| `~/.muser/gui.json` / `~/.muser/server.json` | 動いているサーバーへの接続情報（ポートと Bearer トークン）。トークンを読めればサーバーを操作できるため、認証情報として扱うこと |
| `~/.muser/` | 設定（`mcp.json`、`config.json`、`permissions.json`、`agents/`、どのプロジェクトでも読む自分用の指示 `AGENTS.md` — `~/.claude/CLAUDE.md` や `~/.codex/AGENTS.md` と同じ役割）、入力履歴、使用量の記録 |

`muser logout` でログイン情報を消せます。

## 安全のための仕組み

- `.env`、秘密鍵（`*.pem` `*.key` `id_rsa` など）、`credentials.json`・`secrets.json` などの認証情報ファイル、`.ssh` / `.aws` / `.gnupg` は、muser のファイル読み取り・検索では読めません。
- 検索（`code.grep` / `code.glob`）は 30 秒で打ち切ります。OneDrive フォルダー（クラウドのみのファイルを読むとダウンロードが始まるため）と、ホームから検索するときの AppData は、`path` でその中を指したときだけ検索します。
- 1ターンのツール呼び出しは 250 回まで（`MUSER_MAX_TOOL_CALLS_PER_TURN`）。
- 接続が切れても（スリープ・回線断）、自動でつなぎ直します。作業中に切れても、5 分以内に戻れば作業は続きます。

## 開発

```powershell
git clone https://github.com/nyarurant/muser
cd muser
npm install
npm link
npm test        # 単体テスト
npm run check   # 構文チェック
```

`scripts/roundtrip*.js` は本物の Muse につないで確かめるスクリプトです（実行すると Muse に「テストです」の会話ができ、使用量も使います）。

## ライセンス

MIT
