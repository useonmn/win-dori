import { homedir } from "node:os";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;

/**
 * A comparable form of a path: forward slashes, no `\\?\` prefix, no trailing slash, and lower case on Windows,
 * whose file system is case-insensitive. git prints `C:/a/b` where Windows APIs give `C:\a\b`; both get one key.
 */
export const pathKey = (path: string, windows = IS_WINDOWS): string => {
  let s = path.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, "");
  return windows ? s.toLowerCase() : s;
};

export const samePath = (a: string, b: string, windows = IS_WINDOWS): boolean =>
  pathKey(a, windows) === pathKey(b, windows);

export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? "";

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const POSIX_LOCAL = /\/(Users|home|Volumes|private)\/\S+/g;
// A drive path (C:\x, C:/x), a \\?\ long path, or a UNC share. The drive letter must start a word, so URL schemes
// such as https:// never match. Trailing punctuation (a comma, a closing paren) stays outside the match.
const WINDOWS_LOCAL =
  /(?<![\w~])[A-Za-z]:[\\/](?:\S*[^\s,;.:)'"\]])?|\\\\\?\\\S*[^\s,;.:)'"\]]|\\\\[\w.$-]+\\\S*[^\s,;.:)'"\]]/g;

/**
 * Makes a line safe to post to a messenger thread: the home directory (in either slash form) becomes `~`, and any
 * other local path, POSIX or Windows, becomes `(local path)`.
 */
export const scrubLocalPaths = (text: string, home = ""): string => {
  let out = text;
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const v of [...variants].sort((a, b) => b.length - a.length))
      out = out.replace(new RegExp(escapeRegex(v), IS_WINDOWS || /^[A-Za-z]:/.test(v) ? "gi" : "g"), "~");
  }
  return out.replace(POSIX_LOCAL, "(local path)").replace(WINDOWS_LOCAL, "(local path)");
};

/**
 * The Dori's own folder, as its lead's env names it. A second Dori on the PC runs with these set; a lane is started by
 * the runtime (hc's core, herdr's server), not by the lead's shell, so it inherits none of them and would report into
 * the first Dori's state: they are passed to the lane's session explicitly, when set.
 */
const LANE_ENV_KEYS = ["DORI_HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE"] as const;
export const laneEnv = (env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> =>
  Object.fromEntries(LANE_ENV_KEYS.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
