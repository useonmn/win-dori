import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  commandKind,
  type Env,
  type GuardDeps,
  lockPath,
  monitorChain,
  readLock,
  scanMonitors,
  takeMonitor,
} from "../src/monitor-guard.ts";
import { watchWinProcess } from "../src/monitor-guard-win.ts";
import type { WinProc } from "../src/win-process.ts";
import { withState } from "./fakes.ts";

const CLI = "C:\\Users\\u\\.bun\\install\\global\\node_modules\\dori-mode-scripts\\src\\cli.ts";
const HOME_A: Env = { DORI_CONFIG: "C:\\homes\\a\\config.json" };
const HOME_B: Env = { DORI_CONFIG: "C:\\homes\\b\\config.json", DORI_STATE_DIR: "C:\\homes\\b\\state" };

/** One armed monitor as Windows shows it: bash -c "dori <kind>" -> dori.exe -> bun .bunx launcher -> mise x -> bun. */
const armed = (base: number, kind = "watch", extra = ""): WinProc[] => {
  const args = `${kind}${extra}`;
  return [
    { pid: base, ppid: 1, cmd: `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "dori ${args}"`, startedAt: base * 10 },
    { pid: base + 1, ppid: base, cmd: `C:\\Users\\u\\.bun\\bin\\dori.exe ${args}`, startedAt: base * 10 + 1 },
    { pid: base + 2, ppid: base + 1, cmd: `bun "${CLI}" ${args}`, startedAt: base * 10 + 2 },
    { pid: base + 3, ppid: base + 2, cmd: `"mise" x -- bun ${CLI} ${args}`, startedAt: base * 10 + 3 },
    {
      pid: base + 4,
      ppid: base + 3,
      cmd: `"C:\\Users\\u\\AppData\\Local\\mise\\installs\\bun\\latest\\bin\\bun.exe" ${CLI} ${args}`,
      startedAt: base * 10 + 4,
    },
  ];
};

type Harness = { deps: GuardDeps; killed: number[]; lines: string[]; gone: Set<number>; table: WinProc[] };

const harness = (stateDir: string, table: WinProc[], self: number, envs: Record<number, Env>): Harness => {
  const h: Harness = { killed: [], lines: [], gone: new Set(), table, deps: undefined as unknown as GuardDeps };
  h.deps = {
    kind: "watch",
    stateDir,
    pid: self,
    env: envs[self] ?? {},
    processes: async () => h.table,
    readEnv: (pid) => envs[pid],
    killTree: async (pid) => void h.killed.push(pid),
    watchProcess: (r) => () => h.gone.has(r.pid),
    now: () => Date.UTC(2026, 10, 8),
    out: (line) => void h.lines.push(line),
  };
  return h;
};

const writeLock = (path: string, lock: object): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lock));
};

test("commandKind: watch always, the other kinds only with a loop, other commands never", () => {
  expect(commandKind(`bun "${CLI}" watch`)).toBe("watch");
  expect(commandKind(`bun ${CLI} freshness`)).toBeUndefined();
  expect(commandKind(`bun ${CLI} freshness --loop 5`)).toBe("freshness");
  expect(commandKind(`bun ${CLI} dead-panes --loop=3`)).toBe("dead-panes");
  expect(commandKind(`bun ${CLI} claim-done x --evidence y`)).toBeUndefined();
  expect(commandKind("bun C:\\other\\src\\cli.ts watch")).toBeUndefined();
});

test("monitorChain walks dori.exe, the bun launcher and the mise hop up to the arming shell", () => {
  expect(monitorChain(armed(100), 104)).toEqual({
    chain: [
      { pid: 103, startedAt: 1003 },
      { pid: 102, startedAt: 1002 },
      { pid: 101, startedAt: 1001 },
    ],
    parent: { pid: 100, startedAt: 1000 },
  });
});

test("monitorChain: a Git Bash fork (same command line under itself) is watched at its outermost copy", () => {
  const table = armed(100).map((p) => (p.pid === 101 ? { ...p, ppid: 150 } : p));
  table.push({ pid: 150, ppid: 100, cmd: table[0]?.cmd ?? "", startedAt: 1000 });
  expect(monitorChain(table, 104).parent).toEqual({ pid: 100, startedAt: 1000 });
});

test("monitorChain: a parent pid now held by a newer process means the arming shell is gone", () => {
  const table = armed(100).map((p) => (p.pid === 100 ? { ...p, cmd: "notepad.exe", startedAt: 99_999 } : p));
  expect(monitorChain(table, 104).parent).toBeUndefined();
  expect(
    monitorChain(
      armed(100).filter((p) => p.pid !== 100),
      104,
    ).parent,
  ).toBeUndefined();
});

