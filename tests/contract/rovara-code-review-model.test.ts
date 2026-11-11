// Trust fix A2: the code and security reviews of a Rovara Code (version 2) task default to a different model from the one that wrote the code. The choice is made like the plan check's
// (`reviewerModelFor` reuses the critic's pieces): the strongest model the project allows and the account can call, other than the builder's; only other companies' models when the
// company requires cross-company review; the builder's own model, with a note, when it is the only one usable. A model the company set on the step always stands.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_AGENT_GUARDRAILS, canonicalModelName, builtinRecipe, builtinDefaultPin, currentBuiltinVersion, BUILTIN_AGENTS, type ModelIdentifier, type ResolvedRecipe } from "@rovara-code/contracts";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { WorkflowReviewFindingSchema, createCandidateManifest } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { defaultWorkerModel } from "../../packages/broker/src/agents/dispatch.js";
import { reviewerModelFor, type ReviewerModelInput } from "../../packages/broker/src/rovara-code/reviewer-model.js";
import { REVIEW_SAME_MODEL_NOTE } from "../../packages/broker/src/rovara-code/review-model-lines.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { agentGuardrailsKey, builtinSettingsKey } from "@rovara-code/contracts";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
import { runLimitAck } from "../support/run-limit-ack.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

beforeAll(async () => {
  await loadSlackBroker();
});

const NOW = "2026-10-27T12:00:00.000Z";
const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const HAIKU: ModelIdentifier = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
const key = (model: { provider: string; modelId: string } | undefined) => (model === undefined ? undefined : `${model.provider}/${model.modelId}`);

const choose = (overrides: Partial<ReviewerModelInput> = {}) => reviewerModelFor({
  step: { settings: {} }, builderModel: SONNET, project: {}, guardrails: { forbiddenModels: [] }, sources: [SONNET, OPUS], ...overrides,
});

describe("reviewerModelFor", () => {
  it("builder Sonnet, project allows Opus and Sonnet: the reviewer is Opus, and it is Rovara's choice", () => {
    const chosen = choose();
    expect(chosen).toMatchObject({ chosenBy: "rovara", sameModelAsBuilder: false });
    expect(key("model" in (chosen ?? {}) ? (chosen as { model: ModelIdentifier }).model : undefined)).toBe(key(OPUS));
  });

  it("leaves a model the company set on the step (or its fallback) alone: nothing is chosen", () => {
    expect(choose({ step: { settings: { model: SONNET } } })).toEqual({ chosenBy: "company" });
    expect(choose({ step: { settings: { fallbackModel: GPT } } })).toEqual({ chosenBy: "company" });
  });

  it("requires another company when asked: builder Claude and an OpenAI model allowed gives the OpenAI model", () => {
    const chosen = choose({ sources: [SONNET, OPUS, GPT], differentCompanyFrom: [SONNET] });
    expect(chosen).toMatchObject({ chosenBy: "rovara", sameModelAsBuilder: false, model: { provider: "openai", modelId: "gpt-5.5" } });
  });

  it("chooses nothing when no other company is allowed, so the dispatch's own refusal stands", () => {
    expect(choose({ sources: [SONNET, OPUS], differentCompanyFrom: [SONNET] })).toBeUndefined();
  });

  it("never takes a model an earlier review found unusable: the strongest failed, so another tier is next", () => {
    const chosen = choose({ sources: [OPUS, SONNET, HAIKU], unusable: [OPUS] });
    expect(chosen).toMatchObject({ sameModelAsBuilder: false, model: { modelId: HAIKU.modelId } });
  });

  it("counts a failed model by its canonical name, so the same model reached another way is not tried again", () => {
    const opusOnBedrock: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-6-v1" };
    const chosen = choose({ sources: [opusOnBedrock, SONNET, HAIKU], unusable: [OPUS] });
    expect(chosen).toMatchObject({ model: { modelId: HAIKU.modelId } });
  });

  it("with only the builder's model allowed, uses it and says the same model reviewed", () => {
    expect(choose({ sources: [SONNET] })).toMatchObject({ chosenBy: "rovara", sameModelAsBuilder: true, model: { provider: "anthropic", modelId: "claude-sonnet-4-6" } });
  });

  it("on the last try, the builder's own model (which just answered this account) is the choice, with the note", () => {
    expect(choose({ sources: [OPUS, SONNET], unusable: [OPUS], lastAttempt: true })).toMatchObject({ sameModelAsBuilder: true, model: { modelId: SONNET.modelId } });
  });

  it("never takes a forbidden model or one outside the project's list", () => {
    expect(choose({ sources: [SONNET, OPUS, GPT], guardrails: { forbiddenModels: [OPUS] } })).toMatchObject({ model: { modelId: GPT.modelId } });
    expect(choose({ sources: [SONNET, OPUS, GPT], project: { approved: [SONNET, GPT] } })).toMatchObject({ model: { modelId: GPT.modelId } });
  });

  it("chooses nothing when nothing is known to choose from", () => {
    expect(choose({ sources: [], project: {} })).toBeUndefined();
  });

  it("without a known builder model takes the strongest allowed model", () => {
    expect(choose({ builderModel: undefined })).toMatchObject({ sameModelAsBuilder: false, model: { modelId: OPUS.modelId } });
  });
});

