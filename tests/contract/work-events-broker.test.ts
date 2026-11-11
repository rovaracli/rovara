// Work events (U3) through the real broker: a task started, its plan decided and its spend settled on the fake table with the real wiring. Each emit point writes its events in the change's own transaction.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, WorkEventSchema, workEventExpiresAt, type WorkEvent } from "@agentx/contracts";
import { decide, developerBroker, finishPlanning } from "../support/golden-recorder.js";
import { TEST_ORG } from "../support/orgs.js";

type Broker = Awaited<ReturnType<typeof developerBroker>>;
const rowsOf = (broker: Broker) => broker.harness.db.find((item) => item.entityType === "WORK_EVENT");
const eventsOf = (broker: Broker, taskId: string): WorkEvent[] => rowsOf(broker).filter((row) => row["taskId"] === taskId).sort((a, b) => String(a["sk"]).localeCompare(String(b["sk"])))
  .map((row) => WorkEventSchema.parse(Object.fromEntries(Object.entries(row).filter(([name]) => !["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE].includes(name)))));
const kinds = (list: readonly WorkEvent[]) => list.map((event) => event.kind).sort();

describe("work events through the broker", () => {
  it("writes nothing when the install has them off (a legacy install)", async () => {
    const broker = await developerBroker(true);
    const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
    await broker.finishPrepare(workspaceId);
    expect(rowsOf(broker)).toEqual([]);
    expect(taskId).toBeDefined();
  });

  it("writes a task's events as it starts, plans and is decided, one event for each fact", async () => {
    const broker = await developerBroker(true, { workEvents: {} });
    const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
    // The start's own transaction.
    expect(kinds(eventsOf(broker, taskId))).toEqual(["step_started", "task_started", "waiting_changed"]);
    expect(eventsOf(broker, taskId).find((event) => event.kind === "task_started")).toMatchObject({ orgId: TEST_ORG, project: "payments", path: "QUICK", actor: { kind: "person" } });
    await broker.finishPrepare(workspaceId);
    const planning = broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN");
    const plan = await finishPlanning(broker, taskId, workspaceId, planning);
    // The result of the planning step: the plan reached the owner's gate.
    expect(kinds(eventsOf(broker, taskId))).toEqual(["decision_asked", "step_ended", "step_started", "task_started", "waiting_changed", "waiting_changed"]);
    expect(eventsOf(broker, taskId).filter((event) => event.kind === "decision_asked")).toMatchObject([{ decisionId: `r${String(plan.revision)}`, decision: "plan", actor: { kind: "system" } }]);
    const approval = await decide(broker, taskId, plan, "APPROVE", "Looks right.");
    expect(approval.status).toBe(200);
    const all = eventsOf(broker, taskId);
    expect(all.filter((event) => event.kind === "decision_answered")).toMatchObject([{ decisionId: `r${String(plan.revision)}`, outcome: "approved", actor: { kind: "person" } }]);
    expect(all.filter((event) => event.kind === "plan_approved")).toHaveLength(1);
    // The coding step starts with the decision's own transaction.
    expect(all.filter((event) => event.kind === "step_started").map((event) => (event as { step: string }).step)).toEqual(["plan", "implement"]);
    // Every fact is one event: nothing is written twice, and every row expires 13 months after its month.
    const ids = rowsOf(broker).map((row) => row["id"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of rowsOf(broker)) expect(row[INDEX_EXPIRY_ATTRIBUTE]).toBe(workEventExpiresAt(String(row["at"])));
    // The owner is a person id, never a name: no event holds the owner's name or the request text.
    expect(JSON.stringify(rowsOf(broker))).not.toMatch(/Maya|Fix the retry bug|Looks right/u);
    expect(all.find((event) => event.kind === "task_started")).toMatchObject({ actor: { kind: "person", personId: expect.stringMatching(/^[a-f0-9]{64}$/u) as string } });
  });

  it("writes no events for a decision the broker refuses", async () => {
    const broker = await developerBroker(true, { workEvents: {} });
    const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
    await broker.finishPrepare(workspaceId);
    const planning = broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN");
    const plan = await finishPlanning(broker, taskId, workspaceId, planning);
    const before = rowsOf(broker).length;
    const refused = await decide(broker, taskId, { ...plan, revision: plan.revision + 3 }, "APPROVE", "Stale.");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(rowsOf(broker)).toHaveLength(before);
  });
});
