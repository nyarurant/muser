# muser

[日本語](README.ja.md) | **English**

An **unofficial** terminal coding agent for [Muse](https://muse.ai).
It registers this PC as a Muse "device", so Muse can read and edit files and run commands here while you work together in a conversation. The look and feel follow Claude Code / Codex CLI.

https://github.com/user-attachments/assets/93eb5d68-4bc8-4f50-9d2e-21bcf1118a4c

> **Unofficial.** muser is a personal project with no affiliation with Meta / Muse. It speaks the private protocol the Muse web app uses, so a change on Muse's side can break it at any time, and it may sit uneasily with the terms of service — use it at your own discretion.

## Requirements

- Windows 10 / 11
- Node.js 22 or newer
- Microsoft Edge (used for the login window)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`, used for code search: `winget install BurntSushi.ripgrep.MSVC`)
- A Muse (muse.ai) account

## Install

```powershell
npm install -g muser-cli
```

The command name is `muser`.

## Getting started

Start it **in the folder you want to work in** (starting in your home folder or a drive root makes searches span the whole tree).

```powershell
cd C:\path\to\project
muser
```

The first run sets things up on the spot. It first asks for the UI language (English / 日本語); your choice is saved to `~/.muser/config.json`, can be changed any time with `/lang`, and the `MUSER_LANG=en|ja` environment variable overrides it.

1. **Sign in to muse.ai** — a small Edge window opens. Sign in with your Muse (Meta) account. Your password never reaches muser.
2. **Register this PC as a Muse device** — done with a verification code sent to your email address. The PC appears in Muse under Settings › Devices as "<PC name> CLI (muser)".

You can watch the whole setup flow without signing in with `muser demo login`.

## Using it

Type what you want done and press Enter. Muse works on this PC and you see it happen.

- Lines like `⏺ Read(src/app.js)` are actions muser performed on this PC.
- Lines like `⏺ Found 18 web results for … (Muse)` are Muse's own work (web search, memory search, …). Sources are shown under the answer too.
- The footer shows the approval mode, the connection state, and Muse's weekly usage (e.g. `week 8%`).

| Key / input | What it does |
|---|---|
| Enter / `\`+Enter or Ctrl+J | Send / newline |
| Esc | Interrupt the work |
| Shift+Tab | Cycle the approval mode |
| `@file` | Attach a file (Tab completes) |
| `!command` | Run in PowerShell directly, without Muse, and pass the output with your next message (prefix `&` to run it in the background) |
| Alt+V / Ctrl+V | Attach the clipboard image |
| ↑↓ | Input history (kept across restarts) |

Main slash commands: `/help` `/new` `/clear` `/resume` `/permissions` `/agent` `/agents` `/bg` `/mcp` `/image` `/todos` `/usage` `/lang` `/login` `/update` `/status` `/init` `/exit`

At every start muser checks npm for a newer version in the background and shows it in the footer (`⬆ v… · /update`); `/update` installs it with `npm install -g muser-cli@latest`. Nothing is installed without you. Turn the check off with `MUSER_NO_UPDATE_CHECK=1` or `{"updateCheck": false}` in `~/.muser/config.json`.

## Commands

| Command | What it does |
|---|---|
| `muser` / `muser "instructions"` | Start interactively (optionally with a first instruction) |
| `muser -c` / `--continue` | Resume this folder's latest conversation |
| `muser resume [ID]` | Resume a conversation (list when no ID) |
| `muser exec "instructions"` | Run once and print the final reply to stdout (anything needing approval is declined) |
| `muser exec --json "…"` | The same as JSON Lines: a line per tool call and Muse-side step, the last line is the result (session id, reply, sources, weekly usage before/after); exit code 1 on failure |
| `muser exec --session <ID> "…"` | Continue that conversation (the `session` of a `--json` result) |
| `muser login` / `muser logout` | Sign in to / out of muse.ai |
| `muser pc-login` | Register this PC as a device again |
| `muser usage` | Muse usage and muser's own record |
| `muser doctor` | Check the connection |
| `muser demo` / `muser demo login` | Try the UI / the login flow without connecting to Muse |

| Option | What it does |
|---|---|
| `--mode <m>` | Approval mode (table below). When omitted, the mode last chosen in this folder |
| `--cd <dir>` | Working folder (default: the current folder) |
| `--max-agents <n>` | Cap on parallel agents running at once (default 4, 0 = unlimited) |
| `--max-agents-total <n>` | Cap on parallel agents started per task (default 0 = unlimited) |
## Approval modes

| Mode | Label | Behaviour |
|---|---|---|
| `default` | Ask every time | Reads are automatic. Edits and commands ask every time |
| `auto-edit` | Edits are automatic | Edits inside the working folder are automatic. Commands ask |
| `plan` | Read-only | Reading only. Edits and state-changing commands are refused |
| `bypass` | Everything automatic | Everything runs without asking |

- The approval mode, and anything you marked "don't ask again in this folder" at a prompt, are **saved per folder** and carry over to the next run (`~/.muser/permissions.json`, bypass included). `/permissions` lists and clears them.
- A command counts as read-only only if it is on the allowlist of verified-safe git / rg / npm subcommands and flags. Anything unrecognised goes to a prompt.
- Edits outside the working folder always ask, except in bypass.

## Parallel agents

Muse can hand independent subtasks to parallel agents (and you can too, with `/agent <task>`). Each agent runs in its own Muse side chat, in the same folder, with the same tools.

| Type | What it does |
|---|---|
| `general` | Does anything (default) |
| `explore` / `plan` / `review` | Explores / plans / reviews (read-only) |
| `test` | Runs the tests and fixes failures |

Custom types live in `~/.muser/agents/*.md` or `<project>/.muser/agents/*.md` (Claude Code format; frontmatter: `name` `description` `tools` `readonly`).
Agents use a lot of your Muse allowance, so cap them with `--max-agents` / `--max-agents-total`, the `MUSER_MAX_AGENTS` / `MUSER_MAX_AGENTS_TOTAL` environment variables, or `{"maxAgents": 4, "maxAgentsTotal": 8}` in `~/.muser/config.json`.

## Skills

muser reads skills — folders with a `SKILL.md` (frontmatter `name` and `description`, then instructions) — from the project's `.muser/skills` and `.claude/skills`, and from `~/.muser/skills`, `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`. Skills you already use with Claude Code or Codex work as they are; muser never writes to those folders.

Muse sees only each skill's name and a short description, and reads a skill with the `skill.read` command when it needs it. `/skills` turns skills (or whole sources) on and off; `/skill <name> <request>` asks Muse to use one. Every enabled skill adds a line to a new conversation's first message, so turn off the ones you do not need.

## MCP

Write `~/.muser/mcp.json`, or import settings from Claude Code (`~/.claude.json`) or Codex (`~/.codex/config.toml`) from `/mcp`.

```json
{ "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "enabled": true } } }
```

Tools of enabled servers are given to Muse as `mcp.<server>.<tool>`. `env` / `headers` values are moved into an encrypted vault when saved; only references stay in `mcp.json`.

## Usage

`/usage`, `muser usage` and the footer show the same numbers as muse.ai: **Muse's weekly usage (%), when it resets, and how much add-on credit is left**. They are refetched after every task, and if the number went up you are told, e.g. "this task used +2%". Token counts themselves are not published by Muse, so they cannot be shown.

## Where data lives

| Place | Contents |
|---|---|
| `%LOCALAPPDATA%\muser\*.enc` | Login and device credentials (encrypted with Windows DPAPI) |
| `%LOCALAPPDATA%\muser\sessions.json` | The conversation list |
| `%LOCALAPPDATA%\muser\transcripts\*.jsonl` | Conversation transcripts (used to show resumed chats; only the missing part is fetched from Claude) |
| `~/.muser/` | Settings (`mcp.json`, `config.json`, `permissions.json`, `agents/`), input history, usage records |

`muser logout` deletes the login credentials.

## Safety mechanisms

- `.env` files, private keys (`*.pem`, `*.key`, `id_rsa`, …), credential files such as `credentials.json` / `secrets.json`, and `.ssh` / `.aws` / `.gnupg` cannot be read through muser's file reading or searching.
- Searches (`code.grep` / `code.glob`) stop after 30 seconds. OneDrive folders (reading a cloud-only file would start a download) and, when searching from your home folder, AppData are only searched when a `path` points inside them.
- Tool calls per turn are capped at 250 (`MUSER_MAX_TOOL_CALLS_PER_TURN`).
- If the connection drops (sleep, network), it reconnects by itself. If it comes back within 5 minutes mid-task, the work continues.

## Development

```powershell
git clone https://github.com/nyarurant/muser
cd muser
npm install
npm link
npm test        # unit tests
npm run check   # syntax check
```

`scripts/roundtrip*.js` are scripts that verify against a real Muse (running one creates a "test" conversation in Muse and uses your allowance).

The UI is bilingual (English / Japanese): UI strings are written in Japanese in the code and translated through the table in `src/i18n/en.js` when the language is English — see `src/i18n.js`.

## License

MIT
