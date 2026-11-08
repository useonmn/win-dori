# win-dori

> **win-dori is the Windows port of [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent).** Dori and dori-superagent are Sisyphus Labs' project; win-dori follows upstream commit [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444) and keeps upstream's behaviour and defaults. What it adds is what Windows needs: the PowerShell install, shell-aware panes, and a Windows profile with autostart and a Slack listener. Credit for Dori goes to the upstream authors; bugs in the Windows parts are ours. Upstream issues belong at [sisyphuslabs/dori-superagent/issues](https://github.com/sisyphuslabs/dori-superagent/issues).

> **Licence.** Since this port win-dori is under the [Sustainable Use License](LICENSE), like upstream: personal use, internal business use and free non-commercial use only. [NOTICE.md](NOTICE.md) says what win-dori changed. Versions up to `fa86ddf` were MIT and stay MIT.

**Dori lives in your chat. Tell him what to do in Slack, Telegram or Discord, and each job gets its own coding-agent session, tracked until the work is merged, with a CLEAR review at the exact head required before anything lands.**

English | [한국어](README.ko.md) | [简体中文](README.zh.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Italiano](README.it.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

Dori is a multi-session coding-agent harness from [Sisyphus Labs](https://sisyphuslabs.ai). One lead session talks to you. A request becomes a lane, which is one [omo](https://github.com/code-yeongyu/oh-my-openagent) session in its own [herdr](https://github.com/herdrdev/herdr) tab with its own written brief, and it stays open until its evidence reads back live. A duty loop keeps silent lanes moving. A merge gate stands between the work and `main`.

Two programs ship here. The harness is `dori-harness` in win-dori (upstream calls it `dori`), and Dori mode's messenger CLI is `dori`, so both can live on one machine. Wherever upstream's text says `dori up` or `dori merge`, win-dori runs `dori-harness up` and `dori-harness merge`.

| Piece | What it is | Reach for it when |
|---|---|---|
| The harness (`src/`, `prompts/`) | lead, lanes, duty loop, hourly loop, review and merge gate | you want the whole loop on one machine |
| Dori mode (`skills/dori-mode`) | the messenger CLI: send, receive, presence, done protocol | you want to talk to it from chat |

## What you get

| You get | What it means | Where it lives |
|---|---|---|
| Parallel work, not a queue | every job opens its own tab and its own agent session; several run at once | `dori-harness start`, `src/lanes.ts` |
| A done that has to prove itself | a lane ends with `dori-harness ready --evidence <link>`, and the lead closes it only after that link reads back | `ready()` in `src/lanes.ts`, `prompts/lane-footer.md` |
| No interrupted sessions | a message to a working pane is queued and delivered as one batch when the pane goes idle | `src/inbox.ts` |
| Silence gets noticed | a nudge at 10 and 20 minutes, an escalation to the lead at 40 | `NUDGE_MINUTES` in `src/duty.ts` |
| It finds the next task itself | the hourly loop pulls from a backlog, respects lane and host limits, and asks you only for decisions | `src/loop.ts`, [docs/hourly-loop.md](docs/hourly-loop.md) |
| Status that stays in one place | one message per job, edited in place instead of re-posted | `edit` in `skills/dori-mode/scripts/src/messenger/` |
| One voice | lanes and the duty session never talk to you; everything reaches the lead | `prompts/lead.md`, `prompts/duty.md` |
| Replies the way you write | no emojis in what it writes, short messages, the language of the thread | `skills/dori-mode/SKILL.md` |

![architecture](docs/architecture.png)

## Talk to it from your chat

This repository implements three channels. Each one posts, edits a message in place, and threads a reply.

| Channel | Send and edit | Receive | Show as online | What you set |
|---|---|---|---|---|
| Slack | post, reply in a thread, edit in place | threads view, threads you posted in, DMs and mentions | yes, with a user token | `DORI_SLACK_TOKEN`, plus `DORI_SLACK_COOKIE` for a user token |
| Telegram | post, reply into a forum topic, edit in place | owner DMs, one group topic, edits, media file ids | not applicable to a bot | `DORI_TELEGRAM_TOKEN`, `DORI_TELEGRAM_OWNER_ID`, optionally `DORI_TELEGRAM_GROUP_ID` and `DORI_TELEGRAM_TOPIC_ID` |
| Discord | post, post into a thread, edit in place | not in this repository | yes, a gateway connection | `DORI_DISCORD_TOKEN` |

### Slack

A user token acts as a real member: it needs a paid seat, it sees everything that member sees, and `dori presence slack` can hold the green dot. A bot token costs no seat, sees only channels it was invited to, and shows as an app. Pick one and record it, because it decides what onboarding can read.

```powershell
$env:DORI_SLACK_TOKEN = "xoxp-..."
$env:DORI_SLACK_COOKIE = "..."          # the `d` cookie, user token only

dori send slack --to C0123456789 --text "PR #12 is green" --thread 1712345678.123456
dori send slack --to C0123456789 --edit 1712345678.123456 --text "PR #12 merged"
dori inbound slack --loop 1           # INBOUND lines, one per new message
dori presence slack                   # user token: stay shown as online
```

An untagged reply under a thread Dori started still arrives. Inbound reads Slack's threads view, every thread Dori posted in (recorded in `<stateDir>/slack-threads.json`), and unread DMs, group DMs and mentions.

### Telegram

```powershell
$env:DORI_TELEGRAM_TOKEN = "..."
$env:DORI_TELEGRAM_OWNER_ID = "123456789"      # only this account is a request
$env:DORI_TELEGRAM_GROUP_ID = "-1001234567890" # optional: one group
$env:DORI_TELEGRAM_TOPIC_ID = "42"             # optional: one forum topic inside it

dori send telegram --to -1001234567890 --thread 42 --text "PR #12 is green"
dori inbound telegram --loop 1
```

Inbound is owner-gated: DMs from the configured owner always pass; in a group, only the configured topic does; bot messages never do. Edits arrive as their own message. A voice note, photo or document arrives as a line carrying its `file_id`, which you hand to Telegram's `getFile`; `dori transcribe <file>` then turns downloaded audio into text through `hooks.transcribe`.

### Discord

```powershell
$env:DORI_DISCORD_TOKEN = "..."

dori send discord --to 123456789012345678 --text "PR #12 is green"
dori presence discord                 # stay shown as online on the gateway
```

Outbound works, including posting into a thread you pass as `--thread`. Receiving is the gap: `dori inbound` accepts `slack` or `telegram` only, and the Discord gateway connection in this repository identifies and heartbeats without dispatching an inbound message. `references/setup.md` has the Dori install agent-messenger for the platform side and read your platform's current API for the rest.

### Also in the library, not on a command

Each messenger module is a typed class you can import, and it does more than the CLI exposes:

- Slack file upload (upload URL, then complete) at `skills/dori-mode/scripts/src/messenger/slack.ts`.
- Telegram forum topics (create, rename, close, reopen), draft streaming with a `Thinking…` start, and HTML tables at `skills/dori-mode/scripts/src/messenger/telegram.ts`.
- Discord thread create, rename and archive at `skills/dori-mode/scripts/src/messenger/discord.ts`.

The full module list is in [skills/dori-mode/references/scripts.md](skills/dori-mode/references/scripts.md).

### No other channels

This repository has no Teams, WhatsApp, LINE, WeChat, iMessage, KakaoTalk or Lark support, and `dori send` refuses a channel it does not know. Sisyphus Labs publishes a wider platform list for its hosted product, with the same footnote this README keeps: the shipped Dori mode covers Telegram, Discord and Slack.

## Install

You need [Bun](https://bun.sh) 1.4.4 or newer, git, [herdr](https://herdr.dev) or herdr-core `hc` (see [Runtimes](#runtimes)), [omo](https://github.com/code-yeongyu/oh-my-openagent) (the coding agent that runs in the panes), and the GitHub CLI `gh` for review, checks and the merge.

### Windows

In PowerShell, from any folder:

```powershell
irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex
```

From a checkout you can also run `install.cmd` in cmd.exe; it calls `install.ps1` with the same arguments.

That one line is the whole install. It needs git (if it's missing and winget is there, it installs `Git.Git`) and installs bun and herdr with their official installers when they're missing (`DORI_NO_DEPS=1` turns that off). It installs into `%USERPROFILE%\.dori\src`, and running it again updates that copy (`DORI_NO_PULL=1` skips the pull). It links the skill into `%USERPROFILE%\.agents\skills\dori-mode` as a directory junction, so you don't need admin rights or developer mode, runs `bun install` and `bun link`, and adds bun's global bin folder to your user PATH. Then it places the Windows profile from `profile/`. `DORI_SKIP_PROFILE=1` skips that and copies the example config to `%USERPROFILE%\.dori\config.json` instead. `DORI_SRC`, `SKILLS_DIR` and `DORI_HOME` change those places, and `DORI_REPO` points it at a fork. Open a new terminal afterwards so the PATH change takes effect.

Then open herdr, start omo in it and say "Dori mode".

### Windows profile

The profile keeps the Dori running across reboots, whichever messenger you pick: a boot script, a config, an autostart task, and for Slack a Socket Mode inbound listener with its channel rules and app manifest. Nothing in it names a user, a folder or a channel; every path comes from `%USERPROFILE%` and every id from your own tokens.

The first time you say "Dori mode", the Dori sets itself up in conversation. It asks for the messenger, opens a Notepad file only you can read for the tokens (never paste a token into the chat), and `dori setup <messenger>` checks them, works out the ids it can, saves `%USERPROFILE%\.dori\<messenger>.env` (`slack.env`, `telegram.env` or `discord.env`) readable only by your Windows user, and registers the `Dori Autostart` task. From then on, logging on starts herdr, opens a workspace named after your Dori and starts the agent there.

The Slack listener marks each message it picks up with an eyes reaction and a working status in the thread, and swaps the eyes for a check mark when the Dori replies.

Rerunning the profile step is safe. Files you edited are kept and the difference is shown; `config.json` is only created, never replaced. `DORI_DRY_RUN=1` previews the profile step, `DORI_FORCE=1` replaces edited files and keeps a `.bak-<time>` copy, `DORI_NO_TASK=1` never registers the task, and every run writes `%USERPROFILE%\.dori\undo-profile-<time>.ps1`, which reverses it. [profile/INVENTORY.md](profile/INVENTORY.md) lists every piece, and `profile\install-profile.ps1 -DryRun` from the checkout runs the profile step alone.

### Runtimes

Lanes run in herdr or in herdr-core `hc`. The choice goes, first match wins: `DORI_RUNTIME`, then the `runtime` key in `config.json`, then `HC_TERMINAL_ID` (you're inside hc), then `HERDR_PANE_ID` (you're inside herdr), then whichever one of the two binaries is on PATH. With only herdr on PATH, herdr is the default. On Windows, install hc with herdr-core's official installer.

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/win-dori/main/install.sh | bash
```

It clones the repo to `~/.dori/src`, links the skill into `~/.agents/skills/dori-mode`, puts `dori` on your PATH and copies the example config to `~/.dori/config.json`.

### The harness from a checkout

```powershell
git clone https://github.com/useonmn/win-dori
cd win-dori
bun install
bun link        # puts `dori-harness` on your PATH; without it, use `bun src/cli.ts`
```

Then set at least `leadPane` (from `herdr pane current`), `laneWorkspace` and `defaultCwd` in `~/.dori/config.json`.

### Windows notes

- Tokens live in `~/.dori/<messenger>.env`, never in your user environment. `dori` loads that file itself (or the one in `DORI_ENV_FILE`). For a one-off shell, set them with `$env:DORI_SLACK_TOKEN = "xoxp-..."` as in the examples above.
- The harness types commands into panes, so it probes each pane's shell and quotes for it: pwsh, Windows PowerShell 5.1, cmd or Git Bash. `DORI_PANE_SHELL` (`posix`, `pwsh`, `powershell` or `cmd`) overrides the probe.
- The host guard reads load, memory, swap and disk through one `powershell.exe` call. Load is CPU use times the CPU count plus the processor queue, so it jumps around more than the Unix 1-minute average.
- `Done =` commands are argv lists, like `["bun","test"]`, so the same line works on Windows, macOS and Linux.

## Quickstart

Start herdr's server, then bring the harness up:

```sh
dori-harness up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

A herdr workspace named `dori` opens with the lead in it, an omo session that gets `prompts/lead.md` appended to its system prompt, and the duty session, the duty loop and the hourly loop under it. Talk to the lead. It writes a brief (goal, inputs, deliverable, stop condition, constraints; see [examples/brief.md](examples/brief.md)) and opens lanes itself, or you open one from the shell:

```sh
dori-harness start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md

dori-harness status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login         working  w1:p5    active 0m ago  start: examples/brief.md
```

A lane key matches `^[a-z][a-z0-9-]{1,40}$`, and a key that is already open is refused. Inside the lane, the agent reports and finishes with the commands the lane rules hand it:

```sh
dori-harness report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori-harness report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori-harness ready fix-flaky-login --text 'root cause fixed, checks green' --evidence https://github.com/owner/repo/pull/12
# READY fix-flaky-login
```

The lead reads `[READY fix-flaky-login]` in its pane and runs the gate itself:

```sh
dori-harness review owner/repo#12             # a fresh omo reviewer pinned to the head; writes a receipt
dori-harness merge owner/repo#12 --dry-run    # MERGE_OK owner/repo#12 head=<sha> (dry run), or MERGE_REFUSED <why>
dori-harness merge owner/repo#12              # gh pr merge --squash --match-head-commit <sha>
dori-harness done fix-flaky-login             # closes the lane's tab; only a READY lane can be closed
```

`dori-harness send <lead|duty|key|pane> --text '...'` delivers to a pane or queues while it is busy. `--text` can be left off to read from stdin. The commands the agents receive are rendered with the full path to `src/cli.ts` and `DORI_HOME` set, so the agents never depend on which `dori` is on your PATH.

## How it works

![lane lifecycle](docs/lane-flow.png)

The lead is the only session that talks to you. It turns a request into a brief, opens a lane, reads what lanes send back, and merges.

A lane is one agent session in its own tab, started with one brief and the lane rules appended to it (`prompts/lane-footer.md`). It reports milestones with `dori-harness report` and finishes with `dori-harness ready`, which refuses to go out without an evidence link. Everything a lane does reaches the lead as one line: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

The duty loop is `dori-harness duty --interval 60`, a plain process next to a duty session. Each tick it flushes queued messages into panes that went idle, nudges lanes that have been silent, escalates to the lead, and marks a lane whose pane vanished as lost.

The hourly loop is `dori-harness loop`. Once an hour it syncs the backlog against reality, audits missed work, starts the next item that needs nobody's decision, asks each open question once, and sends one report. It never merges, never pushes and never closes a pane.

State is JSON on disk under `~/.dori` (or `$DORI_HOME`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, plus `backlog/` and `loop/` for the hourly loop and `duty/` for its stop file. The only long-running processes the harness adds are those two loops, and the only runtime dependency is Bun.

### The merge gate

`dori-harness merge` reads the PR's head SHA with `gh` and refuses for a named reason:

| Refusal | Meaning |
|---|---|
| `no_receipt` | no CLEAR review receipt for this exact head |
| `review_block` | the receipt at this head says BLOCK |
| `no_checks` | the check list is empty, and an empty list is never green |
| `checks_red` | a check failed |
| `checks_all_skipped` | every check was skipped, so nothing passed |

`dori-harness review` writes those receipts and nothing else does. It runs a fresh non-interactive omo on `prompts/review.md` pinned to the head, and a reviewer that prints no `VERDICT:` line writes no receipt. A push after the review moves the head, so the old receipt no longer applies.

`hooks.reviewCommand` in `~/.dori/config.json` replaces the built-in reviewer with your own command, which must print the same `VERDICT:` line.

## Command reference

The harness, `src/cli.ts`:

| Command | Does |
|---|---|
| `dori-harness up [--cwd DIR]` | open the lead, duty, duty loop and hourly loop panes |
| `dori-harness start <key> --brief FILE [--cwd DIR]` | open a lane: new tab, agent session, brief plus lane rules |
| `dori-harness report <key> --text T [--status working\|waiting]` | a lane records a milestone or a wait |
| `dori-harness ready <key> --text T --evidence LINK` | a lane finishes; refuses without evidence |
| `dori-harness review <owner/repo#N> [--model M]` | fresh reviewer at the exact head, writes a receipt |
| `dori-harness merge <owner/repo#N> [--dry-run]` | CLEAR receipt plus green checks, then a squash merge |
| `dori-harness done <key>` | the lead closes a READY lane |
| `dori-harness status` | roles and every open lane |
| `dori-harness duty [--once] \| stop \| resume \| status` | the duty loop and its kill switch |
| `dori-harness loop [--once] \| stop \| resume \| status` | the hourly loop and its kill switch |
| `dori-harness backlog add \| list \| decide \| drop \| import` | the queue the hourly loop pulls from |
| `dori-harness send <target> --text T` and `dori-harness inbox list\|ack\|resend` | deliver, queue, and resolve a held delivery |
| `dori-harness role <lead\|duty> [PANE]` | register a pane when you did not use `dori-harness up` |

`bun src/cli.ts` with no arguments prints the same list with every flag.

Dori mode, `skills/dori-mode/scripts/src/cli.ts`:

| Command | Does |
|---|---|
| `dori launch <key> --title T --brief FILE --done "..."` | open a lane, with optional wall, token and cost ceilings |
| `dori claim-done` and `dori object-done` | the 5-minute done flow |
| `dori close <key>` | closes a lane whose `Done =` signals read back live |
| `dori sync` / `dori boot` | registry against live panes; the read-only check after a restart |
| `dori freshness` / `dori dead-panes` / `dori guard` / `dori heavy` | nudge, detect, watch host load, gate heavy commands |
| `dori send` / `dori inbound` / `dori presence` / `dori transcribe` | the messenger commands above |
| `dori worklog` / `dori lesson` / `dori checkpoint` | the lead's record of requests, lessons per repo, completed steps |

`dori launch --dry-run` prints the brief as the lane would receive it.

## Extend it

Lifecycle hooks in `~/.dori/config.json` call your own program on a transition, as an argv array with `{key}`, `{text}`, `{evidence}`, `{repo}`, `{number}` and `{sha}` filled per argument, never through a shell:

| Hook | Fires on |
|---|---|
| `hooks.onReady` | a lane finishes with evidence |
| `hooks.onReport` | a lane reports |
| `hooks.onLost` | a lane's pane disappears |
| `hooks.reviewCommand` | replaces the built-in reviewer |

A hook that hangs cannot hold a command open: the CLI waits at most two seconds for hooks still running and says so. `DORI_PROMPTS_DIR` swaps the four prompt files for your own, `DORI_AGENT_CMD` swaps `omo` for another agent binary, and `DORI_HOME` moves the state directory.

## Run it in a container

[examples/container](examples/container) builds an Ubuntu image with gh, node, bun, herdr, omo and the harness pinned, one `dori` service, and named volumes for every piece of state. There is no published image: you build it locally and log in once inside it. [docs/container.md](docs/container.md) covers the build, the volumes that survive a restart, and the sizing.

## Tests

```sh
bun run test        # 275 tests in ./test/
bun run test:skill  # 308 tests in skills/dori-mode/scripts
bun run ci          # Biome, tsc, knip, the 250-line ratchet, then both suites
```

Neither suite needs a model or the network: the harness runs against a fake herdr and a fake `gh`, and Dori mode against fake herdr, git and `gh`. Two end-to-end tests start a real herdr server and skip themselves when `herdr` is not on PATH.

The Windows profile has its own tests (Windows only): `cd profile; bun test`. `bun scripts/check-paths.ts` fails when a tracked file holds a hard-coded user path or a personal value.

## Telemetry

`dori` sends anonymous usage counts the way omo does: OTLP/HTTP JSON to `https://t.omo.dev`, with a random install id kept in `~/.dori/telemetry.json` and only its sha256 sent. What leaves the machine is counts and fixed enums: installed, daily active, lane started, lane ready, review completed, merge decided, and one hourly duty summary. Never sent: paths, repo names, PR numbers, lane keys, briefs, messages or any other text. Turn it off with `DORI_TELEMETRY=0` (`DO_NOT_TRACK=1` also works), and point it elsewhere with `DORI_TELEMETRY_ENDPOINT`. Telemetry never makes a command fail.

## Contributing

Every contributor signs the [Contributor License Agreement](https://github.com/sisyphuslabs/dori-superagent/blob/main/CLA.md) once, before a pull request of theirs is reviewed or merged, by commenting `I have read the CLA Document and I hereby sign the CLA`. The gates, the test commands and the pull request rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Since the port of upstream [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444), win-dori is under the [Sustainable Use License](LICENSE) version 1.0, like upstream, with third-party components under their own licenses. It allows personal use, internal business use and free non-commercial use; commercial use needs a license from the owner, Sisyphus Labs. [NOTICE.md](NOTICE.md) states what win-dori modified. win-dori versions up to `fa86ddf` were MIT and stay MIT. The prompts in `prompts/` are the instructions the agents actually receive, and they are short enough to read before you trust them.
