// Convergence lane A8: a double of the cloud events service's HTTP publish endpoint, for the realtime adapter's tests. It takes a request the way the service does (a signed POST of one channel and at most five events,
// each event a JSON string) and refuses what the service refuses (a request over five events, an event that is not a string, a missing signature, a channel that is not a path of the namespace). It keeps what it took in
// order, and it models the service's own authorizer: a listener is allowed to hear a channel only when the company in the channel's name is the listener's company, so what a listener hears is what the service would deliver it.
import { parseChannel } from "../../../packages/broker/src/cloud-adapters/email-realtime.js";
import type { RealtimeEntry } from "../../../packages/broker/src/cloud-adapters/k1-ports/index.js";

/** What a listener heard: the entry and the company it was carried for. */
export interface HeardEntry extends RealtimeEntry {
  companyId: string;
}

export interface TakenRequest {
  url: string;
  headers: Record<string, string>;
  channel: string;
  events: string[];
}

export interface Listener {
  companyId: string;
  /** What it was delivered, in order. */
  heard: Array<{ channel: string; notice: Record<string, unknown> }>;
}

export class FakeEventsApi {
  readonly requests: TakenRequest[] = [];
  readonly listeners: Listener[] = [];
  down: "no" | "status" | "network" | "hang" = "no";
  /** Channels whose requests fail with a 500 (a partly failing batch). */
  readonly failChannels = new Set<string>();

  constructor(private readonly namespace = "rovara") {}

  listen(companyId: string): Listener {
    const listener: Listener = { companyId, heard: [] };
    this.listeners.push(listener);
    return listener;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (this.down === "network") throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
    if (this.down === "hang") {
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted === true) fail(); else init?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { channel?: unknown; events?: unknown };
    const channel = body.channel;
    const events = body.events;
    const bad = typeof channel !== "string" || parseChannel(this.namespace, channel) === undefined || !Array.isArray(events) || events.length < 1 || events.length > 5 || !events.every((event) => typeof event === "string")
      || !/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/appsync\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/u.test(headers["authorization"] ?? "");
    if (bad) return new Response("{}", { status: 400 });
    if (this.down === "status" || this.failChannels.has(channel)) return new Response("{}", { status: this.down === "status" ? 503 : 500 });
    this.requests.push({ url, headers, channel, events: events });
    const parsed = parseChannel(this.namespace, channel)!;
    for (const listener of this.listeners) {
      // The service's authorizer: a listener hears only the channels of its own company.
      if (listener.companyId !== parsed.companyId) continue;
      for (const event of events) listener.heard.push({ channel, notice: JSON.parse(event) as Record<string, unknown> });
    }
    return new Response("{}", { status: 200 });
  };

  /** What the service took, one entry per event, in the order the requests arrived. */
  carried(): HeardEntry[] {
    return this.requests.flatMap((request) => {
      const parsed = parseChannel(this.namespace, request.channel)!;
      const audience = parsed.kind === "person" ? { kind: "person" as const, personId: parsed.segment } : parsed.kind === "session" ? { kind: "session" as const, sessionId: parsed.segment } : { kind: "project" as const, project: parsed.segment };
      return request.events.map((event) => ({ companyId: parsed.companyId, audience, notice: JSON.parse(event) as HeardEntry["notice"] }));
    });
  }
}
