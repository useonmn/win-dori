import { win32 } from "node:path";

import { baseName } from "./paths.ts";
import type { CommandSys, Resolved } from "./run.ts";

// cmd.exe's command line limit.
const CMD_MAX = 8191;
const SAFE_BARE = /^[A-Za-z0-9#$*+\-./:?@\\_]$/;

/**
 * One argument for a .bat/.cmd command line, per Rust std 1.77 (the CVE-2024-24576 fix): quote anything that is not
 * plainly safe, double inner quotes so cmd.exe's quote state never flips, and turn `%` into `%%cd:~,%` (an empty
 * substring of %cd%) so `%VAR%` cannot expand. Inside quotes, `& | < > ^ ( )` are literal, so no ^-escaping is needed.
 */
export const batArg = (arg: string): string => {
  const quote =
    arg === "" ||
    arg.endsWith("\\") ||
    [...arg].some((c) => (c.charCodeAt(0) < 128 ? !SAFE_BARE.test(c) : /\p{Cc}/u.test(c)));
  let s = "";
  let slashes = 0;
  for (const c of arg) {
    if (c === "\\") {
      slashes++;
      s += c;
      continue;
    }
    if (c === '"') s += `${"\\".repeat(slashes)}"`;
    else if (c === "%") s += "%%cd:~,";
    slashes = 0;
    s += c;
  }
  return quote ? `"${s}${"\\".repeat(slashes)}"` : s;
};

export const cmdLine = (script: string, args: readonly string[], sys: CommandSys): Resolved => {
  if (/["%]/.test(script) || script.endsWith("\\"))
    return { refused: `cannot run ${script} safely through cmd.exe: its path contains " or %` };
  const bad = args.findIndex((a) => /[\r\n\0]/.test(a));
  if (bad >= 0)
    return {
      refused: `argument ${bad + 1} for ${baseName(script)} contains a newline or NUL, which cmd.exe cannot pass to a .bat/.cmd safely`,
    };
  const line = `""${script}"${args.map((a) => ` ${batArg(a)}`).join("")}"`;
  if (line.length > CMD_MAX)
    return { refused: `command line for ${baseName(script)} exceeds cmd.exe's ${CMD_MAX} character limit` };
  return { argv: [sys.cmdExe, "/d", "/e:ON", "/v:OFF", "/s", "/c", line], verbatim: true };
};

const isNode = (prog: string): boolean => /^node(\.exe)?$/i.test(baseName(prog));

/**
 * The program a standard npm/cmd-shim .cmd ends up running: its last `... %*` line is `"<node>" "<script>" %*` or
 * `"<target>.exe" %*`, with `%~dp0`, `%dp0%` and `SET` variables expanded. Null for anything else.
 */
export const shimTarget = (file: string, text: string, sys: CommandSys): readonly string[] | null => {
  const dir = `${win32.dirname(file)}\\`;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const sets = new Map<string, string>();
  for (const l of lines) {
    const m = /^@?set\s+"?([^=\s"]+)=([^"]*)"?$/i.exec(l);
    if (m?.[1] && m[2] !== undefined && !sets.has(m[1].toLowerCase())) sets.set(m[1].toLowerCase(), m[2]);
  }
  const line = lines.findLast((l) => /\s%\*$/.test(l));
  if (!line) return null;
  const head = (line.slice(0, -2).split(" & ").pop() ?? "").trim().replace(/^@/, "");
  const tokens = [...head.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
  const expand = (token: string): string | null => {
    let s = token;
    for (let i = 0; i < 4 && s.includes("%"); i++)
      s = s.replace(/%~dp0|%dp0%|%(\w+)%/gi, (all, v?: string) =>
        v === undefined ? dir : (sets.get(v.toLowerCase()) ?? all),
      );
    if (s.includes("%")) return null;
    return /[\\/]/.test(s) ? win32.normalize(s) : s;
  };
  const words = tokens.map(expand);
  if (words.some((w) => w === null)) return null;
  const [prog, script, ...rest] = words as string[];
  if (!prog || rest.length) return null;
  if (script !== undefined) {
    if (!isNode(prog) || !win32.isAbsolute(script) || !sys.exists(script)) return null;
    return [win32.isAbsolute(prog) && sys.exists(prog) ? prog : (sys.which("node") ?? sys.execPath), script];
  }
  return /\.(exe|com)$/i.test(prog) && win32.isAbsolute(prog) && sys.exists(prog) ? [prog] : null;
};
