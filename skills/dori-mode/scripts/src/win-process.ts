import { dlopen, FFIType, ptr } from "bun:ffi";

export type WinProc = { readonly pid: number; readonly ppid: number; readonly cmd: string; readonly startedAt?: number };

/** One PowerShell call listing every process with its parent, command line, and UTC start time. */
export const WIN_PROC_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8;",
  "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine,",
  "@{n='CreationDate';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}}",
  "| ConvertTo-Json -Compress",
].join(" ");

type CimRow = { readonly ProcessId?: number; readonly ParentProcessId?: number; readonly CommandLine?: string | null; readonly CreationDate?: string | null };

export const parseWin32Processes = (json: string): WinProc[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "[]");
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r: CimRow) => {
    if (typeof r?.ProcessId !== "number") return [];
    const at = r.CreationDate ? Date.parse(r.CreationDate) : Number.NaN;
    return [{ pid: r.ProcessId, ppid: r.ParentProcessId ?? 0, cmd: r.CommandLine ?? "", ...(Number.isNaN(at) ? {} : { startedAt: at }) }];
  });
};

/** Splits a Windows command line the way CommandLineToArgvW does (the program name takes no backslash escapes). */
export const parseWindowsCommandLine = (line: string): string[] => {
  const out: string[] = [];
  let i = 0;
  const s = line.trimStart();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    out.push(end < 0 ? s.slice(1) : s.slice(1, end));
    i = end < 0 ? s.length : end + 1;
  } else {
    const m = /^[^\s]*/.exec(s)?.[0] ?? "";
    if (m) out.push(m);
    i = m.length;
  }
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] ?? "")) i++;
    if (i >= s.length) break;
    let arg = "";
    let quoted = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        let n = 0;
        while (s[i + n] === "\\") n++;
        if (s[i + n] === '"') {
          arg += "\\".repeat(Math.floor(n / 2));
          if (n % 2) arg += '"';
          else quoted = !quoted;
          i += n;
        } else {
          arg += "\\".repeat(n);
          i += n - 1;
        }
      } else if (c === '"') {
        if (quoted && s[i + 1] === '"') {
          arg += '"';
          i++;
        } else quoted = !quoted;
      } else if (!quoted && /\s/.test(c ?? "")) break;
      else arg += c;
    }
    out.push(arg);
  }
  return out;
};

/** Splits a UTF-16 environment block (`K=V\0K=V\0\0`) into a map; drive-cwd entries such as `=C:=C:\x` are skipped. */
export const parseEnvBlock = (block: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    if (!entry) break;
    const eq = entry.indexOf("=", 1);
    if (eq > 0 && !entry.startsWith("=")) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
};

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;
// x64 layouts: PROCESS_BASIC_INFORMATION.PebBaseAddress, PEB.ProcessParameters,
// RTL_USER_PROCESS_PARAMETERS.Environment and .EnvironmentSize.
const PBI_SIZE = 48;
const PBI_PEB = 8;
const PEB_PARAMS = 0x20;
const PARAMS_ENV = 0x80;
const PARAMS_ENV_SIZE = 0x3f0;
const MAX_ENV_BYTES = 4 << 20;

let api: ReturnType<typeof load> | undefined;
const load = () => {
  const k32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    ReadProcessMemory: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const nt = dlopen("ntdll.dll", { NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 } });
  return { ...k32.symbols, ...nt.symbols };
};

/**
 * Reads another same-user process's environment from its PEB (x64 Windows only). Any failure, such as access
 * denied, a process that exited, or a non-x64 host, returns undefined.
 */
export const readProcessEnv = (pid: number): Record<string, string> | undefined => {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined;
  try {
    api ??= load();
    const a = api;
    const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
    if (!h) return undefined;
    try {
      const read = (addr: bigint, size: number): Uint8Array | undefined => {
        const buf = new Uint8Array(size);
        const got = new BigUint64Array(1);
        return a.ReadProcessMemory(h, addr, ptr(buf), BigInt(size), ptr(got)) && got[0] === BigInt(size) ? buf : undefined;
      };
      const pbi = new Uint8Array(PBI_SIZE);
      const len = new Uint32Array(1);
      if (a.NtQueryInformationProcess(h, 0, ptr(pbi), PBI_SIZE, ptr(len)) !== 0) return undefined;
      const peb = new DataView(pbi.buffer).getBigUint64(PBI_PEB, true);
      const pebBuf = peb ? read(peb + BigInt(PEB_PARAMS), 8) : undefined;
      const params = pebBuf ? new DataView(pebBuf.buffer).getBigUint64(0, true) : 0n;
      const head = params ? read(params, PARAMS_ENV_SIZE + 8) : undefined;
      if (!head) return undefined;
      const view = new DataView(head.buffer);
      const envAddr = view.getBigUint64(PARAMS_ENV, true);
      const envSize = Number(view.getBigUint64(PARAMS_ENV_SIZE, true));
      if (!envAddr || envSize <= 0 || envSize > MAX_ENV_BYTES) return undefined;
      const block = read(envAddr, envSize & ~1);
      return block ? parseEnvBlock(new TextDecoder("utf-16le").decode(block)) : undefined;
    } finally {
      a.CloseHandle(h);
    }
  } catch {
    return undefined;
  }
};
