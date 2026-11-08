import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { catchUp } from "./catchup";

const TOKEN = "xoxb-FAKE-test-token-0000";
const OWNER = "UOWNER";

type Call = {
  method: string;
  params: Record<string, string>;
  auth: string | null;
  ctype: string | null;
  httpMethod: string;
};
type Handler = (method: string, p: Record<string, string>) => unknown;

function fakeFetch(handler: Handler, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    calls.push({
      method,
      params,
      auth: init.headers.Authorization ?? null,
      ctype: init.headers["Content-Type"] ?? null,
      httpMethod: init.method,
    });
    return new Response(JSON.stringify(handler(method, params)));
  }) as typeof fetch;
}

const ok = (messages: unknown[], next = "") => ({ ok: true, messages, response_metadata: { next_cursor: next } });

let logs: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => {
  spy.mockRestore();
  expect(logs.every((l) => !l.includes(TOKEN))).toBe(true);
});

test("empty cursors makes no calls and returns []", async () => {
  const calls: Call[] = [];
  const out = await catchUp({ token: TOKEN, cursors: {}, owner: OWNER, fetchImpl: fakeFetch(() => ok([]), calls) });
  expect(out).toEqual([]);
  expect(calls.length).toBe(0);
});

test("request shape: POST form-encoded with bearer token and history params", async () => {
  const calls: Call[] = [];
  await catchUp({
    token: TOKEN,
    cursors: { C1: "100.000001" },
    owner: OWNER,
    fetchImpl: fakeFetch(() => ok([]), calls),
  });
  expect(calls[0]).toEqual({
    method: "conversations.history",
    params: { channel: "C1", oldest: "100.000001", inclusive: "false", limit: "200" },
    auth: `Bearer ${TOKEN}`,
    ctype: "application/x-www-form-urlencoded",
    httpMethod: "POST",
  });
});

test("owner kept; other users and bot messages dropped", async () => {
  const h = ok([
    { ts: "101.000001", user: OWNER, text: "mine" },
    { ts: "101.000002", user: "UOTHER", text: "other" },
    { ts: "101.000003", user: OWNER, bot_id: "B1", text: "bot as owner" },
    { ts: "101.000004", bot_id: "B2", subtype: "bot_message", text: "bot" },
  ]);
  const out = await catchUp({ token: TOKEN, cursors: { C1: "100.0" }, owner: OWNER, fetchImpl: fakeFetch(() => h) });
  expect(out).toEqual([{ channel: "C1", ts: "101.000001", thread_ts: null, user: OWNER, text: "mine", files: [] }]);
});

test("subtypes: none, file_share, thread_broadcast kept; others dropped", async () => {
  const h = ok([
    { ts: "101.1", user: OWNER, text: "plain" },
    {
      ts: "101.2",
      user: OWNER,
      subtype: "file_share",
      text: "file",
      files: [{ id: "F1", name: "a.png", mimetype: "image/png", url_private: "x" }],
    },
    { ts: "101.3", user: OWNER, subtype: "thread_broadcast", thread_ts: "99.0", text: "bc" },
    { ts: "101.4", user: OWNER, subtype: "channel_join", text: "joined" },
    { ts: "101.5", user: OWNER, subtype: "message_changed", text: "edit" },
  ]);
  const out = await catchUp({ token: TOKEN, cursors: { C1: "100.0" }, owner: OWNER, fetchImpl: fakeFetch(() => h) });
  expect(out.map((m) => m.ts)).toEqual(["101.1", "101.2", "101.3"]);
  expect(out[0].subtype).toBeUndefined();
  expect(out[1]).toEqual({
    channel: "C1",
    ts: "101.2",
    thread_ts: null,
    user: OWNER,
    text: "file",
    files: [{ id: "F1", name: "a.png", mimetype: "image/png" }],
    subtype: "file_share",
  });
  expect(out[2].thread_ts).toBe("99.0");
});

