// Plan 4 Task 22: Linear and Jira issues start agents and chains through Task 19's signed hook route. Each delivery proves itself over its own bytes (Linear: the hex HMAC-SHA256 in
// `Linear-Signature`; Jira: `sha256=<hex>` in `X-Hub-Signature`), is checked against the hook's own tenant, and becomes one normalised event that only Task 20's dispatch maps to work.
// Layer 1 drives the route with a recording dispatcher (what was accepted, refused and ignored). Layer 2 drives it with the real dispatch over the trigger world (the loop guard, one run
// per event). Layer 3 reads what the code left in logs: ids and codes only, never what a sender wrote.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_START_TITLE_MAX } from "@rovara-code/contracts";
import { hookEventKey } from "@rovara-code/contracts";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import type { HookDelivery } from "../../packages/broker/src/triggers/ingress.js";
import { hookProviders } from "../../packages/broker/src/triggers/providers/index.js";
import { jiraProvider } from "../../packages/broker/src/triggers/providers/jira.js";
import { linearProvider } from "../../packages/broker/src/triggers/providers/linear.js";
import type { HookRecord } from "@rovara-code/contracts";
import { HOOK_1, HOOK_2, LINEAR_TENANT, ORG_A, SECRET_1, SECRET_2, TEAM, setupHookWorld, type HookWorld } from "../support/hook-fixtures.js";
import { HOOK_A, disposeGateWorlds, setupTriggerWorld } from "../support/trigger-world.js";
import type { ChainDefinitionInput } from "@rovara-code/contracts";

afterEach(disposeGateWorlds);

const OTHER_TEAM = "d1d1d1d1-1111-4111-8111-d1d1d1d1d1d1";
const OTHER_LINEAR_ORG = "99999999-9999-4999-8999-999999999999";
const JIRA_TENANT = { siteHost: "acme.atlassian.net", projectKey: "PAY" };
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };

// ---- bodies as the vendors send them (only the fields Rovara reads)
interface LinearOver { type?: string; action?: string; organizationId?: string; teamId?: string; id?: string; at?: number; title?: string; labels?: string[]; actor?: { id: string } | null; url?: string; identifier?: string | null; webhookId?: string }
function linearBody(w: HookWorld, over: LinearOver = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: over.id ?? "3f2b1c4e-0000-4000-8000-000000000007", number: 7, title: over.title ?? "Checkout fails", teamId: over.teamId ?? TEAM, team: { id: over.teamId ?? TEAM, key: "ENG" },
    labels: (over.labels ?? ["bug"]).map((name) => ({ id: `lbl-${name}`, name, color: "#fff" })), url: over.url ?? "https://linear.app/acme/issue/ENG-7/checkout-fails",
  };
  if (over.identifier !== null) data["identifier"] = over.identifier ?? "ENG-7";
  return {
    action: over.action ?? "create", type: over.type ?? "Issue", createdAt: new Date(w.clock.now).toISOString(), organizationId: over.organizationId ?? LINEAR_TENANT.organizationId,
    webhookTimestamp: over.at ?? w.clock.now - 5_000, webhookId: over.webhookId ?? "wh-1", url: data["url"],
    ...(over.actor === null ? { actor: null } : { actor: { id: over.actor?.id ?? "user-dana", type: "user", name: "Dana" } }), data,
  };
}
interface JiraOver { event?: string; host?: string; self?: string; project?: string; id?: string; key?: string; at?: number | string; labels?: string[]; type?: string; summary?: string; account?: string | null }
function jiraBody(w: HookWorld, over: JiraOver = {}): Record<string, unknown> {
  const id = over.id ?? "10042";
  return {
    timestamp: over.at ?? w.clock.now - 5_000, webhookEvent: over.event ?? "jira:issue_created", issue_event_type_name: "issue_created",
    ...(over.account === null ? {} : { user: { accountId: over.account ?? "5b10ac8d82e05b22cc7d4ef5", displayName: "Dana" } }),
    issue: {
      id, key: over.key ?? "PAY-12", self: over.self ?? `https://${over.host ?? "acme.atlassian.net"}/rest/api/2/issue/${id}`,
      fields: { summary: over.summary ?? "Refunds fail", project: { key: over.project ?? "PAY" }, issuetype: { name: over.type ?? "Bug" }, labels: over.labels ?? ["bug"] },
    },
  };
}

const sign = (secret: string, raw: Buffer): string => createHmac("sha256", secret).update(raw).digest("hex");
interface Signed { secret?: string; header?: string | undefined; raw?: Buffer; ip?: string }
function linearDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: Signed = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  return { source: "linear", hookId: hook.hookId, raw, headers: { "linear-signature": "header" in options ? options.header : sign(options.secret ?? SECRET_1, raw) }, sourceIp: options.ip ?? "203.0.113.7" };
}
function jiraDelivery(hook: Pick<HookRecord, "hookId">, body: unknown, options: Signed = {}): HookDelivery {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  return { source: "jira", hookId: hook.hookId, raw, headers: { "x-hub-signature": "header" in options ? options.header : `sha256=${sign(options.secret ?? SECRET_1, raw)}` }, sourceIp: options.ip ?? "203.0.113.7" };
}

