import { linkSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isTransient, realFsOps, removeFile, renameRetrying, retrying, type FsOps } from "./fsx.ts";
import { INBOX_LOCK_STALE_MS } from "./store-types.ts";

// Retried on Windows sharing errors: a lock read that failed for a moment must not leave the lock behind on release.
const readOrUndefined = (path: string, ops: FsOps): string | undefined => {
  try {
    return retrying(() => readFileSync(path, "utf8"), ops);
  } catch {
    return undefined;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** An unreadable lock (a holder that died between create and write) is judged by the file's age. */
function lockStale(path: string, content: string, now: number): boolean {
  let lock: { pid?: unknown; host?: unknown; at?: unknown } = {};
  try {
    lock = JSON.parse(content) as typeof lock;
  } catch {
    // fall through to the file's mtime
  }
  // On this host the pid decides: a live holder keeps its lock however long a herdr call takes, or a second flush
  // would deliver the same batch again. The age rule is only for locks from another host or locks that can't be read.
  if (lock.host === hostname() && typeof lock.pid === "number") return !pidAlive(lock.pid);
  const at =
    typeof lock.at === "number"
      ? lock.at
      : (() => {
          try {
            return statSync(path).mtimeMs;
          } catch {
            return now;
          }
        })();
  return now - at > INBOX_LOCK_STALE_MS;
}

export function takeInboxLock(path: string, now: number, ops: FsOps = realFsOps): (() => void) | undefined {
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: now });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return () => {
        if (readOrUndefined(path, ops) === mine) removeFile(path, ops);
      };
    } catch (e) {
      // On Windows a lock still being deleted (another process holds a handle) or scanned refuses wx with
      // EPERM/EACCES/EBUSY instead of EEXIST: it is still someone else's lock.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !isTransient(e, ops)) throw e;
    }
    const seen = readOrUndefined(path, ops);
    if (seen === undefined) continue;
    if (!lockStale(path, seen, now)) return undefined;
    const aside = `${path}.${process.pid}.stale`;
    try {
      renameRetrying(path, aside, ops);
    } catch {
      continue;
    }
    if (readOrUndefined(aside, ops) !== seen) {
      try {
        linkSync(aside, path);
      } catch {
        // a third process holds the lock now; either way it is not ours
      }
      removeFile(aside, ops);
      return undefined;
    }
    removeFile(aside, ops);
  }
  return undefined;
}
