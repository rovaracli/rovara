// Plan 4 Task 19, review fixes: the gateway throttle of the public hook route, a short memory of unknown hook ids, a de-duplication item that stays `pending` until dispatch is
// recorded (a crash between the two no longer loses the event), the count of events beyond the 50th, a 60-second secret cache, and the hook route's own key.
import { beforeAll, describe, expect, it } from "vitest";
import { Template } from "aws-cdk-lib/assertions";
import { Stack } from "aws-cdk-lib";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { HOOK_MAX_EVENTS_PER_DELIVERY, hookEventKey } from "@rovara-code/contracts";
import { HookIngressMemory } from "../../packages/broker/src/triggers/ingress.js";
import { LINEAR_TENANT, ORG_A, SECRET_1, SECRET_2, iso, setupHookWorld, type HookWorld, type TestBody } from "../support/hook-fixtures.js";

const SECOND = 1000;
const bodyOf = (w: HookWorld, id: string, over: Partial<TestBody> = {}): TestBody => ({ id, tenant: LINEAR_TENANT, occurredAt: iso(w.clock.now), ...over });
const itemOf = (w: HookWorld, hookId: string, eventKey: string) => w.db.get(hookEventKey(ORG_A, hookId, eventKey));

describe("the public hook route is throttled at the gateway", () => {
  let template: { Resources: Record<string, { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[] }> };
  beforeAll(() => {
    const app = buildAgentXApp({ agentxEnv: "staging" });
    template = Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!).toJSON() as typeof template;
  }, 300_000);

  it("gives POST /v1/hooks/{source}/{hookId} its own bucket of 100 burst and 50 a second, and the stage waits for the route", () => {
    const key = "POST /v1/hooks/{source}/{hookId}";
    const [stage] = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Stage");
    const settings = stage!.Properties["RouteSettings"] as Record<string, unknown>;
    expect(settings[key]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 });
    const route = Object.entries(template.Resources).find(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties["RouteKey"] === key);
    expect(route).toBeDefined();
    expect([stage!.DependsOn].flat()).toContain(route![0]);
    // The other public routes keep their own, smaller bucket.
    expect(settings["POST /v1/github/install/confirm"]).toEqual({ ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 });
  });
});

describe("an unknown hook id is remembered for a minute", () => {
  const unknown = { source: "linear", hookId: `hk_${"4".repeat(26)}` };

  it("answers the same 403 and makes no DynamoDB call for the same unknown id again, until a minute has passed", async () => {
    const w = setupHookWorld();
    await w.hook();
    const first = await w.receive(w.delivery(unknown, bodyOf(w, "x")));
    expect(first.status).toBe(403);
    const mark = w.db.commandNames().length;
    expect(await w.receive(w.delivery(unknown, bodyOf(w, "y")))).toEqual(first);
    expect(w.commandsSince(mark)).toEqual([]);
    w.clock.now += 59 * SECOND;
    await w.receive(w.delivery(unknown, bodyOf(w, "z")));
    expect(w.commandsSince(mark)).toEqual([]);
    w.clock.now += 2 * SECOND;
    expect((await w.receive(w.delivery(unknown, bodyOf(w, "late")))).status).toBe(403);
    expect(w.commandsSince(mark).length).toBeGreaterThan(0);
  });

  it("does not remember a hook that exists, so a real hook is never refused for another's miss", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    await w.receive(w.delivery(unknown, bodyOf(w, "x")));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "real")))).status).toBe(202);
  });

  it("holds at most a bounded number of ids and forgets the oldest first", () => {
    const memory = new HookIngressMemory();
    const now = Date.now();
    for (let index = 0; index < 10_001; index += 1) memory.noteUnknown(`hk_${String(index)}`, now);
    expect(memory.isUnknown("hk_0", now)).toBe(false);
    expect(memory.isUnknown("hk_10000", now)).toBe(true);
    expect(memory.isUnknown("hk_5000", now + 61 * SECOND)).toBe(false);
  });
});

