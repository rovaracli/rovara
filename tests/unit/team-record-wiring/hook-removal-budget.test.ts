// Task 6 item 5: a hook delivery whose REMOVAL has not finished inside the 1.5 s hook budget is answered 503 (the vendor sends it again); a put keeps today's answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOOK_RECORD_TAP_BUDGET_MS } from "../../../packages/broker/src/triggers/ingress.js";
import { createHookRecordTap } from "../../../packages/broker/src/team-record/sources/ticket-webhooks.js";
import { LINEAR_TENANT, setupHookWorld } from "../../support/hook-fixtures.js";

afterEach(() => { vi.useRealTimers(); });
const body = (tenant: unknown, id = "evt-1") => ({ id, tenant });

describe("a removal past the hook budget", () => {
  it("answers 503 and sends nothing on, when the tap said a removal began and it has not finished in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const world = setupHookWorld();
    world.deps.recordTap = (input: { removalStarted?: () => void }) => { input.removalStarted?.(); return new Promise(() => undefined); };
    const hook = await world.hook({ source: "linear" });
    const answered = world.receive(world.delivery(hook, body(LINEAR_TENANT)));
    await vi.advanceTimersByTimeAsync(HOOK_RECORD_TAP_BUDGET_MS + 100);
    expect((await answered).status).toBe(503);
    expect(world.dispatched).toHaveLength(0);
  });

  it("a removal that finishes inside the budget, and a put that is slow, answer as before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const world = setupHookWorld();
    world.deps.recordTap = async (input: { removalStarted?: () => void }) => { input.removalStarted?.(); };
    const hook = await world.hook({ source: "linear" });
    expect((await world.receive(world.delivery(hook, body(LINEAR_TENANT)))).status).toBe(202);
    world.deps.recordTap = () => new Promise(() => undefined); // a put: no removal began
    const answered = world.receive(world.delivery(hook, body(LINEAR_TENANT, "evt-2")));
    await vi.advanceTimersByTimeAsync(HOOK_RECORD_TAP_BUDGET_MS + 100);
    expect((await answered).status).toBe(202);
  });
});

describe("the hook adapter says when a removal begins", () => {
  it("calls removalStarted before the recorder is asked to remove, for a delete only", async () => {
    const order: string[] = [];
    const adapter = createHookRecordTap({ recorder: { record: async () => { order.push("record"); return "stored"; }, remove: async () => { order.push("remove"); } } });
    const hook = { source: "linear", project: "web", tenant: LINEAR_TENANT };
    const remove = { type: "Issue", action: "remove", organizationId: LINEAR_TENANT.organizationId, data: { id: "i1", teamId: LINEAR_TENANT.teamId } };
    const create = { type: "Issue", action: "create", organizationId: LINEAR_TENANT.organizationId, data: { id: "i1", teamId: LINEAR_TENANT.teamId, title: "t" } };
    await adapter({ orgId: "org-1", hook, body: remove, removalStarted: () => order.push("started") });
    await adapter({ orgId: "org-1", hook, body: create, removalStarted: () => order.push("started-wrong") });
    expect(order).toEqual(["started", "remove", "record"]);
  });
});
