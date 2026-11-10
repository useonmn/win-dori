import { type Env, isLive, lockPath, MONITOR_KINDS, readLock, scanMonitors, homeKey } from "./monitor-guard.ts";
import type { WinProc } from "./win-process.ts";

export type DuplicateReport = { readonly lines: readonly string[]; readonly duplicates: number };

/** `dori status`: this home's monitor instances, and a MONITOR_DUPLICATE warning per kind running more than once. */
export const monitorStatus = (
  table: readonly WinProc[],
  readEnv: (pid: number) => Env | undefined,
  env: Env,
  stateDir: string,
): DuplicateReport => {
  const home = homeKey(env);
  const mine = scanMonitors(table, readEnv).filter((i) => i.home === home);
  const lines: string[] = [];
  let duplicates = 0;
  for (const kind of MONITOR_KINDS) {
    const of = mine.filter((i) => i.kind === kind);
    const lock = readLock(lockPath(stateDir, kind));
    const holder = lock && isLive(table, lock) ? ` lock=${lock.pid}` : "";
    for (const i of of)
      lines.push(
        `MONITOR ${kind} pid=${i.pid} parent=${i.parent?.pid ?? "gone"}${i.startedAt ? ` started=${new Date(i.startedAt).toISOString()}` : ""}${holder}`,
      );
    if (!of.length) lines.push(`MONITOR ${kind} none`);
    if (of.length > 1) {
      duplicates++;
      lines.push(`MONITOR_DUPLICATE ${kind} ${of.length} instances for this home: ${of.map((i) => i.pid).join(", ")}`);
    }
  }
  return { lines, duplicates };
};
