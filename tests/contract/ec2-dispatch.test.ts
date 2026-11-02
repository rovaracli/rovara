import { z } from "zod";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, agentXError, taskGraphDigest, workflowPublicationContext, workflowPublicationContextDigest, workspaceSessionKey, type Ec2RuntimeBinding, type WorkerInvocation } from "../../packages/contracts/src/index.js";
import { createDispatcherHandler, createWorkflowE2EReadinessCompleter, createWorkflowE2EReadinessValidator, workerPingFeatures } from "../../packages/broker/src/aws/dispatcher.js";
import { guardTaskDispatch as coreGuardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { STARTING_COMPUTE_MESSAGE, createEc2Delivery, type Ec2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import type { FeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import type { DurableOutboxRecord, Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { appendOperationEvent } from "../../packages/broker/src/aws/operation-events.js";
import { SessionManager, workspaceBinding } from "../../packages/broker/src/aws/sessions.js";
import { verifyInvokeAuthorization, invocationMatchesClaims } from "../../packages/worker/src/invoke-auth.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { projectRevisionKey } from "../../packages/contracts/src/org-scoped-keys.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
// What KMS Sign returns for ECDSA_SHA_256 on an ECC_NIST_P256 key: a DER signature over the message.
const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs" as const,
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3" as const,
};

function recordFor(workspaceId = randomUUID(), fence = 2): Ec2OutboxRecord {
  const operationId = randomUUID();
  const invocation: WorkerInvocation = {
    protocolVersion: 1, kind: "resume", operationId, workspaceId, fence, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {},
  };
  return { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs" as const, invocation };
}

function delivery(overrides: Partial<Ec2DeliveryDependencies> = {}, without: ReadonlyArray<keyof Ec2DeliveryDependencies> = []) {
  const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
  const progress = vi.fn<Ec2DeliveryDependencies["progress"]>(async () => undefined);
  const applicationPlanNotNegotiated = vi.fn<NonNullable<Ec2DeliveryDependencies["applicationPlanNotNegotiated"]>>(async () => undefined);
  const planQualityNotNegotiated = vi.fn<NonNullable<Ec2DeliveryDependencies["planQualityNotNegotiated"]>>(async () => undefined);
  const dependencies: Ec2DeliveryDependencies = {
    sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
    binding: async () => binding,
    sign: kmsSign,
    post,
    progress,
    applicationPlanNotNegotiated,
    planQualityNotNegotiated,
    now: () => NOW,
    ...overrides,
  };
  for (const key of without) delete dependencies[key];
  const deliver = createEc2Delivery(dependencies);
  return { deliver, post, progress, applicationPlanNotNegotiated, planQualityNotNegotiated };
}

function readinessFixture() {
  const db = new FakeDynamoDb();
  const record = recordFor();
  const taskId = randomUUID();
  const marker = {
    purpose: "workflow-e2e-readiness" as const,
    taskId,
    workflowRevision: 4,
    candidateDigest: "a".repeat(64),
    dispatchSk: `${taskId}#4`,
  };
  record.workflowE2EReadiness = marker;
  db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}`, entityType: "OPERATION",
    id: record.operationId, kind: "resume", status: "DISPATCHING", workspaceId: record.workspaceId, fence: record.invocation.fence, eventSequence: 0,
    workflowE2EReadiness: { ...marker, outboxId: record.id } });
  db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record, status: "QUEUED" });
  db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: "META", entityType: "WORKSPACE", id: record.workspaceId, status: "BUSY",
    deploymentMode: "ec2-ebs", projectName: "readiness-test", projectRevision: record.invocation.projectRevision,
    activeOperationId: record.operationId, fence: record.invocation.fence });
  db.set({ ...projectRevisionKey(TEST_ORG, "readiness-test", record.invocation.projectRevision), entityType: "PROJECT", runtimeBinding: binding });
  db.set({ pk: `DEVTASK#${taskId}`, sk: "META", taskId, workspaceId: record.workspaceId, workflow: { revision: marker.workflowRevision, stage: "VERIFY", state: "WAITING",
    candidate: { digest: marker.candidateDigest }, e2e: { required: true } } });
  db.set({ pk: "WORKFLOW_DISPATCH", sk: marker.dispatchSk, taskId, workflowRevision: marker.workflowRevision,
    candidateDigest: marker.candidateDigest, readinessOperationId: record.operationId, kind: "CHECKS" });
  return { db, record, marker, taskId };
}

