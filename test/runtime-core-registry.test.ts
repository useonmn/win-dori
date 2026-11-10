import { describe, expect, test } from "bun:test";
import { Runtimes } from "../src/runtime/registry.ts";
import type { CreateSpec, RuntimeKind, SessionRef, SessionRuntime } from "../src/runtime/types.ts";
import { formatRef, openSession } from "../src/runtime/types.ts";

describe("Runtimes registry", () => {
  const fakeRuntime = (kind: RuntimeKind): SessionRuntime => {
    const never = (): never => {
      throw new Error("not used");
    };
    return {
      kind,
      self: () => undefined,
      createGroup: never,
      create: never,
      start: never,
      list: never,
      probe: never,
      read: never,
      deliver: never,
      submitTyped: never,
      typeIntoShell: never,
      keys: never,
      close: never,
    };
  };
  const counting = () => {
    const made: RuntimeKind[] = [];
    const runtimes = new Runtimes("hc", (k) => {
      made.push(k);
      return fakeRuntime(k);
    });
    return { made, runtimes };
  };

  test("builds nothing until asked, then memoises one runtime per kind", () => {
    const { made, runtimes } = counting();
    expect(made).toEqual([]);
    const a = runtimes.default;
    const b = runtimes.default;
    expect(a).toBe(b);
    expect(a.kind).toBe("hc");
    expect(made).toEqual(["hc"]);
  });

  test("routes by the ref's runtime, not the selected one", () => {
    const { made, runtimes } = counting();
    const herdrRef: SessionRef = { runtime: "herdr", id: "w1:p3" };
    expect(runtimes.for(herdrRef).kind).toBe("herdr");
    expect(runtimes.for({ runtime: "hc", id: "t7" })).toBe(runtimes.default);
    expect(runtimes.for(herdrRef)).toBe(runtimes.for(herdrRef));
    expect(made).toEqual(["herdr", "hc"]);
  });
});

describe("Runtimes.kinds and selfAny", () => {
  const make = () => new Runtimes("herdr", (k) => ({ kind: k }) as unknown as SessionRuntime);

  test("kinds lists the runtimes built so far, in first-use order", () => {
    const runtimes = make();
    expect(runtimes.kinds()).toEqual([]);
    runtimes.for({ runtime: "hc", id: "t1" });
    runtimes.default;
    runtimes.for({ runtime: "hc", id: "t2" });
    expect(runtimes.kinds()).toEqual(["hc", "herdr"]);
  });

  test.each([
    ["an hc terminal", { HC_TERMINAL_ID: "t7" }, { runtime: "hc", id: "t7" }],
    [
      "hc wins when both are set",
      { HC_TERMINAL_ID: "t7", HERDR_PANE_ID: "w1:p3", HERDR_WORKSPACE_ID: "w1" },
      { runtime: "hc", id: "t7" },
    ],
    [
      "a herdr pane grouped by its workspace",
      { HERDR_PANE_ID: "w1:p3", HERDR_WORKSPACE_ID: "w1" },
      { runtime: "herdr", id: "w1:p3", group: "w1" },
    ],
    ["a herdr pane without a workspace id has no group", { HERDR_PANE_ID: "w1:p3" }, { runtime: "herdr", id: "w1:p3" }],
    [
      "empty variables are unset",
      { HC_TERMINAL_ID: "", HERDR_PANE_ID: "w2:p1", HERDR_WORKSPACE_ID: "" },
      { runtime: "herdr", id: "w2:p1" },
    ],
    ["outside any runtime", {}, undefined],
  ] as const)("selfAny: %s", (_, env, want) => {
    const runtimes = make();
    expect(runtimes.selfAny(env)).toEqual(want);
    expect(runtimes.kinds()).toEqual([]);
  });
});

describe("openSession", () => {
  test("creates the session, then starts the command in it, and returns the created ref", async () => {
    const calls: string[] = [];
    const ref: SessionRef = { runtime: "hc", id: "t9", group: "g" };
    const rt = {
      kind: "hc",
      create: async (spec: CreateSpec) => {
        calls.push(`create ${spec.name} ${spec.container}`);
        return ref;
      },
      start: async (r: SessionRef, command: string) => {
        calls.push(`start ${formatRef(r)} ${command}`);
      },
    } as unknown as SessionRuntime;
    const spec: CreateSpec = { name: "lane-a", cwd: "/w", env: {}, role: "lane", container: "tab" };
    expect(await openSession(rt, spec, "omo")).toBe(ref);
    expect(calls).toEqual(["create lane-a tab", "start hc:t9 omo"]);
  });

  test("a failed start closes the session it just created (scope session) and rethrows the start error", async () => {
    const calls: string[] = [];
    const rt = {
      create: async () => ({ runtime: "hc", id: "t4" }) as SessionRef,
      start: async () => {
        calls.push("start");
        throw new Error("send refused");
      },
      close: async (r: SessionRef, scope?: string) => {
        calls.push(`close ${formatRef(r)} ${scope}`);
      },
    } as unknown as SessionRuntime;
    await expect(
      openSession(rt, { name: "x", cwd: "/", env: {}, role: "lane", container: "tab" }, "omo"),
    ).rejects.toThrow("send refused");
    expect(calls).toEqual(["start", "close hc:t4 session"]);
  });

  test("a failed create starts nothing", async () => {
    let started = false;
    const rt = {
      create: async () => {
        throw new Error("no space");
      },
      start: async () => {
        started = true;
      },
    } as unknown as SessionRuntime;
    await expect(
      openSession(rt, { name: "x", cwd: "/", env: {}, role: "lead", container: "workspace-root" }, "omo"),
    ).rejects.toThrow("no space");
    expect(started).toBe(false);
  });
});

describe("Runtimes with a lazy choice", () => {
  test("for(ref) never calls the choice; default does", () => {
    let asked = 0;
    const make = (kind: RuntimeKind): SessionRuntime => ({ kind }) as unknown as SessionRuntime;
    const rts = new Runtimes(() => {
      asked += 1;
      return "hc";
    }, make);
    expect(rts.for({ runtime: "herdr", id: "w1:p3" }).kind).toBe("herdr");
    expect(asked).toBe(0);
    expect(rts.default.kind).toBe("hc");
    expect(asked).toBe(1);
  });
});
