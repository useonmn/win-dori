import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "../src/gate.ts";
import { ready, startLane } from "../src/lanes.ts";
import { batArg, resolveCommand, type CommandSys } from "../src/run.ts";
import { type Exec, spawnExec } from "../src/runtime/exec.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { href, World } from "./fake.ts";
import { setup } from "./windows-helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-win-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
