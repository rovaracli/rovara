// Convergence S2, the READERS (DECISIONS 152a: readers ship before writers). The 0.5.18 release (branch feat/s2-readers) reads and releases marker rows
// (`TASK#<id>`, `SESSION_WAITING#<id>`) and still writes the string sets; this release writes the markers. These tests give the code rows exactly as the
// marker writers leave them (and as Code's core leaves them) and check that it reads, refuses and releases them, so a rollback to the readers release
// strands no slot and no parked delivery.
import { randomUUID } from "node:crypto";
import { slackMemberLimitKey } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import type { Ec2RuntimeBinding } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { chargeConflict, chargeFormOf, chargeItems, chargedTaskIds, developerCharge, isTaskCharged, releaseConflict, releaseItems } from "../../packages/broker/src/developer/limits.js";
import { SessionManager, parkedOutboxIds } from "../../packages/broker/src/aws/sessions.js";
import { withdrawParkedDelivery } from "../../packages/broker/src/aws/parked-stop.js";

const TABLE = "state";
const limits = { member: 3, organization: 20 };
const developerId = "d".repeat(64);
const charge = developerCharge({ orgId: TEST_ORG, developerId });
const slack = developerCharge({ orgId: TEST_ORG, teamId: "T0READERS01", slackUserId: "U0READ001", developerId });
const send = (db: FakeDynamoDb, items: unknown[]) => db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: items } });
const fails = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a cancelled transaction"); }, (error: unknown) => error);

/** The rows the marker writers (and Code's core) leave for one charged task: the counters and the task's marker beside the member counter. */
function markerCharged(db: FakeDynamoDb, who: typeof charge, taskId: string, count = 1): void {
  db.set({ ...who.organization, entityType: "DEVELOPER_LIMIT", count });
  db.set({ ...who.member, entityType: "DEVELOPER_LIMIT", count });
  db.set({ pk: who.member.pk, sk: `TASK#${taskId}`, entityType: "DEVELOPER_LIMIT_TASK", taskId, memberSk: who.member.sk, chargedAt: "2026-11-20T00:00:00.000Z" });
}

describe("readers: a slot charged by the marker writers", () => {
  it("is read as charged and released through its marker, once", async () => {
    const db = new FakeDynamoDb();
    // Two slots held (another task owns the second), so only the marker's condition, never the count, can stop a repeated release.
    markerCharged(db, charge, "m1", 2);
    expect(await isTaskCharged(db, TABLE, charge, "m1")).toBe(true);
    expect(await chargeFormOf(db, TABLE, charge, "m1")).toBe("marker");
    await send(db, releaseItems(TABLE, charge, "m1", "marker"));
    expect(db.get(charge.member)).toMatchObject({ count: 1 });
    expect(db.get(charge.organization)).toMatchObject({ count: 1 });
    expect(db.get(charge.member.pk, "TASK#m1")).toBeUndefined();
    const repeat = await fails(send(db, releaseItems(TABLE, charge, "m1", "marker")));
    expect(await releaseConflict(db, TABLE, charge, "m1", repeat, "marker")).toBe("already_released");
    expect(db.get(charge.member)).toMatchObject({ count: 1 });
    expect(db.get(charge.organization)).toMatchObject({ count: 1 });
  });

  it("cannot be charged a second time", async () => {
    const db = new FakeDynamoDb();
    markerCharged(db, charge, "m1");
    const repeat = await fails(send(db, chargeItems(TABLE, charge, limits, "m1")));
    expect(await chargeConflict(db, TABLE, charge, "m1", repeat)).toBe("already_charged");
    expect(db.get(charge.member)).toMatchObject({ count: 1 });
    expect(db.get(charge.member)).not.toHaveProperty("tasks");
  });

  it("is listed with the set-form tasks, and only for its own member in a shared Slack partition", async () => {
    const db = new FakeDynamoDb();
    markerCharged(db, slack, "m1", 2);
    db.set({ ...slack.member, entityType: "SLACK_LIMIT", count: 2, tasks: new Set(["s1"]) });
    db.set({ ...slackMemberLimitKey(TEST_ORG, "T0READERS01", "U0OTHER01"), entityType: "SLACK_LIMIT", count: 1 });
    db.set({ pk: slack.member.pk, sk: "TASK#other", entityType: "DEVELOPER_LIMIT_TASK", taskId: "other", memberSk: "MEMBER#U0OTHER01", chargedAt: "x" });
    expect((await chargedTaskIds(db, TABLE, slack.member)).sort()).toEqual(["m1", "s1"]);
  });

  it("a marker-charged and a set-charged task both free their slot, each in its own form", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...charge.organization, entityType: "DEVELOPER_LIMIT", count: 2 });
    db.set({ ...charge.member, entityType: "DEVELOPER_LIMIT", count: 2, tasks: new Set(["old"]) });
    db.set({ pk: charge.member.pk, sk: "TASK#new", entityType: "DEVELOPER_LIMIT_TASK", taskId: "new", memberSk: "MEMBER", chargedAt: "x" });
    await send(db, releaseItems(TABLE, charge, "new", await chargeFormOf(db, TABLE, charge, "new")));
    await send(db, releaseItems(TABLE, charge, "old", await chargeFormOf(db, TABLE, charge, "old")));
    expect(db.get(charge.member)).toMatchObject({ count: 0 });
    expect(db.get(charge.organization)).toMatchObject({ count: 0 });
    expect(db.get(charge.member)).not.toHaveProperty("tasks");
  });
});

