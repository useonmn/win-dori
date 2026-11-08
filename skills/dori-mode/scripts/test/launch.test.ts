import { expect, test } from "bun:test";

import { lastLines, paneCommand, quoteForPane, resolvePaneShell, shellFromProcess } from "../src/launch.ts";

const tricky = ["bun", "-e", "x", "--", 'it\'s "quoted"; & | % ^ $x', "C:\\Program Files\\a b", "\u00fc \ud55c\uae00"];

test("posix quoting is unchanged: safe words stay bare, others get single quotes", () => {
  expect(quoteForPane("--model")).toBe("--model");
  expect(quoteForPane("it's")).toBe("'it'\\''s'");
  expect(paneCommand(["omo", "a b"], "posix")).toBe("omo 'a b'");
});

test("pwsh single-quotes every argument and doubles ' and typographic quotes", () => {
  expect(paneCommand(["bun", "it's \u2018x\u2019 \u201Ay\u201B"], "pwsh")).toBe(
    "& 'bun' 'it''s \u2018\u2018x\u2019\u2019 \u201A\u201Ay\u201B\u201B'",
  );
  expect(paneCommand(tricky, "pwsh")).toContain("'C:\\Program Files\\a b'");
});

test("powershell 5.1 also escapes embedded double quotes, trailing backslashes and empty arguments", () => {
  expect(paneCommand(["x", 'a"b', "", "c d\\", 'q\\"r'], "powershell")).toBe(
    `& 'x' 'a\\"b' '""' 'c d\\\\' 'q\\\\\\"r'`,
  );
});

test("powershell 5.1 keeps a quoted argument with a space whole: it would not wrap it, so the quotes stay balanced", () => {
  expect(paneCommand(["x", '"b c"'], "powershell")).toBe(`& 'x' '"""b c"""'`);
});

test("cmd gets an -EncodedCommand carrying the powershell form, with no cmd metacharacter in the line", () => {
  const line = paneCommand(tricky, "cmd");
  const [exe, flag, name, b64] = line.split(" ");
  expect([exe, flag, name]).toEqual(["powershell", "-NoProfile", "-EncodedCommand"]);
  expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(Buffer.from(b64 ?? "", "base64").toString("utf16le")).toBe(paneCommand(tricky, "powershell"));
});

test("shell names map from process names with or without .exe and path", () => {
  expect(shellFromProcess("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
  expect(shellFromProcess("PowerShell.EXE")).toBe("powershell");
  expect(shellFromProcess("cmd.exe")).toBe("cmd");
  expect(shellFromProcess("/bin/zsh")).toBe("posix");
  expect(shellFromProcess("bun.exe")).toBeUndefined();
});

// The new session's foreground as the runtime's probe reports it; "bad" is a probe that fails.
const infoRunner = (procs: { name?: string; argv0?: string }[] | "bad") => async () => {
  if (procs === "bad") throw new Error("probe failed");
  return procs;
};

test("auto detects the pane shell on Windows, falls back to pwsh, and is posix elsewhere", async () => {
  expect(await resolvePaneShell("auto", infoRunner([{ name: "cmd.exe" }]), true)).toBe("cmd");
  expect(await resolvePaneShell(undefined, infoRunner([{ name: "x", argv0: "C:\\w\\powershell.exe" }]), true)).toBe(
    "powershell",
  );
  expect(await resolvePaneShell("auto", infoRunner([{ name: "bash" }]), true)).toBe("posix");
  expect(await resolvePaneShell("auto", infoRunner([{ name: "bun.exe" }]), true)).toBe("pwsh");
  expect(await resolvePaneShell("auto", infoRunner("bad"), true)).toBe("pwsh");
  expect(await resolvePaneShell("auto", infoRunner([{ name: "cmd.exe" }]), false)).toBe("posix");
  expect(await resolvePaneShell("cmd", infoRunner([]), false)).toBe("cmd");
});

test("lastLines scrubs POSIX and Windows local paths and the home directory but not URLs", () => {
  const screen =
    "see C:\\Users\\ana\\code\\x.txt and D:/work/y and /Users/bob/z\nhttps://example.com/a ok in C:\\Users\\ana";
  expect(lastLines(screen, "C:\\Users\\ana")).toBe(
    "see ~\\code\\x.txt and (local path) and (local path) / https://example.com/a ok in ~",
  );
  expect(lastLines("", "C:\\Users\\ana")).toBe("(blank)");
});
