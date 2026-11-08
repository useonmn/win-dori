import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/cli.ts";
import { realFsOps, type FsOps } from "../src/fsx.ts";
import { backlogAdd } from "../src/backlog.ts";
import { review } from "../src/gate.ts";
import type { Deps } from "../src/harness.ts";
import { load1, windowsLoad } from "../src/host.ts";
import { ready, startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { batArg, resolveCommand, type CommandSys } from "../src/run.ts";
import { type Exec, spawnExec } from "../src/runtime/exec.ts";
import type { SessionRuntime } from "../src/runtime/types.ts";
import {
  appendArg,
  doriCommand,
  IS_WINDOWS,
  paneCommand,
  quoteArg,
  sessionShell,
  type PaneShell,
} from "../src/shell.ts";
import { Store } from "../src/store.ts";
import { Telemetry } from "../src/telemetry.ts";
import { href, World } from "./fake.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-win-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const decoded = (line: string): string => {
  const m = /^powershell -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
  if (!m) throw new Error(`not an encoded cmd line: ${line}`);
  return Buffer.from(m[1]!, "base64").toString("utf16le");
};

function setup(shell: PaneShell = "posix") {
  const w = new World();
  const d: Deps = { ...w.deps(), shell };
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Do the thing.");
  return { w, d, lead, brief };
}

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

