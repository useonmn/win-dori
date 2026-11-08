import { expect, test } from "bun:test";
import { join } from "node:path";

import { baseName, expandHome, pathKey, samePath, scrubLocalPaths } from "../src/paths.ts";

test("~ expands with either separator", () => {
  expect(expandHome("~", "/h")).toBe("/h");
  expect(expandHome("~/a/b", "/h")).toBe(join("/h", "a/b"));
  expect(expandHome("~\\a", "/h")).toBe(join("/h", "a"));
  expect(expandHome("C:\\x", "/h")).toBe("C:\\x");
});

test("git's forward-slash paths and Windows backslash paths compare equal on Windows, case-insensitively", () => {
  expect(samePath("C:/Repo/app/", "c:\\repo\\APP", true)).toBe(true);
  expect(samePath("\\\\?\\C:\\repo", "C:/repo", true)).toBe(true);
  expect(samePath("/Repo", "/repo", false)).toBe(false);
  expect(pathKey("C:\\", true)).toBe("c:/");
  expect(baseName("C:/repo/.wt/demo-lane")).toBe("demo-lane");
  expect(baseName("C:\\repo\\.wt\\demo-lane\\")).toBe("demo-lane");
});

test("home and other local paths are scrubbed in POSIX and Windows form, URLs are left alone", () => {
  expect(scrubLocalPaths("tests green on C:\\Users\\ana\\repo, PR open", "C:\\Users\\ana")).toBe(
    "tests green on ~\\repo, PR open",
  );
  expect(scrubLocalPaths("see c:/users/ana/repo", "C:\\Users\\ana")).toBe("see ~/repo");
  expect(scrubLocalPaths("log at D:\\work\\x.log and \\\\server\\share\\f", "")).toBe(
    "log at (local path) and (local path)",
  );
  expect(scrubLocalPaths("at /home/test/repo", "/home/test")).toBe("at ~/repo");
  expect(scrubLocalPaths("at /Users/bob/x", "/home/test")).toBe("at (local path)");
  expect(scrubLocalPaths("merged https://github.com/acme/app/pull/1", "")).toBe(
    "merged https://github.com/acme/app/pull/1",
  );
  expect(scrubLocalPaths("built D:\\x\\y, then (see E:\\log.txt).", "")).toBe(
    "built (local path), then (see (local path)).",
  );
});
