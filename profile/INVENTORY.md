# Windows Dori profile: inventory

What the Windows Dori setup is made of, and how this repo reproduces each piece. `~` is %USERPROFILE%.
Nothing here names a user, a folder, a workspace or a channel: every path comes from the home folder, every id from `slack.env` or from herdr at boot.
Decisions: **ship** (tracked in `profile/dori/`, placed into `~/.dori` by `profile/install-profile.ps1`),
**generate** (built by the installer or by `dori setup`), **secret** (asked in conversation and saved by `dori setup`, never tracked), **runtime** (detected on the PC at boot), **exclude**.

| Piece | Where it lives | Decision | Notes |
|---|---|---|---|
| dori CLI + dori-mode skill | ~/.dori/src, bun link, ~/.agents/skills/dori-mode junction, bun bin on user PATH | generate | install.ps1 |
| agent-messenger (messenger library for Slack, Telegram and Discord; agent-slackbot CLI for the Slack listener) | bun global packages | generate | install.ps1 runs `bun add -g agent-messenger@2.39.0` when missing; the Slack listener resolves it from bun's global folder, no fixed path |
| config.json | ~/.dori/config.json | ship + runtime | shipped with defaults (`name`, model, `hooks.autostart` = install-profile.ps1 -TaskOnly, guard); `leadPane`, `laneWorkspace`, `workspaces`, `ignorePanes` are empty in the repo and written by the boot script from the herdr workspace it creates. Only created, never replaced |
| inbound-rules.json | ~/.dori/inbound-rules.json | ship | Slack channel rules, empty by default: `mentionOnlyChannels`, `strictMentionChannels`, `ignoreChannels`, plus `agentUsers` (user ids of other agents, bots included, whose messages pass only with an @mention of the bot and arrive marked `"from":"agent"`) |
| inbound-next/ (Slack Socket Mode listener + supervisor + tests) | ~/.dori/inbound-next | ship | paths from the home folder or the script folder; owner/bot ids come from slack.env, no defaults; accepted messages get the eyes reaction and a working status (`DORI_WORKING_STATUS`, refreshed every `DORI_WORKING_REFRESH_MS`, stopped after `DORI_WORKING_LIMIT_MS`), and the bot's reply swaps eyes for white_check_mark |
| boot/dori-boot.ps1 | ~/.dori/boot | ship | herdr workspace named after the Dori (`DORI_NAME`, else `name` in config.json, else `Dori`); herdr ids written to config.json; agent started with `agentCommand` and `defaultModel` from config; messenger from the env file that holds a token (`DORI_MESSENGER` overrides), whose inbound monitor and greeting the prompt names |
| "&lt;Name&gt; Autostart" scheduled task | Task Scheduler, current user, at logon + 30 s | generate | registered only once one messenger env file (slack.env, telegram.env or discord.env) is complete: by `dori setup <messenger>` (hooks.autostart runs install-profile.ps1 -TaskOnly), or by install-profile.ps1 on a rerun when one is already complete; a Dori without tokens is never started at logon. `DORI_NO_TASK=1` skips it |
| slack-manifest.json | ~/.dori/slack-manifest.json | ship | Slack app manifest; rename the app to your Dori's name when you create it |
| slack.env, telegram.env or discord.env (the messenger the owner picks; keys as in `dori setup <messenger> --check`) | ~/.dori | secret | asked in conversation ("Dori mode"): the Dori asks which messenger, the owner pastes the tokens into the owner-only ~/.dori/<messenger>-setup.txt the Dori opens in Notepad (or the Dori reads them via Aside), `dori setup <messenger>` validates them, derives the ids, writes the env file atomically with an owner-only ACL and deletes the paste file; terminal prompts only with DORI_ASK_SECRETS=1 (DORI_MESSENGER picks the messenger); never written to user env vars (dori loads it itself, the file wins over inherited env) |
| slack-setup.txt (and telegram-/discord-) | ~/.dori | exclude | transient owner-only paste file, deleted by `dori setup` once the tokens are saved |
| briefs/, out/, state/ | ~/.dori | exclude | working data |
| omo, its login, its memory store (incl. reference/dori/*.md read at boot) | ~/.omo | exclude | install and log in separately |
| herdr, bun, git, Windows Terminal | system | generate / prerequisite | install.ps1 installs bun and herdr when missing (`DORI_NO_DEPS=1` skips that); git and Windows Terminal are prerequisites |