describe("ec2-ebs delivery", () => {
  it("rechecks task access after compute is ready and parks before signing or POST", async () => {
    const signInvocation = vi.fn(kmsSign);
    const { deliver, post } = delivery({
      sign: signInvocation,
      guardTaskDispatch: async () => "PARKED",
    });
    const record = recordFor();

    await expect(deliver(record, record.invocation)).resolves.toBe("WAITING_FOR_TASK_ACCESS");
    expect(signInvocation).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("creates a fresh task guard after readiness and after ping with current Lambda time", async () => {
    const guardTaskDispatch = vi.fn<NonNullable<Ec2DeliveryDependencies["guardTaskDispatch"]>>(async () => "ALLOWED");
    const { deliver } = delivery({ guardTaskDispatch });
    const record = recordFor();
    let remaining = 15_000;

    await expect(deliver(record, record.invocation, { remainingTimeMs: () => remaining-- })).resolves.toBe("DELIVERED");
    expect(guardTaskDispatch).toHaveBeenCalledTimes(2);
    expect(typeof guardTaskDispatch.mock.calls[0]?.[1]?.remainingTimeMs).toBe("function");
    expect(typeof guardTaskDispatch.mock.calls[1]?.[1]?.remainingTimeMs).toBe("function");
  });

  it("posts the invocation to the worker with a token the worker's own verifier accepts", async () => {
    const { deliver, post } = delivery();
    const record = recordFor();
    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    const [url, init] = post.mock.calls[0]!;
    expect(url).toBe("http://10.42.128.10:8080/invocations");
    expect(JSON.parse(init.body)).toEqual(record.invocation);
    const verified = verifyInvokeAuthorization(init.authorization, {
      publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000),
    });
    expect(verified).toMatchObject({ ok: true, claims: { generation: 3, operationId: record.operationId, fence: 2, expiresAt: Math.floor(NOW / 1_000) + 60 } });
    expect(verified.ok && invocationMatchesClaims(record.invocation, verified.claims)).toBe(true);
    // A minute later the same token is refused.
    expect(verifyInvokeAuthorization(init.authorization, {
      publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000) + 60,
    })).toEqual({ ok: false, reason: "expired" });
  });

  it("uses only a marked ready resume as a compute-readiness receipt and never posts it to the worker", async () => {
    const fixture = readinessFixture();
    const validate = vi.fn(createWorkflowE2EReadinessValidator({ documentClient: fixture.db as never, tableName: "state" }));
    const ensureSession = vi.fn(async () => ({ ready: true as const, generation: 3, privateIp: "10.42.128.10" }));
    const { deliver, post } = delivery({ validateWorkflowE2EReadiness: validate, sessions: { ensureSession } });

    await expect(deliver(fixture.record, fixture.record.invocation)).resolves.toEqual({ readinessGeneration: 3 });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.invocationCallOrder[0]).toBeLessThan(ensureSession.mock.invocationCallOrder[0]!);
    expect(post).not.toHaveBeenCalled();
    expect(fixture.db.commandNames().filter((command) => command === "GetCommand").length).toBeGreaterThan(0);
  });

  it("does not treat an unrelated resume as E2E readiness", async () => {
    const db = new FakeDynamoDb();
    const record = recordFor();
    db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}`, kind: "resume", status: "DISPATCHING",
      id: record.operationId, workspaceId: record.workspaceId, fence: record.invocation.fence });
    const validate = createWorkflowE2EReadinessValidator({ documentClient: db as never, tableName: "state" });
    const { deliver, post } = delivery({ validateWorkflowE2EReadiness: validate });

    await expect(deliver(record, record.invocation)).resolves.toBe("DELIVERED");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects a forged readiness marker before provisioning compute or posting to the worker", async () => {
    const fixture = readinessFixture();
    fixture.record.workflowE2EReadiness = { ...fixture.marker, purpose: "not-readiness" } as unknown as typeof fixture.marker;
    const ensureSession = vi.fn(async () => ({ ready: true as const, generation: 3, privateIp: "10.42.128.10" }));
    const { deliver, post } = delivery({
      validateWorkflowE2EReadiness: createWorkflowE2EReadinessValidator({ documentClient: fixture.db as never, tableName: "state" }),
      sessions: { ensureSession },
    });

    await expect(deliver(fixture.record, fixture.record.invocation)).rejects.toThrow("stored E2E readiness operation, outbox, task, or active fence does not match");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["stored invocation fence", (fixture: ReturnType<typeof readinessFixture>) => {
      const outbox = fixture.db.get(`OUTBOX#${fixture.record.id}`, "OUTBOX")!;
      fixture.db.set({ ...outbox, invocation: { ...fixture.record.invocation, fence: fixture.record.invocation.fence + 1 } });
    }],
    ["operation fence", (fixture: ReturnType<typeof readinessFixture>) => {
      const operation = fixture.db.get(`WORKSPACE#${fixture.record.workspaceId}`, `OPERATION#${fixture.record.operationId}`)!;
      fixture.db.set({ ...operation, fence: fixture.record.invocation.fence + 1 });
    }],
    ["active workspace fence", (fixture: ReturnType<typeof readinessFixture>) => {
      const workspace = fixture.db.get(`WORKSPACE#${fixture.record.workspaceId}`, "META")!;
      fixture.db.set({ ...workspace, fence: fixture.record.invocation.fence + 1 });
    }],
    ["workflow revision", (fixture: ReturnType<typeof readinessFixture>) => {
      const task = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!;
      const workflow = task.workflow as Record<string, unknown>;
      fixture.db.set({ ...task, workflow: { ...workflow, revision: fixture.marker.workflowRevision + 1 } });
    }],
    ["stored purpose", (fixture: ReturnType<typeof readinessFixture>) => {
      const operation = fixture.db.get(`WORKSPACE#${fixture.record.workspaceId}`, `OPERATION#${fixture.record.operationId}`)!;
      const marker = operation.workflowE2EReadiness as Record<string, unknown>;
      fixture.db.set({ ...operation, workflowE2EReadiness: { ...marker, purpose: "other-purpose" } });
    }],
  ])("rejects before provisioning compute when the stored %s is stale or changed", async (_caseName, mutate) => {
    const fixture = readinessFixture();
    mutate(fixture);
    const ensureSession = vi.fn(async () => ({ ready: true as const, generation: 3, privateIp: "10.42.128.10" }));
    const { deliver, post } = delivery({
      validateWorkflowE2EReadiness: createWorkflowE2EReadinessValidator({ documentClient: fixture.db as never, tableName: "state" }),
      sessions: { ensureSession },
    });

    await expect(deliver(fixture.record, fixture.record.invocation)).rejects.toThrow("stored E2E readiness operation, outbox, task, or active fence does not match");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("completes only the validated readiness operation and releases its matching active workspace fence", async () => {
    const fixture = readinessFixture();
    const generation = 9;
    fixture.db.set({ ...workspaceSessionKey(fixture.record.workspaceId), state: "READY", generation, privateIp: "10.42.128.10" });
    const transactions: Array<{ TransactItems: Array<Record<string, Record<string, unknown>>> }> = [];
    const documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "TransactWriteCommand") transactions.push(command.input as typeof transactions[number]);
      return fixture.db.send(command);
    } };
    const validate = createWorkflowE2EReadinessValidator({ documentClient: documentClient as never, tableName: "state" });
    const complete = createWorkflowE2EReadinessCompleter({ documentClient: documentClient as never, tableName: "state" });
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{}" }));
    const deliver = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation, privateIp: "10.42.128.10" }) },
      binding: async () => binding, sign: kmsSign, post, progress: async () => undefined, now: () => NOW,
      validateWorkflowE2EReadiness: validate,
    });
    const handler = createDispatcherHandler({
      markDispatching: async () => true, markDelivered: async () => undefined, markFailed: async () => undefined,
      deliverEc2: (record, invocation) => deliver(record, invocation),
      completeWorkflowE2EReadiness: complete, log: () => undefined,
    });

    await expect(handler({ Records: [{ messageId: "readiness", body: JSON.stringify(fixture.record) }] })).resolves.toEqual({ batchItemFailures: [] });
    expect(post).not.toHaveBeenCalled();
    const completedOperation = fixture.db.get(`WORKSPACE#${fixture.record.workspaceId}`, `OPERATION#${fixture.record.operationId}`)!;
    expect(completedOperation).toMatchObject({
      status: "SUCCEEDED", result: { status: "READY", generation },
      workflowE2EReadiness: { ...fixture.marker, outboxId: fixture.record.id, readyGeneration: generation },
    });
    expect(Object.hasOwn(completedOperation, "workflowE2EReadiness.readyGeneration")).toBe(false);
    const completion = transactions[0]?.TransactItems;
    expect(completion).toHaveLength(6);
    const operationUpdate = completion?.find((entry) => "Update" in entry && entry.Update?.Key && (entry.Update.Key as { sk?: string }).sk === `OPERATION#${fixture.record.operationId}`)?.Update;
    expect(operationUpdate?.UpdateExpression).toContain("workflowE2EReadiness = :readiness");
    expect(operationUpdate?.ExpressionAttributeValues).toMatchObject({ ":readiness": { ...fixture.marker, outboxId: fixture.record.id, readyGeneration: generation },
      ":fence": fixture.record.invocation.fence, ":outbox": fixture.record.id });
    const sessionCheck = completion?.find((entry) => "ConditionCheck" in entry && JSON.stringify(entry.ConditionCheck?.Key) === JSON.stringify(workspaceSessionKey(fixture.record.workspaceId)))?.ConditionCheck;
    expect(sessionCheck).toMatchObject({ ConditionExpression: "#state = :ready AND generation = :generation",
      ExpressionAttributeValues: { ":ready": "READY", ":generation": generation } });
    expect(fixture.db.get(`OUTBOX#${fixture.record.id}`, "OUTBOX")).toMatchObject({ status: "DELIVERED" });
    expect(fixture.db.get(`WORKSPACE#${fixture.record.workspaceId}`, "META")).toMatchObject({ status: "READY", fence: fixture.record.invocation.fence });
    expect(fixture.db.get(`WORKSPACE#${fixture.record.workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
  });

  describe("the task's readiness and workers built before it (spec 051)", () => {
    const readiness = [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 300 }];
    function taskRecord(payload: Record<string, unknown>): Ec2OutboxRecord {
      const record = recordFor();
      const invocation = {
        ...record.invocation,
        kind: "task",
        payload: { conversationId: randomUUID(), prompt: "test it", ...payload },
      } as WorkerInvocation;
      const context = workflowPublicationContext(invocation);
      if (context !== undefined && invocation.kind === "publish") invocation.payload.publicationContextDigest = workflowPublicationContextDigest(context);
      return { ...record, invocation };
    }
    const postedPayload = (post: ReturnType<typeof delivery>["post"]) => (JSON.parse(post.mock.calls[0]![1].body) as { payload: Record<string, unknown> }).payload;

    it("parks a task before asking the worker which optional fields it supports", async () => {
      const workerFeatures = vi.fn(async () => ["model.chatgpt"]);
      const current = delivery({ workerFeatures, guardTaskDispatch: async () => "PARKED" });
      const record = taskRecord({ chatgpt: { model: { provider: "openai", modelId: "gpt-6.1-sol" } } });

      await expect(current.deliver(record, record.invocation)).resolves.toBe("WAITING_FOR_TASK_ACCESS");
      expect(workerFeatures).not.toHaveBeenCalled();
      expect(current.post).not.toHaveBeenCalled();
    });

    it("keeps a task's ChatGPT plan for a worker that can use it, and drops it for one that cannot, which runs the default (#341)", async () => {
      const chatgpt = { model: { provider: "openai", modelId: "gpt-6.1-sol" } };
      const model = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
      const current = delivery({ workerFeatures: async () => ["model.chatgpt"] });
      const record = taskRecord({ model, chatgpt });
      await current.deliver(record, record.invocation);
      expect(postedPayload(current.post)).toMatchObject({ model, chatgpt });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const older = delivery({ workerFeatures: async () => ["model.thinkingLevel"] });
      const again = taskRecord({ model, chatgpt });
      await older.deliver(again, again.invocation);
      expect(postedPayload(older.post)).not.toHaveProperty("chatgpt");
      expect(postedPayload(older.post).model).toEqual(model);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.chatgpt_omitted", reason: "worker-lacks-feature" }));
      log.mockRestore();
    });

    it("refuses feedback-approved implementation before POST unless the worker advertises approval authorization", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      const approval = {
        taskId: randomUUID(), requestId: randomUUID(), ownerId: "owner-1",
        decisionWorkflowRevision: 4, activeWorkflowRevision: 5,
        reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)],
        candidateDigest: "d".repeat(64), selectedFindingIds: ["finding-1"], selectedCommentIds: ["comment-1"],
      };
      const record = taskRecord({ workflowMode: "IMPLEMENT", workflowFeedbackApproval: approval });

      await expect(deliver(record, record.invocation)).rejects.toThrow(/feedback approval requires a compatible worker/);
      expect(post).not.toHaveBeenCalled();
    });

    it("sends feedback-approved implementation only to a worker advertising approval authorization", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowFeedbackApproval"] });
      const approval = {
        taskId: randomUUID(), requestId: randomUUID(), ownerId: "owner-1",
        decisionWorkflowRevision: 4, activeWorkflowRevision: 5,
        reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)],
        candidateDigest: "d".repeat(64), selectedFindingIds: ["finding-1"], selectedCommentIds: ["comment-1"],
      };
      const record = taskRecord({ workflowMode: "IMPLEMENT", workflowFeedbackApproval: approval });

      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(post).workflowFeedbackApproval).toEqual(approval);
    });

    it("refuses a pinned task base before POST unless the worker advertises it", async () => {
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const refused = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview"] });
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase });
      await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/workflow reviews need a worker that receives the task's pinned base commit/);
      expect(refused.post).not.toHaveBeenCalled();

      const accepted = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowBase"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).workflowBase).toEqual(workflowBase);
    });

    it("tells reviewers which checks ran only on a worker that lists it; an older worker reviews without that note", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewChecks = { reviewOnly: false, checks: [{ label: "Unit tests", command: "npm test (in repo/demo)" }] };
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewChecks });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowBase", "task.workflowReviewChecks"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewChecks).toEqual(workflowReviewChecks);
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowBase"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewChecks");
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_checks_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("gives reviewers the approved plan only on a worker that lists it; an older worker reviews without it and keeps the other fields", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewChecks = { reviewOnly: false, checks: [{ label: "Unit tests", command: "npm test (in repo/demo)" }] };
      const workflowReviewPlan = { markdown: "# Plan\n\nDo the thing.", sha256: "b".repeat(64) };
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewChecks, workflowReviewPlan });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase", "task.workflowReviewChecks"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewPlan"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewPlan).toEqual(workflowReviewPlan);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewPlan");
      expect(postedPayload(older.post).workflowReviewChecks).toEqual(workflowReviewChecks);
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_plan_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("gives reviewers the owner's approved PR feedback only on a worker that lists it; an older worker reviews without it and keeps the plan", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewPlan = { markdown: "# Plan\n\nDo the thing.", sha256: "b".repeat(64) };
      const workflowReviewFeedback = [{ summary: "Use the shorter sentence.", fileChanges: [{ repositoryId: "demo", path: "README.md", change: "Shorten it." }] }];
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewPlan, workflowReviewFeedback });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase", "task.workflowReviewPlan"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewFeedback"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewFeedback).toEqual(workflowReviewFeedback);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewFeedback");
      expect(postedPayload(older.post).workflowReviewPlan).toEqual(workflowReviewPlan);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_feedback_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("gives the reviewer note only to a worker that lists it; an older worker still receives the candidate-bound review", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewNote = "Inspect this exact retry note as untrusted context.";
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewNote });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewNote"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewNote).toBe(workflowReviewNote);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewNote");
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_note_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("never sends a stage with MCP context sources to a worker that does not list task.contextSources.v1: it is refused, not run without the team's sources, and the field is not dropped (lane E)", async () => {
      const record = taskRecord({ workflowMode: "PLAN", contextSources: true });
      const base = ["task.workflowMode"];
      const older = delivery({ workerFeatures: async () => base });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/out of date|upgrade/iu);
      expect(older.post).not.toHaveBeenCalled();
      const capable = delivery({ workerFeatures: async () => [...base, "task.contextSources.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).contextSources).toBe(true);
      // A stage of a project with no sources is delivered to either.
      const plain = taskRecord({ workflowMode: "PLAN" });
      const either = delivery({ workerFeatures: async () => base });
      expect(await either.deliver(plain, plain.invocation)).toBe("DELIVERED");
    });

    it("never sends a fix to an open pull request to a worker that does not list task.workflowFix: it is refused, not run as a first build, and the field is not dropped (Plan 6 Task 15)", async () => {
      const record = taskRecord({ workflowMode: "IMPLEMENT", workflowFix: { source: "ci" } });
      const base = ["task.workflowMode"];
      const older = delivery({ workerFeatures: async () => base });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/out of date|upgrade/iu);
      expect(older.post).not.toHaveBeenCalled();
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowFix"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowFix).toEqual({ source: "ci" });
      // An ordinary build is delivered to either.
      const build = taskRecord({ workflowMode: "IMPLEMENT" });
      const plain = delivery({ workerFeatures: async () => base });
      expect(await plain.deliver(build, build.invocation)).toBe("DELIVERED");
    });

    it("never sends an owner redirect to a worker that does not list task.ownerRedirect.v1: it is refused, not run without the re-approval stop, and the field is not dropped (live interaction R1)", async () => {
      const ownerRedirect = { messageId: "msg_0123456789abcdefghij", sender: "person p_a1b2c3", text: "use the retry helper" };
      const record = taskRecord({ workflowMode: "IMPLEMENT", ownerRedirect });
      const base = ["task.workflowMode"];
      const older = delivery({ workerFeatures: async () => base });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/out of date|upgrade/iu);
      expect(older.post).not.toHaveBeenCalled();
      const capable = delivery({ workerFeatures: async () => [...base, "task.ownerRedirect.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).ownerRedirect).toEqual(ownerRedirect);
      // An ordinary build is delivered to either.
      const build = taskRecord({ workflowMode: "IMPLEMENT" });
      const plain = delivery({ workerFeatures: async () => base });
      expect(await plain.deliver(build, build.invocation)).toBe("DELIVERED");
    });

    it("never sends a deep diagnosis to a worker that does not list task.diagnosis.v1: it is refused, not run as a setup draft, and the marker is not dropped (live interaction F3)", async () => {
      const diagnosis = { diagnosisId: "dgn_aaaaaaaaaaaaaaaaaaaa" };
      const record = taskRecord({ workflowMode: "SETUP_DRAFT", diagnosis });
      const base = ["task.workflowMode", "task.setupDraft", "task.setupProposal.v2"];
      const older = delivery({ workerFeatures: async () => base });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/out of date|upgrade/iu);
      expect(older.post).not.toHaveBeenCalled();
      const capable = delivery({ workerFeatures: async () => [...base, "task.diagnosis.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).diagnosis).toEqual(diagnosis);
      // A setup draft (no marker) is delivered to either.
      const draft = taskRecord({ workflowMode: "SETUP_DRAFT" });
      const plain = delivery({ workerFeatures: async () => base });
      expect(await plain.deliver(draft, draft.invocation)).toBe("DELIVERED");
    });

    it("sends a verification run that asks for evidence to a worker that lists task.evidenceCapture.v1 with the request, and to an older worker without it: the run goes on, no evidence is captured and the omission is recorded (wire-proof fix round 1)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const record = taskRecord({ workflowMode: "CHECKS", readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }], evidenceCapture: true });
      const base = ["task.workflowMode", "task.workflowChecks", "task.readiness"];
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("evidenceCapture");
      expect(postedPayload(older.post).readiness).toHaveLength(1);
      expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.includes("dispatch.evidence_capture_omitted") && line.includes("not_captured"))).toBe(true);
      // The same invocation, built while the switch was on, retried on the old worker again and then on a capable one: never failed, and the capable one gets the request.
      const again = delivery({ workerFeatures: async () => base });
      expect(await again.deliver(record, record.invocation)).toBe("DELIVERED");
      const capable = delivery({ workerFeatures: async () => [...base, "task.evidenceCapture.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).evidenceCapture).toBe(true);
      // A verification run that does not ask is delivered to either, as before.
      const plain = taskRecord({ workflowMode: "CHECKS", readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }] });
      expect(await delivery({ workerFeatures: async () => base }).deliver(plain, plain.invocation)).toBe("DELIVERED");
      log.mockRestore();
    });

    it("sends the test environment's plan to a worker that lists task.testEnvironment.v1 but not task.testEnvCoveragePath.v1 without the coveragePath (informational), and with it to one that lists both (S-2)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const plan = { revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test", coveragePath: "reports/coverage.xml" }, { id: "lint", kind: "lint" }] };
      const record = taskRecord({ workflowMode: "CHECKS", readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }, { cwd: "repo/demo", executable: "npm", args: ["run", "lint"], timeoutSeconds: 30 }], testEnvironment: plan });
      const base = ["task.workflowMode", "task.workflowChecks", "task.readiness", "task.testEnvironment.v1"];
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      const sent = postedPayload(older.post).testEnvironment as { checks: Array<Record<string, unknown>>; digest: string };
      expect(sent.checks).toEqual([{ id: "unit", kind: "test" }, { id: "lint", kind: "lint" }]);
      expect(sent.digest).toBe("d".repeat(64));
      expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.includes("dispatch.test_env_coverage_path_omitted"))).toBe(true);
      log.mockRestore();
      const capable = delivery({ workerFeatures: async () => [...base, "task.testEnvCoveragePath.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect((postedPayload(capable.post).testEnvironment as { checks: Array<Record<string, unknown>> }).checks[0]).toMatchObject({ coveragePath: "reports/coverage.xml" });
    });

    it("sends a setup draft that asks to detect the test environment to a worker that does not list task.testEnvDetect.v1 WITHOUT the field, and logs that detection did not run (wire-testenv fix round 1)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const record = taskRecord({ workflowMode: "SETUP_DRAFT", testEnvDetect: true });
      const base = ["task.workflowMode", "task.setupDraft", "task.setupProposal.v2"];
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("testEnvDetect");
      expect(postedPayload(older.post)).toMatchObject({ workflowMode: "SETUP_DRAFT" });
      expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.includes("dispatch.test_env_detect_omitted") && line.includes("\"detection\":\"not_run\""))).toBe(true);
      log.mockRestore();
      // The plan is not like that: running the checks without it would be misleading, so a worker without the feature is refused.
      const plan = taskRecord({ workflowMode: "CHECKS", readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }], testEnvironment: { revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }] } });
      const noPlan = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowChecks", "task.readiness"] });
      await expect(noPlan.deliver(plan, plan.invocation)).rejects.toThrow(/out of date|upgrade/iu);
      expect(noPlan.post).not.toHaveBeenCalled();
      const capable = delivery({ workerFeatures: async () => [...base, "task.testEnvDetect.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).testEnvDetect).toBe(true);
      // A setup draft that does not ask is delivered to either, as before.
      const plain = taskRecord({ workflowMode: "SETUP_DRAFT" });
      expect(await delivery({ workerFeatures: async () => base }).deliver(plain, plain.invocation)).toBe("DELIVERED");
    });

    it("sends a setup draft that is offered company recipes to a worker that does not list task.setupRecipes.v1 WITHOUT them, forgets the recorded offers and logs it; it does not fail the draft (SH30)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const offer = { recipeId: `rcp_${"1".repeat(20)}`, revision: 1, body: { schemaVersion: 1, label: "Python", buildSystems: ["python"], toolchains: [], setupCommands: [], updateCommands: [], checks: [], approvedHosts: [], match: { markerFiles: ["pyproject.toml"], registryHosts: [] } } };
      const record = taskRecord({ workflowMode: "SETUP_DRAFT", testEnvDetect: true, testEnvRecipes: [offer] });
      const base = ["task.workflowMode", "task.setupDraft", "task.setupProposal.v2", "task.testEnvDetect.v1"];
      const forget = vi.fn(async () => undefined);
      const older = delivery({ workerFeatures: async () => base, setupRecipesNotNegotiated: forget });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("testEnvRecipes");
      expect(postedPayload(older.post)).toMatchObject({ workflowMode: "SETUP_DRAFT", testEnvDetect: true });
      expect(forget).toHaveBeenCalledWith(record);
      expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.includes("dispatch.setup_recipes_omitted") && line.includes("worker-lacks-feature"))).toBe(true);
      // A worker with no detection cannot use recipes either, and is sent neither field.
      const noDetect = delivery({ workerFeatures: async () => ["task.workflowMode", "task.setupDraft", "task.setupProposal.v2", "task.setupRecipes.v1"], setupRecipesNotNegotiated: forget });
      expect(await noDetect.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(noDetect.post)).not.toHaveProperty("testEnvRecipes");
      expect(postedPayload(noDetect.post)).not.toHaveProperty("testEnvDetect");
      // An unwired recorder never fails the draft.
      const unwired = delivery({ workerFeatures: async () => base });
      expect(await unwired.deliver(record, record.invocation)).toBe("DELIVERED");
      log.mockRestore();
      // A worker that lists them is sent them, and nothing is forgotten.
      forget.mockClear();
      const capable = delivery({ workerFeatures: async () => [...base, "task.setupRecipes.v1"], setupRecipesNotNegotiated: forget });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).testEnvRecipes).toHaveLength(1);
      expect(forget).not.toHaveBeenCalled();
    });

    it("asks for the code review's risk level only on a worker that lists it; an older worker reviews as before (Plan 6 Task 13)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewRisk: true });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewRisk"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewRisk).toBe(true);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewRisk");
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_risk_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("sends the second reviewer only to a worker that lists task.workflowSecondReviewer.v1; an older worker is sent the review without the field and runs it as today (SR-1)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowSecondReviewer = { candidates: [{ model: { provider: "openrouter", modelId: "openai/gpt-5.5" } }] };
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowSecondReviewer });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowSecondReviewer.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowSecondReviewer).toEqual(workflowSecondReviewer);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowSecondReviewer");
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.second_reviewer_omitted", reason: "worker-lacks-feature", operationId: record.operationId }));
      // A review that asks for no second reviewer is delivered exactly as before to either.
      const plain = taskRecord({ workflowMode: "REVIEW", workflowBase });
      expect(postedPayload((await (async () => { const d = delivery({ workerFeatures: async () => base }); await d.deliver(plain, plain.invocation); return d; })()).post)).not.toHaveProperty("workflowSecondReviewer");
      log.mockRestore();
    });

    it("tells a planning run its document kind and structured format only on a worker that lists them; an older worker plans without them", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const record = taskRecord({ workflowMode: "PLAN", workflowPhase: "DESIGN", planFormat: "structured" });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post)).toMatchObject({ workflowPhase: "DESIGN", planFormat: "structured" });
      const older = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowPhase");
      expect(postedPayload(older.post)).not.toHaveProperty("planFormat");
      // A Quick plan carries only the format.
      const quick = taskRecord({ workflowMode: "PLAN", planFormat: "structured" });
      const olderQuick = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      expect(await olderQuick.deliver(quick, quick.invocation)).toBe("DELIVERED");
      expect(postedPayload(olderQuick.post)).not.toHaveProperty("planFormat");
      expect(postedPayload(older.post).workflowMode).toBe("PLAN");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.structured_plans_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("hands a version 2 application plan only to a worker that lists task.workflowE2EApplicationPlan; an older worker gets the portable-only prompt", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const context: FeatureE2EPlanningContext = { status: "available",
        source: { origin: "approved-setup", commitSha: "a".repeat(40), treeSha: "b".repeat(40), candidateDigest: "c".repeat(64),
          preparedCommitStatus: "UNKNOWN", preparedCommitSha: null, currentCheckoutUnverified: true },
        baselineScenarioIds: [], targets: [{ targetId: "web-1", applicationId: "orders", kind: "web", accountProfileId: "synthetic" }],
        runtimeRefs: [], unavailableTargetRefs: [], unavailableReasons: [], runtimeAccountRefs: [], portableOperations: [], mockFixtures: [], accountContextRefs: [],
        executableKinds: [{ kind: "web", steps: ["navigate", "click"], assertions: ["visible"] }] };
      const asked = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: context });
      const portable = planDocumentInstructions({ kind: "plan", path: "QUICK", e2ePlanningContext: context, applicationPlans: false });
      const wrap = (instructions: string) => `Planning phase only.\n\n${instructions}\n\nRequest:\nadd it`;
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", workflowE2EPlanVersion: 2, prompt: wrap(asked) });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.workflowE2EApplicationPlan"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post)).toMatchObject({ workflowE2EPlanVersion: 2, prompt: wrap(asked) });
      expect(capable.applicationPlanNotNegotiated).not.toHaveBeenCalled();
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      // The operation record must stop saying the plan version was offered, before the worker runs (Ruling AW).
      expect(older.applicationPlanNotNegotiated).toHaveBeenCalledTimes(1);
      expect(older.applicationPlanNotNegotiated).toHaveBeenCalledWith(record);
      expect(postedPayload(older.post)).not.toHaveProperty("workflowE2EPlanVersion");
      expect(postedPayload(older.post).prompt).toBe(wrap(portable));
      expect(postedPayload(older.post)).toMatchObject({ workflowMode: "PLAN", planFormat: "structured" });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.application_plan_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    describe("application E2E admissions (Ruling BQ, mixed fleet)", () => {
      const admission = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, taskId: randomUUID(), workflowRevision: 3, candidateDigest: "a".repeat(64), roundId: randomUUID(), groupRunIds: [randomUUID()],
        admissionRef: { key: `workflow-e2e-admissions/sha256/${"b".repeat(64)}.json`, sha256: "b".repeat(64), byteLength: 100 }, ...extra });
      const checks = (ref: unknown) => taskRecord({ workflowMode: "CHECKS", readiness: [], workflowE2EAdmission: ref });
      const checksFeatures = ["task.workflowMode", "task.workflowChecks", "task.readiness", "task.workflowE2EAdmission"];

      it("never sends an application admission to a worker that does not list task.workflowE2EApplicationChecks, and says why", async () => {
        const record = checks(admission({ kind: "application" }));
        const older = delivery({ workerFeatures: async () => checksFeatures });
        const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
        expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
        expect(refusal?.message).toContain("task.workflowE2EApplicationChecks");
        expect(older.post).not.toHaveBeenCalled();
      });

      it("fails closed for an application admission when the worker cannot be asked which features it lists", async () => {
        const record = checks(admission({ kind: "application" }));
        const unprobed = delivery();
        await expect(unprobed.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
        expect(unprobed.post).not.toHaveBeenCalled();
        const failing = delivery({ workerFeatures: async () => { throw new Error("ping down"); } });
        await expect(failing.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
        expect(failing.post).not.toHaveBeenCalled();
      });

      it("hands an application admission, unchanged, to a worker that lists the feature", async () => {
        const ref = admission({ kind: "application" });
        const record = checks(ref);
        const capable = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
        expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
      });

      it("never sends a round with AI navigation steps to a worker that does not list task.workflowE2EAgentSteps.v1, and says why (M1.4 Task 4.2)", async () => {
        const record = checks(admission({ kind: "application", agentSteps: true }));
        const noAgents = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks"] });
        const refusal = await noAgents.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
        expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
        expect(refusal?.message).toContain("This worker can't run AI navigation steps yet; retry once it restarts");
        expect(noAgents.post).not.toHaveBeenCalled();
      });

      it("hands a round with AI navigation steps, unchanged, to a worker that lists the agent-steps feature", async () => {
        const ref = admission({ kind: "application", agentSteps: true });
        const record = checks(ref);
        const capable = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks", "task.workflowE2EAgentSteps.v1", "task.workflowE2EMidStepSync.v1"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
        expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
      });

      it("never sends a round whose capture policy uses a strip or API samples to a worker that does not list task.workflowE2ECaptureExtras.v1, and says why (proof and evidence I6)", async () => {
        const record = checks(admission({ kind: "application", captureExtras: true }));
        const older = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks"] });
        const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
        expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
        expect(refusal?.message).toContain("screenshot strips or API samples");
        expect(older.post).not.toHaveBeenCalled();
      });

      it("hands a round with capture extras, unchanged, to a worker that lists the feature, and a round without them to an older worker as before (I6)", async () => {
        const ref = admission({ kind: "application", captureExtras: true });
        const capable = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks", "task.workflowE2ECaptureExtras.v1"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        expect(await capable.deliver(checks(ref), checks(ref).invocation)).toBe("DELIVERED");
        expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
        const plain = admission({ kind: "application" });
        const older = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        expect(await older.deliver(checks(plain), checks(plain).invocation)).toBe("DELIVERED");
      });

      it("fails closed for a round with capture extras when the worker cannot be asked which features it lists (I6)", async () => {
        const record = checks(admission({ kind: "application", captureExtras: true }));
        await expect(delivery().deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      });

      it("never sends a round with AI navigation steps to a worker that lists agent steps but not task.workflowE2EMidStepSync.v1 (MIDSTEPCOOKIE: a scan a step old), and says why", async () => {
        const ref = admission({ kind: "application", agentSteps: true });
        const record = checks(ref);
        const beforeSync = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks", "task.workflowE2EAgentSteps.v1"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        const refusal = await beforeSync.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
        expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
        expect(refusal?.message).toContain("This worker can't protect session values during AI navigation steps yet");
        expect(beforeSync.post).not.toHaveBeenCalled();
        // A round with no AI navigation step does not need it.
        const plain = admission({ kind: "application" });
        const plainRecord = checks(plain);
        const older = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        expect(await older.deliver(plainRecord, plainRecord.invocation)).toBe("DELIVERED");
      });

      describe("a chosen AI navigation model or the minimal request shape (M1.4 Task 4.10A, test 15)", () => {
        const APPLICATION = "workflow-e2e-application-admission/v1";
        const MESSAGE = "agent-route-not-approved: this worker is too old for the chosen AI navigation model";
        const withAgents = [...checksFeatures, "task.workflowE2EApplicationChecks", "task.workflowE2EAgentSteps.v1", "task.workflowE2EMidStepSync.v1"];
        const withChoice = [...withAgents, "task.workflowE2EAgentModelChoice.v1"];
        const dependenciesFor = (needs: boolean | undefined | Error, features: string[]) => ({
          workerFeatures: async () => features, workflowE2EAdmissionSchemaVersion: async () => APPLICATION, workflowE2EAdmissionUsesAgentSteps: async () => true,
          workflowE2EAdmissionNeedsModelChoice: vi.fn(async () => { if (needs instanceof Error) throw needs; return needs; }),
        });
        const round = () => { const ref = admission({ kind: "application", agentSteps: true }); return { ref, record: checks(ref) }; };

        it("refuses a non-recommended or minimal route to a worker that does not list task.workflowE2EAgentModelChoice.v1, with the fixed detail and nothing sent", async () => {
          const { record } = round();
          const dependencies = dependenciesFor(true, withAgents);
          const older = delivery(dependencies);
          const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refusal?.message).toContain(MESSAGE);
          expect(older.post).not.toHaveBeenCalled();
          expect(dependencies.workflowE2EAdmissionNeedsModelChoice).toHaveBeenCalledTimes(1);
        });

        it("delivers the same route, unchanged, to a worker that lists the feature (positive control)", async () => {
          const { ref, record } = round();
          const capable = delivery(dependenciesFor(true, withChoice));
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
        });

        it("still delivers Rovara's recommended route in the standard shape to a worker without the feature, so the older fleet keeps working", async () => {
          const { ref, record } = round();
          const older = delivery(dependenciesFor(false, withAgents));
          expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(older.post).workflowE2EAdmission).toEqual(ref);
        });

        it("fails closed when the route cannot be read: an unreadable route is never assumed to be the default", async () => {
          for (const needs of [undefined, new Error("ddb down")]) {
            const { record } = round();
            const unreadable = delivery(dependenciesFor(needs, withAgents));
            await expect(unreadable.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(MESSAGE) as unknown });
            expect(unreadable.post).not.toHaveBeenCalled();
          }
        });

        it("does not look at the route when the worker lists the feature or the round has no AI navigation step", async () => {
          const { record } = round();
          const dependencies = dependenciesFor(true, withChoice);
          await delivery(dependencies).deliver(record, record.invocation);
          expect(dependencies.workflowE2EAdmissionNeedsModelChoice).not.toHaveBeenCalled();
          const plain = checks(admission({ kind: "application" }));
          const noAgents = { ...dependenciesFor(true, [...checksFeatures, "task.workflowE2EApplicationChecks"]), workflowE2EAdmissionUsesAgentSteps: async () => false };
          expect(await delivery(noAgents).deliver(plain, plain.invocation)).toBe("DELIVERED");
          expect(noAgents.workflowE2EAdmissionNeedsModelChoice).not.toHaveBeenCalled();
        });
      });

      describe("the reference's agentSteps flag against the admission it names (checked before delivery)", () => {
        const withAgents = [...checksFeatures, "task.workflowE2EApplicationChecks", "task.workflowE2EAgentSteps.v1", "task.workflowE2EMidStepSync.v1"];
        const APPLICATION = "workflow-e2e-application-admission/v1";
        const dependenciesFor = (usesAgentSteps: boolean | undefined | Error, features = withAgents) => ({
          workerFeatures: async () => features, workflowE2EAdmissionSchemaVersion: async () => APPLICATION,
          workflowE2EAdmissionUsesAgentSteps: vi.fn(async () => { if (usesAgentSteps instanceof Error) throw usesAgentSteps; return usesAgentSteps; }),
        });

        it("refuses a reference without agentSteps whose admission has an agent step, so the worker feature gate cannot be skipped", async () => {
          const record = checks(admission({ kind: "application" }));
          const unflagged = delivery(dependenciesFor(true));
          await expect(unflagged.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("agentSteps") as unknown });
          expect(unflagged.post).not.toHaveBeenCalled();
        });

        it("refuses a reference marked agentSteps whose admission has none", async () => {
          const record = checks(admission({ kind: "application", agentSteps: true }));
          const overstated = delivery(dependenciesFor(false));
          await expect(overstated.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("agentSteps") as unknown });
          expect(overstated.post).not.toHaveBeenCalled();
        });

        it("fails closed, retryably, when the admission cannot be read for its agent steps", async () => {
          const record = checks(admission({ kind: "application" }));
          for (const unreadable of [undefined, new Error("s3 down")]) {
            const attempt = delivery(dependenciesFor(unreadable));
            await expect(attempt.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
            expect(attempt.post).not.toHaveBeenCalled();
          }
        });

        it("delivers a reference whose flag matches its admission, with and without agent steps", async () => {
          const flagged = checks(admission({ kind: "application", agentSteps: true }));
          expect(await delivery(dependenciesFor(true)).deliver(flagged, flagged.invocation)).toBe("DELIVERED");
          const plain = checks(admission({ kind: "application" }));
          expect(await delivery(dependenciesFor(false)).deliver(plain, plain.invocation)).toBe("DELIVERED");
        });
      });

      // Evaluation fix RUN-1, fix round 1 (Ruling DV): a round whose no-agent groups rely on the normal time limits (a route-pinned policy's round with a group that has no agent step) goes only to a
      // worker that lists task.workflowE2EModelFreeLimits.v1. An older worker would compile those groups under 60 s and 10 s and refuse the admission after compute was spent.
      describe("a round that relies on the normal no-model limits (RUN-1, Ruling DV)", () => {
        const APPLICATION = "workflow-e2e-application-admission/v1";
        const FEATURE = "task.workflowE2EModelFreeLimits.v1";
        const base = [...checksFeatures, "task.workflowE2EApplicationChecks"];
        const dependenciesFor = (relies: boolean | undefined | Error, features: string[]) => ({
          workerFeatures: async () => features, workflowE2EAdmissionSchemaVersion: async () => APPLICATION,
          workflowE2EAdmissionNeedsModelFreeLimits: vi.fn(async () => { if (relies instanceof Error) throw relies; return relies; }),
        });

        it("never sends it to a worker that does not list the feature, and says why, before anything runs", async () => {
          const record = checks(admission({ kind: "application" }));
          const older = delivery(dependenciesFor(true, base));
          const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refusal?.message).toContain(FEATURE);
          expect(older.post).not.toHaveBeenCalled();
        });

        it("hands it, unchanged, to a worker that lists the feature", async () => {
          const ref = admission({ kind: "application" });
          const record = checks(ref);
          const capable = delivery(dependenciesFor(true, [...base, FEATURE]));
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
        });

        it("does not ask for the feature of a round that does not rely on the limits, so an older worker still runs it", async () => {
          const record = checks(admission({ kind: "application" }));
          const older = delivery(dependenciesFor(false, base));
          expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
        });

        it("fails closed, retryably, when the admission cannot be read for the limits it relies on", async () => {
          const record = checks(admission({ kind: "application" }));
          for (const unreadable of [undefined, new Error("s3 down")]) {
            const attempt = delivery(dependenciesFor(unreadable, [...base, FEATURE]));
            await expect(attempt.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
            expect(attempt.post).not.toHaveBeenCalled();
          }
        });
      });

      it("does not ask for the agent-steps feature when no group has an agent step", async () => {
        const record = checks(admission({ kind: "application" }));
        const capable = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks"], workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
        expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      });

      it("still hands a portable admission to a worker that predates application CHECKS", async () => {
        const ref = admission();
        const record = checks(ref);
        const older = delivery({ workerFeatures: async () => checksFeatures });
        expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
        expect(postedPayload(older.post).workflowE2EAdmission).toEqual(ref);
      });

      describe("the reference's kind against the admission it names (checked before delivery)", () => {
        const APPLICATION = "workflow-e2e-application-admission/v1";
        const PORTABLE = "workflow-e2e-admission/v1";
        const capable = [...checksFeatures, "task.workflowE2EApplicationChecks"];
        const withSchema = (schema: string | undefined | Error) => vi.fn(async () => { if (schema instanceof Error) throw schema; return schema; });

        it("refuses a reference without kind whose admission is an application admission, and sends nothing", async () => {
          const record = checks(admission());
          const reader = withSchema(APPLICATION);
          const unmarked = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: reader });
          await expect(unmarked.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("kind") as unknown });
          expect(reader).toHaveBeenCalledTimes(1);
          expect(unmarked.post).not.toHaveBeenCalled();
        });

        it("refuses a reference marked application whose admission is a portable one, and sends nothing", async () => {
          const record = checks(admission({ kind: "application" }));
          const marked = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: withSchema(PORTABLE) });
          await expect(marked.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
          expect(marked.post).not.toHaveBeenCalled();
        });

        it("delivers when the kind and the admission agree, application or portable", async () => {
          const app = checks(admission({ kind: "application" }));
          const one = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: withSchema(APPLICATION) });
          expect(await one.deliver(app, app.invocation)).toBe("DELIVERED");
          const portable = checks(admission());
          const two = delivery({ workerFeatures: async () => checksFeatures, workflowE2EAdmissionSchemaVersion: withSchema(PORTABLE) });
          expect(await two.deliver(portable, portable.invocation)).toBe("DELIVERED");
        });

        it("fails closed, retryably, when the admission cannot be read or is not one it knows", async () => {
          const record = checks(admission());
          for (const schema of [undefined, new Error("s3 down")]) {
            const unreadable = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: withSchema(schema) });
            await expect(unreadable.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
            expect(unreadable.post).not.toHaveBeenCalled();
          }
          const unknown = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: withSchema("something-else/v1") });
          await expect(unknown.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
        });

        describe("version 2 admissions, which key the runtime rows by profile and kind (Task 3.4)", () => {
          const V2 = "workflow-e2e-application-admission/v2";
          const SENTENCE = "This worker can't run combined browser and API checks yet; retry once it restarts.";
          const v2Capable = [...capable, "task.workflowE2EApplicationChecks.v2"];

          it("never sends a version 2 admission to a worker that lacks task.workflowE2EApplicationChecks.v2, and says so in one plain sentence", async () => {
            const record = checks(admission({ kind: "application" }));
            const older = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: withSchema(V2) });
            const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
            expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
            expect(refusal?.message).toBe(`RUNTIME_UNAVAILABLE: ${SENTENCE}`);
            expect(older.post).not.toHaveBeenCalled();
            // A baseline round is an application round too: its version 2 admission is held to the same rule.
            const baseline = checks(admission({ kind: "application", purpose: "baseline", baseCommitSha: "c".repeat(40), attempt: 1 }));
            const olderBaseline = delivery({ workerFeatures: async () => [...capable, "task.workflowE2EBaselineChecks"], workflowE2EAdmissionSchemaVersion: withSchema(V2) });
            await expect(olderBaseline.deliver(baseline, baseline.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${SENTENCE}` });
            expect(olderBaseline.post).not.toHaveBeenCalled();
          });

          it("fails closed when no schema reader is wired: an application admission is treated as version 2, so a worker without .v2 is refused and no round is sent", async () => {
            const record = checks(admission({ kind: "application" }));
            const unread = delivery({ workerFeatures: async () => capable });
            await expect(unread.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${SENTENCE}` });
            expect(unread.post).not.toHaveBeenCalled();
          });

          it("hands a version 2 admission, unchanged, to a worker that lists both features", async () => {
            const ref = admission({ kind: "application" });
            const record = checks(ref);
            const current = delivery({ workerFeatures: async () => v2Capable, workflowE2EAdmissionSchemaVersion: withSchema(V2) });
            expect(await current.deliver(record, record.invocation)).toBe("DELIVERED");
            expect(postedPayload(current.post).workflowE2EAdmission).toEqual(ref);
          });

          it("still hands a version 1 admission (stored before the change) to a worker that lists only task.workflowE2EApplicationChecks", async () => {
            const record = checks(admission({ kind: "application" }));
            const older = delivery({ workerFeatures: async () => capable, workflowE2EAdmissionSchemaVersion: withSchema(APPLICATION) });
            expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
          });

          it("does not take the feature for a version 2 reader: a worker that lists only the version 2 string is still refused, since it does not run application admissions at all", async () => {
            const record = checks(admission({ kind: "application" }));
            const odd = delivery({ workerFeatures: async () => [...checksFeatures, "task.workflowE2EApplicationChecks.v2"], workflowE2EAdmissionSchemaVersion: withSchema(V2) });
            await expect(odd.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
            expect(odd.post).not.toHaveBeenCalled();
          });
        });

        it("reads no admission for an invocation that carries none", async () => {
          const reader = withSchema(APPLICATION);
          const plain = taskRecord({});
          const d = delivery({ workflowE2EAdmissionSchemaVersion: reader });
          await d.deliver(plain, plain.invocation);
          expect(reader).not.toHaveBeenCalled();
        });
      });

      it("is advertised by the worker's own /ping feature list", () => {
        expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EApplicationChecks");
        expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EApplicationChecks.v2");
      });

      // M1.4 Task 4.6b, test 18: a replay (no model) goes only to a worker that lists task.workflowE2EReplayChecks.v1; an older worker is never handed one.
      describe("audit replay rounds (Task 4.6b)", () => {
        const replayRef = () => admission({ kind: "application", purpose: "replay", sourceRoundId: "5".repeat(8) + "-5555-4555-8555-" + "5".repeat(12), attempt: 1 });
        const applicationOnly = [...checksFeatures, "task.workflowE2EApplicationChecks"];
        const withReplay = [...applicationOnly, "task.workflowE2EReplayChecks.v1"];
        const schema = async () => "workflow-e2e-application-admission/v1";

        it("never sends a replay admission to a worker that runs application admissions (even AI navigation steps and baselines) but does not list the replay feature, and says why", async () => {
          const record = checks(replayRef());
          const older = delivery({ workerFeatures: async () => [...applicationOnly, "task.workflowE2EBaselineChecks", "task.workflowE2EAgentSteps.v1", "task.workflowE2EMidStepSync.v1"], workflowE2EAdmissionSchemaVersion: schema });
          const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refusal?.message).toContain("task.workflowE2EReplayChecks.v1");
          expect(refusal?.message).toMatch(/replay/i);
          expect(older.post).not.toHaveBeenCalled();
        });

        it("hands a replay admission, unchanged, to a worker that lists the feature (and needs no agent-steps feature: a replay has no model), and other admissions still go as before", async () => {
          const ref = replayRef();
          const record = checks(ref);
          const capable = delivery({ workerFeatures: async () => withReplay, workflowE2EAdmissionSchemaVersion: schema });
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
          const candidate = checks(admission({ kind: "application" }));
          const older = delivery({ workerFeatures: async () => applicationOnly, workflowE2EAdmissionSchemaVersion: schema });
          expect(await older.deliver(candidate, candidate.invocation)).toBe("DELIVERED");
        });

        it("fails closed for a replay admission when the worker cannot be asked which features it lists", async () => {
          const record = checks(replayRef());
          const failing = delivery({ workerFeatures: async () => { throw new Error("ping down"); } });
          await expect(failing.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
          expect(failing.post).not.toHaveBeenCalled();
        });

        it("is advertised by the worker's own /ping feature list", () => {
          expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EReplayChecks.v1");
        });
      });

      describe("baseline rounds (Task 3.7b)", () => {
        const baselineRef = () => admission({ kind: "application", purpose: "baseline", baseCommitSha: "c".repeat(40), attempt: 1 });
        const applicationOnly = [...checksFeatures, "task.workflowE2EApplicationChecks"];
        const withBaseline = [...applicationOnly, "task.workflowE2EBaselineChecks"];

        it("never sends a baseline admission to a worker that runs application admissions but not baseline rounds, and says why", async () => {
          const record = checks(baselineRef());
          const older = delivery({ workerFeatures: async () => applicationOnly, workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
          const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refusal?.message).toContain("task.workflowE2EBaselineChecks");
          expect(refusal?.message).toMatch(/baseline/i);
          expect(older.post).not.toHaveBeenCalled();
        });

        it("hands a baseline admission, unchanged, to a worker that lists the feature, and a candidate admission still goes to one that lists only application CHECKS", async () => {
          const ref = baselineRef();
          const record = checks(ref);
          const capable = delivery({ workerFeatures: async () => withBaseline, workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
          const candidate = checks(admission({ kind: "application" }));
          const older = delivery({ workerFeatures: async () => applicationOnly, workflowE2EAdmissionSchemaVersion: async () => "workflow-e2e-application-admission/v1" });
          expect(await older.deliver(candidate, candidate.invocation)).toBe("DELIVERED");
        });

        it("fails closed for a baseline admission when the worker cannot be asked which features it lists", async () => {
          const record = checks(baselineRef());
          const failing = delivery({ workerFeatures: async () => { throw new Error("ping down"); } });
          await expect(failing.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
          expect(failing.post).not.toHaveBeenCalled();
        });

        it("asks a coding run to export the unchanged code only of a worker that can, and otherwise delivers the run without the request (a baseline never stops the coding)", async () => {
          const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
          const record = taskRecord({ workflowMode: "IMPLEMENT", workflowE2EBaselineSource: true });
          // The executor image is not on the host, so the application and baseline CHECKS features are withheld; the export needs the repository alone (review 3.7b finding 5).
          const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowE2EBaselineSource"] });
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post)).toMatchObject({ workflowMode: "IMPLEMENT", workflowE2EBaselineSource: true });
          const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowE2EBaselineChecks"] });
          expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(older.post)).not.toHaveProperty("workflowE2EBaselineSource");
          expect(postedPayload(older.post)).toMatchObject({ workflowMode: "IMPLEMENT" });
          expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
            event: "dispatch.baseline_source_omitted", reason: "worker-lacks-feature", operationId: record.operationId }));
          log.mockRestore();
        });

        it("is advertised by the worker's own /ping feature list", () => {
          expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EBaselineChecks");
          expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EBaselineSource");
        });
      });

      describe("grounding rounds (T7b)", () => {
        const groundingRef = () => admission({ kind: "application", purpose: "grounding", baseCommitSha: "c".repeat(40), attempt: 1, planArtifactSha256: "9".repeat(64) });
        const applicationOnly = [...checksFeatures, "task.workflowE2EApplicationChecks"];
        const withGrounding = [...applicationOnly, "task.workflowE2EGroundingChecks.v1"];
        const v2 = async () => "workflow-e2e-application-admission/v1";

        it("never sends a grounding admission to a worker that runs application admissions but not grounding rounds, and says why", async () => {
          const record = checks(groundingRef());
          const older = delivery({ workerFeatures: async () => [...applicationOnly, "task.workflowE2EBaselineChecks"], workflowE2EAdmissionSchemaVersion: v2 });
          const refusal = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refusal?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refusal?.message).toContain("task.workflowE2EGroundingChecks.v1");
          expect(older.post).not.toHaveBeenCalled();
        });

        it("hands a grounding admission, unchanged, to a worker that lists the feature", async () => {
          const ref = groundingRef();
          const record = checks(ref);
          const capable = delivery({ workerFeatures: async () => withGrounding, workflowE2EAdmissionSchemaVersion: v2 });
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post).workflowE2EAdmission).toEqual(ref);
        });

        it("fails closed for a grounding admission when the worker cannot be asked which features it lists", async () => {
          const record = checks(groundingRef());
          const failing = delivery({ workerFeatures: async () => { throw new Error("ping down"); } });
          await expect(failing.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
          expect(failing.post).not.toHaveBeenCalled();
        });

        it("asks a coding plan run to export the unchanged code only of a worker that can, and only while the run still negotiates the application plan", async () => {
          const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
          const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", workflowE2EPlanVersion: 2, workflowE2EGroundingSource: true });
          const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.workflowE2EApplicationPlan", "task.workflowE2EGroundingChecks.v1"] });
          expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(capable.post)).toMatchObject({ workflowMode: "PLAN", workflowE2EPlanVersion: 2, workflowE2EGroundingSource: true });
          // A worker without the grounding feature is sent the plan run without the request.
          const noGrounding = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.workflowE2EApplicationPlan"] });
          expect(await noGrounding.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(noGrounding.post)).not.toHaveProperty("workflowE2EGroundingSource");
          expect(postedPayload(noGrounding.post)).toMatchObject({ workflowE2EPlanVersion: 2 });
          // A worker that lists the grounding feature but not the application plan has the plan version removed, and the request goes with it (the schema refuses one without the other).
          const noPlans = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.workflowE2EGroundingChecks.v1"] });
          expect(await noPlans.deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedPayload(noPlans.post)).not.toHaveProperty("workflowE2EPlanVersion");
          expect(postedPayload(noPlans.post)).not.toHaveProperty("workflowE2EGroundingSource");
          expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.grounding_source_omitted", operationId: record.operationId }));
          log.mockRestore();
        });
      });
    });

    it("refuses to downgrade a version 2 application plan when no applicationPlanNotNegotiated recorder is wired, instead of posting a run the operation record still calls version 2 (2.2b N4)", async () => {
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", workflowE2EPlanVersion: 2 });
      const unwired = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] }, ["applicationPlanNotNegotiated"]);
      await expect(unwired.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(unwired.post).not.toHaveBeenCalled();
    });

    it("sends an ordinary portable structured plan unchanged to a worker without the application plan feature", async () => {
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured" });
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).toMatchObject({ workflowMode: "PLAN", planFormat: "structured" });
      expect(postedPayload(older.post)).not.toHaveProperty("workflowE2EPlanVersion");
    });

    it("never hands a version 2 intent in the reviewers' approved plan to a worker that cannot parse it", async () => {
      const sha256 = "a".repeat(64);
      const v1 = { schemaVersion: 1, requestedTargetIds: ["web-1"], accountContextRefs: [], scenarios: [], semanticExportDeltas: [] };
      const v2 = { ...v1, schemaVersion: 2, applicationRuntimeRefs: [], runtimeAccountRefs: [] };
      const review = (e2eIntent: unknown) => taskRecord({ workflowMode: "REVIEW", workflowReviewPlan: { markdown: "Plan", sha256, e2eIntent } });
      const features = ["task.workflowMode", "task.workflowReview", "task.workflowReviewPlan"];
      const older = delivery({ workerFeatures: async () => features });
      const withV2 = review(v2);
      expect(await older.deliver(withV2, withV2.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post).workflowReviewPlan).toEqual({ markdown: "Plan", sha256 });
      const capable = delivery({ workerFeatures: async () => [...features, "task.workflowE2EApplicationPlan"] });
      expect(await capable.deliver(withV2, withV2.invocation)).toBe("DELIVERED");
      expect((postedPayload(capable.post).workflowReviewPlan as { e2eIntent: unknown }).e2eIntent).toEqual(v2);
      // A v1 intent is carried exactly as before, whatever the worker advertises.
      const withV1 = review(v1);
      const olderV1 = delivery({ workerFeatures: async () => features });
      expect(await olderV1.deliver(withV1, withV1.invocation)).toBe("DELIVERED");
      expect((postedPayload(olderV1.post).workflowReviewPlan as { e2eIntent: unknown }).e2eIntent).toEqual(v1);
    });

    it("asks a planning run for anchor lines only on a worker that lists task.codeAnchors; an older worker is sent the prompt without them", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const anchored = planDocumentInstructions({ kind: "plan", path: "QUICK", anchors: true });
      const plain = planDocumentInstructions({ kind: "plan", path: "QUICK" });
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", prompt: `Planning phase only.\n\n${anchored}\n\nRequest:\nadd it` });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.codeAnchors"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).prompt).toContain("anchor?: string");
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post).prompt).toBe(`Planning phase only.\n\n${plain}\n\nRequest:\nadd it`);
      expect(postedPayload(older.post)).toMatchObject({ planFormat: "structured" });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.code_anchors_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("asks a planning run for the plan quality members only on a worker that lists task.workflowPlanDryRun.v1; an older worker is sent the prompt without them", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const asked = planDocumentInstructions({ kind: "plan", path: "QUICK", planQuality: true });
      const plain = planDocumentInstructions({ kind: "plan", path: "QUICK" });
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", prompt: `Planning phase only.\n\n${asked}\n\nRequest:\nadd it` });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.workflowPlanDryRun.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).prompt).toContain("scenarioProves");
      expect(capable.planQualityNotNegotiated).not.toHaveBeenCalled();
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post).prompt).toBe(`Planning phase only.\n\n${plain}\n\nRequest:\nadd it`);
      // The operation record is told, so the broker never sends that planner a revision naming the members.
      expect(older.planQualityNotNegotiated).toHaveBeenCalledWith(record);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.plan_quality_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("refuses to send a planning run without the plan quality members to an older worker when no planQualityNotNegotiated recorder is wired, instead of a run the operation record still calls asked", async () => {
      const asked = planDocumentInstructions({ kind: "plan", path: "QUICK", planQuality: true });
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", prompt: `Planning phase only.\n\n${asked}\n\nRequest:\nadd it` });
      // The older worker would be sent the prompt without the members, and a revision would then name members its strict parser rejects: nothing goes out.
      const unwired = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] }, ["planQualityNotNegotiated"]);
      await expect(unwired.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(unwired.post).not.toHaveBeenCalled();
      // A worker that lists the feature is sent the guidance as asked and needs no recorder.
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.workflowPlanDryRun.v1"] }, ["planQualityNotNegotiated"]);
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).prompt).toContain("scenarioProves");
    });

    it("sends a workflow mode only to a worker that advertises the read-only tool boundary", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      const record = taskRecord({ workflowMode: "PLAN" });
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(post).workflowMode).toBe("PLAN");
    });

    it("sends the Understand and plan-critic modes only to a worker that lists their feature, and never drops the mode (Rovara Code v2)", async () => {
      for (const [workflowMode, feature] of [["UNDERSTAND", "task.workflowUnderstand"], ["PLAN_CRITIQUE", "task.workflowPlanCritique"]] as const) {
        const record = taskRecord({ workflowMode });
        const older = delivery({ workerFeatures: async () => ["task.workflowMode"] });
        await expect(older.deliver(record, record.invocation)).rejects.toThrow(/needs a newer worker/);
        expect(older.post).not.toHaveBeenCalled();
        // The other new feature is not enough.
        const other = delivery({ workerFeatures: async () => ["task.workflowMode", feature === "task.workflowUnderstand" ? "task.workflowPlanCritique" : "task.workflowUnderstand"] });
        await expect(other.deliver(record, record.invocation)).rejects.toThrow(/needs a newer worker/);
        const capable = delivery({ workerFeatures: async () => ["task.workflowMode", feature] });
        expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
        expect(postedPayload(capable.post).workflowMode).toBe(workflowMode);
      }
    });

    it("refuses workflow dispatch when a worker cannot prove it enforces the requested tool boundary", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => [] });
      const record = taskRecord({ workflowMode: "PLAN" });
      await expect(deliver(record, record.invocation)).rejects.toThrow(/workflow mode requires a compatible worker/);
      expect(post).not.toHaveBeenCalled();
    });

    it("refuses a graph-aware invocation when the worker does not advertise the exact feature and never strips the graph", async () => {
      const graph = { schemaVersion: 1 as const, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items: [
        { id: "11111111-1111-4111-8111-111111111111", title: "One", description: "First.", repository: "repo", dependsOn: [] },
      ] };
      const workflowDependencies = { graph, approval: {
        artifactDigest: "a".repeat(64), graphDigest: taskGraphDigest(graph), workflowRevision: 2,
        actorId: "b".repeat(64), runId: "8c330a74-b4c6-4f01-9356-5fe54fc55b21",
      } };
      const record = taskRecord({ workflowMode: "IMPLEMENT", workflowDependencies });
      const older = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/ordered work requires a compatible worker/);
      expect(older.post).not.toHaveBeenCalled();

      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowDependencies"] });
      await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowDependencies).toEqual(workflowDependencies);
    });

    it("never drops the reviews a review step asked for: a worker that cannot run just those is refused", async () => {
      const record = taskRecord({ workflowMode: "REVIEW", workflowReviewers: ["SECURITY"] });
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview"] });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/runs just the reviews it is asked for/);
      expect(older.post).not.toHaveBeenCalled();
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowReviewers"] });
      await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewers).toEqual(["SECURITY"]);
    });

    describe("agent steps and model routes (Plan 3, Task 16a)", () => {
      const NEWER_WORKER = "This agent needs a newer worker. Ask an admin to upgrade Rovara.";
      const refusal = { code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${NEWER_WORKER}` };
      const coding = { kind: "coding", agentId: "code-reviewer", version: 2, stepId: "review", tools: ["read"], promptSection: "From Reviewer:\nBe strict." };
      const agent = { kind: "agent", agentId: "ticket-triage", version: 1, stepId: "triage", instructions: "Be brief.", workspace: "none", inputs: "Request:\nGo." };
      const modelRoute = { alias: "org.src.model", api: "openai-responses", catalog: "gpt-6" };

      it("refuses an agent step on a worker that lacks task.agentStep, never dropping the field", async () => {
        const record = taskRecord({ agentStep: coding });
        for (const features of [[], ["task.workflowMode", "task.agentRun", "model.route"]]) {
          const older = delivery({ workerFeatures: async () => features });
          await expect(older.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
          expect(older.post).not.toHaveBeenCalled();
        }
        const unprobed = delivery();
        await expect(unprobed.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
        expect(unprobed.post).not.toHaveBeenCalled();
      });

      it("sends a coding step unchanged to a worker that lists task.agentStep", async () => {
        const record = taskRecord({ agentStep: coding });
        const capable = delivery({ workerFeatures: async () => ["task.agentStep"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).agentStep).toEqual(coding);
      });

      it("needs task.agentRun as well for the agent kind", async () => {
        const record = taskRecord({ agentStep: agent });
        const onlyStep = delivery({ workerFeatures: async () => ["task.agentStep", "model.route"] });
        await expect(onlyStep.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
        expect(onlyStep.post).not.toHaveBeenCalled();
        const onlyRun = delivery({ workerFeatures: async () => ["task.agentRun"] });
        await expect(onlyRun.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
        expect(onlyRun.post).not.toHaveBeenCalled();
        const capable = delivery({ workerFeatures: async () => ["task.agentStep", "task.agentRun"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).agentStep).toEqual(agent);
      });

      it("refuses a read-only preparation on a worker that lacks task.agentRun, since such a worker would run the repository's setup, and sends it unchanged to one that has it (runs I-2)", async () => {
        const record = { ...taskRecord({}), invocation: { ...taskRecord({}).invocation, kind: "prepare", payload: { project: { name: "payments", revision: 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "signed-grant", readOnly: true } } as unknown as WorkerInvocation };
        for (const features of [[], ["task.agentStep", "model.route"]]) {
          const older = delivery({ workerFeatures: async () => features });
          await expect(older.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
          expect(older.post).not.toHaveBeenCalled();
        }
        const capable = delivery({ workerFeatures: async () => ["task.agentRun"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).readOnly).toBe(true);
      });

      it("refuses a preparation that brings the project's meta repo on a worker that lacks prepare.metaRepo, and sends it unchanged to one that has it (meta repo lane A)", async () => {
        const meta = { repository: { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app" }, paths: [".kiro/steering"], commit: "a".repeat(40) };
        const record = { ...taskRecord({}), invocation: { ...taskRecord({}).invocation, kind: "prepare", payload: { project: { name: "payments", revision: 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "signed-grant", meta } } as unknown as WorkerInvocation };
        for (const features of [undefined, [], ["task.agentRun", "task.agentStep"]]) {
          const older = delivery(features === undefined ? {} : { workerFeatures: async () => features });
          const refused = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refused?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refused?.message).toContain("This project's meta repo needs a newer worker");
          expect(older.post).not.toHaveBeenCalled();
        }
        const capable = delivery({ workerFeatures: async () => ["prepare.metaRepo"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).meta).toEqual(meta);
      });

      it("refuses a preparation that brings the project's package registries on a worker that lacks prepare.registries.v1, and sends it unchanged to one that has it (N9)", async () => {
        const registries = [{ name: "internal-npm", kind: "codeartifact", format: "npm", url: "https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/" }];
        const record = { ...taskRecord({}), invocation: { ...taskRecord({}).invocation, kind: "prepare", payload: { project: { name: "payments", revision: 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "signed-grant", registries } } as unknown as WorkerInvocation };
        for (const features of [undefined, [], ["task.agentRun", "prepare.metaRepo"]]) {
          const older = delivery(features === undefined ? {} : { workerFeatures: async () => features });
          const refused = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
          expect(refused?.code).toBe("RUNTIME_UNAVAILABLE");
          expect(refused?.message).toContain("package registries need a newer worker");
          expect(older.post).not.toHaveBeenCalled();
        }
        const capable = delivery({ workerFeatures: async () => ["prepare.registries.v1"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).registries).toEqual(registries);
      });

      it("refuses a run whose repository grant names a credential kind beyond token and password on a worker that lacks repository.credentialKinds.v1, and sends it unchanged to one that has it (P8)", async () => {
        const grantOf = (credentialKinds?: string[]) => `${Buffer.from(JSON.stringify({ version: 3, repositories: [{ credentialRef: "r", repositoryUrl: "https://git.example.invalid/a.git", access: "clone", hostKind: "customer-host", ...(credentialKinds === undefined ? {} : { credentialKinds }) }] })).toString("base64url")}.signature`;
        const recordOf = (kind: "prepare" | "publish" | "maintain", repositoryGrant: string) => ({ ...taskRecord({}), invocation: { ...taskRecord({}).invocation, kind, payload: { project: { name: "payments", revision: 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant } } as unknown as WorkerInvocation });
        for (const kind of ["prepare", "publish", "maintain"] as const) {
          const record = recordOf(kind, grantOf(["basic", "ssh-key"]));
          for (const features of [undefined, [], ["task.agentRun", "prepare.registries.v1"]]) {
            const older = delivery(features === undefined ? {} : { workerFeatures: async () => features });
            const refused = await older.deliver(record, record.invocation).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
            expect(refused?.code, kind).toBe("RUNTIME_UNAVAILABLE");
            expect(refused?.message).toContain("code host needs a newer worker");
            expect(older.post).not.toHaveBeenCalled();
          }
          const capable = delivery({ workerFeatures: async () => ["repository.credentialKinds.v1"] });
          await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
          expect(postedPayload(capable.post).repositoryGrant).toBe((record.invocation.payload as { repositoryGrant: string }).repositoryGrant);
        }
        // A kind no worker is ever sent (a helper) is not asked of the worker: a grant that names only it is dispatched to an old worker, and the exchange refuses the kind itself.
        const helper = recordOf("prepare", grantOf(["helper"]));
        await expect(delivery({ workerFeatures: async () => [] }).deliver(helper, helper.invocation)).resolves.toBe("DELIVERED");
        // A grant that names only the legacy kinds, or none (every GitHub grant), needs no probe at all and is sent as before.
        for (const grant of [grantOf(), grantOf(["token", "basic"]), "signed-grant"]) {
          const record = recordOf("prepare", grant);
          const unprobed = delivery();
          await expect(unprobed.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        }
      });

      it("never drops a governed model policy binding for an older or unprobed worker",async()=>{
        const modelPolicy={version:1,stage:"build",companyRevision:0,recipeDigest:"a".repeat(64)};
        const record=taskRecord({model:{provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"},modelPolicy});
        for(const older of [delivery(),delivery({workerFeatures:async()=>[]})]){
          await expect(older.deliver(record,record.invocation)).rejects.toMatchObject(refusal);expect(older.post).not.toHaveBeenCalled();
        }
        const capable=delivery({workerFeatures:async()=>["task.modelPolicy"]});
        await expect(capable.deliver(record,record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).modelPolicy).toEqual(modelPolicy);
      });

      it("refuses a model route on a worker that lacks model.route and sends it unchanged to one that has it", async () => {
        const record = taskRecord({ modelRoute });
        const older = delivery({ workerFeatures: async () => ["task.agentStep", "task.agentRun"] });
        await expect(older.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
        expect(older.post).not.toHaveBeenCalled();
        const capable = delivery({ workerFeatures: async () => ["model.route"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(postedPayload(capable.post).modelRoute).toEqual(modelRoute);
        expect(postedPayload(capable.post)).not.toHaveProperty("agentStep");
      });

      it("keeps both fields next to the fields it still drops for an older worker", async () => {
        const record = taskRecord({ agentStep: coding, modelRoute, chatgpt: { model: { provider: "openai", modelId: "gpt-6.1-sol" } } });
        const capable = delivery({ workerFeatures: async () => ["task.agentStep", "model.route"] });
        await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        const sent = postedPayload(capable.post);
        expect(sent.agentStep).toEqual(coding);
        expect(sent.modelRoute).toEqual(modelRoute);
        expect(sent).not.toHaveProperty("chatgpt");
        const older = delivery({ workerFeatures: async () => ["task.agentStep"] });
        await expect(older.deliver(record, record.invocation)).rejects.toMatchObject(refusal);
        expect(older.post).not.toHaveBeenCalled();
      });

      it("sends a payload with neither field byte for byte as before, without asking the worker", async () => {
        const workerFeatures = vi.fn(async () => [] as string[]);
        const record = taskRecord({});
        const plain = delivery({ workerFeatures });
        await expect(plain.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
        expect(workerFeatures).not.toHaveBeenCalled();
        expect(plain.post.mock.calls[0]![1].body).toBe(JSON.stringify(record.invocation));
      });
    });

    it("keeps the readiness for a worker whose /ping lists it", async () => {
      const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => ["task.readiness"]);
      const { deliver, post } = delivery({ workerFeatures });
      const record = taskRecord({ readiness });
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(workerFeatures).toHaveBeenCalledExactlyOnceWith("http://10.42.128.10:8080/ping");
      expect(postedPayload(post).readiness).toEqual(readiness);
    });

    it("drops only the readiness for a worker built before it, which falls back to the agent's commands", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const leveled = { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low" };
      const { deliver, post } = delivery({ workerFeatures: async () => ["model.thinkingLevel"] });
      const record = taskRecord({ readiness, model: leveled });
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(post)).not.toHaveProperty("readiness");
      expect(postedPayload(post).model).toEqual(leveled);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.readiness_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("drops the readiness when the dispatcher has no way to ask the worker", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery();
      const record = taskRecord({ readiness });
      await deliver(record, record.invocation);
      expect(postedPayload(post)).not.toHaveProperty("readiness");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.readiness_omitted", reason: "no-probe" }));
      log.mockRestore();
    });

    it("fails the attempt, posting nothing, when the worker's /ping does not answer for a task carrying only readiness", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => { throw new Error("timeout"); } });
      const record = taskRecord({ readiness });
      await expect(deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: could not ask the EC2 worker .*timeout/);
      expect(post).not.toHaveBeenCalled();
    });

    it("does not ask the worker when the task carries no readiness", async () => {
      const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => []);
      const { deliver, post } = delivery({ workerFeatures });
      const record = taskRecord({});
      await deliver(record, record.invocation);
      expect(workerFeatures).not.toHaveBeenCalled();
      expect(post.mock.calls[0]![1].body).toBe(JSON.stringify(record.invocation));
    });
  });

  describe("publish's reportChecks and workers built before it (spec 051, D-7)", () => {
    function publishRecord(payload: Record<string, unknown>): Ec2OutboxRecord {
      const record = recordFor();
      const operationId = record.invocation.operationId;
      const invocation: WorkerInvocation = {
        ...record.invocation,
        kind: "publish",
        payload: {
          mode: "create",
          project: {
            name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
            repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
          },
          repository: "demo", title: "t", headBranch: `agentx/${operationId}`, repositoryGrant: "g", ...payload,
        },
      };
      const context = workflowPublicationContext(invocation);
      if (context !== undefined && invocation.kind === "publish") invocation.payload.publicationContextDigest = workflowPublicationContextDigest(context);
      return { ...record, invocation };
    }
    const postedPayload = (post: ReturnType<typeof delivery>["post"]) => (JSON.parse(post.mock.calls[0]![1].body) as { payload: Record<string, unknown> }).payload;

    it("refuses a publication bound to a checked tree before POST unless the worker advertises it, and never drops the tree", async () => {
      const record = publishRecord({ candidateTreeSha: "b".repeat(40), publicationMode: "CHECKED_TREE" });
      const refused = delivery({ workerFeatures: async () => ["publish.reportChecks"] });
      await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/publishes exactly the checked tree/);
      expect(refused.post).not.toHaveBeenCalled();
      const unprobed = delivery();
      await expect(unprobed.deliver(record, record.invocation)).rejects.toThrow(/publishes exactly the checked tree/);
      expect(unprobed.post).not.toHaveBeenCalled();

      const missingMode = delivery({ workerFeatures: async () => ["publish.candidateTree"] });
      await expect(missingMode.deliver(record, record.invocation)).rejects.toThrow(/authenticates the broker-selected publication mode/);
      expect(missingMode.post).not.toHaveBeenCalled();

      const accepted = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.mode", "publish.contextDigest"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).candidateTreeSha).toBe("b".repeat(40));
      expect(postedPayload(accepted.post).publicationMode).toBe("CHECKED_TREE");
    });

    it("refuses a reviewed fix for a pull request before POST unless the worker advertises pushing it", async () => {
      const record = recordFor();
      const invocation = { ...record.invocation, kind: "maintain", payload: {
        action: "append", project: { name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }] },
        repository: "demo", pullRequestNumber: 42, headBranch: `agentx/${randomUUID()}`, baseBranch: "main", expectedHeadCommit: "d".repeat(40), repositoryGrant: "g",
        workflowCandidateTreeSha: "b".repeat(40), workflowBaseCommit: "e".repeat(40),
      } } as WorkerInvocation;
      const fix = { ...record, invocation };
      const refused = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.workflowBase"] });
      await expect(refused.deliver(fix, fix.invocation)).rejects.toThrow(/pushing a reviewed fix needs a worker that pushes exactly the reviewed tree/);
      expect(refused.post).not.toHaveBeenCalled();
      const accepted = delivery({ workerFeatures: async () => ["task.workflowPullRequestUpdate"] });
      expect(await accepted.deliver(fix, fix.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post)).toMatchObject({ workflowCandidateTreeSha: "b".repeat(40), workflowBaseCommit: "e".repeat(40) });
    });

    it("sends a reviewed fix's push without the name of the fix to a worker that does not list task.workflowFix: the push is the same, and its commit keeps the usual message (Plan 6 Task 15)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const record = recordFor();
      const invocation = { ...record.invocation, kind: "maintain", payload: {
        action: "append", project: { name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }] },
        repository: "demo", pullRequestNumber: 42, headBranch: `agentx/${randomUUID()}`, baseBranch: "main", expectedHeadCommit: "d".repeat(40), repositoryGrant: "g",
        workflowCandidateTreeSha: "b".repeat(40), workflowBaseCommit: "e".repeat(40), workflowFix: { source: "ci" },
      } } as WorkerInvocation;
      const fix = { ...record, invocation };
      const older = delivery({ workerFeatures: async () => ["task.workflowPullRequestUpdate"] });
      expect(await older.deliver(fix, fix.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).toMatchObject({ workflowCandidateTreeSha: "b".repeat(40) });
      expect(postedPayload(older.post)).not.toHaveProperty("workflowFix");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.push_fix_omitted", operationId: fix.operationId }));
      const newer = delivery({ workerFeatures: async () => ["task.workflowPullRequestUpdate", "task.workflowFix"] });
      expect(await newer.deliver(fix, fix.invocation)).toBe("DELIVERED");
      expect(postedPayload(newer.post).workflowFix).toEqual({ source: "ci" });
      log.mockRestore();
    });

    it("never sends a merge of the base branch, or a fix pushed as a merge commit, to a worker that does not list maintain.workflowSync: it is refused before the POST and the field is not dropped (Plan 6 Task 17)", async () => {
      const maintain = (extra: Record<string, unknown>) => {
        const record = recordFor();
        const invocation = { ...record.invocation, kind: "maintain", payload: {
          action: "sync", project: { name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
            repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }] },
          repository: "demo", pullRequestNumber: 42, headBranch: `agentx/${randomUUID()}`, baseBranch: "main", expectedHeadCommit: "d".repeat(40), repositoryGrant: "g", ...extra,
        } } as WorkerInvocation;
        return { ...record, invocation };
      };
      const merge = maintain({ workflowSync: { baseCommit: "b".repeat(40), expectedHeadCommit: "d".repeat(40) } });
      const mergeFix = maintain({ action: "append", workflowCandidateTreeSha: "c".repeat(40), workflowBaseCommit: "e".repeat(40), workflowMergeBase: "b".repeat(40) });
      for (const record of [merge, mergeFix]) {
        const refused = delivery({ workerFeatures: async () => ["task.workflowPullRequestUpdate"] });
        await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/pushing a reviewed fix needs a worker/);
        expect(refused.post).not.toHaveBeenCalled();
        const accepted = delivery({ workerFeatures: async () => ["task.workflowPullRequestUpdate", "maintain.workflowSync"] });
        expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      }
      const accepted = delivery({ workerFeatures: async () => ["maintain.workflowSync"] });
      expect(await accepted.deliver(merge, merge.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).workflowSync).toEqual({ baseCommit: "b".repeat(40), expectedHeadCommit: "d".repeat(40) });
    });

    it("refuses a publication carrying the task's pinned base before POST unless the worker advertises it, and never drops it", async () => {
      const record = publishRecord({ candidateTreeSha: "b".repeat(40), publicationMode: "CHECKED_TREE", workflowBaseCommit: "c".repeat(40) });
      const refused = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.mode", "publish.contextDigest"] });
      await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/task's pinned base commit/);
      expect(refused.post).not.toHaveBeenCalled();
      const accepted = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.mode", "publish.contextDigest", "publish.workflowBase"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).workflowBaseCommit).toBe("c".repeat(40));
    });

    it("sends the attribution only to a worker that lists publish.attribution; an older worker gets the publication without it, never a failure (I3, rolling deploys)", async () => {
      const attribution = { requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" } };
      const record = publishRecord({ attribution, body: "Requested by: Maya Chen\n" });
      for (const features of [[], ["publish.reportChecks"], ["publish.candidateTree"]]) {
        const old = delivery({ workerFeatures: async () => features });
        expect(await old.deliver(record, record.invocation), JSON.stringify(features)).toBe("DELIVERED");
        const sent = postedPayload(old.post);
        expect(sent).not.toHaveProperty("attribution");
        // Nothing else changes: the description the broker wrote (with the attribution lines) is what the old worker publishes.
        expect(sent.body).toBe("Requested by: Maya Chen\n");
        expect(JSON.stringify(sent)).not.toContain("0123456789abcdef");
      }
      // A worker whose ping cannot be read at all is an old worker too.
      const unprobed = delivery({});
      expect(await unprobed.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(unprobed.post)).not.toHaveProperty("attribution");
      const accepted = delivery({ workerFeatures: async () => ["publish.attribution"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).attribution).toEqual(attribution);
      // A publication that carries none is not touched by the feature.
      const plain = publishRecord({});
      const unaffected = delivery({ workerFeatures: async () => [] });
      expect(await unaffected.deliver(plain, plain.invocation)).toBe("DELIVERED");
    });

    it("keeps reportChecks for a worker whose /ping lists it", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => ["publish.reportChecks"] });
      const record = publishRecord({ reportChecks: true });
      await deliver(record, record.invocation);
      expect(postedPayload(post).reportChecks).toBe(true);
    });

    it("drops reportChecks for a worker built before it, which then refuses a failing check as before", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery({ workerFeatures: async () => ["model.thinkingLevel", "task.readiness"] });
      const record = publishRecord({ reportChecks: true });
      await deliver(record, record.invocation);
      expect(postedPayload(post)).not.toHaveProperty("reportChecks");
      expect(WorkerInvocationSchema.safeParse({ ...record.invocation, payload: postedPayload(post) }).success).toBe(true);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.report_checks_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("drops reportChecks when the dispatcher has no way to ask the worker (M-4)", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery();
      const record = publishRecord({ reportChecks: true });
      await deliver(record, record.invocation);
      expect(postedPayload(post)).not.toHaveProperty("reportChecks");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.report_checks_omitted", reason: "no-probe" }));
      log.mockRestore();
    });

    it("does not ask the worker when the publication does not carry it", async () => {
      const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => []);
      const { deliver, post } = delivery({ workerFeatures });
      const record = publishRecord({});
      await deliver(record, record.invocation);
      expect(workerFeatures).not.toHaveBeenCalled();
      expect(post.mock.calls[0]![1].body).toBe(JSON.stringify(record.invocation));
    });
  });

  describe("the thinking level and workers built before it (spec 053)", () => {
    function taskRecord(model: Record<string, unknown>): Ec2OutboxRecord {
      const record = recordFor();
      const invocation = {
        ...record.invocation,
        kind: "task",
        payload: { conversationId: randomUUID(), prompt: "test it", model },
      } as WorkerInvocation;
      return { ...record, invocation };
    }
    const leveled = { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low" };
    const posted = (post: ReturnType<typeof delivery>["post"]) => (JSON.parse(post.mock.calls[0]![1].body) as { payload: { model: Record<string, unknown> } }).payload.model;

    it("keeps the level for a worker whose /ping lists the feature", async () => {
      const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => ["model.thinkingLevel"]);
      const { deliver, post } = delivery({ workerFeatures });
      const record = taskRecord(leveled);
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(workerFeatures).toHaveBeenCalledExactlyOnceWith("http://10.42.128.10:8080/ping");
      expect(posted(post)).toEqual(leveled);
    });

    it("drops only the level for a worker whose /ping lists no features, and keeps the token valid", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery({ workerFeatures: async () => [] });
      const record = taskRecord(leveled);
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      const model = posted(post);
      expect(model).toEqual({ provider: "amazon-bedrock", modelId: "fast" });
      expect(Object.keys(model)).not.toContain("thinkingLevel");
      const body = JSON.parse(post.mock.calls[0]![1].body) as WorkerInvocation;
      const verified = verifyInvokeAuthorization(post.mock.calls[0]![1].authorization, {
        publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000),
      });
      expect(verified.ok && invocationMatchesClaims(body, verified.claims)).toBe(true);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.thinking_level_omitted", reason: "worker-lacks-feature", requestedThinkingLevel: "low", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("fails the attempt, posting nothing, when the worker's /ping does not answer", async () => {
      // The worker journals the whole invocation's hash: a retry must send what this attempt would have.
      const { deliver, post } = delivery({ workerFeatures: async () => { throw new Error("timeout"); } });
      const record = taskRecord(leveled);
      await expect(deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: could not ask the EC2 worker .*timeout/);
      expect(post).not.toHaveBeenCalled();
    });

    it("drops the level when the dispatcher has no way to ask the worker", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery();
      const record = taskRecord(leveled);
      await deliver(record, record.invocation);
      expect(posted(post)).toEqual({ provider: "amazon-bedrock", modelId: "fast" });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ reason: "no-probe", requestedThinkingLevel: "low" }));
      log.mockRestore();
    });

    it("reads the features from the worker's /ping body: none from a worker built before them, or a malformed field", async () => {
      const ping = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://10.42.128.10:8080/ping", ping({ status: "Healthy", activeOperations: 0 }))).resolves.toEqual([]);
      await expect(workerPingFeatures("http://w/ping", ping({ status: "Healthy", invocationFeatures: "model.thinkingLevel" }))).resolves.toEqual([]);
      await expect(workerPingFeatures("http://w/ping", ping({ status: "Healthy", invocationFeatures: ["model.thinkingLevel", 7] }))).resolves.toEqual(["model.thinkingLevel"]);
      await expect(workerPingFeatures("http://w/ping", ping(null))).resolves.toEqual([]);
      const unreachable = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://w/ping", unreachable)).rejects.toThrow("fetch failed");
    });

    it("fails the attempt when the worker's /ping answers with a non-2xx status", async () => {
      const ping = vi.fn(async () => new Response(JSON.stringify({ status: "Unhealthy", invocationFeatures: [] }), { status: 503 })) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://w/ping", ping)).rejects.toThrow(/HTTP 503/);
      const redirect = vi.fn(async () => new Response("{}", { status: 302 })) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://w/ping", redirect)).rejects.toThrow(/HTTP 302/);
    });

    describe("a project definition carried by prepare, publish and maintain", () => {
      const models = {
        default: { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low", label: "Fast" },
        approved: [
          { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low", label: "Fast" },
          { provider: "openrouter", modelId: "z-ai/glm-5.3" },
        ],
      };
      const unleveledModels = {
        default: { provider: "amazon-bedrock", modelId: "fast", label: "Fast" },
        approved: [
          { provider: "amazon-bedrock", modelId: "fast", label: "Fast" },
          { provider: "openrouter", modelId: "z-ai/glm-5.3" },
        ],
      };
      function projectWith(projectModels: unknown) {
        return {
          name: "payments",
          revision: 1,
          repositories: [{ name: "api", url: "https://git.example.test/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "api-readwrite" }],
          setup: [],
          readiness: [],
          orchestratorInstructions: "Delegate coding to the remote worker.",
          ...(projectModels === undefined ? {} : { models: projectModels }),
        };
      }
      function projectRecord(kind: "prepare" | "publish" | "maintain", projectModels: unknown): Ec2OutboxRecord {
        const record = recordFor();
        const payload = kind === "prepare"
          ? { project: projectWith(projectModels), repositoryGrant: "signed-grant" }
          : kind === "publish"
            ? {
              project: projectWith(projectModels), repository: "api", title: "Fix it", headBranch: `agentx/${randomUUID()}`,
              repositoryGrant: "signed-grant", mode: "create",
            }
            : {
              action: "sync", project: projectWith(projectModels), repository: "api", pullRequestNumber: 7,
              headBranch: `agentx/${randomUUID()}`, baseBranch: "main", expectedHeadCommit: "a".repeat(40), repositoryGrant: "signed-grant",
            };
        return { ...record, invocation: { ...record.invocation, kind, payload } as unknown as WorkerInvocation };
      }
      const postedModels = (post: ReturnType<typeof delivery>["post"]) =>
        (JSON.parse(post.mock.calls[0]![1].body) as { payload: { project: { models?: unknown } } }).payload.project.models;

      for (const kind of ["prepare", "publish", "maintain"] as const) {
        it(`${kind}: keeps every level for a worker whose /ping lists the feature`, async () => {
          const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => ["model.thinkingLevel"]);
          const { deliver, post } = delivery({ workerFeatures });
          const record = projectRecord(kind, models);
          expect(await deliver(record, record.invocation)).toBe("DELIVERED");
          expect(workerFeatures).toHaveBeenCalledExactlyOnceWith("http://10.42.128.10:8080/ping");
          expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual(record.invocation);
        });

        it(`${kind}: strips only the levels for a worker built before them, and keeps the token valid`, async () => {
          const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
          const { deliver, post } = delivery({ workerFeatures: async () => [] });
          const record = projectRecord(kind, models);
          expect(await deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedModels(post)).toEqual(unleveledModels);
          const body = JSON.parse(post.mock.calls[0]![1].body) as WorkerInvocation;
          const sentPayload = record.invocation.payload as { project: Record<string, unknown> };
          expect(body).toEqual({ ...record.invocation, payload: { ...sentPayload, project: { ...sentPayload.project, models: unleveledModels } } });
          const verified = verifyInvokeAuthorization(post.mock.calls[0]![1].authorization, {
            publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000),
          });
          expect(verified.ok && invocationMatchesClaims(body, verified.claims)).toBe(true);
          expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
            event: "dispatch.thinking_level_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
          }));
          log.mockRestore();
        });

        // Task 4.10D review I-1: `lastCheck` is written by the CLI at registration and no worker reads it; an older worker's strict parse would refuse the whole invocation.
        it(`${kind}: never sends lastCheck, so a worker built before it accepts the definition (whatever its features, and without asking it)`, async () => {
          const checked = {
            default: { provider: "amazon-bedrock", modelId: "fast", label: "Fast", lastCheck: { status: "ok", checkedAt: "2026-10-23T12:00:00.000Z" } },
            approved: [
              { provider: "amazon-bedrock", modelId: "fast", label: "Fast", lastCheck: { status: "ok", checkedAt: "2026-10-23T12:00:00.000Z" } },
              { provider: "openrouter", modelId: "z-ai/glm-5.3", lastCheck: { status: "failed", class: "model-not-found", checkedAt: "2026-10-23T12:00:00.000Z" } },
            ],
          };
          const beforeLastCheck = z.object({ provider: z.string(), modelId: z.string(), thinkingLevel: z.string().optional(), label: z.string().optional() }).strict();
          for (const features of [[], ["model.thinkingLevel"]]) {
            const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => features);
            const { deliver, post } = delivery({ workerFeatures });
            const record = projectRecord(kind, checked);
            expect(await deliver(record, record.invocation)).toBe("DELIVERED");
            const sent = postedModels(post) as { default: unknown; approved: unknown[] };
            expect(() => { beforeLastCheck.parse(sent.default); for (const model of sent.approved) beforeLastCheck.parse(model); }).not.toThrow();
            expect(JSON.stringify(sent)).not.toContain("lastCheck");
            expect(sent.approved).toHaveLength(2);
          }
          // Without a model-level field there is nothing to ask the worker about: no probe.
          const probe = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => []);
          const quiet = delivery({ workerFeatures: probe });
          const record = projectRecord(kind, checked);
          await quiet.deliver(record, record.invocation);
          expect(probe).not.toHaveBeenCalled();
        });

        it(`${kind}: fails the attempt, posting nothing, when the worker's /ping does not answer`, async () => {
          const { deliver, post } = delivery({ workerFeatures: async () => { throw new Error("timeout"); } });
          const record = projectRecord(kind, models);
          await expect(deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: could not ask the EC2 worker .*timeout/);
          expect(post).not.toHaveBeenCalled();
        });

        it(`${kind}: does not ask the worker when the definition carries no level`, async () => {
          const workerFeatures = vi.fn(async () => []);
          for (const projectModels of [unleveledModels, undefined]) {
            const { deliver, post } = delivery({ workerFeatures });
            const record = projectRecord(kind, projectModels);
            await deliver(record, record.invocation);
            expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual(record.invocation);
          }
          expect(workerFeatures).not.toHaveBeenCalled();
        });
      }
    });

    it("does not ask the worker when the invocation carries no level", async () => {
      const workerFeatures = vi.fn(async () => []);
      const { deliver, post } = delivery({ workerFeatures });
      const record = taskRecord({ provider: "amazon-bedrock", modelId: "fast" });
      await deliver(record, record.invocation);
      expect(workerFeatures).not.toHaveBeenCalled();
      expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual(record.invocation);
    });
  });

  it("parks the record and records one progress event while the session is not ready", async () => {
    const { deliver, post, progress } = delivery({ sessions: { ensureSession: async () => ({ ready: false, generation: 1, state: "PROVISIONING" }) } });
    const record = recordFor();
    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    expect(progress).toHaveBeenCalledExactlyOnceWith(record, STARTING_COMPUTE_MESSAGE);
    expect(post).not.toHaveBeenCalled();
  });

  it("fails an attempt when the worker refuses, and when the workspace has no ec2-ebs binding", async () => {
    const refused = delivery({ post: async () => ({ status: 401, body: "{\"reason\":\"expired\"}" }) });
    const record = recordFor();
    await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: EC2 worker returned HTTP 401/);
    const unbound = delivery({ binding: async () => undefined });
    await expect(unbound.deliver(record, record.invocation)).rejects.toThrow(/CONFIG_INVALID/);
  });
});

