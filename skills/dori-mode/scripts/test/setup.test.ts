import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Http } from "../src/messenger/http.ts";
import { run } from "../src/run.ts";
import { systemTool } from "../src/run.ts";
import { detectAside, maskValue, parseSetupInput, protectOwnerOnly, type SetupDeps, setupMessenger, type SetupOptions } from "../src/setup.ts";

setDefaultTimeout(30_000);
const BOT = "xoxb-1111111111-2222222222-AbCdEfGhIjKlMnOpQrStUvWx";
const APP = "xapp-1-A0TESTAPP-3333333333-0123456789abcdef0123456789abcdef";
const roots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dori-setup-test-"));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

type SlackWorld = {
  calls: { method: string; token: string }[];
  members: object[];
  channels: object[];
  authError?: string;
  socketOk: boolean;
  sockets: number;
  hooks: string[][];
  listener: boolean;
};
const world = (over: Partial<SlackWorld> = {}): SlackWorld => ({
  calls: [],
  members: [{ id: "UOWNER1", name: "owner", real_name: "The Owner", is_primary_owner: true }, { id: "UBOT1", is_bot: true }, { id: "USLACKBOT" }],
  channels: [{ id: "CHOME1", name: "01-dori" }],
  socketOk: true,
  sockets: 0,
  hooks: [],
  listener: false,
  ...over,
});
const fakeHttp = (w: SlackWorld): Http => async (req) => {
  const method = req.url.split("/").pop() ?? "";
  const token = (req.headers?.Authorization ?? "").replace("Bearer ", "");
  w.calls.push({ method, token });
  const reply = (body: object) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  if (method === "auth.test") return reply(token === BOT && !w.authError ? { ok: true, user_id: "UBOT1", user: "dori", team: "Test Team", team_id: "T0TEST", bot_id: "B0TEST" } : { ok: false, error: w.authError ?? "invalid_auth" });
  if (method === "bots.info") return reply(new URLSearchParams(String(req.body)).get("bot") === "B0TEST" ? { ok: true, bot: { id: "B0TEST", app_id: "A0TESTAPP" } } : { ok: false, error: "bot_not_found" });
  if (method === "apps.connections.open") return reply(token === APP ? { ok: true, url: "wss://fake/link" } : { ok: false, error: "invalid_auth" });
  if (method === "users.conversations") return reply({ ok: true, channels: w.channels });
  if (method === "users.list") return reply({ ok: true, members: w.members });
  return reply({ ok: false, error: "unknown_method" });
};

