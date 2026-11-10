import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APP, BOT, cleanup, fakeHttp, platformHttp, TG, tmp, world } from "./setup-fixtures.ts";

setDefaultTimeout(30_000);
afterAll(cleanup);

test("cli: tokens are refused on the command line; --from FILE against a fake Slack API saves slack.env and deletes the file", async () => {
  const dir = tmp();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const w = world();
      return fakeHttp(w)({
        method: "POST",
        url: req.url,
        headers: { Authorization: req.headers.get("authorization") ?? "" },
        body: "",
      }).then((r) => {
        const body = JSON.parse(r.body) as Record<string, unknown>;
        if (url.pathname.endsWith("apps.connections.open") && body["ok"]) body["url"] = `ws://localhost:${srv.port}/ws`;
        if (url.pathname.endsWith("bots.info")) return Response.json({ ok: true, bot: { app_id: "A0TESTAPP" } });
        return Response.json(body);
      });
    },
    websocket: {
      open: (ws) => {
        ws.send(JSON.stringify({ type: "hello" }));
      },
      message: () => {},
    },
  });
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
    const env = {
      ...(process.env as Record<string, string>),
      DORI_ENV_FILE: join(dir, "slack.env"),
      DORI_CONFIG: join(dir, "config.json"),
      DORI_SLACK_API: `http://localhost:${server.port}/api`,
    };
    const exec = async (args: string[]) => {
      const p = Bun.spawn(["bun", cli, "setup", "slack", ...args], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };
    const refused = await exec(["--set", `DORI_SLACK_TOKEN=${BOT}`]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("never taken from the command line");

    const paste = join(dir, "slack-setup.txt");
    writeFileSync(paste, `DORI_SLACK_TOKEN=${BOT}\nDORI_SLACK_APP_TOKEN=${APP}\n`);
    const r = await exec(["--from", paste]);
    expect(r.out).toContain("Socket Mode hello received");
    expect(r.out).toContain("SETUP_COMPLETE");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(BOT);
    expect(r.out).not.toContain(APP);
    expect(existsSync(paste)).toBe(false);
    expect(readFileSync(join(dir, "slack.env"), "utf8")).toContain("DORI_SLACK_CHANNEL=CHOME1");

    const check = await exec(["--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("ENV_COMPLETE");
    expect(check.out).not.toContain(BOT);
  } finally {
    server.stop(true);
  }
});

test("cli: --from-command takes the tokens from a command's stdout (an Aside script), never shows them, and refuses a failing command", async () => {
  const dir = tmp();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      platformHttp([])({
        method: "GET",
        url: req.url.replace(/^http:\/\/localhost:\d+/, "https://fake.telegram"),
        headers: {},
      }).then((r) => new Response(r.body, { status: r.status })),
  });
  try {
    const script = join(dir, "fake-aside.ts");
    writeFileSync(
      script,
      `console.log("DORI_TELEGRAM_TOKEN=${TG}"); console.error("read token from the BotFather page ${TG}");`,
    );
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
    const env = {
      ...(process.env as Record<string, string>),
      DORI_ENV_FILE: join(dir, "telegram.env"),
      DORI_CONFIG: join(dir, "config.json"),
      DORI_TELEGRAM_API: `http://localhost:${server.port}`,
    };
    const exec = async (args: string[]) => {
      const p = Bun.spawn(["bun", cli, "setup", "telegram", ...args], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };
    const r = await exec(["--set", "DORI_TELEGRAM_OWNER=5550001", "--from-command", "--", "bun", script]);
    expect(r.out).toContain("COMMAND  read token from the BotFather page (token)");
    expect(r.out).toContain("SETUP_COMPLETE");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(TG);
    expect(readFileSync(join(dir, "telegram.env"), "utf8")).toContain(`DORI_TELEGRAM_TOKEN=${TG}`);

    writeFileSync(script, `console.log("DORI_TELEGRAM_TOKEN=${TG}"); process.exit(4);`);
    const failed = await exec(["--from-command", "--", "bun", script]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("FROM_COMMAND_FAILED exit 4");
    expect(failed.out).not.toContain(TG);
  } finally {
    server.stop(true);
  }
});
