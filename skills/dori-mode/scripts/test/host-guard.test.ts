import { describe, expect, test } from "bun:test";

import { type HostEnv, parseWindowsSample, sampleHost, windowsDrive } from "../src/host-guard.ts";
import type { Ran, Runner } from "../src/run.ts";

const ok = (out: string): Ran => ({ code: 0, out, err: "" });
const fail: Ran = { code: 127, out: "", err: "not found" };
const win: HostEnv = { windows: true, home: "C:\\Users\\me", cpus: 8 };
const mac: HostEnv = { windows: false, home: "/Users/me", cpus: 8 };
const panesJson = JSON.stringify({ result: { panes: [{}, {}, {}] } });

const sampleJson = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    freeKb: 4_000_000,
    totalKb: 16_000_000,
    pageFiles: [{ sizeMb: 2048, usedMb: 512 }, { sizeMb: 1024, usedMb: 0 }],
    queue: 2,
    cpuPct: 25,
    diskFreeBytes: 107_374_182_400,
    ...patch,
  });

const winRunner = (ps: Ran, calls: string[][] = []): Runner => async (argv) => {
  calls.push([...argv]);
  if (argv[0] === "powershell.exe") return ps;
  if (argv[0] === "herdr") return ok(panesJson);
  return fail;
};

describe("parseWindowsSample", () => {
  test("derives load, memory, disk and swap", () => {
    expect(parseWindowsSample(sampleJson(), 8)).toEqual({ load1: 4, memFreePct: 25, diskFreeGb: 100, swapFreeGb: 2.5 });
  });
  test("single pagefile object and no pagefile", () => {
    expect(parseWindowsSample(sampleJson({ pageFiles: { sizeMb: 1024, usedMb: 256 } }), 8)?.swapFreeGb).toBe(0.75);
    expect(parseWindowsSample(sampleJson({ pageFiles: [] }), 8)?.swapFreeGb).toBe(0);
    expect(parseWindowsSample(sampleJson({ pageFiles: null }), 8)?.swapFreeGb).toBe(0);
  });
  test("rejects non-JSON and non-objects", () => {
    expect(parseWindowsSample("", 8)).toBeNull();
    expect(parseWindowsSample("not json", 8)).toBeNull();
    expect(parseWindowsSample("[1]", 8)).toBeNull();
  });
  test("missing fields read as unknown, not as healthy disk", () => {
    expect(parseWindowsSample("{}", 8)).toEqual({ load1: 0, memFreePct: 100, diskFreeGb: 0, swapFreeGb: 0 });
  });
});

describe("windowsDrive", () => {
  test("home drive for / or omitted, explicit drive otherwise", () => {
    expect(windowsDrive("/", "C:\\Users\\me")).toBe("C:");
    expect(windowsDrive("/", "E:\\u")).toBe("E:");
    expect(windowsDrive("d:\\x", "C:\\Users\\me")).toBe("D:");
  });
});

describe("sampleHost on windows", () => {
  test("one powershell call plus herdr", async () => {
    const calls: string[][] = [];
    const s = await sampleHost(winRunner(ok(sampleJson()), calls), "/", win);
    expect(s).toEqual({ load1: 4, memFreePct: 25, diskFreeGb: 100, swapFreeGb: 2.5, panes: 3 });
    const ps = calls.filter((c) => c[0] === "powershell.exe");
    expect(ps).toHaveLength(1);
    expect(ps[0]?.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(ps[0]?.[4]).toContain("DeviceID='C:'");
    expect(calls.map((c) => c[0])).not.toContain("sysctl");
  });
  test("explicit data path picks its drive", async () => {
    const calls: string[][] = [];
    await sampleHost(winRunner(ok(sampleJson()), calls), "D:\\x", win);
    expect(calls[0]?.[4]).toContain("DeviceID='D:'");
  });
  test("failed or garbage powershell keeps the unknown values and holds disk", async () => {
    for (const ps of [fail, ok("garbage"), { code: 1, out: sampleJson(), err: "x" }]) {
      expect(await sampleHost(winRunner(ps), "/", win)).toEqual({ load1: 0, memFreePct: 100, diskFreeGb: 0, swapFreeGb: 0, panes: 3 });
    }
  });
});

describe("sampleHost on macOS (unchanged)", () => {
  test("parses sysctl, memory_pressure, df and herdr", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push([...argv]);
      switch (argv[0]) {
        case "sysctl": return ok(argv[2] === "vm.loadavg" ? "{ 3.50 2.00 1.00 }" : "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)");
        case "memory_pressure": return ok("System-wide memory free percentage: 42%");
        case "df": return ok("Filesystem 1024-blocks Used Available Capacity\n/dev/disk1 1000 500 2097152 50% /");
        case "herdr": return ok(panesJson);
        default: return fail;
      }
    };
    expect(await sampleHost(run, "/", mac)).toEqual({ load1: 3.5, memFreePct: 42, diskFreeGb: 2, swapFreeGb: 1, panes: 3 });
    expect(calls.map((c) => c[0])).not.toContain("powershell.exe");
  });
  test("linux load fallback and failure defaults", async () => {
    const run: Runner = async (argv) => (argv[0] === "cat" ? ok("1.25 1 1 1/1 1") : argv[0] === "herdr" ? { code: 1, out: "", err: "" } : fail);
    expect(await sampleHost(run, "/", mac)).toEqual({ load1: 1.25, memFreePct: 100, diskFreeGb: 0, swapFreeGb: 0, panes: -1 });
  });
});
