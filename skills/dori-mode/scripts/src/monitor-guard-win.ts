import { dlopen, FFIType, ptr } from "bun:ffi";

import type { ProcRef } from "./monitor-guard.ts";
import type { Runner } from "./run.ts";
import { parseWin32Processes, WIN_PROC_SCRIPT, type WinProc } from "./win-process.ts";

export const listProcesses = (run: Runner) => async (): Promise<WinProc[]> => {
  const r = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WIN_PROC_SCRIPT], {
    timeoutMs: 30_000,
  });
  return r.code === 0 ? parseWin32Processes(r.out) : [];
};

export const killTree =
  (run: Runner) =>
  async (pid: number): Promise<void> => {
    await run(["taskkill", "/T", "/F", "/PID", String(pid)], { timeoutMs: 30_000 });
  };

const SYNCHRONIZE = 0x0010_0000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WAIT_OBJECT_0 = 0;
const FILETIME_EPOCH_MS = 11_644_473_600_000;

let k32: ReturnType<typeof loadK32> | undefined;
const loadK32 = () =>
  dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;

/**
 * Holds a handle to `r` (so its pid cannot be reused under us) and reports whether it has exited. A process that is
 * already gone, or whose start time differs from `r.startedAt` by more than a millisecond (a reused pid), reads as gone.
 */
export const watchWinProcess = (r: ProcRef): (() => boolean) => {
  k32 ??= loadK32();
  const api = k32;
  const h = api.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, r.pid);
  if (!h) return () => true;
  if (r.startedAt !== undefined) {
    const times = new BigUint64Array(4);
    if (api.GetProcessTimes(h, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24))) {
      const created = Number((times[0] ?? 0n) / 10_000n) - FILETIME_EPOCH_MS;
      if (Math.abs(created - r.startedAt) > 1) {
        api.CloseHandle(h);
        return () => true;
      }
    }
  }
  return () => api.WaitForSingleObject(h, 0) === WAIT_OBJECT_0;
};
