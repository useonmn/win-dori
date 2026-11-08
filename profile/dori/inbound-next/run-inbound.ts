// Supervisor for the Slack inbound listener: keeps it running, restarts with backoff.
// Env overrides (tests): DORI_INBOUND_SCRIPT, DORI_INBOUND_LOCK, DORI_INBOUND_BACKOFF_MS.
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = process.env.DORI_INBOUND_SCRIPT ?? join(import.meta.dir, "dori-inbound.ts");
const LOCK = process.env.DORI_INBOUND_LOCK ?? join(homedir(), ".dori", "state", "inbound.lock");
const BASE_MS = Number(process.env.DORI_INBOUND_BACKOFF_MS ?? 1000);
const STEPS = [2, 4, 8, 16, 30];
const STABLE_MS = 10 * 60 * 1000;
const STORM_WINDOW_MS = 10 * 60 * 1000;
const STORM_EXITS = 5;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function acquireLock(): boolean {
  mkdirSync(dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw e;
    }
    let pid = NaN;
    try {
      pid = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
    } catch {}
    if (pid !== process.pid && pidAlive(pid)) {
      console.log(`INBOUND_ERROR another supervisor pid=${pid} is running`);
      return false;
    }
    try {
      unlinkSync(LOCK); // stale lock: take over
    } catch {}
  }
  console.log(`INBOUND_ERROR could not acquire lock ${LOCK}`);
  return false;
}

function releaseLock() {
  try {
    if (parseInt(readFileSync(LOCK, "utf8").trim(), 10) === process.pid) unlinkSync(LOCK);
  } catch {}
}

async function pumpLines(stream: ReadableStream<Uint8Array>, prefix: string) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      process.stdout.write(prefix + buf.slice(0, i + 1));
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();
  if (buf.length) process.stdout.write(`${prefix + buf}\n`);
}

let child: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let step = 0;
let stormPrinted = false;
const exitTimes: number[] = [];

async function runChild() {
  if (stopping) return;
  const startedAt = Date.now();
  // process.execPath, not "bun": through the mise shim the real listener is a grandchild (bun -> mise x -> bun.exe) that
  // proc.kill() never reaches, so on 2026-11-04 one outlived its supervisor and split Socket Mode events with the next one.
  // stdin is a pipe only this process holds: with DORI_INBOUND_SUPERVISED=1 the listener exits when it closes, however we die.
  const proc = Bun.spawn([process.execPath, SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DORI_INBOUND_SUPERVISED: "1" },
  });
  child = proc;
  const pumps = Promise.all([
    pumpLines(proc.stdout as ReadableStream<Uint8Array>, ""),
    pumpLines(proc.stderr as ReadableStream<Uint8Array>, "INBOUND_STDERR "),
  ]).catch(() => {});
  const code = await proc.exited;
  await pumps;
  child = null;
  if (stopping) return;

  const now = Date.now();
  if (now - startedAt >= STABLE_MS) {
    step = 0;
    stormPrinted = false;
  }
  exitTimes.push(now);
  while (exitTimes.length && now - exitTimes[0] > STORM_WINDOW_MS) exitTimes.shift();
  const storm = exitTimes.length >= STORM_EXITS;
  const units = storm ? STEPS[STEPS.length - 1] : STEPS[Math.min(step, STEPS.length - 1)];
  step++;
  const delayMs = units * BASE_MS;
  const secs = Number((delayMs / 1000).toFixed(3));
  console.log(`INBOUND_ERROR listener exited code=${code}; restart in ${secs}s`);
  if (storm && !stormPrinted) {
    stormPrinted = true;
    console.log("INBOUND_ERROR restart storm");
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    runChild();
  }, delayMs);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  const c = child;
  if (c) {
    // The whole tree on Windows, so nothing the listener started (herdr calls) outlives us either.
    if (process.platform === "win32") {
      try {
        await Bun.spawn(["taskkill", "/PID", String(c.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
      } catch {}
    }
    c.kill();
    await c.exited;
  }
  releaseLock();
  process.exit(0);
}

if (!acquireLock()) process.exit(1);
process.on("exit", releaseLock);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
(async () => {
  try {
    for await (const _ of Bun.stdin.stream()) {
    }
  } catch {}
  shutdown();
})();
runChild();
