import { linkSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isTransient, removeFile, renameRetrying, retrying } from "./fsx.ts";
import type { Deps } from "./harness.ts";

type LockBody = { pid: number; at: number; nonce: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockBody | "missing" | "corrupt" {
  let text: string;
  try {
    text = retrying(() => readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || isTransient(e)) return "missing"; // on Windows a file being moved or deleted can refuse a read
    throw e;
  }
  try {
    const v = JSON.parse(text) as Partial<LockBody>;
    return typeof v.pid === "number" && typeof v.nonce === "string" ? (v as LockBody) : "corrupt";
  } catch {
    return "corrupt";
  }
}

const sameLock = (a: LockBody | "missing" | "corrupt", b: LockBody | "missing" | "corrupt"): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : a.nonce === b.nonce;

/**
 * The lock is created whole with link(2), so it never exists half-written. A dead holder's (or corrupt) lock is
 * moved aside with rename(2), which only one process can win; if what was moved is not the lock judged stale, it
 * is linked back and this process backs off.
 */
export function acquire(d: Deps, path: string = d.store.lockPath("loop")): { nonce: string } | { holder: string } {
  const nonce = randomUUID();
  const tmp = `${path}.${nonce}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: d.now(), nonce }));
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(tmp, path);
        return { nonce };
      } catch (e) {
        if (isTransient(e)) continue; // Windows reports a name that is still being deleted this way
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const seen = readLock(path);
      if (seen === "missing") continue;
      if (seen !== "corrupt" && alive(seen.pid)) return { holder: `locked by pid ${seen.pid}` };
      const aside = `${path}.stale.${nonce}`;
      try {
        renameRetrying(path, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (!sameLock(readLock(aside), seen)) {
        restore(aside, path);
        return { holder: "lock changed hands during takeover" };
      }
      removeFile(aside);
    }
    return { holder: "lock contended" };
  } finally {
    removeFile(tmp);
  }
}

export const holds = (d: Deps, nonce: string): boolean => {
  const l = readLock(d.store.lockPath("loop"));
  return typeof l !== "string" && l.nonce === nonce;
};

export function release(d: Deps, nonce: string, path: string = d.store.lockPath("loop")): void {
  const aside = `${path}.release.${nonce}`;
  try {
    renameRetrying(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const moved = readLock(aside);
  if (typeof moved === "string" || moved.nonce !== nonce) restore(aside, path);
  else removeFile(aside);
}

/** Puts a lock that was moved by mistake back. If a newer lock took its place, the moved one is left aside, never deleted. */
export function restore(aside: string, path: string): void {
  try {
    linkSync(aside, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST" || isTransient(e)) return;
    throw e;
  }
  removeFile(aside);
}
