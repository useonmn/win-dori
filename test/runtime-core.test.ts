import { describe, expect, test } from "bun:test";
import { interactiveShellInFront, SHELLS } from "../src/runtime/foreground.ts";
import type { ForegroundProcess } from "../src/runtime/types.ts";
import { formatRef, parseRef } from "../src/runtime/types.ts";

describe("parseRef / formatRef", () => {
  test.each([
    ["herdr:w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["hc:t7", { runtime: "hc", id: "t7" }],
    ["w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["wAb:pX9", { runtime: "herdr", id: "wAb:pX9" }],
    ["t7", undefined],
    ["hc:t12", { runtime: "hc", id: "t12" }],
    ["t", undefined],
    ["", undefined],
    ["lead", undefined],
    ["tmux:w1:p3", undefined],
    ["herdr:t7", undefined],
    ["hc:w1:p3", undefined],
    ["hc:", undefined],
    ["w1:p3 ", undefined],
    ["machine/t7", undefined],
    ["hc:t2h", { runtime: "hc", id: "t2h" }],
    ["hc:t1b", { runtime: "hc", id: "t1b" }],
    ["hc:box-2/t2h", undefined],
    ["hc:T2H", undefined],
    ["hc:t2h-", undefined],
    ["hc:/t2h", undefined],
    ["hc:a/b/t2h", undefined],
    ["t2h", undefined],
  ] as const)("parseRef(%p)", (text, want) => {
    expect(parseRef(text)).toEqual(want);
  });

  test.each([
    ["herdr:w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["hc:t7", { runtime: "hc", id: "t7" }],
    ["hc:t7 (group dropped)", { runtime: "hc", id: "t7", group: "abcd1234" }],
    ["herdr:w1:p3 (group and container dropped)", { runtime: "herdr", id: "w1:p3", group: "w1", container: "w1:t2" }],
  ] as const)("formatRef gives %s and parses back", (want, ref) => {
    expect(formatRef(ref)).toBe(want.split(" ")[0] ?? "");
    expect(parseRef(formatRef(ref))).toEqual({ runtime: ref.runtime, id: ref.id });
  });
});

describe("interactiveShellInFront (#66), ported from the herdr parser", () => {
  const p = (name: string, ...argv: string[]): ForegroundProcess => ({ name, argv });
  test.each([
    ["login shell", [p("-bash", "-bash")], true],
    ["interactive zsh by path, upper case", [p("/bin/ZSH", "/bin/zsh", "-i")], true],
    ["bash -C (noclobber) is still interactive", [p("bash", "bash", "-C")], true],
    ["busybox sh applet", [p("busybox", "busybox", "sh")], true],
    ["shell entry without argv", [p("fish")], true],
    ["agent with a sh -c child", [p("omo", "omo"), p("sh", "sh", "-c", "sleep 1")], false],
    ["shell running a script is held, the safe side", [p("bash", "bash", "tool.sh")], true],
    ["interactive bash with --rcfile FILE", [p("bash", "bash", "--rcfile", "/tmp/rc")], true],
    ["interactive zsh with -o OPT", [p("zsh", "zsh", "-o", "vi")], true],
    ["login shell running a command: -lc", [p("bash", "bash", "-lc", "make")], false],
    ["pwsh -File", [p("pwsh", "pwsh", "-File", "x.ps1")], false],
    ["bash -f (noglob) is still interactive", [p("bash", "bash", "-f")], true],
    ["bash --init-file F", [p("bash", "bash", "--init-file", "/tmp/rc")], true],
    ["fish -C cmd (init command, still interactive)", [p("fish", "fish", "-C", "set x 1")], true],
    ["bash -ic cmd runs a command", [p("bash", "bash", "-ic", "make")], false],
    ["pwsh -EncodedCommand", [p("pwsh", "pwsh", "-EncodedCommand", "ZQBjAGgAbwA=")], false],
    ["pwsh -Interactive", [p("pwsh", "pwsh", "-Interactive")], true],
    ["pwsh -NoProfile -ExecutionPolicy Bypass", [p("pwsh", "pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass")], true],
    ["pwsh -NoExit -Command keeps a prompt", [p("pwsh", "pwsh", "-NoExit", "-Command", "ls")], true],
    ["pwsh -noex -c keeps a prompt", [p("pwsh", "pwsh", "-noex", "-c", "ls")], true],
    ["pwsh --noexi -Command keeps a prompt", [p("pwsh", "pwsh", "--noexi", "-Command", "ls")], true],
    ["powershell -c", [p("powershell", "powershell", "-c", "ls")], false],
    ["pwsh -Command", [p("pwsh", "pwsh", "-Command", "ls")], false],
    ["exec'd agent", [p("bun", "bun", "omo.js")], false],
    ["busybox running a command applet: busybox sh -c", [p("busybox", "busybox", "sh", "-c", "x")], false],
    ["hc group leader only: an agent", [{ name: "omo", argv: ["omo"], pid: 4242 }], false],
    ["hc group leader only: a bare shell", [{ name: "bash", argv: ["bash"], pid: 4242 }], true],
    ["Windows: pwsh.exe by its full path", [p("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh.exe")], true],
    ["Windows: powershell.exe -Command", [p("powershell.exe", "powershell.exe", "-Command", "ls")], false],
    ["Windows: a bare cmd.exe prompt", [p("C:\\WINDOWS\\system32\\cmd.exe", "cmd.exe")], true],
    ["Windows: cmd /c runs a command", [p("cmd.exe", "cmd.exe", "/C", "dir")], false],
    ["Windows: cmd /k keeps its prompt", [p("cmd.exe", "cmd.exe", "/k", "dir")], true],
    ["Windows: an agent exe is no shell", [p("C:\\tools\\omo.exe", "omo.exe")], false],
  ] as const)("%s", (_, procs, want) => {
    expect(interactiveShellInFront(procs)).toBe(want);
  });

  test("an empty or missing process list is doubt", () => {
    expect(interactiveShellInFront([])).toBe(true);
    expect(interactiveShellInFront(undefined)).toBe(true);
  });

  test("SHELLS covers the busybox and PowerShell names", () => {
    for (const name of ["sh", "bash", "zsh", "fish", "busybox", "pwsh", "powershell", "cmd"])
      expect(SHELLS.has(name)).toBe(true);
    expect(SHELLS.has("omo")).toBe(false);
  });
});
