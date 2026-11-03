---
name: muser-exec
description: Delegate a bounded, read-heavy subtask to Muse with `muser exec` so it runs on the user's Muse plan instead of your own usage limits — exploring or reading a large codebase, hunting bugs / reviewing code, summarizing long files or logs, web research, drafting text. Use when doing it yourself would cost many tokens and the result can be checked (Muse に任せて limit を節約、muser exec に委任、調査・解析・レビューを Muse に投げる). Not for tiny tasks, secrets, or anything destructive.
---

# Delegate to Muse with `muser exec`

`muser exec` sends one task to the user's Muse (muse.ai) and lets it work on this PC through
muser's tools: reading and searching files, running commands, editing (if the mode allows).
Muse's work counts against the user's Muse weekly plan, not against your own context or limits.
You pay only for writing the task and reading the answer.

## When to delegate

Delegate when all of these hold:

- The subtask is bounded and can be written down on its own. Muse does not see this conversation,
  so it needs a self-contained brief.
- Doing it yourself would take many reads or searches: a broad codebase survey, a bug hunt over
  several files, a review of a diff, summarizing big logs, web lookups.
- You can check the answer cheaply: file:line references you can open, a command you can re-run.

Do it yourself instead when:

- The task is small. A run costs about 15-20 s even for a one-liner.
- It needs secrets or credentials.
- It needs the conversation's context that you cannot write down.
- It is destructive, or the user expects you yourself to decide.

## How

1. Write a self-contained brief: the goal, the folder, what to read, and the output format you want.
   For findings, ask for "file:line, what happens, evidence, and how sure you are". For a long
   brief, write it to a file and pass it on stdin (`-`).
2. Pick the mode:
   - `--mode plan`: read-only. Use it for analysis, review and research.
   - `--mode auto-edit`: lets Muse edit files. Review the diff yourself afterwards (`git diff`).
   - The default mode declines anything that would need an approval, because nobody is there to give one.
3. Run it in the background with a status file, from the target folder or with `--cd`:

   ```
   muser exec --mode plan --cd <repo> --status-file <tmp>/muse-<task>.json - < <tmp>/brief.md
   ```

   - Claude Code: use Bash with `run_in_background`. You are told when it exits; read the status file meanwhile if you need progress.
   - Codex: start it in the background and poll the status file.
4. Read the result. Poll with `muser exec --status <path>`: a few lines on the run instead of the
   whole file (about 1/12 of its size on a small run, far less on a long one). Its exit code is the
   run's result once it ended (0 / 2 / 1), 4 while it runs, and 5 when the run is gone or there is
   no such file.
   - stdout carries the final reply.
   - The status file carries the same reply plus the run's record.
5. Verify before you act. Muse's findings are hypotheses: open the cited lines and re-run the claimed
   command. In practice most findings hold, but not all.
6. To follow up in the same conversation, use `muser exec --session <id> "…"`. The id is in the
   status file and on the last stderr line ("続きは: …").

## What muser is doing right now: `muser status`

`muser status --json` lists every muser on this PC — plain interactive windows, the resident
server's conversations and running `muser exec` runs — as `{"windows": [...], "servers": [...], "execs": [...]}`.
A window entry has `activity` (`working` / `approval` / `input` / `idle`), `running` (the tool
in progress and since when), `approval`, `todos`, `focus` (status, round, met / total, open
criteria), `agents` (each parallel agent's state and last tool), `toolLog` (the latest tools)
and `lastTurn`. `muser status <pid or chat id>` is one of them in a few lines; add `--json` for
the same as data. Use it to see what the user's own muser window is busy with before starting
work in the same folder, or to tell a hung agent (no new tool for a long time) from a busy one.

## The status file

The file is replaced whole on every update, so you can poll it safely. It is refreshed at least
every 10 s.

While the run works:

```json
{"state": "running", "pid": 1234, "session": "…", "tools": 5, "last": "code.read src/agent.js",
 "todos": [{"content": "…", "status": "in_progress"}], "progress": [{"message": "…"}],
 "steps": [{"title": "…"}], "toolLog": [{"command": "code.grep", "ok": true}], "focus": {…},
 "log": ["· Muse に接続しています…", "  ✓ code.read package.json", …], "updatedAt": "…"}
```

When it ends:

```json
{"state": "done", "exit": 0, "ok": true, "reply": "…", "completed": true, "focus": {…}, "session": "…", "durationMs": 19000}
```

- `exit` (also the process exit code):
  - `0`: done.
  - `2`: Muse answered, but its own completion check (Focus) did not pass. Read the reply anyway;
    in plan mode this often only means it could not run a command to double-check.
  - `1`: failed. See `error`; a common one is "not logged in" (the user runs `muser login`).
  - `130`: interrupted.
- `state: "failed"`: the process ended without a result.
- A `running` file whose `pid` is gone and whose `updatedAt` has stopped moving is a dead run.

Without `--status-file`, the file goes to `%LOCALAPPDATA%\muser\exec\` and its path is the first
line on stderr. `--json` streams the same events as JSON Lines on stdout instead.

## Accounts

The user may have several Muse accounts in muser. Each has its own weekly allowance and its own Muse.

- `muser account` lists them with their weekly use.
- With no flag, a run starts on the default account, unless another ready account is lighter by at
  least 20 points of weekly use, or the default cannot be used (used up, logged out). In those cases
  it starts on the lightest one.
- To spread many delegations, pass `--account` yourself: read `muser account` and pick the lightest.
- `--account <name>` pins a run to one account. If that account's login has lapsed, the run fails
  (exit 1) instead of moving to another account.
- A conversation lives on the account it was started on. `--session <id>` continues it there, and
  `--session` with another account's `--account` is refused. The account a run used is in the
  status file (`account`) and in `--status`.

## Limits and etiquette

- Check the room first: `muser usage` (or `muser account` with several accounts) prints the weekly
  % of the Muse plan. Near the limit, keep delegations small, pick a lighter account, or do the work
  yourself.
- Several `muser exec` runs may work at once; each gets its own device slot, up to 6.
- An analysis over many files takes minutes. Do not wait in a sleep loop: background the run and
  carry on.
- If `muser` is missing or not logged in, do the task yourself and tell the user. Do not try to log in for them.
- This skill is for agents outside muser. muser itself never offers it to Muse.