// ---- the whole path: the review step of a version 2 task

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const CLAIMS = [
  { id: "1", text: "Payments that fail with a timeout are retried.", evidence: [{ kind: "code" as const, path: "payments/src/charge.ts", startLine: 10, endLine: 24, note: "Today a timeout throws." }] },
  { id: "2", text: "A test proves a timed-out payment is retried once and never charged twice." },
];
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64),
  checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }],
  extraTry: "not_needed", agentClaim: "success" });
const CLAUDE_DEFAULT = defaultWorkerModel();
const OTHER_CLAUDE: ModelIdentifier = { provider: "amazon-bedrock", modelId: bedrockClaudeModelIds().find((id) => canonicalModelName({ provider: "amazon-bedrock", modelId: id }) !== canonicalModelName(CLAUDE_DEFAULT))! };

type Meta = Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };

/** A version 2 task, driven through planning, the plan check and the plan's approval until its build has finished: the review step is the next dispatch. */
async function builtTask(options: { beforeBuild?: (ctx: { h: Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>; workspaceId: string; operations: () => Array<Record<string, unknown>> }) => void; models?: { default: ModelIdentifier; approved: ModelIdentifier[] }; guardrails?: Record<string, unknown>; reviewStepSettings?: Record<string, unknown> } = {}) {
  const access = fakeModelAccess();
  const h = await createSingleAnswerPlanBroker({ audit: capturingAuditDeps(), register: options.models === undefined, brokerExtra: { agents: { ...(options.reviewStepSettings === undefined ? {} : { builtins: {
    currentVersion: (id: string) => currentBuiltinVersion(id as Parameters<typeof currentBuiltinVersion>[0]),
    defaultPin: (id: string) => builtinDefaultPin(id as Parameters<typeof builtinDefaultPin>[0]),
    name: (id: string) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
    recipe: (id: string, version: number) => {
      const recipe = builtinRecipe(id as Parameters<typeof builtinRecipe>[0], version);
      return id !== "rovara-code" ? recipe : { ...recipe, steps: recipe.steps.map(step => step.kind === "review" ? { ...step, settings: { ...step.settings, ...options.reviewStepSettings } } : step) } as ResolvedRecipe;
    },
  } }) }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  if (options.models !== undefined) await registerSlackProject(h.handler, { models: options.models });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const taskId = String((reply.body.task as { taskId: string }).taskId);
  const record = () => h.db.get(`DEVTASK#${taskId}`, "META") as Meta;
  const workspaceId = record().workspaceId;
  // Set after the task starts: a start with this rule needs the build step to name a model, and the rule is about the review dispatch.
  if (options.guardrails !== undefined) h.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, ...options.guardrails } });
  const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const byMode = (mode: string) => operations().filter((item) => item.workflowMode === mode).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const invocationOf = (operationId: unknown) => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload: { model?: { provider: string; modelId: string } } } | undefined;
  await h.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  const planning = byMode("PLAN")[0]!;
  await h.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ claims: CLAIMS })));
  await h.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const critique = byMode("PLAN_CRITIQUE").at(-1)!;
  await h.artifact(workspaceId, String(critique.id), "plan-critique.md", `I read the plan.\n\n\`\`\`rovara-plan-critique\n{"verdict":"ok","points":[]}\n\`\`\`\n`);
  await h.finish(workspaceId, String(critique.id), "SUCCEEDED", { result: { workflowMode: "PLAN_CRITIQUE" } });
  const approved = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: record().workflow.artifacts.at(-1)!.sha256, ...runLimitAck(h.db, taskId),
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  options.beforeBuild?.({ h, workspaceId, operations });
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "a".repeat(40), baseCommitSha: "e".repeat(40) }]);
  await h.finish(workspaceId, String(byMode("IMPLEMENT")[0]!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
  const reports = (operationId: unknown, provider: string, version: string) => ["CRITIC", "SECURITY"].map((role) => ({
    operationId: String(operationId), candidateDigest: candidate.digest, role, provider, version, status: "PASS", findings: [], readOnly: true, recordedAt: new Date().toISOString() }));
  /** The owner's Retry reviews on the blocked review step. */
  const retryReviewsReply = () => h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/review`, { requestId: randomUUID(), expectedRevision: record().workflow.revision, candidateDigest: candidate.digest, instructions: "Retry" });
  const retryReviews = async () => {
    const retried = await retryReviewsReply();
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
  };
  return { h, taskId, workspaceId, record, operations, byMode, invocationOf, candidate, reports, retryReviews, retryReviewsReply };
}
/** A review operation that ended with these reports (as the worker records a reviewer whose model call was refused: UNKNOWN, on an operation that SUCCEEDED). */
async function finishReviewWith(t: Awaited<ReturnType<typeof builtTask>>, review: Record<string, unknown>, extra: Record<string, unknown>) {
  const model = review.model as ModelIdentifier;
  await t.h.finish(t.workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: t.candidate.repositories,
    workflowReviews: t.reports(review.id, model.provider, model.modelId).map((report) => ({ ...report, ...extra })) } });
}
const REFUSED = { status: "UNKNOWN", failureReason: "SESSION_FAILED", modelFailure: "the model call failed: key-rejected AccessDeniedException HTTP 403 request 9e7ea41c-1111-2222-3333-444455556666 attempt 1" };
const THROTTLED = { status: "UNKNOWN", failureReason: "SESSION_FAILED", modelFailure: "the model call failed: limit-or-rate-limited ThrottlingException HTTP 429 attempt 1" };
const THIRD_CLAUDE: ModelIdentifier = { provider: "amazon-bedrock", modelId: bedrockClaudeModelIds().find((id) => ![CLAUDE_DEFAULT, OTHER_CLAUDE].some((model) => canonicalModelName(model) === canonicalModelName({ provider: "amazon-bedrock", modelId: id })))! };

describe("dispatching the review step of a version 2 task with no model set for it", () => {
  it("runs the reviews on a different model from the build's and records it on the operation", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    expect(key(t.byMode("IMPLEMENT")[0]!.model as ModelIdentifier)).toBe(key(CLAUDE_DEFAULT));
    const review = t.byMode("REVIEW")[0]!;
    expect(review, JSON.stringify([t.record().workflow.stage, t.record().workflow.state, t.record().workflow.blockReason])).toBeDefined();
    expect(t.invocationOf(review.id)!.payload.model).toMatchObject({ modelId: OTHER_CLAUDE.modelId });
    expect(review.model).toMatchObject({ modelId: OTHER_CLAUDE.modelId });
    expect(review.reviewSameModel).toBeUndefined();
  });

  it("runs the reviews on the one allowed model, records that it is the build's, and the report carries the note flag", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT] } });
    const review = t.byMode("REVIEW")[0]!;
    expect(t.invocationOf(review.id)!.payload.model).toMatchObject({ modelId: CLAUDE_DEFAULT.modelId });
    expect(review.reviewSameModel).toBe(true);
    await t.h.finish(t.workspaceId, String(review.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: t.candidate.repositories, workflowReviews: t.reports(review.id, CLAUDE_DEFAULT.provider, CLAUDE_DEFAULT.modelId) } });
    expect(t.record().workflow.reviews).toHaveLength(2);
    for (const report of t.record().workflow.reviews!) expect(report).toMatchObject({ provider: CLAUDE_DEFAULT.provider, version: CLAUDE_DEFAULT.modelId });
    // The flag is kept on the task, beside the workflow, never inside it (see "rollback" below); it names the code it is about.
    expect(t.record().reviewSameModel).toEqual({ candidateDigest: t.candidate.digest });
    expect(workflowPullRequestBody({ ...taskFields, reviewSameModel: t.record().reviewSameModel } as never, t.record().workflow, "# Plan\n\n1. Add the flag.\n", SESSION, {})).toContain(REVIEW_SAME_MODEL_NOTE);
  });

  it("a review on another model clears the flag an earlier review of the same code left", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    const review = t.byMode("REVIEW")[0]!;
    expect(review.reviewSameModel).toBeUndefined();
    t.h.db.set({ ...t.record(), reviewSameModel: { candidateDigest: t.candidate.digest } });
    await t.h.finish(t.workspaceId, String(review.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: t.candidate.repositories, workflowReviews: t.reports(review.id, OTHER_CLAUDE.provider, OTHER_CLAUDE.modelId) } });
    expect(t.record().workflow.reviews).toHaveLength(2);
    expect(t.record()).not.toHaveProperty("reviewSameModel");
  });

  it("owner decision 2026-11-02: a Claude-only company's review is on the builder's company, so the operation, the task record and the task page say so in fixed words", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    const review = t.byMode("REVIEW")[0]!;
    expect(review.reviewNoOtherCompany).toBe(true);
    await t.h.finish(t.workspaceId, String(review.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: t.candidate.repositories, workflowReviews: t.reports(review.id, OTHER_CLAUDE.provider, OTHER_CLAUDE.modelId) } });
    expect(t.record().reviewNoOtherCompany).toEqual({ candidateDigest: t.candidate.digest, model: { provider: OTHER_CLAUDE.provider, modelId: OTHER_CLAUDE.modelId } });
    const view = await t.h.dev(MAYA, "GET", `/v1/dev/tasks/${t.taskId}`, undefined, { "x-agentx-task-view": "2" });
    expect((view.body.task as { reviewModelLines: string[] }).reviewModelLines).toContain(`Review uses ${OTHER_CLAUDE.provider}/${OTHER_CLAUDE.modelId} (same company as the builder: no other company's model is available)`);
  });

  it("a review whose operation was not flagged clears the note an earlier review of the same code left", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    const review = t.byMode("REVIEW")[0]!;
    const { reviewNoOtherCompany: _flag, ...unflagged } = review;void _flag;
    t.h.db.set(unflagged);
    t.h.db.set({ ...t.record(), reviewNoOtherCompany: { candidateDigest: t.candidate.digest, model: { provider: OTHER_CLAUDE.provider, modelId: OTHER_CLAUDE.modelId } } });
    await t.h.finish(t.workspaceId, String(review.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: t.candidate.repositories, workflowReviews: t.reports(review.id, OTHER_CLAUDE.provider, OTHER_CLAUDE.modelId) } });
    expect(t.record()).not.toHaveProperty("reviewNoOtherCompany");
  });

  it("refuses an explicit review on the build model without a bound same-model approval", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] }, reviewStepSettings: { model: { provider: CLAUDE_DEFAULT.provider, modelId: CLAUDE_DEFAULT.modelId } } });
    expect(t.byMode("REVIEW")).toEqual([]);
    expect(t.record().workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "The task's pinned stage model is unavailable. Check How we work." });
  });

  it("when cross-company review is required and no other company is allowed, refuses as the dispatch always did (no recommendation changes it)", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] }, guardrails: { requireCrossCompanyReview: true } });
    expect(t.byMode("REVIEW")).toEqual([]);
    expect(t.record().workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(t.record().workflow.blockReason).toBe("The task's pinned stage model is unavailable. Check How we work.");
  });
});

