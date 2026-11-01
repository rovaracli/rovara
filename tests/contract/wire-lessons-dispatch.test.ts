// Wiring lane wire-lessons: through the real broker. A coding stage's worker invocation carries the approved lessons for the stage (and records the manifest the worker's report is applied to) only
// where the install has lesson ports and the project's learning mode allows it; delivery removes the field for a worker that does not list the feature.
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { developerTaskIdentity, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { NO_EMBEDDER, NO_VECTORS } from "../../packages/broker/src/lessons/runtime.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import type { LoadDeps } from "../../packages/broker/src/lessons/load.js";
import { LEARNED_CONTEXT_FEATURE, LEARNED_LOAD_REPORT_FIELD } from "../../packages/contracts/src/index.js";
import type { WorkerInvocation } from "../../packages/contracts/src/protocol.js";
import { Audit, Clock, allowAllAccess, lessonRecord, seed, settings } from "../unit/lessons/lesson-helpers.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const PROJECT = "payments";

/** The install switch for lessons reaching an agent (apart from the Team record's flag): on for these tests unless one turns it off. */
const SWITCH = "LEARNED_LESSONS_ENABLED";
afterAll(() => { delete process.env[SWITCH]; });

async function setup(options: { mode?: "On" | "Off"; withLessons?: boolean; switch?: "on" | "off" } = {}) {
  if (options.switch === "off") delete process.env[SWITCH]; else process.env[SWITCH] = "1";
  const store = new InMemoryLessonStore();
  const load: LoadDeps = { store, embedder: NO_EMBEDDER, vectors: NO_VECTORS, settings: settings(options.mode === undefined ? {} : { mode: options.mode }), access: allowAllAccess, audit: new Audit(), now: new Clock().now };
  const lessons = options.withLessons === false ? {} : { lessons: { load, directory: { identity: async () => ({ principals: [], groups: [] }), eligibility: async () => { throw new Error("n/a"); } }, settings: load.settings, counters: { store, judge: { rate: async () => { throw new Error("no"); } }, settings: load.settings, audit: load.audit, now: load.now } } };
  const h = await createSingleAnswerPlanBroker({ brokerExtra: lessons });
  const approved = lessonRecord({ id: "les_approved1", workspaceId: TEST_ORG, project: PROJECT, type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], scope: {} });
  const unapproved = lessonRecord({ id: "les_unapprovd", workspaceId: TEST_ORG, project: PROJECT, type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [{ approvalId: "au", by: "system:auto", at: 1, mode: "auto" }], scope: {} });
  await seed(store, approved, unapproved);
  const reply = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Fix the retry bug", workflow: true, workflowPath: "QUICK", client: "test-client" });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const taskId = (reply.body.task as { taskId: string }).taskId;
  const meta = () => h.db.get(`DEVTASK#${taskId}`, "META") as unknown as DeveloperTaskRecord;
  const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${meta().workspaceId}` && item.entityType === "OPERATION");
  const prepareId = String(operations().find((item) => item.kind === "prepare")!.id);
  await h.finish(meta().workspaceId, prepareId, "SUCCEEDED", PREPARED);
  const invocationOf = (operationId: string) => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { payload: Record<string, unknown> };
  const accept = async (mode: "IMPLEMENT" | "REVIEW") => {
    const active = operations().find((item) => ["ACCEPTED", "DISPATCHING", "RUNNING"].includes(String(item.status)));
    if (active !== undefined) await h.finish(meta().workspaceId, String(active.id), "FAILED", { error: "ended by the test" });
    const task = meta();
    const accepted = await h.actions.acceptTask(developerTaskIdentity(task, TEST_ORG), task.workspaceId, { requestId: randomUUID(), conversationId: task.conversationId, prompt: `Do the ${mode} step` }, () => [], { workflowMode: mode });
    return { operation: operations().find((item) => item.id === accepted.operation.id)!, invocation: invocationOf(accepted.operation.id) };
  };
  return { h, store, accept, meta, planInvocation: invocationOf(String(operations().find((item) => item.workflowMode === "PLAN")!.id)) };
}

describe("the worker invocation of a coding stage", () => {
  it("carries the approved lessons for the stage, and the operation names the manifest the report belongs to", async () => {
    const t = await setup();
    // The planning stage that preparing started already asked the loader: only the approved lesson is in it.
    const planned = t.planInvocation.payload.learnedContext as { stage: string; lessons: Array<{ id: string }> };
    expect(planned.stage).toBe("PLAN");
    expect(planned.lessons.map((l) => l.id)).toEqual(["les_approved1"]);
    const { invocation, operation } = await t.accept("IMPLEMENT");
    const context = invocation.payload.learnedContext as { stage: string; lessons: Array<{ id: string }> };
    expect(context.stage).toBe("IMPLEMENT");
    expect(context.lessons.map((l) => l.id)).toEqual(["les_approved1"]);
    expect(operation.learnedLoad).toMatchObject({ taskId: t.meta().taskId, project: PROJECT, stage: "IMPLEMENT" });
    const manifests = await t.store.manifests({ workspaceId: TEST_ORG, project: PROJECT }, t.meta().taskId);
    expect(manifests.map((m) => m.stage).sort()).toEqual(["IMPLEMENT", "PLAN"]);
    expect(LEARNED_LOAD_REPORT_FIELD).toBe("learnedLoadReport");
  });

  it("carries nothing, and records nothing, with learning Off for the project", async () => {
    const t = await setup({ mode: "Off" });
    expect(t.planInvocation.payload).not.toHaveProperty("learnedContext");
    const { invocation, operation } = await t.accept("IMPLEMENT");
    expect(invocation.payload).not.toHaveProperty("learnedContext");
    expect(operation).not.toHaveProperty("learnedLoad");
    expect(await t.store.manifests({ workspaceId: TEST_ORG, project: PROJECT }, t.meta().taskId)).toEqual([]);
  });

  it("carries nothing, and records nothing, with the install switch off even where lesson ports exist and learning is On (the default)", async () => {
    const t = await setup({ switch: "off" });
    expect(t.planInvocation.payload).not.toHaveProperty("learnedContext");
    const { invocation, operation } = await t.accept("IMPLEMENT");
    expect(invocation.payload).not.toHaveProperty("learnedContext");
    expect(operation).not.toHaveProperty("learnedLoad");
    expect(await t.store.manifests({ workspaceId: TEST_ORG, project: PROJECT }, t.meta().taskId)).toEqual([]);
  });

  it("carries nothing where the install has no lesson ports (the default)", async () => {
    const t = await setup({ withLessons: false });
    expect(t.planInvocation.payload).not.toHaveProperty("learnedContext");
    const { invocation } = await t.accept("IMPLEMENT");
    expect(invocation.payload).not.toHaveProperty("learnedContext");
  });
});

describe("delivery to an older worker", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const };
  const context = { v: 1, setVersion: 1, stage: "IMPLEMENT", lessons: [] };
  function record(): Ec2OutboxRecord {
    const operationId = randomUUID(), workspaceId = randomUUID();
    const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId, fence: 2, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "do it", learnedContext: context } } as WorkerInvocation;
    return { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs", invocation };
  }
  async function deliver(features: readonly string[]) {
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    const deliverEc2 = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
      binding: async () => binding, sign: kmsSign, post, progress: async () => undefined, now: () => Date.parse("2026-11-01T12:00:00.000Z"), workerFeatures: async () => features,
    });
    const markFailed = vi.fn(async () => undefined), markDelivered = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, maxAttempts: 1, log: () => undefined });
    await handler({ Records: [{ messageId: "m", body: JSON.stringify(record()) }] });
    return { post, markFailed, markDelivered };
  }
  const sent = (post: ReturnType<typeof vi.fn>) => JSON.stringify(post.mock.calls[0]);

  it("is sent the stage without the lessons, and the stage is delivered", async () => {
    const old = await deliver(["task.workflowMode", "model.thinkingLevel"]);
    expect(old.markFailed).not.toHaveBeenCalled();
    expect(old.markDelivered).toHaveBeenCalledTimes(1);
    expect(old.post).toHaveBeenCalledTimes(1);
    expect(sent(old.post)).not.toContain("learnedContext");
  });

  it("a worker that lists the feature is sent them", async () => {
    const current = await deliver([LEARNED_CONTEXT_FEATURE]);
    expect(current.markDelivered).toHaveBeenCalledTimes(1);
    expect(sent(current.post)).toContain("learnedContext");
  });

  it("a worker whose features could not be asked is treated as an old one", async () => {
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    const deliverEc2 = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
      binding: async () => binding, sign: kmsSign, post, progress: async () => undefined, now: () => Date.parse("2026-11-01T12:00:00.000Z"),
    });
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined, markFailed: async () => undefined, deliverEc2, maxAttempts: 1, log: () => undefined });
    await handler({ Records: [{ messageId: "m", body: JSON.stringify(record()) }] });
    expect(JSON.stringify(post.mock.calls[0])).not.toContain("learnedContext");
  });
});
