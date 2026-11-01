// Erasure and retirement reach a stage's stored delivery copy: a stage that is PARKED (waiting for task access or for its session) or that ends FAILED has no time limit, and nobody sweeps it
// when a lesson's author is erased, a lesson is retired or a reader loses access. Such a copy keeps no lesson text, and a stage released from a park is delivered without lessons.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/session.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { markDeliveredCommand } from "../../packages/broker/src/aws/dispatcher.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "a".repeat(64);
const SECRET = "Call the internal retry endpoint at the secret path before every request.";
const LESSONS = { v: 1, lessons: [{ id: "les_mallory01", type: "convention", title: "Mallory's rule", body: SECRET }] };

function outboxRecord(status = "QUEUED", workspaceId = WORKSPACE_ID): Ec2OutboxRecord {
  const operationId = randomUUID();
  return {
    id: randomUUID(), entityType: "OUTBOX", status, operationId, workspaceId, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId, fence: 4, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "continue", conversationStarted: true, learnedContext: LESSONS } },
  } as unknown as Ec2OutboxRecord;
}
const stored = (db: FakeDynamoDb, record: Ec2OutboxRecord) => db.get(`OUTBOX#${record.id}`, "OUTBOX") as unknown as { status: string; invocation: { payload: Record<string, unknown> } };
function seed(db: FakeDynamoDb, record: Ec2OutboxRecord, workspaceId = WORKSPACE_ID) {
  db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${record.operationId}`, status: "DISPATCHING", fence: 4 });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: "BUSY", activeOperationId: record.operationId, fence: 4 });
}

describe("a stage's stored copy keeps no lesson text once it is parked or failed", () => {
  it("parked for task access: the copy loses the lessons and keeps its identity", async () => {
    const db = new FakeDynamoDb();
    const record = outboxRecord();
    seed(db, record);
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, developerId: OWNER, provider: "slack", developerName: "Avery", slackUserId: "U0OWNER001", client: "slack", project: "payments", title: "Payments", workspaceId: WORKSPACE_ID, ownerKey: "f".repeat(64), conversationId: randomUUID(), startingRevision: 1, charge: { member: { pk: "m", sk: "c" }, organization: { pk: "o", sk: "c" } }, shared: true, share: { teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", mode: "view", sharedReason: "requested", sharedAt: "2026-10-11T10:00:00.000Z" }, createdAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z", workflow: { revision: 7, stage: "IMPLEMENT", state: "RUNNING" } });
    db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: OWNER });
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people: [{ developerId: OWNER, slackUserId: "U0OWNER001", name: "Avery", role: "owner" }] });
    await expect(guardTaskDispatch({ documentClient: db, tableName: "state" }, record)).resolves.toBe("PARKED");
    const after = stored(db, record);
    expect(after.status).toBe("WAITING_FOR_TASK_ACCESS");
    expect(after.invocation.payload).toMatchObject({ prompt: "continue", conversationStarted: true });
    expect(after.invocation.payload.learnedContext).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("secret path");
  });

  it("parked for its session: the copy loses the lessons, and the released copy is the one that is delivered", async () => {
    const db = new FakeDynamoDb();
    const sessions = new SessionManager({ documentClient: db, tableName: "state", executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start: async ({ stateMachineArn, name }) => `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}` }, now: () => new Date("2026-11-01T12:00:00.000Z"), chooseSubnet: (subnets) => subnets[0]! });
    const binding: Ec2RuntimeBinding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" };
    const workspaceId = randomUUID();
    const record = outboxRecord("QUEUED", workspaceId);
    seed(db, record, workspaceId);
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: record.id });
    const after = stored(db, record);
    expect(after.status).toBe("WAITING_FOR_SESSION");
    expect(after.invocation.payload.learnedContext).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("secret path");
    // Released: it goes back to PENDING with no lessons, so the publisher queues a stage without them.
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    await sessions.markReady(workspaceId, 1);
    expect(stored(db, record).status).toBe("PENDING");
    expect(JSON.stringify(stored(db, record))).not.toContain("secret path");
  });

  it("failed: the copy loses the lessons (no time limit would otherwise remove them)", async () => {
    const db = new FakeDynamoDb();
    const record = outboxRecord();
    seed(db, record);
    await failOutboxOperation(db as never, "state", record, "RUNTIME_UNAVAILABLE: worker dispatch failed after 5 attempts");
    const after = stored(db, record);
    expect(after.status).toBe("FAILED");
    expect(after.invocation.payload.learnedContext).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("secret path");
  });

  it("failed while waiting for its session (a stage parked, then the start failed) keeps no lessons either", async () => {
    const db = new FakeDynamoDb();
    const record = outboxRecord("WAITING_FOR_SESSION");
    seed(db, record);
    await failOutboxOperation(db as never, "state", record, "RUNTIME_UNAVAILABLE: compute failed", { status: "WAITING_FOR_SESSION" });
    expect(JSON.stringify(stored(db, record))).not.toContain("secret path");
    expect(stored(db, record).status).toBe("FAILED");
  });

  it("a stage with no lessons is parked and failed as before", async () => {
    const db = new FakeDynamoDb();
    const record = outboxRecord();
    delete (record.invocation as unknown as { payload: Record<string, unknown> }).payload.learnedContext;
    seed(db, record);
    await failOutboxOperation(db as never, "state", record, "x");
    expect(stored(db, record)).toMatchObject({ status: "FAILED", invocation: { payload: { prompt: "continue" } } });
  });

  it("marking an item that no longer exists delivered creates nothing and is refused by a condition the dispatcher treats as done (M5)", async () => {
    const db = new FakeDynamoDb();
    await expect(db.send(markDeliveredCommand("state", "gone", "2026-11-01T00:00:00.000Z"))).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    expect(db.get("OUTBOX#gone", "OUTBOX")).toBeUndefined();
  });

  it("delivered still drops them (the earlier rule is unchanged)", async () => {
    const db = new FakeDynamoDb();
    const record = outboxRecord();
    seed(db, record);
    await db.send(markDeliveredCommand("state", record.id, "2026-11-01T00:00:00.000Z"));
    expect(stored(db, record).invocation.payload.learnedContext).toBeUndefined();
  });
});
