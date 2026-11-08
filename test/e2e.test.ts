import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { IS_WINDOWS, paneCommand, shellFromProcess, type PaneShell } from "../src/shell.ts";

// Real herdr, isolated named session, fake agent instead of a model: proves the pane plumbing end to end.
const herdrBin = Bun.which("herdr");
const session = `dori-e2e-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "dori-e2e-"));
const cli = resolve(import.meta.dir, "../src/cli.ts");
// Pinned to herdr, and outside any session of the host's own runtimes, so the lane opens in the isolated session only.
const { HC_TERMINAL_ID: _hc, HERDR_PANE_ID: _pane, HERDR_WORKSPACE_ID: _ws, ...outer } = process.env;
const env = { ...outer, DORI_HOME: home, DORI_HERDR_SESSION: session, DORI_TELEMETRY: "0", DORI_RUNTIME: "herdr" };
const fixture = (name: string) => resolve(import.meta.dir, "fixtures", name);
let server: ReturnType<typeof Bun.spawn> | undefined;

const herdr = async (...argv: string[]) => {
  const r = await spawnExec("herdr", ["--session", session, ...argv]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}").result;
};
const dori = async (...argv: string[]) => {
  const p = Bun.spawn(["bun", cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${code}: ${err}`);
  return out;
};
const until = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
// The lead here is `cat`, which herdr does not recognise as an agent: a bare shell pane. Messages for it must stay in its
// inbox and never be typed into it (#66).
const leadInbox = (lead: string) => Bun.file(join(home, "inbox", `${lead.replaceAll(":", "_")}.jsonl`)).text();
const leadScreen = async (lead: string) =>
  (await spawnExec("herdr", ["--session", session, "pane", "read", lead, "--lines", "80", "--source", "recent"]))
    .stdout;

const paneShell = async (pane: string): Promise<PaneShell | undefined> => {
  const r = await spawnExec("herdr", ["--session", session, "pane", "process-info", "--pane", pane]);
  if (r.code !== 0) return undefined;
  const info = JSON.parse(r.stdout || "{}") as {
    result?: { process_info?: { foreground_processes?: { name?: string; argv0?: string }[] } };
  };
  for (const p of info.result?.process_info?.foreground_processes ?? []) {
    const found = shellFromProcess(p.name ?? "") ?? shellFromProcess(p.argv0 ?? "");
    if (found) return found;
  }
  return undefined;
};

// Lines typed before the sink reads stdin go to the shell that is still starting it, so nothing is sent until it says so.
const holdPane = async (pane: string, shell: PaneShell) => {
  await herdr("pane", "run", pane, paneCommand([process.execPath, fixture("sink.ts")], shell));
  await until(
    "the sink in the lead pane",
    async () => {
      const r = await spawnExec("herdr", [
        "--session",
        session,
        "pane",
        "read",
        pane,
        "--lines",
        "20",
        "--source",
        "recent",
      ]);
      return /^SINK_READY/m.test(r.stdout) ? true : undefined;
    },
    40_000,
  ); // a new pane's shell can take over 20 s to start on a loaded Windows host
};

beforeAll(async () => {
  if (!herdrBin) return;
  server = Bun.spawn([herdrBin, "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
});

afterAll(async () => {
  if (!herdrBin) return;
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  await spawnExec("herdr", ["session", "delete", session]);
});

test.skipIf(!herdrBin)(
  "a lane started in real herdr reports and finishes; the lead pane has no agent, so both wait in its inbox",
  async () => {
    const ws = await herdr("workspace", "create", "--label", "e2e", "--cwd", home, "--no-focus");
    const lead = ws.root_pane.pane_id as string;
    const shell = (await paneShell(lead)) ?? (IS_WINDOWS ? "pwsh" : "posix");
    await holdPane(lead, shell);
    await dori("role", "lead", lead);
    const brief = join(home, "brief.md");
    writeFileSync(brief, "E2E-BRIEF say hello\n");

    const fake = resolve(import.meta.dir, "fixtures/fake-agent.ts");
    const started = Bun.spawn(
      ["bun", cli, "start", "e2e-lane", "--brief", brief, "--workspace", ws.workspace.workspace_id],
      {
        env: { ...env, DORI_PANE_SHELL: shell, DORI_AGENT_CMD: paneCommand([process.execPath, fake, cli], shell) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([new Response(started.stdout).text(), new Response(started.stderr).text()]);
    expect(`${out}${err}`).toContain("STARTED e2e-lane");
    expect(await started.exited).toBe(0);

    const leadText = await until("READY in the lead inbox", async () => {
      const text = await leadInbox(lead);
      return text.includes("[READY e2e-lane]") ? text : undefined;
    });
    expect(await leadScreen(lead)).not.toContain("e2e-lane");
    expect(leadText).toContain("[START e2e-lane]");
    expect(leadText).toContain("[REPORT e2e-lane] read brief: E2E-BRIEF say hello");
    expect(leadText).toContain("[READY e2e-lane] e2e lane finished");
    expect(await dori("status")).toMatch(/e2e-lane\s+ready/);
    expect(await dori("done", "e2e-lane")).toContain("DONE e2e-lane");
  },
  120_000,
);

test.skipIf(!herdrBin)(
  "the hourly loop starts a backlog item as a lane in real herdr and reports the run to the lead",
  async () => {
    const ws = await herdr("workspace", "create", "--label", "e2e-loop", "--cwd", home, "--no-focus");
    const lead = ws.root_pane.pane_id as string;
    const shell = (await paneShell(lead)) ?? (IS_WINDOWS ? "pwsh" : "posix");
    await holdPane(lead, shell);
    await dori("role", "lead", lead);
    const brief = join(home, "loop-brief.md");
    writeFileSync(brief, "E2E-LOOP-BRIEF\n");
    expect(await dori("backlog", "add", "loop-item", "--brief", brief, "--cwd", home, "--priority", "2")).toContain(
      "ADDED loop-item p2",
    );

    const loop = Bun.spawn(["bun", cli, "loop", "--once", "--max-lanes", "5", "--max-load", "100000"], {
      env: {
        ...env,
        HERDR_WORKSPACE_ID: ws.workspace.workspace_id,
        DORI_PANE_SHELL: shell,
        DORI_AGENT_CMD: paneCommand([process.execPath, fixture("fake-agent.ts"), cli], shell),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(loop.stdout).text(), new Response(loop.stderr).text()]);
    expect(await loop.exited).toBe(0);
    expect(out + err).toContain("LOOP started=1");

    const leadText = await until(
      "READY from the loop-started lane in the lead inbox",
      async () => {
        const text = await leadInbox(lead);
        return text.includes("[READY loop-item]") ? text : undefined;
      },
      40_000,
    );
    expect(await leadScreen(lead)).not.toContain("loop-item");
    expect(leadText).toContain("[START loop-item]");
    expect(leadText).toContain("[LOOP ");
    expect(leadText).toContain("started: loop-item (p2)");
    expect(await dori("backlog", "list")).toMatch(/loop-item\s+running/);
    expect(await dori("loop", "status")).toContain("started: loop-item (p2)");
    expect(await dori("loop", "stop", "--text", "e2e pause")).toContain("LOOP STOPPED");
    expect(await dori("loop", "--once")).toContain("LOOP skipped: stopped: e2e pause");
    expect(await dori("done", "loop-item")).toContain("DONE loop-item");
  },
  120_000,
);

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
