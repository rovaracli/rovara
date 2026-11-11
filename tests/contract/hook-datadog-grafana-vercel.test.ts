// Plan 4 Task 24: Datadog monitors, Grafana alerts and Vercel deploys start agents and chains through Task 19's hook route.
// Datadog signs nothing, so the hook's own token travels in the custom header `X-Rovara-Hook-Token`; Grafana's contact point sends `Authorization: Bearer <token>` (and has an
// HMAC-SHA256 body signature option); Vercel signs the raw body with HMAC-SHA1 in `x-vercel-signature`. Every secret is compared as digests in constant time (`tokenEquals`,
// `hmacHexEquals`). Layer 1 drives the route with a recording dispatcher. Layer 2 drives it with the real dispatch. Layer 3 reads what the code left in logs.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOOK_MAX_EVENTS_PER_DELIVERY, HOOK_BODY_MAX_BYTES, hookEventKey } from "@rovara-code/contracts";
import { RUN_START_TITLE_MAX, type ChainDefinitionInput } from "@rovara-code/contracts";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import type { HookDelivery } from "../../packages/broker/src/triggers/ingress.js";
import { hookProviders } from "../../packages/broker/src/triggers/providers/index.js";
import { datadogProvider, DATADOG_PAYLOAD_TEMPLATE } from "../../packages/broker/src/triggers/providers/datadog.js";
import { grafanaProvider } from "../../packages/broker/src/triggers/providers/grafana.js";
import { vercelProvider } from "../../packages/broker/src/triggers/providers/vercel.js";
import type * as TypesModule from "../../packages/broker/src/triggers/providers/types.js";
import { hmacHexEquals, tokenEquals } from "../../packages/broker/src/triggers/providers/types.js";
import type { HookRecord } from "@rovara-code/contracts";
import { HOOK_1, HOOK_2, ORG_A, SECRET_1, SECRET_2, setupHookWorld, type HookWorld } from "../support/hook-fixtures.js";
import { HOOK_A, DANA, disposeGateWorlds, setupTriggerWorld } from "../support/trigger-world.js";

// The comparison functions pass through to the real ones; the spies show that a provider compares a secret only through them.
vi.mock("../../packages/broker/src/triggers/providers/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TypesModule>();
  return { ...actual, tokenEquals: vi.fn(actual.tokenEquals), hmacHexEquals: vi.fn(actual.hmacHexEquals) };
});

afterEach(disposeGateWorlds);

const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const PROVIDERS = { datadog: datadogProvider, grafana: grafanaProvider, vercel: vercelProvider };
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3_600_000;
const IGNORED = { status: 202, body: { delivery: "IGNORED" } };
const DD_TENANT = { datadogOrgId: "1234" };
const GF_TENANT = { host: "grafana.acme.com" };
const VC_TENANT = { teamId: "team_abc", projectId: "prj_123" };
const noEventItems = (w: HookWorld) => w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"));
const hex = (secret: string, raw: Buffer, algorithm: "sha256" | "sha1" = "sha256"): string => createHmac(algorithm, secret).update(raw).digest("hex");

// ---- Datadog
interface DdOver { id?: string; date?: unknown; transition?: unknown; alertId?: unknown; title?: unknown; priority?: unknown; tags?: unknown; link?: unknown; orgId?: unknown }
function ddBody(w: HookWorld, over: DdOver = {}): Record<string, unknown> {
  return {
    id: over.id ?? "1234567", date: "date" in over ? over.date : String(w.clock.now - 5_000), transition: "transition" in over ? over.transition : "Triggered", alertId: "alertId" in over ? over.alertId : "1234",
    title: "title" in over ? over.title : "[Triggered on {host:web-1}] CPU is high", priority: "priority" in over ? over.priority : "normal", tags: "tags" in over ? over.tags : "monitor, name:myService, role:computing-node",
    link: "link" in over ? over.link : "https://app.datadoghq.com/event/jump_to?event_id=123456", orgId: "orgId" in over ? over.orgId : "1234",
  };
}
interface Tokened { token?: string | undefined; header?: string; raw?: Buffer; ip?: string }
function ddDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: Tokened = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  const token = "token" in options ? options.token : SECRET_1;
  const headers: Record<string, string | undefined> = {};
  if (token !== undefined) headers[options.header ?? "x-rovara-hook-token"] = token;
  return { source: "datadog", hookId: hook.hookId, raw, headers, sourceIp: options.ip ?? "203.0.113.7" };
}
async function ddWorld(tenant: Record<string, unknown> = DD_TENANT) {
  const w = setupHookWorld(PROVIDERS);
  const hook = await w.hook({ source: "datadog", hookId: HOOK_1, project: "web", tenant: tenant as never });
  return { w, hook };
}

// ---- Grafana
interface GfAlert { status?: string; fingerprint?: unknown; startsAt?: unknown; labels?: unknown; annotations?: unknown; generatorURL?: unknown }
function gfAlert(w: HookWorld, over: GfAlert = {}): Record<string, unknown> {
  return {
    status: over.status ?? "firing", labels: "labels" in over ? over.labels : { alertname: "HighCPU", severity: "critical", instance: "web-1" },
    annotations: "annotations" in over ? over.annotations : { summary: "CPU is high on web-1" }, startsAt: "startsAt" in over ? over.startsAt : iso(w.clock.now - 60_000),
    endsAt: "0001-01-01T00:00:00Z", generatorURL: "generatorURL" in over ? over.generatorURL : "https://grafana.acme.com/alerting/grafana/abc/view", fingerprint: "fingerprint" in over ? over.fingerprint : "c6b2ad6b8a2bb3a0",
  };
}
function gfBody(w: HookWorld, alerts: Array<Record<string, unknown>> = [gfAlert(w)], over: { externalURL?: unknown } = {}): Record<string, unknown> {
  return { receiver: "rovara", status: "firing", orgId: 1, alerts, groupLabels: {}, commonLabels: {}, commonAnnotations: {}, externalURL: "externalURL" in over ? over.externalURL : "https://grafana.acme.com/", version: "1", groupKey: "{}:{}", truncatedAlerts: 0, state: "alerting", title: "x", message: "y" };
}
interface GfSigned { authorization?: string | undefined; signature?: string | undefined; raw?: Buffer; ip?: string }
function gfDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: GfSigned = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string | undefined> = {};
  const authorization = "authorization" in options ? options.authorization : `Bearer ${SECRET_1}`;
  if (authorization !== undefined) headers["authorization"] = authorization;
  if (options.signature !== undefined) headers["x-grafana-alerting-signature"] = options.signature;
  return { source: "grafana", hookId: hook.hookId, raw, headers, sourceIp: options.ip ?? "203.0.113.7" };
}
async function gfWorld(tenant: Record<string, unknown> = GF_TENANT) {
  const w = setupHookWorld(PROVIDERS);
  const hook = await w.hook({ source: "grafana", hookId: HOOK_1, project: "web", tenant: tenant as never });
  return { w, hook };
}

// ---- Vercel
interface VcOver { id?: string; type?: string; createdAt?: unknown; team?: unknown; project?: unknown; target?: unknown; deployment?: unknown; links?: unknown }
function vcBody(w: HookWorld, over: VcOver = {}): Record<string, unknown> {
  return {
    id: over.id ?? "hook_abc123", type: over.type ?? "deployment.error", createdAt: "createdAt" in over ? over.createdAt : w.clock.now - 5_000, region: "sfo1",
    payload: {
      team: "team" in over ? over.team : { id: "team_abc" }, user: { id: "user_1" }, deployment: "deployment" in over ? over.deployment : { id: "dpl_9x", meta: {}, url: "acme-web-abc.vercel.app", name: "acme-web" },
      links: "links" in over ? over.links : { deployment: "https://vercel.com/acme/acme-web/9x", project: "https://vercel.com/acme/acme-web" }, target: "target" in over ? over.target : "production",
      project: "project" in over ? over.project : { id: "prj_123" }, plan: "pro", regions: ["sfo1"],
    },
  };
}
interface VcSigned { secret?: string; algorithm?: "sha256" | "sha1"; header?: string | undefined; raw?: Buffer; ip?: string }
function vcDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: VcSigned = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  return { source: "vercel", hookId: hook.hookId, raw, headers: { "x-vercel-signature": "header" in options ? options.header : hex(options.secret ?? SECRET_1, raw, options.algorithm ?? "sha1") }, sourceIp: options.ip ?? "203.0.113.7" };
}
async function vcWorld(tenant: Record<string, unknown> = VC_TENANT) {
  const w = setupHookWorld(PROVIDERS);
  const hook = await w.hook({ source: "vercel", hookId: HOOK_1, project: "web", tenant: tenant as never });
  return { w, hook };
}

