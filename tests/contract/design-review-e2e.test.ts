// Design review stage, DR7 slice B: the whole round trip through the real broker over a fake table, a fake model proxy and a fake worker. A Full task whose design was just submitted is started by the dispatch
// (proxy check, packets built by the broker, estimate, cost gate, budgets, stored packets, the operation created WITH its binding in one write); the "worker" fetches its packets, asks for one key per slot and uploads
// `design-review.json`; the broker verifies, assembles, records the round with the proxy-measured spend and releases the keys; the planner's side is applied by `applyPlannerResolve`; round 2 runs on the revised design; the
// design ends on the person's card. Also: a voided reviewer, a slot asked twice, a round that stops at the cap, a hold for cost, no proxy, and the OFF switch.
import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, DesignReviewBindingSchema, PacketDeliverySchema, WORKFLOW_BLOCK_REASONS, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, WorkflowSnapshotSchema, createWorkflowSnapshot, decideWorkflow, enableDesignReview, packetDigestOf, submitWorkflowArtifact,
  type DesignReviewBinding, type ReviewerRole, type WorkflowArtifact, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import { designSpendCommitItems } from "../../packages/broker/src/design-review/spend-follow.js";
import { designAnswersCommitItems } from "../../packages/broker/src/design-review/answers.js";
import { designDocumentKey } from "../../packages/broker/src/design-review/template-store.js";
import { designReviewKeyIds } from "../../packages/broker/src/design-review/slot-keys.js";
import { readSlotPacket } from "../../packages/broker/src/design-review/packet-store.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey, modelKeyKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { TEST_ORG } from "../support/orgs.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const NOW = "2026-11-03T12:00:00.000Z";
const LATER = "2026-11-03T12:05:00.000Z";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-19T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

const REQUIREMENTS = "# Requirements\n\nR1: A payment that times out is retried once.\nR2: A payment is never charged twice.\n";
const DESIGN_V1 = "# Design\n\n## 1. Problem and goal\nR1 and R2.\n\n## 3. Proposed design\n### 3.1 Retry\nR1: retry a timed-out payment once. R2: use the payment id as the idempotency key.\n";

/** A design in the Rovara template: eight sections and the strict meta block. `three` is the body of §3. */
const templateDesign = (three: string, meta: Record<string, unknown> = {}): string => [
  "# Design", "## §1 Problem and goal", "R1 and R2.", "## §2 Current system, as it is today", "A timeout throws (src/charge.ts:10).", "## §3 Proposed design", three, "## §4 Alternatives considered", "None.",
  "## §5 Risks, failure behaviour, rollback", "Retries are bounded.", "## §6 Areas touched", "See the block.", "## §7 Assumptions", "None.", "## §8 Sources", "See the block.",
  "```rovara-design-meta", JSON.stringify({ touches: ["new_api"], repositories: ["demo"], services: [], sources: [{ kind: "repo_file", repo: "demo", ref: "src/charge.ts" }], ...meta }), "```",
].join("\n");
const DESIGN_T1 = templateDesign("### 3.1 Retry\nR1: retry a timed-out payment once. R2: use the payment id as the idempotency key.");
const DESIGN_T2 = templateDesign("### 3.1 Retry\nR1: retry a timed-out payment once. R2: use the payment id as the idempotency key.\n### 3.2 Limit\nThe retry happens at most three times, with a growing wait.");
const resolveBlock = (value: unknown): string => `\n\n\`\`\`rovara-design-resolve\n${JSON.stringify(value)}\n\`\`\`\n`;

type World = Awaited<ReturnType<typeof world>>;

/** A v2 task whose design was just submitted for review: PLAN_CRITIQUE/READY, review "estimating", the documents stored and digest-checked. */
async function world(options: { modelAccess?: boolean; capUsd?: number; tier?: "light" | "standard" | "thorough"; start?: boolean; requirements?: string; design?: string; draft?: string } = {}) {
  const access = fakeModelAccess();
  const harness = await createSingleAnswerPlanBroker({
    brokerExtra: { agents: {}, cloud: true, ...(options.modelAccess === false ? {} : { modelAccess: { access, proxyUrl: PROXY_URL } }) },
  });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
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
  workflow = enableDesignReview(workflow, { expectedRevision: workflow.revision, start: { decidedBy: "auto", reasons: ["new_api"], note: "Adds a retry.", tier: options.tier ?? "standard", capUsd: options.capUsd ?? 10 }, now: NOW });
  const running = (value: WorkflowSnapshot): WorkflowSnapshot => ({ ...value, revision: value.revision + 1, state: "RUNNING" });
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: requirements, now: NOW });
  workflow = decideWorkflow(workflow, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: requirements.sha256 },
    { actorId: owner, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });
  // `draft`: the planner is still writing the DESIGN (PLAN/RUNNING); its answer is the template, uploaded below, and the broker stores it.
  if (options.draft !== undefined) {
    harness.db.set({ ...task(), workflow: WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" }) });
    await harness.artifact(workspaceId, planner, "plan.md", options.draft);
    await harness.finish(workspaceId, planner, "SUCCEEDED");
    const draftOperations = () => harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.workflowMode === "PLAN_CRITIQUE").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { ...harness, access, taskId, workspaceId, task, operations: draftOperations, plannerOps: () => planOps(harness, workspaceId), store, requirements, design, owner, running, active, sweep: () => harness.handler({ source: "agentx.workflow-dispatch-recovery" }) as Promise<unknown>, planner };
  }
  workflow = WorkflowSnapshotSchema.parse(submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: design, now: NOW }));
  harness.db.set({ ...task(), workflow });
  const hold = options.start === false;
  if (!hold) harness.db.set((workflowDispatchItem("state", taskId, workflow.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item);
  // The planner's own run ends (its result is late: the workflow is no longer planning), which frees the workspace and runs the task's due rows: the design review starts.
  await harness.finish(workspaceId, planner, "SUCCEEDED");
  const operations = () => harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.workflowMode === "PLAN_CRITIQUE").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { ...harness, access, taskId, workspaceId, task, operations, plannerOps: () => planOps(harness, workspaceId), store, requirements, design, owner, running, active, sweep: () => harness.handler({ source: "agentx.workflow-dispatch-recovery" }) as Promise<unknown>, planner };
}

