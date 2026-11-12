// Work events (U3) through the real broker and the real notifier handler: the broker moves a task, the table's stream carries the before and after images, and the notifier writes the events from them.
// Nothing is added to the broker's own transactions.
import { describe, expect, it } from "vitest";
import { WorkEventSchema, workEventExpiresAt, type WorkEvent } from "@rovara-code/contracts";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { recordStream } from "../support/developer-task-broker.js";
import { decide, developerBroker, finishPlanning } from "../support/golden-recorder.js";
import { TEST_ORG } from "../support/orgs.js";

type Broker = Awaited<ReturnType<typeof developerBroker>>;

function notifier(broker: Broker, options: { workEvents: boolean }) {
  const stream = recordStream(broker.harness.db);
  const logs: Array<Record<string, unknown>> = [];
  const handle = createNotifierHandler({
    documentClient: broker.harness.db, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined, post: async () => ({ ts: "1695500000.000100" }),
    now: () => Date.now(), log: (entry) => { logs.push(entry); }, deliveryFailed: () => undefined, ...(options.workEvents ? { workEvents: { pause: async () => undefined } } : {}),
  });
  const pump = async () => { await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) }); };
  const rows = () => broker.harness.db.find((item) => item["entityType"] === "WORK_EVENT");
  const eventsOf = (taskId: string): WorkEvent[] => rows().filter((row) => row["taskId"] === taskId).sort((a, b) => String(a["at"]).localeCompare(String(b["at"])) || String(a["id"]).localeCompare(String(b["id"])))
    .map((row) => WorkEventSchema.parse(Object.fromEntries(Object.entries(row).filter(([name]) => !["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE].includes(name)))));
  return { pump, rows, eventsOf, logs };
}
const kinds = (list: readonly WorkEvent[]) => list.map((event) => event.kind).sort();

describe("work events through the broker and the notifier", () => {
  it("writes nothing when the install has them off", async () => {
    const broker = await developerBroker(true);
    const n = notifier(broker, { workEvents: false });
    const { workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
    await broker.finishPrepare(workspaceId);
    await n.pump();
    expect(n.rows()).toEqual([]);
  });

  it("writes a task's events as it starts, plans and is decided, each fact once, with the broker's transactions untouched", async () => {
    const broker = await developerBroker(true);
    const n = notifier(broker, { workEvents: true });
    const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
    await n.pump();
    expect(kinds(n.eventsOf(taskId))).toEqual(["step_started", "task_started", "waiting_changed"]);
    expect(n.eventsOf(taskId).find((event) => event.kind === "task_started")).toMatchObject({ orgId: TEST_ORG, project: "payments", path: "QUICK", actor: { kind: "person", personId: expect.stringMatching(/^[a-f0-9]{64}$/u) as string } });
    await broker.finishPrepare(workspaceId);
    const planning = broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN");
    const plan = await finishPlanning(broker, taskId, workspaceId, planning);
    await n.pump();
    expect(n.eventsOf(taskId).filter((event) => event.kind === "decision_asked")).toMatchObject([{ decisionId: `r${String(plan.revision)}`, decision: "plan", actor: { kind: "system" } }]);
    expect((await decide(broker, taskId, plan, "APPROVE", "Looks right.")).status).toBe(200);
    await n.pump();
    const all = n.eventsOf(taskId);
    expect(all.filter((event) => event.kind === "decision_answered")).toMatchObject([{ decisionId: `r${String(plan.revision)}`, outcome: "approved", actor: { kind: "person" } }]);
    expect(all.filter((event) => event.kind === "plan_approved")).toHaveLength(1);
    expect(all.filter((event) => event.kind === "step_started").map((event) => (event as { step: string }).step)).toEqual(["plan", "implement"]);
    // The broker wrote no event itself: every row came from the notifier, and the broker's own transactions hold none.
    const ids = n.rows().map((row) => row["id"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of n.rows()) expect(row[INDEX_EXPIRY_ATTRIBUTE]).toBe(workEventExpiresAt(String(row["at"])));
    for (const transaction of broker.harness.db.transactions()) expect(JSON.stringify(transaction)).not.toContain("WORK_EVENT");
    expect(JSON.stringify(n.rows())).not.toMatch(/Maya|Fix the retry bug|Looks right/u);
  });

  it("leaves the notifier batch with no failures when every work-event write fails: the notices are still queued and the failure is logged without content (review L3)", async () => {
    const broker = await developerBroker(true);
    const recorded = recordStream(broker.harness.db);
    const logs: Array<Record<string, unknown>> = [];
    const queued: unknown[] = [];
    const handle = createNotifierHandler({
      documentClient: broker.harness.db, tableName: "state", enqueue: async (notices) => { queued.push(...notices); }, retryLater: async () => undefined, post: async () => ({ ts: "1695500000.000100" }),
      now: () => Date.now(), log: (entry) => { logs.push(entry); }, deliveryFailed: () => undefined, workEvents: { pause: async () => undefined },
    });
    const { workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK", shareToChannel: true });
    await broker.finishPrepare(workspaceId);
    const records = recorded.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" }));
    // From here every write of a work event fails (the table refuses it); nothing else is touched.
    broker.harness.db.injectFault({ command: "PutCommand", times: 1000, match: (input) => (input["Item"] as { entityType?: unknown } | undefined)?.entityType === "WORK_EVENT", error: { name: "ProvisionedThroughputExceededException" } });
    await expect(handle({ Records: records })).resolves.toEqual({ batchItemFailures: [] });
    expect(broker.harness.db.find((item) => item["entityType"] === "WORK_EVENT")).toEqual([]);
    const failed = logs.filter((entry) => entry["event"] === "work_event.write_failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const entry of failed) expect(Object.keys(entry).sort()).toEqual(["error", "event", "id", "kind", "streamEventId"]);
    // The notifier's own work was not held up: its notices were queued before the events were written.
    expect(queued.length).toBeGreaterThan(0);
  });

  it("writes the same rows when the stream delivers the same records again", async () => {
    const broker = await developerBroker(true);
    const recorded = recordStream(broker.harness.db);
    const logs: unknown[] = [];
    const handle = createNotifierHandler({
      documentClient: broker.harness.db, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined, post: async () => ({ ts: "1695500000.000100" }),
      now: () => Date.now(), log: (entry) => { logs.push(entry); }, deliveryFailed: () => undefined, workEvents: { pause: async () => undefined },
    });
    const { workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
    await broker.finishPrepare(workspaceId);
    const records = recorded.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" }));
    await handle({ Records: records });
    const first = broker.harness.db.find((item) => item["entityType"] === "WORK_EVENT").map((row) => `${String(row["pk"])}|${String(row["sk"])}`).sort();
    expect(first.length).toBeGreaterThan(0);
    await handle({ Records: records });
    expect(broker.harness.db.find((item) => item["entityType"] === "WORK_EVENT").map((row) => `${String(row["pk"])}|${String(row["sk"])}`).sort()).toEqual(first);
  });
});
