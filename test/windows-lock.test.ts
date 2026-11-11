import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Deps } from "../src/harness.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { Store } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-win-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the loop lock", () => {
  const lockFiles = (d: { store: Store }) =>
    readdirSync(join(d.store.root, "loop")).filter((f) => f.startsWith("lock"));
  const deadPid = async (): Promise<number> => {
    const p = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return p.pid;
  };
  const deps = () => ({ store: new Store(mkdtempSync(join(dir, "lock-"))), now: Date.now }) as unknown as Deps;

  test("acquire and release leave nothing behind; a live holder blocks; a dead holder is taken over", async () => {
    const d = deps();
    const first = acquire(d);
    if (!("nonce" in first)) throw new Error(first.holder);
    expect(acquire(d)).toEqual({ holder: `locked by pid ${process.pid}` });
    release(d, first.nonce);
    expect(lockFiles(d)).toEqual([]);

    const pid = await deadPid();
    writeFileSync(d.store.loopPath("lock"), JSON.stringify({ pid, at: 0, nonce: "dead" }));
    const next = acquire(d);
    if (!("nonce" in next)) throw new Error(next.holder);
    expect(readFileSync(d.store.loopPath("lock"), "utf8")).toContain(next.nonce);
    expect(lockFiles(d)).toEqual(["lock"]);
    release(d, next.nonce);
    expect(lockFiles(d)).toEqual([]);
  });

  const race = async () => {
    const d = deps();
    const racer = resolve(import.meta.dir, "fixtures/lock-racer.ts");
    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, racer, d.store.root], { stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
    );
    const lines = procs.map((p) => {
      const reader = p.stdout.getReader();
      let text = "";
      return async (): Promise<string> => {
        while (!text.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`lock racer ${p.pid} exited early: ${text}`);
          text += new TextDecoder().decode(value);
        }
        const at = text.indexOf("\n");
        const line = text.slice(0, at).trim();
        text = text.slice(at + 1);
        return line;
      };
    });
    expect(await Promise.all(lines.map((next) => next()))).toEqual(procs.map(() => "READY"));
    for (const p of procs) {
      p.stdin.write("go\n");
      await p.stdin.flush();
    }
    const results = (await Promise.all(lines.map((next) => next()))).map(
      (l) => JSON.parse(l) as { nonce?: string; holder?: string },
    );
    const winners = results.filter((r) => r.nonce);
    expect(winners).toHaveLength(1);
    expect(lockFiles(d)).toEqual(["lock"]);
    expect(readFileSync(d.store.loopPath("lock"), "utf8")).toContain(winners[0]!.nonce!);
    for (const r of results) if (!r.nonce) expect(r.holder).toMatch(/locked by pid|lock contended|lock changed hands/);
    for (const p of procs) await p.stdin.end();
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual(procs.map(() => 0));
    expect(lockFiles(d)).toEqual([]);
  };

  test("real processes racing for a free lock: exactly one wins, and release clears it", () => race(), 60_000);
});
