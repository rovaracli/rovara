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
    const planned = t.planInvocation.payload.learnedRefs as { stage: string; lessons: Array<{ id: string; version: number }> };
    expect(planned.stage).toBe("PLAN");
    expect(planned.lessons).toEqual([{ id: "les_approved1", version: 1 }]);
    const { invocation, operation } = await t.accept("IMPLEMENT");
    const context = invocation.payload.learnedRefs as { stage: string; lessons: Array<{ id: string }> };
    expect(context.stage).toBe("IMPLEMENT");
    expect(context.lessons.map((l) => l.id)).toEqual(["les_approved1"]);
    // WL-6: the stored stage (the outbox row the queue message is made from) holds ids and versions, never the lesson's words, and no `learnedContext`.
    for (const payload of [t.planInvocation.payload, invocation.payload]) {
      expect(payload).not.toHaveProperty("learnedContext");
      const approved = lessonRecord({ id: "les_approved1" });
      expect(JSON.stringify(payload)).not.toContain(approved.body);
      expect(JSON.stringify(payload)).not.toContain(approved.title);
    }
    expect(operation.learnedLoad).toMatchObject({ taskId: t.meta().taskId, project: PROJECT, stage: "IMPLEMENT" });
    const manifests = await t.store.manifests({ workspaceId: TEST_ORG, project: PROJECT }, t.meta().taskId);
    expect(manifests.map((m) => m.stage).sort()).toEqual(["IMPLEMENT", "PLAN"]);
    expect(LEARNED_LOAD_REPORT_FIELD).toBe("learnedLoadReport");
  });

  it("carries nothing, and records nothing, with learning Off for the project", async () => {
    const t = await setup({ mode: "Off" });
    expect(t.planInvocation.payload).not.toHaveProperty("learnedRefs");
    const { invocation, operation } = await t.accept("IMPLEMENT");
    expect(invocation.payload).not.toHaveProperty("learnedRefs");
    expect(operation).not.toHaveProperty("learnedLoad");
    expect(await t.store.manifests({ workspaceId: TEST_ORG, project: PROJECT }, t.meta().taskId)).toEqual([]);
  });

  it("carries nothing, and records nothing, with the install switch off even where lesson ports exist and learning is On (the default)", async () => {
    const t = await setup({ switch: "off" });
    expect(t.planInvocation.payload).not.toHaveProperty("learnedRefs");
    const { invocation, operation } = await t.accept("IMPLEMENT");
    expect(invocation.payload).not.toHaveProperty("learnedRefs");
    expect(operation).not.toHaveProperty("learnedLoad");
    expect(await t.store.manifests({ workspaceId: TEST_ORG, project: PROJECT }, t.meta().taskId)).toEqual([]);
  });

  it("carries nothing where the install has no lesson ports (the default)", async () => {
    const t = await setup({ withLessons: false });
    expect(t.planInvocation.payload).not.toHaveProperty("learnedRefs");
    const { invocation } = await t.accept("IMPLEMENT");
    expect(invocation.payload).not.toHaveProperty("learnedRefs");
  });
});