/** The planning operations the design review started to answer its findings (`planRevision`), oldest first. */
function planOps(harness: { db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> } }, workspaceId: string) {
  return harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.workflowMode === "PLAN" && item.planRevision === true).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Raw reply of the broker, as the worker sees it. */
async function rawGet(handler: (event: never) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>, path: string, capability: string) {
  const response = await handler({
    version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { "x-agentx-callback-capability": capability },
    requestContext: { requestId: randomUUID(), http: { method: "GET" } },
  } as never);
  return { status: response.statusCode, body: response.body };
}

interface Reviewer {
  /** What it reports: the digest it fetched (default: the binding's), and the key it names (default: its own). */
  reportedDigest?: string;
  /** The reviewer's answer block. */
  findings?: unknown[];
  /** Ask for the slot's key twice. */
  asksTwice?: boolean;
  /** Does not run at all. */
  absent?: boolean;
  /** What its key spent, in dollars. */
  spentUsd?: number;
  /** The stored packet of its slot is gone (expired, damaged) before the result is read. */
  packetLost?: boolean;
}

/** The worker of one operation: fetches each reviewer's packet, asks for each slot's key, and uploads `design-review.json`. Returns what it did, for the assertions. */
async function runWorker(w: World, operationId: string, reviewers: Partial<Record<ReviewerRole, Reviewer>> = {}, options: { mergeSpentUsd?: number; skipMerge?: boolean; failure?: { error: string } } = {}) {
  const outbox = w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
  const invocation = outbox.invocation as { callbackCapability: string; payload: { designReview: DesignReviewBinding; workflowMode: string } };
  const capability = invocation.callbackCapability;
  const binding = DesignReviewBindingSchema.parse(invocation.payload.designReview);
  const outcomes: unknown[] = [];
  const keys: Record<string, string> = {};
  for (const entry of binding.reviewers) {
    const spec = reviewers[entry.role] ?? {};
    if (spec.absent === true) continue;
    const packet = await rawGet(w.handler, `/v1/internal/design-review/packet?slot=${entry.keySlot}`, capability);
    expect(packet.status, packet.body).toBe(200);
    const delivery = PacketDeliverySchema.parse(JSON.parse(packet.body));
    expect(packetDigestOf(delivery)).toBe(entry.packetDigest);
    const key = await rawGet(w.handler, `/v1/internal/model-access?slot=${entry.keySlot}`, capability);
    expect(key.status, key.body).toBe(200);
    const apiKey = (JSON.parse(key.body) as { apiKey: string }).apiKey;
    keys[entry.role] = apiKey;
    w.access.setKeySpent(apiKey, spec.spentUsd ?? 0.1);
    if (spec.packetLost === true) w.db.delete(`ORG#${TEST_ORG}#DESIGN_REVIEW#${operationId}`, `PACKET#R1#${entry.keySlot}#HEAD`);
    if (spec.asksTwice === true) expect((await rawGet(w.handler, `/v1/internal/model-access?slot=${entry.keySlot}`, capability)).status).toBe(403);
    const comprehension = entry.role === "comprehension";
    const block = JSON.stringify({ ...(comprehension ? { paraphrase: { proposes: "Retry a timed-out payment once.", today: "A timeout throws." } } : {}), findings: spec.findings ?? [] });
    outcomes.push({
      role: entry.role, keySlot: entry.keySlot, status: "answered", retried: false,
      report: { sessionId: `session-${operationId.slice(0, 8)}-${entry.role}`, packetDigest: spec.reportedDigest ?? entry.packetDigest, firstRequestMessages: 2, filesRead: [], tools: ["read", "grep"], modelKeyId: keyIdOf(apiKey) },
      answer: `I read the design.\n\n\`\`\`rovara-design-review\n${block}\n\`\`\`\n`, tokensIn: 5_000, tokensOut: 400, costUsd: 0.05, startedAt: "2026-11-03T12:10:00.000Z", endedAt: "2026-11-03T12:12:00.000Z",
    });
  }
  if (binding.merge !== undefined && options.skipMerge !== true) {
    const merge = await rawGet(w.handler, `/v1/internal/model-access?slot=${binding.merge.keySlot}`, capability);
    expect(merge.status, merge.body).toBe(200);
    keys.merge = (JSON.parse(merge.body) as { apiKey: string }).apiKey;
    w.access.setKeySpent(keys.merge, options.mergeSpentUsd ?? 0.05);
  }
  const result = {
    version: 1, round: binding.round, reviewers: outcomes,
    merge: { status: "no_result", tokensIn: 0, tokensOut: 0, costUsd: 0 }, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false,
  };
  await w.artifact(w.workspaceId, operationId, "design-review.json", JSON.stringify(result));
  await w.finish(w.workspaceId, operationId, options.failure === undefined ? "SUCCEEDED" : "FAILED", options.failure === undefined ? {} : { error: options.failure.error });
  return { binding, keys, capability };
}

const blocker = (id: string, text: string) => ({ id, severity: "blocker", section: "§3", text, citations: [{ kind: "design", section: "§3" }] });
const review = (w: World) => w.task().workflow.designReview!;
const canonicalModel = (model: unknown): string => JSON.stringify([(model as { provider: string }).provider, (model as { modelId: string }).modelId]);

