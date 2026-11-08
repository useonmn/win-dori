// Drives profile/install-profile.ps1 and the boot script in Windows PowerShell (what a fresh PC has) against a temp
// home folder: no scheduled task, no prompts.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

setDefaultTimeout(60_000);
const PROFILE = join(import.meta.dir, "..");
const SCRIPT = join(PROFILE, "install-profile.ps1");
const BOOT = join(PROFILE, "dori", "boot", "dori-boot.ps1");
let root = "";
let home = "";
let dori = "";

const ps = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    // An inherited DORI_HOME (an isolated test run, a lead shell) would send the install outside the test home, as inHome knows.
    env: { ...Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith("DORI_"))), USERPROFILE: home, HOME: home, LOCALAPPDATA: join(home, "AppData", "Local"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
};
const install = (...extra: string[]) =>
  ps(["-File", SCRIPT, "-NoTask", "-NoPrompt", "-SecretsFromEnv", ...extra], {
    DORI_SLACK_TOKEN: "xoxb-test-only",
    DORI_SLACK_APP_TOKEN: "xapp-test-only",
    DORI_SLACK_APP_ID: "ATEST",
    DORI_SLACK_CHANNEL: "CTEST",
    DORI_SLACK_OWNER: "UOWNER",
    DORI_SLACK_BOT_USER: "UBOT",
  });
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dori-profile-test-"));
  home = join(root, "Users", "someone");
  dori = join(home, ".dori");
  mkdirSync(home, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a fresh home gets every profile file, with no absolute home path inside", async () => {
  const r = await install();
  expect(r.code).toBe(0);
  for (const f of files(join(PROFILE, "dori"))) {
    const placed = join(dori, relative(join(PROFILE, "dori"), f));
    expect(readFileSync(placed)).toEqual(readFileSync(f));
    expect(readFileSync(placed, "utf8")).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]/i);
  }
  expect(r.out).not.toContain("xoxb-test-only");
});

test("slack.env holds the values and only the current user can read it", async () => {
  const env = readFileSync(join(dori, "slack.env"), "utf8");
  for (const kv of ["DORI_SLACK_TOKEN=xoxb-test-only", "DORI_SLACK_OWNER=UOWNER", "DORI_SLACK_BOT_USER=UBOT", "DORI_SLACK_CHANNEL=CTEST"]) expect(env).toContain(kv);
  for (const f of ["slack.env"]) {
    const acl = await ps(["-Command", `$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); $a = Get-Acl -LiteralPath '${join(dori, f)}'; "$($a.AreAccessRulesProtected)"; $a.Access | % { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`]);
    const [prot, ...rest] = acl.out.trim().split(/\r?\n/);
    const me = rest.pop();
    expect(prot).toBe("True");
    expect(rest).toEqual([me!]);
  }
});

test("a second run changes nothing", async () => {
  const r = await install();
  expect(r.code).toBe(0);
  expect(r.out).toContain("0 added, 0 updated, 0 replaced");
  expect(r.out).toContain("Nothing changed");
});

