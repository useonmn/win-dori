import { expect, test } from "bun:test";

import type { Ran } from "../src/run.ts";
import { type Proc, procTable, resolveSession, sessionDirFor } from "../src/session-id.ts";
import { parseEnvBlock, parseWin32Processes, parseWindowsCommandLine, readProcessEnv } from "../src/win-process.ts";

const P1 = { runtime: "herdr", id: "w:p1" } as const;
const ID = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const OTHER = "01a10000-0000-7000-8000-000000000000";
const info = JSON.stringify({
  result: {
    pane: { pane_id: "w:p1", agent: "omo" },
    process_info: { shell_pid: 10, foreground_processes: [{ pid: 10, name: "pwsh.exe" }] },
  },
});

const fake =
  (calls: string[][], extra: Record<string, string> = {}) =>
  async (argv: readonly string[]): Promise<Ran> => {
    calls.push([...argv]);
    const line = argv.join(" ");
    if (/^herdr pane (process-info|get)/.test(line)) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };

test("Windows: procTable is one PowerShell CIM call parsed into pid, ppid, command line and start time", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify([
    { ProcessId: 0, ParentProcessId: 0, CommandLine: null, CreationDate: null },
    {
      ProcessId: 6456,
      ParentProcessId: 2920,
      CommandLine: '"C:\\Users\\me\\.local\\bin\\omo.exe"',
      CreationDate: "2026-10-18T04:57:48.5981640Z",
    },
  ]);
  const table = await procTable(fake(calls, { "powershell.exe": json }), true);
  expect(calls[0]?.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(calls[0]?.[4]).toContain("Get-CimInstance Win32_Process");
  expect(table).toEqual([
    { pid: 0, ppid: 0, cmd: "" },
    {
      pid: 6456,
      ppid: 2920,
      cmd: '"C:\\Users\\me\\.local\\bin\\omo.exe"',
      startedAt: Date.parse("2026-10-18T04:57:48.598Z"),
    },
  ]);
  expect(parseWin32Processes(JSON.stringify({ ProcessId: 4, ParentProcessId: 0, CommandLine: "x" }))).toEqual([
    { pid: 4, ppid: 0, cmd: "x" },
  ]);
  expect(parseWin32Processes("")).toEqual([]);
  expect(parseWin32Processes("not json")).toEqual([]);
});

test("Windows command lines split by CommandLineToArgvW rules", () => {
  expect(
    parseWindowsCommandLine(
      '"C:\\Program Files\\omo\\omo.exe" --session "01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" --model x',
    ),
  ).toEqual(["C:\\Program Files\\omo\\omo.exe", "--session", "01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b", "--model", "x"]);
  expect(
    parseWindowsCommandLine('\\\\?\\C:\\b\\node.exe "C:\\a b\\cli.js" ""  "say \\"hi\\"" a\\\\b c\\\\\\"d e\\\\"f g"'),
  ).toEqual(["\\\\?\\C:\\b\\node.exe", "C:\\a b\\cli.js", "", 'say "hi"', "a\\\\b", 'c\\"d', "e\\f g"]);
  expect(parseWindowsCommandLine('x "a ""q"" b"')).toEqual(["x", 'a "q" b']);
  expect(parseWindowsCommandLine("")).toEqual([]);
});

test("Windows: an environment block parses into a map, skipping drive-cwd entries", () => {
  expect(parseEnvBlock(`=C:=C:\\x\0PI_SESSION_ID=${ID}\0A=b=c\0\0junk=1\0`)).toEqual({ PI_SESSION_ID: ID, A: "b=c" });
});

const winTable: Proc[] = [
  { pid: 10, ppid: 1, cmd: "C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoExit" },
  {
    pid: 11,
    ppid: 10,
    cmd: '"C:\\Users\\me\\.local\\bin\\omo.exe" --model x',
    startedAt: Date.parse("2026-10-18T04:57:48.598Z"),
  },
  { pid: 12, ppid: 11, cmd: "C:\\Users\\me\\.omo\\omo.exe C:\\x\\mcp\\cli.js mcp" },
  { pid: 13, ppid: 11, cmd: "C:\\Program Files\\Git\\bin\\bash.exe -c x" },
];

