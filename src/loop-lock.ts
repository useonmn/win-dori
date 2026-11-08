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

type LockFile = ReturnType<typeof readLock>;
export type LockDeps = Pick<Deps, "store" | "now">;

/**
 * Moves the dead holder's lock `seen` aside, or says why this process must back off. Only the process holding the
 * `.takeover` guard may touch the lock, and it looks again under the guard: without that, a process that judged the
 * lock stale a moment ago could move the live lock a faster process just created, and a third could slip in.
 */
function takeOver(path: string, tmp: string, seen: LockFile, nonce: string): string | undefined {
  const guard = `${path}.takeover`;
  try {
    linkSync(tmp, guard);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !isTransient(e)) throw e;
    const other = readLock(guard);
    if (other === "corrupt" || (typeof other !== "string" && !alive(other.pid))) removeFile(guard);
    return "lock contended";
  }
  try {
    if (!sameLock(readLock(path), seen)) return "lock changed hands during takeover";
    const aside = `${path}.stale.${nonce}`;
    try {
      renameRetrying(path, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (isTransient(e)) return "lock contended";
      throw e;
    }
    if (!sameLock(readLock(aside), seen)) {
      restore(aside, path);
      return "lock changed hands during takeover";
    }
    removeFile(aside);
    return undefined;
  } finally {
    removeFile(guard);
  }
}

/**
 * The lock is created whole with link(2), so it never exists half-written. A dead holder's (or corrupt) lock is
 * moved aside with rename(2) under a guard only one process can hold; if what was moved is not the lock judged
 * stale, it is linked back and this process backs off.
 */
export function acquire(d: LockDeps): { nonce: string } | { holder: string } {
  const path = d.store.loopPath("lock");
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
      const refused = takeOver(path, tmp, seen, nonce);
      if (refused) return { holder: refused };
    }
    return { holder: "lock contended" };
  } finally {
    removeFile(tmp);
  }
}

export const holds = (d: Deps, nonce: string): boolean => {
  const l = readLock(d.store.loopPath("lock"));
  return typeof l !== "string" && l.nonce === nonce;
};

export function release(d: LockDeps, nonce: string): void {
  const path = d.store.loopPath("lock");
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
