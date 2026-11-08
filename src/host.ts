import { execFileSync } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";

const sysctlMemoryLevel = (): string =>
  execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

// The sampling of host-guard's windowsSampleScript. PSModulePath is dropped because a value inherited from pwsh breaks
// module loading in PowerShell 5.1.
const WINDOWS_LOAD_SCRIPT = [
  "$q=@();$c=@();1..5|ForEach-Object{$q+=(Get-CimInstance Win32_PerfFormattedData_PerfOS_System).ProcessorQueueLength;$c+=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime;if($_ -lt 5){Start-Sleep -Milliseconds 250}}",
  "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{queue=($q|Measure-Object -Average).Average;cpuPct=($c|Measure-Object -Average).Average})",
].join(";");

const sampleWindowsLoad = (): string => {
  const { PSModulePath: _inherited, ...env } = process.env;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LOAD_SCRIPT], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env,
  });
};

const cpuTimes = () =>
  cpus().reduce(
    (t, { times: c }) => ({ idle: t.idle + c.idle, total: t.total + c.user + c.nice + c.sys + c.idle + c.irq }),
    { idle: 0, total: 0 },
  );

/** Share of CPU time in use over a short window, from the counters os.cpus() reports on every platform. */
function busyShare(read = cpuTimes, sleep: (ms: number) => void = (ms) => Bun.sleepSync(ms)): number {
  const a = read();
  sleep(500);
  const b = read();
  return b.total > a.total ? 1 - (b.idle - a.idle) / (b.total - a.total) : 0;
}

/**
 * Windows has no load average (os.loadavg() is always 0), so this is host-guard's figure: CPU use times cores, plus the
 * processor queue, which stands for the waiting work a load average counts. Without the queue the figure could never
 * pass the core count the hourly loop compares it with. An unreadable sample falls back to CPU use alone.
 */
export function windowsLoad(
  cores: number,
  sample: () => string = sampleWindowsLoad,
  busy: () => number = busyShare,
): number {
  try {
    const { cpuPct, queue } = JSON.parse(sample()) as { cpuPct?: unknown; queue?: unknown };
    if (typeof cpuPct === "number") return (cpuPct / 100) * cores + (typeof queue === "number" ? queue : 0);
  } catch {
    // fall through to os.cpus(): PowerShell or its performance counters may be unavailable
  }
  return busy() * cores;
}

export const load1 = (platform: string = process.platform, windows: (cores: number) => number = windowsLoad): number =>
  platform === "win32" ? windows(cpus().length) : (loadavg()[0] ?? 0);
