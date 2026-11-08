// `dori setup <slack|telegram|discord>`: the conversational messenger setup. The Dori asks the owner only for the
// platform's tokens; this module validates them, derives every other value it can through the platform's API, and
// writes ~/.dori/<messenger>.env atomically with an owner-only ACL. Token values are never printed and never taken
// from the command line: they come from a file (`--from FILE`, deleted after saving), stdin (`--stdin`) or the stdout
// of a command (`--from-command -- ...`, e.g. an Aside browser script), which is read here and never shown.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Http } from "./messenger/http.ts";
import { IS_WINDOWS } from "./paths.ts";
import { type Runner, systemTool } from "./run.ts";

export const MESSENGERS = ["slack", "telegram", "discord"] as const;
export type Messenger = (typeof MESSENGERS)[number];

export const TOKEN = "DORI_SLACK_TOKEN";
export const APP_TOKEN = "DORI_SLACK_APP_TOKEN";
export const COOKIE = "DORI_SLACK_COOKIE";
export const APP_ID = "DORI_SLACK_APP_ID";
export const CHANNEL = "DORI_SLACK_CHANNEL";
export const OWNER = "DORI_SLACK_OWNER";
export const BOT_USER = "DORI_SLACK_BOT_USER";
export const TG_TOKEN = "DORI_TELEGRAM_TOKEN";
export const TG_BOT = "DORI_TELEGRAM_BOT";
export const TG_OWNER = "DORI_TELEGRAM_OWNER";
export const DC_TOKEN = "DORI_DISCORD_TOKEN";
export const DC_APP_ID = "DORI_DISCORD_APP_ID";
export const DC_BOT_USER = "DORI_DISCORD_BOT_USER";
export const DC_OWNER = "DORI_DISCORD_OWNER";

/** Every key each messenger's env file may hold, in the order the file lists them. */
export const KEYS: Record<Messenger, readonly string[]> = {
  slack: [TOKEN, APP_TOKEN, COOKIE, APP_ID, CHANNEL, OWNER, BOT_USER],
  telegram: [TG_TOKEN, TG_BOT, TG_OWNER],
  discord: [DC_TOKEN, DC_APP_ID, DC_BOT_USER, DC_OWNER],
};
export const SECRET_KEYS = new Set<string>([TOKEN, APP_TOKEN, COOKIE, TG_TOKEN, DC_TOKEN]);

/** Slack has three modes, told apart by the token: a bot (xoxb-, with Socket Mode), a user token (xoxp-) or a browser token (xoxc-, with the d cookie). */
export const requiredKeys = (m: Messenger, v: Values): string[] => {
  if (m === "telegram") return [TG_TOKEN, TG_BOT, TG_OWNER];
  if (m === "discord") return [DC_TOKEN, DC_APP_ID, DC_BOT_USER, DC_OWNER];
  const t = v[TOKEN] ?? "";
  if (t.startsWith("xoxc-")) return [TOKEN, COOKIE, CHANNEL, OWNER, BOT_USER];
  if (t.startsWith("xoxp-")) return [TOKEN, CHANNEL, OWNER, BOT_USER];
  return [TOKEN, APP_TOKEN, APP_ID, CHANNEL, OWNER, BOT_USER];
};

export type Values = Record<string, string>;

// Token shapes: Slack (xoxb/xoxp/xoxc, xapp, the xoxd cookie), Telegram (<bot id>:<35 chars>), Discord (three dot-separated base64url parts).
const SLACK_RE = /\b(xox[a-z]-|xapp-)[\w%-]+/g;
const TELEGRAM_RE = /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g;
const DISCORD_RE = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g;

/** Replaces every token-shaped string, so no line built from API replies, errors or pasted text can carry one. */
export const scrubTokens = (text: string): string => text.replace(SLACK_RE, "$1…").replace(TELEGRAM_RE, "(token)").replace(DISCORD_RE, "(token)");

/** `xoxb-… (59 chars)` for a token, the value itself for a non-secret id. */
export const maskValue = (key: string, value: string): string => {
  if (!SECRET_KEYS.has(key)) return value;
  const prefix = /^(xox[a-z]-|xapp-)/.exec(value)?.[1] ?? "";
  return `${prefix}… (${value.length} chars)`;
};