describe("the loop lock", () => {
  const lockFiles = (d: { store: Store }) =>
    readdirSync(join(d.store.root, "loop")).filter((f) => f.startsWith("lock"));
  const deadPid = async (): Promise<number> => {
    const p = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return p.pid;
  };
  const deps = () => ({ store: new Store(mkdtempSync(join(dir, "lock-"))), now: Date.now });

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

  test("a live takeover guard means back off; a dead one is cleared for the next try", async () => {
    const d = deps();
    const guard = d.store.loopPath("lock.takeover");
    writeFileSync(d.store.loopPath("lock"), "corrupt");
    writeFileSync(guard, JSON.stringify({ pid: process.pid, at: 0, nonce: "busy" }));
    expect(acquire(d)).toEqual({ holder: "lock contended" });
    expect(readFileSync(d.store.loopPath("lock"), "utf8")).toBe("corrupt");
    writeFileSync(guard, JSON.stringify({ pid: await deadPid(), at: 0, nonce: "gone" }));
    expect(acquire(d)).toEqual({ holder: "lock contended" });
    expect(existsSync(guard)).toBe(false);
    expect("nonce" in acquire(d)).toBe(true);
  });

  const race = async (seed: (d: { store: Store }) => Promise<void> | void) => {
    const d = deps();
    await seed(d);
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

  test("real processes racing for a free lock: exactly one wins, and release clears it", () => race(() => {}), 60_000);
  test(
    "real processes racing to take over a dead holder: exactly one wins",
    () =>
      race(async (d) => {
        writeFileSync(d.store.loopPath("lock"), JSON.stringify({ pid: await deadPid(), at: 0, nonce: "dead" }));
      }),
    60_000,
  );
  test(
    "real processes racing over a corrupt lock: exactly one wins",
    () =>
      race((d) => {
        writeFileSync(d.store.loopPath("lock"), '{"pid": 12');
      }),
    60_000,
  );
});

describe("pane command lines", () => {
  test("PowerShell 5.1 lines wrap the CommandLineToArgvW form in a literal", () => {
    expect(quoteArg("two words", "powershell")).toBe("'two words'");
    expect(quoteArg("it's", "powershell")).toBe("'it''s'");
    expect(quoteArg('say "hi"', "powershell")).toBe("'say \\\"hi\\\"'");
    expect(quoteArg('"b c"', "powershell")).toBe('\'"""b c"""\'');
    expect(quoteArg("", "powershell")).toBe("'\"\"'");
    expect(quoteArg("dir with space\\", "powershell")).toBe("'dir with space\\\\'");
    expect(paneCommand(["C:\\a b\\x.exe", "two words", 'q"'], "powershell")).toBe(
      "& 'C:\\a b\\x.exe' 'two words' 'q\\\"'",
    );
    expect(appendArg("omo", "it's two", "powershell")).toBe("omo 'it''s two'");
  });

  test("a line break in an argument never reaches the typed line", () => {
    for (const shell of ["pwsh", "powershell"] as const) {
      const line = paneCommand(["x", "a\nb\r\nc"], shell);
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).toContain("'a'+\"`n\"+'b'+\"`r`n\"+'c'");
    }
  });

  test("a cmd pane gets the whole line encoded, so nothing in it is a cmd metacharacter", () => {
    const line = appendArg("omo --model x", "100% of it's & more", "cmd");
    expect(decoded(line)).toBe("omo --model x '100% of it''s & more'");
    expect(decoded(paneCommand(["omo", "a b"], "cmd"))).toBe("& 'omo' 'a b'");
  });

  test("the default dori command is one form for all four shells on Windows and stays POSIX elsewhere", () => {
    expect(doriCommand("D:\\code\\dori\\src\\cli.ts", true)).toBe("bun D:/code/dori/src/cli.ts");
    expect(doriCommand("C:\\Program Files\\windori\\src\\cli.ts", true)).toBe(
      'bun "C:/Program Files/windori/src/cli.ts"',
    );
    expect(doriCommand("/opt/dori/src/cli.ts", false)).toBe("bun /opt/dori/src/cli.ts");
    expect(doriCommand("/home/a b/it's/cli.ts", false)).toBe("bun '/home/a b/it'\\''s/cli.ts'");
  });

  const tricky = [
    "plain",
    "two words",
    "it's",
    'say "hi"',
    '"b c"',
    'x "b c" y',
    '"a b',
    'a "b',
    '\\"c d\\"',
    '"',
    "tail\\",
    "dir with space\\",
    "C:\\Program Files\\x",
    "100%",
    "%PATH%",
    "a&b|c",
    "^caret",
    "$HOME",
    "`tick",
    "",
    "line1\nline2",
    "a\r\nb",
    "\u2018curly\u2019",
    "\uD55C\uAE00",
    "(paren) ;semi",
    "--flag=1",
  ];
  const bash =
    Bun.which("bash") ??
    (existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : null);
  const real: readonly (readonly [PaneShell, string | null])[] = [
    ["pwsh", Bun.which("pwsh")],
    ["powershell", Bun.which("powershell")],
    ["cmd", Bun.which("cmd")],
    ["posix", bash],
  ];
  const inShell = async (shell: PaneShell, exe: string, line: string): Promise<string> => {
    const verbatim = shell === "cmd";
    const argv =
      shell === "posix"
        ? [exe, "-c", line]
        : verbatim
          ? [exe, "/d", "/s", "/c", `"${line}"`]
          : [exe, "-NoProfile", "-NonInteractive", "-Command", line];
    const p = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`${shell} exited ${code}: ${err}${out}`);
    return out;
  };
  const fixture = resolve(import.meta.dir, "fixtures/argv.ts");

  describe.each(real.filter(([, exe]) => IS_WINDOWS && exe))("through a real %s", (shell, exe) => {
    test("paneCommand delivers every argument intact", async () => {
      const out = join(dir, `argv-${shell}.json`);
      // MSYS drops a CR from what Git Bash hands a native program, whatever the quoting.
      const args = shell === "posix" ? tricky.filter((a) => !a.includes("\r")) : tricky;
      await inShell(shell, exe!, paneCommand([process.execPath, fixture, out, ...args], shell));
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(args);
    }, 30_000);

    test("appendArg adds an argument to the agent line", async () => {
      const out = join(dir, `append-${shell}.json`);
      const base = paneCommand([process.execPath, fixture, out], shell === "cmd" ? "powershell" : shell);
      const arg = "Read your brief at C:\\Users\\a b\\brief.md and it's 100% yours.";
      await inShell(shell, exe!, appendArg(base, arg, shell));
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([arg]);
    }, 30_000);

    test("the default dori command runs, also from a path with a space", async () => {
      const spaced = join(dir, `with space ${shell}`);
      mkdirSync(spaced);
      cpSync(fixture, join(spaced, "argv.ts"));
      const out = join(dir, `dori-${shell}.json`).replaceAll("\\", "/");
      await inShell(shell, exe!, `${doriCommand(join(spaced, "argv.ts"))} ${out} report one --status waiting`);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["report", "one", "--status", "waiting"]);
    }, 30_000);
  });

  test("startLane and dori up work with a cmd pane", async () => {
    const { w, d, brief } = setup("cmd");
    const lane = await startLane(d, "cmd-lane", brief, { group: "w1" });
    expect(decoded(w.panes.get(lane.paneId)!.ran[0]!)).toStartWith("omo 'Read your brief at ");

    const log = console.log;
    const printed: string[] = [];
    console.log = (s: string) => {
      printed.push(s);
    };
    try {
      expect(await main(["up", "--cwd", d.store.root], d)).toBe(0);
    } finally {
      console.log = log;
    }
    const roles = d.store.roles();
    const up = /loop=(\S+) hourly=(\S+)/.exec(printed[0]!)!;
    const prompted = decoded(w.panes.get(roles.lead!.id)!.ran[0]!);
    expect(prompted).toStartWith("omo --append-system-prompt '");
    expect(prompted).toContain("lead.md");
    expect(decoded(w.panes.get(roles.duty!.id)!.ran[0]!)).toContain("duty.md");
    expect(w.panes.get(up[1]!)!.ran).toEqual(["dori duty --interval 60"]);
    expect(w.panes.get(up[2]!)!.ran).toEqual(["dori loop"]);
    const hourlySplit = w.calls.filter((c) => c.argv[1] === "split").at(-1)!;
    expect(hourlySplit.argv).toContain("HERDR_WORKSPACE_ID=w1");
    expect(hourlySplit.argv.some((a) => a.startsWith("DORI_CMD="))).toBe(true);
  });

  test("a new session's own shell decides the quoting, not the one this CLI runs in", async () => {
    const rt = (names: string[] | Error): SessionRuntime =>
      ({
        probe: async () => {
          if (names instanceof Error) throw names;
          return { status: "shell", shellInFront: true, foreground: names.map((name) => ({ name, argv: [name] })) };
        },
      }) as unknown as SessionRuntime;
    const ref = href("w1:p2");
    const forced = process.env["DORI_PANE_SHELL"];
    delete process.env["DORI_PANE_SHELL"];
    try {
      expect(await sessionShell(rt(["C:\\WINDOWS\\system32\\cmd.exe"]), ref, "pwsh", true)).toBe("cmd");
      expect(await sessionShell(rt(["pwsh.exe"]), ref, "posix", true)).toBe("pwsh");
      expect(await sessionShell(rt(new Error("gone")), ref, "pwsh", true)).toBe("pwsh");
      expect(await sessionShell(rt(["cmd.exe"]), ref, "posix", false)).toBe("posix");
      process.env["DORI_PANE_SHELL"] = "powershell";
      expect(await sessionShell(rt(["cmd.exe"]), ref, "pwsh", true)).toBe("powershell");
    } finally {
      if (forced === undefined) delete process.env["DORI_PANE_SHELL"];
      else process.env["DORI_PANE_SHELL"] = forced;
    }
  });
});

