import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CommandSys, resolveCommand, run } from "../src/run.ts";
import { batArg } from "../src/run-windows.ts";

const NODE_DIR = "C:\\nodejs";
const files: Record<string, string> = {
  [`${NODE_DIR}\\npm.cmd`]: [
    "@ECHO OFF",
    "SETLOCAL",
    'SET "NODE_EXE=%~dp0\\node.exe"',
    'IF NOT EXIST "%NODE_EXE%" (',
    '  SET "NODE_EXE=node"',
    ")",
    'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
    '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  ].join("\r\n"),
  [`${NODE_DIR}\\node.exe`]: "",
  [`${NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`]: "",
  "C:\\npm-global\\tsc.cmd": [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\typescript\\bin\\tsc" %*',
  ].join("\r\n"),
  "C:\\npm-global\\node_modules\\typescript\\bin\\tsc": "",
  "C:\\old\\lint.cmd": [
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\..\\lint\\bin\\lint.js" %*',
    ") ELSE (",
    "  @SETLOCAL",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    '  node  "%~dp0\\..\\lint\\bin\\lint.js" %*',
    ")",
  ].join("\r\n"),
  "C:\\lint\\bin\\lint.js": "",
  "C:\\tools\\fast.cmd": '@"%~dp0\\bin\\fast.exe"   %*',
  "C:\\tools\\bin\\fast.exe": "",
  "C:\\hooks\\reply.cmd": "@echo off\r\ncurl -d %1 https://example.invalid",
  "C:\\odd%dir\\x.bat": "@echo %*",
};
const which: Record<string, string> = {
  npm: `${NODE_DIR}\\npm.cmd`,
  node: "C:\\other\\node.exe",
  tsc: "C:\\npm-global\\tsc.cmd",
  lint: "C:\\old\\lint.cmd",
  fast: "C:\\tools\\fast.cmd",
  reply: "C:\\hooks\\reply.cmd",
  x: "C:\\odd%dir\\x.bat",
  gh: "C:\\Program Files\\GitHub CLI\\gh.exe",
};
const fakeSys = (platform: NodeJS.Platform, extra: Partial<CommandSys> = {}): CommandSys => ({
  platform,
  which: (c) => which[c] ?? null,
  read: (p) => files[p] ?? null,
  exists: (p) => p in files,
  cmdExe: "C:\\Windows\\System32\\cmd.exe",
  execPath: "C:\\bun\\bun.exe",
  ...extra,
});
const win = fakeSys("win32");
const resolve = (argv: string[], sys = win) => resolveCommand(argv, undefined, sys);

test("off Windows, and for a .exe or an unknown program on Windows, the argv is unchanged", () => {
  for (const argv of [["npm", "-v"], ["reply", "a&b\nc"], []])
    expect(resolve(argv, fakeSys("darwin"))).toEqual({ argv, verbatim: false });
  expect(resolve(["gh", "pr", "view"])).toEqual({ argv: ["gh", "pr", "view"], verbatim: false });
  expect(resolve(["no-such-thing", "x"])).toEqual({ argv: ["no-such-thing", "x"], verbatim: false });
});

test("npm's own shim and cmd-shim node shims run node on the script directly, so no argument touches cmd.exe", () => {
  expect(resolve(["npm", "view", "a&b|c\n%PATH%"])).toEqual({
    argv: [`${NODE_DIR}\\node.exe`, `${NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`, "view", "a&b|c\n%PATH%"],
    verbatim: false,
  });
  // No node.exe beside this shim: node from PATH, else the running bun.
  expect(resolve(["tsc", "-p", "."])).toEqual({
    argv: ["C:\\other\\node.exe", "C:\\npm-global\\node_modules\\typescript\\bin\\tsc", "-p", "."],
    verbatim: false,
  });
  const noNode = fakeSys("win32", { which: (c) => (c === "node" ? null : (which[c] ?? null)) });
  expect(resolve(["tsc"], noNode)).toEqual({
    argv: ["C:\\bun\\bun.exe", "C:\\npm-global\\node_modules\\typescript\\bin\\tsc"],
    verbatim: false,
  });
  expect(resolve(["lint", "x"])).toEqual({
    argv: ["C:\\other\\node.exe", "C:\\lint\\bin\\lint.js", "x"],
    verbatim: false,
  });
  expect(resolve(["fast", "a b"])).toEqual({ argv: ["C:\\tools\\bin\\fast.exe", "a b"], verbatim: false });
});

test("a shim whose script is missing falls back to cmd.exe instead of guessing", () => {
  const gone = fakeSys("win32", { exists: (p) => p in files && !p.endsWith("npm-cli.js") });
  expect(resolve(["npm", "-v"], gone)).toEqual({
    verbatim: true,
    argv: ["C:\\Windows\\System32\\cmd.exe", "/d", "/e:ON", "/v:OFF", "/s", "/c", `""${NODE_DIR}\\npm.cmd" -v"`],
  });
});

test("any other batch file runs through cmd.exe /d /s /c with every metacharacter inside quotes", () => {
  const r = resolve(["reply", "a&b", "100%", 'x"y', "^caret", "| pipe", "%PATH%", "plain-1.2", "", "tail\\"]);
  expect(r).toEqual({
    verbatim: true,
    argv: [
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/e:ON",
      "/v:OFF",
      "/s",
      "/c",
      '""C:\\hooks\\reply.cmd" "a&b" "100%%cd:~,%" "x""y" "^caret" "| pipe" "%%cd:~,%PATH%%cd:~,%" plain-1.2 "" "tail\\\\""',
    ],
  });
});

test("batArg follows the Rust std BatBadBut rules", () => {
  expect(batArg("abc-1.2/x:y@z")).toBe("abc-1.2/x:y@z");
  expect(batArg("a b")).toBe('"a b"');
  expect(batArg('say "hi"')).toBe('"say ""hi"""');
  expect(batArg('a\\"b')).toBe('"a\\\\""b"');
  expect(batArg("C:\\dir\\")).toBe('"C:\\dir\\\\"');
  expect(batArg("50%")).toBe('"50%%cd:~,%"');
  expect(batArg("é")).toBe("é");
});

test("arguments cmd.exe cannot carry, and script paths it would expand, are refused rather than mangled", () => {
  for (const bad of ["line1\nline2", "a\rb", "nul\0"])
    expect(resolve(["reply", "ok", bad])).toEqual({ refused: expect.stringContaining("argument 2 for reply.cmd") });
  expect(resolve(["x"])).toEqual({ refused: expect.stringContaining('contains " or %') });
  expect(resolve(["reply", "y".repeat(9000)])).toEqual({ refused: expect.stringContaining("8191") });
});

describe.skipIf(process.platform !== "win32")("on this Windows host", () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-run-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a user hook .cmd receives messenger text literally and no injected command runs", async () => {
    const hook = join(dir, "hook.cmd");
    writeFileSync(hook, "@echo off\r\n:loop\r\nif [%1]==[] goto end\r\necho(ARG=%1\r\nshift\r\ngoto loop\r\n:end\r\n");
    const args = ["a&b", "100%", 'x"y', "^caret", "| pipe", "%PATH%", "& echo PWNED>pwned.txt"];
    const r = await run([hook, ...args], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out.split(/\r?\n/)).toEqual([
      'ARG="a&b"',
      'ARG="100%"',
      'ARG="x""y"',
      'ARG="^caret"',
      'ARG="| pipe"',
      'ARG="%PATH%"',
      'ARG="& echo PWNED>pwned.txt"',
    ]);
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
    expect(await run([hook, "two\nlines"])).toMatchObject({ code: 126, out: "" });
  });

  test("a node shim .cmd runs its script with arguments intact", async () => {
    writeFileSync(join(dir, "echo-args.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(dir, "echo-args.cmd"), '@"%~dp0\\node.exe" "%~dp0\\echo-args.js" %*\r\n');
    writeFileSync(join(dir, "node.exe"), readFileSync(process.execPath));
    const args = ["a&b", "two\nlines", '"q"', "%PATH%"];
    expect(await run([join(dir, "echo-args.cmd"), ...args])).toEqual({ code: 0, out: JSON.stringify(args), err: "" });
  }, 20_000);

  test("a timeout kills the whole process tree and reports 124", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const child = `const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', detached: true }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1e6)`;
    const r = await run([process.execPath, "-e", child], { timeoutMs: 3000 });
    expect(r).toEqual({ code: 124, out: "", err: "killed process tree (timeout)" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  test("a program that cannot be spawned reports 127", async () => {
    expect(await run(["no-such-program-xyz-dori"])).toMatchObject({ code: 127, out: "" });
  });
});