describe("a Full task's design review, from the dispatch to the person's card", () => {
  it("runs 2 rounds with 3 reviewers each, one question card and a revised design, and ends on approve_design with measured spend and everything released", async () => {
    const w = await world();
    // ---- round 1: the dispatch started it.
    const [first] = w.operations();
    expect(first, "the dispatch created the design review's operation").toBeDefined();
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running", rounds: [] } });
    const operationId = String(first!.id);
    // The binding is on the operation as stored (the same write that created it), and the worker was sent it.
    const binding = DesignReviewBindingSchema.parse(first!.designReview);
    expect(binding.reviewers.map((entry) => entry.role)).toEqual(["comprehension", "critic", "codebase"]);
    expect(binding.merge?.prompt.id).toBe("design-review-merge");
    expect(binding.baseCommits).toEqual({ demo: "e".repeat(40) });
    expect(binding.reviewers.map((entry) => entry.keySlot)).toEqual(["r1-comprehension", "r1-critic", "r1-codebase"]);
    expect(binding.merge?.keySlot).toBe("r1-merge");
    const outbox = w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    expect((outbox.invocation as { payload: { designReview: unknown } }).payload.designReview).toEqual(binding);
    // The capability can read a packet and ask for a slot's key, and nothing else of the plan check's powers.
    const claims = JSON.parse(Buffer.from(String((outbox.invocation as { callbackCapability: string }).callbackCapability).split(".")[0]!, "base64url").toString("utf8")) as { actions: string[]; modelPolicy?: unknown };
    expect(claims.actions.sort()).toEqual(["artifacts", "design-review-packet", "events", "model-access", "result"]);
    expect(claims.modelPolicy).toBeUndefined();
    // The packets are stored and the budgets allocated, under the operation's id, before it ran.
    for (const entry of binding.reviewers) expect(await readSlotPacket({ documentClient: w.db, tableName: "state" }, TEST_ORG, operationId, 1, entry.keySlot)).toBeDefined();
    expect(w.db.get(`ORG#${TEST_ORG}#DESIGN_REVIEW#${operationId}`, "ALLOC")).toBeDefined();
    expect(review(w).estimateUsd).toBeGreaterThan(0);

    const run1 = await runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")], spentUsd: 0.4 }, comprehension: { spentUsd: 0.3 }, codebase: { spentUsd: 0.2 } }, { mergeSpentUsd: 0.1 });
    // The round is recorded: three verified reviewers (by packet digest, honestly said), the measured spend, the finding, and the review waits for the planner.
    const afterOne = w.task().workflow;
    // ... and the planner's resolve run starts at once (the CRITIC_REPLAN row is due), so the review stands at PLAN/RUNNING "resolving".
    expect(afterOne).toMatchObject({ stage: "PLAN", state: "RUNNING", designReview: { status: "resolving" } });
    const round1 = review(w).rounds[0]!;
    expect(round1.reviewers.map((run) => [run.role, run.verified, run.inputProof])).toEqual([["comprehension", true, "digest_only"], ["critic", true, "digest_only"], ["codebase", true, "digest_only"]]);
    expect(round1.reviewers.map((run) => run.costUsd)).toEqual([0.3, 0.4, 0.2]);
    expect(round1.reviewers.every((run) => run.modelKeyId === keyIdOf(run1.keys[run.role]!))).toBe(true);
    expect(round1.reviewers[0]!.paraphrase).toBe("Proposes: Retry a timed-out payment once. Today, per the design: A timeout throws.");
    expect(round1.findings.map((finding) => [finding.severity, finding.text])).toEqual([["blocker", "Retries have no upper bound."]]);
    expect(round1.droppedFindings).toBeUndefined();
    expect(review(w).spentUsd).toBeCloseTo(0.3 + 0.4 + 0.2 + 0.1, 6);
    // Released: no packet is left to fetch, and every slot key was blocked at the proxy.
    expect(await readSlotPacket({ documentClient: w.db, tableName: "state" }, TEST_ORG, operationId, 1, "r1-critic")).toBeUndefined();
    for (const key of Object.values(run1.keys)) expect(w.access.blockKey).toHaveBeenCalledWith(keyIdOf(key));
    // ... and finalized at once (the hold released), which the operation's own end alone would not have done yet.
    for (const key of Object.values(run1.keys)) expect(w.db.get(modelKeyKey(TEST_ORG, keyIdOf(key)))).toMatchObject({ finalized: true });
    expect((await rawGet(w.handler, "/v1/internal/design-review/packet?slot=r1-critic", run1.capability)).status).toBeGreaterThanOrEqual(400);

    // ---- the planner's resolve run starts by itself (the CRITIC_REPLAN row is due for a design review), in the task's own conversation, with the registered resolve prompt and the findings as data.
    const findingId = round1.findings[0]!.id;
    expect(afterOne).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    const [resolveOne] = w.plannerOps();
    expect(resolveOne, "the planner's resolve run was started").toBeDefined();
    expect(resolveOne!.conversationId).toBe(String(w.task().conversationId));
    const resolveInvocation = (w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === resolveOne!.id)[0]!.invocation as { payload: { prompt: string; workflowPhase?: string; planFormat?: string; designReview?: unknown } }).payload;
    expect(resolveInvocation.workflowPhase).toBe("DESIGN");
    // The design is written in the template as Markdown, not as structured claims, and the run is not a design-review round.
    expect(resolveInvocation.planFormat).toBeUndefined();
    expect(resolveInvocation.designReview).toBeUndefined();
    expect(resolveInvocation.prompt).toContain("YOUR ROLE: the design's author, answering a review.");
    expect(resolveInvocation.prompt).toContain(`[${findingId}] blocker`);
    expect(resolveInvocation.prompt).toContain("Retries have no upper bound.");
    expect(resolveInvocation.prompt).toContain('<source-file kind="findings"');

    // ---- the planner needs a person: it asks, and the broker (never the planner) stores one question card and waits.
    const questions = [{ id: "q1", unclear: "How many retries are allowed?", evidence: [{ kind: "design", section: "§3" }], options: [{ id: "a", label: "Three", consequence: "Most timeouts clear." }, { id: "b", label: "Five", consequence: "Customers wait." }], recommended: "a", why: "Fewer waits." }];
    await w.artifact(w.workspaceId, String(resolveOne!.id), "plan.md", `${DESIGN_T1}${resolveBlock({ resolutions: [{ findingId, action: "asked", note: "Depends on a team rule.", questionId: "q1" }], questions })}`);
    await w.finish(w.workspaceId, String(resolveOne!.id), "SUCCEEDED");
    expect(w.task().workflow).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers" } });
    expect(review(w).rounds[0]!.questions).toHaveLength(1);
    expect(w.plannerOps()).toHaveLength(1);

    // ---- the person answers; the answer and the planner's next run are one transaction, and the planner runs again.
    const commit = designAnswersCommitItems({ tableName: "state", taskId: w.taskId, workflow: w.task().workflow, answers: [{ questionId: "q1", optionId: "a" }], actorId: w.owner, now: new Date().toISOString() });
    await w.db.send(new TransactWriteCommand({ TransactItems: commit.items as never }));
    expect(w.task().workflow).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    await w.sweep();
    const [, resolveTwo] = w.plannerOps();
    expect(resolveTwo, "the answers resumed the planner").toBeDefined();
    const secondPrompt = (w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === resolveTwo!.id)[0]!.invocation as { payload: { prompt: string } }).payload.prompt;
    expect(secondPrompt).toContain("A person answered your question card");
    expect(secondPrompt).toContain("chose a) Three");
    // The planner fixes the design: the BROKER stores the revised document under its own digest, and the resolution is applied.
    await w.artifact(w.workspaceId, String(resolveTwo!.id), "plan.md", `${DESIGN_T2}${resolveBlock({ resolutions: [{ findingId, action: "asked", note: "Three, as the person said.", questionId: "q1" }], questions })}`);
    await w.finish(w.workspaceId, String(resolveTwo!.id), "SUCCEEDED");
    const stored = w.task().workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1)!;
    expect(stored).toMatchObject({ format: "markdown", sha256: sha256(DESIGN_T2) });
    expect(stored.objectKey).toBe(designDocumentKey(w.task().ownerKey, w.workspaceId, stored.id));
    expect(w.s3.objects.get(stored.objectKey)).toBe(DESIGN_T2);
    const design2 = stored;

    // ---- round 2: an answered question that changed the design earns a second read (3.2 as changed 2026-11-03), priced afresh; the dispatch started it at once.
    expect(review(w).rounds[0]!.resolutions).toEqual([expect.objectContaining({ findingId, action: "asked", settled: true })]);
    const [, second] = w.operations();
    expect(second, "round 2 has an operation of its own").toBeDefined();
    expect(DesignReviewBindingSchema.parse(second!.designReview).round).toBe(2);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running" } });
    await runWorker(w, String(second!.id), { comprehension: { spentUsd: 0.2 }, critic: { spentUsd: 0.2 }, codebase: { spentUsd: 0.2 } }, { mergeSpentUsd: 0.1 });
    // No findings: the review is over, and the design waits on the person's card.
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(review(w).rounds).toHaveLength(2);
    expect(review(w).rounds[1]!.designDigest).toBe(design2.sha256);
    expect(review(w).spentUsd).toBeCloseTo(1.0 + 0.7, 6);
    expect(review(w).approvals).toBeUndefined();
  });
});