describe("typing into a new pane", () => {
  test.skipIf(!IS_WINDOWS)("a new pane's shell is read only after its prompt is up", async () => {
    const w = new World();
    const d = w.deps();
    const brief = join(d.store.root, "probe-brief.md");
    writeFileSync(brief, "brief\n");
    const forced = process.env["DORI_PANE_SHELL"];
    delete process.env["DORI_PANE_SHELL"];
    try {
      await startLane(d, "probe-order", brief, { cwd: d.store.root, group: "w1" });
    } finally {
      if (forced !== undefined) process.env["DORI_PANE_SHELL"] = forced;
    }
    const verbs = w.calls.map((c) => c.argv.join(" "));
    const waited = verbs.findIndex((v) => v.includes("wait-output"));
    const probed = verbs.findIndex((v) => v.includes("process-info"));
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(probed).toBeGreaterThan(waited);
  });
  // The prompt wait itself (and its absence off Windows) is tested on the adapter: test/runtime-herdr-windows.test.ts.
});

describe("typing into a plain shell pane (the operator's --to-shell)", () => {
  // One Enter per line on Windows is tested on the adapter: test/runtime-herdr-windows.test.ts.
  test("a READY for a shell lead is never typed into it, on Windows either: it waits in the lead's inbox (#66)", async () => {
    const { d, lead, brief } = setup();
    const lane = await startLane(d, "shell-lead", brief, { group: "w1" });
    lead.status = "shell";
    lead.received.length = 0;
    await ready(d, lane.key, "fixed", ["note.txt"]);
    expect(lead.received).toEqual([]);
    expect(d.store.queued(href("w1:p1")).map((m) => m.text)).toContain("[READY shell-lead] fixed\nevidence: note.txt");
  });
});