test("a local edit is kept and shown, -DryRun touches nothing, -Force replaces it with a backup", async () => {
  const k = join(dori, "slack-manifest.json");
  const original = readFileSync(k, "utf8");
  writeFileSync(k, original + "\nexport const LOCAL = 1;\n");
  const kept = await install();
  expect(kept.out).toMatch(/keep\s+slack-manifest\.json \(local edits/);
  expect(kept.out).toContain("local | export const LOCAL = 1;");
  expect(readFileSync(k, "utf8")).toContain("LOCAL = 1");

  const dry = await install("-DryRun", "-Force");
  expect(dry.out).toMatch(/would replace\s+slack-manifest\.json/);
  expect(readFileSync(k, "utf8")).toContain("LOCAL = 1");

  const forced = await install("-Force");
  expect(readFileSync(k, "utf8")).toBe(original);
  const backups = readdirSync(dori).filter((n) => n.startsWith("slack-manifest.json.bak-"));
  expect(backups.length).toBe(1);
  expect(readFileSync(join(dori, backups[0]!), "utf8")).toContain("LOCAL = 1");
  expect(forced.out).toContain("To undo this run");
});

test("config.json is never replaced, even with -Force", async () => {
  const c = join(dori, "config.json");
  writeFileSync(c, JSON.stringify({ leadPane: "wX:p9" }));
  await install("-Force");
  expect(JSON.parse(readFileSync(c, "utf8")).leadPane).toBe("wX:p9");
});

test("boot writes this PC's herdr ids into config.json and keeps the other settings; the workspace is named after the Dori", async () => {
  const c = join(dori, "config.json");
  writeFileSync(c, readFileSync(join(PROFILE, "dori", "config.json")));
  const herdr = join(root, "fake-herdr.cmd");
  writeFileSync(herdr, '@echo off\r\nif not "%2"=="create" exit /b 0\r\necho {"result":{"workspace":{"workspace_id":"wQ"},"pane_id":"wQ:p1"}}\r\n');
  const off = await ps(["-File", BOOT, "-Herdr", herdr, "-NoLaunch"]);
  expect(off.out).toContain("BOOT_OK pane=wQ:p1 workspace=wQ name=Dori");
  const cfg = JSON.parse(readFileSync(c, "utf8"));
  expect([cfg.leadPane, cfg.laneWorkspace, cfg.workspaces, cfg.ignorePanes]).toEqual(["wQ:p1", "wQ", ["wQ"], ["wQ:p1"]]);
  expect(cfg.defaultModel).toBe(JSON.parse(readFileSync(join(PROFILE, "dori", "config.json"), "utf8")).defaultModel);
  expect(cfg.guard.panesMax).toBe(20);

  const named = await ps(["-File", BOOT, "-Herdr", herdr, "-NoLaunch"], { DORI_NAME: "ShipDori" });
  expect(named.out).toContain("name=ShipDori");
  expect(existsSync(join(dori, "state", "boot.log"))).toBe(true);
});

test("secrets never reach user environment variables: the script has no SetEnvironmentVariable and HKCU holds no test value", async () => {
  expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/SetEnvironmentVariable/i);
  const r = await install("-Force");
  expect(r.out).not.toMatch(/environment variable/i);
  const hkcu = await ps(["-Command", "foreach ($k in 'DORI_SLACK_TOKEN','DORI_SLACK_APP_TOKEN','DORI_SLACK_APP_ID','DORI_SLACK_CHANNEL','DORI_SLACK_OWNER','DORI_SLACK_BOT_USER') { [Environment]::GetEnvironmentVariable($k, 'User') }"]);
  for (const v of ["xoxb-test-only", "xapp-test-only", "ATEST", "CTEST", "UOWNER", "UBOT"]) expect(hkcu.out).not.toContain(v);
});

test("by default nothing is asked and inherited DORI_SLACK_* values are ignored: no slack.env, the task is deferred until a messenger env file is complete, -TaskOnly refuses", async () => {
  const bare = join(root, "Users", "fresh");
  mkdirSync(bare, { recursive: true });
  const name = `Dori Autostart Test-${process.pid}-${Date.now()}`;
  const clean = Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith("DORI_")));
  const run = async (args: string[]) => {
    const p = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-DoriHome", join(bare, ".dori"), "-TaskName", name, ...args], {
      env: { ...clean, DORI_SLACK_TOKEN: "xoxb-inherited-stale", DORI_SLACK_OWNER: "USTALE", USERPROFILE: bare, HOME: bare, LOCALAPPDATA: join(bare, "AppData", "Local") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out + err };
  };
  const r = await run([]);
  expect(r.code).toBe(0);
  expect(existsSync(join(bare, ".dori", "slack-manifest.json"))).toBe(true);
  expect(existsSync(join(bare, ".dori", "slack.env"))).toBe(false);
  expect(r.out).toContain("say 'Dori mode'");
  expect(r.out).toContain(`task     '${name}' not registered yet`);
  const only = await run(["-TaskOnly"]);
  expect(only.code).toBe(2);
  expect(only.out).toContain("not registered yet");
  const q = Bun.spawn(["schtasks", "/query", "/tn", name], { stdout: "ignore", stderr: "ignore" });
  expect(await q.exited).not.toBe(0);
});