describe("what a round does with a reviewer it cannot trust", () => {
  it("voids a reviewer whose report names another packet, fails a slot that asked for its key twice closed, charges both honestly, and uses only the verified reviewer's findings", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const wrongDigest = "f".repeat(64);
    const run = await runWorker(w, operationId, {
      critic: { findings: [blocker("1", "Retries have no upper bound.")], spentUsd: 0.2 },
      // Voided: it says it read a packet the broker did not build. Its blocker is dropped before anything is read.
      codebase: { reportedDigest: wrongDigest, findings: [blocker("1", "Every route is open to the world.")], spentUsd: 0.3 },
      // Asked for its key a second time: the slot's key is blocked and the slot has no result, but it is charged its key's whole budget.
      comprehension: { asksTwice: true, spentUsd: 0.05 },
    });
    const round = review(w).rounds[0]!;
    const byRole = new Map(round.reviewers.map((entry) => [entry.role, entry] as const));
    expect(byRole.get("critic")).toMatchObject({ verified: true, inputProof: "digest_only", costUsd: 0.2 });
    expect(byRole.get("codebase")).toMatchObject({ verified: false, verifyFailure: "packet_digest_mismatch", costUsd: 0.3 });
    expect(byRole.get("codebase")!.inputProof).toBeUndefined();
    expect(byRole.get("comprehension")).toMatchObject({ verified: false, verifyFailure: "model_key_mismatch" });
    // Only the verified reviewer's finding is on the record, with no trace of the voided reviewer's words.
    expect(round.findings.map((finding) => finding.text)).toEqual(["Retries have no upper bound."]);
    expect(JSON.stringify(review(w))).not.toContain("Every route is open");
    // The re-asked slot is charged the whole of its key's budget (not what the worker said), and the key was blocked when it asked again.
    const keys = await designReviewKeyIds({ documentClient: w.db, tableName: "state" }, w.operations()[0] as never);
    const budget = keys.budgetUsdBySlot.get("r1-comprehension")!;
    expect(budget).toBeGreaterThan(0.05);
    expect(byRole.get("comprehension")!.costUsd).toBe(budget);
    expect(keys.askedAgain.get("r1-comprehension")).toBe(keyIdOf(run.keys.comprehension!));
    // The total counts every one of them: 0.2 + 0.3 + the whole budget of the re-asked slot + the merge step's 0.05.
    expect(review(w).spentUsd).toBeCloseTo(0.2 + 0.3 + budget + 0.05, 6);
    // The worker's own cost figure (0.05 on every outcome) was never used.
    expect(round.reviewers.map((entry) => entry.costUsd)).not.toContain(0.05);
  });

  it("does not count a reviewer the worker flagged, a reviewer missing from the upload, or a result for another round", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    await runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")] }, codebase: { absent: true }, comprehension: { absent: true } });
    const runs = new Map(review(w).rounds[0]!.reviewers.map((entry) => [entry.role, entry] as const));
    expect(runs.get("critic")!.verified).toBe(true);
    // A reviewer that never ran has no key, no session and no cost, and is recorded as having given no result.
    expect(runs.get("codebase")).toMatchObject({ verified: false, verifyFailure: "unreadable_output", modelKeyId: "none", sessionId: "none", costUsd: 0 });
    expect(runs.get("comprehension")).toMatchObject({ verified: false, costUsd: 0 });
  });
});