describe("spawning an agent that is a .cmd shim", () => {
  const files: Record<string, string> = {
    "C:\\nodejs\\node.exe": "",
    "C:\\nodejs\\omo.cmd": '@"%~dp0\\node.exe" "%~dp0\\node_modules\\omo\\bin\\omo.js" %*\r\n',
    "C:\\nodejs\\node_modules\\omo\\bin\\omo.js": "",
    "C:\\hooks\\plain.cmd": "@echo off\r\necho %1\r\n",
  };
  const which: Record<string, string> = {
    omo: "C:\\nodejs\\omo.cmd",
    plain: "C:\\hooks\\plain.cmd",
    gh: "C:\\Program Files\\GitHub CLI\\gh.exe",
  };
  const sys = (platform: NodeJS.Platform): CommandSys => ({
    platform,
    which: (c) => which[c] ?? null,
    read: (p) => files[p] ?? null,
    exists: (p) => p in files,
    cmdExe: "C:\\Windows\\System32\\cmd.exe",
    execPath: "C:\\bun\\bun.exe",
  });

  test("off Windows and for a real .exe the argv is untouched", () => {
    expect(resolveCommand(["omo", "a&b"], undefined, sys("linux"))).toEqual({ argv: ["omo", "a&b"], verbatim: false });
    expect(resolveCommand(["gh", "pr"], undefined, sys("win32"))).toEqual({ argv: ["gh", "pr"], verbatim: false });
  });

  test("an npm shim runs node on its script, so a multi-line prompt never touches cmd.exe", () => {
    expect(resolveCommand(["omo", "-p", "line1\nline2 & more"], undefined, sys("win32"))).toEqual({
      argv: ["C:\\nodejs\\node.exe", "C:\\nodejs\\node_modules\\omo\\bin\\omo.js", "-p", "line1\nline2 & more"],
      verbatim: false,
    });
  });

  test("any other batch file goes through cmd.exe with safe quoting, or is refused when it cannot be", () => {
    expect(resolveCommand(["plain", "a&b", "100%"], undefined, sys("win32"))).toEqual({
      verbatim: true,
      argv: [
        "C:\\Windows\\System32\\cmd.exe",
        "/d",
        "/e:ON",
        "/v:OFF",
        "/s",
        "/c",
        '""C:\\hooks\\plain.cmd" "a&b" "100%%cd:~,%""',
      ],
    });
    expect(resolveCommand(["plain", "two\nlines"], undefined, sys("win32"))).toEqual({
      refused: expect.stringContaining("newline"),
    });
    expect(batArg('say "hi"')).toBe('"say ""hi"""');
  });

  describe.skipIf(!IS_WINDOWS)("on this host", () => {
    const bin = mkdtempSync(join(tmpdir(), "dori-shim-"));
    afterAll(() => rmSync(bin, { recursive: true, force: true }));

    test("spawnExec passes metacharacters to a batch file literally and refuses a line break", async () => {
      const hook = join(bin, "hook.cmd");
      writeFileSync(
        hook,
        "@echo off\r\n:loop\r\nif [%1]==[] goto end\r\necho(ARG=%1\r\nshift\r\ngoto loop\r\n:end\r\n",
      );
      const r = await spawnExec(hook, ["a&b", "100%", `& echo PWNED>${join(bin, "pwned.txt")}`]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim().split(/\r?\n/)).toEqual([
        'ARG="a&b"',
        'ARG="100%"',
        `ARG="& echo PWNED>${join(bin, "pwned.txt")}"`,
      ]);
      expect(existsSync(join(bin, "pwned.txt"))).toBe(false);
      expect(await spawnExec(hook, ["two\nlines"])).toMatchObject({ code: 126, stdout: "" });
    });

    test("review() runs an npm-style omo.cmd with its multi-line prompt and records the verdict", async () => {
      writeFileSync(
        join(bin, "omo.js"),
        "if (!process.argv.at(-1).includes('\\n')) process.exit(3); console.log('VERDICT: CLEAR');",
      );
      writeFileSync(join(bin, "omo.cmd"), '@"%~dp0\\node.exe" "%~dp0\\omo.js" %*\r\n');
      cpSync(process.execPath, join(bin, "node.exe"));
      const { w, d } = setup();
      const head = "b".repeat(40);
      w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head }) });
      const exec: Exec = (cmd, argv) => (cmd === "gh" ? w.exec(cmd, argv) : spawnExec(cmd, argv));
      expect(await review({ ...d, exec, agentCmd: join(bin, "omo.cmd") }, "o/r#9")).toEqual({
        verdict: "CLEAR",
        sha: head,
      });
      expect(d.store.receipt("o/r#9", head)!.verdict).toBe("CLEAR");
    }, 60_000);
  });
});
