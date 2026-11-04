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
| `!command` | Run in PowerShell directly, without Muse; when it finishes, its output goes to Muse, which answers it, as in Claude Code (off in `/settings`: it then goes with your next message); append ` &` at the end to run it in the background |
| Alt+V / Ctrl+V | Attach the clipboard image |
| Ctrl+Shift+V | Paste the clipboard (an image attaches), where the terminal passes the key to muser |
| Ctrl+O | Show the newest tool output in full (`/output` lists them all). In `--client` mode Ctrl+O always has nothing to show — the outputs stay on the server and the client never fetches them; use `/output` instead, which is forwarded to the server |
| ↑↓ | Input history (kept across restarts) |

Main slash commands: `/help` `/settings` `/focus` `/goal` `/new` `/clear` `/resume` `/permissions` `/agent` `/agents` `/bg` `/mcp` `/image` `/todos` `/usage` `/lang` `/login` `/account` `/update` `/reload` `/status` `/init` `/skills` `/skill` `/output` `/exit`

`/settings` gathers every setting on one screen, each with its current value: agent limits, Focus and its automatic rounds and time limit, the tool-call limit per turn, a daily turn warning, the approval mode for this folder and for new folders, the language, the bell, the update check at startup, spinner animation, wrapping long code lines, colours and the kitty keyboard protocol (these two from the next start), skills and MCP servers. On/off items switch when chosen; numbers are typed in (with their allowed range). Everything is saved in `~/.muser/config.json` (`focus`, `focusRounds`, `focusMinutes`, `maxToolCallsPerTurn`, `dailyTurnLimit`, `defaultMode`, `bell`, `updateCheck`, `motion`, `codeWrap`, `color`, `kitty`); an environment variable such as `MUSER_NO_BELL=1`, `NO_COLOR` or `MUSER_MAX_TOOL_CALLS_PER_TURN` still wins and the screen says so. `/settings agents` opens the agent limits directly: they change the concurrent and per-task agent limits while muser is open. Enter a non-negative integer (0 = unlimited), then choose **Apply for this run** or **Apply and save defaults**. Existing agents keep working; new launches use the new limits. Saved defaults go into `~/.muser/config.json`; command-line flags and environment variables still override them on the next launch.

While it works, Muse names its own spinner word for the task with `spinner.set` ("Untangling regexes…"); until it does, muser shows one of its own ("Musing…", "Daydreaming…"). For multi-step work, Muse is instructed to call `progress.report` at meaningful milestones. These short updates appear immediately in the terminal and are kept in the local turn transcript for `/resume`. Plain `exec` writes them to stderr; `exec --json` emits `type: "progress"` records. Updates are model-driven, so they are not guaranteed on a fixed timer. The exact presentation and retention of this custom command in Muse's Activity feed have not been verified.

When the possible answers are known, Muse asks with choices (up to four questions, with multi-select, descriptions and previews). Pick with ↑↓ and Enter, or enter an answer of your own with "Type your own…"; `n` adds a note. Your answer goes back as your reply and the work resumes.

Focus completion tracking is **on by default**. Muse records criteria for work with multiple actions or code changes, and links its conclusions to actual tool results. Clear unfinished work can continue in the same chat, up to 3 rounds or 15 minutes. Simple questions and single reads do not require a plan. Unknown/manual checks, declined commands, repeated lack of progress, or a queued user message stop automatic continuation. Existing work agents remain available; Focus does not start an independent reviewer.

A standing goal sits above a task: set one with `/goal <text>` and muser starts the next leg by itself whenever a task stops at its round limit or finishes while the goal stands — until a task aimed at the goal completes and clears it. Progress stalls, questions that need you, and a cap of 10 automatic legs still stop it. `/goal` shows the current goal, `/goal clear` removes it; it is saved with the conversation and returns on resume.

Use `/focus` to see the goal, criteria and evidence, `/focus off` or `/focus on` to switch it for the current window, or start with `--no-focus`. Criteria are fixed after they are recorded; correcting the request starts a new logical task. Focus checks that referenced observations exist and command checks really exited successfully; the relevance of an observation and the coverage of the criteria still depend on Muse's interpretation. It cannot certify an unseen UI or physical device. History keeps the outcome; restarting muser does not automatically resume a stopped task. JSON exec emits `type: "focus"` updates and adds `completed` and `focus` to tracked results. `ok` means the request finished; `completed` describes the tracked criteria. Incomplete tracked tasks exit nonzero.

