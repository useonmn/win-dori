// Shell-aware command lines for the sessions dori types into; ported from windori's launch.ts.

import { shq } from "./delivery.ts";
import type { SessionRef, SessionRuntime } from "./runtime/types.ts";

export type PaneShell = "posix" | "pwsh" | "powershell" | "cmd";

export const IS_WINDOWS = process.platform === "win32";

const SHELLS: readonly PaneShell[] = ["posix", "pwsh", "powershell", "cmd"];

export const parseShell = (raw: string): PaneShell => {
  const v = raw.trim().toLowerCase();
  if ((SHELLS as readonly string[]).includes(v)) return v as PaneShell;
  throw new Error(`DORI_PANE_SHELL must be one of ${SHELLS.join(", ")}, got ${raw}`);
};

const PS_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
const psLiteral = (s: string): string => `'${s.replace(PS_QUOTES, (c) => c + c)}'`;

// PowerShell 5.1's own test for wrapping an argument: whitespace outside quotes, counting an escaped quote as a quote.
const ps51Wraps = (s: string): boolean => {
  let quotes = 0;
  for (const c of s) {
    if (c === '"') quotes++;
    else if (/\s/.test(c) && quotes % 2 === 0) return true;
  }
  return false;
};

// Windows PowerShell 5.1 hands a native command's arguments over without escaping: it only wraps
// an argument containing whitespace in quotes and drops empty ones. Escape for CommandLineToArgvW.
// When 5.1 would not wrap, as for `"b c"`, the quotes are written so it still does not, with `""` for a quote.
const legacyArg = (arg: string): string => {
  if (arg === "") return '""';
  const s = arg.replace(/(\\*)"/g, '$1$1\\"');
  if (!/\s/.test(arg)) return s;
  if (ps51Wraps(s)) return s.replace(/(\\+)$/, "$1$1");
  return `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1")}"`;
};

const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

// A pane line is typed and ends at Enter, so a line break inside an argument must not be typed: it is spelled as an
// expression that stays on one line.
const psArg = (s: string): string => {
  if (!/[\r\n]/.test(s)) return psLiteral(s);
  const parts = s
    .split(/(\r\n|\r|\n)/)
    .map((p, i) => (i % 2 ? `"${p.replace("\r", "`r").replace("\n", "`n")}"` : psLiteral(p)));
  return `(${parts.join("+")})`;
};

// cmd.exe cannot quote `%` and `^` reliably, so a cmd pane gets the PowerShell 5.1 form as -EncodedCommand (base64 of
// UTF-16LE), which contains no cmd metacharacter at all.
const forCmd = (script: string): string => `powershell -NoProfile -EncodedCommand ${encodedCommand(script)}`;

const POSIX_SAFE = /^[\w./:@=-]+$/;

/** One argument for a line in `shell`. For cmd this is a fragment of the PowerShell 5.1 script that `forCmd` wraps. */
export const quoteArg = (arg: string, shell: PaneShell): string => {
  if (shell === "posix") return POSIX_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
  if (shell === "pwsh") return psArg(arg);
  return psArg(legacyArg(arg));
};

/** The line to type into a pane so the program receives exactly `argv`. */
export const paneCommand = (argv: readonly string[], shell: PaneShell): string => {
  const [head, ...rest] = argv;
  if (head === undefined) throw new Error("empty command");
  if (shell === "posix") return argv.map((a) => quoteArg(a, "posix")).join(" ");
  if (shell === "pwsh") return `& ${argv.map(psArg).join(" ")}`;
  const ps = `& ${[psArg(head), ...rest.map((a) => quoteArg(a, shell))].join(" ")}`;
  return shell === "powershell" ? ps : forCmd(ps);
};

/**
 * Appends one argument to a command line the user already wrote (an agent command such as
 * `omo` or `omo --model x`). For a cmd pane the whole line is wrapped, so PowerShell 5.1 parses
 * that base line: write it for PowerShell (`paneCommand(argv, "powershell")`), not for cmd.
 */
export const appendArg = (line: string, arg: string, shell: PaneShell): string => {
  const full = `${line} ${quoteArg(arg, shell)}`;
  return shell === "cmd" ? forCmd(full) : full;
};

/**
 * One word valid in pwsh, PowerShell 5.1, cmd and Git Bash alike, also inside a prompt an agent's own shell runs:
 * forward slashes, which all four read as path separators, and double quotes only when the path needs them.
 * A path holding `$`, a backtick, `%` or `"` has no such form.
 */
const neutralPath = (path: string): string => {
  const p = path.replaceAll("\\", "/");
  return /^[\w./:-]+$/.test(p) ? p : `"${p}"`;
};

/**
 * The default dori command, which prompts carry and panes run. Off Windows it is upstream's POSIX form; on Windows the
 * sessions get DORI_HOME in their env instead, since pwsh, PowerShell 5.1 and cmd have no `VAR=value command` form.
 */
export const doriCommand = (cli: string, root: string, windows: boolean = IS_WINDOWS): string =>
  windows ? `bun ${neutralPath(cli)}` : `DORI_HOME=${shq(root)} bun ${shq(cli)}`;

export const shellFromProcess = (name: string): PaneShell | undefined => {
  const n = (name.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  if (n === "pwsh" || n === "powershell" || n === "cmd") return n;
  return /^(bash|sh|zsh|dash|fish)$/.test(n) ? "posix" : undefined;
};

/** The shell assumed when a session's own cannot be read: DORI_PANE_SHELL, else pwsh on Windows, else POSIX. */
export const defaultShell = (env: Readonly<Record<string, string | undefined>> = process.env, windows = IS_WINDOWS) => {
  const forced = env["DORI_PANE_SHELL"];
  if (forced) return parseShell(forced);
  return windows ? "pwsh" : "posix";
};

/**
 * The shell of a session the harness just created, read from its foreground: on Windows the runtime's default shell
 * (herdr's, or the PowerShell an hc session runs) need not be the one this CLI runs in. DORI_PANE_SHELL wins.
 */
export const sessionShell = async (
  rt: SessionRuntime,
  ref: SessionRef,
  fallback: PaneShell,
  windows = IS_WINDOWS,
): Promise<PaneShell> => {
  const forced = process.env["DORI_PANE_SHELL"];
  if (forced) return parseShell(forced);
  if (!windows) return fallback;
  try {
    for (const p of (await rt.probe(ref)).foreground ?? []) {
      for (const name of [p.name, p.argv[0]]) {
        const found = name ? shellFromProcess(name) : undefined;
        if (found) return found;
      }
    }
  } catch {
    // an unreadable session keeps the fallback
  }
  return fallback;
};