// ---- what people read

const taskFields = { title: "Add a retry flag" };
const task = taskFields as never;
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
function reviewed(extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}): WorkflowSnapshot {
  const review = (role: "CRITIC" | "SECURITY", provider: string, version: string) => ({
    operationId: randomUUID(), candidateDigest: code.digest, role, provider, version, status: "PASS", findings: [], readOnly: true, recordedAt: NOW, ...more,
  });
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: NOW, definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [review("CRITIC", "anthropic", "claude-opus-4-6"), review("SECURITY", "anthropic", "claude-opus-4-6")],
    ...extra,
  });
}
/** What the task record carries after a review on the build's model: the flag, for the code the reviews were about. */
const sameModelTask = { ...taskFields, reviewSameModel: { candidateDigest: code.digest } } as never;
const reviewsSection = (body: string) => body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk:"));
const SESSION = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";

describe("the reviewer model, as people read it", () => {
  it("the pull request's Reviews section names the reviewer model, with no same-model note when another model reviewed", () => {
    const section = reviewsSection(workflowPullRequestBody(task, reviewed(), "# Plan\n\n1. Add the flag.\n", SESSION, {}));
    expect(section).toContain("anthropic/claude-opus-4-6");
    expect(section).not.toContain(REVIEW_SAME_MODEL_NOTE);
  });

  it("says the note, exactly, when the review used the build's model", () => {
    expect(REVIEW_SAME_MODEL_NOTE).toBe("Review used the same model as Build. Enable another model for an independent review.");
    const section = reviewsSection(workflowPullRequestBody(sameModelTask, reviewed(), "# Plan\n\n1. Add the flag.\n", SESSION, {}));
    expect(section).toContain("anthropic/claude-opus-4-6");
    expect(section).toContain(REVIEW_SAME_MODEL_NOTE);
  });

  it("makes a model name from a report inert: no mention, link or hidden comment reaches the pull request", () => {
    const hostileVersion = "@everyone <!-- x --> https://example.test/x\nnext line";
    const hostile = reviewed({ reviews: reviewed().reviews!.map((review) => ({ ...review, provider: "evil", version: hostileVersion })) });
    const section = reviewsSection(workflowPullRequestBody(task, hostile, "# Plan\n\n1. Add the flag.\n", SESSION, {}));
    expect(section).toContain("evil/");
    // The inert helper breaks a mention or a link with a zero-width joiner, so GitHub neither notifies nor links it.
    expect(section).not.toMatch(/@(?!\u200D)\w|<!--|:\/\/(?!\u200D)/u);
    expect(section.split("\n").some((line) => line.trim() === "next line")).toBe(false);
  });

  it("a version 1 task's description is unchanged: no reviewer model line", () => {
    const v1 = WorkflowSnapshotSchema.parse({ ...reviewed(), definitionVersion: "1.0.0", program: undefined });
    expect(workflowPullRequestBody(task, v1, "# Plan\n\n1. Add the flag.\n", SESSION, {})).not.toContain("claude-opus-4-6");
  });

  it("the task's message (pull request ready) names the reviewer model, with the note only when the model was the same", () => {
    const other = workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: reviewed() });
    expect(other?.text).toContain("anthropic/claude-opus-4-6");
    expect(other?.text).not.toContain(REVIEW_SAME_MODEL_NOTE);
    const same = workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: reviewed(), reviewSameModel: true });
    expect(same?.text).toContain("anthropic/claude-opus-4-6");
    expect(same?.text).toContain(REVIEW_SAME_MODEL_NOTE);
  });
});

