import { expect, test } from "bun:test";
import { hashValue, scanText } from "../scripts/check-paths.ts";

const rules = (text: string, deny = new Set<string>()) => scanText("f", text, deny).map((h) => h.rule);

test("a real user home or a fixed dev root fails; placeholders and neutral roots pass", () => {
  expect(rules('const p = "C:\\\\Users\\\\jdoe\\\\repo";')).toEqual(["user-home-path"]);
  expect(rules("cd /home/jdoe/src")).toEqual(["user-home-path"]);
  expect(rules("git clone x C:\\dev\\thing")).toEqual(["fixed-install-root"]);
  expect(rules("cd /c/dev/thing")).toEqual(["fixed-install-root"]);
  expect(rules("C:\\Users\\<you>\\.dori, %USERPROFILE%, /home/runner/work, D:\\code\\dori, /home/dori/.omo")).toEqual(
    [],
  );
});

test("a personal mailbox fails and is masked; example and noreply addresses pass", () => {
  const hits = scanText("f", "author jdoe@gmail.com", new Set());
  expect(hits.map((h) => [h.rule, h.sample])).toEqual([["personal-email", `j${"*".repeat(12)}m`]]);
  expect(rules("a@example.com 1+x@users.noreply.github.com omo@local")).toEqual([]);
});

test("a denied value fails as a whole token or Hangul substring, never inside an allowed word", () => {
  const deny = new Set([hashValue("zork"), hashValue("메모")]);
  expect(rules("owner: Zork", deny)).toEqual(["personal-value"]);
  expect(rules("id zorkBot", deny)).toEqual(["personal-value"]);
  expect(rules("안녕 메모야", deny)).toEqual(["personal-value"]);
  expect(rules("zorkish 메모리", deny)).toEqual([]);
});