describe("delivery: the stage's lessons are built from the lesson store at the moment it is sent (WL-6)", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const };
  const SECRET = "Call the internal retry endpoint at the secret path before every request.";
  const refs = { v: 1, orgId: TEST_ORG, project: PROJECT, setVersion: 1, stage: "IMPLEMENT", audience: { kind: "shared" }, lessons: [{ id: "les_mallory01", version: 1 }] };
  const built = { v: 1, setVersion: 1, stage: "IMPLEMENT", lessons: [{ id: "les_mallory01", version: 1, type: "convention", title: "Mallory's rule", description: "", body: SECRET, scopeLabel: "repo api", citations: [] }] };
  function record(payload: Record<string, unknown> = { learnedRefs: refs }): Ec2OutboxRecord {
    const operationId = randomUUID(), workspaceId = randomUUID();
    const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId, fence: 2, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "do it", ...payload } } as WorkerInvocation;
    return { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs", invocation };
  }
  async function deliver(features: readonly string[] | undefined, over: { payload?: Record<string, unknown>; learnedFromRefs?: Ec2DeliveryDependencies["learnedFromRefs"] } = {}) {
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    const deliverEc2 = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
      binding: async () => binding, sign: kmsSign, post, progress: async () => undefined, now: () => Date.parse("2026-11-01T12:00:00.000Z"),
      ...(features === undefined ? {} : { workerFeatures: async () => features }), ...(over.learnedFromRefs === undefined ? {} : { learnedFromRefs: over.learnedFromRefs }),
    });
    const markFailed = vi.fn(async () => undefined), markDelivered = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, maxAttempts: 1, log: () => undefined });
    const queued = record(over.payload);
    await handler({ Records: [{ messageId: "m", body: JSON.stringify(queued) }] });
    const body = post.mock.calls[0]?.[1]?.body;
    return { post, markFailed, markDelivered, queued, sent: body === undefined ? undefined : (JSON.parse(body) as { payload: Record<string, unknown> }) };
  }

  it("the queue message holds ids and versions, not the lesson's words", async () => {
    const { queued } = await deliver([LEARNED_CONTEXT_FEATURE], { learnedFromRefs: async () => built as never });
    expect(JSON.stringify(queued)).not.toContain("secret path");
    expect(JSON.stringify(queued)).not.toContain("Mallory");
    expect(JSON.stringify(queued)).toContain("les_mallory01");
  });

  it("a worker that lists the feature is sent the context built from the store at that moment, and never the refs", async () => {
    let asked = 0;
    const current = await deliver([LEARNED_CONTEXT_FEATURE], { learnedFromRefs: async (asking) => { asked += 1; expect(asking).toEqual(refs); return built as never; } });
    expect(current.markDelivered).toHaveBeenCalledTimes(1);
    expect(asked).toBe(1);
    expect(current.sent?.payload.learnedContext).toEqual(built);
    expect(current.sent?.payload).not.toHaveProperty("learnedRefs");
    expect(JSON.stringify(current.post.mock.calls[0])).not.toContain("learnedRefs");
  });

  it("a lesson erased, retired or edited after the stage was queued is not sent: the store says nothing, and the stage runs without lessons and is delivered", async () => {
    const gone = await deliver([LEARNED_CONTEXT_FEATURE], { learnedFromRefs: async () => undefined });
    expect(gone.markFailed).not.toHaveBeenCalled();
    expect(gone.markDelivered).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gone.post.mock.calls[0])).not.toMatch(/learnedContext|learnedRefs|secret path/u);
  });

  it("a lookup that fails sends no lessons and does not fail the stage", async () => {
    const down = await deliver([LEARNED_CONTEXT_FEATURE], { learnedFromRefs: async () => { throw new Error("db down"); } });
    expect(down.markFailed).not.toHaveBeenCalled();
    expect(down.markDelivered).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(down.post.mock.calls[0])).not.toMatch(/learnedContext|learnedRefs/u);
  });

  it("no lookup is made, and nothing is sent, for an older worker, a worker whose features could not be asked, or an install with no lesson reader", async () => {
    let asked = 0;
    const lookup = async () => { asked += 1; return built as never; };
    for (const features of [["task.workflowMode", "model.thinkingLevel"], undefined]) {
      const old = await deliver(features, { learnedFromRefs: lookup });
      expect(old.markFailed).not.toHaveBeenCalled();
      expect(old.markDelivered).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(old.post.mock.calls[0])).not.toMatch(/learnedContext|learnedRefs/u);
    }
    expect(asked).toBe(0);
    const noReader = await deliver([LEARNED_CONTEXT_FEATURE]);
    expect(noReader.markDelivered).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(noReader.post.mock.calls[0])).not.toMatch(/learnedContext|learnedRefs/u);
  });

  it("a stage queued by an earlier build (stored learnedContext, no refs) keeps the old rule: sent to a worker that lists the feature, removed for one that does not", async () => {
    const legacy = { learnedContext: { v: 1, setVersion: 1, stage: "IMPLEMENT", lessons: [] } };
    const current = await deliver([LEARNED_CONTEXT_FEATURE], { payload: legacy });
    expect(current.sent?.payload).toHaveProperty("learnedContext");
    const old = await deliver(["task.workflowMode"], { payload: legacy });
    expect(old.sent?.payload).not.toHaveProperty("learnedContext");
  });
});