describe("Datadog: an unsigned webhook is proven by the hook's token in X-Rovara-Hook-Token", () => {
  it("dispatches a Triggered monitor with the monitor as the subject, its priority and tags, the time from the epoch-millisecond date and no actor", async () => {
    const { w, hook } = await ddWorld();
    const reply = await w.receive(ddDelivery(hook, ddBody(w, { date: String(w.clock.now - 90_000) })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "datadog", type: "monitor.triggered", eventKey: "dd:1234567", project: "web", hookId: hook.hookId, occurredAt: iso(w.clock.now - 90_000),
      subject: { kind: "alert", id: "1234", title: "[Triggered on {host:web-1}] CPU is high", url: "https://app.datadoghq.com/event/jump_to?event_id=123456" },
      fields: { priority: ["normal"], tag: ["monitor", "name:myService", "role:computing-node"] }, actor: { kind: "unknown" },
    } });
  });

  it("reads the date as epoch milliseconds (a number or a numeral) or as an ISO time with a zone, and ignores any other date", async () => {
    const { w, hook } = await ddWorld();
    const at = w.clock.now - 120_000;
    await w.receive(ddDelivery(hook, ddBody(w, { id: "n1", date: at })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "n2", date: String(at) })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "n3", date: iso(at) })));
    expect(w.dispatched.map((entry) => entry.event.occurredAt)).toEqual([iso(at), iso(at), iso(at)]);
    for (const [index, date] of [undefined, null, "soon", "", -5, 0, 1.5, "1e12", `${String(at)}x`, [at], "2026-10-22T10:00:00"].entries()) {
      expect(await w.receive(ddDelivery(hook, ddBody(w, { id: `bad${String(index)}`, date }))), String(date)).toEqual(IGNORED);
    }
    expect(w.dispatched).toHaveLength(3);
  });

  it("ignores every transition but Triggered: Recovered, Re-Triggered, Warn, No Data, Renotify and a missing one", async () => {
    const { w, hook } = await ddWorld();
    for (const [index, transition] of ["Recovered", "Re-Triggered", "Warn", "Re-Warn", "No Data", "Re-No Data", "Renotify", "triggered", "Triggered ", undefined, 5].entries()) {
      expect(await w.receive(ddDelivery(hook, ddBody(w, { id: `t${String(index)}`, transition }))), String(transition)).toEqual(IGNORED);
    }
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("answers 403 for a token that is not the hook's: one character short, one longer, the other secret, empty, missing, in another header or in a header's other name", async () => {
    const { w, hook } = await ddWorld();
    const body = ddBody(w);
    const attempts = [
      ddDelivery(hook, body, { token: SECRET_1.slice(0, -1) }), ddDelivery(hook, body, { token: `${SECRET_1}x` }), ddDelivery(hook, body, { token: SECRET_2 }), ddDelivery(hook, body, { token: "" }),
      ddDelivery(hook, body, { token: undefined }), ddDelivery(hook, body, { header: "authorization" }), ddDelivery(hook, body, { header: "x-rovara-hook-tokens" }), ddDelivery(hook, body, { token: SECRET_1.toUpperCase() }),
      ddDelivery(hook, body, { token: ` ${SECRET_1}` }),
    ];
    for (const attempt of attempts) expect((await w.receive(attempt)).status, JSON.stringify(attempt.headers)).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect((await w.receive(ddDelivery(hook, body))).status).toBe(202);
  });

  it("takes the header whatever the case of its name, and the previous secret during a rotation's overlap", async () => {
    const w = setupHookWorld(PROVIDERS);
    const hook = await w.hook({ source: "datadog", hookId: HOOK_1, project: "web", tenant: DD_TENANT, secretJson: JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(w.clock.now + HOUR) }) });
    expect((await w.receive(ddDelivery(hook, ddBody(w, { id: "c1" }), { header: "X-Rovara-Hook-Token", token: SECRET_2 }))).status).toBe(202);
    expect((await w.receive(ddDelivery(hook, ddBody(w, { id: "c2" }), { token: SECRET_1 }))).status).toBe(202);
    expect((await w.receive(ddDelivery(hook, ddBody(w, { id: "c3" }), { token: "another-secret-0123456789" }))).status).toBe(403);
  });

  it("compares the token only through tokenEquals (digests, constant time), and never throws for a token of another length", () => {
    const raw = Buffer.from("{}");
    vi.mocked(tokenEquals).mockClear();
    expect(datadogProvider.verify(raw, { "x-rovara-hook-token": "short" }, SECRET_1)).toBe(false);
    expect(tokenEquals).toHaveBeenCalledWith("short", SECRET_1);
    expect(datadogProvider.verify(raw, { "x-rovara-hook-token": "x".repeat(5000) }, SECRET_1)).toBe(false);
    expect(datadogProvider.verify(raw, {}, SECRET_1)).toBe(false);
    expect(datadogProvider.verify(raw, { "x-rovara-hook-token": SECRET_1 }, SECRET_1)).toBe(true);
    expect(datadogProvider.verify(raw, { "x-rovara-hook-token": "" }, "")).toBe(false);
  });

  it("refuses another Datadog org id with 403, for a Triggered body and for one it would ignore, and takes the id as a number too", async () => {
    const { w, hook } = await ddWorld();
    for (const orgId of ["9999", "1234 ", "", undefined, null, ["1234"], { id: "1234" }, 99]) {
      expect((await w.receive(ddDelivery(hook, ddBody(w, { id: `o${JSON.stringify(orgId) ?? "u"}`, orgId })))).status, JSON.stringify(orgId)).toBe(403);
    }
    expect((await w.receive(ddDelivery(hook, ddBody(w, { id: "rec", transition: "Recovered", orgId: "9999" })))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect((await w.receive(ddDelivery(hook, ddBody(w, { id: "num", orgId: 1234 })))).status).toBe(202);
    expect(w.logs.filter((entry) => entry.event === "hook.tenant_mismatch")).toHaveLength(9);
  });

  it("starts no second event for the same event id, per hook; the same event to a hook of another project is its own", async () => {
    const { w, hook } = await ddWorld();
    expect((await w.receive(ddDelivery(hook, ddBody(w)))).status).toBe(202);
    expect(await w.receive(ddDelivery(hook, ddBody(w, { date: String(w.clock.now - 1_000) })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.db.get(hookEventKey(ORG_A, HOOK_1, "dd:1234567"))).toBeDefined();
    const other = await w.hook({ source: "datadog", hookId: HOOK_2, project: "api", tenant: DD_TENANT });
    expect((await w.receive(ddDelivery(other, ddBody(w)))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.project)).toEqual(["web", "api"]);
  });

  it("splits the tags on commas and trims them, keeps text only, and gives the priority as one value", async () => {
    const { w, hook } = await ddWorld();
    await w.receive(ddDelivery(hook, ddBody(w, { id: "g1", tags: "a:b,  c:d ,, e", priority: "low" })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "g2", tags: "", priority: "" })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "g3", tags: 5, priority: 7 })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "g4", tags: Array.from({ length: 80 }, (_, index) => `t${String(index)}`).join(","), priority: undefined })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "g5", tags: `${"t".repeat(300)},x` })));
    const events = w.dispatched.map((entry) => entry.event);
    expect(events[0]!.fields).toEqual({ priority: ["low"], tag: ["a:b", "c:d", "e"] });
    expect(events[1]!.fields).toEqual({ priority: [], tag: [] });
    expect(events[2]!.fields).toEqual({ priority: [], tag: [] });
    expect(events[3]!.fields["tag"]).toHaveLength(50);
    expect(events[4]!.fields["tag"]).toEqual(["t".repeat(200), "x"]);
  });

  it("keeps a link only when it is a plain https link on a Datadog site, and cleans the title a person wrote", async () => {
    const { w, hook } = await ddWorld();
    const links: unknown[] = ["http://app.datadoghq.com/x", "https://app.datadoghq.com:8443/x", "https://u:p@app.datadoghq.com/x", "https://datadoghq.com.evil.example/x", "https://evildatadoghq.com/x", "https://evil.example/datadoghq.com", 5, null, "not a link"];
    for (const [index, link] of links.entries()) await w.receive(ddDelivery(hook, ddBody(w, { id: `l${String(index)}`, link })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "eu", link: "https://app.datadoghq.eu/monitors/1" })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "us3", link: "https://us3.datadoghq.com/monitors/1" })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "gov", link: "https://app.ddog-gov.com/monitors/1" })));
    const events = w.dispatched.map((entry) => entry.event);
    for (const event of events.slice(0, 9)) expect(event.subject.url).toBeUndefined();
    expect(events.slice(9).map((event) => event.subject.url)).toEqual(["https://app.datadoghq.eu/monitors/1", "https://us3.datadoghq.com/monitors/1", "https://app.ddog-gov.com/monitors/1"]);
    await w.receive(ddDelivery(hook, ddBody(w, { id: "t1", title: `Boom\u0000 here‮\n${"x".repeat(500)}` })));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "t2", title: "\u0000\u0007 ", alertId: "77" })));
    const last = w.dispatched.slice(-2).map((entry) => entry.event);
    expect([...last[0]!.subject.title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(last[0]!.subject.title).toMatch(/^Boom here x+$/);
    expect(last[1]!.subject.title).toBe("77");
  });

  it("ignores a signed body it cannot read (no event id, no monitor id, an id that is not text) instead of failing the vendor's delivery", async () => {
    const { w, hook } = await ddWorld();
    const bodies = [ddBody(w, { id: "" }), ddBody(w, { id: "x".repeat(101) }), ddBody(w, { alertId: undefined }), ddBody(w, { alertId: "" }), ddBody(w, { alertId: {} }), { orgId: "1234", transition: "Triggered" }];
    (bodies[0] as Record<string, unknown>)["id"] = "";
    for (const body of bodies) expect(await w.receive(ddDelivery(hook, body)), JSON.stringify(body)).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
  });

  it("answers 400 to a signed body that is not JSON text (a payload the template broke with a quote) and one over the size limit, and writes nothing for a wrong token", async () => {
    const { w, hook } = await ddWorld();
    expect((await w.receive(ddDelivery(hook, "", { raw: Buffer.from('{"id":"1","title":"a "quoted" word"}') }))).status).toBe(400);
    expect((await w.receive(ddDelivery(hook, "", { raw: Buffer.alloc(HOOK_BODY_MAX_BYTES + 1, 97) }))).status).toBe(413);
    const mark = w.db.commandNames().length;
    await w.receive(ddDelivery(hook, ddBody(w), { token: SECRET_2 }));
    expect(w.writesSince(mark)).toEqual([]);
  });

  it("gives a payload template to paste with no free-text variable in it: Datadog does not escape variables, so a quote or backslash in one would break the JSON and lose the event", () => {
    expect(DATADOG_PAYLOAD_TEMPLATE).toBe('{"id":"$ID","date":"$DATE","transition":"$ALERT_TRANSITION","alertId":"$ALERT_ID","priority":"$PRIORITY","tags":"$TAGS","link":"$LINK","orgId":"$ORG_ID"}');
    const variables = DATADOG_PAYLOAD_TEMPLATE.match(/\$[A-Z_]+/g) ?? [];
    expect([...variables].sort()).toEqual(["$ALERT_ID", "$ALERT_TRANSITION", "$DATE", "$ID", "$LINK", "$ORG_ID", "$PRIORITY", "$TAGS"]);
    for (const freeText of ["$EVENT_TITLE", "$EVENT_MSG", "$TEXT_ONLY_MSG", "$ALERT_TITLE", "$ALERT_QUERY", "$ALERT_METRIC", "$USER", "$HOSTNAME", "$LAST_UPDATED"]) expect(DATADOG_PAYLOAD_TEMPLATE).not.toContain(freeText);
    expect(datadogProvider.setup?.payloadTemplate).toBe(DATADOG_PAYLOAD_TEMPLATE);
    expect(datadogProvider.setup?.steps.join("\n")).toContain("X-Rovara-Hook-Token");
    expect(JSON.parse(DATADOG_PAYLOAD_TEMPLATE.replaceAll("$", ""))).toBeTypeOf("object");
  });

  it("tells the person to keep the hook token in a hidden Datadog custom variable, not as a plain header value", () => {
    const steps = datadogProvider.setup?.steps.join("\n") ?? "";
    expect(steps).toMatch(/custom variable/i);
    expect(steps).toMatch(/hidden/i);
    expect(steps).toContain('"X-Rovara-Hook-Token": "$');
    expect(steps).not.toContain("<the secret>");
  });

  it("titles a monitor by its alert id when the body (from the new template) has no title, and still reads the title of a body made from the older template", async () => {
    const { w, hook } = await ddWorld();
    const noTitle = ddBody(w, { id: "n1", alertId: "4321" });
    delete noTitle["title"];
    await w.receive(ddDelivery(hook, noTitle));
    await w.receive(ddDelivery(hook, ddBody(w, { id: "n2", alertId: "4322", title: "Old template title" })));
    expect(w.dispatched.map((entry) => entry.event.subject.title)).toEqual(["4321", "Old template title"]);
  });
});

