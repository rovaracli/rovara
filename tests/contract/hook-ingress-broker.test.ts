// Plan 4 Task 19: the endpoint and the routes through the real broker handler. A delivery reaches ingress before authentication, over the bytes API Gateway decoded (a base64 body is
// verified over its decoded bytes, with the source address API Gateway names), is answered with exactly the body ingress made, and nothing is accepted where nothing can start the
// work. The hook routes sit under the project routes with the cell's address, and closing an org takes its hooks away.
import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { hookKey, hookLookupKey } from "@rovara-code/contracts";
import { HookStore } from "../../packages/broker/src/triggers/hooks.js";
import { HookIngressMemory } from "../../packages/broker/src/triggers/ingress.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { FakeHookSecrets, HOOK_1, LINEAR_TENANT, SECRET_1, SIGNATURE_HEADER, hmacProvider } from "../support/hook-fixtures.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { OrgId } from "@rovara-code/contracts";
import type { TriggerEvent } from "@rovara-code/contracts";

beforeAll(async () => { await loadSlackBroker(); });

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const FORBIDDEN = JSON.stringify({ error: { code: "FORBIDDEN", message: "signature check failed" } });

async function brokerWorld(options: { dispatch?: boolean } = { dispatch: true }) {
  const secrets = new FakeHookSecrets();
  const memory = new HookIngressMemory();
  const dispatched: Array<{ orgId: string; event: TriggerEvent }> = [];
  const members = new FakeProjectMembers();
  members.addProject(TEST_ORG, "web");
  const h = await createDeveloperTaskBroker({
    register: false, cloud: true,
    brokerExtra: {
      cloud: true,
      agents: {
        projectMembers: members,
        eventHooks: { secrets, memory, providers: { linear: hmacProvider("linear") }, ...(options.dispatch === false ? {} : { dispatch: async (orgId: string, event: TriggerEvent) => { dispatched.push({ orgId, event }); } }) },
      },
    },
  } as never);
  const store = new HookStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.create({ orgId: TEST_ORG, hookId: HOOK_1, source: "linear", project: "web", tenant: LINEAR_TENANT, auth: "hmac", hasSecret: true, status: "active", createdBy: "d".repeat(64), createdAt: new Date().toISOString() });
  secrets.values.set(`${TEST_ORG}|${HOOK_1}`, JSON.stringify({ current: SECRET_1 }));
  const post = (raw: Buffer, over: { base64?: boolean; headers?: Record<string, string>; method?: string; hookId?: string; source?: string; signed?: boolean; ip?: string; routeKey?: string } = {}) => {
    const signature = createHmac("sha256", SECRET_1).update(raw).digest("hex");
    return h.handler({
      version: "2.0", routeKey: over.routeKey ?? "POST /v1/hooks/{source}/{hookId}", rawPath: `/v1/hooks/${over.source ?? "linear"}/${over.hookId ?? HOOK_1}`, rawQueryString: "",
      headers: { "content-type": "application/json", ...(over.signed === false ? {} : { [SIGNATURE_HEADER.toUpperCase()]: signature }), ...over.headers },
      body: over.base64 === false ? raw.toString("utf8") : raw.toString("base64"), isBase64Encoded: over.base64 !== false,
      requestContext: { requestId: randomUUID(), http: { method: over.method ?? "POST", sourceIp: over.ip ?? "203.0.113.9" } },
    }) as Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  };
  return { h, secrets, memory, dispatched, store, post, members };
}

const eventBody = (id: string, text = "Fix it") => Buffer.from(JSON.stringify({ id, tenant: LINEAR_TENANT, occurredAt: new Date().toISOString(), note: text }), "utf8");

