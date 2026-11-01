// The Slack ingress's side of the Team record (wire-team-record). The ingress has verified Slack's signature; this hands the event to the BROKER, which holds the record's rights. The ingress itself
// gets no table, queue or storage right: its only new behaviour is one direct invoke of the broker (which it was already allowed to do), and only where `TEAM_RECORD_ENABLED` is exactly "1".
//
// What it adds is the channel's facts, which only the ingress can read (it holds the Slack bot token): whether the channel is public, private, a DM or a group DM, whether it is shared with
// another organisation (Slack Connect), and for a private channel the members now. Unknown is sent as nothing, and the broker's tap records nothing for an unknown channel.
//
// How text travels. Public edition: Slack's terms forbid keeping copies of message text, so a text-carrying event (`message`, `message_changed`) is sent as a REQUEST/RESPONSE invoke, answered while the
// broker processes it in memory: the text is never parked in Lambda's asynchronous queue, where a retry would keep it for hours. An invoke that does not finish in time is dropped, not retried.
// Everything else (deletes, membership, channel events, which carry no message text) is sent as an asynchronous event so a delete is retried by Lambda. Enterprise sends everything asynchronously.
import type { SlackChannelInfo } from "./sources/slack.js";

export const TEAM_RECORD_SLACK_SOURCE = "agentx.team-record-slack";

export interface SlackForwardEvent {
  source: typeof TEAM_RECORD_SLACK_SOURCE;
  payload: Record<string, unknown>;
  channel?: { teamId: string; channelId: string; info: SlackChannelInfo };
}

/** `message` events and edits carry text; nothing else the tap handles does. */
export const carriesText = (payload: Record<string, unknown>): boolean => {
  const event = payload.event;
  const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
  return type === "message" || type === "message_changed";
};

type Fetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const CHANNEL = /^[CGD][A-Z0-9]{2,31}$/;
const TEAM = /^[TE][A-Z0-9]{2,31}$/;
const USER = /^[UW][A-Z0-9]{2,31}$/;
const MEMBERS_MAX = 500;
const SLACK_CALL_MS = 2_000;

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? value as Record<string, unknown> : {});

/** `conversations.info` (and `conversations.members` for a private channel) with the bot token. `undefined` when Slack does not answer or the answer is not understood. */
export async function readChannelInfo(input: { token: string; channelId: string; fetch: Fetch }): Promise<SlackChannelInfo | undefined> {
  const call = async (method: string, query: string): Promise<Record<string, unknown> | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_CALL_MS);
    try {
      const response = await input.fetch(`https://slack.com/api/${method}?${query}`, { method: "GET", headers: { authorization: `Bearer ${input.token}` }, signal: controller.signal });
      const body = record(await response.json());
      return response.ok && body.ok === true ? body : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  const info = await call("conversations.info", `channel=${encodeURIComponent(input.channelId)}`);
  const channel = record(info?.channel);
  if (info === undefined || channel.id !== input.channelId) return undefined;
  const kind: SlackChannelInfo["kind"] | undefined = channel.is_im === true ? "im" : channel.is_mpim === true ? "mpim" : channel.is_private === true || channel.is_group === true ? "private" : channel.is_channel === true ? "public" : undefined;
  if (kind === undefined) return undefined;
  const extShared = channel.is_ext_shared === true || channel.is_pending_ext_shared === true;
  if (kind !== "private") return { kind, extShared };
  const memberIds: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5 && memberIds.length < MEMBERS_MAX; page += 1) {
    const members = await call("conversations.members", `channel=${encodeURIComponent(input.channelId)}&limit=200${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    if (members === undefined || !Array.isArray(members.members)) return { kind, extShared: true };
    for (const id of members.members) if (typeof id === "string" && USER.test(id)) memberIds.push(id);
    const next = record(members.response_metadata).next_cursor;
    cursor = typeof next === "string" && next !== "" ? next : undefined;
    if (cursor === undefined) break;
  }
  // A member list that did not finish is not a snapshot: the channel stays unknown-shaped (treated as shared, so nothing is recorded).
  if (cursor !== undefined) return { kind, extShared: true };
  return { kind, extShared, memberIds: memberIds.slice(0, MEMBERS_MAX) };
}

export interface SlackForwarderDependencies {
  /** Sends one event to the broker. `wait` means a request/response invoke; otherwise an asynchronous event. Throws when it was not accepted. */
  invoke(event: SlackForwardEvent, wait: boolean): Promise<void>;
  token(): Promise<string>;
  fetch: Fetch;
  edition: "enterprise" | "public";
  now?: () => number;
}

/** The ingress's `recordTap`. It never throws a retry at Slack: the ingress wraps it in its own budget and catch. */
export function createSlackForwarder(deps: SlackForwarderDependencies): (payload: unknown) => Promise<void> {
  const cache = new Map<string, { at: number; info: SlackChannelInfo }>();
  const now = deps.now ?? Date.now;
  return async (raw) => {
    const payload = record(raw);
    if (payload.type !== "event_callback") return;
    const event = record(payload.event);
    const teamId = payload.team_id;
    if (typeof teamId !== "string" || !TEAM.test(teamId) || typeof event.type !== "string") return;
    const channelId = typeof event.channel === "string" ? event.channel : record(event.channel).id;
    const forward: SlackForwardEvent = { source: TEAM_RECORD_SLACK_SOURCE, payload };
    if (typeof channelId === "string" && CHANNEL.test(channelId) && event.type !== "channel_deleted") {
      const key = `${teamId}/${channelId}`;
      const hit = cache.get(key);
      let info = hit !== undefined && now() - hit.at < 300_000 ? hit.info : undefined;
      // Membership, conversion and sharing events change the answer: never read a cached one for them.
      if (info === undefined || /^(member_|channel_)/.test(event.type)) {
        info = await readChannelInfo({ token: await deps.token(), channelId, fetch: deps.fetch });
        if (info !== undefined) cache.set(key, { at: now(), info });
      }
      if (info !== undefined) forward.channel = { teamId, channelId, info };
    }
    await deps.invoke(forward, deps.edition === "public" && carriesText(payload));
  };
}
