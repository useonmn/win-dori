// Setup derivation for Telegram and Discord, and the API request helper shared with the Slack derivation.
import type { Http } from "./messenger/http.ts";
import {
  DC_APP_ID,
  DC_BOT_USER,
  DC_OWNER,
  DC_TOKEN,
  maskValue,
  type SetupDeps,
  type SetupOptions,
  TG_BOT,
  TG_OWNER,
  TG_TOKEN,
  type Values,
  scrubTokens,
} from "./setup-env.ts";

export type Reply = Record<string, unknown> & { ok?: boolean; error?: string };
export type Invalid = { readonly key: string; readonly why: string };
export type Ctx = {
  deps: SetupDeps;
  opts: SetupOptions;
  values: Values;
  say: (tag: string, key: string, rest: string) => void;
};

export const request = async (deps: SetupDeps, req: Parameters<Http>[0]): Promise<{ status: number; body: Reply }> => {
  try {
    const res = await deps.http(req);
    return { status: res.status, body: JSON.parse(res.body || "{}") as Reply };
  } catch (e) {
    return {
      status: 0,
      body: { ok: false, error: scrubTokens(e instanceof Error ? e.message : String(e)).slice(0, 120) },
    };
  }
};

export const deriveTelegram = async (c: Ctx): Promise<Invalid | undefined> => {
  const token = c.values[TG_TOKEN]!;
  const api = (method: string) =>
    request(c.deps, { method: "GET", url: `${c.deps.api.telegram}/bot${token}/${method}` });
  const me = await api("getMe");
  const bot = (me.body["result"] ?? {}) as { id?: number; username?: string; is_bot?: boolean };
  if (!me.body.ok || !bot.username)
    return { key: TG_TOKEN, why: `getMe: ${String(me.body["description"] ?? me.body.error ?? `http_${me.status}`)}` };
  c.say("OK", TG_TOKEN, `${maskValue(TG_TOKEN, token)}  getMe: @${bot.username} (${bot.id})`);
  c.values[TG_BOT] = bot.username;
  c.say("DERIVED", TG_BOT, `${bot.username}  (getMe)`);
  if (c.values[TG_OWNER]) {
    if (!/^-?\d+$/.test(c.values[TG_OWNER]!))
      return { key: TG_OWNER, why: `${c.values[TG_OWNER]} is not a Telegram chat id (a number)` };
    return undefined;
  }
  const up = await api("getUpdates");
  if (!up.body.ok) {
    c.say(
      "NEED",
      TG_OWNER,
      `could not derive (getUpdates: ${String(up.body["description"] ?? `http_${up.status}`)}); ask the owner for their Telegram user id`,
    );
    return undefined;
  }
  type Chat = { id?: number; type?: string; username?: string; first_name?: string };
  const chats = new Map<number, Chat>();
  for (const u of (up.body["result"] ?? []) as { message?: { chat?: Chat } }[]) {
    const chat = u.message?.chat;
    if (chat?.type === "private" && typeof chat.id === "number") chats.set(chat.id, chat);
  }
  const list = [...chats.values()];
  if (list.length === 1) {
    c.values[TG_OWNER] = String(list[0]!.id);
    c.say(
      "DERIVED",
      TG_OWNER,
      `${list[0]!.id}  (${list[0]!.username ? `@${list[0]!.username}` : (list[0]!.first_name ?? "?")}, the only person who messaged the bot)`,
    );
  } else if (!list.length)
    c.say(
      "NEED",
      TG_OWNER,
      `nobody has messaged @${bot.username} yet: ask the owner to send it /start, then run again`,
    );
  else
    c.say(
      "NEED",
      TG_OWNER,
      `${list.length} people messaged the bot, ask the owner which is them: ${list.map((x) => `${x.id} ${x.username ? `@${x.username}` : (x.first_name ?? "?")}`).join(", ")}`,
    );
  return undefined;
};

export const deriveDiscord = async (c: Ctx): Promise<Invalid | undefined> => {
  const token = c.values[DC_TOKEN]!;
  const get = (path: string) =>
    request(c.deps, { method: "GET", url: `${c.deps.api.discord}${path}`, headers: { Authorization: `Bot ${token}` } });
  const me = await get("/users/@me");
  const user = me.body as { id?: string; username?: string; bot?: boolean; message?: string };
  if (me.status !== 200 || !user.id) return { key: DC_TOKEN, why: `users/@me: ${user.message ?? `http_${me.status}`}` };
  c.say("OK", DC_TOKEN, `${maskValue(DC_TOKEN, token)}  users/@me: ${user.username ?? "?"} (${user.id})`);
  c.values[DC_BOT_USER] = user.id;
  c.say("DERIVED", DC_BOT_USER, `${user.id}  (users/@me)`);
  const app = await get("/oauth2/applications/@me");
  const a = app.body as {
    id?: string;
    owner?: { id?: string; username?: string };
    team?: { owner_user_id?: string; name?: string } | null;
  };
  if (app.status !== 200 || !a.id) {
    for (const k of [DC_APP_ID, DC_OWNER])
      if (!c.values[k]) c.say("NEED", k, `could not derive (applications/@me: http_${app.status}); ask the owner`);
    return undefined;
  }
  c.values[DC_APP_ID] = a.id;
  c.say("DERIVED", DC_APP_ID, `${a.id}  (applications/@me)`);
  const owner = a.team?.owner_user_id ?? a.owner?.id;
  if (!c.values[DC_OWNER] && owner) {
    c.values[DC_OWNER] = owner;
    c.say(
      "DERIVED",
      DC_OWNER,
      `${owner}  (${a.team ? `owner of the team ${a.team.name ?? "?"} that owns the app` : `the application owner ${a.owner?.username ?? "?"}`}): confirm with the owner`,
    );
  } else if (!c.values[DC_OWNER])
    c.say("NEED", DC_OWNER, "the application has no owner id; ask the owner for their Discord user id");
  return undefined;
};
