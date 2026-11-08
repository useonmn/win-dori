import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../src/runtime/exec.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { ok, recorder, ref } from "./herdr-recorder.ts";

// herdr 0.9.5 on Windows: process-info lists only the pane's own shell while an agent runs in it, a new shell can
// drop what is typed before its prompt is up, and a console reads no LF as Enter.
const WIN = { windows: true } as const;
const onlyShell = {
  process_info: { shell_pid: 40, foreground_processes: [{ pid: 40, name: "pwsh.exe", argv: ["pwsh"] }] },
};
const pane = (agent?: string, agent_status = "idle") => ({ pane: { pane_id: "w1:p1", agent, agent_status } });
const replies =
  (agent?: string, agent_status = "idle") =>
  (argv: readonly string[]): ExecResult =>
    argv[1] === "process-info" ? ok(onlyShell) : argv[1] === "get" ? ok(pane(agent, agent_status)) : ok({});

describe("herdr adapter on Windows", () => {
  test("start waits for the new shell's prompt before typing the command, and types it even with no prompt", async () => {
    const r = recorder((argv) => (argv[1] === "wait-output" ? { code: 1, stdout: "", stderr: "timeout" } : ok({})));
    await new HerdrRuntime(r.exec, "", WIN).start(ref("w1:p2"), "omo");
    expect(r.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["pane wait-output", "pane run"]);
    expect(r.calls[1]).toEqual(["pane", "run", "w1:p2", "omo"]);
  });

  test("a pane listing only its own shell is decided by the agent status: an agent is not a shell in front", async () => {
    const withAgent = await new HerdrRuntime(recorder(replies("omo")).exec, "", WIN).probe(ref("w1:p1"));
    expect(withAgent).toMatchObject({ status: "idle", shellInFront: false });
    const bare = await new HerdrRuntime(recorder(replies(undefined)).exec, "", WIN).probe(ref("w1:p1"));
    expect(bare).toMatchObject({ status: "shell", shellInFront: true });
  });

  test("off Windows the same listing is an interactive shell in front, whatever herdr's status says", async () => {
    const probe = await new HerdrRuntime(recorder(replies("omo")).exec, "", { windows: false }).probe(ref("w1:p1"));
    expect(probe.shellInFront).toBe(true);
  });

  test("deliver reaches an agent in a Windows pane instead of reporting no agent", async () => {
    const r = recorder(replies("omo"));
    expect(await new HerdrRuntime(r.exec, "", WIN).deliver(ref("w1:p1"), "hi")).toEqual({ kind: "delivered" });
    expect(r.calls.at(-1)).toEqual(["agent", "prompt", "w1:p1", "hi"]);
  });

  test("typeIntoShell gives every non-empty line its own Enter on Windows", async () => {
    const r = recorder(replies(undefined));
    expect(await new HerdrRuntime(r.exec, "", WIN).typeIntoShell(ref("w1:p1"), "cd x\r\n\nls")).toBe(true);
    expect(r.calls.filter((c) => c[1] === "send-text" || c[1] === "send-keys")).toEqual([
      ["pane", "send-text", "w1:p1", "cd x"],
      ["pane", "send-keys", "w1:p1", "enter"],
      ["pane", "send-text", "w1:p1", "ls"],
      ["pane", "send-keys", "w1:p1", "enter"],
    ]);
  });

  test("an agent prompt spawnExec refused to run is a plain failure, never an ambiguous delivery", async () => {
    const r = recorder((argv) =>
      argv[0] === "agent" ? { code: 126, stdout: "", stderr: "refused", refused: true } : replies("omo")(argv),
    );
    await expect(new HerdrRuntime(r.exec, "", WIN).deliver(ref("w1:p1"), "hi")).rejects.toThrow("refused");
  });
});