describe("the dispatcher with ec2-ebs records", () => {
  function dispatcher(deliverEc2: (record: Ec2OutboxRecord, invocation: WorkerInvocation) => Promise<Ec2Delivery>) {
    const markDelivered = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, log: () => undefined });
    return { handler, markDelivered, markFailed };
  }

  it("acknowledges a durably access-parked duplicate without invoking or consuming failure attempts", async () => {
    const record = recordFor();
    const markDispatching = vi.fn(async () => true);
    const markDelivered = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const deliverEc2 = vi.fn(async () => "DELIVERED" as const);
    const handler = createDispatcherHandler({
      markDispatching, markDelivered, markFailed, deliverEc2,
      guardTaskDispatch: async () => "PARKED",
      maxAttempts: 1,
      log: () => undefined,
    });

    await expect(handler({ Records: [{ messageId: "access-parked", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "99" } }] }))
      .resolves.toEqual({ batchItemFailures: [] });
    expect(markDispatching).not.toHaveBeenCalled();
    expect(deliverEc2).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("passes invocation remaining time into the initial pre-compute guard", async () => {
    const record = recordFor();
    const guardTaskDispatch = vi.fn<(record: DurableOutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">>(async () => "PARKED");
    const markDispatching = vi.fn(async () => true);
    const handler = createDispatcherHandler({
      markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined,
      guardTaskDispatch, deliverEc2: async () => "DELIVERED", log: () => undefined,
    });

    await expect(handler({ Records: [{ messageId: "initial", body: JSON.stringify(record) }] }, {
      getRemainingTimeInMillis: () => 8_000,
    })).resolves.toEqual({ batchItemFailures: [] });
    expect(guardTaskDispatch).toHaveBeenCalledTimes(1);
    expect(typeof guardTaskDispatch.mock.calls[0]?.[1]?.remainingTimeMs).toBe("function");
    expect(markDispatching).not.toHaveBeenCalled();
  });

  it("acknowledges a parked record without marking it delivered or using a retry", async () => {
    const { handler, markDelivered } = dispatcher(async () => "WAITING_FOR_SESSION");
    const record = recordFor();
    expect(await handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] })).toEqual({ batchItemFailures: [] });
    expect(markDelivered).not.toHaveBeenCalled();
  });

  it("marks a delivered record DELIVERED, and retries a failed delivery", async () => {
    const delivered = dispatcher(async () => "DELIVERED");
    const record = recordFor();
    await delivered.handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] });
    expect(delivered.markDelivered).toHaveBeenCalledWith(record.id);

    const failing = dispatcher(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(await failing.handler({ Records: [{ messageId: "m2", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "1" } }] }))
      .toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(failing.markFailed).not.toHaveBeenCalled();
  });

  it("keeps an incomplete authority guard retryable at max attempts but preserves identical ordinary worker errors", async () => {
    const record = recordFor();
    const original = agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
    const guardTaskDispatch = async (candidate: DurableOutboxRecord) => coreGuardTaskDispatch({
      documentClient: { async send() { throw original; } }, tableName: "state",
    }, candidate);
    const markFailed = vi.fn(async () => undefined);
    const logs: Array<{ terminal: boolean; errorCode?: string }> = [];
    const guarded = createDispatcherHandler({
      guardTaskDispatch, markDispatching: async () => true, markDelivered: async () => undefined, markFailed,
      maxAttempts: 5, deliverEc2: async () => "DELIVERED", log: (entry) => { logs.push(entry); },
    });
    await expect(guarded({ Records: [{ messageId: "guard-terminal", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "5" } }] }))
      .resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "guard-terminal" }] });
    expect(markFailed).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({ terminal: false, errorCode: original.code });

    const ordinaryMarkFailed = vi.fn(async () => undefined);
    const ordinary = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined,
      markFailed: ordinaryMarkFailed, maxAttempts: 5,
      deliverEc2: async () => { throw agentXError("RUNTIME_UNAVAILABLE", original.message.slice("RUNTIME_UNAVAILABLE: ".length)); },
      log: () => undefined });
    await expect(ordinary({ Records: [{ messageId: "worker-terminal", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "5" } }] }))
      .resolves.toEqual({ batchItemFailures: [] });
    expect(ordinaryMarkFailed).toHaveBeenCalledTimes(1);
  });

  it("fails the current and remaining batch items before starting another guard inside the pause reserve", async () => {
    const first = recordFor();
    const second = recordFor();
    const guardTaskDispatch = vi.fn(async () => "ALLOWED" as const);
    const markDispatching = vi.fn(async () => true);
    const handler = createDispatcherHandler({
      guardTaskDispatch, markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined,
      deliverEc2: async () => "DELIVERED", log: () => undefined,
    });

    await expect(handler({ Records: [first, second].map((record, index) => ({ messageId: `m${index + 1}`, body: JSON.stringify(record) })) }, {
      getRemainingTimeInMillis: () => 2_000,
    })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }] });
    expect(guardTaskDispatch).not.toHaveBeenCalled();
    expect(markDispatching).not.toHaveBeenCalled();
  });
});