describe("what the broker checks about the packets and the pins itself", () => {
  const code = (commit: string) => ({ kind: "code", repo: "demo", path: "src/charge.ts", startLine: 1, endLine: 3, anchor: "const x", commit });

  it("accepts a code citation at the commit the BROKER pinned, and drops one at any other (the worker's own pins and claims count for nothing)", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const pinned = { id: "1", severity: "major", section: "§2", text: "Today a timeout throws.", citations: [code("e".repeat(40))] };
    const elsewhere = { id: "1", severity: "blocker", section: "§2", text: "The auth check is missing.", citations: [code("d".repeat(40))] };
    await runWorker(w, operationId, { critic: { findings: [pinned] }, codebase: { findings: [elsewhere] } });
    const round = review(w).rounds[0]!;
    expect(round.findings.map((finding) => finding.text)).toEqual(["Today a timeout throws."]);
    expect(round.droppedFindings).toEqual([{ role: "codebase", severity: "blocker", section: "§2" }]);
  });

  it("does not count a reviewer whose stored packet can no longer be read back: its citations cannot be checked", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    await runWorker(w, operationId, { critic: { packetLost: true, findings: [blocker("1", "Retries have no upper bound.")] }, codebase: { findings: [blocker("1", "Every retry is logged twice.")] } });
    const byRole = new Map(review(w).rounds[0]!.reviewers.map((entry) => [entry.role, entry] as const));
    expect(byRole.get("critic")).toMatchObject({ verified: false, verifyFailure: "packet_digest_mismatch" });
    expect(byRole.get("codebase")!.verified).toBe(true);
    expect(review(w).rounds[0]!.findings.map((finding) => finding.text)).toEqual(["Every retry is logged twice."]);
  });
});

describe("how a round ends short of a result", () => {
  it("stops at the cost cap when the measured spend takes the total past it, and starts no second round", async () => {
    const w = await world({ capUsd: 2 });
    const operationId = String(w.operations()[0]!.id);
    // The merge step is not reached: the reviewers alone spend 2.1 against the 2 cap.
    await runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")], spentUsd: 0.7 }, comprehension: { spentUsd: 0.7 }, codebase: { spentUsd: 0.7 } }, { skipMerge: true });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "stopped_at_cap" } });
    expect(review(w).spentUsd).toBeCloseTo(2.1, 6);
    expect(review(w).rounds[0]!.resolutions).toEqual([]);
    await w.sweep();
    expect(w.operations()).toHaveLength(1);
  });

  it("holds for the person's spend decision when the estimate is over what is left under the cap: nothing is built, stored, allocated or run", async () => {
    const w = await world({ capUsd: 0.5 });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost", rounds: [] } });
    expect(review(w).estimateUsd).toBeGreaterThan(0.5);
    expect(w.operations()).toHaveLength(0);
    expect(w.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET" || item.entityType === "DESIGN_REVIEW_ALLOCATION")).toEqual([]);
    expect(w.access.mintKey).not.toHaveBeenCalled();
  });

  it("does not run at all where there is no model proxy to mint a key per reviewer from: not run, and no operation", async () => {
    const w = await world({ modelAccess: false });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "no_verified_model" } });
    expect(w.operations()).toHaveLength(0);
    expect(w.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET")).toEqual([]);
  });

  it("ends the review as not run when the worker's run fails, charging what its keys cost and releasing the round", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const outbox = w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    // One reviewer got its key and spent before the run was lost.
    const key = JSON.parse((await rawGet(w.handler, "/v1/internal/model-access?slot=r1-critic", capability)).body) as { apiKey: string };
    w.access.setKeySpent(key.apiKey, 0.45);
    await w.finish(w.workspaceId, operationId, "FAILED", { error: "RUNTIME_UNAVAILABLE: the worker stopped" });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "worker_failed" } });
    expect(review(w).spentUsd).toBeCloseTo(0.45, 6);
    expect(w.access.blockKey).toHaveBeenCalledWith(keyIdOf(key.apiKey));
    expect(w.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET")).toEqual([]);
  });

  it("is not recorded twice: a late result for a workflow that already moved changes nothing", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    await runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")] } });
    const recorded = w.task().workflow;
    expect(recorded.designReview!.rounds).toHaveLength(1);
    await w.finish(w.workspaceId, operationId, "SUCCEEDED").catch(() => undefined);
    expect(w.task().workflow.revision).toBe(recorded.revision);
    expect(w.task().workflow.designReview!.rounds).toHaveLength(1);
  });
});

