// S3 review M-5: a step's fence that trips is retried or blocked with words, never dropped silently. The store wrapper (cloud/app/step-fence.ts) throws a retryable error for a transaction that
// failed on a marked fence item; the flow's dispatch sweep then reschedules the row (it asks the step check again) and, after its attempts, blocks the workflow with a reason the owner reads.
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import type { TaskAccess } from "@rovara-code/broker/core/task-flow";
import { when, type TransactItem } from "@rovara-code/contracts";
import { STEP_FENCE_TRIPPED_WORDS, markStepFence, retryOnFenceTrip } from "../../packages/broker/src/cloud/app/index.js";
import { allowAll, plannedTask, press, rig } from "../support/cloud-core-rig.js";
import { BROWSER_SESSION_METHOD } from "../../packages/broker/src/cloud/adapters/people/index.js";

afterEach(() => undefined);

const failing = (key: { pk: string; sk: string }): Extract<TransactItem, { kind: "check" }> => ({ kind: "check", key, condition: when.eq("revision", 99) });

describe("retryOnFenceTrip", () => {
  it("a transaction that failed on a marked fence item is thrown as retryable; one that failed on anything else is returned as it was; an applied one is untouched", async () => {
    const store = retryOnFenceTrip(new MemoryDocumentStore());
    await store.put({ item: { pk: "A", sk: "1", revision: 1 } });
    const fence = markStepFence([failing({ pk: "A", sk: "1" })]);
    await expect(store.transact([{ kind: "put", item: { pk: "B", sk: "1" } }, ...fence])).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: expect.stringContaining(STEP_FENCE_TRIPPED_WORDS) as string });
    // Nothing was written by the failed transaction.
    expect(await store.get({ pk: "B", sk: "1" })).toBeUndefined();
    // The same condition, unmarked, is the store's own answer (a lost race the flow reads for itself).
    expect(await store.transact([failing({ pk: "A", sk: "1" })])).toMatchObject({ applied: false });
    expect(await store.transact(markStepFence([{ kind: "check", key: { pk: "A", sk: "1" }, condition: when.eq("revision", 1) }]))).toMatchObject({ applied: true });
  });

  it("is one wrapper per store, and every other call is the store's own", async () => {
    const base = new MemoryDocumentStore();
    expect(retryOnFenceTrip(base)).toBe(retryOnFenceTrip(base));
    await retryOnFenceTrip(base).put({ item: { pk: "C", sk: "1" } });
    expect(await base.get({ pk: "C", sk: "1" })).toBeDefined();
  });
});

const logs: Array<Record<string, unknown>> = [];

describe("through the real flow: a plan sent back for changes, whose re-planning step fence trips", () => {
  async function sentBackWith(withItems: (armed: () => boolean) => TaskAccess["checkStep"]) {
    // The fence trips only once the plan is sent back: planning itself is an ordinary step.
    let armed = false;
    const r = await rig({ access: { ...allowAll, checkStep: withItems(() => armed) }, log: (entry) => logs.push(entry) });
    r.standing.set(r.people.people.owner.developerId, "owner");
    const { taskId, owner } = await plannedTask(r);
    armed = true;
    const answer = await press(r, taskId, owner, BROWSER_SESSION_METHOD, "request_changes" as never);
    expect(answer.status, JSON.stringify(answer)).toBe("decided");
    const flow = (await r.app.runtimeFor(r.people.people.owner.orgId)).flow;
    return { r, flow, taskId };
  }

  it("a tripped fence is retried by the sweep (rescheduled, not dropped as stale), and the workflow is not left waiting for a step nobody will start", async () => {
    const people = { pk: "PROBE", sk: "FENCE" };
    const { flow } = await sentBackWith((armed) => async () => ({ allowed: true, ...(armed() ? { items: markStepFence([failing(people)]) } : {}) }));
    const report = await flow.sweepOnce();
    expect(report.stale, JSON.stringify(report)).toBe(0);
    expect(report.failed + report.blocked).toBeGreaterThan(0);
  });

  it("the control: the same failing condition, unmarked, is dropped as stale (the silent drop this fixes)", async () => {
    const { flow } = await sentBackWith((armed) => async () => ({ allowed: true, ...(armed() ? { items: [failing({ pk: "PROBE", sk: "FENCE" })] } : {}) }));
    const report = await flow.sweepOnce();
    expect(report.stale, JSON.stringify(report)).toBeGreaterThan(0);
  });
});
