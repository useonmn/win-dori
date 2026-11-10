import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchLane } from "../src/launch.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("a narrow pane that cuts the goal footer short reads STARTUP_OK when the lane's own session holds an active goal", async () => {
  // Given a 31-column pane where omo cut its footer to "Pur...", and omo's session store for the lane's cwd.
  const brief = join(state.dir, "brief.md");
  const sessionsDir = join(state.dir, "sessions");
  // The store is named after the lane's cwd the host's way: --repo-- off Windows, ---repo-- on it.
  const store = sessionDirFor(sessionsDir, "/repo");
  mkdirSync(join(store, "extensions", "goal"), { recursive: true });
  let n = 0;
  const session = (at: string, lane: string, status: string | null) => {
    const id = `01a1b6d8-0000-7000-8000-${String(++n).padStart(12, "0")}`;
    const prompt = `ulw set goal and work. Read and execute the lane brief at ${brief} in full. You are the ${lane} lane; report as the brief's footer says.`;
    writeFileSync(
      join(store, `${at.replace(/:/g, "-").replace(".", "-")}_${id}.jsonl`),
      [
        { type: "session", version: 3, id, timestamp: at, cwd: "/repo" },
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: at,
          message: { role: "user", content: [{ type: "text", text: prompt }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    if (status)
      writeFileSync(
        join(store, "extensions", "goal", `${id}.json`),
        JSON.stringify({ version: 1, goal: { id: `g${n}`, threadId: id, objective: "ship it", status } }),
      );
  };
  const launch = async (key: string): Promise<string> => {
    writeFileSync(brief, "# brief\n");
    world = newWorld();
    world.screen = "Working (12s)\n❯ \n (😺 OmO Native by Q Kim) Pur...";
    const base = depsFor(world, fakeClock(T0), state.dir, { sessionsDir });
    const deps = {
      ...base,
      run: async (argv: readonly string[]) => {
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
          return {
            code: 0,
            out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
            err: "",
          };
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list")
          return {
            code: 0,
            out: JSON.stringify({
              result: { panes: [{ pane_id: "w:p9", workspace_id: "w", agent: "pi", agent_status: "working" }] },
            }),
            err: "",
          };
        return base.run(argv);
      },
    };
    return (await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3" })).startup;
  };
  session("2026-01-01T12:00:03.000Z", "narrow-lane", "active");
  session("2026-01-01T12:00:04.000Z", "paused-lane", "paused");
  session("2026-01-01T12:00:05.000Z", "bare-lane", null);
  session("2026-01-01T11:50:00.000Z", "stale-lane", "active");
  // When each lane launches; then only the lane whose own session, started by this launch, has an active goal is OK.
  expect(await launch("narrow-lane")).toBe("STARTUP_OK narrow-lane w:p9");
  expect(await launch("paused-lane")).toStartWith("STARTUP_NO_GOAL paused-lane w:p9");
  expect(await launch("bare-lane")).toStartWith("STARTUP_NO_GOAL bare-lane w:p9");
  expect(await launch("stale-lane")).toStartWith("STARTUP_NO_GOAL stale-lane w:p9");
  // Another lane's active goal in the same cwd is not this lane's goal.
  expect(await launch("narrow")).toStartWith("STARTUP_NO_GOAL narrow w:p9");
});

test("launch opens the lane with DORI_CONFIG and DORI_STATE_DIR of this home, so its reports land here (#197)", async () => {
  const home = join(state.dir, "second-home");
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const before = process.env["DORI_CONFIG"];
  process.env["DORI_CONFIG"] = join(home, "config.json");
  try {
    const deps = depsFor(world, fakeClock(T0), join(home, "state"), { runtime: "hc" });
    await launchLane(deps, { key: "env-lane", title: "t", brief, done: "closed acme/app#3" });
  } finally {
    if (before === undefined) delete process.env["DORI_CONFIG"];
    else process.env["DORI_CONFIG"] = before;
  }
  const create = world.calls.find((c) => c[0] === "hc" && c[2] === "run") ?? [];
  // POSIX: `env K=V ... sh`; Windows (win-dori): one pwsh -Command string with `$env:K = 'V'`.
  const cmd = create.join(" ");
  const hasEnv = (k: string, v: string) => cmd.includes(`${k}=${v}`) || cmd.includes(`$env:${k} = '${v}'`);
  expect(hasEnv("DORI_CONFIG", join(home, "config.json"))).toBe(true);
  expect(hasEnv("DORI_STATE_DIR", join(home, "state"))).toBe(true);
});

test("launch passes the launcher's DORI_SLACK_TOKEN to the lane, so it posts as this home's bot", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const before = process.env["DORI_SLACK_TOKEN"];
  const envOf = async (key: string, token: string | undefined): Promise<string> => {
    if (token === undefined) delete process.env["DORI_SLACK_TOKEN"];
    else process.env["DORI_SLACK_TOKEN"] = token;
    world = newWorld();
    const deps = depsFor(world, fakeClock(T0), join(state.dir, "state"), { runtime: "hc" });
    await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3" });
    const create = world.calls.find((c) => c[0] === "hc" && c[2] === "run") ?? [];
    return create.join(" ");
  };
  try {
    expect(await envOf("token-lane", "xoxb-test-launcher")).toMatch(/DORI_SLACK_TOKEN\W+xoxb-test-launcher/);
    expect(await envOf("bare-token-lane", undefined)).not.toContain("DORI_SLACK_TOKEN");
    expect(await envOf("empty-token-lane", "")).not.toContain("DORI_SLACK_TOKEN");
  } finally {
    if (before === undefined) delete process.env["DORI_SLACK_TOKEN"];
    else process.env["DORI_SLACK_TOKEN"] = before;
  }
});
