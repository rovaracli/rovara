// Plan 4 Task 23: PagerDuty incidents and Sentry issues and alerts start agents and chains through Task 19's signed hook route. Each delivery proves itself over its own bytes
// (PagerDuty: one or more `v1=<hex>` HMAC-SHA256 values in `X-PagerDuty-Signature`, any one of which may match; Sentry: the hex HMAC-SHA256 in `Sentry-Hook-Signature`, keyed with the
// integration's client secret), is checked against the hook's own tenant, and becomes normalised events that only Task 20's dispatch maps to work.
// Layer 1 drives the route with a recording dispatcher. Layer 2 drives it with the real dispatch over the trigger world. Layer 3 reads what the code left in logs: ids and codes only.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_EVENT_KEY_MAX, RUN_START_TITLE_MAX, type ChainDefinitionInput } from "@rovara-code/contracts";
import { hookEventKey } from "@rovara-code/contracts";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import type { HookDelivery } from "../../packages/broker/src/triggers/ingress.js";
import { hookProviders } from "../../packages/broker/src/triggers/providers/index.js";
import { pagerdutyProvider } from "../../packages/broker/src/triggers/providers/pagerduty.js";
import { sentryProvider } from "../../packages/broker/src/triggers/providers/sentry.js";
import type { HookRecord } from "@rovara-code/contracts";
import { HOOK_1, HOOK_2, ORG_A, SECRET_1, SECRET_2, setupHookWorld, type HookWorld } from "../support/hook-fixtures.js";
import { HOOK_A, disposeGateWorlds, setupTriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const SENTRY_UUID = "33333333-3333-4333-8333-333333333333";
const OTHER_SENTRY_UUID = "44444444-4444-4444-8444-444444444444";
const PD_TENANT = { subdomain: "acme" };
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const PROVIDERS = { pagerduty: pagerdutyProvider, sentry: sentryProvider };
const iso = (ms: number): string => new Date(ms).toISOString();

// ---- bodies as the vendors send them (only the fields Rovara reads)
interface PdOver { type?: string; eventId?: string; at?: unknown; host?: string; url?: string | null; incident?: string; title?: unknown; urgency?: unknown; service?: { id?: string; summary?: unknown } | null }
function pdBody(w: HookWorld, over: PdOver = {}): Record<string, unknown> {
  const incident = over.incident ?? "Q2RWWFOIEAQL4V";
  const data: Record<string, unknown> = {
    id: incident, type: "incident", number: 42, status: "triggered", title: over.title ?? "Checkout is down", urgency: over.urgency ?? "high",
    service: over.service === null ? null : { id: over.service?.id ?? "PSVC001", type: "service_reference", summary: over.service?.summary ?? "Payments API" },
  };
  if (over.url !== null) data["html_url"] = over.url ?? `https://${over.host ?? "acme.pagerduty.com"}/incidents/${incident}`;
  return { event: { id: over.eventId ?? "01BXPD0000000000000000EVT1", event_type: over.type ?? "incident.triggered", resource_type: "incident", occurred_at: "at" in over ? over.at : iso(w.clock.now - 5_000), agent: null, client: null, data } };
}
interface SentryOver { resource?: string; action?: string; uuid?: string | null; issueId?: string | number; firstSeen?: unknown; level?: unknown; title?: unknown; webUrl?: unknown; eventId?: string; datetime?: unknown; rule?: unknown; environment?: unknown; tags?: unknown; eventTitle?: unknown }
function sentryIssueBody(w: HookWorld, over: SentryOver = {}): Record<string, unknown> {
  return {
    action: over.action ?? "created", ...(over.uuid === null ? {} : { installation: { uuid: over.uuid ?? SENTRY_UUID } }), actor: { type: "application", id: "sentry", name: "Sentry" },
    data: { issue: { id: over.issueId ?? "1170", shortId: "WEB-1J", title: over.title ?? "TypeError: x is undefined", level: "level" in over ? over.level : "error", status: "unresolved", firstSeen: "firstSeen" in over ? over.firstSeen : iso(w.clock.now - 5_000), web_url: "webUrl" in over ? over.webUrl : "https://acme.sentry.io/issues/1170/", project: { id: "9", slug: "web" } } },
  };
}
function sentryAlertBody(w: HookWorld, over: SentryOver = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_id: over.eventId ?? "e4874d664c3540c1a32eab185f12c5ab", datetime: "datetime" in over ? over.datetime : iso(w.clock.now - 5_000), level: "level" in over ? over.level : "error",
    title: "eventTitle" in over ? over.eventTitle : "TypeError: x is undefined", web_url: "webUrl" in over ? over.webUrl : "https://acme.sentry.io/issues/1170/events/e4874d664c3540c1a32eab185f12c5ab/",
    tags: "tags" in over ? over.tags : [["browser.name", "Chrome"], ["environment", "staging"]],
  };
  if ("environment" in over) event["environment"] = over.environment;
  return { action: over.action ?? "triggered", ...(over.uuid === null ? {} : { installation: { uuid: over.uuid ?? SENTRY_UUID } }), data: { event, triggered_rule: "rule" in over ? over.rule : "Very Important Alert!" }, actor: { type: "application", id: "sentry", name: "Sentry" } };
}

const hex = (secret: string, raw: Buffer, algorithm: "sha256" | "sha1" = "sha256"): string => createHmac(algorithm, secret).update(raw).digest("hex");
interface Signed { secret?: string; header?: string | undefined; raw?: Buffer; ip?: string }
function pdDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: Signed = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  return { source: "pagerduty", hookId: hook.hookId, raw, headers: { "x-pagerduty-signature": "header" in options ? options.header : `v1=${hex(options.secret ?? SECRET_1, raw)}` }, sourceIp: options.ip ?? "203.0.113.7" };
}
function sentryDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: Signed & { resource?: string | undefined } = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string | undefined> = { "sentry-hook-signature": "header" in options ? options.header : hex(options.secret ?? SECRET_1, raw) };
  if (!("resource" in options) || options.resource !== undefined) headers["sentry-hook-resource"] = options.resource ?? "issue";
  return { source: "sentry", hookId: hook.hookId, raw, headers, sourceIp: options.ip ?? "203.0.113.7" };
}
const alertDelivery = (hook: Pick<HookRecord, "hookId">, body: unknown, options: Signed = {}) => sentryDelivery(hook, body, { ...options, resource: "event_alert" });

