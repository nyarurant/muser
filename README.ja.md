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
| `!コマンド` | Muse を通さず PowerShell で実行し、出力を次のメッセージで渡す（`&` を付けると裏で実行） |
| Alt+V / Ctrl+V | クリップボードの画像を添付 |
| ↑↓ | 入力履歴（次回起動後も残ります） |

主なスラッシュコマンド: `/help` `/new` `/clear` `/resume` `/permissions` `/agent` `/agents` `/bg` `/mcp` `/image` `/todos` `/usage` `/lang` `/login` `/update` `/status` `/init` `/exit`

起動するたびに、裏で npm に新しい版があるかを確認し、あれば下の情報欄に出します（`⬆ v… · /update`）。`/update` で `npm install -g muser-cli@latest` を実行して更新します。勝手にインストールはしません。確認を止めるには、環境変数 `MUSER_NO_UPDATE_CHECK=1` か、`~/.muser/config.json` の `{"updateCheck": false}` を使います。

## コマンド

| コマンド | 説明 |
|---|---|
| `muser` / `muser "指示"` | 対話モードで開始（最初の指示も渡せます） |
| `muser -c` / `--continue` | このフォルダーの直前の会話を再開 |
| `muser resume [ID]` | 会話を再開（ID なしで一覧） |
| `muser exec "指示"` | 1回だけ実行して、最後の返事を標準出力へ（確認が必要な操作は断ります） |
| `muser exec --json "…"` | 同じことを JSON Lines で。PC 操作と Muse 側の手順が1行ずつ、最後の行が結果（会話 ID・返事・出典・週の使用量の前後）。失敗時は終了コード 1 |
| `muser exec --session <ID> "…"` | その会話の続きとして実行（`--json` の結果の `session`） |
| `muser login` / `muser logout` | muse.ai へのログイン / ログアウト |
| `muser pc-login` | この PC を端末として登録し直す |
| `muser usage` | Muse の利用状況と muser の記録 |
| `muser doctor` | 接続の確認 |
| `muser demo` / `muser demo login` | Muse につながずに画面 / ログインまわりを試す |

| オプション | 説明 |
|---|---|
| `--mode <m>` | 承認モード（下表）。付けないときは、そのフォルダーで前回選んだモード |
| `--cd <dir>` | 作業フォルダー（既定: 今のフォルダー） |
| `--max-agents <n>` | 並列エージェントを同時に動かす数の上限（既定 4、0 で無制限） |
| `--max-agents-total <n>` | 1回の作業で起動できる並列エージェントの数の上限（既定 0 = 無制限） |

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

Muse には各スキルの名前と短い説明だけを渡し、必要になったら `skill.read` で中身を読ませます。`/skills` でスキル（や読み込み元ごと）のオン・オフ、`/skill <名前> <頼みたいこと>` でスキルを使った依頼ができます。オンのスキルは新しい会話の最初のメッセージに1行ずつ載るので、使わないものはオフにしてください。

## MCP

`~/.muser/mcp.json` に書くか、`/mcp` から Claude Code（`~/.claude.json`）や Codex（`~/.codex/config.toml`）の設定を取り込めます。

```json
{ "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "enabled": true } } }
```

有効にしたサーバーのツールは `mcp.<サーバー>.<ツール>` として Muse に渡ります。`env` / `headers` の値は保存時に暗号化した保管庫へ移り、`mcp.json` には参照だけが残ります。

## 利用状況

`/usage`・`muser usage`・画面下部に、muse.ai と同じ **Muse の週の使用量（%）、リセット時刻、追加分の残り**を出します。作業が終わるたびに取り直し、増えていれば「この作業で +2%」と知らせます。トークン数そのものは Muse が公開していないため出せません。

## データの置き場所

| 場所 | 中身 |
|---|---|
| `%LOCALAPPDATA%\muser\*.enc` | ログイン情報・端末の認証（Windows DPAPI で暗号化） |
| `%LOCALAPPDATA%\muser\sessions.json` | 会話の一覧 |
| `%LOCALAPPDATA%\muser\transcripts\*.jsonl` | 会話の記録（再開時の表示に使い、足りない分だけ Muse から読み込みます） |
| `~/.muser/` | 設定（`mcp.json`、`config.json`、`permissions.json`、`agents/`）、入力履歴、使用量の記録 |

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
