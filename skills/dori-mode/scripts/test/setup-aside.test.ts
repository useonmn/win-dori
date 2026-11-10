import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { systemTool } from "../src/run.ts";
import { detectAside, protectOwnerOnly } from "../src/setup-platform.ts";
import { cleanup, tmp } from "./setup-fixtures.ts";

setDefaultTimeout(30_000);
afterAll(cleanup);

test("aside: ready only when installed, signed in and a browser profile is connected", async () => {
  const fake = (accounts: string, profiles: string) => async (argv: readonly string[]) => ({
    code: 0,
    out: argv.includes("account") ? accounts : profiles,
    err: "",
  });
  const env = { DORI_ASIDE: '["bun","fake-aside.ts"]' };
  expect(
    (await detectAside(fake("* u1  me@example.com  signed in  profiles: Profile 0", "6e83  Profile 0  connected"), env))
      .ready,
  ).toBe(true);
  const noLogin = await detectAside(fake("no accounts", "x  connected"), env);
  expect(noLogin.ready).toBe(false);
  expect(noLogin.lines[0]).toContain("no signed-in account");
  const noProfile = await detectAside(fake("* u1  signed in", "6e83  Profile 0  disconnected"), env);
  expect(noProfile.ready).toBe(false);
  expect(noProfile.lines[0]).toContain("no connected browser profile");
  const missing = await detectAside(fake("", ""), { LOCALAPPDATA: tmp() }, () => null);
  expect(missing.ready).toBe(false);
  expect(missing.lines[0]).toContain("not installed");
  const local = tmp();
  for (const v of ["1.26.1020.1855", "1.26.1023.1115", "1.26.1022.0"]) {
    const d = join(local, "Aside", "CLI", "versions", "win-x64", v);
    require("node:fs").mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "aside.exe"), "");
  }
  const found = await detectAside(fake("* u1  signed in", "a  connected"), { LOCALAPPDATA: local }, () => null);
  expect(found.argv).toEqual([join(local, "Aside", "CLI", "versions", "win-x64", "1.26.1023.1115", "aside.exe")]);
});

test("protectOwnerOnly calls whoami and icacls by absolute System32 path, so Git Bash's /usr/bin/whoami cannot shadow them", async () => {
  const seen: string[][] = [];
  const fake = async (argv: readonly string[]) => {
    seen.push([...argv]);
    return {
      code: 0,
      out: argv[0]?.toLowerCase().endsWith("whoami.exe") ? '"host\\user","S-1-5-21-1-2-3-1001"' : "",
      err: "",
    };
  };
  await protectOwnerOnly(fake, true)("C:\\x\\a.env");
  expect(seen.map((a) => a[0])).toEqual([systemTool("whoami"), systemTool("icacls"), systemTool("icacls")]);
  expect(seen[1]?.slice(1)).toEqual(["C:\\x\\a.env", "/reset"]);
  expect(seen[2]?.[4]).toBe("*S-1-5-21-1-2-3-1001:(F)");
});
