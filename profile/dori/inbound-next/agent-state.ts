// What the lead's agent is doing, read from its session runtime, for dori-inbound's "workingAgent" working status.
// herdr: `herdr pane get <pane>` prints {"result":{"pane":{"agent_status","terminal_title","terminal_title_stripped",...}}},
// and `herdr pane read <pane> --source visible` prints the screen as plain text.
// hc (herdr-core): `hc --json get <t>` prints the terminal record {"state":"live"|"finished","status":{"state",...}|null,
// "title",...}, and `hc --json read <t> --lines 0` prints {"text",...} (the screen only).
// hc on Windows (herdr-core #70) keeps the last OSC 7501 status after the program exits. dori's own probe asks the process
// tree whether a program still runs below the terminal's shell; this standalone listener does not, because the lead terminal
// runs its agent for its whole life. Only a finished terminal reads as unknown.
export type Runtime = "herdr" | "hc";
export type AgentState = "working" | "idle" | "done" | "blocked" | "unknown";
export type AgentProbe = {
  readonly herdr: readonly string[];
  readonly hc: readonly string[];
  readonly timeoutMs: number;
  readonly title: RegExp | null;
  readonly screen: RegExp | null;
};
// why: the reason the state is unknown; via: the signal ("title" or "screen") that turned it into working.
export type AgentReading = { readonly state: AgentState; readonly why: string; readonly via: string };
type Signals = { readonly state: AgentState; readonly title: string };

const STOPPED: ReadonlySet<AgentState> = new Set(["idle", "done", "blocked"]);
export const isStopped = (state: AgentState) => STOPPED.has(state);
const KNOWN: ReadonlySet<string> = new Set(["working", "idle", "done", "blocked"]);
const word = (value: unknown): AgentState =>
  typeof value === "string" && KNOWN.has(value) ? (value as AgentState) : "unknown";
const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const errMessage = (err: unknown) => String((err as { message?: unknown } | null)?.message ?? err);

// One bounded call: a runtime that hangs is killed after timeoutMs and the reading is unknown.
const run = async (argv: readonly string[], timeoutMs: number): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        p.kill();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    const [out, code] = await Promise.race([Promise.all([new Response(p.stdout).text(), p.exited]), timeout]);
    if (code !== 0) throw new Error(`exit ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
};

const signals = async (probe: AgentProbe, runtime: Runtime, pane: string): Promise<Signals> => {
  switch (runtime) {
    case "herdr": {
      const p = rec(
        rec(rec(JSON.parse(await run([...probe.herdr, "pane", "get", pane], probe.timeoutMs)))["result"])["pane"],
      );
      return {
        state: word(p["agent_status"]),
        title: String(p["terminal_title_stripped"] ?? p["terminal_title"] ?? ""),
      };
    }
    case "hc": {
      const t = rec(JSON.parse(await run([...probe.hc, "--json", "get", pane.replace(/^hc:/, "")], probe.timeoutMs)));
      const state = t["state"] === "finished" ? "unknown" : word(rec(t["status"])["state"]);
      return { state, title: String(t["title"] ?? "") };
    }
    default:
      return runtime satisfies never;
  }
};

const screenText = async (probe: AgentProbe, runtime: Runtime, pane: string): Promise<string> => {
  switch (runtime) {
    case "herdr":
      return run([...probe.herdr, "pane", "read", pane, "--source", "visible"], probe.timeoutMs);
    case "hc": {
      const out = await run([...probe.hc, "--json", "read", pane.replace(/^hc:/, ""), "--lines", "0"], probe.timeoutMs);
      return String(rec(JSON.parse(out))["text"] ?? "");
    }
    default:
      return runtime satisfies never;
  }
};

// The runtime's agent state, upgraded to working by a matching title or screen line. A stopped state only stands when the
// screen read (if configured) also finds no working line; a failed screen read makes it unknown, never stopped.
export const readAgent = async (probe: AgentProbe, runtime: Runtime, pane: string): Promise<AgentReading> => {
  let s: Signals;
  try {
    s = await signals(probe, runtime, pane);
  } catch (err) {
    return { state: "unknown", why: errMessage(err), via: "" };
  }
  if (s.state === "working") return { state: s.state, why: "", via: "" };
  if (probe.title?.test(s.title)) return { state: "working", why: "", via: "title" };
  if (!probe.screen) return { state: s.state, why: "", via: "" };
  try {
    if (probe.screen.test(await screenText(probe, runtime, pane))) return { state: "working", why: "", via: "screen" };
  } catch (err) {
    if (isStopped(s.state)) return { state: "unknown", why: `screen ${errMessage(err)}`, via: "" };
  }
  return { state: s.state, why: "", via: "" };
};
