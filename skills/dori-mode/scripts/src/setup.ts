// `dori setup <slack|telegram|discord>`: the conversational messenger setup. The Dori asks the owner only for the
// platform's tokens; this module validates them, derives every other value it can through the platform's API, and
// writes ~/.dori/<messenger>.env atomically with an owner-only ACL. Token values are never printed and never taken
// from the command line: they come from a file (`--from FILE`, deleted after saving), stdin (`--stdin`) or the stdout
// of a command (`--from-command -- ...`, e.g. an Aside browser script), which is read here and never shown.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { deriveDiscord, deriveTelegram, type Ctx } from "./setup-derive.ts";
import {
  APP_TOKEN,
  COOKIE,
  CHANNEL,
  DC_TOKEN,
  maskValue,
  type Messenger,
  missingKeys,
  parseEnvText,
  renderEnv,
  SECRET_KEYS,
  type SetupDeps,
  type SetupOptions,
  type SetupResult,
  scrubTokens,
  TG_TOKEN,
  TOKEN,
  type Values,
  writeSecretFile,
} from "./setup-env.ts";
import { deriveSlack } from "./setup-slack.ts";

const NEED_TOKEN: Record<string, string> = {
  [TOKEN]: "the bot token (xoxb-...), from the app's OAuth & Permissions page",
  [TG_TOKEN]: "the bot token from @BotFather (/newbot or /token)",
  [DC_TOKEN]: "the bot token from the Developer Portal > your application > Bot > Reset Token",
};
const MAIN_TOKEN: Record<Messenger, string> = { slack: TOKEN, telegram: TG_TOKEN, discord: DC_TOKEN };

/** Validates, derives and (unless a dry run) saves the env file. Exit code: 0 complete, 2 saved but incomplete, 1 invalid. */
export const setupMessenger = async (deps: SetupDeps, opts: SetupOptions): Promise<SetupResult> => {
  const m = opts.messenger;
  const existing = existsSync(opts.envPath) ? parseEnvText(readFileSync(opts.envPath, "utf8")) : {};
  const values: Values = { ...existing, ...opts.input };
  const say = (tag: string, key: string, rest: string) =>
    deps.out(scrubTokens(`${tag.padEnd(9)}${key.padEnd(22)}${rest}`.trimEnd()));
  deps.out(`SETUP ${m} ${opts.envPath}${opts.dryRun ? " (dry run: nothing is written)" : ""}`);

  const main = MAIN_TOKEN[m];
  if (!values[main]) {
    say("NEED", main, NEED_TOKEN[main]!);
    if (m === "slack")
      say(
        "NEED",
        APP_TOKEN,
        "with a bot token, also the app-level token (xapp-...), from Basic Information > App-Level Tokens, scope connections:write",
      );
    deps.out(`SETUP_INCOMPLETE missing: ${main} (nothing was written)`);
    return { code: 2, values: existing, missing: missingKeys(m, values) };
  }
  const ctx: Ctx = { deps, opts, values, say };
  const invalid = await (m === "slack"
    ? deriveSlack(ctx)
    : m === "telegram"
      ? deriveTelegram(ctx)
      : deriveDiscord(ctx));
  if (invalid) {
    say("INVALID", invalid.key, invalid.why);
    deps.out("SETUP_INVALID nothing was written");
    return { code: 1, values: existing, missing: missingKeys(m, existing) };
  }
  if (m === "slack" && values[TOKEN]!.startsWith("xoxc-") && !values[COOKIE]) {
    deps.out(`SETUP_INCOMPLETE missing: ${COOKIE} (nothing was written)`);
    return { code: 2, values: existing, missing: missingKeys(m, values) };
  }

  const missing = missingKeys(m, values);
  const text = renderEnv(m, values);
  const before = existsSync(opts.envPath) ? readFileSync(opts.envPath, "utf8") : undefined;
  const shown = Object.keys(values).filter((k) => values[k]);
  if (opts.dryRun)
    deps.out(
      `DRY_RUN would ${before === undefined ? "create" : before === text ? "leave unchanged" : "update"} ${opts.envPath}: ${shown.map((k) => `${k}=${maskValue(k, values[k]!)}`).join(" ")}`,
    );
  else if (before === text) {
    await deps.protect(opts.envPath);
    deps.out(`UNCHANGED ${m}.env (owner-only ACL re-applied)`);
  } else {
    writeSecretFile(opts.envPath, text);
    await deps.protect(opts.envPath);
    deps.out(`WROTE    ${opts.envPath} (only this user can read it): ${shown.join(", ")}`);
  }

  if (missing.length) {
    deps.out(
      `SETUP_INCOMPLETE missing: ${missing.join(", ")}. Ask the owner for the ids (not secret), then: dori setup ${m} ${missing.map((k) => (SECRET_KEYS.has(k) ? `--from FILE (${k})` : `--set ${k}=...`)).join(" ")}`,
    );
    return { code: 2, values, missing };
  }

  const slackBot = m === "slack" && values[TOKEN]!.startsWith("xoxb-");
  if (slackBot) {
    const cursors = existsSync(opts.cursorPath)
      ? (JSON.parse(readFileSync(opts.cursorPath, "utf8") || "{}") as Record<string, string>)
      : {};
    if (!cursors[values[CHANNEL]!]) {
      const ts = `${Math.floor(deps.now() / 1000)}.000000`;
      if (!opts.dryRun) {
        mkdirSync(dirname(opts.cursorPath), { recursive: true });
        const tmp = `${opts.cursorPath}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...cursors, [values[CHANNEL]!]: ts }));
        renameSync(tmp, opts.cursorPath);
      }
      deps.out(`${opts.dryRun ? "WOULD_SEED" : "SEEDED  "} ${opts.cursorPath} ${values[CHANNEL]}=${ts}`);
    } else deps.out(`CURSOR   ${opts.cursorPath} already has ${values[CHANNEL]}`);
  }

  if (!opts.autostart?.length)
    deps.out("AUTOSTART none configured (hooks.autostart in config.json); nothing registered");
  else if (opts.dryRun) deps.out(`AUTOSTART would run: ${opts.autostart.join(" ")}`);
  else {
    const r = await deps.runHook(opts.autostart);
    for (const l of r.out.split(/\r?\n/).filter((x) => x.trim())) deps.out(scrubTokens(`AUTOSTART ${l.trim()}`));
    deps.out(r.code === 0 ? "AUTOSTART_OK" : `AUTOSTART_FAILED exit ${r.code}`);
  }

  if (slackBot)
    deps.out(
      `MONITOR  arm one persistent monitor: command "DELIVERY=stdout bun ${opts.listenerScript}", filter ^INBOUND, persistent true, wakes_per_hour 3600, human_input true`,
    );
  else if (m === "slack")
    deps.out(
      'MONITOR  arm one persistent monitor: command "dori inbound slack --loop 1", filter ^INBOUND, persistent true, human_input true',
    );
  else
    deps.out(
      `MONITOR  arm your ${m} watch command (agent-messenger) as a persistent monitor for new owner messages; see references/setup.md, Monitors`,
    );
  deps.out(opts.dryRun ? "SETUP_COMPLETE (dry run)" : "SETUP_COMPLETE");
  return { code: 0, values, missing };
};