test("pagination follows next_cursor and respects maxPerChannel", async () => {
  const pages: Record<string, unknown> = {
    "": ok([{ ts: "101.1", user: OWNER, text: "p1" }], "c2"),
    c2: ok([{ ts: "101.2", user: OWNER, text: "p2" }], "c3"),
    c3: ok([{ ts: "101.3", user: OWNER, text: "p3" }]),
  };
  const calls: Call[] = [];
  const out = await catchUp({
    token: TOKEN,
    cursors: { C1: "100.0" },
    owner: OWNER,
    fetchImpl: fakeFetch((_m, p) => pages[p.cursor ?? ""], calls),
  });
  expect(out.map((m) => m.text)).toEqual(["p1", "p2", "p3"]);
  expect(calls.map((c) => c.params.cursor ?? "")).toEqual(["", "c2", "c3"]);

  const calls2: Call[] = [];
  const capped = await catchUp({
    token: TOKEN,
    cursors: { C1: "100.0" },
    owner: OWNER,
    maxPerChannel: 2,
    fetchImpl: fakeFetch((_m, p) => pages[p.cursor ?? ""], calls2),
  });
  expect(capped.map((m) => m.text)).toEqual(["p1", "p2"]);
  expect(calls2.length).toBe(2);
});

test("thread replies: newer owner replies included, older and parent excluded", async () => {
  const calls: Call[] = [];
  const h: Handler = (method, p) => {
    if (method === "conversations.history")
      return ok([
        { ts: "90.0", user: "UOTHER", text: "old parent", reply_count: 3, latest_reply: "105.0", thread_ts: "90.0" },
        { ts: "80.0", user: OWNER, text: "stale thread", reply_count: 1, latest_reply: "99.0", thread_ts: "80.0" },
      ]);
    if (method === "conversations.replies" && p.ts === "90.0")
      return ok([
        { ts: "90.0", user: "UOTHER", text: "old parent", thread_ts: "90.0" },
        { ts: "95.0", user: OWNER, text: "older reply", thread_ts: "90.0" },
        { ts: "100.0", user: OWNER, text: "equal to cursor", thread_ts: "90.0" },
        { ts: "104.0", user: "UOTHER", text: "other reply", thread_ts: "90.0" },
        { ts: "105.0", user: OWNER, text: "new reply", thread_ts: "90.0" },
      ]);
    throw new Error(`unexpected ${method} ${JSON.stringify(p)}`);
  };
  const out = await catchUp({ token: TOKEN, cursors: { C1: "100.0" }, owner: OWNER, fetchImpl: fakeFetch(h, calls) });
  expect(out).toEqual([{ channel: "C1", ts: "105.0", thread_ts: "90.0", user: OWNER, text: "new reply", files: [] }]);
  const rep = calls.filter((c) => c.method === "conversations.replies");
  expect(rep.length).toBe(1);
  expect(rep[0].params).toMatchObject({ channel: "C1", ts: "90.0", oldest: "100.0" });
});

test("dedupe: broadcast seen in history and replies appears once", async () => {
  const bc = { ts: "102.0", user: OWNER, subtype: "thread_broadcast", thread_ts: "101.0", text: "bc" };
  const h: Handler = (method) =>
    method === "conversations.history"
      ? ok([
          bc,
          { ts: "101.0", user: OWNER, text: "parent", reply_count: 1, latest_reply: "102.0", thread_ts: "101.0" },
        ])
      : ok([{ ts: "101.0", user: OWNER, text: "parent", thread_ts: "101.0" }, bc]);
  const out = await catchUp({ token: TOKEN, cursors: { C1: "100.0" }, owner: OWNER, fetchImpl: fakeFetch(h) });
  expect(out.map((m) => m.ts)).toEqual(["101.0", "102.0"]);
});