const harness = (w: SlackWorld, dir: string, over: Partial<SetupOptions> = {}) => {
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
const noSecrets = (lines: string[]) => {
  const all = lines.join("\n");
  expect(all).not.toContain(BOT);
  expect(all).not.toContain(APP);
  expect(all).not.toContain("AbCdEfGh");
};

test("input: KEY=VALUE lines, bare tokens anywhere on a line, quotes stripped, empty values and comments skipped", () => {
  const p = parseSetupInput(`# comment\nDORI_SLACK_TOKEN=\nbot token: ${BOT}\nDORI_SLACK_APP_TOKEN="${APP}"\nDORI_SLACK_OWNER = UOWNER1\n\nsomething else ${"zz"}\n`);
  expect(p.values).toEqual({ DORI_SLACK_TOKEN: BOT, DORI_SLACK_APP_TOKEN: APP, DORI_SLACK_OWNER: "UOWNER1" });
  expect(p.ignoredLines).toEqual([7]);
  expect(maskValue("DORI_SLACK_TOKEN", BOT)).toBe(`xoxb-… (${BOT.length} chars)`);
  expect(maskValue("DORI_SLACK_OWNER", "UOWNER1")).toBe("UOWNER1");
});

test("both tokens valid, one person and one channel: everything derived, slack.env owner-only, cursor seeded, autostart run, tokens never printed", async () => {
  const dir = tmp();
  const w = world();
  const h = harness(w, dir);
  const r = await h.go();
  expect(r.code).toBe(0);
  const env = readFileSync(h.opts.envPath, "utf8");
  expect(env).toBe(`DORI_SLACK_TOKEN=${BOT}\nDORI_SLACK_APP_TOKEN=${APP}\nDORI_SLACK_APP_ID=A0TESTAPP\nDORI_SLACK_CHANNEL=CHOME1\nDORI_SLACK_OWNER=UOWNER1\nDORI_SLACK_BOT_USER=UBOT1\n`);
  expect(JSON.parse(readFileSync(h.opts.cursorPath, "utf8"))).toEqual({ CHOME1: "1792900000.000000" });
  expect(w.sockets).toBe(1);
  expect(w.hooks).toEqual([["register-task", "--name", "test"]]);
  expect(h.lines.at(-1)).toBe("SETUP_COMPLETE");
  expect(h.lines.some((l) => l.startsWith("MONITOR") && l.includes("DELIVERY=stdout bun ~/.dori/inbound-next/run-inbound.ts") && l.includes("wakes_per_hour 3600") && l.includes("human_input true"))).toBe(true);
  noSecrets(h.lines);
  expect(existsSync(`${h.opts.envPath}.${process.pid}.tmp`)).toBe(false);

  if (process.platform === "win32") {
    const acl = await run(["powershell", "-NoProfile", "-Command", `$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); $a = Get-Acl -LiteralPath '${h.opts.envPath}'; "$($a.AreAccessRulesProtected)"; $a.Access | % { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`]);
    const [prot, ...rest] = acl.out.trim().split(/\r?\n/);
    const me = rest.pop();
    expect(prot).toBe("True");
    expect(rest).toEqual([me!]);
  } else expect(statSync(h.opts.envPath).mode & 0o777).toBe(0o600);
});

test("a second run with the same values leaves slack.env and the cursor unchanged", async () => {
  const dir = tmp();
  await harness(world(), dir).go();
  const before = readFileSync(join(dir, "slack.env"), "utf8");
  const again = harness(world(), dir, { input: {} });
  const r = await again.go();
  expect(r.code).toBe(0);
  expect(again.lines).toContain("UNCHANGED slack.env (owner-only ACL re-applied)");
  expect(again.lines.some((l) => l.startsWith("CURSOR") && l.includes("already has CHOME1"))).toBe(true);
  expect(readFileSync(join(dir, "slack.env"), "utf8")).toBe(before);
});

test("several people and channels: tokens saved, missing ids named with candidates, no cursor and no autostart; a rerun with the ids completes it", async () => {
  const dir = tmp();
  const w = world({
    members: [{ id: "UOWNER1", real_name: "The Owner", is_primary_owner: true }, { id: "UOTHER", real_name: "Someone" }],
    channels: [{ id: "CHOME1", name: "01-dori" }, { id: "CGEN", name: "general" }],
  });
  writeFileSync(join(dir, "slack.env"), "DORI_SLACK_COOKIE=keepme\n");
  const h = harness(w, dir);
  const r = await h.go();
  expect(r.code).toBe(2);
  expect(r.missing).toEqual(["DORI_SLACK_CHANNEL", "DORI_SLACK_OWNER"]);
  const env = readFileSync(h.opts.envPath, "utf8");
  expect(env).toContain(`DORI_SLACK_TOKEN=${BOT}`);
  expect(env).toContain("DORI_SLACK_COOKIE=keepme");
  expect(h.lines.some((l) => l.startsWith("NEED") && l.includes("CHOME1 #01-dori") && l.includes("CGEN #general"))).toBe(true);
  expect(h.lines.some((l) => l.startsWith("NEED") && l.includes("primary owner is UOWNER1"))).toBe(true);
  expect(h.lines.at(-1)).toContain("SETUP_INCOMPLETE missing: DORI_SLACK_CHANNEL, DORI_SLACK_OWNER");
  expect(existsSync(h.opts.cursorPath)).toBe(false);
  expect(w.hooks).toEqual([]);
  noSecrets(h.lines);

  const done = await harness(w, dir, { input: { DORI_SLACK_CHANNEL: "CHOME1", DORI_SLACK_OWNER: "UOWNER1" } }).go();
  expect(done.code).toBe(0);
  expect(readFileSync(h.opts.envPath, "utf8")).toContain("DORI_SLACK_COOKIE=keepme\nDORI_SLACK_APP_ID=A0TESTAPP\nDORI_SLACK_CHANNEL=CHOME1\nDORI_SLACK_OWNER=UOWNER1\nDORI_SLACK_BOT_USER=UBOT1\n");
});

test("an invalid bot token, a wrong token kind or a dead app token writes nothing and names the reason", async () => {
  for (const [input, w, reason] of [
    [{ DORI_SLACK_TOKEN: BOT.replace("AbC", "XyZ"), DORI_SLACK_APP_TOKEN: APP }, world(), "auth.test: invalid_auth"],
    [{ DORI_SLACK_TOKEN: APP, DORI_SLACK_APP_TOKEN: APP }, world(), "expected a bot (xoxb-) or user (xoxp-, xoxc-) token"],
    [{ DORI_SLACK_TOKEN: BOT, DORI_SLACK_APP_TOKEN: APP }, world({ socketOk: false }), "Socket Mode did not say hello"],
  ] as const) {
    const dir = tmp();
    const h = harness(w, dir, { input });
    const r = await h.go();
    expect(r.code).toBe(1);
    expect(existsSync(h.opts.envPath)).toBe(false);
    expect(h.lines.some((l) => l.startsWith("INVALID") && l.includes(reason))).toBe(true);
    expect(h.lines.at(-1)).toBe("SETUP_INVALID nothing was written");
    noSecrets(h.lines);
  }
});

test("no bot token: nothing is written and no API is called; a bot token alone is validated, saved, and the app token asked for", async () => {
  const dir = tmp();
  const w = world();
  const h = harness(w, dir, { input: { DORI_SLACK_APP_TOKEN: APP } });
  const r = await h.go();
  expect(r.code).toBe(2);
  expect(existsSync(h.opts.envPath)).toBe(false);
  expect(w.calls).toEqual([]);
  expect(h.lines.some((l) => l.startsWith("NEED") && l.includes("DORI_SLACK_TOKEN"))).toBe(true);

  const half = harness(world(), dir, { input: { DORI_SLACK_TOKEN: BOT } });
  const r2 = await half.go();
  expect(r2.code).toBe(2);
  expect(r2.missing).toEqual(["DORI_SLACK_APP_TOKEN"]);
  expect(readFileSync(half.opts.envPath, "utf8")).toContain(`DORI_SLACK_TOKEN=${BOT}`);
  expect(existsSync(half.opts.cursorPath)).toBe(false);
  noSecrets(half.lines);
});

test("a running listener or --no-socket means no Socket Mode connection is opened; a dry run writes nothing", async () => {
  const dir = tmp();
  const busy = world({ listener: true });
  expect((await harness(busy, dir).go()).code).toBe(0);
  expect(busy.sockets).toBe(0);
  expect(busy.calls.map((c) => c.method)).toContain("apps.connections.open");

  const dry = world();
  const dirDry = tmp();
  const h = harness(dry, dirDry, { dryRun: true, noSocket: true });
  expect((await h.go()).code).toBe(0);
  expect(dry.sockets).toBe(0);
  expect(dry.calls.map((c) => c.method)).not.toContain("apps.connections.open");
  expect(existsSync(h.opts.envPath)).toBe(false);
  expect(existsSync(h.opts.cursorPath)).toBe(false);
  expect(dry.hooks).toEqual([]);
  noSecrets(h.lines);
});

test("cli: tokens are refused on the command line; --from FILE against a fake Slack API saves slack.env and deletes the file", async () => {
  const dir = tmp();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const w = world();
      return fakeHttp(w)({ method: "POST", url: req.url, headers: { Authorization: req.headers.get("authorization") ?? "" }, body: "" }).then((r) => {
        const body = JSON.parse(r.body) as Record<string, unknown>;
        if (url.pathname.endsWith("apps.connections.open") && body.ok) body.url = `ws://localhost:${srv.port}/ws`;
        if (url.pathname.endsWith("bots.info")) return Response.json({ ok: true, bot: { app_id: "A0TESTAPP" } });
        return Response.json(body);
      });
    },
    websocket: {
      open: (ws) => {
        ws.send(JSON.stringify({ type: "hello" }));
      },
      message: () => {},
    },
  });
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
    const env = { ...(process.env as Record<string, string>), DORI_ENV_FILE: join(dir, "slack.env"), DORI_CONFIG: join(dir, "config.json"), DORI_SLACK_API: `http://localhost:${server.port}/api` };
    const exec = async (args: string[]) => {
      const p = Bun.spawn(["bun", cli, "setup", "slack", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };
    const refused = await exec(["--set", `DORI_SLACK_TOKEN=${BOT}`]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("never taken from the command line");

    const paste = join(dir, "slack-setup.txt");
    writeFileSync(paste, `DORI_SLACK_TOKEN=${BOT}\nDORI_SLACK_APP_TOKEN=${APP}\n`);
    const r = await exec(["--from", paste]);
    expect(r.out).toContain("Socket Mode hello received");
    expect(r.out).toContain("SETUP_COMPLETE");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(BOT);
    expect(r.out).not.toContain(APP);
    expect(existsSync(paste)).toBe(false);
    expect(readFileSync(join(dir, "slack.env"), "utf8")).toContain("DORI_SLACK_CHANNEL=CHOME1");

    const check = await exec(["--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("ENV_COMPLETE");
    expect(check.out).not.toContain(BOT);
  } finally {
    server.stop(true);
  }
});

const TG = "7123456789:AAHfakeTelegramTokenValue0123456789abc";
const DC = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.fakeDiscordTokenValue0123456789abcdef";
const XOXC = "xoxc-1111-2222-3333-fakebrowsertokenvalue";
const XOXD = "xoxd-fakecookievalue%2Fwith%3Descapes";
const platformHttp = (seen: { url: string; headers: Record<string, string> }[], opts: { tgChats?: object[]; dcTeam?: boolean; tgBad?: boolean } = {}): Http => async (req) => {
  seen.push({ url: req.url, headers: { ...(req.headers ?? {}) } });
  const reply = (status: number, body: object) => ({ status, headers: {}, body: JSON.stringify(body) });
  if (req.url === `https://fake.telegram/bot${TG}/getMe` && !opts.tgBad) return reply(200, { ok: true, result: { id: 7123456789, is_bot: true, username: "my_dori_bot" } });
  if (req.url === `https://fake.telegram/bot${TG}/getUpdates`) return reply(200, { ok: true, result: (opts.tgChats ?? []).map((chat) => ({ message: { chat } })) });
  if (req.url.startsWith("https://fake.telegram/")) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
  const auth = req.headers?.Authorization;
  if (req.url === "https://fake.discord/api/users/@me") return auth === `Bot ${DC}` ? reply(200, { id: "111", username: "dori", bot: true }) : reply(401, { message: "401: Unauthorized" });
  if (req.url === "https://fake.discord/api/oauth2/applications/@me" && auth === `Bot ${DC}`) return reply(200, { id: "222", owner: { id: "333", username: "ownername" }, team: opts.dcTeam ? { owner_user_id: "444", name: "team" } : null });
  return reply(404, { ok: false, error: "not_found" });
};

test("telegram: the bot token alone is validated with getMe, the owner chat comes from getUpdates, telegram.env is written owner-only", async () => {
  const dir = tmp();
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const h = harness(world(), dir, { messenger: "telegram", envPath: join(dir, "telegram.env"), input: parseSetupInput(`my bot token is ${TG}`, "telegram").values });
  const lines: string[] = [];
  const r = await setupMessenger(
    { http: platformHttp(seen, { tgChats: [{ id: 5550001, type: "private", username: "owner" }, { id: -100200, type: "supergroup" }] }), api: { slack: "", telegram: "https://fake.telegram", discord: "" }, socketHello: async () => true, protect: protectOwnerOnly(run), runHook: async () => ({ code: 0, out: "" }), listenerRunning: () => false, now: () => 0, out: (l) => lines.push(l) },
    { ...h.opts, autostart: undefined },
  );
  expect(r.code).toBe(0);
  expect(readFileSync(join(dir, "telegram.env"), "utf8")).toBe(`DORI_TELEGRAM_TOKEN=${TG}\nDORI_TELEGRAM_BOT=my_dori_bot\nDORI_TELEGRAM_OWNER=5550001\n`);
  expect(existsSync(h.opts.cursorPath)).toBe(false);
  expect(lines.some((l) => l.startsWith("MONITOR") && l.includes("telegram watch command"))).toBe(true);
  expect(lines.join("\n")).not.toContain(TG);
  expect(lines.join("\n")).not.toContain("fakeTelegramToken");

  const none = await setupMessenger(
    { http: platformHttp([], { tgChats: [] }), api: { slack: "", telegram: "https://fake.telegram", discord: "" }, socketHello: async () => true, protect: protectOwnerOnly(run), runHook: async () => ({ code: 0, out: "" }), listenerRunning: () => false, now: () => 0, out: (l) => lines.push(l) },
    { ...h.opts, envPath: join(dir, "t2.env"), input: { DORI_TELEGRAM_TOKEN: TG } },
  );
  expect(none.code).toBe(2);
  expect(lines.some((l) => l.startsWith("NEED") && l.includes("send it /start"))).toBe(true);

  const bad = await setupMessenger(
    { http: platformHttp([], { tgBad: true }), api: { slack: "", telegram: "https://fake.telegram", discord: "" }, socketHello: async () => true, protect: protectOwnerOnly(run), runHook: async () => ({ code: 0, out: "" }), listenerRunning: () => false, now: () => 0, out: (l) => lines.push(l) },
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
  const opts: SetupOptions = { messenger: "discord", envPath: join(dir, "discord.env"), cursorPath: join(dir, "c.json"), input: parseSetupInput(DC, "discord").values, dryRun: false, noSocket: false, listenerScript: "" };
  const deps: SetupDeps = { http: platformHttp(seen, { dcTeam: true }), api: { slack: "", telegram: "", discord: "https://fake.discord/api" }, socketHello: async () => true, protect: protectOwnerOnly(run), runHook: async () => ({ code: 0, out: "" }), listenerRunning: () => false, now: () => 0, out: (l) => lines.push(l) };
  const r = await setupMessenger(deps, opts);
  expect(r.code).toBe(0);
  expect(readFileSync(opts.envPath, "utf8")).toBe(`DORI_DISCORD_TOKEN=${DC}\nDORI_DISCORD_APP_ID=222\nDORI_DISCORD_BOT_USER=111\nDORI_DISCORD_OWNER=444\n`);
  expect(seen.every((s) => s.headers.Authorization === `Bot ${DC}`)).toBe(true);
  expect(lines.join("\n")).not.toContain(DC);
  const bad = await setupMessenger(deps, { ...opts, envPath: join(dir, "d2.env"), input: { DORI_DISCORD_TOKEN: DC.replace("fake", "nope") } });
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
      method === "auth.test" ? { ok: true, user_id: "UDORI", user: "dori", team: "T", team_id: "T1" }
      : method === "users.conversations" ? { ok: true, channels: [{ id: "CHOME1", name: "home" }] }
      : method === "users.list" ? { ok: true, members: [{ id: "UDORI" }, { id: "UOWNER1", real_name: "Owner" }] }
      : { ok: false, error: "unexpected" };
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  };
  const lines: string[] = [];
  const deps: SetupDeps = { http, api: { slack: "https://fake.slack/api", telegram: "", discord: "" }, socketHello: async () => true, protect: protectOwnerOnly(run), runHook: async () => ({ code: 0, out: "" }), listenerRunning: () => false, now: () => 0, out: (l) => lines.push(l) };
  const opts: SetupOptions = { messenger: "slack", envPath: join(dir, "slack.env"), cursorPath: join(dir, "c.json"), input: parseSetupInput(XOXC, "slack").values, dryRun: false, noSocket: false, listenerScript: "" };
  const noCookie = await setupMessenger(deps, opts);
  expect(noCookie.code).toBe(2);
  expect(calls).toEqual([]);
  expect(existsSync(opts.envPath)).toBe(false);

  const r = await setupMessenger(deps, { ...opts, input: parseSetupInput(`${XOXC}\n${XOXD}`, "slack").values });
  expect(r.code).toBe(0);
  expect(calls[0]!.Cookie).toBe(`d=${XOXD}`);
  expect(readFileSync(opts.envPath, "utf8")).toContain("DORI_SLACK_OWNER=UOWNER1\nDORI_SLACK_BOT_USER=UDORI\n");
  expect(lines.some((l) => l.startsWith("MONITOR") && l.includes("dori inbound slack --loop 1"))).toBe(true);
  expect(lines.join("\n")).not.toContain(XOXC);
  expect(lines.join("\n")).not.toContain(XOXD);
});

test("aside: ready only when installed, signed in and a browser profile is connected", async () => {
  const fake = (accounts: string, profiles: string) => async (argv: readonly string[]) => ({ code: 0, out: argv.includes("account") ? accounts : profiles, err: "" });
  const env = { DORI_ASIDE: '["bun","fake-aside.ts"]' };
  expect((await detectAside(fake("* u1  me@example.com  signed in  profiles: Profile 0", "6e83  Profile 0  connected"), env)).ready).toBe(true);
  const noLogin = await detectAside(fake("no accounts", "x  connected"), env);
  expect(noLogin.ready).toBe(false);
  expect(noLogin.lines[0]).toContain("no signed-in account");
  const noProfile = await detectAside(fake("* u1  signed in", "6e83  Profile 0  disconnected"), env);
  expect(noProfile.ready).toBe(false);
  expect(noProfile.lines[0]).toContain("no connected browser profile");
  const missing = await detectAside(fake("", ""), { LOCALAPPDATA: tmp() }, () => null);
  expect(missing.ready).toBe(false);
  expect(missing.lines[0]).toContain("not installed");
  const local = tmp();
  for (const v of ["1.26.1020.1855", "1.26.1023.1115", "1.26.1022.0"]) {
    const d = join(local, "Aside", "CLI", "versions", "win-x64", v);
    require("node:fs").mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "aside.exe"), "");
  }
  const found = await detectAside(fake("* u1  signed in", "a  connected"), { LOCALAPPDATA: local }, () => null);
  expect(found.argv).toEqual([join(local, "Aside", "CLI", "versions", "win-x64", "1.26.1023.1115", "aside.exe")]);
});

