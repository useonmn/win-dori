import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

import { IS_WINDOWS } from "./paths.ts";
import type { Exec } from "../../../../src/runtime/exec.ts";
import { HcRuntime } from "../../../../src/runtime/hc/index.ts";
import { HerdrRuntime } from "../../../../src/runtime/herdr/index.ts";
import { Runtimes } from "../../../../src/runtime/registry.ts";
import { type RuntimeChoice, readRuntimeChoice } from "../../../../src/runtime/select.ts";
import type { RuntimeKind, SessionRuntime } from "../../../../src/runtime/types.ts";
import { configPath, type DoriConfig } from "./config.ts";
import { cmdLine, shimTarget } from "./run-windows.ts";

export type Ran = { readonly code: number; readonly out: string; readonly err: string };
export type RunOptions = { readonly cwd?: string; readonly timeoutMs?: number; readonly preserveOutput?: boolean };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

/** What resolveCommand needs from the host; tests pass a fake to exercise both platforms. */
export type CommandSys = {
  readonly platform: NodeJS.Platform;
  readonly which: (command: string, cwd?: string) => string | null;
  readonly read: (path: string) => string | null;
  readonly exists: (path: string) => boolean;
  readonly cmdExe: string;
  readonly execPath: string;
};

export const realSys: CommandSys = {
  platform: process.platform,
  which: (command, cwd) => Bun.which(command, cwd ? { cwd } : undefined),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists: existsSync,
  cmdExe: win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"),
  execPath: process.execPath,
};

/** `verbatim`: argv[1..] is already a cmd.exe command line and must reach CreateProcess unquoted. */
export type Resolved = { readonly argv: readonly string[]; readonly verbatim: boolean } | { readonly refused: string };

/**
 * The argv that runs `argv` on this platform. Identity off Windows and for .exe/.com. A .bat/.cmd never reaches
 * Bun's own .cmd handling (which refuses any argument holding a cmd.exe metacharacter): an npm-style node shim is run
 * as `node script ...args` with no cmd.exe at all; any other batch file goes through `cmd.exe /d /s /c` with
 * BatBadBut-safe quoting, or is refused when an argument cannot be passed safely.
 */
export const resolveCommand = (argv: readonly string[], cwd?: string, sys: CommandSys = realSys): Resolved => {
  const [head, ...args] = argv;
  if (sys.platform !== "win32" || head === undefined) return { argv, verbatim: false };
  const found = sys.which(head, cwd);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { argv, verbatim: false };
  const text = sys.read(found);
  const target = text === null ? null : shimTarget(found, text, sys);
  return target ? { argv: [...target, ...args], verbatim: false } : cmdLine(found, args, sys);
};

const runPosix: Runner = async (argv, opts = {}) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}),
    });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const [out, err, code] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]);
  return {
    code: p.signalCode ? 124 : code,
    out: opts.preserveOutput ? out : out.trim(),
    err: (p.signalCode ? `killed by ${p.signalCode} (timeout)` : err).trim(),
  };
};

/** A Windows system tool by absolute path: Git Bash puts /usr/bin first on PATH, where whoami, find, sort, timeout and others shadow the Windows ones. */
export const systemTool = (name: string, root = process.env["SystemRoot"] ?? "C:\\Windows"): string =>
  win32.join(root, "System32", `${name}.exe`);

const TASKKILL = systemTool("taskkill");

// Killing only the direct child would orphan its children, which keep running and can hold the output pipes open.
const killTree = async (p: ReturnType<typeof Bun.spawn>): Promise<void> => {
  try {
    await Bun.spawn([TASKKILL, "/T", "/F", "/PID", String(p.pid)], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // taskkill missing: the direct kill below is all that is left.
  }
  p.kill();
};

const runWindows: Runner = async (argv, opts = {}) => {
  const resolved = resolveCommand(argv, opts.cwd);
  if ("refused" in resolved) return { code: 126, out: "", err: resolved.refused };
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([...resolved.argv], {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(resolved.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  let killing: Promise<void> | undefined;
  const proc = p;
  const timer = opts.timeoutMs ? setTimeout(() => (killing = killTree(proc)), opts.timeoutMs) : undefined;
  void p.exited.then(() => clearTimeout(timer));
  const [out, err, code] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]);
  const timedOut = killing !== undefined;
  await killing;
  return {
    code: timedOut ? 124 : code,
    out: opts.preserveOutput ? out : out.trim(),
    err: (timedOut ? "killed process tree (timeout)" : err).trim(),
  };
};

export const run: Runner = IS_WINDOWS ? runWindows : runPosix;

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The runtimes of one process plus the choice that picked the default kind (printed by `dori boot`). A choice that
 * failed (no runtime detected, a bad DORI_RUNTIME) is thrown only where a new session would open, `default`: stored
 * lanes (`for`) and the caller's own session (`selfAny`) still resolve.
 */
export class ChosenRuntimes extends Runtimes {
  readonly choice: RuntimeChoice | undefined;
  readonly failure: Error | undefined;

  constructor(pick: () => RuntimeChoice, make: (kind: RuntimeKind) => SessionRuntime) {
    let choice: RuntimeChoice | undefined;
    let failure: Error | undefined;
    try {
      choice = pick();
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    // Without a choice the selected kind is never read: `default` throws the failure first.
    super(choice?.kind ?? "hc", make);
    this.choice = choice;
    this.failure = failure;
  }

  override get default(): SessionRuntime {
    if (this.failure) throw this.failure;
    return super.default;
  }
}

/** `DORI_RUNTIME` > the config's `runtime` > the root's detection (inside hc, inside herdr, hc on PATH, else herdr). */
export const runtimeChoice = (config: Pick<DoriConfig, "runtime">, env: Env): RuntimeChoice => {
  const fromEnv = env["DORI_RUNTIME"];
  if (!fromEnv && config.runtime !== undefined) return { kind: config.runtime, source: "config" };
  return readRuntimeChoice({ env, configPath: configPath() });
};

/** Every runtime behind the skill's Runner, so tests swap the binaries for a recorder; sleeps go through the clock. */
export const runtimesFor = (
  config: Pick<DoriConfig, "runtime">,
  env: Env,
  runner: Runner = run,
  clock: Clock = realClock,
): ChosenRuntimes => {
  const exec: Exec = async (cmd, argv) => {
    const r = await runner([cmd, ...argv]);
    return { code: r.code, stdout: r.out, stderr: r.err };
  };
  const make: Record<RuntimeKind, () => SessionRuntime> = {
    herdr: () => new HerdrRuntime(exec, env["DORI_HERDR_SESSION"], { env, sleep: clock.sleep }),
    hc: () => new HcRuntime(exec, { env, sleep: clock.sleep }),
  };
  return new ChosenRuntimes(
    () => runtimeChoice(config, env),
    (kind) => make[kind](),
  );
};

const built = new WeakMap<object, ChosenRuntimes>();

/** The deps' own runtimes when injected, else one registry per deps object over its Runner and clock. */
export const runtimesOf = (deps: {
  readonly run: Runner;
  readonly clock: Clock;
  readonly config: Pick<DoriConfig, "runtime">;
  readonly rts?: ChosenRuntimes;
  readonly env?: Env;
}): ChosenRuntimes => {
  if (deps.rts) return deps.rts;
  let rts = built.get(deps);
  if (!rts) {
    rts = runtimesFor(deps.config, deps.env ?? process.env, deps.run, deps.clock);
    built.set(deps, rts);
  }
  return rts;
};