// ---- a reviewer model the account can't call (fix round 1)

describe("a review model that the account could not call", () => {
  const approved = [CLAUDE_DEFAULT, OTHER_CLAUDE, THIRD_CLAUDE];

  it("is left out of the retry: the reviewer reported its model unusable, so the next dispatch picks another one", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved } });
    const first = t.byMode("REVIEW")[0]!;
    const refusedModel = first.model as ModelIdentifier;
    await finishReviewWith(t, first, REFUSED);
    expect(t.record().workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    await t.retryReviews();
    const second = t.byMode("REVIEW")[1]!;
    expect(second.model).toBeDefined();
    expect(canonicalModelName(second.model as ModelIdentifier)).not.toBe(canonicalModelName(refusedModel));
    expect(t.invocationOf(second.id)!.payload.model).toMatchObject({ modelId: (second.model as ModelIdentifier).modelId });
  });

  it("is not left out when the failure was a throttle: another model would not change it", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved } });
    const first = t.byMode("REVIEW")[0]!;
    await finishReviewWith(t, first, THROTTLED);
    await t.retryReviews();
    expect(t.byMode("REVIEW")[1]!.model).toMatchObject({ modelId: (first.model as ModelIdentifier).modelId });
  });

  it("is also left out when its whole operation failed with a refusal (the main session was refused first)", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved } });
    const first = t.byMode("REVIEW")[0]!;
    await t.h.finish(t.workspaceId, String(first.id), "FAILED", { error: "the model call failed: key-rejected AccessDeniedException HTTP 403 attempt 1; check the model key and its permissions, then retry" });
    await t.retryReviews();
    expect(canonicalModelName(t.byMode("REVIEW")[1]!.model as ModelIdentifier)).not.toBe(canonicalModelName(first.model as ModelIdentifier));
  });

  it("uses the verified build model once, then refuses after every allowed model is task-denied", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    // First the other model is refused: the build's own model is the only one left (and says so).
    await finishReviewWith(t, t.byMode("REVIEW")[0]!, REFUSED);
    await t.retryReviews();
    const second = t.byMode("REVIEW")[1]!;
    expect(second.model).toMatchObject({ modelId: CLAUDE_DEFAULT.modelId });
    expect(second.reviewSameModel).toBe(true);
    // C53 forbids retrying a task-denied model, including the reference model.
    await finishReviewWith(t, second, REFUSED);
    const before = t.operations().length;
    const reply = await t.retryReviewsReply();
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ error: { code: "MODEL_NOT_ALLOWED" } });
    expect(t.operations()).toHaveLength(before);
    expect(t.byMode("REVIEW")).toHaveLength(2);
  });

  it("takes the build from the latest build that succeeded, not from a later one that failed", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    // A later build that failed on the other model: it is not the code under review.
    const build = t.byMode("IMPLEMENT")[0]!;
    const failedId = randomUUID();
    t.h.db.set({ ...build, id: failedId, sk: `OPERATION#${failedId}`, requestId: randomUUID(), status: "FAILED", model: { provider: OTHER_CLAUDE.provider, modelId: OTHER_CLAUDE.modelId }, createdAt: "2099-01-01T00:00:00.000Z" });
    await finishReviewWith(t, t.byMode("REVIEW")[0]!, { status: "UNKNOWN", failureReason: "TIMEOUT" });
    await t.retryReviews();
    const second = t.byMode("REVIEW").at(-1)!;
    expect(second.model, "the build that succeeded ran on the default model, so the review is on the other one").toMatchObject({ modelId: OTHER_CLAUDE.modelId });
  });

  it("drops a same-model flag the worker sends: only the broker's own dispatch record sets it", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    const review = t.byMode("REVIEW")[0]!;
    expect(review.reviewSameModel).toBeUndefined();
    await finishReviewWith(t, review, { sameModelAsBuild: true });
    expect(t.record().workflow.reviews).toHaveLength(2);
    for (const report of t.record().workflow.reviews!) expect(report).not.toHaveProperty("sameModelAsBuild");
  });
});