test("cli: --from-command takes the tokens from a command's stdout (an Aside script), never shows them, and refuses a failing command", async () => {
  const dir = tmp();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const server = Bun.serve({ port: 0, fetch: (req) => platformHttp([])({ method: "GET", url: req.url.replace(/^http:\/\/localhost:\d+/, "https://fake.telegram"), headers: {} }).then((r) => new Response(r.body, { status: r.status })) });
  try {
    const script = join(dir, "fake-aside.ts");
    writeFileSync(script, `console.log("DORI_TELEGRAM_TOKEN=${TG}"); console.error("read token from the BotFather page ${TG}");`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
    const env = { ...(process.env as Record<string, string>), DORI_ENV_FILE: join(dir, "telegram.env"), DORI_CONFIG: join(dir, "config.json"), DORI_TELEGRAM_API: `http://localhost:${server.port}` };
    const exec = async (args: string[]) => {
      const p = Bun.spawn(["bun", cli, "setup", "telegram", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };
    const r = await exec(["--set", "DORI_TELEGRAM_OWNER=5550001", "--from-command", "--", "bun", script]);
    expect(r.out).toContain("COMMAND  read token from the BotFather page (token)");
    expect(r.out).toContain("SETUP_COMPLETE");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(TG);
    expect(readFileSync(join(dir, "telegram.env"), "utf8")).toContain(`DORI_TELEGRAM_TOKEN=${TG}`);

    writeFileSync(script, `console.log("DORI_TELEGRAM_TOKEN=${TG}"); process.exit(4);`);
    const failed = await exec(["--from-command", "--", "bun", script]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("FROM_COMMAND_FAILED exit 4");
    expect(failed.out).not.toContain(TG);
  } finally {
    server.stop(true);
  }
});

test("protectOwnerOnly calls whoami and icacls by absolute System32 path, so Git Bash's /usr/bin/whoami cannot shadow them", async () => {
  const seen: string[][] = [];
  const fake = async (argv: readonly string[]) => {
    seen.push([...argv]);
    return { code: 0, out: argv[0]?.toLowerCase().endsWith("whoami.exe") ? '"host\\user","S-1-5-21-1-2-3-1001"' : "", err: "" };
  };
  await protectOwnerOnly(fake, true)("C:\\x\\a.env");
  expect(seen.map((a) => a[0])).toEqual([systemTool("whoami"), systemTool("icacls"), systemTool("icacls")]);
  expect(seen[1]?.slice(1)).toEqual(["C:\\x\\a.env", "/reset"]);
  expect(seen[2]?.[4]).toBe("*S-1-5-21-1-2-3-1001:(F)");
});