test("scanMonitors lists one instance per chain, with its home, and skips a process whose env is unreadable", () => {
  const table = [...armed(100), ...armed(200), ...armed(300, "freshness", " --loop 5")];
  const found = scanMonitors(table, (pid) => (({ 104: HOME_A, 204: HOME_B }) as Record<number, Env>)[pid]);
  expect(found.map((i) => [i.pid, i.kind, i.parent?.pid])).toEqual([
    [104, "watch", 100],
    [204, "watch", 200],
  ]);
  expect(found[0]?.home).not.toBe(found[1]?.home);
});

test("takeMonitor stops a live lock holder's whole tree from its outermost wrapper and takes the lock", async () => {
  const s = withState();
  try {
    const h = harness(s.dir, [...armed(100), ...armed(200)], 204, { 104: HOME_A, 204: HOME_A });
    writeLock(lockPath(s.dir, "watch"), {
      kind: "watch",
      pid: 104,
      startedAt: 1004,
      chain: monitorChain(h.table, 104).chain,
      at: "x",
    });
    const g = await takeMonitor(h.deps);
    expect(h.killed).toEqual([101]);
    expect(g?.replaced).toEqual([104]);
    expect(h.lines).toEqual(["MONITOR_REPLACED watch pid=104 tree=101"]);
    expect(readLock(lockPath(s.dir, "watch"))).toMatchObject({ pid: 204, startedAt: 2004, parent: { pid: 200 } });
  } finally {
    s.done();
  }
});

test("takeMonitor replaces a stale lock (holder gone, or its pid reused) without stopping anything", async () => {
  for (const holder of [
    { pid: 999, startedAt: 9990 },
    { pid: 101, startedAt: 5 },
  ]) {
    const s = withState();
    try {
      const h = harness(s.dir, armed(200), 204, { 204: HOME_A });
      h.table.push({ pid: 101, ppid: 1, cmd: "notepad.exe", startedAt: 777 });
      writeLock(lockPath(s.dir, "watch"), { kind: "watch", ...holder, chain: [], at: "x" });
      await takeMonitor(h.deps);
      expect(h.killed).toEqual([]);
      expect(readLock(lockPath(s.dir, "watch"))?.pid).toBe(204);
    } finally {
      s.done();
    }
  }
});

test("takeMonitor stops a same-home instance that holds no lock (an older dori) but never another home's", async () => {
  const s = withState();
  try {
    const h = harness(s.dir, [...armed(100), ...armed(200), ...armed(300)], 304, {
      104: HOME_A,
      204: HOME_B,
      304: HOME_A,
    });
    await takeMonitor(h.deps);
    expect(h.killed).toEqual([101]);
  } finally {
    s.done();
  }
});

test("check: exits when the arming shell is gone or another instance took the lock; release keeps a lock it lost", async () => {
  const s = withState();
  try {
    const h = harness(s.dir, armed(100), 104, { 104: HOME_A });
    const g = await takeMonitor(h.deps);
    expect(g?.check()).toBeUndefined();
    h.gone.add(100);
    expect(g?.check()).toBe("parent 100 is gone");
    h.gone.clear();
    writeLock(lockPath(s.dir, "watch"), { kind: "watch", pid: 555, chain: [], at: "y" });
    expect(g?.check()).toBe("taken over by pid 555");
    g?.release();
    expect(readLock(lockPath(s.dir, "watch"))?.pid).toBe(555);
  } finally {
    s.done();
  }
});

test("release removes the lock this instance holds; an orphan (no arming shell) is told to exit at once", async () => {
  const s = withState();
  try {
    const h = harness(
      s.dir,
      armed(100).filter((p) => p.pid !== 100),
      104,
      { 104: HOME_A },
    );
    const g = await takeMonitor(h.deps);
    expect(g?.check()).toBe("parent unknown is gone");
    g?.release();
    expect(existsSync(lockPath(s.dir, "watch"))).toBe(false);
  } finally {
    s.done();
  }
});

test("takeMonitor without a readable process table runs unguarded and says so", async () => {
  const s = withState();
  try {
    const h = harness(s.dir, [], 104, {});
    expect(await takeMonitor(h.deps)).toBeUndefined();
    expect(h.lines).toEqual(["MONITOR_WARN watch process table unreadable; running without the singleton"]);
  } finally {
    s.done();
  }
});

test.if(process.platform === "win32")(
  "watchWinProcess: running, exited, and a pid whose start time does not match",
  async () => {
    const child = Bun.spawn(["cmd", "/c", "more"], { stdin: "pipe", stdout: "ignore" });
    const alive = watchWinProcess({ pid: child.pid });
    expect(alive()).toBe(false);
    expect(watchWinProcess({ pid: child.pid, startedAt: 1 })()).toBe(true);
    child.stdin.end();
    await child.exited;
    expect(alive()).toBe(true);
    expect(watchWinProcess({ pid: 999_999 })()).toBe(true);
  },
);
