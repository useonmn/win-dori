// Setup helpers tied to the host: the owner-only ACL, the Socket Mode check, the Aside browser CLI and the paste template.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { IS_WINDOWS } from "./paths.ts";
import { type Runner, systemTool } from "./run.ts";
import { APP_TOKEN, DC_TOKEN, type Messenger, TG_TOKEN, TOKEN } from "./setup-env.ts";

/** Windows: protected ACL with one FullControl entry for the current user's SID (as install-profile.ps1 does); POSIX: mode 600. */
export const protectOwnerOnly =
  (run: Runner, windows = IS_WINDOWS) =>
  async (path: string): Promise<void> => {
    if (!windows) {
      const { chmodSync } = await import("node:fs");
      chmodSync(path, 0o600);
      return;
    }
    const who = await run([systemTool("whoami"), "/user", "/fo", "csv", "/nh"]);
    const sid = /"(S-1-[\d-]+)"/.exec(who.out)?.[1];
    if (!sid) throw new Error(`could not read the current user's SID (whoami exit ${who.code})`);
    // /inheritance:r drops only inherited entries; a file created where nothing is inheritable (an elevated
    // token, a protected parent) carries the token's default DACL as explicit entries, which /reset clears first.
    const reset = await run([systemTool("icacls"), path, "/reset"]);
    if (reset.code !== 0)
      throw new Error(`icacls /reset failed on ${path} (exit ${reset.code}): ${reset.err || reset.out}`.slice(0, 300));
    const r = await run([systemTool("icacls"), path, "/inheritance:r", "/grant:r", `*${sid}:(F)`]);
    if (r.code !== 0) throw new Error(`icacls failed on ${path} (exit ${r.code}): ${r.err || r.out}`.slice(0, 300));
  };

export const realSocketHello = (url: string, timeoutMs = 10_000): Promise<boolean> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.addEventListener("message", (e) => {
      try {
        if ((JSON.parse(String(e.data)) as { type?: string }).type === "hello") finish(true);
      } catch {}
    });
    ws.addEventListener("error", () => finish(false));
    ws.addEventListener("close", () => finish(false));
  });

export type AsideStatus = {
  readonly ready: boolean;
  readonly argv?: readonly string[];
  readonly lines: readonly string[];
};

/**
 * Finds the Aside browser CLI and checks it can act for the owner: an account signed in and a connected browser
 * profile. `DORI_ASIDE` (a path, or a JSON argv such as ["bun","fake-aside.ts"]) overrides the lookup; otherwise PATH,
 * then the newest %LOCALAPPDATA%\Aside\CLI\versions\<platform>\<version>\aside.exe (the `current` junction on PATH
 * cannot always be followed by child processes).
 */
export const detectAside = async (
  run: Runner,
  env: Record<string, string | undefined> = process.env,
  which = (c: string) => Bun.which(c),
): Promise<AsideStatus> => {
  let argv: string[] | undefined;
  if (env["DORI_ASIDE"])
    argv = env["DORI_ASIDE"].startsWith("[") ? (JSON.parse(env["DORI_ASIDE"]) as string[]) : [env["DORI_ASIDE"]];
  else {
    const onPath = which("aside");
    if (onPath) argv = [onPath];
    else if (env["LOCALAPPDATA"]) {
      const base = join(env["LOCALAPPDATA"], "Aside", "CLI", "versions");
      const plat = existsSync(base) ? readdirSync(base).sort() : [];
      for (const p of plat) {
        const versions = readdirSync(join(base, p)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const exe = versions.map((v) => join(base, p, v, "aside.exe")).find((x) => existsSync(x));
        if (exe) argv = [exe];
      }
    }
  }
  if (!argv)
    return {
      ready: false,
      lines: ["ASIDE_UNAVAILABLE not installed (no aside on PATH or under %LOCALAPPDATA%\\Aside\\CLI)"],
    };
  const accounts = await run([...argv, "account", "list"]);
  const signedIn = accounts.code === 0 && /signed in/i.test(accounts.out);
  if (!signedIn)
    return {
      ready: false,
      argv,
      lines: [
        `ASIDE_UNAVAILABLE installed but no signed-in account (aside account list exit ${accounts.code}); the owner can run aside login`,
      ],
    };
  const profiles = await run([...argv, "host", "profiles"]);
  const connected = profiles.out
    .split(/\r?\n/)
    .filter((l) => /\bconnected\b/i.test(l) && !/disconnected/i.test(l)).length;
  if (profiles.code !== 0 || !connected)
    return {
      ready: false,
      argv,
      lines: [
        `ASIDE_UNAVAILABLE signed in but no connected browser profile (aside host profiles exit ${profiles.code}); is the Aside browser open?`,
      ],
    };
  return {
    ready: true,
    argv,
    lines: [
      `ASIDE_READY ${argv.join(" ")} (account signed in, ${connected} connected profile${connected === 1 ? "" : "s"})`,
    ],
  };
};

export const setupTemplate = (m: Messenger): string => {
  const how: Record<Messenger, string> = {
    slack: `# Bot token: api.slack.com/apps > your app > OAuth & Permissions > Bot User OAuth Token (xoxb-...)
# App-level token: Basic Information > App-Level Tokens, scope connections:write (xapp-...)
${TOKEN}=
${APP_TOKEN}=`,
    telegram: `# Bot token: in Telegram, @BotFather > /newbot (or /token for an existing bot)
${TG_TOKEN}=`,
    discord: `# Bot token: discord.com/developers/applications > your application > Bot > Reset Token
${DC_TOKEN}=`,
  };
  return `# Paste your Dori's ${m} token${m === "slack" ? "s" : ""} after the = sign${m === "slack" ? "s" : ""}, save (Ctrl+S) and close this window.
# Only your user can read this file. dori setup ${m} deletes it after saving the tokens to ${m}.env.
${how[m]}
`;
};
