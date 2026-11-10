import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { IS_WINDOWS, paneCommand, type PaneShell } from "../src/shell.ts";

import { cli, fixture, herdrBin, until } from "./e2e-support.ts";

// Every pane shell for real: herdr's default_shell makes the panes dori opens that shell, and nothing tells dori which it is.
const gitBash =
  Bun.which("bash") ??
  (existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : null);
const windowsShells: readonly (readonly [PaneShell, string | null])[] = [
  ["pwsh", Bun.which("pwsh")],
  ["powershell", Bun.which("powershell")],
  ["cmd", Bun.which("cmd")],
  ["posix", gitBash],
];

describe.skipIf(!herdrBin || !IS_WINDOWS).each(windowsShells.filter(([, exe]) => exe))("a %s pane", (shell, exe) => {
  const name = `dori-e2e-${shell}-${process.pid}`;
  const own = mkdtempSync(join(tmpdir(), "dori-e2e-shell-"));
  const config = join(own, "config.toml");
  const { HERDR_PANE_ID: _pane, HERDR_WORKSPACE_ID: _workspace, DORI_PANE_SHELL: _forced, ...base } = process.env;
  const shellEnv = {
    ...base,
    DORI_HOME: own,
    DORI_HERDR_SESSION: name,
    // Pinned like the env above: with herdr and hc both on PATH, dori refuses to guess the runtime.
    DORI_RUNTIME: "herdr",
    DORI_TELEMETRY: "0",
    HERDR_CONFIG_PATH: config,
  };
  let shellServer: ReturnType<typeof Bun.spawn> | undefined;

  const call = async (...argv: string[]) => {
    const p = Bun.spawn(["herdr", "--session", name, ...argv], { env: shellEnv, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(err || out);
    return JSON.parse(out || "{}").result;
  };
  const cliRun = async (extra: Record<string, string>, ...argv: string[]) => {
    const p = Bun.spawn(["bun", cli, ...argv], { env: { ...shellEnv, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${code}: ${err}`);
    return out;
  };
  // A cmd pane hands the agent line to PowerShell 5.1, see appendArg.
  const agentLine = (argv: string[]) => paneCommand(argv, shell === "cmd" ? "powershell" : shell);

  beforeAll(async () => {
    writeFileSync(config, `[terminal]\ndefault_shell = ${JSON.stringify(exe!)}\n`);
    shellServer = Bun.spawn([herdrBin!, "--session", name, "server"], {
      env: shellEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    await until("herdr server", () => call("workspace", "list"));
  });

  afterAll(async () => {
    await spawnExec("herdr", ["--session", name, "server", "stop"]);
    await shellServer?.exited;
    await spawnExec("herdr", ["session", "delete", name]);
  });

  // The lead is the pane's bare shell, no agent: the READY waits in its inbox and is never typed into it (#66).
  test("runs a lane to READY; the lead pane has no agent, so the multi-line message waits in its inbox", async () => {
    const ws = await call("workspace", "create", "--label", "lane", "--cwd", own, "--no-focus");
    const lead = ws.root_pane.pane_id as string;
    await cliRun({}, "role", "lead", lead);
    const brief = join(own, "brief.md");
    writeFileSync(brief, "SHELL-BRIEF hello\n");
    const agent = agentLine([process.execPath, fixture("fake-agent.ts"), cli]);
    expect(
      await cliRun(
        { DORI_AGENT_CMD: agent },
        "start",
        "shell-lane",
        "--brief",
        brief,
        "--workspace",
        ws.workspace.workspace_id,
        "--cwd",
        own,
      ),
    ).toContain("STARTED shell-lane");
    // Git Bash panes start slowly on a loaded Windows host (36 s seen alone): the deadline leaves room for that.
    await until(
      "the lane to go READY",
      async () => (/shell-lane\s+ready/.test(await cliRun({}, "status")) ? true : undefined),
      80_000,
    );
    const inbox = join(own, "inbox", `${lead.replaceAll(":", "_")}.jsonl`);
    const leadText = await until("the READY message in the lead inbox", async () => {
      const text = existsSync(inbox) ? readFileSync(inbox, "utf8") : "";
      return text.includes("[READY shell-lane]") && text.includes("evidence: file://") ? text : undefined;
    });
    expect(leadText).toContain("[REPORT shell-lane] read brief: SHELL-BRIEF hello");
    const screen = await spawnExec("herdr", [
      "--session",
      name,
      "pane",
      "read",
      lead,
      "--lines",
      "120",
      "--source",
      "recent",
    ]);
    expect(screen.code).toBe(0);
    expect(screen.stdout).not.toContain("shell-lane");
  }, 150_000);

  test("dori up starts the lead with its prompt and the hourly loop with the default dori command", async () => {
    const record = (who: string) => agentLine([process.execPath, fixture("argv.ts"), join(own, who)]);
    const out = await cliRun({ DORI_AGENT_CMD: record("up-agent.json") }, "up", "--cwd", own);
    expect(out).toContain("hourly=");
    const argv = await until(
      "the agent command to run",
      async () => {
        const f = join(own, "up-agent.json");
        return existsSync(f) && readFileSync(f, "utf8") ? (JSON.parse(readFileSync(f, "utf8")) as string[]) : undefined;
      },
      40_000,
    ).catch(async (e: unknown) => {
      // The lead pane's screen shows what the shell did with the typed line.
      const lead = String(JSON.parse(readFileSync(join(own, "roles.json"), "utf8"))["lead"] ?? "");
      const screen = await spawnExec("herdr", [
        "--session",
        name,
        "pane",
        "read",
        lead,
        "--lines",
        "40",
        "--source",
        "recent",
      ]);
      throw new Error(`${e instanceof Error ? e.message : String(e)}; lead ${lead} screen:\n${screen.stdout}`);
    });
    expect(argv[0]).toBe("--append-system-prompt");
    expect(readFileSync(argv[1]!, "utf8")).toContain("You are the ");
    await until(
      "the hourly pane's first run",
      async () => (existsSync(join(own, "loop", "last-run.json")) ? true : undefined),
      40_000,
    );
  }, 90_000);
});
