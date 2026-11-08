import type { Exec } from "../exec.ts";
import type { CreateSpec, SessionInfo, SessionRef } from "../types.ts";
import { hcCall, isKind } from "./exec.ts";
import { statusWord } from "./probe.ts";

const NAME_MAX = 32;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RM_RETRIES = 5;
export const RM_RETRY_MS = 200;

/**
 * hc's name rule (0.1.17): 1-32 of a-z 0-9 - _ . starting with a letter or digit, and never id-shaped (`t7`,
 * `machine/t7`), because a name is resolved before an id. Lowercased, other characters become `-`, leading separators
 * are dropped; undefined when nothing usable is left (the terminal then has no name, only its labels).
 */
export function slugName(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, NAME_MAX);
  if (slug === "" || /^t[0-9]+$/.test(slug)) return undefined;
  return slug;
}

const rows = (result: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(result["terminals"])
    ? result["terminals"].filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    : [];
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
// Addresses with a machine prefix (`machine/t7`) are another core's terminals, mirrored into this core's list.
const isLocal = (address: string | undefined): address is string => address !== undefined && !address.includes("/");

async function liveNames(exec: Exec): Promise<Set<string>> {
  const names = new Set<string>();
  for (const t of rows(await hcCall(exec, ["ls"]))) {
    const name = str(t["name"]);
    if (isLocal(str(t["address"])) && t["state"] === "live" && name !== undefined) names.add(name);
  }
  return names;
}

const PS_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
const psLiteral = (s: string): string => `'${s.replace(PS_QUOTES, (c) => c + c)}'`;

/**
 * The shell with the env set. POSIX: the `env` utility, one argv element per K=V. Windows has no `env` and hc no
 * --env flag: PowerShell sets each variable as a literal and keeps its prompt (-NoExit).
 */
export function shellArgv(shell: string, env: Readonly<Record<string, string>>, windows: boolean): string[] {
  if (!windows) return ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), shell];
  const set = Object.entries(env)
    .map(([k, v]) => `$env:${k} = ${psLiteral(v)}`)
    .join("; ");
  return [shell, "-NoLogo", "-NoExit", ...(set === "" ? [] : ["-Command", set])];
}

/** The `hc run` argv for a spec: labels for grouping, the user's shell with the env set (see shellArgv). */
export function createArgv(spec: CreateSpec, shell: string, name: string | undefined, windows = false): string[] {
  for (const key of Object.keys(spec.env))
    if (!ENV_KEY.test(key)) throw new Error(`env key ${JSON.stringify(key)} is not a shell variable name`);
  const labels = [
    `dori.group=${spec.group ?? "dori"}`,
    `dori.role=${spec.role}`,
    `dori.name=${spec.name}`,
    ...(spec.role === "lane" ? [`dori.lane=${spec.name}`] : []),
  ];
  return [
    "run",
    "--bg",
    "--no-parent",
    "--no-notify",
    "--cwd",
    spec.cwd,
    ...labels.flatMap((l) => ["--label", l]),
    ...(name === undefined ? [] : ["--name", name]),
    "--",
    ...shellArgv(shell, spec.env, windows),
  ];
}

/**
 * A terminal running the user's shell with the env set, no parent and no notes (Dori's inbox is the only delivery
 * path). The slug name is used only when no live terminal holds it; a name taken in between is retried without one.
 * Identity is the address plus labels, never the name.
 */
export async function create(exec: Exec, spec: CreateSpec, shell: string, windows = false): Promise<SessionRef> {
  const slug = slugName(spec.name);
  const name = slug !== undefined && !(await liveNames(exec)).has(slug) ? slug : undefined;
  let result: Record<string, unknown>;
  try {
    result = await hcCall(exec, createArgv(spec, shell, name, windows));
  } catch (e) {
    if (name === undefined || !isKind(e, "name_taken")) throw e;
    result = await hcCall(exec, createArgv(spec, shell, undefined, windows));
  }
  const id = str(result["address"]);
  if (id === undefined) throw new Error("hc run did not return an address");
  return { runtime: "hc", id, group: spec.group ?? "dori" };
}

const PROMPT_POLLS = 50;
const PROMPT_POLL_MS = 200;
const PS_PROMPT = /PS [^\n]*>\s*$/;

/**
 * Windows: a PowerShell that is still starting can drop what is typed, so a new session's screen is read until its
 * `PS ...>` prompt is at the bottom (10 s at most; a prompt of another shape only costs the wait).
 */
export async function waitForPrompt(exec: Exec, id: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < PROMPT_POLLS; i++) {
    try {
      const text = (await hcCall(exec, ["read", id, "--lines", "0"]))["text"];
      if (typeof text === "string" && PS_PROMPT.test(text)) return;
    } catch {
      // a terminal that cannot be read yet is waited for like one that shows no prompt
    }
    await sleep(PROMPT_POLL_MS);
  }
}

/** Types the command into the session's shell: a shell reports no status, so there is no `--if` gate. */
export async function start(exec: Exec, id: string, command: string): Promise<void> {
  await hcCall(exec, ["send", id, "--", command]);
}

/** This core's live terminals, all of them or those labelled `dori.group=<group>`. */
export async function list(exec: Exec, group: string | undefined): Promise<SessionInfo[]> {
  const result = await hcCall(exec, ["ls", ...(group === undefined ? [] : ["--label", `dori.group=${group}`])]);
  const out: SessionInfo[] = [];
  for (const t of rows(result)) {
    const id = str(t["address"]);
    if (!isLocal(id) || t["state"] !== "live") continue;
    const [name, cwd, status, agent] = [str(t["name"]), str(t["cwd"]), statusWord(t["status"]), str(t["agent"])];
    out.push({
      ref: { runtime: "hc", id, ...(group === undefined ? {} : { group }) },
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(status === undefined ? {} : { status }),
      ...(agent === undefined ? {} : { agent }),
    });
  }
  return out;
}

/**
 * Kill, then remove the record. A program that takes a moment to die makes `rm` answer `live`: retried 5 times
 * 200 ms apart; still live after that is logged (the kill was sent), not thrown. An unknown terminal is already closed.
 */
export async function close(
  exec: Exec,
  id: string,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
): Promise<void> {
  try {
    await hcCall(exec, ["kill", id]);
  } catch (e) {
    if (isKind(e, "not_found")) return;
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await hcCall(exec, ["rm", id]);
      return;
    } catch (e) {
      if (isKind(e, "not_found")) return;
      if (!isKind(e, "live")) throw e;
      if (attempt >= RM_RETRIES) {
        log(`dori: hc terminal ${id} still running after kill; left in place`);
        return;
      }
      await sleep(RM_RETRY_MS);
    }
  }
}

export function selfRef(env: Readonly<Record<string, string | undefined>>): SessionRef | undefined {
  const id = env["HC_TERMINAL_ID"];
  return id === undefined || id === "" ? undefined : { runtime: "hc", id };
}
