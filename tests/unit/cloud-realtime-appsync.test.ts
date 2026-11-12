// Convergence lane A8: Cloud's events adapter (Code's realtime port, K1) keeps companies apart in the channel names it makes and in what a
// listener can hear, signs the way the AWS SDK signs, and gives up at the deadline without throwing.
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { describe, expect, it } from "vitest";
import { REALTIME_EVENTS_PER_PUBLISH } from "@rovara-code/contracts";
import { AppSyncEventsPublisher, channelOf, parseChannel, regionOfEndpoint, signedHeaders, type AppSyncEventsPublisherOptions } from "../../packages/broker/src/cloud-adapters/email-realtime.js";
import type { RealtimeAudience } from "../../packages/broker/src/cloud-adapters/k1-ports/index.js";
import { FakeEventsApi } from "../support/cloud-adapters/appsync-events-fake.js";

const ENDPOINT = "https://abcdefghij.appsync-api.us-west-2.amazonaws.com/event";
const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const PERSON = "a".repeat(64);
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE0000", secretAccessKey: "secret-example-0000", sessionToken: "token-example-0000" });

function world(extra: Partial<AppSyncEventsPublisherOptions> = {}) {
  const api = new FakeEventsApi();
  const logs: Array<Record<string, unknown>> = [];
  const publisher = new AppSyncEventsPublisher({ endpoint: ENDPOINT, credentials, fetch: api.fetch, log: (entry) => logs.push(entry), ...extra });
  return { api, publisher, logs };
}

// Code's realtime conformance suite (`runRealtimeConformance`) is not in the vendored pin yet. It is registered with the pin bump (tests/conformance/pending-lanes.ts, PENDING_AFTER_PIN); these cases cover its ground meanwhile.
describe("the port's own cases, until the conformance suite is registered", () => {
  it.todo("passes runRealtimeConformance from the vendored Code (blocked on the pin bump)");

  it("carries each notice to its audience for its company, answers an empty batch, counts refused entries as failed, and never throws when the service is down", async () => {
    const { api, publisher } = world();
    const person = { kind: "person", personId: "a".repeat(64) } as const;
    expect(await publisher.publish({ companyId: COMPANY, entries: [] })).toEqual({ sent: 0, failed: 0 });
    expect(await publisher.publish({ companyId: COMPANY, entries: [
      { audience: person, notice: { type: "home.changed", revision: 1 } },
      { audience: person, notice: { type: "session.updated", title: "Fix the login page for Alice" } },
      { audience: { kind: "everyone" } as never, notice: { type: "home.changed", revision: 2 } },
    ] })).toEqual({ sent: 1, failed: 2 });
    expect(api.carried().map((entry) => [entry.companyId, entry.notice])).toEqual([[COMPANY, { type: "home.changed", revision: 1 }]]);
    api.down = "status";
    expect(await publisher.publish({ companyId: COMPANY, entries: [{ audience: person, notice: { type: "home.changed", revision: 3 } }] })).toEqual({ sent: 0, failed: 1 });
    expect(await publisher.publish({ companyId: COMPANY, deadline: Date.now() - 1, entries: [{ audience: person, notice: { type: "home.changed", revision: 4 } }] })).toEqual({ sent: 0, failed: 1 });
  });

  it("takes a full batch and fails what is past the batch limit", async () => {
    const { publisher } = world();
    const entries = Array.from({ length: 201 }, (_, revision) => ({ audience: { kind: "person", personId: "a".repeat(64) } as const, notice: { type: "home.changed", revision } }));
    expect(await publisher.publish({ companyId: COMPANY, entries })).toEqual({ sent: 200, failed: 1 });
  });
});