// Telegram and Discord get the same Windows flow as Slack: their env file alone gates the task and picks the boot messenger.
const freshHome = (label: string) => {
  const h = join(root, "Users", `${label}-${Date.now()}`);
  mkdirSync(join(h, ".dori"), { recursive: true });
  return h;
};
const inHome = async (h: string, args: string[], env: Record<string, string> = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith("DORI_")));
  const p = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    env: { ...clean, USERPROFILE: h, HOME: h, LOCALAPPDATA: join(h, "AppData", "Local"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
};

test("telegram.env alone gates the task: a partial one names the missing key and -TaskOnly refuses, a complete one is enough to register", async () => {
  const h = freshHome("tg");
  const tg = join(h, ".dori", "telegram.env");
  writeFileSync(tg, "DORI_TELEGRAM_TOKEN=123456:test-only\nDORI_TELEGRAM_BOT=dori_test_bot\n");
  const partial = await inHome(h, ["-File", SCRIPT, "-TaskOnly", "-TaskName", "Dori Autostart Never"]);
  expect(partial.code).toBe(2);
  expect(partial.out).toContain("telegram.env is missing DORI_TELEGRAM_OWNER");
  writeFileSync(tg, "DORI_TELEGRAM_TOKEN=123456:test-only\nDORI_TELEGRAM_BOT=dori_test_bot\nDORI_TELEGRAM_OWNER=42\n");
  const complete = await inHome(h, ["-File", SCRIPT, "-TaskOnly", "-DryRun", "-TaskName", "Dori Autostart Never"]);
  expect(complete.code).toBe(0);
  expect(complete.out).toContain("would register task 'Dori Autostart Never'");
  expect(complete.out).not.toContain("slack.env");
});

test("-SecretsFromEnv writes discord.env owner-only, and the boot script picks discord from it (DORI_MESSENGER overrides)", async () => {
  const h = freshHome("dc");
  const r = await inHome(h, ["-File", SCRIPT, "-NoTask", "-NoPrompt", "-SecretsFromEnv"], {
    DORI_DISCORD_TOKEN: "discord-test-only",
    DORI_DISCORD_APP_ID: "111",
    DORI_DISCORD_BOT_USER: "222",
    DORI_DISCORD_OWNER: "333",
  });
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("discord-test-only");
  expect(r.out).not.toContain("no messenger is set up yet");
  expect(readFileSync(join(h, ".dori", "discord.env"), "utf8")).toContain("DORI_DISCORD_OWNER=333");
  expect(existsSync(join(h, ".dori", "slack.env"))).toBe(false);
  const acl = await inHome(h, ["-Command", `$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); $a = Get-Acl -LiteralPath '${join(h, ".dori", "discord.env")}'; "$($a.AreAccessRulesProtected)"; $a.Access.Count`]);
  expect(acl.out.trim().split(/\r?\n/)).toEqual(["True", "1"]);

  const herdr = join(root, "fake-herdr.cmd");
  writeFileSync(herdr, '@echo off\r\nif not "%2"=="create" exit /b 0\r\necho {"result":{"workspace":{"workspace_id":"wD"},"pane_id":"wD:p1"}}\r\n');
  const boot = await inHome(h, ["-File", join(h, ".dori", "boot", "dori-boot.ps1"), "-Herdr", herdr, "-NoLaunch"]);
  expect(boot.out).toContain("messenger=discord");
  const forced = await inHome(h, ["-File", join(h, ".dori", "boot", "dori-boot.ps1"), "-Herdr", herdr, "-NoLaunch"], { DORI_MESSENGER: "telegram" });
  expect(forced.out).toContain("messenger=telegram");
  const none = freshHome("none");
  const empty = await inHome(none, ["-File", BOOT, "-Herdr", herdr, "-NoLaunch"]);
  expect(empty.out).toContain("messenger=none");
});