/** `KEY=VALUE` lines of an env file, in file order; comments and blank lines are skipped. */
export const parseEnvText = (text: string): Values => {
  const out: Values = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

export type ParsedInput = { readonly values: Values; readonly ignoredLines: readonly number[] };

/**
 * Reads what the owner pasted: `KEY=VALUE` lines for the messenger's keys, or a bare token anywhere on a line
 * (Slack: xoxb-/xoxp-/xoxc- token, xapp- app-level token, xoxd- cookie; Telegram and Discord: their bot token).
 * Any other line is reported by number only, never by content, because it may hold a mistyped secret.
 */
export const parseSetupInput = (text: string, m: Messenger = "slack"): ParsedInput => {
  const values: Values = {};
  const ignoredLines: number[] = [];
  const known = new Set<string>(KEYS[m]);
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const kv = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (kv && known.has(kv[1]!)) {
      const v = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
      if (v) values[kv[1]!] = v;
      return;
    }
    const found: [string, string | undefined][] =
      m === "slack"
        ? [[TOKEN, /\b(xox[bpc]-[\w-]+)/.exec(line)?.[1]], [APP_TOKEN, /\b(xapp-[\w-]+)/.exec(line)?.[1]], [COOKIE, /\b(xoxd-[\w%-]+)/.exec(line)?.[1]]]
        : m === "telegram"
          ? [[TG_TOKEN, line.match(TELEGRAM_RE)?.[0]]]
          : [[DC_TOKEN, line.match(DISCORD_RE)?.[0]]];
    let any = false;
    for (const [k, v] of found) if (v) (values[k] = v), (any = true);
    if (!any) ignoredLines.push(n + 1);
  });
  return { values, ignoredLines };
};

/** Env file text: the messenger's keys in canonical order, then any other keys the file already had. */
export const renderEnv = (m: Messenger, values: Values): string => {
  const keys = [...KEYS[m].filter((k) => values[k]), ...Object.keys(values).filter((k) => !KEYS[m].includes(k) && values[k])];
  return keys.map((k) => `${k}=${values[k]}`).join("\n") + "\n";
};

export const missingKeys = (m: Messenger, values: Values): string[] => requiredKeys(m, values).filter((k) => !values[k]);

export type SetupDeps = {
  readonly http: Http;
  readonly api: { readonly slack: string; readonly telegram: string; readonly discord: string };
  /** Opens a Slack Socket Mode url, resolves true on the `hello` envelope and closes at once; false on error or timeout. */
  readonly socketHello: (url: string) => Promise<boolean>;
  readonly protect: (path: string) => Promise<void>;
  readonly runHook: (argv: readonly string[]) => Promise<{ code: number; out: string }>;
  /** True when the Slack listener already holds its lock: a second Socket Mode connection would take its events. */
  readonly listenerRunning: () => boolean;
  readonly now: () => number;
  readonly out: (line: string) => void;
};

export type SetupOptions = {
  readonly messenger: Messenger;
  readonly envPath: string;
  readonly cursorPath: string;
  readonly input: Values;
  readonly dryRun: boolean;
  readonly noSocket: boolean;
  readonly autostart?: readonly string[];
  readonly listenerScript: string;
};

export type SetupResult = { readonly code: 0 | 1 | 2; readonly values: Values; readonly missing: readonly string[] };

type Reply = Record<string, unknown> & { ok?: boolean; error?: string };
type Invalid = { readonly key: string; readonly why: string };
type Ctx = { deps: SetupDeps; opts: SetupOptions; values: Values; say: (tag: string, key: string, rest: string) => void };

const request = async (deps: SetupDeps, req: Parameters<Http>[0]): Promise<{ status: number; body: Reply }> => {
  try {
    const res = await deps.http(req);
    return { status: res.status, body: JSON.parse(res.body || "{}") as Reply };
  } catch (e) {
    return { status: 0, body: { ok: false, error: scrubTokens(e instanceof Error ? e.message : String(e)).slice(0, 120) } };
  }
};

/** A Slack Web API call as a form POST, which every method accepts (read methods ignore JSON bodies). */
const slackCall = async (c: Ctx, token: string, method: string, params: Record<string, string> = {}): Promise<Reply> => {
  const cookie: Record<string, string> = token.startsWith("xoxc-") && c.values[COOKIE] ? { Cookie: `d=${c.values[COOKIE]}` } : {};
  const r = await request(c.deps, {
    method: "POST",
    url: `${c.deps.api.slack}/${method}`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", ...cookie },
    body: new URLSearchParams(params).toString(),
  });
  return r.status === 200 ? r.body : { ok: false, error: r.body.error ?? `http_${r.status}` };
};