test("Windows: the agent is found by its backslash path and its id comes from argv, child env, then start time", async () => {
  const noPs =
    (calls: string[][]) =>
    async (argv: readonly string[]): Promise<Ran> => {
      calls.push([...argv]);
      if (argv[0] === "herdr") return { code: 0, out: info, err: "" };
      throw new Error(`no ps on Windows: ${argv.join(" ")}`);
    };
  for (const cmd of [
    '"C:\\Program Files\\omo\\omo.exe" --session "01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b"',
    "C:\\nvm\\node.exe C:\\x\\senpi\\dist\\bundle\\cli.js --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\omo.cmd --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b",
  ]) {
    const flagged = [winTable[0] as Proc, { pid: 11, ppid: 10, cmd }];
    expect(
      await resolveSession(P1, "C:\\repo", flagged, {
        run: noPs([]),
        sessionsDir: "C:\\s",
        windows: true,
        readEnv: () => undefined,
      }),
    ).toEqual({ id: "01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b", via: "argv", pid: 11 });
  }
  expect(
    (
      await resolveSession(P1, "C:\\repo", [winTable[0] as Proc, { pid: 11, ppid: 10, cmd: "C:\\x\\momo.exe" }], {
        run: noPs([]),
        sessionsDir: "C:\\s",
        windows: true,
      })
    ).via,
  ).toBe("none");

  const read: number[] = [];
  const readEnv = (pid: number) => {
    read.push(pid);
    return pid === 13 ? { PI_SESSION_ID: ID } : pid === 12 ? { PI_SESSION_ID: "not-a-uuid" } : undefined;
  };
  const calls: string[][] = [];
  expect(
    await resolveSession(P1, "C:\\repo", winTable, {
      run: noPs(calls),
      sessionsDir: "C:\\s",
      windows: true,
      readEnv,
    }),
  ).toEqual({ id: ID, via: "child-env", pid: 11 });
  expect(read).toEqual([12, 13]);
  // The root pid comes from the herdr runtime's probe: pane get, then process-info.
  expect(calls).toEqual([
    ["herdr", "pane", "get", "w:p1"],
    ["herdr", "pane", "process-info", "--pane", "w:p1"],
  ]);

  const dirs: string[] = [];
  const listDir = (d: string) => {
    dirs.push(d);
    return [`2026-10-18T04-50-00-000Z_${OTHER}.jsonl`, `2026-10-18T04-57-50-177Z_${ID}.jsonl`];
  };
  expect(
    await resolveSession(P1, "C:\\Users\\me\\repo", winTable, {
      run: noPs([]),
      sessionsDir: "C:\\s",
      windows: true,
      readEnv: () => undefined,
      listDir,
    }),
  ).toEqual({ id: ID, via: "start-time", pid: 11 });
  expect(dirs).toEqual(["C:\\s\\--C--Users-me-repo--"]);

  const unknownStart = winTable.map((p) => (p.pid === 11 ? { pid: p.pid, ppid: p.ppid, cmd: p.cmd } : p));
  expect(
    await resolveSession(P1, "C:\\repo", unknownStart, {
      run: noPs([]),
      sessionsDir: "C:\\s",
      windows: true,
      readEnv: () => undefined,
      listDir,
    }),
  ).toEqual({ id: "", via: "none", pid: 11 });
});

test("Windows session dirs turn the drive colon and every separator into dashes", () => {
  expect(sessionDirFor("C:\\Users\\ana\\.omo\\agent\\sessions", "C:\\Users\\ana\\code\\app", true)).toBe(
    "C:\\Users\\ana\\.omo\\agent\\sessions\\--C--Users-ana-code-app--",
  );
});

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "Windows: readProcessEnv reads a live child's environment",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('up'); setInterval(() => {}, 1e5)"], {
      env: { ...process.env, FOO_TEST: "xyz" },
      stdout: "pipe",
    });
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      expect(readProcessEnv(child.pid)?.["FOO_TEST"]).toBe("xyz");
    } finally {
      child.kill();
      await child.exited;
    }
    expect(readProcessEnv(0)).toBeUndefined();
  },
);
