import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FsOps, writeJsonAtomic } from "../src/fsx";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fsx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** A rename that fails with `code` for the first `failures` calls, then performs the real rename. */
const flakyRename = (failures: number, code: string) => {
  let calls = 0;
  const rename = (from: string, to: string) => {
    calls++;
    if (calls <= failures) throw errno(code);
    renameSync(from, to);
  };
  return { rename, calls: () => calls };
};

const fakeOps = (windows: boolean, rename: FsOps["rename"]) => {
  const sleeps: number[] = [];
  const ops: FsOps = {
    windows,
    rename,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { ops, sleeps };
};

const leftoverTmp = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeJsonAtomic", () => {
  test("writes JSON that reads back, creating the directory", async () => {
    const path = join(dir, "lanes", "a.json");
    await writeJsonAtomic(path, { key: "a", n: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ key: "a", n: 1 });
    expect(leftoverTmp()).toEqual([]);
  });

  test("Windows retries a transient EPERM and then succeeds", async () => {
    const path = join(dir, "lane.json");
    const flaky = flakyRename(2, "EPERM");
    const { ops, sleeps } = fakeOps(true, flaky.rename);
    await writeJsonAtomic(path, { ok: true }, ops);
    expect(flaky.calls()).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ ok: true }, null, 1));
    expect(leftoverTmp()).toEqual([]);
  });

  test("Windows gives up after bounded retries, rethrows, and removes the temp file", async () => {
    const path = join(dir, "lane.json");
    const flaky = flakyRename(Number.POSITIVE_INFINITY, "EBUSY");
    const { ops, sleeps } = fakeOps(true, flaky.rename);
    await expect(writeJsonAtomic(path, { ok: true }, ops)).rejects.toThrow("EBUSY");
    expect(flaky.calls()).toBe(6);
    expect(sleeps.length).toBe(5);
    expect(leftoverTmp()).toEqual([]);
  });

  test("Windows does not retry a non-transient error", async () => {
    const path = join(dir, "lane.json");
    const flaky = flakyRename(Number.POSITIVE_INFINITY, "ENOSPC");
    const { ops, sleeps } = fakeOps(true, flaky.rename);
    await expect(writeJsonAtomic(path, {}, ops)).rejects.toThrow("ENOSPC");
    expect(flaky.calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(leftoverTmp()).toEqual([]);
  });

  test("POSIX keeps a single rename with no retry", async () => {
    const path = join(dir, "lane.json");
    const flaky = flakyRename(Number.POSITIVE_INFINITY, "EPERM");
    const { ops, sleeps } = fakeOps(false, flaky.rename);
    await expect(writeJsonAtomic(path, {}, ops)).rejects.toThrow("EPERM");
    expect(flaky.calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(leftoverTmp()).toEqual([]);
  });
});
