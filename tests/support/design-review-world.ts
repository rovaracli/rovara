// Design review, DR13: the broker round trip the poisoning suite drives. It is the harness of tests/contract/design-review-e2e.test.ts in a module (that file keeps its own copy, so a change to one
// cannot break the other): a Full task whose design was just submitted is started by the real dispatch over a fake table, a fake model proxy and a fake worker; the "worker" fetches its packets, asks for
// each slot's key and uploads `design-review.json`; the broker verifies, assembles and records the round. The reviewers' and the merge step's answers are plain strings the test writes, so a hostile model is
// one string.
import { createHash, randomUUID } from "node:crypto";
import {
  DesignReviewBindingSchema, PacketDeliverySchema, WorkflowSnapshotSchema, createWorkflowSnapshot, decideWorkflow, enableDesignReview, packetDigestOf, submitWorkflowArtifact,
  type DesignReviewBinding, type DesignReviewTier, type ReviewerRole, type WorkflowArtifact, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { MAYA, createSingleAnswerPlanBroker } from "./developer-task-broker.js";
import { fakeModelAccess } from "./fake-model-access.js";
import { TEST_ORG } from "./orgs.js";
import { seedDesignReviewCompany } from "./design-review-company.js";

export const PROXY_URL = "http://internal-proxy.example.test:4000";
export const NOW = "2026-11-03T12:00:00.000Z";
export const LATER = "2026-11-03T12:05:00.000Z";
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const REQUIREMENTS = "# Requirements\n\nR1: A payment that times out is retried once.\nR2: A payment is never charged twice.\n";
export const DESIGN_V1 = "# Design\n\n## 1. Problem and goal\nR1 and R2.\n\n## 3. Proposed design\n### 3.1 Retry\nR1: retry a timed-out payment once. R2: use the payment id as the idempotency key.\n";

export type DesignWorld = Awaited<ReturnType<typeof designWorld>>;

/** A v2 task whose design was just submitted for review: PLAN_CRITIQUE/READY, review "estimating", the documents stored and digest-checked, then started by the dispatch. */
export async function designWorld(options: { tier?: DesignReviewTier; capUsd?: number; requirements?: string; design?: string; reasons?: Array<"new_api" | "money" | "auth" | "data_model" | "pii" | "small_change"> } = {}) {
  const access = fakeModelAccess();
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, cloud: true, modelAccess: { access, proxyUrl: PROXY_URL } } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  seedDesignReviewCompany(harness.db, TEST_ORG, { project: "payments" });
  await new AgentStore({ documentClient: harness.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  harness.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
  const started = await harness.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Retry timed-out payments" }, path: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId?: string }).activeOperationId ?? "");
  await harness.finish(workspaceId, active(), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const planner = active();
  const task = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; ownerKey: string; orgId: string };
  const base = task().workflow;
  const store = (name: string, text: string): WorkflowArtifact => {
    const objectKey = `private/${task().ownerKey}/${workspaceId}/${taskId}/${name}`;
    harness.s3.objects.set(objectKey, text);
    return { id: `artifact-${name}`, type: name.startsWith("requirements") ? "requirements" : "design", version: Number(/-v(\d+)/u.exec(name)?.[1] ?? 1), sha256: sha256(text), producer: "agentx-worker-untrusted", objectKey, createdAt: NOW, format: "markdown" };
  };
  const requirements = store("requirements-v1.md", options.requirements ?? REQUIREMENTS);
  const design = store("design-v1.md", options.design ?? DESIGN_V1);
  const owner = base.ownerId;
  const program = base.program as WorkflowProgram;
  let workflow = createWorkflowSnapshot({ taskId, ownerId: owner, now: NOW, path: "QUICK", definitionVersion: "1.1.0", program });
  workflow = { ...workflow, state: "READY" };
  workflow = enableDesignReview(workflow, {
    expectedRevision: workflow.revision, now: NOW,
    start: { decidedBy: "auto", reasons: options.reasons ?? ["new_api"], note: "Adds a retry.", tier: options.tier ?? "standard", capUsd: options.capUsd ?? 10 },
  });
  const running = (value: WorkflowSnapshot): WorkflowSnapshot => ({ ...value, revision: value.revision + 1, state: "RUNNING" });
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: requirements, now: NOW });
  workflow = decideWorkflow(workflow, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: requirements.sha256 },
    { actorId: owner, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });
  workflow = WorkflowSnapshotSchema.parse(submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: design, now: NOW }));
  // The harness gives the task $2; the calibrated reviewer estimate (FU3) is above that for one round, so the task gets room (these tests are about the review, not the task limit).
  harness.db.set({ ...task(), workflow, budgetUsd: 50 });
  harness.db.set((workflowDispatchItem("state", taskId, workflow.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item);
  // The planner's own run ends (its result is late), which frees the workspace and runs the task's due rows: the design review starts.
  await harness.finish(workspaceId, planner, "SUCCEEDED");
  const operations = () => harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.workflowMode === "PLAN_CRITIQUE").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { ...harness, access, taskId, workspaceId, task, operations, store, requirements, design, owner, running, active };
}

