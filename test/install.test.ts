import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// The real install.sh over a checkout of a local upstream; a stub `bun` stands in for `bun install` and `bun link`.
// On Windows it runs under Git Bash (WSL's System32 bash is not it), and is skipped when Git Bash is not installed.
const win = process.platform === "win32";
const script = resolve(import.meta.dir, "../install.sh").replaceAll("\\", "/");
const bash = win
  ? (Bun.which("bash") ??
    (existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : null))
  : "bash";
// MSYS "winsymlinks:native" makes ln -s a real symlink when Windows allows it and an MSYS symlink otherwise, so no privilege is needed.
const t = bash ? test : test.skip;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "path"));
const PATH_KEY = win ? "Path" : "PATH";
const gitEnv = {
  ...baseEnv,
  GIT_CONFIG_GLOBAL: win ? "NUL" : "/dev/null",
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
  const r = Bun.spawnSync(["git", ...argv], { cwd, env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dori-install-"));
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
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "bun"), 0o755);
  const upstreamCommit = (text: string) => {
    writeFileSync(join(upstream, cli), text);
    git(upstream, "commit", "-qam", text.trim());
  };
  const install = (env: Record<string, string> = {}) => {
    const r = Bun.spawnSync([bash as string, script], {
      env: {
        ...gitEnv,
        HOME: home,
        DORI_HOME: join(home, ".dori"),
        DORI_SRC: src,
        SKILLS_DIR: join(home, "skills"),
        [PATH_KEY]: `${bin}${delimiter}${process.env["PATH"] ?? process.env["Path"]}`,
        MSYS: "winsymlinks:native",
        ...env,
      },
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  return { root, upstream, src, home, cli, upstreamCommit, install };
}

t("a second install over a clean checkout pulls upstream", () => {
  // Given an installed checkout and a newer upstream commit.
  const { upstream, src, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  // When install.sh runs again; then it succeeds at upstream's head.
  expect(install().code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

t("a local change in the way of the pull stops the install, names the file and says how to go on", () => {
  // Given a checkout with a local edit to a file upstream has since changed.
  const { src, cli, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "patched\n");
  // When install.sh runs again.
  const r = install();
  // Then it fails, lists the changed file, and points at the way to install the checkout as it is.
  expect(r.code).toBe(1);
  expect(r.err).toContain(cli);
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
});

t("DORI_NO_PULL=1 installs a changed checkout as it is, without pulling", () => {
  // Given a checkout with a local edit and a newer upstream commit.
  const { src, home, cli, upstreamCommit, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "patched\n");
  // When install.sh runs with DORI_NO_PULL=1.
  const r = install({ DORI_NO_PULL: "1" });
  // Then the install finishes, and the checkout keeps its commit and its local edit.
  expect(r.code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
  expect(existsSync(join(home, ".dori/config.json"))).toBe(true);
});

t("a pull blocked by a local commit lists that commit and how to go on", () => {
  // Given a checkout with its own commit on a file upstream has since changed.
  const { src, cli, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "local fix\n");
  git(src, "commit", "-qam", "local fix");
  // When install.sh runs again.
  const r = install();
  // Then it fails and names the local commit, which git status alone would not show.
  expect(r.code).toBe(1);
  expect(r.err).toContain("local fix");
  expect(r.err).toContain("DORI_NO_PULL=1");
});

t(
  "DORI_NO_PULL=true and DORI_NO_PULL=yes skip the pull like DORI_NO_PULL=1; DORI_NO_PULL=0 still pulls",
  () => {
    // Given an installed checkout and a newer upstream commit.
    const { upstream, src, upstreamCommit, install } = setup();
    const before = git(src, "rev-parse", "HEAD");
    upstreamCommit("v2\n");
    // When install.sh runs with each truthy spelling; then the checkout stays at its commit.
    for (const value of ["true", "yes"]) {
      expect(install({ DORI_NO_PULL: value }).code).toBe(0);
      expect(git(src, "rev-parse", "HEAD")).toBe(before);
    }
    // And with 0 it pulls as usual.
    expect(install({ DORI_NO_PULL: "0" }).code).toBe(0);
    expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
  },
  30_000,
); // four install.sh runs under Git Bash: 4.2 s alone on Windows, over the 5 s default under load

t("a branch with no upstream is not taken for local work: git's reason, no reset suggested", () => {
  // Given a checkout with a local edit whose branch tracks nothing.
  const { src, cli, install } = setup();
  writeFileSync(join(src, cli), "patched\n");
  git(src, "branch", "--unset-upstream");
  // When install.sh runs again.
  const r = install();
  // Then it fails, says git's message is the reason, and never tells the user to reset their work away.
  expect(r.code).toBe(1);
  expect(r.err).toContain("git's message above says why");
  expect(r.err).not.toContain("reset --hard");
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
});

t("a failed fetch is not taken for local work: no reset is suggested", () => {
  // Given a checkout with a local edit whose upstream cannot be reached.
  const { root, src, cli, install } = setup();
  writeFileSync(join(src, cli), "patched\n");
  git(src, "remote", "set-url", "origin", join(root, "missing.git"));
  // When install.sh runs again.
  const r = install();
  // Then it fails with git's reason and never tells the user to reset their work away.
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing.git");
  expect(r.err).not.toContain("reset --hard");
});
