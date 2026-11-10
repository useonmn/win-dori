import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLane, LaunchError } from "../src/launch.ts";
import { cliCommand, footer, shellQuote } from "../src/launch-footer.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

const working: Lane = {
  key: "quiet-lane",
  title: "quiet",
  thread: "chat:team/9",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  lastReplyAt: T0,
};

test("the lane footer calls the skill CLI by its own path, never a bare dori that may be the root harness", async () => {
  const text = footer({ ...working, key: "path-lane" }, "lead:p1");
  const commands = [...text.matchAll(/bun (\S+) (report|claim-done) path-lane/g)];
  expect(commands.map((m) => m[2])).toEqual(["report", "claim-done"]);
  for (const [, cli] of commands) {
    expect(cli).toEndWith("/skills/dori-mode/scripts/src/cli.ts");
    expect(await Bun.file(cli ?? "").exists()).toBe(true);
  }
  expect(text).not.toMatch(/(^|\s)dori (report|claim-done)/);
});

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(
    adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" }),
  ).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, {
    key: "x-lane",
    title: "x",
    brief: "/b.md",
    done: "closed acme/app#3",
    pane: "w:p2",
  });
  expect(ok.thread).toBe("none");
  await expect(
    adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" }),
  ).rejects.toThrow("already registered");
});

// A POSIX shell to run the footer command in: on Windows, Git for Windows' bash (never WSL's System32 bash, which
// cannot see C:/ paths); none means the shell half of the next test cannot run here.
const gitBash = join(process.env["ProgramFiles"] ?? "C:/Program Files", "Git", "bin", "bash.exe");
const posixShell = process.platform !== "win32" ? Bun.which("bash") : existsSync(gitBash) ? gitBash : null;

test("on Windows the footer names the CLI with forward slashes, bare without a space; on POSIX a backslash is quoted", () => {
  expect(cliCommand("D:\\code\\dori\\skills\\dori-mode\\scripts\\src\\cli.ts", true)).toBe(
    "bun D:/code/dori/skills/dori-mode/scripts/src/cli.ts",
  );
  expect(cliCommand("C:\\Users\\Ana Lee\\cli.ts", true)).toBe("bun 'C:/Users/Ana Lee/cli.ts'");
  expect(cliCommand("/opt/dori/src/cli.ts", false)).toBe("bun /opt/dori/src/cli.ts");
  expect(cliCommand("/opt/odd\\name/cli.ts", false)).toBe("bun '/opt/odd\\name/cli.ts'");
});

test.skipIf(!posixShell)("the footer CLI command survives a skill path with a space or a quote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori skill's dir "));
  try {
    const cli = join(dir, "cli.ts");
    writeFileSync(cli, 'console.log("CLI_OK " + process.argv.slice(2).join(" "));\n');
    expect(shellQuote("/plain/path/cli.ts")).toBe("/plain/path/cli.ts");
    const command = cliCommand(cli);
    const proc = Bun.spawn([posixShell!, "-c", `${command} report path-lane --kind milestone`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe("CLI_OK report path-lane --kind milestone");
    expect(await proc.exited).toBe(0);
    expect(footer({ ...working, key: "path-lane" }, "lead:p1")).toContain(cliCommand());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
