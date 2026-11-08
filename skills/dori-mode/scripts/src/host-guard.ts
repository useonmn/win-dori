import { availableParallelism, homedir } from "node:os";

import type { GuardThresholds } from "./config.ts";
import { IS_WINDOWS } from "./paths.ts";
import { type ChosenRuntimes, type Runner, runtimesFor } from "./run.ts";
import { listSessions } from "./sessions.ts";

export type HostSample = {
  readonly load1: number;
  readonly memFreePct: number;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

export type HostEnv = { readonly windows: boolean; readonly home: string; readonly cpus: number };
const realEnv = (): HostEnv => ({ windows: IS_WINDOWS, home: homedir(), cpus: availableParallelism() });

/** Drive letter ("C:") of the data path; "/" or a path without a drive means the home drive. */
export const windowsDrive = (dataPath: string, home: string): string => {
  const explicit = /^([A-Za-z]):/.exec(dataPath)?.[1] ?? /^([A-Za-z]):/.exec(home)?.[1] ?? "C";
  return `${explicit.toUpperCase()}:`;
};

export const windowsSampleScript = (drive: string): string =>
  [
    "$o=Get-CimInstance Win32_OperatingSystem",
    "$pf=@(Get-CimInstance Win32_PageFileUsage)",
    "$q=@();$c=@();1..5|ForEach-Object{$q+=(Get-CimInstance Win32_PerfFormattedData_PerfOS_System).ProcessorQueueLength;$c+=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime;if($_ -lt 5){Start-Sleep -Milliseconds 250}}",
    `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"`,
    "ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{freeKb=$o.FreePhysicalMemory;totalKb=$o.TotalVisibleMemorySize;pageFiles=@($pf|ForEach-Object{[pscustomobject]@{sizeMb=$_.AllocatedBaseSize;usedMb=$_.CurrentUsage}});queue=($q|Measure-Object -Average).Average;cpuPct=($c|Measure-Object -Average).Average;diskFreeBytes=$d.FreeSpace})",
  ].join(";");

const field = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Parses the PowerShell JSON. Returns null when it is not the expected object; unreadable fields keep the unknown values (memory 100%, disk 0 GB, swap 0 GB, load 0). */
export const parseWindowsSample = (json: string, cpus: number): Omit<HostSample, "panes"> | null => {
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const free = field(o["freeKb"]);
  const total = field(o["totalKb"]);
  const cpu = field(o["cpuPct"]);
  const queue = field(o["queue"]);
  const disk = field(o["diskFreeBytes"]);
  const pf =
    o["pageFiles"] === undefined || o["pageFiles"] === null
      ? []
      : Array.isArray(o["pageFiles"])
        ? o["pageFiles"]
        : [o["pageFiles"]];
  const swapMb = pf.reduce<number>((a, e) => {
    const r = (e ?? {}) as Record<string, unknown>;
    const size = field(r["sizeMb"]);
    const used = field(r["usedMb"]);
    return size === undefined || used === undefined ? a : a + Math.max(0, size - used);
  }, 0);
  return {
    load1: cpu === undefined && queue === undefined ? 0 : ((cpu ?? 0) / 100) * cpus + (queue ?? 0),
    memFreePct: free !== undefined && total !== undefined && total > 0 ? Math.round((free / total) * 100) : 100,
    diskFreeGb: disk === undefined ? 0 : disk / 1_073_741_824,
    swapFreeGb: swapMb / 1024,
  };
};

// A failed session list (no runtime, a refused call) is -1, never 0: an unknown count must not pass the guard.
const sessionCount = (rts: ChosenRuntimes): Promise<number> =>
  listSessions(rts).then(
    (sessions) => sessions.length,
    () => -1,
  );

const sampleWindows = async (run: Runner, dataPath: string, env: HostEnv, rts: ChosenRuntimes): Promise<HostSample> => {
  const r = await run([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsSampleScript(windowsDrive(dataPath, env.home)),
  ]);
  const s = (r.code === 0 ? parseWindowsSample(r.out, env.cpus) : null) ?? {
    load1: 0,
    memFreePct: 100,
    diskFreeGb: 0,
    swapFreeGb: 0,
  };
  return { ...s, panes: await sessionCount(rts) };
};

export const sampleHost = async (
  run: Runner,
  dataPath = "/",
  rts: ChosenRuntimes = runtimesFor({}, process.env, run),
  env: HostEnv = realEnv(),
): Promise<HostSample> => {
  if (env.windows) return sampleWindows(run, dataPath, env, rts);
  const load = await run(["sysctl", "-n", "vm.loadavg"]);
  const loadLinux = load.code === 0 ? null : await run(["cat", "/proc/loadavg"]);
  const load1 = num(
    (load.code === 0 ? load.out.replace(/[{}]/g, "").trim() : (loadLinux?.out ?? "")).split(/\s+/)[0],
    0,
  );
  const mp = await run(["memory_pressure", "-Q"]);
  const memInfo = mp.code === 0 ? null : await run(["cat", "/proc/meminfo"]);
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(memInfo?.out ?? "");
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal"),
    available = kb("MemAvailable");
  const memFreePct =
    mp.code === 0
      ? num(/free percentage: (\d+)%/.exec(mp.out)?.[1], 100)
      : total !== null && total > 0 && available !== null
        ? Math.round((available / total) * 100)
        : 100;
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap.out)?.[1], 0) / 1024;
  // A failed session list (no runtime, a refused call) is -1, never 0: an unknown count must not pass the guard.
  const panes = await listSessions(rts).then(
    (sessions) => sessions.length,
    () => -1,
  );
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct < t.memFreeMinPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(
      alerting
        ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
        : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`,
    );
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(
      ready
        ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}`
        : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`,
    );
    state.computeReady = ready;
  }
  return out;
};
