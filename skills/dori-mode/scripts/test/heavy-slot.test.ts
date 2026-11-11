import { expect, test } from "bun:test";

import { pidAlive, removeStale } from "../src/heavy-slot.ts";
import type { Clock } from "../src/run.ts";

const fakeClock = (slept: number[]): Clock => ({ now: () => 0, sleep: async (ms) => void slept.push(ms) });

const errno = (code: string) => Object.assign(new Error(code), { code });

test.skipIf(process.platform !== "win32")(
  "pidAlive on Windows: live, System (exists but not ours), dead, and exited pids",
  async () => {
    const child = Bun.spawn(["cmd", "/c", "exit", "0"]);
    await child.exited;
    expect(pidAlive(process.pid, true)).toBe(true);
    expect(pidAlive(4, true)).toBe(true);
    expect(pidAlive(child.pid, true)).toBe(false);
    expect(pidAlive(999999, true)).toBe(false);
    expect(pidAlive(0, true)).toBe(false);
    expect(pidAlive(-1, true)).toBe(false);
  },
);

test("pidAlive off Windows: a missing pid is dead without consulting ps", () => {
  expect(pidAlive(999999, false)).toBe(false);
});

test("removeStale retries EBUSY on Windows, then succeeds", async () => {
  const slept: number[] = [];
  let calls = 0;
  const rm = () => {
    if (++calls < 3) throw errno("EBUSY");
  };
  await removeStale("slot", fakeClock(slept), true, rm);
  expect(calls).toBe(3);
  expect(slept.length).toBe(2);
});

test("removeStale gives up after a bounded number of retries", async () => {
  const slept: number[] = [];
  let calls = 0;
  const rm = () => {
    calls++;
    throw errno("EPERM");
  };
  await expect(removeStale("slot", fakeClock(slept), true, rm)).rejects.toThrow("EPERM");
  expect(calls).toBe(slept.length + 1);
  expect(calls).toBeGreaterThan(1);
});

test("removeStale does not retry off Windows or on other errors", async () => {
  const slept: number[] = [];
  let calls = 0;
  const busy = () => {
    calls++;
    throw errno("EBUSY");
  };
  await expect(removeStale("slot", fakeClock(slept), false, busy)).rejects.toThrow("EBUSY");
  const missing = () => {
    calls++;
    throw errno("ENOENT");
  };
  await expect(removeStale("slot", fakeClock(slept), true, missing)).rejects.toThrow("ENOENT");
  expect(calls).toBe(2);
  expect(slept).toEqual([]);
});