type Member = { id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean; is_primary_owner?: boolean };
type Channel = { id?: string; name?: string };

const deriveSlack = async (c: Ctx): Promise<Invalid | undefined> => {
  const { values, opts } = c;
  const token = values[TOKEN]!;
  const bot = token.startsWith("xoxb-");
  if (!/^xox[bpc]-/.test(token)) return { key: TOKEN, why: `expected a bot (xoxb-) or user (xoxp-, xoxc-) token, got ${maskValue(TOKEN, token)}` };
  if (token.startsWith("xoxc-") && !values[COOKIE]) {
    c.say("NEED", COOKIE, "a browser token (xoxc-) needs the d cookie (xoxd-...) of the same browser session");
    return;
  }
  const auth = await slackCall(c, token, "auth.test");
  if (!auth.ok) return { key: TOKEN, why: `auth.test: ${auth.error ?? "failed"}` };
  c.say("OK", TOKEN, `${maskValue(TOKEN, token)}  auth.test: workspace ${String(auth.team ?? "?")} (${String(auth.team_id ?? "?")}), ${bot ? "bot" : "member"} ${String(auth.user ?? "?")}`);
  const self = String(auth.user_id ?? "");
  if (self) {
    if (opts.input[BOT_USER] && opts.input[BOT_USER] !== self) c.say("WARN", BOT_USER, `given ${opts.input[BOT_USER]} but the token belongs to ${self}; using ${self}`);
    values[BOT_USER] = self;
    c.say("DERIVED", BOT_USER, `${self}  (auth.test user_id${bot ? "" : ", the Dori's own member"})`);
  }

  if (bot) {
    if (!opts.input[APP_ID]) {
      const info = auth.bot_id ? await slackCall(c, token, "bots.info", { bot: String(auth.bot_id) }) : { ok: false, error: "auth.test returned no bot_id" };
      const appId = String(((info.bot ?? {}) as { app_id?: string }).app_id ?? "");
      if (info.ok && appId) {
        values[APP_ID] = appId;
        c.say("DERIVED", APP_ID, `${appId}  (bots.info)`);
      } else if (!values[APP_ID]) c.say("NEED", APP_ID, `could not derive (bots.info: ${info.error ?? "no app_id"}); it is on the app's Basic Information page (A...)`);
    }
    const appToken = values[APP_TOKEN] ?? "";
    if (!appToken) c.say("NEED", APP_TOKEN, "the app-level token (xapp-...), from Basic Information > App-Level Tokens, scope connections:write");
    else if (!appToken.startsWith("xapp-")) return { key: APP_TOKEN, why: `expected an app-level token starting with xapp-, got ${maskValue(APP_TOKEN, appToken)}` };
    else if (opts.noSocket) c.say("SKIPPED", APP_TOKEN, `${maskValue(APP_TOKEN, appToken)}  not checked (--no-socket)`);
    else {
      const conn = await slackCall(c, appToken, "apps.connections.open");
      if (!conn.ok || typeof conn.url !== "string") return { key: APP_TOKEN, why: `apps.connections.open: ${conn.error ?? "no url"}` };
      if (c.deps.listenerRunning()) c.say("OK", APP_TOKEN, `${maskValue(APP_TOKEN, appToken)}  apps.connections.open ok; socket not opened because the listener is running`);
      else if (await c.deps.socketHello(conn.url)) c.say("OK", APP_TOKEN, `${maskValue(APP_TOKEN, appToken)}  Socket Mode hello received, connection closed`);
      else return { key: APP_TOKEN, why: "Socket Mode did not say hello within 10 s (is Socket Mode enabled for the app?)" };
    }
  }

  if (!values[CHANNEL]) {
    const conv = await slackCall(c, token, "users.conversations", { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
    const chans = ((conv.channels ?? []) as Channel[]).filter((x) => x.id);
    const who = bot ? "the bot" : "the Dori's member";
    if (!conv.ok) c.say("NEED", CHANNEL, `could not derive (users.conversations: ${conv.error}); ask the owner for the home channel id (C...)`);
    else if (chans.length === 1) {
      values[CHANNEL] = chans[0]!.id!;
      c.say("DERIVED", CHANNEL, `${chans[0]!.id}  (#${chans[0]!.name ?? "?"}, the only channel ${who} is in)`);
    } else if (!chans.length) c.say("NEED", CHANNEL, `${who} is in no channel yet: ask the owner to invite it to its home channel (/invite) and run again, or for the channel id (C...)`);
    else c.say("NEED", CHANNEL, `${who} is in ${chans.length} channels, ask the owner which is home: ${chans.slice(0, 8).map((x) => `${x.id} #${x.name ?? "?"}`).join(", ")}`);
  }

  if (!values[OWNER]) {
    const list = await slackCall(c, token, "users.list", { limit: "200" });
    const people = ((list.members ?? []) as Member[]).filter((x) => x.id && x.id !== self && !x.deleted && !x.is_bot && !x.is_app_user && x.id !== "USLACKBOT");
    const primary = people.find((x) => x.is_primary_owner);
    if (!list.ok) c.say("NEED", OWNER, `could not derive (users.list: ${list.error}); ask the owner for their member id (U...)`);
    else if (people.length === 1) {
      values[OWNER] = people[0]!.id!;
      c.say("DERIVED", OWNER, `${people[0]!.id}  (${people[0]!.real_name || people[0]!.name || "?"}, the only person in the workspace)`);
    } else c.say("NEED", OWNER, `${people.length} people in the workspace, so it cannot be derived${primary ? `; the primary owner is ${primary.id} (${primary.real_name || primary.name || "?"}): confirm with the owner` : ""}; ask for their member id (U...)`);
  } else if (!/^[UW][A-Z0-9]+$/.test(values[OWNER]!)) return { key: OWNER, why: `${values[OWNER]} is not a member id (U... or W...)` };
  return undefined;
};

const deriveTelegram = async (c: Ctx): Promise<Invalid | undefined> => {
  const token = c.values[TG_TOKEN]!;
  const api = (method: string) => request(c.deps, { method: "GET", url: `${c.deps.api.telegram}/bot${token}/${method}` });
  const me = await api("getMe");
  const bot = (me.body.result ?? {}) as { id?: number; username?: string; is_bot?: boolean };
  if (!me.body.ok || !bot.username) return { key: TG_TOKEN, why: `getMe: ${String(me.body.description ?? me.body.error ?? `http_${me.status}`)}` };
  c.say("OK", TG_TOKEN, `${maskValue(TG_TOKEN, token)}  getMe: @${bot.username} (${bot.id})`);
  c.values[TG_BOT] = bot.username;
  c.say("DERIVED", TG_BOT, `${bot.username}  (getMe)`);
  if (c.values[TG_OWNER]) {
    if (!/^-?\d+$/.test(c.values[TG_OWNER]!)) return { key: TG_OWNER, why: `${c.values[TG_OWNER]} is not a Telegram chat id (a number)` };
    return undefined;
  }
  const up = await api("getUpdates");
  if (!up.body.ok) {
    c.say("NEED", TG_OWNER, `could not derive (getUpdates: ${String(up.body.description ?? `http_${up.status}`)}); ask the owner for their Telegram user id`);
    return undefined;
  }
  type Chat = { id?: number; type?: string; username?: string; first_name?: string };
  const chats = new Map<number, Chat>();
  for (const u of (up.body.result ?? []) as { message?: { chat?: Chat } }[]) {
    const chat = u.message?.chat;
    if (chat?.type === "private" && typeof chat.id === "number") chats.set(chat.id, chat);
  }
  const list = [...chats.values()];
  if (list.length === 1) {
    c.values[TG_OWNER] = String(list[0]!.id);
    c.say("DERIVED", TG_OWNER, `${list[0]!.id}  (${list[0]!.username ? `@${list[0]!.username}` : (list[0]!.first_name ?? "?")}, the only person who messaged the bot)`);
  } else if (!list.length) c.say("NEED", TG_OWNER, `nobody has messaged @${bot.username} yet: ask the owner to send it /start, then run again`);
  else c.say("NEED", TG_OWNER, `${list.length} people messaged the bot, ask the owner which is them: ${list.map((x) => `${x.id} ${x.username ? `@${x.username}` : (x.first_name ?? "?")}`).join(", ")}`);
  return undefined;
};

const deriveDiscord = async (c: Ctx): Promise<Invalid | undefined> => {
  const token = c.values[DC_TOKEN]!;
  const get = (path: string) => request(c.deps, { method: "GET", url: `${c.deps.api.discord}${path}`, headers: { Authorization: `Bot ${token}` } });
  const me = await get("/users/@me");
  const user = me.body as { id?: string; username?: string; bot?: boolean; message?: string };
  if (me.status !== 200 || !user.id) return { key: DC_TOKEN, why: `users/@me: ${user.message ?? `http_${me.status}`}` };
  c.say("OK", DC_TOKEN, `${maskValue(DC_TOKEN, token)}  users/@me: ${user.username ?? "?"} (${user.id})`);
  c.values[DC_BOT_USER] = user.id;
  c.say("DERIVED", DC_BOT_USER, `${user.id}  (users/@me)`);
  const app = await get("/oauth2/applications/@me");
  const a = app.body as { id?: string; owner?: { id?: string; username?: string }; team?: { owner_user_id?: string; name?: string } | null };
  if (app.status !== 200 || !a.id) {
    for (const k of [DC_APP_ID, DC_OWNER]) if (!c.values[k]) c.say("NEED", k, `could not derive (applications/@me: http_${app.status}); ask the owner`);
    return undefined;
  }
  c.values[DC_APP_ID] = a.id;
  c.say("DERIVED", DC_APP_ID, `${a.id}  (applications/@me)`);
  const owner = a.team?.owner_user_id ?? a.owner?.id;
  if (!c.values[DC_OWNER] && owner) {
    c.values[DC_OWNER] = owner;
    c.say("DERIVED", DC_OWNER, `${owner}  (${a.team ? `owner of the team ${a.team.name ?? "?"} that owns the app` : `the application owner ${a.owner?.username ?? "?"}`}): confirm with the owner`);
  } else if (!c.values[DC_OWNER]) c.say("NEED", DC_OWNER, "the application has no owner id; ask the owner for their Discord user id");
  return undefined;
};

const NEED_TOKEN: Record<string, string> = {
  [TOKEN]: "the bot token (xoxb-...), from the app's OAuth & Permissions page",
  [TG_TOKEN]: "the bot token from @BotFather (/newbot or /token)",
  [DC_TOKEN]: "the bot token from the Developer Portal > your application > Bot > Reset Token",
};
const MAIN_TOKEN: Record<Messenger, string> = { slack: TOKEN, telegram: TG_TOKEN, discord: DC_TOKEN };

/** Validates, derives and (unless a dry run) saves the env file. Exit code: 0 complete, 2 saved but incomplete, 1 invalid. */
export const setupMessenger = async (deps: SetupDeps, opts: SetupOptions): Promise<SetupResult> => {
  const m = opts.messenger;
  const existing = existsSync(opts.envPath) ? parseEnvText(readFileSync(opts.envPath, "utf8")) : {};
  const values: Values = { ...existing, ...opts.input };
  const say = (tag: string, key: string, rest: string) => deps.out(scrubTokens(`${tag.padEnd(9)}${key.padEnd(22)}${rest}`.trimEnd()));
  deps.out(`SETUP ${m} ${opts.envPath}${opts.dryRun ? " (dry run: nothing is written)" : ""}`);

  const main = MAIN_TOKEN[m];
  if (!values[main]) {
    say("NEED", main, NEED_TOKEN[main]!);
    if (m === "slack") say("NEED", APP_TOKEN, "with a bot token, also the app-level token (xapp-...), from Basic Information > App-Level Tokens, scope connections:write");
    deps.out(`SETUP_INCOMPLETE missing: ${main} (nothing was written)`);
    return { code: 2, values: existing, missing: missingKeys(m, values) };
  }
  const ctx: Ctx = { deps, opts, values, say };
  const invalid = await (m === "slack" ? deriveSlack(ctx) : m === "telegram" ? deriveTelegram(ctx) : deriveDiscord(ctx));
  if (invalid) {
    say("INVALID", invalid.key, invalid.why);
    deps.out("SETUP_INVALID nothing was written");
    return { code: 1, values: existing, missing: missingKeys(m, existing) };
  }
  if (m === "slack" && values[TOKEN]!.startsWith("xoxc-") && !values[COOKIE]) {
    deps.out(`SETUP_INCOMPLETE missing: ${COOKIE} (nothing was written)`);
    return { code: 2, values: existing, missing: missingKeys(m, values) };
  }

  const missing = missingKeys(m, values);
  const text = renderEnv(m, values);
  const before = existsSync(opts.envPath) ? readFileSync(opts.envPath, "utf8") : undefined;
  const shown = Object.keys(values).filter((k) => values[k]);
  if (opts.dryRun) deps.out(`DRY_RUN would ${before === undefined ? "create" : before === text ? "leave unchanged" : "update"} ${opts.envPath}: ${shown.map((k) => `${k}=${maskValue(k, values[k]!)}`).join(" ")}`);
  else if (before === text) {
    await deps.protect(opts.envPath);
    deps.out(`UNCHANGED ${m}.env (owner-only ACL re-applied)`);
  } else {
    writeSecretFile(opts.envPath, text);
    await deps.protect(opts.envPath);
    deps.out(`WROTE    ${opts.envPath} (only this user can read it): ${shown.join(", ")}`);
  }

  if (missing.length) {
    deps.out(`SETUP_INCOMPLETE missing: ${missing.join(", ")}. Ask the owner for the ids (not secret), then: dori setup ${m} ${missing.map((k) => (SECRET_KEYS.has(k) ? `--from FILE (${k})` : `--set ${k}=...`)).join(" ")}`);
    return { code: 2, values, missing };
  }

  const slackBot = m === "slack" && values[TOKEN]!.startsWith("xoxb-");
  if (slackBot) {
    const cursors = existsSync(opts.cursorPath) ? (JSON.parse(readFileSync(opts.cursorPath, "utf8") || "{}") as Record<string, string>) : {};
    if (!cursors[values[CHANNEL]!]) {
      const ts = `${Math.floor(deps.now() / 1000)}.000000`;
      if (!opts.dryRun) {
        mkdirSync(dirname(opts.cursorPath), { recursive: true });
        const tmp = `${opts.cursorPath}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...cursors, [values[CHANNEL]!]: ts }));
        renameSync(tmp, opts.cursorPath);
      }
      deps.out(`${opts.dryRun ? "WOULD_SEED" : "SEEDED  "} ${opts.cursorPath} ${values[CHANNEL]}=${ts}`);
    } else deps.out(`CURSOR   ${opts.cursorPath} already has ${values[CHANNEL]}`);
  }

  if (!opts.autostart?.length) deps.out("AUTOSTART none configured (hooks.autostart in config.json); nothing registered");
  else if (opts.dryRun) deps.out(`AUTOSTART would run: ${opts.autostart.join(" ")}`);
  else {
    const r = await deps.runHook(opts.autostart);
    for (const l of r.out.split(/\r?\n/).filter((x) => x.trim())) deps.out(scrubTokens(`AUTOSTART ${l.trim()}`));
    deps.out(r.code === 0 ? "AUTOSTART_OK" : `AUTOSTART_FAILED exit ${r.code}`);
  }

  if (slackBot) deps.out(`MONITOR  arm one persistent monitor: command "DELIVERY=stdout bun ${opts.listenerScript}", filter ^INBOUND, persistent true, wakes_per_hour 3600, human_input true`);
  else if (m === "slack") deps.out('MONITOR  arm one persistent monitor: command "dori inbound slack --loop 1", filter ^INBOUND, persistent true, human_input true');
  else deps.out(`MONITOR  arm your ${m} watch command (agent-messenger) as a persistent monitor for new owner messages; see references/setup.md, Monitors`);
  deps.out(opts.dryRun ? "SETUP_COMPLETE (dry run)" : "SETUP_COMPLETE");
  return { code: 0, values, missing };
};

/** Writes a secret file through a temp file in the same folder and renames it over the target. */
export const writeSecretFile = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};

/** Windows: protected ACL with one FullControl entry for the current user's SID (as install-profile.ps1 does); POSIX: mode 600. */
export const protectOwnerOnly = (run: Runner, windows = IS_WINDOWS) => async (path: string): Promise<void> => {
  if (!windows) {
    const { chmodSync } = await import("node:fs");
    chmodSync(path, 0o600);
    return;
  }
  const who = await run([systemTool("whoami"), "/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[\d-]+)"/.exec(who.out)?.[1];
  if (!sid) throw new Error(`could not read the current user's SID (whoami exit ${who.code})`);
  // /inheritance:r drops only inherited entries; a file created where nothing is inheritable (an elevated
  // token, a protected parent) carries the token's default DACL as explicit entries, which /reset clears first.
  const reset = await run([systemTool("icacls"), path, "/reset"]);
  if (reset.code !== 0) throw new Error(`icacls /reset failed on ${path} (exit ${reset.code}): ${reset.err || reset.out}`.slice(0, 300));
  const r = await run([systemTool("icacls"), path, "/inheritance:r", "/grant:r", `*${sid}:(F)`]);
  if (r.code !== 0) throw new Error(`icacls failed on ${path} (exit ${r.code}): ${r.err || r.out}`.slice(0, 300));
};

export const realSocketHello = (url: string, timeoutMs = 10_000): Promise<boolean> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.addEventListener("message", (e) => {
      try {
        if ((JSON.parse(String(e.data)) as { type?: string }).type === "hello") finish(true);
      } catch {}
    });
    ws.addEventListener("error", () => finish(false));
    ws.addEventListener("close", () => finish(false));
  });

export type AsideStatus = { readonly ready: boolean; readonly argv?: readonly string[]; readonly lines: readonly string[] };

/**
 * Finds the Aside browser CLI and checks it can act for the owner: an account signed in and a connected browser
 * profile. `DORI_ASIDE` (a path, or a JSON argv such as ["bun","fake-aside.ts"]) overrides the lookup; otherwise PATH,
 * then the newest %LOCALAPPDATA%\Aside\CLI\versions\<platform>\<version>\aside.exe (the `current` junction on PATH
 * cannot always be followed by child processes).
 */
export const detectAside = async (run: Runner, env: Record<string, string | undefined> = process.env, which = (c: string) => Bun.which(c)): Promise<AsideStatus> => {
  let argv: string[] | undefined;
  if (env.DORI_ASIDE) argv = env.DORI_ASIDE.startsWith("[") ? (JSON.parse(env.DORI_ASIDE) as string[]) : [env.DORI_ASIDE];
  else {
    const onPath = which("aside");
    if (onPath) argv = [onPath];
    else if (env.LOCALAPPDATA) {
      const base = join(env.LOCALAPPDATA, "Aside", "CLI", "versions");
      const plat = existsSync(base) ? readdirSync(base).sort() : [];
      for (const p of plat) {
        const versions = readdirSync(join(base, p)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const exe = versions.map((v) => join(base, p, v, "aside.exe")).find((x) => existsSync(x));
        if (exe) argv = [exe];
      }
    }
  }
  if (!argv) return { ready: false, lines: ["ASIDE_UNAVAILABLE not installed (no aside on PATH or under %LOCALAPPDATA%\\Aside\\CLI)"] };
  const accounts = await run([...argv, "account", "list"]);
  const signedIn = accounts.code === 0 && /signed in/i.test(accounts.out);
  if (!signedIn) return { ready: false, argv, lines: [`ASIDE_UNAVAILABLE installed but no signed-in account (aside account list exit ${accounts.code}); the owner can run aside login`] };
  const profiles = await run([...argv, "host", "profiles"]);
  const connected = profiles.out.split(/\r?\n/).filter((l) => /\bconnected\b/i.test(l) && !/disconnected/i.test(l)).length;
  if (profiles.code !== 0 || !connected) return { ready: false, argv, lines: [`ASIDE_UNAVAILABLE signed in but no connected browser profile (aside host profiles exit ${profiles.code}); is the Aside browser open?`] };
  return { ready: true, argv, lines: [`ASIDE_READY ${argv.join(" ")} (account signed in, ${connected} connected profile${connected === 1 ? "" : "s"})`] };
};

export const setupTemplate = (m: Messenger): string => {
  const how: Record<Messenger, string> = {
    slack: `# Bot token: api.slack.com/apps > your app > OAuth & Permissions > Bot User OAuth Token (xoxb-...)
# App-level token: Basic Information > App-Level Tokens, scope connections:write (xapp-...)
${TOKEN}=
${APP_TOKEN}=`,
    telegram: `# Bot token: in Telegram, @BotFather > /newbot (or /token for an existing bot)
${TG_TOKEN}=`,
    discord: `# Bot token: discord.com/developers/applications > your application > Bot > Reset Token
${DC_TOKEN}=`,
  };
  return `# Paste your Dori's ${m} token${m === "slack" ? "s" : ""} after the = sign${m === "slack" ? "s" : ""}, save (Ctrl+S) and close this window.
# Only your user can read this file. dori setup ${m} deletes it after saving the tokens to ${m}.env.
${how[m]}
`;
};