describe("a delivery through the broker", () => {
  it("verifies a base64 body over its decoded bytes (multi-byte characters included), starts one event and answers 202 with ingress's own body", async () => {
    const w = await brokerWorld();
    const reply = await w.post(eventBody("e1", "Zürich ✓ 日本語"));
    expect(reply.statusCode).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ delivery: "ACCEPTED", events: 1 });
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: TEST_ORG, event: { source: "linear", project: "web", hookId: HOOK_1, eventKey: "test:e1" } });
    // A body that came as text is verified as the bytes of that text.
    expect((await w.post(eventBody("e2"), { base64: false })).statusCode).toBe(202);
    // The same body again is a duplicate.
    expect((await w.post(eventBody("e1", "Zürich ✓ 日本語"))).statusCode).toBe(200);
  });

  it("answers a forged delivery with exactly the uniform body (no request id), writes nothing, and counts the address API Gateway names", async () => {
    const w = await brokerWorld();
    const mark = w.h.db.commandNames().length;
    const reply = await w.post(eventBody("e1"), { signed: false, ip: "198.51.100.77" });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toBe(FORBIDDEN);
    expect(w.h.db.commandNames().slice(mark).filter((name) => /^(Put|Update|Delete|TransactWrite)/.test(name))).toEqual([]);
    expect(w.memory.addresses.count("198.51.100.77", Date.now())).toBe(1);
    // A body changed after it was signed: signed over other bytes.
    const tampered = await w.post(eventBody("e1"), { headers: { [SIGNATURE_HEADER.toUpperCase()]: createHmac("sha256", SECRET_1).update(eventBody("e2")).digest("hex") } });
    expect(tampered).toMatchObject({ statusCode: 403, body: FORBIDDEN });
    expect(w.dispatched).toEqual([]);
  });

  it("answers an unknown hook, another source's path and a hook of another org the same way, and a GET as not found", async () => {
    const w = await brokerWorld();
    const unknown = await w.post(eventBody("e1"), { hookId: `hk_${"8".repeat(26)}` });
    const wrongSource = await w.post(eventBody("e1"), { source: "sentry" });
    expect([unknown.statusCode, unknown.body]).toEqual([403, FORBIDDEN]);
    expect([wrongSource.statusCode, wrongSource.body]).toEqual([403, FORBIDDEN]);
    expect((await w.post(eventBody("e1"), { method: "GET" })).statusCode).toBe(404);
    expect((await w.post(eventBody("e1"), { method: "PUT" })).statusCode).toBe(404);
  });

  it("takes a delivery only on the hook route's own key: the same path on another route is not a hook delivery and starts nothing", async () => {
    const w = await brokerWorld();
    for (const routeKey of ["ANY /{proxy+}", "ANY /v1/app/{proxy+}", "POST /v1/github/webhooks", "$default"]) {
      const reply = await w.post(eventBody("e1"), { routeKey });
      expect(reply.statusCode, routeKey).not.toBe(202);
      expect(reply.statusCode, routeKey).not.toBe(200);
    }
    expect(w.dispatched).toEqual([]);
    expect((await w.post(eventBody("e1"))).statusCode).toBe(202);
  });

  it("answers 413 for a body over a megabyte without reading anything", async () => {
    const w = await brokerWorld();
    const mark = w.h.db.commandNames().length;
    const reply = await w.post(Buffer.alloc(1_048_577, 0x61));
    expect(reply.statusCode).toBe(413);
    expect(w.h.db.commandNames().length).toBe(mark);
    expect(w.secrets.reads).toBe(0);
  });

  it("starts the work with the broker's own dispatch when none is given: an event no trigger is for is accepted, starts nothing and is a duplicate the second time", async () => {
    const w = await brokerWorld({ dispatch: false });
    const reply = await w.post(eventBody("e1"));
    expect(reply.statusCode).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ delivery: "ACCEPTED", events: 1 });
    expect(w.dispatched).toEqual([]);
    expect((await w.post(eventBody("e1"))).statusCode).toBe(200);
  });
});

describe("the hook routes and closing an org, through the broker", () => {
  it("makes a hook at the cell's address for a maintainer, with the secret stored through the secret store, and lists it without the secret", async () => {
    const w = await brokerWorld();
    await w.h.orgOf(MAYA);
    seedMembership(w.h.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const made = await w.h.dev(MAYA, "POST", "/v1/app/projects/web/event-hooks", { requestId: randomUUID(), source: "linear", tenant: LINEAR_TENANT, secret: `${SECRET_1}-new` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const hook = made.body["hook"] as { hookId: string; url: string };
    expect(hook.url).toBe(`${new URL(DEV_ISSUER).origin}/v1/hooks/linear/${hook.hookId}`);
    expect(w.secrets.stored(TEST_ORG, hook.hookId)).toEqual({ current: `${SECRET_1}-new` });
    const listed = await w.h.dev(MAYA, "GET", "/v1/app/projects/web/event-hooks");
    expect((listed.body["hooks"] as unknown[]).length).toBe(2);
    expect(JSON.stringify(listed.body)).not.toContain(SECRET_1);
    // A source with no provider here can't have a hook.
    expect((await w.h.dev(MAYA, "POST", "/v1/app/projects/web/event-hooks", { requestId: randomUUID(), source: "cloudwatch", tenant: { awsAccountId: "123456789012", topicArn: "arn:aws:sns:us-east-1:123456789012:alarms" } })).status).toBe(503);
  });

  it("turns an org's hooks off and schedules their secrets' deletion when its last owner leaves, and leaves another org's hooks alone", async () => {
    const h = await createDeveloperTaskBroker({
      register: false, orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG),
      brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers(), eventHooks: { secrets: new FakeHookSecrets(), providers: { linear: hmacProvider("linear") } } } },
    });
    const secrets = (h.brokerInput as unknown as { agents: { eventHooks: { secrets: FakeHookSecrets } } }).agents.eventHooks.secrets;
    for (const [who, orgId] of [[MAYA, TEST_ORG], [OMAR, ORG_B]] as const) {
      await h.orgOf(who);
      seedMembership(h.db, who.developerId, { orgId, role: "owner" });
    }
    const store = new HookStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const make = (orgId: OrgId, hookId: string) => store.create({ orgId, hookId, source: "linear", project: "web", tenant: LINEAR_TENANT, auth: "hmac", hasSecret: true, status: "active", createdBy: "d".repeat(64), createdAt: new Date().toISOString() });
    const mine = `hk_${"a".repeat(26)}`;
    const theirs = `hk_${"b".repeat(26)}`;
    await make(TEST_ORG, mine);
    await make(ORG_B, theirs);
    const left = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(await store.record(TEST_ORG, mine)).toMatchObject({ status: "disabled" });
    expect(h.db.get(hookLookupKey(mine))).toBeUndefined();
    expect(secrets.deleted).toEqual([`${TEST_ORG}|${mine}`]);
    expect(await store.record(ORG_B, theirs)).toMatchObject({ status: "active" });
    expect(h.db.get(hookLookupKey(theirs))).toMatchObject({ orgId: ORG_B });
    expect(h.db.get(hookKey(ORG_B, theirs))).toBeDefined();
  });
});
