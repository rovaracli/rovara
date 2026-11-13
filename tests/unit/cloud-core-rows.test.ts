// Convergence S0 ROWS: Cloud's readers read a core task's records in both shapes (readers before writers), and the root ends a core task the way Cloud does.
// Each key has its row here: artifact (D17), operation events (D18), the limit family (D3), the task end (D20). A Cloud task's rows are read exactly as before.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { artifactKey } from "../../vendor/rovara-code/packages/broker/src/local/app/callbacks.js";
import {
  CORE_LIMIT_FAMILY, coreArtifactKey, coreFamilyCounters, coreOperationEvents, coreTaskEndedHandler, findArtifactRow, findCoreArtifactRow,
} from "../../packages/broker/src/cloud/rows/core-rows.js";
import { developerCharge, limitReached } from "../../packages/broker/src/developer/limits.js";
import { operationEventsNewestFirst } from "../../packages/broker/src/aws/broker/terminal-and-github-events.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const W = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const DEV = "d".repeat(64);
const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" });
const asBroker = (db: FakeDynamoDb) => deps(db) as unknown as Parameters<typeof operationEventsNewestFirst>[0];

/** A worker's artifact as Cloud's broker writes it (records.ts putArtifact) and as the core's callback writes it (vendor local/app/callbacks.ts recordArtifact). */
const cloudArtifact = { pk: `WORKSPACE#${W}`, sk: "ARTIFACT#a-cloud-1", entityType: "ARTIFACT", id: "a-cloud-1", workspaceId: W, operationId: OP, ownerKey: "owner", name: "plan.md", mediaType: "text/markdown", objectKey: "private/o/w/op/a-cloud-1", size: 12, createdAt: "2026-11-12T10:00:00.000Z" };
const coreArtifact = { ...coreArtifactKey(W, OP, "plan.md"), entityType: "ARTIFACT", id: "a-core-1", workspaceId: W, operationId: OP, name: "plan.md", mediaType: "text/markdown", objectKey: `workspaces/${W}/operations/${OP}/plan.md`, sha256: "f".repeat(64), bytes: 12, createdAt: "2026-11-12T10:00:00.000Z" };

describe("D17: the artifact key", () => {
  it("the core's key is the one its callback writes (drift guard against the vendored code)", () => {
    expect(coreArtifactKey(W, OP, "plan.md")).toEqual(artifactKey(W, OP, "plan.md"));
  });

  it("a Cloud task's artifact is found by its id with one read, as before", async () => {
    const db = new FakeDynamoDb();
    db.set(cloudArtifact);
    const send = vi.spyOn(db, "send");
    expect(await findArtifactRow(deps(db), W, "a-cloud-1")).toMatchObject({ id: "a-cloud-1", ownerKey: "owner", objectKey: "private/o/w/op/a-cloud-1" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a core task's artifact is found by the id on its row, whatever its key", async () => {
    const db = new FakeDynamoDb();
    db.set(coreArtifact);
    expect(await findArtifactRow(deps(db), W, "a-core-1")).toMatchObject({ id: "a-core-1", name: "plan.md", operationId: OP, objectKey: coreArtifact.objectKey });
    expect(await findArtifactRow(deps(db), W, "nobody")).toBeUndefined();
  });

  it("another workspace's artifact is never found", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...coreArtifact, pk: "WORKSPACE#33333333-3333-4333-8333-333333333333" });
    expect(await findCoreArtifactRow(deps(db), W, "a-core-1")).toBeUndefined();
  });

  it("a Cloud row is not mistaken for a core row: the by-id fallback needs an operation and a name in the key", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...cloudArtifact, sk: "ARTIFACT#a-cloud-2", id: "a-cloud-2" });
    expect(await findCoreArtifactRow(deps(db), W, "a-cloud-2")).toBeUndefined();
  });
});

