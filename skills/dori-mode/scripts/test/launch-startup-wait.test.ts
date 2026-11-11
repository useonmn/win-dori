import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// How long launch waits for an agent that is slow to come up, and what still ends that wait at once (#202).

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

// A status that stands for a runtime that cannot list its sessions.
const LOOKUP_ERROR = "(lookup error)";

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

test("an agent that has not reported is waited for until startupWaitSeconds; a lookup error, a shell or a failure ends the wait at once", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  let waits = 0;
  // herdr lists an agent that has not reported as "unknown", and a pane with no agent (undefined here) as a shell.
  const run = async (
    status: (string | undefined)[],
    screen: string | string[],
    key: string,
    patch: { startupWaitSeconds?: number; goalMarker?: string } = {},
  ) => {
    const statuses = [...status];
    world = newWorld();
    if (Array.isArray(screen)) world.screens = [...screen];
    else world.screen = screen;
    waits = 0;
    const base = depsFor(world, { ...fakeClock(T0), sleep: async () => void waits++ }, state.dir, patch);
    const deps = {
      ...base,
      run: async (argv: readonly string[]) => {
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
          return {
            code: 0,
            out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
            err: "",
          };
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") {
          const s = statuses.length > 1 ? statuses.shift() : statuses[0];
          if (s === LOOKUP_ERROR) return { code: 1, out: "", err: "herdr is not running" };
          const agent = s ? { agent: "pi", agent_status: s } : {};
          return {
            code: 0,
            out: JSON.stringify({ result: { panes: [{ pane_id: "w:p9", workspace_id: "w", ...agent }] } }),
            err: "",
          };
        }
        return base.run(argv);
      },
    };
    return (await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3" })).startup;
  };
  const goal = "❯ \n Pursuing goal (1m)";
  // A slow host: the agent has not reported at the first check, then it comes up and sets its goal.
  expect(
    await run(["unknown", "unknown", "unknown", "idle"], ["PS> & omo", "PS> & omo", "PS> & omo", goal], "slow"),
  ).toBe("STARTUP_OK slow w:p9");
  // An agent that never comes up is unconfirmed after the whole wait (20 s, then sixteen 10 s re-reads), never OK.
  expect(await run(["unknown"], "PS> & omo", "never")).toStartWith(
    "STARTUP_UNCONFIRMED never w:p9: no ready agent status (unknown) after",
  );
  expect(waits).toBe(17);
  // An agent that has not reported is never OK, even when its goal already shows, with or without a goal marker.
  expect(await run(["unknown"], goal, "goal-unreported")).toStartWith(
    "STARTUP_UNCONFIRMED goal-unreported w:p9: no ready agent status (unknown)",
  );
  expect(await run(["unknown"], goal, "goal-unreported-nomarker", { goalMarker: "" })).toStartWith(
    "STARTUP_UNCONFIRMED goal-unreported-nomarker w:p9: no ready agent status (unknown)",
  );
  // The wait is config: a 60 s host gives up after the first check and four re-reads.
  expect(await run(["unknown"], "PS> & omo", "short", { startupWaitSeconds: 60 })).toStartWith(
    "STARTUP_UNCONFIRMED short w:p9",
  );
  expect(waits).toBe(5);
  // A lookup error or a shell ends it at once, at the first check or during the wait.
  expect(await run([LOOKUP_ERROR], "PS> & omo", "err-first")).toStartWith(
    "STARTUP_UNCONFIRMED err-first w:p9: status lookup failed",
  );
  expect(waits).toBe(1);
  expect(await run(["unknown", LOOKUP_ERROR], "PS> & omo", "err-later")).toStartWith(
    "STARTUP_UNCONFIRMED err-later w:p9: status lookup failed",
  );
  expect(waits).toBe(2);
  expect(await run([undefined], "$ ", "shell-first")).toStartWith(
    "STARTUP_UNCONFIRMED shell-first w:p9: no ready agent status (shell)",
  );
  expect(waits).toBe(1);
  expect(await run(["unknown", undefined], "$ ", "shell-later")).toStartWith(
    "STARTUP_UNCONFIRMED shell-later w:p9: agent status became shell",
  );
  expect(waits).toBe(2);
  // A failure that shows while the agent has not reported ends the wait too.
  expect(await run(["unknown"], ["PS> & omo", "No API key found\n$ "], "fail-later")).toBe(
    "STARTUP_ERROR fail-later w:p9: No API key",
  );
  expect(waits).toBe(2);
});

test("on hc, a program that has not reported a status yet is waited for, and one that never does is unconfirmed", async () => {
  // Given hc, whose list shows no status until the program reports one (what a slow omo start looks like, #202).
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  // Only the launch's own checks count: on Windows, hc's ready() first polls the new shell with short sleeps.
  const sleeps: number[] = [];
  const deps = depsFor(world, { ...fakeClock(T0), sleep: async (ms: number) => void sleeps.push(ms) }, state.dir, {
    runtime: "hc",
  });
  // When the launch runs and the program never reports.
  const { startup } = await launchLane(deps, { key: "hc-never", title: "t", brief, done: "closed acme/app#3" });
  // Then it waited the whole time and says so, rather than giving up at the first check or calling it a start.
  expect(startup).toStartWith("STARTUP_UNCONFIRMED hc-never t1: no ready agent status (none) after");
  expect(sleeps.filter((ms) => ms >= 10_000)).toEqual([20_000, ...Array<number>(16).fill(10_000)]);
});
