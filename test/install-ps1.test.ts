import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

// The same scenarios as install.test.ts, against install.ps1 on Windows; a stub `bun` stands in for `bun install` and `bun link`.
const script = resolve(import.meta.dir, "../install.ps1");
const gitEnv: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "NUL",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...argv: string[]): string => {
  const r = Bun.spawnSync(["git", ...argv], { cwd, env: { ...process.env, ...gitEnv } });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const shells = [
  ["pwsh", Bun.which("pwsh")],
  ["powershell", Bun.which("powershell")],
] as const;

function setup(shell: string) {
  const root = mkdtempSync(join(tmpdir(), "dori-install-ps1-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const src = join(root, "src");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const cli = "skills/dori-mode/scripts/src/cli.ts";
  mkdirSync(join(upstream, "skills/dori-mode/scripts/src"), { recursive: true });
  mkdirSync(join(upstream, "skills/dori-mode/references"), { recursive: true });
  writeFileSync(join(upstream, cli), "v1\n");
  writeFileSync(join(upstream, "skills/dori-mode/references/config.example.json"), "{}\n");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "v1");
  git(root, "clone", "-q", upstream, src);
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "bun.cmd"), "@exit /b 0\r\n");
  writeFileSync(join(bin, "hc.cmd"), "@exit /b 0\r\n");
  const upstreamCommit = (text: string) => {
    writeFileSync(join(upstream, cli), text);
    git(upstream, "commit", "-qam", text.trim());
  };
  // path: the whole PATH, for the tests about a missing prerequisite; by default the stubs come first on the real PATH.
  const install = (
    env: Record<string, string> = {},
    path = `${bin}${delimiter}${process.env["Path"] ?? process.env["PATH"] ?? ""}`,
  ) => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k.toLowerCase() !== "path" && !k.startsWith("DORI_")) base[k] = v;
    const exe = Bun.which(shell) as string;
    const r = Bun.spawnSync([exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      env: {
        ...base,
        ...gitEnv,
        Path: path,
        USERPROFILE: home,
        HOME: home,
        DORI_SRC: src,
        SKILLS_DIR: join(home, "skills"),
        DORI_RUNTIME: "hc",
        DORI_SKIP_PROFILE: "1",
        DORI_NO_USER_ENV: "1",
        DORI_NO_TASK: "1",
        ...env,
      },
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  return { root, upstream, src, home, bin, cli, upstreamCommit, install };
}

describe.skipIf(process.platform !== "win32")("install.ps1", () => {
  for (const [name, exe] of shells) {
    // Every scenario runs under pwsh 7 and under Windows PowerShell 5.1 (native stderr under 'Stop' behaves differently there).
    // One installer run took up to 7 s on a loaded 4-core PC, past bun's 5 s default; each test gets 15 s per run it makes.
    const t = (title: string, fn: () => void, installs = 1) => (exe ? test : test.skip)(title, fn, installs * 30_000);

    t(`${name}: a second install over a clean checkout pulls upstream`, () => {
      const { upstream, src, upstreamCommit, install } = setup(name);
      upstreamCommit("v2\n");
      const r = install();
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    });

    t(`${name}: a local change in the way of the pull stops the install, names the file and says how to go on`, () => {
      const { src, cli, upstreamCommit, install } = setup(name);
      upstreamCommit("v2\n");
      writeFileSync(join(src, cli), "patched\n");
      const r = install();
      expect(r.code).toBe(1);
      expect(r.err).toContain(cli);
      expect(r.err).toContain("DORI_NO_PULL=1");
      expect(r.err).toContain("reset --hard");
      expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
    });

    t(`${name}: DORI_NO_PULL=1 installs a changed checkout as it is, without pulling`, () => {
      const { src, home, cli, upstreamCommit, install } = setup(name);
      const before = git(src, "rev-parse", "HEAD");
      upstreamCommit("v2\n");
      writeFileSync(join(src, cli), "patched\n");
      const r = install({ DORI_NO_PULL: "1" });
      expect(r.code).toBe(0);
      expect(r.err).toContain("DORI_NO_PULL=1");
      expect(git(src, "rev-parse", "HEAD")).toBe(before);
      expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
      expect(existsSync(join(home, ".dori/config.json"))).toBe(true);
    });

    t(`${name}: a pull blocked by a local commit lists that commit and how to go on`, () => {
      const { src, cli, upstreamCommit, install } = setup(name);
      upstreamCommit("v2\n");
      writeFileSync(join(src, cli), "local fix\n");
      git(src, "commit", "-qam", "local fix");
      const r = install();
      expect(r.code).toBe(1);
      expect(r.err).toContain("local fix");
      expect(r.err).toContain("DORI_NO_PULL=1");
    });

    t(
      `${name}: DORI_NO_PULL=true and DORI_NO_PULL=yes skip the pull; DORI_NO_PULL=0 still pulls`,
      () => {
        const { upstream, src, upstreamCommit, install } = setup(name);
        const before = git(src, "rev-parse", "HEAD");
        upstreamCommit("v2\n");
        for (const value of ["true", "yes"]) {
          expect(install({ DORI_NO_PULL: value }).code).toBe(0);
          expect(git(src, "rev-parse", "HEAD")).toBe(before);
        }
        expect(install({ DORI_NO_PULL: "0" }).code).toBe(0);
        expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
      },
      3,
    );

    t(`${name}: a branch with no upstream is not taken for local work: git's reason, no reset suggested`, () => {
      const { src, cli, install } = setup(name);
      writeFileSync(join(src, cli), "patched\n");
      git(src, "branch", "--unset-upstream");
      const r = install();
      expect(r.code).toBe(1);
      expect(r.err).toContain("git's message above says why");
      expect(r.err).not.toContain("reset --hard");
      expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
    });

    // git and the shell only: no bun, hc or herdr, whatever the host has installed.
    const bare = () => {
      const sys = process.env["SystemRoot"] ?? "C:\\Windows";
      return [
        dirname(Bun.which("git") as string),
        join(sys, "System32"),
        join(sys, "System32", "WindowsPowerShell", "v1.0"),
      ];
    };
    const nothingInstalled = (home: string) => expect(existsSync(join(home, ".dori"))).toBe(false);

    t(`${name}: a missing bun stops the install with its link and installs nothing`, () => {
      const { home, install } = setup(name);
      const r = install({}, bare().join(delimiter));
      expect(r.code).toBe(1);
      expect(r.err).toContain("bun is required: https://bun.sh");
      nothingInstalled(home);
    });

    t(`${name}: the configured runtime missing stops the install with its link; herdr is never installed`, () => {
      const { home, bin, install } = setup(name);
      const r = install({ DORI_RUNTIME: "herdr" }, [bin, ...bare()].join(delimiter));
      expect(r.code).toBe(1);
      expect(r.err).toContain("herdr is required for runtime herdr: https://herdr.dev");
      nothingInstalled(home);
    });

    t(`${name}: no runtime set and none on PATH says how to pick hc or herdr`, () => {
      const { home, root, install } = setup(name);
      const onlyBun = join(root, "only-bun");
      mkdirSync(onlyBun);
      writeFileSync(join(onlyBun, "bun.cmd"), "@exit /b 0\r\n");
      const r = install({ DORI_RUNTIME: "" }, [onlyBun, ...bare()].join(delimiter));
      expect(r.code).toBe(1);
      expect(r.err).toContain("DORI_RUNTIME='hc'");
      expect(r.err).toContain("DORI_RUNTIME='herdr'");
      nothingInstalled(home);
    });

    t(`${name}: a failed fetch is not taken for local work: no reset is suggested`, () => {
      const { root, src, cli, install } = setup(name);
      writeFileSync(join(src, cli), "patched\n");
      git(src, "remote", "set-url", "origin", join(root, "missing.git"));
      const r = install();
      expect(r.code).toBe(1);
      expect(r.err).toContain("missing.git");
      expect(r.err).not.toContain("reset --hard");
    });
  }
});