describe("channel names (the hosted product's, so nothing it stores or signs changes)", () => {
  it("makes `/<namespace>/o-<company>/<u|s|p>/<segment>` with the segments the hosted product makes", () => {
    // Literals, so a change of the recipe is caught even if the code and the test are changed together (the hosted product's own channel functions give the same names for the same inputs).
    expect(channelOf("rovara", COMPANY, { kind: "session", sessionId: SESSION })).toBe("/rovara/o-00000000000000000000/s/s-aaaaaaaaaaaaaaaaaaaa");
    expect(channelOf("rovara", COMPANY, { kind: "session", sessionId: "crn_bbbbbbbbbbbbbbbbbbbb" })).toBe("/rovara/o-00000000000000000000/s/c-bbbbbbbbbbbbbbbbbbbb");
    expect(channelOf("rovara", COMPANY, { kind: "person", personId: PERSON })).toBe("/rovara/o-00000000000000000000/u/d-ffe054fe7ae0cb6dc65c3af9b61d5209f439851d");
    expect(channelOf("rovara", COMPANY, { kind: "project", project: "web" })).toBe("/rovara/o-00000000000000000000/p/p-a85ebdafe9a984d9a14f9c849ca46c094e43227d");
  });

  it("puts no person id, no project name and no session id past its body in a channel name", () => {
    const names = [channelOf("rovara", COMPANY, { kind: "person", personId: PERSON }), channelOf("rovara", COMPANY, { kind: "project", project: "payments-secret-project" }), channelOf("rovara", COMPANY, { kind: "session", sessionId: SESSION })];
    expect(names[0]).not.toContain(PERSON);
    expect(names[1]).not.toContain("payments");
    expect(names[2]).not.toContain("ses_");
  });

  it("reads back only the names it makes", () => {
    const channel = channelOf("rovara", OTHER, { kind: "project", project: "web" });
    expect(parseChannel("rovara", channel)).toMatchObject({ companyId: OTHER, kind: "project" });
    for (const bad of ["", "/rovara/o-11111111111111111111/p/*", "/rovara/o-11111111111111111111/p/p-zz", "/other/o-11111111111111111111/u/d-" + "0".repeat(40), "/rovara/o-1/u/d-" + "0".repeat(40), `${channel}/extra`, "/rovara/o-11111111111111111111/x/s-aaaaaaaaaaaaaaaaaaaa"]) {
      expect(parseChannel("rovara", bad), bad).toBeUndefined();
    }
  });

  it("refuses a company id or a session id of another shape instead of making a name from it", () => {
    for (const company of ["", "org_short", "org_0000000000000000000A", "00000000000000000000", "org_00000000000000000000/../x"]) {
      expect(() => channelOf("rovara", company, { kind: "project", project: "web" }), company).toThrow();
    }
    for (const sessionId of ["ses_short", "xyz_aaaaaaaaaaaaaaaaaaaa", "ses_aaaaaaaaaaaaaaaaaaaa/../x", "ses_AAAAAAAAAAAAAAAAAAAA"]) {
      expect(() => channelOf("rovara", COMPANY, { kind: "session", sessionId }), sessionId).toThrow();
    }
  });
});