At every start muser checks npm for a newer version in the background and shows it in the footer (`⬆ v… · /update`); `/update` installs it with `npm install -g muser-cli@latest`. Nothing is installed without you. Turn the check off with `MUSER_NO_UPDATE_CHECK=1` or `{"updateCheck": false}` in `~/.muser/config.json`.

Quieter terminal: `NO_COLOR=1` turns colours off, `MUSER_NO_BELL=1` (or `{"bell": false}`) silences the bell on approvals and finished agents, and `MUSER_REDUCED_MOTION=1` stops the spinners.

## Commands

| Command | What it does |
|---|---|
| `muser` / `muser "instructions"` | Start interactively (optionally with a first instruction) |
| `muser -c` / `--continue` | Resume this folder's latest conversation |
| `muser resume [ID] ["instructions"]` | Resume a conversation (list when no ID; any words after the ID are sent as the first prompt) |
| `muser --session <ID> ["instructions"]` | Resume that conversation interactively (the same `--session` as `exec`) |
| `muser exec "instructions"` | Run once and print the final reply to stdout, followed by its sources when it has any (anything needing approval is declined). With no prompt — or `-` — the prompt is read from stdin (e.g. `type task.md \| muser exec`) |
| `muser exec --json "…"` | The same as JSON Lines: a line per tool call and Muse-side step, the last line is the result (session id, reply, sources, weekly usage before/after); exit code 1 on failure |
| `muser exec --session <ID> "…"` | Continue that conversation (the `session` of a `--json` result) |
| `muser exec --status-file <path> "…"` | Keep the run's state in a JSON file another agent (Codex, Claude Code) can poll: `"state":"running"` with the session, the tool log, todos, progress, Muse-side steps and every line the terminal shows (`log`), refreshed at least every 10 s; at the end `"state":"done"` with `exit` 0 (done) / 2 (Focus criteria not met) / 1 (failed), the reply and the Focus judgement. Without the flag the file goes to `%LOCALAPPDATA%\muser\exec\` and its path is printed first |
| `muser status` / `muser status <pid or chat id>` / `--json` | What every muser on this PC is doing right now: plain windows, the resident server's conversations and running `muser exec` runs — working / waiting for approval / waiting for input / idle, the tool running, the todo in progress, Focus, parallel agents. With a pid or chat id, one in detail (recent tools, every todo, the agents, the latest progress). `--json` prints the same as data for another agent. Each window keeps its live state in `%LOCALAPPDATA%\muser\windows\<pid>.json` (never what you type or the replies) |

**For Claude Code and Codex:** the skill `skills/muser-exec` (in this repository and the npm package) teaches an agent to hand read-heavy work — codebase surveys, bug hunts, reviews, research — to Muse with `muser exec`, so it runs on your Muse plan instead of the agent's own limits. `muser agent-skill install` puts it into every Claude Code and Codex skill folder on this PC (`~/.claude/skills`, `~/.codex/skills`, `$CODEX_HOME/skills`, `~/.codex-accounts/*/skills`) as a link to muser's own copy, so updating muser updates the skill; `muser agent-skill` shows where it is, `muser agent-skill remove` takes out what muser put there (add `claude` or `codex` for one of them). muser itself never offers it to Muse.
| `muser login` / `muser logout` | Sign in to / out of muse.ai (`logout` deletes the saved login credentials) |
| `muser help` / `muser -h` / `--help` | Show the built-in help |
| `muser -V` / `--version` / `-v` | Show the version |
| `muser pc-login` | Register this PC as a device again |
| `muser usage` | Muse usage and muser's own record |
| `muser doctor` | Check the connection |
| `muser demo` / `muser demo login` | Try the UI / the login flow without connecting to Muse |
| `muser serve [--port N]` | Start the resident Muser Server that the GUI and phone apps connect to (127.0.0.1 only; how to reach it is written to `~/.muser/gui.json` and `~/.muser/server.json`) |
| `muser server` / `muser server status` / `muser server stop` / `muser server autostart on\|off` | The resident server under its own name: start it / show it and its open conversations / stop it / start it at logon |
| `muser link` / `muser link pair [--wifi]` / `muser link revoke <name>` / `muser link autostart on\|off` | The phone link: show its state and paired devices / pair a phone (QR code, or a code for the same Wi-Fi with `--wifi`) / revoke a paired device / start the server (with the link) at logon |
| `muser --client` | Talk to a conversation on the already-running Muser Server instead of starting standalone (an error if no server is running) |

