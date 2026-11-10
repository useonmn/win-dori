// Drives profile/install-profile.ps1 and the boot script in Windows PowerShell (what a fresh PC has) against a temp
// home folder: no scheduled task is registered (-NoTask, or -DryRun).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

setDefaultTimeout(60_000);
const PROFILE = join(import.meta.dir, "..");
const SCRIPT = join(PROFILE, "install-profile.ps1");
const BOOT = join(PROFILE, "dori", "boot", "dori-boot.ps1");
const EXAMPLE = join(PROFILE, "..", "skills", "dori-mode", "references", "config.example.json");
let root = "";
let home = "";
let dori = "";

const ps = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    // Inherited DORI_* values (a lead shell's messenger tokens) would leak into what the tests assert.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith("DORI_")),
      ),
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
};
const install = (...extra: string[]) => ps(["-File", SCRIPT, "-NoTask", ...extra]);
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const fakeHerdr = (ws: string) => {
  const herdr = join(root, `fake-herdr-${ws}.cmd`);
  writeFileSync(
    herdr,
    `@echo off\r\nif not "%2"=="create" exit /b 0\r\necho {"result":{"workspace":{"workspace_id":"${ws}"},"pane_id":"${ws}:p1"}}\r\n`,
  );
  return herdr;
};

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
});

test("a second run changes nothing", async () => {
  const r = await install();
  expect(r.code).toBe(0);
  expect(r.out).toContain("0 added, 0 updated, 0 replaced");
  expect(r.out).toContain("Nothing changed");
});

test("a local edit is kept and shown, -DryRun touches nothing, -Force replaces it with a backup", async () => {
  const k = join(dori, "boot", "dori-boot.ps1");
  const original = readFileSync(k, "utf8");
  writeFileSync(k, `${original}\n# LOCAL = 1\n`);
  const kept = await install();
  expect(kept.out).toMatch(/keep\s+boot\/dori-boot\.ps1 \(local edits/);
  expect(kept.out).toContain("local | # LOCAL = 1");
  expect(readFileSync(k, "utf8")).toContain("LOCAL = 1");

  const dry = await install("-DryRun", "-Force");
  expect(dry.out).toMatch(/would replace\s+boot\/dori-boot\.ps1/);
  expect(readFileSync(k, "utf8")).toContain("LOCAL = 1");

  const forced = await install("-Force");
  expect(readFileSync(k, "utf8")).toBe(original);
  const backups = readdirSync(join(dori, "boot")).filter((n) => n.startsWith("dori-boot.ps1.bak-"));
  expect(backups.length).toBe(1);
  expect(readFileSync(join(dori, "boot", backups[0]!), "utf8")).toContain("LOCAL = 1");
  expect(forced.out).toContain("To undo this run");
});

test("config.json is never touched, even with -Force", async () => {
  const c = join(dori, "config.json");
  writeFileSync(c, JSON.stringify({ leadPane: "wX:p9" }));
  await install("-Force");
  expect(JSON.parse(readFileSync(c, "utf8")).leadPane).toBe("wX:p9");
});

test("the task is registered without any messenger set up; -TaskOnly only registers it", async () => {
  const name = `Dori Autostart Test-${process.pid}-${Date.now()}`;
  const r = await ps(["-File", SCRIPT, "-DryRun", "-TaskName", name]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`would register task '${name}'`);
  const only = await ps(["-File", SCRIPT, "-TaskOnly", "-DryRun", "-TaskName", name]);
  expect(only.code).toBe(0);
  expect(only.out).toContain(`would register task '${name}'`);
  expect(only.out).not.toContain("files:");
});

test("boot writes this PC's herdr ids into config.json and keeps the other settings; the workspace is named after the Dori", async () => {
  const c = join(dori, "config.json");
  writeFileSync(c, readFileSync(EXAMPLE));
  const herdr = fakeHerdr("wQ");
  const off = await ps(["-File", BOOT, "-Herdr", herdr, "-NoLaunch"]);
  expect(off.out).toContain("BOOT_OK pane=wQ:p1 workspace=wQ name=Dori");
  const cfg = JSON.parse(readFileSync(c, "utf8"));
  expect([cfg.leadPane, cfg.laneWorkspace, cfg.workspaces, cfg.ignorePanes]).toEqual([
    "wQ:p1",
    "wQ",
    ["wQ"],
    ["wQ:p1"],
  ]);
  expect(cfg.defaultModel).toBe(JSON.parse(readFileSync(EXAMPLE, "utf8")).defaultModel);
  expect(cfg.guard.panesMax).toBe(20);

  const named = await ps(["-File", BOOT, "-Herdr", herdr, "-NoLaunch"], { DORI_NAME: "ShipDori" });
  expect(named.out).toContain("name=ShipDori");
  expect(existsSync(join(dori, "state", "boot.log"))).toBe(true);
});

test("with runtime hc, boot opens a labelled hc terminal and writes its address and the group into config.json", async () => {
  const c = join(dori, "config.json");
  writeFileSync(c, JSON.stringify({ ...JSON.parse(readFileSync(EXAMPLE, "utf8")), runtime: "hc" }));
  const hc = join(root, "fake-hc.cmd");
  const log = join(root, "fake-hc.log");
  writeFileSync(
    hc,
    `@echo off\r\necho %* >> "${log}"\r\nif "%2"=="run" echo {"address":"t3","state":"live"}\r\nexit /b 0\r\n`,
  );
  const r = await ps(["-File", BOOT, "-Hc", hc, "-Herdr", join(root, "no-herdr.cmd"), "-NoLaunch"]);
  expect(r.out).toContain("BOOT_OK pane=t3 workspace=dori name=Dori");
  expect(r.out).toContain("runtime=hc");
  const cfg = JSON.parse(readFileSync(c, "utf8"));
  expect([cfg.leadPane, cfg.laneWorkspace, cfg.workspaces, cfg.ignorePanes, cfg.runtime]).toEqual([
    "t3",
    "dori",
    ["dori"],
    ["t3"],
    "hc",
  ]);
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain("--json run --bg --no-parent --no-notify");
  expect(calls).toContain("dori.group=dori");
  expect(calls).toContain("dori.role=lead");
  expect(calls).not.toContain("--keep");
});

test("boot picks the messenger from environment variables and tells the agent to arm upstream's inbound poll", async () => {
  writeFileSync(join(dori, "config.json"), readFileSync(EXAMPLE));
  const herdr = fakeHerdr("wM");
  const boot = (env: Record<string, string>) => ps(["-File", BOOT, "-Herdr", herdr, "-NoLaunch"], env);
  const slack = await boot({ DORI_SLACK_TOKEN: "xoxb-test-only" });
  expect(slack.out).toContain("messenger=slack");
  expect(slack.out).toContain("dori inbound slack --loop 1");
  expect(slack.out).not.toContain("xoxb-test-only");
  const tg = await boot({ DORI_TELEGRAM_TOKEN: "123:test-only" });
  expect(tg.out).toContain("messenger=telegram");
  expect(tg.out).toContain("dori inbound telegram --loop 1");
  const forced = await boot({ DORI_SLACK_TOKEN: "xoxb-test-only", DORI_MESSENGER: "Discord" });
  expect(forced.out).toContain("messenger=discord");
  const none = await boot({});
  expect(none.out).toContain("messenger=none");
  const line = none.out.split(/\r?\n/).find((l) => l.startsWith("BOOT_LINE ")) ?? "";
  expect(line).toMatch(/^BOOT_LINE & 'omo' '--model' '[^']+' 'Dori mode\. /);
});