// ---- fix round 2: rollback safety, and what the model-failure sentence may reach

/** The review report schema as it stood before this change (88223018): strict, with none of the keys this change adds. Only the report's own keys matter here; the findings have their own schema. */
const PREVIOUS_REVIEW_REPORT = z.object({
  operationId: z.string().uuid(),
  candidateDigest: z.string(),
  role: z.enum(["CRITIC", "SECURITY"]),
  provider: z.string(),
  version: z.string(),
  status: z.enum(["PASS", "FINDINGS", "FAILED", "INTERRUPTED", "UNKNOWN"]),
  failureReason: z.string().optional(),
  findings: z.array(WorkflowReviewFindingSchema),
  readOnly: z.literal(true),
  recordedAt: z.string().datetime(),
  partialDiff: z.literal(true).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
}).strict();

describe("rollback: an older broker must still read what this one stored", () => {
  it("a workflow stored after a review on the build's model holds only keys the previous review report schema accepts", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT] } });
    const review = t.byMode("REVIEW")[0]!;
    expect(review.reviewSameModel, "the positive control: this review did run on the build's model").toBe(true);
    await t.h.finish(t.workspaceId, String(review.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: t.candidate.repositories, workflowReviews: t.reports(review.id, CLAUDE_DEFAULT.provider, CLAUDE_DEFAULT.modelId) } });
    const stored = t.record().workflow.reviews!;
    expect(stored).toHaveLength(2);
    for (const report of stored) expect(PREVIOUS_REVIEW_REPORT.safeParse(report), JSON.stringify(report)).toMatchObject({ success: true });
    expect(JSON.stringify(t.record().workflow)).not.toMatch(/sameModelAsBuild|modelFailure/);
  });

  it("a worker that sends the flag, or a model-failure sentence, changes nothing in the stored workflow, and the reviews are still taken", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    await finishReviewWith(t, t.byMode("REVIEW")[0]!, { sameModelAsBuild: true });
    expect(t.record().workflow.reviews, JSON.stringify(t.record().workflow.blockReason)).toHaveLength(2);
    for (const report of t.record().workflow.reviews!) expect(PREVIOUS_REVIEW_REPORT.safeParse(report).success).toBe(true);
    expect(t.record()).not.toHaveProperty("reviewSameModel");
  });

  it("the note is about the code it was said of: a newer candidate does not carry it", () => {
    const newer = createCandidateManifest([{ repositoryId: "payments", commitSha: "2".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const body = workflowPullRequestBody({ ...taskFields, reviewSameModel: { candidateDigest: newer.digest } } as never, reviewed(), "# Plan\n\n1. Add the flag.\n", SESSION, {});
    expect(reviewsSection(body)).not.toContain(REVIEW_SAME_MODEL_NOTE);
    expect(workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: reviewed() })?.text).not.toContain(REVIEW_SAME_MODEL_NOTE);
  });
});

