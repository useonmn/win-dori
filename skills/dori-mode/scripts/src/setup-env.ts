// Setup values: the env keys of each messenger, token masking and scrubbing, parsing of what the owner pasted, the env file text and its atomic write.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Http } from "./messenger/http.ts";

export const MESSENGERS = ["slack", "telegram", "discord"] as const;
export type Messenger = (typeof MESSENGERS)[number];

export const TOKEN = "DORI_SLACK_TOKEN";
export const APP_TOKEN = "DORI_SLACK_APP_TOKEN";
export const COOKIE = "DORI_SLACK_COOKIE";
export const APP_ID = "DORI_SLACK_APP_ID";
export const CHANNEL = "DORI_SLACK_CHANNEL";
export const OWNER = "DORI_SLACK_OWNER";
export const BOT_USER = "DORI_SLACK_BOT_USER";
export const TG_TOKEN = "DORI_TELEGRAM_TOKEN";
export const TG_BOT = "DORI_TELEGRAM_BOT";
export const TG_OWNER = "DORI_TELEGRAM_OWNER";
export const DC_TOKEN = "DORI_DISCORD_TOKEN";
export const DC_APP_ID = "DORI_DISCORD_APP_ID";
export const DC_BOT_USER = "DORI_DISCORD_BOT_USER";
export const DC_OWNER = "DORI_DISCORD_OWNER";

/** Every key each messenger's env file may hold, in the order the file lists them. */
export const KEYS: Record<Messenger, readonly string[]> = {
  slack: [TOKEN, APP_TOKEN, COOKIE, APP_ID, CHANNEL, OWNER, BOT_USER],
  telegram: [TG_TOKEN, TG_BOT, TG_OWNER],
  discord: [DC_TOKEN, DC_APP_ID, DC_BOT_USER, DC_OWNER],
};
export const SECRET_KEYS = new Set<string>([TOKEN, APP_TOKEN, COOKIE, TG_TOKEN, DC_TOKEN]);

/** Slack has three modes, told apart by the token: a bot (xoxb-, with Socket Mode), a user token (xoxp-) or a browser token (xoxc-, with the d cookie). */
export const requiredKeys = (m: Messenger, v: Values): string[] => {
  if (m === "telegram") return [TG_TOKEN, TG_BOT, TG_OWNER];
  if (m === "discord") return [DC_TOKEN, DC_APP_ID, DC_BOT_USER, DC_OWNER];
  const t = v[TOKEN] ?? "";
  if (t.startsWith("xoxc-")) return [TOKEN, COOKIE, CHANNEL, OWNER, BOT_USER];
  if (t.startsWith("xoxp-")) return [TOKEN, CHANNEL, OWNER, BOT_USER];
  return [TOKEN, APP_TOKEN, APP_ID, CHANNEL, OWNER, BOT_USER];
};

export type Values = Record<string, string>;

// Token shapes: Slack (xoxb/xoxp/xoxc, xapp, the xoxd cookie), Telegram (<bot id>:<35 chars>), Discord (three dot-separated base64url parts).
const SLACK_RE = /\b(xox[a-z]-|xapp-)[\w%-]+/g;
const TELEGRAM_RE = /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g;
const DISCORD_RE = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g;

/** Replaces every token-shaped string, so no line built from API replies, errors or pasted text can carry one. */
export const scrubTokens = (text: string): string =>
  text.replace(SLACK_RE, "$1…").replace(TELEGRAM_RE, "(token)").replace(DISCORD_RE, "(token)");

/** `xoxb-… (59 chars)` for a token, the value itself for a non-secret id. */
export const maskValue = (key: string, value: string): string => {
  if (!SECRET_KEYS.has(key)) return value;
  const prefix = /^(xox[a-z]-|xapp-)/.exec(value)?.[1] ?? "";
  return `${prefix}… (${value.length} chars)`;
};

/** `KEY=VALUE` lines of an env file, in file order; comments and blank lines are skipped. */
export const parseEnvText = (text: string): Values => {
  const out: Values = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

export type ParsedInput = { readonly values: Values; readonly ignoredLines: readonly number[] };

/**
 * Reads what the owner pasted: `KEY=VALUE` lines for the messenger's keys, or a bare token anywhere on a line
 * (Slack: xoxb-/xoxp-/xoxc- token, xapp- app-level token, xoxd- cookie; Telegram and Discord: their bot token).
 * Any other line is reported by number only, never by content, because it may hold a mistyped secret.
 */
export const parseSetupInput = (text: string, m: Messenger = "slack"): ParsedInput => {
  const values: Values = {};
  const ignoredLines: number[] = [];
  const known = new Set<string>(KEYS[m]);
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const kv = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (kv && known.has(kv[1]!)) {
      const v = kv[2]!
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim();
      if (v) values[kv[1]!] = v;
      return;
    }
    const found: [string, string | undefined][] =
      m === "slack"
        ? [
            [TOKEN, /\b(xox[bpc]-[\w-]+)/.exec(line)?.[1]],
            [APP_TOKEN, /\b(xapp-[\w-]+)/.exec(line)?.[1]],
            [COOKIE, /\b(xoxd-[\w%-]+)/.exec(line)?.[1]],
          ]
        : m === "telegram"
          ? [[TG_TOKEN, line.match(TELEGRAM_RE)?.[0]]]
          : [[DC_TOKEN, line.match(DISCORD_RE)?.[0]]];
    let any = false;
    for (const [k, v] of found) {
      if (!v) continue;
      values[k] = v;
      any = true;
    }
    if (!any) ignoredLines.push(n + 1);
  });
  return { values, ignoredLines };
};

/** Env file text: the messenger's keys in canonical order, then any other keys the file already had. */
export const renderEnv = (m: Messenger, values: Values): string => {
  const keys = [
    ...KEYS[m].filter((k) => values[k]),
    ...Object.keys(values).filter((k) => !KEYS[m].includes(k) && values[k]),
  ];
  return `${keys.map((k) => `${k}=${values[k]}`).join("\n")}\n`;
};

export const missingKeys = (m: Messenger, values: Values): string[] =>
  requiredKeys(m, values).filter((k) => !values[k]);

export type SetupDeps = {
  readonly http: Http;
  readonly api: { readonly slack: string; readonly telegram: string; readonly discord: string };
  /** Opens a Slack Socket Mode url, resolves true on the `hello` envelope and closes at once; false on error or timeout. */
  readonly socketHello: (url: string) => Promise<boolean>;
  readonly protect: (path: string) => Promise<void>;
  readonly runHook: (argv: readonly string[]) => Promise<{ code: number; out: string }>;
  /** True when the Slack listener already holds its lock: a second Socket Mode connection would take its events. */
  readonly listenerRunning: () => boolean;
  readonly now: () => number;
  readonly out: (line: string) => void;
};

export type SetupOptions = {
  readonly messenger: Messenger;
  readonly envPath: string;
  readonly cursorPath: string;
  readonly input: Values;
  readonly dryRun: boolean;
  readonly noSocket: boolean;
  readonly autostart?: readonly string[] | undefined;
  readonly listenerScript: string;
};

export type SetupResult = { readonly code: 0 | 1 | 2; readonly values: Values; readonly missing: readonly string[] };

/** Writes a secret file through a temp file in the same folder and renames it over the target. */
export const writeSecretFile = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};
