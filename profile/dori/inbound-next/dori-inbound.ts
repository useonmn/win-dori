// Dori Slack inbound: Socket Mode -> one INBOUND line per owner message, eyes reaction as read receipt, working status until the bot replies.
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { catchUp, type SlackMsg } from "./catchup.ts";
const HOME = homedir();
// agent-messenger is a bun global package (bun add -g agent-messenger); DORI_AGENT_MESSENGER overrides its folder.
const MESSENGER = process.env.DORI_AGENT_MESSENGER ?? join(process.env.BUN_INSTALL ?? join(HOME, ".bun"), "install", "global", "node_modules", "agent-messenger");
// Test seams (system boundary only): fake Slack events / history, fake herdr binary, temp config and state dirs.
const FAKE_EVENTS = process.env.DORI_INBOUND_FAKE_EVENTS, FAKE_HISTORY = process.env.DORI_INBOUND_FAKE_HISTORY;
// DORI_HERDR: an executable path, or a JSON argv array such as ["bun","fake-herdr.ts"] (tests).
const HERDR: string[] = process.env.DORI_HERDR?.startsWith('[') ? JSON.parse(process.env.DORI_HERDR) : [process.env.DORI_HERDR ?? 'herdr'];
const CONFIG = process.env.DORI_CONFIG ?? `${HOME}/.dori/config.json`;
const STATE_DIR = process.env.DORI_INBOUND_STATE_DIR ?? `${HOME}/.dori/state`;
const CURSOR_FILE = `${STATE_DIR}/inbound-cursor.json`, SPILL_DIR = `${STATE_DIR}/inbound`;
const envFile = Bun.file(`${HOME}/.dori/slack.env`);
if (!FAKE_EVENTS && await envFile.exists()) for (const l of (await envFile.text()).split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i)] = l.slice(i + 1); } // slack.env wins over inherited (possibly stale) env
const OWNER = process.env.DORI_SLACK_OWNER ?? '';
const BOT_USER = process.env.DORI_SLACK_BOT_USER ?? '';
if (!FAKE_EVENTS && (!OWNER || !BOT_USER)) { console.log('INBOUND_ERROR missing DORI_SLACK_OWNER or DORI_SLACK_BOT_USER (set them in ~/.dori/slack.env)'); process.exit(1); }
const token = FAKE_EVENTS ? 'fake-token' : process.env.DORI_SLACK_TOKEN, appToken = FAKE_EVENTS ? 'fake-app-token' : process.env.DORI_SLACK_APP_TOKEN;
if (!token || !appToken) { console.log('INBOUND_ERROR missing tokens'); process.exit(1); }
// One listener per app token: Slack hands each Socket Mode event to only ONE open connection on the app token, so a second
// listener (an orphan from an earlier session) silently takes a share of the events. The lock name hashes the app token (never
// the token itself), so copies started with another HOME or state dir still collide. The holder touches the lock every 30 s;
// a lock untouched for DORI_INBOUND_LOCK_STALE_MS (2 min) is stale even if its pid is alive again (Windows reuses pids).
// DORI_INBOUND_LOCK_DIR: test seam.
const LOCK_DIR = process.env.DORI_INBOUND_LOCK_DIR ?? (FAKE_EVENTS ? STATE_DIR : tmpdir());
const LISTENER_LOCK = join(LOCK_DIR, `dori-inbound-${createHash('sha256').update(appToken).digest('hex').slice(0, 16)}.lock`);
const LOCK_STALE_MS = Number(process.env.DORI_INBOUND_LOCK_STALE_MS) > 0 ? Number(process.env.DORI_INBOUND_LOCK_STALE_MS) : 120_000;
const pidAlive = (pid: number) => { if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; } };
const lockPid = () => { try { return parseInt(readFileSync(LISTENER_LOCK, 'utf8').trim(), 10); } catch { return NaN; } };
mkdirSync(LOCK_DIR, { recursive: true });
for (let attempt = 0; ; attempt++) {
  try { writeFileSync(LISTENER_LOCK, String(process.pid), { flag: 'wx' }); break; }
  catch (err: any) {
    if (err?.code !== 'EEXIST' || attempt >= 2) { console.log('INBOUND_ERROR could not acquire listener lock ' + String(err?.message ?? err)); process.exit(1); }
    const pid = lockPid();
    let age = Infinity; try { age = Date.now() - statSync(LISTENER_LOCK).mtimeMs; } catch {}
    if (pidAlive(pid) && age < LOCK_STALE_MS) { console.log(`INBOUND_ERROR another listener pid=${pid} is running (${LISTENER_LOCK})`); process.exit(1); }
    try { unlinkSync(LISTENER_LOCK); } catch {} // stale lock (dead or silent holder): take over
  }
}
setInterval(() => { try { if (lockPid() === process.pid) { const t = new Date(); utimesSync(LISTENER_LOCK, t, t); } } catch {} }, 30_000).unref();
process.on('exit', () => { try { if (lockPid() === process.pid) unlinkSync(LISTENER_LOCK); } catch {} });
// Under run-inbound (DORI_INBOUND_SUPERVISED=1) stdin is a pipe the supervisor holds; it closes however the supervisor dies
// (closed pane, hard kill), so exit with it instead of living on as an orphan that keeps a Socket Mode connection.
if (process.env.DORI_INBOUND_SUPERVISED === '1') (async () => {
  try { for await (const _ of Bun.stdin.stream()) {} } catch {}
  process.exit(0); // no log line: stdout went with the supervisor
})();
// Fake Slack Web API: DORI_INBOUND_FAKE_HISTORY JSON is { [method]: { ["<channel>:<ts>" | "<channel>" | "*"]: responseJson } }; anything else answers { ok: true, messages: [] }.
// A response of { "throw": "<message>" } rejects the call; { "hang": true } waits for the call's abort signal. Status and reaction calls print FAKE_STATUS / FAKE_REACTION / FAKE_REACTION_REMOVE lines.
// Re-read on every call, so a test can add messages that "arrived" after start.
const readFakeHistory = async (): Promise<any> => (FAKE_HISTORY ? await Bun.file(FAKE_HISTORY).json() : {});
const fakeFetch = (async (url: any, init: any) => {
  const method = String(url).split('/api/')[1] ?? '';
  const raw = String(init?.body ?? '');
  const json = raw.startsWith('{') ? JSON.parse(raw) : null; // reactions and status post JSON, the rest is form-encoded
  if (method === 'assistant.threads.setStatus') console.log(`FAKE_STATUS ${json.channel_id} ${json.thread_ts} ${JSON.stringify(json.status)}`);
  if (method === 'reactions.add') console.log(`FAKE_REACTION ${json.channel} ${json.timestamp} ${json.name}`);
  if (method === 'reactions.remove') console.log(`FAKE_REACTION_REMOVE ${json.channel} ${json.timestamp} ${json.name}`);
  const p = new URLSearchParams(json ?? raw);
  const table = (await readFakeHistory())[method] ?? {};
  const res = table[`${p.get('channel')}:${p.get('ts')}`] ?? table[p.get('channel') ?? ''] ?? table['*'] ?? { ok: true, messages: [] };
  if (res.throw) throw new Error(res.throw);
  if (res.hang) await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
const slackFetch: typeof fetch = FAKE_EVENTS || FAKE_HISTORY ? fakeFetch : fetch;
// Fake listener: replays DORI_INBOUND_FAKE_EVENTS (JSONL of Slack message events) with the real listener's event names.
// Control lines: {"fake":"connect"} (optional "num_connections", as in Slack's hello), {"fake":"disconnect"}, {"fake":"wait","file":"<path>"} (blocks until the file exists),
// {"fake":"advance","ms":N} (moves the working-status clock by N ms and runs one refresh).
class FakeListener {
  emitter = new EventEmitter();
  on(ev: string, fn: (...a: any[]) => void) { this.emitter.on(ev, fn); return this; }
  async start() {
    const lines = (await Bun.file(FAKE_EVENTS!).text()).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    if (!lines.some(l => l.fake === 'connect')) lines.unshift({ fake: 'connect' });
    (async () => {
      for (const l of lines) {
        if (l.fake === 'connect') { console.log('FAKE_CONNECT'); this.emitter.emit('connected', { num_connections: l.num_connections }); }
        else if (l.fake === 'disconnect') { console.log('FAKE_DISCONNECT'); this.emitter.emit('disconnected'); }
        else if (l.fake === 'advance') this.emitter.emit('fake-advance', l.ms);
        else if (l.fake === 'wait') { console.log('FAKE_WAIT ' + l.file); while (!(await Bun.file(l.file).exists())) await Bun.sleep(20); }
        else this.emitter.emit('message', { ack: () => {}, event: l });
        await Bun.sleep(0);
      }
    })();
  }
}
const slackbot: any = FAKE_EVENTS ? null : await import(pathToFileURL(join(MESSENGER, "dist", "src", "platforms", "slackbot", "index.js")).href);
const client: any = FAKE_EVENTS ? null : await new slackbot.SlackBotClient().login({ token });
const listener: any = FAKE_EVENTS ? new FakeListener() : new slackbot.SlackBotListener(client, { appToken });
const seen = new Set();
// Lead pane that receives each owner message as typed input; env DORI_INBOUND_PANE, else leadPane re-read from ~/.dori/config.json at each delivery
// (leadPane changes after a reboot). Empty disables injection. DELIVERY=stdout prints INBOUND only (for a harness-native monitor).
const resolvePane = async (): Promise<string> => process.env.DORI_INBOUND_PANE ?? (await Bun.file(CONFIG).json().catch(() => ({}))).leadPane ?? '';
const DELIVERY = process.env.DELIVERY;
// Channels listed in ~/.dori/inbound-rules.json "mentionOnlyChannels" need an @mention on top-level messages; thread replies never do.
// Channels listed in "strictMentionChannels" (another agent's home channel) need an @mention on every message, thread replies included.
const rulesFile = `${HOME}/.dori/inbound-rules.json`;
const mentionOnly = async () => { const f = Bun.file(rulesFile); return (await f.exists()) ? ((await f.json()).mentionOnlyChannels ?? []) : []; };
const ignored = async () => { const f = Bun.file(rulesFile); return (await f.exists()) ? ((await f.json()).ignoreChannels ?? []) : []; };
const strictMention = async () => { const f = Bun.file(rulesFile); return (await f.exists()) ? ((await f.json()).strictMentionChannels ?? []) : []; };
// "agentUsers": user ids of other agents (bots included). Their messages pass only when they @mention me; the channel rules above still apply.
const agentUsers = async (): Promise<string[]> => { const f = Bun.file(rulesFile); return (await f.exists()) ? ((await f.json()).agentUsers ?? []) : []; };
const isAgent = async (e: any) => Boolean(e?.user) && e.user !== OWNER && e.user !== BOT_USER && (await agentUsers()).includes(e.user);
const myThreads = new Set<string>();
const inMyThread = async (channel: string, threadTs: string, ts: string) => {
  const key = channel + ':' + threadTs;
  if (myThreads.has(key)) return true;
  try {
    const r = await slackFetch('https://slack.com/api/conversations.replies', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ channel, ts: threadTs, limit: '200' }) });
    const j: any = await r.json();
    if (!j?.ok) { console.log('INBOUND_SKIP ' + JSON.stringify({ channel, ts, reason: 'thread_check_failed' })); return false; }
    const msgs: any[] = j.messages ?? [];
    const mine = msgs.some(m => m.user === BOT_USER) || String(msgs[0]?.text ?? '').includes(`<@${BOT_USER}>`);
    if (mine) myThreads.add(key);
    return mine;
  } catch (err) { console.log('INBOUND_ERROR thread check ' + String((err as any)?.message ?? err)); console.log('INBOUND_SKIP ' + JSON.stringify({ channel, ts, reason: 'thread_check_failed' })); return false; }
};
const OWNER_SUBTYPES = new Set(['file_share', 'thread_broadcast']);
// A bot's chat.postMessage carries bot_id and sometimes subtype bot_message.
const AGENT_SUBTYPES = new Set([...OWNER_SUBTYPES, 'bot_message']);
// Same filter for live events and catch-up results.
const accept = async (e: any): Promise<boolean> => {
  if (!e) return false;
  const mentioned = String(e.text ?? '').includes(`<@${BOT_USER}>`);
  if (await isAgent(e)) {
    if ((e.subtype && !AGENT_SUBTYPES.has(e.subtype)) || !mentioned) return false;
  } else {
    if (e.bot_id) { if (e.user === OWNER) console.log('INBOUND_SKIP ' + JSON.stringify({ channel: e.channel, ts: e.ts, reason: 'bot_id' })); return false; }
    // message_changed / message_deleted carry the author on the inner message, not on the event.
    const author = e.user ?? e.message?.user ?? e.previous_message?.user;
    if (e.subtype && !OWNER_SUBTYPES.has(e.subtype)) { if (author === OWNER) console.log('INBOUND_SKIP ' + JSON.stringify({ channel: e.channel, ts: e.message?.ts ?? e.previous_message?.ts ?? e.ts, subtype: e.subtype })); return false; }
    if (e.user !== OWNER) return false;
  }
  const isThreadReply = Boolean(e.thread_ts && e.thread_ts !== e.ts);
  if ((await mentionOnly()).includes(e.channel) && !mentioned) {
    if (!isThreadReply) return false;
    // Thread replies pass without a mention only in threads I am part of (root mentions me, or I posted there).
    if (!(await inMyThread(e.channel, e.thread_ts, e.ts))) return false;
  }
  if ((await strictMention()).includes(e.channel) && !mentioned) return false;
  if ((await ignored()).includes(e.channel)) return false;
  const id = e.channel + ':' + e.ts; if (seen.has(id)) return false; seen.add(id);
  return true;
};
// Durable cursor { [channel]: lastDeliveredTs }, written atomically (temp file then rename).
const cmpTs = (a: string, b: string) => { const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.'); return ai.length !== bi.length ? ai.length - bi.length : ai !== bi ? (ai < bi ? -1 : 1) : af.padEnd(6, '0') < bf.padEnd(6, '0') ? -1 : af.padEnd(6, '0') > bf.padEnd(6, '0') ? 1 : 0; };
const cursors: Record<string, string> = await Bun.file(CURSOR_FILE).json().catch(() => ({}));
const saveCursor = (channel: string, ts: string) => {
  if (cursors[channel] && cmpTs(cursors[channel], ts) >= 0) return;
  cursors[channel] = ts;
  try { mkdirSync(STATE_DIR, { recursive: true }); const tmp = `${CURSOR_FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(cursors)); renameSync(tmp, CURSOR_FILE); }
  catch (err) { console.log('INBOUND_ERROR cursor ' + String((err as any)?.message ?? err)); }
};
const MAX_LINE = 30_000, RETRY_WAITS = [1000, 3000, 9000];
// Type the line into the lead pane; up to 3 retries (1 s, 3 s, 9 s), re-resolving the pane each attempt.
const inject = async (payload: any): Promise<boolean> => {
  let line = '[SLACK] ' + JSON.stringify(payload);
  // Windows command lines cap near 32,767 chars (ENAMETOOLONG) AFTER quoting, which escapes every " and doubles backslashes;
  // JSON.stringify(line) escapes the same characters, so its length is an upper bound. Over it, spill the full payload to a file.
  if (JSON.stringify(line).length > MAX_LINE) {
    const full = `${SPILL_DIR}/${payload.channel}-${payload.ts}.json`;
    mkdirSync(SPILL_DIR, { recursive: true }); writeFileSync(full, JSON.stringify(payload));
    line = '[SLACK] ' + JSON.stringify({ ...payload, text: payload.text.slice(0, 2000), truncated: true, full });
  }
  let pane = '', error = '';
  for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt++) {
    if (attempt > 0) await Bun.sleep(RETRY_WAITS[attempt - 1]);
    pane = await resolvePane();
    if (!pane) { error = 'no lead pane'; continue; }
    try {
      const p = Bun.spawn([...HERDR, 'pane', 'run', pane, line], { stdout: 'ignore', stderr: 'pipe' });
      const code = await p.exited;
      if (code === 0) { console.log('INJECTED ' + payload.channel + ':' + payload.ts); return true; }
      error = 'exit ' + code + ' ' + (await new Response(p.stderr).text()).trim();
    } catch (err) { error = String((err as any)?.message ?? err); }
  }
  console.log('INJECT_ERROR ' + JSON.stringify({ channel: payload.channel, ts: payload.ts, pane, error, text: String(payload.text).slice(0, 500) }));
  return false;
};
const envMs = (name: string, fallback: number) => { const n = Number(process.env[name]); return n > 0 ? n : fallback; };
const WORKING_LIMIT_MS = envMs('DORI_WORKING_LIMIT_MS', 30 * 60_000);
const WORKING_REFRESH_MS = envMs('DORI_WORKING_REFRESH_MS', 60_000);
const WORKING_STATUS = process.env.DORI_WORKING_STATUS || '작업 중...';
// Reactions and status run inside the delivery queue, so a hung Slack call must not stall it.
const SLACK_TIMEOUT_MS = envMs('DORI_SLACK_TIMEOUT_MS', 10_000);
let clockOffset = 0; // moved only by the fake listener's advance lines
const now = () => Date.now() + clockOffset;
const working = new Map<string, { channel: string; thread: string; until: number }>();
const unanswered = new Map<string, { channel: string; thread: string; ts: string }>();
const slackPost = async (method: string, body: object): Promise<any> => {
  const r = await slackFetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) });
  return r.json();
};
const react = async (method: 'add' | 'remove', channel: string, ts: string, name: string) => {
  try {
    const j = await slackPost(`reactions.${method}`, { channel, timestamp: ts, name });
    if (!j?.ok && j?.error !== 'already_reacted' && j?.error !== 'no_reaction') console.log(`REACTION_ERROR ${method} ${name} ${j?.error}`);
  } catch (err) { console.log('REACTION_ERROR ' + String((err as any)?.message ?? err)); }
};
const setStatus = async (channel: string, thread: string, status: string) => {
  try {
    const j = await slackPost('assistant.threads.setStatus', { channel_id: channel, thread_ts: thread, status });
    if (!j?.ok) console.log('INBOUND_SKIP ' + JSON.stringify({ channel, ts: thread, reason: 'status_' + j?.error }));
  } catch { console.log('INBOUND_SKIP ' + JSON.stringify({ channel, ts: thread, reason: 'status_failed' })); }
};
const showWorking = async (e: any) => {
  const thread = e.thread_ts ?? e.ts;
  working.set(e.channel + ':' + thread, { channel: e.channel, thread, until: now() + WORKING_LIMIT_MS });
  unanswered.set(e.channel + ':' + e.ts, { channel: e.channel, thread, ts: e.ts });
  await setStatus(e.channel, thread, WORKING_STATUS);
};
// A reply in the thread clears Slack's status by itself; a top-level reply in the channel does not, so clear those too.
const stopWorking = async (e: any) => {
  // Stop the refresh first, so a tick during the reaction calls cannot put the status back.
  for (const [key, w] of working) {
    if (w.channel !== e.channel) continue;
    if (e.thread_ts === w.thread) working.delete(key);
    else if (!e.thread_ts) { working.delete(key); void setStatus(w.channel, w.thread, ''); }
  }
  // An answer turns the read receipt into a check mark.
  for (const [key, m] of unanswered) {
    if (m.channel !== e.channel || (e.thread_ts && e.thread_ts !== m.thread)) continue;
    unanswered.delete(key);
    await react('remove', m.channel, m.ts, 'eyes');
    await react('add', m.channel, m.ts, 'white_check_mark');
  }
};
const refreshWorking = () => {
  for (const [key, w] of working) {
    if (now() > w.until) working.delete(key);
    else void setStatus(w.channel, w.thread, WORKING_STATUS);
  }
};
// Unref'd: the Slack socket owns the process lifetime, and a listener that stops must exit so the supervisor restarts it.
setInterval(refreshWorking, WORKING_REFRESH_MS).unref();
if (FAKE_EVENTS) listener.on('fake-advance', (ms: number) => { clockOffset += ms; refreshWorking(); });
const deliver = async (e: any) => {
  await Promise.all([react('add', e.channel, e.ts, 'eyes'), showWorking(e)]);
  const files = (e.files ?? []).map((f: any) => ({ id: f.id, name: f.name, mimetype: f.mimetype }));
  // Agent messages are marked so the lead can tell them from the owner's; owner payloads keep their shape.
  const from = (await isAgent(e)) ? { from: 'agent', user: e.user } : {};
  // Deliver as real input to the lead pane, like lane reports (monitor wakes get paused when they repeat).
  const useInject = DELIVERY === 'inject' || (DELIVERY !== 'stdout' && Boolean(await resolvePane()));
  const ok = useInject ? await inject({ channel: e.channel, ts: e.ts, thread_ts: e.thread_ts ?? null, text: e.text ?? '', files, ...from }) : true;
  if (ok) saveCursor(e.channel, e.ts); // before the INBOUND line, so a reader of that line sees the cursor already advanced
  console.log('INBOUND ' + JSON.stringify({ channel: e.channel, ts: e.ts, thread_ts: e.thread_ts ?? null, user: e.user, text: e.text ?? '', files, ...from }));
};
// One promise queue: filtering and delivery run in arrival order, so injections reach the pane in order.
let queue: Promise<void> = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => { queue = queue.then(fn).catch(err => console.log('INBOUND_ERROR ' + String((err as any)?.message ?? err))); };
listener.on('message', async ({ ack, event }: any) => {
  ack();
  enqueue(async () => {
    // Own messages only: other apps post in these channels too. In the queue, so a reply sorts after the message it answers; not awaited, so reactions never delay delivery.
    if (event?.user === BOT_USER) void stopWorking(event);
    if (await accept(event)) await deliver(event);
  });
});
listener.on?.('error', (err: any) => console.log('INBOUND_ERROR ' + String(err?.message ?? err)));
// SlackBotListener.start() resolves once apps.connections.open returns, before the socket is live; it emits 'connected' on the
// Socket Mode 'hello' envelope (listener.js handleEnvelope case 'hello') and 'disconnected' on ws close while running (ws.on('close')),
// then reconnects and emits 'connected' again.
// Catch-up runs on every connect, so messages sent during a reconnect gap are replayed too; the seen set dedupes.
// Slack's hello counts the open Socket Mode connections on this app token, this one included. More than one means another process
// (an orphan of an older copy, another machine, a copy the lock cannot see) gets a share of the events. Exiting would hand it all of
// them, so stay connected, say so on every hello, and reconnect every DORI_INBOUND_DUP_RECHECK_MS (2 min) for a fresh count. Until a
// hello counts one again, catch-up starts no later than the cursors at the first duplicate hello: the cursor alone has moved past
// messages the other process took. The final catch-up after the count drops still uses that floor.
const DUP_RECHECK_MS = envMs('DORI_INBOUND_DUP_RECHECK_MS', 120_000);
let dupFloor: Record<string, string> | null = null;
let dupTimer: ReturnType<typeof setInterval> | null = null;
const recheck = async () => {
  if (FAKE_EVENTS) return; // tests send the next hello as a control line
  console.log('INBOUND_RECHECK reconnecting for a fresh connection count');
  listener.stop();
  await listener.start();
};
let connectedOnce = false;
listener.on('connected', (info: any) => {
  console.log(connectedOnce ? 'INBOUND_READY reconnected' : 'INBOUND_READY');
  connectedOnce = true;
  const n = Number(info?.num_connections ?? 1);
  if (n > 1) {
    console.log(`INBOUND_ERROR duplicate_socket num_connections=${n}: another process on this app token receives part of the events; stop it (dori-inbound.ts processes, lock ${LISTENER_LOCK}). Staying connected, catch-up re-runs on each recheck every ${DUP_RECHECK_MS / 1000}s`);
    dupFloor ??= { ...cursors };
    dupTimer ??= setInterval(() => void recheck(), DUP_RECHECK_MS);
  }
  const floor = dupFloor;
  if (n <= 1 && dupFloor) {
    console.log('INBOUND_DUPLICATE_CLEARED');
    if (dupTimer) clearInterval(dupTimer);
    dupTimer = null;
    dupFloor = null;
  }
  enqueue(async () => {
    const from = { ...cursors };
    if (floor) for (const [ch, ts] of Object.entries(floor)) if (!from[ch] || cmpTs(ts, from[ch]) < 0) from[ch] = ts;
    const found: SlackMsg[] = await catchUp({ token, cursors: from, owner: OWNER, agents: await agentUsers(), fetchImpl: slackFetch });
    const pick: SlackMsg[] = [];
    for (const m of [...found].sort((a, b) => cmpTs(a.ts, b.ts))) if (await accept(m)) pick.push(m);
    console.log('INBOUND_CATCHUP n=' + pick.length);
    for (const m of pick) await deliver(m);
  });
});
listener.on('disconnected', () => console.log('INBOUND_ERROR disconnected'));
await listener.start();
