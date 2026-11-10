import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { maskValue, parseSetupInput } from "../src/setup-env.ts";
import { cleanup, APP, BOT, harness, noSecrets, tmp, world } from "./setup-fixtures.ts";

setDefaultTimeout(30_000);
afterAll(cleanup);

test("input: KEY=VALUE lines, bare tokens anywhere on a line, quotes stripped, empty values and comments skipped", () => {
  const p = parseSetupInput(
    `# comment\nDORI_SLACK_TOKEN=\nbot token: ${BOT}\nDORI_SLACK_APP_TOKEN="${APP}"\nDORI_SLACK_OWNER = UOWNER1\n\nsomething else ${"zz"}\n`,
  );
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
  expect(env).toBe(
    `DORI_SLACK_TOKEN=${BOT}\nDORI_SLACK_APP_TOKEN=${APP}\nDORI_SLACK_APP_ID=A0TESTAPP\nDORI_SLACK_CHANNEL=CHOME1\nDORI_SLACK_OWNER=UOWNER1\nDORI_SLACK_BOT_USER=UBOT1\n`,
  );
  expect(JSON.parse(readFileSync(h.opts.cursorPath, "utf8"))).toEqual({ CHOME1: "1792900000.000000" });
  expect(w.sockets).toBe(1);
  expect(w.hooks).toEqual([["register-task", "--name", "test"]]);
  expect(h.lines.at(-1)).toBe("SETUP_COMPLETE");
  expect(
    h.lines.some(
      (l) =>
        l.startsWith("MONITOR") &&
        l.includes("DELIVERY=stdout bun ~/.dori/inbound-next/run-inbound.ts") &&
        l.includes("wakes_per_hour 3600") &&
        l.includes("human_input true"),
    ),
  ).toBe(true);
  noSecrets(h.lines);
  expect(existsSync(`${h.opts.envPath}.${process.pid}.tmp`)).toBe(false);

  if (process.platform === "win32") {
    const acl = await run([
      "powershell",
      "-NoProfile",
      "-Command",
      `$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); $a = Get-Acl -LiteralPath '${h.opts.envPath}'; "$($a.AreAccessRulesProtected)"; $a.Access | % { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
    ]);
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
    members: [
      { id: "UOWNER1", real_name: "The Owner", is_primary_owner: true },
      { id: "UOTHER", real_name: "Someone" },
    ],
    channels: [
      { id: "CHOME1", name: "01-dori" },
      { id: "CGEN", name: "general" },
    ],
  });
  writeFileSync(join(dir, "slack.env"), "DORI_SLACK_COOKIE=keepme\n");
  const h = harness(w, dir);
  const r = await h.go();
  expect(r.code).toBe(2);
  expect(r.missing).toEqual(["DORI_SLACK_CHANNEL", "DORI_SLACK_OWNER"]);
  const env = readFileSync(h.opts.envPath, "utf8");
  expect(env).toContain(`DORI_SLACK_TOKEN=${BOT}`);
  expect(env).toContain("DORI_SLACK_COOKIE=keepme");
  expect(
    h.lines.some((l) => l.startsWith("NEED") && l.includes("CHOME1 #01-dori") && l.includes("CGEN #general")),
  ).toBe(true);
  expect(h.lines.some((l) => l.startsWith("NEED") && l.includes("primary owner is UOWNER1"))).toBe(true);
  expect(h.lines.at(-1)).toContain("SETUP_INCOMPLETE missing: DORI_SLACK_CHANNEL, DORI_SLACK_OWNER");
  expect(existsSync(h.opts.cursorPath)).toBe(false);
  expect(w.hooks).toEqual([]);
  noSecrets(h.lines);

  const done = await harness(w, dir, { input: { DORI_SLACK_CHANNEL: "CHOME1", DORI_SLACK_OWNER: "UOWNER1" } }).go();
  expect(done.code).toBe(0);
  expect(readFileSync(h.opts.envPath, "utf8")).toContain(
    "DORI_SLACK_COOKIE=keepme\nDORI_SLACK_APP_ID=A0TESTAPP\nDORI_SLACK_CHANNEL=CHOME1\nDORI_SLACK_OWNER=UOWNER1\nDORI_SLACK_BOT_USER=UBOT1\n",
  );
});

test("an invalid bot token, a wrong token kind or a dead app token writes nothing and names the reason", async () => {
  for (const [input, w, reason] of [
    [{ DORI_SLACK_TOKEN: BOT.replace("AbC", "XyZ"), DORI_SLACK_APP_TOKEN: APP }, world(), "auth.test: invalid_auth"],
    [
      { DORI_SLACK_TOKEN: APP, DORI_SLACK_APP_TOKEN: APP },
      world(),
      "expected a bot (xoxb-) or user (xoxp-, xoxc-) token",
    ],
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
