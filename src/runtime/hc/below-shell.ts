// herdr-core #70: on Windows a terminal's foreground never moves off its shell, so whether a program runs in it is
// read from the process tree: any child of the shell but the console host counts.
import { type Exec, spawnExec } from "../exec.ts";

/** Whether a program runs below the shell `pid`; a failed lookup is doubt and reads as no program (nothing is typed). */
export type BelowShell = (pid: number) => Promise<boolean>;

export const childrenScript = (pid: number): string =>
  `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.Name -notin 'conhost.exe','OpenConsole.exe' } | Measure-Object).Count`;

export const processBelowShell =
  (exec: Exec = spawnExec): BelowShell =>
  async (pid) => {
    const res = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", childrenScript(pid)]);
    return res.code === 0 && Number(res.stdout.trim()) > 0;
  };