describe("the other ends a round has", () => {
  const unusable = "RUNTIME_UNAVAILABLE: the model call failed: model-not-found";

  it("stops at the cost cap when the run ran out of budget, charging what the keys spent", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const capability = ((w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const key = JSON.parse((await rawGet(w.handler, "/v1/internal/model-access?slot=r1-critic", capability)).body) as { apiKey: string };
    w.access.setKeySpent(key.apiKey, 0.3);
    await w.finish(w.workspaceId, operationId, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "stopped_at_cap" } });
    expect(review(w).spentUsd).toBeCloseTo(0.3, 6);
  });

  it("blocks, as the plan check does, when the base rule files could not be verified; the owner's retry resumes the review and starts it again at once, with its spend kept", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    await w.finish(w.workspaceId, operationId, "FAILED", { error: `RUNTIME_UNAVAILABLE: ${WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE}` });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified, designReview: { status: "running", spentUsd: 0 } });
    expect(w.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET")).toEqual([]);
    const reply = await w.dev(MAYA, "POST", `/v1/dev/tasks/${w.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Retry the design review.", expectedRevision: w.task().workflow.revision });
    expect(reply.status, JSON.stringify(reply.body)).toBeLessThan(300);
    // The owner's route now has the round's ports (B2 item 4), so the immediate start runs: the review starts again at once, with no row left for the sweep.
    expect(w.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "CRITIQUE")).toHaveLength(0);
    // The review is estimated and started again: a second operation of its own, round 1 again, nothing recorded for the blocked one.
    expect(w.operations()).toHaveLength(2);
    expect(DesignReviewBindingSchema.parse(w.operations()[1]!.designReview).round).toBe(1);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running", rounds: [] } });
  });

  it("tries the same round again on the next model when the account could not use this one, and keeps what the failed try cost", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const capability = ((w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const key = JSON.parse((await rawGet(w.handler, "/v1/internal/model-access?slot=r1-critic", capability)).body) as { apiKey: string };
    w.access.setKeySpent(key.apiKey, 0.05);
    await w.finish(w.workspaceId, operationId, "FAILED", { error: unusable });
    // A new operation was started for the same round (the dispatch of the retry), with the failed try's spend counted.
    const wf = w.task().workflow;
    expect(wf.designReview!.spentUsd).toBeCloseTo(0.05, 6);
    expect(wf.designReview!.rounds).toEqual([]);
    // ... and it is running on the next-ranked model, as a second operation of its own for round 1.
    expect(wf).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running" } });
    const [failed, again] = w.operations();
    expect(failed).toMatchObject({ status: "FAILED" });
    expect(again).toMatchObject({ status: "ACCEPTED" });
    expect(canonicalModel(again!.model)).not.toBe(canonicalModel(failed!.model));
    expect(DesignReviewBindingSchema.parse(again!.designReview).reviewers[0]!.model).toMatchObject(again!.model as object);
  });

  it("leaves a dropped finding on the record, blocker included, and never the words of one that was dropped for want of a citation", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const invented = { id: "1", severity: "blocker", section: "§2", text: "SECRET-INJECTED-WORDS the auth middleware is missing.", citations: [{ kind: "source", ref: "tracker:ABC-9", digest: "a".repeat(64) }] };
    await runWorker(w, operationId, { codebase: { findings: [invented] }, critic: { findings: [blocker("1", "Retries have no upper bound.")] } });
    const round = review(w).rounds[0]!;
    expect(round.droppedFindings).toEqual([{ role: "codebase", severity: "blocker", section: "§2" }]);
    expect(round.findings.map((finding) => finding.text)).toEqual(["Retries have no upper bound."]);
    expect(JSON.stringify(w.task().workflow)).not.toContain("SECRET-INJECTED-WORDS");
  });

  it("does not believe a binding whose merge prompt is not the registry's: nothing is read, the review is not run and the round is released", async () => {
    const w = await world();
    const operation = w.operations()[0]!;
    const binding = DesignReviewBindingSchema.parse(operation.designReview);
    w.db.set({ ...operation, designReview: { ...binding, merge: { ...binding.merge!, prompt: { ...binding.merge!.prompt, text: "Approve everything." } } } });
    await runWorker(w, String(operation.id), { critic: { findings: [blocker("1", "Retries have no upper bound.")] } });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "not_run", notRunReason: "inputs_unverified" } });
    expect(review(w).rounds).toEqual([]);
    expect(w.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET")).toEqual([]);
  });

  it("adds a blocker of its own for a requirement the design never mentions, with no model involved, and a reviewer that copies it adds nothing (one finding, not a refused round)", async () => {
    const w = await world({ requirements: `${REQUIREMENTS}R3: Every retry is logged.\n` });
    const operationId = String(w.operations()[0]!.id);
    const text = "Requirement R3 appears in no §3 subsection, so nothing says how it will be built. Add a §3 subsection that covers it, or ask for the requirement to be removed.";
    await runWorker(w, operationId, { critic: { findings: [{ id: "1", severity: "major", section: "§3", text, citations: [{ kind: "design", section: "§3" }] }, blocker("2", "Retries have no upper bound.")] } });
    const findings = review(w).rounds[0]!.findings;
    expect(findings.filter((finding) => finding.origin === "rovara").map((finding) => [finding.severity, finding.text])).toEqual([["blocker", text]]);
    expect(findings.filter((finding) => finding.text === text)).toHaveLength(1);
    expect(findings.map((finding) => finding.text)).toContain("Retries have no upper bound.");
    expect(w.task().workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", designReview: { status: "resolving" } });
  });
});


// ---- B2: the planner's side, the template, the spend card and the retry

/** A world stopped right after round 1 was recorded with one blocker, with the planner's resolve run started. */
async function afterRoundOne() {
  const w = await world();
  const operationId = String(w.operations()[0]!.id);
  await runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")], spentUsd: 0.4 }, comprehension: { spentUsd: 0.3 }, codebase: { spentUsd: 0.2 } }, { mergeSpentUsd: 0.1 });
  const findingId = review(w).rounds[0]!.findings[0]!.id;
  const [resolve] = w.plannerOps();
  expect(resolve, "the planner's resolve run was started").toBeDefined();
  return { w, findingId, resolveId: String(resolve!.id) };
}

describe("the planner's answer to the findings", () => {
  const answerWith = async (w: World, resolveId: string, text: string) => { await w.artifact(w.workspaceId, resolveId, "plan.md", text); await w.finish(w.workspaceId, resolveId, "SUCCEEDED"); };

  it("fixes, contests with evidence a reviewer could read, and goes on to round 2 only for a fixed blocker; the design is stored by the broker", async () => {
    const { w, findingId, resolveId } = await afterRoundOne();
    await answerWith(w, resolveId, `${DESIGN_T2}${resolveBlock({ resolutions: [{ findingId, action: "fixed", note: "Added §3.2." }] })}`);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", designReview: { status: "running" } });
    expect(review(w).rounds[0]!.resolutions).toEqual([expect.objectContaining({ findingId, action: "fixed", settled: false })]);
    expect(w.task().workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1)!.sha256).toBe(sha256(DESIGN_T2));
    // The second round is the last: its planner run (if any findings) may only fix or contest, and the bounds are the contract's (2 rounds, 2 revisions).
    expect(w.operations()).toHaveLength(2);
  });

  it("refuses evidence the reviewers could not have read: a contest that rests on a source item alone, or on a citation not in the round's packets, leaves the design as reviewed with the findings unresolved", async () => {
    const { w, findingId, resolveId } = await afterRoundOne();
    const sourceOnly = { findingId, action: "contested", note: "No, it is bounded.", evidence: [{ kind: "source", ref: "tracker:ABC-9", digest: "a".repeat(64) }] };
    await answerWith(w, resolveId, `${DESIGN_T1}${resolveBlock({ resolutions: [sourceOnly] })}`);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(review(w).rounds[0]!.resolutions).toEqual([]);
    expect(w.operations()).toHaveLength(1);
  });

  it("accepts a contest that cites the design itself (positive control for the evidence check): the finding is settled and no second round runs", async () => {
    const { w, findingId, resolveId } = await afterRoundOne();
    await answerWith(w, resolveId, `${DESIGN_T1}${resolveBlock({ resolutions: [{ findingId, action: "contested", note: "§3.1 bounds the retry to one.", evidence: [{ kind: "design", section: "§3" }] }] })}`);
    expect(review(w).rounds[0]!.resolutions).toEqual([expect.objectContaining({ findingId, action: "contested", settled: true })]);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
  });

  it("an answer that cannot be read leaves the design as reviewed, with the findings unresolved; it is never a plan check move", async () => {
    const { w, resolveId } = await afterRoundOne();
    await answerWith(w, resolveId, "I fixed everything, trust me.");
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(w.task().workflow.critique).toBeUndefined();
    expect(review(w).rounds[0]!.resolutions).toEqual([]);
  });

  it("a resolve run that ran out of its budget goes to the person as reviewed (skipPlanRevision, which refuses a design, is never called); a blocked run keeps the round's spend and the owner's Retry resumes the review", async () => {
    const budget = await afterRoundOne();
    await budget.w.finish(budget.w.workspaceId, budget.resolveId, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(budget.w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(budget.w.task().workflow.critique).toBeUndefined();

    const { w, resolveId } = await afterRoundOne();
    const spent = review(w).spentUsd;
    await w.finish(w.workspaceId, resolveId, "FAILED", { error: `RUNTIME_UNAVAILABLE: ${WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE}` });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified, designReview: { status: "resolving", spentUsd: spent } });
    const reply = await w.dev(MAYA, "POST", `/v1/dev/tasks/${w.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Retry.", expectedRevision: w.task().workflow.revision });
    expect(reply.status, JSON.stringify(reply.body)).toBeLessThan(300);
    // Resumed where it stood (the review's own move), not restarted as a plain planning run: a second resolve run, with the same spend, and no plan-check state.
    expect(w.plannerOps()).toHaveLength(2);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", designReview: { status: "resolving", spentUsd: spent } });
    expect(w.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
  });
});

