// Work events (U3): the events are made from the State table stream's before and after images, in the notifier, for every writer of a task's workflow: idempotent, content-free, TTL'd, and never failing the batch.
import { randomUUID } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, WorkEventSchema, WorkflowSnapshotSchema, blockWorkflow, createWorkflowSnapshot, decideWorkflow, submitWorkflowArtifact, workEventExpiresAt, workEventShard, workEventPartitions, type WorkEvent, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, INDEX_EXPIRY_ATTRIBUTE, createCandidateManifest } from "@rovara-code/contracts";
import { WORK_EVENT_WRITE_ATTEMPTS, workEventsOfStream, writeWorkEventsOfStream, type WorkEventStreamDeps } from "../../packages/broker/src/work-events/stream.js";
import { listWorkEvents } from "../../packages/broker/src/work-events/store.js";
import { stoppedStepReason } from "../../packages/broker/src/aws/workflow-cancel-reconcile.js";
import type { StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const project = "billing-service";
const T0 = "2026-11-10T09:00:00.000Z";
const T1 = "2026-11-10T09:05:00.000Z";
const T2 = "2026-11-10T09:10:00.000Z";
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.json`, createdAt: T0, format: "structured" as const };
const planning = (): WorkflowSnapshot => createWorkflowSnapshot({ taskId, ownerId, now: T0 });
const waiting = (): WorkflowSnapshot => { const p = planning(); return submitWorkflowArtifact(p, { expectedRevision: p.revision, artifact: plan, now: T1 }); };
/** As the decision route stores it: the coding step readied by `decideWorkflow`, then started (revision + 1, RUNNING). */
const approved = (): WorkflowSnapshot => {
  const decided = decideWorkflow(waiting(), { requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b", expectedRevision: waiting().revision, decision: "APPROVE", artifactDigest: plan.sha256, reason: "Looks right.", answers: [] }, { actorId: ownerId, role: "TASK_OWNER" }, { now: T2, allowedSkipStages: [], via: "PAGE" });
  return { ...decided, revision: decided.revision + 1, state: "RUNNING", updatedAt: T2 };
};

const taskRow = (workflow: WorkflowSnapshot, extra: Record<string, unknown> = {}) => ({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, orgId, project, client: "web", developerId: ownerId, title: "Fix the billing retry", workflow, ...extra });
let sequence = 0;
/** A stream record as the table delivers it: the images are DynamoDB's attribute values. */
const record = (before: Record<string, unknown> | undefined, after: Record<string, unknown>): StreamRecord => {
  sequence += 1;
  return { eventID: `ev${String(sequence)}`, eventName: before === undefined ? "INSERT" : "MODIFY", dynamodb: { ...(before === undefined ? {} : { OldImage: marshall(before, { removeUndefinedValues: true }) }), NewImage: marshall(after, { removeUndefinedValues: true }) } };
};
const change = (before: WorkflowSnapshot | undefined, after: WorkflowSnapshot, extra: Record<string, unknown> = {}) => record(before === undefined ? undefined : taskRow(before, extra), taskRow(after, extra));

function world() {
  const db = new FakeDynamoDb();
  const logs: Array<Record<string, unknown>> = [];
  const deps: WorkEventStreamDeps = { documentClient: db, tableName: "state", workEvents: { pause: async () => undefined }, log: (entry) => { logs.push(entry); } };
  const rows = () => db.find((item) => item["entityType"] === "WORK_EVENT");
  const events = async (): Promise<WorkEvent[]> => (await listWorkEvents(deps, { orgId, from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z", now: Date.parse(T2) })).events;
  return { db, deps, logs, rows, events };
}
const kinds = (list: readonly { kind: string }[]): string[] => list.map((event) => event.kind).sort();

describe("the events of a stream batch", () => {
  it("makes a task's first events from an INSERT, with the creation time and the client as origin", () => {
    const made = workEventsOfStream([change(undefined, planning())]).map(({ event }) => WorkEventSchema.parse(event));
    expect(kinds(made)).toEqual(["step_started", "task_started", "waiting_changed"]);
    expect(made.find((event) => event.kind === "task_started")).toMatchObject({ at: T0, origin: "web", project, orgId, actor: { kind: "person", personId: ownerId } });
  });

  it("makes the decision's events from a MODIFY, each stream record named by its id", () => {
    const made = workEventsOfStream([change(waiting(), approved())]);
    expect(kinds(made.map(({ event }) => event))).toEqual(["decision_answered", "plan_approved", "step_started", "waiting_changed"]);
    expect(new Set(made.map(({ eventID }) => eventID)).size).toBe(1);
  });

  it("covers a writer no route knows: the same function sees a cancel, a failure and a merge the reconciler saw", () => {
    const cancelled = blockWorkflow(approved(), stoppedStepReason("IMPLEMENT", "CANCELLED"), "2026-11-10T10:00:00.000Z");
    expect(workEventsOfStream([change(approved(), cancelled)]).map(({ event }) => event.kind).sort()).toEqual(["step_ended", "waiting_changed"]);
    const failed = blockWorkflow(approved(), WORKFLOW_BLOCK_REASONS.regressionFound, "2026-11-10T10:00:00.000Z");
    expect(workEventsOfStream([change(approved(), failed)]).map(({ event }) => event.kind).sort()).toEqual(["step_ended", "task_failed", "waiting_changed"]);
    // A task waiting for its merge, as the reconciler sees it: a snapshot the schema accepts (candidate, checks, reviews and one open pull request).
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) }]);
    const waitingForMerge = (state: "OPEN" | "MERGED", extra: Partial<WorkflowSnapshot>): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId, now: T0 }), candidate, stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 9, updatedAt: T2,
      artifacts: [plan],
      decisions: [{ requestId: randomUUID(), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: plan.sha256, at: T1 }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "env", recordedAt: T2, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: T2 })),
      pullRequests: [{ repositoryId: "demo", number: 7, url: "https://example.com/demo/pull/7", headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state }],
      ...extra,
    });
    const open = waitingForMerge("OPEN", {});
    const merged = waitingForMerge("MERGED", { stage: "MERGED", state: "COMPLETE", outcome: "MERGED", revision: 10, updatedAt: "2026-11-10T11:00:00.000Z" });
    expect(workEventsOfStream([change(open, merged)]).map(({ event }) => event.kind).sort()).toEqual(["pr_merged", "task_closed", "waiting_changed"]);
    const budget = blockWorkflow(approved(), BUDGET_EXHAUSTED_FAILURE_MESSAGE, "2026-11-10T10:00:00.000Z");
    expect(workEventsOfStream([change(approved(), budget)]).some(({ event }) => event.kind === "task_failed")).toBe(false);
  });

  it("skips what is not a task's change: another entity, a delete, a replay copy of a past task, a task with no org, a workflow it cannot read", () => {
    const other = record({ pk: "X", sk: "Y", entityType: "OPERATION" }, { pk: "X", sk: "Y", entityType: "OPERATION", status: "SUCCEEDED" });
    const removal: StreamRecord = { eventID: "ev-del", eventName: "REMOVE", dynamodb: { OldImage: marshall(taskRow(waiting())) } };
    const replay = change(waiting(), approved(), { evalRun: true });
    const noOrg = record(taskRow(waiting()), { ...taskRow(approved()), orgId: undefined });
    const unreadable = record(taskRow(waiting()), { ...taskRow(approved()), workflow: { stage: "NONSENSE" } });
    expect(workEventsOfStream([other, removal, replay, noOrg, unreadable])).toEqual([]);
  });

  it("treats an old image whose workflow cannot be read as an unknown before-state: only the task's idempotent start, no invented step or wait", () => {
    const unknownBefore = record({ ...taskRow(waiting()), workflow: { stage: "NONSENSE" } }, taskRow(approved()));
    const made = workEventsOfStream([unknownBefore]).map(({ event }) => event.kind);
    expect(made).toEqual(["task_started"]);
    const none = record({ ...taskRow(waiting()), workflow: undefined }, taskRow(approved()));
    expect(workEventsOfStream([none]).map(({ event }) => event.kind)).toEqual(["task_started"]);
    // The start is the same row whichever change the reader meets first.
    const first = workEventsOfStream([change(undefined, planning())]).find(({ event }) => event.kind === "task_started")!.event;
    const later = workEventsOfStream([unknownBefore])[0]!.event;
    expect(later.id).toBe(first.id);
    expect(later.at).toBe(first.at);
  });

  it("makes nothing for a change that moves nothing the events name", () => {
    expect(workEventsOfStream([change(waiting(), { ...waiting(), updatedAt: T2 })])).toEqual([]);
  });
});

describe("writing them", () => {
  it("writes each event once, in the task's shard of the company's month, with the TTL, and holds no content", async () => {
    const w = world();
    await writeWorkEventsOfStream(w.deps, [change(undefined, planning()), change(planning(), waiting()), change(waiting(), approved())]);
    const rows = w.rows();
    expect(kinds(rows as unknown as { kind: string }[])).toEqual(["decision_answered", "decision_asked", "plan_approved", "step_ended", "step_started", "step_started", "task_started", "waiting_changed", "waiting_changed", "waiting_changed"].sort());
    const partitions = new Set(workEventPartitions(orgId, "2026-11"));
    for (const row of rows) {
      expect(partitions.has(String(row["pk"]))).toBe(true);
      expect(String(row["pk"]).endsWith(`#${String(workEventShard(taskId))}`)).toBe(true);
      expect(row[INDEX_EXPIRY_ATTRIBUTE]).toBe(workEventExpiresAt(String(row["at"])));
    }
    expect(new Date(Number(rows[0]![INDEX_EXPIRY_ATTRIBUTE]) * 1000).toISOString()).toBe("2028-01-01T00:00:00.000Z");
    expect(JSON.stringify(rows)).not.toMatch(/Fix the billing retry|Looks right|billing retry/u);
    expect((await w.events()).length).toBe(rows.length);
  });

  it("is idempotent: a redelivery of the same records writes the same rows, and a second pass over an earlier one adds none", async () => {
    const w = world();
    const batch = [change(undefined, planning()), change(planning(), waiting())];
    await writeWorkEventsOfStream(w.deps, batch);
    const first = w.rows().map((row) => `${String(row["pk"])}|${String(row["sk"])}`).sort();
    await writeWorkEventsOfStream(w.deps, batch);
    await writeWorkEventsOfStream(w.deps, [batch[1]!]);
    expect(w.rows().map((row) => `${String(row["pk"])}|${String(row["sk"])}`).sort()).toEqual(first);
  });

  it("writes nothing when the install has work events off, and reads nothing", async () => {
    const w = world();
    const off: WorkEventStreamDeps = { documentClient: w.deps.documentClient, tableName: w.deps.tableName, log: (entry) => { w.deps.log(entry); } };
    expect(await writeWorkEventsOfStream(off, [change(undefined, planning())])).toEqual({ written: 0, failed: 0 });
    expect(w.rows()).toEqual([]);
    expect(w.db.commandNames()).toEqual([]);
  });

  it("never throws: a write that fails is tried again, then logged by stream record and event id with no content, and the rest are still written", async () => {
    const w = world();
    // The first event's write fails every time; the rest succeed.
    w.db.injectFault({ command: "PutCommand", times: WORK_EVENT_WRITE_ATTEMPTS, error: { name: "ProvisionedThroughputExceededException" } });
    const result = await writeWorkEventsOfStream(w.deps, [change(undefined, planning())]);
    expect(result).toEqual({ written: 2, failed: 1 });
    expect(w.rows()).toHaveLength(2);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toMatchObject({ event: "work_event.write_failed", streamEventId: expect.stringMatching(/^ev\d+$/u) as string, error: "ProvisionedThroughputExceededException" });
    expect(Object.keys(w.logs[0]!).sort()).toEqual(["error", "event", "id", "kind", "streamEventId"]);
  });

  it("retries a write that fails once, and writes it", async () => {
    const w = world();
    w.db.injectFault({ command: "PutCommand", times: 1, error: { name: "InternalServerError" } });
    expect(await writeWorkEventsOfStream(w.deps, [change(undefined, planning())])).toEqual({ written: 3, failed: 0 });
    expect(w.logs).toEqual([]);
  });

  it("makes an event with a new random task id too: only the id decides its shard", async () => {
    const w = world();
    const other = randomUUID();
    await writeWorkEventsOfStream(w.deps, [record(undefined, { ...taskRow({ ...planning(), taskId: other }), taskId: other })]);
    expect(w.rows().every((row) => String(row["pk"]).endsWith(`#${String(workEventShard(other))}`))).toBe(true);
  });
});