test("ordering across channels uses exact ts comparison incl. equal integer parts", async () => {
  const data: Record<string, unknown[]> = {
    CA: [
      { ts: "1792887045.123457", user: OWNER, text: "a2" },
      { ts: "1792887045.000009", user: OWNER, text: "a1" },
    ],
    CB: [
      { ts: "1792887045.123456", user: OWNER, text: "b1" },
      { ts: "1792887046.000000", user: OWNER, text: "b2" },
      { ts: "999999999.999999", user: OWNER, text: "b0" },
    ],
  };
  // cursors chosen so float parsing would wrongly treat 1792887045.123456 vs .123457 as close; exactness matters
  const out = await catchUp({
    token: TOKEN,
    cursors: { CA: "1792887045.000001", CB: "999999999.000001" },
    owner: OWNER,
    fetchImpl: fakeFetch((_m, p) => ok(data[p.channel])),
  });
  expect(out.map((m) => m.text)).toEqual(["b0", "a1", "b1", "a2", "b2"]);
});

test("ok:false for one channel logs once and skips it; others continue", async () => {
  const h: Handler = (_m, p) =>
    p.channel === "CBAD" ? { ok: false, error: "channel_not_found" } : ok([{ ts: "101.0", user: OWNER, text: "good" }]);
  const out = await catchUp({
    token: TOKEN,
    cursors: { CBAD: "100.0", CGOOD: "100.0" },
    owner: OWNER,
    fetchImpl: fakeFetch(h),
  });
  expect(out.map((m) => m.channel)).toEqual(["CGOOD"]);
  expect(logs.length).toBe(1);
  expect(logs[0].startsWith("CATCHUP_ERROR CBAD ")).toBe(true);
  expect(logs[0]).toContain("channel_not_found");
});

test("network throw for one channel logs once (token redacted) and skips it", async () => {
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const p = Object.fromEntries(new URLSearchParams(String(init?.body)));
    if (p.channel === "CNET") throw new Error(`connect failed with header Bearer ${TOKEN}`);
    return new Response(JSON.stringify(ok([{ ts: "101.0", user: OWNER, text: "good" }])));
  }) as typeof fetch;
  const out = await catchUp({ token: TOKEN, cursors: { CNET: "100.0", CGOOD: "100.0" }, owner: OWNER, fetchImpl: f });
  expect(out.map((m) => m.channel)).toEqual(["CGOOD"]);
  expect(logs.length).toBe(1);
  expect(logs[0].startsWith("CATCHUP_ERROR CNET ")).toBe(true);
  expect(logs[0]).not.toContain(TOKEN);
});

test("replies failure skips the whole channel", async () => {
  const h: Handler = (method) =>
    method === "conversations.history"
      ? ok([{ ts: "101.0", user: OWNER, text: "p", reply_count: 1, latest_reply: "102.0" }])
      : { ok: false, error: "ratelimited" };
  const out = await catchUp({ token: TOKEN, cursors: { C1: "100.0" }, owner: OWNER, fetchImpl: fakeFetch(h) });
  expect(out).toEqual([]);
  expect(logs).toEqual(["CATCHUP_ERROR C1 conversations.replies ratelimited"]);
});

test("agents: listed agent kept incl. bot_id and bot_message; unlisted bots and other subtypes dropped; no agents option keeps none", async () => {
  const h = ok([
    { ts: "101.000001", user: "UAGENT", bot_id: "B1", text: "a" },
    { ts: "101.000002", user: "UAGENT", bot_id: "B1", subtype: "bot_message", text: "b" },
    { ts: "101.000003", user: "UROGUE", bot_id: "B2", text: "c" },
    { ts: "101.000004", user: "UAGENT", subtype: "channel_join", text: "d" },
  ]);
  const out = await catchUp({
    token: TOKEN,
    cursors: { C1: "100.0" },
    owner: OWNER,
    agents: ["UAGENT"],
    fetchImpl: fakeFetch(() => h),
  });
  expect(out.map((m) => m.ts)).toEqual(["101.000001", "101.000002"]);
  expect(
    await catchUp({ token: TOKEN, cursors: { C1: "100.0" }, owner: OWNER, fetchImpl: fakeFetch(() => h) }),
  ).toEqual([]);
});
