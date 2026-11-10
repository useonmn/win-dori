import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Http } from "../src/messenger/http.ts";
import { run } from "../src/run.ts";
import { setupMessenger } from "../src/setup.ts";
import type { SetupDeps, SetupOptions } from "../src/setup-env.ts";
import { protectOwnerOnly } from "../src/setup-platform.ts";
import { parseSetupInput } from "../src/setup-env.ts";
import { cleanup, DC, harness, platformHttp, TG, tmp, world, XOXC, XOXD } from "./setup-fixtures.ts";

setDefaultTimeout(30_000);
afterAll(cleanup);

test("telegram: the bot token alone is validated with getMe, the owner chat comes from getUpdates, telegram.env is written owner-only", async () => {
  const dir = tmp();
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const h = harness(world(), dir, {
    messenger: "telegram",
    envPath: join(dir, "telegram.env"),
    input: parseSetupInput(`my bot token is ${TG}`, "telegram").values,
  });
  const lines: string[] = [];
  const r = await setupMessenger(
    {
      http: platformHttp(seen, {
        tgChats: [
          { id: 5550001, type: "private", username: "owner" },
          { id: -100200, type: "supergroup" },
        ],
      }),
      api: { slack: "", telegram: "https://fake.telegram", discord: "" },
      socketHello: async () => true,
      protect: protectOwnerOnly(run),
      runHook: async () => ({ code: 0, out: "" }),
      listenerRunning: () => false,
      now: () => 0,
      out: (l) => lines.push(l),
    },
    { ...h.opts, autostart: undefined },
  );
  expect(r.code).toBe(0);
  expect(readFileSync(join(dir, "telegram.env"), "utf8")).toBe(
    `DORI_TELEGRAM_TOKEN=${TG}\nDORI_TELEGRAM_BOT=my_dori_bot\nDORI_TELEGRAM_OWNER=5550001\n`,
  );
  expect(existsSync(h.opts.cursorPath)).toBe(false);
  expect(lines.some((l) => l.startsWith("MONITOR") && l.includes("telegram watch command"))).toBe(true);
  expect(lines.join("\n")).not.toContain(TG);
  expect(lines.join("\n")).not.toContain("fakeTelegramToken");

  const none = await setupMessenger(
    {
      http: platformHttp([], { tgChats: [] }),
      api: { slack: "", telegram: "https://fake.telegram", discord: "" },
      socketHello: async () => true,
      protect: protectOwnerOnly(run),
      runHook: async () => ({ code: 0, out: "" }),
      listenerRunning: () => false,
      now: () => 0,
      out: (l) => lines.push(l),
    },
    { ...h.opts, envPath: join(dir, "t2.env"), input: { DORI_TELEGRAM_TOKEN: TG } },
  );
  expect(none.code).toBe(2);
  expect(lines.some((l) => l.startsWith("NEED") && l.includes("send it /start"))).toBe(true);

  const bad = await setupMessenger(
    {
      http: platformHttp([], { tgBad: true }),
      api: { slack: "", telegram: "https://fake.telegram", discord: "" },
      socketHello: async () => true,
      protect: protectOwnerOnly(run),
      runHook: async () => ({ code: 0, out: "" }),
      listenerRunning: () => false,
      now: () => 0,
      out: (l) => lines.push(l),
    },
    { ...h.opts, envPath: join(dir, "t3.env"), input: { DORI_TELEGRAM_TOKEN: TG } },
  );
  expect(bad.code).toBe(1);
  expect(existsSync(join(dir, "t3.env"))).toBe(false);
  expect(lines.join("\n")).not.toContain(TG);
});

test("discord: users/@me names the bot, applications/@me gives the app id and the owner (the team owner when a team owns the app)", async () => {
  const dir = tmp();
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const lines: string[] = [];
  const opts: SetupOptions = {
    messenger: "discord",
    envPath: join(dir, "discord.env"),
    cursorPath: join(dir, "c.json"),
    input: parseSetupInput(DC, "discord").values,
    dryRun: false,
    noSocket: false,
    listenerScript: "",
  };
  const deps: SetupDeps = {
    http: platformHttp(seen, { dcTeam: true }),
    api: { slack: "", telegram: "", discord: "https://fake.discord/api" },
    socketHello: async () => true,
    protect: protectOwnerOnly(run),
    runHook: async () => ({ code: 0, out: "" }),
    listenerRunning: () => false,
    now: () => 0,
    out: (l) => lines.push(l),
  };
  const r = await setupMessenger(deps, opts);
  expect(r.code).toBe(0);
  expect(readFileSync(opts.envPath, "utf8")).toBe(
    `DORI_DISCORD_TOKEN=${DC}\nDORI_DISCORD_APP_ID=222\nDORI_DISCORD_BOT_USER=111\nDORI_DISCORD_OWNER=444\n`,
  );
  expect(seen.every((s) => s.headers["Authorization"] === `Bot ${DC}`)).toBe(true);
  expect(lines.join("\n")).not.toContain(DC);
  const bad = await setupMessenger(deps, {
    ...opts,
    envPath: join(dir, "d2.env"),
    input: { DORI_DISCORD_TOKEN: DC.replace("fake", "nope") },
  });
  expect(bad.code).toBe(1);
  expect(existsSync(join(dir, "d2.env"))).toBe(false);
});

test("slack user mode: a browser token (xoxc-) needs the d cookie, sends it to Slack, needs no app token and is watched by dori inbound", async () => {
  const dir = tmp();
  const calls: Record<string, string>[] = [];
  const http: Http = async (req) => {
    calls.push({ ...(req.headers ?? {}) });
    const method = req.url.split("/").pop();
    const body =
      method === "auth.test"
        ? { ok: true, user_id: "UDORI", user: "dori", team: "T", team_id: "T1" }
        : method === "users.conversations"
          ? { ok: true, channels: [{ id: "CHOME1", name: "home" }] }
          : method === "users.list"
            ? { ok: true, members: [{ id: "UDORI" }, { id: "UOWNER1", real_name: "Owner" }] }
            : { ok: false, error: "unexpected" };
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  };
  const lines: string[] = [];
  const deps: SetupDeps = {
    http,
    api: { slack: "https://fake.slack/api", telegram: "", discord: "" },
    socketHello: async () => true,
    protect: protectOwnerOnly(run),
    runHook: async () => ({ code: 0, out: "" }),
    listenerRunning: () => false,
    now: () => 0,
    out: (l) => lines.push(l),
  };
  const opts: SetupOptions = {
    messenger: "slack",
    envPath: join(dir, "slack.env"),
    cursorPath: join(dir, "c.json"),
    input: parseSetupInput(XOXC, "slack").values,
    dryRun: false,
    noSocket: false,
    listenerScript: "",
  };
  const noCookie = await setupMessenger(deps, opts);
  expect(noCookie.code).toBe(2);
  expect(calls).toEqual([]);
  expect(existsSync(opts.envPath)).toBe(false);

  const r = await setupMessenger(deps, { ...opts, input: parseSetupInput(`${XOXC}\n${XOXD}`, "slack").values });
  expect(r.code).toBe(0);
  expect(calls[0]!["Cookie"]).toBe(`d=${XOXD}`);
  expect(readFileSync(opts.envPath, "utf8")).toContain("DORI_SLACK_OWNER=UOWNER1\nDORI_SLACK_BOT_USER=UDORI\n");
  expect(lines.some((l) => l.startsWith("MONITOR") && l.includes("dori inbound slack --loop 1"))).toBe(true);
  expect(lines.join("\n")).not.toContain(XOXC);
  expect(lines.join("\n")).not.toContain(XOXD);
});