describe("a crash between recording an event and starting its work does not lose it", () => {
  it("keeps the item pending while the event is being started and marks it dispatched after", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    let seen: unknown;
    const original = w.deps.dispatch.bind(w.deps);
    w.deps.dispatch = async (orgId, event) => { seen = itemOf(w, hook.hookId, event.eventKey)?.["status"]; return original(orgId, event); };
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e1")))).status).toBe(202);
    expect(seen).toBe("pending");
    expect(itemOf(w, hook.hookId, "test:e1")?.["status"]).toBe("dispatched");
  });

  it("starts an event again when the vendor's retry finds its item pending for more than 120 seconds, once", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    // The state a crash leaves: recorded, never marked.
    w.db.set({ ...hookEventKey(ORG_A, hook.hookId, "test:e1"), entityType: "HOOK_EVENT", orgId: ORG_A, hookId: hook.hookId, status: "pending", at: iso(w.clock.now), indexExpiresAt: Math.floor(w.clock.now / 1000) + 72 * 3600 });
    const delivery = w.delivery(hook, bodyOf(w, "e1"));
    w.clock.now += 119 * SECOND;
    expect(await w.receive(delivery)).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toEqual([]);
    w.clock.now += 2 * SECOND;
    const [one, two] = await Promise.all([w.receive(delivery), w.receive(delivery)]);
    expect([one.status, two.status].sort()).toEqual([200, 202]);
    expect(w.dispatched).toHaveLength(1);
    expect(itemOf(w, hook.hookId, "test:e1")?.["status"]).toBe("dispatched");
    expect(await w.receive(delivery)).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
  });

  it("treats an item written before the status existed as dispatched, however old it is", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    w.db.set({ ...hookEventKey(ORG_A, hook.hookId, "test:e1"), entityType: "HOOK_EVENT", orgId: ORG_A, hookId: hook.hookId, at: iso(w.clock.now - 3600 * SECOND), indexExpiresAt: Math.floor(w.clock.now / 1000) + 3600 });
    expect(await w.receive(w.delivery(hook, bodyOf(w, "e1")))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toEqual([]);
  });

  it("writes the item again when it was forgotten between the failed write and the read of it", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    w.db.injectFault({ command: "PutCommand", match: (input) => String((input["Item"] as { pk?: string } | undefined)?.pk).includes("HOOK_EVENT#"), error: { name: "ConditionalCheckFailedException" } });
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e1")))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });

  it("answers a dispatched event as a duplicate an hour later, whatever the pending window is", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    const delivery = w.delivery(hook, bodyOf(w, "e1"));
    expect((await w.receive(delivery)).status).toBe(202);
    w.clock.now += 3600 * SECOND;
    expect((await w.receive(delivery)).status).toBe(200);
    expect(w.dispatched).toHaveLength(1);
  });
});

describe("events beyond the 50th", () => {
  it("answers 202 and logs how many were dropped, as a count and nothing of the payload", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    const events = Array.from({ length: HOOK_MAX_EVENTS_PER_DELIVERY + 7 }, (_, index) => ({ id: `n${String(index)}` }));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "g", { events })))).status).toBe(202);
    const entry = w.logs.find((log) => log.event === "hook.too_many_events")!;
    expect(entry.fields).toEqual({ hookId: hook.hookId, events: HOOK_MAX_EVENTS_PER_DELIVERY + 7, dropped: 7 });
  });
});

describe("the secret cache lives for 60 seconds", () => {
  it("believes a rotated secret everywhere within a minute: the old secret is refused and the new one accepted once the cached copy is a minute old", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(202);
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_2 }));
    w.clock.now += 59 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "b"), { secret: SECRET_1 }))).status).toBe(202);
    w.clock.now += 2 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "c"), { secret: SECRET_1 }))).status).toBe(403);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "d"), { secret: SECRET_2 }))).status).toBe(202);
  });

  it("stops believing a hook at once when it is turned off, whatever the cache holds", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(202);
    await w.store.disable(ORG_A, hook.hookId);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "b")))).status).toBe(403);
  });
});
