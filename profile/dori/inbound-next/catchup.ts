// Catch-up of the owner's (and listed agents') Slack messages missed since a per-channel cursor (last delivered ts).
// Uses conversations.history and conversations.replies; never logs the token.

export type SlackMsg = { channel: string; ts: string; thread_ts: string | null; user: string; text: string; files: { id: string; name: string; mimetype: string }[]; subtype?: string };

const KEPT_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);
const AGENT_SUBTYPES = new Set([...KEPT_SUBTYPES, 'bot_message']);

// Compare Slack ts strings ("1792887045.123456") exactly: integer part as BigInt, fraction right-padded.
function cmpTs(a: string, b: string): number {
  const [ai = '0', af = ''] = String(a).split('.');
  const [bi = '0', bf = ''] = String(b).split('.');
  const ia = BigInt(ai || '0'), ib = BigInt(bi || '0');
  if (ia !== ib) return ia < ib ? -1 : 1;
  const len = Math.max(af.length, bf.length);
  const fa = af.padEnd(len, '0'), fb = bf.padEnd(len, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

class SlackError extends Error {}

// Agents (bots included) pass here; the listener's accept() still requires their @mention.
function isWanted(m: any, owner: string, agents: string[]): boolean {
  if (!m) return false;
  if (m.user && m.user !== owner && agents.includes(m.user)) return AGENT_SUBTYPES.has(m.subtype);
  return m.user === owner && !m.bot_id && KEPT_SUBTYPES.has(m.subtype);
}

function toMsg(channel: string, m: any): SlackMsg {
  const out: SlackMsg = {
    channel,
    ts: String(m.ts),
    thread_ts: m.thread_ts ?? null,
    user: m.user,
    text: m.text ?? '',
    files: (m.files ?? []).map((f: any) => ({ id: f.id, name: f.name, mimetype: f.mimetype })),
  };
  if (m.subtype !== undefined) out.subtype = m.subtype;
  return out;
}

export async function catchUp(opts: { token: string; cursors: Record<string, string>; owner: string; agents?: string[]; fetchImpl?: typeof fetch; maxPerChannel?: number }): Promise<SlackMsg[]> {
  const { token, cursors, owner } = opts;
  const agents = opts.agents ?? [];
  const doFetch = opts.fetchImpl ?? fetch;
  const max = opts.maxPerChannel ?? 500;
  const redact = (s: string) => (token ? s.split(token).join('[redacted]') : s);

  const call = async (method: string, params: Record<string, string>): Promise<any> => {
    const r = await doFetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const j: any = await r.json();
    if (!j || j.ok !== true) throw new SlackError(`${method} ${j?.error ?? 'not_ok'}`);
    return j;
  };

  // Follow next_cursor until exhausted or `limit` messages collected.
  const paged = async (method: string, params: Record<string, string>, limit: number): Promise<any[]> => {
    const all: any[] = [];
    let cursor = '';
    while (all.length < limit) {
      const j = await call(method, cursor ? { ...params, cursor } : params);
      all.push(...(j.messages ?? []));
      cursor = j.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return all.slice(0, limit);
  };

  const byKey = new Map<string, SlackMsg>();
  for (const [channel, since] of Object.entries(cursors)) {
    const found: SlackMsg[] = [];
    try {
      const history = await paged('conversations.history', { channel, oldest: since, inclusive: 'false', limit: '200' }, max);
      for (const m of history) {
        if (isWanted(m, owner, agents) && cmpTs(m.ts, since) > 0) found.push(toMsg(channel, m));
        if ((m.reply_count ?? 0) > 0 && m.latest_reply && cmpTs(m.latest_reply, since) > 0) {
          const replies = await paged('conversations.replies', { channel, ts: String(m.ts), oldest: since, limit: '200' }, max);
          for (const r of replies) {
            if (String(r.ts) === String(m.ts)) continue;
            if (isWanted(r, owner, agents) && cmpTs(r.ts, since) > 0) found.push(toMsg(channel, r));
          }
        }
      }
    } catch (err) {
      const msg = err instanceof SlackError ? err.message : String((err as any)?.message ?? err);
      console.log(redact(`CATCHUP_ERROR ${channel} ${msg}`));
      continue;
    }
    for (const f of found) byKey.set(`${f.channel}:${f.ts}`, f);
  }
  return [...byKey.values()].sort((a, b) => cmpTs(a.ts, b.ts) || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
}
