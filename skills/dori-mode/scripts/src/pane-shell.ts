// win-dori: the agent line typed into a new session, quoted for that session's own shell (POSIX sh, pwsh, Windows
// PowerShell 5.1 or cmd).
import type { PaneShellSetting } from "./config.ts";
import { quoteForPane } from "./launch-footer.ts";
import { baseName, IS_WINDOWS } from "./paths.ts";

export type PaneShell = "posix" | "pwsh" | "powershell" | "cmd";

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

// Windows PowerShell 5.1 hands a native command's arguments over without escaping: it only wraps an argument that
// contains whitespace in quotes and drops empty ones. Escape for CommandLineToArgvW ourselves.
// When 5.1 would not wrap, as for `"b c"`, the quotes are written so it still does not, with `""` for a quote.
const legacyArg = (arg: string): string => {
  if (arg === "") return '""';
  const s = arg.replace(/(\\*)"/g, '$1$1\\"');
  if (!/\s/.test(arg)) return s;
  if (ps51Wraps(s)) return s.replace(/(\\+)$/, "$1$1");
  return `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1")}"`;
};

const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

/**
 * The line to type into a pane so that the program receives exactly `argv`. cmd.exe cannot quote % and ^ reliably, so
 * for cmd the PowerShell 5.1 form is passed through -EncodedCommand (base64 of UTF-16LE), which contains no cmd
 * metacharacter at all.
 */
export const paneCommand = (argv: readonly string[], shell: PaneShell): string => {
  if (shell === "posix") return argv.map(quoteForPane).join(" ");
  if (shell === "pwsh") return `& ${argv.map(psLiteral).join(" ")}`;
  const ps = `& ${argv.map((a, i) => psLiteral(i === 0 ? a : legacyArg(a))).join(" ")}`;
  return shell === "powershell" ? ps : `powershell -NoProfile -EncodedCommand ${encodedCommand(ps)}`;
};

export const shellFromProcess = (name: string): PaneShell | undefined => {
  const n = baseName(name)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return n === "pwsh" || n === "powershell" || n === "cmd"
    ? n
    : /^(bash|sh|zsh|dash|fish)$/.test(n)
      ? "posix"
      : undefined;
};

type Foreground = readonly { readonly name?: string; readonly argv0?: string; readonly argv?: readonly string[] }[];

/** The shell of a new session from its foreground processes (the runtime's probe); pwsh when it cannot be read. */
export const resolvePaneShell = async (
  setting: PaneShellSetting | undefined,
  foreground: () => Promise<Foreground | undefined>,
  windows = IS_WINDOWS,
): Promise<PaneShell> => {
  if (setting && setting !== "auto") return setting;
  if (!windows) return "posix";
  try {
    for (const p of (await foreground()) ?? []) {
      for (const name of [p.name, p.argv0, p.argv?.[0]]) {
        const found = name ? shellFromProcess(name) : undefined;
        if (found) return found;
      }
    }
  } catch {}
  return "pwsh";
};
