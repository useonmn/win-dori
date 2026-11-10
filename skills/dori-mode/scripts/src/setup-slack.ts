// Setup derivation for Slack: validates the bot, user or browser token and derives the app, channel and owner ids.
import { APP_ID, APP_TOKEN, BOT_USER, CHANNEL, COOKIE, maskValue, OWNER, TOKEN } from "./setup-env.ts";
import { type Ctx, type Invalid, type Reply, request } from "./setup-derive.ts";

/** A Slack Web API call as a form POST, which every method accepts (read methods ignore JSON bodies). */
const slackCall = async (
  c: Ctx,
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<Reply> => {
  const cookie: Record<string, string> =
    token.startsWith("xoxc-") && c.values[COOKIE] ? { Cookie: `d=${c.values[COOKIE]}` } : {};
  const r = await request(c.deps, {
    method: "POST",
    url: `${c.deps.api.slack}/${method}`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", ...cookie },
    body: new URLSearchParams(params).toString(),
  });
  return r.status === 200 ? r.body : { ok: false, error: r.body.error ?? `http_${r.status}` };
};

type Member = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_primary_owner?: boolean;
};
type Channel = { id?: string; name?: string };

export const deriveSlack = async (c: Ctx): Promise<Invalid | undefined> => {
  const { values, opts } = c;
  const token = values[TOKEN]!;
  const bot = token.startsWith("xoxb-");
  if (!/^xox[bpc]-/.test(token))
    return { key: TOKEN, why: `expected a bot (xoxb-) or user (xoxp-, xoxc-) token, got ${maskValue(TOKEN, token)}` };
  if (token.startsWith("xoxc-") && !values[COOKIE]) {
    c.say("NEED", COOKIE, "a browser token (xoxc-) needs the d cookie (xoxd-...) of the same browser session");
    return;
  }
  const auth = await slackCall(c, token, "auth.test");
  if (!auth.ok) return { key: TOKEN, why: `auth.test: ${auth.error ?? "failed"}` };
  c.say(
    "OK",
    TOKEN,
    `${maskValue(TOKEN, token)}  auth.test: workspace ${String(auth["team"] ?? "?")} (${String(auth["team_id"] ?? "?")}), ${bot ? "bot" : "member"} ${String(auth["user"] ?? "?")}`,
  );
  const self = String(auth["user_id"] ?? "");
  if (self) {
    if (opts.input[BOT_USER] && opts.input[BOT_USER] !== self)
      c.say("WARN", BOT_USER, `given ${opts.input[BOT_USER]} but the token belongs to ${self}; using ${self}`);
    values[BOT_USER] = self;
    c.say("DERIVED", BOT_USER, `${self}  (auth.test user_id${bot ? "" : ", the Dori's own member"})`);
  }

  if (bot) {
    if (!opts.input[APP_ID]) {
      const info = auth["bot_id"]
        ? await slackCall(c, token, "bots.info", { bot: String(auth["bot_id"]) })
        : { ok: false, error: "auth.test returned no bot_id" };
      const appId = String(((info["bot"] ?? {}) as { app_id?: string }).app_id ?? "");
      if (info.ok && appId) {
        values[APP_ID] = appId;
        c.say("DERIVED", APP_ID, `${appId}  (bots.info)`);
      } else if (!values[APP_ID])
        c.say(
          "NEED",
          APP_ID,
          `could not derive (bots.info: ${info.error ?? "no app_id"}); it is on the app's Basic Information page (A...)`,
        );
    }
    const appToken = values[APP_TOKEN] ?? "";
    if (!appToken)
      c.say(
        "NEED",
        APP_TOKEN,
        "the app-level token (xapp-...), from Basic Information > App-Level Tokens, scope connections:write",
      );
    else if (!appToken.startsWith("xapp-"))
      return {
        key: APP_TOKEN,
        why: `expected an app-level token starting with xapp-, got ${maskValue(APP_TOKEN, appToken)}`,
      };
    else if (opts.noSocket) c.say("SKIPPED", APP_TOKEN, `${maskValue(APP_TOKEN, appToken)}  not checked (--no-socket)`);
    else {
      const conn = await slackCall(c, appToken, "apps.connections.open");
      if (!conn.ok || typeof conn["url"] !== "string")
        return { key: APP_TOKEN, why: `apps.connections.open: ${conn.error ?? "no url"}` };
      if (c.deps.listenerRunning())
        c.say(
          "OK",
          APP_TOKEN,
          `${maskValue(APP_TOKEN, appToken)}  apps.connections.open ok; socket not opened because the listener is running`,
        );
      else if (await c.deps.socketHello(conn["url"]))
        c.say("OK", APP_TOKEN, `${maskValue(APP_TOKEN, appToken)}  Socket Mode hello received, connection closed`);
      else
        return {
          key: APP_TOKEN,
          why: "Socket Mode did not say hello within 10 s (is Socket Mode enabled for the app?)",
        };
    }
  }

  if (!values[CHANNEL]) {
    const conv = await slackCall(c, token, "users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    const chans = ((conv["channels"] ?? []) as Channel[]).filter((x) => x.id);
    const who = bot ? "the bot" : "the Dori's member";
    if (!conv.ok)
      c.say(
        "NEED",
        CHANNEL,
        `could not derive (users.conversations: ${conv.error}); ask the owner for the home channel id (C...)`,
      );
    else if (chans.length === 1) {
      values[CHANNEL] = chans[0]!.id!;
      c.say("DERIVED", CHANNEL, `${chans[0]!.id}  (#${chans[0]!.name ?? "?"}, the only channel ${who} is in)`);
    } else if (!chans.length)
      c.say(
        "NEED",
        CHANNEL,
        `${who} is in no channel yet: ask the owner to invite it to its home channel (/invite) and run again, or for the channel id (C...)`,
      );
    else
      c.say(
        "NEED",
        CHANNEL,
        `${who} is in ${chans.length} channels, ask the owner which is home: ${chans
          .slice(0, 8)
          .map((x) => `${x.id} #${x.name ?? "?"}`)
          .join(", ")}`,
      );
  }

  if (!values[OWNER]) {
    const list = await slackCall(c, token, "users.list", { limit: "200" });
    const people = ((list["members"] ?? []) as Member[]).filter(
      (x) => x.id && x.id !== self && !x.deleted && !x.is_bot && !x.is_app_user && x.id !== "USLACKBOT",
    );
    const primary = people.find((x) => x.is_primary_owner);
    if (!list.ok)
      c.say("NEED", OWNER, `could not derive (users.list: ${list.error}); ask the owner for their member id (U...)`);
    else if (people.length === 1) {
      values[OWNER] = people[0]!.id!;
      c.say(
        "DERIVED",
        OWNER,
        `${people[0]!.id}  (${people[0]!.real_name || people[0]!.name || "?"}, the only person in the workspace)`,
      );
    } else
      c.say(
        "NEED",
        OWNER,
        `${people.length} people in the workspace, so it cannot be derived${primary ? `; the primary owner is ${primary.id} (${primary.real_name || primary.name || "?"}): confirm with the owner` : ""}; ask for their member id (U...)`,
      );
  } else if (!/^[UW][A-Z0-9]+$/.test(values[OWNER]!))
    return { key: OWNER, why: `${values[OWNER]} is not a member id (U... or W...)` };
  return undefined;
};
