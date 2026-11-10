import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { realFsOps, type FsOps } from "../src/fsx.ts";
import { backlogAdd } from "../src/backlog.ts";
import { load1, windowsLoad } from "../src/host.ts";
import { loopTick } from "../src/loop.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { Store } from "../src/store.ts";
import { Telemetry } from "../src/telemetry.ts";
import { href } from "./fake.ts";
import { setup } from "./windows-helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-win-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("host load", () => {
  test("Windows load is CPU use times cores plus the queue, so a saturated host passes the core count", () => {
    expect(windowsLoad(4, () => '{"queue":3,"cpuPct":50}')).toBe(5);
    expect(windowsLoad(4, () => '{"queue":6,"cpuPct":100}')).toBeGreaterThan(4);
    expect(windowsLoad(8, () => '{"cpuPct":25}')).toBe(2);
    expect(load1("win32", (cores) => cores + 0.5)).toBe(cpus().length + 0.5);
  });

  test("an unreadable sample falls back to CPU use instead of reporting an idle host", () => {
    for (const bad of [
      () => "not json",
      () => "{}",
      () => {
        throw new Error("no powershell");
      },
    ]) {
      expect(windowsLoad(4, bad, () => 0.5)).toBe(2);
    }
  });

  test("a host busy by the Windows figure holds the loop's starts", async () => {
    const { w, d, brief } = setup();
    backlogAdd(d, "held-item", brief, { cwd: d.store.root });
    w.host = { load1: windowsLoad(4, () => '{"queue":6,"cpuPct":100}'), cores: 4, memFreePct: 50 };
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    expect(run.held[0]).toBe("host busy: load 10.0 (limit 4), mem free 50%");
  });

  test.skipIf(!IS_WINDOWS)(
    "the real sample parses on this host and is not the always-zero os.loadavg()",
    () => {
      const load = windowsLoad(cpus().length, undefined, () => {
        throw new Error("sample did not parse");
      });
      expect(Number.isFinite(load)).toBe(true);
      expect(load1()).toBeGreaterThan(0);
    },
    30_000,
  );
});

describe("rename over an open file", () => {
  const flaky = (failures: number, code = "EPERM"): FsOps & { sleeps: number[] } => {
    const sleeps: number[] = [];
    let left = failures;
    return {
      windows: true,
      sleeps,
      sleep: (ms) => {
        sleeps.push(ms);
      },
      rename: (from, to) => {
        if (left-- > 0) throw Object.assign(new Error(code), { code });
        renameSync(from, to);
      },
    };
  };
  const leftovers = (home: string) => readdirSync(home).filter((f) => f.endsWith(".tmp"));

  test("Store retries the Windows sharing errors and gets the write through", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const ops = flaky(3, code);
      const s = new Store(mkdtempSync(join(dir, "store-")), ops);
      s.setRole("lead", href("w1:p1"));
      expect(s.roles().lead).toEqual(href("w1:p1"));
      expect(ops.sleeps).toEqual([10, 20, 40]);
    }
  });

  test("off Windows, or for any other error, the failure is immediate; a failed write leaves no temp file", () => {
    const posix = new Store(mkdtempSync(join(dir, "store-")), { ...flaky(1), windows: false });
    expect(() => posix.setRole("lead", href("w1:p1"))).toThrow("EPERM");
    expect(leftovers(posix.root)).toEqual([]);
    const other = flaky(1, "ENOSPC");
    expect(() => new Store(mkdtempSync(join(dir, "store-")), other).setRole("lead", href("w1:p1"))).toThrow("ENOSPC");
    expect(other.sleeps).toEqual([]);
    const stuck = flaky(99);
    const s = new Store(mkdtempSync(join(dir, "store-")), stuck);
    expect(() => s.setRole("lead", href("w1:p1"))).toThrow("EPERM");
    expect(stuck.sleeps).toEqual([10, 20, 40, 80, 160, 320, 640, 1280]);
    expect(leftovers(s.root)).toEqual([]);
  });

  test("telemetry's state file gets the same retry", async () => {
    const home = mkdtempSync(join(dir, "tel-"));
    const ops = flaky(2);
    const t = new Telemetry(
      home,
      {},
      async () => ({ status: 200, text: JSON.stringify({ key: "k" }) }),
      () => 0,
      () => {},
      ops,
    );
    t.touch();
    await t.flush(5000);
    expect(ops.sleeps).toEqual([10, 20]);
    expect(JSON.parse(readFileSync(join(home, "telemetry.json"), "utf8")).noticeShown).toBe(true);
  });

  test.skipIf(!IS_WINDOWS)(
    "a real process holding the target without share-delete: the write waits it out",
    async () => {
      const s = new Store(mkdtempSync(join(dir, "store-")));
      s.setRole("lead", href("w1:p1"));
      const target = join(s.root, "roles.json");
      // HELD only once the handle is really open; a failed Open prints why instead of a false HELD.
      const script =
        "try{$f=[IO.File]::Open($env:DORI_TARGET,'Open','Read','None')}catch{[Console]::Out.WriteLine('OPEN FAILED: '+$_);exit 1};[Console]::Out.WriteLine('HELD');[Console]::In.ReadToEnd()|Out-Null;$f.Close()";
      const holder = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, DORI_TARGET: target },
      });
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("HELD");

      // Free means the target can be renamed away and back. A plain open is not a probe: on an admin
      // runner Bun's openSync succeeds through another process's share-none handle, while a rename
      // still fails.
      const free = (): boolean => {
        try {
          renameSync(target, `${target}.probe`);
        } catch {
          return false;
        }
        renameSync(`${target}.probe`, target);
        return true;
      };
      expect(free()).toBe(false);
      writeFileSync(join(s.root, "probe"), "x");
      expect(() => renameSync(join(s.root, "probe"), target)).toThrow(/EPERM|EACCES|EBUSY/);

      let released = false;
      const stubborn = new Store(s.root, { ...realFsOps, sleep: () => {} });
      expect(() => stubborn.setRole("duty", href("w1:p2"))).toThrow(/EPERM|EACCES|EBUSY/);
      const ops: FsOps = {
        ...realFsOps,
        sleep: () => {
          if (!released) {
            execFileSync("taskkill", ["/F", "/PID", String(holder.pid)], { stdio: "ignore" });
            released = true;
          }
          const deadline = Date.now() + 10_000;
          while (!free() && Date.now() < deadline) Bun.sleepSync(5);
        },
      };
      const retried = new Store(s.root, ops);
      retried.setRole("duty", href("w1:p2"));
      expect(released).toBe(true);
      expect(retried.roles()).toEqual({ lead: href("w1:p1"), duty: href("w1:p2") });
      await holder.exited;
    },
    30_000,
  );
});
