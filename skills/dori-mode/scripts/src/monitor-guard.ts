import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { baseName, pathKey } from "./paths.ts";
import { parseWindowsCommandLine, type WinProc } from "./win-process.ts";

/**
 * Long-running monitors on Windows. A monitor is started as `dori.exe <kind>` from a shell an agent session armed,
 * and reaches the real bun through wrappers (bun's own .bunx launcher, then any version-manager shim such as
 * `mise x -- bun`). When the session dies only the top of that chain goes away; the bun below keeps running with no
 * parent, and the next session starts another one. So each monitor kind runs once per Dori home: a new instance
 * stops the old one's whole tree and takes over, and every instance exits on its own when the process that armed it
 * is gone or another instance took over.
 */

export const MONITOR_KINDS = ["watch", "freshness", "dead-panes", "guard"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const CHECK_MS = 30_000;

export type ProcRef = { readonly pid: number; readonly startedAt?: number };
export type MonitorLock = {
  readonly kind: string;
  readonly pid: number;
  readonly startedAt?: number;
  readonly chain: readonly ProcRef[];
  readonly parent?: ProcRef;
  readonly at: string;
};
export type Instance = ProcRef & {
  readonly kind: MonitorKind;
  readonly home: string;
  readonly chain: readonly ProcRef[];
  readonly parent?: ProcRef;
};
export type Env = Record<string, string | undefined>;

const isKind = (value: string | undefined): value is MonitorKind =>
  (MONITOR_KINDS as readonly string[]).includes(value ?? "");

/** watch always loops; the other kinds are monitors only with `--loop N`, N > 0 (a one-shot run is not one). */
export const monitorKind = (command: string, loopMin: number): MonitorKind | undefined =>
  command === "watch" || (isKind(command) && loopMin > 0) ? command : undefined;

const CLI = /dori-mode.*[\\/]src[\\/]cli\.ts$/i;

/** The monitor kind a process command line runs (`bun ...dori-mode...\src\cli.ts <kind> [--loop N]`), if any. */
export const commandKind = (cmd: string): MonitorKind | undefined => {
  const args = parseWindowsCommandLine(cmd);
  const at = args.findIndex((a) => CLI.test(a));
  if (at < 0) return undefined;
  const [command, ...rest] = args.slice(at + 1);
  const loopAt = rest.findIndex((a) => a === "--loop" || a.startsWith("--loop="));
  const loop = loopAt < 0 ? 0 : Number(rest[loopAt]?.includes("=") ? rest[loopAt]?.split("=")[1] : rest[loopAt + 1]);
  return monitorKind(command ?? "", Number.isFinite(loop) ? loop : 0);
};

const image = (cmd: string): string =>
  baseName(parseWindowsCommandLine(cmd)[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");

/** A launcher between the arming shell and the monitor: dori.exe, a mise hop, or a bun running the same cli.ts. */
const isWrapper = (p: WinProc): boolean =>
  image(p.cmd) === "dori" || image(p.cmd) === "mise" || commandKind(p.cmd) !== undefined;

const ref = (p: WinProc): ProcRef =>
  p.startedAt === undefined ? { pid: p.pid } : { pid: p.pid, startedAt: p.startedAt };

/** True when `r` is still the same process: its pid is listed with the same start time (a reused pid is not). */
export const isLive = (table: readonly WinProc[], r: ProcRef): boolean =>
  table.some(
    (p) => p.pid === r.pid && (r.startedAt === undefined || p.startedAt === undefined || p.startedAt === r.startedAt),
  );

/**
 * The wrappers above `pid` (nearest first) and the process that armed it: the nearest ancestor that is not a
 * wrapper, or `explicitParent` when given. A parent link to a pid started after its child is a reused pid, so the
 * walk stops there: the real parent is gone.
 */
export const monitorChain = (
  table: readonly WinProc[],
  pid: number,
  explicitParent?: number,
): { chain: ProcRef[]; parent?: ProcRef } => {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const chain: ProcRef[] = [];
  let cur = byPid.get(pid);
  let parent: WinProc | undefined;
  while (cur) {
    const up = byPid.get(cur.ppid);
    if (
      !up ||
      up.pid === cur.pid ||
      (up.startedAt !== undefined && cur.startedAt !== undefined && up.startedAt > cur.startedAt)
    )
      break;
    if (!isWrapper(up)) {
      parent = up;
      // Git Bash runs `bash -c "cmd > file"` as a bash forking a copy of itself with the same command line; the
      // session holds the outer one, so the watch goes on the outermost copy.
      for (
        let outer = byPid.get(parent.ppid);
        outer && outer.pid !== parent.pid && outer.cmd === parent.cmd;
        outer = byPid.get(outer.ppid)
      )
        parent = outer;
      break;
    }
    chain.push(ref(up));
    cur = up;
  }
  if (explicitParent !== undefined) parent = byPid.get(explicitParent);
  return parent ? { chain, parent: ref(parent) } : { chain };
};

/** Which Dori home an environment points at: its config file and state directory, as the CLI resolves them. */
export const homeKey = (env: Env): string =>
  `${pathKey(env["DORI_CONFIG"] ?? join(env["USERPROFILE"] ?? env["HOME"] ?? homedir(), ".dori", "config.json"))}|${pathKey(env["DORI_STATE_DIR"] ?? "")}`;

/**
 * Running monitor instances: the innermost process of each chain (the real bun; its wrappers carry the same command
 * line). A process whose environment cannot be read has no known home and is left out, so it is never stopped.
 */
export const scanMonitors = (table: readonly WinProc[], readEnv: (pid: number) => Env | undefined): Instance[] => {
  const kinds = new Map(
    table.flatMap((p) => {
      const kind = commandKind(p.cmd);
      return kind ? [[p.pid, kind] as const] : [];
    }),
  );
  return table.flatMap((p) => {
    const kind = kinds.get(p.pid);
    if (!kind || table.some((c) => c.ppid === p.pid && c.pid !== p.pid && kinds.get(c.pid) === kind)) return [];
    const env = readEnv(p.pid);
    return env ? [{ ...ref(p), kind, home: homeKey(env), ...monitorChain(table, p.pid) }] : [];
  });
};

export const lockPath = (stateDir: string, kind: MonitorKind): string => join(stateDir, "run", `${kind}.json`);

export const readLock = (path: string): MonitorLock | undefined => {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as MonitorLock;
    return typeof lock?.pid === "number" && Array.isArray(lock.chain) ? lock : undefined;
  } catch {
    return undefined;
  }
};

/** The process to stop for a whole instance: its outermost wrapper still running, else the instance itself. */
export const treeTop = (
  table: readonly WinProc[],
  instance: ProcRef & { readonly chain: readonly ProcRef[] },
): ProcRef => [...instance.chain].reverse().find((r) => isLive(table, r)) ?? instance;

export type GuardDeps = {
  readonly kind: MonitorKind;
  readonly stateDir: string;
  readonly pid: number;
  readonly env: Env;
  readonly processes: () => Promise<WinProc[]>;
  readonly readEnv: (pid: number) => Env | undefined;
  readonly killTree: (pid: number) => Promise<void>;
  /** Returns a check that is true once the process is gone; a pid that is not `r` any more counts as gone. */
  readonly watchProcess: (r: ProcRef) => () => boolean;
  readonly now: () => number;
  readonly out: (line: string) => void;
};

export type Guard = {
  readonly lock: MonitorLock;
  readonly replaced: readonly number[];
  /** The reason this instance must exit now, or undefined to keep running. */
  readonly check: () => string | undefined;
  readonly release: () => void;
};

/**
 * Takes the singleton for (home, kind): stops the lock holder and any other instance of the kind for this home, then
 * writes the lock. Returns undefined when the process table cannot be read (the monitor then runs unguarded, as before).
 */
export const takeMonitor = async (d: GuardDeps): Promise<Guard | undefined> => {
  const table = await d.processes();
  const self = table.find((p) => p.pid === d.pid);
  if (!self) {
    d.out(`MONITOR_WARN ${d.kind} process table unreadable; running without the singleton`);
    return undefined;
  }
  const path = lockPath(d.stateDir, d.kind);
  const home = homeKey(d.env);
  const old = readLock(path);
  const victims = new Map<number, ProcRef & { chain: readonly ProcRef[] }>();
  if (old && old.pid !== d.pid && isLive(table, old)) victims.set(old.pid, old);
  for (const i of scanMonitors(table, d.readEnv)) {
    if (i.pid !== d.pid && i.kind === d.kind && i.home === home) victims.set(i.pid, i);
  }
  const replaced: number[] = [];
  for (const v of victims.values()) {
    const top = treeTop(table, v);
    await d.killTree(top.pid);
    replaced.push(v.pid);
    d.out(`MONITOR_REPLACED ${d.kind} pid=${v.pid} tree=${top.pid}`);
  }
  const explicit = Number(d.env["DORI_MONITOR_PARENT"]);
  const mine = monitorChain(table, d.pid, Number.isInteger(explicit) && explicit > 0 ? explicit : undefined);
  const lock: MonitorLock = { kind: d.kind, ...ref(self), ...mine, at: new Date(d.now()).toISOString() };
  mkdirSync(join(d.stateDir, "run"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
  const parentGone = mine.parent ? d.watchProcess(mine.parent) : () => true;
  return {
    lock,
    replaced,
    check: () => {
      if (parentGone()) return `parent ${mine.parent?.pid ?? "unknown"} is gone`;
      const now = readLock(path);
      return now && now.pid !== d.pid ? `taken over by pid ${now.pid}` : undefined;
    },
    release: () => {
      if (readLock(path)?.pid !== d.pid) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone or held open for a moment; the next instance treats a dead holder as stale anyway.
      }
    },
  };
};