describe("ec2-ebs delivery through the real session manager", () => {
  it("parks the first delivery with one event, re-queues it when ready, then delivers it", async () => {
    const db = new FakeDynamoDb();
    const start = vi.fn(async ({ name }: { name: string }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
    const sessions = new SessionManager({
      documentClient: db, tableName: "state",
      executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start },
    });
    const record = recordFor();
    db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs" as const, projectName: "ec2-test", projectRevision: 1, activeOperationId: record.operationId, fence: 2 });
    db.set({ ...projectRevisionKey(TEST_ORG, "ec2-test", 1), entityType: "PROJECT", runtimeBinding: binding });
    db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}`, status: "DISPATCHING", fence: 2, eventSequence: 0 });
    db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{}" }));
    const deliver = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions,
      binding: (workspaceId) => workspaceBinding(db, "state", TEST_ORG, workspaceId),
      sign: kmsSign,
      post,
      progress: (parked, message) => appendOperationEvent(db, "state", {
        workspaceId: parked.workspaceId, operationId: parked.operationId, fence: parked.invocation.fence, onceKey: `session-wait#${parked.id}`,
        event: { type: "progress", timestamp: new Date(NOW).toISOString(), payload: { message } },
      }),
      now: () => NOW,
    });

    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    // A duplicate SQS delivery of the parked record adds no second event.
    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    expect(start).toHaveBeenCalledOnce();
    expect(db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_SESSION" });
    const events = db.find((item) => item.entityType === "EVENT" && item.operationId === record.operationId);
    expect(events).toEqual([expect.objectContaining({ type: "progress", sequence: 1, payload: { message: STARTING_COMPUTE_MESSAGE } })]);
    expect(db.get(`WORKSPACE#${record.workspaceId}`, `OPERATION#${record.operationId}`)).toMatchObject({ eventSequence: 1 });

    await sessions.markVolume(record.workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(record.workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    expect(await sessions.markReady(record.workspaceId, 1)).toEqual({ requeued: [record.id] });
    expect(db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "PENDING" });

    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    expect(post.mock.calls[0]![0]).toBe("http://10.42.128.10:8080/invocations");
    expect(verifyInvokeAuthorization(post.mock.calls[0]![1].authorization, {
      publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 1, now: () => Math.floor(NOW / 1_000),
    }).ok).toBe(true);
  });

  it("acknowledges a duplicate readiness delivery already parked while provisioning", async () => {
    const fixture = readinessFixture();
    const start = vi.fn(async ({ name }: { name: string }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
    const sessions = new SessionManager({ documentClient: fixture.db, tableName: "state",
      executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start } });
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{}" }));
    const markFailed = vi.fn(async () => undefined);
    const markDelivered = vi.fn(async () => undefined);
    const deliver = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions,
      binding: (workspaceId) => workspaceBinding(fixture.db, "state", TEST_ORG, workspaceId),
      sign: kmsSign,
      post,
      progress: (record, message) => appendOperationEvent(fixture.db, "state", {
        workspaceId: record.workspaceId, operationId: record.operationId, fence: record.invocation.fence,
        onceKey: `session-wait#${record.id}`, event: { type: "progress", timestamp: new Date(NOW).toISOString(), payload: { message } },
      }),
      validateWorkflowE2EReadiness: createWorkflowE2EReadinessValidator({ documentClient: fixture.db as never, tableName: "state" }),
      now: () => NOW,
    });
    const handler = createDispatcherHandler({
      markDispatching: async () => true, markDelivered, markFailed,
      deliverEc2: (record, invocation) => deliver(record, invocation), log: () => undefined,
    });
    const message = { messageId: "readiness-parked", body: JSON.stringify(fixture.record) };

    await expect(handler({ Records: [message] })).resolves.toEqual({ batchItemFailures: [] });
    expect(fixture.db.get(`OUTBOX#${fixture.record.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_SESSION" });
    expect(fixture.db.get(...Object.values(workspaceSessionKey(fixture.record.workspaceId)) as [string, string])).toMatchObject({
      state: "PROVISIONING", generation: 1, waitingOutboxIds: new Set([fixture.record.id]),
    });
    expect(start).toHaveBeenCalledOnce();

    await expect(handler({ Records: [{ ...message, messageId: "readiness-duplicate" }] })).resolves.toEqual({ batchItemFailures: [] });
    expect(start).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(fixture.db.get(`OUTBOX#${fixture.record.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_SESSION" });
    expect(fixture.db.get(...Object.values(workspaceSessionKey(fixture.record.workspaceId)) as [string, string])).toMatchObject({
      state: "PROVISIONING", generation: 1, waitingOutboxIds: new Set([fixture.record.id]),
    });
    expect(fixture.db.find((item) => item.entityType === "EVENT" && item.operationId === fixture.record.operationId)).toHaveLength(1);
  });
});

describe("the runtime binding a session is started with", () => {
  it("reads the workspace record strongly consistently, because preparation may have just moved its revision (#12)", async () => {
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      const key = command.input.Key as { pk: string };
      if (key.pk.startsWith("WORKSPACE#")) return { Item: { deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 2 } };
      return { Item: { runtimeBinding: binding } };
    });
    const workspaceId = randomUUID();
    await expect(workspaceBinding({ send } as never, "state", TEST_ORG, workspaceId)).resolves.toEqual(binding);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ Key: projectRevisionKey(TEST_ORG, "payments", 2) });
  });
});
