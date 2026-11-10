import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/cli.ts";
import { startLane } from "../src/lanes.ts";
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
import { href } from "./fake.ts";
import { decoded, setup } from "./windows-helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-win-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
