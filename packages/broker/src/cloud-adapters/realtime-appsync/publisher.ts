// Convergence lane A8: the `realtime` port on the cloud events service (AppSync Events, its HTTP publish endpoint, signed with SigV4).
//
// A batch is split by channel; each channel's notices go in groups of `REALTIME_EVENTS_PER_PUBLISH` (the API takes one channel and five events to a request); a few requests run at a time; whatever is not done by
// the deadline is given up on (a hung request is aborted and `publish` returns anyway). `publish` never throws: an entry that was refused (not a notice, not an audience, not a company this naming can use), or whose request
// failed or was cut off, is counted in `failed`. A notice is a hint: the host's own catch-up feed is the record, so a lost, late or repeated push does no harm.
//
// Company isolation: the company is in the channel name (`channels.ts`), and every entry of a batch is published for that batch's company only. An entry has no way to name another company's channel.
// Logs carry the kind of channel and the error's name, never a channel name (it holds the company), a notice or an id.
import { REALTIME_EVENTS_PER_PUBLISH, REALTIME_PUBLISH_DEADLINE_MS } from "@rovara-code/contracts";
import { REALTIME_BATCH_MAX, isRealtimeAudience, isRealtimeNotice, type RealtimeBatch, type RealtimeCapabilities, type RealtimePublishResult, type RealtimePublisher } from "../k1-ports/index.js";
import { DEFAULT_NAMESPACE, channelOf, isChannelNamespace } from "./channels.js";
import { signedHeaders, type AwsCredentials } from "./sigv4.js";

export interface AppSyncEventsPublisherOptions {
  /** `https://<id>.appsync-api.<region>.amazonaws.com/event` */
  endpoint: string;
  /** Default: the region in the endpoint's host. */
  region?: string;
  /** The channel namespace of the API. Default `rovara`. */
  namespace?: string;
  /** Read for each request (a role's credentials rotate). */
  credentials: () => Promise<AwsCredentials>;
  fetch?: typeof fetch;
  now?: () => number;
  /** The longest one `publish` may take when the batch names no deadline. Default `REALTIME_PUBLISH_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** Fixed codes only. */
  log?: (entry: Record<string, unknown>) => void;
}

export const APPSYNC_CAPABILITIES: RealtimeCapabilities = { remoteListeners: true, entriesPerRequest: REALTIME_EVENTS_PER_PUBLISH };
const DEFAULT_CONCURRENCY = 4;

/** The region an events API endpoint is in, from its host; undefined for any other host. */
export const regionOfEndpoint = (endpoint: string): string | undefined => /^[^.]+\.appsync-api\.([a-z0-9-]+)\./u.exec(new URL(endpoint).host)?.[1];

export class AppSyncEventsPublisher implements RealtimePublisher {
  readonly capabilities = APPSYNC_CAPABILITIES;
  private readonly url: URL;
  private readonly region: string;
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly options: AppSyncEventsPublisherOptions) {
    this.url = new URL(options.endpoint);
    if (this.url.protocol !== "https:" && this.url.protocol !== "http:") throw new TypeError("the events endpoint is an http(s) URL");
    const region = options.region ?? regionOfEndpoint(options.endpoint);
    if (region === undefined) throw new TypeError("the region is not in the endpoint's host: name it");
    this.region = region;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    if (!isChannelNamespace(this.namespace)) throw new TypeError("the channel namespace is letters, digits and hyphens");
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  async publish(batch: RealtimeBatch): Promise<RealtimePublishResult> {
    const total = batch.entries.length;
    try {
      return await this.run(batch, total);
    } catch {
      // Never throws, whatever went wrong: nothing here is known to have been sent.
      this.log({ event: "realtime.publish_failed", channelKind: "unknown", error: "unexpected" });
      return { sent: 0, failed: total };
    }
  }

  private async run(batch: RealtimeBatch, total: number): Promise<RealtimePublishResult> {
    if (total === 0) return { sent: 0, failed: 0 };
    const start = this.now();
    const budget = Math.min(this.options.deadlineMs ?? REALTIME_PUBLISH_DEADLINE_MS, batch.deadline === undefined ? Infinity : batch.deadline - start);
    if (budget <= 0) return { sent: 0, failed: total };

    // Group by channel, in order; an entry past the batch limit or that is not a valid notice and audience is failed.
    const byChannel = new Map<string, string[]>();
    for (const [index, entry] of batch.entries.entries()) {
      if (index >= REALTIME_BATCH_MAX || !isRealtimeAudience(entry.audience) || !isRealtimeNotice(entry.notice)) continue;
      let channel: string;
      try { channel = channelOf(this.namespace, batch.companyId, entry.audience); } catch { continue; }
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), JSON.stringify(entry.notice)]);
    }
    const requests: Array<{ channel: string; events: string[] }> = [];
    for (const [channel, events] of byChannel) {
      for (let at = 0; at < events.length; at += REALTIME_EVENTS_PER_PUBLISH) requests.push({ channel, events: events.slice(at, at + REALTIME_EVENTS_PER_PUBLISH) });
    }

    const abort = new AbortController();
    const send = this.options.fetch ?? fetch;
    let sent = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const request = requests[next++];
        if (request === undefined || abort.signal.aborted) return;
        const kind = request.channel.split("/")[3] === "u" ? "person" : request.channel.split("/")[3] === "s" ? "session" : "project";
        try {
          const body = JSON.stringify({ channel: request.channel, events: request.events });
          const headers = signedHeaders({ url: this.url, body, region: this.region, service: "appsync", credentials: await this.options.credentials(), at: new Date(this.now()) });
          const response = await send(this.url.toString(), { method: "POST", headers, body, signal: abort.signal });
          if (!response.ok) throw Object.assign(new Error("not ok"), { name: `http_${String(response.status)}` });
          if (!abort.signal.aborted) sent += request.events.length;
        } catch (error) {
          this.log({ event: "realtime.publish_failed", channelKind: kind, error: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name) ? error.name : "unknown" });
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(); }, budget); });
    await Promise.race([Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? DEFAULT_CONCURRENCY, requests.length) }, worker)), late]);
    clearTimeout(timer);
    return { sent, failed: total - sent };
  }
}
