#!/usr/bin/env bun
/**
 * Path / identity guard: fails when a tracked file contains a hard-coded user path, a fixed
 * install root, a personal email address, or one of the maintainer's personal values (ids, names).
 *
 * Personal values are stored only as salted SHA-256 prefixes, so this file does not leak them.
 * Add your own plain values locally with DORI_GUARD_DENY="a,b,c" or a git-ignored
 * `.guard-deny` file (one value per line); `--hash <value>` prints the line to add to DENY_HASHES.
 *
 * Usage: bun scripts/check-paths.ts [--hash <value>] [files...]
 * With no files it scans `git ls-files -co --exclude-standard` from the repo root.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SALT = "win-dori-guard-v1:";
const DENY_HASHES = new Set([
  "067fb21bcc06d8df3198", "3ebcc1f234aba7dcacb2", "5a0d675ef582e6de7768", "5b5bdb0d715819ed0c41",
  "82bb389303570addc0ec", "879f0697262083924885", "94a7e53438bf1bbb7c6f", "abfc54a8ec00f3ab058e",
  "b65fe1aad511380cda75", "b718ab2522e4ee2e3414", "bf666283bf01e6a6b696", "c9713ed0712e0570270f",
  "caafe4e8103a8efcbfdf", "eac2ed11eb3c3683b14c", "f01a4bc1bcdd0850c0ea", "f0cfd6c0b25b8c97a8be",
  "fb8f0fc4a87d6dfc8779",
]);
/** Ordinary words that contain a denied Hangul substring; removed before the substring scan. */
const HANGUL_ALLOW = ["메모리"];
// The guard's own test plants each pattern on purpose.
const SKIP = [/(^|\/)bun\.lock$/, /\.(png|jpe?g|gif|webp|ico)$/i, /^test\/check-paths\.test\.ts$/];

const RULES: { name: string; re: RegExp }[] = [
  // C:\Users\<name>\... (placeholders like <you>, %USERNAME%, $env:USERNAME are fine)
  { name: "user-home-path", re: /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+(?![<%${]|Public\b|Default\b|ana\b|bob\b|me\b|u\b|x\b|a b\b|test\b)[^\\/\s"'`)]+/i },
  { name: "user-home-path", re: /(?<![\w.$:])\/(?:home|Users)\/(?![<$%{]|runner\b|dori\b|ana\b|bob\b|me\b|test\b|a\b|a b\b)[a-z][\w.-]*/ },
  // a fixed install root: a top-level dev folder on a drive, in Windows or Git Bash spelling
  { name: "fixed-install-root", re: /\b[A-Za-z]:(?:\\\\|\\|\/)+dev(?:\\\\|\\|\/)/i },
  { name: "fixed-install-root", re: /(?<![\w.])\/[a-z]\/dev\//i },
  // a personal mailbox (example.com, noreply and local test addresses are fine)
  { name: "personal-email", re: /[\w.+-]+@(?:gmail|googlemail|naver|daum|hanmail|kakao|hotmail|outlook|live|icloud|me|yahoo|proton(?:mail)?)\.[a-z.]+/i },
];

export function hashValue(v: string): string {
  return new Bun.CryptoHasher("sha256").update(SALT + v.toLowerCase()).digest("hex").slice(0, 20);
}

function localDeny(root: string): Set<string> {
  const out = new Set<string>();
  const add = (v: string) => v.trim() && out.add(hashValue(v.trim()));
  for (const v of (process.env.DORI_GUARD_DENY ?? "").split(",")) add(v);
  const f = join(root, ".guard-deny");
  if (existsSync(f)) for (const v of readFileSync(f, "utf8").split(/\r?\n/)) if (!v.startsWith("#")) add(v);
  return out;
}

/** Candidate tokens of one line: alnum runs and their camelCase parts, Hangul substrings. */
export function tokens(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/[A-Za-z0-9]+/g)) {
    const w = m[0];
    out.push(w);
    for (const p of w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)) if (p !== w) out.push(p);
  }
  let hangul = line;
  for (const a of HANGUL_ALLOW) hangul = hangul.split(a).join(" ");
  for (const m of hangul.matchAll(/[\uAC00-\uD7A3]+/g)) {
    const run = m[0];
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
  }
  return out;
}

export interface Hit { file: string; line: number; rule: string; sample: string }

const mask = (s: string) => (s.length <= 2 ? "*".repeat(s.length) : s[0] + "*".repeat(s.length - 2) + s[s.length - 1]);

export function scanText(file: string, text: string, deny: Set<string> = DENY_HASHES): Hit[] {
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((ln, i) => {
    for (const r of RULES) {
      const m = ln.match(r.re);
      if (m) hits.push({ file, line: i + 1, rule: r.name, sample: r.name === "personal-email" ? mask(m[0]) : m[0] });
    }
    for (const t of tokens(ln)) {
      if (deny.has(hashValue(t))) {
        hits.push({ file, line: i + 1, rule: "personal-value", sample: mask(t) });
        break;
      }
    }
  });
  return hits;
}

async function listFiles(root: string): Promise<string[]> {
  const p = Bun.spawn(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error("git ls-files failed: " + (await new Response(p.stderr).text()));
  return out.split("\0").filter(Boolean);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--hash") {
    if (!args[1]) throw new Error("usage: --hash <value>");
    console.log(`"${hashValue(args[1])}",`);
    process.exit(0);
  }
  const root = resolve(import.meta.dir, "..");
  const deny = new Set([...DENY_HASHES, ...localDeny(root)]);
  const files = args.length ? args.map((a) => relative(root, resolve(a)).replaceAll("\\", "/")) : await listFiles(root);
  const hits: Hit[] = [];
  let scanned = 0;
  for (const f of files) {
    if (SKIP.some((re) => re.test(f))) continue;
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue;
    scanned++;
    hits.push(...scanText(f, buf.toString("utf8"), deny));
  }
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.rule}: ${h.sample}`);
  console.log(hits.length ? `check-paths: FAIL (${hits.length} hits in ${scanned} files)` : `check-paths: OK (${scanned} files)`);
  process.exit(hits.length ? 1 : 0);
}
