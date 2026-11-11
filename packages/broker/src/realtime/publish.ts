// Publishing change notices (Plan 5 Task 8). `noticesFor` says who hears a session's change and where (the session's channel, its project's, and each person's
// own); `publishNotices` posts them to the events API over HTTP, signed with SigV4 for `appsync`, at most `REALTIME_EVENTS_PER_PUBLISH` events to a request and all of
// them within `REALTIME_PUBLISH_DEADLINE_MS`. A notice is never a reason for anything else to fail: a request that fails is logged by the kind of channel and the error's
// name, and the person's feed (changes.ts) already holds the notice for the client that missed it. Without an API (`realtime` undefined) nothing is posted.
import { createHash, createHmac } from "node:crypto";
import { ENDED_SESSION_STATUSES, REALTIME_EVENTS_PER_PUBLISH, REALTIME_PUBLISH_DEADLINE_MS, type AgentSessionRecord, type SessionSummary } from "@rovara-code/contracts";
import { parseRealtimeChannel, projectChannel, sessionChannel, userChannel, type RealtimeNotice } from "@agentx/cloud-contracts";

/** The change that is being told: what `SessionChange` (notice-sink.ts) holds of it. */
export interface NoticedChange {
  summaryRevision: number;
  statusChanged: boolean;
  ended: boolean;
  previous: Pick<SessionSummary, "needsPeople">;
  summary: Pick<SessionSummary, "status" | "needsPeople">;
}

/** One notice, the channel it goes to, and the people whose feed holds it. */
export interface PlannedNotice { channel: string; notice: RealtimeNotice; feedTo: string[] }

/** The statuses a follower is told about (Task 9): somebody is needed, or it stopped or ended. */
const FOLLOWER_STATUSES: ReadonlySet<string> = new Set(["needs_person", "paused", "stopped", "waiting", ...ENDED_SESSION_STATUSES]);
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

/** Whether the followers of a session hear this change: it ended, or its status became one a follower is told about. */
export const followersHear = (change: Pick<NoticedChange, "ended" | "statusChanged" | "summary">): boolean =>
  change.ended || (change.statusChanged && FOLLOWER_STATUSES.has(change.summary.status));

/**
 * Who hears a change, and on which channel:
 *  - `session.updated` on the session's own channel;
 *  - on its project's channel, for a cloud task session only (never a chain or local session, I14) and only when `projectNotice` (no Task People entry is `denied`);
 *  - on each person's own channel, and in their feed: the effective owner always; the people a decision waits on (before or after) when the status, the ended state
 *    or who is needed changed; followers (already checked) when the session needs a person, paused, stopped, is waiting or ended;
 *  - `home.changed` to the owner and the people a decision waits on, when the status or who is needed changed.
 */
export function noticesFor(session: AgentSessionRecord, change: NoticedChange, people: { owner: string; followers: readonly string[]; projectNotice: boolean }): PlannedNotice[] {
  const planned: PlannedNotice[] = [];
  const updated: RealtimeNotice = { type: "session.updated", sessionId: session.sessionId, revision: change.summaryRevision };
  planned.push({ channel: sessionChannel(session.orgId, session.sessionId), notice: updated, feedTo: [] });
  if (people.projectNotice && session.kind === "task" && session.where.kind === "cloud" && session.project !== undefined) {
    planned.push({ channel: projectChannel(session.orgId, session.project), notice: updated, feedTo: [] });
  }
  const needed = [...new Set([...change.previous.needsPeople, ...change.summary.needsPeople])].filter((id) => DEVELOPER_ID.test(id));
  const neededChanged = change.previous.needsPeople.length !== change.summary.needsPeople.length || change.previous.needsPeople.some((id, index) => id !== change.summary.needsPeople[index]);
  const moved = change.statusChanged || change.ended || neededChanged;
  const hear = new Set<string>([people.owner]);
  if (moved) for (const id of needed) hear.add(id);
  if (followersHear(change)) for (const id of people.followers) hear.add(id);
  for (const developerId of hear) planned.push({ channel: userChannel(session.orgId, developerId), notice: updated, feedTo: [developerId] });
  if (moved) {
    const home: RealtimeNotice = { type: "home.changed", revision: change.summaryRevision };
    for (const developerId of new Set([people.owner, ...needed])) planned.push({ channel: userChannel(session.orgId, developerId), notice: home, feedTo: [developerId] });
  }
  return planned;
}

