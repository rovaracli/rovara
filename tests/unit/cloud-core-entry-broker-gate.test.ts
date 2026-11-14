// S3-10: the broker's Lambda entry builds the core's inputs ONLY while the combined switch is on. Off (the default), the clients the entry was given are never touched, no root is built and a scheduled core
// job is not the broker's to answer: the broker is exactly what it was. On, the same entry answers the core's scheduled jobs through the root it built from those clients.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { CORE_IN_USE_PARTITION, readCoreEngineFlags, stampForNewTask, stampItem } from "../../packages/broker/src/cloud/app/index.js";
import { CORE_ENGINE_OFF_WORDS, GUARDED_CALLBACK_ACTIONS, createCoreStampGuard } from "../../packages/broker/src/cloud/app/stamp-guard.js";
import { CORE_CALLBACK_ACTIONS } from "../../packages/broker/src/cloud/app/entry.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";

/** Host resources that record every property read: with the switch off nothing may read them. */
function recordingResources(reads: string[]) {
  return new Proxy({}, { get: (_target, key) => { if (typeof key === "string" && key !== "then") reads.push(key); return undefined; } });
}

const CORE_JOB = { source: "agentx.core-job", job: "dispatch-sweep" };

describe("the broker entry's core gate (S3-10)", () => {
  beforeAll(async () => { await loadSlackBroker(); }, 120_000);
  afterEach(() => { delete process.env.CLOUD_CORE_ENGINE; });

  it("switch off: the core clients are never read, no root is built and a core job is not answered by the core", async () => {
    delete process.env.CLOUD_CORE_ENGINE;
    const reads: string[] = [];
    const { handler, db } = createBroker({ extra: { cloudCoreHost: recordingResources(reads) } });
    const sentOf = (): string[] => (db as unknown as { sent: string[] }).sent;
    const sent = sentOf().length;
    const answer = await (handler)(CORE_JOB).catch((error: unknown) => ({ statusCode: -1, body: String(error) }));
    // An event no route of the broker knows: refused as an unauthenticated request, as before the core existed.
    expect(answer.statusCode).toBe(401);
    expect(answer.body).not.toContain("\"job\"");
    expect(reads).toEqual([]);
    // Not even the in-use read a root makes before it answers a job.
    expect(sentOf().slice(sent)).not.toContain("QueryCommand");
  });

  it("switch on: the same entry builds the root from those clients and answers the core job", async () => {
    process.env.CLOUD_CORE_ENGINE = "on";
    const reads: string[] = [];
    const { handler } = createBroker({ extra: { cloudCoreHost: recordingResources(reads) } });
    const answer = await (handler)(CORE_JOB);
    // The root was built and asked for its modules: the deps builder read the clients it was given (and, with no developer API in this harness, refused there: `core_entry.not_configured`).
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ job: "dispatch-sweep" });
    expect(reads.length).toBeGreaterThan(0);
  });

  /** A core task's rows as the core wrote them: the company's in-use mark, the workspace's task pointer, the task row and its engine stamp. */
  function seedCoreTask(db: FakeDynamoDb, options: { stamp?: boolean } = {}): { workspaceId: string; taskId: string } {
    const workspaceId = randomUUID();
    const taskId = randomUUID();
    db.set({ pk: CORE_IN_USE_PARTITION, sk: `ORG#${TEST_ORG}`, orgId: TEST_ORG });
    db.set({ ...taskPointerKey(workspaceId), taskId });
    db.set({ ...taskKey(taskId), taskId, companyId: TEST_ORG, orgId: TEST_ORG });
    if (options.stamp !== false) db.set(stampItem(TEST_ORG, taskId, stampForNewTask(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on" }), TEST_ORG, new Date())).item);
    return { workspaceId, taskId };
  }
  const callbackEvent = (workspaceId: string, action = "result") => ({
    version: "2.0", rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${randomUUID()}/${action}`, rawQueryString: "",
    headers: { "content-type": "application/json", "x-agentx-callback-capability": "not-checked-here" }, body: JSON.stringify({ status: "SUCCEEDED" }),
    requestContext: { requestId: randomUUID(), http: { method: "POST" } },
  });
  const snapshot = (db: FakeDynamoDb) => JSON.stringify([...db.items.entries()].sort());

  it("review H1(b): switch off, a core-stamped task: its worker's callback is answered 503 and no row is touched (never Cloud's callback code)", async () => {
    delete process.env.CLOUD_CORE_ENGINE;
    const { handler, db } = createBroker({});
    const { workspaceId } = seedCoreTask(db);
    const before = snapshot(db);
    const answer = await (handler)(callbackEvent(workspaceId));
    expect(answer.statusCode).toBe(503);
    expect(snapshot(db)).toBe(before);
  });

  it("review H1(b): switch off, a task with no core stamp: the callback is Cloud's, as before (the guard answers nothing)", async () => {
    delete process.env.CLOUD_CORE_ENGINE;
    const { handler, db } = createBroker({});
    const { workspaceId } = seedCoreTask(db, { stamp: false });
    const answer = await (handler)(callbackEvent(workspaceId));
    expect(answer.statusCode).not.toBe(503);
  });

  it("review H1(b): the guard's task routes own a core-stamped task of the caller's company and refuse every action in words; an install that never used the core reads no stamp", async () => {
    const db = new FakeDynamoDb();
    const guard = createCoreStampGuard({ documentClient: db, tableName: "state", now: () => 0 });
    const fresh = randomUUID();
    expect(await guard.taskRoutes.owns({ orgId: TEST_ORG }, fresh)).toBe(false);
    expect((db as unknown as { sent: string[] }).sent).not.toContain("GetCommand");
    const later = createCoreStampGuard({ documentClient: db, tableName: "state", now: () => 0 });
    const { taskId } = seedCoreTask(db);
    expect(await later.taskRoutes.owns({ orgId: TEST_ORG }, taskId)).toBe(true);
    expect(await later.taskRoutes.owns({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, taskId)).toBe(false);
    for (const action of ["decide", "close", "retry", "cancel", "revisePlan"] as const) await expect(later.taskRoutes[action]({} as never)).rejects.toThrow(CORE_ENGINE_OFF_WORDS);
    expect([...GUARDED_CALLBACK_ACTIONS].sort()).toEqual([...CORE_CALLBACK_ACTIONS].sort());
  });
});
