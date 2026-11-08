import { describe, expect, test } from "bun:test";
import { childrenScript } from "../src/runtime/hc/below-shell.ts";
import { parseProbe } from "../src/runtime/hc/probe.ts";
import { createArgv, shellArgv } from "../src/runtime/hc/sessions.ts";
import { terminal } from "./fake-hc.ts";
import { lane, rig, T1 } from "./hc-rig.ts";

// herdr-core #70 on Windows (seen with hc 0.1.18 on this port's PC): foreground stays the terminal's own pwsh.exe
// (pid === the terminal pid) while a program runs in it; OSC 7501 words still arrive, and the last one stays after
// the program exits.
const pwsh = { name: "pwsh.exe", argv: ["pwsh.exe", "-NoLogo", "-NoExit"], pid: 900 };
const win = (below: boolean) => ({ windows: true, belowShell: async () => below });

describe("hc on Windows: the shell and its env", () => {
  test("PowerShell sets each variable as a literal and keeps its prompt; no env, no -Command", () => {
    expect(shellArgv("pwsh.exe", lane.env, true)).toEqual([
      "pwsh.exe",
      "-NoLogo",
      "-NoExit",
      "-Command",
      "$env:A = '1'; $env:B = 'it''s a b'",
    ]);
    expect(shellArgv("powershell.exe", {}, true)).toEqual(["powershell.exe", "-NoLogo", "-NoExit"]);
    expect(createArgv(lane, "pwsh.exe", "lane-k", true).slice(-6)).toEqual([
      "--",
      "pwsh.exe",
      "-NoLogo",
      "-NoExit",
      "-Command",
      "$env:A = '1'; $env:B = 'it''s a b'",
    ]);
  });

  test("create runs PowerShell on Windows, never the env utility", async () => {
    const { fake, rt } = rig({}, { SHELL: "/usr/bin/bash" }, win(false));
    await rt.create(lane);
    const run = fake.calls.find((argv) => argv.includes("--bg")) ?? [];
    expect(run).not.toContain("env");
    expect(run[run.indexOf("--") + 1]).toMatch(/^(pwsh|powershell)\.exe$/);
  });
});

describe("hc on Windows: #70, a terminal whose foreground is its own shell", () => {
  test("a program below the shell that reported a word: that word, no shell in front", () => {
    const p = parseProbe(terminal({ foreground: pwsh, status: { state: "idle", app: "omo" }, reported: true }), true);
    expect(p).toMatchObject({ status: "idle", shellInFront: false, agent: "omo" });
  });

  test("no program below the shell: a shell in front, and a stale word from an exited program is not believed", () => {
    const p = parseProbe(terminal({ foreground: pwsh, status: { state: "idle", app: "fake" }, reported: true }), false);
    expect(p).toMatchObject({ status: "shell", shellInFront: true });
  });

  test("a program below the shell that never reported is unknown: deliver holds it, the operator cannot type", async () => {
    const t = terminal({ foreground: pwsh, status: null, reported: false });
    expect(parseProbe(t, true)).toMatchObject({ status: "unknown", shellInFront: false });
    const { rt } = rig({ t1: t }, {}, win(true));
    expect(await rt.deliver(T1, "hi")).toEqual({ kind: "not-ready", status: "unknown" });
    expect(await rt.typeIntoShell(T1, "dir")).toBe(false);
  });

  test("deliver sends to a reporting agent below the shell, and holds when only the shell is left", async () => {
    const t = () => terminal({ foreground: pwsh, status: { state: "idle", app: "omo" }, reported: true });
    const running = rig({ t1: t() }, {}, win(true));
    expect((await running.rt.deliver(T1, "hi")).kind).toBe("delivered");
    const exited = rig({ t1: t() }, {}, win(false));
    expect(await exited.rt.deliver(T1, "hi")).toEqual({ kind: "no-agent" });
    expect(exited.fake.calls.some((argv) => argv.includes("send"))).toBe(false);
  });

  test("list believes a listed word only while a program runs below the shell: an exited lane lists as a shell", async () => {
    const t = () => terminal({ foreground: pwsh, status: { state: "idle", app: "fake" }, reported: true });
    expect((await rig({ t1: t() }, {}, win(false)).rt.list()).map((s) => s.status)).toEqual(["shell"]);
    expect((await rig({ t1: t() }, {}, win(true)).rt.list()).map((s) => s.status)).toEqual(["idle"]);
    expect((await rig({ t1: t() }).rt.list()).map((s) => s.status)).toEqual(["idle"]);
  });

  test("the POSIX adapter reads the same record as a shell in front, as upstream does", () => {
    expect(parseProbe(terminal({ foreground: pwsh, status: { state: "idle" }, reported: true })).shellInFront).toBe(
      true,
    );
  });

  test("the process lookup asks for the shell's children, the console host left out", () => {
    expect(childrenScript(900)).toContain("ParentProcessId=900");
    expect(childrenScript(900)).toContain("conhost.exe");
  });
});

describe("hc on Windows: a new PowerShell is typed into only once its prompt is up", () => {
  test("start reads the screen until PS ...> is at the bottom, then sends", async () => {
    const { fake, rt, sleeps } = rig({ t1: terminal({ screen: "PS C:\\w> " }) }, {}, win(false));
    await rt.start(T1, "omo");
    expect(fake.calls.filter((a) => a.includes("read"))).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(fake.sent.at(-1)?.text).toBe("omo");
  });

  test("no prompt within 10 s still sends; off Windows nothing is read first", async () => {
    const slow = rig({ t1: terminal({ screen: "Loading personal and system profiles..." }) }, {}, win(false));
    await slow.rt.start(T1, "omo");
    expect(slow.sleeps).toHaveLength(50);
    expect(slow.fake.sent.at(-1)?.text).toBe("omo");
    const posix = rig({ t1: terminal() });
    await posix.rt.start(T1, "omo");
    expect(posix.fake.calls.some((a) => a.includes("read"))).toBe(false);
  });
});