async function linearWorld(providers = { linear: linearProvider, jira: jiraProvider }) {
  const w = setupHookWorld(providers);
  const hook = await w.hook({ source: "linear", hookId: HOOK_1, project: "web", tenant: LINEAR_TENANT });
  return { w, hook };
}
async function jiraWorld(tenant: Record<string, unknown> = JIRA_TENANT) {
  const w = setupHookWorld({ linear: linearProvider, jira: jiraProvider });
  const hook = await w.hook({ source: "jira", hookId: HOOK_1, project: "web", tenant: tenant as never });
  return { w, hook };
}
const noEventItems = (w: HookWorld) => w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"));

describe("Linear: a signed issue creation for the hook's team starts one issue.created event", () => {
  it("dispatches the event with the identifier as the subject id, the labels, the time from webhookTimestamp (milliseconds) and the actor's id", async () => {
    const { w, hook } = await linearWorld();
    const reply = await w.receive(linearDelivery(hook, linearBody(w, { at: w.clock.now - 90_000, labels: ["bug", "P1"] })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "linear", type: "issue.created", eventKey: "linear:issue:3f2b1c4e-0000-4000-8000-000000000007:create", project: "web", hookId: hook.hookId,
      occurredAt: new Date(w.clock.now - 90_000).toISOString(),
      subject: { kind: "issue", id: "ENG-7", title: "Checkout fails", url: "https://linear.app/acme/issue/ENG-7/checkout-fails" },
      fields: { label: ["bug", "P1"] }, actor: { kind: "external", id: "user-dana" },
    } });
  });

  it("says nothing of the actor when the body has none, and falls back to the team key and number, then to the id, for the subject", async () => {
    const { w, hook } = await linearWorld();
    await w.receive(linearDelivery(hook, linearBody(w, { actor: null, identifier: null, id: "a1" })));
    const body = linearBody(w, { identifier: null, id: "a2" });
    const data = body["data"] as Record<string, unknown>;
    delete data["team"];
    delete data["number"];
    await w.receive(linearDelivery(hook, body));
    expect(w.dispatched.map((entry) => [entry.event.subject.id, entry.event.actor])).toEqual([["ENG-7", { kind: "unknown" }], ["a2", { kind: "external", id: "user-dana" }]]);
  });

  it("answers 403 for the same body from another team of the same Linear organization, and for another organization's id, and starts and remembers nothing", async () => {
    const { w, hook } = await linearWorld();
    expect((await w.receive(linearDelivery(hook, linearBody(w, { teamId: OTHER_TEAM })))).status).toBe(403);
    expect((await w.receive(linearDelivery(hook, linearBody(w, { organizationId: OTHER_LINEAR_ORG })))).status).toBe(403);
    // Another organization's id on a body of a kind that is ignored is refused as well: the tenant is read first.
    expect((await w.receive(linearDelivery(hook, linearBody(w, { organizationId: OTHER_LINEAR_ORG, type: "Comment" })))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.tenant_mismatch")).toHaveLength(3);
  });

  it("answers 403 for a body with no organization, a team that is not the hook's, or no team at all, and for one that is not an object", async () => {
    const { w, hook } = await linearWorld();
    const noOrg = linearBody(w);
    delete noOrg["organizationId"];
    const noTeam = linearBody(w);
    delete (noTeam["data"] as Record<string, unknown>)["teamId"];
    delete (noTeam["data"] as Record<string, unknown>)["team"];
    for (const body of [noOrg, noTeam, [], "text", null]) expect((await w.receive(linearDelivery(hook, body))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
  });

  it("takes a team named only by data.team.id, and matches ids without regard to case", async () => {
    const { w, hook } = await linearWorld();
    const body = linearBody(w, { teamId: TEAM.toUpperCase(), organizationId: LINEAR_TENANT.organizationId.toUpperCase() });
    delete (body["data"] as Record<string, unknown>)["teamId"];
    expect((await w.receive(linearDelivery(hook, body))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });

  it("ignores, with a 202, a Comment, an issue update and an issue removal, and a create of another type, starting and remembering nothing", async () => {
    const { w, hook } = await linearWorld();
    for (const over of [{ type: "Comment" }, { action: "update" }, { action: "remove" }, { type: "IssueLabel" }, { type: "issue" }, { action: "Create" }]) {
      expect(await w.receive(linearDelivery(hook, linearBody(w, over)))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    }
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("ignores a signed issue creation it cannot read (no id, no time, a time that is no date) instead of failing the vendor's delivery", async () => {
    const { w, hook } = await linearWorld();
    const noId = linearBody(w);
    delete (noId["data"] as Record<string, unknown>)["id"];
    const noTime = linearBody(w);
    delete noTime["webhookTimestamp"];
    for (const body of [noId, noTime, { ...linearBody(w), webhookTimestamp: 9e18 }, { ...linearBody(w), webhookTimestamp: "now" }, { ...linearBody(w), webhookTimestamp: 1.5 }]) {
      expect(await w.receive(linearDelivery(hook, body))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    }
    expect(w.dispatched).toEqual([]);
  });

  it("refuses a bad signature: another secret, another body, a missing or malformed header, a signature of re-serialised bytes", async () => {
    const { w, hook } = await linearWorld();
    const body = linearBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const pretty = Buffer.from(JSON.stringify(body, null, 2), "utf8");
    const attempts = [
      linearDelivery(hook, body, { secret: SECRET_2 }),
      linearDelivery(hook, body, { header: sign(SECRET_1, Buffer.from("{}")) }),
      linearDelivery(hook, body, { header: undefined }),
      linearDelivery(hook, body, { header: "" }),
      linearDelivery(hook, body, { header: `sha256=${sign(SECRET_1, raw)}` }),
      linearDelivery(hook, body, { header: "not-hex" }),
      { ...linearDelivery(hook, body), raw: pretty },
    ];
    for (const attempt of attempts) expect((await w.receive(attempt)).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
    expect((await w.receive(linearDelivery(hook, body))).status).toBe(202);
  });

  it("takes the hex signature in upper case, and the previous secret during a rotation's overlap", async () => {
    const { w, hook } = await linearWorld();
    const upper = linearBody(w, { id: "u1" });
    const raw = Buffer.from(JSON.stringify(upper), "utf8");
    expect((await w.receive(linearDelivery(hook, upper, { header: sign(SECRET_1, raw).toUpperCase() }))).status).toBe(202);
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: new Date(w.clock.now + 3_600_000).toISOString() }));
    w.memory.remember(hook.hookId, undefined);
    expect((await w.receive(linearDelivery(hook, linearBody(w, { id: "u2" })))).status).toBe(202);
    expect((await w.receive(linearDelivery(hook, linearBody(w, { id: "u3" }), { secret: SECRET_2 }))).status).toBe(202);
  });

  it("starts no second event for the same issue: a replay with a new webhook id and time is a duplicate", async () => {
    const { w, hook } = await linearWorld();
    expect((await w.receive(linearDelivery(hook, linearBody(w)))).status).toBe(202);
    const again = await w.receive(linearDelivery(hook, linearBody(w, { webhookId: "wh-2", at: w.clock.now - 1_000 })));
    expect(again).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
    expect((await w.receive(linearDelivery(hook, linearBody(w, { id: "another-issue" })))).status).toBe(202);
    expect(w.dispatched).toHaveLength(2);
  });

  it("de-duplicates per hook, so the same issue under two projects' hooks of one org starts each project's own work", async () => {
    const { w, hook } = await linearWorld();
    const second = await w.hook({ source: "linear", hookId: HOOK_2, project: "api", tenant: LINEAR_TENANT });
    expect((await w.receive(linearDelivery(hook, linearBody(w)))).status).toBe(202);
    expect((await w.receive(linearDelivery(second, linearBody(w)))).status).toBe(202);
    expect(w.dispatched.map((entry) => [entry.event.project, entry.event.hookId])).toEqual([["web", HOOK_1], ["api", HOOK_2]]);
    expect(w.db.get(hookEventKey(ORG_A, HOOK_1, "linear:issue:3f2b1c4e-0000-4000-8000-000000000007:create"))).toBeDefined();
    expect(w.db.get(hookEventKey(ORG_A, HOOK_2, "linear:issue:3f2b1c4e-0000-4000-8000-000000000007:create"))).toBeDefined();
  });

  it("uses the time the body says: an event more than a day old is not started, and a body dated in seconds is not mistaken for a recent one", async () => {
    const { w, hook } = await linearWorld();
    expect((await w.receive(linearDelivery(hook, linearBody(w, { id: "old", at: w.clock.now - 25 * 3_600_000 })))).status).toBe(202);
    expect((await w.receive(linearDelivery(hook, linearBody(w, { id: "secs", at: Math.floor(w.clock.now / 1000) })))).status).toBe(202);
    expect(w.dispatched).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.stale")).toHaveLength(2);
    await w.receive(linearDelivery(hook, linearBody(w, { id: "fresh", at: w.clock.now - 23 * 3_600_000 })));
    expect(w.dispatched).toHaveLength(1);
  });

  it("cleans what a person wrote: a title with control characters or over the limit still starts the event, a link off linear.app is left out, and only real label names are kept", async () => {
    const { w, hook } = await linearWorld();
    await w.receive(linearDelivery(hook, linearBody(w, { id: "t1", title: `Fix\u0000 the‮ checkout\n${"x".repeat(500)}` })));
    await w.receive(linearDelivery(hook, linearBody(w, { id: "t2", title: "\u0000\u0007 ", url: "https://evil.example/linear.app" })));
    await w.receive(linearDelivery(hook, linearBody(w, { id: "t3", url: "http://linear.app/acme/issue/ENG-7" })));
    await w.receive(linearDelivery(hook, linearBody(w, { id: "t4", url: "https://user:pw@linear.app/acme/issue/ENG-7" })));
    await w.receive(linearDelivery(hook, linearBody(w, { id: "t5", url: "https://linear.app.evil.example/x" })));
    const labels = linearBody(w, { id: "t6" });
    (labels["data"] as Record<string, unknown>)["labels"] = [{ name: "ok" }, { name: "" }, { id: "no-name" }, "text", null, { name: "x".repeat(300) }];
    await w.receive(linearDelivery(hook, labels));
    const events = w.dispatched.map((entry) => entry.event);
    expect(events).toHaveLength(6);
    expect([...events[0]!.subject.title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(events[0]!.subject.title).toMatch(/^Fix the checkout x+$/);
    expect(events[0]!.subject.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(events[1]!.subject.title).toBe("ENG-7");
    for (const event of events.slice(1, 5)) expect(event.subject.url).toBeUndefined();
    expect(events[5]!.fields).toEqual({ label: ["ok", "x".repeat(200)] });
  });

  it("starts the events of an issue with no labels with an empty label list, and keeps the label values in the 50 an event may carry", async () => {
    const { w, hook } = await linearWorld();
    await w.receive(linearDelivery(hook, linearBody(w, { id: "l0", labels: [] })));
    await w.receive(linearDelivery(hook, linearBody(w, { id: "l1", labels: Array.from({ length: 80 }, (_, index) => `label-${String(index)}`) })));
    expect(w.dispatched[0]!.event.fields).toEqual({ label: [] });
    expect(w.dispatched[1]!.event.fields["label"]).toHaveLength(50);
  });
});

describe("Jira: a signed issue creation from the hook's site and project starts one issue.created event", () => {
  it("dispatches the event with the key as the subject, the browse link on the site, the labels and issue type, the time from timestamp (milliseconds) and the account", async () => {
    const { w, hook } = await jiraWorld();
    const reply = await w.receive(jiraDelivery(hook, jiraBody(w, { at: w.clock.now - 120_000, labels: ["bug", "customer"] })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "jira", type: "issue.created", eventKey: "jira:issue:10042:created", project: "web", hookId: hook.hookId, occurredAt: new Date(w.clock.now - 120_000).toISOString(),
      subject: { kind: "issue", id: "PAY-12", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-12" },
      fields: { label: ["bug", "customer"], issueType: ["Bug"] }, actor: { kind: "external", id: "5b10ac8d82e05b22cc7d4ef5" },
    } });
  });

  it("takes any project of the site when the hook names none, and a timestamp sent as a numeral", async () => {
    const { w, hook } = await jiraWorld({ siteHost: "acme.atlassian.net" });
    expect((await w.receive(jiraDelivery(hook, jiraBody(w, { project: "OPS", id: "1", at: String(w.clock.now - 1_000) })))).status).toBe(202);
    expect((await w.receive(jiraDelivery(hook, jiraBody(w, { project: "PAY", id: "2" })))).status).toBe(202);
    expect(w.dispatched).toHaveLength(2);
    expect(w.dispatched[0]!.event.occurredAt).toBe(new Date(w.clock.now - 1_000).toISOString());
  });

  it("answers 403 for another site, another project, and a site that only looks like the hook's, starting and remembering nothing", async () => {
    const { w, hook } = await jiraWorld();
    const selfs = [
      "https://other.atlassian.net/rest/api/2/issue/1",
      "https://acme.atlassian.net.evil.example/rest/api/2/issue/1",
      "https://evil.example/rest/api/2/issue/1?x=acme.atlassian.net",
      "https://acme.atlassian.net@evil.example/rest/api/2/issue/1",
      "http://acme.atlassian.net/rest/api/2/issue/1",
      "https://acme.atlassian.net:8443/rest/api/2/issue/1",
      "https://user:pw@acme.atlassian.net/rest/api/2/issue/1",
      "not a link",
      "",
    ];
    for (const self of selfs) expect((await w.receive(jiraDelivery(hook, jiraBody(w, { self })))).status, self).toBe(403);
    expect((await w.receive(jiraDelivery(hook, jiraBody(w, { project: "OPS" })))).status).toBe(403);
    expect((await w.receive(jiraDelivery(hook, jiraBody(w, { project: "pay" })))).status).toBe(403);
    const noSelf = jiraBody(w);
    delete (noSelf["issue"] as Record<string, unknown>)["self"];
    const noProject = jiraBody(w);
    delete ((noProject["issue"] as { fields: Record<string, unknown> }).fields)["project"];
    for (const body of [noSelf, noProject, [], "text", null, { webhookEvent: "jira:issue_created" }]) expect((await w.receive(jiraDelivery(hook, body))).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("answers 403 when the secret is wrong, the method is not sha256, the prefix is missing or the header is absent", async () => {
    const { w, hook } = await jiraWorld();
    const body = jiraBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const sha1 = createHmac("sha1", SECRET_1).update(raw).digest("hex");
    const attempts = [
      jiraDelivery(hook, body, { secret: SECRET_2 }),
      jiraDelivery(hook, body, { header: `sha1=${sha1}` }),
      jiraDelivery(hook, body, { header: sign(SECRET_1, raw) }),
      jiraDelivery(hook, body, { header: `sha256 ${sign(SECRET_1, raw)}` }),
      jiraDelivery(hook, body, { header: "sha256=" }),
      jiraDelivery(hook, body, { header: undefined }),
      jiraDelivery(hook, body, { header: `sha256=${sign(SECRET_1, Buffer.from("{}"))}` }),
      { ...jiraDelivery(hook, body), raw: Buffer.from(JSON.stringify(body, null, 1), "utf8") },
    ];
    for (const attempt of attempts) expect((await w.receive(attempt)).status).toBe(403);
    expect(w.dispatched).toEqual([]);
    expect((await w.receive(jiraDelivery(hook, body))).status).toBe(202);
  });

  it("takes the sha256 prefix and the hex in any case", async () => {
    const { w, hook } = await jiraWorld();
    const body = jiraBody(w);
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    expect((await w.receive(jiraDelivery(hook, body, { header: `SHA256=${sign(SECRET_1, raw).toUpperCase()}` }))).status).toBe(202);
  });

  it("ignores, with a 202, every other Jira event", async () => {
    const { w, hook } = await jiraWorld();
    for (const event of ["jira:issue_updated", "jira:issue_deleted", "comment_created", "project_created", ""]) {
      expect(await w.receive(jiraDelivery(hook, jiraBody(w, { event })))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    }
    expect(w.dispatched).toEqual([]);
    expect(noEventItems(w)).toEqual([]);
  });

  it("ignores a signed creation it cannot date or name, and leaves the link and the actor out when the key or the user is not there", async () => {
    const { w, hook } = await jiraWorld();
    const noTime = jiraBody(w);
    delete noTime["timestamp"];
    const noId = jiraBody(w);
    delete (noId["issue"] as Record<string, unknown>)["id"];
    for (const body of [noTime, noId, { ...jiraBody(w), timestamp: 9e18 }, { ...jiraBody(w), timestamp: "soon" }]) expect(await w.receive(jiraDelivery(hook, body))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    await w.receive(jiraDelivery(hook, jiraBody(w, { id: "77", key: "../../evil", account: null })));
    await w.receive(jiraDelivery(hook, jiraBody(w, { id: "78", key: "pay-1" })));
    expect(w.dispatched.map((entry) => [entry.event.subject.id, entry.event.subject.url, entry.event.actor.kind])).toEqual([["77", undefined, "unknown"], ["78", undefined, "external"]]);
  });

  it("starts no second event for the same issue (a replay with a new time is a duplicate), per hook", async () => {
    const { w, hook } = await jiraWorld();
    expect((await w.receive(jiraDelivery(hook, jiraBody(w)))).status).toBe(202);
    expect(await w.receive(jiraDelivery(hook, jiraBody(w, { at: w.clock.now - 500 })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.db.get(hookEventKey(ORG_A, HOOK_1, "jira:issue:10042:created"))).toBeDefined();
    const second = await w.hook({ source: "jira", hookId: HOOK_2, project: "api", tenant: JIRA_TENANT as never });
    expect((await w.receive(jiraDelivery(second, jiraBody(w)))).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.project)).toEqual(["web", "api"]);
  });

  it("uses the time the body says, in milliseconds", async () => {
    const { w, hook } = await jiraWorld();
    await w.receive(jiraDelivery(hook, jiraBody(w, { id: "old", at: w.clock.now - 25 * 3_600_000 })));
    await w.receive(jiraDelivery(hook, jiraBody(w, { id: "secs", at: Math.floor(w.clock.now / 1000) })));
    expect(w.dispatched).toEqual([]);
    await w.receive(jiraDelivery(hook, jiraBody(w, { id: "fresh", at: w.clock.now - 23 * 3_600_000 })));
    expect(w.dispatched).toHaveLength(1);
  });

  it("cleans the summary, labels and issue type a person wrote", async () => {
    const { w, hook } = await jiraWorld();
    const body = jiraBody(w, { summary: `Refund\u0000 fails\n${"y".repeat(500)}`, type: "" });
    ((body["issue"] as { fields: Record<string, unknown> }).fields)["labels"] = ["ok", "", 7, null, "z".repeat(300)];
    await w.receive(jiraDelivery(hook, body));
    const event = w.dispatched[0]!.event;
    expect([...event.subject.title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(event.subject.title).toMatch(/^Refund fails y+$/);
    expect(event.fields).toEqual({ label: ["ok", "z".repeat(200)], issueType: [] });
    await w.receive(jiraDelivery(hook, jiraBody(w, { id: "2", summary: "\u0000\u0007" })));
    expect(w.dispatched[1]!.event.subject.title).toBe("PAY-12");
  });
});

describe("what the first mutation pass found unpinned", () => {
  it("reads the signature headers whatever the case of their names", async () => {
    const { w, hook } = await linearWorld();
    const body = linearBody(w);
    const linear = linearDelivery(hook, body);
    expect((await w.receive({ ...linear, headers: { "Linear-Signature": linear.headers["linear-signature"] } })).status).toBe(202);
    const jira = await w.hook({ source: "jira", hookId: HOOK_2, project: "web", tenant: JIRA_TENANT as never });
    const signed = jiraDelivery(jira, jiraBody(w));
    expect((await w.receive({ ...signed, headers: { "X-Hub-Signature": signed.headers["x-hub-signature"] } })).status).toBe(202);
    // A header value with white space round it (a proxy's doing) is still the signature.
    const spaced = jiraDelivery(jira, jiraBody(w, { id: "5" }));
    expect((await w.receive({ ...spaced, headers: { "x-hub-signature": ` ${spaced.headers["x-hub-signature"]!} ` } })).status).toBe(202);
  });

  it("leaves out a link with a port or on a host that only ends like linear.app, and a Jira site that only ends like the hook's", async () => {
    const { w, hook } = await linearWorld();
    await w.receive(linearDelivery(hook, linearBody(w, { id: "p1", url: "https://linear.app:8443/acme/issue/ENG-7" })));
    await w.receive(linearDelivery(hook, linearBody(w, { id: "p2", url: "https://notlinear.app/acme/issue/ENG-7" })));
    expect(w.dispatched.map((entry) => entry.event.subject.url)).toEqual([undefined, undefined]);
    const jira = await w.hook({ source: "jira", hookId: HOOK_2, project: "web", tenant: JIRA_TENANT as never });
    expect((await w.receive(jiraDelivery(jira, jiraBody(w, { host: "notacme.atlassian.net" })))).status).toBe(403);
  });

  it("takes the link from the issue or, when it has none, from the top of the body, and prefers the issue's own", async () => {
    const { w, hook } = await linearWorld();
    const top = linearBody(w, { id: "u1" });
    delete (top["data"] as Record<string, unknown>)["url"];
    top["url"] = "https://linear.app/acme/issue/ENG-7/top";
    const both = linearBody(w, { id: "u2", url: "https://linear.app/acme/issue/ENG-7/data" });
    both["url"] = "https://linear.app/acme/issue/ENG-7/top";
    await w.receive(linearDelivery(hook, top));
    await w.receive(linearDelivery(hook, both));
    expect(w.dispatched.map((entry) => entry.event.subject.url)).toEqual(["https://linear.app/acme/issue/ENG-7/top", "https://linear.app/acme/issue/ENG-7/data"]);
  });

  it("names the issue by its id when it has a number but the body names no team, and starts events for issues with no labels, no label list or a label list that is not a list", async () => {
    const { w, hook } = await linearWorld();
    const noTeam = linearBody(w, { id: "n1", identifier: null });
    delete (noTeam["data"] as Record<string, unknown>)["team"];
    await w.receive(linearDelivery(hook, noTeam));
    const noLabels = linearBody(w, { id: "n2" });
    delete (noLabels["data"] as Record<string, unknown>)["labels"];
    await w.receive(linearDelivery(hook, noLabels));
    const oddLabels = linearBody(w, { id: "n3" });
    (oddLabels["data"] as Record<string, unknown>)["labels"] = "bug";
    await w.receive(linearDelivery(hook, oddLabels));
    expect(w.dispatched.map((entry) => [entry.event.subject.id, entry.event.fields["label"]])).toEqual([["n1", ["bug"]], ["ENG-7", []], ["ENG-7", []]]);
    const jira = await w.hook({ source: "jira", hookId: HOOK_2, project: "web", tenant: { siteHost: "acme.atlassian.net" } as never });
    const bare = jiraBody(w, { id: "j1" });
    delete ((bare["issue"] as { fields: Record<string, unknown> }).fields)["labels"];
    delete ((bare["issue"] as { fields: Record<string, unknown> }).fields)["issuetype"];
    await w.receive(jiraDelivery(jira, bare));
    const odd = jiraBody(w, { id: "j2" });
    ((odd["issue"] as { fields: Record<string, unknown> }).fields)["labels"] = "bug";
    ((odd["issue"] as { fields: Record<string, unknown> }).fields)["issuetype"] = null;
    await w.receive(jiraDelivery(jira, odd));
    expect(w.dispatched.slice(3).map((entry) => entry.event.fields)).toEqual([{ label: [], issueType: [] }, { label: [], issueType: [] }]);
  });

  it("ignores a time of 0 or past what a date can hold, and logs a body that is not an object as a tenant refusal (not as a failure to read it)", async () => {
    const { w, hook } = await linearWorld();
    const jira = await w.hook({ source: "jira", hookId: HOOK_2, project: "web", tenant: JIRA_TENANT as never });
    for (const at of [0, 8_700_000_000_000_000]) {
      expect(await w.receive(linearDelivery(hook, { ...linearBody(w), webhookTimestamp: at }))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
      expect(await w.receive(jiraDelivery(jira, { ...jiraBody(w), timestamp: at }))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    }
    expect(w.dispatched).toEqual([]);
    for (const body of [[], "text", null]) {
      await w.receive(linearDelivery(hook, body));
      await w.receive(jiraDelivery(jira, body));
    }
    expect(w.logs.filter((entry) => entry.event === "hook.tenant_mismatch")).toHaveLength(6);
    expect(w.logs.filter((entry) => entry.event === "hook.normalize_failed")).toEqual([]);
  });
});

describe("the providers are the ones the broker uses", () => {
  it("registers Linear (vendor secret, hmac) and Jira (Rovara's secret, hmac) and the sources of Tasks 23 to 25 only as they land (PagerDuty and Sentry now)", () => {
    const providers = hookProviders();
    expect(providers.linear).toBe(linearProvider);
    expect(providers.jira).toBe(jiraProvider);
    expect([linearProvider.secretOrigin, linearProvider.auth, linearProvider.source]).toEqual(["vendor", "hmac", "linear"]);
    expect([jiraProvider.secretOrigin, jiraProvider.auth, jiraProvider.source]).toEqual(["rovara", "hmac", "jira"]);
    expect(Object.keys(providers).sort()).toEqual(["cloudwatch", "datadog", "grafana", "jira", "linear", "pagerduty", "sentry", "vercel"]);
  });

  it("refuses to read a hook of another source: a Linear provider answers a tenant mismatch for a Jira hook, and the other way", async () => {
    const { w, hook } = await jiraWorld();
    const wrong = { ...hook, source: "linear" } as unknown as HookRecord;
    expect(linearProvider.normalize(linearBody(w), {}, hook)).toEqual({ tenantMismatch: true });
    expect(jiraProvider.normalize(jiraBody(w), {}, { ...wrong, source: "linear" })).toEqual({ tenantMismatch: true });
  });
});

// ---- layer 2: the real dispatch
describe("through Task 20's dispatch: the loop guard and one run per event", () => {
  async function dispatching() {
    const v = setupTriggerWorld();
    (v.routeDeps as { log?: unknown }).log = () => undefined;
    const w = setupHookWorld({ linear: linearProvider, jira: jiraProvider }, { db: v.db, clock: v.clock });
    w.deps.dispatch = async (orgId, event) => dispatchTriggerEvent(v.routeDeps as never, orgId, event);
    const chain = await v.budgetedChain(ONE_STEP);
    const runs = () => v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META");
    const linearHook = await w.hook({ source: "linear", hookId: HOOK_A, project: "web", tenant: LINEAR_TENANT });
    v.hook("linear", HOOK_A);
    v.connection("linear", "rovara-linear-user");
    const linearTrigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created", filter: { label: ["bug"] } }, hookId: HOOK_A });
    return { v, w, chain, runs, linearHook, linearTrigger };
  }
  const outcomes = async (v: Awaited<ReturnType<typeof dispatching>>["v"], triggerId: string) => (await v.triggers.listActivity(ORG_A, triggerId)).map((entry) => [entry.outcome, entry.reason]);

  it("starts one chain run for a person's Linear issue, and none for one the org's Rovara account created", async () => {
    const { v, w, runs, linearHook, linearTrigger } = await dispatching();
    expect((await w.receive(linearDelivery(linearHook, linearBody(w, { id: "mine", actor: { id: "rovara-linear-user" } })))).status).toBe(202);
    expect(runs()).toEqual([]);
    expect(await outcomes(v, linearTrigger.triggerId)).toEqual([["skipped", "caused_by_rovara"]]);
    expect((await w.receive(linearDelivery(linearHook, linearBody(w, { id: "theirs", actor: { id: "someone-else" } })))).status).toBe(202);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ origin: "event", project: "web", startedBy: { kind: "event", triggerId: linearTrigger.triggerId, source: "linear", type: "issue.created", title: "Checkout fails" } });
    expect((await outcomes(v, linearTrigger.triggerId)).map((entry) => entry[0]).sort()).toEqual(["skipped", "started"]);
  });

  it("starts no second run when the same Linear issue is delivered again, whatever its webhook id", async () => {
    const { w, runs, linearHook } = await dispatching();
    await w.receive(linearDelivery(linearHook, linearBody(w)));
    expect(await w.receive(linearDelivery(linearHook, linearBody(w, { webhookId: "wh-9", at: w.clock.now - 100 })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(runs()).toHaveLength(1);
  });

  it("starts only the triggers whose label filter the issue meets", async () => {
    const { v, w, chain, runs, linearHook, linearTrigger } = await dispatching();
    const docs = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "linear", type: "issue.created", filter: { label: ["docs"] } }, hookId: HOOK_A });
    await w.receive(linearDelivery(linearHook, linearBody(w, { labels: ["Bug"] })));
    expect(runs()).toHaveLength(1);
    expect(await outcomes(v, docs.triggerId)).toEqual([]);
    expect(await outcomes(v, linearTrigger.triggerId)).toEqual([["started", undefined]]);
  });

  it("skips a Jira issue the org's Jira account created, and starts one for a person", async () => {
    const { v, w, chain, runs } = await dispatching();
    const jiraHook = await w.hook({ source: "jira", hookId: `hk_${"b".repeat(26)}`, project: "web", tenant: JIRA_TENANT as never });
    v.hook("jira", jiraHook.hookId);
    v.connection("jira", "rovara-jira-account");
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "jira", type: "issue.created", filter: { issueType: ["bug"] } }, hookId: jiraHook.hookId });
    await w.receive(jiraDelivery(jiraHook, jiraBody(w, { id: "1", account: "rovara-jira-account" })));
    expect(runs()).toEqual([]);
    expect(await outcomes(v, trigger.triggerId)).toEqual([["skipped", "caused_by_rovara"]]);
    await w.receive(jiraDelivery(jiraHook, jiraBody(w, { id: "2", key: "PAY-13", account: "5b10ac8d82e05b22cc7d4ef5" })));
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ startedBy: { source: "jira", type: "issue.created", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-13" } });
  });

  it("does not let a Jira body's tenant mismatch or a Linear one reach dispatch", async () => {
    const { w, runs, linearHook } = await dispatching();
    expect((await w.receive(linearDelivery(linearHook, linearBody(w, { teamId: OTHER_TEAM })))).status).toBe(403);
    expect(runs()).toEqual([]);
  });
});

// ---- layer 3: what is logged
describe("nothing a sender wrote reaches a log", () => {
  const MARK = "SECRET-MARKER-9f3a";

  it("keeps the title, labels, names, ids and links of Linear and Jira bodies out of every log line, on every path", async () => {
    const { w, hook } = await linearWorld();
    const jira = await w.hook({ source: "jira", hookId: HOOK_2, project: "web", tenant: JIRA_TENANT as never });
    const marked = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(body).replaceAll("Checkout fails", `${MARK}-title`).replaceAll("bug", `${MARK}-label`).replaceAll("user-dana", `${MARK}-actor`)) as Record<string, unknown>;
    const attempts: HookDelivery[] = [
      linearDelivery(hook, marked(linearBody(w))),
      linearDelivery(hook, marked(linearBody(w, { teamId: OTHER_TEAM, id: `${MARK}-id` }))),
      linearDelivery(hook, marked(linearBody(w, { type: "Comment" }))),
      linearDelivery(hook, marked(linearBody(w, { id: `${MARK}-dup2` })), { secret: SECRET_2 }),
      linearDelivery(hook, { ...marked(linearBody(w)), webhookTimestamp: "bad" }),
      jiraDelivery(jira, marked(jiraBody(w, { summary: `${MARK}-summary`, account: `${MARK}-account` }))),
      jiraDelivery(jira, marked(jiraBody(w, { host: "other.atlassian.net", summary: `${MARK}-summary` }))),
      jiraDelivery(jira, marked(jiraBody(w, { event: "jira:issue_updated", summary: `${MARK}-summary` }))),
      jiraDelivery(jira, marked(jiraBody(w, { id: "2", at: w.clock.now - 30 * 3_600_000, summary: `${MARK}-summary` }))),
    ];
    for (const attempt of attempts) await w.receive(attempt);
    // A positive control: the paths ran (an event was accepted, a tenant refused, an old one dropped) and logged their ids and codes.
    expect(w.dispatched).toHaveLength(2);
    expect(w.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["hook.tenant_mismatch", "hook.stale"]));
    expect(JSON.stringify(w.logs)).not.toContain(MARK);
    expect(JSON.stringify(w.logs)).not.toContain("webhookTimestamp");
  });
});