describe("Grafana: the contact point's Authorization header carries Bearer <token>, and an HMAC body signature is accepted as an option", () => {
  it("dispatches one alert.firing per firing alert of a group and none for the resolved one, with its own key, subject, label fields and the alert's start time", async () => {
    const { w, hook } = await gfWorld();
    w.clock.now = Date.parse("2026-10-22T08:00:00.000Z");
    const first = gfAlert(w, { fingerprint: "aaaa1111", startsAt: iso(w.clock.now - 90_000), labels: { alertname: "HighCPU", severity: "critical" } });
    const second = gfAlert(w, { fingerprint: "bbbb2222", startsAt: "2026-10-22T09:51:03.157076+02:00", labels: { alertname: "DiskFull" }, annotations: {} });
    const resolved = gfAlert(w, { status: "resolved", fingerprint: "cccc3333" });
    const reply = await w.receive(gfDelivery(hook, gfBody(w, [first, second, resolved])));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 2 } });
    expect(w.dispatched.map((entry) => entry.event)).toMatchObject([
      { source: "grafana", type: "alert.firing", eventKey: `grafana:aaaa1111:${String(first["startsAt"])}`, project: "web", hookId: hook.hookId, occurredAt: new Date(String(first["startsAt"])).toISOString(),
        subject: { kind: "alert", id: "aaaa1111", title: "HighCPU: CPU is high on web-1", url: "https://grafana.acme.com/alerting/grafana/abc/view" }, fields: { label: ["alertname=HighCPU", "severity=critical"] }, actor: { kind: "unknown" } },
      { eventKey: "grafana:bbbb2222:2026-10-22T09:51:03.157076+02:00", occurredAt: "2026-10-22T07:51:03.157Z", subject: { id: "bbbb2222", title: "DiskFull" }, fields: { label: ["alertname=DiskFull"] } },
    ]);
  });

  it("ignores a group with no firing alert, and still refuses another Grafana's resolved group", async () => {
    const { w, hook } = await gfWorld();
    expect(await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { status: "resolved" })])))).toEqual(IGNORED);
    expect(await w.receive(gfDelivery(hook, gfBody(w, [])))).toEqual(IGNORED);
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { status: "resolved" })], { externalURL: "https://grafana.evil.example/" })))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
  });

  it("answers 403 for a token that is not the hook's: short, long, other secret, empty, missing, another scheme, a bare token", async () => {
    const { w, hook } = await gfWorld();
    const body = gfBody(w);
    const authorizations = [`Bearer ${SECRET_1.slice(0, -1)}`, `Bearer ${SECRET_1}x`, `Bearer ${SECRET_2}`, "Bearer ", "Bearer", "", undefined, `Basic ${SECRET_1}`, `Token ${SECRET_1}`, SECRET_1, `Bearerx ${SECRET_1}`, `Bearer\t${SECRET_1}`.replace("\t", "")];
    for (const authorization of authorizations) expect((await w.receive(gfDelivery(hook, body, { authorization }))).status, String(authorization)).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect((await w.receive(gfDelivery(hook, body))).status).toBe(202);
  });

  it("takes the scheme in any case, the header in any case, and the previous secret during a rotation's overlap", async () => {
    const w = setupHookWorld(PROVIDERS);
    const hook = await w.hook({ source: "grafana", hookId: HOOK_1, project: "web", tenant: GF_TENANT, secretJson: JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(w.clock.now + HOUR) }) });
    const delivery = gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "f1" })]), { authorization: undefined });
    expect((await w.receive({ ...delivery, headers: { Authorization: `bearer ${SECRET_2}` } })).status).toBe(202);
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "f2" })]), { authorization: `BEARER ${SECRET_1}` }))).status).toBe(202);
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "f3" })]), { authorization: "Bearer another-secret-0123456789" }))).status).toBe(403);
  });

  it("compares the token only through tokenEquals, never throws for another length, and a missing header is never a match", () => {
    const raw = Buffer.from("{}");
    vi.mocked(tokenEquals).mockClear();
    expect(grafanaProvider.verify(raw, { authorization: "Bearer short" }, SECRET_1)).toBe(false);
    expect(tokenEquals).toHaveBeenCalledWith("short", SECRET_1);
    expect(grafanaProvider.verify(raw, { authorization: `Bearer ${"x".repeat(5000)}` }, SECRET_1)).toBe(false);
    expect(grafanaProvider.verify(raw, {}, SECRET_1)).toBe(false);
    expect(grafanaProvider.verify(raw, { authorization: `Bearer ${SECRET_1}` }, SECRET_1)).toBe(true);
    expect(grafanaProvider.verify(raw, { authorization: "Bearer " }, "")).toBe(false);
    expect(grafanaProvider.verify(raw, {}, "")).toBe(false);
  });

  it("accepts the HMAC-SHA256 body signature of Grafana's documented option (hex, in X-Grafana-Alerting-Signature) with no Authorization header, and refuses a wrong one", async () => {
    const { w, hook } = await gfWorld();
    const body = gfBody(w, [gfAlert(w, { fingerprint: "s1" })]);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    vi.mocked(hmacHexEquals).mockClear();
    expect((await w.receive(gfDelivery(hook, body, { authorization: undefined, signature: hex(SECRET_1, raw) }))).status).toBe(202);
    expect(hmacHexEquals).toHaveBeenCalledWith("sha256", raw, SECRET_1, hex(SECRET_1, raw));
    const other = gfBody(w, [gfAlert(w, { fingerprint: "s2" })]);
    const otherRaw = Buffer.from(JSON.stringify(other), "utf8");
    for (const signature of [hex(SECRET_2, otherRaw), hex(SECRET_1, raw), hex(SECRET_1, otherRaw, "sha1"), "", "not-hex", `sha256=${hex(SECRET_1, otherRaw)}`, hex(SECRET_1, Buffer.from(`1700000000:${otherRaw.toString()}`))]) {
      expect((await w.receive(gfDelivery(hook, other, { authorization: undefined, signature }))).status, signature).toBe(403);
    }
    expect(w.dispatched).toHaveLength(1);
  });

  it("refuses another Grafana: another host, a lookalike, http, a port, a user name, a missing or unreadable externalURL (403, nothing dispatched)", async () => {
    const { w, hook } = await gfWorld();
    const urls: unknown[] = ["https://grafana.other.com/", "https://grafana.acme.com.evil.example/", "https://evil.example/grafana.acme.com", "https://xgrafana.acme.com/", "http://grafana.acme.com/", "https://grafana.acme.com:3000/", "https://u:p@grafana.acme.com/", undefined, null, "", 5, "not a url", ["https://grafana.acme.com/"]];
    for (const [index, externalURL] of urls.entries()) expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: `x${String(index)}` })], { externalURL })))).status, String(externalURL)).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w)], { externalURL: "https://GRAFANA.acme.com/path/" })))).status).toBe(202);
  });

  it("skips a repeat notification of an alert that started more than 24 hours ago as stale, and still starts a fresh alert of the same group", async () => {
    const { w, hook } = await gfWorld();
    const old = gfAlert(w, { fingerprint: "old1", startsAt: iso(w.clock.now - 25 * HOUR) });
    const fresh = gfAlert(w, { fingerprint: "new1", startsAt: iso(w.clock.now - 23 * HOUR) });
    expect((await w.receive(gfDelivery(hook, gfBody(w, [old, fresh])))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.subject.id)).toEqual(["new1"]);
    expect(w.logs.filter((entry) => entry.event === "hook.stale")).toHaveLength(1);
  });

  it("starts a repeat notification of the same alert once (same fingerprint and start), and a later firing of the same alert (new start) again", async () => {
    const { w, hook } = await gfWorld();
    const alert = gfAlert(w, { fingerprint: "rep1", startsAt: iso(w.clock.now - 60_000) });
    expect((await w.receive(gfDelivery(hook, gfBody(w, [alert])))).status).toBe(202);
    expect(await w.receive(gfDelivery(hook, gfBody(w, [alert, gfAlert(w, { status: "resolved", fingerprint: "zzz" })])))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "rep1", startsAt: iso(w.clock.now - 30_000) })])))).status).toBe(202);
    expect(w.dispatched).toHaveLength(2);
    const other = await w.hook({ source: "grafana", hookId: HOOK_2, project: "api", tenant: GF_TENANT });
    expect((await w.receive(gfDelivery(other, gfBody(w, [alert])))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.project)).toEqual(["web", "web", "api"]);
  });

  it("starts at most 50 events of one delivery and logs how many were dropped", async () => {
    const { w, hook } = await gfWorld();
    const alerts = Array.from({ length: HOOK_MAX_EVENTS_PER_DELIVERY + 5 }, (_, index) => gfAlert(w, { fingerprint: `fp${String(index).padStart(3, "0")}` }));
    expect((await w.receive(gfDelivery(hook, gfBody(w, alerts)))).status).toBe(202);
    expect(w.dispatched).toHaveLength(HOOK_MAX_EVENTS_PER_DELIVERY);
    expect(w.logs.find((entry) => entry.event === "hook.too_many_events")?.fields).toMatchObject({ events: 55, dropped: 5 });
  });

  it("skips one alert it cannot read (no fingerprint, a start that is not a time, labels that are not text) and dispatches the others of the group", async () => {
    const { w, hook } = await gfWorld();
    const alerts = [
      gfAlert(w, { fingerprint: undefined }), gfAlert(w, { fingerprint: "bad id!" }), gfAlert(w, { fingerprint: "" }), gfAlert(w, { fingerprint: "f".repeat(65) }), gfAlert(w, { fingerprint: "g1", startsAt: "soon" }),
      gfAlert(w, { fingerprint: "g2", startsAt: undefined }), gfAlert(w, { fingerprint: "g3", startsAt: 1_700_000_000_000 }), gfAlert(w, { fingerprint: "g4", startsAt: "2026-10-22T10:00:00" }), "text", null,
      gfAlert(w, { fingerprint: "good1", labels: { a: 1, b: null, c: "ok", d: { x: 1 } } }),
      gfAlert(w, { fingerprint: "good2", labels: "nope", annotations: "nope", generatorURL: 5 }),
      gfAlert(w, { fingerprint: "good3", labels: null, annotations: null }),
    ] as Array<Record<string, unknown>>;
    expect((await w.receive(gfDelivery(hook, gfBody(w, alerts)))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.subject.id)).toEqual(["good1", "good2", "good3"]);
    expect(w.dispatched[0]!.event.fields["label"]).toEqual(["c=ok"]);
    expect(w.dispatched[1]!.event.fields["label"]).toEqual([]);
    expect(w.dispatched[1]!.event.subject.title).toBe("good2");
    expect(w.dispatched[1]!.event.subject.url).toBeUndefined();
  });

  it("keeps labels as key=value text cut to 200 characters (at most 50), and a link only on the Grafana's own host", async () => {
    const { w, hook } = await gfWorld();
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${String(index).padStart(2, "0")}`, "v"]));
    await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "l1", labels: many }), gfAlert(w, { fingerprint: "l2", labels: { long: "x".repeat(300) } })])));
    const bad: unknown[] = ["http://grafana.acme.com/x", "https://grafana.acme.com:3000/x", "https://u@grafana.acme.com/x", "https://grafana.acme.com.evil.example/x", "https://evil.example/", "nope"];
    for (const [index, generatorURL] of bad.entries()) await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: `u${String(index)}`, generatorURL })])));
    const events = w.dispatched.map((entry) => entry.event);
    expect(events[0]!.fields["label"]).toHaveLength(50);
    expect(events[1]!.fields["label"]![0]).toHaveLength(200);
    for (const event of events.slice(2)) expect(event.subject.url).toBeUndefined();
  });

  it("cleans the title a person wrote into the alert name and summary", async () => {
    const { w, hook } = await gfWorld();
    await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "t1", labels: { alertname: `Boom\u0000 here‮\n` }, annotations: { summary: `x${"y".repeat(500)}` } })])));
    const title = w.dispatched[0]!.event.subject.title;
    expect([...title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(title).toMatch(/^Boom here : xy+$/);
    expect(title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});

describe("Vercel: x-vercel-signature is the hex HMAC-SHA1 of the raw body", () => {
  it("dispatches a signed deployment.error with the deployment as the subject, its link, target and the time from createdAt", async () => {
    const { w, hook } = await vcWorld();
    const reply = await w.receive(vcDelivery(hook, vcBody(w, { createdAt: w.clock.now - 90_000 })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "vercel", type: "deployment.error", eventKey: "vercel:hook_abc123", project: "web", hookId: hook.hookId, occurredAt: iso(w.clock.now - 90_000),
      subject: { kind: "deployment", id: "prj_123", title: "acme-web: deployment failed", url: "https://vercel.com/acme/acme-web/9x" }, fields: { target: ["production"] }, actor: { kind: "unknown" },
    } });
  });

  it("names the PROJECT as the subject, so two deployments of one project share it (the 30-minute subject guard sees a deploy-fail loop), and another project does not", async () => {
    const { w, hook } = await vcWorld({ teamId: "team_abc" });
    await w.receive(vcDelivery(hook, vcBody(w, { id: "d1", deployment: { id: "dpl_1", name: "acme-web" } })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "d2", deployment: { id: "dpl_2", name: "acme-web" } })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "d3", deployment: { id: "dpl_3", name: "acme-api" }, project: { id: "prj_456" } })));
    expect(w.dispatched.map((entry) => entry.event.subject.id)).toEqual(["prj_123", "prj_123", "prj_456"]);
    expect(w.dispatched.map((entry) => entry.event.subject.title)).toEqual(["acme-web: deployment failed", "acme-web: deployment failed", "acme-api: deployment failed"]);
  });

  it("falls back to the deployment id when the body names no readable project id", async () => {
    const { w, hook } = await vcWorld({ teamId: "team_abc" });
    for (const [index, project] of [undefined, null, {}, { id: 5 }, { id: "" }, { id: "p".repeat(201) }].entries()) {
      await w.receive(vcDelivery(hook, vcBody(w, { id: `f${String(index)}`, project, deployment: { id: `dpl_${String(index)}`, name: "acme-web" } })));
    }
    expect(w.dispatched.map((entry) => entry.event.subject.id)).toEqual(["dpl_0", "dpl_1", "dpl_2", "dpl_3", "dpl_4", "dpl_5"]);
  });

  it("dispatches deployment.succeeded with a staging target, and gives no target value for a null one", async () => {
    const { w, hook } = await vcWorld();
    await w.receive(vcDelivery(hook, vcBody(w, { id: "s1", type: "deployment.succeeded", target: "staging" })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "s2", type: "deployment.succeeded", target: null })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "s3", type: "deployment.error", target: 5 })));
    expect(w.dispatched.map((entry) => [entry.event.type, entry.event.fields["target"], entry.event.subject.title])).toEqual([
      ["deployment.succeeded", ["staging"], "acme-web: deployment succeeded"], ["deployment.succeeded", [], "acme-web: deployment succeeded"], ["deployment.error", [], "acme-web: deployment failed"],
    ]);
  });

  it("refuses the same body signed with SHA-256 (403), and any signature that is not the SHA-1 of these bytes under the secret", async () => {
    const { w, hook } = await vcWorld();
    const body = vcBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const attempts = [
      vcDelivery(hook, body, { algorithm: "sha256" }), vcDelivery(hook, body, { secret: SECRET_2 }), vcDelivery(hook, body, { header: "" }), vcDelivery(hook, body, { header: undefined }),
      vcDelivery(hook, body, { header: `sha1=${hex(SECRET_1, raw, "sha1")}` }), vcDelivery(hook, body, { header: "not-hex" }), vcDelivery(hook, body, { header: `${hex(SECRET_1, raw, "sha1")}0` }),
      vcDelivery(hook, body, { header: hex(SECRET_1, Buffer.from("{}"), "sha1") }), { ...vcDelivery(hook, body), raw: Buffer.from(JSON.stringify(body, null, 2), "utf8") },
    ];
    for (const attempt of attempts) expect((await w.receive(attempt)).status, String(attempt.headers["x-vercel-signature"])).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect((await w.receive(vcDelivery(hook, body))).status).toBe(202);
  });

  it("takes the header in any case and a capital-letter hex digest, and the previous secret during a rotation's overlap", async () => {
    const w = setupHookWorld(PROVIDERS);
    const hook = await w.hook({ source: "vercel", hookId: HOOK_1, project: "web", tenant: VC_TENANT, secretJson: JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(w.clock.now + HOUR) }) });
    const first = vcBody(w, { id: "r1" });
    const delivery = vcDelivery(hook, first, { secret: SECRET_2 });
    expect((await w.receive({ ...delivery, headers: { "X-Vercel-Signature": String(delivery.headers["x-vercel-signature"]).toUpperCase() } })).status).toBe(202);
    expect((await w.receive(vcDelivery(hook, vcBody(w, { id: "r2" }), { secret: SECRET_1 }))).status).toBe(202);
  });

  it("compares the signature only through hmacHexEquals with sha1, and never throws", () => {
    const raw = Buffer.from("{}");
    vi.mocked(hmacHexEquals).mockClear();
    expect(vercelProvider.verify(raw, { "x-vercel-signature": "00" }, SECRET_1)).toBe(false);
    expect(hmacHexEquals).toHaveBeenCalledWith("sha1", raw, SECRET_1, "00");
    expect(vercelProvider.verify(raw, {}, SECRET_1)).toBe(false);
    expect(vercelProvider.verify(raw, { "x-vercel-signature": hex(SECRET_1, raw, "sha1") }, "")).toBe(false);
    expect(vercelProvider.verify(raw, { "x-vercel-signature": hex(SECRET_1, raw, "sha1") }, SECRET_1)).toBe(true);
  });

  it("checks the tenant when the hook names one: another team, a team of null, another project, a missing project (403), and passes a hook that names neither", async () => {
    const { w, hook } = await vcWorld();
    const wrong: VcOver[] = [{ team: { id: "team_other" } }, { team: null }, { team: undefined }, { team: { id: 5 } }, { project: { id: "prj_other" } }, { project: null }, { project: undefined }, { project: { id: "PRJ_123" } }];
    for (const [index, over] of wrong.entries()) expect((await w.receive(vcDelivery(hook, vcBody(w, { ...over, id: `w${String(index)}` })))).status, JSON.stringify(over)).toBe(403);
    expect(w.dispatched).toEqual([]);
    const onlyProject = await w.hook({ source: "vercel", hookId: HOOK_2, project: "api", tenant: { projectId: "prj_123" } });
    expect((await w.receive(vcDelivery(onlyProject, vcBody(w, { id: "p1", team: { id: "team_other" } })))).status).toBe(202);
    expect((await w.receive(vcDelivery(onlyProject, vcBody(w, { id: "p2", project: { id: "prj_other" } })))).status).toBe(403);
    const neither = await w.hook({ source: "vercel", hookId: `hk_${"3".repeat(26)}`, project: "ops", tenant: {} });
    expect((await w.receive(vcDelivery(neither, vcBody(w, { id: "n1", team: null, project: undefined })))).status).toBe(202);
    expect(w.logs.filter((entry) => entry.event === "hook.tenant_mismatch")).toHaveLength(9);
  });

  it("ignores events that are not a deployment succeeding or failing, even for another team", async () => {
    const { w, hook } = await vcWorld();
    for (const [index, type] of ["deployment.created", "deployment.canceled", "deployment.ready", "project.created", "deployment-ready", "Deployment.Error", ""].entries()) {
      expect(await w.receive(vcDelivery(hook, vcBody(w, { id: `i${String(index)}`, type, team: { id: "team_other" } }))), type).toEqual(IGNORED);
    }
    expect(w.dispatched).toEqual([]);
  });

  it("starts no second event for the same delivery id, per hook; another project's hook starts its own", async () => {
    const { w, hook } = await vcWorld();
    expect((await w.receive(vcDelivery(hook, vcBody(w)))).status).toBe(202);
    expect(await w.receive(vcDelivery(hook, vcBody(w, { createdAt: w.clock.now - 1_000 })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    const other = await w.hook({ source: "vercel", hookId: HOOK_2, project: "api", tenant: VC_TENANT });
    expect((await w.receive(vcDelivery(other, vcBody(w)))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.project)).toEqual(["web", "api"]);
  });

  it("reads createdAt as epoch milliseconds or an ISO time, ignores anything else, and drops a delivery older than a day", async () => {
    const { w, hook } = await vcWorld();
    const at = w.clock.now - 120_000;
    await w.receive(vcDelivery(hook, vcBody(w, { id: "c1", createdAt: at })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "c2", createdAt: iso(at) })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "c3", createdAt: String(at) })));
    expect(w.dispatched.map((entry) => entry.event.occurredAt)).toEqual([iso(at), iso(at), iso(at)]);
    for (const [index, createdAt] of [undefined, null, "soon", -1, 0, 1.5, [at], {}].entries()) expect(await w.receive(vcDelivery(hook, vcBody(w, { id: `bad${String(index)}`, createdAt }))), JSON.stringify(createdAt)).toEqual(IGNORED);
    expect((await w.receive(vcDelivery(hook, vcBody(w, { id: "old", createdAt: w.clock.now - 25 * HOUR })))).status).toBe(202);
    expect(w.dispatched).toHaveLength(3);
    expect(w.logs.filter((entry) => entry.event === "hook.stale")).toHaveLength(1);
  });

  it("ignores a signed body it cannot read (no delivery id, no deployment id) and keeps a link only on vercel.com", async () => {
    const { w, hook } = await vcWorld();
    expect(await w.receive(vcDelivery(hook, vcBody(w, { id: "" })))).toEqual(IGNORED);
    expect(await w.receive(vcDelivery(hook, vcBody(w, { id: "x".repeat(101) })))).toEqual(IGNORED);
    expect(await w.receive(vcDelivery(hook, vcBody(w, { id: "d1", deployment: {} })))).toEqual(IGNORED);
    expect(await w.receive(vcDelivery(hook, vcBody(w, { id: "d2", deployment: null })))).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
    const links: unknown[] = ["http://vercel.com/x", "https://vercel.com:8443/x", "https://u:p@vercel.com/x", "https://vercel.com.evil.example/x", "https://evil.example/vercel.com", 5];
    for (const [index, deployment] of links.entries()) await w.receive(vcDelivery(hook, vcBody(w, { id: `l${String(index)}`, links: { deployment } })));
    await w.receive(vcDelivery(hook, vcBody(w, { id: "nolinks", links: null, deployment: { id: "dpl_1" } })));
    const events = w.dispatched.map((entry) => entry.event);
    for (const event of events) expect(event.subject.url).toBeUndefined();
    expect(events.at(-1)!.subject.title).toBe("dpl_1: deployment failed");
  });

  it("cleans the project name a person chose", async () => {
    const { w, hook } = await vcWorld();
    await w.receive(vcDelivery(hook, vcBody(w, { deployment: { id: "dpl_x", name: `Boom\u0000 here‮\n${"x".repeat(500)}` } })));
    const title = w.dispatched[0]!.event.subject.title;
    expect([...title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(title).toMatch(/^Boom here x+/);
    expect(title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});

describe("the providers are the ones the broker uses", () => {
  it("registers Datadog and Grafana (Rovara's secret, token) and Vercel (vendor secret, hmac) beside the others", () => {
    const providers = hookProviders();
    expect(providers.datadog).toBe(datadogProvider);
    expect(providers.grafana).toBe(grafanaProvider);
    expect(providers.vercel).toBe(vercelProvider);
    expect([datadogProvider.secretOrigin, datadogProvider.auth, datadogProvider.source]).toEqual(["rovara", "token", "datadog"]);
    expect([grafanaProvider.secretOrigin, grafanaProvider.auth, grafanaProvider.source]).toEqual(["rovara", "token", "grafana"]);
    expect([vercelProvider.secretOrigin, vercelProvider.auth, vercelProvider.source]).toEqual(["vendor", "hmac", "vercel"]);
    expect(Object.keys(providers).sort()).toEqual(["cloudwatch", "datadog", "grafana", "jira", "linear", "pagerduty", "sentry", "vercel"]);
  });

  it("answers a tenant mismatch for a hook of another source, and never throws on a delivery it can't verify", async () => {
    const { w, hook } = await ddWorld();
    const gf = await w.hook({ source: "grafana", hookId: HOOK_2, project: "web", tenant: GF_TENANT });
    expect(datadogProvider.normalize(ddBody(w), {}, gf)).toEqual({ tenantMismatch: true });
    expect(grafanaProvider.normalize(gfBody(w), {}, hook)).toEqual({ tenantMismatch: true });
    expect(vercelProvider.normalize(vcBody(w), {}, hook)).toEqual({ tenantMismatch: true });
    for (const provider of [datadogProvider, grafanaProvider, vercelProvider]) {
      expect(provider.verify(Buffer.from("{}"), {}, SECRET_1)).toBe(false);
      for (const body of [null, 5, "text", [], {}]) expect(provider.normalize(body, {}, { ...hook, source: provider.source, tenant: provider.source === "datadog" ? DD_TENANT : provider.source === "grafana" ? GF_TENANT : VC_TENANT })).toBeDefined();
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
    const dd = await w.hook({ source: "datadog", hookId: HOOK_A, project: "web", tenant: DD_TENANT });
    v.hook("datadog", HOOK_A);
    const gf = await w.hook({ source: "grafana", hookId: HOOK_2, project: "web", tenant: GF_TENANT });
    v.hook("grafana", HOOK_2);
    const vc = await w.hook({ source: "vercel", hookId: `hk_${"4".repeat(26)}`, project: "web", tenant: VC_TENANT });
    v.hook("vercel", vc.hookId);
    return { v, w, chain, runs, dd, gf, vc };
  }
  const outcomes = async (v: Awaited<ReturnType<typeof dispatching>>["v"], triggerId: string) => (await v.triggers.listActivity(ORG_A, triggerId)).map((entry) => [entry.outcome, entry.reason]);

  it("starts one chain run for a Datadog monitor whose priority and tag the trigger asks for, once", async () => {
    const { v, w, chain, runs, dd } = await dispatching();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "datadog", type: "monitor.triggered", filter: { priority: ["normal"], tag: ["role:computing-node"] } }, hookId: HOOK_A });
    await w.receive(ddDelivery(dd, ddBody(w, { id: "low", priority: "low" })));
    await w.receive(ddDelivery(dd, ddBody(w, { id: "other-tag", tags: "role:db", alertId: "2" })));
    expect(runs()).toEqual([]);
    expect((await w.receive(ddDelivery(dd, ddBody(w, { id: "hit", alertId: "3" })))).status).toBe(202);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ origin: "event", project: "web", startedBy: { kind: "event", triggerId: trigger.triggerId, source: "datadog", type: "monitor.triggered", title: "[Triggered on {host:web-1}] CPU is high" } });
    expect(await w.receive(ddDelivery(dd, ddBody(w, { id: "hit", alertId: "3", date: String(w.clock.now - 500) })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(runs()).toHaveLength(1);
    expect(await outcomes(v, trigger.triggerId)).toContainEqual(["started", undefined]);
  });

  it("starts one chain run per firing Grafana alert whose label the trigger asks for", async () => {
    const { v, w, chain, runs, gf } = await dispatching();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "grafana", type: "alert.firing", filter: { label: ["severity=critical"] } }, hookId: HOOK_2 });
    const calm = gfAlert(w, { fingerprint: "calm", labels: { alertname: "A", severity: "info" } });
    const loud = gfAlert(w, { fingerprint: "loud", labels: { alertname: "B", severity: "critical" } });
    const loud2 = gfAlert(w, { fingerprint: "loud2", labels: { alertname: "C", severity: "critical" } });
    expect((await w.receive(gfDelivery(gf, gfBody(w, [calm, loud, loud2])))).status).toBe(202);
    expect(runs()).toHaveLength(2);
    expect(await outcomes(v, trigger.triggerId)).toEqual([["started", undefined], ["started", undefined]]);
  });

  it("starts one chain run for a Vercel production failure and none for a staging one", async () => {
    const { v, w, chain, runs, vc } = await dispatching();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "vercel", type: "deployment.error", filter: { target: ["production"] } }, hookId: vc.hookId });
    await w.receive(vcDelivery(vc, vcBody(w, { id: "stage", target: "staging" })));
    expect(runs()).toEqual([]);
    expect((await w.receive(vcDelivery(vc, vcBody(w, { id: "prod", target: "production" })))).status).toBe(202);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ startedBy: { kind: "event", triggerId: trigger.triggerId, source: "vercel", type: "deployment.error", title: "acme-web: deployment failed", url: "https://vercel.com/acme/acme-web/9x" } });
    expect(await outcomes(v, trigger.triggerId)).toEqual([["started", undefined]]);
  });

  it("does not start a second run for the same Vercel project within the subject guard window, though it is another deployment", async () => {
    const { v, w, chain, runs, vc } = await dispatching();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "vercel", type: "deployment.error" }, hookId: vc.hookId });
    await w.receive(vcDelivery(vc, vcBody(w, { id: "first", deployment: { id: "dpl_1", name: "acme-web" } })));
    await w.receive(vcDelivery(vc, vcBody(w, { id: "second", deployment: { id: "dpl_2", name: "acme-web" } })));
    expect(runs()).toHaveLength(1);
    expect(await outcomes(v, trigger.triggerId)).toHaveLength(2);
    expect(await outcomes(v, trigger.triggerId)).toContainEqual(["started", undefined]);
    expect(await outcomes(v, trigger.triggerId)).toContainEqual(["skipped", "recent_subject"]);
  });

  it("does not let another org's or team's body reach dispatch", async () => {
    const { w, runs, dd, gf, vc } = await dispatching();
    expect((await w.receive(ddDelivery(dd, ddBody(w, { orgId: "9999" })))).status).toBe(403);
    expect((await w.receive(gfDelivery(gf, gfBody(w, [gfAlert(w)], { externalURL: "https://grafana.other.com/" })))).status).toBe(403);
    expect((await w.receive(vcDelivery(vc, vcBody(w, { team: { id: "team_other" } })))).status).toBe(403);
    expect(runs()).toEqual([]);
  });
});

// ---- hook creation returns what to paste
describe("creating a Datadog hook gives the exact setup text, and Grafana's", () => {
  it("returns the payload template and the steps naming the token header with the created hook, and nothing of the kind for a vendor-secret source", async () => {
    const v = setupTriggerWorld();
    const hw = setupHookWorld(hookProviders(), { db: v.db, clock: v.clock });
    v.routeDeps.eventHooks = { store: hw.store, secrets: hw.secrets, providers: hw.providers, origin: "https://api.example.com" };
    const made = await v.agentCall(DANA, "POST", "/v1/app/projects/web/event-hooks", { source: "datadog", tenant: DD_TENANT });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const setup = made.body["setup"] as { steps: string[]; payloadTemplate: string };
    expect(setup.payloadTemplate).toBe(DATADOG_PAYLOAD_TEMPLATE);
    expect(setup.steps.join("\n")).toContain("X-Rovara-Hook-Token");
    expect(JSON.stringify(setup)).not.toContain(String(made.body["secret"]));
    const grafana = await v.agentCall(DANA, "POST", "/v1/app/projects/web/event-hooks", { source: "grafana", tenant: GF_TENANT });
    expect(grafana.status, JSON.stringify(grafana.body)).toBe(201);
    expect((grafana.body["setup"] as { steps: string[]; payloadTemplate?: string }).steps.join("\n")).toContain("Bearer");
    expect(grafana.body["secret"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const vercel = await v.agentCall(DANA, "POST", "/v1/app/projects/web/event-hooks", { source: "vercel", tenant: VC_TENANT, secret: SECRET_1 });
    expect(vercel.status, JSON.stringify(vercel.body)).toBe(201);
    expect(vercel.body).not.toHaveProperty("setup");
    expect(vercel.body).not.toHaveProperty("secret");
  });
});

// ---- layer 3: what is logged
describe("nothing a sender wrote reaches a log", () => {
  const MARK = "SECRET-MARKER-7e1b";

  it("keeps the titles, names, ids, tags, labels and links of Datadog, Grafana and Vercel bodies out of every log line, on every path", async () => {
    const w = setupHookWorld(PROVIDERS);
    const dd = await w.hook({ source: "datadog", hookId: HOOK_1, project: "web", tenant: DD_TENANT });
    const gf = await w.hook({ source: "grafana", hookId: HOOK_2, project: "web", tenant: GF_TENANT });
    const vc = await w.hook({ source: "vercel", hookId: `hk_${"5".repeat(26)}`, project: "web", tenant: VC_TENANT });
    const attempts: HookDelivery[] = [
      ddDelivery(dd, ddBody(w, { id: `${MARK}-1`, title: `${MARK}-title`, tags: `${MARK}-tag`, link: `https://app.datadoghq.com/${MARK}` })),
      ddDelivery(dd, ddBody(w, { id: `${MARK}-2`, orgId: `${MARK}-org` })),
      ddDelivery(dd, ddBody(w, { id: `${MARK}-3`, transition: `${MARK}-transition` })),
      ddDelivery(dd, ddBody(w, { id: `${MARK}-4`, title: `${MARK}-title` }), { token: `${MARK}-token` }),
      ddDelivery(dd, ddBody(w, { id: `${MARK}-5`, date: `${MARK}-date` })),
      ddDelivery(dd, ddBody(w, { id: `${MARK}-6`, date: String(w.clock.now - 30 * HOUR) })),
      ddDelivery(dd, "", { raw: Buffer.from(`{"id":"${MARK}","title":"a "${MARK}" b"}`) }),
      gfDelivery(gf, gfBody(w, [gfAlert(w, { fingerprint: "a1", labels: { alertname: `${MARK}-alert`, x: `${MARK}-label` }, annotations: { summary: `${MARK}-summary` } })])),
      gfDelivery(gf, gfBody(w, [gfAlert(w, { fingerprint: "a2" })], { externalURL: `https://${MARK}.example/` })),
      gfDelivery(gf, gfBody(w, [gfAlert(w, { fingerprint: `${MARK}-fp`, startsAt: `${MARK}-start` })])),
      gfDelivery(gf, gfBody(w, [gfAlert(w, { fingerprint: "a3", startsAt: iso(w.clock.now - 30 * HOUR), labels: { alertname: `${MARK}-old` } })])),
      gfDelivery(gf, gfBody(w, [gfAlert(w, { fingerprint: "a4" })]), { authorization: `Bearer ${MARK}-bearer` }),
      vcDelivery(vc, vcBody(w, { id: `${MARK}-v1`, deployment: { id: `${MARK}-dpl`, name: `${MARK}-name` }, links: { deployment: `https://vercel.com/${MARK}` } })),
      vcDelivery(vc, vcBody(w, { id: `${MARK}-v2`, team: { id: `${MARK}-team` } })),
      vcDelivery(vc, vcBody(w, { id: `${MARK}-v3`, type: `${MARK}-type` })),
      vcDelivery(vc, vcBody(w, { id: `${MARK}-v4` }), { secret: `${MARK}-secret` }),
      vcDelivery(vc, vcBody(w, { id: `${MARK}-v5`, createdAt: `${MARK}-at` })),
      vcDelivery(vc, vcBody(w, { id: `${MARK}-v6`, createdAt: w.clock.now - 30 * HOUR })),
    ];
    for (const attempt of attempts) await w.receive(attempt);
    // A positive control: the paths ran (events accepted, tenants refused, old ones dropped) and logged their ids and codes.
    expect(w.dispatched).toHaveLength(3);
    expect(w.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["hook.tenant_mismatch", "hook.stale"]));
    expect(JSON.stringify(w.logs)).not.toContain(MARK);
  });
});