| Option | What it does |
|---|---|
| `--mode <m>` | Approval mode (table below). When omitted, the mode last chosen in this folder |
| `--cd <dir>` | Working folder (default: the current folder) |
| `--max-agents <n>` | Cap on parallel agents running at once (default 4, 0 = unlimited) |
| `--max-agents-total <n>` | Cap on parallel agents started per task (default 0 = unlimited) |
| `--port <n>` | Port for `serve` / `server` (default: an OS-assigned free port) |
| `--relay <url>` | Relay for the phone link, with `serve` / `server` / `link` (or the `MUSER_RELAY_URL` environment variable) |
| `--no-link` / `--no-lan` | Start the server without the phone link / without the link's LAN listener |
| `--wifi` | With `link pair`: pair with a code for the same Wi-Fi instead of a QR code |
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

Muse sees only each skill's name and a short description, and reads a skill with the `skill.read` command when it needs it. `/skills` turns skills (or whole sources) on and off; `/skill <name> <request>` asks Muse to use one, and typing `$name` in a message (with completion) asks for that skill too. Every enabled skill adds a line to a new conversation's first message, so turn off the ones you do not need.

## MCP

Write `~/.muser/mcp.json`, or import settings from Claude Code (`~/.claude.json`) or Codex (`~/.codex/config.toml`) from `/mcp`.

```json
{ "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "enabled": true } } }
```

Tools of enabled servers are given to Muse as `mcp.<server>.<tool>`. `env` / `headers` values are moved into an encrypted vault when saved; only references stay in `mcp.json`.

## Usage

`/usage`, `muser usage` and the footer show the same numbers as muse.ai: **Muse's weekly usage (%), when it resets, and how much add-on credit is left**. They are refetched after every task, and if the number went up you are told, e.g. "this task used +2%". Token counts themselves are not published by Muse, so they cannot be shown.

**Multiple accounts:** `muser account add <name>` signs in another Muse account (its own Edge profile, login and device registration, kept apart from the first). With two or more accounts, a window starts on the one with the lowest weekly usage, fails over to another account when the current one's login lapses, and says so on screen. When the weekly limit is reached it asks: go on with the extra usage bought for that account, or hand the work over to another account; from 90% it checks after every tool call, and with no answer in 60 s it follows the /settings choice (default: go on while extra usage is left, otherwise hand over and resume the unfinished work there). A switch always starts a new chat (carrying a handoff note of the work so far) — the other account's Muse has not seen the conversation — and never happens mid-task. The default account (the one `muser login` and friends act on) stays the first one; only `muser account use <name>` changes it (automatic picks, switches and adding an account do not). `/account` lists the pool or switches by hand; `--account <name>` pins one account; `MUSER_NO_ACCOUNT_AUTO=1` (or `muser account auto off`) turns the automatic choice off.

## Where data lives

| Place | Contents |
|---|---|
| `%LOCALAPPDATA%\muser\*.enc` | Login and device credentials (encrypted with Windows DPAPI) |
| `%LOCALAPPDATA%\muser\sessions.json` | The conversation list |
| `%LOCALAPPDATA%\muser\transcripts\*.jsonl` | Conversation transcripts (used to show resumed chats; only the missing part is fetched from Claude) |
| `~/.muser/gui.json` / `~/.muser/server.json` | How the GUI and other local clients find the running server: its port and its Bearer token. Anyone who can read the token can drive the server, so treat these files as credentials |
| `~/.muser/` | Settings (`mcp.json`, `config.json`, `permissions.json`, `agents/`, and `AGENTS.md` — your instructions for every project, like `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`), input history, usage records |

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