async function pdWorld(tenant: Record<string, unknown> = PD_TENANT) {
  const w = setupHookWorld(PROVIDERS);
  const hook = await w.hook({ source: "pagerduty", hookId: HOOK_1, project: "web", tenant: tenant as never });
  return { w, hook };
}
async function sentryWorld() {
  const w = setupHookWorld(PROVIDERS);
  const hook = await w.hook({ source: "sentry", hookId: HOOK_1, project: "web", tenant: { installationUuid: SENTRY_UUID } });
  return { w, hook };
}
const noEventItems = (w: HookWorld) => w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"));
const IGNORED = { status: 202, body: { delivery: "IGNORED" } };

describe("PagerDuty: a signed incident.triggered for the hook's account starts one event", () => {
  it("dispatches the event with the incident as the subject, its link, urgency and service, the time from occurred_at and no actor", async () => {
    const { w, hook } = await pdWorld();
    const reply = await w.receive(pdDelivery(hook, pdBody(w, { at: iso(w.clock.now - 90_000) })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "pagerduty", type: "incident.triggered", eventKey: "pd:01BXPD0000000000000000EVT1", project: "web", hookId: hook.hookId, occurredAt: iso(w.clock.now - 90_000),
      subject: { kind: "incident", id: "Q2RWWFOIEAQL4V", title: "Checkout is down", url: "https://acme.pagerduty.com/incidents/Q2RWWFOIEAQL4V" },
      fields: { urgency: ["high"], service: ["Payments API"] }, actor: { kind: "unknown" },
    } });
  });

  it("takes a body with two signatures when the second is valid, and when the first is, with or without a space after the comma", async () => {
    const { w, hook } = await pdWorld();
    const first = pdBody(w, { eventId: "evt-a" });
    const rawFirst = Buffer.from(JSON.stringify(first), "utf8");
    const wrong = `v1=${hex(SECRET_2, rawFirst)}`;
    const right = `v1=${hex(SECRET_1, rawFirst)}`;
    expect((await w.receive(pdDelivery(hook, first, { header: `${wrong}, ${right}` }))).status).toBe(202);
    const second = pdBody(w, { eventId: "evt-b" });
    const rawSecond = Buffer.from(JSON.stringify(second), "utf8");
    expect((await w.receive(pdDelivery(hook, second, { header: `v1=${hex(SECRET_1, rawSecond)},v1=${hex(SECRET_2, rawSecond)}` }))).status).toBe(202);
    const third = pdBody(w, { eventId: "evt-c" });
    const rawThird = Buffer.from(JSON.stringify(third), "utf8");
    expect((await w.receive(pdDelivery(hook, third, { header: `v1=${hex(SECRET_2, rawThird)},v1=${"0".repeat(64)},${`v1=${hex(SECRET_1, rawThird)}`}` }))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.eventKey)).toEqual(["pd:evt-a", "pd:evt-b", "pd:evt-c"]);
  });

  it("answers 403 when no signature is valid: another secret, another body, no v1 value, a missing or empty header, a SHA-1 value, text that is not hex, or bytes re-serialised", async () => {
    const { w, hook } = await pdWorld();
    const body = pdBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const good = hex(SECRET_1, raw);
    const attempts = [
      pdDelivery(hook, body, { secret: SECRET_2 }),
      pdDelivery(hook, body, { header: `v1=${hex(SECRET_1, Buffer.from("{}"))}` }),
      pdDelivery(hook, body, { header: `v1=${hex(SECRET_2, raw)},v1=${hex("another-secret-0123456789", raw)}` }),
      pdDelivery(hook, body, { header: `v0=${good}` }),
      pdDelivery(hook, body, { header: `v2=${good},v0=${good}` }),
      pdDelivery(hook, body, { header: good }),
      pdDelivery(hook, body, { header: `sha256=${good}` }),
      pdDelivery(hook, body, { header: "v1=" }),
      pdDelivery(hook, body, { header: "v1" }),
      pdDelivery(hook, body, { header: "," }),
      pdDelivery(hook, body, { header: "" }),
      pdDelivery(hook, body, { header: undefined }),
      pdDelivery(hook, body, { header: `v1=${hex(SECRET_1, raw, "sha1")}` }),
      pdDelivery(hook, body, { header: "v1=not-hex" }),
      pdDelivery(hook, body, { header: `v1=${good}x` }),
      { ...pdDelivery(hook, body), raw: Buffer.from(JSON.stringify(body, null, 2), "utf8") },
    ];
    for (const attempt of attempts) expect((await w.receive(attempt)).status, String(attempt.headers["x-pagerduty-signature"])).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect((await w.receive(pdDelivery(hook, body))).status).toBe(202);
  });

  it("looks at the first ten signatures only, so a long list is bounded work", async () => {
    const { w, hook } = await pdWorld();
    const body = pdBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const filler = (count: number) => Array.from({ length: count }, (_, index) => `v1=${hex(`filler-secret-${String(index)}-0123456789`, raw)}`);
    const right = `v1=${hex(SECRET_1, raw)}`;
    expect((await w.receive(pdDelivery(hook, body, { header: [...filler(10), right].join(",") }))).status).toBe(403);
    expect((await w.receive(pdDelivery(hook, body, { header: [...filler(9), right].join(",") }))).status).toBe(202);
  });

  it("reads the header whatever the case of its name, the hex in any case and the version prefix in any case, and takes the previous secret during a rotation's overlap", async () => {
    const { w, hook } = await pdWorld();
    const body = pdBody(w, { eventId: "evt-case" });
    const signed = pdDelivery(hook, body);
    expect((await w.receive({ ...signed, headers: { "X-PagerDuty-Signature": signed.headers["x-pagerduty-signature"] } })).status).toBe(202);
    const upper = pdBody(w, { eventId: "evt-upper" });
    const raw = Buffer.from(JSON.stringify(upper), "utf8");
    expect((await w.receive(pdDelivery(hook, upper, { header: `V1=${hex(SECRET_1, raw).toUpperCase()}` }))).status).toBe(202);
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(w.clock.now + 3_600_000) }));
    w.memory.remember(hook.hookId, undefined);
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "evt-prev" })))).status).toBe(202);
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "evt-cur" }), { secret: SECRET_2 }))).status).toBe(202);
  });

  it("answers 403 for an incident on another subdomain, or on a host that only looks like the hook's, starting and remembering nothing", async () => {
    const { w, hook } = await pdWorld();
    const urls = [
      "https://other.pagerduty.com/incidents/Q1",
      "https://acme.pagerduty.com.evil.example/incidents/Q1",
      "https://evilacme.pagerduty.com/incidents/Q1",
      "https://evil.example/incidents/Q1?x=acme.pagerduty.com",
      "https://acme.pagerduty.com@evil.example/incidents/Q1",
      "http://acme.pagerduty.com/incidents/Q1",
      "https://acme.pagerduty.com:8443/incidents/Q1",
      "https://user:pw@acme.pagerduty.com/incidents/Q1",
      "https://acme.eu.pagerduty.com/incidents/Q1",
      "not a link",
      "",
    ];
    for (const url of urls) expect((await w.receive(pdDelivery(hook, pdBody(w, { url })))).status, url).toBe(403);
    const noUrl = pdBody(w, { url: null });
    for (const body of [noUrl, [], "text", null, { event: "x" }, { event: { event_type: "incident.triggered", id: "x", data: [] } }, { events: [] }]) expect((await w.receive(pdDelivery(hook, body))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.tenant_mismatch")).toHaveLength(urls.length + 7);
  });

  it("takes the account's incidents on any service when the hook names none, and only the named services when it does", async () => {
    const { w, hook } = await pdWorld();
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "s1", service: { id: "PANYTHING" } })))).status).toBe(202);
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "s2", service: null })))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.fields)).toEqual([{ urgency: ["high"], service: ["Payments API"] }, { urgency: ["high"], service: [] }]);
    const limited = await w.hook({ source: "pagerduty", hookId: HOOK_2, project: "api", tenant: { subdomain: "acme", serviceIds: ["PSVC001", "PSVC002"] } });
    expect((await w.receive(pdDelivery(limited, pdBody(w, { eventId: "s3", service: { id: "PSVC002" } })))).status).toBe(202);
    expect((await w.receive(pdDelivery(limited, pdBody(w, { eventId: "s4", service: { id: "PSVC009" } })))).status).toBe(403);
    expect((await w.receive(pdDelivery(limited, pdBody(w, { eventId: "s5", service: { id: "psvc001" } })))).status).toBe(403);
    expect((await w.receive(pdDelivery(limited, pdBody(w, { eventId: "s6", service: null })))).status).toBe(403);
    expect(w.dispatched.map((entry) => entry.event.eventKey)).toEqual(["pd:s1", "pd:s2", "pd:s3"]);
  });

  it("ignores, with a 202, every other event type (and the test ping, which has no incident link), and remembers nothing", async () => {
    const { w, hook } = await pdWorld();
    for (const type of ["incident.resolved", "incident.acknowledged", "incident.annotated", "service.created", "pagey.ping", "", "Incident.Triggered"]) {
      expect(await w.receive(pdDelivery(hook, pdBody(w, { type }))), type).toEqual(IGNORED);
    }
    const ping = { event: { id: "ping", event_type: "pagey.ping", resource_type: "pagey", occurred_at: iso(w.clock.now), data: { message: "Hello from your friendly Webhook Subscription!" } } };
    expect(await w.receive(pdDelivery(hook, ping))).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("starts no second event for the same event id, whatever its time or incident, and keeps each project's hook apart", async () => {
    const { w, hook } = await pdWorld();
    expect((await w.receive(pdDelivery(hook, pdBody(w)))).status).toBe(202);
    expect(await w.receive(pdDelivery(hook, pdBody(w, { at: iso(w.clock.now - 500) })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(await w.receive(pdDelivery(hook, pdBody(w, { incident: "QOTHER" })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.db.get(hookEventKey(ORG_A, HOOK_1, "pd:01BXPD0000000000000000EVT1"))).toBeDefined();
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "another" })))).status).toBe(202);
    const second = await w.hook({ source: "pagerduty", hookId: HOOK_2, project: "api", tenant: PD_TENANT });
    expect((await w.receive(pdDelivery(second, pdBody(w)))).status).toBe(202);
    expect(w.dispatched.map((entry) => [entry.event.project, entry.event.eventKey])).toEqual([["web", "pd:01BXPD0000000000000000EVT1"], ["web", "pd:another"], ["api", "pd:01BXPD0000000000000000EVT1"]]);
  });

  it("uses the time the body says: more than a day old is not started, and a time with an offset or fractions is read as the instant it is", async () => {
    const { w, hook } = await pdWorld();
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "old", at: iso(w.clock.now - 25 * 3_600_000) })))).status).toBe(202);
    expect(w.dispatched).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.stale")).toHaveLength(1);
    const local = new Date(w.clock.now - 60_000);
    const plus2 = `${new Date(local.getTime() + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;
    await w.receive(pdDelivery(hook, pdBody(w, { eventId: "offset", at: plus2 })));
    await w.receive(pdDelivery(hook, pdBody(w, { eventId: "fraction", at: `${iso(w.clock.now - 120_000).slice(0, 19)}.123456Z` })));
    expect(w.dispatched.map((entry) => entry.event.occurredAt)).toEqual([iso(Math.floor((w.clock.now - 60_000) / 1000) * 1000), `${iso(w.clock.now - 120_000).slice(0, 19)}.123Z`]);
  });

  it("ignores a signed incident it cannot date or name, instead of failing the vendor's delivery", async () => {
    const { w, hook } = await pdWorld();
    const noTime = pdBody(w);
    delete (noTime["event"] as Record<string, unknown>)["occurred_at"];
    const noEventId = pdBody(w);
    delete (noEventId["event"] as Record<string, unknown>)["id"];
    const noIncidentId = pdBody(w);
    delete ((noIncidentId["event"] as { data: Record<string, unknown> }).data)["id"];
    const bodies = [noTime, noEventId, noIncidentId, pdBody(w, { at: "yesterday" }), pdBody(w, { at: "2026-10-22T10:00:00" }), pdBody(w, { at: 1_700_000_000_000 }), pdBody(w, { at: null }), pdBody(w, { eventId: "" }), pdBody(w, { eventId: "e".repeat(101) })];
    for (const body of bodies) expect(await w.receive(pdDelivery(hook, body))).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("cleans what a person wrote: a title with control characters or over the limit still starts the event, and urgency and service that are not text are left out", async () => {
    const { w, hook } = await pdWorld();
    await w.receive(pdDelivery(hook, pdBody(w, { eventId: "t1", title: `Down\u0000 now‮\n${"x".repeat(500)}`, service: { summary: "Pay\u0000ments" } })));
    await w.receive(pdDelivery(hook, pdBody(w, { eventId: "t2", title: "\u0000\u0007 ", urgency: 7, service: { summary: 5 } })));
    await w.receive(pdDelivery(hook, pdBody(w, { eventId: "t3", title: 12, urgency: ["high"], service: { summary: "s".repeat(300) } })));
    const events = w.dispatched.map((entry) => entry.event);
    expect(events).toHaveLength(3);
    expect([...events[0]!.subject.title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(events[0]!.subject.title).toMatch(/^Down now x+$/);
    expect(events[0]!.subject.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(events[0]!.fields["service"]).toEqual(["Pay\u0000ments"]);
    expect(events[1]!.subject.title).toBe("Q2RWWFOIEAQL4V");
    expect(events[1]!.fields).toEqual({ urgency: [], service: [] });
    expect(events[2]!.subject.title).toBe("Q2RWWFOIEAQL4V");
    expect(events[2]!.fields).toEqual({ urgency: [], service: ["s".repeat(200)] });
  });
});

describe("Sentry: a signed issue or alert for the hook's installation starts one event", () => {
  it("dispatches issue.created with level, the issue as the subject, its Sentry link and the time from firstSeen", async () => {
    const { w, hook } = await sentryWorld();
    const reply = await w.receive(sentryDelivery(hook, sentryIssueBody(w, { firstSeen: iso(w.clock.now - 90_000) })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "sentry", type: "issue.created", eventKey: "sentry:issue:1170:created", project: "web", hookId: hook.hookId, occurredAt: iso(w.clock.now - 90_000),
      subject: { kind: "issue", id: "1170", title: "TypeError: x is undefined", url: "https://acme.sentry.io/issues/1170/" },
      fields: { level: ["error"], environment: [] }, actor: { kind: "unknown" },
    } });
  });

  it("dispatches alert.triggered with the rule in the key, the event as the subject, level and environment, and the time from datetime", async () => {
    const { w, hook } = await sentryWorld();
    const reply = await w.receive(alertDelivery(hook, sentryAlertBody(w, { datetime: `${iso(w.clock.now - 90_000).slice(0, 19)}.677000Z` })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "sentry", type: "alert.triggered", eventKey: "sentry:alert:e4874d664c3540c1a32eab185f12c5ab:Very Important Alert!", project: "web", hookId: hook.hookId,
      occurredAt: `${iso(w.clock.now - 90_000).slice(0, 19)}.677Z`,
      subject: { kind: "alert", id: "e4874d664c3540c1a32eab185f12c5ab", title: "Very Important Alert!: TypeError: x is undefined", url: "https://acme.sentry.io/issues/1170/events/e4874d664c3540c1a32eab185f12c5ab/" },
      fields: { level: ["error"], environment: ["staging"] }, actor: { kind: "unknown" },
    } });
  });

  it("reads the environment from the event's own field before its tags, and finds none when neither names one", async () => {
    const { w, hook } = await sentryWorld();
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "a1", environment: "production" })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "a2", tags: [["browser.name", "Chrome"]] })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "a3", tags: "environment" })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "a4", tags: [["environment"], [7, "x"], "environment", null, ["environment", 5], ["environment", "qa"]] })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "a5", environment: 7, tags: [["environment", "dev"]] })));
    expect(w.dispatched.map((entry) => entry.event.fields["environment"])).toEqual([["production"], [], [], ["qa"], ["dev"]]);
  });

  it("names the alert by the rule alone when the event has no title, and falls back to the event id when the rule is not text", async () => {
    const { w, hook } = await sentryWorld();
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "b1", eventTitle: undefined })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "b2", eventTitle: "" })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "b3", rule: "\u0000\u0007 ", eventTitle: 5 })));
    expect(w.dispatched.map((entry) => entry.event.subject.title)).toEqual(["Very Important Alert!", "Very Important Alert!", "b3"]);
  });

  it("answers 403 for another installation's uuid on every kind of body, and for a body with none, starting and remembering nothing", async () => {
    const { w, hook } = await sentryWorld();
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { uuid: OTHER_SENTRY_UUID })))).status).toBe(403);
    expect((await w.receive(alertDelivery(hook, sentryAlertBody(w, { uuid: OTHER_SENTRY_UUID })))).status).toBe(403);
    // The tenant is read first: another installation's body of a kind that is ignored is refused as well.
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { uuid: OTHER_SENTRY_UUID }), { resource: "installation" }))).status).toBe(403);
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { uuid: OTHER_SENTRY_UUID, action: "resolved" })))).status).toBe(403);
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { uuid: OTHER_SENTRY_UUID }), { resource: undefined }))).status).toBe(403);
    for (const body of [sentryIssueBody(w, { uuid: null }), { ...sentryIssueBody(w), installation: {} }, { ...sentryIssueBody(w), installation: "x" }, { ...sentryIssueBody(w), installation: { uuid: 7 } }, [], "text", null]) {
      expect((await w.receive(sentryDelivery(hook, body))).status).toBe(403);
    }
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.tenant_mismatch")).toHaveLength(12);
  });

  it("matches the installation uuid without regard to case", async () => {
    const { w, hook } = await sentryWorld();
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { uuid: SENTRY_UUID.toUpperCase() })))).status).toBe(202);
  });

  it("ignores, with a 202, an installation resource of the hook's own installation, other resources, other actions and a missing or differently spelled resource header", async () => {
    const { w, hook } = await sentryWorld();
    for (const resource of ["installation", "comment", "metric_alert", "error", "seer", "preprod_artifact", "Issue", "event_alert ", ""]) {
      expect(await w.receive(sentryDelivery(hook, sentryIssueBody(w), { resource })), resource).toEqual(IGNORED);
    }
    expect(await w.receive(sentryDelivery(hook, sentryIssueBody(w), { resource: undefined }))).toEqual(IGNORED);
    for (const action of ["resolved", "assigned", "archived", "unresolved", "Created", ""]) expect(await w.receive(sentryDelivery(hook, sentryIssueBody(w, { action }))), action).toEqual(IGNORED);
    // An issue action on the alert resource, and an alert action on the issue resource, are not events either.
    expect(await w.receive(alertDelivery(hook, sentryIssueBody(w)))).toEqual(IGNORED);
    expect(await w.receive(sentryDelivery(hook, sentryAlertBody(w)))).toEqual(IGNORED);
    expect(await w.receive(alertDelivery(hook, sentryAlertBody(w, { action: "resolved" })))).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("refuses a bad signature: another secret, another body, a missing or malformed header, a prefixed value, re-serialised bytes", async () => {
    const { w, hook } = await sentryWorld();
    const body = sentryIssueBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const attempts = [
      sentryDelivery(hook, body, { secret: SECRET_2 }),
      sentryDelivery(hook, body, { header: hex(SECRET_1, Buffer.from("{}")) }),
      sentryDelivery(hook, body, { header: undefined }),
      sentryDelivery(hook, body, { header: "" }),
      sentryDelivery(hook, body, { header: `sha256=${hex(SECRET_1, raw)}` }),
      sentryDelivery(hook, body, { header: `v1=${hex(SECRET_1, raw)}` }),
      sentryDelivery(hook, body, { header: "not-hex" }),
      sentryDelivery(hook, body, { header: hex(SECRET_1, raw, "sha1") }),
      { ...sentryDelivery(hook, body), raw: Buffer.from(JSON.stringify(body, null, 2), "utf8") },
    ];
    for (const attempt of attempts) expect((await w.receive(attempt)).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect((await w.receive(sentryDelivery(hook, body))).status).toBe(202);
  });

  it("reads the headers whatever the case of their names, takes the hex in any case, and the previous secret during a rotation's overlap", async () => {
    const { w, hook } = await sentryWorld();
    const first = sentryDelivery(hook, sentryIssueBody(w, { issueId: "c1" }));
    expect((await w.receive({ ...first, headers: { "Sentry-Hook-Signature": first.headers["sentry-hook-signature"], "Sentry-Hook-Resource": "issue" } })).status).toBe(202);
    const upper = sentryIssueBody(w, { issueId: "c2" });
    const raw = Buffer.from(JSON.stringify(upper), "utf8");
    expect((await w.receive(sentryDelivery(hook, upper, { header: hex(SECRET_1, raw).toUpperCase() }))).status).toBe(202);
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(w.clock.now + 3_600_000) }));
    w.memory.remember(hook.hookId, undefined);
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "c3" })))).status).toBe(202);
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "c4" }), { secret: SECRET_2 }))).status).toBe(202);
  });

  it("starts no second event for the same issue (a replay with a new time is a duplicate), per hook; an alert is one per event and rule", async () => {
    const { w, hook } = await sentryWorld();
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w)))).status).toBe(202);
    expect(await w.receive(sentryDelivery(hook, sentryIssueBody(w, { firstSeen: iso(w.clock.now - 500) })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.db.get(hookEventKey(ORG_A, HOOK_1, "sentry:issue:1170:created"))).toBeDefined();
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: 1171 })))).status).toBe(202);
    expect(w.dispatched[1]!.event.eventKey).toBe("sentry:issue:1171:created");
    const second = await w.hook({ source: "sentry", hookId: HOOK_2, project: "api", tenant: { installationUuid: SENTRY_UUID } });
    expect((await w.receive(sentryDelivery(second, sentryIssueBody(w)))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.project)).toEqual(["web", "web", "api"]);
    expect((await w.receive(alertDelivery(hook, sentryAlertBody(w)))).status).toBe(202);
    expect((await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule: "Another rule" })))).status).toBe(202);
    expect(await w.receive(alertDelivery(hook, sentryAlertBody(w, { datetime: iso(w.clock.now - 1_000) })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(5);
  });

  it("keeps the event key within what a run may carry when a rule is long or holds control characters, by naming the rule with its hash, and still tells rules apart", async () => {
    const { w, hook } = await sentryWorld();
    const long = "r".repeat(300);
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule: long })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule: `${long}!` })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule: "bad\u0000rule" })));
    await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule: "r".repeat(100) })));
    expect(await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule: long })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    const keys = w.dispatched.map((entry) => entry.event.eventKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect([...key].length).toBeLessThanOrEqual(RUN_EVENT_KEY_MAX);
    expect(keys[0]).toMatch(/^sentry:alert:e4874d664c3540c1a32eab185f12c5ab:sha256-[0-9a-f]{16}$/);
    expect(keys[2]).toMatch(/^sentry:alert:e4874d664c3540c1a32eab185f12c5ab:sha256-[0-9a-f]{16}$/);
    expect(keys[3]).toBe(`sentry:alert:e4874d664c3540c1a32eab185f12c5ab:${"r".repeat(100)}`);
    expect(keys[0]).not.toContain("rrrr");
  });

  it("uses the time the body says: more than a day old is not started", async () => {
    const { w, hook } = await sentryWorld();
    expect((await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "old", firstSeen: iso(w.clock.now - 25 * 3_600_000) })))).status).toBe(202);
    expect((await w.receive(alertDelivery(hook, sentryAlertBody(w, { eventId: "dead", datetime: iso(w.clock.now - 25 * 3_600_000) })))).status).toBe(202);
    expect(w.dispatched).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.stale")).toHaveLength(2);
    await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "fresh", firstSeen: iso(w.clock.now - 23 * 3_600_000) })));
    expect(w.dispatched).toHaveLength(1);
  });

  it("ignores a signed issue or alert it cannot read, instead of failing the vendor's delivery", async () => {
    const { w, hook } = await sentryWorld();
    const noIssueId = sentryIssueBody(w);
    delete ((noIssueId["data"] as { issue: Record<string, unknown> }).issue)["id"];
    const noIssue = { ...sentryIssueBody(w), data: {} };
    const noEvent = { ...sentryAlertBody(w), data: { triggered_rule: "r" } };
    const noEventId = sentryAlertBody(w);
    delete (((noEventId["data"] as { event: Record<string, unknown> }).event))["event_id"];
    const issues = [noIssueId, noIssue, sentryIssueBody(w, { firstSeen: undefined }), sentryIssueBody(w, { firstSeen: "soon" }), sentryIssueBody(w, { firstSeen: "2026-10-22T10:00:00" }), sentryIssueBody(w, { firstSeen: 1_700_000_000_000 }), sentryIssueBody(w, { issueId: "bad id!" }), sentryIssueBody(w, { issueId: "" }), sentryIssueBody(w, { issueId: -1 }), sentryIssueBody(w, { issueId: 1.5 })];
    const alerts = [noEvent, noEventId, sentryAlertBody(w, { rule: undefined }), sentryAlertBody(w, { rule: "" }), sentryAlertBody(w, { rule: 5 }), sentryAlertBody(w, { datetime: undefined }), sentryAlertBody(w, { datetime: "soon" }), sentryAlertBody(w, { eventId: "bad id!" }), sentryAlertBody(w, { eventId: "" }), sentryAlertBody(w, { eventId: "e".repeat(65) })];
    for (const body of issues) expect(await w.receive(sentryDelivery(hook, body)), JSON.stringify(body)).toEqual(IGNORED);
    for (const body of alerts) expect(await w.receive(alertDelivery(hook, body)), JSON.stringify(body)).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("takes an issue id sent as a number, and leaves the link and the level out when they are not what Sentry sends", async () => {
    const { w, hook } = await sentryWorld();
    await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: 99 })));
    const bad = ["http://acme.sentry.io/issues/1/", "https://acme.sentry.io:8443/issues/1/", "https://user:pw@acme.sentry.io/issues/1/", "https://evil.example/sentry.io", "https://sentry.io.evil.example/x", "https://notsentry.io/x", "ftp://sentry.io/x", "not a link", 5, null];
    for (const [index, webUrl] of bad.entries()) await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: `u${String(index)}`, webUrl, level: index % 2 === 0 ? 7 : null })));
    await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "d1", webUrl: "https://de.sentry.io/issues/1/" })));
    await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "d2", webUrl: "https://sentry.io/organizations/acme/issues/1/" })));
    const events = w.dispatched.map((entry) => entry.event);
    expect(events[0]).toMatchObject({ eventKey: "sentry:issue:99:created", subject: { id: "99" } });
    for (const event of events.slice(1, 11)) {
      expect(event.subject.url).toBeUndefined();
      expect(event.fields["level"]).toEqual([]);
    }
    expect(events[11]!.subject.url).toBe("https://de.sentry.io/issues/1/");
    expect(events[12]!.subject.url).toBe("https://sentry.io/organizations/acme/issues/1/");
  });

  it("cleans the title a person wrote and keeps level values to text", async () => {
    const { w, hook } = await sentryWorld();
    await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "t1", title: `Boom\u0000 here‮\n${"x".repeat(500)}`, level: "fatal" })));
    await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: "t2", title: "\u0000\u0007 ", level: "l".repeat(300) })));
    const events = w.dispatched.map((entry) => entry.event);
    expect([...events[0]!.subject.title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(events[0]!.subject.title).toMatch(/^Boom here x+$/);
    expect(events[0]!.subject.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(events[0]!.fields["level"]).toEqual(["fatal"]);
    expect(events[1]!.subject.title).toBe("t2");
    expect(events[1]!.fields["level"]).toEqual(["l".repeat(200)]);
  });
});

describe("the providers are the ones the broker uses", () => {
  it("registers PagerDuty and Sentry (vendor secrets, hmac) beside Linear and Jira", () => {
    const providers = hookProviders();
    expect(providers.pagerduty).toBe(pagerdutyProvider);
    expect(providers.sentry).toBe(sentryProvider);
    expect([pagerdutyProvider.secretOrigin, pagerdutyProvider.auth, pagerdutyProvider.source]).toEqual(["vendor", "hmac", "pagerduty"]);
    expect([sentryProvider.secretOrigin, sentryProvider.auth, sentryProvider.source]).toEqual(["vendor", "hmac", "sentry"]);
    expect(Object.keys(providers).sort()).toEqual(["cloudwatch", "datadog", "grafana", "jira", "linear", "pagerduty", "sentry", "vercel"]);
  });

  it("refuses to read a hook of another source: each provider answers a tenant mismatch for the other's hook", async () => {
    const { w, hook } = await sentryWorld();
    const pd = await w.hook({ source: "pagerduty", hookId: HOOK_2, project: "web", tenant: PD_TENANT });
    expect(pagerdutyProvider.normalize(pdBody(w), {}, hook)).toEqual({ tenantMismatch: true });
    expect(sentryProvider.normalize(sentryIssueBody(w), { "sentry-hook-resource": "issue" }, pd)).toEqual({ tenantMismatch: true });
  });

  it("never throws on a delivery it cannot verify: a verification of anything answers false", () => {
    for (const provider of [pagerdutyProvider, sentryProvider]) {
      expect(provider.verify(Buffer.from("{}"), {}, SECRET_1)).toBe(false);
      expect(provider.verify(Buffer.from("{}"), { "x-pagerduty-signature": "v1=00", "sentry-hook-signature": "00" }, "")).toBe(false);
    }
  });
});

// ---- layer 2: the real dispatch
describe("through Task 20's dispatch: one run per event, the filters, and no actor guard for sources Rovara only reads", () => {
  async function dispatching() {
    const v = setupTriggerWorld();
    (v.routeDeps as { log?: unknown }).log = () => undefined;
    const w = setupHookWorld(PROVIDERS, { db: v.db, clock: v.clock });
    w.deps.dispatch = async (orgId, event) => dispatchTriggerEvent(v.routeDeps as never, orgId, event);
    const chain = await v.budgetedChain(ONE_STEP);
    const runs = () => v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META");
    const pdHook = await w.hook({ source: "pagerduty", hookId: HOOK_A, project: "web", tenant: PD_TENANT });
    v.hook("pagerduty", HOOK_A);
    const sentryHook = await w.hook({ source: "sentry", hookId: HOOK_2, project: "web", tenant: { installationUuid: SENTRY_UUID } });
    v.hook("sentry", HOOK_2);
    return { v, w, chain, runs, pdHook, sentryHook };
  }
  const outcomes = async (v: Awaited<ReturnType<typeof dispatching>>["v"], triggerId: string) => (await v.triggers.listActivity(ORG_A, triggerId)).map((entry) => [entry.outcome, entry.reason]);

  it("starts one chain run for a PagerDuty incident whose urgency the trigger asks for, once, and none for a low one", async () => {
    const { v, w, chain, runs, pdHook } = await dispatching();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "pagerduty", type: "incident.triggered", filter: { urgency: ["high"] } }, hookId: HOOK_A });
    expect((await w.receive(pdDelivery(pdHook, pdBody(w, { eventId: "low", urgency: "low" })))).status).toBe(202);
    expect(runs()).toEqual([]);
    expect((await w.receive(pdDelivery(pdHook, pdBody(w, { eventId: "high", urgency: "high" })))).status).toBe(202);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ origin: "event", project: "web", startedBy: { kind: "event", triggerId: trigger.triggerId, source: "pagerduty", type: "incident.triggered", title: "Checkout is down", url: "https://acme.pagerduty.com/incidents/Q2RWWFOIEAQL4V" } });
    expect(await w.receive(pdDelivery(pdHook, pdBody(w, { eventId: "high", urgency: "high", at: iso(w.clock.now - 1_000) })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(runs()).toHaveLength(1);
    expect(await outcomes(v, trigger.triggerId)).toEqual([["started", undefined]]);
  });

  it("starts one chain run for a Sentry issue at the level the trigger asks for, and for an alert the same way", async () => {
    const { v, w, chain, runs, sentryHook } = await dispatching();
    const issue = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "sentry", type: "issue.created", filter: { level: ["error", "fatal"] } }, hookId: HOOK_2 });
    const alert = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "sentry", type: "alert.triggered", filter: { environment: ["staging"] } }, hookId: HOOK_2 });
    await w.receive(sentryDelivery(sentryHook, sentryIssueBody(w, { issueId: "warn", level: "warning" })));
    expect(runs()).toEqual([]);
    await w.receive(sentryDelivery(sentryHook, sentryIssueBody(w, { issueId: "err", level: "Error" })));
    expect(runs()).toHaveLength(1);
    await w.receive(alertDelivery(sentryHook, sentryAlertBody(w, { eventId: "prod", tags: [["environment", "production"]] })));
    expect(runs()).toHaveLength(1);
    await w.receive(alertDelivery(sentryHook, sentryAlertBody(w, { eventId: "stage" })));
    expect(runs()).toHaveLength(2);
    expect(await outcomes(v, issue.triggerId)).toEqual([["started", undefined]]);
    expect(await outcomes(v, alert.triggerId)).toEqual([["started", undefined]]);
    expect(runs().map((run) => (run["startedBy"] as { source: string; type: string }).type).sort()).toEqual(["alert.triggered", "issue.created"]);
  });

  it("does not let another account's or installation's body reach dispatch", async () => {
    const { w, runs, pdHook, sentryHook } = await dispatching();
    expect((await w.receive(pdDelivery(pdHook, pdBody(w, { host: "other.pagerduty.com" })))).status).toBe(403);
    expect((await w.receive(sentryDelivery(sentryHook, sentryIssueBody(w, { uuid: OTHER_SENTRY_UUID })))).status).toBe(403);
    expect(runs()).toEqual([]);
  });
});

// ---- layer 3: what is logged
describe("nothing a sender wrote reaches a log", () => {
  const MARK = "SECRET-MARKER-5d2c";

  it("keeps the titles, names, ids, rules and links of PagerDuty and Sentry bodies out of every log line, on every path", async () => {
    const { w, hook } = await pdWorld();
    const sentry = await w.hook({ source: "sentry", hookId: HOOK_2, project: "web", tenant: { installationUuid: SENTRY_UUID } });
    const marked = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(body).replaceAll("Checkout is down", `${MARK}-title`).replaceAll("Payments API", `${MARK}-service`).replaceAll("TypeError: x is undefined", `${MARK}-error`).replaceAll("Very Important Alert!", `${MARK}-rule`)) as Record<string, unknown>;
    const attempts: HookDelivery[] = [
      pdDelivery(hook, marked(pdBody(w))),
      pdDelivery(hook, marked(pdBody(w, { eventId: `${MARK}-evt2`, host: "other.pagerduty.com" }))),
      pdDelivery(hook, marked(pdBody(w, { eventId: `${MARK}-evt3`, type: "incident.resolved" }))),
      pdDelivery(hook, marked(pdBody(w, { eventId: `${MARK}-evt4` })), { secret: SECRET_2 }),
      pdDelivery(hook, marked(pdBody(w, { eventId: `${MARK}-evt5`, at: "bad" }))),
      pdDelivery(hook, marked(pdBody(w, { eventId: `${MARK}-evt6`, at: iso(w.clock.now - 30 * 3_600_000) }))),
      sentryDelivery(sentry, marked(sentryIssueBody(w))),
      sentryDelivery(sentry, marked(sentryIssueBody(w, { uuid: OTHER_SENTRY_UUID, issueId: `${MARK}-i2` }))),
      sentryDelivery(sentry, marked(sentryIssueBody(w, { action: "resolved" }))),
      sentryDelivery(sentry, marked(sentryIssueBody(w, { issueId: `${MARK}-i4` })), { secret: SECRET_2 }),
      sentryDelivery(sentry, marked(sentryIssueBody(w, { issueId: "i5", firstSeen: "bad" }))),
      sentryDelivery(sentry, marked(sentryIssueBody(w, { issueId: "i6", firstSeen: iso(w.clock.now - 30 * 3_600_000) }))),
      alertDelivery(sentry, marked(sentryAlertBody(w, { rule: `${MARK}-longrule${"x".repeat(200)}` }))),
    ];
    for (const attempt of attempts) await w.receive(attempt);
    // A positive control: the paths ran (events accepted, a tenant refused, old ones dropped) and logged their ids and codes.
    expect(w.dispatched).toHaveLength(3);
    expect(w.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["hook.tenant_mismatch", "hook.stale"]));
    expect(JSON.stringify(w.logs)).not.toContain(MARK);
    expect(JSON.stringify(w.logs)).not.toContain("occurred_at");
    expect(JSON.stringify(w.logs)).not.toContain("firstSeen");
  });
});

// ---- pins found by the mutation pass: each of these fails when the guard it names is changed
describe("pins: the edges of what each provider reads", () => {
  it("PagerDuty reads a signature value only as a whole `v1=<hex>`, never one with text before it", async () => {
    const { w, hook } = await pdWorld();
    const body = pdBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    for (const header of [`x v1=${hex(SECRET_1, raw)}`, `abcv1=${hex(SECRET_1, raw)}`]) {
      expect((await w.receive(pdDelivery(hook, body, { raw, header }))).status).toBe(403);
    }
    expect(w.dispatched).toEqual([]);
  });

  it("PagerDuty bounds what it reads: an event type or an incident link longer than the limit is not this hook's body", async () => {
    const { w, hook } = await pdWorld();
    const longType = pdBody(w, { type: `incident.${"x".repeat(100)}` });
    expect((await w.receive(pdDelivery(hook, longType))).status).toBe(403);
    const longLink = pdBody(w, { eventId: "long-link", url: `https://acme.pagerduty.com/incidents/${"a".repeat(2100)}` });
    expect((await w.receive(pdDelivery(hook, longLink))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
  });

  it("a Sentry hook is never read as a PagerDuty one, even for a body from a host named like the missing subdomain", async () => {
    const { w, hook } = await sentryWorld();
    expect(pagerdutyProvider.normalize(pdBody(w, { host: "undefined.pagerduty.com" }), {}, hook)).toEqual({ tenantMismatch: true });
  });

  it("reads a time only as a whole ISO date and time with a zone: no text before or after it, a lower-case t and z are fine, and a date that does not exist is ignored", async () => {
    const { w, hook } = await pdWorld();
    const good = iso(w.clock.now - 5_000);
    for (const [index, at] of [`x${good}`, `${good} later`, "2026-13-45T10:00:00Z", [good], { toString: () => good }, 5, null].entries()) {
      expect(await w.receive(pdDelivery(hook, pdBody(w, { eventId: `bad${String(index)}`, at })))).toEqual(IGNORED);
    }
    expect(w.dispatched).toEqual([]);
    expect((await w.receive(pdDelivery(hook, pdBody(w, { eventId: "lower", at: good.toLowerCase() })))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.occurredAt)).toEqual([good]);
  });

  it("Sentry keeps a rule in the key up to 100 characters (counting each emoji once) and names it by its hash from 101, or when it holds an invisible character", async () => {
    const { w, hook } = await sentryWorld();
    const emoji = "\u{1F600}".repeat(60);
    for (const rule of ["r".repeat(101), emoji, "a​b"]) await w.receive(alertDelivery(hook, sentryAlertBody(w, { rule })));
    const keys = w.dispatched.map((entry) => entry.event.eventKey);
    expect(keys[0]).toMatch(/:sha256-[0-9a-f]{16}$/);
    expect(keys[1]).toBe(`sentry:alert:e4874d664c3540c1a32eab185f12c5ab:${emoji}`);
    expect(keys[2]).toMatch(/:sha256-[0-9a-f]{16}$/);
  });

  it("Sentry takes a link only without a user name or a password in it", async () => {
    const { w, hook } = await sentryWorld();
    for (const [index, webUrl] of ["https://user@sentry.io/x", "https://:pw@sentry.io/x"].entries()) await w.receive(sentryDelivery(hook, sentryIssueBody(w, { issueId: `n${String(index)}`, webUrl })));
    expect(w.dispatched).toHaveLength(2);
    for (const entry of w.dispatched) expect(entry.event.subject.url).toBeUndefined();
  });

  it("Sentry matches the installation uuid in either case, whichever side is in capitals", async () => {
    const w = setupHookWorld(PROVIDERS);
    const lower = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const lowerHook = await w.hook({ source: "sentry", hookId: HOOK_1, project: "web", tenant: { installationUuid: lower } });
    const upperHook = await w.hook({ source: "sentry", hookId: HOOK_2, project: "web", tenant: { installationUuid: lower.toUpperCase() } });
    expect((await w.receive(sentryDelivery(lowerHook, sentryIssueBody(w, { uuid: lower.toUpperCase(), issueId: "c1" })))).status).toBe(202);
    expect((await w.receive(sentryDelivery(upperHook, sentryIssueBody(w, { uuid: lower, issueId: "c2" })))).status).toBe(202);
  });
});