describe("company isolation", () => {
  const audiences: RealtimeAudience[] = [{ kind: "session", sessionId: SESSION }, { kind: "project", project: "web" }, { kind: "person", personId: PERSON }];
  const notice = (company: string) => ({ type: "session.updated", sessionId: SESSION, revision: company === COMPANY ? 1 : 2 });

  it("delivers one company's notices to that company's listeners and never to another's, for every kind of audience, with the same ids and names in both", async () => {
    const { api, publisher } = world();
    const listenerA = api.listen(COMPANY);
    const listenerB = api.listen(OTHER);
    for (const company of [COMPANY, OTHER]) {
      const result = await publisher.publish({ companyId: company, entries: audiences.map((audience) => ({ audience, notice: notice(company) })) });
      expect(result).toEqual({ sent: 3, failed: 0 });
    }
    // The positive control: both listeners heard their own three, so the delivery path ran for each.
    expect(listenerA.heard.map((heard) => heard.notice["revision"])).toEqual([1, 1, 1]);
    expect(listenerB.heard.map((heard) => heard.notice["revision"])).toEqual([2, 2, 2]);
    // Each company's listener heard only channels of its own company.
    expect(listenerA.heard.every((heard) => parseChannel("rovara", heard.channel)?.companyId === COMPANY)).toBe(true);
    expect(listenerB.heard.every((heard) => parseChannel("rovara", heard.channel)?.companyId === OTHER)).toBe(true);
    // The same session, project and person in two companies are six different channels.
    expect(new Set(api.requests.map((request) => request.channel)).size).toBe(6);
  });

  it("makes a project's segment depend on the company, so even the segment alone differs between companies", () => {
    const a = parseChannel("rovara", channelOf("rovara", COMPANY, { kind: "project", project: "web" }))!;
    const b = parseChannel("rovara", channelOf("rovara", OTHER, { kind: "project", project: "web" }))!;
    expect(a.segment).not.toBe(b.segment);
  });

  it("uses the batch's company for every entry: an entry cannot name another company's channel", async () => {
    const { api, publisher } = world();
    const listenerB = api.listen(OTHER);
    // An entry that tries to carry a company or a channel of its own is not an audience: it is refused, and nothing reaches the other company.
    const sneaky = { audience: { kind: "project", project: "web", companyId: OTHER, channel: channelOf("rovara", OTHER, { kind: "project", project: "web" }) } as never, notice: { type: "session.updated", revision: 1 } };
    expect(await publisher.publish({ companyId: COMPANY, entries: [sneaky, { audience: { kind: "project", project: "web" }, notice: { type: "session.updated", revision: 2 } }] })).toEqual({ sent: 1, failed: 1 });
    expect(listenerB.heard).toEqual([]);
    expect(api.requests).toHaveLength(1);
    expect(parseChannel("rovara", api.requests[0]!.channel)?.companyId).toBe(COMPANY);
  });

  it("fails every entry of a batch whose company id has not the shape the names are made from, and sends nothing", async () => {
    const { api, publisher } = world();
    expect(await publisher.publish({ companyId: "org_x", entries: audiences.map((audience) => ({ audience, notice: notice(COMPANY) })) })).toEqual({ sent: 0, failed: 3 });
    expect(await publisher.publish({ companyId: "", entries: audiences.map((audience) => ({ audience, notice: notice(COMPANY) })) })).toEqual({ sent: 0, failed: 3 });
    expect(api.requests).toHaveLength(0);
  });
});

describe("requests", () => {
  it("sends one channel and at most five events to a request, each event the notice's JSON as a string, signed for the events service", async () => {
    const { api, publisher } = world();
    const entries = Array.from({ length: 12 }, (_, revision) => ({ audience: { kind: "person", personId: PERSON } as const, notice: { type: "home.changed", revision } }));
    expect(await publisher.publish({ companyId: COMPANY, entries })).toEqual({ sent: 12, failed: 0 });
    expect(api.requests.map((request) => request.events.length).sort()).toEqual([2, 5, 5]);
    expect(REALTIME_EVENTS_PER_PUBLISH).toBe(5);
    expect(api.requests.every((request) => new Set([request.channel]).size === 1 && request.url === ENDPOINT)).toBe(true);
    for (const request of api.requests) {
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["x-amz-security-token"]).toBe("token-example-0000");
      expect(request.headers["authorization"]).toMatch(/Credential=AKIDEXAMPLE0000\/\d{8}\/us-west-2\/appsync\/aws4_request/u);
      expect(request.events.every((event) => typeof event === "string" && (JSON.parse(event) as { type: string }).type === "home.changed")).toBe(true);
    }
  });

  it("takes the region from the endpoint's host, or from the setting when the host does not say", () => {
    expect(regionOfEndpoint(ENDPOINT)).toBe("us-west-2");
    expect(regionOfEndpoint("http://127.0.0.1:4566/event")).toBeUndefined();
    expect(() => new AppSyncEventsPublisher({ endpoint: "http://127.0.0.1:4566/event", credentials })).toThrow(/region/);
    expect(new AppSyncEventsPublisher({ endpoint: "http://127.0.0.1:4566/event", region: "us-west-2", credentials }).capabilities).toEqual({ remoteListeners: true, entriesPerRequest: 5 });
  });

  it("signs exactly as the AWS SDK's signer does", async () => {
    const at = new Date("2026-11-11T12:34:56.789Z");
    const body = JSON.stringify({ channel: "/rovara/o-00000000000000000000/u/d-" + "0".repeat(40), events: ["{\"type\":\"home.changed\",\"revision\":1}"] });
    for (const sessionToken of ["token-example-0000", undefined]) {
      const creds = { accessKeyId: "AKIDEXAMPLE0000", secretAccessKey: "secret-example-0000", ...(sessionToken === undefined ? {} : { sessionToken }) };
      const ours = signedHeaders({ url: new URL(ENDPOINT), body, region: "us-west-2", service: "appsync", credentials: creds, at });
      const signer = new SignatureV4({ service: "appsync", region: "us-west-2", credentials: creds, sha256: Sha256, applyChecksum: false });
      const theirs = await signer.sign({ method: "POST", protocol: "https:", hostname: new URL(ENDPOINT).host, path: "/event", headers: { host: new URL(ENDPOINT).host, "content-type": "application/json" }, body }, { signingDate: at });
      const lower = Object.fromEntries(Object.entries(theirs.headers).map(([name, value]) => [name.toLowerCase(), value]));
      expect(ours["authorization"]).toBe(lower["authorization"]);
      expect(ours["x-amz-date"]).toBe(lower["x-amz-date"]);
    }
  });
});