describe("the model-failure sentence stays on the operation's result", () => {
  it("is not in the task's workflow, the pull request's description or the Slack lines after a refused review", async () => {
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, OTHER_CLAUDE] } });
    await finishReviewWith(t, t.byMode("REVIEW")[0]!, REFUSED);
    const workflow = t.record().workflow;
    expect(workflow.reviews, "the positive control: the refused reports were taken as reviews").toHaveLength(2);
    for (const report of workflow.reviews!) expect(report).not.toHaveProperty("modelFailure");
    expect(JSON.stringify(workflow)).not.toMatch(/model call failed|key-rejected|AccessDenied/);
    expect(workflowMessage({ taskId: t.taskId, workflow })?.text).not.toMatch(/model call failed|key-rejected|AccessDenied/);
    expect(workflowPullRequestBody(task, workflow, "# Plan\n\n1. Add the flag.\n", SESSION, {})).not.toMatch(/model call failed|key-rejected|AccessDenied/);
  });
});

describe("a refused reviewer on an operation that succeeded counts toward the limit", () => {
  it("uses the build on the sixth default attempt and never reuses it after this task refuses it", async () => {
    // The build's model and six others: one refusal each leaves a model to choose until the sixth try.
    const others = bedrockClaudeModelIds().map((modelId): ModelIdentifier => ({ provider: "amazon-bedrock", modelId }))
      .filter((model) => canonicalModelName(model) !== canonicalModelName(CLAUDE_DEFAULT));
    const distinctOthers = others.filter((model, index) => others.findIndex((other) => canonicalModelName(other) === canonicalModelName(model)) === index);
    expect(distinctOthers.length, "the catalog must offer enough models for this scenario").toBeGreaterThanOrEqual(6);
    const t = await builtTask({ models: { default: CLAUDE_DEFAULT, approved: [CLAUDE_DEFAULT, ...distinctOthers.slice(0, 6)] } });
    const tried: Array<{ model: ModelIdentifier; same: boolean }> = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const review = t.byMode("REVIEW")[attempt]!;
      expect(review, `try ${attempt + 1} was dispatched`).toBeDefined();
      tried.push({ model: review.model as ModelIdentifier, same: review.reviewSameModel === true });
      await finishReviewWith(t, review, REFUSED);
      if (attempt < 6) await t.retryReviews();
    }
    // Tries 1-5 each chose a model nobody had refused yet, none of them the build's.
    expect(new Set(tried.slice(0, 5).map((entry) => canonicalModelName(entry.model))).size).toBe(5);
    for (const entry of tried.slice(0, 5)) {
      expect(canonicalModelName(entry.model)).not.toBe(canonicalModelName(CLAUDE_DEFAULT));
      expect(entry.same).toBe(false);
    }
    // The sixth is the last: the build's own model, with the note, although another model had not been tried.
    expect(canonicalModelName(tried[5]!.model)).toBe(canonicalModelName(CLAUDE_DEFAULT));
    expect(tried[5]!.same).toBe(true);
    // C53 retains verified default compatibility while forbidding every task-denied model.
    // A seventh review can use an untried verified model, but cannot repeat the refused build model.
    expect(new Set(tried.map(entry => canonicalModelName(entry.model))).size).toBe(7);
    expect(canonicalModelName(tried[6]!.model)).not.toBe(canonicalModelName(CLAUDE_DEFAULT));
    expect(tried[6]!.same).toBe(false);
  });
});