// ---- SigV4

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }

/** Where to post and as whom. `credentials` is read for each batch (a Lambda's are in its environment and rotate). */
export interface RealtimeConfig {
  /** `https://<dns prefix>.appsync-api.<region>.amazonaws.com/event` */
  endpoint: string;
  region: string;
  credentials: () => Promise<AwsCredentials>;
  fetch?: typeof fetch;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value, "utf8").digest();

/** The headers of a SigV4-signed POST of `body` to `url` for `service` (`x-amz-date`, `x-amz-security-token` when there is one, and `authorization`). */
export function signedHeaders(input: { url: URL; body: string; region: string; service: string; credentials: AwsCredentials; at: Date }): Record<string, string> {
  const stamp = input.at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { "content-type": "application/json", host: input.url.host, "x-amz-date": stamp };
  if (input.credentials.sessionToken !== undefined) headers["x-amz-security-token"] = input.credentials.sessionToken;
  // SigV4 wants the signed headers sorted by name; sorted here whatever order they are added in.
  const names = Object.keys(headers).sort();
  const canonical = ["POST", input.url.pathname, input.url.search.slice(1), ...names.map((name) => `${name}:${headers[name]!.trim()}`), "", names.join(";"), sha256(input.body)].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const { host: _host, ...sent } = headers; // eslint-disable-line @typescript-eslint/no-unused-vars -- fetch sets Host from the URL; it is signed but not sent
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(toSign, "utf8").digest("hex")}` };
}

/** The credentials a Lambda holds in its environment. */
export const environmentCredentials = (env: Record<string, string | undefined> = process.env) => async (): Promise<AwsCredentials> => {
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error("no AWS credentials");
  return { accessKeyId, secretAccessKey, sessionToken: env["AWS_SESSION_TOKEN"] };
};

// ---- publishing

export interface PublishDependencies {
  realtime?: RealtimeConfig | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const PUBLISH_CONCURRENCY = 4;

/**
 * Posts the notices: those on one channel in groups of `REALTIME_EVENTS_PER_PUBLISH` (the API takes one channel and five events to a request), the requests a few at a
 * time. Gives up on whatever is not done at `REALTIME_PUBLISH_DEADLINE_MS` (a hung request is aborted, and the call returns anyway). Never throws.
 */
export async function publishNotices(deps: PublishDependencies, entries: ReadonlyArray<{ channel: string; notice: RealtimeNotice }>): Promise<{ requests: number; failed: number }> {
  const config = deps.realtime;
  const result = { requests: 0, failed: 0 };
  if (config === undefined || entries.length === 0) return result;
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line })));
  const byChannel = new Map<string, RealtimeNotice[]>();
  for (const { channel, notice } of entries) byChannel.set(channel, [...(byChannel.get(channel) ?? []), notice]);
  const requests: Array<{ channel: string; events: string[] }> = [];
  for (const [channel, notices] of byChannel) {
    for (let at = 0; at < notices.length; at += REALTIME_EVENTS_PER_PUBLISH) requests.push({ channel, events: notices.slice(at, at + REALTIME_EVENTS_PER_PUBLISH).map((notice) => JSON.stringify(notice)) });
  }
  const abort = new AbortController();
  const send = config.fetch ?? fetch;
  const url = new URL(config.endpoint);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const request = requests[next++];
      if (request === undefined || abort.signal.aborted) return;
      result.requests += 1;
      const kind = parseRealtimeChannel(request.channel)?.kind ?? "unknown";
      try {
        const body = JSON.stringify({ channel: request.channel, events: request.events });
        const headers = signedHeaders({ url, body, region: config.region, service: "appsync", credentials: await config.credentials(), at: new Date(deps.now()) });
        const response = await send(url.toString(), { method: "POST", headers, body, signal: abort.signal });
        if (!response.ok) throw Object.assign(new Error("not ok"), { name: `http_${String(response.status)}` });
      } catch (error) {
        result.failed += 1;
        log({ event: "realtime.publish_failed", channelKind: kind, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(); }, REALTIME_PUBLISH_DEADLINE_MS); });
  await Promise.race([Promise.all(Array.from({ length: Math.min(PUBLISH_CONCURRENCY, requests.length) }, worker)), late]);
  clearTimeout(timer);
  return result;
}