describe("failure, deadline and logs", () => {
  const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ audience: { kind: "person", personId: `p${String(index)}` } as const, notice: { type: "home.changed", revision: index } }));

  it("counts the entries of a request that failed as failed and the rest as sent: a partly failing batch", async () => {
    const { api, publisher, logs } = world();
    api.failChannels.add(channelOf("rovara", COMPANY, { kind: "person", personId: "p1" }));
    expect(await publisher.publish({ companyId: COMPANY, entries: entries(3) })).toEqual({ sent: 2, failed: 1 });
    expect(logs).toEqual([{ event: "realtime.publish_failed", channelKind: "person", error: "http_500" }]);
  });

  it("never throws for a lost connection, a service that is down, or credentials that cannot be read", async () => {
    const { api, publisher, logs } = world();
    api.down = "network";
    expect(await publisher.publish({ companyId: COMPANY, entries: entries(2) })).toEqual({ sent: 0, failed: 2 });
    api.down = "no";
    const noCredentials = new AppSyncEventsPublisher({ endpoint: ENDPOINT, credentials: async () => { throw new Error("no AWS credentials for key AKIDSECRETSECRET"); }, fetch: api.fetch, log: (entry) => logs.push(entry) });
    expect(await noCredentials.publish({ companyId: COMPANY, entries: entries(2) })).toEqual({ sent: 0, failed: 2 });
    expect(JSON.stringify(logs)).not.toContain("AKIDSECRET");
    expect(logs.length).toBeGreaterThan(0);
  });

  it("gives up at the deadline: a hung request is aborted, the call returns by then, and what did not finish is failed", async () => {
    const { api, publisher } = world({ deadlineMs: 100 });
    api.down = "hang";
    const started = Date.now();
    expect(await publisher.publish({ companyId: COMPANY, entries: entries(3) })).toEqual({ sent: 0, failed: 3 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("keeps to the batch's own deadline when it is sooner than the adapter's", async () => {
    const { api, publisher } = world({ deadlineMs: 5_000 });
    api.down = "hang";
    const started = Date.now();
    expect(await publisher.publish({ companyId: COMPANY, deadline: Date.now() + 80, entries: entries(1) })).toEqual({ sent: 0, failed: 1 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("logs the kind of channel and the error's name only: never a channel name, a notice or an id", async () => {
    const { api, publisher, logs } = world();
    api.down = "status";
    await publisher.publish({ companyId: COMPANY, entries: [{ audience: { kind: "project", project: "payments-secret-project" }, notice: { type: "session.updated", sessionId: SESSION, revision: 1 } }, { audience: { kind: "session", sessionId: SESSION }, notice: { type: "session.updated", sessionId: SESSION, revision: 1 } }] });
    expect(logs).toEqual([{ event: "realtime.publish_failed", channelKind: "project", error: "http_503" }, { event: "realtime.publish_failed", channelKind: "session", error: "http_503" }]);
    const seen = JSON.stringify(logs);
    for (const secret of [COMPANY.slice(4), "payments", SESSION.slice(4), "aaaaaaaa"]) expect(seen, secret).not.toContain(secret);
  });
});
