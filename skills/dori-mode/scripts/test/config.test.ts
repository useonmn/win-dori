import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { defaultConfig, envFilePath, expandHome, fill, loadConfig, loadEnvFile } from "../src/config.ts";
import { footer } from "../src/launch.ts";
import { withState } from "./fakes.ts";

const state = withState();
// An inherited DORI_STATE_DIR (a lead shell, an isolated test run) would override every stateDir this file checks.
beforeEach(() => {
  delete process.env.DORI_STATE_DIR;
});
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe(join("/home/ana", ".dori", "state"));
  expect(c.defaultCwd).toBe(join("/home/ana", "code", "my-project"));
  expect(c.paneShell).toBe("auto");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.agentCommand).toEqual(["omo", "--model", "{model}", "{prompt}"]);
});

test("the secrets file wins over an inherited value, keeps = inside values, and skips comments; a missing file changes nothing", async () => {
  const path = join(state.dir, "slack.env");
  await Bun.write(path, "# comment\r\nDORI_SLACK_TOKEN=xoxb-from-file\r\nDORI_SLACK_CHANNEL=C1\nODD=a=b\n\n");
  const env: Record<string, string | undefined> = { DORI_SLACK_TOKEN: "xoxb-stale-inherited", OTHER: "kept" };
  await loadEnvFile(path, env);
  expect(env).toEqual({ DORI_SLACK_TOKEN: "xoxb-from-file", DORI_SLACK_CHANNEL: "C1", ODD: "a=b", OTHER: "kept" });
  const untouched = { A: "1" };
  await loadEnvFile(join(state.dir, "missing.env"), untouched);
  expect(untouched).toEqual({ A: "1" });
  expect(envFilePath("C:\\Users\\ana")).toBe(join("C:\\Users\\ana", ".dori", "slack.env"));
});

test("repoIdentities keys are matched as lowercase owner/repo, whatever case the file uses", async () => {
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ repoIdentities: { "Acme/App": { name: "Example Dev", email: "dev@example.com" } } }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.repoIdentities["acme/app"]).toEqual({ name: "Example Dev", email: "dev@example.com" });
});

test("malformed repoIdentities entries are dropped, so launch still writes its footer and verify-pr reports the repo as unconfigured", async () => {
  const path = join(state.dir, "config.json");
  const good = { name: "Example Dev", email: "dev@example.com" };
  await Bun.write(path, JSON.stringify({ repoIdentities: { "acme/null": null, "acme/text": "dev@example.com", "acme/number": { name: 1, email: "dev@example.com" }, "acme/blank": { name: "Example Dev", email: " " }, "acme/app": good } }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.repoIdentities).toEqual({ "acme/app": good });
  const lane = { key: "demo-lane", title: "demo", thread: "none", brief: "/b.md", done: "merged acme/app#1", openedAt: "2026-01-01T00:00:00Z" };
  expect(footer(lane, "w1:p1", c.repoIdentities)).toContain("  - acme/app: git -c user.name='Example Dev'");
  for (const value of [null, "acme", [good]]) {
    await Bun.write(path, JSON.stringify({ repoIdentities: value }));
    expect((await loadConfig(path, "/home/ana")).repoIdentities).toEqual({});
  }
});

test("a goalMarker that is not a string falls back to the default, so a typo never turns the goal check off", async () => {
  const path = join(state.dir, "config.json");
  for (const value of [null, false, 0, {}, ["Pursuing goal"]]) {
    await Bun.write(path, JSON.stringify({ goalMarker: value }));
    expect((await loadConfig(path, "/home/ana")).goalMarker).toBe("Pursuing goal");
  }
  // An empty string is the documented way to turn the check off, so it is kept.
  await Bun.write(path, JSON.stringify({ goalMarker: "" }));
  expect((await loadConfig(path, "/home/ana")).goalMarker).toBe("");
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

test("expandHome handles ~ with either separator and a Windows home", () => {
  expect(expandHome("~", "C:\\Users\\ana")).toBe("C:\\Users\\ana");
  expect(expandHome("~/code", "/home/ana")).toBe(join("/home/ana", "code"));
  expect(expandHome("~\\code", "/home/ana")).toBe(join("/home/ana", "code"));
  expect(expandHome("/abs/path", "/home/ana")).toBe("/abs/path");
});

test("Windows-style home paths expand into the default locations", () => {
  const home = "C:\\Users\\ana";
  expect(defaultConfig(home).stateDir).toBe(join(home, ".dori", "state"));
  expect(expandHome("~/.dori/state", home)).toBe(join(home, ".dori", "state"));
});
