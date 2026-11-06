// Design review (DR-KEY-1): a design-review round of a task whose Rovara Code recipe carries a pinned model policy. Its operation is built by the real dispatch, so it carries
// `modelPolicy` (stage plan_check), `modelTaskId` and a `modelRoute` like the planner's; each slot's key is asked for through the real broker handler, as the worker does.
// Staging's first real round failed at once with "the model proxy key could not be obtained": the worker opened the operation's own (never prompted) session through the proxy, which asked
// the broker for the OPERATION's key, and the broker refuses that for a design review (keys are by slot only). The slot keys themselves were never asked for.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesignReviewBindingSchema, WorkflowSnapshotSchema, canonicalModelName, createWorkflowSnapshot, decideWorkflow, enableDesignReview, submitWorkflowArtifact,
  DesignReviewWorkerResultSchema, modelFailureCodeOf, type InvocationModelRoute, type WorkflowArtifact, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { lazyModelProxy, modelAccessSource } from "../../packages/worker/src/model-access.js";
import { modelUnusableRound, operationModelProxy, slotRuntimeFor } from "../../packages/worker/src/design-review-sessions.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";
import { workerModelRuntime } from "../../packages/worker/src/pi-session.js";
import { TEST_ORG } from "../support/orgs.js";
import { seedDesignReviewCompany } from "../support/design-review-company.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const NOW = "2026-11-03T12:00:00.000Z";
const LATER = "2026-11-03T12:05:00.000Z";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const REQUIREMENTS = "# Requirements\n\nR1: A payment that times out is retried once.\n";
const DESIGN = "# Design\n\n## 1. Problem and goal\nR1.\n\n## 3. Proposed design\n### 3.1 Retry\nR1: retry a timed-out payment once.\n";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-19T12:00:00.000Z")); vi.stubEnv("DESIGN_REVIEW_ENABLED", "1"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function rawGet(handler: (event: never) => Promise<{ statusCode: number; body: string }>, path: string, capability: string) {
  const response = await handler({
    version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { "x-agentx-callback-capability": capability },
    requestContext: { requestId: randomUUID(), http: { method: "GET" } },
  } as never);
  return { status: response.statusCode, body: response.body };
}

/** A Rovara Code v2 task (its recipe pinned with the company's model policy) whose design was just submitted: the dispatch starts the design review's operation. */
async function world(options: { learned?: Set<string> } = {}) {
  const access = fakeModelAccess();
  // `learned`: the account's usable-model record, as learning from refused calls fills it (usable-models.ts).
  const learned = options.learned;
  const usableModels = learned === undefined ? undefined : { unusable: async () => new Set(learned), markUnusable: async (model: { provider: string; modelId: string }) => { learned.add(canonicalModelName(model)); } };
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, cloud: true, modelAccess: { access, proxyUrl: PROXY_URL }, ...(usableModels === undefined ? {} : { usableModels }) } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  seedDesignReviewCompany(harness.db, TEST_ORG, { project: "payments" });
  await new AgentStore({ documentClient: harness.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  harness.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
  const started = await harness.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Retry timed-out payments" }, path: "QUICK" });
  expect([200, 202], JSON.stringify(started.body)).toContain(started.status);
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId?: string }).activeOperationId ?? "");
  await harness.finish(workspaceId, active(), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const planner = active();
  const task = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; ownerKey: string };
  const base = task().workflow;
  const store = (name: string, text: string): WorkflowArtifact => {
    const objectKey = `private/${task().ownerKey}/${workspaceId}/${taskId}/${name}`;
    harness.s3.objects.set(objectKey, text);
    return { id: `artifact-${name}`, type: name.startsWith("requirements") ? "requirements" : "design", version: 1, sha256: sha256(text), producer: "agentx-worker-untrusted", objectKey, createdAt: NOW, format: "markdown" };
  };
  const requirements = store("requirements-v1.md", REQUIREMENTS);
  const design = store("design-v1.md", DESIGN);
  let workflow = createWorkflowSnapshot({ taskId, ownerId: base.ownerId, now: NOW, path: "QUICK", definitionVersion: "1.1.0", program: base.program as WorkflowProgram });
  workflow = { ...workflow, state: "READY" };
  workflow = enableDesignReview(workflow, { expectedRevision: workflow.revision, start: { decidedBy: "auto", reasons: ["new_api"], note: "Adds a retry.", tier: "standard", capUsd: 10 }, now: NOW });
  const running = (value: WorkflowSnapshot): WorkflowSnapshot => ({ ...value, revision: value.revision + 1, state: "RUNNING" });
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: requirements, now: NOW });
  workflow = decideWorkflow(workflow, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: requirements.sha256 },
    { actorId: base.ownerId, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });
  workflow = WorkflowSnapshotSchema.parse(submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: design, now: NOW }));
  // The harness gives the task $2; the calibrated reviewer estimate (FU3) is above that for one round, so the task gets room (the test is about keys, not the task limit).
  harness.db.set({ ...task(), workflow, budgetUsd: 50 });
  harness.db.set((workflowDispatchItem("state", taskId, workflow.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item);
  await harness.finish(workspaceId, planner, "SUCCEEDED");
  const operations = () => harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.workflowMode === "PLAN_CRITIQUE");
  return { ...harness, access, taskId, workspaceId, task, operations, planner };
}

