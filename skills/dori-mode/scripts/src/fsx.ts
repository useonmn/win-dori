import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { IS_WINDOWS } from "./paths.ts";

/** Injectable file operations, so tests can drive both the Windows and POSIX branches on any host. */
export type FsOps = {
  readonly windows: boolean;
  readonly rename: (from: string, to: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
};

export const realFsOps: FsOps = { windows: IS_WINDOWS, rename: renameSync, sleep: (ms) => Bun.sleep(ms) };

// Windows refuses a rename over a file another process has open (a watcher, a sync monitor, antivirus) with one of these.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const BACKOFF_MS = [10, 20, 40, 80, 160];

/** Injectable synchronous retry, for writers that cannot await (a lock taken and released inside a sync call). */
export type SyncRetryOps = {
  readonly windows: boolean;
  readonly sleep: (ms: number) => void;
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
export const realSyncRetry: SyncRetryOps = { windows: IS_WINDOWS, sleep: sleepSync };

/** True for the codes Windows gives while another process briefly holds a file open or a delete is pending. */
export const isTransientWindowsError = (e: unknown): boolean => TRANSIENT.has((e as NodeJS.ErrnoException)?.code ?? "");

/** Runs `fn`, retrying it with the same backoff as writeJsonAtomic on a transient Windows error; elsewhere, and for any other error, the first failure is final. */
export const retryTransientSync = <T>(fn: () => T, ops: SyncRetryOps = realSyncRetry): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!ops.windows || !isTransientWindowsError(e) || attempt >= BACKOFF_MS.length) throw e;
      ops.sleep(BACKOFF_MS[attempt]!);
    }
  }
};

let seq = 0;
const tmpPath = (path: string): string => `${path}.${process.pid}.${++seq}.tmp`;

const renameRetrying = async (from: string, to: string, ops: FsOps): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      ops.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!ops.windows || !TRANSIENT.has(code) || attempt >= BACKOFF_MS.length) throw e;
      await ops.sleep(BACKOFF_MS[attempt]!);
    }
  }
};

/** Writes JSON through a unique temp file and renames it over `path`, so a reader never sees a half-written file. */
export const writeJsonAtomic = async (path: string, data: unknown, ops: FsOps = realFsOps): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpPath(path);
  try {
    await Bun.write(tmp, JSON.stringify(data, null, 1));
    await renameRetrying(tmp, path, ops);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};

/** Reads and parses a JSON file; null when it is missing, including one removed after a directory listing. */
export const readJsonFile = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};
