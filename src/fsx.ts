// Synchronous rename-into-place; the retry mirrors skills/dori-mode/scripts/src/fsx.ts.

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { IS_WINDOWS } from "./shell.ts";

/** Injectable file operations, so tests can drive both the Windows and POSIX branches on any host. */
export type FsOps = {
  readonly windows: boolean;
  readonly rename: (from: string, to: string) => void;
  readonly sleep: (ms: number) => void;
};

export const realFsOps: FsOps = { windows: IS_WINDOWS, rename: renameSync, sleep: (ms) => Bun.sleepSync(ms) };

// Windows refuses a rename over a file another process has open (a watcher, a sync monitor, antivirus) with one of these,
// and antivirus also holds a file just written. These backoffs run longer than the skills package's, because on a
// saturated host that scan can outlast its 310 ms.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const BACKOFF_MS = [10, 20, 40, 80, 160, 320, 640, 1280];

export const isTransient = (e: unknown, ops: FsOps = realFsOps): boolean =>
  ops.windows && TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "");

/** Runs `op`, waiting out the sharing errors above on Windows. */
export const retrying = <T>(op: () => T, ops: FsOps = realFsOps): T => {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (e) {
      if (!isTransient(e, ops) || attempt >= BACKOFF_MS.length) throw e;
      ops.sleep(BACKOFF_MS[attempt]!);
    }
  }
};

export const renameRetrying = (from: string, to: string, ops: FsOps = realFsOps): void => retrying(() => ops.rename(from, to), ops);

/** Removes a file that may still be held; one that stays held is left behind rather than failing the work it served. */
export const removeFile = (path: string, ops: FsOps = realFsOps): void => {
  try {
    retrying(() => rmSync(path, { force: true }), ops);
  } catch (e) {
    if (!isTransient(e, ops)) throw e;
  }
};

/** Writes `text` to `tmp` and moves it over `path`, so a reader never sees a half-written file. A failed move leaves no temp file behind. */
export const replaceFile = (tmp: string, path: string, text: string, ops: FsOps = realFsOps, mode?: number): void => {
  retrying(() => writeFileSync(tmp, text, mode === undefined ? {} : { mode }), ops);
  try {
    renameRetrying(tmp, path, ops);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};
