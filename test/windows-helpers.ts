import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { PaneShell } from "../src/shell.ts";
import { href, World } from "./fake.ts";

export const decoded = (line: string): string => {
  const m = /^powershell -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
  if (!m) throw new Error(`not an encoded cmd line: ${line}`);
  return Buffer.from(m[1]!, "base64").toString("utf16le");
};

export function setup(shell: PaneShell = "posix") {
  const w = new World();
  const d: Deps = { ...w.deps(), shell };
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Do the thing.");
  return { w, d, lead, brief };
}