const HAIKU = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5" };

/** The design review's operation and what its worker was sent. `haiku`: the round runs on Haiku 5.5 with the operation routed to it, as staging's first round was. */
function reviewOperation(w: Awaited<ReturnType<typeof world>>, options: { haiku?: boolean } = {}) {
  const [operation] = w.operations();
  expect(operation, "the dispatch created the design review's operation").toBeDefined();
  if (options.haiku === true) {
    const stored = operation!.designReview as { reviewers: Array<Record<string, unknown>>; merge: Record<string, unknown> };
    w.db.set({ ...operation!, model: HAIKU, modelRoute: { sourceId: "rovara", alias: HAIKU.modelId, model: HAIKU }, designReview: { ...stored, reviewers: stored.reviewers.map((entry) => ({ ...entry, model: HAIKU })), merge: { ...stored.merge, model: HAIKU } } });
  }
  const current = w.operations()[0]!;
  const outbox = w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === current.id)[0]!;
  const invocation = outbox.invocation as { callbackCapability: string; payload: Parameters<typeof resolveTaskSessionModel>[0] & { workflowMode?: string; designReview?: unknown } };
  const binding = DesignReviewBindingSchema.parse(current.designReview);
  return { operation: current, binding, capability: invocation.callbackCapability, payload: { ...invocation.payload, designReview: binding } };
}

const capabilityOf = (w: Awaited<ReturnType<typeof world>>, operationId: string): string => (w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string }).callbackCapability;

