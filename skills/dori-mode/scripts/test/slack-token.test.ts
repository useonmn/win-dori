import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchLane } from "../src/launch.ts";
import { slackToken, TokenFileError } from "../src/slack-token.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const KEYS = ["DORI_CONFIG", "DORI_SLACK_TOKEN", "DORI_SLACK_TOKEN_FILE"] as const;
let state: ReturnType<typeof withState>;
let world: World;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  state = withState();
  world = newWorld();
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  state.done();
});

const tokenFile = (dir: string, text: string, mode: number): string => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slack-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

const launchArgv = async (home: string, key: string): Promise<string[][]> => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  process.env["DORI_CONFIG"] = join(home, "config.json");
  world = newWorld();
  await launchLane(depsFor(world, fakeClock(T0), join(home, "state"), { runtime: "hc" }), {
    key,
    title: "t",
    brief,
    done: "closed acme/app#3",
  });
  return world.calls.map((c) => [...c]);
};

test("the create argv for a lane never contains the token value, only the token file's path (#200)", async () => {
  // Given a launcher with a token in its env and this home's owner-only token file next to its config.
  const home = join(state.dir, "home");
  const file = tokenFile(home, "xoxb-file-secret\n", 0o600);
  process.env["DORI_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  // When the lane is created on hc, which puts every env value on the command line.
  const calls = await launchArgv(home, "token-lane");
  // Then no argv of any call holds a token, and the lane gets the path with DORI_SLACK_TOKEN blanked.
  expect(calls.flat().filter((arg) => arg.includes("xoxb-"))).toEqual([]);
  const create = calls.find((c) => c[0] === "hc" && c.includes("run") && c.includes("--bg")) ?? [];
  // POSIX: `env K=V ... sh`, one element per variable; Windows: one pwsh -Command string of `$env:K = 'V'`.
  const hasEnv = (k: string, v: string) =>
    create.includes(`${k}=${v}`) || create.join(" ").includes(`$env:${k} = '${v}'`);
  expect(hasEnv("DORI_SLACK_TOKEN_FILE", file)).toBe(true);
  expect(hasEnv("DORI_SLACK_TOKEN", "")).toBe(true);
});

test("with no token file the lane env is unchanged, as in a single-home setup", async () => {
  process.env["DORI_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const calls = await launchArgv(join(state.dir, "plain-home"), "plain-lane");
  expect(calls.flat().filter((arg) => arg.includes("DORI_SLACK_TOKEN") || arg.includes("xoxb-"))).toEqual([]);
});

test("DORI_SLACK_TOKEN is read first, then the token file when the variable is unset or empty", () => {
  const file = tokenFile(join(state.dir, "t"), "  xoxb-from-file\n", 0o600);
  expect(slackToken({ DORI_SLACK_TOKEN: "xoxb-from-env", DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-env");
  expect(slackToken({ DORI_SLACK_TOKEN: "", DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-file");
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-file");
  expect(slackToken({})).toBeUndefined();
});

test("a token file open to group or others is refused on POSIX; Windows has no mode bits to check", () => {
  const file = tokenFile(join(state.dir, "open"), "xoxb-open\n", 0o644);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux")).toThrow(/is open to group or others.*chmod 600/);
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "win32")).toBe("xoxb-open");
});

test("a missing or empty token file is refused, never read as no token", () => {
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: join(state.dir, "absent") })).toThrow(TokenFileError);
  const empty = tokenFile(join(state.dir, "empty"), "\n", 0o600);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: empty })).toThrow(/is empty/);
});
