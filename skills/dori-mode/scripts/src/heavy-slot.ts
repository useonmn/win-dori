import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IS_WINDOWS } from "./paths.ts";
import type { Clock } from "./run.ts";

export type SlotDeps = {
  readonly dir: string;
  readonly slots: number;
  readonly maxLoad: number;
  readonly clock: Clock;
  readonly load: () => Promise<number>;
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
};

const ORPHAN_MS = 60_000;
const RM_RETRIES = 20;
const RM_RETRY_MS = 100;

/**
 * Removes a stale slot. On Windows a file another process still has open fails with EBUSY or EPERM for a moment, so
 * those are retried; elsewhere, and for any other error, the first failure is final.
 */
export const removeStale = async (
  slot: string,
  clock: Clock,
  windows = IS_WINDOWS,
  rm: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      rm(slot);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!windows || (code !== "EBUSY" && code !== "EPERM") || attempt >= RM_RETRIES) throw e;
      await clock.sleep(RM_RETRY_MS);
    }
  }
};

const tryTake = async (deps: SlotDeps, n: number, label: string): Promise<string | null> => {
  const slot = join(deps.dir, `slot.${n}`);
  const claim = (): string | null => {
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    writeFileSync(join(slot, "owner"), `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`);
    return slot;
  };
  const got = claim();
  if (got) return got;
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch {
    owner = "";
  }
  const pid = Number(owner.split(" ")[0]);
  const orphaned = owner ? !deps.alive(pid) : deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  if (!orphaned) return null;
  await removeStale(slot, deps.clock);
  return claim();
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  mkdirSync(deps.dir, { recursive: true });
  for (;;) {
    if ((await deps.load()) < deps.maxLoad) {
      for (let n = 1; n <= deps.slots; n++) {
        const slot = await tryTake(deps, n, label);
        if (slot) return slot;
      }
    }
    await deps.clock.sleep(pollMs);
  }
};

export const releaseSlot = (slot: string): void => rmSync(slot, { recursive: true, force: true });

export const pidAlive = (pid: number, windows = IS_WINDOWS): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    // Windows reports a live pid that is not ours (e.g. System, pid 4) as EPERM; there are no zombies to check.
    return windows && (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (windows) return true;
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
};
