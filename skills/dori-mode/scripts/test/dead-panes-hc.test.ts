import { afterEach, beforeEach, expect, test } from "bun:test";

import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("on hc a stopped lane in a watched group is reported: groups are listed by their dori.group label", async () => {
  // Given an hc lead and a lane of group g1 whose agent stopped (a shell in front, the dead marker on screen).
  const shell = { name: "pwsh.exe", argv: ["pwsh.exe"], pid: 900 };
  world.terminals = {
    t1: hcTerm({ labels: { "dori.group": "g1", "dori.role": "lead" } }),
    t2: hcTerm({
      labels: { "dori.group": "g1", "dori.role": "lane", "dori.lane": "k" },
      status: null,
      foreground: shell,
      screen: "omo has stopped\nPS C:\\w> ",
    }),
  };
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", workspaces: ["g1"], leadPane: "t1" });
  const seen = new Set<string>();
  const st = newDeadPaneState();
  // When two ticks read the same tail; then the lane is reported once and the lead never.
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual(["DEAD_PANE t2"]);
});