describe("B-M2: a result that is computed again", () => {
  it("is recorded in full when its first commit failed: the packets were still there, the keys are charged once, and the packets go with the commit that records the round", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"status":"resolving"'), error: { name: "InternalServerError" } });
    await expect(runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")], spentUsd: 0.4 }, comprehension: { spentUsd: 0.3 }, codebase: { spentUsd: 0.2 } }, { mergeSpentUsd: 0.1 })).rejects.toBeDefined();
    expect(review(w).rounds).toEqual([]);
    // The failed attempt must not have thrown the packets away: the worker's resend finds them.
    expect(await readSlotPacket({ documentClient: w.db, tableName: "state" }, TEST_ORG, operationId, 1, "r1-critic")).toBeDefined();
    await w.finish(w.workspaceId, operationId, "SUCCEEDED");
    const round = review(w).rounds[0]!;
    expect(round.reviewers.map((run) => [run.role, run.verified, run.costUsd])).toEqual([["comprehension", true, 0.3], ["critic", true, 0.4], ["codebase", true, 0.2]]);
    expect(review(w).spentUsd).toBeCloseTo(1.0, 6);
    expect(await readSlotPacket({ documentClient: w.db, tableName: "state" }, TEST_ORG, operationId, 1, "r1-critic")).toBeUndefined();
  });

  it("B-m1 and B-m4: the keys are blocked BEFORE the spend is read (a request admitted at the block is counted), and an uncounted run stores no session id of the worker's", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    // The proxy counts a request it had already admitted when the key is blocked: reading the spend before the block would miss it.
    const blocked = new Set<string>();
    w.access.blockKey.mockImplementation(async (keyId: string) => { blocked.add(keyId); });
    const base = w.access.keySpend.getMockImplementation()!;
    w.access.keySpend.mockImplementation(async (keyIds: readonly string[]) => (await base(keyIds)) + keyIds.filter((id) => blocked.has(id)).length * 0.07);
    await runWorker(w, operationId, { critic: { findings: [blocker("1", "Retries have no upper bound.")], spentUsd: 0.4 }, codebase: { reportedDigest: "f".repeat(64) } });
    const runs = new Map(review(w).rounds[0]!.reviewers.map((run) => [run.role, run] as const));
    expect(runs.get("critic")!.costUsd).toBeCloseTo(0.47, 6);
    expect(runs.get("codebase")).toMatchObject({ verified: false, sessionId: "none" });
  });

  it("B-m3: a blocked round keeps what its keys cost, and the Retry adds nothing more", async () => {
    const w = await world();
    const operationId = String(w.operations()[0]!.id);
    const capability = ((w.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const key = JSON.parse((await rawGet(w.handler, "/v1/internal/model-access?slot=r1-critic", capability)).body) as { apiKey: string };
    w.access.setKeySpent(key.apiKey, 0.25);
    await w.finish(w.workspaceId, operationId, "FAILED", { error: `RUNTIME_UNAVAILABLE: ${WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE}` });
    expect(review(w).spentUsd).toBeCloseTo(0.25, 6);
    await w.dev(MAYA, "POST", `/v1/dev/tasks/${w.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Retry.", expectedRevision: w.task().workflow.revision });
    expect(review(w).spentUsd).toBeCloseTo(0.25, 6);
  });

  it("B-m8: a cancelled round is not run as `cancelled`, not as a worker failure", async () => {
    const w = await world();
    await w.finish(w.workspaceId, String(w.operations()[0]!.id), "CANCELLED");
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "not_run", notRunReason: "cancelled" } });
  });
});

describe("the design template", () => {
  it("is read strictly, stored as a Markdown document under its own digest, and sent to its review; every requirement id must be in §3 or the review adds a blocker", async () => {
    const w = await world({ draft: DESIGN_T1, requirements: `${REQUIREMENTS}R3: Every retry is logged.\n` });
    const design = w.task().workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1)!;
    expect(design).toMatchObject({ format: "markdown", sha256: sha256(DESIGN_T1) });
    expect(w.s3.objects.get(design.objectKey)).toBe(DESIGN_T1);
    expect(w.task().workflow).toMatchObject({ designReview: { status: "running" } });
    // §8's reading list reached the packets (names only): the reviewers' packet for the design holds the file the meta block named.
    const binding = DesignReviewBindingSchema.parse(w.operations()[0]!.designReview);
    const packet = await readSlotPacket({ documentClient: w.db, tableName: "state" }, TEST_ORG, String(w.operations()[0]!.id), 1, binding.reviewers[0]!.keySlot);
    expect(packet).toBeDefined();
    await runWorker(w, String(w.operations()[0]!.id), {});
    expect(review(w).rounds[0]!.findings.filter((finding) => finding.origin === "rovara").map((finding) => finding.text)).toEqual([expect.stringContaining("Requirement R3 appears in no §3 subsection")]);
  });

  it("a design with a section missing, or a meta block that does not read, is not stored: the step stops with the problems (and asks the planner once more where the self-check is on)", async () => {
    for (const draft of ["# Design\n## §1 Problem and goal\nR1 and R2.\n", DESIGN_T1.replace('"touches":["new_api"]', '"touches":["new_api"],"mystery":1')]) {
      const w = await world({ draft });
      expect(w.task().workflow.artifacts.filter((artifact) => artifact.type === "design")).toEqual([]);
      expect(w.operations()).toHaveLength(0);
      expect(w.task().workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.planUnreadable });
      const unreadable = (w.task() as unknown as { planUnreadable: { errors: string[] } }).planUnreadable;
      expect(unreadable.errors.join(" "), draft.slice(0, 30)).toMatch(/design lacks a heading|rovara-design-meta/u);
    }
  });
});

describe("the spend card's follow-through", () => {
  const commit = async (w: World, choice: Parameters<typeof designSpendCommitItems>[0]["write"]["applied"]) => {
    const result = designSpendCommitItems({ tableName: "state", taskId: w.taskId, workflow: w.task().workflow, write: { actorId: w.owner, applied: choice }, now: new Date().toISOString() });
    await w.db.send(new TransactWriteCommand({ TransactItems: result.items as never }));
    return result;
  };

  it("after a hold, raising the cap makes the round due at the new revision and the sweep starts it; the hold keeps the person's cap raise on the record", async () => {
    const w = await world({ capUsd: 0.5 });
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost" } });
    const raised = await commit(w, { choice: "raise_cap", newCapUsd: 20 });
    expect(raised.workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", capUsd: 20 } });
    expect(w.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "CRITIQUE" && item.workflowRevision === raised.workflow.revision)).toHaveLength(1);
    await w.sweep();
    expect(w.operations()).toHaveLength(1);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { status: "running", capUsd: 20, approvals: [expect.objectContaining({ kind: "raise_cap" })] } });
  });

  it("a lower tier does the same; a skip closes to the person's card with no row due", async () => {
    const lower = await world({ capUsd: 0.5 });
    const done = await commit(lower, { choice: "lower_tier", tier: "light" });
    expect(done.workflow).toMatchObject({ designReview: { status: "estimating", tier: "light" } });
    expect(lower.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "CRITIQUE")).toHaveLength(1);
    const skipped = await world({ capUsd: 0.5 });
    const closed = await commit(skipped, { choice: "skip" });
    expect(closed.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "skipped", decidedBy: "person_skip" } });
    expect(skipped.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
  });

  it("an unpriced-run approval is bound to the hold's revision and never lifts the cap: the row carries who approved, the hold stays, and no round starts over the cap", async () => {
    const w = await world({ capUsd: 0.5 });
    const hold = w.task().workflow;
    const approved = await commit(w, { choice: "run_unpriced", stopAtMeasuredUsd: 0.5 });
    expect(approved.workflow).toBe(hold);
    expect(w.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "CRITIQUE")).toEqual([expect.objectContaining({ workflowRevision: hold.revision, costApprovedBy: w.owner })]);
    await w.sweep();
    expect(w.operations()).toHaveLength(0);
    expect(w.task().workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", revision: hold.revision, designReview: { status: "waiting_cost" } });
    // A row whose revision is not the hold's is stale, whoever it names.
    expect(() => designSpendCommitItems({ tableName: "state", taskId: w.taskId, workflow: { ...hold, designReview: { ...hold.designReview!, status: "estimating" } }, write: { actorId: w.owner, applied: { choice: "run_unpriced", stopAtMeasuredUsd: 1 } }, now: NOW })).toThrow();
  });
});