/** The worker's transport, answered by the real broker handler; every request is recorded with its answer. */
function brokerTransport(w: Awaited<ReturnType<typeof world>>, capability: string) {
  const asked: string[] = [];
  const transport = (async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const reply = await rawGet(w.handler, path, capability);
    asked.push(`${reply.status} ${path}`);
    return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { asked, transport };
}

describe("a design review of a task with a pinned model policy", () => {
  it.each([["the dispatch's own model", false], ["Haiku 5.5, routed (staging's first round)", true]] as const)("gives every slot of the round its own key through the real handler: %s", async (_name, haiku) => {
    const w = await world();
    const { operation, binding, capability } = reviewOperation(w, { haiku });
    // The production shape: the pinned recipe's plan-check stage, the task's model authority and a route, like the planner's operation.
    expect(operation).toMatchObject({ kind: "task", workflowMode: "PLAN_CRITIQUE", modelPolicy: { version: 1, stage: "plan_check", companyRevision: 0 }, modelTaskId: w.taskId, modelRoute: { sourceId: "rovara" } });
    expect(w.db.get(`DEVTASK#${w.taskId}`, "RECIPE")).toHaveProperty("modelPolicyPin");
    for (const slot of [...binding.reviewers.map((entry) => entry.keySlot), binding.merge!.keySlot]) {
      const reply = await rawGet(w.handler, `/v1/internal/model-access?slot=${slot}`, capability);
      expect(reply.status, `${slot}: ${reply.body}`).toBe(200);
    }
    expect(w.access.mintKey).toHaveBeenCalledTimes(4);
  });

  it.each([["the dispatch's own model", false], ["Haiku 5.5, routed (staging's first round)", true]] as const)("the worker opens the operation's own session without asking for a key, and each reviewer gets its slot's key: %s", async (_name, haiku) => {
    const w = await world();
    const { binding, capability, payload } = reviewOperation(w, { haiku });
    const { asked, transport } = brokerTransport(w, capability);
    // As main.ts builds the operation's own proxy and session model, and opens the session's model runtime (pi-session.ts createProxyPiSessionAdapter).
    const proxy = operationModelProxy({ payload, proxyUrl: PROXY_URL, controlPlaneUrl: "http://broker.invalid", capability, fetch: transport });
    expect(proxy).toBeDefined();
    const session = await resolveTaskSessionModel(payload, undefined, {}, undefined, proxy);
    const route = (payload as { modelRoute?: InvocationModelRoute }).modelRoute;
    await expect(workerModelRuntime(session.model, undefined, undefined, route === undefined ? proxy : { ...proxy!, route })).resolves.toBeDefined();
    // Staging's failure: opening that session asked the broker for the operation's own key, which a design review never has (403), and the run ended at once.
    expect(asked).toEqual([]);
    expect(w.access.mintKey).not.toHaveBeenCalled();
    // Positive control: each reviewer's own runtime (as the worker builds it) asks for its slot's key and gets it.
    const runtimeFor = slotRuntimeFor({ controlPlaneUrl: "http://broker.invalid", capability, proxyUrl: PROXY_URL, binding, environment: {}, fetch: transport });
    for (const entry of binding.reviewers) await expect(runtimeFor({ purpose: "reviewer", keySlot: entry.keySlot, role: entry.role } as never).keyId!()).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(asked).toEqual(binding.reviewers.map((entry) => `200 /v1/internal/model-access?slot=${entry.keySlot}`));
  });

  it("an operation key asked for a design review is refused, logged with its code, and the worker's error says the status and code", async () => {
    const w = await world();
    const { operation, capability } = reviewOperation(w);
    const { asked, transport } = brokerTransport(w, capability);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const proxy = lazyModelProxy({ baseUrl: PROXY_URL, source: modelAccessSource({ controlPlaneUrl: "http://broker.invalid", capability, fetch: transport }) });
    const error = await workerModelRuntime({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5" }, undefined, undefined, proxy).then(() => undefined, (failure: unknown) => failure as Error);
    const lines = logs.mock.calls.map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } });
    logs.mockRestore();
    expect(asked).toEqual(["403 /v1/internal/model-access"]);
    expect(error?.message).toBe("RUNTIME_UNAVAILABLE: the model proxy key could not be obtained: model access request failed with HTTP 403 (FORBIDDEN)");
    expect(lines.filter((line) => line.event === "design_review.slot_key_refused")).toEqual([{ component: "broker", event: "design_review.slot_key_refused", operationId: operation.id, slot: "none", code: "FORBIDDEN" }]);
  });

  it("a round whose reviewers' model the account may not use is tried again on the next usable model (learned from the structured code), and that round runs", async () => {
    const learned = new Set<string>();
    const w = await world({ learned });
    const { operation, binding, capability } = reviewOperation(w);
    const first = DesignReviewBindingSchema.parse(operation.designReview).reviewers[0]!.model;
    // Every reviewer's model call is refused as not enabled (the proxy's 403); the worker uploads its result and, as its real code decides (modelUnusableRound), ends the operation with the coded failure.
    const result = {
      version: 1, round: binding.round, merge: { status: "skipped", tokensIn: 0, tokensOut: 0, costUsd: 0 }, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false,
      reviewers: binding.reviewers.map((entry) => ({ role: entry.role, keySlot: entry.keySlot, status: "no_result", failure: "model_not_enabled", retried: false, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-03T12:10:00.000Z", endedAt: "2026-11-03T12:10:01.000Z" })),
    };
    const ended = modelUnusableRound(DesignReviewWorkerResultSchema.parse(result));
    expect(ended).toBeDefined();
    await w.artifact(w.workspaceId, String(operation.id), "design-review.json", JSON.stringify(result));
    // The terminal result carries the structured code, as the worker's server sends it (server.ts checksResult).
    await w.finish(w.workspaceId, String(operation.id), "FAILED", { error: ended!.message, result: { modelFailureCode: modelFailureCodeOf(ended) } });
    expect(learned).toEqual(new Set([canonicalModelName(first)]));
    // The same round again (not "did not run"), on another model, with fresh slots and keys.
    const rounds = w.operations().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    expect(w.task().workflow.designReview).toMatchObject({ status: "running", rounds: [] });
    expect(w.task().workflow.designReview?.notRunReason).toBeUndefined();
    expect(rounds).toHaveLength(2);
    const second = DesignReviewBindingSchema.parse(rounds[1]!.designReview);
    expect(canonicalModelName(second.reviewers[0]!.model)).not.toBe(canonicalModelName(first));
    for (const slot of [...second.reviewers.map((entry) => entry.keySlot), second.merge!.keySlot]) {
      const reply = await rawGet(w.handler, `/v1/internal/model-access?slot=${slot}`, capabilityOf(w, String(rounds[1]!.id)));
      expect(reply.status, `${slot}: ${reply.body}`).toBe(200);
    }
    expect(capability).not.toBe(capabilityOf(w, String(rounds[1]!.id)));
  });
});