// ---- pins found by the mutation pass: each of these fails when the guard it names is changed
describe("pins: the edges of what each provider reads", () => {
  it("Datadog takes a monitor id sent as a number, and not a negative or fractional one", async () => {
    const { w, hook } = await ddWorld();
    expect((await w.receive(ddDelivery(hook, ddBody(w, { id: "n1", alertId: 1234 })))).status).toBe(202);
    expect(w.dispatched[0]!.event.subject.id).toBe("1234");
    for (const [index, alertId] of [-1, 1.5].entries()) expect(await w.receive(ddDelivery(hook, ddBody(w, { id: `neg${String(index)}`, alertId })))).toEqual(IGNORED);
    expect(w.dispatched).toHaveLength(1);
  });

  it("each provider answers a tenant mismatch for a hook of another source even when the body names that hook's own tenant fields", async () => {
    const { w, hook } = await ddWorld();
    const asGrafana = { ...hook, source: "grafana" } as HookRecord;
    expect(datadogProvider.normalize(ddBody(w), {}, asGrafana)).toEqual({ tenantMismatch: true });
    const asVercel = { ...hook, source: "vercel", tenant: {} } as HookRecord;
    expect(grafanaProvider.normalize(gfBody(w), {}, { ...hook, source: "datadog", tenant: GF_TENANT })).toEqual({ tenantMismatch: true });
    expect(vercelProvider.normalize(vcBody(w), {}, { ...asVercel, source: "datadog" })).toEqual({ tenantMismatch: true });
  });

  it("the setup text says what to set: five steps for Datadog including that the form encoding is off, and Grafana's bearer and HMAC choices", () => {
    expect(datadogProvider.setup?.steps).toHaveLength(5);
    expect(datadogProvider.setup?.steps.join("\n")).toContain("Encode as form off");
    expect(grafanaProvider.setup?.steps).toHaveLength(4);
    expect(grafanaProvider.setup?.steps.join("\n")).toContain("Timestamp Header empty");
  });

  it("Grafana reads Authorization only as a whole `Bearer <token>`: text before the scheme is refused, white space around the header is not part of the token", async () => {
    const { w, hook } = await gfWorld();
    const body = gfBody(w, [gfAlert(w, { fingerprint: "b1" })]);
    for (const authorization of [`Foo Bearer ${SECRET_1}`, `x Bearer ${SECRET_1}`]) expect((await w.receive(gfDelivery(hook, body, { authorization }))).status, authorization).toBe(403);
    expect((await w.receive(gfDelivery(hook, body, { authorization: `Bearer ${SECRET_1} ` }))).status).toBe(202);
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "b2" })]), { authorization: ` Bearer ${SECRET_1}` }))).status).toBe(202);
  });

  it("Grafana takes a fingerprint in capitals and refuses an externalURL longer than 2048 characters", async () => {
    const { w, hook } = await gfWorld();
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "ABCDEF0123" })])))).status).toBe(202);
    expect(w.dispatched[0]!.event.subject.id).toBe("ABCDEF0123");
    expect((await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "long1" })], { externalURL: `https://grafana.acme.com/${"a".repeat(2100)}` })))).status).toBe(403);
    expect(w.dispatched).toHaveLength(1);
  });

  it("Grafana starts an alert only when its status is firing: another word is not an event, and an alert with an unreadable start is dropped before it can be an invalid event", async () => {
    const { w, hook } = await gfWorld();
    const alerts = [gfAlert(w, { status: "pending", fingerprint: "p1" }), gfAlert(w, { status: "normal", fingerprint: "p2" }), gfAlert(w, { fingerprint: "p3", startsAt: "soon" }), gfAlert(w, { fingerprint: "ok1" })];
    expect((await w.receive(gfDelivery(hook, gfBody(w, alerts)))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.subject.id)).toEqual(["ok1"]);
    expect(w.logs.filter((entry) => entry.event === "hook.event_invalid")).toEqual([]);
  });

  it("Grafana lists the labels sorted by name, and only the labels of a map (a list is no labels)", async () => {
    const { w, hook } = await gfWorld();
    await w.receive(gfDelivery(hook, gfBody(w, [gfAlert(w, { fingerprint: "o1", labels: { z: "1", a: "2", m: "3" } }), gfAlert(w, { fingerprint: "o2", labels: ["x", "y"] })])));
    expect(w.dispatched.map((entry) => entry.event.fields["label"])).toEqual([["a=2", "m=3", "z=1"], []]);
  });

  it("Vercel answers a body with no payload for the hook's team as a tenant refusal, not as a fault of its own", async () => {
    const { w, hook } = await vcWorld();
    const raw = Buffer.from(JSON.stringify({ type: "deployment.error", id: "x" }), "utf8");
    expect((await w.receive(vcDelivery(hook, null, { raw }))).status).toBe(403);
    expect(w.logs.map((entry) => entry.event)).toEqual(["hook.tenant_mismatch"]);
  });

  it("Vercel ignores a deployment with an empty id, and titles a deployment whose project name is only white space by its id", async () => {
    const { w, hook } = await vcWorld();
    expect(await w.receive(vcDelivery(hook, vcBody(w, { id: "e1", deployment: { id: "" } })))).toEqual(IGNORED);
    await w.receive(vcDelivery(hook, vcBody(w, { id: "e2", deployment: { id: "dpl_x", name: "   " } })));
    expect(w.dispatched.map((entry) => entry.event.subject.title)).toEqual(["dpl_x: deployment failed"]);
  });

  it("a repeat of the request that made a Datadog hook gives the setup again, with no secret", async () => {
    const v = setupTriggerWorld();
    const hw = setupHookWorld(hookProviders(), { db: v.db, clock: v.clock });
    v.routeDeps.eventHooks = { store: hw.store, secrets: hw.secrets, providers: hw.providers, origin: "https://api.example.com" };
    const requestId = crypto.randomUUID();
    const first = await v.agentCall(DANA, "POST", "/v1/app/projects/web/event-hooks", { requestId, source: "datadog", tenant: DD_TENANT });
    const again = await v.agentCall(DANA, "POST", "/v1/app/projects/web/event-hooks", { requestId, source: "datadog", tenant: DD_TENANT });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body["replayed"]).toBe(true);
    expect((again.body["setup"] as { payloadTemplate: string }).payloadTemplate).toBe(DATADOG_PAYLOAD_TEMPLATE);
    expect(again.body).not.toHaveProperty("secret");
  });
});
