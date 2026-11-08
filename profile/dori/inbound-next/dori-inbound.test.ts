// Drives dori-inbound.ts as a subprocess through its env seams: fake Slack events/history, fake herdr, temp config/state.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "dori-inbound.ts");
const OWNER = "UOWNERTEST";
let root = "";
let herdrExe = "";
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dori-inbound-test-"));
  // Fake herdr: appends {argv, ok} as one JSON line to FAKE_HERDR_LOG; fails while the FAKE_HERDR_FAILS counter file holds N > 0.
  // pane get prints the agent_status held in the FAKE_HERDR_STATE file (missing: unknown); "hang" never answers, "error" exits 3.
  // It also prints the terminal title held in FAKE_HERDR_TITLE; pane read prints the FAKE_HERDR_SCREEN file ("error" exits 3).
  // Called as hc (--json get / --json read), it prints hc's shapes instead: the terminal record and {text}.
  const src = join(root, "fake-herdr.ts");
  writeFileSync(
    src,
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const at = process.argv.indexOf("pane");
const args = at >= 0 ? process.argv.slice(at) : process.argv.slice(2);
const f = process.env.FAKE_HERDR_FAILS;
let fail = false;
if (f && existsSync(f)) { const n = parseInt(readFileSync(f, "utf8"), 10); if (n > 0) { fail = true; writeFileSync(f, String(n - 1)); } }
appendFileSync(process.env.FAKE_HERDR_LOG!, JSON.stringify({ argv: args, ok: !fail }) + "\\n");
if (fail) { console.error("fake failure"); process.exit(1); }
const hc = args[0] === "--json";
const file = (k: string, d: string) => { const p = process.env[k]; return p && existsSync(p) ? readFileSync(p, "utf8") : d; };
if (args[1] === "get") {
  const state = file("FAKE_HERDR_STATE", "unknown").trim();
  const title = file("FAKE_HERDR_TITLE", "");
  if (state === "hang") setInterval(() => {}, 1000);
  else if (state === "error") process.exit(3);
  else if (hc) console.log(JSON.stringify({ address: args[2], state: "live", status: state === "unknown" ? null : { state, app: "omo" }, title }));
  else console.log(JSON.stringify({ id: "cli:pane:get", result: { type: "pane_info", pane: { pane_id: args[2], agent_status: state, terminal_title: title, terminal_title_stripped: title } } }));
}
if (args[1] === "read") {
  const screen = file("FAKE_HERDR_SCREEN", "");
  if (screen === "error") process.exit(3);
  process.stdout.write(hc ? JSON.stringify({ text: screen, complete: true, how: "screen" }) : screen);
}
`,
  );
  // Run the fake through bun (DORI_HERDR as a JSON argv array): a freshly compiled unsigned exe can be blocked by Smart App Control.
  herdrExe = JSON.stringify([process.execPath, src]);
  const w = Bun.spawn([process.execPath, src, "pane", "run", "warm", "x"], {
    env: { ...process.env, FAKE_HERDR_LOG: join(root, "warm.log") },
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await w.exited) !== 0) throw new Error("fake herdr warm-up failed");
}, 120_000);

afterAll(async () => {
  for (const p of procs) {
    p.kill();
    await p.exited;
  }
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
type Run = {
  dir: string;
  lines: string[];
  waitFor: (re: RegExp, ms?: number) => Promise<string>;
  waitForCount: (re: RegExp, count: number, ms?: number) => Promise<void>;
  herdrCalls: () => { argv: string[]; ok: boolean }[];
  proc: ReturnType<typeof Bun.spawn>;
};

function start(opts: {
  events: unknown[];
  history?: unknown;
  pane?: string;
  fails?: number;
  cursor?: Record<string, string>;
  env?: Record<string, string>;
  config?: object;
  herdrState?: string;
  herdrTitle?: string;
  herdrScreen?: string;
  state?: Record<string, unknown>;
  stdin?: boolean;
}): Run {
  const dir = join(root, `case${++n}`);
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), `${opts.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ leadPane: opts.pane ?? "fakeW:p1", ...opts.config }));
  if (opts.herdrState) writeFileSync(join(dir, "herdr-state"), opts.herdrState);
  if (opts.herdrTitle) writeFileSync(join(dir, "herdr-title"), opts.herdrTitle);
  if (opts.herdrScreen) writeFileSync(join(dir, "herdr-screen"), opts.herdrScreen);
  for (const [name, value] of Object.entries(opts.state ?? {}))
    writeFileSync(join(dir, "state", name), JSON.stringify(value));
  if (opts.history) writeFileSync(join(dir, "history.json"), JSON.stringify(opts.history));
  if (opts.cursor) writeFileSync(join(dir, "state", "inbound-cursor.json"), JSON.stringify(opts.cursor));
  writeFileSync(join(dir, "fails"), String(opts.fails ?? 0));
  writeFileSync(join(dir, "herdr.log"), "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of [
    "DORI_INBOUND_PANE",
    "DELIVERY",
    "DORI_SLACK_TOKEN",
    "DORI_SLACK_APP_TOKEN",
    "DORI_WORKING_LIMIT_MS",
    "DORI_WORKING_REFRESH_MS",
    "DORI_WORKING_STATUS",
    "DORI_SLACK_TIMEOUT_MS",
    "DORI_INBOUND_SUPERVISED",
    "DORI_INBOUND_LOCK_DIR",
    "DORI_WORKING_UNKNOWN_LIMIT_MS",
    "DORI_WORKING_GRACE_MS",
    "DORI_HERDR_TIMEOUT_MS",
    "DORI_RUNTIME",
  ])
    delete env[k];
  Object.assign(env, {
    DORI_INBOUND_FAKE_EVENTS: join(dir, "events.jsonl"),
    DORI_HERDR: herdrExe,
    DORI_CONFIG: join(dir, "config.json"),
    DORI_INBOUND_STATE_DIR: join(dir, "state"),
    DORI_SLACK_OWNER: OWNER,
    FAKE_HERDR_LOG: join(dir, "herdr.log"),
    FAKE_HERDR_FAILS: join(dir, "fails"),
    FAKE_HERDR_STATE: join(dir, "herdr-state"),
    FAKE_HERDR_TITLE: join(dir, "herdr-title"),
    FAKE_HERDR_SCREEN: join(dir, "herdr-screen"),
    ...(opts.history ? { DORI_INBOUND_FAKE_HISTORY: join(dir, "history.json") } : {}),
    ...opts.env,
  });
  // process.execPath, not "bun": through a shim, kill() would miss the real listener.
  const proc = Bun.spawn([process.execPath, SCRIPT], {
    env,
    stdin: opts.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
      for (const w of waiters.splice(0)) w();
    }
    for (const w of waiters.splice(0)) w();
  })();
  let stderr = "";
  (async () => {
    for await (const c of proc.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(c);
  })();
  const waitForCount = (re: RegExp, count: number, ms = 10_000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`timeout waiting for ${count} of ${re}\nstdout:\n${lines.join("\n")}\nstderr:\n${stderr}`)),
        ms,
      );
      const check = () => {
        if (lines.filter((l) => re.test(l)).length >= count) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  const waitFor = (re: RegExp, ms?: number) => waitForCount(re, 1, ms).then(() => lines.find((l) => re.test(l))!);
  const herdrCalls = () =>
    readFileSync(join(dir, "herdr.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { dir, lines, waitFor, waitForCount, herdrCalls, proc };
}

const msg = (channel: string, ts: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  channel,
  ts,
  user: OWNER,
  text,
  ...extra,
});
const injected = (call: { argv: string[] }) => JSON.parse(call.argv[3].slice("[SLACK] ".length));
const stop = async (r: Run) => {
  r.proc.kill();
  await r.proc.exited;
};

setDefaultTimeout(20_000);

describe("dori-inbound", () => {
  test("with runtime hc, or a lead written hc:t5, the line goes in with hc send (paste and Enter in one step)", async () => {
    const r = start({
      pane: "t4",
      events: [msg("CHC", "1050.000001", "via hc")],
      env: { DORI_RUNTIME: "hc", DORI_HC: herdrExe },
    });
    await r.waitFor(/^INJECTED CHC:1050.000001$/);
    const [call] = r.herdrCalls();
    expect(call.argv.slice(0, 4)).toEqual(["--json", "send", "t4", "--"]);
    expect(JSON.parse(call.argv[4].slice("[SLACK] ".length)).text).toBe("via hc");
    const prefixed = start({
      pane: "hc:t5",
      events: [msg("CHC", "1050.000002", "prefixed")],
      env: { DORI_HC: herdrExe },
    });
    await prefixed.waitFor(/^INJECTED CHC:1050.000002$/);
    expect(prefixed.herdrCalls()[0]?.argv.slice(0, 3)).toEqual(["--json", "send", "t5"]);
  });

  test("re-reads the lead pane from config between two messages", async () => {
    const gate = join(root, "gate-pane");
    const r = start({
      pane: "fakeA:p1",
      events: [msg("CPANE", "1001.000001", "one"), { fake: "wait", file: gate }, msg("CPANE", "1001.000002", "two")],
    });
    await r.waitFor(/^INBOUND .*"ts":"1001.000001"/);
    writeFileSync(join(r.dir, "config.json"), JSON.stringify({ leadPane: "fakeB:p2" }));
    writeFileSync(gate, "");
    await r.waitFor(/^INJECTED CPANE:1001.000002$/);
    const calls = r.herdrCalls();
    expect(calls.map((c) => c.argv.slice(0, 3))).toEqual([
      ["pane", "run", "fakeA:p1"],
      ["pane", "run", "fakeB:p2"],
    ]);
    await stop(r);
  });

  test("a burst of 5 reaches the pane in arrival order and the cursor holds the last ts", async () => {
    const ts = [1, 2, 3, 4, 5].map((i) => `1002.00000${i}`);
    const r = start({ events: ts.map((t, i) => msg("CBURST", t, `burst ${i}`)) });
    await r.waitFor(/^INBOUND .*"ts":"1002.000005"/);
    expect(r.herdrCalls().map((c) => injected(c).ts)).toEqual(ts);
    expect(r.lines.filter((l) => l.startsWith("INJECTED ")).map((l) => l.split(":")[1])).toEqual(ts);
    expect(r.lines.filter((l) => l.startsWith("FAKE_REACTION ")).length).toBe(5);
    expect(JSON.parse(readFileSync(join(r.dir, "state", "inbound-cursor.json"), "utf8"))).toEqual({
      CBURST: "1002.000005",
    });
    await stop(r);
  });

  test("oversize payload spills to a file and injects a truncated line", async () => {
    const big = `${"x".repeat(40_000)}END`;
    const r = start({ events: [msg("CBIG", "1003.000001", big)] });
    await r.waitFor(/^INJECTED CBIG:1003.000001$/);
    const [call] = r.herdrCalls();
    expect(call.argv[3].length).toBeLessThan(30_000);
    const p = injected(call);
    expect(p.truncated).toBe(true);
    expect(p.text).toBe(big.slice(0, 2000));
    expect(p.full).toBe(`${join(r.dir, "state")}/inbound/CBIG-1003.000001.json`);
    expect(JSON.parse(readFileSync(p.full, "utf8")).text).toBe(big);
    await stop(r);
  });

  test("quote-heavy payload under 30,000 raw chars still spills (escaped length counts)", async () => {
    const quotes = `${'"\\'.repeat(7_000)}END`;
    const r = start({ events: [msg("CQ", "1003.000002", quotes)] });
    await r.waitFor(/^INJECTED CQ:1003.000002$/);
    const [call] = r.herdrCalls();
    const p = injected(call);
    expect(p.truncated).toBe(true);
    expect(JSON.parse(readFileSync(p.full, "utf8")).text).toBe(quotes);
    await stop(r);
  });

  test("retries a failed injection and then succeeds", async () => {
    const r = start({ fails: 1, events: [msg("CRETRY", "1004.000001", "retry me")] });
    await r.waitFor(/^INJECTED CRETRY:1004.000001$/);
    expect(r.herdrCalls().map((c) => c.ok)).toEqual([false, true]);
    expect(r.lines.some((l) => l.startsWith("INJECT_ERROR"))).toBe(false);
    await stop(r);
  });

  test("retry exhaustion prints INJECT_ERROR with the message text and leaves the cursor alone", async () => {
    const text = `lost? ${"y".repeat(600)}`;
    const r = start({ fails: 99, events: [msg("CFAIL", "1005.000001", text)] });
    const line = await r.waitFor(/^INJECT_ERROR /, 25_000);
    const j = JSON.parse(line.slice("INJECT_ERROR ".length));
    expect(j).toMatchObject({ channel: "CFAIL", ts: "1005.000001", pane: "fakeW:p1", text: text.slice(0, 500) });
    expect(j.error).toContain("exit 1");
    expect(r.herdrCalls().map((c) => c.ok)).toEqual([false, false, false, false]);
    await r.waitFor(/^INBOUND .*"ts":"1005.000001"/);
    expect(existsSync(join(r.dir, "state", "inbound-cursor.json"))).toBe(false);
    await stop(r);
  }, 30_000);

  test("catch-up delivers missed messages in ts order and dedupes a live duplicate", async () => {
    const history = {
      "conversations.history": {
        CCATCH: {
          ok: true,
          messages: [
            {
              type: "message",
              user: OWNER,
              ts: "1006.000003",
              text: "missed file",
              subtype: "file_share",
              files: [{ id: "F1", name: "a.png", mimetype: "image/png" }],
            },
            { type: "message", user: "USOMEONE", ts: "1006.000002", text: "not owner" },
            { type: "message", user: OWNER, ts: "1006.000001", text: "missed one" },
          ],
        },
      },
    };
    const r = start({
      history,
      cursor: { CCATCH: "1006.000000" },
      events: [msg("CCATCH", "1006.000001", "missed one"), msg("CCATCH", "1006.000009", "live")],
    });
    await r.waitFor(/^INBOUND .*"ts":"1006.000009"/);
    const ci = r.lines.indexOf("INBOUND_CATCHUP n=2");
    expect(ci).toBeGreaterThan(r.lines.indexOf("INBOUND_READY"));
    expect(r.herdrCalls().map((c) => injected(c).ts)).toEqual(["1006.000001", "1006.000003", "1006.000009"]);
    expect(injected(r.herdrCalls()[1]).files).toEqual([{ id: "F1", name: "a.png", mimetype: "image/png" }]);
    expect(r.lines.findIndex((l) => l.startsWith("INJECTED "))).toBeGreaterThan(ci);
    expect(JSON.parse(readFileSync(join(r.dir, "state", "inbound-cursor.json"), "utf8"))).toEqual({
      CCATCH: "1006.000009",
    });
    await stop(r);
  });

  test("INBOUND_READY only after the listener connects; disconnect and reconnect are reported", async () => {
    const gate = join(root, "gate-ready");
    const r = start({
      events: [{ fake: "wait", file: gate }, { fake: "connect" }, { fake: "disconnect" }, { fake: "connect" }],
    });
    await r.waitFor(/^FAKE_WAIT /);
    expect(r.lines.some((l) => l.startsWith("INBOUND_READY"))).toBe(false);
    writeFileSync(gate, "");
    await r.waitFor(/^INBOUND_READY reconnected$/);
    const i = (s: string) => r.lines.indexOf(s);
    expect(i("FAKE_CONNECT")).toBeLessThan(i("INBOUND_READY"));
    expect(i("INBOUND_READY")).toBeLessThan(i("INBOUND_ERROR disconnected"));
    expect(i("INBOUND_ERROR disconnected")).toBeLessThan(i("INBOUND_READY reconnected"));
    await stop(r);
  });

  test("catch-up also runs after a reconnect and replays a message sent during the gap", async () => {
    const history = {
      "conversations.history": {
        CGAP: {
          ok: true,
          messages: [
            { type: "message", user: OWNER, ts: "1009.000005", text: "sent during gap" },
            { type: "message", user: OWNER, ts: "1009.000001", text: "live before gap" },
          ],
        },
      },
    };
    const r = start({
      history,
      events: [
        { fake: "connect" },
        msg("CGAP", "1009.000001", "live before gap"),
        { fake: "disconnect" },
        { fake: "connect" },
      ],
    });
    await r.waitFor(/^INBOUND .*"ts":"1009.000005"/);
    expect(r.lines.filter((l) => l.startsWith("INBOUND_CATCHUP "))).toEqual([
      "INBOUND_CATCHUP n=0",
      "INBOUND_CATCHUP n=1",
    ]);
    expect(r.lines.indexOf("INBOUND_READY reconnected")).toBeLessThan(r.lines.indexOf("INBOUND_CATCHUP n=1"));
    expect(r.herdrCalls().map((c) => injected(c).ts)).toEqual(["1009.000001", "1009.000005"]);
    expect(JSON.parse(readFileSync(join(r.dir, "state", "inbound-cursor.json"), "utf8"))).toEqual({
      CGAP: "1009.000005",
    });
    await stop(r);
  });

  test("file_share is accepted, unknown owner subtypes print INBOUND_SKIP", async () => {
    const r = start({
      events: [
        msg("CSUB", "1007.000001", "", { subtype: "channel_join" }),
        msg("CSUB", "1007.000002", "pic", {
          subtype: "file_share",
          files: [{ id: "F2", name: "b.txt", mimetype: "text/plain", url_private: "u" }],
        }),
        msg("CSUB", "1007.000003", "bc", { subtype: "thread_broadcast", thread_ts: "1007.000000" }),
      ],
    });
    await r.waitFor(/^INJECTED CSUB:1007.000003$/);
    expect(r.lines).toContain('INBOUND_SKIP {"channel":"CSUB","ts":"1007.000001","subtype":"channel_join"}');
    expect(r.herdrCalls().map((c) => injected(c).ts)).toEqual(["1007.000002", "1007.000003"]);
    expect(injected(r.herdrCalls()[0]).files).toEqual([{ id: "F2", name: "b.txt", mimetype: "text/plain" }]);
    await stop(r);
  });

  test("quotes, backslashes, emoji, Korean and newlines arrive byte-exact", async () => {
    const text =
      'say "hi" \\ back\\\\slash C:\\path\\ end\\ \u{1F389} \uD55C\uAD6D\uC5B4 \uBA54\uC2DC\uC9C0\nline2\r\nline3\t%PATH% ^&|<> \'single\' "';
    const r = start({ events: [msg("CBYTE", "1008.000001", text)] });
    await r.waitFor(/^INJECTED CBYTE:1008.000001$/);
    const [call] = r.herdrCalls();
    expect(call.argv[3]).toBe(
      `[SLACK] ${JSON.stringify({ channel: "CBYTE", ts: "1008.000001", thread_ts: null, text, files: [] })}`,
    );
    expect(injected(call).text).toBe(text);
    await stop(r);
  });
});

describe("working status and reactions", () => {
  const BOT = "UBOTTEST";
  const STATUS = "작업 중...";
  const botEnv = { DORI_SLACK_BOT_USER: BOT };
  const reply = (channel: string, ts: string, thread_ts?: string) => ({
    type: "message",
    channel,
    ts,
    user: BOT,
    bot_id: "BDORI",
    text: "done",
    ...(thread_ts ? { thread_ts } : {}),
  });
  const gate = (name: string) => join(root, `gate-${name}-${++n}`);
  const grep = (r: Run, prefix: string) => r.lines.filter((l) => l.startsWith(`${prefix} `));
  const fakeStatus = (channel: string, thread: string, status: string) =>
    `FAKE_STATUS ${channel} ${thread} ${JSON.stringify(status)}`;

  test("an accepted message gets eyes and the status; a thread reply targets its thread; others get neither", async () => {
    const r = start({
      env: botEnv,
      events: [
        { ...msg("CACC", "2001.000001", "stranger"), user: "USOMEONE" },
        msg("CACC", "2001.000002", "top"),
        msg("CACC", "2001.000003", "in thread", { thread_ts: "2001.000000" }),
      ],
    });
    await r.waitFor(/^INJECTED CACC:2001.000003$/);
    expect(grep(r, "FAKE_REACTION")).toEqual([
      "FAKE_REACTION CACC 2001.000002 eyes",
      "FAKE_REACTION CACC 2001.000003 eyes",
    ]);
    expect(grep(r, "FAKE_STATUS")).toEqual([
      fakeStatus("CACC", "2001.000002", STATUS),
      fakeStatus("CACC", "2001.000000", STATUS),
    ]);
    await stop(r);
  });

  test("catch-up messages get eyes and the status too, and a reply settles them", async () => {
    const history = {
      "conversations.history": {
        CCUP: { ok: true, messages: [{ type: "message", user: OWNER, ts: "2002.000001", text: "missed" }] },
      },
    };
    const g = gate("cup");
    const r = start({
      env: botEnv,
      history,
      cursor: { CCUP: "2002.000000" },
      events: [{ fake: "connect" }, { fake: "wait", file: g }, reply("CCUP", "2002.000002")],
    });
    await r.waitFor(/^INJECTED CCUP:2002.000001$/);
    expect(grep(r, "FAKE_REACTION")).toEqual(["FAKE_REACTION CCUP 2002.000001 eyes"]);
    expect(grep(r, "FAKE_STATUS")).toEqual([fakeStatus("CCUP", "2002.000001", STATUS)]);
    writeFileSync(g, "");
    await r.waitFor(/^FAKE_REACTION CCUP 2002.000001 white_check_mark$/);
    await stop(r);
  });

  test("a thread reply swaps eyes for a check mark and stops the refresh without an explicit clear", async () => {
    const [g1, g2, g3] = [gate("t1"), gate("t2"), gate("t3")];
    const r = start({
      env: botEnv,
      events: [
        msg("CREP", "2003.000001", "do it"),
        { fake: "wait", file: g1 },
        reply("CREP", "2003.000002", "2003.000001"),
        { fake: "wait", file: g2 },
        { fake: "advance", ms: 60_000 },
        { fake: "wait", file: g3 },
      ],
    });
    await r.waitFor(/^INJECTED CREP:2003.000001$/);
    writeFileSync(g1, "");
    await r.waitFor(/white_check_mark$/);
    const i = (l: string) => r.lines.indexOf(l);
    expect(i("FAKE_REACTION_REMOVE CREP 2003.000001 eyes")).toBeGreaterThan(-1);
    expect(i("FAKE_REACTION_REMOVE CREP 2003.000001 eyes")).toBeLessThan(
      i("FAKE_REACTION CREP 2003.000001 white_check_mark"),
    );
    writeFileSync(g2, "");
    await r.waitFor(new RegExp(`^FAKE_WAIT ${g3.replace(/[\\.]/g, "\\$&")}$`));
    expect(grep(r, "FAKE_STATUS")).toEqual([fakeStatus("CREP", "2003.000001", STATUS)]);
    await stop(r);
  });

  test("a top-level reply clears every open status in its channel and leaves other channels alone", async () => {
    const [g1, g2] = [gate("c1"), gate("c2")];
    const r = start({
      env: botEnv,
      events: [
        msg("CTOP", "2004.000001", "a"),
        msg("CTOP", "2004.000002", "b", { thread_ts: "2004.000000" }),
        msg("COTHER", "2004.000003", "c"),
        { fake: "wait", file: g1 },
        reply("CTOP", "2004.000004"),
        { fake: "wait", file: g2 },
        { fake: "advance", ms: 60_000 },
        reply("CTOP", "2004.000005", "2004.009999"),
      ],
    });
    await r.waitFor(/^INJECTED COTHER:2004.000003$/);
    writeFileSync(g1, "");
    await r.waitForCount(/white_check_mark$/, 2);
    writeFileSync(g2, "");
    await r.waitForCount(/^FAKE_STATUS COTHER /, 2);
    expect(grep(r, "FAKE_STATUS").slice(3).sort()).toEqual(
      [
        fakeStatus("COTHER", "2004.000003", STATUS),
        fakeStatus("CTOP", "2004.000000", ""),
        fakeStatus("CTOP", "2004.000001", ""),
      ].sort(),
    );
    expect(grep(r, "FAKE_REACTION").filter((l) => l.includes("COTHER")).length).toBe(1);
    await stop(r);
  });

  test("a reply in another thread settles nothing", async () => {
    const [g1, g2] = [gate("o1"), gate("o2")];
    const r = start({
      env: botEnv,
      events: [
        msg("CTHR", "2005.000001", "a"),
        { fake: "wait", file: g1 },
        reply("CTHR", "2005.000003", "2005.000002"),
        { fake: "wait", file: g2 },
      ],
    });
    await r.waitFor(/^INJECTED CTHR:2005.000001$/);
    writeFileSync(g1, "");
    await r.waitFor(new RegExp(`^FAKE_WAIT ${g2.replace(/[\\.]/g, "\\$&")}$`));
    expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([]);
    await stop(r);
  });

  test("another app's message is not a reply; this bot's next message is", async () => {
    const [g1, g2] = [gate("b1"), gate("b2")];
    const r = start({
      env: botEnv,
      events: [
        msg("CBOT", "2006.000001", "a"),
        { fake: "wait", file: g1 },
        { ...reply("CBOT", "2006.000002"), user: "UANOTHERBOT", bot_id: "BOTHER" },
        { fake: "wait", file: g2 },
        reply("CBOT", "2006.000003"),
      ],
    });
    await r.waitFor(/^INJECTED CBOT:2006.000001$/);
    writeFileSync(g1, "");
    await r.waitFor(new RegExp(`^FAKE_WAIT ${g2.replace(/[\\.]/g, "\\$&")}$`));
    expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([]);
    writeFileSync(g2, "");
    await r.waitFor(/white_check_mark$/);
    await stop(r);
  });

  test("refreshes on the clock and stops 30 minutes after the message by default", async () => {
    const [g1, g2] = [gate("l1"), gate("l2")];
    const r = start({
      env: botEnv,
      events: [
        msg("CLIM", "2007.000001", "a"),
        { fake: "wait", file: g1 },
        { fake: "advance", ms: 60_000 },
        { fake: "advance", ms: 28 * 60_000 },
        { fake: "advance", ms: 2 * 60_000 },
        { fake: "advance", ms: 60_000 },
        { fake: "wait", file: g2 },
      ],
    });
    await r.waitFor(/^INJECTED CLIM:2007.000001$/);
    writeFileSync(g1, "");
    await r.waitFor(new RegExp(`^FAKE_WAIT ${g2.replace(/[\\.]/g, "\\$&")}$`));
    expect(grep(r, "FAKE_STATUS").length).toBe(3);
    await stop(r);
  });

  test("the interval, the limit and the text follow their env overrides", async () => {
    const [g1, g2] = [gate("e1"), gate("e2")];
    const r = start({
      env: { ...botEnv, DORI_WORKING_REFRESH_MS: "10", DORI_WORKING_LIMIT_MS: "3600000", DORI_WORKING_STATUS: "busy" },
      events: [msg("CENV", "2008.000001", "a"), { fake: "wait", file: g1 }],
    });
    await r.waitForCount(/^FAKE_STATUS CENV 2008.000001 "busy"$/, 4);
    await stop(r);
    const q = start({
      env: { ...botEnv, DORI_WORKING_REFRESH_MS: "3600000", DORI_WORKING_LIMIT_MS: "1000" },
      events: [
        msg("CENV", "2008.000002", "b"),
        { fake: "wait", file: `${g1}x` },
        { fake: "advance", ms: 2_000 },
        { fake: "wait", file: g2 },
      ],
    });
    await q.waitFor(/^INJECTED CENV:2008.000002$/);
    writeFileSync(`${g1}x`, "");
    await q.waitFor(new RegExp(`^FAKE_WAIT ${g2.replace(/[\\.]/g, "\\$&")}$`));
    expect(grep(q, "FAKE_STATUS")).toEqual([fakeStatus("CENV", "2008.000002", STATUS)]);
    await stop(q);
  });

  test("already_reacted and no_reaction are success; other Slack errors are logged", async () => {
    const quiet = {
      "reactions.add": { "*": { ok: false, error: "already_reacted" } },
      "reactions.remove": { "*": { ok: false, error: "no_reaction" } },
    };
    const g = gate("q");
    const r = start({
      env: botEnv,
      history: quiet,
      events: [msg("CQUIET", "2009.000001", "a"), { fake: "wait", file: g }, reply("CQUIET", "2009.000002")],
    });
    await r.waitFor(/^INJECTED CQUIET:2009.000001$/);
    writeFileSync(g, "");
    await r.waitFor(/white_check_mark$/);
    expect(r.lines.some((l) => l.startsWith("REACTION_ERROR"))).toBe(false);
    await stop(r);
    const q = start({
      env: botEnv,
      history: { "reactions.add": { "*": { ok: false, error: "missing_scope" } } },
      events: [msg("CQUIET", "2009.000003", "b")],
    });
    await q.waitFor(/^REACTION_ERROR add eyes missing_scope$/);
    await stop(q);
  });

  test("failed Slack calls never stop delivery or the refresh", async () => {
    const history = {
      "assistant.threads.setStatus": { "*": { throw: "network down" } },
      "reactions.add": { "*": { throw: "network down" } },
    };
    const g = gate("f");
    const r = start({
      env: { ...botEnv, DORI_WORKING_REFRESH_MS: "10" },
      history,
      events: [
        msg("CFETCH", "2010.000001", "a"),
        { fake: "wait", file: g },
        msg("CFETCH", "2010.000002", "b"),
        { fake: "wait", file: `${g}never` },
      ],
    });
    await r.waitFor(/^INJECTED CFETCH:2010.000001$/);
    await r.waitForCount(/^INBOUND_SKIP .*"reason":"status_failed"/, 4);
    expect(r.lines).toContain("REACTION_ERROR network down");
    writeFileSync(g, "");
    await r.waitFor(/^INJECTED CFETCH:2010.000002$/);
    expect(r.proc.exitCode).toBe(null);
    await stop(r);
    const q = start({
      env: botEnv,
      history: { "assistant.threads.setStatus": { "*": { ok: false, error: "channel_not_found" } } },
      events: [msg("CFETCH", "2010.000003", "c")],
    });
    await q.waitFor(/^INBOUND_SKIP .*"reason":"status_channel_not_found"/);
    await stop(q);
  });

  test("a hung Slack call is bounded and delivery goes on", async () => {
    const history = { "assistant.threads.setStatus": { "*": { hang: true } } };
    const r = start({
      env: { ...botEnv, DORI_SLACK_TIMEOUT_MS: "50" },
      history,
      events: [msg("CHANG", "2011.000001", "a"), { fake: "wait", file: gate("h") }],
    });
    await r.waitFor(/^INJECTED CHANG:2011.000001$/);
    expect(r.lines.some((l) => l.includes('"reason":"status_failed"'))).toBe(true);
    await stop(r);
  });

  test("the refresh timer does not keep a finished listener alive", async () => {
    const r = start({ env: botEnv, events: [msg("CEXIT", "2012.000001", "a")] });
    await r.waitFor(/^INJECTED CEXIT:2012.000001$/);
    expect(await r.proc.exited).toBe(0);
  });

  test("strictMentionChannels needs a mention on every message, thread replies included", async () => {
    const home = join(root, "strict-home");
    mkdirSync(join(home, ".dori"), { recursive: true });
    writeFileSync(join(home, ".dori", "inbound-rules.json"), JSON.stringify({ strictMentionChannels: ["CSTRICT"] }));
    const r = start({
      env: { ...botEnv, USERPROFILE: home, HOME: home },
      events: [
        msg("CSTRICT", "2013.000001", "no mention"),
        msg("CSTRICT", "2013.000002", "no mention in thread", { thread_ts: "2013.000001" }),
        msg("CSTRICT", "2013.000003", `<@${BOT}> mention in thread`, { thread_ts: "2013.000001" }),
        msg("CFREE", "2013.000004", "other channel"),
      ],
    });
    await r.waitFor(/^INJECTED CFREE:2013.000004$/);
    expect(r.herdrCalls().map((c) => injected(c).ts)).toEqual(["2013.000003", "2013.000004"]);
    expect(grep(r, "FAKE_REACTION")).toEqual([
      "FAKE_REACTION CSTRICT 2013.000003 eyes",
      "FAKE_REACTION CFREE 2013.000004 eyes",
    ]);
    await stop(r);
  });

  test("agentUsers: a listed agent passes only with a mention, unlisted bots stay out, owner unchanged, strict still applies, catch-up recovers", async () => {
    const home = join(root, "agent-home");
    mkdirSync(join(home, ".dori"), { recursive: true });
    writeFileSync(
      join(home, ".dori", "inbound-rules.json"),
      JSON.stringify({ strictMentionChannels: ["CAGS"], agentUsers: ["UAGENT"] }),
    );
    const agent = (channel: string, ts: string, text: string, extra: Record<string, unknown> = {}) =>
      msg(channel, ts, text, { user: "UAGENT", bot_id: "BAGENT", ...extra });
    const r = start({
      env: { ...botEnv, USERPROFILE: home, HOME: home },
      cursor: { CAG: "3000.000000" },
      history: {
        "conversations.history": {
          CAG: {
            ok: true,
            messages: [
              { ts: "3000.000001", user: "UAGENT", bot_id: "BAGENT", text: `<@${BOT}> missed report` },
              { ts: "3000.000002", user: "UAGENT", bot_id: "BAGENT", text: "missed, no mention" },
            ],
          },
        },
      },
      events: [
        agent("CAG", "3001.000001", `<@${BOT}> bug report`),
        agent("CAG", "3001.000002", "no mention"),
        msg("CAG", "3001.000003", `<@${BOT}> rogue`, { user: "UROGUE", bot_id: "BROGUE" }),
        agent("CAG", "3001.000004", `<@${BOT}> as bot_message`, { subtype: "bot_message" }),
        agent("CAGS", "3001.000005", "strict, no mention"),
        agent("CAGS", "3001.000006", `<@${BOT}> strict thread`, { thread_ts: "3001.000005" }),
        msg("CAG", "3001.000007", "owner, no mention"),
      ],
    });
    await r.waitFor(/^INJECTED CAG:3001.000007$/);
    const got = r.herdrCalls().map(injected);
    expect(got.map((p) => p.ts)).toEqual(["3000.000001", "3001.000001", "3001.000004", "3001.000006", "3001.000007"]);
    expect(got.slice(0, 4).map((p) => [p.from, p.user])).toEqual(Array(4).fill(["agent", "UAGENT"]));
    expect(got[4]).toEqual({
      channel: "CAG",
      ts: "3001.000007",
      thread_ts: null,
      text: "owner, no mention",
      files: [],
    });
    await stop(r);
  });

  describe("workingAgent: the status follows the lead's agent state in its session runtime", () => {
    const on = { workingAgent: true };
    const HG = "hourglass_flowing_sand";
    const waitGate = (r: Run, g: string) => r.waitFor(new RegExp(`^FAKE_WAIT ${g.replace(/[\\.]/g, "\\$&")}$`));
    const gets = (r: Run) => r.herdrCalls().filter((c) => c.argv[1] === "get");
    const hcEnv = { ...botEnv, DORI_RUNTIME: "hc" };
    // omo lead panes: the runtime can say idle while the agent works; the title (tool running) or the Working bar says otherwise.
    const IDLE_TITLE = "OmO - Dori Startup - user";
    const bar = (s: string) => `\n reply text\n\n${s}\n❯\n${"─".repeat(20)}\n~ • status line\n`;
    const WORKING_BAR = bar(`── • Working (12s • esc to interrupt) ${"─".repeat(20)}`);
    // A quoted "• Working (4s • esc to interrupt)" inside a reply is not the bar.
    const IDLE_SCREEN = bar("─".repeat(20)).replace("reply text", 'reply quoting "• Working (4s • esc to interrupt)"');

    test("working keeps the status and the hourglass on every refresh; the 30 min cap clears both", async () => {
      const [g1, g2, g3] = [gate("w1"), gate("w2"), gate("w3")];
      const r = start({
        env: botEnv,
        config: on,
        herdrState: "working",
        events: [
          msg("CHW", "4001.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
          { fake: "advance", ms: 29 * 60_000 },
          { fake: "wait", file: g3 },
        ],
      });
      await r.waitFor(/^INJECTED CHW:4001.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(grep(r, "FAKE_REACTION").sort()).toEqual(
        ["FAKE_REACTION CHW 4001.000001 eyes", `FAKE_REACTION CHW 4001.000001 ${HG}`].sort(),
      );
      expect(grep(r, "FAKE_STATUS")).toEqual(Array(3).fill(fakeStatus("CHW", "4001.000001", STATUS)));
      expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([]);
      expect(gets(r).map((c) => c.argv)).toEqual([
        ["pane", "get", "fakeW:p1"],
        ["pane", "get", "fakeW:p1"],
      ]);
      expect(r.lines).toContain("WORKING_AGENT working");
      writeFileSync(g2, "");
      await waitGate(r, g3);
      expect(grep(r, "FAKE_STATUS").slice(3)).toEqual([fakeStatus("CHW", "4001.000001", "")]);
      expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([`FAKE_REACTION_REMOVE CHW 4001.000001 ${HG}`]);
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHW","thread":"4001.000001","reason":"limit"}');
      await stop(r);
    });

    for (const state of ["idle", "done", "blocked"])
      test(`${state}: a refresh within the grace keeps both, the next one clears the status and the hourglass, eyes stays`, async () => {
        const [g1, g2] = [gate("i1"), gate("i2")];
        const r = start({
          env: botEnv,
          config: on,
          herdrState: state,
          events: [
            msg("CHI", "4002.000001", "a"),
            { fake: "wait", file: g1 },
            { fake: "advance", ms: 1_000 },
            { fake: "advance", ms: 60_000 },
            { fake: "advance", ms: 60_000 },
            { fake: "wait", file: g2 },
          ],
        });
        await r.waitFor(/^INJECTED CHI:4002.000001$/);
        writeFileSync(g1, "");
        await waitGate(r, g2);
        expect(grep(r, "FAKE_STATUS")).toEqual([
          fakeStatus("CHI", "4002.000001", STATUS),
          fakeStatus("CHI", "4002.000001", STATUS),
          fakeStatus("CHI", "4002.000001", ""),
        ]);
        expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([`FAKE_REACTION_REMOVE CHI 4002.000001 ${HG}`]);
        expect(r.lines).toContain(`WORKING_CLEAR {"channel":"CHI","thread":"4002.000001","reason":"agent_${state}"}`);
        expect(gets(r).length).toBe(2);
        await stop(r);
      });

    test("unknown (the runtime hangs past its timeout, or fails): the status stays until 10 min after it last said working", async () => {
      const [g1, g2, g3] = [gate("u1"), gate("u2"), gate("u3")];
      const r = start({
        env: { ...botEnv, DORI_HERDR_TIMEOUT_MS: "300" },
        config: on,
        herdrState: "hang",
        events: [
          msg("CHU", "4003.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 9 * 60_000 },
          msg("CHU2", "4003.000002", "b"),
          { fake: "wait", file: g2 },
          { fake: "advance", ms: 2 * 60_000 },
          { fake: "wait", file: g3 },
        ],
      });
      await r.waitFor(/^INJECTED CHU:4003.000001$/);
      writeFileSync(g1, "");
      await r.waitFor(/^INJECTED CHU2:4003.000002$/);
      expect(r.lines).toContain("WORKING_AGENT unknown timeout");
      writeFileSync(g2, "");
      await waitGate(r, g3);
      expect(grep(r, "FAKE_STATUS").filter((l) => l.includes(" CHU "))).toEqual([
        fakeStatus("CHU", "4003.000001", STATUS),
        fakeStatus("CHU", "4003.000001", STATUS),
        fakeStatus("CHU", "4003.000001", ""),
      ]);
      expect(grep(r, "FAKE_STATUS").filter((l) => l.includes(" CHU2 "))).toEqual([
        fakeStatus("CHU2", "4003.000002", STATUS),
        fakeStatus("CHU2", "4003.000002", STATUS),
      ]);
      expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([`FAKE_REACTION_REMOVE CHU 4003.000001 ${HG}`]);
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHU","thread":"4003.000001","reason":"unknown_limit"}');
      await stop(r);
      const g4 = gate("u4");
      const q = start({
        env: botEnv,
        config: on,
        herdrState: "error",
        events: [
          msg("CHU", "4003.000003", "c"),
          { fake: "wait", file: `${g1}x` },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g4 },
        ],
      });
      await q.waitFor(/^INJECTED CHU:4003.000003$/);
      writeFileSync(`${g1}x`, "");
      await waitGate(q, g4);
      expect(q.lines).toContain("WORKING_AGENT unknown exit 3");
      expect(grep(q, "FAKE_STATUS")).toEqual([
        fakeStatus("CHU", "4003.000003", STATUS),
        fakeStatus("CHU", "4003.000003", STATUS),
      ]);
      expect(grep(q, "FAKE_REACTION_REMOVE")).toEqual([]);
      await stop(q);
    });

    const omoCases = [
      {
        name: "a working title (omo running a tool)",
        title: "OmO - Running eval",
        screen: IDLE_SCREEN,
        config: {},
        via: "title",
      },
      {
        name: "the Working bar on screen (omo thinking or writing)",
        title: IDLE_TITLE,
        screen: WORKING_BAR,
        config: {},
        via: "screen",
      },
      {
        name: "a workingTitle from the config",
        title: "busy: build",
        screen: IDLE_SCREEN,
        config: { workingTitle: "^busy: " },
        via: "title",
      },
    ];
    for (const c of omoCases)
      test(`agent_status idle with ${c.name} keeps the status past the grace`, async () => {
        const [g1, g2] = [gate("t1"), gate("t2")];
        const r = start({
          env: botEnv,
          config: { ...on, ...c.config },
          herdrState: "idle",
          herdrTitle: c.title,
          herdrScreen: c.screen,
          events: [
            msg("CHT", "4008.000001", "a"),
            { fake: "wait", file: g1 },
            { fake: "advance", ms: 60_000 },
            { fake: "advance", ms: 60_000 },
            { fake: "wait", file: g2 },
          ],
        });
        await r.waitFor(/^INJECTED CHT:4008.000001$/);
        writeFileSync(g1, "");
        await waitGate(r, g2);
        expect(grep(r, "FAKE_STATUS")).toEqual(Array(3).fill(fakeStatus("CHT", "4008.000001", STATUS)));
        expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([]);
        expect(r.lines).toContain(`WORKING_AGENT working ${c.via}`);
        expect(r.lines.some((l) => l.startsWith("WORKING_CLEAR"))).toBe(false);
        await stop(r);
      });

    test("agent_status idle with the idle title and no Working bar clears; turning workingScreen off skips the screen read", async () => {
      const [g1, g2] = [gate("n1"), gate("n2")];
      const r = start({
        env: botEnv,
        config: on,
        herdrState: "idle",
        herdrTitle: IDLE_TITLE,
        herdrScreen: IDLE_SCREEN,
        events: [
          msg("CHN", "4009.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
        ],
      });
      await r.waitFor(/^INJECTED CHN:4009.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(grep(r, "FAKE_STATUS")).toEqual([
        fakeStatus("CHN", "4009.000001", STATUS),
        fakeStatus("CHN", "4009.000001", ""),
      ]);
      expect(r.lines).toContain("WORKING_AGENT idle");
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHN","thread":"4009.000001","reason":"agent_idle"}');
      expect(
        r
          .herdrCalls()
          .filter((c) => c.argv[1] === "read")
          .map((c) => c.argv),
      ).toEqual([["pane", "read", "fakeW:p1", "--source", "visible"]]);
      await stop(r);
      const [h1, h2] = [gate("n3"), gate("n4")];
      const q = start({
        env: botEnv,
        config: { ...on, workingScreen: "" },
        herdrState: "idle",
        herdrTitle: IDLE_TITLE,
        herdrScreen: WORKING_BAR,
        events: [
          msg("CHN", "4009.000002", "b"),
          { fake: "wait", file: h1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: h2 },
        ],
      });
      await q.waitFor(/^INJECTED CHN:4009.000002$/);
      writeFileSync(h1, "");
      await waitGate(q, h2);
      expect(q.lines).toContain('WORKING_CLEAR {"channel":"CHN","thread":"4009.000002","reason":"agent_idle"}');
      expect(q.herdrCalls().filter((c) => c.argv[1] === "read")).toEqual([]);
      await stop(q);
    });

    test("agent_status idle but the screen read fails: unknown, the status stays until the 10 min cap", async () => {
      const [g1, g2, g3] = [gate("k1"), gate("k2"), gate("k3")];
      const r = start({
        env: botEnv,
        config: on,
        herdrState: "idle",
        herdrTitle: IDLE_TITLE,
        herdrScreen: "error",
        events: [
          msg("CHK", "4010.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 9 * 60_000 },
          { fake: "wait", file: g2 },
          { fake: "advance", ms: 2 * 60_000 },
          { fake: "wait", file: g3 },
        ],
      });
      await r.waitFor(/^INJECTED CHK:4010.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(r.lines).toContain("WORKING_AGENT unknown screen exit 3");
      expect(grep(r, "FAKE_STATUS")).toEqual([
        fakeStatus("CHK", "4010.000001", STATUS),
        fakeStatus("CHK", "4010.000001", STATUS),
      ]);
      writeFileSync(g2, "");
      await waitGate(r, g3);
      expect(grep(r, "FAKE_STATUS").slice(2)).toEqual([fakeStatus("CHK", "4010.000001", "")]);
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHK","thread":"4010.000001","reason":"unknown_limit"}');
      await stop(r);
    });

    test("a reply takes the hourglass off with the status, and eyes still turns into a check mark", async () => {
      const [g1, g2, g3] = [gate("r1"), gate("r2"), gate("r3")];
      const r = start({
        env: botEnv,
        config: on,
        herdrState: "working",
        events: [
          msg("CHR", "4004.000001", "a"),
          { fake: "wait", file: g1 },
          reply("CHR", "4004.000002", "4004.000001"),
          { fake: "wait", file: g2 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g3 },
        ],
      });
      await r.waitFor(/^INJECTED CHR:4004.000001$/);
      writeFileSync(g1, "");
      await r.waitFor(/^FAKE_REACTION CHR 4004.000001 white_check_mark$/);
      expect(grep(r, "FAKE_REACTION_REMOVE").sort()).toEqual(
        ["FAKE_REACTION_REMOVE CHR 4004.000001 eyes", `FAKE_REACTION_REMOVE CHR 4004.000001 ${HG}`].sort(),
      );
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHR","thread":"4004.000001","reason":"reply"}');
      writeFileSync(g2, "");
      await waitGate(r, g3);
      expect(grep(r, "FAKE_STATUS")).toEqual([fakeStatus("CHR", "4004.000001", STATUS)]);
      expect(gets(r)).toEqual([]);
      await stop(r);
    });

    test("off by default: no runtime state call, no hourglass, the old refresh even while the runtime says idle", async () => {
      const [g1, g2] = [gate("o1"), gate("o2")];
      const r = start({
        env: botEnv,
        herdrState: "idle",
        events: [
          msg("CHO", "4005.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
        ],
      });
      await r.waitFor(/^INJECTED CHO:4005.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(grep(r, "FAKE_STATUS")).toEqual([
        fakeStatus("CHO", "4005.000001", STATUS),
        fakeStatus("CHO", "4005.000001", STATUS),
      ]);
      expect(grep(r, "FAKE_REACTION")).toEqual(["FAKE_REACTION CHO 4005.000001 eyes"]);
      expect(gets(r)).toEqual([]);
      expect(r.lines.some((l) => l.startsWith("WORKING_"))).toBe(false);
      expect(existsSync(join(r.dir, "state", "inbound-hourglass.json"))).toBe(false);
      await stop(r);
    });

    test("workingHerdr is accepted as an alias of workingAgent", async () => {
      const [g1, g2] = [gate("a1"), gate("a2")];
      const r = start({
        env: botEnv,
        config: { workingHerdr: true },
        herdrState: "idle",
        events: [
          msg("CHA", "4011.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
        ],
      });
      await r.waitFor(/^INJECTED CHA:4011.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHA","thread":"4011.000001","reason":"agent_idle"}');
      await stop(r);
    });

    test("a restart takes off the hourglass an earlier run left, before catch-up; the state file then lists only live ones", async () => {
      const g = gate("l");
      const r = start({
        env: botEnv,
        config: on,
        herdrState: "working",
        state: { "inbound-hourglass.json": [{ channel: "CHL", thread: "4006.000000", ts: "4006.000001" }] },
        events: [{ fake: "connect" }, msg("CHL", "4006.000002", "new"), { fake: "wait", file: g }],
      });
      await r.waitFor(/^INJECTED CHL:4006.000002$/);
      const i = (l: string) => r.lines.indexOf(l);
      expect(i(`FAKE_REACTION_REMOVE CHL 4006.000001 ${HG}`)).toBeGreaterThan(-1);
      expect(i(fakeStatus("CHL", "4006.000000", ""))).toBeGreaterThan(-1);
      expect(i("WORKING_LEFTOVER_CLEARED n=1")).toBeLessThan(i("INBOUND_CATCHUP n=0"));
      expect(i(`FAKE_REACTION_REMOVE CHL 4006.000001 ${HG}`)).toBeLessThan(i("INBOUND_CATCHUP n=0"));
      expect(JSON.parse(readFileSync(join(r.dir, "state", "inbound-hourglass.json"), "utf8"))).toEqual([
        { channel: "CHL", thread: "4006.000002", ts: "4006.000002" },
      ]);
      await stop(r);
    });

    test("supervised, closing stdin takes the hourglass and the status off before the listener exits", async () => {
      const r = start({
        env: { ...botEnv, DORI_INBOUND_SUPERVISED: "1" },
        stdin: true,
        config: on,
        herdrState: "working",
        events: [msg("CHX", "4007.000001", "a"), { fake: "wait", file: gate("x") }],
      });
      await r.waitFor(/^INJECTED CHX:4007.000001$/);
      (r.proc.stdin as import("bun").FileSink).end();
      expect(await r.proc.exited).toBe(0);
      await r.waitFor(new RegExp(`^FAKE_REACTION_REMOVE CHX 4007.000001 ${HG}$`));
      expect(r.lines).toContain(fakeStatus("CHX", "4007.000001", ""));
      expect(r.lines).toContain('WORKING_CLEAR {"channel":"CHX","thread":"4007.000001","reason":"exit"}');
      expect(JSON.parse(readFileSync(join(r.dir, "state", "inbound-hourglass.json"), "utf8"))).toEqual([]);
    });

    test("hc: status working keeps the status, read from hc --json get on the lead terminal", async () => {
      const [g1, g2] = [gate("hw1"), gate("hw2")];
      const r = start({
        pane: "t4",
        env: { ...hcEnv, DORI_HC: herdrExe },
        config: on,
        herdrState: "working",
        events: [
          msg("CHH", "4012.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
        ],
      });
      await r.waitFor(/^INJECTED CHH:4012.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(gets(r).map((c) => c.argv)).toEqual([["--json", "get", "t4"]]);
      expect(r.lines).toContain("WORKING_AGENT working");
      expect(grep(r, "FAKE_STATUS")).toEqual(Array(2).fill(fakeStatus("CHH", "4012.000001", STATUS)));
      expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([]);
      await stop(r);
    });

    test("hc: status idle with no Working bar clears the status and the hourglass", async () => {
      const [g1, g2] = [gate("hi1"), gate("hi2")];
      const r = start({
        pane: "hc:t6",
        env: { ...botEnv, DORI_HC: herdrExe },
        config: on,
        herdrState: "idle",
        herdrTitle: IDLE_TITLE,
        herdrScreen: IDLE_SCREEN,
        events: [
          msg("CHJ", "4013.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
        ],
      });
      await r.waitFor(/^INJECTED CHJ:4013.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(
        r
          .herdrCalls()
          .filter((c) => c.argv[1] !== "send")
          .map((c) => c.argv),
      ).toEqual([
        ["--json", "get", "t6"],
        ["--json", "read", "t6", "--lines", "0"],
      ]);
      expect(r.lines).toContain("WORKING_AGENT idle");
      expect(grep(r, "FAKE_STATUS")).toEqual([
        fakeStatus("CHJ", "4013.000001", STATUS),
        fakeStatus("CHJ", "4013.000001", ""),
      ]);
      expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([`FAKE_REACTION_REMOVE CHJ 4013.000001 ${HG}`]);
      await stop(r);
    });

    test("hc: status idle with the Working bar in the hc read screen keeps the status", async () => {
      const [g1, g2] = [gate("hs1"), gate("hs2")];
      const r = start({
        pane: "t4",
        env: { ...hcEnv, DORI_HC: herdrExe },
        config: on,
        herdrState: "idle",
        herdrTitle: IDLE_TITLE,
        herdrScreen: WORKING_BAR,
        events: [
          msg("CHS", "4014.000001", "a"),
          { fake: "wait", file: g1 },
          { fake: "advance", ms: 60_000 },
          { fake: "wait", file: g2 },
        ],
      });
      await r.waitFor(/^INJECTED CHS:4014.000001$/);
      writeFileSync(g1, "");
      await waitGate(r, g2);
      expect(r.lines).toContain("WORKING_AGENT working screen");
      expect(grep(r, "FAKE_STATUS")).toEqual(Array(2).fill(fakeStatus("CHS", "4014.000001", STATUS)));
      expect(grep(r, "FAKE_REACTION_REMOVE")).toEqual([]);
      await stop(r);
    });
  });
});

// 2026-11-04: an orphaned listener on the same app token took a share of the Socket Mode events and two owner messages vanished.
describe("one listener per app token", () => {
  const lockName = `dori-inbound-${createHash("sha256").update("fake-app-token").digest("hex").slice(0, 16)}.lock`;

  test("a second listener on the same app token refuses to start, even with another state dir", async () => {
    const locks = join(root, "locks-second");
    const gate = join(root, "gate-second");
    const a = start({
      events: [{ fake: "wait", file: gate }],
      env: { DORI_INBOUND_LOCK_DIR: locks, DELIVERY: "stdout" },
    });
    await a.waitFor(/^INBOUND_CATCHUP/);
    expect(readFileSync(join(locks, lockName), "utf8")).toBe(String(a.proc.pid));
    const b = start({
      events: [{ fake: "wait", file: gate }],
      env: { DORI_INBOUND_LOCK_DIR: locks, DELIVERY: "stdout" },
    });
    expect(await b.waitFor(/^INBOUND_ERROR another listener pid=\d+ is running/)).toContain(`pid=${a.proc.pid} `);
    expect(await b.proc.exited).toBe(1);
    expect(b.lines).not.toContain("INBOUND_READY");
    writeFileSync(gate, "");
    await stop(a);
  });

  test("a lock its holder stopped touching is taken over, even when that pid is alive (Windows reuses pids)", async () => {
    const locks = join(root, "locks-silent");
    mkdirSync(locks, { recursive: true });
    const lock = join(locks, lockName);
    writeFileSync(lock, String(process.pid)); // alive, but not a listener
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const r = start({ events: [], env: { DORI_INBOUND_LOCK_DIR: locks, DELIVERY: "stdout" } });
    await r.waitFor(/^INBOUND_CATCHUP/);
    expect(readFileSync(lock, "utf8")).toBe(String(r.proc.pid));
    await stop(r);
  });

  test("num_connections > 1: warns, stays connected, and recovers a message the other connection took once the count drops", async () => {
    const gate = join(root, "gate-dup");
    const r = start({
      cursor: { CDUP: "6000.000002" },
      history: { "conversations.history": {} },
      events: [
        { fake: "connect", num_connections: 2 },
        msg("CDUP", "6000.000005", "live"),
        { fake: "wait", file: gate },
        { fake: "connect", num_connections: 1 },
      ],
      env: { DELIVERY: "stdout" },
    });
    expect(await r.waitFor(/^INBOUND_ERROR duplicate_socket/)).toContain("num_connections=2");
    await r.waitFor(/^INBOUND .*"ts":"6000.000005"/);
    // The other connection took 6000.000003: it shows up in history below the cursor the live message moved to.
    writeFileSync(
      join(r.dir, "history.json"),
      JSON.stringify({
        "conversations.history": {
          CDUP: {
            ok: true,
            messages: [
              { ts: "6000.000005", user: OWNER, text: "live" },
              { ts: "6000.000003", user: OWNER, text: "taken by the other connection" },
            ],
          },
        },
      }),
    );
    writeFileSync(gate, "");
    await r.waitFor(/^INBOUND_DUPLICATE_CLEARED$/);
    await r.waitFor(/^INBOUND .*"ts":"6000.000003"/);
    expect(r.lines.filter((l) => l.startsWith("INBOUND_CATCHUP"))).toEqual([
      "INBOUND_CATCHUP n=0",
      "INBOUND_CATCHUP n=1",
    ]);
    expect(
      r.lines.filter((l) => l.startsWith("INBOUND ")).map((l) => JSON.parse(l.slice("INBOUND ".length)).ts),
    ).toEqual(["6000.000005", "6000.000003"]);
    expect(r.proc.exitCode).toBeNull();
    await stop(r);
  });

  test("supervised (DORI_INBOUND_SUPERVISED=1), it exits when its stdin pipe closes, so it cannot outlive its supervisor", async () => {
    const dir = join(root, "supervised");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ fake: "wait", file: join(dir, "never") })}\n`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of ["DORI_INBOUND_PANE", "DORI_INBOUND_LOCK_DIR", "DORI_INBOUND_FAKE_HISTORY"]) delete env[k];
    Object.assign(env, {
      DORI_INBOUND_FAKE_EVENTS: join(dir, "events.jsonl"),
      DORI_CONFIG: join(dir, "config.json"),
      DORI_INBOUND_STATE_DIR: join(dir, "state"),
      DORI_SLACK_OWNER: OWNER,
      DELIVERY: "stdout",
      DORI_INBOUND_SUPERVISED: "1",
    });
    const proc = Bun.spawn([process.execPath, SCRIPT], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    procs.push(proc);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    while (!out.includes("FAKE_WAIT")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("FAKE_WAIT");
    expect(proc.exitCode).toBeNull();
    (proc.stdin as import("bun").FileSink).end();
    expect(await proc.exited).toBe(0);
  });

  test("owner edits (message_changed) and owner messages with bot_id are logged as INBOUND_SKIP, not dropped silently", async () => {
    const r = start({
      events: [
        {
          type: "message",
          subtype: "message_changed",
          channel: "CMISS",
          ts: "1793789814.000100",
          hidden: true,
          message: {
            type: "message",
            user: OWNER,
            ts: "1793789813.816289",
            thread_ts: "1793789230.364459",
            text: "two links",
          },
        },
        msg("CMISS", "1793789815.000001", "via an app", { bot_id: "BAPP" }),
        msg("CMISS", "1793789816.000001", "plain"),
      ],
      env: { DELIVERY: "stdout" },
    });
    await r.waitFor(/^INBOUND .*"ts":"1793789816.000001"/);
    expect(
      r.lines.filter((l) => l.startsWith("INBOUND_SKIP ")).map((l) => JSON.parse(l.slice("INBOUND_SKIP ".length))),
    ).toEqual([
      { channel: "CMISS", ts: "1793789813.816289", subtype: "message_changed" },
      { channel: "CMISS", ts: "1793789815.000001", reason: "bot_id" },
    ]);
    await stop(r);
  });
});

test("without fakes it refuses to start when the owner or bot id is missing, before any Slack call", async () => {
  const home = join(root, "empty-home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    USERPROFILE: home,
    HOME: home,
    DORI_SLACK_TOKEN: "xoxb-fake",
    DORI_SLACK_APP_TOKEN: "xapp-fake",
  };
  for (const k of ["DORI_SLACK_OWNER", "DORI_SLACK_BOT_USER", "DORI_INBOUND_FAKE_EVENTS", "DORI_INBOUND_FAKE_HISTORY"])
    delete env[k];
  const proc = Bun.spawn([process.execPath, SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(1);
  expect(out).toContain("INBOUND_ERROR missing DORI_SLACK_OWNER or DORI_SLACK_BOT_USER");
});
