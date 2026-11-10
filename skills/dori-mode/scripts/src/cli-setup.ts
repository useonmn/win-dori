/** win-dori: dori setup, the owner-only token files for Slack, Telegram and Discord, and the Aside check. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type Cli, type Command, die } from "./cli-context.ts";
import { envFilePath, expandHome, fill } from "./config.ts";
import { pidAlive } from "./heavy-slot.ts";
import { fetchHttp } from "./messenger/http.ts";
import { resolveCommand, run } from "./run.ts";
import { detectAside, protectOwnerOnly, realSocketHello, setupTemplate } from "./setup-platform.ts";
import {
  KEYS,
  maskValue,
  type Messenger,
  MESSENGERS,
  missingKeys,
  parseEnvText,
  parseSetupInput,
  requiredKeys,
  SECRET_KEYS,
  scrubTokens,
} from "./setup-env.ts";
import { setupMessenger } from "./setup.ts";

const USAGE =
  "usage: dori setup <slack|telegram|discord> [--prepare [--no-open] | --check | --from FILE | --stdin | --from-command -- CMD ...] [--set KEY=VALUE ...] [--dry-run] [--no-socket]; dori setup aside";

const prepare = async (m: Messenger, doriDir: string, noOpen: boolean): Promise<void> => {
  const file = join(doriDir, `${m}-setup.txt`);
  mkdirSync(doriDir, { recursive: true });
  const pasted = existsSync(file) && Object.keys(parseSetupInput(readFileSync(file, "utf8"), m).values).length > 0;
  if (!pasted) writeFileSync(file, setupTemplate(m), { mode: 0o600 });
  await protectOwnerOnly(run)(file);
  console.log(`PREPARED ${file} (only this user can read it)`);
  if (!noOpen && process.platform === "win32") {
    Bun.spawn(["notepad.exe", file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    console.log("OPENED   in Notepad");
  }
  console.log(`NEXT     when the owner has saved it: dori setup ${m} --from "${file}"`);
};

const check = (m: Messenger, envPath: string): never => {
  const have = existsSync(envPath) ? parseEnvText(readFileSync(envPath, "utf8")) : {};
  for (const k of requiredKeys(m, have)) {
    const value = have[k];
    console.log(`${value ? "HAVE   " : "MISSING"} ${k}${value ? ` ${maskValue(k, value)}` : ""}`);
  }
  const missing = missingKeys(m, have);
  console.log(missing.length ? `ENV_INCOMPLETE ${envPath} missing: ${missing.join(", ")}` : `ENV_COMPLETE ${envPath}`);
  return process.exit(missing.length ? 2 : 0);
};

/** The pasted text: the output of --from-command, stdin, or the --from file; empty when none was given. */
const inputText = async (rest: readonly string[], stdin: boolean, fromPath: string | undefined): Promise<string> => {
  const sep = rest.indexOf("--");
  const fromCommand = sep >= 0 ? rest.slice(sep + 1) : [];
  if (fromCommand.length) {
    const launch = resolveCommand(fromCommand);
    const resolved = "refused" in launch ? die(launch.refused, 126) : launch;
    const child = Bun.spawn([...resolved.argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsVerbatimArguments: resolved.verbatim,
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    for (const l of err
      .split(/\r?\n/)
      .filter((x) => x.trim())
      .slice(-20))
      console.log(scrubTokens(`COMMAND  ${l.trim()}`).slice(0, 300));
    if (code !== 0) die(`FROM_COMMAND_FAILED exit ${code}; its output was not used`);
    return out;
  }
  if (stdin) return await Bun.stdin.text();
  return fromPath ? readFileSync(fromPath, "utf8") : "";
};

const setValues = (m: Messenger, pairs: readonly string[]): Record<string, string> => {
  const sets: Record<string, string> = {};
  for (const kv of pairs) {
    const i = kv.indexOf("=");
    const k = i > 0 ? kv.slice(0, i).trim() : "";
    if (SECRET_KEYS.has(k))
      die(`${k} is never taken from the command line; use --from FILE, --stdin or --from-command`);
    if (!KEYS[m].includes(k))
      die(`--set takes KEY=VALUE with KEY one of ${KEYS[m].filter((x) => !SECRET_KEYS.has(x)).join(", ")}`);
    sets[k] = kv.slice(i + 1).trim();
  }
  return sets;
};

const write = async (cli: Cli, m: Messenger, envPath: string): Promise<never> => {
  const { opt, values, strings, rest, config } = cli;
  const doriDir = dirname(envPath);
  const from = opt("from");
  const fromPath = from ? expandHome(from) : undefined;
  if (fromPath && !existsSync(fromPath)) die(`no file ${fromPath}`);
  const parsed = parseSetupInput(await inputText(rest, Boolean(values["stdin"]), fromPath), m);
  for (const n of parsed.ignoredLines)
    console.log(`IGNORED  input line ${n} (not KEY=VALUE and no token; its content is not shown)`);
  const sets = setValues(m, strings("set"));
  const dryRun = Boolean(values["dry-run"]);
  const src = resolve(import.meta.dir, "..", "..", "..", "..");
  const lock = join(config.stateDir, "inbound.lock");
  const listener = join(doriDir, "inbound-next", "run-inbound.ts").replace(/\\/g, "/");
  const home = homedir().replace(/\\/g, "/");
  const result = await setupMessenger(
    {
      http: fetchHttp,
      api: {
        slack: process.env["DORI_SLACK_API"] ?? "https://slack.com/api",
        telegram: process.env["DORI_TELEGRAM_API"] ?? "https://api.telegram.org",
        discord: process.env["DORI_DISCORD_API"] ?? "https://discord.com/api/v10",
      },
      socketHello: (url) => realSocketHello(url),
      protect: protectOwnerOnly(run),
      runHook: async (argv) => {
        const r = await run(argv);
        return { code: r.code, out: `${r.out}\n${r.err}` };
      },
      listenerRunning: () => existsSync(lock) && pidAlive(Number.parseInt(readFileSync(lock, "utf8").trim(), 10)),
      now: () => Date.now(),
      out: (l) => console.log(l),
    },
    {
      messenger: m,
      envPath,
      cursorPath: join(config.stateDir, "inbound-cursor.json"),
      input: { ...parsed.values, ...sets },
      dryRun,
      noSocket: Boolean(values["no-socket"]),
      autostart: config.hooks.autostart ? fill(config.hooks.autostart, { src, home: homedir() }) : undefined,
      listenerScript: listener.toLowerCase().startsWith(home.toLowerCase())
        ? `~${listener.slice(home.length)}`
        : listener,
    },
  );
  const savedTokens =
    !dryRun &&
    result.code !== 1 &&
    Object.keys(parsed.values).some((k) => SECRET_KEYS.has(k) && result.values[k] === parsed.values[k]);
  if (fromPath && savedTokens) {
    rmSync(fromPath, { force: true });
    console.log(`REMOVED  ${fromPath} (the tokens now live only in ${m}.env)`);
  } else if (fromPath && !dryRun) console.log(`KEPT     ${fromPath} (fix it and run again)`);
  return process.exit(result.code);
};

const setup: Command = async (cli) => {
  const { key, values } = cli;
  if (key === "aside") {
    const st = await detectAside(run);
    for (const l of st.lines) console.log(l);
    process.exit(st.ready ? 0 : 3);
  }
  if (!(MESSENGERS as readonly string[]).includes(key ?? "")) die(USAGE);
  const m = key as Messenger;
  const envPath = envFilePath(homedir(), m);
  if (values["prepare"]) return await prepare(m, dirname(envPath), Boolean(values["no-open"]));
  if (values["check"]) check(m, envPath);
  await write(cli, m, envPath);
};

export const setupCommands: Readonly<Record<string, Command>> = { setup };
