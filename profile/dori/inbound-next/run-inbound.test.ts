import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPERVISOR = join(import.meta.dir, "run-inbound.ts");
let dir: string;
const live: Sup[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "run-inbound-test-"));
  writeFileSync(
    join(dir, "echo-child.ts"),
    `console.log("hello out"); console.error("oops err"); console.log("CHILDPID " + process.pid); setInterval(() => {}, 1000);\n`,
  );
  writeFileSync(join(dir, "crash-child.ts"), `console.log("started"); process.exit(3);\n`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const s of live.splice(0)) {
    if (s.proc.exitCode !== null) continue;
    // graceful stop so the supervisor kills its own child; hard kill only as a bounded fallback
    try {
      (s.proc.stdin as import("bun").FileSink).end();
    } catch {}
    const t = setTimeout(() => s.proc.kill(), 5000);
    await s.proc.exited;
    clearTimeout(t);
  }
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Sup = {
  proc: ReturnType<typeof Bun.spawn>;
  lines: string[];
  waitFor: (pred: (l: string) => boolean, ms?: number) => Promise<string>;
  waitCount: (pred: (l: string) => boolean, n: number, ms?: number) => Promise<string[]>;
  lock: string;
};

// overrides: extra env for the supervisor; an undefined value removes the variable.
function startSupervisor(script: string, lockName: string, overrides: Record<string, string | undefined> = {}): Sup {
  const lock = join(dir, lockName);
  const env: Record<string, string | undefined> = {
    ...process.env,
    DORI_INBOUND_SCRIPT: join(dir, script),
    DORI_INBOUND_LOCK: lock,
    DORI_INBOUND_BACKOFF_MS: "10",
    ...overrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = Bun.spawn([process.execPath, SUPERVISOR], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: env as Record<string, string>,
  });
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
      for (const w of waiters) w();
    }
  })();
  const waitCount = (pred: (l: string) => boolean, n: number, ms = 10000) =>
    new Promise<string[]>((resolve, reject) => {
      const check = () => {
        const hits = lines.filter(pred);
        if (hits.length >= n) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hits.slice(0, n));
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timeout waiting for ${n} matching lines; got:\n${lines.join("\n")}`));
      }, ms);
      waiters.add(check);
      check();
    });
  const waitFor = async (pred: (l: string) => boolean, ms?: number) => (await waitCount(pred, 1, ms))[0];
  const s = { proc, lines, waitFor, waitCount, lock };
  live.push(s);
  return s;
}

test("by default runs dori-inbound.ts beside it and locks under the home folder's .dori/state", async () => {
  const home = join(dir, "home");
  const events = join(dir, "connect-only.jsonl");
  writeFileSync(events, JSON.stringify({ fake: "connect" }) + "\n");
  const s = startSupervisor("", "unused.lock", {
    DORI_INBOUND_SCRIPT: undefined,
    DORI_INBOUND_LOCK: undefined,
    USERPROFILE: home,
    HOME: home,
    DORI_INBOUND_FAKE_EVENTS: events,
    DORI_CONFIG: join(dir, "no-config.json"),
    DORI_INBOUND_STATE_DIR: join(dir, "default-state"),
    DORI_SLACK_OWNER: "UOWNER",
    DELIVERY: "stdout",
  });
  await s.waitFor((l) => l === "INBOUND_READY");
  expect(existsSync(join(home, ".dori", "state", "inbound.lock"))).toBe(true);
});

test("a hard-killed supervisor takes its listener down with it (the stdin pipe closes)", async () => {
  const home = join(dir, "home-wd");
  const locks = join(dir, "locks-wd");
  mkdirSync(locks, { recursive: true });
  const events = join(dir, "wait-forever.jsonl");
  writeFileSync(events, JSON.stringify({ fake: "wait", file: join(dir, "gate-never") }) + "\n");
  const s = startSupervisor("", "wd.lock", {
    DORI_INBOUND_SCRIPT: undefined,
    USERPROFILE: home,
    HOME: home,
    DORI_INBOUND_FAKE_EVENTS: events,
    DORI_CONFIG: join(dir, "no-config.json"),
    DORI_INBOUND_STATE_DIR: join(dir, "wd-state"),
    DORI_INBOUND_LOCK_DIR: locks,
    DORI_SLACK_OWNER: "UOWNER",
    DELIVERY: "stdout",
  });
  await s.waitFor((l) => l.startsWith("INBOUND_CATCHUP"));
  // The listener's own lock holds its pid: the real listener, not a shim.
  const lockFile = join(locks, readdirSync(locks)[0]);
  const childPid = Number(readFileSync(lockFile, "utf8"));
  expect(alive(childPid)).toBe(true);
  s.proc.kill("SIGKILL"); // no shutdown handler runs
  await s.proc.exited;
  // No OS event exists for a non-child pid: check it, bounded at 10 s.
  for (let i = 0; i < 500 && alive(childPid); i++) await Bun.sleep(20);
  expect(alive(childPid)).toBe(false);
}, 20_000);

test("forwards stdout unchanged and prefixes stderr", async () => {
  const s = startSupervisor("echo-child.ts", "fwd.lock");
  await s.waitFor((l) => l === "hello out");
  await s.waitFor((l) => l === "INBOUND_STDERR oops err");
  expect(s.lines).not.toContain("oops err");
});

test("restarts after crash with message, backoff grows, storm printed once", async () => {
  const s = startSupervisor("crash-child.ts", "crash.lock");
  const isExit = (l: string) => l.startsWith("INBOUND_ERROR listener exited");
  const exits = await s.waitCount(isExit, 6, 20000);
  expect(exits).toEqual([
    "INBOUND_ERROR listener exited code=3; restart in 0.02s",
    "INBOUND_ERROR listener exited code=3; restart in 0.04s",
    "INBOUND_ERROR listener exited code=3; restart in 0.08s",
    "INBOUND_ERROR listener exited code=3; restart in 0.16s",
    "INBOUND_ERROR listener exited code=3; restart in 0.3s",
    "INBOUND_ERROR listener exited code=3; restart in 0.3s",
  ]);
  // restarted: child output after each crash
  expect(s.lines.filter((l) => l === "started").length).toBeGreaterThanOrEqual(6);
  // storm printed exactly once, right after the 5th exit
  const storms = s.lines.filter((l) => l === "INBOUND_ERROR restart storm");
  expect(storms.length).toBe(1);
  const fifth = s.lines.findIndex((l, i) => isExit(l) && s.lines.slice(0, i + 1).filter(isExit).length === 5);
  expect(s.lines[fifth + 1]).toBe("INBOUND_ERROR restart storm");
}, 30000);

test("refuses to run when lock pid is alive", async () => {
  const lock = join(dir, "busy.lock");
  writeFileSync(lock, String(process.pid));
  const s = startSupervisor("echo-child.ts", "busy.lock");
  await s.waitFor((l) => l === `INBOUND_ERROR another supervisor pid=${process.pid} is running`);
  expect(await s.proc.exited).toBe(1);
  expect(s.lines).not.toContain("hello out");
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
});

test("takes over a stale lock", async () => {
  const dead = Bun.spawn(["bun", "-e", "0"]);
  await dead.exited;
  expect(alive(dead.pid)).toBe(false);
  const lock = join(dir, "stale.lock");
  writeFileSync(lock, String(dead.pid));
  const s = startSupervisor("echo-child.ts", "stale.lock");
  await s.waitFor((l) => l === "hello out");
  expect(readFileSync(lock, "utf8").trim()).toBe(String(s.proc.pid));
});

test("stdin close kills the child and exits 0", async () => {
  const s = startSupervisor("echo-child.ts", "stop.lock");
  const line = await s.waitFor((l) => l.startsWith("CHILDPID "));
  const childPid = Number(line.split(" ")[1]);
  expect(alive(childPid)).toBe(true);
  (s.proc.stdin as import("bun").FileSink).end();
  expect(await s.proc.exited).toBe(0);
  expect(alive(childPid)).toBe(false);
  expect(existsSync(s.lock)).toBe(false);
});