describe("D18: operation events", () => {
  const cloudEvent = (n: number) => ({ pk: `OPERATION#${OP}`, sk: `EVENT#${String(n).padStart(12, "0")}`, entityType: "EVENT", workspaceId: W, operationId: OP, sequence: n, type: "progress", timestamp: `2026-11-12T10:00:0${n}.000Z`, payload: { message: `cloud ${n}` } });
  const coreEvent = (n: number) => ({ pk: `WORKSPACE#${W}`, sk: `EVENT#${OP}#${String(n).padStart(10, "0")}`, entityType: "OPERATION_EVENT", operationId: OP, sequence: n, type: "progress", timestamp: `2026-11-12T10:00:0${n}.000Z`, payload: { message: `core ${n}` } });

  it("the core's key is the one its callback writes (drift guard against the vendored code)", () => {
    const source = readFileSync(new URL("../../vendor/rovara-code/packages/broker/src/services/callbacks.ts", import.meta.url), "utf8");
    expect(source).toContain("sk: `EVENT#${operation.id}#${String(last - parsed.length + index + 1).padStart(10, \"0\")}`, entityType: \"OPERATION_EVENT\"");
  });

  it("a Cloud task's events are read where they always were, newest first, with no extra read", async () => {
    const db = new FakeDynamoDb();
    [1, 2, 3].forEach((n) => db.set(cloudEvent(n)));
    const send = vi.spyOn(db, "send");
    const events = await operationEventsNewestFirst(asBroker(db), OP, 10, W);
    expect(events.map((event) => event.sequence)).toEqual([3, 2, 1]);
    expect(send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(1);
  });

  it("a core task's events are found under its workspace, in the same shape, newest first", async () => {
    const db = new FakeDynamoDb();
    [1, 2, 3].forEach((n) => db.set(coreEvent(n)));
    const events = await operationEventsNewestFirst(asBroker(db), OP, 2, W);
    expect(events).toEqual([
      { sequence: 3, type: "progress", timestamp: "2026-11-12T10:00:03.000Z", payload: { message: "core 3" } },
      { sequence: 2, type: "progress", timestamp: "2026-11-12T10:00:02.000Z", payload: { message: "core 2" } },
    ]);
  });

  it("without a workspace the core's rows are not looked for (a caller that does not know it reads as before)", async () => {
    const db = new FakeDynamoDb();
    db.set(coreEvent(1));
    expect(await operationEventsNewestFirst(asBroker(db), OP, 10)).toEqual([]);
  });

  it("another operation's core events are not read", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...coreEvent(1), sk: `EVENT#99999999-9999-4999-8999-999999999999#${String(1).padStart(10, "0")}` });
    expect(await coreOperationEvents(deps(db), W, OP)).toEqual([]);
  });

  it("a page after a sequence reads from it, as Cloud's cursor does", async () => {
    const db = new FakeDynamoDb();
    [1, 2, 3, 4].forEach((n) => db.set(coreEvent(n)));
    const page = await coreOperationEvents(deps(db), W, OP, { limit: 2, afterSequence: 3 });
    expect(page.map((event) => event["sequence"])).toEqual([3, 4]);
    expect(page.every((event) => event["entityType"] === "EVENT")).toBe(true);
  });
});

