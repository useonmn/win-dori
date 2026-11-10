import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Http } from "../src/messenger/http.ts";
import { run } from "../src/run.ts";
import { setupMessenger } from "../src/setup.ts";
import type { SetupDeps, SetupOptions } from "../src/setup-env.ts";
import { protectOwnerOnly } from "../src/setup-platform.ts";

export const BOT = "xoxb-1111111111-2222222222-AbCdEfGhIjKlMnOpQrStUvWx";
export const APP = "xapp-1-A0TESTAPP-3333333333-0123456789abcdef0123456789abcdef";
const roots: string[] = [];
export const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dori-setup-test-"));
  roots.push(d);
  return d;
};
export const cleanup = () => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
};

export type SlackWorld = {
  calls: { method: string; token: string }[];
  members: object[];
  channels: object[];
  authError?: string;
  socketOk: boolean;
  sockets: number;
  hooks: string[][];
  listener: boolean;
};
export const world = (over: Partial<SlackWorld> = {}): SlackWorld => ({
  calls: [],
  members: [
    { id: "UOWNER1", name: "owner", real_name: "The Owner", is_primary_owner: true },
    { id: "UBOT1", is_bot: true },
    { id: "USLACKBOT" },
  ],
  channels: [{ id: "CHOME1", name: "01-dori" }],
  socketOk: true,
  sockets: 0,
  hooks: [],
  listener: false,
  ...over,
});
export const fakeHttp =
  (w: SlackWorld): Http =>
  async (req) => {
    const method = req.url.split("/").pop() ?? "";
    const token = (req.headers?.["Authorization"] ?? "").replace("Bearer ", "");
    w.calls.push({ method, token });
    const reply = (body: object) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
    if (method === "auth.test")
      return reply(
        token === BOT && !w.authError
          ? { ok: true, user_id: "UBOT1", user: "dori", team: "Test Team", team_id: "T0TEST", bot_id: "B0TEST" }
          : { ok: false, error: w.authError ?? "invalid_auth" },
      );
    if (method === "bots.info")
      return reply(
        new URLSearchParams(String(req.body)).get("bot") === "B0TEST"
          ? { ok: true, bot: { id: "B0TEST", app_id: "A0TESTAPP" } }
          : { ok: false, error: "bot_not_found" },
      );
    if (method === "apps.connections.open")
      return reply(token === APP ? { ok: true, url: "wss://fake/link" } : { ok: false, error: "invalid_auth" });
    if (method === "users.conversations") return reply({ ok: true, channels: w.channels });
    if (method === "users.list") return reply({ ok: true, members: w.members });
    return reply({ ok: false, error: "unknown_method" });
  };

export const harness = (w: SlackWorld, dir: string, over: Partial<SetupOptions> = {}) => {
  const lines: string[] = [];
  const deps: SetupDeps = {
    http: fakeHttp(w),
    api: { slack: "https://fake.slack/api", telegram: "https://fake.telegram", discord: "https://fake.discord/api" },
    socketHello: async () => {
      w.sockets++;
      return w.socketOk;
    },
    protect: protectOwnerOnly(run),
    runHook: async (argv) => {
      w.hooks.push([...argv]);
      return { code: 0, out: "task 'Dori Autostart Test' registered" };
    },
    listenerRunning: () => w.listener,
    now: () => 1_792_900_000_000,
    out: (l) => lines.push(l),
  };
  const opts: SetupOptions = {
    messenger: "slack",
    envPath: join(dir, "slack.env"),
    cursorPath: join(dir, "state", "inbound-cursor.json"),
    input: { DORI_SLACK_TOKEN: BOT, DORI_SLACK_APP_TOKEN: APP },
    dryRun: false,
    noSocket: false,
    autostart: ["register-task", "--name", "test"],
    listenerScript: "~/.dori/inbound-next/run-inbound.ts",
    ...over,
  };
  return { lines, go: () => setupMessenger(deps, opts), opts };
};
export const noSecrets = (lines: string[]) => {
  const all = lines.join("\n");
  expect(all).not.toContain(BOT);
  expect(all).not.toContain(APP);
  expect(all).not.toContain("AbCdEfGh");
};

export const TG = "7123456789:AAHfakeTelegramTokenValue0123456789abc";
export const DC = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.fakeDiscordTokenValue0123456789abcdef";
export const XOXC = "xoxc-1111-2222-3333-fakebrowsertokenvalue";
export const XOXD = "xoxd-fakecookievalue%2Fwith%3Descapes";
export const platformHttp =
  (
    seen: { url: string; headers: Record<string, string> }[],
    opts: { tgChats?: object[]; dcTeam?: boolean; tgBad?: boolean } = {},
  ): Http =>
  async (req) => {
    seen.push({ url: req.url, headers: { ...(req.headers ?? {}) } });
    const reply = (status: number, body: object) => ({ status, headers: {}, body: JSON.stringify(body) });
    if (req.url === `https://fake.telegram/bot${TG}/getMe` && !opts.tgBad)
      return reply(200, { ok: true, result: { id: 7123456789, is_bot: true, username: "my_dori_bot" } });
    if (req.url === `https://fake.telegram/bot${TG}/getUpdates`)
      return reply(200, { ok: true, result: (opts.tgChats ?? []).map((chat) => ({ message: { chat } })) });
    if (req.url.startsWith("https://fake.telegram/"))
      return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const auth = req.headers?.["Authorization"];
    if (req.url === "https://fake.discord/api/users/@me")
      return auth === `Bot ${DC}`
        ? reply(200, { id: "111", username: "dori", bot: true })
        : reply(401, { message: "401: Unauthorized" });
    if (req.url === "https://fake.discord/api/oauth2/applications/@me" && auth === `Bot ${DC}`)
      return reply(200, {
        id: "222",
        owner: { id: "333", username: "ownername" },
        team: opts.dcTeam ? { owner_user_id: "444", name: "team" } : null,
      });
    return reply(404, { ok: false, error: "not_found" });
  };
