import { interactiveShellInFront } from "../foreground.ts";
import { omoScreenIdle } from "../herdr/probe.ts";
import type { AgentStatus, ForegroundProcess, Probe } from "../types.ts";
import type { Exec } from "../exec.ts";
import type { BelowShell } from "./below-shell.ts";
import { hcCall, isKind } from "./exec.ts";

/** Recent lines read to look for omo's idle input box (the same window the herdr runtime reads). */
const SCREEN_LINES = 30;

const REPORTED: ReadonlySet<string> = new Set(["idle", "working", "blocked", "error", "done"]);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function foregroundOf(value: unknown): ForegroundProcess | undefined {
  const fg = rec(value);
  const name = text(fg?.["name"]);
  if (fg === undefined || name === undefined) return undefined;
  const argv = Array.isArray(fg["argv"]) ? fg["argv"].filter((a): a is string => typeof a === "string") : [name];
  const pid = num(fg["pid"]);
  return { name, argv, ...(pid === undefined ? {} : { pid }) };
}

/** The status word of hc's `status` field (an object `{state}`, or a bare word in `ls` rows); undefined when it never reported. */
export function statusWord(value: unknown): AgentStatus | undefined {
  const word = typeof value === "string" ? value : text(rec(value)?.["state"]);
  if (word === undefined) return undefined;
  return REPORTED.has(word) ? (word as AgentStatus) : "unknown";
}

/**
 * One `hc get` record as a Probe. The status is the program's own OSC 7501 word; a program that never reported is a
 * `shell` when an interactive shell leads the foreground, else `unknown`. The screen check is applied by `probe`.
 */
export function parseProbe(terminal: unknown, programBelowShell?: boolean): Probe {
  const t = rec(terminal) ?? {};
  if (t["state"] === "finished") return { status: "gone", shellInFront: false };
  const fg = foregroundOf(t["foreground"]);
  const foreground = fg === undefined ? undefined : [fg];
  const [rootPid, turn, title, cwd] = [num(t["pid"]), num(t["turn"]), text(t["title"]), text(t["cwd"])];
  // Windows (#70): the foreground is the terminal's own shell whatever runs in it, so `programBelowShell` (from the
  // process tree) decides. With no program below it the shell is in front and a reported word is stale: a program
  // that exited keeps its last OSC 7501 word, so it is never believed then.
  const ownShell = programBelowShell !== undefined && fg?.pid !== undefined && fg.pid === rootPid;
  const shellInFront = ownShell ? !programBelowShell : interactiveShellInFront(foreground);
  const reported = ownShell && !programBelowShell ? undefined : statusWord(t["status"]);
  const status = reported ?? (shellInFront ? "shell" : "unknown");
  const agent = (reported === undefined ? undefined : text(rec(t["status"])?.["app"])) ?? fg?.name;
  return {
    status,
    ...(agent === undefined ? {} : { agent }),
    ...(fg?.pid === undefined ? {} : { pgid: fg.pid }),
    ...(rootPid === undefined ? {} : { rootPid }),
    ...(turn === undefined ? {} : { turn }),
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront,
    ...(foreground === undefined ? {} : { foreground }),
  };
}

/** #62 on hc: believe the screen only when it positively shows omo's idle input; a failed read is doubt and stays working. */
async function screenShowsIdle(exec: Exec, id: string): Promise<boolean> {
  try {
    const result = await hcCall(exec, ["read", id, "--lines", String(SCREEN_LINES)]);
    return typeof result["text"] === "string" && omoScreenIdle(result["text"]);
  } catch {
    return false;
  }
}

/** A probe plus hc's own status word, which `deliver` needs for its compare-and-send gate. */
export type HcProbe = { readonly probe: Probe; readonly word: AgentStatus };

/**
 * `hc get`, then the #62 screen check: omo reports `working` over OSC 7501 for as long as any monitor or background
 * session is live, even between turns (#178), so a `working` word with no shell in front reads `idle` when the screen
 * positively shows the idle input. A terminal hc no longer knows is `gone`; any other `get` failure throws.
 */
export async function probeWithWord(exec: Exec, id: string, belowShell?: BelowShell): Promise<HcProbe> {
  let parsed: Probe;
  try {
    const terminal = await hcCall(exec, ["get", id]);
    const fg = foregroundOf(terminal["foreground"]);
    const own = belowShell !== undefined && fg?.pid !== undefined && fg.pid === num(terminal["pid"]);
    parsed = parseProbe(terminal, own && fg?.pid !== undefined ? await belowShell(fg.pid) : undefined);
  } catch (e) {
    if (isKind(e, "not_found")) return { probe: { status: "gone", shellInFront: false }, word: "gone" };
    throw e;
  }
  const word = parsed.status;
  if (word !== "working" || parsed.shellInFront || !(await screenShowsIdle(exec, id))) return { probe: parsed, word };
  return { probe: { ...parsed, status: "idle" }, word };
}

/** `hc get` plus the screen check; Windows passes `belowShell` (#70) so a finished program is not believed. */
export async function probe(exec: Exec, id: string, belowShell?: BelowShell): Promise<Probe> {
  return (await probeWithWord(exec, id, belowShell)).probe;
}