describe("D3: the limit family a core task charges", () => {
  it("is the core's person family, named once", () => {
    expect(CORE_LIMIT_FAMILY).toBe("person");
    expect(coreFamilyCounters(ORG, DEV)).toEqual({ member: { pk: `DEVELOPER_LIMIT#${DEV}`, sk: "MEMBER" }, organization: { pk: `ORG#${ORG}#DEVELOPER_LIMIT#ORGANIZATION`, sk: "ORGANIZATION" } });
  });

  it("is the family Cloud's own route-started tasks charge (a developer with no Slack link)", () => {
    expect(developerCharge({ orgId: ORG, developerId: DEV })).toEqual(coreFamilyCounters(ORG, DEV));
  });

  const slackCharge = developerCharge({ orgId: ORG, teamId: "T0TEAM", slackUserId: "U0MAYA", developerId: DEV });
  const limits = { member: 2, organization: 50 };

  it("a Slack-linked person with two core tasks open cannot start a third on Cloud's path", async () => {
    const db = new FakeDynamoDb();
    const { member } = coreFamilyCounters(ORG, DEV);
    db.set({ ...member, count: 2 });
    db.set({ pk: member.pk, sk: "TASK#t1", entityType: "DEVELOPER_LIMIT_TASK", taskId: "t1" });
    db.set({ pk: member.pk, sk: "TASK#t2", entityType: "DEVELOPER_LIMIT_TASK", taskId: "t2" });
    expect(await limitReached(db, "state", slackCharge, limits)).toBeUndefined();
    expect(await limitReached(db, "state", slackCharge, limits, coreFamilyCounters(ORG, DEV))).toBe("member");
  });

  it("one core task and one Cloud Slack task count as two against a limit of two", async () => {
    const db = new FakeDynamoDb();
    const { member } = coreFamilyCounters(ORG, DEV);
    db.set({ ...member, count: 1 });
    db.set({ pk: member.pk, sk: "TASK#t1", entityType: "DEVELOPER_LIMIT_TASK", taskId: "t1" });
    db.set({ ...slackCharge.member, count: 1, tasks: new Set(["t0"]) });
    expect(await limitReached(db, "state", slackCharge, limits, coreFamilyCounters(ORG, DEV))).toBe("member");
  });

  it("with no core task nothing changes: the same answer with and without the other family", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...slackCharge.member, count: 1, tasks: new Set(["t0"]) });
    expect(await limitReached(db, "state", slackCharge, limits)).toBeUndefined();
    expect(await limitReached(db, "state", slackCharge, limits, coreFamilyCounters(ORG, DEV))).toBeUndefined();
    db.set({ ...slackCharge.member, count: 2, tasks: new Set(["t0", "t9"]) });
    expect(await limitReached(db, "state", slackCharge, limits)).toBe("member");
    expect(await limitReached(db, "state", slackCharge, limits, coreFamilyCounters(ORG, DEV))).toBe("member");
  });

  it("where Cloud's counter is the core's row (no Slack link) the core's tasks are not counted twice", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ orgId: ORG, developerId: DEV });
    db.set({ ...charge.member, count: 1 });
    db.set({ pk: charge.member.pk, sk: "TASK#t1", entityType: "DEVELOPER_LIMIT_TASK", taskId: "t1" });
    expect(await limitReached(db, "state", charge, limits, coreFamilyCounters(ORG, DEV))).toBeUndefined();
  });
});

describe("D20: the end of a core task", () => {
  it("tells Cloud's end bookkeeping with the record in the shape it reads, as closed", async () => {
    const told: unknown[] = [];
    const handler = coreTaskEndedHandler({ readTask: async () => ({ taskId: "t1", companyId: ORG, project: "payments" }), onTaskEnded: async (task, outcome) => { told.push([task, outcome]); } });
    await handler({ orgId: ORG, taskId: "t1" });
    expect(told).toEqual([[{ taskId: "t1", companyId: ORG, orgId: ORG, project: "payments" }, "closed"]]);
  });

  it("a record Cloud already wrote with orgId is passed as it is", async () => {
    const told: unknown[] = [];
    await coreTaskEndedHandler({ readTask: async () => ({ taskId: "t1", orgId: ORG }), onTaskEnded: async (task) => { told.push(task); } })({ orgId: ORG, taskId: "t1" });
    expect(told).toEqual([{ taskId: "t1", orgId: ORG }]);
  });

  it("a task with no record, or of another company, tells nobody", async () => {
    const onTaskEnded = vi.fn(async () => undefined);
    await coreTaskEndedHandler({ readTask: async () => undefined, onTaskEnded })({ orgId: ORG, taskId: "t1" });
    await coreTaskEndedHandler({ readTask: async () => ({ taskId: "t1", orgId: "org_bbbbbbbbbbbbbbbbbbbb" }), onTaskEnded })({ orgId: ORG, taskId: "t1" });
    expect(onTaskEnded).not.toHaveBeenCalled();
  });
});
