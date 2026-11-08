# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 1. herdr

herdr is the terminal multiplexer the Dori runs in. Every lane is a herdr tab, and herdr lets you read a pane, type into it and see which process runs there.

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi        # or the integration for the agent you run in
herdr --skill                       # load its skill unless it is already in your context
```

On Windows, install herdr from PowerShell, then run the same two `herdr` commands:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
```

## 2. Messenger

Install agent-messenger (github.com/agent-messenger/agent-messenger) and read which platforms it supports. Ask the owner which one to use (Slack, Telegram or Discord; none is preferred) and wait for the answer.

agent-messenger wraps part of each platform. Read the platform's current bot API changelog and call the API directly for the rest:

- Telegram: stream a reply as it grows and show "Thinking…" with message drafts, send rich messages for tables and headings, and use topics in the private chat (turn on threaded mode in BotFather's mini app; there is no API for that switch).
- Discord: edit your own messages to grow them, and use threads.

### If the owner picks Slack: user token or bot token

Ask which mode, give the trade-off as a short list, and wait for the choice:

- **User token**: the Dori acts as a real member of the workspace.
  - It needs a paid seat, which the owner pays for.
  - It reads everything that member can see.
  - It can keep a green online dot (`dori presence slack`).
- **Bot token**: the Dori is a Slack app.
  - There's no seat cost.
  - It only sees channels it is invited to, within the scopes the app was granted.
  - It shows as an app, not a person.

Record the choice. With a user token, the secrets are `DORI_SLACK_TOKEN` (`xoxp-`, or `xoxc-` plus `DORI_SLACK_COOKIE`, the `d` cookie `xoxd-...` from that member's browser session). With a bot token, they are `DORI_SLACK_TOKEN` (`xoxb-`) and `DORI_SLACK_APP_TOKEN` (`xapp-`, for Socket Mode). Step 3 saves them; never set them by hand in environment variables.

## 3. Bot and its tokens

### Who makes the bot

Run `dori setup aside`. If it prints `ASIDE_READY` (the Aside browser CLI is installed, signed in, and a browser profile is connected), ask the owner whether they create the bot and its tokens themselves or want you to do it. If it prints `ASIDE_UNAVAILABLE`, do not offer it: the owner creates the bot, and you guide them.

**The owner does it** (the default). Give the steps for their platform one at a time and wait for each:

- **Slack**: api.slack.com/apps > Create New App > From an app manifest, and paste the manifest (`~/.dori/slack-manifest.json` when the Windows profile placed one). Install it to the workspace. Basic Information > App-Level Tokens > Generate, scope `connections:write` (the `xapp-` token). OAuth & Permissions > Bot User OAuth Token (the `xoxb-` token). Invite the bot to its home channel (`/invite @<bot>`).
- **Telegram**: @BotFather > `/newbot`, then the owner sends `/start` to the new bot (that is how its chat id is found).
- **Discord**: discord.com/developers/applications > New Application > Bot > Reset Token, then invite it with an OAuth2 URL (scope `bot`).

**You do it, through Aside.** Create the app with `aside` (`aside exec`, or `aside repl` with the site skill), from the manifest above, or reuse the owner's existing Dori app if there is one. Install it and turn on what the platform needs (Slack: Socket Mode, the app-level token). Never take a snapshot or screenshot of a page that shows a token, and never print one. Read the tokens only inside the hand-off below.

### Hand the tokens to `dori setup`, never to the chat

Never ask for a token in the chat, and never put one in a command line. A chat message is stored in the session record and sent to the model provider; nothing can mask it afterwards. If the owner pastes one anyway, say it stays in the record and suggest rotating it once setup is done.

- **Owner-only file** (the owner made the bot): `dori setup <messenger> --prepare` creates `~/.dori/<messenger>-setup.txt` that only this user can read, with one empty `KEY=` line per token, and opens it in Notepad. Tell the owner to paste the tokens there, save and close, and tell you when. Then run `dori setup <messenger> --from "<that file>"`. It deletes the file once the tokens are saved.
- **Command pipe** (you made the bot through Aside): `dori setup <messenger> --from-command -- <aside> repl "<code>"`. The code opens the token pages and prints `KEY=VALUE` lines (for example `DORI_SLACK_TOKEN=xoxb-...` from OAuth & Permissions and `DORI_SLACK_APP_TOKEN=xapp-...` from the app-level token dialog) with `console.log`. That stdout goes straight into `dori setup`, never to you; only its stderr is shown, with tokens scrubbed. Use the full path `dori setup aside` printed.
- **Terminal**: the owner can run `dori setup <messenger> --stdin` in their own terminal, outside the agent, paste the tokens and end with Ctrl+Z, Enter (Ctrl+D on macOS and Linux). The Windows profile also has `DORI_ASK_SECRETS=1` (with `DORI_MESSENGER`) for its installer.

`dori setup` validates the tokens with the platform's API and derives everything it can: on Slack the bot user and workspace (auth.test), the app id (bots.info), the home channel when the bot is in exactly one channel, the owner when the workspace has one person; on Telegram the bot (getMe) and the owner's chat id when exactly one person has messaged the bot (getUpdates); on Discord the bot user, the application id and its owner (applications/@me). With a Slack bot token it also opens one Socket Mode connection until Slack says hello, then closes it (skipped when the listener already runs). It prints tokens only masked (`xoxb-… (59 chars)`), writes `~/.dori/<messenger>.env` through a temp file with an owner-only ACL, and ends with one of:

- `SETUP_COMPLETE`, exit 0: follow its `MONITOR` line and arm that monitor. `hooks.autostart` (if configured) has run, and for a Slack bot the listener cursor is seeded.
- `SETUP_INCOMPLETE`, exit 2: the tokens are saved, and each `NEED` line says what is missing and why it could not be derived, often with candidates. Ask the owner one short question per value (these ids are not secret), then `dori setup <messenger> --set KEY=VALUE`.
- `SETUP_INVALID`, exit 1: nothing was written; tell the owner the reason on the `INVALID` line.

`dori setup <messenger> --check` tells, without the network, whether the file is complete. `dori` loads `slack.env`, `telegram.env` and `discord.env` from `~/.dori` before every command.

### Avatar and greeting

Give the bot its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Telegram**: @BotFather → `/setuserpic` → pick the bot → send the image.
- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon.
- **Slack**:
  - bot token: the app's **Basic Information** → Display Information → App icon;
  - user token: the member's profile photo (`users.setPhoto`, or the profile page).

Greet the owner through the bot before doing anything else.

## 4. Scripts

```sh
cd skills/dori-mode/scripts && bun install && bun link    # puts `dori` on PATH
mkdir -p ~/.dori && cp ../references/config.example.json ~/.dori/config.json
```

On Windows, install from any folder with `irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex`, or run `.\install.ps1` from a checkout. Either way it installs into `%USERPROFILE%\.dori\src` and asks nothing. It does the same steps, links the skill as a directory junction, adds bun's global bin folder to your user PATH, and places the Windows profile (or the example config). The tokens come later, in conversation, through step 3.

Then edit `~/.dori/config.json`: at least `leadPane` (your own herdr pane, from `herdr pane current`), `laneWorkspace`, `defaultCwd`, and the two hooks if you want lane threads updated automatically. On Windows, also check `paneShell` (see `references/scripts.md`). `references/scripts.md` explains every field.

## 5. Monitors

Arm these as persistent monitors in your own session:

| Monitor | Command | Filter |
|---|---|---|
| inbound messages | the `MONITOR` line `dori setup` printed (Slack bot: the Windows profile's Socket Mode listener; Slack user token: `dori inbound slack --loop 1`; Telegram, Discord: your messenger's watch command) | new owner messages |
| done flow | `dori watch` | `^LANE_` |
| dead panes | `dori dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE)` |
| host guard | `dori guard --loop 1` | `^HOST_GUARD` |
| freshness | `dori freshness --loop 5` | `^(NUDGED\|POSTED\|NO-REPORT\|PENDING-REPORT\|STALE-REPORT\|STALLED\|JOURNAL-ERROR\|WORKING-WHILE-PAUSED)` |
| Slack inbound (Slack only) | `dori inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `dori inbound telegram --loop 1` (reads `~/.dori/telegram.env`: `DORI_TELEGRAM_OWNER` or `DORI_TELEGRAM_OWNER_ID`) | `^INBOUND` |
| presence (optional) | `dori presence slack` or `dori presence discord` | `^PRESENCE_READY` |

The Slack bot listener also shows the owner that work has started. Each accepted message, catch-up ones included, gets an `eyes` reaction and a thread status (`작업 중...` by default, `DORI_WORKING_STATUS` overrides it). The status is refreshed every minute (`DORI_WORKING_REFRESH_MS`) and stops after 30 minutes (`DORI_WORKING_LIMIT_MS`). When the bot replies, the status clears and `eyes` becomes `white_check_mark`. Slack calls time out after 10 seconds (`DORI_SLACK_TIMEOUT_MS`), and a failed one is logged without blocking delivery.

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.