/** Raw reply of the broker, as the worker sees it. */
export async function rawGet(handler: (event: never) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>, path: string, capability: string) {
  const response = await handler({
    version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { "x-agentx-callback-capability": capability },
    requestContext: { requestId: randomUUID(), http: { method: "GET" } },
  } as never);
  return { status: response.statusCode, body: response.body };
}

export interface Reviewer {
  /** The findings block it ends its answer with (default: none). */
  findings?: unknown[];
  /** The whole answer text, instead of the standard "I read the design" plus the block. A hostile model writes whatever it likes here. */
  answer?: string;
  spentUsd?: number;
}

export interface WorkerRun { binding: DesignReviewBinding; keys: Record<string, string>; capability: string; delivered: Map<ReviewerRole, string> }

/**
 * The worker of one operation: fetches each reviewer's packet (kept, so a test can read what the reviewers were given), asks for each slot's key, and uploads `design-review.json` with the answers the test
 * wrote. `merge.answer` is what the merge model said.
 */
export async function runDesignWorker(w: DesignWorld, operationId: string, reviewers: Partial<Record<ReviewerRole, Reviewer>> = {}, options: { merge?: { answer: string }; mergeSpentUsd?: number } = {}): Promise<WorkerRun> {
  const outbox = w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
  const invocation = outbox.invocation as { callbackCapability: string; payload: { designReview: DesignReviewBinding } };
  const capability = invocation.callbackCapability;
  const binding = DesignReviewBindingSchema.parse(invocation.payload.designReview);
  const outcomes: unknown[] = [];
  const keys: Record<string, string> = {};
  const delivered = new Map<ReviewerRole, string>();
  for (const entry of binding.reviewers) {
    const spec = reviewers[entry.role] ?? {};
    const packet = await rawGet(w.handler, `/v1/internal/design-review/packet?slot=${entry.keySlot}`, capability);
    if (packet.status !== 200) throw new Error(`packet ${entry.keySlot}: ${packet.status} ${packet.body}`);
    const delivery = PacketDeliverySchema.parse(JSON.parse(packet.body));
    if (packetDigestOf(delivery) !== entry.packetDigest) throw new Error("the delivered packet is not the one the binding names");
    delivered.set(entry.role, JSON.stringify(delivery));
    const key = await rawGet(w.handler, `/v1/internal/model-access?slot=${entry.keySlot}`, capability);
    if (key.status !== 200) throw new Error(`key ${entry.keySlot}: ${key.status}`);
    const apiKey = (JSON.parse(key.body) as { apiKey: string }).apiKey;
    keys[entry.role] = apiKey;
    w.access.setKeySpent(apiKey, spec.spentUsd ?? 0.1);
    const comprehension = entry.role === "comprehension";
    const block = JSON.stringify({ ...(comprehension ? { paraphrase: { proposes: "Retry a timed-out payment once.", today: "A timeout throws." } } : {}), findings: spec.findings ?? [] });
    outcomes.push({
      role: entry.role, keySlot: entry.keySlot, status: "answered", retried: false,
      report: { sessionId: `session-${operationId.slice(0, 8)}-${entry.role}`, packetDigest: entry.packetDigest, firstRequestMessages: 2, filesRead: [], tools: ["read", "grep"], modelKeyId: keyIdOf(apiKey) },
      answer: spec.answer ?? `I read the design.\n\n\`\`\`rovara-design-review\n${block}\n\`\`\`\n`, tokensIn: 5_000, tokensOut: 400, costUsd: 0.05, startedAt: "2026-11-03T12:10:00.000Z", endedAt: "2026-11-03T12:12:00.000Z",
    });
  }
  let merge: Record<string, unknown> = { status: "no_result", tokensIn: 0, tokensOut: 0, costUsd: 0 };
  if (binding.merge !== undefined) {
    const mergeKey = await rawGet(w.handler, `/v1/internal/model-access?slot=${binding.merge.keySlot}`, capability);
    if (mergeKey.status !== 200) throw new Error(`merge key: ${mergeKey.status}`);
    keys.merge = (JSON.parse(mergeKey.body) as { apiKey: string }).apiKey;
    w.access.setKeySpent(keys.merge, options.mergeSpentUsd ?? 0.05);
    if (options.merge !== undefined) merge = { status: "answered", answer: options.merge.answer, tokensIn: 3_000, tokensOut: 300, costUsd: 0.05 };
  }
  const result = { version: 1, round: binding.round, reviewers: outcomes, merge, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false };
  await w.artifact(w.workspaceId, operationId, "design-review.json", JSON.stringify(result));
  await w.finish(w.workspaceId, operationId, "SUCCEEDED");
  return { binding, keys, capability, delivered };
}