const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", volumeSizeGiB: 20, volumeType: "gp3",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
};

function sessionWorld() {
  const db = new FakeDynamoDb();
  const sessions = new SessionManager({
    documentClient: db, tableName: TABLE, now: () => new Date("2026-11-20T12:00:00.000Z"), chooseSubnet: (subnets) => subnets[0]!,
    executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:p", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:d", start: async ({ stateMachineArn, name }) => `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}` },
  });
  const workspaceId = randomUUID();
  const outbox = (status = "WAITING_FOR_SESSION") => {
    const operationId = randomUUID(), outboxId = randomUUID();
    db.set({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status, operationId, workspaceId, deploymentMode: "ec2-ebs", invocation: { protocolVersion: 1, kind: "prepare", operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {} } });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "PREPARING", activeOperationId: operationId, fence: 1 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, status: "DISPATCHING", fence: 1 });
    return { operationId, outboxId };
  };
  const marker = (outboxId: string) => db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `SESSION_WAITING#${outboxId}`, entityType: "SESSION_WAITING", workspaceId, outboxId, parkedAt: "2026-11-20T11:00:00.000Z" });
  return { db, sessions, workspaceId, outbox, marker };
}

describe("readers: deliveries parked by the marker writers", () => {
  it("are read with the set-form ones, and a session read lists both", async () => {
    const { db, sessions, workspaceId, outbox, marker } = sessionWorld();
    const first = outbox("QUEUED"), second = outbox();
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: first.outboxId });
    marker(second.outboxId);
    expect((await sessions.get(workspaceId))!.waitingOutboxIds).toEqual([first.outboxId, second.outboxId].sort());
    expect(await parkedOutboxIds(db, TABLE, workspaceId, db.get(`WORKSPACE#${workspaceId}`, "SESSION"))).toEqual([first.outboxId, second.outboxId].sort());
  });

  it("a parked marker is requeued when the compute comes up, and the marker goes", async () => {
    const { db, sessions, workspaceId, outbox, marker } = sessionWorld();
    await sessions.ensureSession({ workspaceId, binding });
    const parked = outbox();
    marker(parked.outboxId);
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    expect((await sessions.markReady(workspaceId, 1)).requeued).toEqual([parked.outboxId]);
    expect(db.get(`OUTBOX#${parked.outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `SESSION_WAITING#${parked.outboxId}`)).toBeUndefined();
  });

  it("a Stop withdraws a marker-parked delivery and deletes its marker", async () => {
    const { db, sessions, workspaceId, outbox, marker } = sessionWorld();
    await sessions.ensureSession({ workspaceId, binding });
    const parked = outbox();
    marker(parked.outboxId);
    expect(await withdrawParkedDelivery(db, TABLE, workspaceId, parked.operationId)).toBe(true);
    expect(db.get(`OUTBOX#${parked.outboxId}`, "OUTBOX")).toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `SESSION_WAITING#${parked.outboxId}`)).toBeUndefined();
  });

  it("a failed provisioning fails the marker-parked delivery and clears the marker", async () => {
    const { db, sessions, workspaceId, outbox, marker } = sessionWorld();
    await sessions.ensureSession({ workspaceId, binding });
    const parked = outbox();
    marker(parked.outboxId);
    expect((await sessions.markFailed(workspaceId, 1, "no capacity")).failed).toEqual([parked.outboxId]);
    expect(db.get(`WORKSPACE#${workspaceId}`, `SESSION_WAITING#${parked.outboxId}`)).toBeUndefined();
  });

  it("deleting the session removes the markers it holds", async () => {
    const { db, sessions, workspaceId, outbox, marker } = sessionWorld();
    await sessions.ensureSession({ workspaceId, binding });
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    await sessions.markReady(workspaceId, 1);
    const parked = outbox();
    marker(parked.outboxId);
    await sessions.deleteSession(workspaceId);
    await sessions.markDeleted(workspaceId);
    expect(db.get(`WORKSPACE#${workspaceId}`, `SESSION_WAITING#${parked.outboxId}`)).toBeUndefined();
  });
});
