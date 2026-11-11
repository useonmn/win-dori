import { describe, expect, test } from "bun:test";
import { interactiveShellInFront, SHELLS } from "../src/runtime/foreground.ts";
import type { ForegroundProcess } from "../src/runtime/types.ts";

describe("interactiveShellInFront on Windows shells", () => {
  const p = (name: string, ...argv: string[]): ForegroundProcess => ({ name, argv });
  test.each([
    ["pwsh.exe by its full path", [p("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh.exe")], true],
    ["powershell.exe -Command", [p("powershell.exe", "powershell.exe", "-Command", "ls")], false],
    ["a bare cmd.exe prompt", [p("C:\\WINDOWS\\system32\\cmd.exe", "cmd.exe")], true],
    ["cmd /c runs a command", [p("cmd.exe", "cmd.exe", "/C", "dir")], false],
    ["cmd /k keeps its prompt", [p("cmd.exe", "cmd.exe", "/k", "dir")], true],
    ["an agent exe is no shell", [p("C:\\tools\\omo.exe", "omo.exe")], false],
  ] as const)("%s", (_, procs, want) => {
    expect(interactiveShellInFront(procs)).toBe(want);
  });

  test("SHELLS covers cmd", () => {
    expect(SHELLS.has("cmd")).toBe(true);
  });
});
