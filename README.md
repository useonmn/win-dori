**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# win-dori

> **win-dori is a Windows port of [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent).** It is based on upstream commit [181df3e](https://github.com/sisyphuslabs/dori-superagent/commit/181df3e) and keeps upstream's behaviour and defaults. What it adds is what Windows needs: the PowerShell install, shell-aware panes, and a Windows profile with autostart and a Slack listener. Credit for Dori mode and the harness goes to the upstream authors; bugs in the Windows parts are ours. The license keeps the original copyright notice.

Dori mode turns one coding-agent session into an always-on messenger agent. You talk to a single bot on Slack, Telegram or Discord. The Dori hands each job to its own agent session in a herdr tab, keeps track of every session it started, and only closes one after the work is actually done: the PR merged, the issue closed, the version published.

It ships as a skill (`skills/dori-mode/SKILL.md` plus references) and a small bun + TypeScript CLI called `dori`. Experimental: expect rough edges.

## Install

### Windows

In PowerShell, from any folder:

```powershell
irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex
```

That one line is the whole install. It needs git (if it's missing and winget is there, it installs `Git.Git`), and installs bun and herdr with their official installers when they're missing (`DORI_NO_DEPS=1` turns that off). It installs into `%USERPROFILE%\.dori\src`, so there is nothing to clone or `cd` into first, and running it again updates that copy. It links the skill into `%USERPROFILE%\.agents\skills\dori-mode` as a directory junction, so you don't need admin rights or developer mode. It runs `bun install` and `bun link`, and adds bun's global bin folder to your user PATH if it's missing. Then it places the Windows profile from `profile/` (see [Windows profile](#windows-profile)). `DORI_SKIP_PROFILE=1` skips that and copies the example config to `%USERPROFILE%\.dori\config.json` instead. `DORI_SRC`, `SKILLS_DIR` and `DORI_HOME` change those places, and `DORI_REPO` points it at a fork (an `owner/name`, a clone URL or a local path; a private fork is cloned with your `gh` login). Open a new terminal afterwards so the PATH change takes effect.

Then install [omo](https://github.com/code-yeongyu/oh-my-openagent) (or another agent that loads skills) and log in to it, open herdr, start the agent in it and say "Dori mode".

### Windows profile

On Windows the install also places a ready-made setup that keeps the Dori running across reboots, whichever messenger you pick (Slack, Telegram or Discord): a boot script, a config, an autostart task, and for Slack a Socket Mode listener with its channel rules and app manifest. Nothing in it names a user, a folder or a channel; every path comes from `%USERPROFILE%` and every id from your own tokens.

The Slack listener shows when a message has been picked up. It adds an eyes reaction, sets the thread's working status (`작업 중...` by default, `DORI_WORKING_STATUS` changes it) and refreshes that status while the work runs. When the Dori replies, the eyes turn into a check mark. Messages caught up after a restart get the same treatment.

When you say "Dori mode" the first time, the Dori sets itself up in conversation:

- it asks which messenger you want: Slack, Telegram or Discord (none is preferred; the flow is the same);
- if the Aside browser is installed and signed in, it asks whether you make the bot and its tokens or it does; otherwise it walks you through making them (the Slack app manifest is `%USERPROFILE%\.dori\slack-manifest.json`);
- it opens a Notepad file only you can read; paste the tokens there (for Slack, `xoxb-` and `xapp-`), save and tell it. Never paste a token into the chat: the chat is stored and cannot be masked afterwards;
- `dori setup <messenger>` checks the tokens with that platform, works out the ids it can (Slack: app id, bot user, home channel, your member id; Telegram: the bot and your chat id; Discord: the bot user, application id and you) and asks you for the ones it cannot, saves `%USERPROFILE%\.dori\<messenger>.env` (`slack.env`, `telegram.env` or `discord.env`) so only your Windows user can read it, deletes the Notepad file, registers the `Dori Autostart` task and the Dori starts listening on that messenger.

From then on, logging on starts the Dori: the autostart task opens herdr, makes a workspace named after your Dori, writes its ids into `config.json` and starts the agent there with `agentCommand` and `defaultModel` from `config.json`. The name comes from `DORI_NAME`, else `name` in `config.json`, else `Dori`; it also names the task (`<name> Autostart`). The boot script picks the messenger from the env file that holds a token (`DORI_MESSENGER` overrides it). To type the values in the terminal instead, run the install with `$env:DORI_ASK_SECRETS = '1'` set (it asks which messenger, or set `$env:DORI_MESSENGER = 'telegram'`).

What the profile step does:

- Installs `agent-messenger` (the messenger library for Slack, Telegram and Discord) as a bun global package.
- Copies `profile/dori/` into `%USERPROFILE%\.dori`. A file you edited since the last install is kept and the difference is shown; `config.json` is only created, never replaced. `DORI_DRY_RUN=1` shows what the profile step would change and changes none of it (the CLI update above still runs; for a pure preview run `profile\install-profile.ps1 -DryRun` from `%USERPROFILE%\.dori\src`); `DORI_FORCE=1` replaces edited files and keeps a `.bak-<time>` copy.
- Keeps secrets only in `slack.env`, `telegram.env` or `discord.env`. It never writes them to your user environment variables, which every program you start would inherit; `dori` and the listener read the files themselves.
- Registers the autostart task (at logon, 30 s delay) only once one messenger's env file is complete: `dori setup <messenger>` does it after saving the tokens, so a Dori without tokens is never started at logon. `DORI_NO_TASK=1` never registers it.
- Prints what it did, and writes `%USERPROFILE%\.dori\undo-profile-<time>.ps1`, which reverses that run.

Running it again is safe: unchanged files are skipped, `slack.env` is left alone, and an identical task is left alone. `profile/INVENTORY.md` lists every piece of the setup and how it is handled.

Not covered: omo itself, its login and its memory store (the notes the Dori reads at boot live there). `briefs/`, `out/` and `state/` in `.dori` are working data and are not kept either.

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/win-dori/main/install.sh | bash
```

This clones the repo to `~/.dori/src`, links the skill into `~/.agents/skills/dori-mode`, puts `dori` on your PATH with `bun link`, and copies an example config to `~/.dori/config.json`. Like the Windows install, it installs bun and herdr when they're missing (`DORI_NO_DEPS=1` turns that off). Rerunning either installer updates the existing copy with `git pull`; `DORI_NO_PULL=1` (also `true` or `yes`) skips that, in PowerShell `$env:DORI_NO_PULL='1'`. Set `SKILLS_DIR` if your agent loads skills from somewhere else.

Then open your agent inside herdr and say "Dori mode".

## The superagent harness

The repo also carries the harness from [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent), ported to run on Windows, macOS and Linux with upstream's behaviour and defaults. Its command is `dori-harness`. The text in this section comes from upstream's README, so "we" and "our" mean the upstream team.

One lead session talks to you. Each task runs as a lane: its own omo session in its own herdr tab, started from a written brief and finished with a READY that must carry evidence. A duty loop nudges lanes that go quiet, escalates to the lead, and holds messages for busy panes until they can read them. Merges pass through a gate that requires a CLEAR review receipt at the exact head plus green checks.

### Why this exists

DeepSeek published [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (first commit 2026-10-31) and, about a day later, the article "Exploring Super-agent Design: Towards a More Autonomous Agent System". Their design has a long-lived Router session that only talks to humans and dispatches work, isolated Worker sessions with one per ticket, event triggers batched per turn, and a watchdog. Their README calls it a research prototype, and its stated philosophy is to "take as little human attention as possible, and give as much value as possible".

We have been running the same shape for about six months, in public:

- 2026-04-18: team mode lands in omo, several agent sessions in terminal panes with a worktree each ([f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0), [e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)).
- 2026-05-06: the Dori name enters the omo README ([#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)).
- 2026-10-07: this repository publishes Dori mode, as `omo-dori-mode-experimental` ([ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)): one agent hands each job to its own agent session in a herdr tab and closes it only after the work is done. The git history is public.
- 2026-10-31: DeepSeek's prototype gets its first commit.
- Around 2026-11-01: DeepSeek's article.

It is how we work every day. omo has 70k+ stars. Over the 31 days from 2026-10-03 to 2026-11-02, the [author's GitHub contribution calendar](https://github.com/code-yeongyu) shows 38,656 contributions: about 1,250 a day on average, with peaks of 2,227 on 2026-10-16 and 2,001 on 2026-10-29. That is up to ~2,000 contributions a day, produced with the full version of this setup.

The harness at the root of this repo is the minimal version: the part that runs on herdr and omo alone, with nothing else attached.

### Same structure, same philosophy

Put DeepSeek's prototype docs next to Dori and the concepts line up one for one, in the structure of the pipeline and in the rules of their [philosophy doc](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md).

![Dori vs DeepSeek](docs/dori-vs-deepseek.en.png)

#### Structure

| DeepSeek dsh-superagent | Dori |
|---|---|
| Source: GitHub, Feishu | Dori lives in chat: Slack, Discord, Telegram |
| Trigger, then Eval, then Ticket | One task asked in chat becomes one ticket |
| Executor session per ticket: one session, one work directory | One coding-agent session per task, run on omo, many in parallel |
| Channel: answers in the original conversation, with a PR for example | Reports in the same channel, one status message per task, edited in place |
| Panel: shows only what needs a person | The ticket board and Notion stay current on their own |

#### Philosophy

| DeepSeek dsh-superagent | Dori |
|---|---|
| Least human attention, most value | Short messages, no emojis, a ping only after the merge |
| Acts only when asked or when a written team rule allows it | People set direction and bring new ideas; Dori starts no work nobody asked for |
| Speaks only when a person must act, one question at a time | A decision comes with options, its own recommendation and one picture |
| Reports honestly, never works around a block | No "done" without proof; checked against a real case, and the report is the merged result |

The Dori column is our production Dori and Dori mode (`skills/dori-mode`). The harness at the root of this repo implements its lane, inbox, duty and merge-gate part on herdr and omo.

### Architecture

![architecture](docs/architecture.png)

Three roles, each an omo session in a herdr pane. herdr provides the workspaces, tabs and panes, recognises omo in a pane as an agent, and reports its state (idle, working, blocked, done) over its CLI. The harness reads that state before it does anything to a pane.

The lead is the only session that talks to you. It turns a request into a brief, opens a lane with `dori-harness start`, reads what lanes send back, and merges.

A lane is one omo session in its own herdr tab, started with one brief and the lane rules appended to it (`prompts/lane-footer.md`). It reports milestones with `dori-harness report` and finishes with `dori-harness ready`, which refuses to go out without an evidence link.

The duty loop is `dori-harness duty --interval 60`, a plain process in a pane next to a duty omo session. Each tick it flushes queued messages into panes that have gone idle, nudges lanes that have been silent, escalates to the lead, and marks a lane whose pane vanished as lost. `dori-harness duty stop --text "why"` is its kill switch: until `dori-harness duty resume`, every tick only prints `DUTY stopped: <why>` and skips all duty work (no flushes, nudges, escalations or duty counts), and queued messages wait in the inbox. `dori-harness duty status` says whether it is stopped and why.

State is JSON on disk under `~/.dori` (or `$DORI_HOME`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, plus `backlog/` and `loop/` for the hourly loop and `duty/` for the duty loop's stop file. Besides the agent sessions, the only long-running processes the harness adds are the duty loop and the hourly loop, and the only runtime dependency is Bun.

![lane lifecycle](docs/lane-flow.png)

`dori-harness start <key> --brief FILE` writes the brief plus the lane rules to `~/.dori/briefs/<key>.md`, opens a tab, runs `omo 'Read your brief at <path> and execute it. Your lane key is <key>.'`, records the lane as `working`, and sends the lead `[START <key>]`. From there the lane reports (`[REPORT <key>]`, or `[REPORT <key> WAITING]` when it is blocked outside its own pane) and ends with `[READY <key>]` plus its evidence links. The lead checks the evidence, runs `dori-harness review` and `dori-harness merge` when there is a PR, and closes the lane with `dori-harness done <key>`. A lane that stays idle gets a nudge at 10 and 20 minutes and is escalated to the lead at 40 (`[ESCALATE <key>]`). A lane whose pane disappears before READY is reported as `[LOST <key>]`.

### Mapping to DeepSeek's super-agent

| DeepSeek super-agent | windori harness | In this repo |
|---|---|---|
| Router session: talks to humans, dispatches | LEAD session: the only one that talks to the human; opens lanes, merges | `prompts/lead.md`, `up()` in `src/cli.ts` |
| Worker session, one per ticket | LANE: one omo session per task in its own herdr tab, with its own brief | `startLane()` in `src/harness.ts`, `prompts/lane-footer.md` |
| Ticket + Mandate | brief file + lane rules footer, and a READY that must carry evidence | `~/.dori/briefs/<key>.md`, `ready()` in `src/harness.ts` |
| Trigger batching: events batched per turn | pane inbox: messages to a busy pane queue and arrive as one batch when it goes idle | `send()`, `flushInbox()` in `src/harness.ts`; `inbox/` in `src/store.ts` |
| Watchdog | DUTY loop: flushes inboxes, nudges at 10/20 minutes, escalates at 40, detects lost panes | `dutyTick()` in `src/harness.ts`, `prompts/duty.md`, `prompts/nudge.md` |
| Admission matrix, `maxWorkers` (default 3) | hourly loop budget: at most `--max-lanes` (default 3) open lanes, `--max-starts` (default 2) per run, no starts on a loaded host | `loopTick()` in `src/loop.ts` |
| not in the prototype | gated merge: CLEAR review receipt at the exact head SHA plus green checks; an empty check list is never green | `review()`, `mergeGate()` in `src/harness.ts`, `prompts/review.md`, `receipts/` in `src/store.ts` |
| not in the prototype | one-voice rule: lanes and duty never talk to the human | `prompts/lead.md`, `prompts/duty.md`, `prompts/lane-footer.md` |
| not in the prototype | full-text answer ledger: each lane's final answer, evidence links and log kept on disk | `Lane.final`, `Lane.log` in `src/store.ts` |

### Quick start

You need Bun 1.3 or newer, herdr, omo, and the GitHub CLI `gh` (used for PR head SHAs, checks and the merge). The install above already links `dori-harness`. From a checkout of this repo, do it yourself:

```sh
bun install
bun link   # puts `dori-harness` on your PATH; or write `bun src/cli.ts` wherever `dori-harness` appears below
```

Upstream calls this command `dori`. Here that name belongs to Dori mode, so the harness is `dori-harness`.

Start herdr, then from a shell:

```sh
dori-harness up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

That opens a herdr workspace named `dori` with a lead pane (omo with `prompts/lead.md` appended to its system prompt), a duty pane (omo with `prompts/duty.md`), the duty loop below it, and the hourly loop below that. Talk to the lead pane. It writes a brief (goal, inputs, deliverable, stop condition, constraints; see [`examples/brief.md`](examples/brief.md)) and opens lanes itself, and you can do the same from the shell:

```sh
dori-harness start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md
dori-harness status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login          working  w1:p5    active 0m ago  start: examples/brief.md
```

A lane key matches `^[a-z][a-z0-9-]{1,40}$`, and a key that is already open is refused.

Inside a lane, omo reports and finishes with the commands the lane rules hand it:

```sh
dori-harness report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori-harness report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori-harness ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

The lead, on `[READY fix-flaky-login]`:

```sh
dori-harness review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori-harness merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori-harness merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori-harness done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

`dori-harness send <lead|duty|key|pane> --text '...'` delivers a message to a pane, or queues it when the pane is busy. `dori-harness role <lead|duty> [PANE]` registers a pane by hand when you did not use `dori-harness up`. `--text` can be left off to read the message from stdin. The commands the agents see are rendered with the full path to `src/cli.ts`, so `dori-harness` does not need to be on their PATH. Environment: `DORI_HOME` (state directory, default `~/.dori`), `DORI_AGENT_CMD` (default `omo`), `DORI_HERDR_SESSION` (a named herdr session), `DORI_CMD` (how the agents are told to call dori).

### Windows panes

The harness types commands into panes, so it probes each new pane's own shell and quotes for it: pwsh, Windows PowerShell 5.1, cmd or Git Bash. `DORI_PANE_SHELL` (`posix`, `pwsh`, `powershell` or `cmd`) overrides the probe. In a cmd pane the agent line runs through PowerShell 5.1, so a `.ps1` agent shim is subject to its execution policy. A checkout path containing `$`, a backtick, `%` or `"` has no form that's valid in all four shells; set `DORI_CMD` if yours has one.

### What the harness enforces

One voice. The lead is the only session that talks to you (`prompts/lead.md`). The lane rules say every fact meant for the human goes to the lead (`prompts/lane-footer.md`, rule 3), and the duty session never merges and never talks to the human (`prompts/duty.md`). Everything a lane does reaches the lead pane as a prompt: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

READY needs evidence. `dori-harness ready` refuses without at least one `--evidence` link and without final answer text (`ready()` in `src/harness.ts`). The text and links are stored on the lane record as `final`, and `dori-harness done` refuses any lane that is not `ready`, so no lane closes without a recorded answer.

Busy panes are never interrupted. `dori-harness send` asks herdr for the pane's agent state first. `idle` or `done` get the message now; anything else has it queued in `~/.dori/inbox/`, and the command prints `QUEUED`. A pane with no running agent in front (the agent exited and left its shell (pwsh, powershell, cmd or bash) at the prompt; on macOS and Linux also an agent suspended with Ctrl+Z) is never typed into, because text typed into a shell runs as a command: its messages stay queued, and the duty loop prints `inbox-held` until an agent is back in the pane. To type into a plain shell on purpose, the operator passes `--to-shell`: it applies to that one message only and never to queued ones. On Windows herdr's process-info lists only the pane's own shell, so there the harness decides from herdr's agent status, and `--to-shell` types each line with its own Enter. The duty loop delivers the queue when the pane goes idle, as a single message that starts with "N messages arrived while you were busy" (`send()` and `flushInbox()` in `src/harness.ts`). `dori-harness done` waits the same way: it refuses to close a pane that herdr reports as working or blocked.

A message whose delivery failed after it may already have reached the pane is never sent twice. When the text was typed but its Enter failed, only Enter is pressed later, and only into the agent it was typed into: the inbox records the agent name from `herdr pane get` and the foreground process group from `herdr pane process-info` (`pane get`'s `revision` stays the same across an agent restart, so it is not used). On Windows the shell pid in process-info doesn't change, so this check relies on the agent name. If herdr then sees no agent in the pane, or a different one, the entry is held instead. A held entry is never resent, the lead is told once with `[DELIVERY-AMBIGUOUS <pane>]`, and `dori-harness send` prints `HELD` and exits 3. `dori-harness inbox list <pane|role|key>` shows a pane's entries with an index, state (`queued`, `typed` or `held`), sender, queued time and at most the first 60 characters of the text, JSON-escaped. After checking the pane, `dori-harness inbox ack <pane> <index>` drops a held entry that did arrive, and `dori-harness inbox resend <pane> <index>` releases one that did not, so the next flush delivers it. A pane that is gone is reported as `inbox-target-gone` even when all its entries are held. Only one flush runs per pane at a time, across processes: `flushInbox()` takes a lock file next to the pane's inbox (created exclusively, with pid, host and time), and a second flush, from a CLI `send` during a duty tick for example, returns `queued` without delivering. On this host a lock is taken over only when its pid is dead, so a live flush keeps it however long herdr takes; a lock from another host, or one that can't be read, is taken over after 60 seconds (`lockInbox()` in `src/store.ts`).

Nudges at 10, 20 and 40 minutes. `NUDGE_MINUTES = [10, 20, 40]` in `src/harness.ts`. A lane that has not reported for 10 minutes, and whose pane is not working, gets `prompts/nudge.md` in its pane. At 20 it gets it again. At 40 the duty loop stops nudging and sends the lead `[ESCALATE <key>]`. A `working` pane resets the idle clock, a lane that reported `--status waiting` or whose pane is `blocked` is left alone, any new report resets the nudge count, and a pane that disappears is reported as `[LOST <key>]`.

Merge needs a CLEAR receipt at the exact head and green checks. `dori-harness merge` reads the PR's head SHA with `gh`, then requires a receipt for that SHA in `~/.dori/receipts/` with verdict `CLEAR`. Only `dori-harness review` writes receipts. It runs a fresh non-interactive omo (`omo -p --no-session`, optionally `--model`) on `prompts/review.md` pinned to that SHA, and when the reviewer prints no `VERDICT:` line, no receipt is written. Then `gh pr checks` must return at least one check, every check must be `pass` or `skipping`, and at least one must be `pass`. An empty check list is refused with "an empty check list is never green". The merge itself is `gh pr merge --squash --match-head-commit <sha>`. A push after the review changes the head SHA, so the receipt no longer matches and the merge is refused (`review()` and `mergeGate()` in `src/harness.ts`).

### Hourly loop

`dori-harness up` also starts `dori-harness loop` in a fourth pane. Once an hour it checks the harness against reality and starts the next piece of work that needs nobody's decision, so the lead does not have to remember what comes next. The full design is in [`docs/hourly-loop.md`](docs/hourly-loop.md).

Work waits in a backlog under `~/.dori/backlog/`, one brief per item. The lead adds items, or you import open GitHub issues that carry a label:

```sh
dori-harness backlog add search-index --brief briefs/search.md --priority 2
dori-harness backlog add new-billing --brief briefs/billing.md --decision 'charge per seat or per workspace?'
dori-harness backlog import owner/repo --label dori     # label p1..p9 sets the priority, needs-decision marks a question
dori-harness backlog list
```

A run first checks its gate: it does nothing while the loop is stopped, while another loop holds the lock, or when the last run was less than an interval ago (one hour by default; `--force` skips this check). A run that passes the gate does five things, in order:

1. Sync. An item whose lane is done, or whose READY PR has merged, becomes done. An item whose lane was lost goes back to the queue, and after two losses it turns into a question. An imported item whose issue was closed is dropped.
2. Missed-work audit. A lane with no report for 3 hours, a READY lane nobody closed for 2 hours, a lane whose pane vanished.
3. Pull. It starts the next open items with no open question, by priority, then age (an item whose start fails twice becomes a question, so it never blocks the rest), within `--max-lanes` (default 3) open lanes and `--max-starts` (default 2) per run. Nothing starts while the load is above the core count (or `--max-load`; on Windows, load is the CPU-and-queue figure from [Requirements](#requirements)) or less than 10% of memory is available (on macOS the kernel's available-memory level, since free pages alone run near zero there).
4. Ask. Each open question reaches the lead once as `[DECIDE <id>]`, with one reminder after 6 hours. The lead asks you, then records the answer with `dori-harness backlog decide <id> --text '...'` (the answer is appended to the item's brief) or `dori-harness backlog drop <id>`.
5. Report. One `[LOOP ...]` message goes to the lead with open lanes against the limit, backlog counts, host load and free memory, and each finding. Every run that passes the gate is also kept in `~/.dori/loop/runs/`.

Besides its own state (backlog items, run records, the lock), the loop only opens lanes and sends messages. It never merges, never pushes, never closes a pane and never edits an open lane's record (retrying a lost item starts a fresh lane under the same key); its `gh` calls only read. `dori-harness loop stop --text "why"` is the kill switch: until `dori-harness loop resume`, every run does nothing. A lock and a last-run stamp keep two loops from running the same hour twice, so `dori-harness loop --once` from cron or Task Scheduler is safe next to the pane. `dori-harness loop status` prints the last run.

### What this is not

A minimal experiment. The harness is a small TypeScript program on Bun with zero runtime dependencies, and it is not our production stack. Left out on purpose: the cross-machine mesh, heavy-slot scheduling, the chat and ticket-tracker bridges, and receipts for whole test suites. What is here is the part that runs on herdr and omo alone: roles, lanes, the inbox, the duty loop, the hourly loop and backlog, and the review and merge gate. Dori mode in `skills/dori-mode` is a separate CLI with its own messenger pieces, host guard and heavy-slot runner; the harness imports nothing from it.

### Telemetry

The harness has telemetry, and it is on by default. It sends anonymous usage counts the same way omo does: OTLP/HTTP JSON logs to the omo collector at `https://t.omo.dev`. The identity is a random install id kept in `~/.dori/telemetry.json`, and only its sha256 is sent. On the first send the collector mints a per-install ingest key from that hash (`POST /v1/register`); the key is cached in `~/.dori/telemetry.json` and minted again after the collector answers 401. No shared key ships in the code. The first run prints a one-line notice. Turn it off with `DORI_TELEMETRY=0` (`DO_NOT_TRACK=1` also works), and point it at another collector with `DORI_TELEMETRY_ENDPOINT`.

| event | when | fields |
|---|---|---|
| `dori.installed` | first run | none |
| `dori.daily_active` | once per UTC day, on any harness command | `day_utc` |
| `dori.lane_started` | `dori-harness start` | `open_lanes` |
| `dori.lane_ready` | `dori-harness ready` | `evidence_count`, `lane_minutes` |
| `dori.review_completed` | `dori-harness review` | `verdict`: `CLEAR` or `BLOCK` |
| `dori.merge_decided` | `dori-harness merge` without `--dry-run` | `outcome`: `merged`, `no_receipt`, `review_block`, `no_checks`, `checks_red`, `checks_all_skipped` |
| `dori.duty_summary` | at most once an hour, from the duty loop | `ticks`, `flushed`, `nudges`, `escalations`, `lost` |

`dori.daily_active` is what gives the daily, weekly and monthly active counts. Actives are counted per install, so the rare second copy from two runs starting at the same moment does not change them. Every record also carries the resource fields: service name and version, the install hash, a CI flag, the OS type (`darwin`, `linux` or `windows`; other systems send nothing) and version, and the CPU architecture. Never sent: paths, repo names, PR numbers, lane keys, briefs, messages or any other text. Sending runs in the background with a 2 second timeout per request; a command waits at most 2 seconds for it before exiting, and a telemetry failure never fails a command.

### State

Harness state is in `DORI_HOME` (default `~/.dori`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, `backlog/`, `loop/`. Dori mode keeps its own in `state/` and `config.json` under the same folder, so the two don't overwrite each other. Harness and Dori mode are separate CLIs, and the harness imports nothing from Dori mode.

## Requirements

- [bun](https://bun.sh) 1.3 or newer, and git
- [herdr](https://herdr.dev), the terminal multiplexer the lanes run in. On Windows, install it with `powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"`.
- a coding agent that loads skills (built for [OmO](https://github.com/code-yeongyu/oh-my-openagent); the agent command is configurable)
- `gh` (the GitHub CLI) for checking merged PRs and closed issues; `npm` for published versions
- [agent-messenger](https://github.com/agent-messenger/agent-messenger) for the bot itself

The host guard reads load, memory, swap and disk on macOS and on Windows. On Windows it gets them from one `powershell.exe` call. Load there is CPU use times the CPU count plus the processor queue, averaged over about a second, so it jumps around more than the 1-minute average on Unix. On Linux, load and disk work, and memory and swap read as unknown.

## Naming your Dori

The first thing a Dori does is ask you what it should be called. "Dori" is fine. So is a name that ends in Dori, like ShipDori or WorkDori, which helps when you run more than one. It uses that name for the bot, for how it signs off, and for the mode, so next time "ShipDori mode" is all you have to say.

## Using Slack

If you pick Slack, the Dori asks one more question and waits for your answer:

- **User token**: it acts as a real member of your workspace. That takes a paid seat, which you pay for. It reads everything that member can see and can keep a green online dot.
- **Bot token**: it's a Slack app. There's no seat cost, but it only sees channels it's invited to, within the scopes you gave the app.

## How the Dori writes

It talks the way you do. If you write short, casual and lowercase, it answers short, casual and lowercase. It uses no emojis, in any language. When a reply has several parts, it sends a few short messages instead of one long block, each sent as soon as it's ready, with no artificial pauses. A single status that keeps changing is the exception: that stays one message, edited in place.

## Configuration

Everything lives in `~/.dori/config.json`, and every field is optional. The ones you will want to set:

| Field | What it is |
|---|---|
| `leadPane` | your Dori's own herdr pane (`herdr pane current`). Lanes report here. |
| `laneWorkspace` | the herdr workspace new lane tabs open in |
| `defaultCwd` | where lanes start, and the repo whose worktrees they own |
| `agentCommand` | how to start an agent, as an argv list with `{model}` and `{prompt}` |
| `paneShell` | the shell in lane panes: `auto` (default), `posix`, `pwsh`, `powershell` or `cmd`. `auto` means posix off Windows. On Windows it asks herdr which shell the pane runs and falls back to `pwsh`. Set it if your panes always use one shell. |
| `hooks.threadReply`, `hooks.threadDone` | your messenger CLI, as argv lists with `{thread}` and `{text}`, so lanes can post progress and be marked done |

The rest (timings, thresholds, heavy-slot count) has sensible defaults. The full table is in [`references/scripts.md`](skills/dori-mode/references/scripts.md). `DORI_CONFIG`, `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

## Onboarding

On first setup, before it reads anything of yours, the Dori asks whether it may learn how you work: your tools, what you're working on and why, who you and your company are. Only if you say yes does it look at your tools, one at a time. For each one it says which integration it would use and what that reads, for example a CLI that reads Gmail and Calendar so it can watch your schedule, and asks before it touches it. Tools you decline are skipped and remembered.

Everything is read-only. It writes what it learns to memory as it goes and ends with a short summary of what it knows and what's still missing. The full process is in [`references/onboarding.md`](skills/dori-mode/references/onboarding.md).

## Routing a request

The Dori decides on its own how to handle each message.

- Questions, status checks, lookups and small edits get answered directly, with no new session.
- Code that ends in a PR, multi-step work, and anything long or parallel gets a lane. If an idle lane already owns that repo, the work goes there instead.
- When the host is short on memory, disk or panes (`dori can-launch` says HOLD), nothing new opens. The work is queued and the Dori tells you why.
- New work gets a new thread. A follow-up goes back to its original thread, reopening the old session if its lane was closed. A quick question is answered where you asked it.

## The session registry

Every lane gets one JSON file under `~/.dori/state/lanes/`. It maps the messenger thread to the herdr pane, the pane to the agent's own session id, and records a status: `working`, `done-claimed`, `verified-done`, `not-done` or `closed`. Each change is kept in a history.

`dori sync` compares that against the panes that are actually running and tells you what drifted: a pane that went away, a session id that changed, a lane with no way to prove it's finished. It never deletes anything. Add `--write` and it saves the session ids it found.

## The 5-minute done flow

A lane says it's finished:

```sh
dori claim-done fix-login --evidence "merged acme/app#412 (a1b2c3d)"
```

The Dori sees `LANE_DONE_CLAIMED`, and the lane is told it closes in five minutes. You can push back in that window:

```sh
dori object-done fix-login --reason "the changelog entry is missing"
```

The reason goes straight to the lane, which keeps working and claims again later. If nobody objects, `dori watch` closes the lane once the window is up. Before it does, it reads every `Done =` signal live again, and it refuses if a worktree still has commits that never reached a remote or uncommitted tracked changes. Either one turns the claim back into not-done, with the reason. Restarting the watcher doesn't reset the clock.

### What counts as done

A lane's `Done =` line lists signals the watcher can check for itself:
- a PR merged;
- an issue closed;
- a package version published;
- for work that never ends in a PR (a local setup, a QA pass, a running service): a command that exits 0, a file with the expected hash or JSON field, or a URL that answers with the expected status and body.

```
Done = command ["bun","test"]; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Write commands as argv, like `["bun","test"]`, so the same line works on Windows, macOS and Linux. On Windows a path such as `file C:\Users\ana\qa\report.json` is taken literally, so single backslashes are fine.

The watcher runs each check itself when it closes the lane, with no shell, and never takes the lane's word for it. A signal it can't parse is refused when the lane is launched. The full syntax is in [`references/sessions.md`](skills/dori-mode/references/sessions.md).

## Commands

| Command | What it does |
|---|---|
| `dori launch <key> ...` | write the lane footer into the brief, open a tab, start the agent, check for startup errors |
| `dori adopt <key> --pane ID ...` | register a lane that's already running |
| `dori sync [--write]` | registry against live panes, plus drift |
| `dori claim-done` / `object-done` / `close` | the done flow |
| `dori pause` / `resume` | the owner said wait: no nudges, goal paused, running turn stopped; and back |
| `dori watch` | the auto-close watcher; run it as a persistent monitor |
| `dori freshness [--loop MIN]` | nudge lanes that went quiet, then post their last report to their thread |
| `dori dead-panes [--loop MIN]` | report agent panes that stopped |
| `dori guard [--loop MIN]` | alert on load, memory, disk and pane count |
| `dori heavy <label> -- <cmd>` | run a build or test suite only when a slot is free and load is low |

Text sent to a pane always goes as one argument, never through a shell string, and the CLI reports each send as delivered or unconfirmed.

## Utilities

The CLI also carries the messenger pieces a Dori needs. You can import them as typed modules from `scripts/src/messenger/`.

| Command | What it does |
|---|---|
| `dori send slack\|telegram\|discord --to T --text X [--thread ID] [--edit ID]` | post or edit a message; rate limits are retried, and text containing `$(` is refused |
| `dori presence slack\|discord` | keep the account shown online (a Discord bot on the gateway, or a Slack user account through a web-client socket tickled every minute) |
| `dori transcribe <file>` | turn a voice note into text through your `hooks.transcribe` command |
| `dori can-launch` | tell whether there's room for another lane |
| `dori inbound slack [--loop MIN]` | catch everything addressed to the Dori on Slack: unread replies from the Threads view, new replies in any thread it posted in (even untagged ones), and DMs or channels with unread mentions |

The modules also cover a few things that have no command:
- Telegram: `sendMessageDraft` streaming that starts at "Thinking…", forum topics, and HTML tables.
- Discord: threads you can start, rename and archive.
- Slack: file uploads.
- `typingWhile`, which shows the typing indicator while a piece of work runs.

Every message the Dori posts on Slack records its thread, whichever helper sent it. A reply under a root it posted with a raw API call still reaches it, which is the case a plain message-event listener misses.

Tokens come from `DORI_SLACK_TOKEN` (with `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` and `DORI_DISCORD_TOKEN`. `dori` loads `~/.dori/slack.env` (or the file in `DORI_ENV_FILE`) first, and its values win over ones inherited from the environment.

## Tests

CI runs on every push to main and every pull request (see the end of this section). To run the tests locally:

```sh
cd skills/dori-mode/scripts
bun install
bun test           # behaviour tests against fake herdr, git and gh
bunx tsc --noEmit  # typecheck
```

The same commands work on Windows in PowerShell. The tests never touch a real pane, repo or GitHub.

The harness tests run from the repo root with `bun test ./test/`, and `bun run typecheck` checks its types. They use a fake herdr and gh, plus private herdr sessions in each pane shell when `herdr` is on PATH.

The Windows profile has its own tests (Windows only): `cd profile; bun test`. They run the listener against fake Slack and herdr, and run `install-profile.ps1` and the boot script in Windows PowerShell against a temporary home folder, with no scheduled task.

`bun scripts/check-paths.ts` fails when a tracked file holds a hard-coded user path, a fixed `C:\dev`-style install root, a personal mailbox or a maintainer's personal value (kept only as salted hashes). Add your own values locally with `DORI_GUARD_DENY="a,b"` or a git-ignored `.guard-deny` file. CI (`.github/workflows/ci.yml`) runs the guard, both typechecks and the root, skill and profile suites on Windows, and everything but the Windows-only profile suite on Ubuntu.

## License

MIT

## Migrate from OmOMeow

If you set up the older OmOMeow mode from the gist, your bot keeps working. Four changes turn it into a Dori.

1. **Pick a Dori name.** "Dori" on its own, or one that ends in Dori, like ShipDori or WorkDori. Tell your agent: "From now on your name is ShipDori and this is ShipDori mode." From then on, "ShipDori mode" is the keyword that turns it on, in place of "OmOMeow mode".
2. **Rename the bot and change its picture.**
   - Telegram: open @BotFather, send `/setname`, pick the bot and send the new name. Then send `/setuserpic`, pick the bot and send the new image. The default Dori picture is [`skills/dori-mode/assets/dori-avatar.png`](skills/dori-mode/assets/dori-avatar.png); use any image you like. A bot's name and picture can only be changed through BotFather.
   - Discord: in the Developer Portal, open your application. On the **Bot** page change the username and the icon, and on **General Information** change the app name and icon as well (the same default picture works), then save.
3. **Install this repo** with the install steps above, and tell your agent "ShipDori mode". It picks up the skill and the `dori` CLI in place of the old pasted prompt.
4. **Run onboarding** if your OmOMeow never did. Just say "run onboarding".

Your existing threads, topics and memory stay as they are.
